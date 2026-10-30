// Космический бой 2.0: корабли снаружи, отсеки и экипаж внутри.
//
// Корабль — корпус (спрайт карты в честном масштабе) с орудиями на точках
// корпуса. У каждой пушки своя цель, которую выбирает игрок:
//   - 'auto'     — сама (по своему типу: ионная по щитам, тяжёлая по орудиям…);
//   - 'fighters' — по истребителям и бомбардировщикам;
//   - 'hull'     — по корпусу ближайшего врага (стороной к себе);
//   - 'sys'      — по системе корабля: двигатели, реактор, щиты, мостик, орудия, ангар;
//   - 'room'     — по конкретному отсеку.
// Пушка бьёт только в своём секторе обстрела (бортовые — на свой борт).
//
// Попадание: секторный щит (нос/правый борт/корма/левый борт) гасит урон,
// пробив — урон по корпусу и по отсеку в точке удара: поломка, пожар, гибель
// людей. Экипаж (shared/rt-crew.js) тушит и чинит; от целости отсека и людей на
// посту зависят ход, питание, щиты, точность и перезарядка каждой пушки.
// Реактор разбит — 60 с на спасение (починить до 25%), иначе взрыв.
//
// Характеристики корпусов — из ship_types старой игры (корпус ×3, щит сектора ×2).
// ES5, без зависимостей кроме rt-crew. Работает в браузере и в Node.

(function(root, factory) {
  var node = typeof module === 'object' && module.exports;
  var crew = node ? require('./rt-crew.js') : root.SWCrew;
  var board = node ? require('./rt-board.js') : root.SWBoard;
  var army = node ? require('./rt-army.js') : root.SWArmy;
  var api = factory(crew, board, army);
  if (node) module.exports = api;
  else root.SWSpace = api;
})(typeof self !== 'undefined' ? self : this, function(SWCrew, SWBoard, SWArmy) {
  'use strict';

  var TAU = Math.PI * 2, TICK = 0.1, BOLT = 4200;     // скорость болта, м/с

  // ---------------------------------------------------------------- орудия
  // dmg — за выстрел; sh/hull/sys — множители по щиту, корпусу, отсеку;
  // aim — доля попаданий точно в выбранный отсек (остальное — рядом).
  var GUNS = {
    heavy:  { name: 'Тяжёлый турболазер', short: 'ТТЛ', range: 7000, reload: 6, dmg: 18, acc: 0.8, accF: 0.06, sh: 1, hull: 1, sys: 1.1, fire: 0.45, aim: 0.65, fdmg: 400,
              about: 'Пробивает глубоко — достаёт до реактора. По истребителям почти не попадает.' },
    medium: { name: 'Турболазер', short: 'ТЛ', range: 5500, reload: 3.5, dmg: 9, acc: 0.82, accF: 0.16, sh: 1, hull: 1, sys: 0.9, fire: 0.3, aim: 0.55, fdmg: 120,
              about: 'Скорострельный, годится и по кораблям, и по бомбардировщикам.' },
    long:   { name: 'Дальнобойная пушка', short: 'ДП', range: 10000, reload: 8, dmg: 16, acc: 0.75, accF: 0.03, sh: 1, hull: 1, sys: 0.9, fire: 0.25, aim: 0.5, fdmg: 400,
              about: 'Бьёт дальше всех, но медленно.' },
    ion:    { name: 'Ионная пушка', short: 'ИОН', range: 6000, reload: 7, dmg: 16, acc: 0.8, accF: 0.04, sh: 2.6, hull: 0.5, sys: 1.6, fire: 0, stun: 5, aim: 0.6, fdmg: 60,
              about: 'Срывает щиты втрое быстрее и глушит отсек на 5 с. По корпусу — вполсилы, пожаров не даёт.' },
    pd:     { name: 'Турель ПВО', short: 'ПВО', range: 2200, reload: 0.7, dmg: 2.5, acc: 0.85, accF: 0.42, sh: 0.5, hull: 0.6, sys: 0.3, fire: 0.05, aim: 0.35, fdmg: 34,
              about: 'Против истребителей и бомбардировщиков. По кораблям — слабо.' }
  };
  // Системы для выбора цели: тип отсека → что это для игрока
  var SYS = [
    { id: 'engine',  name: 'Двигатели', types: ['engine', 'hyper'] },
    { id: 'reactor', name: 'Реактор',   types: ['reactor'] },
    { id: 'shield',  name: 'Щиты',      types: ['shield'] },
    { id: 'bridge',  name: 'Мостик',    types: ['bridge', 'cic', 'flight'] },
    { id: 'guns',    name: 'Орудия',    types: ['gun', 'pdgun'] },
    { id: 'hangar',  name: 'Ангар',     types: ['hangar', 'dock'] }
  ];
  // Броня отсеков: ядро реактора и мостик крепче
  var ARMOR = { reactor: 0.55, bridge: 0.75, shield: 0.85 };
  // Предел поломки отсека за одно попадание: реактор глубоко в броне — одним залпом его не выбить
  var ROOM_CAP = { reactor: 2.2, bridge: 18 };
  var REACTOR_FUSE = 90;     // реактор разбит — столько секунд до взрыва (экипаж успевает поднять до 25% — отбой)
  var SYS_BY = {}; SYS.forEach(function(s) { SYS_BY[s.id] = s; });
  // отсек → система (приказ «по отсеку» на другом корабле становится приказом по той же системе)
  function sysOfRoom(t) { for (var i = 0; i < SYS.length; i++) if (SYS[i].types.indexOf(t) >= 0) return SYS[i].id; return null; }
  // Приказ пушки, перенесённый на другой корабль: та же система (отсек → его система, иначе корпус)
  function carryTgt(t, foe, fromShip) {
    if (t.k === 'sys') return { k: 'sys', ship: foe.n, sys: t.sys };
    if (t.k === 'room') { var r = fromShip && fromShip.plan.roomByN[t.room], sy = r ? sysOfRoom(r.t) : null; return sy ? { k: 'sys', ship: foe.n, sys: sy } : { k: 'hull', ship: foe.n }; }
    return { k: 'hull', ship: foe.n };
  }

  // Корпуса — из ship_types старой игры
  var CLASS = {
    venator:    { troops: 60, guard: 12, hp: 1200, shield: 150, regen: 8, acc: 85, eva: 3, hangar: 3, move: 6, dmg: 120, craft: ['arc170', 'arc170', 'ywing'] },
    acclamator: { troops: 80, guard: 8, hp: 700,  shield: 150, regen: 8, acc: 80, eva: 5, hangar: 0, move: 7, dmg: 45, bal: 1.25 },
    munificent: { troops: 40, guard: 8, hp: 700,  shield: 150, regen: 8, acc: 80, eva: 5, hangar: 0, move: 7, dmg: 45 },
    providence: { troops: 60, guard: 12, hp: 1200, shield: 150, regen: 8, acc: 85, eva: 3, hangar: 3, move: 6, dmg: 120, craft: ['vulture', 'vulture', 'hyena'], bal: 1.5 },
    // guard — штатная охрана из экипажа: на абордаж не ходит, обороняет корабль;
    // troops — десант в трюме (бойцы абордажа и обороны);
    // craft — звенья по 4 машины; у самых больших ангаров число звеньев урезано до 6;
    // bal — множитель урона по прогонам ИИ против ИИ (равные по старой игре корпуса ≈ 50/50)
    rep_mandator:   { troops: 90, guard: 18, hp: 2400, shield: 300, regen: 15, acc: 85, eva: 1,  hangar: 6, move: 4,  dmg: 220, craft: ['arc170', 'arc170', 'ywing', 'arc170', 'ywing', 'arc170'] },
    rep_victory:    { troops: 60, guard: 12, hp: 1100, shield: 200, regen: 10, acc: 83, eva: 4,  hangar: 2, move: 6,  dmg: 130, craft: ['arc170', 'ywing'] },
    rep_valiant:    { troops: 40, guard: 8, hp: 850,  shield: 150, regen: 8,  acc: 82, eva: 5,  hangar: 0, move: 7,  dmg: 75 },
    rep_arquitens:  { troops: 20, guard: 6, hp: 620,  shield: 150, regen: 8,  acc: 80, eva: 10, hangar: 0, move: 8,  dmg: 55 },
    tantive:        { troops: 12, guard: 4, hp: 400,  shield: 150, regen: 8,  acc: 78, eva: 18, hangar: 0, move: 10, dmg: 45, bal: 1.2 },
    cis_subjugator: { troops: 90, guard: 18, hp: 2500, shield: 250, regen: 12, acc: 85, eva: 1,  hangar: 4, move: 4,  dmg: 210, craft: ['vulture', 'hyena', 'vulture', 'hyena'] },
    cis_lucrehulk:  { troops: 120, guard: 20, hp: 1900, shield: 200, regen: 10, acc: 82, eva: 2,  hangar: 8, move: 4,  dmg: 120, craft: ['vulture', 'vulture', 'hyena', 'vulture', 'vulture', 'hyena'] },
    cis_recusant:   { troops: 40, guard: 8, hp: 850,  shield: 150, regen: 8,  acc: 82, eva: 4,  hangar: 0, move: 7,  dmg: 70, bal: 1.1 },
    cis_diamond:    { troops: 50, guard: 8, hp: 650,  shield: 130, regen: 8,  acc: 80, eva: 8,  hangar: 0, move: 8,  dmg: 55, bal: 1.15 },
    hardcell:       { troops: 30, guard: 6, hp: 480,  shield: 150, regen: 8,  acc: 78, eva: 15, hangar: 0, move: 9,  dmg: 50 }
  };
  // Малые корабли — тоже из ship_types
  var CRAFT = {
    arc170:  { name: 'ARC-170',    role: 'fighter', hp: 90,  speed: 230, img: 'arc170', len: 14.2 },
    ywing:   { name: 'Y-wing',     role: 'bomber',  hp: 140, speed: 170, img: 'ywing',  len: 16 },
    vulture: { name: 'Стервятник', role: 'fighter', hp: 90,  speed: 250, img: 'vulture', len: 6.9 },
    hyena:   { name: 'Гиена',      role: 'bomber',  hp: 140, speed: 180, img: 'hyena',  len: 8.1 },
    // абордажный шаттл: до 12 бойцов; сбит — команда погибла
    shuttle: { name: 'Абордажный шаттл', role: 'shuttle', hp: 700, speed: 240, img: null, len: 18 }
  };
  // Абордаж: сколько бойцов принимают шлюзы цели (старая игра: малый 20, большой 30, флагман 36)
  function boardCap(sh) { return sh.len >= 1200 ? 36 : sh.len >= 700 ? 30 : 20; }
  var BOARD_GAP = 3000, BOARD_CD = 60, SHUTTLE_MAX = 12;
  // Притягивающий луч (исследование «Притягивающие лучи» в игре): держит вражеский корабль — тот почти
  // стоит, разворачивается медленно и его подтягивает к нам; в гиперпространство не уйти (база), абордаж —
  // и при поднятых щитах. Дальность — зазор между корпусами; держит hold с, потом перезарядка cd с
  var TRACTOR = { range: 4000, hold: 20, cd: 60, pull: 80, near: 1200 };
  var MUSTER_MAX = 75;      // десант собирается у шлюза не дольше (кто не добежал — остаётся на борту)
  // Авиакрыло корабля (wmode): 'auto' — взлетают, когда враг ближе WING_R или по кораблю бьют, стихло на WING_CALM с —
  // садятся в ангар (так же — пока хозяина нет в игре); 'out' — все в воздухе; 'dock' — на борт и не взлетают
  var WING_R = 9000, WING_CALM = 25, WING_MODES = { auto: 1, out: 1, dock: 1 };
  var WING_LEASH = 12000;   // дальше от своего корабля машины не уходят (кроме цели, которую дал игрок)

  // Дальность датчиков, м: у больших кораблей дальше (4–7 км по длине корпуса) + 1 км на единицу сонара.
  // Станция на орбите видит на SENS_STATION. Решение Артёма (26.10): орбита 30×30 км, при 6–10 км у кораблей
  // и 12 км у станции туман почти не показывался — враг виден, только когда подошёл.
  // Отдаётся наружу — карточки верфи и корабля пишут те же километры, что видит бой
  var SENS_STATION = 8000;
  function sensOf(lenM, visB) { return Math.max(4000, Math.min(7000, 4000 + (lenM || 0) * 2)) + (visB || 0) * 1000; }
  function shK(C) { return Math.max(0.35, Math.min(1.25, C.dmg / 120)); }
  function rng(seed) {
    var s = (seed >>> 0) || 1;
    return function() { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  }
  function wrap(a) { while (a > Math.PI) a -= TAU; while (a < -Math.PI) a += TAU; return a; }
  function turnTo(cur, to, step) { var d = wrap(to - cur); return Math.abs(d) <= step ? to : cur + (d > 0 ? step : -step); }

  // ---------------------------------------------------------------- бой
  function Battle(opts) {
    this.R = rng(opts.seed || 7);
    this.t = 0; this.ships = []; this.craft = []; this.pending = []; this.nextCraft = 1;
    this.musters = [];       // десант бежит к своему шлюзу на посадку в шаттлы
    this.ev = { shots: [], booms: [], shields: [], kills: [], boards: [], rams: [] };
    this.over = -1;          // сторона-победитель
    this.aiBoard = opts.aiBoard || [false, false];   // стороны, за которые абордаж решает ИИ
    this.boardT = 3;
    // туман войны: что видит каждая сторона (fog: false — видно всё)
    this.fog = opts.fog !== false;
    this.endless = !!opts.endless;     // орбита системы: бой не «кончается», корабли приходят и уходят
    // стороны: 0 — Республика, 1 — КНС, 2 — NPC (пираты у находки в Пустоте): враги всем, без абордажа
    this.vis = [{}, {}, {}]; this.visC = [{}, {}, {}]; this.last = [{}, {}, {}]; this.senseT = 0; this.sides = 2;
    var list = opts.ships || [];
    for (var i = 0; i < list.length; i++) this.addShip(list[i]);
  }

  // Спящий экипаж: корабль на орбите, которого бой ещё не коснулся. Ни тел, ни карт
  // проходимости — только отсеки с целостью 100 и ответы «всё исправно». Как только по кораблю
  // стреляют, идут на абордаж, смотрят внутрь или враг рядом — Battle.wake строит настоящий
  // SWCrew.Crew. Так система со ста кораблями на орбите не стоит сотни экипажей в памяти.
  function DormantCrew(plan, opts) {
    this.ship = plan; this.w = plan.w; this.h = plan.h; this.team = opts.team || 0; this.dormant = true;
    this.board = null; this.alertOn = !!opts.alert; this.t = 0; this.crewLost = opts.crewLost || 0;
    this.agents = []; this.burning = []; this.fire = {}; this.scorch = []; this.roomList = []; this.rooms = {};
    this.ev = { deaths: [], ignites: [], blasts: [], guns: [] };
    for (var i = 0; i < plan.rooms.length; i++) {
      var r = plan.rooms[i], st = { n: r.n, t: r.t, r: r, integ: 100, stun: 0, need: 0, fires: 0, anchor: null, staffed: 0, assigned: 0, fixers: 0, fighters: 0, firedAt: -99, runner: 0, spots: null };
      this.rooms[r.n] = st; this.roomList.push(st);
    }
    this.recount(opts);
  }
  // сколько людей будет на борту, когда корабль проснётся (для сводок и строки «экипаж»): посты отсеков —
  // как их заполняет SWCrew.Crew (казармы при поимённом десанте пусты), без погибших в прошлых боях,
  // плюс десант трюма и охрана. Раньше считался только десант: у спящего корабля «экипаж 8», а проснувшись — 181
  DormantCrew.prototype.recount = function(opts) {
    var roster = opts.roster || null, posts = 0, P = SWCrew && SWCrew.POST || {};
    for (var i = 0; i < this.roomList.length; i++) {
      var r = this.roomList[i].r;
      if (roster && (r.t === 'troops' || r.t === 'droids')) continue;
      var base = P[r.t] || 1;
      posts += Math.min(base * 3, base + Math.floor((r.area || r.w * r.h) / 140));
    }
    this.n = Math.max(0, posts - (opts.crewLost || 0)) + (roster ? roster.length : 0) + (opts.guards ? opts.guards.n : 0);
  };
  DormantCrew.prototype.step = function() {};
  DormantCrew.prototype.sysEff = function() { return 1; };
  DormantCrew.prototype.roomEff = function() { return 1; };
  DormantCrew.prototype.alive = function() { return this.n; };
  DormantCrew.prototype.gunFired = function() {};
  DormantCrew.prototype.damageRoom = function() {};
  DormantCrew.prototype.ignite = function() {};
  DormantCrew.prototype.blast = function() {};
  DormantCrew.prototype.releaseJob = function() {};
  DormantCrew.prototype.sendPost = function() {};
  DormantCrew.prototype.claimCell = function() {};
  DormantCrew.prototype.go = function() {};
  DormantCrew.prototype.spotIn = function() { return null; };
  DormantCrew.prototype.heldType = function() { return false; };

  // { cls, plan (SWShip.load), side, x, y, hd, figs, name, army, dormant }
  // army — что есть у корабля в игре (SWArmy.fromGame или типовой состав полигона):
  //   roster (бойцы трюма), hangar (машины), hpK/shK (целость), hpBonus/shBonus/dmgK
  //   (улучшения), crewLost (недобор экипажа). Без army на борту ни бойцов, ни машин.
  Battle.prototype.addShip = function(o) {
    var C = CLASS[o.cls] || CLASS.acclamator, plan = o.plan, A = o.army || {};
    var sh = {
      n: this.ships.length, id: o.id || (o.cls + '-' + this.ships.length), cls: o.cls, name: o.name || plan.name, side: o.side,
      plan: plan, len: plan.h * plan.cellM, wid: plan.w * plan.cellM,
      x: o.x || 0, y: o.y || 0, hd: o.hd || 0, v: 0, order: null, ai: o.ai !== false,
      hullMax: C.hp * 3, hull: C.hp * 3, shMax: C.shield * 1.6, sh: [C.shield * 1.6, C.shield * 1.6, C.shield * 1.6, C.shield * 1.6],
      // генератор щитов рассчитан на огонь корабля своего класса: у малых кораблей
      // восстановление и перекачка слабее, иначе их пушки не продавливают щит вовсе
      shHit: [0, 0, 0, 0], focus: -1, focusAuto: true, foeT: null, regen: C.regen * 0.35 * shK(C), xfer: 1.2 * shK(C), acc: C.acc / 100, eva: C.eva / 100,
      vmax: (C.move + (A.moveB || 0)) * 9, turn: 4 * Math.PI / 180, dead: false, deadAt: 0, crit: 0,
      // датчики: дальше у больших кораблей; выстрел выдаёт место на FLASH с
      sens: sensOf(plan.h * plan.cellM, A.visB), flash: -99,
      crew: null, crewOpts: { seed: (this.ships.length + 1) * 7717, figs: o.figs, figMap: o.figMap, alert: true, team: o.side,
                              roster: A.roster || [], figIds: o.figIds, kit: SWArmy ? SWArmy.kit : null, crewLost: A.crewLost || 0,
                              guards: C.guard ? { n: C.guard, kit: SWArmy ? SWArmy.kit(plan.faction === 'cis' ? 'cis_b1' : 'rep_dc15a') : null, hp: SWArmy && SWArmy.unit ? (SWArmy.unit(plan.faction === 'cis' ? 'cis_b1' : 'rep_dc15a') || [])[2] : 0 } : null },
      dormant: !!o.dormant, owner: o.owner || null, faction: o.faction || plan.faction,
      vehicles: (A.vehicles || []).slice(), gameId: A.id || null,
      figIds: o.figIds || null, boardCd: 0, inbound: 0, captured: -1, stands: o.stands || null,
      guns: [], eff: {}, hangar: (A.hangar || []).slice(), launchT: 4 + this.ships.length, sysCache: {},
      // ангар: bay — номера машин на борту (по порядку ангара в игре), bayHp — целость севших; крыло — wmode, wOut (в воздухе ли)
      bay: null, bayHp: {}, wmode: 'auto', wOut: false, wCalm: WING_CALM, wLost: 0, hurtT: -99, hurtBy: null,
      tractor: !!A.tractor, tb: null, tbReady: 0, heldBy: null
    };
    sh.crew = sh.dormant ? new DormantCrew(plan, sh.crewOpts) : new SWCrew.Crew(plan, sh.crewOpts);
    sh.bay = sh.hangar.map(function(_, i) { return i; });
    // орудия с секторами обстрела
    var main = 0, raw = 0;
    for (var g = 0; g < plan.mounts.length; g++) {
      var m = plan.mounts[g], T = GUNS[m.t] || GUNS.medium;
      var ux = (m.x - plan.w / 2) * plan.cellM, uf = -(m.y - plan.h / 2) * plan.cellM;
      var face = Math.atan2(ux, uf), dist = Math.sqrt(ux * ux + uf * uf);
      // башня смотрит на свою сторону корпуса: нос (±100°), борт (±115°) или корма (±100°); ПВО — ±150°
      if (dist < sh.wid * 0.12 || Math.abs(face) < Math.PI / 6) face = 0;
      else if (Math.abs(face) > Math.PI * 0.86) face = Math.PI;
      else face = face > 0 ? Math.PI / 2 : -Math.PI / 2;
      var room = plan.roomByN[m.room];
      sh.guns.push({ i: g, t: m.t, T: T, room: m.room, name: room ? room.name : T.name, lx: m.x, ly: m.y,
                     face: face, arc: m.t === 'pd' ? 2.6 : (face === 0 || face === Math.PI) ? 1.75 : 2.0, cd: this.R() * T.reload, tgt: { k: 'auto' }, cur: null,
                     x: 0, y: 0, k: 1, aimAt: null, eff: 1, out: false });
      if (m.t !== 'pd') { main++; raw += T.dmg / T.reload; }
    }
    // урон главного калибра — пропорционально «урону» корабля в старой игре
    var k = raw > 0 ? (C.dmg / 120) * (44 / raw) : 1;
    // и с поправкой на то, сколько стволов бьёт в одну сторону при лучшем развороте:
    // корабли с равным «уроном» старой игры равны и здесь, как бы ни стояли пушки
    var bestDps = 0;
    for (var a = 0; a < 32; a++) {
      var ang = -Math.PI + a * Math.PI / 16, v = 0;
      for (g = 0; g < sh.guns.length; g++) {
        var gg = sh.guns[g]; if (gg.t === 'pd') continue;
        if (Math.abs(wrap(ang - gg.face)) <= gg.arc) v += gg.T.dmg / gg.T.reload;
      }
      bestDps = Math.max(bestDps, v);
    }
    if (bestDps > 0) k *= raw / bestDps;
    // ионные пушки слабы по корпусу — их корабль получает прибавку, чтобы итог был равным
    var hw = 0, hs = 0;
    for (g = 0; g < sh.guns.length; g++) { var gt = sh.guns[g]; if (gt.t === 'pd') continue; hw += gt.T.dmg / gt.T.reload * gt.T.hull; hs += gt.T.dmg / gt.T.reload; }
    if (hw > 0) k *= Math.min(1.5, hs / hw);
    // bal — поправка по итогам прогонов ИИ против ИИ (раскладка пушек у корпусов разная:
    // где-то стволы стоят кучно и выбиваются разом, где-то бьют только с носа)
    k *= C.bal || 1;
    // без улучшений — для модернизации на ходу (refit)
    sh.base = { k: k, hull: sh.hullMax, sh: sh.shMax, vmax: C.move * 9, sens: sh.sens - (A.visB || 0) * 1000, move: C.move };
    sh.bon = { hp: A.hpBonus || 1, sh: A.shBonus || 1, dmg: A.dmgK || 1, move: A.moveB || 0, vis: A.visB || 0 };
    k *= A.dmgK || 1;                                  // улучшение орудий корабля в игре
    for (g = 0; g < sh.guns.length; g++) if (sh.guns[g].t !== 'pd') sh.guns[g].k = k;
    // корпус и щиты — с улучшениями и тем, что осталось после прошлых боёв
    if (A.hpBonus) { sh.hullMax *= A.hpBonus; sh.hull = sh.hullMax; }
    if (A.hpK != null) sh.hull = Math.max(1, sh.hullMax * A.hpK);
    if (A.shBonus) sh.shMax *= A.shBonus;
    sh.foreK = A.foreK > 1 ? A.foreK : 1;              // «Мастер лобовой атаки»: носовой сектор держит больше
    for (var q = 0; q < 4; q++) sh.sh[q] = this.secMax(sh, q) * (A.shK && A.shK[q] != null ? A.shK[q] : 1);
    this.ships.push(sh);
    if (!sh.dormant) this.applyStands(sh);
    this.place(sh);
    // разведка перед боем: где противник стоял на старте, обе стороны знают (NPC в эту разведку не входят)
    if (sh.side === 2) this.sides = 3;
    else this.last[1 - sh.side][sh.n] = { x: sh.x, y: sh.y, hd: sh.hd, t: this.t };
    return sh;
  };

  // ---------------------------------------------------------------- геометрия
  // План: нос вверху (−y), правый борт справа (+x). Мир: hd — куда смотрит нос.
  Battle.prototype.toWorld = function(sh, lx, ly) {
    var p = sh.plan, ux = (lx - p.w / 2) * p.cellM, uf = -(ly - p.h / 2) * p.cellM;
    var c = Math.cos(sh.hd), s = Math.sin(sh.hd);
    return [sh.x + c * uf - s * ux, sh.y + s * uf + c * ux];
  };
  Battle.prototype.toLocal = function(sh, x, y) {
    var p = sh.plan, dx = x - sh.x, dy = y - sh.y, c = Math.cos(sh.hd), s = Math.sin(sh.hd);
    var uf = dx * c + dy * s, ux = -dx * s + dy * c;
    return [ux / p.cellM + p.w / 2, -uf / p.cellM + p.h / 2];
  };
  Battle.prototype.place = function(sh) {
    for (var i = 0; i < sh.guns.length; i++) {
      var g = sh.guns[i], w = this.toWorld(sh, g.lx, g.ly); g.x = w[0]; g.y = w[1];
    }
  };
  // Точка корпуса (клетка плана) или ничего
  Battle.prototype.solidAt = function(sh, lx, ly) {
    var p = sh.plan, x = Math.floor(lx), y = Math.floor(ly);
    if (x < 0 || y < 0 || x >= p.w || y >= p.h) return false;
    return p.kind[y * p.w + x] !== 0;
  };
  // Сектор щита, откуда пришёл выстрел: 0 нос, 1 правый борт, 2 корма, 3 левый
  Battle.prototype.sector = function(sh, fx, fy) {
    var a = wrap(Math.atan2(fy - sh.y, fx - sh.x) - sh.hd);
    if (Math.abs(a) <= Math.PI / 4) return 0;
    if (Math.abs(a) >= Math.PI * 3 / 4) return 2;
    return a > 0 ? 1 : 3;
  };

  // ---------------------------------------------------------------- приказы игрока
  // tgt: {k:'auto'} | {k:'fighters'} | {k:'shuttles'} | {k:'hull', ship} | {k:'sys', ship, sys} | {k:'room', ship, room}
  Battle.prototype.setTarget = function(shipN, guns, tgt) {
    var sh = this.ships[shipN]; if (!sh || sh.dead || !tgt) return 0;
    // проверка приказа: годится и для сервера, где он придёт от игрока
    var k = tgt.k, foe = this.ships[tgt.ship];
    if (k !== 'auto' && k !== 'fighters' && k !== 'shuttles') {
      if (!foe || foe.dead || foe.side === sh.side) return 0;
      // имена — только свои ключи (с сервера может прийти «constructor» и т. п.)
      if (k === 'sys' && !(typeof tgt.sys === 'string' && Object.prototype.hasOwnProperty.call(SYS_BY, tgt.sys))) return 0;
      if (k === 'room' && !(tgt.room === (tgt.room | 0) && Object.prototype.hasOwnProperty.call(foe.plan.roomByN, tgt.room))) return 0;
      if (k !== 'hull' && k !== 'sys' && k !== 'room') return 0;
    }
    if (!guns || !guns.length) return 0;
    var n = 0;
    for (var i = 0; i < guns.length; i++) {
      var g = (guns[i] === (guns[i] | 0)) ? sh.guns[guns[i]] : null; if (!g) continue;
      g.tgt = { k: tgt.k, ship: tgt.ship, sys: tgt.sys, room: tgt.room }; g.cur = null; g.keep = null; n++;
    }
    return n;
  };
  // Атака: корабль берёт врага в цель. Пушки «сама» бьют его первым (кто его не
  // достаёт — по ближайшему в секторе), пушки с приказом по чужому кораблю
  // переводятся на него (отсек → корпус), ИИ-курс идёт к нему, щиты и бомбардировщики
  // — тоже на него. to == null — снять цель (корабль снова выбирает сам).
  Battle.prototype.attack = function(shipN, to) {
    var sh = this.ships[shipN]; if (!sh || sh.dead) return 0;
    if (to == null || to < 0) { sh.foeT = null; return 0; }
    var foe = this.ships[to];
    if (!foe || foe.dead || foe.side === sh.side || to !== (to | 0)) return 0;
    sh.foeT = to;
    var n = 0;
    for (var i = 0; i < sh.guns.length; i++) {
      var g = sh.guns[i], k = g.tgt.k;
      if (k === 'auto') { g.cur = null; n++; continue; }
      if ((k === 'hull' || k === 'sys' || k === 'room') && g.tgt.ship !== to) {
        g.tgt = carryTgt(g.tgt, foe, this.ships[g.tgt.ship]); g.cur = null; n++;
      } else if (k === 'hull' || k === 'sys' || k === 'room') n++;
    }
    // свои бомбардировщики выбирают цель заново
    // (кто только что отбомбился и уходит — сменит цель после отхода, не раньше)
    for (i = 0; i < this.craft.length; i++) { var c = this.craft[i]; if (c.home === sh.n && c.role === 'bomber' && c.tgt !== to) { if (c.mode === 'out') c.retgt = true; else c.tgt = null; } }
    return n;
  };
  // Цель корабля: назначенная игроком (видна — она; ушла в туман — курс к её последней
  // засечке, пока не дошли: там не нашли — цель потеряна), иначе ближайший враг
  // Враг для ИИ на живой орбите: цель корабля (как foeOf), иначе ближайший видимый в датчиках самого
  // корабля — «увидел — пошёл в атаку». Засечки (где враг стоял когда-то) ИИ сюда не ведут
  Battle.prototype.aiFoe = function(sh) {
    if (sh.foeT != null) { var t = this.foeOf(sh); if (t) return t; }
    var r = this.sensRange(sh), best = null, bd = 1e18;
    for (var i = 0; i < this.ships.length; i++) {
      var o = this.ships[i]; if (o.dead || o.side === sh.side || !this.sees(sh.side, o)) continue;
      var dx = o.x - sh.x, dy = o.y - sh.y, d = dx * dx + dy * dy, lim = r + o.len / 2;
      if (d <= lim * lim && d < bd) { bd = d; best = o; }
    }
    return best;
  };
  // Возврат на место после боя (sh.home): дойти и развернуться, как стоял; дошёл — место забыто
  Battle.prototype.homeStep = function(sh, vmax) {
    var H = sh.home, dx = H.x - sh.x, dy = H.y - sh.y, d = Math.sqrt(dx * dx + dy * dy);
    if (d > 150) return { want: Math.atan2(dy, dx), wantV: Math.min(vmax, d / 20) };
    if (Math.abs(wrap(H.hd - sh.hd)) < 0.03 && sh.v < 1) { sh.home = null; return { want: null, wantV: 0 }; }
    return { want: H.hd, wantV: 0 };
  };
  Battle.prototype.foeOf = function(sh) {
    if (sh.foeT != null) {
      var t = this.ships[sh.foeT];
      if (t && !t.dead && t.side !== sh.side) {
        if (this.sees(sh.side, t)) return t;
        var L = this.last[sh.side][t.n];
        if (L && (L.x - sh.x) * (L.x - sh.x) + (L.y - sh.y) * (L.y - sh.y) > 1500 * 1500) return { x: L.x, y: L.y, ghost: true, n: t.n };
      }
      sh.foeT = null;
    }
    return this.nearestFoe(sh);
  };
  // Модернизация на ходу (верфь в игре): новые множители корпуса, щитов, орудий, хода и датчиков.
  // Целость корпуса и щитов — в той же доле, что была
  Battle.prototype.refitShip = function(n, A) {
    var sh = this.ships[n]; if (!sh || sh.dead || !sh.base) return;
    var hk = sh.hull / Math.max(1, sh.hullMax), b = sh.base, q;
    sh.bon = { hp: A.hpBonus || 1, sh: A.shBonus || 1, dmg: A.dmgK || 1, move: A.moveB || 0, vis: A.visB || 0 };
    sh.hullMax = b.hull * sh.bon.hp; sh.hull = Math.max(1, sh.hullMax * hk);
    var self = this, sk = sh.sh.map(function(v, i) { return v / Math.max(1, self.secMax(sh, i)); });
    sh.shMax = b.sh * sh.bon.sh; sh.foreK = A.foreK > 1 ? A.foreK : 1;
    for (q = 0; q < 4; q++) sh.sh[q] = this.secMax(sh, q) * sk[q];
    for (q = 0; q < sh.guns.length; q++) if (sh.guns[q].t !== 'pd') sh.guns[q].k = b.k * sh.bon.dmg;
    sh.vmax = (b.move + sh.bon.move) * 9; sh.sens = b.sens + sh.bon.vis * 1000;
    sh.tractor = !!A.tractor; if (!sh.tractor && sh.tb) this.tbRelease(sh);
  };
  // ---- притягивающий луч
  // Кто держит корабль лучом (или null)
  Battle.prototype.holder = function(sh) {
    var h = sh.heldBy != null ? this.ships[sh.heldBy] : null;
    return h && !h.dead && h.tb && h.tb.to === sh.n ? h : null;
  };
  // Можно ли взять цель лучом: { ok, why, gap }
  Battle.prototype.tractorCan = function(n, t) {
    var a = this.ships[n], b = t === (t | 0) && t >= 0 ? this.ships[t] : null;
    if (!a || a.dead) return { ok: false, why: 'корабля нет' };
    if (!a.tractor) return { ok: false, why: 'на корабле нет притягивающего луча — исследование «Притягивающие лучи»' };
    if (a.tb) { var hd = this.ships[a.tb.to]; return { ok: false, why: 'луч уже держит ' + (hd ? hd.name : 'цель') }; }
    if (a.tbReady > this.t) return { ok: false, why: 'луч перезаряжается: ' + Math.ceil(a.tbReady - this.t) + ' с', cd: a.tbReady - this.t };
    if (!b || b.dead || b.side === a.side) return { ok: false, why: 'выбери вражеский корабль — коснись его' };
    if (!this.sees(a.side, b)) return { ok: false, why: 'нет контакта с целью' };
    if (this.holder(b)) return { ok: false, why: 'цель уже в луче' };
    if ((a.eff.reactor == null ? 1 : a.eff.reactor) < 0.3) return { ok: false, why: 'не хватает питания: реактор повреждён' };
    var dx = b.x - a.x, dy = b.y - a.y, gap = Math.sqrt(dx * dx + dy * dy) - (a.len + b.len) / 2;
    if (gap > TRACTOR.range) return { ok: false, why: 'далеко: ' + (gap / 1000).toFixed(1) + ' км, луч берёт до ' + TRACTOR.range / 1000 + ' км', gap: gap };
    return { ok: true, why: '', gap: Math.max(0, gap) };
  };
  // Приказ: взять цель t лучом ('' — взял, иначе причина); t < 0 — отпустить
  Battle.prototype.tractor = function(n, t) {
    var a = this.ships[n]; if (!a || a.dead) return 'корабля нет';
    if (t == null || t < 0) { if (a.tb) this.tbRelease(a); return ''; }
    var c = this.tractorCan(n, t); if (!c.ok) return c.why;
    a.tb = { to: t, until: this.t + TRACTOR.hold };
    this.ships[t].heldBy = n;
    return '';
  };
  Battle.prototype.tbRelease = function(a) {
    var b = a.tb ? this.ships[a.tb.to] : null;
    if (b && b.heldBy === a.n) b.heldBy = null;
    a.tb = null; a.tbReady = this.t + TRACTOR.cd;
  };
  // Каждый шаг: луч рвётся — время вышло, держащий или цель погибли, цель стала своей (трофей),
  // ушла дальше дальности с запасом или у держащего разбит реактор
  Battle.prototype.beams = function() {
    for (var i = 0; i < this.ships.length; i++) {
      var a = this.ships[i]; if (!a.tb) continue;
      var b = this.ships[a.tb.to];
      if (a.dead || !b || b.dead || b.side === a.side || this.t >= a.tb.until || (a.eff.reactor == null ? 1 : a.eff.reactor) < 0.15) { this.tbRelease(a); continue; }
      var dx = b.x - a.x, dy = b.y - a.y, gap = Math.sqrt(dx * dx + dy * dy) - (a.len + b.len) / 2;
      if (gap > TRACTOR.range * 1.3) { this.tbRelease(a); continue; }
      b.heldBy = a.n;
    }
  };
  // Держать позицию (игрок отошёл): корабль стоит на месте, к врагу в досягаемости
  // поворачивается бортом с большим числом стволов; никуда не идёт и абордаж не начинает
  // Разбудить спящий корабль: настоящий экипаж по тому же составу
  Battle.prototype.wake = function(sh) {
    if (!sh || !sh.dormant) return;
    sh.crew = new SWCrew.Crew(sh.plan, sh.crewOpts); sh.dormant = false;
    this.applyStands(sh);
    for (var i = 0; i < this.craft.length; i++) if (this.craft[i].home === sh.n) this.craft[i].idle = false;   // его истребители — в дело
    this.ev.wakes = this.ev.wakes || []; this.ev.wakes.push(sh.n);
  };
  // Посты десанта (rt-crew standUnits): uid бойца → клетка плана. Живут в корабле боя (и в базе —
  // ships.troop_posts), поэтому переживают сон корабля и новое открытие орбиты
  Battle.prototype.applyStands = function(sh) {
    if (!sh.stands || sh.dormant || !sh.crew.standAt) return;
    var ag = sh.crew.agents;
    for (var i = 0; i < ag.length; i++) { var a = ag[i], p = a.uid && sh.stands[a.uid]; if (p && a.alive && a.team === sh.side) sh.crew.standAt(a, p); }
  };
  Battle.prototype.standTroops = function(shipN, ids, cell) {
    var sh = this.ships[shipN]; if (!sh || sh.dead || !Array.isArray(ids)) return 0;
    if (sh.dormant) this.wake(sh);
    var n = sh.crew.standUnits(ids.slice(0, 128), cell | 0), st = {}, ag = sh.crew.agents;
    for (var i = 0; i < ag.length; i++) if (ag[i].alive && ag[i].stand && ag[i].uid) st[ag[i].uid] = ag[i].stand.slice(0, 2);
    sh.stands = st; sh.standsDirty = true;
    return n;
  };
  Battle.prototype.guard = function(shipN, on) {
    var sh = this.ships[shipN]; if (!sh || sh.dead) return;
    sh.guard = !!on;
    // игрок закрыл экран: корабль доходит заданный курс и только потом держит позицию
    if (on) { sh.ai = false; if (sh.order && sh.order.face) sh.order = null; sh.focusAuto = true; }
  };
  // Курс: к точке; face — только развернуться носом к точке; x == null — корабль ведёт ИИ;
  // hold — стоять (свой курс без точки)
  Battle.prototype.order = function(shipN, x, y, face) {
    var sh = this.ships[shipN]; if (!sh || sh.dead) return;
    sh.guard = false;                                   // игрок снова ведёт корабль сам
    if (x != null) sh.home = null;                      // свой курс — место «до боя» забыто: новое место там, где оставит игрок
    if (x === 'hold') { sh.order = null; sh.ai = false; return; }
    if (x != null && !(isFinite(x) && isFinite(y))) return;
    sh.order = x == null ? null : { x: x, y: y, face: !!face }; sh.ai = x == null;
  };

  // ---------------------------------------------------------------- шаг
  Battle.prototype.step = function(dt) {
    this.acc = Math.min((this.acc || 0) + dt, 0.5);
    while (this.acc >= TICK) { this.acc -= TICK; this.tick(TICK); }
  };
  Battle.prototype.tick = function(dt) {
    this.t += dt;
    var i, sh;
    this.beams();
    for (i = 0; i < this.ships.length; i++) {
      sh = this.ships[i];
      if (sh.dead) continue;
      if (!sh.dormant) sh.crew.step(dt);
      this.systems(sh, dt);
      this.drive(sh, dt);
      this.place(sh);
      if (!sh.dormant) this.wingStep(sh, dt);
    }
    this.collide(dt);
    this.senseT -= dt;
    if (this.senseT <= 0) { this.senseT = 0.5; this.sense(); }
    this.boardStep(dt);
    for (i = 0; i < this.ships.length; i++) if (!this.ships[i].dead && !this.ships[i].dormant) this.fireGuns(this.ships[i], dt);
    this.flyCraft(dt);
    // попадания долетают
    var keep = [];
    for (i = 0; i < this.pending.length; i++) {
      var p = this.pending[i];
      if (p.at <= this.t) this.resolve(p); else keep.push(p);
    }
    this.pending = keep;
    if (!this.endless) this.checkEnd();
  };

  // Системы корабля из состояния отсеков
  Battle.prototype.systems = function(sh, dt) {
    var c = sh.crew, e = sh.eff;
    e.engine = c.sysEff('engine');
    e.reactor = c.sysEff('reactor');
    e.shield = hasType(sh.plan, 'shield') ? c.sysEff('shield') : e.reactor;
    e.bridge = (c.sysEff('bridge') * 2 + (hasType(sh.plan, 'cic') ? c.sysEff('cic') : 1)) / 3;
    e.hangar = hasType(sh.plan, 'hangar') ? c.sysEff('hangar') : 0;
    e.power = 0.45 + 0.55 * e.reactor;           // без реактора — аварийные генераторы (почти половина)
    this.shields(sh, dt);
    // генератор щитов в руках абордажной команды — щиты погашены
    if (sh.crew.board && sh.crew.board.heldType('shield')) { sh.sh[0] = sh.sh[1] = sh.sh[2] = sh.sh[3] = 0; }
    // орудия: люди на посту, целость, питание
    for (var g = 0; g < sh.guns.length; g++) {
      var gun = sh.guns[g], re = gun.room ? c.roomEff(gun.room) : 1;
      gun.eff = re; gun.out = re <= 0;
    }
    // реактор разбит — отсчёт до взрыва
    var rs = reactorState(sh);
    if (rs !== null && rs <= 0.5) { if (!sh.crit) sh.crit = REACTOR_FUSE; }
    else if (sh.crit && rs !== null && rs > 25) sh.crit = 0;
    if (sh.crit) {
      sh.crit -= dt;
      if (sh.crit <= 0) { sh.crit = 0; this.kill(sh, 'reactor'); }
    }
  };
  // Секторные щиты.
  //  - Предел сектора: усиленный сектор ×1,25, остальные ×0,9; разбитый генератор
  //    снижает предел (до 40% при нуле).
  //  - Восстановление: полное, если по сектору не били 5 с; под огнём — 12%;
  //    усиленный сектор — ×1,4. Скорость зависит от класса корабля (shK).
  //  - Перекачка: спокойные сектора с запасом больше половины отдают (xfer ед/с)
  //    самому просевшему из тех, что под огнём, — без хозяина корабля это делает экипаж.
  // Предел сектора без усиления и поломок: носовой (0) — больше на исследование «Мастер лобовой атаки»
  Battle.prototype.secMax = function(sh, s) { return sh.shMax * (s === 0 && sh.foreK > 1 ? sh.foreK : 1); };
  Battle.prototype.shieldCap = function(sh, s) {
    var k = sh.focus < 0 ? 1 : s === sh.focus ? 1.25 : 0.9;
    return this.secMax(sh, s) * k * (0.4 + 0.6 * (sh.eff.shield == null ? 1 : sh.eff.shield));
  };
  Battle.prototype.shields = function(sh, dt) {
    var e = sh.eff, s, base = sh.regen * e.shield * e.power;
    if (sh.focusAuto) this.autoFocus(sh, dt);
    var need = -1, nv = 1e9;
    for (s = 0; s < 4; s++) {
      sh.shHit[s] = Math.max(0, sh.shHit[s] - dt);
      var cap = this.shieldCap(sh, s), r = base * (sh.shHit[s] > 0 ? 0.12 : 1) * (s === sh.focus ? 1.4 : 1);
      sh.sh[s] = Math.min(cap, sh.sh[s] + r * dt);
      if (sh.sh[s] > cap) sh.sh[s] = cap;
      if (sh.shHit[s] > 0 && sh.sh[s] / cap < nv) { nv = sh.sh[s] / cap; need = s; }
    }
    if (need >= 0) {
      for (s = 0; s < 4; s++) {
        if (s === need || sh.shHit[s] > 0) continue;
        var c2 = this.shieldCap(sh, s);
        if (sh.sh[s] <= c2 * 0.5) continue;
        var give = Math.min(sh.xfer * e.power * dt, sh.sh[s] - c2 * 0.5, this.shieldCap(sh, need) - sh.sh[need]);
        if (give > 0) { sh.sh[s] -= give; sh.sh[need] += give; }
      }
    }
  };
  // ИИ (и экипаж корабля без хозяина) усиливает сектор, что смотрит на ближайшего врага
  Battle.prototype.autoFocus = function(sh, dt) {
    sh.focusT = (sh.focusT || 0) - dt;
    if (sh.focusT > 0) return;
    sh.focusT = 3;
    var foe = this.nearestFoe(sh);
    sh.focus = foe ? this.sector(sh, foe.x, foe.y) : -1;
  };
  // Приказ игрока: усилить сектор (0 нос, 1 правый, 2 корма, 3 левый), −1 — ровно
  Battle.prototype.setFocus = function(shipN, s) {
    var sh = this.ships[shipN]; if (!sh || sh.dead) return;
    sh.focus = (s === 0 || s === 1 || s === 2 || s === 3) ? s : -1;
    sh.focusAuto = false;
  };

  function hasType(plan, t) {
    if (!plan._types) { plan._types = {}; for (var i = 0; i < plan.rooms.length; i++) plan._types[plan.rooms[i].t] = 1; }
    return !!plan._types[t];
  }
  function reactorState(sh) {
    var c = sh.crew, best = null;
    for (var i = 0; i < c.roomList.length; i++) if (c.roomList[i].t === 'reactor') best = Math.max(best || 0, c.roomList[i].integ);
    return best;
  }

  // Ход: к точке приказа; без приказа — ИИ держит дистанцию бортом к врагу
  Battle.prototype.drive = function(sh, dt) {
    var e = sh.eff, vmax = sh.vmax * (0.2 + 0.8 * e.engine) * (0.5 + 0.5 * e.power);
    var tr = sh.turn * (0.3 + 0.7 * e.engine) * (0.6 + 0.4 * e.bridge);
    // в притягивающем луче: ход и поворот режутся (тем сильнее, чем держащий крупнее), скорость сбрасывается
    var hb = this.holder(sh), hk = hb ? Math.max(0.35, Math.min(1, hb.len / sh.len)) : 0;
    if (hk) { vmax *= 1 - 0.85 * hk; tr *= 1 - 0.6 * hk; if (sh.v > vmax) sh.v = Math.max(vmax, sh.v - sh.vmax * 0.3 * dt); }
    var want = null, wantV = 0;
    if (sh.order) {
      var dx = sh.order.x - sh.x, dy = sh.order.y - sh.y, d = Math.sqrt(dx * dx + dy * dy);
      if (sh.order.face) {
        want = Math.atan2(dy, dx); wantV = 0;
        if (Math.abs(wrap(want - sh.hd)) < 0.02) sh.order = null;
      }
      else if (d < 120) { sh.order = null; }
      else {
        want = Math.atan2(dy, dx); wantV = Math.min(vmax, d / 20);
        // точка занята чужим корпусом (или туда же идёт свой): упёрся и 12 с не продвинулся — приказ снят;
        // далеко от точки — это толчея на пути (строй разворачивается), ждём дольше — 45 с
        if (sh.order.bd == null || d < sh.order.bd - 40) { sh.order.bd = d; sh.order.bt = this.t; }
        else if (this.t - sh.order.bt > (d < sh.len + 1500 ? 12 : 45) && this.t - (sh.touchT || -99) < 2) { sh.order = null; want = null; wantV = 0; }
      }
    } else if (sh.guard) {
      // на позиции: враг в досягаемости — борт к нему, ход ноль; врага нет, а бой увёл с места — назад на место
      var gf = sh.foeT != null && this.ships[sh.foeT] && !this.ships[sh.foeT].dead && this.sees(sh.side, this.ships[sh.foeT]) ? this.ships[sh.foeT] : this.nearestFoe(sh), gNear = false;
      if (gf && !gf.ghost) {
        var gx = gf.x - sh.x, gy = gf.y - sh.y;
        if (gx * gx + gy * gy < Math.pow(mainRange(sh) * 1.3 + gf.len / 2, 2)) { want = Math.atan2(gy, gx) + bestFacing(sh, false); wantV = 0; gNear = true; }
      }
      if (!gNear && sh.home) { var gh = this.homeStep(sh, vmax); want = gh.want; wantV = gh.wantV; }
    } else if (sh.ai) {
      // живая орбита (seenOnly): враг — только видимый и в датчиках самого корабля; бой кончился — назад на место
      var foe = this.seenOnly ? this.aiFoe(sh) : this.foeOf(sh);
      if (!foe && sh.home) { var ah = this.homeStep(sh, vmax); want = ah.want; wantV = ah.wantV; }
      if (foe) {
        if (this.seenOnly && !sh.home) sh.home = { x: sh.x, y: sh.y, hd: sh.hd };   // где стоял до боя
        var fx = foe.x - sh.x, fy = foe.y - sh.y, fd = Math.sqrt(fx * fx + fy * fy), brg = Math.atan2(fy, fx);
        var range = mainRange(sh) * 0.7;
        if (fd > range) { want = brg; wantV = vmax; }
        else {
          // встать так, чтобы на врага смотрело больше стволов (нос, борт или скула)
          var o = bestFacing(sh, fd < range * 0.5);
          want = brg + o; wantV = vmax * (fd < range * 0.5 ? 0.6 : 0.3);
        }
      }
    }
    // не лезть в чужой корпус: обойти (разворот на месте — face — не трогаем)
    if (want !== null && !(sh.order && sh.order.face)) {
      var av = this.avoid(sh, want, wantV);
      if (av) { want = av.want; wantV = av.wantV; }
    }
    if (want !== null) {
      sh.hd = turnTo(sh.hd, want, tr * dt);
      var off = Math.abs(wrap(want - sh.hd));
      wantV *= Math.max(0.25, Math.cos(Math.min(off, Math.PI / 2)));
    }
    var acc = sh.vmax * 0.08 * dt;
    sh.v += Math.max(-acc, Math.min(acc, wantV - sh.v));
    sh.hd = wrap(sh.hd);
    sh.x += Math.cos(sh.hd) * sh.v * dt; sh.y += Math.sin(sh.hd) * sh.v * dt;
    // луч подтягивает к держащему — до TRACTOR.near между корпусами
    if (hk) {
      var px = hb.x - sh.x, py = hb.y - sh.y, pd = Math.sqrt(px * px + py * py), pg = pd - (sh.len + hb.len) / 2;
      if (pd > 1 && pg > TRACTOR.near) {
        var st = Math.min(TRACTOR.pull * hk * dt, pg - TRACTOR.near), nx = sh.x + px / pd * st, ny = sh.y + py / pd * st;
        // орбита системы: не затащить в чужую полосу гиперпространства (сервер даёт pullOk)
        if (!this.pullOk || this.pullOk(sh, nx, ny)) { sh.x = nx; sh.y = ny; }
      }
    }
  };
  // Поворот относительно линии на врага, при котором бьёт больше всего стволов.
  // away — только курсы с отходом (враг слишком близко).
  var OFFS = [0, Math.PI / 4, -Math.PI / 4, Math.PI / 2, -Math.PI / 2, Math.PI * 3 / 4, -Math.PI * 3 / 4];
  function bestFacing(sh, away) {
    var best = 0, bv = -1;
    for (var i = 0; i < OFFS.length; i++) {
      var o = OFFS[i]; if (away && Math.abs(o) < Math.PI / 2) continue;
      var a = -o, v = 0;
      for (var g = 0; g < sh.guns.length; g++) {
        var gun = sh.guns[g]; if (gun.t === 'pd' || gun.out) continue;
        if (Math.abs(wrap(a - gun.face)) <= gun.arc) v += gun.T.dmg * gun.k / gun.T.reload;
      }
      // при равенстве — тот курс, что ближе к нынешнему (не крутиться зря)
      v -= Math.abs(wrap(o - (sh.lastO || 0))) * 0.01;
      if (v > bv) { bv = v; best = o; }
    }
    sh.lastO = best;
    return best;
  }
  // Дистанция боя для ИИ — по средней пушке главного калибра (не по самой дальней)
  function mainRange(sh) {
    var r = [];
    for (var i = 0; i < sh.guns.length; i++) if (sh.guns[i].t !== 'pd') r.push(sh.guns[i].T.range);
    if (!r.length) return 5000;
    r.sort(function(a, b) { return a - b; });
    return r[Math.floor((r.length - 1) / 2)];
  }
  // Ближайший видимый враг; если никого не видно — «призрак» на месте последней
  // засечки ({x, y, ghost}), чтобы ИИ шёл туда, где врага видели
  Battle.prototype.nearestFoe = function(sh) {
    var best = null, bd = 1e18, ghost = null, gd = 1e18;
    for (var i = 0; i < this.ships.length; i++) {
      var o = this.ships[i]; if (o.dead || o.side === sh.side) continue;
      if (this.sees(sh.side, o)) {
        var dx = o.x - sh.x, dy = o.y - sh.y, d = dx * dx + dy * dy;
        if (d < bd) { bd = d; best = o; }
      } else {
        var L = this.last[sh.side][o.n]; if (!L) continue;
        var gx = L.x - sh.x, gy = L.y - sh.y, g2 = gx * gx + gy * gy;
        if (g2 < gd) { gd = g2; ghost = { x: L.x, y: L.y, ghost: true, n: o.n }; }
      }
    }
    return best || ghost;
  };

  // ---------------------------------------------------------------- туман войны
  // Видит ли сторона side корабль o
  Battle.prototype.sees = function(side, o) { return !this.fog || o.side === side || !!this.vis[side][o.n]; };
  // Дальность датчиков: связь и тактический центр разбиты — видно ближе (до 55%)
  Battle.prototype.sensRange = function(sh) {
    var c = sh.crew, sum = 0, n = 0;
    for (var i = 0; i < sh.plan.rooms.length; i++) {
      var r = sh.plan.rooms[i]; if (r.t !== 'comms' && r.t !== 'cic') continue;
      sum += c.roomEff(r.n); n++;
    }
    return sh.sens * (n ? 0.55 + 0.45 * Math.min(1, sum / n) : 1);
  };
  var CRAFT_SENS = 3500, NEAR = 1500, FLASH = 3, FLASH_R = 15000;
  Battle.prototype.sense = function() {
    var S = this.ships, C = this.craft, side, i, j;
    for (side = 0; side < this.sides; side++) {
      var vis = {}, visC = {}, eyes = [];
      for (i = 0; i < S.length; i++) if (!S[i].dead && S[i].side === side) eyes.push([S[i].x, S[i].y, this.sensRange(S[i])]);
      for (i = 0; i < C.length; i++) if (!C[i].dead && C[i].side === side) eyes.push([C[i].x, C[i].y, CRAFT_SENS]);
      // неподвижные датчики (станция на орбите): [сторона, x, y, дальность]
      if (this.eyes) for (i = 0; i < this.eyes.length; i++) if (this.eyes[i][0] === side) eyes.push([this.eyes[i][1], this.eyes[i][2], this.eyes[i][3]]);
      for (i = 0; i < S.length; i++) {
        var o = S[i]; if (o.dead || o.side === side) continue;
        var seen = false, flash = this.t - o.flash < FLASH;
        for (j = 0; j < eyes.length && !seen; j++) {
          var dx = o.x - eyes[j][0], dy = o.y - eyes[j][1], d2 = dx * dx + dy * dy, r = eyes[j][2] + o.len * 0.5;
          if (d2 < r * r || d2 < NEAR * NEAR || (flash && d2 < FLASH_R * FLASH_R)) seen = true;
        }
        if (seen) { vis[o.n] = 1; this.last[side][o.n] = { x: o.x, y: o.y, hd: o.hd, t: this.t }; }
      }
      for (i = 0; i < C.length; i++) {
        var c = C[i]; if (c.dead || c.side === side) continue;
        for (j = 0; j < eyes.length; j++) {
          var ex = c.x - eyes[j][0], ey = c.y - eyes[j][1];
          if (ex * ex + ey * ey < eyes[j][2] * eyes[j][2]) { visC[c.id] = 1; break; }
        }
      }
      this.vis[side] = vis; this.visC[side] = visC;
    }
  };

  // ---------------------------------------------------------------- стрельба
  Battle.prototype.fireGuns = function(sh, dt) {
    var e = sh.eff;
    for (var i = 0; i < sh.guns.length; i++) {
      var g = sh.guns[i];
      if (g.out) { g.aimAt = null; continue; }
      g.cd -= dt * (0.6 + 0.4 * e.power) * (0.25 + 0.75 * g.eff);       // у орудий свои накопители: без реактора — медленнее, но стреляют
      var aim = this.pick(sh, g);
      g.aimAt = aim;
      if (!aim || g.cd > 0) continue;
      g.cd = g.T.reload * (0.9 + this.R() * 0.2);
      if (g.t !== 'pd') sh.flash = this.t;            // вспышка главного калибра видна издалека
      if (g.room) sh.crew.gunFired(g.room);
      if (aim.craft) this.shootCraft(sh, g, aim.craft);
      else this.shootShip(sh, g, aim);
    }
  };
  // Куда эта пушка бьёт сейчас (с учётом сектора и дальности)
  Battle.prototype.pick = function(sh, g) {
    var t = g.tgt, k = t.k, T = g.T;
    if (k === 'auto') {
      if (g.t === 'pd') { var c0 = this.craftFor(sh, g, T.range); if (c0) return { craft: c0 }; }
      var foe = this.foeInArc(sh, g, null);
      if (!foe) return null;
      // пушка помнит прошлый приказ по системе — новый враг в секторе: бить ту же систему
      if (g.keep) { g.tgt = g.keep.k === 'sys' ? { k: 'sys', ship: foe.n, sys: g.keep.sys } : { k: 'hull', ship: foe.n }; g.keep = null; return this.pick(sh, g); }
      return this.autoAim(sh, g, foe);
    }
    if (k === 'fighters') { var c1 = this.craftFor(sh, g, T.range); return c1 ? { craft: c1 } : null; }
    // ПВО по шаттлам: сперва абордажные шаттлы; их нет — как «сама»
    if (k === 'shuttles') {
      var c2 = this.craftFor(sh, g, T.range, true); if (c2) return { craft: c2 };
      if (g.t === 'pd') { var c3 = this.craftFor(sh, g, T.range); if (c3) return { craft: c3 }; }
      var f2 = this.foeInArc(sh, g, null); return f2 ? this.autoAim(sh, g, f2) : null;
    }
    var tgtShip = this.ships[t.ship];
    if (!tgtShip || tgtShip.dead || tgtShip.side === sh.side) {
      // цель погибла — пушка помнит, ЧТО бить (реактор, орудия…), и переходит на следующего врага;
      // сейчас некого — ждёт «сама», выбор хранит до появления врага
      // (каждая пушка — по своему сектору: первый враг, которого она достаёт, — по той же системе)
      g.keep = { k: t.k === 'room' ? 'sys' : t.k, sys: t.k === 'room' ? (tgtShip && tgtShip.plan.roomByN[t.room] ? sysOfRoom(tgtShip.plan.roomByN[t.room].t) : null) : t.sys };
      if (g.keep.k === 'sys' && !g.keep.sys) g.keep = { k: 'hull' };
      g.tgt = { k: 'auto' };
      return this.pick(sh, g);
    }
    if (!this.sees(sh.side, tgtShip)) return null;      // цель потеряна в тумане — пушка ждёт
    if (this.ourBoard(sh.side, tgtShip)) {
      if (sh.hold && sh.hold[tgtShip.n]) return null;   // приказ: по кораблю со своим десантом не стрелять
      if (k === 'hull' || k === 'room') return this.inArc(sh, g, tgtShip.x, tgtShip.y, tgtShip) ? { ship: tgtShip, room: this.gunRoomFree(tgtShip, sh.side, g) } : null;
    }
    if (!this.inArc(sh, g, tgtShip.x, tgtShip.y, tgtShip)) return null;
    if (k === 'hull') return { ship: tgtShip, room: 0 };
    if (k === 'room') return tgtShip.plan.roomByN[t.room] ? { ship: tgtShip, room: t.room } : { ship: tgtShip, room: 0 };
    if (k === 'sys') return { ship: tgtShip, room: this.sysRoom(tgtShip, t.sys, g) };
    return null;
  };
  // Сама: ионная — по щитам (или двигателям), тяжёлая — по орудиям и реактору,
  // остальные — по мостику и корпусу
  Battle.prototype.autoAim = function(sh, g, foe) {
    var sys = null;
    // на борту свой абордаж: бить по орудиям цели, мимо отсеков, где наши
    if (this.ourBoard(sh.side, foe)) return { ship: foe, room: this.gunRoomFree(foe, sh.side, g) };
    if (g.t === 'ion') sys = foe.sh[this.sector(foe, g.x, g.y)] > this.secMax(foe, this.sector(foe, g.x, g.y)) * 0.2 ? (hasType(foe.plan, 'shield') ? 'shield' : 'engine') : 'engine';
    else if (g.t === 'heavy') sys = this.sector(foe, g.x, g.y) === 2 ? 'engine' : 'guns';
    else if (g.t === 'pd') return { ship: foe, room: 0 };
    else sys = 'bridge';
    return { ship: foe, room: this.sysRoom(foe, sys, g) };
  };
  // Отсек системы, ближайший к стреляющему (с его стороны)
  Battle.prototype.sysRoom = function(ship, sys, g) {
    var S = SYS_BY[sys]; if (!S) return 0;
    var best = 0, bd = 1e18, rooms = ship.plan.rooms;
    for (var i = 0; i < rooms.length; i++) {
      var r = rooms[i]; if (S.types.indexOf(r.t) < 0) continue;
      var st = ship.crew.rooms[r.n];
      var w = this.toWorld(ship, r.cx, r.cy), dx = w[0] - g.x, dy = w[1] - g.y, d = dx * dx + dy * dy;
      if (st && st.integ <= 0) d *= 4;              // уже разбитые — в последнюю очередь
      if (d < bd) { bd = d; best = r.n; }
    }
    return best;
  };
  Battle.prototype.inArc = function(sh, g, x, y, tgtShip) {
    var dx = x - g.x, dy = y - g.y, d = Math.sqrt(dx * dx + dy * dy);
    var reach = g.T.range + (tgtShip ? tgtShip.len * 0.35 : 0);
    if (d > reach) return false;
    var a = wrap(Math.atan2(dy, dx) - sh.hd);          // от носа, +к правому борту
    return Math.abs(wrap(a - g.face)) <= g.arc + (tgtShip ? Math.atan2(tgtShip.len * 0.3, d) : 0);
  };
  Battle.prototype.foeInArc = function(sh, g) {
    var best = null, bd = 1e18;
    // цель корабля — первой, если пушка её достаёт
    var ft = sh.foeT != null ? this.ships[sh.foeT] : null;
    if (ft && !ft.dead && ft.side !== sh.side && this.sees(sh.side, ft) && !(sh.hold && sh.hold[ft.n] && this.ourBoard(sh.side, ft)) && this.inArc(sh, g, ft.x, ft.y, ft)) return ft;
    for (var i = 0; i < this.ships.length; i++) {
      var o = this.ships[i]; if (o.dead || o.side === sh.side || !this.sees(sh.side, o)) continue;
      if (sh.hold && sh.hold[o.n] && this.ourBoard(sh.side, o)) continue;   // приказ: по кораблю со своим десантом не стрелять
      if (!this.inArc(sh, g, o.x, o.y, o)) continue;
      var dx = o.x - g.x, dy = o.y - g.y, d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = o; }
    }
    return best;
  };
  Battle.prototype.craftFor = function(sh, g, range, onlyShuttles) {
    var best = null, bd = range * range;
    for (var i = 0; i < this.craft.length; i++) {
      var c = this.craft[i]; if (c.dead || c.side === sh.side || !this.visC[sh.side][c.id] || (onlyShuttles && c.role !== 'shuttle')) continue;
      var dx = c.x - g.x, dy = c.y - g.y, d = dx * dx + dy * dy;
      if (d > bd || !this.inArc(sh, g, c.x, c.y, null)) continue;
      // бомбардировщики, что идут на нас, — первыми
      if (c.role === 'bomber' || c.role === 'shuttle') d *= 0.5;
      if (d < bd) { bd = d; best = c; }
    }
    return best;
  };

  Battle.prototype.shootShip = function(sh, g, aim) {
    var T = g.T, foe = aim.ship, p = foe.plan, R = this.R;
    var dx = foe.x - g.x, dy = foe.y - g.y, d = Math.sqrt(dx * dx + dy * dy);
    var hit = T.acc * sh.acc * (0.6 + 0.4 * sh.eff.bridge) * (1 - foe.eva) * (1 - 0.35 * Math.min(1, d / T.range));
    // точка удара на плане цели
    var lx, ly, room = aim.room && p.roomByN[aim.room];
    if (room && R() < T.aim * (0.7 + 0.3 * sh.eff.bridge)) {
      lx = room.x + 1 + R() * (room.w - 2); ly = room.y + 1 + R() * (room.h - 2);
    } else {
      // рядом с выбранным отсеком или по борту, обращённому к стрелку
      var cx, cy, spread;
      if (room) { cx = room.cx; cy = room.cy; spread = 30; }
      else { var loc = this.toLocal(foe, g.x, g.y), mx = loc[0] - p.w / 2, my = loc[1] - p.h / 2, L = Math.sqrt(mx * mx + my * my) || 1;
             cx = p.w / 2 + mx / L * p.w * 0.25; cy = p.h / 2 + my / L * p.h * 0.2; spread = Math.max(p.w, p.h) * 0.3; }
      for (var t = 0; t < 12; t++) {
        lx = cx + (R() - 0.5) * 2 * spread; ly = cy + (R() - 0.5) * 2 * spread;
        if (this.solidAt(foe, lx, ly)) break;
        if (t === 11) { lx = p.w / 2; ly = p.h / 2; }
      }
    }
    var miss = R() > hit;
    var w = this.toWorld(foe, lx, ly);
    if (miss) { w[0] += (R() - 0.5) * 900; w[1] += (R() - 0.5) * 900; }
    var fly = Math.sqrt((w[0] - g.x) * (w[0] - g.x) + (w[1] - g.y) * (w[1] - g.y)) / BOLT;
    this.ev.shots.push({ x0: g.x, y0: g.y, x1: w[0], y1: w[1], t0: this.t, dur: fly, side: sh.side, t: g.t, miss: miss });
    if (!miss) this.pending.push({ at: this.t + fly, ship: foe.n, lx: lx, ly: ly, fx: g.x, fy: g.y, T: T, k: g.k, by: sh.n });
  };
  Battle.prototype.shootCraft = function(sh, g, c) {
    var T = g.T, R = this.R;
    var hit = T.accF * (0.6 + 0.4 * sh.eff.bridge) * (c.role === 'bomber' ? 1.25 : c.role === 'shuttle' ? 1.2 : 1);
    var miss = R() > hit;
    var fly = Math.sqrt((c.x - g.x) * (c.x - g.x) + (c.y - g.y) * (c.y - g.y)) / BOLT;
    var ox = miss ? (R() - 0.5) * 120 : 0, oy = miss ? (R() - 0.5) * 120 : 0;
    this.ev.shots.push({ x0: g.x, y0: g.y, x1: c.x + ox, y1: c.y + oy, t0: this.t, dur: fly, side: sh.side, t: g.t, miss: miss, craft: 1 });
    if (!miss) this.pending.push({ at: this.t + fly, craft: c.id, dmg: T.fdmg });
  };

  // Удар долетел
  Battle.prototype.resolve = function(p) {
    if (p.craft) {
      var c = this.craftById(p.craft); if (!c || c.dead) return;
      if (c.idle) { c.idle = false; if (this.ships[c.home] && this.ships[c.home].dormant) this.wake(this.ships[c.home]); }
      c.hp -= p.dmg;
      if (c.hp <= 0) {
        c.dead = true; c.deadAt = this.t; this.ev.booms.push({ x: c.x, y: c.y, r: 30, t0: this.t, craft: 1 });
        this.ev.kills.push({ craft: c.type, side: c.side, party: c.party ? c.party.length : 0 });
        if (c.role === 'shuttle') this.shuttleLost(c);
        else if (this.ships[c.home]) this.ships[c.home].wLost++;
      }
      return;
    }
    var sh = this.ships[p.ship]; if (!sh || sh.dead) return;
    if (sh.dormant) this.wake(sh);
    sh.hurtT = this.t; if (p.by != null && p.by >= 0) sh.hurtBy = p.by;      // по кораблю бьют — крыло взлетает (и знает, кто)
    var T = p.T, dmg = T.dmg * p.k * (0.85 + this.R() * 0.3);
    var w = this.toWorld(sh, p.lx, p.ly);
    // щит сектора
    var s = this.sector(sh, p.fx, p.fy);
    sh.shHit[s] = 5;
    if (sh.sh[s] > 0) {
      var absorb = dmg * T.sh;
      if (absorb <= sh.sh[s]) {
        sh.sh[s] -= absorb;
        this.ev.shields.push({ ship: sh.n, s: s, x: w[0], y: w[1], t0: this.t });
        if (T.stun && this.R() < 0.25) this.hitRoom(sh, p.lx, p.ly, 0, T, 0.4);   // ионный удар пробивает и сквозь щит
        return;
      }
      // «щит упал» — только когда сектор держал заметный запас (не каждое добивание остатка)
      var was = sh.sh[s], solid = was > this.shieldCap(sh, s) * 0.15;
      dmg = (absorb - was) / T.sh; sh.sh[s] = 0;
      this.ev.shields.push({ ship: sh.n, s: s, x: w[0], y: w[1], t0: this.t, down: solid ? 1 : 0 });
    }
    sh.hull -= dmg * T.hull;
    this.ev.booms.push({ x: w[0], y: w[1], r: 14 + dmg * 1.4, t0: this.t, ship: sh.n, ion: !!T.stun });
    this.hitRoom(sh, p.lx, p.ly, dmg, T, 1);
    if (sh.hull <= 0) this.kill(sh, 'hull');
  };
  // Удар внутрь: поломка отсека, пожар, люди
  Battle.prototype.hitRoom = function(sh, lx, ly, dmg, T, k) {
    var p = sh.plan, x = Math.floor(lx), y = Math.floor(ly), n = 0;
    for (var r = 0; r <= 6 && !n; r++) {
      for (var dy = -r; dy <= r && !n; dy++) for (var dx = -r; dx <= r && !n; dx++) {
        var gx = x + dx, gy = y + dy;
        if (gx < 0 || gy < 0 || gx >= p.w || gy >= p.h) continue;
        n = p.room[gy * p.w + gx];
      }
    }
    var c = sh.crew, armor = 1, tt = null;
    if (n) { tt = p.roomByN[n] && p.roomByN[n].t; armor = ARMOR[tt] || 1; }
    k *= armor;
    if (n) c.damageRoom(n, Math.min(ROOM_CAP[tt] || 30, (dmg || 6) * T.sys * 0.7 * k), T.stun ? T.stun * k : 0);
    if (dmg > 0) {
      if (this.R() < T.fire * Math.min(2, dmg / 12)) c.ignite(lx, ly, 30 + this.R() * 40);
      c.blast(lx, ly, 2 + dmg / 12, 50 + dmg * 3 * T.hull);
    }
  };
  // ---------------------------------------------------------------- столкновения
  // Корпус корабля — цепочка кругов по силуэту плана (вдоль длины): длинный
  // корабль — длинная цепочка, у носа круги уже. Малые корабли и шаттлы
  // пролетают над и под корпусами — их это не касается.
  function hullCircles(plan) {
    if (plan._cols) return plan._cols;
    var W = plan.w, H = plan.h, M = plan.cellM, len = H * M;
    // полоса — около 90 м длины корпуса: клин Венатора и диск Лукрехалка ложатся плотно
    var y, x, K = Math.max(4, Math.min(18, Math.round(len / 90))), out = [];
    for (var k = 0; k < K; k++) {
      var y0 = Math.floor(k * H / K), y1 = Math.floor((k + 1) * H / K), mn = 1e9, mx = -1e9;
      for (y = y0; y < y1; y++) for (x = 0; x < W; x++) if (plan.kind[y * W + x]) { if (x < mn) mn = x; if (x > mx) mx = x; }
      if (mx < mn) continue;
      // широкая полоса (борт шире полосы) — делим поперёк, чтобы круги не торчали за нос и корму;
      // пустые куски (середина «бублика» Лукрехалка) пропускаем
      var n = Math.max(1, Math.ceil((mx - mn + 1) / Math.max(1, y1 - y0)));
      for (var c = 0; c < n; c++) {
        var x0 = mn + Math.floor(c * (mx - mn + 1) / n), x1 = mn + Math.floor((c + 1) * (mx - mn + 1) / n);
        var a0 = 1e9, a1 = -1e9, b0 = 1e9, b1 = -1e9;
        for (y = y0; y < y1; y++) for (x = x0; x < x1; x++) if (plan.kind[y * W + x]) { if (x < a0) a0 = x; if (x > a1) a1 = x; if (y < b0) b0 = y; if (y > b1) b1 = y; }
        if (a1 < a0) continue;
        var hw = (a1 - a0 + 1) / 2 * M, hh = (b1 - b0 + 1) / 2 * M;
        // uf — вперёд от центра корабля, ux — к правому борту; радиус покрывает кусок
        out.push({ uf: -((b0 + b1 + 1) / 2 - H / 2) * M, ux: ((a0 + a1 + 1) / 2 - W / 2) * M, r: Math.max(hw, hh) * 1.02 });
      }
    }
    plan._cols = out;
    // радиус охвата всей цепочки — для быстрого отсева дальних пар
    plan._colR = 0;
    for (k = 0; k < out.length; k++) plan._colR = Math.max(plan._colR, Math.sqrt(out[k].uf * out[k].uf + out[k].ux * out[k].ux) + out[k].r);
    return out;
  }
  Battle.prototype.circles = function(sh) {
    var cs = hullCircles(sh.plan), c = Math.cos(sh.hd), s = Math.sin(sh.hd), out = [];
    for (var i = 0; i < cs.length; i++) out.push([sh.x + c * cs[i].uf - s * cs[i].ux, sh.y + s * cs[i].uf + c * cs[i].ux, cs[i].r]);
    return out;
  };
  // Касание корпусов: развести (тяжёлый сдвигается меньше), погасить ход в сторону
  // удара; на скорости — удар по врагу: корпус, отсек у места удара, пожар и раненые
  var RAM_V = 10, RAM_K = 4;
  Battle.prototype.collide = function(dt) {
    var S = this.ships, i, j;
    for (i = 0; i < S.length; i++) {
      var a = S[i]; if (a.dead) continue;
      for (j = i + 1; j < S.length; j++) {
        var b = S[j]; if (b.dead) continue;
        hullCircles(a.plan); hullCircles(b.plan);
        var dx = b.x - a.x, dy = b.y - a.y, reach = a.plan._colR + b.plan._colR + 10;
        if (dx * dx + dy * dy > reach * reach) continue;
        // до трёх проходов: малый корабль между двумя кругами большого выталкивается целиком
        for (var it = 0; it < 3 && !a.dead && !b.dead; it++) if (!this.collidePair(a, b, dt, it === 0)) break;
        if (a.dead) break;
      }
    }
  };
  Battle.prototype.collidePair = function(a, b, dt, first) {
    var ca = this.circles(a), cb = this.circles(b), best = null, sx = 0, sy = 0;
    for (var p = 0; p < ca.length; p++) for (var q = 0; q < cb.length; q++) {
      var ex = ca[p][0] - cb[q][0], ey = ca[p][1] - cb[q][1], rr = ca[p][2] + cb[q][2], d2 = ex * ex + ey * ey;
      if (d2 >= rr * rr) continue;
      var d = Math.sqrt(d2) || 0.01, depth = rr - d;
      sx += ex / d * depth; sy += ey / d * depth;
      if (!best || depth > best.depth) best = { depth: depth, nx: ex / d, ny: ey / d, x: (ca[p][0] * cb[q][2] + cb[q][0] * ca[p][2]) / rr, y: (ca[p][1] * cb[q][2] + cb[q][1] * ca[p][2]) / rr };
    }
    if (!best) return false;
    // выталкивать по сумме всех касаний (внутри «диска» из кругов одна пара толкала бы в соседний круг)
    var sl = Math.sqrt(sx * sx + sy * sy);
    if (sl > 0.01) { best.nx = sx / sl; best.ny = sy / sl; }
    // n — от b к a; массы — по корпусу класса. «Упёрся» (снять приказ, если не движется) — о врага или
    // о своего, что стоит в точке курса; толчея своих по пути приказ не снимает
    if (a.side !== b.side || blocksGoal(a, b)) a.touchT = this.t;
    if (a.side !== b.side || blocksGoal(b, a)) b.touchT = this.t;
    var ma = a.hullMax, mb = b.hullMax, ka = mb / (ma + mb), kb = ma / (ma + mb);
    a.x += best.nx * best.depth * ka; a.y += best.ny * best.depth * ka;
    b.x -= best.nx * best.depth * kb; b.y -= best.ny * best.depth * kb;
    // скорость сближения по линии удара
    var va = -(Math.cos(a.hd) * best.nx + Math.sin(a.hd) * best.ny) * a.v, vb = (Math.cos(b.hd) * best.nx + Math.sin(b.hd) * best.ny) * b.v;
    var close = va + vb;
    if (va > 0) a.v *= Math.max(0, 1 - va / Math.max(1, Math.abs(a.v)) * 0.9);
    if (vb > 0) b.v *= Math.max(0, 1 - vb / Math.max(1, Math.abs(b.v)) * 0.9);
    this.place(a); this.place(b);
    var key = a.n < b.n ? a.n + ':' + b.n : b.n + ':' + a.n;
    this.ramT = this.ramT || {};
    // удар — по скорости сверх «притирания» и по доле чужой массы (малый о большой — больно малому);
    // свои корабли друг друга не бьют: рулевые расходятся, корпуса только расталкиваются
    if (first && a.side !== b.side && close > RAM_V && this.t - (this.ramT[key] || -99) > 4) {
      this.ramT[key] = this.t;
      this.ram(a, (close - RAM_V) * RAM_K * 2 * ka, best.x, best.y);
      this.ram(b, (close - RAM_V) * RAM_K * 2 * kb, best.x, best.y);
      this.ev.booms.push({ x: best.x, y: best.y, r: 40 + close * 3, t0: this.t });           // удар видно обеим сторонам
      this.ev.rams = this.ev.rams || [];
      this.ev.rams.push({ a: a.n, b: b.n, v: Math.round(close) });
    }
    return true;
  };
  // Удар корпусом о корпус: щит сектора не держит (это не болт), бьёт по броне
  Battle.prototype.ram = function(sh, dmg, wx, wy) {
    if (sh.dead || dmg <= 0) return;
    var l = this.toLocal(sh, wx, wy), p = sh.plan;
    var lx = Math.max(1, Math.min(p.w - 2, l[0])), ly = Math.max(1, Math.min(p.h - 2, l[1]));
    sh.hull -= dmg;
    // по отсеку — как тяжёлый залп, не больше: пробоина у места удара, а не полкорабля
    this.hitRoom(sh, lx, ly, Math.min(40, dmg * 0.6), GUNS.heavy, 1);
    if (sh.hull <= 0) this.kill(sh, 'ram');
  };
  // Корабль o занимает точку курса корабля sh
  function blocksGoal(sh, o) {
    var q = sh.order; if (!q || q.face) return false;
    var dx = o.x - q.x, dy = o.y - q.y, r = (o.len + sh.len) / 2 + 200;
    return dx * dx + dy * dy < r * r;
  }
  // Обход: впереди по курсу чужой корпус — отвернуть и сбавить ход (ИИ и курс игрока)
  Battle.prototype.avoid = function(sh, want, wantV) {
    var best = null, bd = 1e18, ord = sh.order, follow = null;
    // до точки курса: кто стоит дальше неё, тот не мешает (строй у точки — соседи по бокам и за ней)
    var togo = ord && !ord.face ? Math.sqrt((ord.x - sh.x) * (ord.x - sh.x) + (ord.y - sh.y) * (ord.y - sh.y)) : 1e18;
    for (var i = 0; i < this.ships.length; i++) {
      var o = this.ships[i]; if (o === sh || o.dead) continue;
      // игрок сам повёл корабль на врага (точка на его корпусе или рядом) — это таран, не обходим
      if (ord && o.side !== sh.side) { hullCircles(o.plan); var tx = ord.x - o.x, ty = ord.y - o.y; if (tx * tx + ty * ty < (o.plan._colR + 300) * (o.plan._colR + 300)) continue; }
      var dx = o.x - sh.x, dy = o.y - sh.y, d = Math.sqrt(dx * dx + dy * dy), clear = (sh.len + o.len) / 2 + 250 + Math.abs(sh.v) * 10;
      if (d > clear) continue;
      if (d - (o.len + o.wid) / 4 > togo) continue;
      var off = wrap(Math.atan2(dy, dx) - want);
      if (Math.abs(off) > 1.1) continue;                     // не по курсу
      // насколько пройдём мимо: боковой зазор до центра другого корабля
      // ширина другого поперёк нашего курса — по его развороту (стоит бортом — шире, носом — уже)
      var oa = wrap(o.hd - want), across = Math.abs(Math.sin(oa)) * o.len / 2 + Math.abs(Math.cos(oa)) * o.wid / 2;
      var side = Math.abs(Math.sin(off)) * d, need = sh.wid / 2 + across + 150;
      if (side > need) continue;
      // свой идёт впереди туда же — не отворачивать, а держаться за ним (колонна, не толчея)
      if (o.side === sh.side && o.v > 3 && Math.cos(wrap(o.hd - want)) > 0.6 && Math.abs(off) < 0.8) {
        var fv = o.v * Math.max(0.5, Math.min(1, (d - (sh.len + o.len) / 2) / 400));
        if (follow == null || fv < follow) follow = fv;
        continue;
      }
      if (d < bd) { bd = d; best = { off: off, d: d, clear: clear, stop: o.side !== sh.side || blocksGoal(sh, o) }; }
    }
    if (!best) return follow == null || follow >= wantV ? null : { want: want, wantV: follow };
    if (follow != null) wantV = Math.min(wantV, follow);
    if (best.stop) sh.touchT = Math.max(sh.touchT || -99, this.t - 1.5);   // обходит чужого или своего в точке — «упёрся» (для приказа)
    var k = 1 - best.d / best.clear;
    // отвернуть в ту сторону, где он «уже» сбоку; чем ближе — тем круче и медленнее
    return { want: want - (best.off >= 0 ? 1 : -1) * (0.5 + 0.7 * k), wantV: wantV * Math.max(0.15, 1 - k * 1.2) };
  };
  Battle.prototype.kill = function(sh, why) {
    if (sh.dead) return;
    sh.dead = true; sh.deadAt = this.t; sh.why = why; sh.hull = Math.max(0, sh.hull); sh.crit = 0; sh.order = null;
    this.ev.booms.push({ x: sh.x, y: sh.y, r: sh.len * 0.6, t0: this.t, big: 1, ship: sh.n });
    this.ev.kills.push({ ship: sh.n, side: sh.side, why: why });
    for (var i = 0; i < this.craft.length; i++) if (this.craft[i].home === sh.n && this.craft[i].docked) this.craft[i].dead = true;
  };
  Battle.prototype.checkEnd = function() {
    if (this.over >= 0) return;
    var alive = [0, 0, 0];
    for (var i = 0; i < this.ships.length; i++) if (!this.ships[i].dead) alive[this.ships[i].side]++;
    if (!alive[0] && alive[1]) this.over = 1;
    else if (!alive[1] && alive[0]) this.over = 0;
    else if (!alive[0] && !alive[1]) this.over = 2;
  };

  // ---------------------------------------------------------------- малые корабли
  Battle.prototype.craftById = function(id) {
    for (var i = 0; i < this.craft.length; i++) if (this.craft[i].id === id) return this.craft[i];
    return null;
  };
  // Вылет из ангара: по одному каждые 1,5 с, звеньями по 4, если ангар цел
  Battle.prototype.launch = function(sh, dt) {
    if (!sh.hangar.length) return;
    sh.launchT -= dt;
    if (sh.launchT > 0 || sh.eff.hangar < 0.3) return;
    // в ангаре — машины поштучно (как в игре: одна строка ships — одна машина); вылет по одной,
    // звеньями по четыре с паузой
    // slot — номер машины в ангаре игры (по порядку): по нему сервер пишет, какая машина сбита; севшая взлетает с той целостью, что была
    var type = sh.hangar.shift(), slot = sh.bay && sh.bay.length ? sh.bay.shift() : (sh.launched || 0);
    var hpK = sh.bayHp[slot] != null ? sh.bayHp[slot] : 1; delete sh.bayHp[slot];
    sh.launched = (sh.launched || 0) + 1;
    sh.wing = (sh.wing || 0) + 1;
    if (sh.wing >= 4) { sh.wing = 0; sh.launchT = 6; } else sh.launchT = 1.5;
    // звенья вылетают по очереди из всех ангаров корабля
    var hs = [];
    for (var i = 0; i < sh.plan.rooms.length; i++) if (sh.plan.rooms[i].t === 'hangar') hs.push(sh.plan.rooms[i]);
    var h = hs.length ? hs[(sh.wingN || 0) % hs.length] : null;
    if (sh.wing === 0) sh.wingN = (sh.wingN || 0) + 1;
    var w = h ? this.toWorld(sh, h.cx + (sh.wing - 1.5) * 6, h.y + 4) : [sh.x, sh.y];
    var C = CRAFT[type];
    this.craft.push({ id: this.nextCraft++, type: type, role: C.role, img: C.img, side: sh.side, home: sh.n,
                      x: w[0], y: w[1], hd: sh.hd, v: C.speed * 0.6, hp: C.hp * Math.max(0.05, hpK), max: C.hp, speed: C.speed,
                      cd: 1 + this.R(), tgt: null, mode: 'go', dead: false, len: C.len, born: this.t, slot: slot });
  };
  // Авиакрыло: раз в полсекунды — взлетать или садиться (по режиму и обстановке); в воздухе — вылет по одной
  Battle.prototype.wingStep = function(sh, dt) {
    sh.wT = (sh.wT || 0) - dt;
    if (sh.wT <= 0) {
      sh.wT = 0.5;
      // хозяина нет в игре (держит позицию) — крыло само: защищается и бьёт тех, кто подошёл
      var mode = sh.guard ? 'auto' : (WING_MODES[sh.wmode] ? sh.wmode : 'auto');
      sh.wCalm = this.wingThreat(sh) ? 0 : (sh.wCalm == null ? WING_CALM : sh.wCalm) + 0.5;
      var was = sh.wOut;
      sh.wOut = mode === 'out' || (mode === 'auto' && sh.wCalm < WING_CALM);
      // поднялись по тревоге — первая машина через 1–2,5 с (стартовая пауза боя — только для начала боя)
      if (sh.wOut && !was && sh.launchT > 3) sh.launchT = 1 + (sh.n % 4) * 0.5;
      for (var i = 0; i < this.craft.length; i++) {
        var c = this.craft[i]; if (c.dead || c.home !== sh.n || c.role === 'shuttle') continue;
        c.ret = !sh.wOut;
      }
      // в ангаре чинят: 2% в секунду, если ангар цел
      if (sh.eff.hangar >= 0.3) for (var k in sh.bayHp) if (sh.bayHp[k] < 1) sh.bayHp[k] = Math.min(1, sh.bayHp[k] + 0.01);
    }
    if (sh.wOut) this.launch(sh, dt);
  };
  // Враг рядом: корабль под огнём (15 с), его цель видна, бодрствующий враг или чужая машина ближе WING_R
  Battle.prototype.wingThreat = function(sh) {
    if (this.t - sh.hurtT < 15) return true;
    var f = sh.foeT != null ? this.ships[sh.foeT] : null;
    if (f && !f.dead && f.side !== sh.side && this.sees(sh.side, f)) return true;
    var R2 = WING_R * WING_R, i, dx, dy;
    for (i = 0; i < this.ships.length; i++) {
      var o = this.ships[i]; if (o.dead || o.dormant || o.side === sh.side || !this.sees(sh.side, o)) continue;
      dx = o.x - sh.x; dy = o.y - sh.y; if (dx * dx + dy * dy < R2) return true;
    }
    for (i = 0; i < this.craft.length; i++) {
      var c = this.craft[i]; if (c.dead || c.idle || c.side === sh.side || (this.fog && !this.visC[sh.side][c.id])) continue;
      dx = c.x - sh.x; dy = c.y - sh.y; if (dx * dx + dy * dy < R2) return true;
    }
    return false;
  };
  // Кого крыло бьёт: цель корабля (видна), тот, кто по нему бьёт, иначе ближайший бодрствующий враг в WING_R
  Battle.prototype.wingFoe = function(sh) {
    var f = sh.foeT != null ? this.ships[sh.foeT] : null;
    if (f && !f.dead && f.side !== sh.side && this.sees(sh.side, f)) return f;
    f = sh.hurtBy != null && this.t - sh.hurtT < 20 ? this.ships[sh.hurtBy] : null;
    if (f && !f.dead && f.side !== sh.side && this.sees(sh.side, f)) return f;
    var best = null, bd = WING_R * WING_R;
    for (var i = 0; i < this.ships.length; i++) {
      var o = this.ships[i]; if (o.dead || o.dormant || o.side === sh.side || !this.sees(sh.side, o)) continue;
      var dx = o.x - sh.x, dy = o.y - sh.y, d = dx * dx + dy * dy; if (d < bd) { bd = d; best = o; }
    }
    return best;
  };
  // Режим крыла: 'auto' | 'out' | 'dock'
  Battle.prototype.setWing = function(shipN, mode) {
    var sh = this.ships[shipN]; if (!sh || sh.dead || !WING_MODES[mode]) return false;
    sh.wmode = mode; sh.wT = 0;
    if (mode === 'out' && sh.launchT > 1.5) sh.launchT = 1.5;          // «В бой» — первая машина почти сразу
    return true;
  };
  // Куда садятся: середина ангара (первого), без ангара — к центру корабля
  Battle.prototype.hangarPt = function(sh) {
    for (var i = 0; i < sh.plan.rooms.length; i++) { var r = sh.plan.rooms[i]; if (r.t === 'hangar') return this.toWorld(sh, r.cx, r.cy); }
    return [sh.x, sh.y];
  };
  // Села: машина снова в ангаре — в том же месте списка и с той целостью, что была
  Battle.prototype.dockCraft = function(c, sh) {
    c.dead = true; c.docked = true; c.why = 'dock'; c.deadAt = this.t;
    sh.hangar.push(c.type); (sh.bay = sh.bay || []).push(c.slot); sh.bayHp[c.slot] = Math.max(0.05, c.hp / c.max);
  };
  // Малый корабль, который уже в полёте (в игре истребители стоят на орбите сами по себе):
  // приписывается к своему крупному кораблю home, с которого «взлетел»
  Battle.prototype.addCraft = function(type, side, home, x, y, hd, hpK) {
    var C = CRAFT[type]; if (!C || !this.ships[home]) return null;
    var c = { id: this.nextCraft++, type: type, role: C.role, img: C.img, side: side, home: home,
              x: x, y: y, hd: hd || 0, v: 0, hp: C.hp * Math.max(0.02, Math.min(1, hpK == null ? 1 : hpK)), max: C.hp, speed: C.speed,
              cd: 1 + this.R(), tgt: null, mode: 'go', dead: false, len: C.len, born: this.t, idle: !!this.ships[home].dormant };
    this.craft.push(c);
    return c;
  };
  Battle.prototype.flyCraft = function(dt) {
    var R = this.R, i, c;
    for (i = 0; i < this.craft.length; i++) {
      c = this.craft[i]; if (c.dead || c.idle) continue;
      var gx, gy, want;
      if (c.role === 'shuttle') { this.flyShuttle(c, dt); continue; }
      var hm = c.ret ? this.ships[c.home] : null, landD = null;
      if (hm && !hm.dead) {
        // на борт: к ангару своего корабля; машина с орбиты (не из ангара) или ангар разбит — держится рядом
        if (c.slot == null || hm.eff.hangar < 0.3) { var ob = this.t * 0.35 + c.id; gx = hm.x + Math.cos(ob) * 600; gy = hm.y + Math.sin(ob) * 600; }
        else {
          var hpt = this.hangarPt(hm); gx = hpt[0]; gy = hpt[1];
          landD = Math.sqrt((gx - c.x) * (gx - c.x) + (gy - c.y) * (gy - c.y));
          if (landD < 160) { this.dockCraft(c, hm); continue; }
        }
      } else if (c.role === 'fighter') {
        // истребитель: ближайший вражеский малый корабль (не дальше поводка от своего корабля), иначе прикрывает свой корабль
        var hs0 = this.ships[c.home], foe = this.nearCraft(c, 9000);
        if (foe && hs0 && !hs0.dead && (foe.x - hs0.x) * (foe.x - hs0.x) + (foe.y - hs0.y) * (foe.y - hs0.y) > WING_LEASH * WING_LEASH) foe = null;
        if (foe) {
          gx = foe.x; gy = foe.y;
          var dx = gx - c.x, dy = gy - c.y, d = Math.sqrt(dx * dx + dy * dy);
          c.cd -= dt;
          if (d < 700 && c.cd <= 0 && Math.abs(wrap(Math.atan2(dy, dx) - c.hd)) < 0.5) {
            c.cd = 0.6;
            var hitF = R() < 0.3;
            this.ev.shots.push({ x0: c.x, y0: c.y, x1: foe.x + (hitF ? 0 : (R() - 0.5) * 60), y1: foe.y + (hitF ? 0 : (R() - 0.5) * 60), t0: this.t, dur: d / 2500, side: c.side, t: 'f', miss: !hitF });
            if (hitF) this.pending.push({ at: this.t + d / 2500, craft: foe.id, dmg: 14 });
          }
        } else {
          // прикрытие: между своим кораблём и его целью (только видимой — к старым засечкам не летают)
          var home = this.ships[c.home];
          var tgtS = home && !home.dead ? this.wingFoe(home) : null;
          var cx = tgtS && home ? (home.x * 0.4 + tgtS.x * 0.6) : (home ? home.x : c.x), cy = tgtS && home ? (home.y * 0.4 + tgtS.y * 0.6) : (home ? home.y : c.y);
          var orb = this.t * 0.25 + c.id;
          gx = cx + Math.cos(orb) * 1400; gy = cy + Math.sin(orb) * 1400;
        }
      } else {
        // бомбардировщик: заход на отсек вражеского корабля, сброс, отход, новый заход
        var ship = c.tgt != null ? this.ships[c.tgt] : null, h0 = this.ships[c.home];
        // цель ушла в туман или увела далеко от своего корабля (а игрок её не давал) — бросить и выбрать заново
        if (ship && !ship.dead && (!this.sees(c.side, ship) ||
            (h0 && !h0.dead && h0.foeT !== ship.n && (ship.x - h0.x) * (ship.x - h0.x) + (ship.y - h0.y) * (ship.y - h0.y) > WING_LEASH * WING_LEASH))) ship = null;
        if (!ship || ship.dead) {
          var h = h0 || c, best = null, bd = 1e18;
          // цель своего корабля, иначе тот, кто по нему бьёт, иначе ближайший видимый — не дальше поводка от своего корабля
          var hft = h.foeT != null ? this.ships[h.foeT] : h.hurtBy != null && this.t - h.hurtT < 20 ? this.ships[h.hurtBy] : null;
          if (hft && !hft.dead && hft.side !== c.side && this.sees(c.side, hft)) { best = hft; bd = -1; }
          for (var s = 0; s < this.ships.length && bd >= 0; s++) {
            var o = this.ships[s]; if (o.dead || o.side === c.side || !this.sees(c.side, o)) continue;
            if ((o.x - h.x) * (o.x - h.x) + (o.y - h.y) * (o.y - h.y) > WING_LEASH * WING_LEASH) continue;
            var ddx = o.x - c.x, ddy = o.y - c.y, dd = ddx * ddx + ddy * ddy;
            if (dd < bd) { bd = dd; best = o; }
          }
          ship = best; c.tgt = best ? best.n : null; c.mode = 'go';
          c.room = best ? this.sysRoom(best, R() < 0.5 ? 'engine' : 'guns', { x: c.x, y: c.y }) : 0;
          if (!best) {
            // никого не видно — кружат у своего корабля (к старым засечкам не летят)
            var ob2 = this.t * 0.2 + c.id; gx = h.x + Math.cos(ob2) * 1800; gy = h.y + Math.sin(ob2) * 1800;
          }
        }
        if (ship) {
          var rm = ship.plan.roomByN[c.room], pt = rm ? this.toWorld(ship, rm.cx, rm.cy) : [ship.x, ship.y];
          var bx = pt[0] - c.x, by = pt[1] - c.y, bdist = Math.sqrt(bx * bx + by * by);
          if (c.mode === 'go') {
            gx = pt[0]; gy = pt[1];
            if (bdist < 420) {
              c.mode = 'out'; c.outT = 6;
              // сброс: удар по отсеку с большим шансом пожара
              var lx = rm ? rm.x + 1 + R() * (rm.w - 2) : ship.plan.w / 2, ly = rm ? rm.y + 1 + R() * (rm.h - 2) : ship.plan.h / 2;
              this.pending.push({ at: this.t + 0.4, ship: ship.n, lx: lx, ly: ly, fx: c.x, fy: c.y,
                                  T: { dmg: 11, sh: 0.7, hull: 1, sys: 1.3, fire: 0.8, stun: 0 }, k: 1, by: -1 });
              this.ev.shots.push({ x0: c.x, y0: c.y, x1: pt[0], y1: pt[1], t0: this.t, dur: 0.4, side: c.side, t: 'b', miss: false });
            }
          } else {
            c.outT -= dt;
            gx = c.x + Math.cos(c.hd) * 1000; gy = c.y + Math.sin(c.hd) * 1000;
            if (c.outT <= 0) { c.mode = 'go'; if (R() < 0.3 || c.retgt) { c.tgt = null; c.retgt = false; } }
          }
        }
      }
      if (!c.off) { var oa = c.id * 2.399; c.off = [Math.cos(oa) * (60 + (c.id % 4) * 35), Math.sin(oa) * (60 + (c.id % 4) * 35)]; }
      var far = (gx - c.x) * (gx - c.x) + (gy - c.y) * (gy - c.y) > 640000;     // дальше 800 м — держать строй
      if (far && landD == null) { gx += c.off[0]; gy += c.off[1]; }
      want = Math.atan2(gy - c.y, gx - c.x);
      c.hd = turnTo(c.hd, want, 2.2 * dt);
      // заход на посадку: сбросить ход у ангара (но не медленнее своего корабля)
      var vT = landD != null && landD < 1200 ? Math.min(c.speed, Math.max((hm.v || 0) + 40, 40 + landD * 0.4)) : c.speed;
      c.v += (vT - c.v) * Math.min(1, dt * (landD != null ? 1.6 : 0.8));
      c.x += Math.cos(c.hd) * c.v * dt; c.y += Math.sin(c.hd) * c.v * dt;
    }
    // убрать сбитых через 2 с
    if (this.craft.length > 40 && (this.t * 10 | 0) % 50 === 0) {
      var t = this.t; this.craft = this.craft.filter(function(x) { return !x.dead || t - (x.deadAt || t) < 2; });
    }
  };
  Battle.prototype.nearCraft = function(c, range) {
    var best = null, bd = range * range;
    for (var i = 0; i < this.craft.length; i++) {
      var o = this.craft[i]; if (o.dead || o.side === c.side || !this.visC[c.side][o.id]) continue;
      var dx = o.x - c.x, dy = o.y - c.y, d = dx * dx + dy * dy;
      if (o.role === 'bomber' || o.role === 'shuttle') d *= 0.6;
      if (d < bd) { bd = d; best = o; }
    }
    return best;
  };

  // ---------------------------------------------------------------- абордаж
  Battle.prototype.gunRoomFree = function(foe, side, g) {
    var bd = foe.crew.board, best = 0, bdist = 1e18, rooms = foe.plan.rooms;
    for (var i = 0; i < rooms.length; i++) {
      var r = rooms[i]; if (r.t !== 'gun' && r.t !== 'pdgun') continue;
      var st = bd.rs[r.n]; if (st && (st.cnt[side] || st.held)) continue;
      var w = this.toWorld(foe, r.cx, r.cy), dx = w[0] - g.x, dy = w[1] - g.y, d = dx * dx + dy * dy;
      if (d < bdist) { bdist = d; best = r.n; }
    }
    return best;
  };
  // Огонь по кораблю, где идёт свой абордаж: вести (по орудиям) или прекратить
  Battle.prototype.setHold = function(n, t, on) {
    var sh = this.ships[n], o = this.ships[t]; if (!sh || !o || o.side === sh.side) return;
    sh.hold = sh.hold || {}; sh.hold[t] = !!on;
  };
  Battle.prototype.ourBoard = function(side, o) {
    var bd = o.crew.board;
    return !!(bd && bd.started && bd.over < 0 && bd.att === side);
  };
  // Свободные бойцы десанта на корабле. all — и защитники своего корабля, что сейчас
  // не в перестрелке (контрабордаж: игрок сам снимает их с обороны)
  Battle.prototype.troopsOf = function(sh, all) {
    var out = [], ag = sh.crew.agents;
    for (var i = 0; i < ag.length; i++) {
      var a = ag[i];
      var st = sh.crew.rooms[a.home];
      // десант — те, кто в казармах (встал на пост погибшего расчётчика — нужен на посту)
      if (!a.alive || a.team !== sh.side || a.grp !== 'troops' || a.role !== 'reserve') continue;
      if (!st || !(st.t === 'troops' || st.t === 'droids' || st.t === 'vehicle' || st.t === 'armory')) continue;
      if (a.job && a.job.kind === 'defend' && !(all && !(a.tgt >= 0))) continue;
      if (a.job && a.job.kind === 'muster') continue;              // уже бежит к шлюзу
      if (a.stand) continue;                                         // на посту (поставил игрок) — на абордаж не идёт
      out.push(a);
    }
    return out;
  };
  // Можно ли идти на абордаж: { ok, why, party, cap, reinforce }
  Battle.prototype.canBoard = function(n, t, all) {
    var a = this.ships[n], b = this.ships[t];
    if (!a || !b || a.dead || b.dead) return { ok: false, why: 'цели нет', party: 0 };
    if (a.side === b.side) return { ok: false, why: 'это свой корабль', party: 0 };
    if (a.side === 2 || b.side === 2) return { ok: false, why: 'пиратов на абордаж не берут — только огнём', party: 0 };
    if (!this.sees(a.side, b)) return { ok: false, why: 'нет контакта с целью', party: 0 };
    // что видно игроку в полосе: зазор между корпусами, щит цели со стороны нашего корабля, стоят ли её двигатели
    var gx = b.x - a.x, gy = b.y - a.y, gapM = Math.sqrt(gx * gx + gy * gy) - (a.len + b.len) / 2;
    var sec0 = this.sector(b, a.x, a.y), cap0 = this.shieldCap(b, sec0);
    var hb0 = this.holder(b), beam = !!(hb0 && hb0.side === a.side);    // цель в луче нашей стороны
    var geo = { gap: Math.round(Math.max(0, gapM)), need: BOARD_GAP, sec: sec0, shK: Math.round(b.sh[sec0] / Math.max(1, cap0) * 100) / 100, stuck: b.eff.engine < 0.3 || beam, beam: beam };
    var res = function(o) { for (var k in geo) o[k] = geo[k]; return o; };
    var tro = this.troopsOf(a, all), avail = tro.length, cap = boardCap(b);
    geo.tro = avail;
    // меньше четырёх бойцов на абордаж не идут — кроме героя (джедай, ситх)
    var minP = tro.some(function(x) { return x.hero; }) ? 1 : 4;
    var bd = b.crew.board, on = !!(bd && bd.over < 0 && bd.att === a.side && bd.started);
    if (bd && bd.over < 0 && bd.started && bd.att !== a.side) return res({ ok: false, why: 'на борту цели уже идёт чужой абордаж', party: 0 });
    // в бою на борту уже свои — подкрепление: места в шлюзах за вычетом тех, кто там и в пути
    var inside = 0;
    if (on) { var ag = b.crew.agents; for (var i = 0; i < ag.length; i++) if (ag[i].alive && ag[i].team === a.side) inside++; }
    var party = Math.min(avail, Math.max(0, cap - inside - this.menTo(b) - (b.mustered || 0)));   // в шаттлах и на сборах у шлюзов
    for (var mi = 0; mi < this.musters.length; mi++) if (this.musters[mi].n === n) return res({ ok: false, why: 'десант уже бежит к шлюзу', party: 0, cap: cap });
    if (a.boardCd > 0) return res({ ok: false, why: 'шаттлы вернутся через ' + Math.ceil(a.boardCd) + ' с', party: party, cap: cap });
    var own = a.crew.board;
    if (avail < minP) return res({ ok: false, why: own && own.started && own.over < 0 ? 'десант обороняет свой корабль' : avail ? 'мало десанта: ' + avail + ', нужно от ' + minP + ' (или герой)' : 'на борту нет десанта', party: 0, cap: cap });
    if (party < minP) return res({ ok: false, why: 'шлюзы цели заняты своими', party: 0, cap: cap });
    var dx = b.x - a.x, dy = b.y - a.y, gap = Math.sqrt(dx * dx + dy * dy) - (a.len + b.len) / 2;
    if (gap > BOARD_GAP) return res({ ok: false, why: 'далеко: ' + (gap / 1000).toFixed(1) + ' км, нужно ближе ' + BOARD_GAP / 1000 + ' км', party: party, cap: cap });
    if (!on) {
      var s = this.sector(b, a.x, a.y), cap2 = this.shieldCap(b, s);
      var down = b.sh[s] <= cap2 * 0.15, stuck = b.eff.engine < 0.3 || beam;
      if (!down && !stuck) return res({ ok: false, why: 'щит цели с этой стороны ' + Math.round(b.sh[s] / Math.max(1, cap2) * 100) + '% — нужно ниже 15%, стоящие двигатели' + (a.tractor ? ' или наш притягивающий луч' : ''), party: party, cap: cap });
    }
    return res({ ok: true, why: '', party: party, cap: cap, reinforce: on });
  };
  // Шлюз корабля b, ближайший к точке from
  Battle.prototype.portFor = function(b, from) {
    var best = null, bd = 1e18, rooms = b.plan.rooms;
    for (var i = 0; i < rooms.length; i++) {
      var r = rooms[i]; if (r.t !== 'airlock' || !r.port) continue;
      var w = this.toWorld(b, r.port[0], r.port[1]), dx = w[0] - from.x, dy = w[1] - from.y, d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = r; }
    }
    return best;
  };
  // Абордаж: десант бежит из казарм к своему шлюзу, ближнему к цели; собрались — шаттлы
  // (по 12) летят к шлюзу цели. Места в шлюзах цели и откат шаттлов заняты с приказа.
  // now — сразу в шаттлах, без сборов (учения полигона)
  Battle.prototype.board = function(n, t, all, now) {
    if (this.ships[n] && this.ships[n].dormant) this.wake(this.ships[n]);
    // цель будить — только когда абордаж разрешён (видна, рядом, щит снят): иначе приказ «на абордаж» по номерам
    // будил бы всю орбиту, и чужие корабли в тумане тоже (аудит космоса, SPACE-BUG-003)
    var can = this.canBoard(n, t, all); if (!can.ok) return can;
    if (this.ships[t].dormant) this.wake(this.ships[t]);
    var a = this.ships[n], b = this.ships[t], lock = this.portFor(b, a);
    if (!lock) return { ok: false, why: 'у цели нет шлюзов' };
    var main = this.departFrom(a, this.troopsOf(a, all), b, can.party);
    var take = this.pickParty(a, can.party, all, main), i;
    var ports = now ? [] : this.departPorts(a, take, main);
    if (!ports.length) return this.shuttlesOut(a, b, lock, null, take.map(function(m) { return this.departOf(a, m); }, this), can.reinforce, 0);
    var k0 = Math.ceil(take.length / SHUTTLE_MAX);
    for (i = 0; i < take.length; i++) {
      var m = take[i], from = this.nearPort(ports, m);
      this.offDefence(a, m); a.crew.releaseJob(m);
      // каждый бежит к ближнему своему шлюзу или ангару — оттуда и взлетит его шаттл
      m.job = { kind: 'muster', room: from.n }; m.guard = 0; m.wait = 0; m.hold = 0;
      a.crew.go(m, from.n, a.crew.spotIn(from) || a.crew.rooms[from.n].anchor, 'muster');
      m.face = from.port ? Math.atan2(from.port[1] - (from.y + from.h / 2), from.port[0] - (from.x + from.w / 2)) : null;
    }
    b.mustered = (b.mustered || 0) + take.length;       // места в шлюзах цели заняты (враг сборов не видит)
    a.boardCd = BOARD_CD;
    var far = 0;
    for (i = 0; i < take.length; i++) { var fp = this.nearPort(ports, take[i]); far = Math.max(far, Math.abs(take[i].x - fp.cx) + Math.abs(take[i].y - fp.cy)); }
    this.musters.push({ n: n, t: t, lock: lock.n, men: take.length, out: 0,
                        max: Math.min(150, Math.max(MUSTER_MAX, far / 4.5 * 1.4 + 10)),     // большой корабль — бежать дольше
                        ids: take.map(function(m) { return m.id; }), t0: this.t, k0: k0, reinforce: !!can.reinforce });
    this.ev.boards.push({ n: n, t: t, count: take.length, shuttles: k0, muster: 1, reinforce: !!can.reinforce });
    return { ok: true, party: take.length, shuttles: k0, muster: true };
  };
  // Откуда стартуют шаттлы: шлюз или ангар, ближний к десанту (бежать по кораблю недолго);
  // из равных — тот, что ближе к цели
  // Отсеки, откуда взлетают абордажные шаттлы: шлюзы с выходом наружу, ангары, доки
  Battle.prototype.departRooms = function(a) {
    var out = [], rooms = a.plan.rooms;
    for (var i = 0; i < rooms.length; i++) {
      var r = rooms[i]; if (!((r.t === 'airlock' && r.port) || r.t === 'hangar' || r.t === 'dock')) continue;
      if (a.crew.rooms[r.n] && a.crew.rooms[r.n].anchor) out.push(r);
    }
    return out;
  };
  // Сколько бойцов летит к кораблю b в шаттлах
  Battle.prototype.menTo = function(b) {
    var n = 0;
    for (var i = 0; i < this.craft.length; i++) { var c = this.craft[i]; if (c.role === 'shuttle' && !c.dead && !c.back && c.tgt === b.n && c.party) n += c.party.length; }
    return n;
  };
  // Шлюзы отправки этой команды: ближние к бойцам, но не больше, чем шаттлов на всех (+1) —
  // иначе огромный корабль рассыпал бы десант по десятку шлюзов в шаттлы по двое
  Battle.prototype.departPorts = function(a, take, main) {
    var all = this.departRooms(a); if (!all.length || !take.length) return [];
    var cnt = {}, i, keep = Math.ceil(take.length / SHUTTLE_MAX) + 1;
    for (i = 0; i < take.length; i++) { var p = this.nearPort(all, take[i]); cnt[p.n] = (cnt[p.n] || 0) + 1; }
    var list = all.filter(function(r) { return cnt[r.n]; }).sort(function(x, y) { return cnt[y.n] - cnt[x.n]; }).slice(0, keep);
    if (main && list.indexOf(main) < 0 && list.length < keep) list.push(main);
    return list.length ? list : [main || all[0]];
  };
  Battle.prototype.nearPort = function(ports, m) {
    var best = ports[0], bd = 1e18;
    for (var i = 0; i < ports.length; i++) { var dx = ports[i].cx - m.x, dy = ports[i].cy - m.y, d = dx * dx + dy * dy; if (d < bd) { bd = d; best = ports[i]; } }
    return best;
  };
  // (оценка: сколько бежать ближним count бойцам до этого отсека)
  Battle.prototype.departFrom = function(a, pool, b, count) {
    if (!pool.length) return null;
    var best = null, bd = 1e18, rooms = a.plan.rooms, tl = this.toLocal(a, b.x, b.y), i, k;
    for (i = 0; i < rooms.length; i++) {
      var r = rooms[i]; if (!((r.t === 'airlock' && r.port) || r.t === 'hangar' || r.t === 'dock')) continue;
      if (!a.crew.rooms[r.n] || !a.crew.rooms[r.n].anchor) continue;
      var ds = [];
      for (k = 0; k < pool.length; k++) { var dx = pool[k].x - r.cx, dy = pool[k].y - r.cy; ds.push(Math.sqrt(dx * dx + dy * dy)); }
      ds.sort(function(p, q) { return p - q; });
      var far = ds[Math.min(ds.length, Math.max(1, count || 1)) - 1];          // последнему бежать дольше всех
      var ex = r.cx - tl[0], ey = r.cy - tl[1], d = far + Math.sqrt(ex * ex + ey * ey) * 0.05;
      if (d < bd) { bd = d; best = r; }
    }
    return best;
  };
  // Сборы у шлюза: все добежали (или вышло время) — посадка; цель пропала — отбой, бойцы по местам
  Battle.prototype.musterStep = function() {
    for (var i = this.musters.length - 1; i >= 0; i--) {
      var mu = this.musters[i], a = this.ships[mu.n], b = this.ships[mu.t];
      var gone = function() { if (b) b.mustered = Math.max(0, (b.mustered || 0) - mu.men); mu.men = 0; };
      var self = this;
      // назад на борт: идёт абордаж своего корабля — в оборону, иначе по местам
      var back = function(list) {
        var hb = a && a.crew.board, def = hb && hb.started && hb.over < 0 && hb.def === a.side;
        for (var q = 0; q < list.length; q++) { a.crew.releaseJob(list[q]); if (def) hb.toDefend(list[q]); else a.crew.sendPost(list[q]); }
        if (def && list.length) hb.makeDefSquads();
      };
      if (!a || a.dead) { gone(); this.musters.splice(i, 1); continue; }
      var c = a.crew, W = c.w, list = [], ready = [], byRoom = {};
      for (var k = 0; k < mu.ids.length; k++) {
        var m = c.agents[mu.ids[k]];
        if (!m || !m.alive || !m.job || m.job.kind !== 'muster') continue;
        list.push(m);
        if (a.plan.room[Math.floor(m.y) * W + Math.floor(m.x)] === m.job.room) { ready.push(m); (byRoom[m.job.room] = byRoom[m.job.room] || []).push(m); }
      }
      var bb = b && b.crew.board, foreign = bb && bb.started && bb.over < 0 && bb.att !== a.side;
      var late = this.t - mu.t0 > (mu.max || MUSTER_MAX);
      // погибшие на сборах места в шлюзах цели больше не держат
      if (list.length < mu.men && b) { var lost = mu.men - list.length; mu.men -= lost; b.mustered = Math.max(0, (b.mustered || 0) - lost); }
      if (!list.length) {
        // никого: улетели — конец сборов; не улетел никто (сняли в оборону, погибли) — отбой, шаттлы свободны
        if (!mu.out) { a.boardCd = 0; this.ev.boards.push({ n: mu.n, t: mu.t, cancel: 1, count: 0 }); }
        gone(); this.musters.splice(i, 1); continue;
      }
      var far2 = b && !b.dead ? Math.sqrt((b.x - a.x) * (b.x - a.x) + (b.y - a.y) * (b.y - a.y)) - (a.len + b.len) / 2 : 0;
      if (!b || b.dead || foreign || far2 > BOARD_GAP * 1.5 || (late && !ready.length)) {
        // отбой: цели нет, ушла далеко или не собрались — по местам (или в оборону)
        back(list);
        if (!mu.out) a.boardCd = 0;
        gone(); this.musters.splice(i, 1);
        this.ev.boards.push({ n: mu.n, t: mu.t, cancel: 1, count: list.length });
        continue;
      }
      // посадка у каждого шлюза: шаттл заполнился (12) — стартует сразу; последний ждёт
      // остальных, кто бежит к этому же шлюзу, до срока
      for (var rn in byRoom) {
        var here = byRoom[rn], left = list.filter(function(x) { return x.job.room === +rn; }).length;
        while (here.length && (here.length >= SHUTTLE_MAX || here.length === left || late)) {
          var grp = here.splice(0, SHUTTLE_MAX), party = [];
          for (k = 0; k < grp.length; k++) { party.push(this.departOf(a, grp[k])); list.splice(list.indexOf(grp[k]), 1); left--; }
          var gn = Math.min(mu.men, grp.length); mu.men -= gn; b.mustered = Math.max(0, (b.mustered || 0) - gn);
          this.shuttlesOut(a, b, b.plan.roomByN[mu.lock], a.plan.roomByN[+rn], party, mu.reinforce, 1);
          mu.out += party.length;
        }
      }
      if (late && list.length) { back(list); this.ev.boards.push({ n: mu.n, t: mu.t, left: list.length }); }   // не добежали — остаются
      if (late || !list.length) { gone(); this.musters.splice(i, 1); }
    }
  };
  // Шаттлы с командой стартуют от своего шлюза (from) к шлюзу цели (lock)
  Battle.prototype.shuttlesOut = function(a, b, lock, from, party, reinforce, mustered) {
    var i, n = a.n, t = b.n;
    if (!lock || !party.length) return { ok: false, why: 'некому лететь' };
    var p0 = from ? (from.port ? this.toWorld(a, from.port[0], from.port[1]) : this.toWorld(a, from.cx, from.cy)) : [a.x, a.y];
    var C = CRAFT.shuttle, k = 0;
    for (i = 0; i < party.length; i += SHUTTLE_MAX) {
      var grp = party.slice(i, i + SHUTTLE_MAX), off = (k++ - 1) * 60;
      this.craft.push({ id: this.nextCraft++, type: 'shuttle', role: 'shuttle', img: null, side: a.side, home: n, tgt: t, lock: lock.n,
                        port: lock.port, party: grp, x: p0[0] + off, y: p0[1] - off, hd: Math.atan2(b.y - a.y, b.x - a.x), v: C.speed * 0.4,
                        hp: C.hp, max: C.hp, speed: C.speed, cd: 0, dead: false, len: C.len, born: this.t, faction: a.plan.faction });
      b.inbound++;
    }
    a.boardCd = BOARD_CD;
    this.ev.boards.push({ n: n, t: t, count: party.length, shuttles: k, reinforce: !!reinforce, launch: mustered ? 1 : 0 });
    return { ok: true, party: party.length, shuttles: k };
  };
  // Снять с корабля команду абордажа: бойцы и 1–2 инженера (вскрывать двери, ставить заряд)
  // Кто идёт на абордаж: бойцы и 1–2 инженера (вскрывать двери, ставить заряд)
  // near — отсек отправки: из равных берутся те, кто к нему ближе (бежать недолго)
  Battle.prototype.pickParty = function(a, count, all, near) {
    // инженеры — купленные бойцы-инженеры трюма (экипаж корабля на абордаж не идёт)
    var all0 = this.troopsOf(a, all), engs = all0.filter(function(x) { return x.eng; }), troops = all0.filter(function(x) { return !x.eng; });
    var dist = function(m) { if (!near) return 0; var dx = m.x - near.cx, dy = m.y - near.cy; return dx * dx + dy * dy; };
    // герои — первыми (малой группой идут только с героем); инженер — в группе от четырёх
    troops.sort(function(p, q) { return ((q.hero ? 1 : 0) - (p.hero ? 1 : 0)) || (dist(p) - dist(q)); });
    engs.sort(function(p, q) { return dist(p) - dist(q); });
    var nEng = count >= 4 ? Math.min(engs.length, count >= 8 ? 2 : 1) : 0;
    return troops.slice(0, count - nEng).concat(engs.slice(0, nEng));
  };
  // Снят с обороны своего корабля: из отряда защитников вон
  Battle.prototype.offDefence = function(a, m) {
    if (!(m.job && m.job.kind === 'defend')) return;
    var ob = a.crew.board, oq = ob && m.dsq && ob.dsq[m.dsq - 1];
    if (oq) { var oi = oq.members.indexOf(m.id); if (oi >= 0) oq.members.splice(oi, 1); }
    m.job = null; m.guard = 0; m.dsq = 0; m.post = null;
  };
  // Боец сел в шаттл: с корабля его нет, в отряде абордажа — его запись
  Battle.prototype.departOf = function(a, m) {
    this.offDefence(a, m);
    a.crew.releaseJob(m); a.crew.claimCell(m, null);
    m.alive = false; m.gone = true;                       // ушёл на шаттл
    var st = a.crew.rooms[m.home]; if (st) st.assigned--;
    return { fig: m.fig, wpn: m.wpn || this.wpnFor(a, m), eng: !!m.eng, src: m.id, hp: m.hp, hpMax: m.hpMax, dmgK: m.dmgK || 1,
             utype: m.utype || '', uname: m.uname || '', uid: m.uid || '', hero: !!m.hero, medicU: !!m.medicU };
  };
  // Снять с корабля команду абордажа сразу (полигон: высадка без сборов)
  Battle.prototype.takeParty = function(a, count, all) {
    var take = this.pickParty(a, count, all), party = [];
    for (var i = 0; i < take.length; i++) party.push(this.departOf(a, take[i]));
    return party;
  };
  // Высадка без полёта (полигон и замеры): команда сразу в шлюзе цели
  Battle.prototype.forceBoard = function(n, t, count) {
    var a = this.ships[n], b = this.ships[t];
    if (!a || !b || a.dead || b.dead || a.side === b.side) return false;
    var lock = this.portFor(b, a); if (!lock) return false;
    var bd = b.crew.board;
    if (bd && bd.started && bd.over < 0 && bd.att !== a.side) return false;
    var party = this.takeParty(a, Math.min(count || 30, boardCap(b)), true);
    if (!party.length) return false;
    b.inbound++;
    this.dock({ side: a.side, home: n, party: party, lock: lock.n }, b);
    this.ev.boards.push({ n: n, t: t, count: party.length, shuttles: 0 });
    return true;
  };
  Battle.prototype.wpnFor = function(sh, m) {
    var id = sh.figIds && sh.figIds[m.fig];
    if (id && SWBoard.FIG_WPN[id]) return SWBoard.FIG_WPN[id];
    return sh.plan.faction === 'cis' ? (m.id % 4 === 3 ? 'b2' : 'b1') : (m.id % 5 === 4 ? 'heavy' : 'rifle');
  };
  Battle.prototype.flyShuttle = function(c, dt) {
    var b = this.ships[c.tgt], home = this.ships[c.home], gx, gy;
    if (!b || b.dead) {
      // цели нет — назад; команда возвращается в казармы
      if (!c.back) { c.back = true; if (b) b.inbound = Math.max(0, b.inbound - 1); c.speed = CRAFT.shuttle.speed; }
      if (!home || home.dead) { c.dead = true; c.deadAt = this.t; return; }
      gx = home.x; gy = home.y;
      if ((gx - c.x) * (gx - c.x) + (gy - c.y) * (gy - c.y) < Math.pow(home.len * 0.4, 2)) { this.shuttleHome(c, home); return; }
    } else {
      var w = this.toWorld(b, c.port[0], c.port[1]); gx = w[0]; gy = w[1];
      var dx = gx - c.x, dy = gy - c.y, d = Math.sqrt(dx * dx + dy * dy);
      if (d < 70) { this.dock(c, b); return; }
      // у цели — сбросить ход, чтобы не проскочить
      c.speed = CRAFT.shuttle.speed * Math.max(0.35, Math.min(1, d / 900));
    }
    var want = Math.atan2(gy - c.y, gx - c.x);
    c.hd = turnTo(c.hd, want, 2.4 * dt);
    c.v += (c.speed - c.v) * Math.min(1, dt * 1.2);
    c.x += Math.cos(c.hd) * c.v * dt; c.y += Math.sin(c.hd) * c.v * dt;
  };
  Battle.prototype.dock = function(c, b) {
    c.dead = true; c.docked = true; c.deadAt = this.t;
    b.inbound = Math.max(0, b.inbound - 1);
    var bd = b.crew.board;
    // первый абордаж — новый бой внутри; прошлый отбит — тот же корабль, двери и турели как есть
    if (!bd) bd = new SWBoard.Board(b.crew, { flagship: b.len >= 1200, figIds: b.figIds, seed: b.n * 131 + Math.floor(this.t) });
    else if (bd.over >= 0) bd.reopen();
    if (bd.att !== c.side) return;
    bd.inFlight = b.inbound;
    bd.defManual = this.defHuman ? !!this.defHuman(b) : !this.aiBoard[bd.def];   // оборона за игроком — отряды собирает он
    bd.addParty(c.party, c.lock, !this.aiBoard[c.side]);       // сторона за игроком — отряды ждут его приказов
    this.ev.boards.push({ dock: 1, n: c.home, t: b.n, count: c.party.length });
  };
  Battle.prototype.shuttleLost = function(c) {
    var b = this.ships[c.tgt];
    if (b && !c.back) b.inbound = Math.max(0, b.inbound - 1);
    // команда сбитого шаттла погибла: на родном корабле — уже не «ушёл», а потерян (запишется в базу как погибший)
    var home = this.ships[c.home], ag = home && home.crew && home.crew.agents;
    if (ag && c.party) for (var i = 0; i < c.party.length; i++) { var m = ag[c.party[i].src]; if (m && m.gone) { m.gone = false; m.lost = true; m.alive = false; } }
  };
  Battle.prototype.shuttleHome = function(c, home) {
    c.dead = true; c.docked = true; c.deadAt = this.t;
    var ag = home.crew.agents, hb = home.crew.board, fight = !!(hb && hb.started && hb.over < 0), back = 0;
    for (var i = 0; i < c.party.length; i++) {
      var m = ag[c.party[i].src]; if (!m || !m.gone) continue;
      m.alive = true; m.gone = false; m.job = null; m.dsq = 0; var st = home.crew.rooms[m.home]; if (st) st.assigned++;
      if (fight) { hb.toDefend(m); back++; }              // свой корабль под абордажем — сразу в оборону
      else home.crew.sendPost(m);
    }
    if (back) hb.makeDefSquads();                         // вернувшиеся — одним новым отрядом
  };
  // Итоги абордажей и решения ИИ
  Battle.prototype.boardStep = function(dt) {
    var i, sh;
    this.musterStep();
    for (i = 0; i < this.ships.length; i++) {
      sh = this.ships[i];
      if (sh.boardCd > 0) sh.boardCd -= dt;
      var bd = sh.crew.board; if (!bd || sh.dead) continue;
      bd.inFlight = sh.inbound;
      // игрок ушёл из боя — оборону ведёт ИИ: бойцы без отряда разбиваются на отряды
      // кто ведёт оборону: игрок у корабля (сервер знает, в бою ли хозяин) или ИИ
      var man = this.defHuman ? !!this.defHuman(sh) : !this.aiBoard[bd.def];
      if (bd.defManual !== man) {
        bd.defManual = man;
        // ИИ принял оборону: все отряды — к ИИ, свободные — отрядами по казармам
        if (!man && bd.started && bd.over < 0) { bd.setAuto(bd.def, null); bd.makeDefSquads(); }
      }
      if (bd.over === 1) this.capture(sh, bd.att);
      else if (bd.over === 2) this.kill(sh, 'reactor');
    }
    // ИИ: свободный десант — на абордаж, если можно
    this.boardT -= dt;
    if (this.boardT > 0) return;
    this.boardT = 4;
    for (i = 0; i < this.ships.length; i++) {
      sh = this.ships[i];
      if (sh.dead || !this.aiBoard[sh.side]) continue;
      for (var j = 0; j < this.ships.length; j++) {
        var o = this.ships[j]; if (o.dead || o.side === sh.side) continue;
        // ИИ не бросает десант на свежий корабль: цель побита или обездвижена, свой — держится
        if (!(o.hull < o.hullMax * 0.85 || o.eff.engine < 0.3) || sh.hull < sh.hullMax * 0.35) continue;
        var can = this.canBoard(i, j);
        // ИИ одним героем не рискует: от четырёх бойцов
        if (can.ok && can.party >= 4 && (can.reinforce || this.R() < 0.35)) { this.board(i, j); break; }
      }
    }
  };
  // Мостик удержан: корабль — трофей атакующих (выходит из боя целым)
  Battle.prototype.capture = function(sh, side) {
    if (sh.dead) return;
    sh.dead = true; sh.deadAt = this.t; sh.why = 'captured'; sh.captured = side; sh.crit = 0; sh.order = null; sh.v = 0;
    this.ev.kills.push({ ship: sh.n, side: sh.side, why: 'captured', by: side });
    for (var i = 0; i < this.craft.length; i++) if (this.craft[i].home === sh.n && this.craft[i].docked) this.craft[i].dead = true;
  };

  // События кадра для отрисовки (забрать и очистить)
  Battle.prototype.takeEvents = function() {
    var e = this.ev; this.ev = { shots: [], booms: [], shields: [], kills: [], boards: [], rams: [] };
    return e;
  };

  return { Battle: Battle, GUNS: GUNS, SYS: SYS, SYS_BY: SYS_BY, CLASS: CLASS, CRAFT: CRAFT, TICK: TICK, wrap: wrap, boardCap: boardCap, BOARD_GAP: BOARD_GAP, TRACTOR: TRACTOR, sensOf: sensOf, SENS_STATION: SENS_STATION, WING_R: WING_R, WING_CALM: WING_CALM };
});
