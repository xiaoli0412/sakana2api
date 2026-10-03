// Capture nirnor.jp visual design: full-page screenshots (desktop light),
// plus key CSS tokens (colors, fonts, spacing) for the UI rebuild reference.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const OUT = path.join(os.tmpdir(), 'nirnor-ref');
fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  executablePath: ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find((p) => fs.existsSync(p)),
  args: ['--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto('https://nirnor.jp/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
await page.waitForTimeout(6000);
await page.screenshot({ path: path.join(OUT, 'nirnor-top.png'), timeout: 30000, animations: 'disabled' }).catch((e) => console.log('shot1 fail:', String(e).slice(0, 80)));

// scroll to see the works grid
await page.mouse.wheel(0, 1600);
await page.waitForTimeout(2500);
await page.screenshot({ path: path.join(OUT, 'nirnor-works.png'), timeout: 30000, animations: 'disabled' }).catch(() => {});
await page.mouse.wheel(0, 2400);
await page.waitForTimeout(2500);
await page.screenshot({ path: path.join(OUT, 'nirnor-mid.png'), timeout: 30000, animations: 'disabled' }).catch(() => {});

const css = await page.evaluate(async () => {
  const links = [...document.querySelectorAll('link[rel=stylesheet]')].map((l) => l.href);
  const out = [];
  for (const href of links) {
    try {
      const t = await (await fetch(href)).text();
      if (t.length < 200000) out.push({ href, text: t });
    } catch {}
  }
  return out;
});
for (const { href, text } of css) {
  const name = href.split('/').pop().split('?')[0] || 'style.css';
  fs.writeFileSync(path.join(OUT, name), text);
}
console.log('screenshots +', css.length, 'stylesheets saved to', OUT);
await browser.close();
