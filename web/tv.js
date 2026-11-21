// The TV page (server 5.11): Family Dashboard for a remote.
//
// Home shows this TV's cards (its layout comes from the server). OK on a card opens its
// section; inside a section, Left and Right switch tabs, Up and Down move or scroll,
// OK on a map or radar opens it full screen, Back goes back, and Back again goes Home.
//
// Written for older TV browsers too (LG webOS and Samsung Tizen from about 2019),
// so no optional chaining or other newer syntax.
(function () {
  'use strict';

  var W = 1920, H = 1080;
  var $ = function (s) { return document.querySelector(s); };
  var stage = $('#stage'), screenEl = $('#screen'), layer = $('#layer');
  var qs = new URLSearchParams(location.search);

  // ---- fit 1920 x 1080 onto any screen ------------------------------------------------------
  function fit() {
    var s = Math.min(window.innerWidth / W, window.innerHeight / H);
    // centered: shift back by half the scaled size (the origin is the top left)
    stage.style.transform = 'translate(' + (-W * s / 2) + 'px,' + (-H * s / 2) + 'px) scale(' + s + ')';
  }
  window.addEventListener('resize', fit);
  fit();

  // ---- who this TV is ----------------------------------------------------------------------
  function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; } return v; }
  var tvId = qs.get('tv') || store('fd-tv-id');
  if (!tvId) { tvId = 'tv-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4); store('fd-tv-id', tvId); }
  var ua = navigator.userAgent;
  var model = qs.get('model') || (/Web0S|webOS/i.test(ua) ? 'LG TV' : /Tizen/i.test(ua) ? 'Samsung TV' : /AFT|Fire ?TV/i.test(ua) ? 'Fire TV' : /Android/i.test(ua) ? 'Android TV' : 'TV browser');
  var kind = qs.get('kind') || (/Android/i.test(ua) ? 'android-tv' : 'tv-page');
  var demo = qs.get('demo') === '1';

  // ---- small helpers -----------------------------------------------------------------------
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function arr(v) { return Array.isArray(v) ? v : []; }
  function css(hex) { var m = /^0x([0-9a-f]{6})/i.exec(String(hex || '')); return m ? '#' + m[1] : (String(hex || '').charAt(0) === '#' ? hex : '#E8623C'); }
  function title(s) { s = String(s || ''); return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase(); }
  function get(o, path, dflt) { var v = o; var p = path.split('.'); for (var i = 0; i < p.length; i++) { if (v == null) return dflt; v = v[p[i]]; } return v == null ? dflt : v; }
  var toastTimer = null;
  function toast(msg) {
    var t = $('#toast'); if (!t) { t = document.createElement('div'); t.id = 'toast'; stage.appendChild(t); }
    t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.hidden = true; }, 3500);
  }
  var ICONS = {
    sun: '<circle cx="12" cy="12" r="5"/><path d="M12 1v3M12 20v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M1 12h3M20 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>',
    cloud: '<path d="M7 18h10a4 4 0 0 0 0-8 6 6 0 0 0-11.6 1.6A3.3 3.3 0 0 0 7 18z"/>',
    rain: '<path d="M7 14h10a4 4 0 0 0 0-8 6 6 0 0 0-11.6 1.6A3.3 3.3 0 0 0 7 14z"/><path d="M8 17l-1 3M12 17l-1 3M16 17l-1 3"/>',
    storm: '<path d="M7 14h10a4 4 0 0 0 0-8 6 6 0 0 0-11.6 1.6A3.3 3.3 0 0 0 7 14z"/><path d="M12 14l-2 4h3l-2 4"/>',
    snow: '<path d="M7 14h10a4 4 0 0 0 0-8 6 6 0 0 0-11.6 1.6A3.3 3.3 0 0 0 7 14z"/><path d="M8 18h.01M12 20h.01M16 18h.01"/>'
  };
  function wxIcon(code, size) {
    var k = String(code || '').toLowerCase();
    var key = /storm|thunder/.test(k) ? 'storm' : /snow|sleet/.test(k) ? 'snow' : /rain|drizzle|shower/.test(k) ? 'rain' : /cloud|overcast|fog|mist/.test(k) ? 'cloud' : 'sun';
    return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + ICONS[key] + '</svg>';
  }

  // ---- data from the server ------------------------------------------------------------------
  var data = null, lastOk = 0, problem = null, peekWx = null;
  function load() {
    var q = new URLSearchParams({ tv: tvId, tvKind: kind, tvModel: model });
    if (peekWx) q.set('wx', peekWx);
    return fetch('/api/dashboard?' + q.toString(), { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('The server answered ' + r.status + '.'); return r.json(); })
      .then(function (d) { data = d; lastOk = Date.now(); problem = null; render(); showAlerts(); })
      .catch(function (e) { problem = e.message; if (!data) render(); });
  }

  // ---- where we are ------------------------------------------------------------------------
  // view: 'home' or a section id; tab: the tab inside it; focus: the focused element's key
  var nav = { view: 'home', tab: null, focus: null, scroll: 0 };
  var SECTION_FOR = { next: ['calendar', 'agenda'], today: ['calendar', 'week'], weather: ['weather', null], travel: ['travel', null],
    chores: ['chores', null], todos: ['lists', 'todos'], groceries: ['lists', 'groceries'], meals: ['lists', 'meals'], home: ['home', null] };
  var NAMES = { calendar: 'Calendar', weather: 'Weather', travel: 'Travel', chores: 'Chores', lists: 'Lists', home: 'Home' };
  function layout() { return data && data.layout ? data.layout : { cards: ['next', 'today', 'weather', 'travel', 'chores', 'todos', 'groceries', 'meals', 'home'], sections: ['calendar', 'weather', 'travel', 'chores', 'lists', 'home'] }; }
  function canOpen(section) { return layout().sections.indexOf(section) >= 0 && (section !== 'home' || arr(data && data.home).length > 0); }

  function go(view, tab) {
    nav.view = view; nav.tab = tab || null; nav.focus = null; nav.scroll = 0;
    closeLayer();
    render();
  }

  // ---- drawing -----------------------------------------------------------------------------
  function render() {
    var now = data ? new Date((data.serverTime || Date.now() / 1000) * 1000 + (Date.now() - lastOk)) : new Date();
    $('#clock').textContent = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    $('#date').textContent = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
    if (!data) {
      screenEl.innerHTML = '<div class="problem"><div><b>' + (problem ? 'Can\'t reach the family server' : 'Loading...') + '</b><p>' + esc(problem || '') + '</p></div></div>';
      return;
    }
    var html;
    if (nav.view === 'home') html = homeScreen();
    else if (nav.view === 'calendar') html = calendarScreen();
    else if (nav.view === 'weather') html = weatherScreen();
    else if (nav.view === 'travel') html = travelScreen();
    else if (nav.view === 'chores') html = choresScreen();
    else if (nav.view === 'lists') html = listsScreen();
    else if (nav.view === 'home-assistant' || nav.view === 'home2') html = haScreen();
    else html = homeScreen();
    screenEl.innerHTML = html;
    var name = data.display && data.display.name;
    $('#crumb').innerHTML = nav.view === 'home' ? '<b>' + esc(name || 'Family Dashboard') + '</b>'
      : 'Home &nbsp;›&nbsp; <b>' + esc(NAMES[nav.view === 'home2' ? 'home' : nav.view] || '') + '</b>' + (nav.tab ? ' &nbsp;·&nbsp; ' + esc(tabName(nav.tab)) : '');
    $('#hint').innerHTML = nav.view === 'home' ? '<span><b>OK</b> open</span><span><b>Arrows</b> move</span>'
      : '<span><b>◀ ▶</b> switch</span><span><b>▲ ▼</b> move</span><span><b>OK</b> open</span><span><b>Back</b> home</span>';
    afterRender();
  }
  var TAB_NAMES = { agenda: 'Agenda', week: 'Week', month: 'Month', todos: 'To-dos', groceries: 'Groceries', meals: 'Meals' };
  function tabName(t) {
    if (TAB_NAMES[t]) return TAB_NAMES[t];
    var loc = arr(data.weatherLocations).filter(function (l) { return l.id === t; })[0];
    if (loc) return loc.name;
    var m = arr(get(data, 'transport.members', [])).filter(function (x) { return x.id === t; })[0];
    return m ? title(m.name) : t;
  }

  // the next thing happening, for the "Next up" card
  function nextEvent() {
    var nowMs = Date.now();
    var today = arr(get(data, 'calendarViews.todayEvents', data.todayEvents));
    var timed = today.filter(function (e) { return !e.isAllDay && (e.endMs || 0) > nowMs; });
    if (timed.length) return { ev: timed[0], when: timed[0].startMs <= nowMs ? 'Now' : timed[0].timeLabel, rest: timed.slice(1, 3) };
    var later = arr(get(data, 'calendarViews.list', data.calendar));
    return later.length ? { ev: later[0], when: later[0].dateLabel + ' · ' + later[0].timeLabel, rest: [] } : null;
  }

  function card(id, body, cls) {
    var sec = SECTION_FOR[id];
    var open = sec && canOpen(sec[0] === 'home' ? 'home' : sec[0]);
    return '<div class="card ' + (cls || '') + (open ? ' f' : '') + '" ' + (open ? 'data-f="card-' + id + '" data-go="' + id + '"' : '') + '>' + body + '</div>';
  }

  // Home fills a 2-row grid exactly: 4 columns (5 for 9 or 10 cards); spare cells make
  // "Next up" tall and then the first cards wide, so there are never gaps or a third row.
  function homeScreen() {
    var cards = layout().cards.filter(function (c) { return c !== 'home' || arr(data.home).length; }).slice(0, 10);
    var n = cards.length;
    var cols = n >= 9 ? 5 : n <= 3 ? Math.max(1, n) : 4, rows = n <= 3 ? 1 : 2;
    var spare = cols * rows - n, extra = {};
    if (rows === 2 && spare > 0 && cards[0] === 'next') { extra.next = ' tall'; spare--; }
    for (var i = 0; i < n && spare > 0; i++) if (!extra[cards[i]]) { extra[cards[i]] = ' wide'; spare--; }
    var parts = cards.map(function (c) { return renderCard(c, extra[c] || ''); });
    return '<div class="grid' + (cols === 5 ? ' five' : '') + '" style="grid-template-columns:repeat(' + cols + ',1fr);grid-template-rows:repeat(' + rows + ',1fr)">' + parts.join('') + '</div>';
  }

  function renderCard(c, cls) {
    var d = data, nowMs = Date.now();
    if (c === 'next') {
      var n = nextEvent();
      if (!n) return card(c, '<h3>Next up</h3><div class="mid muted">Nothing on the calendar</div>', cls);
      return card(c, '<h3>Next up <small>' + esc(n.ev.calendarName || '') + '</small></h3><div class="big">' + esc(n.ev.title) + '</div>' +
        '<div class="sub"><span class="' + (n.when === 'Now' ? 'now' : '') + '">' + esc(n.when) + '</span>' + (n.ev.location ? ' · ' + esc(n.ev.location) : '') + '</div>' +
        (n.rest.length ? '<div class="sub muted">Then ' + n.rest.map(function (e) { return esc(e.timeLabel + ' ' + e.title); }).join(', ') + '</div>' : ''), cls);
    }
    if (c === 'today') {
      var evs = arr(get(d, 'calendarViews.todayEvents', d.todayEvents)).filter(function (e) { return e.isAllDay || (e.endMs || 0) > nowMs; });
      return card(c, '<h3>Today <small>' + evs.length + ' left</small></h3><div class="rows">' + (evs.slice(0, 6).map(function (e) {
        return '<div class="row"><i class="dot" style="background:' + css(e.colorHex) + '"></i><span class="t">' + esc(e.isAllDay ? 'All day' : e.timeLabel) + '</span><span class="x">' + esc(e.title) + '</span></div>';
      }).join('') || '<div class="mid muted">All clear today</div>') + '</div>', cls);
    }
    if (c === 'weather') {
      var w = d.homeWeather || d.weather || {};
      return card(c, '<h3>Weather <small>' + esc(get(arr(d.weatherLocations).filter(function (l) { return l.id === d.homeWxLoc; })[0] || {}, 'name', '')) + '</small></h3>' +
        '<div style="display:flex;align-items:center;justify-content:space-between"><div class="big" style="font-size:96px">' + esc(w.temp != null ? Math.round(w.temp) + '°' : '--') + '</div><div style="color:var(--warn)">' + wxIcon(w.iconCode || w.condition, 110) + '</div></div>' +
        '<div class="sub">' + esc(w.condition || '') + '</div><div class="sub muted">High ' + esc(w.high) + '° · Low ' + esc(w.low) + '°' + (w.todayMaxPop ? ' · ' + esc(w.todayMaxPop) + '% rain' : '') + '</div>', cls);
    }
    if (c === 'travel') {
      var bus = d.bus || {};
      var ms = arr(get(d, 'transport.members', []));
      var trip = ms.map(function (m) { return m.nextEventTrip ? { m: m, t: m.nextEventTrip } : null; }).filter(Boolean)[0];
      var body = bus.isActive
        ? '<div class="big">' + esc(bus.distanceLabel || bus.eta || 'On the way') + '</div><div class="sub">' + esc(bus.status || 'School bus') + '</div>'
        : trip ? '<div class="mid">' + esc(trip.t.eventTitle) + '</div><div class="sub">Leave by <b>' + esc(trip.t.leaveBy) + '</b> · ' + esc(trip.t.driveLabel) + '</div>'
          : '<div class="mid muted">No trips coming up</div>';
      return card(c, '<h3>' + (bus.isActive ? 'School bus' : 'Travel') + '</h3>' + body, cls);
    }
    if (c === 'chores') {
      var ch = arr(d.chores);
      return card(c, '<h3>Chores <small>' + ch.length + ' open</small></h3><div class="rows">' + (ch.slice(0, 4).map(function (x) {
        return '<div class="row"><span class="x">' + esc(x.title) + '</span><span class="pill">' + esc(shortReward(x.displayReward)) + '</span></div>';
      }).join('') || '<div class="mid muted">All caught up</div>') + '</div>', cls);
    }
    if (c === 'todos') {
      var t = get(d, 'lists.todos', { today: [], anytime: [] });
      var all = arr(t.today).concat(arr(t.anytime));
      return card(c, '<h3>To-dos <small>' + all.length + '</small></h3><div class="rows">' + (all.slice(0, 5).map(function (x) {
        return '<div class="row"><span class="x">' + esc(x.title) + '</span><small class="muted" style="font-size:24px">' + esc(x.who) + '</small></div>';
      }).join('') || '<div class="mid muted">Nothing to do</div>') + '</div>', cls);
    }
    if (c === 'groceries') {
      var g = arr(get(d, 'lists.groceries.toBuy', []));
      return card(c, '<h3>Groceries <small>' + g.length + ' to buy</small></h3><div class="sub" style="font-size:32px;line-height:1.45;color:var(--text)">' +
        (g.slice(0, 10).map(function (x) { return esc(x.name); }).join(' · ') || '<span class="muted">The list is empty</span>') + '</div>', cls);
    }
    if (c === 'meals') {
      var wk = arr(get(d, 'lists.meals.week', []));
      return card(c, '<h3>Meals</h3><div class="rows">' + wk.slice(0, 5).map(function (day) {
        var m = arr(day.meals);
        return '<div class="row"><span class="t">' + esc(day.label) + '</span><span class="x' + (m.length ? '' : ' muted') + '">' + esc(m.length ? m.map(function (x) { return x.name; }).join(', ') : 'Not planned') + '</span></div>';
      }).join('') + '</div>', cls);
    }
    if (c === 'home') {
      var hs = arr(d.home);
      var attn = hs.filter(function (h) { return h.attention; });
      return card(c, '<h3>Home <small>' + (attn.length ? 'Needs a look' : 'All good') + '</small></h3><div class="rows">' + (attn.concat(hs.filter(function (h) { return !h.attention; }))).slice(0, 4).map(function (h) {
        return '<div class="row"><span class="x">' + esc(h.name) + '</span><b style="' + (h.attention ? 'color:var(--warn)' : '') + '">' + esc(h.state) + '</b></div>';
      }).join('') + '</div>', cls);
    }
    return '';
  }

  function shortReward(r) { return String(r || '').replace(/^\+/, '').replace(/\s*POINTS?$/i, ' pts').replace(/m\s*Time$/i, ' min'); }

  function tabs(list, sel) {
    return '<div class="tabs">' + list.map(function (t) {
      return '<div class="tab f flat' + (t.id === sel ? ' sel' : '') + '" data-f="tab-' + esc(t.id) + '" data-tab="' + esc(t.id) + '">' + esc(t.name) + '</div>';
    }).join('') + '</div>';
  }

  function calendarScreen() {
    var tab = nav.tab || 'agenda';
    var v = data.calendarViews || {};
    var html = tabs([{ id: 'agenda', name: 'Agenda' }, { id: 'week', name: 'Week' }, { id: 'month', name: 'Month' }], tab);
    var nowMs = Date.now();
    if (tab === 'agenda') {
      var groups = [{ label: 'Today', evs: arr(v.todayEvents) }];
      var byDay = {};
      arr(v.list).forEach(function (e) { (byDay[e.dateLabel] = byDay[e.dateLabel] || []).push(e); });
      Object.keys(byDay).forEach(function (k) { groups.push({ label: k, evs: byDay[k] }); });
      html += '<div class="pane"><div class="scroll"><div class="scroll-inner agenda">' + groups.map(function (g) {
        return '<div class="day">' + esc(g.label) + '</div>' + (g.evs.map(function (e) {
          return '<div class="ev' + (!e.isAllDay && e.endMs && e.endMs < nowMs ? ' past' : '') + '" style="border-left:8px solid ' + css(e.colorHex) + '"><span class="tm">' + esc(e.isAllDay ? 'All day' : e.timeLabel) + '</span><span class="ti">' + esc(e.title) + '</span><span class="who">' + esc(e.calendarName || '') + '</span></div>';
        }).join('') || '<div class="empty">Nothing on the calendar</div>');
      }).join('') + '</div></div></div>';
    } else if (tab === 'week') {
      html += '<div class="pane"><div class="week">' + arr(v.weekDays).map(function (d) {
        return '<div class="wd' + (d.isToday ? ' today' : '') + '"><h4><span>' + esc(d.dayName) + '</span><span>' + esc(d.dateNum) + '</span></h4>' + arr(d.richEvents).map(function (e) {
          return '<div class="e" style="border-color:' + css(e.colorHex) + '"><b>' + esc(e.isAllDay ? 'All day' : e.timeLabel) + '</b><span>' + esc(e.title) + '</span></div>';
        }).join('') + '</div>';
      }).join('') + '</div></div>';
    } else {
      html += '<div class="pane"><div class="month">' + ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(function (x) { return '<div class="h">' + x + '</div>'; }).join('') +
        arr(v.monthCells).map(function (c) {
          return '<div class="mc' + (c.inMonth ? '' : ' out') + (c.isToday ? ' today' : '') + '"><div class="n">' + esc(c.dayNum) + '</div>' + arr(c.preview).map(function (p, i) {
            return '<div class="p" style="border-color:' + css(arr(c.previewColors)[i]) + '">' + esc(p) + '</div>';
          }).join('') + '</div>';
        }).join('') + '</div></div>';
    }
    return html;
  }

  function weatherScreen() {
    var locs = arr(data.weatherLocations);
    var tab = nav.tab || data.selectedWxLoc || (locs[0] && locs[0].id);
    var w = data.weather || {};
    var html = locs.length > 1 ? tabs(locs.map(function (l) { return { id: l.id, name: l.name }; }), tab) : '';
    html += '<div class="pane' + (locs.length > 1 ? '' : ' full') + '"><div class="split"><div class="card wxnow">' +
      '<div style="display:flex;justify-content:space-between;align-items:center"><div class="big">' + esc(w.temp != null ? Math.round(w.temp) + '°' : '--') + '</div><div style="color:var(--warn)">' + wxIcon(w.iconCode || w.condition, 150) + '</div></div>' +
      '<div class="mid" style="margin-top:12px">' + esc(w.condition || '') + '</div><div class="sub">High ' + esc(w.high) + '° · Low ' + esc(w.low) + '°</div>' +
      '<div class="hours">' + arr(w.hourly).slice(0, 8).map(function (h) { return '<div>' + esc(h.time) + '<b>' + esc(h.temp) + '°</b>' + (h.pop ? esc(h.pop) + '%' : '&nbsp;') + '</div>'; }).join('') + '</div>' +
      '<div class="days">' + arr(w.daily).slice(0, 7).map(function (x) { return '<div>' + esc(x.dayName) + '<b>' + esc(x.high) + '°</b>' + esc(x.low) + '°</div>'; }).join('') + '</div></div>' +
      '<div class="map f flat" data-f="radar" data-full="radar">' + radarTiles(w) + '<div class="badge">Radar · OK for full screen</div></div></div></div>';
    return html;
  }
  function radarTiles(w) {
    var base = arr(w.radarBaseTiles), over = arr(w.radarOverlayTiles);
    if (!base.length) return '<div class="empty" style="padding:40px">No radar for this place.</div>';
    return '<div class="radar">' + base.map(function (b, i) {
      return '<div class="cell"><img alt="" src="' + esc(b) + '">' + (over[i] ? '<img alt="" src="' + esc(over[i]) + '" style="opacity:.75">' : '') + '</div>';
    }).join('') + '</div>';
  }

  function travelScreen() {
    var ms = arr(get(data, 'transport.members', []));
    var tab = nav.tab || (ms[0] && ms[0].id);
    var m = ms.filter(function (x) { return x.id === tab; })[0] || ms[0] || {};
    var bus = data.bus || {};
    var t = m.nextEventTrip;
    var html = ms.length > 1 ? tabs(ms.map(function (x) { return { id: x.id, name: title(x.name) }; }), tab) : '';
    var status = m.hasBus && String(m.activeMode).toUpperCase() !== 'CAR' && bus.isActive
      ? '<div class="big">' + esc(bus.distanceLabel || bus.eta || '') + '</div><div class="sub">' + esc(bus.status || 'School bus') + '</div>'
      : t ? '<div class="mid">' + esc(t.eventTitle) + '</div><div class="sub">' + esc(t.eventTime) + ' · ' + esc(t.location || '') + '</div><div class="big" style="margin-top:18px;font-size:48px">Leave by ' + esc(t.leaveBy) + '</div><div class="sub">' + esc(t.driveLabel) + ' drive</div>'
        : '<div class="mid">' + esc(m.primaryName || 'No trips coming up') + '</div><div class="sub">' + esc(m.primaryDriveLabel || '') + '</div>';
    html += '<div class="pane' + (ms.length > 1 ? '' : ' full') + '"><div class="split"><div class="card">' + '<h3>' + esc(title(m.name || '')) + '</h3>' + status +
      (m.scheduleNote ? '<div class="sub muted" style="margin-top:20px">' + esc(m.scheduleNote) + '</div>' : '') + '</div>' +
      '<div class="map f flat" data-f="map" data-full="map" id="paneMap"><div class="empty" style="padding:40px">Loading the map...</div></div></div></div>';
    return html;
  }

  function choresScreen() {
    var ch = arr(data.chores);
    var kids = arr(data.users);
    var nameOf = function (id) { var k = kids.filter(function (x) { return String(x.id).toLowerCase() === String(id || '').toLowerCase(); })[0]; return k ? title(k.name) : ''; };
    var item = function (c) {
      return '<div class="item chore f" data-f="chore-' + esc(c.id) + '" data-chore="' + esc(c.id) + '"><span class="x">' + esc(c.title) + (c.assignedTo ? ' <small>' + esc(nameOf(c.assignedTo)) + '</small>' : '') + '</span><span class="r">' + esc(String(c.displayReward || '').replace(/^\+/, '')) + '</span></div>';
    };
    var b = ch.filter(function (c) { return !c.assignedTo; }), mine = ch.filter(function (c) { return c.assignedTo; });
    return '<div class="pane full"><div class="scroll"><div class="scroll-inner">' +
      '<div class="tabs" style="gap:28px">' + kids.map(function (k) { return '<div class="card" style="padding:18px 28px;flex-direction:row;align-items:center;gap:16px"><i class="dot" style="background:' + css(k.colorHex) + '"></i><span class="mid">' + esc(title(k.name)) + '</span><span class="pill">' + esc(k.earnedPoints != null ? k.earnedPoints : (k.earnedTotal || 0)) + ' pts</span></div>'; }).join('') + '</div>' +
      '<h3 style="font-size:30px;color:var(--text2);margin:10px 0 14px">CHORES · OK when it\'s done</h3><div class="list">' + (mine.map(item).join('') || '<div class="empty">All caught up.</div>') + '</div>' +
      '<h3 style="font-size:30px;color:var(--text2);margin:26px 0 14px">BOUNTIES · any kid, first one done earns it</h3><div class="list">' + (b.map(item).join('') || '<div class="empty">No bounties right now.</div>') + '</div>' +
      '</div></div></div>';
  }

  function listsScreen() {
    var tab = nav.tab || 'todos';
    var l = data.lists || {};
    var html = tabs([{ id: 'todos', name: 'To-dos' }, { id: 'groceries', name: 'Groceries' }, { id: 'meals', name: 'Meals' }], tab);
    html += '<div class="pane"><div class="scroll"><div class="scroll-inner">';
    if (tab === 'todos') {
      var t = l.todos || {};
      var row = function (x) { return '<div class="item"><span class="x">' + esc(x.title) + '</span><small>' + esc(x.who) + (x.private ? ' · private' : '') + '</small></div>'; };
      html += '<h3 style="font-size:30px;color:var(--text2);margin:0 0 14px">TODAY</h3><div class="list">' + (arr(t.today).map(row).join('') || '<div class="empty">Nothing due today.</div>') + '</div>' +
        '<h3 style="font-size:30px;color:var(--text2);margin:26px 0 14px">ANYTIME</h3><div class="list">' + (arr(t.anytime).map(row).join('') || '<div class="empty">No anytime to-dos.</div>') + '</div>';
    } else if (tab === 'groceries') {
      var g = arr(get(l, 'groceries.toBuy', []));
      html += '<div class="list" style="grid-template-columns:repeat(3,1fr)">' + (g.map(function (x) { return '<div class="item"><span class="x">' + esc(x.name) + '</span></div>'; }).join('') || '<div class="empty">The grocery list is empty.</div>') + '</div>';
    } else {
      html += '<div class="list" style="grid-template-columns:1fr">' + arr(get(l, 'meals.week', [])).map(function (d) {
        var m = arr(d.meals);
        return '<div class="item"><span style="min-width:260px;color:var(--text2);font-weight:700">' + esc(d.label) + '</span><span class="x' + (m.length ? '' : ' muted') + '">' +
          esc(m.length ? m.map(function (x) { return title(x.meal) + ': ' + x.name; }).join(' · ') : 'Not planned') + '</span></div>';
      }).join('') + '</div>';
    }
    return html + '</div></div></div>';
  }

  function haScreen() {
    var hs = arr(data.home);
    hs = hs.filter(function (h) { return h.attention; }).concat(hs.filter(function (h) { return !h.attention; }));
    return '<div class="pane full"><div class="list" style="grid-template-columns:repeat(3,1fr)">' + (hs.map(function (h) {
      return '<div class="item' + (h.attention ? ' attn' : '') + '" style="flex-direction:column;align-items:flex-start;padding:26px 30px"><small>' + esc(h.name) + '</small><span class="s" style="font-size:44px;font-weight:800">' + esc(h.state) + '</span></div>';
    }).join('') || '<div class="empty">Nothing picked from Home Assistant yet.</div>') + '</div></div>';
  }

  // ---- maps: built for the box's real size ----------------------------------------------------
  function paintMap(el, m, scaleTo) {
    var Wm = m.width || 1920, Hm = m.height || 1080, size = m.tileSize || 256, cols = m.cols || 1;
    var html = arr(m.tiles).map(function (t, i) {
      if (!t) return '';
      var x = m.originX + (i % cols) * size, y = m.originY + Math.floor(i / cols) * size;
      return '<img alt="" src="' + esc(t) + '" style="left:' + x + 'px;top:' + y + 'px;width:' + (size + 1) + 'px;height:' + (size + 1) + 'px">';
    }).join('') + '<div class="wash"></div>' + arr(m.pins).map(function (p) {
      return '<div class="pin' + (p.kind === 'home' ? ' home' : '') + '" style="left:' + p.x + 'px;top:' + p.y + 'px"><i style="' + (p.kind === 'home' ? '' : 'background:' + css(p.color)) + '"></i>' + (p.label ? '<span>' + esc(p.label) + '</span>' : '') + '</div>';
    }).join('');
    el.innerHTML = '<div style="position:absolute;left:0;top:0;width:' + Wm + 'px;height:' + Hm + 'px">' + html + '</div>' + (scaleTo ? '' : '<div class="badge">OK for full screen</div>');
  }
  function loadMap(el, who, w, h) {
    var q = new URLSearchParams({ zoom: 'auto', w: String(Math.round(w)), h: String(Math.round(h)) });
    if (who) q.set('who', who);
    return fetch('/api/map/full?' + q.toString(), { cache: 'no-store' }).then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'No map yet.'); return j; }); })
      .then(function (m) { paintMap(el, m); return m; })
      .catch(function (e) { el.innerHTML = '<div class="empty" style="padding:40px">' + esc(e.message) + '</div>'; return null; });
  }
  var paneMapFor = null;
  function afterRender() {
    // the travel map fills its box at the box's own size (in the 1920 x 1080 stage's pixels)
    var pm = $('#paneMap');
    if (pm) {
      var who = nav.tab || get(arr(get(data, 'transport.members', []))[0] || {}, 'id', '');
      if (paneMapFor && paneMapFor.who === who && paneMapFor.html) pm.innerHTML = paneMapFor.html;
      else loadMap(pm, who, pm.offsetWidth, pm.offsetHeight).then(function () { paneMapFor = { who: who, html: pm.innerHTML }; });
    } else paneMapFor = null;
    restoreFocus();
  }

  // ---- full screen: radar, map, the kid picker ------------------------------------------------
  function openFull(kindOf) {
    layer.className = '';
    layer.hidden = false;
    if (kindOf === 'radar') {
      var w = data.weather || {};
      layer.innerHTML = '<div class="map" style="position:absolute;left:0;top:0;width:1920px;height:1080px;border-radius:0">' + radarTiles(w) + '</div>' +
        '<div class="head" style="border-color:var(--info)"><div>Radar</div><b>' + esc(tabName(nav.tab || data.selectedWxLoc || '')) + '</b><div>' + esc(w.condition || '') + '</div></div><div class="back">Back to close</div>';
    } else {
      var who = nav.tab || '';
      layer.innerHTML = '<div class="map" id="fullMap" style="position:absolute;left:0;top:0;width:1920px;height:1080px;border-radius:0"></div><div class="head" id="fmHead"><div>Map</div><b>Loading...</b></div><div class="back">Back to close</div>';
      loadMap($('#fullMap'), who, 1920, 1080).then(function (m) {
        var b = $('#fullMap .badge'); if (b) b.remove();
        if (m) $('#fmHead').innerHTML = '<div>' + esc(m.title || 'Map') + '</div><b>' + esc(m.status || '') + '</b><div>' + esc(m.detail || '') + '</div>';
      });
    }
  }
  var pickFor = null;
  function openPicker(chore) {
    var kids = arr(data.users);
    if (chore.assignedTo) return markDone(chore, String(chore.assignedTo).toLowerCase());
    if (kids.length === 1) return markDone(chore, String(kids[0].id).toLowerCase());
    if (!kids.length) return toast('Add kids in the Family Dashboard app first.');
    pickFor = chore;
    layer.className = 'sheet'; layer.hidden = false;
    layer.innerHTML = '<div class="picker"><h2>Who did “' + esc(chore.title) + '”?</h2><p>' + esc(String(chore.displayReward || '').replace(/^\+/, '')) + ' goes to whoever you pick.</p><div class="kids">' +
      kids.map(function (k) { return '<div class="kid f" data-f="kid-' + esc(k.id) + '" data-kid="' + esc(String(k.id).toLowerCase()) + '"><i class="dot" style="background:' + css(k.colorHex) + '"></i>' + esc(title(k.name)) + '</div>'; }).join('') + '</div></div>';
    focusFirst(layer);
  }
  function closeLayer() { layer.hidden = true; layer.innerHTML = ''; pickFor = null; }
  function markDone(chore, memberId) {
    closeLayer();
    fetch('/api/chores/' + encodeURIComponent(chore.id) + '/done', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ memberId: memberId }) })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'The chore was not saved.'); return j; }); })
      .then(function (j) { toast(j.state === 'earned' ? 'Nice job, ' + title(j.name) + '!' : 'Nice job, ' + title(j.name) + '! A parent will check it in the app.'); load(); })
      .catch(function (e) { toast(e.message); });
  }

  // ---- alerts (doorbell, the bus, events) -------------------------------------------------------
  var seenAlerts = {}, alertTimer = null;
  try { seenAlerts = JSON.parse(store('fd-tv-alerts') || '{}'); } catch (e) { seenAlerts = {}; }
  function showAlerts() {
    var nowS = Date.now() / 1000;
    var a = arr(data.alerts).filter(function (x) { return x.at <= nowS && x.until > nowS && !seenAlerts[x.id]; })[0];
    if (!a) return;
    seenAlerts[a.id] = nowS;
    Object.keys(seenAlerts).forEach(function (k) { if (nowS - seenAlerts[k] > 86400) delete seenAlerts[k]; });
    store('fd-tv-alerts', JSON.stringify(seenAlerts));
    var el = $('#alert');
    el.style.borderColor = css(a.colorHex);
    el.innerHTML = '<b>' + esc(a.title) + '</b><div>' + esc(a.detail || '') + '</div>';
    el.hidden = false;
    if (a.sound) beep();
    clearTimeout(alertTimer);
    alertTimer = setTimeout(function () { el.hidden = true; }, 20000);
  }
  function beep() {
    try {
      var C = window.AudioContext || window.webkitAudioContext; if (!C) return;
      var ctx = new C(), o = ctx.createOscillator(), g = ctx.createGain();
      o.connect(g); g.connect(ctx.destination); o.frequency.value = 880; g.gain.value = 0.08;
      o.start(); o.frequency.setValueAtTime(660, ctx.currentTime + 0.18); o.stop(ctx.currentTime + 0.4);
    } catch (e) { /* no sound here */ }
  }

  // ---- the remote: focus moves to the nearest thing in that direction ----------------------------
  function focusables(root) { return Array.prototype.slice.call((root || stage).querySelectorAll('.f')).filter(function (e) { return e.offsetParent !== null || e === document.activeElement; }); }
  function current() { return stage.querySelector('.f.on'); }
  function setFocus(el) {
    var c = current(); if (c) c.classList.remove('on');
    if (!el) return;
    el.classList.add('on');
    nav.focus = el.getAttribute('data-f');
  }
  function focusFirst(root) { setFocus(focusables(root)[0] || null); }
  function restoreFocus() {
    if (!layer.hidden) return;
    var el = nav.focus ? stage.querySelector('[data-f="' + nav.focus.replace(/"/g, '') + '"]') : null;
    if (!el && nav.view !== 'home') el = stage.querySelector('.tab.sel');
    if (el) setFocus(el); else focusFirst(screenEl);
  }
  function rectOf(el) { var r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, l: r.left, r: r.right, t: r.top, b: r.bottom }; }
  function move(dir) {
    var root = layer.hidden ? screenEl : layer;
    var cur = current();
    var list = focusables(root);
    if (!cur || list.indexOf(cur) < 0) { focusFirst(root); return true; }
    var a = rectOf(cur), best = null, bestScore = Infinity;
    list.forEach(function (el) {
      if (el === cur) return;
      var b = rectOf(el);
      var dx = b.x - a.x, dy = b.y - a.y;
      var ok = dir === 'left' ? b.r <= a.l + 4 : dir === 'right' ? b.l >= a.r - 4 : dir === 'up' ? b.b <= a.t + 4 : b.t >= a.b - 4;
      if (!ok) return;
      var main = dir === 'left' || dir === 'right' ? Math.abs(dx) : Math.abs(dy);
      var cross = dir === 'left' || dir === 'right' ? Math.abs(dy) : Math.abs(dx);
      var score = main + cross * 2.2;
      if (score < bestScore) { bestScore = score; best = el; }
    });
    if (best) { setFocus(best); keepVisible(best); return true; }
    return false;
  }
  // scroll a long list so the focused item stays on screen
  function keepVisible(el) {
    var inner = el.closest ? el.closest('.scroll-inner') : null;
    if (!inner) return;
    var box = inner.parentNode.getBoundingClientRect(), r = el.getBoundingClientRect();
    var s = Math.min(window.innerWidth / W, window.innerHeight / H);
    if (r.bottom > box.bottom) nav.scroll += (r.bottom - box.bottom) / s + 30;
    if (r.top < box.top) nav.scroll -= (box.top - r.top) / s + 30;
    applyScroll(inner);
  }
  function applyScroll(inner) {
    inner = inner || screenEl.querySelector('.scroll-inner');
    if (!inner) return;
    var max = Math.max(0, inner.scrollHeight - inner.parentNode.offsetHeight);
    nav.scroll = Math.max(0, Math.min(max, nav.scroll));
    inner.style.transform = 'translateY(' + (-nav.scroll) + 'px)';
  }
  function scrollBy(px) {
    var inner = screenEl.querySelector('.scroll-inner');
    if (!inner) return false;
    var before = nav.scroll; nav.scroll += px; applyScroll(inner);
    return nav.scroll !== before;
  }

  function switchTab(step) {
    var t = Array.prototype.slice.call(screenEl.querySelectorAll('.tab'));
    if (!t.length) return false;
    var i = Math.max(0, t.indexOf(screenEl.querySelector('.tab.sel')));
    var next = t[(i + step + t.length) % t.length];
    selectTab(next.getAttribute('data-tab'));
    return true;
  }
  function selectTab(id) {
    nav.tab = id; nav.scroll = 0; nav.focus = 'tab-' + id;
    if (nav.view === 'weather') { peekWx = id; load(); }
    render();
  }

  function ok() {
    var el = current();
    if (!el) return;
    if (pickFor && el.getAttribute('data-kid')) return markDone(pickFor, el.getAttribute('data-kid'));
    var goTo = el.getAttribute('data-go');
    if (goTo) {
      var s = SECTION_FOR[goTo];
      return go(s[0] === 'home' ? 'home2' : s[0], s[1]);
    }
    var tab = el.getAttribute('data-tab');
    if (tab) return selectTab(tab);
    var full = el.getAttribute('data-full');
    if (full) return openFull(full);
    var chore = el.getAttribute('data-chore');
    if (chore) { var c = arr(data.chores).filter(function (x) { return String(x.id) === chore; })[0]; if (c) openPicker(c); }
  }

  /** Back: close the full-screen layer, then go Home. Returns false at Home (let the TV leave the app). */
  function back() {
    if (!layer.hidden) { closeLayer(); restoreFocus(); return true; }
    if (nav.view !== 'home') { var from = nav.view; go('home'); nav.focus = null; restoreFocusTo(from); return true; }
    return false;
  }
  function restoreFocusTo(view) {
    var card = Array.prototype.slice.call(screenEl.querySelectorAll('[data-go]')).filter(function (c) { var s = SECTION_FOR[c.getAttribute('data-go')]; return s && (s[0] === view || (view === 'home2' && s[0] === 'home')); })[0];
    if (card) setFocus(card);
  }
  // The Android TV app catches its own Back button and asks the page first.
  window.fdTvBack = back;

  var lastKey = Date.now();
  document.addEventListener('keydown', function (e) {
    lastKey = Date.now();
    var k = e.key, c = e.keyCode;
    var handled = true;
    var onTab = layer.hidden && current() && current().classList.contains('tab');
    if (k === 'ArrowLeft' || c === 37) {
      // on the tabs, Left and Right change the tab right away
      if (onTab) switchTab(-1);
      else if (!move('left') && nav.view !== 'home' && layer.hidden) switchTab(-1);
    } else if (k === 'ArrowRight' || c === 39) {
      if (onTab) switchTab(1);
      else if (!move('right') && nav.view !== 'home' && layer.hidden) switchTab(1);
    } else if (k === 'ArrowUp' || c === 38) {
      if (!move('up')) scrollBy(-360);
    } else if (k === 'ArrowDown' || c === 40) {
      if (!move('down')) scrollBy(360);
    } else if (k === 'Enter' || c === 13) {
      ok();
    } else if (k === 'Escape' || k === 'Backspace' || k === 'GoBack' || k === 'BrowserBack' || c === 27 || c === 8 || c === 461 || c === 10009) {
      // 461: LG webOS Back, 10009: Samsung Tizen Return
      handled = back();
      if (!handled && (c === 461 || c === 10009)) {
        try { if (window.tizen) window.tizen.application.getCurrentApplication().exit(); else if (window.webOS && window.webOS.platformBack) window.webOS.platformBack(); } catch (err) { /* the TV handles it */ }
      }
    } else handled = false;
    if (handled) e.preventDefault();
  });
  // LG's pointer remote: clicking works too
  stage.addEventListener('click', function (e) {
    var el = e.target.closest ? e.target.closest('.f') : null;
    if (el) { setFocus(el); ok(); }
  });

  // after a few minutes without the remote, back to Home (like the Roku)
  setInterval(function () {
    if (Date.now() - lastKey > 3 * 60000 && (nav.view !== 'home' || !layer.hidden)) { closeLayer(); peekWx = null; go('home'); }
  }, 30000);

  // ---- go --------------------------------------------------------------------------------------
  load();
  setInterval(load, 15000);
  setInterval(render, 30000); // the clock
})();
