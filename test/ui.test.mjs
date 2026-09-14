// The web page in local Chrome: on a static host, and against the real server
// running a stub agent. Nothing here spends credits.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, findChromium, serveStatic, startServer } from './helpers.mjs';

const chromePath = findChromium();
const skip = chromePath ? false : 'no local Chromium found (set CHROME_PATH)';

let browser;
test.before(async () => {
  if (!chromePath) return;
  const { chromium } = await import('playwright-core');
  browser = await chromium.launch({ executablePath: chromePath, headless: true });
});
test.after(async () => {
  await browser?.close();
});

async function openPage(t, url, { viewport = { width: 1280, height: 800 }, init } = {}) {
  const page = await browser.newPage({ viewport });
  t.after(() => page.close());
  if (init) await page.addInitScript(init);
  await page.goto(url);
  return page;
}

async function staticPage(t, viewport, query = '') {
  const site = await serveStatic(path.join(ROOT, 'public'));
  t.after(site.close);
  return openPage(t, `${site.url}/${query}`, { viewport });
}

// A copy of the site with its own recorded run, for replays built to trip the page up.
async function siteWithRun(t, run) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'claimback-site-'));
  cpSync(path.join(ROOT, 'public'), dir, { recursive: true });
  writeFileSync(path.join(dir, 'demo', 'featured-run.json'), typeof run === 'string' ? run : JSON.stringify(run));
  const site = await serveStatic(dir);
  t.after(async () => {
    await site.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return site;
}

const TRICKY_RUN = {
  input: { flightNumber: 'AI162', date: '2026-09-09' },
  events: [
    { type: 'step', id: 'law', phase: 'reason', title: 'Read the law', t: 0 },
    { type: 'source', step: 'law', url: 'javascript:alert(1)', title: 'A search result', quote: 'Quoted text', verified: null, t: 10 },
    { type: 'letter', step: 'law', subject: 'Claim', body: 'Letter body', t: 20 },
    {
      type: 'result',
      t: 30,
      claim: { verdict: 'owed', amountText: '£520', reducedText: null, regimeName: 'UK Regulation 261/2004', reasons: ['Owed.'], flight: null, models: ['recorded-model'], filing: { url: 'javascript:alert(2)', reason: 'Stopped at the submit button.' } },
    },
    { type: 'end', t: 40 },
  ],
};

test('the date field only offers the last 14 days', { skip }, async (t) => {
  const page = await staticPage(t);
  const state = await page.evaluate(() => {
    const localIso = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
    const input = document.querySelector('[name=date]');
    return { min: input.min, max: input.max, value: input.value, today: localIso(new Date()), earliest: localIso(new Date(Date.now() - 14 * 86_400_000)) };
  });
  assert.equal(state.max, state.today);
  assert.equal(state.min, state.earliest);
  assert.ok(!state.value || state.value >= state.min, `the default date ${state.value} is older than ${state.min}`);
});

test('the side panel fits a 720px-tall screen', { skip }, async (t) => {
  const page = await staticPage(t, { width: 1280, height: 720 });
  const { height, viewport } = await page.evaluate(() => ({ height: document.querySelector('.panel').getBoundingClientRect().height, viewport: innerHeight }));
  assert.ok(height <= viewport - 16, `the panel is ${Math.round(height)}px tall in a ${viewport}px window`);
});

test('the recorded run still replays on a static host', { skip }, async (t) => {
  const page = await staticPage(t, undefined, '?autoplay&pace=0.25');
  await page.waitForSelector('.result .amount', { timeout: 60_000 });
  assert.equal(await page.textContent('.result .amount'), '£260–£520');
  assert.equal(await page.isDisabled('#run-live'), true);
});

test('a recorded run that fails to load says so and frees the buttons', { skip }, async (t) => {
  const site = await siteWithRun(t, '{"input": broken');
  const page = await openPage(t, `${site.url}/`);
  await page.click('#watch-replay');
  await page.waitForSelector('.error', { timeout: 10_000 });
  assert.equal(await page.isDisabled('#watch-replay'), false);
});

test('links from search results only ever open web pages', { skip }, async (t) => {
  const site = await siteWithRun(t, TRICKY_RUN);
  const page = await openPage(t, `${site.url}/?autoplay&pace=0.25`);
  await page.waitForSelector('.result', { timeout: 20_000 });
  const scriptLinks = await page.$$eval('a', (links) => links.filter((a) => a.protocol === 'javascript:').length);
  assert.equal(scriptLinks, 0);
});

test('the copy button says so when copying fails', { skip }, async (t) => {
  const site = await siteWithRun(t, TRICKY_RUN);
  const page = await openPage(t, `${site.url}/?autoplay&pace=0.25`, {
    init: () => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.reject(new Error('denied')) } }),
  });
  await page.waitForSelector('.result', { timeout: 20_000 });
  await page.click('.letter button');
  await page.waitForFunction(() => document.querySelector('.letter button').textContent !== 'Copy letter');
  assert.notEqual(await page.textContent('.letter button'), 'Copied');
});

test('the model label goes back to the configured one when a new run starts', { skip }, async (t) => {
  const site = await siteWithRun(t, TRICKY_RUN);
  const page = await openPage(t, `${site.url}/?autoplay&pace=0.25`);
  await page.waitForSelector('.result', { timeout: 20_000 });
  await page.waitForFunction(() => !document.querySelector('#watch-replay').disabled);
  assert.match(await page.textContent('#model'), /recorded-model/);
  await page.click('#watch-replay');
  assert.doesNotMatch(await page.textContent('#model'), /recorded-model/);
});

test('a live run that loses its server says so instead of freezing', { skip }, async (t) => {
  const server = await startServer({ STUB_MS: '10000', STUB_TICKS: '10' });
  t.after(server.stop);
  const page = await openPage(t, server.url);
  const recent = await page.evaluate(() => {
    const d = new Date(Date.now() - 2 * 86_400_000);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
  });
  await page.fill('[name=flightNumber]', 'AI162');
  await page.fill('[name=date]', recent);
  await page.fill('[name=code]', 'secret');
  await page.click('#run-live');
  await page.waitForSelector('text=tick 0', { timeout: 15_000 });
  await server.stop();
  await page.waitForSelector('.error', { timeout: 30_000 });
  assert.equal(await page.isDisabled('#watch-replay'), false);
});
