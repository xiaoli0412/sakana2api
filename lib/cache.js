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

  /** Generate a cache key from semantic request data when available. */
  key(body, meta = {}) {
    const obj = typeof body === 'object' ? { ...body } : { body };
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

  /** Clear the whole cache (admin action). */
  clear() {
    this.store.clear();
    this.hits = 0;
    this.misses = 0;
    this.bypasses = 0;
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