// Multi-account pool: manages N Sakana accounts, round-robins requests,
// auto-harvests new sessions via auto-session, detects rate-limits, and
// replenishes the pool.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const POOL_FILE = path.join(__dirname, '..', 'account_pool.json');
const MIN_POOL = parseInt(process.env.ACCOUNT_POOL_MIN || '5', 10);
const MAX_POOL = parseInt(process.env.ACCOUNT_POOL_MAX || '10', 10);
const REFRESH_INTERVAL = 20 * 60 * 1000; // 20 min

class AccountPool {
  constructor() {
    this.accounts = []; // { id, email, uid, cookieHeader, cookies, savedAt, state: 'active'|'rate_limited'|'expired'|'harvesting' }
    this.nextIdx = 0;
    this.load();
  }

  load() {
    try { this.accounts = JSON.parse(fs.readFileSync(POOL_FILE, 'utf8')); }
    catch { this.accounts = []; }
  }

  save() {
    fs.writeFileSync(POOL_FILE, JSON.stringify(this.accounts, null, 2));
  }

  count() { return this.accounts.length; }

  activeCount() { return this.accounts.filter(a => a.state === 'active').length; }

  /** Get next active account (round-robin). Returns null if none. */
  next() {
    const active = this.accounts.filter(a => a.state === 'active');
    if (!active.length) return null;
    const idx = this.nextIdx % active.length;
    this.nextIdx = (idx + 1) % active.length;
    return active[idx];
  }

  /** Mark an account as rate-limited (will be refreshed). */
  markRateLimited(id) {
    const acct = this.accounts.find(a => a.id === id);
    if (acct) { acct.state = 'rate_limited'; this.save(); }
  }

  /** Mark an account as expired. */
  markExpired(id) {
    const acct = this.accounts.find(a => a.id === id);
    if (acct) { acct.state = 'expired'; this.save(); }
  }

  /** Add a harvested session to the pool. */
  add(session) {
    const id = crypto.randomUUID();
    this.accounts.push({
      id, email: session.email || '', uid: session.uid || '',
      cookieHeader: session.cookieHeader || '',
      cookies: session.cookies || [],
      savedAt: Date.now(),
      state: 'active',
    });
    // Also add to the session.json for legacy compatibility
    fs.writeFileSync(path.join(__dirname, '..', 'session.json'), JSON.stringify(session, null, 2));
    this.save();
    this.trim();
    return id;
  }

  /** Remove old accounts keeping pool within MAX_POOL. */
  trim() {
    const active = this.accounts.filter(a => a.state === 'active');
    const others = this.accounts.filter(a => a.state !== 'active');
    if (active.length > MAX_POOL) {
      active.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
      this.accounts = active.slice(0, MAX_POOL).concat(others);
    }
    this.save();
  }

  /** Refresh all accounts (re-navigate to keep cookies fresh). */
  async refreshAll(harvestFn) {
    for (const acct of this.accounts) {
      try {
        if (acct.state === 'active' || acct.state === 'rate_limited') {
          const session = await harvestFn(acct);
          if (session) {
            acct.cookieHeader = session.cookieHeader;
            acct.cookies = session.cookies;
            acct.savedAt = Date.now();
            acct.state = 'active';
          }
        }
      } catch (e) {
        console.log('[account-pool] refresh failed for', acct.email || acct.id, ':', e.message);
      }
    }
    this.save();
  }

  /** Ensure pool has at least MIN_POOL active accounts. */
  async ensureMinPool(harvestFn) {
    const active = this.accounts.filter(a => a.state === 'active').length;
    const needed = Math.min(MIN_POOL - active, MAX_POOL - this.accounts.length);
    if (needed <= 0) return;
    console.log(`[account-pool] need ${needed} more accounts, harvesting...`);
    for (let i = 0; i < needed; i++) {
      try {
        const session = await harvestFn();
        if (session) this.add(session);
      } catch (e) {
        console.log('[account-pool] harvest failed:', e.message);
      }
    }
  }
}

module.exports = { AccountPool };