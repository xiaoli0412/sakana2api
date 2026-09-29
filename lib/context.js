// ContextStore — high-affinity conversation stickiness.
// Maps request fingerprints to rich context entries so follow-up turns reuse
// the same upstream conversation, account, and latest message leaf.
const crypto = require('node:crypto');
const { clipUtf8ByBytes } = require('./context-budget');

const TTL_DEFAULT = 24 * 60 * 60 * 1000;
const CAP_DEFAULT = 10000;
const CLIENT_ALIAS_CAP_DEFAULT = 16;
const PRUNE_INTERVAL_DEFAULT = 60 * 1000;
const sha = (s) => crypto.createHash('md5').update(String(s)).digest('hex');
const envNumber = (name, fallback, min = 0) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= min ? n : fallback;
};
const MAX_CLIENT_ALIAS_BYTES = Math.max(64, envNumber('CONTEXT_MAX_CLIENT_ALIAS_BYTES', 256));

const CLIENT_ALIAS_CAP = envNumber('CONTEXT_MAX_CLIENT_ALIASES', CLIENT_ALIAS_CAP_DEFAULT, 0);
const PRUNE_INTERVAL = envNumber('CONTEXT_PRUNE_MS', PRUNE_INTERVAL_DEFAULT, 0);

function lastUserText(body) {
  const msgs = Array.isArray(body?.messages) ? body.messages : [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (!m || m.role !== 'user') continue;
    const c = m.content;
    return typeof c === 'string' ? c : (Array.isArray(c) ? c.map(p => p && (p.text || p.content || '')).join(' ') : '');
  }
  return '';
}

function firstUserText(body) {
  const msgs = Array.isArray(body?.messages) ? body.messages : [];
  for (const m of msgs) {
    if (!m || m.role !== 'user') continue;
    const c = m.content;
    return typeof c === 'string' ? c : (Array.isArray(c) ? c.map(p => p && (p.text || p.content || '')).join(' ') : '');
  }
  return '';
}

function getContextKeys(req, body) {
  const keys = [];
  const explicitId = body?.conversation_id || body?.chat_id || body?.thread_id ||
    (req?.headers && (req.headers['x-conversation-id'] || req.headers['x-thread-id']));
  if (explicitId) keys.push(`id:${boundedAlias(explicitId)}`);
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

function boundedAlias(value) {
  return clipUtf8ByBytes(String(value || ''), MAX_CLIENT_ALIAS_BYTES);
}

function makeEntry(conversationId, lastMessageId, accountId, snapshot = {}, previous = {}, maxClientAliases = CLIENT_ALIAS_CAP, now = Date.now) {
  const prior = previous && typeof previous === 'object' ? previous : {};
  const clientConversationIds = Array.isArray(snapshot.clientConversationIds)
    ? snapshot.clientConversationIds
    : (Array.isArray(prior.clientConversationIds) ? prior.clientConversationIds : []);
  const aliases = [...new Set(clientConversationIds.filter(Boolean).map(boundedAlias))];
  const cappedAliases = maxClientAliases > 0 ? aliases.slice(-maxClientAliases) : [];
  return {
    conversationId,
    accountId: accountId || prior.accountId || '',
    clientConversationIds: cappedAliases,
    lastMessageId: lastMessageId || prior.lastMessageId || '',
    ts: now(),
    ...snapshotFields(snapshot, prior),
  };
}

function isContextEntry(entry) {
  return !!entry && typeof entry === 'object';
}

class ContextStore {
  constructor({ ttl = TTL_DEFAULT, capacity = CAP_DEFAULT, maxClientAliases = null,
    maxAliases = null, maxClientConversationIds = null, aliasCap = null,
    pruneIntervalMs = null, pruneInterval = null, now = Date.now, onPrune = null } = {}) {
    const aliasLimit = [maxClientAliases, maxAliases, maxClientConversationIds, aliasCap]
      .find(value => Number.isFinite(value));
    const pruneIntervalValue = [pruneIntervalMs, pruneInterval]
      .find(value => Number.isFinite(value));
    this.ttl = Math.max(0, Number.isFinite(ttl) ? ttl : TTL_DEFAULT);
    this.capacity = Math.max(0, Number.isFinite(capacity) ? capacity : CAP_DEFAULT);
    this.maxClientAliases = Math.max(0, Number.isFinite(aliasLimit) ? aliasLimit : CLIENT_ALIAS_CAP);
    this.pruneIntervalMs = Math.max(0, Number.isFinite(pruneIntervalValue) ? pruneIntervalValue : PRUNE_INTERVAL);
    this.now = typeof now === 'function' ? now : Date.now;
    this.onPrune = typeof onPrune === 'function' ? onPrune : null;
    this.map = new Map();
    this.stats = { sets: 0, hits: 0, misses: 0, evictions: 0 };
    this._pruneTimer = null;
    if (this.pruneIntervalMs > 0) this.startPruner();
  }

  get size() { return this.map.size; }

  _prune(now = this.now()) {
    let removed = 0;
    for (const [k, e] of this.map) {
      if (!isContextEntry(e) || !Number.isFinite(e.ts) || now - e.ts >= this.ttl) {
        this.map.delete(k);
        this.stats.evictions++;
        removed++;
      }
    }
    if (this.map.size > this.capacity) {
      const entries = [...this.map.entries()].sort((a, b) => (a[1].ts || 0) - (b[1].ts || 0));
      for (const [k] of entries.slice(0, this.map.size - this.capacity)) {
        this.map.delete(k);
        this.stats.evictions++;
        removed++;
      }
    }
    if (removed && this.onPrune) {
      try { this.onPrune(removed); } catch {}
    }
    return removed;
  }

  /** Public expiry hook for callers that want deterministic cleanup. */
  prune(now = this.now()) {
    return this._prune(now);
  }

  expire(now = this.now()) {
    return this._prune(now);
  }

  startPruner(intervalMs = this.pruneIntervalMs) {
    this.stopPruner();
    this.pruneIntervalMs = Math.max(0, Number.isFinite(intervalMs) ? intervalMs : 0);
    if (this.pruneIntervalMs <= 0) return false;
    this._pruneTimer = setInterval(() => this._prune(this.now()), this.pruneIntervalMs);
    this._pruneTimer.unref?.();
    return true;
  }

  stopPruner() {
    if (!this._pruneTimer) return false;
    clearInterval(this._pruneTimer);
    this._pruneTimer = null;
    return true;
  }

  _get(key, now = this.now()) {
    const entry = this.map.get(key);
    if (entry && isContextEntry(entry) && Number.isFinite(entry.ts) && now - entry.ts < this.ttl) return entry;
    if (entry) {
      this.map.delete(key);
      this.stats.evictions++;
    }
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
    const now = this.now();
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
    const now = this.now();
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

  _pruneAliases(conversationId, aliases = []) {
    if (!conversationId) return 0;
    const allowed = new Set(aliases.filter(Boolean));
    let removed = 0;
    for (const [key, entry] of this.map) {
      if (!key.startsWith('id:') || !isContextEntry(entry) || entry.conversationId !== conversationId) continue;
      const alias = key.slice(3);
      if (alias === conversationId || allowed.has(alias)) continue;
      this.map.delete(key);
      removed++;
    }
    return removed;
  }

  // The sixth argument is optional to preserve all legacy callers.
  save(req, body, conversationId, lastMessageId, explicitAccountId = null, snapshot = null) {
    if (!conversationId) return;
    if (typeof req === 'string') {
      const key = sha(req);
      this.map.set(key, makeEntry(conversationId, lastMessageId, explicitAccountId, snapshot || {}, this.map.get(key) || {}, this.maxClientAliases, this.now));
    } else {
      const keys = getContextKeys(req, body);
      const explicitId = body?.conversation_id || body?.chat_id || body?.thread_id ||
        (req?.headers && (req.headers['x-conversation-id'] || req.headers['x-thread-id']));
      const safeExplicitId = explicitId ? boundedAlias(explicitId) : '';
      keys.push(`id:${conversationId}`);
      const explicitEntry = safeExplicitId ? this.map.get(`id:${safeExplicitId}`) : null;
      const conversationEntry = this.map.get(`id:${conversationId}`);
      const previous = explicitEntry || conversationEntry || (!safeExplicitId
        ? keys.map((key) => this.map.get(key)).find(Boolean)
        : null) || {};
      const entrySnapshot = safeExplicitId && safeExplicitId !== conversationId
        ? { ...(snapshot || {}), clientConversationIds: [...new Set([...(previous.clientConversationIds || []), safeExplicitId])] }
        : snapshot || {};
      const entry = makeEntry(conversationId, lastMessageId, explicitAccountId, entrySnapshot, previous, this.maxClientAliases, this.now);
      for (const key of keys) this.map.set(key, entry);
      this._pruneAliases(conversationId, entry.clientConversationIds);
    }
    this.stats.sets++;
    if (this.map.size > this.capacity) this._prune(this.now());
  }

  clear() { this.map.clear(); }

  close() {
    this.stopPruner();
    this.clear();
  }

  stop() { this.close(); }
}

module.exports = {
  ContextStore,
  firstUserText,
  lastUserText,
  getContextKeys,
};
