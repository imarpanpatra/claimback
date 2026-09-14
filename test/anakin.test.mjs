// The Anakin client against a fake API and a fake browser, so nothing here
// spends credits or opens a real session.
import test from 'node:test';
import assert from 'node:assert/strict';
import { json } from './helpers.mjs';

process.env.ANAKIN_API_KEY = 'test';

let respond;
globalThis.fetch = async (url, options = {}) => respond(String(url), options);

const { chromium } = await import('playwright-core');
const { scrape, openBrowser } = await import('../lib/anakin.js');

test('a scrape that ends as cancelled fails at once and says so', { timeout: 30_000 }, async () => {
  respond = () => json({ id: 'job', status: 'cancelled', error: 'stopped by the service' });
  const started = Date.now();
  await assert.rejects(scrape('https://example.com/', { timeoutMs: 20_000 }), /cancelled/);
  assert.ok(Date.now() - started < 5000, 'it kept polling a job that had already ended');
});

test('a scrape stuck on an unknown status names it when it times out', { timeout: 30_000 }, async () => {
  respond = () => json({ id: 'job', status: 'throttled' });
  await assert.rejects(scrape('https://example.com/', { timeoutMs: 50 }), /throttled/);
});

test('a browser session is closed if its page fails to open', async () => {
  let closed = false;
  chromium.connectOverCDP = async () => ({
    contexts: () => [{
      pages: () => [],
      newPage: async () => {
        throw new Error('the page failed to open');
      },
    }],
    close: async () => {
      closed = true;
    },
  });
  await assert.rejects(openBrowser({ record: true }), /failed to open/);
  assert.equal(closed, true, 'the billed session was left open');
});
