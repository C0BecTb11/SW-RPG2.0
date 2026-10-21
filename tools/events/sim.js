#!/usr/bin/env node
// Прогон охот ботами: доля побед добычи по картам, уровням и числу охотников.
//   node tools/events/sim.js [hunt_sith|hunt_jedi] [боёв на клетку=6] [уровень=все] [охотников=1..4]
// Баланс подбирается так, чтобы на среднем числе охотников добыча выигрывала около половины.
'use strict';
const fs = require('fs');
const path = require('path');
const GR = require('../../shared/rt-ground.js');
const P = require('../../shared/rt-planets.js');
const EV = require('../../shared/rt-events.js');
const CAT = require('../../shared/rt-events-cat.js');

const evId = process.argv[2] || 'hunt_sith', runs = +(process.argv[3] || 6);
const tiers = process.argv[4] ? [+process.argv[4]] : [1, 2, 3], counts = process.argv[5] ? [+process.argv[5]] : [1, 2, 3, 4];
const E = CAT.BY[evId];

function battle(mapId, tier, nh, seed, jedi2) {
  const js = JSON.parse(fs.readFileSync(path.join(__dirname, '../../shared/events/maps', mapId + '.json')));
  const B = new GR.Ground(js, { seed: seed, noTown: true, auto0: false, auto1: false, att: 0, weather: js.night || 0 });
  const prey = evId === 'hunt_sith' ? 'sith' : 'jedi', players = [];
  for (let i = 0; i < (jedi2 ? 2 : 1); i++) players.push({ user: 'bot:' + prey + ':' + i, role: prey, bot: true });
  for (let i = 0; i < nh; i++) players.push({ user: 'bot:hunter:' + i, role: 'hunter', bot: true });
  const H = EV.create(B, { event: evId, tier: tier, map: js, players: players, seed: seed * 7 + 1 });
  H.setup();
  for (let s = 0; s < 20 * 60 * 25 && !H.result; s++) { B.step(0.05); if (s % 2 === 1) H.step(); }
  return H.result || { winner: '?', why: 'не кончился', t: Math.round(B.t) };
}

const t0 = Date.now(), tot = {};
tiers.forEach(tier => {
  counts.forEach(nh => {
    const row = [], why = {};
    let pw = 0, n = 0, tsum = 0;
    E.maps.forEach(m => {
      let w = 0;
      for (let r = 0; r < runs; r++) {
        const res = battle(m, tier, nh, 1000 + r * 37 + tier * 5 + nh, evId === 'hunt_jedi' && nh >= 3 && r % 2 === 0);
        if (res.winner !== 'hunter') w++;
        why[res.why] = (why[res.why] || 0) + 1; tsum += res.t; n++;
      }
      pw += w; row.push(m + ' ' + w + '/' + runs);
    });
    console.log('ур.' + tier + ' охотников ' + nh + ': добыча ' + Math.round(pw / n * 100) + '%  ' + row.join('  ') + '  ср. ' + Math.round(tsum / n) + ' с  | ' + Object.keys(why).map(k => k + ' ' + why[k]).join('; '));
  });
});
console.log('за ' + Math.round((Date.now() - t0) / 1000) + ' с');
