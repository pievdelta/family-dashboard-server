// Demo mode for the web dashboard: open the page with ?demo=1 and it shows a
// made-up family (Maya, Leo, Dana and Sam) instead of asking a server.
// The Android TV app uses this when there's no family server to find (and for
// app store reviewers). Times move with the clock, so "happening now" stays true.
// Nothing here runs unless ?demo=1 is in the address.
(function () {
  if (new URLSearchParams(location.search).get('demo') !== '1') return;

  const IDS = ['maya', 'leo', 'dana', 'work'];
  const NAMES = ['MAYA', 'LEO', 'DANA', 'SAM'];
  const COL = ['0xA855F7FF', '0xF97316FF', '0xEC4899FF', '0x38BDF8FF'];
  const FAMCOL = '0xEAB308FF';
  const TILE = '/web/demo';
  const state = { overviewMember: 'all', selectedWxLoc: 'riverside', transport: 'maya', modes: {}, cals: {}, zoom: 15 };
  const done = new Set();

  const pad = (n) => String(n).padStart(2, '0');
  const tl = (h, m) => `${h % 12 || 12}:${pad(m)} ${h < 12 ? 'AM' : 'PM'}`;
  const DAY3 = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
  const Day3 = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MON3 = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const Mon3 = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const MONTH = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];
  const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  const sameDay = (a, b) => iso(a) === iso(b);

  function badge(who) {
    if (who.length === 1) return [IDS[who[0]], NAMES[who[0]], COL[who[0]], [IDS[who[0]]]];
    if (who.length === 2) return [IDS[0], `${NAMES[0]} & ${NAMES[1]}`, FAMCOL, [IDS[0], IDS[1]]];
    return [IDS[0], 'FAMILY', FAMCOL, IDS.slice(0, 3)];
  }

  function build(now) {
    const cals = IDS.map((id, i) => ({ id, name: NAMES[i], colorHex: COL[i], enabled: state.cals[id] !== false }));
    const enabled = Object.fromEntries(cals.map(c => [c.id, c.enabled]));
    function ev(day, h, m, dur, title, loc, who, desc = '', allDay = false) {
      const d = addDays(now, day); d.setHours(h, m, 0, 0);
      const [cid, bname, color, keys] = badge(who);
      if (!keys.some(k => enabled[k])) return null;
      if (state.overviewMember !== 'all' && !keys.includes(state.overviewMember)) return null;
      return {
        title, location: loc, description: desc, startMs: d.getTime(), endMs: d.getTime() + dur * 60000, isAllDay: allDay,
        isoDate: iso(d), monthHeader: `${MONTH[d.getMonth()]} ${d.getFullYear()}`, dayBadge: `${DAY3[d.getDay()]} ${d.getDate()}`,
        shortDate: `${MON3[d.getMonth()]} ${d.getDate()} (${DAY3[d.getDay()]})`, dateLabel: `${Day3[d.getDay()]}, ${Mon3[d.getMonth()]} ${d.getDate()}`,
        timeLabel: allDay ? 'ALL DAY' : tl(h, m), calendarId: cid, calendarName: bname, colorHex: color, enabled: true, _d: d, _day: day
      };
    }
    const plan = [];
    // today's events sit around the current time, so something is always on
    const todayDefs = [['Dentist checkup', 'Smile Dental, 114 Main St', [1]], ['Staff standup', 'Video call', [3]], ['Soccer practice', 'Lakeside Park', [1]],
      ['Family dinner with Grandma and Grandpa', '', []], ['Tumbling class', 'Star Gymnastics', [2]], ['Budget review', '', [3]]];
    let k = 0;
    for (const off of [-190, -40, 35, 140, 230, 300]) {
      const t = new Date(now.getTime() + off * 60000);
      if (sameDay(t, now) && k < todayDefs.length) {
        const [title, loc, who] = todayDefs[k++];
        plan.push(ev(0, t.getHours(), Math.floor(t.getMinutes() / 5) * 5, 60, title, loc, who));
      }
    }
    plan.push(ev(0, 0, 0, 1440, 'Library books due', '', [0], '', true));
    for (const [d, h, m, title, loc, who, desc] of [
      [1, 8, 0, 'Orthodontist', 'Bright Smile Orthodontics', [1], 'Bring the retainer case'], [1, 16, 0, 'Basketball tryouts', 'Middle school gym', [0], ''],
      [1, 18, 30, 'PTA meeting', 'Maple Grove Elementary', [2], ''], [2, 0, 0, 'No School - Teacher Workday', '', [0, 1], 'ALLDAY'],
      [2, 17, 0, 'Swim lesson', 'Aquatic Center', [1], ''], [3, 9, 0, 'Quarterly planning', '100 Commerce Dr', [3], ''], [3, 19, 0, 'Movie night', '', [], ''],
      [4, 10, 0, 'Soccer game vs Comets', 'Lakeside Park', [1], 'Wear the blue jersey'], [5, 11, 0, 'Birthday party for Owen', 'Sky Zone', [0], 'Gift is in the hall closet'],
      [6, 18, 0, 'Dinner: Tacos', '', [], ''], [8, 16, 30, 'Soccer practice', 'Lakeside Park', [1], ''], [9, 7, 30, 'Band concert rehearsal', 'School auditorium', [0], ''],
      [12, 12, 0, 'Grandma visits', '', [], ''], [17, 18, 0, 'Holiday lights', 'Uptown', [], ''], [20, 14, 0, 'Winter recital', 'Community theater', [0], '']
    ]) {
      const allDay = desc === 'ALLDAY';
      plan.push(ev(d, h, m, allDay ? 1440 : 60, title, loc, who, allDay ? '' : desc, allDay));
    }
    const evs = plan.filter(Boolean).sort((a, b) => a.startMs - b.startMs);
    const nowMs = now.getTime();
    const order = (a, b) => (a.isAllDay - b.isAllDay) || (a.startMs - b.startMs);
    const pub = (e) => { const o = { ...e }; delete o._d; delete o._day; return o; };
    const todayEvents = evs.filter(e => e._day === 0 && (e.isAllDay || e.endMs > nowMs)).sort(order).slice(0, 5).map(pub);
    const upcoming = evs.filter(e => e._day > 0).slice(0, 14).map(pub);
    const weekDays = [];
    for (let i = 0; i < 7; i++) {
      const d = addDays(now, i);
      const de = evs.filter(e => e._day === i).sort(order).slice(0, 4);
      weekDays.push({ dayName: DAY3[d.getDay()], dateNum: `${MON3[d.getMonth()]} ${d.getDate()}`, isToday: i === 0, richEvents: de.map(pub), events: de.map(e => `${e.timeLabel}: ${e.title}`) });
    }
    const first = new Date(now.getFullYear(), now.getMonth(), 1);
    const start = addDays(first, -first.getDay());
    const monthCells = [];
    for (let i = 0; i < 42; i++) {
      const d = addDays(start, i);
      const ce = evs.filter(e => sameDay(e._d, d));
      monthCells.push({ dayNum: String(d.getDate()), inMonth: d.getMonth() === now.getMonth(), isToday: sameDay(d, now), preview: ce.slice(0, 2).map(e => e.title), previewColors: ce.slice(0, 2).map(e => e.colorHex) });
    }

    // weather
    const locs = [{ id: 'riverside', name: 'Riverside', lat: 39.76, lon: -89.6 }, { id: 'orlando', name: 'Orlando, FL', lat: 28.5, lon: -81.4 },
      { id: 'denver', name: 'Denver, CO', lat: 39.74, lon: -104.99 }, { id: 'chicago', name: 'Chicago, IL', lat: 41.88, lon: -87.63 }];
    const cities = { riverside: [54, 'Overcast Clouds', 'cloud', 61, 47, 70], orlando: [81, 'Clear Sky', 'sun', 84, 66, 10], denver: [51, 'Light Rain', 'rain', 58, 44, 80], chicago: [43, 'Thunderstorm', 'storm', 48, 36, 90] };
    function wx(id) {
      const [temp, condition, icon, high, low, mp] = cities[id] || cities.riverside;
      const wet = mp > 30;
      const pops = wet ? [10, 20, 45, 70, 65, 30, 15, 5] : [0, 0, 5, 10, 5, 0, 0, 0];
      const ics = wet ? ['cloud', 'cloud', 'rain', 'rain', 'rain', 'cloud', 'cloud', 'sun'] : Array(8).fill('sun');
      const hourly = [0, 1, 2, 3, 4, 5, 6, 7].map(i => {
        const h = (now.getHours() + i) % 24;
        return { time: i === 0 ? 'NOW' : `${h % 12 || 12} ${h < 12 ? 'AM' : 'PM'}`, temp: temp + [0, 1, 2, 1, -1, -3, -4, -6][i], pop: pops[i], icon: ics[i] };
      });
      const daily = [0, 1, 2, 3, 4, 5, 6].map(i => ({
        dayName: i === 0 ? 'TODAY' : DAY3[addDays(now, i).getDay()], high: high + [0, -3, 2, 4, 1, -5, -2][i], low: low + [0, -2, 1, 2, 0, -4, -3][i],
        pop: [mp, 60, 10, 5, 30, 85, 0][i], icon: ['cloud', 'rain', 'sun', 'sun', 'cloud', 'storm', 'sun'][i]
      }));
      return { temp, high, low, todayMaxPop: mp, condition, iconCode: icon, hourly, daily,
        radarBaseTiles: [...Array(9).keys()].map(i => `${TILE}/base-${i}.png`), radarOverlayTiles: [...Array(9).keys()].map(i => `${TILE}/radar-${i}.png`) };
    }

    // chores and bounties
    let chores = [['Empty the dishwasher', 5, 'POINTS', null], ['Take out trash and recycling', 10, 'POINTS', null], ['Feed the fish', 2, 'POINTS', 'leo'],
      ['Fold and put away laundry', 15, 'TIME', null], ['Vacuum the living room', 15, 'TIME', null], ['Wipe down kitchen counters', 5, 'POINTS', null],
      ['Rake leaves in the front yard', 30, 'TIME', 'maya'], ['Clean bathroom sink and mirror', 10, 'POINTS', null], ['Set the table for dinner', 3, 'POINTS', 'leo'],
      ['Water the plants', 5, 'POINTS', null], ['Wash the car', 30, 'TIME', null], ['Make your bed', 5, 'POINTS', 'maya']]
      .map(([title, amount, rewardType, who], i) => ({ id: `c${i}`, title, amount, rewardType, assignedTo: who, assignedMember: who,
        displayReward: rewardType === 'TIME' ? `+${amount}m Time` : `+${amount} ${rewardType}` }))
      .filter(c => !done.has(c.id));
    if (state.overviewMember !== 'all') chores = chores.filter(c => !c.assignedTo || c.assignedTo === state.overviewMember);
    const users = [{ id: 'maya', name: 'Maya', colorHex: COL[0], earnedTotal: 45 }, { id: 'leo', name: 'Leo', colorHex: COL[1], earnedTotal: 32 }];

    // travel
    const grid = { tiles: [...Array(9).keys()].map(i => `${TILE}/map-${i}.png`), ovPinX: 310, ovPinY: 190, bigPinX: 420, bigPinY: 255, zoom: state.zoom };
    const soon = new Date(nowMs + 35 * 60000); const leave = new Date(nowMs + 11 * 60000);
    const trip = { eventTitle: 'Soccer practice', eventTime: tl(soon.getHours(), Math.floor(soon.getMinutes() / 5) * 5), location: 'Lakeside Park', driveMins: 14,
      driveMiles: '5.2', driveLabel: '14 mins (5.2 mi)', leaveBy: tl(leave.getHours(), leave.getMinutes()), within2Hours: true, lat: 39.72, lon: -89.6 };
    const dests = [['Maple Grove Elementary', '410 Maple Ave', '8 mins (2.9 mi)', true, ''], ['Little Sprouts Preschool', '22 Oak St', '12 mins (4.6 mi)', false, 'Tue/Wed/Thu 9:15 AM - 1:00 PM'],
      ['Star Gymnastics', '900 Elm St', '11 mins (4.1 mi)', false, ''], ['Riverside Office Park', '100 Commerce Dr', '16 mins (6.3 mi)', false, 'Works from home Mon and Fri']];
    const clock = tl(now.getHours(), now.getMinutes());
    const members = IDS.map((id, i) => {
      const [primaryName, primaryAddress, label, hasBus, scheduleNote] = dests[i];
      return { id, name: NAMES[i], colorHex: COL[i], hasBus, activeMode: hasBus ? (state.modes[id] || 'BUS') : 'CAR', scheduleNote, primaryName, primaryAddress,
        primaryDriveMins: parseInt(label, 10), primaryDriveLabel: label, primaryLat: 39.75, primaryLon: -89.61,
        busStatus: hasBus ? 'Afternoon bus' : 'Car Commute', busEta: hasBus ? '6 mins' : label, nextEventTrip: i === 1 ? trip : null, ...grid };
    });
    const bus = { lat: 39.76, lng: -89.61, isActive: true, status: 'Afternoon bus', eta: '6 mins', lastUpdated: clock, distanceFt: 1450, distanceLabel: '1,500 ft away', ...grid };

    // tonight's chore on the calendar, like the real server adds them
    if (todayEvents.length) {
      todayEvents.push({ ...todayEvents[todayEvents.length - 1], title: 'Feed the fish', location: '', kind: 'chore', sourceType: 'tasks', taskId: 'c2', calendarName: 'Leo' });
    }

    return {
      dashboardTitle: 'FAMILY DASHBOARD', clockOnly: clock, overviewMember: state.overviewMember, selectedWxLoc: state.selectedWxLoc, weatherLocations: locs,
      currentTime: `${DAY3[now.getDay()]}, ${MON3[now.getMonth()]} ${pad(now.getDate())}`, todayLabel: `${DAY3[now.getDay()]}, ${MON3[now.getMonth()]} ${now.getDate()}`,
      weather: wx(state.selectedWxLoc), homeWeather: wx('riverside'), chores, users, calendars: cals, bus,
      transport: { selectedMemberId: state.transport, members }, todayEvents, calendar: upcoming,
      calendarViews: { todayEvents, list: upcoming, weekDays, monthCells, monthTitle: `${MONTH[now.getMonth()]} ${now.getFullYear()}`, calendars: cals },
      home: [
        { id: 'lock.front_door', name: 'Front door', state: 'Locked', icon: 'lock', attention: false },
        { id: 'cover.garage_door', name: 'Garage door', state: 'Open', icon: 'garage', attention: true },
        { id: 'climate.hallway', name: 'Thermostat', state: '70° · Heating', icon: 'temp', attention: false },
        { id: 'binary_sensor.back_door', name: 'Back door', state: 'Closed', icon: 'door', attention: false }
      ],
      // what a TV may show from the lists (server 5.11)
      display: new URLSearchParams(location.search).get('tv') || location.pathname === '/tv' ? { id: 'demo-tv', name: 'Living room', profileId: 'house' } : null,
      layout: { cards: ['next', 'today', 'weather', 'travel', 'chores', 'todos', 'groceries', 'meals', 'home'], sections: ['calendar', 'weather', 'travel', 'chores', 'lists', 'home'] },
      lists: {
        todos: { today: [{ id: 't1', title: 'Call the plumber', who: 'Dana', private: false }, { id: 't2', title: 'Sign the field trip form', who: 'Both', private: false }],
          anytime: [{ id: 't3', title: 'Renew car registration', who: 'Sam', private: false }, { id: 't4', title: 'Book summer camp', who: 'Both', private: false }, { id: 't5', title: 'Replace the porch light', who: 'Sam', private: false }], count: 5 },
        groceries: { toBuy: ['Milk', 'Eggs', 'Bananas', 'Bread', 'Chicken thighs', 'Tortillas', 'Shredded cheese', 'Apples', 'Coffee', 'Paper towels'].map((name, i) => ({ id: `g${i}`, name })), count: 10 },
        meals: (() => {
          const dinners = ['Chicken tacos', 'Spaghetti and meatballs', '', 'Sheet-pan salmon', 'Homemade pizza', '', 'Slow cooker chili'];
          const week = dinners.map((name, i) => { const d = addDays(now, i); return { date: iso(d), label: i === 0 ? 'Tonight' : i === 1 ? 'Tomorrow' : ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][d.getDay()], meals: name ? [{ meal: 'dinner', name, time: null }] : [] }; });
          return { week, tonight: week[0].meals, today: iso(now) };
        })()
      },
      serverTime: Math.floor(nowMs / 1000), serverVersion: 'demo', demo: true
    };
  }

  function fullMap(q) {
    const zoom = q.get('zoom') && q.get('zoom') !== 'auto' ? Number(q.get('zoom')) : 15;
    const width = Math.max(320, Number(q.get('w')) || 1920), height = Math.max(240, Number(q.get('h')) || 1080);
    const cols = Math.ceil((width + 80) / 256), rows = Math.ceil((height + 60) / 256);
    const tiles = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) tiles.push(`${TILE}/osm-${(r % 5) * 8 + (c % 8)}.png`);
    return { zoom, tileSize: 256, width, height, originX: -40, originY: -30, cols, rows, tiles,
      pins: [{ kind: 'home', label: 'Home', color: '0xF8FAFCFF', x: Math.round(width * 0.6), y: Math.round(height * 0.62) },
        { kind: 'bus', label: 'Bus', color: '0x22C55EFF', x: Math.round(width * 0.4), y: Math.round(height * 0.4) }],
      title: 'School bus for Maya', status: '1,500 ft away', detail: 'Afternoon bus  ·  just now', live: true, who: q.get('who') || 'maya' };
  }

  const json = (data, status = 200) => Promise.resolve(new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }));
  const realFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    if (url.origin !== location.origin || !url.pathname.startsWith('/api/')) return realFetch(input, init);
    const q = url.searchParams;
    if (url.pathname === '/api/dashboard') {
      // the same knobs the real server takes
      if (q.get('selectOverviewMember')) state.overviewMember = q.get('selectOverviewMember');
      if (q.get('who')) state.overviewMember = q.get('who') === 'all' ? 'all' : q.get('who');
      if (q.get('selectWx')) state.selectedWxLoc = q.get('selectWx');
      if (q.get('wx')) state.selectedWxLoc = q.get('wx');
      if (q.get('selectTransport')) state.transport = q.get('selectTransport');
      if (q.get('toggleCal')) state.cals[q.get('toggleCal')] = state.cals[q.get('toggleCal')] === false;
      if (q.get('toggleTransportMode')) { const m = q.get('toggleTransportMode'); state.modes[m] = (state.modes[m] || 'BUS') === 'BUS' ? 'CAR' : 'BUS'; }
      if (q.get('zoom')) state.zoom = Number(q.get('zoom')) || 15;
      return json(build(new Date()));
    }
    if (url.pathname === '/api/map/full') return json(fullMap(q));
    const m = url.pathname.match(/^\/api\/chores\/([^/]+)\/done$/);
    if (m) {
      let who = '';
      try { who = JSON.parse(init?.body || '{}').memberId || ''; } catch (e) { /* none */ }
      if (!who) return json({ error: 'Pick who did the chore.' }, 400);
      done.add(decodeURIComponent(m[1]));
      return json({ ok: true, state: 'waiting', name: who.charAt(0).toUpperCase() + who.slice(1) });
    }
    return json({ error: 'Not in the demo.' }, 404);
  };
  document.documentElement.classList.add('demo');
})();
