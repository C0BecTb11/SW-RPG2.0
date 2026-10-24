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
            st: null, at: 0, kind: 'ore', agents: [], pops: [], parts: [], rings: [], raf: 0, last: 0, t: 0, seen: null, rr: 0, ro: null, on: false };

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
  function counts(st) {
    var run = st.run, out = { h: {}, d: {} };
    ['h', 'd'].forEach(function(k) {
      var tot = k === 'h' ? st.humans : st.droids, on = run ? (k === 'h' ? run.humans : run.droids) : 0, hurt = 0;
      (st.hurt || []).forEach(function(x) { if (x.kind === k) hurt += x.n; });
      hurt = Math.min(hurt, Math.max(0, tot - on));
      var rest = (k === 'h' ? st.rest_h : st.rest_d) ? Math.max(0, tot - on - hurt) : 0;
      out[k] = { tot: tot, on: on, hurt: hurt, rest: rest, free: Math.max(0, tot - on - hurt - rest) };
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
    var spot = 0, R = rng(Date.now() & 0xffff);
    ['h', 'd'].forEach(function(k) {
      var c = cn[k], mine = S.agents.filter(function(a) { return a.k === k; });
      mine.forEach(function(a, j) {
        var role = j < c.on ? 'work' : j < c.on + c.hurt ? 'hurt' : j < c.on + c.hurt + c.rest ? 'rest' : 'free';
        var want = role === 'work' ? spot++ : -1;
        if (a.role === role && a.spot === want) return;
        a.role = role; a.spot = want; a.carry = false;
        var dst = role === 'work' ? stand(sp[want]) : role === 'free' ? yardPoint(R) : BARR.door.slice();
        if (first) {
          a.x = dst[0]; a.y = dst[1]; a.path = null; a.inside = role === 'rest' || role === 'hurt';
          a.ang = role === 'work' ? -Math.PI / 2 : Math.PI / 2;
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

  // ---------------------------------------------------------------- кадр
  function accNow() {
    var r = S.st && S.st.run; if (!r) return null;
    var t1 = new Date(r.ends_at).getTime(), now = Date.now();
    var v = r.accrued + r.rate * Math.max(0, Math.min(now, t1) - S.at) / 3600000;
    return r.cap != null ? Math.min(r.cap, v) : v;
  }
  function step(dt) {
    S.t += dt;
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
        var p = a.path[0], dx = p[0] - a.x, dy = p[1] - a.y, d = Math.sqrt(dx * dx + dy * dy), sp = (a.k !== 'd' ? 2.3 : 2.0) * (a.carry ? 0.85 : 1);
        if (d < 0.05) { a.path.shift(); if (!a.path.length) arrive(a); }
        else { var k = Math.min(1, sp * dt / d); a.x += dx * k; a.y += dy * k; a.ang = Math.atan2(dy, dx); a.mv = Math.min(1, a.mv + dt * 6); }
      } else {
        a.mv = Math.max(0, a.mv - dt * 6);
        if (a.role === 'free' && Math.random() < dt * 0.12) a.path = [yardPoint(Math.random)];
        if (a.role === 'work') a.ang = -Math.PI / 2;
      }
      if (a.k === 'f' || a.k === 't') { staffStep(a, dt); return; }
      // у забоя: добыча и вскрыша — искры, обслуживание — сварка, разведка — импульс сканера
      if (a.role === 'work' && !a.path && !a.carry) {
        var task = S.st.run && S.st.run.task || 'extract';
        if (task === 'maint') { if (Math.random() < dt * 3) spark(a.x, a.y - 0.85, '#8fd3ff'); }
        else if (task === 'survey') { if (Math.random() < dt * 0.35) S.rings.push({ x: a.x, y: a.y - 0.9, t: 0 }); }
        else if (S.kind !== 'food' && Math.random() < dt * (S.kind === 'gas' ? 1.5 : 4) * (task === 'prep' ? 1.6 : 1)) spark(a.x, a.y - 0.9, task === 'prep' ? '#a99b8a' : null);
      }
    });
    // износ: чем сильнее, тем чаще дымят установки
    var wear = S.st.wear || 0;
    if (wear >= 25) {
      var sp2 = spots(S.st.places);
      if (Math.random() < dt * (wear - 15) / 25) { var w0 = sp2[Math.floor(Math.random() * sp2.length)]; S.parts.push({ x: w0.x + (Math.random() - 0.5) * 0.5, y: w0.y - 0.3, vx: (Math.random() - 0.5) * 0.15, vy: -0.35 - Math.random() * 0.2, t: 0, life: 2.2 + Math.random(), sm: 1, col: wear >= 60 ? '#3a3633' : '#77736e' }); }
    }
    for (var r0 = S.rings.length - 1; r0 >= 0; r0--) { S.rings[r0].t += dt; if (S.rings[r0].t > 1.4) S.rings.splice(r0, 1); }
    // свободные во дворе не стоят друг в друге
    var yard = S.agents.filter(function(a) { return a.role === 'free' && !a.inside && !a.path; });
    for (var p1 = 0; p1 < yard.length; p1++) for (var p2 = p1 + 1; p2 < yard.length; p2++) {
      var u = yard[p1], v = yard[p2], ddx = v.x - u.x, ddy = v.y - u.y, dd = Math.sqrt(ddx * ddx + ddy * ddy) || 0.01;
      if (dd < 0.75) { var push = (0.75 - dd) * 0.5; u.x -= ddx / dd * push; u.y -= ddy / dd * push; v.x += ddx / dd * push; v.y += ddy / dd * push; }
    }
    yard.forEach(function(a) { a.x = Math.max(YARD[0] + 0.3, Math.min(YARD[2] - 0.3, a.x)); a.y = Math.max(YARD[1] + 0.1, Math.min(YARD[3] - 0.1, a.y)); });
    for (var j = S.parts.length - 1; j >= 0; j--) { var q = S.parts[j]; q.t += dt; q.x += q.vx * dt; q.y += q.vy * dt; if (!q.sm) q.vy += 1.4 * dt; if (q.t > q.life) S.parts.splice(j, 1); }
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
    // рабочие: по глубине
    var vis = S.agents.filter(function(a) { return !a.inside; }).sort(function(a, b) { return a.y - b.y; });
    vis.forEach(function(a) { c.save(); c.translate(a.x, a.y); c.scale(FIGK, FIGK); if (a.k === 'd') droid(c, a, T, t); else human(c, a, T, t); c.restore(); });
    S.parts.forEach(function(q) {
      var f = q.t / q.life;
      if (q.sm) { c.fillStyle = rgba(q.col, 0.32 * (1 - f) * Math.min(1, f * 5)); dot(c, q.x, q.y, 0.18 + f * 0.45); }
      else { c.fillStyle = rgba(q.col.charAt(0) === '#' ? q.col : '#ffffff', Math.max(0, 1 - f)); dot(c, q.x, q.y, 0.045); }
    });
    S.rings.forEach(function(r) { var k = r.t / 1.4; c.strokeStyle = 'rgba(143,211,255,' + (0.6 * (1 - k)) + ')'; c.lineWidth = 0.05; c.beginPath(); c.arc(r.x, r.y, 0.2 + k * 1.3, 0, TAU); c.stroke(); });
    labels(c, T, st);
    S.pops.forEach(function(p) {
      var k = p.t / 1.6; c.save(); c.globalAlpha = Math.max(0, 1 - k * k);
      text(c, '+1', p.x, p.y - 0.4 - k * 1.1, 0.55, T.lit, 'bold');
      c.restore();
    });
  }
  // по ленте идёт сырьё: из приёмки вверх и вдоль ряда мест, пока смена перерабатывает взятое
  function beltLoad(c, T, st, t) {
    var r = st.run, acc = accNow();
    if (!r || !r.input || (r.task !== 'extract' && r.task !== 'prep') || (r.cap != null && acc != null && acc >= r.cap - 0.001)) return;
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
    var cn = counts(st), inH = cn.h.rest + cn.h.hurt, inD = cn.d.rest + cn.d.hurt, now = Date.now();
    var parts = [];
    if (cn.h.rest || cn.d.rest) {
      var until = Math.max(st.rest_h ? new Date(st.rest_h).getTime() : 0, st.rest_d ? new Date(st.rest_d).getTime() : 0), m = Math.max(0, Math.ceil((until - now) / 60000));
      parts.push('отдых ' + (cn.h.rest + cn.d.rest) + (m ? ' · ' + (m >= 60 ? Math.floor(m / 60) + ' ч ' + (m % 60) + ' м' : m + ' мин') : ''));
    }
    if (cn.h.hurt || cn.d.hurt) parts.push('выбыли ' + (cn.h.hurt + cn.d.hurt));
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
    // спецовка: рабочий — серо-синяя, бригадир — тёмно-красная, техник — оранжевая; каска — жёлтая, белая, синяя
    var LOOK = { h: ['#4b5f73', '#7a90a6', '#d9a940', '#c98f2a', '#ffe08a', '#d99a2a'],
                 f: ['#5a2a26', '#94443a', '#e8ecef', '#aab4bd', '#ffffff', '#c5ced6'],
                 t: ['#7a4a1c', '#c47a32', '#8fd3ff', '#2f6aa8', '#9fd2ff', '#3a78bd'] }[a.k] || null;
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
    c.fillStyle = '#ff9d3c'; dot(c, 0, -0.1, 0.028);
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
    catch (e) { if (!S.err) { S.err = 1; if (window.errReport) errReport(e, 'mine.scene'); } }
  }

  root.MNScene = {
    mount: function(box) {
      S.box = box;
      if (!S.cv || S.cv.parentNode !== box) { S.cv = document.createElement('canvas'); S.cv.className = 'mn-cv'; box.insertBefore(S.cv, box.firstChild); S.c = S.cv.getContext('2d'); }
      S.cw = 0; S.agents = []; S.parts = []; S.pops = []; S.rings = []; S.seen = null; S.st = null; S.bg = null; S.bgKey = ''; S.err = 0;
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
      assign(first);
    },
    stop: function() { S.on = false; if (S.raf) cancelAnimationFrame(S.raf); S.raf = 0; },
    theme: function(id) { return THEME[id] || THEME.ore; }
  };
})(typeof self !== 'undefined' ? self : this);
