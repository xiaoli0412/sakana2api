'use strict';

function abortCode(reason, fallback = 'REQUEST-ABORTED') {
  const raw = String(reason?.errorCode || reason?.code || reason?.name || '').toUpperCase();
  if (raw === 'SERVER-SHUTDOWN' || raw === 'ERR_SERVER_SHUTDOWN') return 'SERVER-SHUTDOWN';
  if (raw === 'REQUEST-TIMEOUT' || raw === 'TIMEOUT' || raw === 'TIMEOUTERROR') return 'REQUEST-TIMEOUT';
  if (raw === 'ABORT_ERR' || raw === 'ABORTERROR' || raw === 'REQUEST-ABORTED') return 'REQUEST-ABORTED';
  if (reason?.name === 'TimeoutError') return 'REQUEST-TIMEOUT';
  if (reason?.name === 'AbortError') return 'REQUEST-ABORTED';
  return fallback;
}

function abortError(reason, fallback = 'REQUEST-ABORTED') {
  const code = abortCode(reason, fallback);
  const message = code === 'SERVER-SHUTDOWN'
    ? 'server is shutting down'
    : (code === 'REQUEST-TIMEOUT' ? 'request timeout' : 'request aborted');
  const error = new Error(message);
  error.name = 'AbortError';
  error.code = code;
  error.errorCode = code;
  error.status = code === 'SERVER-SHUTDOWN' ? 503 : (code === 'REQUEST-TIMEOUT' ? 504 : 499);
  return error;
}

module.exports = { abortCode, abortError };
