// Setup page sections for running the server without a terminal:
// updates, the log, and the settings folder.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import express from 'express';
import { homeOnly } from './pairing.js';

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

function tail(file, lines) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return text.split('\n').slice(-lines).join('\n');
  } catch (e) {
    return '';
  }
}

export function setupExtras(app, { updater, dataDir = process.cwd(), requestRestart, log = console.log }) {
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

    let tools = `<div class="row"><a href="/setup/log" target="_blank">Show the server log</a>`;
    if (onThisComputer(req)) tools += `<form method="post" action="/setup/open-folder" class="inline"><button class="quiet">Show settings folder</button></form>`;
    if (process.env.FD_LAUNCHER === '1') tools += `<form method="post" action="/setup/restart" class="inline"><button class="quiet">Restart server</button></form>`;
    tools += `</div><p class="muted">Settings folder: <code>${esc(dataDir)}</code></p>`;
    if (updater.status.repo) tools += `<p class="muted">Free software under the AGPL-3.0. <a href="https://github.com/${esc(updater.status.repo)}" target="_blank">Source code</a></p>`;
    parts.push(section('tools', null, 'Server', tools));
    return parts;
  };
}
