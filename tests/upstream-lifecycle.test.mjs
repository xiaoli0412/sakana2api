import assert from 'node:assert/strict';
import {
  closeGlobalDispatcher,
  readLimitedBuffer,
  SakanaUpstream,
  UpstreamError,
} from '../lib/upstream.js';

const nativeFetch = globalThis.fetch;
const upstream = new SakanaUpstream(() => ({ ua: 'upstream-lifecycle-test', cookieHeader: '' }));

function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

function trackedResponse({ body, status = 200, headers = {} }) {
  const response = new Response(body, { status, headers });
  const state = {
    bodyCancelCalls: 0,
    readerCancelCalls: 0,
  };
  const responseBody = response.body;
  const bodyCancel = responseBody?.cancel?.bind(responseBody);
  const getReader = responseBody?.getReader?.bind(responseBody);
  if (bodyCancel) {
    responseBody.cancel = async (...args) => {
      state.bodyCancelCalls++;
      return bodyCancel(...args);
    };
  }
  if (getReader) {
    responseBody.getReader = (...args) => {
      const reader = getReader(...args);
      const readerCancel = reader.cancel.bind(reader);
      reader.cancel = async (...cancelArgs) => {
        state.readerCancelCalls++;
        return readerCancel(...cancelArgs);
      };
      return reader;
    };
  }
  return { response, state };
}

function neverEndingStream(state) {
  return new ReadableStream({
    cancel() {
      state.sourceCancelCalls++;
    },
  });
}

function chunkedStream(chunks, state) {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(Uint8Array.from(chunk));
      controller.close();
    },
    cancel() {
      state.sourceCancelCalls++;
    },
  });
}

function installFetch(handler) {
  globalThis.fetch = async (...args) => handler(...args);
}

function abortReason(code) {
  return Object.assign(new Error(code), { code });
}

function partialReadResponse() {
  const secondReadStarted = deferred();
  let releasePendingRead;
  let pullCount = 0;
  const state = {
    cancelCalls: 0,
    cancelReasons: [],
  };
  const stream = new ReadableStream({
    pull(controller) {
      pullCount++;
      if (pullCount === 1) {
        controller.enqueue(Uint8Array.from([1, 2, 3]));
        return;
      }
      secondReadStarted.resolve();
      return new Promise((resolve) => { releasePendingRead = resolve; });
    },
    cancel(reason) {
      state.cancelCalls++;
      state.cancelReasons.push(reason);
      releasePendingRead?.();
    },
  });
  const response = new Response(stream, {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
  return { response, secondReadStarted: secondReadStarted.promise, state };
}

async function assertBodyTooLarge(promise, message) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof UpstreamError, message);
    assert.equal(error.status, 413, message);
    assert.equal(error.errorCode, 'BODY_TOO_LARGE', message);
    return true;
  });
}

async function assertFetchTextAbort(reasonCode, expectedErrorCode, expectedStatus) {
  const pending = partialReadResponse();
  installFetch(async () => pending.response);
  const controller = new AbortController();
  const request = upstream.fetchText('/partial-read', { method: 'GET' }, 10_000, controller.signal);
  await pending.secondReadStarted;
  controller.abort(abortReason(reasonCode));

  await assert.rejects(request, (error) => {
    assert.ok(error instanceof UpstreamError);
    assert.equal(error.errorCode, expectedErrorCode);
    assert.equal(error.status, expectedStatus);
    return true;
  });
  assert.ok(pending.state.cancelCalls >= 1, `${reasonCode}: partial reader is canceled`);
  assert.ok(
    pending.state.cancelReasons.some((reason) => reason?.code === reasonCode),
    `${reasonCode}: abort reason reaches the reader`,
  );
}

try {
  {
    const sourceState = { sourceCancelCalls: 0 };
    const response = trackedResponse({
      body: neverEndingStream(sourceState),
      headers: { 'content-length': '11' },
    });
    await assertBodyTooLarge(
      readLimitedBuffer(response.response, 10),
      'declared oversized response is rejected',
    );
    assert.equal(response.state.bodyCancelCalls, 1, 'declared oversized response body is canceled');
    assert.equal(sourceState.sourceCancelCalls, 1, 'declared oversized stream is canceled at the source');
  }

  {
    const sourceState = { sourceCancelCalls: 0 };
    const response = trackedResponse({
      body: chunkedStream([[1, 2, 3], [4, 5, 6]], sourceState),
    });
    await assertBodyTooLarge(
      readLimitedBuffer(response.response, 5),
      'chunked oversized response is rejected',
    );
    assert.ok(response.state.readerCancelCalls >= 1, 'chunked oversized reader is canceled');
  }

  await assertFetchTextAbort('REQUEST-ABORTED', 'REQUEST-ABORTED', 499);
  await assertFetchTextAbort('REQUEST-TIMEOUT', 'UPSTREAM-TIMEOUT', 504);
  await assertFetchTextAbort('SERVER-SHUTDOWN', 'SERVER-SHUTDOWN', 503);

  {
    const sourceState = { sourceCancelCalls: 0 };
    const response = trackedResponse({
      body: neverEndingStream(sourceState),
      status: 403,
      headers: { 'content-type': 'text/html; challenge' },
    });
    installFetch(async () => response.response);
    await assert.rejects(
      upstream.fetchText('/cloudflare', { method: 'GET' }),
      (error) => {
        assert.ok(error instanceof UpstreamError);
        assert.equal(error.status, 403);
        assert.equal(error.errorCode, 'CF-403');
        return true;
      },
    );
    assert.equal(response.state.bodyCancelCalls, 1, 'Cloudflare challenge body is canceled');
    assert.equal(sourceState.sourceCancelCalls, 1, 'Cloudflare challenge stream is canceled at the source');
  }

  {
    const sourceState = { sourceCancelCalls: 0 };
    const response = trackedResponse({
      body: chunkedStream([[123, 34, 101, 114, 114, 111, 114, 34, 58, 34, 110, 111, 34, 125]], sourceState),
      status: 502,
      headers: { 'content-type': 'application/json' },
    });
    installFetch(async () => response.response);
    await assert.rejects(
      upstream.fetchText('/non-2xx', { method: 'GET' }),
      (error) => {
        assert.ok(error instanceof UpstreamError);
        assert.equal(error.status, 502);
        assert.equal(error.errorCode, 'UPSTREAM-ERROR');
        return true;
      },
    );
    assert.ok(response.state.readerCancelCalls >= 1, 'non-2xx response reader is canceled');
  }

  {
    const sourceState = { sourceCancelCalls: 0 };
    const response = trackedResponse({
      body: chunkedStream([[111, 107]], sourceState),
      headers: { 'content-length': '2' },
    });
    const result = await readLimitedBuffer(response.response, 10);
    assert.deepEqual(result, Buffer.from('ok'));
    assert.equal(response.state.readerCancelCalls, 1, 'bounded successful read cancels its reader');
  }

  await assert.doesNotReject(() => closeGlobalDispatcher());
  await assert.doesNotReject(() => closeGlobalDispatcher());
  await assert.doesNotReject(() => closeGlobalDispatcher());

  console.log('upstream lifecycle tests: all passed');
} finally {
  globalThis.fetch = nativeFetch;
  await closeGlobalDispatcher();
}
