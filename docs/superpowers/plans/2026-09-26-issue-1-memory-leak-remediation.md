# Issue #1 Memory Leak Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop Playwright target-crash recovery from accumulating browser resources, expose bounded memory diagnostics, and keep the container from exhausting host memory during long runs.

**Architecture:** Keep the single shared persistent Playwright context and the existing account-pool lock, but make browser startup/recovery single-flight and lifecycle-aware. Browser crash recovery will close and discard the failed context before a bounded retry; health and stats will report only scalar process/browser state. Docker defaults will add a V8 heap ceiling and configurable 2 GiB container boundary without changing session files or upstream behavior.

**Tech Stack:** Node.js 22 CommonJS, Playwright 1.62, Node `node:test`/existing executable `.mjs` tests, Docker Compose.

---

### Task 1: Add deterministic auto-session lifecycle tests

**Files:**
- Create: `tests/auto-session-lifecycle.test.mjs`
- Modify: `lib/auto-session.js:18-32,109-134,450-482` to expose test-only lifecycle seams without exposing cookies or tokens

- [ ] **Step 1: Write failing tests for single-flight startup and context invalidation**

Create a test that injects a fake `launchPersistentContext` implementation and asserts that two concurrent browser acquisitions resolve to the same fake context and increment the launch counter once. Add a second case where the fake context emits `close`, then assert the cached state reports no live context and the next acquisition launches exactly one replacement.

The test must use a fake context with these methods/events: `pages()`, `newPage()`, `close()`, `on()`, and `browser().on()`. It must not contact Sakana or launch a real browser.

- [ ] **Step 2: Run the focused test and verify it fails for the current implementation**

Run:

```bash
node tests/auto-session-lifecycle.test.mjs
```

Expected: FAIL because the current module has no injectable launcher/status seam and does not clear its cached context when the browser target closes.

- [ ] **Step 3: Add minimal test seams and lifecycle state**

Add internal state in `lib/auto-session.js`:

```js
let context = null;
let browserStart = null;
const browserState = {
  launches: 0,
  recoveries: 0,
  lastError: '',
  lastErrorAt: 0,
  lastRecoveryAt: 0,
};
let launchContext = (opts) => chromium.launchPersistentContext(PROFILE_DIR, opts);
```

Add a `bindContextLifecycle(ctx)` helper that registers `close` on the context and `disconnected` on `ctx.browser()` when available. Each handler must clear `context` only if the event belongs to the currently cached context. Export `__testing` methods for tests: `reset()`, `setLauncher(fn)`, `ensureBrowser()`, `state()`, and `emitContextClose()` only through the existing module export object. `state()` must return a copy with `hasContext`, `pageCount`, `launches`, `recoveries`, `lastError`, `lastErrorAt`, and `lastRecoveryAt`.

- [ ] **Step 4: Make `ensureBrowser()` single-flight and page-count independent**

Change `ensureBrowser()` so it:

1. Returns the existing context after a safe `pages()` probe, even when it has zero pages.
2. Returns `browserStart` while a launch is pending.
3. Uses `launchContext(opts)` exactly once per launch.
4. Binds lifecycle listeners before publishing the context.
5. Clears `browserStart` in `finally`.
6. Increments `browserState.launches` only after a successful launch.

Do not change the persistent profile path, browser flags, locale, or anti-automation init script.

- [ ] **Step 5: Run the focused test and verify it passes**

Run:

```bash
node tests/auto-session-lifecycle.test.mjs
```

Expected: PASS for concurrent startup, zero-page context reuse, and close/disconnect invalidation.

- [ ] **Step 6: Commit the lifecycle seam**

```bash
git add lib/auto-session.js tests/auto-session-lifecycle.test.mjs
git commit -m "fix: make auto-session browser lifecycle single-flight"
```

### Task 2: Add bounded crash recovery to harvest and refresh operations

**Files:**
- Modify: `lib/auto-session.js:333-447,450-482`
- Modify: `tests/auto-session-lifecycle.test.mjs`

- [ ] **Step 1: Add failing recovery tests**

Add a fake page whose `goto()` rejects with `Error("Target crashed")` on the first call. Assert that the failed context is closed, `recoveries` increments, the second context is launched, and the operation succeeds. Add a test where every attempt crashes and assert the error is propagated after the configured maximum attempts. Stub the sleep function through the test seam so the test does not wait in real time.

- [ ] **Step 2: Run the recovery tests and verify they fail**

Run:

```bash
node tests/auto-session-lifecycle.test.mjs
```

Expected: FAIL because current harvest/refresh paths retry without centrally closing and discarding the failed context.

- [ ] **Step 3: Implement crash classification and cleanup**

Add helpers:

```js
const CRASH_RETRIES = parseInt(process.env.AUTO_SESSION_CRASH_RETRIES || '2', 10);
const CRASH_BACKOFF_MS = parseInt(process.env.AUTO_SESSION_CRASH_BACKOFF_MS || '1000', 10);

function isBrowserCrashError(err) {
  const msg = String(err?.message || err || '').toLowerCase();
  return /target crashed|browser has been closed|context has been closed|page has been closed/.test(msg);
}

async function discardBrowser(reason) {
  const old = context;
  context = null;
  if (!old) return;
  try { await old.close(); } catch {}
  browserState.recoveries++;
  browserState.lastError = String(reason?.message || reason || 'browser crash').slice(0, 200);
  browserState.lastErrorAt = Date.now();
  browserState.lastRecoveryAt = Date.now();
}
```

Ensure cleanup is idempotent and never closes a replacement context that was published after the failure.

- [ ] **Step 4: Wrap browser-backed harvest/refresh with bounded retry**

Add `withBrowserRecovery(operation)` that runs the operation, catches only `isBrowserCrashError` failures, calls `discardBrowser()`, waits `CRASH_BACKOFF_MS * 2 ** attempt` with a maximum of three attempts total, and retries. Non-crash errors must be rethrown immediately. Use this wrapper at the exported `harvestSessionLocked`, `harvestFresh`, and `refreshAccount` boundaries so existing account-pool serialization remains intact. Do not add a second retry loop inside `account-pool.js`.

- [ ] **Step 5: Make stop drain and close safely**

Update `stop()` to clear both timers, await `queue`, call `discardBrowser('stop')`, and reset the queue to `Promise.resolve()` so a later `start()` is clean. Keep repeated `stop()` calls harmless. Do not wait forever on a broken browser close operation.

- [ ] **Step 6: Run focused and existing account-pool tests**

Run:

```bash
node tests/auto-session-lifecycle.test.mjs
node tests/account-pool.test.mjs
```

Expected: PASS, with crash recovery closing each failed context exactly once and account-pool behavior unchanged.

- [ ] **Step 7: Commit crash recovery**

```bash
git add lib/auto-session.js tests/auto-session-lifecycle.test.mjs
git commit -m "fix: recover crashed auto-session browsers with bounded backoff"
```

### Task 3: Expose bounded memory and browser diagnostics

**Files:**
- Modify: `lib/auto-session.js:450-482`
- Modify: `server.js:946-958,1037-1062`
- Create: `tests/observability.test.mjs`

- [ ] **Step 1: Write failing observability tests**

Add a small test for a new `memorySnapshot()` helper that asserts numeric `rssMB`, `heapUsedMB`, `heapTotalMB`, `externalMB`, and `arrayBuffersMB`. Add an HTTP-level assertion using the existing server startup pattern that `/health` still returns `ok: true` and includes numeric `uptimeSec` and memory fields. The test must not assert exact values.

- [ ] **Step 2: Run the test and verify it fails**

Run:

```bash
node tests/observability.test.mjs
```

Expected: FAIL because `/health` currently returns only `{ ok: true }` and auto-session has no public diagnostics method.

- [ ] **Step 3: Add scalar helpers and status output**

Add a `memorySnapshot()` helper in `server.js` that converts `process.memoryUsage()` to rounded MiB fields. Change `/health` to return:

```js
{
  ok: true,
  uptimeSec: Math.floor(process.uptime()),
  memory: memorySnapshot()
}
```

Extend `autoSession` with `status()` returning only `browserState` scalars and the current page count; never include cookies, tokens, profile paths, or mailbox data.

- [ ] **Step 4: Include browser status in `/api/stats` operations**

At the existing `s.ops` object, add `browser: autoSession.status()`. Keep the existing `mem` fields for dashboard compatibility and leave all request/account statistics unchanged.

- [ ] **Step 5: Run observability and existing tests**

Run:

```bash
node tests/observability.test.mjs
npm test
```

Expected: PASS. `/health` remains suitable for the current Compose healthcheck and the existing protocol tests remain green.

- [ ] **Step 6: Commit observability**

```bash
git add lib/auto-session.js server.js tests/observability.test.mjs
 git commit -m "feat: expose process and browser memory diagnostics"
```

### Task 4: Add Docker heap and memory guardrails

**Files:**
- Modify: `docker-entrypoint.sh:1-12`
- Modify: `docker-compose.yml:4-34`
- Create: `tests/container-config.test.mjs`

- [ ] **Step 1: Write failing config assertions**

Add a text-based config test that reads the two files and asserts:

- `docker-entrypoint.sh` sets a default `NODE_OPTIONS` containing `--max-old-space-size=1536` without overwriting an existing value.
- Compose keeps `restart: unless-stopped` and adds configurable `mem_limit` defaulting to `2g`.
- Compose sets `memswap_limit` from an environment override with a default of `2g`.

- [ ] **Step 2: Run the config test and verify it fails**

Run:

```bash
node tests/container-config.test.mjs
```

Expected: FAIL because the current entrypoint and Compose file have no heap or memory limits.

- [ ] **Step 3: Add the entrypoint default**

Before the `AUTO_SESSION` branch in `docker-entrypoint.sh`, add:

```sh
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=1536}"
```

This preserves a caller-provided `NODE_OPTIONS` string and supplies the default only when unset.

- [ ] **Step 4: Add configurable Compose limits**

Under the service definition in `docker-compose.yml`, add:

```yaml
    mem_limit: ${MEMORY_LIMIT:-2g}
    memswap_limit: ${MEMORY_SWAP_LIMIT:-2g}
```

Keep `restart: unless-stopped`, `init: true`, volumes, healthcheck, and existing account-pool environment variables unchanged.

- [ ] **Step 5: Validate Compose interpolation and run tests**

Run:

```bash
node tests/container-config.test.mjs
docker compose config
```

Expected: PASS; rendered Compose config shows `mem_limit: 2g`, `memswap_limit: 2g`, and `restart: unless-stopped`. If Docker is unavailable, report that command as skipped while the text test still passes.

- [ ] **Step 6: Commit container guardrails**

```bash
git add docker-entrypoint.sh docker-compose.yml tests/container-config.test.mjs
git commit -m "ops: cap node heap and container memory"
```

### Task 5: Full verification and issue handoff

**Files:**
- Modify: only files required by verification fixes

- [ ] **Step 1: Run all focused tests**

```bash
node tests/auto-session-lifecycle.test.mjs
node tests/observability.test.mjs
node tests/container-config.test.mjs
node tests/account-pool.test.mjs
```

Expected: all commands exit 0.

- [ ] **Step 2: Run the project test suite**

```bash
npm test
```

Expected: all existing translation, Gemini, and tools/search tests pass.

- [ ] **Step 3: Inspect the final diff and status**

```bash
git diff origin/main...HEAD --check
git status --short
git log --oneline -8
```

Expected: no whitespace errors; only the Issue #1 commits plus pre-existing untracked Docker files or user changes remain visible.

- [ ] **Step 4: Run a local health smoke test when dependencies are available**

Start with `AUTO_SESSION=false`, a temporary `PORT`, and a temporary `SAKANA_SESSION_FILE`, then request `/health` and `/api/stats`. Verify that health is 200, `ok` is true, memory values are numeric, and stats include `ops.browser` without any cookie/token values.

- [ ] **Step 5: Commit any verification-only corrections**

If verification requires a code correction, stage only the exact corrected paths, for example:

```bash
git add lib/auto-session.js server.js tests/auto-session-lifecycle.test.mjs tests/observability.test.mjs tests/container-config.test.mjs docker-entrypoint.sh docker-compose.yml
git commit -m "test: verify Issue #1 remediation"
```

Do not stage `session.json`, `account_pool.json`, `.browser-profile`, keys, or any other runtime secret/state file.
