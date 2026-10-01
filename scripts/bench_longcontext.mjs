import { chat, requireBenchmarkEnv, summarize } from './bench-common.mjs';

requireBenchmarkEnv();
const sizes = [30_000, 60_000, 120_000, 240_000, 480_000];
const formats = ['txt', 'json'];
const models = ['sakana-writer', 'sakana-writer-mini'];
const marker = 'NEEDLE-SAKANA-7F3C';

function makeDocument(size, needleOffset = 0.63) {
  const line = '小说上下文填充：春雨落在旧车站的铁棚上，人物沿着时间线继续前行。';
  const target = Math.max(0, Math.min(size - marker.length, Math.floor(size * needleOffset)));
  const prefix = line.repeat(Math.ceil(target / line.length)).slice(0, target);
  const suffix = line.repeat(Math.ceil((size - target - marker.length) / line.length)).slice(0, Math.max(0, size - target - marker.length));
  return `${prefix}${marker}${suffix}`;
}

const results = [];
for (const model of models) {
  for (const size of sizes) {
    for (const context_format of formats) {
      const document = makeDocument(size);
      const prompt = `请读取完整上下文，找到唯一标记并只回答标记本身：${marker}`;
      const result = await chat({
        model,
        stream: false,
        context_format,
        messages: [{ role: 'user', content: `${document}\n\n${prompt}` }],
      }, { timeoutMs: 300000, contextFormat: context_format });
      const passed = result.ok && result.text.includes(marker);
      results.push(summarize(result, { model, size, context_format, path: 'document', needleFound: passed, inputChars: document.length }));
      console.log(JSON.stringify(results.at(-1)));
    }
    const document = makeDocument(size);
    const prompt = `请读取完整上下文，找到唯一标记并只回答标记本身：${marker}`;
    const result = await chat({
      model,
      stream: false,
      context_format: 'txt',
      messages: [{ role: 'user', content: `${document}\n\n${prompt}` }],
    }, { timeoutMs: 300000, contextFormat: 'txt' });

    const passed = result.ok && result.text.includes(marker);
    results.push(summarize(result, { model, size, context_format: 'optical-candidate', path: 'threshold-candidate', needleFound: passed, inputChars: document.length }));
    console.log(JSON.stringify(results.at(-1)));
  }
}
const passed = results.filter((r) => r.needleFound).length;
console.log(JSON.stringify({ benchmark: 'longcontext', total: results.length, passed, failed: results.length - passed, note: 'optical-candidate uses normal writer routing; enable OPTICAL_CONTEXT and inspect server telemetry for rendered pages' }));
process.exit(passed === results.length ? 0 : 1);
