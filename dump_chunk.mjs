import { findPageTarget, CdpSession } from './lib/cdp.js';
import fs from 'fs';
const target = await findPageTarget();
const sess = await CdpSession.connect(target.webSocketDebuggerUrl);
const r = await sess.evaluate(`(async () => {
  const u = '/_next/static/chunks/1ceo-6se51_hi.js';
  const t = await (await fetch(u)).text();
  return t;
})()`);
fs.writeFileSync('chunk-1ceo.js', r);
console.log('saved chunk-1ceo.js, size:', r.length);
sess.close();
