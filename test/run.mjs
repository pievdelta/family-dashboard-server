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
