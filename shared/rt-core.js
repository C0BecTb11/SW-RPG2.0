// Бои 2.0 в реальном времени: общий модуль расчёта.
// Один и тот же файл работает на игровом сервере (Node, require) и в
// браузере (window.SWRT / Web Worker). Без зависимостей и без сборки, ES5.
//
// Главная единица расчёта — отряд: один приказ, один путь, одна цель.
// Боец держит место в строю; его положение на экране — забота браузера.
// Боец, выбранный поодиночке, становится «отрядом из одного» — тот же код.
// Карта делится на чанки 32×32: по ним ищем цели, усыпляем тихие места,
// подписываем игроков на подробные события и сохраняем снимок.

(function(root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SWRT = api;
})(typeof self !== 'undefined' ? self : this, function() {
  'use strict';

  var CHUNK = 32;
  var TICK = 0.1;                 // шаг расчёта, с (10 в секунду)
  var SYNC_EVERY = 10;            // сводка положений отрядов раз в секунду
  var FLOOR = 0, WALL = 1, COVER = 2;

  // ---------- случайные числа: одинаково везде ----------
  function rng(seed) {
    var a = seed >>> 0;
    return function() {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---------- типы бойцов (темп демо на «½×») ----------
  // rof — выстрелов в секунду на бойца; speed — клеток в секунду
  var TYPES = [
    { id: 'rep_dc15a',  side: 0, name: 'Клон с DC-15A',      hp: 100, speed: 1.3,  range: 10, acc: 0.55, dmg: 7,  rof: 0.9,  moveFire: 0.6,  draw: 'clone', gun: 'dc15a', rad: 0.34 },
    { id: 'rep_heavy',  side: 0, name: 'Клон-пулемётчик',    hp: 120, speed: 1.05, range: 9,  acc: 0.42, dmg: 4,  rof: 2.4,  moveFire: 0,    draw: 'clone', gun: 'z6',    rad: 0.36 },
    { id: 'rep_sniper', side: 0, name: 'Клон-снайпер',       hp: 90,  speed: 1.2,  range: 16, acc: 0.8,  dmg: 22, rof: 0.25, moveFire: 0,    draw: 'clone', gun: 'dc15a', rad: 0.34, single: true },
    { id: 'cis_b1',     side: 1, name: 'Дроид B1',           hp: 70,  speed: 1.1,  range: 9,  acc: 0.46, dmg: 7,  rof: 0.75, moveFire: 0,    draw: 'b1',    gun: 'e5',    rad: 0.32 },
    { id: 'cis_b2',     side: 1, name: 'Дроид B2',           hp: 160, speed: 0.8,  range: 7,  acc: 0.48, dmg: 5,  rof: 1.2,  moveFire: 0.55, draw: 'b2',    gun: 'wrist', rad: 0.42 },
    { id: 'cis_bx',     side: 1, name: 'BX-коммандос',       hp: 140, speed: 1.65, range: 10, acc: 0.62, dmg: 9,  rof: 0.8,  moveFire: 0.55, draw: 'bx',    gun: 'e5',    rad: 0.34, single: true }
  ];
  var TYPE_BY_ID = {};
  for (var ti = 0; ti < TYPES.length; ti++) { TYPES[ti].n = ti; TYPE_BY_ID[TYPES[ti].id] = ti; }

  // ---------- карта ----------
  function makeMap(w, h, seed) {
    var R = rng(seed), cells = new Uint8Array(w * h), x, y, i;
    function set(x, y, v) { if (x >= 0 && y >= 0 && x < w && y < h) cells[y * w + x] = v; }
    var zone = 22;                      // зоны высадки по краям — пустые
    var blocks = Math.round(w * h / 900);
    for (i = 0; i < blocks; i++) {
      var bw = 6 + Math.floor(R() * 13), bh = 6 + Math.floor(R() * 13);
      var bx = zone + 2 + Math.floor(R() * (w - 2 * zone - bw - 4));
      var by = 2 + Math.floor(R() * (h - bh - 4));
      var ruin = R() < 0.45;
      for (x = bx; x < bx + bw; x++) for (y = by; y < by + bh; y++) {
        var edge = x === bx || y === by || x === bx + bw - 1 || y === by + bh - 1;
        if (!edge) continue;
        if (ruin && R() < 0.35) continue;          // пролом в стене
        set(x, y, WALL);
      }
      // проёмы: по одному на каждую сторону
      set(bx + 1 + Math.floor(R() * (bw - 2)), by, FLOOR);
      set(bx + 1 + Math.floor(R() * (bw - 2)), by + bh - 1, FLOOR);
      set(bx, by + 1 + Math.floor(R() * (bh - 2)), FLOOR);
      set(bx + bw - 1, by + 1 + Math.floor(R() * (bh - 2)), FLOOR);
    }
    // укрытия: ящики, мешки — короткие ряды
    var covers = Math.round(w * h / 140);
    for (i = 0; i < covers; i++) {
      var cx = zone + Math.floor(R() * (w - 2 * zone)), cy = Math.floor(R() * h);
      var len = 2 + Math.floor(R() * 4), horiz = R() < 0.5;
      for (var k = 0; k < len; k++) {
        var px = horiz ? cx + k : cx, py = horiz ? cy : cy + k;
        if (px >= 0 && py >= 0 && px < w && py < h && cells[py * w + px] === FLOOR) cells[py * w + px] = COVER;
      }
    }
    return { w: w, h: h, seed: seed, cells: cells, cw: Math.ceil(w / CHUNK), ch: Math.ceil(h / CHUNK) };
  }

  function passable(map, x, y) {
    return x >= 0 && y >= 0 && x < map.w && y < map.h && map.cells[y * map.w + x] === FLOOR;
  }

  // ---------- поля направлений ----------
  // Одно поле на точку назначения, общее для всех отрядов, идущих туда.
  // Дейкстра с целыми ценами 10/14 и очередью-корзинами (алгоритм Диала):
  // линейно по числу клеток. dir — куда шагнуть из клетки (0..7), 255 — некуда.
  var DX = [1, 1, 0, -1, -1, -1, 0, 1];
  var DY = [0, 1, 1, 1, 0, -1, -1, -1];
  var DC = [10, 14, 10, 14, 10, 14, 10, 14];

  // Рабочие массивы общие на карту: корзины — кольца в одном Int32Array
  function flowScratch(map) {
    if (map._fs) return map._fs;
    var n = map.w * map.h;
    map._fs = { dist: new Uint16Array(n), q: new Int32Array(16 * n), head: new Int32Array(16), tail: new Int32Array(16), n: n };
    return map._fs;
  }

  function buildFlow(map, tx, ty) {
    var w = map.w, h = map.h, n = w * h, cells = map.cells;
    var S = flowScratch(map), dist = S.dist, q = S.q, head = S.head, tail = S.tail;
    var dir = new Uint8Array(n);
    dist.fill(65535); dir.fill(255); head.fill(0); tail.fill(0);
    var B = 15, start = ty * w + tx;
    if (cells[start] !== FLOOR) return { dir: dir, tx: tx, ty: ty };
    dist[start] = 0; dir[start] = 254;  // 254 — пришли
    q[0] = start; tail[0] = 1;
    var cur = 0, left = 1;
    while (left > 0) {
      var b = cur % B;
      if (head[b] === tail[b]) { cur++; continue; }
      var c = q[b * n + (head[b] % n)]; head[b]++; left--;
      if (dist[c] !== cur) continue;
      var cx = c % w, cy = (c - cx) / w;
      for (var d = 0; d < 8; d++) {
        var nx = cx + DX[d], ny = cy + DY[d];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        var nc = ny * w + nx;
        if (cells[nc] !== FLOOR) continue;
        if (d & 1) { // по диагонали — только если оба боковых свободны
          if (cells[cy * w + nx] !== FLOOR || cells[ny * w + cx] !== FLOOR) continue;
        }
        var nd = cur + DC[d];
        if (nd < dist[nc]) {
          dist[nc] = nd;
          dir[nc] = (d + 4) & 7;       // из соседа обратно к нам
          var nb = nd % B;
          q[nb * n + (tail[nb] % n)] = nc; tail[nb]++; left++;
        }
      }
    }
    return { dir: dir, tx: tx, ty: ty };
  }

  function FlowCache(map, max) {
    this.map = map; this.max = max || 32; this.m = new Map(); this.built = 0; this.ms = 0;
  }
  FlowCache.prototype.peek = function(tx, ty) {
    var key = ty * this.map.w + tx, f = this.m.get(key);
    if (f) { this.m.delete(key); this.m.set(key, f); }
    return f || null;
  };
  FlowCache.prototype.get = function(tx, ty) {
    var key = ty * this.map.w + tx, f = this.m.get(key);
    if (f) { this.m.delete(key); this.m.set(key, f); return f; }
    var t0 = now();
    f = buildFlow(this.map, tx, ty);
    this.ms += now() - t0; this.built++;
    this.m.set(key, f);
    if (this.m.size > this.max) this.m.delete(this.m.keys().next().value);
    return f;
  };

  function now() {
    if (typeof performance !== 'undefined' && performance.now) return performance.now();
    var t = process.hrtime(); return t[0] * 1e3 + t[1] / 1e6;
  }

  // Ближайшая проходимая клетка к точке (спиралью)
  function nearestFloor(map, x, y) {
    x = Math.max(0, Math.min(map.w - 1, Math.round(x))); y = Math.max(0, Math.min(map.h - 1, Math.round(y)));
    if (passable(map, x, y)) return [x, y];
    for (var r = 1; r < 12; r++) {
      for (var dx = -r; dx <= r; dx++) for (var dy = -r; dy <= r; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (passable(map, x + dx, y + dy)) return [x + dx, y + dy];
      }
    }
    return [x, y];
  }

  // Видимость лучом по клеткам: стены закрывают, укрытия — нет
  function sees(map, x0, y0, x1, y1) {
    var cx = Math.floor(x0), cy = Math.floor(y0), ex = Math.floor(x1), ey = Math.floor(y1);
    var dx = x1 - x0, dy = y1 - y0;
    var sx = dx > 0 ? 1 : -1, sy = dy > 0 ? 1 : -1;
    var tdx = dx !== 0 ? Math.abs(1 / dx) : 1e9, tdy = dy !== 0 ? Math.abs(1 / dy) : 1e9;
    var tmx = dx !== 0 ? (dx > 0 ? (cx + 1 - x0) : (x0 - cx)) * tdx : 1e9;
    var tmy = dy !== 0 ? (dy > 0 ? (cy + 1 - y0) : (y0 - cy)) * tdy : 1e9;
    var w = map.w, cells = map.cells, guard = 64;
    while ((cx !== ex || cy !== ey) && guard-- > 0) {
      if (tmx < tmy) { tmx += tdx; cx += sx; } else { tmy += tdy; cy += sy; }
      if (cx < 0 || cy < 0 || cx >= w || cy >= map.h) return false;
      if (cells[cy * w + cx] === WALL && (cx !== ex || cy !== ey)) return false;
    }
    return true;
  }

  // ---------- строй ----------
  // Место бойца в строю относительно знамени отряда (в осях отряда:
  // x — вперёд, y — вправо). Тот же расчёт в браузере и на сервере.
  var SPACING = 0.85;
  function slotOffset(slot, count) {
    if (count <= 1) return [0, 0];
    var cols = Math.min(6, Math.ceil(Math.sqrt(count * 1.6)));
    var row = Math.floor(slot / cols), col = slot % cols;
    var inRow = Math.min(cols, count - row * cols);
    return [-row * SPACING, (col - (inRow - 1) / 2) * SPACING];
  }

  // ---------- бой ----------
  // Отряд: { id, side, type, members[], x, y, face, dest, flow, target,
  //          acc (накопитель выстрелов), single, keep (одиночка по умолчанию),
  //          home (отряд, откуда вышел боец), idle, manual, skip, dtAcc }
  function Battle(opts) {
    this.map = opts.map;
    this.R = rng((opts.seed || 1) ^ 0x9e3779b9);
    this.flows = new FlowCache(this.map, opts.flowCache || 96);
    this.flowWait = [];         // отряды ждут поле направлений (бюджет на тик)
    this.flowBudgetMs = opts.flowBudgetMs || 6;
    this.tick = 0;
    this.squads = [];           // по id; null — нет
    this.list = [];             // живые отряды
    this.nextSquad = 1;
    // бойцы — плоские массивы
    var cap = opts.cap || 4096;
    this.cap = cap;
    this.sType = new Uint8Array(cap);
    this.sSide = new Uint8Array(cap);
    this.sHp = new Int16Array(cap);
    this.sSquad = new Uint16Array(cap);
    this.sAlive = new Uint8Array(cap);
    this.sDiedAt = new Int32Array(cap);
    this.nSoldiers = 0;
    this.freeIds = [];
    // чанки
    var nc = this.map.cw * this.map.ch;
    this.chunkSquads = []; for (var i = 0; i < nc; i++) this.chunkSquads.push([]);
    this.chunkSide = [new Uint16Array(nc), new Uint16Array(nc)];
    this.hot = new Uint8Array(nc);      // чанки, на которые смотрят игроки
    // нагрузка
    this.lod = 0; this.budgetMs = opts.budgetMs || 25; this.msHist = [];
    this.maxSquads = opts.maxSquads || 360;
    this.stats = { shots: 0, hits: 0, deaths: 0, skipped: 0, slept: 0, ms: 0, merged: 0 };
    // события тика
    this.ev = { shots: [], deaths: [], hurts: [], orders: [], spawns: [], removes: [], members: [] };
  }

  Battle.prototype.chunkOf = function(x, y) {
    var cx = Math.max(0, Math.min(this.map.cw - 1, Math.floor(x / CHUNK)));
    var cy = Math.max(0, Math.min(this.map.ch - 1, Math.floor(y / CHUNK)));
    return cy * this.map.cw + cx;
  };

  Battle.prototype.newSoldierId = function() {
    // id погибших берём снова не раньше чем через 30 с: браузер успеет «похоронить»
    if (this.freeIds.length && this.tick - this.sDiedAt[this.freeIds[0]] > 300) return this.freeIds.shift();
    if (this.nSoldiers >= this.cap) return -1;
    return this.nSoldiers++;
  };

  Battle.prototype.addSquad = function(typeN, x, y, count, opts) {
    opts = opts || {};
    var t = TYPES[typeN], members = [];
    for (var i = 0; i < count; i++) {
      var id = this.newSoldierId();
      if (id < 0) break;
      this.sType[id] = typeN; this.sSide[id] = t.side; this.sHp[id] = t.hp; this.sAlive[id] = 1;
      members.push(id);
    }
    if (!members.length) return null;
    var p = nearestFloor(this.map, x, y);
    var sq = this.makeSquad(t.side, typeN, members, p[0] + 0.5, p[1] + 0.5, opts.face != null ? opts.face : (t.side === 0 ? 0 : Math.PI));
    sq.keep = !!(opts.single || (count === 1 && t.single));
    sq.single = members.length === 1;
    this.ev.spawns.push(sq.id);
    return sq;
  };

  Battle.prototype.makeSquad = function(side, typeN, members, x, y, face) {
    var id = this.nextSquad++;
    if (this.nextSquad > 65000) this.nextSquad = 1;
    while (this.squads[this.nextSquad]) this.nextSquad++;
    var sq = { id: id, side: side, type: typeN, members: members, alive: members.length,
               x: x, y: y, face: face, dest: null, flow: null, target: 0, acc: 0, scan: 0,
               los: false, losAt: -99, single: members.length === 1, keep: false, home: 0,
               idle: 0, manual: 0, skip: 0, dtAcc: 0, moving: false, engaged: false, hold: false };
    this.squads[id] = sq; this.list.push(sq);
    for (var i = 0; i < members.length; i++) this.sSquad[members[i]] = id;
    return sq;
  };

  Battle.prototype.removeSquad = function(sq) {
    this.squads[sq.id] = null;
    var i = this.list.indexOf(sq); if (i >= 0) this.list.splice(i, 1);
    this.ev.removes.push(sq.id);
  };

  // ---------- приказы ----------
  Battle.prototype.orderMove = function(ids, x, y, side) {
    var group = [], i;
    for (i = 0; i < ids.length; i++) {
      var sq = this.squads[ids[i]];
      if (sq && (side == null || sq.side === side)) group.push(sq);
    }
    if (!group.length) return 0;
    // Несколько отрядов в одну точку — раскладываем их сеткой, не в кучу
    var cols = Math.ceil(Math.sqrt(group.length)), gap = 4;
    for (i = 0; i < group.length; i++) {
      var r = Math.floor(i / cols), c = i % cols;
      var ox = (c - (cols - 1) / 2) * gap, oy = (r - (Math.ceil(group.length / cols) - 1) / 2) * gap;
      if (group.length === 1) { ox = 0; oy = 0; }
      var p = nearestFloor(this.map, x + ox, y + oy);
      this.setDest(group[i], p[0], p[1]);
    }
    return group.length;
  };

  Battle.prototype.setDest = function(sq, cx, cy, keepRejoin) {
    if (!keepRejoin) sq.rejoin = 0;                     // новый приказ отменяет возврат в строй
    sq.dest = [cx, cy]; sq.idle = 0; sq.hold = false;
    sq.flow = this.flows.peek(cx, cy);
    if (sq.flow) this.ev.orders.push(sq.id);
    else if (this.flowWait.indexOf(sq) < 0) this.flowWait.push(sq);
  };

  // Поля направлений строим не больше бюджета за тик: много приказов разом
  // растягиваются на несколько тиков, без рывков. Первый — всегда.
  Battle.prototype.buildFlows = function() {
    var t0 = now(), q = this.flowWait, n = 0;
    while (q.length && (n === 0 || now() - t0 < this.flowBudgetMs)) {
      var sq = q.shift();
      if (!this.squads[sq.id] || !sq.dest) continue;
      sq.flow = this.flows.get(sq.dest[0], sq.dest[1]); n++;
      this.ev.orders.push(sq.id);
      // остальные, кто ждёт ту же точку, получают его бесплатно
      for (var i = q.length - 1; i >= 0; i--) {
        var o = q[i];
        if (o.dest && o.dest[0] === sq.dest[0] && o.dest[1] === sq.dest[1]) { o.flow = sq.flow; this.ev.orders.push(o.id); q.splice(i, 1); }
      }
    }
  };

  // Маршрут отряда для браузера: точки поворота по полю направлений.
  // Браузер ведёт знамя по ним сам, сервер шлёт только приказ.
  Battle.prototype.path = function(sq, max) {
    var pts = [], f = sq.flow, w = this.map.w;
    if (!sq.dest || !f) return pts;
    var cx = Math.floor(sq.x), cy = Math.floor(sq.y), last = -1, guard = 2048;
    max = max || 48;
    while (guard-- > 0) {
      var d = f.dir[cy * w + cx];
      if (d === 254 || d === 255 || (cx === sq.dest[0] && cy === sq.dest[1])) break;
      if (d !== last && last !== -1) { pts.push(cx, cy); if (pts.length >= max * 2) return pts; }
      last = d; cx += DX[d]; cy += DY[d];
    }
    pts.push(sq.dest[0], sq.dest[1]);
    return pts;
  };

  Battle.prototype.orderStop = function(sq) {
    sq.rejoin = 0;
    if (!sq.dest) return;
    sq.dest = null; sq.flow = null; this.ev.orders.push(sq.id);
    var i = this.flowWait.indexOf(sq); if (i >= 0) this.flowWait.splice(i, 1);
  };

  // Бойцов — в одиночки. Каждый выходит из строя «отрядом из одного»
  Battle.prototype.detach = function(soldiers, side) {
    var made = [];
    for (var i = 0; i < soldiers.length; i++) {
      var s = soldiers[i];
      if (typeof s !== 'number' || s !== (s | 0)) continue;     // только целые номера
      if (s < 0 || s >= this.nSoldiers || !this.sAlive[s]) continue;
      if (side != null && this.sSide[s] !== side) continue;
      var from = this.squads[this.sSquad[s]];
      if (!from || from.single) { if (from) made.push(from); continue; }
      var slot = from.members.indexOf(s);
      if (slot < 0) continue;
      var off = slotOffset(slot, from.members.length);
      var cs = Math.cos(from.face), sn = Math.sin(from.face);
      var px = from.x + off[0] * cs - off[1] * sn, py = from.y + off[0] * sn + off[1] * cs;
      from.members.splice(slot, 1); from.alive--;
      this.ev.members.push(from.id);
      var p = nearestFloor(this.map, px - 0.5, py - 0.5);
      var one = this.makeSquad(from.side, this.sType[s], [s], p[0] + 0.5, p[1] + 0.5, from.face);
      one.home = from.id; one.target = from.target;
      this.ev.spawns.push(one.id);
      made.push(one);
      if (!from.members.length) this.removeSquad(from);
    }
    return made;
  };

  // Вернуть одиночку в строй: в свой отряд, а если его нет — к ближайшему такому же
  Battle.prototype.regroup = function(sq) {
    if (!sq || !sq.single) return false;
    var home = this.squads[sq.home];
    if (!home || home.side !== sq.side || home.type !== sq.type) home = this.nearestKin(sq, 1e9);
    if (!home) return false;
    var dx = home.x - sq.x, dy = home.y - sq.y;
    if (dx * dx + dy * dy > 16) {          // далеко — сначала идти к строю
      this.setDest(sq, Math.floor(home.x), Math.floor(home.y));
      sq.rejoin = home.id;
      return true;
    }
    this.merge(sq, home);
    return true;
  };

  Battle.prototype.nearestKin = function(sq, maxD2) {
    var best = null, bd = maxD2;
    for (var i = 0; i < this.list.length; i++) {
      var o = this.list[i];
      if (o === sq || o.single || o.side !== sq.side || o.type !== sq.type || o.members.length >= 16) continue;
      var dx = o.x - sq.x, dy = o.y - sq.y, d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = o; }
    }
    return best;
  };

  Battle.prototype.merge = function(one, into) {
    for (var i = 0; i < one.members.length; i++) {
      into.members.push(one.members[i]); this.sSquad[one.members[i]] = into.id;
    }
    into.alive += one.alive;
    one.members = []; one.alive = 0;
    this.removeSquad(one);
    this.ev.members.push(into.id);
    this.stats.merged++;
  };

  // ---------- шаг расчёта ----------
  Battle.prototype.step = function() {
    var t0 = now(), map = this.map, i, sq;
    this.tick++;
    var ev = this.ev;
    // 1. Чанки: кто где стоит
    var cs = this.chunkSquads, s0 = this.chunkSide[0], s1 = this.chunkSide[1];
    for (i = 0; i < cs.length; i++) cs[i].length = 0;
    s0.fill(0); s1.fill(0);
    for (i = 0; i < this.list.length; i++) {
      sq = this.list[i];
      sq.chunk = this.chunkOf(sq.x, sq.y);
      cs[sq.chunk].push(sq);
      (sq.side === 0 ? s0 : s1)[sq.chunk] += sq.alive;
    }
    this.buildFlows();
    // 2. Нагрузка: если не укладываемся — спокойные места реже
    var lodEvery = 1 << this.lod;
    var cw = map.cw;
    var list = this.list.slice();
    for (i = 0; i < list.length; i++) {
      sq = list[i];
      if (this.squads[sq.id] !== sq) continue;
      var cx = sq.chunk % cw, cy = (sq.chunk - cx) / cw;
      var foes = this.enemyNear(sq.side, cx, cy);
      if (!foes && !sq.dest) {           // спит: врагов рядом нет, идти некуда
        sq.engaged = false; sq.moving = false; sq.target = 0; sq.dtAcc = 0;
        sq.idle += TICK;
        this.stats.slept++;
        continue;
      }
      var quiet = !foes || (!sq.engaged && !this.hot[sq.chunk]);
      sq.dtAcc += TICK;
      if (quiet && lodEvery > 1 && ((this.tick + sq.id) % lodEvery) !== 0) { this.stats.skipped++; continue; }
      var dt = sq.dtAcc; sq.dtAcc = 0;
      this.move(sq, dt);
      if (this.squads[sq.id] !== sq) continue;           // влился в строй по пути
      if (foes) this.fight(sq, dt); else { sq.engaged = false; sq.target = 0; }
      if (!sq.dest && !sq.engaged) sq.idle += dt; else sq.idle = 0;
    }
    // 3. Пик: одиночки, отставшие от боя, сами возвращаются в строй
    if (this.list.length > this.maxSquads || this.lod > 0) this.autoMerge();
    // 4. Учёт времени
    var ms = now() - t0;
    this.stats.ms = ms;
    this.msHist.push(ms); if (this.msHist.length > 20) this.msHist.shift();
    if (this.tick % 10 === 0) {
      var avg = 0; for (i = 0; i < this.msHist.length; i++) avg += this.msHist[i]; avg /= this.msHist.length;
      if (avg > this.budgetMs && this.lod < 3) this.lod++;
      else if (avg < this.budgetMs / 3 && this.lod > 0) this.lod--;
    }
    return ev;
  };

  Battle.prototype.enemyNear = function(side, cx, cy) {
    var arr = this.chunkSide[1 - side], cw = this.map.cw, ch = this.map.ch, n = 0;
    for (var y = cy - 1; y <= cy + 1; y++) {
      if (y < 0 || y >= ch) continue;
      for (var x = cx - 1; x <= cx + 1; x++) {
        if (x < 0 || x >= cw) continue;
        n += arr[y * cw + x];
      }
    }
    return n;
  };

  Battle.prototype.move = function(sq, dt) {
    if (!sq.dest || !sq.flow) { sq.moving = false; return; }   // без поля — ждёт свой тик
    var t = TYPES[sq.type], map = this.map, w = map.w;
    var step = t.speed * dt * (sq.engaged ? 0.75 : 1);
    var guard = 4;
    while (step > 0 && guard-- > 0) {
      var cx = Math.floor(sq.x), cy = Math.floor(sq.y), c = cy * w + cx;
      var d = sq.flow.dir[c];
      var gx, gy;
      if (d === 254 || (cx === sq.dest[0] && cy === sq.dest[1])) { gx = sq.dest[0] + 0.5; gy = sq.dest[1] + 0.5; }
      else if (d === 255) { this.arrive(sq); return; }        // путь закрыт
      else { gx = cx + DX[d] + 0.5; gy = cy + DY[d] + 0.5; }
      var dx = gx - sq.x, dy = gy - sq.y, L = Math.sqrt(dx * dx + dy * dy);
      if (L < 1e-4) {
        if (d === 254 || (cx === sq.dest[0] && cy === sq.dest[1])) { this.arrive(sq); return; }
        break;
      }
      var face = Math.atan2(dy, dx);
      sq.face = turn(sq.face, face, 4 * dt);
      var k = Math.min(1, step / L);
      sq.x += dx * k; sq.y += dy * k; step -= L * k;
      sq.moving = true;
    }
  };

  Battle.prototype.arrive = function(sq) {
    sq.dest = null; sq.flow = null; sq.moving = false;
    this.ev.orders.push(sq.id);
    if (sq.rejoin) {
      var home = this.squads[sq.rejoin]; sq.rejoin = 0;
      if (home && home.side === sq.side && home.type === sq.type) this.merge(sq, home);
    }
  };

  function turn(cur, to, step) {
    var d = to - cur;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return Math.abs(d) <= step ? to : cur + (d > 0 ? step : -step);
  }

  Battle.prototype.fight = function(sq, dt) {
    var t = TYPES[sq.type], map = this.map, tg = this.squads[sq.target];
    sq.scan -= dt;
    if (!tg || tg.side === sq.side || sq.scan <= 0) {
      sq.scan = 0.5 + this.R() * 0.2;
      var nt = this.findTarget(sq, t.range);
      if (nt !== tg) { tg = nt; sq.target = tg ? tg.id : 0; sq.losAt = -99; }
    }
    if (!tg) { sq.engaged = false; return; }
    var dx = tg.x - sq.x, dy = tg.y - sq.y, dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > t.range + 1.5) { sq.engaged = false; return; }
    if (this.tick - sq.losAt >= 10) { sq.los = sees(map, sq.x, sq.y, tg.x, tg.y); sq.losAt = this.tick; }
    if (!sq.los) { sq.engaged = false; return; }
    sq.engaged = true;
    if (!sq.moving) sq.face = turn(sq.face, Math.atan2(dy, dx), 3 * dt);
    // выстрелы отряда за тик
    var mv = sq.moving ? t.moveFire : 1;
    sq.acc += sq.alive * t.rof * dt * mv;
    var n = Math.floor(sq.acc);
    if (n <= 0) return;
    sq.acc -= n;
    // укрытие цели: клетка между целью и стрелком
    var ux = dx / (dist || 1), uy = dy / (dist || 1);
    var bx = Math.floor(tg.x - ux * 1.1), by = Math.floor(tg.y - uy * 1.1);
    var cover = (bx >= 0 && by >= 0 && bx < map.w && by < map.h && map.cells[by * map.w + bx] !== FLOOR) ? 0.55 : 1;
    var p = t.acc * Math.max(0.25, Math.min(1, 1.15 - (dist / t.range) * 0.5)) * cover * (tg.moving ? 0.85 : 1);
    var hits = 0;
    if (n <= 24) { for (var k = 0; k < n; k++) if (this.R() < p) hits++; }
    else {                                 // много выстрелов — нормальное приближение
      var m = n * p, sd = Math.sqrt(n * p * (1 - p));
      var z = (this.R() + this.R() + this.R() - 1.5) * 2;
      hits = Math.max(0, Math.min(n, Math.round(m + z * sd)));
    }
    this.stats.shots += n; this.stats.hits += hits;
    this.ev.shots.push(sq.id, tg.id, Math.min(255, n), Math.min(255, hits));
    for (var h = 0; h < hits && tg.alive > 0; h++) this.hurt(tg, t.dmg);
  };

  Battle.prototype.findTarget = function(sq, range) {
    var cw = this.map.cw, ch = this.map.ch;
    var cx = sq.chunk % cw, cy = (sq.chunk - cx) / cw;
    var best = [], R2 = (range + 1.5) * (range + 1.5);
    for (var y = cy - 1; y <= cy + 1; y++) {
      if (y < 0 || y >= ch) continue;
      for (var x = cx - 1; x <= cx + 1; x++) {
        if (x < 0 || x >= cw) continue;
        var arr = this.chunkSquads[y * cw + x];
        for (var i = 0; i < arr.length; i++) {
          var o = arr[i];
          if (o.side === sq.side || o.alive <= 0 || this.squads[o.id] !== o) continue;
          var dx = o.x - sq.x, dy = o.y - sq.y, d = dx * dx + dy * dy;
          if (d <= R2) best.push(d, o);
        }
      }
    }
    if (!best.length) return null;
    // ближайшие 3 — проверяем видимость
    for (var tries = 0; tries < 3 && best.length; tries++) {
      var bi = 0;
      for (var j = 2; j < best.length; j += 2) if (best[j] < best[bi]) bi = j;
      var cand = best[bi + 1];
      if (sees(this.map, sq.x, sq.y, cand.x, cand.y)) return cand;
      best.splice(bi, 2);
    }
    return null;
  };

  Battle.prototype.hurt = function(tg, dmg) {
    var m = tg.members;
    if (!m.length || this.squads[tg.id] !== tg) return;
    var idx = Math.floor(this.R() * m.length), s = m[idx];
    var hp = this.sHp[s] - dmg;
    if (hp > 0) { this.sHp[s] = hp; this.ev.hurts.push(s); return; }
    this.sHp[s] = 0; this.sAlive[s] = 0; this.sDiedAt[s] = this.tick;
    m.splice(idx, 1); tg.alive--;
    this.freeIds.push(s);
    this.ev.deaths.push(s);
    this.stats.deaths++;
    if (!m.length) this.removeSquad(tg);
  };

  Battle.prototype.autoMerge = function() {
    var n = 0;
    for (var i = this.list.length - 1; i >= 0 && n < 20; i--) {
      var sq = this.list[i];
      if (!sq.single || sq.keep || sq.manual > this.tick || sq.dest || sq.engaged || sq.idle < 8) continue;
      var home = this.squads[sq.home];
      if (!home || home.side !== sq.side || home.type !== sq.type) home = this.nearestKin(sq, 36);
      if (!home) continue;
      var dx = home.x - sq.x, dy = home.y - sq.y;
      if (dx * dx + dy * dy > 36) continue;
      this.merge(sq, home); n++;
    }
  };

  Battle.prototype.clearEvents = function() {
    var e = this.ev;
    e.shots.length = 0; e.deaths.length = 0; e.hurts.length = 0; e.orders.length = 0;
    e.spawns.length = 0; e.removes.length = 0; e.members.length = 0;
  };

  Battle.prototype.counts = function() {
    var c = [0, 0], sq = [0, 0], singles = 0;
    for (var i = 0; i < this.list.length; i++) {
      var s = this.list[i]; c[s.side] += s.alive; sq[s.side]++; if (s.single) singles++;
    }
    return { troops: c, squads: sq, singles: singles, total: c[0] + c[1] };
  };

  // Снимок по чанкам: что изменилось с прошлого раза
  Battle.prototype.snapshotChunks = function(prev) {
    var by = {}, i, k;
    for (i = 0; i < this.list.length; i++) {
      var sq = this.list[i], key = 'c:' + (sq.chunk % this.map.cw) + ':' + Math.floor(sq.chunk / this.map.cw);
      var hp = []; for (var j = 0; j < sq.members.length; j++) hp.push(this.sHp[sq.members[j]]);
      (by[key] = by[key] || []).push([sq.id, sq.side, TYPES[sq.type].id, Math.round(sq.x * 10) / 10, Math.round(sq.y * 10) / 10,
        sq.dest ? sq.dest[0] : -1, sq.dest ? sq.dest[1] : -1, sq.single ? 1 : 0, hp]);
    }
    var out = {}, json = {};
    for (k in by) { json[k] = JSON.stringify(by[k]); if (!prev || prev[k] !== json[k]) out[k] = by[k]; }
    if (prev) for (k in prev) if (!json[k]) out[k] = null;
    return { changed: out, json: json };
  };

  // ---------- сеть: компактный двоичный формат ----------
  var MSG = { INIT: 1, TICK: 2, SYNC: 3, STAT: 4 };

  function Writer(size) { this.b = new ArrayBuffer(size || 1024); this.v = new DataView(this.b); this.o = 0; }
  Writer.prototype.need = function(n) {
    if (this.o + n <= this.b.byteLength) return;
    var nb = new ArrayBuffer(Math.max(this.b.byteLength * 2, this.o + n));
    new Uint8Array(nb).set(new Uint8Array(this.b, 0, this.o));
    this.b = nb; this.v = new DataView(nb);
  };
  Writer.prototype.u8 = function(x) { this.need(1); this.v.setUint8(this.o, x); this.o += 1; };
  Writer.prototype.u16 = function(x) { this.need(2); this.v.setUint16(this.o, x, true); this.o += 2; };
  Writer.prototype.u32 = function(x) { this.need(4); this.v.setUint32(this.o, x, true); this.o += 4; };
  Writer.prototype.pos = function(x) { this.u16(Math.max(0, Math.min(65535, Math.round(x * 64)))); };
  Writer.prototype.done = function() { return this.b.slice(0, this.o); };

  function Reader(buf) { this.v = new DataView(buf); this.o = 0; }
  Reader.prototype.u8 = function() { var x = this.v.getUint8(this.o); this.o += 1; return x; };
  Reader.prototype.u16 = function() { var x = this.v.getUint16(this.o, true); this.o += 2; return x; };
  Reader.prototype.u32 = function() { var x = this.v.getUint32(this.o, true); this.o += 4; return x; };
  Reader.prototype.pos = function() { return this.u16() / 64; };

  function utf8(str) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
    return new Uint8Array(Buffer.from(str, 'utf8'));
  }
  function fromUtf8(u8) {
    if (typeof TextDecoder !== 'undefined') return new TextDecoder().decode(u8);
    return Buffer.from(u8).toString('utf8');
  }

  function squadInit(b, sq) {
    return [sq.id, sq.side, sq.type, Math.round(sq.x * 64) / 64, Math.round(sq.y * 64) / 64,
            Math.round(sq.face * 100) / 100, sq.dest ? sq.dest[0] : -1, sq.dest ? sq.dest[1] : -1,
            sq.single ? 1 : 0, sq.keep ? 1 : 0, sq.members.slice(), b.path(sq, 48)];
  }

  function encodeInit(b, side, extra) {
    var sqs = [], hp = [], i;
    for (i = 0; i < b.list.length; i++) sqs.push(squadInit(b, b.list[i]));
    for (i = 0; i < b.nSoldiers; i++) hp.push(b.sAlive[i] ? b.sHp[i] : 0);
    var json = JSON.stringify({ w: b.map.w, h: b.map.h, seed: b.map.seed, tick: b.tick, side: side,
                                types: TYPES, squads: sqs, hp: hp, extra: extra || null });
    var body = utf8(json), out = new Uint8Array(body.length + 1);
    out[0] = MSG.INIT; out.set(body, 1);
    return out.buffer;
  }

  // Подробности тика — с учётом того, на какие чанки смотрит игрок (sub)
  function encodeTick(b, sub) {
    var e = b.ev, w = new Writer(256), i, n, at;
    w.u8(MSG.TICK); w.u32(b.tick);
    // выстрелы: только если стрелок или цель в кадре игрока
    at = w.o; w.u16(0); n = 0;
    for (i = 0; i < e.shots.length; i += 4) {
      var a = b.squads[e.shots[i]], t = b.squads[e.shots[i + 1]];
      if (sub && !(a && sub[a.chunk]) && !(t && sub[t.chunk])) continue;
      w.u16(e.shots[i]); w.u16(e.shots[i + 1]); w.u8(e.shots[i + 2]); w.u8(e.shots[i + 3]); n++;
    }
    w.v.setUint16(at, n, true);
    // гибель — всем (сводка численности без неё врала бы)
    w.u16(e.deaths.length);
    for (i = 0; i < e.deaths.length; i++) w.u16(e.deaths[i]);
    // ранения — только в кадре
    at = w.o; w.u16(0); n = 0;
    for (i = 0; i < e.hurts.length; i++) {
      var s = e.hurts[i];
      if (!b.sAlive[s]) continue;
      var sq = b.squads[b.sSquad[s]];
      if (sub && !(sq && sub[sq.chunk])) continue;
      w.u16(s); w.u16(b.sHp[s]); n++;
    }
    w.v.setUint16(at, n, true);
    // приказы: куда идёт отряд (браузер ведёт его по тому же полю направлений)
    var seen = {};
    at = w.o; w.u16(0); n = 0;
    for (i = 0; i < e.orders.length; i++) {
      var o = b.squads[e.orders[i]];
      if (!o || seen[o.id]) continue; seen[o.id] = 1;
      var pts = b.path(o, 48);
      w.u16(o.id); w.pos(o.x); w.pos(o.y); w.u8((o.engaged ? 1 : 0));
      w.u8(pts.length / 2);
      for (var pi = 0; pi < pts.length; pi++) w.u16(pts[pi]);
      n++;
    }
    w.v.setUint16(at, n, true);
    // новые отряды (одиночки, подкрепление)
    at = w.o; w.u16(0); n = 0;
    for (i = 0; i < e.spawns.length; i++) {
      var p = b.squads[e.spawns[i]];
      if (!p) continue;
      w.u16(p.id); w.u8(p.side); w.u8(p.type); w.u8((p.single ? 1 : 0) | (p.keep ? 2 : 0));
      w.pos(p.x); w.pos(p.y); w.u16(Math.round(((p.face % 6.2832) + 6.2832) % 6.2832 * 1000));
      w.u16(p.members.length);
      for (var k = 0; k < p.members.length; k++) { w.u16(p.members[k]); w.u16(b.sHp[p.members[k]]); }
      n++;
    }
    w.v.setUint16(at, n, true);
    // смена состава (боец вышел из строя или вернулся)
    seen = {};
    at = w.o; w.u16(0); n = 0;
    for (i = 0; i < e.members.length; i++) {
      var q = b.squads[e.members[i]];
      if (!q || seen[q.id]) continue; seen[q.id] = 1;
      w.u16(q.id); w.u16(q.members.length);
      for (var j = 0; j < q.members.length; j++) w.u16(q.members[j]);
      n++;
    }
    w.v.setUint16(at, n, true);
    // исчезнувшие отряды
    w.u16(e.removes.length);
    for (i = 0; i < e.removes.length; i++) w.u16(e.removes[i]);
    return w.done();
  }

  // Сводка раз в секунду: где знамёна всех отрядов
  function encodeSync(b) {
    var w = new Writer(16 + b.list.length * 9);
    w.u8(MSG.SYNC); w.u32(b.tick); w.u16(b.list.length);
    for (var i = 0; i < b.list.length; i++) {
      var sq = b.list[i];
      w.u16(sq.id); w.pos(sq.x); w.pos(sq.y);
      w.u8((sq.moving ? 1 : 0) | (sq.engaged ? 2 : 0) | (sq.single ? 4 : 0));
      w.u16(sq.target || 0);
    }
    return w.done();
  }

  function encodeStat(obj) {
    var body = utf8(JSON.stringify(obj)), out = new Uint8Array(body.length + 1);
    out[0] = MSG.STAT; out.set(body, 1);
    return out.buffer;
  }

  function decode(buf) {
    var u8 = new Uint8Array(buf), type = u8[0];
    if (type === MSG.INIT || type === MSG.STAT) return { t: type, d: JSON.parse(fromUtf8(u8.subarray(1))) };
    var r = new Reader(buf), i, n, k;
    r.u8();
    if (type === MSG.SYNC) {
      var tick = r.u32(); n = r.u16(); var sq = [];
      for (i = 0; i < n; i++) sq.push({ id: r.u16(), x: r.pos(), y: r.pos(), f: r.u8(), tg: r.u16() });
      return { t: type, tick: tick, squads: sq };
    }
    var m = { t: type, tick: r.u32(), shots: [], deaths: [], hurts: [], orders: [], spawns: [], members: [], removes: [] };
    n = r.u16(); for (i = 0; i < n; i++) m.shots.push(r.u16(), r.u16(), r.u8(), r.u8());
    n = r.u16(); for (i = 0; i < n; i++) m.deaths.push(r.u16());
    n = r.u16(); for (i = 0; i < n; i++) m.hurts.push(r.u16(), r.u16());
    n = r.u16(); for (i = 0; i < n; i++) {
      var id = r.u16(), x = r.pos(), y = r.pos(), fl = r.u8(), np = r.u8(), pts = [];
      for (k = 0; k < np * 2; k++) pts.push(r.u16());
      m.orders.push({ id: id, x: x, y: y, fl: fl, path: pts });
    }
    n = r.u16(); for (i = 0; i < n; i++) {
      var sp = { id: r.u16(), side: r.u8(), type: r.u8(), fl: r.u8(), x: r.pos(), y: r.pos(), face: r.u16() / 1000, members: [], hp: [] };
      k = r.u16(); for (var j = 0; j < k; j++) { sp.members.push(r.u16()); sp.hp.push(r.u16()); }
      m.spawns.push(sp);
    }
    n = r.u16(); for (i = 0; i < n; i++) {
      var mm = { id: r.u16(), members: [] };
      k = r.u16(); for (var jj = 0; jj < k; jj++) mm.members.push(r.u16());
      m.members.push(mm);
    }
    n = r.u16(); for (i = 0; i < n; i++) m.removes.push(r.u16());
    return m;
  }

  // ---------- комната: бой + игроки ----------
  // Без сети: транспорт (WebSocket на сервере, Worker в прототипе) передаёт
  // сюда клиента с методом send(ArrayBuffer) и полем side.
  function Room(opts) {
    this.battle = opts.battle;
    this.ai = opts.ai || null;
    this.clients = [];
    this.bytes = 0; this.bytesWin = 0; this.bytesRate = 0; this.winStart = now();
    this.name = opts.name || 'room';
    this.extra = opts.extra || null;
  }

  Room.prototype.join = function(client) {
    client.sub = null; client.subRect = null;
    this.clients.push(client);
    this.send(client, encodeInit(this.battle, client.side, this.extra));
  };
  Room.prototype.leave = function(client) {
    var i = this.clients.indexOf(client); if (i >= 0) this.clients.splice(i, 1);
    this.updateHot();
  };
  Room.prototype.send = function(c, buf) {
    this.bytes += buf.byteLength; this.bytesWin += buf.byteLength;
    c.bytes = (c.bytes || 0) + buf.byteLength;
    c.send(buf);
  };

  // Подписка: прямоугольник чанков в кадре + кайма в один чанк
  Room.prototype.subscribe = function(client, rect) {
    var m = this.battle.map, sub = new Uint8Array(m.cw * m.ch);
    var x0 = Math.max(0, (rect[0] | 0) - 1), y0 = Math.max(0, (rect[1] | 0) - 1);
    var x1 = Math.min(m.cw - 1, (rect[2] | 0) + 1), y1 = Math.min(m.ch - 1, (rect[3] | 0) + 1);
    for (var y = y0; y <= y1; y++) for (var x = x0; x <= x1; x++) sub[y * m.cw + x] = 1;
    client.sub = sub; client.subRect = [x0, y0, x1, y1];
    this.updateHot();
  };
  Room.prototype.updateHot = function() {
    var hot = this.battle.hot; hot.fill(0);
    for (var i = 0; i < this.clients.length; i++) {
      var s = this.clients[i].sub; if (!s) continue;
      for (var k = 0; k < s.length; k++) if (s[k]) hot[k] = 1;
    }
  };

  // Приказ игрока. Свои отряды — только своей стороны
  Room.prototype.command = function(client, m) {
    var b = this.battle, side = client.side, i, sq, ok = 0;
    if (!m || typeof m !== 'object') return;
    if (m.t === 'sub' && Array.isArray(m.r) && m.r.length === 4) { this.subscribe(client, m.r); return; }
    if (m.t !== 'order') return;
    var ids = Array.isArray(m.sq) ? m.sq.slice(0, 400).filter(function(v) { return typeof v === 'number' && v === (v | 0) && v > 0; }) : [];
    if (m.x != null) m.x = +m.x; if (m.y != null) m.y = +m.y;
    if (isFinite(m.x)) m.x = Math.max(0, Math.min(b.map.w - 1, m.x));
    if (isFinite(m.y)) m.y = Math.max(0, Math.min(b.map.h - 1, m.y));
    var until = b.tick + 600;   // приказ игрока: ИИ не трогает отряд минуту
    if (m.k === 'move' && isFinite(m.x) && isFinite(m.y)) {
      for (i = 0; i < ids.length; i++) { sq = b.squads[ids[i]]; if (sq && sq.side === side) sq.manual = until; }
      ok = b.orderMove(ids, +m.x, +m.y, side);
    } else if (m.k === 'stop') {
      for (i = 0; i < ids.length; i++) { sq = b.squads[ids[i]]; if (sq && sq.side === side) { sq.manual = until; b.orderStop(sq); ok++; } }
    } else if (m.k === 'detach' && Array.isArray(m.s)) {
      var made = b.detach(m.s.slice(0, 200), side);
      for (i = 0; i < made.length; i++) made[i].manual = until;
      if (isFinite(m.x) && isFinite(m.y) && made.length) {
        var mids = []; for (i = 0; i < made.length; i++) mids.push(made[i].id);
        b.orderMove(mids, +m.x, +m.y, side);
      }
      ok = made.length;
    } else if (m.k === 'regroup') {
      for (i = 0; i < ids.length; i++) { sq = b.squads[ids[i]]; if (sq && sq.side === side && b.regroup(sq)) ok++; }
    }
    return ok;
  };

  Room.prototype.step = function() {
    var b = this.battle;
    if (this.ai) this.ai.think(b);
    b.step();
    var i, c;
    for (i = 0; i < this.clients.length; i++) { c = this.clients[i]; this.send(c, encodeTick(b, c.sub)); }
    if (b.tick % SYNC_EVERY === 0 && this.clients.length) {
      var sync = encodeSync(b);
      for (i = 0; i < this.clients.length; i++) this.send(this.clients[i], sync);
    }
    b.clearEvents();
    var t = now();
    if (t - this.winStart >= 1000) {
      this.bytesRate = this.bytesWin * 1000 / (t - this.winStart);
      this.bytesWin = 0; this.winStart = t;
    }
  };

  Room.prototype.statFor = function(extra) {
    var b = this.battle, cnt = b.counts(), s = b.stats;
    var o = { tick: b.tick, ms: Math.round(s.ms * 100) / 100, lod: b.lod, troops: cnt.troops, squads: cnt.squads,
              singles: cnt.singles, clients: this.clients.length,
              bps: Math.round(this.bytesRate / Math.max(1, this.clients.length)),
              flows: b.flows.built, flowMs: Math.round(b.flows.ms) };
    if (extra) for (var k in extra) o[k] = extra[k];
    return encodeStat(o);
  };

  // ---------- сценарии нагрузки и простой ИИ ----------
  // p500 — обычный бой (~500 войск), p2000 — пиковый (~2000).
  var SCEN = {
    p500:  { w: 160, h: 160, perSide: 250 },
    p2000: { w: 256, h: 256, perSide: 1000 }
  };

  // Состав стороны: отряды по 8–16, плюс одиночки (снайперы, BX)
  function armyPlan(side, total) {
    var plan = [];
    if (side === 0) {
      var singles = Math.round(total * 0.04);
      for (var i = 0; i < singles; i++) plan.push([TYPE_BY_ID.rep_sniper, 1]);
      var left = total - singles, k = 0;
      while (left > 0) { var heavy = (k++ % 5 === 4), n = Math.min(left, heavy ? 8 : 12); plan.push([heavy ? TYPE_BY_ID.rep_heavy : TYPE_BY_ID.rep_dc15a, n]); left -= n; }
    } else {
      var sx = Math.round(total * 0.04);
      for (var j = 0; j < sx; j++) plan.push([TYPE_BY_ID.cis_bx, 1]);
      var rest = total - sx, q = 0;
      while (rest > 0) { var b2 = (q++ % 4 === 3), m = Math.min(rest, b2 ? 8 : 16); plan.push([b2 ? TYPE_BY_ID.cis_b2 : TYPE_BY_ID.cis_b1, m]); rest -= m; }
    }
    return plan;
  }

  function makeScenario(name, seed) {
    var sc = Object.prototype.hasOwnProperty.call(SCEN, name) ? SCEN[name] : SCEN.p500;
    seed = seed || 1977;
    var map = makeMap(sc.w, sc.h, seed);
    var b = new Battle({ map: map, seed: seed, cap: Math.max(4096, sc.perSide * 4) });
    var ai = new ProtoAI(b, sc, seed);
    ai.deploy(b, 0, sc.perSide); ai.deploy(b, 1, sc.perSide);
    b.clearEvents();
    return { battle: b, ai: ai, name: name, scen: sc };
  }

  function ProtoAI(b, sc, seed) {
    this.R = rng(seed * 7 + 3); this.sc = sc; this.target = sc.perSide; this.nextWave = [0, 0]; this.nextDetach = 50;
  }
  ProtoAI.prototype.base = function(side) {
    var m = this.sc;
    return side === 0 ? [8, m.h / 2] : [m.w - 9, m.h / 2];
  };
  ProtoAI.prototype.deploy = function(b, side, total) {
    var plan = armyPlan(side, total), base = this.base(side), R = this.R;
    for (var i = 0; i < plan.length; i++) {
      b.addSquad(plan[i][0], base[0] + (R() - 0.5) * 14, 6 + R() * (this.sc.h - 12), plan[i][1]);
    }
  };
  ProtoAI.prototype.nearFoe = function(b, sq) {
    var best = [], i;
    for (i = 0; i < b.list.length; i++) {
      var o = b.list[i]; if (o.side === sq.side) continue;
      var dx = o.x - sq.x, dy = o.y - sq.y; best.push([dx * dx + dy * dy, o]);
    }
    if (!best.length) return null;
    best.sort(function(a, c) { return a[0] - c[0]; });
    return best[Math.floor(this.R() * Math.min(4, best.length))][1];
  };
  ProtoAI.prototype.think = function(b) {
    var R = this.R, i, sq;
    if (b.tick % 10 !== 0) return;
    var cnt = b.counts();
    // Подкрепление: держим численность сторон около заданной
    for (var side = 0; side < 2; side++) {
      if (cnt.troops[side] < this.target * 0.75 && b.tick >= this.nextWave[side]) {
        this.nextWave[side] = b.tick + 150;
        var need = this.target - cnt.troops[side];
        var plan = armyPlan(side, need), base = this.base(side);
        for (i = 0; i < plan.length; i++) b.addSquad(plan[i][0], base[0] + (R() - 0.5) * 12, 6 + R() * (this.sc.h - 12), plan[i][1]);
      }
    }
    // Наступление: свободные отряды идут к противнику по случайным полосам
    for (i = 0; i < b.list.length; i++) {
      sq = b.list[i];
      if (sq.manual > b.tick || sq.dest || sq.engaged || sq.rejoin) continue;
      if (sq.idle < 2 + R() * 4) continue;
      // цель — один из ближайших отрядов противника; если их нет — к его базе
      var foeSq = this.nearFoe(b, sq), tx, ty;
      if (foeSq) {
        tx = sq.x + (foeSq.x - sq.x) * (0.6 + R() * 0.4); ty = sq.y + (foeSq.y - sq.y) * (0.6 + R() * 0.4);
      } else {
        var foe = this.base(1 - sq.side);
        tx = sq.x + (foe[0] - sq.x) * (0.25 + R() * 0.35); ty = Math.max(4, Math.min(this.sc.h - 5, sq.y + (R() - 0.5) * 40));
      }
      // точки на сетке 4×4: одно поле направлений на многих
      var p = nearestFloor(b.map, Math.round(tx / 4) * 4, Math.round(ty / 4) * 4);
      b.setDest(sq, p[0], p[1]);
    }
    // Одиночки: время от времени отряды выпускают бойцов в обход, потом возвращают
    if (b.tick >= this.nextDetach) {
      this.nextDetach = b.tick + 30;
      for (var tries = 0; tries < 3; tries++) {
        sq = b.list[Math.floor(R() * b.list.length)];
        if (!sq || sq.single || sq.members.length < 6) continue;
        var pick = sq.members.slice(0, 3);
        var made = b.detach(pick);
        for (var j = 0; j < made.length; j++) {
          var f = made[j], ang = R() * Math.PI * 2;
          var q = nearestFloor(b.map, f.x + Math.cos(ang) * 8, f.y + Math.sin(ang) * 8);
          b.setDest(f, q[0], q[1]);
          f.backAt = b.tick + 200 + Math.floor(R() * 200);
        }
      }
      for (i = 0; i < b.list.length; i++) {
        sq = b.list[i];
        if (sq.single && !sq.keep && sq.backAt && b.tick > sq.backAt && !sq.rejoin && sq.manual <= b.tick) { sq.backAt = 0; b.regroup(sq); }
      }
    }
  };

  return {
    CHUNK: CHUNK, TICK: TICK, SYNC_EVERY: SYNC_EVERY, FLOOR: FLOOR, WALL: WALL, COVER: COVER,
    TYPES: TYPES, TYPE_BY_ID: TYPE_BY_ID, MSG: MSG, DX: DX, DY: DY,
    rng: rng, makeMap: makeMap, buildFlow: buildFlow, FlowCache: FlowCache, passable: passable,
    nearestFloor: nearestFloor, sees: sees, slotOffset: slotOffset, turn: turn,
    Battle: Battle, Room: Room, ProtoAI: ProtoAI, makeScenario: makeScenario, SCEN: SCEN,
    encodeInit: encodeInit, encodeTick: encodeTick, encodeSync: encodeSync, encodeStat: encodeStat, decode: decode,
    now: now
  };
});
