// Setup page and device pairing.
//
// A phone or tablet pairs once, on the home network: it sends the six-digit
// code shown on the setup page (or scans its QR code) and gets back the
// family's Firebase connection details plus a sign-in made just for it. After
// that it talks to Firebase directly and works from anywhere.
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import QRCode from 'qrcode';
import express from 'express';

const APP_CONFIG_FILE = './firebase-app.json';
const CODE_LIFETIME_MS = 10 * 60 * 1000;

// ---- who may use these pages ---------------------------------------------------

export function isHomeNetwork(req) {
  let ip = String(req.socket?.remoteAddress || '');
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  if (ip === '::1' || ip.startsWith('127.')) return true;
  if (ip.startsWith('10.') || ip.startsWith('192.168.')) return true;
  const m = ip.match(/^172\.(\d+)\./);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  if (/^(fe80|fc|fd)/i.test(ip)) return true;
  return false;
}

export function homeOnly(req, res, next) {
  if (isHomeNetwork(req)) return next();
  res.status(403).send('The setup page only opens on your home network.');
}

export function lanAddress(port) {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) {
        return `http://${a.address}:${port}`;
      }
    }
  }
  return `http://localhost:${port}`;
}

// ---- the app's Firebase connection details ------------------------------------------

/** Reads the Android entry from a google-services.json file. */
export function parseGoogleServices(text, appPackage) {
  const gs = typeof text === 'string' ? JSON.parse(text) : text;
  const clients = gs.client || [];
  const client = clients.find(c => c.client_info?.android_client_info?.package_name === appPackage) || clients[0];
  if (!client) throw new Error('That file has no Android app in it.');
  const pkg = client.client_info?.android_client_info?.package_name;
  return {
    apiKey: client.api_key?.[0]?.current_key,
    applicationId: client.client_info?.mobilesdk_app_id,
    projectId: gs.project_info?.project_id,
    storageBucket: gs.project_info?.storage_bucket || null,
    gcmSenderId: gs.project_info?.project_number || null,
    packageName: pkg || null
  };
}

function loadAppConfig() {
  try { return JSON.parse(fs.readFileSync(APP_CONFIG_FILE, 'utf8')); } catch (e) { return null; }
}
function saveAppConfig(cfg) {
  fs.writeFileSync(APP_CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
}

/**
 * Asks Firebase for the Android app's details, registering the app first if
 * the project doesn't have it yet. Works when the Admin key is allowed to
 * manage the project, which it usually is; otherwise the setup page asks for
 * the google-services.json file instead.
 */
async function fetchAppConfig({ credential, projectId, appPackage }) {
  const { access_token: token } = await credential.getAccessToken();
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const base = `https://firebase.googleapis.com/v1beta1/projects/${projectId}`;
  const call = async (url, opts = {}) => {
    const r = await fetch(url, { headers, ...opts });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error?.message || `HTTP ${r.status}`);
    return body;
  };

  let apps = (await call(`${base}/androidApps?pageSize=100`)).apps || [];
  let mine = apps.find(a => a.packageName === appPackage);
  if (!mine) {
    let op = await call(`${base}/androidApps`, { method: 'POST', body: JSON.stringify({ packageName: appPackage, displayName: 'Family Dashboard' }) });
    for (let i = 0; i < 20 && !op.done; i++) {
      await new Promise(r => setTimeout(r, 1500));
      op = await call(`https://firebase.googleapis.com/v1beta1/${op.name}`);
    }
    if (op.error) throw new Error(op.error.message);
    mine = op.response;
  }
  const cfg = await call(`${base}/androidApps/${mine.appId}/config`);
  const text = Buffer.from(cfg.configFileContents, 'base64').toString('utf8');
  return parseGoogleServices(text, appPackage);
}

// ---- routes ----------------------------------------------------------------------------

export function setupPairing(app, ctx) {
  const {
    db, auth, rules, householdId, projectId, credential,
    appPackage, port, version, log = console.log, rulesSource
  } = ctx;
  const devicesRef = db ? db.collection('households').doc(householdId).collection('devices') : null;

  const state = {
    appConfig: loadAppConfig(),
    appConfigError: null,
    authOk: null,
    authError: null,
    rulesOk: null,
    rulesError: null,
    pairing: null,
    knownDevices: new Set()
  };

  const newCode = () => {
    state.pairing = {
      code: String(crypto.randomInt(0, 1000000)).padStart(6, '0'),
      expiresAt: Date.now() + CODE_LIFETIME_MS,
      tries: 0
    };
    return state.pairing;
  };

  async function checkAll() {
    if (!db) return;
    try {
      await auth.listUsers(1);
      state.authOk = true;
      state.authError = null;
    } catch (e) {
      state.authOk = false;
      state.authError = /CONFIGURATION_NOT_FOUND|identitytoolkit|not been used|disabled/i.test(e.message)
        ? 'Authentication isn\'t turned on for this Firebase project yet.'
        : e.message;
    }
    if (!state.appConfig) {
      try {
        state.appConfig = await fetchAppConfig({ credential, projectId, appPackage });
        saveAppConfig(state.appConfig);
        state.appConfigError = null;
        log('[Setup] Found the app\'s Firebase details.');
      } catch (e) {
        state.appConfigError = e.message;
      }
    }
    if (rules && state.rulesOk !== true) {
      try {
        const current = await rules.getFirestoreRuleset();
        const text = (current.source || []).map(f => f.content).join('\n');
        state.rulesOk = text.includes('pairedTo(hid)');
      } catch (e) {
        state.rulesOk = false;
      }
    }
  }

  async function publishRules() {
    try {
      await rules.releaseFirestoreRulesetFromSource(rulesSource);
      state.rulesOk = true;
      state.rulesError = null;
      log('[Setup] Published the Firestore security rules.');
    } catch (e) {
      state.rulesOk = false;
      state.rulesError = e.message;
    }
  }

  if (db) {
    // rules are published only from the setup page: older versions of the app
    // stop working once they're on, so the family chooses when
    checkAll();
    // a removed device also loses its sign-in
    devicesRef.onSnapshot((snap) => {
      const now = new Set(snap.docs.map(d => d.id));
      for (const id of state.knownDevices) {
        if (!now.has(id)) auth.revokeRefreshTokens(id).catch(() => {});
      }
      state.knownDevices = now;
    }, () => {});
  }

  const ready = () => Boolean(db && state.authOk && state.appConfig);

  // the app pairs here (home network only)
  app.post('/api/pair', homeOnly, async (req, res) => {
    if (!ready()) return res.status(503).json({ error: 'This server isn\'t finished setting up. Open its setup page.' });
    const p = state.pairing;
    const code = String(req.body?.code || '').replace(/\D/g, '');
    if (!p || Date.now() > p.expiresAt) return res.status(400).json({ error: 'That code has expired. Show a new one on the setup page.' });
    if (++p.tries > 5) { state.pairing = null; return res.status(429).json({ error: 'Too many tries. Show a new code on the setup page.' }); }
    if (code !== p.code) return res.status(400).json({ error: 'That code isn\'t right.' });

    const deviceId = `dev_${crypto.randomBytes(9).toString('hex')}`;
    const name = String(req.body?.deviceName || 'Phone').slice(0, 60);
    const kind = ['phone', 'tablet', 'tv'].includes(req.body?.kind) ? req.body.kind : 'phone';
    try {
      await devicesRef.doc(deviceId).set({ name, kind, pairedAt: Date.now() });
      const token = await auth.createCustomToken(deviceId, { householdId });
      state.pairing = null; // one device per code
      log(`[Setup] Paired "${name}".`);
      res.json({
        householdId,
        deviceId,
        token,
        firebase: state.appConfig,
        server: { url: lanAddress(port), version }
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // a paired device that lost its sign-in (new phone install) can get a fresh one at home
  app.post('/api/pair/refresh', homeOnly, async (req, res) => {
    const deviceId = String(req.body?.deviceId || '');
    if (!ready() || !/^dev_[0-9a-f]+$/.test(deviceId)) return res.status(400).json({ error: 'Pair again.' });
    const doc = await devicesRef.doc(deviceId).get();
    if (!doc.exists) return res.status(404).json({ error: 'This device was removed. Pair it again.' });
    res.json({ householdId, deviceId, token: await auth.createCustomToken(deviceId, { householdId }), firebase: state.appConfig });
  });

  app.get('/setup', homeOnly, async (req, res) => {
    if (db && (!state.authOk || !state.appConfig)) await checkAll();
    const devices = db ? (await devicesRef.get()).docs.map(d => ({ id: d.id, ...d.data() })) : [];
    let qr = null;
    const p = state.pairing && Date.now() < state.pairing.expiresAt ? state.pairing : null;
    const serverUrl = lanAddress(port);
    if (ready() && p) {
      const link = `familydash://pair?server=${encodeURIComponent(serverUrl)}&code=${p.code}`;
      qr = await QRCode.toDataURL(link, { margin: 1, width: 280 });
    }
    const extras = ctx.extras ? await ctx.extras(req) : [];
    res.type('html').send(setupPage({ ...ctx, state, devices, pairing: p, qr, serverUrl, ready: ready(), extras }));
  });

  app.post('/setup/code', homeOnly, (req, res) => { newCode(); res.redirect('/setup#pair'); });
  app.post('/setup/rules', homeOnly, async (req, res) => { await publishRules(); res.redirect('/setup#rules'); });
  app.post('/setup/recheck', homeOnly, async (req, res) => { state.rulesOk = null; await checkAll(); res.redirect('/setup'); });
  app.post('/setup/app-config', homeOnly, express_text_guard, (req, res) => {
    try {
      const cfg = parseGoogleServices(String(req.body?.googleServices || ''), appPackage);
      if (!cfg.apiKey || !cfg.applicationId) throw new Error('That file is missing the app\'s key or id.');
      state.appConfig = cfg;
      state.appConfigError = null;
      saveAppConfig(cfg);
    } catch (e) {
      state.appConfigError = `Couldn't read that: ${e.message}`;
    }
    res.redirect('/setup#app');
  });
  // the Firebase key from the setup page, so nobody has to find the server's folder
  app.post('/setup/firebase-key', homeOnly, express_text_guard, (req, res) => {
    try {
      const raw = String(req.body?.key || '').trim();
      if (!raw) throw new Error('Choose the key file first.');
      let key;
      try { key = JSON.parse(raw); } catch (e) { throw new Error('That isn\'t the key file. It should be the .json file from Service accounts.'); }
      if (key.type !== 'service_account' || !key.project_id || !key.private_key || !key.client_email) {
        throw new Error('That .json file isn\'t a service-account key. In Firebase, use Project settings > Service accounts > Generate new private key.');
      }
      const name = `${key.project_id}-firebase-adminsdk-key.json`.replace(/[^\w.-]/g, '_');
      fs.writeFileSync(name, JSON.stringify(key, null, 2) + '\n', { mode: 0o600 });
      state.keyError = null;
      log(`[Setup] Saved the Firebase key for project ${key.project_id}. Restarting to connect.`);
      res.type('html').send(`<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="8;url=/setup"><body style="font:18px system-ui;padding:40px">Saved. Connecting to Firebase... this page reloads in a few seconds.</body>`);
      if (ctx.requestRestart) ctx.requestRestart();
    } catch (e) {
      state.keyError = e.message;
      res.redirect('/setup#firebase');
    }
  });
  app.post('/setup/devices/:id/remove', homeOnly, async (req, res) => {
    if (devicesRef && /^dev_[0-9a-f]+$/.test(req.params.id)) {
      await devicesRef.doc(req.params.id).delete().catch(() => {});
      auth.revokeRefreshTokens(req.params.id).catch(() => {});
    }
    res.redirect('/setup#devices');
  });

  return { state, ready };
}

// forms post url-encoded bodies; the main server only parses JSON
const express_text_guard = express.urlencoded({ extended: false, limit: '200kb' });


// ---- page ------------------------------------------------------------------------------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function step(id, ok, title, body) {
  const mark = ok === true ? '<span class="ok">&#10003;</span>' : ok === false ? '<span class="todo">!</span>' : '<span class="wait">&#8230;</span>';
  return `<section id="${id}" class="${ok === true ? 'done' : ''}"><h2>${mark} ${title}</h2>${body}</section>`;
}

function setupPage({ state, devices, pairing, qr, serverUrl, ready, projectId, householdId, appPackage, version, db, rulesSource, extras = [] }) {
  const fb = (p) => `https://console.firebase.google.com/project/${esc(projectId)}/${p}`;
  const parts = [];

  if (!db) {
    parts.push(step('firebase', false, 'Connect your own Firebase', `
      <p>Chores, rewards and to-dos are kept in a free Firebase project that belongs to you, so the app works away from home too.</p>
      <ol>
        <li>Go to <a href="https://console.firebase.google.com" target="_blank">console.firebase.google.com</a> and create a project. Google Analytics isn't needed.</li>
        <li>In <b>Build &gt; Firestore Database</b>, choose <b>Create database</b>, production mode, and the location nearest you.</li>
        <li>In <b>Build &gt; Authentication</b>, choose <b>Get started</b>. You don't need to turn on any sign-in method.</li>
        <li>In <b>Project settings &gt; Service accounts</b>, choose <b>Generate new private key</b>. A <code>.json</code> file downloads.</li>
        <li>Choose that file here. The server saves it in its settings folder and restarts. It never leaves this computer.</li>
      </ol>
      <form method="post" action="/setup/firebase-key" id="keyform">
        <input type="file" id="keyfile" accept=".json,application/json">
        <textarea name="key" id="keytext" rows="4" placeholder="...or paste the file's contents here"></textarea>
        <button>Connect Firebase</button>
      </form>
      ${state.keyError ? `<p class="err">${esc(state.keyError)}</p>` : ''}
      <script>
        document.getElementById('keyfile').addEventListener('change', async (e) => {
          const f = e.target.files[0]; if (!f) return;
          document.getElementById('keytext').value = await f.text();
        });
      </script>`));
  } else {
    parts.push(step('firebase', true, 'Firebase connected', `<p>Project <b>${esc(projectId)}</b>, family <b>${esc(householdId)}</b>.</p>`));
    parts.push(step('auth', state.authOk, 'Sign-in for paired devices', state.authOk
      ? '<p>Ready.</p>'
      : `<p>${esc(state.authError || 'Checking...')}</p><p>Open <a href="${fb('authentication')}" target="_blank">Authentication</a> in the Firebase console and choose <b>Get started</b>, then <form method="post" action="/setup/recheck" class="inline"><button>check again</button></form></p>`));
    parts.push(step('app', Boolean(state.appConfig), 'App connection details', state.appConfig
      ? `<p>Found for <code>${esc(state.appConfig.packageName || appPackage)}</code>.</p>`
      : `<p>${state.appConfigError ? `The server couldn't get these itself (${esc(state.appConfigError)}).` : 'Looking...'}</p>
         <p>In <a href="${fb('settings/general')}" target="_blank">Project settings</a>, add an <b>Android</b> app with the package name <code>${esc(appPackage)}</code> (skip the other steps), download its <code>google-services.json</code>, and paste the file's contents here:</p>
         <form method="post" action="/setup/app-config"><textarea name="googleServices" rows="6" placeholder='{ "project_info": ...'></textarea><button>Save</button></form>`));
    parts.push(step('rules', state.rulesOk, 'Security rules', state.rulesOk
      ? '<p>Published. Only devices paired with this server can open your family\'s data.</p>'
      : `<p>${state.rulesError ? `Publishing failed: ${esc(state.rulesError)}` : 'Not published yet, so your family\'s data isn\'t locked down.'}</p>
         <p class="muted">Publish once your phones and tablets are paired with app 2.1 or later. Older versions of the app (and any copy of an older APK) stop working at that moment, which is the point.</p>
         <form method="post" action="/setup/rules"><button>Publish rules</button></form>
         <details><summary>Or paste them yourself</summary><p>Firebase console &gt; Firestore Database &gt; Rules:</p><pre>${esc(rulesSource)}</pre></details>`));
  }

  if (ready) {
    parts.push(step('pair', devices.length > 0 ? true : null, 'Pair a phone or tablet', pairing
      ? `<div class="pair"><img src="${qr}" alt="Pairing QR code"><div><p>In the app, choose <b>Connect to your family dashboard</b> and scan this code, or type:</p>
         <p class="code">${pairing.code.slice(0, 3)} ${pairing.code.slice(3)}</p>
         <p>Server: <code>${esc(serverUrl)}</code></p><p class="muted">Works once, for the next ${Math.max(1, Math.round((pairing.expiresAt - Date.now()) / 60000))} minutes. The phone must be on this Wi-Fi.</p></div></div>
         <form method="post" action="/setup/code"><button>Show a new code</button></form>`
      : `<p>Each phone or tablet pairs once, on your home Wi-Fi. After that it works anywhere.</p><form method="post" action="/setup/code"><button>Show a pairing code</button></form>`));
    parts.push(step('devices', devices.length ? true : null, `Paired devices (${devices.length})`, devices.length
      ? `<ul class="devices">${devices.sort((a, b) => (b.pairedAt || 0) - (a.pairedAt || 0)).map(d => `<li><span>${esc(d.name)} <small>${esc(d.kind)}, paired ${new Date(d.pairedAt || 0).toLocaleDateString()}</small></span>
          <form method="post" action="/setup/devices/${esc(d.id)}/remove"><button class="quiet">Remove</button></form></li>`).join('')}</ul>`
      : '<p class="muted">None yet.</p>'));
  }

  parts.push(...extras);
  parts.push(step('roku', null, 'Roku', `<p>Open the Family Dashboard on your Roku (app 4.3 or newer). It finds this server by itself. If it doesn't, press <b>*</b> and set the home server address to <code>${esc(serverUrl)}</code>.</p>`));

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Family Dashboard setup</title>
<style>
  :root { --bg:#faf7f2; --card:#fff; --ink:#1b1c1a; --muted:#5c5f59; --line:#e4dfd5; --green:#1f6b4f; --orange:#e8623c; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0e1512; --card:#16201b; --ink:#e4e7e3; --muted:#b9c2bc; --line:#2c3a33; --green:#7fd3ae; --orange:#ff9c7a; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:16px/1.5 -apple-system, system-ui, "Segoe UI", Roboto, sans-serif; }
  main { max-width: 760px; margin: 0 auto; padding: 24px 16px 64px; }
  h1 { font-size: 28px; margin: 8px 0 4px; } h2 { font-size: 19px; margin: 0 0 8px; display:flex; gap:10px; align-items:center; }
  section { background:var(--card); border:1px solid var(--line); border-radius:16px; padding:18px 20px; margin:14px 0; }
  section.done h2 { color: var(--green); }
  .ok, .todo, .wait { display:inline-grid; place-items:center; width:26px; height:26px; border-radius:50%; font-size:15px; color:#fff; flex:none; }
  .ok { background:var(--green); } .todo { background:var(--orange); } .wait { background:var(--muted); }
  button { background:var(--green); color:#fff; border:0; border-radius:10px; padding:10px 16px; font-size:15px; cursor:pointer; }
  button.quiet { background:transparent; color:var(--orange); border:1px solid var(--line); padding:6px 12px; }
  form.inline { display:inline; } textarea { width:100%; font:13px ui-monospace, monospace; border-radius:10px; border:1px solid var(--line); padding:10px; background:var(--bg); color:var(--ink); margin-bottom:8px; }
  pre { white-space:pre-wrap; font-size:12px; background:var(--bg); padding:12px; border-radius:10px; overflow:auto; }
  code { background:var(--bg); padding:1px 6px; border-radius:6px; }
  .pair { display:flex; gap:20px; align-items:center; flex-wrap:wrap; } .pair img { width:220px; height:220px; border-radius:12px; background:#fff; padding:6px; }
  .code { font-size:40px; font-weight:700; letter-spacing:4px; margin:4px 0; }
  .muted, small { color:var(--muted); } a { color:var(--green); } .err { color:var(--orange); font-weight:600; }
  input[type=file] { margin: 4px 0 10px; } .row { display:flex; gap:10px; flex-wrap:wrap; align-items:center; }
  .notes { white-space:pre-wrap; font-size:14px; background:var(--bg); padding:12px; border-radius:10px; max-height:240px; overflow:auto; }
  ul.devices { list-style:none; padding:0; margin:0; } ul.devices li { display:flex; justify-content:space-between; align-items:center; padding:10px 0; border-top:1px solid var(--line); gap:12px; }
  ul.devices li:first-child { border-top:0; } ul.devices small { display:block; }
</style></head><body><main>
<h1>Family Dashboard setup</h1><p class="muted">Server ${esc(version)}. This page only opens on your home network.</p>
${parts.join('\n')}
</main></body></html>`;
}
