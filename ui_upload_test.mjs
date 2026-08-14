import fs from 'fs';
import { findPageTarget, CdpSession } from './lib/cdp.js';
const target = await findPageTarget();
const sess = await CdpSession.connect(target.webSocketDebuggerUrl);

// 1) hook fetch to capture upload request + result
await sess.evaluate(`(() => {
  window.__capUpload = [];
  const of = window.fetch;
  window.fetch = async function(...args) {
    const u = String(args[0] || '');
    const init = args[1] || {};
    if (u.includes('/api/conversation') && init.method === 'POST') {
      const entry = { u };
      if (init.body instanceof FormData) {
        entry.fd = [];
        for (const [k, v] of init.body.entries()) entry.fd.push([k, typeof v === 'string' ? v : { name: v.name, size: v.size, type: v.type }]);
      } else entry.body = typeof init.body === 'string' ? init.body.slice(0, 300) : null;
      try { const r = await of.apply(this, args); entry.status = r.status; const t = await r.clone().text(); entry.respHead = t.slice(0, 150); window.__capUpload.push(entry); return r; } catch (e) { entry.err = String(e); window.__capUpload.push(entry); throw e; }
    }
    return of.apply(this, args);
  };
  return 'hooked';
})()`);

// 2) simulate drag-drop of red64.png onto the file dropzone
const pngB64 = fs.readFileSync('red64.png').toString('base64');
const drop = await sess.evaluate(`(async () => {
  const pngB64 = ${JSON.stringify(pngB64)};
  const bin = Uint8Array.from(atob(pngB64), c => c.charCodeAt(0));
  const file = new File([bin], 'red64.png', { type: 'image/png' });
  const dt = new DataTransfer();
  dt.items.add(file);
  const dropzone = document.querySelector('form[class*="dropzone"], form');
  if (!dropzone) return { error: 'no dropzone' };
  const evt = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt });
  dropzone.dispatchEvent(evt);
  await new Promise(r => setTimeout(r, 1500));
  const thumbs = Array.from(document.querySelectorAll('img, [class*="file"], [class*="thumb"], [class*="attach"]')).map(e => (e.alt || e.className || '').toString().slice(0, 60)).filter(Boolean).slice(0, 10);
  return { ok: true, thumbs };
})()`);
console.log('drop:', JSON.stringify(drop));
await new Promise(r => setTimeout(r, 2000));
const state = await sess.evaluate(`(() => ({
  hasFilePreview: !!document.querySelector('[class*="file"],[class*="thumb"],[class*="preview"]'),
  bodyText: document.body.innerText.slice(0, 120)
}))()`);
console.log('state:', JSON.stringify(state));
sess.close();
