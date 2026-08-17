// Panel API contract check — run against a live server (local or remote).
// Usage: node scripts/panel_check.mjs <base_url> <admin_key>
// Verifies the management-panel endpoints return the shapes the UI depends on.
const [base, adminKey] = [process.argv[2] || 'http://127.0.0.1:8799', process.argv[3] || ''];
const ADMIN = { authorization: 'Bearer ' + adminKey };

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}  ${detail}`); }
}

async function req(path, opts = {}) {
  const r = await fetch(base + path, { ...opts, headers: { ...(opts.headers || {}) } });
  let body = null;
  try { body = await r.json(); } catch {}
  return { status: r.status, body };
}

console.log(`panel_check against ${base} (adminKey=${adminKey ? 'set' : 'EMPTY'})`);

// 1. Without auth: /api/stats and /api/accounts must 401 in keyed mode.
{
  const s = await req('/api/stats');
  check('no-auth /api/stats -> 401 in keyed mode', s.status === 401, `got ${s.status}`);
  const a = await req('/api/accounts');
  check('no-auth /api/accounts -> 401 in keyed mode', a.status === 401, `got ${a.status}`);
}

// 2. With admin key: /api/stats must carry the full ops shape the dashboard renders.
{
  const s = await req('/api/stats', { headers: ADMIN });
  check('/api/stats -> 200 with admin key', s.status === 200, `got ${s.status}`);
  const b = s.body || {};
  check('stats.accounts has total/active/limited/expired', ['total','active','limited','expired'].every(k => typeof b.accounts?.[k] === 'number'), JSON.stringify(b.accounts));
  check('stats.ops present with concurrency stats', !!b.ops && !!b.ops.concurrency && typeof b.ops.concurrency.queueLength === 'number', JSON.stringify(b.ops?.concurrency));
  check('stats.ops has mem rssMB', typeof b.ops?.mem?.rssMB === 'number');
  check('stats.ops has contextCount + uptimeSec + auditCount', typeof b.ops?.contextCount === 'number' && typeof b.ops?.uptimeSec === 'number' && typeof b.auditCount === 'number');
  check('stats.requests/tokens/cost/timeSeries present', !!b.requests && !!b.tokens && !!b.cost && !!b.timeSeries);
}

// 3. /api/accounts is ADMIN-only and must NOT leak session cookies.
{
  const a = await req('/api/accounts', { headers: ADMIN });
  check('/api/accounts -> 200 with admin key', a.status === 200, `got ${a.status}`);
  const b = a.body || {};
  check('accounts is an array', Array.isArray(b.accounts), typeof b.accounts);
  check('total/active are numbers', typeof b.total === 'number' && typeof b.active === 'number');
  const leak = JSON.stringify(b).match(/sakana-chat=|cf_clearance=|idToken|refreshToken/);
  check('accounts response contains NO session cookies/tokens', !leak, `leaked: ${leak?.[0]}`);
  if (Array.isArray(b.accounts) && b.accounts.length) {
    const acct = b.accounts[0];
    check('account has state + email/uid + inFlight counters', typeof acct.state === 'string' && ('email' in acct || 'uid' in acct) && typeof acct.inFlight === 'number', JSON.stringify(Object.keys(acct)));
  } else {
    console.log('  (pool empty — no accounts to inspect)');
  }
}

// 4. /api/audit + /api/keys respond to the admin key.
{
  const aud = await req('/api/audit', { headers: ADMIN });
  check('/api/audit -> 200 with admin key', aud.status === 200, `got ${aud.status}`);
  check('audit entries is an array', Array.isArray(aud.body?.entries));
  const keys = await req('/api/keys', { headers: ADMIN });
  check('/api/keys -> 200 with admin key', keys.status === 200, `got ${keys.status}`);
  check('keys list is an array', Array.isArray(keys.body?.keys));
}

// 5. CSV export with admin key yields text/csv.
{
  const r = await fetch(base + '/api/export-audit.csv', { headers: ADMIN });
  const text = await r.text();
  check('/api/export-audit.csv -> 200 + csv content-type', r.status === 200 && (r.headers.get('content-type') || '').includes('csv'), `status=${r.status} ct=${r.headers.get('content-type')}`);
  check('csv starts with header row', text.replace(/^\uFEFF/, '').startsWith('id,ts,time_iso'), text.slice(0, 40));
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);