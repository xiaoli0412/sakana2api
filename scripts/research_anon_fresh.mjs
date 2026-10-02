// Pristine-context anonymous chat test: no persistent profile, no Firebase
// leftovers. If the anonymous session can complete bootstrap + send a message,
// the pool can pivot to anonymous sessions (no registration at all).
import { chromium } from 'playwright';
import fs from 'node:fs';

const HOME = 'https://chat.sakana.ai/';
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
const apiNet = [];
page.on('response', async (r) => {
  const u = r.url();
  if (u.startsWith(HOME + 'api/')) {
    let b = ''; try { b = (await r.text()).slice(0, 130).replace(/\s+/g, ' '); } catch {}
    apiNet.push(`${r.request().method()} ${r.status()} ${u.slice(HOME.length).slice(0, 60)} :: ${b}`);
  }
});

try {
  await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(5000);

  // pass turnstile gate if present
  for (let i = 0; i < 20; i++) {
    const open = await page.evaluate(() => !document.querySelector('.fixed.inset-0.bg-black\\/60')).catch(() => true);
    if (open) break;
    const cf = page.frames().find((f) => String(f.url()).includes('challenges.cloudflare.com'));
    if (cf) await cf.locator('input[type="checkbox"], label.ctp-checkbox-label').first().click({ timeout: 2500, force: true }).catch(() => {});
    await page.waitForTimeout(3000);
  }
  console.log('gate open, waiting for session prep…');
  await page.waitForTimeout(6000);

  const body1 = await page.evaluate(() => document.body.innerText.slice(0, 250).replace(/\n+/g, ' | '));
  console.log('before send:', body1);

  const input = page.locator('textarea, [contenteditable=true], input[type=text]').first();
  await input.waitFor({ state: 'visible', timeout: 15000 });
  await input.fill('Hi. Reply with exactly: PONG');
  await page.waitForTimeout(800);
  await page.keyboard.press('Enter');
  console.log('message sent, waiting for reply…');

  for (let i = 0; i < 12; i++) {
    await page.waitForTimeout(4000);
    const text = await page.evaluate(() => document.body.innerText);
    if (/PONG/.test(text)) { console.log(`REPLY RECEIVED at t+${(i + 1) * 4}s: anonymous chat WORKS`); break; }
    if (/Connection failed|network connection/.test(text)) { console.log(`FAILED at t+${(i + 1) * 4}s: connection error banner`); break; }
  }
  const finalText = await page.evaluate(() => document.body.innerText.slice(0, 500).replace(/\n+/g, ' | '));
  console.log('final page:', finalText.slice(0, 300));
} finally {
  console.log('--- /api network ---');
  for (const l of apiNet.slice(-12)) console.log(l);
  await context.close().catch(() => {});
  await browser.close().catch(() => {});
}
