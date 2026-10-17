/* Наземный бой 2.0 по сети: Viewer (сервер → что видит сторона) и Mirror (браузер держит
 * бой без расчёта и сглаживает движение). Текстовые кадры JSON, 5 Гц; туман, районы и
 * отряды — раз в секунду; полный список бойцов — раз в 10 с и при входе.
 *
 * Кадр f: { t:'f', T, n:[[id,x,y,aim,mv,hp,flags,aux]...], new:[{...}], gone:[id], ev:{s,b,x,m,d,sh},
 *           cnt:[живых 0, 1], cap, dist, fog (RLE), sq, st:[[i,hp,dead]] }
 * flags: 1 в укрытии, 2 оглушён, 4 страх, 8 держит, 16 на месте, 32 купол, 64 внушение, 128 идёт к точке игрока
 * aux: техника — угол башни; герой — [поза, k]; остальные — 0.
 * Приказы cmd: move {ids,x,y}, attack {ids,tid}, hold, stop, auto {ids,on}, assign {ids,sq},
 *              ability {id,ab,tgt}, load {ids,ship}.
 * ES5, UMD.
 */
(function(root, factory) {
  var api = factory(
    typeof require === 'function' ? require('./rt-planets.js') : root.SWPlanets,
    typeof require === 'function' ? require('./rt-units.js') : root.SWUnits,
    typeof require === 'function' ? require('./rt-ground.js') : root.SWGround
  );
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SWGroundNet = api;
})(typeof self !== 'undefined' ? self : this, function(P, U, GR) {
  'use strict';
  var N = P.N, TAU = Math.PI * 2;
  var FRAME_EVERY = 2, SLOW_EVERY = 10, FULL_EVERY = 100;   // в тактах сервера (0,1 с)
  var DELAY = 0.25;                                         // запаздывание отрисовки, с
  var ACTS = ['idle', 'run', 'slash', 'deflect', 'push', 'throw', 'dash', 'lightning', 'choke', 'mind', 'heal', 'barrier'];
  var ACT_N = {}; ACTS.forEach(function(a, i) { ACT_N[a] = i; });
  function r2(x) { return Math.round(x * 100) / 100; }
  function r1(x) { return Math.round(x * 10) / 10; }

  // RLE тумана: строка «v:n,v:n,...» по 20736 клеткам
  function rle(arr) {
    var out = [], i = 0, n = arr.length;
    while (i < n) { var v = arr[i], k = 1; while (i + k < n && arr[i + k] === v) k++; out.push(v + ':' + k); i += k; }
    return out.join(',');
  }
  function unrle(s, arr) {
    var parts = s.split(','), o = 0;
    for (var i = 0; i < parts.length; i++) { var p = parts[i].split(':'), v = +p[0], k = +p[1]; for (var j = 0; j < k && o < arr.length; j++) arr[o++] = v; }
  }

  // ---------------------------------------------------------------- Viewer
  // ownerCheck: приказы только своим бойцам (a.owner === user); на полигоне — всей стороне
  function Viewer(B, side, user, opts) {
    this.B = B; this.side = side; this.user = user; this.opts = opts || {};
    this.known = {}; this.seenAt = {}; this.lastT = -1; this.msgSeq = 0; this.full = true; this.stHp = {}; this.sqKey = ''; this.last = {}; this.shown = {};
  }
  Viewer.prototype.lost = function() { this.full = true; this.known = {}; this.shown = {}; this.last = {}; };
  Viewer.prototype.visible = function(a) {
    if (!a.alive) return false;
    if (this.B.ctl(a) === this.side || a.team === this.side) return true;
    return this.B.canSee(this.side, a);
  };
  Viewer.prototype.flags = function(a) {
    var t = this.B.t;
    return (a.inside >= 0 ? 1 : 0) | (a.stun > 0 ? 2 : 0) | (a.fear > 0 ? 4 : 0) | (a.hold ? 8 : 0) | (a.at || !a.goal ? 16 : 0) | (a.barrier > t ? 32 : 0) | (a.mind && a.mind.until > t ? 64 : 0) | (a.post && !a.at ? 128 : 0);
  };
  Viewer.prototype.intro = function(a) {
    return { id: a.id, tid: a.tid, team: a.team, uid: a.uid || null, name: a.name || '', hpMax: a.hpMax, owner: a.owner || null, npc: !!a.npc, size: a.size,
             hero: a.hero ? { abil: a.hero.abil, portrait: a.hero.portrait, hid: a.hid || null } : null };
  };
  Viewer.prototype.frame = function(tickN) {
    var B = this.B, side = this.side, t = B.t, ag = B.agents, i, a;
    var slow = this.full || tickN % SLOW_EVERY === 0, full = this.full || tickN % FULL_EVERY === 0, snap = this.full || tickN % 20 === 0;
    var f = { t: 'f', T: r2(t), n: [], ev: {} }, nw = [], gone = [], hide = [];
    for (i = 0; i < ag.length; i++) {
      a = ag[i];
      if (!this.visible(a)) {
        if (this.known[a.id] && !a.alive && !this.seenAt['d' + a.id]) { gone.push(a.id); this.seenAt['d' + a.id] = 1; }
        else if (this.shown[a.id] && a.alive) hide.push(a.id);     // жив, но вышел из виду
        this.shown[a.id] = 0;
        continue;
      }
      if (!this.known[a.id] || full) { this.known[a.id] = 1; nw.push(this.intro(a)); }
      var aux = a.T.vehicle && a.size === 2 ? r2(a.turretA) : a.hero ? [ACT_N[a.hero.actT > 0 ? a.hero.act : 'idle'] || 0, r2(a.hero.k || 0)] : 0;
      var row = [a.id, r2(a.x), r2(a.y), r2(a.aim), a.mv > 0.3 ? 1 : 0, Math.round(a.hp), this.flags(a), aux], key = row.join(',');
      // стоящие не повторяются в каждом кадре: только изменения, раз в 2 с — все
      if (snap || !this.shown[a.id] || this.last[a.id] !== key) { f.n.push(row); this.last[a.id] = key; }
      this.shown[a.id] = 1;
    }
    if (nw.length) f.new = nw;
    if (gone.length) f.gone = gone;
    if (hide.length) f.hide = hide;
    // события с прошлого кадра, видимые стороне
    var self = this, since = this.lastT;
    var vis = function(x, y) { var c = Math.floor(y) * N + Math.floor(x); return c >= 0 && c < N * N && B.seen[side][c] === 2; };
    f.ev.s = B.ev.shots.filter(function(q) { return q.t > since && (q.team === side || vis(q.x0, q.y0) || vis(q.x1, q.y1)); })
      .map(function(q) { return [r2(q.t), r1(q.x0), r1(q.y0), r1(q.x1), r1(q.y1), q.team, q.hit ? 1 : 0, q.w || '', q.d || 0, q.melee ? 1 : 0]; });
    f.ev.b = B.ev.booms.filter(function(q) { return q.t > since && vis(q.x, q.y); }).map(function(q) { return [r2(q.t), r1(q.x), r1(q.y), r1(q.r)]; });
    f.ev.x = B.ev.fx.filter(function(q) { return q.t > since && (q.x == null || vis(q.x, q.y) || (q.id != null && ag[q.id] && self.visible(ag[q.id]))); })
      .map(function(q) { return { k: q.k, t: r2(q.t), x: q.x, y: q.y, id: q.id, tx: q.tx, ty: q.ty, tid: q.tid, r: q.r, until: q.until }; });
    f.ev.sh = B.ev.shells.filter(function(q) { return q.t0 > since; }).map(function(q) { return [r2(q.t0), r2(q.t1), r1(q.x0), r1(q.y0), r1(q.x1), r1(q.y1), r1(q.r)]; });
    var ms = []; for (i = 0; i < B.ev.msgs.length; i++) { var m = B.ev.msgs[i]; if (m.seq > this.msgSeq && m.team === side) ms.push([m.seq, m.text, m.kind || '']); if (m.seq > this.msgSeq) this.msgSeq = m.seq; }
    if (ms.length) f.ev.m = ms;
    f.ev.d = B.ev.deaths.filter(function(q) { return q.t > since; }).map(function(q) { return q.id; });
    this.lastT = t;
    // здоровье построек — только изменившиеся
    var st = [];
    for (i = 0; i < B.structs.length; i++) { var s = B.structs[i], key = Math.round(s.hp) + ':' + (s.dead ? 1 : 0); if (this.stHp[i] !== key || full) { this.stHp[i] = key; st.push([i, Math.round(s.hp), s.dead ? 1 : 0]); } }
    if (st.length) f.st = st;
    if (slow) {
      f.cnt = [B.alive(0), B.alive(1)];
      f.cap = { prog: r1(B.cap.prog), status: B.cap.status, cnt: B.cap.cnt, need: B.capNeed };
      f.dist = B.districts.map(function(d) { return [d.by, d.cnt[0], d.cnt[1]]; });
      f.fog = rle(B.seen[side]);
      var sq = B.teams[side].squads.map(function(q) { return { id: q.id, members: q.members.slice() }; }), sk = JSON.stringify(sq);
      if (sk !== this.sqKey || full) { this.sqKey = sk; f.sq = sq; }
      if (B.over >= 0) { f.over = B.over; f.why = B.why; }
    }
    this.full = false;
    return JSON.stringify(f);
  };
  // Приказ от игрока: только своим; чужие id отбрасываются
  Viewer.prototype.ids = function(list) {
    var B = this.B, side = this.side, user = this.user, own = this.opts.ownerCheck, out = [];
    if (!Array.isArray(list)) return out;
    for (var i = 0; i < list.length && i < 400; i++) {
      var id = list[i] | 0, a = B.agents[id]; if (!a || !a.alive) continue;
      if (B.ctl(a) !== side) continue;
      if (own && a.owner !== user) continue;
      if (a.npc) continue;
      out.push(id);
    }
    return out;
  };
  Viewer.prototype.command = function(m) {
    var B = this.B, side = this.side, ids = this.ids(m.ids);
    switch (m.k) {
      case 'move': { var x = m.x | 0, y = m.y | 0; if (x < 0 || y < 0 || x >= N || y >= N) return; if (ids.length) B.orderMove(side, ids, x, y); return; }
      case 'attack': { var tg = B.agents[m.tid | 0]; if (!tg || !tg.alive || !this.visible(tg) || B.ctl(tg) === side) return; if (ids.length) B.orderAttack(side, ids, tg.id); return; }
      case 'hold': if (ids.length) B.orderHold(side, ids); return;
      case 'stop': if (ids.length) B.orderStop(side, ids); return;
      case 'auto': if (ids.length) B.setAuto(side, ids, !!m.on); return;
      case 'assign': if (ids.length) B.assign(side, ids, m.sq | 0); return;
      case 'ability': {
        var hid = this.ids([m.id])[0]; if (hid == null) return;
        var tgt = null;
        if (m.tgt && m.tgt.tid != null) { var ta = B.agents[m.tgt.tid | 0]; if (!ta || !ta.alive) return; tgt = { tid: ta.id }; }
        else if (m.tgt && m.tgt.x != null) tgt = { x: +m.tgt.x, y: +m.tgt.y };
        var err = B.useAbility(side, hid, String(m.ab || ''), tgt);
        if (err) B.msg(err, side, 'bad');
        return;
      }
      case 'load': if (ids.length && this.opts.onLoad) this.opts.onLoad(ids, String(m.ship || ''), this.user); return;
      case 'build': {
        // инженер: укрепление из игры (тип и клетка проверяет база, комната подводит бойца)
        var bid = this.ids([m.id])[0]; if (bid == null || !this.opts.onBuild) return;
        var bx = m.x | 0, by = m.y | 0, bw = Math.max(1, Math.min(6, m.w | 0)), bh = Math.max(1, Math.min(6, m.h | 0));
        if (bx < 0 || by < 0 || bx + bw > N || by + bh > N || !/^[a-z0-9_]{1,40}$/.test(String(m.type || ''))) return;
        this.opts.onBuild(bid, { type: String(m.type), x: bx, y: by, w: bw, h: bh }, this.user);
        return;
      }
      default: return;
    }
  };

  // ---------------------------------------------------------------- Mirror
  // Тот же набор полей, что читает экран (ground/ground.js) у движка
  function Mirror(hello, side, send) {
    this.side = side; this.send = send;
    this.mapJson = hello.map; this.settle = hello.map.settle; this.town = hello.map.town || P.GEO.town;
    this.map = P.load(hello.map); this.att = hello.att; this.def = 1 - hello.att;
    this.zones = hello.map.zones || { deploy: [], slots: [] };
    this.sx = this.town[0] + (this.town[2] >> 1) - (GR.SQUARE >> 1); this.sy = this.town[1] + (this.town[3] >> 1) - (GR.SQUARE >> 1);
    this.capNeed = hello.capNeed || 120; this.cap = { prog: 0, status: 'stalled', cnt: [0, 0] };
    this.agents = []; this.structs = (hello.structs || []).map(function(s) { return s; });
    this.districts = hello.districts || [];
    this.teams = [{ squads: [] }, { squads: [] }, { squads: [] }];
    this.seen = [new Uint8Array(N * N), new Uint8Array(N * N)]; this.fogN = 0;
    this.ev = { shots: [], booms: [], fx: [], msgs: [], deaths: [], shells: [] };
    this.t = hello.T || 0; this.srvT = this.t; this.at = Date.now(); this.over = -1; this.why = '';
    this.cnt = [0, 0]; this.seq = 0; this.pass = null;
  }
  Mirror.prototype.ctl = function(a) { return a.mind && a.mind.until > this.t ? a.mind.by : a.team; };
  Mirror.prototype.canSee = function(side, a) { return !!a.vis; };
  Mirror.prototype.alive = function(team) { return this.cnt[team] || 0; };
  Mirror.prototype.squadOf = function(team, id) { var sqs = this.teams[team].squads; for (var i = 0; i < sqs.length; i++) if (sqs[i].id === id) return sqs[i]; return null; };
  Mirror.prototype.cmd = function(k, o) { o = o || {}; o.t = 'cmd'; o.k = k; this.send(JSON.stringify(o)); };
  Mirror.prototype.orderMove = function(team, ids, x, y) { var self = this; ids.forEach(function(i) { var a = self.agents[i]; if (a) { a.goal = [x, y]; a.at = false; a.post = true; a.hold = false; a.focus = -1; } }); this.cmd('move', { ids: ids, x: x, y: y }); return ids.length; };
  Mirror.prototype.orderAttack = function(team, ids, tid) { var self = this; ids.forEach(function(i) { var a = self.agents[i]; if (a) { a.focus = tid; a.hold = false; } }); this.cmd('attack', { ids: ids, tid: tid }); return ids.length; };
  Mirror.prototype.orderHold = function(team, ids) { var self = this; ids.forEach(function(i) { var a = self.agents[i]; if (a) { a.hold = true; a.at = true; a.post = true; } }); this.cmd('hold', { ids: ids }); return ids.length; };
  Mirror.prototype.orderStop = function(team, ids) { var self = this; ids.forEach(function(i) { var a = self.agents[i]; if (a) { a.hold = false; a.at = true; a.post = false; a.goal = null; a.focus = -1; } }); this.cmd('stop', { ids: ids }); return ids.length; };
  Mirror.prototype.setAuto = function(team, ids, on) { this.cmd('auto', { ids: ids, on: !!on }); };
  Mirror.prototype.assign = function(team, ids, sq) { this.cmd('assign', { ids: ids, sq: sq }); return sq; };
  Mirror.prototype.useAbility = function(team, id, ab, tgt) { this.cmd('ability', { id: id, ab: ab, tgt: tgt }); return null; };
  Mirror.prototype.orderLoad = function(ids, ship) { this.cmd('load', { ids: ids, ship: ship }); };
  Mirror.prototype.orderBuild = function(id, type, x, y, w, h) { this.cmd('build', { id: id, type: type, x: x, y: y, w: w, h: h }); };
  Mirror.prototype.onText = function(m) {
    if (m.t === 'f') this.frame(m);
    else if (m.t === 'note') this.ev.msgs.push({ seq: ++this.seq, t: this.t, text: m.msg, team: this.side, kind: m.kind || '' });
  };
  Mirror.prototype.frame = function(f) {
    var i, self = this;
    this.srvT = f.T; this.at = Date.now();
    if (f.new) for (i = 0; i < f.new.length; i++) {
      var n = f.new[i], a = this.agents[n.id];
      while (this.agents.length < n.id) this.agents.push({ id: this.agents.length, alive: false, gone: true, T: U.type('rep_dc15a'), team: 0, x: 0, y: 0, hp: 0, hpMax: 1, size: 1 });   // без дыр в списке
      if (!a) {
        var Ty = U.type(n.tid) || U.type(n.team === 0 ? 'rep_dc15a' : 'cis_b1');
        a = { id: n.id, tid: n.tid, T: Ty, team: n.team, uid: n.uid, name: n.name, hpMax: n.hpMax, owner: n.owner, npc: n.npc, size: n.size || Ty.size,
              x: 0, y: 0, aim: 0, legs: 0, mv: 0, phase: Math.random() * TAU, hp: n.hpMax, alive: true, gone: false, diedAt: 0, air: Ty.air, fly: Ty.move === 'air',
              inside: -1, stun: 0, fear: 0, hold: false, at: true, goal: null, post: false, sq: 0, tgt: -1, focus: -1, barrier: 0, mind: null, turretA: 0,
              hero: n.hero ? { act: 'idle', k: 0, actT: 0, cds: {}, abil: n.hero.abil || [], portrait: n.hero.portrait, hid: n.hero.hid || null } : null, k0: null, k1: null, vis: false, seenT: 0 };
        this.agents[n.id] = a;
      } else { a.name = n.name; a.hpMax = n.hpMax; a.owner = n.owner; a.uid = n.uid; }
    }
    var now = f.T;
    for (i = 0; i < f.n.length; i++) {
      var u = f.n[i], b = this.agents[u[0]]; if (!b) continue;
      b.k0 = b.k1 || { x: u[1], y: u[2], T: now - FRAME_EVERY * 0.1 }; b.k1 = { x: u[1], y: u[2], T: now };
      if (!b.vis) { b.x = u[1]; b.y = u[2]; b.k0 = b.k1; }
      b.aim = u[3]; b.mv = u[4]; b.hp = u[5]; var fl = u[6];
      b.inside = fl & 1 ? 0 : -1; b.stun = fl & 2 ? 1 : 0; b.fear = fl & 4 ? 1 : 0; b.hold = !!(fl & 8); b.at = !!(fl & 16); b.barrier = fl & 32 ? now + 1 : 0;
      b.mind = fl & 64 ? { until: now + 1, by: 1 - b.team } : null; b.post = !!(fl & 128);
      if (b.T.vehicle && b.size === 2) b.turretA = +u[7] || 0;
      else if (b.hero && Array.isArray(u[7])) { b.hero.act = ACTS[u[7][0]] || 'idle'; b.hero.k = u[7][1]; b.hero.actT = b.hero.act === 'idle' ? 0 : 1; }
      b.vis = true; b.seenT = now; b.alive = true;
    }
    if (f.gone) for (i = 0; i < f.gone.length; i++) { var g = this.agents[f.gone[i]]; if (g && g.alive) { g.alive = false; g.diedAt = now; g.vis = false; } }
    if (f.hide) for (i = 0; i < f.hide.length; i++) { var hd = this.agents[f.hide[i]]; if (hd) hd.vis = false; }
    if (f.ev) {
      var e = f.ev;
      if (e.s) e.s.forEach(function(q) { self.ev.shots.push({ t: q[0], x0: q[1], y0: q[2], x1: q[3], y1: q[4], team: q[5], hit: !!q[6], w: q[7], d: q[8], melee: !!q[9] }); });
      if (e.b) e.b.forEach(function(q) { self.ev.booms.push({ t: q[0], x: q[1], y: q[2], r: q[3] }); });
      if (e.x) e.x.forEach(function(q) { self.ev.fx.push(q); });
      if (e.sh) e.sh.forEach(function(q) { self.ev.shells.push({ t0: q[0], t1: q[1], x0: q[2], y0: q[3], x1: q[4], y1: q[5], r: q[6] }); });
      if (e.m) e.m.forEach(function(q) { self.ev.msgs.push({ seq: ++self.seq, t: now, text: q[1], kind: q[2], team: self.side }); });
      if (e.d) e.d.forEach(function(id) { var d = self.agents[id]; if (d && d.alive) { d.alive = false; d.diedAt = now; } self.ev.deaths.push({ t: now, id: id }); });
    }
    if (f.st) for (i = 0; i < f.st.length; i++) { var s = this.structs[f.st[i][0]]; if (s) { s.hp = f.st[i][1]; s.dead = !!f.st[i][2]; } }
    if (f.cnt) this.cnt = f.cnt;
    if (f.cap) { this.cap = { prog: f.cap.prog, status: f.cap.status, cnt: f.cap.cnt }; if (f.cap.need) this.capNeed = f.cap.need; }
    if (f.dist) for (i = 0; i < f.dist.length && i < this.districts.length; i++) { this.districts[i].by = f.dist[i][0]; this.districts[i].cnt = [f.dist[i][1], f.dist[i][2]]; }
    if (f.fog) { unrle(f.fog, this.seen[this.side]); this.fogN++; }
    if (f.sq) this.teams[this.side].squads = f.sq;
    if (f.over != null) { this.over = f.over; this.why = f.why || ''; }
    while (this.ev.shots.length > 600) this.ev.shots.shift();
  };
  // Плавное движение: своё время отстаёт от сервера на DELAY; враг, пропавший из виду, скрывается
  Mirror.prototype.step = function(dt) {
    var target = this.srvT + (Date.now() - this.at) / 1000 - DELAY;
    this.t += dt; if (Math.abs(this.t - target) > 0.5) this.t = target; else this.t += (target - this.t) * 0.1;
    var t = this.t, ag = this.agents;
    for (var i = 0; i < ag.length; i++) {
      var a = ag[i]; if (!a) continue;
      if (!a.alive) { if (!a.gone && t - a.diedAt > 40) a.gone = true; continue; }
      if (a.k0 && a.k1) {
        var k = a.k1.T > a.k0.T ? (t - a.k0.T) / (a.k1.T - a.k0.T) : 1; k = Math.max(0, Math.min(1, k));
        var nx = a.k0.x + (a.k1.x - a.k0.x) * k, ny = a.k0.y + (a.k1.y - a.k0.y) * k;
        if (a.mv) { a.phase = (a.phase + dt * (a.T.vehicle ? 5 : 7)) % TAU; var ddx = nx - a.x, ddy = ny - a.y; if (ddx * ddx + ddy * ddy > 1e-6) a.legs = Math.atan2(ddy, ddx); }
        a.x = nx; a.y = ny;
      }
      if (a.hero && a.hero.actT > 0) { a.hero.k = Math.min(1, a.hero.k + dt * 1.8); }
    }
    while (this.ev.shots.length && t - this.ev.shots[0].t > 1.5) this.ev.shots.shift();
    while (this.ev.booms.length && t - this.ev.booms[0].t > 3) this.ev.booms.shift();
    while (this.ev.deaths.length && t - this.ev.deaths[0].t > 5) this.ev.deaths.shift();
    while (this.ev.fx.length && t - this.ev.fx[0].t > 15) this.ev.fx.shift();
    while (this.ev.shells.length && t - this.ev.shells[0].t1 > 2) this.ev.shells.shift();
  };

  return { Viewer: Viewer, Mirror: Mirror, rle: rle, unrle: unrle, DELAY: DELAY, FRAME_EVERY: FRAME_EVERY };
});
