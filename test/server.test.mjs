// Runs the real server.js with a stub agent, so nothing here spends credits.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sleep, startServer } from './helpers.mjs';

const day = 86_400_000;
const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);
const recent = isoDate(Date.now() - 3 * day);
const valid = { code: 'secret', flightNumber: 'AI162', date: recent, passenger: {} };

async function post(url, body, raw) {
  const res = await fetch(`${url}/api/runs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: raw ?? JSON.stringify(body) });
  return { status: res.status, body: await res.text() };
}

async function readEvents(url, id, from) {
  const text = await (await fetch(`${url}/api/runs/${id}/events${from ? `?from=${from}` : ''}`)).text();
  return text.split('\n\n').filter((chunk) => chunk.startsWith('data: ')).map((chunk) => JSON.parse(chunk.slice(6)));
}

test('a request with passenger: null does not jam live runs', async (t) => {
  const server = await startServer({ STUB_MS: '300' });
  t.after(server.stop);
  const first = await post(server.url, { ...valid, passenger: null });
  assert.equal(first.status, 202, first.body);
  await sleep(1200);
  const next = await post(server.url, valid);
  assert.equal(next.status, 202, next.body);
});

test('the date must be a real date within the last 14 days', async (t) => {
  const server = await startServer({ STUB_MS: '200' });
  t.after(server.stop);
  const bad = [['2026-09-09'], isoDate(Date.now() - 30 * day), isoDate(Date.now() + 3 * day), '2026-13-45'];
  for (const date of bad) {
    const res = await post(server.url, { ...valid, date });
    assert.equal(res.status, 400, `${JSON.stringify(date)} gave ${res.status} ${res.body}`);
  }
});

test('malformed JSON gets a short error without a stack trace', async (t) => {
  const server = await startServer();
  t.after(server.stop);
  const res = await post(server.url, null, '{"code":');
  assert.equal(res.status, 400);
  assert.equal(/\n\s+at |node_modules/.test(res.body), false, res.body);
});

async function postFrom(url, ip, body) {
  const res = await fetch(`${url}/api/runs`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.text() };
}

test('a run that goes over the time limit is closed and frees the slot', async (t) => {
  const server = await startServer({ STUB_MS: '5000', STUB_TICKS: '5', RUN_TIMEOUT_MS: '800' });
  t.after(server.stop);
  const { id } = JSON.parse((await post(server.url, valid)).body);
  await sleep(1500);
  const events = await readEvents(server.url, id, 0);
  assert.ok(events.some((e) => e.type === 'error' && /limit/.test(e.message)), JSON.stringify(events));
  assert.equal(events.at(-1).type, 'end');
  const next = await post(server.url, valid);
  assert.equal(next.status, 202, next.body);
});

test('wrong access codes are limited per visitor, and a pasted code with spaces still works', async (t) => {
  const server = await startServer({ STUB_MS: '200' });
  t.after(server.stop);
  for (let i = 0; i < 20; i++) {
    assert.equal((await postFrom(server.url, '203.0.113.7', { ...valid, code: `guess-${i}` })).status, 403);
  }
  const locked = await postFrom(server.url, '203.0.113.7', valid);
  assert.equal(locked.status, 429, locked.body);
  const other = await postFrom(server.url, '203.0.113.8', { ...valid, code: '  secret\n' });
  assert.equal(other.status, 202, other.body);
});

test('events are numbered so a dropped stream can resume where it left off', async (t) => {
  const server = await startServer({ STUB_MS: '500' });
  t.after(server.stop);
  const { id } = JSON.parse((await post(server.url, valid)).body);
  await sleep(1500);
  const all = await readEvents(server.url, id, 0);
  assert.ok(all.length > 4);
  assert.deepEqual(all.map((e) => e.seq), all.map((_, i) => i));
  const resumed = await readEvents(server.url, id, 3);
  assert.deepEqual(resumed.map((e) => e.seq), all.slice(3).map((e) => e.seq));
});
