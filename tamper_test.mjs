import { findPageTarget, CdpSession } from './lib/cdp.js';
const target = await findPageTarget();
const sess = await CdpSession.connect(target.webSocketDebuggerUrl);

// Tamper hook: rewrite each real stream fetch's data.id / data.userMessageId and observe result
const hook = await sess.evaluate(`(() => {
  window.__tamperResults = [];
  let mode = 'id-random-new'; // 'id-random-new' | 'id-keep' | 'umid-random-new' etc (switch externally)
  const of = window.fetch;
  window.fetch = async function(...args) {
    const u = String(args[0] || '');
    const init = args[1] || {};
    if (u.includes('/api/conversation') && init.method === 'POST' && init.body instanceof FormData) {
      const dataStr = init.body.get('data');
      if (dataStr) {
        const d = JSON.parse(dataStr);
        const original = { id: d.id, userMessageId: d.userMessageId };
        const mode = window.__tamperMode || 'control';
        if (mode === 'id-random-new') d.id = crypto.randomUUID();
        if (mode === 'umid-random-new') d.userMessageId = crypto.randomUUID();
        if (mode === 'id-random-v7') { /* gen v7 */ }
        const newFd = new FormData();
        newFd.append('data', JSON.stringify(d));
        const r = await of.call(this, u, { ...init, body: newFd });
        window.__tamperResults.push({ mode, original, status: r.status });
        return r;
      }
    }
    return of.apply(this, args);
  };
  return 'hooked';
})()`);
console.log('hook:', hook);

// Test 1: control (no tamper) — baseline real UI round trip must succeed
await sess.evaluate('window.__tamperMode = "control"');
await new Promise(r => setTimeout(r, 500));
const send1 = await sendViaUI(sess, '控制组测试:1+1=?');
console.log('control send:', send1);
await new Promise(r => setTimeout(r, 16000));
console.log('control result:', JSON.stringify(await sess.evaluate('window.__tamperResults'), null, 1));

// Test 2: tamper id -> random fresh uuid
await sess.evaluate('window.__tamperResults = []; window.__tamperMode = "id-random-new"');
const send2 = await sendViaUI(sess, '篡改id组测试:2+2=?');
console.log('tamper-id send:', send2);
await new Promise(r => setTimeout(r, 16000));
console.log('tamper-id result:', JSON.stringify(await sess.evaluate('window.__tamperResults'), null, 1));

// Test 3: tamper userMessageId -> random fresh uuid
await sess.evaluate('window.__tamperResults = []; window.__tamperMode = "umid-random-new"');
const send3 = await sendViaUI(sess, '篡改umid组测试:3+3=?');
console.log('tamper-umid send:', send3);
await new Promise(r => setTimeout(r, 16000));
console.log('tamper-umid result:', JSON.stringify(await sess.evaluate('window.__tamperResults'), null, 1));
sess.close();

async function sendViaUI(s, text) {
  return s.evaluate(`(async () => {
    const input = document.querySelector('textarea');
    if (!input) return 'no-input';
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    input.focus(); setter.call(input, ${JSON.stringify(text)});
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(text)} }));
    await new Promise(r => setTimeout(r, 600));
    const btn = Array.from(document.querySelectorAll('button')).find(b => (b.getAttribute('aria-label') || '').toLowerCase().includes('send'));
    if (!btn) return 'no-btn';
    btn.click(); return 'sent';
  })()`);
}
