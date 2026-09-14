import test from 'node:test';
import assert from 'node:assert/strict';
import { applicableRegimes, referenceCompensation } from '../lib/rules.js';

const uk261 = (arrivalDelayMin, distanceKm = 6732) =>
  referenceCompensation({ regime: 'UK261', distanceKm, arrivalDelayMin, cancelled: false, intraEU: false });

test('AI162: UK261 gives £520, which the airline may halve for a 3 to 4 hour delay', () => {
  const r = uk261(207);
  assert.equal(r.eligible, true);
  assert.equal(r.amount, 520);
  assert.equal(r.reducedAmount, 260);
  assert.equal(r.currency, 'GBP');
  const regimes = applicableRegimes({ originCountry: 'GB', destinationCountry: 'IN', airlineCountry: 'IN' });
  assert.deepEqual(regimes.map((x) => x.id), ['UK261', 'DGCA']);
});

test('the 50% reduction still applies at exactly 4 hours late', () => {
  assert.equal(uk261(240).reducedAmount, 260);
  assert.equal(uk261(241).reducedAmount, 0);
});

test('under 3 hours late is not owed', () => {
  assert.equal(uk261(179).eligible, false);
  assert.equal(uk261(180).eligible, true);
});

test('a cancelled Indian flight is valued by its length, not always ₹10,000', () => {
  const dgca = (distanceKm) => referenceCompensation({ regime: 'DGCA', distanceKm, arrivalDelayMin: 0, cancelled: true, intraEU: false }).amount;
  assert.equal(dgca(250), 5000);
  assert.equal(dgca(1100), 7500);
  assert.equal(dgca(2000), 10000);
});

test('India pays no cash for delays', () => {
  const r = referenceCompensation({ regime: 'DGCA', distanceKm: 6732, arrivalDelayMin: 207, cancelled: false, intraEU: false });
  assert.equal(r.eligible, false);
  assert.equal(r.amount, 0);
});
