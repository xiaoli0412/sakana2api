// Watch the post-magic-link /login page for 60s, clicking ANY Cloudflare
// Turnstile widget (overlay OR inline), and log /api/auth/login outcomes.
// Goal: prove the token path that yields a VALID (200) session.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

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
const authNet = [];
page.on('response', async (r) => {
  if (r.url().includes('/api/auth')) {
    let b = ''; try { b = (await r.text()).slice(0, 120).replace(/\s+/g, ' '); } catch {}
    authNet.push(`${r.request().method()} ${r.status()} ${r.url().slice(HOME.length)} :: ${b}`);
    console.log(`AUTH ${r.status()} ${r.url().slice(HOME.length)}`);
  }
});
// Wipe stale cookies but keep cf_clearance
await context.addCookies([`__noop=1`]).catch(() => {});
try {
  await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3000);
  const stale = (await context.cookies(HOME)).filter((c) => c.name === 'sakana-chat');
  if (stale.length) {
    await context.clearCookies().catch(() => {});
    const clearance = (await context.cookies(HOME)).filter((c) => c.name === 'cf_clearance');
    if (clearance.length) await context.addCookies(clearance).catch(() => {});
    console.log('cleared stale session cookies, kept', clearance.length, 'cf_clearance');
    await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3000);
  }

  await page.locator("button:has-text('Log in'), button:has-text('Sign in')").first().click({ timeout: 30000 });
  const emailBox = page.getByRole('textbox', { name: 'Email address' });
  await emailBox.waitFor({ state: 'visible', timeout: 15000 });
  await emailBox.fill(mail.address);
  await page.getByRole('button', { name: 'Continue' }).click();
  console.log('magic link requested');
  const link = await pollMagicLink(mail.token);
  await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 60000 });
  console.log('landed:', page.url().slice(0, 80));

  // Watch for 75s: log turnstile widget presence, click any checkbox anywhere.
  for (let i = 0; i < 25; i++) {
    const cfFrames = page.frames().filter((f) => String(f.url()).includes('challenges.cloudflare.com'));
    if (cfFrames.length && i % 2 === 0) {
      for (const cf of cfFrames) {
        await cf.locator('input[type="checkbox"], label.ctp-checkbox-label, [id*="checkbox"]').first()
          .click({ timeout: 2500, force: true }).catch(() => {});
      }
    }
    const widgets = await page.evaluate(() => {
      const boxes = [...document.querySelectorAll('[class*="turnstile"], .cf-turnstile, iframe[src*="challenges.cloudflare"]')];
      return boxes.length;
    }).catch(() => -1);
    const cookies = await context.cookies(HOME);
    const has = cookies.some((c) => c.name === 'sakana-chat');
    console.log(`t+${i * 3}s url=${page.url().replace(HOME, '').slice(0, 40) || '/'} cfFrames=${cfFrames.length} widgets=${widgets} cookie=${has}`);
    if (i === 8) await page.screenshot({ path: path.join(OUT, 'login-watch.png'), fullPage: false }).catch(() => {});
    if (has) {
      // validity check
      await page.waitForTimeout(3000);
      const probe = await page.evaluate(async () => {
        try { const r = await fetch('/api/v2/user/settings', { credentials: 'include' }); return r.status; } catch { return -1; }
      }).catch(() => -1);
      console.log('VALIDITY probe user/settings:', probe, probe === 200 ? '→ VALID SESSION ✓' : '→ INVALID');
      if (probe === 200) break;
    }
    await page.waitForTimeout(3000);
  }
} finally {
  console.log('--- /api/auth network ---');
  for (const l of authNet) console.log(l);
  await page.screenshot({ path: path.join(OUT, 'login-watch-final.png'), fullPage: true }).catch(() => {});
  await context.close().catch(() => {});
}
