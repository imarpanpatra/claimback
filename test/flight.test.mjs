import test from 'node:test';
import assert from 'node:assert/strict';
import { describeFlight, parseFlightNumber } from '../lib/flight.js';

test('a delay of 179.5 minutes is not rounded up to 3 hours', () => {
  const dep = Date.UTC(2026, 8, 9, 8, 45) / 1000;
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
