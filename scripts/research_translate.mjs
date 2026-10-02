// Scrape the new /translate page: HTML, lazy chunks, and any API calls the
// page makes on load (model list, language pairs, limits).
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const OUT = path.join(os.tmpdir(), 'sakana-research-v016');
fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({
  headless: false,
  executablePath: ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find((p) => fs.existsSync(p)),
  args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--window-size=1280,900', '--lang=en-US'],
});
const context = await browser.newContext({
  locale: 'zh-CN', timezoneId: 'Asia/Shanghai', viewport: null,
});
await context.addInitScript(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
});
const page = await context.newPage();
const api = [];
page.on('request', (r) => { if (r.url().includes('/api/')) api.push(`>> ${r.method()} ${r.url().slice(0, 130)}`); });
page.on('response', async (r) => {
  if (r.url().includes('/api/')) {
    let b = ''; try { b = (await r.text()).slice(0, 250).replace(/\s+/g, ' '); } catch {}
    api.push(`<< ${r.status()} ${r.url().slice(0, 130)} :: ${b}`);
  }
});

try {
  await page.goto('https://chat.sakana.ai/translate', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(5000);
  await page.screenshot({ path: path.join(OUT, 'translate-page.png'), fullPage: true });
  fs.writeFileSync(path.join(OUT, 'translate.html'), await page.content());

  const state = await page.evaluate(() => ({
    url: location.href,
    text: document.body.innerText.slice(0, 1500),
    selects: [...document.querySelectorAll('select')].map((s) => [...s.options].map((o) => o.value || o.textContent.trim())).slice(0, 5),
    textareas: document.querySelectorAll('textarea').length,
    buttons: [...document.querySelectorAll('button')].map((b) => b.textContent.trim()).filter(Boolean).slice(0, 25),
  }));
  fs.writeFileSync(path.join(OUT, 'translate-state.json'), JSON.stringify(state, null, 1));
  console.log('URL:', state.url);
  console.log('selects:', JSON.stringify(state.selects));
  console.log('textareas:', state.textareas);
  console.log('buttons:', JSON.stringify(state.buttons));
  console.log('--- page text ---');
  console.log(state.text.slice(0, 700));
  console.log('--- api calls ---');
  for (const l of api) console.log(l.slice(0, 220));

  // lazy chunks loaded for this route
  const assets = await page.evaluate(() => performance.getEntriesByType('resource')
    .map((e) => e.name).filter((u) => u.endsWith('.js') || u.includes('.js?')));
  fs.writeFileSync(path.join(OUT, 'translate-assets.txt'), assets.join('\n'));
  console.log('js resources:', assets.length);
} finally {
  await browser.close().catch(() => {});
}
