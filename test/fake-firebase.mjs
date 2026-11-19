// In-memory stand-in for the parts of firebase-admin the server uses.
// Data is mirrored to FAKE_FIREBASE_DB (a JSON file of { "path/to/doc": {...} })
// so a test can read what the server wrote, and edit the file to play the app.
import fs from 'fs';

const FILE = process.env.FAKE_FIREBASE_DB;
let store = new Map();
const listeners = new Set();
let writing = false;

function load() {
  try { store = new Map(Object.entries(JSON.parse(fs.readFileSync(FILE, 'utf8')))); } catch (e) { store = new Map(); }
}
function save() {
  if (!FILE) return;
  writing = true;
  fs.writeFileSync(FILE, JSON.stringify(Object.fromEntries(store), null, 1));
  setTimeout(() => { writing = false; }, 50);
}
load();
if (FILE) {
  fs.watchFile(FILE, { interval: 200 }, () => {
    if (writing) return;
    load();
    notify();
  });
}

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
function notify() {
  setImmediate(() => { for (const l of [...listeners]) l(); });
}

class DocSnap {
  constructor(path, data) { this.ref = new DocRef(path); this.id = path.split('/').pop(); this._d = data; this.exists = data !== undefined; }
  data() { return clone(this._d); }
  get(field) { return this._d?.[field]; }
}

class DocRef {
  constructor(path) { this.path = path; this.id = path.split('/').pop(); }
  collection(name) { return new CollectionRef(`${this.path}/${name}`); }
  async get() { return new DocSnap(this.path, clone(store.get(this.path))); }
  async set(data, opts = {}) {
    const prev = opts.merge ? (store.get(this.path) || {}) : {};
    store.set(this.path, { ...prev, ...clone(data) });
    save(); notify();
  }
  async update(data) {
    if (!store.has(this.path)) throw new Error(`NOT_FOUND: ${this.path}`);
    store.set(this.path, { ...store.get(this.path), ...clone(data) });
    save(); notify();
  }
  async delete() { store.delete(this.path); save(); notify(); }
  onSnapshot(cb) {
    let last;
    const fire = () => {
      const now = JSON.stringify(store.get(this.path) ?? null);
      if (now === last) return;
      last = now;
      cb(new DocSnap(this.path, clone(store.get(this.path))));
    };
    listeners.add(fire);
    fire();
    return () => listeners.delete(fire);
  }
}

class Query {
  constructor(path, filters = []) { this.path = path; this.filters = filters; }
  where(field, op, value) { return new Query(this.path, [...this.filters, [field, op, value]]); }
  _docs() {
    const prefix = `${this.path}/`;
    return [...store.entries()]
      .filter(([p]) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'))
      .filter(([, d]) => this.filters.every(([f, op, v]) => (
        op === '==' ? d[f] === v : op === '<' ? d[f] < v : op === '>' ? d[f] > v : op === '<=' ? d[f] <= v : op === '>=' ? d[f] >= v : false)))
      .map(([p, d]) => new DocSnap(p, clone(d)));
  }
  async get() { const docs = this._docs(); return { docs, empty: docs.length === 0, size: docs.length }; }
  onSnapshot(cb) {
    let last;
    let seen = new Set();
    const fire = () => {
      const docs = this._docs();
      const now = JSON.stringify(docs.map(d => [d.id, d._d]));
      if (now === last) return;
      last = now;
      const ids = new Set(docs.map(d => d.id));
      const changes = docs.filter(d => !seen.has(d.id)).map(doc => ({ type: 'added', doc }));
      seen = ids;
      cb({ docs, empty: docs.length === 0, size: docs.length, docChanges: () => changes });
    };
    listeners.add(fire);
    fire();
    return () => listeners.delete(fire);
  }
}

class CollectionRef extends Query {
  doc(id) { return new DocRef(`${this.path}/${id || Math.random().toString(36).slice(2, 12)}`); }
}

export function firestore() {
  return {
    collection: (name) => new CollectionRef(name),
    batch() {
      const ops = [];
      const b = {
        set: (ref, data, opts) => { ops.push(() => ref.set(data, opts)); return b; },
        update: (ref, data) => { ops.push(() => ref.update(data)); return b; },
        delete: (ref) => { ops.push(() => ref.delete()); return b; },
        commit: async () => { for (const op of ops) await op(); }
      };
      return b;
    },
    async runTransaction(fn) {
      const ops = [];
      const tx = {
        get: (ref) => ref.get(),
        set: (ref, data, opts) => { ops.push(() => ref.set(data, opts)); return tx; },
        update: (ref, data) => { ops.push(() => ref.update(data)); return tx; },
        delete: (ref) => { ops.push(() => ref.delete()); return tx; }
      };
      const out = await fn(tx);
      for (const op of ops) await op();
      return out;
    }
  };
}

export const revoked = [];
export function auth() {
  return {
    createCustomToken: async (uid, claims) => `fake-token.${uid}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}`,
    listUsers: async () => ({ users: [] }),
    revokeRefreshTokens: async (uid) => { revoked.push(uid); console.log(`[fake] revoked ${uid}`); }
  };
}

let rulesText = '';
export function rules() {
  return {
    getFirestoreRuleset: async () => ({ source: [{ name: 'firestore.rules', content: rulesText }] }),
    releaseFirestoreRulesetFromSource: async (src) => { rulesText = String(src); console.log('[fake] rules published'); }
  };
}

export function credential() {
  return { getAccessToken: async () => { throw new Error('no network in the test sandbox'); } };
}
