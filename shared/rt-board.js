// Абордаж 2.0: бой внутри корабля в реальном времени.
//
// Правила взяты из старой игры (js/boarding-*.js) и переложены на живое время:
//  - абордажная команда высаживается в шлюз; шлюзовые и бронедвери по тревоге
//    заперты — их вскрывают (инженер вдвое быстрее);
//  - защитники — бойцы из казарм корабля; экипаж в бой не идёт, но под огнём гибнет;
//  - противоабордажные турели у входов в ключевые отсеки, питаются от энергоузла;
//  - отсек, где остались одни атакующие, через 6 с переходит к ним: его система
//    глохнет (щиты, двигатели, орудия борта, ангар…), особые отсеки дают своё
//    (связь — снять тревогу, энергоузел — погасить турели, тактический центр —
//    видеть весь корабль, арсенал — +15% урона, лазарет — лечение, насосная —
//    продувка отсека раз в 5 мин);
//  - цели: мостик — удержать (90 с, флагман — 150 с) и корабль ваш;
//    реактор — инженер ставит заряд (6 с), 90 с до взрыва, если защитники не снимут.
//
// Бойцы — тела того же экипажа (rt-crew): не проходят сквозь стены, мебель и
// друг друга, ходят по тем же полям направлений. Этот модуль добавляет к ним
// оружие, цели, двери, турели и захват отсеков. ES5, без зависимостей.

(function(root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SWBoard = api;
})(typeof self !== 'undefined' ? self : this, function() {
  'use strict';

  var K = { VOID: 0, TECH: 1, HULL: 2, WALL: 3, FLOOR: 4, DOOR: 5 };
  var DX = [1, 1, 0, -1, -1, -1, 0, 1], DY = [0, 1, 1, 1, 0, -1, -1, -1];

  // Оружие по фигуре бойца (из TYPES rt-core и экипажа). range — клетки (2 м).
  var WPN = {
    rifle:  { name: 'DC-15A',       hp: 100, range: 12, acc: 0.5, dmg: 9,  rof: 0.9, spd: 1    },
    heavy:  { name: 'Z-6',          hp: 120, range: 11, acc: 0.40, dmg: 5,  rof: 2.4, spd: 0.85 },
    b1:     { name: 'E-5',          hp: 90,  range: 11, acc: 0.46, dmg: 8,  rof: 0.8, spd: 0.95 },
    b2:     { name: 'Наручный бластер', hp: 180, range: 9, acc: 0.48, dmg: 6, rof: 1.3, spd: 0.75 },
    bx:     { name: 'E-5 (BX)',     hp: 140, range: 12, acc: 0.62, dmg: 10, rof: 0.85, spd: 1.15 },
    tool:   { name: 'Пистолет',     hp: 100, range: 8,  acc: 0.35, dmg: 6,  rof: 0.6, spd: 1    },
    // бойцы из игры: снайпер, гранатомёт (по площади), световой меч (вплотную, герои)
    sniper: { name: 'Снайперская винтовка', hp: 70, range: 20, acc: 0.8, dmg: 22, rof: 0.4, spd: 0.9 },
    launcher: { name: 'Гранатомёт', hp: 90, range: 10, acc: 0.45, dmg: 18, rof: 0.35, spd: 0.9, splash: 1.6 },
    saber:  { name: 'Световой меч', hp: 280, range: 2.6, acc: 0.9, dmg: 26, rof: 1.6, spd: 1.35 }
  };
  var FIG_WPN = { rep_dc15a: 'rifle', rep_heavy: 'heavy', rep_sniper: 'rifle', cis_b1: 'b1', cis_b2: 'b2', cis_bx: 'bx',
                  rep_engineer: 'tool', cis_engineer: 'tool' };
  var TURRET = { hp: 150, range: 11, acc: 0.7, dmg: 25, rof: 0.4 };
  // Повадки в бою (как на пробной палубе) — только пока бойца ведёт ИИ или в рамках приказа игрока:
  //  crowd — B1: из коридора и шлюза лезут в отсек к цели, там встают и стреляют;
  //  push  — B2: давит вперёд с огнём до near клеток;
  //  cover — BX и клоны: ищут клетку за мебелью в r клетках, откуда видно цель;
  //  every — как часто решают заново, с. Точка игрока («держать здесь») важнее любых повадок.
  var STYLE = {
    b1:    { k: 'crowd', every: 1.4 },
    b2:    { k: 'push', near: 4.5, every: 1.3 },
    bx:    { k: 'cover', r: 4, every: 3.5 },
    rifle: { k: 'cover', r: 3, every: 5 },
    sniper: { k: 'cover', r: 3, every: 6 }
  };
  var MICRO_END = 2;          // столько секунд без боя — бойцы возвращаются к приказу
  // PREP — подготовка после первой стыковки: штурмовики ждут в шлюзе (получают приказы),
  // защитники запирают, заваривают, расставляют отряды; HOLD_SOLO — подкрепление игрока без приказа ждёт столько
  var PREP = 45, HOLD_SOLO = 20;
  var CAPTURE = 6, RETAKE = 6, BREACH = 10, PLANT = 6, FUSE = 90, DEFUSE = 8, VENT_CD = 300, VENT_DMG = 40;
  // оборона: обычную дверь вскрывают вдвое быстрее брони; заваренную — вдвое дольше; заварка 6 с
  var WELD = 6, DSQ_MAX = 10;
  var SCAN = 0.4, ASSAULT = 1.35;
  // Отсеки по роли: что даёт захват
  var KEYROOM = { bridge: 1, cic: 1, reactor: 1, shield: 1, comms: 1, power: 1, engine: 1, hyper: 1, hangar: 1,
                  armory: 1, medbay: 1, pumps: 1, gun: 1, pdgun: 1 };

  function rng(seed) {
    var s = (seed >>> 0) || 1;
    return function() { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  }
  function turn(cur, to, step) {
    var d = to - cur;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return Math.abs(d) <= step ? to : cur + (d > 0 ? step : -step);
  }

  // crew — экипаж корабля-цели (rt-crew); opts: { flagship, figIds, seed }
  function Board(crew, opts) {
    opts = opts || {};
    var sh = crew.ship, W = sh.w, n = W * sh.h, i;
    this.c = crew; this.ship = sh; this.W = W;
    crew.board = this;
    this.def = crew.team; this.att = 1 - crew.team;
    this.R = rng(opts.seed || 99991);
    this.figIds = opts.figIds || null;
    this.holdNeed = opts.flagship ? 150 : 90;
    this.t = 0; this.over = -1; this.why = '';
    this.ev = { shots: [], msgs: [], doors: [], vents: [], booms: [] };
    // проходимость для атакующих: как у экипажа, но запертые двери — стена
    this.walkAtt = new Uint8Array(crew.walk);
    // прозрачность для выстрелов: пол и двери без глухих машин
    this.clear = new Uint8Array(n);
    for (i = 0; i < n; i++) { var k = sh.kind[i]; this.clear[i] = (k === K.FLOOR || k === K.DOOR) && sh.prop[i] !== 2 ? 1 : 0; }
    // двери: клетки проёма, вид, состояние
    this.doorAt = new Int16Array(n).fill(-1);
    this.doors = [];
    for (i = 0; i < sh.doors.length; i++) {
      // проём: w клеток вдоль стены; у двойной стены (d = 2) — ещё ряд по ту сторону
      var d = sh.doors[i], cells = [], ww = d.w || 1, j, c;
      for (j = 0; j < ww; j++) {
        c = (d.y + (d.v ? j : 0)) * W + d.x + (d.v ? 0 : j);
        if (sh.kind[c] === K.DOOR && this.doorAt[c] < 0) cells.push(c);
      }
      if ((d.d || 1) > 1) {
        for (var side = -1; side <= 1; side += 2) {
          var far = [], ok = true;
          for (j = 0; j < ww; j++) {
            c = (d.y + (d.v ? j : side)) * W + d.x + (d.v ? side : j);
            if (c < 0 || c >= n || sh.kind[c] !== K.DOOR || this.doorAt[c] >= 0) { ok = false; break; }
            far.push(c);
          }
          if (ok) { cells = cells.concat(far); break; }
        }
      }
      if (!cells.length) continue;
      var di = this.doors.length;
      for (j = 0; j < cells.length; j++) this.doorAt[cells[j]] = di;
      var cx = 0, cy = 0; for (j = 0; j < cells.length; j++) { cx += cells[j] % W; cy += Math.floor(cells[j] / W); }
      this.doors.push({ i: di, id: d.id, k: this.doorKind(d, cells), cells: cells, x: cx / cells.length + 0.5, y: cy / cells.length + 0.5, v: d.v,
                        state: 'open', breach: 0, by: -1, weld: 0, welder: -1, weldP: 0, rooms: d.rooms || [] });
    }
    // противоабордажные турели
    this.turrets = [];
    for (i = 0; i < sh.props.length; i++) {
      var p = sh.props[i]; if (p.t !== 'apturret') continue;
      var tc = (p.y + 1) * W + p.x + 1;
      this.turrets.push({ x: p.x + 1, y: p.y + 1, hp: TURRET.hp, cd: this.R() * 2, aim: 0, tgt: -1, dead: false, room: sh.room[tc] || sh.room[p.y * W + p.x], fireAt: -9 });
    }
    // отсеки: кто держит
    this.rs = {};
    this.keyRooms = [];
    for (i = 0; i < sh.rooms.length; i++) {
      var r = sh.rooms[i];
      this.rs[r.n] = { n: r.n, t: r.t, r: r, cnt: [0, 0], hold: 0, back: 0, held: false };
      if (KEYROOM[r.t]) this.keyRooms.push(r.n);
    }
    this.bridge = this.firstRoom('bridge') || this.firstRoom('cic');
    this.reactor = this.firstRoom('reactor');
    this.bridgeT = 0;
    this.charge = null;          // { plant, left, room, defuse }
    this.ventCd = [0, 0];
    this.alarm = false; this.alarmCd = 0;
    this.squads = [];            // отряды атакующих (по шаттлам): { id, members[], room, auto }
    this.dsq = [];               // отряды защитников: { id, members[], room, auto }
    // оборона за игроком: отряды собирает он сам («В отряд N»); кто без отряда — держит, где стоит.
    // За ИИ — отряды по казармам, как раньше. Ставит бой (Battle) по aiBoard стороны защитников.
    this.defManual = !!opts.defManual;
    this.visT = 0; this.vis = new Uint8Array(0);     // кого из защитников видят атакующие
    this.defT = 0;
    this.started = false;
  }
  // Вид двери по соседним отсекам: шлюз — шлюзовая, ключевой отсек — бронедверь
  // (в данных планов вид иногда определён по дальним клеткам — здесь по соседям проёма)
  var BLAST = { bridge: 1, cic: 1, reactor: 1, shield: 1, comms: 1, power: 1, armory: 1 };
  Board.prototype.doorKind = function(d, cells) {
    var sh = this.ship, W = this.W, lock = false, blast = d.k === 'blast';
    for (var j = 0; j < cells.length; j++) {
      for (var o = 0; o < 4; o++) for (var r = 1; r <= 2; r++) {
        var x = cells[j] % W + (o === 0 ? r : o === 1 ? -r : 0), y = Math.floor(cells[j] / W) + (o === 2 ? r : o === 3 ? -r : 0);
        if (x < 0 || y < 0 || x >= W || y >= sh.h) continue;
        var rm = sh.roomByN[sh.room[y * W + x]]; if (!rm) continue;
        if (rm.t === 'airlock') lock = true;
        if (BLAST[rm.t]) blast = true;
      }
    }
    return lock ? 'lock' : blast ? 'blast' : 'door';
  };
  Board.prototype.firstRoom = function(t) {
    for (var i = 0; i < this.ship.rooms.length; i++) if (this.ship.rooms[i].t === t) return this.ship.rooms[i].n;
    return 0;
  };
  Board.prototype.msg = function(text, team, kind) {
    this.seq = (this.seq || 0) + 1;
    this.ev.msgs.push({ seq: this.seq, t: this.c.t, text: text, team: team, kind: kind || '' });
    if (this.ev.msgs.length > 40) this.ev.msgs.splice(0, 20);
  };
  // Кто держит отсек (сторона); по умолчанию — хозяин корабля
  Board.prototype.heldBy = function(n) { var s = this.rs[n]; return s && s.held ? this.att : this.def; };
  Board.prototype.heldType = function(t) {
    for (var k in this.rs) if (this.rs[k].t === t && this.rs[k].held) return true;
    return false;
  };
  // Этот боец — под управлением абордажа (атакующий или защитник в бою)
  Board.prototype.owns = function(a) { return a.team !== this.def || (a.job && (a.job.kind === 'defend' || a.job.kind === 'weld')); };

  // ---------------------------------------------------------------- двери
  Board.prototype.occupied = function(d) {
    var ag = this.c.agents, W = this.W;
    for (var i = 0; i < ag.length; i++) {
      var a = ag[i]; if (!a.alive || a.team !== this.att) continue;
      if (d.cells.indexOf(Math.floor(a.y) * W + Math.floor(a.x)) >= 0) return true;
    }
    return false;
  };
  Board.prototype.setDoor = function(d, state) {
    if (d.state === state) return;
    d.state = state;
    if (state !== 'locked') { d.weld = 0; d.weldP = 0; }
    var lock = state === 'locked';
    for (var j = 0; j < d.cells.length; j++) this.walkAtt[d.cells[j]] = lock ? 0 : this.c.walk[d.cells[j]];
    this.ev.doors.push({ t: this.c.t, i: d.i, state: state });
    if (this.ev.doors.length > 60) this.ev.doors.splice(0, 30);
  };
  // Тревога: шлюзовые и бронедвери запираются (связь в руках врага — не работает)
  Board.prototype.setAlarm = function(on) {
    if (on && this.heldType('comms')) return false;
    if (on && this.alarmCd > 0 && !this.alarm) return false;
    this.alarm = !!on;
    for (var i = 0; i < this.doors.length; i++) {
      var d = this.doors[i];
      if (d.state === 'broken') continue;
      if (d.k !== 'blast' && d.k !== 'lock') continue;
      if (on && this.occupied(d)) continue;             // в проёме стоит чужой — дверь не закрыть
      if (!on && d.weld) continue;                      // заваренная остаётся запертой
      this.setDoor(d, on ? 'locked' : 'open');
    }
    if (on) { this.alarmCd = 300; this.c.alert(true); }
    return true;
  };

  // ---------------------------------------------------------------- высадка
  // party: [{ fig, wpn, eng }]; room — шлюз высадки (номер отсека)
  // manual — атакующая сторона за игроком: отряд ждёт приказа (без него — ИИ по истечении ожидания)
  Board.prototype.addParty = function(party, roomN, manual) {
    var c = this.c, st = c.rooms[roomN], r = this.ship.roomByN[roomN], i;
    if (!st || !r) return null;
    if (!this.started) {
      this.started = true;
      this.prep = PREP;
      this.setAlarm(true);
      this.msg('Абордаж! Тревога: шлюзы и бронедвери заперты. До штурма ' + PREP + ' с — запирай, заваривай, ставь отряды', this.def, 'bad');
      this.msg('Стыковка. Подготовка ' + PREP + ' с: раздай отрядам цели — штурм начнётся сам', this.att, 'gold');
      // бойцы из казарм — к обороне (кто уже встал на пост погибшего расчётчика — остаётся на посту)
      for (i = 0; i < c.agents.length; i++) {
        var a = c.agents[i];
        if (a.alive && a.team === this.def && this.isTrooper(a)) this.toDefend(a);
      }
      this.makeDefSquads();
    }
    var sq = manual ? { id: this.squads.length + 1, members: [], room: roomN, auto: false, wait: Math.max(this.prep || 0, HOLD_SOLO), land: roomN }
                    : { id: this.squads.length + 1, members: [], room: this.bridge || roomN, auto: true };
    for (i = 0; i < party.length; i++) {
      var pm = party[i], p = c.spotIn(r) || st.anchor; if (!p) break;
      var w = WPN[pm.wpn] || WPN.rifle;
      var ag = {
        id: c.agents.length, x: p[0] + 0.5 + (this.R() - 0.5) * 0.4, y: p[1] + 0.5 + (this.R() - 0.5) * 0.4, vx: 0, vy: 0,
        hp: pm.hp || w.hp, hpMax: pm.hpMax || w.hp, dmgK: pm.dmgK || 1, utype: pm.utype || '', uname: pm.uname || '', uid: pm.uid || '',
        hero: !!pm.hero, medicU: !!pm.medicU, src: pm.src, alive: true, team: this.att, home: -1, spot: null, role: pm.eng ? 'sapper' : 'boarder', grp: 'board',
        task: 'board', goalRoom: roomN, goal: p, at: false, wait: 0.4 + this.R() * 0.8, stuck: 0, lastD: 1e9, wig: 0,
        job: { kind: 'board' }, fig: pm.fig, aim: 0, legs: 0, mv: 0, phase: this.R() * 6.28, face: null, sprayAt: -1, fixAt: -1,
        carry: false, medic: -1, hold: 0, busyT: 0, claimed: -1, wpn: pm.wpn, eng: !!pm.eng, sq: sq.id,
        tgt: -1, scan: this.R() * SCAN, cd: this.R(), breach: -1
      };
      c.agents.push(ag); sq.members.push(ag.id);
    }
    if (!sq.members.length) return null;
    this.squads.push(sq);
    this.orderSquad(sq, sq.room, !manual);
    this.msg('Отряд ' + sq.id + ' высадился: ' + sq.members.length + ' бойцов', this.att, 'gold');
    return sq;
  };
  Board.prototype.isTrooper = function(a) {
    var st = this.c.rooms[a.home];
    if (a.role === 'guard') return true;                 // штатная охрана — всегда в оборону
    return a.grp === 'troops' && a.role === 'reserve' && !!st && (st.t === 'troops' || st.t === 'droids' || st.t === 'vehicle' || st.t === 'armory');
  };
  Board.prototype.toDefend = function(a) {
    var c = this.c, stand = a.stand;
    a.post = null; a.focus = -1; this.microEnd(a, true);
    c.releaseJob(a); c.claimCell(a, null);
    a.job = { kind: 'defend', room: a.home };
    if (!a.wpn) { a.wpn = this.wpnOf(a); a.hpMax = WPN[a.wpn].hp; a.hp = a.hpMax * Math.min(1, a.hp / 100); }
    a.tgt = -1; a.scan = this.R() * SCAN; a.cd = this.R(); a.at = false; a.wait = this.R() * 1.5; a.guard = 0;
    if (this.defManual) this.holdHere(a);
    // поставлен игроком на пост — держит его и в обороне
    if (stand && c.walk[stand[1] * this.W + stand[0]]) { a.post = [stand[0], stand[1]]; this.goCell(a, a.post); }
  };
  // Держать место, где стоит (оборона за игроком, боец без отряда)
  Board.prototype.holdHere = function(a) {
    var W = this.W, x = Math.floor(a.x), y = Math.floor(a.y), k = y * W + x;
    if (!this.c.walk[k]) return;
    a.goal = [x, y]; a.goalRoom = this.ship.room[k] || 0; a.at = false; a.stuck = 0; a.lastD = 1e9;
  };
  // Боец обороны без отряда при обороне за игроком — сам никуда не идёт
  Board.prototype.loose = function(a) { return this.defManual && a.team === this.def && !a.dsq; };
  // Новый абордаж того же корабля (прошлый отбит): двери, турели, насосы — как есть
  Board.prototype.reopen = function() {
    this.over = -1; this.why = ''; this.started = false; this.bridgeT = 0; this.charge = null; this.squads = []; this.dsq = [];
    for (var i = 0; i < this.c.agents.length; i++) this.c.agents[i].dsq = 0;
  };
  Board.prototype.wpnOf = function(a) {
    var id = this.figIds && this.figIds[a.fig];
    if (id && FIG_WPN[id]) return FIG_WPN[id];
    return this.c.ship.faction === 'cis' ? (a.id % 4 === 3 ? 'b2' : 'b1') : (a.id % 5 === 4 ? 'heavy' : 'rifle');
  };
  // Приказ отряду: занять отсек (auto — приказ ИИ, игрок его перекрывает)
  // cell — точка на плане (номер клетки): отряд встаёт вокруг неё и держит её (коридор, развилка…);
  // без точки — идёт в отсек целиком
  Board.prototype.orderSquad = function(sq, roomN, auto, cell) {
    var c = this.c;
    if (cell != null && cell >= 0) {
      var live = [];
      for (var k = 0; k < sq.members.length; k++) { var m = c.agents[sq.members[k]]; if (m && m.alive) live.push(m); }
      var spots = this.spotsNear(cell, live.length); if (!spots.length) return false;
      sq.room = this.ship.room[spots[0][1] * this.W + spots[0][0]] || 0; sq.auto = false; sq.cell = cell;
      for (k = 0; k < live.length; k++) { live[k].post = spots[k % spots.length]; live[k].focus = -1; this.goCell(live[k], live[k].post); }
      return true;
    }
    var r = this.ship.roomByN[roomN]; if (!r) return false;
    sq.room = roomN; sq.auto = !!auto; sq.cell = -1;
    for (var i = 0; i < sq.members.length; i++) {
      var a = c.agents[sq.members[i]]; if (!a || !a.alive) continue;
      if (auto && a.post) continue;                         // ИИ отряда не сдёргивает бойца с точки игрока
      var p = c.spotIn(r); if (!p) continue;
      a.post = null;
      if (auto) { this.aiGoal(a, roomN, p); continue; }
      a.focus = -1; this.microEnd(a, true);
      a.goalRoom = roomN; a.goal = p; a.at = false; a.stuck = 0; a.lastD = 1e9;
    }
    return true;
  };
  // Клетки пола вокруг точки (по ходу, не сквозь стены и двери) — места для отряда
  Board.prototype.spotsNear = function(cell, n) {
    var W = this.W, H = this.ship.h, walk = this.c.walk, out = [], seen = {}, q = [];
    if (!(cell >= 0 && cell < W * H)) return out;
    if (!walk[cell] || this.doorAt[cell] >= 0) {
      // ткнули в стену или мебель — ближайший пол в 3 клетках
      // (ближний пол своего же отсека — не по ту сторону стены)
      var cx = cell % W, cy = (cell - cx) / W, best = -1, bd = 1e9, rm = this.ship.room[cell];
      for (var dy = -6; dy <= 6; dy++) for (var dx = -6; dx <= 6; dx++) {
        var x = cx + dx, y = cy + dy, k = y * W + x;
        if (x < 0 || y < 0 || x >= W || y >= H || !walk[k] || this.doorAt[k] >= 0) continue;
        var dd = dx * dx + dy * dy + (this.ship.room[k] === rm ? 0 : 50);
        if (dd < bd) { bd = dd; best = k; }
      }
      if (best < 0) return out;
      cell = best;
    }
    q.push(cell); seen[cell] = 1;
    for (var h = 0; h < q.length && out.length < Math.max(1, n); h++) {
      var c0 = q[h], x0 = c0 % W, y0 = (c0 - x0) / W;
      out.push([x0, y0]);
      for (var d = 0; d < 4; d++) {
        var nx = x0 + (d === 0 ? 1 : d === 1 ? -1 : 0), ny = y0 + (d === 2 ? 1 : d === 3 ? -1 : 0), nk = ny * W + nx;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H || seen[nk] || !walk[nk] || this.doorAt[nk] >= 0) continue;
        seen[nk] = 1; q.push(nk);
      }
    }
    return out;
  };
  // Свой ли это боец под приказом игрока: штурмовик из отряда или защитник в обороне
  Board.prototype.mine = function(team, a) {
    return !!(a && a.alive && !a.gone && a.team === team && (team === this.att ? a.sq : a.job && a.job.kind === 'defend'));
  };
  // Приказ отдельным бойцам: каждому своя клетка у точки (ближнему к точке — ближняя), держат её
  Board.prototype.orderUnits = function(team, ids, cell) {
    if (this.over >= 0 || !Array.isArray(ids) || !(cell >= 0 && cell < this.W * this.ship.h)) return 0;
    var c = this.c, list = [], i;
    for (i = 0; i < ids.length && list.length < 128; i++) { var a = c.agents[ids[i] | 0]; if (this.mine(team, a) && list.indexOf(a) < 0) list.push(a); }
    if (!list.length) return 0;
    var spots = this.spotsNear(cell, list.length); if (!spots.length) return 0;
    var px = cell % this.W + 0.5, py = Math.floor(cell / this.W) + 0.5, n = 0;
    list.sort(function(p, q) { return (p.x - px) * (p.x - px) + (p.y - py) * (p.y - py) - (q.x - px) * (q.x - px) - (q.y - py) * (q.y - py); });
    for (i = 0; i < list.length && spots.length; i++) {
      var u = list[i], bi = 0, bd = 1e9;
      for (var k = 0; k < spots.length; k++) { var dx = spots[k][0] + 0.5 - u.x, dy = spots[k][1] + 0.5 - u.y, d = dx * dx + dy * dy; if (d < bd) { bd = d; bi = k; } }
      u.post = spots.splice(bi, 1)[0]; u.guard = 0; u.breach = -1; u.wait = 0;
      this.goCell(u, u.post); n++;
    }
    // штурмовой отряд на подготовке: все его бойцы получили точки — приказ есть, ждать нечего
    if (team === this.att) for (i = 0; i < this.squads.length; i++) {
      var sq = this.squads[i]; if (!(sq.wait > 0)) continue;
      var all = true;
      for (var m = 0; m < sq.members.length; m++) { var sa = c.agents[sq.members[m]]; if (sa && sa.alive && !sa.post) { all = false; break; } }
      if (all) sq.wait = 0;
    }
    return n;
  };
  // Огонь по выбранному врагу: бьют его, когда видят и достают (пока жив)
  Board.prototype.focusUnits = function(team, ids, tid) {
    if (this.over >= 0 || !Array.isArray(ids)) return 0;
    var t = this.c.agents[tid | 0]; if (!t || !t.alive || t.team === team) return 0;
    var n = 0;
    for (var i = 0; i < ids.length && i < 128; i++) { var a = this.c.agents[ids[i] | 0]; if (this.mine(team, a)) { a.focus = tid | 0; a.scan = 0; n++; } }
    return n;
  };
  Board.prototype.goCell = function(a, p) {
    this.microEnd(a, true);
    var k = p[1] * this.W + p[0];
    a.goalRoom = this.ship.room[k] || 0; a.goal = [p[0], p[1]]; a.at = false; a.stuck = 0; a.lastD = 1e9; a.goT = this.t;
  };
  Board.prototype.order = function(team, sqIds, roomN, cell) {
    if (this.over >= 0) return 0;
    if (cell != null && cell >= 0) { if (!(cell < this.W * this.ship.h)) return 0; roomN = this.ship.room[cell] || 0; }
    else if (!this.ship.roomByN[roomN]) return 0;
    if (team === this.def) return this.orderDef(sqIds, roomN, cell);
    if (team !== this.att) return 0;
    var n = 0;
    for (var i = 0; i < this.squads.length; i++) {
      var sq = this.squads[i];
      if (sqIds && sqIds.indexOf(sq.id) < 0) continue;
      if (this.alive(sq) && this.orderSquad(sq, roomN, false, cell)) { sq.wait = 0; n++; }
    }
    return n;
  };
  // ---------------------------------------------------------------- оборона под рукой игрока
  // Отряды защитников: бойцы казарм по 10, по своей казарме. Без приказа — ИИ
  // (часть держит мостик и реактор, остальные идут на врага); с приказом — держат отсек.
  Board.prototype.makeDefSquads = function(force) {
    if (this.defManual && !force) return;
    var c = this.c, list = [], i, sq = null;
    for (i = 0; i < c.agents.length; i++) {
      var a = c.agents[i];
      if (a.alive && a.team === this.def && a.job && a.job.kind === 'defend' && !a.dsq) list.push(a);
    }
    list.sort(function(p, q) { return (p.home - q.home) || (p.id - q.id); });
    for (i = 0; i < list.length; i++) {
      if (!sq || sq.members.length >= DSQ_MAX || (sq.home !== list[i].home && sq.members.length >= 6)) {
        sq = { id: this.nextDsq(), members: [], room: 0, auto: true, home: list[i].home };
        this.dsq.push(sq);
      }
      sq.members.push(list[i].id); list[i].dsq = sq.id;
    }
  };
  // Боец вернулся с шаттла или встал в оборону позже — в отряд
  Board.prototype.addDefender = function(a) { this.toDefend(a); a.dsq = 0; this.makeDefSquads(); };
  Board.prototype.orderDef = function(ids, roomN, cell) {
    var n = 0, pt = cell != null && cell >= 0;
    for (var i = 0; i < this.dsq.length; i++) {
      var sq = this.dsq[i];
      if (ids && ids.indexOf(sq.id) < 0) continue;
      if (!this.alive(sq)) continue;
      var live = [];
      for (var j = 0; j < sq.members.length; j++) { var a = this.c.agents[sq.members[j]]; if (a && a.alive) live.push(a); }
      var spots = pt ? this.spotsNear(cell, live.length) : null;
      if (pt && !spots.length) continue;
      sq.room = pt ? this.ship.room[spots[0][1] * this.W + spots[0][0]] || 0 : roomN; sq.auto = false; sq.cell = pt ? cell : -1; n++;
      for (j = 0; j < live.length; j++) {
        a = live[j]; a.guard = 0; a.goT = -99; a.focus = -1;
        if (pt) { a.post = spots[j % spots.length]; this.goCell(a, a.post); }
        else { a.post = null; this.microEnd(a, true); this.goRoom(a, roomN, 0); }
      }
    }
    // приказ всем — и бойцам без отряда (оборона за игроком): идут и держат там
    if (!ids && this.defManual) {
      var loose = [];
      for (var li = 0; li < this.c.agents.length; li++) { var la = this.c.agents[li]; if (this.mine(this.def, la) && this.loose(la)) loose.push(la); }
      var lsp = pt && loose.length ? this.spotsNear(cell, loose.length + 12).slice(12) : null;      // мимо мест отрядов
      if (pt && lsp && !lsp.length) lsp = this.spotsNear(cell, loose.length);
      if (pt && (!lsp || !lsp.length)) loose = [];                        // туда не пройти — некому
      for (li = 0; li < loose.length; li++) {
        var lb = loose[li]; lb.guard = 0; lb.goT = -99; lb.focus = -1;
        if (pt && lsp.length) { lb.post = lsp[li % lsp.length]; this.goCell(lb, lb.post); }
        else if (!pt) { lb.post = null; this.microEnd(lb, true); this.goRoom(lb, roomN, 0); }
      }
      if (loose.length) n++;
    }
    return n;
  };
  // Вернуть отряды ИИ (атакующие — на мостик, защитники — охрана и охота)
  Board.prototype.setAuto = function(team, ids) {
    var list = team === this.def ? this.dsq : team === this.att ? this.squads : [], n = 0;
    for (var i = 0; i < list.length; i++) {
      var sq = list[i];
      if (ids && ids.indexOf(sq.id) < 0) continue;
      if (!this.alive(sq)) continue;
      n++;
      sq.cell = -1;
      for (var pm = 0; pm < sq.members.length; pm++) { var pa = this.c.agents[sq.members[pm]]; if (pa) { pa.post = null; pa.focus = -1; this.microEnd(pa, true); } }
      if (team === this.att) { if (this.bridge) this.orderSquad(sq, this.bridge, true); else sq.auto = true; }
      else { sq.auto = true; sq.room = 0; }
    }
    // «Сами» всем: бойцы без отряда тоже уходят к ИИ — отрядами по казармам
    if (team === this.def && !ids && this.defManual) {
      var before = this.dsq.length; this.makeDefSquads(true); n += this.dsq.length - before;
    }
    return n;
  };
  Board.prototype.nextDsq = function() { var m = 0; for (var i = 0; i < this.dsq.length; i++) m = Math.max(m, this.dsq[i].id); return m + 1; };
  // Игрок собирает отряд: выбранные бойцы обороны — в отряд sqId (0 — новый, -1 — без отряда)
  Board.prototype.assignDef = function(team, ids, sqId) {
    if (team !== this.def || this.over >= 0 || !Array.isArray(ids)) return 0;
    var c = this.c, list = [], i;
    for (i = 0; i < ids.length && list.length < 128; i++) { var a = c.agents[ids[i] | 0]; if (this.mine(team, a) && list.indexOf(a) < 0) list.push(a); }
    if (!list.length) return 0;
    var sq = null;
    if (sqId > 0) { for (i = 0; i < this.dsq.length; i++) if (this.dsq[i].id === sqId) sq = this.dsq[i]; if (!sq) return 0; }
    else if (sqId === 0) {
      if (this.dsq.length >= 12) { var empty = null; for (i = 0; i < this.dsq.length && !empty; i++) if (!this.alive(this.dsq[i])) empty = this.dsq[i]; if (!empty) return 0; sq = empty; sq.members = []; }
      else { sq = { id: this.nextDsq(), members: [], room: 0, auto: false, cell: -1, home: 0 }; this.dsq.push(sq); }
      sq.auto = false; sq.room = 0; sq.cell = -1;
    }
    for (i = 0; i < list.length; i++) {
      var u = list[i];
      if (u.dsq) { var old = null; for (var k = 0; k < this.dsq.length; k++) if (this.dsq[k].id === u.dsq) old = this.dsq[k];
        if (old) { var j = old.members.indexOf(u.id); if (j >= 0) old.members.splice(j, 1); } }
      u.dsq = sq ? sq.id : 0; u.guard = 0; this.microEnd(u, true);
      if (sq) sq.members.push(u.id);
      // новый отряд без приказа — стоит, где стоит; в отряд с приказом — к нему (кроме точки бойца)
      // в отряд с точкой — своё место у флажка (не в одну клетку со всеми)
      if (sq && !sq.auto && (sq.room || sq.cell >= 0) && !u.post) { if (sq.cell >= 0) { var sp = this.spotsNear(sq.cell, sq.members.length); if (sp.length) { u.post = sp[sp.length - 1]; this.goCell(u, u.post); } } else this.goRoom(u, sq.room, 0); }
      else if (!sq && !u.post && this.defManual) this.holdHere(u);
    }
    return list.length;
  };
  // Двери: защитник запирает и открывает любую целую дверь (не с врагом в проёме)
  Board.prototype.canDoor = function(team, i) {
    var d = this.doors[i];
    if (!d) return 'нет двери';
    if (team !== this.def) return 'дверями управляют защитники';
    if (this.over >= 0) return 'абордаж окончен';
    if (d.state === 'broken') return 'дверь выбита';
    if (d.state === 'open' && this.occupied(d)) return 'в проёме враг';
    return '';
  };
  Board.prototype.door = function(team, i) {
    if (this.canDoor(team, i) !== '') return false;
    var d = this.doors[i];
    // вскрытие не обнуляется: запереть заново не значит починить замок
    if (d.state === 'locked') this.setDoor(d, 'open');
    else this.setDoor(d, 'locked');
    return true;
  };
  // Сколько вскрывать: обычная дверь 5 с, броня и шлюз 10 с; заварена — вдвое дольше
  Board.prototype.breachNeed = function(d) { return BREACH * (d.k === 'door' ? 0.5 : 1) * (d.weld ? 2 : 1); };
  // Заварка: ближайший ремонтник корабля идёт к запертой двери и варит 6 с
  Board.prototype.canWeld = function(team, i) {
    var d = this.doors[i];
    if (!d) return 'нет двери';
    if (team !== this.def) return 'варят защитники';
    if (this.over >= 0) return 'абордаж окончен';
    if (d.state !== 'locked') return 'сначала запереть';
    if (d.weld) return 'уже заварена';
    var w = d.welder >= 0 ? this.c.agents[d.welder] : null;
    if (w && w.alive && w.job && w.job.kind === 'weld') return 'уже варят';
    if (!this.welderFor(d)) return 'нет свободного ремонтника';
    return '';
  };
  Board.prototype.welderFor = function(d) {
    var c = this.c, best = null, bd = 1e18;
    for (var i = 0; i < c.agents.length; i++) {
      var a = c.agents[i];
      if (!a.alive || a.team !== this.def || a.role !== 'fixer' || (a.job && (a.job.kind === 'weld' || a.job.kind === 'defend'))) continue;
      var dx = a.x - d.x, dy = a.y - d.y, dd = dx * dx + dy * dy;
      if (dd < bd) { bd = dd; best = a; }
    }
    return best;
  };
  Board.prototype.weld = function(team, i) {
    if (this.canWeld(team, i) !== '') return false;
    var d = this.doors[i], a = this.welderFor(d), c = this.c;
    c.releaseJob(a); c.claimCell(a, null);
    var p = this.doorSide(d, a);
    a.job = { kind: 'weld', door: i, room: this.ship.room[p[1] * this.W + p[0]] || 0 };
    a.goalRoom = a.job.room; a.goal = p; a.at = false; a.stuck = 0; a.lastD = 1e9; a.task = 'weld';
    a.weldT = 0; a.tgt = -1; a.wait = 0; a.face = null;
    d.welder = a.id; d.weldP = 0;
    this.msg('Ремонтник идёт заваривать дверь', this.def, 'gold');
    return true;
  };
  // Клетка у двери (не в проёме) — ближняя к человеку
  Board.prototype.doorSide = function(d, a) {
    var W = this.W, best = null, bd = 1e18, walk = this.c.walk;
    for (var j = 0; j < d.cells.length; j++) {
      for (var o = 0; o < 4; o++) {
        var x = d.cells[j] % W + (o === 0 ? 1 : o === 1 ? -1 : 0), y = Math.floor(d.cells[j] / W) + (o === 2 ? 1 : o === 3 ? -1 : 0);
        var k = y * W + x;
        if (x < 0 || y < 0 || x >= W || y >= this.ship.h || !walk[k] || this.doorAt[k] >= 0) continue;
        var dx = x + 0.5 - a.x, dy = y + 0.5 - a.y, dd = dx * dx + dy * dy;
        if (dd < bd) { bd = dd; best = [x, y]; }
      }
    }
    return best || [Math.floor(d.x), Math.floor(d.y)];
  };
  Board.prototype.weldThink = function(a, dt) {
    if (!a.job || a.job.kind !== 'weld') return;
    var d = this.doors[a.job.door];
    if (!d || d.state !== 'locked' || d.weld || this.over >= 0) { this.weldEnd(a, d); return; }
    // до ближайшей клетки проёма (у широкой бронедвери центр далеко)
    var W = this.W, dist = 1e9, dx = 0, dy = 0;
    for (var j = 0; j < d.cells.length; j++) {
      var cx = d.cells[j] % W + 0.5 - a.x, cy = Math.floor(d.cells[j] / W) + 0.5 - a.y, cd = Math.sqrt(cx * cx + cy * cy);
      if (cd < dist) { dist = cd; dx = cx; dy = cy; }
    }
    if (dist > 1.9 && !a.at) { this.step(a, dt, 2.2); return; }
    a.aim = turn(a.aim, Math.atan2(dy, dx), 6 * dt);
    a.mv += (0 - a.mv) * Math.min(1, dt * 6);
    a.fixAt = d.cells[0];
    a.weldT += dt; d.weldP = a.weldT / WELD;
    if (a.weldT >= WELD) {
      d.weld = 1;
      this.msg('Дверь заварена: вскрывать вдвое дольше', this.def, 'gold');
      this.weldEnd(a, d);
    }
  };
  Board.prototype.weldEnd = function(a, d) {
    a.job = null; a.fixAt = -1; a.task = 'post';
    if (d) { d.welder = -1; d.weldP = 0; }
    this.c.sendPost(a);
  };

  Board.prototype.alive = function(sq) {
    var n = 0; for (var i = 0; i < sq.members.length; i++) { var a = this.c.agents[sq.members[i]]; if (a && a.alive) n++; }
    return n;
  };

  // ---------------------------------------------------------------- бойцы
  // Решение бойца на шаг: цель, стрельба (в tick), движение, вскрытие двери
  Board.prototype.think = function(a, dt) {
    var c = this.c, W = this.W, here = Math.floor(a.y) * W + Math.floor(a.x);
    if (c.fire[here]) c.hurt(a, c.fire[here] * 0.1 * dt);
    if (!a.alive) return;
    a.dvx = 0; a.dvy = 0;
    if (a.job && a.job.kind === 'weld') { this.weldThink(a, dt); return; }
    // подготовка: штурмовики ждут в шлюзе (стреляют, если к ним пришли), никуда не идут
    if (this.prep > 0 && a.team === this.att) {
      var tp = this.tgtPos(a); if (tp) a.aim = turn(a.aim, Math.atan2(tp.y - a.y, tp.x - a.x), 7 * dt);
      a.mv += (0 - a.mv) * Math.min(1, dt * 6); return;
    }
    if (a.wait > 0) { a.wait -= dt; a.mv += (0 - a.mv) * Math.min(1, dt * 6); return; }
    var w = WPN[a.wpn] || WPN.rifle;
    var tg = this.tgtPos(a);
    var engaged = tg && tg.d <= w.range * 0.8;
    if (tg) a.aim = turn(a.aim, Math.atan2(tg.y - a.y, tg.x - a.x), 7 * dt);
    // вскрытие двери
    if (a.breach >= 0) {
      var d = this.doors[a.breach];
      if (!d || d.state !== 'locked') { a.breach = -1; }
      else if (!engaged) {
        // вскрывает один (лучший) — толпа у двери быстрее не сделает
        if (d.tickAt !== this.c.t || a.eng) { if (d.tickAt !== this.c.t) d.breach += dt * (a.eng ? 2 : 1); else d.breach += dt; d.tickAt = this.c.t; }
        d.by = a.id;
        a.aim = turn(a.aim, Math.atan2(d.y - a.y, d.x - a.x), 6 * dt);
        a.mv += (0 - a.mv) * Math.min(1, dt * 6); a.phase = (a.phase + dt * 4) % 6.28;
        if (d.breach >= this.breachNeed(d)) { this.setDoor(d, 'broken'); d.weld = 0; this.msg((d.k === 'lock' ? 'Шлюзовая' : d.k === 'blast' ? 'Бронедверь' : 'Дверь') + ' вскрыта', this.att, 'gold'); this.ev.booms.push({ t: c.t, x: d.x, y: d.y, r: 2.2 }); }
        return;
      }
    }
    // «в бою» для повадок — цель в дальности (стреляет), а не только ближе 0,8 дальности: иначе боец на краю выходит из укрытия
    if (tg && tg.d <= w.range) a.engT = this.t; else a.inCov = false;
    // точка игрока: бежит туда и под огнём, стреляя на ходу
    if (a.post && !a.at) { this.moveFire(a, dt, (tg ? 1.4 : 2.6) * w.spd, tg); return; }
    // повадки в бою: укрытие, натиск, рывок из коридора
    if (!a.post) {
      if (engaged && this.micro(a, tg, w, dt)) return;
      if (a.og && this.t - (a.engT || -99) > MICRO_END) this.microEnd(a);
      else if (a.og && !a.at) { this.moveFire(a, dt, 1.4 * w.spd, tg); return; }
    }
    if (engaged) {
      // в бою: стоит и стреляет; цель у края дальности — подтягивается шагом
      a.mv += (0 - a.mv) * Math.min(1, dt * 6);
      if (tg.d > w.range * 0.6 && !a.at) this.step(a, dt, 0.8 * w.spd);
      return;
    }
    if (a.at) {
      a.mv += (0 - a.mv) * Math.min(1, dt * 6);
      // в отсеке остались враги вне выстрела — сблизиться (иначе стоят по углам большого зала)
      a.push = (a.push || 0) - dt;
      if (a.push <= 0 && !a.post && !a.og && !this.loose(a)) { a.push = 1 + this.R() * 0.5; this.closeIn(a); }    // на точке — держит её, не сходит
      return;
    }
    this.step(a, dt, (tg ? 1.4 : 2.6) * w.spd);
  };
  Board.prototype.closeIn = function(a) {
    var c = this.c, sh = this.ship, W = this.W, n = sh.room[Math.floor(a.y) * W + Math.floor(a.x)], s = n && this.rs[n];
    if (!s || !s.cnt[1 - a.team]) return;
    var best = null, bd = 1e18;
    for (var i = 0; i < c.agents.length; i++) {
      var b = c.agents[i];
      if (!b.alive || b.team === a.team || sh.room[Math.floor(b.y) * W + Math.floor(b.x)] !== n) continue;
      var dx = b.x - a.x, dy = b.y - a.y, d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = b; }
    }
    if (!best) return;
    var w = WPN[a.wpn] || WPN.rifle;
    if (bd < w.range * w.range * 0.5 && this.los(a.x, a.y, best.x, best.y)) return;
    // точка на полпути к врагу, на полу этого отсека
    var tx = Math.floor((a.x + best.x) / 2), ty = Math.floor((a.y + best.y) / 2);
    if (!c.walk[ty * W + tx] || sh.room[ty * W + tx] !== n) { tx = Math.floor(best.x); ty = Math.floor(best.y); }
    a.goalRoom = n; a.goal = [tx, ty]; a.at = false; a.stuck = 0; a.lastD = 1e9;
  };
  // ---- повадки в бою
  // Боец под приказом игрока (отряд с приказом или точка) — повадки только в пределах приказа
  Board.prototype.ordered = function(a) {
    if (a.post || this.loose(a)) return true;           // без отряда — держит место: повадки только в своём отсеке
    var q = a.team === this.att ? (a.sq && this.squads[a.sq - 1]) : (a.dsq && this.dsq[a.dsq - 1]);
    return !!(q && !q.auto);
  };
  // Решить, куда сместиться в бою; true — боец в пути к своему месту (ход сделан)
  Board.prototype.micro = function(a, tg, w, dt) {
    var st = STYLE[a.wpn];
    if (st && this.t >= (a.mT || 0)) {
      a.mT = this.t + st.every * (0.8 + this.R() * 0.4);
      var cell = -1, sh = this.ship, W = this.W, here = Math.floor(a.y) * W + Math.floor(a.x);
      // приказ игрока: не уходить из отсека приказа (коридор — так коридор)
      var keep = this.ordered(a) ? (a.og ? a.og.r : a.goalRoom) : -1;
      if (st.k === 'push') {
        if (tg.d > st.near + 0.4) cell = this.towards(a, tg, st.near, keep);
      } else if (st.k === 'crowd') {
        var rn = sh.room[here], rr = sh.roomByN[rn];
        if ((!rn || (rr && rr.t === 'airlock')) && tg.d > 3.5) cell = this.towards(a, tg, 3, keep);
      } else if (st.k === 'cover') {
        a.inCov = this.cover(tg.x, tg.y, a.x, a.y) < 1;
        if (!a.inCov) cell = this.coverCell(a, tg, st.r, w.range, keep);
      }
      if (cell >= 0 && cell !== here) this.microGo(a, cell);
    }
    if (a.og && !a.at) {
      // натиск: дошёл до своей дистанции — встаёт (цель могла сама подойти)
      if (st && st.k === 'push' && tg.d <= st.near) { a.goal = [Math.floor(a.x), Math.floor(a.y)]; a.at = true; return false; }
      this.moveFire(a, dt, (st && st.k === 'push' ? 1.1 : 1.5) * w.spd, tg);
      return true;
    }
    return false;
  };
  // Клетка пола на пути к цели: остановиться в near клетках от неё
  Board.prototype.towards = function(a, tg, near, keep) {
    var W = this.W, k = Math.max(0, 1 - near / Math.max(0.01, tg.d));
    var x = Math.floor(a.x + (tg.x - a.x) * k), y = Math.floor(a.y + (tg.y - a.y) * k);
    if (x < 0 || y < 0 || x >= W || y >= this.ship.h) return -1;
    var sp = this.spotsNear(y * W + x, 1); if (!sp.length) return -1;
    var c = sp[0][1] * W + sp[0][0];
    if (keep >= 0 && (this.ship.room[c] || 0) !== keep) return -1;
    if (a.team === this.att && !this.walkAtt[c]) return -1;
    return c;
  };
  // Укрытие: свободная клетка за мебелью (мебель между ней и целью), откуда цель видна и достаётся
  Board.prototype.coverCell = function(a, tg, R, range, keep) {
    var c = this.c, W = this.W, H = this.ship.h, walk = a.team === this.att ? this.walkAtt : c.walk;
    var sx = Math.floor(a.x), sy = Math.floor(a.y), s0 = sy * W + sx, best = -1, bs = 1e9;
    var q = [s0], dep = [0], seen = {}; seen[s0] = 1;
    this.claim = this.claim || {};
    for (var h = 0; h < q.length; h++) {
      var k = q[h], x = k % W, y = (k - x) / W, d = dep[h];
      if (d > 0 && (keep < 0 || (this.ship.room[k] || 0) === keep)) {
        var o = c.cellHead[k], cl = this.claim[k], ca = cl != null && c.agents[cl];
        var free = (o === -1 || o === a.id) && !(ca && ca !== a && ca.alive && ca.og);
        if (free) {
          var px = x + 0.5, py = y + 0.5, dx = tg.x - px, dy = tg.y - py, dd = Math.sqrt(dx * dx + dy * dy);
          if (dd <= range * 0.95 && dd > 1.5 && this.cover(tg.x, tg.y, px, py) < 1 && this.los(px, py, tg.x, tg.y)) {
            var sc = d + Math.abs(dd - 6) * 0.4;
            if (sc < bs) { bs = sc; best = k; }
          }
        }
      }
      if (d >= R) continue;
      for (var o4 = 0; o4 < 4; o4++) {
        var nx = x + (o4 === 0 ? 1 : o4 === 1 ? -1 : 0), ny = y + (o4 === 2 ? 1 : o4 === 3 ? -1 : 0), nk = ny * W + nx;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H || seen[nk] || !walk[nk] || this.doorAt[nk] >= 0) continue;
        seen[nk] = 1; q.push(nk); dep.push(d + 1);
      }
    }
    return best;
  };
  // Сместиться на клетку боя; приказ (куда шёл) запоминается и вернётся, когда бой стихнет
  Board.prototype.microGo = function(a, cell) {
    if (!a.og) a.og = { g: a.goal, r: a.goalRoom };
    this.claim = this.claim || {};
    if (a.mc != null && this.claim[a.mc] === a.id) delete this.claim[a.mc];
    a.mc = cell; this.claim[cell] = a.id;
    var x = cell % this.W;
    a.goal = [x, (cell - x) / this.W]; a.goalRoom = this.ship.room[cell] || 0; a.at = false; a.stuck = 0; a.lastD = 1e9;
  };
  // Бой стих (или пришёл новый приказ — keep=false): назад к приказу
  Board.prototype.microEnd = function(a, drop) {
    if (a.mc != null && this.claim && this.claim[a.mc] === a.id) delete this.claim[a.mc];
    a.mc = null; a.inCov = false;
    var og = a.og; a.og = null;
    if (!og || drop) return;
    if (og.g) { a.goal = og.g; a.goalRoom = og.r; a.at = false; a.stuck = 0; a.lastD = 1e9; }
  };
  // Новая цель хода от ИИ: если боец сейчас занят в бою — запомнить на потом
  Board.prototype.aiGoal = function(a, room, p) {
    if (a.og) { a.og = { g: p, r: room }; return; }
    a.goalRoom = room; a.goal = p; a.at = false; a.stuck = 0; a.lastD = 1e9;
  };
  // Идти и стрелять: ноги — по ходу, ствол — на цель
  Board.prototype.moveFire = function(a, dt, sp, tg) {
    var aim0 = a.aim;
    this.step(a, dt, sp);
    if (tg) a.aim = turn(aim0, Math.atan2(tg.y - a.y, tg.x - a.x), 7 * dt);
  };
  Board.prototype.step = function(a, dt, sp) {
    var nc = this.c.nav(a, dt, sp);
    if (nc >= 0 && a.team === this.att && !this.walkAtt[nc]) {
      // упёрся в запертую дверь — вскрывать
      var di = this.doorAt[nc];
      if (di >= 0 && this.doors[di].state === 'locked') { a.breach = di; a.dvx = 0; a.dvy = 0; }
    }
  };
  // Где цель бойца (боец, турель или ничего)
  Board.prototype.tgtPos = function(a) {
    if (a.tgt < 0) return null;
    var x, y;
    if (a.tgt >= 100000) { var tu = this.turrets[a.tgt - 100000]; if (!tu || tu.dead) { a.tgt = -1; return null; } x = tu.x; y = tu.y; }
    else { var b = this.c.agents[a.tgt]; if (!b || !b.alive) { a.tgt = -1; return null; } x = b.x; y = b.y; }
    var dx = x - a.x, dy = y - a.y;
    return { x: x, y: y, d: Math.sqrt(dx * dx + dy * dy) };
  };

  // Луч по клеткам: стены, глухие машины и запертые двери закрывают
  Board.prototype.los = function(x0, y0, x1, y1) {
    var W = this.W, cx = Math.floor(x0), cy = Math.floor(y0), ex = Math.floor(x1), ey = Math.floor(y1);
    var dx = x1 - x0, dy = y1 - y0, sx = dx > 0 ? 1 : -1, sy = dy > 0 ? 1 : -1;
    var tdx = dx !== 0 ? Math.abs(1 / dx) : 1e9, tdy = dy !== 0 ? Math.abs(1 / dy) : 1e9;
    var tmx = dx !== 0 ? (dx > 0 ? (cx + 1 - x0) : (x0 - cx)) * tdx : 1e9;
    var tmy = dy !== 0 ? (dy > 0 ? (cy + 1 - y0) : (y0 - cy)) * tdy : 1e9;
    for (var g = 0; g < 64 && (cx !== ex || cy !== ey); g++) {
      if (tmx < tmy) { tmx += tdx; cx += sx; } else { tmy += tdy; cy += sy; }
      if (cx === ex && cy === ey) break;
      var c = cy * W + cx;
      if (!this.clear[c]) return false;
      var di = this.doorAt[c]; if (di >= 0 && this.doors[di].state === 'locked') return false;
    }
    return true;
  };
  // Укрытие у цели: мебель на линии в последних полутора клетках
  Board.prototype.cover = function(x0, y0, x1, y1) {
    var dx = x0 - x1, dy = y0 - y1, L = Math.sqrt(dx * dx + dy * dy) || 1, sh = this.ship;
    for (var k = 0.6; k <= 1.6; k += 0.5) {
      var x = Math.floor(x1 + dx / L * k), y = Math.floor(y1 + dy / L * k);
      if (x >= 0 && y >= 0 && x < this.W && y < sh.h && sh.prop[y * this.W + x] === 1) return 0.5;
    }
    return 1;
  };
  // Поиск цели: ближайший враг в радиусе дальности и на линии огня (по сетке экипажа)
  Board.prototype.findTarget = function(a, range) {
    var c = this.c, W = this.W, H = this.ship.h, head = c.cellHead, next = c.nextIn;
    // приказ игрока «огонь по нему» — первым, если достаёт и видит
    if (a.focus >= 0) {
      var fo = c.agents[a.focus];
      if (!fo || !fo.alive || fo.team === a.team || fo.gone) a.focus = -1;
      else { var fx = fo.x - a.x, fy = fo.y - a.y; if (fx * fx + fy * fy <= range * range && this.los(a.x, a.y, fo.x, fo.y)) return a.focus; }
    }
    var ax = Math.floor(a.x), ay = Math.floor(a.y), R = Math.ceil(range), best = -1, bd = 1e9, cand = [];
    for (var y = Math.max(0, ay - R); y <= Math.min(H - 1, ay + R); y++) {
      for (var x = Math.max(0, ax - R); x <= Math.min(W - 1, ax + R); x++) {
        for (var j = head[y * W + x]; j !== -1; j = next[j]) {
          var b = c.agents[j]; if (!b || !b.alive || b.team === a.team) continue;
          var dx = b.x - a.x, dy = b.y - a.y, d = dx * dx + dy * dy;
          if (d > range * range) continue;
          // бойцы важнее безоружного экипажа
          var armed = b.wpn ? 1 : 2.2;
          cand.push(d * armed, j);
        }
      }
    }
    // атакующим — ещё и турели
    if (a.team === this.att) {
      for (var t = 0; t < this.turrets.length; t++) {
        var tu = this.turrets[t]; if (tu.dead) continue;
        var tx = tu.x - a.x, ty = tu.y - a.y, td = tx * tx + ty * ty;
        if (td <= range * range) cand.push(td * 0.9, 100000 + t);
      }
    }
    for (var tries = 0; tries < 4 && cand.length; tries++) {
      var bi = 0;
      for (var k = 2; k < cand.length; k += 2) if (cand[k] < cand[bi]) bi = k;
      var id = cand[bi + 1], px, py;
      if (id >= 100000) { px = this.turrets[id - 100000].x; py = this.turrets[id - 100000].y; }
      else { px = c.agents[id].x; py = c.agents[id].y; }
      if (this.los(a.x, a.y, px, py)) return id;
      cand.splice(bi, 2);
    }
    return -1;
  };

  // ---------------------------------------------------------------- шаг боя
  Board.prototype.tick = function(dt) {
    var c = this.c, ag = c.agents, i, a;
    this.t += dt;
    if (this.alarmCd > 0) this.alarmCd -= dt;
    if (this.prep > 0) {
      this.prep = Math.max(0, this.prep - dt);
      if (this.prep === 0) { this.msg('Штурм! Шлюз вскрывают', this.att, 'gold'); this.msg('Штурм начался — враг вскрывает шлюз', this.def, 'bad'); }
    }
    // отряд игрока без приказа: ждал свой срок — ведёт ИИ (к мостику)
    for (var si = 0; si < this.squads.length; si++) {
      var wq = this.squads[si]; if (!(wq.wait > 0)) continue;
      wq.wait = Math.max(0, wq.wait - dt);
      if (wq.wait === 0 && !wq.auto && wq.room === wq.land && this.alive(wq)) { wq.auto = true; this.msg('Отряд ' + wq.id + ' без приказа — идёт к мостику сам', this.att, 'gold'); }
    }
    this.ventCd[0] = Math.max(0, this.ventCd[0] - dt); this.ventCd[1] = Math.max(0, this.ventCd[1] - dt);
    var dmgK = [this.armoryK(0), this.armoryK(1)];
    // стрельба бойцов (на подготовке шлюз ещё не вскрыт: штурмовики в стыковочном рукаве — огня нет)
    for (i = 0; i < ag.length && !(this.prep > 0); i++) {
      a = ag[i]; if (!a.alive || !a.wpn) continue;
      if (a.team === this.def && !(a.job && a.job.kind === 'defend')) continue;
      var w = WPN[a.wpn];
      a.scan -= dt;
      if (a.scan <= 0) { a.scan = SCAN + this.R() * 0.15; a.tgt = this.findTarget(a, w.range); }
      a.cd -= dt;
      if (a.tgt < 0 || a.cd > 0) continue;
      var tg = this.tgtPos(a); if (!tg || tg.d > w.range) continue;
      if (Math.abs(((Math.atan2(tg.y - a.y, tg.x - a.x) - a.aim + 9.42) % 6.283) - 3.14) > 0.6) continue;   // ещё не навёл ствол
      a.cd = 1 / w.rof * (0.85 + this.R() * 0.3);
      var moving = Math.abs(a.vx) + Math.abs(a.vy) > 0.4;
      // абордажная команда — штурмовики: стреляют точнее в тесноте коридоров
      var p = w.acc * (a.team === this.att ? ASSAULT : 1) * Math.max(0.3, 1.1 - tg.d / w.range * 0.5) * this.cover(a.x, a.y, tg.x, tg.y) * (moving ? 0.7 : 1);
      var hit = this.R() < p;
      var dmg = hit ? w.dmg * dmgK[a.team] * (a.dmgK || 1) * (0.8 + this.R() * 0.4) : 0;
      this.shot(a.x, a.y, tg.x, tg.y, a.team, hit, a.wpn, dmg, a.tgt >= 100000 ? -1 : a.tgt);
      if (hit) {
        if (a.tgt >= 100000) this.hitTurret(this.turrets[a.tgt - 100000], dmg);
        else { var b = ag[a.tgt]; c.hurt(b, dmg); if (!b.alive) a.tgt = -1; }
        // граната: задевает и тех, кто рядом с целью (своих — тоже)
        if (w.splash) {
          for (var sj = 0; sj < ag.length; sj++) {
            var sb = ag[sj]; if (!sb.alive || sj === a.tgt) continue;
            var sdx = sb.x - tg.x, sdy = sb.y - tg.y;
            if (sdx * sdx + sdy * sdy < w.splash * w.splash) c.hurt(sb, dmg * 0.5);
          }
          this.ev.booms.push({ t: c.t, x: tg.x, y: tg.y, r: w.splash * 0.8 });
        }
      }
    }
    if (!(this.prep > 0)) this.turretsStep(dt);
    // лазарет: свои внутри лечатся
    this.medStep(dt);
    // раз в полсекунды: кто держит отсеки, цели, ИИ
    this.capT = (this.capT || 0) + dt;
    if (this.capT >= 0.5) { if (!(this.prep > 0)) this.capture(this.capT); this.capT = 0; }
    this.defT -= dt;
    if (this.defT <= 0) { this.defT = 1; this.defenders(); this.attackers(); }
    this.visT -= dt;
    if (this.visT <= 0) { this.visT = 0.5; this.sight(); }
    this.chargeStep(dt);
    // сварщик погиб или ушёл — дверь снова свободна для заварки
    for (i = 0; i < this.doors.length; i++) {
      var dw = this.doors[i]; if (dw.welder < 0) continue;
      var wa = ag[dw.welder];
      if (!wa || !wa.alive || !wa.job || wa.job.kind !== 'weld' || wa.job.door !== i) { dw.welder = -1; dw.weldP = 0; }
    }
    // старые события
    var t = c.t;
    if (this.ev.shots.length > 400) this.ev.shots.splice(0, 200);
    while (this.ev.shots.length && t - this.ev.shots[0].t > 1.5) this.ev.shots.shift();
    while (this.ev.booms.length && t - this.ev.booms[0].t > 3) this.ev.booms.shift();
    while (this.ev.vents.length && t - this.ev.vents[0].t > 4) this.ev.vents.shift();
  };
  // Выстрел для экрана. Промах летит дальше цели — до стены (там искры и подпалина);
  // d — урон (цифры над целью), ti — в кого (−1 — турель)
  Board.prototype.shot = function(x0, y0, x1, y1, team, hit, wpn, d, ti) {
    var R = this.R, mx = hit ? 0 : (R() - 0.5) * 2.4, my = hit ? 0 : (R() - 0.5) * 2.4, wall = 0;
    if (!hit) {
      var ex = x1 + mx, ey = y1 + my, dx = ex - x0, dy = ey - y0, L = Math.sqrt(dx * dx + dy * dy) || 1, W = this.W, H = this.ship.h;
      dx /= L; dy /= L;
      // шагом в четверть клетки от стрелка: первая стена или запертая дверь; не дальше 10 клеток за цель
      // (турель стоит внутри своей глухой машины — пока болт не вышел на открытое место, стены не в счёт)
      for (var k = 0.5, kmax = L + 10, out = false; k <= kmax; k += 0.25) {
        var cx = Math.floor(x0 + dx * k), cy = Math.floor(y0 + dy * k);
        if (cx < 0 || cy < 0 || cx >= W || cy >= H) { k -= 0.25; break; }
        var ci = cy * W + cx, di = this.doorAt[ci];
        var shut = !this.clear[ci] || (di >= 0 && this.doors[di].state === 'locked');
        if (!shut) { out = true; continue; }
        if (out) { wall = 1; k -= 0.12; break; }
      }
      x1 = x0 + dx * Math.min(k, kmax); y1 = y0 + dy * Math.min(k, kmax); mx = 0; my = 0;
    }
    this.ev.shots.push({ t: this.c.t, x0: x0, y0: y0, x1: x1 + mx, y1: y1 + my, team: team, hit: hit, w: wpn, d: hit ? Math.round(d || 0) : 0, ti: ti == null ? -1 : ti, wall: wall });
  };
  Board.prototype.armoryK = function(team) {
    // арсенал: +15% тому, кто его держит
    var any = false, att = false;
    for (var k in this.rs) if (this.rs[k].t === 'armory') { any = true; if (this.rs[k].held) att = true; }
    if (!any) return 1;
    return (team === this.att) === att ? 1.15 : 1;
  };
  Board.prototype.hitTurret = function(tu, dmg) {
    if (tu.dead) return;
    tu.hp -= dmg;
    if (tu.hp <= 0) { tu.dead = true; tu.hp = 0; this.ev.booms.push({ t: this.c.t, x: tu.x, y: tu.y, r: 1.6 }); this.msg('Турель уничтожена', this.att, 'gold'); }
  };
  Board.prototype.turretsStep = function(dt) {
    if (this.heldType('power')) return;          // энергоузел у врага — турели молчат
    var c = this.c;
    for (var i = 0; i < this.turrets.length; i++) {
      var tu = this.turrets[i]; if (tu.dead) continue;
      tu.cd -= dt;
      tu.scan = (tu.scan || 0) - dt;
      if (tu.scan <= 0) {
        tu.scan = 0.5;
        tu.tgt = this.findTarget({ x: tu.x, y: tu.y, team: this.def }, TURRET.range);
        if (tu.tgt >= 100000) tu.tgt = -1;
      }
      var b = tu.tgt >= 0 ? c.agents[tu.tgt] : null;
      if (!b || !b.alive) { tu.tgt = -1; continue; }
      tu.aim = turn(tu.aim, Math.atan2(b.y - tu.y, b.x - tu.x), 4 * dt);
      if (tu.cd > 0) continue;
      tu.cd = 1 / TURRET.rof;
      var d = Math.sqrt((b.x - tu.x) * (b.x - tu.x) + (b.y - tu.y) * (b.y - tu.y));
      var hit = this.R() < TURRET.acc * Math.max(0.4, 1.1 - d / TURRET.range * 0.5) * this.cover(tu.x, tu.y, b.x, b.y);
      var tdmg = hit ? TURRET.dmg * (0.85 + this.R() * 0.3) : 0;
      this.shot(tu.x, tu.y, b.x, b.y, this.def, hit, 'turret', tdmg, tu.tgt);
      tu.fireAt = c.t;
      if (hit) c.hurt(b, tdmg);
    }
  };
  Board.prototype.medStep = function(dt) {
    var c = this.c, sh = this.ship, W = this.W;
    // медик в бою: лечит раненого рядом (3 клетки), пока сам не стреляет
    for (var mi = 0; mi < c.agents.length; mi++) {
      var md = c.agents[mi]; if (!md.alive || !md.medicU || md.tgt >= 0) continue;
      for (var mj = 0; mj < c.agents.length; mj++) {
        var pt = c.agents[mj]; if (!pt.alive || pt.team !== md.team || pt.hp >= pt.hpMax || mj === mi) continue;
        var mdx = pt.x - md.x, mdy = pt.y - md.y;
        if (mdx * mdx + mdy * mdy < 9) { pt.hp = Math.min(pt.hpMax, pt.hp + 4 * dt); break; }
      }
    }
    for (var i = 0; i < c.agents.length; i++) {
      var a = c.agents[i]; if (!a.alive || a.hp >= a.hpMax) continue;
      var n = sh.room[Math.floor(a.y) * W + Math.floor(a.x)], s = n && this.rs[n];
      if (s && s.t === 'medbay' && this.heldBy(n) === a.team) a.hp = Math.min(a.hpMax, a.hp + 2 * dt);
    }
  };

  // Кто держит отсеки: одни атакующие 6 с — отсек их; одни защитники 6 с — отбит
  Board.prototype.capture = function(dt) {
    var c = this.c, sh = this.ship, W = this.W, k, s;
    for (k in this.rs) { this.rs[k].cnt[0] = 0; this.rs[k].cnt[1] = 0; }
    for (var i = 0; i < c.agents.length; i++) {
      var a = c.agents[i]; if (!a.alive) continue;
      var n = sh.room[Math.floor(a.y) * W + Math.floor(a.x)];
      if (n && this.rs[n]) this.rs[n].cnt[a.team]++;
    }
    var att = this.att, def = this.def;
    if (this.over >= 0) return;
    for (k in this.rs) {
      s = this.rs[k];
      var A = s.cnt[att], D = s.cnt[def];
      if (A && !D) {
        s.back = 0;
        if (!s.held) { s.hold += dt; if (s.hold >= CAPTURE) { s.held = true; s.hold = CAPTURE; this.onHeld(s, true); } }
      } else if (D && !A) {
        s.hold = Math.max(0, s.hold - dt * 2);
        if (s.held) { s.back += dt; if (s.back >= RETAKE) { s.held = false; s.back = 0; s.hold = 0; this.onHeld(s, false); } }
      }
    }
    // мостик: удержание
    var b = this.bridge && this.rs[this.bridge];
    if (b && b.held && !b.cnt[def] && b.cnt[att]) {
      this.bridgeT += dt;
      if (this.bridgeT >= this.holdNeed && this.over < 0) { this.over = 1; this.why = 'captured'; this.msg('Мостик удержан — корабль захвачен!', att, 'gold'); }
    }
    // атакующих не осталось — абордаж отбит
    if (this.over < 0 && this.started && !this.inFlight) {
      var left = 0;
      for (i = 0; i < c.agents.length; i++) if (c.agents[i].alive && c.agents[i].team === att) left++;
      if (!left) { this.over = 0; this.why = 'repelled'; this.msg('Абордаж отбит', def, 'gold'); this.end(); }
    }
  };
  var ROOM_EFF = { shield: 'щиты погашены', engine: 'двигатели заглушены', hyper: 'прыжок заглушён', hangar: 'ангар не выпускает машины',
                   comms: 'тревога снята', power: 'турели обесточены', cic: 'виден весь корабль', armory: 'урон +15%',
                   medbay: 'лечение своих', pumps: 'продувка отсеков', gun: 'орудие молчит', pdgun: 'пост ПВО молчит', bridge: 'удержание мостика' };
  Board.prototype.onHeld = function(s, held) {
    var e = ROOM_EFF[s.t];
    if (held) {
      this.msg('Захвачен: ' + s.r.name + (e ? ' — ' + e : ''), this.att, 'gold');
      if (s.t === 'comms' && this.alarm) this.setAlarm(false);
    } else {
      this.msg('Отбит: ' + s.r.name, this.def, 'gold');
      if (s.n === this.bridge) this.bridgeT = 0;        // удержание начинается заново
    }
  };
  // Кого видит абордажная команда (защитники и экипаж): на линии огня у своих или всё — с тактическим центром
  Board.prototype.sight = function() {
    var c = this.c, ag = c.agents, n = ag.length, all = this.heldType('cic');
    if (this.vis.length < n) this.vis = new Uint8Array(n + 64);
    var own = [];
    for (var i = 0; i < n; i++) if (ag[i].alive && ag[i].team === this.att) own.push(ag[i]);
    for (i = 0; i < n; i++) {
      var b = ag[i];
      if (!b.alive || b.team === this.att) { this.vis[i] = 1; continue; }
      if (all) { this.vis[i] = 1; continue; }
      var v = 0;
      for (var j = 0; j < own.length && !v; j++) {
        var a = own[j], dx = b.x - a.x, dy = b.y - a.y;
        if (dx * dx + dy * dy < 18 * 18 && this.los(a.x, a.y, b.x, b.y)) v = 1;
      }
      this.vis[i] = v;
    }
  };

  // ---------------------------------------------------------------- ИИ
  // Защитники: часть держит мостик и реактор, остальные идут на ближайших врагов
  Board.prototype.defenders = function() {
    var c = this.c, ag = c.agents, i, a, foes = [];
    for (i = 0; i < ag.length; i++) if (ag[i].alive && ag[i].team === this.att) foes.push(ag[i]);
    if (this.over >= 0) return;
    var guard = { }, gNeed = {};
    if (this.bridge) gNeed[this.bridge] = 6;
    if (this.reactor) gNeed[this.reactor] = 3;
    var bridgeHot = this.bridge && this.rs[this.bridge] && this.rs[this.bridge].cnt[this.att] > 0;
    for (i = 0; i < ag.length; i++) {
      a = ag[i];
      if (!a.alive || a.team !== this.def || !a.job || a.job.kind !== 'defend') continue;
      // отряд с приказом игрока — держит свой отсек
      var dq = a.dsq && this.dsq[a.dsq - 1];
      if (a.post) { a.guard = 0; continue; }                // держит точку (приказ отряду или бойцу)
      if (this.loose(a)) { a.guard = 0; continue; }          // без отряда при обороне за игроком — держит место
      if (dq && !dq.auto && dq.room) { a.guard = 0; this.goRoom(a, dq.room, 6); continue; }
      if (dq && !dq.auto) { a.guard = 0; continue; }          // отряд игрока без приказа — стоит
      // охрана ключевых отсеков
      var g = a.guard;
      if (!g) {
        for (var gk in gNeed) if ((guard[gk] || 0) < gNeed[gk]) { g = +gk; break; }
        if (g && foes.length) { a.guard = g; }
      }
      if (a.guard) { guard[a.guard] = (guard[a.guard] || 0) + 1; this.goRoom(a, a.guard, 6); continue; }
      // охотники: к ближайшему врагу (по прямой), мостик под ударом — на мостик
      var tgtRoom = 0;
      if (bridgeHot) tgtRoom = this.bridge;
      else if (foes.length) {
        var best = null, bd = 1e18;
        for (var j = 0; j < foes.length; j++) { var dx = foes[j].x - a.x, dy = foes[j].y - a.y, d = dx * dx + dy * dy; if (d < bd) { bd = d; best = foes[j]; } }
        if (best) tgtRoom = this.ship.room[Math.floor(best.y) * this.W + Math.floor(best.x)] || this.nearRoom(best.x, best.y);
      }
      if (tgtRoom) this.goRoom(a, tgtRoom, 3);
    }
  };
  // Свободные отряды атакующих (без приказа игрока) идут на мостик; мостик взят — держат его
  Board.prototype.attackers = function() {
    for (var i = 0; i < this.squads.length; i++) {
      var sq = this.squads[i]; if (!this.alive(sq)) continue;
      if (sq.auto && sq.room !== this.bridge && this.bridge) this.orderSquad(sq, this.bridge, true);
    }
  };
  // Идти в отсек (не дёргать, если уже идёт туда же или стоит в нём); every — с повтором раз в N с
  Board.prototype.goRoom = function(a, n, every) {
    var r = this.ship.roomByN[n]; if (!r) return;
    if (a.og ? a.og.r === n : a.goalRoom === n && (a.at || this.t - (a.goT || -99) < every)) return;
    var p = this.c.spotIn(r); if (!p) return;
    a.goT = this.t; this.aiGoal(a, n, p);
  };
  Board.prototype.nearRoom = function(x, y) {
    var sh = this.ship, W = this.W;
    for (var r = 1; r < 8; r++) for (var dy = -r; dy <= r; dy++) for (var dx = -r; dx <= r; dx++) {
      var cx = Math.floor(x) + dx, cy = Math.floor(y) + dy;
      if (cx < 0 || cy < 0 || cx >= W || cy >= sh.h) continue;
      var n = sh.room[cy * W + cx]; if (n) return n;
    }
    return 0;
  };

  // ---------------------------------------------------------------- действия
  // Заряд у реактора: реакторный зал взят, инженер внутри
  Board.prototype.canPlant = function() {
    if (!this.reactor || this.charge || this.over >= 0) return null;
    if (!this.rs[this.reactor].held) return 'сначала взять реакторный зал';
    var e = this.engIn(this.reactor, this.att);
    if (!e) return 'нужен инженер в реакторном зале';
    return '';
  };
  Board.prototype.engIn = function(n, team) {
    var c = this.c, sh = this.ship, W = this.W;
    for (var i = 0; i < c.agents.length; i++) {
      var a = c.agents[i];
      if (!a.alive || a.team !== team) continue;
      var ok = team === this.att ? a.eng : (a.role === 'fixer' || a.wpn);
      if (ok && sh.room[Math.floor(a.y) * W + Math.floor(a.x)] === n) return a;
    }
    return null;
  };
  Board.prototype.plant = function(team) {
    if (team !== this.att || this.canPlant() !== '') return false;
    this.charge = { plant: PLANT, left: FUSE, defuse: 0, armed: false };
    this.msg('Инженер ставит заряд у реактора…', this.att, 'gold');
    return true;
  };
  Board.prototype.chargeStep = function(dt) {
    var ch = this.charge; if (!ch || this.over >= 0) return;
    var rs = this.rs[this.reactor];
    if (!ch.armed) {
      if (!this.engIn(this.reactor, this.att)) { this.charge = null; this.msg('Заряд не поставлен: инженер ушёл или погиб', this.att, 'bad'); return; }
      ch.plant -= dt;
      if (ch.plant <= 0) { ch.armed = true; this.msg('Заряд у реактора! ' + FUSE + ' с до взрыва', this.att, 'bad'); }
      return;
    }
    ch.left -= dt;
    // защитники снимают: в зале их боец или инженер и ни одного атакующего
    if (rs.cnt[this.att] === 0 && this.engIn(this.reactor, this.def)) {
      ch.defuse += dt;
      if (ch.defuse >= DEFUSE) { this.charge = null; this.msg('Заряд у реактора снят', this.def, 'gold'); return; }
    } else ch.defuse = Math.max(0, ch.defuse - dt);
    if (ch.left <= 0) { this.over = 2; this.why = 'reactor'; this.msg('Реактор взорван!', this.att, 'bad'); }
  };
  // Продувка: насосная своя — отсек под удар (все внутри, свои и чужие)
  Board.prototype.canVent = function(team) {
    if (this.prep > 0) return 'идёт подготовка к штурму';
    var has = false;
    for (var k in this.rs) if (this.rs[k].t === 'pumps') { has = true; if (this.heldBy(+k) !== team) return 'насосная не наша'; }
    if (!has) return 'насосной нет';
    if (this.ventCd[team] > 0) return 'насосы готовы через ' + Math.ceil(this.ventCd[team]) + ' с';
    return '';
  };
  Board.prototype.vent = function(team, n) {
    if (this.canVent(team) !== '' || !this.rs[n]) return false;
    var c = this.c, sh = this.ship, W = this.W, hit = 0;
    for (var i = 0; i < c.agents.length; i++) {
      var a = c.agents[i]; if (!a.alive) continue;
      if (sh.room[Math.floor(a.y) * W + Math.floor(a.x)] === n) { c.hurt(a, VENT_DMG); hit++; }
    }
    this.ventCd[team] = VENT_CD;
    this.ev.vents.push({ t: c.t, n: n });
    this.msg('Продувка: ' + this.rs[n].r.name + ' (' + hit + ' под ударом)', team, 'gold');
    return true;
  };
  // Конец абордажа: защитники — на свои посты, тревога снимается
  Board.prototype.end = function() {
    for (var pi = 0; pi < this.c.agents.length; pi++) { this.c.agents[pi].post = null; this.c.agents[pi].focus = -1; this.microEnd(this.c.agents[pi], true); }
    this.claim = {};   // точки и цели — только на этот бой
    var c = this.c;
    for (var k in this.rs) { this.rs[k].held = false; this.rs[k].hold = 0; this.rs[k].back = 0; }
    this.charge = null;
    if (this.alarm) this.setAlarm(false);
    for (var i = 0; i < c.agents.length; i++) {
      var a = c.agents[i];
      if (a.alive && a.team === this.def && a.job && a.job.kind === 'defend') { a.job = null; a.guard = 0; a.hunt = false; if (a.stand) c.standGo(a); else c.sendPost(a); }
      else if (a.alive && a.job && a.job.kind === 'weld') this.weldEnd(a, this.doors[a.job.door]);
      a.dsq = 0;
    }
  };

  // Сводка для экрана
  Board.prototype.summary = function() {
    var c = this.c, out = { att: 0, def: 0, crew: 0, sq: [], prep: this.prep > 0 ? Math.ceil(this.prep) : 0 };
    for (var i = 0; i < c.agents.length; i++) {
      var a = c.agents[i]; if (!a.alive) continue;
      if (a.team === this.att) out.att++;
      else if (a.job && a.job.kind === 'defend') out.def++;
      else out.crew++;
    }
    for (i = 0; i < this.squads.length; i++) { var oq = this.squads[i]; out.sq.push({ id: oq.id, n: this.alive(oq), room: oq.room, auto: oq.auto, c: oq.cell >= 0 ? oq.cell : -1, w: oq.wait > 0 && !oq.auto && oq.room === oq.land ? Math.ceil(oq.wait) : 0 }); }
    out.dsq = [];
    for (i = 0; i < this.dsq.length; i++) out.dsq.push({ id: this.dsq[i].id, n: this.alive(this.dsq[i]), room: this.dsq[i].room, auto: this.dsq[i].auto, c: this.dsq[i].cell >= 0 ? this.dsq[i].cell : -1 });
    return out;
  };

  return { Board: Board, WPN: WPN, FIG_WPN: FIG_WPN, TURRET: TURRET, ROOM_EFF: ROOM_EFF, KEYROOM: KEYROOM,
           CAPTURE: CAPTURE, PREP: PREP, BREACH: BREACH, FUSE: FUSE, PLANT: PLANT, WELD: WELD, DEFUSE: DEFUSE, RETAKE: RETAKE };
});
