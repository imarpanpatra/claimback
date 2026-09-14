import dotenv from 'dotenv';
import express from 'express';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { runClaim } from './lib/agent.js';
import { llmLabel } from './lib/llm.js';

dotenv.config({ quiet: true });

const PORT = Number(process.env.PORT) || 7860;
const DAY = 86_400_000;
// A claim normally takes 2 to 5 minutes. One that runs far longer is stuck, and
// mustn't hold the only live-run slot forever.
const RUN_TIMEOUT_MS = Number(process.env.RUN_TIMEOUT_MS) || 15 * 60_000;
// Wrong access codes allowed from one address before it has to wait.
const CODE_ATTEMPTS = 20;
const CODE_WINDOW_MS = 15 * 60_000;
// Used for any field a visitor leaves blank. The agent stops before submitting,
// so demo details never reach an airline.
const DEMO_PASSENGER = { fullName: 'Alex Demo', email: 'alex.demo@example.com', ticketNumber: '0982100000000' };

const app = express();
// Render sits behind proxies, so the visitor's own address is the first one in
// X-Forwarded-For. It can be faked, but it only feeds the wrong-code limit, and
// keying on a shared proxy address would lock every visitor out together.
app.set('trust proxy', true);
app.use(express.json({ limit: '32kb' }));
// The recorded run lives in public/demo, so the page also works on a static host.
app.use(express.static(fileURLToPath(new URL('./public', import.meta.url))));

const runs = new Map();
const wrongCodes = new Map();
let running = 0;

const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

function codeMatches(given) {
  const expected = process.env.LIVE_RUN_CODE?.trim();
  if (!expected || typeof given !== 'string') return false;
  const a = Buffer.from(given.trim());
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function tooManyWrongCodes(ip) {
  const entry = wrongCodes.get(ip);
  return Boolean(entry && Date.now() - entry.since < CODE_WINDOW_MS && entry.count >= CODE_ATTEMPTS);
}

function recordWrongCode(ip) {
  const now = Date.now();
  const entry = wrongCodes.get(ip);
  if (entry && now - entry.since < CODE_WINDOW_MS) entry.count += 1;
  else wrongCodes.set(ip, { count: 1, since: now });
  if (wrongCodes.size > 1000) {
    for (const [key, value] of wrongCodes) if (now - value.since >= CODE_WINDOW_MS) wrongCodes.delete(key);
  }
}

// FlightAware's public history goes back about 14 days, so a date outside it
// would only fail after credits are spent. A day's slack covers time zones.
function dateProblem(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return 'Enter the departure date.';
  const ms = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== date) return 'That isn’t a real date.';
  const daysAgo = (Date.now() - ms) / DAY;
  if (daysAgo > 15) return 'Claimback can only check flights from the last 14 days.';
  if (daysAgo < -1) return 'That flight hasn’t happened yet.';
  return null;
}

const duration = (ms) => (ms >= 60_000 ? `${Math.round(ms / 60_000)}-minute` : `${Math.round(ms / 1000)}-second`);

app.get('/api/config', (req, res) => {
  const hasModel = Boolean(process.env.OPENAI_API_KEY || process.env.GEMINI_API_KEY);
  res.json({ liveRuns: Boolean(process.env.LIVE_RUN_CODE && hasModel), model: llmLabel() });
});

app.post('/api/runs', (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const { code, flightNumber, date } = body;
  const passenger = body.passenger && typeof body.passenger === 'object' ? body.passenger : {};
  if (tooManyWrongCodes(req.ip)) return res.status(429).json({ error: 'Too many wrong access codes. Try again in 15 minutes.' });
  if (!codeMatches(code)) {
    recordWrongCode(req.ip);
    return res.status(403).json({ error: 'That access code isn’t right.' });
  }
  if (!text(flightNumber, 10)) return res.status(400).json({ error: 'Enter a flight number.' });
  const problem = dateProblem(date);
  if (problem) return res.status(400).json({ error: problem });
  if (running >= 1) return res.status(429).json({ error: 'A claim is already running. Try again in a couple of minutes.' });

  const who = {
    fullName: text(passenger.fullName, 80) || DEMO_PASSENGER.fullName,
    email: text(passenger.email, 120) || DEMO_PASSENGER.email,
    bookingReference: text(passenger.bookingReference, 12),
    ticketNumber: text(passenger.ticketNumber, 20) || DEMO_PASSENGER.ticketNumber,
  };
  const id = randomUUID();
  const run = { input: { flightNumber, date }, events: [], listeners: new Set(), done: false, startedAt: Date.now() };
  runs.set(id, run);
  running++;

  // Events are numbered so a page whose stream drops can resume where it left off.
  // Once a run is closed, anything it still emits is dropped.
  const emit = (event) => {
    if (run.done) return;
    const e = { ...event, t: Date.now() - run.startedAt, seq: run.events.length };
    run.events.push(e);
    for (const send of run.listeners) send(e);
  };
  const finish = async () => {
    if (run.done) return;
    emit({ type: 'end' });
    run.done = true;
    running--;
    await mkdir('runs', { recursive: true }).catch(() => {});
    await writeFile(`runs/${id}.json`, JSON.stringify({ input: run.input, events: run.events })).catch(() => {});
    setTimeout(() => runs.delete(id), 30 * 60_000).unref();
  };
  const limit = setTimeout(() => {
    emit({ type: 'error', message: `The claim went over the ${duration(RUN_TIMEOUT_MS)} limit, so Claimback gave up on it. Try again in a few minutes.` });
    finish();
  }, RUN_TIMEOUT_MS);

  runClaim({ flightNumber: text(flightNumber, 10), date, passenger: who }, emit)
    .catch((err) => emit({ type: 'error', message: err.message }))
    .finally(() => {
      clearTimeout(limit);
      finish();
    });

  res.status(202).json({ id });
});

app.get('/api/runs/:id/events', (req, res) => {
  const run = runs.get(req.params.id);
  if (!run) return res.status(404).json({ error: 'Run not found.' });

  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  const send = (e) => res.write(`data: ${JSON.stringify(e)}\n\n`);
  const from = Math.max(0, Number.parseInt(req.query.from, 10) || 0);
  run.events.slice(from).forEach(send);
  if (run.done) return res.end();

  const listener = (e) => {
    send(e);
    if (e.type === 'end') res.end();
  };
  run.listeners.add(listener);
  const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
  req.on('close', () => {
    clearInterval(ping);
    run.listeners.delete(listener);
  });
});

// Express's own error page shows a stack trace outside production.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err.status ?? err.statusCode ?? 500;
  res.status(status).json({ error: err.type === 'entity.parse.failed' ? 'The request body isn’t valid JSON.' : 'Something went wrong.' });
});

app.listen(PORT, () => console.log(`Claimback running on http://localhost:${PORT}`));
