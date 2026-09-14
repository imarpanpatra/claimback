// Promote a saved run to the replay shown on the public page, and download its
// cloud-browser recording for the demo video.
//   node scripts/feature-run.js runs/AI162-2026-09-09-1789312345678.json
import dotenv from 'dotenv';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';

dotenv.config({ quiet: true });

const file = process.argv[2];
if (!file) {
  console.error('Usage: node scripts/feature-run.js <runs/file.json>');
  process.exit(1);
}

const run = JSON.parse(await readFile(file, 'utf8'));
if (!run.events.some((e) => e.type === 'result')) {
  console.error('That run never reached a result. Pick a complete one.');
  process.exit(1);
}
const errors = run.events.filter((e) => e.type === 'error');
if (errors.length) console.warn(`Warning: the run contains errors: ${errors.map((e) => e.message).join(' | ')}`);

// Recording links are presigned, carry a session token and expire after an
// hour, so none of them belongs in a public replay.
const recording = run.events.find((e) => e.type === 'recording');
const withoutLink = (e) => {
  if (e.type !== 'result' || !e.claim?.filing) return e;
  const { recordingUrl, ...filing } = e.claim.filing;
  return { ...e, claim: { ...e.claim, filing } };
};
const events = run.events.filter((e) => e.type !== 'recording').map(withoutLink);

// Kept under public/ so the page can replay it from any static host.
await mkdir('public/demo', { recursive: true });
const recordedAt = (await stat(file)).mtime.toISOString();
const out = JSON.stringify({ input: run.input, recordedAt, events });
await writeFile('public/demo/featured-run.json', out);
console.log(`public/demo/featured-run.json: ${events.length} events, ${Math.round(out.length / 1024)} KB`);

// A recording link ends in the session's connection id, e.g. .../rec-f81b….webm.
const connIdOf = (url) => {
  try {
    return new URL(url).pathname.split('/').pop().replace(/\.webm$/, '') || null;
  } catch {
    return null;
  }
};

if (recording) {
  await mkdir('recordings', { recursive: true });
  let res = await fetch(recording.url).catch(() => null);
  const connId = connIdOf(recording.url);
  if (!res?.ok && process.env.ANAKIN_API_KEY && connId) {
    // The link has expired: ask Anakin for a fresh link to this run's own recording.
    const headers = { 'X-API-Key': process.env.ANAKIN_API_KEY };
    const detail = await fetch(`https://api.anakin.io/v1/recordings/${connId}`, { headers })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
    if (detail?.videoUrl) res = await fetch(detail.videoUrl).catch(() => null);
  }
  if (res?.ok) {
    const bytes = Buffer.from(await res.arrayBuffer());
    await writeFile('recordings/anakin-session.webm', bytes);
    console.log(`recordings/anakin-session.webm: ${Math.round(bytes.length / 1024)} KB`);
  } else {
    console.warn('Could not download the cloud-browser recording.');
  }
}
