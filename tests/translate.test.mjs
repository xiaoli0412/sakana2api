// Offline test: feed a realistic Sakana NDJSON stream (based on the protocol)
// into the translator and verify the OpenAI SSE chunks it produces.
import { openaiRequestToSakana, NdjsonTranslator } from '../lib/translate.js';

let failures = 0;
function check(name, cond, extra = '') {
  if (cond) console.log('  ✓', name);
  else { failures++; console.log('  ✗', name, extra); }
}

console.log('== 1. OpenAI request -> Sakana bootstrap ==');
{
  const r = openaiRequestToSakana({
    model: 'sakana-namazu:polite',
    messages: [{ role: 'user', content: '你好' }],
  });
  check('toneMode=polite->jp-vibes', r.toneMode === 'jp-vibes', r.toneMode);
  check('prompt="你好"', r.prompt === '你好', r.prompt);
  check('model=sakana-namazu', r.sakanaModel === 'sakana-namazu', r.sakanaModel);
  check('default search=true', r.webSearchEnabled === true);
}

console.log('== 1b. hyphen model matrix parsing ==');
{
  const cases = [
    ['sakana-namazu', { m: 'sakana-namazu', tone: 'default', search: true }],
    ['sakana-namazu-polite', { m: 'sakana-namazu', tone: 'jp-vibes', search: true }],
    ['sakana-namazu-search', { m: 'sakana-namazu', tone: 'default', search: true }],
    ['sakana-namazu-osaka', { m: 'sakana-namazu', tone: 'osaka', search: true }],
    ['sakana-fugu', { m: 'fugu', tone: 'default', search: true }],
    ['sakana-fugu-polite-search', { m: 'fugu', tone: 'jp-vibes', search: true }],
    ['sakana-fugu-osaka', { m: 'fugu', tone: 'osaka', search: true }],
  ];
  for (const [model, want] of cases) {
    const r = openaiRequestToSakana({ model, messages: [] });
    const got = { m: r.sakanaModel, tone: r.toneMode, search: r.webSearchEnabled };
    check(`parse ${model}`, JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got));
  }
}

console.log('== 2. multimodal image data url -> files ==');
{
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]).toString('base64');
  const r = openaiRequestToSakana({
    messages: [
      { role: 'user', content: [
        { type: 'text', text: '看这张图' },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } },
      ] },
    ],
  });
  check('prompt contains 看这张图', r.prompt.includes('看这张图'), r.prompt);
  check('has 1 file', r.files.length === 1, String(r.files.length));
  check('file name image-1.png', r.files[0].name === 'image-1.png', r.files[0].name);
  check('file mime image/png', r.files[0].mime === 'image/png', r.files[0].mime);
  check('file type=base64', r.files[0].type === 'base64', r.files[0].type);
}

console.log('== 3. NDJSON -> OpenAI SSE chunks (thinking + stream + tool + final) ==');
{
  const t = new NdjsonTranslator();
  const chunks = [];
  const lines = [
    { type: 'reasoning', token: '用户想要说' },
    { type: 'stream', token: '结果是' },
    { type: 'toolCall', toolCall: { toolCallId: 'tc-1', toolName: 'run_python', arguments: '{"code":"print(2+2)"}' } },
    { type: 'toolResult', toolResult: { toolCallId: 'tc-1', toolName: 'run_python', output: { stdout: '4' }, isError: false } },
    { type: 'finalAnswer', text: ' 4' },
  ];
  for (const l of lines) chunks.push(...t.line(JSON.stringify(l)));
  chunks.push(...t.finish());
  const sseStrings = chunks.map(c => JSON.stringify(c));
  check('reasoning delta emitted', sseStrings.some(s => s.includes('reasoning_content')), sseStrings[0] || '');
  check('stream content emitted', chunks.some(c => c.choices[0].delta.content === '结果是'));
  check('tool_call delta emitted', sseStrings.some(s => s.includes('tool_calls') && s.includes('run_python')));
  const tc = chunks.find(c => c.choices[0].delta.tool_calls);
  check('tool_call has name+arguments+id', tc && tc.choices[0].delta.tool_calls[0].function.name === 'run_python' && tc.choices[0].delta.tool_calls[0].function.arguments.includes('print(2+2)'));
  check('finalAnswer text appended', chunks.some(c => c.choices[0].delta.content === ' 4'));
  check('finish_reason stop last', chunks.at(-1).choices[0].finish_reason === 'stop');
  const fin = chunks.filter(c => c.choices[0].finish_reason === 'stop');
  check('only one finish_reason', fin.length === 1, String(fin.length));
}

console.log('== 4. web search toolResult shape (from real bundle) ==');
{
  const t = new NdjsonTranslator();
  const out = t.line(JSON.stringify({
    type: 'toolResult',
    toolResult: { toolCallId: 's-1', toolName: 'search', output: { query: 'sakana ai', formattedResults: 'x', sources: [{ title: 'Sakana AI', url: 'https://sakana.ai' }] }, isError: false },
  }));
  check('search toolResult consumed w/o crash', Array.isArray(out));
}

console.log('== 5. multi-token accumulation dedup (regression) ==');
{
  const t = new NdjsonTranslator();
  const lines = [
    { type: 'stream', token: 'BANANA B\0\0\0\0\0\0\0\0' },
    { type: 'stream', token: 'ANANA BANANA\0\0\0\0' },
    { type: 'finalAnswer', text: 'BANANA BANANA BANANA\0\0\0\0\0\0\0' },
  ];
  let out = '';
  for (const l of lines) {
    for (const c of t.line(JSON.stringify(l))) {
      const d = c.choices[0].delta;
      if (d.content) out += d.content;
    }
  }
  check('multi-token stream emits final text exactly once', out === 'BANANA BANANA BANANA', JSON.stringify(out));
}

console.log('== 6. tool-role message round-trip (external framework) ==');
{
  const r = openaiRequestToSakana({
    model: 'sakana-namazu',
    messages: [
      { role: 'user', content: '北京天气?' },
      { role: 'assistant', content: '我查一下' },
      { role: 'tool', name: 'get_weather', tool_call_id: 'call_1', content: '{"weather":"晴"}' },
    ],
  });
  check('tool turn detected', r.isToolTurn === true);
  check('tool turn isContinue', r.isContinue === true);
  check('tool result embedded in prompt', /晴/.test(r.prompt) && /get_weather/.test(r.prompt), r.prompt.slice(0, 120));
  check('original user text kept', /北京天气/.test(r.prompt), r.prompt.slice(0, 120));
}

console.log('== 7. multiple request shapes ==');
{
  const a = openaiRequestToSakana({ model: 'sakana-namazu', input: 'hello via input' });
  check('body.input string → prompt', a.prompt === 'hello via input', a.prompt);
  const b = openaiRequestToSakana({ model: 'sakana-namazu', input: [{ role: 'user', content: 'via array' }] });
  check('body.input array → prompt', b.prompt === 'via array', b.prompt);
  const c = openaiRequestToSakana({ model: 'sakana-namazu', prompt: 'legacy prompt here' });
  check('legacy body.prompt → prompt', c.prompt === 'legacy prompt here', c.prompt);
  const d = openaiRequestToSakana({ model: 'sakana-namazu', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'responses style' }] }] });
  check('responses-style input_text → prompt', d.prompt === 'responses style', d.prompt);
}

console.log('== 8. tool-hint injection gated by TOOL_PROMPT env ==');
{
  const body = { model: 'sakana-namazu', tools: [{ type: 'function', function: { name: 'get_weather', description: '天气' } }], messages: [{ role: 'user', content: 'x' }] };
  const withHint = openaiRequestToSakana(body);
  check('tool hint injected by default', /可用工具/.test(withHint.prompt), withHint.prompt.slice(0, 100));
  const prev = process.env.TOOL_PROMPT;
  process.env.TOOL_PROMPT = '0';
  const without = openaiRequestToSakana(body);
  check('tool hint off when TOOL_PROMPT=0', !/可用工具/.test(without.prompt));
  if (prev === undefined) delete process.env.TOOL_PROMPT; else process.env.TOOL_PROMPT = prev;
}

console.log('== 9. finalAnswer incremental delta on repeated events ==');
{
  const t = new NdjsonTranslator();
  let out = '';
  const events = [
    { type: 'stream', token: 'HELLO\0\0' },
    { type: 'finalAnswer', text: 'HELLO WORLD\0' },
    { type: 'finalAnswer', text: 'HELLO WORLD AGAIN\0' },
  ];
  for (const e of events) {
    for (const c of t.line(JSON.stringify(e))) {
      const d = c.choices[0].delta;
      if (d.content) out += d.content;
    }
  }
  check('finalAnswer deltas accumulate to full text', out === 'HELLO WORLD AGAIN', JSON.stringify(out));
  check('no chunk after final complete (dedup)', t.line(JSON.stringify({ type: 'finalAnswer', text: 'HELLO WORLD AGAIN' })).length === 0);
}

process.exit(failures ? 1 : 0);