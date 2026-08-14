import { findPageTarget, CdpSession } from './lib/cdp.js';
const target = await findPageTarget();
const sess = await CdpSession.connect(target.webSocketDebuggerUrl);

// Hook fetch to capture the ACTUAL FormData contents (data JSON + file parts)
const hook = await sess.evaluate(`(async () => {
  window.__cap3 = [];
  const of = window.fetch;
  window.fetch = async function(...args) {
    const u = String(args[0] || '');
    if (u.includes('/api/conversation') && (args[1] || {}).method === 'POST' && (args[1] || {}).body instanceof FormData) {
      const fd = args[1].body;
      const parts = [];
      for (const [k, v] of fd.entries()) {
        if (typeof v === 'string') parts.push([k, 'string', v]);
        else parts.push([k, 'blob', v.type, v.name, v.size]);
      }
      window.__cap3.push({ url: u, fdParts: parts, headers: args[1].headers ? Array.from(args[1].headers.entries()) : 'none' });
    } else if (u.includes('/api/conversation') && (args[1] || {}).method === 'POST') {
      window.__cap3.push({ url: u, jsonBody: (args[1] || {}).body, headers: args[1].headers ? Array.from(args[1].headers.entries()) : 'none' });
    }
    return of.apply(this, args);
  };
  return 'ok';
})()`);
console.log('hook:', hook);

// navigate to home and send one message through the UI
await sess.send('Page.navigate', { url: 'https://chat.sakana.ai/' });
await new Promise(r => setTimeout(r, 6000));

const d = await sess.evaluate(`(async () => {
  const input = document.querySelector('textarea');
  if (!input) return { error: 'no textarea' };
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  input.focus();
  setter.call(input, '你好,请回复一句话');
  input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '你好,请回复一句话' }));
  await new Promise(r => setTimeout(r, 500));
  const btn = Array.from(document.querySelectorAll('button')).find(b => (b.getAttribute('aria-label') || '').toLowerCase().includes('send') || (b.innerText || '').trim() === 'Send message');
  if (!btn) return { error: 'no send btn', buttons: Array.from(document.querySelectorAll('button')).map(b => (b.getAttribute('aria-label') || b.innerText || '').trim()).slice(-10) };
  btn.click();
  return { sent: true };
})()`);
console.log('send:', JSON.stringify(d));
await new Promise(r => setTimeout(r, 15000));
const cap = await sess.evaluate('window.__cap3');
console.log('CAPTURED:', JSON.stringify(cap, null, 1));
sess.close();
