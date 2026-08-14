import { findPageTarget, CdpSession } from './lib/cdp.js';
const target = await findPageTarget();
const sess = await CdpSession.connect(target.webSocketDebuggerUrl);
const events = [];
sess.on('Network.requestWillBeSent', (p) => {
  if (p.request.url.includes('/api/')) events.push({ ev: 'req', url: p.request.url, method: p.request.method, headers: p.request.headers });
});
sess.on('Network.responseReceived', (p) => {
  if (p.response.url.includes('/api/')) events.push({ ev: 'resp', url: p.response.url, status: p.response.status });
});
sess.on('Network.requestWillBeSentExtraInfo', (p) => {
  if (p.requestId) events.push({ ev: 'extra', url: p.associatedCookies.length + ' cookies for req' });
});
await sess.send('Network.enable');
await sess.send('Page.enable');
await sess.send('Page.reload', { ignoreCache: false });
// wait longer for firebase signup + api calls
await new Promise(r => setTimeout(r, 15000));
// Also check if page made any /api/ calls
const apiEvents = events.filter(e => e.url && e.url.includes('/api/'));
console.log('API events:', JSON.stringify(apiEvents, null, 1));
// And print ALL cookies now
const cookies = await sess.send('Network.getAllCookies');
console.log('COOKIES now:');
for (const c of cookies.cookies) console.log(' ', c.name, c.domain, c.path, 'len=' + c.value.length, 'httpOnly=' + c.httpOnly);
sess.close();
