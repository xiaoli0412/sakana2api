// Persistent-profile login with the Turnstile gate primitive.
// `passTurnstileGate` waits out / clicks through the interactive CF challenge
// that now blocks session bootstrap. This is the automation primitive v0.16's
// auto-session will port.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const OUT = path.join(os.tmpdir(), 'sakana-research-v016');
const PROFILE = path.join(process.cwd(), '.browser-profile');
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

const GATE = '.fixed.inset-0.bg-black\\/60';
const gateOpen = (page) => page.evaluate(() => !document.querySelector('.fixed.inset-0.bg-black\\/60'));

/** Wait out / click through the interactive Turnstile challenge overlay. */
async function passTurnstileGate(page, { timeoutMs = 120000 } = {}) {
  const t0 = Date.now();
  let clicks = 0;
  while (Date.now() - t0 < timeoutMs) {
    if (await gateOpen(page).catch(() => false)) {
      console.log(`turnstile gate open (waited ${(Date.now() - t0) / 1000}s, clicks=${clicks})`);
      return true;
    }
    const cfFrame = page.frames().find((f) => f.url().includes('challenges.cloudflare.com'));
    if (cfFrame) {
      try {
        const target = cfFrame.locator('input[type="checkbox"], label.ctp-checkbox-label, .ctp-checkbox-label, [id*="checkbox"]');
        if (await target.count()) {
          await target.first().click({ timeout: 4000, force: true }).catch(() => {});
          clicks++;
          console.log(`  clicked challenge checkbox (attempt ${clicks})`);
        } else {
          const body = cfFrame.locator('body');
          if (await body.count()) {
            await body.click({ timeout: 3000, force: true }).catch(() => {});
            clicks++;
          }
        }
      } catch {}
    }
    await page.waitForTimeout(4000);
  }
  console.log('turnstile gate TIMEOUT');
  return false;
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
const authNet = [];
page.on('response', async (r) => {
  if (r.url().includes('/api/auth')) {
    let body = '';
    try { body = (await r.text()).slice(0, 200).replace(/\s+/g, ' '); } catch {}
    authNet.push(`${r.request().method()} ${r.status()} ${r.url().slice(0, 80)} :: ${body}`);
  }
});

let cookiePlanted = false;
try {
  await page.goto('https://chat.sakana.ai/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3000);
  if (!(await passTurnstileGate(page))) throw new Error('gate never opened');

  const loginBtn = page.locator("button:has-text('Log in'), button:has-text('Sign in')").first();
  await loginBtn.click({ timeout: 20000 });
  const emailBox = page.getByRole('textbox', { name: 'Email address' });
  await emailBox.waitFor({ state: 'visible', timeout: 15000 });
  await emailBox.fill(mail.address);
  await page.getByRole('button', { name: 'Continue' }).click();
  console.log('magic link requested…');
  const link = await pollMagicLink(mail.token);
  console.log('navigating magic link…');
  await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(4000);
  await passTurnstileGate(page); // the redirect-back SPA may re-gate before /api/auth/login

  for (let i = 0; i < 20; i++) {
    const cookies = await context.cookies('https://chat.sakana.ai/');
    cookiePlanted = cookies.some((c) => c.name === 'sakana-chat');
    if (cookiePlanted) { console.log(`COOKIE PLANTED at t+${i * 2}s`); break; }
    await page.waitForTimeout(2000);
  }
} finally {
  await page.screenshot({ path: path.join(OUT, 'login-with-gate.png'), fullPage: true }).catch(() => {});
  console.log('--- /api/auth calls ---');
  for (const l of authNet) console.log(l);
  console.log('cookie planted:', cookiePlanted);
  await context.close().catch(() => {});
}
