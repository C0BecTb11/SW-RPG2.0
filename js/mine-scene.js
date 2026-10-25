// Живая сцена участка добычи и перерабатывающего цеха (план claude/mining-plan.md).
//
// Участок сверху: забои (вышки, жилы, грядки — по ресурсу) по числу мест работы, дорога, склад участка,
// барак. Цех: цеховой зал с печами, реакторами или сборочными столами, приёмка сырья и лента к местам
// (по ней идёт сырьё, пока смена перерабатывает взятое со склада планеты). Рабочие — те, что в бригаде: на смене стоят у своих мест и работают, отдыхающие и выбывшие —
// в бараке, свободные — во дворе. Сцена не выдумывает цифры: добытое за смену считает база
// (mine_site_state.run.accrued + rate), и каждый раз, когда оно переходит через целое, один рабочий
// относит единицу на склад — над складом «+1». Склад участка наполняется по stock из базы.
//
// Мир — клетки W×H, рисуется в canvas под размер контейнера. Фон (земля, забои, постройки) печётся
// один раз на вид и размер; рабочие, искры и подписи — каждый кадр. Кадры идут, только пока
// сцена на экране. ES5, только браузер.
//
// Диверсии (sql/mine_sabotage.sql, план claude/sabotage-plan.md): охрана на постах с конусами обзора, караул
// бригады — прожекторы по стене, бастующие люди с плакатами и сбойные дроиды во дворе (hurt.why). Чужая группа
// рисуется по таймлайну операции из st.ops и времени сервера (st.now), поэтому у всех, кто смотрит, одна картина:
// подход тенями (сцена темнеет), действие у цели, отход; поймали — тревога, выстрелы, пленных уводят в барак.
// До конца следствия у цели остаются улики: следы, подпалина или вскрытый ящик и «?».

(function(root) {
  'use strict';

  var TAU = Math.PI * 2, W = 18, H = 13, ROAD = 7.3, FIGK = 1.75;     // рабочие крупнее клетки: видно на телефоне
  var STORE = { x: 0.8, y: 9.1, w: 4.4, h: 3.3, door: [3.0, 9.1] };
  var BARR = { x: 12.4, y: 9.1, w: 4.9, h: 3.3, door: [14.85, 9.1] };
  var YARD = [11.6, 7.9, 17.3, 8.85];
  var THEME = {
    ore:      { g: '#3b342c', g2: '#463d33', pit: '#2a241e', rock: '#5b5147', acc: '#b08968', lit: '#f0c486', name: 'Рудник' },
    gas:      { g: '#2c3634', g2: '#36423f', pit: '#232b2a', rock: '#4f5b58', acc: '#4ad9c8', lit: '#9ff3e8', name: 'Газовый промысел' },
    crystals: { g: '#241f2c', g2: '#2e2839', pit: '#1a1622', rock: '#3d3550', acc: '#b46cf0', lit: '#e2b8ff', name: 'Кристальная выработка' },
    food:     { g: '#26331f', g2: '#2f3f28', pit: '#1e2a19', rock: '#4b5a40', acc: '#5fd968', lit: '#c6ffb0', name: 'Ферма' },
    // цеха: fab — вид места работы, raw — цвет сырья на ленте и в приёмке
    durasteel:   { g: '#2b2e33', g2: '#353940', pit: '#22262b', rock: '#555b63', acc: '#8fa8c4', lit: '#ffb15a', raw: '#b08968', fab: 'furnace', name: 'Плавильный цех' },
    cells:       { g: '#2a302f', g2: '#333b3a', pit: '#212726', rock: '#4f5a58', acc: '#d9a940', lit: '#ffe08a', raw: '#4ad9c8', fab: 'reactor', name: 'Топливный цех' },
    electronics: { g: '#262b33', g2: '#303641', pit: '#1e232a', rock: '#4a5260', acc: '#4a90d9', lit: '#9fd2ff', raw: '#b08968', raw2: '#a34ad9', fab: 'bench', name: 'Сборочный цех' }
  };
  var RAW = { x: 6.5, y: 9.1, w: 3.6, h: 3.3, feed: 8.3 };      // приёмка сырья цеха и подача к ленте
  var BELT = ROAD - 0.78;

  var S = { box: null, cv: null, c: null, dpr: 1, px: 20, ox: 0, oy: 0, cw: 0, ch: 0, bg: null, bgKey: '',
            st: null, at: 0, kind: 'ore', agents: [], pops: [], parts: [], rings: [], raf: 0, last: 0, t: 0, seen: null, rr: 0, ro: null, on: false,
            skew: 0, plans: {}, boom: {} };

  function rng(seed) { var s = seed >>> 0 || 1; return function() { s += 0x6D2B79F5; var t = s; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  function hash(str) { var h = 2166136261; for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  function dot(c, x, y, r) { c.beginPath(); c.arc(x, y, r, 0, TAU); c.fill(); }
  function rr(c, x, y, w, h, r) { r = Math.min(r, w / 2, h / 2); c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); }
  function shade(hex, f) { var v = parseInt(hex.slice(1), 16), r = Math.min(255, Math.round(((v >> 16) & 255) * f)), g = Math.min(255, Math.round(((v >> 8) & 255) * f)), b = Math.min(255, Math.round((v & 255) * f)); return 'rgb(' + r + ',' + g + ',' + b + ')'; }
  function rgba(hex, a) { var v = parseInt(hex.slice(1), 16); return 'rgba(' + ((v >> 16) & 255) + ',' + ((v >> 8) & 255) + ',' + (v & 255) + ',' + a + ')'; }

  // места работы: одна линия до 8, дальше две
  function spots(n) {
    var out = [], rows = n > 8 ? 2 : 1, per = Math.ceil(n / rows);
    for (var i = 0; i < n; i++) {
      var r = Math.floor(i / per), k = i % per, cnt = Math.min(per, n - r * per);
      var x = cnt === 1 ? W / 2 : 2.2 + k * (W - 4.4) / (cnt - 1);
      out.push({ x: x, y: rows === 1 ? 3.3 : 2.3 + r * 2.3 });
    }
    return out;
  }
  function stand(sp) { return [sp.x, sp.y + 0.8]; }

  // ---------------------------------------------------------------- фон
  function bake() {
    var st = S.st, kind = S.kind, T = THEME[kind], n = st ? st.places : 6;
    var key = kind + ':' + n + ':' + S.cw + 'x' + S.ch + ':' + S.dpr;
    if (S.bg && S.bgKey === key) return;
    S.bgKey = key;
    var cv = S.bg || document.createElement('canvas');
    cv.width = Math.round(S.cw * S.dpr); cv.height = Math.round(S.ch * S.dpr);
    var c = cv.getContext('2d');
    c.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
    c.fillStyle = shade(T.g, 0.7); c.fillRect(0, 0, S.cw, S.ch);
    c.translate(S.ox, S.oy); c.scale(S.px, S.px);
    var R = rng(hash(kind + n));
    // земля: тон, пятна, мелкие камни
    var g = c.createLinearGradient(0, 0, W, H); g.addColorStop(0, T.g2); g.addColorStop(1, T.g);
    c.fillStyle = g; c.fillRect(0, 0, W, H);
    for (var i = 0; i < 140; i++) { c.fillStyle = 'rgba(0,0,0,' + (0.04 + R() * 0.08) + ')'; dot(c, R() * W, R() * H, 0.08 + R() * 0.35); }
    for (i = 0; i < 90; i++) { c.fillStyle = 'rgba(255,255,255,' + (0.02 + R() * 0.04) + ')'; dot(c, R() * W, R() * H, 0.03 + R() * 0.06); }
    var sp = spots(n);
    workZone(c, T, kind, sp, R);
    // дорога и отводы к местам
    c.lineCap = 'round';
    sp.forEach(function(s) { var p = stand(s); path(c, T, p[0], p[1] + 0.1, p[0], ROAD, 0.55); });
    path(c, T, 1.4, ROAD, W - 1.2, ROAD, 0.95);
    path(c, T, STORE.door[0], ROAD, STORE.door[0], STORE.door[1] + 0.2, 0.75);
    path(c, T, BARR.door[0], ROAD, BARR.door[0], BARR.door[1] + 0.2, 0.75);
    // двор у барака
    c.fillStyle = 'rgba(0,0,0,0.12)'; rr(c, YARD[0], YARD[1] - 0.1, YARD[2] - YARD[0], YARD[3] - YARD[1] + 0.2, 0.3); c.fill();
    if (kind === 'ore') rails(c);
    if (kind === 'gas') pipes(c, T, sp);
    if (T.fab) { belt(c, T, sp); machines(c, T, sp); rawBin(c, T); }
    storeBase(c, T, kind);
    barrack(c, T);
    // свет с северо-запада и виньетка
    var vg = c.createRadialGradient(W * 0.35, H * 0.3, 1, W * 0.5, H * 0.5, W * 0.75);
    vg.addColorStop(0, 'rgba(255,240,210,0.05)'); vg.addColorStop(1, 'rgba(0,0,0,0.38)');
    c.fillStyle = vg; c.fillRect(0, 0, W, H);
    S.bg = cv;
  }
  function path(c, T, x0, y0, x1, y1, w) {
    c.strokeStyle = shade(T.g, 0.72); c.lineWidth = w + 0.12; c.beginPath(); c.moveTo(x0, y0); c.lineTo(x1, y1); c.stroke();
    c.strokeStyle = shade(T.g2, 1.18); c.lineWidth = w; c.beginPath(); c.moveTo(x0, y0); c.lineTo(x1, y1); c.stroke();
  }
  function rails(c) {
    c.strokeStyle = 'rgba(30,24,18,0.75)'; c.lineWidth = 0.09;
    for (var x = 1.6; x < W - 1.3; x += 0.42) { c.beginPath(); c.moveTo(x, ROAD - 0.32); c.lineTo(x, ROAD + 0.32); c.stroke(); }
    c.strokeStyle = '#8d8f92'; c.lineWidth = 0.055;
    [-0.2, 0.2].forEach(function(o) { c.beginPath(); c.moveTo(1.4, ROAD + o); c.lineTo(W - 1.2, ROAD + o); c.stroke(); });
  }
  function pipes(c, T, sp) {
    c.lineCap = 'round';
    c.strokeStyle = '#2b3433'; c.lineWidth = 0.2; c.beginPath(); c.moveTo(1.6, ROAD - 0.7); c.lineTo(W - 1.6, ROAD - 0.7); c.stroke();
    c.strokeStyle = '#6d7a78'; c.lineWidth = 0.13; c.stroke();
    sp.forEach(function(s) { c.strokeStyle = '#6d7a78'; c.lineWidth = 0.11; c.beginPath(); c.moveTo(s.x + 0.55, s.y + 0.2); c.lineTo(s.x + 0.55, ROAD - 0.7); c.stroke(); });
    c.strokeStyle = '#6d7a78'; c.lineWidth = 0.13; c.beginPath(); c.moveTo(1.6, ROAD - 0.7); c.lineTo(1.6, STORE.y + 0.4); c.stroke();
  }
  // лента цеха: от приёмки вверх к ряду мест и вдоль него, ролики поперёк
  function belt(c, T, sp) {
    c.lineCap = 'butt';
    c.strokeStyle = '#15181c'; c.lineWidth = 0.42; c.beginPath(); c.moveTo(RAW.feed, RAW.y); c.lineTo(RAW.feed, BELT); c.stroke();
    c.beginPath(); c.moveTo(1.4, BELT); c.lineTo(W - 1.4, BELT); c.stroke();
    c.strokeStyle = '#2c3137'; c.lineWidth = 0.32; c.beginPath(); c.moveTo(RAW.feed, RAW.y); c.lineTo(RAW.feed, BELT); c.stroke();
    c.beginPath(); c.moveTo(1.4, BELT); c.lineTo(W - 1.4, BELT); c.stroke();
    c.strokeStyle = 'rgba(255,255,255,0.07)'; c.lineWidth = 0.03;
    for (var x = 1.5; x < W - 1.4; x += 0.3) { c.beginPath(); c.moveTo(x, BELT - 0.15); c.lineTo(x, BELT + 0.15); c.stroke(); }
    for (var y = BELT + 0.2; y < RAW.y; y += 0.3) { c.beginPath(); c.moveTo(RAW.feed - 0.15, y); c.lineTo(RAW.feed + 0.15, y); c.stroke(); }
    // отводы ленты к местам работы
    sp.forEach(function(s) { c.strokeStyle = '#3a4047'; c.lineWidth = 0.08; c.beginPath(); c.moveTo(s.x + 0.5, s.y + 0.15); c.lineTo(s.x + 0.5, BELT - 0.2); c.stroke(); });
  }
  function rawBin(c, T) {
    var b = RAW;
    c.fillStyle = 'rgba(0,0,0,0.38)'; rr(c, b.x + 0.12, b.y + 0.15, b.w, b.h, 0.18); c.fill();
    c.fillStyle = '#4b5158'; rr(c, b.x, b.y, b.w, b.h, 0.18); c.fill();
    c.fillStyle = '#23272c'; rr(c, b.x + 0.22, b.y + 0.25, b.w - 0.44, b.h - 0.45, 0.1); c.fill();
    // косые полосы «опасно» по краю приёмки
    c.save(); rr(c, b.x, b.y, b.w, 0.2, 0.05); c.clip();
    for (var x = b.x - 0.4; x < b.x + b.w; x += 0.4) { c.fillStyle = '#d9a940'; c.beginPath(); c.moveTo(x, b.y + 0.2); c.lineTo(x + 0.2, b.y); c.lineTo(x + 0.4, b.y); c.lineTo(x + 0.2, b.y + 0.2); c.closePath(); c.fill(); }
    c.restore();
    c.strokeStyle = 'rgba(255,255,255,0.08)'; c.lineWidth = 0.05; rr(c, b.x, b.y, b.w, b.h, 0.18); c.stroke();
  }
  // цеховой зал: стена из листов с полосой «опасно», пол из плит; места — печи, реакторы, сборочные столы
  function hall(c, T, sp, R) {
    var i, x;
    c.fillStyle = shade(T.pit, 1.15); c.fillRect(0, 1.3, W, 5.0);
    c.strokeStyle = 'rgba(0,0,0,0.28)'; c.lineWidth = 0.035;
    for (x = 0; x <= W; x += 1.5) { c.beginPath(); c.moveTo(x, 1.3); c.lineTo(x, 6.3); c.stroke(); }
    for (var y = 1.3; y <= 6.3; y += 1.25) { c.beginPath(); c.moveTo(0, y); c.lineTo(W, y); c.stroke(); }
    for (i = 0; i < 60; i++) { c.fillStyle = 'rgba(255,255,255,' + (0.02 + R() * 0.03) + ')'; dot(c, R() * W, 1.4 + R() * 4.8, 0.03 + R() * 0.05); }
    var wg = c.createLinearGradient(0, 0, 0, 1.3); wg.addColorStop(0, shade(T.rock, 1.0)); wg.addColorStop(1, shade(T.rock, 0.6));
    c.fillStyle = wg; c.fillRect(0, 0, W, 1.3);
    c.strokeStyle = 'rgba(0,0,0,0.3)'; c.lineWidth = 0.04;
    for (x = 0.3; x < W; x += 0.3) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, 1.12); c.stroke(); }
    c.save(); c.beginPath(); c.rect(0, 1.12, W, 0.18); c.clip();
    for (x = -0.4; x < W; x += 0.5) { c.fillStyle = '#d9a940'; c.beginPath(); c.moveTo(x, 1.3); c.lineTo(x + 0.18, 1.12); c.lineTo(x + 0.43, 1.12); c.lineTo(x + 0.25, 1.3); c.closePath(); c.fill(); }
    c.restore();
    c.fillStyle = 'rgba(0,0,0,0.35)'; c.fillRect(0, 1.3, W, 0.12);
  }
  // станки цеха — поверх дорожек к местам, чтобы дорожка не резала печь или стол
  function machines(c, T, sp) {
    sp.forEach(function(s) {
      c.fillStyle = 'rgba(0,0,0,0.4)';
      if (T.fab === 'furnace') {
        rr(c, s.x - 0.62, s.y - 1.0, 1.32, 1.36, 0.14); c.fill();
        var fg = c.createLinearGradient(s.x - 0.65, 0, s.x + 0.65, 0); fg.addColorStop(0, '#3d4249'); fg.addColorStop(0.5, '#646b74'); fg.addColorStop(1, '#3d4249');
        c.fillStyle = fg; rr(c, s.x - 0.65, s.y - 1.08, 1.3, 1.3, 0.14); c.fill();
        c.fillStyle = '#2a2e33'; rr(c, s.x - 0.25, s.y - 1.32, 0.5, 0.32, 0.06); c.fill();             // труба
        c.fillStyle = '#16191d'; rr(c, s.x - 0.36, s.y - 0.35, 0.72, 0.5, 0.08); c.fill();              // устье
        c.strokeStyle = 'rgba(255,255,255,0.12)'; c.lineWidth = 0.04; rr(c, s.x - 0.65, s.y - 1.08, 1.3, 1.3, 0.14); c.stroke();
      } else if (T.fab === 'reactor') {
        c.beginPath(); c.arc(s.x + 0.06, s.y - 0.36, 0.66, 0, TAU); c.fill();
        var rg = c.createRadialGradient(s.x - 0.2, s.y - 0.6, 0.05, s.x, s.y - 0.42, 0.66); rg.addColorStop(0, '#7c8786'); rg.addColorStop(1, '#3a4241');
        c.fillStyle = rg; c.beginPath(); c.arc(s.x, s.y - 0.42, 0.64, 0, TAU); c.fill();
        c.strokeStyle = '#26302f'; c.lineWidth = 0.08; c.beginPath(); c.arc(s.x, s.y - 0.42, 0.44, 0, TAU); c.stroke();
        c.fillStyle = '#1b2120'; c.beginPath(); c.arc(s.x, s.y - 0.42, 0.26, 0, TAU); c.fill();
        for (var b = 0; b < 4; b++) { var aa = b * Math.PI / 2 + 0.4; c.fillStyle = '#596463'; dot(c, s.x + Math.cos(aa) * 0.56, s.y - 0.42 + Math.sin(aa) * 0.56, 0.05); }
      } else {
        rr(c, s.x - 0.7, s.y - 0.95, 1.46, 1.08, 0.1); c.fill();
        c.fillStyle = '#5a616b'; rr(c, s.x - 0.72, s.y - 1.0, 1.44, 1.04, 0.1); c.fill();
        c.fillStyle = '#3a4049'; rr(c, s.x - 0.64, s.y - 0.92, 1.28, 0.88, 0.07); c.fill();
        for (var k = 0; k < 2; k++) {
          var bx = s.x - 0.56 + k * 0.6;
          c.fillStyle = '#1f5a3a'; rr(c, bx, s.y - 0.8, 0.5, 0.6, 0.04); c.fill();
          c.strokeStyle = 'rgba(201,214,120,0.55)'; c.lineWidth = 0.02;
          c.beginPath(); c.moveTo(bx + 0.06, s.y - 0.7); c.lineTo(bx + 0.3, s.y - 0.7); c.lineTo(bx + 0.3, s.y - 0.4); c.moveTo(bx + 0.1, s.y - 0.3); c.lineTo(bx + 0.42, s.y - 0.3); c.stroke();
          c.fillStyle = '#20242a'; c.fillRect(bx + 0.14, s.y - 0.6, 0.18, 0.14);
        }
      }
    });
  }
  // забои / вышки / жилы / грядки
  function workZone(c, T, kind, sp, R) {
    var i;
    if (T.fab) { hall(c, T, sp, R); return; }
    if (kind === 'ore' || kind === 'crystals') {
      // карьер / пещера: уступы, ниже к стене
      for (var b = 0; b < 3; b++) {
        var y = 5.9 - b * 1.25;
        c.fillStyle = shade(T.pit, 1.25 - b * 0.12);
        c.beginPath(); c.moveTo(0, y);
        for (var x = 0; x <= W; x += 0.6) c.lineTo(x, y + Math.sin(x * 1.3 + b) * 0.12 + (R() - 0.5) * 0.12);
        c.lineTo(W, 0); c.lineTo(0, 0); c.closePath(); c.fill();
        c.strokeStyle = 'rgba(255,255,255,0.06)'; c.lineWidth = 0.05; c.stroke();
      }
      // стена карьера / пещеры: сплошной скальный край с неровной кромкой, трещинами и бликом сверху-слева
      var edge = [];
      for (var ex = 0; ex <= W + 0.01; ex += 0.35) edge.push([ex, 1.15 + Math.sin(ex * 0.9) * 0.18 + (R() - 0.5) * 0.28]);
      c.fillStyle = 'rgba(0,0,0,0.35)'; c.beginPath(); c.moveTo(0, 0); edge.forEach(function(p) { c.lineTo(p[0], p[1] + 0.22); }); c.lineTo(W, 0); c.closePath(); c.fill();
      var rg = c.createLinearGradient(0, 0, 0, 1.5); rg.addColorStop(0, shade(T.rock, 1.05)); rg.addColorStop(1, shade(T.rock, 0.62));
      c.fillStyle = rg; c.beginPath(); c.moveTo(0, 0); edge.forEach(function(p) { c.lineTo(p[0], p[1]); }); c.lineTo(W, 0); c.closePath(); c.fill();
      c.strokeStyle = 'rgba(255,255,255,0.1)'; c.lineWidth = 0.04; c.beginPath(); edge.forEach(function(p, j) { if (j) c.lineTo(p[0], p[1]); else c.moveTo(p[0], p[1]); }); c.stroke();
      for (i = 0; i < 26; i++) {
        var cx0 = R() * W, cy0 = 0.15 + R() * 0.8;
        c.strokeStyle = 'rgba(0,0,0,0.3)'; c.lineWidth = 0.035; c.beginPath(); c.moveTo(cx0, cy0); c.lineTo(cx0 + (R() - 0.5) * 0.5, cy0 + 0.2 + R() * 0.3); c.lineTo(cx0 + (R() - 0.5) * 0.6, cy0 + 0.4 + R() * 0.2); c.stroke();
      }
      for (i = 0; i < 70; i++) { c.fillStyle = shade(T.rock, 0.55 + R() * 0.6); dot(c, R() * W, 1.3 + R() * 4.3, 0.03 + R() * 0.07); }
      if (kind === 'crystals') for (i = 0; i < 18; i++) { c.fillStyle = rgba(T.acc, 0.25 + R() * 0.35); dot(c, R() * W, 0.2 + R() * 0.9, 0.04 + R() * 0.05); }
      sp.forEach(function(s) {
        // ниша забоя
        c.fillStyle = 'rgba(0,0,0,0.45)'; c.beginPath(); c.ellipse(s.x, s.y - 0.15, 0.62, 0.45, 0, 0, TAU); c.fill();
        c.fillStyle = shade(T.pit, 0.7); c.beginPath(); c.ellipse(s.x, s.y - 0.2, 0.48, 0.32, 0, 0, TAU); c.fill();
        if (kind === 'ore') {
          for (var k = 0; k < 7; k++) { c.fillStyle = k % 3 ? shade(T.acc, 0.7 + R() * 0.4) : shade(T.rock, 0.9); dot(c, s.x + (R() - 0.5) * 1.1, s.y + 0.15 + R() * 0.35, 0.06 + R() * 0.08); }
        } else {
          crystalCluster(c, T, s.x, s.y - 0.25, R);
        }
      });
    } else if (kind === 'gas') {
      c.fillStyle = shade(T.pit, 1.15); rr(c, 0.8, 1.0, W - 1.6, 4.6, 0.3); c.fill();
      c.strokeStyle = 'rgba(255,255,255,0.05)'; c.lineWidth = 0.05;
      for (i = 1.6; i < W - 1; i += 1.1) { c.beginPath(); c.moveTo(i, 1.05); c.lineTo(i, 5.55); c.stroke(); }
      sp.forEach(function(s) {
        c.fillStyle = 'rgba(0,0,0,0.35)'; rr(c, s.x - 0.7, s.y - 0.95, 1.4, 1.4, 0.12); c.fill();
        c.fillStyle = '#4a5553'; rr(c, s.x - 0.62, s.y - 1.0, 1.24, 1.24, 0.1); c.fill();
        c.strokeStyle = '#7e8b89'; c.lineWidth = 0.06; c.beginPath(); c.moveTo(s.x - 0.6, s.y - 0.98); c.lineTo(s.x + 0.6, s.y + 0.22); c.moveTo(s.x + 0.6, s.y - 0.98); c.lineTo(s.x - 0.6, s.y + 0.22); c.stroke();
        c.strokeRect(s.x - 0.62, s.y - 1.0, 1.24, 1.24);
        c.fillStyle = '#26302f'; dot(c, s.x, s.y - 0.38, 0.26);
      });
    } else {
      // фермы: грядки с рядами
      sp.forEach(function(s) {
        c.fillStyle = 'rgba(0,0,0,0.3)'; rr(c, s.x - 0.78, s.y - 1.55, 1.56, 1.9, 0.12); c.fill();
        c.fillStyle = '#3a2e22'; rr(c, s.x - 0.7, s.y - 1.6, 1.4, 1.8, 0.1); c.fill();
        for (var row = 0; row < 3; row++) for (var k2 = 0; k2 < 5; k2++) {
          var px = s.x - 0.48 + row * 0.48, py = s.y - 1.42 + k2 * 0.34;
          c.fillStyle = shade(T.acc, 0.55 + R() * 0.3); dot(c, px, py, 0.13 + R() * 0.04);
          c.fillStyle = 'rgba(255,255,255,0.12)'; dot(c, px - 0.04, py - 0.04, 0.05);
        }
      });
    }
  }
  function crystalCluster(c, T, x, y, R) {
    for (var k = 0; k < 5; k++) {
      var a = -Math.PI / 2 + (k - 2) * 0.45 + (R() - 0.5) * 0.2, L = 0.35 + R() * 0.3, w = 0.08 + R() * 0.05;
      var tx = x + Math.cos(a) * L, ty = y + Math.sin(a) * L;
      c.fillStyle = k % 2 ? shade(T.acc, 1.05) : shade(T.acc, 0.75);
      c.beginPath(); c.moveTo(x - Math.sin(a) * w, y + Math.cos(a) * w); c.lineTo(tx, ty); c.lineTo(x + Math.sin(a) * w, y - Math.cos(a) * w); c.closePath(); c.fill();
    }
  }
  function storeBase(c, T, kind) {
    var s = STORE;
    c.fillStyle = 'rgba(0,0,0,0.35)'; rr(c, s.x + 0.12, s.y + 0.15, s.w, s.h, 0.2); c.fill();
    c.fillStyle = shade(T.rock, 0.75); rr(c, s.x, s.y, s.w, s.h, 0.2); c.fill();
    c.fillStyle = shade(T.g, 0.6); rr(c, s.x + 0.2, s.y + 0.25, s.w - 0.4, s.h - 0.45, 0.12); c.fill();
    c.strokeStyle = 'rgba(255,255,255,0.08)'; c.lineWidth = 0.05; rr(c, s.x, s.y, s.w, s.h, 0.2); c.stroke();
    // ворота
    c.fillStyle = '#d9a940'; c.fillRect(s.door[0] - 0.5, s.y - 0.06, 1.0, 0.12);
  }
  function barrack(c, T) {
    var b = BARR;
    c.fillStyle = 'rgba(0,0,0,0.4)'; rr(c, b.x + 0.15, b.y + 0.2, b.w, b.h, 0.18); c.fill();
    var g = c.createLinearGradient(b.x, b.y, b.x, b.y + b.h); g.addColorStop(0, '#6b7178'); g.addColorStop(0.5, '#565c63'); g.addColorStop(1, '#41464c');
    c.fillStyle = g; rr(c, b.x, b.y, b.w, b.h, 0.18); c.fill();
    c.strokeStyle = 'rgba(0,0,0,0.35)'; c.lineWidth = 0.05;
    for (var x = b.x + 0.45; x < b.x + b.w; x += 0.45) { c.beginPath(); c.moveTo(x, b.y + 0.05); c.lineTo(x, b.y + b.h - 0.05); c.stroke(); }
    c.strokeStyle = 'rgba(255,255,255,0.18)'; c.lineWidth = 0.08; c.beginPath(); c.moveTo(b.x + 0.1, b.y + b.h / 2); c.lineTo(b.x + b.w - 0.1, b.y + b.h / 2); c.stroke();
    c.fillStyle = '#2a2f35'; c.fillRect(b.door[0] - 0.45, b.y - 0.08, 0.9, 0.2);
  }

  // ---------------------------------------------------------------- рабочие
  // hurt — травмы и поломки после аврала (в бараке); dis — бастуют люди или сбоят дроиды после диверсии (во дворе)
  function counts(st) {
    var run = st.run, out = { h: {}, d: {} };
    ['h', 'd'].forEach(function(k) {
      var tot = k === 'h' ? st.humans : st.droids, on = run ? (k === 'h' ? run.humans : run.droids) : 0, hurt = 0, dis = 0;
      (st.hurt || []).forEach(function(x) { if (x.kind !== k) return; if (x.why === 'strike' || x.why === 'virus') dis += x.n || 0; else hurt += x.n || 0; });
      hurt = Math.min(hurt, Math.max(0, tot - on));
      dis = Math.min(dis, Math.max(0, tot - on - hurt));
      var rest = (k === 'h' ? st.rest_h : st.rest_d) ? Math.max(0, tot - on - hurt - dis) : 0;
      out[k] = { tot: tot, on: on, hurt: hurt, dis: dis, rest: rest, free: Math.max(0, tot - on - hurt - dis - rest) };
    });
    return out;
  }
  // путь по дорогам: к дороге, вдоль неё, к цели; lane — своя полоса, чтобы идущие не шли гуськом в одной точке
  function route(from, to, lane) {
    var y = ROAD + (lane || 0), pts = [];
    if (Math.abs(from[1] - y) > 0.05) pts.push([from[0], y]);
    pts.push([to[0], y]);
    pts.push(to);
    return pts;
  }
  function laneOf(a) { return ((a.i + (a.k === 'd' ? 1 : 0)) % 3 - 1) * 0.24; }
  function yardPoint(R) { return [YARD[0] + 0.4 + R() * (YARD[2] - YARD[0] - 0.8), YARD[1] + 0.2 + R() * (YARD[3] - YARD[1] - 0.4)]; }
  // бастующие — толпой у двери барака, полукругом лицом к дороге
  function crowdPoint(i) { var a = (i * 2.399) % TAU, r = 0.45 + (i % 4) * 0.28; return [BARR.door[0] + Math.cos(a) * r * 1.5, YARD[1] + 0.35 + Math.abs(Math.sin(a)) * r * 0.55]; }
  // посты охраны: обход между двумя точками; первые — у склада и у барака, дальше — края рабочей зоны и середина дороги
  var GPOST = [
    [[5.65, 8.45], [6.7, 8.45]], [[10.5, 8.45], [11.3, 8.45]], [[0.95, 4.5], [0.95, 5.9]],
    [[W - 0.95, 4.5], [W - 0.95, 5.9]], [[W / 2 - 1.1, 8.6], [W / 2 + 0.6, 8.6]]
  ];
  function guardsOnPost(st) { return Math.min(GPOST.length, Math.min(st.guards || 0, st.guards_max || 0) + (st.garrison ? 1 : 0)); }
  // Роли из состояния базы: на смене — к своему месту, отдых и выбывшие — в барак, свободные — во двор
  function assign(first) {
    var st = S.st; if (!st) return;
    var cn = counts(st), sp = spots(st.places), list = S.agents;
    ['h', 'd'].forEach(function(k) {
      var mine = list.filter(function(a) { return a.k === k; });
      while (mine.length < cn[k].tot) { var a = { k: k, i: mine.length, x: BARR.door[0], y: BARR.door[1], ang: -Math.PI / 2, ph: Math.random() * TAU, path: null, role: '', mv: 0, inside: true }; list.push(a); mine.push(a); }
      if (mine.length > cn[k].tot) { S.agents = list = list.filter(function(a) { return a.k !== k || a.i < cn[k].tot; }); mine = mine.slice(0, cn[k].tot); }
    });
    // бригадир и техники — отдельные фигуры, своя логика в staffStep
    ['f', 't'].forEach(function(k) {
      var n = k === 'f' ? st.foremen || 0 : st.techs || 0, mine = S.agents.filter(function(a) { return a.k === k; });
      while (mine.length < n) { var p0 = first ? yardPoint(Math.random) : BARR.door.slice(); var a = { k: k, i: mine.length, x: p0[0], y: p0[1], ang: Math.PI / 2, ph: Math.random() * TAU, path: null, role: 'idle', mv: 0, wait: Math.random() * 2 }; S.agents.push(a); mine.push(a); }
      if (mine.length > n) S.agents = S.agents.filter(function(a) { return a.k !== k || a.i < n; });
    });
    // охрана: нанятые на посту и один от «Казарм ополчения»; у каждого свой пост, обходит его
    var ng = guardsOnPost(st), gs = S.agents.filter(function(a) { return a.k === 'g'; });
    while (gs.length < ng) { var gp = GPOST[gs.length % GPOST.length], g0 = first ? gp[0] : BARR.door.slice(); var ga = { k: 'g', i: gs.length, x: g0[0], y: g0[1], ang: Math.PI / 2, ph: Math.random() * TAU, path: null, role: 'post', mv: 0, wait: Math.random() * 3, leg: 0 }; S.agents.push(ga); gs.push(ga); }
    if (gs.length > ng) S.agents = S.agents.filter(function(a) { return a.k !== 'g' || a.i < ng; });
    var spot = 0, R = rng(Date.now() & 0xffff);
    ['h', 'd'].forEach(function(k) {
      var c = cn[k], mine = S.agents.filter(function(a) { return a.k === k; });
      mine.forEach(function(a, j) {
        var role = j < c.on ? 'work' : j < c.on + c.hurt ? 'hurt' : j < c.on + c.hurt + c.dis ? (k === 'h' ? 'strike' : 'glitch') : j < c.on + c.hurt + c.dis + c.rest ? 'rest' : 'free';
        var want = role === 'work' ? spot++ : -1;
        if (a.role === role && a.spot === want) return;
        a.role = role; a.spot = want; a.carry = false;
        var dst = role === 'work' ? stand(sp[want]) : role === 'free' || role === 'glitch' ? yardPoint(R) : role === 'strike' ? crowdPoint(a.i) : BARR.door.slice();
        if (first) {
          a.x = dst[0]; a.y = dst[1]; a.path = null; a.inside = role === 'rest' || role === 'hurt';
          a.ang = role === 'work' || role === 'strike' ? -Math.PI / 2 : Math.PI / 2;
        } else {
          if (a.inside) { a.inside = false; a.x = BARR.door[0]; a.y = BARR.door[1] - 0.1; }
          a.path = route([a.x, a.y], dst, laneOf(a));
        }
      });
    });
  }
  // Одна единица добытого: свободный от ноши рабочий на смене несёт её на склад
  function haul() {
    var st = S.st, sp = st ? spots(st.places) : [];
    var cand = S.agents.filter(function(a) { return a.role === 'work' && !a.path && !a.carry; });
    if (!cand.length) { S.pops.push({ x: STORE.x + STORE.w / 2, y: STORE.y + 0.4, t: 0 }); return; }
    var a = cand[(S.rr++) % cand.length];
    a.carry = true; a.path = route([a.x, a.y], [STORE.door[0], STORE.door[1] - 0.15], laneOf(a)); a.back = stand(sp[a.spot] || sp[0]);
  }

  // ---------------------------------------------------------------- диверсии: охрана и чужая группа
  // Республика — коммандос в серой броне, у старшего золотой визор; КНС — тонкие тёмные дроиды с узким сенсором
  var SPY_LOOK = {
    republic: { body: '#7f878f', hi: '#c4cbd1', helm: '#2b3138', visor: '#d9a940', visor2: '#8a96a2', leg: '#3a4148', arm: '#5b636b' },
    cis: { body: '#2a2e34', hi: '#4f5660', helm: '#17191d', visor: '#ff6a3c', visor2: '#ff6a3c', leg: '#1b1e22', arm: '#3a3f46' }
  };
  var OP_WORK = { blast: 10, virus: 14, strike: 16, poison: 14, theft: 16 };   // с у цели после действия
  var OP_REACH = 12, OP_LEAVE = 45, OP_BOOM = 22, OP_FIRE = 150;            // путь к цели после действия; отход; взрыв и пожар — с от прихода к цели
  var AL_RUN = 6, AL_LEAD = 10, AL_ESC = 40, AL_BACK = 12, AL_END = 90;      // тревога: подбег, увод в барак, возврат, сирены

  function srvNow() { return Date.now() + S.skew; }
  function opsErr(e) { if (!S.opsErr) { S.opsErr = 1; if (window.errReport) errReport(e, 'mine.scene.ops'); } }
  // Слой диверсий в своём save/restore: сбой в нём не ломает остальной кадр участка
  function opsDraw(c, t, fn) {
    c.save();
    try { fn(c, t); } catch (e) { opsErr(e); }
    c.restore();
  }
  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function tms(iso) { var v = iso ? Date.parse(iso) : NaN; return isNaN(v) ? null : v; }
  function dist(a, b) { var dx = b[0] - a[0], dy = b[1] - a[1]; return Math.sqrt(dx * dx + dy * dy); }
  function lerp2(a, b, k) { return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k]; }
  function ease(k) { k = clamp01(k); return k * k * (3 - 2 * k); }

  // Охранник: обходит пост между двумя точками, стоя поводит головой — конус обзора ходит туда-сюда
  function guardStep(a, dt) {
    if (a.hold > 0) { a.hold -= dt; return; }              // тревога ведёт его сама (alarmGuards)
    a.alarm = false;
    if (a.path && a.path.length) return;
    var post = GPOST[a.i % GPOST.length];
    a.look = (a.look || 0) + dt;
    a.ang = Math.atan2(4.6 - a.y, W / 2 - a.x) + Math.sin(a.look * 0.7 + a.ph) * 0.75;
    a.wait -= dt; if (a.wait > 0) return;
    a.leg = 1 - (a.leg || 0);
    var to = post[a.leg];                                      // далеко от поста (только вышел из барака) — по дороге, не сквозь постройки
    a.path = dist([a.x, a.y], to) > 2.5 ? route([a.x, a.y], to.slice(), 0) : [to.slice()];
    a.wait = 3 + Math.random() * 4;
  }

  // Цель группы: у места работы — сбоку от установки, со стороны прихода; склад и барак — с тыльного бока
  function opTarget(o, st, from) {
    var sp = spots(st.places);
    if (o.spot >= 0 && sp.length) {
      var s0 = sp[Math.min(o.spot, sp.length - 1)];
      return { x: s0.x + from * 0.85, y: s0.y - 0.15, face: from < 0 ? 0 : Math.PI, at: [s0.x, s0.y - 0.35], low: false };
    }
    if (o.spot === -2) return { x: BARR.x - 0.4, y: BARR.y + 1.5, face: 0, at: [BARR.x + 0.6, BARR.y + 1.5], low: true };
    return { x: STORE.x + STORE.w + 0.4, y: STORE.y + 1.5, face: Math.PI, at: [STORE.x + STORE.w - 0.6, STORE.y + 1.5], low: true };
  }
  function polyLen(pts) { var len = [0]; for (var i = 1; i < pts.length; i++) len.push(len[i - 1] + dist(pts[i - 1], pts[i])); return len; }
  // План операции. До действия база не говорит, куда идёт группа (по цели угадывалась бы операция), поэтому
  // подход у всех одинаковый: тенями по верхней кромке зала или карьера, с остановками в укрытиях — к точке
  // ожидания. После действия место известно: оттуда — к цели (к складу и бараку — по краю и за постройками),
  // потом отход тем же краем. Всё из seed операции — одинаково у всех, кто смотрит
  function opPlan(o, st) {
    var known = o.spot != null && o.acted_at, key = o.id + ':' + st.places + ':' + (known ? o.spot : '?');
    if (S.plans[key]) return S.plans[key];
    var from = (o.seed & 1) ? 1 : -1, R = rng((o.seed >>> 0) || 1), i;
    // в два ряда места стоят почти у стены — тогда группа крадётся по самой кромке, над первым рядом
    var ey = st.places > 8 ? 0.8 : 1.8, ex = from < 0 ? -0.8 : W + 0.8, cx = from < 0 ? 0.45 : W - 0.45;
    var hx = from < 0 ? 3 + R() * (W / 2 - 3) : W / 2 + R() * (W / 2 - 3), C = { x: hx, y: ey };
    var pts = [[ex, ey], [cx, ey]], n = Math.max(1, Math.round(Math.abs(hx - cx) / 3));
    for (i = 1; i < n; i++) pts.push([cx + (hx - cx) * i / n + (R() - 0.5) * 0.4, ey + (R() - 0.5) * 0.25]);
    pts.push([hx, ey]);
    // ключи подхода: движение по длине, в укрытиях — пауза (взгляд — куда шли); подход занимает 4–84 % окна
    var keys = [{ w: 0, x: pts[0][0], y: pts[0][1], mv: 1, ang: from < 0 ? 0 : Math.PI }], acc = 0, ang = keys[0].ang;
    for (i = 1; i < pts.length; i++) {
      acc += dist(pts[i - 1], pts[i]); ang = Math.atan2(pts[i][1] - pts[i - 1][1], pts[i][0] - pts[i - 1][0]);
      keys.push({ w: acc, x: pts[i][0], y: pts[i][1], mv: 1, ang: ang });
      if (i > 1 && i < pts.length - 1) { acc += 2.2; keys.push({ w: acc, x: pts[i][0], y: pts[i][1], mv: 0, ang: ang }); }
    }
    keys.forEach(function(k) { k.u = 0.04 + 0.8 * k.w / Math.max(0.01, acc); });
    var leafR = [];                                              // листовки: куда лягут (у цели)
    for (i = 0; i < 14; i++) leafR.push([R(), R(), R()]);
    // пойманных уводят от точки ожидания к дороге и вдоль неё к двери барака
    var esc = [[hx, ey], [hx, ROAD + 0.45], [BARR.door[0], ROAD + 0.45], [BARR.door[0], BARR.door[1] - 0.1]];
    var plan = { from: from, C: C, keys: keys, esc: esc, el: polyLen(esc), T: null, steps: [] };
    if (known) {
      var T = opTarget(o, st, from), lowY = H - 0.35;
      var reach = T.low ? [[hx, ey], [cx, ey], [cx, lowY], [T.x, lowY], [T.x, T.y]] : [[hx, ey], [T.x, ey], [T.x, T.y]];
      var back = T.low ? [[T.x, T.y], [T.x, lowY], [cx, lowY], [ex, lowY]] : [[T.x, T.y], [T.x, ey], [cx, ey], [ex, ey]];
      plan.T = T; plan.reach = reach; plan.rl = polyLen(reach); plan.back = back; plan.bl = polyLen(back);
      plan.leaf = leafR.map(function(r) { return [T.at[0] - 1.8 + r[0] * 2.2, T.at[1] - 2.1 + r[1] * 1.3, r[2] * TAU]; });
      plan.steps = footprints(pts.concat(reach.slice(1)));
    }
    S.plans[key] = plan;
    return plan;
  }
  // следы: пары отпечатков вдоль пути, внутри сцены
  function footprints(pts) {
    var steps = [], side = 1;
    for (var i = 1; i < pts.length; i++) {
      var d = dist(pts[i - 1], pts[i]), m = Math.floor(d / 0.42);
      for (var j = 0; j < m; j++) {
        var p = lerp2(pts[i - 1], pts[i], j / Math.max(1, m)), nx = -(pts[i][1] - pts[i - 1][1]) / Math.max(0.01, d), ny = (pts[i][0] - pts[i - 1][0]) / Math.max(0.01, d);
        side = -side;
        if (p[0] > 0.2 && p[0] < W - 0.2) steps.push([p[0] + nx * 0.08 * side, p[1] + ny * 0.08 * side]);
      }
    }
    return steps;
  }
  function keyAt(keys, u) {
    for (var i = 1; i < keys.length; i++) if (u <= keys[i].u) {
      var a = keys[i - 1], b = keys[i], k = (u - a.u) / Math.max(1e-6, b.u - a.u), mv = b.mv && (b.x !== a.x || b.y !== a.y) ? 1 : 0;
      return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, ang: b.ang, mv: mv };
    }
    var z = keys[keys.length - 1]; return { x: z.x, y: z.y, ang: z.ang, mv: 0 };
  }
  function polyAt(pts, len, k) {
    var L = len[len.length - 1] * clamp01(k);
    for (var i = 1; i < pts.length; i++) if (L <= len[i]) {
      var f = (L - len[i - 1]) / Math.max(1e-6, len[i] - len[i - 1]), p = lerp2(pts[i - 1], pts[i], f);
      return { x: p[0], y: p[1], ang: Math.atan2(pts[i][1] - pts[i - 1][1], pts[i][0] - pts[i - 1][0]) };
    }
    var z = pts[pts.length - 1]; return { x: z[0], y: z[1], ang: 0 };
  }
  function atTarget(T, m) { return T.low ? [T.x, T.y + (m ? 0.42 : -0.12)] : [T.x, T.y + (m ? 0.46 : 0)]; }
  function atHold(C, m) { return [C.x - (m ? 0.5 : 0), C.y + (m ? 0.32 : 0)]; }

  // Что от операции на сцене сейчас: фигурки и позы, затемнение, dt — с от действия, da — с от прихода к цели
  function opNow(o, st, now) {
    var tA = tms(o.approach_at), tX = tms(o.act_at), tD = tms(o.acted_at);
    if (tA == null || tX == null || now < tA) return null;
    var P = opPlan(o, st), C = P.C, out = { o: o, P: P, figs: [], dark: 0, dt: tD != null ? (now - tD) / 1000 : -1, da: null }, m, q;
    if (tD == null) {                                            // подход и ожидание итога у точки ожидания
      var u = clamp01((now - tA) / Math.max(1, tX - tA)), end = P.keys[P.keys.length - 1].u, last = P.keys[P.keys.length - 1].ang;
      out.dark = clamp01((now - tA) / 20000);
      for (m = 0; m < 2; m++) {
        var um = u - m * 0.014;
        if (um < P.keys[0].u) continue;
        if (um >= end) { q = atHold(C, m); out.figs.push({ x: q[0], y: q[1], ang: last, pose: 'hide', m: m, mv: 0 }); continue; }
        var kk = keyAt(P.keys, um);
        out.figs.push({ x: kk.x, y: kk.y + (m ? 0.36 : 0), ang: kk.ang, pose: kk.mv ? 'sneak' : 'hide', m: m, mv: kk.mv });
      }
      return out;
    }
    var dt = out.dt; if (dt < 0) dt = 0;
    if (o.result === 'caught' || !P.T) {                         // тревога: стоят, руки вверх; потом их уводят в барак
      out.dark = 1 - clamp01((dt - 60) / 20);
      if (o.result !== 'caught') return out;
      if (dt < AL_LEAD) for (m = 0; m < 2; m++) { q = atHold(C, m); out.figs.push({ x: q[0], y: q[1], ang: Math.PI / 2, pose: dt < 1.5 ? 'hide' : 'hands', m: m, mv: 0 }); }
      else if (dt < AL_LEAD + AL_ESC) for (m = 0; m < 2; m++) {
        var pe = polyAt(P.esc, P.el, ease((dt - AL_LEAD) / AL_ESC) - m * 0.05);
        out.figs.push({ x: pe.x, y: pe.y, ang: pe.ang, pose: 'led', m: m, mv: 1 });
      }
      return out;
    }
    var T = P.T, w1 = OP_WORK[o.kind] || 12, da = dt - OP_REACH;
    out.da = da;
    out.dark = 1 - clamp01((da - w1 - 20) / 20);
    if (da < 0) for (m = 0; m < 2; m++) {                       // от точки ожидания — к цели
      var pr = polyAt(P.reach, P.rl, dt / OP_REACH - m * 0.04);
      out.figs.push({ x: pr.x, y: pr.y + (m ? (T.low ? -0.3 : 0.3) : 0), ang: pr.ang, pose: 'sneak', m: m, mv: 1 });
    }
    else if (da < w1) for (m = 0; m < 2; m++) { q = atTarget(T, m); out.figs.push({ x: q[0], y: q[1], ang: T.face, pose: 'work', m: m, mv: 0, kind: o.kind }); }
    else if (da < w1 + OP_LEAVE) for (m = 0; m < 2; m++) {
      var pb = polyAt(P.back, P.bl, (da - w1) / OP_LEAVE - m * 0.03);
      out.figs.push({ x: pb.x, y: pb.y + (m ? (T.low ? -0.3 : 0.3) : 0), ang: pb.ang, pose: o.kind === 'theft' ? 'carry' : 'sneak', m: m, mv: 1 });
    }
    return out;
  }

  // Частицы последствий: взрыв, огонь и дым, зелёная дымка у пайков, сбой в сети
  function opsStep(dt) {
    var st = S.st, now = srvNow(), list = [];
    (st.ops || []).forEach(function(o) { var x = opNow(o, st, now); if (x) list.push(x); });
    S.cur = list;
    list.forEach(function(x) {
      var o = x.o, d0 = x.da;
      if (o.result !== 'ok' || d0 == null || d0 < 0 || !x.P.T) return;
      var at = x.P.T.at;
      if (o.kind === 'blast') {
        if (d0 >= OP_BOOM && d0 < OP_BOOM + 2 && !S.boom[o.id]) { S.boom[o.id] = 1; burst(at); }
        var fire = d0 >= OP_BOOM && d0 < OP_FIRE;
        if (fire && Math.random() < dt * 14) S.parts.push({ x: at[0] + (Math.random() - 0.5) * 0.7, y: at[1] + 0.1, vx: (Math.random() - 0.5) * 0.2, vy: -0.6 - Math.random() * 0.5, t: 0, life: 0.5 + Math.random() * 0.4, fl: 1, col: Math.random() < 0.5 ? '#ffb15a' : '#ff6a3c' });
        if (d0 >= OP_BOOM && !o.revealed && Math.random() < dt * (fire ? 3 : 0.7)) smokePuff(at, fire ? '#2f2c2a' : '#6b6762');
      } else if (o.kind === 'poison' && d0 >= 8 && (d0 < 50 || st.spoiled) && Math.random() < dt * (d0 < 50 ? 5 : 0.6)) {
        smokePuff([at[0] + (Math.random() - 0.5) * 2.4, at[1] + (Math.random() - 0.5) * 1.4], '#6fdc5a');
      } else if (o.kind === 'virus' && d0 >= OP_WORK.virus && d0 < OP_WORK.virus + 25 && Math.random() < dt * 6) {
        spark(at[0] + (Math.random() - 0.5) * 0.8, at[1], Math.random() < 0.55 ? '#ff4a3c' : '#8fd3ff');
      }
    });
    alarmGuards(list);
  }
  function burst(at) {
    for (var i = 0; i < 26; i++) { var a = Math.random() * TAU, v = 1 + Math.random() * 2.2; S.parts.push({ x: at[0], y: at[1], vx: Math.cos(a) * v, vy: Math.sin(a) * v - 0.6, t: 0, life: 0.5 + Math.random() * 0.5, col: Math.random() < 0.5 ? '#ffe08a' : '#ff8a3c' }); }
    for (i = 0; i < 9; i++) smokePuff([at[0] + (Math.random() - 0.5) * 0.9, at[1] + (Math.random() - 0.5) * 0.6], '#3a3633');
  }
  function smokePuff(at, col) { S.parts.push({ x: at[0], y: at[1], vx: (Math.random() - 0.5) * 0.2, vy: -0.3 - Math.random() * 0.25, t: 0, life: 2 + Math.random(), sm: 1, col: col }); }

  // Тревога: ближний охранник бежит к пойманным, стоит над ними, ведёт в барак и возвращается на пост.
  // Охраны нет — выходит дежурный из барака. Начало подбега — откуда он был, дальше всё по времени тревоги
  function alarmGuards(list) {
    var al = null;
    list.forEach(function(x) { if (!al && x.o.result === 'caught' && x.dt >= 0 && x.dt < AL_LEAD + AL_ESC + AL_BACK) al = x; });
    S.escort = null;
    if (!al) return;
    var T = al.P.C, dt = al.dt, g = null;
    S.agents.forEach(function(a) { if (a.k === 'g' && !g) g = a; });
    var me = g || { k: 'g', i: 0, ph: 0, x: BARR.door[0], y: BARR.door[1], role: 'post' };
    if (me.alarmOp !== al.o.id) { me.alarmOp = al.o.id; me.ax0 = g ? [g.x, g.y] : BARR.door.slice(); }
    var stand1 = [T.x + (T.x + 0.8 > W - 0.3 ? -0.8 : 0.8), T.y + 0.2], p, ang, mv = 1;
    if (dt < AL_RUN) { p = lerp2(me.ax0, stand1, ease(dt / AL_RUN)); ang = Math.atan2(stand1[1] - me.ax0[1], stand1[0] - me.ax0[0]); }
    else if (dt < AL_LEAD) { p = stand1; ang = Math.atan2(T.y - p[1], T.x - p[0]); mv = 0; }
    else if (dt < AL_LEAD + AL_ESC) { var pe = polyAt(al.P.esc, al.P.el, ease((dt - AL_LEAD) / AL_ESC) - 0.1); p = [pe.x + 0.35, pe.y + 0.15]; ang = pe.ang; }
    else {
      if (!g) return;                                             // дежурный ушёл в барак вместе с пленными
      var door = [BARR.door[0] + 0.35, BARR.door[1] + 0.05], home = GPOST[g.i % GPOST.length][0];
      p = lerp2(door, home, ease((dt - AL_LEAD - AL_ESC) / AL_BACK)); ang = Math.atan2(home[1] - door[1], home[0] - door[0]);
    }
    me.x = p[0]; me.y = p[1]; me.ang = ang; me.mv = mv; me.alarm = true;
    if (g) { g.path = null; g.hold = 0.25; g.wait = 2; }
    else S.escort = me;
  }

  // Рисунок: следы и улики до конца следствия, летящие листовки
  function opsUnder(c) {
    (S.cur || []).forEach(function(x) {
      var o = x.o, P = x.P, d0 = x.da, w1 = OP_WORK[o.kind] || 12;
      if (o.result !== 'ok' || d0 == null || !P.T) return;
      var at = P.T.at, ev = !o.revealed, i;
      if (d0 < 0) return;
      if (ev && d0 >= w1) {                                        // следы — когда группа уже отходит, вдоль всего пути
        c.fillStyle = 'rgba(12,10,8,0.22)';
        P.steps.forEach(function(s2) { c.beginPath(); c.ellipse(s2[0], s2[1], 0.06, 0.04, 0, 0, TAU); c.fill(); });
      }
      if (o.kind === 'blast' && d0 >= OP_BOOM && ev) {
        var sg = c.createRadialGradient(at[0], at[1] + 0.2, 0.05, at[0], at[1] + 0.2, 1.0);
        sg.addColorStop(0, 'rgba(8,6,4,0.75)'); sg.addColorStop(1, 'rgba(8,6,4,0)');
        c.fillStyle = sg; c.beginPath(); c.ellipse(at[0], at[1] + 0.2, 1.0, 0.7, 0, 0, TAU); c.fill();
      } else if (o.kind === 'theft' && d0 >= w1 * 0.5 && ev) {
        var bx = P.T.x - 0.05, by = P.T.y + 0.75;                  // вскрытый ящик у склада, крышка отброшена
        c.fillStyle = 'rgba(0,0,0,0.35)'; rr(c, bx - 0.26, by - 0.16, 0.56, 0.42, 0.05); c.fill();
        c.fillStyle = '#7a5a36'; rr(c, bx - 0.3, by - 0.2, 0.56, 0.42, 0.05); c.fill();
        c.fillStyle = '#2a2018'; rr(c, bx - 0.24, by - 0.14, 0.44, 0.3, 0.03); c.fill();
        c.save(); c.translate(bx + 0.42, by - 0.32); c.rotate(0.6); c.fillStyle = '#8a6a40'; rr(c, -0.28, -0.08, 0.56, 0.16, 0.03); c.fill(); c.restore();
      } else if (o.kind === 'poison' && d0 >= 8 && (ev || S.st.spoiled)) {
        var pg = c.createRadialGradient(at[0], at[1], 0.1, at[0], at[1], 1.6);
        pg.addColorStop(0, 'rgba(111,220,90,0.16)'); pg.addColorStop(1, 'rgba(111,220,90,0)');
        c.fillStyle = pg; c.beginPath(); c.arc(at[0], at[1], 1.6, 0, TAU); c.fill();
      } else if (o.kind === 'strike' && d0 >= 4) {
        var fk = clamp01((d0 - 4) / 12);                           // разлетаются от цели и ложатся
        if (fk >= 1 && !ev) return;
        for (i = 0; i < P.leaf.length; i++) {
          var L = P.leaf[i], lk = clamp01(fk * 1.4 - i * 0.03), lp = lerp2([P.T.x, P.T.y - 0.4], L, lk);
          c.save(); c.translate(lp[0], lp[1] - Math.sin(lk * Math.PI) * 0.6); c.rotate(L[2] + lk * 3);
          c.fillStyle = 'rgba(232,226,208,0.85)'; c.fillRect(-0.09, -0.06, 0.18, 0.12);
          c.fillStyle = 'rgba(217,74,74,0.8)'; c.fillRect(-0.06, -0.03, 0.12, 0.025);
          c.restore();
        }
      }
    });
  }
  // Затемнение на подходе и в тревоге; конусы охраны и прожекторы караула светят поверх
  function opsDark(c, t) {
    var k = 0; (S.cur || []).forEach(function(x) { if (x.dark > k) k = x.dark; });
    if (k > 0) {
      c.fillStyle = 'rgba(3,6,14,' + (0.46 * k) + ')'; c.fillRect(-1, -1, W + 2, H + 2);
      var vg = c.createRadialGradient(W / 2, H / 2, 2, W / 2, H / 2, W * 0.7);
      vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,' + (0.35 * k) + ')');
      c.fillStyle = vg; c.fillRect(-1, -1, W + 2, H + 2);
    }
    var alarm = S.escort || S.agents.some(function(a) { return a.k === 'g' && a.alarm; });
    S.agents.forEach(function(a) { if (a.k === 'g' && !a.inside) cone(c, a.x, a.y, a.ang, 2.5 + 0.4 * k, 0.06 + 0.14 * k, a.alarm ? '#ff6a5a' : '#fff0c8'); });
    if (S.escort) cone(c, S.escort.x, S.escort.y, S.escort.ang, 2.5, 0.18, '#ff6a5a');
    if (S.st.run && S.st.run.task === 'guard') searchlights(c, t, k);
    return alarm;
  }
  function cone(c, x, y, ang, r, a, col) {
    if (!(r > 0) || !(a > 0)) return;
    var g = c.createRadialGradient(x, y, 0.05, x, y, r);
    g.addColorStop(0, rgba(col, Math.min(1, a))); g.addColorStop(1, rgba(col, 0));
    c.fillStyle = g; c.beginPath(); c.moveTo(x, y); c.arc(x, y, r, ang - 0.55, ang + 0.55); c.closePath(); c.fill();
  }
  // Караул бригады: два прожектора по углам стены медленно водят лучами по рабочей зоне
  function searchlights(c, t, k) {
    [[0.5, 0.6, 0.62], [W - 0.5, 0.6, Math.PI - 0.62]].forEach(function(L, i) {
      var a = L[2] + Math.sin(t * 0.45 + i * 2.1) * 0.55, r = 8.5;
      var g = c.createRadialGradient(L[0], L[1], 0.1, L[0], L[1], r);
      g.addColorStop(0, 'rgba(255,244,214,' + (0.15 + 0.12 * k) + ')'); g.addColorStop(1, 'rgba(255,244,214,0)');
      c.fillStyle = g; c.beginPath(); c.moveTo(L[0], L[1]); c.arc(L[0], L[1], r, a - 0.16, a + 0.16); c.closePath(); c.fill();
      c.fillStyle = '#2a2f35'; dot(c, L[0], L[1], 0.17);
      c.fillStyle = '#fff6cc'; dot(c, L[0], L[1], 0.08);
    });
  }
  // Фигурки группы и дежурный из барака
  function opsFigs(c, t) {
    (S.cur || []).forEach(function(x) {
      var side = x.o.side === 'cis' ? 'cis' : 'republic';
      x.figs.forEach(function(f) {
        if (f.x < -0.5 || f.x > W + 0.5) return;
        c.save(); c.translate(f.x, f.y); c.scale(FIGK, FIGK);
        if (f.pose === 'hide') c.globalAlpha = 0.72;
        spy(c, f, side, t);
        c.restore();
      });
    });
    if (S.escort) { var e = S.escort; c.save(); c.translate(e.x, e.y); c.scale(FIGK, FIGK); human(c, e, THEME[S.kind], t); c.restore(); }
  }
  // Поверх всего: вспышка взрыва, сирены, «!» над охранником, выстрелы, «?» у места до конца следствия
  function opsOver(c, t) {
    (S.cur || []).forEach(function(x) {
      var o = x.o, d0 = x.dt, w1 = OP_WORK[o.kind] || 12;
      if (d0 < 0) return;                                          // итога ещё нет: что за операция, хозяину не видно
      if (o.result === 'caught') {
        if (d0 < AL_END) {
          var on = Math.sin(t * 9) > 0;
          [[BARR.x + 0.3, BARR.y - 0.18], [BARR.x + BARR.w - 0.3, BARR.y - 0.18], [STORE.x + 0.3, STORE.y - 0.18], [STORE.x + STORE.w - 0.3, STORE.y - 0.18]].forEach(function(p, i) {
            var lit = on === (i % 2 === 0);
            if (lit) { var hg = c.createRadialGradient(p[0], p[1], 0.02, p[0], p[1], 1.1); hg.addColorStop(0, 'rgba(255,60,50,0.45)'); hg.addColorStop(1, 'rgba(255,60,50,0)'); c.fillStyle = hg; dot(c, p[0], p[1], 1.1); }
            c.fillStyle = lit ? '#ff4a3c' : '#5a1a16'; dot(c, p[0], p[1], 0.11);
          });
        }
        var gd = S.escort || S.agents.filter(function(a) { return a.k === 'g' && a.alarm; })[0];
        if (gd && d0 < 3) text(c, '!', gd.x, gd.y - 1.0 - Math.abs(Math.sin(d0 * 6)) * 0.2, 0.75, '#ff4a3c', 'bold');
        if (gd) [1.5, 2.4, 3.3].forEach(function(t0, i) {
          var k = (d0 - t0) / 0.3; if (k < 0 || k > 1) return;
          var tx = x.P.C.x + (i - 1) * 0.5, ty = x.P.C.y - 0.3, a = lerp2([gd.x, gd.y - 0.2], [tx, ty], k), b = lerp2([gd.x, gd.y - 0.2], [tx, ty], Math.max(0, k - 0.25));
          c.strokeStyle = 'rgba(255,90,74,0.95)'; c.lineWidth = 0.07; c.lineCap = 'round'; c.beginPath(); c.moveTo(b[0], b[1]); c.lineTo(a[0], a[1]); c.stroke();
          if (k > 0.9) { c.fillStyle = 'rgba(255,200,150,0.7)'; dot(c, tx, ty, 0.14); }
        });
        return;
      }
      if (!x.P.T || x.da == null) return;
      var at = x.P.T.at;
      d0 = x.da;                                                   // дальше — от прихода к цели
      if (o.kind === 'blast') {
        if (d0 < OP_BOOM && d0 >= 3) {                           // заряд мигает чаще и чаще
          var bk = Math.sin(t * (6 + (d0 - 3) * 1.2)) > 0.2;
          c.fillStyle = '#2a2f35'; rr(c, at[0] - 0.1, at[1] + 0.18, 0.2, 0.14, 0.03); c.fill();
          c.fillStyle = bk ? '#ff3b2f' : '#5a1a16'; dot(c, at[0], at[1] + 0.25, 0.04);
        }
        if (d0 >= OP_BOOM && d0 < OP_FIRE) {                     // пожар: отсвет мерцает и гаснет к концу
          var fa = (0.22 + 0.1 * Math.sin(t * 11) * Math.sin(t * 4.3)) * (1 - clamp01((d0 - OP_FIRE + 30) / 30));
          var gg = c.createRadialGradient(at[0], at[1], 0.05, at[0], at[1], 1.5); gg.addColorStop(0, 'rgba(255,150,60,' + Math.max(0, fa) + ')'); gg.addColorStop(1, 'rgba(255,90,40,0)');
          c.fillStyle = gg; dot(c, at[0], at[1], 1.5);
        }
        var fk = (d0 - OP_BOOM) / 0.8;
        if (fk >= 0 && fk <= 1) { var fr = 0.3 + fk * 2.2, fg = c.createRadialGradient(at[0], at[1], 0.05, at[0], at[1], fr); fg.addColorStop(0, 'rgba(255,246,210,' + (0.9 * (1 - fk)) + ')'); fg.addColorStop(1, 'rgba(255,140,60,0)'); c.fillStyle = fg; dot(c, at[0], at[1], fr); }
      }
      if (o.kind === 'virus' && d0 >= OP_WORK.virus && d0 < OP_WORK.virus + 4) {
        for (var r = 0; r < 3; r++) { var rk = clamp01((d0 - OP_WORK.virus - r * 0.6) / 2.4); if (rk <= 0 || rk >= 1) continue; c.strokeStyle = 'rgba(255,74,60,' + (0.7 * (1 - rk)) + ')'; c.lineWidth = 0.06; c.beginPath(); c.arc(at[0], at[1], 0.3 + rk * 7, 0, TAU); c.stroke(); }
      }
      if (o.result === 'ok' && !o.revealed && d0 >= w1) {        // «?» — следствие ещё идёт
        var qk = 0.5 + 0.5 * Math.sin(t * 2.2);
        c.fillStyle = 'rgba(217,169,64,' + (0.12 + 0.12 * qk) + ')'; dot(c, at[0], at[1] - 1.05, 0.42);
        c.strokeStyle = 'rgba(255,214,107,' + (0.55 + 0.35 * qk) + ')'; c.lineWidth = 0.05; c.beginPath(); c.arc(at[0], at[1] - 1.05, 0.3, 0, TAU); c.stroke();
        text(c, '?', at[0], at[1] - 1.03, 0.44, '#ffd66b', 'bold');
      }
    });
  }
  // Диверсант сверху: пригнулся на подходе, у цели — с зарядом, планшетом, ломом или листовками; пойманный — руки вверх
  function spy(c, f, side, t) {
    var L = SPY_LOOK[side], low = f.pose === 'sneak' || f.pose === 'hide' || f.pose === 'work', cis = side === 'cis';
    c.rotate(f.ang + Math.PI / 2);
    if (low) c.scale(0.88, 0.88);
    var sw = f.mv ? Math.sin(t * (f.pose === 'sneak' ? 8 : 6) + f.m * 2) * 0.1 : 0;
    c.fillStyle = 'rgba(0,0,0,0.45)'; c.beginPath(); c.ellipse(0.05, 0.08, cis ? 0.24 : 0.3, 0.26, 0, 0, TAU); c.fill();
    c.fillStyle = L.leg; c.beginPath(); c.ellipse(-0.09, sw, 0.06, 0.11, 0, 0, TAU); c.fill(); c.beginPath(); c.ellipse(0.09, -sw, 0.06, 0.11, 0, 0, TAU); c.fill();
    c.strokeStyle = L.arm; c.lineWidth = cis ? 0.05 : 0.075; c.lineCap = 'round';
    if (f.pose === 'hands') {
      c.beginPath(); c.moveTo(-0.17, 0); c.lineTo(-0.24, -0.34); c.moveTo(0.17, 0); c.lineTo(0.24, -0.34); c.stroke();
      c.fillStyle = L.arm; dot(c, -0.24, -0.36, 0.04); dot(c, 0.24, -0.36, 0.04);
    } else if (f.pose === 'led') {
      c.beginPath(); c.moveTo(-0.16, 0); c.lineTo(-0.05, 0.16); c.moveTo(0.16, 0); c.lineTo(0.05, 0.16); c.stroke();
    } else if (f.pose === 'carry') {
      c.beginPath(); c.moveTo(-0.16, 0); c.lineTo(-0.1, -0.22); c.moveTo(0.16, 0); c.lineTo(0.1, -0.22); c.stroke();
      c.fillStyle = '#8a6a40'; rr(c, -0.18, -0.44, 0.36, 0.26, 0.04); c.fill(); c.strokeStyle = 'rgba(0,0,0,0.45)'; c.lineWidth = 0.025; c.stroke();
    } else if (f.pose === 'work') {
      var wk = Math.sin(t * 7 + f.m * 1.7);
      c.beginPath(); c.moveTo(-0.16, 0); c.lineTo(-0.06, -0.26 - wk * 0.03); c.moveTo(0.16, 0); c.lineTo(0.06, -0.26 + wk * 0.03); c.stroke();
      var kind = f.kind;
      if (kind === 'blast') { c.fillStyle = '#2a2f35'; rr(c, -0.08, -0.4, 0.16, 0.12, 0.02); c.fill(); c.fillStyle = Math.sin(t * 8) > 0 ? '#ff3b2f' : '#5a1a16'; dot(c, 0, -0.34, 0.025); }
      else if (kind === 'virus') { c.fillStyle = '#1b2430'; rr(c, -0.1, -0.42, 0.2, 0.14, 0.02); c.fill(); c.fillStyle = 'rgba(143,211,255,' + (0.6 + 0.3 * wk) + ')'; c.fillRect(-0.08, -0.4, 0.16, 0.1); }
      else if (kind === 'theft') { c.strokeStyle = '#9aa0a6'; c.lineWidth = 0.04; c.beginPath(); c.moveTo(0.06, -0.26); c.lineTo(0.02, -0.52 - wk * 0.04); c.stroke(); }
      else if (kind === 'strike') { c.fillStyle = 'rgba(232,226,208,0.9)'; c.fillRect(-0.1, -0.42, 0.18, 0.12); }
      else if (kind === 'poison') { c.fillStyle = '#3f6a35'; rr(c, -0.06, -0.44, 0.12, 0.16, 0.03); c.fill(); c.fillStyle = 'rgba(111,220,90,0.7)'; dot(c, 0, -0.47, 0.03); }
    } else {                                                     // на ходу — оружие наперевес
      c.beginPath(); c.moveTo(-0.16, 0); c.lineTo(-0.05, -0.22); c.moveTo(0.16, 0); c.lineTo(0.07, -0.28); c.stroke();
      c.strokeStyle = '#15181c'; c.lineWidth = 0.055; c.beginPath(); c.moveTo(-0.06, -0.1); c.lineTo(0.06, -0.46); c.stroke();
    }
    if (cis) {
      var cg = c.createLinearGradient(-0.13, 0, 0.13, 0); cg.addColorStop(0, L.body); cg.addColorStop(0.5, L.hi); cg.addColorStop(1, L.body);
      c.fillStyle = cg; rr(c, -0.14, -0.08, 0.28, 0.17, 0.05); c.fill();
      c.fillStyle = L.helm; rr(c, -0.07, -0.12, 0.14, 0.13, 0.03); c.fill();
      c.fillStyle = L.visor; c.fillRect(-0.055, -0.1, 0.11, 0.025);
      c.fillStyle = rgba(L.visor, 0.25); dot(c, 0, -0.09, 0.08);
    } else {
      var g = c.createLinearGradient(-0.2, 0, 0.2, 0); g.addColorStop(0, L.body); g.addColorStop(0.5, L.hi); g.addColorStop(1, L.body);
      c.fillStyle = g; c.beginPath(); c.ellipse(0, 0.02, 0.2, 0.12, 0, 0, TAU); c.fill();
      c.fillStyle = 'rgba(40,46,52,0.6)'; c.fillRect(-0.2, -0.005, 0.4, 0.03);
      c.fillStyle = L.helm; dot(c, 0, -0.01, 0.105);
      c.strokeStyle = f.m ? L.visor2 : L.visor; c.lineWidth = 0.035; c.beginPath(); c.arc(0, -0.01, 0.075, -Math.PI * 0.85, -Math.PI * 0.15); c.stroke();
      if (!f.m) { c.strokeStyle = '#8a96a2'; c.lineWidth = 0.02; c.beginPath(); c.moveTo(0.06, 0.02); c.lineTo(0.13, 0.16); c.stroke(); }  // антенна старшего
    }
  }

  // ---------------------------------------------------------------- кадр
  function accNow() {
    var r = S.st && S.st.run; if (!r) return null;
    // по времени сервера: ends_at серверное, часы телефона могут спешить или отставать
    var t1 = new Date(r.ends_at).getTime(), now = srvNow();
    var v = r.accrued + r.rate * Math.max(0, Math.min(now, t1) - (S.at + S.skew)) / 3600000;
    return r.cap != null ? Math.min(r.cap, v) : v;
  }
  function step(dt) {
    S.t += dt;
    if (!S.st) return;                       // кадр пришёл раньше первого состояния с сервера
    var acc = accNow();
    if (acc != null) {
      var whole = Math.floor(acc);
      if (S.seen == null || whole < S.seen) S.seen = whole;
      var n = Math.min(4, whole - S.seen);
      for (var i = 0; i < n; i++) haul();
      S.seen = whole;
    } else S.seen = null;
    S.agents.forEach(function(a) {
      a.ph += dt * (a.k !== 'd' ? 7 : 5);
      if (a.path && a.path.length) {
        var p = a.path[0], dx = p[0] - a.x, dy = p[1] - a.y, d = Math.sqrt(dx * dx + dy * dy), sp = (a.k === 'g' ? 1.15 : a.k !== 'd' ? 2.3 : 2.0) * (a.carry ? 0.85 : 1);
        if (d < 0.05) { a.path.shift(); if (!a.path.length) arrive(a); }
        else { var k = Math.min(1, sp * dt / d); a.x += dx * k; a.y += dy * k; a.ang = Math.atan2(dy, dx); a.mv = Math.min(1, a.mv + dt * 6); }
      } else {
        a.mv = Math.max(0, a.mv - dt * 6);
        if (a.role === 'free' && Math.random() < dt * 0.12) a.path = [yardPoint(Math.random)];
        if (a.role === 'work' || a.role === 'strike') a.ang = -Math.PI / 2;   // бастующие — лицом к дороге, плакаты над головой
      }
      if (a.k === 'f' || a.k === 't') { staffStep(a, dt); return; }
      if (a.k === 'g') { guardStep(a, dt); return; }
      // у забоя: добыча и вскрыша — искры, обслуживание — сварка, разведка — импульс сканера
      if (a.role === 'work' && !a.path && !a.carry) {
        var task = S.st.run && S.st.run.task || 'extract';
        if (task === 'maint') { if (Math.random() < dt * 3) spark(a.x, a.y - 0.85, '#8fd3ff'); }
        else if (task === 'survey') { if (Math.random() < dt * 0.35) S.rings.push({ x: a.x, y: a.y - 0.9, t: 0 }); }
        else if (S.kind !== 'food' && Math.random() < dt * (S.kind === 'gas' ? 1.5 : 4) * (task === 'prep' ? 1.6 : task === 'guard' ? 0.6 : 1)) spark(a.x, a.y - 0.9, task === 'prep' ? '#a99b8a' : null);
      }
    });
    // износ: чем сильнее, тем чаще дымят установки
    var wear = S.st.wear || 0;
    if (wear >= 25) {
      var sp2 = spots(S.st.places);
      if (Math.random() < dt * (wear - 15) / 25) { var w0 = sp2[Math.floor(Math.random() * sp2.length)]; S.parts.push({ x: w0.x + (Math.random() - 0.5) * 0.5, y: w0.y - 0.3, vx: (Math.random() - 0.5) * 0.15, vy: -0.35 - Math.random() * 0.2, t: 0, life: 2.2 + Math.random(), sm: 1, col: wear >= 60 ? '#3a3633' : '#77736e' }); }
    }
    try { opsStep(dt); } catch (e) { opsErr(e); }
    for (var r0 = S.rings.length - 1; r0 >= 0; r0--) { S.rings[r0].t += dt; if (S.rings[r0].t > 1.4) S.rings.splice(r0, 1); }
    // свободные во дворе не стоят друг в друге
    var yard = S.agents.filter(function(a) { return a.role === 'free' && !a.inside && !a.path; });
    for (var p1 = 0; p1 < yard.length; p1++) for (var p2 = p1 + 1; p2 < yard.length; p2++) {
      var u = yard[p1], v = yard[p2], ddx = v.x - u.x, ddy = v.y - u.y, dd = Math.sqrt(ddx * ddx + ddy * ddy) || 0.01;
      if (dd < 0.75) { var push = (0.75 - dd) * 0.5; u.x -= ddx / dd * push; u.y -= ddy / dd * push; v.x += ddx / dd * push; v.y += ddy / dd * push; }
    }
    yard.forEach(function(a) { a.x = Math.max(YARD[0] + 0.3, Math.min(YARD[2] - 0.3, a.x)); a.y = Math.max(YARD[1] + 0.1, Math.min(YARD[3] - 0.1, a.y)); });
    for (var j = S.parts.length - 1; j >= 0; j--) { var q = S.parts[j]; q.t += dt; q.x += q.vx * dt; q.y += q.vy * dt; if (!q.sm && !q.fl) q.vy += 1.4 * dt; if (q.t > q.life) S.parts.splice(j, 1); }
    for (j = S.pops.length - 1; j >= 0; j--) { S.pops[j].t += dt; if (S.pops[j].t > 1.6) S.pops.splice(j, 1); }
  }
  function arrive(a) {
    if (a.carry && a.back) { a.carry = false; S.pops.push({ x: STORE.door[0], y: STORE.y + 0.3, t: 0 }); a.path = route([a.x, a.y], a.back, laneOf(a)); a.back = null; return; }
    if (a.role === 'rest' || a.role === 'hurt') a.inside = true;
  }
  function spark(x, y, col) {
    var T = THEME[S.kind];
    for (var i = 0; i < 2; i++) S.parts.push({ x: x + (Math.random() - 0.5) * 0.4, y: y, vx: (Math.random() - 0.5) * 1.4, vy: -0.8 - Math.random() * 0.8, t: 0, life: 0.35 + Math.random() * 0.3, col: col || (Math.random() < 0.5 ? T.lit : T.acc) });
  }
  // Бригадир на смене обходит занятые места; техники при износе идут от установки к установке и чинят
  function besideSpot(sp, i, side) { var p = stand(sp); return [p[0] + side * 0.72, p[1] + 0.15 + (i % 2) * 0.1]; }
  function staffStep(a, dt) {
    var st = S.st, run = st.run, sp = spots(st.places);
    var role = a.k === 'f' ? (run ? 'boss' : 'idle') : (st.wear > 0.5 ? 'fix' : 'idle');
    if (role !== a.role) { a.role = role; a.wait = 0.3 + Math.random(); a.fixing = false; a.path = a.path && a.path.length ? a.path : null; }
    if (a.path && a.path.length) return;
    if (a.fixing && Math.random() < dt * 5) spark(a.x + 0.15 * Math.cos(a.ang), a.y + 0.15 * Math.sin(a.ang) - 0.2, '#8fd3ff');
    a.wait -= dt; if (a.wait > 0) return;
    if (role === 'boss') {
      var busy = S.agents.filter(function(b) { return b.role === 'work' && !b.path; });
      var j = busy.length ? busy[Math.floor(Math.random() * busy.length)].spot : Math.floor(Math.random() * sp.length);
      a.path = route([a.x, a.y], besideSpot(sp[j] || sp[0], a.i, j % 2 ? -1 : 1), 0.36); a.wait = 2.5 + Math.random() * 2.5; a.fixing = false;
    } else if (role === 'fix') {
      if (a.fixing) { a.fixing = false; a.cnt = (a.cnt || 0) + 1; a.wait = 0.2; return; }
      var n = sp.length, k = (a.i * 3 + (a.cnt || 0) * 2) % n, tgt = besideSpot(sp[k], a.i + 1, k % 2 ? 1 : -1);
      if (Math.abs(tgt[0] - a.x) + Math.abs(tgt[1] - a.y) < 0.2) { a.fixing = true; a.ang = Math.atan2(stand(sp[k])[1] - a.y - 0.6, stand(sp[k])[0] - a.x); a.wait = 3 + Math.random() * 2; }
      else a.path = route([a.x, a.y], tgt, -0.36);
    } else {
      a.path = route([a.x, a.y], yardPoint(Math.random), a.k === 'f' ? 0.36 : -0.36); a.wait = 4 + Math.random() * 4;
    }
  }

  function draw() {
    var c = S.c, st = S.st; if (!c || !st) return;
    bake();
    c.setTransform(1, 0, 0, 1, 0, 0); c.drawImage(S.bg, 0, 0);
    c.setTransform(S.dpr, 0, 0, S.dpr, 0, 0); c.translate(S.ox, S.oy); c.scale(S.px, S.px);
    var T = THEME[S.kind], sp = spots(st.places), t = S.t, run = st.run;
    // места: подсветка занятых, у газа — вспышка на вышке, у кристаллов — свечение
    var busy = {}; S.agents.forEach(function(a) { if (a.role === 'work' && !a.path) busy[a.spot] = 1; });
    sp.forEach(function(s, i) {
      var on = !!busy[i], k = on ? 0.6 + 0.4 * Math.sin(t * 3 + i) : 0.15;
      if (S.kind === 'gas') { c.fillStyle = rgba(T.acc, 0.25 + 0.5 * k); dot(c, s.x, s.y - 0.38, 0.2); if (on) { c.fillStyle = rgba(T.lit, 0.12 * k); dot(c, s.x, s.y - 0.38, 0.75); } }
      else if (S.kind === 'crystals') { c.fillStyle = rgba(T.acc, 0.08 + 0.2 * k); dot(c, s.x, s.y - 0.3, 0.8); }
      else if (S.kind === 'ore' && on) { c.fillStyle = rgba(T.lit, 0.07 * k); dot(c, s.x, s.y - 0.1, 0.9); }
      else if (T.fab === 'furnace') {                 // устье печи: горит, пока у печи работают
        var fk = on ? 0.55 + 0.45 * Math.sin(t * 5 + i * 1.7) * Math.sin(t * 2.3 + i) : 0.12;
        c.fillStyle = rgba(T.lit, 0.25 + 0.6 * fk); rr(c, s.x - 0.3, s.y - 0.3, 0.6, 0.4, 0.07); c.fill();
        if (on) { c.fillStyle = rgba(T.lit, 0.1 * fk); dot(c, s.x, s.y - 0.1, 1.0); }
      } else if (T.fab === 'reactor') {
        c.fillStyle = rgba(T.lit, on ? 0.35 + 0.45 * k : 0.12); dot(c, s.x, s.y - 0.42, 0.22);
        if (on) { c.strokeStyle = rgba(T.acc, 0.5 * k); c.lineWidth = 0.04; c.beginPath(); c.arc(s.x, s.y - 0.42, 0.33, t * 2 + i, t * 2 + i + 2.4); c.stroke(); }
      } else if (T.fab === 'bench') {
        for (var l = 0; l < 3; l++) { var lk = on ? (Math.sin(t * 6 + i * 2 + l * 2.1) > 0.2 ? 1 : 0.2) : 0.15; c.fillStyle = rgba(l === 1 ? '#5fd968' : T.lit, 0.3 + 0.6 * lk); dot(c, s.x - 0.4 + l * 0.4, s.y + 0.06, 0.04); }
      }
      if (!on && run) { c.fillStyle = 'rgba(0,0,0,0.25)'; dot(c, s.x, s.y - 0.1, 0.55); }
    });
    // богатая жила: золотые прожилки по скальной стене, мерцают
    if (st.vein_until && !T.fab) {
      var VR = rng(hash('vein' + S.kind)); c.lineCap = 'round'; c.lineJoin = 'round';
      for (var v = 0; v < 9; v++) {
        var vx = 1 + v * (W - 2) / 8 + (VR() - 0.5) * 0.8, vy = 0.55 + VR() * 0.7, vk = 0.5 + 0.5 * Math.sin(t * 1.4 + v * 1.7);
        c.strokeStyle = 'rgba(255,214,90,' + (0.12 * vk) + ')'; c.lineWidth = 0.22;
        c.beginPath(); c.moveTo(vx - 0.5, vy); c.lineTo(vx - 0.15, vy + 0.22); c.lineTo(vx + 0.2, vy + 0.05); c.lineTo(vx + 0.55, vy + 0.28); c.stroke();
        c.strokeStyle = 'rgba(255,226,140,' + (0.45 + 0.4 * vk) + ')'; c.lineWidth = 0.05; c.stroke();
        c.fillStyle = 'rgba(255,246,200,' + (0.5 * vk) + ')'; dot(c, vx + 0.2, vy + 0.05, 0.05);
      }
    }
    // цех: отлаженный режим — зелёные лампы по стене зала
    if (T.fab && st.vein_until) for (var lp = 0; lp < 8; lp++) {
      var lx = 1.2 + lp * (W - 2.4) / 7, lk2 = 0.5 + 0.5 * Math.sin(t * 2 + lp);
      c.fillStyle = 'rgba(95,217,104,' + (0.1 * lk2) + ')'; dot(c, lx, 0.6, 0.45);
      c.fillStyle = 'rgba(160,255,170,' + (0.55 + 0.4 * lk2) + ')'; dot(c, lx, 0.6, 0.07);
    }
    if (!run) { c.fillStyle = 'rgba(5,8,13,0.28)'; c.fillRect(0, 0, W, 6.3); }
    if (T.fab) beltLoad(c, T, st, t);
    storeHeap(c, T, st);
    // диверсии: улики, затемнение на подходе, конусы охраны и прожекторы караула — под фигурками
    opsDraw(c, t, opsUnder);
    opsDraw(c, t, opsDark);
    // рабочие: по глубине
    var vis = S.agents.filter(function(a) { return !a.inside; }).sort(function(a, b) { return a.y - b.y; });
    vis.forEach(function(a) { c.save(); c.translate(a.x, a.y); c.scale(FIGK, FIGK); if (a.k === 'd') droid(c, a, T, t); else human(c, a, T, t); c.restore(); });
    opsDraw(c, t, opsFigs);
    S.parts.forEach(function(q) {
      var f = q.t / q.life;
      if (q.sm) { c.fillStyle = rgba(q.col, 0.32 * (1 - f) * Math.min(1, f * 5)); dot(c, q.x, q.y, 0.18 + f * 0.45); }
      else if (q.fl) { c.fillStyle = rgba(q.col, 0.85 * (1 - f)); dot(c, q.x, q.y, 0.03 + 0.12 * (1 - f)); }
      else { c.fillStyle = rgba(q.col.charAt(0) === '#' ? q.col : '#ffffff', Math.max(0, 1 - f)); dot(c, q.x, q.y, 0.045); }
    });
    S.rings.forEach(function(r) { var k = r.t / 1.4; c.strokeStyle = 'rgba(143,211,255,' + (0.6 * (1 - k)) + ')'; c.lineWidth = 0.05; c.beginPath(); c.arc(r.x, r.y, 0.2 + k * 1.3, 0, TAU); c.stroke(); });
    labels(c, T, st);
    opsDraw(c, t, opsOver);
    S.pops.forEach(function(p) {
      var k = p.t / 1.6; c.save(); c.globalAlpha = Math.max(0, 1 - k * k);
      text(c, '+1', p.x, p.y - 0.4 - k * 1.1, 0.55, T.lit, 'bold');
      c.restore();
    });
  }
  // по ленте идёт сырьё: из приёмки вверх и вдоль ряда мест, пока смена перерабатывает взятое
  function beltLoad(c, T, st, t) {
    var r = st.run, acc = accNow();
    if (!r || !r.input || (r.task !== 'extract' && r.task !== 'prep' && r.task !== 'guard') || (r.cap != null && acc != null && acc >= r.cap - 0.001)) return;
    var up = RAW.y - BELT, len = up + (W - 2.8), N = 16, cols = st.refine ? st.refine.inputs.map(function(x) { return x.color; }) : [T.raw];
    for (var i = 0; i < N; i++) {
      var u = ((t * 0.55 + i / N) % 1) * len, x, y;
      if (u < up) { x = RAW.feed; y = RAW.y - u; }
      else { var v = u - up, side = i % 2 ? 1 : -1; x = RAW.feed + side * v * 0.62; y = BELT; if (x < 1.5 || x > W - 1.5) continue; }
      c.fillStyle = 'rgba(0,0,0,0.35)'; rr(c, x - 0.1, y - 0.06, 0.22, 0.18, 0.04); c.fill();
      c.fillStyle = cols[i % cols.length] || T.raw; rr(c, x - 0.12, y - 0.1, 0.22, 0.18, 0.04); c.fill();
    }
  }
  function storeHeap(c, T, st) {
    var s = STORE, f = Math.max(0, Math.min(1, st.stock / Math.max(1, st.site_cap)));
    var cx = s.x + s.w / 2, cy = s.y + s.h / 2 + 0.1;
    if (T.fab) { fabStore(c, T, st, f); return; }
    if (S.kind === 'gas') {
      for (var i = 0; i < 3; i++) {
        var x = s.x + 0.85 + i * 1.35, y = cy;
        c.fillStyle = 'rgba(0,0,0,0.35)'; dot(c, x + 0.08, y + 0.1, 0.58);
        c.fillStyle = '#5d6967'; dot(c, x, y, 0.58);
        c.fillStyle = '#26302f'; dot(c, x, y, 0.44);
        c.fillStyle = rgba(T.acc, 0.25 + 0.6 * f); dot(c, x, y, 0.44 * Math.sqrt(Math.max(0.05, f)));
        c.strokeStyle = 'rgba(255,255,255,0.15)'; c.lineWidth = 0.04; c.beginPath(); c.arc(x, y, 0.58, Math.PI * 1.1, Math.PI * 1.6); c.stroke();
      }
      return;
    }
    if (S.kind === 'food' || S.kind === 'crystals') {
      var n = Math.round(f * 12);
      for (var k = 0; k < Math.max(1, n); k++) {
        var bx = s.x + 0.45 + (k % 4) * 0.92, by = s.y + 0.45 + Math.floor(k / 4) * 0.85;
        c.globalAlpha = n ? 1 : 0.25;
        c.fillStyle = 'rgba(0,0,0,0.35)'; rr(c, bx + 0.06, by + 0.06, 0.74, 0.66, 0.06); c.fill();
        c.fillStyle = S.kind === 'food' ? '#7a5a36' : '#3d3550'; rr(c, bx, by, 0.74, 0.66, 0.06); c.fill();
        c.fillStyle = rgba(T.acc, S.kind === 'food' ? 0.55 : 0.8); dot(c, bx + 0.37, by + 0.33, 0.14);
        c.globalAlpha = 1;
      }
      return;
    }
    // руда — куча, растёт с запасом
    var r = 0.35 + 1.15 * Math.sqrt(f);
    c.fillStyle = 'rgba(0,0,0,0.35)'; c.beginPath(); c.ellipse(cx + 0.1, cy + 0.12, r * 1.25, r * 0.8, 0, 0, TAU); c.fill();
    var g = c.createRadialGradient(cx - r * 0.3, cy - r * 0.35, r * 0.1, cx, cy, r * 1.25);
    g.addColorStop(0, shade(T.acc, 1.2)); g.addColorStop(1, shade(T.acc, 0.55));
    c.fillStyle = g; c.beginPath(); c.ellipse(cx, cy, r * 1.2, r * 0.75, 0, 0, TAU); c.fill();
    var R = rng(7); for (var j = 0; j < 10 * r; j++) { c.fillStyle = 'rgba(0,0,0,0.25)'; dot(c, cx + (R() - 0.5) * r * 2, cy + (R() - 0.5) * r * 1.2, 0.05); }
    // вагонетка у склада
    var tx = STORE.door[0] + 1.6;
    c.fillStyle = 'rgba(0,0,0,0.35)'; rr(c, tx - 0.42, ROAD - 0.28, 0.9, 0.6, 0.08); c.fill();
    c.fillStyle = '#5b5f63'; rr(c, tx - 0.48, ROAD - 0.34, 0.9, 0.6, 0.08); c.fill();
    c.fillStyle = shade(T.acc, 0.8); rr(c, tx - 0.4, ROAD - 0.27, 0.74, 0.46, 0.06); c.fill();
  }
  // цех: готовое на складе — слитки, ячейки или ящики; в приёмке — сырьё по запасу планеты
  function fabStore(c, T, st, f) {
    var s = STORE, n = Math.round(f * 12), k;
    for (k = 0; k < Math.max(1, n); k++) {
      var bx = s.x + 0.45 + (k % 4) * 0.92, by = s.y + 0.45 + Math.floor(k / 4) * 0.85;
      c.globalAlpha = n ? 1 : 0.25;
      if (T.fab === 'furnace') {                      // слитки дюрастали стопкой
        for (var j = 0; j < 3; j++) {
          c.fillStyle = 'rgba(0,0,0,0.3)'; rr(c, bx + 0.05, by + j * 0.2 + 0.05, 0.74, 0.17, 0.04); c.fill();
          var ig = c.createLinearGradient(0, by + j * 0.2, 0, by + j * 0.2 + 0.17); ig.addColorStop(0, '#c9d6e3'); ig.addColorStop(1, '#6f8296');
          c.fillStyle = ig; rr(c, bx, by + j * 0.2, 0.74, 0.17, 0.04); c.fill();
        }
      } else if (T.fab === 'reactor') {               // топливные ячейки
        for (var q = 0; q < 2; q++) {
          c.fillStyle = 'rgba(0,0,0,0.3)'; dot(c, bx + 0.2 + q * 0.36 + 0.04, by + 0.36, 0.17);
          c.fillStyle = '#5a5340'; dot(c, bx + 0.2 + q * 0.36, by + 0.32, 0.17);
          c.fillStyle = rgba(T.acc, 0.85); dot(c, bx + 0.2 + q * 0.36, by + 0.32, 0.09);
        }
      } else {                                        // ящики электроники
        c.fillStyle = 'rgba(0,0,0,0.35)'; rr(c, bx + 0.06, by + 0.06, 0.74, 0.66, 0.06); c.fill();
        c.fillStyle = '#34465e'; rr(c, bx, by, 0.74, 0.66, 0.06); c.fill();
        c.fillStyle = rgba(T.acc, 0.8); c.fillRect(bx + 0.14, by + 0.28, 0.46, 0.1);
      }
      c.globalAlpha = 1;
    }
    // приёмка: сколько сырья на складе планеты относительно его предела
    var r = st.refine, cap = Math.max(1, st.planet.cap), have = 0;
    if (r && r.inputs.length) r.inputs.forEach(function(x, i) {
      var fr = Math.max(0, Math.min(1, x.have / cap)), col = x.color || (i ? T.raw2 : T.raw), w = (RAW.w - 0.6) / r.inputs.length;
      var x0 = RAW.x + 0.3 + i * w, hh = (RAW.h - 0.6) * Math.sqrt(fr);
      if (fr > 0) {
        var g = c.createLinearGradient(0, RAW.y + RAW.h - 0.3 - hh, 0, RAW.y + RAW.h - 0.3); g.addColorStop(0, shade(col, 1.15)); g.addColorStop(1, shade(col, 0.55));
        c.fillStyle = g; c.beginPath(); c.ellipse(x0 + w / 2, RAW.y + RAW.h - 0.3, w / 2 - 0.05, Math.max(0.12, hh), 0, Math.PI, TAU); c.fill();
      }
      have += x.have;
    });
  }
  function text(c, s, x, y, size, col, w) {
    c.save(); c.scale(1 / S.px, 1 / S.px);
    c.font = (w || 'normal') + ' ' + Math.round(size * S.px) + 'px "Courier New", monospace'; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.lineWidth = Math.max(2, size * S.px * 0.22); c.strokeStyle = 'rgba(5,6,10,0.85)'; c.strokeText(s, x * S.px, y * S.px);
    c.fillStyle = col; c.fillText(s, x * S.px, y * S.px);
    c.restore();
  }
  function labels(c, T, st) {
    text(c, st.stock + '/' + st.site_cap, STORE.x + STORE.w / 2, STORE.y + STORE.h + 0.42, 0.42, '#cfd8dc');
    if (T.fab && st.refine) {
      var low = st.refine.inputs.some(function(x) { return x.have < x.k; });
      text(c, 'сырьё ' + st.refine.inputs.map(function(x) { return x.have; }).join(' · '), RAW.x + RAW.w / 2, RAW.y + RAW.h + 0.42, 0.42, low ? '#ff8a7a' : '#cfd8dc');
    }
    var cn = counts(st), inH = cn.h.rest + cn.h.hurt, inD = cn.d.rest + cn.d.hurt, now = srvNow();   // rest_* — отметки сервера
    var parts = [];
    if (cn.h.rest || cn.d.rest) {
      var until = Math.max(st.rest_h ? new Date(st.rest_h).getTime() : 0, st.rest_d ? new Date(st.rest_d).getTime() : 0), m = Math.max(0, Math.ceil((until - now) / 60000));
      parts.push('отдых ' + (cn.h.rest + cn.d.rest) + (m ? ' · ' + (m >= 60 ? Math.floor(m / 60) + ' ч ' + (m % 60) + ' м' : m + ' мин') : ''));
    }
    if (cn.h.hurt || cn.d.hurt) parts.push('выбыли ' + (cn.h.hurt + cn.d.hurt));
    if (cn.h.dis) parts.push('бастуют ' + cn.h.dis);
    if (cn.d.dis) parts.push('сбой ' + cn.d.dis);
    if (parts.length) text(c, parts.join(' · '), BARR.x + BARR.w / 2, BARR.y + BARR.h + 0.42, 0.38, '#9fb4c8');
    // окна барака светятся, если внутри кто-то есть
    if (inH + inD) { for (var i = 0; i < 4; i++) { c.fillStyle = 'rgba(255,214,140,' + (0.55 + 0.25 * Math.sin(S.t * 1.3 + i)) + ')'; c.fillRect(BARR.x + 0.55 + i * 1.08, BARR.y + 0.45, 0.42, 0.22); } }
    // сон над бараком
    if (cn.h.rest + cn.d.rest) { var zk = (S.t * 0.5) % 1; c.save(); c.globalAlpha = 1 - zk; text(c, 'z', BARR.x + BARR.w - 0.6 + zk * 0.4, BARR.y - 0.2 - zk * 0.8, 0.45, '#cfd8dc', 'bold'); c.restore(); }
    if (cn.h.hurt + cn.d.hurt) { c.fillStyle = '#d94a4a'; c.fillRect(BARR.x + 0.3, BARR.y - 0.55, 0.12, 0.42); c.fillRect(BARR.x + 0.15, BARR.y - 0.4, 0.42, 0.12); }
    if (!st.run) text(c, st.res_k <= 0 ? 'залежи нет' : T.fab && st.refine && st.refine.room < 1 ? 'нет сырья' : 'смены нет', W / 2, 5.6, 0.5, T.fab && st.refine && st.refine.room < 1 ? '#ff8a7a' : '#8fa8c4');
  }

  // Человек сверху: каска, плечи в спецовке, инструмент по ресурсу
  function human(c, a, T, t) {
    c.rotate(a.ang + Math.PI / 2);                      // «вверх» по экрану — вперёд
    var sw = a.mv * Math.sin(a.ph) * 0.12;
    c.fillStyle = 'rgba(0,0,0,0.35)'; c.beginPath(); c.ellipse(0.05, 0.07, 0.3, 0.26, 0, 0, TAU); c.fill();
    c.fillStyle = '#2d2a26'; c.beginPath(); c.ellipse(-0.1, sw, 0.07, 0.11, 0, 0, TAU); c.fill(); c.beginPath(); c.ellipse(0.1, -sw, 0.07, 0.11, 0, 0, TAU); c.fill();
    var work = a.role === 'work' && !a.path && !a.carry, swing = work ? Math.sin(t * 6 + a.ph) : 0;
    // руки и инструмент
    c.strokeStyle = '#6d5b45'; c.lineWidth = 0.08; c.lineCap = 'round';
    if (a.k === 'f' && !a.mv) {                             // бригадир: планшет в руках
      c.beginPath(); c.moveTo(-0.18, 0); c.lineTo(-0.08, -0.2); c.moveTo(0.18, 0); c.lineTo(0.08, -0.2); c.stroke();
      c.fillStyle = '#2b3542'; rr(c, -0.12, -0.34, 0.24, 0.16, 0.03); c.fill();
      c.fillStyle = 'rgba(120,200,255,' + (0.55 + 0.25 * Math.sin(t * 2 + a.ph)) + ')'; c.fillRect(-0.09, -0.31, 0.18, 0.1);
    } else if (a.k === 't' && a.fixing) {                    // техник: ключ к установке
      var ws = Math.sin(t * 9 + a.ph) * 0.25;
      c.beginPath(); c.moveTo(-0.16, 0); c.lineTo(-0.05, -0.26); c.moveTo(0.16, 0); c.lineTo(0.08, -0.28); c.stroke();
      c.save(); c.translate(0.08, -0.3); c.rotate(ws); c.strokeStyle = '#b9c2c9'; c.lineWidth = 0.05; c.beginPath(); c.moveTo(0, 0); c.lineTo(0, -0.22); c.stroke();
      c.lineWidth = 0.035; c.beginPath(); c.arc(0, -0.25, 0.05, Math.PI * 0.2, Math.PI * 1.8); c.stroke(); c.restore();
    } else if (a.k === 'g') {                                // охранник: бластерная винтовка наперевес
      c.beginPath(); c.moveTo(-0.17, 0); c.lineTo(-0.04, -0.24); c.moveTo(0.17, 0); c.lineTo(0.06, -0.3); c.stroke();
      c.strokeStyle = '#1d2228'; c.lineWidth = 0.06; c.beginPath(); c.moveTo(-0.06, -0.12); c.lineTo(0.08, -0.5); c.stroke();
      c.fillStyle = a.alarm ? '#ff5a4a' : 'rgba(255,90,74,0.45)'; dot(c, 0.085, -0.51, 0.024);
    } else if (a.role === 'strike') {                       // бастует: плакат над головой, покачивается
      var pw = Math.sin(t * 2.2 + a.ph) * 0.12;
      c.beginPath(); c.moveTo(-0.17, 0); c.lineTo(-0.06, -0.3); c.moveTo(0.17, 0); c.lineTo(0.06, -0.3); c.stroke();
      c.save(); c.rotate(pw);
      c.strokeStyle = '#6d5b45'; c.lineWidth = 0.035; c.beginPath(); c.moveTo(0, -0.28); c.lineTo(0, -0.5); c.stroke();
      c.fillStyle = '#e8e2d0'; rr(c, -0.22, -0.72, 0.44, 0.24, 0.03); c.fill();
      c.fillStyle = '#d94a4a'; c.fillRect(-0.16, -0.66, 0.32, 0.04); c.fillRect(-0.12, -0.58, 0.24, 0.035);
      c.restore();
    } else if (a.carry) {
      c.beginPath(); c.moveTo(-0.18, 0); c.lineTo(-0.1, -0.22); c.moveTo(0.18, 0); c.lineTo(0.1, -0.22); c.stroke();
      c.fillStyle = shade(T.acc, 0.95); rr(c, -0.17, -0.42, 0.34, 0.26, 0.05); c.fill(); c.strokeStyle = 'rgba(0,0,0,0.4)'; c.lineWidth = 0.025; c.stroke();
    } else if (work) {
      var aa = -0.4 + swing * 0.5;
      c.save(); c.rotate(aa);
      c.beginPath(); c.moveTo(0.16, 0); c.lineTo(0.12, -0.3); c.stroke();
      tool(c, T, swing);
      c.restore();
      c.beginPath(); c.moveTo(-0.16, 0); c.lineTo(-0.02, -0.28); c.stroke();
    } else {
      c.beginPath(); c.moveTo(-0.19, 0); c.lineTo(-0.2, -sw * 0.8 - 0.05); c.moveTo(0.19, 0); c.lineTo(0.2, sw * 0.8 - 0.05); c.stroke();
    }
    // плечи (спецовка) и каска
    // спецовка: рабочий — серо-синяя, бригадир — тёмно-красная, техник — оранжевая, охрана — тёмная броня с красной полосой;
    // каска — жёлтая, белая, синяя, у охраны — стальной шлем
    var LOOK = { h: ['#4b5f73', '#7a90a6', '#d9a940', '#c98f2a', '#ffe08a', '#d99a2a'],
                 f: ['#5a2a26', '#94443a', '#e8ecef', '#aab4bd', '#ffffff', '#c5ced6'],
                 t: ['#7a4a1c', '#c47a32', '#8fd3ff', '#2f6aa8', '#9fd2ff', '#3a78bd'],
                 g: ['#2b3440', '#5a6878', '#d94a4a', '#3a4654', '#a7b4c1', '#4d5a68'] }[a.k] || null;
    LOOK = LOOK || ['#4b5f73', '#7a90a6', '#d9a940', '#c98f2a', '#ffe08a', '#d99a2a'];
    var g = c.createLinearGradient(-0.2, 0, 0.2, 0); g.addColorStop(0, LOOK[0]); g.addColorStop(0.5, LOOK[1]); g.addColorStop(1, LOOK[0]);
    c.fillStyle = g; c.beginPath(); c.ellipse(0, 0.02, 0.21, 0.12, 0, 0, TAU); c.fill();
    c.fillStyle = LOOK[2]; c.fillRect(-0.21, 0.0, 0.42, 0.035);              // светоотражающая полоса
    c.fillStyle = LOOK[3]; dot(c, 0, 0.0, 0.115);
    var hg = c.createRadialGradient(-0.03, -0.04, 0.01, 0, 0, 0.12); hg.addColorStop(0, LOOK[4]); hg.addColorStop(1, LOOK[5]);
    c.fillStyle = hg; dot(c, 0, -0.01, 0.1);
    c.fillStyle = '#fff6cc'; dot(c, 0, -0.1, 0.025);                         // фонарь на каске
  }
  function tool(c, T, swing) {
    if (S.kind === 'ore') {
      c.strokeStyle = '#7a5a36'; c.lineWidth = 0.045; c.beginPath(); c.moveTo(0.12, -0.28); c.lineTo(0.12, -0.6); c.stroke();
      c.strokeStyle = '#9aa0a6'; c.lineWidth = 0.05; c.beginPath(); c.moveTo(-0.02, -0.56); c.quadraticCurveTo(0.12, -0.66, 0.27, -0.56); c.stroke();
    } else if (S.kind === 'gas') {
      c.strokeStyle = '#b9c2c1'; c.lineWidth = 0.05; c.beginPath(); c.moveTo(0.12, -0.28); c.lineTo(0.12, -0.52); c.stroke();
      c.strokeStyle = '#d9a940'; c.lineWidth = 0.04; c.beginPath(); c.arc(0.12, -0.56, 0.06, 0, TAU); c.stroke();
    } else if (THEME[S.kind] && THEME[S.kind].fab === 'furnace') {   // кочерга с раскалённым концом
      c.strokeStyle = '#6d737a'; c.lineWidth = 0.045; c.beginPath(); c.moveTo(0.12, -0.28); c.lineTo(0.1, -0.7); c.stroke();
      c.fillStyle = rgba(T.lit, 0.55 + 0.45 * Math.abs(swing)); dot(c, 0.1, -0.72, 0.04);
    } else if (THEME[S.kind] && THEME[S.kind].fab) {                // паяльник / ключ с огоньком
      c.strokeStyle = '#4a4f57'; c.lineWidth = 0.05; c.beginPath(); c.moveTo(0.12, -0.28); c.lineTo(0.12, -0.5); c.stroke();
      c.fillStyle = rgba(T.lit, 0.5 + 0.5 * Math.abs(swing)); dot(c, 0.12, -0.53, 0.035);
    } else if (S.kind === 'crystals') {
      c.strokeStyle = '#4a4f57'; c.lineWidth = 0.06; c.beginPath(); c.moveTo(0.12, -0.28); c.lineTo(0.12, -0.5); c.stroke();
      c.strokeStyle = rgba(T.lit, 0.5 + 0.5 * Math.abs(swing)); c.lineWidth = 0.025; c.beginPath(); c.moveTo(0.12, -0.5); c.lineTo(0.12, -0.72); c.stroke();
    } else {
      c.fillStyle = '#8a6a40'; rr(c, 0.02, -0.5, 0.22, 0.18, 0.04); c.fill();
      c.fillStyle = shade(T.acc, 0.8); dot(c, 0.13, -0.42, 0.06);
    }
  }
  // Дроид-рабочий: корпус с охристой полосой, гусеницы, два манипулятора, сенсор
  function droid(c, a, T, t) {
    var gl = a.role === 'glitch';                          // вирус: стоит, подёргивается, сенсор красный
    if (gl) { var jk = Math.sin(t * 23 + a.ph * 3) > 0.6 ? 1 : 0; c.translate(jk * (Math.random() - 0.5) * 0.05, jk * (Math.random() - 0.5) * 0.05); c.rotate(Math.sin(t * 17 + a.ph) * 0.08 * jk); }
    c.rotate(a.ang + Math.PI / 2);
    c.fillStyle = 'rgba(0,0,0,0.35)'; c.beginPath(); c.ellipse(0.05, 0.08, 0.3, 0.28, 0, 0, TAU); c.fill();
    var tr = (a.ph * 0.15) % 0.1;
    for (var s = -1; s <= 1; s += 2) {
      c.fillStyle = '#26292d'; rr(c, s * 0.2 - 0.06, -0.2, 0.12, 0.4, 0.04); c.fill();
      c.strokeStyle = 'rgba(255,255,255,0.12)'; c.lineWidth = 0.02;
      for (var y = -0.18 + tr * a.mv; y < 0.2; y += 0.1) { c.beginPath(); c.moveTo(s * 0.2 - 0.05, y); c.lineTo(s * 0.2 + 0.05, y); c.stroke(); }
    }
    var work = a.role === 'work' && !a.path && !a.carry, swing = work ? Math.sin(t * 5 + a.ph) : 0;
    c.strokeStyle = '#7d848c'; c.lineWidth = 0.06; c.lineCap = 'round';
    if (a.carry) {
      c.beginPath(); c.moveTo(-0.12, -0.05); c.lineTo(-0.1, -0.28); c.moveTo(0.12, -0.05); c.lineTo(0.1, -0.28); c.stroke();
      c.fillStyle = shade(T.acc, 0.95); rr(c, -0.17, -0.46, 0.34, 0.24, 0.05); c.fill(); c.strokeStyle = 'rgba(0,0,0,0.4)'; c.lineWidth = 0.025; c.stroke();
    } else {
      c.beginPath(); c.moveTo(-0.12, -0.05); c.lineTo(-0.14, -0.3 - swing * 0.08); c.moveTo(0.12, -0.05); c.lineTo(0.14, -0.3 + swing * 0.08); c.stroke();
      c.fillStyle = '#5a6068'; dot(c, -0.14, -0.31 - swing * 0.08, 0.04); dot(c, 0.14, -0.31 + swing * 0.08, 0.04);
      if (work && S.kind !== 'food') { c.fillStyle = rgba(T.lit, 0.4 + 0.4 * Math.abs(swing)); dot(c, 0, -0.38, 0.05); }
    }
    var g = c.createLinearGradient(-0.16, -0.14, 0.16, 0.16); g.addColorStop(0, '#a4abb3'); g.addColorStop(1, '#5e646b');
    c.fillStyle = g; rr(c, -0.16, -0.15, 0.32, 0.3, 0.07); c.fill();
    c.strokeStyle = 'rgba(0,0,0,0.45)'; c.lineWidth = 0.02; c.stroke();
    c.fillStyle = '#c47a32'; c.fillRect(-0.16, 0.02, 0.32, 0.05);
    c.fillStyle = '#3a3f45'; dot(c, 0, -0.05, 0.08);
    if (gl) {
      var on = Math.sin(t * 13 + a.ph) > -0.3;
      if (on) { c.fillStyle = 'rgba(255,59,59,0.28)'; dot(c, 0, -0.1, 0.12); }
      c.fillStyle = on ? '#ff3b3b' : '#6a1a1a'; dot(c, 0, -0.1, 0.034);
    } else { c.fillStyle = '#ff9d3c'; dot(c, 0, -0.1, 0.028); }
  }

  // ---------------------------------------------------------------- жизнь сцены
  function resize() {
    if (!S.box || !S.cv) return;
    var r = S.box.getBoundingClientRect(), cw = Math.max(1, Math.round(r.width)), ch = Math.max(1, Math.round(r.height));
    S.dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (cw === S.cw && ch === S.ch && S.cv.width === Math.round(cw * S.dpr)) return;
    S.cw = cw; S.ch = ch;
    S.cv.width = Math.round(cw * S.dpr); S.cv.height = Math.round(ch * S.dpr);
    S.cv.style.width = cw + 'px'; S.cv.style.height = ch + 'px';
    S.px = Math.min(cw / W, ch / H); S.ox = (cw - W * S.px) / 2; S.oy = (ch - H * S.px) / 2;
    S.bgKey = '';
  }
  function loop(now) {
    if (!S.on) return;
    S.raf = requestAnimationFrame(loop);
    if (document.hidden) { S.last = now; return; }
    var dt = Math.min(0.1, (now - (S.last || now)) / 1000); S.last = now;
    try { resize(); step(dt); draw(); }
    catch (e) {
      if (S.cv) S.cv.width = S.cv.width;                  // сбросить «залипшие» save() и трансформации
      if (!S.err) { S.err = 1; if (window.errReport) errReport(e, 'mine.scene'); }
    }
  }

  root.MNScene = {
    mount: function(box) {
      S.box = box;
      if (!S.cv || S.cv.parentNode !== box) { S.cv = document.createElement('canvas'); S.cv.className = 'mn-cv'; box.insertBefore(S.cv, box.firstChild); S.c = S.cv.getContext('2d'); }
      S.cw = 0; S.agents = []; S.parts = []; S.pops = []; S.rings = []; S.seen = null; S.st = null; S.bg = null; S.bgKey = ''; S.err = 0;
      S.plans = {}; S.boom = {}; S.cur = []; S.escort = null; S.opsErr = 0; S.skew = 0;
      resize();
      if (!S.on) { S.on = true; S.last = 0; S.raf = requestAnimationFrame(loop); }
    },
    set: function(st, at) {
      var first = !S.st;
      var kind = THEME[st && st.res && st.res.id] ? st.res.id : 'ore';
      if (kind !== S.kind) { S.kind = kind; S.bgKey = ''; }
      // новая смена — счёт «+1» заново от того, что уже накопано
      if (!first && S.st && S.st.run && st.run && S.st.run.id !== st.run.id) S.seen = null;
      S.st = st; S.at = at;
      var sn = st && st.now ? Date.parse(st.now) : NaN;
      S.skew = isNaN(sn) ? 0 : sn - at;                    // время сервера: фигурки группы идут по нему
      assign(first);
    },
    stop: function() { S.on = false; if (S.raf) cancelAnimationFrame(S.raf); S.raf = 0; },
    theme: function(id) { return THEME[id] || THEME.ore; }
  };
})(typeof self !== 'undefined' ? self : this);
