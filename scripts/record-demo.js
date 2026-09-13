// Builds the narrated demo video from the featured run: a title card, the run
// replaying in the app, a recap, the Anakin cloud-browser recording and an end
// card, with a voiceover from scripts/narration.json.
//   node scripts/record-demo.js             record everything, then mix
//   node scripts/record-demo.js --mix-only  re-mix the last recording
// Output: recordings/claimback-demo.mp4
// Needs ffmpeg and ffprobe, the edge-tts command (pip install edge-tts), and a
// local Chromium (CHROME_PATH, or Playwright's downloaded browsers).
// Set DEMO_URL to show the recorded-run link on the end card.
import { chromium } from 'playwright-core';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const PORT = 7870;
const SIZE = { width: 1280, height: 720 };
const OUT = 'recordings';
const VOICE_DIR = path.join(OUT, 'narration');
const MANIFEST = path.join(VOICE_DIR, 'mix.json');
const ANAKIN_CLIP = path.join(OUT, 'anakin-session.webm');
const MAX_CLIP_S = 40;
const LEAD_MS = 400; // a line starts just after its part appears
const TAIL_MS = 900; // and the picture holds briefly after the line ends
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

function speak(key, text, { voice, rate }) {
  const file = path.join(VOICE_DIR, `${key}.mp3`);
  const result = spawnSync('edge-tts', ['--voice', voice, `--rate=${rate}`, '--text', text, '--write-media', file], { encoding: 'utf8' });
  if (result.status !== 0 || !existsSync(file)) {
    throw new Error(`edge-tts failed for "${key}": ${result.stderr || result.error?.message || 'no output'}`);
  }
  return { file, ms: Math.round(durationOf(file) * 1000) };
}

const card = (title, lead, lines = []) => `<!doctype html><html><body style="margin:0;height:100vh;display:grid;place-items:center;
  background:radial-gradient(900px 500px at 80% -10%,#1a2750,transparent 60%),#0a0f1c;color:#e9edf5;font-family:'Segoe UI',system-ui,sans-serif">
  <div style="text-align:center;max-width:1000px;padding:0 48px">
    <div style="font-size:68px;font-weight:800;letter-spacing:-0.03em">${title}</div>
    <div style="margin-top:20px;font-size:32px;font-weight:600;color:#43d99a">${lead}</div>
    ${lines.map((l) => `<div style="margin-top:12px;font-size:22px;color:#98a3ba">${l}</div>`).join('')}
  </div></body></html>`;

// Records one part of the video in its own browser context. The callback gets
// the moment recording started, so it can report when its narration begins.
async function segment(browser, record) {
  const context = await browser.newContext({ viewport: SIZE, recordVideo: { dir: path.join(OUT, 'raw'), size: SIZE } });
  const page = await context.newPage();
  const startedAt = Date.now();
  const cues = (await record(page, startedAt)) ?? [];
  const video = page.video();
  await context.close();
  return { file: await video.path(), cues };
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

// Everything the mix needs, so it can be re-run without re-recording.
function mix({ totalSeconds, parts, cues, voice }) {
  const video = parts.map((part, i) => {
    const cap = part.trim ? `,trim=duration=${part.trim},setpts=PTS-STARTPTS` : '';
    return `[${i}:v]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=0x0a0f1c,fps=30,format=yuv420p,setsar=1${cap}[v${i}]`;
  });
  const videoConcat = `${parts.map((_, i) => `[v${i}]`).join('')}concat=n=${parts.length}:v=1:a=0[vout]`;
  const audio = cues.map((cue, j) => `[${parts.length + j}:a]aresample=48000,aformat=channel_layouts=mono,adelay=delays=${cue.atMs}:all=1[a${j}]`);
  const audioMix = `${cues.map((_, j) => `[a${j}]`).join('')}amix=inputs=${cues.length}:normalize=0,loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000,apad[aout]`;

  const output = path.join(OUT, 'claimback-demo.mp4');
  const args = [
    '-y', '-loglevel', 'error',
    ...parts.flatMap((p) => ['-i', p.file]),
    ...cues.flatMap((c) => ['-i', voice[c.key]]),
    '-filter_complex', [...video, videoConcat, ...audio, audioMix].join(';'),
    '-map', '[vout]', '-map', '[aout]',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
    '-c:a', 'aac', '-b:a', '128k', '-ac', '1',
    // apad makes the audio endless and -shortest does not reliably stop a
    // filter graph, so set the length explicitly.
    '-t', totalSeconds.toFixed(3),
    '-movflags', '+faststart', output,
  ];
  const result = spawnSync('ffmpeg', args, { stdio: ['ignore', 'inherit', 'inherit'] });
  if (result.status !== 0) throw new Error('ffmpeg failed');
  console.log(`Wrote ${output} (${durationOf(output).toFixed(0)} s, ${cues.length} narration lines)`);
}

if (process.argv.includes('--mix-only')) {
  mix(JSON.parse(await readFile(MANIFEST, 'utf8')));
  process.exit(0);
}

const script = JSON.parse(await readFile(new URL('./narration.json', import.meta.url), 'utf8'));
const featured = JSON.parse(await readFile('public/demo/featured-run.json', 'utf8'));
const models = featured.events.find((e) => e.type === 'result')?.claim.models ?? [];

await rm(path.join(OUT, 'raw'), { recursive: true, force: true });
await rm(VOICE_DIR, { recursive: true, force: true });
await mkdir(VOICE_DIR, { recursive: true });

const lines = {};
for (const [key, text] of Object.entries(script.segments)) lines[key] = speak(key, text, script);
console.log(`Narration: ${Object.keys(lines).length} lines, ${(Object.values(lines).reduce((s, l) => s + l.ms, 0) / 1000).toFixed(0)} s of speech, voice ${script.voice}`);

const holdFor = (key) => (lines[key] ? lines[key].ms + LEAD_MS + TAIL_MS : 0);
const cardMs = (key, minimum) => Math.max(minimum, holdFor(key));

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
    await sleep(cardMs('title', 7000));
    return [{ key: 'title', offsetMs: LEAD_MS }];
  });

  const app = await segment(browser, async (page, startedAt) => {
    const holds = Object.fromEntries(Object.keys(lines).map((key) => [key, holdFor(key)]));
    await page.addInitScript((h) => {
      window.__narrationHolds = h;
    }, holds);
    await page.goto(`http://localhost:${PORT}/?autoplay&pace=2`);
    await page.waitForFunction(
      () => document.querySelector('#result')?.children.length > 0 && !document.querySelector('#watch-replay')?.disabled,
      null,
      { timeout: 10 * 60_000, polling: 500 },
    );
    const marks = await page.evaluate(() => window.__replayMarks ?? []);
    await sleep(2500);

    // A slow scroll back through the whole run as a recap, long enough for its line.
    const recapAt = Date.now();
    await page.evaluate(() => window.scrollTo({ top: 0 }));
    const recapMs = cardMs('recap', 16_000);
    await sleep(1200);
    const scrollSteps = 24;
    for (let i = 0; i < scrollSteps; i++) {
      await page.evaluate((n) => window.scrollBy({ top: Math.ceil(document.body.scrollHeight / n), behavior: 'smooth' }), scrollSteps);
      await sleep((recapMs - 1200) / scrollSteps);
    }
    await sleep(2000);
    return [
      ...marks.map((m) => ({ key: m.key, offsetMs: m.at - startedAt + LEAD_MS })),
      { key: 'recap', offsetMs: recapAt - startedAt + LEAD_MS },
    ];
  });

  const clipCard = hasClip && (await segment(browser, async (page) => {
    await page.setContent(card('Inside Anakin’s cloud browser', 'Filling in Air India’s claim form', ['The real recorded session from this run. It stops at Submit.']));
    await sleep(4000);
    // The clip line starts on this card and carries on over the recording.
    return [{ key: 'clip', offsetMs: LEAD_MS }];
  }));

  const end = await segment(browser, async (page) => {
    await page.setContent(card('Claimback', 'github.com/imarpanpatra/claimback', [
      process.env.DEMO_URL ? `Watch it run: ${process.env.DEMO_URL}` : '',
      'Not legal advice. Claimback never submits a claim for you.',
    ].filter(Boolean)));
    await sleep(cardMs('end', 6000) + 1000);
    return [{ key: 'end', offsetMs: LEAD_MS }];
  });

  const parts = [title, app, ...(hasClip ? [clipCard, { file: ANAKIN_CLIP, cues: [], trim: MAX_CLIP_S }] : []), end];

  // Turn each part's cue offsets into positions in the finished video.
  let cursor = 0;
  const cues = [];
  for (const part of parts) {
    const seconds = part.trim ? Math.min(durationOf(part.file), part.trim) : durationOf(part.file);
    for (const cue of part.cues) {
      if (lines[cue.key]) cues.push({ key: cue.key, atMs: Math.max(0, Math.round(cursor * 1000 + cue.offsetMs)) });
    }
    cursor += seconds;
  }
  cues.sort((a, b) => a.atMs - b.atMs);
  cues.forEach((cue, i) => {
    const next = cues[i + 1];
    if (next && cue.atMs + lines[cue.key].ms > next.atMs) {
      console.warn(`Warning: "${cue.key}" runs ${cue.atMs + lines[cue.key].ms - next.atMs} ms into "${next.key}".`);
    }
  });

  const manifest = {
    totalSeconds: cursor,
    parts: parts.map((p) => ({ file: p.file, trim: p.trim ?? null })),
    cues,
    voice: Object.fromEntries(Object.entries(lines).map(([key, line]) => [key, line.file])),
  };
  await writeFile(MANIFEST, JSON.stringify(manifest, null, 2));
  mix(manifest);
} finally {
  await browser.close();
  server.kill();
}
