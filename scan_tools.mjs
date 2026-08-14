import { findPageTarget, CdpSession } from './lib/cdp.js';
const target = await findPageTarget();
const sess = await CdpSession.connect(target.webSocketDebuggerUrl);
const r = await sess.evaluate(`(async () => {
  const srcs = Array.from(document.querySelectorAll('script[src]')).map(s => s.src).filter(u => u.includes('/_next/'));
  const out = [];
  const kws = ['toolCall', 'tool_calls', 'toolcalls', 'functionCall', 'function_call', '"tools"', 'toolUse', 'tool_use', 'mcp', 'artifact', 'codeExecution', 'code_execution', 'searchResults', 'search_results', 'citations', 'sources'];
  for (const u of srcs) {
    try {
      const text = await (await fetch(u)).text();
      for (const kw of kws) {
        let idx = 0;
        const found = [];
        while ((idx = text.indexOf(kw, idx)) >= 0) {
          found.push(text.slice(Math.max(0, idx - 120), idx + 180));
          idx += kw.length;
          if (found.length >= 2) break;
        }
        if (found.length) out.push({ u: u.slice(u.lastIndexOf('/') + 1), kw, n: (text.match(new RegExp(kw, 'g')) || []).length, samples: found });
      }
    } catch (e) {}
  }
  return out;
})()`);
console.log(JSON.stringify(r, null, 1).slice(0, 18000));
sess.close();
