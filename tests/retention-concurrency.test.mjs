import assert from 'node:assert/strict';
import { ConcurrencyManager } from '../lib/concurrency.js';

const pool = { activeCount: () => 1 };
const manager = new ConcurrencyManager({ maxConcurrentPerAccount: 1, maxQueue: 1, queueTimeoutMs: 1000 });
await manager.acquire(pool);
const controller = new AbortController();
const waiting = manager.acquire(pool, { signal: controller.signal });
assert.equal(manager.stats.queueLength, 1);
controller.abort(new Error('client disconnected'));
await assert.rejects(waiting, (error) => error.name === 'AbortError' && error.code === 'REQUEST-ABORTED');
assert.equal(manager.stats.queueLength, 0);
assert.equal(manager.stats.totalAborted, 1);

const queued = manager.acquire(pool);
await assert.rejects(manager.acquire(pool), (error) => error.code === 'QUEUE_FULL');
assert.equal(manager.stats.totalRejected, 1);
manager.release();
await queued;
manager.release();
assert.equal(manager.stats.inFlight, 0);

console.log('concurrency retention tests: all passed');
