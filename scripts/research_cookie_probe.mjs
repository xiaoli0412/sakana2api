// Minimal probe: does a planted sakana-chat cookie survive, and is it valid?
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
const authNet = [];
page.on('response', async (r) => {
  if (r.url().includes('/api/auth') || r.url().includes('rate-limit')) {
    let b = ''; try { b = (await r.text()).slice(0, 120).replace(/\s+/g, ' '); } catch {}
    authNet.push(`${r.request().method()} ${r.status()} ${r.url().slice(HOME.length)} :: ${b}`);
  }
});

async function cookieState(label) {
  const c = (await context.cookies(HOME)).find((x) => x.name === 'sakana-chat');
  console.log(`${label}: sakana-chat ${c ? 'PRESENT (len ' + c.value.length + ')' : 'ABSENT'}`);
  return !!c;
}

try {
  await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(5000);
  let has = await cookieState('t+5s');
  if (has) {
    const probe = await page.evaluate(async () => {
      try {
        const r = await fetch('/api/v2/user/settings', { credentials: 'include' });
        return { status: r.status, body: (await r.text()).slice(0, 300) };
      } catch (e) { return { error: String(e) }; }
    });
    console.log('user/settings probe:', JSON.stringify(probe).slice(0, 400));
    for (const waitSec of [15, 30, 60]) {
      await page.waitForTimeout(waitSec * 1000);
      has = await cookieState(`t+${waitSec}s later`);
      if (!has) { console.log('COOKIE WAS REVOKED by the app'); break; }
    }
  }
  console.log('--- auth network ---');
  for (const l of authNet) console.log(l);
  const btn = await page.evaluate(() => [...document.querySelectorAll('button')].map((b) => b.textContent.trim()).filter(Boolean).slice(0, 10));
  console.log('buttons:', JSON.stringify(btn));
} finally {
  await context.close().catch(() => {});
}
