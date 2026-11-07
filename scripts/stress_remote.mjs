#!/usr/bin/env node
// Live load / long-context stress against a running sakana-2api deployment.
//
//   BASE_URL=http://127.0.0.1:8787 API_KEY=... npm run test:stress:live
//
// Sends real text turns (growing full history), a long document, a base64 text
// file, an optional image, a delta continuation, and a bounded concurrency
// burst. Writes a JSON report with per-call latency/tokens/error and the server
// audit tail. No synthetic upstream: every request hits the real model.
//
// Env:
//   BASE_URL (default http://127.0.0.1:8787)
//   API_KEY (required)
//   ROUNDS (default 6) CONCURRENCY (default 8)
//   OUT (default stress-report.json) IMAGE_PATH (optional PNG/JPEG)

import fs from 'node:fs';
import path from 'node:path';

const base = String(process.env.BASE_URL || 'http://127.0.0.1:8787').replace(/\/+$/, '');
const key = String(process.env.API_KEY || '').trim();
if (!key) {
  console.error('API_KEY is required');
  process.exit(2);
}
const rounds = Math.max(1, Math.min(20, parseInt(process.env.ROUNDS || '6', 10)));
const concurrency = Math.max(1, Math.min(50, parseInt(process.env.CONCURRENCY || '8', 10)));
const outFile = path.resolve(process.env.OUT || 'stress-report.json');
const imagePath = process.env.IMAGE_PATH || '';
const headers = { authorization: `Bearer ${key}`, 'content-type': 'application/json' };

const report = { startedAt: new Date().toISOString(), base, rounds, concurrency, calls: [], audit: null };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeText(chars, seed = 0) {
  const unit = `第${seed}段：这是一段用于真实压力测试的中文文本，包含标点、数字 123456、English words 与 Markdown 标记。\n`;
  return unit.repeat(Math.ceil(chars / unit.length)).slice(0, chars);
}

async function call(label, body, { timeoutMs = 240000, collectStream = false } = {}) {
  const started = Date.now();
  const record = { label, model: body.model, stream: !!body.stream, mode: body.history_mode || 'full', charsIn: JSON.stringify(body.messages || []).length };
  try {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    record.status = response.status;
    record.conversationId = response.headers.get('x-conversation-id') || '';
    if (collectStream && response.ok && response.body) {
      let text = '';
      let sse = '';
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        sse += chunk;
        for (const line of chunk.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') continue;
          try { text += JSON.parse(data).choices?.[0]?.delta?.content || ''; } catch {}
        }
      }
      record.charsOut = text.length;
      record.sample = text.slice(0, 80);
      record.sseDone = sse.includes('data: [DONE]');
    } else {
      const text = await response.text();
      let json = null;
      try { json = JSON.parse(text); } catch {}
      record.charsOut = json?.choices?.[0]?.message?.content?.length || 0;
      record.sample = (json?.choices?.[0]?.message?.content || '').slice(0, 80);
      record.promptTokens = json?.usage?.prompt_tokens ?? null;
      record.completionTokens = json?.usage?.completion_tokens ?? null;
      record.totalTokens = json?.usage?.total_tokens ?? null;
      record.error = json?.error?.code || json?.error?.message || null;
      if (!response.ok && !record.error) record.error = text.slice(0, 120);
    }
  } catch (error) {
    record.error = String(error.message || error).slice(0, 200);
  }
  record.ms = Date.now() - started;
  report.calls.push(record);
  console.log(JSON.stringify({ label, status: record.status, ms: record.ms, charsOut: record.charsOut, error: record.error || undefined }));
  return record;
}

async function main() {
  // 0. warmup / auth
  await call('warmup', { model: 'sakana', stream: false, max_tokens: 32, messages: [{ role: 'user', content: '只回复两个字：就绪' }] });

  // 1. growing full-history conversation
  const history = [];
  for (let i = 1; i <= rounds; i++) {
    const user = makeText(200 + i * 400, i);
    history.push({ role: 'user', content: user });
    const rec = await call(`turn-${i}`, { model: 'sakana', stream: false, max_tokens: 160, messages: [...history] });
    history.push({ role: 'assistant', content: rec.sample || '收到。' });
  }

  // 2. long document prompt (20k chars)
  await call('long-text-20k', {
    model: 'sakana-writer', stream: false, max_tokens: 200,
    messages: [{ role: 'user', content: `${makeText(20000, 99)}\n\n请用一句话总结上面文本的主旨。` }],
  });

  // 3. base64 text file attachment (~24KB)
  const doc = `# 真实压测文档\n\n${makeText(24000, 7)}`;
  await call('file-text-24k', {
    model: 'sakana', stream: false, max_tokens: 120,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: '附件是一份 Markdown 文档，请只回复它的第一行标题。' },
        { type: 'file', name: 'stress.md', source: { type: 'base64', media_type: 'text/markdown', data: Buffer.from(doc).toString('base64') } },
      ],
    }],
  });

  // 4. optional image attachment
  if (imagePath && fs.existsSync(imagePath)) {
    const data = fs.readFileSync(imagePath).toString('base64');
    const mime = /\.jpe?g$/i.test(imagePath) ? 'image/jpeg' : 'image/png';
    await call('image', {
      model: 'sakana', stream: false, max_tokens: 120,
      messages: [{ role: 'user', content: [
        { type: 'text', text: '认出图片内容，只用一句话描述。' },
        { type: 'image_url', image_url: { url: `data:${mime};base64,${data}` } },
      ] }],
    });
  }

  // 5. streaming
  const streamRec = await call('stream', {
    model: 'sakana-mini', stream: true, max_tokens: 80,
    messages: [{ role: 'user', content: '用一句话说明流式输出正常。' }],
  }, { collectStream: true });
  if (!streamRec.sseDone) streamRec.error = streamRec.error || 'missing [DONE]';

  // 6. delta continuation using the stream conversation id
  if (streamRec.conversationId) {
    await call('delta-continue', {
      model: 'sakana-mini', stream: false, max_tokens: 80,
      history_mode: 'delta', conversation_id: streamRec.conversationId,
      messages: [{ role: 'user', content: '继续补充一句。' }],
    });
  }

  // 7. bounded concurrency burst (short prompts)
  const burst = await Promise.all(Array.from({ length: concurrency }, (_, i) =>
    call(`burst-${i + 1}`, { model: 'sakana-mini', stream: false, max_tokens: 40, messages: [{ role: 'user', content: `并发测试 ${i + 1}：只回复 ok` }] }, { timeoutMs: 240000 })));
  report.burst = {
    count: burst.length,
    errors: burst.filter((item) => item.error).length,
    p50Ms: percentile(burst.map((item) => item.ms), 50),
    p95Ms: percentile(burst.map((item) => item.ms), 95),
  };

  // 8. server audit tail (needs the same key to be admin-capable)
  try {
    const auditRes = await fetch(`${base}/api/audit`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20000) });
    if (auditRes.ok) {
      const auditJson = await auditRes.json();
      report.audit = (auditJson.entries || []).slice(0, 40);
    } else {
      report.audit = { status: auditRes.status };
    }
  } catch (error) {
    report.audit = { error: String(error.message || error).slice(0, 160) };
  }
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index];
}

try {
  await main();
} catch (error) {
  report.fatal = String(error.message || error).slice(0, 300);
} finally {
  const ok = report.calls.filter((item) => !item.error && item.status >= 200 && item.status < 300);
  const failed = report.calls.filter((item) => item.error || item.status >= 400);
  report.summary = {
    total: report.calls.length,
    ok: ok.length,
    failed: failed.length,
    p50Ms: percentile(ok.map((item) => item.ms), 50),
    p95Ms: percentile(ok.map((item) => item.ms), 95),
    maxMs: ok.length ? Math.max(...ok.map((item) => item.ms)) : null,
    tokensIn: ok.reduce((n, item) => n + (item.promptTokens || 0), 0),
    tokensOut: ok.reduce((n, item) => n + (item.completionTokens || 0), 0),
    seconds: Math.round((Date.now() - Date.parse(report.startedAt)) / 1000),
  };
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
  console.log('STRESS_SUMMARY ' + JSON.stringify(report.summary));
  console.log('REPORT ' + outFile);
  if (failed.length) process.exitCode = 1;
}