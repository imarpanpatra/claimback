// Anakin REST client: URL Scraper, Search, Wire and the cloud browser.
// The scraper and read-only Wire actions also work without ANAKIN_API_KEY on
// Anakin's keyless tier; Search and the browser need a key.
import { chromium } from 'playwright-core';

const BASE = 'https://api.anakin.io/v1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hasKey = () => Boolean(process.env.ANAKIN_API_KEY);

async function call(method, path, body, timeoutMs = 130_000) {
  const headers = { 'Content-Type': 'application/json' };
  if (hasKey()) headers['X-API-Key'] = process.env.ANAKIN_API_KEY;

  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok && res.status !== 202) {
    const err = data.error;
    const message = typeof err === 'string' ? err : err?.message ?? data.message ?? res.statusText;
    throw new Error(`Anakin ${path} failed (${res.status}): ${message}`);
  }
  return data;
}

export async function scrape(url, { useBrowser = false, country } = {}) {
  let job = await call('POST', '/url-scraper/scrape', { url, useBrowser, ...(country && { country }) });
  const deadline = Date.now() + 150_000;
  while (job.status !== 'completed' && job.status !== 'failed') {
    if (Date.now() > deadline) throw new Error(`Scraping ${url} timed out`);
    await sleep(3000);
    job = await call('GET', `/url-scraper/${job.id}`);
  }
  if (job.status === 'failed') throw new Error(`Scraping ${url} failed: ${job.error ?? 'unknown error'}`);
  return { ...job, credits: job.cached ? 0 : 1 };
}

export async function search(prompt, limit = 6) {
  if (!hasKey()) throw new Error('Anakin Search needs ANAKIN_API_KEY');
  const data = await call('POST', '/search', { prompt, limit });
  return { results: data.results ?? [], credits: 3 };
}

// /wire-run is the synchronous mode for read-only actions. It takes the same
// body with or without a key; the key only lifts the keyless allowance.
export async function wire(actionId, params) {
  const job = await call('POST', '/wire-run', { action_id: actionId, params });
  if (job.status !== 'completed') {
    throw new Error(`Wire action ${actionId} ended as ${job.status}: ${job.error ?? 'no result'}`);
  }
  return { data: job.data, credits: job.credits_used ?? 0 };
}

// country routes the session through a residential exit there, so the airline
// shows the site a passenger in that country would see.
export async function openBrowser({ record = true, country } = {}) {
  if (!hasKey()) throw new Error('The Anakin cloud browser needs ANAKIN_API_KEY');
  const connect = (params) => chromium.connectOverCDP(
    `wss://api.anakin.io/v1/browser-connect?${new URLSearchParams(params)}`,
    { headers: { 'X-API-Key': process.env.ANAKIN_API_KEY }, timeout: 60_000 },
  );
  const base = record ? { record: 'true' } : {};
  const startedAt = Date.now();
  let browser;
  let exit = country ?? null;
  try {
    browser = await connect(country ? { ...base, country } : base);
  } catch (err) {
    if (!country) throw err;
    // An unsupported exit country shouldn't stop the claim.
    browser = await connect(base);
    exit = null;
  }
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page = context.pages()[0] ?? (await context.newPage());
  return { browser, page, startedAt, country: exit };
}

// Billing is 1 credit per started 2-minute window.
export const browserCredits = (startedAt) => Math.max(1, Math.ceil((Date.now() - startedAt) / 120_000));

// Recordings finalize a few seconds after disconnect, so poll for the newest
// one that started after this session did.
export async function findRecording(startedAt, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const list = await call('GET', '/recordings').catch(() => null);
    const items = Array.isArray(list) ? list : list?.recordings ?? list?.data ?? list?.items ?? [];
    const mine = items
      .filter((r) => new Date(r.createdAt).getTime() >= startedAt - 10_000)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
    if (mine?.status === 'completed') {
      return call('GET', `/recordings/${mine.connId ?? mine.id}`).catch(() => mine);
    }
    await sleep(4000);
  }
  return null;
}
