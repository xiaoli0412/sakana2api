// Reproduce the new Sakana login flow with full network capture to see how
// /api/auth/login + Cloudflare Turnstile now plant the session cookie.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const OUT = path.join(os.tmpdir(), 'sakana-research-v016');
const mailApi = 'https://api.mail.tm';

async function createTempMail() {
  const d = await (await fetch(mailApi + '/domains', { signal: AbortSignal.timeout(15000) })).json();
  const domain = (d['hydra:member'] || [])[0]?.domain || 'emalupe.com';
  const address = 'sak' + Date.now().toString(36) + '@' + domain;
  const password = 'Sakana2api!2026';
  const r = await fetch(mailApi + '/accounts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address, password }), signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error('mail account failed: ' + r.status);
  const t = await (await fetch(mailApi + '/token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address, password }), signal: AbortSignal.timeout(15000) })).json();
  return { address, token: t.token };
}

async function pollMagicLink(token, timeoutSec = 90) {
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    try {
      const msgs = await (await fetch(mailApi + '/messages', { headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(10000) })).json();
      for (const m of (msgs['hydra:member'] || [])) {
        const full = await (await fetch(mailApi + '/messages/' + m.id, { headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(10000) })).json();
        const html = typeof full.html === 'string' ? full.html : JSON.stringify(full.html);
        const l = html.match(/https:\/\/sakana-talk\.firebaseapp\.com\/__\/auth\/action\?[^"'<>\s]+/);
        if (l) return l[0].replace(/&amp;/g, '&');
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error('magic link timeout');
}

const mail = await createTempMail();
console.log('mailbox:', mail.address);

const browser = await chromium.launch({
  headless: false,
  executablePath: ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find((p) => fs.existsSync(p)),
  args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--window-size=1280,900', '--lang=en-US'],
});
const context = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
  locale: 'zh-CN', timezoneId: 'Asia/Shanghai', viewport: { width: 1280, height: 900 },
});
await context.addInitScript(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] });
  Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
});
const page = await context.newPage();
const net = [];
page.on('request', (r) => { if (r.url().includes('sakana')) net.push(`>> ${r.method()} ${r.url().slice(0, 120)}`); });
page.on('response', async (r) => {
  const u = r.url();
  if (u.includes('/api/auth') || u.includes('rate-limit') || u.includes('turnstile') || u.includes('/api/conversation')) {
    let body = '';
    try { body = (await r.text()).slice(0, 400); } catch {}
    net.push(`<< ${r.status()} ${u.slice(0, 120)} :: ${body.replace(/\n/g, ' ')}`);
  }
});

await page.goto('https://chat.sakana.ai/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(3000);

// The new UI may throw a blocking overlay (welcome modal / Turnstile challenge).
// Introspect it, wait for Turnstile to resolve, and dismiss before proceeding.
async function dumpOverlays(label) {
  const overlays = await page.evaluate(() =>
    [...document.querySelectorAll('.fixed.inset-0, [role=dialog]')].map((d) => ({
      cls: d.className.slice(0, 80),
      text: d.innerText.slice(0, 200),
      iframes: [...d.querySelectorAll('iframe')].map((f) => f.title || f.src.slice(0, 80)),
    })),
  );
  console.log(`overlays@${label}:`, JSON.stringify(overlays).slice(0, 600));
  return overlays;
}
for (let i = 0; i < 8; i++) {
  const ov = await dumpOverlays(`t${i}`);
  const hasBlocking = await page.evaluate(() => {
    const el = [...document.querySelectorAll('.fixed.inset-0')].find((d) => d.className.includes('bg-black'));
    return el ? getComputedStyle(el).display !== 'none' : false;
  });
  if (!hasBlocking) { console.log('no blocking overlay at t' + i); break; }
  // Turnstile auto-runs; give it time. If a dismissible button exists, try it.
  const dismissed = await page.evaluate(() => {
    for (const txt of ['閉じる', 'Close', 'OK', 'Skip', '始める', '開始', 'Start', 'Continue', '次へ', 'Got it']) {
      const b = [...document.querySelectorAll('button')].find((x) => x.innerText.trim() === txt && x.offsetParent);
      if (b) { b.click(); return txt; }
    }
    return null;
  }).catch(() => null);
  if (dismissed) console.log('dismissed via button:', dismissed);
  await page.waitForTimeout(2500);
}

const loginBtn = page.locator("button:has-text('Log in'), button:has-text('Sign in')").first();
await loginBtn.click({ timeout: 20000 }).catch(async (e) => {
  console.log('sign-in click failed, dumping overlays again');
  await dumpOverlays('click-fail');
  throw e;
});
const emailBox = page.getByRole('textbox', { name: 'Email address' });
await emailBox.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
await emailBox.fill(mail.address);
await page.getByRole('button', { name: 'Continue' }).click();
console.log('magic link requested…');
const link = await pollMagicLink(mail.token);
console.log('magic link received, navigating…');
await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(5000);
console.log('after redirect url:', page.url());

// give the SPA up to 20s to call /api/auth/login and plant the cookie
for (let i = 0; i < 10; i++) {
  const cookies = await context.cookies('https://chat.sakana.ai/');
  if (cookies.some((c) => c.name === 'sakana-chat')) { console.log(`COOKIE PLANTED at t+${i * 2}s`); break; }
  await page.waitForTimeout(2000);
}
await page.screenshot({ path: path.join(OUT, 'after-login.png'), fullPage: true });

const finalState = await page.evaluate(() => ({
  url: location.href,
  bodyText: document.body.innerText.slice(0, 800),
  dialogs: [...document.querySelectorAll('[role=dialog]')].map((d) => d.innerText.slice(0, 300)),
}));
fs.writeFileSync(path.join(OUT, 'login-net.log'), net.join('\n'));
console.log('--- auth-related network ---');
for (const line of net.filter((l) => l.includes('auth') || l.includes('turnstile') || l.includes('challenge'))) console.log(line);
console.log('--- final page state ---');
console.log(JSON.stringify(finalState, null, 1).slice(0, 1200));
await browser.close();
