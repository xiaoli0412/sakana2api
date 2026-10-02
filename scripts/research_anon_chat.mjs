// Test 1: can the ANONYMOUS session chat? (page-scoped fetch with its cookies)
// Test 2 (separate script): old-server pool cookie validity.
import { chromium } from 'playwright';
import fs from 'node:fs';

const HOME = 'https://chat.sakana.ai/';
const context = await chromium.launchPersistentContext(process.cwd() + '/.browser-profile', {
  headless: false,
  executablePath: ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find((p) => fs.existsSync(p)),
  args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--window-size=1280,900', '--lang=en-US'],
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
  locale: 'zh-CN', timezoneId: 'Asia/Shanghai', viewport: { width: 1280, height: 900 },
});
const page = context.pages()[0] || await context.newPage();

try {
  await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(6000);

  // Use the app itself: type into the main input and click send, watch network.
  const input = page.locator('textarea, [contenteditable=true], input[type=text]').first();
  await input.waitFor({ state: 'visible', timeout: 15000 });
  await input.fill('こんにちは。あなたのモデル名を一言で教えて。');
  await page.waitForTimeout(1000);
  const send = page.locator('button[type=submit], form button').last();
  await send.click({ timeout: 10000 }).catch(() => {});

  // Watch for conversation creation result
  let conversationApi = null;
  page.on('response', async (r) => {
    if (r.url().includes('/api/conversation') && r.request().method() === 'POST') {
      let b = ''; try { b = (await r.text()).slice(0, 200).replace(/\s+/g, ' '); } catch {}
      conversationApi = `${r.status()} ${b}`;
    }
  });
  await page.waitForTimeout(20000);
  const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 600));
  console.log('--- anonymous chat attempt ---');
  console.log('POST /api/conversation →', conversationApi || '(not observed)');
  console.log('page text:', bodyText.replace(/\n+/g, ' | ').slice(0, 400));
  await page.screenshot({ path: 'D:\\DevCache\\temp\\sakana-research-v016\\anon-chat.png', fullPage: false }).catch(() => {});
} finally {
  await context.close().catch(() => {});
}
