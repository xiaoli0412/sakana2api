// Complete email-link login inside the real Chrome window.
// Uses Firebase JS SDK injected into the page (signInWithEmailLink).
import fs from 'fs';
import path from 'path';
import { findPageTarget, CdpSession } from '../lib/cdp.js';

const mailFile = process.argv[2] || './tempmail.json';
const sessFile = process.argv[3] || './session.json';

const mail = JSON.parse(fs.readFileSync(mailFile, 'utf8'));
const target = await findPageTarget();
if (!target) { console.error('no chrome target'); process.exit(1); }
const sess = await CdpSession.connect(target.webSocketDebuggerUrl);

// 1) load the login page so firebase app is on the same origin
await sess.send('Page.navigate', { url: 'https://chat.sakana.ai/login' });
await new Promise(r => setTimeout(r, 6000));

// 2) get fresh magic link from mail.tm (fetch newest message with sign-in link)
let link = '';
const tok = await (await fetch('https://api.mail.tm/token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address: mail.address, password: mail.password }) })).json();
const msgs = await (await fetch('https://api.mail.tm/messages', { headers: { Authorization: 'Bearer ' + tok.token } })).json();
for (const m of (msgs['hydra:member'] || []).slice().reverse()) {
  const full = await (await fetch('https://api.mail.tm/messages/' + m.id, { headers: { Authorization: 'Bearer ' + tok.token } })).json();
  const html = typeof full.html === 'string' ? full.html : JSON.stringify(full.html);
  const l = html.match(/https:\/\/sakana-talk\.firebaseapp\.com\/__\/auth\/action\?[^"<>\s]+/);
  if (l) { link = l[0].replace(/&amp;/g, '&').replace(/%27$/, ''); break; }
}
if (!link) { console.error('no magic link found in inbox'); process.exit(2); }
console.log('magic link:', link.slice(0, 110) + '...');

// 3) signInWithEmailLink via injected SDK
const expr = `(async () => {
  const email = ${JSON.stringify(mail.address)};
  const link = ${JSON.stringify(link)};
  await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js');
  await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js');
  const app = firebase.initializeApp({ apiKey: 'AIzaSyBIJuyUokxGiETY0Nu3hQNC1dMadHyf_I4', authDomain: 'sakana-talk.firebaseapp.com', tenantId: 'sakana-talk-prd-pvl72' }, 'sakana2api');
  const auth = firebase.auth(app);
  try {
    const cred = await firebase.auth.signInWithEmailLink(auth, email, link);
    const user = cred.user;
    return { ok: true, uid: user.uid, email: user.email, isAnonymous: user.isAnonymous };
  } catch (e) {
    return { ok: false, error: String(e), code: e && e.code, message: e && e.message };
  }
})()`;
try {
  const r = await sess.evaluate(expr);
  console.log('signIn:', JSON.stringify(r));
} catch (e) {
  console.log('evaluate failed:', String(e).slice(0, 400));
}

// 4) wait for the app to pick up auth state, then probe API
await new Promise(r => setTimeout(r, 8000));
const probe = await sess.evaluate(`(async () => {
  const r = await fetch('/api/rate-limit/status', { headers: { accept: 'application/json' } });
  return { status: r.status, body: (await r.text()).slice(0, 200) };
})()`);
console.log('API probe after signIn:', JSON.stringify(probe));
sess.close();
