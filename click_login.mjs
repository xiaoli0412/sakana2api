import { findPageTarget, CdpSession } from './lib/cdp.js';
const target = await findPageTarget();
const sess = await CdpSession.connect(target.webSocketDebuggerUrl);
// Click Log in button
const r = await sess.evaluate(`(() => {
  const btn = Array.from(document.querySelectorAll('button, a')).find(b => (b.innerText || '').trim() === 'Log in');
  if (!btn) return { error: 'no login btn' };
  btn.click();
  return { clicked: true, text: btn.innerText };
})()`);
console.log('click:', JSON.stringify(r));
await new Promise(r2 => setTimeout(r2, 2500));
const state = await sess.evaluate(`(() => {
  const btns = Array.from(document.querySelectorAll('button, a')).map(b => (b.innerText || '').trim()).filter(t => t && t.length < 40);
  const dialogs = Array.from(document.querySelectorAll('[role="dialog"], .fixed, [class*="modal"], [class*="overlay"]')).map(d => (d.innerText || '').slice(0, 200));
  return { url: location.href, btns: [...new Set(btns)].slice(-20), dialogs: dialogs.slice(0, 4) };
})()`);
console.log('state:', JSON.stringify(state, null, 1));
sess.close();
