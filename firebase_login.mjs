import fs from 'fs';
import { findPageTarget, CdpSession } from './lib/cdp.js';
const target = await findPageTarget();
const sess = await CdpSession.connect(target.webSocketDebuggerUrl);
const mail = JSON.parse(fs.readFileSync('tempmail.json', 'utf8'));
const msg = JSON.parse(fs.readFileSync('mailmsg.json', 'utf8'));
const html = typeof msg.html === 'string' ? msg.html : JSON.stringify(msg.html);
let link = html.match(/https?:\/\/[^"<>\s]+/g)[0].replace(/&amp;/g, '&').replace(/%27$/, '');

// dynamic import firebase auth in page and signInWithEmailLink
const expr = `(async () => {
  const email = ${JSON.stringify(mail.address)};
  const link = ${JSON.stringify(link)};
  // load firebase SDKs
  await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js');
  await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js');
  const app = firebase.initializeApp({ apiKey: 'AIzaSyBIJuyUokxGiETY0Nu3hQNC1dMadHyf_I4', authDomain: 'sakana-talk.firebaseapp.com', tenantId: 'sakana-talk-prd-pvl72' }, 'sakana2api');
  const auth = firebase.auth(app);
  try {
    const cred = await firebase.auth.signInWithEmailLink(auth, email, link);
    const user = cred.user;
    const idToken = await user.getIdToken(true);
    return { ok: true, uid: user.uid, email: user.email, isAnon: user.isAnonymous, idToken: idToken.slice(0, 40) + '...', len: idToken.length };
  } catch (e) {
    return { ok: false, error: String(e), code: e.code, message: e.message };
  }
})()`;
try {
  const r = await sess.evaluate(expr);
  console.log('firebase login:', JSON.stringify(r, null, 1));
} catch (e) {
  console.log('evaluate error:', String(e).slice(0, 500));
}
sess.close();
