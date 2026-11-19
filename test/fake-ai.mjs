// Stands in for a real AI in tests (FD_FAKE_AI=1): canned answers, no network, no key.
export async function fakeAsk(settings, system, prompt) {
  if (/dinners/.test(system + prompt)) {
    return { ideas: [
      { name: 'Chicken tacos', why: 'Maya loves tacos', minutes: 25, ingredients: ['chicken', 'tortillas', 'cheese'], toBuy: ['tortillas'] },
      { name: 'Pasta with butter', why: 'Safe for Leo', minutes: 15, ingredients: ['pasta', 'butter'], toBuy: [] }
    ] };
  }
  return { todos: [{ title: 'Renew car registration', owner: 'me', due: '2026-11-30' }],
    groceries: ['milk', 'eggs'],
    events: [{ title: 'Dentist for Leo', date: '2026-11-24', time: '3:00 PM', location: 'Smile Dental' }] };
}
