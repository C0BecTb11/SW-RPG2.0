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
      wall: '#c3c9d1', wallTop: '#e6eaef', wallEdge: '#4a525c', corridor: '#666e78', plate: 'rgba(28,32,38,0.93)',
      lamp: '#f2f6ff', lampGlow: 'rgba(200,225,255,0.22)', stripGlow: 'rgba(160,210,255,0.18)', screenGlow: 'rgba(120,190,255,0.16)',
      doorGlow: 'rgba(130,230,150,0.12)', accentSoft: 'rgba(192,69,58,0.55)', corridorLine: 'rgba(230,236,242,0.35)',
      accent: '#c0453a', light: '#9fd0ff', door: '#8b939c', doorLight: '#7fe08a', tech: 'rgba(6,9,14,0.55)',
      floor: {
        hangar: '#565d66', bridge: '#2b405c', flight: '#2b405c', cic: '#2e3f5a', gun: '#5d4640', pdgun: '#5a4642',
        reactor: '#5f5130', shield: '#2c5560', engine: '#544a40', hyper: '#463e5e', quarters: '#555d54', troops: '#525a52',
        mess: '#5c5b4c', medbay: '#3d5f59', armory: '#5d4b4b', storage: '#5a5548', hold: '#5a5548', workshop: '#5a5848',
        airlock: '#4a4e57', dock: '#4c5562', comms: '#33506a', observe: '#2b405c', vehicle: '#535a63', droids: '#585042'
      }
    },
    cis: {
      wall: '#8b8170', wallTop: '#b3a68e', wallEdge: '#2f2a23', corridor: '#4f4b45', plate: 'rgba(26,24,22,0.93)',
      lamp: '#ffd8a8', lampGlow: 'rgba(255,190,120,0.20)', stripGlow: 'rgba(110,160,240,0.18)', screenGlow: 'rgba(255,160,90,0.14)',
      doorGlow: 'rgba(230,160,70,0.12)', accentSoft: 'rgba(61,116,214,0.55)', corridorLine: 'rgba(110,160,230,0.35)',
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
      tasks.push(fetch('../shared/ships/' + id + '.json?v=2').then(function(r) {
        if (!r.ok) throw new Error('план не найден'); return r.json();
      }).then(function(d) { V.cache[id] = { data: d }; }));
    }
    Promise.all(tasks).then(function() {
      var c = V.cache[id];
      if (!c.ship) c.ship = SH.load(c.data);
      return loadImg('../' + c.ship.sprite).then(function(img) { c.img = img; return loadCraft(); }).then(function() { return c; });
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
  // Малые корабли в ангарах — те же картинки, что на космической карте
  var CRAFT_IDS = ['arc170', 'ywing', 'vulture', 'hyena'];
  function loadCraft() {
    if (V.craft) return Promise.resolve();
    var out = {};
    return Promise.all(CRAFT_IDS.map(function(id) {
      return loadImg('../assets/ships/' + id + '.png').then(function(im) { out[id] = im; }, function() {});
    })).then(function() { V.craft = out; });
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

  function buildChunk(cx, cy, tp) { return window.ShipArt.chunk(cx, cy, tp); }

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
    BUILD.left = s >= 12 ? 1 : 2;
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
  window.ShipArt.init(V, K);
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
