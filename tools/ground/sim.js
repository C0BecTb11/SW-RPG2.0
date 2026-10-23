#!/usr/bin/env node
// Прогон наземного боя без экрана: типовые армии обеих сторон, ИИ против ИИ.
//   node tools/ground/sim.js [planet] [seconds]
// Печатает ход боя, проверяет инварианты (никто не в скале, не за краем, hp в пределах),
// меряет скорость шага.
'use strict';
const path = require('path');
const G = require('../../shared/rt-ground.js');
const P = require('../../shared/rt-planets.js');
const U = require('../../shared/rt-units.js');

// Типовая армия для полигона: [тип, число]
const ARMY = {
  0: [['rep_dc15a', 24], ['rep_heavy', 6], ['rep_sniper', 3], ['rep_launcher', 4], ['rep_arc', 4], ['rep_medic', 2], ['rep_engineer', 1], ['rep_jedi', 1],
      ['rep_atte', 2], ['rep_atrt', 3], ['rep_barc', 2], ['rep_aa', 1], ['rep_laat', 1], ['rep_artillery', 1], ['rep_turbo', 1]],
  1: [['cis_b1', 36], ['cis_b2', 8], ['cis_bx', 4], ['cis_wheel', 3], ['cis_b1_sniper', 3], ['cis_b1_launcher', 4], ['cis_medic', 2], ['cis_engineer', 1], ['cis_sith', 1],
      ['cis_aat', 2], ['cis_stap', 3], ['cis_spider', 1], ['cis_hmp', 1], ['cis_missile', 1], ['cis_artillery', 1], ['cis_mtt', 1]]
};

function placeArmy(g, team, list, box, R) {
  // box: [x, y, w, h]; ставим на свободные клетки, техника — с запасом
  const taken = {};
  let placed = 0;
  list.forEach(([tid, n]) => {
    const Ty = U.type(tid);
    for (let i = 0; i < n; i++) {
      let ok = false;
      for (let t = 0; t < 400 && !ok; t++) {
        const x = box[0] + Math.floor(R() * box[2]), y = box[1] + Math.floor(R() * box[3]);
        const size = Ty.size, c = y * P.N + x;
        if (taken[c] || (size === 2 && (taken[c + 1] || taken[c + P.N] || taken[c + P.N + 1]))) continue;
        if (!g.pass[Ty.move + size][c]) continue;
        taken[c] = 1; if (size === 2) { taken[c + 1] = taken[c + P.N] = taken[c + P.N + 1] = 1; }
        g.add(tid, team, x + size / 2, y + size / 2, { aim: team === 0 ? -Math.PI / 2 : Math.PI / 2 });
        ok = true; placed++;
      }
    }
  });
  return placed;
}

function setup(planet, opts) {
  opts = opts || {};
  const js = require(path.join('../../shared/planets', planet + '.json'));
  const settle = opts.settle || { level: 3, districts: [{ slot: 1, id: 'market' }, { slot: 2, id: 'garrison' }, { slot: 3, id: 'hospital' }] };
  const g = new G.Ground(js, { seed: opts.seed || 11, auto0: opts.auto0 !== false, auto1: opts.auto1 !== false, att: opts.att == null ? 0 : opts.att, captureSeconds: opts.captureSeconds || 120, settle: settle, militiaAuto: true });
  const R = G.rng(opts.seed || 5);
  const att = g.att, def = 1 - att;
  // атакующие — в полосе вторжения и чуть выше; защитники — у города
  const nA = placeArmy(g, att, ARMY[att], [20, P.N - 12, 104, 10], R);
  const tw = g.town;
  const nD = placeArmy(g, def, ARMY[def], [tw[0] - 4, tw[1] + tw[3] - 6, tw[2] + 8, 14], R);
  // пара полевых построек у защитников
  g.addStruct('turret', def, tw[0] + 6, tw[1] + tw[3] + 2); g.addStruct('turret', def, tw[0] + tw[2] - 7, tw[1] + tw[3] + 2);
  g.addStruct('trench', def, tw[0] + 12, tw[1] + tw[3] + 1); g.addStruct('bunker', def, tw[0] + 16, tw[1] + tw[3] + 3);
  g.deployDefense(def);          // гарнизон сразу на постах, как в полигоне
  return { g, nA, nD };
}

// Столкновения: никто не стоит «внутри» другого (пехота в технике, техника в технике)
function overlaps(g) {
  const ag = g.agents.filter(a => a.alive && !a.air && !a.fly), out = [];
  for (let i = 0; i < ag.length; i++) for (let j = i + 1; j < ag.length; j++) {
    const a = ag[i], b = ag[j], dx = a.x - b.x, dy = a.y - b.y, d = Math.sqrt(dx * dx + dy * dy);
    const D = (a.rad + b.rad) * (a.size === 2 && b.size === 2 ? 0.8 : 1);
    if (d < D * 0.75) out.push(a.tid + '~' + b.tid + ' ' + d.toFixed(2) + '<' + D.toFixed(2));
  }
  return out;
}
function check(g) {
  const err = [];
  for (const a of g.agents) {
    if (!a.alive) continue;
    if (!(a.x >= 0 && a.x <= P.N && a.y >= 0 && a.y <= P.N)) err.push('за краем ' + a.tid + ' ' + a.x.toFixed(1) + ',' + a.y.toFixed(1));
    if (!(a.hp > 0 && a.hp <= a.hpMax + 1)) err.push('hp ' + a.tid + ' ' + a.hp);
    if (isNaN(a.x) || isNaN(a.y)) err.push('NaN ' + a.tid);
    if (!a.air) { const c = g.cellOf(a); if (!g.pass[a.move + a.size][c[1] * P.N + c[0]]) err.push('в непроходимом ' + a.tid + ' ' + c); }
  }
  return err;
}

if (require.main === module) {
  const planet = process.argv[2] || 'naboo', secs = +process.argv[3] || 240, lvl = +process.argv[4] || 3;
  const { g, nA, nD } = setup(planet, { settle: { level: lvl, districts: [{ slot: 1, id: 'market' }, { slot: 2, id: 'garrison' }, { slot: 3, id: 'hospital' }, { slot: 4, id: 'comms' }] } });
  console.log('поселение: уровень ' + g.settle.level + ' (' + g.settle.name + '), ворот ' + g.settle.gates.length + ', башен ' + g.settle.towers.length + ', районов ' + g.districts.length);
  console.log(planet + ': атакующих ' + nA + ', защитников ' + nD);
  let t0 = Date.now(), ticks = 0, bad = 0, lastRep = 0, shots = 0, deaths = 0;
  while (g.t < secs && g.over < 0) {
    g.step(0.1); ticks += 2;
    shots += g.ev.shots.filter(s => s.t > g.t - 0.1).length;
    deaths = g.agents.filter(a => !a.alive).length;
    if (g.t - lastRep >= 20) {
      lastRep = g.t;
      const e = check(g).concat(overlaps(g)); bad += e.length;
      const s = g.summary();
      const gates = g.settle.gates.map(q => q.s.dead ? 'x' : Math.round(q.s.hp / q.s.hpMax * 100) + '%').join(' ');
      const dist = s.districts.map(d => d.id[0] + (d.by === g.def ? '+' : '-')).join('');
      console.log(`t=${g.t.toFixed(0).padStart(4)}с живых ${s.alive[0]}/${s.alive[1]} площадь ${s.cap.cnt} ${s.cap.status} ${s.cap.prog.toFixed(0)}  выстрелов ${shots}  ворота ${gates}  районы ${dist}  поля ${g.flows.built} (${g.flows.ms} мс)` + (e.length ? '  ! ' + e.slice(0, 3).join('; ') : ''));
    }
  }
  const ms = Date.now() - t0;
  console.log(`итог: ${g.over < 0 ? 'время вышло' : 'победа стороны ' + g.over + ' (' + g.why + ')'}; ${ticks} шагов за ${ms} мс = ${(ms / ticks).toFixed(2)} мс/шаг; погибших ${deaths}; ошибок ${bad}`);
  process.exit(bad ? 1 : 0);
}
module.exports = { setup, placeArmy, check, overlaps, ARMY };
