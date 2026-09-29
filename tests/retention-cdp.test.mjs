import assert from 'node:assert/strict';
import { CdpSession } from '../lib/cdp.js';

function mockSocket() {
  return {
    sent: [],
    send(payload) { this.sent.push(JSON.parse(payload)); },
    close() { this.onclose?.({ code: 1000, reason: '' }); },
    onmessage: null,
    onerror: null,
    onclose: null,
  };
}

{
  const ws = mockSocket();
  const session = new CdpSession(ws, { commandTimeoutMs: 1000 });
  const first = session.send('Runtime.enable');
  const second = session.send('Runtime.evaluate');
  assert.equal(session.pending.size, 2);
  ws.onerror(new Error('socket failed'));
  await assert.rejects(first, /socket failed/);
  await assert.rejects(second, /socket failed/);
  assert.equal(session.pending.size, 0);
  assert.equal(session.closed, true);
  await assert.rejects(session.send('after-close'), /CDP session closed/);
}

{
  const ws = mockSocket();
  const session = new CdpSession(ws, { commandTimeoutMs: 1000 });
  const pending = session.send('Network.getAllCookies');
  session.close();
  await assert.rejects(pending, /CDP session closed/);
  assert.equal(session.pending.size, 0);
}

console.log('cdp retention tests: all passed');
