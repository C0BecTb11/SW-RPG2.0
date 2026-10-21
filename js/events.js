/* Лобби ивентов (game/events.html): каталог своей стороны, уровни и роли, очередь и подбор,
 * история, рейтинг, титулы; у администрации — тест без очереди (dev_event_start).
 * Каталог — shared/rt-events-cat.js, состояние — функции базы event_* (sql/events.sql).
 * Найден бой — переход на game/event-battle.html?m=<матч>. ES5.
 */
(function() {
  'use strict';
  var CAT = window.SWEventsCat;
  var S = { list: null, status: null, tab: 'list', f: 'all', pick: {}, maps: {}, hist: null, rate: null, rateSide: null, dev: { event: 'hunt_sith', tier: 1, role: 'hunter', map: '', bots: 2 }, pollT: 0, goT: 0 };
  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function(c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function fmt(n) { return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' '); }
  var toastT = 0;
  function toast(msg, kind) { var el = $('ev-toast'); el.textContent = msg; el.className = 'ev-toast show' + (kind ? ' ' + kind : ''); clearTimeout(toastT); toastT = setTimeout(function() { el.className = 'ev-toast'; }, 2800); }
  function rpc(fn, args) { return supabase.rpc(fn, args || {}).then(function(r) { if (r.error) throw new Error(r.error.message); return r.data; }); }
  function errText(e) { return String(e && e.message || e).replace(/^.*?: /, ''); }

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
    return Promise.all([rpc('event_list'), rpc('event_status'), fetch('../shared/events/maps/index.json').then(function(r) { return r.json(); }).catch(function() { return []; })]).then(function(r) {
      S.list = r[0]; S.status = r[1]; (r[2] || []).forEach(function(m) { S.maps[m.id] = m.name; });
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
      rpc('event_status').then(function(r) { var had = !!(S.status && S.status.match); S.status = r; queueBar(); if (!had && r.match) toast('Бой найден!', 'gold'); poll(); }, function() { poll(); });
    }, fast ? 2000 : 12000);
  }

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
    var pk = S.pick[E.id] || (S.pick[E.id] = { tier: 1, role: null });
    var myRoles = E.roles.filter(function(r) { return r.side === side; });
    if (!pk.role && myRoles.length) pk.role = myRoles[0].id;
    var tags = '<span class="ev-tag' + (E.kind === 'pvp' ? ' pvp' : '') + '">' + (E.kind === 'pvp' ? 'против игроков' : 'против бота') + '</span><span class="ev-tag">' + (E.theater === 'ground' ? 'наземка' : 'космос') + '</span>' +
      '<span class="ev-tag' + (E.troops === 'own' ? ' own' : '') + '">' + (E.troops === 'own' ? 'свои войска' : 'войска ивента') + '</span>';
    var cls = 'ev-card ' + E.kind + ' ' + (E.sides.length > 1 ? 'both' : E.sides[0]) + (ready ? '' : ' soon') + (ready ? ' wide' : '');
    var html = '<article class="' + cls + '" data-ev="' + E.id + '"><div class="ev-ribbon">скоро</div><div class="ev-head">' + icon(E.icon) +
      '<div class="ev-name"><b>' + esc(E.title) + '</b><em>' + esc(E.place) + '</em><div class="ev-tags">' + tags + '</div></div></div>';
    html += '<p class="ev-about">' + esc(E.about) + '</p>';
    if (!ready) return html + '</article>';
    if (E.maps.length) html += '<div class="ev-maps">' + E.maps.map(function(m) { return '<div class="ev-map" style="background-image:url(../assets/events/' + m + '.jpg?v=2)"><span>' + esc(S.maps[m] || m) + '</span></div>'; }).join('') + '</div>';
    if (E.goal && E.goal[side]) html += '<div class="ev-goal"><b>Твоя задача</b>' + esc(E.goal[side]) + '</div>';
    if (myRoles.length > 1 || E.roles.length > 1) {
      html += '<div><div class="ev-lab">Роль</div><div class="ev-roles">';
      E.roles.forEach(function(r) {
        var mine = r.side === side;
        html += '<button type="button" data-role="' + r.id + '"' + (mine ? '' : ' disabled') + ' class="' + (pk.role === r.id ? 'on' : '') + '"><b>' + esc(r.name) + '</b><em>' + (mine ? esc(r.about || '') : 'за ' + (r.side === 'cis' ? 'КНС' : 'Республику')) + ' · ' + (r.min === r.max ? r.max : r.min + '–' + r.max) + ' игр.</em></button>';
      });
      html += '</div></div>';
    }
    html += '<div><div class="ev-lab">Сложность</div><div class="ev-tiers">';
    CAT.TIERS.forEach(function(T) { html += '<button type="button" data-tier="' + T.n + '" class="' + (pk.tier === T.n ? 'on' : '') + '"><b>' + ['I', 'II', 'III'][T.n - 1] + ' · ' + T.name + '<i class="pip' + (trophy(E.id, T.n) ? ' got' : '') + '" title="' + (trophy(E.id, T.n) ? 'трофей получен' : 'трофея ещё нет') + '"></i></b><em>' + (E.minutes ? E.minutes[T.n - 1] + ' мин · ' : '') + '×' + String(T.k).replace('.', ',') + '</em></button>'; });
    html += '</div></div>';
    var title = pk.role && E.titles[pk.role];
    html += '<div class="ev-reward">Награда за победу: ' + rewardLine(E.id, pk.tier) + (pk.tier === 3 && title ? ' · титул <span class="t">«' + esc(title) + '»</span>' : '') + '</div>';
    var w = E.roles.map(function(r) { return esc(r.name.toLowerCase()) + ' <b>' + waitCount(E.id, pk.tier, r.id) + '</b>'; }).join(' · ');
    var inQ = S.status && S.status.queue && S.status.queue.event === E.id;
    html += '<div class="ev-foot"><div class="ev-wait">В очереди сейчас: ' + w + '<br>' + esc(CAT.TIERS[pk.tier - 1].about) + '</div>' +
      '<button type="button" class="ev-go" data-join="' + E.id + '"' + (myRoles.length ? '' : ' disabled') + '>' + (inQ ? 'В очереди' : 'В очередь') + '</button></div>';
    return html + '</article>';
  }
  function listView() {
    var side = S.list.side, all = CAT.forSide(side), f = S.f;
    var pass = function(E) { return f === 'all' || E.kind === f || E.theater === f; };
    var ready = all.filter(function(E) { return E.ready && pass(E); }), soon = all.filter(function(E) { return !E.ready && pass(E); });
    var html = '';
    if (ready.length) html += '<div class="ev-sec"><h2>Открыты</h2><span>' + ready.length + '</span></div><div class="ev-grid">' + ready.map(card).join('') + '</div>';
    var pvp = soon.filter(function(E) { return E.kind === 'pvp'; }), pve = soon.filter(function(E) { return E.kind === 'pve'; });
    if (pvp.length) html += '<div class="ev-sec"><h2>Против игроков — скоро</h2><span>' + pvp.length + '</span></div><div class="ev-grid">' + pvp.map(card).join('') + '</div>';
    if (pve.length) html += '<div class="ev-sec"><h2>Против бота — скоро</h2><span>' + pve.length + '</span></div><div class="ev-grid">' + pve.map(card).join('') + '</div>';
    return html || '<div class="ev-empty">Под этот фильтр ивентов нет</div>';
  }

  // ---------------------------------------------------------------- история и рейтинг
  function histView() {
    if (!S.hist) { rpc('event_history', { p_limit: 30 }).then(function(r) { S.hist = r || []; render(); }, function(e) { S.hist = []; toast(errText(e), 'bad'); render(); }); return '<div class="ev-load"><span></span>Загружаю…</div>'; }
    if (!S.hist.length) return '<div class="ev-empty">Боёв ещё не было. Встань в очередь — бой начнётся, как только наберутся игроки.</div>';
    return '<div class="ev-rows">' + S.hist.map(function(h) {
      var E = CAT.BY[h.event] || { title: h.event }, done = h.status === 'done', won = done && h.winner === h.role;
      var res = h.status === 'aborted' ? '<span class="r">отмена</span>' : !done ? '<span class="r">идёт</span>' : '<span class="r ' + (won ? 'win' : 'loss') + '">' + (won ? 'победа' : 'пораж.') + '</span>';
      var role = (CAT.role(h.event, h.role) || {}).name || h.role || '';
      var aw = h.award ? '+' + fmt(h.award.credits) + ' кр' + (Object.keys(h.award.resources || {}).length ? '<em>+ ресурсы на склад</em>' : '') + '<em>' + h.award.points + ' очк.</em>' : h.test ? '<em>тест</em>' : '';
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
    var other = E.roles.filter(function(r) { return r.id !== d.role && r.max > 1; })[0];
    if (other) html += '<div><div class="ev-lab">Ботов в роли «' + esc(other.name) + '»</div><div class="ev-chips">' + [1, 2, 3, 4].filter(function(n) { return n >= other.min && n <= other.max; }).map(function(n) { return '<button type="button" data-dv="bots" data-v="' + n + '" class="' + (d.bots === n ? 'on' : '') + '">' + n + '</button>'; }).join('') + '</div></div>';
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
      el.innerHTML = '<i class="ev-q-spin"></i><div class="ev-q-tx"><b>Бой найден: ' + esc(E.title) + '</b><em>' + esc(S.maps[st.match.map] || st.match.map) + ' · ' + ['I', 'II', 'III'][st.match.tier - 1] + (role ? ' · ты — <i>' + esc(role.name.toLowerCase()) + '</i>' : '') + (st.match.test ? ' · тест' : '') + '</em></div><button type="button" class="ev-go" id="ev-q-go">В бой</button>';
      // сам переводим в бой один раз на матч: вернулся из боя — остаётся кнопка
      var key = 'ev-go-' + st.match.id, once = false; try { once = !!sessionStorage.getItem(key); sessionStorage.setItem(key, '1'); } catch (e) {}
      clearTimeout(S.goT); if (!once) S.goT = setTimeout(function() { go(st.match.id); }, 2500);
      return;
    }
    clearTimeout(S.goT);
    if (!st.queue) { el.hidden = true; return; }
    var q = st.queue, E2 = CAT.BY[q.event], role2 = CAT.role(q.event, q.role), c = q.counts || {};
    var need = E2.roles.map(function(r) { var n = c[r.id] || 0; return r.name.toLowerCase() + ' <i>' + n + '</i>/' + r.max + (n < r.min ? ' (нужно ' + r.min + ')' : ''); }).join(' · ');
    var wait = q.wait || 0;
    el.hidden = false; el.className = 'ev-queue';
    el.innerHTML = '<i class="ev-q-spin"></i><div class="ev-q-tx"><b>' + esc(E2.title) + ' · ' + ['I', 'II', 'III'][q.tier - 1] + ' · ' + esc(role2 ? role2.name.toLowerCase() : q.role) + '</b><em>В очереди ' + Math.floor(wait / 60) + ':' + ('0' + wait % 60).slice(-2) + ' · ' + need + '</em></div><button type="button" class="ev-go ghost" id="ev-q-leave">Выйти</button>';
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
    var cardEl = t.closest('[data-ev]'), id = cardEl && cardEl.getAttribute('data-ev');
    if (t.hasAttribute('data-tier') && id) { S.pick[id].tier = +t.getAttribute('data-tier'); render(); return; }
    if (t.hasAttribute('data-role') && id) { S.pick[id].role = t.getAttribute('data-role'); render(); return; }
    if (t.hasAttribute('data-join')) {
      var pk = S.pick[id]; t.disabled = true;
      rpc('event_join', { p_event: id, p_tier: pk.tier, p_role: pk.role }).then(function(r) { S.status = r; queueBar(); poll(); toast(r.match ? 'Бой найден!' : 'Ты в очереди — бой начнётся, когда наберутся роли', 'gold'); render(); }, function(err) { toast(errText(err), 'bad'); render(); });
      return;
    }
    if (t.id === 'ev-q-leave') { rpc('event_leave').then(function(r) { S.status = r; queueBar(); render(); toast('Ты вышел из очереди'); }, function(err) { toast(errText(err), 'bad'); }); return; }
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
