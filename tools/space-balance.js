#!/usr/bin/env node
// Баланс классов орбиты: дуэли ИИ против ИИ (без абордажа и авиации) для пар, равных в базе.
// Каждая пара — N боёв с разными сидами, половина со сменой сторон (стартовая сторона не даёт перевеса).
//   node tools/space-balance.js                 — все пары, 30 боёв
//   node tools/space-balance.js venator:providence 40
//   node tools/space-balance.js --fit           — подобрать bal второго класса пары до 45–55 % (вывод — числа для CLASS)
//   node tools/space-balance.js tantive:hardcell --fit --target=0.35 — для пар, неравных в базе
// Гонять после каждой правки формул огня, щитов и экипажа (shared/rt-space.js, rt-crew.js).
'use strict';
var fs = require('fs'), path = require('path');
var ROOT = path.join(__dirname, '..', 'shared');
var SWShip = require(path.join(ROOT, 'rt-ship.js')), SP = require(path.join(ROOT, 'rt-space.js'));
var P = {};
function plan(id) { return P[id] || (P[id] = SWShip.load(JSON.parse(fs.readFileSync(path.join(ROOT, 'ships', (id === 'cis_munificent' ? 'munificent' : id === 'cis_hardcell' ? 'hardcell' : id) + '.json'), 'utf8')))); }

// пары, равные в базе (ship_types): республика — КНС
var PAIRS = ['venator:providence', 'acclamator:munificent', 'tantive:hardcell', 'rep_valiant:cis_recusant',
             'rep_arquitens:cis_diamond', 'rep_mandator:cis_subjugator', 'rep_victory:cis_lucrehulk'];

function duel(a, b, seed, swap) {
  var B = new SP.Battle({ seed: seed, fog: false, aiBoard: [false, false] });
  var sa = swap ? 1 : 0, sb = 1 - sa;
  var A = B.addShip({ cls: a, plan: plan(a), side: sa, x: sa ? 7000 : 0, y: 0, hd: sa ? Math.PI : 0, army: {} });
  var C = B.addShip({ cls: b, plan: plan(b), side: sb, x: sb ? 7000 : 0, y: 0, hd: sb ? Math.PI : 0, army: {} });
  for (var t = 0; t < 900 && B.over < 0; t += 0.1) { B.step(0.1); B.takeEvents(); }
  if (B.over === sa) return 1;
  if (B.over === sb) return 0;
  // не кончили за 15 минут — по доле оставшегося корпуса
  var ka = A.hull / A.hullMax, kb = C.hull / C.hullMax;
  return ka > kb ? 1 : ka < kb ? 0 : 0.5;
}
function rate(a, b, n) {
  var w = 0;
  for (var i = 0; i < n; i++) w += duel(a, b, 101 + i * 37, i % 2 === 1);
  return w / n;                 // доля побед первого класса
}

var args = process.argv.slice(2), fit = args.indexOf('--fit') >= 0, tg = 0.5;
// --target=0.3 — доля побед первого класса, к которой подбирать (пары, неравные в базе: сильнейший по базе должен выигрывать)
args.forEach(function(x) { var m = /^--target=([\d.]+)$/.exec(x); if (m) tg = +m[1]; });
args = args.filter(function(x) { return x !== '--fit' && !/^--target=/.test(x); });
var pairs = args[0] && args[0].indexOf(':') > 0 ? args[0].split(',') : PAIRS;
var N = +(args.find ? args.find(function(x) { return /^\d+$/.test(x); }) : 0) || 30;

pairs.forEach(function(pr) {
  var s = pr.split(':'), a = s[0], b = s[1];
  var CB = SP.CLASS[b]; if (!SP.CLASS[a] || !CB) { console.log(pr, '— нет класса'); return; }
  var r = rate(a, b, N);
  console.log(pr + '  побед ' + a + ': ' + Math.round(r * 100) + ' %  (bal ' + (SP.CLASS[a].bal || 1) + ' / ' + (CB.bal || 1) + ')');
  if (!fit || Math.abs(r - tg) <= 0.05) return;
  // бинарный поиск bal второго класса: больше bal — сильнее он, меньше побед у первого
  var lo = 0.5, hi = 2.5, best = CB.bal || 1, bestR = r;
  for (var it = 0; it < 9; it++) {
    var mid = Math.round((lo + hi) / 2 * 100) / 100; CB.bal = mid;
    var rm = rate(a, b, N);
    if (Math.abs(rm - tg) < Math.abs(bestR - tg)) { best = mid; bestR = rm; }
    if (Math.abs(rm - tg) <= 0.05) break;
    if (rm > tg) lo = mid; else hi = mid;
  }
  CB.bal = best;
  console.log('   → ' + b + ' bal ' + best + '  (побед ' + a + ' ' + Math.round(bestR * 100) + ' %)');
});
