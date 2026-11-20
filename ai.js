// AI features with the family's own key: meal ideas and the brain dump.
//
// The phone app can't reach this server away from home, so requests travel
// through the family's Firebase:
//
//   households/{id}/aiRequests/{requestId}
//     app writes:    { type: 'meals' | 'braindump', input: {...}, createdBy, createdAt, status: 'new' }
//     server writes: { status: 'working' }, then { status: 'done', result } or { status: 'error', error }
//
// Nothing is saved from a result until a parent confirms it in the app.
// The key stays in config.txt on this computer and is never sent to phones.

const PROVIDERS = {
  gemini: { name: 'Gemini', model: 'gemini-flash-latest' },
  claude: { name: 'Claude', model: 'claude-haiku-5-5' },
  openai: { name: 'OpenAI', model: 'gpt-5-mini' }
};
const MAX_PER_HOUR = 30;
const STALE_MS = 10 * 60 * 1000;

/** Which provider and key to use, from config.txt. An older GEMINI_API_KEY line still works. */
export function aiSettings(env = process.env) {
  let provider = String(env.AI_PROVIDER || '').trim().toLowerCase();
  let key = String(env.AI_API_KEY || '').trim();
  if (!key && String(env.GEMINI_API_KEY || '').trim()) {
    key = String(env.GEMINI_API_KEY).trim();
    provider = provider || 'gemini';
  }
  if (!PROVIDERS[provider]) provider = key ? 'gemini' : '';
  const model = String(env.AI_MODEL || '').trim() || (provider ? PROVIDERS[provider].model : '');
  return { configured: Boolean(key && provider), provider, providerName: provider ? PROVIDERS[provider].name : '', model, key };
}

/** Pulls the first JSON object out of a model's reply (it may wrap it in ``` fences). */
export function parseJsonReply(text) {
  const s = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try { return JSON.parse(s); } catch (e) { /* fall through */ }
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) return JSON.parse(s.slice(start, end + 1));
  throw new Error('The AI answered in a way the server could not read. Try again.');
}

async function postJson(url, headers, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* not JSON */ }
  if (!res.ok) {
    const msg = json?.error?.message || json?.error?.type || text.slice(0, 200);
    if (res.status === 401 || res.status === 403) throw new Error(`The AI key was refused (${msg}). Check it on the setup page.`);
    if (res.status === 429) throw new Error('The AI service says the key is out of free requests for now. Try again later.');
    throw new Error(`The AI service answered ${res.status}: ${msg}`);
  }
  return json;
}

/** One request to the configured AI. Returns the parsed JSON object it answered with. */
export async function askAI(settings, system, prompt) {
  const { provider, model, key } = settings;
  let text = '';
  if (provider === 'gemini') {
    const j = await postJson(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, { 'x-goog-api-key': key }, {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0.7 }
    });
    text = (j?.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
  } else if (provider === 'claude') {
    const j = await postJson('https://api.anthropic.com/v1/messages', { 'x-api-key': key, 'anthropic-version': '2023-06-01' }, {
      model, max_tokens: 2000, system: system + '\nAnswer with only the JSON object.', messages: [{ role: 'user', content: prompt }]
    });
    text = (j?.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  } else if (provider === 'openai') {
    const j = await postJson('https://api.openai.com/v1/chat/completions', { Authorization: `Bearer ${key}` }, {
      model, response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }]
    });
    text = j?.choices?.[0]?.message?.content || '';
  } else {
    throw new Error('No AI is connected. Add a key on the setup page.');
  }
  return parseJsonReply(text);
}

// ---- the two features ------------------------------------------------------------------

const clip = (s, n) => String(s ?? '').trim().slice(0, n);
const strList = (v, n = 20, len = 80) => (Array.isArray(v) ? v : []).map(x => clip(x, len)).filter(Boolean).slice(0, n);

// How adventurous to be, chosen in the app.
const VIBES = {
  favorites: 'Stick to what the kids already eat: build every dinner around their listed foods.',
  stretch: 'Mostly familiar dinners, each with one small new thing. Every kid should still find something they eat on the plate.',
  adventurous: 'Try dishes the family probably hasn\'t made before. The kids\' foods are not limits tonight; for each dinner, say in "why" which of their foods could go on the side.'
};

export function mealPrompt({ kids, groceries, note, today, planned = [], minutes = null, vibe = 'favorites', allergies = [] }) {
  const v = VIBES[vibe] ? vibe : 'favorites';
  const system = 'You suggest easy family dinners. Be practical: weeknight-friendly, common ingredients, nothing fancy unless asked. ' +
    (v === 'adventurous' ? 'The family wants something new tonight. ' : 'Respect what each kid will eat. ') +
    (allergies.length ? 'Food allergies are strict: never suggest a dinner, side, sauce or ingredient that contains a listed allergen, even as an option. ' : '') +
    'Reply with JSON only.';
  const lines = [
    `Today is ${today}.`,
    kids.length ? 'The kids:' : '',
    ...kids.map(k => `- ${k.name}${k.safeFoods ? `: will reliably eat ${k.safeFoods}` : ''}${k.interests ? ` (into ${k.interests})` : ''}`),
    allergies.length ? `FOOD ALLERGIES, never use these or anything made with them: ${allergies.map(a => `${a.name}: ${a.items.join(', ')}`).join('; ')}.` : '',
    groceries.toBuy.length ? `Already on the grocery list: ${groceries.toBuy.join(', ')}.` : '',
    groceries.recent.length ? `Recently bought: ${groceries.recent.join(', ')}.` : '',
    groceries.pantry?.length ? `Pantry staples they always have: ${groceries.pantry.join(', ')}.` : '',
    planned.length ? `Already planned (don't repeat these): ${planned.join('; ')}.` : '',
    minutes ? `Time to cook: ${minutes} minutes at most, including prep.` : '',
    VIBES[v],
    note ? `The parent adds: ${note}` : '',
    '',
    'Suggest 4 dinners. For each, list the main ingredients it needs. Prefer dinners that use what they already have (recently bought and pantry staples). Mark ingredients the family probably needs to buy (not on the list, not recently bought, not a pantry staple) in "toBuy".',
    'JSON shape: {"ideas":[{"name":"","why":"one short sentence, mention which kid it works for","minutes":30,"ingredients":[""],"toBuy":[""]}]}'
  ];
  return { system, prompt: lines.filter(l => l !== '').join('\n') };
}

// Words that usually mean an allergen is in a dish. A second check after the AI, not a
// guarantee: it flags, it doesn't promise. Matched as whole words, so "eggplant" isn't egg.
const ALLERGEN_WORDS = {
  peanut: ['peanut', 'peanuts', 'peanut butter', 'satay'],
  'tree nut': ['almond', 'almonds', 'cashew', 'cashews', 'walnut', 'walnuts', 'pecan', 'pecans', 'pistachio', 'pistachios', 'hazelnut', 'hazelnuts', 'macadamia', 'pine nuts', 'pesto', 'nutella', 'praline'],
  milk: ['milk', 'cheese', 'cheddar', 'mozzarella', 'parmesan', 'cream', 'yogurt', 'yoghurt', 'butter', 'ghee', 'alfredo', 'queso', 'ricotta', 'ranch', 'sour cream', 'mac and cheese'],
  egg: ['egg', 'eggs', 'mayo', 'mayonnaise', 'aioli', 'meringue', 'frittata', 'omelet', 'omelette', 'quiche'],
  wheat: ['wheat', 'flour', 'bread', 'breadcrumbs', 'pasta', 'spaghetti', 'noodles', 'tortilla', 'tortillas', 'bun', 'buns', 'pizza', 'couscous', 'crackers', 'pancake', 'pancakes', 'waffles', 'soy sauce', 'macaroni', 'lasagna'],
  soy: ['soy', 'soy sauce', 'tofu', 'edamame', 'miso', 'tempeh', 'teriyaki'],
  fish: ['fish', 'salmon', 'tuna', 'cod', 'tilapia', 'halibut', 'trout', 'anchovy', 'anchovies', 'sardines', 'fish sauce'],
  shellfish: ['shellfish', 'shrimp', 'prawn', 'prawns', 'crab', 'lobster', 'clam', 'clams', 'mussels', 'scallops', 'oysters', 'crawfish'],
  sesame: ['sesame', 'tahini', 'hummus']
};
const ALIASES = { peanuts: 'peanut', 'tree nuts': 'tree nut', nuts: 'tree nut', dairy: 'milk', eggs: 'egg', gluten: 'wheat', 'soy beans': 'soy', soybeans: 'soy', seafood: 'shellfish' };
// "peanut butter" and the like aren't dairy
const NOT_DAIRY = /\b(peanut|almond|cashew|sunflower|apple|cocoa|shea|nut)\s+butter\b|\bcoconut (milk|cream)\b|\b(oat|almond|soy|rice) milk\b|\bcream of tartar\b|\bbutternut\b/gi;

function wordsFor(allergen) {
  const a = String(allergen).trim().toLowerCase();
  const key = ALIASES[a] || a.replace(/s$/, '');
  return [...new Set([a, ...(ALLERGEN_WORDS[key] || ALLERGEN_WORDS[a] || [])])];
}

/** "May contain peanut (Leo)" for an idea that seems to include someone's allergen, else null. */
export function allergyWarning(idea, allergies = []) {
  const raw = [idea.name, idea.why, ...(idea.ingredients || []), ...(idea.toBuy || [])].join(' | ').toLowerCase();
  const hits = [];
  for (const { name, items } of allergies) {
    for (const allergen of items) {
      const text = ['milk', 'dairy'].includes(String(allergen).toLowerCase()) ? raw.replace(NOT_DAIRY, ' ') : raw;
      const found = wordsFor(allergen).find(w => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text));
      if (found) hits.push(`${allergen.toLowerCase()} (${name})`);
    }
  }
  return hits.length ? `May contain ${[...new Set(hits)].join(', ')}. Check before you cook.` : null;
}

export function cleanMeals(json, allergies = []) {
  const ideas = (Array.isArray(json?.ideas) ? json.ideas : []).slice(0, 6).map(i => ({
    name: clip(i?.name, 80),
    why: clip(i?.why, 200),
    minutes: Number.isFinite(Number(i?.minutes)) ? Math.round(Number(i.minutes)) : null,
    ingredients: strList(i?.ingredients, 15, 60),
    toBuy: strList(i?.toBuy, 15, 60)
  })).filter(i => i.name).map(i => ({ ...i, warning: allergyWarning(i, allergies) }));
  if (!ideas.length) throw new Error('The AI didn\'t come up with any ideas. Try again, maybe with a note.');
  // ideas that look safe first
  ideas.sort((a, b) => Boolean(a.warning) - Boolean(b.warning));
  return { ideas };
}

export function brainDumpPrompt({ text, parents, kids, me, today, weekday }) {
  const system = 'You turn a busy parent\'s messy notes into a tidy list of to-dos, grocery items and calendar events. ' +
    'Only include things the notes actually say. Never invent tasks. Reply with JSON only.';
  const prompt = [
    `Today is ${weekday}, ${today}. The person writing is ${me || 'a parent'}.`,
    parents.length ? `Parents: ${parents.join(', ')}.` : '',
    kids.length ? `Kids: ${kids.join(', ')}.` : '',
    '',
    'Sort the notes below.',
    '- Things to buy go in "groceries" (just the item, like "milk").',
    '- Something happening at a specific date or time (appointments, games, parties) goes in "events" with date YYYY-MM-DD and time like "3:00 PM" or null.',
    '- Everything else someone has to do goes in "todos". "owner" is "me", "both", or a parent\'s name if the notes say who. "due" is YYYY-MM-DD or null.',
    'Turn relative dates ("next Tuesday", "tomorrow") into real dates.',
    'JSON shape: {"todos":[{"title":"","owner":"me","due":null}],"groceries":[""],"events":[{"title":"","date":"YYYY-MM-DD","time":null,"location":""}]}',
    '',
    'Notes:',
    clip(text, 4000)
  ].filter(l => l !== '').join('\n');
  return { system, prompt };
}

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
export function cleanBrainDump(json) {
  const out = {
    todos: (Array.isArray(json?.todos) ? json.todos : []).slice(0, 30).map(t => ({
      title: clip(t?.title, 120),
      owner: clip(t?.owner || 'me', 40).toLowerCase(),
      due: isDate(t?.due) ? t.due : null
    })).filter(t => t.title),
    groceries: strList(json?.groceries, 40, 60),
    events: (Array.isArray(json?.events) ? json.events : []).slice(0, 20).map(e => ({
      title: clip(e?.title, 120),
      date: isDate(e?.date) ? e.date : null,
      time: e?.time ? clip(e.time, 20) : null,
      location: clip(e?.location, 120)
    })).filter(e => e.title && e.date)
  };
  if (!out.todos.length && !out.groceries.length && !out.events.length) throw new Error('Nothing to sort out in that. Try writing a few things you need to remember.');
  return out;
}

// ---- watching for requests ---------------------------------------------------------------

/**
 * Follows aiRequests in Firebase and answers new ones. `context()` returns the
 * family details a prompt needs. Returns a status object for the health report.
 */
export function startAI({ root, settings = aiSettings(), context, ask = askAI, log = console.log }) {
  const status = { configured: settings.configured, provider: settings.provider, providerName: settings.providerName, lastError: null, lastOkAt: null };
  const recent = [];
  const handled = new Set();
  const ref = root.collection('aiRequests');

  async function handle(doc) {
    const req = doc.data() || {};
    if (handled.has(doc.id)) return;
    handled.add(doc.id);
    const fail = (msg) => doc.ref.set({ status: 'error', error: msg, finishedAt: Date.now() }, { merge: true });
    if (!settings.configured) return fail('No AI is connected. Add a key on the family server\'s setup page.');
    if (Date.now() - Number(req.createdAt || 0) > STALE_MS) return fail('This request waited too long. Try again.');
    const hourAgo = Date.now() - 3600000;
    while (recent.length && recent[0] < hourAgo) recent.shift();
    if (recent.length >= MAX_PER_HOUR) return fail(`That's ${MAX_PER_HOUR} AI requests this hour, the most this server sends. Try again later.`);
    recent.push(Date.now());

    await doc.ref.set({ status: 'working', startedAt: Date.now() }, { merge: true });
    try {
      const ctx = await context(req);
      let result;
      if (req.type === 'meals') {
        const minutes = Number(req.input?.minutes);
        const p = mealPrompt({
          ...ctx,
          note: clip(req.input?.note, 500),
          minutes: Number.isFinite(minutes) && minutes >= 5 && minutes <= 240 ? Math.round(minutes) : null,
          vibe: String(req.input?.vibe || 'favorites').toLowerCase()
        });
        result = cleanMeals(await ask(settings, p.system, p.prompt), ctx.allergies || []);
      } else if (req.type === 'braindump') {
        const p = brainDumpPrompt({ ...ctx, kids: ctx.kids.map(k => k.name), text: req.input?.text });
        result = cleanBrainDump(await ask(settings, p.system, p.prompt));
      } else {
        throw new Error('This server doesn\'t know that kind of AI request. Update it from the setup page.');
      }
      await doc.ref.set({ status: 'done', result, finishedAt: Date.now() }, { merge: true });
      status.lastOkAt = Date.now();
      status.lastError = null;
      log(`[AI] Answered a ${req.type} request with ${settings.providerName}.`);
    } catch (e) {
      status.lastError = e.message;
      log(`[AI] ${req.type} request failed: ${e.message}`);
      await fail(e.message);
    }
  }

  ref.where('status', '==', 'new').onSnapshot((snap) => {
    for (const ch of snap.docChanges()) if (ch.type === 'added') handle(ch.doc).catch(e => log(`[AI] ${e.message}`));
  }, (err) => { status.lastError = err.message; log(`[AI] Stopped listening for requests: ${err.message}`); });

  // tidy up: answered requests older than a day
  const sweep = async () => {
    try {
      const old = await ref.where('createdAt', '<', Date.now() - 86400000).get();
      for (const d of old.docs) await d.ref.delete();
    } catch (e) { /* not important */ }
  };
  setTimeout(sweep, 60000);
  setInterval(sweep, 6 * 3600000).unref?.();

  if (settings.configured) log(`[AI] Meal ideas and the brain dump are on, using ${settings.providerName} (${settings.model}).`);
  return status;
}

export const AI_PROVIDERS = PROVIDERS;
