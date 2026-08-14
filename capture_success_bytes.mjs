import fs from 'fs';
import { findPageTarget, CdpSession } from './lib/cdp.js';
const target = await findPageTarget();
const sess = await CdpSession.connect(target.webSocketDebuggerUrl);
const r = await sess.evaluate(`(async () => {
  const out = {};
  const boot = await fetch('/api/conversation', {
    method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'include',
    body: JSON.stringify({ inputs: '字节级测试', enableThinking: false, toneMode: 'default', webSearchEnabled: false, model: 'sakana-namazu' })
  }).then(r => r.json());
  out.systemMessageId = boot.systemMessageId;
  out.conversationId = boot.conversationId;
  const fd = new FormData();
  fd.append('data', JSON.stringify({ inputs: '字节级测试', id: boot.systemMessageId, is_retry: false, is_continue: false, enableThinking: false, toneMode: 'default', webSearchEnabled: false, userMessageId: crypto.randomUUID(), model: 'sakana-namazu' }));
  // read raw body via Response
  const raw = await new Response(fd).arrayBuffer();
  out.bodyB64 = btoa(String.fromCharCode(...new Uint8Array(raw)));
  const resp = await fetch('/api/conversation/' + boot.conversationId, { method: 'POST', body: fd, credentials: 'include' });
  out.status = resp.status;
  const text = await resp.text();
  out.bodyHead = text.slice(0, 200);
  out.bodyLen = text.length;
  return out;
})()`);
console.log('status:', r.status);
fs.writeFileSync('success_sample.json', JSON.stringify(r));
console.log('bodyB64 len:', r.bodyB64.length, 'bodyHead:', (r.bodyHead || '').slice(0, 120));
sess.close();
