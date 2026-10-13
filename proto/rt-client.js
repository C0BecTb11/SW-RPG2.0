// Бой 2.0 — клиент прототипа: принимает поток боя (от сервера или из Worker),
// ведёт отряды по маршрутам, рисует поле, фигурки, болты; выбор отрядов и
// одиночек, приказы, замер плавности. ES5, без сборки.

(function() {
  'use strict';

  var S = window.SWRT, F = window.SWRTFig, TAU = Math.PI * 2, CH = S.CHUNK;
  var COL = { own: '#5fd968', foe: '#d94a4a', gold: '#d9a940', ally: '#4a90d9' };
  var BOLT = [['74,163,255', '#e2f1ff'], ['255,59,42', '#ffe0d8']];

  // ---------- состояние ----------
  var G = {
    map: null, side: 0, types: S.TYPES, tick: 0,
    squads: new Map(),
    cap: 0, sx: null, sy: null, sFace: null, sLegs: null, sAim: null, sMv: null, sPhase: null,
    sHp: null, sType: null, sSide: null, sSquad: null, sAlive: null, sHit: null, sSlot: null,
    bolts: [], sparks: [],
    corpses: {},            // чанк → [[x, y, type, ang], ...]
    sel: { squads: new Set(), soldiers: new Set() },
    mode: 'squad',          // squad | soldier
    stat: {}, link: null, source: 'worker', room: 'p500',
    bytes: 0, bytesWin: 0, bps: 0, winAt: performance.now()
  };

  function ensureCap(n) {
    if (n <= G.cap) return;
    var cap = Math.max(4096, Math.ceil(n * 1.5));
    function grow(Ctor, old) { var a = new Ctor(cap); if (old) a.set(old); return a; }
    G.sx = grow(Float32Array, G.sx); G.sy = grow(Float32Array, G.sy);
    G.sFace = grow(Float32Array, G.sFace); G.sLegs = grow(Float32Array, G.sLegs); G.sAim = grow(Float32Array, G.sAim);
    G.sMv = grow(Float32Array, G.sMv); G.sPhase = grow(Float32Array, G.sPhase); G.sHit = grow(Float32Array, G.sHit);
    G.sHp = grow(Int16Array, G.sHp); G.sType = grow(Uint8Array, G.sType); G.sSide = grow(Uint8Array, G.sSide);
    G.sSquad = grow(Uint16Array, G.sSquad); G.sAlive = grow(Uint8Array, G.sAlive); G.sSlot = grow(Uint16Array, G.sSlot);
    G.cap = cap;
  }

  // ---------- поток боя ----------
  function onBuf(buf) {
    G.bytes += buf.byteLength; G.bytesWin += buf.byteLength;
    var m = S.decode(buf);
    if (m.t === S.MSG.INIT) init(m.d);
    else if (m.t === S.MSG.TICK) tick(m);
    else if (m.t === S.MSG.SYNC) sync(m);
    else if (m.t === S.MSG.STAT) { G.stat = m.d; hudStat(); }
  }

  function init(d) {
    G.map = S.makeMap(d.w, d.h, d.seed);
    G.side = d.side; G.tick = d.tick;
    G.squads.clear(); G.bolts.length = 0; G.sparks.length = 0; G.corpses = {};
    G.sel.squads.clear(); G.sel.soldiers.clear();
    ensureCap(d.hp.length + 64);
    G.sAlive.fill(0);
    for (var i = 0; i < d.hp.length; i++) G.sHp[i] = d.hp[i];
    for (var k = 0; k < d.squads.length; k++) {
      var q = d.squads[k];
      // [id, side, type, x, y, face, destX, destY, single, keep, members, path]
      addSquad({ id: q[0], side: q[1], type: q[2], x: q[3], y: q[4], face: q[5], fl: (q[8] ? 1 : 0) | (q[9] ? 2 : 0),
                 members: q[10], hp: null, path: q[11] }, true);
    }
    CHUNKS.clear();
    if (!CAM.ready) fitCamera();
    setTimeout(atlas, 300);           // атлас фигурок — заранее, не при первом приближении
    sendSub(true);
    hud();
  }

  function addSquad(p, fresh) {
    var T = G.types[p.type];
    var sq = { id: p.id, side: p.side, type: p.type, x: p.x, y: p.y, face: p.face || 0, members: p.members.slice(),
               single: !!(p.fl & 1) || p.members.length === 1, keep: !!(p.fl & 2), path: [], pi: 0,
               moving: false, engaged: false, target: 0, cx: 0, cy: 0, speed: T.speed };
    setPath(sq, p.path || []);
    G.squads.set(sq.id, sq);
    ensureCap(Math.max.apply(null, sq.members.concat([0])) + 1);
    for (var i = 0; i < sq.members.length; i++) {
      var s = sq.members[i];
      var wasAlive = G.sAlive[s] && G.sType[s] === p.type && G.sSide[s] === p.side;
      G.sSquad[s] = sq.id; G.sSlot[s] = i; G.sType[s] = p.type; G.sSide[s] = p.side;
      if (p.hp) G.sHp[s] = p.hp[i];
      if (!wasAlive || fresh) {
        var o = slotPos(sq, i);
        G.sx[s] = o[0]; G.sy[s] = o[1]; G.sFace[s] = sq.face; G.sLegs[s] = sq.face; G.sAim[s] = sq.face;
        G.sMv[s] = 0; G.sPhase[s] = Math.random() * TAU; G.sHit[s] = 0;
      }
      G.sAlive[s] = 1;
    }
    return sq;
  }

  function setPath(sq, pts) {
    sq.path = []; sq.pi = 0;
    for (var i = 0; i + 1 < pts.length; i += 2) sq.path.push([pts[i] + 0.5, pts[i + 1] + 0.5]);
    sq.moving = sq.path.length > 0;
  }

  function slotPos(sq, slot) {
    var off = S.slotOffset(slot, sq.members.length), c = Math.cos(sq.face), s = Math.sin(sq.face);
    return [sq.x + off[0] * c - off[1] * s, sq.y + off[0] * s + off[1] * c];
  }

  function reslot(sq) { for (var i = 0; i < sq.members.length; i++) G.sSlot[sq.members[i]] = i; }

  function tick(m) {
    G.tick = m.tick;
    var i, sq;
    for (i = 0; i < m.spawns.length; i++) addSquad(m.spawns[i], false);
    for (i = 0; i < m.members.length; i++) {
      sq = G.squads.get(m.members[i].id); if (!sq) continue;
      sq.members = m.members[i].members.slice();
      for (var k = 0; k < sq.members.length; k++) { var sm = sq.members[k]; G.sSquad[sm] = sq.id; G.sAlive[sm] = 1; }
      reslot(sq);
    }
    for (i = 0; i < m.orders.length; i++) {
      var o = m.orders[i]; sq = G.squads.get(o.id); if (!sq) continue;
      sq.cx += o.x - sq.x; sq.cy += o.y - sq.y;   // поправку вносим плавно
      sq.engaged = !!(o.fl & 1);
      setPath(sq, o.path);
    }
    for (i = 0; i < m.hurts.length; i += 2) {
      var hs = m.hurts[i]; G.sHp[hs] = m.hurts[i + 1]; G.sHit[hs] = 0.18;
    }
    for (i = 0; i < m.deaths.length; i++) die(m.deaths[i]);
    for (i = 0; i < m.removes.length; i++) {
      var rid = m.removes[i]; G.squads.delete(rid); G.sel.squads.delete(rid);
    }
    for (i = 0; i < m.shots.length; i += 4) shots(m.shots[i], m.shots[i + 1], m.shots[i + 2], m.shots[i + 3]);
  }

  function die(s) {
    if (!G.sAlive[s]) return;
    G.sAlive[s] = 0; G.sel.soldiers.delete(s);
    var sq = G.squads.get(G.sSquad[s]);
    if (sq) { var i = sq.members.indexOf(s); if (i >= 0) { sq.members.splice(i, 1); reslot(sq); } }
    var x = G.sx[s], y = G.sy[s], key = chunkKey(x, y);
    var list = G.corpses[key] || (G.corpses[key] = []);
    var c = [x, y, G.sType[s], Math.random() * TAU];
    list.push(c);
    if (list.length > 300) list.shift();
    bakeCorpse(key, c);
    if (inView(x, y, 2)) spark(x, y, G.sSide[s] ? 'fire' : 'white', 0.5);
  }

  function sync(m) {
    for (var i = 0; i < m.squads.length; i++) {
      var q = m.squads[i], sq = G.squads.get(q.id);
      if (!sq) continue;
      var dx = q.x - (sq.x + sq.cx), dy = q.y - (sq.y + sq.cy);
      if (dx * dx + dy * dy > 36) { sq.x = q.x; sq.y = q.y; sq.cx = 0; sq.cy = 0; }   // далеко ушёл — сразу
      else { sq.cx += dx; sq.cy += dy; }
      sq.engaged = !!(q.f & 2); sq.target = q.tg;
      if (!(q.f & 1) && sq.pi >= sq.path.length) sq.moving = false;
    }
  }

  // ---------- выстрелы: болты показываем выборочно ----------
  var BOLT_CAP = 260;
  function shots(aId, bId, n, hits) {
    var a = G.squads.get(aId), b = G.squads.get(bId);
    if (!a || !b || !a.members.length) return;
    if (!inView(a.x, a.y, 14) && !inView(b.x, b.y, 14)) return;
    var load = G.bolts.length / BOLT_CAP;
    var show = Math.min(n, Math.max(1, Math.round(n * (1 - load) * 0.8)));
    if (load >= 1) return;
    for (var i = 0; i < show; i++) {
      var s = a.members[Math.floor(Math.random() * a.members.length)];
      var hit = i < hits;
      var tx, ty;
      if (b.members.length) { var t = b.members[Math.floor(Math.random() * b.members.length)]; tx = G.sx[t]; ty = G.sy[t]; }
      else { tx = b.x; ty = b.y; }
      if (!hit) { tx += (Math.random() - 0.5) * 2.2; ty += (Math.random() - 0.5) * 2.2; }
      var ang = Math.atan2(ty - G.sy[s], tx - G.sx[s]);
      G.sAim[s] = ang;
      G.bolts.push({ x: G.sx[s] + Math.cos(ang) * 0.45, y: G.sy[s] + Math.sin(ang) * 0.45, tx: tx, ty: ty, a: ang,
                     side: a.side, delay: Math.random() * 0.1, hit: hit, big: a.type === 1 || a.type === 2 });
    }
  }

  function spark(x, y, kind, life) {
    if (G.sparks.length > 120) return;
    G.sparks.push({ x: x, y: y, k: kind, t: 0, life: life || 0.25 });
  }

  // ---------- движение (каждый кадр) ----------
  function simulate(dt) {
    G.squads.forEach(function(sq) {
      var T = G.types[sq.type];
      // плавная поправка к позиции сервера
      var k = Math.min(1, dt * 3);
      sq.x += sq.cx * k; sq.y += sq.cy * k; sq.cx -= sq.cx * k; sq.cy -= sq.cy * k;
      if (sq.pi < sq.path.length) {
        var step = T.speed * dt * (sq.engaged ? 0.75 : 1), guard = 3;
        while (step > 0 && sq.pi < sq.path.length && guard-- > 0) {
          var p = sq.path[sq.pi], dx = p[0] - sq.x, dy = p[1] - sq.y, L = Math.sqrt(dx * dx + dy * dy);
          if (L <= step) { sq.x = p[0]; sq.y = p[1]; step -= L; sq.pi++; continue; }
          sq.face = S.turn(sq.face, Math.atan2(dy, dx), 4 * dt);
          sq.x += dx / L * step; sq.y += dy / L * step; step = 0;
        }
        sq.moving = true;
      } else sq.moving = false;
      var tg = sq.engaged && sq.target ? G.squads.get(sq.target) : null;
      if (tg && !sq.moving) sq.face = S.turn(sq.face, Math.atan2(tg.y - sq.y, tg.x - sq.x), 3 * dt);
      // бойцы держат место в строю
      var n = sq.members.length, c = Math.cos(sq.face), s = Math.sin(sq.face);
      var vmax = T.speed * 1.9 * dt;
      for (var i = 0; i < n; i++) {
        var id = sq.members[i], off = S.slotOffset(i, n);
        var gx = sq.x + off[0] * c - off[1] * s, gy = sq.y + off[0] * s + off[1] * c;
        var ex = gx - G.sx[id], ey = gy - G.sy[id], d = Math.sqrt(ex * ex + ey * ey), mv = 0;
        if (d > 0.03) {
          var st = Math.min(d, vmax);
          G.sx[id] += ex / d * st; G.sy[id] += ey / d * st;
          mv = st / (T.speed * dt + 1e-6);
          G.sLegs[id] = S.turn(G.sLegs[id], Math.atan2(ey, ex), 8 * dt);
          G.sPhase[id] = (G.sPhase[id] + st * 7) % TAU;
        }
        G.sMv[id] += (Math.min(1, mv) - G.sMv[id]) * Math.min(1, dt * 8);
        var want = tg ? Math.atan2(tg.y - G.sy[id], tg.x - G.sx[id]) : (G.sMv[id] > 0.3 ? G.sLegs[id] : sq.face);
        G.sAim[id] = S.turn(G.sAim[id], want, 6 * dt);
        if (G.sHit[id] > 0) G.sHit[id] -= dt;
      }
    });
    // болты
    var bs = G.bolts, w = 0;
    for (var bi = 0; bi < bs.length; bi++) {
      var b = bs[bi];
      if (b.delay > 0) { b.delay -= dt; bs[w++] = b; continue; }
      var dx = b.tx - b.x, dy = b.ty - b.y, L = Math.sqrt(dx * dx + dy * dy), st = 34 * dt;
      if (L <= st) { if (b.hit && inView(b.tx, b.ty, 1)) spark(b.tx, b.ty, b.side ? 'fire' : 'rep', 0.18); continue; }
      b.x += dx / L * st; b.y += dy / L * st; bs[w++] = b;
    }
    bs.length = w;
    var sp = G.sparks, j = 0;
    for (var si = 0; si < sp.length; si++) { sp[si].t += dt; if (sp[si].t < sp[si].life) sp[j++] = sp[si]; }
    sp.length = j;
  }

  // ---------- камера ----------
  var CV = document.getElementById('rt-canvas'), CTX = CV.getContext('2d');
  var CAM = { x: 0, y: 0, s: 6, ready: false, vw: 0, vh: 0, dpr: 1 };

  function resize() {
    CAM.dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    CAM.vw = window.innerWidth; CAM.vh = window.innerHeight;
    CV.width = Math.round(CAM.vw * CAM.dpr); CV.height = Math.round(CAM.vh * CAM.dpr);
    CV.style.width = CAM.vw + 'px'; CV.style.height = CAM.vh + 'px';
    clampCam();
  }
  function minS() { return G.map ? Math.min(CAM.vw / G.map.w, CAM.vh / G.map.h) * 0.92 : 2; }
  function maxS() { return 56; }
  function fitCamera() {
    if (!G.map) return;
    CAM.x = G.map.w / 2; CAM.y = G.map.h / 2; CAM.s = minS(); CAM.ready = true;
  }
  function clampCam() {
    if (!G.map) return;
    CAM.s = Math.max(minS(), Math.min(maxS(), CAM.s));
    var hw = CAM.vw / 2 / CAM.s, hh = CAM.vh / 2 / CAM.s;
    CAM.x = Math.max(Math.min(hw, G.map.w / 2), Math.min(G.map.w - Math.min(hw, G.map.w / 2), CAM.x));
    CAM.y = Math.max(Math.min(hh, G.map.h / 2), Math.min(G.map.h - Math.min(hh, G.map.h / 2), CAM.y));
  }
  function toScreen(x, y) { return [(x - CAM.x) * CAM.s + CAM.vw / 2, (y - CAM.y) * CAM.s + CAM.vh / 2]; }
  function toWorld(px, py) { return [(px - CAM.vw / 2) / CAM.s + CAM.x, (py - CAM.vh / 2) / CAM.s + CAM.y]; }
  function inView(x, y, m) {
    var hw = CAM.vw / 2 / CAM.s + m, hh = CAM.vh / 2 / CAM.s + m;
    return x > CAM.x - hw && x < CAM.x + hw && y > CAM.y - hh && y < CAM.y + hh;
  }
  function chunkKey(x, y) { return Math.floor(x / CH) + ':' + Math.floor(y / CH); }

  // Подписка на чанки в кадре — сервер шлёт подробности только по ним
  var subLast = '', subAt = 0;
  function sendSub(force) {
    if (!G.map || !G.link) return;
    var a = toWorld(0, 0), b = toWorld(CAM.vw, CAM.vh);
    var r = [Math.floor(Math.max(0, a[0]) / CH), Math.floor(Math.max(0, a[1]) / CH),
             Math.floor(Math.min(G.map.w - 1, b[0]) / CH), Math.floor(Math.min(G.map.h - 1, b[1]) / CH)];
    var key = r.join(',');
    var t = performance.now();
    if (!force && (key === subLast || t - subAt < 250)) return;
    subLast = key; subAt = t;
    G.link.send({ t: 'sub', r: r });
  }

  // ---------- слой поля по чанкам ----------
  var CHUNKS = new Map(), CHUNK_MAX = { 4: 80, 8: 48, 16: 20 };
  function tierFor(s) { return s < 6 ? 4 : s < 14 ? 8 : 16; }

  function hash2(x, y, seed) {
    var h = (x * 374761393 + y * 668265263 + seed * 2246822519) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  // Плавный шум: значения в узлах сетки, между ними — сглаженно
  function smooth(x, y, seed) {
    var x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
    fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
    var a = hash2(x0, y0, seed), b = hash2(x0 + 1, y0, seed), c = hash2(x0, y0 + 1, seed), d = hash2(x0 + 1, y0 + 1, seed);
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  }

  function buildChunk(cx, cy, tp) {
    var cv = document.createElement('canvas'); cv.width = cv.height = CH * tp;
    var c = cv.getContext('2d'), m = G.map, seed = m.seed, x, y, i;
    // трава, как на наземной карте игры: оттенки по шуму 1 пиксель на
    // клетку (с полями на соседей), растянутые со сглаживанием — без «клеток»
    var low = document.createElement('canvas'); low.width = low.height = CH + 2;
    var lc = low.getContext('2d'), img = lc.createImageData(CH + 2, CH + 2), D = img.data;
    var A = [58, 90, 46], B = [69, 104, 52], Cc = [52, 82, 40];
    for (y = 0; y < CH + 2; y++) for (x = 0; x < CH + 2; x++) {
      var wx = cx * CH + x - 1, wy = cy * CH + y - 1, o = (y * (CH + 2) + x) * 4;
      var n1 = smooth(wx / 9, wy / 9, seed), n2 = smooth(wx / 3, wy / 3, seed + 5);
      var n = n1 * 0.7 + n2 * 0.3;
      var k1 = Math.max(0, Math.min(1, (n - 0.35) * 2.2)), dark = Math.max(0, 0.45 - n) * 1.4;
      D[o] = A[0] + (B[0] - A[0]) * k1 - (A[0] - Cc[0]) * dark;
      D[o + 1] = A[1] + (B[1] - A[1]) * k1 - (A[1] - Cc[1]) * dark;
      D[o + 2] = A[2] + (B[2] - A[2]) * k1 - (A[2] - Cc[2]) * dark;
      D[o + 3] = 255;
    }
    lc.putImageData(img, 0, 0);
    c.imageSmoothingEnabled = true;
    c.drawImage(low, 0.5, 0.5, CH, CH, 0, 0, CH * tp, CH * tp);
    if (tp >= 8) {     // пятна земли и травинки — только вблизи
      c.globalAlpha = 0.16;
      for (i = 0; i < 22; i++) {
        var rx = hash2(cx * 97 + i, cy * 31, seed) * CH * tp, ry = hash2(cx * 13, cy * 71 + i, seed) * CH * tp;
        c.fillStyle = i % 3 ? '#2b4422' : '#6b5a3e';
        c.beginPath(); c.ellipse(rx, ry, tp * (1.5 + i % 4), tp * (0.8 + i % 3 * 0.5), i, 0, TAU); c.fill();
      }
      c.globalAlpha = 0.35; c.strokeStyle = '#5c7f45'; c.lineWidth = Math.max(1, tp / 16);
      c.beginPath();
      var blades = tp >= 16 ? 900 : 300;
      for (i = 0; i < blades; i++) {
        var bx = hash2(i, cx * 7 + cy, seed + 11) * CH * tp, by = hash2(cy * 5 + cx, i, seed + 13) * CH * tp;
        var bl = tp * (0.12 + hash2(i, i, seed) * 0.18);
        c.moveTo(bx, by); c.lineTo(bx + bl * 0.3, by - bl);
      }
      c.stroke();
      c.globalAlpha = 1;
    }
    if (cx * CH + CH > m.w || cy * CH + CH > m.h) {   // за краем карты — пустота
      c.fillStyle = '#05060a';
      if (cx * CH + CH > m.w) c.fillRect((m.w - cx * CH) * tp, 0, CH * tp, CH * tp);
      if (cy * CH + CH > m.h) c.fillRect(0, (m.h - cy * CH) * tp, CH * tp, CH * tp);
    }
    // стены и укрытия
    for (y = 0; y < CH; y++) for (x = 0; x < CH; x++) {
      var gx = cx * CH + x, gy = cy * CH + y;
      if (gx >= m.w || gy >= m.h) continue;
      var v = m.cells[gy * m.w + gx], px = x * tp, py = y * tp;
      if (v === S.WALL) {
        c.fillStyle = 'rgba(0,0,0,0.35)'; c.fillRect(px + tp * 0.25, py + tp * 0.3, tp, tp);
        c.fillStyle = '#5b636b'; c.fillRect(px, py, tp, tp);
        c.fillStyle = '#7d868f'; c.fillRect(px, py, tp, tp * 0.22);
        if (tp >= 8) { c.fillStyle = 'rgba(0,0,0,0.25)'; c.fillRect(px, py + tp - 1, tp, 1); c.fillRect(px + tp - 1, py, 1, tp); }
      } else if (v === S.COVER) {
        var sand = hash2(gx, gy, seed + 3) < 0.5;
        c.fillStyle = 'rgba(0,0,0,0.3)'; c.fillRect(px + tp * 0.2, py + tp * 0.25, tp * 0.9, tp * 0.9);
        c.fillStyle = sand ? '#8f7a52' : '#c9a45c';
        c.fillRect(px + tp * 0.06, py + tp * 0.06, tp * 0.88, tp * 0.88);
        if (tp >= 8) {
          c.strokeStyle = sand ? '#5e4f34' : '#6b5a3e'; c.lineWidth = Math.max(1, tp / 12);
          c.strokeRect(px + tp * 0.1, py + tp * 0.1, tp * 0.8, tp * 0.8);
          if (!sand) { c.beginPath(); c.moveTo(px + tp * 0.1, py + tp * 0.1); c.lineTo(px + tp * 0.9, py + tp * 0.9); c.stroke(); }
        }
      }
    }
    // зоны высадки — тонкая рамка своего цвета
    c.lineWidth = Math.max(1, tp / 6);
    var zx0 = 0 - cx * CH, zx1 = 22 - cx * CH;
    if (zx1 > 0 && zx0 < CH) { c.strokeStyle = 'rgba(95,217,104,0.28)'; c.strokeRect(Math.max(0, zx0) * tp, -2, (zx1 - Math.max(0, zx0)) * tp, CH * tp + 4); }
    var fx0 = (m.w - 22) - cx * CH;
    if (fx0 < CH && fx0 + 22 > 0) { c.strokeStyle = 'rgba(217,74,74,0.28)'; c.strokeRect(fx0 * tp, -2, 22 * tp, CH * tp + 4); }
    var ch = { cv: cv, ctx: c, tp: tp, cx: cx, cy: cy };
    var list = G.corpses[cx + ':' + cy];
    if (list) for (i = 0; i < list.length; i++) drawCorpse(ch, list[i]);
    return ch;
  }

  function drawCorpse(ch, cp) {
    var c = ch.ctx;
    c.save();
    c.translate((cp[0] - ch.cx * CH) * ch.tp, (cp[1] - ch.cy * CH) * ch.tp);
    F.corpse(c, G.types[cp[2]], cp[3], ch.tp * F.FIG);
    c.restore();
  }

  function bakeCorpse(key, cp) {
    [4, 8, 16].forEach(function(tp) { var ch = CHUNKS.get(tp + ':' + key); if (ch) drawCorpse(ch, cp); });
    if (OVER.cv && OVER.map === G.map) drawCorpse({ ctx: OVER.ctx, tp: OVER.tp, cx: 0, cy: 0 }, cp);
  }

  // Обзорная картинка всей карты (4 пикселя на клетку), склеенная из кусков
  var OVER = { cv: null, map: null, row: 0 };
  function overview() {
    var m = G.map;
    if (OVER.map !== m) {
      OVER.map = m; OVER.tp = 4; OVER.row = 0;
      OVER.cv = document.createElement('canvas'); OVER.cv.width = m.w * 4; OVER.cv.height = m.h * 4;
      OVER.ctx = OVER.cv.getContext('2d');
    }
    // строим по ряду кусков за кадр; пока не готово — рисуем кусками
    if (OVER.row < m.ch) {
      for (var cx = 0; cx < m.cw; cx++) {
        var ch = CHUNKS.get('4:' + cx + ':' + OVER.row) || buildChunk(cx, OVER.row, 4);
        OVER.ctx.drawImage(ch.cv, cx * CH * 4, OVER.row * CH * 4);
      }
      OVER.row++;
      return false;
    }
    return true;
  }

  // Новые куски поля строим не больше двух за кадр; пока крупного нет —
  // показываем мелкий того же места: приближение без заминки
  var BUILD = { left: 2 };
  function getChunk(cx, cy, tp) {
    var key = tp + ':' + cx + ':' + cy, ch = CHUNKS.get(key);
    if (ch) { CHUNKS.delete(key); CHUNKS.set(key, ch); return ch; }
    if (BUILD.left <= 0) {
      var alt = CHUNKS.get((tp === 16 ? 8 : 4) + ':' + cx + ':' + cy) || CHUNKS.get('4:' + cx + ':' + cy);
      if (alt) return alt;
      if (tp !== 4) return getChunk(cx, cy, 4);
    }
    BUILD.left--;
    ch = buildChunk(cx, cy, tp);
    CHUNKS.set(key, ch);
    var lim = CHUNK_MAX[tp], n = 0;
    CHUNKS.forEach(function(v, k) { if (v.tp === tp) n++; });
    if (n > lim) { for (var k of CHUNKS.keys()) { if (CHUNKS.get(k).tp === tp) { CHUNKS.delete(k); break; } } }
    return ch;
  }

  // ---------- атлас фигурок ----------
  var ATLAS = null;
  function atlas() {
    if (!ATLAS) {
      var t0 = performance.now();
      ATLAS = F.bake(G.types, 72);
      ATLAS.ms = performance.now() - t0;
    }
    return ATLAS;
  }

  // ---------- кадр ----------
  var FR = { last: 0, dts: [], drawn: 0, mode: '', cpuSim: 0, cpuDraw: 0 };
  function frame(t) {
    requestAnimationFrame(frame);
    var dt = FR.last ? Math.min(0.1, (t - FR.last) / 1000) : 0.016;
    var real = FR.last ? t - FR.last : 16;
    FR.last = t;
    BENCH.frame(real, t);
    if (!G.map) return;
    var t1 = performance.now();
    simulate(dt);
    var t2 = performance.now();
    draw(t / 1000);
    var t3 = performance.now();
    FR.cpuSim = FR.cpuSim * 0.95 + (t2 - t1) * 0.05; FR.cpuDraw = FR.cpuDraw * 0.95 + (t3 - t2) * 0.05;
    FR.lastCpu = t3 - t1;
    if (BENCH.on) { BENCH.cs.push(t2 - t1); BENCH.cd.push(t3 - t2); }
    FR.dts.push(real); if (FR.dts.length > 120) FR.dts.shift();
    if (t - G.winAt > 1000) { G.bps = G.bytesWin * 1000 / (t - G.winAt); G.bytesWin = 0; G.winAt = t; hudStat(); }
    sendSub(false);
  }

  function draw(T) {
    var c = CTX, dpr = CAM.dpr, s = CAM.s, m = G.map;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.fillStyle = '#05060a'; c.fillRect(0, 0, CAM.vw, CAM.vh);
    BUILD.left = 2;
    // поле
    var tp = tierFor(s * dpr / 1.2);
    var a = toWorld(0, 0), b = toWorld(CAM.vw, CAM.vh);
    var cx0 = Math.max(0, Math.floor(a[0] / CH)), cy0 = Math.max(0, Math.floor(a[1] / CH));
    var cx1 = Math.min(m.cw - 1, Math.floor(b[0] / CH)), cy1 = Math.min(m.ch - 1, Math.floor(b[1] / CH));
    c.imageSmoothingEnabled = tp < 16 || s < 20;
    if (s * dpr < 4 && overview()) {         // вся карта в кадре — одной картинкой
      var o = toScreen(0, 0);
      c.drawImage(OVER.cv, o[0], o[1], m.w * s, m.h * s);
    } else
    for (var cy = cy0; cy <= cy1; cy++) for (var cx = cx0; cx <= cx1; cx++) {
      var ch = getChunk(cx, cy, tp), p = toScreen(cx * CH, cy * CH), size = CH * s;
      c.drawImage(ch.cv, Math.floor(p[0]), Math.floor(p[1]), Math.ceil(size) + 1, Math.ceil(size) + 1);
    }
    c.imageSmoothingEnabled = true;
    // фигурки или значки: между 8 и 11 px на клетку — перетекают
    var fk = Math.max(0, Math.min(1, (s - 8) / 3));
    FR.drawn = 0;
    drawOrders(c, T);
    if (fk < 1) drawIcons(c, 1 - fk, T);
    if (fk > 0) drawFigures(c, fk, T);
    drawBolts(c);
    drawSparks(c);
    drawSelBox(c);
    FR.mode = fk >= 1 ? 'фигурки' : fk <= 0 ? 'значки' : 'переход';
  }

  function drawFigures(c, alpha, T) {
    var A = atlas(), cell = A.cell, size = CAM.s * A.scale, half = size / 2;
    var cols = 10, perType = A.dirs * A.frames;
    c.globalAlpha = alpha;
    var hw = CAM.vw / 2 / CAM.s + 1, hh = CAM.vh / 2 / CAM.s + 1, x0 = CAM.x - hw, x1 = CAM.x + hw, y0 = CAM.y - hh, y1 = CAM.y + hh;
    var selS = G.sel.soldiers, selQ = G.sel.squads;
    G.squads.forEach(function(sq) {
      if (sq.x < x0 - 8 || sq.x > x1 + 8 || sq.y < y0 - 8 || sq.y > y1 + 8) return;
      var picked = selQ.has(sq.id);
      for (var i = 0; i < sq.members.length; i++) {
        var id = sq.members[i], x = G.sx[id], y = G.sy[id];
        if (x < x0 || x > x1 || y < y0 || y > y1) continue;
        var p = toScreen(x, y);
        if (picked || selS.has(id)) {
          c.strokeStyle = 'rgba(240,200,106,0.95)'; c.lineWidth = 1.5;
          c.beginPath(); c.arc(p[0], p[1], CAM.s * 0.48, 0, TAU); c.stroke();
        }
        var dir = Math.round(((G.sAim[id] % TAU) + TAU) % TAU / TAU * A.dirs) % A.dirs;
        var fr = G.sMv[id] > 0.3 ? 1 + Math.floor(G.sPhase[id] / (TAU / 4)) % 4 : 0;
        var k = G.sType[id] * perType + dir * A.frames + fr;
        var sx = (k % cols) * cell, sy = Math.floor(k / cols) * cell;
        c.drawImage(A.canvas, sx, sy, cell, cell, p[0] - half, p[1] - half, size, size);
        if (G.sHit[id] > 0) {
          c.globalAlpha = alpha * Math.min(1, G.sHit[id] / 0.18) * 0.5;
          c.fillStyle = G.sSide[id] ? '#ffb070' : '#ffffff';
          c.beginPath(); c.arc(p[0], p[1], CAM.s * 0.35, 0, TAU); c.fill();
          c.globalAlpha = alpha;
        }
        FR.drawn++;
      }
      // здоровье одиночки — тонкая дуга
      if (sq.single && sq.members.length && CAM.s > 16) {
        var sid = sq.members[0], T2 = G.types[sq.type], pct = G.sHp[sid] / T2.hp, pp = toScreen(G.sx[sid], G.sy[sid]);
        c.strokeStyle = sq.side === G.side ? COL.own : COL.foe; c.lineWidth = 2;
        c.beginPath(); c.arc(pp[0], pp[1], CAM.s * 0.62, -Math.PI / 2, -Math.PI / 2 + TAU * Math.max(0, pct)); c.stroke();
      }
    });
    c.globalAlpha = 1;
  }

  // Значок отряда (круг, кольцо стороны, число бойцов) рисуется один раз
  // в маленькую картинку и потом только копируется: сотни значков за кадр
  var ICONS = new Map();
  function iconSprite(own, n, picked, r) {
    var key = (own ? 1 : 0) + ':' + n + ':' + (picked ? 1 : 0) + ':' + r;
    var im = ICONS.get(key);
    if (im) return im;
    var dpr = CAM.dpr, size = Math.ceil((r + 2) * 2 * dpr);
    var cv = document.createElement('canvas'); cv.width = cv.height = size;
    var c = cv.getContext('2d'); c.scale(dpr, dpr);
    var m = size / dpr / 2, col = own ? COL.own : COL.foe;
    c.fillStyle = 'rgba(10,13,20,0.9)'; c.beginPath(); c.arc(m, m, r, 0, TAU); c.fill();
    c.lineWidth = 2; c.strokeStyle = picked ? '#f0c86a' : col; c.beginPath(); c.arc(m, m, r - 1, 0, TAU); c.stroke();
    if (r >= 8) {
      c.font = 'bold ' + Math.round(r * 0.95) + 'px "Courier New", monospace';
      c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillStyle = '#cfd8dc';
      c.fillText(String(n), m, m + 0.5);
    }
    im = { cv: cv, half: m };
    ICONS.set(key, im);
    if (ICONS.size > 400) ICONS.delete(ICONS.keys().next().value);
    return im;
  }

  function drawIcons(c, alpha, T) {
    c.globalAlpha = alpha;
    var wedges = [[], []], dots = [[], []], fights = [], pickedDots = [];
    var rr = Math.max(2.2, CAM.s * 0.5);
    G.squads.forEach(function(sq) {
      if (!inView(sq.x, sq.y, 4)) return;
      var p = toScreen(sq.x, sq.y), own = sq.side === G.side ? 1 : 0;
      var picked = G.sel.squads.has(sq.id);
      FR.drawn++;
      if (sq.single) { dots[own].push(p[0], p[1]); if (picked) pickedDots.push(p[0], p[1]); return; }
      var r = Math.round(Math.max(5, Math.min(13, 3 + Math.sqrt(sq.members.length) * 1.6 + CAM.s * 0.4)));
      var im = iconSprite(own, sq.members.length, picked, r);
      c.drawImage(im.cv, p[0] - im.half, p[1] - im.half, im.half * 2, im.half * 2);
      wedges[own].push(p[0], p[1], r, sq.face);
      if (sq.engaged) fights.push(p[0], p[1], r);
    });
    var i, k;
    for (k = 0; k < 2; k++) {
      // клинья — куда смотрит отряд, одним путём на сторону
      c.fillStyle = k ? COL.own : COL.foe;
      c.beginPath();
      var w = wedges[k];
      for (i = 0; i < w.length; i += 4) {
        var x = w[i], y = w[i + 1], r = w[i + 2], a = w[i + 3];
        c.moveTo(x + Math.cos(a) * (r + 5), y + Math.sin(a) * (r + 5));
        c.lineTo(x + Math.cos(a + 2.4) * (r + 1), y + Math.sin(a + 2.4) * (r + 1));
        c.lineTo(x + Math.cos(a - 2.4) * (r + 1), y + Math.sin(a - 2.4) * (r + 1));
        c.closePath();
      }
      c.fill();
      // одиночки — точки
      var d = dots[k];
      c.beginPath();
      for (i = 0; i < d.length; i += 2) { c.moveTo(d[i] + rr, d[i + 1]); c.arc(d[i], d[i + 1], rr, 0, TAU); }
      c.fill();
      c.strokeStyle = 'rgba(0,0,0,0.7)'; c.lineWidth = 1; c.stroke();
    }
    if (pickedDots.length) {
      c.strokeStyle = '#f0c86a'; c.lineWidth = 2; c.beginPath();
      for (i = 0; i < pickedDots.length; i += 2) { c.moveTo(pickedDots[i] + rr + 1, pickedDots[i + 1]); c.arc(pickedDots[i], pickedDots[i + 1], rr + 1, 0, TAU); }
      c.stroke();
    }
    if (fights.length) {   // идёт бой — мерцающее оранжевое кольцо
      c.strokeStyle = 'rgba(232,146,58,' + (0.5 + 0.4 * Math.sin(T * 8)) + ')'; c.lineWidth = 1.5; c.beginPath();
      for (i = 0; i < fights.length; i += 3) { c.moveTo(fights[i] + fights[i + 2] + 3, fights[i + 1]); c.arc(fights[i], fights[i + 1], fights[i + 2] + 3, 0, TAU); }
      c.stroke();
    }
    c.globalAlpha = 1;
  }

  // Путь выбранных своих отрядов — пунктиром, как в игре
  function drawOrders(c, T) {
    if (!G.sel.squads.size) return;
    c.setLineDash([5, 5]); c.lineDashOffset = -T * 18; c.lineWidth = 1.5; c.strokeStyle = 'rgba(217,169,64,0.7)';
    G.sel.squads.forEach(function(id) {
      var sq = G.squads.get(id); if (!sq || sq.pi >= sq.path.length) return;
      var p = toScreen(sq.x, sq.y);
      c.beginPath(); c.moveTo(p[0], p[1]);
      for (var i = sq.pi; i < sq.path.length; i++) { var q = toScreen(sq.path[i][0], sq.path[i][1]); c.lineTo(q[0], q[1]); }
      c.stroke();
      var e = toScreen(sq.path[sq.path.length - 1][0], sq.path[sq.path.length - 1][1]);
      c.setLineDash([]); c.fillStyle = 'rgba(217,169,64,0.85)';
      c.beginPath(); c.arc(e[0], e[1], 3, 0, TAU); c.fill(); c.setLineDash([5, 5]);
    });
    c.setLineDash([]);
  }

  function drawBolts(c) {
    var s = CAM.s, len = Math.max(0.5, Math.min(1.1, 14 / s));
    c.lineCap = 'round';
    for (var side = 0; side < 2; side++) {
      var col = BOLT[side];
      // свечение и сердцевина двумя проходами
      for (var pass = 0; pass < 2; pass++) {
        c.strokeStyle = pass ? col[1] : 'rgba(' + col[0] + ',0.55)';
        c.lineWidth = pass ? Math.max(1, s * 0.05) : Math.max(2, s * 0.14);
        c.beginPath();
        for (var i = 0; i < G.bolts.length; i++) {
          var b = G.bolts[i];
          if (b.side !== side || b.delay > 0 || !inView(b.x, b.y, 2)) continue;
          var l = b.big ? len * 1.3 : len;
          var p = toScreen(b.x, b.y), q = toScreen(b.x - Math.cos(b.a) * l, b.y - Math.sin(b.a) * l);
          c.moveTo(p[0], p[1]); c.lineTo(q[0], q[1]);
        }
        c.stroke();
      }
    }
  }

  function drawSparks(c) {
    for (var i = 0; i < G.sparks.length; i++) {
      var sp = G.sparks[i], k = 1 - sp.t / sp.life, p = toScreen(sp.x, sp.y), r = CAM.s * (0.25 + 0.35 * (1 - k));
      c.fillStyle = sp.k === 'fire' ? 'rgba(255,150,60,' + 0.7 * k + ')' : sp.k === 'rep' ? 'rgba(140,200,255,' + 0.7 * k + ')' : 'rgba(255,255,255,' + 0.6 * k + ')';
      c.beginPath(); c.arc(p[0], p[1], Math.max(1.5, r), 0, TAU); c.fill();
    }
  }

  // ---------- выбор и приказы ----------
  function ownSquadAt(wx, wy, r) {
    var best = null, bd = r * r;
    G.squads.forEach(function(sq) {
      if (sq.side !== G.side) return;
      for (var i = 0; i < sq.members.length; i++) {
        var id = sq.members[i], dx = G.sx[id] - wx, dy = G.sy[id] - wy, d = dx * dx + dy * dy;
        if (d < bd) { bd = d; best = { sq: sq, s: id }; }
      }
      if (!sq.members.length) return;
      var ex = sq.x - wx, ey = sq.y - wy, e = ex * ex + ey * ey;
      if (e < bd) { bd = e; best = { sq: sq, s: sq.members[0] }; }
    });
    return best;
  }

  function tapAt(px, py, long) {
    var w = toWorld(px, py), r = Math.max(0.7, 14 / CAM.s);
    var hit = ownSquadAt(w[0], w[1], r);
    if (hit) {
      if (long || G.mode === 'soldier') {
        // одиночный выбор: отдельный боец
        G.sel.squads.clear();
        if (hit.sq.single) G.sel.squads.add(hit.sq.id);
        else { if (G.sel.soldiers.has(hit.s)) G.sel.soldiers.delete(hit.s); else G.sel.soldiers.add(hit.s); }
        toast(hit.sq.single ? 'Одиночка выбран' : 'Боец выбран: ' + G.sel.soldiers.size + ' · коснись поля — выйдут из строя');
      } else {
        G.sel.soldiers.clear();
        if (G.sel.squads.has(hit.sq.id)) G.sel.squads.delete(hit.sq.id); else G.sel.squads.add(hit.sq.id);
      }
      hud(); return;
    }
    // приказ: идти сюда
    if (G.sel.soldiers.size) {
      G.link.send({ t: 'order', k: 'detach', s: Array.from(G.sel.soldiers), x: w[0], y: w[1] });
      toast('Бойцы вышли из строя: ' + G.sel.soldiers.size);
      G.sel.soldiers.clear(); hud(); mark(w[0], w[1]); return;
    }
    if (G.sel.squads.size) {
      G.link.send({ t: 'order', k: 'move', sq: Array.from(G.sel.squads), x: w[0], y: w[1] });
      mark(w[0], w[1]); return;
    }
  }

  function mark(x, y) { spark(x, y, 'white', 0.4); }

  // выбор рамкой: двумя пальцами нельзя — кнопка «Рамка», потом протянуть
  var BOX = null;
  function drawSelBox(c) {
    if (!BOX) return;
    c.strokeStyle = 'rgba(217,169,64,0.9)'; c.lineWidth = 1; c.setLineDash([4, 3]);
    c.strokeRect(Math.min(BOX.x0, BOX.x1), Math.min(BOX.y0, BOX.y1), Math.abs(BOX.x1 - BOX.x0), Math.abs(BOX.y1 - BOX.y0));
    c.setLineDash([]);
  }
  function boxSelect() {
    var a = toWorld(Math.min(BOX.x0, BOX.x1), Math.min(BOX.y0, BOX.y1)), b = toWorld(Math.max(BOX.x0, BOX.x1), Math.max(BOX.y0, BOX.y1));
    G.sel.soldiers.clear(); G.sel.squads.clear();
    G.squads.forEach(function(sq) {
      if (sq.side === G.side && sq.x >= a[0] && sq.x <= b[0] && sq.y >= a[1] && sq.y <= b[1]) G.sel.squads.add(sq.id);
    });
    hud();
  }

  // ---------- ввод ----------
  var PTR = new Map(), GEST = null;
  function bindInput() {
    CV.addEventListener('pointerdown', function(e) {
      CV.setPointerCapture(e.pointerId);
      PTR.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t0: performance.now() });
      if (PTR.size === 1) {
        GEST = { moved: false, long: false };
        if (UI.boxMode) { BOX = { x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY }; return; }
        GEST.timer = setTimeout(function() {
          if (GEST && !GEST.moved && PTR.size === 1) { GEST.long = true; var p = PTR.values().next().value; tapAt(p.x, p.y, true); }
        }, 450);
      } else if (PTR.size === 2) {
        if (GEST) { GEST.moved = true; clearTimeout(GEST.timer); }
        var ps = Array.from(PTR.values());
        GEST.pinch = { d: dist(ps[0], ps[1]), s: CAM.s, mid: toWorld((ps[0].x + ps[1].x) / 2, (ps[0].y + ps[1].y) / 2) };
      }
      BENCH.userInput();
    });
    CV.addEventListener('pointermove', function(e) {
      var p = PTR.get(e.pointerId); if (!p) return;
      var dx = e.clientX - p.x, dy = e.clientY - p.y;
      p.x = e.clientX; p.y = e.clientY;
      if (BOX) { BOX.x1 = e.clientX; BOX.y1 = e.clientY; return; }
      if (!GEST) return;
      if (PTR.size === 2 && GEST.pinch) {
        var ps = Array.from(PTR.values()), d = dist(ps[0], ps[1]);
        CAM.s = GEST.pinch.s * d / Math.max(1, GEST.pinch.d);
        clampCam();
        var mx = (ps[0].x + ps[1].x) / 2, my = (ps[0].y + ps[1].y) / 2, w = toWorld(mx, my);
        CAM.x += GEST.pinch.mid[0] - w[0]; CAM.y += GEST.pinch.mid[1] - w[1]; clampCam();
        return;
      }
      if (Math.abs(p.x - p.x0) + Math.abs(p.y - p.y0) > 8) { GEST.moved = true; clearTimeout(GEST.timer); }
      if (GEST.moved) { CAM.x -= dx / CAM.s; CAM.y -= dy / CAM.s; clampCam(); }
    });
    function up(e) {
      var p = PTR.get(e.pointerId); PTR.delete(e.pointerId);
      if (BOX) { if (Math.abs(BOX.x1 - BOX.x0) + Math.abs(BOX.y1 - BOX.y0) > 10) boxSelect(); BOX = null; UI.boxMode = false; hud(); return; }
      if (!GEST) return;
      clearTimeout(GEST.timer);
      if (PTR.size === 0) {
        if (p && !GEST.moved && !GEST.long && e.type === 'pointerup') tapAt(p.x, p.y, false);
        GEST = null;
      } else GEST.pinch = null;
    }
    CV.addEventListener('pointerup', up);
    CV.addEventListener('pointercancel', up);
    CV.addEventListener('wheel', function(e) {
      e.preventDefault();
      var w = toWorld(e.clientX, e.clientY);
      CAM.s *= Math.exp(-e.deltaY * 0.0015); clampCam();
      var w2 = toWorld(e.clientX, e.clientY); CAM.x += w[0] - w2[0]; CAM.y += w[1] - w2[1]; clampCam();
      BENCH.userInput();
    }, { passive: false });
    window.addEventListener('resize', function() { resize(); CHUNKS.clear(); ICONS.clear(); });
  }
  function dist(a, b) { var dx = a.x - b.x, dy = a.y - b.y; return Math.sqrt(dx * dx + dy * dy); }

  // ---------- связь ----------
  function WorkerLink(room, side) {
    var w = new Worker('sim-worker.js');
    w.onmessage = function(e) { if (e.data instanceof ArrayBuffer) onBuf(e.data); };
    w.postMessage({ t: 'start', room: room, side: side });
    return { send: function(m) { w.postMessage(m); }, close: function() { w.terminate(); }, kind: 'worker' };
  }

  function WsLink(url, token, room, onFail) {
    var ws = new WebSocket(url.replace(/^http/, 'ws') + '/ws');
    ws.binaryType = 'arraybuffer';
    var ok = false;
    ws.onopen = function() { ws.send(JSON.stringify({ t: 'auth', token: token, room: room })); };
    ws.onmessage = function(e) {
      if (typeof e.data === 'string') {
        var m = JSON.parse(e.data);
        if (m.t === 'error') { toast('Сервер: ' + m.msg, true); }
        if (m.t === 'pong') { G.rtt = performance.now() - m.at; }
        return;
      }
      ok = true; onBuf(e.data);
    };
    ws.onclose = function() { if (!ok && onFail) onFail(); else if (G.link && G.link.ws === ws) toast('Связь с сервером потеряна', true); };
    var ping = setInterval(function() { if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'ping', at: performance.now() })); }, 3000);
    return { ws: ws, send: function(m) { if (ws.readyState === 1) ws.send(JSON.stringify(m)); },
             close: function() { clearInterval(ping); ws.onclose = null; ws.close(); }, kind: 'server' };
  }

  function connect() {
    if (G.link) G.link.close();
    G.map = null; CAM.ready = false; CHUNKS.clear();
    if (G.source === 'server' && SERVER.url && SERVER.token) {
      G.link = WsLink(SERVER.url, SERVER.token, G.room, function() {
        toast('Сервер не ответил — считаю в браузере', true);
        G.source = 'worker'; connect();
      });
    } else {
      G.source = 'worker';
      G.link = WorkerLink(G.room, 0);
    }
    hud();
  }

  // ---------- сервер 2.0: на связи ли ----------
  var SERVER = { url: null, online: false, token: null };
  function checkServer() {
    if (!window.supabase || typeof window.supabase.rpc !== 'function') return;
    window.supabase.auth.getSession().then(function(r) {
      var s = r && r.data && r.data.session;
      if (!s) return;
      SERVER.token = s.access_token;
      return window.supabase.rpc('rt_server_status').then(function(res) {
        var d = res && res.data;
        if (d && d.online && d.url) { SERVER.url = d.url; SERVER.online = true; hud(); }
      });
    }).catch(function() {});
  }

  // ---------- интерфейс ----------
  var UI = { boxMode: false };
  var $ = function(id) { return document.getElementById(id); };

  function hud() {
    $('rt-scen-500').classList.toggle('on', G.room === 'p500');
    $('rt-scen-2000').classList.toggle('on', G.room === 'p2000');
    $('rt-src-worker').classList.toggle('on', G.source === 'worker');
    var srv = $('rt-src-server');
    srv.classList.toggle('on', G.source === 'server');
    srv.disabled = !SERVER.online;
    srv.title = SERVER.online ? SERVER.url : 'Сервер 2.0 ещё не запущен';
    var nS = G.sel.squads.size, nB = G.sel.soldiers.size, sing = 0, men = 0;
    G.sel.squads.forEach(function(id) { var q = G.squads.get(id); if (q) { men += q.members.length; if (q.single) sing++; } });
    var info = nB ? 'Бойцов: ' + nB + ' · коснись поля — выйдут из строя'
             : nS ? 'Отрядов: ' + (nS - sing) + (sing ? ' · одиночек: ' + sing : '') + ' · войск: ' + men + ' · коснись поля — идти'
             : G.mode === 'soldier' ? 'Режим «Боец»: касание выбирает одного бойца' : 'Коснись своего отряда. Долгое касание — один боец';
    $('rt-sel').textContent = info;
    $('rt-mode-squad').classList.toggle('on', G.mode === 'squad');
    $('rt-mode-soldier').classList.toggle('on', G.mode === 'soldier');
    $('rt-box').classList.toggle('on', UI.boxMode);
    $('rt-regroup').disabled = !sing;
    $('rt-stop').disabled = !nS;
    $('rt-clear').disabled = !nS && !nB;
    hudStat();
  }

  function fmtKb(b) { return b < 1024 ? Math.round(b) + ' Б/с' : (b / 1024).toFixed(1).replace('.', ',') + ' КБ/с'; }
  function fmt(n, d) { return (Math.round(n * Math.pow(10, d)) / Math.pow(10, d)).toString().replace('.', ','); }

  function hudStat() {
    var st = G.stat, tr = st.troops || [0, 0], sq = st.squads || [0, 0];
    $('rt-rep').textContent = tr[0]; $('rt-cis').textContent = tr[1];
    $('rt-sq').textContent = (sq[0] || 0) + '/' + (sq[1] || 0);
    $('rt-singles').textContent = st.singles || 0;
    var d = FR.dts, avg = 0; for (var i = 0; i < d.length; i++) avg += d[i]; avg = d.length ? avg / d.length : 16;
    $('rt-fps').textContent = Math.round(1000 / avg);
    $('rt-frame').textContent = fmt(avg, 1) + ' мс';
    $('rt-sim').textContent = fmt(st.srvMs != null ? st.srvMs : st.ms || 0, 2) + ' мс';
    $('rt-net').textContent = fmtKb(G.bps);
    $('rt-lod').textContent = st.lod || 0;
    $('rt-view').textContent = FR.mode + ' · ' + FR.drawn;
  }

  var toastT = 0;
  function toast(msg, bad) {
    var el = $('rt-toast');
    el.textContent = msg; el.className = 'rt-toast show' + (bad ? ' bad' : '');
    clearTimeout(toastT); toastT = setTimeout(function() { el.className = 'rt-toast'; }, 2400);
  }

  function bindUi() {
    $('rt-scen-500').onclick = function() { if (G.room !== 'p500') { G.room = 'p500'; connect(); } };
    $('rt-scen-2000').onclick = function() { if (G.room !== 'p2000') { G.room = 'p2000'; connect(); } };
    $('rt-src-worker').onclick = function() { if (G.source !== 'worker') { G.source = 'worker'; connect(); } };
    $('rt-src-server').onclick = function() { if (SERVER.online && G.source !== 'server') { G.source = 'server'; connect(); } };
    $('rt-mode-squad').onclick = function() { G.mode = 'squad'; G.sel.soldiers.clear(); hud(); };
    $('rt-mode-soldier').onclick = function() { G.mode = 'soldier'; hud(); };
    $('rt-box').onclick = function() { UI.boxMode = !UI.boxMode; hud(); if (UI.boxMode) toast('Протяни пальцем рамку'); };
    $('rt-all').onclick = function() {
      G.sel.soldiers.clear(); G.sel.squads.clear();
      G.squads.forEach(function(sq) { if (sq.side === G.side && inView(sq.x, sq.y, 0)) G.sel.squads.add(sq.id); });
      hud();
    };
    $('rt-regroup').onclick = function() {
      var ids = []; G.sel.squads.forEach(function(id) { var q = G.squads.get(id); if (q && q.single) ids.push(id); });
      if (ids.length) { G.link.send({ t: 'order', k: 'regroup', sq: ids }); toast('В строй: ' + ids.length); G.sel.squads.clear(); hud(); }
    };
    $('rt-stop').onclick = function() { G.link.send({ t: 'order', k: 'stop', sq: Array.from(G.sel.squads) }); };
    $('rt-clear').onclick = function() { G.sel.squads.clear(); G.sel.soldiers.clear(); hud(); };
    $('rt-bench').onclick = function() { BENCH.start(); };
    $('rt-res-close').onclick = function() { $('rt-res').hidden = true; };
    $('rt-res-save').onclick = function() { BENCH.save(); };
  }

  // ---------- замер плавности ----------
  // 36 с по сценарию камеры: обзор → бой вблизи → проход вдоль фронта.
  // Пишем время каждого кадра; итог можно сохранить в базу (rt_bench).
  var BENCH = {
    on: false, t0: 0, frames: [], phase: '', result: null,
    start: function() {
      if (!G.map) return;
      this.on = true; this.t0 = performance.now(); this.frames = []; this.sims = []; this.bytes0 = G.bytes; this.byPhase = {}; this.cs = []; this.cd = []; this.cpByPhase = {};
      $('rt-bench').disabled = true; $('rt-res').hidden = true;
      toast('Замер 36 с — не трогай экран');
    },
    userInput: function() { if (this.on) { this.on = false; $('rt-bench').disabled = false; toast('Замер прерван касанием', true); } },
    hot: function() {
      var best = null, bn = -1;
      G.squads.forEach(function(sq) {
        if (!sq.engaged) return;
        var n = 0; G.squads.forEach(function(o) { var dx = o.x - sq.x, dy = o.y - sq.y; if (dx * dx + dy * dy < 400) n += o.members.length; });
        if (n > bn) { bn = n; best = sq; }
      });
      return best || G.squads.values().next().value;
    },
    frame: function(dt, t) {
      if (!this.on) return;
      var e = (t - this.t0) / 1000, m = G.map, k;
      var ph = e < 8 ? 'обзор' : e < 22 ? 'вблизи' : 'проход';
      if (ph !== this.phase) {
        this.phase = ph;
        if (ph === 'вблизи') { var h = this.hot(); this.focus = h ? [h.x, h.y] : [m.w / 2, m.h / 2]; }
        if (ph === 'проход') this.from = [CAM.x, CAM.y];
      }
      if (ph === 'обзор') { CAM.s = minS(); CAM.x = m.w / 2; CAM.y = m.h / 2; }
      else if (ph === 'вблизи') { k = Math.min(1, (e - 8) / 2); CAM.s = minS() + (22 - minS()) * k; CAM.x += (this.focus[0] - CAM.x) * 0.08; CAM.y += (this.focus[1] - CAM.y) * 0.08; }
      else { k = (e - 22) / 14; CAM.s = 14; CAM.x = this.from[0]; CAM.y = 10 + (m.h - 20) * k; }
      clampCam();
      if (e > 0.5) {
        this.frames.push(dt);
        (this.byPhase[ph] = this.byPhase[ph] || []).push(dt);
        (this.cpByPhase[ph] = this.cpByPhase[ph] || []).push(FR.lastCpu || 0);
        if (G.stat.srvMs != null) this.sims.push(G.stat.srvMs);
      }
      if (e >= 36) this.finish();
    },
    finish: function() {
      this.on = false; $('rt-bench').disabled = false;
      function sum(a) { var f = a.slice().sort(function(x, y) { return x - y; }), s = 0; for (var i = 0; i < f.length; i++) s += f[i];
        return { fps: Math.round(1000 * f.length / Math.max(1, s)), p50: Math.round(f[f.length >> 1] * 10) / 10,
                 p95: Math.round(f[Math.floor(f.length * 0.95)] * 10) / 10, max: Math.round(f[f.length - 1]),
                 jank: Math.round(f.filter(function(x) { return x > 34; }).length / f.length * 1000) / 10 }; }
      var r = { scenario: G.room, source: G.source, all: sum(this.frames), phases: {},
                troops: (G.stat.troops || [0, 0])[0] + (G.stat.troops || [0, 0])[1], squads: G.squads.size,
                simMs: this.sims.length ? Math.round(this.sims.reduce(function(a, b) { return a + b; }, 0) / this.sims.length * 100) / 100 : null,
                netBps: Math.round((G.bytes - this.bytes0) / 36), atlasMs: ATLAS ? Math.round(ATLAS.ms) : null };
      function avg(a) { var s = 0; for (var i = 0; i < a.length; i++) s += a[i]; return a.length ? Math.round(s / a.length * 100) / 100 : 0; }
      for (var k in this.byPhase) { r.phases[k] = sum(this.byPhase[k]); r.phases[k].cpu = avg(this.cpByPhase[k] || []); }
      r.cpuMoveMs = avg(this.cs); r.cpuDrawMs = avg(this.cd);
      this.result = r;
      showResult(r);
    },
    save: function() {
      var r = this.result; if (!r || !window.supabase) return;
      var dev = { ua: navigator.userAgent.slice(0, 300), w: screen.width, h: screen.height, dpr: window.devicePixelRatio || 1,
                  cores: navigator.hardwareConcurrency || null, mem: navigator.deviceMemory || null };
      window.supabase.rpc('rt_bench_submit', { p_scenario: r.scenario, p_device: dev, p_results: r }).then(function(res) {
        if (res.error) toast(res.error.message === 'Нет входа в игру' ? 'Чтобы сохранить, войди в игру' : 'Не сохранилось: ' + res.error.message, true);
        else { toast('Замер сохранён — Claude его увидит'); $('rt-res-save').disabled = true; }
      });
    }
  };

  function showResult(r) {
    var rows = [['Всё время', r.all]];
    ['обзор', 'вблизи', 'проход'].forEach(function(k) { if (r.phases[k]) rows.push([k[0].toUpperCase() + k.slice(1), r.phases[k]]); });
    var h = '<table><tr><th></th><th>к/с</th><th>кадр p50</th><th>p95</th><th>рывки</th></tr>';
    rows.forEach(function(x) {
      var v = x[1], bad = v.p95 > 34 ? ' class="bad"' : v.p95 > 20 ? ' class="mid"' : ' class="good"';
      h += '<tr><td>' + x[0] + '</td><td' + bad + '>' + v.fps + '</td><td>' + fmt(v.p50, 1) + ' мс</td><td' + bad + '>' + fmt(v.p95, 1) + ' мс</td><td>' + fmt(v.jank, 1) + '%</td></tr>';
    });
    h += '</table>';
    h += '<div class="rt-res-meta">' + (r.scenario === 'p2000' ? '~2000' : '~500') + ' войск · ' + (r.source === 'server' ? 'сервер' : 'расчёт в браузере') +
         ' · расчёт ' + fmt(r.simMs || 0, 2) + ' мс/такт · поток ' + fmtKb(r.netBps) + '</div>';
    $('rt-res-body').innerHTML = h;
    $('rt-res').hidden = false;
    $('rt-res-save').disabled = false;
    window.__rtBench = r;
  }

  // ---------- старт ----------
  resize(); bindInput(); bindUi();
  var q = location.search.match(/[?&]n=(2000|500)/);
  if (q) G.room = 'p' + q[1];
  connect();
  checkServer();
  requestAnimationFrame(frame);
  if (/[?&]bench=1/.test(location.search)) setTimeout(function() { BENCH.start(); }, 4000);
  window.__rt = { G: G, CAM: CAM, BENCH: BENCH, FR: FR };
})();
