/* Город (поселение) в наземке 2.0 — общий модуль для сервера и браузера.
 *
 * Город стоит в центре карты (GEO.town, 36×36), растёт с уровнем поселения:
 *   1 Посёлок       — площадь, один квартал, дворы; без стены
 *   2 Городок       — частокол 26×26, ворота юг и север, два квартала
 *   3 Город         — стена 32×32, четыре ворот, две башни (к полосе вторжения), три квартала
 *   4 Столица       — стена 36×36 (вся площадка), четыре ворот, четыре башни, четыре квартала
 * Кварталы — районы из игры (district_types): market, square, fields, warehouses, garrison,
 * hospital, comms, workshops. Незастроенные квадранты — дворы (дома и изгороди).
 * Стена — непроходимое укрытие (COVER): через неё стреляют с полукрытием, но не ходят;
 * ворота и башни — постройки движка (gate, tower) стороны хозяина планеты.
 *
 * apply(json, settle) → { map: карта с городом (слои распакованы), town: модель }
 *   settle: { level: 1..4, districts: [{ slot: 1..4, id: 'market' | ... }] }
 * Модель: { level, k, wall: [x, y, w, h] | null, gates: [{x, y, w, h, side}], towers: [{x, y}],
 *           districts: [{ id, slot, rect, yard, spawn }], blocks: [{ q, kind, rect }], square: [x, y, 8, 8] }
 * ES5, UMD.
 */
(function(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./rt-planets.js'));
  else root.SWTown = factory(root.SWPlanets);
})(typeof self !== 'undefined' ? self : this, function(P) {
  'use strict';
  var T = P.T, N = P.N;
  // Материалы города — своими номерами слоя m (с 8), чтобы не зависеть от палитры планеты
  var M = { wall: 8, palisade: 9, stall: 10, crate: 11, statue: 12, planter: 13, sandbag: 14, fence: 15, hedge: 16, pavement: 17, bldg: 18 };
  var MAT_NAME = {}; Object.keys(M).forEach(function(k) { MAT_NAME[M[k]] = k; });
  // Названия и игровые эффекты районов (district_types)
  var DISTRICTS = {
    market:     { name: 'Рынок',              effect: 'Торговые ряды: укрытые дворы' },
    square:     { name: 'Площадь',            effect: 'Парадная площадь: статуи-укрытия' },
    fields:     { name: 'Угодья',             effect: 'Грядки: лёгкое укрытие, пехота медленнее' },
    warehouses: { name: 'Склады',             effect: 'Кто держит — перезаряжается на четверть быстрее' },
    garrison:   { name: 'Казармы ополчения',  effect: 'Ополчение выходит из плаца; у врага в руках — не выходит' },
    hospital:   { name: 'Госпиталь',          effect: 'Кто держит — пехота внутри лечится, 1 % в секунду' },
    comms:      { name: 'Узел связи',         effect: 'Кто держит — видит всё в 24 клетках от центра' },
    workshops:  { name: 'Мастерские',         effect: 'Кто держит — техника внутри чинится, 1 % в секунду' }
  };
  var LEVEL_NAME = { 1: 'Посёлок', 2: 'Городок', 3: 'Город', 4: 'Столица округа' };
  var MILITIA_BASE = { 1: 1, 2: 2, 3: 3, 4: 4 };     // settlement_levels.militia_base; казармы +2
  // Облик по планете: стена и крыши
  var LOOK = {
    alderaan:      { wall: 'stone',   roof: 'gable',   c: [232, 226, 212], roofC: [168, 92, 66],  trim: [120, 110, 96] },
    anaxes:        { wall: 'metal',   roof: 'flat',    c: [128, 132, 136], roofC: [96, 100, 104],  trim: [70, 74, 78] },
    catoneimoidia: { wall: 'stone',   roof: 'dome',    c: [210, 196, 170], roofC: [150, 120, 90],  trim: [110, 90, 70] },
    christophsis:  { wall: 'crystal', roof: 'crystal', c: [150, 200, 230], roofC: [110, 180, 230], trim: [60, 120, 170] },
    corellia:      { wall: 'metal',   roof: 'flat',    c: [120, 112, 104], roofC: [90, 84, 78],    trim: [60, 56, 52] },
    coruscant:     { wall: 'metal',   roof: 'flat',    c: [132, 128, 124], roofC: [104, 100, 98],  trim: [70, 70, 74] },
    feorust:       { wall: 'metal',   roof: 'panel',   c: [136, 120, 100], roofC: [104, 90, 74],   trim: [72, 62, 52] },
    geonosis:      { wall: 'hive',    roof: 'organic', c: [168, 110, 76],  roofC: [140, 88, 60],   trim: [100, 62, 42] },
    hypori:        { wall: 'metal',   roof: 'flat',    c: [104, 100, 96],  roofC: [80, 78, 74],    trim: [52, 50, 48] },
    kamino:        { wall: 'metal',   roof: 'dome',    c: [214, 222, 228], roofC: [186, 198, 208], trim: [120, 136, 150] },
    kashyyyk:      { wall: 'wood',    roof: 'wood',    c: [118, 84, 54],   roofC: [96, 66, 40],    trim: [60, 42, 26] },
    kuat:          { wall: 'stone',   roof: 'gable',   c: [226, 220, 206], roofC: [90, 98, 112],   trim: [110, 110, 104] },
    maygito:       { wall: 'ice',     roof: 'flat',    c: [190, 206, 222], roofC: [150, 170, 196], trim: [96, 116, 146] },
    mustafar:      { wall: 'metal',   roof: 'panel',   c: [92, 84, 80],    roofC: [70, 62, 60],    trim: [40, 34, 32] },
    muunilinst:    { wall: 'stone',   roof: 'tier',    c: [196, 188, 172], roofC: [160, 150, 132], trim: [96, 88, 76] },
    naboo:         { wall: 'stone',   roof: 'dome',    c: [230, 222, 200], roofC: [110, 150, 120], trim: [130, 118, 96] },
    raxus:         { wall: 'stone',   roof: 'gable',   c: [200, 190, 206], roofC: [120, 96, 140],  trim: [90, 70, 100] },
    ryloth:        { wall: 'stone',   roof: 'flat',    c: [196, 150, 110], roofC: [160, 118, 84],  trim: [110, 76, 50] },
    umbara:        { wall: 'metal',   roof: 'flat',    c: [70, 66, 90],    roofC: [52, 48, 72],    trim: [120, 90, 190] },
    utapau:        { wall: 'stone',   roof: 'tier',    c: [176, 160, 136], roofC: [140, 126, 104], trim: [96, 84, 68] }
  };
  var DEF_LOOK = { wall: 'stone', roof: 'flat', c: [180, 176, 168], roofC: [120, 116, 110], trim: [80, 78, 74] };
  function look(id) { return LOOK[id] || DEF_LOOK; }

  function rng(seed) { var s = seed >>> 0 || 1; return function() { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
  function hashStr(str) { var h = 2166136261; for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

  // Размер по уровню: k — отступ стены от площади (площадь 66..73, стена 66−k .. 73+k)
  var K = { 1: 9, 2: 9, 3: 12, 4: 14 };
  var SQ = 8;

  function apply(json, settle, opts) {   // opts не используется
    settle = settle || {};
    var level = Math.max(1, Math.min(4, settle.level || 1)), map = P.load(json);
    var t = map.t, m = map.m, tw = map.town || P.GEO.town;
    var sx = tw[0] + (tw[2] >> 1) - (SQ >> 1), sy = tw[1] + (tw[3] >> 1) - (SQ >> 1);          // 66, 66
    var k = K[level], x0 = sx - k, y0 = sy - k, x1 = sx + SQ - 1 + k, y1 = sy + SQ - 1 + k;     // стена
    var R = rng(hashStr('town/' + (json.id || 'x') + '/' + level));
    var objs = (json.objs || []).slice();
    var town = { level: level, name: LEVEL_NAME[level], k: k, wall: null, gates: [], towers: [], districts: [], blocks: [], square: [sx, sy, SQ, SQ], cx: sx + SQ / 2, cy: sy + SQ / 2, look: look(json.id) };
    function set(x, y, code, mat) { if (x < 0 || y < 0 || x >= N || y >= N) return; var c = y * N + x; t[c] = code; m[c] = mat || 0; }
    function fill(x, y, w, h, code, mat) { for (var yy = y; yy < y + h; yy++) for (var xx = x; xx < x + w; xx++) set(xx, yy, code, mat); }
    function cellOk(x, y) { return t[y * N + x] === T.OPEN || t[y * N + x] === T.ROAD; }
    // --- улицы: крест 4 клетки (68..71) от стены до площади и мощёное кольцо вокруг площади
    var cxs = sx + 2, cw = 4;                                                                     // 68..71
    fill(cxs, y0, cw, y1 - y0 + 1, T.ROAD); fill(x0, cxs, x1 - x0 + 1, cw, T.ROAD);
    // с 3-го уровня — проспекты во всю ширину площади (8 клеток), мощёные
    if (level >= 3) { fill(sx, y0, SQ, y1 - y0 + 1, T.ROAD, M.pavement); fill(x0, sy, x1 - x0 + 1, SQ, T.ROAD, M.pavement); }
    fill(sx, sy, SQ, SQ, T.ROAD, M.pavement);
    // --- стена, ворота, башни
    if (level >= 2) {
      var wm = level === 2 ? M.palisade : M.wall;
      for (var x = x0; x <= x1; x++) { set(x, y0, T.COVER, wm); set(x, y1, T.COVER, wm); }
      for (var y = y0; y <= y1; y++) { set(x0, y, T.COVER, wm); set(x1, y, T.COVER, wm); }
      town.wall = [x0, y0, x1 - x0 + 1, y1 - y0 + 1];
      // кольцевая дорога внутри стены
      fill(x0 + 1, y0 + 1, x1 - x0 - 1, 2, T.ROAD); fill(x0 + 1, y1 - 2, x1 - x0 - 1, 2, T.ROAD);
      fill(x0 + 1, y0 + 1, 2, y1 - y0 - 1, T.ROAD); fill(x1 - 2, y0 + 1, 2, y1 - y0 - 1, T.ROAD);
      // ворота 3 клетки по оси улицы (69..71): юг и север всегда, запад и восток — с уровня 3
      var gx = cxs + 1;
      town.gates.push({ x: gx, y: y1, w: 3, h: 1, side: 'S' }); town.gates.push({ x: gx, y: y0, w: 3, h: 1, side: 'N' });
      if (level >= 3) { town.gates.push({ x: x0, y: gx, w: 1, h: 3, side: 'W' }); town.gates.push({ x: x1, y: gx, w: 1, h: 3, side: 'E' }); }
      town.gates.forEach(function(g) { fill(g.x, g.y, g.w, g.h, T.ROAD); });
      // башни 2×2 в углах внутри стены: уровень 3 — южные (к полосе вторжения), 4 — все
      if (level >= 3) { town.towers.push({ x: x0 + 1, y: y1 - 2 }); town.towers.push({ x: x1 - 2, y: y1 - 2 }); }
      if (level >= 4) { town.towers.push({ x: x0 + 1, y: y0 + 1 }); town.towers.push({ x: x1 - 2, y: y0 + 1 }); }
      town.towers.forEach(function(tw2) { objs.push({ k: 'bastion', x: tw2.x, y: tw2.y, w: 2, h: 2 }); });
      town.gates.forEach(function(g) { objs.push({ k: 'gateposts', x: g.x, y: g.y, w: g.w, h: g.h }); });
    }
    // --- кварталы: четыре квадранта между улицами и кольцом
    var bw = k - 3, inner = level >= 2 ? x0 + 3 : x0 + 1;
    if (level < 2) bw = k - 1;
    var quads = [
      { q: 'NW', rect: [inner, inner, bw, bw] },
      { q: 'NE', rect: [sx + SQ, inner, bw, bw] },
      { q: 'SW', rect: [inner, sy + SQ, bw, bw] },
      { q: 'SE', rect: [sx + SQ, sy + SQ, bw, bw] }
    ];
    // по слотам: 1 → NW, 2 → NE, 3 → SW, 4 → SE; только построенные (без building)
    var bySlot = {};
    (settle.districts || []).forEach(function(d) { if (d && d.id && DISTRICTS[d.id] && !d.building && d.slot >= 1 && d.slot <= 4) bySlot[d.slot] = d.id; });
    quads.forEach(function(qd, i) {
      var id = bySlot[i + 1], r = qd.rect, blk = { q: qd.q, kind: id || 'houses', rect: r };
      town.blocks.push(blk);
      var d = { id: blk.kind, q: qd.q, rect: r };
      // проход во двор — со стороны площади (внутренний угол), 2 клетки
      layout(blk.kind, r, d, qd.q, { set: set, fill: fill, R: R, objs: objs, level: level, cellOk: cellOk, look: town.look, id: json.id, t: t });
      if (id) { d.slot = i + 1; d.name = DISTRICTS[id].name; d.effect = DISTRICTS[id].effect; town.districts.push(d); }
    });
    var out = { id: json.id, v: json.v, w: map.w, h: map.h, seed: json.seed, town: tw, t: t, e: map.e, m: m, objs: objs, paths: json.paths || [], name: json.name, about: json.about, look: json.look, zones: json.zones, settle: town };
    return { map: out, town: town };
  }

  // Планировка квартала. Ограда с проходом к улице у площади; постройки — BLOCK + объект bldg.
  function layout(kind, r, d, q, g) {
    var x = r[0], y = r[1], w = r[2], h = r[3], set = g.set, fill = g.fill, R = g.R, objs = g.objs, level = g.level;
    var toS = q === 'SW' || q === 'SE', toE = q === 'NE' || q === 'SE';
    function bldg(bx, by, bw, bh, s, z) { fill(bx, by, bw, bh, T.BLOCK, M.bldg); objs.push({ k: 'bldg', x: bx, y: by, w: bw, h: bh, s: s || kind, z: z || 1, d: kind }); }
    // город с 3-го уровня — дворы мощёные
    if (level >= 3 && kind !== 'empty' && kind !== 'fields' && kind !== 'houses') fill(x, y, w, h, T.ROAD, M.pavement);
    // дома-пристройки: 2×2 на свободных местах с зазором в клетку, n штук
    function houses(n, style) {
      var cand = [];
      for (var py = y + 1; py + 2 <= y + h - 1; py += 3) for (var px = x + 1; px + 2 <= x + w - 1; px += 3) cand.push([px, py]);
      for (var i = cand.length - 1; i > 0; i--) { var j = Math.floor(R() * (i + 1)), tmp = cand[i]; cand[i] = cand[j]; cand[j] = tmp; }
      var placed = 0;
      for (var c = 0; c < cand.length && placed < n; c++) {
        var px2 = cand[c][0], py2 = cand[c][1], ok = true;
        for (var yy = py2 - 1; yy <= py2 + 2 && ok; yy++) for (var xx = px2 - 1; xx <= px2 + 2 && ok; xx++) { var cc = g.t[yy * N + xx]; if (cc === T.BLOCK || cc === T.COVER && (xx > x && xx < x + w - 1 && yy > y && yy < y + h - 1)) ok = false; }
        if (!ok) continue;
        bldg(px2, py2, 2, 2, style || 'house'); placed++;
      }
      return placed;
    }
    var dens = level >= 4 ? 1 : level === 3 ? 0.6 : 0.3, FEN = level >= 3 ? M.fence : M.hedge;   // в посёлке — живые изгороди, в городе — каменные
    // ограда по периметру с проходами: сторона к площади (внутренняя) — проход 3 клетки посередине
    function fence(mat, gaps) {
      for (var i = 0; i < w; i++) { set(x + i, y, T.COVER, mat); set(x + i, y + h - 1, T.COVER, mat); }
      for (var j = 0; j < h; j++) { set(x, y + j, T.COVER, mat); set(x + w - 1, y + j, T.COVER, mat); }
      gaps.forEach(function(gp) { fill(gp[0], gp[1], gp[2], gp[3], T.OPEN, 0); });
    }
    var midX = x + (w >> 1) - 1, midY = y + (h >> 1) - 1;
    var gapIn = toE ? [x, midY, 1, 3] : [x + w - 1, midY, 1, 3];                 // проход к улице-оси (к площади по x)
    var gapIn2 = toS ? [midX, y, 3, 1] : [midX, y + h - 1, 3, 1];                 // проход к улице-оси (по y)
    d.spawn = [toE ? x + 1 : x + w - 2, midY + 1];
    if (w < 5) { if (kind !== 'empty') bldg(x, y, w, h, kind); return; }
    switch (kind) {
      case 'market': {
        fence(FEN, [gapIn, gapIn2]);
        // павильон в дальнем углу, лавки, между ними ряды лотков через клетку
        var bx = toE ? x + w - 4 : x + 1, by = toS ? y + h - 4 : y + 1; bldg(bx, by, 3, 3, 'market');
        houses(w >= 9 ? Math.round(2 * dens) : 1, 'shop');
        for (var yy = y + 2; yy < y + h - 2; yy += 2) for (var xx = x + 2; xx < x + w - 2; xx += 2) {
          var near = false;
          for (var ny = yy - 1; ny <= yy + 1 && !near; ny++) for (var nx = xx - 1; nx <= xx + 1 && !near; nx++) if (g.t[ny * N + nx] === T.BLOCK) near = true;
          if (!near) set(xx, yy, T.COVER, M.stall);
        }
        break;
      }
      case 'square': {
        fill(x, y, w, h, T.ROAD, M.pavement);
        var cx = x + (w >> 1), cy = y + (h >> 1);
        fill(cx - 1, cy - 1, 2, 2, T.COVER, M.statue); objs.push({ k: 'fountain', x: cx, y: cy, r: 1.2 });
        [[x + 1, y + 1], [x + w - 2, y + 1], [x + 1, y + h - 2], [x + w - 2, y + h - 2]].forEach(function(p) { set(p[0], p[1], T.COVER, M.statue); });
        break;
      }
      case 'fields': {
        fence(M.hedge, [gapIn, gapIn2]);
        for (var fy = y + 1; fy < y + h - 1; fy++) if ((fy - y) % 2 === 1) for (var fx = x + 1; fx < x + w - 1; fx++) set(fx, fy, T.LIGHT, 0);
        var ax = toE ? x + w - 3 : x + 1, ay = toS ? y + h - 3 : y + 1; bldg(ax, ay, 2, 2, 'barn');
        if (w >= 8) { var ax2 = toE ? x + 1 : x + w - 3; bldg(ax2, ay, 2, 2, 'house'); }
        break;
      }
      case 'warehouses': {
        fence(FEN, [gapIn, gapIn2]);
        var ww = Math.max(2, w - 3), hh = Math.max(2, Math.floor((h - 4) / 2));
        bldg(x + 1, y + 1, ww, hh, 'warehouse'); bldg(x + 1, y + h - 1 - hh, ww, hh, 'warehouse');
        if (w >= 9) bldg(x + w - 3, y + 1 + hh + 1 - (hh > 2 ? 1 : 0), 2, 2, 'house');
        for (var cxx = x + 2; cxx < x + w - 1; cxx += 2) set(cxx, y + 1 + hh + 1, T.COVER, M.crate);
        break;
      }
      case 'garrison': {
        // казарма вдоль дальней стороны, плац, мешки с песком у входа; d.spawn — плац (выход ополчения)
        var depth = Math.max(2, Math.min(3, h - 4));
        if (toS) bldg(x + 1, y + h - 1 - depth, w - 2, depth, 'garrison'); else bldg(x + 1, y + 1, w - 2, depth, 'garrison');
        if (w >= 9) { var ax3 = toE ? x + w - 3 : x + 1, ay3 = toS ? y + 1 : y + h - 3; bldg(ax3, ay3, 2, 2, 'armory'); }
        var sy2 = toS ? y : y + h - 1;
        for (var sx2 = x; sx2 < x + w; sx2++) if (sx2 < midX || sx2 > midX + 2) set(sx2, sy2, T.COVER, M.sandbag);
        for (var j2 = y; j2 < y + h; j2++) { set(x, j2, T.COVER, M.sandbag); set(x + w - 1, j2, T.COVER, M.sandbag); }
        fill(gapIn[0], gapIn[1], gapIn[2], gapIn[3], T.OPEN, 0);
        d.spawn = [midX + 1, toS ? y + 1 : y + h - 2];
        break;
      }
      case 'hospital': {
        fence(FEN, [gapIn, gapIn2]);
        var hw = Math.max(3, Math.min(5, w - 4)), hh = Math.max(3, Math.min(5, h - 4));
        var hx = toE ? x + w - 2 - hw : x + 2, hy = toS ? y + h - 2 - hh : y + 2;
        bldg(hx, hy, hw, hh, 'hospital', 2);
        houses(w >= 9 ? Math.round(3 * dens) : 1);
        break;
      }
      case 'comms': {
        fence(FEN, [gapIn, gapIn2]);
        var ccx = x + (w >> 1) - 1, ccy = y + (h >> 1) - 1;
        bldg(ccx, ccy, 3, 3, 'comms', 3); objs.push({ k: 'antenna', x: ccx + 1.5, y: ccy + 1.5 });
        houses(w >= 8 ? 1 + Math.round(3 * dens) : 1);
        break;
      }
      case 'workshops': {
        fence(FEN, [gapIn, gapIn2]);
        var sw = Math.max(2, Math.floor((w - 4) / 2));
        bldg(x + 1, y + 1, sw, Math.max(2, h - 3), 'workshop'); bldg(x + w - 1 - sw, y + 1, sw, Math.max(2, h - 3), 'workshop');
        for (var cy2 = y + 2; cy2 < y + h - 1; cy2 += 2) set(x + 1 + sw + 1, cy2, T.COVER, M.crate);
        break;
      }
      case 'houses': {
        // дворы: 2–4 дома с изгородями, проходы со стороны улиц
        fence(M.hedge, [gapIn, gapIn2, toE ? [x, y + 1, 1, 2] : [x + w - 1, y + 1, 1, 2]]);
        houses(w >= 9 ? 3 + Math.round(5 * dens) : w >= 6 ? 2 + Math.round(2 * dens) : 1);
        if (w >= 8 && level < 3) set(x + (w >> 1), y + (h >> 1), T.COVER, M.planter);
        break;
      }
      default: break;   // empty — пусто
    }
  }

  return { apply: apply, DISTRICTS: DISTRICTS, LEVEL_NAME: LEVEL_NAME, MILITIA_BASE: MILITIA_BASE, M: M, MAT_NAME: MAT_NAME, LOOK: LOOK, look: look, K: K };
});
