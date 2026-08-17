// Upload stability stress — multiple rounds of image/file uploads against a
// live deployment to surface intermittent failures (user-reported flakiness).
// Usage: node scripts/upload_stress.mjs <base> <key> [rounds]
const BASE = process.argv[2] || process.env.BASE_URL || 'http://127.0.0.1:8799';
const key = process.argv[3] || process.env.SAKANA_TEST_KEY || '';
const ROUNDS = parseInt(process.argv[4] || '3', 10);

let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) console.log('  PASS', name);
  else { fail++; console.log('  FAIL', name, JSON.stringify(extra).slice(0, 220)); }
}

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
    return { status: 0, error: String(e.name || e.message), code: 'NET' };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1x1 png / small jpg / text / markdown data URLs
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const JPG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AH//Z';
const TXT = 'data:text/plain;base64,' + Buffer.from('关键数值: 43991,这是测试文档').toString('base64');
const MD = 'data:text/markdown;base64,' + Buffer.from('# 答案\n秘密编号 = 77331').toString('base64');
// minimal but structurally valid PDF
const pdfBytes = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\nxref\n0 4\ntrailer<</Size 4/Root 1 0 R>>\n%%EOF');
const PDF = 'data:application/pdf;base64,' + pdfBytes.toString('base64');

console.log(`upload_stress against ${BASE}, rounds=${ROUNDS}`);

for (let round = 1; round <= ROUNDS; round++) {
  console.log(`\n=== round ${round}/${ROUNDS} ===`);

  // 1. image (multimodal base64)
  {
    const r = await chat({ model: 'sakana-namazu', stream: false, messages: [{ role: 'user', content: [
      { type: 'text', text: '图片主色是什么?一个字回答。' },
      { type: 'image_url', image_url: { url: PNG } },
    ] }] });
    const text = r.choices?.[0]?.message?.content || '';
    ok(`r${round} png upload -> 200 + answer`, !r.error && text.length > 0, { status: r.status, error: r.error, text: text.slice(0, 60) });
  }
  await sleep(3000);

  // 2. jpg
  {
    const r = await chat({ model: 'sakana-namazu', stream: false, messages: [{ role: 'user', content: [
      { type: 'text', text: '图片主色是什么?一个字回答。' },
      { type: 'image_url', image_url: { url: JPG } },
    ] }] });
    const text = r.choices?.[0]?.message?.content || '';
    ok(`r${round} jpg upload -> 200 + answer`, !r.error && text.length > 0, { status: r.status, error: r.error, text: text.slice(0, 60) });
  }
  await sleep(3000);

  // 3. text file
  {
    const r = await chat({ model: 'sakana-namazu', stream: false, messages: [{ role: 'user', content: [
      { type: 'text', text: '文档里的关键数值是多少?只给数字。' },
      { type: 'file', name: 'data.txt', mime: 'text/plain', file_url: TXT },
    ] }] });
    const text = r.choices?.[0]?.message?.content || '';
    ok(`r${round} txt file -> model sees 43991`, !r.error && /43991/.test(text), { status: r.status, error: r.error, text: text.slice(0, 60) });
  }
  await sleep(3000);

  // 4. markdown
  {
    const r = await chat({ model: 'sakana-namazu', stream: false, messages: [{ role: 'user', content: [
      { type: 'text', text: '文档里的秘密编号是多少?只给数字。' },
      { type: 'file', name: 'doc.md', mime: 'text/markdown', file_url: MD },
    ] }] });
    const text = r.choices?.[0]?.message?.content || '';
    ok(`r${round} md file -> model sees 77331`, !r.error && /77331/.test(text), { status: r.status, error: r.error, text: text.slice(0, 60) });
  }
  await sleep(3000);

  // 5. pdf (sandbox upload path)
  {
    const r = await chat({ model: 'sakana-namazu', stream: false, messages: [{ role: 'user', content: [
      { type: 'text', text: '回答“PDF OK”即可。' },
      { type: 'file', name: 'doc.pdf', mime: 'application/pdf', file_url: PDF },
    ] }] });
    const text = r.choices?.[0]?.message?.content || '';
    ok(`r${round} pdf upload -> 200 + no crash`, !r.error && r.status === 200, { status: r.status, error: r.error, code: r.code, text: text.slice(0, 60) });
  }
  await sleep(3000);

  // 6. image + stream
  {
    const r = await chat({ model: 'sakana-namazu', stream: true, messages: [{ role: 'user', content: [
      { type: 'text', text: '图片主色是什么?一个字回答。' },
      { type: 'image_url', image_url: { url: PNG } },
    ] }] });
    // chat() above only json-parses; for stream we need special handling
    let text = '';
    let status = 0, err = '';
    try {
      const resp = await fetch(BASE + '/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(key ? { authorization: 'Bearer ' + key } : {}) },
        body: JSON.stringify({ model: 'sakana-namazu', stream: true, messages: [{ role: 'user', content: [
          { type: 'text', text: '图片主色是什么?一个字回答。' },
          { type: 'image_url', image_url: { url: PNG } },
        ] }] }),
        signal: AbortSignal.timeout(150000),
      });
      status = resp.status;
      if (resp.ok && resp.body) {
        const reader = resp.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          // Flush the decoder + leftover buffer on EOF: the final data:
          // line often arrives without a trailing newline, and multibyte
          // chars split across chunks are held by the decoder until flush.
          if (done) { buf += dec.decode(); break; }
          buf += dec.decode(value, { stream: true });
          const lines = buf.split('\n'); buf = lines.pop();
          for (const line of lines) {
            if (!line.startsWith('data:')) continue;
            const pl = line.slice(5).trim();
            if (!pl || pl === '[DONE]') continue;
            try { const o = JSON.parse(pl); if (o.choices?.[0]?.delta?.content) text += o.choices[0].delta.content; } catch {}
          }
        }
        if (buf.trim()) {
          const line = buf.trim();
          if (line.startsWith('data:')) {
            const pl = line.slice(5).trim();
            if (pl && pl !== '[DONE]') {
              try { const o = JSON.parse(pl); if (o.choices?.[0]?.delta?.content) text += o.choices[0].delta.content; } catch {}
            }
          }
        }
      } else { err = await resp.text().catch(() => ''); }
    } catch (e) { status = 0; err = String(e.name || e.message); }
    ok(`r${round} png stream upload -> 200 + tokens`, status === 200 && text.length > 0, { status, err: err.slice(0, 100), text: text.slice(0, 60) });
  }
  await sleep(3000);
}

console.log(fail ? `\nRESULT: ${fail} FAILURES` : '\nRESULT: all rounds passed');
process.exit(fail ? 1 : 0);