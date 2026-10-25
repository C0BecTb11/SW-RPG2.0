#!/usr/bin/env node
// Прогон обороны ботами: доля побед гарнизона по картам, уровням и числу игроков.
//   node tools/events/sim-defense.js [r_tessara|c_siege] [боёв на клетку=4] [уровень=все] [игроков=1..4]
// Боты гарнизона слабее людей (держат посты и бросаются на прорвавшихся), поэтому ориентир по
// ботам: I — гарнизон почти всегда держится, II — чаще держится, III — около половины.
'use strict';
const fs = require('fs');
const path = require('path');
const GR = require('../../shared/rt-ground.js');
const EV = require('../../shared/rt-events.js');
const CAT = require('../../shared/rt-events-cat.js');

const evId = process.argv[2] || 'r_tessara', runs = +(process.argv[3] || 4);
const tiers = process.argv[4] ? [+process.argv[4]] : [1, 2, 3], counts = process.argv[5] ? [+process.argv[5]] : [1, 2, 3, 4];
const E = CAT.BY[evId];

function battle(mapId, tier, n, seed) {
  const js = JSON.parse(fs.readFileSync(path.join(__dirname, '../../shared/events/maps', mapId + '.json')));
  const B = new GR.Ground(js, { seed: seed, noTown: true, auto0: false, auto1: false, att: 0, weather: js.night || 0 });
  const players = [];
  for (let i = 0; i < n; i++) players.push({ user: 'bot:defender:' + i, role: 'defender', bot: true });
  const H = EV.create(B, { event: evId, tier: tier, map: js, players: players, seed: seed * 7 + 1 });
  H.setup();
  let maxA = 0;
  for (let s = 0; s < 25 * 60 * 20 && !H.result; s++) { B.step(0.05); if (s % 2 === 1) H.step(); if (s % 200 === 0) maxA = Math.max(maxA, B.agents.filter(a => a.alive).length); }
  const r = H.result || { winner: '?', why: 'не кончился', t: Math.round(B.t), tasks: H.cleared, need: H.W, hp: H.hp };
  r.maxA = maxA; r.agents = B.agents.length;
  return r;
}

const t0 = Date.now();
tiers.forEach(tier => {
  counts.forEach(n => {
    const row = [], why = {};
    let wins = 0, cnt = 0, tsum = 0, hpSum = 0, wav = 0, maxA = 0, ag = 0;
    E.maps.forEach(m => {
      let w = 0;
      for (let r = 0; r < runs; r++) {
        const res = battle(m, tier, n, 1000 + r * 37 + tier * 5 + n);
        if (res.winner === 'defender') { w++; hpSum += res.hp || 0; }
        why[res.why] = (why[res.why] || 0) + 1; tsum += res.t; cnt++; wav += res.tasks || 0; maxA = Math.max(maxA, res.maxA); ag = Math.max(ag, res.agents);
      }
      wins += w; row.push(m + ' ' + w + '/' + runs);
    });
    console.log('ур.' + tier + ' игроков ' + n + ': гарнизон ' + Math.round(wins / cnt * 100) + '%  ' + row.join('  ') + '  ср. ' + Math.round(tsum / cnt) + ' с, волн ' + (wav / cnt).toFixed(1) +
      (wins ? ', прочность у победителей ' + Math.round(hpSum / wins) + '%' : '') + ', живых до ' + maxA + ', всего бойцов ' + ag + '  | ' + Object.keys(why).map(k => k + ' ' + why[k]).join('; '));
  });
});
console.log('за ' + Math.round((Date.now() - t0) / 1000) + ' с');
