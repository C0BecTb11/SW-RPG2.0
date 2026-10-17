#!/usr/bin/env node
// Прогон войск по картам планет: каждый род войск пытается пройти всюду.
//
//   node tools/planets/walk.js             — все планеты
//   node tools/planets/walk.js kamino      — одна
//   node tools/planets/walk.js --json out  — ещё и следы для картинок (out/<id>.json)
//
// Рода войск: пехота (1×1, пешком), AT-RT (1×1, шагоход), STAP и BARC (1×1, репульсоры),
// AT-TE, танки и артиллерия (2×2, гусеницы и шаги), AAT и MTT (2×2, репульсоры).
// Для каждого:
//   1) куда вообще можно попасть из полосы вторжения (и что остаётся отрезанным);
//   2) дойдут ли до ворот города, до обеих зон развёртывания, к каждому участку;
//   3) войско: сотни бойцов идут из полосы и из зон к случайным точкам по всей карте —
//      путь ищется по тем же правилам, что будут в бою (shared/rt-planets.js), и каждый
//      шаг проверяется; считаются сбои и петли (путь много длиннее прямой).
'use strict';

const fs = require('fs');
const path = require('path');
const P = require('../../shared/rt-planets.js');
const N = P.N, T = P.T;
const DIR = path.join(__dirname, '../../shared/planets');

const KINDS = [
  { id: 'foot', name: 'пехота', mv: 'foot', size: 1, n: 260 },
  { id: 'walker', name: 'AT-RT', mv: 'track', size: 1, n: 80 },
  { id: 'speeder', name: 'спидеры', mv: 'hover', size: 1, n: 80 },
  { id: 'heavy', name: 'AT-TE, танки', mv: 'track', size: 2, n: 120 },
  { id: 'hover2', name: 'AAT, MTT', mv: 'hover', size: 2, n: 80 }
];

function rng(seed) { return function() { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

// Может ли боец (машина) стоять, левый верхний угол (x, y)
function stand(m, x, y, k) {
  if (x < 0 || y < 0 || x + k.size > N || y + k.size > N) return false;
  return k.size === 1 ? P.canStand(m, x, y, k.mv) : P.canBox(m, x, y, k.size, k.mv);
}
// Шаг (dx, dy) из (x, y): для 1×1 — восемь сторон, для машины — четыре (передний край по правилам шага)
function step(m, x, y, dx, dy, k) {
  if (k.size === 1) return P.canStep(m, x, y, x + dx, y + dy, k.mv);
  if (dx && dy) return false;
  if (!stand(m, x + dx, y + dy, k)) return false;
  for (let s = 0; s < k.size; s++) {
    const ax = dx ? (dx > 0 ? x + k.size - 1 : x) : x + s, ay = dy ? (dy > 0 ? y + k.size - 1 : y) : y + s;
    if (!P.canStep(m, ax, ay, ax + dx, ay + dy, k.mv)) return false;
  }
  return true;
}
const D8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
function dirs(k) { return k.size === 1 ? D8 : D8.slice(0, 4); }
// Цена шага: медленнее по трудной земле
function cost(m, x, y, k, diag) {
  let sp = 1;
  for (let j = 0; j < k.size; j++) for (let i = 0; i < k.size; i++) sp = Math.min(sp, P.speed(m, x + i, y + j, k.mv));
  return (diag ? 1.414 : 1) / Math.max(0.2, sp);
}

function flood(m, starts, k) {
  const seen = new Uint8Array(N * N), q = [];
  starts.forEach(s => { if (!seen[s] && stand(m, s % N, (s / N) | 0, k)) { seen[s] = 1; q.push(s); } });
  for (let i = 0; i < q.length; i++) {
    const c = q[i], x = c % N, y = (c / N) | 0;
    for (const [dx, dy] of dirs(k)) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= N || ny >= N || seen[ny * N + nx]) continue;
      if (step(m, x, y, dx, dy, k)) { seen[ny * N + nx] = 1; q.push(ny * N + nx); }
    }
  }
  return seen;
}

// Поиск пути (A*) — как будет искать сервер боя
function astar(m, a, b, k) {
  const g = new Float64Array(N * N).fill(Infinity), prev = new Int32Array(N * N).fill(-1), h = [];
  const H = c => { const x = c % N, y = (c / N) | 0, dx = Math.abs(x - b % N), dy = Math.abs(y - ((b / N) | 0)); return k.size === 1 ? Math.max(dx, dy) + 0.414 * Math.min(dx, dy) : dx + dy; };
  const push = (f, c) => { h.push([f, c]); let i = h.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (h[p][0] <= h[i][0]) break; [h[p], h[i]] = [h[i], h[p]]; i = p; } };
  const pop = () => { const top = h[0], last = h.pop(); if (h.length) { h[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let mm = i; if (l < h.length && h[l][0] < h[mm][0]) mm = l; if (r < h.length && h[r][0] < h[mm][0]) mm = r; if (mm === i) break; [h[mm], h[i]] = [h[i], h[mm]]; i = mm; } } return top; };
  g[a] = 0; push(H(a), a);
  while (h.length) {
    const [f, c] = pop();
    if (c === b) break;
    if (f - H(c) > g[c] + 1e-6) continue;
    const x = c % N, y = (c / N) | 0;
    for (const [dx, dy] of dirs(k)) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
      if (!step(m, x, y, dx, dy, k)) continue;
      const nc = ny * N + nx, ng = g[c] + cost(m, nx, ny, k, dx && dy);
      if (ng < g[nc]) { g[nc] = ng; prev[nc] = c; push(ng + H(nc), nc); }
    }
  }
  if (g[b] === Infinity) return null;
  const out = [];
  for (let c = b; c >= 0; c = prev[c]) out.push(c);
  return out.reverse();
}

function targets(js) {
  const tw = js.town, cx = tw[0] + (tw[2] >> 1) - 1, z = js.zones;
  const t = [['город, юг', cx, tw[1] + tw[3]], ['город, север', cx, tw[1] - 2], ['город, запад', tw[0] - 2, tw[1] + (tw[3] >> 1)], ['город, восток', tw[0] + tw[2], tw[1] + (tw[3] >> 1)]];
  z.deploy.forEach((d, i) => t.push(['зона ' + (i + 1), d[0] + 2, d[1] + 2]));
  return t;
}
// Есть ли у участка подход (соседняя клетка, куда можно встать)
function plotOk(reach, s, k) {
  for (let i = -k.size; i <= 6; i++) for (const j of [-k.size, 6]) { const x = s[0] + i, y = s[1] + j; if (x >= 0 && y >= 0 && x < N && y < N && reach[y * N + x]) return true; }
  for (let j = -k.size; j <= 6; j++) for (const i of [-k.size, 6]) { const x = s[0] + i, y = s[1] + j; if (x >= 0 && y >= 0 && x < N && y < N && reach[y * N + x]) return true; }
  return false;
}

function run(id, dump) {
  const js = JSON.parse(fs.readFileSync(path.join(DIR, id + '.json'), 'utf8')), m = P.load(js);
  const R = rng(0x5eed ^ id.length * 977 ^ id.charCodeAt(0) * 131);
  const res = { id, name: js.name, kinds: {}, problems: [] };
  const out = { id, traces: {}, cut: {} };
  for (const k of KINDS) {
    const strip = [];
    for (let x = 0; x + k.size <= N; x++) strip.push((N - P.GEO.strip) * N + x);
    const reach = flood(m, strip, k);
    let can = 0, got = 0;
    const cutMask = new Uint8Array(N * N);
    for (let c = 0; c < N * N; c++) {
      if (!stand(m, c % N, (c / N) | 0, k)) continue;
      can++; if (reach[c]) got++; else cutMask[c] = 1;
    }
    // отрезанные места — кусками
    const parts = [];
    const seen = new Uint8Array(N * N);
    for (let c = 0; c < N * N; c++) {
      if (!cutMask[c] || seen[c]) continue;
      const q = [c]; seen[c] = 1;
      for (let i = 0; i < q.length; i++) { const x = q[i] % N, y = (q[i] / N) | 0; for (const [dx, dy] of D8) { const nx = x + dx, ny = y + dy; if (nx >= 0 && ny >= 0 && nx < N && ny < N && cutMask[ny * N + nx] && !seen[ny * N + nx]) { seen[ny * N + nx] = 1; q.push(ny * N + nx); } } }
      parts.push([q.length, q[0] % N, (q[0] / N) | 0]);
    }
    parts.sort((a, b) => b[0] - a[0]);
    // цели
    const miss = [];
    for (const tg of targets(js)) {
      let ok = false;
      for (let j = -k.size + 1; j <= 0 && !ok; j++) for (let i = -k.size + 1; i <= 0 && !ok; i++) { const x = tg[1] + i, y = tg[2] + j; if (x >= 0 && y >= 0 && reach[y * N + x]) ok = true; }
      if (!ok) miss.push(tg[0]);
    }
    const plotsOk = js.zones.slots.filter(s => plotOk(reach, s, k)).length;
    // войско: из полосы и из зон — к случайным достижимым точкам
    const pool = [];
    for (let c = 0; c < N * N; c++) if (reach[c]) pool.push(c);
    const starts = strip.filter(s => reach[s]);
    js.zones.deploy.forEach(d => { for (let j = 0; j < 6 - k.size + 1; j++) for (let i = 0; i < 6 - k.size + 1; i++) { const c = (d[1] + j) * N + d[0] + i; if (reach[c]) starts.push(c); } });
    let fail = 0, bad = 0, len = 0, worst = 0, worstAt = null;
    const visit = new Uint8Array(N * N), traces = [];
    for (let s = 0; s < k.n && pool.length && starts.length; s++) {
      const a = starts[Math.floor(R() * starts.length)], b = pool[Math.floor(R() * pool.length)];
      const p = astar(m, a, b, k);
      if (!p) { fail++; continue; }
      // проверка каждого шага
      for (let i = 1; i < p.length; i++) {
        const x0 = p[i - 1] % N, y0 = (p[i - 1] / N) | 0, x1 = p[i] % N, y1 = (p[i] / N) | 0;
        if (!step(m, x0, y0, x1 - x0, y1 - y0, k)) { bad++; break; }
      }
      p.forEach(c => { for (let j = 0; j < k.size; j++) for (let i = 0; i < k.size; i++) visit[c + j * N + i] = 1; });
      let L = 0;
      for (let i = 1; i < p.length; i++) L += Math.hypot(p[i] % N - p[i - 1] % N, ((p[i] / N) | 0) - ((p[i - 1] / N) | 0));
      const st = Math.hypot(a % N - b % N, ((a / N) | 0) - ((b / N) | 0));
      len += L;
      if (st > 12 && L / st > worst) { worst = L / st; worstAt = [a % N, (a / N) | 0, b % N, (b / N) | 0]; }
      if (dump && traces.length < 60) traces.push(p.filter((c, i) => i % 2 === 0 || i === p.length - 1).map(c => [c % N, (c / N) | 0]));
    }
    let cov = 0;
    for (let c = 0; c < N * N; c++) if (visit[c]) cov++;
    res.kinds[k.id] = { name: k.name, reach: got / Math.max(1, can), cutCells: can - got, parts: parts.slice(0, 4), miss, plots: plotsOk, fail, bad, avg: len / Math.max(1, k.n - fail), worst, worstAt, cov: cov / N / N };
    if (miss.length && (k.id === 'foot' || k.id === 'heavy')) res.problems.push(k.name + ': не дойти до ' + miss.join(', '));
    if (k.id === 'foot' && plotsOk < js.zones.slots.length) res.problems.push('пехота: нет подхода к ' + (js.zones.slots.length - plotsOk) + ' участкам');
    if (k.id === 'foot' && can - got) res.problems.push('пехота: отрезано ' + (can - got) + ' клеток');
    if (fail || bad) res.problems.push(k.name + ': сбоев пути ' + fail + ', неверных шагов ' + bad);
    if (dump) {
      out.traces[k.id] = traces;
      if (k.id === 'foot' || k.id === 'heavy') { const cm = []; for (let c = 0; c < N * N; c++) if (cutMask[c]) cm.push(c); out.cut[k.id] = cm; }
    }
  }
  if (dump) fs.writeFileSync(path.join(dump, id + '.json'), JSON.stringify(out));
  return res;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  let dump = null;
  const ji = args.indexOf('--json');
  if (ji >= 0) { dump = args[ji + 1]; args.splice(ji, 2); fs.mkdirSync(dump, { recursive: true }); }
  const list = JSON.parse(fs.readFileSync(path.join(DIR, 'index.json'), 'utf8')).map(p => p.id);
  const ids = args.length ? args : list;
  let problems = 0;
  const pct = v => (v * 100).toFixed(v < 0.995 ? 1 : 0).padStart(5) + '%';
  console.log('планета'.padEnd(15) + KINDS.map(k => k.name.padEnd(14)).join('') + '  петли (худшая)');
  ids.forEach(id => {
    const r = run(id, dump);
    const worst = Math.max.apply(null, KINDS.map(k => r.kinds[k.id].worst));
    console.log(r.name.padEnd(15) + KINDS.map(k => (pct(r.kinds[k.id].reach) + ' ' + (r.kinds[k.id].plots + '/14')).padEnd(14)).join('') + '  ×' + worst.toFixed(1));
    r.problems.forEach(p => console.log('   ! ' + p));
    problems += r.problems.length;
    if (dump) fs.writeFileSync(path.join(dump, id + '.res.json'), JSON.stringify(r));
  });
  console.log(problems ? '\nзамечаний: ' + problems : '\nвсё проходимо');
  process.exit(problems ? 1 : 0);
}
module.exports = { run, KINDS, astar, flood, stand, step };
