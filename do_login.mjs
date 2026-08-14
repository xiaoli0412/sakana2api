import fs from 'fs';
import { findPageTarget, CdpSession } from './lib/cdp.js';
const target = await findPageTarget();
const sess = await CdpSession.connect(target.webSocketDebuggerUrl);
const mail = JSON.parse(fs.readFileSync('tempmail.json', 'utf8'));

// Fill the email field with temp email and click Continue
const r = await sess.evaluate(`(async () => {
  const email = ${JSON.stringify(mail.address)};
  const input = Array.from(document.querySelectorAll('input[type="email"], input[name="email"], input[type="text"]')).find(i => i.type === 'email' || (i.placeholder || '').toLowerCase().includes('email'));
  if (!input) return { error: 'no email input' };
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  input.focus();
  setter.call(input, email);
  input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: email }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise(r2 => setTimeout(r2, 400));
  const btn = Array.from(document.querySelectorAll('button')).find(b => (b.innerText || '').trim() === 'Continue');
  if (!btn) return { error: 'no continue btn', inputVal: input.value };
  btn.click();
  return { ok: true, inputVal: input.value };
})()`);
console.log('fill result:', JSON.stringify(r));
await new Promise(r2 => setTimeout(r2, 4000));
const state = await sess.evaluate(`(() => {
  const dialog = Array.from(document.querySelectorAll('[role="dialog"]')).map(d => (d.innerText || '').slice(0, 400));
  return { dialog };
})()`);
console.log('dialog state:', JSON.stringify(state));
sess.close();
