// ContextStore — high-affinity conversation stickiness.
// Maps request fingerprints to rich context entries so follow-up turns reuse
// the same upstream conversation, account, and latest message leaf.
import crypto from 'node:crypto';

const TTL_DEFAULT = 24 * 60 * 60 * 1000;
const CAP_DEFAULT = 10000;
const sha = (s) => crypto.createHash('md5').update(String(s)).digest('hex');

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

export function firstUserText(body) {
  const msgs = Array.isArray(body?.messages) ? body.messages : [];
  for (const m of msgs) {
    if (!m || m.role !== 'user') continue;
    const c = m.content;
    return typeof c === 'string' ? c : (Array.isArray(c) ? c.map(p => p && (p.text || p.content || '')).join(' ') : '');
  }
  return '';
}

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

function snapshotFields(snapshot = {}, previous = {}) {
  const next = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const prior = previous && typeof previous === 'object' ? previous : {};
  return {
    firstMessageFingerprint: next.firstMessageFingerprint || prior.firstMessageFingerprint || '',
    recentClientHistoryFingerprint: next.recentClientHistoryFingerprint || prior.recentClientHistoryFingerprint || '',
    recentUserFingerprint: next.recentUserFingerprint || prior.recentUserFingerprint || '',
    messageCount: Number.isFinite(next.messageCount) ? next.messageCount : (Number.isFinite(prior.messageCount) ? prior.messageCount : 0),
    updatedAt: next.updatedAt ?? prior.updatedAt ?? Date.now(),
    forks: Number.isFinite(next.forks) ? next.forks : (Number.isFinite(prior.forks) ? prior.forks : 0),
    rebuilds: Number.isFinite(next.rebuilds) ? next.rebuilds : (Number.isFinite(prior.rebuilds) ? prior.rebuilds : 0),
  };
}

function makeEntry(conversationId, lastMessageId, accountId, snapshot = {}, previous = {}) {
  const prior = previous && typeof previous === 'object' ? previous : {};
  const clientConversationIds = Array.isArray(snapshot.clientConversationIds)
    ? snapshot.clientConversationIds
    : (Array.isArray(prior.clientConversationIds) ? prior.clientConversationIds : []);
  return {
    conversationId,
    accountId: accountId || prior.accountId || '',
    clientConversationIds: [...new Set(clientConversationIds.filter(Boolean))],
    lastMessageId: lastMessageId || prior.lastMessageId || '',
    ts: Date.now(),
    ...snapshotFields(snapshot, prior),
  };
}

function isContextEntry(entry) {
  return !!entry && typeof entry === 'object';
}

export class ContextStore {
  constructor({ ttl = TTL_DEFAULT, capacity = CAP_DEFAULT } = {}) {
    this.ttl = ttl;
    this.capacity = capacity;
    this.map = new Map();
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
    if (this.map.size > this.capacity) {
      const entries = [...this.map.entries()].sort((a, b) => a[1].ts - b[1].ts);
      for (const [k] of entries.slice(0, this.map.size - this.capacity)) {
        this.map.delete(k);
        this.stats.evictions++;
      }
    }
  }

  _get(key, now = Date.now()) {
    const entry = this.map.get(key);
    if (entry && now - entry.ts < this.ttl) return entry;
    if (entry) this.map.delete(key);
    return null;
  }

  lookup(req, body) {
    if (typeof req === 'string') {
      const entry = this._get(sha(req));
      if (entry) { this.stats.hits++; return entry; }
      this.stats.misses++;
      return null;
    }
    for (const key of getContextKeys(req, body)) {
      const entry = this._get(key);
      if (entry) { this.stats.hits++; return entry; }
    }
    this.stats.misses++;
    return null;
  }

  getByConversationId(conversationId) {
    if (!conversationId) return null;
    const now = Date.now();
    let found = null;
    for (const [key, entry] of this.map) {
      if (!isContextEntry(entry)) {
        this.map.delete(key);
        continue;
      }
      if (entry.conversationId !== conversationId) continue;
      if (!Number.isFinite(entry.ts) || now - entry.ts >= this.ttl) {
        this.map.delete(key);
        continue;
      }
      if (!found || entry.ts > found.ts) found = entry;
    }
    return found;
  }

  /** Remove id/text/model aliases belonging only to one conversation. */
  clearConversation(conversationId = '') {
    if (!conversationId) return 0;
    const matchingIds = new Set([conversationId]);
    for (const entry of this.map.values()) {
      if (!isContextEntry(entry)) continue;
      if (entry.conversationId === conversationId ||
          (entry.clientConversationIds || []).includes(conversationId)) {
        matchingIds.add(entry.conversationId);
      }
    }
    let removed = 0;
    for (const [key, entry] of this.map) {
      if (!isContextEntry(entry) || !matchingIds.has(entry.conversationId)) continue;
      this.map.delete(key);
      removed++;
    }
    return removed;
  }

  updateLeaf(conversationId, lastMessageId, snapshot = null) {
    if (!conversationId) return 0;
    const now = Date.now();
    let updated = 0;
    for (const [key, entry] of this.map) {
      if (!isContextEntry(entry)) continue;
      if (entry.conversationId !== conversationId) continue;
      this.map.set(key, {
        ...entry,
        ...snapshotFields(snapshot, entry),
        lastMessageId: lastMessageId || entry.lastMessageId || '',
        ts: now,
      });
      updated++;
    }
    return updated;
  }

  // The sixth argument is optional to preserve all legacy callers.
  save(req, body, conversationId, lastMessageId, explicitAccountId = null, snapshot = null) {
    if (!conversationId) return;
    if (typeof req === 'string') {
      const key = sha(req);
      this.map.set(key, makeEntry(conversationId, lastMessageId, explicitAccountId, snapshot || {}, this.map.get(key) || {}));
    } else {
      const keys = getContextKeys(req, body);
      const explicitId = body?.conversation_id || body?.chat_id || body?.thread_id ||
        (req?.headers && (req.headers['x-conversation-id'] || req.headers['x-thread-id']));
      keys.push(`id:${conversationId}`);
      const explicitEntry = explicitId ? this.map.get(`id:${explicitId}`) : null;
      const conversationEntry = this.map.get(`id:${conversationId}`);
      const previous = explicitEntry || conversationEntry || (!explicitId
        ? keys.map((key) => this.map.get(key)).find(Boolean)
        : null) || {};
      const entrySnapshot = explicitId && explicitId !== conversationId
        ? { ...(snapshot || {}), clientConversationIds: [...new Set([...(previous.clientConversationIds || []), explicitId])] }
        : snapshot || {};
      const entry = makeEntry(conversationId, lastMessageId, explicitAccountId, entrySnapshot, previous);
      for (const key of keys) this.map.set(key, entry);
    }
    this.stats.sets++;
    if (this.map.size > this.capacity) this._prune(Date.now());
  }

  clear() { this.map.clear(); }
}
