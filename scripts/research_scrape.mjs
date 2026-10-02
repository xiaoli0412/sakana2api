// One-off research scraper for the (possibly updated) chat.sakana.ai UI.
// Captures: rendered HTML, all same-origin JS bundles, screenshots, request
// URL log, localStorage keys. Output is a research artifact — never committed.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ROOT = process.env.SAKANA_PROFILE_DIR || path.join(process.cwd(), '.browser-profile');
const OUT = path.join(os.tmpdir(), 'sakana-research-v016');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  headless: false,
  executablePath: ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'].find((p) => fs.existsSync(p)),
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
const requests = [];
page.on('request', (r) => requests.push(`${r.method()} ${r.url()}`));
page.on('console', (m) => { if (m.type() === 'error') requests.push(`CONSOLE-ERR ${m.text().slice(0, 200)}`); });

console.log('loading chat.sakana.ai …');
const response = await page.goto('https://chat.sakana.ai/', { waitUntil: 'domcontentloaded', timeout: 60000 });
console.log('status:', response?.status());
await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
await page.waitForTimeout(6000);

await page.screenshot({ path: path.join(OUT, 'landing.png'), fullPage: true });
fs.writeFileSync(path.join(OUT, 'index.html'), await page.content());

// Same-origin bundles + manifests
const assets = await page.evaluate(() => {
  const urls = new Set();
  for (const s of document.querySelectorAll('script[src]')) urls.add(s.src);
  for (const l of document.querySelectorAll('link[href]')) {
    if (/\.(js|css|json|woff2?)$/i.test(l.href) || l.rel?.includes('manifest')) urls.add(l.href);
  }
  return [...urls];
});
console.log('assets:', assets.length);
let saved = 0;
for (const url of assets) {
  try {
    const body = await page.evaluate(async (u) => {
      const r = await fetch(u, { credentials: 'include' });
      return { ct: r.headers.get('content-type') || '', text: await r.text() };
    }, url);
    const name = url.split('/').pop().split('?')[0].slice(0, 80) || `asset-${saved}`;
    fs.writeFileSync(path.join(OUT, name), body.text);
    saved++;
  } catch (e) { console.log('asset failed:', url.slice(0, 80), String(e).slice(0, 80)); }
}
console.log('saved assets:', saved);

// SPA state hints
const state = await page.evaluate(() => ({
  title: document.title,
  localStorageKeys: Object.keys(localStorage),
  sessionStorageKeys: Object.keys(sessionStorage),
  bodySnippet: document.body.innerText.slice(0, 1500),
  buttons: [...document.querySelectorAll('button')].map((b) => b.textContent.trim()).filter(Boolean).slice(0, 40),
}));
fs.writeFileSync(path.join(OUT, 'state.json'), JSON.stringify(state, null, 2));
fs.writeFileSync(path.join(OUT, 'requests.log'), requests.join('\n'));
console.log('title:', state.title);
console.log('buttons:', JSON.stringify(state.buttons));
console.log('localStorage:', JSON.stringify(state.localStorageKeys));
console.log('OUT =', OUT);
await browser.close();
