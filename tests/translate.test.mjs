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
    enable_thinking: true,
    web_search_options: { },
    messages: [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: '你好' },
    ],
  });
  check('toneMode=polite->jp-vibes', r.toneMode === 'jp-vibes', r.toneMode);
  check('enableThinking=true', r.enableThinking === true);
  check('webSearchEnabled=true', r.webSearchEnabled === true);
  check('prompt="你好"', r.prompt === '你好', r.prompt);
  check('model=sakana-namazu', r.sakanaModel === 'sakana-namazu', r.sakanaModel);
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
  check('files.length=1', r.files.length === 1, JSON.stringify(r.files));
  check('file name image-1.png', r.files[0].name === 'image-1.png', r.files[0].name);
  check('file mime image/png', r.files[0].mime === 'image/png', r.files[0].mime);
  check('file type=base64', r.files[0].type === 'base64');
}

console.log('== 3. NDJSON -> OpenAI SSE chunks (thinking + stream + tool + final) ==');
{
  const t = new NdjsonTranslator();
  const chunks = [];
  const lines = [
    { type: 'reasoning', token: '用户问了一个加法问题。' },
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
  // tokens are consecutive slices of the final text (NUL-padded on the wire);
  // output must equal the final text exactly once
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

process.exit(failures ? 1 : 0);