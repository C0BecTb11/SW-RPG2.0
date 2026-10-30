// Наземка 2.0 на сервере: комната живой планеты («gr:<планета>»).
// Открывается, когда игрок открыл планету; грузит бойцов, постройки и поселение из базы
// (rt_ground_open), считает бой движком shared/rt-ground.js, раз в 5 с пишет позиции и
// здоровье (rt_ground_sync) и подхватывает новых и ушедших бойцов (rt_ground_pull).
// Бойцы планеты заперты блокировкой боя 2.0 — дозор, турели, npc_tick и автоход базы их
// не трогают. Захват считает база по записанным позициям (capture_tick); сервер лишь
// показывает её прогресс. Комната закрывается через 3 минуты тишины без игроков.
// Зонд-разведчик улетает на соседнюю планету тоже через комнату: идёт в зону вылета, база
// (start_scout_move) снимает его с карты, прилёт делает cron finish-scout-moves.
'use strict';

var fs = require('fs');
// Очередь на отправку игроку: больше — кадры пропускаются, потом бой целиком (медленная связь не копит минуты задержки)
// 256 КБ — больше самого крупного кадра (при 1000 бойцах ~150 КБ): иначе такой кадр сразу переполнял очередь,
// и следующий всегда шёл полным (аудит 30.10, BUG-076)
var BUF_MAX = 262144;
var path = require('path');
var P = require('../shared/rt-planets.js');
var U = require('../shared/rt-units.js');
var GR = require('../shared/rt-ground.js');
var Net = require('../shared/rt-ground-net.js');

var N = P.N;
var SYNC_EVERY = 5000, PULL_EVERY = 5000, QUIET_MS = 3 * 60e3;
var LOAD_FIRE_S = 30;          // погрузка на борт — не раньше 30 с после последнего попадания по бойцу
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
  this.dbCell = {}; this.lastSt = {}; this.boardDead = {};
  this.syncAt = Date.now(); this.pullAt = Date.now(); this.quietSince = Date.now(); this.emptySince = Date.now(); this.created = Date.now();
  this.loads = []; this.goneAt = {};
  var self = this;
  this.open().then(function() { self.ready = true; self.waiting.forEach(function(c) { self.admit(c); }); self.waiting = []; },
                   function(e) { self.failed = e.message || String(e); self.cfg.log('error', 'комната наземки не открылась', { room: name, err: self.failed }); self.waiting.forEach(function(c) { c.ws.send(JSON.stringify({ t: 'error', msg: 'Планета не открылась: ' + self.failed })); c.ws.close(4007); }); self.waiting = []; self.closed = true; });
}

GroundRoom.prototype.rpc = function(fn, args) { args = args || {}; args.p_key = this.cfg.key; return this.cfg.rpc(fn, args); };

// Ключ того, что вписано в карту комнаты при открытии: поселение, хозяин и здания на участках (6×6 непроходимы).
// Изменилось — комната пересоздаётся: здание, построенное или снесённое при открытой комнате, иначе не было бы
// ни преградой, ни проходом до следующего открытия (аудит 30.10, BUG-007)
function mapKey(st) {
  var settle = st.settle ? { level: st.settle.level, districts: st.settle.districts || [] } : { level: 1, districts: [] };
  var bl = (st.buildings || []).map(function(b) { return b.x + ',' + b.y; }).sort().join(';');
  return JSON.stringify(settle) + '|' + (st.system && st.system.faction) + '|' + bl;
}
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
    self.settleKey = mapKey(st);
    var B = new GR.Ground(js, { seed: (Date.now() % 100000) | 0, auto0: false, auto1: false, att: self.att, captureSeconds: st.capture_goal || 21600, settle: settle, militiaAuto: false, capExternal: true });
    self.B = B;
    // туман (раз в 0,5 с) и ИИ (раз в 2 с) разных комнат — в разные такты: сервер один на все планеты (BUG-070)
    B.fogT = Math.random() * 0.5; B.aiT = Math.random() * 2;
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
// asked — когда запрошен снимок (pull): боец, которого комната сама сняла с карты позже (погрузка,
// вылет разведчика), в старом снимке ещё стоит — его не возвращаем
GroundRoom.prototype.applyUnits = function(units, asked) {
  var B = this.B, self = this, seen = {}, raid = 0, leave = 0;
  units.forEach(function(u) {
    if (asked && self.goneAt[u.id] >= asked) return;
    seen[u.id] = 1;
    if (self.byUid[u.id] != null) {
      // мародёр: налёт кончился (npc_brains.state = 'leave') — банда уходит с карты
      var ex = B.agents[self.byUid[u.id]];
      if (ex && ex.alive && ex.team === 2 && u.brain && u.brain.st === 'leave' && !ex.leave) { ex.leave = true; leave++; }
      // бонусы сменились (пассивка героя, улучшение) — пересчитать, не дожидаясь переоткрытия комнаты (аудит 30.10, BUG-031)
      var bk = JSON.stringify(u.bonus || {});
      if (ex && ex.alive && ex.bonusKey != null && ex.bonusKey !== bk) B.rebonus(ex, u.bonus);
      if (ex) ex.bonusKey = bk;
      return;
    }
    var Ty = U.type(u.type); if (!Ty) { self.cfg.log('warn', 'неизвестный тип бойца', { type: u.type }); return; }
    var team = teamOf(u.faction), size = Ty.size, x = u.x, y = u.y;
    if (!B.pass[Ty.move + size][y * N + x]) { var alt = B.nearestOk(Ty.move, size, x, y); if (alt) { x = alt[0]; y = alt[1]; } }
    var hpMax = Ty.hp + (u.bonus && u.bonus.hp || 0), abil = u.abil || [];
    var a = B.add(u.type, team, x + size / 2, y + size / 2, {
      uid: u.id, name: u.name || (u.npc === 'partisan' ? 'Подпольщик' : ''), portrait: u.portrait || undefined, hpMax: hpMax, hp: Math.min(hpMax, u.hp), owner: u.owner || null,
      bonus: u.bonus || null, npc: !!u.npc, aim: team === self.def ? Math.PI / 2 : -Math.PI / 2, skills: u.skills || null,
      abil: Ty.hero ? abil.filter(function(id) { var A = GR.ABIL[id]; return A && A[0]; }) : undefined, passive: Ty.hero ? passiveOf(abil) : undefined
    });
    if (!a) return;
    a.hid = u.hero || null;                      // героя знают панели игры (древо, имя)
    if (a.npc) a.auto = true;
    if (u.npc === 'partisan') a.part = true;    // подполье (sql/loyalty.sql): идёт прямо на площадь
    if (u.brain && team === 2) {                 // логово и поводок мародёра (npc_brains)
      a.home = [u.brain.hx, u.brain.hy]; a.leave = u.brain.st === 'leave';
      if (self.ready && !a.leave) raid++;
    }
    if (u.training) a.hold = true;
    a.bonusKey = JSON.stringify(u.bonus || {});
    self.restoreSt(a, u.rt, team);
    self.byUid[u.id] = a.id;
    self.lastSync[u.id] = x + ',' + y + ',' + Math.round(a.hp);
    self.dbCell[u.id] = u.x + ',' + u.y;
    self.lastSt[u.id] = stKey(self.stOf(a));
  });
  if (raid) [0, 1].forEach(function(tm) { B.msg(raid > 1 ? 'Банда мародёров у поселения: ' + raid : 'Мародёр у поселения', tm, 'bad'); });
  if (leave) [0, 1].forEach(function(tm) { B.msg('Мародёры уходят с добычей', tm, 'bad'); });
  // ушедшие (погружены, уничтожены базой, переданы) — убираем без сцены гибели
  Object.keys(this.byUid).forEach(function(uid) {
    if (seen[uid]) return;
    var a = B.agents[self.byUid[uid]];
    if (a && a.alive) { a.alive = false; a.gone = true; a.removed = true; a.diedAt = B.t - 100; }
    delete self.byUid[uid]; delete self.lastSync[uid]; delete self.dbCell[uid]; delete self.lastSt[uid];
  });
};
// Откаты героя и порабощение живут дольше комнаты: в базе (unit_positions.rt_state) — в абсолютном
// времени (секунды эпохи), иначе переоткрытие комнаты сбрасывало «Порабощение» и освобождало раба (BUG-018)
function stKey(st) { return st ? JSON.stringify(st) : ''; }
GroundRoom.prototype.stOf = function(a) {
  var B = this.B, now = Date.now() / 1000, st = null, k;
  if (a.hero && a.hero.cds) {
    a.cdAbs = a.cdAbs || {};
    for (k in a.hero.cds) {
      var v = a.hero.cds[k]; if (!(v > B.t)) { delete a.cdAbs[k]; continue; }
      if (!a.cdAbs[k] || a.cdAbs[k][0] !== v) a.cdAbs[k] = [v, Math.round(now + v - B.t)];
      (st = st || {}).cd = st.cd || {}; st.cd[k] = a.cdAbs[k][1];
    }
  }
  if (a.mind && a.mind.until > B.t) {
    if (!a.mindAbs || a.mindAbs[0] !== a.mind.until) a.mindAbs = [a.mind.until, Math.round(now + a.mind.until - B.t)];
    (st = st || {}).mind = { by: a.mind.by, until: a.mindAbs[1] };
  } else a.mindAbs = null;
  return st;
};
GroundRoom.prototype.restoreSt = function(a, rt, team) {
  if (!rt || typeof rt !== 'object') return;
  var B = this.B, now = Date.now() / 1000, k;
  if (a.hero && rt.cd) for (k in rt.cd) {
    var left = +rt.cd[k] - now; if (!(left > 0) || !GR.ABIL[k]) continue;
    a.hero.cds[k] = B.t + left; (a.cdAbs = a.cdAbs || {})[k] = [a.hero.cds[k], +rt.cd[k]];
  }
  var m = rt.mind;
  if (m && (m.by === 0 || m.by === 1 || m.by === 2) && m.by !== team && +m.until > now) {
    a.mind = { until: B.t + (+m.until - now), by: m.by, orig: team }; a.mindAbs = [a.mind.until, +m.until];
    a.tgt = -1; a.focus = -1; a.goal = null; a.at = true; a.post = false; a.sq = 0;
  }
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
      if (st0 && st0.dead && s.hp > 0 && b0 === 0) { st0.dead = false; st0.hp = s.hp; B.stVer = (B.stVer || 0) + 1; self.structSync[s.id] = self.structOk[s.id] = Math.round(s.hp); }
      return;
    }
    if (s.building) return;                                   // ещё строится — подхватим, когда готова
    if (!U.ST[s.kind]) return;
    // сырьё добытчика — из типа (rep_mine_gas → gas): экран рисует баки, теплицу или друзу
    var res = s.kind === 'extractor' ? String(s.type || '').replace(/^(rep|cis)_mine_/, '') || null : null;
    var st = B.addStruct(s.kind, teamOf(s.faction), s.x, s.y, { w: s.w, h: s.h, hp: Math.min(s.hp, s.hpMax || s.hp), uid: s.id, res: res });
    if (!st) return;
    if (s.hpMax) st.hpMax = s.hpMax;
    if (s.hp <= 0) { st.dead = true; B.stVer = (B.stVer || 0) + 1; }
    self.structByUid[s.id] = st.i; self.structSync[s.id] = self.structOk[s.id] = st.dead ? 0 : Math.round(st.hp);
  });
  Object.keys(this.structByUid).forEach(function(uid) { if (!seen[uid]) { var st = B.structs[self.structByUid[uid]]; if (st && !st.dead) { st.dead = true; B.stVer = (B.stVer || 0) + 1; } delete self.structByUid[uid]; } });
};
GroundRoom.prototype.applyCapture = function(cap, goal) {
  var B = this.B;
  if (goal) B.capNeed = goal;
  // подполье открывает поселение наступающим (rt_ground_state.loyalty, sql/loyalty.sql)
  var lo = this.state && this.state.loyalty, spy = lo && lo.reveal ? teamOf(lo.reveal) : -1;
  if (spy > 1) spy = -1;
  if (spy >= 0 && spy !== B.spy) B.msg('Подполье доносит: поселение у нас на виду', spy, 'gold');
  B.spy = spy;
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
  // и в очереди открытия: пока комната открывается, второе окно того же игрока не встаёт рядом с первым (BUG-051)
  for (i = this.waiting.length - 1; i >= 0; i--) {
    var w = this.waiting[i];
    if (w.who && w.who.user === c.who.user && c.who.user !== 'dev') { try { w.ws.send(JSON.stringify({ t: 'error', msg: 'Эта планета открыта в другой вкладке' })); w.ws.close(4006); } catch (e) {} this.waiting.splice(i, 1); }
  }
  if (!this.ready) { this.waiting.push(c); return true; }
  this.admit(c);
  return true;
};
GroundRoom.prototype.admit = function(c) {
  var self = this, B = this.B;
  c.side = c.side === 1 || (c.side !== 0 && c.who.side === 1) ? 1 : 0;
  // хозяин планеты (своя сторона) — ему зоны высадки, управляющий и все здания; врагу — по туману (BUG-042)
  var home = teamOf(this.state.system.faction) === c.side;
  c.viewer = new Net.Viewer(B, c.side, c.who.user, { ownerCheck: !this.cfg.dev, buildings: this.state.buildings || [], planetSide: teamOf(this.state.system.faction),
    onLoad: function(ids, ship, user) { self.onLoad(ids, ship, user, c); }, onBuild: function(id, job, user) { self.onBuild(id, job, user, c); }, onScout: function(id, to, user) { self.onScout(id, to, user, c); } });
  this.clients.push(c);
  this.send(c, JSON.stringify({
    t: 'hello', kind: 'ground', system: this.system, name: this.state.system.name, side: c.side, att: this.att, T: Math.round(B.t * 100) / 100, capNeed: B.capNeed,
    me: c.who.user, own: !this.cfg.dev,                                   // приказы — только своим бойцам (Viewer.ids): клиент не выбирает союзных
    map: this.mapPacked, structs: c.viewer.helloStructs(),
    districts: B.districts.map(function(d) { return { id: d.id, name: d.name, effect: d.effect, rect: d.rect, by: d.by, cnt: [c.side === 0 ? d.cnt[0] : null, c.side === 1 ? d.cnt[1] : null] }; }),
    faction: this.state.system.faction, controller: home ? this.state.system.controller : null, zones: home ? this.zones : [], zoneBox: this.zoneBox,
    buildings: c.viewer.helloBuildings(), plots: this.state.plots || []
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
    // очередь игрока переполнена — кадр не строим (построенный и выброшенный кадр уносил гибели и скрытия,
    // BUG-036); следующий уйдёт полным
    if (this.tickN % Net.FRAME_EVERY === 0) { if (c.ws.bufferedAmount > BUF_MAX) { c.viewer.lost(); continue; } this.send(c, c.viewer.frame(this.tickN)); }
  }
  var now = Date.now();
  if (now - this.rateAt >= 2000) { this.bytesRate = this.bytes / ((now - this.rateAt) / 1000); this.bytes = 0; this.rateAt = now; }
  if (now - this.syncAt >= SYNC_EVERY || B.ev.deaths.some(function(d) { return d.t > t0; })) this.sync();
  if (now - this.pullAt >= PULL_EVERY) this.pull();
};

// Записать в базу изменившиеся позиции и здоровье
// Запись в базу — строго по очереди: два запроса вперемешку могли бы записать старое поверх нового
// Запись, что ещё ждёт очереди, одна: она возьмёт состояние на момент своего начала, этого хватит всем, кто
// её ждёт. Иначе при медленной базе каждый такт ставил новую — очередь росла без предела (BUG-038)
GroundRoom.prototype.sync = function() {
  if (this.syncWait) return this.syncWait;
  var self = this;
  this.syncAt = Date.now();
  var p = this.syncWait = (this.syncQ || Promise.resolve()).then(function() { self.syncWait = null; return self.syncNow(); });
  this.syncQ = p.catch(function() {});
  return p;
};
GroundRoom.prototype.syncNow = function() {
  var B = this.B, rows = [], srows = [], self = this, live = [], used = {}, cellFor = {};
  // клетки в базе: на клетку один боец (idx_unit_positions_cell). Двое в одной клетке — второму ближайшая
  // свободная, иначе база оставляла ему старую позицию, и захват считался по ней (BUG-039).
  // Сначала — те, кто в базе уже стоит в своей клетке, потом остальные
  Object.keys(this.byUid).forEach(function(uid) {
    var a = B.agents[self.byUid[uid]];
    if (!a || a.removed || a.left || !a.alive) return;
    var c = B.cellOf(a); live.push([uid, a, c]);
  });
  var claim = function(uid, c) { used[c[0] + ',' + c[1]] = uid; cellFor[uid] = c; };
  live.forEach(function(L) { var k = L[2][0] + ',' + L[2][1]; if (self.dbCell[L[0]] === k && !used[k]) claim(L[0], L[2]); });
  live.forEach(function(L) {
    var uid = L[0], a = L[1], c = L[2]; if (cellFor[uid]) return;
    if (!used[c[0] + ',' + c[1]]) { claim(uid, c); return; }
    var m = B.pass[a.move + a.size], best = null;
    for (var r = 1; r <= 4 && !best; r++) for (var dy = -r; dy <= r && !best; dy++) for (var dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      var x = c[0] + dx, y = c[1] + dy; if (x < 0 || y < 0 || x + a.size > N || y + a.size > N || used[x + ',' + y]) continue;
      if (m && !m[y * N + x]) continue;
      best = [x, y]; break;
    }
    claim(uid, best || c);
  });
  Object.keys(this.byUid).forEach(function(uid) {
    var a = B.agents[self.byUid[uid]];
    // мародёр ушёл с карты: строку в базе убирает rt_ground_sync (как погибшего, без засчёта)
    if (a && a.left) { if (self.lastSync[uid] !== 'left') { self.lastSync[uid] = 'left'; var lc = B.cellOf(a); rows.push({ id: uid, x: lc[0], y: lc[1], hp: 0, fire: false }); } return; }
    if (!a || a.removed) return;
    // погиб, когда база уже снимает его с карты (погрузка, вылет): гибель не пишем — иначе база стёрла бы
    // бойца, который уже на борту или в пути. Сняла — гибель запишется отдельно (boardDead), не вышло —
    // следующей сверкой
    if (!a.alive && a.loading) return;
    var c = a.alive ? cellFor[uid] || B.cellOf(a) : B.cellOf(a), hp = a.alive ? Math.max(1, Math.round(a.hp)) : 0, fire = a.alive && B.t - (a.hitT || -99) < 30;
    var key = c[0] + ',' + c[1] + ',' + hp + ',' + (fire ? 1 : 0), st = a.alive ? self.stOf(a) : null, sk = stKey(st);
    if (self.lastSync[uid] === key && (!a.alive || self.lastSt[uid] === sk)) return;
    self.lastSync[uid] = key;
    var row = { id: uid, x: c[0], y: c[1], hp: hp, fire: fire };        // под огнём — в базе закрыта погрузка со стороны
    if (a.alive && self.lastSt[uid] !== sk) { row.st = st; self.lastSt[uid] = sk; }   // откаты и порабощение (BUG-018)
    if (!a.alive && a.hitBy != null) { var k = B.agents[a.hitBy]; if (k && k.uid) row.by = k.uid; }   // кому засчитать (герою)
    rows.push(row);
  });
  // погиб, пока база грузила его на борт: база его уже погрузила — снять с борта (BUG-060)
  Object.keys(this.boardDead).forEach(function(uid) { var bd = self.boardDead[uid]; rows.push({ id: uid, x: bd.x, y: bd.y, hp: 0, fire: false, board: true, by: bd.by || undefined }); });
  Object.keys(this.structByUid).forEach(function(uid) {
    var s = B.structs[self.structByUid[uid]]; if (!s) return;
    var hp = s.dead ? 0 : Math.round(s.hp);
    if (self.structSync[uid] === hp) return;
    self.structSync[uid] = hp; srows.push({ id: uid, hp: hp });
  });
  if (!rows.length && !srows.length) return Promise.resolve();
  return this.rpc('rt_ground_sync', { p_battle: this.battleId, p_units: rows, p_structs: srows })
    .then(function(res) {
      srows.forEach(function(r) { self.structOk[r.id] = r.hp; });
      rows.forEach(function(r) { if (r.board) delete self.boardDead[r.id]; else if (r.hp > 0) self.dbCell[r.id] = r.x + ',' + r.y; });
      // клетка у кого-то осталась занятой (busy) — кто именно, база не говорит: эти строки — ещё раз в следующий раз
      if (res && res.busy > 0) rows.forEach(function(r) { if (r.hp > 0) { delete self.lastSync[r.id]; delete self.dbCell[r.id]; } });
    })
    .catch(function(e) {
      self.cfg.log('error', 'rt_ground_sync', { room: self.name, err: e.message });
      rows.forEach(function(r) { delete self.lastSync[r.id]; if (r.st !== undefined) delete self.lastSt[r.id]; });
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
  var self = this, base = null, asked = 0; this.pullAt = Date.now();
  // сначала дождаться своих записей: снимок базы не старее того, что мы в неё положили
  return (this.syncQ || Promise.resolve()).then(function() {
    base = {}; for (var k in self.structOk) base[k] = self.structOk[k];
    asked = Date.now();
    return self.rpc('rt_ground_pull', { p_battle: self.battleId, p_system: self.system });
  }).then(function(st) {
    if (!st || st.closed) { self.cfg.log('warn', 'бой закрыт базой', { room: self.name }); self.closed = true; self.kick('Бой на планете закрыт'); return; }
    var key = mapKey(st);
    if (key !== self.settleKey) {
      // планета сменила хозяина, поселение выросло или на участках встало (снесено) здание: комната пересоздаётся
      self.cfg.log('info', 'планета изменилась — комната закрывается', { room: self.name });
      self.close('planet changed').then(function() { self.kick('Планета изменилась — открой её заново'); });
      return;
    }
    self.state = st;
    self.applyUnits(st.units || [], asked);
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
    var a = B.agents[id]; if (!a || !a.alive || !a.uid || a.loading) return;
    var z = self.zoneFor(a); if (!z) return;
    a.loadShip = ship; a.scoutTo = null; a.loadZone = z; a.loadUser = user;
    if (!self.inZone(a, z)) B.orderMove(c.side, [id], z.cx, z.cy);
    n++;
  });
  if (n) B.msg('На борт: ' + n + ' — идут в зону погрузки', c.side, 'gold');
};
GroundRoom.prototype.loadsStep = function() {
  var B = this.B, self = this, ag = B.agents;
  if (this.tickN % 10 !== 0) return;
  for (var i = 0; i < ag.length; i++) {
    var a = ag[i]; if (!a.alive || !(a.loadShip || a.scoutTo) || a.loading) continue;
    var z = a.loadZone;
    if (!this.inZone(a, z)) { if (a.at && !a.loading && this.tickN % 50 === 0) B.orderMove(a.team, [a.id], z.cx, z.cy); continue; }   // встал с краю — ещё шаг внутрь
    // под огнём не грузятся — то же правило, что у панели армии в базе (rt_battle_guard: 30 с после попадания).
    // Через сервер боя оно обходилось: rt_ground_act идёт мимо сторожа (решение Артёма 30.10 — закрыть)
    if (B.t - (a.hitT == null ? -99 : a.hitT) < LOAD_FIRE_S) {
      if (!a.loadWarn) { a.loadWarn = true; B.msg((a.name || a.T.name) + ' под огнём — погрузка, когда 30 с не будет попаданий', a.team, 'bad'); }
      continue;
    }
    a.loadWarn = false;
    a.loading = true;
    if (a.scoutTo) { this.scoutGo(a); continue; }
    (function(a, ship, user) {
      self.sync().then(function() {
        return self.rpc('rt_ground_act', { p_user: user, p_fn: a.T.vehicle ? 'load_vehicle_to_ship' : 'load_unit_from_ground', p_args: { unit: a.uid, ship: ship } });
      }).then(function() {
        // пал, пока база грузила: на борт он уже попал — гибель записать отдельно (BUG-060)
        if (!a.alive) { var dc = B.cellOf(a), kb = a.hitBy != null && B.agents[a.hitBy]; self.boardDead[a.uid] = { x: dc[0], y: dc[1], by: kb && kb.uid || null }; self.drop(a); self.sync(); return; }
        self.drop(a);
        B.msg((a.name || a.T.name) + ' — на борту', a.team, 'gold');
      }, function(e) {
        a.loading = false; a.loadShip = null;
        B.msg('Погрузка: ' + String(e.message || e).replace(/^.*?: /, ''), a.team, 'bad');
      });
    })(a, a.loadShip, a.loadUser);
  }
};

// Целиком ли боец в зоне (как в базе: is_box_in_*_zone смотрит всю коробку техники, BUG-043)
GroundRoom.prototype.inZone = function(a, z) {
  var c = this.B.cellOf(a), s = a.size || 1;
  return c[0] >= z.x && c[1] >= z.y && c[0] + s <= z.x + z.w && c[1] + s <= z.y + z.h;
};
// Боец снят с карты руками комнаты (погрузка, вылет): без сцены гибели, и старый снимок базы его не вернёт
GroundRoom.prototype.drop = function(a) {
  a.alive = false; a.gone = true; a.removed = true; a.diedAt = this.B.t - 100;
  this.goneAt[a.uid] = Date.now(); delete this.byUid[a.uid]; delete this.lastSync[a.uid];
};

// ---- разведчик: идёт в зону вылета (как на погрузку) и улетает на соседнюю планету (start_scout_move)
GroundRoom.prototype.onScout = function(id, to, user, c) {
  var B = this.B, a = B.agents[id];
  if (!a || !a.alive || !a.uid) return;
  if (!a.T.scout) { B.msg('Сам по себе летать умеет только разведчик', c.side, 'bad'); return; }
  if (to === this.system) { B.msg('Он уже здесь', c.side, 'bad'); return; }
  if (a.loading || a.scoutTo === to) return;                 // уже улетает / уже идёт туда
  var z = this.zoneFor(a);
  if (!z) { B.msg('Нет зоны вылета: разведчик улетает из зоны высадки', c.side, 'bad'); return; }
  a.scoutTo = to; a.scoutName = hasMap(to) ? (mapJson(to).name || '') : ''; a.loadShip = null; a.build = null; a.loadZone = z; a.loadUser = user;
  if (!this.inZone(a, z)) {
    B.orderMove(c.side, [id], z.cx, z.cy);
    B.msg((a.name || a.T.name) + ' идёт в зону вылета' + (a.scoutName ? ' → ' + a.scoutName : ''), c.side, 'gold');
  }
};
GroundRoom.prototype.scoutGo = function(a) {
  var self = this, B = this.B, to = a.scoutTo, nm = a.scoutName;
  self.sync().then(function() {
    return self.rpc('rt_ground_act', { p_user: a.loadUser, p_fn: 'start_scout_move', p_args: { unit: a.uid, system: to } });
  }).then(function(r) {
    var sec = r && r.result != null ? +r.result : 0;
    self.drop(a);
    B.msg((a.name || a.T.name) + ' улетел' + (nm ? ' на ' + nm : '') + (sec ? ' · прилёт через ' + sec + ' с' : ''), a.team, 'gold');
  }, function(e) {
    a.loading = false; a.scoutTo = null;
    B.msg('Разведка: ' + String(e.message || e).replace(/^.*?: /, ''), a.team, 'bad');
  });
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
  if (a.loading) { B.msg((a.name || a.T.name) + ' уже грузится на борт', c.side, 'bad'); return; }
  if (a.build && a.build.busy) { B.msg((a.name || a.T.name) + ' уже закладывает укрепление — дождись', c.side, 'bad'); return; }
  // на стенах, воротах и башнях города и поверх других построек не строят (база этих клеток не знает)
  for (var jy = job.y; jy < job.y + job.h; jy++) for (var jx = job.x; jx < job.x + job.w; jx++) {
    var so = B.structAt[jy * N + jx]; if (so >= 0 && !B.structs[so].dead) { B.msg('Здесь уже стоит ' + B.structs[so].name.toLowerCase() + ' — выбери другое место', c.side, 'bad'); return; }
    var mm = B.map.m[jy * N + jx]; if (mm === 8 || mm === 9) {   // стена или частокол (shared/rt-town.js, M.wall / M.palisade)
      B.msg('На стене города не строят', c.side, 'bad'); return; }
  }
  if (a.loadShip || a.scoutTo) { a.loadShip = null; a.scoutTo = null; a.loading = false; }
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
        if (a.build === j) a.build = null;                   // ответ на старую стройку не отменяет новую (BUG-049)
        B.msg((a.name || a.T.name) + ' заложил укрепление', a.team, 'gold');
        self.pullAt = 0;                                     // подхватить постройку базой пораньше
      }, function(e) {
        if (a.build === j) a.build = null;
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
  if (Date.now() - this.emptySince < 10 * 60e3 && this.B && this.B.agents.some(function(a) { return a.alive && !a.npc && ((a.goal && !a.at) || a.loadShip || a.scoutTo || a.build); })) return false;
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
