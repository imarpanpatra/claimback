// Runs the whole claim pipeline offline: every Anakin and Gemini call is answered
// by the fake fetch below, so these tests cost nothing and need no keys.
import test from 'node:test';
import assert from 'node:assert/strict';
import { geminiReply, json } from './helpers.mjs';

process.env.GEMINI_API_KEY = 'test';
delete process.env.OPENAI_API_KEY;
delete process.env.GEMINI_MODEL;
delete process.env.ANAKIN_API_KEY; // without it the agent skips its paid search and browser steps

const AIRLINES = {
  AI: { title: 'Air India (AI)', iata: 'AI', icao: 'AIC', country_code: 'IN', active: true },
  AA: { title: 'American Airlines (AA)', iata: 'AA', icao: 'AAL', country_code: 'US', active: true },
  BA: { title: 'British Airways (BA)', iata: 'BA', icao: 'BAW', country_code: 'GB', active: true },
};
const AIRPORTS = {
  LHR: { iata: 'LHR', name: 'London Heathrow Airport', city: 'London', country: 'United Kingdom', country_code: 'GB', latitude: 51.4775, longitude: -0.461388 },
  DEL: { iata: 'DEL', name: 'Delhi Indira Gandhi International Airport', city: 'New Delhi', country: 'India', country_code: 'IN', latitude: 28.5665, longitude: 77.103104 },
  JFK: { iata: 'JFK', name: 'John F Kennedy International Airport', city: 'New York', country: 'United States', country_code: 'US', latitude: 40.6398, longitude: -73.7789 },
};
const TIME_ZONES = { LHR: ':Europe/London', DEL: ':Asia/Kolkata', JFK: ':America/New_York' };

const LONG_REAL_SENTENCE = '(c)by four hours, in respect of all flights not falling under (a) or (b), the operating air carrier may reduce the compensation provided for in paragraph 1 by 50 %.';
const ARTICLE_7 = [
  '## Article 7 Right to compensation',
  '1.Where reference is made to this Article, passengers shall receive compensation amounting to—',
  '(a)£220 for all flights of 1500 kilometres or less;',
  '(b)£350 for all flights between 1500 and 3500 kilometres;',
  '(c)£520 for all flights not falling under (a) or (b).',
  LONG_REAL_SENTENCE,
].join('\n');

// FlightAware keeps a flight's recent history as JSON inside the page.
function flightAwarePage({ airline, origin, destination, delayMin = 0, cancelled = false, noScheduledArrival = false }) {
  const dep = Date.UTC(2026, 8, 9, 8, 45) / 1000;
  const arr = dep + 8 * 3600 + 35 * 60;
  const flight = {
    origin: { iata: origin, friendlyName: AIRPORTS[origin].name, TZ: TIME_ZONES[origin] },
    destination: { iata: destination, friendlyName: AIRPORTS[destination].name, TZ: TIME_ZONES[destination] },
    gateDepartureTimes: { scheduled: dep, actual: cancelled ? null : dep + delayMin * 60 },
    gateArrivalTimes: { scheduled: noScheduledArrival ? null : arr, actual: cancelled ? null : arr + delayMin * 60 },
    cancelled,
    diverted: false,
  };
  const boot = { flights: { any: { airline, activityLog: { flights: [flight] } } } };
  return `<html><script>var trackpollBootstrap = ${JSON.stringify(boot)};</script></html>`;
}

const AIR_INDIA = { fullName: 'Air India', iata: 'AI', icao: 'AIC', url: 'https://www.airindia.com/' };
const BRITISH_AIRWAYS = { fullName: 'British Airways', iata: 'BA', icao: 'BAW', url: 'https://www.britishairways.com/' };
const RULING = { eligible: 'yes', amount: 520, reducedAmount: 260, currency: 'GBP', reasoning: 'test reasoning', citations: [], airlineDefences: [] };

let scenario;
globalThis.fetch = async (url, options = {}) => {
  url = String(url);
  const body = options.body ? JSON.parse(options.body) : {};
  if (url.endsWith('/v1/wire-run')) {
    const p = body.params;
    const airports = scenario.airports ?? AIRPORTS;
    if (body.action_id === 'act_airhelp_airline_autocomplete') return json({ status: 'completed', data: { items: [AIRLINES[p.airline_query]].filter(Boolean) }, credits_used: 1 });
    if (body.action_id === 'act_airhelp_airport_autocomplete') return json({ status: 'completed', data: { items: [airports[p.airport_query]].filter(Boolean) }, credits_used: 1 });
    if (body.action_id === 'act_airhelp_flight_status_listing') return json({ status: 'completed', data: { items: [] }, credits_used: 2 });
  }
  if (url.endsWith('/v1/url-scraper/scrape')) {
    if (body.url.includes('flightaware.com')) return json({ id: 'fa', status: 'completed', html: scenario.flightAware, markdown: '' });
    if (body.url.includes('legislation.gov.uk')) {
      if (scenario.lawFails) return json({ error: 'upstream timeout' }, 500);
      return json({ id: 'law', status: 'completed', html: '', markdown: ARTICLE_7 });
    }
  }
  if (url.includes('generativelanguage.googleapis.com')) {
    const system = body.systemInstruction.parts[0].text;
    if (system.startsWith('You are a passenger-rights analyst')) return geminiReply(scenario.ruling);
    if (system.startsWith('Write a firm, polite compensation claim')) {
      if (scenario.letterFails) return json({ error: { message: 'The caller does not have permission' } }, 403);
      return geminiReply({ subject: 'Claim', body: 'Letter' });
    }
  }
  throw new Error(`unexpected request in test: ${url}`);
};

const { runClaim } = await import('../lib/agent.js');

async function run(flightNumber, setup) {
  scenario = setup;
  const events = [];
  const claim = await runClaim({ flightNumber, date: '2026-09-09', passenger: {}, skipForm: true }, (e) => events.push(e));
  return { claim, events };
}

const ai162 = (ruling = RULING, extra = {}) => ({
  flightAware: flightAwarePage({ airline: AIR_INDIA, origin: 'LHR', destination: 'DEL', delayMin: 207, ...extra }),
  ruling,
});
const guardrailNote = (events) => events.find((e) => e.type === 'note' && e.guardrail);

test('AI162 still comes out as UK261 £520, reducible to £260', async () => {
  const { claim } = await run('AI162', ai162());
  assert.equal(claim.regime, 'UK261');
  assert.equal(claim.amount, 520);
  assert.equal(claim.reducedAmount, 260);
});

test('a codeshare uses the airline that flew it, not the one whose number was typed', async () => {
  const { claim, events } = await run('AA6936', {
    flightAware: flightAwarePage({ airline: BRITISH_AIRWAYS, origin: 'JFK', destination: 'LHR', delayMin: 300 }),
    ruling: { ...RULING, reducedAmount: 0 },
  });
  assert.equal(claim.regime, 'UK261', `got verdict ${claim.verdict}; notes: ${events.filter((e) => e.type === 'note').map((e) => e.text).join(' | ')}`);
  assert.equal(claim.amount, 520);
});

test('a quote with invented text added is not marked as found on the page', async () => {
  const { events } = await run('AI162', ai162({
    ...RULING,
    citations: [
      { quote: `${LONG_REAL_SENTENCE} The airline must also pay £5,000 to every passenger.`, supports: 'invented' },
      { quote: '£220 for all flights of 1,500 kilometres or less', supports: 'real, with a thousands comma' },
    ],
  }));
  const sources = events.filter((e) => e.type === 'source');
  assert.equal(sources.length, 2);
  assert.equal(sources[0].verified, false, 'the quote with an invented clause must not pass');
  assert.equal(sources[1].verified, true, '1,500 on the quote must match 1500 on the page');
});

test('a reading of "depends, £0" is flagged, not passed', async () => {
  // Over 4 hours late there is no reduced figure, which is when a £0 reading used to pass.
  const { events } = await run('AI162', ai162({ ...RULING, eligible: 'depends', amount: 0, reducedAmount: 0 }, { delayMin: 300 }));
  assert.equal(guardrailNote(events).guardrail, 'override', guardrailNote(events).text);
});

test('a reading of the reduced £260 says so, instead of "£520 matches"', async () => {
  const { events } = await run('AI162', ai162({ ...RULING, amount: 260, reducedAmount: 0 }));
  const note = guardrailNote(events);
  assert.equal(note.guardrail, 'pass');
  assert.match(note.text, /£260/);
});

test('a reading more certain than the table is not called "more cautious"', async () => {
  const { events } = await run('AI162', ai162(RULING, { cancelled: true }));
  const note = guardrailNote(events);
  assert.equal(note.guardrail, 'pass');
  assert.doesNotMatch(note.text, /more cautious/);
});

test('a flight with no scheduled arrival time fails loudly instead of coming out as "nothing owed"', async () => {
  await assert.rejects(run('AI162', ai162(RULING, { noScheduledArrival: true })), /scheduled arrival/);
});

test('an airport without coordinates fails loudly instead of landing in the long-haul band', async () => {
  const { latitude, longitude, ...withoutCoordinates } = AIRPORTS.DEL;
  await assert.rejects(run('AI162', { ...ai162(), airports: { ...AIRPORTS, DEL: withoutCoordinates } }), /coordinates/);
});

test('if the official text can’t be read, the built-in table still decides', async () => {
  const { claim, events } = await run('AI162', { ...ai162(), lawFails: true });
  assert.equal(claim.regime, 'UK261');
  assert.equal(claim.amount, 520);
  assert.ok(events.some((e) => e.type === 'note' && /official text/.test(e.text) && /built-in/.test(e.text)));
});

test('if the letter can’t be written, the result still arrives', async () => {
  const { claim } = await run('AI162', { ...ai162(), letterFails: true });
  assert.equal(claim.amount, 520);
  assert.equal(claim.letter, null);
});
