import { chat, requireBenchmarkEnv, summarize } from './bench-common.mjs';

requireBenchmarkEnv();
const tool = { type: 'function', function: { name: 'read_fixture', description: '读取测试文件并返回内容', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } };
const jobs = [
  { id: 'inspect-and-patch', prompt: '请调用 read_fixture 读取 /tmp/fixture.txt，然后根据结果给出一个最小 JavaScript 修复方案。' },
  { id: 'tool-json', prompt: '请调用 read_fixture，参数 path 为 /tmp/config.json；工具返回后只输出 JSON 格式的修复建议。' },
  { id: 'debug-flow', prompt: '请先分析边界条件，再调用 read_fixture 读取 /tmp/error.log，最后列出三步排查计划。' },
];

const results = [];
for (const job of jobs) {
  const first = await chat({ model: 'sakana-code', stream: true, tools: [tool], messages: [{ role: 'user', content: job.prompt }] }, { timeoutMs: 240000 });
  const firstSummary = summarize(first, { job: job.id, round: 1, hasToolCall: first.toolCalls.length > 0 });
  console.log(JSON.stringify(firstSummary));
  let final = first;
  if (first.toolCalls.length > 0) {
    const call = first.toolCalls[0];
    final = await chat({
      model: 'sakana-code', stream: true,
      messages: [
        { role: 'user', content: job.prompt },
        { role: 'assistant', content: '', tool_calls: [{ id: call.id || 'bench-call', type: 'function', function: { name: call.name, arguments: call.arguments || '{}' } }] },
        { role: 'tool', tool_call_id: call.id || 'bench-call', name: call.name, content: JSON.stringify({ ok: true, fixture: 'BENCH-TOOL-42', note: 'synthetic authorized benchmark result' }) },
      ],
    }, { timeoutMs: 240000 });
  }
  const summary = summarize(final, { job: job.id, round: first.toolCalls.length > 0 ? 2 : 1, completed: final.ok && final.contentChars > 0, toolRoundTrip: first.toolCalls.length > 0 });
  results.push(summary);
  console.log(JSON.stringify(summary));
}
const passed = results.filter((r) => r.completed).length;
console.log(JSON.stringify({ benchmark: 'code', total: results.length, passed, failed: results.length - passed }));
process.exit(passed === results.length ? 0 : 1);
