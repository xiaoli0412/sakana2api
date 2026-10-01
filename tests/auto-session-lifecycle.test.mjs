import assert from 'node:assert/strict';

const { autoSession } = (await import('../lib/auto-session.js')).default;

function fakeContext() {
  const listeners = new Map();
  const browserListeners = new Map();
  let pages = [];
  let closed = false;
  const browser = {
    on(event, fn) {
      browserListeners.set(event, fn);
      return browser;
    },
    emit(event, ...args) {
      browserListeners.get(event)?.(...args);
    },
  };
  const context = {
    pages: () => pages,
    newPage: async () => {
      const page = {};
      pages = [...pages, page];
      return page;
    },
    browser: () => browser,
    on(event, fn) {
      listeners.set(event, fn);
      return context;
    },
    emit(event, ...args) {
      listeners.get(event)?.(...args);
    },
    close: async () => {
      if (closed) return;
      closed = true;
      listeners.get('close')?.();
    },
    get closed() {
      return closed;
    },
  };
  return context;
}

let launches = 0;
const contexts = [];
autoSession.__testing.reset();
autoSession.__testing.setLauncher(async () => {
  launches++;
  const ctx = fakeContext();
  contexts.push(ctx);
  return ctx;
});

const [first, second] = await Promise.all([
  autoSession.__testing.ensureBrowser(),
  autoSession.__testing.ensureBrowser(),
]);
assert.strictEqual(first, second, 'concurrent ensureBrowser calls share one context');
assert.equal(launches, 1, 'concurrent ensureBrowser calls launch once');
assert.equal(autoSession.__testing.status().pageCount, 0, 'empty context is reusable');

contexts[0].emit('close');
assert.equal(autoSession.__testing.status().hasContext, false, 'close clears cached context');
const replacement = await autoSession.__testing.ensureBrowser();
assert.notStrictEqual(replacement, first, 'closed context is replaced');
assert.equal(launches, 2, 'replacement launches once');
contexts[1].browser().emit('disconnected');
assert.equal(autoSession.__testing.status().hasContext, false, 'disconnect clears cached context');

const crashContexts = [];
let crashAttempts = 0;
autoSession.__testing.reset();
autoSession.__testing.setWait(async () => {});
autoSession.__testing.setLauncher(async () => {
  crashAttempts++;
  const ctx = fakeContext();
  const page = {
    async goto() {
      if (crashAttempts === 1) throw new Error('Target crashed');
      return undefined;
    },
  };
  await ctx.newPage();
  ctx.pages = () => [page];
  crashContexts.push(ctx);
  return ctx;
});
const recovered = await autoSession.__testing.withBrowserRecovery(async () => {
  const ctx = await autoSession.__testing.ensureBrowser();
  await ctx.pages()[0].goto('https://example.test');
  return 'ok';
});
assert.equal(recovered, 'ok', 'crashed browser operation recovers');
assert.equal(crashContexts[0].closed, true, 'failed context is closed');
assert.equal(autoSession.__testing.status().recoveries, 1, 'recovery count increments');
assert.equal(crashAttempts, 2, 'recovery launches one replacement');

let exhausted = 0;
autoSession.__testing.reset();
autoSession.__testing.setLauncher(async () => {
  exhausted++;
  const ctx = fakeContext();
  const page = { async goto() { throw new Error('Target crashed'); } };
  await ctx.newPage();
  ctx.pages = () => [page];
  return ctx;
});
await assert.rejects(
  () => autoSession.__testing.withBrowserRecovery(async () => {
    const ctx = await autoSession.__testing.ensureBrowser();
    await ctx.pages()[0].goto('https://example.test');
  }),
  /Target crashed/,
);
assert.equal(exhausted, 3, 'recovery stops after the configured attempts');

// A stop can race an isolated chromium launch. The launch promise itself is
// not cancelable, so a browser resolving after stop must still be closed.
let resolveIsolatedLaunch;
let lateBrowserCloseCount = 0;
autoSession.__testing.reset();
autoSession.__testing.setIsolatedLauncher(() => new Promise((resolve) => {
  resolveIsolatedLaunch = resolve;
}));
const pendingIsolatedHarvest = autoSession.harvestFreshIsolated();
await new Promise((resolve) => setImmediate(resolve));
await autoSession.stop();
await assert.rejects(() => pendingIsolatedHarvest, /auto-session stopped/);
resolveIsolatedLaunch({
  async close() { lateBrowserCloseCount++; },
});
await new Promise((resolve) => setImmediate(resolve));
assert.equal(lateBrowserCloseCount, 1, 'late isolated browser launch is closed after stop');

autoSession.__testing.setIsolatedLauncher(null);
autoSession.__testing.setLauncher(null);
autoSession.__testing.setWait(null);
await autoSession.stop();
await autoSession.stop();
assert.equal(autoSession.__testing.status().hasContext, false, 'stop is idempotent');
await autoSession.__testing.reset();

console.log('auto-session crash recovery tests: all passed');
