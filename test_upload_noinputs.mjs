import fs from 'fs';
import { findPageTarget, CdpSession } from './lib/cdp.js';
const target = await findPageTarget();
const sess = await CdpSession.connect(target.webSocketDebuggerUrl);
const pngB64 = fs.readFileSync('red64.png').toString('base64');
const r = await sess.evaluate(`(async () => {
  const pngB64 = ${JSON.stringify(pngB64)};
  const bin = Uint8Array.from(atob(pngB64), c => c.charCodeAt(0));
  const out = {};
  // bootstrap with NO inputs (empty)
  const boot = await fetch('/api/conversation', {
    method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'include',
    body: JSON.stringify({ inputs: undefined, enableThinking: false, toneMode: 'default', webSearchEnabled: false, model: 'sakana-namazu' })
  }).then(r => r.json());
  out.bootstrap = boot;
  // stream with files, id=systemMessageId
  const fd = new FormData();
  fd.append('data', JSON.stringify({ inputs: '这张图片什么颜色', id: boot.systemMessageId, is_retry: false, is_continue: false, enableThinking: false, toneMode: 'default', webSearchEnabled: false, userMessageId: crypto.randomUUID(), model: 'sakana-namazu' }));
  fd.append('files', new File([bin], 'base64;red64.png', { type: 'image/png' }));
  const resp = await fetch('/api/conversation/' + boot.conversationId, { method: 'POST', body: fd, credentials: 'include' });
  out.stream = { status: resp.status, head: (await resp.text()).slice(0, 200) };
  return out;
})()`);
console.log(JSON.stringify(r, null, 1));
sess.close();
