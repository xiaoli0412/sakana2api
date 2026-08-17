// Same-conversation multi-attachment + parallel-upload stress.
// The user-reported flakiness pattern: several uploads in ONE conversation,
// and uploads racing with other requests. Probes both against live.
// Usage: node scripts/upload_conv_stress.mjs <base> <key>
const BASE = process.argv[2] || process.env.BASE_URL || 'http://127.0.0.1:8799';
const key = process.argv[3] || process.env.SAKANA_TEST_KEY || '';

let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) console.log('  PASS', name);
  else { fail++; console.log('  FAIL', name, JSON.stringify(extra).slice(0, 200)); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function chat(body, timeout = 150000) {
  try {
    const resp = await fetch(BASE + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(key ? { authorization: 'Bearer ' + key } : {}) },
      body: JSON.stringify(body), signal: AbortSignal.timeout(timeout),
    });
    const j = await resp.json().catch(() => ({}));
    j.status = resp.status;
    if (!resp.ok) j.error = j.error?.message || j.error || ('HTTP ' + resp.status);
    return j;
  } catch (e) {
    return { status: 0, error: String(e.name || e.message) };
  }
}

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const TXT1 = 'data:text/plain;base64,' + Buffer.from('一号文件数值: 10001').toString('base64');
const TXT2 = 'data:text/plain;base64,' + Buffer.from('二号文件数值: 20002').toString('base64');

console.log(`upload_conv_stress against ${BASE}`);

console.log('\n== A. 3 attachments in ONE message (same conversation boot) ==');
{
  const r = await chat({ model: 'sakana-namazu', stream: false, messages: [{ role: 'user', content: [
    { type: 'text', text: '分别读出:图片颜色、一号文件数值、二号文件数值。用"颜色=X 一号=Y 二号=Z"格式回答。' },
    { type: 'image_url', image_url: { url: PNG } },
    { type: 'file', name: 'one.txt', mime: 'text/plain', file_url: TXT1 },
    { type: 'file', name: 'two.txt', mime: 'text/plain', file_url: TXT2 },
  ] }] });
  const text = r.choices?.[0]?.message?.content || '';
  console.log('  answer:', JSON.stringify(text.slice(0, 160)));
  ok('A multi-attachment 200', r.status === 200, { status: r.status, error: r.error });
  ok('A all three seen', /10001/.test(text) && /20002/.test(text), text.slice(0, 160));
}

console.log('\n== B. upload turns in ONE conversation_id, 5 sequential turns ==');
{
  const first = await chat({ model: 'sakana-namazu', stream: false, messages: [{ role: 'user', content: '接下来我会发文件,每次只回复收到+文件编号。' }] });
  const convId = first.conversation_id;
  ok('B boot conversation 200', first.status === 200 && !!convId, { status: first.status, error: first.error });
  let allGood = convId ? true : false;
  for (let i = 1; i <= 5 && convId; i++) {
    const data = 'data:text/plain;base64,' + Buffer.from(`文件${i}内容: sentinel-${i}00${i}`).toString('base64');
    const r = await chat({ model: 'sakana-namazu', stream: false, conversation_id: convId, messages: [{ role: 'user', content: [
      { type: 'text', text: `读取文件编号。` },
      { type: 'file', name: `f${i}.txt`, mime: 'text/plain', file_url: data },
    ] }] });
    const text = r.choices?.[0]?.message?.content || '';
    console.log(`  turn${i}: status=${r.status} "${text.slice(0, 60)}"`);
    if (r.status !== 200) allGood = false;
    await sleep(4000);
  }
  ok('B all 5 same-conversation upload turns 200', allGood);
}

console.log('\n== C. 6 PARALLEL uploads (different conversations) ==');
{
  const jobs = [1, 2, 3, 4, 5, 6].map((i) => chat({ model: 'sakana-namazu', stream: false, messages: [{ role: 'user', content: [
    { type: 'text', text: '文件数值?只给数字。' },
    { type: 'file', name: `p${i}.txt`, mime: 'text/plain', file_url: 'data:text/plain;base64,' + Buffer.from(`并行文件: ${90000 + i}`).toString('base64') },
  ] }] }));
  const rs = await Promise.all(jobs);
  const codes = rs.map((r) => r.status);
  const matches = rs.map((r, i) => /9000[1-6]/.test(r.choices?.[0]?.message?.content || '')).filter(Boolean).length;
  console.log('  statuses:', JSON.stringify(codes), 'content-matches:', matches);
  ok('C all 6 parallel uploads 200', codes.every((c) => c === 200), codes);
}

console.log(fail ? `\nRESULT: ${fail} FAILURES` : '\nRESULT: all passed');
process.exit(fail ? 1 : 0);