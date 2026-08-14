import { findPageTarget, CdpSession } from './lib/cdp.js';
const target = await findPageTarget();
const sess = await CdpSession.connect(target.webSocketDebuggerUrl);
const r = await sess.evaluate(`(async () => {
  const scripts = Array.from(document.querySelectorAll('script[src]')).map(s => s.src);
  // Also check performance entries / modulepreload for chunks
  const chunks = performance.getEntriesByType('resource').map(e => e.name).filter(n => n.includes('.js'));
  return { scripts, chunks: [...new Set(chunks)].slice(0, 60) };
})()`);
console.log(JSON.stringify(r, null, 2));
sess.close();
