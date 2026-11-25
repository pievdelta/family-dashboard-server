// The TV page: Family Dashboard for a remote, on LG webOS, Samsung Tizen, Android TV,
// Fire TV or any TV browser. Since server 5.12 it looks and works like the Roku app:
// the clock and weather up top, Home tiles in the Roku's places, section tabs with option
// chips under them, the remote's keys along the bottom, and a white focus ring.
//
// Home: arrows move between tiles, OK opens one. In a section: Left and Right on the tabs
// switch sections, Down reaches the chips (Agenda / Week / Month and so on), OK on a map
// or radar shows it full screen, Back goes Home. Music the server is playing (Spotify or
// AirPlay) plays here too when this TV's layout allows it.
//
// Written for older TV browsers too (LG webOS and Samsung Tizen from about 2019): no
// optional chaining, no CSS grid or flex gap.
(function () {
  'use strict';

  var W = 1920, H = 1080;
  var $ = function (s) { return document.querySelector(s); };
  var stage = $('#stage'), screenEl = $('#screen'), layer = $('#layer');
  var qs = new URLSearchParams(location.search);

  // ---- fit 1920 x 1080 onto any screen ------------------------------------------------------
  var scale = 1;
  function fit() {
    scale = Math.min(window.innerWidth / W, window.innerHeight / H);
    stage.style.transform = 'translate(' + (-W * scale / 2) + 'px,' + (-H * scale / 2) + 'px) scale(' + scale + ')';
  }
  window.addEventListener('resize', fit);
  fit();

  // ---- who this TV is ------------------------------------------------------------------------
  function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; } return v; }
  var tvId = qs.get('tv') || store('fd-tv-id');
  if (!tvId) { tvId = 'tv-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4); store('fd-tv-id', tvId); }
  var ua = navigator.userAgent;
  var model = qs.get('model') || (/Web0S|webOS/i.test(ua) ? 'LG TV' : /Tizen/i.test(ua) ? 'Samsung TV' : /AFT|Fire ?TV/i.test(ua) ? 'Fire TV' : /Android/i.test(ua) ? 'Android TV' : 'TV browser');
  var kind = qs.get('kind') || (/Android/i.test(ua) ? 'android-tv' : 'tv-page');
  var demo = qs.get('demo') === '1';

  // ---- helpers ---------------------------------------------------------------------------------
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function arr(v) { return Array.isArray(v) ? v : []; }
  function css(hex, dflt) { var m = /^0x([0-9a-f]{6})/i.exec(String(hex || '')); return m ? '#' + m[1] : (String(hex || '').charAt(0) === '#' ? hex : (dflt || '#E8623C')); }
  function title(s) { s = String(s || ''); return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase(); }
  function get(o, p, dflt) { var v = o; var a = p.split('.'); for (var i = 0; i < a.length; i++) { if (v == null) return dflt; v = v[a[i]]; } return v == null ? dflt : v; }
  function join(parts) { return parts.filter(function (x) { return x; }).join('  ·  '); }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
  function niceTime(s) { return String(s || '').replace(/^0/, '').replace(/:00(?= ?[AP]M)/i, '').replace(/ ?([AP])M$/i, function (m, x) { return ' ' + x.toUpperCase() + 'M'; }); }
  function inText(mins) {
    if (mins <= 0) return 'now';
    if (mins < 60) return 'in ' + mins + ' min';
    var h = Math.floor(mins / 60), r = mins % 60;
    return r === 0 || h >= 4 ? 'in ' + h + ' h' : 'in ' + h + ' h ' + r + ' min';
  }
  function wxImg(code) {
    var c = String(code || '').toLowerCase();
    var k = /storm|thunder/.test(c) ? 'storm' : /rain|drizzle|shower/.test(c) ? 'rain' : /cloud|overcast|fog|mist/.test(c) ? 'cloud' : 'sun';
    return '/web/wx/' + k + '.png';
  }
  function reward(r) { return String(r || '').replace(/^\+/, '').replace(/\s*POINTS?$/i, ' pts').replace(/m\s*Time$/i, ' min'); }
  var toastTimer = null;
  function toast(msg) {
    var t = $('#toast'); if (!t) { t = document.createElement('div'); t.id = 'toast'; stage.appendChild(t); }
    t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.hidden = true; }, 3500);
  }

  // ---- data from the server --------------------------------------------------------------------
  var data = null, lastOk = 0, problem = null, peekWx = null;
  function load() {
    var q = new URLSearchParams({ tv: tvId, tvKind: kind, tvModel: model });
    if (peekWx) q.set('wx', peekWx);
    return fetch('/api/dashboard?' + q.toString(), { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('The server answered ' + r.status + '.'); return r.json(); })
      .then(function (d) { data = d; nowPlaying = d.music || null; lastOk = Date.now(); problem = null; render(); showAlerts(); syncMusic(); })
      .catch(function (e) { problem = e.message; if (!data) render(); else renderFoot(); });
  }

  // ---- where we are ----------------------------------------------------------------------------
  // view: 'home' or a section; sub: the chip picked in it; focus: the focused element's key
  var nav = { view: 'home', sub: null, focus: null, scroll: 0 };
  var SECTIONS = ['calendar', 'weather', 'travel', 'chores', 'lists', 'home'];
  var NAMES = { calendar: 'Calendar', weather: 'Weather', travel: 'Travel', chores: 'Chores', lists: 'Lists', home: 'Home' };
  // which section (and chip) a Home tile opens
  var OPENS = { next: ['calendar', 'agenda'], today: ['calendar', 'agenda'], weather: ['weather', null], travel: ['travel', null],
    chores: ['chores', null], todos: ['lists', 'todos'], groceries: ['lists', 'groceries'], meals: ['lists', 'meals'], home: ['home', null] };
  function layout() {
    return data && data.layout ? data.layout : { cards: ['next', 'today', 'weather', 'travel', 'chores', 'todos', 'groceries', 'meals', 'home'], sections: SECTIONS.slice(), music: true };
  }
  function sections() {
    return SECTIONS.filter(function (s) { return layout().sections.indexOf(s) >= 0 && (s !== 'home' || arr(data && data.home).length > 0); });
  }
  function canOpen(s) { return sections().indexOf(s) >= 0; }

  function go(view, sub) {
    nav.view = view; nav.sub = sub || null; nav.scroll = 0;
    nav.focus = view === 'home' ? null : 'tab-' + view;
    closeLayer();
    render();
  }

  // ---- drawing ---------------------------------------------------------------------------------
  function render() {
    renderClock();
    if (!data) {
      screenEl.className = 'home';
      screenEl.innerHTML = '<div class="problem"><b>' + (problem ? 'Can\'t reach the family server' : 'Loading...') + '</b><p>' + esc(problem || 'Getting the family\'s day ready.') + '</p></div>';
      renderFoot();
      return;
    }
    if (nav.view !== 'home' && !canOpen(nav.view)) { nav.view = 'home'; nav.focus = null; }
    renderHeader();
    if (nav.view === 'home') {
      screenEl.className = 'home';
      screenEl.innerHTML = homeScreen();
      $('#chips').hidden = true;
    } else {
      screenEl.className = '';
      renderChips();
      screenEl.innerHTML = sectionScreen();
    }
    renderFoot();
    afterRender();
  }

  function renderClock() {
    var now = new Date();
    $('#clock').textContent = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    $('#date').textContent = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  }

  function renderHeader() {
    // the weather summary: on Home it's a door to the Weather screen
    var w = data.homeWeather || data.weather || {};
    var city = get(arr(data.weatherLocations).filter(function (l) { return l.id === data.homeWxLoc; })[0] || arr(data.weatherLocations)[0] || {}, 'name', '');
    var wx = $('#wx');
    wx.hidden = false;
    wx.className = nav.view === 'home' && canOpen('weather') ? 'f' : '';
    wx.setAttribute('data-f', 'wx');
    if (nav.view === 'home' && canOpen('weather')) wx.setAttribute('data-go', 'weather'); else wx.removeAttribute('data-go');
    wx.innerHTML = '<img alt="" src="' + wxImg(w.iconCode || w.condition) + '"><div class="t">' + esc(w.temp != null ? Math.round(w.temp) + '°' : '--') + '</div>' +
      '<div class="c one">' + esc(w.condition || '') + '</div><div class="p one">' + esc(city) + '</div>';
    // section tabs, right-aligned next to the weather (not on Home)
    var tabs = $('#tabs');
    if (nav.view === 'home') { tabs.innerHTML = ''; return; }
    tabs.innerHTML = sections().map(function (s) {
      return '<div class="stab f' + (s === nav.view ? ' sel' : '') + '" data-f="tab-' + s + '" data-section="' + s + '">' + NAMES[s] + '</div>';
    }).join('');
  }

  // ---- Home: the Roku's tiles, laid out from this TV's cards --------------------------------------
  // "Next up" and "Today" take the left column like the Roku (1060 px); the rest stack on the
  // right (648 px). Four or more of those make the left column narrower and the right two columns.
  var WEIGHT = { travel: 250, weather: 238, chores: 286, todos: 286, groceries: 250, meals: 250, home: 250 };
  function homeBoxes(cards) {
    var GAP = 18, HT = 810, FULL = 1728, boxes = [];
    var left = cards.filter(function (c) { return c === 'next' || c === 'today'; });
    var right = cards.filter(function (c) { return c !== 'next' && c !== 'today'; }).slice(0, 8);
    var stack = function (list, x, y, w, h) {
      var sum = 0; list.forEach(function (c) { sum += WEIGHT[c] || 260; });
      var room = h - GAP * (list.length - 1), yy = y;
      list.forEach(function (c, i) {
        var hh = i === list.length - 1 ? y + h - yy : Math.round(room * (WEIGHT[c] || 260) / sum);
        boxes.push({ id: c, x: x, y: yy, w: w, h: hh });
        yy += hh + GAP;
      });
    };
    if (!left.length) {
      // no left column: an even grid
      var n = right.length, rows = n <= 3 ? 1 : 2, cols = Math.ceil(n / rows), cw = (FULL - GAP * (cols - 1)) / cols;
      for (var c = 0; c < cols; c++) stack(right.slice(c * rows, c * rows + rows), Math.round(c * (cw + GAP)), 0, Math.round(cw), HT);
      return boxes;
    }
    var lw = !right.length ? FULL : right.length <= 3 ? 1060 : 700;
    if (left.length === 2) {
      boxes.push({ id: 'next', x: 0, y: 0, w: lw, h: 168 });
      boxes.push({ id: 'today', x: 0, y: 186, w: lw, h: HT - 186 });
    } else boxes.push({ id: left[0], x: 0, y: 0, w: lw, h: HT, tall: true });
    if (right.length) {
      var rx = lw + GAP, rw = FULL - rx, rc = right.length <= 3 ? 1 : 2, per = Math.ceil(right.length / rc), colw = (rw - GAP * (rc - 1)) / rc;
      for (var k = 0; k < rc; k++) stack(right.slice(k * per, k * per + per), Math.round(rx + k * (colw + GAP)), 0, Math.round(colw), HT);
    }
    return boxes;
  }

  function homeScreen() {
    var cards = layout().cards.filter(function (c) { return c !== 'home' || arr(data.home).length; });
    return homeBoxes(cards).map(function (b) {
      var o = OPENS[b.id], open = o && canOpen(o[0]);
      var attrs = open ? ' f" data-f="tile-' + b.id + '" data-go="' + b.id + '"' : '"';
      return '<div class="tile ' + tileClass(b) + attrs + ' style="left:' + b.x + 'px;top:' + b.y + 'px;width:' + b.w + 'px;height:' + b.h + 'px">' + tile(b) + '</div>';
    }).join('');
  }
  function tileClass(b) {
    var c = { next: 'hero', today: 'agenda', travel: 'travel', weather: 'wtile' }[b.id] || 'plain';
    if (b.tall) c += ' tall';
    if (b.id === 'travel' && b.h < 230) c += ' short';
    return c;
  }
  function rowsFit(b) { return Math.max(1, Math.floor((b.h - 78) / 52)); }

  function events() { return arr(get(data, 'calendarViews.todayEvents', data.todayEvents)); }

  // the Roku's reading of today's events: now, next, later, all day
  function todayModel() {
    var nowMs = Date.now(), rows = [], nextIdx = -1, nowIdx = -1;
    events().forEach(function (e) {
      if (!e || (!e.title && !e.timeLabel)) return;
      var st = 'later';
      if (e.isAllDay) st = 'allday';
      else if ((e.startMs || 0) <= nowMs - 5 * 60000) { st = 'now'; nowIdx = rows.length; }
      else if (nextIdx < 0) { st = 'next'; nextIdx = rows.length; }
      rows.push({ title: e.title || '(no title)', time: niceTime(e.timeLabel), state: st, start: e.startMs || 0,
        loc: e.location || '', who: title(e.calendarName || ''), color: css(e.colorHex) });
    });
    return { rows: rows, nextIdx: nextIdx, nowIdx: nowIdx };
  }

  function tile(b) {
    var d = data, t;
    if (b.id === 'next') {
      var mdl = todayModel(), r, eb, tag = '', soon = false, meta, bar = '#2A4337', ebColor = 'var(--text3)', ti;
      if (mdl.nextIdx >= 0) {
        r = mdl.rows[mdl.nextIdx];
        var delta = Math.round((r.start - Date.now()) / 60000);
        eb = delta <= 5 ? 'STARTING NOW' : 'NEXT UP'; ebColor = 'var(--accent)';
        if (delta > 5) { tag = inText(delta); soon = delta <= 30; }
        ti = r.title; meta = join([r.time, r.loc, r.who]); bar = r.color;
      } else if (mdl.nowIdx >= 0) {
        r = mdl.rows[mdl.nowIdx];
        eb = 'HAPPENING NOW'; ebColor = 'var(--good)'; ti = r.title; meta = join(['Started ' + r.time, r.loc, r.who]); bar = r.color;
      } else {
        var other = arr(get(d, 'calendarViews.list', d.calendar)).filter(function (e) { return e && e.title; })[0];
        eb = mdl.rows.length ? 'REST OF TODAY' : 'TODAY';
        ti = mdl.rows.length ? 'Nothing else scheduled' : 'Nothing on the calendar';
        meta = other ? 'Coming up: ' + join([other.dateLabel + (other.isAllDay ? ', all day' : ' at ' + niceTime(other.timeLabel)), other.title]) : '';
      }
      return '<div class="bar" style="background:' + bar + '"></div><div class="eb" style="color:' + ebColor + '">' + eb + '</div>' +
        (tag ? '<div class="tag' + (soon ? ' soon' : '') + '">' + esc(tag) + '</div>' : '') +
        '<div class="ti one' + (ti.length > 32 && !b.tall ? ' long' : '') + '">' + esc(ti) + '</div><div class="me one">' + esc(meta) + '</div>';
    }
    if (b.id === 'today') {
      var m2 = todayModel(), timed = [], allDay = [];
      m2.rows.forEach(function (x) { if (x.state === 'allday') allDay.push(x.title); else timed.push(x); });
      var cap = Math.max(1, Math.floor((b.h - (allDay.length ? 116 : 70) - 10) / 54));
      var nextAt = -1; timed.forEach(function (x, i) { if (x.state === 'next' && nextAt < 0) nextAt = i; });
      var first = 0, later = 0, show = timed.length;
      if (timed.length > cap) {
        first = Math.max(0, Math.min(timed.length - cap, (nextAt < 0 ? timed.length - cap : nextAt - 1)));
        show = cap;
        if (first + cap < timed.length) { show = cap - 1; later = timed.length - (first + show); }
      }
      var wide = b.w > 900;
      var row = function (x, cls) {
        return '<div class="ar ' + (cls || x.state) + '"><span class="tm">' + esc(x.time) + '</span>' + (x.color ? '<i style="background:' + x.color + '"></i>' : '') +
          '<span class="ti one">' + esc(x.title) + '</span>' + (wide && x.loc ? '<span class="lo one">' + esc(x.loc) + '</span>' : '') + '</div>';
      };
      var html = '';
      if (!m2.rows.length) html += '<div class="ar headrow"><span class="tm"></span><span class="ti">Nothing else today</span></div>';
      timed.slice(first, first + show).forEach(function (x) { html += row(x); });
      if (later) html += '<div class="ar more"><span class="tm"></span><span class="ti">+ ' + later + ' more later today</span></div>';
      // a light day leaves room at the bottom, so tomorrow fills it
      var used = (m2.rows.length ? show : 1) + (later ? 1 : 0), room = cap - used;
      if (!later && room >= 3) {
        var tmr = tomorrowRows(room - 1);
        html += '<div class="ar headrow"><span class="tm"></span><span class="ti">Tomorrow</span>' + (wide ? '<span class="lo">' + esc(tmr.day) + '</span>' : '') + '</div>';
        tmr.rows.forEach(function (x) { html += row(x, 'tmr'); });
      }
      var total = Math.max(m2.rows.length, d.todayTotal || 0);
      return '<div class="head"><b>Today</b><span>' + (total ? (total === 1 ? '1 event left today' : total + ' events left today') : '') + '</span></div>' +
        (allDay.length ? '<div class="allday"><em>All day</em><span class="one">' + esc(allDay.join('  ·  ')) + '</span></div>' : '') +
        '<div class="alist' + (allDay.length ? ' below' : '') + '">' + html + '</div>';
    }
    if (b.id === 'travel') {
      var bus = d.bus || {}, trip = soonestTrip(), eb2, st = '', big = '', ft = '', ebc = 'var(--text3)', bigc = '', ftc = '';
      if (bus.isActive) {
        var riders = arr(bus.riders).map(function (x) { return String(x).toUpperCase(); });
        eb2 = 'BUS' + (riders.length && riders.length <= 2 ? '  ·  ' + riders.join(' & ') : ''); ebc = 'var(--good)';
        st = bus.status || ''; big = bus.distanceLabel || bus.eta || '';
        if (bus.distanceFt != null && bus.distanceFt <= 2000) bigc = 'var(--good)';
        ft = trip ? 'Next trip: leave by ' + trip.leaveBy : bus.lastUpdated ? 'Position as of ' + bus.lastUpdated : '';
      } else if (trip) {
        eb2 = 'NEXT TRIP' + (trip.who ? '  ·  ' + trip.who.toUpperCase() : ''); ebc = 'var(--accent)';
        st = join([trip.title, trip.time, trip.loc]); big = 'Leave by ' + trip.leaveBy;
        ft = trip.remain <= 0 ? join([trip.drive, 'time to go']) : join([trip.drive, inText(trip.remain)]);
        if (trip.remain <= 15) { bigc = 'var(--warn)'; ftc = 'var(--warn)'; }
      } else {
        var mem = arr(get(d, 'transport.members', [])).filter(function (x) { return x.primaryName; })[0];
        if (mem) { eb2 = 'USUAL TRIP  ·  ' + String(mem.name || '').toUpperCase(); st = 'To ' + mem.primaryName; big = mem.primaryDriveLabel || ''; ft = 'No trips with an address in the next day'; }
        else { eb2 = 'TRAVEL'; st = 'No trips coming up.'; }
      }
      return '<div class="eb one" style="color:' + ebc + '">' + esc(eb2) + '</div><div class="st">' + esc(st) + '</div>' +
        '<div class="big one"' + (bigc ? ' style="color:' + bigc + '"' : '') + '>' + esc(big) + '</div><div class="ft one"' + (ftc ? ' style="color:' + ftc + '"' : '') + '>' + esc(ft) + '</div>';
    }
    if (b.id === 'weather') {
      var w = d.homeWeather || d.weather || {}, hourly = arr(w.hourly), n = Math.max(3, Math.min(5, Math.floor((b.w - 48) / 116)));
      if (b.h < 230) {
        // short tile: one line per hour
        var fitRows = Math.max(1, Math.floor((b.h - 70) / 46));
        return '<div class="adv one">' + esc(advice(w)) + '</div><div class="rows">' + hourly.slice(0, fitRows).map(function (h) {
          var pp = Math.round(h.pop || 0);
          return '<div class="r" style="height:46px"><span class="d">' + esc(niceTime(h.time)) + '</span><img alt="" src="' + wxImg(h.icon) + '" style="width:36px;height:36px;margin-right:14px"><b class="x">' + esc(h.temp != null ? Math.round(h.temp) + '°' : '') + '</b><span class="w"' + (pp >= 30 ? ' style="color:var(--info)"' : '') + '>' + (h.pop != null ? pp + '%' : '') + '</span></div>';
        }).join('') + '</div>';
      }
      return '<div class="adv one">' + esc(advice(w)) + '</div><div class="cols">' + hourly.slice(0, n).map(function (h) {
        var p = Math.round(h.pop || 0);
        return '<div class="col"><small>' + esc(niceTime(h.time)) + '</small><img alt="" src="' + wxImg(h.icon) + '"><b>' + esc(h.temp != null ? Math.round(h.temp) + '°' : '') + '</b><span class="' + (p >= 30 ? 'wet' : '') + '">' + (h.pop != null ? p + '%' : '') + '</span></div>';
      }).join('') + '</div>';
    }
    if (b.id === 'chores') {
      var ch = arr(d.chores).filter(function (x) { return x && x.title; }), fit1 = rowsFit(b);
      return '<div class="head"><b>Chores up for grabs</b><span>' + (ch.length ? ch.length + ' open' : '') + '</span></div><div class="rows">' +
        (ch.length ? ch.slice(0, fit1).map(function (x) { return '<div class="r"><span class="x one">' + esc(x.title) + '</span><span class="k">' + esc(reward(x.displayReward)) + '</span></div>'; }).join('')
          : '<div class="empty">All caught up. Nothing open right now.</div>') + '</div>';
    }
    if (b.id === 'todos') {
      t = get(d, 'lists.todos', {});
      var all = arr(t.today).concat(arr(t.anytime));
      return '<div class="head"><b>To-dos</b><span>' + (all.length ? all.length + ' open' : '') + '</span></div><div class="rows">' +
        (all.length ? all.slice(0, rowsFit(b)).map(function (x) { return '<div class="r"><span class="x one">' + esc(x.title) + '</span><span class="w">' + esc(x.who) + '</span></div>'; }).join('')
          : '<div class="empty">Nothing to do. Enjoy it.</div>') + '</div>';
    }
    if (b.id === 'groceries') {
      var g = arr(get(d, 'lists.groceries.toBuy', []));
      return '<div class="head"><b>Grocery list</b><span>' + (g.length ? g.length + ' to buy' : '') + '</span></div><div class="rows">' +
        (g.length ? '<div class="words">' + g.map(function (x) { return esc(x.name); }).join('  ·  ') + '</div>' : '<div class="empty">The list is empty.</div>') + '</div>';
    }
    if (b.id === 'meals') {
      var wk = arr(get(d, 'lists.meals.week', []));
      return '<div class="head"><b>Meals</b><span></span></div><div class="rows">' + wk.slice(0, rowsFit(b)).map(function (day) {
        var ms = arr(day.meals);
        return '<div class="r"><span class="d">' + esc(day.label) + '</span><span class="x one"' + (ms.length ? '' : ' style="color:var(--text3)"') + '>' + esc(ms.length ? ms.map(function (x) { return x.name; }).join(', ') : 'Not planned') + '</span></div>';
      }).join('') + '</div>';
    }
    if (b.id === 'home') {
      var hs = arr(d.home), attn = hs.filter(function (h) { return h.attention; });
      return '<div class="head"><b>Home</b><span' + (attn.length ? ' style="color:var(--warn)"' : '') + '>' + (attn.length ? 'Needs a look' : 'All good') + '</span></div><div class="rows">' +
        attn.concat(hs.filter(function (h) { return !h.attention; })).slice(0, rowsFit(b)).map(function (h) {
          return '<div class="r"><span class="x one">' + esc(h.name) + '</span><span class="k" style="color:' + (h.attention ? 'var(--warn)' : 'var(--text2)') + '">' + esc(h.state) + '</span></div>';
        }).join('') + '</div>';
    }
    return '';
  }

  function tomorrowRows(cap) {
    var t = new Date(); t.setDate(t.getDate() + 1);
    var y = t.getFullYear(), m = t.getMonth(), dd = t.getDate(), out = [], day = '', more = 0;
    arr(get(data, 'calendarViews.list', data.calendar)).forEach(function (e) {
      if (!e || !e.title || !e.startMs) return;
      var s = new Date(e.startMs);
      if (s.getFullYear() !== y || s.getMonth() !== m || s.getDate() !== dd) return;
      if (!day) day = e.dateLabel || '';
      if (out.length < cap) out.push({ title: e.title, time: e.isAllDay ? 'All day' : niceTime(e.timeLabel), loc: e.location || '', color: css(e.colorHex) });
      else more++;
    });
    if (!out.length) out.push({ title: 'Nothing scheduled', time: '', loc: '', color: '' });
    else if (more) out[out.length - 1] = { title: '+ ' + (more + 1) + ' more tomorrow', time: '', loc: '', color: '' };
    return { day: day, rows: out };
  }

  function soonestTrip() {
    var best = null, now = new Date(), nowMin = now.getHours() * 60 + now.getMinutes();
    arr(get(data, 'transport.members', [])).forEach(function (m) {
      var t = m.nextEventTrip; if (!t) return;
      var mm = /^(\d{1,2}):(\d{2})\s*([AP])M/i.exec(String(t.leaveBy || ''));
      if (!mm) return;
      var mins = (Number(mm[1]) % 12 + (mm[3].toUpperCase() === 'P' ? 12 : 0)) * 60 + Number(mm[2]);
      if (mins < nowMin - 10) return;
      if (!best || mins < best.mins) best = { mins: mins, remain: mins - nowMin, leaveBy: t.leaveBy, title: t.eventTitle, time: t.eventTime, loc: t.location, drive: t.driveLabel, who: title(m.name) };
    });
    return best;
  }

  // the Roku's one-line weather advice for the next few hours
  function advice(w) {
    var hourly = arr(w.hourly).slice(0, 6), best = -1, bestT = '', storm = '';
    if (!hourly.length) return w.condition || '';
    hourly.forEach(function (h) {
      var p = Math.round(h.pop || 0);
      if (String(h.icon).toLowerCase() === 'storm' && !storm) storm = h.time;
      if ((p >= 50 && best < 50) || (best < 50 && p > best)) { best = p; bestT = h.time; }
    });
    var when = function (t) { return String(t).toLowerCase() === 'now' ? 'right now' : 'around ' + niceTime(t); };
    if (storm) return 'Storms possible ' + when(storm);
    if (best >= 50) return 'Rain likely ' + when(bestT) + ' (' + best + '%)';
    if (best >= 30) return 'Some chance of rain ' + when(bestT) + ' (' + best + '%)';
    return 'No rain expected for the next few hours';
  }

  // ---- sections ------------------------------------------------------------------------------
  function chipsFor(view) {
    if (view === 'calendar') return [{ id: 'agenda', name: 'Agenda' }, { id: 'week', name: 'Week' }, { id: 'month', name: 'Month' }];
    if (view === 'weather') { var locs = arr(data.weatherLocations); return locs.length > 1 ? locs.map(function (l) { return { id: l.id, name: l.name }; }) : []; }
    if (view === 'travel') { var ms = arr(get(data, 'transport.members', [])); return ms.length > 1 ? ms.map(function (m) { return { id: m.id, name: title(m.name), color: css(m.colorHex) }; }) : []; }
    if (view === 'lists') return [{ id: 'todos', name: 'To-dos' }, { id: 'groceries', name: 'Groceries' }, { id: 'meals', name: 'Meals' }];
    return [];
  }
  function currentSub() {
    var c = chipsFor(nav.view);
    if (nav.sub && c.some(function (x) { return x.id === nav.sub; })) return nav.sub;
    if (nav.view === 'weather') return data.selectedWxLoc || (c[0] && c[0].id) || null;
    if (nav.view === 'travel') return get(data, 'transport.selectedMemberId', null) || (c[0] && c[0].id) || null;
    return c[0] ? c[0].id : null;
  }
  function renderChips() {
    var c = chipsFor(nav.view), el = $('#chips'), sub = currentSub();
    el.hidden = !c.length && !context();
    el.innerHTML = c.map(function (x) {
      var sel = x.id === sub;
      return '<div class="chip f' + (sel ? ' sel' : '') + '" data-f="chip-' + esc(x.id) + '" data-chip="' + esc(x.id) + '"' + (sel && x.color ? ' style="background:' + x.color + '"' : '') + '>' +
        (x.color && !sel ? '<i style="background:' + x.color + '"></i>' : '') + esc(x.name) + '</div>';
    }).join('') + '<span class="ctx">' + esc(context()) + '</span>';
  }
  function context() {
    if (nav.view === 'calendar') return currentSub() === 'month' ? get(data, 'calendarViews.monthTitle', '') : '';
    if (nav.view === 'weather') { var w = data.weather || {}; return w.high != null ? 'High ' + w.high + '°  ·  Low ' + w.low + '°' : ''; }
    if (nav.view === 'chores') { var n = arr(data.chores).length; return n ? n + ' open' : ''; }
    if (nav.view === 'lists') { var t = get(data, 'lists.todos.count', 0), g = get(data, 'lists.groceries.count', 0); return join([plural(t, 'to-do', 'to-dos'), g + ' to buy']); }
    return '';
  }

  function sectionScreen() {
    var sub = currentSub();
    if (nav.view === 'calendar') return calendarScreen(sub);
    if (nav.view === 'weather') return weatherScreen();
    if (nav.view === 'travel') return travelScreen(sub);
    if (nav.view === 'chores') return choresScreen();
    if (nav.view === 'lists') return listsScreen(sub);
    if (nav.view === 'home') return haScreen();
    return '';
  }

  function calendarScreen(sub) {
    var v = data.calendarViews || {}, nowMs = Date.now();
    if (sub === 'week') {
      return '<div class="week">' + arr(v.weekDays).map(function (d) {
        return '<div class="wd' + (d.isToday ? ' today' : '') + '"><h4><span>' + esc(d.dayName) + '</span><span>' + esc(d.dateNum) + '</span></h4>' + arr(d.richEvents).map(function (e) {
          return '<div class="e" style="border-color:' + css(e.colorHex) + '"><b>' + esc(e.isAllDay ? 'All day' : niceTime(e.timeLabel)) + '</b><span>' + esc(e.title) + '</span></div>';
        }).join('') + '</div>';
      }).join('') + '</div>';
    }
    if (sub === 'month') {
      var cells = arr(v.monthCells), rows = [];
      for (var i = 0; i < cells.length; i += 7) rows.push(cells.slice(i, i + 7));
      return '<div class="month"><div class="hrow">' + ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(function (x) { return '<div>' + x + '</div>'; }).join('') + '</div>' +
        rows.map(function (r) {
          return '<div class="wrow">' + r.map(function (c) {
            return '<div class="mc' + (c.inMonth ? '' : ' out') + (c.isToday ? ' today' : '') + '"><div class="n">' + esc(c.dayNum) + '</div>' + arr(c.preview).map(function (p, k) {
              return '<div class="p" style="border-color:' + css(arr(c.previewColors)[k]) + '">' + esc(p) + '</div>';
            }).join('') + '</div>';
          }).join('') + '</div>';
        }).join('') + '</div>';
    }
    var groups = [{ label: 'TODAY', evs: arr(v.todayEvents) }], byDay = {}, order = [];
    arr(v.list).forEach(function (e) { if (!byDay[e.dateLabel]) { byDay[e.dateLabel] = []; order.push(e.dateLabel); } byDay[e.dateLabel].push(e); });
    order.forEach(function (k) { groups.push({ label: String(k).toUpperCase(), evs: byDay[k] }); });
    return '<div class="scroll"><div class="scroll-inner agenda-full">' + groups.map(function (g) {
      return '<div class="day">' + esc(g.label) + '</div>' + (g.evs.map(function (e) {
        return '<div class="ev' + (!e.isAllDay && e.endMs && e.endMs < nowMs ? ' past' : '') + '"><span class="tm">' + esc(e.isAllDay ? 'All day' : niceTime(e.timeLabel)) + '</span><i style="background:' + css(e.colorHex) + '"></i><span class="ti one">' + esc(e.title) + '</span><span class="who">' + esc(join([e.location, title(e.calendarName)])) + '</span></div>';
      }).join('') || '<div class="empty">Nothing on the calendar</div>');
    }).join('') + '</div></div>';
  }

  function weatherScreen() {
    var w = data.weather || {};
    return '<div class="split"><div class="card wxnow">' +
      '<div class="row1"><div class="big">' + esc(w.temp != null ? Math.round(w.temp) + '°' : '--') + '</div><img alt="" src="' + wxImg(w.iconCode || w.condition) + '"></div>' +
      '<div class="cond">' + esc(w.condition || '') + '</div><div class="sub">' + esc(advice(w)) + '</div>' +
      '<div class="hours">' + arr(w.hourly).slice(0, 8).map(function (h) { return '<div>' + esc(niceTime(h.time)) + '<img alt="" src="' + wxImg(h.icon) + '"><b>' + esc(Math.round(h.temp)) + '°</b>' + (h.pop ? esc(Math.round(h.pop)) + '%' : '&nbsp;') + '</div>'; }).join('') + '</div>' +
      '<div class="days">' + arr(w.daily).slice(0, 7).map(function (x) { return '<div>' + esc(title(x.dayName)) + '<img alt="" src="' + wxImg(x.icon) + '"><b>' + esc(x.high) + '°</b>' + esc(x.low) + '°</div>'; }).join('') + '</div></div>' +
      '<div class="map f ring" data-f="radar" data-full="radar">' + radarTiles(w) + '<div class="badge">Radar  ·  OK for full screen</div></div></div>';
  }
  function radarTiles(w) {
    var base = arr(w.radarBaseTiles), over = arr(w.radarOverlayTiles);
    if (!base.length) return '<div class="empty" style="padding:40px">No radar for this place.</div>';
    return '<div class="radar">' + base.map(function (b, i) {
      return '<div class="cell" style="left:' + (i % 3) * 33.33 + '%;top:' + Math.floor(i / 3) * 33.33 + '%"><img alt="" src="' + esc(b) + '">' + (over[i] ? '<img alt="" src="' + esc(over[i]) + '" style="opacity:.75">' : '') + '</div>';
    }).join('') + '</div>';
  }

  function travelScreen(sub) {
    var ms = arr(get(data, 'transport.members', []));
    var m = ms.filter(function (x) { return x.id === sub; })[0] || ms[0] || {};
    var bus = data.bus || {}, t = m.nextEventTrip, html;
    if (m.hasBus && String(m.activeMode).toUpperCase() !== 'CAR' && bus.isActive) {
      html = '<div class="lbl" style="color:var(--good)">SCHOOL BUS</div><div style="font-size:56px;font-weight:700">' + esc(bus.distanceLabel || bus.eta || '') + '</div><div class="sub" style="font-size:28px;color:var(--text2);margin-top:8px">' + esc(bus.status || '') + '</div>';
    } else if (t) {
      html = '<div class="lbl" style="color:var(--accent)">NEXT TRIP</div><div style="font-size:36px;font-weight:700">' + esc(t.eventTitle) + '</div><div style="font-size:28px;color:var(--text2);margin-top:8px">' + esc(join([t.eventTime, t.location])) + '</div>' +
        '<div style="font-size:52px;font-weight:700;margin-top:26px">Leave by ' + esc(t.leaveBy) + '</div><div style="font-size:28px;color:var(--text2)">' + esc(t.driveLabel) + ' drive</div>';
    } else {
      html = '<div class="lbl">USUAL TRIP</div><div style="font-size:36px;font-weight:700">' + esc(m.primaryName || 'No trips coming up') + '</div><div style="font-size:28px;color:var(--text2);margin-top:8px">' + esc(m.primaryDriveLabel || '') + '</div>';
    }
    if (m.scheduleNote) html += '<div style="font-size:26px;color:var(--text3);margin-top:24px">' + esc(m.scheduleNote) + '</div>';
    return '<div class="split"><div class="card"><h3>' + esc(title(m.name || '')) + '</h3>' + html + '</div>' +
      '<div class="map f ring" data-f="map" data-full="map" id="paneMap"><div class="empty" style="padding:40px">Loading the map...</div></div></div>';
  }

  function choresScreen() {
    var ch = arr(data.chores), kids = arr(data.users);
    var nameOf = function (id) { var k = kids.filter(function (x) { return String(x.id).toLowerCase() === String(id || '').toLowerCase(); })[0]; return k ? title(k.name) : ''; };
    var item = function (c) {
      return '<div class="item f" data-f="chore-' + esc(c.id) + '" data-chore="' + esc(c.id) + '"><span class="x one">' + esc(c.title) + '</span>' + (c.assignedTo ? '<small>' + esc(nameOf(c.assignedTo)) + '</small>' : '') + '<span class="r">' + esc(reward(c.displayReward)) + '</span></div>';
    };
    var mine = ch.filter(function (c) { return c.assignedTo; }), b = ch.filter(function (c) { return !c.assignedTo; });
    return '<div class="scroll"><div class="scroll-inner">' +
      '<div class="kids">' + kids.map(function (k) { return '<div class="kid"><i style="background:' + css(k.colorHex) + '"></i>' + esc(title(k.name)) + '<small>' + esc(k.earnedLabel || ((k.earnedPoints || 0) + ' points')) + '</small></div>'; }).join('') + '</div>' +
      '<div class="lbl">CHORES  ·  OK WHEN IT\'S DONE</div><div class="list">' + (mine.map(item).join('') || '<div class="empty">All caught up.</div>') + '</div>' +
      '<div class="lbl" style="margin-top:18px">BOUNTIES  ·  ANY KID, FIRST ONE DONE EARNS IT</div><div class="list">' + (b.map(item).join('') || '<div class="empty">No bounties right now.</div>') + '</div>' +
      '</div></div>';
  }

  function listsScreen(sub) {
    var l = data.lists || {}, html = '<div class="scroll"><div class="scroll-inner">';
    if (sub === 'groceries') {
      var g = arr(get(l, 'groceries.toBuy', []));
      html += '<div class="list three">' + (g.map(function (x) { return '<div class="item"><span class="x one">' + esc(x.name) + '</span></div>'; }).join('') || '<div class="empty">The grocery list is empty.</div>') + '</div>';
    } else if (sub === 'meals') {
      html += '<div class="list one">' + arr(get(l, 'meals.week', [])).map(function (d) {
        var m = arr(d.meals);
        return '<div class="item"><span class="lab">' + esc(d.label) + '</span><span class="x one"' + (m.length ? '' : ' style="color:var(--text3)"') + '>' +
          esc(m.length ? m.map(function (x) { return title(x.meal) + ': ' + x.name; }).join('  ·  ') : 'Not planned') + '</span></div>';
      }).join('') + '</div>';
    } else {
      var t = l.todos || {};
      var row = function (x) { return '<div class="item"><span class="x one">' + esc(x.title) + '</span><small>' + esc(x.who) + (x.private ? '  ·  private' : '') + '</small></div>'; };
      html += '<div class="lbl">TODAY</div><div class="list">' + (arr(t.today).map(row).join('') || '<div class="empty">Nothing due today.</div>') + '</div>' +
        '<div class="lbl" style="margin-top:18px">ANYTIME</div><div class="list">' + (arr(t.anytime).map(row).join('') || '<div class="empty">No anytime to-dos.</div>') + '</div>';
    }
    return html + '</div></div>';
  }

  function haScreen() {
    var hs = arr(data.home);
    hs = hs.filter(function (h) { return h.attention; }).concat(hs.filter(function (h) { return !h.attention; }));
    return '<div class="list three">' + (hs.map(function (h) {
      return '<div class="item tall' + (h.attention ? ' attn' : '') + '"><small style="margin:0">' + esc(h.name) + '</small><span class="s" style="font-size:40px;font-weight:700">' + esc(h.state) + '</span></div>';
    }).join('') || '<div class="empty">Nothing picked from Home Assistant yet.</div>') + '</div>';
  }

  // ---- footer: the remote's keys, and the connection or what's playing ----------------------------
  function renderFoot() {
    var hints = [];
    if (!layer.hidden && pickFor) hints = [['ARROWS', 'Move'], ['OK', 'Choose'], ['BACK', 'Close']];
    else if (!layer.hidden) hints = [['BACK', 'Close']];
    else if (nav.view === 'home') {
      var cur = current(), goTo = cur && cur.getAttribute('data-go');
      hints.push(['ARROWS', 'Move']);
      if (goTo && !document.body.classList.contains('idle')) hints.push(['OK', 'Open ' + (goTo === 'weather' ? 'Weather' : NAMES[OPENS[goTo][0]])]);
      else hints = [['ARROWS', 'Pick a section to open']];
    } else {
      hints.push(['BACK', 'Home']);
      hints.push(['LEFT / RIGHT', 'Switch screen']);
      if (nav.view === 'travel') hints.push(['OK', 'Full-screen map']);
      if (nav.view === 'weather') hints.push(['OK', 'Full-screen radar']);
      if (nav.view === 'chores' && arr(data && data.chores).length) hints.push(['OK', 'Check off a chore']);
      if (chipsFor(nav.view).length) hints.push(['DOWN', 'Options']);
    }
    if (musicBlocked) hints.unshift(['OK', 'Play the music']);
    $('#hint').innerHTML = hints.map(function (h) { return '<span class="k">' + esc(h[0]) + '</span><span class="d">' + esc(h[1]) + '</span>'; }).join('');

    var st = $('#status');
    var np = nowPlaying && nowPlaying.playing && nowPlaying.title && layout().music !== false ? nowPlaying : null;
    if (np) {
      st.innerHTML = (np.art ? '<img alt="" src="' + esc(np.art) + '">' : '') + '<span class="np">&#9835;&nbsp; <b>' + esc(np.title) + '</b>' + (np.artist ? '  ·  ' + esc(np.artist) : '') + '</span>';
      return;
    }
    var txt, col;
    if (demo) { txt = 'Demo data  ·  not your family\'s real schedule'; col = 'var(--warn)'; }
    else if (problem && !data) { txt = 'Not connected'; col = 'var(--alert)'; }
    else if (problem) { txt = 'Offline  ·  showing what we had'; col = 'var(--alert)'; }
    else if (!data) { txt = 'Connecting...'; col = 'var(--text3)'; }
    else if (Date.now() - lastOk > 75000) { txt = 'Updated ' + Math.round((Date.now() - lastOk) / 60000) + ' min ago'; col = 'var(--warn)'; }
    else { txt = 'Up to date'; col = 'var(--good)'; }
    st.innerHTML = '<span style="color:' + (col === 'var(--good)' || col === 'var(--text3)' ? 'var(--text3)' : col) + '">' + esc(txt) + '</span><i style="background:' + col + '"></i>';
  }

  // ---- maps: built for the box's real size -------------------------------------------------------
  function paintMap(el, m, full) {
    var size = m.tileSize || 256, cols = m.cols || 1;
    var html = arr(m.tiles).map(function (t, i) {
      if (!t) return '';
      var x = m.originX + (i % cols) * size, y = m.originY + Math.floor(i / cols) * size;
      return '<img alt="" src="' + esc(t) + '" style="left:' + x + 'px;top:' + y + 'px;width:' + (size + 1) + 'px;height:' + (size + 1) + 'px">';
    }).join('') + '<div class="wash"></div>' + arr(m.pins).map(function (p) {
      return '<div class="pin' + (p.kind === 'home' ? ' home' : '') + '" style="left:' + p.x + 'px;top:' + p.y + 'px"><i style="' + (p.kind === 'home' ? '' : 'background:' + css(p.color)) + '"></i>' + (p.label ? '<span>' + esc(p.label) + '</span>' : '') + '</div>';
    }).join('');
    el.innerHTML = '<div style="position:absolute;left:0;top:0;width:' + (m.width || 1920) + 'px;height:' + (m.height || 1080) + 'px">' + html + '</div>' + (full ? '' : '<div class="badge">OK for full screen</div>');
  }
  function loadMap(el, who, w, h, full) {
    var q = new URLSearchParams({ zoom: 'auto', w: String(Math.round(w)), h: String(Math.round(h)) });
    if (who) q.set('who', who);
    return fetch('/api/map/full?' + q.toString(), { cache: 'no-store' }).then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'No map yet.'); return j; }); })
      .then(function (m) { paintMap(el, m, full); return m; })
      .catch(function (e) { el.innerHTML = '<div class="empty" style="padding:40px">' + esc(e.message) + '</div>'; return null; });
  }
  var paneMapFor = null;
  function afterRender() {
    var pm = $('#paneMap');
    if (pm) {
      var who = currentSub() || '';
      if (paneMapFor && paneMapFor.who === who && paneMapFor.html) pm.innerHTML = paneMapFor.html;
      else loadMap(pm, who, pm.offsetWidth, pm.offsetHeight).then(function () { paneMapFor = { who: who, html: pm.innerHTML }; });
    } else paneMapFor = null;
    applyScroll();
    restoreFocus();
  }

  // ---- full screen: radar, map, the kid picker -----------------------------------------------------
  function openFull(what) {
    layer.className = ''; layer.hidden = false;
    if (what === 'radar') {
      var w = data.weather || {};
      layer.innerHTML = '<div class="map" style="position:absolute;left:0;top:0;width:1920px;height:1080px;border-radius:0">' + radarTiles(w) + '</div>' +
        '<div class="head" style="border-color:var(--info)"><div>Radar</div><b>' + esc(w.condition || 'Weather') + '</b><div>' + esc(advice(w)) + '</div></div><div class="back">BACK to close</div>';
    } else {
      layer.innerHTML = '<div class="map" id="fullMap" style="position:absolute;left:0;top:0;width:1920px;height:1080px;border-radius:0"></div><div class="head" id="fmHead"><div>Map</div><b>Loading...</b></div><div class="back">BACK to close</div>';
      loadMap($('#fullMap'), currentSub() || '', 1920, 1080, true).then(function (m) {
        if (m) $('#fmHead').innerHTML = '<div>' + esc(m.title || 'Map') + '</div><b>' + esc(m.status || '') + '</b><div>' + esc(m.detail || '') + '</div>';
      });
    }
    renderFoot();
  }
  var pickFor = null;
  function openPicker(chore) {
    var kids = arr(data.users);
    if (chore.assignedTo) return markDone(chore, String(chore.assignedTo).toLowerCase());
    if (kids.length === 1) return markDone(chore, String(kids[0].id).toLowerCase());
    if (!kids.length) return toast('Add kids in the Family Dashboard app first.');
    pickFor = chore;
    layer.className = 'sheet'; layer.hidden = false;
    layer.innerHTML = '<div class="picker"><h2>Who did "' + esc(chore.title) + '"?</h2><p>' + esc(reward(chore.displayReward)) + ' goes to whoever you pick.</p><div class="kids">' +
      kids.map(function (k) { return '<div class="kid f" data-f="kid-' + esc(k.id) + '" data-kid="' + esc(String(k.id).toLowerCase()) + '"><i style="background:' + css(k.colorHex) + '"></i>' + esc(title(k.name)) + '</div>'; }).join('') + '</div></div>';
    setFocus(focusables(layer)[0] || null);
    renderFoot();
  }
  function closeLayer() { layer.hidden = true; layer.innerHTML = ''; pickFor = null; }
  function markDone(chore, memberId) {
    closeLayer();
    fetch('/api/chores/' + encodeURIComponent(chore.id) + '/done', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ memberId: memberId }) })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'The chore was not saved.'); return j; }); })
      .then(function (j) { toast(j.state === 'earned' ? 'Nice job, ' + title(j.name) + '!' : 'Nice job, ' + title(j.name) + '! Waiting for a parent\'s OK.'); load(); })
      .catch(function (e) { toast(e.message); });
  }

  // ---- alerts (the doorbell, the bus, events), like the Roku's banner ---------------------------------
  var seenAlerts = {}, alertTimer = null;
  try { seenAlerts = JSON.parse(store('fd-tv-alerts') || '{}'); } catch (e) { seenAlerts = {}; }
  function showAlerts() {
    var nowS = Date.now() / 1000;
    var a = arr(data.alerts).filter(function (x) { return x.at <= nowS && x.until > nowS && !seenAlerts[x.id]; })[0];
    if (!a) return;
    seenAlerts[a.id] = nowS;
    Object.keys(seenAlerts).forEach(function (k) { if (nowS - seenAlerts[k] > 86400) delete seenAlerts[k]; });
    store('fd-tv-alerts', JSON.stringify(seenAlerts));
    var el = $('#alert'), c = css(a.colorHex);
    el.innerHTML = '<div class="bar" style="background:' + c + '"></div><div class="eb" style="color:' + c + '">' + esc(String(a.kind || 'Alert').toUpperCase()) + '</div><b class="one">' + esc(a.title) + '</b><div class="dt one">' + esc(a.detail || '') + '</div>';
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

  // ---- music from the server's speaker (Spotify or AirPlay) ---------------------------------------------
  var audio = $('#music'), nowPlaying = null, musicOn = false, musicBlocked = false, quietSince = 0, musicPoll = null;
  function wantMusic() { return Boolean(nowPlaying && nowPlaying.playing && nowPlaying.stream && layout().music !== false); }
  function startMusic() {
    audio.src = nowPlaying.stream + '?t=' + Date.now();
    musicOn = true; musicBlocked = false;
    var p = audio.play();
    if (p && p.catch) p.catch(function () { musicOn = false; musicBlocked = true; renderFoot(); }); // the TV wants a key press first
  }
  function stopMusic() {
    musicOn = false; musicBlocked = false; quietSince = 0;
    try { audio.pause(); audio.removeAttribute('src'); audio.load(); } catch (e) {}
  }
  function syncMusic() {
    if (wantMusic()) { quietSince = 0; if (!musicOn && !musicBlocked) startMusic(); }
    else if (musicOn || musicBlocked) {
      // a pause between songs or a phone call: keep listening a little while before letting go
      if (!quietSince) quietSince = Date.now();
      else if (Date.now() - quietSince > 20000) stopMusic();
    }
    // while music is on at the server, ask what's playing every few seconds so it starts and stops quickly
    if (nowPlaying !== null && !musicPoll) musicPoll = setInterval(pollMusic, 3000);
    if (nowPlaying === null && musicPoll) { clearInterval(musicPoll); musicPoll = null; }
    renderFoot();
  }
  function pollMusic() {
    if (demo) return;
    fetch('/api/music/now', { cache: 'no-store' }).then(function (r) { return r.json(); })
      .then(function (m) { var changed = JSON.stringify(m) !== JSON.stringify(nowPlaying); nowPlaying = m; if (changed) syncMusic(); else if (musicOn || musicBlocked) syncMusic(); })
      .catch(function () { /* the next dashboard refresh tells us */ });
  }
  // the stream dropped (Wi-Fi blip, server restart): pick it back up
  audio.addEventListener('error', function () { if (musicOn) { musicOn = false; setTimeout(syncMusic, 3000); } });
  audio.addEventListener('ended', function () { if (musicOn) { musicOn = false; setTimeout(syncMusic, 1000); } });
  function musicKey(action) {
    if (!nowPlaying) return false;
    fetch('/api/music/control', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: action }) })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'That didn\'t work.'); }); })
      .then(function () { setTimeout(pollMusic, 800); })
      .catch(function (e) { toast(e.message); });
    return true;
  }

  // ---- the remote: focus moves to the nearest thing in that direction --------------------------------
  function focusables(root) {
    return Array.prototype.slice.call((root || stage).querySelectorAll('.f')).filter(function (e) {
      return e.offsetParent !== null && (root === layer || !layer.contains(e));
    });
  }
  function current() { return stage.querySelector('.f.on'); }
  function setFocus(el) {
    var c = current(); if (c) c.classList.remove('on');
    if (!el) return;
    el.classList.add('on');
    nav.focus = el.getAttribute('data-f');
  }
  function restoreFocus() {
    if (!layer.hidden) return;
    var el = nav.focus ? stage.querySelector('[data-f="' + String(nav.focus).replace(/"/g, '') + '"]') : null;
    if (!el && nav.view !== 'home') el = stage.querySelector('.stab.sel');
    if (!el && nav.view === 'home') el = screenEl.querySelector('.tile.f');
    if (!el) el = focusables(stage)[0];
    if (el) setFocus(el);
  }
  function rectOf(el) { var r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, l: r.left, r: r.right, t: r.top, b: r.bottom }; }
  function move(dir) {
    var root = layer.hidden ? stage : layer, cur = current(), list = focusables(root);
    if (!cur || list.indexOf(cur) < 0) { setFocus(list[0] || null); return true; }
    var a = rectOf(cur), best = null, bestScore = Infinity, slack = 4 * scale;
    list.forEach(function (el) {
      if (el === cur) return;
      var b = rectOf(el), dx = b.x - a.x, dy = b.y - a.y;
      var ok = dir === 'left' ? b.r <= a.l + slack : dir === 'right' ? b.l >= a.r - slack : dir === 'up' ? b.b <= a.t + slack : b.t >= a.b - slack;
      if (!ok) return;
      var horiz = dir === 'left' || dir === 'right';
      var score = (horiz ? Math.abs(dx) : Math.abs(dy)) + (horiz ? Math.abs(dy) : Math.abs(dx)) * 2.2;
      if (score < bestScore) { bestScore = score; best = el; }
    });
    if (best) { setFocus(best); keepVisible(best); renderFoot(); return true; }
    return false;
  }
  function keepVisible(el) {
    var inner = el.closest ? el.closest('.scroll-inner') : null;
    if (!inner) return;
    var box = inner.parentNode.getBoundingClientRect(), r = el.getBoundingClientRect();
    if (r.bottom > box.bottom) nav.scroll += (r.bottom - box.bottom) / scale + 30;
    if (r.top < box.top) nav.scroll -= (box.top - r.top) / scale + 30;
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

  function switchSection(step) {
    var s = sections(), i = s.indexOf(nav.view);
    if (i < 0 || s.length < 2) return;
    var next = s[(i + step + s.length) % s.length];
    nav.view = next; nav.sub = null; nav.scroll = 0; nav.focus = 'tab-' + next; peekWx = null;
    render();
  }
  function switchChip(step) {
    var c = chipsFor(nav.view), i = -1, sub = currentSub();
    c.forEach(function (x, k) { if (x.id === sub) i = k; });
    if (c.length < 2) return;
    selectChip(c[(Math.max(0, i) + step + c.length) % c.length].id);
  }
  function selectChip(id) {
    nav.sub = id; nav.scroll = 0; nav.focus = 'chip-' + id;
    if (nav.view === 'weather') { peekWx = id; load(); }
    render();
  }

  function ok() {
    // the TV wanted a key press before playing sound: this press is that, and nothing else
    if (musicBlocked) { startMusic(); renderFoot(); return; }
    var el = current();
    if (!el) return;
    if (pickFor && el.getAttribute('data-kid')) return markDone(pickFor, el.getAttribute('data-kid'));
    var goTo = el.getAttribute('data-go');
    if (goTo) {
      if (goTo === 'weather' && el.id === 'wx') return go('weather', null);
      var o = OPENS[goTo];
      return go(o[0], o[1]);
    }
    var chip = el.getAttribute('data-chip');
    if (chip) return selectChip(chip);
    var full = el.getAttribute('data-full');
    if (full) return openFull(full);
    var chore = el.getAttribute('data-chore');
    if (chore) { var c = arr(data.chores).filter(function (x) { return String(x.id) === chore; })[0]; if (c) openPicker(c); }
  }

  /** Back: close the full-screen layer, then go Home. Returns false at Home (let the TV leave the app). */
  function back() {
    if (!layer.hidden) { closeLayer(); restoreFocus(); renderFoot(); return true; }
    if (nav.view !== 'home') {
      var from = nav.view;
      go('home');
      var tileEl = Array.prototype.slice.call(screenEl.querySelectorAll('[data-go]')).filter(function (t) { return OPENS[t.getAttribute('data-go')][0] === from; })[0];
      if (tileEl) setFocus(tileEl);
      renderFoot();
      return true;
    }
    return false;
  }
  // The Android TV app catches its own Back button and asks the page first.
  window.fdTvBack = back;

  // nobody's touched the remote for a bit: hide the ring on Home, like the Roku
  var lastKey = 0;
  document.body.classList.add('idle');
  function idleCheck() {
    var idle = nav.view === 'home' && layer.hidden && Date.now() - lastKey > 30000;
    if (idle !== document.body.classList.contains('idle')) { document.body.classList.toggle('idle', idle); renderFoot(); }
    // a few minutes without the remote: back to Home
    if (Date.now() - lastKey > 3 * 60000 && (nav.view !== 'home' || !layer.hidden)) { closeLayer(); peekWx = null; go('home'); }
  }

  document.addEventListener('keydown', function (e) {
    var k = e.key, c = e.keyCode, handled = true;
    var wasIdle = document.body.classList.contains('idle');
    lastKey = Date.now();
    if (wasIdle) { document.body.classList.remove('idle'); renderFoot(); }
    var cur = current(), onTab = layer.hidden && cur && cur.classList.contains('stab'), onChip = layer.hidden && cur && cur.classList.contains('chip');
    if (k === 'ArrowLeft' || c === 37) {
      if (wasIdle) return e.preventDefault(); // the first press just shows where you are
      if (onTab) switchSection(-1); else if (onChip) switchChip(-1); else move('left');
    } else if (k === 'ArrowRight' || c === 39) {
      if (wasIdle) return e.preventDefault();
      if (onTab) switchSection(1); else if (onChip) switchChip(1); else move('right');
    } else if (k === 'ArrowUp' || c === 38) {
      if (wasIdle) return e.preventDefault();
      if (!move('up')) scrollBy(-360);
    } else if (k === 'ArrowDown' || c === 40) {
      if (wasIdle) return e.preventDefault();
      if (!move('down')) scrollBy(360);
    } else if (k === 'Enter' || c === 13) {
      if (wasIdle && nav.view === 'home' && !musicBlocked) return e.preventDefault();
      ok();
    } else if (k === 'MediaPlayPause' || c === 179 || c === 415 || c === 19 || c === 10252) {
      handled = musicKey('playpause');
    } else if (k === 'MediaTrackNext' || c === 176 || c === 417 || c === 10233) {
      handled = musicKey('next');
    } else if (k === 'MediaTrackPrevious' || c === 177 || c === 412 || c === 10232) {
      handled = musicKey('prev');
    } else if (k === 'Escape' || k === 'Backspace' || k === 'GoBack' || k === 'BrowserBack' || c === 27 || c === 8 || c === 461 || c === 10009) {
      // 461: LG webOS Back, 10009: Samsung Tizen Return
      handled = back();
      if (!handled && (c === 461 || c === 10009)) {
        try { if (window.tizen) window.tizen.application.getCurrentApplication().exit(); else if (window.webOS && window.webOS.platformBack) window.webOS.platformBack(); } catch (err) { /* the TV handles it */ }
      }
    } else handled = false;
    if (handled) e.preventDefault();
  });
  // LG's pointer remote: pointing and clicking works too
  stage.addEventListener('click', function (e) {
    lastKey = Date.now(); document.body.classList.remove('idle');
    var el = e.target.closest ? e.target.closest('.f') : null;
    if (!el) return;
    setFocus(el);
    if (el.classList.contains('stab')) { var s = el.getAttribute('data-section'); if (s !== nav.view) { nav.view = s; nav.sub = null; nav.focus = 'tab-' + s; render(); } return; }
    ok();
  });

  // ---- go ------------------------------------------------------------------------------------------
  render();
  load();
  setInterval(load, 15000);
  setInterval(function () { renderClock(); idleCheck(); }, 1000);
  setInterval(function () { if (data && nav.view === 'home' && layer.hidden) { render(); } }, 60000); // "in 25 min" keeps counting down
})();
