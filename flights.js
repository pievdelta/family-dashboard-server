// Flights on the dashboard (server 5.13, optional): any calendar event with a flight number
// ("DL 1234", "Delta 1234", "Flight to Orlando (DL 1234)") is tracked on the TVs.
//
//   FlightAware AeroAPI (the family's own key): status, delays, gates, terminals, times.
//     Checked every 30 min until 3 h before departure, then every 8 min until it lands,
//     within a monthly budget (Personal tier: $0.005 per check, first $5 a month free).
//   OpenSky Network (optional keys): where the plane is while it's in the air. Without it,
//     the plane is placed along its route by FlightAware's progress.
//
// Family flights get a leave-by time (drive to the airport plus a buffer, or for a pickup,
// to be there when they land) and alerts. Client flights (the work calendar, or "client"
// in the event) just show their status. Settings and keys live in flights.json.

import fs from 'fs';

/** Airlines people write in calendars: IATA code -> [ICAO code, name, other names]. */
export const AIRLINES = {
  AA: ['AAL', 'American'], DL: ['DAL', 'Delta'], UA: ['UAL', 'United'], WN: ['SWA', 'Southwest'],
  B6: ['JBU', 'JetBlue'], NK: ['NKS', 'Spirit'], F9: ['FFT', 'Frontier'], AS: ['ASA', 'Alaska'],
  HA: ['HAL', 'Hawaiian'], G4: ['AAY', 'Allegiant'], SY: ['SCX', 'Sun Country'], MX: ['MXY', 'Breeze'],
  XP: ['VXP', 'Avelo'], AC: ['ACA', 'Air Canada'], WS: ['WJA', 'WestJet'], PD: ['POE', 'Porter'],
  BA: ['BAW', 'British Airways'], VS: ['VIR', 'Virgin Atlantic'], LH: ['DLH', 'Lufthansa'],
  AF: ['AFR', 'Air France'], KL: ['KLM', 'KLM'], IB: ['IBE', 'Iberia'], EI: ['EIN', 'Aer Lingus'],
  LX: ['SWR', 'Swiss'], OS: ['AUA', 'Austrian'], SK: ['SAS', 'SAS'], AY: ['FIN', 'Finnair'],
  TP: ['TAP', 'TAP'], AZ: ['ITY', 'ITA'], FI: ['ICE', 'Icelandair'], U2: ['EZY', 'easyJet'],
  FR: ['RYR', 'Ryanair'], EK: ['UAE', 'Emirates'], QR: ['QTR', 'Qatar'], EY: ['ETD', 'Etihad'],
  TK: ['THY', 'Turkish'], AM: ['AMX', 'Aeromexico'], Y4: ['VOI', 'Volaris'], VB: ['VIV', 'Viva Aerobus'],
  CM: ['CMP', 'Copa'], AV: ['AVA', 'Avianca'], LA: ['LAN', 'LATAM'], JL: ['JAL', 'Japan Airlines'],
  NH: ['ANA', 'ANA'], CX: ['CPA', 'Cathay Pacific'], SQ: ['SIA', 'Singapore'], QF: ['QFA', 'Qantas'],
  NZ: ['ANZ', 'Air New Zealand'], KE: ['KAL', 'Korean Air'], OZ: ['AAR', 'Asiana'], BW: ['BWA', 'Caribbean'],
  '4O': ['AIJ', 'Interjet'], OO: ['SKW', 'SkyWest'], YX: ['RPA', 'Republic'], '9E': ['EDV', 'Endeavor'],
  MQ: ['ENY', 'Envoy'], OH: ['JIA', 'PSA'], QX: ['QXE', 'Horizon'], YV: ['ASH', 'Mesa'], G7: ['GJS', 'GoJet'],
  ZW: ['AWI', 'Air Wisconsin'], C5: ['UCA', 'CommutAir'], '3M': ['SIL', 'Silver'], '9K': ['KAP', 'Cape Air']
};
const NAME_TO_CODE = {};
for (const [code, [, name]] of Object.entries(AIRLINES)) NAME_TO_CODE[name.toLowerCase()] = code;
Object.assign(NAME_TO_CODE, { 'american airlines': 'AA', 'delta air lines': 'DL', 'united airlines': 'UA', 'southwest airlines': 'WN',
  'alaska airlines': 'AS', 'hawaiian airlines': 'HA', 'spirit airlines': 'NK', 'frontier airlines': 'F9', 'allegiant air': 'G4', 'breeze airways': 'MX' });

export const FLIGHT_DEFAULTS = { enabled: false, aeroKey: '', openSkyId: '', openSkySecret: '', bufferMin: 120, workIsClients: true, monthlyDollars: 5 };

export function readFlightSettings(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      enabled: j.enabled === true,
      aeroKey: String(j.aeroKey || '').trim(),
      openSkyId: String(j.openSkyId || '').trim(),
      openSkySecret: String(j.openSkySecret || '').trim(),
      bufferMin: Math.min(240, Math.max(30, Math.round(Number(j.bufferMin) || 120))),
      workIsClients: j.workIsClients !== false,
      monthlyDollars: Math.min(100, Math.max(0, Number(j.monthlyDollars ?? 5)))
    };
  } catch (e) {
    return { ...FLIGHT_DEFAULTS };
  }
}

// ---- finding flights in calendar events --------------------------------------------------

/**
 * The flight in an event, or null: { airline, number, code: "DL 1234" }.
 * The airline has to be one we know, so "Room 12" or "Grade 3" never count.
 */
const MAJOR = new Set(['AA', 'DL', 'UA', 'WN', 'B6', 'NK', 'F9', 'AS', 'HA', 'G4', 'AC', 'WS', 'BA', 'VS', 'LH', 'AF', 'KL', 'EK', 'QR', 'TK', 'IB', 'EI', 'AM', 'Y4', 'CM', 'AV', 'JL', 'NH', 'QF', 'SQ', 'CX', 'KE']);
const FLIGHTY = /flight|flying|fly to|✈|airport|depart|arriv|lands?\b|landing|pick\s?-?up|layover|boarding/i;

export function findFlight(text) {
  const t = String(text || '');
  const context = FLIGHTY.test(t);
  // "DL 1234", "DL1234", "(DL 1234)", "B6 815"
  const codeRe = /(?:^|[^A-Za-z0-9])([A-Z][A-Z0-9]|[0-9][A-Z])\s?(\d{1,4})(?![0-9])/g;
  let m;
  while ((m = codeRe.exec(t))) {
    const air = m[1].toUpperCase();
    // a big airline with a real-looking number, or any airline when the event talks about flying
    if (AIRLINES[air] && (context || (MAJOR.has(air) && m[2].length >= 2))) return { airline: air, number: String(Number(m[2])), code: `${air} ${Number(m[2])}` };
  }
  // "Delta 1234", "Southwest flight 1234", "United Airlines #45"
  const names = Object.keys(NAME_TO_CODE).sort((a, b) => b.length - a.length).map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const nameRe = new RegExp(`\\b(${names.join('|')})\\s+(?:flight\\s+|fl\\.?\\s*)?#?(\\d{1,4})\\b`, 'i');
  const n = nameRe.exec(t);
  if (n) { const air = NAME_TO_CODE[n[1].toLowerCase()]; return { airline: air, number: String(Number(n[2])), code: `${air} ${Number(n[2])}` }; }
  return null;
}

/** Pickups: someone else's flight the family meets at the airport. */
export function isPickup(text) {
  return /\b(pick\s?-?up|picking up|meet(ing)?\s+\w+\s+at|airport run|arriv(es|ing)|lands?\b|landing)/i.test(String(text || ''));
}

export function isClientEvent(ev, settings) {
  return (settings.workIsClients && ev.sourceType === 'work') || /\bclients?\b/i.test(`${ev.title || ''} ${ev.description || ''}`);
}

// ---- geometry --------------------------------------------------------------------------------

const rad = (d) => (d * Math.PI) / 180, deg = (r) => (r * 180) / Math.PI;
export function milesBetween(a, b) {
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 3958.8 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}
/** A point part of the way along the great circle from a to b (f from 0 to 1). */
export function alongRoute(a, b, f) {
  const p1 = rad(a.lat), l1 = rad(a.lon), p2 = rad(b.lat), l2 = rad(b.lon);
  const d = 2 * Math.asin(Math.sqrt(Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin((l2 - l1) / 2) ** 2));
  if (d < 1e-9) return { lat: a.lat, lon: a.lon };
  const A = Math.sin((1 - f) * d) / Math.sin(d), B = Math.sin(f * d) / Math.sin(d);
  const x = A * Math.cos(p1) * Math.cos(l1) + B * Math.cos(p2) * Math.cos(l2);
  const y = A * Math.cos(p1) * Math.sin(l1) + B * Math.cos(p2) * Math.sin(l2);
  const z = A * Math.sin(p1) + B * Math.sin(p2);
  return { lat: deg(Math.atan2(z, Math.sqrt(x * x + y * y))), lon: deg(Math.atan2(y, x)) };
}
export function bearing(a, b) {
  const y = Math.sin(rad(b.lon - a.lon)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon - a.lon));
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

// ---- FlightAware's answer, read defensively ------------------------------------------------------

const ms = (s) => { const t = s ? Date.parse(s) : NaN; return Number.isFinite(t) ? t : null; };

/** The flight in AeroAPI's list that matches the calendar's departure time best. */
export function pickAeroFlight(list, startMs) {
  const objs = (Array.isArray(list) ? list : []).filter(f => f && typeof f === 'object');
  if (!objs.length) return null;
  let best = null, bestGap = Infinity;
  for (const f of objs) {
    const t = ms(f.scheduled_out) ?? ms(f.scheduled_off);
    if (t == null) continue;
    const gap = Math.abs(t - startMs);
    if (gap < bestGap) { bestGap = gap; best = f; }
  }
  // more than a day off: a different trip on the same flight number
  return bestGap <= 26 * 3600 * 1000 ? best : null;
}

/** What the family needs from one AeroAPI flight record. */
export function readAero(f) {
  const place = (p) => (p && typeof p === 'object' ? { code: String(p.code_iata || p.code || '').toUpperCase(), icao: String(p.code_icao || ''), name: String(p.name || ''), city: String(p.city || ''), tz: String(p.timezone || '') } : null);
  return {
    faId: String(f.fa_flight_id || ''),
    callsign: String(f.ident_icao || f.ident || '').replace(/\s+/g, ''),
    status: String(f.status || ''),
    cancelled: f.cancelled === true,
    diverted: f.diverted === true,
    origin: place(f.origin),
    destination: place(f.destination),
    schedOut: ms(f.scheduled_out), estOut: ms(f.estimated_out), actOut: ms(f.actual_out),
    actOff: ms(f.actual_off),
    schedIn: ms(f.scheduled_in), estIn: ms(f.estimated_in) ?? ms(f.estimated_on), actIn: ms(f.actual_in),
    estOn: ms(f.estimated_on), actOn: ms(f.actual_on),
    gateOut: f.gate_origin ? String(f.gate_origin) : '', termOut: f.terminal_origin ? String(f.terminal_origin) : '',
    gateIn: f.gate_destination ? String(f.gate_destination) : '', termIn: f.terminal_destination ? String(f.terminal_destination) : '',
    baggage: f.baggage_claim ? String(f.baggage_claim) : '',
    progress: Number.isFinite(Number(f.progress_percent)) ? Number(f.progress_percent) : null,
    delayOutMin: Number.isFinite(Number(f.departure_delay)) ? Math.round(Number(f.departure_delay) / 60) : null,
    delayInMin: Number.isFinite(Number(f.arrival_delay)) ? Math.round(Number(f.arrival_delay) / 60) : null,
    aircraft: f.aircraft_type ? String(f.aircraft_type) : ''
  };
}

/** One short word for where the flight is: what a TV shows big. */
export function phaseOf(a, nowMs) {
  if (!a) return 'scheduled';
  if (a.cancelled) return 'cancelled';
  if (a.diverted) return 'diverted';
  if (a.actIn || /arrived|gate arrival/i.test(a.status)) return 'arrived';
  if (a.actOn || /landed/i.test(a.status)) return 'landed';
  if (a.actOff || /en route|airborne/i.test(a.status)) return 'air';
  if (a.actOut || /taxi/i.test(a.status)) return 'taxiing';
  const delay = a.delayOutMin ?? ((a.estOut && a.schedOut) ? Math.round((a.estOut - a.schedOut) / 60000) : 0);
  if (delay >= 15) return 'delayed';
  return 'ontime';
}
const PHASE_TEXT = { scheduled: 'Scheduled', ontime: 'On time', delayed: 'Delayed', taxiing: 'Leaving the gate', air: 'In the air', landed: 'Landed', arrived: 'At the gate', cancelled: 'Cancelled', diverted: 'Diverted' };

// ---- the flights service ---------------------------------------------------------------------------

export function createFlights({
  file, usageFile, airportsFile, log = console.log, now = () => Date.now(), fetchImpl = (...a) => fetch(...a),
  events = () => [], memberOf = () => [], memberName = (id) => id, memberColor = () => '0x7DD3FCFF',
  home = () => null, driveTo = async () => null, timeIn = (msv, tz) => new Date(msv).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz || undefined }),
  aeroBase = 'https://aeroapi.flightaware.com/aeroapi', openSkyBase = 'https://opensky-network.org/api',
  openSkyAuth = 'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token'
}) {
  let settings = readFlightSettings(file);
  const airports = new Map();
  try { for (const [code, name, city, lat, lon] of JSON.parse(fs.readFileSync(airportsFile, 'utf8'))) airports.set(code, { code, name, city, lat, lon }); } catch (e) { log(`[Flights] No airport list: ${e.message}`); }
  const tracked = new Map();   // key -> { flight, ev, aero, checkedAt, nextAt, problem, pos, posAt, icao24, alerted, trip }
  const alertList = [];
  let usage = { month: '', calls: 0 };
  try { usage = JSON.parse(fs.readFileSync(usageFile, 'utf8')); } catch (e) { /* first month */ }
  let timer = null, busy = false, lastProblem = null;
  let osToken = null, osTokenUntil = 0;
  const say = (m) => log(`[Flights] ${m}`);

  const monthKey = () => new Date(now()).toISOString().slice(0, 7);
  const budgetCalls = () => Math.floor(settings.monthlyDollars / 0.005);
  function spend() {
    if (usage.month !== monthKey()) usage = { month: monthKey(), calls: 0 };
    usage.calls++;
    try { fs.writeFileSync(usageFile, JSON.stringify(usage)); } catch (e) { /* not critical */ }
  }
  function canSpend() {
    if (usage.month !== monthKey()) usage = { month: monthKey(), calls: 0 };
    return usage.calls < budgetCalls();
  }

  function airport(code) { return code ? airports.get(String(code).toUpperCase()) || null : null; }

  /** Calendar events with a flight in them, from 14 hours ago to 36 hours ahead. */
  function scan() {
    const t = now(), seen = new Set();
    for (const ev of events()) {
      if (!ev || !ev.startMs || ev.startMs < t - 14 * 3600e3 || ev.startMs > t + 36 * 3600e3) continue;
      const text = `${ev.title || ''}  ${ev.location || ''}  ${ev.description || ''}`;
      const f = findFlight(text);
      if (!f) continue;
      const day = new Date(ev.startMs).toISOString().slice(0, 10);
      const key = `${f.airline}${f.number}-${day}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const client = isClientEvent(ev, settings);
      const pickup = !client && isPickup(text);
      const members = client ? [] : memberOf(ev);
      const prev = tracked.get(key);
      // airports written in the event ("ATL to MCO", "ATL-MCO", "(ATL)") until FlightAware says
      const codes = (text.match(/\b[A-Z]{3}\b/g) || []).filter(c => airports.has(c));
      tracked.set(key, {
        key, flight: f, ev: { title: ev.title, startMs: ev.startMs, endMs: ev.endMs || ev.startMs, location: ev.location || '' },
        kind: client ? 'client' : 'family', pickup, members,
        guessFrom: codes[0] || '', guessTo: codes[1] || '',
        aero: prev?.aero || null, checkedAt: prev?.checkedAt || 0, nextAt: prev?.nextAt || 0, problem: prev?.problem || null,
        pos: prev?.pos || null, posAt: prev?.posAt || 0, icao24: prev?.icao24 || '', alerted: prev?.alerted || {}, done: prev?.done || false,
        trip: prev?.trip || null
      });
    }
    for (const k of [...tracked.keys()]) if (!seen.has(k)) tracked.delete(k);
  }

  /** How long until this flight is worth checking again. */
  function nextCheck(x) {
    const t = now(), a = x.aero;
    if (x.done) return Infinity;
    if (!a) return x.problem ? 2 * 3600e3 : 0;
    const p = phaseOf(a, t);
    if (p === 'cancelled') return Infinity;
    if (p === 'arrived') return Infinity;
    if (p === 'landed') return 10 * 60e3;
    const out = a.estOut || a.schedOut || x.ev.startMs;
    if (p === 'air' || p === 'taxiing') return 8 * 60e3;
    if (out - t > 3 * 3600e3) return 30 * 60e3;
    return 8 * 60e3;
  }

  async function checkAero(x) {
    if (!settings.aeroKey) return;
    if (!canSpend()) { lastProblem = `The monthly FlightAware limit ($${settings.monthlyDollars}) is used up; flights show their calendar times until next month.`; return; }
    const [icao] = AIRLINES[x.flight.airline] || [];
    const ident = icao ? `${icao}${x.flight.number}` : `${x.flight.airline}${x.flight.number}`;
    spend();
    try {
      const r = await fetchImpl(`${aeroBase}/flights/${encodeURIComponent(ident)}?max_pages=1`, { headers: { 'x-apikey': settings.aeroKey, Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
      if (r.status === 401 || r.status === 403) { lastProblem = "FlightAware didn't accept the key."; x.problem = lastProblem; return; }
      if (r.status === 429) { lastProblem = 'FlightAware asked us to slow down; trying again shortly.'; return; }
      if (!r.ok) { x.problem = `FlightAware answered ${r.status}.`; return; }
      const j = await r.json();
      const f = pickAeroFlight(j.flights, x.ev.startMs);
      if (!f) { x.problem = 'FlightAware has no record of this flight yet (it lists flights about two days ahead).'; return; }
      const before = x.aero;
      x.aero = readAero(f);
      x.problem = null;
      lastProblem = null;
      noticeChanges(x, before);
      if (phaseOf(x.aero) === 'arrived' || phaseOf(x.aero) === 'cancelled') x.done = true;
    } catch (e) {
      x.problem = `Couldn't reach FlightAware (${e.message}).`;
    } finally {
      x.checkedAt = now();
    }
  }

  // ---- where the plane is -------------------------------------------------------------------
  async function openSkyToken() {
    if (!settings.openSkyId || !settings.openSkySecret) return null;
    if (osToken && now() < osTokenUntil - 60e3) return osToken;
    const r = await fetchImpl(openSkyAuth, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=client_credentials&client_id=${encodeURIComponent(settings.openSkyId)}&client_secret=${encodeURIComponent(settings.openSkySecret)}`,
      signal: AbortSignal.timeout(10000)
    });
    if (!r.ok) throw new Error(`OpenSky didn't accept the client ID and secret (${r.status})`);
    const j = await r.json();
    osToken = j.access_token; osTokenUntil = now() + (Number(j.expires_in) || 1800) * 1000;
    return osToken;
  }

  /** One OpenSky call for every plane in the air: by radio ID when we know them all (1 credit), else everything (4). */
  async function locate(list) {
    const flying = list.filter(x => x.aero && x.aero.callsign);
    if (!flying.length) return;
    try {
      const token = await openSkyToken();
      const headers = token ? { Authorization: `Bearer ${token}` } : {};
      const known = flying.every(x => x.icao24);
      const url = known ? `${openSkyBase}/states/all?${flying.map(x => `icao24=${x.icao24}`).join('&')}` : `${openSkyBase}/states/all`;
      const r = await fetchImpl(url, { headers, signal: AbortSignal.timeout(20000) });
      for (const x of flying) x.posAt = now(); // asked, whatever the answer: try again in a minute and a half
      if (!r.ok) return;
      const j = await r.json();
      for (const x of flying) {
        const row = (j.states || []).find(st => Array.isArray(st) && String(st[1] || '').trim().toUpperCase() === x.aero.callsign.toUpperCase());
        if (!row) { x.icao24 = ''; continue; }
        x.icao24 = String(row[0] || '');
        if (Number.isFinite(row[6]) && Number.isFinite(row[5])) {
          const alt = row[7] ?? row[13];
          x.pos = { lat: row[6], lon: row[5], track: Number.isFinite(row[10]) ? Math.round(row[10]) : null,
            altFt: Number.isFinite(alt) ? Math.round(alt * 3.28084) : null,
            mph: Number.isFinite(row[9]) ? Math.round(row[9] * 2.23694) : null, source: 'opensky' };
        }
      }
    } catch (e) { /* the progress estimate covers it */ }
  }

  /** Where the plane is: OpenSky's report if fresh, otherwise along the route by FlightAware's progress. */
  function position(x) {
    const a = x.aero, t = now();
    const ph = phaseOf(a, t);
    if (ph !== 'air') return null;
    if (x.pos && t - x.posAt < 5 * 60e3) return x.pos;
    const o = airport(a?.origin?.code), d = airport(a?.destination?.code);
    if (!o || !d) return null;
    let f = a.progress != null ? a.progress / 100 : null;
    if (f == null && a.actOff && (a.estOn || a.schedIn)) f = (t - a.actOff) / Math.max(1, (a.estOn || a.schedIn) - a.actOff);
    if (f == null) return null;
    f = Math.min(0.99, Math.max(0.01, f));
    const p = alongRoute(o, d, f);
    return { lat: p.lat, lon: p.lon, track: Math.round(bearing(p, d)), altFt: null, mph: null, source: 'estimate' };
  }

  // ---- leave-by for family flights -------------------------------------------------------------
  async function planTrip(x) {
    if (x.kind !== 'family') { x.trip = null; return; }
    const a = x.aero, h = home();
    const from = airport(a?.origin?.code || x.guessFrom), to = airport(a?.destination?.code || x.guessTo);
    if (!h) { x.trip = null; return; }
    const near = (ap) => ap && milesBetween(h, ap) < 150;
    let target, whenMs, kind;
    if (x.pickup && near(to)) {
      // be at the curb about 15 minutes after the plane reaches the gate
      target = to; whenMs = (a?.estIn || a?.schedIn || x.ev.endMs || x.ev.startMs) + 15 * 60e3; kind = 'pickup';
    } else if (!x.pickup && near(from)) {
      target = from; whenMs = (a?.estOut || a?.schedOut || x.ev.startMs) - settings.bufferMin * 60e3; kind = 'departure';
    } else { x.trip = null; return; }
    const route = await driveTo(target.lat, target.lon);
    if (!route) { x.trip = null; return; }
    x.trip = { kind, airport: target, leaveByMs: whenMs - route.mins * 60e3, driveMins: route.mins, driveMiles: route.miles, driveLabel: route.label };
  }

  // ---- alerts: delays, gate changes, takeoff, landing ----------------------------------------------
  function noticeChanges(x, before) {
    const a = x.aero, t = now(), who = whoOf(x);
    const ph = phaseOf(a, t), was = before ? phaseOf(before, t) : null;
    const push = (id, title, detail, urgent) => {
      if (x.alerted[id]) return;
      x.alerted[id] = t;
      alertList.push({ id: `flight-${x.key}-${id}`, kind: 'flight', at: Math.floor(t / 1000), until: Math.floor((t + 15 * 60e3) / 1000),
        title, detail, colorHex: urgent ? '0xF59E0BFF' : '0x7DD3FCFF', sound: x.kind === 'family' });
    };
    const name = `${who ? `${who}'s flight` : 'Flight'} ${x.flight.code}`;
    const route = `${a.origin?.code || '?'} → ${a.destination?.code || '?'}`;
    if (ph === 'cancelled') push('cancelled', `${name} is cancelled`, route, true);
    if (ph === 'diverted') push('diverted', `${name} was diverted`, route, true);
    const delay = a.delayOutMin || 0;
    if (delay >= 15 && !a.actOff) {
      const step = Math.floor(delay / 15) * 15;
      push(`delay-${step}`, `${name} is delayed ${delay} min`, `Now departs ${timeIn(a.estOut || a.schedOut, a.origin?.tz)}  ·  ${route}`, true);
    }
    const watchGate = x.pickup || x.kind === 'client' ? 'gateIn' : 'gateOut';
    if (before && before[watchGate] && a[watchGate] && before[watchGate] !== a[watchGate]) {
      push(`gate-${a[watchGate]}`, `Gate change: ${x.flight.code}`, `Now gate ${a[watchGate]}${watchGate === 'gateIn' ? ` at ${a.destination?.code || ''}` : ''} (was ${before[watchGate]})`, true);
    }
    if (ph === 'air' && was && was !== 'air') push('off', `${name} took off`, `${route}  ·  lands about ${timeIn(a.estOn || a.schedIn, a.destination?.tz)}`, false);
    if ((ph === 'landed' || ph === 'arrived') && was && was !== 'landed' && was !== 'arrived') {
      push('on', `${name} landed`, [a.destination?.code, a.gateIn ? `Gate ${a.gateIn}` : '', a.baggage ? `Bags at ${a.baggage}` : ''].filter(Boolean).join('  ·  '), false);
    }
  }

  function whoOf(x) {
    if (x.kind === 'client') return clientName(x.ev.title);
    if (x.members.length) return x.members.map(memberName).join(' & ');
    return '';
  }
  /** "Client: Smith family DL 1234" -> "Smith family" */
  function clientName(title) {
    const t = String(title || '').replace(/\b(client|flight|to|from)\b:?/gi, ' ').replace(/\(?\b[A-Z0-9]{2}\s?\d{1,4}\)?/g, ' ').replace(/[-–—:|·]+/g, ' ').replace(/\s+/g, ' ').trim();
    return t.length >= 2 && t.length <= 40 ? t : 'Client';
  }

  async function tick() {
    if (busy || !settings.enabled) return;
    busy = true;
    try {
      scan();
      let checks = 0;
      const list = [...tracked.values()].sort((p, q) => p.ev.startMs - q.ev.startMs);
      for (const x of list) {
        if (checks < 6 && now() >= x.nextAt && settings.aeroKey) { await checkAero(x); checks++; x.nextAt = now() + nextCheck(x); }
      }
      await locate(list.filter(x => phaseOf(x.aero, now()) === 'air' && now() - x.posAt > 85e3));
      for (const x of list) await planTrip(x);
      // old alerts fall away after a day
      while (alertList.length && alertList[0].until * 1000 < now() - 24 * 3600e3) alertList.shift();
    } catch (e) {
      lastProblem = e.message;
    } finally { busy = false; }
  }

  function view(x) {
    const a = x.aero, t = now(), ph = phaseOf(a, t);
    const from = a?.origin?.code || x.guessFrom, to = a?.destination?.code || x.guessTo;
    const apFrom = airport(from), apTo = airport(to);
    const outMs = a ? (a.actOut || a.estOut || a.schedOut) : x.ev.startMs;
    const inMs = a ? (a.actIn || a.estIn || a.schedIn) : (x.ev.endMs > x.ev.startMs ? x.ev.endMs : null);
    const delay = a ? Math.max(0, a.delayOutMin || 0) : 0;
    const pos = position(x);
    const member = x.members[0];
    return {
      id: x.key,
      code: x.flight.code,
      airline: (AIRLINES[x.flight.airline] || [])[1] || x.flight.airline,
      kind: x.kind,
      pickup: x.pickup,
      who: whoOf(x),
      colorHex: x.kind === 'client' ? '0x7DD3FCFF' : member ? memberColor(member) : '0xE8623CFF',
      eventTitle: x.ev.title,
      phase: ph,
      status: PHASE_TEXT[ph] + (ph === 'delayed' ? ` ${delay} min` : ''),
      live: Boolean(a),
      from: { code: from, city: a?.origin?.city || apFrom?.city || '', name: a?.origin?.name || apFrom?.name || '' },
      to: { code: to, city: a?.destination?.city || apTo?.city || '', name: a?.destination?.name || apTo?.name || '' },
      departs: { ms: outMs, time: outMs ? timeIn(outMs, a?.origin?.tz) : '', label: a?.actOut ? 'Left the gate' : 'Departs', gate: a?.gateOut || '', terminal: a?.termOut || '' },
      arrives: { ms: inMs, time: inMs ? timeIn(inMs, a?.destination?.tz) : '', label: a?.actIn ? 'Arrived' : 'Arrives', gate: a?.gateIn || '', terminal: a?.termIn || '', baggage: a?.baggage || '' },
      progress: ph === 'air' ? (a?.progress ?? null) : ph === 'landed' || ph === 'arrived' ? 100 : 0,
      position: pos ? { lat: Math.round(pos.lat * 1e4) / 1e4, lon: Math.round(pos.lon * 1e4) / 1e4, track: pos.track, altFt: pos.altFt, mph: pos.mph, estimate: pos.source === 'estimate' } : null,
      leaveBy: x.trip ? { ms: x.trip.leaveByMs, time: timeIn(x.trip.leaveByMs), driveMins: x.trip.driveMins, airport: x.trip.airport.code, kind: x.trip.kind } : null,
      note: x.problem || '',
      updatedAt: x.checkedAt || null
    };
  }

  /** How much a flight matters right now: in the air first, then soonest. */
  function rank(v) {
    const t = now();
    const order = { air: 0, taxiing: 0, delayed: 1, ontime: 1, scheduled: 2, landed: 3, diverted: 1, arrived: 4, cancelled: 5 };
    return (order[v.phase] ?? 3) * 1e13 + Math.abs((v.phase === 'landed' || v.phase === 'arrived' ? v.arrives.ms : v.departs.ms || 0) - t);
  }

  return {
    get settings() { return settings; },

    start() {
      clearInterval(timer);
      if (!settings.enabled) return;
      timer = setInterval(() => { tick(); }, 60e3);
      timer.unref?.();
      setTimeout(() => tick(), 2000).unref?.();
    },
    stop() { clearInterval(timer); timer = null; },

    apply(next) {
      const merged = { ...settings, ...next };
      for (const k of ['aeroKey', 'openSkyId', 'openSkySecret']) if (next[k] === undefined || next[k] === '••••••') merged[k] = settings[k];
      fs.writeFileSync(file, JSON.stringify(merged, null, 2) + '\n');
      settings = readFlightSettings(file);
      osToken = null;
      for (const x of tracked.values()) x.nextAt = 0;
      this.start();
      return settings;
    },

    /** True for a calendar event that's a flight the family flies on: its drive is planned here instead. */
    isFlightEvent(ev) {
      return Boolean(settings.enabled && ev && findFlight(`${ev.title || ''}  ${ev.location || ''}  ${ev.description || ''}`));
    },

    /** The trip a family member's next flight needs (same shape as the server's other trips), or null. */
    tripFor(memberId) {
      if (!settings.enabled) return null;
      const t = now();
      const mine = [...tracked.values()].filter(x => x.trip && x.members.includes(memberId) && x.trip.leaveByMs > t - 60 * 60e3 && !x.done)
        .sort((p, q) => p.trip.leaveByMs - q.trip.leaveByMs)[0];
      if (!mine) return null;
      const v = view(mine), tr = mine.trip;
      const startMs = tr.kind === 'pickup' ? (v.arrives.ms || mine.ev.startMs) : (v.departs.ms || mine.ev.startMs);
      return {
        eventTitle: tr.kind === 'pickup' ? `Pick up ${v.code} at ${tr.airport.code}` : `Flight ${v.code} to ${v.to.city || v.to.code || ''}`.trim(),
        eventTime: tr.kind === 'pickup' ? `lands ${v.arrives.time}` : `departs ${v.departs.time}`,
        location: tr.airport.name,
        driveMins: tr.driveMins, driveMiles: tr.driveMiles, driveLabel: tr.driveLabel,
        leaveBy: timeIn(tr.leaveByMs), leaveByMs: tr.leaveByMs, startMs,
        within2Hours: startMs - t <= 2 * 3600e3,
        lat: tr.airport.lat, lon: tr.airport.lon,
        flight: v.id
      };
    },

    /** For the dashboard: null when flights are off. */
    summary() {
      if (!settings.enabled) return null;
      return [...tracked.values()].map(view).sort((p, q) => rank(p) - rank(q));
    },

    get(id) { const x = tracked.get(id); return x ? view(x) : null; },

    /** Points and a route line for the map: the two airports, and the plane. */
    mapFor(id) {
      const x = tracked.get(id);
      if (!x) return null;
      const v = view(x), o = airport(v.from.code), d = airport(v.to.code);
      const points = [];
      if (o) points.push({ kind: 'airport', label: o.code, lat: o.lat, lon: o.lon, color: '0xF8FAFCFF' });
      if (d) points.push({ kind: 'airport', label: d.code, lat: d.lat, lon: d.lon, color: '0xF8FAFCFF' });
      if (v.position) points.push({ kind: 'plane', label: v.code, lat: v.position.lat, lon: v.position.lon, color: v.colorHex, rot: v.position.track ?? (o && d ? Math.round(bearing(o, d)) : 0) });
      const path = o && d ? Array.from({ length: 41 }, (_, i) => alongRoute(o, d, i / 40)) : [];
      return { points, path, view: v };
    },

    alerts(nowMs = now()) { return alertList.filter(a => a.until * 1000 > nowMs - 60e3); },

    /** For the setup page. */
    status() {
      if (usage.month !== monthKey()) usage = { month: monthKey(), calls: 0 };
      return {
        enabled: settings.enabled, hasAero: Boolean(settings.aeroKey), hasOpenSky: Boolean(settings.openSkyId && settings.openSkySecret),
        bufferMin: settings.bufferMin, workIsClients: settings.workIsClients, monthlyDollars: settings.monthlyDollars,
        callsThisMonth: usage.calls, budgetCalls: budgetCalls(), spent: Math.round(usage.calls * 0.5) / 100,
        problem: lastProblem, flights: [...tracked.values()].map(view)
      };
    },

    // for tests
    _tick: tick,
    _tracked: tracked
  };
}
