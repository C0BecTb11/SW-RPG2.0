// Игровой сервер боёв в реальном времени — Star Wars: Global Conflict 2.0.
// Node 20+, без зависимостей. Считает бои, раздаёт их игрокам по WebSocket,
// пишет журнал и сердцебиение в Supabase (функции rt_*).
//
// Настройки — переменные окружения (на Hetzner: /etc/swrt.env):
//   RT_SERVER_KEY  ключ сервера (обязателен для записи в базу)
//   PUBLIC_URL     внешний адрес, например https://1-2-3-4.sslip.io
//   PORT           порт за Caddy, по умолчанию 8080
//   SUPABASE_URL, SUPABASE_ANON_KEY — по умолчанию проект игры
//   RT_DEV=1       только для замеров: вход без Supabase, токен «dev»

'use strict';

var http = require('http');
var path = require('path');
var childProcess = require('child_process');
var os = require('os');
var wsLite = require('./ws-lite');
var SWRT = require('../shared/rt-core.js');
var Space = require('./space-room.js');
var Ground = require('./ground-room.js');

var CFG = {
  port: +(process.env.PORT || 8080),
  host: process.env.HOST || '127.0.0.1',
  key: process.env.RT_SERVER_KEY || '',
  publicUrl: process.env.PUBLIC_URL || '',
  sbUrl: process.env.SUPABASE_URL || 'https://zqqaxhhajhgspaiwlyhy.supabase.co',
  sbKey: process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpxcWF4aGhhamhnc3BhaXdseWh5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU0NDMyNjIsImV4cCI6MjEwMTAxOTI2Mn0.oauDY1aq02uU1dHsoj_H50fi4owBDypn_hMHDalHOSw',
  dev: process.env.RT_DEV === '1',
  origins: (process.env.RT_ORIGINS || 'https://c0bectb11.github.io').split(',')
};

var VERSION = (function() {
  try { return childProcess.execSync('git rev-parse --short HEAD', { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
  catch (e) { return 'dev'; }
})();
var STARTED = Date.now();

// ---------- Supabase ----------
function rpc(fn, args, token) {
  return fetch(CFG.sbUrl + '/rest/v1/rpc/' + fn, {
    method: 'POST',
    headers: { apikey: CFG.sbKey, Authorization: 'Bearer ' + (token || CFG.sbKey), 'Content-Type': 'application/json' },
    body: JSON.stringify(args || {}),
    signal: AbortSignal.timeout(10000)
  }).then(function(r) {
    return r.text().then(function(t) {
      var body = null; try { body = t ? JSON.parse(t) : null; } catch (e) { body = t; }
      if (!r.ok) { var err = new Error((body && body.message) || ('HTTP ' + r.status)); err.status = r.status; throw err; }
      return body;
    });
  });
}

// Замеры без базы: ответы rt_ground_* из снимков планет (только RT_DEV)
var groundRpc = rpc;
if (CFG.dev && process.env.RT_GROUND_FIXTURE) groundRpc = require('./fixture-rpc.js').make(process.env.RT_GROUND_FIXTURE, function(l, m, d) { log(l, m, d); });

// ---------- журнал: в консоль и пачками в rt_server_log ----------
var LOG = { rows: [], dropped: 0 };
function log(level, msg, data) {
  var line = new Date().toISOString() + ' ' + level.toUpperCase() + ' ' + msg + (data ? ' ' + JSON.stringify(data) : '');
  (level === 'error' ? console.error : console.log)(line);
  if (LOG.rows.length < 2000) LOG.rows.push({ at: new Date().toISOString(), level: level, msg: String(msg).slice(0, 500), data: data || null });
  else LOG.dropped++;
}
function flushLog() {
  if (CFG.dev || !CFG.key) { LOG.rows.length = 0; return Promise.resolve(); }
  var rows = LOG.rows.splice(0, 500);
  if (LOG.dropped) { rows.push({ level: 'warn', msg: 'журнал: пропущено строк ' + LOG.dropped }); LOG.dropped = 0; }
  return rpc('rt_log', { p_key: CFG.key, p_rows: rows }).catch(function(e) {
    console.error('rt_log не записан: ' + e.message);
    if (LOG.rows.length < 1500) LOG.rows = rows.concat(LOG.rows);   // попробуем в следующий раз
  });
}

// ---------- вход игрока: токен Supabase ----------
var TOKENS = new Map();   // токен → { user, side, nick, until }
function verify(token) {
  if (CFG.dev && token === 'dev') return Promise.resolve({ user: 'dev', side: 0, nick: 'dev' });
  // замеры с союзниками: «dev:имя» — отдельный игрок (места, свои корабли)
  if (CFG.dev && /^dev:[a-z0-9]{1,12}$/.test(String(token))) return Promise.resolve({ user: token, side: 0, nick: token.slice(4) });
  if (typeof token !== 'string' || token.length < 20 || token.length > 4096) return Promise.reject(new Error('нет токена'));
  var hit = TOKENS.get(token);
  if (hit && hit.until > Date.now()) return Promise.resolve(hit);
  return fetch(CFG.sbUrl + '/auth/v1/user', {
    headers: { apikey: CFG.sbKey, Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(8000)
  }).then(function(r) {
    if (!r.ok) throw new Error('вход не подтверждён (' + r.status + ')');
    return r.json();
  }).then(function(u) {
    // фракция — из профиля (RLS отдаёт игроку его собственную строку)
    return fetch(CFG.sbUrl + '/rest/v1/profiles?select=faction,nickname&id=eq.' + encodeURIComponent(u.id), {
      headers: { apikey: CFG.sbKey, Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(8000)
    }).then(function(r) { return r.ok ? r.json() : []; }).catch(function() { return []; }).then(function(rows) {
      var p = rows && rows[0] || {};
      var who = { user: u.id, side: p.faction === 'cis' ? 1 : 0, nick: String(p.nickname || '').slice(0, 40), until: Date.now() + 5 * 60e3 };
      TOKENS.set(token, who);
      if (TOKENS.size > 500) TOKENS.delete(TOKENS.keys().next().value);
      return who;
    });
  });
}

// ---------- комнаты ----------
// Нагрузочные бои прототипа (p500, p2000) и тестовые космические бои на двоих
// (sp:код:бой — space-room.js).
var ROOMS = new Map();
var PROTO = { p500: 1, p2000: 1 };
var SPACE_MAX = 8;          // космический бой с экипажами тяжёлый: до 8 комнат на сервер

var GROUND_MAX = 12;        // живых планет на сервер

function getRoom(name, cfg) {
  var gp = Ground.parse(name);
  if (gp) {
    var g = ROOMS.get(gp.key);
    if (g && !g.closed) return g;
    if (!Ground.hasMap(gp.system)) return null;
    var ng = 0; ROOMS.forEach(function(x) { if (x.kind === 'ground' && !x.closed) ng++; });
    if (ng >= GROUND_MAX) return null;
    g = new Ground.GroundRoom(gp.key, gp.system, { rpc: groundRpc, key: CFG.key, log: log, dev: CFG.dev });
    g.ms = [];
    ROOMS.set(gp.key, g);
    log('info', 'комната планеты создана', { room: gp.key });
    return g;
  }
  var sp = Space.parse(name);
  // космическая комната — по коду: бой задаёт тот, кто её создал
  if (sp) name = sp.key;
  var r = ROOMS.get(name);
  if (r) return r;
  if (sp) {
    var n = 0; ROOMS.forEach(function(x) { if (x.kind === 'space') n++; });
    if (n >= SPACE_MAX) return null;
    r = new Space.SpaceRoom(name, sp.code, sp.scen, cfg ? Space.cfgClean(cfg) : null);
    r.dev = CFG.dev;
    r.ms = []; r.emptySince = Date.now(); r.created = Date.now();
    ROOMS.set(name, r);
    log('info', 'комната создана', { room: name });
    return r;
  }
  if (!Object.prototype.hasOwnProperty.call(PROTO, name)) return null;
  var sc = SWRT.makeScenario(name, 1977 + Math.floor(Math.random() * 1000));
  r = new SWRT.Room({ battle: sc.battle, ai: sc.ai, name: name });
  r.ms = []; r.emptySince = Date.now(); r.created = Date.now();
  ROOMS.set(name, r);
  log('info', 'комната создана', { room: name, troops: sc.battle.counts().total });
  return r;
}

// ---------- такт: 10 раз в секунду, без накопления опоздания ----------
var TICK_MS = SWRT.TICK * 1000;
var tickN = 0, nextAt = Date.now() + TICK_MS, late = 0;
function loop() {
  var t0 = SWRT.now();
  ROOMS.forEach(function(r, name) {
    if (r.kind === 'ground') {
      // планета живёт и без игроков, пока идёт бой; закрывается после тишины
      if (r.closed) { ROOMS.delete(name); return; }
      if (r.shouldClose()) { r.close('quiet'); ROOMS.delete(name); return; }
    } else if (!r.clients.length) {
      if (Date.now() - r.emptySince > 5 * 60e3) { ROOMS.delete(name); log('info', 'комната закрыта: никого нет', { room: name }); }
      return;
    }
    var a = SWRT.now();
    try { r.step(); }
    catch (e) { log('error', 'ошибка в такте', { room: name, err: String(e && e.stack || e).slice(0, 400) }); }
    r.ms.push(SWRT.now() - a);
    if (r.ms.length > 600) r.ms.shift();
    if (r.kind !== 'space' && r.kind !== 'ground' && r.battle.tick % 10 === 0) {
      var st = r.statFor({ srvMs: Math.round((SWRT.now() - a) * 100) / 100, cpu: CPU.pct, ver: VERSION });
      for (var i = 0; i < r.clients.length; i++) r.send(r.clients[i], st);
    }
  });
  tickN++;
  var spent = SWRT.now() - t0;
  nextAt += TICK_MS;
  var wait = nextAt - Date.now();
  if (wait < 0) { late++; nextAt = Date.now() + TICK_MS; wait = TICK_MS; }
  if (spent > TICK_MS * 0.8) log('warn', 'такт не укладывается', { ms: Math.round(spent) });
  setTimeout(loop, Math.max(0, wait));
}

// ---------- загрузка процессора ----------
var CPU = { pct: 0, last: process.cpuUsage(), at: Date.now() };
setInterval(function() {
  var u = process.cpuUsage(CPU.last), dt = (Date.now() - CPU.at) * 1000;
  CPU.pct = Math.round((u.user + u.system) / dt * 1000) / 10;
  CPU.last = process.cpuUsage(); CPU.at = Date.now();
}, 2000).unref();

function pct(arr, p) {
  if (!arr.length) return 0;
  var s = arr.slice().sort(function(a, b) { return a - b; });
  return Math.round(s[Math.min(s.length - 1, Math.floor(s.length * p))] * 100) / 100;
}

function health() {
  var rooms = [];
  var busy = 0;   // идущие космические бои; прототипы перезапуску не мешают
  ROOMS.forEach(function(r, name) {
    if (r.kind === 'space' || r.kind === 'ground') { busy += r.busy(); var inf = r.info(); inf.tickP50 = pct(r.ms, 0.5); inf.tickP95 = pct(r.ms, 0.95); rooms.push(inf); return; }
    var c = r.battle.counts();
    rooms.push({ room: name, clients: r.clients.length, troops: c.total, squads: c.squads[0] + c.squads[1],
                 singles: c.singles, lod: r.battle.lod, tickP50: pct(r.ms, 0.5), tickP95: pct(r.ms, 0.95),
                 bytesPerClient: Math.round(r.bytesRate / Math.max(1, r.clients.length)) });
  });
  return { ok: true, version: VERSION, uptime: Math.round((Date.now() - STARTED) / 1000), cpu: CPU.pct,
           memMb: Math.round(process.memoryUsage().rss / 1048576), late: late, busy: busy, rooms: rooms };
}

// ---------- HTTP ----------
var server = http.createServer(function(req, res) {
  var url = req.url.split('?')[0];
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  if (url === '/health' || url === '/') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(health()));
    return;
  }
  res.statusCode = 404; res.end('not found');
});

// ---------- WebSocket ----------
var CLIENTS = new Set();
server.on('upgrade', function(req, sock, head) {
  if (req.url.split('?')[0] !== '/ws') { sock.destroy(); return; }
  var origin = req.headers.origin || '';
  if (origin && !CFG.dev && CFG.origins.indexOf(origin) < 0 && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
    sock.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
  }
  var ws = wsLite.accept(req, sock, head);
  if (!ws) return;
  var c = { ws: ws, side: 0, room: null, who: null, msgs: 0, msgWin: Date.now(), ip: req.headers['x-forwarded-for'] || sock.remoteAddress,
            send: function(buf) {
              // медленный игрок: не копим очередь — пропускаем такт и потом шлём бой заново
              if (ws.bufferedAmount > 2 * 1048576) { c.resync = true; return; }
              if (c.resync && c.room && c.room.kind !== 'space' && c.room.kind !== 'ground') { c.resync = false; ws.send(SWRT.encodeInit(c.room.battle, c.side, c.room.extra)); return; }
              ws.send(buf);
            } };
  CLIENTS.add(c);
  var authTimer = setTimeout(function() { if (!c.who) ws.close(4001); }, 10000);
  ws.on('message', function(data, binary) {
    var t = Date.now();
    if (t - c.msgWin > 1000) { c.msgWin = t; c.msgs = 0; }
    if (++c.msgs > 30) return;                  // не больше 30 сообщений в секунду
    if (binary) return;
    var m; try { m = JSON.parse(data); } catch (e) { return; }
    if (!m || typeof m !== 'object' || Array.isArray(m)) return;
    if (!c.who) {
      if (m.t !== 'auth' || c.authing) return;      // один вход на соединение
      c.authing = true;
      verify(m.token).then(function(who) {
        clearTimeout(authTimer);
        if (!ws.open) return;
        // сторона — из профиля игрока; выбрать её самому можно только в замерах
        c.who = who; c.side = (CFG.dev && (m.side === 0 || m.side === 1)) ? m.side : who.side;
        var r = getRoom(String(m.room || 'p500').slice(0, 40), m.cfg);
        if (!r) { ws.send(JSON.stringify({ t: 'error', msg: Space.parse(String(m.room || '')) ? 'Сервер занят: все комнаты боя заняты, попробуй позже' : Ground.parse(String(m.room || '')) ? 'Сервер занят или планета без карты' : 'нет такого боя' })); ws.close(4004); return; }
        if (r.kind === 'space') {
          c.side = -1;
          if (!r.join(c, m.side)) return;
        } else if (r.kind === 'ground') {
          if (!r.join(c)) return;
        } else r.join(c);
        c.room = r;
        log('info', 'игрок вошёл', { room: r.name, user: who.user, nick: who.nick, side: c.side });
      }, function(e) {
        c.authing = false;
        ws.send(JSON.stringify({ t: 'error', msg: e.message })); ws.close(4003);
      });
      return;
    }
    if (m.t === 'ping') { ws.send(JSON.stringify({ t: 'pong', at: m.at, tick: c.room ? c.room.battle.tick : 0 })); return; }
    if (c.room) {
      try { c.room.command(c, m); }
      catch (e) { log('error', 'ошибка приказа', { err: String(e).slice(0, 300) }); }
    }
  });
  ws.on('close', function() {
    clearTimeout(authTimer);
    CLIENTS.delete(c);
    if (c.room) {
      c.room.leave(c);
      if (!c.room.clients.length) c.room.emptySince = Date.now();
      log('info', 'игрок вышел', { room: c.room.name, user: c.who && c.who.user, kb: Math.round((c.bytes || 0) / 1024) });
    }
  });
});

// ping каждые 20 с; кто молчит 40 с — отключаем
setInterval(function() {
  CLIENTS.forEach(function(c) {
    if (!c.ws.alive) { c.ws.terminate(); return; }
    c.ws.alive = false; c.ws.ping();
  });
}, 20000).unref();

// ---------- сводка раз в минуту + сердцебиение ----------
setInterval(function() {
  var h = health();
  log('info', 'сводка', { cpu: h.cpu, memMb: h.memMb, clients: CLIENTS.size, late: h.late, rooms: h.rooms });
}, 60000).unref();
setInterval(flushLog, 10000).unref();
setInterval(function() {
  if (CFG.dev || !CFG.key || LOG.rows.length) return;      // журнал сам обновит «на связи»
  rpc('rt_log', { p_key: CFG.key, p_rows: [] }).catch(function(e) { console.error('сердцебиение: ' + e.message); });
}, 20000).unref();

// ---------- старт и остановка ----------
function hello() {
  if (CFG.dev || !CFG.key) { log('warn', 'режим без базы: ' + (CFG.dev ? 'RT_DEV' : 'нет RT_SERVER_KEY')); return; }
  rpc('rt_server_hello', { p_key: CFG.key, p_url: CFG.publicUrl, p_version: VERSION,
                           p_info: { node: process.version, cpus: os.cpus().length, memMb: Math.round(os.totalmem() / 1048576) } })
    .then(function(active) { log('info', 'сервер на связи с базой', { url: CFG.publicUrl, version: VERSION, activeBattles: (active || []).length }); })
    .catch(function(e) { log('error', 'rt_server_hello не прошёл', { err: e.message }); setTimeout(hello, 30000); });
}

server.listen(CFG.port, CFG.host, function() {
  log('info', 'сервер запущен', { port: CFG.port, version: VERSION, node: process.version });
  hello();
  setTimeout(loop, TICK_MS);
});

function stop(sig) {
  log('info', 'остановка: ' + sig);
  CLIENTS.forEach(function(c) { c.ws.close(1012); });
  flushLog().then(function() { process.exit(0); });
  setTimeout(function() { process.exit(0); }, 3000).unref();
}
process.on('SIGTERM', function() { stop('SIGTERM'); });
process.on('SIGINT', function() { stop('SIGINT'); });
// Неизвестная ошибка: записать и выйти — systemd поднимет сервер заново
process.on('uncaughtException', function(e) {
  log('error', 'необработанная ошибка', { err: String(e && e.stack || e).slice(0, 800) });
  flushLog().then(function() { process.exit(1); });
  setTimeout(function() { process.exit(1); }, 3000).unref();
});

module.exports = { server: server, health: health, CFG: CFG };
