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
    typeof require === 'function' ? require('./rt-units.js') : root.SWUnits,
    typeof require === 'function' ? require('./rt-town.js') : root.SWTown
  );
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SWGround = api;
})(typeof self !== 'undefined' ? self : this, function(P, U, TOWN) {
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
  // Строй на ходу (боты ивентов, orderMove с form): ширина ряда, шаг между бойцами, дальше какого
  // расстояния от места боец его догоняет по полю направлений, за сколько клеток до цели строй распускается
  var FORM_COLS = 4, FORM_GAP = 1.35, FORM_LOST = 6, FORM_END = 5;
  // Радиус расталкивания техники (клетки): по её виду сверху, чтобы машины не наезжали друг
  // на друга и на пехоту. Проходимость считается по-прежнему 2×2 клетки.
  // = 0,42 × размах машины сверху (rt-vehicles span), чтобы пехота не стояла «внутри»
  var VRAD = { rep_atte: 1.9, rep_turbo: 2.5, rep_artillery: 2.3, cis_mtt: 2.5, cis_artillery: 1.7, cis_aat: 1.5, rep_aa: 1.35, cis_spider: 1.35, cis_missile: 1.35, rep_atrt: 0.7, rep_barc: 0.75, cis_stap: 0.6 };
  var RAD_MAX = 2.5;
  var DEF_NEAR = 7, DEF_FAR = 20;  // пояс обороны: расстояние от центра площади (клетки)
  var SORTIE = 18;                 // оборона бросается на прорвавшихся, если они ближе этого
  // Повадки в бою (как в абордаже): cover — ищет укрытие, откуда достаёт цель; push — идёт
  // на цель до near клеток; crowd — толпой подтягивается на 0,6 дальности; kite — держит
  // дистанцию, отходит, если цель ближе 0,45 дальности. every — как часто думать (с).
  var STYLE = {
    infantry: { k: 'cover', r: 5, every: 4 },
    cis_b1: { k: 'crowd', every: 1.5 }, cis_militia: { k: 'crowd', every: 1.5 }, rep_militia: { k: 'crowd', every: 1.5 },
    cis_b2: { k: 'push', near: 4, every: 1.3 },
    cis_wheel: { k: 'push', near: 10, every: 1.2 },     // подкатывается на выстрел и встаёт
    rep_barc: { k: 'kite', every: 1.2 }, cis_stap: { k: 'kite', every: 1.2 }, rep_atrt: { k: 'kite', every: 1.5 }
  };
  // Мародёры (команда 2, как npc_marauder_act в игре, расстояния — в клетках боя): грабят постройки
  // (кроме турелей, башен и ворот), охотятся на видимых врагов у логова, на толпу без злости не лезут,
  // раненые отходят, остальное время слоняются у города вне выстрела обороны; по концу налёта уходят с карты.
  var LOOT = { extractor: 1, cantina: 1, radar: 1, jammer: 1, camo: 1, trench: 1, bunker: 1 };
  var RAID = { hard: 40, hunt: 36, wary: 21, pack: 12, low: 0.35, flee: 15, loot: 24, ring: [6, 12], every: 120, leaveT: 90 };
  var MICRO_END = 3;               // столько секунд без боя — боец возвращается к приказу
  // Способности бойцов из исследований (ability_* в игре): боец применяет их сам, когда способность
  // готова и цель подходит; откат — секунды боя (в старой игре — полчаса между ходами).
  // Сила из игры: граната/фугас/огонь — сторона области (клетки игры), оглушение и спаренный — шанс %,
  // рывок — дальность (клетки игры); урон — ability_damage
  var SKILL = {
    grenade:     { cd: 24, name: 'Граната', dmg: 40 },
    he:          { cd: 20, name: 'Фугасный снаряд', dmg: 50 },
    suppression: { cd: 28, name: 'Заградительный огонь', dmg: 25 },
    stun:        { cd: 30, name: 'Оглушающий выстрел' },
    headshot:    { cd: 45, name: 'Выстрел в голову' },
    ap:          { cd: 14, name: 'Бронебойный снаряд' },
    twin:        { cd: 18, name: 'Спаренный выстрел' },
    lunge:       { cd: 22, name: 'Рывок с клинком', dmg: 120 },
    // врождённые — у охотников бара (HUNT)
    net:         { cd: 18, name: 'Сетемёт' },
    rocket:      { cd: 22, name: 'Наручная ракета', dmg: 60 }
  };
  // Охотники бара — охотники на одарённых (флаги rt-units: f, n, j).
  //  hero — урон по героям ×; внушение, умиротворение, страх и оглушение молнией их не берут.
  //  net — сетемёт следопыта: летит fly с, держит героя hero с (клинок режет сеть быстрее), остальных other с;
  //        дальность range (клетки игры); технику, авиацию и того, кто в полёте на ранце, не берёт. Пока на
  //        враге сеть: не ходит, без сил и выпадов, джедай не отражает выстрелы, стреляет с меткостью ×acc.
  //  scatter — дробовик следопыта: урон ×near в упор → ×far на предельной дальности; дробь отразить
  //        клинком труднее (шанс ×deflect); соседа цели в pellet клетках с шансом chance задевает part урона.
  //  twin — спаренные бластеры мандалорца: два болта, каждый — эта доля урона.
  //  rocket — наручная ракета: круг r клеток поля, летит со скоростью spd кл/с (одарённый, как от гранаты, — вполсилы).
  //  jet — реактивный ранец: враг с клинком ближе melee или любой ближе close — отскок на dist клеток
  //        за t с (в полёте стреляет, сеть и клинок его не достают); откат cd.
  var HUNT = { hero: 1.3,
    net: { range: 3, fly: 0.35, hero: 3.5, other: 6, acc: 0.5 },
    scatter: { near: 1.45, far: 0.55, deflect: 0.5, pellet: 1.2, chance: 0.5, part: 0.35 },
    twin: 0.5,
    rocket: { r: 1.6, spd: 24 },
    jet: { cd: 18, dist: 5.5, t: 0.7, melee: 2.6, close: 1.2, every: 0.25 } };
  var SUPP_T = 6, STUN_T = 5;
  // Медик (клон-медик, дроид-техник): раз в every с лечит самого раненого своего пехотинца или героя
  // в r клетках боя (не себя) на hp; оглушённый, залёгший в страхе или под чужой волей — не лечит
  var MEDIC = { every: 2, r: 3, hp: 8 };
  // Колесо Смерти (флаг w): катится — быстрый и увёртливый, но не стреляет; встал — за open с
  // раскрывается и ставит щит, чтобы покатиться дальше — за fold с сворачивается. Щит держит огонь
  // пехоты, техники издали (её выстрел садит щит в heavy раз сильнее), турелей и воздуха; не держит
  // артиллерию, технику в упор (point клеток) и героев (мечи, Сила). Пробит — молчит down с;
  // без попаданий calm с — восстанавливается.
  var WHEEL = { open: 1.1, fold: 0.7, sh: 180, regen: 25, calm: 3, down: 8, point: 4, eva: 20, heavy: 2 };
  var PEND_T = 30;                 // способность «на подходе»: столько секунд герой идёт к цели, потом отказ      // заградительный огонь: залёг (меткость ½, стреляет реже); оглушён — стоит

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
  // Кэш полей (поле ~20 КБ). Вытесняются только поля, которыми 2 с никто не пользовался: раньше при 64+ разных
  // целях вытеснялись нужные в том же такте и строились заново каждый такт (80 целей — 15 с счёта на 5 с боя).
  // soft (ход бойца): не больше BUDGET новых полей за шаг движка — остальные бойцы ждут шаг, а не тормозят всех.
  function Flows(g) { this.g = g; this.cache = {}; this.keys = []; this.MAX = 96; this.HARD = 512; this.BUDGET = 4; this.stepT = -1; this.stepN = 0; this.built = 0; this.ms = 0; }
  Flows.prototype.get = function(mv, size, tx, ty, soft) {
    var key = mv + size + ':' + tx + ',' + ty, f = this.cache[key];
    if (f) { f.used = this.g.t; return f; }
    if (soft) {
      if (this.stepT !== this.g.t) { this.stepT = this.g.t; this.stepN = 0; }
      if (this.stepN >= this.BUDGET) return null;
      this.stepN++;
    }
    var t0 = Date.now();
    f = this.build(mv, size, tx, ty);
    this.cache[key] = f; this.keys.push(key); this.built++; this.ms += Date.now() - t0;
    if (this.keys.length > this.MAX) {
      var self = this, cut = this.g.t - 2; this.keys.sort(function(a, b) { return self.cache[a].used - self.cache[b].used; });
      while (this.keys.length > this.MAX * 0.75 && (this.cache[this.keys[0]].used < cut || this.keys.length > this.HARD)) delete this.cache[this.keys.shift()];
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
  // Карта ивента: слои как есть, «город» пустой и за краем карты (площади и стен нет)
  function noTownMap(json) {
    var map = P.load(json), town = { level: 0, name: json.name || '', k: 0, wall: null, gates: [], towers: [], districts: [], blocks: [], square: [-100, -100, 0, 0], cx: -96, cy: -96, look: TOWN.look(json.id) };
    var out = { id: json.id, v: json.v, w: map.w, h: map.h, seed: json.seed, town: [-104, -104, 8, 8], t: map.t, e: map.e, m: map.m, objs: json.objs || [], paths: json.paths || [], name: json.name, about: json.about, look: json.look, zones: { deploy: [], slots: [] }, settle: town, ev: json.ev || null };
    return { map: out, town: town };
  }
  function Ground(mapJson, opts) {
    opts = opts || {};
    var self = this;
    // поселение: город накладывается на карту (стены, ворота, кварталы) по уровню и районам из игры
    // ивент (opts.noTown): своя выдуманная карта без города — ни стен, ни площади, ни захвата
    this.noTown = !!opts.noTown;
    var ap = this.noTown ? noTownMap(mapJson) : TOWN.apply(mapJson, opts.settle || { level: 1, districts: [] });
    this.mapJson = ap.map; this.settle = ap.town;
    this.map = P.load(ap.map);
    this.id = mapJson.id; this.town = this.noTown ? ap.map.town : mapJson.town || P.GEO.town; this.zones = this.noTown ? ap.map.zones : mapJson.zones || { deploy: [], slots: [] };
    this.R = rng(opts.seed || 7);
    this.t = 0; this.acc = 0; this.over = -1; this.why = '';
    this.agents = []; this.used = [];
    this.ev = { shots: [], booms: [], msgs: [], deaths: [], fx: [], shells: [] };
    this.seq = 0;
    this.teams = [{ auto: !!opts.auto0, squads: [] }, { auto: opts.auto1 == null ? true : !!opts.auto1, squads: [] }, { auto: true, squads: [] }];
    this.att = opts.att == null ? 0 : opts.att; this.def = 1 - this.att;      // кто штурмует планету
    this.capNeed = opts.captureSeconds || 21600;
    this.militiaAuto = !!opts.militiaAuto;
    this.capExternal = !!opts.capExternal;   // в игре прогресс захвата и исход считает база (capture_tick)
    this.cap = { prog: 0, rate: 0, status: 'stalled', cnt: [0, 0] };
    this.structs = [];
    this.weather = opts.weather != null ? opts.weather : P.WEATHER[this.id] ? P.WEATHER[this.id][1] : 0;
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
    this.seen = [new Uint8Array(n), new Uint8Array(n), new Uint8Array(n)];     // третий — банда мародёров
    this.fogT = 0; this.aiT = 0; this.capT = 0; this.sqT = 0;
    this.flows = new Flows(this); this.claim = {};
    this.sx = this.town[0] + (this.town[2] >> 1) - (SQUARE >> 1); this.sy = this.town[1] + (this.town[3] >> 1) - (SQUARE >> 1);
    this.nextId = 0;
    // ворота и башни города — хозяина планеты; районы — кто держит (сначала хозяин)
    var st = this.settle, def = this.def;
    st.gates.forEach(function(g) { g.s = self.addStruct('gate', def, g.x, g.y, { w: g.w, h: g.h, hp: 600 + 300 * st.level }); });
    st.towers.forEach(function(tw) { tw.s = self.addStruct('tower', def, tw.x, tw.y); });
    this.districts = st.districts.map(function(d) { return { id: d.id, name: d.name, effect: d.effect, rect: d.rect, spawn: d.spawn, by: def, cnt: [0, 0] }; });
    this.militiaT = -1;
    this.spy = -1;      // настроения планеты (sql/loyalty.sql): подполье открывает поселение этой стороне
  }

  // ---- бойцы
  Ground.prototype.add = function(tid, team, x, y, extra) {
    var Ty = U.type(tid); if (!Ty) return null;
    extra = extra || {};
    var a = {
      id: this.agents.length, tid: tid, T: Ty, team: team, x: x, y: y, vx: 0, vy: 0, dvx: 0, dvy: 0,
      aim: extra.aim || 0, legs: extra.aim || 0, mv: 0, phase: this.R() * TAU,
      hpMax: Math.round((extra.hpMax || Ty.hp) * (extra.hpK || 1)), hp: 0, alive: true, gone: false, diedAt: 0,
      size: Ty.size, move: Ty.move, air: Ty.air, fly: Ty.move === 'air', speed: Ty.speed, range: Ty.range * RANGE_K, vision: Ty.vision * RANGE_K,
      goal: null, at: true, post: false, hold: false, sq: 0, tgt: -1, focus: -1, scan: this.R() * SCAN, cd: this.R() * Ty.rof,
      stuck: 0, lastD: 1e9, wig: 0, side: 1, wait: 0, engT: -99, turretA: extra.aim || 0, inside: -1,
      uid: extra.uid || null, name: extra.name || '', owner: extra.owner || null, dmgK: extra.dmgK || 1,
      stun: 0, fear: 0, choke: -1, mind: null, barrier: 0, revealT: -99, netT: 0, jet: null, jetCd: 0,
      hero: null, auto: false, dpost: null, sortie: false, lane: -1, ph: 0, jam: 0, ghostT: -1, og: null, mc: null, mT: 0, inCov: false, npc: !!extra.npc, rofK: 1, accB: 0, evaB: 0
    };
    a.rad = VRAD[tid] != null ? VRAD[tid] : (Ty.size === 2 ? 1.0 : R);
    if (Ty.wheel) { a.wh = { k: 0, sh: WHEEL.sh, shMax: WHEEL.sh, down: -1, hitT: -99, fxT: -99 }; a.rad = 0.4; }
    if (Ty.hero) {
      a.range = SABER; a.hero = { act: 'idle', k: 0, actT: 0, cds: {}, abil: extra.abil || (team === 0 ? ACTIVE_LIGHT : ACTIVE_DARK).slice(), portrait: extra.portrait || (team === 0 ? 'jedi_01' : 'sith_01'), passive: extra.passive || {} };
      if (a.hero.passive.hp) a.hpMax += a.hero.passive.hp;
      if (a.hero.passive.vision) a.vision += a.hero.passive.vision * RANGE_K;
    }
    // бонусы из игры (bonus_*): дальность и обзор — клетки игры, ход — клетки за ход, меткость и уклонение — проценты
    var bo = extra.bonus || null;
    if (bo) {
      if (bo.range && !Ty.hero) { a.range += bo.range * RANGE_K; a.rangeB = bo.range; }   // спад меткости — на всю новую дальность (statsOf); у героя клинок
      if (bo.vision) a.vision += bo.vision * RANGE_K;
      if (bo.move) a.speed = Math.max(0.2, (Ty.speed / U.SPEED_K + bo.move) * U.SPEED_K);
      if (bo.damage && Ty.dmg > 0) a.dmgK *= (Ty.dmg + bo.damage) / Ty.dmg;
      a.accB = bo.accuracy || 0; a.evaB = bo.evasion || 0;
    }
    if (Ty.artillery) a.range = Ty.range;       // артиллерия: на всю карту (144)
    // способности из исследований: [вид, сила, урон]; первая готова не сразу — через 3–11 с
    if (extra.skills && extra.skills.length) {
      var self0 = this;
      a.sk = extra.skills.filter(function(q) { return q && SKILL[q[0]]; }).map(function(q) { return { k: q[0], v: +q[1] || 0, dmg: +q[2] || 0, ready: self0.t + 3 + self0.R() * 8 }; });
      if (!a.sk.length) a.sk = null;
    }
    // охотники бара: сетемёт или наручная ракета — с рождения; ранец мандалорца готов через 3 с
    if (Ty.netter || Ty.mando) (a.sk = a.sk || []).push({ k: Ty.netter ? 'net' : 'rocket', v: 0, dmg: 0, ready: this.t + 2 + this.R() * 4 });
    if (Ty.mando) a.jetCd = this.t + 3;
    a.hp = extra.hp != null ? Math.min(a.hpMax, extra.hp) : a.hpMax;
    this.agents.push(a); this.used.push(a.id);
    if (this.nextIn.length < this.agents.length) { var ni = new Int32Array(this.agents.length + 256); ni.set(this.nextIn); this.nextIn = ni; }
    return a;
  };
  Ground.prototype.addStruct = function(kind, team, x, y, extra) {
    var S = U.ST[kind]; if (!S) return null;
    var s = { i: this.structs.length, kind: kind, team: team, x: x, y: y, w: (extra && extra.w) || S[1], h: (extra && extra.h) || S[1], hp: (extra && extra.hp) || S[2], hpMax: (extra && extra.hp) || S[2], cover: S[3], inMul: S[4], radius: S[5], dmg: S[6], acc: S[7], enter: S[8], infOnly: S[9], cd: 0, tgt: -1, dead: false, name: S[0], uid: extra && extra.uid, res: (extra && extra.res) || null };
    // мина клетку не занимает: по ней ходят все — свои спокойно, враг до первого шага
    if (kind !== 'landmine') for (var j = 0; j < s.h; j++) for (var i = 0; i < s.w; i++) { var c = (y + j) * N + x + i; if (c >= 0 && c < N * N) this.structAt[c] = s.i; }
    this.structs.push(s);
    return s;
  };
  // клетка бойца; в полёте на ранце — клетка посадки (над скалой и водой он только пролетает)
  Ground.prototype.cellOf = function(a) { if (a.jet) return [Math.floor(a.jet.x1), Math.floor(a.jet.y1)]; return a.size === 2 ? [Math.round(a.x) - 1, Math.round(a.y) - 1] : [Math.floor(a.x), Math.floor(a.y)]; };
  Ground.prototype.okAt = function(a, cx, cy) {
    if (cx < 0 || cy < 0 || cx >= N || cy >= N) return false;
    var c = cy * N + cx;
    if (!this.pass[a.move + a.size][c]) return false;
    var s = this.structAt[c];
    if (s >= 0 && !(a.air || a.fly)) { var st = this.structs[s]; if (st.dead) return true; if (!st.enter || st.team !== a.team || (st.infOnly && a.T.cls !== 'infantry' && a.T.cls !== 'hero')) return false; }
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
      if (!(opts && opts.auto)) { this.microEnd(a, true); if (a.hero) a.hero.pend = null; }
      this.mark(taken, spot[0], spot[1], a);
      this.goCell(a, spot[0], spot[1], [cx, cy]); a.post = !(opts && opts.auto); a.hold = false; a.focus = -1; n++;
      if (!(opts && opts.auto)) { a.auto = false; a.dpost = null; a.sortie = false; }
    }
    if (opts && opts.form) this.formation(list, cx, cy);
    return n;
  };
  // Строй (opts.form — боты ивентов): пехота идёт за ведущим своими местами в строю, а не гуськом по одной
  // тропе. Ведущий — кто ближе к цели; места — ряды по FORM_COLS, ближе к своему месту в группе.
  // Место в строю закрыто (скала, стена) или отстал — идёт по полю направлений, потом догоняет строй
  Ground.prototype.formation = function(list, cx, cy) {
    var inf = list.filter(function(a) { return a.size === 1 && !a.hero && !a.air && !a.fly && a.goal && !a.at; }), i, j;
    for (i = 0; i < list.length; i++) list[i].fm = null;
    if (inf.length < 3) return;
    var mx = 0, my = 0; inf.forEach(function(a) { mx += a.x; my += a.y; }); mx /= inf.length; my /= inf.length;
    var hx = cx + 0.5 - mx, hy = cy + 0.5 - my, L = Math.sqrt(hx * hx + hy * hy); if (L < 8) return;
    var ux = hx / L, uy = hy / L;
    // ведущий — впереди всех по ходу; остальные — по местам: ряды за ним (клин), ближайшее к себе место
    inf.sort(function(a, b) { return ((b.x - mx) * ux + (b.y - my) * uy) - ((a.x - mx) * ux + (a.y - my) * uy); });
    var lead = inf[0], cols = Math.min(FORM_COLS, Math.max(2, Math.ceil(Math.sqrt(inf.length)) + 1)), slots = [];
    for (var r = 0; slots.length < inf.length + 4; r++) for (var c = 0; c < cols + 1; c++) {
      var l = (c - cols / 2) * FORM_GAP; if (r === 0 && Math.abs(l) < 0.01) continue;
      slots.push({ f: -r * FORM_GAP - Math.abs(l) * 0.35, l: l, k: r + Math.abs(l) * 0.4 });
    }
    slots.sort(function(a, b) { return a.k - b.k; });
    var speed = Math.min.apply(null, inf.map(function(a) { return a.speed; }));
    lead.fm = { lead: lead.id, self: true, sp: speed };
    var free = inf.slice(1);
    for (i = 0; i < slots.length && free.length; i++) {
      var sl = slots[i], best = -1, bd = 1e9;
      for (j = 0; j < free.length; j++) {
        var b = free[j], rx = b.x - lead.x, ry = b.y - lead.y, f = rx * ux + ry * uy, ll = rx * -uy + ry * ux;
        var d = (f - sl.f) * (f - sl.f) + (ll - sl.l) * (ll - sl.l); if (d < bd) { bd = d; best = j; }
      }
      free[best].fm = { lead: lead.id, f: sl.f, l: sl.l, sp: speed };
      free.splice(best, 1);
    }
  };
  // Шаг в строю: true — шаг сделан (место в строю видно и досягаемо), false — идти как обычно
  Ground.prototype.formStep = function(a, dt, dist) {
    var fm = a.fm, Ld = this.agents[fm.lead];
    if (!Ld || !Ld.alive || Ld.at || !Ld.goal || !Ld.fm || Ld.fm.lead !== Ld.id) { a.fm = null; return false; }
    var lv = Math.sqrt(Ld.vx * Ld.vx + Ld.vy * Ld.vy), h = lv > 0.05 ? Math.atan2(Ld.vy, Ld.vx) : Ld.legs;
    var fx = Math.cos(h), fy = Math.sin(h);
    var sx = Ld.x + fx * fm.f - fy * fm.l, sy = Ld.y + fy * fm.f + fx * fm.l;
    var dx = sx - a.x, dy = sy - a.y, d = Math.sqrt(dx * dx + dy * dy);
    if (d > FORM_LOST) return false;                                       // отстал — догоняет по полю
    var gx = Math.floor(sx), gy = Math.floor(sy);
    if (!this.okAt(a, gx, gy) || !this.straight(a, sx, sy)) return false;
    // скорость: как у ведущего, отставший — быстрее (но не быстрее себя)
    var spc = P.speed(this.map, Math.floor(a.x), Math.floor(a.y), a.move) || 1, sp = Math.min(a.speed * 1.15, lv + d * 0.9);
    var vx, vy;
    if (d > 0.08) { vx = dx / d * sp * spc; vy = dy / d * sp * spc; }
    else { vx = Ld.vx; vy = Ld.vy; }
    // по пути — снова ведущим к своей точке строй держит место; на месте в строю — шаг ведущего
    if (d < 0.6 && lv > 0.05) { vx = vx * 0.5 + Ld.vx * 0.5; vy = vy * 0.5 + Ld.vy * 0.5; }
    a.dvx = vx; a.dvy = vy;
    if (dist < a.lastD - 0.05) { a.lastD = dist; a.stuck = 0; a.jam = 0; } else a.stuck = Math.max(0, a.stuck - dt);
    var ang = Math.atan2(vy, vx), v = Math.sqrt(vx * vx + vy * vy);
    if (v > 0.05) { a.legs = turn(a.legs, ang, LEGS * dt); if (!(a.tgt >= 0 || a.focus >= 0)) a.aim = turn(a.aim, ang, TURN * dt); }
    a.mv += ((v > 0.05 ? 1 : 0) - a.mv) * Math.min(1, dt * 6);
    a.phase = (a.phase + dt * 7 * (v / Math.max(0.5, a.T.speed))) % TAU;
    return true;
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
        // окоп, бункер — каждая клетка укрепления занимается (иначе боец вставал рядом с окопом)
        var sti = this.structAt[c], inSt = sti >= 0 && this.structs[sti].enter && !this.structs[sti].dead;
        if (a.size === 1 && r < 10 && ((x + y) & 1) && !inSt) continue;          // пехота — в шахматном порядке, чтобы не толпиться
        var d = dx * dx + dy * dy; if (d < bd) { bd = d; best = [x, y]; }
      }
    }
    return best;
  };
  // key — общая точка отряда: поле направлений строится к ней одно на всех, последние клетки — напрямую
  Ground.prototype.goCell = function(a, cx, cy, key) {
    if (a.og) { a.og = { g: [cx, cy], key: key || null, at: false }; return; }     // занят повадкой в бою — приказ подождёт
    a.goal = [cx, cy]; a.key = key || null; a.at = false; a.stuck = 0; a.lastD = 1e9; a.wait = 0; a.fm = null;
  };
  // Прямой ход до клетки: все клетки на отрезке проходимы
  Ground.prototype.straight = function(a, tx, ty) {
    var ok = this.pass[a.move + a.size], dx = tx - a.x, dy = ty - a.y, L = Math.sqrt(dx * dx + dy * dy), n = Math.ceil(L * 2) + 1, off = a.size === 2 ? 1 : 0.5;
    for (var i = 0; i <= n; i++) { var f = i / n, x = Math.floor(a.x + dx * f - (off - 0.5)), y = Math.floor(a.y + dy * f - (off - 0.5)); if (x < 0 || y < 0 || x >= N || y >= N || !ok[y * N + x]) return false; }
    return true;
  };
  Ground.prototype.orderAttack = function(team, ids, tid) {
    var self = this, tg = this.agents[tid]; if (!tg || !tg.alive || tg.team === team) return 0;
    var n = 0;
    ids.forEach(function(i) { var a = self.agents[i]; if (!self.mine(team, a)) return; self.microEnd(a, true); if (a.hero) a.hero.pend = null; a.focus = tid; a.post = false; a.hold = false; a.goal = null; a.at = true; a.auto = false; a.dpost = null; a.sortie = false; n++; });
    return n;
  };
  Ground.prototype.orderHold = function(team, ids) {
    var self = this, n = 0;
    ids.forEach(function(i) { var a = self.agents[i]; if (!self.mine(team, a)) return; self.microEnd(a, true); if (a.hero) a.hero.pend = null; var c = self.cellOf(a); a.goal = [c[0], c[1]]; a.at = true; a.post = true; a.hold = true; a.focus = -1; a.auto = false; a.dpost = null; a.sortie = false; n++; });
    return n;
  };
  Ground.prototype.orderStop = function(team, ids) {
    var self = this, n = 0;
    ids.forEach(function(i) { var a = self.agents[i]; if (!self.mine(team, a)) return; self.microEnd(a, true); if (a.hero) a.hero.pend = null; a.goal = null; a.at = true; a.post = false; a.hold = false; a.focus = -1; a.auto = false; a.dpost = null; a.sortie = false; n++; });
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
  Ground.prototype.setAuto = function(team, ids, on) { var self = this; ids.forEach(function(i) { var a = self.agents[i]; if (self.mine(team, a)) { a.post = !on && a.post; a.auto = !!on; if (on) { if (a.hero) a.hero.pend = null; a.hold = false; a.dpost = null; a.sortie = false; a.ph = 0; } } }); };

  // ---- обзор
  Ground.prototype.canSee = function(team, b) {
    if (b.team === team) return true;
    if (b.air) return !this.seen[team] || this.seen[team][clamp(Math.floor(b.y), 0, N - 1) * N + clamp(Math.floor(b.x), 0, N - 1)] === 2;
    var c = clamp(Math.floor(b.y), 0, N - 1) * N + clamp(Math.floor(b.x), 0, N - 1), sn = this.seen[team];
    if (!sn) return true;
    if (sn[c] !== 2) return false;
    // скрытный разведчик: виден только вблизи (stealth_range) или после выстрела; маскировочная сеть — 3 клетки
    var st = (b.sneak || b.T.stealth) ? (b.sneak || b.T.stealth) * RANGE_K : 0;
    if (b.inside >= 0 && this.structs[b.inside].kind === 'camo') st = Math.max(st, 3 * RANGE_K);
    if (st && this.t - b.revealT > (b.revealFor || 120)) { if (this.nearestOwn(team, b.x, b.y, st) < 0 && !this.radarSees(team, b.x, b.y)) return false; }
    return true;
  };
  // постройку видели, если открыта хоть одна её клетка (луч обзора упирается в ближнюю сторону)
  Ground.prototype.structSeen = function(team, st) {
    if (st.kind === 'landmine' && st.team !== team) return false;          // чужую мину не видно — не по чему стрелять
    var sn = this.seen[team]; if (!sn) return true;
    for (var y = st.y; y < st.y + st.h; y++) for (var x = st.x; x < st.x + st.w; x++) if (x >= 0 && y >= 0 && x < N && y < N && sn[y * N + x] >= 1) return true;
    return false;
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
    for (var tm = 0; tm < this.seen.length; tm++) { var s = this.seen[tm]; for (k = 0; k < s.length; k++) if (s[k] === 2) s[k] = 1; }
    var jam = this.structs.filter(function(s) { return !s.dead && s.kind === 'jammer'; });
    for (i = 0; i < ag.length; i++) {
      var a = ag[i]; if (!a.alive || !this.seen[a.team]) continue;
      var r = a.vision - this.weather * RANGE_K;
      // глушилка врага: обзор режется до 2 клеток
      for (var j = 0; j < jam.length; j++) { var jm = jam[j]; if (jm.team === a.team) continue; var jdx = jm.x + 1 - a.x, jdy = jm.y + 1 - a.y; if (jdx * jdx + jdy * jdy <= jm.radius * jm.radius * RANGE_K * RANGE_K) r = Math.min(r, 2 * RANGE_K); }
      if ((a.air || a.fly)) r += 2;
      this.reveal(a.team, a.x, a.y, r, a.x, a.y);
    }
    // узел связи: кто держит — видит всё в 24 клетках от центра города
    for (i = 0; i < this.districts.length; i++) { var dd = this.districts[i]; if (dd.id === 'comms' && dd.by >= 0 && dd.by <= 1) this.reveal(dd.by, this.sx + SQUARE / 2, this.sy + SQUARE / 2, 8 * RANGE_K); }
    // подполье доносит наступающим: поселение видно, как с узла связи
    if (this.spy === 0 || this.spy === 1) this.reveal(this.spy, this.sx + SQUARE / 2, this.sy + SQUARE / 2, 8 * RANGE_K);
    for (i = 0; i < this.structs.length; i++) { var st = this.structs[i]; if (st.dead || st.team > 1) continue; if (st.kind === 'radar' || st.kind === 'turret') this.reveal(st.team, st.x + st.w / 2, st.y + st.h / 2, (st.radius || 3) * RANGE_K); }
    // полоса вторжения всегда видна хозяину планеты
    if (this.noTown) return;
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

  // Что прикрывает бойца — для карточки: укрепление, рельеф рядом, свет
  Ground.prototype.coverInfo = function(a) {
    if (a.air || a.fly) return { k: 'air', text: 'в воздухе' };
    if (a.inside >= 0) { var st = this.structs[a.inside]; if (st && !st.dead) return { k: 'struct', text: st.name.toLowerCase() + ' · урон −' + st.cover + ' %' + (st.kind === 'trench' ? ', стреляет чаще' : '') }; }
    var m = this.map, bx = Math.floor(a.x), by = Math.floor(a.y), near = 0, lit = !!this.light[by * N + bx];
    for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) { var x = bx + dx, y = by + dy; if (x < 0 || y < 0 || x >= N || y >= N) continue; var c = y * N + x; if (m.t[c] === T.COVER || m.t[c] === T.TRAP) near++; }
    if (near) return { k: 'cover', text: 'за укрытием (с той стороны, где оно)' + (lit ? ' · на свету' : '') };
    return { k: 'open', text: 'на открытом месте' + (lit ? ' · на свету' : '') };
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
        if (b.hero && a.T.hunter) w *= 0.35;                     // охотник бара: одарённый — первая цель
        cand.push(d * w, j);
      }
    }
    // постройки врага (турели, радар, глушилка) — техника и артиллерия
    if (a.T.cls !== 'infantry' || true) for (i = 0; i < this.structs.length; i++) {
      var st = this.structs[i]; if (st.dead || st.team === team || st.team === 2) continue;
      if (team === 2 ? !LOOT[st.kind] : (st.kind !== 'turret' && st.kind !== 'radar' && st.kind !== 'jammer' && a.T.cls === 'infantry')) continue;
      var sdx = st.x + st.w / 2 - a.x, sdy = st.y + st.h / 2 - a.y, sd = sdx * sdx + sdy * sdy;
      if (sd > a.range * a.range) continue;
      if (!this.structSeen(team, st)) continue;
      cand.push(sd * (st.kind === 'turret' || st.kind === 'tower' ? 1.2 : st.kind === 'gate' ? 1.5 : 2.5), 100000 + i);
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
    // точки нет (приказ ждёт конца повадки: goCell при a.og кладёт его в og) — стоять, а не падать
    if (!a.goal) { a.at = true; a.mv += (0 - a.mv) * Math.min(1, dt * 6); return; }
    var c = this.cellOf(a), cx = c[0], cy = c[1], gx = a.goal[0], gy = a.goal[1];
    var off = a.size === 2 ? 1 : 0.5;
    var ddx = gx + off - a.x, ddy = gy + off - a.y, dist = Math.sqrt(ddx * ddx + ddy * ddy);
    if ((cx === gx && cy === gy && dist < 0.3) || (dist < 1.2 && a.stuck > 0.8)) { a.at = true; a.vx = a.vy = 0; a.fm = null; return; }
    // в строю: ведущий идёт шагом самого медленного, остальные держат места; у цели — каждый к своей клетке
    if (a.fm && !a.og) {
      if (dist <= FORM_END) a.fm = null;
      else if (a.fm.self) sp = Math.min(sp, a.fm.sp * 0.9);
      else if (this.formStep(a, dt, dist)) return;
    }
    var tx, ty;
    var key = a.key || a.goal;
    if ((a.air || a.fly) || (dist < 6 && this.straight(a, gx + off, gy + off))) { tx = gx + off; ty = gy + off; }
    else {
      var f = this.flows.get(a.move, a.size, key[0], key[1], true);
      if (!f) { a.mv += (0 - a.mv) * Math.min(1, dt * 6); return; }          // поле строится в следующий шаг (бюджет на шаг)
      var d = f.dir[cy * N + cx];
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
        // путь упёрся в чужие ворота — ломать их
        var gi = this.gateAt(nx, ny, a); if (gi >= 0 && a.T.dmg > 0) { a.tgt = 100000 + gi; a.scan = 1; }
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
  Ground.prototype.gateAt = function(x, y, a) {
    var si = this.structAt[y * N + x]; if (si < 0) return -1;
    var st = this.structs[si]; return st.kind === 'gate' && !st.dead && st.team !== this.ctl(a) && !(a.air || a.fly) ? si : -1;
  };
  Ground.prototype.think = function(a, dt) {
    a.dvx = 0; a.dvy = 0;
    var tg = null;
    if (a.stun > 0) { a.stun -= dt; a.mv += (0 - a.mv) * Math.min(1, dt * 6); return; }
    if (a.jet) { this.jetStep(a, dt); return; }
    if (a.netT > this.t) {
      // в сети: ни шагу, только поворот к цели (стреляет — хуже, см. fire)
      a.mv += (0 - a.mv) * Math.min(1, dt * 6);
      var tn = this.tgtPos(a); if (tn && !(a.T.vehicle && a.size === 2)) a.aim = turn(a.aim, Math.atan2(tn.y - a.y, tn.x - a.x), TURN * dt);
      return;
    }
    if (a.T.mando && this.t >= a.jetCd && this.jetCheck(a, dt)) return;
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
    // повадки в бою: укрытие, натиск, толпа, дистанция — не для стоящих по приказу
    if (!a.post && !a.hold && !a.hero && !a.T.artillery) {
      if (engaged && this.micro(a, tg, range, dt)) return;
      // под огнём без цели в дальности: перебежка в укрытие в сторону стрелка (и дальше по приказу, когда стихнет)
      if (!engaged && !a.inCov && this.t - (a.hitT || -99) < 2.5 && this.t >= (a.mT || 0) && a.T.cls === 'infantry' && !a.wh) {
        var sh = a.hitBy != null ? this.agents[a.hitBy] : null, en = sh && sh.alive ? sh : this.nearestEnemy(a, a.vision);
        if (en) { var ftg = { x: en.x, y: en.y, d: Math.sqrt((en.x - a.x) * (en.x - a.x) + (en.y - a.y) * (en.y - a.y)) }; a.engT = this.t; if (this.micro(a, ftg, Math.max(range, ftg.d + 1), dt)) return; }
      }
      if (a.og && this.t - (a.engT || -99) > MICRO_END) this.microEnd(a);
      else if (a.og && !a.at && a.goal) { this.nav(a, dt, a.speed); return; }
    }
    if (engaged) {
      a.mv += (0 - a.mv) * Math.min(1, dt * 6);
      if (tg.d > range * 0.6 && !a.at && !a.hold && a.goal && !a.wh) this.nav(a, dt, a.speed * 0.8);   // Колесо Смерти в бою стоит раскрытым
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
  // ---- охотники бара: реактивный ранец мандалорца
  // Угроза вплотную (клинок героя или любой враг совсем рядом) — отскок от неё; в окопе и бункере не взлетает
  Ground.prototype.jetCheck = function(a, dt) {
    var J = HUNT.jet;
    a.jetScan = (a.jetScan || 0) - dt; if (a.jetScan > 0) return false;
    a.jetScan = J.every;
    if (a.inside >= 0 || a.choke >= 0 || a.fear > 0) return false;
    var ag = this.agents, team = this.ctl(a), th = null, best = 1e9;
    for (var i = 0; i < ag.length; i++) {
      var b = ag[i]; if (!b.alive || b.air || b.fly || this.ctl(b) === team || b.netT > this.t || b.stun > 0) continue;
      var dx = b.x - a.x, dy = b.y - a.y, d = Math.sqrt(dx * dx + dy * dy), lim = b.hero ? J.melee : J.close;
      if (d < lim && d < best) { best = d; th = b; }
    }
    if (!th) return false;
    var bx = a.x - th.x, by = a.y - th.y, bl = Math.sqrt(bx * bx + by * by) || 1, base = Math.atan2(by / bl, bx / bl), land = null;
    var tries = [0, 0.5, -0.5, 1, -1, 1.5, -1.5], dists = [J.dist, J.dist - 1.2, J.dist - 2.2];
    for (var di = 0; di < dists.length && !land; di++) for (var ti = 0; ti < tries.length && !land; ti++) {
      var an = base + tries[ti], lx = Math.floor(a.x + Math.cos(an) * dists[di]), ly = Math.floor(a.y + Math.sin(an) * dists[di]);
      if (lx < 1 || ly < 1 || lx >= N - 1 || ly >= N - 1 || !this.okAt(a, lx, ly) || this.cellHead[ly * N + lx] !== -1) continue;
      land = [lx, ly];
    }
    if (!land) return false;
    a.jetCd = this.t + J.cd;
    a.jet = { t0: this.t, t1: this.t + J.t, x0: a.x, y0: a.y, x1: land[0] + 0.5, y1: land[1] + 0.5 };
    if (a.og) this.microEnd(a);
    if (a.at || !a.goal) { a.goal = [land[0], land[1]]; a.key = null; a.at = true; }
    a.vx = a.vy = a.dvx = a.dvy = 0; a.stuck = 0; a.lastD = 1e9;
    this.ev.fx.push({ t: this.t, k: 'jet', x: a.x, y: a.y, tx: a.jet.x1, ty: a.jet.y1, id: a.id, r: J.t });
    this.ev.fx.push({ t: this.t, k: 'skill', x: a.x, y: a.y, id: a.id, name: 'Реактивный ранец', team: a.team });
    return true;
  };
  // Полёт на ранце: по прямой над всем, лицом к цели; сел — дальше по приказу
  Ground.prototype.jetStep = function(a, dt) {
    var j = a.jet, k = Math.min(1, (this.t - j.t0) / (j.t1 - j.t0));
    a.x = j.x0 + (j.x1 - j.x0) * k; a.y = j.y0 + (j.y1 - j.y0) * k;
    a.vx = a.vy = a.dvx = a.dvy = 0; a.mv += (0 - a.mv) * Math.min(1, dt * 6);
    a.legs = turn(a.legs, Math.atan2(j.y1 - j.y0, j.x1 - j.x0), LEGS * dt);
    var tg = this.tgtPos(a); a.aim = turn(a.aim, tg ? Math.atan2(tg.y - a.y, tg.x - a.x) : a.legs, TURN * dt);
    if (k >= 1) { a.jet = null; a.x = j.x1; a.y = j.y1; }
  };
  // ---- повадки в бою
  Ground.prototype.styleOf = function(a) { return STYLE[a.tid] || (a.T.cls === 'infantry' ? STYLE.infantry : null); };
  // true — боец занят ходом по повадке (шаг сделан)
  Ground.prototype.micro = function(a, tg, range, dt) {
    var st = this.styleOf(a); if (!st) return false;
    if (this.t >= (a.mT || 0)) {
      a.mT = this.t + st.every * (0.8 + this.R() * 0.4);
      var cell = null;
      if (st.k === 'push') { if (tg.d > st.near + 0.5) cell = this.towards(a, tg, st.near); }
      else if (st.k === 'crowd') { if (tg.d > range * 0.75) cell = this.towards(a, tg, range * 0.6); }
      else if (st.k === 'kite') {
        if (tg.d < range * 0.45) cell = this.away(a, tg, range * 0.7);
        else if (tg.d > range * 0.9) cell = this.towards(a, tg, range * 0.7);
      } else if (st.k === 'cover') {
        a.inCov = this.coverK(a.x, a.y, tg.x, tg.y, a.team) < 1;
        if (!a.inCov) cell = this.coverCell(a, tg, st.r, range);
      }
      if (cell && (cell[0] !== Math.floor(a.x) || cell[1] !== Math.floor(a.y))) this.microGo(a, cell);
    }
    if (a.og && !a.at && a.goal) {
      if (st.k === 'push' && tg.d <= st.near) { a.goal = [Math.floor(a.x), Math.floor(a.y)]; a.at = true; return false; }
      this.nav(a, dt, a.speed * (st.k === 'push' ? 1 : 1.1));
      return true;
    }
    return false;
  };
  // Укрытие точки (px, py) от стрелка в (tx, ty): 1 — нет; меньше — есть (валун, ёж, заросли, окоп своей стороны)
  Ground.prototype.coverK = function(px, py, tx, ty, team) {
    var c = Math.floor(py) * N + Math.floor(px), si = this.structAt[c];
    if (si >= 0) { var st = this.structs[si]; if (!st.dead && st.enter && st.team === team && st.cover) return 1 - st.cover / 100; }
    return this.cover(tx, ty, { x: px, y: py, size: 1, inside: -1, air: false });
  };
  // Клетка по прямой к цели, в near клетках от неё (свободная, проходимая, по прямой)
  Ground.prototype.towards = function(a, tg, near) {
    var k = Math.max(0, 1 - near / Math.max(0.01, tg.d)), x = Math.floor(a.x + (tg.x - a.x) * k), y = Math.floor(a.y + (tg.y - a.y) * k);
    return this.freeNear(a, x, y, 1);
  };
  Ground.prototype.away = function(a, tg, want) {
    var dx = a.x - tg.x, dy = a.y - tg.y, L = Math.sqrt(dx * dx + dy * dy) || 1, k = want - L;
    return this.freeNear(a, Math.floor(a.x + dx / L * k), Math.floor(a.y + dy / L * k), 2);
  };
  Ground.prototype.freeNear = function(a, x, y, r) {
    var off = a.size === 2 ? 1 : 0.5, best = null, bd = 1e9;
    for (var dy = -r; dy <= r; dy++) for (var dx = -r; dx <= r; dx++) {
      var cx = x + dx, cy = y + dy; if (cx < 1 || cy < 1 || cx >= N - 1 || cy >= N - 1) continue;
      var c = cy * N + cx; if (!this.okAt(a, cx, cy) || this.claim[c] != null && this.claim[c] !== a.id) continue;
      if (!this.straight(a, cx + off, cy + off)) continue;
      var d = dx * dx + dy * dy; if (d < bd) { bd = d; best = [cx, cy]; }
    }
    return best;
  };
  // Укрытие: клетка в R шагах, откуда цель видна и достаётся, а стрелку хуже попасть
  Ground.prototype.coverCell = function(a, tg, R, range) {
    var ok = this.pass[a.move + 1], sx = Math.floor(a.x), sy = Math.floor(a.y), s0 = sy * N + sx, best = null, bs = 1e9;
    var q = [s0], dep = [0], seen = {}; seen[s0] = 1;
    for (var h = 0; h < q.length; h++) {
      var k = q[h], x = k % N, y = (k - x) / N, d = dep[h];
      if (d > 0) {
        var cl = this.claim[k], ca = cl != null && this.agents[cl], free = !(ca && ca !== a && ca.alive && ca.og), o = this.cellHead[k];
        if (free && (o === -1 || o === a.id)) {
          var px = x + 0.5, py = y + 0.5, ddx = tg.x - px, ddy = tg.y - py, dd = Math.sqrt(ddx * ddx + ddy * ddy);
          if (dd <= range * 0.95 && dd > 1.5) {
            var kc = this.coverK(px, py, tg.x, tg.y, a.team);
            if (kc < 1 && this.los(px, py, tg.x, tg.y) && this.straight(a, px, py)) {
              var sc = d + Math.abs(dd - range * 0.7) * 0.3 + kc * 3;
              if (sc < bs) { bs = sc; best = [x, y]; }
            }
          }
        }
      }
      if (d >= R) continue;
      for (var o4 = 0; o4 < 4; o4++) {
        var nx = x + (o4 === 0 ? 1 : o4 === 1 ? -1 : 0), ny = y + (o4 === 2 ? 1 : o4 === 3 ? -1 : 0), nk = ny * N + nx;
        if (nx < 0 || ny < 0 || nx >= N || ny >= N || seen[nk] || !ok[nk] || !P.canStep(this.map, x, y, nx, ny, a.move)) continue;
        seen[nk] = 1; q.push(nk); dep.push(d + 1);
      }
    }
    return best;
  };
  // Сместиться по повадке; приказ (куда шёл) вернётся, когда бой стихнет
  Ground.prototype.microGo = function(a, cell) {
    if (!a.og) a.og = { g: a.goal, key: a.key, at: a.at };
    if (a.mc != null && this.claim[a.mc] === a.id) delete this.claim[a.mc];
    a.mc = cell[1] * N + cell[0]; this.claim[a.mc] = a.id;
    a.goal = [cell[0], cell[1]]; a.key = null; a.at = false; a.stuck = 0; a.lastD = 1e9; a.wait = 0;
  };
  Ground.prototype.microEnd = function(a, drop) {
    if (a.mc != null && this.claim[a.mc] === a.id) delete this.claim[a.mc];
    a.mc = null; a.inCov = false;
    var og = a.og; a.og = null;
    if (!og || drop) return;
    if (og.g && !og.at) { a.goal = og.g; a.key = og.key; a.at = false; a.stuck = 0; a.lastD = 1e9; }
    else { a.goal = og.g; a.at = true; }
  };
  // Меткость, уклонение и дальность (клетки игры) — с исследованиями и пассивами героя
  Ground.prototype.statsOf = function(a) {
    var rg = a.T.range + (a.rangeB || 0);
    if (a.wh && a.wh.k < 0.5) return { acc: a.T.acc + (a.accB || 0), eva: a.T.eva + (a.evaB || 0) + WHEEL.eva, range: rg, cls: a.T.cls, dmg: a.T.dmg };   // катится — попасть труднее
    if (!a.accB && !a.evaB && !a.rangeB) return a.T;
    return { acc: a.T.acc + (a.accB || 0), eva: a.T.eva + (a.evaB || 0), range: rg, cls: a.T.cls, dmg: a.T.dmg };
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
      if (!(a.air || a.fly || a.jet)) this.wall(a);
    }
    this.cellHead.fill(-1);
    for (i = 0; i < ag.length; i++) {
      a = ag[i]; if (!a.alive) continue;
      var cx = clamp(Math.floor(a.x), 0, N - 1), cy = clamp(Math.floor(a.y), 0, N - 1), c = cy * N + cx;
      this.nextIn[i] = this.cellHead[c]; this.cellHead[c] = i;
    }
    for (i = 0; i < ag.length; i++) {
      a = ag[i]; if (!a.alive || a.air || a.fly || a.jet) continue;
      var ax = Math.floor(a.x), ay = Math.floor(a.y), ra = a.rad, rr = Math.ceil(ra + RAD_MAX);
      for (var yy = ay - rr; yy <= ay + rr; yy++) for (var xx = ax - rr; xx <= ax + rr; xx++) {
        if (xx < 0 || yy < 0 || xx >= N || yy >= N) continue;
        for (var j = this.cellHead[yy * N + xx]; j !== -1; j = this.nextIn[j]) {
          if (j <= i) continue;
          var b = ag[j]; if (!b.alive || b.air || b.fly || b.jet) continue;
          var rb = b.rad, D = ra + rb;
          // техника с техникой — теснее (могут частично наезжать); застрявшая в пробке — на 2 с «призрак»
          if (a.size === 2 && b.size === 2) { D *= a.ghostT > this.t || b.ghostT > this.t ? 0.4 : 0.8; }
          var dx = b.x - a.x, dy = b.y - a.y, d2 = dx * dx + dy * dy;
          if (d2 >= D * D) continue;
          if (d2 < 1e-6) { var ja = ((i * 7919 + j * 104729) % 360) * Math.PI / 180; dx = Math.cos(ja) * 0.01; dy = Math.sin(ja) * 0.01; d2 = 1e-4; }   // точно друг на друге — развести
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
    if (si >= 0 && this.structs[si].enter && !this.structs[si].dead && this.structs[si].team === a.team && !a.wh) a.inside = si;
  };

  // ---- стрельба
  Ground.prototype.hurt = function(b, d, by, melee) {
    b.hitT = this.t; if (by != null) b.hitBy = by;
    if (!b.alive) return;
    if (b.wh && !melee && (d = this.shield(b, d, by)) <= 0) return;      // клинок щит не держит
    if (b.barrier > this.t) d *= 0.7;
    if (b.hero && b.hero.passive.absorb) d *= 1 - b.hero.passive.absorb / 100;
    b.hp -= d;
    if (b.hp <= 0) { b.hp = 0; b.alive = false; b.diedAt = this.t; b.mv = 0; this.ev.deaths.push({ t: this.t, id: b.id, by: by }); if (b.sq) { var sq = this.squadOf(b.team, b.sq); if (sq) sq.members = sq.members.filter(function(x) { return x !== b.id; }); } }
  };
  // ---- Колесо Смерти
  // щит поднят: раскрыт, не пробит
  Ground.prototype.shieldUp = function(b) { var w = b.wh; return !!w && w.k >= 1 && w.sh > 0 && this.t >= w.down; };
  // держит ли щит удар от by (боец, 100000+ — постройка, −1 — снаряд без стрелка)
  Ground.prototype.shieldBlocks = function(b, by) {
    if (by == null || by < 0) return false;
    if (by >= 100000) return true;
    var a = this.agents[by]; if (!a) return false;
    if (a.hero || a.T.artillery) return false;
    if (a.T.vehicle && !a.air && !a.fly) { var dx = a.x - b.x, dy = a.y - b.y; if (dx * dx + dy * dy <= WHEEL.point * WHEEL.point) return false; }
    return true;
  };
  // урон после щита; что щит принял — снимается с числа на выстреле. Тяжёлые выстрелы техники
  // и авиации садят щит вдвое быстрее
  Ground.prototype.shield = function(b, d, by) {
    var w = b.wh;
    if (!this.shieldUp(b) || !this.shieldBlocks(b, by)) return d;
    var at = by < 100000 ? this.agents[by] : null, drain = at && at.T.vehicle ? WHEEL.heavy : 1;
    var take = Math.min(w.sh / drain, d), left = d - take;
    w.sh = Math.max(0, w.sh - take * drain); w.hitT = this.t;
    var sh = this.ev.shots;
    for (var i = sh.length - 1; i >= 0 && i >= sh.length - 4; i--) if (sh[i].ti === b.id && sh[i].t === this.t) { sh[i].d = Math.round(left); sh[i].sh = 1; break; }
    if (w.sh <= 0) { w.sh = 0; w.down = this.t + WHEEL.down; this.ev.fx.push({ t: this.t, k: 'shieldoff', x: b.x, y: b.y, id: b.id }); }
    else if (this.t - w.fxT > 0.25) { w.fxT = this.t; this.ev.fx.push({ t: this.t, k: 'shield', x: b.x, y: b.y, id: b.id }); }
    return left;
  };
  // после решения хода: стоит — раскрывается (если рядом бой), хочет ехать — сначала сворачивается;
  // щит восстанавливается только у раскрытого
  Ground.prototype.wheelStep = function(a, dt) {
    var w = a.wh, t = this.t, go = a.dvx !== 0 || a.dvy !== 0;
    if (go) {
      if (w.k > 0) { w.k = Math.max(0, w.k - dt / WHEEL.fold); a.dvx = 0; a.dvy = 0; a.mv += (0 - a.mv) * Math.min(1, dt * 8); }
    } else if (w.k < 1) {
      var fight = a.tgt >= 0 || a.focus >= 0 || t - (a.engT || -99) < 4 || t - (a.hitT || -99) < 4 || a.hold || (a.dpost && a.at);   // на посту обороны — сразу раскрыт
      if (fight || w.k > 0) w.k = Math.min(1, w.k + dt / WHEEL.open);
    }
    if (w.k >= 1 && t >= w.down && w.sh < w.shMax && t - w.hitT > WHEEL.calm) w.sh = Math.min(w.shMax, w.sh + WHEEL.regen * dt);
  };
  Ground.prototype.hurtStruct = function(s, d) {
    if (s.dead) return;
    s.hp -= d;
    if (s.hp <= 0) { s.hp = 0; s.dead = true; this.ev.booms.push({ t: this.t, x: s.x + s.w / 2, y: s.y + s.h / 2, r: s.w + 0.5 }); this.msg(s.kind === 'gate' ? 'Ворота выбиты' : s.name + ' уничтожен' + (/[аяь]$/.test(s.name) ? 'а' : ''), s.team, 'bad'); }
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
      if (a.wh && a.wh.k < 1) continue;            // Колесо Смерти катится или раскрывается — не стреляет
      var tg = this.tgtPos(a); if (!tg) { a.tgt = -1; continue; }
      var range = tg.a ? this.rangeTo(a, tg.a) : a.range;
      if (tg.d > range) continue;
      if (a.T.artillery) { this.artillery(a, tg); continue; }
      var aimA = a.T.vehicle && a.size === 2 ? a.turretA : a.aim;
      if (Math.abs(((Math.atan2(tg.y - a.y, tg.x - a.x) - aimA + 9.42) % 6.283) - 3.14) > 0.5) continue;
      var supp = a.suppT > this.t;                 // под заградительным огнём: залёг
      a.cd = a.T.rof * (0.85 + this.R() * 0.3) * (a.rofK || 1) * (supp ? 1.5 : 1);
      if (a.sk && tg.a && this.skill(a, tg)) { a.revealT = this.t; continue; }
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
      var p = U.hitChance(this.statsOf(a), this.statsOf(b), tg.d / RANGE_K, this.cover(a.x, a.y, b)) * (moving ? 0.7 : 1) * (a.hero && a.hero.passive.acc ? 1 + a.hero.passive.acc / 100 : 1) * (supp ? 0.5 : 1) * (a.netT > this.t ? HUNT.net.acc : 1);
      if (b.hero && b.hero.passive.evasion) p *= 1 - b.hero.passive.evasion / 100;
      // охотники бара: по одарённым больнее; дробовик — в упор сильнее, вдали слабее; мандалорец — два болта
      var hk = (b.hero && a.T.hunter ? HUNT.hero : 1) * (a.T.mando ? HUNT.twin : 1);
      if (a.T.netter) { var sr = Math.max(1, this.rangeTo(a, b)), sf = clamp((tg.d - 1) / Math.max(1, sr - 1), 0, 1); hk *= HUNT.scatter.near + (HUNT.scatter.far - HUNT.scatter.near) * sf; }
      for (var vv = 0, nv = a.wh || a.T.mando ? 2 : 1; vv < nv && b.alive; vv++) {     // Колесо Смерти и мандалорец — спаренные бластеры
        hit = this.R() < p;
        // джедай отражает выстрелы: часть попаданий уходит обратно (в сети — не отражает; дробь — вдвое реже)
        if (hit && b.hero && b.hero.passive.deflect && b.hero.act !== 'slash' && !(b.netT > this.t) && this.R() < b.hero.passive.deflect / 100 * (a.T.netter ? HUNT.scatter.deflect : 1)) { hit = false; this.ev.fx.push({ t: this.t, k: 'deflect', x: b.x, y: b.y, id: b.id }); b.hero.act = 'deflect'; b.hero.actT = 0.35; }
        dmg = hit ? U.damage(a.T, b.T, inMul) * a.dmgK * hk * (0.8 + this.R() * 0.4) : 0;
        this.shot(a, tg, hit, dmg, b.id);
        if (nv > 1) { var q2 = this.ev.shots[this.ev.shots.length - 1], ox = -Math.sin(a.aim) * (vv ? 0.16 : -0.16), oy = Math.cos(a.aim) * (vv ? 0.16 : -0.16); q2.x0 += ox; q2.y0 += oy; q2.x1 += ox; q2.y1 += oy; }
        a.revealT = this.t;
        if (hit) {
          this.hurt(b, dmg, a.id);
          if (!b.alive) a.tgt = -1;
          // окоп: сразу отвечает огнём
          if (b.alive && b.inside >= 0 && this.structs[b.inside].kind === 'trench' && b.cd > 0.3) b.cd = 0.3;
          // гранатомёт и ракеты: задевает рядом
          var splash = /launcher/.test(a.tid) ? 1.6 : a.tid === 'cis_missile' ? 2 : 0;
          if (splash) { this.splash(tg.x, tg.y, splash, dmg * 0.5, a); this.ev.booms.push({ t: this.t, x: tg.x, y: tg.y, r: splash * 0.8 }); }
          // картечь: сосед цели тоже ловит дробь
          if (a.T.netter && this.R() < HUNT.scatter.chance) {
            var pb = this.secondFoe(this.ctl(a), b, HUNT.scatter.pellet);
            if (pb) { var pd = U.damage(a.T, pb.T, inMul) * a.dmgK * HUNT.scatter.part * (pb.hero ? HUNT.hero : 1); this.shot(a, { x: pb.x, y: pb.y, a: pb }, true, pd, pb.id); this.hurt(pb, pd, a.id); }
          }
        }
      }
    }
  };
  // ---- способности бойцов (исследования)
  Ground.prototype.skill = function(a, tg) {
    var b = tg.a, t = this.t, team = this.ctl(a);
    for (var i = 0; i < a.sk.length; i++) {
      var s = a.sk[i], S = SKILL[s.k], ok = false; if (t < s.ready) continue;
      if (s.k === 'grenade' || s.k === 'he' || s.k === 'suppression') {
        // по скоплению: в области хотя бы двое врагов (или цель в окопе, бункере)
        var r = Math.max(1.6, (s.v || 2) * RANGE_K * 0.55);
        if (s.k === 'grenade' && tg.d > Math.min(a.range, 4 * RANGE_K)) continue;
        var nf = this.foesAt(team, tg.x, tg.y, r, s.k === 'he');
        if (nf < 2 && !(b.inside >= 0)) continue;
        // область бьёт и своих (решение Артёма): себе под ноги не бросает, а своих в области должно быть
        // меньше, чем врагов (по одиночке в окопе — ни одного своего рядом)
        if (s.k !== 'suppression' && tg.d < r + 0.5) continue;
        if (this.alliesAt(team, tg.x, tg.y, r, s.k === 'he', a) >= Math.max(1, nf)) continue;
        var dm = (s.dmg || S.dmg) * a.dmgK;
        if (s.k === 'grenade') this.ev.shells.push({ t0: t, t1: t + 0.8, x0: a.x, y0: a.y, x1: tg.x, y1: tg.y, team: team, r: r, dmg: dm, by: a.id, foe: true });
        else { this.shot(a, tg, true, 0, b.id); this.blast(team, a.id, tg.x, tg.y, r, dm, s.k === 'he', s.k === 'suppression'); }
        ok = true;
      } else if (s.k === 'stun') {
        // верное оглушение (100 %) — разряд без урона; с шансом — обычный верный выстрел, который может оглушить
        if (b.stun > 0 || b.hero) continue;
        var sv = s.v || 10, sd = sv < 100 ? U.damage(a.T, b.T, a.inside >= 0 ? this.structs[a.inside].inMul : 1) * a.dmgK * (0.8 + this.R() * 0.4) : 0;
        this.shot(a, tg, true, sd, b.id);
        if (sd) this.hurt(b, sd, a.id);
        if (b.alive && this.R() * 100 < sv) { b.stun = Math.max(b.stun, STUN_T); b.tgt = -1; }
        ok = true;
      } else if (s.k === 'headshot') {
        if (b.T.vehicle) continue;
        var hd = b.hero ? b.hpMax * 0.25 : b.hp + 1;          // одарённый устоит
        this.shot(a, tg, true, hd, b.id); this.hurt(b, hd, a.id); ok = true;
      } else if (s.k === 'ap') {
        if (!b.T.vehicle) continue;
        var ad = U.damage(a.T, b.T) * a.dmgK * 2;
        this.shot(a, tg, true, ad, b.id); this.hurt(b, ad, a.id); ok = true;
      } else if (s.k === 'twin') {
        var c2 = this.secondFoe(team, b, 3 * RANGE_K); if (!c2) continue;
        var d1 = U.damage(a.T, b.T) * a.dmgK; this.shot(a, tg, true, d1, b.id); this.hurt(b, d1, a.id);
        if (this.R() * 100 < (s.v || 50)) { var d2 = U.damage(a.T, c2.T) * a.dmgK; this.shot(a, { x: c2.x, y: c2.y, a: c2 }, true, d2, c2.id); this.hurt(c2, d2, a.id); }
        ok = true;
      } else if (s.k === 'lunge') {
        if (b.air || tg.d > (s.v || 3) * RANGE_K || tg.d < 1.5) continue;
        var lx = b.x - a.x, ly = b.y - a.y, ll = Math.sqrt(lx * lx + ly * ly) || 1, land = this.nearestOk(a.move, a.size, Math.floor(b.x - lx / ll * 0.9), Math.floor(b.y - ly / ll * 0.9));
        if (!land) continue;
        a.x = land[0] + 0.5; a.y = land[1] + 0.5; a.vx = a.vy = 0;
        var ld = (s.dmg || S.dmg) * a.dmgK; if (b.hero) ld = Math.min(ld, b.hpMax * 0.3);
        this.ev.shots.push({ t: t, x0: a.x, y0: a.y, x1: b.x, y1: b.y, team: a.team, hit: true, w: 'saber', d: Math.round(ld), ti: b.id, from: a.id, melee: true });
        this.hurt(b, ld, a.id, true); ok = true;
      } else if (s.k === 'net') {
        // сетемёт: одарённый в дальности — первым; нет его рядом — любой пехотинец, что ещё не в сети
        var nt = this.netTarget(a, b, team); if (!nt) continue;
        this.ev.shells.push({ k: 'net', t0: t, t1: t + HUNT.net.fly, x0: a.x, y0: a.y, x1: nt.x, y1: nt.y, team: team, r: 0.7, tid: nt.id, by: a.id });
        a.aim = Math.atan2(nt.y - a.y, nt.x - a.x);
        ok = true;
      } else if (s.k === 'rocket') {
        // наручная ракета: по одарённому, по технике или по скоплению; своих в круге меньше, чем врагов
        var rr0 = HUNT.rocket.r, nf2 = this.foesAt(team, tg.x, tg.y, rr0, false);
        if (!b.hero && !b.T.vehicle && nf2 < 2 && !(b.inside >= 0)) continue;
        if (tg.d < rr0 + 0.5 || b.air) continue;
        if (this.alliesAt(team, tg.x, tg.y, rr0, false, a) >= Math.max(1, nf2)) continue;
        this.ev.shells.push({ k: 'rk', t0: t, t1: t + Math.max(0.2, tg.d / HUNT.rocket.spd), x0: a.x, y0: a.y, x1: tg.x, y1: tg.y, team: team, r: rr0, dmg: (s.dmg || S.dmg) * a.dmgK, by: a.id, foe: true });
        ok = true;
      }
      if (ok) {
        s.ready = t + S.cd * (0.9 + this.R() * 0.2);
        this.ev.fx.push({ t: t, k: 'skill', x: a.x, y: a.y, id: a.id, name: S.name, team: a.team });
        if (!b.alive) a.tgt = -1;
        return true;
      }
    }
    return false;
  };
  // Кого ловить сетью: одарённого в дальности сетемёта (видно, по прямой); иначе текущую цель-пехотинца.
  // Не в сети уже, не техника и не авиация, не в полёте на ранце
  Ground.prototype.netTarget = function(a, b, team) {
    var R2 = HUNT.net.range * RANGE_K, ag = this.agents, best = null, bd = R2 * R2;
    var ok = function(e) { return e && e.alive && !e.air && !e.fly && !e.T.vehicle && !e.jet && !(e.netT > 0 && e.netT > this.t - 0.5); }.bind(this);
    for (var i = 0; i < ag.length; i++) {
      var e = ag[i]; if (!e.hero || this.ctl(e) === team || !ok(e) || !this.canSee(team, e)) continue;
      var dx = e.x - a.x, dy = e.y - a.y, d = dx * dx + dy * dy; if (d >= bd || !this.los(a.x, a.y, e.x, e.y)) continue;
      bd = d; best = e;
    }
    if (best) return best;
    var dx2 = b.x - a.x, dy2 = b.y - a.y;
    return ok(b) && dx2 * dx2 + dy2 * dy2 <= R2 * R2 && (b.hero || b.T.cls === 'infantry') ? b : null;
  };
  Ground.prototype.medicStep = function(a, dt) {
    a.healT = (a.healT == null ? this.R() * MEDIC.every : a.healT) - dt;
    if (a.healT > 0) return;
    a.healT = MEDIC.every;
    if (a.left || a.stun > 0 || a.fear > 0 || a.choke >= 0 || a.netT > this.t || a.mind && a.mind.until > this.t) return;
    var ag = this.agents, team = this.ctl(a), best = null, bk = 1, r2 = MEDIC.r * MEDIC.r;
    for (var i = 0; i < ag.length; i++) {
      var b = ag[i]; if (b === a || !b.alive || b.left || b.T.vehicle || b.hp >= b.hpMax || this.ctl(b) !== team) continue;
      var dx = b.x - a.x, dy = b.y - a.y; if (dx * dx + dy * dy > r2) continue;
      var k = b.hp / b.hpMax; if (k < bk) { bk = k; best = b; }
    }
    if (!best) return;
    best.hp = Math.min(best.hpMax, best.hp + MEDIC.hp);
    this.ev.fx.push({ t: this.t, k: 'healed', x: best.x, y: best.y, id: best.id });
  };
  // своих команды team (пехоты — inf) в круге, кроме самого бойца me
  Ground.prototype.alliesAt = function(team, x, y, r, inf, me) {
    var n = 0, ag = this.agents;
    for (var i = 0; i < ag.length; i++) {
      var e = ag[i]; if (e === me || !e.alive || e.air || this.ctl(e) !== team || (inf && e.T.vehicle)) continue;
      var dx = e.x - x, dy = e.y - y; if (dx * dx + dy * dy < r * r) n++;
    }
    return n;
  };
  // врагов команды team (пехоты — inf) в круге
  Ground.prototype.foesAt = function(team, x, y, r, inf) {
    var n = 0, ag = this.agents;
    for (var i = 0; i < ag.length; i++) {
      var e = ag[i]; if (!e.alive || e.air || this.ctl(e) === team || (inf && e.T.vehicle)) continue;
      var dx = e.x - x, dy = e.y - y; if (dx * dx + dy * dy < r * r) n++;
    }
    return n;
  };
  // вторая цель спаренного выстрела: живой враг рядом с первой
  Ground.prototype.secondFoe = function(team, b, r) {
    var best = null, bd = r * r, ag = this.agents;
    for (var i = 0; i < ag.length; i++) {
      var e = ag[i]; if (e === b || !e.alive || e.air || this.ctl(e) === team || !this.canSee(team, e)) continue;
      var dx = e.x - b.x, dy = e.y - b.y, d = dx * dx + dy * dy; if (d < bd) { bd = d; best = e; }
    }
    return best;
  };
  // взрыв способности: бьёт всех в круге — и своих (решение Артёма), кроме самого стрелка; inf — фугас не
  // берёт технику; supp — заградительный огонь: кто уцелел, тот залёг. Свои ранены «без стрелка» (by −1):
  // гибель своего не засчитывается бойцу, а раненый не ищет стрелка среди своих
  Ground.prototype.blast = function(team, by, x, y, r, dmg, inf, supp) {
    var ag = this.agents;
    for (var j = 0; j < ag.length; j++) {
      var e = ag[j]; if (!e.alive || e.air || e.id === by || (inf && e.T.vehicle)) continue;
      var dx = e.x - x, dy = e.y - y, d2 = dx * dx + dy * dy; if (d2 >= r * r) continue;
      this.hurt(e, dmg * (1 - Math.sqrt(d2) / r * 0.4) * (e.hero ? 0.5 : 1), this.ctl(e) === team ? -1 : by);
      if (supp && e.alive) e.suppT = this.t + SUPP_T;
    }
    this.ev.booms.push({ t: this.t, x: x, y: y, r: r * 0.6 });
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
      if (s.k === 'net') { this.netLand(s); sh.splice(i, 1); continue; }
      if (s.foe) { this.blast(s.team, s.by, s.x1, s.y1, s.r, s.dmg, false, false); sh.splice(i, 1); continue; }   // граната, ракета бойца
      this.splash(s.x1, s.y1, s.r, s.dmg, by && by.alive ? by : null);
      this.ev.booms.push({ t: this.t, x: s.x1, y: s.y1, r: s.r, big: true });
      sh.splice(i, 1);
    }
  };
  // Сеть долетела: цель ещё там (не дальше r от точки), не взлетела на ранце — держит; иначе мимо
  Ground.prototype.netLand = function(s) {
    var b = this.agents[s.tid];
    if (!b || !b.alive || b.jet || b.air || b.fly) return;
    var dx = b.x - s.x1, dy = b.y - s.y1;
    if (dx * dx + dy * dy > (s.r + 0.5) * (s.r + 0.5)) { this.ev.fx.push({ t: this.t, k: 'netmiss', x: s.x1, y: s.y1 }); return; }
    var dur = b.hero ? HUNT.net.hero : HUNT.net.other;
    b.netT = Math.max(b.netT || 0, this.t + dur);
    b.vx = b.vy = b.dvx = b.dvy = 0;
    if (b.hero) { b.hero.pend = null; if (b.hero.act === 'dash' || b.hero.act === 'run') { b.hero.act = 'idle'; b.hero.actT = 0; } }
    this.ev.fx.push({ t: this.t, k: 'net', x: b.x, y: b.y, id: b.id, until: b.netT });
    if (b.hero) { this.msg((b.name || 'Одарённый') + ' в сети', this.ctl(b), 'bad'); this.msg('Одарённый пойман сетью', s.team, 'gold'); }
  };
  // Мины: враг на мине — взрыв. Урон по классу цели (U.DM.mine), к краю вдвое меньше; задевает всех рядом,
  // и своих тоже. Хозяевам — «сработала», пострадавшим — «подрыв на мине».
  Ground.prototype.minesStep = function() {
    var M = U.MINE, ag = this.agents;
    for (var i = 0; i < this.structs.length; i++) {
      var s = this.structs[i]; if (s.dead || s.kind !== 'landmine') continue;
      var cx = s.x + s.w / 2, cy = s.y + s.h / 2, hit = null;
      for (var j = 0; j < ag.length; j++) {
        var b = ag[j]; if (!b.alive || b.air || b.fly || this.ctl(b) === s.team) continue;
        var dx = b.x - cx, dy = b.y - cy, tr = M.trig + (b.size === 2 ? M.trig2 : 0);
        if (dx * dx + dy * dy < tr * tr) { hit = b; break; }
      }
      if (!hit) continue;
      s.hp = 0; s.dead = true;
      this.ev.booms.push({ t: this.t, x: cx, y: cy, r: M.r, big: true });
      var victims = {};
      for (j = 0; j < ag.length; j++) {
        var v = ag[j]; if (!v.alive || v.air || v.fly) continue;
        var vx = v.x - cx, vy = v.y - cy, d2 = vx * vx + vy * vy; if (d2 >= M.r * M.r) continue;
        var k = U.mult('mine', v.T.cls); if (!k) continue;
        victims[v.team] = 1;
        this.hurt(v, s.dmg * k * (1 - Math.sqrt(d2) / M.r * 0.5), 100000 + i);
      }
      for (j = 0; j < this.structs.length; j++) {
        var o = this.structs[j]; if (o === s || o.dead) continue;
        var ox = Math.max(o.x, Math.min(cx, o.x + o.w)) - cx, oy = Math.max(o.y, Math.min(cy, o.y + o.h)) - cy;
        if (ox * ox + oy * oy < M.r * M.r) this.hurtStruct(o, s.dmg * U.mult('mine', 'structure'));
      }
      this.msg('Мина сработала' + (hit.T && hit.T.name ? ': ' + hit.T.name : ''), s.team, 'gold');
      for (var tm in victims) if (+tm !== s.team) this.msg('Подрыв на мине!', +tm, 'bad');
    }
  };
  // Полевые турели: сами стреляют по видимым врагам в радиусе
  Ground.prototype.structsStep = function(dt) {
    this.minesStep();
    for (var i = 0; i < this.structs.length; i++) {
      var s = this.structs[i]; if (s.dead || (s.kind !== 'turret' && s.kind !== 'tower')) continue;
      s.cd -= dt; if (s.cd > 0) continue;
      var cx = s.x + s.w / 2, cy = s.y + s.h / 2, r = s.radius * RANGE_K, best = null, bd = r * r;
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
    if (a.netT > this.t) return;                                // в сети: режет её, а не врага
    a.scan -= dt;
    if (a.scan <= 0) { a.scan = SCAN; a.tgt = this.findTarget(a); }
    a.cd -= dt;
    if (a.tgt < 0 || a.cd > 0) return;
    var tg = this.tgtPos(a); if (!tg || !tg.a || tg.d > SABER) return;
    a.cd = a.T.rof;
    this.heroAct(a, 'slash', SLASH, { tid: tg.a.id });
  };
  Ground.prototype.heroAct = function(a, act, dur, data) { var h = a.hero; if (a.sneak) a.revealT = this.t; h.act = act; h.actT = dur; h.actDur = dur; h.k = 0; h.data = data || null; a.mv = 0; this.ev.fx.push({ t: this.t, k: act, x: a.x, y: a.y, id: a.id, tid: data && data.tid, tx: data && data.x, ty: data && data.y }); };
  Ground.prototype.heroActEnd = function(a) {
    var h = a.hero, d = h.data || {}, b = d.tid != null ? this.agents[d.tid] : null, act = h.act;
    h.act = 'idle'; h.k = 0;
    var dmgK = a.dmgK * (1 + (h.passive.damage || 0) / 100);
    if (act === 'slash' && b && b.alive) {
      var dx = b.x - a.x, dy = b.y - a.y;
      if (dx * dx + dy * dy <= (SABER + 0.4) * (SABER + 0.4)) {
        // меткость героя и уклонение цели — с пассивами (Форма боя, тренировки) и исследованиями
        var p = U.hitChance(this.statsOf(a), this.statsOf(b), 0, 1) * (1 + (h.passive.acc || 0) / 100), hit = this.R() < p;
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
        if (this.R() < 0.5 && !f.T.hunter) f.stun = Math.max(f.stun, 2);
      }
    } else if (act === 'choke' && b && b.alive) {
      var cdm = (d.power || 90) * dmgK;
      this.hurt(b, cdm, a.id); b.choke = -1;
      if (d.drain) a.hp = Math.min(a.hpMax, a.hp + cdm * 0.6);
    } else if (act === 'mind') {
      if (d.fear) { var ag4 = this.agents; for (var r = 0; r < ag4.length; r++) { var g = ag4[r]; if (!g.alive || g.hero || g.T.vehicle || g.T.hunter || this.ctl(g) === a.team) continue; var gx = g.x - a.x, gy = g.y - a.y; if (gx * gx + gy * gy <= 9 * RANGE_K * RANGE_K) { g.fear = 6; g.tgt = -1; } } }
      else if (b && b.alive && !b.hero && !b.T.hunter) {
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
  // Применить способность героя: tgt = { tid } | { x, y } | null.
  // approach — приказ игрока: цель далеко — герой сам подойдёт и применит (ИИ ботов зовёт без него и получает «далеко»)
  Ground.prototype.useAbility = function(team, id, abilId, tgt, approach) {
    var a = this.agents[id], A = ABIL[abilId];
    if (!a || !a.alive || !a.hero || !A || !A[0] || !this.mine(team, a)) return 'нет';
    var h = a.hero;
    if (h.abil.indexOf(abilId) < 0) return 'не изучено';
    if ((h.cds[abilId] || 0) > this.t) return 'откат ' + Math.ceil(h.cds[abilId] - this.t) + ' с';
    if (h.actT > 0) return 'занят';
    if (a.netT > this.t) return 'в сети';
    h.pend = null;                                              // новая способность заменяет ожидающую
    var rng = A[2] * RANGE_K, b = tgt && tgt.tid != null ? this.agents[tgt.tid] : null, data = { power: A[4] };
    if (A[1] === 'enemy' || A[1] === 'ally') {
      if (!b || !b.alive) return 'нет цели';
      if (A[1] === 'enemy' && this.ctl(b) === team) return 'это свой';
      if (A[1] === 'ally' && b.team !== team) return 'это враг';
      if (A[0] === 'mind' && b.T.hunter) return 'охотника внушение не берёт';
      var dx = b.x - a.x, dy = b.y - a.y, d = Math.sqrt(dx * dx + dy * dy);
      // далеко — герой сам подходит на дальность и применяет (pendStep); новый приказ игрока отменяет
      if (d > rng + 0.5) return approach ? this.pendStart(team, a, abilId, b) : 'далеко';
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

  // Способность «на подходе»: герой идёт к цели (врага — преследует, к союзнику — идёт следом) и, как только
  // цель в дальности, применяет. Отменяют: новый приказ игрока, гибель или уход цели из вида, PEND_T секунд.
  Ground.prototype.pendStart = function(team, a, abilId, b) {
    var h = a.hero, A = ABIL[abilId];
    if (A[1] === 'enemy' && !this.canSee(team, b)) return 'цель не видна';
    this.microEnd(a, true);
    a.hold = false; a.auto = false; a.dpost = null; a.sortie = false;
    if (A[1] === 'enemy') { a.focus = b.id; a.post = false; a.goal = null; a.at = true; }
    else { a.focus = -1; this.pendFollow(a, b); }
    h.pend = { ab: abilId, tid: b.id, team: team, until: this.t + PEND_T };
    this.msg((ABIL_NAME[abilId] || abilId) + ': подхожу на дальность', team, '');
    return '';
  };
  Ground.prototype.pendFollow = function(a, b) {
    var c = [Math.floor(b.x), Math.floor(b.y)], g = a.goal;
    if (g && !a.at && Math.abs(g[0] - c[0]) + Math.abs(g[1] - c[1]) <= 1) return;
    var spot = this.spotNear(a, c[0], c[1], {}); if (!spot) return;
    this.goCell(a, spot[0], spot[1]); a.post = true;
  };
  Ground.prototype.pendStep = function(a) {
    var h = a.hero, p = h.pend, A = ABIL[p.ab], b = this.agents[p.tid], name = ABIL_NAME[p.ab] || p.ab;
    // отказ: герой останавливается там, где шёл (дальше сам решит, драться ли), и игроку — почему
    var drop = function(self, why) { h.pend = null; if (a.focus === p.tid) a.focus = -1; a.goal = null; a.at = true; a.post = false; if (why) self.msg(name + ': ' + why, p.team, 'bad'); };
    if (!this.mine(p.team, a)) { h.pend = null; return; }
    if (!b || !b.alive || b.gone) return drop(this, 'цели больше нет');
    if (A[1] === 'enemy' && (this.ctl(b) === p.team || !this.canSee(p.team, b))) return drop(this, 'цель потеряна');
    if (A[1] === 'ally' && b.team !== p.team) return drop(this, 'цель потеряна');
    if (this.t > p.until) return drop(this, 'не дошёл до цели');
    if (h.actT > 0 || a.stun > 0 || a.netT > this.t) return;   // ударом, оглушением или сетью занят — дождаться
    var dx = b.x - a.x, dy = b.y - a.y, rng = A[2] * RANGE_K;
    if (dx * dx + dy * dy <= (rng + 0.5) * (rng + 0.5)) {
      h.pend = null;
      if (A[1] === 'ally') { var c = this.cellOf(a); a.goal = [c[0], c[1]]; a.at = true; a.post = false; }
      var err = this.useAbility(p.team, a.id, p.ab, { tid: b.id });
      if (err) this.msg(name + ': ' + err, p.team, 'bad');
      return;
    }
    if (A[1] === 'enemy') { if (a.focus !== b.id) a.focus = b.id; }
    else this.pendFollow(a, b);
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
    var foot = [], veh = [], near = [], pf = this.pass.foot1, pt = this.pass.track2, ph = this.pass.hover2, wr = this.settle.wall;
    var fx1 = Math.round(f[0]), fy1 = Math.round(f[1]);
    for (var y = 2; y < N - 2; y++) for (var x = 2; x < N - 2; x++) {
      var c = y * N + x, dx = x + 0.5 - sqx, dy = y + 0.5 - sqy, d = Math.max(Math.abs(dx), Math.abs(dy)), dl = Math.sqrt(dx * dx + dy * dy) || 1, dot = (dx * f[0] + dy * f[1]) / dl;
      // за стеной — только внутри неё; пост у стены со стороны врага ценится (парапет — укрытие)
      if (wr && !(x > wr[0] && x < wr[0] + wr[2] - 1 && y > wr[1] && y < wr[1] + wr[3] - 1)) continue;
      var si = this.structAt[c], st = si >= 0 ? this.structs[si] : null;
      if (st && (!st.enter || st.team !== team || st.kind === 'gate')) continue;
      var front = m.t[(y + fy1) * N + x + fx1] === T.COVER ? 2.5 : 0;
      if (pf[c] && d >= DEF_NEAR && d <= DEF_FAR && dot > -0.15) foot.push([this.coverC[c] * 3 + m.e[c] * 1.2 + (st ? 4 : 0) + front + dot * 1.5 - d * 0.08 + R() * 0.3, x, y]);
      if (!st && (pt[c] || ph[c]) && d >= DEF_NEAR - 2 && d <= DEF_FAR - 6 && dot > -0.3) veh.push([m.e[c] * 0.8 + dot * 1.2 - d * 0.1 + R() * 0.3, x, y, pt[c], ph[c]]);
      if (!st && pf[c] && d >= 2 && d <= DEF_NEAR + 2) near.push([-d + R() * 0.5, x, y]);
    }
    function pick(list, lim, margin, taken) {
      list.sort(function(a, b) { return b[0] - a[0]; });
      var out = []; taken = taken || {};
      for (var i = 0; i < list.length && out.length < lim; i++) {
        var p = list[i], c = p[2] * N + p[1]; if (taken[c]) continue;
        out.push({ x: p[1], y: p[2], by: -1, track: p[3], hover: p[4] });
        for (var yy = p[2] - margin; yy <= p[2] + margin; yy++) for (var xx = p[1] - margin; xx <= p[1] + margin; xx++) taken[yy * N + xx] = 1;
      }
      return out;
    }
    // сначала техника (с запасом под её радиус), пехоте и ближним постам эти клетки не достаются
    var vp = pick(veh, 50, 3), used = {};
    vp.forEach(function(p) { for (var yy = p.y - 2; yy <= p.y + 3; yy++) for (var xx = p.x - 2; xx <= p.x + 3; xx++) used[yy * N + xx] = 1; });
    var fp = pick(foot, 220, 1, used), np = pick(near, 60, 1, used);
    return (this._posts = { team: team, foot: fp, veh: vp, near: np });
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
      var list = a.size === 2 ? posts.veh : (a.T.cls === 'aa' || a.air || a.fly || a.T.medic || a.T.builder ? posts.near : posts.foot);
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
      var x = Math.round(sqx + f[0] * (DEF_FAR + 16) - f[1] * k * 22), y = Math.round(sqy + f[1] * (DEF_FAR + 16) + f[0] * k * 22), best = null, bs = -1;
      var reach = this.flows.get('foot', 1, Math.floor(sqx), Math.floor(sqy)).dir;      // откуда вообще дойти до площади
      for (var dy = -8; dy <= 8; dy += 2) for (var dx = -8; dx <= 8; dx += 2) {
        var cx = clamp(x + dx, 6, N - 7), cy = clamp(y + dy, 6, N - 7), sc = 0;
        if (!pf[cy * N + cx] || reach[cy * N + cx] === 255) continue;
        for (var yy = cy - 5; yy <= cy + 5; yy++) for (var xx = cx - 5; xx <= cx + 5; xx++) sc += pf[yy * N + xx] + (k === 0 ? pt[yy * N + xx] : (this.coverC[yy * N + xx] < 1 ? 0.5 : 0));
        sc -= (Math.abs(dx) + Math.abs(dy)) * 0.5;
        if (sc > bs) { bs = sc; best = [cx, cy]; }
      }
      out.push(best || [clamp(x, 6, N - 7), clamp(y, 6, N - 7)]);
    }
    return (this._lanes = out);
  };
  Ground.prototype.ai = function() {
    var ag = this.agents, sqx = this.sx + SQUARE / 2, sqy = this.sy + SQUARE / 2, self = this;
    if (this.noTown) { if (this.onAI) this.onAI(); return; }      // ивент: ботов ведёт сценарий
    for (var tm = 0; tm < 2; tm++) {
      var teamAuto = this.teams[tm].auto, ids = [];
      for (var i = 0; i < ag.length; i++) { var a = ag[i]; if (!a.alive || this.ctl(a) !== tm || (a.T.artillery && tm !== this.att)) continue; if (!teamAuto && !a.auto && !a.npc) continue; if (a.mind && a.mind.until > this.t) continue; ids.push(i); }
      if (!ids.length) continue;
      if (tm === this.att) this.aiAttack(tm, ids); else this.aiDefend(tm, ids);
    }
    this.aiRaid();
  };
  Ground.prototype.aiAttack = function(tm, ids) {
    var ag = this.agents, sqx = this.sx + SQUARE / 2, sqy = this.sy + SQUARE / 2, L = this.lanes(), groups = [[], [], []], toSq = [];
    // сбор на рубеже: колонны идут дальше вместе, когда собралось больше половины всего десанта (или кто-то уже пошёл)
    var tot = [0, 0, 0], here = [0, 0, 0], gone = [0, 0, 0], i, a;
    for (i = 0; i < ids.length; i++) {
      a = ag[ids[i]];
      if (a.lane < 0) a.lane = a.T.vehicle || a.air || a.fly ? 1 : a.id % 3;
      if (a.part) { a.ph = 1; continue; }        // подполье встаёт у самой площади: к рубежу не ходит и сбор колонн не торопит
      tot[a.lane]++;
      if (a.ph === 1) gone[a.lane]++;
      else { var lp = L[a.lane]; if (Math.abs(a.x - lp[0]) < 8 && Math.abs(a.y - lp[1]) < 8) { a.ph = 0.5; here[a.lane]++; } }
    }
    var onlyArt = ids.every(function(id) { return ag[id].T.artillery; });
    for (i = 0; i < ids.length; i++) {
      a = ag[ids[i]];
      if (onlyArt) { a.ph = 1; }
      if (a.ph === 0.5 && !a.part && !a.T.artillery && (here[0] + here[1] + here[2] + gone[0] + gone[1] + gone[2] >= (tot[0] + tot[1] + tot[2]) * 0.6 || gone[0] + gone[1] + gone[2] > 0)) { a.ph = 1; a.at = true; }
      if (a.tgt >= 0 || (a.goal && !a.at) || (a.T.artillery && a.ph > 0 && !onlyArt)) continue;
      if (a.ph < 1) groups[a.lane].push(a.id); else toSq.push(a.id);
    }
    for (var k = 0; k < 3; k++) if (groups[k].length) this.orderMove(tm, groups[k], L[k][0], L[k][1], { auto: true });
    // на площадь — каждая колонна со своей стороны (фланги заходят с боков)
    var f = this.threatDir(), byLane = [[], [], []];
    toSq.forEach(function(id) { byLane[ag[id].lane].push(id); });
    for (k = 0; k < 3; k++) if (byLane[k].length) {
      var kk = k - 1, tx = clamp(Math.round(sqx - f[1] * kk * 7), 2, N - 3), ty = clamp(Math.round(sqy + f[0] * kk * 7), 2, N - 3);
      this.orderMove(tm, byLane[k], tx, ty, { auto: true });
    }
  };
  Ground.prototype.aiDefend = function(tm, ids) {
    var ag = this.agents, sqx = this.sx + SQUARE / 2, sqy = this.sy + SQUARE / 2, posts = this.defPosts(tm);
    // прорвавшиеся: видимые враги в ядре города
    var intr = [];
    for (var j = 0; j < ag.length; j++) { var b = ag[j]; if (!b.alive || this.ctl(b) === tm || b.air || !this.canSee(tm, b)) continue; if (Math.max(Math.abs(b.x - sqx), Math.abs(b.y - sqy)) <= SQUARE / 2 + 6) intr.push(b); }
    for (var i = 0; i < ids.length; i++) {
      var a = ag[ids[i]];
      if (!a.dpost) {
        var list = a.size === 2 ? posts.veh : (a.T.cls === 'aa' || a.air || a.fly || a.T.medic || a.T.builder ? posts.near : posts.foot);
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
      } else if (intr.length && a.tgt < 0 && !(a.air || a.fly)) {
        var best = null, bd = SORTIE * SORTIE;
        for (var q = 0; q < intr.length; q++) { var dx = intr[q].x - a.x, dy = intr[q].y - a.y, d = dx * dx + dy * dy; if (d < bd) { bd = d; best = intr[q]; } }
        if (best) { if (!a.sortie || a.at) { a.sortie = true; a.hold = false; this.goCell(a, Math.floor(best.x), Math.floor(best.y), this.qkey(a, Math.floor(best.x), Math.floor(best.y))); } continue; }
      }
      if (a.sortie && a.tgt < 0 && (a.at || !a.goal)) { a.sortie = false; this.goCell(a, a.dpost.x, a.dpost.y, this.qkey(a, a.dpost.x, a.dpost.y)); continue; }
      if (!a.sortie && a.at && !a.hold) { var c = this.cellOf(a); a.goal = [c[0], c[1]]; a.hold = true; }
    }
  };
  // ---- мародёры
  Ground.prototype.aiRaid = function() {
    var ag = this.agents, ids = [], foes = [], i;
    for (i = 0; i < ag.length; i++) { var a = ag[i]; if (a.alive && !a.gone && a.team === 2 && a.npc && this.ctl(a) === 2) ids.push(i); }
    if (!ids.length) return;
    // кого банда знает: видит кто-то из своих (общий обзор банды)
    for (i = 0; i < ag.length; i++) { var b = ag[i]; if (b.alive && !b.gone && this.ctl(b) !== 2 && !b.air && this.canSee(2, b)) foes.push(b); }
    var taken = {};
    for (i = 0; i < ids.length; i++) this.raider(ag[ids[i]], foes, ids, taken);
  };
  Ground.prototype.raider = function(a, foes, ids, taken) {
    var ag = this.agents, home = a.home || (a.home = [Math.floor(a.x), Math.floor(a.y)]), self = this, i;
    var hd = function(x, y) { return Math.max(Math.abs(x - home[0]), Math.abs(y - home[1])); };
    var go = function(c, run) { if (!c) return false; if (!a.goal || a.at || a.goal[0] !== c[0] || a.goal[1] !== c[1]) self.goCell(a, c[0], c[1]); a.post = !!run; a.hold = false; a.focus = -1; return true; };
    if (a.leave) { this.raidLeave(a); return; }
    var low = a.hp <= a.hpMax * RAID.low, aggro = this.t - (a.hitT == null ? -99 : a.hitT) < 60;
    var near = null, nd = 1e9;
    for (i = 0; i < foes.length; i++) { var f = foes[i], dx = f.x - a.x, dy = f.y - a.y, d = Math.sqrt(dx * dx + dy * dy); if (d < nd) { nd = d; near = f; } }
    // ранен и враг рядом — отход подальше от врага, в сторону логова
    if (low && near && nd <= RAID.flee) {
      var c = this.away(a, near, RAID.flee + 4);
      if (c && hd(c[0], c[1]) <= RAID.hard) { go(c, true); return; }
      if (hd(Math.floor(a.x), Math.floor(a.y)) > 2 && go(this.freeNear(a, home[0], home[1], 3) || home.slice(), true)) return;
      return;                                           // загнан в угол — отстреливается
    }
    if (!low && near && nd <= RAID.hunt) {
      // без злости на толпу не лезем: враг достаёт — отходим из-под огня, иначе выжидаем
      if (!aggro) {
        var nf = 0, na = 1, reach = null;
        for (i = 0; i < foes.length; i++) { var g = foes[i], gd = Math.sqrt((g.x - a.x) * (g.x - a.x) + (g.y - a.y) * (g.y - a.y)); if (gd <= RAID.wary) nf++; if (gd <= g.range + 2 && !reach) reach = g; }
        for (i = 0; i < ids.length; i++) { var m = ag[ids[i]]; if (m !== a && Math.abs(m.x - a.x) <= RAID.pack && Math.abs(m.y - a.y) <= RAID.pack) na++; }
        if (nf > na + 1) {
          if (reach) { var w = this.away(a, reach, reach.range + 4); if (w && hd(w[0], w[1]) <= RAID.hard) { go(w, true); return; } }
          if (a.focus >= 0 || !a.at) { var hc = this.cellOf(a); a.goal = [hc[0], hc[1]]; a.at = true; a.focus = -1; a.post = false; }
          return;
        }
      }
      if (hd(Math.floor(near.x), Math.floor(near.y)) <= RAID.hard) {
        if (a.focus !== near.id) { a.focus = near.id; a.goal = null; a.at = true; a.post = false; a.hold = false; }
        return;
      }
    }
    if (a.focus >= 0) { a.focus = -1; a.at = true; a.goal = null; }
    // раненый без драки — к логову, там отлёживается
    if (low) { if (hd(Math.floor(a.x), Math.floor(a.y)) > 2) go(this.freeNear(a, home[0], home[1], 3) || home.slice(), false); return; }
    // грабёж: ближайшая чужая постройка в пределах поводка
    var lt = null, ld = RAID.loot * RAID.loot;
    for (i = 0; i < this.structs.length; i++) {
      var s = this.structs[i]; if (s.dead || s.team === 2 || !LOOT[s.kind]) continue;
      var sx = s.x + s.w / 2, sy = s.y + s.h / 2, sd = (sx - a.x) * (sx - a.x) + (sy - a.y) * (sy - a.y);
      if (sd < ld && hd(Math.floor(sx), Math.floor(sy)) <= RAID.hard && (s.kind !== 'camo' || sd <= 9 * RANGE_K * RANGE_K)) { ld = sd; lt = { x: sx, y: sy, d: Math.sqrt(sd), s: s }; }
    }
    if (lt) {
      if (lt.d > a.range * 0.85) { var kk = Math.max(0, 1 - a.range * 0.7 / lt.d); go(this.spotNear(a, Math.floor(a.x + (lt.x - a.x) * kk), Math.floor(a.y + (lt.y - a.y) * kk), taken), false); }
      else {
        if (!a.at) { var lc = this.cellOf(a); a.goal = [lc[0], lc[1]]; a.at = true; }
        // хозяину — раз в полминуты на постройку (в игре — сводка «Мародёры грабят»)
        if (lt.s.team <= 1 && this.t - (lt.s.lootT == null ? -99 : lt.s.lootT) > 30) { lt.s.lootT = this.t; this.msg('Мародёры грабят: ' + U.ST[lt.s.kind][0].toLowerCase(), lt.s.team, 'bad'); }
      }
      return;
    }
    // слоняться у города вне выстрела обороны; точка общая на банду, меняется раз в ~2 минуты
    var p = this.lurkPoint(a, home, foes);
    if (!p) return;
    if (a.lurk === p.k && a.goal && (!a.at || Math.abs(a.goal[0] - p.x) + Math.abs(a.goal[1] - p.y) < 6)) return;
    var spot = this.spotNear(a, p.x, p.y, taken);
    if (spot) { this.mark(taken, spot[0], spot[1], a); a.lurk = p.k; go(spot, false); }
  };
  function hash4(a, b, c, d) { var h = 2166136261; [a, b, c, d].forEach(function(v) { h ^= (v | 0) + 0x9e3779b9; h = Math.imul(h, 16777619); h ^= h >>> 13; }); return (h >>> 0) % 100000; }
  Ground.prototype.lurkPoint = function(a, home, foes) {
    var key = home[0] * 1000 + home[1], b = Math.floor((this.t + key % RAID.every) / RAID.every), c = (this._lurk || (this._lurk = {}))[key];
    if (c && c.b === b) return c.p;
    var sqx = this.sx + SQUARE / 2, sqy = this.sy + SQUARE / 2, lo = SQUARE / 2 + a.range + RAID.ring[0], hi = SQUARE / 2 + a.range + RAID.ring[1];
    var foot = this.pass.foot1, band = N - P.GEO.strip - 4, best = null, bs = 1e18, i;
    var guns = [];
    for (i = 0; i < foes.length; i++) guns.push([foes[i].x, foes[i].y, foes[i].range + 2]);
    for (i = 0; i < this.structs.length; i++) { var s = this.structs[i]; if (!s.dead && s.team !== 2 && (s.kind === 'turret' || s.kind === 'tower')) guns.push([s.x + s.w / 2, s.y + s.h / 2, s.radius * RANGE_K + 3]); }
    for (var y = Math.max(2, Math.floor(sqy - hi)); y <= Math.min(band, Math.ceil(sqy + hi)); y += 2) {
      for (var x = Math.max(2, Math.floor(sqx - hi)); x <= Math.min(N - 3, Math.ceil(sqx + hi)); x += 2) {
        var r = Math.max(Math.abs(x + 0.5 - sqx), Math.abs(y + 0.5 - sqy));
        if (r < lo || r > hi || !foot[y * N + x] || Math.max(Math.abs(x - home[0]), Math.abs(y - home[1])) > RAID.hard) continue;
        var th = 0;
        for (i = 0; i < guns.length; i++) { var gx = guns[i][0] - x, gy = guns[i][1] - y; if (gx * gx + gy * gy <= guns[i][2] * guns[i][2]) th++; }
        var sc = th * 1e6 + hash4(key, b, x, y);
        if (sc < bs) { bs = sc; best = { x: x, y: y, k: key + ':' + b + ':' + x + ':' + y }; }
      }
    }
    this._lurk[key] = { b: b, p: best };
    return best;
  };
  // Налёт кончился: банда уходит с карты к ближнему краю (прочь от города) и исчезает
  Ground.prototype.raidLeave = function(a) {
    if (a.leaveT == null) a.leaveT = this.t;
    var x = Math.floor(a.x), y = Math.floor(a.y), edge = Math.min(x, y, N - 1 - x, N - 1 - y);
    if (edge <= 3 || this.t - a.leaveT > RAID.leaveT) { a.alive = false; a.gone = true; a.removed = true; a.left = true; a.diedAt = this.t - 100; return; }
    if (a.goal && !a.at && a.post) return;
    var sqx = this.sx + SQUARE / 2, sqy = this.sy + SQUARE / 2, dx = a.x - sqx, dy = a.y - sqy;
    if (dy > 0) dy = 0;                                // не через полосу вторжения внизу — вбок или вверх
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) dx = a.x < N / 2 ? -1 : 1;
    var k = Math.min(dx > 0 ? (N - 3 - a.x) / dx : dx < 0 ? (2 - a.x) / dx : 1e9, dy > 0 ? (N - 3 - a.y) / dy : dy < 0 ? (2 - a.y) / dy : 1e9);
    var tx = Math.round(a.x + dx * k), ty = Math.round(a.y + dy * k), c = this.nearestOk(a.move, a.size, clamp(tx, 2, N - 3), clamp(ty, 2, N - 3));
    if (!c) { a.leaveT = -1e9; return; }
    this.goCell(a, c[0], c[1]); a.post = true; a.hold = false; a.focus = -1;
  };
  // ---- захват площади: как capture_tick в игре, перевес даёт +1/с, равенство — спор
  // ---- районы города: кто держит (больше бойцов внутри; при равенстве — прежний), их действие
  Ground.prototype.districtsStep = function(dt) {
    var ag = this.agents, ds = this.districts, i, j;
    for (j = 0; j < ds.length; j++) { ds[j].cnt[0] = 0; ds[j].cnt[1] = 0; }
    for (i = 0; i < ag.length; i++) {
      var a = ag[i]; a.rofK = 1; if (!a.alive || a.team > 1 || a.air || a.fly) continue;
      for (j = 0; j < ds.length; j++) { var r = ds[j].rect; if (a.x >= r[0] && a.x < r[0] + r[2] && a.y >= r[1] && a.y < r[1] + r[3]) { ds[j].cnt[this.ctl(a)]++; a.inD = j; break; } }
      if (j === ds.length) a.inD = -1;
    }
    for (j = 0; j < ds.length; j++) {
      var d = ds[j], was = d.by;
      if (d.cnt[0] > d.cnt[1]) d.by = 0; else if (d.cnt[1] > d.cnt[0]) d.by = 1;
      if (d.by !== was) { this.msg(d.name + ': ' + (d.by === this.def ? 'отбит' : 'занят врагом'), this.def, d.by === this.def ? 'gold' : 'bad'); this.msg(d.name + ': ' + (d.by === this.att ? 'взят' : 'потерян'), this.att, d.by === this.att ? 'gold' : 'bad'); }
    }
    for (i = 0; i < ag.length; i++) {
      var b = ag[i]; if (!b.alive || b.inD == null || b.inD < 0) continue;
      var dd = ds[b.inD]; if (dd.by !== this.ctl(b)) continue;
      if (dd.id === 'hospital' && b.T.cls === 'infantry' && b.hp < b.hpMax) b.hp = Math.min(b.hpMax, b.hp + b.hpMax * 0.01 * dt);
      else if (dd.id === 'workshops' && b.T.vehicle && b.hp < b.hpMax) b.hp = Math.min(b.hpMax, b.hp + b.hpMax * 0.01 * dt);
      else if (dd.id === 'warehouses') b.rofK = 0.75;
    }
  };
  // Ополчение: n ополченцев хозяина выходят с плаца казарм (или на край площади); казармы у врага — не выходят
  Ground.prototype.raiseMilitia = function(n, opts) {
    var team = this.def, gar = null;
    for (var j = 0; j < this.districts.length; j++) if (this.districts[j].id === 'garrison') gar = this.districts[j];
    if (gar && gar.by !== team) return 0;
    var at = gar ? gar.spawn : [this.sx + SQUARE / 2, this.sy + SQUARE], tid = team === 0 ? 'rep_militia' : 'cis_militia', taken = {}, made = 0;
    for (var i = 0; i < n; i++) {
      var probe = { size: 1, move: 'foot', team: team, air: false, fly: false, T: U.type(tid) }, spot = this.spotNear(probe, at[0], at[1], taken);
      if (!spot) break;
      taken[spot[1] * N + spot[0]] = 1;
      var a = this.add(tid, team, spot[0] + 0.5, spot[1] + 0.5, { aim: Math.atan2(this.threatDir()[1], this.threatDir()[0]), npc: true, uid: opts && opts.uids ? opts.uids[i] : null });
      a.auto = true; made++;
    }
    if (made) { this.msg('Ополчение вышло на защиту: ' + made, team, 'gold'); this.msg('Из города вышло ополчение: ' + made, 1 - team, 'bad'); }
    return made;
  };
  Ground.prototype.capture = function(dt) {
    if (this.noTown) return;                 // ивент: исход решает его сценарий (shared/rt-events.js)
    this.districtsStep(dt);
    // полигон: враг у стен — жители берутся за оружие (в игре — raise_militia по своим правилам)
    if (this.militiaAuto && this.militiaT < 0) {
      var tw = this.town, near = false, ag0 = this.agents;
      for (var q = 0; q < ag0.length && !near; q++) { var e0 = ag0[q]; if (e0.alive && this.ctl(e0) === this.att && e0.x >= tw[0] - 6 && e0.x < tw[0] + tw[2] + 6 && e0.y >= tw[1] - 6 && e0.y < tw[1] + tw[3] + 6) near = true; }
      if (near) { this.militiaT = this.t; var gar = this.districts.some(function(d) { return d.id === 'garrison'; }); this.raiseMilitia(TOWN.MILITIA_BASE[this.settle.level] + (gar ? 3 : 0)); }
    }
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
    if (!this.capExternal) c.prog = clamp(c.prog + c.rate * dt, 0, this.capNeed);
    // штурм отбит: десант уничтожен — или от него осталась горстка (≤10 %), и полторы минуты никого в городе
    var nA = this.alive(this.att), tw = this.town, near = false;
    if (this.attN0 == null && this.t > 5) this.attN0 = nA;
    for (i = 0; i < ag.length; i++) { var b = ag[i]; if (b.alive && this.ctl(b) === this.att && b.x >= tw[0] - 6 && b.x < tw[0] + tw[2] + 6 && b.y >= tw[1] - 6 && b.y < tw[1] + tw[3] + 6) { near = true; break; } }
    if (near || this.lastNear == null) this.lastNear = this.t;
    if (this.capExternal) return;            // в игре бой не «кончается»: планета живёт дальше
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
      if (a.hero && a.hero.pend) this.pendStep(a);
      this.think(a, dt);
      if (a.wh) this.wheelStep(a, dt);
      if (a.T.medic) this.medicStep(a, dt);
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
    var self = this, s = { t: this.t, over: this.over, why: this.why, alive: [this.alive(0), this.alive(1)], cap: this.cap, sq: [[], []], districts: this.districts.map(function(d) { return { id: d.id, name: d.name, by: d.by, cnt: d.cnt.slice() }; }) };
    for (var tm = 0; tm < 2; tm++) s.sq[tm] = this.teams[tm].squads.map(function(q) { var n = 0; q.members.forEach(function(id) { if (self.agents[id].alive) n++; }); return { id: q.id, n: n }; });
    return s;
  };

  return { SKILL: SKILL, WHEEL: WHEEL, MEDIC: MEDIC, HUNT: HUNT, Ground: Ground, Flows: Flows, STEP: STEP, RANGE_K: RANGE_K, SABER: SABER, SQUARE: SQUARE, ABIL: ABIL, ABIL_NAME: ABIL_NAME, ACTIVE_LIGHT: ACTIVE_LIGHT, ACTIVE_DARK: ACTIVE_DARK, turn: turn, rng: rng };
});
