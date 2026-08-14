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
  const domains = await (await fetch(MAIL_API + '/domains')).json();
  const domain = (domains['hydra:member'] || [])[0]?.domain || 'emalupe.com';
  const address = 'sak' + Date.now().toString(36) + '@' + domain;
  const password = 'Sakana2api!2026';
  await fetch(MAIL_API + '/accounts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ address, password }),
  });
  const tok = await (await fetch(MAIL_API + '/token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ address, password }),
  })).json();
  return { address, password, token: tok.token };
}

async function pollMagicLink(mail, timeoutSec = 90) {
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    const msgs = await (await fetch(MAIL_API + '/messages', {
      headers: { Authorization: 'Bearer ' + mail.token },
    })).json();
    for (const m of (msgs['hydra:member'] || [])) {
      const full = await (await fetch(MAIL_API + '/messages/' + m.id, {
        headers: { Authorization: 'Bearer ' + mail.token },
      })).json();
      const html = typeof full.html === 'string' ? full.html : JSON.stringify(full.html);
      // stop at quotes — HTML hrefs are wrapped in ' or " and a stray quote
      // in tenantId= makes the Firebase handler fail the sign-in
      const l = html.match(/https:\/\/sakana-talk\.firebaseapp\.com\/__\/auth\/action\?[^"'<>\s]+/);
      if (l) return l[0].replace(/&amp;/g, '&');
    }
    await sleep(4000);
  }
  throw new Error('magic link not received within ' + timeoutSec + 's');
}

/* ---------- browser ---------- */

async function ensureBrowser() {
  if (context && context.pages().length) return context;
  log('launching persistent Chromium…');
  context = await chromium.launchPersistentContext(PROFILE_DIR, {
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
  });
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

/** True when the sidebar shows a signed-in user (no "Log in" button). */
async function isLoggedIn(page) {
  const cookies = await context.cookies('https://chat.sakana.ai/');
  if (!cookies.some((c) => c.name === 'sakana-chat')) return false;
  const loginBtn = page.getByRole('button', { name: 'Log in' });
  return !(await loginBtn.isVisible().catch(() => true));
}

/** Handle the first-run "Welcome to Sakana Chat!" ToS dialog. */
async function acceptTerms(page) {
  const dialog = page.getByRole('dialog');
  const start = dialog.getByRole('button', { name: 'Start chatting' });
  if (!(await start.isVisible({ timeout: 6000 }).catch(() => false))) return false;
  log('first-run dialog: accepting ToS…');
  await dialog.getByRole('checkbox', { name: /Terms of Service/ }).click();
  await dialog.getByRole('checkbox', { name: /Privacy Policy/ }).click();
  await sleep(500);
  await start.click();
  await sleep(3000);
  return true;
}

/** Full email-magic-link login on the open page. */
async function emailLogin(page, mail) {
  log('opening "Log in" dialog…');
  await page.getByRole('button', { name: 'Log in' }).click();
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
 */
async function clearIdentity(page) {
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
}

/**
 * Harvest a session. fresh=false reuses the persistent profile (usually one
 * account, saved in tempmail.json). fresh=true wipes identity and registers a
 * brand-new temp mailbox, yielding a distinct account every call.
 */
async function harvestSession({ fresh = false } = {}) {
  const ctx = await ensureBrowser();
  const page = ctx.pages()[0] || await ctx.newPage();
  log(`harvesting (fresh=${fresh})…`);
  await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 90000 }).catch((e) => log('goto:', e.message));
  await passCfShield(page);

  if (fresh) {
    // New identity + new mailbox on every fresh harvest.
    await clearIdentity(page);
    await passCfShield(page);
    const mail = await createTempMail();
    log('fresh mailbox created: ' + mail.address);
    await emailLogin(page, mail);
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
  log(`session saved: loggedIn=true cookies=${cookies.length} uid=${session.uid || '-'} email=${session.email || '-'}`);
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
    refreshAccount: (acct) => withLock(() => refreshAccount(acct)),
    _queue: () => withLock(async () => true),
  },
};