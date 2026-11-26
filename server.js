import express from 'express';
import cors from 'cors';
import admin from 'firebase-admin';
import ical from 'node-ical';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildTaskEvents, tidyOldData } from './tasks.js';
import { buildFullMap } from './map-full.js';
import { startDiscovery } from './discovery.js';
import { setupPairing, isHomeNetwork, lanAddress, homeOnly } from './pairing.js';
import { startCloudConfig } from './cloud-config.js';
import { createUpdater } from './updater.js';
import { setupExtras } from './setup-extras.js';
import { startAI, aiSettings } from './ai.js';
import { startHomeAssistant } from './home-assistant.js';
import { createDisplays, buildLists, BUILT_IN_PROFILES } from './displays.js';
import { createMusic } from './music.js';
import { createFlights } from './flights.js';

// what a screen that isn't a named TV shows (a browser, an older Roku)
const TV_DEFAULT_LAYOUT = BUILT_IN_PROFILES.house;

if (fs.existsSync('./config.txt')) {
  dotenv.config({ path: './config.txt' });
} else {
  dotenv.config();
}

const app = express();
app.use(cors());
app.use(express.json());

// Nothing personal lives in this file. Who is in the family, where home is and
// which words tie an event to a person all come from household.json; keys,
// tokens and calendar links come from config.txt (see config.example.txt).
process.on('unhandledRejection', (err) => {
  console.error('[Server] Unhandled error:', err?.message || err);
});

const HOUSEHOLD_CONFIG_FILE = './household.json';
let householdConfig = {
  dashboardTitle: 'FAMILY DASHBOARD',
  timezone: 'America/New_York',
  home: { lat: 0, lon: 0 },
  weatherLocations: [],
  calendars: {},
  members: []
};

let rawHousehold = null;
if (fs.existsSync(HOUSEHOLD_CONFIG_FILE)) {
  try {
    rawHousehold = JSON.parse(fs.readFileSync(HOUSEHOLD_CONFIG_FILE, 'utf8'));
    householdConfig = { ...householdConfig, ...rawHousehold };
  } catch (e) {
    console.error(`[Config] ${HOUSEHOLD_CONFIG_FILE} could not be read: ${e.message}`);
  }
} else {
  console.error(`[Config] ${HOUSEHOLD_CONFIG_FILE} is missing. Copy household.example.json to household.json and fill it in.`);
}

const PORT = Number(process.env.PORT || 3000);
const TZ = householdConfig.timezone || 'America/New_York';
const HOME_LAT = Number(householdConfig.home?.lat || process.env.HOME_LAT || 0);
const HOME_LON = Number(householdConfig.home?.lon || process.env.HOME_LON || 0);

const MEMBERS = (householdConfig.members || []).filter(m => m && m.id).map(m => ({ ...m, id: String(m.id).toLowerCase() }));
const CAL_CFG = householdConfig.calendars || {};
const FAMILY_COLOR = CAL_CFG.familyColorHex || '0xEAB308FF';
const FAMILY_NAME = CAL_CFG.familyName || 'Family';
const WEATHER_LOCS = (householdConfig.weatherLocations && householdConfig.weatherLocations.length)
  ? householdConfig.weatherLocations
  : [{ id: 'home', name: 'Home', lat: HOME_LAT, lon: HOME_LON }];
const HOME_WX_ID = WEATHER_LOCS[0].id;
// members who own a whole calendar feed (for example the work calendar) are not "family default" people
const FAMILY_MEMBERS = MEMBERS.filter(m => !m.sourceType);
const KID_MEMBERS = MEMBERS.filter(m => m.role === 'kid');

// Alerts the TV plays a sound for. Every value can be changed in the
// "notifications" block of household.json.
const NOTIFY_CFG = {
  eventLeadMinutes: 5,
  leaveAlerts: true,
  busNearFeet: 2000,
  quietStart: '21:30',
  quietEnd: '06:30',
  ...(householdConfig.notifications || {})
};

function memberDefaultMode(m) {
  return m.hasBus ? String(m.defaultMode || 'BUS').toUpperCase() : 'CAR';
}

const nyIsoFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const nyHmFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour12: false, hour: '2-digit', minute: '2-digit' });
const nyWkFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' });
const nyWeekdayFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'long' });
const nyMonShortFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, month: 'short' });
const nyMonFullFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, month: 'long', year: 'numeric' });
const nyDateLblFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric' });
const nyTimeLblFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });

// time-zone helpers for chores and to-dos placed on the calendar (tasks.js)
const TASK_FMT = {
  toNyIsoDate: (d) => toNyIsoDate(d),
  getNyHourMinute: (d) => getNyHourMinute(d),
  wkFmt: nyWkFmt,
  monShortFmt: nyMonShortFmt,
  monFullFmt: nyMonFullFmt,
  dateLblFmt: nyDateLblFmt,
  timeLblFmt: nyTimeLblFmt
};

function toNyIsoDate(dateObj) {
  const parts = nyIsoFmt.formatToParts(dateObj);
  return `${parts.find(p => p.type === 'year').value}-${parts.find(p => p.type === 'month').value}-${parts.find(p => p.type === 'day').value}`;
}

function getNyHourMinute(dateObj) {
  const parts = nyHmFmt.formatToParts(dateObj);
  return {
    h: Number(parts.find(p => p.type === 'hour').value) % 24,
    m: Number(parts.find(p => p.type === 'minute').value)
  };
}

// one place for the version: package.json (the release build checks the tag matches)
const PACKAGE_INFO = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const SERVER_VERSION = PACKAGE_INFO.version;
// where updates come from: owner/repo on GitHub (FD_UPDATE_REPO overrides, 'off' turns checks off)
const UPDATE_REPO = (process.env.FD_UPDATE_REPO || PACKAGE_INFO.familyDashboard?.updateRepo || '').trim();
// the Android app's id (Family Dashboard; versions before 2.2 were io.loux.bountyquest)
const APP_PACKAGE = (process.env.APP_PACKAGE || 'io.loux.familydashboard').trim();

let db = null;
let firebaseAuth = null;
let firebaseRules = null;
let firebaseCredential = null;
let firebaseProjectId = '';

function findServiceAccountFile() {
  const named = (process.env.FIREBASE_SERVICE_ACCOUNT || '').trim();
  if (named) return named;
  try {
    return fs.readdirSync('.').find(f => /firebase-adminsdk.*\.json$/i.test(f)) || '';
  } catch (e) {
    return '';
  }
}

let householdId = (process.env.HOUSEHOLD_ID || '').trim();
if (process.env.FAKE_FIREBASE) {
  // tests: an in-memory stand-in for Firebase
  const fake = await import(process.env.FAKE_FIREBASE);
  db = fake.firestore();
  firebaseAuth = fake.auth();
  firebaseRules = fake.rules();
  firebaseCredential = fake.credential();
  firebaseProjectId = 'fake-project';
  if (!householdId) householdId = 'test-family';
} else {
  try {
    const saFile = findServiceAccountFile();
    if (saFile) {
      const serviceAccount = JSON.parse(fs.readFileSync(saFile, 'utf8'));
      firebaseCredential = admin.credential.cert(serviceAccount);
      admin.initializeApp({ credential: firebaseCredential, projectId: serviceAccount.project_id });
      db = admin.firestore();
      firebaseAuth = admin.auth();
      firebaseRules = admin.securityRules();
      firebaseProjectId = serviceAccount.project_id;
      if (!householdId) {
        // a new family: make up an id once and remember it in config.txt
        householdId = `family-${Math.random().toString(36).slice(2, 8)}`;
        const { updateConfigFile } = await import('./cloud-config.js');
        updateConfigFile('./config.txt', { HOUSEHOLD_ID: householdId });
        process.env.HOUSEHOLD_ID = householdId;
        console.log(`[Firebase] Created family id ${householdId} and saved it in config.txt.`);
      }
    } else {
      console.log('[Firebase] Off: chores, pairing and app settings need your own Firebase. Open the setup page to see how.');
    }
  } catch (e) {
    console.error('[Firebase] Could not start:', e.message);
    db = null;
  }
}

// After settings change in the app: the launcher (npm start) restarts us.
function requestRestart() {
  if (process.env.FD_LAUNCHER === '1') {
    setTimeout(() => process.exit(75), 300);
  } else {
    console.log('[Settings] Restart the server to use the new settings (npm start restarts on its own).');
  }
}

const FILTER_STATE_FILE = './calendar-filters.json';
let filterState = {
  enabledMap: {},
  selectedTransportMember: MEMBERS[0]?.id || '',
  overviewMember: 'all',
  selectedWxLoc: HOME_WX_ID,
  transportModes: {},
  transportModeDay: ''
};
if (fs.existsSync(FILTER_STATE_FILE)) {
  try {
    const loaded = JSON.parse(fs.readFileSync(FILTER_STATE_FILE, 'utf8'));
    filterState = { ...filterState, ...loaded, enabledMap: { ...(loaded.enabledMap || {}) }, transportModes: { ...(loaded.transportModes || {}) } };
  } catch (e) {}
}
// Tidy saved choices that point at people or places that are no longer configured.
(function tidyFilterState() {
  const ids = new Set(MEMBERS.map(m => m.id));
  for (const key of Object.keys(filterState.enabledMap)) if (!ids.has(key)) delete filterState.enabledMap[key];
  for (const key of Object.keys(filterState.transportModes)) if (!ids.has(key)) delete filterState.transportModes[key];
  if (!ids.has(filterState.selectedTransportMember)) filterState.selectedTransportMember = MEMBERS[0]?.id || '';
  if (filterState.overviewMember !== 'all' && !ids.has(filterState.overviewMember)) filterState.overviewMember = 'all';
  if (!WEATHER_LOCS.some(l => l.id === filterState.selectedWxLoc)) filterState.selectedWxLoc = HOME_WX_ID;
})();

// "Going by car today" is a one-day choice. It goes back to each person's
// usual way of travelling at midnight, so a forgotten switch cannot hide the
// bus from the home screen for days.
function expireTransportModes() {
  const today = toNyIsoDate(new Date());
  if (filterState.transportModeDay !== today) {
    filterState.transportModes = {};
    filterState.transportModeDay = today;
    saveFilterState();
  }
}
function activeModeFor(m) {
  if (!m.hasBus) return 'CAR';
  return filterState.transportModes[m.id] || memberDefaultMode(m);
}
function saveFilterState() {
  try {
    fs.writeFileSync(FILTER_STATE_FILE, JSON.stringify(filterState, null, 2), 'utf8');
  } catch (e) {}
}

function toRokuHex(hexStr, fallback = '0xEAB308FF') {
  if (!hexStr || typeof hexStr !== 'string') return fallback;
  const clean = hexStr.replace('#', '').replace(/^0x/i, '').trim();
  if (clean.length === 6) return `0x${clean.toUpperCase()}FF`;
  if (clean.length === 8) return `0x${clean.toUpperCase()}`;
  return fallback;
}

let mcpClient = null;
let mcpConnected = false;
let busStudents = [];          // [{ id, name }] from AlphaPortal's own student list
let busStudentsCheckedAt = 0;

// What the bus tracker is doing, for the startup log and /api/bus/status.
// Nothing secret goes in here.
const busHealth = {
  configured: false,
  connected: false,
  credential: 'unknown',
  students: [],
  lastPollAt: null,
  lastFixAt: null,
  lastShift: null,
  lastError: null,
  hint: null
};
let lastLoggedBusError = '';
function noteBusError(where, msg, hint) {
  const text = `${where}: ${msg}`;
  busHealth.lastError = text;
  if (hint) busHealth.hint = hint;
  if (text !== lastLoggedBusError) {
    lastLoggedBusError = text;
    console.error(`[AlphaPortal] ${text}${hint ? `\n[AlphaPortal] Fix: ${hint}` : ''}`);
  }
}

let latestBusCoords = {
  lat: HOME_LAT,
  lng: HOME_LON,
  isActive: false,
  status: 'No Active Bus Route',
  eta: '--',
  lastUpdated: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
};
let busNearAlert = null;
expireTransportModes();

function feetBetween(lat1, lon1, lat2, lon2) {
  const R = 20902231; // earth radius in feet
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(a)));
}

function distanceLabel(feet) {
  if (feet < 1000) return `${Math.max(50, Math.round(feet / 50) * 50)} ft away`;
  if (feet < 5280 * 0.3) return `${(Math.round(feet / 100) * 100).toLocaleString('en-US')} ft away`;
  const miles = feet / 5280;
  return `${miles < 10 ? miles.toFixed(1) : Math.round(miles)} mi away`;
}

function findStudentIds(obj) {
  const ids = [];
  function scan(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) scan(item);
      return;
    }
    for (const [k, v] of Object.entries(node)) {
      if ((k === 'studentId' || k === 'id' || k === 'student_id') && (typeof v === 'string' || typeof v === 'number')) {
        ids.push(String(v));
      } else if (typeof v === 'object') {
        scan(v);
      }
    }
  }
  scan(obj);
  return [...new Set(ids)];
}

function extractBusTelemetry(obj, rawText = '') {
  let found = { lat: null, lng: null, status: null, eta: null, hasDeparted: false, hasArrived: false, arrivedTime: null };
  if (/\b(departed|en\s*route|in\s*transit|on\s*route|route\s*active|bus\s*is\s*on|running|started)\b/i.test(rawText)) {
    found.hasDeparted = true;
  }
  if (/\b(arrived|completed|trip\s*completed|route\s*completed|dropped\s*off|at\s*school|ended|inactive|not\s*running|no\s*active)\b/i.test(rawText)) {
    found.hasArrived = true;
  }
  const arrivedMatch = rawText.match(/arrived\s*(?:at\s*school\s*)?(?:at\s*)?(\d{1,2}:\d{2}\s*(?:AM|PM)?)/i);
  if (arrivedMatch) {
    found.arrivedTime = arrivedMatch[1];
    found.hasArrived = true;
  }

  function scan(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) scan(item);
      return;
    }
    for (const [k, v] of Object.entries(node)) {
      const key = k.toLowerCase();
      if ((key === 'lat' || key === 'latitude') && typeof v === 'number' && v !== 0) found.lat = v;
      if ((key === 'lng' || key === 'lon' || key === 'longitude') && typeof v === 'number' && v !== 0) found.lng = v;
      if ((key === 'lat' || key === 'latitude') && typeof v === 'string' && !isNaN(parseFloat(v))) found.lat = parseFloat(v);
      if ((key === 'lng' || key === 'lon' || key === 'longitude') && typeof v === 'string' && !isNaN(parseFloat(v))) found.lng = parseFloat(v);

      if ((key === 'routename' || key === 'route_name' || key === 'busnumber' || key === 'bus_number' || key === 'status' || key === 'substatus' || key === 'state' || key === 'tripstatus') && v && typeof v === 'string') {
        if (!found.status) found.status = v;
        if (/departed|en\s*route|in\s*transit|active|running|started|approaching/i.test(v)) found.hasDeparted = true;
        if (/arrived|completed|ended|inactive|parked|at\s*school|dropped|finished/i.test(v)) found.hasArrived = true;
      }

      if ((key.includes('depart') || key.includes('start')) && !key.includes('scheduled') && !key.includes('planned') && v) {
        if (v === true || (typeof v === 'string' && v !== 'null' && v !== 'false' && v !== '')) {
          found.hasDeparted = true;
        }
      }

      if ((key.includes('arriv') || key.includes('complet') || key.includes('dropoff') || key.includes('ended')) && !key.includes('scheduled') && !key.includes('estimated') && !key.includes('eta') && v) {
        if (v === true || (typeof v === 'string' && v !== 'null' && v !== 'false' && v !== '')) {
          found.hasArrived = true;
          if (typeof v === 'string') found.arrivedTime = v;
        }
      }

      if ((key === 'eta' || key === 'estimatedarrival' || key === 'estimated_arrival' || key === 'minutes') && v) {
        if (!found.eta) found.eta = String(v);
        found.hasDeparted = true;
      }
      if (typeof v === 'object') scan(v);
    }
  }
  scan(obj);
  return found;
}

// Reads one MCP tool result: { ok, data, text, error }
function readToolResult(res) {
  const text = res?.content?.find?.(c => c.type === 'text')?.text || '';
  if (res?.isError) return { ok: false, text, error: text.slice(0, 300) || 'tool error' };
  let data = null;
  try { data = JSON.parse(text); } catch (e) {}
  return { ok: true, data, text };
}

// AlphaPortal's own student ids. The id in household.json is used only when it
// is one of these, so a school-system student number there cannot break tracking.
async function loadBusStudents() {
  const res = readToolResult(await mcpClient.callTool({ name: 'alphaportal_list_students', arguments: {} }));
  if (!res.ok) throw new Error(`could not list students (${res.error})`);
  const list = res.data?.data?.students || res.data?.students || (Array.isArray(res.data?.data) ? res.data.data : null);
  let found = [];
  if (Array.isArray(list)) {
    found = list.map(s => ({
      id: Number(s.studentId ?? s.id ?? s.student_id),
      name: String(s.firstName || s.name || s.fullName || '').trim()
    })).filter(s => s.id > 0);
  }
  if (!found.length) {
    found = findStudentIds(res.data || {}).map(id => ({ id: Number(id), name: '' })).filter(s => s.id > 0);
  }
  const configured = MEMBERS.filter(m => m.hasBus && m.alphaportalStudentId).map(m => Number(m.alphaportalStudentId));
  for (const id of configured) {
    if (found.length && !found.some(s => s.id === id)) {
      console.log(`[AlphaPortal] household.json has alphaportalStudentId ${id}, but AlphaPortal knows this account's students as ${found.map(s => s.id).join(', ')}. Using AlphaPortal's ids. Update household.json to one of those to silence this.`);
    }
  }
  const preferred = found.filter(s => configured.includes(s.id));
  busStudents = preferred.length ? preferred : found;
  busStudentsCheckedAt = Date.now();
  busHealth.students = busStudents.map(s => s.id);
  console.log(`[AlphaPortal] Tracking ${busStudents.length ? busStudents.map(s => `${s.name || 'student'} (${s.id})`).join(', ') : 'no students (none found on this account)'}`);
}

// The bus is shown whenever AlphaPortal reports a position, at any hour. The run
// we expect right now is asked first, then the other one.
async function updateBusData() {
  if (!mcpConnected || !mcpClient) return;
  const { h } = getNyHourMinute(new Date());
  const shifts = h < 11 ? ['AM', 'PM'] : ['PM', 'AM'];
  busHealth.lastPollAt = new Date().toISOString();
  try {
    if (!busStudents.length || Date.now() - busStudentsCheckedAt > 6 * 3600 * 1000) await loadBusStudents();
    for (const stu of busStudents) {
      for (const shift of shifts) {
        let res;
        try {
          res = readToolResult(await mcpClient.callTool({
            name: 'alphaportal_get_bus_location',
            arguments: { studentId: stu.id, shift }
          }));
        } catch (err) {
          noteBusError('bus location', err.message);
          continue;
        }
        if (!res.ok) {
          noteBusError('bus location', res.error, /expired|rejected|401|refresh token/i.test(res.error)
            ? 'Sign in at your district\'s AlphaPortal site, run JSON.parse(localStorage.user).User.RefreshToken in the browser console, and paste it into config.txt as ALPHAPORTAL_REFRESH_TOKEN. Then restart the server.'
            : null);
          continue;
        }
        const extracted = extractBusTelemetry(res.data || {}, res.text);
        if (extracted.lat && extracted.lng) {
          const feet = (HOME_LAT || HOME_LON) ? feetBetween(extracted.lat, extracted.lng, HOME_LAT, HOME_LON) : null;
          latestBusCoords = {
            lat: extracted.lat,
            lng: extracted.lng,
            isActive: true,
            shift,
            status: extracted.status || (shift === 'AM' ? 'Morning bus' : 'Afternoon bus'),
            eta: extracted.eta ? (String(extracted.eta).includes('min') ? extracted.eta : `${extracted.eta} mins`) : (feet != null ? distanceLabel(feet) : 'Live GPS'),
            distanceFt: feet,
            distanceLabel: feet != null ? distanceLabel(feet) : '',
            lastUpdated: new Date().toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' })
          };
          busHealth.lastFixAt = new Date().toISOString();
          busHealth.lastShift = shift;
          busHealth.lastError = null;
          busHealth.hint = null;
          checkBusNear(feet, shift);
          return;
        }
      }
    }
    latestBusCoords.isActive = false;
  } catch (e) {
    noteBusError('update', e.message);
  }
}

// One alert per run when the bus first comes within busNearFeet of home.
function checkBusNear(feet, shift) {
  const limit = Number(NOTIFY_CFG.busNearFeet) || 0;
  if (!limit || feet == null || feet > limit) return;
  const id = `bus-${toNyIsoDate(new Date())}-${shift}`;
  if (busNearAlert && busNearAlert.id === id) return;
  const nowSec = Math.floor(Date.now() / 1000);
  const riders = MEMBERS.filter(m => m.hasBus && activeModeFor(m) === 'BUS').map(m => m.name);
  busNearAlert = {
    id,
    kind: 'bus',
    at: nowSec,
    until: nowSec + 10 * 60,
    title: 'The bus is almost here',
    detail: `${distanceLabel(feet)}${riders.length ? ` for ${riders.join(' & ')}` : ''}`
  };
  console.log(`[AlphaPortal] Bus is ${distanceLabel(feet)} from home (${shift} run)`);
}

async function initAlphaPortal() {
  const rawToken = (process.env.ALPHAPORTAL_REFRESH_TOKEN || '').replace(/['"]/g, '').trim();
  if (!MEMBERS.some(m => m.hasBus)) return;
  if (!rawToken || rawToken.includes('your_')) {
    busHealth.hint = 'Add ALPHAPORTAL_REFRESH_TOKEN to config.txt';
    return;
  }
  busHealth.configured = true;

  // Run the tracker with the same Node that runs this server.
  const entry = fileURLToPath(new URL('./node_modules/alphaportal-mcp/dist/index.js', import.meta.url));
  const useLocal = fs.existsSync(entry);
  if (!useLocal) console.log('[AlphaPortal] alphaportal-mcp is not installed in this folder (run npm install). Trying npx instead.');

  try {
    const mcpTransport = new StdioClientTransport({
      command: useLocal ? process.execPath : 'npx',
      args: useLocal ? [entry] : ['-y', 'alphaportal-mcp'],
      stderr: 'pipe',
      env: {
        ...process.env,
        ALPHAPORTAL_REFRESH_TOKEN: rawToken,
        // this server has no browser to borrow a sign-in from
        ALPHAPORTAL_DISABLE_FETCHPROXY: process.env.ALPHAPORTAL_DISABLE_FETCHPROXY || '1'
      }
    });
    const errStream = mcpTransport.stderr;
    if (errStream) {
      errStream.on('data', chunk => {
        for (const line of String(chunk).split('\n')) {
          if (line.trim() && !/maintained by AI/i.test(line)) console.error(`[AlphaPortal] ${line.trim()}`);
        }
      });
    }

    const client = new Client({ name: 'family-dashboard', version: SERVER_VERSION }, { capabilities: {} });
    await client.connect(mcpTransport);
    mcpClient = client;
    mcpConnected = true;
    busHealth.connected = true;

    // check the sign-in once, so a dead token is reported plainly at startup
    try {
      const hc = readToolResult(await client.callTool({ name: 'alphaportal_healthcheck', arguments: {} }));
      if (hc.data && hc.data.ok === true) {
        busHealth.credential = 'ok';
        console.log('[AlphaPortal] Connected and signed in.');
      } else {
        busHealth.credential = 'failed';
        const why = hc.data?.error?.message || hc.error || 'unknown problem';
        noteBusError('sign-in check', why, hc.data?.hint || null);
      }
    } catch (e) {
      console.log('[AlphaPortal] Connected (sign-in check unavailable).');
    }

    await updateBusData();
    setInterval(updateBusData, 30000);
  } catch (err) {
    mcpConnected = false;
    busHealth.connected = false;
    noteBusError('start', err.message, 'Run npm install in the server folder, then restart.');
  }
}
initAlphaPortal();

app.get('/api/bus/status', (req, res) => {
  res.json({ ...busHealth, bus: { isActive: latestBusCoords.isActive, shift: latestBusCoords.shift || null, distanceFt: latestBusCoords.distanceFt ?? null, lastUpdated: latestBusCoords.lastUpdated } });
});

const tileCache = new Map();

app.get('/api/tile', async (req, res) => {
  try {
    const { type, z, x, y } = req.query;
    const cacheKey = `${type || 'osm'}_${z}_${x}_${y}`;
    const cached = tileCache.get(cacheKey);
    if (cached && (Date.now() - cached.time) < 300000) {
      res.setHeader('Content-Type', cached.contentType);
      return res.send(cached.buffer);
    }

    const urlsToTry = type === 'radar'
      ? [`https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q-900913/${z}/${x}/${y}.png`]
      : [
          `https://tile.openstreetmap.org/${z}/${x}/${y}.png`,
          `https://basemaps.cartocdn.com/rastertiles/voyager/${z}/${x}/${y}.png`
        ];

    for (const url of urlsToTry) {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15',
          'Accept': 'image/png,image/*;q=0.8',
          'Referer': 'https://www.openstreetmap.org/'
        }
      });
      if (response.ok) {
        const buffer = Buffer.from(await response.arrayBuffer());
        const contentType = response.headers.get('content-type') || 'image/png';
        if (tileCache.size > 600) tileCache.delete(tileCache.keys().next().value);
        tileCache.set(cacheKey, { buffer, contentType, time: Date.now() });
        res.setHeader('Content-Type', contentType);
        res.setHeader('Cache-Control', 'public, max-age=600');
        return res.send(buffer);
      }
    }
    res.status(502).end();
  } catch (err) {
    res.status(502).end();
  }
});

let cachedBountyData = {
  chores: [],
  users: KID_MEMBERS.map(m => ({ id: m.id, name: m.name, colorHex: m.colorHex, memberId: m.id, earnedTotal: 0, earnedPoints: 0, earnedMinutes: 0, earnedLabel: '0 points' }))
};

// Which configured person a chore-app user is: same id, same name, or a keyword match.
function memberForUser(userId, userName) {
  const id = String(userId || '').toLowerCase();
  const name = String(userName || '').toLowerCase();
  // the app can link a profile to a TV person explicitly (app 2.2 and later)
  const user = liveData.users.find(u => String(u.id || '').toLowerCase() === id);
  const linked = String(user?.dashboardMemberId || '').toLowerCase();
  if (linked) {
    const m = MEMBERS.find(x => x.id === linked);
    if (m) return m;
  }
  return MEMBERS.find(m => m.id === id || String(m.name || '').toLowerCase() === name)
    || MEMBERS.find(m => (m.matchKeywords || []).some(k => k && (id.includes(String(k).toLowerCase()) || name.includes(String(k).toLowerCase()))))
    || null;
}

function earnedLabelFor(points, minutes) {
  const parts = [];
  if (points || !minutes) parts.push(`${points} ${points === 1 ? 'point' : 'points'}`);
  if (minutes) parts.push(`${minutes} min`);
  return parts.join(' + ');
}

// Live copies of the family's Firebase data. Listeners keep them current, so a
// change in the app reaches the TV in a second or two and Firebase only counts
// reads when something actually changes.
const liveData = { chores: [], users: [], ledger: [], todos: [], meals: [], groceries: [], loaded: false };

function startLiveData() {
  if (!db) return;
  const root = db.collection('households').doc(householdId);
  const pending = new Set(['chores', 'users', 'ledger', 'todos']);
  for (const name of ['chores', 'users', 'ledger', 'todos', 'meals', 'groceries']) {
    root.collection(name).onSnapshot((snap) => {
      liveData[name] = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      pending.delete(name);
      if (pending.size === 0) liveData.loaded = true;
      refreshChoreBountyCache();
    }, (err) => console.error(`[Chores] Lost the live connection to ${name}: ${err.message}`));
  }
}

async function refreshChoreBountyCache() {
  try {
    if (!db) return;
    const allChores = liveData.chores;
    const ledger = liveData.ledger;
    // App v2 keeps a ledger of earned and used rewards. Older households only
    // have completed chores, so those still count until the app moves them over.
    const recordedChores = new Set(ledger.map(e => e.choreId).filter(Boolean));

    // repeating chores (app v2) are done once per day or week, in household time
    const todayIso = toNyIsoDate(new Date());
    const weekday = new Date(`${todayIso}T12:00:00Z`).getUTCDay();
    const weekStartIso = toNyIsoDate(new Date(Date.parse(`${todayIso}T12:00:00Z`) - weekday * 86400000));
    const doneThisPeriod = (c) => {
      if (!c.lastCompletedAt || !c.repeat || c.repeat === 'NONE') return false;
      const iso = toNyIsoDate(new Date(Number(c.lastCompletedAt)));
      return c.repeat === 'DAILY' ? iso === todayIso : iso >= weekStartIso;
    };

    const users = liveData.users
      .filter(d => (d.role || 'CHILD') !== 'PARENT')
      .map((d) => {
        const userData = d;
        const nameStr = userData.name || d.id;
        const idLower = d.id.toLowerCase();
        let earnedMinutes = 0;
        let earnedPoints = 0;
        const add = (type, amount) => { if (type === 'TIME') earnedMinutes += amount; else earnedPoints += amount; };
        // what's left to use: earned minus spent in the rewards history...
        for (const e of ledger) {
          if (String(e.memberId || '').toLowerCase() !== idLower) continue;
          add(e.rewardType, (Number(e.amount) || 0) * (e.kind === 'SPEND' ? -1 : 1));
        }
        // ...plus chores finished in version 1 of the app, which has no history yet
        for (const c of allChores) {
          if (c.status === 'COMPLETED' && String(c.completedBy || '').toLowerCase() === idLower && !recordedChores.has(c.id)) {
            add(c.rewardType, Number(c.amount) || 0);
          }
        }
        const pending = allChores.filter(c => c.status === 'PENDING' && String(c.completedBy || '').toLowerCase() === idLower).length;
        const member = memberForUser(d.id, nameStr);

        return {
          id: idLower,
          name: nameStr,
          memberId: member ? member.id : null,
          colorHex: member ? member.colorHex : toRokuHex(userData.themeColorHex || '', FAMILY_COLOR),
          earnedTotal: earnedPoints,
          earnedPoints,
          earnedMinutes,
          earnedLabel: earnedLabelFor(earnedPoints, earnedMinutes),
          pendingCount: pending
        };
      });

    const userToMember = {};
    for (const u of users) if (u.memberId) userToMember[u.id] = u.memberId;

    const availableChores = allChores
      .filter(c => (c.status === 'AVAILABLE' || (!c.status && !c.completedBy)) && !doneThisPeriod(c))
      .map(c => ({
        id: c.id,
        title: c.title || 'Chore',
        amount: c.amount || 0,
        rewardType: c.rewardType || 'POINTS',
        repeat: c.repeat || 'NONE',
        assignedTo: c.assignedTo || null,
        assignedMember: c.assignedTo ? (userToMember[String(c.assignedTo).toLowerCase()] || String(c.assignedTo).toLowerCase()) : null,
        displayReward: c.rewardType === 'TIME' ? `+${c.amount}m Time` : `+${c.amount} ${c.rewardType || 'POINTS'}`
      }));

    const pendingCount = allChores.filter(c => c.status === 'PENDING').length;
    cachedBountyData = { chores: availableChores, users, pendingCount };
  } catch (err) {
    console.error('[Chores] Refresh error:', err.message);
  }
}


let cachedExpandedEvents = [];

// how the calendar feeds did on their last load, for the app's health card
const calendarHealth = { configured: false, ok: null, events: 0, loadedAt: null, error: null };

async function downloadAndParseIcs(url, label = 'calendar') {
  if (!url) return {};
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'text/calendar,text/plain,*/*;q=0.8'
      }
    });
    if (!response.ok) {
      calendarHealth.error = `The ${label} link answered ${response.status}`;
      return null;
    }
    let rawIcsText = await response.text();
    rawIcsText = rawIcsText
      .replace(/TZID="?Eastern Standard Time"?/gi, 'TZID=America/New_York')
      .replace(/TZID="?Eastern Daylight Time"?/gi, 'TZID=America/New_York')
      .replace(/TZID="?US Eastern Standard Time"?/gi, 'TZID=America/New_York')
      .replace(/TZID="?Central Standard Time"?/gi, 'TZID=America/Chicago')
      .replace(/TZID="?Pacific Standard Time"?/gi, 'TZID=America/Los_Angeles');
    return ical.sync.parseICS(rawIcsText);
  } catch (err) {
    calendarHealth.error = `Couldn't load the ${label}: ${err.message}`;
    return null;
  }
}

// Turns a phrase from household.json into a whole-word, case-insensitive test.
// "hold" matches "Hold for dentist" but not "household". A phrase that ends in
// a colon ("canceled:") only matches at the start of a title.
function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function keywordTest(keyword) {
  const kw = String(keyword || '').trim().toLowerCase();
  if (!kw) return () => false;
  if (kw.endsWith(':')) return (text) => String(text || '').trim().toLowerCase().startsWith(kw);
  const re = new RegExp(`(^|[^a-z0-9])${escapeRegex(kw).replace(/\s+/g, '\\s*')}($|[^a-z0-9])`, 'i');
  return (text) => re.test(String(text || ''));
}
const globalIgnoreTests = (CAL_CFG.globalIgnoreKeywords || []).map(keywordTest);
const feedIgnoreTests = {};
for (const [key, list] of Object.entries(CAL_CFG)) {
  const m = key.match(/^(.+)IgnoreKeywords$/);
  if (m && m[1] !== 'global' && Array.isArray(list)) feedIgnoreTests[m[1]] = list.map(keywordTest);
}
const sharedKidTests = (CAL_CFG.sharedEventKeywords || []).map(keywordTest);
for (const m of MEMBERS) m._keywordTests = (m.matchKeywords || []).map(keywordTest);

function shouldIgnoreEvent(title, sourceType) {
  const t = (title || '').trim();
  if (!t) return true;
  if (globalIgnoreTests.some(test => test(t))) return true;
  if ((feedIgnoreTests[sourceType] || []).some(test => test(t))) return true;
  return false;
}

function hasExdateMatch(exdateObj, candidateDate) {
  if (!exdateObj) return false;
  const utcIso = candidateDate.toISOString().slice(0, 10);
  const nyIso = toNyIsoDate(candidateDate);
  if (exdateObj[utcIso] || exdateObj[nyIso]) return true;
  for (const exVal of Object.values(exdateObj)) {
    const exDt = new Date(exVal);
    if (!isNaN(exDt.getTime())) {
      if (exDt.toISOString().slice(0, 10) === utcIso || toNyIsoDate(exDt) === nyIso) return true;
    }
  }
  return false;
}

let lastCalendarCount = -1;
async function refreshCalendarBackgroundCache() {
  try {
    let famUrl = (process.env.CALENDAR_ICAL_URL || '').trim();
    if (famUrl.includes('/calendar/embed') && famUrl.includes('src=')) {
      const srcMatch = famUrl.match(/[?&]src=([^&]+)/);
      if (srcMatch && srcMatch[1]) {
        famUrl = `https://calendar.google.com/calendar/ical/${srcMatch[1]}/public/basic.ics`;
      }
    }
    const workUrl = (process.env.WORK_ICAL_URL || '').trim();

    calendarHealth.error = null;
    calendarHealth.configured = Boolean(famUrl || workUrl);
    const [familyRaw, workRaw] = await Promise.all([
      downloadAndParseIcs(famUrl, 'family calendar'),
      downloadAndParseIcs(workUrl, 'work calendar')
    ]);
    const familyData = familyRaw || {};
    const workData = workRaw || {};
    calendarHealth.ok = calendarHealth.configured ? (familyRaw !== null && workRaw !== null) : null;

    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const windowStart = new Date(startOfToday.getTime() - 35 * 86400000);
    const windowEnd = new Date(startOfToday.getTime() + 120 * 86400000);

    const instances = [];

    function expandFeed(feedData, sourceType) {
      if (!feedData || typeof feedData !== 'object') return;

      const recurrenceOverrides = new Set();
      for (const ev of Object.values(feedData)) {
        if (ev && ev.type === 'VEVENT' && ev.recurrenceid && ev.uid) {
          const rDate = new Date(ev.recurrenceid);
          if (!isNaN(rDate.getTime())) {
            recurrenceOverrides.add(`${ev.uid}_${rDate.toISOString().slice(0, 10)}`);
            recurrenceOverrides.add(`${ev.uid}_${toNyIsoDate(rDate)}`);
          }
        }
      }

      function addInstance(ev, instStart, instEnd, isAllDay) {
        const rawTitle = String(ev.summary || (sourceType === 'work' ? 'Work Meeting' : 'Busy')).trim();
        const durationMs = instEnd - instStart;
        const daySpan = isAllDay ? Math.max(1, Math.round(durationMs / 86400000)) : 1;
        const maxSpan = Math.min(daySpan, 14);

        for (let dOffset = 0; dOffset < maxSpan; dOffset++) {
          const curStart = new Date(instStart);
          if (dOffset > 0) curStart.setDate(curStart.getDate() + dOffset);
          if (curStart < windowStart || curStart > windowEnd) continue;

          const wk = nyWkFmt.format(curStart).toUpperCase();
          const monShort = nyMonShortFmt.format(curStart).toUpperCase();
          const monFull = nyMonFullFmt.format(curStart).toUpperCase();

          const allDayDate = new Date(instStart.getFullYear(), instStart.getMonth(), instStart.getDate() + dOffset);
          const isoDate = isAllDay
            ? `${allDayDate.getFullYear()}-${String(allDayDate.getMonth() + 1).padStart(2, '0')}-${String(allDayDate.getDate()).padStart(2, '0')}`
            : toNyIsoDate(curStart);
          const dayNum = String(Number(isoDate.split('-')[2]));

          const timeLabel = isAllDay ? 'ALL DAY' : nyTimeLblFmt.format(curStart);
          const cleanLoc = String(ev.location || '').trim();
          const cleanDesc = String(ev.description || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, 90);

          instances.push({
            title: rawTitle,
            location: cleanLoc,
            description: cleanDesc,
            startMs: curStart.getTime(),
            endMs: isAllDay ? (curStart.getTime() + 86400000) : (curStart.getTime() + Math.max(durationMs, 1800000)),
            isAllDay,
            sourceType,
            isoDate,
            monthHeader: monFull,
            dayBadge: `${wk} ${dayNum}`,
            shortDate: `${monShort} ${dayNum} (${wk})`,
            dateLabel: nyDateLblFmt.format(curStart),
            timeLabel
          });
        }
      }

      for (const ev of Object.values(feedData)) {
        if (!ev || ev.type !== 'VEVENT' || !ev.start) continue;
        if (ev.status && String(ev.status).toUpperCase() === 'CANCELLED') continue;
        if (shouldIgnoreEvent(ev.summary, sourceType)) continue;

        const origStart = new Date(ev.start);
        if (isNaN(origStart.getTime())) continue;
        const origEnd = ev.end ? new Date(ev.end) : origStart;

        if (!ev.rrule && (origEnd < windowStart || origStart > windowEnd)) continue;

        const durationMs = Math.max(0, origEnd - origStart);
        const isAllDay = ev.datetype === 'date' || (origStart.getHours() === 0 && origStart.getMinutes() === 0 && durationMs >= 86400000);

        if (ev.rrule) {
          try {
            const ruleUntil = ev.rrule.options?.until ? new Date(ev.rrule.options.until) : null;
            if (ruleUntil && ruleUntil < windowStart) continue;

            const origNyHm = getNyHourMinute(origStart);
            const dates = ev.rrule.between(windowStart, windowEnd, true);
            for (const dt of dates) {
              const utcIso = dt.toISOString().slice(0, 10);
              const nyIso = toNyIsoDate(dt);
              if (hasExdateMatch(ev.exdate, dt)) continue;
              if (recurrenceOverrides.has(`${ev.uid}_${utcIso}`) || recurrenceOverrides.has(`${ev.uid}_${nyIso}`)) continue;

              const instStart = new Date(dt);
              if (!isAllDay) {
                const curHm = getNyHourMinute(instStart);
                const diffMinutes = (origNyHm.h * 60 + origNyHm.m) - (curHm.h * 60 + curHm.m);
                instStart.setTime(instStart.getTime() + diffMinutes * 60000);
              }
              const instEnd = new Date(instStart.getTime() + durationMs);
              addInstance(ev, instStart, instEnd, isAllDay);
            }
          } catch (rErr) {
            if (origEnd >= windowStart && origStart <= windowEnd) {
              addInstance(ev, origStart, origEnd, isAllDay);
            }
          }
        } else {
          addInstance(ev, origStart, origEnd, isAllDay);
        }
      }
    }

    expandFeed(familyData, 'family');
    expandFeed(workData, 'work');

    cachedExpandedEvents = instances;
    calendarHealth.events = instances.length;
    if (calendarHealth.ok) calendarHealth.loadedAt = Date.now();
    if (instances.length !== lastCalendarCount) {
      console.log(`[Calendar] Ready: ${instances.length} active events cached in RAM.`);
      lastCalendarCount = instances.length;
    }
    await refreshTransportBackgroundCache();
  } catch (err) {
    console.error('[Calendar] Background refresh error:', err.message);
  }
}

// One switchable calendar per person in household.json.
function buildPersonCategories() {
  return MEMBERS.map(m => {
    if (filterState.enabledMap[m.id] === undefined) {
      filterState.enabledMap[m.id] = true;
    }
    return { id: m.id, name: m.name, colorHex: m.colorHex, enabled: Boolean(filterState.enabledMap[m.id]) };
  });
}

// Decides whose event this is, using only what household.json says:
//   1. a feed that belongs to one person (sourceType) is always theirs
//   2. a person's locationRules (title + place) win next
//   3. a keyword hit for a parent wins over the kids
//   4. a shared keyword ("no school") means all the kids
//   5. keyword hits for one or more kids
//   6. otherwise it is a whole-family event
function matchEventToCategories(title, description, location, sourceType, categories) {
  const catOf = (m) => categories.find(c => c.id === m.id) || { id: m.id, name: m.name, colorHex: m.colorHex, enabled: true };
  const single = (m) => {
    const c = catOf(m);
    return { primary: c, memberKeys: [m.id], displayBadge: c.name, colorHex: c.colorHex, enabled: c.enabled };
  };
  const group = (members, badge) => {
    const cats = members.map(catOf);
    const on = cats.filter(c => c.enabled);
    const primary = on[0] || cats[0] || { id: 'family', name: FAMILY_NAME, colorHex: FAMILY_COLOR, enabled: true };
    return {
      primary,
      memberKeys: members.map(m => m.id),
      displayBadge: badge || cats.map(c => c.name).join(' & '),
      colorHex: (on.length === cats.length || on.length === 0) ? FAMILY_COLOR : on[0].colorHex,
      enabled: cats.length === 0 ? true : on.length > 0
    };
  };

  const feedOwner = MEMBERS.find(m => m.sourceType && m.sourceType === sourceType);
  if (feedOwner) return single(feedOwner);

  const t = (title || '').trim();
  const loc = (location || '').trim();
  const text = `${t} ${description || ''} ${loc}`;
  const has = (hay, needle) => !needle || hay.toLowerCase().includes(String(needle).toLowerCase());

  const byRule = FAMILY_MEMBERS.find(m => (m.locationRules || []).some(r => (r.titleContains || r.locationContains) && has(t, r.titleContains) && has(loc, r.locationContains)));
  if (byRule) return single(byRule);

  const hits = FAMILY_MEMBERS.filter(m => m._keywordTests.some(test => test(text)));
  const parentHit = hits.find(m => m.role !== 'kid');
  if (parentHit) return single(parentHit);

  if (KID_MEMBERS.length > 0 && sharedKidTests.some(test => test(t))) {
    return KID_MEMBERS.length === 1 ? single(KID_MEMBERS[0]) : group(KID_MEMBERS);
  }
  if (hits.length === 1) return single(hits[0]);
  if (hits.length > 1) return group(hits);
  return group(FAMILY_MEMBERS, FAMILY_NAME);
}

function buildCalendarPayloadFromCache(users = [], overviewMem = 'all') {
  const categories = buildPersonCategories();
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const todayIso = toNyIsoDate(now);
  const nowMs = now.getTime();

  const seenKeys = new Set();
  const activeEvents = [];

  // chores and to-dos with a day (and maybe a time) join the calendar
  const taskEvents = db ? buildTaskEvents({
    chores: liveData.chores, todos: liveData.todos, meals: liveData.meals, users: liveData.users, memberForUser, fmt: TASK_FMT, now
  }) : [];

  for (const rawEv of [...cachedExpandedEvents, ...taskEvents]) {
    let matched;
    if (rawEv.kind) {
      const cat = rawEv.memberKey && categories.find(c => c.id === rawEv.memberKey);
      matched = cat
        ? { primary: cat, memberKeys: [cat.id], displayBadge: cat.name, colorHex: cat.colorHex, enabled: cat.enabled }
        : { primary: { id: 'family' }, memberKeys: FAMILY_MEMBERS.map(m => m.id), displayBadge: FAMILY_NAME, colorHex: FAMILY_COLOR, enabled: true };
    } else {
      matched = matchEventToCategories(rawEv.title, rawEv.description, rawEv.location, rawEv.sourceType, categories);
    }
    if (!matched.enabled) continue;
    if (overviewMem !== 'all' && !matched.memberKeys.includes(overviewMem)) continue;

    const key = `${rawEv.isoDate}_${rawEv.timeLabel}_${rawEv.title.toLowerCase()}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);

    activeEvents.push({
      ...rawEv,
      calendarId: matched.primary.id,
      calendarName: matched.displayBadge,
      colorHex: matched.colorHex,
      enabled: true
    });
  }

  activeEvents.sort((a, b) => a.startMs - b.startMs);

  const todayAll = activeEvents.filter(e => e.isoDate === todayIso && (e.isAllDay || (e.endMs || (e.startMs + 1800000)) > nowMs));
  todayAll.sort((a, b) => (a.isAllDay !== b.isAllDay ? (a.isAllDay ? 1 : -1) : a.startMs - b.startMs));
  // Send enough for the TV to fill its screens, and say how many there really
  // are so it can show "+3 more" instead of quietly dropping them.
  const todayEvents = todayAll.slice(0, 12);
  const upcomingAll = activeEvents.filter(e => e.isoDate > todayIso);
  const upcomingWeekList = upcomingAll.slice(0, 40);

  const weekDays = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(startOfToday);
    d.setDate(d.getDate() + i);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const dayAll = activeEvents
      .filter(e => e.isoDate === iso)
      .sort((a, b) => (a.isAllDay !== b.isAllDay ? (a.isAllDay ? 1 : -1) : a.startMs - b.startMs));
    const dayEvents = dayAll.slice(0, 8);
    weekDays.push({
      dayName: nyWkFmt.format(d).toUpperCase(),
      dateNum: `${nyMonShortFmt.format(d).toUpperCase()} ${d.getDate()}`,
      isToday: i === 0,
      total: dayAll.length,
      richEvents: dayEvents,
      events: dayEvents.map(e => `${e.timeLabel}: ${e.title}`)
    });
  }

  const year = now.getFullYear();
  const month = now.getMonth();
  const monthTitle = nyMonFullFmt.format(now).toUpperCase();
  const firstDayOfMonth = new Date(year, month, 1);
  const startOffset = firstDayOfMonth.getDay();
  const gridStartDate = new Date(year, month, 1 - startOffset);

  const monthCells = [];
  for (let i = 0; i < 42; i++) {
    const cellDate = new Date(gridStartDate);
    cellDate.setDate(gridStartDate.getDate() + i);
    const iso = `${cellDate.getFullYear()}-${String(cellDate.getMonth() + 1).padStart(2, '0')}-${String(cellDate.getDate()).padStart(2, '0')}`;
    const cellEvents = activeEvents.filter(e => e.isoDate === iso);
    monthCells.push({
      dayNum: String(cellDate.getDate()),
      inMonth: cellDate.getMonth() === month,
      isToday: cellDate.getTime() === startOfToday.getTime(),
      count: cellEvents.length,
      preview: cellEvents.slice(0, 2).map(e => e.title),
      previewColors: cellEvents.slice(0, 2).map(e => e.colorHex)
    });
  }

  return {
    todayEvents,
    todayTotal: todayAll.length,
    listTotal: upcomingAll.length,
    list: upcomingWeekList,
    weekDays,
    monthCells,
    monthTitle,
    calendars: categories
  };
}

const geocodeCache = new Map();
const routeCache = new Map();

function isPhysicalLocation(locStr) {
  if (!locStr || locStr.length < 4) return false;
  if (/^(https?:|zoom|microsoft\s*teams|teams\s*meeting|webex|google\s*meet|online|virtual|tbd|none)/i.test(locStr.trim())) {
    return false;
  }
  return true;
}

async function geocodeAddress(addressStr) {
  const key = addressStr.toLowerCase().trim();
  if (geocodeCache.has(key)) return geocodeCache.get(key);

  for (const m of (householdConfig.members || [])) {
    if (m.primaryDestination && key.includes(m.primaryDestination.name.toLowerCase())) {
      const coords = { lat: m.primaryDestination.lat, lon: m.primaryDestination.lon };
      geocodeCache.set(key, coords);
      return coords;
    }
  }

  try {
    // home.geocodeHint ("Springfield, IL") helps short addresses like "Main St gym" land in the right town
    const hint = String(householdConfig.home?.geocodeHint || '').trim();
    const needsHint = hint && !addressStr.toLowerCase().includes(hint.split(',').pop().trim().toLowerCase());
    const q = encodeURIComponent(needsHint ? `${addressStr}, ${hint}` : addressStr);
    const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${q}`, {
      headers: { 'User-Agent': `FamilyDashboard/${SERVER_VERSION} (home server)` }
    });
    if (res.ok) {
      const arr = await res.json();
      if (arr && arr[0] && arr[0].lat && arr[0].lon) {
        const coords = { lat: parseFloat(arr[0].lat), lon: parseFloat(arr[0].lon) };
        geocodeCache.set(key, coords);
        return coords;
      }
    }
  } catch (e) {}
  return null;
}

async function getDriveRoute(destLat, destLon) {
  const key = `${destLat.toFixed(4)},${destLon.toFixed(4)}`;
  const cached = routeCache.get(key);
  if (cached && (Date.now() - cached.time) < 600000) return cached.data;

  try {
    const url = `https://router.project-osrm.org/route/v1/driving/${HOME_LON},${HOME_LAT};${destLon},${destLat}?overview=false`;
    const res = await fetch(url, { headers: { 'User-Agent': `FamilyDashboard/${SERVER_VERSION}` } });
    if (res.ok) {
      const json = await res.json();
      const route = json?.routes?.[0];
      if (route) {
        const mins = Math.max(1, Math.round(route.duration / 60));
        const miles = (route.distance / 1609.34).toFixed(1);
        const data = { mins, miles, label: `${mins} mins (${miles} mi)` };
        routeCache.set(key, { time: Date.now(), data });
        return data;
      }
    }
  } catch (e) {}

  const R = 3958.8;
  const dLat = ((destLat - HOME_LAT) * Math.PI) / 180;
  const dLon = ((destLon - HOME_LON) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos((HOME_LAT * Math.PI) / 180) * Math.cos((destLat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  const miles = (R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * 1.3).toFixed(1);
  const mins = Math.max(3, Math.round(Number(miles) * 2.2));
  return { mins, miles, label: `${mins} mins (${miles} mi)` };
}

let cachedTransportMembers = [];
let cachedNextImminentEventTrip = null;

async function refreshTransportBackgroundCache() {
  try {
    const categories = buildPersonCategories();
    const nowMs = Date.now();
    const twoHoursMs = 2 * 3600 * 1000;
    const next24HoursMs = 24 * 3600 * 1000;

    const memberConfigs = MEMBERS;
    const updatedMembers = [];
    let soonest2HrTrip = null;

    for (const mCfg of memberConfigs) {
      const dest = mCfg.primaryDestination || { name: 'Destination', lat: HOME_LAT, lon: HOME_LON };
      const primaryRoute = await getDriveRoute(dest.lat, dest.lon);

      const upcomingWithLoc = cachedExpandedEvents
        .filter(ev => {
          if (ev.isAllDay || !isPhysicalLocation(ev.location)) return false;
          if (flights.isFlightEvent(ev)) return false; // flights plan their own drive to the airport
          const diff = ev.startMs - nowMs;
          if (diff < -15 * 60000 || diff > next24HoursMs) return false;
          const matched = matchEventToCategories(ev.title, ev.description, ev.location, ev.sourceType, categories);
          return matched.memberKeys.includes(mCfg.id);
        })
        .sort((a, b) => a.startMs - b.startMs)[0];

      let nextEventTrip = null;
      if (upcomingWithLoc) {
        const evCoords = await geocodeAddress(upcomingWithLoc.location);
        const targetCoords = evCoords || { lat: dest.lat, lon: dest.lon };
        const evRoute = await getDriveRoute(targetCoords.lat, targetCoords.lon);
        const leaveByDate = new Date(upcomingWithLoc.startMs - (evRoute.mins + 10) * 60000);
        const leaveByStr = nyTimeLblFmt.format(leaveByDate);
        const within2Hours = (upcomingWithLoc.startMs - nowMs) <= twoHoursMs;

        nextEventTrip = {
          eventTitle: upcomingWithLoc.title,
          eventTime: upcomingWithLoc.timeLabel,
          location: upcomingWithLoc.location,
          driveMins: evRoute.mins,
          driveMiles: evRoute.miles,
          driveLabel: evRoute.label,
          leaveBy: leaveByStr,
          leaveByMs: leaveByDate.getTime(),
          startMs: upcomingWithLoc.startMs,
          within2Hours,
          lat: targetCoords.lat,
          lon: targetCoords.lon
        };

        if (within2Hours && (!soonest2HrTrip || upcomingWithLoc.startMs < soonest2HrTrip.startMs)) {
          soonest2HrTrip = {
            ...nextEventTrip,
            memberId: mCfg.id,
            memberName: mCfg.name,
            colorHex: mCfg.colorHex,
            startMs: upcomingWithLoc.startMs
          };
        }
      }

      // a flight (or a pickup at the airport) that needs leaving sooner than the next event
      const flightTrip = flights.tripFor(mCfg.id);
      if (flightTrip && (!nextEventTrip || flightTrip.leaveByMs < nextEventTrip.leaveByMs)) {
        nextEventTrip = flightTrip;
        if (flightTrip.within2Hours && (!soonest2HrTrip || flightTrip.startMs < soonest2HrTrip.startMs)) {
          soonest2HrTrip = { ...flightTrip, memberId: mCfg.id, memberName: mCfg.name, colorHex: mCfg.colorHex };
        }
      }

      const activeMode = activeModeFor(mCfg);

      updatedMembers.push({
        id: mCfg.id,
        name: mCfg.name,
        colorHex: mCfg.colorHex,
        hasBus: Boolean(mCfg.hasBus),
        activeMode,
        scheduleNote: mCfg.scheduleNote || '',
        primaryName: dest.name,
        primaryAddress: dest.address,
        primaryDriveMins: primaryRoute.mins,
        primaryDriveMiles: primaryRoute.miles,
        primaryDriveLabel: primaryRoute.label,
        primaryLat: dest.lat,
        primaryLon: dest.lon,
        busStatus: mCfg.hasBus ? latestBusCoords.status : 'Car Commute',
        busEta: mCfg.hasBus ? latestBusCoords.eta : primaryRoute.label,
        nextEventTrip
      });
    }

    cachedTransportMembers = updatedMembers;
    cachedNextImminentEventTrip = soonest2HrTrip;
  } catch (err) {
    console.error('[Transport] Cache error:', err.message);
  }
}

let cachedWeatherLocations = {};

async function fetchCityWeather(lat, lon) {
  try {
    const [owmRes, meteoRes] = await Promise.all([
      fetch(`https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&units=imperial&appid=${process.env.OPENWEATHER_KEY}`).then(r => r.json()).catch(() => ({})),
      fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=temperature_2m,precipitation_probability,weathercode&daily=weathercode,temperature_2m_max,temperature_2m_min,precipitation_probability_max&temperature_unit=fahrenheit&timezone=${encodeURIComponent(TZ)}`).then(r => r.json()).catch(() => ({}))
    ]);

    // Open-Meteo answers in the household's time zone, so "now" has to be worked
    // out in that zone too. (Using UTC here made the NOW column several hours ahead.)
    const nowLocal = new Date();
    const nowHourIso = `${toNyIsoDate(nowLocal)}T${String(getNyHourMinute(nowLocal).h).padStart(2, '0')}`;
    let startIdx = 0;
    if (meteoRes.hourly?.time) {
      const found = meteoRes.hourly.time.findIndex(t => t.startsWith(nowHourIso));
      if (found >= 0) startIdx = found;
    }

    const hourly = [];
    for (let i = 0; i < 8; i++) {
      const idx = startIdx + i;
      const rawTime = meteoRes.hourly?.time?.[idx];
      const dt = rawTime ? new Date(rawTime) : new Date(Date.now() + i * 3600000);
      hourly.push({
        time: i === 0 ? 'NOW' : hourLabel(rawTime, dt),
        temp: Math.round(meteoRes.hourly?.temperature_2m?.[idx] || owmRes.main?.temp || 70),
        pop: Math.round(meteoRes.hourly?.precipitation_probability?.[idx] || 0),
        icon: mapWmoToIcon(meteoRes.hourly?.weathercode?.[idx] || 0)
      });
    }

    const daily = [];
    for (let i = 0; i < 7; i++) {
      const rawDate = meteoRes.daily?.time?.[i];
      const dt = rawDate ? new Date(`${rawDate}T12:00:00`) : new Date(Date.now() + i * 86400000);
      daily.push({
        dayName: i === 0 ? 'TODAY' : dt.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase(),
        high: Math.round(meteoRes.daily?.temperature_2m_max?.[i] || 75),
        low: Math.round(meteoRes.daily?.temperature_2m_min?.[i] || 55),
        pop: Math.round(meteoRes.daily?.precipitation_probability_max?.[i] || 0),
        icon: mapWmoToIcon(meteoRes.daily?.weathercode?.[i] || 0)
      });
    }

    const cond = (owmRes.weather?.[0]?.description || 'Clear').replace(/\b\w/g, l => l.toUpperCase());
    const iconCode = /storm|thunder/i.test(cond) ? 'storm' : /rain|drizzle|shower/i.test(cond) ? 'rain' : /cloud|overcast/i.test(cond) ? 'cloud' : 'sun';

    return {
      temp: Math.round(owmRes.main?.temp || hourly[0]?.temp || 72),
      high: daily[0]?.high || 75,
      low: daily[0]?.low || 55,
      todayMaxPop: daily[0]?.pop || 0,
      condition: cond,
      iconCode,
      hourly,
      daily
    };
  } catch (e) {
    return { temp: 72, high: 75, low: 55, todayMaxPop: 0, condition: 'Clear', iconCode: 'sun', hourly: [], daily: [] };
  }
}

// "2026-11-16T17:00" -> "5 PM", read straight from the text so the server's own time zone never matters
function hourLabel(rawTime, fallbackDate) {
  const m = /T(\d{2}):/.exec(String(rawTime || ''));
  const h = m ? Number(m[1]) : getNyHourMinute(fallbackDate).h;
  return `${h % 12 || 12} ${h < 12 ? 'AM' : 'PM'}`;
}

function mapWmoToIcon(code) {
  if (code >= 95) return 'storm';
  if (code >= 51 && code <= 82) return 'rain';
  if (code >= 2 && code <= 48) return 'cloud';
  return 'sun';
}

async function refreshWeatherBackgroundCache() {
  const locs = WEATHER_LOCS;
  const newMap = {};
  for (const loc of locs) {
    newMap[loc.id] = await fetchCityWeather(loc.lat, loc.lon);
  }
  cachedWeatherLocations = newMap;
}

function attachRadarTileUrls(hostHeader, wxLocId) {
  const loc = WEATHER_LOCS.find(l => l.id === wxLocId) || WEATHER_LOCS[0];
  const lat = loc.lat;
  const lon = loc.lon;

  const wxData = cachedWeatherLocations[loc.id] || cachedWeatherLocations[HOME_WX_ID] || { temp: 72, high: 75, low: 55, todayMaxPop: 0, condition: 'Clear', iconCode: 'sun', hourly: [], daily: [] };

  const rZoom = 7;
  const n = Math.pow(2, rZoom);
  const centerTileX = Math.floor(((lon + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const centerTileY = Math.floor(((1 - Math.log(latRad ? Math.tan(latRad) + 1 / Math.cos(latRad) : 1) / Math.PI) / 2) * n);

  const radarBaseTiles = [];
  const radarOverlayTiles = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const tx = centerTileX + dx;
      const ty = centerTileY + dy;
      radarBaseTiles.push(`http://${hostHeader}/api/tile?type=osm&z=${rZoom}&x=${tx}&y=${ty}`);
      radarOverlayTiles.push(`http://${hostHeader}/api/tile?type=radar&z=${rZoom}&x=${tx}&y=${ty}`);
    }
  }
  return { ...wxData, radarBaseTiles, radarOverlayTiles };
}

function getBusMapTiles(lat, lon, zoom = 15, hostHeader = `localhost:${PORT}`) {
  const z = Math.min(Math.max(Number(zoom || 15), 12), 18);
  const n = Math.pow(2, z);
  const exactX = ((lon + 180) / 360) * n;
  const latRad = (lat * Math.PI) / 180;
  const exactY = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;

  const centerTileX = Math.floor(exactX);
  const centerTileY = Math.floor(exactY);
  const fracX = exactX - centerTileX;
  const fracY = exactY - centerTileY;

  const tiles = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      tiles.push(`http://${hostHeader}/api/tile?type=osm&z=${z}&x=${centerTileX + dx}&y=${centerTileY + dy}`);
    }
  }
  return {
    tiles,
    ovPinX: Math.round(170 + fracX * 170),
    ovPinY: Math.round(170 + fracY * 170),
    bigPinX: Math.round(230 + fracX * 230),
    bigPinY: Math.round(230 + fracY * 230),
    zoom: z
  };
}

startLiveData();
refreshWeatherBackgroundCache();
// Flights (optional): flight numbers on the calendar, tracked with the family's own FlightAware and OpenSky keys
const flightTimeFmt = new Map();
function timeInZone(msv, tz) {
  const zone = tz || TZ;
  if (!flightTimeFmt.has(zone)) {
    try { flightTimeFmt.set(zone, new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', minute: '2-digit', ...(zone !== TZ ? { timeZoneName: 'short' } : {}) })); } catch (e) { flightTimeFmt.set(zone, nyTimeLblFmt); }
  }
  return flightTimeFmt.get(zone).format(new Date(msv));
}
const flights = createFlights({
  file: path.join(process.cwd(), 'flights.json'),
  usageFile: path.join(process.cwd(), 'flights-usage.json'),
  airportsFile: fileURLToPath(new URL('./data/airports.json', import.meta.url)),
  events: () => cachedExpandedEvents,
  memberOf: (ev) => matchEventToCategories(ev.title, ev.description, ev.location, ev.sourceType, buildPersonCategories()).memberKeys.filter(k => MEMBERS.some(m => m.id === k)),
  memberName: (id) => (MEMBERS.find(m => m.id === id) || {}).name || id,
  memberColor: (id) => (MEMBERS.find(m => m.id === id) || {}).colorHex || '0xE8623CFF',
  home: () => (HOME_LAT || HOME_LON ? { lat: HOME_LAT, lon: HOME_LON } : null),
  driveTo: (lat, lon) => getDriveRoute(lat, lon),
  timeIn: timeInZone
});
flights.start();

refreshCalendarBackgroundCache();

// no Firebase reads here: this only re-sorts what the listeners already have,
// so repeating chores come back at midnight
setInterval(refreshChoreBountyCache, 60000);
setInterval(refreshWeatherBackgroundCache, 120000);
setInterval(refreshCalendarBackgroundCache, 60000);
setInterval(refreshTransportBackgroundCache, 120000);

// ---- alerts the TV can chime for --------------------------------------------
function clockMinutes(str, fallback) {
  const m = String(str || '').match(/^(\d{1,2}):(\d{2})$/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : fallback;
}

function inQuietHours(ms) {
  const start = clockMinutes(NOTIFY_CFG.quietStart, -1);
  const end = clockMinutes(NOTIFY_CFG.quietEnd, -1);
  if (start < 0 || end < 0 || start === end) return false;
  const { h, m } = getNyHourMinute(new Date(ms));
  const now = h * 60 + m;
  return start < end ? (now >= start && now < end) : (now >= start || now < end);
}

function slugOf(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
}

// Everything that should chime in the next few hours, plus anything chiming now.
// Events follow the calendars that are switched on, not the person filter, so
// nobody's reminder is silenced because the TV was showing someone else.
function buildAlerts() {
  const nowMs = Date.now();
  const alerts = [];
  const categories = buildPersonCategories();
  const lead = Math.max(0, Number(NOTIFY_CFG.eventLeadMinutes) || 0);
  const horizon = nowMs + 6 * 3600 * 1000;

  if (lead > 0) {
    const seen = new Set();
    for (const ev of cachedExpandedEvents) {
      if (ev.isAllDay || !ev.startMs) continue;
      const at = ev.startMs - lead * 60000;
      if (ev.startMs + 5 * 60000 < nowMs || at > horizon) continue;
      const matched = matchEventToCategories(ev.title, ev.description, ev.location, ev.sourceType, categories);
      if (!matched.enabled) continue;
      const id = `ev-${ev.startMs}-${slugOf(ev.title)}`;
      if (seen.has(id)) continue;
      seen.add(id);
      alerts.push({
        id,
        kind: 'event',
        at: Math.floor(at / 1000),
        until: Math.floor((ev.startMs + 5 * 60000) / 1000),
        title: ev.title,
        detail: [`Starts at ${ev.timeLabel}`, matched.displayBadge, ev.location].filter(Boolean).join('  ·  '),
        colorHex: matched.colorHex,
        sound: !inQuietHours(at)
      });
    }
  }

  if (NOTIFY_CFG.leaveAlerts !== false) {
    for (const mem of cachedTransportMembers) {
      const trip = mem.nextEventTrip;
      if (!trip || !trip.leaveByMs || !trip.startMs) continue;
      if (trip.startMs < nowMs || trip.leaveByMs > horizon) continue;
      alerts.push({
        id: `leave-${mem.id}-${trip.startMs}`,
        kind: 'leave',
        at: Math.floor(trip.leaveByMs / 1000),
        until: Math.floor(trip.startMs / 1000),
        title: `Time to leave${mem.name ? ` for ${mem.name}` : ''}`,
        detail: [trip.eventTitle, `${trip.driveMins} min drive`, trip.flight ? trip.eventTime : `starts ${trip.eventTime}`].filter(Boolean).join('  ·  '),
        colorHex: mem.colorHex,
        sound: !inQuietHours(trip.leaveByMs)
      });
    }
  }

  if (busNearAlert && busNearAlert.until * 1000 > nowMs) {
    alerts.push({ ...busNearAlert, colorHex: '0x22C55EFF', sound: !inQuietHours(busNearAlert.at * 1000) });
  }

  // from Home Assistant: the doorbell, a door left open. Safety alarms chime even in quiet hours.
  for (const a of homeAssistant.alerts(nowMs)) {
    const urgent = /smoke|gas|carbon monoxide|water|going off/i.test(a.title);
    alerts.push({ ...a, colorHex: urgent ? '0xEF4444FF' : '0xF59E0BFF', sound: urgent || !inQuietHours(a.at * 1000) });
  }

  // flights: delays, gate changes, takeoff and landing (client flights without the chime)
  for (const a of flights.alerts(nowMs)) alerts.push({ ...a, sound: a.sound && !inQuietHours(a.at * 1000) });

  alerts.sort((a, b) => a.at - b.at);
  return alerts.slice(0, 30);
}

// The web dashboard: the TV dashboard in any browser on the home network.
const WEB_DIR = fileURLToPath(new URL('./web/', import.meta.url));
app.use('/web', express.static(WEB_DIR, { maxAge: '5m' }));
app.get('/', (req, res) => res.sendFile(path.join(WEB_DIR, 'index.html')));
// the TV page: Android TV, Fire TV, LG webOS, Samsung Tizen, or any browser on a TV
app.get('/tv', (req, res) => res.sendFile(path.join(WEB_DIR, 'tv.html')));

// music for the TVs (server 5.12, optional): the stream, AirPlay's cover picture, and play/pause/skip
app.get('/api/music/stream.mp3', homeOnly, (req, res) => music.stream(req, res));
app.get('/api/music/art', homeOnly, (req, res) => music.art(req, res));
// just what's playing, for TVs to start and stop the music quickly (polled every few seconds while music is on)
app.get('/api/music/now', (req, res) => res.set('Cache-Control', 'no-store').json(music.summary()));
app.post('/api/music/control', homeOnly, express.json({ limit: '2kb' }), async (req, res) => {
  try {
    await music.control(String(req.body?.action || ''));
    res.json({ ok: true });
  } catch (e) {
    res.status(409).json({ error: e.message });
  }
});
app.get('/manifest.webmanifest', (req, res) => res.type('application/manifest+json').sendFile(path.join(WEB_DIR, 'manifest.webmanifest')));

app.get('/api/dashboard', (req, res) => {
  try {
    const hostHeader = req.headers.host || `localhost:${PORT}`;
    // a TV says which one it is (?tv=...); it gets its own layout and lists
    const display = displays.seen(req.query, req.ip);
    const layout = display?.profile || TV_DEFAULT_LAYOUT;
    const zoom = Number(req.query.zoom || 15);
    expireTransportModes();

    if (req.query.toggleCal) {
      const targetId = String(req.query.toggleCal).toLowerCase();
      const curVal = filterState.enabledMap[targetId] !== undefined ? filterState.enabledMap[targetId] : true;
      filterState.enabledMap[targetId] = !curVal;
      saveFilterState();
    }

    if (req.query.selectOverviewMember) {
      filterState.overviewMember = String(req.query.selectOverviewMember).toLowerCase();
      saveFilterState();
    }

    if (req.query.selectWx) {
      filterState.selectedWxLoc = String(req.query.selectWx).toLowerCase();
      saveFilterState();
    }

    if (req.query.selectTransport) {
      filterState.selectedTransportMember = String(req.query.selectTransport).toLowerCase();
      saveFilterState();
    }

    if (req.query.toggleTransportMode) {
      const mId = String(req.query.toggleTransportMode).toLowerCase();
      const mCfg = MEMBERS.find(m => m.id === mId);
      if (mCfg && mCfg.hasBus) {
        filterState.transportModes[mId] = activeModeFor(mCfg) === 'BUS' ? 'CAR' : 'BUS';
      }
      saveFilterState();
      refreshTransportBackgroundCache();
    }

    // ?who= and ?wx= look at one person or city for this reply only, so the web
    // dashboard can browse without changing what the TV shows
    const peekWho = req.query.who ? String(req.query.who).toLowerCase() : '';
    const peekWx = req.query.wx ? String(req.query.wx).toLowerCase() : '';
    const overviewMem = peekWho || filterState.overviewMember || 'all';
    const peekLoc = peekWx ? WEATHER_LOCS.find(l => String(l.id).toLowerCase() === peekWx) : null;
    const wxLoc = peekLoc ? peekLoc.id : (filterState.selectedWxLoc || HOME_WX_ID);
    const calendarData = buildCalendarPayloadFromCache(cachedBountyData.users, overviewMem);
    const weatherData = attachRadarTileUrls(hostHeader, wxLoc);
    const homeWxData = attachRadarTileUrls(hostHeader, HOME_WX_ID);
    const now = new Date();

    let filteredChores = cachedBountyData.chores;
    if (overviewMem !== 'all') {
      filteredChores = cachedBountyData.chores.filter(c => {
        return !c.assignedTo || c.assignedMember === overviewMem || String(c.assignedTo).toLowerCase() === overviewMem;
      });
    }

    const transportMembersWithMaps = cachedTransportMembers.map(m0 => {
      // the mode can change between background refreshes, so read it fresh
      const mCfg = MEMBERS.find(x => x.id === m0.id);
      const m = mCfg ? { ...m0, activeMode: activeModeFor(mCfg) } : m0;
      const useBusCoords = m.hasBus && m.activeMode === 'BUS' && latestBusCoords.isActive;
      const targetLat = useBusCoords ? latestBusCoords.lat : m.primaryLat;
      const targetLon = useBusCoords ? latestBusCoords.lng : m.primaryLon;

      return {
        ...m,
        ...getBusMapTiles(targetLat, targetLon, zoom, hostHeader)
      };
    });

    let homeBusPayload;
    // The home screen shows the live bus whenever one is running and at least
    // one bus rider is taking it today.
    const busRiders = MEMBERS.filter(m => m.hasBus && activeModeFor(m) === 'BUS');

    if (latestBusCoords.isActive && busRiders.length > 0) {
      const mapGrid = getBusMapTiles(latestBusCoords.lat, latestBusCoords.lng, zoom, hostHeader);
      homeBusPayload = {
        ...latestBusCoords,
        riders: busRiders.map(m => m.name),
        ...mapGrid
      };
    } else if (cachedNextImminentEventTrip) {
      const trip = cachedNextImminentEventTrip;
      const mapGrid = getBusMapTiles(trip.lat, trip.lon, zoom, hostHeader);
      homeBusPayload = {
        lat: trip.lat,
        lng: trip.lon,
        status: `NEXT (${trip.memberName}): ${trip.eventTitle}`,
        eta: `${trip.driveMins}m drive (Leave ${trip.leaveBy})`,
        lastUpdated: trip.eventTime,
        ...mapGrid
      };
    } else {
      const activeMember = transportMembersWithMaps.find(m => m.id === filterState.selectedTransportMember) || transportMembersWithMaps[0];
      if (activeMember) {
        homeBusPayload = {
          lat: activeMember.primaryLat,
          lng: activeMember.primaryLon,
          status: `${activeMember.name}: ${activeMember.primaryName}`,
          eta: activeMember.nextEventTrip
            ? `${activeMember.primaryDriveMins}m | Next: ${activeMember.nextEventTrip.driveMins}m`
            : activeMember.primaryDriveLabel,
          lastUpdated: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          tiles: activeMember.tiles,
          ovPinX: activeMember.ovPinX,
          ovPinY: activeMember.ovPinY,
          bigPinX: activeMember.bigPinX,
          bigPinY: activeMember.bigPinY,
          zoom: activeMember.zoom
        };
      } else {
        homeBusPayload = {
          ...latestBusCoords,
          ...getBusMapTiles(latestBusCoords.lat, latestBusCoords.lng, zoom, hostHeader)
        };
      }
    }

    res.json({
      dashboardTitle: householdConfig.dashboardTitle || 'FAMILY DASHBOARD',
      serverVersion: SERVER_VERSION,
      serverTime: Math.floor(Date.now() / 1000),
      clockOnly: now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
      overviewMember: overviewMem,
      selectedWxLoc: wxLoc,
      homeWxLoc: HOME_WX_ID,
      weatherLocations: WEATHER_LOCS,
      currentTime: now.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }).toUpperCase() + '  |  ' + now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
      todayLabel: now.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }).toUpperCase(),
      weather: weatherData,
      homeWeather: homeWxData,
      chores: filteredChores,
      users: cachedBountyData.users,
      calendars: calendarData.calendars,
      bus: homeBusPayload,
      transport: {
        selectedMemberId: filterState.selectedTransportMember,
        members: transportMembersWithMaps
      },
      todayEvents: calendarData.todayEvents,
      todayTotal: calendarData.todayTotal,
      calendar: calendarData.list,
      calendarTotal: calendarData.listTotal,
      calendarViews: calendarData,
      home: homeAssistant.homeStrip(),
      display: display ? { id: display.id, name: display.name, profileId: display.profileId } : null,
      layout: { cards: layout.cards, sections: layout.sections, music: layout.music !== false },
      // music playing on the server's speaker (Spotify or AirPlay), for TVs to play along; null when off
      music: music.summary(),
      // flights on the calendar (server 5.13, optional): status, gates, where the plane is; null when off
      flights: flights.summary(),
      lists: buildLists({ ...liveData, profile: layout, isoOf: toNyIsoDate, dayName: (d) => nyWeekdayFmt.format(d) }),
      alerts: buildAlerts()
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// The TV's full-screen map: the live bus (or the next place someone is going)
// and home, zoomed so both fit. ?who= picks the person, ?zoom= a number or auto.
app.get('/api/map/full', (req, res) => {
  const hostHeader = req.headers.host || `localhost:${PORT}`;
  // a flight: both airports, the route, and the plane
  if (String(req.query.who || '').startsWith('flight:')) {
    const fm = flights.mapFor(String(req.query.who).slice(7));
    if (!fm || !fm.points.length) return res.status(404).json({ error: 'No map for that flight yet.' });
    const v = fm.view;
    const map = buildFullMap({
      points: fm.points, path: fm.path, minZoom: 2, zoom: req.query.zoom || 'auto', width: req.query.w, height: req.query.h,
      tileUrl: (z, x, y) => `http://${hostHeader}/api/tile?type=osm&z=${z}&x=${x}&y=${y}`
    });
    if (!map) return res.status(404).json({ error: 'No map for that flight yet.' });
    return res.json({
      ...map,
      title: `${v.code}${v.who ? `  ·  ${v.who}` : ''}`,
      status: v.status,
      detail: [`${v.from.code} → ${v.to.code}`, v.departs.time ? `${v.departs.label} ${v.departs.time}` : '', v.arrives.time ? `${v.arrives.label} ${v.arrives.time}` : ''].filter(Boolean).join('  ·  '),
      live: v.phase === 'air', updatedAt: Date.now()
    });
  }
  const who = String(req.query.who || filterState.selectedTransportMember || '').toLowerCase();
  const mem = cachedTransportMembers.find(m0 => m0.id === who) || null;
  const homePoint = (HOME_LAT || HOME_LON) ? { kind: 'home', label: 'Home', lat: HOME_LAT, lon: HOME_LON, color: '0xF8FAFCFF' } : null;
  const points = [];
  let title = '';
  let status = '';
  let detail = '';

  const riders = MEMBERS.filter(m0 => m0.hasBus && activeModeFor(m0) === 'BUS');
  const busForThem = latestBusCoords.isActive && (mem ? (mem.hasBus && activeModeFor(MEMBERS.find(m0 => m0.id === mem.id) || mem) === 'BUS') : riders.length > 0);
  if (busForThem) {
    points.push({ kind: 'bus', label: 'Bus', lat: latestBusCoords.lat, lon: latestBusCoords.lng, color: '0x22C55EFF' });
    title = `School bus${riders.length ? ` for ${riders.map(m0 => m0.name).join(' & ')}` : ''}`;
    status = latestBusCoords.distanceLabel || latestBusCoords.eta || 'On the road';
    detail = [latestBusCoords.status, latestBusCoords.lastUpdated ? `as of ${latestBusCoords.lastUpdated}` : ''].filter(Boolean).join('  ·  ');
  } else if (mem && mem.nextEventTrip && mem.nextEventTrip.lat) {
    const trip = mem.nextEventTrip;
    points.push({ kind: 'place', label: trip.eventTitle, lat: Number(trip.lat), lon: Number(trip.lon), color: mem.colorHex });
    title = `${mem.name}: ${trip.eventTitle}`;
    status = trip.driveLabel ? `${trip.driveLabel} drive` : '';
    detail = [trip.eventTime, trip.leaveBy ? `leave by ${trip.leaveBy}` : '', trip.location].filter(Boolean).join('  ·  ');
  } else if (mem && mem.primaryLat) {
    points.push({ kind: 'place', label: mem.primaryName, lat: Number(mem.primaryLat), lon: Number(mem.primaryLon), color: mem.colorHex });
    title = `${mem.name}: ${mem.primaryName}`;
    status = mem.primaryDriveLabel ? `${mem.primaryDriveLabel} drive` : '';
  } else {
    title = 'Home';
  }
  if (homePoint) points.push(homePoint);

  const map = buildFullMap({
    points,
    zoom: req.query.zoom || 'auto',
    // a browser sends its own size so the map fits instead of stretching; the Roku keeps 1920 x 1080
    width: req.query.w, height: req.query.h,
    tileUrl: (z, x, y) => `http://${hostHeader}/api/tile?type=osm&z=${z}&x=${x}&y=${y}`
  });
  if (!map) return res.status(404).json({ error: 'Home isn\'t set in household.json, so there\'s nothing to show yet.' });
  res.json({ ...map, title, status, detail, live: busForThem, updatedAt: Date.now() });
});

// ---- pairing, app settings and chores from the TV (server 5.0) ------------------------

const updater = createUpdater({ version: SERVER_VERSION, repo: UPDATE_REPO === 'off' ? '' : UPDATE_REPO, requestRestart });
// Each TV's own layout (tvs.json, shared with the app through Firebase)
const displays = createDisplays({ file: path.join(process.cwd(), 'tvs.json') });

// Home Assistant (optional, read-only): picked devices on the TV and alerts when they need someone
const homeAssistant = startHomeAssistant({ picksFile: path.join(process.cwd(), 'home-assistant.json') });


// Music (optional): Spotify and AirPlay to every TV
const music = createMusic({ file: path.join(process.cwd(), 'music.json'), dataDir: process.cwd() });
music.start();
const setupSections = setupExtras(app, {
  updater, dataDir: process.cwd(), requestRestart, aiState: () => aiStatus, homeAssistant, displays, music, flights,
  parents: () => liveData.users.filter(u => String(u.role || '').toUpperCase() === 'PARENT' && u.name).map(u => ({ id: u.id, name: u.name }))
});

setupPairing(app, {
  extras: setupSections,
  requestRestart,
  db,
  auth: firebaseAuth,
  rules: firebaseRules,
  householdId,
  projectId: firebaseProjectId,
  credential: firebaseCredential,
  appPackage: APP_PACKAGE,
  port: PORT,
  version: SERVER_VERSION,
  rulesSource: fs.readFileSync(new URL('./firestore.rules', import.meta.url), 'utf8')
});

function homeOnlyApi(req, res, next) {
  if (isHomeNetwork(req)) return next();
  res.status(403).json({ error: 'Only devices on the home network can do that.' });
}

// The Roku checks off a chore for a kid. Like a tap in the app, it waits for a
// parent's OK unless the family turned approvals off.
app.post('/api/chores/:id/done', homeOnlyApi, async (req, res) => {
  if (!db) return res.status(503).json({ error: 'Chores are off on this server.' });
  const who = String(req.body?.memberId || req.body?.userId || '').toLowerCase();
  const user = liveData.users.find(u => u.id.toLowerCase() === who && (u.role || 'CHILD') !== 'PARENT')
    || liveData.users.find(u => (u.role || 'CHILD') !== 'PARENT' && memberForUser(u.id, u.name)?.id === who);
  if (!user) return res.status(400).json({ error: 'Pick who did the chore.' });
  const root = db.collection('households').doc(householdId);
  const choreRef = root.collection('chores').doc(req.params.id);
  try {
    const result = await db.runTransaction(async (tx) => {
      const [choreSnap, homeSnap] = await Promise.all([tx.get(choreRef), tx.get(root)]);
      if (!choreSnap.exists) return { status: 404, error: 'That chore is gone.' };
      const c = choreSnap.data();
      if ((c.status || 'AVAILABLE') !== 'AVAILABLE') return { status: 409, error: 'Someone already did that one.' };
      if (c.assignedTo && c.assignedTo !== user.id) return { status: 409, error: 'That chore belongs to someone else.' };
      const now = Date.now();
      const needsOk = homeSnap.exists ? homeSnap.data().requireApproval !== false : true;
      if (needsOk) {
        tx.update(choreRef, { status: 'PENDING', completedBy: user.id, submittedAt: now });
        return { status: 200, state: 'waiting' };
      }
      const repeat = c.repeat || 'NONE';
      tx.update(choreRef, repeat === 'NONE'
        ? { status: 'COMPLETED', completedBy: user.id, lastCompletedAt: now, lastCompletedBy: user.id }
        : { status: 'AVAILABLE', completedBy: null, submittedAt: null, lastCompletedAt: now, lastCompletedBy: user.id });
      tx.set(root.collection('ledger').doc(), {
        memberId: user.id, kind: 'EARN', rewardType: c.rewardType || 'TIME', amount: Number(c.amount) || 0,
        note: c.title || 'Chore', choreId: req.params.id, createdAt: now, createdBy: 'tv'
      });
      return { status: 200, state: 'earned' };
    });
    if (result.status !== 200) return res.status(result.status).json({ error: result.error });
    res.json({ ok: true, state: result.state, name: user.name || user.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Check off a to-do or a grocery from a TV (server 5.13), and undo it right after.
// A private to-do can only be checked off on a TV whose layout shows it.
app.post('/api/lists/:kind/:id/:action', homeOnlyApi, async (req, res) => {
  const { kind, id, action } = req.params;
  if (!['todos', 'groceries'].includes(kind) || !['done', 'undo'].includes(action)) return res.status(404).json({ error: 'Not a list.' });
  if (!db) return res.status(503).json({ error: 'Lists are off on this server.' });
  const ref = db.collection('households').doc(householdId).collection(kind).doc(id);
  try {
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: 'That one is gone.' });
    const item = snap.data();
    if (kind === 'todos' && item.private) {
      const display = displays.seen({ tv: req.body?.tv || req.query.tv }, req.ip);
      const allowed = new Set(display?.profile?.privateTodosOf || []);
      if (!allowed.has(item.ownerId)) return res.status(403).json({ error: 'That to-do is private.' });
    }
    const done = action === 'done';
    await ref.update(done ? { done: true, doneAt: Date.now(), doneBy: 'tv' } : { done: false, doneAt: null, doneBy: null });
    // the TV's next refresh shows it right away
    const list = liveData[kind];
    const local = Array.isArray(list) ? list.find(x => x.id === id) : null;
    if (local) Object.assign(local, done ? { done: true, doneAt: Date.now() } : { done: false, doneAt: null });
    res.json({ ok: true, done, title: String(item.title || item.name || '') });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Version 1 of the app kept earned rewards only on completed chores. Copy
// those into the rewards history once, so nobody's balance drops.
async function migrateV1Rewards(root) {
  const home = (await root.get()).data() || {};
  if (home.ledgerMigrated !== false) return;
  const [chores, ledger] = await Promise.all([root.collection('chores').get(), root.collection('ledger').get()]);
  const recorded = new Set(ledger.docs.map(d => d.data().choreId).filter(Boolean));
  const batch = db.batch();
  let count = 0;
  for (const d of chores.docs) {
    const c = d.data();
    if (c.status !== 'COMPLETED' || !c.completedBy || recorded.has(d.id)) continue;
    batch.set(root.collection('ledger').doc(`v1-${d.id}`), {
      memberId: c.completedBy, kind: 'EARN', rewardType: c.rewardType || 'TIME', amount: Number(c.amount) || 0,
      note: c.title || 'Chore', choreId: d.id, createdAt: Number(c.lastCompletedAt) || Date.now(), createdBy: 'v1'
    });
    count++;
  }
  batch.update(root, { ledgerMigrated: true });
  await batch.commit();
  if (count) console.log(`[Chores] Moved ${count} earned rewards from version 1 into the rewards history.`);
}

async function startFamilyCloud() {
  if (!db) return;
  try {
    const root = db.collection('households').doc(householdId);
    const snap = await root.get();
    if (!snap.exists) {
      const title = String(householdConfig.dashboardTitle || '').replace(/dashboard/i, '').trim();
      const name = title ? title.toLowerCase().replace(/\b\w/g, ch => ch.toUpperCase()) : 'Our Family';
      // ledgerMigrated false lets the app copy rewards from version 1 chores
      await root.set({ name, requireApproval: true, ledgerMigrated: false, createdAt: Date.now() });
    }
    await migrateV1Rewards(root);
    await startCloudConfig({
      db,
      householdId,
      householdFile: HOUSEHOLD_CONFIG_FILE,
      configFile: './config.txt',
      localHousehold: rawHousehold || {},
      serverVersion: SERVER_VERSION,
      requestRestart
    });
    startHealthReports(root);
    startAgendaSync(root);
    startTidy(root);
    displays.attachCloud(root);
    const fakeAI = process.env.FD_FAKE_AI ? (await import('./test/fake-ai.mjs')).fakeAsk : undefined;
    aiStatus = startAI({ root, context: (req) => aiContext(root, req), ...(fakeAI ? { ask: fakeAI, settings: { configured: true, provider: 'gemini', providerName: 'Test AI', model: 'fake', key: 'x' } } : {}) });
  } catch (e) {
    console.error(`[Firebase] ${e.message}`);
  }
}

// What an AI prompt may know about the family: first names, what the kids
// eat and like (as entered in the app), and the grocery list. Nothing else.
let aiStatus = { configured: aiSettings().configured, providerName: aiSettings().providerName };
async function aiContext(root, req) {
  const isParent = (u) => String(u.role || 'CHILD').toUpperCase() === 'PARENT';
  const kids = liveData.users.filter(u => !isParent(u) && u.name).map(u => ({ name: u.name, safeFoods: u.safeFoods || '', interests: u.interests || '' }));
  const parents = liveData.users.filter(u => isParent(u) && u.name).map(u => u.name);
  const me = liveData.users.find(u => u.id === req.createdBy)?.name || '';
  const groceries = { toBuy: [], recent: [] };
  try {
    const snap = await root.collection('groceries').get();
    const weekAgo = Date.now() - 7 * 86400000;
    for (const d of snap.docs) {
      const g = d.data() || {};
      if (!g.name) continue;
      if (!g.done) groceries.toBuy.push(g.name);
      else if ((g.doneAt || 0) > weekAgo) groceries.recent.push(g.name);
    }
  } catch (e) { /* the list is optional */ }
  // staples the family always keeps on hand
  const pantry = [];
  try {
    const snap = await root.collection('pantry').get();
    for (const d of snap.docs) { const n = String(d.data()?.name || '').trim(); if (n) pantry.push(n); }
  } catch (e) { /* optional too */ }
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const weekday = now.toLocaleDateString('en-US', { weekday: 'long' });
  // dinners already planned, so ideas don't repeat them
  const planned = liveData.meals.filter(m => m.name && String(m.date || '') >= today).map(m => `${m.date}: ${m.name}`).slice(0, 14);
  // food allergies for everyone, kids and adults: never in a suggestion
  const allergies = liveData.users.filter(u => u.name && String(u.allergies || '').trim())
    .map(u => ({ name: u.name, items: String(u.allergies).split(',').map(x => x.trim()).filter(Boolean).slice(0, 20) }))
    .filter(a => a.items.length);
  return { kids, parents, me, groceries: { ...groceries, pantry }, planned, allergies, today, weekday };
}

// Every few minutes, tell the app how the server is doing: running, calendar
// loaded, bus tracker connected, update waiting. A missed report means the
// computer is off or asleep.
function healthReport() {
  const busProblem = !busHealth.configured ? null
    : busHealth.credential === 'failed' ? 'the AlphaPortal sign-in stopped working'
    : !busHealth.connected ? (busHealth.hint || busHealth.lastError || 'not connected')
    : null;
  return {
    version: SERVER_VERSION,
    seenAt: Date.now(),
    calendar: {
      ok: calendarHealth.configured ? calendarHealth.ok : null,
      events: calendarHealth.events,
      loadedAt: calendarHealth.loadedAt,
      error: calendarHealth.error
    },
    bus: { configured: busHealth.configured, ok: busHealth.configured ? !busProblem : null, problem: busProblem },
    update: { available: updater.available() ? updater.status.latest.version : null },
    ai: { configured: Boolean(aiStatus.configured), provider: aiStatus.providerName || null, problem: aiStatus.lastError || null },
    homeAssistant: { configured: homeAssistant.status.configured, connected: homeAssistant.status.connected, problem: homeAssistant.status.problem }
  };
}

// The family schedule for the next 7 days, for the app (it can't reach this
// server away from home, but it can read Firebase). Written only when it changes.
function buildAgenda() {
  const cal = buildCalendarPayloadFromCache(cachedBountyData.users, 'all');
  const slim = (e) => ({
    title: e.title,
    time: e.isAllDay ? null : e.timeLabel,
    startMs: e.startMs,
    endMs: e.endMs || null,
    who: e.calendarName || '',
    color: e.colorHex || '',
    location: e.location || '',
    kind: e.kind || null
  });
  const days = [];
  const add = (iso, label, ev) => {
    let d = days.find(x => x.iso === iso);
    if (!d) { d = { iso, label, events: [] }; days.push(d); }
    if (d.events.length < 20) d.events.push(slim(ev));
  };
  for (const e of cal.todayEvents) add(e.isoDate, 'Today', e);
  for (const e of cal.list) {
    if (days.length >= 7 && !days.some(d => d.iso === e.isoDate)) break;
    add(e.isoDate, e.dateLabel || e.shortDate || e.isoDate, e);
  }
  return days;
}

function startTidy(root) {
  const run = async () => {
    try {
      const n = await tidyOldData(root);
      if (n) console.log(`[Tidy] Cleared ${n} old meal${n === 1 ? '' : 's'} and grocery items.`);
    } catch (e) { console.log(`[Tidy] ${e.message}`); }
  };
  setTimeout(run, 2 * 60000);
  setInterval(run, 6 * 3600000).unref?.();
}

function startAgendaSync(root) {
  const ref = root.collection('config').doc('agenda');
  let last = '';
  const sync = async () => {
    try {
      const days = buildAgenda();
      const text = JSON.stringify(days);
      if (text === last) return;
      await ref.set({ days, updatedAt: Date.now() });
      last = text;
    } catch (e) {
      console.error(`[Agenda] Couldn't share the schedule with the app: ${e.message}`);
    }
  };
  setTimeout(sync, 30000);
  setInterval(sync, 2 * 60 * 1000).unref?.();
}

function startHealthReports(root) {
  const ref = root.collection('config').doc('dashboard');
  const send = () => ref.set({ server: healthReport() }, { merge: true })
    .catch(e => console.error(`[Health] Couldn't report to the app: ${e.message}`));
  setTimeout(send, 45000);              // after the calendar and bus have had a chance to load
  setInterval(send, 5 * 60 * 1000).unref?.();
}
startFamilyCloud();
updater.start();
startDiscovery({ port: PORT, householdId: () => householdId, version: () => SERVER_VERSION, log: console.log });

const httpServer = app.listen(PORT, '0.0.0.0', () => {
  console.log(`${householdConfig.dashboardTitle || 'Family Dashboard'} server v${SERVER_VERSION} running on port ${PORT}`);
  console.log(`[Setup] Pair phones and check Firebase at ${lanAddress(PORT)}/setup`);
  console.log(`[Config] People: ${MEMBERS.map(m => m.name).join(', ') || 'none - add members to household.json'}`);
  console.log(`[Config] Weather places: ${WEATHER_LOCS.map(l => l.name || l.id).join(', ')}`);
  const missing = [];
  if (!process.env.CALENDAR_ICAL_URL) missing.push('CALENDAR_ICAL_URL (family calendar)');
  if (MEMBERS.some(m => m.sourceType === 'work') && !process.env.WORK_ICAL_URL) missing.push('WORK_ICAL_URL (work calendar)');
  if (!process.env.OPENWEATHER_KEY) missing.push('OPENWEATHER_KEY (current conditions)');
  if (MEMBERS.some(m => m.hasBus) && !process.env.ALPHAPORTAL_REFRESH_TOKEN) missing.push('ALPHAPORTAL_REFRESH_TOKEN (live bus)');
  if (MEMBERS.some(m => m.hasBus)) console.log(`[AlphaPortal] Bus tracker health: http://localhost:${PORT}/api/bus/status`);
  if (!HOME_LAT || !HOME_LON) missing.push('home.lat / home.lon in household.json');
  if (missing.length) console.log(`[Config] Not set in config.txt, so these parts stay empty: ${missing.join('; ')}`);
});
httpServer.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[Server] Port ${PORT} is already in use. Another copy of the server is probably running (an old Terminal window with npm start?). Close it and this one starts by itself.`);
  } else {
    console.error(`[Server] Couldn't start: ${err.message}`);
  }
  process.exit(1);
});
