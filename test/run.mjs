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

if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
console.log('\nall passed');
process.exit(0);
