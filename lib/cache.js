// In-memory cache with configurable hit rate (random bypass for realistic
// simulation). Caches request->response pairs. Supports TTL and manual
// invalidation.
const crypto = require('crypto');

const CACHE_HIT_RATE = parseFloat(process.env.CACHE_HIT_RATE || '0.93'); // 93% default
const CACHE_TTL = parseInt(process.env.CACHE_TTL || '60000', 10); // 60s default

class Cache {
  constructor() {
    this.store = new Map();
    this.hits = 0;
    this.misses = 0;
    this.bypasses = 0;
  }

  /** Generate a cache key from a request body (ignoring conversation_id/stream). */
  key(body) {
    const obj = typeof body === 'object' ? { ...body } : { body };
    // Remove fields that shouldn't affect cache key
    delete obj.conversation_id;
    delete obj.stream;
    return crypto.createHash('md5').update(JSON.stringify(obj)).digest('hex');
  }

  /** Get cached response. Returns null on miss or bypass. */
  get(key) {
    const entry = this.store.get(key);
    if (!entry) { this.misses++; return null; }
    if (Date.now() - entry.ts > CACHE_TTL) {
      this.store.delete(key);
      this.misses++;
      return null;
    }
    // Random bypass to simulate hit rate
    if (Math.random() > CACHE_HIT_RATE) {
      this.bypasses++;
      return null;
    }
    this.hits++;
    return entry.data;
  }

  /** Set cached response. */
  set(key, data) {
    this.store.set(key, { data, ts: Date.now() });
    // Evict old entries periodically
    if (this.store.size > 1000) {
      const old = [...this.store.entries()].filter(([, e]) => Date.now() - e.ts > CACHE_TTL * 2);
      for (const [k] of old) this.store.delete(k);
    }
  }

  /** Invalidate entries matching a request (e.g. after conversation update). */
  invalidate(key) {
    this.store.delete(key);
  }

  stats() {
    const total = this.hits + this.misses + this.bypasses;
    return {
      size: this.store.size,
      hits: this.hits,
      misses: this.misses,
      bypasses: this.bypasses,
      hitRate: total ? (this.hits / total * 100).toFixed(1) + '%' : '0%',
    };
  }
}

module.exports = { Cache };