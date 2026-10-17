#!/usr/bin/env node
// Маски проходимости планет для базы (planet_maps): по клетке «1» — можно стоять, «0» — нет.
// Пять масок: foot1 (пехота), track1/track2 (гусеницы и шагоходы 1×1 и 2×2), hover1/hover2
// (репульсоры). Для 2×2 бит стоит на верхней левой клетке. Город (стены, кварталы) сюда не
// входит: его накладывает сервер при открытии комнаты (rt_ground_map).
//   node tools/planets/masks.js            → sql/planet_maps_seed.sql
//   node tools/planets/masks.js --json id  → маски одной планеты в stdout (для сервера)
'use strict';
const fs = require('fs'), path = require('path');
const P = require('../../shared/rt-planets.js');
const N = P.N;

function masks(json) {
  const m = P.load(json), n = N * N, out = {};
  [['foot', 1], ['track', 1], ['track', 2], ['hover', 1], ['hover', 2]].forEach(([mv, size]) => {
    let s = '';
    for (let k = 0; k < n; k++) {
      const x = k % N, y = (k - x) / N;
      let ok;
      if (size === 1) ok = P.speed(m, x, y, mv) > 0;
      else ok = x + 2 <= N && y + 2 <= N && P.canBox(m, x, y, 2, mv);
      s += ok ? '1' : '0';
    }
    out[mv + size] = s;
  });
  return out;
}

if (require.main === module) {
  const dir = path.join(__dirname, '../../shared/planets');
  if (process.argv[2] === '--json') {
    const id = process.argv[3];
    process.stdout.write(JSON.stringify(masks(JSON.parse(fs.readFileSync(path.join(dir, id + '.json'), 'utf8')))));
    process.exit(0);
  }
  const list = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
  let sql = '-- Маски проходимости 20 планет (tools/planets/masks.js). Повторный запуск обновляет строки.\n';
  list.forEach(p => {
    const mk = masks(JSON.parse(fs.readFileSync(path.join(dir, p.id + '.json'), 'utf8')));
    sql += `insert into public.planet_maps (system_id, w, h, foot1, track1, track2, hover1, hover2, version)\n` +
      `values ('${p.id}', ${N}, ${N}, '${mk.foot1}', '${mk.track1}', '${mk.track2}', '${mk.hover1}', '${mk.hover2}', 'base')\n` +
      `on conflict (system_id) do update set w = excluded.w, h = excluded.h, foot1 = excluded.foot1, track1 = excluded.track1, track2 = excluded.track2, hover1 = excluded.hover1, hover2 = excluded.hover2, version = excluded.version, updated_at = now();\n`;
  });
  fs.writeFileSync(path.join(__dirname, '../../sql/planet_maps_seed.sql'), sql);
  console.log('записано планет: ' + list.length + ', ' + Math.round(sql.length / 1024) + ' КБ');
}
module.exports = { masks };
