// TDD:工具链路重构 + 搜索合并 thinking + 安全文本剥离 的失败测试
import {
  openaiRequestToSakana, NdjsonTranslator, extractJsonToolCalls,
} from '../lib/translate.js';

let failures = 0;
function check(name, cond, extra = '') {
  if (cond) console.log('  ✓', name);
  else { failures++; console.log('  ✗', name, extra); }
}

console.log('== 1. JSON 工具调用提取(非锚定,嵌入文本) ==');
{
  const embedded = extractJsonToolCalls('好的，我来执行：{"tool":"bash","arguments":{"command":"ls -la"}}');
  check('文本中间嵌入的 JSON 可提取', !!embedded && embedded[0].name === 'bash' && embedded[0].arguments.includes('ls -la'), JSON.stringify(embedded));
  const md = extractJsonToolCalls('```json\n{"tool":"read","arguments":{"path":"/etc/hosts"}}\n```\n已读取');
  check('markdown 块 + 尾部文本可提取', !!md && md[0].name === 'read', JSON.stringify(md));
  const none = extractJsonToolCalls('我直接回答你的问题，不需要调用工具。');
  check('无工具调用返回 null', none === null, JSON.stringify(none));
  const arr = extractJsonToolCalls('以下是调用：[{"tool":"write","arguments":{"path":"a.txt","content":"hi"}}] 完成');
  check('数组形式(带前后文本)可提取', !!arr && arr[0].name === 'write', JSON.stringify(arr));
}

console.log('== 2. 原生沙盒工具调用 delta 抑制 ==');
{
  const t = new NdjsonTranslator();
  const out = t.line(JSON.stringify({ type: 'toolCall', toolCall: { toolCallId: 'functions.run_python.abc', toolName: 'run_python', input: { code: 'print(1)' } } }));
  check('functions.* 工具调用不产生客户端 tool_calls delta', out.length === 0, JSON.stringify(out));
  check('标记为 native 回合(供服务端自动续轮)', t.nativeToolRound === true);
  const t2 = new NdjsonTranslator();
  const out2 = t2.line(JSON.stringify({ type: 'toolCall', toolCall: { toolCallId: 'call_9', toolName: 'bash', input: { command: 'ls' } } }));
  check('未声明客户端工具名同样抑制', out2.length === 0, JSON.stringify(out2));
}

console.log('== 3. 搜索事件合并进 thinking ==');
{
  const t = new NdjsonTranslator();
  const out = t.line(JSON.stringify({ type: 'toolCall', toolCall: { toolCallId: 'functions.search.1', toolName: 'search', input: { query: '今天东京天气' } } }));
  check('搜索开始 → reasoning 增量', out.some(c => c.choices[0].delta.reasoning_content && c.choices[0].delta.reasoning_content.includes('搜索')), JSON.stringify(out));
  const t2 = new NdjsonTranslator();
  const out2 = t2.line(JSON.stringify({ type: 'toolResult', toolResult: { toolName: 'search', output: { sources: [{ title: '日本气象厅', url: 'https://www.jma.go.jp' }] } } }));
  check('搜索来源 → reasoning 增量', out2.some(c => c.choices[0].delta.reasoning_content && c.choices[0].delta.reasoning_content.includes('日本气象厅')), JSON.stringify(out2));
}

console.log('== 4. 上游安全停止文本剥离 ==');
{
  const SAFETY = '安全でない入出力が検出されたため、回答を停止しました。';
  const t = new NdjsonTranslator();
  const out = t.line(JSON.stringify({ type: 'stream', token: '正常内容。' + SAFETY }));
  const content = out.map(c => c.choices[0].delta.content || '').join('');
  check('安全文本从 content 剥离', !content.includes('安全でない') && content.includes('正常内容'), JSON.stringify(content));
  const t2 = new NdjsonTranslator();
  const out2 = t2.line(JSON.stringify({ type: 'finalAnswer', text: '答案。' + SAFETY }));
  const content2 = out2.map(c => c.choices[0].delta.content || '').join('');
  check('finalAnswer 同样剥离', !content2.includes('安全でない') && content2.includes('答案'), JSON.stringify(content2));
}

console.log('== 5. 搜索模式:enableThinking 关闭 + webSearch 开启 ==');
{
  const r = openaiRequestToSakana({ model: 'sakana-namazu-search', messages: [{ role: 'user', content: '今天东京天气?' }], web_search: true });
  check('搜索模式 → thinking 关', r.enableThinking === false, JSON.stringify({ et: r.enableThinking, ws: r.webSearchEnabled }));
  check('搜索模式 → webSearch 开', r.webSearchEnabled === true);
  const r2 = openaiRequestToSakana({ model: 'sakana-namazu', messages: [{ role: 'user', content: '你好' }] });
  check('默认模式 → thinking 开', r2.enableThinking === true, JSON.stringify({ et: r2.enableThinking, ws: r2.webSearchEnabled }));
  check('默认模式 → webSearch 关', r2.webSearchEnabled === false);
  const r3 = openaiRequestToSakana({ model: 'sakana-namazu', messages: [{ role: 'user', content: '你好' }], web_search: false });
  check('显式 web_search:false → 思考模式', r3.enableThinking === true && r3.webSearchEnabled === false);
}

console.log('== 6. 客户端工具提示词强化 ==');
{
  const r = openaiRequestToSakana({
    model: 'sakana-namazu',
    messages: [{ role: 'user', content: '执行 ls' }],
    tools: [{ type: 'function', function: { name: 'bash', description: '执行命令', parameters: { type: 'object', properties: {} } } }],
  });
  check('提示禁止内置沙盒工具', r.prompt.includes('禁止') && /run_command|run_python/.test(r.prompt), r.prompt.slice(-600));
  check('提示只输出 JSON 对象', r.prompt.includes('JSON 对象') || r.prompt.includes('json'), r.prompt.slice(-600));
  check('工具名与描述入提示', r.prompt.includes('bash') && r.prompt.includes('执行命令'));
}

console.log('== 7. Anthropic 工具格式双向转换 ==');
{
  const { anthropicToChat, chatToAnthropicNonStream, openAiChunkToAnthropicEvents } = await import('../lib/anthropic.js');
  // 请求:tool_use 块 → assistant tool_calls
  const chat = anthropicToChat({
    model: 'sakana-namazu',
    messages: [
      { role: 'user', content: '执行 ls' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'bash', input: { command: 'ls' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'a.txt\nb.txt' }] },
    ],
    tools: [{ name: 'bash', description: '执行命令', input_schema: { type: 'object', properties: {} } }],
  });
  check('tool_use → tool_calls', chat.messages[1].tool_calls && chat.messages[1].tool_calls[0].id === 'toolu_1' && chat.messages[1].tool_calls[0].function.name === 'bash', JSON.stringify(chat.messages[1]));
  check('tool_result → role:tool', chat.messages[2].role === 'tool' && chat.messages[2].tool_call_id === 'toolu_1', JSON.stringify(chat.messages[2]));
  check('anthropic tools → openai tools', chat.tools[0].function.name === 'bash' && chat.tools[0].function.parameters === undefined, JSON.stringify(chat.tools));
  // 非流式响应:tool_calls → tool_use
  const anth = chatToAnthropicNonStream({
    choices: [{ index: 0, message: { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } }] }, finish_reason: 'tool_calls' }],
  });
  check('tool_calls → tool_use 块', anth.content[0].type === 'tool_use' && anth.content[0].id === 'call_1' && anth.content[0].name === 'bash' && anth.content[0].input.command === 'ls', JSON.stringify(anth));
  check('stop_reason=tool_use', anth.stop_reason === 'tool_use');
  // 流式响应:tool_calls delta → content_block_start/input_json_delta/stop + message_delta
  const events = openAiChunkToAnthropicEvents({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'bash', arguments: '{"command":"l' } }] }, finish_reason: null }] }, 'm');
  check('首片 → content_block_start(tool_use)', events[0].type === 'content_block_start' && events[0].content_block.type === 'tool_use' && events[0].content_block.name === 'bash', JSON.stringify(events));
  check('参数分片 → input_json_delta', events[1].type === 'content_block_delta' && events[1].delta.type === 'input_json_delta', JSON.stringify(events));
  const finish = openAiChunkToAnthropicEvents({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }, 'm');
  check('收尾 → message_delta(stop_reason=tool_use) + message_stop', finish.some(e => e.type === 'message_delta' && e.delta.stop_reason === 'tool_use') && finish.some(e => e.type === 'message_stop'), JSON.stringify(finish));
}

console.log('== 8. 流式 usage 收尾块(独立 choices:[] chunk) ==');
{
  const t = new NdjsonTranslator();
  t.line(JSON.stringify({ type: 'stream', token: '你好世界' }));
  const fin = t.finish();
  check('finish 块带 finish_reason', fin[0].choices[0].finish_reason === 'stop', JSON.stringify(fin));
  check('独立 usage chunk(choices 空数组)', fin.some(c => Array.isArray(c.choices) && c.choices.length === 0 && c.usage && c.usage.total_tokens > 0), JSON.stringify(fin));
}

console.log('== 9. 工具回合 JSON 候选抑制(声明 tools 时 content 不泄漏 JSON) ==');
{
  // 声明了工具:模型流式输出 {"tool":...} 时缓冲,不产生 content delta
  const t = new NdjsonTranslator({ declaredTools: ['get_weather'] });
  const out1 = t.line(JSON.stringify({ type: 'stream', token: '{"tool":"get_wea' }));
  check('JSON 候选阶段不发 content', out1.length === 0, JSON.stringify(out1));
  const out2 = t.line(JSON.stringify({ type: 'stream', token: 'ther","arguments":{"city":"北京"}}' }));
  check('完整 JSON 仍不发 content', out2.length === 0, JSON.stringify(out2));
  const out3 = t.line(JSON.stringify({ type: 'finalAnswer', text: '{"tool":"get_weather","arguments":{"city":"北京"}}' }));
  check('finalAnswer 提取为 tool_calls', out3.some(c => c.choices[0].delta.tool_calls), JSON.stringify(out3));
  const tc = out3.flatMap(c => c.choices[0].delta.tool_calls || [])[0];
  check('tool_calls 参数完整', tc && tc.function.name === 'get_weather' && tc.function.arguments.includes('北京'), JSON.stringify(tc));

  // 自然语言信号(换行)出现 → 判定不是 JSON,flush 缓冲正常发
  const t2 = new NdjsonTranslator({ declaredTools: ['get_weather'] });
  const a = t2.line(JSON.stringify({ type: 'stream', token: '{"tool":"get_weather",' }));
  check('候选缓冲不发', a.length === 0);
  const b = t2.line(JSON.stringify({ type: 'stream', token: '\n好的，这是完整回答' }));
  const flushed = b.flatMap(c => c.choices[0].delta.content || []);
  check('换行后 flush 缓冲为 content', flushed.join('').includes('好的'), JSON.stringify(flushed));

  // 未声明工具(普通聊天):JSON 风格回答照常发出,不缓冲
  const t3 = new NdjsonTranslator();
  const c = t3.line(JSON.stringify({ type: 'stream', token: '{"answer":"直接回答"}' }));
  check('无工具声明时不缓冲', c.some(x => (x.choices[0].delta.content || '').includes('直接回答')), JSON.stringify(c));
}

console.log(failures === 0 ? '\nALL TOOLS/SEARCH TESTS PASSED' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
