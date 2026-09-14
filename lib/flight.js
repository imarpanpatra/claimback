// Establishes what happened to a flight from two independent sources:
// FlightAware's flight history (scraped through Anakin) and AirHelp's flight
// status listing (an Anakin Wire action). Airline and airport details come from
// AirHelp through Wire too, with bundled OpenFlights tables as a fallback.
import { readFileSync } from 'node:fs';
import { scrape, wire } from './anakin.js';
import { countryCodeFromName } from './rules.js';

const load = (name) => JSON.parse(readFileSync(new URL(`../data/${name}`, import.meta.url), 'utf8'));
const AIRLINES = load('airlines.json');
const AIRPORTS = load('airports.json');

export function parseFlightNumber(raw) {
  const m = String(raw ?? '').toUpperCase().replace(/[\s-]/g, '').match(/^([A-Z0-9]{2})(\d{1,4})([A-Z]?)$/);
  if (!m || /^\d{2}$/.test(m[1])) return null;
  return { iata: m[1], number: `${Number(m[2])}${m[3]}` };
}

export async function resolveAirline(iata) {
  let warning = null;
  try {
    const { data, credits } = await wire('act_airhelp_airline_autocomplete', { airline_query: iata });
    const matches = (data?.items ?? []).filter((a) => a.iata === iata && a.icao);
    const hit = matches.find((a) => a.active) ?? matches[0];
    if (hit) {
      return {
        source: 'Anakin Wire · AirHelp airline lookup',
        credits,
        iata,
        icao: hit.icao,
        name: hit.title.replace(/\s*\([^)]*\)\s*$/, ''),
        countryCode: hit.country_code,
      };
    }
    warning = `AirHelp has no airline with code ${iata}`;
  } catch (err) {
    warning = `AirHelp lookup failed: ${err.message}`;
  }
  const local = AIRLINES[iata]?.find((a) => a.active) ?? AIRLINES[iata]?.[0];
  if (!local) return null;
  return {
    source: 'OpenFlights airline table',
    credits: 0,
    warning,
    iata,
    icao: local.icao,
    name: local.name,
    countryCode: countryCodeFromName(local.country),
  };
}

export async function resolveAirport(iata) {
  let warning = null;
  try {
    const { data, credits } = await wire('act_airhelp_airport_autocomplete', { airport_query: iata });
    const hit = (data?.items ?? []).find((a) => a.iata === iata);
    if (hit) {
      return {
        source: 'Anakin Wire · AirHelp airport lookup',
        credits,
        iata,
        name: hit.name,
        city: hit.city,
        country: hit.country,
        countryCode: hit.country_code,
        lat: hit.latitude,
        lon: hit.longitude,
      };
    }
    warning = `AirHelp has no airport with code ${iata}`;
  } catch (err) {
    warning = `AirHelp lookup failed: ${err.message}`;
  }
  const local = AIRPORTS[iata];
  if (!local) return null;
  return {
    source: 'OpenFlights airport table',
    credits: 0,
    warning,
    iata,
    name: local.name,
    city: local.city,
    country: local.country,
    countryCode: countryCodeFromName(local.country),
    lat: local.lat,
    lon: local.lon,
  };
}

// FlightAware embeds the last ~14 days of a flight as JSON in the page. It only
// resolves ICAO idents (BAW117, not BA117).
export async function flightHistory(ident) {
  const url = `https://www.flightaware.com/live/flight/${ident}`;
  const page = await scrape(url);
  const html = page.html ?? '';
  const result = { url, credits: page.credits, airline: null, flights: [], problem: null };

  const at = html.indexOf('trackpollBootstrap = ');
  if (at < 0) return { ...result, problem: 'the page had no flight data block' };
  const start = html.indexOf('{', at);
  const end = html.indexOf(';</script>', start);
  let boot;
  try {
    boot = JSON.parse(html.slice(start, end));
  } catch {
    return { ...result, problem: 'the flight data block could not be parsed' };
  }
  const main = Object.values(boot.flights ?? {})[0];
  if (!main) return { ...result, problem: 'the flight data block was empty' };
  return { ...result, airline: main.airline ?? null, flights: main.activityLog?.flights ?? [] };
}

const tzOf = (airport) => (airport?.TZ ?? 'UTC').replace(/^:/, '');

const localDate = (sec, timeZone) =>
  new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(sec * 1000));

const localTime = (sec, timeZone) =>
  sec
    ? new Intl.DateTimeFormat('en-GB', { timeZone, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(sec * 1000))
    : null;

const iso = (sec) => (sec ? new Date(sec * 1000).toISOString() : null);

export function pickFlight(flights, date) {
  return flights.find((f) => f.gateDepartureTimes?.scheduled && localDate(f.gateDepartureTimes.scheduled, tzOf(f.origin)) === date) ?? null;
}

export function describeFlight(f) {
  const dep = f.gateDepartureTimes ?? {};
  const arr = f.gateArrivalTimes ?? {};
  const originTz = tzOf(f.origin);
  const destTz = tzOf(f.destination);
  const airport = (a) => ({ iata: a?.iata ?? a?.icao, name: a?.friendlyName, location: a?.friendlyLocation });

  return {
    origin: airport(f.origin),
    destination: airport(f.destination),
    scheduledDeparture: iso(dep.scheduled),
    actualDeparture: iso(dep.actual),
    scheduledArrival: iso(arr.scheduled),
    actualArrival: iso(arr.actual),
    display: {
      scheduledDeparture: localTime(dep.scheduled, originTz),
      actualDeparture: localTime(dep.actual, originTz),
      scheduledArrival: localTime(arr.scheduled, destTz),
      actualArrival: localTime(arr.actual, destTz),
    },
    // The law measures delay at arrival at the gate, which is what these times
    // record. Round down, so 179.5 minutes never counts as the 3 hours the law needs.
    arrivalDelayMin: arr.scheduled && arr.actual ? Math.floor((arr.actual - arr.scheduled) / 60) : null,
    cancelled: Boolean(f.cancelled),
    diverted: Boolean(f.diverted),
    aircraft: f.aircraftTypeFriendly ?? null,
    finished: Boolean(arr.actual) || Boolean(f.cancelled),
  };
}

export async function airhelpStatus({ date, origin, destination, iata, number }) {
  const [y, m, d] = date.split('-');
  const { data, credits } = await wire('act_airhelp_flight_status_listing', {
    local_departure_date: `${d}-${m}-${y}`,
    departure_airport_code: origin,
    arrival_airport_code: destination,
  });
  const items = data?.items ?? [];
  const match = items.find((i) => i.airline_code === iata && i.flight_number === number) ?? null;
  return { credits, listed: items.length, match };
}
