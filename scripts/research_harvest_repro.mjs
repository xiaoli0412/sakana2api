// Replicate auto-session's fresh harvest EXACTLY (identity wipe incl.
// localStorage/IndexedDB/firebase + cf_clearance preservation) with full
// /api/auth network capture, to find what the SPA does differently when the
// cookie never gets planted.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const OUT = path.join(os.tmpdir(), 'sakana-research-v016');
const PROFILE = path.join(process.cwd(), '.browser-profile');
const HOME = 'https://chat.sakana.ai/';
const mailApi = 'https://api.mail.tm';

async function createTempMail() {
  const d = await (await fetch(mailApi + '/domains', { signal: AbortSignal.timeout(15000) })).json();
  const domain = (d['hydra:member'] || [])[0]?.domain || 'emalupe.com';
  const address = 'sak' + Date.now().toString(36) + '@' + domain;
  const password = 'Sakana2api!2026';
  await fetch(mailApi + '/accounts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address, password }), signal: AbortSignal.timeout(15000) });
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

const context = await chromium.launchPersistentContext(PROFILE, {
  headless: false,
  executablePath: ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find((p) => fs.existsSync(p)),
  args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--window-size=1280,900', '--lang=en-US'],
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
  locale: 'zh-CN', timezoneId: 'Asia/Shanghai', viewport: { width: 1280, height: 900 },
});
await context.addInitScript(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] });
  Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
});
const page = context.pages()[0] || await context.newPage();
const net = [];
page.on('response', async (r) => {
  const u = r.url();
  if (u.startsWith(HOME + 'api/') || u.includes('/api/auth')) {
    let body = '';
    try { body = (await r.text()).slice(0, 150).replace(/\s+/g, ' '); } catch {}
    net.push(`${r.request().method()} ${r.status()} ${u.slice(HOME.length)} :: ${body}`);
  }
});

const gateOpen = () => page.evaluate(() => !document.querySelector('.fixed.inset-0.bg-black\\/60')).catch(() => true);
async function gate() {
  const t0 = Date.now();
  while (Date.now() - t0 < 90000) {
    if (await gateOpen()) return true;
    const cf = page.frames().find((f) => String(f.url()).includes('challenges.cloudflare.com'));
    if (cf) await cf.locator('input[type="checkbox"], label.ctp-checkbox-label').first().click({ timeout: 3000, force: true }).catch(() => {});
    await page.waitForTimeout(3000);
  }
  return false;
}

try {
  // STEP 1: clearIdentity equivalent (cookies minus cf_clearance + storage wipe)
  await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2000);
  const before = await context.cookies(HOME);
  const clearance = before.filter((c) => c.name === 'cf_clearance');
  await context.clearCookies().catch(() => {});
  if (clearance.length) await context.addCookies(clearance).catch(() => {});
  await page.evaluate(() => {
    localStorage.clear(); sessionStorage.clear();
    try { indexedDB.deleteDatabase('firebaseLocalStorageDb'); } catch {}
  }).catch(() => {});
  await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(4000);
  console.log('after wipe, gate open:', await gateOpen(), '(gate solved:', await gate(), ')');
  net.push('--- identity wiped, now login ---');

  // STEP 2: login flow identical to emailLogin
  const loginBtn = page.locator("button:has-text('Log in'), button:has-text('Sign in')").first();
  await loginBtn.click({ timeout: 30000 });
  const emailBox = page.getByRole('textbox', { name: 'Email address' });
  await emailBox.waitFor({ state: 'visible', timeout: 15000 });
  await emailBox.fill(mail.address);
  await page.getByRole('button', { name: 'Continue' }).click();
  console.log('magic link requested');
  const link = await pollMagicLink(mail.token);
  await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(4000);
  console.log('post-redirect gate open:', await gateOpen(), 'url:', page.url().slice(0, 70));
  if (!(await gateOpen())) await gate();

  let planted = false;
  for (let i = 0; i < 20; i++) {
    const cookies = await context.cookies(HOME);
    planted = cookies.some((c) => c.name === 'sakana-chat');
    if (planted) { console.log(`COOKIE at t+${i * 2}s`); break; }
    await page.waitForTimeout(2000);
  }
  console.log('planted:', planted);
} finally {
  console.log('--- /api network ---');
  for (const l of net) console.log(l);
  await page.screenshot({ path: path.join(OUT, 'harvest-repro.png'), fullPage: true }).catch(() => {});
  await context.close().catch(() => {});
}
