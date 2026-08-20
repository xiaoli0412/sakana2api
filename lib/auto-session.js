// Auto-session: launches a persistent Chromium (Xvfb on headless servers),
// bypasses the Cloudflare 5s shield, auto-logs-in via temp-mail + Firebase
// magic link, accepts the first-run ToS dialog, harvests cookies + tokens
// into session.json, and keeps the session fresh by re-navigating.
//
// Verified flow (2026-08): submit email in the "Log in" dialog -> a magic
// link arrives in the mail.tm inbox within seconds -> navigating the browser
// to that link completes Firebase sign-in and redirects back to the app.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const SESSION_FILE = path.join(__dirname, '..', 'session.json');
const PROFILE_DIR = path.join(__dirname, '..', '.browser-profile');
const MAIL_API = 'https://api.mail.tm';
const REFRESH_MS = 20 * 60 * 1000;       // cf_clearance TTL ~30min -> refresh every 20
const HOME_URL = 'https://chat.sakana.ai/';

let context = null;   // persistent browser context (survives restarts via PROFILE_DIR)
let timer = null;
let queue = Promise.resolve();  // serializes all browser operations (one context)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(...a) { console.log('[auto-session]', ...a); }

// Run browser ops strictly one-at-a-time (shared persistent context).
function withLock(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

/* ---------- mail.tm temp mailbox ---------- */

async function createTempMail() {
  const domainsRes = await fetch(MAIL_API + '/domains', { signal: AbortSignal.timeout(15000) });
  const domains = await domainsRes.json();
  const domainList = (domains['hydra:member'] || []).map(d => d.domain);
  const domain = domainList[0] || 'emalupe.com';
  const address = 'sak' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6) + '@' + domain;
  const password = 'Sakana2api!2026';
  
  const accRes = await fetch(MAIL_API + '/accounts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ address, password }),
    signal: AbortSignal.timeout(15000),
  });
  if (!accRes.ok) {
    const errText = await accRes.text();
    throw new Error(`failed to create temp mail account: ${accRes.status} ${errText}`);
  }

  const tokRes = await fetch(MAIL_API + '/token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ address, password }),
    signal: AbortSignal.timeout(15000),
  });
  const tok = await tokRes.json();
  if (!tok || !tok.token) throw new Error('failed to get temp mail auth token');
  return { address, password, token: tok.token };
}

async function pollMagicLink(mail, timeoutSec = 90) {
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    try {
      const msgsRes = await fetch(MAIL_API + '/messages', {
        headers: { Authorization: 'Bearer ' + mail.token },
        signal: AbortSignal.timeout(10000),
      });
      const msgs = await msgsRes.json();
      for (const m of (msgs['hydra:member'] || [])) {
        const fullRes = await fetch(MAIL_API + '/messages/' + m.id, {
          headers: { Authorization: 'Bearer ' + mail.token },
          signal: AbortSignal.timeout(10000),
        });
        const full = await fullRes.json();
        const html = typeof full.html === 'string' ? full.html : JSON.stringify(full.html);
        // stop at quotes — HTML hrefs are wrapped in ' or " and a stray quote
        // in tenantId= makes the Firebase handler fail the sign-in
        const l = html.match(/https:\/\/sakana-talk\.firebaseapp\.com\/__\/auth\/action\?[^"'<>\s]+/);
        if (l) return l[0].replace(/&amp;/g, '&');
      }
    } catch {}
    await sleep(3500);
  }
  throw new Error('magic link not received within ' + timeoutSec + 's');
}

function getChromePath() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return undefined;
}

async function ensureBrowser() {
  if (context && context.pages().length) return context;
  const chromePath = getChromePath();
  log(`launching persistent Chromium… (exec: ${chromePath || 'default playwright'})`);
  const opts = {
    headless: false,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--disable-blink-features=AutomationControlled', '--window-size=1280,900',
      '--lang=en-US',
    ],
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    viewport: { width: 1280, height: 900 },
  };
  if (chromePath) opts.executablePath = chromePath;
  context = await chromium.launchPersistentContext(PROFILE_DIR, opts);
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
  });
  return context;
}

/** Wait until the CF 5s shield resolves (title flips to "Sakana Chat"). */
async function passCfShield(page) {
  for (let i = 0; i < 60; i++) {
    const title = await page.title().catch(() => '');
    const cookies = await context.cookies('https://chat.sakana.ai/');
    const clearance = cookies.find((c) => c.name === 'cf_clearance');
    if (title === 'Sakana Chat' || (clearance && clearance.value.length > 50)) {
      log('CF shield passed (~%ds)', i * 2);
      return;
    }
    await sleep(2000);
  }
  log('WARN: CF shield may not have passed, continuing anyway');
}

/** True when the sidebar shows a signed-in user (no login button). */
async function isLoggedIn(page) {
  const cookies = await context.cookies('https://chat.sakana.ai/');
  if (!cookies.some((c) => c.name === 'sakana-chat')) return false;
  // Sakana 页面按钮文案曾在 "Log in"/"Sign in" 间切换,两种都视为未登录信号。
  const loginBtn = page.locator("button:has-text('Log in'), button:has-text('Sign in')").first();
  return !(await loginBtn.isVisible().catch(() => true));
}

/** Handle the first-run "Welcome to Sakana Chat!" ToS dialog. */
async function acceptTerms(page) {
  const dialog = page.getByRole('dialog');
  const start = dialog.getByRole('button', { name: 'Start chatting' });
  if (!(await start.isVisible({ timeout: 6000 }).catch(() => false))) return false;
  log('first-run dialog: accepting ToS…');
  // Sakana 的 ToS 复选框 role/name 匹配不稳定(2026-08 变过),改用 CSS 定位:
  // 勾选 dialog 内所有可见 checkbox(通常 Terms + Privacy 各一个),并保留
  // 旧的 role 匹配作为兜底。
  const boxes = dialog.locator('input[type="checkbox"]');
  const n = await boxes.count().catch(() => 0);
  let clicked = false;
  if (n > 0) {
    for (let i = 0; i < n; i++) {
      const visible = await boxes.nth(i).isVisible().catch(() => false);
      if (visible) {
        await boxes.nth(i).check({ force: true }).catch(() => {});
        clicked = true;
      }
    }
  } else {
    for (const name of [/Terms of Service/, /Privacy Policy/]) {
      const box = dialog.getByRole('checkbox', { name });
      if (await box.isVisible({ timeout: 1000 }).catch(() => false)) {
        await box.click().catch(() => {});
        clicked = true;
      }
    }
  }
  log(clicked ? 'ToS checkboxes accepted' : 'no ToS checkboxes found, proceeding');
  await sleep(500);
  await start.click({ force: true }).catch(() => start.click());
  await sleep(3000);
  return true;
}

/** Full email-magic-link login on the open page. */
async function emailLogin(page, mail) {
  log('opening login dialog…');
  // Sakana 按钮文案 2026-08 已从 "Log in" 改为 "Sign in";兼容两种。
  const loginBtn = page.locator("button:has-text('Log in'), button:has-text('Sign in')").first();
  await loginBtn.click();
  await sleep(1500);
  const emailBox = page.getByRole('textbox', { name: 'Email address' });
  await emailBox.fill(mail.address);
  await sleep(500);
  await page.getByRole('button', { name: 'Continue' }).click();
  log('magic link requested for ' + mail.address);

  const link = await pollMagicLink(mail);
  log('magic link received, completing sign-in…');
  await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((e) => log('goto link err: ' + e.message));
  log('after link: url=' + page.url());
  if (page.url().includes('firebaseapp.com')) {
    log('handler page body: ' + (await page.evaluate(() => document.body ? document.body.innerText.slice(0, 200) : '').catch(() => '?')));
  }
  await sleep(4000);

  // Firebase handler redirects back to the app; wait for the session cookie.
  for (let i = 0; i < 30; i++) {
    const cookies = await context.cookies('https://chat.sakana.ai/');
    if (cookies.some((c) => c.name === 'sakana-chat')) break;
    await sleep(2000);
  }
  await sleep(5000);
  await acceptTerms(page);
}

/** Read firebase tokens (uid/email/idToken/refreshToken) from IndexedDB. */
async function readFirebaseTokens(page) {
  try {
    return await page.evaluate(() => new Promise((resolve) => {
      const req = indexedDB.open('firebaseLocalStorageDb');
      req.onerror = () => resolve({});
      req.onsuccess = () => {
        let tx, store;
        try {
          tx = req.result.transaction('firebaseLocalStorage', 'readonly');
          store = tx.objectStore('firebaseLocalStorage');
        } catch (e) { return resolve({}); }
        const g = store.getAll();
        g.onerror = () => resolve({});
        g.onsuccess = () => {
          for (const row of g.result || []) {
            const v = row?.value;
            if (v?.stsTokenManager?.accessToken) {
              return resolve({
                uid: v.uid || '', email: v.email || '',
                isAnonymous: !!v.isAnonymous,
                idToken: v.stsTokenManager.accessToken,
                refreshToken: v.stsTokenManager.refreshToken || '',
              });
            }
          }
          resolve({});
        };
      };
    }));
  } catch (e) { return {}; }
}

/* ---------- harvest / refresh ---------- */

/**
 * Wipe browser identity (cookies + firebase indexedDB + localStorage) so a
 * fresh harvest logs in as a NEW account instead of resuming the old one.
 * Verified: after this, NO sakana-chat session cookie may remain — otherwise
 * the next "fresh" harvest just re-attaches to the previous account.
 */
async function clearIdentity(page) {
  for (let round = 0; round < 3; round++) {
    await context.clearCookies().catch(() => {});
    try {
      await page.evaluate(() => {
        localStorage.clear();
        sessionStorage.clear();
        return new Promise((resolve) => {
          const done = () => resolve();
          try {
            const req = indexedDB.deleteDatabase('firebaseLocalStorageDb');
            req.onsuccess = done; req.onerror = done; req.onblocked = done;
          } catch { done(); }
          setTimeout(done, 4000); // firebase may hold the connection -> never block forever
        });
      });
    } catch {}
    // Force a hard reload so the app re-initializes without the old identity.
    await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await sleep(1500);
    const cookies = await context.cookies('https://chat.sakana.ai/');
    if (!cookies.some((c) => c.name === 'sakana-chat')) {
      log('identity cleared (round %d)', round + 1);
      return true;
    }
    log('WARN: sakana-chat cookie survived identity wipe, round %d — retrying', round + 1);
  }
  // Last resort: override the session cookie value so the old identity cannot revive.
  const stale = await context.cookies('https://chat.sakana.ai/');
  for (const c of stale) {
    if (c.name === 'sakana-chat') await context.clearCookies({ name: c.name, domain: c.domain }).catch(() => {});
  }
  log('WARN: identity wipe incomplete — proceeding with best-effort cleared cookies');
  return false;
}

/**
 * Harvest a session. fresh=false reuses the persistent profile (usually one
 * account, saved in tempmail.json). fresh=true wipes identity and registers a
 * brand-new temp mailbox, yielding a distinct account every call.
 */
/**
 * Fresh-account login flow: wipe identity, register a brand-new temp mailbox,
 * complete magic-link sign-in, and VERIFY the session cookie really changed
 * (a leftover sakana-chat cookie means we "harvested" the previous account).
 */
async function freshLogin(page) {
  await clearIdentity(page);
  await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {});
  await passCfShield(page);
  const before = (await context.cookies('https://chat.sakana.ai/').catch(() => []))
    .filter((c) => c.name === 'sakana-chat').map((c) => c.value)[0] || '';

  const mail = await createTempMail();
  log('fresh mailbox created: ' + mail.address);
  await emailLogin(page, mail);

  const after = (await context.cookies('https://chat.sakana.ai/').catch(() => []))
    .filter((c) => c.name === 'sakana-chat').map((c) => c.value)[0] || '';
  if (!after) throw new Error('no sakana-chat cookie after login');
  if (before && before === after) throw new Error('session cookie unchanged after fresh login — re-attached to previous account');
  return mail;
}

async function harvestSession({ fresh = false } = {}) {
  const ctx = await ensureBrowser();
  const page = ctx.pages()[0] || await ctx.newPage();
  log(`harvesting (fresh=${fresh})…`);
  await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 90000 }).catch((e) => log('goto:', e.message));
  await passCfShield(page);

  if (fresh) {
    // New identity + new mailbox on every fresh harvest. Retry the whole
    // login flow once — upstream sign-in is flaky under load.
    try {
      await freshLogin(page);
    } catch (e) {
      log('fresh login attempt 1 failed (%s) — retrying once', e.message);
      await sleep(3000);
      await freshLogin(page);
    }
  } else if (!(await isLoggedIn(page))) {
    // Fresh profile (no login) -> full email login; saved mailbox reused when present.
    let mail = {};
    try { mail = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'tempmail.json'), 'utf8')); } catch {}
    if (!mail.token || !mail.address) {
      mail = await createTempMail();
      fs.writeFileSync(path.join(__dirname, '..', 'tempmail.json'), JSON.stringify(mail));
      log('temp mailbox created: ' + mail.address);
    }
    await emailLogin(page, mail);
  } else {
    log('already logged in (profile session), skipping login');
  }

  if (!(await isLoggedIn(page))) {
    throw new Error('login failed — not logged in after harvest');
  }

  const cookies = await context.cookies('https://chat.sakana.ai/');
  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  const tokens = await readFirebaseTokens(page);
  const session = {
    savedAt: Date.now(),
    loggedIn: true,
    cookieHeader,
    cookies: cookies.map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path })),
    uid: tokens.uid || '',
    email: tokens.email || '',
    isAnonymous: !!tokens.isAnonymous,
    idToken: tokens.idToken || '',
    refreshToken: tokens.refreshToken || '',
  };
  fs.writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2));
  log(`session saved: loggedIn=true cookies=${cookies.length} uid=${session.uid || '-'} email=${session.email || '-'} sess=${cookieHeader.match(/sakana-chat=([^;]+)/)?.[1]?.slice(0, 8) || '-'}`);
  return session;
}

/**
 * Refresh an existing account's cookies in-place: load its saved cookies into
 * the browser, navigate (renews cf_clearance), read back. Returns the updated
 * session, or null when the login is gone (caller should replace the account).
 */
async function refreshAccount(acct) {
  const ctx = await ensureBrowser();
  const page = ctx.pages()[0] || await ctx.newPage();
  if (!acct || !acct.cookies || !acct.cookies.length) return null;
  await context.clearCookies().catch(() => {});
  try {
    await context.addCookies(acct.cookies.filter((c) => c.domain && c.name));
  } catch (e) {
    log('addCookies failed:', e.message);
    return null;
  }
  log(`refreshing account ${(acct.email || acct.id || '').slice(0, 24)}…`);
  await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((e) => log('goto:', e.message));
  await passCfShield(page);
  await sleep(4000);
  if (!(await isLoggedIn(page))) return null;
  const cookies = await context.cookies('https://chat.sakana.ai/');
  const tokens = await readFirebaseTokens(page);
  if (!cookies.length) return null;
  return {
    savedAt: Date.now(),
    loggedIn: true,
    cookieHeader: cookies.map((c) => `${c.name}=${c.value}`).join('; '),
    cookies: cookies.map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path })),
    uid: tokens.uid || acct.uid || '',
    email: tokens.email || acct.email || '',
    isAnonymous: !!tokens.isAnonymous,
    idToken: tokens.idToken || acct.idToken || '',
    refreshToken: tokens.refreshToken || acct.refreshToken || '',
  };
}

/** Cheap keep-alive: reload the page so cf_clearance/_dd_s stay fresh. */
async function refreshSession() {
  if (!context) return harvestSession();
  try {
    const page = context.pages()[0] || await context.newPage();
    log('refreshing session (reload)…');
    await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(8000);
    if (!(await isLoggedIn(page))) {
      log('login lost during refresh — re-logging in');
      return harvestSession();
    }
    const cookies = await context.cookies('https://chat.sakana.ai/');
    const session = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    session.savedAt = Date.now();
    session.cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    session.cookies = cookies.map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path }));
    fs.writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2));
    log('session refreshed: ' + cookies.length + ' cookies');
    return session;
  } catch (e) {
    log('refresh failed (%s) — re-harvesting', e.message);
    return harvestSession();
  }
}

/* ---------- lifecycle ---------- */

async function start() {
  if (timer) { clearInterval(timer); timer = null; }
  const session = await withLock(() => harvestSession());
  timer = setInterval(() => { withLock(() => refreshSession()).catch(() => {}); }, REFRESH_MS);
  return session;
}

async function stop() {
  if (timer) { clearInterval(timer); timer = null; }
  if (context) { try { await context.close(); } catch {} context = null; }
}

async function getSession() {
  if (fs.existsSync(SESSION_FILE)) {
    const s = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    if (Date.now() - (s.savedAt || 0) > REFRESH_MS) refreshSession().catch(() => {});
    return s;
  }
  throw new Error('no session yet — auto-session still harvesting');
}

module.exports = {
  autoSession: {
    start, stop, getSession, harvestSession, refreshSession,
    // Serialized fresh-account harvest (browser context is shared — one at a
    // time). This is the ONLY entry point the pool/keeper should use.
    harvestFresh: () => withLock(() => harvestSession({ fresh: true })),
    harvestSessionLocked: () => withLock(() => harvestSession()),
    refreshAccount: (acct) => withLock(() => refreshAccount(acct)),
    _queue: () => withLock(async () => true),
  },
};