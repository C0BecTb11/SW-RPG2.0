// Космический бой на сервере: тестовая комната на двоих.
// Имя комнаты — «sp:КОД:БОЙ» (например sp:k7m2q:vp). Первый вошедший берёт свою
// сторону (или ту, что просил), второй — оставшуюся. Пока стороны нет, за неё
// воюет ИИ (корабли, пушки и абордаж); игрок вернулся — управление снова его.
// Сервер считает бой целиком; игрокам уходит только то, что их сторона видит.

'use strict';

var fs = require('fs');
var path = require('path');
var SWRT = require('../shared/rt-core.js');
var SWShip = require('../shared/rt-ship.js');
var SWSpace = require('../shared/rt-space.js');
var Net = require('../shared/rt-space-net.js');
var FIG = require('../shared/rt-figures.js').SWRTFig;
var Army = require('../shared/rt-army.js');

var ALL = FIG.withCrew(SWRT.TYPES);
var FIG_IDS = ALL.map(function(t) { return t.id; });
var PLANS = {};
function plan(id) {
  if (!PLANS[id]) PLANS[id] = SWShip.load(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'shared', 'ships', id + '.json'), 'utf8')));
  return PLANS[id];
}

var SEAT_HOLD = 90e3;       // место ушедшего игрока ждёт его полторы минуты (потом его корабли можно передать)
var SIDE_MAX = 3;           // игроков на сторону: союзники приходят на помощь

// Места: на каждой стороне до SIDE_MAX игроков, у каждого свои корабли (sh.owner = user).
// Ушёл — его корабли держат позицию; вернулся — снова его.
function SpaceRoom(name, code, scen, cfg) {
  this.kind = 'space';
  this.name = name; this.code = code; this.scen = scen; this.cfg = cfg || null; this.speed = 1;
  this.clients = [];
  this.seats = [[], []];              // [{ user, nick, left }] — кто играет за сторону
  this.tickN = 0; this.bytes = 0; this.bytesRate = 0; this.rateAt = Date.now();
  this.newBattle();
}

SpaceRoom.prototype.newBattle = function() {
  // свой бой создателя комнаты или бой из списка
  var ships = this.cfg ? Net.layout(this.cfg) : Net.SCEN[this.scen].ships, fill = this.cfg ? this.cfg.fill : 1;
  var B = new SWSpace.Battle({ seed: 1977 + Math.floor(Math.random() * 100000), aiBoard: [true, true] });
  ships.forEach(function(s) {
    var p = plan(s[0]);
    // пока бой по сети — тестовый: типовой трюм и ангар (свой флот из игры — следующий шаг)
    B.addShip({ cls: s[0], plan: p, side: s[1], x: s[2], y: s[3], hd: s[1] === 0 ? 0 : Math.PI, figMap: FIG.crewFigs(p.faction, ALL), figIds: FIG_IDS,
                army: Army.typicalArmy(s[0], fill), name: Army.shipName(s[0]) });
  });
  this.B = B; this.round = (this.round || 0) + 1;
  this.battle = { tick: 0 };                       // для общего цикла сервера (index.js)
  // реванш: давно ушедшие места снимаются, корабли раздаются — сначала тем, кто в бою
  var self = this;
  for (var side = 0; side < 2; side++) {
    this.seats[side] = this.seats[side].filter(function(o) { return !self.expired(o); });
    var order = this.seats[side].filter(function(o) { return self.here(o.user); }).concat(this.seats[side].filter(function(o) { return !self.here(o.user); }));
    for (var k = 0; k < order.length; k++) this.giveShips(order[k], side);
  }
  for (var i = 0; i < this.clients.length; i++) this.clients[i].viewer = new Net.Viewer(B, this.clients[i].side, this.clients[i].who.user);
  this.syncAi();
};

SpaceRoom.prototype.here = function(user) { return this.clients.some(function(c) { return c.who && c.who.user === user && !c.spectator; }); };
SpaceRoom.prototype.seatOf = function(user) {
  for (var s = 0; s < 2; s++) for (var i = 0; i < this.seats[s].length; i++) if (this.seats[s][i].user === user) return { side: s, seat: this.seats[s][i] };
  return null;
};
// давно ушедший (дольше SEAT_HOLD) — его место можно занять, а корабли передать
SpaceRoom.prototype.expired = function(st) { return !!st.left && !this.here(st.user) && Date.now() - st.left > SEAT_HOLD; };

// Сторона без игроков вовсе (тест на одного) — её ведёт ИИ целиком. У стороны с игроками:
// корабли того, кто в бою, — его; ушедшего — держат позицию (стоят, бьют подошедших,
// абордаж не начинают; идущий абордаж и оборона — сами); «dev» (замеры) ведёт всю сторону.
SpaceRoom.prototype.syncAi = function() {
  var B = this.B, self = this;
  // оборону корабля ведёт игрок, только пока его хозяин в бою; ушёл — ИИ (как и курс)
  if (!B.defHuman) B.defHuman = function(sh) { return !!(sh.owner && self.here(sh.owner)) && !B.aiBoard[sh.side]; };
  for (var s = 0; s < 2; s++) {
    var dev = this.clients.some(function(c) { return c.side === s && c.who && c.who.user === 'dev'; });
    var seated = this.seats[s].length > 0;
    B.aiBoard[s] = !dev && !seated;
    B.ships.forEach(function(sh) {
      if (sh.side !== s || sh.dead) return;
      if (dev) { if (sh.guard) { sh.guard = false; sh.ai = true; } return; }
      if (sh.owner && self.here(sh.owner)) return;                        // хозяин в бою
      if (sh.owner || seated) { if (!sh.guard) B.guard(sh.n, true); return; }   // хозяин отошёл
      sh.guard = false; sh.ai = true; sh.order = null; sh.focusAuto = true;     // никого не было — ИИ
    });
  }
};

// Раздать игроку корабли его стороны: ничьи; иначе корабли давно ушедшего; иначе половину
// у того, у кого их больше всех (тестовые комнаты; в игре корабли — из флота игрока)
SpaceRoom.prototype.giveShips = function(seat, side) {
  var B = this.B, user = seat.user, self = this, got = [];
  var mine = function(sh) { return sh.side === side && !sh.dead; };
  B.ships.forEach(function(sh) { if (mine(sh) && !sh.owner) { sh.owner = user; sh.guard = false; got.push(sh); } });
  if (!got.length) {
    var gone = this.seats[side].filter(function(o) { return o.user !== user && self.expired(o); });
    gone.forEach(function(o) {
      B.ships.forEach(function(sh) { if (mine(sh) && sh.owner === o.user) { sh.owner = user; sh.guard = false; got.push(sh); } });
      self.seats[side].splice(self.seats[side].indexOf(o), 1);
    });
  }
  if (!got.length) {
    var by = {}, top = null;
    B.ships.forEach(function(sh) { if (mine(sh) && sh.owner && sh.owner !== user) (by[sh.owner] = by[sh.owner] || []).push(sh); });
    for (var u in by) if (!top || by[u].length > by[top].length) top = u;
    if (top && by[top].length >= 2) by[top].slice(Math.ceil(by[top].length / 2)).forEach(function(sh) { sh.owner = user; sh.guard = false; got.push(sh); });
  }
  return got;
};

// Раз в несколько секунд: место ушедшего дольше SEAT_HOLD снимается. Его корабли —
// союзнику в бою (у кого меньше кораблей); на стороне никого — сторону снова ведёт ИИ
SpaceRoom.prototype.expire = function() {
  var B = this.B, self = this, changed = false;
  for (var s = 0; s < 2; s++) {
    var gone = this.seats[s].filter(function(o) { return self.expired(o); });
    if (!gone.length) continue;
    var present = this.seats[s].filter(function(o) { return self.here(o.user); });
    gone.forEach(function(o) {
      var ships = B.ships.filter(function(sh) { return sh.owner === o.user && !sh.dead; });
      ships.forEach(function(sh) {
        if (!present.length) { sh.owner = null; return; }
        var best = present[0], bn = 1e9;
        present.forEach(function(p) { var n = B.ships.filter(function(x) { return x.owner === p.user && !x.dead; }).length; if (n < bn) { bn = n; best = p; } });
        sh.owner = best.user; sh.guard = false;
        self.clients.forEach(function(c) { if (c.who && c.who.user === best.user) self.send(c, JSON.stringify({ t: 'note', msg: o.nick + ' не вернулся — под твоей командой ' + sh.name })); });
      });
      self.seats[s].splice(self.seats[s].indexOf(o), 1); changed = true;
    });
  }
  if (changed) { this.syncAi(); this.roster(); }
};

SpaceRoom.prototype.seatFor = function(c, want) {
  var user = c.who.user, self = this;
  // в замерах (RT_DEV) «dev» — без места: сторону выбирает сам, ведёт все её корабли
  if (user === 'dev') return want === 1 ? 1 : 0;
  var was = this.seatOf(user); if (was) return was.side;                  // вернулся
  var room = function(s) { return self.seats[s].filter(function(o) { return !self.expired(o); }).length < SIDE_MAX; };
  if ((want === 0 || want === 1) && room(want)) return want;
  if (room(c.who.side)) return c.who.side;
  if (room(1 - c.who.side)) return 1 - c.who.side;
  return -1;
};

SpaceRoom.prototype.join = function(c, want) {
  var side = this.seatFor(c, want);
  if (side < 0) {
    c.spectator = true; c.side = 0;
    c.ws.send(JSON.stringify({ t: 'error', msg: 'В бою уже по ' + SIDE_MAX + ' игрока на сторону' }));
    c.ws.close(4005);
    return false;
  }
  c.side = side;
  // второе окно того же игрока: старое отключаем
  for (var i = this.clients.length - 1; i >= 0; i--) {
    var o = this.clients[i];
    if (o.who && o.who.user === c.who.user && c.who.user !== 'dev') { o.ws.send(JSON.stringify({ t: 'error', msg: 'Этот бой открыт в другой вкладке' })); o.ws.close(4006); this.clients.splice(i, 1); }
  }
  var given = [];
  if (c.who.user !== 'dev') {
    var was = this.seatOf(c.who.user);
    if (was) was.seat.left = 0;
    else { var seat = { user: c.who.user, nick: c.who.nick, left: 0 }; this.seats[side].push(seat); given = this.giveShips(seat, side); }
  }
  this.clients.push(c);
  c.viewer = new Net.Viewer(this.B, side, c.who.user);
  this.syncAi();
  this.hello(c);
  // союзнику передали корабли — хозяину сообщить; не досталось — пусть знает, что смотрит
  if (!given.length && c.who.user !== 'dev' && !this.B.ships.some(function(sh) { return sh.owner === c.who.user && !sh.dead; }))
    this.send(c, JSON.stringify({ t: 'note', msg: 'Свободных кораблей на твоей стороне нет — смотришь бой союзника' }));
  if (given.length) {
    var names = given.map(function(sh) { return sh.name; }).join(', '), self = this;
    this.clients.forEach(function(x) { if (x !== c && x.side === side) self.send(x, JSON.stringify({ t: 'note', msg: 'Союзник ' + (c.who.nick || '') + ' в бою: под его командой — ' + names })); });
  }
  this.roster();
  return true;
};

SpaceRoom.prototype.leave = function(c) {
  var i = this.clients.indexOf(c);
  if (i >= 0) this.clients.splice(i, 1);
  var was = c.who && this.seatOf(c.who.user);
  if (was && !this.here(c.who.user)) was.seat.left = Date.now();
  this.syncAi();
  this.roster();
};

// Начало связи (и новый бой): что за бой, чья сторона, корабли
SpaceRoom.prototype.hello = function(c) {
  var B = this.B;
  this.send(c, JSON.stringify({
    t: 'hello', code: this.code, scen: this.scen, cfg: this.cfg, side: c.side, spd: this.speed, round: this.round, T: B.t, over: B.over,
    ships: B.ships.map(function(s) { return [s.cls, s.side]; })
  }));
};
SpaceRoom.prototype.roster = function() {
  var self = this, now = Date.now();
  // по сторонам: кто в бою, кто отошёл; чей корабль — для подписи
  var seats = [0, 1].map(function(s) {
    return self.seats[s].map(function(o) { var on = self.here(o.user); return { nick: o.nick, on: on, away: !on && !!o.left && now - o.left < SEAT_HOLD, user: o.user }; });
  });
  var own = this.B.ships.map(function(sh) { var o = sh.owner && self.seatOf(sh.owner); return o ? o.seat.nick || '?' : ''; });
  this.clients.forEach(function(c) {
    var me = c.who && c.who.user;
    var mk = function(list) { return list.map(function(o) { return { nick: o.nick, on: o.on, away: o.away, me: o.user === me }; }); };
    self.send(c, JSON.stringify({ t: 'roster', seats: [mk(seats[0]), mk(seats[1])], own: own }));
  });
};
SpaceRoom.prototype.send = function(c, data) {
  // медленная связь: кадры пропускаем (каждый лёгкий кадр — полный), копоть потом заново
  if (c.ws.bufferedAmount > 1048576) { if (c.viewer) c.viewer.lost(); return; }
  var n = typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength;
  this.bytes += n; c.bytes = (c.bytes || 0) + n;
  c.ws.send(data);
};

SpaceRoom.prototype.step = function() {
  var B = this.B, i, j;
  for (var k = 0; k < this.speed && B.over < 0; k++) {
    B.tick(SWSpace.TICK);
    if (k < this.speed - 1) { var e0 = B.takeEvents(); for (i = 0; i < this.clients.length; i++) if (this.clients[i].viewer) this.clients[i].viewer.push(e0); }
  }
  if (B.over >= 0 && !this.overAt) this.overAt = Date.now();
  this.tickN++; this.battle.tick = this.tickN;
  if (this.tickN % 50 === 0) this.expire();
  var ev = B.takeEvents();
  for (i = 0; i < this.clients.length; i++) {
    var c = this.clients[i]; if (!c.viewer) continue;
    c.viewer.push(ev); c.viewer.spd = this.speed;
    var fr = c.viewer.frames(this.tickN);
    for (j = 0; j < fr.length; j++) this.send(c, fr[j]);
  }
  var now = Date.now();
  if (now - this.rateAt >= 2000) { this.bytesRate = this.bytes / ((now - this.rateAt) / 1000); this.bytes = 0; this.rateAt = now; }
};

SpaceRoom.prototype.command = function(c, m) {
  if (!c.viewer || c.spectator) return;
  if (m.t === 'cmd') { c.viewer.command(m); return; }
  // замеры (RT_DEV): подвести врага, прогнать бой вперёд
  if (m.t === 'dbg' && this.dev) {
    var B = this.B, me = B.ships.filter(function(x) { return x.side === c.side && !x.dead; })[0], foe = B.ships.filter(function(x) { return x.side !== c.side && !x.dead; })[0];
    if (m.k === 'near' && me && foe) { foe.x = me.x + 2600; foe.y = me.y + 300; foe.sh = [0, 0, 0, 0]; B.sense(); }
    if (m.k === 'fboard' && me && foe) B.forceBoard(me.n, foe.n, 30);
    if (m.k === 'fast') for (var i = 0; i < Math.min(3000, m.n | 0) && B.over < 0; i++) B.tick(SWSpace.TICK);
    return;
  }
  // скорость боя: пауза, ×1, ×2, ×4 — для обоих игроков
  if (m.t === 'speed') {
    var v = m.v | 0; if (v !== 0 && v !== 1 && v !== 2 && v !== 4) return;
    var now = Date.now();
    if (now - (this.speedAt || 0) < 1500) return;          // не чаще раза в полторы секунды
    // большой бой (больше двух кораблей) — не быстрее ×2: сервер один на всех
    if (v === 4 && this.B.ships.length > 2) v = 2;
    this.speedAt = now; this.speed = v;
    var who = c.who && c.who.nick ? c.who.nick : (c.side === 0 ? 'Республика' : 'КНС');
    var msg = JSON.stringify({ t: 'note', msg: (v === 0 ? 'Пауза' : 'Скорость ×' + v) + ' · ' + who });
    var self = this; this.clients.forEach(function(x) { self.send(x, msg); });
    return;
  }
  if (m.t === 'again') {
    // реванш — только когда бой окончен
    if (this.B.over < 0) return;
    this.overAt = 0; this.speed = 1;
    this.newBattle();
    var self = this;
    this.clients.forEach(function(x) { self.hello(x); });
    this.roster();
  }
};

SpaceRoom.prototype.busy = function() { return this.clients.length && this.B.over < 0 ? 1 : 0; };
SpaceRoom.prototype.info = function() {
  return { room: this.name, clients: this.clients.length, ships: this.B.ships.length, t: Math.round(this.B.t), over: this.B.over,
           bytesPerClient: Math.round(this.bytesRate / Math.max(1, this.clients.length)) };
};

// «sp:код:бой» → комната или ошибка
function parse(name) {
  var m = /^sp:([a-z0-9]{3,12}):([a-z0-9]{2,4})$/i.exec(name);
  if (!m || !Object.prototype.hasOwnProperty.call(Net.SCEN, m[2])) return null;
  return { code: m[1].toLowerCase(), scen: m[2], key: 'sp:' + m[1].toLowerCase() };
}

module.exports = { SpaceRoom: SpaceRoom, parse: parse, plan: plan, cfgClean: Net.cfgClean };
