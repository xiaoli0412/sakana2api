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
const crypto = require('crypto');

const SESSION_FILE = process.env.SAKANA_SESSION_FILE || path.join(__dirname, '..', 'session.json');
const PROFILE_DIR = path.join(__dirname, '..', '.browser-profile');
const MAIL_API = 'https://api.mail.tm';
const REFRESH_MS = 20 * 60 * 1000;       // cf_clearance TTL ~30min -> refresh every 20
const HOME_URL = 'https://chat.sakana.ai/';
const HARVEST_CONCURRENCY = Math.min(3, Math.max(1, Number.parseInt(process.env.HARVEST_CONCURRENCY || '1', 10) || 1));

let context = null;   // persistent browser context (survives restarts via PROFILE_DIR)
let browserStart = null;
let browserStartGeneration = 0;
let timer = null;
let queue = Promise.resolve();  // serializes all browser operations (one context)
const browserState = {
  launches: 0,
  recoveries: 0,
  lastError: '',
  lastErrorAt: 0,
  lastRecoveryAt: 0,
};
let launchContext = (opts) => chromium.launchPersistentContext(PROFILE_DIR, opts);
let launchIsolatedBrowser = (opts) => chromium.launch(opts);

async function interruptibleWait(ms, signal = operationController.signal, generation = operationGeneration) {
  assertOperationActive(generation, signal);
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(stoppedError());
    signal.addEventListener?.('abort', onAbort, { once: true });
  });
  try {
    await Promise.race([Promise.resolve(wait(ms)), aborted]);
  } finally {
    signal.removeEventListener?.('abort', onAbort);
  }
  assertOperationActive(generation, signal);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CRASH_RETRIES = Math.max(0, parseInt(process.env.AUTO_SESSION_CRASH_RETRIES || '2', 10));
const CRASH_BACKOFF_MS = Math.max(0, parseInt(process.env.AUTO_SESSION_CRASH_BACKOFF_MS || '1000', 10));
const STOP_DRAIN_MS = Math.max(0, parseInt(process.env.AUTO_SESSION_STOP_DRAIN_MS || '5000', 10));
let wait = sleep;
let stopping = false;
let operationGeneration = 0;
let operationController = new AbortController();
let stopPromise = null;
const isolatedHarvests = new Map();

function stoppedError() {
  return Object.assign(new Error('auto-session stopped'), { code: 'SERVER-SHUTDOWN' });
}

function assertOperationActive(generation = operationGeneration, signal = null) {
  if (stopping || generation !== operationGeneration || operationController.signal.aborted || signal?.aborted) throw stoppedError();
}

function operationSignal(generation = operationGeneration, externalSignal = null) {
  assertOperationActive(generation, externalSignal);
  if (!externalSignal) return operationController.signal;
  return AbortSignal.any([operationController.signal, externalSignal]);
}

function atomicWriteJson(file, value) {
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
    try { fs.chmodSync(file, 0o600); } catch {}
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    throw err;
  }
}

function sessionCookie(value) {
  return ((value?.cookieHeader || '').match(/(?:^|;\s*)sakana-chat=([^;]+)/) || [])[1] || '';
}

function log(...a) { console.log('[auto-session]', ...a); }

function isBrowserCrashError(err) {
  const msg = String(err?.message || err || '').toLowerCase();
  return /target crashed|browser has been closed|context has been closed|page has been closed/.test(msg);
}

function safeBrowserError(reason) {
  const raw = String(reason?.errorCode || reason?.code || reason?.name || reason || '').toUpperCase();
  if (raw.includes('TIMEOUT')) return 'timeout';
  if (raw.includes('ABORT')) return 'canceled';
  if (/AUTH|CF-403|LOGIN/.test(raw)) return 'auth';
  if (/TARGET CRASHED|BROWSER HAS BEEN CLOSED|CONTEXT HAS BEEN CLOSED|PAGE HAS BEEN CLOSED/.test(raw)) return 'browser_crash';
  return 'browser_error';
}

async function discardBrowser(reason, countRecovery = true) {
  const old = context;
  context = null;
  if (old) {
    try { await withTimeout(old.close(), STOP_DRAIN_MS); } catch {}
  }
  if (!countRecovery) return;
  browserState.recoveries++;
  browserState.lastError = safeBrowserError(reason);
  browserState.lastErrorAt = Date.now();
  browserState.lastRecoveryAt = Date.now();
}

async function withBrowserRecovery(operation, generation = operationGeneration, signal = null) {
  const activeSignal = operationSignal(generation, signal);
  for (let attempt = 0; ; attempt++) {
    assertOperationActive(generation, activeSignal);
    try {
      const result = await operation();
      assertOperationActive(generation, activeSignal);
      return result;
    } catch (err) {
      if (stopping || generation !== operationGeneration || activeSignal.aborted) throw stoppedError();
      if (!isBrowserCrashError(err) || attempt >= CRASH_RETRIES) throw err;
      await discardBrowser(err);
      await interruptibleWait(Math.min(CRASH_BACKOFF_MS * (2 ** attempt), 30000), activeSignal, generation);
    }
  }
}

function withTimeout(promise, ms) {
  const boundedMs = Math.max(0, Number(ms) || 0);
  let timerId;
  const timeout = new Promise((_, reject) => {
    timerId = setTimeout(() => reject(new Error('auto-session stop drain timeout')), boundedMs);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timerId));
}

function closeIsolatedSlot(slot, timeoutMs = STOP_DRAIN_MS) {
  if (!slot) return Promise.resolve();
  if (slot.closePromise) return slot.closePromise;
  slot.closePromise = (async () => {
    const contextToClose = slot.context;
    const browserToClose = slot.browser;
    const close = (value) => value?.close
      ? withTimeout(Promise.resolve().then(() => value.close()), timeoutMs).catch(() => {})
      : Promise.resolve();
    await Promise.allSettled([close(contextToClose), close(browserToClose)]);
    slot.context = null;
    slot.browser = null;
  })().finally(() => {
    slot.closePromise = null;
  });
  return slot.closePromise;
}

async function launchIsolatedWithAbort(options, signal) {
  const launchPromise = Promise.resolve().then(() => launchIsolatedBrowser(options));
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(signal?.reason instanceof Error ? signal.reason : stoppedError());
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([launchPromise, aborted]);
  } catch (err) {
    // Playwright cannot cancel chromium.launch(). Close a browser that resolves
    // after the request has already been aborted, without keeping the harvest alive.
    launchPromise.then((browser) => {
      if (browser?.close) {
        withTimeout(Promise.resolve().then(() => browser.close()), STOP_DRAIN_MS).catch(() => {});
      }
    }).catch(() => {});
    throw err;
  } finally {
    signal?.removeEventListener?.('abort', onAbort);
  }
}

async function withIsolatedBrowserRecovery(operation, generation = operationGeneration, signal = null) {
  const activeSignal = operationSignal(generation, signal);
  for (let attempt = 0; ; attempt++) {
    assertOperationActive(generation, activeSignal);
    try {
      const result = await operation();
      assertOperationActive(generation, activeSignal);
      return result;
    } catch (err) {
      if (stopping || generation !== operationGeneration || activeSignal.aborted) throw stoppedError();
      if (!isBrowserCrashError(err) || attempt >= CRASH_RETRIES) throw err;
      browserState.lastError = safeBrowserError(err);
      browserState.lastErrorAt = Date.now();
      browserState.lastRecoveryAt = Date.now();
      await interruptibleWait(Math.min(CRASH_BACKOFF_MS * (2 ** attempt), 30000), activeSignal, generation);
    }
  }
}

function withLock(fn) {
  const generation = operationGeneration;
  const run = queue.then(
    () => {
      if (stopping || generation !== operationGeneration) throw stoppedError();
      return fn(generation);
    },
    () => {
      if (stopping || generation !== operationGeneration) throw stoppedError();
      return fn(generation);
    },
  );
  queue = run.catch(() => {});
  return run;
}

/* ---------- mail.tm temp mailbox ---------- */

async function createTempMail(signal = operationController.signal) {
  const domainsRes = await fetch(MAIL_API + '/domains', { signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) });
  const domains = await domainsRes.json();
  const domainList = (domains['hydra:member'] || []).map(d => d.domain);
  const domain = domainList[0] || 'emalupe.com';
  const address = 'sak' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6) + '@' + domain;
  const password = 'Sakana2api!2026';
  
  const accRes = await fetch(MAIL_API + '/accounts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ address, password }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
  });
  if (!accRes.ok) {
    const errText = await accRes.text();
    throw new Error(`failed to create temp mail account: ${accRes.status} ${errText}`);
  }

  const tokRes = await fetch(MAIL_API + '/token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ address, password }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
  });
  const tok = await tokRes.json();
  if (!tok || !tok.token) throw new Error('failed to get temp mail auth token');
  return { address, password, token: tok.token };
}

async function pollMagicLink(mail, timeoutSec = 90, signal = operationController.signal, generation = operationGeneration) {
  const activeSignal = operationSignal(generation, signal);
  const deadline = Date.now() + timeoutSec * 1000;
  let pollDelayMs = 1000;
  while (Date.now() < deadline) {
    assertOperationActive(generation, activeSignal);
    try {
      const requestSignal = () => AbortSignal.any([activeSignal, AbortSignal.timeout(10000)]);
      const msgsRes = await fetch(MAIL_API + '/messages', {
        headers: { Authorization: 'Bearer ' + mail.token },
        signal: requestSignal(),
      });
      const msgs = await msgsRes.json();
      for (const m of (msgs['hydra:member'] || [])) {
        const fullRes = await fetch(MAIL_API + '/messages/' + m.id, {
          headers: { Authorization: 'Bearer ' + mail.token },
          signal: requestSignal(),
        });
        const full = await fullRes.json();
        const html = typeof full.html === 'string' ? full.html : JSON.stringify(full.html);
        // stop at quotes — HTML hrefs are wrapped in ' or " and a stray quote
        // in tenantId= makes the Firebase handler fail the sign-in
        const l = html.match(/https:\/\/sakana-talk\.firebaseapp\.com\/__\/auth\/action\?[^"'<>\s]+/);
        if (l) return l[0].replace(/&amp;/g, '&');
      }
    } catch (err) {
      if (activeSignal?.aborted || generation !== operationGeneration || stopping) throw stoppedError();
    }
    // Fast-start exponential backoff: the magic link usually lands within a
    // few seconds, so poll 1s first and only settle back to 5s.
    await interruptibleWait(pollDelayMs, signal, generation);
    pollDelayMs = Math.min(5000, Math.round(pollDelayMs * 1.5));
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

function browserLaunchOptions({ headless = false, persistent = false } = {}) {
  const chromePath = getChromePath();
  const opts = {
    headless,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--disable-blink-features=AutomationControlled', '--window-size=1280,900',
      '--lang=en-US',
    ],
  };
  if (chromePath) opts.executablePath = chromePath;
  if (persistent) Object.assign(opts, browserContextOptions());
  return opts;
}

function browserContextOptions() {
  return {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    viewport: { width: 1280, height: 900 },
  };
}

async function createIsolatedHarvestContext(generation, signal, slot = null) {
  assertOperationActive(generation, signal);
  const setupPromise = (async () => {
    const browser = await launchIsolatedWithAbort(browserLaunchOptions({ headless: true }), signal);
    if (slot) slot.browser = browser;
    try {
      assertOperationActive(generation, signal);
      const ctx = await browser.newContext(browserContextOptions());
      if (slot) slot.context = ctx;
      await ctx.addInitScript?.(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] });
        Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      });
      assertOperationActive(generation, signal);
      log('isolated harvest context ready');
      return { browser, context: ctx };
    } catch (err) {
      if (slot) {
        await closeIsolatedSlot(slot, STOP_DRAIN_MS);
      } else {
        await withTimeout(browser.close(), STOP_DRAIN_MS).catch(() => {});
      }
      throw err;
    }
  })();
  if (slot) slot.setupPromise = setupPromise;
  try {
    return await setupPromise;
  } finally {
    if (slot?.setupPromise === setupPromise) slot.setupPromise = null;
  }
}

function bindContextLifecycle(ctx) {
  const invalidate = () => {
    if (context !== ctx) return;
    context = null;
  };
  ctx.on?.('close', invalidate);
  try { ctx.browser?.()?.on?.('disconnected', invalidate); } catch {}
}

function contextPageCount() {
  try { return context ? context.pages().length : 0; } catch { return 0; }
}

function browserStatus() {
  return {
    hasContext: !!context,
    pageCount: contextPageCount(),
    launches: browserState.launches,
    recoveries: browserState.recoveries,
    lastError: browserState.lastError || null,
    lastErrorAt: browserState.lastErrorAt,
    lastRecoveryAt: browserState.lastRecoveryAt,
  };
}

async function ensureBrowser(generation = operationGeneration, signal = null) {
  const activeSignal = operationSignal(generation, signal);
  assertOperationActive(generation, activeSignal);
  if (context) {
    try {
      context.pages();
      return context;
    } catch {
      context = null;
    }
  }
  if (browserStart) {
    if (browserStartGeneration === generation) {
      const started = await browserStart;
      assertOperationActive(generation, activeSignal);
      return started;
    }
    browserStart = null;
    browserStartGeneration = 0;
  }
  const launchGeneration = generation;
  browserStartGeneration = launchGeneration;
  const launchPromise = (async () => {
    const chromePath = getChromePath();
    log(`launching persistent Chromium… (exec: ${chromePath || 'default playwright'})`);
    const opts = browserLaunchOptions({ headless: false, persistent: true });
    const ctx = await launchContext(opts);
    if (stopping || launchGeneration !== operationGeneration || activeSignal.aborted) {
      try { await ctx.close(); } catch {}
      throw stoppedError();
    }
    await ctx.addInitScript?.(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    });
    assertOperationActive(launchGeneration, activeSignal);
    bindContextLifecycle(ctx);
    context = ctx;
    browserState.launches++;
    return ctx;
  })();
  browserStart = launchPromise;
  try {
    return await launchPromise;
  } finally {
    if (browserStart === launchPromise && browserStartGeneration === launchGeneration) {
      browserStart = null;
      browserStartGeneration = 0;
    }
  }
}

async function gotoOrThrow(page, url, options, label = 'goto') {
  try {
    return await page.goto(url, options);
  } catch (err) {
    if (isBrowserCrashError(err)) throw err;
    log(label + ':', safeBrowserError(err));
    return null;
  }
}

async function passCfShield(page, ctx = context, generation = operationGeneration, signal = null) {
  const activeSignal = operationSignal(generation, signal);
  assertOperationActive(generation, activeSignal);
  for (let i = 0; i < 60; i++) {
    assertOperationActive(generation, activeSignal);
    const title = await page.title().catch(() => '');
    const cookies = await ctx.cookies('https://chat.sakana.ai/');
    assertOperationActive(generation, activeSignal);
    const clearance = cookies.find((c) => c.name === 'cf_clearance');
    if (title === 'Sakana Chat' || (clearance && clearance.value.length > 50)) {
      log('CF shield passed (~%ds)', i * 2);
      return;
    }
    await interruptibleWait(2000, activeSignal, generation);
  }
  assertOperationActive(generation, activeSignal);
  log('WARN: CF shield may not have passed, continuing anyway');
}

/** True when the sidebar shows a signed-in user (no login button). */
async function isLoggedIn(page, ctx = context, generation = operationGeneration, signal = null) {
  const activeSignal = operationSignal(generation, signal);
  assertOperationActive(generation, activeSignal);
  const cookies = await ctx.cookies('https://chat.sakana.ai/');
  assertOperationActive(generation, activeSignal);
  if (!cookies.some((c) => c.name === 'sakana-chat')) return false;
  // Sakana 页面按钮文案曾在 "Log in"/"Sign in" 间切换,两种都视为未登录信号。
  const loginBtn = page.locator("button:has-text('Log in'), button:has-text('Sign in')").first();
  return !(await loginBtn.isVisible().catch(() => true));
}

/** Handle the first-run "Welcome to Sakana Chat!" ToS dialog. */
async function acceptTerms(page, generation = operationGeneration, signal = null) {
  const activeSignal = operationSignal(generation, signal);
  assertOperationActive(generation, activeSignal);
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
  await start.click({ force: true }).catch(() => start.click());
  // Wait for the dialog to actually close instead of a blind 3.5s sleep.
  const closed = await dialog.waitFor({ state: 'hidden', timeout: 8000 }).then(() => true).catch(() => false);
  if (!closed) await interruptibleWait(1500, activeSignal, generation);
  return true;
}

/** Full email-magic-link login on the open page. */
async function emailLogin(page, mail, ctx = context, generation = operationGeneration, signal = null) {
  const activeSignal = operationSignal(generation, signal);
  assertOperationActive(generation, activeSignal);
  log('opening login dialog…');
  // Sakana 按钮文案 2026-08 已从 "Log in" 改为 "Sign in";兼容两种。
  const loginBtn = page.locator("button:has-text('Log in'), button:has-text('Sign in')").first();
  await loginBtn.click();
  // Event-driven waits replace the old fixed sleeps: wait for the email box
  // to become actionable instead of a blind 1.5s+0.5s.
  const emailBox = page.getByRole('textbox', { name: 'Email address' });
  await emailBox.waitFor({ state: 'visible', timeout: 15000 }).catch(async () => {
    // Some tenants animate the dialog slowly; one bounded fallback retry.
    await interruptibleWait(1500, activeSignal, generation);
    await emailBox.waitFor({ state: 'visible', timeout: 10000 });
  });
  await emailBox.fill(mail.address);
  await page.getByRole('button', { name: 'Continue' }).click();
  log('magic link requested for ' + mail.address);

  const link = await pollMagicLink(mail, 90, activeSignal, generation);
  assertOperationActive(generation, activeSignal);
  log('magic link received, completing sign-in…');
  await gotoOrThrow(page, link, { waitUntil: 'domcontentloaded', timeout: 60000 }, 'goto link');
  try {
    const u = new URL(page.url());
    log('after magic link navigation: ' + u.origin + u.pathname);
  } catch {
    log('after magic link navigation');
  }
  if (page.url().includes('firebaseapp.com')) {
    log('firebase handler page reached');
  }

  // Firebase handler redirects back to the app; poll the session cookie every
  // 500ms (was a blind 4s sleep + 30×2s loop + 5s sleep ≈ up to 69s).
  const cookieDeadline = Date.now() + 60000;
  let hasSession = false;
  while (Date.now() < cookieDeadline) {
    const cookies = await ctx.cookies('https://chat.sakana.ai/');
    assertOperationActive(generation, activeSignal);
    if (cookies.some((c) => c.name === 'sakana-chat')) { hasSession = true; break; }
    await interruptibleWait(500, activeSignal, generation);
  }
  if (!hasSession) log('WARN: session cookie not observed within 60s, continuing');
  // Give the SPA a moment to render the logged-in UI, then confirm.
  const readyDeadline = Date.now() + 10000;
  while (Date.now() < readyDeadline) {
    assertOperationActive(generation, activeSignal);
    if (await isLoggedIn(page, ctx, generation, activeSignal).catch(() => false)) break;
    await interruptibleWait(500, activeSignal, generation);
  }
  await acceptTerms(page, generation, activeSignal);
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
async function clearIdentity(page, ctx = context, generation = operationGeneration, signal = null) {
  const activeSignal = operationSignal(generation, signal);
  for (let round = 0; round < 3; round++) {
    assertOperationActive(generation, activeSignal);
    await ctx.clearCookies().catch(() => {});
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
    await gotoOrThrow(page, HOME_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await interruptibleWait(1500, activeSignal, generation);
    const cookies = await ctx.cookies('https://chat.sakana.ai/');
    assertOperationActive(generation, activeSignal);
    if (!cookies.some((c) => c.name === 'sakana-chat')) {
      log('identity cleared (round %d)', round + 1);
      return true;
    }
    log('WARN: sakana-chat cookie survived identity wipe, round %d — retrying', round + 1);
  }
  // Last resort: override the session cookie value so the old identity cannot revive.
  const stale = await ctx.cookies('https://chat.sakana.ai/');
  for (const c of stale) {
    if (c.name === 'sakana-chat') await ctx.clearCookies({ name: c.name, domain: c.domain }).catch(() => {});
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
async function freshLogin(page, ctx = context, generation = operationGeneration, signal = null) {
  const activeSignal = operationSignal(generation, signal);
  assertOperationActive(generation, activeSignal);
  await clearIdentity(page, ctx, generation, activeSignal);
  await gotoOrThrow(page, HOME_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await passCfShield(page, ctx, generation, activeSignal);
  const before = (await ctx.cookies('https://chat.sakana.ai/').catch(() => []))
    .filter((c) => c.name === 'sakana-chat').map((c) => c.value)[0] || '';

  const mail = await createTempMail(activeSignal);
  log('fresh mailbox created: ' + mail.address);
  await emailLogin(page, mail, ctx, generation, activeSignal);

  const after = (await ctx.cookies('https://chat.sakana.ai/').catch(() => []))
    .filter((c) => c.name === 'sakana-chat').map((c) => c.value)[0] || '';
  if (!after) throw new Error('no sakana-chat cookie after login');
  if (before && before === after) throw new Error('session cookie unchanged after fresh login — re-attached to previous account');
  return mail;
}

async function harvestFreshIsolated(options = {}) {
  const activeSignal = operationSignal(operationGeneration, options.signal);
  const generation = operationGeneration;
  const harvestId = crypto.randomUUID();
  const controller = new AbortController();
  const combinedSignal = AbortSignal.any([activeSignal, controller.signal]);
  isolatedHarvests.set(harvestId, { controller, browser: null, context: null });
  try {
    for (let attempt = 0; ; attempt++) {
      assertOperationActive(generation, combinedSignal);
      let browser = null;
      let isolatedContext = null;
      try {
        ({ browser, context: isolatedContext } = await createIsolatedHarvestContext(generation, combinedSignal, isolatedHarvests.get(harvestId)));
        const slot = isolatedHarvests.get(harvestId);
        if (slot) { slot.browser = browser; slot.context = isolatedContext; }
        const page = await isolatedContext.newPage();
        return await harvestSession({
          fresh: true,
          generation,
          signal: combinedSignal,
          ctx: isolatedContext,
          page,
          persist: false,
        });
      } catch (err) {
        if (stopping || generation !== operationGeneration || combinedSignal.aborted) throw stoppedError();
        if (!isBrowserCrashError(err) || attempt >= CRASH_RETRIES) throw err;
        browserState.recoveries++;
        browserState.lastError = safeBrowserError(err);
        browserState.lastErrorAt = Date.now();
        browserState.lastRecoveryAt = Date.now();
        await interruptibleWait(Math.min(CRASH_BACKOFF_MS * (2 ** attempt), 30000), combinedSignal, generation);
      } finally {
        const slot = isolatedHarvests.get(harvestId);
        await closeIsolatedSlot(slot);
      }
    }
  } finally {
    isolatedHarvests.delete(harvestId);
  }
}

async function harvestSession({ fresh = false, generation = operationGeneration, signal = null, ctx: providedContext = null, page: providedPage = null, persist = true } = {}) {
  const activeSignal = operationSignal(generation, signal);
  assertOperationActive(generation, activeSignal);
  const ctx = providedContext || await ensureBrowser(generation, activeSignal);
  assertOperationActive(generation, activeSignal);
  const page = providedPage || ctx.pages()[0] || await ctx.newPage();

  assertOperationActive(generation, activeSignal);
  log(`harvesting (fresh=${fresh})…`);
  await gotoOrThrow(page, HOME_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await passCfShield(page, ctx, generation, activeSignal);

  if (fresh) {
    // New identity + new mailbox on every fresh harvest. Retry the whole
    // login flow once — upstream sign-in is flaky under load.
    try {
      await freshLogin(page, ctx, generation, activeSignal);
    } catch (e) {
      if (isBrowserCrashError(e)) throw e;
      log('fresh login attempt 1 failed (%s) — retrying once', safeBrowserError(e));
      await interruptibleWait(3000, activeSignal, generation);
      await freshLogin(page, ctx, generation, activeSignal);
    }
  } else if (!(await isLoggedIn(page, ctx, generation, activeSignal))) {
    // Fresh profile (no login) -> full email login; saved mailbox reused when present.
    let mail = {};
    try { mail = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'tempmail.json'), 'utf8')); } catch {}
    assertOperationActive(generation, activeSignal);
    if (!mail.token || !mail.address) {
      mail = await createTempMail(activeSignal);
      assertOperationActive(generation, activeSignal);
      atomicWriteJson(path.join(__dirname, '..', 'tempmail.json'), mail);
      log('temp mailbox created: ' + mail.address);
    }
    assertOperationActive(generation, activeSignal);
    await emailLogin(page, mail, ctx, generation, activeSignal);
  } else {
    log('already logged in (profile session), skipping login');
  }

  assertOperationActive(generation, activeSignal);
  if (!(await isLoggedIn(page, ctx, generation, activeSignal))) {
    throw new Error('login failed — not logged in after harvest');
  }

  assertOperationActive(generation, activeSignal);
  const cookies = await ctx.cookies('https://chat.sakana.ai/');
  assertOperationActive(generation, activeSignal);
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
  assertOperationActive(generation, activeSignal);
  if (persist) atomicWriteJson(SESSION_FILE, session);
  log(`session saved: loggedIn=true cookies=${cookies.length} uid=${session.uid || '-'} email=${session.email || '-'}`);
  return session;
}

/**
 * Refresh an existing account's cookies in-place: load its saved cookies into
 * the browser, navigate (renews cf_clearance), read back. Returns the updated
 * session, or null when the login is gone (caller should replace the account).
 */
async function refreshAccount(acct, generation = operationGeneration, signal = null) {
  const activeSignal = operationSignal(generation, signal);
  assertOperationActive(generation, activeSignal);
  if (!acct || !acct.cookies || !acct.cookies.length) return null;

  // Each pool account gets a disposable browser context. A shared persistent
  // profile carries one Firebase IndexedDB identity, so reusing it for another
  // account can make a valid cookie look foreign and churn the pool.
  const refreshId = crypto.randomUUID();
  const controller = new AbortController();
  const refreshSignal = AbortSignal.any([activeSignal, controller.signal]);
  const slot = { controller, browser: null, context: null };
  isolatedHarvests.set(refreshId, slot);
  try {
    const { browser, context: ctx } = await createIsolatedHarvestContext(generation, refreshSignal, slot);
    const page = await ctx.newPage();
    assertOperationActive(generation, refreshSignal);
    await ctx.clearCookies().catch(() => {});
    try {
      await ctx.addCookies(acct.cookies.filter((c) => c.domain && c.name));
    } catch (e) {
      log('addCookies failed:', safeBrowserError(e));
      return null;
    }
    log(`refreshing account ${(acct.email || acct.id || '').slice(0, 24)}…`);
    assertOperationActive(generation, refreshSignal);
    await gotoOrThrow(page, HOME_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await passCfShield(page, ctx, generation, refreshSignal);
    await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(async () => {
      await interruptibleWait(2000, refreshSignal, generation);
    });
    assertOperationActive(generation, refreshSignal);
    const cookies = await ctx.cookies('https://chat.sakana.ai/');
    if (!cookies.some((cookie) => cookie.name === 'sakana-chat')) return null;
    assertOperationActive(generation, refreshSignal);
    const freshCookies = await ctx.cookies('https://chat.sakana.ai/');
    const tokens = await readFirebaseTokens(page);
    if (!freshCookies.length) return null;
    const fresh = {
      savedAt: Date.now(),
      loggedIn: true,
      cookieHeader: freshCookies.map((c) => `${c.name}=${c.value}`).join('; '),
      cookies: freshCookies.map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path })),
      uid: tokens.uid || acct.uid || '',
      email: tokens.email || acct.email || '',
      isAnonymous: !!tokens.isAnonymous,
      idToken: tokens.idToken || acct.idToken || '',
      refreshToken: tokens.refreshToken || acct.refreshToken || '',
    };
    if (sessionCookie(acct) && sessionCookie(fresh) && sessionCookie(acct) !== sessionCookie(fresh)) {
      log('refresh identity mismatch; refusing foreign session for account', (acct.id || '').slice(0, 12));
      return null;
    }
    if (acct.uid && fresh.uid && acct.uid !== fresh.uid) return null;
    if (acct.email && fresh.email && acct.email !== fresh.email) return null;
    return fresh;
  } finally {
    const slot = isolatedHarvests.get(refreshId);
    await closeIsolatedSlot(slot);
    isolatedHarvests.delete(refreshId);
  }
}

async function refreshSession(generation = operationGeneration, signal = null) {
  const activeSignal = operationSignal(generation, signal);
  assertOperationActive(generation, activeSignal);
  return withBrowserRecovery(async () => {
    assertOperationActive(generation, activeSignal);
    const ctx = context;
    if (!ctx) return harvestSession({ generation, signal: activeSignal });
    try {
      const page = ctx.pages()[0] || await ctx.newPage();
      assertOperationActive(generation, activeSignal);
      log('refreshing session (reload)…');
      await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
      // Wait for the SPA to settle (network idle or a short bound) instead of
      // a blind 8s sleep; login state decides the next step either way.
      await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(async () => {
        await interruptibleWait(2000, activeSignal, generation);
      });
      assertOperationActive(generation, activeSignal);
      if (!(await isLoggedIn(page, ctx, generation, activeSignal))) {
        log('login lost during refresh — re-logging in');
        return harvestSession({ generation, signal: activeSignal });
      }
      const cookies = await ctx.cookies('https://chat.sakana.ai/');
      assertOperationActive(generation, activeSignal);
      const session = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
      session.savedAt = Date.now();
      session.cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
      session.cookies = cookies.map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path }));
      assertOperationActive(generation, activeSignal);
      atomicWriteJson(SESSION_FILE, session);
      log('session refreshed: ' + cookies.length + ' cookies');
      return session;
    } catch (e) {
      if (isBrowserCrashError(e)) throw e;
      assertOperationActive(generation, activeSignal);
      log('refresh failed (%s) — re-harvesting', safeBrowserError(e));
      return harvestSession({ generation, signal: activeSignal });
    }
  }, generation, activeSignal);
}

/* ---------- lifecycle ---------- */

async function start({ managedByPool = false } = {}) {
  if (stopPromise) await stopPromise;
  operationController = new AbortController();
  operationGeneration += 1;
  const generation = operationGeneration;
  stopping = false;
  if (timer) { clearInterval(timer); timer = null; }
  const session = await withLock((lockedGeneration) => withBrowserRecovery(
    () => harvestSession({ generation: lockedGeneration }),
    lockedGeneration,
  ));
  assertOperationActive(generation);
  if (!managedByPool && generation === operationGeneration && !stopping) {
    timer = setInterval(() => {
      withLock((lockedGeneration) => refreshSession(lockedGeneration)).catch(() => {});
    }, REFRESH_MS);
    timer.unref?.();
  }
  return session;
}

async function stop() {
  if (stopPromise) return stopPromise;
  stopping = true;
  operationController.abort(stoppedError());
  operationGeneration += 1;
  if (timer) { clearInterval(timer); timer = null; }
  const pendingQueue = queue;
  const pendingBrowserStart = browserStart;
  // Detach new work immediately. The old chain is still drained best-effort,
  // but a later start must never enqueue behind an operation that ignored stop.
  queue = Promise.resolve();
  if (browserStart === pendingBrowserStart) browserStart = null;
  let currentStopPromise;
  currentStopPromise = (async () => {
    const deadline = Date.now() + STOP_DRAIN_MS;
    const remaining = () => Math.max(0, deadline - Date.now());
    const drain = (promise) => {
      const ms = remaining();
      return ms > 0 ? withTimeout(promise, ms).catch(() => {}) : Promise.resolve();
    };
    try {
      const pending = [pendingQueue, pendingBrowserStart].filter(Boolean).map((p) => Promise.resolve(p).catch(() => {}));
      if (pending.length) await drain(Promise.all(pending));
    } catch {}
    await drain(discardBrowser('stop', false));
    const isolated = [...isolatedHarvests.values()];
    for (const slot of isolated) slot.controller.abort(stoppedError());
    await Promise.allSettled(isolated.map((slot) => closeIsolatedSlot(slot, remaining())));
  })().finally(() => {
    if (stopPromise === currentStopPromise) stopPromise = null;
  });
  stopPromise = currentStopPromise;
  return currentStopPromise;
}

async function getSession() {
  if (fs.existsSync(SESSION_FILE)) {
    const s = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    if (Date.now() - (s.savedAt || 0) > REFRESH_MS && !stopping) {
      autoSessionRefreshLocked().catch(() => {});
    }
    return s;
  }
  throw new Error('no session yet — auto-session still harvesting');
}

function autoSessionRefreshLocked() {
  return withLock((generation) => refreshSession(generation));
}

module.exports = {
  autoSession: {
    start, stop, getSession, harvestSession, refreshSession, status: browserStatus,
    // Serialized fresh-account harvest (browser context is shared — one at a
    // time). This is the ONLY entry point the pool/keeper should use.
    harvestFresh: (options = {}) => {
      if (HARVEST_CONCURRENCY > 1 && options.isolated !== false) return harvestFreshIsolated(options);
      return withLock((generation) => withBrowserRecovery(
        () => harvestSession({ fresh: true, generation, signal: options.signal }), generation, options.signal,
      ));
    },
    harvestFreshIsolated,
    harvestSessionLocked: (options = {}) => withLock((generation) => withBrowserRecovery(
      () => harvestSession({ generation, signal: options.signal }), generation, options.signal,
    )),
    refreshSessionLocked: () => autoSessionRefreshLocked(),
    refreshAccount: (acct, options = {}) => withLock((generation) => withIsolatedBrowserRecovery(
      () => refreshAccount(acct, generation, options.signal), generation, options.signal,
    )),
    _queue: () => withLock(async () => true),
    __testing: {
      ensureBrowser,
      status: browserStatus,
      setLauncher(fn) { launchContext = fn || ((opts) => chromium.launchPersistentContext(PROFILE_DIR, opts)); },
      setIsolatedLauncher(fn) { launchIsolatedBrowser = fn || ((opts) => chromium.launch(opts)); },
      setWait(fn) { wait = fn || sleep; },
      withBrowserRecovery,
      reset() {
        const oldContext = context;
        const oldBrowserStart = browserStart;
        const oldQueue = queue;
        if (timer) { clearInterval(timer); timer = null; }
        stopping = true;
        operationController.abort(stoppedError());
        operationGeneration += 1;
        operationController = new AbortController();
        stopping = false;
        context = null;
        browserStart = null;
        browserStartGeneration = 0;
        launchIsolatedBrowser = (opts) => chromium.launch(opts);
        queue = Promise.resolve();
        void Promise.allSettled([
          oldQueue,
          oldBrowserStart,
          oldContext ? withTimeout(oldContext.close(), STOP_DRAIN_MS).catch(() => {}) : null,
        ].filter(Boolean));
        browserState.launches = 0;
        browserState.recoveries = 0;
        browserState.lastError = '';
        browserState.lastErrorAt = 0;
        browserState.lastRecoveryAt = 0;
      },
    },
  },
};
