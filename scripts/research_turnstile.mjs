// Try to pass the interactive Cloudflare Turnstile checkbox by clicking it
// inside the challenge iframe, then verify the gate opens (modal gone,
// rate-limit/status 200, anonymous session established).
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const OUT = path.join(os.tmpdir(), 'sakana-research-v016');
const PROFILE = path.join(process.cwd(), '.browser-profile');

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
page.on('response', async (r) => {
  if (r.url().includes('/api/rate-limit') || r.url().includes('/api/auth')) {
    console.log(`NET ${r.status()} ${r.url().slice(0, 100)}`);
  }
});

try {
  await page.goto('https://chat.sakana.ai/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(4000);

  const gateOpen = await page.evaluate(() => !document.querySelector('.fixed.inset-0.bg-black\\/60'));
  console.log('gate open on load:', gateOpen);

  if (!gateOpen) {
    // Find the Turnstile widget iframe and click its checkbox.
    const t0 = Date.now();
    for (let attempt = 1; attempt <= 6 && Date.now() - t0 < 90000; attempt++) {
      const frameInfo = page.frames().map((f) => f.url().slice(0, 80)).filter((u) => u.includes('challenges.cloudflare'));
      console.log(`attempt ${attempt}: challenge frames = ${frameInfo.length}`);
      const cfFrame = page.frames().find((f) => f.url().includes('challenges.cloudflare.com'));
      if (cfFrame) {
        try {
          const cb = cfFrame.locator('input[type="checkbox"], .ctp-checkbox-label, #challenge-stage');
          const n = await cb.count();
          console.log(`  checkbox-like elements: ${n}`);
          if (n > 0) {
            await cb.first().click({ timeout: 5000, force: true }).catch(async () => {
              // the real checkbox lives in a nested iframe for interactive mode
              const lbl = cfFrame.locator('label');
              if (await lbl.count()) await lbl.first().click({ timeout: 5000, force: true });
            });
            console.log('  clicked challenge element');
          }
        } catch (e) { console.log('  click err:', String(e).slice(0, 100)); }
      }
      await page.waitForTimeout(5000);
      const open = await page.evaluate(() => !document.querySelector('.fixed.inset-0.bg-black\\/60'));
      console.log(`  gate open now: ${open}`);
      if (open) { console.log(`TURNSTILE PASSED in ${(Date.now() - t0) / 1000}s`); break; }
    }
  }

  await page.screenshot({ path: path.join(OUT, 'turnstile-after.png'), fullPage: false });

  const finalState = await page.evaluate(() => ({
    rateLimitVisible: !!document.querySelector('.fixed.inset-0'),
    bodySnippet: document.body.innerText.slice(0, 400),
    buttons: [...document.querySelectorAll('button')].map((b) => b.textContent.trim()).filter(Boolean).slice(0, 15),
  }));
  console.log(JSON.stringify(finalState, null, 1));

  // anonymous session check: rate-limit/status should be 200 once a session exists
  const status = await page.evaluate(async () => {
    try {
      const r = await fetch('/api/rate-limit/status', { credentials: 'include' });
      return { status: r.status, body: (await r.text()).slice(0, 500) };
    } catch (e) { return { error: String(e) }; }
  });
  console.log('rate-limit/status:', JSON.stringify(status).slice(0, 600));
} finally {
  await context.close().catch(() => {});
}
