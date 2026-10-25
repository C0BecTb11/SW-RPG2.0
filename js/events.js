/* Лобби ивентов (game/events.html): ивент дня (окно 18–23 по серверу, ивент и уровень случайны),
 * запись → сбор «Готов» → бой, бой с ботами, если соперника нет; каталог своей стороны,
 * история, рейтинг, титулы; у администрации — тест без очереди (dev_event_start).
 * Каталог — shared/rt-events-cat.js, состояние — функции базы event_* (sql/events.sql).
 * Найден бой — переход на game/event-battle.html?m=<матч>. ES5.
 */
(function() {
  'use strict';
  var CAT = window.SWEventsCat;
  var S = { list: null, status: null, tab: 'list', f: 'all', dayRole: null, maps: {}, hist: null, rate: null, rateSide: null, dev: { event: 'hunt_sith', tier: 1, role: 'hunter', map: '', bots: 2 }, pollT: 0, goT: 0, off: 0, polls: 0, reloadAt: 0 };
  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function(c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function fmt(n) { return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' '); }
  var toastT = 0;
  function toast(msg, kind) { var el = $('ev-toast'); el.textContent = msg; el.className = 'ev-toast show' + (kind ? ' ' + kind : ''); clearTimeout(toastT); toastT = setTimeout(function() { el.className = 'ev-toast'; }, 2800); }
  function rpc(fn, args) { return supabase.rpc(fn, args || {}).then(function(r) { if (r.error) throw new Error(r.error.message); return r.data; }); }
  function errText(e) {
    var m = String(e && e.message || e).replace(/^.*?: /, '');
    // внутренние ошибки базы и сети (англ.) — понятным текстом (gameErr из js/err-report.js)
    return typeof gameErr === 'function' ? gameErr({ message: m }) : m;
  }

  // ---------------------------------------------------------------- значки ивентов
  var P = {
    sith: '<path d="M5 19L17 5M7 5l12 14"/><path d="M4 18l2 2M18 18l2 2" stroke-width="2.4"/>',
    jedi: '<path d="M12 3v13"/><path d="M10 16h4v3h-4zM11 19v2h2v-2"/>',
    envoy: '<circle cx="12" cy="7" r="3"/><path d="M6 20c0-4 3-6 6-6s6 2 6 6"/><path d="M17 9l3 1v3c0 2-1.5 3-3 3.5"/>',
    holocron: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5"/>',
    generator: '<circle cx="12" cy="12" r="8"/><path d="M13 6l-4 7h4l-2 5"/>',
    blockade: '<path d="M3 8l4-2v4zM10 12l4-2v4zM17 8l4-2v4z"/><path d="M3 18h18" stroke-dasharray="2 2"/>',
    phantom: '<path d="M4 14l8-8 8 8-8 4z" stroke-dasharray="3 2"/><circle cx="12" cy="12" r="1.5"/>',
    aces: '<path d="M12 4v16M5 9l7 3 7-3M7 18l5-2 5 2"/>',
    station: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2.5"/><path d="M12 4v5.5M12 14.5V20M4 12h5.5M14.5 12H20"/>',
    boarding: '<path d="M3 12h11M10 8l4 4-4 4"/><path d="M17 5v14l4-3V8z"/>',
    outpost: '<path d="M8 21V9l4-5 4 5v12M5 21h14M10 13h4"/>',
    rescue: '<path d="M12 21s-7-4.5-7-10a4 4 0 017-2.5A4 4 0 0119 11c0 5.5-7 10-7 10z"/><path d="M12 9v6M9 12h6"/>',
    beast: '<path d="M6 4c1 5 1 11-1 16M11 4c1 5 1 11-1 16M16 4c1 5 1 11-1 16"/>',
    factory: '<path d="M3 21V11l5 3v-3l5 3V7l8 4v10z"/><path d="M7 18h2M12 18h2M17 18h2"/>',
    convoy: '<rect x="2" y="9" width="5" height="6" rx="1"/><rect x="9.5" y="9" width="5" height="6" rx="1"/><rect x="17" y="9" width="5" height="6" rx="1"/>',
    bridge: '<path d="M2 18h20M4 18c0-6 4-9 8-9s8 3 8 9M8 18v-5M16 18v-5M12 18V9"/>',
    stealth: '<path d="M2 12s4-6 10-6 10 6 10 6-4 6-10 6S2 12 2 12z"/><path d="M4 20L20 4"/>',
    medship: '<path d="M4 14l8-9 8 9-8 5z"/><path d="M12 9v6M9 12h6"/>',
    courier: '<path d="M8 12h13M17 8l4 4-4 4"/><path d="M3 8h4M2 12h3M3 16h4"/>',
    pirates: '<circle cx="12" cy="10" r="6"/><path d="M9 21v-4M12 21v-4M15 21v-4"/><circle cx="9.5" cy="10" r="1.2"/><circle cx="14.5" cy="10" r="1.2"/>',
    shipyard: '<path d="M4 21V5h10M14 5l4 4M10 5v4"/><path d="M8 15l6-2 6 2-6 3z"/>',
    droid: '<circle cx="12" cy="11" r="7"/><circle cx="12" cy="10" r="2"/><path d="M8 20l4-2 4 2"/>',
    mine: '<path d="M12 3l5 7-5 11-5-11z"/><path d="M7 10h10"/>',
    bounty: '<circle cx="12" cy="12" r="7"/><path d="M12 2v5M12 17v5M2 12h5M17 12h5"/><circle cx="12" cy="12" r="1.5"/>',
    city: '<path d="M3 21V10h5v11M8 21V5h6v16M14 21v-8h7v8M5 13h1M10 8h2M10 12h2M16 16h3"/>',
    lab: '<path d="M9 3h6M10 3v6l-5 10a1.5 1.5 0 001.3 2h11.4a1.5 1.5 0 001.3-2L14 9V3"/><path d="M8 15h8"/>',
    ambush: '<path d="M3 5l7 7-7 7M21 5l-7 7 7 7"/><circle cx="12" cy="12" r="1.5"/>',
    relay: '<path d="M12 10v11M8 21h8"/><circle cx="12" cy="8" r="2"/><path d="M7.5 4a6 6 0 000 8M16.5 4a6 6 0 010 8"/>',
    swarm: '<path d="M5 6l2 2-2 2M11 4l2 2-2 2M17 7l2 2-2 2M8 14l2 2-2 2M15 15l2 2-2 2"/>',
    blockade2: ''
  };
  function icon(k) { return '<i class="ev-ico ' + esc(k) + '"><svg viewBox="0 0 24 24" aria-hidden="true">' + (P[k] || P.station) + '</svg></i>'; }

  // ---------------------------------------------------------------- загрузка
  function load() {
    return Promise.all([rpc('event_list'), rpc('event_status'), fetch('../shared/events/maps/index.json', { cache: 'no-cache' }).then(function(r) { return r.json(); }).catch(function() { return []; })]).then(function(r) {
      S.list = r[0]; S.status = r[1]; (r[2] || []).forEach(function(m) { S.maps[m.id] = m.name; });
      clockSync(S.status && S.status.today);
      document.body.classList.toggle('cis', S.list.side === 'cis');
      $('ev-side').textContent = S.list.side === 'cis' ? 'КНС' : 'Республика';
      $('ev-tab-dev').hidden = !S.list.admin;
      S.rateSide = S.list.side;
      render(); queueBar(); poll();
    }).catch(function(e) { $('ev-body').innerHTML = '<div class="ev-empty">Не удалось загрузить ивенты: ' + esc(errText(e)) + '</div>'; });
  }
  function poll() {
    clearTimeout(S.pollT);
    var st = S.status || {}, fast = st.queue || st.match;
    S.pollT = setTimeout(function() {
      if (document.hidden) { poll(); return; }
      rpc('event_status').then(function(r) {
        var had = !!(S.status && S.status.match), wasOpen = today().open;
        S.status = r; clockSync(r.today); queueBar();
        if (!had && r.match) toast('Бой найден!', 'gold');
        // окно открылось или закрылось — перерисовать карточку дня; без записи — раз в полминуты обновить счётчики
        S.polls++;
        if (!!(r.today && r.today.open) !== !!wasOpen || (!r.queue && !r.match && S.polls % 3 === 0)) reloadList();
        else if (S.tab === 'list') dayRefresh();
        poll();
      }, function() { poll(); });
    }, fast ? 2000 : 10000);
  }
  function reloadList() { rpc('event_list').then(function(L) { S.list = L; render(); }, function() {}); }

  // ---------------------------------------------------------------- время сервера и отсчёты
  function clockSync(T) { if (T && T.now) S.off = Date.parse(T.now) - Date.now(); }
  function srvNow() { return Date.now() + S.off; }
  function today() { return (S.status && S.status.today) || (S.list && S.list.today) || {}; }
  function hms(sec, short) {
    sec = Math.max(0, Math.floor(sec)); var h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s2 = sec % 60;
    return (h || !short ? h + ':' + ('0' + m).slice(-2) : m) + ':' + ('0' + s2).slice(-2);
  }
  function hhmm(iso) { var d = new Date(iso); return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2); }
  // время по серверу: часы из настроек окна, а не из часового пояса телефона
  function srvHour(iso, tz) { try { return new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: tz }); } catch (e) { return hhmm(iso); } }
  function tzName(tz) { return tz === 'Europe/Moscow' ? 'МСК' : (tz || '').split('/').pop(); }
  function tick() {
    var now = srvNow(), due = false;
    [].forEach.call(document.querySelectorAll('[data-cd]'), function(el) {
      var left = (Date.parse(el.getAttribute('data-cd')) - now) / 1000;
      if (left <= 0 && el.hasAttribute('data-reload')) due = true;
      el.textContent = hms(left, el.getAttribute('data-cdfmt') === 'short');
    });
    if (due && now - S.reloadAt > 5000) { S.reloadAt = now; rpc('event_status').then(function(r) { S.status = r; clockSync(r.today); queueBar(); reloadList(); }, function() {}); }
  }
  setInterval(tick, 1000);

  // ---------------------------------------------------------------- профиль
  function me() {
    var L = S.list, p = L.profile || {}, titles = L.titles || [];
    var html = '<div class="ev-stat"><b>' + fmt(p.points || 0) + '</b><span>очки</span></div><div class="ev-stat"><b>' + fmt(p.wins || 0) + ' / ' + fmt(p.games || 0) + '</b><span>побед / боёв</span></div>' +
      '<div class="ev-stat"><b>' + (L.trophies || []).length + '</b><span>трофеев</span></div><div class="ev-titles-row"><span>Титул</span>';
    if (!titles.length) html += '<span class="ev-title none">за победу на уровне «Легенда»</span>';
    else titles.forEach(function(t) { html += '<button type="button" class="ev-title' + (p.title === t ? ' on' : '') + '" data-title="' + esc(t) + '">' + esc(t) + '</button>'; });
    return html + '</div>';
  }

  // ---------------------------------------------------------------- каталог
  function trophy(id, tier) { return (S.list.trophies || []).some(function(t) { return t[0] === id && t[1] === tier; }); }
  function waitCount(id, tier, role) { return (S.list.waiting || {})[id + ':' + tier + ':' + role] || 0; }
  function rewardLine(id, tier) {
    var r = CAT.reward(id, tier); if (!r) return '';
    var res = Object.keys(r.res).map(function(k) { return '<b>' + r.res[k] + '</b> ' + CAT.RES_NAME[k]; }).join(' · ');
    return '<b>' + fmt(r.cr) + '</b> кр' + (res ? ' · ' + res : '');
  }
  function card(E) {
    var side = S.list.side, row = (S.list.events || []).filter(function(x) { return x.id === E.id; })[0], ready = !!(row && row.ready && E.ready);
    var tags = '<span class="ev-tag' + (E.kind === 'pvp' ? ' pvp' : '') + '">' + (E.kind === 'pvp' ? 'против игроков' : 'против бота') + '</span><span class="ev-tag">' + (E.theater === 'ground' ? 'наземка' : 'космос') + '</span>' +
      '<span class="ev-tag' + (E.troops === 'own' ? ' own' : '') + '">' + (E.troops === 'own' ? 'свои войска' : 'войска ивента') + '</span>';
    var cls = 'ev-card ' + E.kind + ' ' + (E.sides.length > 1 ? 'both' : E.sides[0]) + (ready ? '' : ' soon') + (ready ? ' wide' : '');
    var html = '<article class="' + cls + '" data-ev="' + E.id + '"><div class="ev-ribbon">скоро</div><div class="ev-head">' + icon(E.icon) +
      '<div class="ev-name"><b>' + esc(E.title) + '</b><em>' + esc(E.place) + '</em><div class="ev-tags">' + tags + '</div></div></div>';
    html += '<p class="ev-about">' + esc(E.about) + '</p>';
    if (!ready) return html + '</article>';
    if (E.maps.length) html += '<div class="ev-maps">' + E.maps.map(function(m) { return '<div class="ev-map" style="background-image:url(../assets/events/' + m + '.jpg?v=2)"><span>' + esc(S.maps[m] || m) + '</span></div>'; }).join('') + '</div>';
    if (E.goal && E.goal[side]) html += '<div class="ev-goal"><b>Твоя задача</b>' + esc(E.goal[side]) + '</div>';
    html += rolesInfo(E);
    // трофеи по уровням: уровень выбрать нельзя — он выпадает вместе с ивентом дня
    html += '<div class="ev-trophies"><span class="ev-lab">Трофеи</span>' + CAT.TIERS.map(function(T) {
      return '<span class="ev-tro' + (trophy(E.id, T.n) ? ' got' : '') + '" title="' + (trophy(E.id, T.n) ? 'трофей получен' : 'трофея ещё нет') + '"><i></i>' + ['I', 'II', 'III'][T.n - 1] + ' · ' + T.name + '</span>';
    }).join('') + '</div>';
    html += '<div class="ev-reward">Награда за победу: ' + rewardLine(E.id, 1) + ' <span class="k">на II ×' + String(CAT.TIERS[1].k).replace('.', ',') + ', на III ×' + CAT.TIERS[2].k + '</span></div>';
    return html + '</article>';
  }
  function rolesInfo(E) {
    var side = S.list.side;
    return '<div class="ev-roles-info">' + E.roles.map(function(r) {
      var mine = r.side === side;
      return '<span class="' + (mine ? 'mine' : '') + '"><b>' + esc(r.name) + '</b> · ' + (mine ? 'твоя сторона' : 'за ' + (r.side === 'cis' ? 'КНС' : 'Республику')) + ' · ' + (r.min === r.max ? r.max : r.min + '–' + r.max) + ' игр.</span>';
    }).join('') + '</div>';
  }

  // ---------------------------------------------------------------- ивент дня
  function dayCard() {
    var T = today(), side = S.list.side, st = S.status || {}, paid = st.paid || S.list.paid || {};
    var tzl = tzName(T.tz);
    if (!T.open || !T.event || !CAT.BY[T.event]) {
      var before = T.opens_at && srvNow() < Date.parse(T.opens_at);
      var at = T.next_at || T.opens_at, local = at ? hhmm(at) : '', srv = at ? srvHour(at, T.tz) : '18:00';
      return '<article class="ev-day closed"><div class="ev-day-top"><span class="ev-day-k">Ивент дня</span><span class="ev-day-win">' + esc(srv) + '–' + esc(T.closes_at ? srvHour(T.closes_at, T.tz) : '23:00') + ' ' + esc(tzl) + '</span></div>' +
        '<div class="ev-day-wait"><i class="ev-day-dice" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="3"/><circle cx="9" cy="9" r="1.3"/><circle cx="15" cy="15" r="1.3"/><circle cx="15" cy="9" r="1.3"/><circle cx="9" cy="15" r="1.3"/><circle cx="12" cy="12" r="1.3"/></svg></i>' +
        '<div><b>' + (before ? 'Откроется сегодня в ' + esc(srv) + ' ' + esc(tzl) : 'На сегодня ивенты закрыты') + '</b>' +
        '<em>' + (before ? 'Какой ивент и какая сложность — станет известно при открытии. Ивент один на всех и выпадает случайно.' : 'Следующий — завтра в ' + esc(srv) + ' ' + esc(tzl) + '. Ивент и сложность выпадут случайно.') +
        (local && local !== srv ? ' У тебя это ' + esc(local) + '.' : '') + '</em>' +
        (at ? '<div class="ev-day-cd">до открытия <b data-cd="' + esc(at) + '" data-reload>' + hms((Date.parse(at) - srvNow()) / 1000) + '</b></div>' : '') + '</div></div></article>';
    }
    var E = CAT.BY[T.event], tier = T.tier || 1, Tn = CAT.TIERS[tier - 1];
    var myRoles = E.roles.filter(function(r) { return r.side === side; });
    if (!S.dayRole || !myRoles.some(function(r) { return r.id === S.dayRole; })) S.dayRole = myRoles.length ? myRoles[0].id : null;
    var q = st.queue && st.queue.event === E.id ? st.queue : null, title = S.dayRole && E.titles[S.dayRole];
    var tags = '<span class="ev-tag' + (E.kind === 'pvp' ? ' pvp' : '') + '">' + (E.kind === 'pvp' ? 'против игроков' : 'против бота') + '</span><span class="ev-tag">' + (E.theater === 'ground' ? 'наземка' : 'космос') + '</span>';
    var html = '<article class="ev-day open ' + E.kind + '"><div class="ev-day-top"><span class="ev-day-k">Ивент дня</span>' +
      '<span class="ev-day-win">до ' + esc(srvHour(T.closes_at, T.tz)) + ' ' + esc(tzl) + ' · <b data-cd="' + esc(T.closes_at) + '" data-reload>' + hms((Date.parse(T.closes_at) - srvNow()) / 1000) + '</b></span></div>' +
      '<div class="ev-head">' + icon(E.icon) + '<div class="ev-name"><b>' + esc(E.title) + '</b><em>' + esc(E.place) + '</em><div class="ev-tags">' + tags + '</div></div>' +
      '<div class="ev-day-tier t' + tier + '" title="Сложность выпала случайно"><b>' + ['I', 'II', 'III'][tier - 1] + '</b><span>' + esc(Tn.name) + '</span></div></div>';
    html += '<p class="ev-about">' + esc(E.about) + '</p>';
    if (E.maps.length) html += '<div class="ev-maps">' + E.maps.map(function(m) { return '<div class="ev-map" style="background-image:url(../assets/events/' + m + '.jpg?v=2)"><span>' + esc(S.maps[m] || m) + '</span></div>'; }).join('') + '</div>';
    if (E.goal && E.goal[side]) html += '<div class="ev-goal"><b>Твоя задача</b>' + esc(E.goal[side]) + '</div>';
    if (myRoles.length > 1) {
      html += '<div><div class="ev-lab">Роль</div><div class="ev-roles">' + myRoles.map(function(r) {
        return '<button type="button" data-droles="' + r.id + '" class="' + (S.dayRole === r.id ? 'on' : '') + '"' + (q ? ' disabled' : '') + '><b>' + esc(r.name) + '</b><em>' + esc(r.about || '') + ' · ' + (r.min === r.max ? r.max : r.min + '–' + r.max) + ' игр.</em></button>';
      }).join('') + '</div></div>';
    } else if (myRoles.length) {
      html += '<div class="ev-goal role"><b>Твоя роль</b>' + esc(myRoles[0].name) + (myRoles[0].about ? ' — ' + esc(myRoles[0].about.charAt(0).toLowerCase() + myRoles[0].about.slice(1)) : '') + '</div>';
    }
    html += '<div class="ev-reward">Награда за победу: ' + rewardLine(E.id, tier) + (tier === 3 && title ? ' · титул <span class="t">«' + esc(title) + '»</span>' : '') +
      '<span class="k">' + esc(E.minutes ? E.minutes[tier - 1] + ' мин · ' : '') + esc(Tn.about) + '</span></div>';
    if (paid.win) html += '<div class="ev-paid">Награда за победу сегодня уже получена — следующие бои идут на рейтинг и трофеи.</div>';
    else if (paid.any) html += '<div class="ev-paid">Утешительная награда сегодня уже получена — осталась награда за победу.</div>';
    var counts = q ? q.counts || {} : null, pct = (st.bots_pct || S.list.bots_pct || 50) / 100;
    var w = E.roles.map(function(r) { var n = counts ? counts[r.id] || 0 : waitCount(E.id, tier, r.id); return esc(r.name.toLowerCase()) + ' <b>' + n + '</b>/' + r.max; }).join(' · ');
    if (E.kind === 'pvp') html += '<div class="ev-howto"><span>1</span>Запишись <span>2</span>Стороны собраны — «Сбор», жми «Готов» <span>3</span>Бой. Соперника нет 3 мин — можно с ботами (награда ×' + String(pct).replace('.', ',') + ')</div>';
    else html += '<div class="ev-howto"><span>1</span>Запишись — можно одному, в отряде до ' + Math.max.apply(null, myRoles.map(function(r) { return r.max; }).concat([1])) + ' <span>2</span>Через полминуты или полным составом — «Сбор», жми «Готов» <span>3</span>Бой против волн врага</div>';
    html += '<div class="ev-foot" id="ev-day-foot">' + dayFoot(E, w, q) + '</div>';
    return html + '</article>';
  }
  function dayFoot(E, w, q) {
    return '<div class="ev-wait">Записались<br>' + w + '</div>' +
      '<button type="button" class="ev-go" id="ev-signup"' + (q || !S.dayRole ? ' disabled' : '') + '>' + (q ? 'Ты записан' : 'Записаться') + '</button>';
  }
  // поллинг: обновить только низ карточки дня (счётчики, кнопка), не трогая остальное
  function dayRefresh() {
    var foot = $('ev-day-foot'), T = today(), st = S.status || {};
    if (!foot || !T.open || !CAT.BY[T.event]) return;
    var E = CAT.BY[T.event], q = st.queue && st.queue.event === E.id ? st.queue : null, counts = q ? q.counts || {} : null;
    var w = E.roles.map(function(r) { var n = counts ? counts[r.id] || 0 : waitCount(E.id, T.tier, r.id); return esc(r.name.toLowerCase()) + ' <b>' + n + '</b>/' + r.max; }).join(' · ');
    foot.innerHTML = dayFoot(E, w, q);
  }
  function listView() {
    var side = S.list.side, all = CAT.forSide(side), f = S.f;
    var pass = function(E) { return f === 'all' || E.kind === f || E.theater === f; };
    var ready = all.filter(function(E) { return E.ready && pass(E); }), soon = all.filter(function(E) { return !E.ready && pass(E); });
    var html = dayCard();
    if (ready.length) html += '<div class="ev-sec"><h2>Готовые ивенты</h2><span>' + ready.length + ' · по одному в день</span></div><div class="ev-grid">' + ready.map(card).join('') + '</div>';
    var pvp = soon.filter(function(E) { return E.kind === 'pvp'; }), pve = soon.filter(function(E) { return E.kind === 'pve'; });
    if (pvp.length) html += '<div class="ev-sec"><h2>Против игроков — скоро</h2><span>' + pvp.length + '</span></div><div class="ev-grid">' + pvp.map(card).join('') + '</div>';
    if (pve.length) html += '<div class="ev-sec"><h2>Против бота — скоро</h2><span>' + pve.length + '</span></div><div class="ev-grid">' + pve.map(card).join('') + '</div>';
    return html;
  }

  // ---------------------------------------------------------------- история и рейтинг
  function histView() {
    if (!S.hist) { rpc('event_history', { p_limit: 30 }).then(function(r) { S.hist = r || []; render(); }, function(e) { S.hist = []; toast(errText(e), 'bad'); render(); }); return '<div class="ev-load"><span></span>Загружаю…</div>'; }
    if (!S.hist.length) return '<div class="ev-empty">Боёв ещё не было. Ивент дня открывается вечером — запишись, и бой начнётся, когда все будут готовы.</div>';
    return '<div class="ev-rows">' + S.hist.map(function(h) {
      var E = CAT.BY[h.event] || { title: h.event }, done = h.status === 'done', won = done && h.winner === h.role;
      var res = h.status === 'aborted' ? '<span class="r">отмена</span>' : !done ? '<span class="r">идёт</span>' : '<span class="r ' + (won ? 'win' : 'loss') + '">' + (won ? 'победа' : 'пораж.') + '</span>';
      var role = (CAT.role(h.event, h.role) || {}).name || h.role || '';
      var aw = h.award ? (h.award.paid === false ? '<em>награда за день уже была</em>' : '+' + fmt(h.award.credits) + ' кр' + (Object.keys(h.award.resources || {}).length ? '<em>+ ресурсы на склад</em>' : '')) + '<em>' + h.award.points + ' очк.</em>' : h.test ? '<em>тест</em>' : '';
      var when = new Date(h.at); when = ('0' + when.getDate()).slice(-2) + '.' + ('0' + (when.getMonth() + 1)).slice(-2) + ' ' + ('0' + when.getHours()).slice(-2) + ':' + ('0' + when.getMinutes()).slice(-2);
      return '<div class="ev-row">' + res + '<div class="m"><b>' + esc(E.title) + ' · ' + ['I', 'II', 'III'][h.tier - 1] + '</b><em>' + esc(role) + ' · ' + esc(S.maps[h.map] || h.map) + ' · ' + when + (h.why ? ' · ' + esc(h.why) : '') + '</em></div><div class="a">' + aw + '</div></div>';
    }).join('') + '</div>';
  }
  function rateView() {
    var side = S.rateSide;
    if (!S.rate || S.rate.side !== side) { rpc('event_rating', { p_side: side }).then(function(r) { S.rate = { side: side, rows: r || [] }; render(); }, function(e) { toast(errText(e), 'bad'); }); return '<div class="ev-load"><span></span>Загружаю…</div>'; }
    var html = '<div class="ev-chips" style="margin-bottom:8px"><button type="button" data-rs="republic" class="' + (side === 'republic' ? 'on' : '') + '">Республика</button><button type="button" data-rs="cis" class="' + (side === 'cis' ? 'on' : '') + '">КНС</button></div>';
    if (!S.rate.rows.length) return html + '<div class="ev-empty">Рейтинг пуст — первые победы ещё впереди</div>';
    return html + '<div class="ev-rows">' + S.rate.rows.map(function(r, i) {
      return '<div class="ev-row' + (r.me ? ' me' : '') + '"><span class="n">' + (i + 1) + '</span><div class="m"><b class="nick ' + esc(r.side) + '">' + esc(r.nick || '—') + '</b><em>' + (r.title ? '«' + esc(r.title) + '» · ' : '') + fmt(r.wins) + ' побед из ' + fmt(r.games) + '</em></div><div class="a">' + fmt(r.points) + '<em>очков</em></div></div>';
    }).join('') + '</div>';
  }

  // ---------------------------------------------------------------- тест администрации
  function devView() {
    var d = S.dev, E = CAT.BY[d.event], ready = CAT.LIST.filter(function(e) { return e.ready; });
    if (!E.roles.some(function(r) { return r.id === d.role; })) d.role = E.roles[0].id;
    var html = '<div class="ev-dev"><p>Бой без очереди: ты — в выбранной роли, остальные роли — боты. Награда в тесте не начисляется. Сторона роли может не совпадать с твоей.</p>';
    html += '<div><div class="ev-lab">Ивент</div><div class="ev-chips">' + ready.map(function(e) { return '<button type="button" data-dv="event" data-v="' + e.id + '" class="' + (d.event === e.id ? 'on' : '') + '">' + esc(e.title) + '</button>'; }).join('') + '</div></div>';
    html += '<div><div class="ev-lab">Роль</div><div class="ev-chips">' + E.roles.map(function(r) { return '<button type="button" data-dv="role" data-v="' + r.id + '" class="' + (d.role === r.id ? 'on' : '') + '">' + esc(r.name) + ' · ' + (r.side === 'cis' ? 'КНС' : 'Респ.') + '</button>'; }).join('') + '</div></div>';
    html += '<div><div class="ev-lab">Сложность</div><div class="ev-chips">' + CAT.TIERS.map(function(T) { return '<button type="button" data-dv="tier" data-v="' + T.n + '" class="' + (d.tier === T.n ? 'on' : '') + '">' + ['I', 'II', 'III'][T.n - 1] + ' · ' + T.name + '</button>'; }).join('') + '</div></div>';
    html += '<div><div class="ev-lab">Карта</div><div class="ev-chips"><button type="button" data-dv="map" data-v="" class="' + (!d.map ? 'on' : '') + '">случайная</button>' + E.maps.map(function(m) { return '<button type="button" data-dv="map" data-v="' + m + '" class="' + (d.map === m ? 'on' : '') + '">' + esc(S.maps[m] || m) + '</button>'; }).join('') + '</div></div>';
;
    var other = E.roles.filter(function(r) { return r.id !== d.role && r.max > 1; })[0], own = E.roles.filter(function(r) { return r.id === d.role; })[0];
    // против бота: сколько всего в отряде — ты и боты-союзники
    if (E.kind === 'pve' && own && own.max > 1) html += '<div><div class="ev-lab">Отряд в тесте — ты и боты</div><div class="ev-chips">' + [1, 2, 3, 4].filter(function(n) { return n <= own.max; }).map(function(n) { return '<button type="button" data-dv="bots" data-v="' + n + '" class="' + (d.bots === n ? 'on' : '') + '">' + (n === 1 ? 'один' : n + ' в отряде') + '</button>'; }).join('') + '</div></div>';
    else if (other) html += '<div><div class="ev-lab">Ботов в роли «' + esc(other.name) + '»</div><div class="ev-chips">' + [1, 2, 3, 4].filter(function(n) { return n >= other.min && n <= other.max; }).map(function(n) { return '<button type="button" data-dv="bots" data-v="' + n + '" class="' + (d.bots === n ? 'on' : '') + '">' + n + '</button>'; }).join('') + '</div></div>';
    html += '<div class="ev-foot"><div class="ev-wait">Прошлый тест, если шёл, будет отменён.</div><button type="button" class="ev-go" id="ev-dev-go">Запустить тест</button></div></div>';
    if (!S.devRecent) { rpc('dev_event_recent', { p_limit: 12 }).then(function(r) { S.devRecent = r || []; render(); }, function() { S.devRecent = []; }); }
    else if (S.devRecent.length) html += '<div class="ev-sec"><h2>Последние матчи</h2></div><div class="ev-rows">' + S.devRecent.map(function(m) {
      var E2 = CAT.BY[m.event] || { title: m.event };
      return '<div class="ev-row"><span class="r' + (m.status === 'done' ? ' win' : m.status === 'aborted' ? ' loss' : '') + '">' + ({ done: 'итог', aborted: 'отмена', live: 'идёт', forming: 'сбор' }[m.status] || m.status) + '</span><div class="m"><b>' + esc(E2.title) + ' · ' + ['I', 'II', 'III'][m.tier - 1] + (m.test ? ' · тест' : '') + '</b><em>' + esc((m.players || []).join(', ')) + (m.why ? ' · ' + esc(m.why) : '') + '</em></div><div class="a">' + esc(m.winner ? ((CAT.role(m.event, m.winner) || {}).name || m.winner) : '') + '</div></div>';
    }).join('') + '</div>';
    return html;
  }

  // ---------------------------------------------------------------- очередь
  function queueBar() {
    var el = $('ev-queue'), st = S.status || {};
    if (st.match) {
      var E = CAT.BY[st.match.event] || { title: '' }, mine = (st.match.players || []).filter(function(p) { return p.user === S.uid; })[0], role = mine && CAT.role(st.match.event, mine.role);
      el.hidden = false; el.className = 'ev-queue found';
      el.innerHTML = '<i class="ev-q-spin"></i><div class="ev-q-tx"><b>Бой найден: ' + esc(E.title) + '</b><em>' + esc(S.maps[st.match.map] || st.match.map) + ' · ' + ['I', 'II', 'III'][st.match.tier - 1] + (role ? ' · ты — <i>' + esc(role.name.toLowerCase()) + '</i>' : '') + (st.match.test ? ' · тест' : st.match.bots ? ' · против ботов' : '') + '</em></div><div class="ev-q-btns"><button type="button" class="ev-go" id="ev-q-go">В бой</button></div>';
      // сам переводим в бой один раз на матч: вернулся из боя — остаётся кнопка. Опрос идёт каждые 2 с —
      // уже поставленный переход на этот же матч не трогаем (раньше следующий опрос его снимал)
      if (S.goFor !== st.match.id) {
        clearTimeout(S.goT); S.goFor = st.match.id;
        var key = 'ev-go-' + st.match.id, once = false; try { once = !!sessionStorage.getItem(key); sessionStorage.setItem(key, '1'); } catch (e) {}
        var mid = st.match.id;
        if (!once) S.goT = setTimeout(function() { go(mid); }, 2500);
      }
      return;
    }
    clearTimeout(S.goT); S.goFor = null;
    if (!st.queue) { el.hidden = true; return; }
    var q = st.queue, E2 = CAT.BY[q.event] || { title: q.event, roles: [] }, role2 = CAT.role(q.event, q.role), c = q.counts || {};
    var head = esc(E2.title) + ' · ' + ['I', 'II', 'III'][q.tier - 1] + ' · ' + esc(role2 ? role2.name.toLowerCase() : q.role);
    el.hidden = false;
    // сбор: все записанные подтверждают «Готов»
    if (q.call) {
      var cl = q.call, bots = cl.mode === 'bots';
      el.className = 'ev-queue call';
      var who = (cl.who || []).map(function(w) { return '<i class="' + (w.ready ? 'ok' : '') + '">' + (w.ready ? '✓ ' : '') + esc(w.nick || '—') + '</i>'; }).join(' ');
      el.innerHTML = '<i class="ev-q-spin"></i><div class="ev-q-tx"><b>' + (bots ? 'Бой с ботами — подтверди' : 'Сбор! Все на месте — подтверди') + '</b>' +
        '<em>' + head + ' · готовы <i>' + cl.ready + '</i>/' + cl.total + ' · осталось <span data-cd="' + esc(cl.deadline) + '" data-cdfmt="short">' + hms((Date.parse(cl.deadline) - srvNow()) / 1000, true) + '</span></em>' +
        '<em class="who">' + who + '</em></div><div class="ev-q-btns">' +
        (cl.me_ready ? '<span class="ev-q-ok">Ты готов</span>' : '<button type="button" class="ev-go" id="ev-q-ready">Готов</button>') +
        '<button type="button" class="ev-go ghost" id="ev-q-leave">Выйти</button></div>';
      if (!cl.me_ready && S.callSeen !== cl.at) { S.callSeen = cl.at; toast('Сбор! Нажми «Готов»', 'gold'); try { if (navigator.vibrate) navigator.vibrate([120, 80, 120]); } catch (e) {} }
      return;
    }
    var need = E2.roles.map(function(r) { var n = c[r.id] || 0; return r.name.toLowerCase() + ' <i>' + n + '</i>/' + r.max + (n < r.min ? ' (нужно ' + r.min + ')' : ''); }).join(' · ');
    var wait = q.wait || 0, pct = st.bots_pct || 50, botsBtn = '', botsTx = '';
    if (q.bots_in === 0) botsBtn = '<button type="button" class="ev-go" id="ev-q-bots" title="Награда ×' + String(pct / 100).replace('.', ',') + '">С ботами</button>';
    else if (q.bots_in > 0) botsTx = '<em>Соперника пока нет — ботов можно позвать через <span data-cd="' + new Date(srvNow() + q.bots_in * 1000).toISOString() + '" data-cdfmt="short">' + hms(q.bots_in, true) + '</span> (награда ×' + String(pct / 100).replace('.', ',') + ')</em>';
    else if (q.bots_in == null) botsTx = '';
    el.className = 'ev-queue';
    el.innerHTML = '<i class="ev-q-spin"></i><div class="ev-q-tx"><b>Записан: ' + head + '</b><em>Ждём ' + Math.floor(wait / 60) + ':' + ('0' + wait % 60).slice(-2) + ' · ' + need + '</em>' + botsTx + '</div>' +
      '<div class="ev-q-btns">' + botsBtn + '<button type="button" class="ev-go ghost" id="ev-q-leave">Выйти</button></div>';
  }
  function go(id) { location.href = 'event-battle.html?m=' + encodeURIComponent(id); }

  // ---------------------------------------------------------------- отрисовка и касания
  function render() {
    if (!S.list) return;
    $('ev-me').innerHTML = me();
    [].forEach.call(document.querySelectorAll('#ev-tabs button'), function(b) { b.classList.toggle('on', b.getAttribute('data-tab') === S.tab); });
    [].forEach.call(document.querySelectorAll('#ev-filters button'), function(b) { b.classList.toggle('on', b.getAttribute('data-f') === S.f); });
    $('ev-filters').hidden = S.tab !== 'list';
    $('ev-body').innerHTML = S.tab === 'list' ? listView() : S.tab === 'hist' ? histView() : S.tab === 'rate' ? rateView() : devView();
  }
  document.addEventListener('click', function(e) {
    var t = e.target.closest('button'); if (!t) return;
    if (t.hasAttribute('data-tab')) { S.tab = t.getAttribute('data-tab'); if (S.tab === 'hist') S.hist = null; render(); return; }
    if (t.hasAttribute('data-f')) { S.f = t.getAttribute('data-f'); render(); return; }
    if (t.hasAttribute('data-rs')) { S.rateSide = t.getAttribute('data-rs'); render(); return; }
    if (t.hasAttribute('data-droles')) { S.dayRole = t.getAttribute('data-droles'); render(); return; }
    if (t.id === 'ev-signup') {
      var T = today(); t.disabled = true;
      rpc('event_join', { p_event: T.event, p_tier: T.tier, p_role: S.dayRole }).then(function(r) {
        S.status = r; queueBar(); poll(); render();
        toast(r.match ? 'Бой найден!' : r.queue && r.queue.call ? 'Сбор! Нажми «Готов»' : 'Ты записан — когда стороны соберутся, придёт «Сбор»', 'gold');
      }, function(err) { toast(errText(err), 'bad'); reloadList(); });
      return;
    }
    if (t.id === 'ev-q-ready') {
      t.disabled = true;
      rpc('event_ready').then(function(r) { S.status = r; queueBar(); poll(); if (r.match) toast('Бой найден!', 'gold'); }, function(err) { toast(errText(err), 'bad'); t.disabled = false; });
      return;
    }
    if (t.id === 'ev-q-bots') {
      t.disabled = true;
      rpc('event_bots').then(function(r) { S.status = r; queueBar(); poll(); toast(r.match ? 'Бой с ботами начинается' : 'Сбор с ботами — нажми «Готов»', 'gold'); }, function(err) { toast(errText(err), 'bad'); t.disabled = false; });
      return;
    }
    if (t.id === 'ev-q-leave') { rpc('event_leave').then(function(r) { S.status = r; queueBar(); render(); toast('Запись снята'); }, function(err) { toast(errText(err), 'bad'); }); return; }
    if (t.id === 'ev-q-go' && S.status && S.status.match) { go(S.status.match.id); return; }
    if (t.hasAttribute('data-title')) {
      var ti = t.getAttribute('data-title'), cur = S.list.profile && S.list.profile.title, nt = cur === ti ? null : ti;
      rpc('event_title_set', { p_title: nt }).then(function() { S.list.profile = S.list.profile || {}; S.list.profile.title = nt; render(); toast(nt ? 'Титул «' + nt + '» рядом с ником' : 'Титул снят', 'gold'); }, function(err) { toast(errText(err), 'bad'); });
      return;
    }
    if (t.hasAttribute('data-dv')) { var k = t.getAttribute('data-dv'), v = t.getAttribute('data-v'); S.dev[k] = k === 'tier' || k === 'bots' ? +v : v; if (k === 'event') S.dev.map = ''; render(); return; }
    if (t.id === 'ev-dev-go') {
      var d = S.dev; t.disabled = true;
      rpc('dev_event_start', { p_event: d.event, p_tier: d.tier, p_role: d.role, p_map: d.map || null, p_bots: d.bots }).then(function(r) { if (r && r.match) go(r.match.id); else { toast('Тест не создан', 'bad'); t.disabled = false; } }, function(err) { toast(errText(err), 'bad'); t.disabled = false; });
    }
  });

  document.addEventListener('DOMContentLoaded', function() {
    sbSessionGate().then(function(r) { S.uid = r.data.session.user.id; load(); });
  });
})();
