// Замеры без базы (RT_DEV): ответы функций rt_ground_* из файлов-снимков планет.
// RT_GROUND_FIXTURE=/путь/к/папке — там <планета>.json (ответ rt_ground_state + units).
// Погибшие (hp 0 из rt_ground_sync) из снимка уходят, как ушли бы из базы.
'use strict';
var fs = require('fs');
var path = require('path');

function make(dir, log) {
  var fx = {};
  function load(system) {
    if (!fx[system]) {
      var p = path.join(dir, system + '.json');
      if (!fs.existsSync(p)) throw new Error('нет снимка планеты ' + system);
      fx[system] = JSON.parse(fs.readFileSync(p, 'utf8'));
      fx[system].battle_id = fx[system].battle_id || '00000000-0000-0000-0000-00000000' + String(1000 + Object.keys(fx).length).slice(-4);
    }
    return fx[system];
  }
  var bySys = {};
  return function(fn, args) {
    try {
      if (fn === 'rt_ground_open') { var st = load(args.p_system); bySys[st.battle_id] = args.p_system; return Promise.resolve(JSON.parse(JSON.stringify(st))); }
      if (fn === 'rt_ground_pull') { var s2 = load(bySys[args.p_battle] || args.p_system); return Promise.resolve(JSON.parse(JSON.stringify(s2))); }
      if (fn === 'rt_ground_sync') {
        var s3 = load(bySys[args.p_battle]), dead = {};
        (args.p_units || []).forEach(function(r) { if (r.hp <= 0) dead[r.id] = 1; else { var u = s3.units.filter(function(x) { return x.id === r.id; })[0]; if (u) { u.x = r.x; u.y = r.y; u.hp = r.hp; } } });
        s3.units = s3.units.filter(function(u) { return !dead[u.id]; });
        (args.p_structs || []).forEach(function(r) { var st3 = s3.structs.filter(function(x) { return x.id === r.id; })[0]; if (st3) st3.hp = r.hp; });
        if (log) log('info', 'снимок: записано', { units: (args.p_units || []).length, dead: Object.keys(dead).length, structs: (args.p_structs || []).length });
        return Promise.resolve({ units: (args.p_units || []).length, structs: (args.p_structs || []).length });
      }
      if (fn === 'rt_ground_act') {
        var s4 = null; for (var k in bySys) s4 = load(bySys[k]);
        if (s4 && args.p_fn === 'build_structure') s4.structs.push({ id: 'fx-' + Date.now(), kind: String(args.p_args.type).replace(/^(cis|rep)_/, ''), type: args.p_args.type, x: args.p_args.x, y: args.p_args.y, w: 2, h: 1, hp: 300, hpMax: 300, faction: s4.system.faction, building: false });
        else if (s4) s4.units = s4.units.filter(function(u) { return u.id !== args.p_args.unit; });
        return Promise.resolve({ ok: true });
      }
      if (fn === 'rt_ground_map' || fn === 'rt_ground_close' || fn === 'rt_log' || fn === 'rt_server_hello') return Promise.resolve(true);
      return Promise.reject(new Error('снимок: нет функции ' + fn));
    } catch (e) { return Promise.reject(e); }
  };
}
module.exports = { make: make };
