// Local browser regression for character cards and standard-model chat.
// This test never contacts production and uses only an in-memory mock server.
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';

const root = new URL('..', import.meta.url);
const html = await readFile(new URL('public/index.html', root), 'utf8');
const avatarPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);
const models = [
  { id: 'sakana-namazu', description: 'Namazu · Standard 🐟' },
  { id: 'sakana-fugu', description: 'Fugu · Standard 🐡' },
  { id: 'sakana-namazu-rp2', description: 'legacy roleplay model' },
];
const card = { id: 'card-local', name: '小红', description: '本地测试角色卡' };
let activeCard = null;
let cardUploaded = false;
let chatRequests = 0;

const server = createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  const json = (status, value, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(value));
  };
  if (url.pathname === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return;
  }
  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }
  if (url.pathname === '/v1/models') {
    json(200, { object: 'list', data: models });
    return;
  }
  if (url.pathname === '/health') {
    json(200, { ok: true });
    return;
  }
  if (url.pathname === '/api/stats') {
    json(200, { accounts: {}, requests: {}, tokens: {}, cache: {}, timeSeries: { h24: [] }, byModel: {}, ops: {} });
    return;
  }
  if (url.pathname === '/api/accounts') {
    json(200, { accounts: [], total: 0, active: 0, target: 0, max: 0 });
    return;
  }
  if (url.pathname === '/api/keys') {
    json(200, { keys: [], open: true });
    return;
  }
  if (url.pathname === '/api/audit') {
    json(200, { entries: [] });
    return;
  }
  if (url.pathname === '/api/characters' && req.method === 'GET') {
    json(200, { characters: cardUploaded ? [card] : [], active: activeCard });
    return;
  }
  if (url.pathname === '/api/characters/upload' && req.method === 'POST') {
    req.resume();
    req.once('end', () => {
      cardUploaded = true;
      json(200, { ok: true, ...card });
    });
    return;
  }
  if (url.pathname === `/api/characters/${card.id}/avatar`) {
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': avatarPng.length });
    res.end(avatarPng);
    return;
  }
  if (url.pathname === `/api/characters/${card.id}/activate` && req.method === 'POST') {
    activeCard = { id: card.id, name: card.name };
    json(200, { ok: true, ...activeCard });
    return;
  }
  if (url.pathname === '/api/characters/deactivate' && req.method === 'POST') {
    activeCard = null;
    json(200, { ok: true });
    return;
  }
  if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.once('end', () => {
      chatRequests++;
      const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (request.model.includes('rp') || request.model.includes('roleplay')) {
        json(400, { error: { message: 'roleplay models are disabled', code: 'RP-MODEL-DISABLED' } });
        return;
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        'x-conversation-id': 'local-character-conversation',
      });
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: '甜品店测试回复' }, finish_reason: null }] }) + '\n\n');
      res.end('data: [DONE]\n\n');
    });
    return;
  }
  json(404, { error: { message: 'not found' } });
});

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', error => errors.push(`pageerror: ${error.message}`));
page.on('console', message => { if (message.type() === 'error') errors.push(`console: ${message.text()}`); });
page.on('response', response => {
  if (response.status() >= 400) errors.push(`http ${response.status()}: ${response.url()}`);
});

try {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#chatModelSelect option', { state: 'attached' });
  const options = await page.locator('#chatModelSelect option').evaluateAll(nodes => nodes.map(node => node.value));
  if (options.length !== 2 || options.some(value => /rp|roleplay/i.test(value))) {
    throw new Error(`standard model list failed: ${JSON.stringify(options)}`);
  }

  await page.click('[data-tab="chat"]');
  await page.waitForSelector('#characterCardList', { state: 'visible' });
  await page.setInputFiles('#cardFileInput', {
    name: 'local-card.png',
    mimeType: 'image/png',
    buffer: avatarPng,
  });
  await page.waitForFunction(() => document.querySelector('#characterCardList')?.textContent.includes('小红'), null, { timeout: 10_000 });
  const avatarLoaded = await page.waitForFunction(() => {
    const image = document.querySelector('#characterCardList img');
    return image && image.complete && image.naturalWidth > 0;
  }, null, { timeout: 10_000 }).then(() => true).catch(() => false);
  if (!avatarLoaded) throw new Error('local character avatar did not load');

  await page.locator('#characterCardList .preset-card').first().click();
  await page.waitForFunction(() => !document.getElementById('activeCardBar').hidden, null, { timeout: 10_000 });
  if (!(await page.locator('#activeCardName').textContent()).includes('小红')) throw new Error('character card activation failed');

  await page.selectOption('#chatModelSelect', 'sakana-fugu');
  await page.fill('#chatInput', '我们点什么甜品好呢?');
  await page.click('#btnSendChat');
  await page.waitForFunction(() => document.querySelector('#chatMessages')?.textContent.includes('甜品店测试回复'), null, { timeout: 10_000 });
  if (chatRequests !== 1) throw new Error(`expected one standard chat request, got ${chatRequests}`);

  await page.click('#btnClearActiveCard');
  await page.waitForFunction(() => document.getElementById('activeCardBar').hidden, null, { timeout: 10_000 });
  if (errors.length) throw new Error(errors.join('\n'));
  console.log('local browser checks passed:', JSON.stringify({ options, avatarLoaded, chatRequests }));
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
