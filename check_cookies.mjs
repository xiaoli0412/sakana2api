import { findPageTarget, CdpSession } from './lib/cdp.js';
const target = await findPageTarget();
const sess = await CdpSession.connect(target.webSocketDebuggerUrl);
const r = await sess.send('Network.getAllCookies');
console.log(JSON.stringify(r.cookies.map(c => ({ name: c.name, domain: c.domain, path: c.path, size: c.value.length, httpOnly: c.httpOnly, expires: c.expires === -1 ? 'session' : new Date(c.expires * 1000).toISOString() })), null, 2));
sess.close();
