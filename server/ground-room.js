// Наземка 2.0 на сервере: комната живой планеты («gr:<планета>»).
// Открывается, когда игрок открыл планету; грузит бойцов, постройки и поселение из базы
// (rt_ground_open), считает бой движком shared/rt-ground.js, раз в 5 с пишет позиции и
// здоровье (rt_ground_sync) и подхватывает новых и ушедших бойцов (rt_ground_pull).
// Бойцы планеты заперты блокировкой боя 2.0 — дозор, турели, npc_tick и автоход базы их
// не трогают. Захват считает база по записанным позициям (capture_tick); сервер лишь
// показывает её прогресс. Комната закрывается через 3 минуты тишины без игроков.
'use strict';

var fs = require('fs');
// Очередь на отправку игроку: больше — кадры пропускаются, потом бой целиком (медленная связь не копит минуты задержки)
var BUF_MAX = 131072;
var path = require('path');
var P = require('../shared/rt-planets.js');
var U = require('../shared/rt-units.js');
var GR = require('../shared/rt-ground.js');
var Net = require('../shared/rt-ground-net.js');

var N = P.N;
var SYNC_EVERY = 5000, PULL_EVERY = 5000, QUIET_MS = 3 * 60e3;
var MAPS = {};
function mapJson(id) {
  if (!MAPS[id]) MAPS[id] = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'shared', 'planets', id + '.json'), 'utf8'));
  return MAPS[id];
}
function teamOf(faction) { return faction === 'republic' ? 0 : faction === 'cis' ? 1 : 2; }
function hasMap(id) { try { return fs.existsSync(path.join(__dirname, '..', 'shared', 'planets', id + '.json')); } catch (e) { return false; } }

// Пассивные умения героя из выученных способностей (hero_learned → ABIL таблица движка).
// Здоровье, урон, обзор, меткость и уклонение база уже кладёт в bonus_* бойца (hero_apply_passives) —
// они приходят в u.bonus и учитываются там; здесь — только то, чего в bonus нет (отражение, поглощение),
// иначе пассивка считалась бы дважды (и герой уходил бы из боя с запасом сверх предела)
function passiveOf(abil) {
  var out = {}, map = { deflect_light: 'deflect', absorb_dark: 'absorb' };
  (abil || []).forEach(function(id) { var A = GR.ABIL[id]; if (A && !A[0] && map[id]) out[map[id]] = (out[map[id]] || 0) + A[4]; });
  return out;
}

function GroundRoom(name, system, cfg) {
  this.kind = 'ground'; this.name = name; this.system = system; this.cfg = cfg;
  this.clients = []; this.waiting = []; this.ready = false; this.closed = false; this.failed = null;
  this.ms = []; this.bytes = 0; this.bytesRate = 0; this.rateAt = Date.now(); this.tickN = 0;
  this.battle = { tick: 0 };
  this.byUid = {}; this.structByUid = {}; this.lastSync = {}; this.structSync = {}; this.structOk = {};
  this.syncAt = Date.now(); this.pullAt = Date.now(); this.quietSince = Date.now(); this.emptySince = Date.now(); this.created = Date.now();
  this.loads = [];
  var self = this;
  this.open().then(function() { self.ready = true; self.waiting.forEach(function(c) { self.admit(c); }); self.waiting = []; },
                   function(e) { self.failed = e.message || String(e); self.cfg.log('error', 'комната наземки не открылась', { room: name, err: self.failed }); self.waiting.forEach(function(c) { c.ws.send(JSON.stringify({ t: 'error', msg: 'Планета не открылась: ' + self.failed })); c.ws.close(4007); }); self.waiting = []; self.closed = true; });
}

GroundRoom.prototype.rpc = function(fn, args) { args = args || {}; args.p_key = this.cfg.key; return this.cfg.rpc(fn, args); };

GroundRoom.prototype.open = function() {
  var self = this;
  if (!hasMap(this.system)) return Promise.reject(new Error('нет карты планеты ' + this.system));
  return this.rpc('rt_ground_open', { p_system: this.system }).then(function(st) {
    if (!st || !st.battle_id || !st.system) throw new Error('база не вернула планету');
    self.battleId = st.battle_id; self.state = st;
    self.def = teamOf(st.system.faction); if (self.def > 1) self.def = 0;
    self.att = 1 - self.def;
    var json = mapJson(self.system), map = P.load(json);
    // постройки на участках — непроходимые 6×6 (как в базе: ground_box_on_building)
    (st.buildings || []).forEach(function(b) { for (var y = b.y; y < b.y + 6; y++) for (var x = b.x; x < b.x + 6; x++) if (x >= 0 && y >= 0 && x < N && y < N) { map.t[y * N + x] = P.T.BLOCK; map.m[y * N + x] = 18; } });
    var js = { id: json.id, v: json.v, w: json.w, h: json.h, seed: json.seed, town: json.town, t: map.t, e: map.e, m: map.m, objs: json.objs, paths: json.paths, name: json.name, about: json.about, look: json.look, zones: json.zones };
    var settle = st.settle ? { level: st.settle.level, districts: st.settle.districts || [] } : { level: 1, districts: [] };
    self.settleKey = JSON.stringify(settle) + '|' + st.system.faction;
    var B = new GR.Ground(js, { seed: (Date.now() % 100000) | 0, auto0: false, auto1: false, att: self.att, captureSeconds: st.capture_goal || 21600, settle: settle, militiaAuto: false, capExternal: true });
    self.B = B;
    // карта игрокам — слоями в base64 (типизированные массивы в JSON не уходят)
    var mj = B.mapJson; self.mapPacked = {};
    Object.keys(mj).forEach(function(k) { self.mapPacked[k] = mj[k]; });
    self.mapPacked.t = P.pack(mj.t); self.mapPacked.e = P.pack(mj.e); self.mapPacked.m = P.pack(mj.m);
    self.applyUnits(st.units || []);
    self.applyStructs(st.structs || []);
    self.applyCapture(st.capture, st.capture_goal);
    self.ownerOf = {}; self.zones = st.zones || []; self.zoneBox = st.zone_box;
    self.cfg.log('info', 'планета открыта', { room: self.name, battle: self.battleId, units: B.agents.length, structs: B.structs.length, level: settle.level, faction: st.system.faction });
    // маски проходимости с городом — в базу (высадка, появление, стройка по ним)
    var masks = { w: N, h: N };
    ['foot1', 'track1', 'track2', 'hover1', 'hover2'].forEach(function(k) { var a = B.pass[k], s = ''; for (var i = 0; i < a.length; i++) s += a[i] ? '1' : '0'; masks[k] = s; });
    self.rpc('rt_ground_map', { p_system: self.system, p_masks: masks, p_version: 'town:' + settle.level }).catch(function(e) { self.cfg.log('warn', 'маска планеты не записана', { err: e.message }); });
  });
};

// Бойцы из базы → движок. Повторный вызов (pull) добавляет новых и убирает ушедших.
GroundRoom.prototype.applyUnits = function(units) {
  var B = this.B, self = this, seen = {}, raid = 0, leave = 0;
  units.forEach(function(u) {
    seen[u.id] = 1;
    if (self.byUid[u.id] != null) {
      // мародёр: налёт кончился (npc_brains.state = 'leave') — банда уходит с карты
      var ex = B.agents[self.byUid[u.id]];
      if (ex && ex.alive && ex.team === 2 && u.brain && u.brain.st === 'leave' && !ex.leave) { ex.leave = true; leave++; }
      return;
    }
    var Ty = U.type(u.type); if (!Ty) { self.cfg.log('warn', 'неизвестный тип бойца', { type: u.type }); return; }
    var team = teamOf(u.faction), size = Ty.size, x = u.x, y = u.y;
    if (!B.pass[Ty.move + size][y * N + x]) { var alt = B.nearestOk(Ty.move, size, x, y); if (alt) { x = alt[0]; y = alt[1]; } }
    var hpMax = Ty.hp + (u.bonus && u.bonus.hp || 0), abil = u.abil || [];
    var a = B.add(u.type, team, x + size / 2, y + size / 2, {
      uid: u.id, name: u.name || '', portrait: u.portrait || undefined, hpMax: hpMax, hp: Math.min(hpMax, u.hp), owner: u.owner || null,
      bonus: u.bonus || null, npc: !!u.npc, aim: team === self.def ? Math.PI / 2 : -Math.PI / 2, skills: u.skills || null,
      abil: Ty.hero ? abil.filter(function(id) { var A = GR.ABIL[id]; return A && A[0]; }) : undefined, passive: Ty.hero ? passiveOf(abil) : undefined
    });
    if (!a) return;
    a.hid = u.hero || null;                      // героя знают панели игры (древо, имя)
    if (a.npc) a.auto = true;
    if (u.brain && team === 2) {                 // логово и поводок мародёра (npc_brains)
      a.home = [u.brain.hx, u.brain.hy]; a.leave = u.brain.st === 'leave';
      if (self.ready && !a.leave) raid++;
    }
    if (u.training) a.hold = true;
    self.byUid[u.id] = a.id;
    self.lastSync[u.id] = x + ',' + y + ',' + Math.round(a.hp);
  });
  if (raid) [0, 1].forEach(function(tm) { B.msg(raid > 1 ? 'Банда мародёров у поселения: ' + raid : 'Мародёр у поселения', tm, 'bad'); });
  if (leave) [0, 1].forEach(function(tm) { B.msg('Мародёры уходят с добычей', tm, 'bad'); });
  // ушедшие (погружены, уничтожены базой, переданы) — убираем без сцены гибели
  Object.keys(this.byUid).forEach(function(uid) {
    if (seen[uid]) return;
    var a = B.agents[self.byUid[uid]];
    if (a && a.alive) { a.alive = false; a.gone = true; a.removed = true; a.diedAt = B.t - 100; }
    delete self.byUid[uid]; delete self.lastSync[uid];
  });
};
// base — прочность построек, которая лежала в базе к моменту запроса (pull)
GroundRoom.prototype.applyStructs = function(list, base) {
  var B = this.B, self = this, seen = {};
  list.forEach(function(s) {
    seen[s.id] = 1;
    if (self.structByUid[s.id] != null) {
      // разбитая постройка снова цела — только если база уже знала о гибели (там был 0): старый снимок,
      // где гибель ещё не записана, её не воскрешает
      var st0 = B.structs[self.structByUid[s.id]], b0 = base ? base[s.id] : self.structOk[s.id];
      if (st0 && st0.dead && s.hp > 0 && b0 === 0) { st0.dead = false; st0.hp = s.hp; self.structSync[s.id] = self.structOk[s.id] = Math.round(s.hp); }
      return;
    }
    if (s.building) return;                                   // ещё строится — подхватим, когда готова
    if (!U.ST[s.kind]) return;
    var st = B.addStruct(s.kind, teamOf(s.faction), s.x, s.y, { w: s.w, h: s.h, hp: Math.min(s.hp, s.hpMax || s.hp), uid: s.id });
    if (!st) return;
    if (s.hpMax) st.hpMax = s.hpMax;
    if (s.hp <= 0) st.dead = true;
    self.structByUid[s.id] = st.i; self.structSync[s.id] = self.structOk[s.id] = st.dead ? 0 : Math.round(st.hp);
  });
  Object.keys(this.structByUid).forEach(function(uid) { if (!seen[uid]) { var st = B.structs[self.structByUid[uid]]; if (st) st.dead = true; delete self.structByUid[uid]; } });
};
GroundRoom.prototype.applyCapture = function(cap, goal) {
  var B = this.B;
  if (goal) B.capNeed = goal;
  if (cap) { B.cap.prog = +cap.progress || 0; B.cap.status = cap.status || 'stalled'; B.capFaction = cap.faction; }
  else { B.cap.prog = 0; B.cap.status = 'stalled'; }
};

// ---- игроки
GroundRoom.prototype.join = function(c) {
  if (this.closed) { c.ws.send(JSON.stringify({ t: 'error', msg: 'Планета закрыта: ' + (this.failed || 'попробуй ещё раз') })); c.ws.close(4007); return false; }
  for (var i = this.clients.length - 1; i >= 0; i--) {
    var o = this.clients[i];
    if (o.who && o.who.user === c.who.user && c.who.user !== 'dev') { o.ws.send(JSON.stringify({ t: 'error', msg: 'Эта планета открыта в другой вкладке' })); o.ws.close(4006); this.clients.splice(i, 1); }
  }
  if (!this.ready) { this.waiting.push(c); return true; }
  this.admit(c);
  return true;
};
GroundRoom.prototype.admit = function(c) {
  var self = this, B = this.B;
  c.side = c.side === 1 || (c.side !== 0 && c.who.side === 1) ? 1 : 0;
  c.viewer = new Net.Viewer(B, c.side, c.who.user, { ownerCheck: !this.cfg.dev, onLoad: function(ids, ship, user) { self.onLoad(ids, ship, user, c); }, onBuild: function(id, job, user) { self.onBuild(id, job, user, c); } });
  this.clients.push(c);
  this.send(c, JSON.stringify({
    t: 'hello', kind: 'ground', system: this.system, name: this.state.system.name, side: c.side, att: this.att, T: Math.round(B.t * 100) / 100, capNeed: B.capNeed,
    me: c.who.user, own: !this.cfg.dev,                                   // приказы — только своим бойцам (Viewer.ids): клиент не выбирает союзных
    map: this.mapPacked, structs: B.structs.map(Net.structRow),
    districts: B.districts.map(function(d) { return { id: d.id, name: d.name, effect: d.effect, rect: d.rect, by: d.by, cnt: d.cnt }; }),
    faction: this.state.system.faction, controller: this.state.system.controller, zones: this.zones, zoneBox: this.zoneBox,
    buildings: this.state.buildings || [], plots: this.state.plots || []
  }));
  this.cfg.log('info', 'игрок на планете', { room: this.name, user: c.who.user, side: c.side });
};
GroundRoom.prototype.leave = function(c) {
  var i = this.clients.indexOf(c); if (i >= 0) this.clients.splice(i, 1);
  i = this.waiting.indexOf(c); if (i >= 0) this.waiting.splice(i, 1);
  if (!this.clients.length) this.emptySince = Date.now();
};
GroundRoom.prototype.send = function(c, data) {
  if (c.ws.bufferedAmount > BUF_MAX) { if (c.viewer) c.viewer.lost(); return; }
  var n = typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength;
  this.bytes += n; c.bytes = (c.bytes || 0) + n;
  c.ws.send(data);
};
GroundRoom.prototype.command = function(c, m) {
  if (!c.viewer || !this.ready) return;
  if (m.t === 'cmd') c.viewer.command(m);
};

// ---- такт
GroundRoom.prototype.step = function() {
  if (!this.ready || this.closed) return;
  var B = this.B, i, j;
  // карта из базы «живёт»: расчёт шага 0,1 с (двигатель сам режет на 0,05)
  var shots0 = B.ev.shots.length, t0 = B.t;
  B.step(0.1);
  if (B.ev.shots.some(function(q) { return q.t > t0; })) this.quietSince = Date.now();
  this.tickN++; this.battle.tick = this.tickN;
  this.loadsStep();
  this.buildsStep();
  for (i = 0; i < this.clients.length; i++) {
    var c = this.clients[i]; if (!c.viewer) continue;
    if (this.tickN % Net.FRAME_EVERY === 0) this.send(c, c.viewer.frame(this.tickN));
  }
  var now = Date.now();
  if (now - this.rateAt >= 2000) { this.bytesRate = this.bytes / ((now - this.rateAt) / 1000); this.bytes = 0; this.rateAt = now; }
  if (now - this.syncAt >= SYNC_EVERY || B.ev.deaths.some(function(d) { return d.t > t0; })) this.sync();
  if (now - this.pullAt >= PULL_EVERY) this.pull();
};

// Записать в базу изменившиеся позиции и здоровье
// Запись в базу — строго по очереди: два запроса вперемешку могли бы записать старое поверх нового
GroundRoom.prototype.sync = function() {
  var self = this, p = (this.syncQ || Promise.resolve()).then(function() { return self.syncNow(); });
  this.syncQ = p.catch(function() {});
  return p;
};
GroundRoom.prototype.syncNow = function() {
  var B = this.B, rows = [], srows = [], self = this;
  this.syncAt = Date.now();
  Object.keys(this.byUid).forEach(function(uid) {
    var a = B.agents[self.byUid[uid]];
    // мародёр ушёл с карты: строку в базе убирает rt_ground_sync (как погибшего, без засчёта)
    if (a && a.left) { if (self.lastSync[uid] !== 'left') { self.lastSync[uid] = 'left'; var lc = B.cellOf(a); rows.push({ id: uid, x: lc[0], y: lc[1], hp: 0, fire: false }); } return; }
    if (!a || a.removed) return;
    var c = B.cellOf(a), hp = a.alive ? Math.max(1, Math.round(a.hp)) : 0, fire = a.alive && B.t - (a.hitT || -99) < 30;
    var key = c[0] + ',' + c[1] + ',' + hp + ',' + (fire ? 1 : 0);
    if (self.lastSync[uid] === key) return;
    self.lastSync[uid] = key;
    var row = { id: uid, x: c[0], y: c[1], hp: hp, fire: fire };        // под огнём — в базе закрыта погрузка со стороны
    if (!a.alive && a.hitBy != null) { var k = B.agents[a.hitBy]; if (k && k.uid) row.by = k.uid; }   // кому засчитать (герою)
    rows.push(row);
  });
  Object.keys(this.structByUid).forEach(function(uid) {
    var s = B.structs[self.structByUid[uid]]; if (!s) return;
    var hp = s.dead ? 0 : Math.round(s.hp);
    if (self.structSync[uid] === hp) return;
    self.structSync[uid] = hp; srows.push({ id: uid, hp: hp });
  });
  if (!rows.length && !srows.length) return Promise.resolve();
  return this.rpc('rt_ground_sync', { p_battle: this.battleId, p_units: rows, p_structs: srows })
    .then(function() { srows.forEach(function(r) { self.structOk[r.id] = r.hp; }); })
    .catch(function(e) {
      self.cfg.log('error', 'rt_ground_sync', { room: self.name, err: e.message });
      Object.keys(self.lastSync).forEach(function(k) { if (rows.some(function(r) { return r.id === k; })) delete self.lastSync[k]; });
      srows.forEach(function(r) { delete self.structSync[r.id]; });      // постройки — повторить запись в следующий раз
    });
};
// Подхватить из базы новых бойцов, ушедших, постройки, прогресс захвата; смена хозяина — закрыть
GroundRoom.prototype.pull = function() {
  // прошлый запрос ещё не вернулся (база медленная) — не накладывать: старый ответ поверх нового терял бы бойцов
  if (this.pulling) return Promise.resolve();
  var me = this; this.pulling = true;
  return this.pullNow().then(function(v) { me.pulling = false; return v; }, function(e) { me.pulling = false; throw e; });
};
GroundRoom.prototype.pullNow = function() {
  var self = this, base = null; this.pullAt = Date.now();
  // сначала дождаться своих записей: снимок базы не старее того, что мы в неё положили
  return (this.syncQ || Promise.resolve()).then(function() {
    base = {}; for (var k in self.structOk) base[k] = self.structOk[k];
    return self.rpc('rt_ground_pull', { p_battle: self.battleId, p_system: self.system });
  }).then(function(st) {
    if (!st || st.closed) { self.cfg.log('warn', 'бой закрыт базой', { room: self.name }); self.closed = true; self.kick('Бой на планете закрыт'); return; }
    var settle = st.settle ? { level: st.settle.level, districts: st.settle.districts || [] } : { level: 1, districts: [] };
    var key = JSON.stringify(settle) + '|' + (st.system && st.system.faction);
    if (key !== self.settleKey) {
      // планета сменила хозяина или поселение выросло: комната пересоздаётся
      self.cfg.log('info', 'планета изменилась — комната закрывается', { room: self.name });
      self.close('planet changed').then(function() { self.kick('Планета изменилась — открой её заново'); });
      return;
    }
    self.state = st;
    self.applyUnits(st.units || []);
    self.applyStructs(st.structs || [], base);
    self.applyCapture(st.capture, st.capture_goal);
  }).catch(function(e) { self.cfg.log('error', 'rt_ground_pull', { room: self.name, err: e.message }); });
};
GroundRoom.prototype.kick = function(msg) {
  var self = this;
  this.clients.slice().forEach(function(c) { try { c.ws.send(JSON.stringify({ t: 'reset', msg: msg })); c.ws.close(4008); } catch (e) {} });
  this.clients = [];
};

// ---- погрузка: отряд идёт в свою зону и грузится на корабль руками сервера
GroundRoom.prototype.zoneFor = function(a) {
  var tw = this.B.town;
  if (a.team === this.att) return { x: 0, y: N - P.GEO.strip, w: N, h: P.GEO.strip, cx: Math.floor(a.x), cy: N - 2 };
  var best = null, bd = 1e9;
  (this.zones || []).forEach(function(z) { var dx = z.x + z.size / 2 - a.x, dy = z.y + z.size / 2 - a.y, d = dx * dx + dy * dy; if (d < bd) { bd = d; best = { x: z.x, y: z.y, w: z.size, h: z.size, cx: z.x + (z.size >> 1), cy: z.y + (z.size >> 1) }; } });
  return best;
};
GroundRoom.prototype.onLoad = function(ids, ship, user, c) {
  var B = this.B, self = this, n = 0;
  if (!/^[0-9a-f-]{36}$/.test(ship)) return;
  ids.forEach(function(id) {
    var a = B.agents[id]; if (!a || !a.alive || !a.uid) return;
    var z = self.zoneFor(a); if (!z) return;
    a.loadShip = ship; a.loadZone = z; a.loadUser = user;
    if (!(a.x >= z.x && a.x < z.x + z.w && a.y >= z.y && a.y < z.y + z.h)) B.orderMove(c.side, [id], z.cx, z.cy);
    n++;
  });
  if (n) B.msg('На борт: ' + n + ' — идут в зону погрузки', c.side, 'gold');
};
GroundRoom.prototype.loadsStep = function() {
  var B = this.B, self = this, ag = B.agents;
  if (this.tickN % 10 !== 0) return;
  for (var i = 0; i < ag.length; i++) {
    var a = ag[i]; if (!a.alive || !a.loadShip || a.loading) continue;
    var z = a.loadZone; if (!(a.x >= z.x && a.x < z.x + z.w && a.y >= z.y && a.y < z.y + z.h)) continue;
    a.loading = true;
    (function(a) {
      self.sync().then(function() {
        return self.rpc('rt_ground_act', { p_user: a.loadUser, p_fn: a.T.vehicle ? 'load_vehicle_to_ship' : 'load_unit_from_ground', p_args: { unit: a.uid, ship: a.loadShip } });
      }).then(function() {
        a.alive = false; a.gone = true; a.removed = true; a.diedAt = B.t - 100; delete self.byUid[a.uid]; delete self.lastSync[a.uid];
        B.msg((a.name || a.T.name) + ' — на борту', a.team, 'gold');
      }, function(e) {
        a.loading = false; a.loadShip = null;
        B.msg('Погрузка: ' + String(e.message || e).replace(/^.*?: /, ''), a.team, 'bad');
      });
    })(a);
  }
};

// ---- стройка инженера: подойти к месту (дальность базы — 2 клетки от коробки) и заложить через build_structure
var BUILD_GAP = 2;
function boxGap(ax, ay, aw, ah, bx, by, bw, bh) {
  var dx = Math.max(bx - (ax + aw), ax - (bx + bw), 0), dy = Math.max(by - (ay + ah), ay - (by + bh), 0);
  return Math.max(dx, dy);
}
GroundRoom.prototype.onBuild = function(id, job, user, c) {
  var B = this.B, a = B.agents[id];
  if (!a || !a.alive || !a.uid || !a.T.builder) { B.msg('Строить умеет только инженер', c.side, 'bad'); return; }
  if (a.loadShip) { a.loadShip = null; a.loading = false; }
  a.build = { type: job.type, x: job.x, y: job.y, w: job.w, h: job.h, user: user, busy: false };
  // цель хода: ближайшая к бойцу проходимая клетка в кольце на 1 клетку от коробки
  var best = null, bd = 1e9, sz = a.size, m = B.pass[a.move + sz];
  for (var y = job.y - BUILD_GAP - sz; y <= job.y + job.h + BUILD_GAP; y++) for (var x = job.x - BUILD_GAP - sz; x <= job.x + job.w + BUILD_GAP; x++) {
    if (x < 0 || y < 0 || x + sz > N || y + sz > N) continue;
    var gp = boxGap(x, y, sz, sz, job.x, job.y, job.w, job.h);
    if (gp < 1 || gp > BUILD_GAP) continue;                   // не на самой коробке, но в дальности стройки
    if (!m[y * N + x]) continue;
    var d = (x + sz / 2 - a.x) * (x + sz / 2 - a.x) + (y + sz / 2 - a.y) * (y + sz / 2 - a.y) + gp;
    if (d < bd) { bd = d; best = [x, y]; }
  }
  var c0 = B.cellOf(a);
  if (boxGap(c0[0], c0[1], sz, sz, job.x, job.y, job.w, job.h) > BUILD_GAP) {
    if (!best) { a.build = null; B.msg('К месту стройки не подойти', c.side, 'bad'); return; }
    B.orderMove(c.side, [id], best[0], best[1]);
    B.msg((a.name || a.T.name) + ' идёт к месту стройки', c.side, 'gold');
  }
};
GroundRoom.prototype.buildsStep = function() {
  var B = this.B, self = this, ag = B.agents;
  if (this.tickN % 10 !== 0) return;
  for (var i = 0; i < ag.length; i++) {
    var a = ag[i], j = a.build; if (!a.alive || !j || j.busy) continue;
    var sz = a.size, c = B.cellOf(a);
    if (boxGap(c[0], c[1], sz, sz, j.x, j.y, j.w, j.h) > BUILD_GAP) { if (a.at || !a.goal) { a.build = null; B.msg((a.name || a.T.name) + ': до места стройки не дошёл', a.team, 'bad'); } continue; }
    if (a.goal && !a.at) B.orderStop(a.team, [a.id]);
    j.busy = true;
    (function(a, j) {
      self.sync().then(function() {
        return self.rpc('rt_ground_act', { p_user: j.user, p_fn: 'build_structure', p_args: { unit: a.uid, type: j.type, x: j.x, y: j.y } });
      }).then(function() {
        a.build = null;
        B.msg((a.name || a.T.name) + ' заложил укрепление', a.team, 'gold');
        self.pullAt = 0;                                     // подхватить постройку базой пораньше
      }, function(e) {
        a.build = null;
        B.msg('Стройка: ' + String(e.message || e).replace(/^.*?: /, ''), a.team, 'bad');
      });
    })(a, j);
  }
};

// ---- закрытие
GroundRoom.prototype.quiet = function() { return Date.now() - this.quietSince > QUIET_MS; };
GroundRoom.prototype.shouldClose = function() {
  if (this.closed) return true;
  if (!this.ready || this.clients.length) return false;
  // игрок закрыл экран, а бойцы ещё идут по приказу (к точке, на погрузку, на стройку) — доводим (не дольше 10 мин)
  if (Date.now() - this.emptySince < 10 * 60e3 && this.B && this.B.agents.some(function(a) { return a.alive && !a.npc && ((a.goal && !a.at) || a.loadShip || a.build); })) return false;
  return Date.now() - this.emptySince > QUIET_MS && this.quiet();
};
GroundRoom.prototype.close = function(why) {
  var self = this;
  if (this.closed) return this.closeP || Promise.resolve();
  this.closed = true;
  // пока закрытие не записано в базу, комната остаётся в списке: новый вход подождёт, а не откроет бой,
  // который тут же закроет запоздавший ответ старого
  var done = function() { self.closeDone = true; };
  return (this.closeP = this.sync().then(function() { return self.rpc('rt_ground_close', { p_battle: self.battleId, p_result: { why: why || 'quiet', t: Math.round(self.B.t) } }); })
    .then(function() { self.cfg.log('info', 'планета закрыта', { room: self.name, why: why }); }, function(e) { self.cfg.log('error', 'rt_ground_close', { room: self.name, err: e.message }); }).then(done, done));
};
GroundRoom.prototype.busy = function() { return this.ready && !this.closed && (this.clients.length || !this.quiet()) ? 1 : 0; };
GroundRoom.prototype.info = function() {
  var B = this.B;
  return { room: this.name, kind: 'ground', clients: this.clients.length, troops: B ? B.agents.filter(function(a) { return a.alive; }).length : 0, t: B ? Math.round(B.t) : 0,
           bytesPerClient: Math.round(this.bytesRate / Math.max(1, this.clients.length)) };
};

function parse(name) {
  var m = /^gr:([a-z0-9_]{2,32})$/i.exec(name);
  return m ? { system: m[1].toLowerCase(), key: 'gr:' + m[1].toLowerCase() } : null;
}

module.exports = { GroundRoom: GroundRoom, parse: parse, hasMap: hasMap };
