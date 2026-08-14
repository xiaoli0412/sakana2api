import fs from 'fs';
import { findPageTarget, CdpSession } from './lib/cdp.js';

// Rebuild the exact FormData Node sends, dump raw bytes
const form = new FormData();
form.append('data', JSON.stringify({
  inputs: '测试', id: '019ffafe-669a-7499-8e5d-6d65edddfc0a',
  is_retry: false, is_continue: false, enableThinking: false,
  toneMode: 'default', webSearchEnabled: false,
  userMessageId: '37d6c0ec-88c5-4665-a92f-f29cee04219d', model: 'sakana-namazu'
}));
const buf = Buffer.from(await form.arrayBuffer());
console.log('NODE BODY (first 700 bytes):');
console.log(buf.slice(0, 700).toString('utf8'));
console.log('...total len:', buf.length);

// Also capture the browser's real multipart body from the page (same JSON)
const target = await findPageTarget();
const sess = await CdpSession.connect(target.webSocketDebuggerUrl);
const real = await sess.evaluate(`(async () => {
  const fd = new FormData();
  fd.append('data', JSON.stringify({
    inputs: '测试', id: '019ffafe-669a-7499-8e5d-6d65edddfc0a',
    is_retry: false, is_continue: false, enableThinking: false,
    toneMode: 'default', webSearchEnabled: false,
    userMessageId: '37d6c0ec-88c5-4665-a92f-f29cee04219d', model: 'sakana-namazu'
  }));
  const arr = new Uint8Array(await fd.arrayBuffer());
  let s = '';
  for (let i = 0; i < Math.min(arr.length, 700); i++) s += String.fromCharCode(arr[i]);
  return { head: s, len: arr.length };
})()`);
console.log('\nBROWSER BODY (first 700 bytes):');
console.log(real.head);
console.log('total len:', real.len);
sess.close();
