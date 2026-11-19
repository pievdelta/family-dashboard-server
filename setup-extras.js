// Setup page sections for running the server without a terminal:
// updates, the log, and the settings folder.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import express from 'express';
import { homeOnly } from './pairing.js';
import { updateConfigFile } from './cloud-config.js';
import { aiSettings, askAI, AI_PROVIDERS } from './ai.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const form = express.urlencoded({ extended: false, limit: '10kb' });

// true when the browser runs on this same computer (so "show in Finder" makes sense)
function onThisComputer(req) {
  let ip = String(req.socket?.remoteAddress || '');
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  if (ip === '::1' || ip.startsWith('127.')) return true;
  return Object.values(os.networkInterfaces()).flat().some(a => a && a.address === ip);
}

function section(id, ok, title, body) {
  const mark = ok === true ? '<span class="ok">&#10003;</span>' : ok === false ? '<span class="todo">!</span>' : '<span class="wait">&#8230;</span>';
  return `<section id="${id}" class="${ok === true ? 'done' : ''}"><h2>${mark} ${title}</h2>${body}</section>`;
}

// macOS: is the firewall blocking this server's Node? (asked without admin rights)
let fwCache = { at: 0, blocked: false };
function firewallBlocks() {
  if (process.platform !== 'darwin') return false;
  if (Date.now() - fwCache.at < 60000) return fwCache.blocked;
  const FW = '/usr/libexec/ApplicationFirewall/socketfilterfw';
  let blocked = false;
  try {
    const on = spawnSync(FW, ['--getglobalstate'], { encoding: 'utf8', timeout: 3000 }).stdout || '';
    if (/enabled/i.test(on) && !/disabled/i.test(on)) {
      const app = spawnSync(FW, ['--getappblocked', process.execPath], { encoding: 'utf8', timeout: 3000 }).stdout || '';
      const all = spawnSync(FW, ['--getblockall'], { encoding: 'utf8', timeout: 3000 }).stdout || '';
      blocked = /is blocked|not.*permitted|not part of/i.test(app) || /enabled/i.test(all) && !/disabled/i.test(all);
    }
  } catch (e) {}
  fwCache = { at: Date.now(), blocked };
  return blocked;
}

function tail(file, lines) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return text.split('\n').slice(-lines).join('\n');
  } catch (e) {
    return '';
  }
}

export function setupExtras(app, { updater, dataDir = process.cwd(), requestRestart, aiState = () => ({}), log = console.log }) {
  const logFile = path.join(dataDir, 'logs', 'server.log');
  let installError = null;

  app.post('/setup/update/check', homeOnly, async (req, res) => {
    await updater.check();
    res.redirect('/setup#updates');
  });

  app.post('/setup/update/install', homeOnly, form, async (req, res) => {
    try {
      installError = null;
      const v = await updater.install();
      res.type('html').send(`<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="20;url=/setup#updates">
<body style="font:18px system-ui;padding:40px;max-width:640px">Installed ${esc(v)}. The server is restarting into it now. This page reloads in about 20 seconds.
<p style="color:#666">If the new version doesn't start, the server goes back to the one you had and says so here.</p></body>`);
    } catch (e) {
      installError = e.message;
      log(`[Update] ${e.message}`);
      res.redirect('/setup#updates');
    }
  });

  // settings files from an older copy (a folder run with npm start), chosen in the browser
  const IMPORTABLE = ['config.txt', 'household.json', 'firebase-app.json', '.cloud-sync.json', 'calendar-filters.json'];
  let importNote = null;
  app.post('/setup/import', homeOnly, express.json({ limit: '2mb' }), (req, res) => {
    const files = req.body?.files || {};
    const saved = [];
    const skipped = [];
    try {
      for (const [rawName, text] of Object.entries(files)) {
        const name = path.basename(String(rawName));
        const isKey = /firebase-adminsdk.*\.json$/i.test(name);
        if ((!IMPORTABLE.includes(name) && !isKey) || typeof text !== 'string' || text.length > 1_000_000) { skipped.push(name); continue; }
        if (name.endsWith('.json')) { try { JSON.parse(text); } catch (e) { throw new Error(`${name} is damaged`); } } // refuse a broken file rather than save it
        if (name === 'config.txt' && !/^[A-Z0-9_]+=/m.test(text)) throw new Error('config.txt doesn\'t look like a settings file');
        if (saved.some(f => f.name === name)) throw new Error(`${name} was chosen twice`);
        saved.push({ name, text, mode: name === 'config.txt' || isKey ? 0o600 : 0o644 });
      }
      // everything checked out: now save
      for (const f of saved) fs.writeFileSync(path.join(dataDir, f.name), f.text, { mode: f.mode });
      saved.splice(0, saved.length, ...saved.map(f => f.name));
      if (!saved.length) throw new Error(skipped.length ? `none of those are settings files (${skipped.join(', ')})` : 'no files were chosen');
      // the app may have changed settings since: let the newest copy win on restart, as usual
      importNote = `Brought in ${saved.join(', ')}${skipped.length ? `. Skipped ${skipped.join(', ')}` : ''}. Restarting to use them.`;
      log(`[Setup] Imported ${saved.join(', ')} from an older copy.`);
      res.json({ ok: true, message: importNote });
      if (requestRestart) requestRestart();
    } catch (e) {
      res.status(400).json({ error: `Couldn't bring those in: ${e.message}` });
    }
  });

  // ---- AI with the family's own key
  let aiNote = null;
  app.post('/setup/ai', homeOnly, form, (req, res) => {
    const provider = String(req.body?.provider || '').toLowerCase();
    const key = String(req.body?.key || '').replace(/[\r\n]/g, '').trim();
    if (req.body?.remove === '1') {
      updateConfigFile(path.join(dataDir, 'config.txt'), { AI_API_KEY: '', AI_PROVIDER: '', GEMINI_API_KEY: '' });
      aiNote = 'Removed the AI key. Restarting.';
      log('[Setup] AI key removed.');
      res.redirect('/setup#ai');
      if (requestRestart) requestRestart();
      return;
    }
    if (!AI_PROVIDERS[provider] || key.length < 20) {
      aiNote = 'Choose a provider and paste the whole key.';
      return res.redirect('/setup#ai');
    }
    updateConfigFile(path.join(dataDir, 'config.txt'), { AI_PROVIDER: provider, AI_API_KEY: key });
    aiNote = `Saved your ${AI_PROVIDERS[provider].name} key. Restarting to turn on meal ideas and the brain dump.`;
    log(`[Setup] AI key saved for ${AI_PROVIDERS[provider].name}.`);
    res.redirect('/setup#ai');
    if (requestRestart) requestRestart();
  });
  app.post('/setup/ai/test', homeOnly, async (req, res) => {
    const s = aiSettings();
    try {
      const j = await askAI(s, 'Reply with JSON only.', 'Reply with {"ok": true, "say": "a five-word hello to a busy family"}.');
      aiNote = `It works. ${s.providerName} says: "${String(j.say || 'hello').slice(0, 80)}"`;
    } catch (e) {
      aiNote = `The test didn't work: ${e.message}`;
    }
    res.redirect('/setup#ai');
  });

  app.post('/setup/restart', homeOnly, (req, res) => {
    log('[Setup] Restart requested from the setup page.');
    res.type('html').send('<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="10;url=/setup"><body style="font:18px system-ui;padding:40px">Restarting... this page reloads in a few seconds.</body>');
    if (requestRestart) requestRestart();
  });

  app.get('/setup/log', homeOnly, (req, res) => {
    const text = tail(logFile, 400) || 'No log yet. When the server is started from a terminal, the log is in that window.';
    res.type('text/plain; charset=utf-8').send(text);
  });

  app.post('/setup/open-folder', homeOnly, (req, res) => {
    if (onThisComputer(req)) {
      const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
      try { spawn(opener, [dataDir], { detached: true, stdio: 'ignore' }).unref(); } catch (e) {}
    }
    res.redirect('/setup#updates');
  });

  // the sections, built per request
  return (req) => {
    const s = updater.status;
    const parts = [];
    let ok = null;
    let body = '';
    const note = updater.takeMessage();
    if (note) body += `<p><b>${esc(note)}</b></p>`;
    if (!updater.enabled) {
      body += `<p>Version ${esc(s.current)}. Update checks are off in this copy.</p>`;
    } else if (updater.available()) {
      ok = false;
      const L = s.latest;
      body += `<p>Version <b>${esc(L.version)}</b> is out. You have ${esc(s.current)}.</p>`;
      if (L.notes) body += `<div class="notes">${esc(L.notes)}</div>`;
      if (s.installing) {
        body += `<p>${esc(s.step || 'Installing')}...</p>`;
      } else if (updater.managed) {
        body += `<p class="muted">Your settings, keys and paired devices stay as they are. It takes about a minute.</p>
          <form method="post" action="/setup/update/install"><button>Update to ${esc(L.version)}</button></form>`;
      } else {
        body += `<p>This copy was started from a folder by hand, so update it the same way: <a href="${esc(L.url)}" target="_blank">download ${esc(L.version)}</a>, or run <code>git pull</code> and <code>npm install</code>, then start it again.</p>`;
      }
    } else {
      ok = true;
      const when = s.checkedAt ? new Date(s.checkedAt).toLocaleString() : 'not yet';
      body += `<p>Version ${esc(s.current)} is the newest. <span class="muted">Last checked ${esc(when)}.</span></p>
        <form method="post" action="/setup/update/check"><button class="quiet">Check now</button></form>`;
    }
    if (s.error) body += `<p class="err">${esc(s.error)}</p>`;
    if (installError) body += `<p class="err">The update didn't install: ${esc(installError)}</p>`;
    parts.push(section('updates', ok, 'Updates', body));

    // AI
    const ai = aiSettings();
    const st = aiState() || {};
    let aiBody = `<p>Optional. With your own AI key, the app suggests dinners from what your kids eat and what's on the grocery list, and turns a quick brain dump into to-dos, groceries and events. Requests go from this server straight to the AI company you pick, using your key.</p>`;
    if (aiNote) aiBody += `<p><b>${esc(aiNote)}</b></p>`;
    if (ai.configured) {
      aiBody += `<p>Using <b>${esc(ai.providerName)}</b> (${esc(ai.model)}).${st.lastError ? ` <span class="err">Last problem: ${esc(st.lastError)}</span>` : ''}</p>
        <div class="row"><form method="post" action="/setup/ai/test" class="inline"><button class="quiet">Test it</button></form>
        <form method="post" action="/setup/ai" class="inline"><input type="hidden" name="remove" value="1"><button class="quiet">Remove the key</button></form></div>
        <details><summary>Use a different key</summary>`;
    }
    aiBody += `<form method="post" action="/setup/ai" class="row">
        <select name="provider">${Object.entries(AI_PROVIDERS).map(([id, p]) => `<option value="${id}"${(ai.provider || 'gemini') === id ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
        <input name="key" type="password" autocomplete="off" placeholder="Paste your API key" style="flex:1;min-width:220px">
        <button>Save key</button></form>
      <p class="muted small">Getting a key: Gemini at aistudio.google.com (has a free tier), Claude at console.anthropic.com, OpenAI at platform.openai.com. The key stays in config.txt on this computer.</p>`;
    if (ai.configured) aiBody += '</details>';
    parts.push(section('ai', ai.configured ? true : null, 'AI (optional)', aiBody));

    let tools = `<div class="row"><a href="/setup/log" target="_blank">Show the server log</a>`;
    if (onThisComputer(req)) tools += `<form method="post" action="/setup/open-folder" class="inline"><button class="quiet">Show settings folder</button></form>`;
    if (process.env.FD_LAUNCHER === '1') tools += `<form method="post" action="/setup/restart" class="inline"><button class="quiet">Restart server</button></form>`;
    tools += `</div><p class="muted">Settings folder: <code>${esc(dataDir)}</code></p>`;
    if (updater.status.repo) tools += `<p class="muted">Free software under the AGPL-3.0. <a href="https://github.com/${esc(updater.status.repo)}" target="_blank">Source code</a></p>`;
    tools += `<details${importNote ? ' open' : ''}><summary>Moving from an older copy you ran with npm start?</summary>
      <p>Stop the old copy first (close its Terminal window). Then choose these files from its folder: <code>config.txt</code>, <code>household.json</code>, and if they're there <code>firebase-app.json</code>, <code>calendar-filters.json</code> and <code>.cloud-sync.json</code>.
      Your Firebase key isn't needed again. Files starting with a dot are hidden: press <b>Cmd + Shift + .</b> in the file window to show them.</p>
      <input type="file" id="importfiles" multiple><button type="button" id="importbtn">Bring them in</button>
      <p id="importmsg" class="muted">${importNote ? esc(importNote) : ''}</p>
      <script>
        document.getElementById('importbtn').addEventListener('click', async () => {
          const msg = document.getElementById('importmsg');
          const files = {};
          for (const f of document.getElementById('importfiles').files) files[f.name] = await f.text();
          if (!Object.keys(files).length) { msg.textContent = 'Choose the files first.'; return; }
          msg.textContent = 'Saving...';
          const r = await fetch('/setup/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ files }) });
          const j = await r.json().catch(() => ({}));
          msg.textContent = j.message || j.error || 'Something went wrong.';
          if (r.ok) setTimeout(() => location.reload(), 9000);
        });
      </script></details>`;
    if (firewallBlocks()) {
      parts.unshift(section('firewall', false, 'The Mac\'s firewall is blocking phones and the TV', `<p>This page works on this Mac, but other devices can't reach the server. In Terminal, run:</p>
<pre>sudo /usr/libexec/ApplicationFirewall/socketfilterfw --add "${esc(process.execPath)}"
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --unblockapp "${esc(process.execPath)}"</pre>
<p class="muted">Or in System Settings &gt; Network &gt; Firewall &gt; Options, add <code>${esc(process.execPath)}</code> and set it to allow incoming connections. Then reload this page.</p>`));
    }
    parts.unshift(`<p class="running">&#9679; The server is running${process.env.FD_LAUNCHER === '1' && process.env.FD_HOME ? ' in the background on this Mac and starts by itself when you log in. There is nothing to keep open.' : '.'}</p>`);
    parts.push(section('tools', null, 'Server', tools));
    return parts;
  };
}
