// Account-pool regression tests (TDD targets).
//
// The prod incident of 2026-08-16: the background refresh cycle stamped the
// browser profile's IndexedDB identity (uid/email) onto EVERY account in the
// pool, so all 10 entries showed the same email/uid even though each held a
// distinct sakana-chat session cookie. Two failures combined:
//   1. refreshAccount() returned foreign identity fields and the pool
//      overwrote each account's own uid/email with them.
//   2. dedupe/load keys were uid-based, so a restart after (1) would have
//      COLLAPSED 10 distinct sessions into 1 entry.
// These tests pin the fixed behavior.
import { AccountPool } from '../lib/account-pool.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let failures = 0;
function check(name, cond, extra = '') {
  if (cond) console.log('  ✓', name);
  else { failures++; console.log('  ✗', name, extra); }
}

// ----- helpers -----
function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sakana-pool-'));
}
const mkAcct = (uid, sessionValue, extra = {}) => ({
  id: 'id-' + Math.random().toString(36).slice(2, 8),
  uid, email: extra.email || (uid ? `u${uid.slice(0, 6)}@emalupe.com` : ''),
  cookieHeader: `sakana-chat=${sessionValue}; cf_clearance=x`,
  cookies: [],
  savedAt: Date.now(),
  state: 'active',
  inFlight: 0,
  ...extra,
});

console.log('== account-pool regression tests ==');

// ---- TEST 1: load() must NOT collapse distinct sessions that share a (bleed-polluted) uid ----
{
  const dir = tmpDir();
  const file = path.join(dir, 'account_pool.json');
  const a = mkAcct('SAME-UID', 'sess-aaa');
  const b = mkAcct('SAME-UID', 'sess-bbb');
  const c = mkAcct('SAME-UID', 'sess-ccc');
  fs.writeFileSync(file, JSON.stringify([a, b, c]));
  const pool = new AccountPool(file, path.join(dir, 'session.json'));
  check('T1 load keeps 3 distinct sessions despite identical uid', pool.count() === 3, `got ${pool.count()}`);
  const keys = pool.accounts.map(x => (x.uid || '') + '#' + ((x.cookieHeader || '').split('sakana-chat=')[1] || '').split(';')[0]);
  check('T1 all 3 session identities preserved', new Set(keys).size === 3);
}

// ---- TEST 2: load() still dedupes EXACT duplicates (same uid AND same session cookie) ----
{
  const dir = tmpDir();
  const file = path.join(dir, 'account_pool.json');
  const a = mkAcct('UID-X', 'sess-same');
  const dup = { ...a }; // identical entry
  fs.writeFileSync(file, JSON.stringify([a, dup]));
  const pool = new AccountPool(file, path.join(dir, 'session.json'));
  check('T2 exact duplicate entries collapse to 1', pool.count() === 1, `got ${pool.count()}`);
}

// ---- TEST 3: add() accepts same-uid/different-session, rejects identical session ----
{
  const dir = tmpDir();
  const pool = new AccountPool(path.join(dir, 'account_pool.json'), path.join(dir, 'session.json'));
  const s1 = { uid: 'UID-1', email: 'one@x.com', cookieHeader: 'sakana-chat=cookie-1; a=b', cookies: [], savedAt: Date.now(), state: 'active' };
  const s2 = { uid: 'UID-1', email: 'one@x.com', cookieHeader: 'sakana-chat=cookie-2; a=b', cookies: [], savedAt: Date.now(), state: 'active' };
  const s1again = { uid: 'UID-1', email: 'one@x.com', cookieHeader: 'sakana-chat=cookie-1; a=b', cookies: [], savedAt: Date.now(), state: 'active' };
  const id1 = pool.add(s1);
  const id2 = pool.add(s2);
  const id3 = pool.add(s1again);
  check('T3 add accepts distinct sessions of same uid', id1 && id2, `id1=${id1} id2=${id2}`);
  check('T3 add rejects identical session re-add', id3 === null, `id3=${id3}`);
  check('T3 pool holds 2 entries', pool.count() === 2, `got ${pool.count()}`);
}

// ---- TEST 4: applyRefresh (the real production refresh path) must NOT overwrite identity ----
{
  const dir = tmpDir();
  const pool = new AccountPool(path.join(dir, 'account_pool.json'), path.join(dir, 'session.json'));
  const acct = pool.add({ uid: 'REAL-UID-1', email: 'real1@emalupe.com', cookieHeader: 'sakana-chat=real-sess; x=y', cookies: [], savedAt: Date.now(), state: 'active' });
  const entry = pool.accounts.find(a => a.id === acct);

  // The buggy refreshFn returns a session whose uid/email come from the
  // browser profile's IndexedDB (a DIFFERENT account).
  const fresh = { cookieHeader: `sakana-chat=real-sess; cf_clearance=newcf`, cookies: [], savedAt: Date.now(), loggedIn: true, uid: 'FOREIGN-UID', email: 'foreign@emalupe.com' };
  pool.applyRefresh(entry, fresh);
  check('T4 refresh keeps the account\'s own uid', entry.uid === 'REAL-UID-1', `got ${entry.uid}`);
  check('T4 refresh keeps the account\'s own email', entry.email === 'real1@emalupe.com', `got ${entry.email}`);
  check('T4 refresh updates cookies + state + refreshes count', entry.cookieHeader.includes('cf_clearance=newcf') && entry.state === 'active' && entry.refreshes === 1);
}

// ---- TEST 5: save() round-trips the bleed-polluted shape losslessly (10 same-uid distinct sessions) ----
{
  const dir = tmpDir();
  const file = path.join(dir, 'account_pool.json');
  const pool = new AccountPool(file, path.join(dir, 'session.json'));
  pool.accounts = Array.from({ length: 10 }, (_, i) => mkAcct('POLLUTED-UID', `sess-${i}`));
  pool.save();
  const reloaded = new AccountPool(file, path.join(dir, 'session.json'));
  check('T5 save/load round-trip keeps all 10 same-uid distinct sessions', reloaded.count() === 10, `got ${reloaded.count()}`);
}

console.log(failures ? `\nRESULT: ${failures} FAILED` : '\nRESULT: all passed');
process.exit(failures ? 1 : 0);