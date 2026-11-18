// Starts server.js and keeps it running.
//
// The server asks for a restart (exit code 75) after the family's settings
// change in the app, or after it installed an update. If the server crashes,
// it is started again after a short pause.
//
// Installed by the Mac installer (FD_HOME is set), it also:
//   - runs the version named in FD_HOME/current.json
//   - goes back to the previous version if a new one keeps failing to start
//   - writes the log to <data folder>/logs/server.log, keeping it small
// Self-contained on purpose: this file outlives the versions it starts.
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const RESTART = 75;
const HEALTHY_AFTER_MS = Number(process.env.FD_HEALTHY_MS) || 120000;
const here = path.dirname(fileURLToPath(import.meta.url));
const home = process.env.FD_HOME || '';
const installed = Boolean(home && fs.existsSync(path.join(home, 'versions')));
const dataDir = process.env.FD_DATA || (installed ? path.join(home, 'Settings') : here);

let child = null;
let stopping = false;
let quickCrashes = 0;
let healthyTimer = null;

// ---- log file (installed only; a terminal run prints as before) ----------------------
const logDir = path.join(dataDir, 'logs');
const logFile = path.join(logDir, 'server.log');
const LOG_MAX = 2 * 1024 * 1024;
function writeLog(chunk) {
  process.stdout.write(chunk);
  if (!installed) return;
  try {
    fs.mkdirSync(logDir, { recursive: true });
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > LOG_MAX) {
      fs.rmSync(`${logFile}.2`, { force: true });
      if (fs.existsSync(`${logFile}.1`)) fs.renameSync(`${logFile}.1`, `${logFile}.2`);
      fs.renameSync(logFile, `${logFile}.1`);
    }
    fs.appendFileSync(logFile, chunk);
  } catch (e) {}
}
const say = (msg) => writeLog(`${new Date().toISOString().slice(0, 19).replace('T', ' ')} [Launcher] ${msg}\n`);

// ---- which version to run ---------------------------------------------------------
function readState() {
  try { return JSON.parse(fs.readFileSync(path.join(home, 'current.json'), 'utf8')); } catch (e) { return {}; }
}
function writeState(state) {
  const file = path.join(home, 'current.json');
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 2) + '\n');
  fs.renameSync(`${file}.tmp`, file);
}
const versionDir = (v) => path.join(home, 'versions', String(v || ''));
const hasVersion = (v) => Boolean(v) && fs.existsSync(path.join(versionDir(v), 'server.js'));
function newestVersion() {
  const list = fs.readdirSync(path.join(home, 'versions')).filter(hasVersion);
  const key = (v) => v.split('.').map(n => String(parseInt(n, 10) || 0).padStart(6, '0')).join('.');
  return list.sort((a, b) => (key(a) < key(b) ? 1 : -1))[0] || '';
}

function pickServer() {
  if (!installed) return { file: path.join(here, 'server.js'), state: null };
  let state = readState();
  if (!hasVersion(state.version)) {
    const v = newestVersion();
    if (!v) throw new Error(`No server version found in ${path.join(home, 'versions')}. Run the installer again.`);
    state = { ...state, version: v, pending: false };
    writeState(state);
  }
  return { file: path.join(versionDir(state.version), 'server.js'), state };
}

// A new version that keeps failing goes back to the one before it.
function rollBack(state) {
  const bad = state.version;
  const prev = hasVersion(state.previous) ? state.previous : '';
  if (!prev) return false;
  writeState({
    ...state,
    version: prev,
    previous: '',
    pending: false,
    startedTries: 0,
    bad: [...new Set([...(state.bad || []), bad])],
    message: `Version ${bad} didn't start, so the server went back to ${prev}. The log has the details.`
  });
  say(`Version ${bad} failed to start. Went back to ${prev}.`);
  return true;
}

function markHealthy() {
  const state = readState();
  if (!state.pending) return;
  const v = state.version;
  writeState({ ...state, pending: false, startedTries: 0, message: `Updated to ${v}.` });
  say(`Version ${v} is running fine.`);
  // keep only this version and the one before it
  for (const d of fs.readdirSync(path.join(home, 'versions'))) {
    if (d !== v && d !== state.previous) fs.rmSync(versionDir(d), { recursive: true, force: true });
  }
  // newer launcher? it takes over the next time the computer starts the server
  try {
    const fresh = path.join(versionDir(v), 'launcher.js');
    const mine = path.join(home, 'launcher.js');
    if (fs.existsSync(fresh) && fs.readFileSync(fresh, 'utf8') !== fs.readFileSync(mine, 'utf8')) fs.copyFileSync(fresh, mine);
  } catch (e) {}
}

function start() {
  let pick;
  try {
    pick = pickServer();
  } catch (e) {
    say(e.message);
    return setTimeout(start, 60000);
  }
  const startedAt = Date.now();
  if (installed) {
    fs.mkdirSync(dataDir, { recursive: true });
    say(`Starting server ${pick.state.version}${pick.state.pending ? ' (new)' : ''}.`);
  }
  child = spawn(process.execPath, [pick.file], {
    stdio: installed ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    cwd: dataDir,
    env: { ...process.env, FD_LAUNCHER: '1', FD_DATA: dataDir }
  });
  if (installed) {
    child.stdout.on('data', writeLog);
    child.stderr.on('data', writeLog);
    clearTimeout(healthyTimer);
    if (pick.state.pending) healthyTimer = setTimeout(markHealthy, HEALTHY_AFTER_MS);
  }
  child.on('exit', (code, signal) => {
    child = null;
    clearTimeout(healthyTimer);
    if (stopping) return process.exit(0);
    if (code === RESTART) {
      say('Restart requested by the server.');
      quickCrashes = 0;
      return start();
    }
    if (code === 0 && !signal && !installed) return process.exit(0);

    const quick = Date.now() - startedAt < 30000;
    if (installed && quick && pick.state.pending) {
      const state = readState();
      const tries = (state.startedTries || 0) + 1;
      if (tries >= 2 && rollBack(state)) return setTimeout(start, 1000);
      writeState({ ...state, startedTries: tries });
    }
    quickCrashes = quick ? quickCrashes + 1 : 0;
    if (!installed && quickCrashes >= 5) {
      console.error('[Launcher] The server keeps stopping right after it starts. Fix the error above, then run npm start again.');
      return process.exit(1);
    }
    // installed: never give up, but wait longer between tries (up to 5 minutes)
    const wait = Math.min(installed ? 300 : 30, 2 ** quickCrashes);
    say(`The server stopped (${signal || `code ${code}`}). Starting it again in ${wait} s.`);
    setTimeout(start, wait * 1000);
  });
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    stopping = true;
    if (child) child.kill(sig); else process.exit(0);
  });
}

start();
