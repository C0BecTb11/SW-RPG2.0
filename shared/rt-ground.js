// Наземный бой 2.0 — движок (общий для браузера и сервера, ES5).
//
// Карта — постоянная карта планеты (shared/planets, SWPlanets), бойцы и техника —
// из игры (shared/rt-units: unit_types и damage_matrix), повадки и приказы — как в
// абордаже (rt-board): отряды, точка игрока, цель игрока, «держать здесь», ИИ за
// отсутствующего. Единица — клетка поля, бойцы — как в rt-crew: радиус 0,3, поле
// направлений к цели, расталкивание по сетке клеток.
//
// Отличия от палубы: местность (скорость по клетке, укрытия и заросли, высоты и
// склоны, вода и лава), техника 2×2 с башней, воздух (над всем, не толкается),
// герои с ближним боем и способностями из игры (hero_abilities), артиллерия по
// площади, полевые постройки инженеров (окопы, бункеры, турели, радар, глушилка,
// маскировка), туман войны по обзору, захват площади города.
//
// Основной цикл: step(dt) → tick(STEP) с шагом 0,05 с: обзор → решения → ход и
// расталкивание → стрельба → герои → артиллерия → постройки → захват.

(function(root, factory) {
  var api = factory(
    typeof require === 'function' ? require('./rt-planets.js') : root.SWPlanets,
    typeof require === 'function' ? require('./rt-units.js') : root.SWUnits
  );
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SWGround = api;
})(typeof self !== 'undefined' ? self : this, function(P, U) {
  'use strict';

  var TAU = Math.PI * 2;
  var T = P.T, N = P.N;
  var DX = [1, 1, 0, -1, -1, -1, 0, 1], DY = [0, 1, 1, 1, 0, -1, -1, -1];
  var STEP = 0.05, R = 0.3;
  var RANGE_K = 3;                 // клетки дальности и обзора игры → клетки боя (бой крупнее: боец — клетка)
  var SCAN = 0.4, TURN = 7, LEGS = 9;
  var SABER = 1.4;                 // дальность светового меча
  var SLASH = 0.55;                // длительность удара мечом
  var DEATH_KEEP = 40;             // сколько секунд тело остаётся в списке
  var FOG_EVERY = 0.5, AI_EVERY = 2, CAP_EVERY = 0.5, SQ_MAX = 12;
  var SHELL_T = 2.4;               // полёт снаряда артиллерии, с
  var SQUARE = 8;                  // площадь города: SQUARE×SQUARE в центре
  var SPREAD = 0.9;                // шаг строя при приказе нескольким
  // Радиус расталкивания техники (клетки): по её виду сверху, чтобы машины не наезжали друг
  // на друга и на пехоту. Проходимость считается по-прежнему 2×2 клетки.
  var VRAD = { rep_atte: 1.5, rep_turbo: 1.5, rep_artillery: 1.5, cis_mtt: 1.5, cis_artillery: 1.4, cis_aat: 1.3, rep_aa: 1.2, cis_spider: 1.2, cis_missile: 1.2, rep_atrt: 0.6, rep_barc: 0.6, cis_stap: 0.5 };
  var DEF_NEAR = 7, DEF_FAR = 20;  // пояс обороны: расстояние от центра площади (клетки)
  var SORTIE = 18;                 // оборона бросается на прорвавшихся, если они ближе этого

  function rng(seed) { var s = seed >>> 0 || 1; return function() { s += 0x6D2B79F5; var t = s; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  function turn(cur, to, step) {
    var d = ((to - cur + Math.PI) % TAU + TAU) % TAU - Math.PI;
    if (Math.abs(d) <= step) return to;
    return cur + (d > 0 ? step : -step);
  }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  // Способности героев из игры (hero_abilities): [поза, цель, дальность (клеток игры), откат, сила, второе]
  var ABIL = {
    throw_light: ['throw', 'enemy', 4, 90, 4], throw_dark: ['throw', 'enemy', 4, 90, 4],
    dash_light: ['dash', 'enemy', 4, 90, 4], dash_dark: ['dash', 'enemy', 4, 90, 4],
    push_light: ['push', 'enemy', 2, 120, 3], push_dark: ['push', 'enemy', 2, 120, 3, 'damage'],
    lightning_dark: ['lightning', 'enemy', 3, 180, 120, 'stun'],
    drain_dark: ['choke', 'enemy', 1, 120, 70, 'drain'], choke_dark: ['choke', 'enemy', 3, 150, 90],
    fear_dark: ['mind', 'area', 3, 180, 3], mind_enslave: ['mind', 'enemy', 3, 600, 300], mind_suasion: ['mind', 'enemy', 3, 600, 300],
    pacify_light: ['mind', 'enemy', 3, 150, 2],
    heal_light: ['heal', 'ally', 1, 120, 80], barrier_light: ['barrier', 'self', 3, 180, 30],
    deflect_light: ['deflect', null, 0, 0, 30], atk_light: [null, null, 0, 0, 4], atk_dark: [null, null, 0, 0, 25],
    hp_light: [null, null, 0, 0, 60], hp_dark: [null, null, 0, 0, 60], evasion_light: [null, null, 0, 0, 10], evasion_dark: [null, null, 0, 0, 10],
    vision_light: [null, null, 0, 0, 3], vision_dark: [null, null, 0, 0, 3], absorb_dark: [null, null, 0, 0, 30]
  };
  var ABIL_NAME = { throw_light: 'Бросок меча', throw_dark: 'Клинок-палач', dash_light: 'Выпад', dash_dark: 'Бросок хищника', push_light: 'Толчок Силы',
    push_dark: 'Телекинетический бросок', lightning_dark: 'Удар молниями', drain_dark: 'Вытягивание жизни', choke_dark: 'Удушение', fear_dark: 'Волна страха',
    mind_enslave: 'Порабощение', mind_suasion: 'Внушение', pacify_light: 'Умиротворение', heal_light: 'Исцеление Силой', barrier_light: 'Защитный купол' };
  var ACTIVE_LIGHT = ['dash_light', 'push_light', 'throw_light', 'heal_light', 'barrier_light', 'pacify_light', 'mind_suasion'];
  var ACTIVE_DARK = ['dash_dark', 'push_dark', 'throw_dark', 'drain_dark', 'choke_dark', 'fear_dark', 'mind_enslave', 'lightning_dark'];

  // ---------------------------------------------------------------- поле направлений
  // Dijkstra от цели по проходимости рода войск; dir: 0..7 шаг, 254 — на месте, 255 — не дойти
  function Flows(g) { this.g = g; this.cache = {}; this.keys = []; this.MAX = 64; this.built = 0; this.ms = 0; }
  Flows.prototype.get = function(mv, size, tx, ty) {
    var key = mv + size + ':' + tx + ',' + ty, f = this.cache[key];
    if (f) { f.used = this.g.t; return f; }
    var t0 = Date.now();
    f = this.build(mv, size, tx, ty);
    this.cache[key] = f; this.keys.push(key); this.built++; this.ms += Date.now() - t0;
    if (this.keys.length > this.MAX) {
      var self = this; this.keys.sort(function(a, b) { return self.cache[a].used - self.cache[b].used; });
      while (this.keys.length > this.MAX * 0.75) delete this.cache[this.keys.shift()];
    }
    return f;
  };
  Flows.prototype.build = function(mv, size, tx, ty) {
    var g = this.g, ok = g.pass[mv + size], cost = g.costOf[mv], n = N * N;
    var dist = g._fd || (g._fd = new Int32Array(n)), dir = new Uint8Array(n);
    dist.fill(0x7fffffff); dir.fill(255);
    var buckets = g._fb || (g._fb = []), head = 0, cnt = 0;
    for (var i = 0; i < buckets.length; i++) buckets[i] = null;
    var goal = ty * N + tx;
    if (!ok[goal]) { var alt = g.nearestOk(mv, size, tx, ty); if (!alt) return { dir: dir, tx: tx, ty: ty, used: g.t }; goal = alt[1] * N + alt[0]; }
    dist[goal] = 0; dir[goal] = 254;
    (buckets[0] = buckets[0] || []).push(goal); cnt = 1;
    var air = mv === 'air', e = g.map.e, t = g.map.t;
    for (var d0 = 0; cnt > 0 && d0 < buckets.length + 1; d0++) {
      var b = buckets[d0]; if (!b) continue;
      for (var q = 0; q < b.length; q++) {
        var c = b[q]; cnt--;
        if (dist[c] !== d0) continue;
        var x = c % N, y = (c - x) / N;
        for (var k = 0; k < 8; k++) {
          var nx = x + DX[k], ny = y + DY[k];
          if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
          var nc = ny * N + nx;
          if (!ok[nc]) continue;
          if (k & 1) { if (!ok[y * N + nx] || !ok[ny * N + x]) continue; }        // углы не срезать
          if (!air) {
            // высоты: только через склон, по прямой
            var ea = e[nc], eb = e[c];
            if (ea !== eb) { if (k & 1 || Math.abs(ea - eb) > 1) continue; var lo = ea < eb ? nc : c; if (t[lo] !== T.RAMP) continue; }
          }
          var step = k & 1 ? Math.round(cost[nc] * 1.4) : cost[nc], nd = d0 + step;
          if (nd < dist[nc]) { dist[nc] = nd; dir[nc] = (k + 4) & 7; (buckets[nd] = buckets[nd] || []).push(nc); cnt++; }
        }
      }
      buckets[d0] = null;
    }
    return { dir: dir, tx: goal % N, ty: (goal - goal % N) / N, used: g.t };
  };

  // ---------------------------------------------------------------- бой
  function Ground(mapJson, opts) {
    opts = opts || {};
    var self = this;
    this.map = P.load(mapJson);
    this.id = mapJson.id; this.town = mapJson.town || P.GEO.town; this.zones = mapJson.zones || { deploy: [], slots: [] };
    this.R = rng(opts.seed || 7);
    this.t = 0; this.acc = 0; this.over = -1; this.why = '';
    this.agents = []; this.used = [];
    this.ev = { shots: [], booms: [], msgs: [], deaths: [], fx: [], shells: [] };
    this.seq = 0;
    this.teams = [{ auto: !!opts.auto0, squads: [] }, { auto: opts.auto1 == null ? true : !!opts.auto1, squads: [] }, { auto: true, squads: [] }];
    this.att = opts.att == null ? 0 : opts.att; this.def = 1 - this.att;      // кто штурмует планету
    this.capNeed = opts.captureSeconds || 21600;
    this.cap = { prog: 0, rate: 0, status: 'stalled', cnt: [0, 0] };
    this.structs = [];
    this.weather = P.WEATHER[this.id] ? P.WEATHER[this.id][1] : 0;
    // проходимость по роду войск и размеру; цена клетки = 1/скорость
    this.pass = {}; this.costOf = {};
    var m = this.map, n = N * N, k;
    ['foot', 'track', 'hover', 'air'].forEach(function(mv) {
      var c = new Int16Array(n), p1 = new Uint8Array(n), p2 = new Uint8Array(n);
      for (k = 0; k < n; k++) { var sp = P.speed(m, k % N, (k - k % N) / N, mv); c[k] = sp > 0 ? Math.round(10 / sp) : 999; p1[k] = sp > 0 ? 1 : 0; }
      for (var y = 0; y + 2 <= N; y++) for (var x = 0; x + 2 <= N; x++) p2[y * N + x] = P.canBox(m, x, y, 2, mv) ? 1 : 0;
      self.pass[mv + 1] = p1; self.pass[mv + 2] = p2; self.costOf[mv] = c;
    });
    this.blockLos = new Uint8Array(n); this.light = new Uint8Array(n); this.coverC = new Float32Array(n);
    for (k = 0; k < n; k++) { var c0 = m.t[k]; this.blockLos[k] = P.blocksLos(m, k % N, (k - k % N) / N) ? 1 : 0; this.light[k] = c0 === T.LIGHT ? 1 : 0; this.coverC[k] = P.coverAt(m, k % N, (k - k % N) / N); }
    this.structAt = new Int16Array(n).fill(-1);
    // сетка клеток для соседей
    this.cellHead = new Int32Array(n).fill(-1); this.nextIn = new Int32Array(256);
    // туман: 0 — не видели, 1 — видели, 2 — видно сейчас
    this.seen = [new Uint8Array(n), new Uint8Array(n)];
    this.fogT = 0; this.aiT = 0; this.capT = 0; this.sqT = 0;
    this.flows = new Flows(this);
    this.sx = this.town[0] + (this.town[2] >> 1) - (SQUARE >> 1); this.sy = this.town[1] + (this.town[3] >> 1) - (SQUARE >> 1);
    this.nextId = 0;
  }

  // ---- бойцы
  Ground.prototype.add = function(tid, team, x, y, extra) {
    var Ty = U.type(tid); if (!Ty) return null;
    extra = extra || {};
    var a = {
      id: this.agents.length, tid: tid, T: Ty, team: team, x: x, y: y, vx: 0, vy: 0, dvx: 0, dvy: 0,
      aim: extra.aim || 0, legs: extra.aim || 0, mv: 0, phase: this.R() * TAU,
      hpMax: Math.round((extra.hpMax || Ty.hp) * (extra.hpK || 1)), hp: 0, alive: true, gone: false, diedAt: 0,
      size: Ty.size, move: Ty.move, air: Ty.air, speed: Ty.speed, range: Ty.range * RANGE_K, vision: Ty.vision * RANGE_K,
      goal: null, at: true, post: false, hold: false, sq: 0, tgt: -1, focus: -1, scan: this.R() * SCAN, cd: this.R() * Ty.rof,
      stuck: 0, lastD: 1e9, wig: 0, side: 1, wait: 0, engT: -99, turretA: extra.aim || 0, inside: -1,
      uid: extra.uid || null, name: extra.name || '', owner: extra.owner || null, dmgK: extra.dmgK || 1,
      stun: 0, fear: 0, choke: -1, mind: null, barrier: 0, revealT: -99,
      hero: null, auto: false, dpost: null, sortie: false, lane: -1, ph: 0, jam: 0, ghostT: -1
    };
    a.rad = VRAD[tid] != null ? VRAD[tid] : (Ty.size === 2 ? 1.0 : R);
    if (Ty.hero) {
      a.range = SABER; a.hero = { act: 'idle', k: 0, actT: 0, cds: {}, abil: extra.abil || (team === 0 ? ACTIVE_LIGHT : ACTIVE_DARK).slice(), portrait: extra.portrait || (team === 0 ? 'jedi_01' : 'sith_01'), passive: extra.passive || {} };
      if (a.hero.passive.hp) a.hpMax += a.hero.passive.hp;
      if (a.hero.passive.vision) a.vision += a.hero.passive.vision * RANGE_K;
    }
    if (Ty.artillery) a.range = Ty.range;       // артиллерия: на всю карту (144)
    a.hp = extra.hp != null ? Math.min(a.hpMax, extra.hp) : a.hpMax;
    this.agents.push(a); this.used.push(a.id);
    if (this.nextIn.length < this.agents.length) { var ni = new Int32Array(this.agents.length + 256); ni.set(this.nextIn); this.nextIn = ni; }
    return a;
  };
  Ground.prototype.addStruct = function(kind, team, x, y, extra) {
    var S = U.ST[kind]; if (!S) return null;
    var s = { i: this.structs.length, kind: kind, team: team, x: x, y: y, w: S[1], h: S[1], hp: (extra && extra.hp) || S[2], hpMax: S[2], cover: S[3], inMul: S[4], radius: S[5], dmg: S[6], acc: S[7], enter: S[8], infOnly: S[9], cd: 0, tgt: -1, dead: false, name: S[0], uid: extra && extra.uid };
    for (var j = 0; j < s.h; j++) for (var i = 0; i < s.w; i++) { var c = (y + j) * N + x + i; if (c >= 0 && c < N * N) this.structAt[c] = s.i; }
    this.structs.push(s);
    return s;
  };
  Ground.prototype.cellOf = function(a) { return a.size === 2 ? [Math.round(a.x) - 1, Math.round(a.y) - 1] : [Math.floor(a.x), Math.floor(a.y)]; };
  Ground.prototype.okAt = function(a, cx, cy) {
    if (cx < 0 || cy < 0 || cx >= N || cy >= N) return false;
    var c = cy * N + cx;
    if (!this.pass[a.move + a.size][c]) return false;
    var s = this.structAt[c];
    if (s >= 0 && !a.air) { var st = this.structs[s]; if (st.dead) return true; if (!st.enter || st.team !== a.team || (st.infOnly && a.T.cls !== 'infantry' && a.T.cls !== 'hero')) return false; }
    return true;
  };
  Ground.prototype.nearestOk = function(mv, size, x, y) {
    var ok = this.pass[mv + size];
    for (var r = 0; r < 20; r++) for (var dy = -r; dy <= r; dy++) for (var dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      var nx = x + dx, ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < N && ny < N && ok[ny * N + nx]) return [nx, ny];
    }
    return null;
  };
  Ground.prototype.msg = function(text, team, kind) { this.ev.msgs.push({ seq: ++this.seq, t: this.t, text: text, team: team, kind: kind || '' }); if (this.ev.msgs.length > 60) this.ev.msgs.shift(); };

  // ---- приказы
  Ground.prototype.mine = function(team, a) { return a && a.alive && a.team === team && !(a.mind && a.mind.until > this.t); };
  Ground.prototype.ctl = function(a) { return a.mind && a.mind.until > this.t ? a.mind.by : a.team; };
  // Идти: каждому своё место рядом с точкой (строй по спирали, с учётом размера)
  Ground.prototype.orderMove = function(team, ids, cx, cy, opts) {
    var self = this, list = ids.map(function(i) { return self.agents[i]; }).filter(function(a) { return self.mine(team, a); });
    if (!list.length) return 0;
    var taken = {}, n = 0;
    list.sort(function(a, b) { return b.size - a.size; });
    for (var i = 0; i < list.length; i++) {
      var a = list[i], spot = this.spotNear(a, cx, cy, taken);
      if (!spot) continue;
      this.mark(taken, spot[0], spot[1], a);
      this.goCell(a, spot[0], spot[1], [cx, cy]); a.post = !(opts && opts.auto); a.hold = false; a.focus = -1; n++;
      if (!(opts && opts.auto)) { a.auto = false; a.dpost = null; a.sortie = false; }
    }
    return n;
  };
  // Занять клетки под бойца: пехота — свою, техника — свои 2×2 и пояс вокруг по радиусу расталкивания
  Ground.prototype.mark = function(taken, x, y, a) {
    var m = a.size === 2 ? Math.ceil(a.rad - 0.5) : 0;
    for (var yy = y - m; yy <= y + a.size - 1 + m; yy++) for (var xx = x - m; xx <= x + a.size - 1 + m; xx++) taken[yy * N + xx] = 1;
  };
  Ground.prototype.spotNear = function(a, cx, cy, taken) {
    var best = null, bd = 1e9, rmax = a.size === 2 ? 20 : 14;
    for (var r = 0; r < rmax && !best; r++) {
      for (var dy = -r; dy <= r; dy++) for (var dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        var x = cx + dx, y = cy + dy, c = y * N + x;
        if (!this.okAt(a, x, y) || taken[c]) continue;
        if (a.size === 2 && (taken[c + 1] || taken[c + N] || taken[c + N + 1])) continue;
        if (a.size === 1 && r < 10 && ((x + y) & 1)) continue;          // пехота — в шахматном порядке, чтобы не толпиться
        var d = dx * dx + dy * dy; if (d < bd) { bd = d; best = [x, y]; }
      }
    }
    return best;
  };
  // key — общая точка отряда: поле направлений строится к ней одно на всех, последние клетки — напрямую
  Ground.prototype.goCell = function(a, cx, cy, key) { a.goal = [cx, cy]; a.key = key || null; a.at = false; a.stuck = 0; a.lastD = 1e9; a.wait = 0; };
  // Прямой ход до клетки: все клетки на отрезке проходимы
  Ground.prototype.straight = function(a, tx, ty) {
    var ok = this.pass[a.move + a.size], dx = tx - a.x, dy = ty - a.y, L = Math.sqrt(dx * dx + dy * dy), n = Math.ceil(L * 2) + 1, off = a.size === 2 ? 1 : 0.5;
    for (var i = 0; i <= n; i++) { var f = i / n, x = Math.floor(a.x + dx * f - (off - 0.5)), y = Math.floor(a.y + dy * f - (off - 0.5)); if (x < 0 || y < 0 || x >= N || y >= N || !ok[y * N + x]) return false; }
    return true;
  };
  Ground.prototype.orderAttack = function(team, ids, tid) {
    var self = this, tg = this.agents[tid]; if (!tg || !tg.alive || tg.team === team) return 0;
    var n = 0;
    ids.forEach(function(i) { var a = self.agents[i]; if (!self.mine(team, a)) return; a.focus = tid; a.post = false; a.hold = false; a.goal = null; a.at = true; a.auto = false; a.dpost = null; a.sortie = false; n++; });
    return n;
  };
  Ground.prototype.orderHold = function(team, ids) {
    var self = this, n = 0;
    ids.forEach(function(i) { var a = self.agents[i]; if (!self.mine(team, a)) return; var c = self.cellOf(a); a.goal = [c[0], c[1]]; a.at = true; a.post = true; a.hold = true; a.focus = -1; a.auto = false; a.dpost = null; a.sortie = false; n++; });
    return n;
  };
  Ground.prototype.orderStop = function(team, ids) {
    var self = this, n = 0;
    ids.forEach(function(i) { var a = self.agents[i]; if (!self.mine(team, a)) return; a.goal = null; a.at = true; a.post = false; a.hold = false; a.focus = -1; a.auto = false; a.dpost = null; a.sortie = false; n++; });
    return n;
  };
  // Отряды: sqId > 0 — в отряд, 0 — новый, −1 — без отряда
  Ground.prototype.assign = function(team, ids, sqId) {
    var self = this, sqs = this.teams[team].squads, sq = null;
    if (sqId > 0) { for (var i = 0; i < sqs.length; i++) if (sqs[i].id === sqId) sq = sqs[i]; if (!sq) return false; }
    else if (sqId === 0) { if (sqs.length >= SQ_MAX) return false; var m = 0; sqs.forEach(function(s) { m = Math.max(m, s.id); }); sq = { id: m + 1, members: [], auto: false }; sqs.push(sq); }
    ids.forEach(function(id) {
      var a = self.agents[id]; if (!self.mine(team, a)) return;
      if (a.sq) { var old = self.squadOf(team, a.sq); if (old) old.members = old.members.filter(function(x) { return x !== id; }); }
      a.sq = sq ? sq.id : 0; if (sq) sq.members.push(id);
    });
    this.teams[team].squads = sqs.filter(function(s) { return s.members.length; });
    return sq ? sq.id : -1;
  };
  Ground.prototype.squadOf = function(team, id) { var sqs = this.teams[team].squads; for (var i = 0; i < sqs.length; i++) if (sqs[i].id === id) return sqs[i]; return null; };
  Ground.prototype.setAuto = function(team, ids, on) { var self = this; ids.forEach(function(i) { var a = self.agents[i]; if (self.mine(team, a)) { a.post = !on && a.post; a.auto = !!on; if (on) { a.hold = false; a.dpost = null; a.sortie = false; a.ph = 0; } } }); };

  // ---- обзор
  Ground.prototype.canSee = function(team, b) {
    if (b.team === team) return true;
    if (b.air) return this.seen[team][clamp(Math.floor(b.y), 0, N - 1) * N + clamp(Math.floor(b.x), 0, N - 1)] === 2;
    var c = clamp(Math.floor(b.y), 0, N - 1) * N + clamp(Math.floor(b.x), 0, N - 1);
    if (this.seen[team][c] !== 2) return false;
    // скрытный разведчик: виден только вблизи (stealth_range) или после выстрела; маскировочная сеть — 3 клетки
    var st = b.T.stealth ? b.T.stealth * RANGE_K : 0;
    if (b.inside >= 0 && this.structs[b.inside].kind === 'camo') st = Math.max(st, 3 * RANGE_K);
    if (st && this.t - b.revealT > 120) { if (this.nearestOwn(team, b.x, b.y, st) < 0 && !this.radarSees(team, b.x, b.y)) return false; }
    return true;
  };
  Ground.prototype.radarSees = function(team, x, y) {
    for (var i = 0; i < this.structs.length; i++) { var s = this.structs[i]; if (s.dead || s.team !== team || s.kind !== 'radar') continue; var dx = s.x + 1 - x, dy = s.y + 1 - y; if (dx * dx + dy * dy <= s.radius * s.radius * RANGE_K * RANGE_K) return true; }
    return false;
  };
  Ground.prototype.nearestOwn = function(team, x, y, r) {
    var ag = this.agents, best = -1, bd = r * r;
    for (var i = 0; i < ag.length; i++) { var a = ag[i]; if (!a.alive || a.team !== team) continue; var dx = a.x - x, dy = a.y - y, d = dx * dx + dy * dy; if (d < bd) { bd = d; best = i; } }
    return best;
  };
  Ground.prototype.fog = function() {
    var ag = this.agents, i, k;
    for (var tm = 0; tm < 2; tm++) { var s = this.seen[tm]; for (k = 0; k < s.length; k++) if (s[k] === 2) s[k] = 1; }
    var jam = this.structs.filter(function(s) { return !s.dead && s.kind === 'jammer'; });
    for (i = 0; i < ag.length; i++) {
      var a = ag[i]; if (!a.alive || a.team > 1) continue;
      var r = a.vision - this.weather * RANGE_K;
      // глушилка врага: обзор режется до 2 клеток
      for (var j = 0; j < jam.length; j++) { var jm = jam[j]; if (jm.team === a.team) continue; var jdx = jm.x + 1 - a.x, jdy = jm.y + 1 - a.y; if (jdx * jdx + jdy * jdy <= jm.radius * jm.radius * RANGE_K * RANGE_K) r = Math.min(r, 2 * RANGE_K); }
      if (a.air) r += 2;
      this.reveal(a.team, a.x, a.y, r, a.x, a.y);
    }
    for (i = 0; i < this.structs.length; i++) { var st = this.structs[i]; if (st.dead || st.team > 1) continue; if (st.kind === 'radar' || st.kind === 'turret') this.reveal(st.team, st.x + st.w / 2, st.y + st.h / 2, (st.radius || 3) * RANGE_K); }
    // полоса вторжения всегда видна хозяину планеты
    var sd = this.seen[this.def];
    for (k = (N - P.GEO.strip) * N; k < N * N; k++) sd[k] = 2;
  };
  // Открыть обзор: лучи от бойца до радиуса; скала или третья клетка зарослей — конец луча.
  // С высоты видно через скалы ниже себя.
  Ground.prototype.reveal = function(team, x, y, r) {
    var s = this.seen[team], cx = Math.floor(x), cy = Math.floor(y), e = this.map.e, e0 = P.heightAt(this.map, cx, cy);
    var rays = Math.ceil(TAU * r * 0.9), last = -1;
    s[cy * N + cx] = 2;
    for (var i = 0; i < rays; i++) {
      var ang = i / rays * TAU, dx = Math.cos(ang), dy = Math.sin(ang), lightN = 0;
      for (var k = 1; k <= r; k += 0.7) {
        var xx = Math.floor(x + dx * k), yy = Math.floor(y + dy * k);
        if (xx < 0 || yy < 0 || xx >= N || yy >= N) break;
        var c = yy * N + xx; if (c === last) continue; last = c;
        s[c] = 2;
        if (this.blockLos[c] && e[c] >= e0) break;
        if (this.light[c] && ++lightN > 3) break;
        var si = this.structAt[c]; if (si >= 0 && !this.structs[si].dead && !this.structs[si].enter) break;
      }
    }
  };
  // Линия видимости/огня: скалы закрывают (если стрелок не выше них), заросли — глубже второй клетки
  Ground.prototype.los = function(x0, y0, x1, y1, e0, soft) {
    var dx = x1 - x0, dy = y1 - y0, L = Math.sqrt(dx * dx + dy * dy);
    if (L < 0.01) return true;
    var steps = Math.ceil(L * 2), lightN = 0, e = this.map.e, ex = e0 == null ? P.heightAt(this.map, Math.floor(x0), Math.floor(y0)) : e0;
    var c1 = Math.floor(y1) * N + Math.floor(x1), c0 = Math.floor(y0) * N + Math.floor(x0), last = -1;
    for (var i = 1; i < steps; i++) {
      var f = i / steps, cx = Math.floor(x0 + dx * f), cy = Math.floor(y0 + dy * f);
      if (cx < 0 || cy < 0 || cx >= N || cy >= N) return false;
      var c = cy * N + cx; if (c === last || c === c1 || c === c0) continue; last = c;
      if (this.blockLos[c] && e[c] >= ex) return false;
      if (this.light[c] && ++lightN > (soft ? 3 : 2)) return false;
      var s = this.structAt[c]; if (s >= 0 && !this.structs[s].dead && !this.structs[s].enter && this.structs[s].kind !== 'camo') return false;
    }
    return true;
  };
  // Укрытие цели от стрелка: 1 — нет, меньше — хуже попасть
  Ground.prototype.cover = function(ax, ay, b) {
    if (b.air) return 1;
    var k = 1, m = this.map, bc = Math.floor(b.y) * N + Math.floor(b.x);
    if (b.inside >= 0) { var st = this.structs[b.inside]; if (!st.dead && st.cover) k *= 1 - st.cover / 100; }
    else {
      var dx = ax - b.x, dy = ay - b.y, L = Math.sqrt(dx * dx + dy * dy) || 1;
      for (var q = 0.6; q <= 1.6; q += 0.5) {
        var x = Math.floor(b.x + dx / L * q), y = Math.floor(b.y + dy / L * q);
        if (x < 0 || y < 0 || x >= N || y >= N) continue;
        var c = y * N + x, cv = this.coverC[c];
        if (m.t[c] === T.COVER || m.t[c] === T.TRAP) { k *= cv; break; }
      }
      if (this.light[bc]) k *= 0.75;
    }
    if (b.size === 1 && P.heightAt(m, Math.floor(b.x), Math.floor(b.y)) > P.heightAt(m, Math.floor(ax), Math.floor(ay))) k *= 0.85;
    return k;
  };

  // ---- цели
  Ground.prototype.tgtPos = function(a) {
    var tg = a.focus >= 0 ? this.agents[a.focus] : (a.tgt >= 0 ? this.agents[a.tgt] : null);
    if (tg && (!tg.alive || tg.gone)) tg = null;
    if (!tg && a.tgt >= 100000) { var st = this.structs[a.tgt - 100000]; if (st && !st.dead) { var dx0 = st.x + st.w / 2 - a.x, dy0 = st.y + st.h / 2 - a.y; return { x: st.x + st.w / 2, y: st.y + st.h / 2, d: Math.sqrt(dx0 * dx0 + dy0 * dy0), s: st }; } }
    if (!tg) return null;
    var dx = tg.x - a.x, dy = tg.y - a.y;
    return { x: tg.x, y: tg.y, d: Math.sqrt(dx * dx + dy * dy), a: tg };
  };
  Ground.prototype.canHit = function(a, b) {
    if (b.air) return a.T.cls === 'aa' || a.T.cls === 'air' || a.hero ? true : a.range * 0.5 > 0;
    return !a.air || true;
  };
  Ground.prototype.rangeTo = function(a, b) { return b.air && a.T.cls !== 'aa' && a.T.cls !== 'air' ? a.range * 0.5 : a.range; };
  Ground.prototype.findTarget = function(a) {
    var ag = this.agents, team = this.ctl(a), rr = a.range + 1, best = -1, bd = 1e18, i;
    if (a.T.dmg <= 0) return -1;
    if (a.focus >= 0) { var fo = ag[a.focus]; if (fo && fo.alive && this.canSee(team, fo)) { var fdx = fo.x - a.x, fdy = fo.y - a.y, fd = Math.sqrt(fdx * fdx + fdy * fdy); if (fd <= this.rangeTo(a, fo) && this.los(a.x, a.y, fo.x, fo.y)) return a.focus; } else a.focus = -1; }
    var cand = [];
    var x0 = Math.max(0, Math.floor(a.x - rr)), x1 = Math.min(N - 1, Math.floor(a.x + rr)), y0 = Math.max(0, Math.floor(a.y - rr)), y1 = Math.min(N - 1, Math.floor(a.y + rr));
    for (var y = y0; y <= y1; y++) for (var x = x0; x <= x1; x++) {
      for (var j = this.cellHead[y * N + x]; j !== -1; j = this.nextIn[j]) {
        var b = ag[j]; if (!b.alive || b.gone || this.ctl(b) === team || (b.team === 2 && team === 2)) continue;
        if (b.air && a.T.cls !== 'aa' && a.T.cls !== 'air' && !a.hero && a.T.cls !== 'infantry') continue;
        var dx = b.x - a.x, dy = b.y - a.y, d = dx * dx + dy * dy, r = this.rangeTo(a, b);
        if (d > r * r) continue;
        // предпочтения: ПВО — воздух, техника — техника, пехота — пехота; слабые цели ближе — вкуснее
        var w = U.mult(a.T.cls, b.T.cls); w = w > 0 ? 1 / w : 3;
        cand.push(d * w, j);
      }
    }
    // постройки врага (турели, радар, глушилка) — техника и артиллерия
    if (a.T.cls !== 'infantry' || true) for (i = 0; i < this.structs.length; i++) {
      var st = this.structs[i]; if (st.dead || st.team === team || st.team === 2) continue;
      if (st.kind !== 'turret' && st.kind !== 'radar' && st.kind !== 'jammer' && a.T.cls === 'infantry') continue;
      var sdx = st.x + st.w / 2 - a.x, sdy = st.y + st.h / 2 - a.y, sd = sdx * sdx + sdy * sdy;
      if (sd > a.range * a.range) continue;
      if (this.seen[team][st.y * N + st.x] < 1) continue;
      cand.push(sd * (st.kind === 'turret' ? 1.2 : 2.5), 100000 + i);
    }
    // ближайшие (по весу) — проверка видимости и линии огня
    var tries = 0;
    while (cand.length && tries < 5) {
      var bi = -1, bw = 1e18;
      for (i = 0; i < cand.length; i += 2) if (cand[i] < bw) { bw = cand[i]; bi = i; }
      var id = cand[bi + 1]; cand.splice(bi, 2); tries++;
      if (id >= 100000) { var s2 = this.structs[id - 100000]; if (this.los(a.x, a.y, s2.x + s2.w / 2, s2.y + s2.h / 2)) return id; continue; }
      var t2 = ag[id];
      if (!this.canSee(team, t2)) continue;
      if (a.T.artillery || a.air || t2.air || this.los(a.x, a.y, t2.x, t2.y)) return id;
    }
    return -1;
  };

  // ---- ход
  Ground.prototype.nav = function(a, dt, sp) {
    var c = this.cellOf(a), cx = c[0], cy = c[1], gx = a.goal[0], gy = a.goal[1];
    var off = a.size === 2 ? 1 : 0.5;
    var ddx = gx + off - a.x, ddy = gy + off - a.y, dist = Math.sqrt(ddx * ddx + ddy * ddy);
    if ((cx === gx && cy === gy && dist < 0.3) || (dist < 1.2 && a.stuck > 0.8)) { a.at = true; a.vx = a.vy = 0; return; }
    var tx, ty;
    var key = a.key || a.goal;
    if (a.air || (dist < 6 && this.straight(a, gx + off, gy + off))) { tx = gx + off; ty = gy + off; }
    else {
      var f = this.flows.get(a.move, a.size, key[0], key[1]), d = f.dir[cy * N + cx];
      if (d === 255) {
        // не на проходимой клетке (сдвинут) или цель недостижима: к ближайшей годной
        var alt = this.nearestOk(a.move, a.size, cx, cy);
        if (alt && (alt[0] !== cx || alt[1] !== cy)) { tx = alt[0] + off; ty = alt[1] + off; }
        else { a.at = true; a.wait = 0.5; return; }
      } else if (d === 254 || (key !== a.goal && Math.abs(cx - key[0]) + Math.abs(cy - key[1]) <= 1)) { tx = gx + off; ty = gy + off; }
      else {
        var nx = cx + DX[d], ny = cy + DY[d], d2 = f.dir[ny * N + nx];
        tx = nx + off; ty = ny + off;
        if (d2 < 8) { tx += DX[d2] * 0.5; ty += DY[d2] * 0.5; }
      }
    }
    var dx = tx - a.x, dy = ty - a.y, L = Math.sqrt(dx * dx + dy * dy) || 1;
    if (dist < a.lastD - 0.05) { a.lastD = dist; a.stuck = 0; a.jam = 0; } else a.stuck += dt;
    if (a.stuck > 1.5) {
      a.wig = 0.6; a.stuck = 0; a.side = this.R() < 0.5 ? 1 : -1; a.jam++;
      if (a.jam >= 2 && a.size === 2) {
        // техника в пробке: на 2 с не толкается с другой техникой, а застрявшую у скалы — ставим на следующую клетку пути
        a.ghostT = this.t + 2; a.jam = 0;
        var sc = [Math.round(tx) - 1, Math.round(ty) - 1];
        if (sc[0] >= 0 && sc[1] >= 0 && sc[0] < N - 1 && sc[1] < N - 1 && this.pass[a.move + 2][sc[1] * N + sc[0]]) { a.x = sc[0] + 1; a.y = sc[1] + 1; }
      }
    }
    if (a.wig > 0) { a.wig -= dt; var px = -dy / L * a.side, py = dx / L * a.side; dx = dx / L + px * 0.9; dy = dy / L + py * 0.9; L = Math.sqrt(dx * dx + dy * dy); }
    // скорость по клетке под ногами
    var spc = P.speed(this.map, cx, cy, a.move) || 1;
    if (a.fear > 0) sp *= 1.3;
    a.dvx = dx / L * sp * spc; a.dvy = dy / L * sp * spc;
    var ang = Math.atan2(dy, dx);
    a.legs = turn(a.legs, ang, LEGS * dt);
    if (!(a.tgt >= 0 || a.focus >= 0) || a.T.vehicle) a.aim = turn(a.aim, ang, TURN * dt);
    a.mv += (1 - a.mv) * Math.min(1, dt * 6);
    a.phase = (a.phase + dt * (a.T.vehicle ? 5 : 7) * (sp / Math.max(0.5, a.T.speed))) % TAU;
  };
  Ground.prototype.think = function(a, dt) {
    a.dvx = 0; a.dvy = 0;
    var tg = null;
    if (a.stun > 0) { a.stun -= dt; a.mv += (0 - a.mv) * Math.min(1, dt * 6); return; }
    if (a.choke >= 0) { var ch = this.agents[a.choke]; if (ch && ch.alive && ch.hero && ch.hero.act === 'choke') { a.mv = 0; return; } a.choke = -1; }
    if (a.wait > 0) { a.wait -= dt; a.mv += (0 - a.mv) * Math.min(1, dt * 6); return; }
    if (a.hero && a.hero.act !== 'idle' && a.hero.act !== 'run' && a.hero.act !== 'dash') { a.mv += (0 - a.mv) * Math.min(1, dt * 6); return; }
    tg = this.tgtPos(a);
    if (tg) {
      var want = Math.atan2(tg.y - a.y, tg.x - a.x);
      if (a.T.vehicle && a.size === 2) a.turretA = turn(a.turretA, want, U.TURRET_TURN * dt); else a.aim = turn(a.aim, want, TURN * dt);
    }
    if (a.fear > 0) {
      // страх: бежит от ближайшего врага
      a.fear -= dt;
      var en = this.nearestEnemy(a, 12);
      if (en) { var fx = a.x - en.x, fy = a.y - en.y, fl = Math.sqrt(fx * fx + fy * fy) || 1, gx = clamp(Math.round(a.x + fx / fl * 6), 1, N - 2), gy = clamp(Math.round(a.y + fy / fl * 6), 1, N - 2); if (!a.goal || a.at) this.goCell(a, gx, gy); }
    }
    var range = tg ? (tg.a ? this.rangeTo(a, tg.a) : a.range) : a.range;
    var engaged = tg && tg.d <= range * (a.hero ? 1 : 0.85) && !a.T.artillery;
    if (tg && tg.d <= range) a.engT = this.t;
    // точка игрока: идёт туда и под огнём
    if (a.post && !a.at && a.goal) { this.nav(a, dt, a.speed); return; }
    if (a.hero && tg && !a.hold) {
      // герой: сближается до удара
      if (tg.d > SABER * 0.9) { var tc = [Math.floor(tg.x), Math.floor(tg.y)]; if (!a.goal || a.goal[0] !== tc[0] || a.goal[1] !== tc[1]) this.goCell(a, tc[0], tc[1]); this.nav(a, dt, a.speed * 1.1); if (a.at && tg.d > SABER) { a.at = false; } return; }
      a.mv += (0 - a.mv) * Math.min(1, dt * 6); a.at = true; return;
    }
    if (engaged) {
      a.mv += (0 - a.mv) * Math.min(1, dt * 6);
      if (tg.d > range * 0.6 && !a.at && !a.hold && a.goal) this.nav(a, dt, a.speed * 0.8);
      return;
    }
    // цель игрока вне дальности — идти к ней
    if (a.focus >= 0 && tg && !a.hold) { var fc = [Math.floor(tg.x), Math.floor(tg.y)]; if (!a.goal || a.goal[0] !== fc[0] || a.goal[1] !== fc[1] || a.at) this.goCell(a, fc[0], fc[1]); this.nav(a, dt, a.speed); return; }
    if (a.at || !a.goal) {
      a.mv += (0 - a.mv) * Math.min(1, dt * 6);
      // есть цель, но не в дальности и без приказа: подтянуться (кроме стоящих по приказу)
      if (tg && !a.hold && !a.post && !a.dpost && !a.T.artillery && tg.d > range && tg.d < range * 1.8) { var cc = [Math.floor(tg.x), Math.floor(tg.y)]; this.goCell(a, cc[0], cc[1]); }
      return;
    }
    this.nav(a, dt, a.speed);
  };
  Ground.prototype.nearestEnemy = function(a, r) {
    var ag = this.agents, best = null, bd = r * r, team = this.ctl(a);
    for (var i = 0; i < ag.length; i++) { var b = ag[i]; if (!b.alive || this.ctl(b) === team) continue; var dx = b.x - a.x, dy = b.y - a.y, d = dx * dx + dy * dy; if (d < bd) { bd = d; best = b; } }
    return best;
  };
  // Расталкивание и стены — как в rt-crew, но с размером и без столкновений с воздухом
  Ground.prototype.collide = function(dt) {
    var ag = this.agents, n = N * N, i, a;
    for (i = 0; i < ag.length; i++) {
      a = ag[i]; if (!a.alive) continue;
      var k = Math.min(1, dt * 10);
      a.vx += (a.dvx - a.vx) * k; a.vy += (a.dvy - a.vy) * k;
      a.x += a.vx * dt; a.y += a.vy * dt;
      if (!a.air) this.wall(a);
    }
    this.cellHead.fill(-1);
    for (i = 0; i < ag.length; i++) {
      a = ag[i]; if (!a.alive) continue;
      var cx = clamp(Math.floor(a.x), 0, N - 1), cy = clamp(Math.floor(a.y), 0, N - 1), c = cy * N + cx;
      this.nextIn[i] = this.cellHead[c]; this.cellHead[c] = i;
    }
    for (i = 0; i < ag.length; i++) {
      a = ag[i]; if (!a.alive || a.air) continue;
      var ax = Math.floor(a.x), ay = Math.floor(a.y), ra = a.rad;
      for (var yy = ay - 2; yy <= ay + 2; yy++) for (var xx = ax - 2; xx <= ax + 2; xx++) {
        if (xx < 0 || yy < 0 || xx >= N || yy >= N) continue;
        for (var j = this.cellHead[yy * N + xx]; j !== -1; j = this.nextIn[j]) {
          if (j <= i) continue;
          var b = ag[j]; if (!b.alive || b.air) continue;
          var rb = b.rad, D = ra + rb;
          // техника с техникой — теснее (могут частично наезжать); застрявшая в пробке — на 2 с «призрак»
          if (a.size === 2 && b.size === 2) { D *= 0.7; if (a.ghostT > this.t || b.ghostT > this.t) continue; }
          var dx = b.x - a.x, dy = b.y - a.y, d2 = dx * dx + dy * dy;
          if (d2 >= D * D || d2 < 1e-6) continue;
          var d = Math.sqrt(d2), push = (D - d) * 0.5, nx = dx / d, ny = dy / d;
          var ma = a.at ? 0.25 : 1, mb = b.at ? 0.25 : 1, wa = a.size === 2 ? 0.2 : 1, wb = b.size === 2 ? 0.2 : 1;
          var s = ma * wa + mb * wb || 1;
          a.x -= nx * push * 2 * (ma * wa / s); a.y -= ny * push * 2 * (ma * wa / s);
          b.x += nx * push * 2 * (mb * wb / s); b.y += ny * push * 2 * (mb * wb / s);
          if (a.at && a.goal && !a.hold && b.size === 2 && !b.at) a.at = false;
          if (b.at && b.goal && !b.hold && a.size === 2 && !a.at) b.at = false;
        }
      }
      this.wall(a);
    }
  };
  Ground.prototype.wall = function(a) {
    var ok = this.pass[a.move + a.size], off = a.size === 2 ? 1 : 0.5, rad = a.size === 2 ? 0.98 : R;
    for (var pass = 0; pass < 2; pass++) {
      var cx = a.size === 2 ? Math.round(a.x) - 1 : Math.floor(a.x), cy = a.size === 2 ? Math.round(a.y) - 1 : Math.floor(a.y);
      for (var yy = cy - 1; yy <= cy + 1; yy++) for (var xx = cx - 1; xx <= cx + 1; xx++) {
        var blocked = xx < 0 || yy < 0 || xx >= N || yy >= N || !ok[yy * N + xx];
        if (!blocked) { var s = this.structAt[yy * N + xx]; if (s >= 0) { var st = this.structs[s]; blocked = !st.dead && (!st.enter || st.team !== a.team || (st.infOnly && a.size === 2)); } }
        if (!blocked) continue;
        // клетка — квадрат; машина 2×2 — её «центр» соответствует квадрату 2×2
        var bx0 = xx, by0 = yy, bx1 = xx + 1, by1 = yy + 1;
        var px = clamp(a.x, bx0, bx1), py = clamp(a.y, by0, by1), dx = a.x - px, dy = a.y - py, d2 = dx * dx + dy * dy;
        if (d2 >= rad * rad) continue;
        if (d2 < 1e-6) { continue; }
        var d = Math.sqrt(d2), p = rad - d; a.x += dx / d * p; a.y += dy / d * p;
      }
    }
    a.x = clamp(a.x, off, N - off); a.y = clamp(a.y, off, N - off);
    var c = this.cellOf(a), cc = c[1] * N + c[0];
    if (!ok[cc]) { var alt = this.nearestOk(a.move, a.size, c[0], c[1]); if (alt) { a.x = alt[0] + off; a.y = alt[1] + off; } }
    a.inside = -1;
    var si = this.structAt[Math.floor(a.y) * N + Math.floor(a.x)];
    if (si >= 0 && this.structs[si].enter && !this.structs[si].dead && this.structs[si].team === a.team) a.inside = si;
  };

  // ---- стрельба
  Ground.prototype.hurt = function(b, d, by) {
    if (!b.alive) return;
    if (b.barrier > this.t) d *= 0.7;
    if (b.hero && b.hero.passive.absorb) d *= 1 - b.hero.passive.absorb / 100;
    b.hp -= d;
    if (b.hp <= 0) { b.hp = 0; b.alive = false; b.diedAt = this.t; b.mv = 0; this.ev.deaths.push({ t: this.t, id: b.id, by: by }); if (b.sq) { var sq = this.squadOf(b.team, b.sq); if (sq) sq.members = sq.members.filter(function(x) { return x !== b.id; }); } }
  };
  Ground.prototype.hurtStruct = function(s, d) {
    if (s.dead) return;
    s.hp -= d;
    if (s.hp <= 0) { s.hp = 0; s.dead = true; this.ev.booms.push({ t: this.t, x: s.x + s.w / 2, y: s.y + s.h / 2, r: s.w + 0.5 }); this.msg(s.name + ' уничтожен' + (s.name.slice(-1) === 'а' ? 'а' : ''), s.team, 'bad'); }
  };
  Ground.prototype.shot = function(a, tg, hit, d, ti) {
    var x1 = tg.x, y1 = tg.y, mx = 0, my = 0;
    if (!hit) { mx = (this.R() - 0.5) * 2.2; my = (this.R() - 0.5) * 2.2; }
    this.ev.shots.push({ t: this.t, x0: a.x, y0: a.y, x1: x1 + mx, y1: y1 + my, team: a.team, hit: hit, w: a.T.cls, d: hit ? Math.round(d) : 0, ti: ti, air: !!(tg.a && tg.a.air), from: a.id });
  };
  Ground.prototype.fire = function(dt) {
    var ag = this.agents, i;
    for (i = 0; i < ag.length; i++) {
      var a = ag[i]; if (!a.alive || a.T.dmg <= 0 || a.stun > 0 || a.fear > 0 || a.choke >= 0) continue;
      if (a.hero) { this.heroFight(a, dt); continue; }
      a.scan -= dt;
      if (a.scan <= 0) { a.scan = SCAN + this.R() * 0.15; a.tgt = this.findTarget(a); }
      a.cd -= dt;
      if (a.tgt < 0 || a.cd > 0) continue;
      var tg = this.tgtPos(a); if (!tg) { a.tgt = -1; continue; }
      var range = tg.a ? this.rangeTo(a, tg.a) : a.range;
      if (tg.d > range) continue;
      if (a.T.artillery) { this.artillery(a, tg); continue; }
      var aimA = a.T.vehicle && a.size === 2 ? a.turretA : a.aim;
      if (Math.abs(((Math.atan2(tg.y - a.y, tg.x - a.x) - aimA + 9.42) % 6.283) - 3.14) > 0.5) continue;
      a.cd = a.T.rof * (0.85 + this.R() * 0.3);
      var moving = Math.abs(a.vx) + Math.abs(a.vy) > 0.4, hit, dmg;
      if (tg.s) {
        hit = this.R() < Math.max(0.05, a.T.acc / 100) * (moving ? 0.7 : 1);
        dmg = hit ? U.damage(a.T, { cls: 'structure' }) * a.dmgK * (0.8 + this.R() * 0.4) : 0;
        this.shot(a, tg, hit, dmg, 100000 + tg.s.i);
        if (hit) this.hurtStruct(tg.s, dmg);
        continue;
      }
      var b = tg.a;
      var inMul = a.inside >= 0 ? this.structs[a.inside].inMul : 1;
      var p = U.hitChance(a.T, b.T, tg.d / RANGE_K, this.cover(a.x, a.y, b)) * (moving ? 0.7 : 1) * (a.hero && a.hero.passive.acc ? 1 + a.hero.passive.acc / 100 : 1);
      if (b.hero && b.hero.passive.evasion) p *= 1 - b.hero.passive.evasion / 100;
      hit = this.R() < p;
      // джедай отражает выстрелы: часть попаданий уходит обратно
      if (hit && b.hero && b.hero.passive.deflect && b.hero.act !== 'slash' && this.R() < b.hero.passive.deflect / 100) { hit = false; this.ev.fx.push({ t: this.t, k: 'deflect', x: b.x, y: b.y, id: b.id }); b.hero.act = 'deflect'; b.hero.actT = 0.35; }
      dmg = hit ? U.damage(a.T, b.T, inMul) * a.dmgK * (0.8 + this.R() * 0.4) : 0;
      this.shot(a, tg, hit, dmg, b.id);
      a.revealT = this.t;
      if (hit) {
        this.hurt(b, dmg, a.id);
        if (!b.alive) a.tgt = -1;
        // окоп: сразу отвечает огнём
        if (b.alive && b.inside >= 0 && this.structs[b.inside].kind === 'trench' && b.cd > 0.3) b.cd = 0.3;
        // гранатомёт и ракеты: задевает рядом
        var splash = /launcher/.test(a.tid) ? 1.6 : a.tid === 'cis_missile' ? 2 : 0;
        if (splash) { this.splash(tg.x, tg.y, splash, dmg * 0.5, a); this.ev.booms.push({ t: this.t, x: tg.x, y: tg.y, r: splash * 0.8 }); }
      }
    }
  };
  Ground.prototype.splash = function(x, y, r, dmg, by) {
    var ag = this.agents;
    for (var j = 0; j < ag.length; j++) {
      var sb = ag[j]; if (!sb.alive || sb.air) continue;
      var dx = sb.x - x, dy = sb.y - y, d2 = dx * dx + dy * dy;
      if (d2 < r * r) this.hurt(sb, dmg * (by ? U.mult(by.T.cls, sb.T.cls) : 1) * (1 - Math.sqrt(d2) / r * 0.5), by ? by.id : -1);
    }
    for (var s = 0; s < this.structs.length; s++) { var st = this.structs[s]; if (st.dead) continue; var sx = clamp(x, st.x, st.x + st.w), sy = clamp(y, st.y, st.y + st.h); if ((sx - x) * (sx - x) + (sy - y) * (sy - y) < r * r) this.hurtStruct(st, dmg * (by ? U.mult(by.T.cls, 'structure') : 1)); }
  };
  // Артиллерия: залп по площади, снаряд летит SHELL_T секунд; цель должна быть видна команде
  Ground.prototype.artillery = function(a, tg) {
    a.cd = a.T.rof * (0.9 + this.R() * 0.2);
    var sx = tg.x + (this.R() - 0.5) * 2.5, sy = tg.y + (this.R() - 0.5) * 2.5;
    this.ev.shells.push({ t0: this.t, t1: this.t + SHELL_T, x0: a.x, y0: a.y, x1: sx, y1: sy, team: a.team, r: a.T.splash, dmg: a.T.dmg * a.dmgK, by: a.id });
    a.revealT = this.t;
    this.ev.fx.push({ t: this.t, k: 'artfire', x: a.x, y: a.y, id: a.id });
  };
  Ground.prototype.shellsStep = function() {
    var sh = this.ev.shells;
    for (var i = sh.length - 1; i >= 0; i--) {
      var s = sh[i]; if (this.t < s.t1) continue;
      var by = this.agents[s.by];
      this.splash(s.x1, s.y1, s.r, s.dmg, by && by.alive ? by : null);
      this.ev.booms.push({ t: this.t, x: s.x1, y: s.y1, r: s.r, big: true });
      sh.splice(i, 1);
    }
  };
  // Полевые турели: сами стреляют по видимым врагам в радиусе
  Ground.prototype.structsStep = function(dt) {
    for (var i = 0; i < this.structs.length; i++) {
      var s = this.structs[i]; if (s.dead || s.kind !== 'turret') continue;
      s.cd -= dt; if (s.cd > 0) continue;
      var cx = s.x + 0.5, cy = s.y + 0.5, r = s.radius * RANGE_K, best = null, bd = r * r;
      for (var j = 0; j < this.agents.length; j++) { var b = this.agents[j]; if (!b.alive || this.ctl(b) === s.team || (b.team === 2 && s.team === 2)) continue; var dx = b.x - cx, dy = b.y - cy, d = dx * dx + dy * dy; if (d < bd && this.canSee(s.team, b) && this.los(cx, cy, b.x, b.y)) { bd = d; best = b; } }
      if (!best) { s.cd = 0.5; continue; }
      s.cd = U.ROF.turret;
      var hit = this.R() < s.acc / 100 * this.cover(cx, cy, best), dmg = hit ? Math.round(s.dmg * U.mult('turret', best.T.cls)) : 0;
      this.ev.shots.push({ t: this.t, x0: cx, y0: cy, x1: best.x + (hit ? 0 : (this.R() - 0.5) * 2), y1: best.y + (hit ? 0 : (this.R() - 0.5) * 2), team: s.team, hit: hit, w: 'turret', d: dmg, ti: best.id, from: 100000 + i });
      if (hit) this.hurt(best, dmg, 100000 + i);
      s.aim = Math.atan2(best.y - cy, best.x - cx);
    }
  };

  // ---- герои
  Ground.prototype.heroFight = function(a, dt) {
    var h = a.hero;
    if (h.actT > 0) { h.actT -= dt; h.k = 1 - h.actT / (h.actDur || 1); if (h.actT <= 0) { this.heroActEnd(a); } return; }
    a.scan -= dt;
    if (a.scan <= 0) { a.scan = SCAN; a.tgt = this.findTarget(a); }
    a.cd -= dt;
    if (a.tgt < 0 || a.cd > 0) return;
    var tg = this.tgtPos(a); if (!tg || !tg.a || tg.d > SABER) return;
    a.cd = a.T.rof;
    this.heroAct(a, 'slash', SLASH, { tid: tg.a.id });
  };
  Ground.prototype.heroAct = function(a, act, dur, data) { var h = a.hero; h.act = act; h.actT = dur; h.actDur = dur; h.k = 0; h.data = data || null; a.mv = 0; this.ev.fx.push({ t: this.t, k: act, x: a.x, y: a.y, id: a.id, tid: data && data.tid, tx: data && data.x, ty: data && data.y }); };
  Ground.prototype.heroActEnd = function(a) {
    var h = a.hero, d = h.data || {}, b = d.tid != null ? this.agents[d.tid] : null, act = h.act;
    h.act = 'idle'; h.k = 0;
    var dmgK = a.dmgK * (1 + (h.passive.damage || 0) / 100);
    if (act === 'slash' && b && b.alive) {
      var dx = b.x - a.x, dy = b.y - a.y;
      if (dx * dx + dy * dy <= (SABER + 0.4) * (SABER + 0.4)) {
        var p = U.hitChance(a.T, b.T, 0, 1) * (1 + (h.passive.acc || 0) / 100), hit = this.R() < p;
        var dmg = hit ? U.damage(a.T, b.T) * dmgK * (0.85 + this.R() * 0.3) : 0;
        this.ev.shots.push({ t: this.t, x0: a.x, y0: a.y, x1: b.x, y1: b.y, team: a.team, hit: hit, w: 'saber', d: Math.round(dmg), ti: b.id, from: a.id, melee: true });
        if (hit) this.hurt(b, dmg, a.id);
      }
    } else if (act === 'dash' && b && b.alive) {
      var ddx = b.x - a.x, ddy = b.y - a.y, dl = Math.sqrt(ddx * ddx + ddy * ddy) || 1, land = this.nearestOk(a.move, 1, Math.floor(b.x - ddx / dl * 0.9), Math.floor(b.y - ddy / dl * 0.9));
      if (land) { a.x = land[0] + 0.5; a.y = land[1] + 0.5; }
      this.hurt(b, U.damage(a.T, b.T) * dmgK * 1.2, a.id); this.ev.shots.push({ t: this.t, x0: a.x, y0: a.y, x1: b.x, y1: b.y, team: a.team, hit: true, w: 'saber', d: Math.round(U.damage(a.T, b.T) * dmgK * 1.2), ti: b.id, from: a.id, melee: true });
    } else if (act === 'push') {
      var pw = d.power || 3, ag = this.agents;
      for (var i = 0; i < ag.length; i++) {
        var c = ag[i]; if (!c.alive || c.air || this.ctl(c) === a.team) continue;
        var cx = c.x - a.x, cy = c.y - a.y, cd = Math.sqrt(cx * cx + cy * cy);
        if (cd > pw * RANGE_K * 0.5 + 1 || Math.abs(((Math.atan2(cy, cx) - a.aim + 9.42) % 6.283) - 3.14) > 0.9) continue;
        var kk = (pw + 1) * (c.size === 2 ? 0.3 : 1);
        var nx = clamp(c.x + cx / cd * kk, 1, N - 2), ny = clamp(c.y + cy / cd * kk, 1, N - 2), ok = this.nearestOk(c.move, c.size, Math.floor(nx), Math.floor(ny));
        if (ok) { c.x = ok[0] + (c.size === 2 ? 1 : 0.5); c.y = ok[1] + (c.size === 2 ? 1 : 0.5); }
        c.stun = Math.max(c.stun, 1.2); c.at = false;
        if (d.damage) this.hurt(c, 40 * dmgK, a.id);
      }
    } else if (act === 'throw') {
      // клинок пролетает к цели и обратно: все враги на линии получают урон
      var tx = d.x, ty = d.y, ag2 = this.agents;
      for (var j = 0; j < ag2.length; j++) {
        var e = ag2[j]; if (!e.alive || e.air || this.ctl(e) === a.team) continue;
        var vx = tx - a.x, vy = ty - a.y, L = Math.sqrt(vx * vx + vy * vy) || 1, px = e.x - a.x, py = e.y - a.y, pr = (px * vx + py * vy) / L;
        if (pr < 0 || pr > L + 0.5) continue;
        var dist = Math.abs(px * vy - py * vx) / L;
        if (dist <= 0.8) { var dm = U.damage(a.T, e.T) * dmgK * 0.8; this.hurt(e, dm, a.id); this.ev.shots.push({ t: this.t, x0: e.x, y0: e.y, x1: e.x, y1: e.y, team: a.team, hit: true, w: 'saber', d: Math.round(dm), ti: e.id, from: a.id, melee: true }); }
      }
    } else if (act === 'lightning') {
      var ag3 = this.agents;
      for (var q = 0; q < ag3.length; q++) {
        var f = ag3[q]; if (!f.alive || this.ctl(f) === a.team) continue;
        var fx = f.x - a.x, fy = f.y - a.y, fd = Math.sqrt(fx * fx + fy * fy);
        if (fd > 3 * RANGE_K || Math.abs(((Math.atan2(fy, fx) - a.aim + 9.42) % 6.283) - 3.14) > 0.6) continue;
        var ld = (d.power || 120) * dmgK * (f.T.vehicle ? 0.6 : 1) * (1 - fd / (3 * RANGE_K) * 0.5);
        this.hurt(f, ld, a.id); this.ev.shots.push({ t: this.t, x0: a.x, y0: a.y, x1: f.x, y1: f.y, team: a.team, hit: true, w: 'lightning', d: Math.round(ld), ti: f.id, from: a.id });
        if (this.R() < 0.5) f.stun = Math.max(f.stun, 2);
      }
    } else if (act === 'choke' && b && b.alive) {
      var cdm = (d.power || 90) * dmgK;
      this.hurt(b, cdm, a.id); b.choke = -1;
      if (d.drain) a.hp = Math.min(a.hpMax, a.hp + cdm * 0.6);
    } else if (act === 'mind') {
      if (d.fear) { var ag4 = this.agents; for (var r = 0; r < ag4.length; r++) { var g = ag4[r]; if (!g.alive || g.hero || g.T.vehicle || this.ctl(g) === a.team) continue; var gx = g.x - a.x, gy = g.y - a.y; if (gx * gx + gy * gy <= 9 * RANGE_K * RANGE_K) { g.fear = 6; g.tgt = -1; } } }
      else if (b && b.alive && !b.hero) {
        if (d.pacify) { b.stun = Math.max(b.stun, 8); }
        else { b.mind = { until: this.t + (d.power || 300), by: a.team, orig: b.team }; b.tgt = -1; b.focus = -1; b.goal = null; b.at = true; b.post = false; b.sq = 0; }
      }
    } else if (act === 'heal' && b && b.alive) { b.hp = Math.min(b.hpMax, b.hp + (d.power || 80)); this.ev.fx.push({ t: this.t, k: 'healed', x: b.x, y: b.y, id: b.id }); }
    else if (act === 'barrier') {
      var ag5 = this.agents;
      for (var s = 0; s < ag5.length; s++) { var m = ag5[s]; if (!m.alive || m.team !== a.team) continue; var mx = m.x - a.x, my = m.y - a.y; if (mx * mx + my * my <= 9 * RANGE_K * RANGE_K) m.barrier = this.t + 12; }
      this.ev.fx.push({ t: this.t, k: 'dome', x: a.x, y: a.y, r: 3 * RANGE_K, until: this.t + 12, id: a.id });
    }
    h.data = null;
  };
  // Применить способность героя: tgt = { tid } | { x, y } | null
  Ground.prototype.useAbility = function(team, id, abilId, tgt) {
    var a = this.agents[id], A = ABIL[abilId];
    if (!a || !a.alive || !a.hero || !A || !A[0] || !this.mine(team, a)) return 'нет';
    var h = a.hero;
    if (h.abil.indexOf(abilId) < 0) return 'не изучено';
    if ((h.cds[abilId] || 0) > this.t) return 'откат ' + Math.ceil(h.cds[abilId] - this.t) + ' с';
    if (h.actT > 0) return 'занят';
    var rng = A[2] * RANGE_K, b = tgt && tgt.tid != null ? this.agents[tgt.tid] : null, data = { power: A[4] };
    if (A[1] === 'enemy' || A[1] === 'ally') {
      if (!b || !b.alive) return 'нет цели';
      if (A[1] === 'enemy' && this.ctl(b) === team) return 'это свой';
      if (A[1] === 'ally' && b.team !== team) return 'это враг';
      var dx = b.x - a.x, dy = b.y - a.y, d = Math.sqrt(dx * dx + dy * dy);
      if (d > rng + 0.5) return 'далеко';
      a.aim = Math.atan2(dy, dx); data.tid = b.id; data.x = b.x; data.y = b.y;
    } else if (A[1] === 'area' && tgt && tgt.x != null) { a.aim = Math.atan2(tgt.y - a.y, tgt.x - a.x); data.x = tgt.x; data.y = tgt.y; }
    if (A[5] === 'damage') data.damage = true;
    if (A[5] === 'drain') data.drain = true;
    if (abilId === 'fear_dark') data.fear = true;
    if (abilId === 'pacify_light') data.pacify = true;
    h.cds[abilId] = this.t + A[3];
    var dur = { throw: 1.1, dash: 0.35, push: 0.5, lightning: 1.6, choke: 2.5, mind: 1.2, heal: 1.0, barrier: 0.8 }[A[0]] || 0.6;
    if (A[0] === 'choke' && b) b.choke = a.id;
    this.heroAct(a, A[0], dur, data);
    this.msg(ABIL_NAME[abilId] || abilId, team, 'gold');
    return '';
  };

  // ---- ИИ стороны без игрока: отряды к площади, оборона у площади
  // ---- ИИ. Штурм: тремя колоннами (центр по дороге — техника, фланги — пехота) к рубежу
  // перед городом, оттуда — на площадь. Оборона: каждому — пост в поясе перед площадью
  // (укрытия, высоты, окопы ценятся), стоит и стреляет; на прорвавшихся в город бросаются
  // только те, кто рядом; потом возвращаются на пост.
  Ground.prototype.threatDir = function() {
    if (this._tdir) return this._tdir;
    // штурм высаживается в полосе вторжения у нижнего края карты
    var sqx = this.sx + SQUARE / 2, sqy = this.sy + SQUARE / 2, fx = N / 2 - sqx, fy = N - P.GEO.strip / 2 - sqy;
    var l = Math.sqrt(fx * fx + fy * fy) || 1;
    return (this._tdir = [fx / l, fy / l]);
  };
  Ground.prototype.defPosts = function(team) {
    if (this._posts && this._posts.team === team) return this._posts;
    var sqx = this.sx + SQUARE / 2, sqy = this.sy + SQUARE / 2, f = this.threatDir(), m = this.map, R = rng(31);
    var foot = [], veh = [], near = [], pf = this.pass.foot1, pt = this.pass.track2, ph = this.pass.hover2;
    for (var y = 2; y < N - 2; y++) for (var x = 2; x < N - 2; x++) {
      var c = y * N + x, dx = x + 0.5 - sqx, dy = y + 0.5 - sqy, d = Math.max(Math.abs(dx), Math.abs(dy)), dl = Math.sqrt(dx * dx + dy * dy) || 1, dot = (dx * f[0] + dy * f[1]) / dl;
      var si = this.structAt[c], st = si >= 0 ? this.structs[si] : null;
      if (st && (!st.enter || st.team !== team)) continue;
      if (pf[c] && d >= DEF_NEAR && d <= DEF_FAR && dot > -0.15) foot.push([this.coverC[c] * 3 + m.e[c] * 1.2 + (st ? 4 : 0) + dot * 1.5 - d * 0.08 + R() * 0.3, x, y]);
      if (!st && (pt[c] || ph[c]) && d >= DEF_NEAR - 2 && d <= DEF_FAR - 6 && dot > -0.3) veh.push([m.e[c] * 0.8 + dot * 1.2 - d * 0.1 + R() * 0.3, x, y, pt[c], ph[c]]);
      if (!st && pf[c] && d >= 2 && d <= DEF_NEAR + 2) near.push([-d + R() * 0.5, x, y]);
    }
    function pick(list, lim, margin) {
      list.sort(function(a, b) { return b[0] - a[0]; });
      var taken = {}, out = [];
      for (var i = 0; i < list.length && out.length < lim; i++) {
        var p = list[i], c = p[2] * N + p[1]; if (taken[c]) continue;
        out.push({ x: p[1], y: p[2], by: -1, track: p[3], hover: p[4] });
        for (var yy = p[2] - margin; yy <= p[2] + margin; yy++) for (var xx = p[1] - margin; xx <= p[1] + margin; xx++) taken[yy * N + xx] = 1;
      }
      return out;
    }
    return (this._posts = { team: team, foot: pick(foot, 220, 1), veh: pick(veh, 50, 2), near: pick(near, 60, 1) });
  };
  // Общая точка для поля направлений: середина квадрата 8×8, чтобы соседние посты делили одно поле
  Ground.prototype.qkey = function(a, x, y) {
    var kx = (x >> 3) * 8 + 4, ky = (y >> 3) * 8 + 4, ok = this.nearestOk(a.move, a.size, clamp(kx, 1, N - 2), clamp(ky, 1, N - 2));
    return ok || [x, y];
  };
  // Расставить защитников по постам сразу (начало боя): стоят и держат
  Ground.prototype.deployDefense = function(team) {
    var posts = this.defPosts(team), ag = this.agents;
    for (var i = 0; i < ag.length; i++) {
      var a = ag[i]; if (!a.alive || a.team !== team || a.T.artillery) continue;
      var list = a.T.cls === 'aa' || a.air || a.T.medic || a.T.builder ? posts.near : a.T.vehicle ? posts.veh : posts.foot;
      var p = this.freePost(list, a) || this.freePost(posts.foot, a); if (!p) continue;
      p.by = a.id; a.dpost = p; var off = a.size === 2 ? 1 : 0.5;
      a.x = p.x + off; a.y = p.y + off; a.goal = [p.x, p.y]; a.at = true; a.hold = true; a.post = false;
      a.aim = a.legs = a.turretA = Math.atan2(this.threatDir()[1], this.threatDir()[0]);
    }
  };
  Ground.prototype.freePost = function(list, a) {
    var best = null, bd = 1e9;
    for (var i = 0; i < list.length; i++) {
      var p = list[i]; if (p.by >= 0) { var o = this.agents[p.by]; if (o && o.alive && o.dpost === p) continue; p.by = -1; }
      if (a.size === 2 && !(a.move === 'track' ? p.track : a.move === 'hover' ? p.hover : true)) continue;
      var dx = p.x - a.x, dy = p.y - a.y, d = dx * dx + dy * dy; if (d < bd) { bd = d; best = p; }
    }
    return best;
  };
  Ground.prototype.lanes = function() {
    if (this._lanes) return this._lanes;
    var sqx = this.sx + SQUARE / 2, sqy = this.sy + SQUARE / 2, f = this.threatDir(), out = [];
    // рубеж: в 16 клетках за поясом обороны, три точки; каждая — самое открытое место в округе
    var pf = this.pass.foot1, pt = this.pass.track2;
    for (var k = -1; k <= 1; k++) {
      var x = Math.round(sqx + f[0] * (DEF_FAR + 16) - f[1] * k * 16), y = Math.round(sqy + f[1] * (DEF_FAR + 16) + f[0] * k * 16), best = null, bs = -1;
      for (var dy = -8; dy <= 8; dy += 2) for (var dx = -8; dx <= 8; dx += 2) {
        var cx = clamp(x + dx, 6, N - 7), cy = clamp(y + dy, 6, N - 7), sc = 0;
        for (var yy = cy - 5; yy <= cy + 5; yy++) for (var xx = cx - 5; xx <= cx + 5; xx++) sc += pf[yy * N + xx] + (k === 0 ? pt[yy * N + xx] : 0);
        sc -= (Math.abs(dx) + Math.abs(dy)) * 0.5;
        if (sc > bs) { bs = sc; best = [cx, cy]; }
      }
      out.push(best);
    }
    return (this._lanes = out);
  };
  Ground.prototype.ai = function() {
    var ag = this.agents, sqx = this.sx + SQUARE / 2, sqy = this.sy + SQUARE / 2, self = this;
    for (var tm = 0; tm < 2; tm++) {
      var teamAuto = this.teams[tm].auto, ids = [];
      for (var i = 0; i < ag.length; i++) { var a = ag[i]; if (!a.alive || this.ctl(a) !== tm || (a.T.artillery && tm !== this.att)) continue; if (!teamAuto && !a.auto) continue; if (a.mind && a.mind.until > this.t) continue; ids.push(i); }
      if (!ids.length) continue;
      if (tm === this.att) this.aiAttack(tm, ids); else this.aiDefend(tm, ids);
    }
  };
  Ground.prototype.aiAttack = function(tm, ids) {
    var ag = this.agents, sqx = this.sx + SQUARE / 2, sqy = this.sy + SQUARE / 2, L = this.lanes(), groups = [[], [], []], toSq = [];
    // сбор на рубеже: колонна идёт дальше, когда собралось больше половины (или кто-то уже пошёл)
    var tot = [0, 0, 0], here = [0, 0, 0], gone = [0, 0, 0], i, a;
    for (i = 0; i < ids.length; i++) {
      a = ag[ids[i]];
      if (a.lane < 0) a.lane = a.T.vehicle || a.air ? 1 : a.id % 3;
      tot[a.lane]++;
      if (a.ph === 1) gone[a.lane]++;
      else { var lp = L[a.lane]; if (Math.abs(a.x - lp[0]) < 8 && Math.abs(a.y - lp[1]) < 8) { a.ph = 0.5; here[a.lane]++; } }
    }
    var onlyArt = ids.every(function(id) { return ag[id].T.artillery; });
    for (i = 0; i < ids.length; i++) {
      a = ag[ids[i]];
      if (onlyArt) { a.ph = 1; }
      if (a.ph === 0.5 && !a.T.artillery && (here[a.lane] + gone[a.lane] >= tot[a.lane] * 0.6 || gone[a.lane] > 0)) { a.ph = 1; a.at = true; }
      if (a.tgt >= 0 || (a.goal && !a.at) || (a.T.artillery && a.ph > 0 && !onlyArt)) continue;
      if (a.ph < 1) groups[a.lane].push(a.id); else toSq.push(a.id);
    }
    for (var k = 0; k < 3; k++) if (groups[k].length) this.orderMove(tm, groups[k], L[k][0], L[k][1], { auto: true });
    if (toSq.length) this.orderMove(tm, toSq, Math.floor(sqx), Math.floor(sqy), { auto: true });
  };
  Ground.prototype.aiDefend = function(tm, ids) {
    var ag = this.agents, sqx = this.sx + SQUARE / 2, sqy = this.sy + SQUARE / 2, posts = this.defPosts(tm);
    // прорвавшиеся: видимые враги в ядре города
    var intr = [];
    for (var j = 0; j < ag.length; j++) { var b = ag[j]; if (!b.alive || this.ctl(b) === tm || b.air || !this.canSee(tm, b)) continue; if (Math.max(Math.abs(b.x - sqx), Math.abs(b.y - sqy)) <= SQUARE / 2 + 6) intr.push(b); }
    for (var i = 0; i < ids.length; i++) {
      var a = ag[ids[i]];
      if (!a.dpost) {
        var list = a.T.cls === 'aa' || a.air || a.T.medic || a.T.builder ? posts.near : a.T.vehicle ? posts.veh : posts.foot;
        var p = this.freePost(list, a) || this.freePost(posts.foot, a);
        if (!p) continue;
        p.by = a.id; a.dpost = p; a.hold = false; a.sortie = false; a.post = false; a.focus = -1;
        this.goCell(a, p.x, p.y, this.qkey(a, p.x, p.y));
        continue;
      }
      if (a.hero) {
        // герой: ближайший враг в SORTIE/2 — навстречу, иначе на пост
        var en = this.nearestEnemy(a, SORTIE / 2);
        if (en) { if (!a.sortie || a.at) { a.sortie = true; a.hold = false; this.goCell(a, Math.floor(en.x), Math.floor(en.y), this.qkey(a, Math.floor(en.x), Math.floor(en.y))); } continue; }
      } else if (intr.length && a.tgt < 0 && !a.air) {
        var best = null, bd = SORTIE * SORTIE;
        for (var q = 0; q < intr.length; q++) { var dx = intr[q].x - a.x, dy = intr[q].y - a.y, d = dx * dx + dy * dy; if (d < bd) { bd = d; best = intr[q]; } }
        if (best) { if (!a.sortie || a.at) { a.sortie = true; a.hold = false; this.goCell(a, Math.floor(best.x), Math.floor(best.y), this.qkey(a, Math.floor(best.x), Math.floor(best.y))); } continue; }
      }
      if (a.sortie && a.tgt < 0 && (a.at || !a.goal)) { a.sortie = false; this.goCell(a, a.dpost.x, a.dpost.y, this.qkey(a, a.dpost.x, a.dpost.y)); continue; }
      if (!a.sortie && a.at && !a.hold) { var c = this.cellOf(a); a.goal = [c[0], c[1]]; a.hold = true; }
    }
  };
  // ---- захват площади: как capture_tick в игре, перевес даёт +1/с, равенство — спор
  Ground.prototype.capture = function(dt) {
    var cnt = [0, 0], ag = this.agents;
    for (var i = 0; i < ag.length; i++) {
      var a = ag[i]; if (!a.alive || a.air || a.T.vehicle || a.team > 1) continue;
      if (a.x >= this.sx && a.x < this.sx + SQUARE && a.y >= this.sy && a.y < this.sy + SQUARE) cnt[a.team]++;
    }
    var c = this.cap; c.cnt = cnt;
    var A = cnt[this.att], D = cnt[this.def];
    if (A > D) { c.rate = 1; c.status = 'capturing'; }
    else if (D > A) { c.rate = -1; c.status = c.prog > 0 ? 'reverting' : 'stalled'; }
    else { c.rate = 0; c.status = A ? 'contested' : 'stalled'; }
    c.prog = clamp(c.prog + c.rate * dt, 0, this.capNeed);
    // штурм отбит: десант уничтожен — или от него осталась горстка (≤10 %), и полторы минуты никого в городе
    var nA = this.alive(this.att), tw = this.town, near = false;
    if (this.attN0 == null && this.t > 5) this.attN0 = nA;
    for (i = 0; i < ag.length; i++) { var b = ag[i]; if (b.alive && this.ctl(b) === this.att && b.x >= tw[0] - 6 && b.x < tw[0] + tw[2] + 6 && b.y >= tw[1] - 6 && b.y < tw[1] + tw[3] + 6) { near = true; break; } }
    if (near || this.lastNear == null) this.lastNear = this.t;
    if (this.over < 0 && this.t > 5 && (nA === 0 || (this.attN0 && nA <= Math.max(2, this.attN0 * 0.1) && this.t - this.lastNear > 90))) { this.over = this.def; this.why = 'Штурм отбит'; this.msg('Штурм отбит', this.def, 'gold'); this.msg(nA ? 'Десант разбит' : 'Десант уничтожен', this.att, 'bad'); }
    if (c.prog >= this.capNeed && this.over < 0) { this.over = this.att; this.why = 'Площадь захвачена'; this.msg('Поселение захвачено', this.att, 'gold'); this.msg('Поселение потеряно', this.def, 'bad'); }
  };

  // ---- шаг
  Ground.prototype.step = function(dt) {
    this.acc = Math.min(this.acc + dt, 0.5);
    while (this.acc >= STEP) { this.acc -= STEP; this.tick(STEP); }
  };
  Ground.prototype.tick = function(dt) {
    this.t += dt;
    var ag = this.agents, i, a;
    this.fogT -= dt; if (this.fogT <= 0) { this.fogT = FOG_EVERY; this.fog(); this.fogN = (this.fogN || 0) + 1; }
    for (i = 0; i < ag.length; i++) {
      a = ag[i];
      if (!a.alive) { if (!a.gone && this.t - a.diedAt > DEATH_KEEP) a.gone = true; continue; }
      if (a.mind && a.mind.until <= this.t) { a.mind = null; a.tgt = -1; }
      this.think(a, dt);
    }
    this.collide(dt);
    this.fire(dt);
    this.shellsStep();
    this.structsStep(dt);
    this.aiT -= dt; if (this.aiT <= 0) { this.aiT = AI_EVERY; this.ai(); }
    this.capT += dt; if (this.capT >= CAP_EVERY) { this.capture(this.capT); this.capT = 0; }
    var t = this.t;
    if (this.ev.shots.length > 600) this.ev.shots.splice(0, 300);
    while (this.ev.shots.length && t - this.ev.shots[0].t > 1.5) this.ev.shots.shift();
    while (this.ev.booms.length && t - this.ev.booms[0].t > 3) this.ev.booms.shift();
    while (this.ev.deaths.length && t - this.ev.deaths[0].t > 5) this.ev.deaths.shift();
    while (this.ev.fx.length && t - this.ev.fx[0].t > 15) this.ev.fx.shift();
  };
  Ground.prototype.alive = function(team) { var n = 0; for (var i = 0; i < this.agents.length; i++) { var a = this.agents[i]; if (a.alive && this.ctl(a) === team) n++; } return n; };
  Ground.prototype.summary = function() {
    var self = this, s = { t: this.t, over: this.over, why: this.why, alive: [this.alive(0), this.alive(1)], cap: this.cap, sq: [[], []] };
    for (var tm = 0; tm < 2; tm++) s.sq[tm] = this.teams[tm].squads.map(function(q) { var n = 0; q.members.forEach(function(id) { if (self.agents[id].alive) n++; }); return { id: q.id, n: n }; });
    return s;
  };

  return { Ground: Ground, Flows: Flows, STEP: STEP, RANGE_K: RANGE_K, SABER: SABER, SQUARE: SQUARE, ABIL: ABIL, ABIL_NAME: ABIL_NAME, ACTIVE_LIGHT: ACTIVE_LIGHT, ACTIVE_DARK: ACTIVE_DARK, turn: turn, rng: rng };
});
