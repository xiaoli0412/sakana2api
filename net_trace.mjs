import { findPageTarget, CdpSession } from './lib/cdp.js';
const target = await findPageTarget();
const sess = await CdpSession.connect(target.webSocketDebuggerUrl);
const events = [];
sess.on('Network.requestWillBeSent', (p) => {
  events.push({ ev: 'req', url: p.request.url, method: p.request.method, headers: p.request.headers });
});
sess.on('Network.responseReceived', (p) => {
  events.push({ ev: 'resp', url: p.response.url, status: p.response.status, headers: p.response.headers, setCookie: p.response.headers['set-cookie'] || null });
});
sess.on('Network.requestWillBeSentExtraInfo', (p) => {
  events.push({ ev: 'extra-request', url: p.associatedCookies ? String(Object.keys(p.associatedCookies || {}).length) : '?', cookies: (p.associatedCookies || []).map(c => c.cookie.name + '=' + (c.cookie.value || '').slice(0, 20)) });
});
await sess.send('Network.enable');
await sess.send('Page.enable');
await sess.send('Page.reload', { ignoreCache: false });
await new Promise(r => setTimeout(r, 12000));
const focused = events.filter(e => !e.url.includes('datadog') && !e.url.includes('challenges.cloudflare')).map(e => {
  if (e.ev === 'extra-request') return e;
  return { ev: e.ev, url: e.url, method: e.method, status: e.status, setCookie: e.setCookie ? e.setCookie.slice(0, 150) : null };
});
console.log(JSON.stringify(focused.slice(0, 60), null, 1));
sess.close();
