// Offline test: feed a realistic Sakana NDJSON stream (based on the protocol)
// into the translator and verify the OpenAI SSE chunks it produces.
import { openaiRequestToSakana, NdjsonTranslator, sniffMimeType, parseModel, MODELS } from '../lib/translate.js';
import { AccountPool } from '../lib/account-pool.js';
import { ConcurrencyManager } from '../lib/concurrency.js';

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
  check('default search=false (raw parse)', parseModel('sakana-namazu').webSearchEnabled === false);
  check('default mode: thinking on, search off', r.webSearchEnabled === false && r.enableThinking === true);
}

console.log('== 1b. hyphen model matrix parsing ==');
{
  const cases = [
    ['sakana-namazu', { m: 'sakana-namazu', tone: 'default', search: false, think: true, rp: false }],
    ['sakana-namazu-polite', { m: 'sakana-namazu', tone: 'jp-vibes', search: false, think: true, rp: false }],
    ['sakana-namazu-search', { m: 'sakana-namazu', tone: 'default', search: true, think: true, rp: false }],
    ['sakana-namazu-osaka', { m: 'sakana-namazu', tone: 'osaka', search: false, think: true, rp: false }],
    ['sakana-namazu-nosearch', { m: 'sakana-namazu', tone: 'default', search: false, think: true, rp: false }],
    ['sakana-fugu', { m: 'fugu', tone: 'default', search: false, think: true, rp: false }],
    ['sakana-fugu-polite-search', { m: 'fugu', tone: 'jp-vibes', search: true, think: true, rp: false }],
    ['sakana-fugu-osaka', { m: 'fugu', tone: 'osaka', search: false, think: true, rp: false }],
    ['sakana-namazu-rp', { m: 'sakana-namazu', tone: 'default', search: false, think: true, rp: true }],
  ];
  for (const [model, want] of cases) {
    const r = parseModel(model);
    const got = { m: r.sakanaModel, tone: r.toneMode, search: r.webSearchEnabled, think: r.enableThinking, rp: r.isRP };
    check(`parse ${model}`, JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got));
  }
  const rp = MODELS.find(m => m.id === 'sakana-namazu-rp');
  check('RP model listed in /v1/models', !!rp && rp.rp === true && rp.apiModel === 'sakana-namazu', rp && rp.id);
  check('total models = 16', MODELS.length === 16, String(MODELS.length));
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
  const t = new NdjsonTranslator({ declaredTools: ['run_python'] });
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
  check('finish_reason tool_calls or stop', chunks.at(-2).choices[0].finish_reason === 'tool_calls');
}

console.log('== 4. web search toolResult shape (from real bundle) ==');
{
  const t = new NdjsonTranslator();
  const out = t.line(JSON.stringify({
    type: 'toolResult',
    toolResult: { toolCallId: 's-1', toolName: 'search', output: { query: 'sakana ai', formattedResults: 'x', sources: [{ title: 'Sakana AI', url: 'https://sakana.ai' }] }, isError: false },
  }));
  check('search toolResult consumed w/o crash', Array.isArray(out));
  check('citations extracted from search toolResult', t.citations.some(c => c.url === 'https://sakana.ai'));
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
  check('tool turn is fresh input (not is_continue)', r.isContinue === false);
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
  check('tool hint injected by default', /可用自定义工具/.test(withHint.prompt), withHint.prompt.slice(0, 100));
  const prev = process.env.TOOL_PROMPT;
  process.env.TOOL_PROMPT = '0';
  const without = openaiRequestToSakana(body);
  check('tool hint off when TOOL_PROMPT=0', !/可用自定义工具/.test(without.prompt));
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

console.log('== 10. Embedded <thinking> tag parsing ==');
{
  const t = new NdjsonTranslator();
  const chunks = [];
  const lines = [
    { type: 'stream', token: '<thinking>让我仔细分析这个问题' },
    { type: 'stream', token: '，首先我们需要计算</thinking>答案是42' },
  ];
  for (const l of lines) chunks.push(...t.line(JSON.stringify(l)));
  chunks.push(...t.finish());
  
  const reasoning = chunks.map(c => c.choices[0]?.delta?.reasoning_content || '').join('');
  const content = chunks.map(c => c.choices[0]?.delta?.content || '').join('');
  check('reasoning extracted from <thinking>', reasoning.includes('让我仔细分析这个问题') && reasoning.includes('首先我们需要计算'), reasoning);
  check('content does not contain <thinking>', !content.includes('<thinking>') && !content.includes('</thinking>'), content);
  check('content contains pure answer', content.includes('答案是42'), content);
}

console.log('== 11. Citations extraction and source chips cleaning ==');
{
  const t = new NdjsonTranslator();
  const chunks = [];
  const line = { type: 'finalAnswer', text: '根据最新资料<source-chip title="Sakana AI 官网" url="https://sakana.ai"/>，模型性能优异。' };
  chunks.push(...t.line(JSON.stringify(line)));
  chunks.push(...t.finish());

  check('citations extracted from chip', t.citations.some(c => c.title === 'Sakana AI 官网' && c.url === 'https://sakana.ai'));
  const content = chunks.map(c => c.choices[0]?.delta?.content || '').join('');
  check('source-chip tag stripped from content', !content.includes('<source-chip'), content);
  check('final chunk contains citations array', chunks.at(-2).citations && chunks.at(-2).citations.length > 0);
}

console.log('== 12. Model JSON tool call auto-detection ==');
{
  const t = new NdjsonTranslator();
  const chunks = [];
  const line = { type: 'finalAnswer', text: '```json\n{"tool": "get_weather", "arguments": {"city": "Tokyo"}}\n```' };
  chunks.push(...t.line(JSON.stringify(line)));
  chunks.push(...t.finish());

  const tcChunk = chunks.find(c => c.choices[0]?.delta?.tool_calls);
  check('JSON tool call detected', !!tcChunk);
  check('JSON tool name parsed', tcChunk?.choices[0]?.delta?.tool_calls[0]?.function?.name === 'get_weather');
  check('JSON tool arguments parsed', tcChunk?.choices[0]?.delta?.tool_calls[0]?.function?.arguments.includes('Tokyo'));
  check('finish reason is tool_calls', chunks.at(-2).choices[0].finish_reason === 'tool_calls');
}

console.log('== 13. Web search explicit parameter controls ==');
{
  const disabled = openaiRequestToSakana({ model: 'sakana-namazu', web_search: false, messages: [{ role: 'user', content: 'test' }] });
  check('web_search: false disables search', disabled.webSearchEnabled === false);

  // Thinking is innate, so search only survives when the client explicitly
  // turns thinking off (same as the real web UI: it never sends both).
  const enabled = openaiRequestToSakana({ model: 'sakana-namazu', web_search: true, enable_thinking: false, messages: [{ role: 'user', content: 'test' }] });
  check('web_search: true + enable_thinking:false enables search', enabled.webSearchEnabled === true && enabled.enableThinking === false);
}

console.log('== 13b. INPUT-MODE-001 硬约束:思考与搜索互斥,搜索优先(实测上游 400) ==');
{
  // 上游在 enableThinking 与 webSearchEnabled 同时为 true 时返回 400。
  // 语义为显式模式切换:搜索请求强制关闭思考,搜索过程由代理合成进
  // reasoning_content(客户端思维链可见"正在搜索/搜索来源")。
  const both = openaiRequestToSakana({ model: 'sakana-namazu', web_search: true, enable_thinking: true, messages: [{ role: 'user', content: 'test' }] });
  check('both on -> search mode wins (thinking forced off)', both.enableThinking === false && both.webSearchEnabled === true);

  const bothViaModel = openaiRequestToSakana({ model: 'sakana-namazu-search', enable_thinking: true, messages: [{ role: 'user', content: 'test' }] });
  check('model search suffix + thinking -> search mode wins', bothViaModel.webSearchEnabled === true && bothViaModel.enableThinking === false);

  const thinkOnly = openaiRequestToSakana({ model: 'sakana-namazu', web_search: false, enable_thinking: true, messages: [{ role: 'user', content: 'test' }] });
  check('thinking alone stays on', thinkOnly.enableThinking === true && thinkOnly.webSearchEnabled === false);

  const searchOnly = openaiRequestToSakana({ model: 'sakana-namazu', web_search: true, enable_thinking: false, messages: [{ role: 'user', content: 'test' }] });
  check('search alone stays on', searchOnly.webSearchEnabled === true && searchOnly.enableThinking === false);

  const thinkModelSearchOff = openaiRequestToSakana({ model: 'sakana-namazu-think', web_search: false, messages: [{ role: 'user', content: 'test' }] });
  check('think model + explicit search off -> thinking on', thinkModelSearchOff.enableThinking === true && thinkModelSearchOff.webSearchEnabled === false);
}

console.log('== 13c. system prompt and RP injection ==');
{
  const r = openaiRequestToSakana({ model: 'sakana-namazu', messages: [
    { role: 'system', content: 'SYS-身份' },
    { role: 'user', content: '你好' },
  ] });
  check('system prompt leads the prompt', r.prompt.startsWith('SYS-身份'), r.prompt.slice(0, 40));

  const multi = openaiRequestToSakana({ model: 'sakana-namazu', messages: [
    { role: 'system', content: 'A' },
    { role: 'system', content: 'B' },
    { role: 'user', content: 'C' },
  ] });
  check('multiple system prompts keep order', multi.prompt.startsWith('A\n\nB\n\nC'), multi.prompt.slice(0, 40));

  const rp = openaiRequestToSakana({ model: 'sakana-namazu-rp', messages: [{ role: 'user', content: '嗨' }] });
  check('rp model flagged', rp.isRP === true);
}

console.log('== 14. Least-InFlight load balancing & account pool ==');
{
  const pool = new AccountPool();
  pool.accounts = [
    { id: 'acct-1', email: 'a1@test.com', cookieHeader: 'c1', state: 'active', inFlight: 0 },
    { id: 'acct-2', email: 'a2@test.com', cookieHeader: 'c2', state: 'active', inFlight: 2 },
    { id: 'acct-3', email: 'a3@test.com', cookieHeader: 'c3', state: 'rate_limited', rateLimitedAt: Date.now() - 700000 }, // expired cooldown
  ];

  const pick1 = pool.next();
  check('prefers account with inFlight=0', pick1 && pick1.id === 'acct-1', pick1?.id);

  pool.acquire('acct-1');
  check('inFlight incremented on acct-1', pool.accounts.find(a => a.id === 'acct-1').inFlight === 1);

  // acct-3 should be recovered by cooldown
  const pick2 = pool.next();
  check('recovers rate_limited account on cooldown expiry', pool.accounts.find(a => a.id === 'acct-3').state === 'active');

  pool.release('acct-1', true);
  check('inFlight decremented on release', pool.accounts.find(a => a.id === 'acct-1').inFlight === 0);
}

console.log('== 15. Anthropic Claude Multimodal & Document format ==');
{
  const jpegB64 = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46]).toString('base64');
  const pdfB64 = Buffer.from('%PDF-1.4 test').toString('base64');
  const r = openaiRequestToSakana({
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: '总结这份报告' },
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpegB64 } },
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfB64 } },
        ],
      },
    ],
  });
  check('claude image parsed', r.files.some(f => f.mime === 'image/jpeg' && f.name.endsWith('.jpeg')));
  check('claude pdf document parsed', r.files.some(f => f.mime === 'application/pdf' && f.name.endsWith('.pdf')));
}

console.log('== 16. Google Gemini Multimodal inline_data format ==');
{
  const webpB64 = Buffer.from('RIFF....WEBPVP8 ').toString('base64');
  const r = openaiRequestToSakana({
    messages: [
      {
        role: 'user',
        parts: [
          { text: '分析这张 Gemini 图片' },
          { inline_data: { mime_type: 'image/webp', data: webpB64 } },
        ],
      },
    ],
  });
  check('gemini prompt text parsed', r.prompt.includes('分析这张 Gemini 图片'));
  check('gemini webp parsed', r.files.some(f => f.mime === 'image/webp' && f.name.endsWith('.webp')));
}

console.log('== 17. Binary Magic Bytes MIME sniffing ==');
{
  const pngBuf = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const pdfBuf = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2D, 0x31, 0x2E, 0x34]);
  const wavBuf = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE')]);
  const mp3Buf = Buffer.from([0x49, 0x44, 0x33, 0x03, 0x00, 0x00]);

  check('sniffs PNG', sniffMimeType(pngBuf) === 'image/png');
  check('sniffs PDF', sniffMimeType(pdfBuf) === 'application/pdf');
  check('sniffs WAV', sniffMimeType(wavBuf) === 'audio/wav');
  check('sniffs MP3', sniffMimeType(mp3Buf) === 'audio/mpeg');
}

console.log('== 18. Concurrency Limiter Queue (100 parallel acquisitions) ==');
{
  const cm = new ConcurrencyManager({ maxConcurrentPerAccount: 5, queueTimeoutMs: 5000 });
  const pool = new AccountPool();
  pool.accounts = [
    { id: 'acct-1', email: 'a1@test.com', cookieHeader: 'c1', state: 'active', inFlight: 0 },
    { id: 'acct-2', email: 'a2@test.com', cookieHeader: 'c2', state: 'active', inFlight: 0 },
  ]; // Capacity = 2 * 5 = 10 slots

  let concurrentActive = 0;
  let maxConcurrentSeen = 0;
  let completed = 0;

  const tasks = Array.from({ length: 50 }, async (_, i) => {
    await cm.acquire(pool);
    concurrentActive++;
    if (concurrentActive > maxConcurrentSeen) maxConcurrentSeen = concurrentActive;
    await new Promise(r => setTimeout(r, 10)); // simulate work
    concurrentActive--;
    completed++;
    cm.release();
  });

  await Promise.all(tasks);
  check('all 50 tasks completed', completed === 50, String(completed));
  check('concurrency never exceeded pool capacity', maxConcurrentSeen <= 10, `max seen: ${maxConcurrentSeen}`);
  check('queue is empty after completion', cm.stats.queueLength === 0 && cm.stats.inFlight === 0);
}

console.log('== 19. Parallel Tool Calls Detection (Array format) ==');
{
  const t = new NdjsonTranslator();
  const chunks = [];
  const line = {
    type: 'finalAnswer',
    text: '```json\n[\n  {"tool": "get_weather", "arguments": {"city": "Tokyo"}},\n  {"tool": "get_stock", "arguments": {"symbol": "AAPL"}}\n]\n```',
  };
  chunks.push(...t.line(JSON.stringify(line)));
  chunks.push(...t.finish());

  const tcChunk = chunks.find(c => c.choices[0]?.delta?.tool_calls);
  check('parallel tool calls detected', !!tcChunk);
  check('both tool calls parsed', tcChunk?.choices[0]?.delta?.tool_calls?.length === 2);
  check('tool 1 is get_weather', tcChunk?.choices[0]?.delta?.tool_calls[0]?.function?.name === 'get_weather');
  check('tool 2 is get_stock', tcChunk?.choices[0]?.delta?.tool_calls[1]?.function?.name === 'get_stock');
  check('finish reason is tool_calls', chunks.at(-2).choices[0].finish_reason === 'tool_calls');
}

console.log('== 20. Tagged <tool_call> and Anthropic/OpenAI Tool Formats ==');
{
  const t = new NdjsonTranslator();
  const chunks = [];
  const line = {
    type: 'finalAnswer',
    text: '我需要查询数据库：<tool_call>{"name": "query_db", "arguments": {"sql": "SELECT * FROM users"}}</tool_call>',
  };
  chunks.push(...t.line(JSON.stringify(line)));
  chunks.push(...t.finish());

  const tcChunk = chunks.find(c => c.choices[0]?.delta?.tool_calls);
  check('tagged tool_call detected', !!tcChunk);
  check('tagged tool name parsed', tcChunk?.choices[0]?.delta?.tool_calls[0]?.function?.name === 'query_db');
  check('tagged tool arguments parsed', tcChunk?.choices[0]?.delta?.tool_calls[0]?.function?.arguments.includes('SELECT'));
}

console.log('== 21. Long-Context Automatic Document Attachment (>12000 chars) ==');
{
  const longText = 'A'.repeat(15000);
  const r = openaiRequestToSakana({
    model: 'sakana-namazu',
    messages: [{ role: 'user', content: longText }],
  });
  check('long prompt auto-attached as context_document.txt', r.files.some(f => f.name === 'context_document.txt'));
  check('prompt replaced with sandbox attachment prompt', r.prompt.includes('context_document.txt') && r.prompt.length < 5000);
}

console.log('== 22. Tool Round-Trip Execution Context Injection ==');
{
  const r = openaiRequestToSakana({
    model: 'sakana-namazu',
    messages: [
      { role: 'user', content: '查询东京天气' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_123', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Tokyo"}' } }] },
      { role: 'tool', tool_call_id: 'call_123', name: 'get_weather', content: '{"weather": "Sunny", "temp": "26C"}' },
    ],
  });
  check('tool result recognized', r.isToolTurn === true);
  check('isContinue stays false (tool result is a fresh input, upstream ignores inputs on is_continue)', r.isContinue === false);
  check('tool result injected into continuation prompt', r.prompt.includes('Sunny') && r.prompt.includes('get_weather'));
}

process.exit(failures ? 1 : 0);