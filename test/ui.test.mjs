// The web page in local Chrome: on a static host, and against the real server
// running a stub agent. Nothing here spends credits.
import test from 'node:test';
import assert from 'node:assert/strict';
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

async function staticPage(t, viewport = { width: 1280, height: 800 }, query = '') {
  const site = await serveStatic(path.join(ROOT, 'public'));
  t.after(site.close);
  const page = await browser.newPage({ viewport });
  t.after(() => page.close());
  await page.goto(`${site.url}/${query}`);
  return page;
}

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

test('a live run that loses its server says so instead of freezing', { skip }, async (t) => {
  const server = await startServer({ STUB_MS: '10000', STUB_TICKS: '10' });
  t.after(server.stop);
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.goto(server.url);
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
