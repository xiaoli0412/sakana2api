import { findPageTarget, CdpSession } from './lib/cdp.js';
const target = await findPageTarget();
const sess = await CdpSession.connect(target.webSocketDebuggerUrl);

// 1) Drive the REAL UI: type message and send, capture what the app itself sends (hook logs req headers)
const drive = `(async () => {
  window.__2apiCap = [];
  const of = window.fetch;
  window.fetch = async function(...args) {
    const u = String(args[0] || '');
    let hdrs = null;
    try {
      const init = args[1] || {};
      hdrs = {};
      if (init.headers instanceof Headers) init.headers.forEach((v, k) => hdrs[k] = v);
      else if (init.headers && typeof init.headers === 'object') hdrs = Object.fromEntries(Object.entries(init.headers).map(([k, v]) => [k, String(v)]));
    } catch (e) {}
    const resp = await of.apply(this, args);
    if (u.includes('/api/')) {
      const entry = { url: u, method: (args[1] && args[1].method) || 'GET', status: resp.status, reqHeaders: hdrs, reqBody: null };
      try { const init = args[1] || {}; entry.reqBody = typeof init.body === 'string' ? init.body.slice(0, 2000) : null; } catch (e) {}
      window.__2apiCap.push(entry);
      resp.clone().text().then(t => { entry.respHead = t.slice(0, 2000); entry.respLen = t.length; }).catch(() => {});
    }
    return resp;
  };
  // find the textbox (contenteditable or textarea) and set text with native setter + real input events
  const input = document.querySelector('textarea, [contenteditable="true"], [contenteditable=""], input[type="text"]');
  if (!input) return { error: 'no input' };
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value') || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  input.focus();
  if (setter && setter.set) setter.set.call(input, '测试:2+2=?');
  input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '测试:2+2=?' }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return { inputType: input.tagName, filled: input.value };
})()`;
const driveRes = await sess.evaluate(drive);
console.log('drive UI:', JSON.stringify(driveRes));

// press Enter via CDP key event to submit
await sess.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
await sess.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });

// wait a bit for the request to fire + response
await new Promise(r => setTimeout(r, 9000));
const cap = await sess.evaluate('window.__2apiCap');
console.log('CAPTURED:', JSON.stringify(cap).slice(0, 5000));
sess.close();
