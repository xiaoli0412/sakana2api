import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AccountPool } from '../lib/account-pool.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sakana-retention-pool-'));
let now = 1000;
const pool = new AccountPool(path.join(dir, 'pool.json'), path.join(dir, 'session.json'), {
  minPool: 1,
  maxPool: 1,
  maxConcurrentPerAccount: 2,
  maxModelEntries: 2,
  leaseMaxAgeMs: 10,
  leaseReaperMs: 0,
  now: () => now,
});
const accountId = pool.add({ uid: 'uid', email: 'user@example.com', cookieHeader: 'sakana-chat=retention', cookies: [] });
assert.ok(accountId);

for (let i = 0; i < 5; i++) {
  const lease = pool.lease(`model-${i}`, { accountId });
  if (lease) pool.releaseLease(lease, true);
}
assert.ok(Object.keys(pool.accounts[0].modelUse).length <= 2);
assert.ok(Object.keys(pool.accounts[0].modelCount).length <= 2);

const lease = pool.lease('long-running', { accountId });
assert.ok(lease);
now += 11;
assert.equal(pool.reapLeases(), 1);
assert.equal(pool.leases.size, 0);
assert.equal(pool.accounts[0].inFlight, 0);
assert.equal(pool.telemetry.leaseTimeouts, 1);

const second = pool.lease('cleanup', { accountId });
assert.ok(second);
pool.stopBackground();
assert.equal(pool.leases.size, 0, 'stop cleanup releases outstanding leases');
assert.equal(pool.accounts[0].inFlight, 0);
assert.equal(pool.leaseReaperTimer, null);
fs.rmSync(dir, { recursive: true, force: true });

console.log('account-pool retention tests: all passed');
