import { findPageTarget, CdpSession } from './lib/cdp.js';
import fs from 'fs';
const target = await findPageTarget();
const sess = await CdpSession.connect(target.webSocketDebuggerUrl);
const r = await sess.evaluate(`(async () => {
  const u = '/_next/static/chunks/2fsd6w8j9k3vk.js';
  return await (await fetch(u)).text();
})()`);
fs.writeFileSync('chunk-messages.js', r);
console.log('saved chunk-messages.js', r.length);
sess.close();
