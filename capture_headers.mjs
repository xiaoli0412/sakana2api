import { findPageTarget, CdpSession } from './lib/cdp.js';
const target = await findPageTarget();
const sess = await CdpSession.connect(target.webSocketDebuggerUrl);

// ensure home
await sess.send('Page.navigate', { url: 'https://chat.sakana.ai/' });
await new Promise(r => setTimeout(r, 6000));

// Network capture of request headers + bodies (enable Network + Fetch to see body? headers enough)
const reqs = [];
sess.on('Network.requestWillBeSent', (p) => {
  if (p.request.url.includes('/api/conversation') && p.request.method === 'POST') {
    reqs.push({ url: p.request.url, headers: p.request.headers, hasFormData: /multipart/.test(p.request.headers['content-type'] || '') });
  }
});
sess.on('Network.requestWillBeSentExtraInfo', (p) => {
  const rec = reqs.find(r => r.extra === undefined && r.parsedUrl(undefined) === undefined); // noop
});
await sess.send('Network.enable');

// send real UI message with search on + thinking on
const d = await sess.evaluate(`(async () => {
  const input = document.querySelector('textarea');
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  input.focus(); setter.call(input, '今天东京天气如何?'); 
  input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '今天东京天气如何?' }));
  await new Promise(r => setTimeout(r, 600));
  const btn = Array.from(document.querySelectorAll('button')).find(b => (b.getAttribute('aria-label') || '').toLowerCase().includes('send'));
  btn.click(); return true;
})()`);
console.log('sent:', d);
await new Promise(r => setTimeout(r, 15000));
console.log('REQUESTS:', JSON.stringify(reqs.map(r => ({ url: r.url, hasFormData: r.hasFormData, important: Object.fromEntries(Object.entries(r.headers).filter(([k]) => !['sec-ch-ua','sec-ch-ua-mobile','sec-ch-ua-platform','accept','accept-language'].includes(k))) })), null, 1));
// now read conversation list to get the new conversation id + messages
const conv = await sess.evaluate(`(async () => {
  const list = await fetch('/api/v2/conversations?p=0', { credentials: 'include', headers: { accept: 'application/json' } }).then(r => r.json());
  const data = list.json || list;
  const first = (data.conversations || [])[0];
  const detail = first ? await fetch('/api/conversation/' + first.id, { credentials: 'include', headers: { accept: 'application/json' } }).then(r => r.json()) : null;
  return { first: first ? { id: first.id, title: first.title } : null, msgs: detail ? (detail.messages || []).map(m => ({ id: m.id, from: m.from, content: (m.content || '').slice(0, 40) })) : [] };
})()`);
console.log('CONV:', JSON.stringify(conv, null, 1));
sess.close();
