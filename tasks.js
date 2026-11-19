// Chores and parent to-dos that belong on the calendar.
//
// Shown on the agenda:
//   - a one-time chore with a due date, on that day (at its time, if it has one)
//   - a repeating chore with a time of day, on each of its days this week
//     (for example "Mon-Fri 7:15 AM: make your bed")
//   - a parent to-do with a due date, on that day; overdue ones on today.
//     Private to-dos never leave the phone of the parent who wrote them.
//   - a planned meal ("Dinner: Tacos"), on its day, today and later
// Finished items drop off. Chores waiting for a parent's OK stay, marked.

const DAY = 86400000;

/** "07:15" -> { h: 7, m: 15 } */
function parseTime(text) {
  const m = String(text || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h < 24 && min < 60 ? { h, m: min } : null;
}

/**
 * Builds calendar-shaped items. `fmt` holds the server's time-zone helpers so
 * these line up exactly with events from the calendar feeds.
 */
export function buildTaskEvents({ chores = [], todos = [], meals = [], users = [], memberForUser, fmt, now = new Date(), routineDays = 7 }) {
  const { toNyIsoDate, getNyHourMinute, wkFmt, monShortFmt, monFullFmt, dateLblFmt, timeLblFmt } = fmt;
  const out = [];
  const todayIso = toNyIsoDate(now);
  const nameOf = (id) => users.find(u => u.id === id)?.name || '';

  // a moment on a calendar day in the household's time zone
  const at = (iso, time) => {
    const [y, mo, d] = iso.split('-').map(Number);
    const wantH = time ? time.h : 12;
    const wantM = time ? time.m : 0;
    let t = Date.UTC(y, mo - 1, d, wantH, wantM);
    for (let i = 0; i < 3; i++) {
      const gotIso = toNyIsoDate(new Date(t));
      const got = getNyHourMinute(new Date(t));
      const dayShift = (Date.parse(`${gotIso}T00:00:00Z`) - Date.parse(`${iso}T00:00:00Z`)) / 60000;
      const diff = (wantH * 60 + wantM) - (got.h * 60 + got.m) - dayShift;
      if (diff === 0) break;
      t += diff * 60000;
    }
    return new Date(t);
  };

  const weekdayOf = (iso) => new Date(`${iso}T12:00:00Z`).getUTCDay();
  const addDays = (iso, n) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);

  const item = ({ iso, time, title, kind, id, memberKey, pending = false, overdue = false }) => {
    const start = at(iso, time);
    const wk = wkFmt.format(start).toUpperCase();
    const dayNum = String(Number(iso.split('-')[2]));
    const mon = monShortFmt.format(start).toUpperCase();
    return {
      title: title + (pending ? ' (waiting for OK)' : '') + (overdue ? ' (overdue)' : ''),
      location: '',
      description: '',
      startMs: start.getTime(),
      endMs: start.getTime() + (time ? 900000 : DAY),
      isAllDay: !time,
      sourceType: 'tasks',
      isoDate: iso,
      monthHeader: monFullFmt.format(start).toUpperCase(),
      dayBadge: `${wk} ${dayNum}`,
      shortDate: `${mon} ${dayNum} (${wk})`,
      dateLabel: dateLblFmt.format(start),
      timeLabel: time ? timeLblFmt.format(start) : 'ALL DAY',
      kind,
      taskId: id,
      memberKey,
      pending
    };
  };

  const memberKeyFor = (userId) => {
    if (!userId) return null;
    const m = memberForUser(userId, nameOf(userId));
    return m ? m.id : null;
  };

  for (const c of chores) {
    const repeat = c.repeat || 'NONE';
    const time = parseTime(c.timeOfDay);
    const memberKey = memberKeyFor(c.assignedTo);
    const pending = c.status === 'PENDING';
    if (repeat === 'NONE') {
      if (!c.dueAt || c.status === 'COMPLETED') continue;
      const iso = toNyIsoDate(new Date(Number(c.dueAt)));
      const overdue = iso < todayIso;
      out.push(item({ iso: overdue ? todayIso : iso, time: overdue ? null : time, title: c.title || 'Chore', kind: 'chore', id: c.id, memberKey, pending, overdue }));
      continue;
    }
    if (!time) continue; // repeating chores without a time stay on the Chores screen only
    const days = Array.isArray(c.days) ? c.days.map(Number).filter(d => d >= 0 && d <= 6) : [];
    const doneIso = c.lastCompletedAt ? toNyIsoDate(new Date(Number(c.lastCompletedAt))) : '';
    for (let i = 0; i < routineDays; i++) {
      const iso = addDays(todayIso, i);
      const wd = weekdayOf(iso);
      if (repeat === 'DAILY' && days.length && !days.includes(wd)) continue;
      if (repeat === 'WEEKLY' && (!days.length || days[0] !== wd)) continue;
      if (i === 0 && doneIso === todayIso && !pending) continue; // done today
      out.push(item({ iso, time, title: c.title || 'Chore', kind: 'chore', id: c.id, memberKey, pending: i === 0 && pending }));
    }
  }

  for (const t of todos) {
    if (t.done || t.private || !t.dueAt) continue;
    const iso = toNyIsoDate(new Date(Number(t.dueAt)));
    const overdue = iso < todayIso;
    out.push(item({
      iso: overdue ? todayIso : iso,
      time: overdue ? null : parseTime(t.timeOfDay),
      title: t.title || 'To-do',
      kind: 'todo',
      id: t.id,
      memberKey: memberKeyFor(t.ownerId),
      overdue
    }));
  }
  for (const m of meals) {
    const iso = String(m.date || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso) || iso < todayIso || !m.name) continue;
    const which = MEAL_NAMES[String(m.meal || 'dinner').toLowerCase()] || 'Dinner';
    out.push(item({ iso, time: parseTime(m.time), title: `${which}: ${m.name}`, kind: 'meal', id: m.id, memberKey: null }));
  }
  return out;
}

const MEAL_NAMES = { breakfast: 'Breakfast', lunch: 'Lunch', dinner: 'Dinner' };
