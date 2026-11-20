// Family Dashboard on the web. Reads the same /api/dashboard the Roku app
// uses, and browses people and cities without changing what the TV shows.
(() => {
  'use strict';

  // ---- state and settings --------------------------------------------------------------
  const store = {
    get(k, d) { try { const v = localStorage.getItem('fd.' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('fd.' + k, JSON.stringify(v)); } catch (e) { /* private window */ } }
  };
  const state = {
    data: null, view: 'today', who: 'all', wx: null, calView: store.get('calView', 'agenda'),
    traveler: null, mapZoom: 'auto', mapData: null, mapWho: null,
    lastOk: 0, fails: 0, skew: 0, lastKey: Date.now(),
    theme: store.get('theme', 'auto'), sound: store.get('sound', false), idleHome: store.get('idleHome', true),
    seenAlerts: store.get('seenAlerts', {})
  };
  const $ = (s, el = document) => el.querySelector(s);
  const viewEl = $('#view');

  // ---- helpers ------------------------------------------------------------------------
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const css = (c, fb = '#E8623C') => {
    const s = String(c || '');
    const m = s.match(/^0x([0-9a-f]{6})/i) || s.match(/^#([0-9a-f]{6})/i);
    return m ? '#' + m[1] : fb;
  };
  const arr = (v) => Array.isArray(v) ? v.filter(x => x && typeof x === 'object') : [];
  const titleCase = (s) => { s = String(s || ''); return s === s.toUpperCase() ? s.toLowerCase().replace(/\b\w/g, c => c.toUpperCase()) : s; };
  const hourLabel = (s) => /^now$/i.test(String(s)) ? 'Now' : String(s || '');
  const niceTime = (s) => { s = String(s || ''); return /all day/i.test(s) ? 'All day' : s; };
  const reward = (s) => String(s || '').replace(/POINTS/i, 'points').replace(/\bTime\b/, 'time').replace(/^\+(\d+)m /, '+$1 min ');
  const nowSec = () => Math.floor(Date.now() / 1000) + state.skew;
  const inText = (mins) => mins < 60 ? `in ${mins} min` : `in ${Math.floor(mins / 60)} h ${mins % 60 ? (mins % 60) + ' min' : ''}`.trim();
  function ago(ms) {
    const s = Math.round((Date.now() - ms) / 1000);
    if (s < 90) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    return `${Math.round(s / 3600)} h ago`;
  }
  function icon(code, big) {
    const c = String(code || '').toLowerCase();
    const cls = big ? 'ico big' : 'ico';
    const sun = '<circle cx="16" cy="16" r="6" fill="#FBBF24"/><g stroke="#FBBF24" stroke-width="2.4" stroke-linecap="round"><path d="M16 3v3M16 26v3M3 16h3M26 16h3M6.8 6.8l2.1 2.1M23.1 23.1l2.1 2.1M6.8 25.2l2.1-2.1M23.1 8.9l2.1-2.1"/></g>';
    const cloud = '<path d="M9 24h14a5 5 0 0 0 .6-10A7 7 0 0 0 10 12.5 5.8 5.8 0 0 0 9 24z" fill="#CBD5E1"/>';
    const rain = cloud + '<g stroke="#7DD3FC" stroke-width="2.2" stroke-linecap="round"><path d="M11 27l-1 3M16 27l-1 3M21 27l-1 3"/></g>';
    const storm = cloud + '<path d="M17 24l-4 6h3l-2 5 6-7h-3l2-4z" fill="#FBBF24"/>';
    const body = c === 'rain' ? rain : c === 'storm' ? storm : c === 'cloud' ? cloud : sun;
    return `<svg class="${cls}" viewBox="0 0 32 36" aria-hidden="true">${body}</svg>`;
  }
  function toast(text, ms = 4000) {
    const t = $('#toast');
    t.textContent = text; t.hidden = false;
    clearTimeout(toast.timer); toast.timer = setTimeout(() => { t.hidden = true; }, ms);
  }
  function minutesOfDay(d = new Date()) { return d.getHours() * 60 + d.getMinutes(); }
  function clockToMin(s) {
    const m = String(s || '').match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
    if (!m) return -1;
    let h = Number(m[1]) % 12; if (!m[3]) h = Number(m[1]);
    if (m[3] && m[3].toUpperCase() === 'PM') h += 12;
    return h * 60 + Number(m[2]);
  }
  function applyTheme() {
    if (state.theme === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', state.theme);
  }

  // ---- data ----------------------------------------------------------------------------
  async function load() {
    const q = new URLSearchParams({ zoom: '15', who: state.who });
    if (state.wx) q.set('wx', state.wx);
    try {
      const res = await fetch('/api/dashboard?' + q, { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      state.data = data;
      state.lastOk = Date.now();
      state.fails = 0;
      if (typeof data.serverTime === 'number') state.skew = data.serverTime - Math.floor(Date.now() / 1000);
      if (!state.traveler) state.traveler = String(data?.transport?.selectedMemberId || arr(data?.transport?.members)[0]?.id || '').toLowerCase();
      render();
      checkAlerts();
    } catch (e) {
      state.fails++;
      paintStatus();
      if (!state.data) renderEmpty();
    }
  }
  let pollTimer = null;
  function schedule() {
    clearTimeout(pollTimer);
    const busy = state.data?.bus?.isActive || Date.now() - state.lastKey < 30000;
    const wait = state.fails ? Math.min(30000, 5000 * state.fails) : (busy ? 5000 : 15000);
    pollTimer = setTimeout(async () => { if (!document.hidden) await load(); schedule(); }, wait);
  }

  // ---- header ---------------------------------------------------------------------------
  function paintClock() {
    const d = new Date();
    $('#time').textContent = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    $('#date').textContent = d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  }
  function paintStatus() {
    const el = $('#status');
    let text = 'Connecting...'; let cls = 'status';
    if (state.lastOk) {
      const age = Date.now() - state.lastOk;
      if (state.fails >= 2) { text = `Offline · showing what we had ${ago(state.lastOk)}`; cls += ' bad'; }
      else if (age > 75000) { text = `Updated ${ago(state.lastOk)}`; cls += ' warn'; }
      else { text = state.data?.demo ? 'Demo family · nothing here is real' : 'Up to date'; cls += ' ok'; }
    } else if (state.fails) { text = "Can't reach the family server"; cls += ' bad'; }
    el.className = cls;
    el.lastElementChild.textContent = text;
  }
  function travelMembers() { return arr(state.data?.transport?.members); }
  function people() {
    // the TV's people, in the order the server sends them
    const seen = new Set(); const out = [];
    for (const m of travelMembers()) { const id = String(m.id).toLowerCase(); if (!seen.has(id)) { seen.add(id); out.push({ id, name: titleCase(m.name), color: css(m.colorHex) }); } }
    return out;
  }
  function paintHeader() {
    document.querySelectorAll('#tabs button').forEach(b => b.dataset.view === state.view ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current'));
    const hw = state.data?.homeWeather || state.data?.weather;
    const locs = arr(state.data?.weatherLocations);
    const homeName = (locs[0]?.name || '').split(',')[0];
    $('#wxChip').innerHTML = hw && hw.temp !== undefined
      ? `${icon(hw.iconCode)}<b>${esc(hw.temp)}°</b><span><small>${esc(titleCase(hw.condition || ''))}</small><small>${esc(homeName)}</small></span>`
      : '';
    const peopleEl = $('#people');
    const ps = people();
    const showPeople = ['today', 'calendar', 'chores'].includes(state.view) && ps.length > 0;
    peopleEl.hidden = !showPeople;
    if (showPeople) {
      peopleEl.innerHTML = '<span class="label">Show</span>' +
        `<button class="chip" data-who="all" aria-pressed="${state.who === 'all'}">Everyone</button>` +
        ps.map(p => `<button class="chip" data-who="${esc(p.id)}" aria-pressed="${state.who === p.id}"><i style="background:${p.color}"></i>${esc(p.name)}</button>`).join('');
    }
  }

  // ---- views -----------------------------------------------------------------------------
  function render() {
    paintHeader();
    paintStatus();
    if (!state.data) return renderEmpty();
    ({ today: renderToday, calendar: renderCalendar, weather: renderWeather, travel: renderTravel, chores: renderChores }[state.view] || renderToday)();
  }

  function renderEmpty() {
    viewEl.innerHTML = `<div class="center"><div><h2>${state.fails ? "Can't reach the family server" : 'Getting your day ready...'}</h2>
      <p class="muted">${state.fails ? 'Check that the computer running the Family Dashboard Server is on. This page keeps trying.' : ''}</p></div></div>`;
  }

  function todayModel() {
    const now = Date.now();
    const evs = arr(state.data.todayEvents);
    const timed = evs.filter(e => !e.isAllDay);
    const allDay = evs.filter(e => e.isAllDay);
    const current = timed.filter(e => e.startMs <= now && (e.endMs || e.startMs + 1800000) > now);
    const next = timed.find(e => e.startMs > now);
    return { evs, timed, allDay, current, next, now };
  }

  function evRow(e, now) {
    const isNow = !e.isAllDay && e.startMs <= now && (e.endMs || e.startMs + 1800000) > now;
    const place = e.location || (e.kind === 'chore' ? 'Chore' : e.kind === 'todo' ? 'To-do' : e.kind === 'meal' ? 'Meal plan' : '');
    return `<div class="ev${isNow ? ' now' : ''}">
      <span class="t">${e.isAllDay ? '<span class="allday">All day</span>' : esc(niceTime(e.timeLabel))}</span>
      <i class="d" style="background:${css(e.colorHex)}"></i>
      <span class="n">${esc(e.title)}</span>
      <span class="w">${esc([place, titleCase(e.calendarName)].filter(Boolean).join(' · '))}</span>
    </div>`;
  }

  function upcomingByDay(limitDays, perDay) {
    const groups = [];
    for (const e of arr(state.data.calendar)) {
      let g = groups.find(x => x.iso === e.isoDate);
      if (!g) { if (groups.length >= limitDays) break; g = { iso: e.isoDate, label: e.dateLabel || e.shortDate, items: [] }; groups.push(g); }
      if (g.items.length < perDay) g.items.push(e);
    }
    return groups;
  }

  function miniMap(bus) {
    const tiles = Array.isArray(bus?.tiles) ? bus.tiles : [];
    if (tiles.length !== 9) return '<div class="map"></div>';
    const x = Number(bus.bigPinX), y = Number(bus.bigPinY);
    const pin = Number.isFinite(x) && Number.isFinite(y)
      ? `<div class="pin" style="left:${(x / 690) * 100}%;top:${(y / 690) * 100}%"><i style="background:${bus.isActive ? 'var(--good)' : 'var(--accent)'}"></i></div>` : '';
    return `<div class="map">${tiles.map((t, i) => `<img alt="" src="${esc(t)}" style="left:${(i % 3) * 33.333}%;top:${Math.floor(i / 3) * 33.333}%;width:33.4%;height:33.4%">`).join('')}<div class="wash"></div>${pin}</div>`;
  }

  function renderToday() {
    const d = state.data;
    const { evs, current, next, now } = todayModel();
    let hero;
    const focus = current[0] || next;
    if (focus) {
      const isNow = focus === current[0];
      const mins = Math.round((focus.startMs - now) / 60000);
      hero = `<div class="card hero"><div class="bar" style="background:${css(focus.colorHex)}"></div><div style="min-width:0">
        <div class="eyebrow">${isNow ? 'Happening now' : 'Next up'}</div>
        <h2>${esc(focus.title)}</h2>
        <div class="meta">${esc([niceTime(focus.timeLabel), focus.location, titleCase(focus.calendarName)].filter(Boolean).join(' · '))}</div>
      </div>${!isNow && mins > 0 ? `<div class="when">${esc(inText(mins))}</div>` : ''}</div>`;
    } else {
      const up = arr(d.calendar)[0];
      hero = `<div class="card hero"><div class="bar" style="background:var(--line)"></div><div>
        <div class="eyebrow">Rest of today</div><h2>Nothing else scheduled</h2>
        <div class="meta">${up ? esc(`Coming up: ${up.dateLabel || ''} at ${niceTime(up.timeLabel)} · ${up.title}`) : ''}</div></div></div>`;
    }

    const tomorrow = upcomingByDay(1, 5)[0];
    const list = `<div class="card"><h3>Today <small>${evs.length ? `${d.todayTotal || evs.length} left today` : ''}</small></h3>
      <div class="events">${evs.length ? evs.map(e => evRow(e, now)).join('') : '<div class="empty">Nothing left on the calendar today.</div>'}</div>
      ${tomorrow ? `<div class="day-head"><span>${esc(tomorrow.label)}</span></div><div class="events">${tomorrow.items.map(e => evRow(e, now)).join('')}</div>` : ''}
    </div>`;

    const bus = d.bus || {};
    const busLive = Boolean(bus.isActive);
    const travel = `<div class="card click" data-open="map"><h3>${busLive ? 'School bus' : 'Travel'} <small>Tap for the big map</small></h3>
      <div class="travel-mini">${miniMap(bus)}<div style="min-width:0">
        <div class="eyebrow">${busLive ? 'Bus' : 'Next trip'}</div>
        <div class="muted">${esc(bus.status || '')}</div>
        <div class="big-stat">${esc(busLive ? (bus.distanceLabel || bus.eta || 'On the way') : (bus.eta || ''))}</div>
        <div class="faint small">${esc(bus.lastUpdated ? 'as of ' + bus.lastUpdated : '')}</div>
      </div></div></div>`;

    const hw = d.homeWeather || d.weather || {};
    const weather = `<div class="card click" data-go="weather"><h3>Weather <small>${esc((arr(d.weatherLocations)[0]?.name) || '')}</small></h3>
      <div class="wx-now">${icon(hw.iconCode, true)}<div><div class="temp">${esc(hw.temp ?? '--')}°</div>
      <div class="muted">${esc(titleCase(hw.condition || ''))}${hw.high !== undefined ? ` · High ${esc(hw.high)}° · Low ${esc(hw.low)}°` : ''}</div></div></div>
      <div class="wx-hours">${arr(hw.hourly).slice(0, 6).map(h => `<div><div class="h">${esc(hourLabel(h.time))}</div>${icon(h.icon)}<div class="v">${esc(h.temp)}°</div><div class="p">${h.pop ? esc(h.pop) + '%' : ''}</div></div>`).join('')}</div></div>`;

    const chores = arr(d.chores);
    const kids = arr(d.users);
    const ordered = [...chores.filter(c => !c.assignedTo), ...chores.filter(c => c.assignedTo)];
    const choreCard = `<div class="card click" data-go="chores"><h3>Chores &amp; bounties <small>${chores.length} open</small></h3>
      <div class="chore-list">${ordered.slice(0, 5).map(c => `<div class="chore-row"><span>${esc(c.title)}${c.assignedTo ? '' : ' <span class="tag">Bounty</span>'}</span><span class="reward">${esc(reward(c.displayReward))}</span></div>`).join('') || '<div class="empty">All caught up.</div>'}</div>
      ${kids.length ? `<div class="people" style="margin-top:10px">${kids.map(k => `<span class="chip"><i style="background:${css(k.colorHex)}"></i>${esc(titleCase(k.name))} · ${esc(k.earnedLabel || k.earnedTotal || 0)}</span>`).join('')}</div>` : ''}
    </div>`;

    // from Home Assistant (server 5.9+): the few things the family picked, never controls
    const home = arr(d.home);
    const homeCard = home.length ? `<div class="card"><h3>Home <small>${home.some(h => h.attention) ? 'Needs a look' : 'All good'}</small></h3>
      <div class="home-grid">${home.map(h => `<div class="home-item${h.attention ? ' attn' : ''}">${homeIcon(h.icon)}<div style="min-width:0"><div class="n">${esc(h.name)}</div><div class="s">${esc(h.state)}</div></div></div>`).join('')}</div></div>` : '';

    viewEl.innerHTML = `<div class="grid-today"><div class="col">${hero}${list}</div><div class="col">${homeCard}${travel}${weather}${choreCard}</div></div>`;
  }

  // small line icons for the Home card
  function homeIcon(kind) {
    const p = {
      lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
      door: '<path d="M6 21V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v17"/><path d="M4 21h16"/><circle cx="14.5" cy="12" r="1"/>',
      garage: '<path d="M3 21V9l9-5 9 5v12"/><path d="M7 21v-8h10v8M7 16h10"/>',
      temp: '<path d="M14 14.8V5a2 2 0 0 0-4 0v9.8a4 4 0 1 0 4 0z"/>',
      motion: '<circle cx="13" cy="4" r="2"/><path d="M9 21l2-6 3 3v3M8 12l3-4 4 2 3 3M11 15l-1-4"/>',
      person: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
      alarm: '<path d="M12 3l9 16H3z"/><path d="M12 10v4M12 17v.5"/>',
      water: '<path d="M12 3s6 7 6 11a6 6 0 0 1-12 0c0-4 6-11 6-11z"/>',
      bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 20a2 2 0 0 0 4 0"/>',
      battery: '<rect x="3" y="8" width="16" height="9" rx="2"/><path d="M21 11v3"/>'
    }[kind] || '<circle cx="12" cy="12" r="4"/>';
    return `<svg class="hi" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
  }

  function renderCalendar() {
    const d = state.data;
    const now = Date.now();
    const seg = `<div class="toolbar"><div class="seg">${['agenda', 'week', 'month'].map(v => `<button data-cal="${v}" aria-pressed="${state.calView === v}">${v[0].toUpperCase() + v.slice(1)}</button>`).join('')}</div>
      <span class="faint small">${esc(d.calendarViews?.monthTitle && state.calView === 'month' ? titleCase(d.calendarViews.monthTitle) : '')}</span></div>`;
    let body = '';
    if (state.calView === 'week') {
      const days = arr(d.calendarViews?.weekDays);
      body = `<div class="week">${days.map(w => `<div class="day${w.isToday ? ' today' : ''}"><h4>${esc(titleCase(w.dayName))} <span class="faint">${esc(titleCase(w.dateNum))}</span></h4>
        ${arr(w.richEvents).map(e => `<div class="item" style="border-color:${css(e.colorHex)}"><span class="faint small">${esc(niceTime(e.timeLabel))}</span><b>${esc(e.title)}</b>${e.location ? `<span class="faint small">${esc(e.location)}</span>` : ''}</div>`).join('') || '<div class="faint small">Nothing planned</div>'}
        ${w.total > arr(w.richEvents).length ? `<div class="faint small">+${w.total - arr(w.richEvents).length} more</div>` : ''}</div>`).join('')}</div>`;
    } else if (state.calView === 'month') {
      const cells = arr(d.calendarViews?.monthCells);
      const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      body = `<div class="month">${wd.map(w => `<div class="wd">${w}</div>`).join('')}${cells.map(c => {
        const pv = Array.isArray(c.preview) ? c.preview : [];
        const pc = Array.isArray(c.previewColors) ? c.previewColors : [];
        return `<div class="cell${c.inMonth ? '' : ' out'}${c.isToday ? ' today' : ''}"><div class="num">${esc(c.dayNum)}</div>
          ${pv.map((t, i) => `<div class="p" style="border-color:${css(pc[i])}">${esc(t)}</div>`).join('')}
          <div class="dots">${pv.map((t, i) => `<i style="background:${css(pc[i])}"></i>`).join('')}</div>
          ${c.count > pv.length ? `<div class="faint">+${c.count - pv.length}</div>` : ''}</div>`;
      }).join('')}</div>`;
    } else {
      const today = arr(d.todayEvents);
      const groups = upcomingByDay(10, 12);
      body = `<div class="card"><div class="day-head" style="padding-top:0"><span>Today</span><span class="faint">${today.length} events</span></div>
        <div class="events">${today.map(e => evRow(e, now)).join('') || '<div class="empty">Nothing left today.</div>'}</div>
        ${groups.map(g => `<div class="day-head"><span>${esc(g.label)}</span></div><div class="events">${g.items.map(e => evRow(e, now)).join('')}</div>`).join('')}
        ${d.calendarTotal > arr(d.calendar).length ? `<p class="faint small">+${d.calendarTotal - arr(d.calendar).length} more events after these</p>` : ''}</div>`;
    }
    viewEl.innerHTML = seg + body;
  }

  function radar(w) {
    const base = Array.isArray(w.radarBaseTiles) ? w.radarBaseTiles : [];
    const over = Array.isArray(w.radarOverlayTiles) ? w.radarOverlayTiles : [];
    if (base.length !== 9) return '';
    const cell = (t, i) => `<img alt="" src="${esc(t)}" style="left:${(i % 3) * 33.333}%;top:${Math.floor(i / 3) * 33.333}%;width:33.4%;height:33.4%">`;
    return `<div class="card radar"><h3>Radar <small>Green and yellow show rain</small></h3><div class="map">${base.map(cell).join('')}${over.length === 9 ? over.map(cell).join('') : ''}
      <div class="pin" style="left:50%;top:50%"><i style="background:var(--accent)"></i></div></div></div>`;
  }

  function renderWeather() {
    const d = state.data;
    const w = d.weather || {};
    const locs = arr(d.weatherLocations);
    const sel = String(d.selectedWxLoc || state.wx || locs[0]?.id || '').toLowerCase();
    const name = (locs.find(l => String(l.id).toLowerCase() === sel)?.name) || '';
    viewEl.innerHTML = `<div class="toolbar">${locs.map(l => `<button class="chip" data-wx="${esc(String(l.id).toLowerCase())}" aria-pressed="${String(l.id).toLowerCase() === sel}">${esc(l.name.split(',')[0])}</button>`).join('')}</div>
      <div class="two"><div class="stack">
        <div class="card"><div class="wx-now">${icon(w.iconCode, true)}<div><div class="temp">${esc(w.temp ?? '--')}°</div>
          <div class="muted">${esc(titleCase(w.condition || ''))}${w.high !== undefined ? ` · High ${esc(w.high)}° · Low ${esc(w.low)}°` : ''}</div>
          ${w.todayMaxPop ? `<div style="color:var(--info)">Rain chance today ${esc(w.todayMaxPop)}%</div>` : ''}</div></div>
          <div class="wx-hours">${arr(w.hourly).map(h => `<div><div class="h">${esc(hourLabel(h.time))}</div>${icon(h.icon)}<div class="v">${esc(h.temp)}°</div><div class="p">${h.pop ? esc(h.pop) + '%' : ''}</div></div>`).join('')}</div></div>
        <div class="card"><h3>The week ahead <small>${esc(name)}</small></h3><div class="wx-days">${arr(w.daily).map(x => `<div class="wx-day"><span>${esc(titleCase(x.dayName))}</span>${icon(x.icon)}<span><b>${esc(x.high)}°</b> <span class="faint">/ ${esc(x.low)}°</span></span><span class="p">${x.pop ? esc(x.pop) + '% rain' : ''}</span></div>`).join('')}</div></div>
      </div>${radar(w)}</div>`;
  }

  function renderTravel() {
    const d = state.data;
    const mems = travelMembers();
    if (!mems.length) { viewEl.innerHTML = '<div class="empty">No travel info yet. Add people and places in the app or household.json.</div>'; return; }
    const mem = mems.find(m => String(m.id).toLowerCase() === state.traveler) || mems[0];
    const id = String(mem.id).toLowerCase();
    const onBus = mem.hasBus && String(mem.activeMode).toUpperCase() !== 'CAR';
    const busLive = onBus && d.bus?.isActive;
    const trip = mem.nextEventTrip;
    let leave = '';
    if (trip && trip.leaveBy) {
      const lb = clockToMin(trip.leaveBy);
      const remain = lb >= 0 ? lb - minutesOfDay() : null;
      const urgent = remain !== null && remain <= 15 && remain > -30;
      const note = remain === null ? '' : remain > 0 ? inText(remain) : remain > -30 ? 'time to go' : '';
      leave = `<div class="leave${urgent ? ' urgent' : ''}">Leave by ${esc(trip.leaveBy)}</div> <span class="muted">${esc(note)}</span>`;
    }
    const headline = busLive ? `Bus is ${d.bus.distanceLabel || d.bus.eta || 'on the way'}` : onBus ? 'No bus on the road right now' : (mem.primaryDriveLabel ? `${mem.primaryDriveLabel} drive` : '');
    viewEl.innerHTML = `<div class="toolbar">${mems.map(m => `<button class="chip" data-traveler="${esc(String(m.id).toLowerCase())}" aria-pressed="${String(m.id).toLowerCase() === id}"><i style="background:${css(m.colorHex)}"></i>${esc(titleCase(m.name))}</button>`).join('')}</div>
      <div class="two"><div class="card" style="padding:10px"><div id="travelMap" class="map wide"></div></div>
      <div class="stack">
        <div class="card"><div class="eyebrow">${esc(titleCase(mem.name))} · ${onBus ? 'by bus' : 'by car'}</div>
          <h2 style="margin:4px 0">${esc(mem.primaryName ? 'To ' + mem.primaryName : '')}</h2>
          <div class="big-stat">${esc(headline)}</div>
          <div class="muted">${esc(busLive ? [mem.busStatus, d.bus.lastUpdated ? 'as of ' + d.bus.lastUpdated : ''].filter(Boolean).join(' · ') : (onBus ? 'By car it is ' + (mem.primaryDriveLabel || '') : ''))}</div>
          ${mem.scheduleNote ? `<div class="faint small">${esc(mem.scheduleNote)}</div>` : ''}
        </div>
        <div class="card"><h3>Next event away from home</h3>
          ${trip && trip.eventTitle ? `<h2 style="margin:0 0 4px">${esc(trip.eventTitle)}</h2><div class="muted">${esc([trip.eventTime, trip.location, trip.driveLabel].filter(Boolean).join(' · '))}</div>${leave}`
            : '<div class="muted">When a calendar event has a street address, the time to leave shows up here.</div>'}
        </div>
      </div></div>`;
    loadMap(id, $('#travelMap'));
  }

  function renderChores() {
    const d = state.data;
    const kids = arr(d.users);
    const chores = arr(d.chores);
    const nameOf = (mid) => people().find(p => p.id === String(mid || '').toLowerCase())?.name || '';
    viewEl.innerHTML = `${kids.length ? `<div class="kids">${kids.map(k => `<div class="card kid"><div class="eyebrow" style="color:${css(k.colorHex)}">${esc(titleCase(k.name))}</div>
        <div class="amount">${esc(Number.isFinite(k.earnedPoints) ? k.earnedPoints : (k.earnedTotal ?? 0))}</div>
        <div class="faint small">${esc(Number(k.earnedMinutes) > 0 ? `points, plus ${k.earnedMinutes} min of time` : 'points earned')}${k.pendingCount ? ` · ${k.pendingCount} waiting for a parent` : ''}</div></div>`).join('')}</div>` : ''}
      ${section('Bounties', 'Any kid can grab these. First one done earns it.', chores.filter(c => !c.assignedTo), 'No bounties posted right now.')}
      ${section('Chores', 'Each one is a specific kid\'s job. Tap one when it\'s done.', chores.filter(c => c.assignedTo), 'All caught up. No chores waiting.')}`;
    function section(title, hint, list, empty) {
      return `<div class="card" style="margin-top:var(--gap)"><h3>${title} <small>${list.length} open · ${hint}</small></h3>
        <div class="chores-grid">${list.map(c => `<button class="chore" data-chore="${esc(c.id)}"><span class="title">${esc(c.title)}${c.assignedMember || c.assignedTo ? `<span class="who">${esc(nameOf(c.assignedMember || c.assignedTo) || 'Assigned')}</span>` : ''}</span><span class="reward">${esc(reward(c.displayReward))}</span></button>`).join('') || `<div class="empty">${empty}</div>`}</div></div>`;
    }
  }

  // ---- full-screen and travel maps ------------------------------------------------------------
  async function fetchMap(who, zoom) {
    const q = new URLSearchParams({ zoom: String(zoom || 'auto') });
    if (who) q.set('who', who);
    const res = await fetch('/api/map/full?' + q, { cache: 'no-store' });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error || 'The map needs server 5.1 or newer.');
    return j;
  }
  function paintMap(el, m, tools) {
    if (!el) return;
    const W = 1920, H = 1080, size = m.tileSize || 256, cols = m.cols || 1;
    const tiles = (m.tiles || []).map((t, i) => t ? `<img alt="" src="${esc(t)}" style="left:${((m.originX + (i % cols) * size) / W) * 100}%;top:${((m.originY + Math.floor(i / cols) * size) / H) * 100}%;width:${(size / W) * 100 + 0.05}%;height:${(size / H) * 100 + 0.08}%">` : '').join('');
    const pins = (m.pins || []).map(p => `<div class="pin ${p.kind === 'home' ? 'home' : ''}" style="left:${(p.x / W) * 100}%;top:${(p.y / H) * 100}%"><i style="${p.kind === 'home' ? '' : `background:${css(p.color)}`}"></i>${p.label ? `<span>${esc(p.label)}</span>` : ''}</div>`).join('');
    el.innerHTML = tiles + '<div class="wash"></div>' + pins + '<span class="attrib">© OpenStreetMap</span>' +
      (tools ? `<div class="map-tools"><button data-zoom="in" aria-label="Zoom in">+</button><button data-zoom="out" aria-label="Zoom out">−</button><button data-zoom="fit" aria-label="Fit everyone">⤢</button></div>` : '');
    state.mapData = m;
  }
  async function loadMap(who, el, tools = true) {
    try {
      if (state.mapWho !== who) { state.mapZoom = 'auto'; state.mapWho = who; }
      const m = await fetchMap(who, state.mapZoom);
      paintMap(el, m, tools);
      return m;
    } catch (e) {
      if (el) el.innerHTML = `<div class="center" style="min-height:100%"><p class="muted">${esc(e.message)}</p></div>`;
      return null;
    }
  }
  function busRider() {
    const d = state.data;
    if (d?.bus?.isActive) {
      const r = travelMembers().find(m => m.hasBus && String(m.activeMode).toUpperCase() !== 'CAR');
      if (r) return String(r.id).toLowerCase();
    }
    return state.traveler;
  }
  let fullMapTimer = null;
  async function openFullMap(who) {
    const ov = $('#overlay');
    ov.className = 'overlay map-full';
    ov.hidden = false;
    ov.innerHTML = `<div class="fullmap"><div id="fullMap" class="map"></div><div class="head" id="fmHead"><span class="eyebrow">Map</span><b>Loading...</b></div><button class="close" data-close aria-label="Close">×</button></div>`;
    state.mapWho = null;
    const paint = async () => {
      const m = await loadMap(who, $('#fullMap'));
      const head = $('#fmHead');
      if (m && head) {
        head.style.borderColor = m.live ? 'var(--good)' : 'var(--info)';
        head.innerHTML = `<span class="eyebrow" style="color:${m.live ? 'var(--good)' : 'var(--info)'}">${m.live ? 'Live bus' : 'Map'}</span><div>${esc(m.title || '')}</div><b>${esc(m.status || '')}</b><div class="small" style="opacity:.8">${esc(m.detail || '')}</div>`;
      }
    };
    await paint();
    clearInterval(fullMapTimer);
    fullMapTimer = setInterval(() => { if (!$('#overlay').hidden && $('#fullMap')) paint(); else clearInterval(fullMapTimer); }, 15000);
  }

  // ---- chores from this screen ------------------------------------------------------------------
  async function markDone(chore, memberId) {
    try {
      const res = await fetch(`/api/chores/${encodeURIComponent(chore.id)}/done`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ memberId })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || (res.status === 404 ? 'This server is too old to check off chores.' : 'The chore was not saved.'));
      const name = titleCase(j.name || '');
      toast(j.state === 'earned' ? `Nice job, ${name}! ${reward(chore.displayReward)} added.` : `Nice job, ${name}! A parent will check it in the app.`);
      chime('chore');
      load();
    } catch (e) {
      toast(e.message);
    }
  }
  function startChore(choreId) {
    const chore = arr(state.data?.chores).find(c => String(c.id) === String(choreId));
    if (!chore) return;
    const kids = arr(state.data.users);
    if (chore.assignedTo) return markDone(chore, String(chore.assignedTo).toLowerCase());
    if (state.who !== 'all') {
      const k = kids.find(u => String(u.memberId || '').toLowerCase() === state.who || String(u.id).toLowerCase() === state.who);
      if (k) return markDone(chore, String(k.id).toLowerCase());
    }
    if (kids.length === 1) return markDone(chore, String(kids[0].id).toLowerCase());
    if (!kids.length) return toast('Add kids in the Family Dashboard app first.');
    const ov = $('#overlay');
    ov.className = 'overlay'; ov.hidden = false;
    ov.innerHTML = `<div class="sheet" role="dialog" aria-label="Who did it"><h2>Who did “${esc(chore.title)}”?</h2>
      <p class="muted">${esc(reward(chore.displayReward))} goes to whoever you pick.</p>
      <div class="pick">${kids.map(k => `<button data-kid="${esc(String(k.id).toLowerCase())}"><i style="background:${css(k.colorHex)}"></i>${esc(titleCase(k.name))}</button>`).join('')}</div>
      <div class="actions"><button class="btn" data-close>Cancel</button></div></div>`;
    ov.dataset.chore = chore.id;
  }

  // ---- alerts and sound ---------------------------------------------------------------------------
  let audio = null;
  function chime(kind) {
    if (!state.sound) return;
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      const notes = { bus: [1046, 784, 1046, 784], leave: [523, 659, 784, 1046], chore: [784, 1046, 1318], event: [659, 880] }[kind] || [659, 880];
      notes.forEach((f, i) => {
        const o = audio.createOscillator(); const g = audio.createGain();
        o.type = 'sine'; o.frequency.value = f;
        const t = audio.currentTime + i * 0.18;
        g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.25, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
        o.connect(g).connect(audio.destination); o.start(t); o.stop(t + 1);
      });
    } catch (e) { /* no audio */ }
  }
  function checkAlerts() {
    const now = nowSec();
    const fresh = arr(state.data?.alerts).filter(a => a.id && a.at <= now && now < a.until && now < a.at + 600 && !state.seenAlerts[a.id]);
    // forget alerts that are over
    for (const [id, until] of Object.entries(state.seenAlerts)) if (until < now) delete state.seenAlerts[id];
    if (!fresh.length) return;
    const rank = { bus: 3, leave: 2, event: 1 };
    const best = fresh.sort((a, b) => (rank[b.kind] || 0) - (rank[a.kind] || 0))[0];
    fresh.forEach(a => { state.seenAlerts[a.id] = a.until; });
    store.set('seenAlerts', state.seenAlerts);
    const eyebrow = { event: 'Starting soon', leave: 'Time to leave', bus: 'Bus nearby' }[best.kind] || 'Coming up';
    const color = best.kind === 'bus' ? 'var(--good)' : best.kind === 'leave' ? 'var(--warn)' : css(best.colorHex);
    const el = $('#alert');
    el.style.borderColor = color;
    el.innerHTML = `<div><span class="eyebrow" style="color:${color}">${esc(eyebrow)}</span><b>${esc(best.title)}</b><span class="muted">${esc(best.detail || '')}</span></div>`;
    el.hidden = false;
    clearTimeout(checkAlerts.timer);
    checkAlerts.timer = setTimeout(() => { el.hidden = true; }, 120000);
    if (best.sound !== false) chime(best.kind);
  }

  // ---- settings ------------------------------------------------------------------------------------
  function openMenu() {
    const ov = $('#overlay');
    ov.className = 'overlay'; ov.hidden = false;
    ov.innerHTML = '';
    ov.appendChild($('#menuTpl').content.cloneNode(true));
    $('#setTheme').value = state.theme;
    $('#setSound').checked = state.sound;
    $('#setIdle').checked = state.idleHome;
    $('#setVersion').textContent = state.data?.serverVersion ? `Server ${state.data.serverVersion}` : '';
    $('#setTheme').onchange = (e) => { state.theme = e.target.value; store.set('theme', state.theme); applyTheme(); };
    $('#setSound').onchange = (e) => { state.sound = e.target.checked; store.set('sound', state.sound); if (state.sound) chime('event'); };
    $('#setIdle').onchange = (e) => { state.idleHome = e.target.checked; store.set('idleHome', state.idleHome); };
    $('#setFull').onclick = () => {
      const el = document.documentElement;
      if (document.fullscreenElement) document.exitFullscreen?.(); else (el.requestFullscreen || el.webkitRequestFullscreen)?.call(el);
    };
  }
  function closeOverlay() {
    const ov = $('#overlay');
    ov.hidden = true; ov.innerHTML = ''; delete ov.dataset.chore;
    clearInterval(fullMapTimer);
  }

  // ---- input ----------------------------------------------------------------------------------------
  function go(view) {
    state.view = view;
    if (view !== 'travel') state.mapWho = null;
    render();
    window.scrollTo({ top: 0 });
  }
  document.addEventListener('click', (e) => {
    state.lastKey = Date.now();
    const t = e.target.closest('button, [data-open], [data-go], #alert');
    if (!t) return;
    if (t.id === 'alert') { t.hidden = true; return; }
    if (t.matches('[data-close]')) return closeOverlay();
    if (t.dataset.view) return go(t.dataset.view);
    if (t.id === 'wxChip') { state.wx = null; return go('weather'); }
    if (t.id === 'menuBtn') return openMenu();
    if (t.dataset.who) { state.who = t.dataset.who; paintHeader(); return load(); }
    if (t.dataset.cal) { state.calView = t.dataset.cal; store.set('calView', state.calView); return renderCalendar(); }
    if (t.dataset.wx) { state.wx = t.dataset.wx; return load(); }
    if (t.dataset.traveler) { state.traveler = t.dataset.traveler; return renderTravel(); }
    if (t.dataset.chore) return startChore(t.dataset.chore);
    if (t.dataset.kid) {
      const chore = arr(state.data?.chores).find(c => String(c.id) === $('#overlay').dataset.chore);
      closeOverlay();
      if (chore) markDone(chore, t.dataset.kid);
      return;
    }
    if (t.dataset.zoom) {
      const cur = state.mapData?.zoom || 15;
      state.mapZoom = t.dataset.zoom === 'fit' ? 'auto' : String(Math.max(10, Math.min(18, cur + (t.dataset.zoom === 'in' ? 1 : -1))));
      const el = $('#fullMap') || $('#travelMap');
      const who = state.mapWho;
      state.mapWho = who; // keep the zoom for this person
      fetchMap(who, state.mapZoom).then(m => paintMap(el, m, true)).catch(() => {});
      return;
    }
    if (t.dataset.open === 'map') return openFullMap(busRider());
    if (t.dataset.go) return go(t.dataset.go);
  });
  // On a TV (the Android TV app opens ?display=tv) the remote's left and right
  // move between screens, up and down scroll, OK opens the person filter.
  const onTv = new URLSearchParams(location.search).get('display') === 'tv';
  if (onTv) document.body.classList.add('on-tv');
  const ORDER = ['today', 'calendar', 'weather', 'travel', 'chores'];
  document.addEventListener('keydown', (e) => {
    state.lastKey = Date.now();
    if (e.key === 'Escape') closeOverlay();
    if (!onTv) return;
    // The Android TV app may add its own remote navigation (SpatialNavigation), which can
    // reach every button. Then the arrows are its job.
    if (window.SpatialNavigation) return;
    if (!$('#overlay').hidden) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      const i = Math.max(0, ORDER.indexOf(state.view));
      const next = ORDER[(i + (e.key === 'ArrowRight' ? 1 : ORDER.length - 1)) % ORDER.length];
      e.preventDefault();
      go(next);
      window.scrollTo(0, 0);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      window.scrollBy({ top: (e.key === 'ArrowDown' ? 1 : -1) * window.innerHeight * 0.6, behavior: 'smooth' });
    }
  });
  $('#overlay').addEventListener('click', (e) => { if (e.target.id === 'overlay' && !e.target.classList.contains('map-full')) closeOverlay(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });

  // ---- clock and quiet-time reset ----------------------------------------------------------------------
  let lastMinute = -1;
  setInterval(() => {
    const d = new Date();
    if (d.getMinutes() !== lastMinute) {
      lastMinute = d.getMinutes();
      paintClock();
      if (state.data && ['today', 'travel'].includes(state.view) && $('#overlay').hidden) render();
    }
    paintStatus();
    if (state.data) checkAlerts();
    // a wall screen drifts back to everyone's Today
    if (state.idleHome && Date.now() - state.lastKey > 180000 && (state.view !== 'today' || state.who !== 'all' || !$('#overlay').hidden)) {
      const busMapOpen = !$('#overlay').hidden && $('#fullMap') && state.data?.bus?.isActive;
      if (!busMapOpen) {
        closeOverlay();
        const reload = state.who !== 'all' || state.wx;
        state.who = 'all'; state.wx = null; state.view = 'today';
        state.lastKey = Date.now();
        if (reload) load(); else render();
      }
    }
  }, 1000);

  applyTheme();
  paintClock();
  load().then(schedule);
})();
