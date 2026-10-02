// Click "Sign in again" on the failure page, redo the email flow, and capture
// ALL chat.sakana.ai + firebase network to pinpoint where sign-in dies.
import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const OUT = path.join(os.tmpdir(), 'sakana-research-v016');
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

const context = await chromium.launchPersistentContext(process.cwd() + '/.browser-profile', {
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
  if (u.includes('identitytoolkit') || u.includes('securetoken') || u.includes('/api/auth') || u.includes('/api/conversation')) {
    let b = ''; try { b = (await r.text()).slice(0, 150).replace(/\s+/g, ' '); } catch {}
    net.push(`${r.request().method()} ${r.status()} ${u.slice(0, 110)} :: ${b}`);
  }
});

try {
  await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3000);
  const stale = (await context.cookies(HOME)).filter((c) => c.name === 'sakana-chat');
  if (stale.length) {
    const clearance = (await context.cookies(HOME)).filter((c) => c.name === 'cf_clearance');
    await context.clearCookies().catch(() => {});
    if (clearance.length) await context.addCookies(clearance).catch(() => {});
    await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3000);
    console.log('stale session cleared');
  }

  for (let attempt = 1; attempt <= 3; attempt++) {
    console.log(`=== attempt ${attempt} ===`);
    await page.locator("button:has-text('Log in'), button:has-text('Sign in'), button:has-text('Sign in again')").first().click({ timeout: 30000 });
    const emailBox = page.getByRole('textbox', { name: 'Email address' });
    await emailBox.waitFor({ state: 'visible', timeout: 15000 });
    // any turnstile widget inside the login dialog?
    const dlgWidgets = await page.evaluate(() => document.querySelectorAll('.cf-turnstile, iframe[src*="challenges.cloudflare"]').length);
    console.log('login dialog turnstile widgets:', dlgWidgets);
    await emailBox.fill(mail.address);
    await page.getByRole('button', { name: 'Continue' }).click();
    console.log('magic link requested');
    const link = await pollMagicLink(mail.token);
    await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(6000);
    const state = await page.evaluate(() => document.body.innerText.slice(0, 200));
    console.log('landed:', page.url().replace(HOME, '').slice(0, 50), '| page text:', state.replace(/\n/g, ' | ').slice(0, 120));
    if (!state.includes('Sign in failed')) {
      const probe = await page.evaluate(async () => {
        try { const r = await fetch('/api/v2/user/settings', { credentials: 'include' }); return r.status; } catch { return -1; }
      }).catch(() => -1);
      console.log('VALIDITY probe:', probe, probe === 200 ? 'VALID ✓' : 'INVALID');
      if (probe === 200) break;
    }
  }
} finally {
  console.log('--- firebase/auth network ---');
  for (const l of net) console.log(l);
  await page.screenshot({ path: path.join(OUT, 'signin-again.png'), fullPage: true }).catch(() => {});
  await context.close().catch(() => {});
}
