// Local image/file upload E2E against http://127.0.0.1:8799.
// Builds a real tiny PNG data URL and a text file, sends via chat.completions
// multimodal parts, verifies the model sees them (and proxy doesn't crash).
const BASE = process.env.E2E_BASE || 'http://127.0.0.1:8799';
let fails = 0;
const ok = (name, cond, extra = '') => {
  if (cond) console.log('  PASS', name);
  else { fails++; console.log('  FAIL', name, extra); }
};

// 1x1 red PNG
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const dataUrl = 'data:image/png;base64,' + PNG_B64;

async function chat(body, timeout = 150000) {
  const resp = await fetch(BASE + '/v1/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(timeout),
  });
  const j = await resp.json().catch(() => ({}));
  if (!resp.ok) return { error: resp.status, ...j };
  return j;
}

console.log('== A. image upload (multimodal) ==');
{
  const r = await chat({ model: 'sakana-namazu', stream: false, messages: [{ role: 'user', content: [
    { type: 'text', text: '这张图片是什么颜色?简短回答。' },
    { type: 'image_url', image_url: { url: dataUrl } },
  ] }] });
  const text = r.choices && r.choices[0] && r.choices[0].message && r.choices[0].message.content || '';
  ok('image request returns 200', !r.error, JSON.stringify(r).slice(0, 200));
  ok('response has content', text.length > 0, text.slice(0, 120));
  console.log('  model said:', JSON.stringify(text.slice(0, 120)));
}

console.log('== B. text file upload (extracted into prompt) ==');
{
  const fileData = 'data:text/plain;base64,' + Buffer.from('机密数值: 8848 米').toString('base64');
  const r = await chat({ model: 'sakana-namazu', stream: false, messages: [{ role: 'user', content: [
    { type: 'text', text: '文件里的机密数值是多少?直接给出数字。' },
    { type: 'file', name: 'secret.txt', mime: 'text/plain', file_url: fileData },
  ] }] });
  const text = r.choices && r.choices[0] && r.choices[0].message && r.choices[0].message.content || '';
  ok('file request returns 200', !r.error, JSON.stringify(r).slice(0, 200));
  ok('file content extracted & model sees it', /8848/.test(text), text.slice(0, 160));
}

console.log('== C. markdown code file ==');
{
  const md = Buffer.from('# Numbers\nThe answer is 777.').toString('base64');
  const r = await chat({ model: 'sakana-namazu', stream: false, messages: [{ role: 'user', content: [
    { type: 'text', text: '这个文档里的答案是什么?' },
    { type: 'file', name: 'doc.md', mime: 'text/markdown', file_url: 'data:text/markdown;base64,' + md },
  ] }] });
  const text = r.choices && r.choices[0] && r.choices[0].message && r.choices[0].message.content || '';
  ok('md request 200', !r.error);
  ok('md extracted', /777/.test(text), text.slice(0, 160));
}

console.log('\n' + (fails === 0 ? 'ALL IMAGE/FILE E2E PASSED' : fails + ' FAILURES'));
process.exit(fails ? 1 : 0);