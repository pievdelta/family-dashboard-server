// Keeps the dashboard settings in step with the family's Firebase, so the app
// can change them from anywhere.
//
//   households/{id}/config/dashboard    the contents of household.json, plus
//                                       which secrets are set (never their values)
//   households/{id}/private/secretsInbox the app drops new keys and calendar links
//                                       here; the server moves them into config.txt
//                                       and deletes the document right away
//
// Whoever changed last wins: an edit to household.json on this computer is
// pushed up, and an edit made in the app is written down here. Either way the
// server restarts itself to use the new settings.
import fs from 'fs';
import crypto from 'crypto';

// Settings the app may set. Everything else in config.txt stays local.
export const APP_SECRET_KEYS = ['CALENDAR_ICAL_URL', 'WORK_ICAL_URL', 'OPENWEATHER_KEY', 'ALPHAPORTAL_REFRESH_TOKEN'];

const STATE_FILE = './.cloud-sync.json';

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export function hashOf(obj) {
  return crypto.createHash('sha256').update(canonical(obj)).digest('hex').slice(0, 16);
}

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) { return {}; }
}
function writeState(state) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); } catch (e) {}
}

/** Replaces or adds KEY=value lines in config.txt, keeping comments and other lines. */
export function updateConfigFile(file, changes) {
  let lines = [];
  try { lines = fs.readFileSync(file, 'utf8').split(/\r?\n/); } catch (e) {}
  const done = new Set();
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  lines = lines.map(line => {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=/);
    if (m && Object.prototype.hasOwnProperty.call(changes, m[1])) {
      done.add(m[1]);
      return `${m[1]}=${changes[m[1]]}`;
    }
    return line;
  });
  for (const [key, value] of Object.entries(changes)) {
    if (!done.has(key)) lines.push(`${key}=${value}`);
  }
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
}

export function secretsSetNow() {
  const out = {};
  for (const k of APP_SECRET_KEYS) out[k] = Boolean(String(process.env[k] || '').trim());
  return out;
}

/**
 * Starts syncing. `requestRestart` is called after a change has been written
 * to disk. Returns a small status object for the setup page.
 */
export async function startCloudConfig({ db, householdId, householdFile, configFile, localHousehold, serverVersion, requestRestart, log = console.log }) {
  const root = db.collection('households').doc(householdId);
  const configRef = root.collection('config').doc('dashboard');
  const inboxRef = root.collection('private').doc('secretsInbox');
  const status = { syncing: false, lastError: null };

  const state = readState();
  const localHash = hashOf(localHousehold);

  const writeLocal = (household, hash) => {
    fs.writeFileSync(householdFile, JSON.stringify(household, null, 2) + '\n', 'utf8');
    writeState({ ...readState(), syncedHash: hash });
  };

  const publish = async (household) => {
    const hash = hashOf(household);
    await configRef.set({
      household,
      hash,
      updatedAt: Date.now(),
      updatedBy: 'server',
      secretsSet: secretsSetNow(),
      server: { version: serverVersion, startedAt: Date.now() }
    }, { merge: false });
    writeState({ ...readState(), syncedHash: hash });
  };

  // 1. decide who wins at startup
  const snap = await configRef.get();
  const cloud = snap.exists ? snap.data() : null;
  const cloudHash = cloud && cloud.household ? hashOf(cloud.household) : null;
  if (!cloudHash) {
    await publish(localHousehold);
    log('[Settings] Saved this server\'s settings to Firebase so the app can show and change them.');
  } else if (cloudHash === localHash) {
    writeState({ ...state, syncedHash: localHash });
    await configRef.set({ secretsSet: secretsSetNow(), server: { version: serverVersion, startedAt: Date.now() } }, { merge: true });
  } else if (state.syncedHash && localHash !== state.syncedHash) {
    // household.json was edited here since the last sync
    await publish(localHousehold);
    log('[Settings] household.json changed on this computer. Sent the new settings to Firebase.');
  } else {
    writeLocal(cloud.household, cloudHash);
    log('[Settings] The app changed the settings. Applying them now.');
    return requestRestart();
  }

  // 2. follow changes made in the app
  status.syncing = true;
  configRef.onSnapshot((doc) => {
    if (!doc.exists) return;
    const data = doc.data();
    if (!data.household || data.updatedBy === 'server') return;
    const hash = hashOf(data.household);
    if (hash === readState().syncedHash) return;
    try {
      writeLocal(data.household, hash);
      log(`[Settings] ${data.updatedByName || 'The app'} changed the settings. Restarting to apply them.`);
      requestRestart();
    } catch (e) {
      status.lastError = e.message;
      log(`[Settings] Could not save the new settings: ${e.message}`);
    }
  }, (err) => { status.syncing = false; status.lastError = err.message; log(`[Settings] Stopped following changes: ${err.message}`); });

  // 3. new keys and links from the app
  inboxRef.onSnapshot(async (doc) => {
    if (!doc.exists) return;
    const data = doc.data() || {};
    const changes = {};
    for (const key of APP_SECRET_KEYS) {
      if (typeof data[key] === 'string') changes[key] = data[key].replace(/[\r\n]/g, '').trim();
    }
    try {
      await inboxRef.delete();
      if (Object.keys(changes).length === 0) return;
      updateConfigFile(configFile, changes);
      for (const [k, v] of Object.entries(changes)) process.env[k] = v;
      await configRef.set({ secretsSet: secretsSetNow() }, { merge: true });
      log(`[Settings] Updated ${Object.keys(changes).join(', ')} from the app. Restarting to apply.`);
      requestRestart();
    } catch (e) {
      status.lastError = e.message;
      log(`[Settings] Could not apply new keys from the app: ${e.message}`);
    }
  }, (err) => { status.lastError = err.message; });

  return status;
}
