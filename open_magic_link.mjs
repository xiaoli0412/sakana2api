import fs from 'fs';
import { findPageTarget, CdpSession } from './lib/cdp.js';
const target = await findPageTarget();
const sess = await CdpSession.connect(target.webSocketDebuggerUrl);
const msg = JSON.parse(fs.readFileSync('mailmsg.json', 'utf8'));
const html = typeof msg.html === 'string' ? msg.html : JSON.stringify(msg.html);
const link = html.match(/https?:\/\/[^"<>\s]+/g)[0].replace(/&amp;/g, '&');

const events = [];
sess.on('Network.requestWillBeSent', (p) => {
  if (p.request.url.includes('/api/') || p.request.url.includes('firebaseapp') || p.request.url.includes('identitytoolkit') || p.request.url.includes('securetoken')) {
    events.push({ ev: 'req', url: p.request.url.slice(0, 200), method: p.request.method, headers: p.request.headers });
  }
});
sess.on('Network.responseReceived', (p) => {
  const sc = p.response.headers['set-cookie'];
  if (p.response.url.includes('/api/') || sc) {
    events.push({ ev: 'resp', url: p.response.url.slice(0, 200), status: p.response.status, setCookie: sc ? sc.slice(0, 200) : null });
  }
});
await sess.send('Network.enable');
// navigate to the magic link (this tab, firebase will redirect with continueUrl)
console.log('opening link:', link.slice(0, 120));
await sess.send('Page.navigate', { url: link });
await new Promise(r => setTimeout(r, 15000));
console.log('events:', JSON.stringify(events, null, 1));
// check url + cookies
const url = await sess.evaluate('location.href');
console.log('URL now:', url);
const cookies = await sess.send('Network.getAllCookies');
console.log('COOKIES:');
for (const c of cookies.cookies) console.log(' ', c.name, c.domain, 'len=' + c.value.length, 'httpOnly=' + c.httpOnly, 'expires=' + (c.expires === -1 ? 'session' : new Date(c.expires * 1000).toISOString()));
sess.close();
