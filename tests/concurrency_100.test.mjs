// 100 Concurrency Stress & High-Load Benchmark
// Simulates 100 concurrent requests arriving simultaneously,
// testing queue scheduling, account dispatching, and streaming parsing under load.

import { ConcurrencyManager } from '../lib/concurrency.js';
import { AccountPool } from '../lib/account-pool.js';
import { openaiRequestToSakana, NdjsonTranslator } from '../lib/translate.js';

let failures = 0;
function check(name, cond, extra = '') {
  if (cond) console.log('  ✓', name);
  else { failures++; console.log('  ✗', name, extra); }
}

console.log('== Starting 100 Concurrent Request Stress Test ==');

async function run100ConcurrencyTest() {
  const cm = new ConcurrencyManager({ maxConcurrentPerAccount: 5, queueTimeoutMs: 15000 });
  const pool = new AccountPool();
  // Simulate 10 active upstream accounts (total concurrent capacity = 10 * 5 = 50 concurrent active slots)
  pool.accounts = Array.from({ length: 10 }, (_, i) => ({
    id: `acct-${i + 1}`,
    email: `sakana${i + 1}@emalupe.com`,
    cookieHeader: `sakana-chat=fake-cookie-${i + 1}`,
    state: 'active',
    inFlight: 0,
    successCount: 0,
    errorCount: 0,
  }));

  const TOTAL_REQUESTS = 100;
  let activeInFlight = 0;
  let maxActiveObserved = 0;
  let successCount = 0;
  let errorCount = 0;
  const latencies = [];

  console.log(`[stress] Spawning ${TOTAL_REQUESTS} concurrent requests against ${pool.accounts.length} accounts...`);
  const t0 = Date.now();

  const requests = Array.from({ length: TOTAL_REQUESTS }, async (_, idx) => {
    const reqStart = Date.now();
    try {
      // 1. Acquire slot from concurrency manager
      await cm.acquire(pool);
      activeInFlight++;
      if (activeInFlight > maxActiveObserved) maxActiveObserved = activeInFlight;

      // 2. Select least-loaded account
      const acct = pool.next();
      if (!acct) throw new Error('no active account in pool');
      pool.acquire(acct.id);

      // 3. Simulate multimodal payload parsing
      const body = {
        model: idx % 2 === 0 ? 'sakana-namazu' : 'sakana-fugu-polite',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: `并发测试请求 #${idx + 1}` },
              { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' } },
            ],
          },
        ],
      };
      const sakanaReq = openaiRequestToSakana(body);
      if (!sakanaReq.prompt || !sakanaReq.files.length) throw new Error('multimodal translation failed');

      // 4. Simulate NDJSON stream chunk processing under load
      const translator = new NdjsonTranslator();
      const rawLines = [
        { type: 'reasoning', token: `[思考${idx}] 分析请求` },
        { type: 'stream', token: `[回复${idx}] ` },
        { type: 'stream', token: `并发任务执行成功。<source-chip title="Sakana" url="https://sakana.ai"/>` },
        { type: 'finalAnswer', text: `[回复${idx}] 并发任务执行成功。<source-chip title="Sakana" url="https://sakana.ai"/>` },
      ];

      for (const line of rawLines) {
        translator.line(JSON.stringify(line));
      }
      translator.finish();

      // Simulate network / generation delay (5~25ms)
      await new Promise(r => setTimeout(r, 5 + Math.random() * 20));

      pool.release(acct.id, true);
      activeInFlight--;
      successCount++;
      latencies.push(Date.now() - reqStart);
    } catch (err) {
      activeInFlight--;
      errorCount++;
      console.error(`Request #${idx + 1} failed:`, err.message);
    } finally {
      cm.release();
    }
  });

  await Promise.all(requests);
  const duration = Date.now() - t0;
  latencies.sort((a, b) => a - b);
  const avg = Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length);
  const p95 = latencies[Math.floor(latencies.length * 0.95)] || 0;
  const p99 = latencies[Math.floor(latencies.length * 0.99)] || 0;
  const qps = ((TOTAL_REQUESTS / (duration / 1000))).toFixed(1);

  console.log(`[stress] Results: ${successCount}/${TOTAL_REQUESTS} succeeded in ${duration}ms (${qps} req/s)`);
  console.log(`[stress] Latency: min=${latencies[0]}ms, avg=${avg}ms, p95=${p95}ms, p99=${p99}ms, max=${latencies[latencies.length - 1]}ms`);
  console.log(`[stress] Max Active In-Flight: ${maxActiveObserved} (Limit: ${pool.accounts.length * 5})`);

  check('100% of 100 concurrent requests succeeded', successCount === TOTAL_REQUESTS && errorCount === 0);
  check('max in-flight respected account pool limits', maxActiveObserved <= pool.accounts.length * 5);
  check('all account connection counts balanced', pool.accounts.every(a => a.inFlight === 0 && a.successCount > 0));
  check('concurrency queue fully drained', cm.stats.queueLength === 0 && cm.stats.inFlight === 0);
}

run100ConcurrencyTest().then(() => {
  process.exit(failures ? 1 : 0);
}).catch(err => {
  console.error('Stress test failed:', err);
  process.exit(1);
});
