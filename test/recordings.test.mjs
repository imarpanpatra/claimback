import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { json } from './helpers.mjs';

process.env.ANAKIN_API_KEY = 'test';

// Anakin stamps a recording's createdAt when its session ends, and duration is
// the session length in seconds.
const START = Date.parse('2026-09-14T10:00:00Z');
const at = (ms) => new Date(START + ms).toISOString();
let recordings = [];
globalThis.fetch = async (url) => {
  url = String(url);
  if (url.endsWith('/v1/recordings')) return json({ recordings });
  const connId = url.split('/').pop();
  return json({ connId, videoUrl: `https://s3.example/${connId}.webm` });
};

const { findRecording } = await import('../lib/anakin.js');

test("picks this session's recording, not a later one from another session", async () => {
  recordings = [
    { connId: 'rec-mine', createdAt: at(42_300), duration: 39, status: 'completed' },
    { connId: 'rec-other', createdAt: at(80_000), duration: 60, status: 'completed' },
  ];
  const found = await findRecording(START, 300, { endedAt: START + 42_000 });
  assert.equal(found?.connId, 'rec-mine');
});

test("returns nothing rather than another session's recording", async () => {
  recordings = [{ connId: 'rec-other', createdAt: at(80_000), duration: 60, status: 'completed' }];
  assert.equal(await findRecording(START, 300, { endedAt: START + 42_000 }), null);
});

test('returns nothing when two recordings fit equally well', async () => {
  recordings = [
    { connId: 'rec-a', createdAt: at(42_300), duration: 39, status: 'completed' },
    { connId: 'rec-b', createdAt: at(43_000), duration: 40, status: 'completed' },
  ];
  assert.equal(await findRecording(START, 300, { endedAt: START + 42_000 }), null);
});

test("the replay script fetches the run's own recording once its link has expired, and drops the link", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'claimback-feature-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const expired = 'https://expired.example/recordings/session-1/rec-mine.webm?X-Amz-Expires=3600';
  const run = {
    input: { flightNumber: 'AI162', date: '2026-09-09' },
    events: [
      { type: 'step', id: 'form', phase: 'act', title: 'Fill in the form', t: 1 },
      { type: 'recording', step: 'form', url: expired, t: 2 },
      { type: 'result', claim: { verdict: 'owed', filing: { url: 'https://airline.example/form', reason: 'stopped', recordingUrl: expired } }, t: 3 },
    ],
  };
  await writeFile(path.join(dir, 'run.json'), JSON.stringify(run));

  const script = fileURLToPath(new URL('../scripts/feature-run.js', import.meta.url));
  const mock = new URL('./fixtures/recordings-fetch-mock.mjs', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--import', mock, script, 'run.json'], {
    cwd: dir,
    env: { ...process.env, ANAKIN_API_KEY: 'test' },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);

  const video = await readFile(path.join(dir, 'recordings', 'anakin-session.webm'), 'utf8');
  assert.equal(video, 'VIDEO rec-mine');
  const featured = await readFile(path.join(dir, 'public', 'demo', 'featured-run.json'), 'utf8');
  assert.equal(featured.includes('expired.example'), false, 'the replay must not carry the presigned recording link');
});
