// Each TV gets its own layout. A TV says who it is with ?tv=<its id> when it asks for the
// dashboard (the Roku from version 4.5, the TV page from server 5.11), the server
// remembers it, and a parent names it ("Kitchen", "Bedroom") and picks a layout
// profile for it, on the setup page now and in the app's TV tab later.
//
// Stored in tvs.json next to config.txt, and mirrored to the family's Firebase
// (config/tvs) so the app can edit it. Browsers that don't say they're a TV aren't listed.

import fs from 'fs';

/** The cards a Home screen can show, in their usual order. */
export const CARDS = [
  { id: 'next', name: 'Next up' },
  { id: 'today', name: "Today's schedule" },
  { id: 'weather', name: 'Weather' },
  { id: 'travel', name: 'Bus and travel' },
  { id: 'chores', name: 'Chores and bounties' },
  { id: 'todos', name: 'To-dos' },
  { id: 'groceries', name: 'Grocery list' },
  { id: 'meals', name: 'Meal plan' },
  { id: 'home', name: 'Home (Home Assistant)' }
];
/** The screens a TV can open from Home. */
export const SECTIONS = [
  { id: 'calendar', name: 'Calendar' },
  { id: 'weather', name: 'Weather' },
  { id: 'travel', name: 'Travel' },
  { id: 'chores', name: 'Chores' },
  { id: 'lists', name: 'Lists (to-dos, groceries, meals)' },
  { id: 'home', name: 'Home (Home Assistant)' }
];
const CARD_IDS = CARDS.map(c => c.id);
const SECTION_IDS = SECTIONS.map(s => s.id);

/** Three to start from. Parents can change them or add their own. */
export const BUILT_IN_PROFILES = {
  house: { name: 'Whole house', cards: [...CARD_IDS], sections: [...SECTION_IDS], privateTodosOf: [] },
  parents: { name: 'Parents', cards: ['next', 'today', 'weather', 'todos', 'groceries', 'meals', 'home'], sections: ['calendar', 'weather', 'lists', 'home'], privateTodosOf: [] },
  kids: { name: 'Kids', cards: ['next', 'today', 'weather', 'travel', 'chores', 'meals'], sections: ['calendar', 'weather', 'travel', 'chores'], privateTodosOf: [] }
};
export const DEFAULT_PROFILE = 'house';

const cleanId = (v) => (/^[A-Za-z0-9_-]{4,64}$/.test(String(v || '')) ? String(v) : null);
const clip = (s, n) => String(s ?? '').trim().slice(0, n);

/** A profile as stored, checked: known cards and sections only, in a sensible order. */
export function cleanProfile(p, fallbackName = 'Layout') {
  const cards = (Array.isArray(p?.cards) ? p.cards : []).map(String).filter((c, i, a) => CARD_IDS.includes(c) && a.indexOf(c) === i);
  const sections = (Array.isArray(p?.sections) ? p.sections : []).map(String).filter((c, i, a) => SECTION_IDS.includes(c) && a.indexOf(c) === i);
  return {
    name: clip(p?.name, 40) || fallbackName,
    cards: cards.length ? cards : ['next', 'today'],
    sections,
    privateTodosOf: (Array.isArray(p?.privateTodosOf) ? p.privateTodosOf : []).map(x => clip(x, 64)).filter(Boolean).slice(0, 6),
    // plays the server's music (Spotify, AirPlay) when something is playing; on unless turned off
    music: p?.music !== false
  };
}

function emptyState() {
  return { displays: {}, profiles: JSON.parse(JSON.stringify(BUILT_IN_PROFILES)), updatedAt: 0 };
}

export function createDisplays({ file, log = console.log, now = () => Date.now() }) {
  let state = emptyState();
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    state = { displays: j.displays || {}, profiles: { ...emptyState().profiles, ...(j.profiles || {}) }, updatedAt: Number(j.updatedAt) || 0 };
  } catch (e) { /* first run */ }
  let cloudRef = null;
  let pushTimer = null;

  function save({ edited = false, soon = false } = {}) {
    if (edited) state.updatedAt = now();
    try { fs.writeFileSync(file, JSON.stringify(state, null, 2) + '\n'); } catch (e) { log(`[TVs] Couldn't save tvs.json: ${e.message}`); }
    if (cloudRef) {
      // a little later, so a burst of changes is one write
      clearTimeout(pushTimer);
      pushTimer = setTimeout(() => {
        cloudRef.set({ ...state, by: 'server' }).catch(e => log(`[TVs] Couldn't share TV layouts with the app: ${e.message}`));
      }, edited || soon ? 500 : 5000);
      pushTimer.unref?.();
    }
  }

  function defaultName(kind, model) {
    const base = clip(model, 40) || (kind === 'roku' ? 'Roku' : kind === 'android-tv' ? 'Android TV' : 'TV');
    const taken = new Set(Object.values(state.displays).map(d => d.name));
    if (!taken.has(base)) return base;
    for (let i = 2; ; i++) if (!taken.has(`${base} ${i}`)) return `${base} ${i}`;
  }

  return {
    get state() { return state; },

    /**
     * Called for every dashboard request. Returns this TV's record and its layout,
     * or null when the request isn't from a TV (a phone or a browser tab).
     */
    seen(query = {}, ip = '') {
      const id = cleanId(query.tv);
      if (!id) return null;
      const t = now();
      let d = state.displays[id];
      if (!d) {
        const kind = ['roku', 'tv-page', 'android-tv'].includes(String(query.tvKind)) ? String(query.tvKind) : 'tv-page';
        d = state.displays[id] = { name: defaultName(kind, query.tvModel), kind, model: clip(query.tvModel, 60), profile: DEFAULT_PROFILE, firstSeen: t, lastSeen: t, ip: clip(ip, 45) };
        log(`[TVs] New TV: ${d.name}. Name it and pick its layout on the setup page.`);
        save({ edited: true });
      } else if (t - (d.lastSeen || 0) > 10 * 60000 || d.ip !== clip(ip, 45)) {
        // remembering when it was last on, without writing every 20 seconds
        d.lastSeen = t; d.ip = clip(ip, 45);
        save();
      }
      const pid = state.profiles[d.profile] ? d.profile : DEFAULT_PROFILE;
      return { id, name: d.name, profileId: pid, profile: cleanProfile(state.profiles[pid] || BUILT_IN_PROFILES.house) };
    },

    list() {
      return Object.entries(state.displays).map(([id, d]) => ({ id, ...d })).sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
    },

    setDisplay(id, { name, profile } = {}) {
      const d = state.displays[id];
      if (!d) return false;
      if (name !== undefined && clip(name, 40)) d.name = clip(name, 40);
      if (profile !== undefined && state.profiles[profile]) d.profile = profile;
      save({ edited: true });
      return true;
    },

    removeDisplay(id) {
      if (!state.displays[id]) return false;
      delete state.displays[id];
      save({ edited: true });
      return true;
    },

    /** Adds or changes a profile. Returns its id. */
    saveProfile(id, data) {
      const pid = cleanId(id) || `p${now().toString(36)}`;
      state.profiles[pid] = cleanProfile(data, state.profiles[pid]?.name || 'New layout');
      save({ edited: true });
      return pid;
    },

    /** Built-in profiles can't be removed; TVs using a removed one go back to the whole house. */
    removeProfile(id) {
      if (BUILT_IN_PROFILES[id] || !state.profiles[id]) return false;
      delete state.profiles[id];
      for (const d of Object.values(state.displays)) if (d.profile === id) d.profile = DEFAULT_PROFILE;
      save({ edited: true });
      return true;
    },

    /**
     * Shares the TV list with the app through Firebase, and takes the app's edits
     * (names, layouts) when they're newer than ours. When it was last on stays ours.
     */
    attachCloud(root) {
      cloudRef = root.collection('config').doc('tvs');
      cloudRef.onSnapshot((doc) => {
        const remote = doc.exists ? doc.data() : null;
        if (!remote) { save({ soon: true }); return; }
        if (remote.by === 'server' || Number(remote.updatedAt || 0) <= state.updatedAt) return;
        const profiles = { ...emptyState().profiles };
        for (const [pid, p] of Object.entries(remote.profiles || {})) if (cleanId(pid)) profiles[pid] = cleanProfile(p);
        for (const [id, rd] of Object.entries(remote.displays || {})) {
          const d = state.displays[id];
          if (!d) continue;
          if (clip(rd?.name, 40)) d.name = clip(rd.name, 40);
          if (profiles[rd?.profile]) d.profile = rd.profile;
        }
        // a TV the app removed
        for (const id of Object.keys(state.displays)) if (!(remote.displays || {})[id]) delete state.displays[id];
        state.profiles = profiles;
        state.updatedAt = Number(remote.updatedAt);
        log('[TVs] Took TV layout changes from the app.');
        save();
      }, (err) => log(`[TVs] Lost the connection for TV layouts: ${err.message}`));
      // ours goes up right away unless the app's copy was newer (handled above)
      save({ soon: true });
    }
  };
}

// ---- lists for the TV: to-dos, groceries, the meal plan --------------------------------------

/**
 * What a TV may show from the family's lists.
 * Private to-dos only for the parents its layout allows (privateTodosOf).
 * Overdue to-dos simply show as today's, with no "overdue" label.
 */
export function buildLists({ todos = [], groceries = [], meals = [], users = [], profile = BUILT_IN_PROFILES.house, now = new Date(), isoOf, dayName }) {
  const nameOf = (id) => users.find(u => u.id === id)?.name || '';
  const todayIso = isoOf(now);
  const endOfToday = (() => { const d = new Date(now); d.setHours(23, 59, 59, 999); return d.getTime(); })();
  const allowedPrivate = new Set(profile.privateTodosOf || []);
  const open = todos.filter(t => t.title && !t.done && (!t.private || allowedPrivate.has(t.ownerId)));
  const todo = (t) => ({ id: t.id, title: String(t.title), who: t.ownerId ? nameOf(t.ownerId) || 'Parent' : 'Both', private: Boolean(t.private) });
  const today = open.filter(t => t.dueAt && Number(t.dueAt) <= endOfToday).sort((a, b) => a.dueAt - b.dueAt).map(todo);
  const anytime = open.filter(t => !t.dueAt).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)).map(todo);

  const toBuy = groceries.filter(g => g.name && !g.done).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)).map(g => ({ id: g.id, name: String(g.name) }));

  const week = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(now); d.setDate(d.getDate() + i);
    const iso = isoOf(d);
    const label = i === 0 ? 'Tonight' : i === 1 ? 'Tomorrow' : dayName(d);
    const planned = meals.filter(m => m.date === iso && m.name)
      .map(m => ({ meal: String(m.meal || 'dinner'), name: String(m.name), time: m.time || null }));
    week.push({ date: iso, label, meals: planned });
  }
  return {
    todos: { today, anytime, count: today.length + anytime.length },
    groceries: { toBuy, count: toBuy.length },
    meals: { week, tonight: week[0].meals, today: todayIso }
  };
}
