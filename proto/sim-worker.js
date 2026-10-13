// Прототип: «сервер в браузере». Тот же расчёт (shared/rt-core.js) и тот же
// двоичный поток, что у игрового сервера, только в отдельном потоке Worker.
// Основной поток страницы получает ровно то, что получал бы по WebSocket.

importScripts('../shared/rt-core.js');

var room = null, client = null, timer = null, nextAt = 0, scen = '';

function send(buf) { postMessage(buf, [buf]); }

function start(name, side) {
  stop();
  var sc = SWRT.makeScenario(name, 1977);
  scen = name;
  room = new SWRT.Room({ battle: sc.battle, ai: sc.ai, name: name });
  client = { side: side || 0, send: send };
  room.join(client);
  nextAt = Date.now() + 100;
  loop();
}

function stop() { if (timer) clearTimeout(timer); timer = null; room = null; }

function loop() {
  if (!room) return;
  var a = SWRT.now();
  room.step();
  var ms = SWRT.now() - a;
  if (room.battle.tick % 10 === 0) send(room.statFor({ srvMs: Math.round(ms * 100) / 100, src: 'worker' }));
  nextAt += 100;
  var wait = nextAt - Date.now();
  if (wait < 0) { nextAt = Date.now() + 100; wait = 0; }
  timer = setTimeout(loop, wait);
}

onmessage = function(e) {
  var m = e.data;
  if (!m || typeof m !== 'object') return;
  if (m.t === 'start') { start(m.room, m.side); return; }
  if (m.t === 'stop') { stop(); return; }
  if (room && client) room.command(client, m);
};
