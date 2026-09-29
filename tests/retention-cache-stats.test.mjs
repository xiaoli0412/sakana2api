import assert from 'node:assert/strict';
import { Cache } from '../lib/cache.js';
import { Stats } from '../lib/stats.js';

// Cache: hard entry/byte limits, expiry sweep, and stats remain bounded.
{
  let now = 1000;
  const cache = new Cache({ now: () => now, hitRate: 1, maxEntries: 2, maxBytes: 80, ttl: 50, sweepIntervalMs: 0 });
  cache.set('a', 'one');
  cache.set('b', 'two');
  cache.set('c', 'three');
  assert.ok(cache.store.size <= 2);
  assert.ok(cache.bytes <= 80);
  assert.equal(cache.get('a'), null, 'oldest entry is evicted at the cap');
  cache.set('large', 'x'.repeat(100));
  assert.equal(cache.get('large'), null, 'oversized values are rejected');
  assert.ok(cache.stats().oversized >= 1);
  assert.ok(cache.store.size <= 2);
  assert.ok(cache.bytes <= 80);
  now += 60;
  assert.equal(cache.sweep(), 2, 'expired entries are swept');
  assert.equal(cache.stats().size, 0);
  cache.close();
}

// Stats: model/key maps are capped and errors are safe scalar strings.
{
  const stats = new Stats({ maxModels: 2, maxKeys: 2, maxErrorLength: 12 });
  for (let i = 0; i < 4; i++) {
    stats.begin(`model-${i}`);
    stats.finish({ model: `model-${i}`, ok: false, error: new Error(`line\n${'x'.repeat(40)}`), keyId: `key-${i}` });
  }
  const snapshot = stats.snapshot();
  assert.ok(Object.keys(snapshot.byModel).length <= 2);
  assert.ok(Object.keys(snapshot.byKey).length <= 2);
  assert.equal(typeof snapshot.lastErr, 'string');
  assert.ok(snapshot.lastErr.length <= 12);
  assert.equal(snapshot.lastErr.includes('\n'), false);
}

console.log('cache/stats retention tests: all passed');
