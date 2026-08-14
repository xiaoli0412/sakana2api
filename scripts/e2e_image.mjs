import fs from 'fs';
const BASE = 'http://127.0.0.1:8787';
const b64 = fs.readFileSync('red64.png').toString('base64');
const body = {
  model: 'sakana-namazu',
  stream: false,
  messages: [{ role: 'user', content: [
    { type: 'text', text: '这张图片是什么颜色?回答一个颜色词' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,' + b64 } },
  ] }],
};
const resp = await fetch(BASE + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
console.log('status:', resp.status);
const j = await resp.json();
console.log('content:', JSON.stringify(j.choices?.[0]?.message?.content));
if (j.error) console.log('err:', JSON.stringify(j.error));
