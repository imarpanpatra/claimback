// Builds the demo video from the featured run: a title card, the run replaying
// in the app, the Anakin cloud-browser recording, and an end card.
//   node scripts/record-demo.js        ->  recordings/claimback-demo.mp4
// Needs ffmpeg and ffprobe on PATH and a local Chromium (CHROME_PATH, or
// Playwright's downloaded browsers). Set DEMO_URL to show the live link.
import { chromium } from 'playwright-core';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';

const PORT = 7870;
const SIZE = { width: 1280, height: 720 };
const OUT = 'recordings';
const ANAKIN_CLIP = path.join(OUT, 'anakin-session.webm');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findChromium() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const root = path.join(process.env.LOCALAPPDATA ?? '', 'ms-playwright');
  const dirs = existsSync(root) ? readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse() : [];
  for (const dir of dirs) {
    for (const sub of ['chrome-win64', 'chrome-win']) {
      const exe = path.join(root, dir, sub, 'chrome.exe');
      if (existsSync(exe)) return exe;
    }
  }
  throw new Error('No local Chromium found. Set CHROME_PATH.');
}

function durationOf(file) {
  const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' });
  return Number(probe.stdout?.trim()) || 0;
}

const card = (title, lead, lines = []) => `<!doctype html><html><body style="margin:0;height:100vh;display:grid;place-items:center;
  background:radial-gradient(900px 500px at 80% -10%,#1a2750,transparent 60%),#0a0f1c;color:#e9edf5;font-family:'Segoe UI',system-ui,sans-serif">
  <div style="text-align:center;max-width:1000px;padding:0 48px">
    <div style="font-size:68px;font-weight:800;letter-spacing:-0.03em">${title}</div>
    <div style="margin-top:20px;font-size:32px;font-weight:600;color:#43d99a">${lead}</div>
    ${lines.map((l) => `<div style="margin-top:12px;font-size:22px;color:#98a3ba">${l}</div>`).join('')}
  </div></body></html>`;

async function segment(browser, record) {
  const context = await browser.newContext({ viewport: SIZE, recordVideo: { dir: path.join(OUT, 'raw'), size: SIZE } });
  const page = await context.newPage();
  await record(page);
  const video = page.video();
  await context.close();
  return video.path();
}

async function startServer() {
  const server = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) {
    const up = await fetch(`http://localhost:${PORT}/api/config`).then(() => true, () => false);
    if (up) return server;
    await sleep(250);
  }
  server.kill();
  throw new Error('The server did not start.');
}

const featured = JSON.parse(await readFile('public/demo/featured-run.json', 'utf8'));
const models = featured.events.find((e) => e.type === 'result')?.claim.models ?? [];

await rm(path.join(OUT, 'raw'), { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
const server = await startServer();
const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
// Very short recordings add nothing the in-app screenshots don't already show.
const hasClip = existsSync(ANAKIN_CLIP) && durationOf(ANAKIN_CLIP) >= 3;

try {
  const title = await segment(browser, async (page) => {
    await page.setContent(card('Claimback', 'Your flight was late. The airline owes you.', [
      'An AI agent that reads live flight data and the law, works out what you’re owed, and fills in the claim form.',
      `Built for Anakin Forge 2026 with Anakin Wire, URL Scraper, Search and Browser API${models.length ? `. Reasoning by ${models.join(' and ')}` : ''}.`,
    ]));
    await sleep(7000);
  });

  const app = await segment(browser, async (page) => {
    await page.goto(`http://localhost:${PORT}/?autoplay&pace=2.5`);
    await page.waitForFunction(
      () => document.querySelector('#result')?.children.length > 0 && !document.querySelector('#watch-replay')?.disabled,
      null,
      { timeout: 8 * 60_000, polling: 500 },
    );
    await sleep(7000);
    // A slow scroll back through the whole run as a recap.
    await page.evaluate(() => window.scrollTo({ top: 0 }));
    await sleep(1500);
    for (let i = 0; i < 24; i++) {
      await page.evaluate(() => window.scrollBy({ top: Math.ceil(document.body.scrollHeight / 24), behavior: 'smooth' }));
      await sleep(650);
    }
    await sleep(2500);
  });

  const clipCard = hasClip && (await segment(browser, async (page) => {
    await page.setContent(card('Inside Anakin’s cloud browser', 'Filling in Air India’s claim form', ['The real recorded session from this run. It stops at Submit.']));
    await sleep(4000);
  }));

  const end = await segment(browser, async (page) => {
    await page.setContent(card('Claimback', 'github.com/imarpanpatra/claimback', [
      process.env.DEMO_URL ? `Try it: ${process.env.DEMO_URL}` : '',
      'Not legal advice. Claimback never submits a claim for you.',
    ].filter(Boolean)));
    await sleep(6000);
  });

  const parts = [title, app, ...(hasClip ? [clipCard, ANAKIN_CLIP] : []), end];
  const filters = parts.map((file, i) => {
    const cap = file === ANAKIN_CLIP ? ',trim=duration=40,setpts=PTS-STARTPTS' : '';
    return `[${i}:v]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=0x0a0f1c,fps=30,format=yuv420p,setsar=1${cap}[v${i}]`;
  });
  const concat = `${parts.map((_, i) => `[v${i}]`).join('')}concat=n=${parts.length}:v=1:a=0[out]`;
  const output = path.join(OUT, 'claimback-demo.mp4');
  const args = ['-y', '-loglevel', 'error', ...parts.flatMap((f) => ['-i', f]), '-filter_complex', `${filters.join(';')};${concat}`,
    '-map', '[out]', '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-movflags', '+faststart', output];
  const result = spawnSync('ffmpeg', args, { stdio: 'inherit' });
  if (result.status !== 0) throw new Error('ffmpeg failed');
  console.log(`Wrote ${output} (${durationOf(output).toFixed(0)} s)${hasClip ? '' : ', without the cloud-browser clip'}`);
} finally {
  await browser.close();
  server.kill();
}
