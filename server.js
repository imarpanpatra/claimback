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
// Used for any field a visitor leaves blank. The agent stops before submitting,
// so demo details never reach an airline.
const DEMO_PASSENGER = { fullName: 'Alex Demo', email: 'alex.demo@example.com', ticketNumber: '0982100000000' };

const app = express();
app.use(express.json({ limit: '32kb' }));
// The recorded run lives in public/demo, so the page also works on a static host.
app.use(express.static(fileURLToPath(new URL('./public', import.meta.url))));

const runs = new Map();
let running = 0;

const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

function codeMatches(given) {
  const expected = process.env.LIVE_RUN_CODE;
  if (!expected || typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
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

app.get('/api/config', (req, res) => {
  const hasModel = Boolean(process.env.OPENAI_API_KEY || process.env.GEMINI_API_KEY);
  res.json({ liveRuns: Boolean(process.env.LIVE_RUN_CODE && hasModel), model: llmLabel() });
});

app.post('/api/runs', (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const { code, flightNumber, date } = body;
  const passenger = body.passenger && typeof body.passenger === 'object' ? body.passenger : {};
  if (!codeMatches(code)) return res.status(403).json({ error: 'That access code isn’t right.' });
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
  const emit = (event) => {
    const e = { ...event, t: Date.now() - run.startedAt, seq: run.events.length };
    run.events.push(e);
    for (const send of run.listeners) send(e);
  };

  runClaim({ flightNumber: text(flightNumber, 10), date, passenger: who }, emit)
    .catch((err) => emit({ type: 'error', message: err.message }))
    .finally(async () => {
      running--;
      run.done = true;
      emit({ type: 'end' });
      await mkdir('runs', { recursive: true }).catch(() => {});
      await writeFile(`runs/${id}.json`, JSON.stringify({ input: run.input, events: run.events })).catch(() => {});
      setTimeout(() => runs.delete(id), 30 * 60_000).unref();
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
