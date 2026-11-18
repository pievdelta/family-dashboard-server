// One-click updates from GitHub releases.
//
// Only an installed server updates itself: the Mac installer starts the
// server with FD_HOME pointing at its folder, which holds
//
//   launcher.js          keeps the server running and rolls back a bad update
//   current.json         { version, previous, pending, bad: [] }
//   versions/<version>/  the server code for each version kept
//   downloads/           a release while it is being checked
//
// The family's settings live in a separate data folder (the server's working
// folder), so an update never touches config.txt, household.json or keys.
//
// A copy run from a git clone or a zip with `npm start` only says when a new
// version is out.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { spawnSync } from 'child_process';

const DAY = 24 * 60 * 60 * 1000;
const ASSET = /^family-dashboard-server-(\d+\.\d+\.\d+)\.tar\.gz$/;

/** "5.10.0" > "5.9.2" */
export function newer(a, b) {
  const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

/** "a1b2...  family-dashboard-server-5.2.0.tar.gz" lines -> { name: hash } */
export function parseSums(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/i);
    if (m) out[m[2].trim()] = m[1].toLowerCase();
  }
  return out;
}

export function readState(home) {
  try { return JSON.parse(fs.readFileSync(path.join(home, 'current.json'), 'utf8')); } catch (e) { return {}; }
}

export function writeState(home, state) {
  const file = path.join(home, 'current.json');
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 2) + '\n');
  fs.renameSync(`${file}.tmp`, file);
}

export function createUpdater({ version, repo, home = process.env.FD_HOME, api = process.env.FD_UPDATE_API || 'https://api.github.com', requestRestart, log = console.log }) {
  const enabled = Boolean(repo && /^[\w.-]+\/[\w.-]+$/.test(repo) && !/^OWNER\//.test(repo));
  const managed = Boolean(home && fs.existsSync(path.join(home, 'versions')));
  const status = {
    current: version,
    repo: enabled ? repo : null,
    managed,
    checkedAt: 0,
    latest: null,          // { version, notes, url, publishedAt }
    error: null,
    installing: false,
    step: '',
  };

  // the launcher leaves a note after an update settles or is rolled back;
  // it is shown on the setup page once
  function takeMessage() {
    if (!managed) return null;
    const st = readState(home);
    if (!st.message || st.pending) return null;
    const msg = st.message;
    delete st.message;
    try { writeState(home, st); } catch (e) {}
    return msg;
  }

  let retryTimer = null;

  async function getJson(url) {
    const res = await fetch(url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': `FamilyDashboard/${version}` } });
    if (!res.ok) throw new Error(res.status === 403 || res.status === 429 ? 'GitHub is limiting requests from this network right now' : `GitHub said ${res.status}`);
    return res.json();
  }

  async function check() {
    if (!enabled) return status;
    try {
      const rel = await getJson(`${api}/repos/${repo}/releases/latest`);
      const asset = (rel.assets || []).find(a => ASSET.test(a.name));
      const sums = (rel.assets || []).find(a => a.name === 'SHA256SUMS');
      const v = String(rel.tag_name || '').replace(/^v/, '');
      const bad = managed ? (readState(home).bad || []) : [];
      status.latest = asset && sums && !bad.includes(v) ? {
        version: v,
        notes: String(rel.body || '').slice(0, 4000),
        url: rel.html_url,
        publishedAt: rel.published_at,
        asset: asset.browser_download_url,
        assetName: asset.name,
        sums: sums.browser_download_url
      } : null;
      status.error = null;
      if (status.latest && newer(v, version)) log(`[Update] Version ${v} is available. Open the setup page to install it.`);
    } catch (e) {
      status.error = `Couldn't check for updates: ${e.message}. Trying again in an hour.`;
      // GitHub limits checks without an account to 60 an hour per home address
      clearTimeout(retryTimer);
      retryTimer = setTimeout(check, 60 * 60 * 1000);
      retryTimer.unref?.();
    }
    status.checkedAt = Date.now();
    return status;
  }

  function available() {
    return Boolean(status.latest && newer(status.latest.version, version));
  }

  async function download(url, file) {
    const res = await fetch(url, { headers: { 'User-Agent': `FamilyDashboard/${version}` } });
    if (!res.ok) throw new Error(`download failed (${res.status})`);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(file, buf);
    return buf;
  }

  async function install() {
    if (!managed) throw new Error('This copy was started by hand, so it can\'t update itself. Download the new version from GitHub.');
    if (!available()) throw new Error('There is no newer version to install.');
    if (status.installing) throw new Error('An update is already being installed.');
    const rel = status.latest;
    status.installing = true;
    const dl = path.join(home, 'downloads');
    const target = path.join(home, 'versions', rel.version);
    const temp = `${target}.partial`;
    try {
      fs.mkdirSync(dl, { recursive: true });
      status.step = 'Downloading';
      const sums = parseSums((await download(rel.sums, path.join(dl, 'SHA256SUMS'))).toString('utf8'));
      const tgz = path.join(dl, rel.assetName);
      const buf = await download(rel.asset, tgz);
      status.step = 'Checking the download';
      const hash = crypto.createHash('sha256').update(buf).digest('hex');
      if (!sums[rel.assetName] || sums[rel.assetName] !== hash) throw new Error('the download didn\'t match its checksum, so it was not installed');

      status.step = 'Unpacking';
      fs.rmSync(temp, { recursive: true, force: true });
      fs.mkdirSync(temp, { recursive: true });
      const tar = spawnSync('tar', ['-xzf', tgz, '-C', temp], { encoding: 'utf8' });
      if (tar.status !== 0) throw new Error(`couldn't unpack it: ${(tar.stderr || '').trim() || tar.error?.message}`);
      // the archive holds one folder, or the files themselves
      let root = temp;
      const inside = fs.readdirSync(temp);
      if (inside.length === 1 && fs.statSync(path.join(temp, inside[0])).isDirectory()) root = path.join(temp, inside[0]);
      const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
      if (pkg.version !== rel.version) throw new Error(`the download says it is ${pkg.version}, not ${rel.version}`);
      if (!fs.existsSync(path.join(root, 'server.js')) || !fs.existsSync(path.join(root, 'node_modules'))) throw new Error('the download is missing files');
      const need = String(pkg.engines?.node || '').match(/(\d+)/);
      if (need && Number(need[1]) > Number(process.versions.node.split('.')[0])) {
        throw new Error(`version ${rel.version} needs a newer Node than this installer has. Download the new installer from GitHub instead.`);
      }
      fs.rmSync(target, { recursive: true, force: true });
      fs.renameSync(root, target);
      fs.rmSync(temp, { recursive: true, force: true });
      fs.rmSync(tgz, { force: true });

      status.step = 'Restarting';
      const st = readState(home);
      writeState(home, { ...st, version: rel.version, previous: st.version || version, pending: true, startedTries: 0 });
      log(`[Update] Installed ${rel.version}. Restarting into it.`);
      setTimeout(() => requestRestart(), 500);
      return rel.version;
    } catch (e) {
      fs.rmSync(temp, { recursive: true, force: true });
      status.installing = false;
      status.step = '';
      throw e;
    }
  }

  function start() {
    if (!enabled) return;
    setTimeout(check, 15000);
    setInterval(check, DAY).unref?.();
  }

  return { status, check, install, available, start, takeMessage, enabled, managed };
}
