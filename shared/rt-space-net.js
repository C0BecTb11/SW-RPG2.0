// Сетевой космический бой: сервер считает, телефон рисует.
//
// Сервер (Node): у каждого игрока — Viewer. Он собирает события боя с учётом
// тумана войны (чего сторона не видит — не уходит игроку) и раз в 0,2 с шлёт
// «лёгкое» состояние: корабли, малые корабли, выстрелы, туман, сводку абордажей.
// Для корабля, на который игрок смотрит изнутри, — ещё люди (двоичный кадр,
// 4 раза в секунду), огонь по клеткам, отсеки, двери и турели абордажа.
//
// Браузер: Mirror держит обычный SWSpace.Battle (те же планы, отсеки, пушки),
// но не считает его — только переносит в него присланное и сглаживает движение
// между кадрами. Отрисовка и панели работают с ним как с локальным боем.
// Приказы уходят на сервер (Mirror подменяет методы боя на отправку).
//
// ES5, без зависимостей.

(function(root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SWSpaceNet = api;
})(typeof self !== 'undefined' ? self : this, function() {
  'use strict';

  var LIGHT_EVERY = 2, AGENTS_EVERY = 2, HEAVY_EVERY = 5;   // в тактах сервера (0,1 с)
  var DELAY = 0.25;                                         // запаздывание отрисовки по умолчанию, с (дальше — по сети)
  var STEPR = 0.2;                                          // лёгкие кадры — раз в 0,2 с настоящего времени
  var KEYS = 6;                                             // сколько положений корабля / малого корабля держит экран
  // Часы экрана — монотонные: перевод системных часов не сбивает сглаживание
  function clock() { return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now(); }
  // Положение в момент t между двумя известными, что его окружают (за последним — стоит на последнем)
  function keyAt(ks, t) {
    var j = ks.length - 1; while (j > 0 && ks[j].T > t) j--;
    var a = ks[j], b = ks[j + 1] || a, k = b.T > a.T ? Math.max(0, Math.min(1, (t - a.T) / (b.T - a.T))) : 1;
    if (t < a.T) k = 0;
    var dh = b.hd - a.hd; while (dh > Math.PI) dh -= 6.2832; while (dh < -Math.PI) dh += 6.2832;
    return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, hd: a.hd + dh * k };
  }
  function keyPush(ks, x, y, hd, T, step) {
    var lk = ks[ks.length - 1];
    if (T < lk.T) return;
    if (T === lk.T) { lk.x = x; lk.y = y; lk.hd = hd; return; }
    if (T - lk.T > step * 1.5) ks.push({ x: lk.x, y: lk.y, hd: lk.hd, T: T - step });   // молчал — значит стоял
    ks.push({ x: x, y: y, hd: hd, T: T });
    if (ks.length > KEYS) ks.splice(0, ks.length - KEYS);
  }
  var AG = 16;
  var AH = 10;              // заголовок кадра людей: тип, —, N (2), время (4), номер корабля (2) — номер больше не байт (SPACE-BUG-010)
  var LOCK = 900;                                           // мс: свой приказ важнее кадров, что уже летят                                              // байт на человека в кадре экипажа
  // новые номера — с новым заголовком (AH): экран старой версии такие кадры пропускает, а не читает вкривь
  var BIN = { AGENTS: 21, FIRE: 22, AGENTS_D: 23 };
  // версия протокола орбиты: сервер новее экрана — экран перезагружается (hello.pv)
  var PV = 2;
  var JOBS = ['', 'fire', 'fix', 'heal', 'carry', 'back', 'defend', 'board', 'weld', 'muster', 'stand'];
  var JOB_N = {}; for (var ji = 0; ji < JOBS.length; ji++) JOB_N[JOBS[ji]] = ji;
  var ROLES = ['post', 'fixer', 'medic', 'reserve', 'boarder', 'sapper', 'guard'];
  var ROLE_N = {}; for (var ri = 0; ri < ROLES.length; ri++) ROLE_N[ROLES[ri]] = ri;
  var WPNS = ['', 'rifle', 'heavy', 'b1', 'b2', 'bx', 'tool', 'sniper', 'launcher', 'saber', 'pistols', 'scatter'];   // 4 бита — не больше 16
  var WPN_N = {}; for (var wi = 0; wi < WPNS.length; wi++) WPN_N[WPNS[wi]] = wi;
  var DOOR_ST = ['open', 'locked', 'broken'], DOOR_N = { open: 0, locked: 1, broken: 2 };

  // Бои для пробы: [класс, сторона, x, y]; сторона 0 смотрит носом вправо, 1 — влево
  var SCEN = {
    vp:  { name: 'Венатор × Провидение', ships: [['venator', 0, 0, 0], ['providence', 1, 9000, 1400]] },
    am:  { name: 'Акламатор × Щедрый', ships: [['acclamator', 0, 0, 0], ['munificent', 1, 8500, -1000]] },
    '2x2': { name: 'Два на два', ships: [['venator', 0, 0, -1300], ['acclamator', 0, -600, 1500], ['providence', 1, 9500, -900], ['munificent', 1, 9000, 1800]] },
    fl:  { name: 'Мандатор × Покоритель', ships: [['rep_mandator', 0, 0, 0], ['cis_subjugator', 1, 11000, 1500]] },
    lr:  { name: 'Венатор × Лукрехалк', ships: [['venator', 0, 0, 0], ['cis_lucrehulk', 1, 10500, 1200]] },
    vk:  { name: 'Победа × Провидение', ships: [['rep_victory', 0, 0, 0], ['providence', 1, 9000, 1400]] },
    vr:  { name: 'Валиант × Бунтарь', ships: [['rep_valiant', 0, 0, 0], ['cis_recusant', 1, 8500, 1200]] },
    ad:  { name: 'Аркитенс × Алмаз', ships: [['rep_arquitens', 0, 0, 0], ['cis_diamond', 1, 7500, -900]] },
    th:  { name: 'Тантив × Хардсел', ships: [['tantive', 0, 0, 0], ['hardcell', 1, 6000, 700]] }
  };

  // Корабли для своего боя: [класс, имя, сторона, длина]
  var SHIPS = [['venator', 'Венатор', 0, 1137], ['acclamator', 'Акламатор', 0, 752], ['rep_mandator', 'Мандатор', 0, 1500], ['rep_victory', 'Победа', 0, 900],
               ['rep_valiant', 'Валиант', 0, 700], ['rep_arquitens', 'Аркитенс', 0, 325], ['tantive', 'Тантив', 0, 150],
               ['providence', 'Провидение', 1, 1088], ['munificent', 'Щедрый', 1, 825], ['cis_subjugator', 'Покоритель', 1, 1500], ['cis_lucrehulk', 'Лукрехалк', 1, 1200],
               ['cis_recusant', 'Бунтарь', 1, 1187], ['cis_diamond', 'Алмаз', 1, 600], ['hardcell', 'Хардсел', 1, 225]];
  var SHIP_BY = {}; for (var si = 0; si < SHIPS.length; si++) SHIP_BY[SHIPS[si][0]] = SHIPS[si];
  // Свой бой: { a: [классы Республики], b: [классы КНС], dist } → проверенный или null
  function cfgClean(cfg) {
    if (!cfg || typeof cfg !== 'object') return null;
    var out = { a: [], b: [], dist: Math.max(3000, Math.min(25000, +cfg.dist || 8000)), fill: cfg.fill === 0 || cfg.fill === 0.5 ? cfg.fill : 1 };
    var side = function(list, sd) {
      if (!Array.isArray(list)) return false;
      for (var i = 0; i < list.length && i < 3; i++) {
        var id = String(list[i]), sh = Object.prototype.hasOwnProperty.call(SHIP_BY, id) ? SHIP_BY[id] : null;
        if (!sh || sh[2] !== sd) return false;
        (sd === 0 ? out.a : out.b).push(id);
      }
      return list.length >= 1;
    };
    if (!side(cfg.a, 0) || !side(cfg.b, 1)) return null;
    return out;
  }
  // Расстановка: Республика слева, КНС справа на dist, строем по 2,6 км
  function layout(cfg) {
    var out = [], i;
    for (i = 0; i < cfg.a.length; i++) out.push([cfg.a[i], 0, 0, Math.round((i - (cfg.a.length - 1) / 2) * 2600)]);
    for (i = 0; i < cfg.b.length; i++) out.push([cfg.b[i], 1, cfg.dist, Math.round((i - (cfg.b.length - 1) / 2) * 2600 + 700)]);
    return out;
  }
  function cfgName(cfg) {
    var n = function(l) { return l.map(function(id) { return SHIP_BY[id][1]; }).join(' + '); };
    return n(cfg.a) + ' × ' + n(cfg.b);
  }

  function r1(x) { return Math.round(x * 10) / 10; }
  // режим авиакрыла ↔ число в кадре
  var WM = { auto: 0, out: 1, dock: 2 }, WM_N = ['auto', 'out', 'dock'];
  function r0(x) { return Math.round(x); }
  function r2(x) { return Math.round(x * 100) / 100; }

  var FOG_SHOT = 1500;       // болт стрелка из тумана — от точки не дальше этого от цели (м)
  // ================================================================ сервер
  // user — кто смотрит (бой с союзниками: приказы — только своим кораблям; «dev» и без user — всей стороне)
  function Viewer(B, side, user) {
    this.B = B; this.side = side; this.user = user || null;
    this.sel = -1; this.foe = -1; this.view = -1;
    this.k = 0;
    this.ev = { shots: [], booms: [], shields: [], kills: [], boards: [] };
    this.mark = {};          // что уже отправлено по кораблю: вспышки, выстрелы, сообщения абордажа
    this.craftKnown = {};    // малые корабли, о которых игрок уже знает (тип, сторона)
  }
  // События одного такта (одни на всех) — оставить то, что этой стороне видно
  Viewer.prototype.push = function(e) {
    var B = this.B, side = this.side, i, ev = this.ev, self = this;
    var vis = function(n) { var s = B.ships[n]; return !s || s.side === side || s.dead || B.sees(side, s); };
    // туман (SPACE-BUG-007): стрелок или цель не видны — что видно стороне. Корабль: своя сторона, в датчиках
    // или наш абордаж на борту; малый корабль: свой или в датчиках (visC)
    var shipV = function(n) { var s = B.ships[n]; if (!s) return false; if (!B.fog || s.side === side) return true; var bd = s.crew && s.crew.board; return !!(B.vis[side] && B.vis[side][n]) || !!(bd && bd.started && bd.over < 0 && bd.att === side); };
    var craftV = function(id) { var c = B.craftById ? B.craftById(id) : null; return !B.fog || !c || c.side === side || !!(B.visC && B.visC[side] && B.visC[side][id]); };
    var who = function(src, cr) { return src == null ? null : cr ? craftV(src) : shipV(src); };
    for (i = 0; i < e.shots.length; i++) {
      var sx = e.shots[i], fromV = who(sx.from, sx.fromC), toV = who(sx.to, sx.toC);
      if (fromV === null || fromV) { ev.shots.push(sx); continue; }               // стрелок виден (или не помечен)
      if (!toV) continue;                                                         // ни стрелка, ни цели не видно — нет и болта
      // стрелок в тумане, цель видна: болт приходит «из-за края» — не дальше FOG_SHOT от цели, без точки стрелка
      var fdx = sx.x0 - sx.x1, fdy = sx.y0 - sx.y1, fd = Math.sqrt(fdx * fdx + fdy * fdy) || 1, fk = Math.min(1, FOG_SHOT / fd);
      ev.shots.push({ x0: sx.x1 + fdx * fk, y0: sx.y1 + fdy * fk, x1: sx.x1, y1: sx.y1, t0: sx.t0, dur: sx.dur * fk, side: sx.side, t: sx.t, miss: sx.miss });
    }
    for (i = 0; i < e.booms.length; i++) {
      var b = e.booms[i];
      if (b.ship != null) { if (shipV(b.ship)) ev.booms.push(b); continue; }                        // попадание, гибель корабля — только виденного
      if (b.ram && !shipV(b.ram[0]) && !shipV(b.ram[1])) continue;                                   // таран в тумане
      if (b.craft && b.cid != null && !craftV(b.cid)) continue;                                      // сбитая машина в тумане — не видна
      ev.booms.push(b);
    }
    for (i = 0; i < e.shields.length; i++) if (vis(e.shields[i].ship)) ev.shields.push(e.shields[i]);
    for (i = 0; i < e.kills.length; i++) {
      var kl = e.kills[i];
      if (kl.ship != null) { var ks = B.ships[kl.ship]; if (ks && ks.side !== side && !shipV(kl.ship)) continue; (this.deadSeen = this.deadSeen || {})[kl.ship] = 1; }
      else if (kl.craft != null && kl.cid != null && !craftV(kl.cid)) continue;
      ev.kills.push(kl);
    }
    for (i = 0; i < (e.rams || []).length; i++) { var rm = e.rams[i], r1s = B.ships[rm.a], r2s = B.ships[rm.b]; if ((r1s && r1s.side === side) || (r2s && r2s.side === side)) (ev.rams = ev.rams || []).push(rm); }
    // сборы десанта у своего шлюза и отбой — только своим; цели — когда шаттлы стартовали
    for (i = 0; i < e.boards.length; i++) { var bb = e.boards[i], s1 = B.ships[bb.n], s2 = B.ships[bb.t]; if ((s1 && s1.side === side) || (s2 && s2.side === side && !bb.muster && !bb.cancel)) ev.boards.push(bb); }
    if (ev.boards.length > 50) ev.boards.splice(0, ev.boards.length - 50);
    if (ev.kills.length > 100) ev.kills.splice(0, ev.kills.length - 100);
    if (ev.shots.length > 300) ev.shots.splice(0, ev.shots.length - 300);
  };
  Viewer.prototype.shipLight = function(sh) {
    var B = this.B, own = sh.side === this.side, i, g;
    if (!own && !sh.dead && !B.sees(this.side, sh)) { var hb = this.boardLight(sh); return hb ? { n: sh.n, hid: 1, bd: hb } : { n: sh.n, hid: 1 }; }
    // погиб или ушёл, не будучи на виду (гибели не видели, ушёл из тумана в гиперпространство) — без места (SPACE-BUG-007)
    if (!own && sh.dead && B.fog && !(this.deadSeen && this.deadSeen[sh.n])) return { n: sh.n, hid: 1, dead: 1 };
    // туман: про чужой корабль (без нашего десанта на борту) — только то, что видно снаружи:
    // корпус с шагом 5%, щиты по сектору четвертями, без систем, реактора и экипажа
    var bdI = sh.crew.board, intel = own || (bdI && bdI.started && bdI.over < 0 && bdI.att === this.side);
    var hq = intel ? r0(sh.hull) : Math.ceil(sh.hull / (sh.hullMax * 0.05)) * sh.hullMax * 0.05;
    var sq = function(q) { var v = sh.sh[q], m = B.secMax(sh, q); return intel ? r0(v) : Math.min(4, Math.ceil(v / (m * 0.25) - 0.01)) * m * 0.25; };
    var o = { n: sh.n, x: r1(sh.x), y: r1(sh.y), hd: Math.round(sh.hd * 1000) / 1000, v: r1(sh.v), hull: r0(hq),
              sh: [r0(sq(0)), r0(sq(1)), r0(sq(2)), r0(sq(3))], f: own ? sh.focus : -1, fa: sh.focusAuto ? 1 : 0,
              e: intel ? [r2(sh.eff.engine || 0), r2(sh.eff.reactor || 0), r2(sh.eff.shield || 0), r2(sh.eff.bridge || 0), r2(sh.eff.hangar || 0), r2(sh.eff.power || 0)] : null,
              crit: intel ? r1(sh.crit) : 0, dead: sh.dead ? 1 : 0, why: sh.why || '', cap: sh.captured, inb: sh.inbound,
              burn: sh.crew.burning.length, ct: r2(sh.crew.t) };
    if (sh.tb) o.tb = [sh.tb.to, r1(sh.tb.until - B.t)];               // притягивающий луч: кого держит, сколько осталось
    // чужой на виду с улучшенным корпусом или щитами: пределы (строка из тумана их не несёт — без них доля выше 100 %)
    if (!own && ((sh.bon && (sh.bon.hp !== 1 || sh.bon.sh !== 1)) || sh.foreK > 1)) { o.hm = r0(sh.hullMax); o.sm = r2(sh.shMax); o.fk = sh.foreK || 1; }
    if (own) {
      if (sh.tractor) { o.tx = 1; if (sh.tbReady > B.t) o.tc = r1(sh.tbReady - B.t); }
      var hbO = B.holder(sh); if (hbO) o.hb = [hbO.n, r1(hbO.tb.until - B.t)];   // нас держат (держащий может быть в тумане)
      o.ow = this.ctl(sh) ? 1 : 2; o.cd = r0(sh.boardCd); o.ai = sh.ai ? 1 : 0; o.gd = sh.guard ? 1 : 0; o.at = sh.foeT != null ? sh.foeT : -1; o.ord = sh.order ? [r0(sh.order.x), r0(sh.order.y), sh.order.face ? 1 : 0] : null;
      o.hold = sh.hold || null; o.alive = sh.crew.alive(); o.sens = r0(B.sensRange(sh)); o.alert = sh.crew.alertOn ? 1 : 0;
      // авиакрыло: режим, на борту / в воздухе / сбито (только у кого есть машины)
      var wf = 0; for (i = 0; i < B.craft.length; i++) { var wc = B.craft[i]; if (!wc.dead && wc.home === sh.n && wc.role !== 'shuttle') wf++; }
      if (wf || sh.hangar.length || sh.wLost) o.wg = [WM[sh.wmode] || 0, sh.hangar.length, wf, sh.wLost || 0, sh.wOut ? 1 : 0];
      // трюм: десант на борту / всего, герои, техника, недобор экипажа
      var tA = 0, tN = 0, tP = 0, hn = [];
      for (i = 0; i < sh.crew.agents.length; i++) { var ta = sh.crew.agents[i]; if (ta.team !== sh.side || !ta.utype) continue; tN++; if (ta.alive) { tA++; if (ta.stand) tP++; if (ta.hero && ta.uname) hn.push(ta.uname); } }
      if (sh.dormant && sh.stands) tP = Object.keys(sh.stands).length;     // спит — посты по записи
      o.tr = [tA, tN]; o.hn = hn; o.ps = tP;
      var gA = 0, gN = 0, mu = 0; for (i = 0; i < sh.crew.agents.length; i++) { var ga = sh.crew.agents[i]; if (ga.team === sh.side && ga.role === 'guard') { gN++; if (ga.alive) gA++; } if (ga.alive && ga.job && ga.job.kind === 'muster') mu++; } o.gu = [gA, gN]; o.mu = mu; o.veh = (sh.vehicles || []).length; o.cl = sh.crew.crewLost || 0;
      o.g = [];
      // пушки поимённо — только у корабля в панели или под осмотром (у флота из десятков кораблей это основной трафик)
      var wantGuns = sh.n === this.sel || sh.n === this.view || (this.sel < 0 && B.ships.length <= 6);
      for (i = 0; wantGuns && i < sh.guns.length; i++) {
        g = sh.guns[i];
        var a = g.aimAt;
        o.g.push([a && a.ship ? a.ship.n : -1, a && a.ship ? (a.room || 0) : 0, a && a.craft ? a.craft.id : 0, g.out ? 1 : 0,
                  r2(Math.max(0, g.cd) / g.T.reload), g.tgt.k, g.tgt.ship != null ? g.tgt.ship : -1, g.tgt.sys || '', g.tgt.room || 0, g.keep ? (g.keep.sys || 'hull') : '']);
      }
    } else {
      // чужие пушки — только те, что смотрят на наши корабли (видно, куда бьёт враг)
      o.g = [];
      for (i = 0; i < sh.guns.length; i++) {
        g = sh.guns[i]; var aa = g.aimAt;
        if (aa && aa.ship && aa.ship.side === this.side) o.g.push([i, aa.ship.n, aa.room || 0]);
      }
    }
    // огонь снаружи: выборка клеток (не больше 60)
    if (sh.crew.burning.length && this.lk % 2 === 0) {
      var bl = sh.crew.burning, step = Math.max(1, Math.floor(bl.length / 60)), fs = [];
      for (i = 0; i < bl.length; i += step) fs.push(bl[i], r0(sh.crew.fire[bl[i]]));
      o.fs = fs;
    } else if (!sh.crew.burning.length) o.fs = [];
    o.bd = this.boardLight(sh);
    return o;
  };
  // абордаж: сводка для полосы в панели (и когда корабль ушёл из датчиков)
  Viewer.prototype.boardLight = function(sh) {
    var bd = sh.crew.board;
    if (bd && bd.started && (bd.att === this.side || bd.def === this.side)) {
      var su = bd.summary();
      return { over: bd.over, att: bd.att, def: bd.def, alarm: bd.alarm ? 1 : 0, alarmCd: r0(bd.alarmCd), bt: r1(bd.bridgeT), hn: bd.holdNeed, pr: r1(bd.prep || 0),
               ch: bd.charge ? { a: bd.charge.armed ? 1 : 0, l: r1(bd.charge.left), p: r1(bd.charge.plant), d: r1(bd.charge.defuse) } : null,
               su: { att: su.att, def: su.def, crew: su.crew, sq: su.sq, dsq: bd.def === this.side ? su.dsq : [], dm: bd.defManual ? 1 : 0 }, held: this.heldList(bd), seq: bd.seq || 0,
               br: bd.bridge && bd.rs[bd.bridge] ? [bd.rs[bd.bridge].held ? 1 : 0, r1(bd.rs[bd.bridge].hold), bd.rs[bd.bridge].cnt[0], bd.rs[bd.bridge].cnt[1]] : null,
               pw: bd.canPlant(), vw: bd.canVent(this.side), t: r1(bd.t), msgs: this.newMsgs(sh, bd) };
    }
    return null;
  };
  // Кадр не дошёл (медленная связь): всё разностное — заново полным
  Viewer.prototype.lost = function() { this.scFor = -1; this.agPrev = null; this.rmPrev = null; this.craftKnown = {}; this.whoFor = -1; };
  Viewer.prototype.heldList = function(bd) { var out = []; for (var k in bd.rs) if (bd.rs[k].held) out.push(+k); return out; };
  Viewer.prototype.newMsgs = function(sh, bd) {
    var m = this.mk(sh.n), out = [];
    if (m.bdObj !== bd) { m.bdObj = bd; m.bmsg = 0; }
    for (var i = 0; i < bd.ev.msgs.length; i++) { var x = bd.ev.msgs[i]; if (x.seq > m.bmsg) { out.push(x); m.bmsg = x.seq; } }
    return out;
  };
  Viewer.prototype.mk = function(n) { return this.mark[n] || (this.mark[n] = { scorch: 0, blasts: -1, guns: -1, bshot: -1, bboom: -1, bvent: -1, bmsg: 0, scObj: null }); };

  // Лёгкий кадр (5 раз в секунду)
  Viewer.prototype.light = function() {
    var B = this.B, side = this.side, i, out = { t: 's', T: r2(B.t), over: B.over, ships: [], craft: [], spd: this.spd };
    this.lk = (this.lk || 0) + 1;
    for (i = 0; i < B.ships.length; i++) {
      var ship = B.ships[i];
      // орбита системы: спящий корабль стоит — его строка нужна раз в десять кадров (и всегда в первом)
      if (ship.dormant && this.lk % 10 !== 1 && i !== this.sel && i !== this.foe && i !== this.view) continue;
      out.ships.push(this.shipLight(ship));
    }
    for (i = 0; i < B.craft.length; i++) {
      var c = B.craft[i]; if (c.dead) continue;
      if (B.fog && c.side !== side && !B.visC[side][c.id]) continue;
      if (c.idle && this.craftKnown[c.id] && this.lk % 10 !== 1) { out.craft.push([c.id]); continue; }   // стоит на орбите: только «жив», положение раз в десять кадров
      var row = [c.id, r0(c.x), r0(c.y), Math.round(c.hd * 100) / 100, r0(c.hp)];
      // что за машина — один раз
      if (!this.craftKnown[c.id]) { this.craftKnown[c.id] = 1; row.push(c.type, c.side, c.role, c.faction || '', c.img || '', c.len, r0(c.max), c.tgt != null && typeof c.tgt === 'number' ? c.tgt : -1); }
      out.craft.push(row);
    }
    out.vis = B.vis[side]; out.visC = null;
    var last = {}, L = B.last[side];
    for (var k in L) last[k] = [r0(L[k].x), r0(L[k].y), Math.round(L[k].hd * 100) / 100, r1(L[k].t)];
    out.last = this.noLast ? {} : last;            // орбита: туман без «засечек»
    // события
    var ev = this.ev;
    out.ev = {
      shots: ev.shots.map(function(s) { return [r0(s.x0), r0(s.y0), r0(s.x1), r0(s.y1), r2(s.t0), r2(s.dur), s.side, s.t, s.miss ? 1 : 0]; }),
      booms: ev.booms.map(function(b) { return [r0(b.x), r0(b.y), r0(b.r), r2(b.t0), b.ship == null ? -1 : b.ship, (b.big ? 1 : 0) | (b.ion ? 2 : 0) | (b.craft ? 4 : 0)]; }),
      shields: ev.shields.map(function(s) { return [s.ship, s.s, r0(s.x), r0(s.y), r2(s.t0), s.down ? 1 : 0]; }),
      kills: ev.kills, boards: ev.boards, rams: ev.rams || []
    };
    this.ev = { shots: [], booms: [], shields: [], kills: [], boards: [] };
    // можно ли абордаж: по выбранной цели или по кораблю, куда смотрим изнутри
    // пары «наш корабль → цель»: выбранный → цель (или корабль, куда смотрим);
    // свой корабль под абордажем → корабль атакующих (контрабордаж снимает бойцов с обороны)
    var tgt = this.view >= 0 && B.ships[this.view] && B.ships[this.view].side !== side ? this.view : this.foe, pairs = [];
    var self = this;
    if (this.sel >= 0 && B.ships[this.sel] && this.ctl(B.ships[this.sel]) && tgt >= 0 && B.ships[tgt]) pairs.push([this.sel, tgt]);
    // и ближние враги выбранного (до трёх, в 10 км), если у него есть десант: полоса подскажет,
    // кого можно брать на абордаж прямо сейчас
    var me = this.sel >= 0 && B.ships[this.sel];
    if (me && !me.dead && this.ctl(me) && B.troopsOf(me, false).length) {
      B.ships.filter(function(o) { return !o.dead && o.side !== side && o.n !== tgt && B.sees(side, o) && Math.abs(o.x - me.x) + Math.abs(o.y - me.y) < 14000; })
        .map(function(o) { var dx = o.x - me.x, dy = o.y - me.y; return [dx * dx + dy * dy, o.n]; })
        .filter(function(q) { return q[0] < 10000 * 10000; })
        .sort(function(p, q) { return p[0] - q[0]; }).slice(0, 3)
        .forEach(function(q) { pairs.push([me.n, q[1]]); });
    }
    var vs = this.view >= 0 && B.ships[this.view];
    if (vs && self.ctl(vs) && vs.crew.board && vs.crew.board.started && vs.crew.board.over < 0) {
      B.ships.forEach(function(o) { if (!o.dead && o.side !== side) pairs.push([vs.n, o.n]); });
    }
    out.can = pairs.slice(0, 7).map(function(p) {
      var own = B.ships[p[0]].crew.board, all = !!(own && own.started && own.over < 0 && own.def === side);
      var cb = B.canBoard(p[0], p[1], all);
      return { n: p[0], t: p[1], ok: cb.ok, why: cb.why || '', party: cb.party || 0, reinforce: !!cb.reinforce, cap: cb.cap || 0,
               gap: cb.gap, need: cb.need, sec: cb.sec, shK: cb.shK, stuck: !!cb.stuck, beam: cb.beam ? 1 : 0, tro: cb.tro };
    });
    return out;
  };

  // Корабль изнутри: отсеки, копоть, вспышки, абордаж.
  // mode: 'full' — смотрим внутрь; 'lite' — только отсеки (панель своего корабля);
  // 'foe' — целость отсеков цели (схема прицела)
  Viewer.prototype.heavy = function(n, mode) {
    var B = this.B, sh = B.ships[n]; if (!sh) return null;
    var own = sh.side === this.side, bd = sh.crew.board, involved = bd && bd.started && (bd.att === this.side || bd.def === this.side);
    var c = sh.crew, m = this.mk(n), i, st, out = { t: 'h', n: n, ct: r2(c.t), rooms: [] };
    if (mode === 'foe') {
      // чужой корабль: чертёж класса известен, состояние отсеков — нет (только при нашем десанте на борту)
      if (own || !involved || !B.sees(this.side, sh)) return null;
      out.lite = 2;
      for (i = 0; i < c.roomList.length; i++) { st = c.roomList[i]; if (st.integ < 99.5) out.rooms.push([st.n, r0(st.integ)]); }
      return out;
    }
    if (!own && !involved) return null;                       // чужой корабль без нашего абордажа — внутрь не смотрим
    out.alert = c.alertOn ? 1 : 0;
    // внутри — только отсеки, что изменились с прошлого кадра
    var rp = mode === 'full' ? (this.rmPrev && this.rmPrev.n === n ? this.rmPrev.m : null) : null, rm = {};
    for (i = 0; i < c.roomList.length; i++) {
      st = c.roomList[i];
      var row = [st.n, r0(st.integ), r1(st.stun), st.fires, own ? st.staffed : 0, st.need, own ? st.assigned : 0], key = row.join(',');
      rm[st.n] = key;
      if (!rp || rp[st.n] !== key) out.rooms.push(row);
    }
    if (mode === 'full') this.rmPrev = { n: n, m: rm };
    if (mode === 'lite') { out.lite = 1; return out; }
    // кто есть кто из бойцов игры (тип, имя героя) — когда список поменялся
    if (this.whoFor !== n || this.whoN !== c.agents.length) {
      this.whoFor = n; this.whoN = c.agents.length; out.who = [];
      for (i = 0; i < c.agents.length; i++) { var wa = c.agents[i]; if (wa.utype) out.who.push([i, wa.utype, wa.uname || '', wa.hero ? 1 : 0]); }
    }
    // копоть: с первого кадра внутри — вся, дальше — новая (массив подрезается с начала)
    var sc = c.scorch, from = 0;
    if (this.scFor === n && m.scLast) { from = sc.lastIndexOf(m.scLast) + 1; if (from === 0) out.scAll = 1; }
    else out.scAll = 1;
    this.scFor = n;
    out.scorch = sc.slice(out.scAll ? 0 : from).map(function(q) { return [r1(q.x), r1(q.y), r1(q.r), r2(q.a)]; });
    m.scLast = sc.length ? sc[sc.length - 1] : null;
    out.blasts = c.ev.blasts.filter(function(b) { return b.t > m.blasts; }).map(function(b) { return [r1(b.x), r1(b.y), r1(b.r), r2(b.t)]; });
    if (c.ev.blasts.length) m.blasts = Math.max(m.blasts, c.ev.blasts[c.ev.blasts.length - 1].t);
    out.guns = c.ev.guns.filter(function(g) { return g.t > m.guns; }).map(function(g) { return [g.n, r2(g.t)]; });
    if (c.ev.guns.length) m.guns = Math.max(m.guns, c.ev.guns[c.ev.guns.length - 1].t);
    if (involved) out.bd = this.boardHeavy(sh, bd, m);
    return out;
  };
  Viewer.prototype.boardHeavy = function(sh, bd, m) {
    var i, o = {};
    o.doors = []; o.weld = [];
    for (i = 0; i < bd.doors.length; i++) {
      var d = bd.doors[i];
      o.doors.push(DOOR_N[d.state] * 64 + Math.min(63, Math.round(d.breach / bd.breachNeed(d) * 63)));
      // сварщик в пути — тоже «варят»: второй раз не послать
      if (d.weld || d.weldP > 0 || d.welder >= 0) o.weld.push([i, d.weld ? 1 : 0, Math.max(0.01, r2(d.weldP || 0))]);
    }
    o.tur = bd.turrets.map(function(t) { return [r0(t.hp), r2(t.aim), t.tgt >= 0 ? 1 : 0, t.dead ? 1 : 0, r2(t.fireAt)]; });
    // атакующие не знают, сколько защитников в отсеке, пока сами туда не вошли
    var blind = bd.att === this.side && !bd.heldType('cic');
    o.rs = []; for (var k in bd.rs) { var s = bd.rs[k], c0 = s.cnt[0], c1 = s.cnt[1];
      if (blind && !s.cnt[bd.att]) { if (bd.def === 0) c0 = 0; else c1 = 0; }
      if (s.held || s.hold > 0 || s.back > 0 || c0 || c1) o.rs.push([s.n, s.held ? 1 : 0, r1(s.hold), c0, c1, r1(s.back)]); }
    o.vent = bd.ventCd.slice();
    if (m.bdObj2 !== bd) { m.bdObj2 = bd; m.bshot = -1; m.bboom = -1; m.bvent = -1; }
    o.shots = bd.ev.shots.filter(function(s) { return s.t > m.bshot; }).map(function(s) { return [r1(s.x0), r1(s.y0), r1(s.x1), r1(s.y1), r2(s.t), s.team, s.hit ? 1 : 0, s.w, s.d || 0, s.ti == null ? -1 : s.ti, s.wall ? 1 : 0]; });
    if (bd.ev.shots.length) m.bshot = Math.max(m.bshot, bd.ev.shots[bd.ev.shots.length - 1].t);
    o.booms = bd.ev.booms.filter(function(b) { return b.t > m.bboom; }).map(function(b) { return [r1(b.x), r1(b.y), r1(b.r), r2(b.t)]; });
    if (bd.ev.booms.length) m.bboom = Math.max(m.bboom, bd.ev.booms[bd.ev.booms.length - 1].t);
    o.vents = bd.ev.vents.filter(function(v) { return v.t > m.bvent; }).map(function(v) { return [v.n, r2(v.t)]; });
    if (bd.ev.vents.length) m.bvent = Math.max(m.bvent, bd.ev.vents[bd.ev.vents.length - 1].t);
    return o;
  };
  // Люди корабля — двоичный кадр. Абордажной команде — только те, кого её бойцы видят.
  // Полный кадр — при входе и раз в 5 с; между ними — только изменившиеся (карта битов + записи):
  // кто стоит на посту, тот не стоит трафика.
  Viewer.prototype.agentsBin = function(n, tick) {
    var B = this.B, sh = B.ships[n], c = sh.crew, ag = c.agents, bd = c.board, W = sh.plan.w;
    var fog = bd && bd.started && bd.att === this.side && sh.side !== this.side ? bd.vis : null;
    var N = ag.length, cur = new Uint8Array(N * AG), v = new DataView(cur.buffer), o = 0;
    for (var i = 0; i < N; i++) {
      var a = ag[i], hidden = fog && a.team !== this.side && a.alive && !fog[i];
      var fl = (a.alive ? 1 : 0) | (a.at ? 2 : 0) | (a.carry ? 4 : 0) | (a.gone ? 8 : 0) | (hidden ? 16 : 0) | (a.breach >= 0 ? 32 : 0) | (a.face != null ? 64 : 0) | (a.team ? 128 : 0);
      if (hidden) { v.setUint8(o + 6, fl); v.setUint8(o + 15, 0); o += AG; continue; }   // кого не видно — без места и дел
      // место — до 1/16 клетки, взгляд — 64 направления: мелкая дрожь стоящих не идёт в сеть
      v.setUint16(o, Math.max(0, Math.min(65535, Math.round(a.x * 16) * 4)), true); v.setUint16(o + 2, Math.max(0, Math.min(65535, Math.round(a.y * 16) * 4)), true);
      v.setUint8(o + 4, (Math.round((((a.aim % 6.2832) + 6.2832) % 6.2832) / 6.2832 * 64) & 63) * 4);
      v.setUint8(o + 5, Math.round(Math.max(0, Math.min(1, a.hp / (a.hpMax || 100))) * 255));
      v.setUint8(o + 6, fl);
      v.setUint8(o + 7, (a.job ? JOB_N[a.job.kind] || 0 : 0) | ((ROLE_N[a.role] || 0) << 4));
      v.setUint8(o + 8, a.fig || 0);
      v.setUint8(o + 9, (WPN_N[a.wpn] || 0) | (a.sq ? Math.min(15, a.sq) << 4 : 0));
      // куда смотрит работа: огонь под струёй, машина под сваркой, пациент — смещением от себя
      var tx = -1;
      if (a.sprayAt >= 0) tx = a.sprayAt; else if (a.fixAt >= 0) tx = a.fixAt;
      var dx = 0, dy = 0;
      if (tx >= 0) { dx = tx % W - Math.floor(a.x); dy = Math.floor(tx / W) - Math.floor(a.y); }
      else if (a.job && a.job.kind === 'heal' && ag[a.job.who]) { dx = Math.round(ag[a.job.who].x - a.x); dy = Math.round(ag[a.job.who].y - a.y); }
      v.setInt8(o + 10, Math.max(-127, Math.min(127, dx))); v.setInt8(o + 11, Math.max(-127, Math.min(127, dy)));
      // где: отсек дела или цели (для подписи «кто это»)
      var where = a.job && a.job.room ? a.job.room : a.job && (a.job.kind === 'defend' || a.job.kind === 'board') ? a.goalRoom : (a.goalRoom || a.home);
      v.setUint16(o + 12, where > 0 ? where : 0, true);
      v.setUint8(o + 14, (a.tgt >= 0 && a.tgt != null ? 1 : 0) | (a.guard ? 2 : 0) | (a.task === 'post' ? 4 : 0) | (a.eng ? 8 : 0) | (a.inCov ? 16 : 0) | (a.post ? 32 : 0));
      v.setUint8(o + 15, Math.min(255, a.sq || a.dsq || 0));
      o += AG;
    }
    var prev = this.agPrev && this.agPrev.n === n && tick % 50 !== 0 ? this.agPrev.b : null;
    this.agPrev = { n: n, b: cur };
    var head = function(type, len) { var out = new Uint8Array(len), hv = new DataView(out.buffer); hv.setUint8(0, type); hv.setUint8(1, n & 255); hv.setUint16(2, N, true); hv.setFloat32(4, c.t, true); hv.setUint16(8, n, true); return out; };
    if (!prev) { var full = head(BIN.AGENTS, AH + cur.length); full.set(cur, AH); return full.buffer; }
    var bits = new Uint8Array(Math.ceil(N / 8)), ch = [];
    for (i = 0; i < N; i++) {
      var same = i * AG + AG <= prev.length;
      for (var j = 0; same && j < AG; j++) if (cur[i * AG + j] !== prev[i * AG + j]) same = false;
      if (!same) { bits[i >> 3] |= 1 << (i & 7); ch.push(i); }
    }
    var d = head(BIN.AGENTS_D, AH + bits.length + ch.length * AG);
    d.set(bits, AH);
    for (i = 0, o = AH + bits.length; i < ch.length; i++, o += AG) d.set(cur.subarray(ch[i] * AG, ch[i] * AG + AG), o);
    return d.buffer;
  };
  Viewer.prototype.fireBin = function(n) {
    var c = this.B.ships[n].crew, bl = c.burning, buf = new ArrayBuffer(8 + bl.length * 5), v = new DataView(buf);
    v.setUint8(0, BIN.FIRE); v.setUint8(1, n & 255); v.setUint16(2, n, true); v.setUint32(4, bl.length, true);
    for (var i = 0, o = 8; i < bl.length; i++, o += 5) { v.setUint32(o, bl[i], true); v.setUint8(o + 4, Math.round(c.fire[bl[i]])); }
    return buf;
  };
  // Что отправить игроку на этом такте сервера: [строки и двоичные кадры]
  Viewer.prototype.frames = function(tick) {
    var out = [];
    this.k++;
    if (tick % LIGHT_EVERY === 0) out.push(JSON.stringify(this.light()));
    var v = this.view;
    if (v >= 0 && this.B.ships[v] && !this.B.ships[v].dead && this.heavyOk(v)) {
      if (tick % AGENTS_EVERY === 0) {
        var h = this.heavyOk(v);
        if (h) { out.push(this.agentsBin(v, tick)); var hv = this.heavy(v, 'full'); if (hv) out.push(JSON.stringify(hv)); }
      }
      if (tick % HEAVY_EVERY === 0 && this.heavyOk(v)) out.push(this.fireBin(v));
    } else { this.scFor = -1; this.agPrev = null; this.rmPrev = null; this.whoFor = -1; }
    if (tick % HEAVY_EVERY === 0) {
      // свой выбранный корабль: отсеки для панели; цель — целость отсеков для схемы прицела
      var S = this.B.ships;
      if (this.sel >= 0 && this.sel !== v && S[this.sel] && S[this.sel].side === this.side) { var hs = this.heavy(this.sel, 'lite'); if (hs) out.push(JSON.stringify(hs)); }
      if (this.foe >= 0 && this.foe !== v && S[this.foe] && !S[this.foe].dead) { var hf = this.heavy(this.foe, 'foe'); if (hf) out.push(JSON.stringify(hf)); }
    }
    return out;
  };
  Viewer.prototype.heavyOk = function(n) {
    var sh = this.B.ships[n]; if (!sh) return false;
    if (sh.side === this.side) return true;
    var bd = sh.crew.board; return !!(bd && bd.started && bd.att === this.side);
  };
  // Корабль под командой этого игрока: своей стороны и его (или ничей; «dev» — вся сторона)
  Viewer.prototype.ctl = function(sh) { return sh.side === this.side && (!sh.owner || !this.user || this.user === 'dev' || sh.owner === this.user); };
  // Приказ игрока: проверка, что корабль свой, и исполнение
  Viewer.prototype.command = function(m) {
    var B = this.B, side = this.side, sh = B.ships[m.n | 0], bd;
    var mine = sh && sh.side === side && !sh.dead && m.n === (m.n | 0) && this.ctl(sh);
    switch (m.k) {
      case 'view': this.sel = m.sel | 0; this.foe = m.foe == null ? -1 : m.foe | 0; this.view = m.view == null ? -1 : m.view | 0; return true;
      case 'target': if (!mine || !Array.isArray(m.guns) || !m.tgt || typeof m.tgt !== 'object') return false;
        var tk = String(m.tgt.k); if (['auto', 'fighters', 'shuttles', 'hull', 'sys', 'room'].indexOf(tk) < 0) return false;
        return B.setTarget(m.n, m.guns.slice(0, 64), { k: tk, ship: m.tgt.ship | 0, sys: typeof m.tgt.sys === 'string' ? m.tgt.sys : undefined, room: m.tgt.room | 0 });
      case 'order': if (!mine) return false;
        if (m.x === 'hold') B.order(m.n, 'hold'); else if (m.x == null) B.order(m.n, null);
        else B.order(m.n, +m.x, +m.y, !!m.face);
        return true;
      case 'attack': if (!mine) return false; if (m.to == null || m.to < 0) { B.attack(m.n, null); return true; } return B.attack(m.n, m.to | 0) >= 0 && sh.foeT === (m.to | 0);
      case 'focus': if (!mine) return false; if (m.auto) { sh.focusAuto = true; return true; } B.setFocus(m.n, m.s | 0); return true;
      case 'board': if (!mine || !B.ships[m.to | 0]) return false; return B.board(m.n, m.to | 0, !!m.all);
      case 'hold': if (!mine) return false; B.setHold(m.n, m.to | 0, !!m.on); return true;
      case 'stand': if (!mine || !Array.isArray(m.ids)) return false; return B.standTroops(m.n, m.ids.slice(0, 128).map(Number), m.cell == null ? -1 : m.cell | 0) > 0;
      case 'tractor': this.lastWhy = ''; if (!mine) return false; this.lastWhy = B.tractor(m.n, m.to == null ? -1 : m.to | 0); return !this.lastWhy;
      case 'wing': if (!mine) return false; return B.setWing(m.n, String(m.mode));
    }
    // абордаж: по кораблю-цели, сторона — игрока
    var t = B.ships[m.to | 0]; bd = t && t.crew.board;
    if (!bd || !bd.started || bd.over >= 0) return false;
    switch (m.k) {
      case 'border': return bd.order(side, Array.isArray(m.sq) ? m.sq.slice(0, 32).map(Number) : null, m.room | 0, m.cell != null ? m.cell | 0 : -1);
      case 'plant': return bd.plant(side);
      case 'vent': return bd.vent(side, m.room | 0);
      case 'alarm': if (bd.def !== side) return false; return bd.setAlarm(!!m.on);
      case 'bauto': return bd.setAuto(side, Array.isArray(m.sq) ? m.sq.slice(0, 32).map(Number) : null);
      case 'bassign': return bd.assignDef(side, Array.isArray(m.ids) ? m.ids.slice(0, 128) : [], m.sq | 0);
      case 'door': return bd.door(side, m.i | 0);
      case 'weld': return bd.weld(side, m.i | 0);
      case 'bunits': return bd.orderUnits(side, Array.isArray(m.ids) ? m.ids.slice(0, 128) : [], m.cell | 0);
      case 'bfocus': return bd.focusUnits(side, Array.isArray(m.ids) ? m.ids.slice(0, 128) : [], m.tgt | 0);
    }
    return false;
  };

  // Пакет приказов группе кораблей { t:'cmd', k:'many', list:[{k:'order'|'attack', n, x, y, face, to}] }:
  // разложить на обычные приказы (не больше 40; другие виды — мимо)
  var MANY_K = { order: 1, attack: 1 };
  function eachMany(m, fn) {
    if (!m || !Array.isArray(m.list)) return;
    m.list.slice(0, 40).forEach(function(x) {
      if (x && typeof x === 'object' && !Array.isArray(x) && MANY_K[x.k]) fn({ t: 'cmd', k: x.k, n: x.n, x: x.x, y: x.y, face: x.face, to: x.to });
    });
  }

  // ================================================================ браузер
  // B — локальный SWSpace.Battle с теми же кораблями (не считается); send(obj) — на сервер
  function Mirror(B, side, send, SWBoard) {
    this.B = B; this.side = side; this.send = send; this.SWBoard = SWBoard;
    // batch(fn): приказы внутри fn уходят одним пакетом many (если сервер умеет — caps), иначе по одному
    var send0 = send, q = null;
    send = function(m) { if (q && m.t === 'cmd' && MANY_K[m.k]) q.push(m); else send0(m); };
    this.many = false;
    this.batch = function(fn) {
      if (!self.many) { fn(); return; }
      q = [];
      try { fn(); } finally {
        var list = q; q = null;
        for (var i = 0; i < list.length; i += 40) {
          var part = list.slice(i, i + 40);
          if (part.length === 1) send0(part[0]); else send0({ t: 'cmd', k: 'many', list: part.map(function(x) { delete x.t; return x; }) });
        }
      }
    };
    this.snap = [];            // два последних лёгких кадра: { T, at, ships, craft }
    this.queue = { shots: [], booms: [], shields: [], kills: [], boards: [] };
    this.craftMeta = {}; this.agFull = -1; this.agVis = null; this.viewN = -1; this.whoMap = {};
    var self = this;
    B.fog = true;
    // команды — на сервер; на экране — сразу (кадры, что уже в пути, этого не отменят: LOCK)
    var lock = function(o) { if (o) o.netLock = Date.now() + LOCK; };
    B.setTarget = function(n, guns, tgt) {
      var sh = B.ships[n]; if (!sh || sh.dead || !guns || !guns.length) return 0;
      send({ t: 'cmd', k: 'target', n: n, guns: guns, tgt: tgt });
      guns.forEach(function(i) { var g = sh.guns[i]; if (g) { g.tgt = { k: tgt.k, ship: tgt.ship, sys: tgt.sys, room: tgt.room }; lock(g); } });
      return guns.length;
    };
    B.order = function(n, x, y, face) {
      send({ t: 'cmd', k: 'order', n: n, x: x === undefined ? null : x, y: y, face: !!face });
      var s = B.ships[n]; if (!s) return; lock(s);
      s.guard = false;
      if (x === 'hold') { s.ai = false; s.order = null; } else if (x == null) { s.ai = true; s.order = null; } else s.order = { x: x, y: y, face: !!face };
    };
    // атака: на экране сразу — цель корабля и пушки, что на неё переходят (как сделает сервер)
    var attack0 = B.attack;
    B.attack = function(n, to) {
      var sh = B.ships[n]; if (!sh || sh.dead) return 0;
      send({ t: 'cmd', k: 'attack', n: n, to: to == null ? -1 : to });
      var r = attack0.call(B, n, to); lock(sh); sh.guns.forEach(lock);
      return r;
    };
    B.setFocus = function(n, s) { send({ t: 'cmd', k: 'focus', n: n, s: s }); var sh = B.ships[n]; if (sh) { sh.focus = s; sh.focusAuto = false; lock(sh); } };
    B.autoShields = function(n) { send({ t: 'cmd', k: 'focus', n: n, auto: 1 }); var sh = B.ships[n]; if (sh) { sh.focusAuto = true; lock(sh); } };
    // посты десанта: решает сервер, на экране — по кадрам людей (дело «на посту»)
    B.standTroops = function(n, ids, cell) { send({ t: 'cmd', k: 'stand', n: n, ids: ids.slice(0, 128), cell: cell == null ? -1 : cell }); return ids.length; };
    // авиакрыло: режим — на экране сразу
    B.setWing = function(n, mode) { send({ t: 'cmd', k: 'wing', n: n, mode: mode }); var sh = B.ships[n]; if (sh) { sh.wmode = mode; lock(sh); } return true; };
    B.setHold = function(n, t, on) { send({ t: 'cmd', k: 'hold', n: n, to: t, on: !!on }); var sh = B.ships[n]; if (sh) { sh.hold = sh.hold || {}; sh.hold[t] = !!on; lock(sh); } };
    B.canBoard = function(n, t) {
      var l = self.can || [];
      for (var i = 0; i < l.length; i++) if (l[i].n === n && l[i].t === t) return l[i];
      return { ok: false, why: 'жду сервер…', party: 0 };
    };
    B.board = function(n, t, all) {
      var c = B.canBoard(n, t); if (!c.ok) return c;
      send({ t: 'cmd', k: 'board', n: n, to: t, all: !!all });
      self.can = (self.can || []).filter(function(x) { return !(x.n === n && x.t === t); });   // до ответа — не жать дважды
      return { ok: true, party: c.party, shuttles: Math.ceil(c.party / 12), muster: true };
    };
    // притягивающий луч: проверка — по тому, что видно (решает сервер); взял — на экране сразу
    var tractor0 = B.tractor;
    B.tractor = function(n, to) {
      var sh = B.ships[n]; if (!sh || sh.dead) return 'корабля нет';
      if (to != null && to >= 0) { var c = B.tractorCan(n, to); if (!c.ok) return c.why; }
      send({ t: 'cmd', k: 'tractor', n: n, to: to == null ? -1 : to });
      var r = tractor0.call(B, n, to); lock(sh);
      return r;
    };
    B.sensRange = function(sh) { return sh.netSens || sh.sens; };
    B.step = function() {};
    B.takeEvents = function() { var q = self.queue; self.queue = { shots: [], booms: [], shields: [], kills: [], boards: [], rams: [] }; return q; };
  }
  Mirror.prototype.onText = function(m) {
    if (m.t === 's') this.light(m);
    else if (m.t === 'h') this.heavy(m);
  };
  Mirror.prototype.onBin = function(buf) {
    var v = new DataView(buf), type = v.getUint8(0);
    if (type === BIN.AGENTS || type === BIN.AGENTS_D) this.agents(v, type === BIN.AGENTS_D);
    else if (type === BIN.FIRE) this.fire(v);
  };
  Mirror.prototype.light = function(m) {
    var B = this.B, now = Date.now(), i, k;
    m.at = now;
    this.curT = m.T; this.craftT = m.T;
    this.clockSync(m.T, m.spd == null ? 1 : m.spd);
    this.snap.push(m); if (this.snap.length > 3) this.snap.shift();
    B.over = m.over;
    // туман
    B.vis[this.side] = m.vis || {};
    var L = {}; for (k in m.last) { var q = m.last[k]; L[k] = { x: q[0], y: q[1], hd: q[2], t: q[3] }; } B.last[this.side] = L;
    var vc = {}; for (i = 0; i < m.craft.length; i++) vc[m.craft[i][0]] = 1; B.visC[this.side] = vc;
    // малые корабли — новые кадр за кадром; если предыдущий не успели разобрать, позиции из нового
    if (this.craftNext) for (i = 0; i < this.craftNext.length; i++) { var q0 = this.craftNext[i]; if (q0.length > 5 && !this.craftMeta[q0[0]]) this.craftMeta[q0[0]] = { type: q0[5], side: q0[6], role: q0[7], faction: q0[8], img: q0[9] || null, len: q0[10], max: q0[11], tgt: q0[12] >= 0 ? q0[12] : null }; }
    for (i = 0; i < m.ships.length; i++) this.shipState(m.ships[i]);
    // притягивающий луч: держащий в тумане — его луч знаем по своему кораблю
    for (i = 0; i < B.ships.length; i++) B.ships[i].heldBy = null;
    for (i = 0; i < B.ships.length; i++) {
      var hs = B.ships[i];
      if (hs.netHb && B.ships[hs.netHb.by] && !(B.ships[hs.netHb.by].tb && B.ships[hs.netHb.by].tb.to === hs.n)) B.ships[hs.netHb.by].tb = { to: hs.n, until: hs.netHb.until, fog: true };
    }
    for (i = 0; i < B.ships.length; i++) { var hb = B.ships[i]; if (hb.tb && !hb.dead && B.ships[hb.tb.to]) { if (hb.tb.fog && !(B.ships[hb.tb.to].netHb && B.ships[hb.tb.to].netHb.by === hb.n)) { hb.tb = null; continue; } B.ships[hb.tb.to].heldBy = hb.n; } }
    // события: в очередь отрисовки
    var Q = this.queue, e = m.ev;
    e.shots.forEach(function(s) { Q.shots.push({ x0: s[0], y0: s[1], x1: s[2], y1: s[3], t0: s[4], dur: s[5], side: s[6], t: s[7], miss: !!s[8] }); });
    e.booms.forEach(function(b) { Q.booms.push({ x: b[0], y: b[1], r: b[2], t0: b[3], ship: b[4] < 0 ? null : b[4], big: !!(b[5] & 1), ion: !!(b[5] & 2), craft: !!(b[5] & 4) }); });
    e.shields.forEach(function(s) { Q.shields.push({ ship: s[0], s: s[1], x: s[2], y: s[3], t0: s[4], down: s[5] }); });
    e.kills.forEach(function(x) {
      Q.kills.push(x);
      if (x.ship != null) { var s = B.ships[x.ship]; if (s) { s.dead = true; s.why = x.why; if (x.by != null) s.captured = x.by; s.deadAt = m.T; } }
    });
    e.boards.forEach(function(x) { Q.boards.push(x); });
    (e.rams || []).forEach(function(x) { (Q.rams = Q.rams || []).push(x); });
    if (Q.rams && Q.rams.length > 12) Q.rams.splice(0, Q.rams.length - 12);
    // вкладка в фоне: кадры идут, отрисовки нет — не копить старые эффекты
    if (Q.shots.length > 400) Q.shots.splice(0, Q.shots.length - 400);
    if (Q.booms.length > 150) Q.booms.splice(0, Q.booms.length - 150);
    if (Q.shields.length > 150) Q.shields.splice(0, Q.shields.length - 150);
    if (Q.kills.length > 60) Q.kills.splice(0, Q.kills.length - 60);
    if (Q.boards.length > 30) Q.boards.splice(0, Q.boards.length - 30);
    this.can = Array.isArray(m.can) ? m.can : m.can ? [m.can] : [];
    this.craftNext = m.craft;
  };
  // Сдвиг «часы × скорость − время сервера» по кадрам за 4 с: самый быстрый — опора; отставание —
  // шаг кадров + разброс прихода (как в наземке: между двумя известными положениями — всегда)
  Mirror.prototype.clockSync = function(T, spd) {
    if (spd !== this.spdK) { this.offs = []; this.spdK = spd; }
    if (!(spd > 0)) { this.base = null; return; }
    var wall = clock() / 1000, o = wall * spd - T, offs = this.offs, lo = Infinity, hi = -Infinity;
    offs.push([wall, o]); while (offs.length && wall - offs[0][0] > 4) offs.shift();
    for (var i = 0; i < offs.length; i++) { lo = Math.min(lo, offs[i][1]); hi = Math.max(hi, offs[i][1]); }
    this.base = lo; this.lag = STEPR + Math.min(0.35, Math.max(0.03, (hi - lo) / spd)) + 0.02;
  };
  Mirror.prototype.shipState = function(o) {
    var B = this.B, sh = B.ships[o.n]; if (!sh) return;
    if (o.hid) {
      // ушёл из датчиков: его прицелы больше не знаем; абордаж на нём — по сводке
      sh.netHid = true; for (var hg = 0; hg < sh.guns.length; hg++) sh.guns[hg].aimAt = null;
      sh.tb = null;                                                   // его луч не видно (держит нас — узнаем по своему кораблю)
      if (o.dead && !sh.dead) { sh.dead = true; sh.deadAt = B.t; sh.why = 'gone'; }   // пропал в тумане — без остова и места
      this.boardState(sh, o.bd); return;
    }
    var wasHid = sh.netHid; sh.netHid = false;
    sh.net = sh.net || {};
    sh.net.cur = { x: o.x, y: o.y, hd: o.hd };
    // положения по времени сервера; вынырнул из тумана или погиб — с чистого листа (без проезда через полкарты)
    var T = this.curT != null ? this.curT : 0, spdS = STEPR * (this.spdK > 0 ? this.spdK : 1);
    if (!sh.net.ks || wasHid || o.dead) sh.net.ks = [{ x: o.x, y: o.y, hd: o.hd, T: T }];
    else keyPush(sh.net.ks, o.x, o.y, o.hd, T, spdS);
    var mine = !(sh.netLock > Date.now());
    if (o.hm) { sh.hullMax = o.hm; sh.shMax = o.sm; sh.foreK = o.fk || 1; }
    sh.v = o.v; sh.hull = o.hull; sh.sh = o.sh;
    if (mine) { sh.focus = o.f; sh.focusAuto = !!o.fa; }
    if (o.e) { sh.eff.engine = o.e[0]; sh.eff.reactor = o.e[1]; sh.eff.shield = o.e[2]; sh.eff.bridge = o.e[3]; sh.eff.hangar = o.e[4]; sh.eff.power = o.e[5]; }
    else { sh.eff.engine = sh.eff.reactor = sh.eff.shield = sh.eff.bridge = sh.eff.hangar = sh.eff.power = 1; }   // чужой: систем не видно — рисуем как исправный
    sh.crit = o.crit; if (o.dead && !sh.dead) { sh.dead = true; sh.deadAt = B.t; } sh.why = o.why || sh.why; if (o.cap != null) sh.captured = o.cap; sh.inbound = o.inb;
    var T0 = this.curT != null ? this.curT : B.t;
    if (mine) sh.tb = o.tb ? { to: o.tb[0], until: T0 + o.tb[1] } : null;   // только что взял лучом сам — ждём кадр с сервера (LOCK)
    if (sh.side === this.side) {
      sh.tractor = !!o.tx; if (mine) sh.tbReady = o.tc ? T0 + o.tc : 0;
      sh.netHb = o.hb ? { by: o.hb[0], until: T0 + o.hb[1] } : null;
    }
    sh.netBurn = o.burn; if (this.viewN !== sh.n) { sh.netCt = o.ct; sh.netCtAt = Date.now(); sh.netCtT = this.curT; }
    if (o.fs) {
      // наружный огонь: прислали выборку клеток
      if (this.viewN !== sh.n) { var c = sh.crew; for (var j = 0; j < c.burning.length; j++) c.fire[c.burning[j]] = 0; c.burning = []; for (j = 0; j < o.fs.length; j += 2) { c.burning.push(o.fs[j]); c.fire[o.fs[j]] = o.fs[j + 1]; } }
    }
    if (sh.side === this.side) {
      sh.boardCd = o.cd;
      sh.ctl = o.ow !== 2;
      if (o.wg) { if (mine) sh.wmode = WM_N[o.wg[0]] || 'auto'; sh.netWing = { bay: o.wg[1], fly: o.wg[2], lost: o.wg[3], out: !!o.wg[4] }; } else sh.netWing = null;
      if (mine) { sh.ai = !!o.ai; sh.guard = !!o.gd; sh.foeT = o.at >= 0 ? o.at : null; sh.order = o.ord ? { x: o.ord[0], y: o.ord[1], face: !!o.ord[2] } : null; sh.hold = o.hold || null; }
      sh.netAlive = o.alive; sh.netSens = o.sens; sh.crew.alertOn = !!o.alert;
      sh.netTroops = o.tr || null; sh.netPosts = o.ps || 0; sh.netGuards = o.gu || null; sh.netMuster = o.mu || 0; sh.netHeroes = o.hn || []; sh.crew.crewLost = o.cl || 0;
      if (o.veh != null && (!sh.vehicles || sh.vehicles.length !== o.veh)) { sh.vehicles = []; for (var vv = 0; vv < o.veh; vv++) sh.vehicles.push('?'); }
      for (var i = 0; i < o.g.length && i < sh.guns.length; i++) {
        var g = sh.guns[i], a = o.g[i];
        g.aimAt = a[0] >= 0 ? { ship: B.ships[a[0]], room: a[1] } : a[2] ? { craft: this.craftById(a[2]) } : null;
        if (g.aimAt && g.aimAt.craft === null) g.aimAt = null;
        g.out = !!a[3]; g.cd = a[4] * g.T.reload;
        if (!(g.netLock > Date.now())) { g.tgt = { k: a[5], ship: a[6] >= 0 ? a[6] : undefined, sys: a[7] || undefined, room: a[8] || undefined }; g.keep = a[9] ? (a[9] === 'hull' ? { k: 'hull' } : { k: 'sys', sys: a[9] }) : null; }
      }
      if (!sh.crew.netAlive) { sh.crew.netAlive = true; sh.crew.alive = function() { return sh.netAlive || 0; }; }
    } else {
      for (var q = 0; q < sh.guns.length; q++) sh.guns[q].aimAt = null;
      for (q = 0; q < o.g.length; q++) { var gg = sh.guns[o.g[q][0]]; if (gg) gg.aimAt = { ship: B.ships[o.g[q][1]], room: o.g[q][2] }; }
    }
    this.boardState(sh, o.bd);
  };
  Mirror.prototype.craftById = function(id) {
    for (var i = 0; i < this.B.craft.length; i++) if (this.B.craft[i].id === id) return this.B.craft[i];
    return null;
  };
  // Абордаж: объект Board на клиенте (те же двери и турели из плана), состояние — с сервера
  Mirror.prototype.boardState = function(sh, o) {
    var bd = sh.crew.board;
    if (!o) return;
    // прошлый абордаж кончился, начался новый — новый объект (сообщения и события с нуля)
    if (bd && bd.over >= 0 && o.over < 0) bd = null;
    if (!bd) {
      if (sh.dormant) this.B.wake(sh);
      bd = new this.SWBoard.Board(sh.crew, { flagship: sh.len >= 1200, figIds: sh.figIds, seed: 1 });
      bd.started = true;
      bd.defManual = bd.def === this.side;          // свою оборону ведёт игрок: отряды собирает он (как на сервере)
    }
    bd.started = true; bd.over = o.over; bd.alarm = !!o.alarm; bd.alarmCd = o.alarmCd; bd.bridgeT = o.bt; bd.holdNeed = o.hn; bd.t = o.t; bd.prep = o.pr || 0;
    bd.charge = o.ch ? { armed: !!o.ch.a, left: o.ch.l, plant: o.ch.p, defuse: o.ch.d } : null;
    var held = {}; o.held.forEach(function(n) { held[n] = 1; });
    for (var k in bd.rs) bd.rs[k].held = !!held[k];
    if (o.br && bd.bridge && bd.rs[bd.bridge]) { var b = bd.rs[bd.bridge]; b.held = !!o.br[0]; b.hold = o.br[1]; b.cnt[0] = o.br[2]; b.cnt[1] = o.br[3]; }
    bd.netSum = o.su; bd.netPlant = o.pw; bd.netVent = o.vw;
    if (!bd.netPatched) {
      bd.netPatched = true;
      var self = this, n = sh.n;
      bd.summary = function() { return bd.netSum || { att: 0, def: 0, crew: 0, sq: [] }; };
      bd.canPlant = function() { return bd.netPlant; };
      bd.canVent = function() { return bd.netVent; };
      bd.plant = function() { self.send({ t: 'cmd', k: 'plant', to: n }); return true; };
      bd.vent = function(team, room) { self.send({ t: 'cmd', k: 'vent', to: n, room: room }); return true; };
      bd.setAlarm = function(on) { self.send({ t: 'cmd', k: 'alarm', to: n, on: !!on }); bd.alarm = !!on; return true; };
      bd.tick = function() {}; bd.think = function() {}; bd.owns = function() { return false; };
      // оборона: приказы отрядам, двери, сварка — на сервер; проверки — по присланному
      var listFor = function(team) { return team === bd.def ? (bd.netSum && bd.netSum.dsq || []) : (bd.netSum && bd.netSum.sq || []); };
      bd.order = function(team, ids, room, cell) {
        var pt = cell != null && cell >= 0;
        if (pt) room = bd.ship.room[cell] || 0;
        self.send({ t: 'cmd', k: 'border', to: n, sq: ids, room: room, cell: pt ? cell : undefined }); var c = 0;
        listFor(team).forEach(function(q) { if (q.n && (!ids || ids.indexOf(q.id) >= 0)) { q.room = room; q.auto = false; q.cell = pt ? cell : -1; c++; } });
        // приказ всем при обороне за игроком идёт и бойцам без отряда (как на сервере)
        if (!ids && team === bd.def && bd.defManual && bd.c.agents.some(function(a) { return a.alive && !a.gone && a.team === team && !a.dsq && a.job && a.job.kind === 'defend'; })) c++;
        clearOwn(team, ids);
        return c;
      };
      // приказ отряду снимает с его бойцов точки и цели, отданные поштучно (как на сервере)
      var clearOwn = function(team, ids) {
        bd.c.agents.forEach(function(a) { var q = team === bd.def ? a.dsq : a.sq; if (a.team === team && (!ids || ids.indexOf(q) >= 0)) { a.post = null; a.focus = -1; } });
      };
      // бойцы поштучно: на экране — сразу (точка и цель у себя), решает сервер
      bd.orderUnits = function(team, ids, cell) {
        if (bd.over >= 0) return 0;
        ids = ids.slice(0, 128);
        self.send({ t: 'cmd', k: 'bunits', to: n, ids: ids, cell: cell });
        var W = bd.ship.w, k = 0; ids.forEach(function(id) { var a = bd.c.agents[id]; if (a && a.alive && a.team === team) { a.post = [cell % W, Math.floor(cell / W)]; a.postAt = Date.now(); k++; } });
        return k;
      };
      bd.focusUnits = function(team, ids, tid) {
        if (bd.over >= 0) return 0;
        ids = ids.slice(0, 128);
        self.send({ t: 'cmd', k: 'bfocus', to: n, ids: ids, tgt: tid });
        var k = 0; ids.forEach(function(id) { var a = bd.c.agents[id]; if (a && a.alive && a.team === team) { a.focus = tid; k++; } });
        return k;
      };
      bd.setAuto = function(team, ids) {
        self.send({ t: 'cmd', k: 'bauto', to: n, sq: ids }); var c = 0;
        listFor(team).forEach(function(q) { if (q.n && (!ids || ids.indexOf(q.id) >= 0)) { q.auto = true; c++; } });
        clearOwn(team, ids);
        return c;
      };
      // отряд собирает игрок: решает сервер; на экране номер отряда придёт со следующим кадром
      bd.assignDef = function(team, ids, sqId) {
        if (bd.over >= 0 || team !== bd.def) return 0;
        ids = ids.slice(0, 128);
        self.send({ t: 'cmd', k: 'bassign', to: n, ids: ids, sq: sqId | 0 });
        return ids.length;
      };
      bd.door = function(team, i) { if (bd.canDoor(team, i) !== '') return false; self.send({ t: 'cmd', k: 'door', to: n, i: i }); var d = bd.doors[i]; d.state = d.state === 'locked' ? 'open' : 'locked'; return true; };
      bd.weld = function(team, i) { if (bd.canWeld(team, i) !== '') return false; self.send({ t: 'cmd', k: 'weld', to: n, i: i }); bd.doors[i].weldP = 0.01; return true; };
      bd.canWeld = function(team, i) {
        var d = bd.doors[i];
        if (!d) return 'нет двери';
        if (team !== bd.def) return 'варят защитники';
        if (d.state !== 'locked') return 'сначала запереть';
        if (d.weld) return 'уже заварена';
        if (d.weldP > 0) return 'уже варят';
        return '';
      };
    }
    // отряды: члены по номерам (для центра отряда и меток)
    var keep = function(list, src) {
      return src.map(function(q) { var old = null; for (var i = 0; i < (list || []).length; i++) if (list[i].id === q.id) old = list[i]; return { id: q.id, members: old ? old.members : [], room: q.room, auto: q.auto, cell: q.c != null ? q.c : -1, wait: q.w || 0, land: q.w ? q.room : -1 }; });
    };
    if (o.su && o.su.sq) bd.squads = keep(bd.squads, o.su.sq);
    if (o.su && o.su.dsq) bd.dsq = keep(bd.dsq, o.su.dsq);
    if (o.su && o.su.dm != null) bd.defManual = !!o.su.dm;           // кто ведёт оборону — решает сервер
    for (var i = 0; i < o.msgs.length; i++) bd.ev.msgs.push(o.msgs[i]);
    if (o.msgs.length) bd.seq = o.msgs[o.msgs.length - 1].seq;
    if (bd.ev.msgs.length > 40) bd.ev.msgs.splice(0, 20);
  };
  Mirror.prototype.heavy = function(m) {
    var sh = this.B.ships[m.n]; if (!sh) return;
    var c = sh.crew, i, st;
    if (m.lite === 2) {
      // цель: присланы только повреждённые отсеки
      for (i = 0; i < c.roomList.length; i++) c.roomList[i].integ = 100;
      for (i = 0; i < m.rooms.length; i++) { st = c.rooms[m.rooms[i][0]]; if (st) st.integ = m.rooms[i][1]; }
      return;
    }
    c.alertOn = !!m.alert;
    for (i = 0; i < m.rooms.length; i++) {
      var r = m.rooms[i]; st = c.rooms[r[0]]; if (!st) continue;
      st.integ = r[1]; st.stun = r[2]; st.fires = r[3]; st.staffed = r[4]; st.need = r[5]; st.assigned = r[6];
    }
    if (m.lite) return;
    // время экипажа: к нему привязаны вспышки и выстрелы внутри
    sh.netCt = m.ct; sh.netCtAt = Date.now(); sh.netCtT = this.curT;
    if (m.scAll) c.scorch = [];
    if (m.who) { var wm = this.whoMap[m.n] = {}; m.who.forEach(function(w) { wm[w[0]] = w; }); this.applyWho(sh); }
    (m.scorch || []).forEach(function(q) { c.scorch.push({ x: q[0], y: q[1], r: q[2], a: q[3] }); });
    if (c.scorch.length > 200) c.scorch.splice(0, 50);
    (m.blasts || []).forEach(function(b) { c.ev.blasts.push({ x: b[0], y: b[1], r: b[2], t: b[3] }); });
    (m.guns || []).forEach(function(g) { c.ev.guns.push({ n: g[0], t: g[1] }); });
    if (c.ev.blasts.length > 60) c.ev.blasts.splice(0, 30);
    if (c.ev.guns.length > 60) c.ev.guns.splice(0, 30);
    var bd = c.board, o = m.bd;
    if (bd && o) {
      for (i = 0; i < bd.doors.length; i++) { bd.doors[i].weld = 0; bd.doors[i].weldP = 0; }
      (o.weld || []).forEach(function(w) { var dw = bd.doors[w[0]]; if (dw) { dw.weld = w[1]; dw.weldP = w[2]; } });
      for (i = 0; i < o.doors.length && i < bd.doors.length; i++) {
        var d = bd.doors[i], st2 = DOOR_ST[o.doors[i] >> 6];
        d.state = st2; d.breach = (o.doors[i] & 63) / 63 * bd.breachNeed(d);
      }
      for (i = 0; i < o.tur.length && i < bd.turrets.length; i++) { var t = bd.turrets[i], q = o.tur[i]; t.hp = q[0]; t.aim = q[1]; t.tgt = q[2] ? 1 : -1; t.dead = !!q[3]; t.fireAt = q[4]; }
      for (var k in bd.rs) { var s0 = bd.rs[k]; s0.hold = 0; s0.back = 0; s0.cnt[0] = 0; s0.cnt[1] = 0; }
      o.rs.forEach(function(x) { var s = bd.rs[x[0]]; if (!s) return; s.held = !!x[1]; s.hold = x[2]; s.cnt[0] = x[3]; s.cnt[1] = x[4]; s.back = x[5]; });
      bd.ventCd = o.vent;
      o.shots.forEach(function(s) { bd.ev.shots.push({ x0: s[0], y0: s[1], x1: s[2], y1: s[3], t: s[4], team: s[5], hit: !!s[6], w: s[7], d: s[8] || 0, ti: s[9] == null ? -1 : s[9], wall: !!s[10] }); });
      o.booms.forEach(function(b) { bd.ev.booms.push({ x: b[0], y: b[1], r: b[2], t: b[3] }); });
      o.vents.forEach(function(v) { bd.ev.vents.push({ n: v[0], t: v[1] }); });
      var ct = m.ct;
      while (bd.ev.shots.length && ct - bd.ev.shots[0].t > 1.5) bd.ev.shots.shift();
      while (bd.ev.booms.length && ct - bd.ev.booms[0].t > 3) bd.ev.booms.shift();
      while (bd.ev.vents.length && ct - bd.ev.vents[0].t > 4) bd.ev.vents.shift();
    }
  };
  // Люди: новое положение — цель сглаживания; служебные поля — сразу
  Mirror.prototype.agents = function(v, delta) {
    var n = v.getUint16(8, true), N = v.getUint16(2, true), ct = v.getFloat32(4, true), sh = this.B.ships[n]; if (!sh) return;
    if (sh.dormant) this.B.wake(sh);                                   // смотрим внутрь: нужен настоящий экипаж (карты, отсеки)
    var c = sh.crew, ag = c.agents, now = Date.now(), o = AH, W = sh.plan.w, i;
    // разностный кадр к кораблю, полного кадра которого ещё не было, — ждём полный
    if (delta && this.agFull !== n) return;
    if (!delta) this.agFull = n;
    sh.netView = true; sh.netCt = ct; sh.netCtAt = now; sh.netCtT = this.curT;
    if (ag.length > N) ag.length = N;
    var bd = c.board, list = [];
    if (delta) {
      var nb = Math.ceil(N / 8), base = AH + nb, k = 0;
      for (i = 0; i < N; i++) if (v.getUint8(AH + (i >> 3)) & (1 << (i & 7))) list.push([i, base + (k++) * AG]);
    } else for (i = 0; i < N; i++) list.push([i, AH + i * AG]);
    var vis = this.agVis && this.agVis.length === N && delta ? this.agVis : new Uint8Array(N);
    if (this.agVis && delta && this.agVis.length !== N) { vis.set(this.agVis.subarray(0, Math.min(N, this.agVis.length))); }
    this.agVis = vis;
    for (var li = 0; li < list.length; li++) {
      i = list[li][0]; o = list[li][1];
      var a = ag[i];
      if (!a) a = ag[i] = { id: i, x: 0, y: 0, hp: 100, hpMax: 100, alive: true, aim: 0, legs: 0, mv: 0, phase: (i * 2.39) % 6.28, fig: 0, job: null,
                            role: 'post', team: 0, face: null, sprayAt: -1, fixAt: -1, breach: -1, tgt: -1, home: 0, goalRoom: 0 };
      var fl = v.getUint8(o + 6);
      a.team = fl & 128 ? 1 : 0;
      if (fl & 16) {
        // не видно абордажной команде: не рисовать, места не знаем
        a.gone = true; a.alive = true; a.nx = null; a.job = null; a.sprayAt = -1; a.fixAt = -1; vis[i] = 0;
        continue;
      }
      vis[i] = 1;
      var x = v.getUint16(o, true) / 64, y = v.getUint16(o + 2, true) / 64, jb = v.getUint8(o + 7);
      var wasAlive = a.alive && !a.gone;
      a.alive = !!(fl & 1); a.at = !!(fl & 2); a.carry = !!(fl & 4); a.gone = !!(fl & 8);
      // первый кадр, телепорт (шаттл, смерть) — сразу на место; иначе — сглаживание
      if (a.nx == null || !wasAlive || !a.alive || Math.abs(x - a.nx) + Math.abs(y - a.ny) > 6) { a.x = x; a.y = y; a.px = x; a.py = y; }
      else { a.px = a.x; a.py = a.y; }
      a.nx = x; a.ny = y; a.nat = now;
      a.aimT = v.getUint8(o + 4) / 256 * 6.2832;
      if (a.aim == null || !wasAlive) a.aim = a.aimT;
      a.hp = v.getUint8(o + 5) / 255 * 100; a.hpMax = 100;
      a.breach = fl & 32 ? 1 : -1;
      a.face = fl & 64 ? a.aimT : null;
      var jk = JOBS[jb & 15]; a.role = ROLES[jb >> 4] || 'post';
      var wv = v.getUint8(o + 9);
      a.wpn = WPNS[wv & 15] || undefined;
      var sqv = v.getUint8(o + 15); if (a.team === sh.side) { a.dsq = sqv; a.sq = 0; } else { a.sq = sqv; a.dsq = 0; }
      a.fig = v.getUint8(o + 8);
      var dx = v.getInt8(o + 10), dy = v.getInt8(o + 11), where = v.getUint16(o + 12, true), f2 = v.getUint8(o + 14);
      a.home = where; a.goalRoom = where;
      a.tgt = f2 & 1 ? 1 : -1; a.guard = f2 & 2 ? 1 : 0; a.task = f2 & 4 ? 'post' : null; a.eng = !!(f2 & 8); a.inCov = !!(f2 & 16); a.held = !!(f2 & 32);
      // точку снял сервер (бой кончился, новый приказ отряду) — снять и на экране; свежий приказ ещё в пути — не трогать
      if (!(f2 & 32) && a.post && !(a.postAt > now - LOCK)) a.post = null;
      a.sprayAt = -1; a.fixAt = -1;
      if (jk) {
        a.job = { kind: jk, room: where };
        var cell = (Math.floor(y) + dy) * W + Math.floor(x) + dx;
        if (jk === 'fire') a.sprayAt = cell; else if (jk === 'fix' || (jk === 'weld' && dx | dy)) a.fixAt = cell;
        else if (jk === 'heal') a.job.who = this.nearAgent(ag, x + dx, y + dy, i);
      } else a.job = null;
    }
    this.applyWho(sh);
    // кто в каком отряде — по всем людям (в разностном кадре пришли не все)
    if (bd) {
      bd.vis = vis;
      var sqm = {};
      var dqm = {};
      for (i = 0; i < ag.length; i++) {
        if (ag[i] && ag[i].sq) (sqm[ag[i].sq] = sqm[ag[i].sq] || []).push(i);
        if (ag[i] && ag[i].dsq) (dqm[ag[i].dsq] = dqm[ag[i].dsq] || []).push(i);
      }
      if (bd.squads) bd.squads.forEach(function(q) { q.members = sqm[q.id] || []; });
      if (bd.dsq) bd.dsq.forEach(function(q) { q.members = dqm[q.id] || []; });
    }
  };
  Mirror.prototype.applyWho = function(sh) {
    var wm = this.whoMap[sh.n]; if (!wm) return;
    var ag = sh.crew.agents;
    for (var k in wm) { var a = ag[k]; if (a) { a.utype = wm[k][1]; a.uname = wm[k][2]; a.hero = !!wm[k][3]; } }
  };
  Mirror.prototype.nearAgent = function(ag, x, y, self) {
    var best = -1, bd = 4;
    for (var i = 0; i < ag.length; i++) { if (i === self || !ag[i] || ag[i].nx == null) continue; var dx = ag[i].nx - x, dy = ag[i].ny - y, d = dx * dx + dy * dy; if (d < bd) { bd = d; best = i; } }
    return best;
  };
  Mirror.prototype.fire = function(v) {
    var n = v.getUint16(2, true), N = v.getUint32(4, true), sh = this.B.ships[n]; if (!sh) return;
    var c = sh.crew, i;
    for (i = 0; i < c.burning.length; i++) c.fire[c.burning[i]] = 0;
    c.burning = [];
    for (i = 0; i < N; i++) { var cell = v.getUint32(8 + i * 5, true); c.burning.push(cell); c.fire[cell] = v.getUint8(12 + i * 5); }
  };
  // Каждый кадр отрисовки: сгладить движение, выставить время
  Mirror.prototype.update = function() {
    var B = this.B, now = Date.now(), s = this.snap; if (!s.length) return false;
    var last = s[s.length - 1];
    // время боя идёт со скоростью сервера (пауза — стоит); своё время отстаёт на lag, плавно
    var spd = last.spd == null ? 1 : last.spd, nowR = clock() / 1000, dt = this.prevR ? Math.min(0.25, Math.max(0, nowR - this.prevR)) : 0;
    this.prevR = nowR;
    var target = this.base != null && spd > 0 ? nowR * spd - this.base - this.lag * spd : last.T;
    if (this.rt == null) this.rt = target;
    this.rt += dt * spd;
    if (Math.abs(this.rt - target) > 0.5 * Math.max(1, spd)) this.rt = target; else this.rt += (target - this.rt) * 0.08;
    if (this.rt > last.T + 0.05 * spd) this.rt = last.T + 0.05 * spd;          // не забегать за последний кадр
    B.t = this.rt; B.acc = 0;
    var k, i;
    for (i = 0; i < B.ships.length; i++) {
      var sh = B.ships[i], n = sh.net; if (!n || !n.ks) continue;
      var p = keyAt(n.ks, B.t);
      sh.x = p.x; sh.y = p.y; sh.hd = p.hd;
      B.place(sh);
      // время экипажа — от его отметки по тому же отстающему времени боя, назад не идёт (вспышки внутри не скачут)
      if (sh.netCt != null) { var ctt = sh.netCt + (sh.netCtT != null ? B.t - sh.netCtT : Math.min(0.5, (now - (sh.netCtAt || last.at)) / 1000) * spd - DELAY * spd); if (sh.crew.t != null && ctt < sh.crew.t && sh.crew.t - ctt < 0.5) ctt = sh.crew.t; sh.crew.t = ctt; }
      // люди корабля, на который смотрим
      if (sh.netView) {
        var ag = sh.crew.agents;
        for (var j = 0; j < ag.length; j++) {
          var m = ag[j]; if (!m || m.nx == null) continue;
          var kk = Math.min(1, (now - m.nat) / 250);
          var ox = m.x, oy = m.y;
          m.x = m.px + (m.nx - m.px) * kk; m.y = m.py + (m.ny - m.py) * kk;
          var sp = Math.sqrt((m.x - ox) * (m.x - ox) + (m.y - oy) * (m.y - oy));
          m.mv += ((sp > 0.004 ? 1 : 0) - m.mv) * 0.2;
          if (sp > 0.004) m.legs = Math.atan2(m.y - oy, m.x - ox);
          var da = (m.aimT || 0) - m.aim; while (da > Math.PI) da -= 6.2832; while (da < -Math.PI) da += 6.2832;
          m.aim += da * 0.3;
          m.phase = (m.phase + (m.mv > 0.3 ? 0.17 : 0.05)) % 6.2832;
        }
      }
    }
    // малые корабли: список целиком из последнего кадра, положение — сглаженно
    if (this.craftNext) {
      var list = this.craftNext, old = {}, out = [];
      for (i = 0; i < B.craft.length; i++) old[B.craft[i].id] = B.craft[i];
      for (i = 0; i < list.length; i++) {
        var q = list[i], c = old[q[0]], meta = this.craftMeta[q[0]];
        if (q.length === 1) { if (c) { if (c.ks) keyPush(c.ks, c.ks[c.ks.length - 1].x, c.ks[c.ks.length - 1].y, c.ks[c.ks.length - 1].hd, this.craftT, STEPR * (spd || 1)); out.push(c); } continue; }   // стоит — как был
        if (q.length > 5) meta = this.craftMeta[q[0]] = { type: q[5], side: q[6], role: q[7], faction: q[8], img: q[9] || null, len: q[10], max: q[11], tgt: q[12] >= 0 ? q[12] : null };
        if (!meta) continue;                               // кадр с описанием потерялся — до полного обновления не рисуем
        if (!c) c = { id: q[0], x: q[1], y: q[2], hd: q[3] };
        c.type = meta.type; c.side = meta.side; c.role = meta.role; c.faction = meta.faction; c.img = meta.img; c.len = meta.len; c.max = meta.max; c.tgt = meta.tgt;
        c.hp = q[4]; c.dead = false;
        if (!c.ks) c.ks = [{ x: q[1], y: q[2], hd: q[3], T: this.craftT }]; else keyPush(c.ks, q[1], q[2], q[3], this.craftT, STEPR * (spd || 1));
        out.push(c);
      }
      B.craft = out; this.craftNext = null;
    }
    // малые корабли — так же, по положениям во времени сервера (без «подтягивания» рывками 5 раз в секунду)
    for (i = 0; i < B.craft.length; i++) {
      var cr = B.craft[i]; if (!cr.ks) continue;
      var cp = keyAt(cr.ks, B.t); cr.x = cp.x; cr.y = cp.y; cr.hd = cp.hd;
    }
    return true;
  };

  return { Viewer: Viewer, Mirror: Mirror, eachMany: eachMany, BIN: BIN, PV: PV, DELAY: DELAY, SCEN: SCEN, SHIPS: SHIPS, SHIP_BY: SHIP_BY, cfgClean: cfgClean, layout: layout, cfgName: cfgName };
});
