// npm test: quick checks that need no Firebase, calendar or internet.
//   1. the updater's version and checksum helpers
//   2. the server starts (with a stand-in for Firebase) and its main pages answer
import assert from 'assert/strict';
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { newer, parseSums } from '../updater.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`ok    ${name}`); } catch (e) { failed++; console.log(`FAIL  ${name}\n      ${e.message}`); }
}

await test('version compare', () => {
  assert.equal(newer('5.10.0', '5.9.9'), true);
  assert.equal(newer('5.2.0', '5.2.0'), false);
  assert.equal(newer('5.1.9', '5.2.0'), false);
  assert.equal(newer('6.0.0', '5.99.99'), true);
});

await test('checksum file', () => {
  const sums = parseSums(`${'a'.repeat(64)}  family-dashboard-server-5.2.0.tar.gz\n${'B'.repeat(64)} *Family-Dashboard-Server-5.2.0.pkg\n`);
  assert.equal(sums['family-dashboard-server-5.2.0.tar.gz'], 'a'.repeat(64));
  assert.equal(sums['Family-Dashboard-Server-5.2.0.pkg'], 'b'.repeat(64));
});

await test('AI replies are read and cleaned', async () => {
  const { parseJsonReply, cleanBrainDump, cleanMeals, aiSettings } = await import('../ai.js');
  assert.deepEqual(parseJsonReply('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJsonReply('Sure! {"a":2} hope that helps'), { a: 2 });
  const bd = cleanBrainDump({ todos: [{ title: 'Call plumber', due: 'next week' }, { title: '' }], groceries: ['milk', ''], events: [{ title: 'Party', date: '2026-12-01' }, { title: 'No date' }] });
  assert.equal(bd.todos.length, 1); assert.equal(bd.todos[0].due, null); assert.equal(bd.todos[0].owner, 'me');
  assert.deepEqual(bd.groceries, ['milk']); assert.equal(bd.events.length, 1);
  assert.throws(() => cleanBrainDump({}));
  assert.equal(cleanMeals({ ideas: [{ name: 'Tacos', minutes: '20' }] }).ideas[0].minutes, 20);
  assert.equal(aiSettings({ GEMINI_API_KEY: 'k'.repeat(30) }).provider, 'gemini');
  assert.equal(aiSettings({ AI_PROVIDER: 'claude', AI_API_KEY: 'k'.repeat(30) }).providerName, 'Claude');
  assert.equal(aiSettings({}).configured, false);
});

await test('planned meals join the calendar; pantry goes to the meal AI', async () => {
  const { buildTaskEvents } = await import('../tasks.js');
  const { mealPrompt } = await import('../ai.js');
  const tz = 'America/New_York';
  const f = (o) => new Intl.DateTimeFormat('en-US', { timeZone: tz, ...o });
  const fmt = {
    toNyIsoDate: (d) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(d),
    getNyHourMinute: (d) => { const p = f({ hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(d); return { h: Number(p.find(x => x.type === 'hour').value), m: Number(p.find(x => x.type === 'minute').value) }; },
    wkFmt: f({ weekday: 'short' }), monShortFmt: f({ month: 'short' }), monFullFmt: f({ month: 'long' }),
    dateLblFmt: f({ weekday: 'long', month: 'short', day: 'numeric' }), timeLblFmt: f({ hour: 'numeric', minute: '2-digit' })
  };
  const now = new Date('2026-11-19T15:00:00Z');
  const ev = buildTaskEvents({ meals: [
    { id: 'a', date: '2026-11-19', name: 'Tacos' },
    { id: 'b', date: '2026-11-20', name: 'Soup', meal: 'lunch', time: '12:30' },
    { id: 'c', date: '2026-11-01', name: 'Old' }
  ], memberForUser: () => null, fmt, now });
  assert.deepEqual(ev.map(e => e.title), ['Dinner: Tacos', 'Lunch: Soup']);
  assert.equal(ev[0].isAllDay, true); assert.equal(ev[1].timeLabel, '12:30 PM'); assert.equal(ev[0].kind, 'meal');
  const p = mealPrompt({ kids: [], groceries: { toBuy: [], recent: ['chicken'], pantry: ['rice', 'pasta'] }, planned: ['2026-11-19: Tacos'], today: '2026-11-19' });
  assert.match(p.prompt, /Pantry staples they always have: rice, pasta/);
  assert.match(p.prompt, /don't repeat these\): 2026-11-19: Tacos/);
});

await test('meal choices reach the prompt; old meals and groceries are tidied', async () => {
  const { mealPrompt } = await import('../ai.js');
  const { tidyOldData } = await import('../tasks.js');
  const base = { kids: [{ name: 'A', safeFoods: 'pasta' }], groceries: { toBuy: [], recent: [] }, today: '2026-11-19' };
  const fav = mealPrompt({ ...base, minutes: 30, vibe: 'favorites', note: 'chicken in the freezer' });
  assert.match(fav.prompt, /30 minutes at most/); assert.match(fav.prompt, /build every dinner around/); assert.match(fav.prompt, /chicken in the freezer/);
  assert.match(fav.system, /Respect what each kid will eat/);
  const adv = mealPrompt({ ...base, vibe: 'adventurous' });
  assert.match(adv.system, /something new/); assert.doesNotMatch(adv.system, /Respect/);
  assert.match(mealPrompt({ ...base, vibe: 'nonsense' }).prompt, /build every dinner around/);

  const dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fd-tidy-')), 'db.json');
  const now = new Date('2026-11-19T15:00:00Z').getTime();
  const DAY = 86400000;
  fs.writeFileSync(dbFile, JSON.stringify({
    'households/h/meals/old': { date: '2026-11-10', name: 'Old' },
    'households/h/meals/recent': { date: '2026-11-17', name: 'Recent' },
    'households/h/groceries/g1': { name: 'milk', done: true, doneAt: now - 5 * DAY },
    'households/h/groceries/g2': { name: 'eggs', done: true, doneAt: now - DAY },
    'households/h/groceries/g3': { name: 'bread', done: false }
  }));
  process.env.FAKE_FIREBASE_DB = dbFile;
  const { firestore } = await import('./fake-firebase.mjs');
  const db = firestore();
  const root = db.collection('households').doc('h');
  assert.equal(await tidyOldData(root, now), 2);
  const left = (await root.collection('groceries').get()).docs.map(d => d.id).sort();
  assert.deepEqual(left, ['g2', 'g3']);
  assert.deepEqual((await root.collection('meals').get()).docs.map(d => d.id), ['recent']);
});

await test('Home Assistant devices read and alert like a family would expect', async () => {
  const { describe, homeAlerts, applyEntityMessage, haSettings } = await import('../home-assistant.js');
  const d = (entity_id, state, attributes = {}) => describe({ entity_id, state, attributes });
  assert.deepEqual([d('lock.front', 'unlocked').state, d('lock.front', 'unlocked').attention], ['Unlocked', true]);
  assert.equal(d('cover.garage', 'open', { device_class: 'garage' }).icon, 'garage');
  assert.equal(d('binary_sensor.back', 'off', { device_class: 'door' }).state, 'Closed');
  assert.equal(d('binary_sensor.leak', 'on', { device_class: 'moisture' }).state, 'Wet');
  assert.equal(d('climate.hall', 'heat', { current_temperature: 69.6, hvac_action: 'heating' }).state, '70° · Heating');
  assert.equal(d('sensor.out', '41.26', { unit_of_measurement: '°F' }).state, '41.3°F');
  assert.equal(d('lock.x', 'unavailable').state, 'Not available');
  assert.equal(haSettings({ HA_URL: 'homeassistant.local:8123/', HA_TOKEN: 't' }).url, 'http://homeassistant.local:8123');

  const now = Date.parse('2026-11-19T20:00:00Z');
  const ents = {
    'cover.garage': { state: 'open', attributes: { friendly_name: 'Garage door', device_class: 'garage' }, last_changed: now - 31 * 60000 },
    'lock.front': { state: 'unlocked', attributes: { friendly_name: 'Front door' }, last_changed: now - 60000 },
    'binary_sensor.leak': { state: 'on', attributes: { friendly_name: 'Basement', device_class: 'moisture' }, last_changed: now - 5000 },
    'event.doorbell': { state: new Date(now - 10000).toISOString(), attributes: { friendly_name: 'Front doorbell', device_class: 'doorbell' }, last_changed: now - 10000 },
    'lock.back': { state: 'locked', attributes: { friendly_name: 'Back door' }, last_changed: now - 5000 }
  };
  const alerts = homeAlerts(ents, { alerts: { 'cover.garage': 30, 'lock.front': 10, 'binary_sensor.leak': 0, 'event.doorbell': 0, 'lock.back': 0 } }, now);
  const byId = Object.fromEntries(alerts.map(a => [a.id.split('-').slice(0, 2).join('-'), a]));
  assert.equal(byId['ha-cover.garage'].title, 'Garage door has been open 30 minutes');
  assert.ok(byId['ha-cover.garage'].at * 1000 <= now, 'garage alert is due');
  assert.ok(byId['ha-lock.front'].at * 1000 > now, 'front door alert waits for 10 minutes');
  assert.equal(byId['ha-binary_sensor.leak'].title, 'Basement detects water');
  assert.equal(byId['ha-event.doorbell'].title, 'Someone is at the door');
  assert.ok(!byId['ha-lock.back'], 'a locked door has no alert');
  assert.ok(alerts.every(a => a.kind === 'home'));
  assert.equal(homeAlerts(ents, { alerts: { 'event.doorbell': 0 } }, now + 5 * 60000).length, 0, 'doorbell alert ends after 2 minutes');

  const map = {};
  applyEntityMessage(map, { a: { 'lock.front': { s: 'locked', a: { friendly_name: 'Front door' }, lc: 1700000000.5 } } });
  assert.equal(map['lock.front'].last_changed, 1700000000500);
  applyEntityMessage(map, { c: { 'lock.front': { '+': { s: 'unlocked', lc: 1700000100 } } } });
  assert.deepEqual([map['lock.front'].state, map['lock.front'].last_changed], ['unlocked', 1700000100000]);
  applyEntityMessage(map, { c: { 'lock.front': { '+': { a: { battery: 80 } }, '-': { a: ['friendly_name'] } } } });
  assert.deepEqual(map['lock.front'].attributes, { battery: 80 });
  applyEntityMessage(map, { r: ['lock.front'] });
  assert.equal(map['lock.front'], undefined);
});

await test('allergies are strict in the prompt and flagged in ideas', async () => {
  const { mealPrompt, cleanMeals, allergyWarning } = await import('../ai.js');
  const al = [{ name: 'Leo', items: ['Peanuts'] }, { name: 'Sam', items: ['Shellfish'] }, { name: 'Maya', items: ['Milk'] }, { name: 'Dana', items: ['Eggs'] }];
  const p = mealPrompt({ kids: [], groceries: { toBuy: [], recent: [] }, today: '2026-11-19', allergies: al });
  assert.match(p.system, /allergies are strict/);
  assert.match(p.prompt, /FOOD ALLERGIES.*Leo: Peanuts; Sam: Shellfish/);
  assert.equal(mealPrompt({ kids: [], groceries: { toBuy: [], recent: [] }, today: 'x' }).prompt.includes('ALLERG'), false);
  const out = cleanMeals({ ideas: [{ name: 'Shrimp tacos', ingredients: ['shrimp', 'corn tortillas'] }, { name: 'Chicken and rice', ingredients: ['chicken', 'rice', 'coconut milk'] }] }, al);
  assert.equal(out.ideas[0].name, 'Chicken and rice', 'safe ideas first');
  assert.equal(out.ideas[0].warning, null);
  assert.match(out.ideas[1].warning, /shellfish \(Sam\)/);
  assert.equal(allergyWarning({ name: 'Eggplant', ingredients: ['butternut squash', 'peanut-free sauce'] }, [{ name: 'D', items: ['Eggs', 'Milk'] }]), null);
});

await test('each TV gets its own layout, and edits from the app come back', async () => {
  const { createDisplays, buildLists, cleanProfile } = await import('../displays.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-tvs-'));
  process.env.FAKE_FIREBASE_DB = path.join(dir, 'db.json');
  const { firestore } = await import('./fake-firebase.mjs');
  const root = firestore().collection('households').doc('h');
  let t = 1000;
  const tv = createDisplays({ file: path.join(dir, 'tvs.json'), log: () => {}, now: () => t });
  assert.equal(tv.seen({}), null, 'a browser that is not a TV is not listed');
  assert.equal(tv.seen({ tv: 'x' }), null, 'ids are checked');
  const first = tv.seen({ tv: 'roku-1', tvKind: 'roku', tvModel: 'Roku Ultra' });
  assert.equal(first.name, 'Roku Ultra'); assert.equal(first.profileId, 'house');
  assert.equal(tv.seen({ tv: 'roku-2', tvKind: 'roku', tvModel: 'Roku Ultra' }).name, 'Roku Ultra 2');
  tv.attachCloud(root);
  await new Promise(r => setTimeout(r, 700));
  assert.equal((await root.collection('config').doc('tvs').get()).data().displays['roku-1'].name, 'Roku Ultra', 'shared with the app');
  // the app renames one and switches it to the parents layout
  const remote = (await root.collection('config').doc('tvs').get()).data();
  remote.displays['roku-1'].name = 'Bedroom'; remote.displays['roku-1'].profile = 'parents';
  await root.collection('config').doc('tvs').set({ ...remote, by: 'app', updatedAt: t + 5000 });
  await new Promise(r => setTimeout(r, 50));
  const after = tv.seen({ tv: 'roku-1' });
  assert.equal(after.name, 'Bedroom'); assert.equal(after.profileId, 'parents');
  assert.ok(!after.profile.cards.includes('chores'), 'parents layout has no chores');
  assert.deepEqual(cleanProfile({ cards: ['weather', 'bogus', 'weather'], sections: ['lists'] }).cards, ['weather']);

  const now = new Date(2026, 10, 21, 12, 0, 0);
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const lists = buildLists({
    todos: [
      { id: 'a', title: 'Overdue', ownerId: 'p1', dueAt: now.getTime() - 3 * 86400000 },
      { id: 'b', title: 'Anytime', ownerId: null },
      { id: 'c', title: 'Secret', ownerId: 'p1', private: true },
      { id: 'd', title: 'Next week', ownerId: 'p1', dueAt: now.getTime() + 7 * 86400000 },
      { id: 'e', title: 'Finished', done: true }
    ],
    groceries: [{ id: 'g', name: 'milk' }, { id: 'h', name: 'eggs', done: true }],
    meals: [{ date: iso(now), name: 'Tacos' }],
    users: [{ id: 'p1', name: 'Sam' }],
    profile: { privateTodosOf: [] }, now, isoOf: iso, dayName: () => 'Day'
  });
  assert.deepEqual(lists.todos.today.map(x => x.title), ['Overdue'], 'overdue shows as today');
  assert.deepEqual(lists.todos.anytime.map(x => [x.title, x.who]), [['Anytime', 'Both']]);
  assert.deepEqual(lists.groceries.toBuy.map(x => x.name), ['milk']);
  assert.equal(lists.meals.tonight[0].name, 'Tacos'); assert.equal(lists.meals.week.length, 7);
  const parents = buildLists({ todos: [{ id: 'c', title: 'Secret', ownerId: 'p1', private: true }], profile: { privateTodosOf: ['p1'] }, now, isoOf: iso, dayName: () => '' });
  assert.equal(parents.todos.anytime[0].title, 'Secret', 'private to-dos only where allowed');
});

await test('server starts and answers', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-test-'));
  fs.copyFileSync(path.join(root, 'household.example.json'), path.join(data, 'household.json'));
  const port = 39000 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, [path.join(root, 'server.js')], {
    cwd: data,
    env: { ...process.env, PORT: String(port), FAKE_FIREBASE: path.join(root, 'test', 'fake-firebase.mjs'), FAKE_FIREBASE_DB: path.join(data, 'db.json'), FD_UPDATE_REPO: 'off' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let out = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });
  try {
    const base = `http://127.0.0.1:${port}`;
    let up = false;
    for (let i = 0; i < 60 && !up; i++) {
      await new Promise(r => setTimeout(r, 500));
      up = await fetch(`${base}/api/dashboard`).then(r => r.ok).catch(() => false);
    }
    assert.ok(up, `the server didn't answer. Its output:\n${out}`);
    const dash = await (await fetch(`${base}/api/dashboard`)).json();
    assert.ok(Array.isArray(dash.chores), 'dashboard has chores');
    assert.ok(dash.weather !== undefined, 'dashboard has weather');
    const setup = await (await fetch(`${base}/setup`)).text();
    assert.match(setup, /Family Dashboard setup/);
    assert.match(setup, /Updates/);
    const page = await (await fetch(`${base}/`)).text();
    assert.match(page, /web\/app\.js/, 'web dashboard page is served');
    assert.equal((await fetch(`${base}/web/app.js`)).status, 200);
    const peek = await (await fetch(`${base}/api/dashboard?who=nobody&wx=grandma`)).json();
    assert.equal(peek.selectedWxLoc, 'grandma', 'web can look at another city');
    const after = await (await fetch(`${base}/api/dashboard`)).json();
    assert.notEqual(after.selectedWxLoc, 'grandma', 'looking from the web does not change the TV');
    const map = await fetch(`${base}/api/map/full`);
    assert.equal(map.status, 200);
    const mapJson = await map.json();
    assert.ok(mapJson.tiles.length > 0 && mapJson.pins.some(p => p.kind === 'home'), 'map has tiles and a home pin');
  } finally {
    child.kill();
    fs.rmSync(data, { recursive: true, force: true });
  }
});

await test('music: Spotify and AirPlay reach the TVs as one MP3 stream', async () => {
  const { createMusic, airplayMetaParser, spotifyStatus, cleanName, PcmSource } = await import('../music.js');
  // the pieces first
  const items = [];
  const feed = airplayMetaParser((i) => items.push(i));
  const hex = (w) => Buffer.from(w, 'latin1').toString('hex');
  feed(`<item><type>${hex('core')}</type><code>${hex('minm')}</code><length>5</length>\n<data encoding="base64">\nSGVs`);
  feed(`bG8=</data></item>\n<item><type>${hex('ssnc')}</type><code>${hex('pbeg')}</code><length>0</length></item>`);
  assert.equal(items.length, 2);
  assert.equal(items[0].code, 'minm'); assert.equal(items[0].data.toString(), 'Hello');
  assert.equal(items[1].type, 'ssnc'); assert.equal(items[1].data, null);
  assert.deepEqual(spotifyStatus({ paused: false, track: { name: 'X', artist_names: ['A', 'B'], album_cover_url: 'http://insecure' } }), { playing: true, title: 'X', artist: 'A, B', album: '', art: '' });
  assert.equal(spotifyStatus({}).playing, false);
  assert.equal(cleanName('  Kitchen <script> "TV"  '), 'Kitchen script TV');
  // a source holds only whole samples, and asks its program to wait when full
  const s = new PcmSource('x');
  let paused = 0;
  s.stream = { pause: () => paused++, resume: () => {} };
  s.push(Buffer.alloc(7)); assert.equal(s.bytes, 4);
  s.push(Buffer.alloc(44100 * 4 * 2)); assert.equal(paused, 1);

  // the real thing, with stand-ins for the two programs
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-music-'));
  const fakes = path.join(root, 'test', 'fakes');
  const logs = [];
  const music = createMusic({
    file: path.join(data, 'music.json'), dataDir: data, log: (m) => logs.push(m),
    find: (program) => path.join(fakes, program), apiPort: 3680 + Math.floor(Math.random() * 200)
  });
  const express = (await import('express')).default;
  const app = express();
  app.get('/stream', (req, res) => music.stream(req, res));
  app.get('/art', (req, res) => music.art(req, res));
  const srv = app.listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    assert.equal(music.summary(), null, 'off until turned on');
    music.apply({ enabled: true, name: 'Test Speaker' });
    assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'music.json'), 'utf8')).name, 'Test Speaker');
    await new Promise(r => setTimeout(r, 4000));
    const st = music.status();
    assert.ok(st.sources.spotify.running && st.sources.airplay.running, `both running: ${JSON.stringify(st)} ${logs.join(' | ')}`);
    const sum = music.summary();
    assert.equal(sum.playing, true);
    assert.ok(['spotify', 'airplay'].includes(sum.source));
    // a TV listens for two seconds: real MP3 frames, about the right amount
    const ctl = new AbortController();
    const r = await fetch(`${base}/stream`, { signal: ctl.signal });
    assert.equal(r.headers.get('content-type'), 'audio/mpeg');
    const reader = r.body.getReader();
    let got = 0, first = null;
    const until = Date.now() + 2000;
    while (Date.now() < until) { const { value } = await reader.read(); if (!value) break; if (!first) first = value; got += value.length; }
    ctl.abort();
    assert.ok(first[0] === 0xff && (first[1] & 0xe0) === 0xe0, 'starts on an MP3 frame');
    assert.ok(got > 160000 / 8 * 1.5 && got < 160000 / 8 * 5, `about 2 s of 160 kbps MP3 (got ${got} bytes)`);
    // AirPlay's song details and cover came through its pipe
    assert.equal(music._meta.airplay.title, 'AirPlay Song');
    assert.equal(music._meta.airplay.artist, 'AirPlay Artist');
    assert.equal((await fetch(`${base}/art`)).status, 200);
    // Spotify's details and the remote's buttons
    await new Promise(r => setTimeout(r, 2200));
    assert.equal(music._meta.spotify.title, 'Song 1');
    assert.equal(music._meta.spotify.artist, 'Band A, Band B');
    music._sources.airplay.lastDataAt = 0; // pretend the iPhone stopped, so Spotify is the one playing
    const killAir = music.status();
    assert.ok(killAir);
    // turning AirPlay off leaves Spotify playing
    const spotifyBefore = music._procs.spotify.child.pid;
    music.apply({ airplay: false });
    await new Promise(r => setTimeout(r, 5000));
    assert.equal(music.status().sources.airplay.running, false);
    // the restarted Spotify is the only one, and the server tracks it
    const live = (await import('child_process')).execSync('ps -eo pid,args').toString().split('\n').filter(l => l.includes('fakes/go-librespot') && l.includes(data));
    assert.equal(live.length, 1, live.join('\n'));
    assert.notEqual(music._procs.spotify.child.pid, spotifyBefore);
    assert.equal(music.summary().source, 'spotify');
    await music.control('next');
    const calls = fs.readFileSync(path.join(data, 'music', 'spotify', 'calls.log'), 'utf8');
    assert.ok(calls.includes('POST /player/next'), 'skip reached Spotify');
    music.apply({ enabled: false });
    assert.equal(music.summary(), null);
  } finally {
    music.stop();
    srv.close();
    fs.rmSync(data, { recursive: true, force: true });
  }
});

if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
console.log('\nall passed');
process.exit(0);
