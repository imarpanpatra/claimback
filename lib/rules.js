// Passenger-rights reference used as a guardrail. The agent reads the official
// pages live and reasons from them; its conclusion is then checked against this
// table, so a misread page can't put a wrong amount into a claim.

// ISO country codes. EU outermost regions (Réunion, Guadeloupe…) have their own.
const EU_EEA_CH = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV',
  'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE', 'IS', 'LI', 'NO', 'CH',
  'RE', 'GP', 'MQ', 'GF', 'YT', 'MF',
]);

// Only used when AirHelp is unreachable and the bundled OpenFlights tables,
// which store country names, stand in.
const NAME_TO_CODE = {
  Austria: 'AT', Belgium: 'BE', Bulgaria: 'BG', Croatia: 'HR', Cyprus: 'CY', 'Czech Republic': 'CZ',
  Denmark: 'DK', Estonia: 'EE', Finland: 'FI', France: 'FR', Germany: 'DE', Greece: 'GR', Hungary: 'HU',
  Ireland: 'IE', Italy: 'IT', Latvia: 'LV', Lithuania: 'LT', Luxembourg: 'LU', Malta: 'MT',
  Netherlands: 'NL', Poland: 'PL', Portugal: 'PT', Romania: 'RO', Slovakia: 'SK', Slovenia: 'SI',
  Spain: 'ES', Sweden: 'SE', Iceland: 'IS', Liechtenstein: 'LI', Norway: 'NO', Switzerland: 'CH',
  Reunion: 'RE', Guadeloupe: 'GP', Martinique: 'MQ', 'French Guiana': 'GF', Mayotte: 'YT',
  'Saint Martin': 'MF', 'United Kingdom': 'GB', Canada: 'CA', India: 'IN', 'United States': 'US',
};

export const countryCodeFromName = (name) => NAME_TO_CODE[name] ?? null;
export const isEU = (code) => EU_EEA_CH.has(code);

export const REGIME_NAMES = {
  EU261: 'EU Regulation 261/2004',
  UK261: 'UK Regulation 261/2004',
  APPR: 'Canada’s Air Passenger Protection Regulations',
  DGCA: 'India’s DGCA passenger rules (CAR Section 3, Series M, Part IV)',
  US_DOT: 'US Department of Transportation rules',
};

// Pages the agent reads before deciding. Regimes without one are decided from
// the reference table alone.
export const OFFICIAL_SOURCES = {
  EU261: {
    url: 'https://europa.eu/youreurope/citizens/travel/passenger-rights/air/index_en.htm',
    title: 'Air passenger rights, Your Europe (European Commission)',
  },
  UK261: {
    url: 'https://www.legislation.gov.uk/eur/2004/261/article/7',
    title: 'Regulation 261/2004 as retained in UK law, Article 7 (legislation.gov.uk)',
  },
};

export function greatCircleKm(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * 6371 * Math.asin(Math.sqrt(h)));
}

export function applicableRegimes({ originCountry, destinationCountry, airlineCountry }) {
  const regimes = [];

  if (isEU(originCountry)) {
    regimes.push({ id: 'EU261', why: 'departs from the EU/EEA' });
  } else if (isEU(destinationCountry) && isEU(airlineCountry)) {
    regimes.push({ id: 'EU261', why: 'arrives in the EU/EEA on an EU/EEA airline' });
  }

  if (originCountry === 'GB') {
    regimes.push({ id: 'UK261', why: 'departs from the United Kingdom' });
  } else if (destinationCountry === 'GB' && (airlineCountry === 'GB' || isEU(airlineCountry))) {
    regimes.push({ id: 'UK261', why: 'arrives in the UK on a UK or EU airline' });
  }

  if (originCountry === 'CA' || destinationCountry === 'CA') {
    regimes.push({ id: 'APPR', why: 'flies to, from or within Canada' });
  }
  if (originCountry === 'IN' || airlineCountry === 'IN') {
    regimes.push({ id: 'DGCA', why: originCountry === 'IN' ? 'departs from India' : 'is operated by an Indian airline' });
  }
  if (originCountry === 'US' || destinationCountry === 'US') {
    regimes.push({ id: 'US_DOT', why: 'flies to or from the United States' });
  }
  return regimes;
}

const BANDS = {
  EU261: { currency: 'EUR', short: 250, medium: 400, long: 600 },
  UK261: { currency: 'GBP', short: 220, medium: 350, long: 520 },
};

// eligible is true, false, or 'depends' when the answer hinges on facts flight
// data can't show (notice given for a cancellation, whose fault a delay was).
export function referenceCompensation({ regime, distanceKm, arrivalDelayMin, cancelled, intraEU }) {
  if (regime === 'EU261' || regime === 'UK261') {
    const b = BANDS[regime];
    let band;
    let amount;
    if (distanceKm <= 1500) {
      band = 'up to 1,500 km';
      amount = b.short;
    } else if (distanceKm <= 3500 || (regime === 'EU261' && intraEU)) {
      band = distanceKm > 3500 ? 'within the EU, over 1,500 km' : '1,500 to 3,500 km';
      amount = b.medium;
    } else {
      band = 'over 3,500 km';
      amount = b.long;
    }
    const base = { regime, currency: b.currency, band, amount, reducedAmount: 0 };

    if (cancelled) {
      return { ...base, eligible: 'depends', note: 'Owed for a cancellation unless you were told 14+ days ahead, were rerouted close to your original times, or the cause was extraordinary.' };
    }
    if (arrivalDelayMin < 180) {
      return { ...base, amount: 0, eligible: false, note: `Arrived ${Math.max(arrivalDelayMin, 0)} minutes late. Compensation starts at 3 hours.` };
    }
    if (band === 'over 3,500 km' && arrivalDelayMin < 240) {
      return { ...base, eligible: true, reducedAmount: amount / 2, note: 'A long-haul delay of 3 to 4 hours lets the airline halve the payment.' };
    }
    return { ...base, eligible: true, note: 'Owed unless the airline proves extraordinary circumstances, such as severe weather or an air-traffic-control strike.' };
  }

  if (regime === 'APPR') {
    const base = { regime, currency: 'CAD', band: 'large airline', reducedAmount: 0 };
    if (cancelled) {
      return { ...base, amount: 400, eligible: 'depends', note: 'CAD 400 to 1,000 for a cancellation within the airline’s control, scaled by how late you finally arrived.' };
    }
    if (arrivalDelayMin < 180) {
      return { ...base, amount: 0, eligible: false, note: `Arrived ${Math.max(arrivalDelayMin, 0)} minutes late. Compensation starts at 3 hours.` };
    }
    const amount = arrivalDelayMin >= 540 ? 1000 : arrivalDelayMin >= 360 ? 700 : 400;
    return { ...base, amount, eligible: 'depends', note: 'Owed only if the delay was within the airline’s control and not needed for safety. Small airlines pay CAD 125 to 500.' };
  }

  if (regime === 'DGCA') {
    const base = { regime, currency: 'INR', band: 'by block time', reducedAmount: 0 };
    if (cancelled) {
      return { ...base, amount: 10000, eligible: 'depends', note: '₹5,000 to ₹10,000 by block time for a cancellation with under two weeks’ notice, unless an alternative flight within two hours was offered.' };
    }
    return { ...base, amount: 0, eligible: false, note: 'India’s rules give meals, a refund or a hotel for long delays, not cash compensation.' };
  }

  if (regime === 'US_DOT') {
    return { regime, currency: 'USD', band: '', amount: 0, reducedAmount: 0, eligible: false, note: 'US rules require no cash compensation for delays. Refunds apply only if you chose not to fly.' };
  }

  return null;
}
