// Run a claim from the terminal and save the event log to runs/.
//   npm run claim -- AI162 2026-09-09
//   npm run claim -- AI162 2026-09-09 --no-form   (skip the browser step)
import dotenv from 'dotenv';
import { mkdir, writeFile } from 'node:fs/promises';
import { runClaim } from '../lib/agent.js';

dotenv.config({ quiet: true });

const [flightNumber, date, ...flags] = process.argv.slice(2);
if (!flightNumber || !/^\d{4}-\d{2}-\d{2}$/.test(date ?? '')) {
  console.error('Usage: npm run claim -- <flight number> <YYYY-MM-DD> [--no-form]');
  process.exit(1);
}

// Demo identity. The agent stops before submitting, so none of it reaches the airline.
const passenger = { fullName: 'Alex Demo', email: 'alex.demo@example.com', bookingReference: '', ticketNumber: '0982100000000' };
const started = Date.now();
const events = [];

function print(e) {
  const t = `${(e.t / 1000).toFixed(1).padStart(6)}s`;
  switch (e.type) {
    case 'step': return console.log(`\n${t}  [${e.phase.toUpperCase()}] ${e.title}`);
    case 'tool': return console.log(`${t}    -> ${e.name}: ${e.detail}${e.credits ? ` (${e.credits} cr)` : ''}`);
    case 'note': return console.log(`${t}    *  ${e.text}`);
    case 'thought': return console.log(`${t}    ~  ${e.text}`);
    case 'source': return console.log(`${t}    "  ${e.quote}${e.verified === true ? '  [found on page]' : e.verified === false ? '  [NOT on page]' : ''}`);
    case 'action': return console.log(`${t}    +  ${e.op} ${e.label}${e.value ? ` = ${e.value}` : ''}`);
    case 'shot': return console.log(`${t}    [screenshot] ${e.caption ?? ''}`);
    case 'recording': return console.log(`${t}    [recording] ${e.url}`);
    case 'letter': return console.log(`${t}    Letter: ${e.subject}\n\n${e.body}\n`);
    case 'result': return console.log(`\n${t}  RESULT\n${JSON.stringify({ ...e.claim, letter: undefined }, null, 2)}`);
    case 'error': return console.log(`${t}  ERROR ${e.message}`);
    default: return undefined;
  }
}

const emit = (event) => {
  const e = { ...event, t: Date.now() - started };
  events.push(e);
  print(e);
};

try {
  await runClaim({ flightNumber, date, passenger, skipForm: flags.includes('--no-form') }, emit);
} catch (err) {
  emit({ type: 'error', message: err.message });
}
emit({ type: 'end' });

await mkdir('runs', { recursive: true });
// Only letters and digits from the flight number, so "AI/162" can't point the path at another folder.
const file = `runs/${flightNumber.replace(/[^a-z0-9]/gi, '')}-${date}-${started}.json`;
await writeFile(file, JSON.stringify({ input: { flightNumber, date }, events }));
console.log(`\nSaved ${file}`);
