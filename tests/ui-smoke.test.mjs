// Deterministic local UI smoke for the v0.15 refresh. It never contacts the
// production host or an upstream model; all browser API calls are mocked.
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';

const root = new URL('..', import.meta.url);
const html = await readFile(new URL('public/index.html', root), 'utf8');
const models = [
  { id: 'sakana', description: 'Sakana · 标准对话 · 深度思考' },
  { id: 'sakana-mini', description: 'Sakana Mini · 轻量快速 · 深度思考' },
  { id: 'sakana-code', description: 'Sakana Code · 编程 · 长思维链 · 工具强化 · 先搜后想' },
  { id: 'sakana-code-mini', description: 'Sakana Code Mini · 编程轻量 · 工具强化 · 先搜后想' },
  { id: 'sakana-writer', description: 'Sakana Writer · 超长文本写作 · 上下文压缩管线' },
  { id: 'sakana-writer-mini', description: 'Sakana Writer Mini · 写作轻量 · 上下文压缩管线' },
  { id: 'sakana-translate', description: 'Sakana Translate · 大批量翻译 · 格式保真 · 术语一致' },
  { id: 'sakana-polite', description: 'Sakana Polite · 敬语风格 · 深度思考' },
  { id: 'sakana-osaka', description: 'Sakana Osaka · Osaka 风格 · 深度思考' },
  { id: 'sakana-namazu-rp2', description: 'legacy roleplay model' },
];
const audit = [{ id: 'smoke-1', ts: Date.now(), method: 'POST', path: '/v1/chat/completions', model: 'sakana', status: 200, duration: 42, error: null }];
const requestBodies = [];
let chatRequests = 0;

const server = createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  const body = (status, value, headers = {}) => {
    const text = JSON.stringify(value);
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(text);
  };
  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  } else if (url.pathname === '/v1/models') body(200, { object: 'list', data: models });
  else if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      requestBodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      chatRequests++;
      if (chatRequests === 1) {
        body(500, { error: { message: 'intentional attachment retry failure' } });
        return;
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        'x-conversation-id': 'smoke-conversation',
      });
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: chatRequests === 2 ? 'retry ok' : 'new turn ok' }, finish_reason: null }] }) + '\n\n');
      res.end('data: [DONE]\n\n');
    });
  } else if (url.pathname.startsWith('/v1/conversations/') && url.pathname.endsWith('/stop')) body(200, { ok: true });
  else if (url.pathname === '/health') body(200, { ok: true });
  else if (url.pathname === '/api/stats') body(200, { accounts: {}, requests: {}, tokens: {}, cache: {}, timeSeries: { h24: [] }, byModel: {}, ops: {} });
  else if (url.pathname === '/api/characters') body(200, { characters: [], active: null });
  else if (url.pathname === '/api/accounts') body(200, { accounts: [], total: 0, active: 0, target: 0, max: 0 });
  else if (url.pathname === '/api/keys') body(200, { keys: [], open: true });
  else if (url.pathname === '/api/audit') body(200, { entries: audit });
  else body(404, { error: { message: 'not found' } });
});

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const browser = await chromium.launch({ headless: true });
const errors = [];
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
page.on('pageerror', error => errors.push(`pageerror: ${error.message}`));
page.on('console', message => {
  if (message.type() !== 'error') return;
  if (/Failed to load resource: the server responded with a status of 500/i.test(message.text())) return;
  errors.push(`console: ${message.text()}`);
});

try {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#chatModelSelect option', { state: 'attached' });

  const initial = await page.evaluate(() => ({
    noRemoteFonts: [...document.querySelectorAll('link')].every(link => !/fonts\.googleapis|fonts\.gstatic/.test(link.href)),
    panes: document.querySelectorAll('[data-pane]').length,
    tabs: document.querySelectorAll('[data-tab]').length,
    options: document.querySelectorAll('#chatModelSelect option').length,
    hasRpOption: [...document.querySelectorAll('#chatModelSelect option')].some(option => /rp|roleplay/i.test(option.value)),
    togglesRemoved: !document.getElementById('btnToggleSearch') && !document.getElementById('btnToggleThink'),
    badgeRemoved: !document.getElementById('chatModelBadge'),
    styleSelect: !!document.getElementById('chatStyleSelect'),
  }));
  if (!initial.noRemoteFonts || initial.panes < 8 || initial.tabs < 8 || initial.options !== 9 || initial.hasRpOption) throw new Error(`unexpected initial UI: ${JSON.stringify(initial)}`);
  if (!initial.togglesRemoved || !initial.badgeRemoved || !initial.styleSelect) throw new Error(`composer cleanup failed: ${JSON.stringify(initial)}`);

  await page.click('#btnOpenSidebar');
  if (!(await page.locator('#mainSidebar').evaluate(el => el.classList.contains('drawer-open')))) throw new Error('mobile drawer did not open');
  // The backdrop center is covered by the sidebar itself; users tap the
  // exposed area to the right of the 280px drawer.
  await page.click('#sidebarBackdrop', { position: { x: 340, y: 400 } });
  if (await page.locator('#sidebarBackdrop').isVisible()) throw new Error('drawer backdrop did not close');

  await page.click('#btnOpenSidebar');
  await page.click('[data-tab="settings"]');
  await page.click('#btnThemeLight');
  const theme = await page.evaluate(() => ({ className: document.body.className, stored: localStorage.getItem('sakana_theme') }));
  if (!theme.className.includes('theme-light') || theme.stored !== 'light') throw new Error(`theme persistence failed: ${JSON.stringify(theme)}`);

  // Tab pane survives a reload via the URL hash.
  await page.click('#btnOpenSidebar');
  await page.click('[data-tab="chat"]');
  const hash = await page.evaluate(() => location.hash);
  if (hash !== '#chat') throw new Error(`tab hash not synced: ${hash}`);

  // Chat drawer on narrow screens keeps the sidebar reachable.
  await page.click('#btnOpenChatDrawer');
  if (!(await page.locator('#chatSidebar').evaluate(el => el.classList.contains('chat-drawer-open')))) throw new Error('chat drawer did not open');

  // Custom presets persist in localStorage with an 8-item cap. The save
  // button lives inside the chat sidebar drawer.
  await page.fill('#chatInput', '帮我写一个爬虫');
  await page.click('#btnSavePreset');
  await page.click('#btnSavePreset');
  const customPresets = await page.evaluate(() => JSON.parse(localStorage.getItem('sakana_custom_presets') || '[]'));
  if (customPresets.length !== 2) throw new Error(`custom presets not saved: ${customPresets.length}`);
  await page.click('#chatDrawerBackdrop', { position: { x: 340, y: 400 } });
  if (await page.locator('#chatSidebar').evaluate(el => el.classList.contains('chat-drawer-open'))) throw new Error('chat drawer did not close');

  // Attachment retry lifecycle: fail → one-shot retry buffer → later turns clean.
  await page.setInputFiles('#fileUploadInput', {
    name: 'chapter.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('chapter attachment: ' + 'novel '.repeat(20)),
  });
  await page.waitForSelector('#attachmentsPreview', { state: 'visible' });
  await page.fill('#chatInput', '继续写这一章');
  await page.click('#btnSendChat');
  await page.waitForSelector('button[onclick*="retryLastChatMessage"]', { timeout: 10_000 });

  const afterFailure = await page.evaluate(() => {
    const stored = localStorage.getItem('sakana_chat_sessions') || '';
    return {
      storedHasDataUrl: stored.includes('data:'),
      domHasDataUrl: [...document.querySelectorAll('#chatMessages img')].some(img => img.src.startsWith('data:')),
      attachmentPreviewVisible: !document.getElementById('attachmentsPreview').hidden,
    };
  });
  if (afterFailure.storedHasDataUrl || afterFailure.domHasDataUrl || afterFailure.attachmentPreviewVisible) throw new Error(`attachment retained after failure: ${JSON.stringify(afterFailure)}`);
  if (!requestBodies[0]?.messages?.some(message => JSON.stringify(message).includes('chapter.txt'))) throw new Error('first outbound request omitted attachment metadata');
  if (!JSON.stringify(requestBodies[0]).includes('data:text/plain;base64,')) throw new Error('first outbound request omitted Data URL');

  await page.click('button[onclick*="retryLastChatMessage"]');
  await page.waitForFunction(() => document.querySelector('#chatMessages')?.textContent.includes('retry ok'), null, { timeout: 10_000 });
  if (chatRequests !== 2 || !JSON.stringify(requestBodies[1]).includes('data:text/plain;base64,')) throw new Error('retry request did not carry its one-shot attachment');

  // Retry and new turns route style through the body, not removed toggles.
  if (requestBodies[1].web_search !== undefined || requestBodies[1].enable_thinking !== undefined) throw new Error('client still sends routing toggles');

  await page.fill('#chatInput', '开始下一回');
  await page.selectOption('#chatStyleSelect', 'osaka');
  await page.click('#btnSendChat');
  await page.waitForFunction(() => document.querySelector('#chatMessages')?.textContent.includes('new turn ok'), null, { timeout: 10_000 });
  if (requestBodies[2].style !== 'osaka') throw new Error(`style parameter missing: ${JSON.stringify(requestBodies[2]).slice(0, 120)}`);
  const thirdPayload = JSON.stringify(requestBodies[2]);
  if (chatRequests !== 3 || thirdPayload.includes('data:text/plain;base64,') || thirdPayload.includes('chapter attachment')) throw new Error('later turn resent released attachment');

  await page.click('#btnOpenSidebar');
  await page.click('[data-tab="models"]');
  if (await page.locator('#modelMatrixGrid .model-card').count() !== 9) throw new Error('model matrix does not show the 9 standard models');

  const chat = await page.evaluate(() => {
    const sessions = Array.from({ length: 25 }, (_, i) => ({ id: `s${i}`, title: `session ${i}`, messages: Array.from({ length: 20 }, () => ({ role: 'user', content: 'x'.repeat(5000), files: [{ name: 'x.png', type: 'image/png', dataUrl: 'data:image/png;base64,' + 'A'.repeat(2000) }] })) }));
    localStorage.setItem('sakana_chat_sessions', JSON.stringify(sessions));
    return { storedBeforeReload: localStorage.getItem('sakana_chat_sessions').length };
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#chatModelSelect option', { state: 'attached' });
  const bounded = await page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem('sakana_chat_sessions') || '[]');
    return { sessions: saved.length, messages: saved.reduce((n, s) => n + s.messages.length, 0), bytes: localStorage.getItem('sakana_chat_sessions').length, dataUrls: JSON.stringify(saved).includes('data:image') };
  });
  if (bounded.sessions > 20 || bounded.messages > 400 || bounded.bytes > 2 * 1024 * 1024 || bounded.dataUrls) throw new Error(`chat bounds failed: ${JSON.stringify(bounded)}`);
  if (!chat.storedBeforeReload) throw new Error('chat fixture was not written');

  await page.click('#btnOpenSidebar');
  await page.click('[data-tab="audit"]');
  await page.waitForSelector('#auditRows button');
  await page.click('#auditRows button');
  const auditText = await page.locator('#modalAuditReq').textContent();
  if (!auditText.includes('method') || auditText.includes('reqBody') || auditText.includes('resBody')) throw new Error(`audit detail is not metadata-only: ${auditText}`);

  if (errors.length) throw new Error(errors.join('\n'));
  console.log('UI smoke passed:', JSON.stringify({ initial, theme, afterFailure, chatRequests, customPresets: customPresets.length, bounded }));
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
