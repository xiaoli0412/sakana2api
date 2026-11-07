'use strict';
// Small HTTP primitives shared by server.js and the extracted route modules.
// Moved verbatim from server.js (P2 split): behavior must stay byte-identical.
const { abortError } = require('./abort');

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req, limit = 32 * 1024 * 1024) {
  const signal = req?.__signal;
  const declared = Number(req?.headers?.['content-length']);
  if (Number.isFinite(declared) && declared > limit) {
    const error = new Error(`request body exceeds ${limit} bytes`);
    error.code = 'BODY_TOO_LARGE';
    error.status = 413;
    req.resume?.();
    return Promise.reject(error);
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const cleanup = () => {
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
      req.removeListener('aborted', onAborted);
      req.removeListener('close', onClose);
      signal?.removeEventListener?.('abort', onSignalAbort);
    };
    const settle = (error, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      req.__bodyBytes = size;
      if (error) {
        chunks.length = 0;
        reject(error);
      } else {
        resolve(value);
      }
    };
    const abort = (reason) => abortError(reason);
    const onData = (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        const error = new Error(`request body exceeds ${limit} bytes`);
        error.code = 'BODY_TOO_LARGE';
        settle(error);
        req.resume();
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => settle(null, Buffer.concat(chunks));
    const onError = (error) => settle(error);
    const onAborted = () => settle(abort());
    const onClose = () => {
      if (!req.complete) settle(abort());
    };
    const onSignalAbort = () => {
      settle(abort(signal.reason));
      req.resume?.();
    };
    if (signal?.aborted) {
      onSignalAbort();
      req.resume?.();
      return;
    }
    req.on('data', onData);
    req.once('end', onEnd);
    req.once('error', onError);
    req.once('aborted', onAborted);
    req.once('close', onClose);
    signal?.addEventListener?.('abort', onSignalAbort, { once: true });
  });
}

module.exports = { sendJson, readBody };