// Ивент на сервере: комната матча «ev:<матч>». Матч собирает база (очередь, event_match_try
// или dev_event_start); комната берёт его (rt_event_open), строит бой на карте ивента
// (shared/events/maps) движком наземки без города, ведёт сценарий (shared/rt-events.js) и ботов
// на пустых ролях, а по итогу пишет его в базу (rt_event_finish: награды, трофеи, титулы).
// Бойцы ивента в армию не пишутся. Войти могут только игроки матча (в тесте — его автор).
// RT_DEV: «ev:dev-<ивент>-<уровень>-<карта>-<роль>» — матч без базы, остальные роли — боты.
// Укрепления сценария (оборона) уходят игроку в hello, как на планете.
'use strict';

var fs = require('fs');
// Очередь на отправку игроку: больше — кадры пропускаются, потом бой целиком (медленная связь не копит минуты задержки)
var BUF_MAX = 131072;
var path = require('path');
var P = require('../shared/rt-planets.js');
var GR = require('../shared/rt-ground.js');
var Net = require('../shared/rt-ground-net.js');
var CAT = require('../shared/rt-events-cat.js');
var EV = require('../shared/rt-events.js');

var N = P.N;
var START_WAIT = 3 * 60e3;          // никто из людей не вошёл — матч отменяется
var LEAVE_LOSE = 120e3;             // все люди роли ушли и не вернулись — роль проиграла
var END_KEEP = 90e3;                // после итога комната живёт, чтобы все увидели экран итога

function mapPath(id) { return path.join(__dirname, '..', 'shared', 'events', 'maps', id + '.json'); }
function teamOf(side) { return side === 'cis' ? 1 : 0; }

function EventRoom(name, match, cfg) {
  this.kind = 'event'; this.name = name; this.matchId = match; this.cfg = cfg;
  this.clients = []; this.waiting = []; this.ready = false; this.closed = false; this.failed = null;
  this.ms = []; this.bytes = 0; this.bytesRate = 0; this.rateAt = Date.now(); this.tickN = 0;
  this.battle = { tick: 0 }; this.created = Date.now(); this.emptySince = Date.now();
  this.roleSeen = {}; this.endAt = 0; this.awards = null; this.finishing = false; this.saved = false;
  this.present = {}; this.beatAt = Date.now();          // кто из людей входил в бой; сердцебиение матча в базе
  var self = this;
  this.open().then(function() { self.ready = true; self.waiting.forEach(function(c) { self.admit(c); }); self.waiting = []; },
                   function(e) {
                     self.failed = e.message || String(e); self.cfg.log('error', 'ивент не открылся', { room: name, err: self.failed });
                     self.waiting.forEach(function(c) { self.err(c, 'Ивент не открылся: ' + self.failed, 4007); }); self.waiting = []; self.closed = true;
                     // база уже пометила матч «идёт» — отменяем, чтобы игроки не застряли
                     if (self.match && !(self.cfg.dev && /^dev-/.test(self.matchId))) self.rpc('rt_event_abort', { p_match: self.matchId, p_why: 'сервер не открыл бой: ' + self.failed }).catch(function() {});
                   });
}
EventRoom.prototype.rpc = function(fn, args) { args = args || {}; args.p_key = this.cfg.key; return this.cfg.rpc(fn, args); };
EventRoom.prototype.err = function(c, msg, code) { try { c.ws.send(JSON.stringify({ t: 'error', msg: msg })); c.ws.close(code || 4007); } catch (e) {} };

// Матч без базы (только RT_DEV): ev:dev-hunt_sith-2-sarn-sith
function devMatch(id) {
  var m = /^dev-([a-z_]+)-([123])-([a-z0-9_]+)-([a-z]+)(?:-(\d))?$/.exec(id); if (!m) throw new Error('неверный тестовый матч');
  var E = CAT.BY[m[1]]; if (!E || !E.ready) throw new Error('нет такого ивента');
  var bots = +(m[5] || 2), players = [];
  E.roles.forEach(function(r) {
    // своя роль: против бота — число в имени = весь отряд (ты + боты-союзники); иначе только до минимума
    var n = r.id === m[4] ? (E.kind === 'pve' ? Math.max(r.min - 1, Math.min(r.max, bots) - 1) : r.min - 1) : r.max === 1 ? 1 : Math.max(r.min, Math.min(r.max, bots));
    if (r.id === m[4]) players.push({ user: 'dev', role: r.id, side: r.side, nick: 'dev' });
    for (var i = 1; i <= n; i++) players.push({ user: 'bot:' + r.id + ':' + i, role: r.id, side: r.side, bot: true });
  });
  return Promise.resolve({ id: id, event: m[1], tier: +m[2], map: m[3], players: players, test: true, seed: 1977, created_by: 'dev' });
}

EventRoom.prototype.open = function() {
  var self = this;
  var get; try { get = this.cfg.dev && /^dev-/.test(this.matchId) ? devMatch(this.matchId) : this.rpc('rt_event_open', { p_match: this.matchId }); } catch (e) { get = Promise.reject(e); }   // кривое имя тестового боя — отказ этому бою, не исключение
  return get.then(function(m) {
    if (!m || !m.event || !m.map) throw new Error('база не вернула матч');
    self.match = m;
    var E = CAT.BY[m.event]; if (!E || !E.ready) throw new Error('ивент не готов: ' + m.event);
    if (E.maps.indexOf(m.map) < 0 || !fs.existsSync(mapPath(m.map))) throw new Error('нет карты ' + m.map);
    self.match = m; self.E = E;
    var json = JSON.parse(fs.readFileSync(mapPath(m.map), 'utf8'));
    self.mapInfo = { id: json.id, name: json.name, about: json.about };
    var B = new GR.Ground(json, { seed: (m.seed || 1977) % 100000, noTown: true, auto0: false, auto1: false, att: 0, weather: json.night || 0 });
    self.B = B;
    self.H = EV.create(B, { event: m.event, tier: m.tier, map: json, players: m.players, seed: m.seed || 1977 });
    self.H.setup();
    var mj = B.mapJson; self.mapPacked = {};
    Object.keys(mj).forEach(function(k) { self.mapPacked[k] = mj[k]; });
    self.mapPacked.t = P.pack(mj.t); self.mapPacked.e = P.pack(mj.e); self.mapPacked.m = P.pack(mj.m);
    self.humans = m.players.filter(function(p) { return !p.bot; });
    self.cfg.log('info', 'ивент открыт', { room: self.name, event: m.event, tier: m.tier, map: m.map, players: m.players.length, humans: self.humans.length, test: !!m.test });
  });
};

// ---- игроки
EventRoom.prototype.playerOf = function(user) {
  var m = this.match; if (!m) return null;
  for (var i = 0; i < m.players.length; i++) if (!m.players[i].bot && m.players[i].user === user) return m.players[i];
  return null;
};
EventRoom.prototype.join = function(c) {
  if (this.closed) { this.err(c, 'Бой ивента закрыт: ' + (this.failed || 'он уже кончился')); return false; }
  for (var i = this.clients.length - 1; i >= 0; i--) {
    var o = this.clients[i];
    if (o.who && o.who.user === c.who.user && c.who.user !== 'dev') { this.err(o, 'Бой открыт в другой вкладке', 4006); this.clients.splice(i, 1); }
  }
  if (!this.ready) { this.waiting.push(c); return true; }
  this.admit(c);
  return true;
};
EventRoom.prototype.admit = function(c) {
  var self = this, B = this.B, p = this.playerOf(c.who.user);
  if (!p && this.cfg.dev && c.who.user === 'dev') p = this.match.players.filter(function(q) { return !q.bot; })[0];
  if (!p) { this.err(c, 'Ты не участник этого боя', 4005); return; }
  var role = CAT.role(this.match.event, p.role);
  c.side = teamOf(role ? role.side : p.side); c.role = p.role;
  c.viewer = new Net.Viewer(B, c.side, c.who.user === 'dev' && this.cfg.dev ? 'dev' : c.who.user, { ownerCheck: true });
  this.clients.push(c);
  this.roleSeen[p.role] = Date.now(); this.present[c.who.user] = 1;
  var E = this.E;
  this.send(c, JSON.stringify({
    t: 'hello', kind: 'event', system: this.mapInfo.id, name: this.mapInfo.name, side: c.side, att: B.att, T: Math.round(B.t * 100) / 100, capNeed: 1,
    me: c.who.user === 'dev' && this.cfg.dev ? 'dev' : c.who.user, own: true,
    map: this.mapPacked, structs: B.structs.map(Net.structRow), districts: [], faction: null, controller: null, zones: [], zoneBox: null, buildings: [], plots: [],
    ev: { match: this.match.id, event: E.id, title: E.title, tier: this.match.tier, role: p.role, roleName: role ? role.name : p.role, test: !!this.match.test,
          place: this.mapInfo.name, about: this.mapInfo.about, goal: E.goal ? E.goal[role ? role.side : 'republic'] : '', minutes: E.minutes[this.match.tier - 1],
          players: this.match.players.map(function(q) { return { role: q.role, nick: q.bot ? 'бот' : q.nick || '', bot: !!q.bot, me: q.user === c.who.user }; }) }
  }));
  this.send(c, JSON.stringify({ t: 'ev', v: this.H.view(c.side) }));
  if (this.H.result && this.endMsg) this.send(c, this.endMsg(c), true);
  this.cfg.log('info', 'игрок в ивенте', { room: this.name, user: c.who.user, role: p.role, side: c.side });
};
EventRoom.prototype.leave = function(c) {
  var i = this.clients.indexOf(c); if (i >= 0) this.clients.splice(i, 1);
  var w = this.waiting.indexOf(c); if (w >= 0) this.waiting.splice(w, 1);           // ушёл, пока бой открывался
  if (c.role) this.roleSeen[c.role] = Date.now();
};
// Медленный игрок: кадры пропускаем и потом шлём бой заново (viewer.lost); итог — дошлём, как освободится
EventRoom.prototype.send = function(c, s, keep) {
  if (c.ws.bufferedAmount > BUF_MAX) { if (c.viewer) c.viewer.lost(); if (keep) c.pending = s; return; }
  this.bytes += s.length; c.bytes = (c.bytes || 0) + s.length;
  try { c.ws.send(s); } catch (e) {}
};
EventRoom.prototype.command = function(c, m) { if (!c.viewer || !this.ready || this.H.result) return; if (m.t === 'cmd') c.viewer.command(m); };

// ---- такт
EventRoom.prototype.step = function() {
  if (!this.ready || this.closed) return;
  var B = this.B, H = this.H, i, now = Date.now();
  if (!H.result) { B.step(0.1); H.step(); this.forfeit(now); }
  this.tickN++; this.battle.tick = this.tickN;
  for (i = 0; i < this.clients.length; i++) {
    var c = this.clients[i]; if (!c.viewer) continue;
    if (c.pending && c.ws.bufferedAmount < BUF_MAX / 2) { var pd = c.pending; c.pending = null; this.send(c, pd, true); }
    if (this.tickN % Net.FRAME_EVERY === 0) this.send(c, c.viewer.frame(this.tickN));
    if (this.tickN % 5 === 0) this.send(c, JSON.stringify({ t: 'ev', v: H.view(c.side) }));
  }
  if (now - this.rateAt >= 2000) { this.bytesRate = this.bytes / ((now - this.rateAt) / 1000); this.bytes = 0; this.rateAt = now; }
  if (H.result && !this.finishing) this.finish();
  // сердцебиение матча: база отменяет «идущие» матчи без него (сервер упал, комната пропала)
  if (!H.result && now - this.beatAt > 30e3 && !(this.cfg.dev && /^dev-/.test(this.matchId))) {
    this.beatAt = now; var self0 = this;
    this.rpc('rt_event_beat', { p_match: this.matchId }).catch(function(e) { self0.cfg.log('warn', 'rt_event_beat', { room: self0.name, err: e.message }); });
  }
  // никто из людей так и не вошёл
  if (!H.result && !Object.keys(this.roleSeen).length && now - this.created > START_WAIT) this.abort('игроки не вошли в бой');
};
// Все люди одной роли ушли надолго, а другая сторона здесь — роль проиграла; ушли все — отмена
EventRoom.prototype.forfeit = function(now) {
  if (!this.humans.length || !Object.keys(this.roleSeen).length) return;
  var self = this, here = {}, roles = {};
  this.clients.forEach(function(c) { if (c.role) here[c.role] = 1; });
  this.humans.forEach(function(p) { roles[p.role] = 1; });
  var never = Object.keys(roles).filter(function(r) { return !self.roleSeen[r]; });
  if (never.length && now - this.created > START_WAIT) { this.abort('не все игроки вошли в бой'); return; }
  var gone = Object.keys(roles).filter(function(r) { return self.roleSeen[r] && !here[r] && now - self.roleSeen[r] > LEAVE_LOSE; });
  if (!gone.length) return;
  if (gone.length === Object.keys(roles).length) { this.abort('все игроки покинули бой'); return; }
  var win = Object.keys(roles).filter(function(r) { return gone.indexOf(r) < 0; })[0];
  this.H.finish(win, 'Соперник покинул бой'); this.H.result.forfeit = true;
};
EventRoom.prototype.finish = function() {
  var self = this, H = this.H;
  this.finishing = true; this.endAt = Date.now();
  var res = { winner: H.result.winner, why: H.result.why, t: H.result.t, tasks: H.result.tasks, need: H.result.need, hp: H.result.hp, stats: H.result.stats, forfeit: !!H.result.forfeit, present: Object.keys(this.present) };
  this.cfg.log('info', 'ивент окончен', { room: this.name, winner: res.winner, why: res.why, t: res.t, forfeit: res.forfeit });
  // игроку — общий итог без чужих данных, своя награда и свои убийства
  this.endMsg = function(c) {
    var me = c.who && res.stats[c.who.user] || { kills: 0, lost: 0 };
    return JSON.stringify({ t: 'evend', result: { winner: res.winner, why: res.why, t: res.t, tasks: res.tasks, need: res.need, hp: res.hp, forfeit: res.forfeit }, me: me, awards: self.awardFor(c), saved: self.saved, test: !!self.match.test });
  };
  var done = function(aw, saved) {
    self.awards = Array.isArray(aw) ? aw : null; self.saved = !!saved;
    self.clients.forEach(function(c) { self.send(c, self.endMsg(c), true); });
  };
  if (this.cfg.dev && /^dev-/.test(this.matchId)) { done(null, true); return; }
  // запись итога: три попытки (сеть до базы может моргнуть)
  var tries = 0;
  (function save() {
    tries++;
    self.rpc('rt_event_finish', { p_match: self.matchId, p_result: res }).then(function(r) { done(r && r.awards || null, true); },
      function(e) { self.cfg.log('error', 'rt_event_finish', { room: self.name, err: e.message, try: tries }); if (tries < 3) setTimeout(save, 4000 * tries); else done(null, false); });
  })();
};
EventRoom.prototype.awardFor = function(c) {
  if (!this.awards || !c.who) return null;
  for (var i = 0; i < this.awards.length; i++) if (this.awards[i] && this.awards[i].user === c.who.user) return this.awards[i];
  return null;
};
EventRoom.prototype.abort = function(why) {
  if (this.closed) return;
  var self = this;
  this.cfg.log('warn', 'ивент отменён', { room: this.name, why: why });
  this.clients.forEach(function(c) { self.send(c, JSON.stringify({ t: 'evend', aborted: true, result: { why: 'Бой отменён: ' + why } }), true); });
  this.closed = true;
  if (!(this.cfg.dev && /^dev-/.test(this.matchId))) this.rpc('rt_event_abort', { p_match: this.matchId, p_why: why }).catch(function(e) { self.cfg.log('error', 'rt_event_abort', { err: e.message }); });
};

// ---- закрытие
EventRoom.prototype.shouldClose = function() {
  if (this.closed) return true;
  if (!this.ready) return Date.now() - this.created > START_WAIT * 2;
  if (this.H.result && this.endAt && Date.now() - this.endAt > END_KEEP) { this.closed = true; return true; }
  return false;
};
EventRoom.prototype.close = function(why) {
  this.closed = true; this.cfg.log('info', 'ивент закрыт', { room: this.name, why: why });
  // итог уже у игроков — отпустить соединения (иначе висят на замёрзшем бою и держат его в памяти)
  this.clients.slice().forEach(function(c) { try { c.ws.close(4008); } catch (e) {} });
  return Promise.resolve();
};
EventRoom.prototype.busy = function() { return this.ready && !this.closed && !(this.H && this.H.result) ? 1 : 0; };
EventRoom.prototype.info = function() {
  var B = this.B;
  return { room: this.name, kind: 'event', clients: this.clients.length, troops: B ? B.agents.filter(function(a) { return a.alive; }).length : 0, t: B ? Math.round(B.t) : 0,
           event: this.match && this.match.event, bytesPerClient: Math.round(this.bytesRate / Math.max(1, this.clients.length)) };
};

function parse(name) {
  var m = /^ev:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|dev-[a-z0-9_-]{4,60})$/.exec(String(name || ''));
  return m ? { match: m[1], key: 'ev:' + m[1] } : null;
}

module.exports = { EventRoom: EventRoom, parse: parse };
