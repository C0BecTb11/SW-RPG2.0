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
    // токен и адрес сервера — с пределом ожидания (js/supabase-client.js): зависшая сессия
    // или молчащая база не держат вход в бой, а случай виден в журнале
    var tok = function() { return sbAccessToken(5000); };
    sbSessionGate().then(function() {
      return sbWithin(supabase.rpc('event_status'), 8000, 'event_status');
    }).then(function(r) {
      var st = r && r.data || {}, srv = (st.server && st.server.url) || SRV_FALLBACK;
      if (st.server && st.server.online === false) setTimeout(function() { if (window.GD) GD.toast('Сервер боёв не на связи — бой может не открыться', 'bad'); }, 1500);
      start(srv, 'ev:' + matchId, tok);
    }, function() { start(SRV_FALLBACK, 'ev:' + matchId, tok); });
  }
  function start(srv, room, token) {
    window.GD_TOKEN = token;
    window.GD_LIVE = { system: 'ev', room: room, srv: srv, ws: null, tries: 0 };
    var s = document.createElement('script'); s.src = '../ground/ground.js?v=25'; document.body.appendChild(s);
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
        items.push('Когда все задачи выполнены, вызывается <b>шаттл</b>: он сядет через ' + HUNT.eta[ti] + ' с, потом продержись на площадке ' + HUNT.extract + ' с. Охотники тоже узнают, куда он летит.');
        items.push('Охотники видят все места задач и получают <b>тревогу</b>, когда ты начинаешь задачу.');
        items.push('Раз в ' + HUNT.ping[ti] + ' с сенсоры охотников показывают им <b>круг</b>, где ты сейчас. Убей сенсорщиков — импульсы прекратятся.');
        if (HUNT.sneak[ti]) items.push('Ты незаметен дальше <b>' + HUNT.sneak[ti] * 3 + ' клеток</b>. Удар и силы выдают тебя на ' + HUNT.reveal + ' с.');
        items.push('Другой путь к победе — перебить всех охотников.');
      } else {
        items.push('Цель — ' + (e.event === 'hunt_jedi' ? 'джедаи' : 'ситх') + '. Найди и уничтожь до эвакуации. Время: <b>' + (e.minutes || 15) + ' мин</b>.');
        items.push('Места задач видны на карте. Когда враг начинает задачу — <b>тревога</b> у места: держится, пока он там, и показывает, сколько ему осталось.');
        items.push('Выполнив задачи, враг вызывает <b>шаттл</b> — он сядет через ' + HUNT.eta[ti] + ' с. Успей к площадке.');
        items.push('Сенсорщик отряда раз в <b>' + HUNT.ping[ti] + ' с</b> даёт импульс: круг, где сейчас ' + word + '. Береги сенсорщиков.');
        if (HUNT.sneak[ti]) items.push('Цель скрытна: видна только ближе <b>' + HUNT.sneak[ti] * 3 + ' клеток</b> к твоим бойцам — это <b>голубая зона</b> вокруг них. Удар или сила выдают цель на ' + HUNT.reveal + ' с. Туман рассеивается дальше, но скрытую цель в нём не видно.');
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
      if (v.exit) html += '<span class="ev-pill exit">⇪ ' + esc(v.exit[2]) + (v.exit[4] > 0 ? ' · шаттл через <b>' + v.exit[4] + ' с</b>' : ' <i><u style="width:' + v.exit[3] + '%;background:#5fd968"></u></i>') + '</span>';
      if (v.nextPing >= 0) html += '<span class="ev-pill' + (v.nextPing <= 5 ? ' bad' : '') + '">импульс охотников через <b>' + v.nextPing + ' с</b></span>';
    } else {
      html += '<span class="ev-pill">задач врага <b>' + v.done + '/' + v.need + '</b></span>';
      var sn = HUNT && HUNT.sneak[(v.tier || 1) - 1];
      if (sn) html += '<span class="ev-pill zone">цель скрыта · видна в голубой зоне — ближе <b>' + sn * 3 + ' кл.</b></span>';
      if (v.nextPing >= 0) html += '<span class="ev-pill' + (v.ping ? ' act' : '') + '">' + (v.ping ? 'импульс на карте' : 'импульс через <b>' + v.nextPing + ' с</b>') + '</span>';
      else html += '<span class="ev-pill bad">сенсорщики погибли</span>';
      if (v.alarm) html += '<span class="ev-pill bad">тревога: ' + esc(v.alarm[2]) + (v.alarm[4] ? ' · ' + v.alarm[5] + '%' : '') + '</span>';
      if (v.seen) html += '<span class="ev-pill bad">цель видели ' + (v.seen[2] < 1 ? 'сейчас' : v.seen[2] + ' с назад') + '</span>';
      if (v.exit) html += '<span class="ev-pill bad">эвакуация врага: ' + esc(v.exit[2]) + (v.exit[4] > 0 ? ' · шаттл через <b>' + v.exit[4] + ' с</b>' : ' ' + v.exit[3] + '%') + '</span>';
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
  var NEAR = 6;                                             // с этого масштаба предметы мест видны сами — вместо ромбов подписи
  function forceCol() { return L.hello && L.hello.ev && L.hello.ev.event === 'hunt_jedi' ? '120,190,255' : '255,72,60'; }
  function preyTeam() { return L.hello && L.hello.ev && L.hello.ev.event === 'hunt_jedi' ? 0 : 1; }
  function glow(c, x, y, r, col, a) { if (r <= 0) return; var g = c.createRadialGradient(x, y, 0, x, y, r); g.addColorStop(0, 'rgba(' + col + ',' + a + ')'); g.addColorStop(1, 'rgba(' + col + ',0)'); c.fillStyle = g; c.fillRect(x - r, y - r, r * 2, r * 2); }
  // состояние места для своей стороны: 0 — ждёт, 1 — идёт удержание, 2 — выполнено; и прогресс
  function siteState(v, st) {
    if (v.role !== 'hunter') return [st[3], st[4]];
    var al = v.alarm && Math.abs(v.alarm[0] - st[0]) < 0.6 && Math.abs(v.alarm[1] - st[1]) < 0.6 ? v.alarm : null;
    return st[3] === 2 ? [2, 100] : al && al[4] ? [1, al[5]] : [0, al ? al[5] : 0];
  }
  // Шаттл эвакуации сверху: k — 0 (высоко, мелкий, тень далеко) … 1 (сел)
  function shuttle(c, x, y, s, k, now, landed) {
    var L0 = 2.6 * s, alt = (1 - k) * (1 - k), sx = x - alt * 9 * s, sy = y - alt * 11 * s, sc = 0.7 + 0.3 * k;
    // тень на земле — ровно под точкой посадки, растёт и темнеет
    c.save(); c.translate(x + (1 - k) * 2.5 * s, y + (1 - k) * 3 * s); c.scale(0.6 + 0.4 * k, 0.6 + 0.4 * k);
    c.fillStyle = 'rgba(0,0,0,' + (0.15 + 0.3 * k).toFixed(3) + ')'; hull(c, L0); c.fill(); c.restore();
    c.save(); c.translate(sx, sy); c.scale(sc, sc);
    // двигатели
    var fl = landed ? 0.35 : 0.8 + 0.2 * Math.sin(now * 30);
    glow(c, -L0 * 0.55, -L0 * 0.16, L0 * 0.32 * fl, '150,200,255', 0.7); glow(c, -L0 * 0.55, L0 * 0.16, L0 * 0.32 * fl, '150,200,255', 0.7);
    hull(c, L0); var g = c.createLinearGradient(-L0 * 0.5, -L0 * 0.5, L0 * 0.5, L0 * 0.5); g.addColorStop(0, '#e9e6de'); g.addColorStop(1, '#8d8a84'); c.fillStyle = g; c.fill();
    c.strokeStyle = 'rgba(40,40,44,0.8)'; c.lineWidth = Math.max(1, s * 0.05); c.stroke();
    c.strokeStyle = 'rgba(60,60,66,0.6)'; c.lineWidth = Math.max(0.6, s * 0.03); c.beginPath(); c.moveTo(-L0 * 0.4, 0); c.lineTo(L0 * 0.3, 0); c.stroke();
    c.fillStyle = '#c0453a'; c.fillRect(-L0 * 0.2, -L0 * 0.36, L0 * 0.18, L0 * 0.05); c.fillRect(-L0 * 0.2, L0 * 0.31, L0 * 0.18, L0 * 0.05);
    c.fillStyle = 'rgba(30,50,70,0.95)'; c.beginPath(); c.ellipse(L0 * 0.36, 0, L0 * 0.1, L0 * 0.07, 0, 0, TAU); c.fill();
    c.fillStyle = 'rgba(170,220,255,0.6)'; c.beginPath(); c.ellipse(L0 * 0.38, -L0 * 0.02, L0 * 0.04, L0 * 0.025, 0, 0, TAU); c.fill();
    var bl = Math.sin(now * 6) > 0; c.fillStyle = bl ? '#ff5a4a' : '#5aff7a'; c.beginPath(); c.arc(-L0 * 0.1, -L0 * 0.44, Math.max(1.5, s * 0.07), 0, TAU); c.arc(-L0 * 0.1, L0 * 0.44, Math.max(1.5, s * 0.07), 0, TAU); c.fill();
    if (landed) { c.fillStyle = 'rgba(40,38,36,0.9)'; c.fillRect(-L0 * 0.62, -L0 * 0.08, L0 * 0.16, L0 * 0.16); c.fillStyle = 'rgba(255,214,130,0.5)'; c.fillRect(-L0 * 0.6, -L0 * 0.06, L0 * 0.12, L0 * 0.12); }
    c.restore();
  }
  // корпус: нос на восток, короткие крылья, хвост с двумя дюзами
  function hull(c, L0) {
    c.beginPath(); c.moveTo(L0 * 0.5, 0); c.lineTo(L0 * 0.22, -L0 * 0.14); c.lineTo(-L0 * 0.05, -L0 * 0.16); c.lineTo(-L0 * 0.22, -L0 * 0.48); c.lineTo(-L0 * 0.34, -L0 * 0.48); c.lineTo(-L0 * 0.3, -L0 * 0.2);
    c.lineTo(-L0 * 0.52, -L0 * 0.2); c.lineTo(-L0 * 0.52, L0 * 0.2); c.lineTo(-L0 * 0.3, L0 * 0.2); c.lineTo(-L0 * 0.34, L0 * 0.48); c.lineTo(-L0 * 0.22, L0 * 0.48); c.lineTo(-L0 * 0.05, L0 * 0.16); c.lineTo(L0 * 0.22, L0 * 0.14); c.closePath();
  }
  // Зона обнаружения скрытой цели (охотники, уровни II–III): объединение кругов вокруг своих бойцов —
  // тонкая кромка и лёгкая заливка. Круги рисуются в запасной холст, кромка — вычитанием меньших.
  var ZONE = { fill: null, edge: null };
  function zoneCanvas(k, w, h) { var cv = ZONE[k]; if (!cv) cv = ZONE[k] = document.createElement('canvas'); if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; } return cv; }
  function detectZone(c, s, dpr, v) {
    var sneak = HUNT.sneak[(v.tier || 1) - 1] || 0; if (!sneak || v.role !== 'hunter') return;
    var B = GD.B, r = sneak * 3 * s, w = c.canvas.width, h = c.canvas.height, pts = [];
    B.agents.forEach(function(a) { if (a && a.alive && a.team === GD.side) pts.push(GD.toS(a.x, a.y)); });
    if (!pts.length || r < 6) return;
    var f = zoneCanvas('fill', w, h), fx = f.getContext('2d'), e = zoneCanvas('edge', w, h), ex = e.getContext('2d');
    fx.setTransform(1, 0, 0, 1, 0, 0); fx.clearRect(0, 0, w, h); fx.setTransform(dpr, 0, 0, dpr, 0, 0); fx.fillStyle = '#fff';
    pts.forEach(function(p) { fx.beginPath(); fx.arc(p[0], p[1], r, 0, TAU); fx.fill(); });
    ex.setTransform(1, 0, 0, 1, 0, 0); ex.globalCompositeOperation = 'source-over'; ex.clearRect(0, 0, w, h); ex.drawImage(f, 0, 0);
    ex.globalCompositeOperation = 'destination-out'; ex.setTransform(dpr, 0, 0, dpr, 0, 0);
    pts.forEach(function(p) { ex.beginPath(); ex.arc(p[0], p[1], Math.max(1, r - 1.6), 0, TAU); ex.fill(); });
    ex.globalCompositeOperation = 'source-over';
    c.save(); c.setTransform(1, 0, 0, 1, 0, 0);
    // заливка и кромка — цветом сенсоров охотников
    c.globalAlpha = 0.06; c.drawImage(tint(f, '143,200,255'), 0, 0);
    c.globalAlpha = 0.55; c.drawImage(tint(e, '143,200,255'), 0, 0);
    c.restore();
  }
  var TINT = {};
  function tint(src, col) {
    var t = TINT[col]; if (!t) t = TINT[col] = document.createElement('canvas');
    if (t.width !== src.width || t.height !== src.height) { t.width = src.width; t.height = src.height; }
    var x = t.getContext('2d'); x.globalCompositeOperation = 'source-over'; x.clearRect(0, 0, t.width, t.height); x.drawImage(src, 0, 0);
    x.globalCompositeOperation = 'source-in'; x.fillStyle = 'rgb(' + col + ')'; x.fillRect(0, 0, t.width, t.height); x.globalCompositeOperation = 'source-over';
    return t;
  }
  // Под бойцами: круг, где стоять; удержание Силой; погасшие места; площадка эвакуации и севший шаттл
  window.GD_UNDER = function(c, s, dpr) {
    var v = L.v; if (!v || !window.GD || !HUNT) return;
    detectZone(c, s, dpr, v);
    var now = performance.now() / 1000, prey = v.role !== 'hunter', fc = forceCol(), B = GD.B, pt = preyTeam();
    (v.sites || []).forEach(function(st) {
      var p = GD.toS(st[0], st[1]), ss = siteState(v, st), state = ss[0], R = HUNT.site * s;
      if (state === 2) {
        // выполнено: место гаснет — копоть и тлеющие искры
        var g = c.createRadialGradient(p[0], p[1], 0, p[0], p[1], 2.4 * s); g.addColorStop(0, 'rgba(8,6,6,0.55)'); g.addColorStop(1, 'rgba(8,6,6,0)'); c.fillStyle = g; c.beginPath(); c.arc(p[0], p[1], 2.4 * s, 0, TAU); c.fill();
        for (var e = 0; e < 5; e++) { var ph = (now * 0.35 + e / 5) % 1, ex = p[0] + Math.sin(e * 2.4 + now * 0.7) * s * 0.6, ey = p[1] - ph * s * 2.2; c.fillStyle = 'rgba(' + (prey ? '255,170,90' : '170,170,180') + ',' + (0.6 * (1 - ph)).toFixed(3) + ')'; c.beginPath(); c.arc(ex, ey, Math.max(1, s * 0.07 * (1 - ph * 0.5)), 0, TAU); c.fill(); }
        return;
      }
      if (s >= NEAR && state === 0) { c.strokeStyle = prey ? 'rgba(240,200,106,0.55)' : 'rgba(143,168,196,0.35)'; c.lineWidth = 1.5; c.setLineDash([5, 6]); c.lineDashOffset = -now * 6; c.beginPath(); c.arc(p[0], p[1], R, 0, TAU); c.stroke(); c.setLineDash([]); c.lineDashOffset = 0; }
      if (state !== 1) return;
      // удержание: вращаются кольца рун, свет столбом, искры стягиваются к середине, нити к герою
      var pulse = 0.5 + 0.5 * Math.sin(now * 5);
      c.save(); c.translate(p[0], p[1]);
      c.globalCompositeOperation = 'lighter';
      glow(c, 0, 0, R * 1.2, fc, 0.1 + 0.06 * pulse);
      c.rotate(now * 0.9); c.strokeStyle = 'rgba(' + fc + ',0.75)'; c.lineWidth = Math.max(1.2, s * 0.08); c.setLineDash([s * 0.5, s * 0.3]); c.beginPath(); c.arc(0, 0, R * 0.78, 0, TAU); c.stroke();
      c.rotate(-now * 2.1); c.lineWidth = Math.max(1, s * 0.05); c.setLineDash([s * 0.18, s * 0.22]); c.beginPath(); c.arc(0, 0, R * 0.55, 0, TAU); c.stroke(); c.setLineDash([]);
      c.restore();
      c.save(); c.globalCompositeOperation = 'lighter';
      for (var i = 0; i < 14; i++) { var f = (now * 0.6 + i / 14) % 1, a = i * 2.39996 + now * 1.4 * (i % 2 ? 1 : -1), r = R * (1.15 - f), px = p[0] + Math.cos(a) * r, py = p[1] + Math.sin(a) * r; c.fillStyle = 'rgba(' + fc + ',' + (0.85 * f).toFixed(3) + ')'; c.beginPath(); c.arc(px, py, Math.max(1, s * 0.09 * (0.4 + f)), 0, TAU); c.fill(); }
      var bh = s * 4.2, bw = s * (0.35 + 0.1 * pulse), bg = c.createLinearGradient(0, p[1], 0, p[1] - bh); bg.addColorStop(0, 'rgba(' + fc + ',0.4)'); bg.addColorStop(1, 'rgba(' + fc + ',0)'); c.fillStyle = bg; c.fillRect(p[0] - bw / 2, p[1] - bh, bw, bh);
      glow(c, p[0], p[1], s * 0.6, '255,255,255', 0.16 + 0.12 * pulse);
      // нити Силы от видимых героев рядом
      if (B) B.agents.forEach(function(a) {
        if (!a || !a.alive || !a.hero || a.team !== pt || a.vis === false) return;
        var dx = a.x - st[0], dy = a.y - st[1]; if (dx * dx + dy * dy > HUNT.site * HUNT.site * 1.2) return;
        var hp = GD.toS(a.x, a.y); c.strokeStyle = 'rgba(' + fc + ',0.7)'; c.lineWidth = Math.max(1, s * 0.06); c.beginPath(); c.moveTo(hp[0], hp[1]);
        for (var q = 1; q <= 8; q++) { var k = q / 8, w = Math.sin(k * Math.PI) * Math.sin(now * 12 + q * 1.7) * s * 0.18; c.lineTo(hp[0] + (p[0] - hp[0]) * k - dy * w / Math.max(0.3, Math.sqrt(dx * dx + dy * dy)), hp[1] + (p[1] - hp[1]) * k + dx * w / Math.max(0.3, Math.sqrt(dx * dx + dy * dy))); }
        c.stroke();
      });
      c.restore();
      // прогресс по кругу
      if (ss[1] > 0) { c.strokeStyle = 'rgba(0,0,0,0.5)'; c.lineWidth = Math.max(3, s * 0.2); c.beginPath(); c.arc(p[0], p[1], R + s * 0.25, 0, TAU); c.stroke(); c.strokeStyle = 'rgba(' + fc + ',0.95)'; c.lineWidth = Math.max(2, s * 0.13); c.beginPath(); c.arc(p[0], p[1], R + s * 0.25, -Math.PI / 2, -Math.PI / 2 + TAU * ss[1] / 100); c.stroke(); }
    });
    // эвакуация: огни площадки бегут по кругу; шаттл сел — стоит на площадке
    if (v.exit) {
      var ep = GD.toS(v.exit[0], v.exit[1]), er = 2.45 * s, col = prey ? '120,255,150' : '255,110,90';
      for (var j = 0; j < 8; j++) { var on = Math.floor(now * 6) % 8 === j, ba = j / 8 * TAU; glow(c, ep[0] + Math.cos(ba) * er, ep[1] + Math.sin(ba) * er, s * (on ? 0.9 : 0.4), col, on ? 0.9 : 0.35); }
      if (v.exit[4] <= 0) {
        shuttle(c, ep[0], ep[1], s, 1, now, true);
        var pr = v.exit[3] / 100; c.strokeStyle = 'rgba(0,0,0,0.5)'; c.lineWidth = Math.max(3, s * 0.2); c.beginPath(); c.arc(ep[0], ep[1], HUNT.exitR * s, 0, TAU); c.stroke();
        if (pr > 0) { c.strokeStyle = 'rgba(' + col + ',0.95)'; c.lineWidth = Math.max(2, s * 0.13); c.beginPath(); c.arc(ep[0], ep[1], HUNT.exitR * s, -Math.PI / 2, -Math.PI / 2 + TAU * pr); c.stroke(); }
      }
    }
  };
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
      var p = GD.toS(st[0], st[1]), ss = siteState(v, st), state = ss[0], isAlarm = v.alarm && Math.abs(v.alarm[0] - st[0]) < 0.6 && Math.abs(v.alarm[1] - st[1]) < 0.6;
      var col = prey ? (state === 2 ? '95,217,104' : state === 1 ? '240,200,106' : '217,169,64') : (state === 2 ? '110,120,130' : isAlarm ? '255,110,90' : '143,168,196');
      var mark = state === 2 ? (prey ? '✓' : '×') : prey ? '!' : '?', prog = state !== 2 && ss[1] > 0 ? ' ' + ss[1] + '%' : '';
      if (s >= NEAR) {
        // крупно: предмет виден сам — над ним подпись со знаком и прогрессом
        var ly = p[1] - 2.6 * s - 10;
        if (isAlarm && state !== 2) { c.strokeStyle = 'rgba(255,110,90,' + (0.3 + 0.6 * pulse).toFixed(2) + ')'; c.lineWidth = 2; c.beginPath(); c.arc(p[0], p[1], 2.7 * s + pulse * 6, 0, TAU); c.stroke(); }
        label(c, mark + ' ' + st[2].toUpperCase() + prog, p[0], ly, 'rgba(' + col + ',1)');
        return;
      }
      c.fillStyle = 'rgba(' + col + ',0.16)'; diamond(c, p[0], p[1], R); c.fill();
      c.strokeStyle = 'rgba(' + col + ',0.95)'; c.lineWidth = 2; diamond(c, p[0], p[1], R); c.stroke();
      if (state !== 2 && ss[1] > 0) { c.strokeStyle = 'rgba(' + (prey ? '240,200,106' : '255,110,90') + ',0.95)'; c.lineWidth = 3; c.beginPath(); c.arc(p[0], p[1], R + 5, -Math.PI / 2, -Math.PI / 2 + TAU * ss[1] / 100); c.stroke(); }
      if (isAlarm) { c.strokeStyle = 'rgba(255,110,90,' + (0.3 + 0.6 * pulse).toFixed(2) + ')'; c.lineWidth = 2; c.beginPath(); c.arc(p[0], p[1], R + 6 + pulse * 6, 0, TAU); c.stroke(); }
      c.font = 'bold ' + Math.round(Math.max(9, R * 0.9)) + 'px "Courier New", monospace'; c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillStyle = 'rgba(' + col + ',1)'; c.fillText(mark, p[0], p[1] + 0.5);
      if (s >= 3.2) label(c, st[2].toUpperCase() + prog, p[0], p[1] + R + 12, 'rgba(' + col + ',1)');
    });
    // эвакуация
    if (prey && !v.exit) (v.exits || []).forEach(function(e) { var p = GD.toS(e[0], e[1]), r = 2.6 * s; if (s < NEAR) { c.strokeStyle = 'rgba(95,217,104,0.4)'; c.lineWidth = 1; c.setLineDash([4, 4]); c.beginPath(); c.arc(p[0], p[1], r, 0, TAU); c.stroke(); c.setLineDash([]); } if (s >= 4) label(c, '⇪ ' + e[2], p[0], p[1] + r + 9, 'rgba(143,232,154,0.65)'); });
    if (v.exit) {
      var ep = GD.toS(v.exit[0], v.exit[1]), er = 2.6 * s, col2 = prey ? '95,217,104' : '255,110,90', eta = v.exit[4] || 0, etaAll = v.exit[5] || 60;
      if (s < NEAR) { c.fillStyle = 'rgba(' + col2 + ',' + (0.08 + 0.08 * pulse).toFixed(3) + ')'; c.beginPath(); c.arc(ep[0], ep[1], er, 0, TAU); c.fill(); c.strokeStyle = 'rgba(' + col2 + ',0.95)'; c.lineWidth = 2; c.stroke(); }
      // шаттл в воздухе: снижается к площадке, тень растёт (севший рисуется под бойцами)
      if (eta > 0) { var k = Math.max(0, Math.min(1, 1 - (eta - (Date.now() - L.vAt) / 1000) / etaAll)); shuttle(c, ep[0], ep[1], s, k, now, false); }
      if (s < NEAR && v.exit[3] > 0) { c.fillStyle = 'rgba(' + col2 + ',0.9)'; c.fillRect(ep[0] - er, ep[1] + er + 3, er * 2 * v.exit[3] / 100, 3); }
      label(c, (prey ? 'ЭВАКУАЦИЯ · ' : 'ЭВАКУАЦИЯ ВРАГА · ') + v.exit[2].toUpperCase() + (eta > 0 ? ' · ШАТТЛ ЧЕРЕЗ ' + eta + ' С' : v.exit[3] > 0 ? ' · ' + v.exit[3] + '%' : ' · ШАТТЛ СЕЛ'), ep[0], ep[1] - er - 12, prey ? '#8fe89a' : '#ff9a80');
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
    if (v.exit) { c.strokeStyle = v.role !== 'hunter' ? '#5fd968' : '#ff6e5a'; c.lineWidth = 1.5; c.beginPath(); c.arc(x0 + v.exit[0] * k, y0 + v.exit[1] * k, Math.max(3, 3 * k), 0, TAU); c.stroke(); }
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
      // награда раз в день: победная уже была (или утешительная) — бой шёл на рейтинг и трофеи
      a.innerHTML = (aw.credits > 0 ? '+' + fmtN(aw.credits) + ' кредитов' : aw.capped ? '<em>' + (aw.won ? 'Награда за победу сегодня уже получена' : 'Награда за сегодня уже получена') + '</em>' : 'Без награды') +
        (res2 ? '<br><em>на склад: ' + esc(res2) + '</em>' : '') + (aw.points ? '<br><em>+' + aw.points + ' очков рейтинга</em>' : '') +
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
