#!/usr/bin/env node
// Сверка каталога ивентов: shared/rt-events-cat.js ↔ sql/events.sql (роли, карты, награды,
// титулы, готовность) и наличие карт shared/events/maps и картинок assets/events.
//   node tools/events/check.js
'use strict';
const fs = require('fs');
const path = require('path');
const CAT = require('../../shared/rt-events-cat.js');
const root = path.join(__dirname, '../..');
const sql = fs.readFileSync(path.join(root, 'sql/events.sql'), 'utf8');
let bad = 0;
const err = m => { bad++; console.log('✗ ' + m); };

// строки каталога в insert: ('id', 'kind', 'theater', '{sides}', 'title', 'troops', ready, 'roles', '{maps}', '{minutes}', cr, 'res', 'titles', sort)
const rowRe = /\(\s*'([a-z_0-9]+)', '(pvp|pve)', '(ground|space)', '\{([a-z,]+)\}', '([^']*)', '(event|own)', (true|false),\s*'(\[.*?\])',\s*'\{([a-z0-9_,]*)\}', '\{([0-9,]+)\}', (\d+), '(\{.*?\})', '(\{.*?\})', (\d+)\)/gs;
const rows = {};
let m;
while ((m = rowRe.exec(sql))) rows[m[1]] = { kind: m[2], theater: m[3], sides: m[4].split(','), title: m[5], troops: m[6], ready: m[7] === 'true', roles: JSON.parse(m[8]), maps: m[9] ? m[9].split(',') : [], minutes: m[10].split(',').map(Number), cr: +m[11], res: JSON.parse(m[12]), titles: JSON.parse(m[13]) };

CAT.LIST.forEach(E => {
  const r = rows[E.id];
  if (!r) return err(E.id + ': нет в sql/events.sql');
  if (r.kind !== E.kind || r.theater !== E.theater || r.troops !== E.troops) err(E.id + ': вид, театр или войска не совпадают');
  if (r.sides.join() !== E.sides.join()) err(E.id + ': стороны ' + r.sides + ' ≠ ' + E.sides);
  if (r.title !== E.title) err(E.id + ': название «' + r.title + '» ≠ «' + E.title + '»');
  if (r.ready !== E.ready) err(E.id + ': готовность не совпадает');
  if (r.cr !== E.reward.cr || JSON.stringify(r.res) !== JSON.stringify(E.reward.res)) err(E.id + ': награда не совпадает');
  if (JSON.stringify(r.titles) !== JSON.stringify(E.titles)) err(E.id + ': титулы не совпадают');
  if (r.maps.join() !== E.maps.join()) err(E.id + ': карты не совпадают');
  if (E.minutes && r.minutes.join() !== E.minutes.join()) err(E.id + ': время не совпадает');
  const rr = r.roles.map(x => [x.id, x.side, x.min, x.max].join(':')).join(), er = E.roles.map(x => [x.id, x.side, x.min, x.max].join(':')).join();
  if (rr !== er) err(E.id + ': роли ' + rr + ' ≠ ' + er);
  E.maps.forEach(mp => {
    if (!fs.existsSync(path.join(root, 'shared/events/maps', mp + '.json'))) err(E.id + ': нет карты ' + mp);
    if (!fs.existsSync(path.join(root, 'assets/events', mp + '.jpg'))) err(E.id + ': нет картинки карты ' + mp);
  });
});
Object.keys(rows).forEach(id => { if (!CAT.BY[id]) err(id + ': есть в базе, нет в каталоге'); });
const per = s => CAT.forSide(s).length;
console.log((bad ? '✗' : '✓') + ' ивентов ' + CAT.LIST.length + ' (в базе ' + Object.keys(rows).length + '), Республика ' + per('republic') + ', КНС ' + per('cis') + ', готово ' + CAT.LIST.filter(e => e.ready).length);
process.exit(bad ? 1 : 0);
