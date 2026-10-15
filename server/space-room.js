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

var SEAT_HOLD = 90e3;       // место ушедшего игрока ждёт его полторы минуты

function SpaceRoom(name, code, scen, cfg) {
  this.kind = 'space';
  this.name = name; this.code = code; this.scen = scen; this.cfg = cfg || null; this.speed = 1;
  this.clients = [];
  this.seats = [null, null];          // { user, nick, left } — кто играет за сторону
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
  for (var i = 0; i < this.clients.length; i++) this.clients[i].viewer = new Net.Viewer(B, this.clients[i].side);
  this.syncAi();
};

// абордаж за сторону без игрока решает ИИ
SpaceRoom.prototype.syncAi = function() {
  for (var s = 0; s < 2; s++) {
    var here = this.clients.some(function(c) { return c.side === s && !c.spectator; });
    this.B.aiBoard[s] = !here;
    // стороны нет — её корабли ведёт ИИ (свой курс, «стоять» и щиты игрока снимаются)
    if (!here) this.B.ships.forEach(function(sh) { if (sh.side === s && !sh.dead) { sh.ai = true; sh.order = null; sh.focusAuto = true; sh.foeT = null; } });
  }
};

SpaceRoom.prototype.seatFor = function(c, want) {
  var now = Date.now(), user = c.who.user, i;
  // в замерах (RT_DEV) у всех один «dev»: сторону выбирает сам игрок
  if (user === 'dev') return want === 1 ? 1 : 0;
  for (i = 0; i < 2; i++) if (this.seats[i] && this.seats[i].user === user) return i;       // вернулся
  for (i = 0; i < 2; i++) if (this.seats[i] && this.seats[i].left && now - this.seats[i].left > SEAT_HOLD) this.seats[i] = null;
  if ((want === 0 || want === 1) && !this.seats[want]) return want;
  if (!this.seats[c.who.side]) return c.who.side;
  if (!this.seats[1 - c.who.side]) return 1 - c.who.side;
  return -1;
};

SpaceRoom.prototype.join = function(c, want) {
  var side = this.seatFor(c, want);
  if (side < 0) {
    c.spectator = true; c.side = 0;
    c.ws.send(JSON.stringify({ t: 'error', msg: 'В комнате уже двое игроков' }));
    c.ws.close(4005);
    return false;
  }
  c.side = side;
  if (c.who.user !== 'dev') this.seats[side] = { user: c.who.user, nick: c.who.nick, left: 0 };
  // второе окно того же игрока: старое отключаем
  for (var i = this.clients.length - 1; i >= 0; i--) {
    var o = this.clients[i];
    if (o.who && o.who.user === c.who.user && c.who.user !== 'dev') { o.ws.send(JSON.stringify({ t: 'error', msg: 'Этот бой открыт в другой вкладке' })); o.ws.close(4006); this.clients.splice(i, 1); }
  }
  this.clients.push(c);
  c.viewer = new Net.Viewer(this.B, side);
  this.syncAi();
  this.hello(c);
  this.roster();
  return true;
};

SpaceRoom.prototype.leave = function(c) {
  var i = this.clients.indexOf(c);
  if (i >= 0) this.clients.splice(i, 1);
  var s = this.seats[c.side];
  var still = this.clients.some(function(o) { return o.who && c.who && o.who.user === c.who.user; });
  if (s && c.who && s.user === c.who.user && !still) s.left = Date.now();
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
  var seats = this.seats.map(function(s, i) {
    var on = self.clients.some(function(c) { return c.side === i; });
    return { on: on, nick: s ? s.nick : '', away: !!(s && !on && s.left && now - s.left < SEAT_HOLD) };
  });
  var msg = JSON.stringify({ t: 'roster', seats: seats });
  this.clients.forEach(function(c) { self.send(c, msg); });
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
