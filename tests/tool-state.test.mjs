import assert from 'node:assert/strict';
import { ToolCallState } from '../lib/tool-state.js';

const state = new ToolCallState();
state.start({ id: 'call-1', index: 1, name: 'weather' });
state.append('call-1', '{"city":"');
state.append('call-1', 'Tokyo"}');
state.start({ id: 'call-2', index: 0, name: 'stock', arguments: '{"symbol":"SAK"}' });
state.end('call-1');
state.end('call-2');
const calls = state.values();
assert.equal(calls.length, 2);
assert.equal(calls[0].id, 'call-1');
assert.equal(calls[0].arguments, '{"city":"Tokyo"}');
assert.equal(calls[1].name, 'stock');
assert.equal(calls[1].arguments, '{"symbol":"SAK"}');
assert.equal(state.get('call-1').done, undefined);
console.log('tool-state tests: all passed');
