import { chat, requireBenchmarkEnv, summarize } from './bench-common.mjs';

requireBenchmarkEnv();
const models = ['sakana', 'sakana-mini', 'sakana-code', 'sakana-code-mini', 'sakana-writer', 'sakana-writer-mini', 'sakana-polite', 'sakana-osaka'];
const cases = [
  { id: 'pelican-bike', prompt: '画一只鹈鹕骑自行车。请用简短文字描述画面，并给出一个可执行的 SVG 代码块。', test: (text) => /鹈鹕|pelican/i.test(text) && /svg/i.test(text) },
  { id: 'candy', prompt: '有 17 颗糖果平均分给 5 个孩子，至少需要再买几颗才能平均分完？只回答数字和一句解释。', test: (text) => /3/.test(text) },
  { id: 'strawberry-r', prompt: '单词 strawberry 中有几个字母 r？请只回答数字并解释计数过程。', test: (text) => /2/.test(text) },
  { id: 'decimal', prompt: '9.11 和 9.9 哪个更大？请比较小数位并给出结论。', test: (text) => /9\.9/.test(text) },
  { id: 'arithmetic', prompt: '计算 (37 * 19) - (144 / 12) + 5。请给出中间步骤和最终整数。', test: (text) => /696/.test(text) },
];

const results = [];
for (const model of models) {
  for (const scenario of cases) {
    const result = await chat({ model, stream: true, messages: [{ role: 'user', content: scenario.prompt }] }, { timeoutMs: 180000 });
    results.push(summarize(result, { model, scenario: scenario.id, passed: result.ok && scenario.test(result.text) }));
    console.log(JSON.stringify(results.at(-1)));
  }
}
const passed = results.filter((r) => r.passed).length;
console.log(JSON.stringify({ benchmark: 'intelligence', total: results.length, passed, failed: results.length - passed }));
process.exit(passed === results.length ? 0 : 1);
