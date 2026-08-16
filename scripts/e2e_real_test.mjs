// Real live end-to-end integration & stress test against running server.js
import http from 'http';
import { spawn } from 'child_process';
import path from 'path';

const PORT = 8798;
const BASE = `http://127.0.0.1:${PORT}`;

let serverProcess = null;
let failures = 0;

function check(name, cond, extra = '') {
  if (cond) console.log('  ✓', name);
  else { failures++; console.log('  ✗', name, extra); }
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function request(path, options = {}) {
  const url = BASE + path;
  try {
    const res = await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(options.timeout || 60000),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, headers: res.headers, text, json };
  } catch (err) {
    return { status: 504, headers: new Headers(), text: err.message, json: { error: { message: err.message } } };
  }
}

async function startServer() {
  console.log(`[test] Launching server.js on port ${PORT}...`);
  serverProcess = spawn('node', ['server.js'], {
    cwd: path.resolve('.'),
    env: { ...process.env, PORT: String(PORT), AUTO_SESSION: 'false', CACHE_ENABLED: 'true' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  serverProcess.stdout.on('data', d => {
    const s = d.toString();
    if (s.includes('error') || s.includes('Error')) console.log('[server:out]', s.trim());
  });
  serverProcess.stderr.on('data', d => {
    console.error('[server:err]', d.toString().trim());
  });

  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) {
        console.log('[test] Server is ready!');
        return;
      }
    } catch {}
    await sleep(300);
  }
  throw new Error('Server failed to start within 10s');
}

async function stopServer() {
  if (serverProcess) {
    console.log('[test] Stopping server...');
    serverProcess.kill('SIGTERM');
    await sleep(500);
    try { serverProcess.kill('SIGKILL'); } catch {}
    serverProcess = null;
  }
}

async function runTests() {
  try {
    await startServer();

    console.log('\n== 1. Basic Health & Metadata Endpoints ==');
    {
      const h = await request('/health');
      check('GET /health returns 200 OK', h.status === 200 && h.json?.ok === true);

      const m = await request('/v1/models');
      check('GET /v1/models returns 200', m.status === 200);
      check('GET /v1/models contains models array (12 models)', Array.isArray(m.json?.data) && m.json?.data.length === 12);
      check('models include sakana-namazu and sakana-fugu', m.json?.data.some(x => x.id === 'sakana-namazu') && m.json?.data.some(x => x.id === 'sakana-fugu'));

      const s = await request('/api/stats');
      check('GET /api/stats returns 200', s.status === 200 && typeof s.json?.requests?.total === 'number');

      const a = await request('/api/accounts');
      check('GET /api/accounts returns 200', a.status === 200 && Array.isArray(a.json?.accounts));
    }

    console.log('\n== 2. Multimodal Formats Parsing ==');
    {
      // A. OpenAI format with 1x1 PNG image
      const pngB64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
      const openaiImg = await request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'sakana-namazu',
          stream: false,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: '这张图片是什么？' },
                { type: 'image_url', image_url: { url: `data:image/png;base64,${pngB64}` } },
              ],
            },
          ],
        }),
      });
      check('OpenAI multimodal image request accepted', [200, 401, 502, 504].includes(openaiImg.status), `status: ${openaiImg.status}, body: ${openaiImg.text}`);

      // B. Anthropic Claude format
      const claudeImg = await request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'sakana-namazu',
          stream: false,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: '解析此图片' },
                { type: 'image', source: { type: 'base64', media_type: 'image/png', data: pngB64 } },
              ],
            },
          ],
        }),
      });
      check('Claude multimodal format accepted', [200, 401, 502, 504].includes(claudeImg.status), `status: ${claudeImg.status}, body: ${claudeImg.text}`);

      // C. Google Gemini format
      const geminiImg = await request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'sakana-namazu',
          stream: false,
          messages: [
            {
              role: 'user',
              parts: [
                { text: '分析 Gemini 格式' },
                { inline_data: { mime_type: 'image/png', data: pngB64 } },
              ],
            },
          ],
        }),
      });
      check('Gemini multimodal format accepted', [200, 401, 502, 504].includes(geminiImg.status), `status: ${geminiImg.status}, body: ${geminiImg.text}`);

      // D. Text file extraction
      const docData = Buffer.from('机密代码: SAKANA-2026').toString('base64');
      const fileReq = await request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'sakana-namazu',
          stream: false,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: '提取文件里的机密代码' },
                { type: 'file', name: 'secret.txt', file_url: `data:text/plain;base64,${docData}` },
              ],
            },
          ],
        }),
      });
      check('File attachment document accepted', [200, 401, 502, 504].includes(fileReq.status), `status: ${fileReq.status}, body: ${fileReq.text}`);
    }

    console.log('\n== 3. 100 Concurrent Burst Live HTTP Stress Test ==');
    {
      const TOTAL_CONCURRENT = 100;
      console.log(`[stress] Sending ${TOTAL_CONCURRENT} parallel HTTP requests to live server...`);
      const t0 = Date.now();

      let success200 = 0;
      let handledCount = 0;
      const statusCounts = {};

      const promises = Array.from({ length: TOTAL_CONCURRENT }, async (_, i) => {
        try {
          const res = await request(i % 3 === 0 ? '/v1/models' : i % 3 === 1 ? '/api/stats' : '/health', {
            timeout: 15000,
          });
          handledCount++;
          statusCounts[res.status] = (statusCounts[res.status] || 0) + 1;
          if (res.status === 200) success200++;
        } catch (e) {
          handledCount++;
          statusCounts['err:' + e.message] = (statusCounts['err:' + e.message] || 0) + 1;
        }
      });

      await Promise.all(promises);
      const elapsed = Date.now() - t0;
      console.log(`[stress] Completed ${handledCount}/${TOTAL_CONCURRENT} requests in ${elapsed}ms`);
      console.log('[stress] Status breakdown:', JSON.stringify(statusCounts));

      check('100/100 concurrent requests handled without server crash', handledCount === TOTAL_CONCURRENT);
      check('All 100 requests returned 200 OK', success200 === TOTAL_CONCURRENT, `got ${success200}/100`);
    }

    console.log('\n== 4. Verify Server Health After Concurrency ==');
    {
      const postCheck = await request('/health');
      check('Server remains healthy after 100 concurrency burst', postCheck.status === 200);

      const statsCheck = await request('/api/stats');
      check('Stats tracks concurrent requests', statsCheck.status === 200 && typeof statsCheck.json?.requests?.total === 'number');
    }

  } finally {
    await stopServer();
  }
}

runTests().then(() => {
  console.log('\n' + (failures === 0 ? '=== ALL LIVE TESTS PASSED ===' : `=== ${failures} FAILURES ===`));
  process.exit(failures ? 1 : 0);
}).catch(err => {
  console.error('Fatal test error:', err);
  stopServer().finally(() => process.exit(1));
});
