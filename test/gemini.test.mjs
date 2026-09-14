import test from 'node:test';
import assert from 'node:assert/strict';
import { geminiReply, json } from './helpers.mjs';

process.env.GEMINI_API_KEY = 'test';
delete process.env.GEMINI_MODEL;

let respond;
let calls = [];
globalThis.fetch = async (url) => {
  const model = String(url).match(/models\/([^:]+):/)[1];
  calls.push(model);
  return respond(model);
};

const { askJson } = await import('../lib/gemini.js');
const ask = () => askJson({ system: 's', prompt: 'p', schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] } });

test('a retired fallback model is skipped instead of ending the chain', async () => {
  calls = [];
  respond = (model) => {
    if (model === 'gemini-3.8-flash') return json({ error: { message: 'You exceeded your current quota, please check your plan and billing details.' } }, 429);
    if (model === 'gemini-3.7-flash') return json({ error: { message: 'models/gemini-3.7-flash is not found for API version v1beta' } }, 404);
    return geminiReply({ ok: true });
  };
  const { answer, model } = await ask();
  assert.deepEqual(answer, { ok: true });
  assert.equal(model, 'gemini-3.6-flash');
  assert.deepEqual(calls, ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.6-flash']);
});

test('a rejected API key stops straight away', async () => {
  calls = [];
  respond = () => json({ error: { message: 'API key not valid.' } }, 403);
  await assert.rejects(ask, /403/);
  assert.equal(calls.length, 1);
});

test('an invalid API key, which Google reports as a 400, also stops straight away', async () => {
  calls = [];
  respond = () => json({ error: { message: 'API key not valid. Please pass a valid API key.' } }, 400);
  await assert.rejects(ask, /400/);
  assert.equal(calls.length, 1);
});

test('a model that rejects a setting is skipped for the next one', async () => {
  calls = [];
  respond = (model) => (model === 'gemini-3.8-flash'
    ? json({ error: { message: 'Thinking level is not supported for this model.' } }, 400)
    : geminiReply({ ok: true }));
  const { model } = await ask();
  assert.equal(model, 'gemini-3.7-flash');
  assert.deepEqual(calls, ['gemini-3.8-flash', 'gemini-3.7-flash']);
});

test('blocked answers from every model give up quickly instead of retrying each one', async () => {
  calls = [];
  respond = () => json({ promptFeedback: { blockReason: 'SAFETY' } });
  const started = Date.now();
  await assert.rejects(ask, /no answer/);
  assert.equal(calls.length, 5);
  assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms`);
});

test('an answer that is not valid JSON moves on to the next model', async () => {
  calls = [];
  respond = (model) => (model === 'gemini-3.8-flash'
    ? json({ candidates: [{ content: { parts: [{ text: '{"ok": tr' }] }, finishReason: 'MAX_TOKENS' }] })
    : geminiReply({ ok: true }));
  const { model } = await ask();
  assert.equal(model, 'gemini-3.7-flash');
  assert.deepEqual(calls, ['gemini-3.8-flash', 'gemini-3.7-flash']);
});
