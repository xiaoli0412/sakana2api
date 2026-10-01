import { chat, pngDataUrl, requireBenchmarkEnv, summarize } from './bench-common.mjs';

requireBenchmarkEnv();
const scenarios = [
  {
    id: 'text-search-thinking',
    body: { model: 'sakana-code', stream: true, web_search: true, enable_thinking: true, messages: [{ role: 'user', content: '请搜索东京当前时间并给出来源，简短回答。' }] },
  },
  {
    id: 'image-search-thinking',
    body: { model: 'sakana-code', stream: true, web_search: true, enable_thinking: true, messages: [{ role: 'user', content: [{ type: 'text', text: '先描述图片，再搜索相关公开信息，给出来源。' }, { type: 'image_url', image_url: { url: pngDataUrl() } }] }] },
  },
  {
    id: 'file-search-thinking',
    body: { model: 'sakana-writer', stream: true, web_search: true, enable_thinking: true, context_format: 'txt', messages: [{ role: 'user', content: [{ type: 'text', text: '读取附件中的关键词，再搜索背景资料并引用来源。' }, { type: 'file', name: 'fixture.txt', mime: 'text/plain', file_url: `data:text/plain;base64,${Buffer.from('附件关键词: BENCH-FILE-42').toString('base64')}` }] }] },
  },
  {
    id: 'explicit-search-only',
    body: { model: 'sakana', stream: true, web_search: true, enable_thinking: false, messages: [{ role: 'user', content: '搜索一个公开事实并列出来源。' }] },
  },
  {
    id: 'thinking-only',
    body: { model: 'sakana', stream: true, web_search: false, enable_thinking: true, messages: [{ role: 'user', content: '请逐步推理 17*19-4。' }] },
  },
];

const results = [];
for (const scenario of scenarios) {
  const result = await chat(scenario.body, { timeoutMs: 240000 });
  results.push(summarize(result, { scenario: scenario.id, accepted: result.status !== 0 && result.status < 500 }));
  console.log(JSON.stringify(results.at(-1)));
}
const passed = results.filter((r) => r.accepted).length;
console.log(JSON.stringify({ benchmark: 'files-search', total: results.length, passed, failed: results.length - passed, note: 'Compare status, latency, citations and reasoning sizes; response bodies are intentionally discarded.' }));
process.exit(passed === results.length ? 0 : 1);
