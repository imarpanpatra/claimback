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

// Recording links are presigned for an hour, so they can't live in a replay.
const recording = run.events.find((e) => e.type === 'recording');
const events = run.events.filter((e) => e.type !== 'recording');

// Kept under public/ so the page can replay it from any static host.
await mkdir('public/demo', { recursive: true });
const recordedAt = (await stat(file)).mtime.toISOString();
const out = JSON.stringify({ input: run.input, recordedAt, events });
await writeFile('public/demo/featured-run.json', out);
console.log(`public/demo/featured-run.json: ${events.length} events, ${Math.round(out.length / 1024)} KB`);

if (recording) {
  await mkdir('recordings', { recursive: true });
  let res = await fetch(recording.url).catch(() => null);
  if (!res?.ok && process.env.ANAKIN_API_KEY) {
    // The link has expired: ask Anakin for a fresh one for the newest recording.
    const headers = { 'X-API-Key': process.env.ANAKIN_API_KEY };
    const list = await fetch('https://api.anakin.io/v1/recordings', { headers }).then((r) => r.json());
    const newest = (list.recordings ?? []).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
    const detail = newest && (await fetch(`https://api.anakin.io/v1/recordings/${newest.connId ?? newest.id}`, { headers }).then((r) => r.json()));
    if (detail?.videoUrl) res = await fetch(detail.videoUrl);
  }
  if (res?.ok) {
    const bytes = Buffer.from(await res.arrayBuffer());
    await writeFile('recordings/anakin-session.webm', bytes);
    console.log(`recordings/anakin-session.webm: ${Math.round(bytes.length / 1024)} KB`);
  } else {
    console.warn('Could not download the cloud-browser recording.');
  }
}
