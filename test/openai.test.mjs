// The OpenAI client against a fake API.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.OPENAI_API_KEY = 'test';
delete process.env.OPENAI_MODEL;

let calls = 0;
globalThis.fetch = async () => {
  calls += 1;
  throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
};

const { askJson } = await import('../lib/openai.js');

test('a timeout hands over to the next provider instead of waiting twice more', async () => {
  const schema = { type: 'object', properties: { ok: { type: 'boolean' } } };
  await assert.rejects(askJson({ system: 's', prompt: 'p', schema }), /timed out/);
  assert.equal(calls, 1);
});
