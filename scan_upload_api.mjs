import { findPageTarget, CdpSession } from './lib/cdp.js';
const target = await findPageTarget();
const sess = await CdpSession.connect(target.webSocketDebuggerUrl);
const r = await sess.evaluate(`(async () => {
  const srcs = Array.from(document.querySelectorAll('script[src]')).map(s => s.src).filter(u => u.includes('/_next/'));
  const found = [];
  for (const u of srcs) {
    try {
      const text = await (await fetch(u)).text();
      for (const kw of ['/api/files', '/api/upload', 'presigned', 'uploadURL', 'upload_url', 'fileRef', 'file_ref', 'attachment', 'attachments', 'multipart', 'new File([', 'upload_file']) {
        let idx = 0;
        while ((idx = text.indexOf(kw, idx)) >= 0) {
          if (kw === '/api/upload') found.push({ u: u.slice(u.lastIndexOf('/') + 1), kw, ctx: text.slice(Math.max(0, idx - 120), idx + 200) });
          idx += kw.length;
          if (found.length > 12) break;
        }
      }
    } catch (e) {}
  }
  return found.slice(0, 12);
})()`);
console.log(JSON.stringify(r, null, 1));
sess.close();
