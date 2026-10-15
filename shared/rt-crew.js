// Экипаж корабля 2.0: живые люди (дроиды) внутри отсеков.
//
// Каждый — отдельное тело радиусом 0,3 клетки (0,6 м):
//  - не проходит сквозь переборки, технику и мебель (круг против клеток);
//  - не проходит сквозь других (раздвигаются, в проходах держатся правой стороны);
//  - ходит по полям направлений: дальний путь — к отсеку, ближний — внутри отсека.
//
// Задачи (ИИ без хозяина):
//  - мир: несут вахту, ходят в соседние отсеки и обратно;
//  - тревога: все бегут на боевые посты;
//  - пожар: ближайшие ремонтники и резерв тушат; если своих нет — тушит расчёт отсека;
//  - поломка: ремонтники и инженеры чинят отсек, когда огня нет;
//  - погиб расчётчик орудия, реактора, мостика — его место занимает резерв.
//
// Огонь — по клеткам отсеков: разгорается, перекидывается на соседние клетки,
// жжёт людей и портит отсек. Состояние отсека (целость, оглушение ионным
// ударом, кто на посту) даёт эффективность систем для космического боя.
//
// ES5, без зависимостей. Работает в браузере и в Node (сервер боёв).

(function(root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SWCrew = api;
})(typeof self !== 'undefined' ? self : this, function() {
  'use strict';

  var K = { VOID: 0, TECH: 1, HULL: 2, WALL: 3, FLOOR: 4, DOOR: 5 };
  var DX = [1, 1, 0, -1, -1, -1, 0, 1], DY = [0, 1, 1, 1, 0, -1, -1, -1], DC = [10, 14, 10, 14, 10, 14, 10, 14];
  var STEP = 0.05;                 // шаг расчёта, с (20 в секунду)
  var R = 0.3;                     // радиус тела, клетки
  var WALK = 1.25, RUN = 3;        // клеток в секунду (2,5 и 6 м/с)
  var MUSTER_RUN = 4.5;            // десант бегом к шлюзу на посадку (9 м/с, по тревоге, налегке)

  // Сколько людей на посту каждого типа отсека
  var STUN_IMM = 6;          // секунд «перезапуска» после ионного сбоя: новый сбой не берётся
  var POST = { bridge: 6, flight: 5, cic: 5, gun: 3, pdgun: 2, reactor: 3, shield: 2, engine: 4, hyper: 2, hangar: 6,
               quarters: 3, troops: 6, mess: 4, medbay: 3, armory: 2, storage: 1, hold: 1, workshop: 3, airlock: 1,
               dock: 2, comms: 3, observe: 2, vehicle: 3, droids: 2, power: 2, pumps: 2 };
  // Посты, которые держат системы корабля (их заполняют из резерва)
  var KEY = { gun: 1, pdgun: 1, reactor: 1, shield: 1, engine: 1, bridge: 1, cic: 1, flight: 1, hyper: 1 };
  // Кто в резерве: могут тушить, чинить и заменять погибших
  var RESERVE = { quarters: 1, troops: 1, mess: 1, storage: 1, hold: 1, armory: 1, droids: 1, vehicle: 1, observe: 1, dock: 1, airlock: 1 };
  // Ремонтники по должности
  var FIXER = { workshop: 1, reactor: 1, engine: 1, hyper: 1, shield: 1, power: 1, pumps: 1 };
  // Откуда носят боеприпасы к орудиям
  var STORE = { storage: 1, armory: 1, hold: 1 };
  // Кто служит в отсеке: мостик — офицеры, машины — инженеры, лазарет — медики,
  // казармы — десант, орудия и прочие посты — расчёты
  var GROUP = { bridge: 'bridge', cic: 'bridge', flight: 'bridge', comms: 'bridge', observe: 'bridge',
                reactor: 'eng', engine: 'eng', workshop: 'eng', power: 'eng', pumps: 'eng', medbay: 'medic',
                troops: 'troops', droids: 'troops', vehicle: 'troops', armory: 'troops',
                quarters: 'crew', mess: 'crew', storage: 'crew', hold: 'crew' };
  function roleOf(t) { return KEY[t] ? 'post' : FIXER[t] ? 'fixer' : t === 'medbay' ? 'medic' : 'reserve'; }

  function rng(seed) {
    var s = (seed >>> 0) || 1;
    return function() { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  }

  // ---------------------------------------------------------------- поля направлений
  // Алгоритм Диала по проходимым клеткам в рамке [x0,y0,w,h] карты корабля.
  // Диагональ — только если оба боковых свободны (никто не срезает угол).
  function Flows(crew) {
    this.c = crew; this.m = new Map(); this.max = 40; this.built = 0;
    this.local = new Map(); this.lmax = 160;
  }
  // Рабочие массивы поиска — одни на все корабли (берутся по самому большому)
  var SCR = { n: 0, dist: null, q: null, head: new Int32Array(16), tail: new Int32Array(16) };
  function scratch(n) {
    if (SCR.n < n) { SCR.n = n; SCR.dist = new Uint16Array(n); SCR.q = new Int32Array(16 * n); }
    return SCR;
  }
  Flows.prototype.build = function(tx, ty, bx, by, bw, bh) {
    var c = this.c, W = c.w, walk = c.walk, n = bw * bh;
    var S = scratch(n), dir = new Uint8Array(n), dist = S.dist, q = S.q, head = S.head, tail = S.tail, B = 15;
    dir.fill(255);
    if (tx < bx || ty < by || tx >= bx + bw || ty >= by + bh || !walk[ty * W + tx]) return { dir: dir, bx: bx, by: by, bw: bw, bh: bh, tx: tx, ty: ty };
    for (var i = 0; i < n; i++) dist[i] = 65535;
    head.fill(0); tail.fill(0);
    var start = (ty - by) * bw + (tx - bx);
    dist[start] = 0; dir[start] = 254; q[0] = start; tail[0] = 1;
    var cur = 0, left = 1;
    while (left > 0) {
      var b = cur % B;
      if (head[b] === tail[b]) { cur++; continue; }
      var cc = q[b * n + (head[b] % n)]; head[b]++; left--;
      if (dist[cc] !== cur) continue;
      var lx = cc % bw, ly = (cc - lx) / bw;
      for (var d = 0; d < 8; d++) {
        var nx = lx + DX[d], ny = ly + DY[d];
        if (nx < 0 || ny < 0 || nx >= bw || ny >= bh) continue;
        if (!walk[(ny + by) * W + nx + bx]) continue;
        if (d & 1) {
          if (!walk[(ly + by) * W + nx + bx] || !walk[(ny + by) * W + lx + bx]) continue;
        }
        var nc = ny * bw + nx, nd = cur + DC[d];
        if (nd < dist[nc]) {
          dist[nc] = nd; dir[nc] = (d + 4) & 7;
          var nb = nd % B; q[nb * n + (tail[nb] % n)] = nc; tail[nb]++; left++;
        }
      }
    }
    this.built++;
    return { dir: dir, bx: bx, by: by, bw: bw, bh: bh, tx: tx, ty: ty };
  };
  // Весь корабль → к точке (обычно к «входу» отсека)
  Flows.prototype.global = function(tx, ty) {
    var key = ty * this.c.w + tx, f = this.m.get(key);
    if (f) { this.m.delete(key); this.m.set(key, f); return f; }
    if (this.c.budget <= 0) return null;
    this.c.budget--; this.c.flowT = 0.15;
    f = this.build(tx, ty, 0, 0, this.c.w, this.c.h);
    this.m.set(key, f);
    if (this.m.size > this.max) this.m.delete(this.m.keys().next().value);
    return f;
  };
  // Внутри отсека (рамка отсека плюс кайма) → к своей клетке
  Flows.prototype.inRoom = function(room, tx, ty) {
    var key = room.n * 1048576 + ty * this.c.w + tx, f = this.local.get(key);
    if (f) { this.local.delete(key); this.local.set(key, f); return f; }
    var c = this.c, bx = Math.max(0, room.x - 2), by = Math.max(0, room.y - 2);
    var bw = Math.min(c.w, room.x + room.w + 2) - bx, bh = Math.min(c.h, room.y + room.h + 2) - by;
    f = this.build(tx, ty, bx, by, bw, bh);
    this.local.set(key, f);
    if (this.local.size > this.lmax) this.local.delete(this.local.keys().next().value);
    return f;
  };
  function flowDir(f, x, y) {
    var lx = x - f.bx, ly = y - f.by;
    if (lx < 0 || ly < 0 || lx >= f.bw || ly >= f.bh) return 255;
    return f.dir[ly * f.bw + lx];
  }

  // ---------------------------------------------------------------- экипаж
  function Crew(ship, opts) {
    opts = opts || {};
    this.ship = ship; this.w = ship.w; this.h = ship.h;
    this.team = opts.team || 0;         // сторона корабля (для абордажа: свои и чужие на борту)
    this.board = null;                  // идёт абордаж — объект SWBoard.Board
    this.R = rng(opts.seed || (ship.w * 7919 + ship.h));
    var n = ship.w * ship.h, i;
    // проходимо: пол и двери без предметов
    this.walk = new Uint8Array(n);
    for (i = 0; i < n; i++) {
      var k = ship.kind[i];
      this.walk[i] = (k === K.FLOOR || k === K.DOOR) && !ship.prop[i] ? 1 : 0;
    }
    this.mainOnly();
    this.fire = new Float32Array(n);    // сила огня в клетке 0..100
    this.inList = new Uint8Array(n);    // клетка уже в списке горящих
    this.burning = [];                  // номера горящих клеток
    this.flows = new Flows(this);
    this.budget = 2;
    this.alertOn = !!opts.alert;
    this.t = 0; this.acc = 0; this.think = 0; this.fireT = 0; this.flowT = 0;
    this.ev = { deaths: [], ignites: [], blasts: [], guns: [] };
    this.claim = new Int32Array(n);     // клетка занята как место работы: id + 1
    this.scorch = [];                   // следы взрывов
    // отсеки: состояние
    this.rooms = {};
    this.roomList = [];
    for (i = 0; i < ship.rooms.length; i++) {
      var r = ship.rooms[i];
      // людей по размеру отсека: большой зал — больше рук (до трёх норм поста)
      var base = POST[r.t] || 1, need = Math.min(base * 3, base + Math.floor((r.area || r.w * r.h) / 140));
      var st = { n: r.n, t: r.t, r: r, integ: 100, stun: 0, need: need, fires: 0, anchor: null,
                 staffed: 0, assigned: 0, fixers: 0, fighters: 0, firedAt: -99, runner: 0, spots: null };
      st.anchor = this.anchorOf(r);
      st.spots = this.workSpots(r);
      this.rooms[r.n] = st; this.roomList.push(st);
    }
    // люди
    this.agents = [];
    var figs = opts.figs || [0], fmap = opts.figMap || null;
    var self = this;
    // roster — бойцы трюма поимённо (бой 2.0): казармы без «своих» солдат, только купленные;
    // без roster (просмотр кораблей) — казармы заполнены, как раньше
    var roster = opts.roster || null;
    var figOf = function(t) {
      var list = fmap && (fmap[GROUP[t] || 'post'] || fmap.post);
      if (!list || !list.length) list = figs;
      return list[Math.floor(self.R() * list.length)];
    };
    for (i = 0; i < this.roomList.length; i++) {
      var rs = this.roomList[i];
      if (!rs.anchor) continue;
      if (roster && (rs.t === 'troops' || rs.t === 'droids')) continue;
      for (var j = 0; j < rs.need; j++) {
        var id = this.agents.length, p = this.workSpot(rs, id) || this.spotIn(rs.r);
        if (!p) break;
        var ag = {
          id: id, x: p[0] + 0.5, y: p[1] + 0.5, vx: 0, vy: 0, hp: 100, hpMax: 100, alive: true, team: this.team,
          home: rs.n, spot: p, role: roleOf(rs.t), grp: roster && GROUP[rs.t] === 'troops' ? 'crew' : GROUP[rs.t] || 'post',
          task: 'post', goalRoom: rs.n, goal: p, at: true, wait: this.R() * 4, stuck: 0, lastD: 1e9, wig: 0,
          job: null, fig: figOf(rs.t), aim: p[2] != null ? p[2] : this.R() * Math.PI * 2, legs: 0, mv: 0, phase: this.R() * 6.28,
          face: p[2] != null ? p[2] : null, sprayAt: -1, fixAt: -1, carry: false, medic: -1, hold: 0, busyT: 3 + this.R() * 8, claimed: -1
        };
        this.agents.push(ag);
        this.claimCell(ag, p);
        rs.assigned++;
      }
    }
    // десант в трюме: число бойцов задаёт корабль (старая игра: пехота в трюме), а не
    // только размер казарм — недостающих ставим в казармы, стеллажи дроидов и арсенал
    if (opts.troops) {
      var bar = this.roomList.filter(function(q) { return GROUP[q.t] === 'troops' && q.anchor; }), have = 0;
      for (i = 0; i < this.agents.length; i++) if (this.agents[i].grp === 'troops') have++;
      for (var k2 = 0; have < opts.troops && bar.length && k2 < opts.troops * 3; k2++) {
        var bq = bar[k2 % bar.length], pp = this.spotIn(bq.r); if (!pp) continue;
        this.agents.push({
          id: this.agents.length, x: pp[0] + 0.5, y: pp[1] + 0.5, vx: 0, vy: 0, hp: 100, hpMax: 100, alive: true, team: this.team,
          home: bq.n, spot: pp, role: 'reserve', grp: 'troops', task: 'post', goalRoom: bq.n, goal: pp, at: true, wait: this.R() * 4,
          stuck: 0, lastD: 1e9, wig: 0, job: null, fig: figOf(bq.t), aim: this.R() * Math.PI * 2, legs: 0, mv: 0, phase: this.R() * 6.28,
          face: null, sprayAt: -1, fixAt: -1, carry: false, medic: -1, hold: 0, busyT: 3 + this.R() * 8, claimed: -1
        });
        bq.assigned++; have++;
      }
    }
    // экипажа недостаёт (погибшие в прошлых боях, не пополнены на верфи): их нет на борту
    if (opts.crewLost > 0) {
      var pool = this.agents.filter(function(a) { return a.grp !== 'troops'; });
      for (var cl = 0; cl < opts.crewLost && pool.length; cl++) {
        var gone = pool.splice(Math.floor(this.R() * pool.length), 1)[0];
        gone.alive = false; gone.gone = true; gone.absent = true;
        var gs = this.rooms[gone.home]; if (gs) gs.assigned--;
        this.claimCell(gone, null);
      }
      this.crewLost = opts.crewLost;
    }
    // десант трюма поимённо: в казармы и стеллажи дроидов (нет их — арсенал, техника, кубрики)
    if (roster) {
      var bays = this.roomList.filter(function(q) { return (q.t === 'troops' || q.t === 'droids') && q.anchor; });
      if (!bays.length) bays = this.roomList.filter(function(q) { return (q.t === 'armory' || q.t === 'vehicle') && q.anchor; });
      var ids = opts.figIds || null, kitOf = opts.kit || null;
      for (var ri = 0; ri < roster.length && bays.length; ri++) {
        var u = roster[ri], kt = kitOf ? kitOf(u.type) : null, bay = bays[ri % bays.length], sp = this.spotIn(bay.r);
        if (!sp || !kt) continue;
        var fi = ids ? ids.indexOf(kt.fig) : -1;
        this.agents.push({
          id: this.agents.length, x: sp[0] + 0.5, y: sp[1] + 0.5, vx: 0, vy: 0, hp: u.hp, hpMax: u.hpMax, alive: true, team: this.team,
          home: bay.n, spot: sp, role: 'reserve', grp: 'troops', task: 'post', goalRoom: bay.n, goal: sp, at: true, wait: this.R() * 4,
          stuck: 0, lastD: 1e9, wig: 0, job: null, fig: fi >= 0 ? fi : figOf(bay.t), aim: this.R() * Math.PI * 2, legs: 0, mv: 0, phase: this.R() * 6.28,
          face: null, sprayAt: -1, fixAt: -1, carry: false, medic: -1, hold: 0, busyT: 3 + this.R() * 8, claimed: -1,
          // кто это в игре: тип бойца, имя героя, строка базы; оружие и урон — по типу
          utype: u.type, uname: u.name || '', uid: u.uid || '', wpn: kt.wpn, dmgK: kt.dmgK * (u.dmgX || 1), eng: kt.eng, medicU: kt.medic, hero: kt.hero
        });
        bay.assigned++;
      }
    }
    // штатная охрана (из экипажа, не покупается): в арсенал и казармы, нет их — в кубрики;
    // на абордаж не ходит, пожары и ремонт не её дело — обороняет корабль
    if (opts.guards && opts.guards.n > 0) {
      var gk = opts.guards.kit, gIds = opts.figIds || null, gFig = gk && gIds ? gIds.indexOf(gk.fig) : -1;
      var posts = this.roomList.filter(function(q) { return (q.t === 'armory' || q.t === 'troops' || q.t === 'droids') && q.anchor; });
      if (!posts.length) posts = this.roomList.filter(function(q) { return GROUP[q.t] === 'crew' && q.anchor; });
      for (var gi = 0; gi < opts.guards.n && posts.length; gi++) {
        var gp = posts[gi % posts.length], gsp = this.spotIn(gp.r); if (!gsp) continue;
        this.agents.push({
          id: this.agents.length, x: gsp[0] + 0.5, y: gsp[1] + 0.5, vx: 0, vy: 0, hp: opts.guards.hp || 100, hpMax: opts.guards.hp || 100, alive: true, team: this.team,
          home: gp.n, spot: gsp, role: 'guard', grp: 'troops', task: 'post', goalRoom: gp.n, goal: gsp, at: true, wait: this.R() * 4,
          stuck: 0, lastD: 1e9, wig: 0, job: null, fig: gFig >= 0 ? gFig : figOf(gp.t), aim: this.R() * Math.PI * 2, legs: 0, mv: 0, phase: this.R() * 6.28,
          face: null, sprayAt: -1, fixAt: -1, carry: false, medic: -1, hold: 0, busyT: 3 + this.R() * 8, claimed: -1,
          wpn: gk ? gk.wpn : null, dmgK: gk ? gk.dmgK : 1, guardU: true
        });
        gp.assigned++;
      }
    }
    // сетка соседства
    this.cellHead = new Int32Array(n).fill(-1);
    this.nextIn = new Int32Array(Math.max(1, this.agents.length));
    this.used = [];
  }

  // Пятачки пола, отрезанные мебелью от остального корабля, — не для людей
  Crew.prototype.mainOnly = function() {
    var W = this.w, n = W * this.h, walk = this.walk, lab = new Int32Array(n), best = 0, bestN = 0, k = 0, st = [];
    for (var i = 0; i < n; i++) {
      if (!walk[i] || lab[i]) continue;
      k++; lab[i] = k; st.push(i); var sz = 0;
      while (st.length) {
        var p = st.pop(); sz++;
        var x = p % W;
        if (x > 0 && walk[p - 1] && !lab[p - 1]) { lab[p - 1] = k; st.push(p - 1); }
        if (x < W - 1 && walk[p + 1] && !lab[p + 1]) { lab[p + 1] = k; st.push(p + 1); }
        if (p >= W && walk[p - W] && !lab[p - W]) { lab[p - W] = k; st.push(p - W); }
        if (p + W < n && walk[p + W] && !lab[p + W]) { lab[p + W] = k; st.push(p + W); }
      }
      if (sz > bestN) { bestN = sz; best = k; }
    }
    for (i = 0; i < n; i++) if (walk[i] && lab[i] !== best) walk[i] = 0;
  };
  // Места работы: пол рядом с пультом или машиной отсека, лицом к ним
  Crew.prototype.workSpots = function(r) {
    var sh = this.ship, W = this.w, out = [];
    for (var y = r.y + 1; y < r.y + r.h - 1; y++) for (var x = r.x + 1; x < r.x + r.w - 1; x++) {
      var i = y * W + x;
      if (!this.walk[i] || sh.room[i] !== r.n) continue;
      for (var d = 0; d < 8; d += 2) {
        var k = (y + DY[d]) * W + x + DX[d];
        if (sh.prop[k] && sh.room[k] === r.n) { out.push([x, y, Math.atan2(DY[d], DX[d]), k]); break; }
      }
    }
    return out;
  };
  // Свободное место работы в отсеке (не занятое другим)
  Crew.prototype.workSpot = function(st, id) {
    var sp = st.spots;
    if (!sp || !sp.length) return null;
    for (var t = 0; t < 14; t++) {
      var q = sp[Math.floor(this.R() * sp.length)], c = q[1] * this.w + q[0];
      if (this.fire[c]) continue;
      if (this.claim[c] && this.claim[c] !== id + 1) continue;
      return q;
    }
    return null;
  };
  Crew.prototype.claimCell = function(a, p) {
    if (a.claimed >= 0 && this.claim[a.claimed] === a.id + 1) this.claim[a.claimed] = 0;
    a.claimed = -1;
    if (!p) return;
    var c = p[1] * this.w + p[0];
    if (!this.claim[c]) { this.claim[c] = a.id + 1; a.claimed = c; }
  };
  // «Вход» отсека — свободная клетка ближе к середине
  Crew.prototype.anchorOf = function(r) {
    var cx = Math.floor(r.x + r.w / 2), cy = Math.floor(r.y + r.h / 2), best = null, bd = 1e9;
    for (var y = r.y; y < r.y + r.h; y++) for (var x = r.x; x < r.x + r.w; x++) {
      var i = y * this.w + x;
      if (!this.walk[i] || this.ship.room[i] !== r.n) continue;
      var d = (x - cx) * (x - cx) + (y - cy) * (y - cy);
      if (d < bd) { bd = d; best = [x, y]; }
    }
    return best;
  };
  Crew.prototype.spotIn = function(r) {
    var sh = this.ship;
    for (var t = 0; t < 60; t++) {
      var x = r.x + 1 + Math.floor(this.R() * Math.max(1, r.w - 2)), y = r.y + 1 + Math.floor(this.R() * Math.max(1, r.h - 2));
      var i = y * this.w + x;
      if (this.walk[i] && sh.room[i] === r.n && !this.fire[i]) return [x, y];
    }
    var st = this.rooms[r.n];
    return st && st.anchor ? [st.anchor[0], st.anchor[1]] : null;
  };

  // ---------------------------------------------------------------- внешние воздействия
  Crew.prototype.alert = function(on) {
    this.alertOn = !!on;
    for (var i = 0; i < this.agents.length; i++) {
      var a = this.agents[i];
      if (!a.alive || a.job) continue;
      this.sendPost(a);
      a.wait = on ? this.R() * 1.2 : this.R() * 3;
    }
  };
  // Попадание в клетку: пожар
  Crew.prototype.ignite = function(x, y, power) {
    x = Math.floor(x); y = Math.floor(y);
    var sh = this.ship, best = -1, bd = 1e9;
    // тяжёлые машины (турели, ядро реактора) бронированы — горит вокруг них
    for (var dy = -8; dy <= 8; dy++) for (var dx = -8; dx <= 8; dx++) {
      var gx = x + dx, gy = y + dy;
      if (gx < 0 || gy < 0 || gx >= this.w || gy >= this.h) continue;
      var i = gy * this.w + gx;
      if (!this.burnable(i)) continue;
      var d = dx * dx + dy * dy; if (d < bd) { bd = d; best = i; }
    }
    if (best < 0) return false;
    if (!this.inList[best]) { this.inList[best] = 1; this.burning.push(best); }
    this.fire[best] = Math.min(100, Math.max(this.fire[best], power || 40));
    this.ev.ignites.push(best);
    return true;
  };
  Crew.prototype.burnable = function(i) {
    var sh = this.ship, k = sh.kind[i];
    return !!sh.room[i] && (k === K.FLOOR || k === K.DOOR) && sh.prop[i] !== 2;
  };
  // Взрыв в клетке: ранит и убивает рядом
  Crew.prototype.blast = function(x, y, rad, dmg) {
    var r2 = rad * rad;
    this.ev.blasts.push({ x: x, y: y, r: rad, t: this.t });
    // копоть остаётся на полу
    this.scorch.push({ x: x, y: y, r: rad * 1.3, a: (x * 7.13 + y) % 6.28 });
    if (this.scorch.length > 200) this.scorch.splice(0, 50);
    for (var i = 0; i < this.agents.length; i++) {
      var a = this.agents[i];
      if (!a.alive) continue;
      var dx = a.x - x, dy = a.y - y, d = dx * dx + dy * dy;
      if (d <= r2) this.hurt(a, dmg * (1 - Math.sqrt(d) / (rad + 0.01) * 0.5));
    }
  };
  // Орудие этого поста выстрелило: вспышка в отсеке, подносчикам — работа
  Crew.prototype.gunFired = function(n) {
    var st = this.rooms[n]; if (!st) return;
    st.firedAt = this.t;
    this.ev.guns.push({ n: n, t: this.t });
  };
  Crew.prototype.damageRoom = function(n, amount, stun) {
    var st = this.rooms[n]; if (!st) return;
    st.integ = Math.max(0, st.integ - amount);
    // ионный сбой: после него системы несколько секунд перезапускаются и новый сбой не берут —
    // иначе непрерывный ионный огонь держал бы отсек (и реактор) выключенным весь бой
    if (stun && !(st.stunImm > 0)) st.stun = Math.max(st.stun, stun);
  };
  Crew.prototype.hurt = function(a, d) {
    a.hp -= d;
    if (a.hp <= 0 && a.alive) {
      a.alive = false; a.hp = 0; a.diedAt = this.t; this.ev.deaths.push(a.id);
      this.releaseJob(a); this.claimCell(a, null);
      if (a.medic >= 0) { var m = this.agents[a.medic]; if (m && m.job && m.job.kind === 'heal') { this.releaseJob(m); this.sendPost(m); } }
      var st = this.rooms[a.home]; if (st) st.assigned--;
    }
  };

  // ---------------------------------------------------------------- эффективность
  // Отсек: целость × люди на посту. Без людей пост орудия молчит.
  Crew.prototype.roomEff = function(n) {
    var st = this.rooms[n]; if (!st) return 0;
    if (st.integ < 12) return 0;
    if (this.board && this.board.heldBy(n) !== this.team) return 0;   // отсек держит абордажная команда
    // реактор в сбое — на аварийном питании (не ноль, но не лучше работающего)
    if (st.stun > 0) return st.t === 'reactor' ? 0.4 * st.integ / 100 * Math.min(1, st.staffed / st.need) : 0;
    var people = Math.min(1, st.staffed / st.need);
    var fire = st.fires ? Math.max(st.t === 'reactor' ? 0.6 : 0.35, 1 - st.fires / (st.t === 'reactor' ? 120 : 40)) : 1;   // реактор — большой зал: пожар в углу не глушит его
    if (KEY[st.t] && st.t !== 'reactor' && st.t !== 'engine' && st.t !== 'shield' && st.t !== 'hyper') return st.integ / 100 * people * fire;
    return st.integ / 100 * (0.3 + 0.7 * people) * fire;
  };
  // Система по типу отсеков (среднее), например 'engine', 'reactor'
  Crew.prototype.sysEff = function(t) {
    var s = 0, n = 0;
    for (var i = 0; i < this.roomList.length; i++) if (this.roomList[i].t === t) { s += this.roomEff(this.roomList[i].n); n++; }
    return n ? s / n : 1;
  };
  // Живые свои (абордажники противника на борту — не экипаж)
  Crew.prototype.alive = function() { var n = 0; for (var i = 0; i < this.agents.length; i++) if (this.agents[i].alive && this.agents[i].team === this.team) n++; return n; };

  // ---------------------------------------------------------------- задачи
  Crew.prototype.sendPost = function(a) {
    var st = this.rooms[a.home];
    if (!st) return;
    if (!a.spot || this.fire[a.spot[1] * this.w + a.spot[0]] > 0 || this.ship.room[a.spot[1] * this.w + a.spot[0]] !== st.n)
      a.spot = this.workSpot(st, a.id) || this.spotIn(st.r) || a.spot;
    a.face = a.spot && a.spot[2] != null ? a.spot[2] : null;
    this.go(a, st.n, a.spot, 'post');
  };
  Crew.prototype.go = function(a, roomN, cell, task) {
    a.goalRoom = roomN; a.goal = cell; a.task = task; a.at = false; a.stuck = 0; a.lastD = 1e9; a.wig = 0;
    a.sprayAt = -1; a.fixAt = -1;
    this.claimCell(a, cell);
  };
  Crew.prototype.releaseJob = function(a) {
    if (!a.job) return;
    var j = a.job, st = this.rooms[j.room];
    if (j.kind === 'fire') { if (st) st.fighters--; }
    else if (j.kind === 'fix') { if (st) st.fixers--; }
    else if (j.kind === 'carry' || j.kind === 'back') { if (st && j.kind === 'carry') st.runner--; a.carry = false; }
    else if (j.kind === 'heal') { var pt = this.agents[j.who]; if (pt && pt.medic === a.id) pt.medic = -1; }
    a.job = null; a.sprayAt = -1; a.fixAt = -1;
  };

  // Раз в полсекунды: кто куда бежит
  Crew.prototype.dispatch = function() {
    var i, j, st, a, rs = this.roomList, ag = this.agents;
    // 1. Счёт: кто на посту, сколько огня по отсекам
    for (i = 0; i < rs.length; i++) { rs[i].staffed = 0; rs[i].fires = 0; }
    for (i = 0; i < this.burning.length; i++) { st = this.rooms[this.ship.room[this.burning[i]]]; if (st) st.fires++; }
    for (i = 0; i < ag.length; i++) {
      a = ag[i];
      if (a.alive && !a.job && a.task === 'post' && this.ship.room[Math.floor(a.y) * this.w + Math.floor(a.x)] === a.home) {
        st = this.rooms[a.home]; if (st) st.staffed++;
      }
    }
    // 2. Освободить тех, чья работа кончилась
    for (i = 0; i < ag.length; i++) {
      a = ag[i];
      if (!a.alive || !a.job) continue;
      var kind = a.job.kind;
      st = this.rooms[a.job.room];
      var done = false;
      if (kind === 'fire') done = st.fires === 0;
      else if (kind === 'fix') done = st.integ >= 99.5 || st.fires > 0;
      else if (kind === 'heal') {
        var pt = this.agents[a.job.who];
        done = !pt || !pt.alive || pt.hp >= pt.hpMax - 1;
        // пациент сместился — догнать
        if (!done && !a.at && (Math.abs(pt.x - a.goal[0] - 0.5) > 2 || Math.abs(pt.y - a.goal[1] - 0.5) > 2)) this.goNear(a, pt, 'heal');
        else if (!done && a.at && (Math.abs(pt.x - a.x) > 2 || Math.abs(pt.y - a.y) > 2)) this.goNear(a, pt, 'heal');
      }
      if (done) { this.releaseJob(a); this.sendPost(a); }
    }
    if (!this.alertOn && !this.burning.length) return;
    // 3. Пожары: нужно бойцов по размеру огня
    for (i = 0; i < rs.length; i++) {
      st = rs[i];
      if (!st.fires) continue;
      var need = Math.min(8, 2 + Math.ceil(st.fires / 6));
      if (st.fighters < need) this.assign(st, 'fire', need - st.fighters);
    }
    // 4. Поломки без огня
    for (i = 0; i < rs.length; i++) {
      st = rs[i];
      if (st.fires || st.integ >= 95) continue;
      var needF = st.integ < 50 ? 4 : 2;
      if (KEY[st.t]) needF++;
      if (st.fixers < needF) this.assign(st, 'fix', needF - st.fixers);
    }
    // 5. Раненые — ближайший свободный медик идёт лечить
    for (i = 0; i < ag.length; i++) {
      a = ag[i];
      if (!a.alive || a.team !== this.team || a.hp >= 0.7 * a.hpMax || a.medic >= 0 || a.role === 'medic') continue;
      var md = null, mdD = 1e18;
      for (j = 0; j < ag.length; j++) {
        var m = ag[j]; if (!m.alive || m.role !== 'medic' || m.job) continue;
        var dd = (m.x - a.x) * (m.x - a.x) + (m.y - a.y) * (m.y - a.y);
        if (dd < mdD) { mdD = dd; md = m; }
      }
      if (!md) break;
      md.job = { kind: 'heal', room: 0, who: a.id }; a.medic = md.id;
      this.goNear(md, a, 'heal');
    }
    // 6. Подносчики: от склада к орудию, что стреляет
    if (this.alertOn) {
      for (i = 0; i < rs.length; i++) {
        st = rs[i];
        if (st.t !== 'gun' || st.runner > 0 || this.t - st.firedAt > 15 || !st.anchor || st.fires) continue;
        var rn = null, rd = 1e18;
        for (j = 0; j < ag.length; j++) {
          var b2 = ag[j];
          if (!b2.alive || b2.job || b2.role !== 'reserve' || b2.utype || !STORE[this.rooms[b2.home] && this.rooms[b2.home].t]) continue;
          var d2 = (b2.x - st.anchor[0]) * (b2.x - st.anchor[0]) + (b2.y - st.anchor[1]) * (b2.y - st.anchor[1]);
          if (d2 < rd) { rd = d2; rn = b2; }
        }
        if (!rn || rd > 140 * 140) continue;
        rn.job = { kind: 'carry', room: st.n }; rn.carry = true; st.runner++;
        this.go(rn, st.n, this.workSpot(st, rn.id) || this.spotIn(st.r), 'carry');
      }
    }
    // 7. Пустые ключевые посты — резерв встаёт на место погибших
    if (this.alertOn) {
      for (i = 0; i < rs.length; i++) {
        st = rs[i];
        if (!KEY[st.t] || st.assigned >= st.need || !st.anchor) continue;
        for (j = st.assigned; j < st.need; j++) {
          // на пост погибшего — резерв экипажа; купленные бойцы трюма — десант, не расчёт
          var b = this.nearest(st, function(x) { return x.role === 'reserve' && !x.job && !x.utype; });
          if (!b) break;
          var old = this.rooms[b.home]; if (old) old.assigned--;
          b.home = st.n; b.role = 'post'; b.spot = this.workSpot(st, b.id) || this.spotIn(st.r); st.assigned++;
          this.sendPost(b);
        }
      }
    }
  };
  // Кого послать: ближайшие по «цене» пути. Ремонтники дешевле резерва,
  // свои в горящем отсеке — первые (они уже здесь). Расчёты чужих постов не трогаем.
  Crew.prototype.assign = function(st, kind, count) {
    if (!st.anchor) return;            // в отсек не пройти (на плане нет свободного пола)
    var ag = this.agents, ax = st.anchor[0], ay = st.anchor[1], cand = [];
    for (var i = 0; i < ag.length; i++) {
      var a = ag[i];
      if (!a.alive || a.job) continue;
      var own = a.home === st.n, w;
      if (a.role === 'medic') continue;
      if (kind === 'fire') w = own ? 0.3 : a.role === 'fixer' ? 0.6 : a.role === 'reserve' ? 1 : -1;
      else w = own && a.role === 'post' ? -1 : a.role === 'fixer' ? 0.6 : a.role === 'reserve' ? 1 : -1;
      if (w < 0) continue;
      var dx = a.x - ax, dy = a.y - ay;
      cand.push([Math.sqrt(dx * dx + dy * dy) * w, a]);
    }
    cand.sort(function(p, q) { return p[0] - q[0]; });
    // ближайшие по прямой могут быть далеко по коридорам: уточнить длиной пути
    var f = this.flows.global(ax, ay);
    if (f) {
      var top = Math.min(cand.length, count + 8);
      for (var t = 0; t < top; t++) {
        var L = this.pathLen(f, cand[t][1]);
        if (L >= 0) cand[t][0] = L * (cand[t][0] / Math.max(0.01, Math.sqrt(Math.pow(cand[t][1].x - ax, 2) + Math.pow(cand[t][1].y - ay, 2))));
      }
      cand.sort(function(p, q) { return p[0] - q[0]; });
    }
    for (var k = 0; k < cand.length && count > 0; k++, count--) {
      var b = cand[k][1];
      b.job = { kind: kind, room: st.n };
      if (kind === 'fire') st.fighters++; else st.fixers++;
      this.goJob(b);
    }
  };
  // Длина пути по полю (в клетках), −1 — нет пути
  Crew.prototype.pathLen = function(f, a) {
    var x = Math.floor(a.x), y = Math.floor(a.y), L = 0;
    for (var i = 0; i < 3000; i++) {
      var d = flowDir(f, x, y);
      if (d === 254) return L;
      if (d === 255) return -1;
      x += DX[d]; y += DY[d]; L += (d & 1) ? 1.414 : 1;
    }
    return -1;
  };
  Crew.prototype.nearest = function(st, ok, maxD) {
    if (!st.anchor) return null;
    var best = null, bd = (maxD || 1e9) * (maxD || 1e9), ax = st.anchor[0], ay = st.anchor[1];
    for (var i = 0; i < this.agents.length; i++) {
      var a = this.agents[i];
      if (!a.alive || !ok(a)) continue;
      var dx = a.x - ax, dy = a.y - ay, d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = a; }
    }
    return best;
  };
  // Куда встать для работы: у ближайшей горящей клетки / у машины отсека
  Crew.prototype.goJob = function(a) {
    var st = this.rooms[a.job.room], cell = null;
    if (a.job.kind === 'fire') cell = this.fireSpot(st, a);
    else cell = this.workSpot(st, a.id);
    if (!cell) cell = this.spotIn(st.r);
    if (cell) { this.go(a, st.n, cell, a.job.kind); a.face = cell[2] != null ? cell[2] : null; a.fixCell = cell[3] != null ? cell[3] : -1; }
  };
  // Подойти к человеку (лечить): соседняя свободная клетка
  Crew.prototype.goNear = function(a, pt, task) {
    var W = this.w, px = Math.floor(pt.x), py = Math.floor(pt.y), best = null, bd = 1e9;
    for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      var x = px + dx, y = py + dy;
      if (x < 0 || y < 0 || x >= W || y >= this.h || !this.walk[y * W + x]) continue;
      var d = (x - a.x) * (x - a.x) + (y - a.y) * (y - a.y);
      if (d < bd) { bd = d; best = [x, y]; }
    }
    if (!best) best = [px, py];
    this.go(a, this.ship.room[best[1] * W + best[0]], best, task);
  };
  Crew.prototype.fireSpot = function(st, a) {
    var best = -1, bd = 1e9, W = this.w, sh = this.ship;
    for (var i = 0; i < this.burning.length; i++) {
      var c = this.burning[i]; if (sh.room[c] !== st.n) continue;
      var x = c % W, y = (c - x) / W, d = (x - a.x) * (x - a.x) + (y - a.y) * (y - a.y);
      if (d < bd) { bd = d; best = c; }
    }
    if (best < 0) return null;
    // соседняя клетка, где можно стоять (лучше без огня)
    var bx = best % W, by = (best - bx) / W, pick = null, pv = 1e9;
    for (var r = 1; r <= 7 && (!pick || r <= 3); r++) {
      for (var dy = -r; dy <= r; dy++) for (var dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        var gx = bx + dx, gy = by + dy;
        if (gx < 0 || gy < 0 || gx >= W || gy >= this.h) continue;
        var k = gy * W + gx;
        if (!this.walk[k] || sh.room[k] !== st.n) continue;
        // не вставать вплотную к другому пожарному: обступают огонь, а не толпятся
        var crowd = 0;
        for (var qy = -1; qy <= 1; qy++) for (var qx = -1; qx <= 1; qx++) {
          var qk = k + qy * W + qx, cl = this.claim[qk];
          if (cl && cl !== a.id + 1) crowd++;
        }
        var v = this.fire[k] * 4 + crowd * 60 + (gx - a.x) * (gx - a.x) + (gy - a.y) * (gy - a.y);
        if (v < pv) { pv = v; pick = [gx, gy]; }
      }
    }
    return pick;
  };

  // ---------------------------------------------------------------- огонь
  Crew.prototype.stepFire = function(dt) {
    var W = this.w, sh = this.ship, f = this.fire, list = this.burning, R = this.R, i;
    var add = [];
    for (i = list.length - 1; i >= 0; i--) {
      var c = list[i], v = f[c];
      if (v <= 0) { f[c] = 0; this.inList[c] = 0; list[i] = list[list.length - 1]; list.pop(); continue; }
      f[c] = Math.min(100, v + 9 * dt);
      var st = this.rooms[sh.room[c]];
      // поломка от огня — по доле горящего отсека: большой зал (реактор Венатора) не плавится быстрее малого
      if (st) st.integ = Math.max(0, st.integ - v * 0.0005 * dt * Math.min(1, 60 / Math.max(1, st.r.area || st.r.w * st.r.h)));
      if (v > 45 && list.length + add.length < 2500) {
        var x = c % W, y = (c - x) / W;
        for (var d = 0; d < 8; d += 2) {
          var nx = x + DX[d], ny = y + DY[d];
          if (nx < 0 || ny < 0 || nx >= W || ny >= this.h) continue;
          var nc = ny * W + nx;
          if (f[nc] || this.inList[nc] || !this.burnable(nc)) continue;
          if (R() < 0.035 * dt * (v / 100)) { f[nc] = 12; this.inList[nc] = 1; add.push(nc); }
        }
      }
    }
    for (i = 0; i < add.length; i++) list.push(add[i]);
  };

  // ---------------------------------------------------------------- шаг
  Crew.prototype.step = function(dt) {
    this.acc = Math.min(this.acc + dt, 0.5);
    while (this.acc >= STEP) { this.acc -= STEP; this.tick(STEP); }
  };
  Crew.prototype.tick = function(dt) {
    this.t += dt;
    if (this.ev.deaths.length > 200) this.ev.deaths.splice(0, 100);
    if (this.ev.ignites.length > 200) this.ev.ignites.splice(0, 100);
    if (this.ev.blasts.length > 60) this.ev.blasts.splice(0, 30);
    if (this.ev.guns.length > 60) this.ev.guns.splice(0, 30);
    // дальний путь по всему кораблю дорогой (5–15 мс) — не чаще ~6 раз в секунду
    this.flowT -= dt; this.budget = this.flowT <= 0 ? 1 : 0;
    var i, rs = this.roomList;
    for (i = 0; i < rs.length; i++) {
      if (rs[i].stun > 0) { rs[i].stun = Math.max(0, rs[i].stun - dt); if (rs[i].stun === 0) rs[i].stunImm = STUN_IMM; }
      else if (rs[i].stunImm > 0) rs[i].stunImm = Math.max(0, rs[i].stunImm - dt);
    }
    this.fireT += dt;
    if (this.fireT >= 0.25) { this.stepFire(this.fireT); this.fireT = 0; }
    this.think -= dt;
    if (this.think <= 0) { this.think = 0.5; this.dispatch(); }
    var ag = this.agents, B = this.board;
    for (i = 0; i < ag.length; i++) {
      if (!ag[i].alive) continue;
      if (B && B.owns(ag[i])) B.think(ag[i], dt); else this.think1(ag[i], dt);
    }
    this.collide(dt);
    if (B) B.tick(dt);
  };

  // Решение одного человека на шаг: куда хочет идти
  Crew.prototype.think1 = function(a, dt) {
    var W = this.w, cx = Math.floor(a.x), cy = Math.floor(a.y), here = cy * W + cx;
    // огонь жжёт
    if (this.fire[here]) this.hurt(a, this.fire[here] * (a.job && a.job.kind === 'fire' ? 0.05 : 0.14) * dt);
    if (!a.alive) return;
    a.dvx = 0; a.dvy = 0;
    if (a.at) {
      a.mv += (0 - a.mv) * Math.min(1, dt * 6);
      this.work(a, dt);
      return;
    }
    if (a.wait > 0) { a.wait -= dt; a.mv += (0 - a.mv) * Math.min(1, dt * 6); return; }
    if (a.hold > 0) { a.hold -= dt; a.mv += (0 - a.mv) * Math.min(1, dt * 6); return; }
    this.nav(a, dt, a.job && a.job.kind === 'muster' ? MUSTER_RUN : (this.alertOn || a.job) ? RUN : WALK);
  };
  // Шаг к цели (a.goal в отсеке a.goalRoom) со скоростью sp; вернёт клетку, куда шагает
  // дальше (−1 — стоит, пришёл или ждёт поле направлений). Нужен и абордажу.
  Crew.prototype.nav = function(a, dt, sp) {
    var W = this.w, cx = Math.floor(a.x), cy = Math.floor(a.y), here = cy * W + cx;
    var gx = a.goal[0], gy = a.goal[1];
    var ddx = gx + 0.5 - a.x, ddy = gy + 0.5 - a.y, dist = Math.sqrt(ddx * ddx + ddy * ddy);
    if ((cx === gx && cy === gy && dist < 0.3) || (dist < 1.1 && a.stuck > 0.8)) { a.at = true; a.vx = a.vy = 0; return -1; }
    // где следующий шаг
    var room = this.ship.roomByN[a.goalRoom], f = null, d = 255;
    if (room && this.ship.room[here] === a.goalRoom) f = this.flows.inRoom(room, gx, gy);
    if (f) d = flowDir(f, cx, cy);
    if (!room) { f = this.flows.global(gx, gy); d = f ? flowDir(f, cx, cy) : 255; }     // цель в коридоре
    else if (!f || d === 255) {
      var st = this.rooms[a.goalRoom];
      var an = st && st.anchor;
      if (an) {
        if (cx === an[0] && cy === an[1]) { f = this.flows.inRoom(room, gx, gy); d = flowDir(f, cx, cy); }
        else { f = this.flows.global(an[0], an[1]); d = f ? flowDir(f, cx, cy) : 255; }
      }
    }
    if (!f) { a.wait = 0.1; return -1; }       // поле строится в следующий шаг
    var tx, ty, nextC = -1;
    if (d === 254) { tx = gx + 0.5; ty = gy + 0.5; }
    else if (d === 255) {
      // путь закрыт (огонь не в счёт — закрыто стенами): выбрать новое место
      a.goal = (room && this.spotIn(room)) || a.goal; a.wait = 0.5; return -1;
    } else {
      var nx = cx + DX[d], ny = cy + DY[d], d2 = flowDir(f, nx, ny);
      tx = nx + 0.5; ty = ny + 0.5; nextC = ny * W + nx;
      if (d2 < 8) { tx += DX[d2] * 0.5; ty += DY[d2] * 0.5; }   // плавнее на поворотах
    }
    var dx = tx - a.x, dy = ty - a.y, L = Math.sqrt(dx * dx + dy * dy) || 1;
    var urgent = sp > WALK;
    // застрял — шаг в сторону
    if (dist < a.lastD - 0.05) { a.lastD = dist; a.stuck = 0; } else a.stuck += dt;
    if (a.stuck > 1.5) { a.wig = 0.6; a.stuck = 0; a.side = this.R() < 0.5 ? 1 : -1; }
    if (a.wig > 0) { a.wig -= dt; var px = -dy / L * a.side, py = dx / L * a.side; dx = dx / L + px * 0.9; dy = dy / L + py * 0.9; L = Math.sqrt(dx * dx + dy * dy); }
    a.dvx = dx / L * sp; a.dvy = dy / L * sp;
    var ang = Math.atan2(dy, dx);
    a.legs = turn(a.legs, ang, 9 * dt); a.aim = turn(a.aim, ang, 7 * dt);
    a.mv += (1 - a.mv) * Math.min(1, dt * 6);
    a.phase = (a.phase + dt * (urgent ? 10 : 7)) % (Math.PI * 2);
    return nextC;
  };

  // На месте: вахта у пультов, тушение, ремонт, лечение, подноска; в мирное время — прогулки
  Crew.prototype.work = function(a, dt) {
    var j = a.job, W = this.w;
    // десант у шлюза: ждёт посадки в шаттл, оружие наготове
    if (j && j.kind === 'muster') { a.phase = (a.phase + dt * 1.5) % 6.28; if (a.face != null) a.aim = turn(a.aim, a.face, 3 * dt); return; }
    if (j && j.kind === 'fire') {
      var cx = Math.floor(a.x), cy = Math.floor(a.y), any = false;
      // струя бьёт до 7 клеток (14 м): огонь на машинах достают из прохода
      var bk = -1, bd = 999;
      for (var dy = -7; dy <= 7; dy++) for (var dx = -7; dx <= 7; dx++) {
        var gx = cx + dx, gy = cy + dy;
        if (gx < 0 || gy < 0 || gx >= W || gy >= this.h) continue;
        var k = gy * W + gx;
        if (!this.fire[k]) continue;
        any = true;
        var dd = dx * dx + dy * dy;
        if (dd < bd) { bd = dd; bk = k; }
      }
      a.sprayAt = bk;
      if (bk >= 0) {
        // пеной по ближайшей клетке и её соседям
        var fx = bk % W, fy = (bk - fx) / W;
        this.fire[bk] = Math.max(0, this.fire[bk] - 16 * dt);
        for (var ny = -1; ny <= 1; ny++) for (var nx = -1; nx <= 1; nx++) {
          var nk = (fy + ny) * W + fx + nx;
          if (nk !== bk && nk >= 0 && nk < this.fire.length && this.fire[nk]) this.fire[nk] = Math.max(0, this.fire[nk] - 4 * dt);
        }
        a.aim = turn(a.aim, Math.atan2(fy + 0.5 - a.y, fx + 0.5 - a.x), 8 * dt);
        // огонь далеко (больше 4 клеток) — подойти ближе
        if (bd > 16) { var c0 = this.fireSpot(this.rooms[j.room], a); if (c0 && (c0[0] !== a.goal[0] || c0[1] !== a.goal[1])) this.go(a, j.room, c0, 'fire'); }
      }
      a.phase = (a.phase + dt * 4) % 6.28;
      if (!any) { var c = this.fireSpot(this.rooms[j.room], a); if (c) this.go(a, j.room, c, 'fire'); }
      return;
    }
    if (j && j.kind === 'fix') {
      var st = this.rooms[j.room];
      if (st && !st.fires) st.integ = Math.min(100, st.integ + 0.9 * dt);
      a.fixAt = a.fixCell >= 0 ? a.fixCell : -1;
      if (a.face != null) a.aim = turn(a.aim, a.face, 6 * dt);
      a.phase = (a.phase + dt * 3) % 6.28;
      a.busyT -= dt;
      if (a.busyT <= 0) {
        // к следующей машине отсека
        a.busyT = 4 + this.R() * 4;
        var p = this.workSpot(st, a.id) || this.spotIn(st.r);
        if (p) { this.go(a, st.n, p, 'fix'); a.face = p[2] != null ? p[2] : null; a.fixCell = p[3] != null ? p[3] : -1; }
      }
      return;
    }
    if (j && j.kind === 'heal') {
      var pt = this.agents[j.who];
      if (!pt || !pt.alive) return;
      var ddx = pt.x - a.x, ddy = pt.y - a.y;
      if (ddx * ddx + ddy * ddy < 2.6) {
        pt.hp = Math.min(pt.hpMax, pt.hp + 9 * dt); pt.hold = 0.4;
        a.aim = turn(a.aim, Math.atan2(ddy, ddx), 8 * dt);
        a.phase = (a.phase + dt * 3) % 6.28;
      } else this.goNear(a, pt, 'heal');
      return;
    }
    if (j && j.kind === 'carry') {
      // отдал ящик расчёту — назад на склад
      a.carry = false; var gs = this.rooms[j.room]; if (gs) gs.runner--;
      a.job = { kind: 'back', room: j.room };
      var hs = this.rooms[a.home];
      if (hs) { a.wait = 1 + this.R(); this.go(a, hs.n, this.workSpot(hs, a.id) || this.spotIn(hs.r), 'back'); }
      return;
    }
    if (j && j.kind === 'back') { this.releaseJob(a); this.sendPost(a); return; }
    // вахта: лицом к пульту, время от времени — к соседнему
    if (a.face != null) a.aim = turn(a.aim, a.face + Math.sin(this.t * 0.7 + a.id) * 0.25, 3 * dt);
    a.busyT -= dt;
    if (this.alertOn) {
      if (a.busyT <= 0) {
        a.busyT = 6 + this.R() * 10;
        var hs2 = this.rooms[a.home];
        if (hs2 && hs2.spots && hs2.spots.length > 1 && this.R() < 0.6) {
          var q = this.workSpot(hs2, a.id);
          if (q) { a.spot = q; this.sendPost(a); }
        }
      }
      return;
    }
    // мирное время: постоял — прошёлся
    a.wait -= dt;
    if (a.wait > 0) return;
    a.wait = 2 + this.R() * 6;
    if (this.R() < 0.15) {
      var back = a.goalRoom !== a.home;
      var r2 = back ? this.ship.roomByN[a.home] : this.ship.rooms[Math.floor(this.R() * this.ship.rooms.length)];
      var st2 = r2 && this.rooms[r2.n];
      var p2 = st2 && (this.workSpot(st2, a.id) || this.spotIn(r2));
      if (p2) { this.go(a, r2.n, p2, 'post'); a.face = p2[2] != null ? p2[2] : null; a.wait = 0; }
    } else {
      var r = this.ship.roomByN[a.goalRoom], st3 = r && this.rooms[r.n], p3 = st3 && (this.workSpot(st3, a.id) || this.spotIn(r));
      if (p3 && Math.abs(p3[0] - a.x) + Math.abs(p3[1] - a.y) < 14) { this.go(a, r.n, p3, 'post'); a.face = p3[2] != null ? p3[2] : null; a.wait = 0; }
    }
  };

  function turn(cur, to, step) {
    var d = to - cur;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return Math.abs(d) <= step ? to : cur + (d > 0 ? step : -step);
  }

  // ---------------------------------------------------------------- тела
  // Движение → раздвинуть людей (правостороннее расхождение) → вытолкнуть из стен.
  Crew.prototype.collide = function(dt) {
    if (this.nextIn.length < this.agents.length) this.nextIn = new Int32Array(this.agents.length + 64);   // на борт пришли чужие
    var ag = this.agents, W = this.w, head = this.cellHead, next = this.nextIn, used = this.used, i, a;
    for (i = 0; i < ag.length; i++) {
      a = ag[i]; if (!a.alive) continue;
      var k = Math.min(1, dt * 10);
      a.vx += ((a.dvx || 0) - a.vx) * k; a.vy += ((a.dvy || 0) - a.vy) * k;
      a.x += a.vx * dt; a.y += a.vy * dt;
      this.wall(a);
    }
    // сетка
    for (i = 0; i < used.length; i++) head[used[i]] = -1;
    used.length = 0;
    for (i = 0; i < ag.length; i++) {
      a = ag[i]; if (!a.alive) continue;
      var c = Math.floor(a.y) * W + Math.floor(a.x);
      if (head[c] === -1) used.push(c);
      next[i] = head[c]; head[c] = i;
    }
    var D = R * 2, D2 = D * D;
    for (i = 0; i < ag.length; i++) {
      a = ag[i]; if (!a.alive) continue;
      var ax = Math.floor(a.x), ay = Math.floor(a.y);
      for (var yy = ay - 1; yy <= ay + 1; yy++) {
        if (yy < 0 || yy >= this.h) continue;
        for (var xx = ax - 1; xx <= ax + 1; xx++) {
          if (xx < 0 || xx >= W) continue;
          for (var j = head[yy * W + xx]; j !== -1; j = next[j]) {
            if (j <= i) continue;
            var b = ag[j], dx = b.x - a.x, dy = b.y - a.y, d2 = dx * dx + dy * dy;
            if (d2 >= D2) continue;
            var d = Math.sqrt(d2);
            if (d < 1e-4) { dx = (i & 1 ? 1 : -1) * 0.01; dy = 0.01; d = 0.0141; }
            var over = D - d, nx = dx / d, ny = dy / d;
            // кто стоит — уступает тому, кто идёт
            var am = a.at ? 0 : 1, bm = b.at ? 0 : 1;
            var wa = am === bm ? 0.5 : am ? 0.25 : 0.75, wb = 1 - wa;
            a.x -= nx * over * wa; a.y -= ny * over * wa;
            b.x += nx * over * wb; b.y += ny * over * wb;
            // встречные — каждый вправо от своего хода
            if (am && bm && (a.dvx * b.dvx + a.dvy * b.dvy) < 0) {
              var sa = Math.sqrt(a.dvx * a.dvx + a.dvy * a.dvy) || 1, sb = Math.sqrt(b.dvx * b.dvx + b.dvy * b.dvy) || 1;
              var side = 0.35 * over;
              a.x += -a.dvy / sa * side; a.y += a.dvx / sa * side;
              b.x += -b.dvy / sb * side; b.y += b.dvx / sb * side;
            }
            // стоящего толкнули — не вечно, вернётся на своё место
            if (a.at && wa > 0.5 && over > 0.15) { a.at = false; a.lastD = 1e9; }
            if (b.at && wb > 0.5 && over > 0.15) { b.at = false; b.lastD = 1e9; }
          }
        }
      }
    }
    for (i = 0; i < ag.length; i++) if (ag[i].alive) this.wall(ag[i]);
  };
  // Круг против непроходимых клеток: вытолкнуть наружу
  Crew.prototype.wall = function(a) {
    var W = this.w, H = this.h, walk = this.walk;
    // запертая дверь — стена для абордажной команды (свои проходят)
    if (this.board && a.team !== this.team) walk = this.board.walkAtt;
    for (var pass = 0; pass < 2; pass++) {
      var cx = Math.floor(a.x), cy = Math.floor(a.y);
      // центр сам оказался в стене (сильный толчок) — назад на ближайшую свободную клетку
      if (cx < 0 || cy < 0 || cx >= W || cy >= H || !walk[cy * W + cx]) { this.unstick(a); cx = Math.floor(a.x); cy = Math.floor(a.y); }
      for (var y = cy - 1; y <= cy + 1; y++) for (var x = cx - 1; x <= cx + 1; x++) {
        if (x >= 0 && y >= 0 && x < W && y < H && walk[y * W + x]) continue;
        var px = Math.max(x, Math.min(x + 1, a.x)), py = Math.max(y, Math.min(y + 1, a.y));
        var dx = a.x - px, dy = a.y - py, d2 = dx * dx + dy * dy;
        if (d2 >= R * R) continue;
        var d = Math.sqrt(d2);
        if (d < 1e-5) continue;
        var push = R - d;
        a.x += dx / d * push; a.y += dy / d * push;
      }
    }
  };
  Crew.prototype.unstick = function(a) {
    var W = this.w, cx = Math.floor(a.x), cy = Math.floor(a.y), best = null, bd = 1e9;
    var walk = this.board && a.team !== this.team ? this.board.walkAtt : this.walk;
    for (var r = 1; r <= 4 && !best; r++) {
      for (var y = cy - r; y <= cy + r; y++) for (var x = cx - r; x <= cx + r; x++) {
        if (x < 0 || y < 0 || x >= W || y >= this.h || !walk[y * W + x]) continue;
        var dx = x + 0.5 - a.x, dy = y + 0.5 - a.y, d = dx * dx + dy * dy;
        if (d < bd) { bd = d; best = [x + 0.5, y + 0.5]; }
      }
    }
    if (best) { a.x = best[0]; a.y = best[1]; }
  };

  return { Crew: Crew, POST: POST, KEY: KEY, GROUP: GROUP, K: K, STEP: STEP, R: R, RUN: RUN, WALK: WALK, DX: DX, DY: DY, turn: turn };
});
