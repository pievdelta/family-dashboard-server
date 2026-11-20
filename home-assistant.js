// Home Assistant, read-only: a few things from the house on the TV, and alerts
// when they need someone ("Garage door has been open 30 minutes").
//
// The family picks which devices on the setup page. The address and token stay
// in config.txt (HA_URL, HA_TOKEN); the picks live in home-assistant.json next to it.
// Nothing here turns anything on or off: controlling the house is Home Assistant's job.
//
// The server keeps one live connection to Home Assistant, the same kind its own
// app uses, and hears only about the picked devices.

import fs from 'fs';

const RIGHT_AWAY = 0;
export const ALERT_CHOICES = [
  { value: '', label: 'No alert' },
  { value: String(RIGHT_AWAY), label: 'Alert right away' },
  { value: '10', label: 'If it stays that way 10 min' },
  { value: '30', label: 'If it stays that way 30 min' },
  { value: '60', label: 'If it stays that way an hour' }
];
// the kinds of things worth showing a family; the rest (power meters, updates, scripts) stay out of the list
const DOMAINS = ['lock', 'cover', 'binary_sensor', 'climate', 'alarm_control_panel', 'event', 'person', 'sensor', 'switch', 'light', 'fan', 'input_boolean', 'vacuum', 'water_heater'];

/** The address and token from config.txt. */
export function haSettings(env = process.env) {
  let url = String(env.HA_URL || '').trim().replace(/\/+$/, '');
  if (url && !/^https?:\/\//i.test(url)) url = 'http://' + url;
  const token = String(env.HA_TOKEN || '').trim();
  return { configured: Boolean(url && token), url, token };
}

/** { show: [entity ids], alerts: { entity_id: minutes } } from home-assistant.json. */
export function readPicks(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const show = Array.isArray(j.show) ? j.show.filter(x => typeof x === 'string').slice(0, 12) : [];
    const alerts = {};
    for (const [id, m] of Object.entries(j.alerts || {})) if (Number.isFinite(Number(m)) && Number(m) >= 0) alerts[id] = Number(m);
    return { show, alerts };
  } catch (e) {
    return { show: [], alerts: {} };
  }
}

export function savePicks(file, picks) {
  fs.writeFileSync(file, JSON.stringify({ show: picks.show || [], alerts: picks.alerts || {} }, null, 2) + '\n');
}

const title = (s) => String(s || '').replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase());
const domainOf = (id) => String(id).split('.')[0];

/**
 * How one device reads to a family: "Locked", "Open", "71° · Heating".
 * attention: true when it's in the state someone might need to deal with.
 */
export function describe(entity) {
  const id = entity.entity_id;
  const a = entity.attributes || {};
  const s = String(entity.state ?? '');
  const dc = String(a.device_class || '');
  const name = String(a.friendly_name || id);
  const out = { id, name, state: title(s), icon: 'dot', attention: false, available: !['unavailable', 'unknown'].includes(s) };
  if (!out.available) return { ...out, state: 'Not available' };
  switch (domainOf(id)) {
    case 'lock':
      return { ...out, icon: 'lock', state: { locked: 'Locked', unlocked: 'Unlocked', jammed: 'Jammed', locking: 'Locking', unlocking: 'Unlocking', open: 'Open' }[s] || title(s), attention: ['unlocked', 'jammed', 'open'].includes(s) };
    case 'cover': {
      const garage = dc === 'garage' || /garage/i.test(name);
      return { ...out, icon: garage ? 'garage' : 'door', state: { open: 'Open', opening: 'Opening', closed: 'Closed', closing: 'Closing' }[s] || title(s), attention: s === 'open' || s === 'opening' };
    }
    case 'binary_sensor': {
      const on = s === 'on';
      const words = {
        door: ['Open', 'Closed', 'door'], garage_door: ['Open', 'Closed', 'garage'], window: ['Open', 'Closed', 'door'], opening: ['Open', 'Closed', 'door'],
        motion: ['Motion', 'Clear', 'motion'], occupancy: ['Someone there', 'Clear', 'motion'], presence: ['Someone there', 'Clear', 'motion'],
        moisture: ['Wet', 'Dry', 'water'], smoke: ['Smoke!', 'OK', 'alarm'], gas: ['Gas!', 'OK', 'alarm'], carbon_monoxide: ['CO!', 'OK', 'alarm'],
        safety: ['Unsafe', 'OK', 'alarm'], problem: ['Problem', 'OK', 'alarm'], battery: ['Low', 'OK', 'battery'], lock: ['Unlocked', 'Locked', 'lock'],
        sound: ['Sound', 'Quiet', 'dot'], vibration: ['Vibration', 'Still', 'dot'], running: ['Running', 'Done', 'dot'], plug: ['Plugged in', 'Unplugged', 'dot']
      }[dc];
      if (words) return { ...out, icon: words[2], state: on ? words[0] : words[1], attention: on && dc !== 'plug' };
      return { ...out, state: on ? 'On' : 'Off', attention: on };
    }
    case 'climate': {
      const cur = Number(a.current_temperature);
      const action = a.hvac_action ? title(a.hvac_action) : title(s);
      return { ...out, icon: 'temp', state: [Number.isFinite(cur) ? `${Math.round(cur)}°` : null, action].filter(Boolean).join(' · ') };
    }
    case 'water_heater':
      return { ...out, icon: 'temp', state: Number.isFinite(Number(a.current_temperature)) ? `${Math.round(Number(a.current_temperature))}°` : title(s) };
    case 'alarm_control_panel':
      return { ...out, icon: 'alarm', state: { disarmed: 'Disarmed', armed_home: 'Armed (home)', armed_away: 'Armed (away)', armed_night: 'Armed (night)', armed_vacation: 'Armed (vacation)', pending: 'Arming', arming: 'Arming', triggered: 'Alarm!' }[s] || title(s), attention: s === 'triggered' };
    case 'event': {
      // a doorbell press, a button: the state is when it last happened
      const t = Date.parse(s);
      const when = Number.isFinite(t) ? new Date(t).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '';
      const bell = dc === 'doorbell' || /door ?bell|ding|ring/i.test(name);
      return { ...out, icon: bell ? 'bell' : 'dot', state: when ? `Last ${when}` : 'Nothing yet', event: true, bell };
    }
    case 'person':
    case 'device_tracker':
      return { ...out, icon: 'person', state: s === 'home' ? 'Home' : s === 'not_home' ? 'Away' : title(s) };
    case 'sensor': {
      const unit = a.unit_of_measurement ? String(a.unit_of_measurement) : '';
      const n = Number(s);
      const val = Number.isFinite(n) && s.trim() !== '' ? String(Math.round(n * 10) / 10) : title(s);
      return { ...out, icon: /°/.test(unit) || dc === 'temperature' ? 'temp' : 'dot', state: unit ? `${val}${unit.startsWith('°') || unit === '%' ? '' : ' '}${unit}` : val };
    }
    case 'vacuum':
      return { ...out, icon: 'dot', state: title(s) };
    default:
      return { ...out, state: s === 'on' ? 'On' : s === 'off' ? 'Off' : title(s) };
  }
}

/** The words for an alert about this device. */
function alertText(d, minutes) {
  if (d.event) return d.bell ? { title: 'Someone is at the door', detail: d.name } : { title: d.name, detail: 'Just now' };
  const verb = { Open: 'is open', Unlocked: 'is unlocked', Jammed: 'is jammed', Wet: 'detects water', 'Smoke!': 'detects smoke', 'Gas!': 'detects gas', 'CO!': 'detects carbon monoxide', 'Alarm!': 'is going off', Motion: 'sees motion', 'Someone there': 'sees someone', Low: 'battery is low' }[d.state];
  const t = verb ? `${d.name} ${verb}` : `${d.name}: ${d.state}`;
  if (minutes > 0) {
    const how = minutes >= 60 ? `${Math.round(minutes / 60)} hour${minutes >= 120 ? 's' : ''}` : `${minutes} minutes`;
    return { title: verb && /^is /.test(verb) ? `${d.name} has been ${verb.slice(3)} ${how}` : t, detail: `For ${how} now` };
  }
  return { title: t, detail: 'Just now' };
}

/**
 * Alerts for the TV from the picked devices' current states.
 * entities: { id: { state, attributes, last_changed (ms) } }
 * Right-away alerts last 2 minutes from the change; "stays that way" alerts last
 * until it changes back (up to 6 hours). Each gets an id that's new for each
 * change, so the TV chimes once per time it happens.
 */
export function homeAlerts(entities, picks, nowMs = Date.now()) {
  const out = [];
  for (const [id, minutes] of Object.entries(picks.alerts || {})) {
    const e = entities[id];
    if (!e) continue;
    const d = describe({ entity_id: id, state: e.state, attributes: e.attributes });
    if (!d.available) continue;
    const since = Number(e.last_changed) || nowMs;
    if (d.event) {
      // doorbells and buttons: only right away makes sense
      if (nowMs - since > 120000 || !e.state) continue;
      out.push({ id: `ha-${id}-${since}`, at: Math.floor(since / 1000), until: Math.floor((since + 120000) / 1000), ...alertText(d, 0) });
      continue;
    }
    if (!d.attention) continue;
    if (minutes === RIGHT_AWAY) {
      if (nowMs - since > 120000) continue;
      out.push({ id: `ha-${id}-${since}`, at: Math.floor(since / 1000), until: Math.floor((since + 120000) / 1000), ...alertText(d, 0) });
    } else {
      const at = since + minutes * 60000;
      if (at > nowMs + 6 * 3600000) continue;
      out.push({ id: `ha-${id}-${since}-${minutes}`, at: Math.floor(at / 1000), until: Math.floor((Math.max(at, nowMs) + 6 * 3600000) / 1000), ...alertText(d, minutes) });
    }
  }
  return out.map(a => ({ ...a, kind: 'home' }));
}

// ---- Home Assistant's compressed entity updates (subscribe_entities) ----------------------

/** Applies one subscribe_entities message to the entity map. Returns true if anything changed. */
export function applyEntityMessage(entities, msg) {
  let changed = false;
  for (const [id, c] of Object.entries(msg?.a || {})) {
    entities[id] = { state: c.s, attributes: c.a || {}, last_changed: Math.round(Number(c.lc) * 1000) || Date.now() };
    changed = true;
  }
  for (const [id, diff] of Object.entries(msg?.c || {})) {
    const e = entities[id] || (entities[id] = { state: null, attributes: {}, last_changed: Date.now() });
    const plus = diff['+'] || {};
    if ('s' in plus && plus.s !== e.state) {
      e.state = plus.s;
      e.last_changed = Math.round(Number(plus.lc ?? plus.lu) * 1000) || Date.now();
    } else if ('lc' in plus) {
      e.last_changed = Math.round(Number(plus.lc) * 1000) || e.last_changed;
    }
    if (plus.a) e.attributes = { ...e.attributes, ...plus.a };
    for (const k of diff['-']?.a || []) delete e.attributes[k];
    changed = true;
  }
  for (const id of msg?.r || []) { delete entities[id]; changed = true; }
  return changed;
}

// ---- talking to Home Assistant -------------------------------------------------------------

async function rest(settings, path, ms = 8000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(settings.url + path, { headers: { Authorization: `Bearer ${settings.token}` }, signal: ctl.signal });
    if (res.status === 401) throw new Error('Home Assistant refused the token. Make a new long-lived token and paste it again.');
    if (!res.ok) throw new Error(`Home Assistant answered ${res.status}.`);
    return await res.json();
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`Home Assistant didn't answer at ${settings.url}.`);
    if (e.cause?.code === 'ECONNREFUSED' || e.cause?.code === 'ENOTFOUND' || e.cause?.code === 'EHOSTUNREACH') throw new Error(`Couldn't reach Home Assistant at ${settings.url}. Check the address.`);
    throw e;
  } finally {
    clearTimeout(t);
  }
}

/** Every device worth offering on the setup page, grouped and sorted by name. */
export async function listEntities(settings) {
  const all = await rest(settings, '/api/states', 15000);
  return (Array.isArray(all) ? all : [])
    .filter(e => DOMAINS.includes(domainOf(e.entity_id)))
    .filter(e => domainOf(e.entity_id) !== 'sensor' || ['temperature', 'humidity', 'battery', 'moisture'].includes(e.attributes?.device_class) || /°|%/.test(e.attributes?.unit_of_measurement || ''))
    .map(e => describe(e))
    .sort((x, y) => x.name.localeCompare(y.name));
}

/** "Connected to Home" style check for the setup page's Test button. */
export async function testConnection(settings) {
  const cfg = await rest(settings, '/api/config');
  return `Connected to ${cfg.location_name || 'Home Assistant'} (version ${cfg.version || '?'}).`;
}

/**
 * Keeps a live connection for the picked devices. Returns the status object,
 * plus homeStrip() and alerts() for the dashboard, and restart() after picks change.
 */
export function startHomeAssistant({ settings = haSettings(), picksFile, log = console.log, Socket = globalThis.WebSocket }) {
  const status = { configured: settings.configured, connected: false, problem: null, entities: {}, picks: readPicks(picksFile) };
  let ws = null;
  let retry = 5000;
  let timer = null;
  let stopped = false;

  function watched() {
    return [...new Set([...status.picks.show, ...Object.keys(status.picks.alerts)])];
  }

  function connect() {
    if (stopped || !settings.configured) return;
    const ids = watched();
    if (!ids.length) { status.connected = false; status.problem = null; return; }
    if (!Socket) { status.problem = 'This Node.js has no WebSocket. Update the server.'; return; }
    let n = 1;
    try {
      ws = new Socket(settings.url.replace(/^http/i, 'ws') + '/api/websocket');
    } catch (e) {
      status.problem = `Couldn't connect: ${e.message}`;
      return schedule();
    }
    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); } catch (e) { return; }
      if (m.type === 'auth_required') ws.send(JSON.stringify({ type: 'auth', access_token: settings.token }));
      else if (m.type === 'auth_invalid') {
        status.problem = 'Home Assistant refused the token. Make a new long-lived token and paste it again.';
        log(`[Home Assistant] ${status.problem}`);
        retry = 10 * 60000; // don't hammer it with a bad token
        try { ws.close(); } catch (e) {}
      } else if (m.type === 'auth_ok') {
        status.connected = true; status.problem = null; retry = 5000;
        log(`[Home Assistant] Connected. Watching ${ids.length} device${ids.length === 1 ? '' : 's'}.`);
        ws.send(JSON.stringify({ id: ++n, type: 'subscribe_entities', entity_ids: ids }));
      } else if (m.type === 'event' && m.event) {
        applyEntityMessage(status.entities, m.event);
      } else if (m.type === 'result' && m.success === false) {
        status.problem = `Home Assistant said: ${m.error?.message || 'no'}`;
      }
    };
    // A refused connection reports an error and may never report "closed", so either one ends it.
    const socket = ws;
    let ended = false;
    const endConnection = () => {
      if (ended) return;
      ended = true;
      if (status.connected) log('[Home Assistant] Lost the connection. Trying again.');
      status.connected = false;
      if (ws === socket) ws = null;
      try { socket.close(); } catch (e) {}
      schedule();
    };
    ws.onclose = endConnection;
    ws.onerror = () => {
      if (!status.problem) status.problem = `Couldn't reach Home Assistant at ${settings.url}.`;
      endConnection();
    };
  }

  function schedule() {
    if (stopped) return;
    clearTimeout(timer);
    timer = setTimeout(connect, retry);
    timer.unref?.();
    retry = Math.min(retry * 2, 5 * 60000);
  }

  connect();

  return {
    status,
    /** What the TV's Home strip shows, in the order picked. */
    homeStrip() {
      return status.picks.show.map(id => status.entities[id] ? describe({ entity_id: id, ...status.entities[id] }) : null).filter(Boolean)
        .map(({ id, name, state, icon, attention }) => ({ id, name, state, icon, attention }));
    },
    alerts(nowMs) { return homeAlerts(status.entities, status.picks, nowMs); },
    /** After the setup page saved new picks: reconnect for the new list. */
    restart() {
      status.picks = readPicks(picksFile);
      for (const id of Object.keys(status.entities)) if (!watched().includes(id)) delete status.entities[id];
      retry = 1000;
      clearTimeout(timer);
      if (ws) { try { ws.close(); } catch (e) {} } else connect();
    },
    stop() { stopped = true; clearTimeout(timer); try { ws?.close(); } catch (e) {} }
  };
}
