import test from 'node:test';
import assert from 'node:assert/strict';
import { describeFlight, parseFlightNumber, pickFlight, resolveAirline } from '../lib/flight.js';

const dep = Date.UTC(2026, 8, 9, 8, 45) / 1000;

test('a delay of 179.5 minutes is not rounded up to 3 hours', () => {
  const flight = describeFlight({
    origin: { TZ: ':Europe/London' },
    destination: { TZ: ':Asia/Kolkata' },
    gateDepartureTimes: { scheduled: dep },
    gateArrivalTimes: { scheduled: dep + 30_000, actual: dep + 30_000 + 179.5 * 60 },
  });
  assert.equal(flight.arrivalDelayMin, 179);
});

test('flight numbers are parsed into airline code and number', () => {
  assert.deepEqual(parseFlightNumber('AI162'), { iata: 'AI', number: '162' });
  assert.deepEqual(parseFlightNumber('ai 162'), { iata: 'AI', number: '162' });
  assert.deepEqual(parseFlightNumber('6E2134'), { iata: '6E', number: '2134' });
  assert.deepEqual(parseFlightNumber('BA0117'), { iata: 'BA', number: '117' });
  assert.equal(parseFlightNumber('12345'), null);
});

test('an airport with a broken time zone shows UTC times instead of crashing the run', () => {
  const flight = describeFlight({
    origin: { TZ: ':Not/AZone' },
    destination: { TZ: ':Asia/Kolkata' },
    gateDepartureTimes: { scheduled: dep },
    gateArrivalTimes: { scheduled: dep + 30_000, actual: dep + 30_000 + 200 * 60 },
  });
  assert.match(flight.display.scheduledDeparture, /UTC/);
  assert.equal(flight.arrivalDelayMin, 200);
});

test('the flight that operated is picked over a cancelled placeholder on the same date', () => {
  const placeholder = { origin: { TZ: ':Europe/London' }, gateDepartureTimes: { scheduled: dep }, cancelled: true };
  const operated = { origin: { TZ: ':Europe/London' }, gateDepartureTimes: { scheduled: dep + 600, actual: dep + 900 }, cancelled: false };
  assert.equal(pickFlight([placeholder, operated], '2026-09-09'), operated);
});

test('with AirHelp unreachable, the bundled table gives VY as Vueling', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('offline');
  };
  try {
    const airline = await resolveAirline('VY');
    assert.equal(airline.name, 'Vueling Airlines');
    assert.equal(airline.icao, 'VLG');
  } finally {
    globalThis.fetch = realFetch;
  }
});
