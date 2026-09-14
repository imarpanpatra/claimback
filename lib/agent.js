// Claimback agent. Reads what happened to a flight, reads the law that covers
// it, decides what the passenger is owed, then fills in the airline's claim form
// in a recorded cloud browser, stopping before anything is sent.
import { askJson, modelsUsed } from './llm.js';
import { scrape, search, openBrowser, browserCredits, findRecording } from './anakin.js';
import {
  parseFlightNumber, resolveAirline, resolveAirport, flightHistory, pickFlight, describeFlight, airhelpStatus,
} from './flight.js';
import {
  applicableRegimes, referenceCompensation, greatCircleKm, isEU, REGIME_NAMES, OFFICIAL_SOURCES,
} from './rules.js';
import { fillClaimForm } from './claimform.js';

const money = (amount, currency) =>
  new Intl.NumberFormat('en-GB', { style: 'currency', currency, maximumFractionDigits: 0 }).format(amount);

const lateness = (min) => (min < 60 ? `${min} minutes` : `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, '0')}m`);

const verdictOf = (eligible) => (eligible === true ? 'yes' : eligible === false ? 'no' : 'depends');

// Markdown links and amendment markers like [F2](…) make a verbatim quote look
// different from the page, and so does writing 1,500 for 1500, so compare
// letters, digits and currency signs only.
const normalize = (s) =>
  String(s ?? '')
    .replace(/\]\([^)]*\)/g, ' ')
    .replace(/(\d)[,\s](?=\d{3}\b)/g, '$1')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}£€$₹]+/gu, ' ')
    .trim();

// A quote only counts as evidence if all of it is on the page the agent read.
const quoteOnPage = (quote, page) => {
  const q = normalize(quote);
  return q.length >= 12 && normalize(page).includes(q);
};

const hostOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
};

// Search results can carry any kind of address; only web pages get opened or linked.
const isWebUrl = (url) => /^https?:\/\//i.test(String(url ?? ''));

// Coordinates can arrive as numbers or numeric strings. A missing one would make
// the distance NaN, which lands in the long-haul band.
const hasCoordinates = (airport) => [airport.lat, airport.lon].every((v) => v != null && v !== '' && Number.isFinite(Number(v)));

// Compares the model's reading with the reference table. The table always sets
// the final figures; this decides whether the reading agreed and says how.
function judgeRuling(ruling, reference, regimeId) {
  const expected = verdictOf(reference.eligible);
  const verdict = ruling.eligible;
  const sameCurrency = ruling.currency?.toUpperCase() === reference.currency;
  const full = ruling.amount === reference.amount;
  const reduced = reference.reducedAmount > 0 && ruling.amount === reference.reducedAmount;
  // "depends" against "yes" with the same amount is a difference in caution,
  // not a different answer.
  const agrees = expected === 'no' ? verdict === 'no' : verdict !== 'no' && sameCurrency && (full || reduced);

  if (!agrees) {
    return {
      agrees,
      message: `Guardrail override: the reading gave “${verdict}, ${ruling.amount} ${ruling.currency}”, but the ${regimeId} table gives “${expected}, ${reference.amount} ${reference.currency}”. Using the table.`,
    };
  }
  if (expected === 'no') {
    return { agrees, message: `Guardrail passed: nothing owed under ${regimeId}, matching Claimback's built-in table.` };
  }
  let message = reduced
    ? `Guardrail passed: ${money(ruling.amount, reference.currency)} matches the reduced figure in Claimback's built-in ${regimeId} table (${money(reference.amount, reference.currency)} in full).`
    : `Guardrail passed: ${money(reference.amount, reference.currency)} matches Claimback's built-in ${regimeId} table.`;
  if (verdict === 'depends' && expected === 'yes') {
    message += ' The reading was more cautious, since the airline could still argue extraordinary circumstances.';
  } else if (verdict === 'yes' && expected === 'depends') {
    message += ' The reading was more certain than the table, which treats this as depending on facts flight data can’t show.';
  }
  return { agrees, message };
}

const RULING_SYSTEM = `You are a passenger-rights analyst deciding what one passenger is owed for one flight.
Base the decision on the official text you are given. Quote the exact sentences you rely on, copied character for character, so they can be checked against the page.
Delay is measured at arrival at the destination gate. EU and UK courts (Sturgeon, C-402/07) give arrival delays of 3 hours or more the same compensation as cancellations; apply that even if the text shown is only Article 7.
Put the full amount in "amount" (0 if nothing is owed). If the rules let the airline reduce it for this flight, put the reduced figure in "reducedAmount", otherwise 0. EU and UK regulators let the airline halve compensation under Article 7(2)(c) when a flight over 3,500 km arrives between 3 and 4 hours late: give the halved figure as reducedAmount and describe it as what the airline may pay instead of the full amount, not as the amount owed.
Extraordinary circumstances are for the airline to prove. If nothing in the facts points to them, answer "yes" and list them as a likely defence rather than answering "depends".
Answer "depends" only when the outcome hinges on something flight data can't show, such as how much notice was given for a cancellation.
Write "reasoning" as at most three plain sentences a passenger would understand.`;

const RULING_SCHEMA = {
  type: 'object',
  properties: {
    eligible: { type: 'string', enum: ['yes', 'no', 'depends'] },
    amount: { type: 'number' },
    reducedAmount: { type: 'number' },
    currency: { type: 'string', description: 'ISO currency code' },
    reasoning: { type: 'string' },
    citations: {
      type: 'array',
      items: {
        type: 'object',
        properties: { quote: { type: 'string' }, supports: { type: 'string' } },
        required: ['quote', 'supports'],
      },
    },
    airlineDefences: { type: 'array', items: { type: 'string' } },
  },
  required: ['eligible', 'amount', 'reducedAmount', 'currency', 'reasoning', 'citations', 'airlineDefences'],
};

const CAUSE_SYSTEM = `You check whether an airline could refuse delay compensation by citing extraordinary circumstances: severe weather, air-traffic-control restrictions or strikes, security alerts, political unrest, or a hidden manufacturing defect. Technical faults and crew shortages do not count.
You get web search results. Most will not be about this flight, so say so rather than guess. Only cite results that mention this flight, or a disruption at these airports on this date.`;

const CAUSE_SCHEMA = {
  type: 'object',
  properties: {
    assessment: { type: 'string', enum: ['likely_extraordinary', 'no_evidence', 'likely_airline_fault'] },
    reasoning: { type: 'string', description: 'At most two sentences.' },
    relevantSources: {
      type: 'array',
      items: {
        type: 'object',
        properties: { url: { type: 'string' }, title: { type: 'string' }, evidence: { type: 'string' } },
        required: ['url', 'title', 'evidence'],
      },
    },
  },
  required: ['assessment', 'reasoning', 'relevantSources'],
};

const CHOICE_SYSTEM = `Pick the page on the airline's own website where a passenger starts a compensation or delay claim: a claim form, or a customer-support form that accepts claims.
Never pick a claims agency, news article, forum or comparison site. If no result is on the airline's own site, return an empty url.`;

const CHOICE_SCHEMA = {
  type: 'object',
  properties: { url: { type: 'string' }, why: { type: 'string', description: 'One sentence.' } },
  required: ['url', 'why'],
};

const LETTER_SYSTEM = `Write a firm, polite compensation claim a passenger can send to an airline. Plain text, under 250 words.
State the flight, date, route, scheduled and actual arrival, the delay, the regulation and the amount claimed. Ask for payment within 14 days, and say the passenger will escalate to the regulator or an alternative dispute resolution scheme if it isn't paid.
Don't invent facts. Use a [bracketed placeholder] for anything you weren't given.`;

const LETTER_SCHEMA = {
  type: 'object',
  properties: { subject: { type: 'string' }, body: { type: 'string' } },
  required: ['subject', 'body'],
};

export function runClaim(input, emit) {
  return modelsUsed.run(new Set(), () => claimSteps(input, emit));
}

async function claimSteps({ flightNumber, date, passenger, skipForm = false }, emit) {
  let credits = 0;
  const models = () => [...(modelsUsed.getStore() ?? [])];
  const spend = (n) => {
    if (!n) return;
    credits += n;
    emit({ type: 'credits', total: credits });
  };
  const step = (id, phase, title) => emit({ type: 'step', id, phase, title });
  const tool = (stepId, name, detail, cost = 0) => {
    emit({ type: 'tool', step: stepId, name, detail, credits: cost });
    spend(cost);
  };
  const note = (stepId, text, extra = {}) => emit({ type: 'note', step: stepId, text, ...extra });
  const thought = (stepId, text) => emit({ type: 'thought', step: stepId, text });

  // 1. What happened to the flight
  step('flight', 'read', `Find out what happened to ${flightNumber} on ${date}`);
  const code = parseFlightNumber(flightNumber);
  if (!code) throw new Error(`“${flightNumber}” doesn't look like a flight number. Try something like AI162.`);
  const label = `${code.iata}${code.number}`;

  const airline = await resolveAirline(code.iata);
  if (!airline) throw new Error(`No airline uses the code ${code.iata}.`);
  tool('flight', airline.source, `${code.iata} is ${airline.name}, ICAO code ${airline.icao}`, airline.credits);
  if (airline.warning) note('flight', `${airline.warning}. Used the bundled table instead.`);

  const history = await flightHistory(`${airline.icao}${code.number}`);
  tool('flight', 'Anakin URL Scraper · FlightAware', history.url, history.credits);
  if (history.problem) throw new Error(`FlightAware had no usable data for ${label}: ${history.problem}.`);

  // A codeshare number resolves on FlightAware to the flight another airline
  // operated. Passenger-rights laws and claims follow the operating airline.
  let operator = airline;
  const flownBy = history.airline;
  if (flownBy?.iata && flownBy.iata !== airline.iata) {
    const resolved = await resolveAirline(flownBy.iata);
    if (resolved) {
      operator = resolved;
      tool('flight', resolved.source, `${flownBy.iata} is ${resolved.name}, which operated this flight`, resolved.credits);
      note('flight', `${label} is a codeshare operated by ${resolved.name}. The laws and the claim follow the operating airline.`);
    }
  }

  const raw = pickFlight(history.flights, date);
  if (!raw) {
    throw new Error(`FlightAware's recent history for ${label} has ${history.flights.length} flights and none left on ${date}. Claimback can check the last 14 days.`);
  }
  const flight = describeFlight(raw);
  if (flight.diverted) throw new Error(`${label} on ${date} was diverted. Claimback doesn't handle diversions yet.`);
  if (!flight.finished) throw new Error(`${label} on ${date} hasn't reached its gate yet, so there's nothing to claim.`);
  if (!flight.cancelled && flight.arrivalDelayMin == null) {
    throw new Error(`FlightAware has no scheduled arrival time for ${label} on ${date}, so the delay can't be measured.`);
  }

  emit({ type: 'flight', step: 'flight', flight: { label, airline: operator.name, date, ...flight } });
  if (flight.cancelled) {
    note('flight', `Cancelled. It was due to leave ${flight.origin.name} at ${flight.display.scheduledDeparture}.`);
  } else {
    const late = flight.arrivalDelayMin > 0 ? `, ${lateness(flight.arrivalDelayMin)} late` : ', on time';
    note('flight', `${flight.origin.name} to ${flight.destination.name}. Due at the gate ${flight.display.scheduledArrival}, got there ${flight.display.actualArrival}${late}.`);
  }

  // 2. A second, independent source
  step('verify', 'read', 'Cross-check the delay with a second source');
  try {
    const status = await airhelpStatus({ date, origin: flight.origin.iata, destination: flight.destination.iata, iata: code.iata, number: code.number });
    tool('verify', 'Anakin Wire · AirHelp flight status', `${status.listed} flights on ${flight.origin.iata} to ${flight.destination.iata} that day`, status.credits);
    const m = status.match;
    if (!m) {
      note('verify', `AirHelp doesn't list ${label} that day, so FlightAware's gate times stand alone.`);
    } else if ((m.arrival_status === 'cancelled') !== flight.cancelled) {
      note('verify', `The sources disagree on whether it was cancelled (AirHelp says ${m.arrival_status}). Going with FlightAware's gate records.`);
    } else if (flight.cancelled) {
      note('verify', 'AirHelp also lists it as cancelled.');
    } else if (m.delay_minutes == null) {
      note('verify', 'AirHelp lists the flight without a delay figure, so FlightAware stands alone.');
    } else {
      const gap = Math.abs(m.delay_minutes - flight.arrivalDelayMin);
      note('verify', gap <= 20
        ? `AirHelp reports ${m.delay_minutes} minutes late. The two sources agree.`
        : `AirHelp reports ${m.delay_minutes} minutes, ${gap} off FlightAware. The law measures delay at the gate, which is what FlightAware's times record, so those are used.`);
    }
  } catch (err) {
    note('verify', `The second source was unreachable (${err.message}). Continuing with FlightAware alone.`);
  }

  // 3. Which laws cover it
  step('law', 'reason', 'Work out which passenger-rights laws cover this flight');
  const [from, to] = await Promise.all([resolveAirport(flight.origin.iata), resolveAirport(flight.destination.iata)]);
  if (!from || !to) throw new Error(`Couldn't look up airport ${from ? flight.destination.iata : flight.origin.iata}.`);
  tool('law', from.source, `${from.name}, ${from.country} and ${to.name}, ${to.country}`, from.credits + to.credits);

  const unplaced = [from, to].find((a) => !hasCoordinates(a));
  if (unplaced) throw new Error(`Couldn't work out the flight distance: there are no coordinates for ${unplaced.iata}.`);
  const distanceKm = greatCircleKm(from, to);
  const regimes = applicableRegimes({ originCountry: from.countryCode, destinationCountry: to.countryCode, airlineCountry: operator.countryCode });
  note('law', `Great-circle distance: ${distanceKm.toLocaleString('en-GB')} km.`);
  for (const r of regimes) note('law', `${REGIME_NAMES[r.id]} applies: the flight ${r.why}.`);

  const facts = {
    flight: label,
    airline: operator.name,
    date,
    from: `${from.name} (${from.iata}), ${from.country}`,
    to: `${to.name} (${to.iata}), ${to.country}`,
    distanceKm,
    cancelled: flight.cancelled,
    arrivalDelayMinutes: flight.arrivalDelayMin,
    scheduledArrival: flight.display.scheduledArrival,
    actualArrival: flight.display.actualArrival,
  };
  const summary = { ...facts, fromCode: from.iata, toCode: to.iata, fromName: from.city || from.name, toName: to.city || to.name };

  if (!regimes.length) {
    const claim = {
      verdict: 'not_covered',
      flight: summary,
      reasons: ['No passenger-rights law with fixed compensation covers this route and airline. The Montreal Convention still lets you claim proven costs caused by the delay.'],
      models: models(),
      credits,
    };
    emit({ type: 'result', claim });
    return claim;
  }

  // 4. Read the official rules and decide, checked against the reference table
  const intraEU = isEU(from.countryCode) && isEU(to.countryCode);
  const assessments = [];
  for (const regime of regimes) {
    const reference = referenceCompensation({
      regime: regime.id, distanceKm, arrivalDelayMin: flight.arrivalDelayMin ?? 0, cancelled: flight.cancelled, intraEU,
    });
    // The table always sets the final figures; the reading supplies the reasoning
    // and the evidence, and a disagreement is surfaced.
    const final = { eligible: verdictOf(reference.eligible), amount: reference.amount, reducedAmount: reference.reducedAmount, currency: reference.currency };
    const source = OFFICIAL_SOURCES[regime.id];
    if (!source) {
      note('law', `${REGIME_NAMES[regime.id]}: ${reference.note}`);
      assessments.push({ regime: regime.id, reference, final, defences: [], citations: [] });
      continue;
    }

    const stepId = `rules-${regime.id}`;
    step(stepId, 'reason', `Read the official ${REGIME_NAMES[regime.id]} text and decide`);
    let page;
    let ruling;
    try {
      page = await scrape(source.url);
      tool(stepId, 'Anakin URL Scraper', source.url, page.credits);
      ruling = await askJson({
        system: RULING_SYSTEM,
        prompt: `Regime: ${REGIME_NAMES[regime.id]} (${regime.id})\nFlight facts (FlightAware gate times, cross-checked):\n${JSON.stringify(facts, null, 2)}\n\nOfficial text from ${source.url}:\n"""\n${(page.markdown ?? '').slice(0, 45_000)}\n"""`,
        schema: RULING_SCHEMA,
      });
    } catch (err) {
      // The table can decide alone, so losing the page or the model shouldn't lose the claim.
      note(stepId, `Couldn't read or reason over the official text (${err.message.split('\n')[0]}). Claimback's built-in ${regime.id} table decides instead.`);
      assessments.push({ regime: regime.id, reference, final, defences: [], citations: [] });
      continue;
    }
    thought(stepId, ruling.reasoning);

    const citations = ruling.citations.slice(0, 3).map((c) => ({ ...c, verified: quoteOnPage(c.quote, page.markdown) }));
    for (const c of citations) emit({ type: 'source', step: stepId, url: source.url, title: source.title, quote: c.quote, supports: c.supports, verified: c.verified });

    const { agrees, message } = judgeRuling(ruling, reference, regime.id);
    note(stepId, message, { guardrail: agrees ? 'pass' : 'override' });

    assessments.push({ regime: regime.id, reference, final, defences: ruling.airlineDefences, citations, source });
  }

  const rank = { yes: 2, depends: 1 };
  const best = assessments
    .filter((a) => a.final.eligible !== 'no' && a.final.amount > 0)
    .sort((a, b) => rank[b.final.eligible] - rank[a.final.eligible])[0];

  if (!best) {
    const claim = {
      verdict: 'not_owed',
      flight: summary,
      reasons: assessments.map((a) => `${REGIME_NAMES[a.regime]}: ${a.reference.note}`),
      models: models(),
      credits,
    };
    emit({ type: 'result', claim });
    return claim;
  }

  const amountText = money(best.final.amount, best.final.currency);
  const reducedText = best.final.reducedAmount ? money(best.final.reducedAmount, best.final.currency) : null;

  // 5. Could the airline blame extraordinary circumstances?
  let cause = null;
  if (process.env.ANAKIN_API_KEY) {
    step('cause', 'reason', 'Look for extraordinary circumstances the airline could cite');
    try {
      const query = `${operator.name} ${label} ${date} ${from.city} ${to.city} delay`;
      const { results, credits: cost } = await search(query, 6);
      tool('cause', 'Anakin Search', query, cost);
      cause = await askJson({
        system: CAUSE_SYSTEM,
        prompt: JSON.stringify({ facts, searchResults: results.map(({ title, url, snippet, date: published }) => ({ title, url, snippet, published })) }),
        schema: CAUSE_SCHEMA,
      });
      thought('cause', cause.reasoning);
      for (const s of cause.relevantSources) {
        if (isWebUrl(s.url) && results.some((r) => r.url === s.url)) emit({ type: 'source', step: 'cause', url: s.url, title: s.title, quote: s.evidence, verified: null });
      }
    } catch (err) {
      note('cause', `Skipped: ${err.message}`);
    }
  }

  const claimFacts = {
    passenger,
    flight: {
      number: label,
      airline: operator.name,
      date,
      from: facts.from,
      to: facts.to,
      scheduledArrival: facts.scheduledArrival,
      actualArrival: facts.actualArrival,
      arrivalDelayMinutes: facts.arrivalDelayMinutes,
      cancelled: facts.cancelled,
    },
    claim: {
      regulation: REGIME_NAMES[best.regime],
      amount: amountText,
      reason: flight.cancelled ? 'Flight cancelled' : `Arrived ${lateness(flight.arrivalDelayMin)} late`,
    },
  };

  // 6. Fill in the airline's claim form
  let filing = null;
  if (!skipForm) {
    step('form', 'act', `Fill in ${operator.name}'s claim form`);
    if (!process.env.ANAKIN_API_KEY) {
      note('form', 'Skipped: finding and filling the form needs an Anakin API key for Search and the cloud browser.');
    } else {
      try {
        filing = await fileClaim({ airline: operator, history, best, claimFacts, country: from.countryCode, emit, tool, note, thought });
      } catch (err) {
        note('form', `Stopped: ${err.message.split('\n')[0]}`);
      }
    }
  }

  // 7. The letter, for email or for the form's free-text box. The verdict stands
  // without it, so a failure here doesn't lose the result.
  step('letter', 'act', 'Write the claim letter');
  let letter = null;
  try {
    letter = await askJson({
      system: LETTER_SYSTEM,
      prompt: JSON.stringify({ ...claimFacts, reducedAmountIfAirlineAppliesReduction: reducedText, likelyDefences: best.defences }),
      schema: LETTER_SCHEMA,
    });
    emit({ type: 'letter', step: 'letter', subject: letter.subject, body: letter.body });
  } catch (err) {
    note('letter', `Couldn't write the letter: ${err.message.split('\n')[0]}`);
  }

  const claim = {
    verdict: best.final.eligible === 'yes' ? 'owed' : 'likely',
    regime: best.regime,
    regimeName: REGIME_NAMES[best.regime],
    amount: best.final.amount,
    reducedAmount: best.final.reducedAmount,
    currency: best.final.currency,
    amountText,
    reducedText,
    flight: summary,
    reasons: [best.reference.note],
    others: assessments.filter((a) => a !== best).map((a) => ({ regime: a.regime, name: REGIME_NAMES[a.regime], note: a.reference.note })),
    defences: best.defences,
    cause: cause && { assessment: cause.assessment, reasoning: cause.reasoning },
    filing: filing && {
      url: filing.url,
      reason: filing.reason,
      fieldsFilled: filing.filled.filter((f) => f.op !== 'click').length,
      recordingUrl: filing.recording?.videoUrl ?? null,
    },
    letter,
    models: models(),
    credits,
  };
  emit({ type: 'result', claim });
  return claim;
}

async function fileClaim({ airline, history, best, claimFacts, country, emit, tool, note, thought }) {
  const domain = hostOf(history.airline?.url);
  const query = `${airline.name} ${best.regime} flight delay compensation claim form`;
  const { results: found, credits } = await search(query, 8);
  tool('form', 'Anakin Search', query, credits);
  const results = found.filter((r) => isWebUrl(r.url));

  const own = domain ? results.filter((r) => hostOf(r.url).endsWith(domain)) : [];
  const choice = await askJson({
    system: CHOICE_SYSTEM,
    prompt: JSON.stringify({
      airline: airline.name,
      officialDomain: domain || 'unknown',
      results: (own.length ? own : results).map(({ title, url, snippet }) => ({ title, url, snippet })),
    }),
    schema: CHOICE_SCHEMA,
  });
  if (!choice.url || !results.some((r) => r.url === choice.url)) {
    note('form', `No online claim form turned up on ${domain || 'the airline’s site'}. The letter below can be sent by email instead.`);
    return null;
  }
  thought('form', choice.why);

  // Connect from the departure country, where a passenger making this claim would be.
  const session = await openBrowser({ record: true, country });
  note('form', session.country
    ? `Opened a recorded Anakin cloud browser on ${hostOf(choice.url)}, connecting from ${session.country} to match the departure airport.`
    : `Opened a recorded Anakin cloud browser on ${hostOf(choice.url)}.`);
  let result;
  let endedAt;
  try {
    result = await fillClaimForm({ page: session.page, url: choice.url, facts: claimFacts, emit, step: 'form' });
  } finally {
    await session.browser.close().catch(() => {});
    endedAt = Date.now();
    const minutes = Math.max(1, Math.round((endedAt - session.startedAt) / 60_000));
    tool('form', 'Anakin Browser API', `Recorded cloud-browser session, about ${minutes} min`, browserCredits(session.startedAt));
  }
  note('form', result.reason);

  const recording = await findRecording(session.startedAt, 60_000, { endedAt }).catch(() => null);
  if (recording?.videoUrl) emit({ type: 'recording', step: 'form', url: recording.videoUrl });
  return { url: choice.url, ...result, recording };
}
