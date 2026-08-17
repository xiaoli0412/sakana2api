// ContextStore — high-affinity conversation stickiness.
// Maps request fingerprints -> { conversationId, accountId, lastMessageId, ts }
// so follow-up turns reuse the same upstream conversation AND the same pool
// account (CONV-NOTFOUND-001 otherwise).
import crypto from 'node:crypto';

const TTL_DEFAULT = 24 * 60 * 60 * 1000; // 24h
const CAP_DEFAULT = 10000;

const sha = (s) => crypto.createHash('md5').update(String(s)).digest('hex');

/** Raw text of the LAST user message — used as a fallback key. */
export function lastUserText(body) {
  const msgs = Array.isArray(body?.messages) ? body.messages : [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (!m || m.role !== 'user') continue;
    const c = m.content;
    return typeof c === 'string' ? c : (Array.isArray(c) ? c.map(p => p && (p.text || p.content || '')).join(' ') : '');
  }
  return '';
}

/** Raw text of the FIRST user message — the stable stickiness key. */
export function firstUserText(body) {
  const msgs = Array.isArray(body?.messages) ? body.messages : [];
  for (const m of msgs) {
    if (!m || m.role !== 'user') continue;
    const c = m.content;
    return typeof c === 'string' ? c : (Array.isArray(c) ? c.map(p => p && (p.text || p.content || '')).join(' ') : '');
  }
  return '';
}

/**
 * Lookup keys for a request. Explicit conversation ids (headers or body) are
 * preferred; the first-user-message text is the fallback that makes
 * history-resend clients sticky without passing conversation_id at all.
 */
export function getContextKeys(req, body) {
  const keys = [];
  const explicitId = body?.conversation_id || body?.chat_id || body?.thread_id ||
    (req?.headers && (req.headers['x-conversation-id'] || req.headers['x-thread-id']));
  if (explicitId) keys.push(`id:${explicitId}`);
  const firstText = firstUserText(body);
  if (firstText) {
    keys.push(`text:${sha(firstText)}`);
    keys.push(`model:${sha(firstText + ':' + (body?.model || ''))}`);
  }
  return keys;
}

export class ContextStore {
  constructor({ ttl = TTL_DEFAULT, capacity = CAP_DEFAULT } = {}) {
    this.ttl = ttl;
    this.capacity = capacity;
    this.map = new Map(); // key -> entry { conversationId, accountId, lastMessageId, ts }
    this.stats = { sets: 0, hits: 0, misses: 0, evictions: 0 };
  }

  get size() { return this.map.size; }

  _prune(now = Date.now()) {
    for (const [k, e] of this.map) {
      if (now - e.ts > this.ttl) {
        this.map.delete(k);
        this.stats.evictions++;
      }
    }
    // capacity guard: drop oldest entries beyond 2x capacity (prune only TTL)
    if (this.map.size > this.capacity) {
      const entries = [...this.map.entries()].sort((a, b) => a[1].ts - b[1].ts);
      const remove = entries.slice(0, this.map.size - this.capacity);
      for (const [k] of remove) {
        this.map.delete(k);
        this.stats.evictions++;
      }
    }
  }

  /** lookup by request (or legacy string arg: text-only key). */
  lookup(req, body) {
    if (typeof req === 'string') {
      const h = sha(req);
      const entry = this.map.get(h);
      if (entry && Date.now() - entry.ts < this.ttl) { this.stats.hits++; return entry; }
      if (entry) this.map.delete(h);
      this.stats.misses++;
      return null;
    }
    const keys = getContextKeys(req, body);
    for (const k of keys) {
      const entry = this.map.get(k);
      if (entry && Date.now() - entry.ts < this.ttl) { this.stats.hits++; return entry; }
      if (entry) this.map.delete(k);
    }
    this.stats.misses++;
    return null;
  }

  /** save mapping; string arg = legacy text-key path. */
  save(req, body, conversationId, lastMessageId, explicitAccountId = null) {
    if (!conversationId) return;
    const now = Date.now();
    if (typeof req === 'string') {
      const h = sha(req);
      const prev = this.map.get(h);
      this.map.set(h, {
        conversationId,
        accountId: explicitAccountId || (prev && prev.accountId) || '',
        lastMessageId: lastMessageId || (prev && prev.lastMessageId) || '',
        ts: now,
      });
    } else {
      const entry = { conversationId, accountId: explicitAccountId || '', lastMessageId: lastMessageId || '', ts: now };
      const keys = getContextKeys(req, body);
      keys.push(`id:${conversationId}`);
      for (const k of keys) this.map.set(k, entry);
    }
    this.stats.sets++;
    if (this.map.size > this.capacity) this._prune(now);
  }

  clear() {
    this.map.clear();
  }
}