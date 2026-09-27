import assert from 'node:assert/strict';
import {
  contentDelta, reasoningDelta, searchStarted, searchSource, fileOutput, finish, usage,
  TurnEventBuffer,
} from '../lib/events.js';

const buffer = new TurnEventBuffer({ maxSources: 2, maxFiles: 1 });
assert.equal(buffer.push(contentDelta('answer')), true);
assert.equal(buffer.push(reasoningDelta('thinking')), true);
assert.equal(buffer.push(searchStarted('sakana')), true);
assert.equal(buffer.push(searchSource({ title: 'Sakana', url: 'https://sakana.ai' })), true);
assert.equal(buffer.push(searchSource({ title: 'Sakana', url: 'https://sakana.ai' })), false);
assert.equal(buffer.push(searchSource({ title: 'Other', url: 'https://example.com' })), true);
assert.equal(buffer.push(searchSource({ title: 'Overflow', url: 'https://overflow.test' })), false);
assert.equal(buffer.push(fileOutput({ name: 'result.txt', sha: 'abc', mime: 'text/plain' })), true);
assert.equal(buffer.push(fileOutput({ name: 'second.txt', sha: 'def', mime: 'text/plain' })), false);
assert.equal(buffer.push(finish('stop')), true);
assert.equal(buffer.push(finish('tool_calls')), false);
assert.equal(buffer.push(usage({ prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 })), true);
assert.equal(buffer.push(usage({ prompt_tokens: 9 })), false);

const snapshot = buffer.snapshot();
assert.equal(snapshot.sources.length, 2);
assert.equal(snapshot.files.length, 1);
assert.equal(snapshot.finished, true);
const chunks = buffer.toOpenAiChunks({ id: 'chatcmpl-test', model: 'sakana-namazu' });
assert.equal(chunks.filter((chunk) => chunk.choices?.length === 0).length, 1);
assert.equal(chunks.at(-1).usage.total_tokens, 5);
assert.equal(chunks.find((chunk) => chunk.choices?.[0]?.delta?.reasoning_content)?.choices[0].delta.reasoning_content, 'thinking');
assert.equal(chunks.find((chunk) => chunk.choices?.[0]?.finish_reason)?.choices[0].finish_reason, 'stop');
console.log('events tests: all passed');
