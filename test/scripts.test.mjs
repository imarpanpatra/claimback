import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLAIM = fileURLToPath(new URL('../scripts/claim.js', import.meta.url));
// Makes every fetch fail. The agent rejects these flight numbers before any
// network call anyway, and the API keys are blanked as well.
const OFFLINE = `data:text/javascript,${encodeURIComponent("globalThis.fetch = async () => { throw new Error('offline'); };")}`;

// Runs claim.js in a fresh folder and lists what it left there.
async function claim(t, flightNumber) {
  const dir = await mkdtemp(path.join(tmpdir(), 'claimback-claim-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, ['--import', OFFLINE, CLAIM, flightNumber, '2026-09-09', '--no-form'], {
    cwd: dir,
    env: { ...process.env, ANAKIN_API_KEY: '', GEMINI_API_KEY: '', OPENAI_API_KEY: '' },
    encoding: 'utf8',
  });
  return { result, top: await readdir(dir), runs: await readdir(path.join(dir, 'runs')).catch(() => []) };
}

test('a slash in the flight number does not turn into a folder under runs/', async (t) => {
  const { result, runs } = await claim(t, 'AI/162');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(runs.length, 1);
  assert.match(runs[0], /^AI162-2026-09-09-\d+\.json$/);
});

test('a flight number cannot put the run log outside runs/', async (t) => {
  const { result, top, runs } = await claim(t, '../AI162');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(top, ['runs']);
  assert.equal(runs.length, 1);
  assert.match(runs[0], /^AI162-2026-09-09-\d+\.json$/);
});
