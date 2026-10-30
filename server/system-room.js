// Орбита системы в игре: комната «so:<система>». Корабли — все, что стоят на орбите в базе
// (rt_space_open), со своими трюмами и ангарами (Army.fromGame). Корабль игрока в сети —
// под его командой; хозяина нет — держит позицию и отвечает огнём (guard). Бой не «кончается»:
// корабли приходят из гиперпространства и уходят (pull раз в 5 с), снимок в базу раз в 5 с
// (rt_space_sync): корпус, щиты, клетка и разворот, бойцы на борту, машины, трофеи.
//
// Клетка орбиты в игре — 200 м (сетка 150 → 30 км); бой считает в метрах, экран — тоже.
// Спящие экипажи (dormant): корабль получает настоящий экипаж, когда по нему стреляют,
// рядом (WAKE_M) идёт бой, его смотрят изнутри или ему отдают приказ. Пока никто не
// нападает, орбита с флотами обеих фракций стоит тихо, как и в старой игре.

'use strict';

var fs = require('fs');
// Очередь на отправку игроку: больше — кадры пропускаются, потом бой целиком (медленная связь не копит минуты задержки)
var BUF_MAX = 131072;
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
function hasPlan(id) { return /^[a-z0-9_]{2,32}$/.test(String(id)) && fs.existsSync(path.join(__dirname, '..', 'shared', 'ships', id + '.json')); }

var CELL_M = 200;            // клетка орбиты игры в метрах
var SYNC_EVERY = 5000, PULL_EVERY = 5000, QUIET_MS = 180000, WAKE_M = 9000, WAKE_CRAFT_M = 5000;
var FIRE_HOLD = 30;          // секунд после попадания корабль считается «под огнём» (прыжок закрыт)
// Находка в Пустоте (sql/void_finds.sql): пираты-охрана — сторона 2. Чужой корабль ближе AGGRO к находке —
// охрана просыпается и идёт в атаку; дальше LEASH от находки за врагом не гонится — возвращается на пост
var VF_AGGRO = 7000, VF_LEASH = 10000;
// Трудность охраны — «средняя»: корпус и пушки пиратов крепче своего класса (подобрано боями 4 Акламаторов против охраны)
var VF_HP = +(process.env.VF_HP || 2), VF_DMG = +(process.env.VF_DMG || 1.8);

// отпечаток улучшений корабля: что даёт верфь
function upgKey(s) { return [s.bonus_hp, s.bonus_shield, s.bonus_damage, s.bonus_move, s.bonus_vision, s.bonus_fore, (s.upgrades || []).join('|')].join(','); }
function sideOf(faction) { return faction === 'cis' ? 1 : 0; }
function boxOf(type, facing) {
  var w = type ? type.width_cells || 1 : 1, h = type ? type.height_cells || 1 : 1;
  return (facing === 90 || facing === 270) ? { w: h, h: w } : { w: w, h: h };
}
// разворот игры (0 — носом вверх, 90 — вправо) ↔ курс боя (0 — вправо, по часовой)
function hdOf(facing) { return ((facing || 0) - 90) * Math.PI / 180; }
function facingOf(hd) { var d = Math.round(hd * 180 / Math.PI + 90); d = ((d % 360) + 360) % 360; return Math.round(d / 90) * 90 % 360; }

function SystemRoom(name, system, cfg) {
  this.kind = 'system'; this.name = name; this.system = system; this.cfg = cfg;
  this.clients = []; this.waiting = []; this.ready = false; this.closed = false; this.failed = null;
  this.ms = []; this.bytes = 0; this.bytesRate = 0; this.rateAt = Date.now(); this.tickN = 0;
  this.battle = { tick: 0 }; this.speed = 1;
  this.byId = {};              // id корабля в игре → n в бою
  this.free = {};              // id истребителя на орбите → малый корабль боя
  this.unitHp = {};            // id бойца → последний записанный hp
  this.craftHp = {};
  this.lastSync = {};
  this.okHp = {};               // id → корпус, который точно лежит в базе (загружен или записан успешно)
  this.upg = {};               // id корабля → отпечаток улучшений (модернизация на верфи — подхватить на ходу)
  this.hitAt = {};             // n → время последнего попадания (бой)
  this.syncAt = Date.now(); this.pullAt = Date.now(); this.quietSince = Date.now(); this.emptySince = Date.now(); this.created = Date.now();
  var self = this;
  this.open().then(function() { self.ready = true; self.waiting.forEach(function(c) { self.admit(c); }); self.waiting = []; },
                   function(e) { self.failed = e.message || String(e); self.cfg.log('error', 'комната системы не открылась', { room: name, err: self.failed }); self.waiting.forEach(function(c) { c.ws.send(JSON.stringify({ t: 'error', msg: 'Орбита не открылась: ' + self.failed })); c.ws.close(4007); }); self.waiting = []; self.closed = true; });
}

SystemRoom.prototype.rpc = function(fn, args) { args = args || {}; args.p_key = this.cfg.key; return this.cfg.rpc(fn, args); };

// ---- открытие
SystemRoom.prototype.open = function() {
  var self = this;
  return this.rpc('rt_space_open', { p_system: this.system }).then(function(st) {
    if (!st || !st.battle_id || !st.system) throw new Error('база не вернула систему');
    self.battleId = st.battle_id; self.state = st;
    self.types = {}; (st.types || []).forEach(function(t) { self.types[t.id] = t; });
    self.grid = (st.settings && st.settings.grid) || 150;
    // туман войны: враг виден в дальности датчиков своих кораблей, истребителей и станции (и по вспышкам
    // главного калибра); «засечек» на месте, где видели, игрокам орбиты не шлём
    var B = new SWSpace.Battle({ seed: 1977 + Math.floor(Math.random() * 100000), aiBoard: [false, false], endless: true, fog: true });
    B.seenOnly = true;                               // ИИ кораблей — по тому, что видят датчики, и назад на место после боя
    B.defHuman = function(sh) { return !!(sh.owner && self.here(sh.owner)); };
    // притягивающий луч не затаскивает цель в чужую для неё полосу гиперпространства (как приказы — clampY);
    // уже там — тянуть можно только наружу
    B.pullOk = function(sh, x, y) { var c = self.clampY(sh.side, y); return c === y || Math.abs(y - c) < Math.abs(sh.y - self.clampY(sh.side, sh.y)); };
    // кто пошёл на абордаж — тому и трофей
    var board0 = B.board;
    B.board = function(n, t, all, now) { var r = board0.call(B, n, t, all, now); if (r && r.ok && B.ships[t]) B.ships[t].boardBy = B.ships[n].owner || null; return r; };
    self.B = B;
    self.setEyes();
    self.stKey = stationKey(st.station);
    self.applyShips(st.ships || []);
    self.applyFind(st.find || null);
    self.cfg.log('info', 'орбита открыта', { room: self.name, battle: self.battleId, ships: B.ships.length, system: st.system.faction });
  });
};

// Станция видит вокруг себя — для своей стороны (готовая; строящаяся ещё слепа)
var STATION_SENS = SWSpace.SENS_STATION;     // станция видит на 8 км (shared/rt-space.js)
SystemRoom.prototype.setEyes = function() {
  var st = this.state && this.state.station, sl = this.state && this.state.slot;
  this.B.eyes = st && st.ready && st.faction ? [[sideOf(st.faction), ((st.x != null ? st.x : sl.x) + (st.size || sl.size) / 2) * CELL_M, ((st.y != null ? st.y : sl.y) + (st.size || sl.size) / 2) * CELL_M, STATION_SENS]] : [];
};
// Станция под туманом войны (решение Артёма, 30.10): чужая сторона не знает, что стоит на месте станции,
// пока её корабль или истребитель не подойдёт к месту на дальность своих датчиков. Знают всегда: хозяева
// планеты и хозяева станции. Не знающим место приходит без станции и с пометкой fog — пустое место
// и чужая станция для них выглядят одинаково, так что туман ничего не выдаёт.
function stationKey(stn) { return stn ? stn.id + '|' + (stn.ready === false ? 0 : 1) + '|' + stn.faction : ''; }
function sideOfKnown(f) { return f === 'republic' ? 0 : f === 'cis' ? 1 : -1; }
SystemRoom.prototype.slotKnown = function(side) {
  var st = this.state || {}, stn = st.station;
  if (st.system && sideOfKnown(st.system.faction) === side) return true;
  if (stn && sideOfKnown(stn.faction) === side) return true;
  return !!(this.slotSeen && this.slotSeen[side]);
};
SystemRoom.prototype.stationView = function(side) {
  var st = this.state || {}, known = this.slotKnown(side);
  return { station: known ? (st.station || null) : null, fog: !known && !!st.slot };
};
SystemRoom.prototype.sendStation = function(side) {
  var v = this.stationView(side), msg = JSON.stringify({ t: 'station', station: v.station, fog: v.fog }), self = this;
  this.clients.forEach(function(c) { if (c.viewer && c.side === side) self.send(c, msg); });
};
// раз в 10 тактов: подошёл ли кто-то из не знающих к месту станции
SystemRoom.prototype.slotSight = function() {
  var st = this.state, sl = st && st.slot, B = this.B; if (!sl || !B) return;
  var cx = (sl.x + sl.size / 2) * CELL_M, cy = (sl.y + sl.size / 2) * CELL_M, rr = sl.size * CELL_M / 2, side, i;
  for (side = 0; side < 2; side++) {
    if (this.slotKnown(side)) continue;
    var seen = false;
    for (i = 0; i < B.ships.length && !seen; i++) {
      var o = B.ships[i]; if (o.dead || o.side !== side) continue;
      var r = B.sensRange(o) + rr, dx = o.x - cx, dy = o.y - cy;
      if (dx * dx + dy * dy < r * r) seen = true;
    }
    for (i = 0; i < B.craft.length && !seen; i++) {
      var k = B.craft[i]; if (k.dead || k.side !== side) continue;
      var r2 = CRAFT_SENS + rr, ex = k.x - cx, ey = k.y - cy;
      if (ex * ex + ey * ey < r2 * r2) seen = true;
    }
    if (seen) { (this.slotSeen = this.slotSeen || {})[side] = true; this.sendStation(side); }
  }
};
// станцию построили, достроили, снесли или захватили — всем, кто имеет право знать; разведка места — заново
SystemRoom.prototype.stationChanged = function() {
  var key = stationKey(this.state && this.state.station);
  if (key === this.stKey) return;
  var idOld = (this.stKey || '').split('|')[0], idNew = key.split('|')[0];
  this.stKey = key;
  if (idOld !== idNew) this.slotSeen = {};
  this.sendStation(0); this.sendStation(1);
};
var CRAFT_SENS = 3500;                       // датчики истребителя (shared/rt-space.js, sense)

// Корабли из базы → бой. Повторный вызов (pull) добавляет прибывших и убирает ушедших.
// base — корпуса, которые лежали в базе к моменту запроса (pull): рост сверх них — ремонт в доке
SystemRoom.prototype.applyShips = function(list, base) {
  var B = this.B, self = this, seen = {}, added = [];
  list.forEach(function(s) {
    seen[s.id] = 1;
    var n = self.byId[s.id], old = n != null ? B.ships[n] : null;
    if (old && !old.dead) {
      // корпус подрос в доке (ремонт) — подхватить; хозяин сменился — пересоздать
      var type0 = self.types[s.ship_type], max0 = type0 ? (type0.max_hp || 0) + (s.bonus_hp || 0) : 0;
      // ремонт — только если в базе больше, чем было в ней на момент запроса: старый снимок (запись ещё
      // не дошла или упала) — не ремонт, иначе урон последних секунд откатывался бы
      var b0 = base && base[s.id] != null ? base[s.id] : self.okHp[s.id];
      if (max0 && b0 != null && s.hp > b0) { old.hull = Math.min(old.hullMax, Math.max(old.hull, old.hullMax * s.hp / max0)); self.okHp[s.id] = s.hp; }
      if (old.faction !== s.faction || old.owner !== (s.owner_user_id || null)) { old.dead = true; old.why = 'left'; old.deadAt = B.t; delete self.byId[s.id]; }
      else {
        // верфь поставила улучшения — корабль в бою меняется сразу (корпус, щиты, орудия, ход, сонар)
        var uk = upgKey(s);
        if (self.upg[s.id] != null && self.upg[s.id] !== uk && type0) {
          B.refitShip(old.n, Army.fromGame(s, type0, [], [], {}));
          var rmsg = JSON.stringify({ t: 'refit', n: old.n, hm: Math.round(old.hullMax), sm: Math.round(old.shMax * 100) / 100, fk: old.foreK || 1, tb: old.tractor ? 1 : 0 });
          self.clients.forEach(function(c) { self.send(c, rmsg); });
          self.cfg.log('info', 'корабль модернизирован', { room: self.name, ship: s.id, type: s.ship_type });
        }
        self.upg[s.id] = uk; old.bon0 = bonOf(s);
        self.syncUnits(old, s); return;
      }
    } else if (old) { if (old.captured < 0 && old.why !== 'left') return; delete self.byId[s.id]; }   // погиб в бою — строка с hp 0 ещё лежит
    var type = self.types[s.ship_type] || null;
    if (type && type.is_fighter) { self.addFree(s, type); return; }
    if (!hasPlan(s.ship_type)) { self.cfg.log('warn', 'нет плана корабля', { type: s.ship_type }); return; }
    var p = plan(s.ship_type);
    var army = Army.fromGame(s, type, s.units || [], s.craft || [], { regenSec: (self.state.settings && self.state.settings.regen) || 30 });
    var box = boxOf(type, s.facing), side = sideOf(s.faction), pose = self.poseOf(s, type);
    var sh = B.addShip({ cls: s.ship_type, plan: p, side: side,
                         x: pose ? pose.x : (s.x + box.w / 2) * CELL_M, y: pose ? pose.y : (s.y + box.h / 2) * CELL_M, hd: pose ? pose.hd : hdOf(s.facing),
                         figMap: FIG.crewFigs(p.faction, ALL), figIds: FIG_IDS, army: army, name: army.name, id: s.id, owner: s.owner_user_id || null,
                         faction: s.faction, dormant: true, stands: s.troop_posts && typeof s.troop_posts === 'object' ? s.troop_posts : null });
    sh.gameId = s.id; sh.trophy = !!s.trophy; sh.commander = s.commander_id || null; sh.bon0 = bonOf(s);
    sh.units = (s.units || []).map(function(u) { return { id: u.id, hpMax: u.hp }; });
    sh.craftIds = hangarIds(s.craft);
    self.byId[s.id] = sh.n; self.lastSync[s.id] = null; self.okHp[s.id] = s.hp; self.upg[s.id] = upgKey(s);
    (s.units || []).forEach(function(u) { self.unitHp[u.id] = u.hp; });
    (s.craft || []).forEach(function(c) { self.craftHp[c.id] = c.hp; });
    added.push(sh);
  });
  // ушли (гиперпространство, погрузка в ангар, продажа): из боя — вон
  Object.keys(this.byId).forEach(function(id) {
    if (seen[id]) return;
    var sh = B.ships[self.byId[id]];
    if (sh && !sh.dead) { sh.dead = true; sh.why = 'left'; sh.deadAt = B.t; }
    delete self.byId[id];
  });
  Object.keys(this.free).forEach(function(id) {
    if (seen[id]) return;
    var c = self.free[id]; if (c && !c.dead) { c.dead = true; c.why = 'left'; }
    delete self.free[id];
  });
  if (added.length && this.ready) {
    var msg = JSON.stringify({ t: 'ships', ships: added.map(function(sh) { return self.shipRow(sh); }) });
    this.clients.forEach(function(c) { self.send(c, msg); });
    this.syncAi();
  }
  return added;
};
// Машины ангара в бою — только известных бою типов, в том же порядке, что Army.fromGame кладёт в hangar
function hangarIds(craft) { return (craft || []).filter(function(c) { return !!Army.CRAFT[c.ship_type]; }).map(function(c) { return c.id; }); }
// бонусы корпуса и щитов из исследований (щиты: 0 — нос, у него свой бонус)
function bonOf(s) { return { hp: +s.bonus_hp || 0, sh: +s.bonus_shield || 0, fore: +s.bonus_fore || 0 }; }
// Истребитель, стоящий на орбите сам по себе: в бою — малый корабль своего ближайшего крупного
SystemRoom.prototype.addFree = function(s, type) {
  var B = this.B, self = this;
  if (this.free[s.id]) return;
  var kind = Army.CRAFT[s.ship_type]; if (!kind) return;
  var side = sideOf(s.faction), x = (s.x + 0.5) * CELL_M, y = (s.y + 0.5) * CELL_M, home = -1, bd = 1e18;
  B.ships.forEach(function(sh) {
    if (sh.dead || sh.side !== side) return;
    var dx = sh.x - x, dy = sh.y - y, d = dx * dx + dy * dy - (sh.owner === s.owner_user_id ? 1e8 : 0);
    if (d < bd) { bd = d; home = sh.n; }
  });
  if (home < 0) return;                                             // без крупного корабля своей стороны — не летает
  var maxHp = type.max_hp || 90;
  var c = B.addCraft(kind, side, home, x, y, hdOf(s.facing), s.hp / maxHp);
  if (!c) return;
  c.gameId = s.id; c.gameMax = maxHp; this.free[s.id] = c; this.craftHp[s.id] = s.hp;
};
// бойцы трюма подхватываются только пока экипаж спит (бой их ещё не «взял» в тела)
SystemRoom.prototype.syncUnits = function(sh, s) {
  var self = this;
  if (!sh.dormant) return;
  var army = Army.fromGame(s, this.types[s.ship_type] || null, s.units || [], s.craft || [], { regenSec: (this.state.settings && this.state.settings.regen) || 30 });
  sh.crewOpts.roster = army.roster || []; if (sh.crew.recount) sh.crew.recount(sh.crewOpts);
  sh.hangar = (army.hangar || []).slice(); sh.vehicles = (army.vehicles || []).slice();
  sh.bay = sh.hangar.map(function(_, i) { return i; }); sh.bayHp = {};          // спит — машин в воздухе нет, все на борту
  sh.units = (s.units || []).map(function(u) { return { id: u.id, hpMax: u.hp }; });
  sh.craftIds = hangarIds(s.craft);
  (s.units || []).forEach(function(u) { self.unitHp[u.id] = u.hp; });
  (s.craft || []).forEach(function(c) { self.craftHp[c.id] = c.hp; });
};
// строка корабля для клиента: [класс, сторона, x, y, армия, курс, { id, owner, name, faction, trophy }]
SystemRoom.prototype.shipRow = function(sh) {
  // пределы корпуса и щитов (bon, foreK) — как на сервере, иначе у клиента доли выше 100 %
  var self = this, A = { roster: [], hangar: (sh.hangar || []).slice(), vehicles: (sh.vehicles || []).slice(), hpK: sh.hull / sh.hullMax, shK: [0, 1, 2, 3].map(function(i) { return sh.sh[i] / self.B.secMax(sh, i); }),
            hpBonus: sh.bon ? sh.bon.hp : 1, shBonus: sh.bon ? sh.bon.sh : 1, dmgK: 1, foreK: sh.foreK || 1, crewLost: sh.crewOpts.crewLost || 0, name: sh.name, id: sh.gameId };
  return [sh.cls, sh.side, Math.round(sh.x), Math.round(sh.y), A, Math.round(sh.hd * 1000) / 1000, { id: sh.gameId, owner: sh.owner, name: sh.name, faction: sh.faction, trophy: !!sh.trophy, n: sh.n }];
};

// ---- игроки
SystemRoom.prototype.here = function(user) { return this.clients.some(function(c) { return c.who && c.who.user === user; }); };
SystemRoom.prototype.join = function(c) {
  if (this.closed) { c.ws.send(JSON.stringify({ t: 'error', msg: 'Орбита закрыта' })); c.ws.close(4008); return false; }
  if (!this.ready) { this.waiting.push(c); return true; }
  this.admit(c);
  return true;
};
SystemRoom.prototype.admit = function(c) {
  var B = this.B, self = this;
  for (var i = this.clients.length - 1; i >= 0; i--) {
    var o = this.clients[i];
    if (o.who && o.who.user === c.who.user && c.who.user !== 'dev') { o.ws.send(JSON.stringify({ t: 'error', msg: 'Эта орбита открыта в другой вкладке' })); o.ws.close(4006); this.clients.splice(i, 1); }
  }
  c.side = c.side === 1 || (c.side !== 0 && c.who.side === 1) ? 1 : 0;
  c.viewer = new Net.Viewer(B, c.side, c.who.user);
  c.viewer.noLast = true;                         // туман без «засечек»: кого не видно — того нет
  c.viewer.sysRoom = this;
  this.clients.push(c);
  this.emptySince = 0;
  this.syncAi();
  this.send(c, JSON.stringify(this.hello(c)));
  this.cfg.log('info', 'игрок на орбите', { room: this.name, user: c.who.user, side: c.side });
};
SystemRoom.prototype.hello = function(c) {
  var B = this.B, self = this, st = this.state, sv = this.stationView(c.side);
  return {
    t: 'hello', kind: 'sys', caps: ['many'], fog: true, system: this.system, name: st.system.name, faction: st.system.faction, deep: !!st.system.deep, side: c.side, spd: 1, round: 1, T: B.t, over: -1,
    user: c.who.user,
    sc: { name: st.system.name, ships: B.ships.map(function(sh) { return self.shipRow(sh); }) },
    grid: { cells: this.grid, cellM: CELL_M, zone: (st.settings && st.settings.zone) || 14, pads: st.pads || [], slot: st.slot || null, station: sv.station, slotFog: sv.fog },
    find: this.findInfo()
  };
};
SystemRoom.prototype.leave = function(c) {
  var i = this.clients.indexOf(c);
  if (i >= 0) this.clients.splice(i, 1);
  // ушёл, пока орбита открывалась — из очереди тоже, иначе его «впустят» уже отключённым и комната не закроется
  i = this.waiting.indexOf(c); if (i >= 0) this.waiting.splice(i, 1);
  if (!this.clients.length) this.emptySince = Date.now();
  if (this.B) this.syncAi();
};
// Корабли хозяина в сети — его; без хозяина — держат позицию (guard): стоят, отвечают огнём
// хозяин корабля в сети (или замер dev за его сторону) — кораблём командует игрок
SystemRoom.prototype.ctlHere = function(sh) {
  var dev = this.clients.some(function(c) { return c.side === sh.side && c.who && c.who.user === 'dev'; });
  return dev || !!(sh.owner && this.here(sh.owner));
};
SystemRoom.prototype.syncAi = function() {
  var B = this.B, self = this;
  B.ships.forEach(function(sh) {
    if (sh.dead || sh.pirate != null) return;                 // охрану находки ведёт pirateStep
    if (self.ctlHere(sh)) { if (sh.guard) { sh.guard = false; sh.ai = false; } return; }
    if (!sh.guard) B.guard(sh.n, true);
  });
};
SystemRoom.prototype.send = function(c, data) {
  if (c.ws.bufferedAmount > BUF_MAX) { if (c.viewer) c.viewer.lost(); return; }
  var n = typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength;
  this.bytes += n; c.bytes = (c.bytes || 0) + n;
  c.ws.send(data);
};

// ---- такт
SystemRoom.prototype.step = function() {
  if (!this.ready || this.closed) return;
  var B = this.B, i, j;
  B.tick(SWSpace.TICK);
  this.dockStep();
  this.tickN++; this.battle.tick = this.tickN;
  var ev = B.takeEvents();
  var t = B.t;
  if (ev.shots.length || ev.booms.length) this.quietSince = Date.now();
  // попадания: кто под огнём (для снимка и запрета прыжка)
  for (i = 0; i < ev.shields.length; i++) this.hitAt[ev.shields[i].ship] = t;
  for (i = 0; i < ev.booms.length; i++) if (ev.booms[i].ship != null && ev.booms[i].ship >= 0) this.hitAt[ev.booms[i].ship] = t;
  for (i = 0; i < this.clients.length; i++) {
    var c = this.clients[i]; if (!c.viewer) continue;
    c.viewer.push(ev); c.viewer.spd = 1;
    var fr = c.viewer.frames(this.tickN);
    for (j = 0; j < fr.length; j++) this.send(c, fr[j]);
  }
  if (this.tickN % 10 === 0) { this.wakeStep(); this.pirateStep(); this.slotSight(); }
  var now = Date.now();
  if (now - this.rateAt >= 2000) { this.bytesRate = this.bytes / ((now - this.rateAt) / 1000); this.bytes = 0; this.rateAt = now; }
  if (now - this.syncAt >= SYNC_EVERY || ev.kills.length) this.sync();
  if (now - this.pullAt >= PULL_EVERY) this.pull();
};
// Будить спящих: враг рядом, смотрят изнутри, есть приказ
SystemRoom.prototype.wakeStep = function() {
  var B = this.B, S = B.ships, i, j;
  var viewed = {};
  this.clients.forEach(function(c) { if (c.viewer && c.viewer.view >= 0) viewed[c.viewer.view] = 1; });
  for (i = 0; i < S.length; i++) {
    var a = S[i]; if (a.dead || !a.dormant) continue;
    if (viewed[i] || a.order || a.foeT != null) { B.wake(a); continue; }
    // хозяин в сети (не «держит позицию»): враг в датчиках — пушки «сама» бьют, ИИ («Ход: сам») идёт в атаку.
    // Спящий корабль не стреляет — без этого флоты стояли бок о бок, пока игрок не отдаст приказ
    if (this.ctlHere(a) && B.aiFoe(a)) { B.wake(a); continue; }
    // рядом идёт бой (враг не спит и в дальности датчиков) — корабль просыпается и отвечает
    var near = false;
    for (j = 0; j < S.length && !near; j++) {
      var b = S[j]; if (b.dead || b.dormant || b.side === a.side) continue;
      var dx = a.x - b.x, dy = a.y - b.y;
      if (dx * dx + dy * dy < WAKE_M * WAKE_M && this.hitAt[b.n] != null && B.t - this.hitAt[b.n] < FIRE_HOLD) near = true;
    }
    for (j = 0; j < B.craft.length && !near; j++) {
      var cr = B.craft[j]; if (cr.dead || cr.idle || cr.side === a.side) continue;
      var ex = a.x - cr.x, ey = a.y - cr.y;
      if (ex * ex + ey * ey < WAKE_CRAFT_M * WAKE_CRAFT_M) near = true;
    }
    if (near) B.wake(a);
  }
};

// Точная поза из прошлой орбиты (ships.rt_x / rt_y / rt_hd, sql/rt_space_pose.sql): корабль встаёт ровно там и так,
// как его оставили. Берём её, только если она даёт ту же клетку и разворот, что в базе: иначе корабль за это
// время двигала сама игра (автоход, прыжок, верфь) — тогда по клетке, как раньше.
SystemRoom.prototype.poseOf = function(s, type) {
  var q = s.rt_pose;
  if (!Array.isArray(q) || q.length < 3 || !isFinite(+q[0]) || !isFinite(+q[1]) || !isFinite(+q[2])) return null;
  var x = +q[0], y = +q[1], hd = +q[2], fc = facingOf(hd), box = boxOf(type, fc);
  var cx = Math.max(0, Math.min(this.grid - box.w, Math.round(x / CELL_M - box.w / 2)));
  var cy = Math.max(0, Math.min(this.grid - box.h, Math.round(y / CELL_M - box.h / 2)));
  if (cx !== s.x || cy !== s.y || fc !== ((s.facing || 0) % 360)) return null;
  return { x: x, y: y, hd: hd };
};

// ---- снимок в базу
// Запись в базу — строго по очереди: два запроса вперемешку могли бы записать старое поверх нового
SystemRoom.prototype.sync = function() {
  var self = this, p = (this.syncQ || Promise.resolve()).then(function() { return self.syncNow(); });
  this.syncQ = p.catch(function() {});
  return p;
};
SystemRoom.prototype.syncNow = function() {
  var B = this.B, self = this, ships = [], craft = [], units = [], captured = [];
  this.syncAt = Date.now();
  B.ships.forEach(function(sh) {
    if (!sh.gameId || sh.why === 'left' || sh.synced) return;
    // предел — как при загрузке (Army.fromGame): тип + бонусы исследований; без бонусов корабль с ними
    // терял долю корпуса и щитов при каждом открытии орбиты
    var type = self.types[sh.cls], bo = sh.bon0 || bonOf({}), maxHp = type ? (type.max_hp || 0) + bo.hp : 0, maxSh = type ? (type.max_shield || 0) + bo.sh : 0;
    if (sh.captured >= 0 && sh.dead) {
      // трофей: хозяину абордажа; строка корабля в базе переходит, бой подхватит его заново
      if (sh.boardBy) captured.push({ id: sh.gameId, by: sh.boardBy, faction: sh.captured === 1 ? 'cis' : 'republic' });
      sh.synced = true;
      (sh.units || []).forEach(function(u) { units.push({ id: u.id, hp: 0 }); });
      return;
    }
    var box = boxOf(type, facingOf(sh.hd)), fc = facingOf(sh.hd);
    var cx = Math.max(0, Math.min(self.grid - box.w, Math.round(sh.x / CELL_M - box.w / 2)));
    var cy = Math.max(0, Math.min(self.grid - box.h, Math.round(sh.y / CELL_M - box.h / 2)));
    var hp = sh.dead ? 0 : Math.max(1, Math.round(maxHp * sh.hull / sh.hullMax));
    var shv = [0, 1, 2, 3].map(function(i) { return sh.dead ? 0 : Math.round((maxSh + (i === 0 ? bo.fore : 0)) * Math.max(0, Math.min(1, sh.sh[i] / B.secMax(sh, i)))); });
    var fire = self.hitAt[sh.n] != null && B.t - self.hitAt[sh.n] < FIRE_HOLD;
    // в притягивающем луче: база не пустит в гиперпространство, пока держат (rt_battle_guard по снимку боя)
    var hbS = B.holder(sh), held = hbS ? Math.max(1, Math.ceil(hbS.tb.until - B.t)) : 0;
    // точная поза (метры и курс) — чтобы при новом открытии орбиты корабль стоял там и так, как его оставили
    var mx = Math.round(sh.x), my = Math.round(sh.y), hd = Math.round(sh.hd * 1000) / 1000;
    var key = cx + ',' + cy + ',' + fc + ',' + hp + ',' + shv.join(',') + ',' + (fire ? 1 : 0) + ',' + (hbS ? hbS.n + ':' + Math.round(hbS.tb.until) : 0) + ',' +
              Math.round(mx / 20) + ',' + Math.round(my / 20) + ',' + Math.round(hd * 50);
    var last = self.lastSync[sh.gameId];
    if (!last || last.key !== key) { ships.push({ id: sh.gameId, x: cx, y: cy, facing: fc, hp: hp, sh: shv, fire: fire, held: held, mx: mx, my: my, hd: hd }); self.lastSync[sh.gameId] = { key: key, hp: hp }; }
    // бойцы на борту: по телам экипажа (uid), пока экипаж спит — как были
    if (sh.dead) { (sh.units || []).forEach(function(u) { if (self.unitHp[u.id] !== 0) { units.push({ id: u.id, hp: 0 }); self.unitHp[u.id] = 0; } }); sh.craftIds.forEach(function(id) { if (self.craftHp[id] !== 0) { craft.push({ id: id, hp: 0 }); self.craftHp[id] = 0; } }); sh.synced = true; return; }
    if (!sh.dormant) {
      var ag = sh.crew.agents;
      for (var i = 0; i < ag.length; i++) {
        // ушёл на шаттл (в полёте или на чужом борту) — его пишет корабль, где он сейчас; погиб в шаттле — lost
        var a = ag[i]; if (!a.uid || a.gone) continue;
        var hp0 = self.unitHpMax(sh, a.uid), v = a.alive ? Math.max(1, Math.round(hp0 * a.hp / (a.hpMax || 100))) : 0;
        if (self.unitHp[a.uid] !== v) { units.push({ id: a.uid, hp: v }); self.unitHp[a.uid] = v; }
      }
      // машины ангара: k-я строка — машина с номером k (slot, по порядку ангара в игре). На борту (bay) — жива;
      // в воздухе — жива, пока её машина в бою не сбита; ни там, ни там (сбита и убрана из списка) — погибла
      var bay = {}; (sh.bay || []).forEach(function(k) { bay[k] = 1; });
      sh.craftIds.forEach(function(id, k) {
        if (bay[k]) return;
        var c = null; for (var j = 0; j < B.craft.length; j++) { var x = B.craft[j]; if (x.home === sh.n && x.slot === k && x.gameId == null && !x.docked) { c = x; break; } }
        if ((!c || c.dead) && self.craftHp[id] !== 0) { craft.push({ id: id, hp: 0 }); self.craftHp[id] = 0; }
      });
    }
  });
  Object.keys(this.free).forEach(function(id) {
    var c = self.free[id]; if (!c || c.why === 'left') return;
    var v = c.dead ? 0 : Math.max(1, Math.round(c.gameMax * c.hp / c.max));
    if (self.craftHp[id] !== v) { craft.push({ id: id, hp: v }); self.craftHp[id] = v; }
  });
  // посты десанта поменялись (игрок поставил или снял) — в базу отдельно: ships.troop_posts
  var posts = [];
  B.ships.forEach(function(sh) { if (sh.standsDirty && sh.gameId && !sh.dead) { posts.push({ id: sh.gameId, posts: sh.stands || {} }); sh.standsDirty = false; } });
  if (posts.length) this.rpc('rt_space_posts', { p_battle: this.battleId, p_ships: posts }).catch(function(e) {
    self.cfg.log('error', 'rt_space_posts', { room: self.name, err: e.message });
    posts.forEach(function(p) { var n = self.byId[p.id]; if (n != null && B.ships[n]) B.ships[n].standsDirty = true; });
  });
  this.syncFind();
  if (!ships.length && !craft.length && !units.length && !captured.length) return Promise.resolve();
  return this.rpc('rt_space_sync', { p_battle: this.battleId, p_ships: ships, p_craft: craft, p_units: units, p_captured: captured })
    .then(function() { ships.forEach(function(r) { self.okHp[r.id] = r.hp; }); if (captured.length) self.pullAt = 0; })
    .catch(function(e) { self.cfg.log('error', 'rt_space_sync', { room: self.name, err: e.message }); ships.forEach(function(r) { delete self.lastSync[r.id]; }); });
};
// Предел здоровья бойца из базы: ищется в трюме этого корабля, затем всех остальных — десант на чужом
// борту записывает корабль-цель, а в его трюме этого бойца нет (иначе вышло бы 100 вместо настоящего)
SystemRoom.prototype.unitHpMax = function(sh, uid) {
  var list = [sh].concat(this.B.ships);
  for (var j = 0; j < list.length; j++) {
    var r = (list[j] && list[j].crewOpts && list[j].crewOpts.roster) || [];
    for (var i = 0; i < r.length; i++) if (r[i].uid === uid) return r[i].hpMax || 100;
  }
  return 100;
};
// Подхватить из базы прибывших и ушедших, ремонт; бой закрыт базой — всех вон
SystemRoom.prototype.pull = function() {
  // прошлый запрос ещё не вернулся (база медленная) — не накладывать: старый ответ поверх нового терял бы бойцов
  if (this.pulling) return Promise.resolve();
  var me = this; this.pulling = true;
  return this.pullNow().then(function(v) { me.pulling = false; return v; }, function(e) { me.pulling = false; throw e; });
};
SystemRoom.prototype.pullNow = function() {
  var self = this, base = null; this.pullAt = Date.now();
  // сначала дождаться своих записей: тогда снимок базы не старее того, что мы в неё положили
  return (this.syncQ || Promise.resolve()).then(function() {
    base = {}; for (var k in self.okHp) base[k] = self.okHp[k];
    return self.rpc('rt_space_pull', { p_battle: self.battleId, p_system: self.system });
  }).then(function(st) {
    if (!st || st.closed) { self.cfg.log('warn', 'орбита закрыта базой', { room: self.name }); self.closed = true; self.kick('Орбита закрыта'); return; }
    self.state = st;
    self.setEyes();
    self.stationChanged();
    self.applyShips(st.ships || [], base);
    self.applyFind(st.find || null);
    return self.takeOrders();
  }).catch(function(e) { self.cfg.log('error', 'rt_space_pull', { room: self.name, err: e.message }); });
};
// Приказы из игры для кораблей этой орбиты (rt_space_orders): например, рейс снабжения ведёт флот к своей
// полосе гиперпространства, пока орбиту смотрят (sql/supply_zone_live.sql). Цель — в метрах, центр корабля.
SystemRoom.prototype.takeOrders = function() {
  var self = this;
  if (this.noOrders) return Promise.resolve();
  return this.rpc('rt_space_orders_take', { p_battle: this.battleId, p_system: this.system }).then(function(list) {
    (Array.isArray(list) ? list : []).forEach(function(o) {
      var n = self.byId[o.ship_id], sh = n != null ? self.B.ships[n] : null;
      if (!sh || sh.dead || !isFinite(+o.x) || !isFinite(+o.y)) return;
      if (sh.dormant) self.B.wake(sh);
      sh.dock = null;
      self.B.order(n, +o.x, self.clampY(sh.side, +o.y), false);
    });
  }).catch(function(e) {
    // база без этой функции (старый снимок) — больше не спрашиваем до перезапуска комнаты
    if (/rt_space_orders_take|does not exist|Could not find|PGRST202/i.test(e.message || '')) self.noOrders = true;
    else self.cfg.log('warn', 'rt_space_orders_take', { room: self.name, err: e.message });
  });
};
SystemRoom.prototype.kick = function(msg) {
  this.clients.slice().forEach(function(c) { try { c.ws.send(JSON.stringify({ t: 'reset', msg: msg })); c.ws.close(4008); } catch (e) {} });
  this.clients = [];
};

// ---- приказы
// своя полоса гиперпространства (как hyperspace_side в базе): система нашей фракции — верх, чужая — низ,
// ничейная — Республика сверху, КНС снизу. В чужую полосу ход закрыт: курс прижимается к её кромке.
SystemRoom.prototype.myBand = function(side) {
  var f = side === 1 ? 'cis' : 'republic', sf = this.state && this.state.system && this.state.system.faction;
  if (!sf || sf === 'neutral') return f === 'republic' ? 'top' : 'bottom';
  return sf === f ? 'top' : 'bottom';
};
SystemRoom.prototype.clampY = function(side, y) {
  var z = ((this.state && this.state.settings && this.state.settings.zone) || 14) * CELL_M, N = this.grid * CELL_M, pad = 300;
  if (this.myBand(side) === 'top') return Math.min(y, N - z - pad);
  return Math.max(y, z + pad);
};
// ---- площадки сброса: погрузка и высадка только оттуда (is_in_orbital_drop — корабль целиком внутри)
SystemRoom.prototype.padAt = function(x, y) {
  var pads = (this.state && this.state.pads) || [];
  for (var i = 0; i < pads.length; i++) { var p = pads[i]; if (x >= p.x * CELL_M && x < (p.x + p.size) * CELL_M && y >= p.y * CELL_M && y < (p.y + p.size) * CELL_M) return p; }
  return null;
};
// разворот, при котором корабль целиком помещается в площадку: ближний к нынешнему; null — не помещается никак
SystemRoom.prototype.fitFacing = function(sh, pad) {
  var type = this.types[sh.cls], f0 = facingOf(sh.hd), fs = [f0, (f0 + 180) % 360, (f0 + 90) % 360, (f0 + 270) % 360];
  for (var i = 0; i < fs.length; i++) { var b = boxOf(type, fs[i]); if (b.w <= pad.size - 1 && b.h <= pad.size - 1) return fs[i]; }
  for (i = 0; i < fs.length; i++) { b = boxOf(type, fs[i]); if (b.w <= pad.size && b.h <= pad.size) return fs[i]; }
  return null;
};
// дошёл до середины площадки — встать ровно: по центру и прямым разворотом (так база видит его в площадке)
SystemRoom.prototype.dockStep = function() {
  var B = this.B, M = CELL_M;
  for (var i = 0; i < B.ships.length; i++) {
    var sh = B.ships[i], pad = sh.dock; if (!pad) continue;
    if (sh.dead) { sh.dock = null; continue; }
    if (sh.order) continue;                                    // ещё идёт
    var cx = (pad.x + pad.size / 2) * M, cy = (pad.y + pad.size / 2) * M, f = this.fitFacing(sh, pad);
    sh.dock = null;
    if (f == null || Math.abs(sh.x - cx) > pad.size * M / 2 || Math.abs(sh.y - cy) > pad.size * M / 2) continue;   // остановили не у площадки
    sh.x = cx; sh.y = cy; sh.hd = hdOf(f); sh.v = 0;
  }
};
SystemRoom.prototype.command = function(c, m) {
  if (!c.viewer) return;
  // приказы группе кораблей одним сообщением — каждый как обычный (полоса, площадка сброса)
  if (m.t === 'cmd' && m.k === 'many') { var self = this; Net.eachMany(m, function(x) { self.command(c, x); }); return; }
  if (m.t === 'cmd') {
    var sh = this.B.ships[m.n | 0];
    // будить спящий экипаж — только своему кораблю (иначе один игрок будит всю орбиту и грузит сервер)
    if (sh && sh.dormant && m.k !== 'view' && c.viewer.ctl(sh)) this.B.wake(sh);
    if (m.k === 'order' && m.x != null && m.x !== 'hold' && isFinite(+m.x) && isFinite(+m.y)) {
      // приказ — только в пределах карты орбиты (клиент ограничивает так же; чужое сообщение — тем более)
      var NM = this.grid * CELL_M, edge = 300;
      m.x = Math.max(edge, Math.min(NM - edge, +m.x));
      m.y = this.clampY(c.side, Math.max(edge, Math.min(NM - edge, +m.y)));
    }
    // курс в площадку сброса — к её середине, по прибытии корабль встаёт в неё целиком (dockStep)
    if (m.k === 'order' && sh && sh.side === c.side) {
      var pad = m.x != null && m.x !== 'hold' && !m.face && isFinite(+m.x) ? this.padAt(+m.x, +m.y) : null;
      if (pad && this.fitFacing(sh, pad) != null) { m.x = (pad.x + pad.size / 2) * CELL_M; m.y = (pad.y + pad.size / 2) * CELL_M; sh.dock = pad; }
      else sh.dock = null;
    }
    // заглянуть внутрь: свой — всегда, чужой — только если его видно
    var vs = m.k === 'view' && m.view != null && m.view >= 0 ? this.B.ships[m.view | 0] : null;
    if (vs && vs.pirate != null) return;                     // внутрь пиратского корабля не заглянуть: экипажа игры у него нет
    if (vs && vs.dormant && (vs.side === c.side || this.B.sees(c.side, vs))) this.B.wake(vs);
    var ok = c.viewer.command(m);
    // притягивающий луч: отказ — игроку словами; взял — сразу в базу (прыжок цели закрыт)
    if (m.k === 'tractor' && m.to != null && m.to >= 0) {
      if (!ok && c.viewer.lastWhy) this.send(c, JSON.stringify({ t: 'note', msg: 'Луч: ' + c.viewer.lastWhy, kind: 'bad' }));
      else if (ok) this.sync().catch(function() {});
    }
    return;
  }
  if (m.t === 'dbg' && this.cfg.dev) {
    var B = this.B, me = B.ships.filter(function(x) { return x.side === c.side && !x.dead; })[0], foe = B.ships.filter(function(x) { return x.side !== c.side && !x.dead; })[0];
    if (m.k === 'near' && me && foe) { foe.x = me.x + 2600; foe.y = me.y + 300; B.wake(me); B.wake(foe); foe.sh = [0, 0, 0, 0]; B.sense(); }
    if (m.k === 'fast') for (var i = 0; i < Math.min(3000, m.n | 0); i++) B.tick(SWSpace.TICK);
  }
};

// ---- находка в Пустоте (sql/void_finds.sql)
// Что видит клиент: зона, удержание, охрана (без мест — их показывает бой)
SystemRoom.prototype.findInfo = function() {
  var f = this.find; if (!f) return null;
  var alive = 0, all = 0, self = this;
  Object.keys(this.pirates || {}).forEach(function(i) { all++; var p = self.pirates[i]; if (p && !p.dead) alive++; });
  if (!all) (f.guards || []).forEach(function(g) { all++; if (+g.hp > 0 && !f.down) alive++; });
  return { id: f.id, type: f.type, title: f.title, glyph: f.glyph, art: f.art, guard: f.guard_name, cx: f.cx, cy: f.cy, r: f.r,
           down: !!f.down, guards: [alive, all], hold: f.hold || {}, need: f.need || 10800, holder: f.holder || null,
           tick: f.tick, ends: f.ends, now: f.now };
};
// Находка из базы (открытие, pull, ответ rt_void_sync): новая — охрана встаёт по местам из базы; та же — только числа;
// закрыта — пираты уходят, зона гаснет
SystemRoom.prototype.applyFind = function(fd) {
  var B = this.B, self = this;
  if (!fd || !fd.id) {
    if (!this.find) return;
    this.find = null;
    Object.keys(this.pirates || {}).forEach(function(i) { var p = self.pirates[i]; if (p && !p.dead) { p.dead = true; p.why = 'left'; p.deadAt = B.t; } });
    this.pirates = {}; this.vfKey = null; this.findKey = null;
    this.sendFind();
    return;
  }
  var fresh = !this.find || this.find.id !== fd.id;
  this.find = fd;
  if (fresh) {
    // прежняя находка этого узла (DEV: «потерять» и сразу новая) — её охрана уходит, а не остаётся без присмотра
    Object.keys(this.pirates || {}).forEach(function(i) { var p = self.pirates[i]; if (p && !p.dead) { p.dead = true; p.why = 'left'; p.deadAt = B.t; } });
    this.pirates = {}; this.vfKey = null;
    var added = [];
    if (!fd.down) (fd.guards || []).forEach(function(g) { if (+g.hp > 0) { var sh = self.addPirate(g); if (sh) added.push(sh); } });
    if (added.length && this.ready) {
      var msg = JSON.stringify({ t: 'ships', ships: added.map(function(sh) { return self.shipRow(sh); }) });
      this.clients.forEach(function(c) { self.send(c, msg); });
    }
    if (added.length) this.cfg.log('info', 'охрана находки', { room: this.name, find: fd.id, ships: added.length });
  } else if (fd.down) {
    // охрану сняла база (DEV) — пираты уходят с орбиты
    Object.keys(this.pirates || {}).forEach(function(i) { var p = self.pirates[i]; if (p && !p.dead) { p.dead = true; p.why = 'left'; p.deadAt = B.t; } });
  }
  this.sendFind();
};
SystemRoom.prototype.addPirate = function(g) {
  var type = this.types[g.cls];
  if (!type || !hasPlan(g.cls)) { this.cfg.log('warn', 'нет плана корабля охраны', { type: g.cls }); return null; }
  var p = plan(g.cls), id = 'vf-' + this.find.id.slice(0, 8) + '-' + g.i;
  var hpMax = Math.round((type.max_hp || 100) * VF_HP);
  var row = { id: id, ship_type: g.cls, hp: Math.max(1, Math.round(hpMax * Math.min(1, +g.hp || 1))), faction: 'pirate', name: g.name || null,
              bonus_hp: hpMax - (type.max_hp || 100), bonus_damage: Math.round((type.damage || 50) * (VF_DMG - 1)),
              shield_fore: type.max_shield || 0, shield_aft: type.max_shield || 0, shield_port: type.max_shield || 0, shield_starboard: type.max_shield || 0 };
  var army = Army.fromGame(row, type, [], [], { regenSec: (this.state.settings && this.state.settings.regen) || 30 });
  var x = isFinite(+g.x) ? +g.x : this.grid * CELL_M / 2, y = isFinite(+g.y) ? +g.y : this.grid * CELL_M / 2, hd = isFinite(+g.hd) ? +g.hd : 0;
  // пост — из базы (px/py/phd не меняются); место в бою (x/y) уезжает за погоней — по нему пост не ставим
  var post = isFinite(+g.px) && isFinite(+g.py) ? { x: +g.px, y: +g.py, hd: isFinite(+g.phd) ? +g.phd : hd } : { x: x, y: y, hd: hd };
  var sh = this.B.addShip({ cls: g.cls, plan: p, side: 2, x: x, y: y, hd: hd, figMap: FIG.crewFigs('cis', ALL), figIds: FIG_IDS, army: army,
                            name: army.name, id: id, owner: null, faction: 'pirate', dormant: true });
  // у охраны нет строки в ships: снимок орбиты (rt_space_sync) её пропускает, корпус пишет rt_void_sync
  sh.gameId = null; sh.craftIds = []; sh.units = [];
  sh.pirate = g.i | 0; sh.post = post; sh.ai = false; sh.guard = true; sh.focusAuto = true; sh.lead = !!g.lead;
  this.pirates[sh.pirate] = sh;
  return sh;
};
// Охрана: враг у находки — проснуться и в атаку; врага нет или увела погоня — назад на пост и стеречь
SystemRoom.prototype.pirateStep = function() {
  var f = this.find, B = this.B; if (!f || !this.pirates) return;
  var cx = (f.cx + 0.5) * CELL_M, cy = (f.cy + 0.5) * CELL_M, foe = false, i;
  for (i = 0; i < B.ships.length && !foe; i++) {
    var o = B.ships[i]; if (o.dead || o.side === 2 || o.why === 'left') continue;
    var dx = o.x - cx, dy = o.y - cy; if (dx * dx + dy * dy < VF_AGGRO * VF_AGGRO) foe = true;
  }
  var self = this;
  Object.keys(this.pirates).forEach(function(k) {
    var p = self.pirates[k]; if (!p || p.dead) return;
    var px = p.x - cx, py = p.y - cy, far = px * px + py * py > VF_LEASH * VF_LEASH;
    if (far) { if (!p.order) { B.order(p.n, p.post.x, p.post.y, false); p.back = true; } return; }
    if (p.back) { if (p.order) return; p.back = false; }
    // по нему стреляют издалека (дальше 7 км от находки) — тоже просыпается: безнаказанно расстрелять охрану нельзя
    var shot = self.hitAt[p.n] != null && B.t - self.hitAt[p.n] < FIRE_HOLD;
    if (foe || shot) {
      if (p.dormant) B.wake(p);
      if (!p.ai) { p.guard = false; p.ai = true; }
      // стреляют из-за датчиков: вспышка выстрела засекла стрелка — идти на него (ИИ сам ищет только в датчиках)
      if (shot && !foe && p.foeT == null) {
        var best = -1, bd = 1e18, L = B.last[2] || {};
        B.ships.forEach(function(o) {
          var z = L[o.n]; if (o.dead || o.side === 2 || !z || B.t - z.t > FIRE_HOLD) return;
          var d = (z.x - p.x) * (z.x - p.x) + (z.y - p.y) * (z.y - p.y); if (d < bd) { bd = d; best = o.n; }
        });
        if (best >= 0) B.attack(p.n, best);
      }
    } else if (p.ai) {
      p.ai = false; p.foeT = null; B.order(p.n, p.post.x, p.post.y, false); p.back = true;
    } else if (!p.order) {
      // не на посту (комнату открыли после погони — место из базы уехало) — вернуться, потом стеречь
      var ox = p.x - p.post.x, oy = p.y - p.post.y;
      if (ox * ox + oy * oy > 400 * 400) { if (p.dormant) B.wake(p); B.order(p.n, p.post.x, p.post.y, false); p.back = true; }
      else if (!p.guard) B.guard(p.n, true);
    }
  });
};
// Охрана — в базу (корпус, место, разворот), когда что-то поменялось; ответ базы — свежая находка
SystemRoom.prototype.syncFind = function() {
  var f = this.find, self = this; if (!f || !this.pirates) return;
  var list = Object.keys(this.pirates).map(function(k) {
    var p = self.pirates[k];
    return { i: +k, hp: p.dead ? 0 : Math.round(Math.max(0.001, p.hull / p.hullMax) * 1000) / 1000, x: Math.round(p.x), y: Math.round(p.y), hd: Math.round(p.hd * 1000) / 1000 };
  });
  if (!list.length) return;
  var key = list.map(function(g) { return g.i + ':' + g.hp + ':' + Math.round(g.x / 50) + ':' + Math.round(g.y / 50); }).join('|');
  if (key === this.vfKey || this.vfBusy) return;
  this.vfBusy = true;
  var fid = f.id;
  this.rpc('rt_void_sync', { p_battle: this.battleId, p_find: fid, p_guards: list }).then(function(fd) {
    self.vfBusy = false; self.vfKey = key;
    if (!self.find || self.find.id !== fid) return;
    if (fd && fd.closed) { self.applyFind(null); return; }
    if (fd && fd.id) self.applyFind(fd);
  }, function(e) {
    self.vfBusy = false;
    // база без находок (старый снимок) — больше не пишем до перезапуска комнаты
    if (/rt_void_sync|does not exist|Could not find|PGRST202/i.test(e.message || '')) self.vfKey = key;
    self.cfg.log('warn', 'rt_void_sync', { room: self.name, err: e.message });
  });
};
// Клиентам — когда поменялось удержание, охрана или находка закрылась
SystemRoom.prototype.sendFind = function() {
  if (!this.ready) return;
  var info = this.findInfo(), self = this;
  var key = info ? [info.id, info.down, info.guards.join('/'), info.hold.republic, info.hold.cis, info.holder, info.ends].join(',') : '';
  if (key === this.findKey) return;
  this.findKey = key;
  var msg = JSON.stringify({ t: 'find', find: info });
  this.clients.forEach(function(c) { self.send(c, msg); });
};

// ---- закрытие
SystemRoom.prototype.quiet = function() { return Date.now() - this.quietSince > QUIET_MS; };
SystemRoom.prototype.shouldClose = function() {
  if (this.closed) return true;
  if (!this.ready || this.clients.length) return false;
  // корабль ещё идёт по курсу (игрок закрыл экран) — доводим, потом закрываемся
  if (Date.now() - this.emptySince < 15 * 60e3 && this.B && this.B.ships.some(function(sh) { return !sh.dead && sh.order && !sh.order.face; })) return false;
  return Date.now() - this.emptySince > QUIET_MS && this.quiet();
};
SystemRoom.prototype.close = function(why) {
  var self = this;
  if (this.closed) return this.closeP || Promise.resolve();
  this.closed = true;
  // пока закрытие не записано в базу, комната остаётся в списке: новый вход подождёт, а не откроет бой,
  // который тут же закроет запоздавший ответ старого
  var done = function() { self.closeDone = true; };
  return (this.closeP = this.sync().then(function() { return self.rpc('rt_space_close', { p_battle: self.battleId, p_result: { why: why || 'quiet', t: Math.round(self.B.t) } }); })
    .then(function() { self.cfg.log('info', 'орбита закрыта', { room: self.name, why: why }); }, function(e) { self.cfg.log('error', 'rt_space_close', { room: self.name, err: e.message }); }).then(done, done));
};
// занят — пока идёт стрельба; зритель на тихой орбите обновлению сервера не мешает (комната откроется заново из базы)
SystemRoom.prototype.busy = function() { return !this.quiet() ? 1 : 0; };
SystemRoom.prototype.info = function() {
  var awake = this.B ? this.B.ships.filter(function(s) { return !s.dead && !s.dormant; }).length : 0;
  return { room: this.name, clients: this.clients.length, ships: this.B ? this.B.ships.filter(function(s) { return !s.dead; }).length : 0, awake: awake,
           t: this.B ? Math.round(this.B.t) : 0, bytesPerClient: Math.round(this.bytesRate / Math.max(1, this.clients.length)) };
};

// «so:<система>» → { key, system }
function parse(name) {
  var m = /^so:([a-z0-9_]{2,40})$/i.exec(String(name || ''));
  if (!m) return null;
  return { key: 'so:' + m[1].toLowerCase(), system: m[1].toLowerCase() };
}

module.exports = { SystemRoom: SystemRoom, parse: parse, CELL_M: CELL_M, boxOf: boxOf, hdOf: hdOf, facingOf: facingOf };
