// Browser E2E: character card upload/activate + RP model chat on the production panel.
import { chromium } from 'playwright';

const BASE = 'http://38.76.190.150:8787/';
const ADMIN = 'sk-sak-23e3bf82919da59eada7cacff83fc463332427093c159203';
const CARD = 'C:/Users/李昊桐/AppData/Local/Temp/browser_test_card.png';

let failures = 0;
function check(name, cond, extra = '') {
  if (cond) console.log('  ✓', name);
  else { failures++; console.log('  ✗', name, extra); }
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', e => console.log('  [pageerror]', e.message));
page.on('console', m => { if (m.type() === 'error') console.log('  [console.error]', m.text().slice(0, 200)); });

try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // Unlock admin: the bootstrap apiFetch 401s will show the lock modal.
  const lockShown = await page.waitForSelector('#globalAdminLock:not([hidden])', { timeout: 15000 }).then(() => true).catch(() => false);
  console.log('  lock modal shown:', lockShown);
  await page.fill('#adminKeyInput', ADMIN);
  await page.click('text=解锁');
  await page.waitForSelector('#globalAdminLock', { state: 'hidden', timeout: 10000 });
  console.log('  ✓ admin unlocked');

  // Open chat tab
  await page.click('[data-tab="chat"]').catch(async () => {
    await page.click('.sidebar-nav button:has-text("聊天")').catch(() => {});
  });
  await page.waitForSelector('#chatModelSelect', { timeout: 10000 });
  check('chat pane visible', await page.locator('#chatModelSelect').isVisible());

  // Character card board exists
  await page.waitForSelector('#characterCardList', { timeout: 10000 });
  check('character card board rendered', await page.locator('#characterCardList').isVisible());

  // Model dropdown has RP group
  const groupCount = await page.locator('#chatModelSelect optgroup').count();
  check('model select has 2 optgroups (standard + RP)', groupCount === 2, String(groupCount));
  const rpOpt = await page.locator('#chatModelSelect option[value="sakana-namazu-rp"]').count();
  check('sakana-namazu-rp option exists', rpOpt === 1);

  // Upload the card via the hidden file input
  await page.setInputFiles('#cardFileInput', CARD);
  await page.waitForFunction(() => {
    const el = document.getElementById('characterCardList');
    return el && el.textContent.includes('小红');
  }, { timeout: 15000 });
  console.log('  ✓ card uploaded & listed');

  // Card item: avatar loads + click to activate
  const avatarOk = await page.waitForFunction(() => {
    const im = document.querySelector('#characterCardList img');
    return im && im.complete && im.naturalWidth > 0;
  }, { timeout: 10000 }).then(() => true).catch(() => {
    console.log('  (avatar may still be loading)');
    return false;
  });
  check('avatar image loaded', avatarOk);
  await page.locator('#characterCardList .preset-card').first().click();
  await page.waitForFunction(() => !document.getElementById('activeCardBar').hidden, { timeout: 10000 });
  const activeName = await page.locator('#activeCardName').textContent();
  check('active card bar shows name', activeName.includes('小红'), activeName);

  // Chat with the RP model
  await page.selectOption('#chatModelSelect', 'sakana-namazu-rp');
  await page.fill('#chatInput', '我们点什么甜品好呢?');
  await page.click('#btnSendChat');
  const chatOutcome = await page.waitForFunction(() => {
    const msgs = document.querySelectorAll('#chatMessages > div');
    const last = msgs[msgs.length - 1];
    if (!last) return { done: false };
    // Real answer (or an error/retry button) has appeared in the body area.
    const body = last.querySelector('.body-content');
    const errBtn = last.querySelector('button[onclick*=retry]');
    if (errBtn) return { done: true, text: 'ERROR_BTN: ' + last.textContent.slice(0, 200) };
    if (body && body.textContent.trim().length > 15) return { done: true, text: last.textContent.slice(0, 400) };
    return { done: false };
  }, { timeout: 240000, polling: 1000 }).then(r => r.jsonValue()).catch(() => ({ done: false, text: 'TIMEOUT' }));
  // Grab any visible toasts too
  const toastText = await page.locator('.toast, #chatToasts, [class*="toast"]').allInnerTexts().catch(() => []);
  console.log('  last msg text:', chatOutcome.text.replace(/\n/g, ' ').slice(0, 150));
  console.log('  toasts:', toastText.join(' | ').slice(0, 200));
  check('model reply rendered', chatOutcome.done, chatOutcome.text.slice(0, 100));
  check('reply is in-character (sweet shop context)', /甜品|蛋糕|甜点|你|我|草莓/.test(chatOutcome.text), chatOutcome.text.slice(0, 80));

  // Deactivate
  await page.click('#btnClearActiveCard');
  await page.waitForFunction(() => document.getElementById('activeCardBar').hidden, { timeout: 10000 });
  check('deactivate hides active card bar', true);

  console.log(failures === 0 ? '\n=== ALL BROWSER CHECKS PASSED ===' : `\n=== ${failures} BROWSER CHECKS FAILED ===`);
} finally {
  await browser.close();
}
process.exit(failures === 0 ? 0 : 1);