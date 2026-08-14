import { findPageTarget, CdpSession } from './lib/cdp.js';
const target = await findPageTarget();
console.log('target:', target ? target.url : 'NONE');
if (!target) process.exit(1);
const sess = await CdpSession.connect(target.webSocketDebuggerUrl);
const info = await sess.evaluate(`(() => {
  const out = { url: location.href, title: document.title };
  const b = document.body ? document.body.innerText.slice(0, 200) : '';
  out.bodyText = b;
  out.readyState = document.readyState;
  out.cf = /cloudflare|attention required|just a moment|verify|checking your browser/i.test(document.body ? document.body.innerHTML : '');
  out.turnstileLoaded = !!document.querySelector('script[src*="challenges.cloudflare"]');
  return out;
})()`);
console.log(JSON.stringify(info, null, 2));
sess.close();
