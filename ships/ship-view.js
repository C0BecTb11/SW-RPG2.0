// Корабли 2.0 — просмотр корабля снаружи и изнутри.
// Издалека корабль такой же, как на космической карте (тот же спрайт);
// при приближении корпус «срезается» и видны отсеки, коридоры, двери,
// техника и экипаж. Масштаб честный: клетка = 2 м, длина по канону.
// ES5, без сборки.

(function() {
  'use strict';

  var S = window.SWRT, F = window.SWRTFig, SH = window.SWShip, K = SH.K;
  var TAU = Math.PI * 2, CH = 32;

  var LIST = [
    { id: 'venator', short: 'Венатор' },
    { id: 'acclamator', short: 'Акламатор' },
    { id: 'munificent', short: 'Щедрый' },
    { id: 'providence', short: 'Провиденс' }
  ];

  // ---------- палитры ----------
  // Республика — светлые переборки, синие и красные метки; КНС — бронза и
  // тёмный металл, синие огни. Пол отсека тонирован по его назначению.
  var PAL = {
    republic: {
      wall: '#c3c9d1', wallTop: '#e6eaef', wallEdge: '#4a525c', corridor: '#666e78', plate: 'rgba(28,32,38,0.93)', corridorLine: 'rgba(230,236,242,0.35)',
      accent: '#c0453a', light: '#9fd0ff', door: '#8b939c', doorLight: '#7fe08a', tech: 'rgba(6,9,14,0.55)',
      floor: {
        hangar: '#565d66', bridge: '#2b405c', flight: '#2b405c', cic: '#2e3f5a', gun: '#5d4640', pdgun: '#5a4642',
        reactor: '#5f5130', shield: '#2c5560', engine: '#544a40', hyper: '#463e5e', quarters: '#555d54', troops: '#525a52',
        mess: '#5c5b4c', medbay: '#3d5f59', armory: '#5d4b4b', storage: '#5a5548', hold: '#5a5548', workshop: '#5a5848',
        airlock: '#4a4e57', dock: '#4c5562', comms: '#33506a', observe: '#2b405c', vehicle: '#535a63', droids: '#585042'
      }
    },
    cis: {
      wall: '#8b8170', wallTop: '#b3a68e', wallEdge: '#2f2a23', corridor: '#4f4b45', plate: 'rgba(26,24,22,0.93)', corridorLine: 'rgba(110,160,230,0.35)',
      accent: '#3d74d6', light: '#7fb3ff', door: '#6c655a', doorLight: '#e3a24a', tech: 'rgba(8,8,10,0.6)',
      floor: {
        hangar: '#4a4741', bridge: '#2a3446', flight: '#2a3446', cic: '#2c3344', gun: '#54403a', pdgun: '#523f3a',
        reactor: '#58492a', shield: '#284650', engine: '#4a4038', hyper: '#3e3550', quarters: '#4b4c44', troops: '#4a4b44',
        mess: '#504d40', medbay: '#344c48', armory: '#504141', storage: '#4f4a3f', hold: '#4c473c', workshop: '#4f4c3e',
        airlock: '#40424a', dock: '#424852', comms: '#2c4258', observe: '#2a3446', vehicle: '#474b52', droids: '#4d4537'
      }
    }
  };

  // ---------- состояние ----------
  var V = { ship: null, map: null, img: null, pal: null, flows: null, crew: [], sel: null, labels: true, cache: {} };
  var CV = document.getElementById('sv-canvas'), CTX = CV.getContext('2d');
  var CAM = { x: 0, y: 0, s: 2, vw: 0, vh: 0, dpr: 1 };
  var $ = function(id) { return document.getElementById(id); };

  // ---------- загрузка ----------
  function open(id) {
    toast('Загружаю ' + nameOf(id) + '…');
    var tasks = [];
    if (!V.cache[id]) {
      tasks.push(fetch('../shared/ships/' + id + '.json?v=1').then(function(r) {
        if (!r.ok) throw new Error('план не найден'); return r.json();
      }).then(function(d) { V.cache[id] = { data: d }; }));
    }
    Promise.all(tasks).then(function() {
      var c = V.cache[id];
      if (!c.ship) c.ship = SH.load(c.data);
      return loadImg('../' + c.ship.sprite).then(function(img) { c.img = img; return c; });
    }).then(function(c) {
      V.ship = c.ship; V.img = c.img; V.pal = PAL[V.ship.faction] || PAL.republic;
      if (!c.clip) c.clip = makeClip(c.ship, c.img);
      V.clip = c.clip;
      V.map = SH.rtMap(V.ship, S);
      V.flows = new S.FlowCache(V.map, 24);
      V.sel = null;
      CHUNKS.clear();
      makeCrew();
      fit();
      hud();
      try { localStorage.setItem('sv-ship', id); } catch (e) {}
      $('sv-toast').className = 'sv-toast';
    }).catch(function(e) { toast('Не загрузилось: ' + e.message, true); });
  }
  // Корпус для разреза: спрайт без дыр. Прозрачные пятна внутри силуэта
  // (бывают в спрайтах) заливаются тёмным металлом по плану отсеков.
  function makeClip(sh, img) {
    var cw = sh.crop[2] - sh.crop[0], chh = sh.crop[3] - sh.crop[1];
    var m = document.createElement('canvas'); m.width = sh.w; m.height = sh.h;
    var mc = m.getContext('2d'), id = mc.createImageData(sh.w, sh.h), d = id.data;
    for (var i = 0, n = sh.w * sh.h; i < n; i++) {
      var k = sh.kind[i];
      if (k !== K.VOID && k !== K.HULL) { d[i * 4] = 58; d[i * 4 + 1] = 61; d[i * 4 + 2] = 66; d[i * 4 + 3] = 255; }
    }
    mc.putImageData(id, 0, 0);
    var cv = document.createElement('canvas'); cv.width = cw; cv.height = chh;
    var c = cv.getContext('2d');
    c.drawImage(m, 0, 0, cw, chh);
    c.drawImage(img, sh.crop[0], sh.crop[1], cw, chh, 0, 0, cw, chh);
    return cv;
  }
  function nameOf(id) { for (var i = 0; i < LIST.length; i++) if (LIST[i].id === id) return LIST[i].short; return id; }
  function loadImg(src) {
    return new Promise(function(res, rej) {
      var im = new Image(); im.onload = function() { res(im); }; im.onerror = function() { rej(new Error('нет картинки корабля')); };
      im.src = src;
    });
  }

  // ---------- камера ----------
  function resize() {
    CAM.dpr = Math.min(window.devicePixelRatio || 1, 2);
    CAM.vw = window.innerWidth; CAM.vh = window.innerHeight;
    CV.width = Math.round(CAM.vw * CAM.dpr); CV.height = Math.round(CAM.vh * CAM.dpr);
    CV.style.width = CAM.vw + 'px'; CV.style.height = CAM.vh + 'px';
    clamp();
  }
  function minS() {
    if (!V.ship) return 1;
    var top = $('sv-top').getBoundingClientRect().bottom + 8, bot = CAM.vh - $('sv-bottom').getBoundingClientRect().top + 8;
    return Math.min((CAM.vw - 24) / V.ship.w, (CAM.vh - top - bot) / V.ship.h);
  }
  function maxS() { return 64; }
  function fit() {
    var top = $('sv-top').getBoundingClientRect().bottom + 8, bot = CAM.vh - $('sv-bottom').getBoundingClientRect().top + 8;
    CAM.s = minS(); CAM.x = V.ship.w / 2; CAM.y = V.ship.h / 2 - (top - bot) / 2 / CAM.s;
  }
  function clamp() {
    if (!V.ship) return;
    CAM.s = Math.max(minS() * 0.9, Math.min(maxS(), CAM.s));
    var m = 40 / CAM.s;
    CAM.x = Math.max(-m, Math.min(V.ship.w + m, CAM.x));
    CAM.y = Math.max(-m - 200 / CAM.s, Math.min(V.ship.h + m + 200 / CAM.s, CAM.y));
  }
  function toScreen(x, y) { return [(x - CAM.x) * CAM.s + CAM.vw / 2, (y - CAM.y) * CAM.s + CAM.vh / 2]; }
  function toWorld(px, py) { return [(px - CAM.vw / 2) / CAM.s + CAM.x, (py - CAM.vh / 2) / CAM.s + CAM.y]; }
  var FLY = null;
  function flyTo(x, y, s) { FLY = { x0: CAM.x, y0: CAM.y, s0: CAM.s, x1: x, y1: y, s1: s, t: 0 }; }

  // Доля «разреза»: издалека — корпус, вблизи — отсеки
  function cut() { return Math.max(0, Math.min(1, (CAM.s - 2.4) / 2.6)); }

  // ---------- куски отсеков ----------
  var CHUNKS = new Map(), CHUNK_MAX = { 4: 120, 8: 48, 16: 16, 32: 8 }, BUILD = { left: 2 };
  function tierFor(s) { return s < 5 ? 4 : s < 12 ? 8 : s < 26 ? 16 : 32; }

  function hash(x, y) {
    var h = (x * 374761393 + y * 668265263) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  function getChunk(cx, cy, tp) {
    var key = tp + ':' + cx + ':' + cy, ch = CHUNKS.get(key);
    if (ch) { CHUNKS.delete(key); CHUNKS.set(key, ch); return ch; }
    if (BUILD.left <= 0) {
      var alt = CHUNKS.get((tp === 32 ? 16 : tp === 16 ? 8 : 4) + ':' + cx + ':' + cy) || CHUNKS.get('8:' + cx + ':' + cy) || CHUNKS.get('4:' + cx + ':' + cy);
      if (alt) return alt;
      if (tp !== 4) return getChunk(cx, cy, 4);
    }
    BUILD.left--;
    ch = buildChunk(cx, cy, tp);
    CHUNKS.set(key, ch);
    var n = 0; CHUNKS.forEach(function(v) { if (v.tp === tp) n++; });
    if (n > CHUNK_MAX[tp]) { for (var k of CHUNKS.keys()) { if (CHUNKS.get(k).tp === tp) { CHUNKS.delete(k); break; } } }
    return ch;
  }

  function buildChunk(cx, cy, tp) {
    var sh = V.ship, P = V.pal, cv = document.createElement('canvas');
    cv.width = cv.height = CH * tp;
    var c = cv.getContext('2d'), x0 = cx * CH, y0 = cy * CH, x, y, i, k;
    var w = sh.w, crop = sh.crop, sx = (crop[2] - crop[0]) / sh.w, sy = (crop[3] - crop[1]) / sh.h;
    // 1. техпространство — тот же корпус со спрайта, притушенный
    c.imageSmoothingEnabled = true;
    c.drawImage(V.clip, x0 * sx, y0 * sy, CH * sx, CH * sy, 0, 0, CH * tp, CH * tp);
    c.globalCompositeOperation = 'source-atop';
    c.fillStyle = tp >= 8 ? P.plate : P.tech; c.fillRect(0, 0, CH * tp, CH * tp);
    if (tp >= 8) {
      // техпространство вблизи — тёмные плиты с заклёпками, а не размытый спрайт
      c.fillStyle = 'rgba(255,255,255,0.035)';
      for (y = 0; y < CH; y += 4) for (x = (y >> 2) % 2 * 2; x < CH; x += 4) c.fillRect(x * tp, y * tp, tp * 2, tp * 2);
    }
    c.globalCompositeOperation = 'source-over';
    // трубы и кабели по техпространству — только вблизи
    if (tp >= 8) {
      c.strokeStyle = 'rgba(0,0,0,0.35)'; c.lineWidth = Math.max(1, tp * 0.18);
      c.beginPath();
      for (y = 0; y < CH; y += 3) {
        for (x = 0; x < CH; x++) {
          var gx = x0 + x, gy = y0 + y;
          if (gx >= sh.w || gy >= sh.h || sh.kind[gy * w + gx] !== K.TECH) continue;
          if (hash(gx >> 3, gy) < 0.55) { c.moveTo(x * tp, (y + 0.5) * tp); c.lineTo((x + 1) * tp, (y + 0.5) * tp); }
        }
      }
      c.stroke();
    }
    // 2. пол отсеков и коридоров
    for (y = 0; y < CH; y++) {
      for (x = 0; x < CH; x++) {
        var gx2 = x0 + x, gy2 = y0 + y;
        if (gx2 >= sh.w || gy2 >= sh.h) continue;
        i = gy2 * w + gx2; k = sh.kind[i];
        if (k !== K.FLOOR && k !== K.DOOR) continue;
        var r = sh.room[i] ? sh.roomByN[sh.room[i]] : null;
        c.fillStyle = r ? (P.floor[r.t] || P.corridor) : P.corridor;
        c.fillRect(x * tp, y * tp, tp, tp);
      }
    }
    // плиты пола 4×4 м и полосы коридоров
    if (tp >= 8) {
      c.strokeStyle = 'rgba(0,0,0,0.11)'; c.lineWidth = 1;
      c.beginPath();
      for (y = 0; y < CH; y++) for (x = 0; x < CH; x++) {
        var gx3 = x0 + x, gy3 = y0 + y;
        if (gx3 >= sh.w || gy3 >= sh.h) continue;
        i = gy3 * w + gx3;
        if (sh.kind[i] !== K.FLOOR) continue;
        if (gx3 % 2 === 0) { c.moveTo(x * tp + 0.5, y * tp); c.lineTo(x * tp + 0.5, (y + 1) * tp); }
        if (gy3 % 2 === 0) { c.moveTo(x * tp, y * tp + 0.5); c.lineTo((x + 1) * tp, y * tp + 0.5); }
      }
      c.stroke();
      // коридор: светлая разметка по оси
      c.fillStyle = P.corridorLine;
      for (y = 0; y < CH; y++) for (x = 0; x < CH; x++) {
        var gx4 = x0 + x, gy4 = y0 + y;
        if (gx4 >= sh.w || gy4 >= sh.h) continue;
        i = gy4 * w + gx4;
        if (sh.kind[i] !== K.FLOOR || sh.room[i]) continue;
        var hz = isCorr(gx4 - 1, gy4) && isCorr(gx4 + 1, gy4), vt = isCorr(gx4, gy4 - 1) && isCorr(gx4, gy4 + 1);
        var wallN = !isCorr(gx4, gy4 - 1), wallW = !isCorr(gx4 - 1, gy4);
        if (wallN && hz && (gx4 % 4 < 2)) c.fillRect(x * tp, y * tp + tp * 0.08, tp, tp * 0.1);
        if (wallW && vt && (gy4 % 4 < 2)) c.fillRect(x * tp + tp * 0.08, y * tp, tp * 0.1, tp);
      }
    }
    // 3. переборки: стены отсеков и края техпространства вдоль коридоров —
    // сплошной лентой; тёмная кромка только со стороны пола
    var wallish = function(gx, gy) {
      if (gx < 0 || gy < 0 || gx >= sh.w || gy >= sh.h) return false;
      var kk = sh.kind[gy * w + gx];
      if (kk === K.WALL) return true;
      if (kk !== K.TECH && kk !== K.HULL) return false;
      return isOpen(gx - 1, gy) || isOpen(gx + 1, gy) || isOpen(gx, gy - 1) || isOpen(gx, gy + 1);
    };
    var lw = Math.max(1, tp * 0.14);
    for (y = 0; y < CH; y++) {
      for (x = 0; x < CH; x++) {
        var gx5 = x0 + x, gy5 = y0 + y;
        if (gx5 >= sh.w || gy5 >= sh.h || !wallish(gx5, gy5)) continue;
        c.fillStyle = P.wall; c.fillRect(x * tp, y * tp, tp, tp);
        c.fillStyle = P.wallEdge;
        if (isOpen(gx5, gy5 - 1)) c.fillRect(x * tp, y * tp, tp, lw);
        if (isOpen(gx5, gy5 + 1)) c.fillRect(x * tp, (y + 1) * tp - lw, tp, lw);
        if (isOpen(gx5 - 1, gy5)) c.fillRect(x * tp, y * tp, lw, tp);
        if (isOpen(gx5 + 1, gy5)) c.fillRect((x + 1) * tp - lw, y * tp, lw, tp);
        if (tp >= 8 && !wallish(gx5, gy5 - 1) && !isOpen(gx5, gy5 - 1)) { c.fillStyle = P.wallTop; c.fillRect(x * tp, y * tp, tp, tp * 0.2); }
      }
    }
    // 4. двери
    for (i = 0; i < sh.doors.length; i++) {
      var d = sh.doors[i];
      if (d.x < x0 - 2 || d.y < y0 - 2 || d.x >= x0 + CH + 2 || d.y >= y0 + CH + 2) continue;
      drawDoor(c, d, (d.x - x0) * tp, (d.y - y0) * tp, tp);
    }
    // 5. техника и мебель
    for (i = 0; i < sh.props.length; i++) {
      var p = sh.props[i];
      if (p.x + p.w < x0 || p.y + p.h < y0 || p.x > x0 + CH || p.y > y0 + CH) continue;
      c.save(); c.translate((p.x - x0) * tp, (p.y - y0) * tp);
      drawProp(c, p, tp);
      c.restore();
    }
    // 6. обшивка поверх — чистый край корпуса
    c.globalCompositeOperation = 'destination-in';
    c.drawImage(V.clip, x0 * sx, y0 * sy, CH * sx, CH * sy, 0, 0, CH * tp, CH * tp);
    c.globalCompositeOperation = 'source-over';
    return { cv: cv, tp: tp };
  }

  function isOpen(x, y) {
    var sh = V.ship;
    if (x < 0 || y < 0 || x >= sh.w || y >= sh.h) return false;
    var k = sh.kind[y * sh.w + x];
    return k === K.FLOOR || k === K.DOOR;
  }
  function isCorr(x, y) {
    var sh = V.ship;
    if (x < 0 || y < 0 || x >= sh.w || y >= sh.h) return false;
    var i = y * sh.w + x;
    return (sh.kind[i] === K.FLOOR || sh.kind[i] === K.DOOR) && !sh.room[i];
  }

  function drawDoor(c, d, px, py, tp) {
    var P = V.pal, len = (d.w || 2) * tp, deep = (d.d === 2 ? 2 : 1) * tp;
    var w = d.v ? deep : len, h = d.v ? len : deep;
    c.fillStyle = P.door; c.fillRect(px, py, w, h);
    c.fillStyle = 'rgba(0,0,0,0.35)';
    if (d.v) { c.fillRect(px + w / 2 - tp * 0.06, py, tp * 0.12, h); }
    else { c.fillRect(px, py + h / 2 - tp * 0.06, w, tp * 0.12); }
    // створки разъехались — щель посередине, огоньки по краям проёма
    if (tp >= 8) {
      c.fillStyle = P.doorLight;
      var r = Math.max(1, tp * 0.12);
      if (d.v) { c.fillRect(px + w / 2 - r / 2, py + tp * 0.1, r, r); c.fillRect(px + w / 2 - r / 2, py + h - tp * 0.1 - r, r, r); }
      else { c.fillRect(px + tp * 0.1, py + h / 2 - r / 2, r, r); c.fillRect(px + w - tp * 0.1 - r, py + h / 2 - r / 2, r, r); }
    }
  }

  // ---------- рисунки техники и мебели (сверху) ----------
  function rr(c, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    c.beginPath(); c.moveTo(x + r, y); c.lineTo(x + w - r, y); c.quadraticCurveTo(x + w, y, x + w, y + r);
    c.lineTo(x + w, y + h - r); c.quadraticCurveTo(x + w, y + h, x + w - r, y + h); c.lineTo(x + r, y + h);
    c.quadraticCurveTo(x, y + h, x, y + h - r); c.lineTo(x, y + r); c.quadraticCurveTo(x, y, x + r, y); c.closePath();
  }
  function disc(c, x, y, r) { c.beginPath(); c.arc(x, y, r, 0, TAU); c.fill(); }
  function glow(c, x, y, r, col) {
    var g = c.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, col); g.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = g; disc(c, x, y, r);
  }

  function drawProp(c, p, tp) {
    var P = V.pal, W = p.w * tp, H = p.h * tp, rep = V.ship.faction === 'republic';
    var shade = 'rgba(0,0,0,0.35)';
    switch (p.t) {
      case 'laat': return craft(c, W, H, tp, 'laat', p.a);
      case 'vulture': return craft(c, W, H, tp, 'vulture', p.a);
      case 'shuttle': return craft(c, W, H, tp, 'shuttle', 0);
      case 'atte': case 'aat': return vehicle(c, W, H, tp, p.t);
      case 'bunk':
        c.fillStyle = shade; c.fillRect(tp * 0.2, tp * 0.2, W, H);
        c.fillStyle = rep ? '#9aa3ad' : '#76705f'; rr(c, 0, 0, W, H, tp * 0.2); c.fill();
        c.fillStyle = rep ? '#d6dbe1' : '#a49a85'; rr(c, tp * 0.15, tp * 0.15, W - tp * 0.3, H / 2 - tp * 0.2, tp * 0.15); c.fill();
        c.fillRect(tp * 0.15, H / 2 + tp * 0.05, W - tp * 0.3, H / 2 - tp * 0.2);
        c.fillStyle = rep ? '#eef1f4' : '#c3b79e'; c.fillRect(tp * 0.2, tp * 0.2, tp * 0.6, H / 2 - tp * 0.3);
        return;
      case 'table':
        c.fillStyle = shade; c.fillRect(tp * 0.2, tp * 0.2, W, H);
        c.fillStyle = rep ? '#a8b0b9' : '#80786a'; rr(c, 0, 0, W, H, tp * 0.3); c.fill();
        c.fillStyle = 'rgba(0,0,0,0.25)';
        for (var s = tp * 0.6; s < W - tp * 0.4; s += tp) { disc(c, s, -tp * 0.3, tp * 0.22); disc(c, s, H + tp * 0.3, tp * 0.22); }
        return;
      case 'bed':
        c.fillStyle = '#c9d3d6'; rr(c, 0, 0, W, H, tp * 0.25); c.fill();
        c.fillStyle = '#7fbfb3'; c.fillRect(tp * 0.15, H * 0.3, W - tp * 0.3, H * 0.6);
        c.fillStyle = '#eef3f4'; c.fillRect(tp * 0.2, tp * 0.15, W - tp * 0.4, H * 0.18);
        return;
      case 'bacta':
        glow(c, W / 2, H / 2, W * 0.75, 'rgba(90,220,210,0.45)');
        c.fillStyle = '#2a3b40'; disc(c, W / 2, H / 2, W * 0.46);
        c.fillStyle = 'rgba(120,240,225,0.85)'; disc(c, W / 2, H / 2, W * 0.34);
        return;
      case 'crates':
        for (var cx = 0; cx < p.w; cx++) for (var cy = 0; cy < p.h; cy++) {
          var hh = hash(p.x + cx, p.y + cy);
          if (hh < 0.18) continue;
          c.fillStyle = shade; c.fillRect(cx * tp + tp * 0.18, cy * tp + tp * 0.18, tp * 0.9, tp * 0.9);
          c.fillStyle = rep ? (hh < 0.6 ? '#8e8a7a' : '#a7a18c') : (hh < 0.6 ? '#6d6350' : '#857a62');
          c.fillRect(cx * tp + tp * 0.06, cy * tp + tp * 0.06, tp * 0.88, tp * 0.88);
          if (tp >= 8) { c.strokeStyle = 'rgba(0,0,0,0.35)'; c.lineWidth = 1; c.strokeRect(cx * tp + tp * 0.18, cy * tp + tp * 0.18, tp * 0.64, tp * 0.64); }
        }
        return;
      case 'console': {
        var f = p.f || 0;
        c.fillStyle = '#20262e'; rr(c, 0, 0, W, H, tp * 0.2); c.fill();
        c.fillStyle = P.light; c.globalAlpha = 0.75;
        c.fillRect(tp * 0.2, f === 0 ? H * 0.55 : H * 0.15, W - tp * 0.4, H * 0.3);
        c.globalAlpha = 1;
        return;
      }
      case 'holotable':
        c.fillStyle = '#1b2129'; disc(c, W / 2, H / 2, W * 0.5);
        glow(c, W / 2, H / 2, W * 0.9, rep ? 'rgba(120,190,255,0.5)' : 'rgba(255,170,90,0.45)');
        c.strokeStyle = rep ? 'rgba(170,215,255,0.9)' : 'rgba(255,200,140,0.9)'; c.lineWidth = Math.max(1, tp * 0.1);
        c.beginPath(); c.arc(W / 2, H / 2, W * 0.3, 0, TAU); c.stroke();
        return;
      case 'turret_base': {
        // помещение под башней: поворотный погон с метками, механизм наводки,
        // казённики двух стволов и лотки подачи
        var cxp = W / 2, cyp = H / 2, R = Math.min(W, H) / 2;
        c.fillStyle = shade; disc(c, cxp + tp * 0.4, cyp + tp * 0.4, R);
        c.fillStyle = rep ? '#7e868f' : '#5e564a'; disc(c, cxp, cyp, R);
        c.fillStyle = rep ? '#5a6169' : '#463f35'; disc(c, cxp, cyp, R * 0.86);
        c.strokeStyle = rep ? '#b9c0c8' : '#8e8370'; c.lineWidth = Math.max(1, tp * 0.12);
        c.beginPath();
        for (var a = 0; a < 36; a++) {
          var an = a / 36 * TAU, r1 = R * 0.88, r2 = R * (a % 3 ? 0.94 : 0.98);
          c.moveTo(cxp + Math.cos(an) * r1, cyp + Math.sin(an) * r1); c.lineTo(cxp + Math.cos(an) * r2, cyp + Math.sin(an) * r2);
        }
        c.stroke();
        c.fillStyle = '#23272d'; disc(c, cxp, cyp, R * 0.62);
        // лотки подачи к казённикам
        c.fillStyle = rep ? '#9aa1aa' : '#776d5d';
        c.fillRect(cxp - R * 0.5, cyp + R * 0.05, R * 0.22, R * 0.55); c.fillRect(cxp + R * 0.28, cyp + R * 0.05, R * 0.22, R * 0.55);
        // казённики и стволы
        c.fillStyle = rep ? '#c9cfd6' : '#9a8e78'; rr(c, cxp - R * 0.34, cyp - R * 0.3, R * 0.68, R * 0.5, tp * 0.4); c.fill();
        c.fillStyle = '#15181c';
        c.fillRect(cxp - R * 0.2, cyp - R * 0.95, R * 0.12, R * 0.7); c.fillRect(cxp + R * 0.08, cyp - R * 0.95, R * 0.12, R * 0.7);
        c.fillStyle = V.pal.accent; c.fillRect(cxp - R * 0.34, cyp + R * 0.12, R * 0.68, R * 0.06);
        glow(c, cxp, cyp - R * 0.05, R * 0.35, rep ? 'rgba(120,190,255,0.35)' : 'rgba(255,140,80,0.35)');
        return;
      }
      case 'pd_base':
        c.fillStyle = rep ? '#9aa1aa' : '#6f6656'; disc(c, W / 2, H / 2, W * 0.48);
        c.fillStyle = '#262b31'; disc(c, W / 2, H / 2, W * 0.3);
        c.fillStyle = '#14171b'; c.fillRect(W * 0.45, 0, W * 0.1, H * 0.45);
        return;
      case 'reactor_core':
        glow(c, W / 2, H / 2, W * 0.8, 'rgba(255,170,60,0.55)');
        c.fillStyle = '#2b2620'; disc(c, W / 2, H / 2, W * 0.5);
        c.strokeStyle = 'rgba(255,190,90,0.9)'; c.lineWidth = Math.max(1.5, tp * 0.2);
        c.beginPath(); c.arc(W / 2, H / 2, W * 0.4, 0, TAU); c.stroke();
        c.beginPath(); c.arc(W / 2, H / 2, W * 0.26, 0, TAU); c.stroke();
        c.fillStyle = 'rgba(255,235,180,0.95)'; disc(c, W / 2, H / 2, W * 0.13);
        return;
      case 'shield_gen':
        glow(c, W / 2, H / 2, W * 0.75, 'rgba(90,200,255,0.5)');
        c.fillStyle = '#26323a'; disc(c, W / 2, H / 2, W * 0.46);
        c.strokeStyle = 'rgba(140,220,255,0.9)'; c.lineWidth = Math.max(1, tp * 0.15);
        c.beginPath(); c.arc(W / 2, H / 2, W * 0.32, 0, TAU); c.stroke();
        return;
      case 'hyper_core':
        glow(c, W / 2, H / 2, W * 0.8, 'rgba(170,120,255,0.5)');
        c.fillStyle = '#2a2433'; rr(c, 0, 0, W, H, tp * 0.6); c.fill();
        c.fillStyle = 'rgba(200,170,255,0.9)'; rr(c, W * 0.3, H * 0.15, W * 0.4, H * 0.7, tp * 0.4); c.fill();
        return;
      case 'engine_block':
        c.fillStyle = shade; c.fillRect(tp * 0.3, tp * 0.3, W, H);
        c.fillStyle = rep ? '#7d858f' : '#5f574b'; rr(c, 0, 0, W, H, tp * 0.8); c.fill();
        c.fillStyle = '#2a2f36'; rr(c, W * 0.2, H * 0.1, W * 0.6, H * 0.8, tp * 0.6); c.fill();
        glow(c, W / 2, H * 0.85, W * 0.6, rep ? 'rgba(120,190,255,0.55)' : 'rgba(255,150,80,0.5)');
        return;
      case 'droid_rack':
        c.fillStyle = '#2e2a24'; c.fillRect(0, 0, W, H);
        c.fillStyle = '#c9b88c';
        for (var dy = tp * 0.5; dy < H - tp * 0.2; dy += tp) { c.beginPath(); c.ellipse(W / 2, dy, W * 0.32, tp * 0.22, 0, 0, TAU); c.fill(); }
        return;
      case 'bench':
        c.fillStyle = rep ? '#8f969e' : '#6b6456'; c.fillRect(0, 0, W, H);
        c.fillStyle = '#3a4048'; c.fillRect(tp * 0.3, tp * 0.3, W * 0.35, H - tp * 0.6);
        c.fillStyle = P.light; c.globalAlpha = 0.6; c.fillRect(W * 0.6, tp * 0.4, W * 0.3, tp * 0.3); c.globalAlpha = 1;
        return;
      case 'hatch':
        c.fillStyle = '#2a2f36'; disc(c, W / 2, H / 2, W * 0.5);
        c.strokeStyle = '#d9a940'; c.lineWidth = Math.max(1, tp * 0.15); c.setLineDash([tp * 0.4, tp * 0.3]);
        c.beginPath(); c.arc(W / 2, H / 2, W * 0.4, 0, TAU); c.stroke(); c.setLineDash([]);
        return;
      case 'window':
        c.fillStyle = 'rgba(140,190,255,0.25)'; c.fillRect(0, 0, W, H);
        c.fillStyle = 'rgba(200,225,255,0.5)'; c.fillRect(0, 0, W, Math.max(1, H * 0.3));
        return;
      default:
        c.fillStyle = shade; c.fillRect(0, 0, W, H);
    }
  }

  // Малые корабли в ангаре: LAAT, «Стервятник», шаттл — силуэты сверху
  function craft(c, W, H, tp, kind, flip) {
    c.save();
    c.translate(W / 2, H / 2);
    if (flip) c.scale(-1, 1);
    var s = Math.min(W, H) / 2;
    c.fillStyle = 'rgba(0,0,0,0.4)'; c.beginPath(); c.ellipse(s * 0.12, s * 0.12, s * 0.95, s * 0.8, 0, 0, TAU); c.fill();
    if (kind === 'laat') {
      // LAAT/i: корпус-ящик, кабина в носу, крылья с ракетами, кормовой хвост
      c.fillStyle = '#b9c0c8';
      c.beginPath(); c.moveTo(-s * 0.25, -s * 0.95); c.lineTo(s * 0.25, -s * 0.95); c.lineTo(s * 0.35, s * 0.85); c.lineTo(-s * 0.35, s * 0.85); c.closePath(); c.fill();
      c.fillStyle = '#a3abb4'; c.fillRect(-s * 0.95, -s * 0.15, s * 1.9, s * 0.38);
      c.fillStyle = '#7d2a26'; c.fillRect(-s * 0.95, -s * 0.15, s * 0.3, s * 0.38); c.fillRect(s * 0.65, -s * 0.15, s * 0.3, s * 0.38);
      c.fillStyle = '#2a3440'; c.fillRect(-s * 0.15, -s * 0.85, s * 0.3, s * 0.3);
      c.fillStyle = '#6d757e'; c.fillRect(-s * 0.08, s * 0.4, s * 0.16, s * 0.55);
    } else if (kind === 'vulture') {
      // «Стервятник»: голова-кабина в центре, два крыла-ноги вперёд и назад
      c.fillStyle = '#9c917b';
      c.fillRect(-s * 0.9, -s * 0.12, s * 1.8, s * 0.24);
      c.fillRect(-s * 0.9, -s * 0.12, s * 0.22, s * 0.9); c.fillRect(s * 0.68, -s * 0.12, s * 0.22, s * 0.9);
      c.fillRect(-s * 0.9, -s * 0.78, s * 0.22, s * 0.7); c.fillRect(s * 0.68, -s * 0.78, s * 0.22, s * 0.7);
      c.fillStyle = '#c3b694'; c.beginPath(); c.ellipse(0, 0, s * 0.3, s * 0.45, 0, 0, TAU); c.fill();
      c.fillStyle = '#e3a24a'; disc(c, 0, -s * 0.25, s * 0.08);
    } else {
      c.fillStyle = '#c3c9d0';
      c.beginPath(); c.moveTo(0, -s * 0.95); c.lineTo(s * 0.45, s * 0.6); c.lineTo(-s * 0.45, s * 0.6); c.closePath(); c.fill();
      c.fillStyle = '#9aa2ab'; c.fillRect(-s * 0.85, s * 0.2, s * 1.7, s * 0.25);
      c.fillStyle = '#2a3440'; c.fillRect(-s * 0.12, -s * 0.6, s * 0.24, s * 0.3);
    }
    c.restore();
  }

  function vehicle(c, W, H, tp, kind) {
    c.fillStyle = 'rgba(0,0,0,0.4)'; c.fillRect(tp * 0.4, tp * 0.4, W, H);
    if (kind === 'atte') {
      // AT-TE: длинный корпус на шести ногах
      c.fillStyle = '#5e6268';
      for (var i = 0; i < 3; i++) { c.fillRect(W * (0.18 + i * 0.28), 0, W * 0.08, H); }
      c.fillStyle = '#c6ccd2'; rr(c, W * 0.06, H * 0.2, W * 0.88, H * 0.6, tp * 0.4); c.fill();
      c.fillStyle = '#7d2a26'; c.fillRect(W * 0.06, H * 0.45, W * 0.88, H * 0.1);
      c.fillStyle = '#2a3440'; c.fillRect(W * 0.84, H * 0.38, W * 0.1, H * 0.24);
    } else {
      // AAT: танк на репульсорах
      c.fillStyle = '#8e826b'; rr(c, 0, H * 0.1, W, H * 0.8, tp * 0.8); c.fill();
      c.fillStyle = '#6a604f'; disc(c, W * 0.55, H / 2, H * 0.28);
      c.fillStyle = '#2b2a26'; c.fillRect(W * 0.6, H * 0.46, W * 0.4, H * 0.08);
    }
  }

  // ---------- экипаж ----------
  // Сколько народу на каком посту; бродят по отсеку, иногда идут в другой
  var CREW_PER = { bridge: 6, flight: 5, cic: 5, gun: 3, pdgun: 2, reactor: 3, shield: 2, engine: 4, hyper: 2, hangar: 6,
                   quarters: 3, troops: 6, mess: 4, medbay: 3, armory: 2, storage: 1, hold: 1, workshop: 2, airlock: 1,
                   dock: 2, comms: 3, observe: 2, vehicle: 3, droids: 2 };

  function makeCrew() {
    V.crew = [];
    var sh = V.ship, rep = sh.faction === 'republic';
    var types = rep ? [S.TYPE_BY_ID.rep_dc15a, S.TYPE_BY_ID.rep_heavy] : [S.TYPE_BY_ID.cis_b1, S.TYPE_BY_ID.cis_b1, S.TYPE_BY_ID.cis_b2];
    var R = S.rng(sh.w * 31 + sh.h);
    for (var i = 0; i < sh.rooms.length; i++) {
      var r = sh.rooms[i], n = CREW_PER[r.t] || 1;
      for (var k = 0; k < n; k++) {
        var p = freeCellIn(r, R);
        if (!p) break;
        V.crew.push({ x: p[0] + 0.5, y: p[1] + 0.5, home: r.n, room: r.n, tx: p[0] + 0.5, ty: p[1] + 0.5, wait: R() * 4,
                      flow: null, type: types[Math.floor(R() * types.length)], aim: R() * TAU, legs: 0, mv: 0, phase: R() * TAU });
      }
    }
    $('sv-crew').textContent = V.crew.length;
  }

  function freeCellIn(r, R) {
    var sh = V.ship;
    for (var t = 0; t < 40; t++) {
      var x = r.x + 2 + Math.floor(R() * Math.max(1, r.w - 4)), y = r.y + 2 + Math.floor(R() * Math.max(1, r.h - 4));
      var i = y * sh.w + x;
      if (sh.kind[i] === K.FLOOR && !sh.prop[i] && sh.room[i] === r.n) return [x, y];
    }
    return null;
  }

  var CR = S.rng(7);
  function stepCrew(dt) {
    var sh = V.ship, map = V.map, w = sh.w;
    for (var i = 0; i < V.crew.length; i++) {
      var m = V.crew[i];
      if (m.wait > 0) { m.wait -= dt; m.mv += (0 - m.mv) * Math.min(1, dt * 6); continue; }
      var spd = 1.1 * dt, dx, dy, L;
      if (m.flow) {
        // идёт по полю направлений в другой отсек
        var cx = Math.floor(m.x), cy = Math.floor(m.y), d = m.flow.dir[cy * w + cx];
        var gx, gy;
        if (d === 254 || d === 255) { m.flow = null; m.room = m.next; m.wait = 2 + CR() * 6; continue; }
        gx = cx + S.DX[d] + 0.5; gy = cy + S.DY[d] + 0.5;
        dx = gx - m.x; dy = gy - m.y; L = Math.sqrt(dx * dx + dy * dy) || 1;
        m.x += dx / L * Math.min(L, spd * 1.4); m.y += dy / L * Math.min(L, spd * 1.4);
        walk(m, dx, dy, dt);
        continue;
      }
      dx = m.tx - m.x; dy = m.ty - m.y; L = Math.sqrt(dx * dx + dy * dy);
      if (L < 0.08) {
        m.wait = 1 + CR() * 5;
        if (CR() < 0.12) {
          // сменить пост: свой отсек ↔ соседний
          var r2 = CR() < 0.5 ? sh.roomByN[m.home] : sh.rooms[Math.floor(CR() * sh.rooms.length)];
          var p2 = r2 && freeCellIn(r2, CR);
          if (p2 && r2.n !== m.room) { m.flow = V.flows.get(p2[0], p2[1]); m.next = r2.n; continue; }
        }
        var r = sh.roomByN[m.room], p = r && freeCellIn(r, CR);
        if (p && straight(m.x, m.y, p[0] + 0.5, p[1] + 0.5)) { m.tx = p[0] + 0.5; m.ty = p[1] + 0.5; }
        continue;
      }
      var st = Math.min(L, spd);
      m.x += dx / L * st; m.y += dy / L * st;
      walk(m, dx, dy, dt);
    }
  }
  function walk(m, dx, dy, dt) {
    var a = Math.atan2(dy, dx);
    m.legs = S.turn(m.legs, a, 8 * dt); m.aim = S.turn(m.aim, a, 6 * dt);
    m.mv += (1 - m.mv) * Math.min(1, dt * 6);
    m.phase = (m.phase + dt * 7) % TAU;
  }
  // прямая видимость по полу — чтобы не ходить сквозь мебель
  function straight(x0, y0, x1, y1) {
    var sh = V.ship, n = Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) * 2);
    for (var i = 1; i <= n; i++) {
      var x = Math.floor(x0 + (x1 - x0) * i / n), y = Math.floor(y0 + (y1 - y0) * i / n), k = y * sh.w + x;
      if (sh.kind[k] !== K.FLOOR && sh.kind[k] !== K.DOOR) return false;
      if (sh.prop[k]) return false;
    }
    return true;
  }

  // ---------- атлас фигурок (с защитой от «пустого» холста на Android) ----------
  var ATLAS = null, ATLAS_TRIES = 0, SIZES = [56, 44, 36];
  function atlas() {
    if (!ATLAS || (ATLAS.bad && ATLAS_TRIES < SIZES.length)) {
      try { ATLAS = F.bake(S.TYPES, SIZES[Math.min(ATLAS_TRIES, SIZES.length - 1)]); } catch (e) { ATLAS = { bad: true }; }
      ATLAS_TRIES++;
      ATLAS.ok = !!ATLAS.canvas && F.check(ATLAS); ATLAS.bad = !ATLAS.ok; ATLAS.at = performance.now();
    } else if (ATLAS.ok && performance.now() - ATLAS.at > 3000) {
      ATLAS.at = performance.now();
      if (!F.check(ATLAS)) { ATLAS.ok = false; ATLAS.bad = true; }
    }
    return ATLAS;
  }

  // ---------- кадр ----------
  var FR = { last: 0, fps: 60, acc: 0 };
  function frame(t) {
    requestAnimationFrame(frame);
    var dt = FR.last ? Math.min(0.1, (t - FR.last) / 1000) : 0.016;
    FR.fps = FR.fps * 0.95 + (1 / Math.max(0.001, dt)) * 0.05;
    FR.last = t;
    if (!V.ship) return;
    if (FLY) {
      FLY.t = Math.min(1, FLY.t + dt / 0.6);
      var e = 1 - Math.pow(1 - FLY.t, 3);
      CAM.x = FLY.x0 + (FLY.x1 - FLY.x0) * e; CAM.y = FLY.y0 + (FLY.y1 - FLY.y0) * e;
      CAM.s = Math.exp(Math.log(FLY.s0) + (Math.log(FLY.s1) - Math.log(FLY.s0)) * e);
      clamp();
      if (FLY.t >= 1) { FLY = null; hud(); }
    }
    stepCrew(dt);
    draw(t / 1000);
    FR.acc += dt;
    if (FR.acc > 0.5) { FR.acc = 0; $('sv-fps').textContent = Math.round(FR.fps); hudZoom(); }
  }

  function draw(T) {
    var c = CTX, sh = V.ship, s = CAM.s, k = cut();
    c.setTransform(CAM.dpr, 0, 0, CAM.dpr, 0, 0);
    c.clearRect(0, 0, CAM.vw, CAM.vh);
    BUILD.left = 2;
    var o = toScreen(0, 0), crop = sh.crop;
    // корпус снаружи — тот же спрайт, что на космической карте
    if (k < 1) {
      c.globalAlpha = 1;
      c.imageSmoothingEnabled = true;
      c.drawImage(V.img, crop[0], crop[1], crop[2] - crop[0], crop[3] - crop[1], o[0], o[1], sh.w * s, sh.h * s);
    }
    // разрез: отсеки поверх корпуса
    if (k > 0) {
      c.globalAlpha = k;
      var tp = tierFor(s * CAM.dpr / 1.2);
      var a = toWorld(0, 0), b = toWorld(CAM.vw, CAM.vh);
      var cw = Math.ceil(sh.w / CH), chh = Math.ceil(sh.h / CH);
      var cx0 = Math.max(0, Math.floor(a[0] / CH)), cy0 = Math.max(0, Math.floor(a[1] / CH));
      var cx1 = Math.min(cw - 1, Math.floor(b[0] / CH)), cy1 = Math.min(chh - 1, Math.floor(b[1] / CH));
      c.imageSmoothingEnabled = !(tp >= 16 && s >= tp * 1.2);
      for (var cy = cy0; cy <= cy1; cy++) for (var cx = cx0; cx <= cx1; cx++) {
        var ch = getChunk(cx, cy, tp), p = toScreen(cx * CH, cy * CH);
        c.drawImage(ch.cv, Math.floor(p[0]), Math.floor(p[1]), Math.ceil(CH * s) + 1, Math.ceil(CH * s) + 1);
      }
      c.imageSmoothingEnabled = true;
      c.globalAlpha = 1;
    }
    // выбранный отсек
    if (V.sel) {
      var r = V.sel, p0 = toScreen(r.x, r.y);
      c.strokeStyle = 'rgba(240,200,106,' + (0.65 + 0.3 * Math.sin(T * 4)) + ')'; c.lineWidth = 2;
      c.setLineDash([6, 4]); c.lineDashOffset = -T * 16;
      c.strokeRect(p0[0], p0[1], r.w * s, r.h * s);
      c.setLineDash([]);
    }
    // орудия на корпусе — видны снаружи
    if (k < 0.9) drawMounts(c, 1 - k, T);
    // экипаж
    if (k > 0.5 && s >= 5) drawCrew(c, Math.min(1, (s - 5) / 3) * k);
    // подписи отсеков
    if (V.labels && k > 0.6) drawLabels(c, k);
  }

  function drawMounts(c, alpha, T) {
    var sh = V.ship, s = CAM.s;
    c.globalAlpha = alpha;
    for (var i = 0; i < sh.mounts.length; i++) {
      var m = sh.mounts[i], p = toScreen(m.x, m.y);
      var r = m.t === 'pd' ? 2.5 : 4.5;
      c.strokeStyle = m.t === 'pd' ? 'rgba(143,168,196,0.8)' : 'rgba(217,169,64,0.95)';
      c.lineWidth = 1.5;
      c.beginPath(); c.arc(p[0], p[1], r + (V.sel && V.sel.n === m.room ? 3 + Math.sin(T * 6) * 1.5 : 0), 0, TAU); c.stroke();
    }
    c.globalAlpha = 1;
  }

  function drawCrew(c, alpha) {
    var A = atlas(), s = CAM.s;
    var hw = CAM.vw / 2 / s + 1, hh = CAM.vh / 2 / s + 1;
    var x0 = CAM.x - hw, x1 = CAM.x + hw, y0 = CAM.y - hh, y1 = CAM.y + hh;
    c.globalAlpha = alpha;
    var scale = 1.3;    // фигурки крупнее жизни, иначе в отсеках по 50 м их не разглядеть
    for (var i = 0; i < V.crew.length; i++) {
      var m = V.crew[i];
      if (m.x < x0 || m.x > x1 || m.y < y0 || m.y > y1) continue;
      var p = toScreen(m.x, m.y);
      if (A.ok) {
        var size = s * A.scale * scale, half = size / 2, per = A.dirs * A.frames;
        var dir = Math.round(((m.aim % TAU) + TAU) % TAU / TAU * A.dirs) % A.dirs;
        var fr = m.mv > 0.3 ? 1 + Math.floor(m.phase / (TAU / 4)) % 4 : 0;
        var kk = m.type * per + dir * A.frames + fr;
        c.drawImage(A.canvas, (kk % A.cols) * A.cell, Math.floor(kk / A.cols) * A.cell, A.cell, A.cell, p[0] - half, p[1] - half, size, size);
      } else {
        c.save(); c.translate(p[0], p[1]); c.scale(s * scale, s * scale);
        F.draw(c, S.TYPES[m.type], { aim: m.aim, legs: m.legs, mv: m.mv, phase: m.phase });
        c.restore();
      }
    }
    c.globalAlpha = 1;
  }

  function drawLabels(c, k) {
    var sh = V.ship, s = CAM.s;
    if (s > 30) return;
    var fs = s < 8 ? 10 : 11;
    c.font = fs + 'px "Courier New", monospace'; c.textAlign = 'center'; c.textBaseline = 'middle';
    for (var i = 0; i < sh.rooms.length; i++) {
      var r = sh.rooms[i];
      if (r.auto && s < 7) continue;
      var wpx = r.w * s, hpx = r.h * s;
      if (hpx < 18) continue;
      var name = r.name;
      var tw = c.measureText(name).width;
      if (tw + 8 > wpx) {
        // длинное имя — короче, по типу
        name = name.replace(/ \(.*\)$/, '');
        tw = c.measureText(name).width;
        if (tw + 8 > wpx) continue;
      }
      var p = toScreen(r.x + r.w / 2, r.y + Math.min(r.h / 2, 3 + 14 / s));
      if (p[0] < -100 || p[1] < -20 || p[0] > CAM.vw + 100 || p[1] > CAM.vh + 20) continue;
      c.globalAlpha = k * 0.92;
      c.fillStyle = 'rgba(5,6,10,0.72)'; c.fillRect(p[0] - tw / 2 - 4, p[1] - fs / 2 - 3, tw + 8, fs + 6);
      c.fillStyle = r === V.sel ? '#f0c86a' : '#cfd8dc';
      c.fillText(name, p[0], p[1] + 0.5);
    }
    c.globalAlpha = 1;
  }

  // ---------- ввод ----------
  var PTR = new Map(), G = null;
  function bind() {
    CV.addEventListener('pointerdown', function(e) {
      CV.setPointerCapture(e.pointerId); FLY = null;
      PTR.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY });
      if (PTR.size === 1) G = { moved: false };
      else if (PTR.size === 2 && G) {
        G.moved = true;
        var ps = Array.from(PTR.values());
        G.pinch = { d: dist(ps[0], ps[1]), s: CAM.s, mid: toWorld((ps[0].x + ps[1].x) / 2, (ps[0].y + ps[1].y) / 2) };
      }
    });
    CV.addEventListener('pointermove', function(e) {
      var p = PTR.get(e.pointerId); if (!p || !G) return;
      var dx = e.clientX - p.x, dy = e.clientY - p.y; p.x = e.clientX; p.y = e.clientY;
      if (PTR.size === 2 && G.pinch) {
        var ps = Array.from(PTR.values()), d = dist(ps[0], ps[1]);
        CAM.s = G.pinch.s * d / Math.max(1, G.pinch.d); clamp();
        var w = toWorld((ps[0].x + ps[1].x) / 2, (ps[0].y + ps[1].y) / 2);
        CAM.x += G.pinch.mid[0] - w[0]; CAM.y += G.pinch.mid[1] - w[1]; clamp(); hudZoom();
        return;
      }
      if (Math.abs(p.x - p.x0) + Math.abs(p.y - p.y0) > 8) G.moved = true;
      if (G.moved) { CAM.x -= dx / CAM.s; CAM.y -= dy / CAM.s; clamp(); }
    });
    function up(e) {
      var p = PTR.get(e.pointerId); PTR.delete(e.pointerId);
      if (!G) return;
      if (PTR.size === 0) { if (p && !G.moved && e.type === 'pointerup') tap(p.x, p.y); G = null; }
      else G.pinch = null;
    }
    CV.addEventListener('pointerup', up); CV.addEventListener('pointercancel', up);
    CV.addEventListener('wheel', function(e) {
      e.preventDefault(); FLY = null;
      var w = toWorld(e.clientX, e.clientY);
      CAM.s *= Math.exp(-e.deltaY * 0.0015); clamp();
      var w2 = toWorld(e.clientX, e.clientY); CAM.x += w[0] - w2[0]; CAM.y += w[1] - w2[1]; clamp(); hudZoom();
    }, { passive: false });
    window.addEventListener('resize', function() { resize(); });
    document.addEventListener('visibilitychange', function() { if (document.visibilityState === 'visible' && ATLAS) ATLAS.at = 0; });
  }
  function dist(a, b) { var dx = a.x - b.x, dy = a.y - b.y; return Math.sqrt(dx * dx + dy * dy); }

  function tap(px, py) {
    if (!V.ship) return;
    var w = toWorld(px, py), r = SH.roomAt(V.ship, w[0], w[1]);
    if (!r) {
      // касание по орудию на корпусе — его пост
      for (var i = 0; i < V.ship.mounts.length; i++) {
        var m = V.ship.mounts[i], dx = m.x - w[0], dy = m.y - w[1];
        if (dx * dx + dy * dy < Math.pow(14 / CAM.s, 2)) { r = V.ship.roomByN[m.room]; break; }
      }
    }
    V.sel = r || null;
    if (r && cut() < 0.6) flyTo(r.x + r.w / 2, r.y + r.h / 2, Math.max(9, Math.min(22, Math.min(CAM.vw / (r.w + 16), CAM.vh * 0.5 / (r.h + 16)))));
    hud();
  }

  // ---------- интерфейс ----------
  function hud() {
    var sh = V.ship;
    for (var i = 0; i < LIST.length; i++) $('sv-ship-' + LIST[i].id).classList.toggle('on', !!sh && sh.id === LIST[i].id);
    if (!sh) return;
    var top = $('sv-top');
    top.classList.toggle('cis', sh.faction === 'cis');
    $('sv-name').textContent = sh.name;
    $('sv-side').textContent = sh.faction === 'cis' ? 'КНС' : 'Республика';
    $('sv-len').textContent = sh.lengthM + ' м';
    $('sv-rooms').textContent = sh.rooms.length;
    var guns = 0; for (var g = 0; g < sh.mounts.length; g++) if (sh.mounts[g].t !== 'pd') guns++;
    $('sv-guns').textContent = guns + (sh.mounts.length > guns ? ' + ' + (sh.mounts.length - guns) + ' ПВО' : '');
    var r = V.sel, box = $('sv-info');
    if (r) {
      var T = SH.TYPES[r.t] || { name: r.t, sys: '', about: '' };
      var crew = 0; for (var k = 0; k < V.crew.length; k++) if (V.crew[k].room === r.n) crew++;
      var mount = null; for (var q = 0; q < sh.mounts.length; q++) if (sh.mounts[q].room === r.n) mount = sh.mounts[q];
      box.innerHTML = '<div class="sv-info-head"><b>' + esc(r.name) + '</b><span class="sv-tag">' + esc(T.name) + '</span></div>' +
        '<div class="sv-info-row"><span>Система</span><b>' + esc(T.sys) + '</b>' +
        '<span>Площадь</span><b>' + (r.area * sh.cellM * sh.cellM) + ' м²</b>' +
        '<span>Экипаж</span><b>' + crew + '</b></div>' +
        '<div class="sv-info-about">' + esc(T.about) + (mount ? ' Орудие на корпусе отмечено кольцом.' : '') + '</div>';
      box.hidden = false;
    } else {
      box.innerHTML = '<div class="sv-info-about">' + (cut() < 0.5 ? 'Приблизь корабль — откроется разрез с отсеками. Коснись отсека или орудия на корпусе.' : 'Коснись отсека — покажу, что в нём и кто служит.') + '</div>';
      box.hidden = false;
    }
    hudZoom();
  }
  var lastCut = -1;
  function hudZoom() {
    var c = cut() < 0.5 ? 0 : 1;
    $('sv-zoom').textContent = c ? 'Корпус' : 'Разрез';
    if (c !== lastCut) { lastCut = c; if (!V.sel) hud(); }
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, function(ch) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]; }); }

  var toastT = 0;
  function toast(msg, bad) {
    var el = $('sv-toast'); el.textContent = msg; el.className = 'sv-toast show' + (bad ? ' bad' : '');
    clearTimeout(toastT); toastT = setTimeout(function() { el.className = 'sv-toast'; }, 2600);
  }

  function bindUi() {
    LIST.forEach(function(it) { $('sv-ship-' + it.id).onclick = function() { if (!V.ship || V.ship.id !== it.id) open(it.id); }; });
    $('sv-zoom').onclick = function() {
      if (!V.ship) return;
      if (cut() < 0.5) {
        var r = V.sel || biggest();
        flyTo(r ? r.x + r.w / 2 : V.ship.w / 2, r ? r.y + r.h / 2 : V.ship.h / 2, 10);
      } else {
        var top = $('sv-top').getBoundingClientRect().bottom + 8, bot = CAM.vh - $('sv-bottom').getBoundingClientRect().top + 8;
        var s = minS(); flyTo(V.ship.w / 2, V.ship.h / 2 - (top - bot) / 2 / s, s);
      }
    };
    $('sv-labels').onclick = function() { V.labels = !V.labels; $('sv-labels').classList.toggle('on', V.labels); };
  }
  function biggest() {
    var b = null; V.ship.rooms.forEach(function(r) { if (r.t === 'bridge' && (!b || r.area > b.area)) b = r; });
    return b;
  }

  // ---------- старт ----------
  resize(); bind(); bindUi();
  var start = 'venator';
  var q = location.search.match(/[?&]ship=(\w+)/);
  if (q) start = q[1];
  else { try { start = localStorage.getItem('sv-ship') || start; } catch (e) {} }
  if (!LIST.some(function(it) { return it.id === start; })) start = 'venator';
  open(start);
  requestAnimationFrame(frame);
  window.__sv = { V: V, CAM: CAM, flyTo: flyTo, cut: cut, FR: FR, atlas: function() { return ATLAS; } };
})();
