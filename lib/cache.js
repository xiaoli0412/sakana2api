// In-memory cache with configurable hit rate (random bypass for realistic
// simulation). Caches request->response pairs. Supports TTL, bounded retention,
// and manual invalidation.
const crypto = require('crypto');

const envNumber = (name, fallback, min = 0) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= min ? value : fallback;
};
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const CACHE_HIT_RATE = clamp(envNumber('CACHE_HIT_RATE', 0.93, 0), 0, 1);
const CACHE_TTL = envNumber('CACHE_TTL', 60000, 0);
const CACHE_MAX_ENTRIES = envNumber('CACHE_MAX_ENTRIES', 1000, 0);
const CACHE_MAX_BYTES = envNumber('CACHE_MAX_BYTES', 64 * 1024 * 1024, 0);
const CACHE_SWEEP_MS = envNumber('CACHE_SWEEP_MS', 10000, 0);

class Cache {
  constructor(options = {}) {
    if (typeof options === 'number') options = { ttl: options };
    const optionNumber = (names, fallback, min = 0) => {
      for (const name of names) {
        if (Object.prototype.hasOwnProperty.call(options, name) && Number.isFinite(Number(options[name]))) {
          return Math.max(min, Number(options[name]));
        }
      }
      return fallback;
    };

    this.hitRate = clamp(optionNumber(['hitRate'], CACHE_HIT_RATE, 0), 0, 1);
    this.ttl = optionNumber(['ttl', 'ttlMs'], CACHE_TTL, 0);
    this.maxEntries = optionNumber(['maxEntries', 'maxSize', 'maxItems'], CACHE_MAX_ENTRIES, 0);
    this.maxBytes = optionNumber(['maxBytes', 'bytes', 'maxSizeBytes'], CACHE_MAX_BYTES, 0);
    this.sweepIntervalMs = optionNumber(['sweepIntervalMs', 'sweepMs'], CACHE_SWEEP_MS, 0);
    this.now = typeof options.now === 'function' ? options.now : Date.now;

    this.store = new Map();
    this.bytes = 0;
    this.sequence = 0;
    this.hits = 0;
    this.misses = 0;
    this.bypasses = 0;
    this.sets = 0;
    this.evictions = 0;
    this.expired = 0;
    this.oversized = 0;
    this._sweepTimer = null;
    if (this.sweepIntervalMs > 0) {
      this._sweepTimer = setInterval(() => this.sweep(), this.sweepIntervalMs);
      this._sweepTimer.unref?.();
    }
  }

  /** Generate a cache key from semantic request data when available. */
  key(body, meta = {}) {
    const obj = typeof body === 'object' && body !== null ? { ...body } : { body };
    delete obj.conversation_id;
    delete obj.chat_id;
    delete obj.thread_id;
    delete obj.stream;
    delete obj.api_key;
    delete obj.authorization;
    delete obj.tools;
    delete obj.functions;
    delete obj.tool_choice;
    delete obj.parallel_tool_calls;
    delete obj.__contextSnapshot;
    delete obj.__normalizedRequest;
    const semantic = meta.semanticFingerprint || '';
    if (semantic) obj.semantic_message_fingerprint = semantic;
    if (meta.normalized) obj.normalized_messages = meta.normalized;
    return crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex');
  }

  _entrySize(key, data) {
    let serialized;
    try {
      serialized = JSON.stringify(data);
    } catch {
      serialized = String(data);
    }
    if (serialized === undefined) serialized = '';
    return Buffer.byteLength(String(key), 'utf8') + Buffer.byteLength(serialized, 'utf8');
  }

  _expired(entry, now) {
    return !entry || this.ttl <= 0 || now - entry.ts >= this.ttl;
  }

  _remove(key, reason = '') {
    const entry = this.store.get(key);
    if (!entry) return false;
    this.store.delete(key);
    this.bytes = Math.max(0, this.bytes - (entry.size || 0));
    if (reason === 'expired') this.expired++;
    else if (reason === 'evicted') this.evictions++;
    return true;
  }

  _evictToLimits() {
    while (this.store.size > this.maxEntries || this.bytes > this.maxBytes) {
      let oldestKey = null;
      let oldest = null;
      for (const [key, entry] of this.store) {
        if (!oldest || entry.ts < oldest.ts || (entry.ts === oldest.ts && entry.seq < oldest.seq)) {
          oldestKey = key;
          oldest = entry;
        }
      }
      if (oldestKey === null || !this._remove(oldestKey, 'evicted')) break;
    }
  }

  /** Remove expired entries and restore the configured hard limits. */
  sweep(now = this.now()) {
    let removed = 0;
    for (const [key, entry] of this.store) {
      if (this._expired(entry, now) && this._remove(key, 'expired')) removed++;
    }
    const before = this.evictions;
    this._evictToLimits();
    removed += this.evictions - before;
    return removed;
  }

  /** Get cached response. Returns null on miss or bypass. */
  get(key) {
    const now = this.now();
    this.sweep(now);
    const entry = this.store.get(key);
    if (!entry) { this.misses++; return null; }
    if (this._expired(entry, now)) {
      this._remove(key, 'expired');
      this.misses++;
      return null;
    }
    // Random bypass to simulate hit rate.
    if (Math.random() > this.hitRate) {
      this.bypasses++;
      return null;
    }
    this.hits++;
    return entry.data;
  }

  /** Set cached response. Oversized values are rejected without exceeding caps. */
  set(key, data) {
    const now = this.now();
    this.sweep(now);
    this.sets++;
    this._remove(key);
    const size = this._entrySize(key, data);
    if (this.maxEntries <= 0 || size > this.maxBytes) {
      this.oversized++;
      return;
    }
    this.store.set(key, { data, ts: now, size, seq: ++this.sequence });
    this.bytes += size;
    this._evictToLimits();
  }

  /** Invalidate entries matching a request (e.g. after conversation update). */
  invalidate(key) {
    this._remove(key);
  }

  /** Clear the whole cache (admin action). */
  clear() {
    this.store.clear();
    this.bytes = 0;
    this.hits = 0;
    this.misses = 0;
    this.bypasses = 0;
    this.sets = 0;
    this.evictions = 0;
    this.expired = 0;
    this.oversized = 0;
  }

  stop() {
    if (this._sweepTimer) {
      clearInterval(this._sweepTimer);
      this._sweepTimer = null;
    }
  }

  close() { this.stop(); }

  stats() {
    this.sweep();
    const total = this.hits + this.misses + this.bypasses;
    return {
      size: this.store.size,
      bytes: this.bytes,
      maxEntries: this.maxEntries,
      maxBytes: this.maxBytes,
      ttl: this.ttl,
      hits: this.hits,
      misses: this.misses,
      bypasses: this.bypasses,
      sets: this.sets,
      evictions: this.evictions,
      expired: this.expired,
      oversized: this.oversized,
      hitRate: total ? (this.hits / total * 100).toFixed(1) + '%' : '0%',
    };
  }
}

module.exports = { Cache };
