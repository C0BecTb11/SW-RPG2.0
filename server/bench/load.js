// Нагрузочный замер сервера: поднимает сервер (RT_DEV=1), подключает игроков
// по WebSocket, гоняет бой и печатает: такт сервера, процессор, трафик на
// игрока, задержку приказа. Запуск: node server/bench/load.js [секунд] [игроков]

'use strict';
var cp = require('child_process'), path = require('path');
var SECS = +process.argv[2] || 90, N = +process.argv[3] || 10, PORT = 18080 + Math.floor(Math.random() * 1000);

function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }
function health() { return fetch('http://127.0.0.1:' + PORT + '/health').then(function(r) { return r.json(); }); }

function client(room, i) {
  return new Promise(function(resolve) {
    var ws = new WebSocket('ws://127.0.0.1:' + PORT + '/ws');
    ws.binaryType = 'arraybuffer';
    var st = { bytes: 0, msgs: 0, rtt: [], init: 0, ws: ws, side: i % 2 };
    ws.onopen = function() { ws.send(JSON.stringify({ t: 'auth', token: 'dev', room: room, side: st.side })); };
    ws.onmessage = function(e) {
      if (typeof e.data === 'string') { var m = JSON.parse(e.data); if (m.t === 'pong') st.rtt.push(Date.now() - m.at); return; }
      st.bytes += e.data.byteLength; st.msgs++;
      if (new Uint8Array(e.data)[0] === 1) { st.init = e.data.byteLength; resolve(st); }
    };
    ws.onerror = function(e) { console.error('ws error', e.message); };
  });
}

async function run(room) {
  var srv = cp.spawn(process.execPath, [path.join(__dirname, '..', 'index.js')], { env: Object.assign({}, process.env, { RT_DEV: '1', PORT: String(PORT) }), stdio: ['ignore', 'pipe', 'pipe'] });
  var out = ''; srv.stdout.on('data', function(d) { out += d; }); srv.stderr.on('data', function(d) { out += d; });
  for (var k = 0; k < 50; k++) { try { await health(); break; } catch (e) { await sleep(100); } }
  var cs = [];
  for (var i = 0; i < N; i++) cs.push(await client(room, i));
  var W = room === 'p2000' ? 8 : 5;
  var t0 = Date.now(), lastPing = 0, b0 = cs.map(function(c) { return c.bytes; }), samples = [];
  while (Date.now() - t0 < SECS * 1000) {
    // каждый игрок смотрит на свой кусок карты и двигает камеру
    cs.forEach(function(c, j) {
      var x = Math.floor(Math.random() * (W - 2)), y = Math.floor(Math.random() * (W - 2));
      c.ws.send(JSON.stringify({ t: 'sub', r: [x, y, x + 1, y + 1] }));
      if (Math.random() < 0.5) c.ws.send(JSON.stringify({ t: 'order', k: 'move', sq: [1 + Math.floor(Math.random() * 300), 1 + Math.floor(Math.random() * 300)], x: Math.random() * W * 32, y: Math.random() * W * 32 }));
      c.ws.send(JSON.stringify({ t: 'ping', at: Date.now() }));
    });
    await sleep(5000);
    var h = await health(); samples.push(h);
  }
  var secs = (Date.now() - t0) / 1000;
  var h2 = samples[samples.length - 1], r = h2.rooms[0] || {};
  var rtt = [].concat.apply([], cs.map(function(c) { return c.rtt; })).sort(function(a, b) { return a - b; });
  var bps = cs.map(function(c, j) { return (c.bytes - b0[j]) / secs; });
  var cpu = samples.slice(2).map(function(s) { return s.cpu; });
  var res = {
    room: room, players: N, seconds: Math.round(secs), troops: r.troops, squads: r.squads, singles: r.singles,
    tickP50ms: r.tickP50, tickP95ms: r.tickP95, lod: r.lod, lateTicks: h2.late,
    cpuAvgPct: Math.round(cpu.reduce(function(a, b) { return a + b; }, 0) / Math.max(1, cpu.length) * 10) / 10,
    cpuMaxPct: Math.max.apply(null, cpu.concat([0])), memMb: h2.memMb,
    initKB: Math.round(cs[0].init / 1024 * 10) / 10,
    bytesPerPlayerAvg: Math.round(bps.reduce(function(a, b) { return a + b; }, 0) / bps.length),
    bytesPerPlayerMax: Math.round(Math.max.apply(null, bps)),
    rttP50ms: rtt[rtt.length >> 1], rttMaxMs: rtt[rtt.length - 1]
  };
  cs.forEach(function(c) { c.ws.close(); });
  srv.kill('SIGTERM');
  await sleep(300);
  if (/ERROR/.test(out)) console.log(out.split('\n').filter(function(l) { return /ERROR|WARN/.test(l); }).slice(0, 10).join('\n'));
  return res;
}

(async function() {
  var rows = [];
  for (var room of ['p500', 'p2000']) rows.push(await run(room));
  console.log(JSON.stringify(rows, null, 1));
})();
