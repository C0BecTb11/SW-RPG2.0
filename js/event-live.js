/* Бой ивента (game/event-battle.html): связка экрана наземки 2.0 (ground/ground.js по сети)
 * с худом ивента. Комната сервера — «ev:<матч>» (server/event-room.js); состояние ивента
 * приходит сообщениями ev (раз в 0,5 с, своё для каждой стороны) и evend (итог и награда).
 *
 * Худ: таймер и строка задач вверху; на карте — места задач, эвакуация, импульс сенсоров,
 * тревога и где цель видели в последний раз; брифинг в начале, итог с наградой в конце.
 * Замеры без базы: ?dev=dev-hunt_sith-2-sarn-hunter&srv=http://127.0.0.1:8080. ES5.
 */
(function() {
  'use strict';
  var CAT = window.SWEventsCat, EVS = window.SWEvents, HUNT = EVS ? EVS.HUNT : null;
  var SRV_FALLBACK = 'https://2-31-45-237.sslip.io';
  var Q = function(k) { var m = new RegExp('[?&]' + k + '=([^&]+)').exec(location.search); return m ? decodeURIComponent(m[1]) : ''; };
  var matchId = Q('m'), devRoom = Q('dev');
  var L = { hello: null, v: null, vAt: 0, end: null, camSet: false, briefShown: false, endShown: false };
  window.EVL = L;
  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function(c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function fmtT(t) { t = Math.max(0, Math.ceil(t)); return Math.floor(t / 60) + ':' + ('0' + t % 60).slice(-2); }
  function fmtN(n) { return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' '); }
  var GLYPH = {
    sith: '<path d="M5 19L17 5M7 5l12 14"/><path d="M4 18l2 2M18 18l2 2" stroke-width="2.4"/>',
    jedi: '<path d="M12 3v13"/><path d="M10 16h4v3h-4zM11 19v2h2v-2"/>',
    hunter: '<circle cx="12" cy="12" r="7"/><path d="M12 2v5M12 17v5M2 12h5M17 12h5"/><circle cx="12" cy="12" r="1.5"/>'
  };
  function glyph(k) { return '<svg viewBox="0 0 24 24" aria-hidden="true">' + (GLYPH[k] || GLYPH.hunter) + '</svg>'; }

  // ---------------------------------------------------------------- запуск
  function boot() {
    if (devRoom) { start(Q('srv') || 'http://127.0.0.1:8080', 'ev:' + devRoom, function() { return Promise.resolve('dev'); }); return; }
    if (!matchId) { location.href = 'events.html'; return; }
    sbSessionGate().then(function() {
      return supabase.rpc('event_status');
    }).then(function(r) {
      var st = r && r.data || {}, srv = (st.server && st.server.url) || SRV_FALLBACK;
      if (st.server && st.server.online === false) setTimeout(function() { if (window.GD) GD.toast('Сервер боёв не на связи — бой может не открыться', 'bad'); }, 1500);
      start(srv, 'ev:' + matchId, function() { return supabase.auth.getSession().then(function(x) { var s = x && x.data && x.data.session; return s ? s.access_token : ''; }); });
    }, function() { start(SRV_FALLBACK, 'ev:' + matchId, function() { return supabase.auth.getSession().then(function(x) { var s = x && x.data && x.data.session; return s ? s.access_token : ''; }); }); });
  }
  function start(srv, room, token) {
    window.GD_TOKEN = token;
    window.GD_LIVE = { system: 'ev', room: room, srv: srv, ws: null, tries: 0 };
    var s = document.createElement('script'); s.src = '../ground/ground.js?v=10'; document.body.appendChild(s);
  }

  // ---------------------------------------------------------------- бой открылся
  window.GD_ON_HELLO = function(h) {
    L.hello = h; var e = h.ev || {}, E = CAT.BY[e.event] || {}, T = CAT.TIERS[(e.tier || 1) - 1] || CAT.TIERS[0];
    $('sp-kicker').textContent = (E.title || 'Ивент') + ' · ' + ['I', 'II', 'III'][(e.tier || 1) - 1] + ' ' + T.name;
    $('gd-planet').textContent = e.place || h.name || '';
    var g = $('gd-goal'); g.textContent = (e.roleName ? 'ты — ' + e.roleName.toLowerCase() : '') + (e.test ? ' · тест' : ''); g.className = 'gd-goal' + (e.role === 'hunter' ? '' : ' att');
    $('gd-globe').innerHTML = glyph(e.role === 'hunter' ? 'hunter' : e.role);
    document.title = (E.title || 'Ивент') + ' — Star Wars: Global Conflict';
    if (!L.briefShown) brief();
  };
  function brief() {
    L.briefShown = true;
    var h = L.hello, e = h.ev || {}, E = CAT.BY[e.event] || {}, ti = (e.tier || 1) - 1, prey = e.role !== 'hunter', items = [];
    $('ev-brief-k').textContent = 'Брифинг · ' + (E.title || '') + ' · ' + (CAT.TIERS[ti] || {}).name;
    $('ev-brief-title').textContent = e.place || '';
    $('ev-brief-goal').textContent = e.goal || '';
    if (HUNT) {
      var word = e.event === 'hunt_jedi' ? 'джедаи' : 'ситх';
      if (prey) {
        items.push('Задач: <b>' + HUNT.tasks[ti] + '</b>. Встань у места задачи и держись <b>' + HUNT.channel[ti] + ' с</b> — прогресс копится, даже если отойдёшь.');
        items.push('Когда все задачи выполнены, открывается <b>эвакуация</b>: продержись на ней ' + HUNT.extract + ' с.');
        items.push('Охотники видят все места задач и получают <b>тревогу</b>, когда ты начинаешь задачу.');
        items.push('Раз в ' + HUNT.ping[ti] + ' с сенсоры охотников показывают им <b>круг</b>, где ты сейчас. Убей сенсорщиков — импульсы прекратятся.');
        if (HUNT.sneak[ti]) items.push('Ты незаметен дальше <b>' + HUNT.sneak[ti] * 3 + ' клеток</b>. Удар и силы выдают тебя на ' + HUNT.reveal + ' с.');
        items.push('Другой путь к победе — перебить всех охотников.');
      } else {
        items.push('Цель — ' + (e.event === 'hunt_jedi' ? 'джедаи' : 'ситх') + '. Найди и уничтожь до эвакуации. Время: <b>' + (e.minutes || 15) + ' мин</b>.');
        items.push('Места задач видны на карте. Когда враг начинает задачу — <b>тревога</b> у места.');
        items.push('Сенсорщик отряда раз в <b>' + HUNT.ping[ti] + ' с</b> даёт импульс: круг, где сейчас ' + word + '. Береги сенсорщиков.');
        if (HUNT.sneak[ti]) items.push('Цель видна только ближе <b>' + HUNT.sneak[ti] * 3 + ' клеток</b> — пока не ударит или не применит силу.');
        items.push('Держи дистанцию: клинок бьёт в упор, бластеры — издалека.');
      }
    }
    $('ev-brief-list').innerHTML = items.map(function(t) { return '<li>' + t + '</li>'; }).join('');
    $('ev-brief-who').innerHTML = (e.players || []).map(function(p) { var r = CAT.role(e.event, p.role); return '<span class="' + (p.me ? 'me' : p.bot ? 'bot' : '') + '">' + esc(r ? r.name : p.role) + ' · ' + esc(p.me ? 'ты' : p.bot ? 'бот' : p.nick) + '</span>'; }).join('');
    $('ev-brief').hidden = false;
  }
  $('ev-brief-go').onclick = function() { $('ev-brief').hidden = true; };

  // ---------------------------------------------------------------- состояние ивента
  window.GD_ON_EV = function(m) {
    if (m.t === 'ev') {
      L.v = m.v; L.vAt = Date.now();
      // откаты сил своих героев — экран не считает их сам
      if (m.v.cds && window.GD && GD.B) m.v.cds.forEach(function(r) { var a = GD.B.agents[r[0]]; if (a && a.hero) { a.hero.cds = {}; Object.keys(r[1]).forEach(function(k) { a.hero.cds[k] = GD.B.t + r[1][k]; }); } });
      top();
      if (!L.camSet) camToMine();
      if (m.v.over && !L.endShown) showEnd(m.v.over, null);
    } else if (m.t === 'evend') { L.end = m; showEnd(m.result || {}, m.awards, m.aborted, m); }
  };
  function left() { var v = L.v; if (!v) return 0; return v.over ? v.left : Math.max(0, v.left - (Date.now() - L.vAt) / 1000); }
  function top() {
    var v = L.v; if (!v) return;
    var t = left(), el = $('ev-timer'); el.textContent = fmtT(t); el.className = 'ev-timer' + (t < 60 && !v.over ? ' low' : '');
    $('ev-line').innerHTML = line(v, true);
  }
  setInterval(function() { if (L.v) { var el = $('ev-timer'), t = left(); el.textContent = fmtT(t); el.className = 'ev-timer' + (t < 60 && !L.v.over ? ' low' : ''); } }, 250);
  function line(v, compact) {
    var html = '', prey = v.role !== 'hunter';
    if (prey) {
      (v.tasks || []).forEach(function(k) { html += '<span class="ev-pill' + (k[2] ? ' done' : k[1] > 0 ? ' act' : '') + '">' + (k[2] ? '✓ ' : '') + esc(k[0]) + (k[2] ? '' : '<i><u style="width:' + k[1] + '%"></u></i>') + '</span>'; });
      if (v.exit) html += '<span class="ev-pill exit">⇪ ' + esc(v.exit[2]) + ' <i><u style="width:' + v.exit[3] + '%;background:#5fd968"></u></i></span>';
      if (v.nextPing >= 0) html += '<span class="ev-pill' + (v.nextPing <= 5 ? ' bad' : '') + '">импульс охотников через <b>' + v.nextPing + ' с</b></span>';
    } else {
      html += '<span class="ev-pill">задач врага <b>' + v.done + '/' + v.need + '</b></span>';
      if (v.nextPing >= 0) html += '<span class="ev-pill' + (v.ping ? ' act' : '') + '">' + (v.ping ? 'импульс на карте' : 'импульс через <b>' + v.nextPing + ' с</b>') + '</span>';
      else html += '<span class="ev-pill bad">сенсорщики погибли</span>';
      if (v.alarm) html += '<span class="ev-pill bad">тревога: ' + esc(v.alarm[2]) + '</span>';
      if (v.seen) html += '<span class="ev-pill bad">цель видели ' + (v.seen[2] < 1 ? 'сейчас' : v.seen[2] + ' с назад') + '</span>';
      if (v.exit) html += '<span class="ev-pill bad">эвакуация врага: ' + esc(v.exit[2]) + ' ' + v.exit[3] + '%</span>';
    }
    return html;
  }
  // нижняя полоса: строка ивента уже вверху — здесь только подсказки экрана
  window.GD_EV_LINE = function() { return ''; };
  function camToMine() {
    if (!window.GD || !GD.B || !GD.CAM) return;
    var B = GD.B, x = 0, y = 0, n = 0;
    B.agents.forEach(function(a) { if (a && a.alive && a.team === GD.side && a.vis) { x += a.x; y += a.y; n++; } });
    if (!n) return;
    GD.CAM.x = x / n; GD.CAM.y = y / n; GD.CAM.s = Math.max(10, Math.min(window.innerWidth, window.innerHeight) / 34);
    L.camSet = true;
  }

  // ---------------------------------------------------------------- разметка на карте
  var TAU = Math.PI * 2;
  function label(c, text, x, y, col) {
    c.font = 'bold 10px "Courier New", monospace'; c.textAlign = 'center'; c.textBaseline = 'middle';
    var w = text.length * 6.3 + 8; c.fillStyle = 'rgba(5,6,10,0.72)'; c.fillRect(x - w / 2, y - 7, w, 14);
    c.fillStyle = col; c.fillText(text, x, y);
  }
  function diamond(c, x, y, r) { c.beginPath(); c.moveTo(x, y - r); c.lineTo(x + r, y); c.lineTo(x, y + r); c.lineTo(x - r, y); c.closePath(); }
  window.GD_DRAW = function(c, s, dpr) {
    var v = L.v; if (!v || !window.GD) return;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    var now = performance.now() / 1000, pulse = 0.5 + 0.5 * Math.sin(now * 4), prey = v.role !== 'hunter', R = Math.max(7, 2.4 * s);
    // импульс сенсоров
    if (v.ping) {
      var pp = GD.toS(v.ping[0], v.ping[1]), pr = v.ping[2] * s, fade = Math.min(1, v.ping[3] / 3);
      c.fillStyle = 'rgba(255,110,90,' + (0.08 * fade).toFixed(3) + ')'; c.beginPath(); c.arc(pp[0], pp[1], pr, 0, TAU); c.fill();
      c.strokeStyle = 'rgba(255,110,90,' + (0.85 * fade).toFixed(3) + ')'; c.lineWidth = 2; c.setLineDash([6, 5]); c.beginPath(); c.arc(pp[0], pp[1], pr, 0, TAU); c.stroke(); c.setLineDash([]);
      c.strokeStyle = 'rgba(255,110,90,' + (0.4 * fade * pulse).toFixed(3) + ')'; c.beginPath(); c.arc(pp[0], pp[1], pr * (0.4 + 0.6 * ((now * 0.8) % 1)), 0, TAU); c.stroke();
      label(c, 'ИМПУЛЬС', pp[0], pp[1] - pr - 10, '#ff9a80');
    }
    // места задач
    (v.sites || []).forEach(function(st) {
      var p = GD.toS(st[0], st[1]), state = st[3], isAlarm = v.alarm && Math.abs(v.alarm[0] - st[0]) < 0.6 && Math.abs(v.alarm[1] - st[1]) < 0.6;
      var col = prey ? (state === 2 ? '95,217,104' : state === 1 ? '240,200,106' : '217,169,64') : (state === 2 ? '110,120,130' : isAlarm ? '255,110,90' : '143,168,196');
      c.fillStyle = 'rgba(' + col + ',0.16)'; diamond(c, p[0], p[1], R); c.fill();
      c.strokeStyle = 'rgba(' + col + ',0.95)'; c.lineWidth = 2; diamond(c, p[0], p[1], R); c.stroke();
      if (prey && state !== 2 && st[4] > 0) { c.strokeStyle = 'rgba(240,200,106,0.95)'; c.lineWidth = 3; c.beginPath(); c.arc(p[0], p[1], R + 5, -Math.PI / 2, -Math.PI / 2 + TAU * st[4] / 100); c.stroke(); }
      if (isAlarm) { c.strokeStyle = 'rgba(255,110,90,' + (0.3 + 0.6 * pulse).toFixed(2) + ')'; c.lineWidth = 2; c.beginPath(); c.arc(p[0], p[1], R + 6 + pulse * 6, 0, TAU); c.stroke(); }
      c.font = 'bold ' + Math.round(Math.max(9, R * 0.9)) + 'px "Courier New", monospace'; c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillStyle = 'rgba(' + col + ',1)'; c.fillText(state === 2 ? (prey ? '✓' : '×') : prey ? '!' : '?', p[0], p[1] + 0.5);
      if (s >= 3.2) label(c, st[2].toUpperCase() + (prey && state !== 2 && st[4] > 0 ? ' ' + st[4] + '%' : ''), p[0], p[1] + R + 12, 'rgba(' + col + ',1)');
    });
    // эвакуация
    if (prey && !v.exit) (v.exits || []).forEach(function(e) { var p = GD.toS(e[0], e[1]), w = 6 * s; c.strokeStyle = 'rgba(95,217,104,0.35)'; c.lineWidth = 1; c.setLineDash([4, 4]); c.strokeRect(p[0] - w / 2, p[1] - w / 2, w, w); c.setLineDash([]); if (s >= 4) label(c, e[2], p[0], p[1] + w / 2 + 9, 'rgba(143,232,154,0.6)'); });
    if (v.exit) {
      var ep = GD.toS(v.exit[0], v.exit[1]), ew = 6 * s, col2 = prey ? '95,217,104' : '255,110,90';
      c.fillStyle = 'rgba(' + col2 + ',' + (0.08 + 0.08 * pulse).toFixed(3) + ')'; c.fillRect(ep[0] - ew / 2, ep[1] - ew / 2, ew, ew);
      c.strokeStyle = 'rgba(' + col2 + ',0.95)'; c.lineWidth = 2; c.strokeRect(ep[0] - ew / 2, ep[1] - ew / 2, ew, ew);
      if (v.exit[3] > 0) { c.fillStyle = 'rgba(' + col2 + ',0.9)'; c.fillRect(ep[0] - ew / 2, ep[1] + ew / 2 + 3, ew * v.exit[3] / 100, 3); }
      label(c, (prey ? 'ЭВАКУАЦИЯ · ' : 'ЭВАКУАЦИЯ ВРАГА · ') + v.exit[2].toUpperCase(), ep[0], ep[1] - ew / 2 - 10, prey ? '#8fe89a' : '#ff9a80');
    }
    // где цель видели
    if (v.seen && v.seen[2] >= 1) {
      var sp = GD.toS(v.seen[0] + 0.5, v.seen[1] + 0.5), a = Math.max(0.25, 1 - v.seen[2] / 20);
      c.strokeStyle = 'rgba(255,110,90,' + a.toFixed(2) + ')'; c.lineWidth = 1.5;
      c.beginPath(); c.arc(sp[0], sp[1], 9, 0, TAU); c.moveTo(sp[0] - 14, sp[1]); c.lineTo(sp[0] - 5, sp[1]); c.moveTo(sp[0] + 5, sp[1]); c.lineTo(sp[0] + 14, sp[1]); c.moveTo(sp[0], sp[1] - 14); c.lineTo(sp[0], sp[1] - 5); c.moveTo(sp[0], sp[1] + 5); c.lineTo(sp[0], sp[1] + 14); c.stroke();
      label(c, v.seen[2] + ' с назад', sp[0], sp[1] + 22, 'rgba(255,154,128,' + a.toFixed(2) + ')');
    }
  };
  window.GD_MINI = function(c, x0, y0, k) {
    var v = L.v; if (!v) return;
    (v.sites || []).forEach(function(st) { c.fillStyle = st[3] === 2 ? '#5fd968' : v.role !== 'hunter' ? '#f0c86a' : '#8fa8c4'; c.fillRect(x0 + st[0] * k - 2, y0 + st[1] * k - 2, 4, 4); });
    if (v.exit) { c.strokeStyle = v.role !== 'hunter' ? '#5fd968' : '#ff6e5a'; c.lineWidth = 1.5; c.strokeRect(x0 + (v.exit[0] - 3) * k, y0 + (v.exit[1] - 3) * k, 6 * k, 6 * k); }
    if (v.ping) { c.strokeStyle = 'rgba(255,110,90,0.9)'; c.lineWidth = 1; c.beginPath(); c.arc(x0 + v.ping[0] * k, y0 + v.ping[1] * k, v.ping[2] * k, 0, TAU); c.stroke(); }
  };

  // ---------------------------------------------------------------- итог
  window.GD_ON_END = function(win, why) { if (!L.endShown) showEnd(L.v && L.v.over ? L.v.over : { why: why, winner: win ? myRole() : '' }, null); };
  function myRole() { return L.hello && L.hello.ev ? L.hello.ev.role : ''; }
  function showEnd(res, aw, aborted, m) {
    m = m || L.end || {};
    var e = L.hello && L.hello.ev || {}, won = !aborted && res.winner === e.role;
    L.endShown = true;
    var el = $('ev-end');
    el.className = 'sp-end ev-end ' + (aborted ? '' : won ? 'win' : 'loss');
    $('ev-end-k').textContent = 'Итог · ' + ((CAT.BY[e.event] || {}).title || 'ивент');
    $('ev-end-mark').innerHTML = glyph(e.role === 'hunter' ? 'hunter' : e.role);
    $('ev-end-title').textContent = aborted ? 'Бой отменён' : won ? 'Победа' : 'Поражение';
    $('ev-end-why').textContent = res.why || '';
    var mine = m.me ? m.me.kills : 0;
    $('ev-end-stats').innerHTML = aborted ? '' : '<div><b>' + fmtT(res.t || 0) + '</b><span>длился</span></div><div><b>' + (res.tasks != null ? res.tasks + '/' + res.need : '—') + '</b><span>задач</span></div><div><b>' + mine + '</b><span>твоих убийств</span></div>';
    var a = $('ev-end-award');
    if (aw) {
      var res2 = Object.keys(aw.res || {}).map(function(k) { return aw.res[k] + ' ' + CAT.RES_NAME[k]; }).join(', ');
      a.innerHTML = (aw.credits > 0 ? '+' + fmtN(aw.credits) + ' кредитов' : 'Без награды') + (res2 ? '<br><em>на склад: ' + esc(res2) + '</em>' : '') + (aw.points ? '<br><em>+' + aw.points + ' очков рейтинга</em>' : '') +
        (aw.title ? '<span class="ttl">Новый титул: «' + esc(aw.title) + '»</span>' : '') + (aw.won ? '<span class="ttl" style="color:#e8d9a8">Трофей уровня ' + ['I', 'II', 'III'][(e.tier || 1) - 1] + '</span>' : '');
    } else if (e.test || m.test) a.innerHTML = '<em>Тестовый бой — награда не начисляется</em>';
    else if (aborted) a.innerHTML = '<em>Бой отменён — награды нет</em>';
    else if (L.end && m.saved === false) a.innerHTML = '<em>Итог не удалось записать — сообщи администрации, награду начислят вручную</em>';
    else if (L.end && res.forfeit && (res.t || 0) < 180) a.innerHTML = '<em>Соперник ушёл слишком рано — бой без награды</em>';
    else if (L.end) a.innerHTML = '<em>Награда — в «Истории» ивентов</em>';
    else a.innerHTML = '<em>Подсчёт награды…</em>';
    el.hidden = false;
  }
  $('ev-end-look').onclick = function() { $('ev-end').hidden = true; };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
