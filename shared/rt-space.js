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
  var crew = (typeof module === 'object' && module.exports) ? require('./rt-crew.js') : root.SWCrew;
  var api = factory(crew);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SWSpace = api;
})(typeof self !== 'undefined' ? self : this, function(SWCrew) {
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
  var SYS_BY = {}; SYS.forEach(function(s) { SYS_BY[s.id] = s; });

  // Корпуса — из ship_types старой игры
  var CLASS = {
    venator:    { hp: 1200, shield: 150, regen: 8, acc: 85, eva: 3, hangar: 3, move: 6, dmg: 120, craft: ['arc170', 'arc170', 'ywing'] },
    acclamator: { hp: 700,  shield: 150, regen: 8, acc: 80, eva: 5, hangar: 0, move: 7, dmg: 45, bal: 1.25 },
    munificent: { hp: 700,  shield: 150, regen: 8, acc: 80, eva: 5, hangar: 0, move: 7, dmg: 45 },
    providence: { hp: 1200, shield: 150, regen: 8, acc: 85, eva: 3, hangar: 3, move: 6, dmg: 120, craft: ['vulture', 'vulture', 'hyena'], bal: 1.5 },
    // craft — звенья по 4 машины; у самых больших ангаров число звеньев урезано до 6;
    // bal — множитель урона по прогонам ИИ против ИИ (равные по старой игре корпуса ≈ 50/50)
    rep_mandator:   { hp: 2400, shield: 300, regen: 15, acc: 85, eva: 1,  hangar: 6, move: 4,  dmg: 220, craft: ['arc170', 'arc170', 'ywing', 'arc170', 'ywing', 'arc170'] },
    rep_victory:    { hp: 1100, shield: 200, regen: 10, acc: 83, eva: 4,  hangar: 2, move: 6,  dmg: 130, craft: ['arc170', 'ywing'] },
    rep_valiant:    { hp: 850,  shield: 150, regen: 8,  acc: 82, eva: 5,  hangar: 0, move: 7,  dmg: 75 },
    rep_arquitens:  { hp: 620,  shield: 150, regen: 8,  acc: 80, eva: 10, hangar: 0, move: 8,  dmg: 55 },
    tantive:        { hp: 400,  shield: 150, regen: 8,  acc: 78, eva: 18, hangar: 0, move: 10, dmg: 45, bal: 1.2 },
    cis_subjugator: { hp: 2500, shield: 250, regen: 12, acc: 85, eva: 1,  hangar: 4, move: 4,  dmg: 210, craft: ['vulture', 'hyena', 'vulture', 'hyena'] },
    cis_lucrehulk:  { hp: 1900, shield: 200, regen: 10, acc: 82, eva: 2,  hangar: 8, move: 4,  dmg: 120, craft: ['vulture', 'vulture', 'hyena', 'vulture', 'vulture', 'hyena'] },
    cis_recusant:   { hp: 850,  shield: 150, regen: 8,  acc: 82, eva: 4,  hangar: 0, move: 7,  dmg: 70, bal: 1.1 },
    cis_diamond:    { hp: 650,  shield: 130, regen: 8,  acc: 80, eva: 8,  hangar: 0, move: 8,  dmg: 55, bal: 1.15 },
    hardcell:       { hp: 480,  shield: 150, regen: 8,  acc: 78, eva: 15, hangar: 0, move: 9,  dmg: 50 }
  };
  // Малые корабли — тоже из ship_types
  var CRAFT = {
    arc170:  { name: 'ARC-170',    role: 'fighter', hp: 90,  speed: 230, img: 'arc170', len: 14.2 },
    ywing:   { name: 'Y-wing',     role: 'bomber',  hp: 140, speed: 170, img: 'ywing',  len: 16 },
    vulture: { name: 'Стервятник', role: 'fighter', hp: 90,  speed: 250, img: 'vulture', len: 6.9 },
    hyena:   { name: 'Гиена',      role: 'bomber',  hp: 140, speed: 180, img: 'hyena',  len: 8.1 }
  };

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
    this.ev = { shots: [], booms: [], shields: [], kills: [] };
    this.over = -1;          // сторона-победитель
    // туман войны: что видит каждая сторона (fog: false — видно всё)
    this.fog = opts.fog !== false;
    this.vis = [{}, {}]; this.visC = [{}, {}]; this.last = [{}, {}]; this.senseT = 0;
    var list = opts.ships || [];
    for (var i = 0; i < list.length; i++) this.addShip(list[i]);
  }

  // { cls, plan (SWShip.load), side, x, y, hd, figs, name }
  Battle.prototype.addShip = function(o) {
    var C = CLASS[o.cls] || CLASS.acclamator, plan = o.plan;
    var sh = {
      n: this.ships.length, id: o.id || (o.cls + '-' + this.ships.length), cls: o.cls, name: o.name || plan.name, side: o.side,
      plan: plan, len: plan.h * plan.cellM, wid: plan.w * plan.cellM,
      x: o.x || 0, y: o.y || 0, hd: o.hd || 0, v: 0, order: null, ai: o.ai !== false,
      hullMax: C.hp * 3, hull: C.hp * 3, shMax: C.shield * 1.6, sh: [C.shield * 1.6, C.shield * 1.6, C.shield * 1.6, C.shield * 1.6],
      // генератор щитов рассчитан на огонь корабля своего класса: у малых кораблей
      // восстановление и перекачка слабее, иначе их пушки не продавливают щит вовсе
      shHit: [0, 0, 0, 0], focus: -1, focusAuto: true, regen: C.regen * 0.35 * shK(C), xfer: 1.2 * shK(C), acc: C.acc / 100, eva: C.eva / 100,
      vmax: C.move * 9, turn: 4 * Math.PI / 180, dead: false, deadAt: 0, crit: 0,
      // датчики: дальше у больших кораблей; выстрел выдаёт место на FLASH с
      sens: Math.max(6000, Math.min(10000, 6000 + plan.h * plan.cellM * 2.5)), flash: -99,
      crew: new SWCrew.Crew(plan, { seed: (this.ships.length + 1) * 7717, figs: o.figs, figMap: o.figMap, alert: true }),
      guns: [], eff: {}, hangar: (C.craft || []).slice(), launchT: 4 + this.ships.length, sysCache: {}
    };
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
    for (g = 0; g < sh.guns.length; g++) if (sh.guns[g].t !== 'pd') sh.guns[g].k = k;
    this.ships.push(sh);
    this.place(sh);
    // разведка перед боем: где противник стоял на старте, обе стороны знают
    this.last[1 - sh.side][sh.n] = { x: sh.x, y: sh.y, hd: sh.hd, t: this.t };
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
  // tgt: {k:'auto'} | {k:'fighters'} | {k:'hull', ship} | {k:'sys', ship, sys} | {k:'room', ship, room}
  Battle.prototype.setTarget = function(shipN, guns, tgt) {
    var sh = this.ships[shipN]; if (!sh || sh.dead || !tgt) return 0;
    // проверка приказа: годится и для сервера, где он придёт от игрока
    var k = tgt.k, foe = this.ships[tgt.ship];
    if (k !== 'auto' && k !== 'fighters') {
      if (!foe || foe.dead || foe.side === sh.side) return 0;
      if (k === 'sys' && !SYS_BY[tgt.sys]) return 0;
      if (k === 'room' && !foe.plan.roomByN[tgt.room]) return 0;
      if (k !== 'hull' && k !== 'sys' && k !== 'room') return 0;
    }
    if (!guns || !guns.length) return 0;
    var n = 0;
    for (var i = 0; i < guns.length; i++) {
      var g = (guns[i] === (guns[i] | 0)) ? sh.guns[guns[i]] : null; if (!g) continue;
      g.tgt = { k: tgt.k, ship: tgt.ship, sys: tgt.sys, room: tgt.room }; g.cur = null; n++;
    }
    return n;
  };
  // Курс: к точке; face — только развернуться носом к точке; x == null — корабль ведёт ИИ;
  // hold — стоять (свой курс без точки)
  Battle.prototype.order = function(shipN, x, y, face) {
    var sh = this.ships[shipN]; if (!sh || sh.dead) return;
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
    for (i = 0; i < this.ships.length; i++) {
      sh = this.ships[i];
      if (sh.dead) continue;
      sh.crew.step(dt);
      this.systems(sh, dt);
      this.drive(sh, dt);
      this.place(sh);
      this.launch(sh, dt);
    }
    this.senseT -= dt;
    if (this.senseT <= 0) { this.senseT = 0.5; this.sense(); }
    for (i = 0; i < this.ships.length; i++) if (!this.ships[i].dead) this.fireGuns(this.ships[i], dt);
    this.flyCraft(dt);
    // попадания долетают
    var keep = [];
    for (i = 0; i < this.pending.length; i++) {
      var p = this.pending[i];
      if (p.at <= this.t) this.resolve(p); else keep.push(p);
    }
    this.pending = keep;
    this.checkEnd();
  };

  // Системы корабля из состояния отсеков
  Battle.prototype.systems = function(sh, dt) {
    var c = sh.crew, e = sh.eff;
    e.engine = c.sysEff('engine');
    e.reactor = c.sysEff('reactor');
    e.shield = hasType(sh.plan, 'shield') ? c.sysEff('shield') : e.reactor;
    e.bridge = (c.sysEff('bridge') * 2 + (hasType(sh.plan, 'cic') ? c.sysEff('cic') : 1)) / 3;
    e.hangar = hasType(sh.plan, 'hangar') ? c.sysEff('hangar') : 0;
    e.power = 0.3 + 0.7 * e.reactor;
    this.shields(sh, dt);
    // орудия: люди на посту, целость, питание
    for (var g = 0; g < sh.guns.length; g++) {
      var gun = sh.guns[g], re = gun.room ? c.roomEff(gun.room) : 1;
      gun.eff = re; gun.out = re <= 0;
    }
    // реактор разбит — отсчёт до взрыва
    var rs = reactorState(sh);
    if (rs !== null && rs <= 0.5) { if (!sh.crit) sh.crit = 60; }
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
  Battle.prototype.shieldCap = function(sh, s) {
    var k = sh.focus < 0 ? 1 : s === sh.focus ? 1.25 : 0.9;
    return sh.shMax * k * (0.4 + 0.6 * (sh.eff.shield == null ? 1 : sh.eff.shield));
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
    var want = null, wantV = 0;
    if (sh.order) {
      var dx = sh.order.x - sh.x, dy = sh.order.y - sh.y, d = Math.sqrt(dx * dx + dy * dy);
      if (sh.order.face) {
        want = Math.atan2(dy, dx); wantV = 0;
        if (Math.abs(wrap(want - sh.hd)) < 0.02) sh.order = null;
      }
      else if (d < 120) { sh.order = null; }
      else { want = Math.atan2(dy, dx); wantV = Math.min(vmax, d / 20); }
    } else if (sh.ai) {
      var foe = this.nearestFoe(sh);
      if (foe) {
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
    if (want !== null) {
      sh.hd = turnTo(sh.hd, want, tr * dt);
      var off = Math.abs(wrap(want - sh.hd));
      wantV *= Math.max(0.25, Math.cos(Math.min(off, Math.PI / 2)));
    }
    var acc = sh.vmax * 0.08 * dt;
    sh.v += Math.max(-acc, Math.min(acc, wantV - sh.v));
    sh.hd = wrap(sh.hd);
    sh.x += Math.cos(sh.hd) * sh.v * dt; sh.y += Math.sin(sh.hd) * sh.v * dt;
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
    for (side = 0; side < 2; side++) {
      var vis = {}, visC = {}, eyes = [];
      for (i = 0; i < S.length; i++) if (!S[i].dead && S[i].side === side) eyes.push([S[i].x, S[i].y, this.sensRange(S[i])]);
      for (i = 0; i < C.length; i++) if (!C[i].dead && C[i].side === side) eyes.push([C[i].x, C[i].y, CRAFT_SENS]);
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
      g.cd -= dt * e.power * (0.25 + 0.75 * g.eff);
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
      if (!foe) return g.t === 'pd' ? null : null;
      return this.autoAim(sh, g, foe);
    }
    if (k === 'fighters') { var c1 = this.craftFor(sh, g, T.range); return c1 ? { craft: c1 } : null; }
    var tgtShip = this.ships[t.ship];
    if (!tgtShip || tgtShip.dead || tgtShip.side === sh.side) { g.tgt = { k: 'auto' }; return null; }
    if (!this.sees(sh.side, tgtShip)) return null;      // цель потеряна в тумане — пушка ждёт
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
    if (g.t === 'ion') sys = foe.sh[this.sector(foe, g.x, g.y)] > foe.shMax * 0.2 ? (hasType(foe.plan, 'shield') ? 'shield' : 'engine') : 'engine';
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
    for (var i = 0; i < this.ships.length; i++) {
      var o = this.ships[i]; if (o.dead || o.side === sh.side || !this.sees(sh.side, o)) continue;
      if (!this.inArc(sh, g, o.x, o.y, o)) continue;
      var dx = o.x - g.x, dy = o.y - g.y, d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = o; }
    }
    return best;
  };
  Battle.prototype.craftFor = function(sh, g, range) {
    var best = null, bd = range * range;
    for (var i = 0; i < this.craft.length; i++) {
      var c = this.craft[i]; if (c.dead || c.side === sh.side || !this.visC[sh.side][c.id]) continue;
      var dx = c.x - g.x, dy = c.y - g.y, d = dx * dx + dy * dy;
      if (d > bd || !this.inArc(sh, g, c.x, c.y, null)) continue;
      // бомбардировщики, что идут на нас, — первыми
      if (c.role === 'bomber') d *= 0.5;
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
    var hit = T.accF * (0.6 + 0.4 * sh.eff.bridge) * (c.role === 'bomber' ? 1.25 : 1);
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
      c.hp -= p.dmg;
      if (c.hp <= 0) { c.dead = true; c.deadAt = this.t; this.ev.booms.push({ x: c.x, y: c.y, r: 30, t0: this.t, craft: 1 }); this.ev.kills.push({ craft: c.type, side: c.side }); }
      return;
    }
    var sh = this.ships[p.ship]; if (!sh || sh.dead) return;
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
    var c = sh.crew, armor = 1;
    if (n) { var tt = p.roomByN[n] && p.roomByN[n].t; armor = ARMOR[tt] || 1; }
    k *= armor;
    if (n) c.damageRoom(n, Math.min(30, (dmg || 6) * T.sys * 0.7 * k), T.stun ? T.stun * k : 0);
    if (dmg > 0) {
      if (this.R() < T.fire * Math.min(2, dmg / 12)) c.ignite(lx, ly, 30 + this.R() * 40);
      c.blast(lx, ly, 2 + dmg / 12, 50 + dmg * 3 * T.hull);
    }
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
    var alive = [0, 0];
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
    var type = sh.hangar[0];
    sh.wing = (sh.wing || 0) + 1;
    if (sh.wing >= 4) { sh.wing = 0; sh.hangar.shift(); sh.launchT = 6; } else sh.launchT = 1.5;
    // звенья вылетают по очереди из всех ангаров корабля
    var hs = [];
    for (var i = 0; i < sh.plan.rooms.length; i++) if (sh.plan.rooms[i].t === 'hangar') hs.push(sh.plan.rooms[i]);
    var h = hs.length ? hs[(sh.wingN || 0) % hs.length] : null;
    if (sh.wing === 0) sh.wingN = (sh.wingN || 0) + 1;
    var w = h ? this.toWorld(sh, h.cx + (sh.wing - 1.5) * 6, h.y + 4) : [sh.x, sh.y];
    var C = CRAFT[type];
    this.craft.push({ id: this.nextCraft++, type: type, role: C.role, img: C.img, side: sh.side, home: sh.n,
                      x: w[0], y: w[1], hd: sh.hd, v: C.speed * 0.6, hp: C.hp, max: C.hp, speed: C.speed,
                      cd: 1 + this.R(), tgt: null, mode: 'go', dead: false, len: C.len, born: this.t });
  };
  Battle.prototype.flyCraft = function(dt) {
    var R = this.R, i, c;
    for (i = 0; i < this.craft.length; i++) {
      c = this.craft[i]; if (c.dead) continue;
      var gx, gy, want;
      if (c.role === 'fighter') {
        // истребитель: ближайший вражеский малый корабль, иначе прикрывает свой корабль
        var foe = this.nearCraft(c, 9000);
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
          var home = this.ships[c.home];
          var tgtS = home && !home.dead ? this.nearestFoe(home) : null;
          var cx = tgtS && home ? (home.x * 0.4 + tgtS.x * 0.6) : (home ? home.x : c.x), cy = tgtS && home ? (home.y * 0.4 + tgtS.y * 0.6) : (home ? home.y : c.y);
          var orb = this.t * 0.25 + c.id;
          gx = cx + Math.cos(orb) * 1400; gy = cy + Math.sin(orb) * 1400;
        }
      } else {
        // бомбардировщик: заход на отсек вражеского корабля, сброс, отход, новый заход
        var ship = c.tgt != null ? this.ships[c.tgt] : null;
        if (!ship || ship.dead) {
          var h = this.ships[c.home] || c, best = null, bd = 1e18;
          for (var s = 0; s < this.ships.length; s++) {
            var o = this.ships[s]; if (o.dead || o.side === c.side || !this.sees(c.side, o)) continue;
            var ddx = o.x - c.x, ddy = o.y - c.y, dd = ddx * ddx + ddy * ddy;
            if (dd < bd) { bd = dd; best = o; }
          }
          ship = best; c.tgt = best ? best.n : null; c.mode = 'go';
          c.room = best ? this.sysRoom(best, R() < 0.5 ? 'engine' : 'guns', { x: c.x, y: c.y }) : 0;
          if (!best) {
            // никого не видно — к последней засечке врага, иначе к своему кораблю
            var gh = this.ships[c.home] ? this.nearestFoe(this.ships[c.home]) : null;
            if (gh) { gx = gh.x; gy = gh.y; } else { gx = h.x; gy = h.y; }
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
            if (c.outT <= 0) { c.mode = 'go'; if (R() < 0.3) c.tgt = null; }
          }
        }
      }
      if (!c.off) { var oa = c.id * 2.399; c.off = [Math.cos(oa) * (60 + (c.id % 4) * 35), Math.sin(oa) * (60 + (c.id % 4) * 35)]; }
      var far = (gx - c.x) * (gx - c.x) + (gy - c.y) * (gy - c.y) > 640000;     // дальше 800 м — держать строй
      if (far) { gx += c.off[0]; gy += c.off[1]; }
      want = Math.atan2(gy - c.y, gx - c.x);
      c.hd = turnTo(c.hd, want, 2.2 * dt);
      c.v += (c.speed - c.v) * Math.min(1, dt * 0.8);
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
      if (o.role === 'bomber') d *= 0.6;
      if (d < bd) { bd = d; best = o; }
    }
    return best;
  };

  // События кадра для отрисовки (забрать и очистить)
  Battle.prototype.takeEvents = function() {
    var e = this.ev; this.ev = { shots: [], booms: [], shields: [], kills: [] };
    return e;
  };

  return { Battle: Battle, GUNS: GUNS, SYS: SYS, SYS_BY: SYS_BY, CLASS: CLASS, CRAFT: CRAFT, TICK: TICK, wrap: wrap };
});
