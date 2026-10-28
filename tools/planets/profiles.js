// Профили 20 планет для генератора карт (gen.js).
//
// build(g, T) рисует местность через построитель g: хребты, реки, пропасти, леса,
// укрытия. Заповедное (зоны, участки, полоса вторжения, город) и проходы g
// бережёт сам. look — как планета выглядит: цвета и виды клеток; его читает
// отрисовка (ground/terrain.js). Виды клеток (mats) — по типу местности:
// индекс в списке = m в карте.
'use strict';

const N = 144;
const STRIP = 4;      // полоса вторжения (shared/rt-planets.js GEO.strip)
// где «открытое поле» — не в обжитом и не у базы (север занят участками)
const south = (x, y) => y > 92;
const sides = (x, y) => (x < 46 || x > 94) && y > 48;
const field = (x, y) => y > 48;

// ---------------------------------------------------------------- Камино: план Типоки
// Платформы: город — на центральной; север — гроздь кругов под участками; зоны — посадочные круги
// у края; вокруг — купола (dome), посадочные площадки (pad) и грузовые палубы (mod) на сваях.
// Круги подобраны так, что все участки, зоны и город лежат на них целиком (проверка — в reserve).
function kaminoPlan() {
  return [
    ['core', 70, 70, 27, 'deck'],
    ['hub', 78, 28, 17, 'deck'], ['nw', 57, 23, 13, 'deck'], ['ne', 100, 25, 14.5, 'deck'], ['ne2', 96, 36, 7, 'deck'], ['sw', 64, 41, 8, 'deck'],
    ['z1', 24, 7, 7.5, 'deck'], ['z2', 81, 7, 7.5, 'deck'],
    ['w1', 20, 30, 8, 'dome'], ['w2', 14, 70, 9, 'pad'], ['w3', 25, 91, 10, 'dome'], ['w4', 12, 120, 7, 'mod'], ['w5', 42, 118, 8, 'pad'],
    ['s1', 70.5, 117, 7, 'mod'],
    ['e5', 97, 118, 8, 'pad'], ['e4', 131, 120, 7, 'mod'], ['e3', 115, 91, 10, 'dome'], ['e2', 130, 70, 9, 'pad'], ['e1', 126, 44, 8, 'dome'], ['e0', 131, 15, 6, 'mod']
  ].map(a => ({ id: a[0], x: a[1], y: a[2], r: a[3], kind: a[4] }));
}
// переходы: [откуда, куда, ширина, сначала по 'x' или 'y']
const KAMINO_LINKS = [
  ['z1', 'nw', 3, 'x'], ['w1', 'nw', 3, 'x'], ['w1', 'z1', 3, 'y'], ['w1', 'w2', 3, 'y'], ['w2', 'core', 3, 'x'], ['w2', 'w3', 3, 'y'],
  ['w3', 'core', 3, 'x'], ['w3', 'w4', 3, 'y'], ['w4', 'strip', 3, 'y'], ['w4', 'w5', 3, 'x'], ['w5', 'strip', 3, 'y'],
  ['s1', 'w5', 3, 'x'], ['s1', 'e5', 3, 'x'],
  ['e5', 'strip', 3, 'y'], ['e4', 'e5', 3, 'x'], ['e4', 'strip', 3, 'y'], ['e3', 'e4', 3, 'y'], ['e3', 'core', 3, 'x'],
  ['e2', 'e3', 3, 'y'], ['e2', 'core', 3, 'x'], ['e1', 'e2', 3, 'y'], ['e1', 'ne2', 3, 'x'], ['e0', 'e1', 3, 'y'], ['e0', 'ne', 3, 'x']
];
// Ломаная перехода A → B (по осям, один поворот), обрезанная до кромок: на палубу заходит на 0,8 клетки
function kaminoWalk(A, B, first, w) {
  const c = first === 'x' ? [B.x, A.y] : [A.x, B.y];
  const raw = [[A.x, A.y], c, [B.x, B.y]], pts = [];
  for (let s = 0; s < 2; s++) {
    const a = raw[s], b = raw[s + 1], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    for (let k = 0; k <= L; k += 0.25) pts.push([a[0] + (b[0] - a[0]) * k / (L || 1), a[1] + (b[1] - a[1]) * k / (L || 1)]);
  }
  const inside = (p, d, m) => Math.hypot(p[0] - d.x, p[1] - d.y) <= d.r - m;
  // начало — там, где переход в последний раз выходит из A (с заходом 0,8); конец — где впервые входит в B
  let i0 = 0, i1 = pts.length - 1;
  while (i0 < pts.length - 1 && inside(pts[i0 + 1], A, 0.8)) i0++;
  if (B.r) while (i1 > i0 && inside(pts[i1 - 1], B, 0.8)) i1--;
  const seg = pts.slice(i0, i1 + 1);
  if (seg.length < 2) return null;
  // оставить только углы
  const out = [seg[0]];
  for (let i = 1; i < seg.length - 1; i++) {
    const p = seg[i - 1], q = seg[i], r = seg[i + 1];
    if ((Math.abs(q[0] - p[0]) > 1e-6) !== (Math.abs(r[0] - q[0]) > 1e-6)) out.push(q);
  }
  out.push(seg[seg.length - 1]);
  // чётная ширина ложится по оси платформы, если сдвинуть на полклетки
  const sh = w % 2 ? 0 : 0.5;
  return out.map(p => [Math.round((p[0] - sh) * 2) / 2, Math.round((p[1] - sh) * 2) / 2]);
}

module.exports = {

  // ---------------------------------------------------------------- Альдераан
  alderaan: {
    name: 'Альдераан', about: 'Зелёные холмы и луга, две горные гряды с перевалами, озёра с бродами, рощи и каменные изгороди полей. Предгорья — высоты с обзором; луга простреливаются насквозь.', ford: true,
    look: { highTint: 0.12,
      ground: ['#4d6b33', '#5b7a3b', '#6b8a45'], style: 'grass',
      rough: '#7c7a66', light: ['#5f8d3a', '#2f4b22'], rock: ['#6c6a63', '#a9a69c'], snow: '#e8ece8',
      water: ['#1b4669', '#3f7da3'], road: '#8b7b5b', roadStyle: 'trail',
      mats: { 1: ['scree'], 2: ['meadow', 'grove'], 3: ['boulder', 'tree', 'fence'], 4: ['rock'] }
    },
    build(g, T) {
      // две горные гряды с предгорьями (высота 1) и перевалами
      [[[4, 62], [44, 128]], [[140, 58], [100, 126]]].forEach(r => {
        const pts = g.meander(r[0], r[1], 10, 10);
        const foot = [];
        g.stroke(pts, 13, (x, y) => { if (!g.res[y * N + x]) { g.e[y * N + x] = 1; foot.push([x, y]); } });
        g.stroke(pts, f => 4 + 3 * Math.sin(f * Math.PI), (x, y) => g.paint(x, y, T.BLOCK, 0));
        g.rampsAround(foot, 1, 6);
      });
      // озёра и ручьи
      for (let i = 0; i < 4; i++) {
        const cx = g.irnd(20, 124), cy = g.irnd(96, 128);
        g.blob(cx, cy, g.irnd(50, 140), (x, y) => g.paint(x, y, T.WATER, 0));
        g.stroke(g.walk(cx, cy, 6, 5, 0.5), 1.6, (x, y) => g.paint(x, y, T.WATER, 0));
      }
      // рощи (заросли) и отдельные деревья
      g.noiseFill(9, 0.6, (x, y, v) => { if (g.t[y * N + x] === T.OPEN && !g.res[y * N + x]) g.paint(x, y, T.LIGHT, v > 0.4 ? 1 : 0); });
      g.scatter(60, T.COVER, 1, { gap: 1, where: field });
      // изгороди полей — каменные, с проходами
      for (let i = 0; i < 7; i++) {
        const x0 = g.irnd(8, 120), y0 = g.irnd(90, 124), w = g.irnd(8, 14), h = g.irnd(6, 9);
        for (let k = 0; k < w; k++) { if (k % 5 !== 2) { g.paint(x0 + k, y0, T.COVER, 2); g.paint(x0 + k, y0 + h, T.COVER, 2); } }
        for (let k = 1; k < h; k++) { if (k % 4 !== 2) { g.paint(x0, y0 + k, T.COVER, 2); g.paint(x0 + w, y0 + k, T.COVER, 2); } }
      }
      g.scatter(70, T.COVER, 0, { gap: 1, cluster: [1, 3], where: field });
      g.noiseFill(7, 0.7, (x, y) => { if (g.t[y * N + x] === T.OPEN) g.paint(x, y, T.ROUGH, 0); }, 2, (x, y) => g.e[y * N + x] === 1);
      // дороги — по готовой местности: в обход скал, коротко через воду и пропасти
      g.mainRoads({ amp: 7 });
    }
  },

  // ---------------------------------------------------------------- Анаксис
  anaxes: {
    name: 'Анаксис', about: 'Поле былых сражений: серые плато, воронки, остовы техники. Две линии противотанковых ежей — пехота проходит, технике нужны разрывы и дороги.',
    look: { highTint: 0.25,
      ground: ['#55554f', '#62615b', '#4b4a45'], style: 'soil',
      rough: '#6f6a60', light: ['#3d3c38', '#47463f'], rock: ['#76746e', '#a3a099'],
      water: ['#1d2b33', '#34505c'], road: '#7a776f', roadStyle: 'paved',
      mats: { 1: ['rubble'], 2: ['crater', 'trench'], 3: ['tankwreck', 'ruin', 'boulder'], 4: ['rock', 'wreck'], 11: ['hedgehog'] }
    },
    build(g, T) {
      // серые плато
      for (let i = 0; i < 4; i++) g.plateau(g.pick([g.irnd(10, 40), g.irnd(100, 134)]), g.irnd(56, 126), g.irnd(7, 12), 1, 3, 0.35);
      // воронки былых боёв: внутри — укрытие для пехоты, по краю — завалы
      g.place(26, 600, field, (x, y) => {
        const r = g.rnd(2, 4.5); return [g.diskCells(x, y, r), { k: 'crater', x: x, y: y, r: r }];
      }, T.LIGHT, 0, 0, [T.OPEN, T.ROUGH]);
      g.objs.filter(o => o.k === 'crater').forEach(o => g.disk(o.x, o.y, o.r + 1.4, (x, y, d) => { if (d > 0.72 && g.t[y * N + x] === T.OPEN) g.paint(x, y, T.ROUGH, 0); }));
      // остовы техники — крупные (скалой) и мелкие (укрытием)
      g.place(9, 400, field, (x, y) => {
        const a = g.R() * Math.PI, pts = g.rotRect(x, y, g.rnd(4, 7), g.rnd(2.2, 3), a);
        return [g.poly(pts), { k: 'wreck', pts: pts, a: a, s: g.irnd(0, 2) }];
      }, T.BLOCK, 1, 1);
      g.scatter(60, T.COVER, 0, { gap: 2, where: field });
      g.scatter(40, T.COVER, 1, { gap: 1, cluster: [2, 4], where: field });
      g.scatter(50, T.COVER, 2, { gap: 1, where: field });
      // противотанковые линии: ежи поперёк подходов, с разрывами
      [104, 121].forEach(y0 => {
        for (let x = 2; x < N - 2; x++) {
          const yy = y0 + Math.round(Math.sin(x / 9) * 2);
          if ((x % 18) < 14 && x % 2 === 0) g.paint(x, yy, T.TRAP, 0);
        }
      });
      // окопы
      for (let i = 0; i < 6; i++) g.stroke(g.walk(g.irnd(10, 134), g.irnd(94, 130), 4, 3, 0.6), 1, (x, y) => { if (g.t[y * N + x] === T.OPEN) g.paint(x, y, T.LIGHT, 1); });
      // дороги — по готовой местности: в обход скал, коротко через воду и пропасти
      g.mainRoads({ amp: 4 });
    }
  },

  // ---------------------------------------------------------------- Като-Неймодия
  catoneimoidia: {
    name: 'Като-Неймодия', about: 'Каменные плато, разрезанные пропастями. Через пропасти — арочные мосты: узкие места, где решается бой. Туман снижает обзор.',
    look: {
      ground: ['#4a6b65', '#587b74', '#6a8b82'], style: 'stone',
      rough: '#7b958c', light: ['#5d7f62', '#3f5f4a'], rock: ['#86a69d', '#d0e2da'],
      void: 'chasm', voidc: ['#050c0e', '#1c3034'], water: ['#1a3a40', '#3a6a70'], road: '#a7b9b1', roadStyle: 'stone', bridge: 'arch',
      mats: { 1: ['scree'], 2: ['moss'], 3: ['balustrade', 'boulder'], 4: ['rock', 'outcrop'], 6: ['chasm'] }
    },
    build(g, T) {
      // пропасти: две через всю карту южнее города и две у боков
      [98, 119].forEach((y0, i) => {
        const pts = g.meander([-2, y0 + g.irnd(-3, 3)], [N + 2, y0 + g.irnd(-3, 3)], 6, 12);
        g.stroke(pts, f => 6 + 3 * Math.sin(f * Math.PI * (3 + i)), (x, y) => g.paint(x, y, T.VOID, 0));
      });
      g.stroke(g.meander([22, 46], [16, 92], 5, 10), 5, (x, y) => g.paint(x, y, T.VOID, 0));
      g.stroke(g.meander([122, 46], [128, 92], 5, 10), 5, (x, y) => g.paint(x, y, T.VOID, 0));
      // каменные плато между пропастями
      for (let i = 0; i < 4; i++) g.plateau(g.pick([g.irnd(30, 48), g.irnd(96, 116)]), g.irnd(104, 114), g.irnd(4, 6), 1, 2, 0.25);
      g.place(18, 300, field, (x, y) => [g.diskCells(x, y, g.rnd(1.2, 2.4)), { k: 'outcrop', x: x, y: y }], T.BLOCK, 1, 1);
      g.scatter(55, T.COVER, 1, { gap: 1, cluster: [1, 2], where: field });
      g.noiseFill(8, 0.62, (x, y) => { if (g.t[y * N + x] === T.OPEN) g.paint(x, y, T.LIGHT, 0); });
      // дороги — по готовой местности: в обход скал, коротко через воду и пропасти
      g.mainRoads({ amp: 8, sideW: 3 });
    }
  },

  // ---------------------------------------------------------------- Кристофсис
  christophsis: {
    name: 'Кристофсис', about: 'Стеклянные равнины, кристаллические гряды и шпили. Гроздья кристаллов — укрытие, которое тяжёлое оружие может разбить.',
    look: {
      ground: ['#1c3769', '#244684', '#2c55a0'], style: 'glass',
      rough: '#3a63a8', light: ['#4f86c8', '#2f5c9a'], rock: ['#5ea7e6', '#d8f2ff'], glow: '#9fe0ff',
      water: ['#0d1f40', '#2a4f8a'], road: '#8aa4cf', roadStyle: 'paved',
      mats: { 1: ['shards'], 2: ['crystalbed'], 3: ['crystal', 'crystalsmall'], 4: ['crystalridge', 'crystalspire'] }
    },
    build(g, T) {
      // кристаллические гряды
      for (let i = 0; i < 5; i++) {
        const pts = g.walk(g.pick([g.irnd(6, 40), g.irnd(104, 138)]), g.irnd(56, 128), 5, 5, 0.5);
        g.stroke(pts, 2.4, (x, y) => g.paint(x, y, T.BLOCK, 0));
      }
      // кристаллические шпили
      g.place(30, 900, field, (x, y) => {
        const r = g.rnd(1.2, 2.8); return [g.diskCells(x, y, r), { k: 'crystalspire', x: x, y: y, r: r, a: g.R() * Math.PI }];
      }, T.BLOCK, 1, 1);
      // гроздья кристаллов — укрытие
      g.scatter(80, T.COVER, 0, { gap: 1, cluster: [2, 5], where: field });
      g.scatter(70, T.COVER, 1, { gap: 1, where: field });
      g.noiseFill(7, 0.62, (x, y) => { if (g.t[y * N + x] === T.OPEN) g.paint(x, y, T.ROUGH, 0); });
      g.noiseFill(11, 0.66, (x, y) => { if (g.t[y * N + x] === T.OPEN) g.paint(x, y, T.LIGHT, 0); });
      // дороги — по готовой местности: в обход скал, коротко через воду и пропасти
      g.mainRoads({ amp: 6 });
    }
  },

  // ---------------------------------------------------------------- Кореллия
  corellia: {
    name: 'Кореллия', about: 'Промзона верфей: ряды складов, штабеля контейнеров, ограды и рельсы. С востока — залив с пирсами.',
    look: {
      ground: ['#2d2c2e', '#383639', '#433f42'], style: 'concrete',
      rough: '#4a4642', light: ['#3a3e34', '#2c3028'], rock: ['#5a5654', '#7d7874'], accent: '#ff8a3a',
      water: ['#0e1820', '#26394a'], road: '#262527', roadStyle: 'asphalt', bridge: 'pier',
      mats: { 1: ['gravel', 'rail'], 2: ['weeds'], 3: ['container', 'chainfence', 'crate'], 4: ['rock', 'warehouse'] }
    },
    build(g, T) {
      // залив с востока и пирсы
      const shore = g.noise(10, 3);
      for (let y = 56; y < 132; y++) for (let x = 100; x < N; x++) {
        const edge = 116 - Math.sin((y - 56) / 76 * Math.PI) * 14 + (shore(x, y) - 0.5) * 10;
        if (x > edge) g.paint(x, y, T.WATER, 0);
      }
      for (let k = 0; k < 4; k++) { const y0 = 66 + k * 16; g.rect(100, y0, 30, 3, (x, y) => { if (g.t[y * N + x] === T.WATER) g.paint(x, y, T.OPEN, 1); }); }
      // склады — рядами
      for (let gy = 94; gy < 132; gy += 12) for (let gx = 6; gx < 100; gx += 16) {
        if (g.R() < 0.25) continue;
        const w = g.irnd(8, 12), h = g.irnd(5, 8), x = gx + g.irnd(0, 3), y = gy + g.irnd(0, 2);
        const cells = []; g.rect(x, y, w, h, (i, j) => cells.push([i, j]));
        g.stamp(cells, T.BLOCK, 1, { k: 'warehouse', x: x, y: y, w: w, h: h, s: g.irnd(0, 3) }, 1);
      }
      for (let gy = 56; gy < 90; gy += 13) for (const gx of [4, 20, 98]) {
        if (g.R() < 0.3) continue;
        const w = g.irnd(7, 11), h = g.irnd(5, 7), x = gx + g.irnd(0, 4), y = gy + g.irnd(0, 3);
        const cells = []; g.rect(x, y, w, h, (i, j) => cells.push([i, j]));
        g.stamp(cells, T.BLOCK, 1, { k: 'warehouse', x: x, y: y, w: w, h: h, s: g.irnd(0, 3) }, 1);
      }
      // штабеля контейнеров (по 2–4 в ряд), ящики, ограды
      g.scatter(70, T.COVER, 0, { gap: 1, cluster: [2, 4], line: [1, 0], where: field });
      g.scatter(40, T.COVER, 0, { gap: 1, cluster: [2, 3], line: [0, 1], where: field });
      g.scatter(50, T.COVER, 2, { gap: 1, where: field });
      for (let i = 0; i < 8; i++) {
        const x0 = g.irnd(4, 120), y0 = g.irnd(52, 130), horiz = g.R() < 0.5, L = g.irnd(8, 16);
        for (let k = 0; k < L; k++) if (k % 7 !== 3) g.paint(horiz ? x0 + k : x0, horiz ? y0 : y0 + k, T.COVER, 1);
      }
      // рельсы
      [[[0, 92], [100, 92]], [[0, 134], [100, 134]]].forEach(r => g.stroke(r, 1, (x, y) => { if (g.t[y * N + x] === T.OPEN) g.paint(x, y, T.ROUGH, 1); }));
      g.noiseFill(8, 0.68, (x, y) => { if (g.t[y * N + x] === T.OPEN) g.paint(x, y, T.LIGHT, 0); });
      g.noiseFill(6, 0.64, (x, y) => { if (g.t[y * N + x] === T.OPEN) g.paint(x, y, T.ROUGH, 0); });
      // дороги — по готовой местности: в обход скал, коротко через воду и пропасти
      g.mainRoads({ amp: 3 });
    }
  },

  // ---------------------------------------------------------------- Корусант
  coruscant: {
    name: 'Корусант', ortho: true, about: 'Сплошной город: кварталы-небоскрёбы, проспекты и улицы, площади. Уличные бои; технике — только по проспектам.', road: true,
    look: {
      ground: ['#5b544a', '#675f54', '#4f4940'], style: 'plates',
      rough: '#6f665a', light: ['#4d6a3a', '#3c5a2e'], rock: ['#7a7166', '#a89c8c'], accent: '#ffd27a',
      water: ['#1a2a38', '#3a5a70'], road: '#3e3a35', roadStyle: 'avenue',
      mats: { 1: ['debris'], 2: ['planter'], 3: ['speeder', 'barrier', 'planterbox'], 4: ['tower'] }
    },
    build(g, T) {
      g.mainRoads({ amp: 0, w: 4, sideW: 3 });
      // кварталы: сетка проспектов, между ними — небоскрёбы
      const xs = [0], ys = [48];
      while (xs[xs.length - 1] < N) xs.push(xs[xs.length - 1] + g.irnd(13, 18));
      while (ys[ys.length - 1] < N) ys.push(ys[ys.length - 1] + g.irnd(12, 17));
      for (let a = 0; a + 1 < xs.length; a++) for (let b = 0; b + 1 < ys.length; b++) {
        const x0 = xs[a] + 2, y0 = ys[b] + 2, x1 = xs[a + 1] - 2, y1 = ys[b + 1] - 2;
        if (x1 - x0 < 4 || y1 - y0 < 4) continue;
        if (g.R() < 0.12) continue;                         // площадь
        // квартал — 1–4 башни
        const split = g.R() < 0.5 && x1 - x0 > 9, split2 = g.R() < 0.5 && y1 - y0 > 9;
        const mx = split ? Math.round((x0 + x1) / 2) : x1, my = split2 ? Math.round((y0 + y1) / 2) : y1;
        [[x0, y0, mx, my], [split ? mx + 1 : -1, y0, x1, my], [x0, split2 ? my + 1 : -1, mx, y1], [split ? mx + 1 : -1, split2 ? my + 1 : -1, x1, y1]].forEach(q => {
          if (q[0] < 0 || q[1] < 0 || q[2] - q[0] < 3 || q[3] - q[1] < 3) return;
          const cells = []; g.rect(q[0], q[1], q[2] - q[0], q[3] - q[1], (i, j) => cells.push([i, j]));
          g.stamp(cells, T.BLOCK, 0, { k: 'tower', x: q[0], y: q[1], w: q[2] - q[0], h: q[3] - q[1], z: g.irnd(1, 4), s: g.irnd(0, 3) }, 0);
        });
      }
      // проспекты ровно между кварталами
      xs.forEach(x => g.rect(x - 1, 48, 3, N - 48, (i, j) => { if (g.t[j * N + i] === T.OPEN && !g.res[j * N + i]) g.paint(i, j, T.ROAD, 0); }));
      ys.forEach(y => g.rect(0, y - 1, N, 3, (i, j) => { if (g.t[j * N + i] === T.OPEN && !g.res[j * N + i]) g.paint(i, j, T.ROAD, 0); }));
      g.scatter(60, T.COVER, 0, { gap: 1, cluster: [1, 2], on: [T.ROAD, T.OPEN], where: field });
      g.scatter(40, T.COVER, 1, { gap: 1, cluster: [2, 3], on: [T.OPEN], where: field });
      g.scatter(30, T.COVER, 2, { gap: 1, on: [T.OPEN], settled: true });
      g.noiseFill(5, 0.74, (x, y) => { if (g.t[y * N + x] === T.OPEN && !g.res[y * N + x]) g.paint(x, y, T.LIGHT, 0); });
    }
  },

  // ---------------------------------------------------------------- Фоэрост
  feorust: {
    name: 'Фоэрост', about: 'Рудный мир: карьеры террасами, отвалы, конвейеры и рудовозы. Ступени карьера — высоты, на дно ведут рампы.', base: 2,
    look: { highTint: 0.2,
      ground: ['#52565b', '#5f6368', '#474b50'], style: 'soil',
      rough: '#6d6258', light: ['#5a4a3e', '#4a3d34'], rock: ['#736c66', '#9a918a'], rust: ['#8a4c2c', '#a8683c'],
      water: ['#232a2e', '#435258'], road: '#6a6560', roadStyle: 'gravel',
      mats: { 1: ['gravel'], 2: ['ore'], 3: ['conveyor', 'oretruck', 'boulder'], 4: ['rock', 'spoil'] }
    },
    build(g, T) {
      // карьеры террасами: верх 2, ступень 1, дно 0
      [[28, 108, 17], [114, 104, 16], [20, 66, 10], [124, 66, 10]].forEach(p => {
        const lv1 = [], lv0 = [];
        g.disk(p[0], p[1], p[2], (x, y) => { if (!g.res[y * N + x] || g.res[y * N + x] === 2) { g.e[y * N + x] = 1; lv1.push([x, y]); } }, 0.18);
        g.disk(p[0], p[1], p[2] * 0.55, (x, y) => { if (!g.res[y * N + x] || g.res[y * N + x] === 2) { g.e[y * N + x] = 0; lv0.push([x, y]); } }, 0.2);
        g.rampsAround(lv1, 2, 3);
        g.rampsAround(lv0, 1, 2);
        g.objs.push({ k: 'quarry', x: p[0], y: p[1], r: p[2] });
        lv0.forEach(c => { if (g.R() < 0.35 && g.t[c[1] * N + c[0]] === T.OPEN) g.paint(c[0], c[1], T.LIGHT, 0); });
      });
      // отвалы
      g.place(16, 500, field, (x, y) => [g.diskCells(x, y, g.rnd(1.6, 3)), { k: 'spoil', x: x, y: y }], T.BLOCK, 1, 1);
      g.objs.filter(o => o.k === 'spoil').forEach(o => g.disk(o.x, o.y, 4.5, (x, y) => { if (g.t[y * N + x] === T.OPEN) g.paint(x, y, T.ROUGH, 0); }, 0.3));
      // конвейеры — длинные линии с проходами
      for (let i = 0; i < 6; i++) {
        const x0 = g.irnd(6, 130), y0 = g.irnd(56, 130), horiz = g.R() < 0.6, L = g.irnd(12, 24);
        for (let k = 0; k < L; k++) if (k % 8 !== 4) g.paint(horiz ? x0 + k : x0, horiz ? y0 : y0 + k, T.COVER, 0);
      }
      g.scatter(30, T.COVER, 1, { gap: 2, where: field });
      g.scatter(60, T.COVER, 2, { gap: 1, cluster: [1, 2], where: field });
      g.noiseFill(7, 0.62, (x, y) => { if (g.t[y * N + x] === T.OPEN) g.paint(x, y, T.ROUGH, 0); });
      // дороги — по готовой местности: в обход скал, коротко через воду и пропасти
      g.mainRoads({ amp: 5 });
    }
  },

  // ---------------------------------------------------------------- Геонозис
  geonosis: {
    name: 'Геонозис', about: 'Красные каньоны между столовыми горами, уступы у подножий, шпили-ульи, дюны. Песок замедляет пехоту.',
    look: { highTint: 0.35,
      ground: ['#9a4a22', '#ad5629', '#bf6531'], style: 'sand',
      rough: '#c27342', light: ['#7a5a30', '#6e4426'], rock: ['#7a3418', '#c2703f'],
      water: ['#3a2a20', '#6a4a30'], road: '#c88452', roadStyle: 'trail',
      mats: { 1: ['dunes', 'scree'], 2: ['scrub'], 3: ['boulder', 'rockfin'], 4: ['mesa', 'hive'] }
    },
    build(g, T) {
      // столовые горы — каньоны между ними
      g.noiseFill(14, 0.6, (x, y) => g.paint(x, y, T.BLOCK, 0), 4, field);
      // уступы у подножий
      const ledge = [];
      g.noiseFill(14, 0.55, (x, y) => { const k = y * N + x; if (g.t[k] === T.OPEN && !g.res[k]) { g.e[k] = 1; ledge.push([x, y]); } }, 4, field);
      g.rampsAround(ledge, 1, 12);
      // шпили-ульи
      g.place(22, 900, field, (x, y) => {
        const r = g.rnd(1.3, 2.6); return [g.diskCells(x, y, r), { k: 'hive', x: x, y: y, r: r }];
      }, T.BLOCK, 1, 1);
      g.noiseFill(9, 0.56, (x, y) => { if (g.t[y * N + x] === T.OPEN) g.paint(x, y, T.ROUGH, 0); });
      g.scatter(70, T.COVER, 0, { gap: 1, cluster: [1, 3], where: field });
      g.scatter(30, T.COVER, 1, { gap: 2, cluster: [2, 3], line: [1, 1], where: field });
      g.noiseFill(6, 0.7, (x, y) => { if (g.t[y * N + x] === T.OPEN) g.paint(x, y, T.LIGHT, 0); });
      // дороги — по готовой местности: в обход скал, коротко через воду и пропасти
      g.mainRoads({ amp: 9 });
    }
  },

  // ---------------------------------------------------------------- Хайпори
  hypori: {
    name: 'Хайпори', about: 'Пепельная пустошь: обломки кораблей, ржавые остовы, воронки. Пепел снижает обзор; остовы — крупные укрытия.',
    look: {
      ground: ['#2a2420', '#342c26', '#3e352d'], style: 'ash',
      rough: '#4b453f', light: ['#3a3029', '#2e2620'], rock: ['#1f1b18', '#4a423b'], metal: ['#5f5a54', '#8a837a'], accent: '#ff7a3a',
      water: ['#141414', '#2a2a2a'], road: '#4a4038', roadStyle: 'trail',
      mats: { 1: ['ash'], 2: ['crater'], 3: ['debris', 'boulder'], 4: ['rock', 'hull'] }
    },
    build(g, T) {
      // остовы кораблей — крупные обломки корпусов
      g.place(8, 600, field, (x, y) => {
        const a = g.R() * Math.PI, w = g.rnd(10, 17), h = g.rnd(3.5, 6), pts = g.rotRect(x, y, w, h, a);
        return [g.poly(pts), { k: 'hull', pts: pts, a: a, w: w, h: h, x: x, y: y, s: g.irnd(0, 2) }];
      }, T.BLOCK, 1, 2);
      g.objs.filter(o => o.k === 'hull').forEach(o => {
        for (let i = 0; i < 14; i++) {
          const d = g.rnd(o.w / 2 + 1, o.w / 2 + 5), a = g.R() * Math.PI * 2, x = Math.round(o.x + Math.cos(a) * d), y = Math.round(o.y + Math.sin(a) * d);
          if (g.okSpot(x, y, 0, {})) g.paint(x, y, T.COVER, 0);
        }
      });
      g.place(16, 500, field, (x, y) => { const r = g.rnd(2, 5); return [g.diskCells(x, y, r), { k: 'crater', x: x, y: y, r: r }]; }, T.LIGHT, 0, 0, [T.OPEN, T.ROUGH]);
      g.noiseFill(10, 0.64, (x, y) => g.paint(x, y, T.BLOCK, 0), 3, field);
      g.noiseFill(8, 0.5, (x, y) => { if (g.t[y * N + x] === T.OPEN) g.paint(x, y, T.ROUGH, 0); });
      g.scatter(60, T.COVER, 0, { gap: 1, cluster: [1, 3], where: field });
      g.scatter(50, T.COVER, 1, { gap: 1, where: field });
      // дороги — по готовой местности: в обход скал, коротко через воду и пропасти
      g.mainRoads({ amp: 6 });
    }
  },

  // ---------------------------------------------------------------- Камино
  kamino: {
    name: 'Камино', ortho: true, road: false, about: 'Океан и Типока: круглые платформы на сваях — купола, посадочные площадки, переходы между ними; вода — только для репульсоров и авиации. Дождь снижает обзор.',
    look: {
      ground: ['#9aa2a6', '#a8b0b4', '#8e979c'], style: 'plates',
      rough: '#7f888d', light: ['#6f8890', '#5a7078'], rock: ['#6a7378', '#c0c8cc'], accent: '#7fd8ff',
      water: ['#15222a', '#2c424d'], road: '#c3cbcf', roadStyle: 'walkway', bridge: 'walkway', ocean: true,
      mats: { 1: ['grate'], 2: ['puddles'], 3: ['module', 'railing'], 4: ['dome'] }
    },
    // Обжитое (ровная суша вокруг города, зон и участков) — только на платформах и у полосы вторжения:
    // иначе вокруг круглых платформ торчат квадратные углы
    reserve(g, T) {
      const D = kaminoPlan(), strip = N - STRIP - 6;
      g.kam = D;
      const inD = (x, y) => D.some(d => Math.hypot(x + 0.5 - d.x, y + 0.5 - d.y) <= d.r);
      for (let k = 0; k < N * N; k++) {
        const x = k % N, y = (k / N) | 0;
        if (y >= strip || inD(x, y)) continue;
        if (g.res[k] === 1) throw new Error('Камино: заповедная клетка вне платформ ' + x + ',' + y);
        if (g.res[k] === 3) { g.res[k] = 0; g.set3[k] = 0; }
      }
    },
    build(g, T) {
      const D = g.kam;
      g.t.fill(T.WATER);
      // платформы — круги (клетка суша, если внутри её центр); кромку и панели рисует отрисовка (kplat)
      D.forEach(d => {
        g.diskCells(d.x, d.y, d.r).forEach(c => g.paint(c[0], c[1], T.OPEN, 0));
        g.obj({ k: 'kplat', x: d.x, y: d.y, r: d.r, v: d.kind });
      });
      g.obj({ k: 'kdock', x: 0, y: N - STRIP - 6, w: N, h: STRIP + 6 });
      // купола Типоки: вокруг — кольцо прохода не уже 3 клеток
      D.forEach(d => {
        if (d.kind !== 'dome') return;
        const r = d.r - 3.5;
        g.stamp(g.diskCells(d.x, d.y, r), T.BLOCK, 0, { k: 'dome', x: d.x, y: d.y, r: r }, 0, [T.OPEN]);
      });
      // посадочные площадки — разметка; по краю четыре стойки ограждения
      D.forEach(d => {
        if (d.kind !== 'pad') return;
        g.obj({ k: 'kpad', x: d.x, y: d.y, r: d.r - 1.6 });
        for (let i = 0; i < 4; i++) {
          const a = Math.PI / 4 + i * Math.PI / 2, x = Math.floor(d.x + Math.cos(a) * (d.r - 2)), y = Math.floor(d.y + Math.sin(a) * (d.r - 2));
          if (g.okSpot(x, y, 0, {})) g.paint(x, y, T.COVER, 1);
        }
      });
      // главный переход: полоса вторжения → южные ворота (ось ворот — клетки 69..71); к зонам ведут
      // палубы северной грозди и переход z1 → nw
      g.corridor([[70, N - STRIP - 5], [70, g.town[1] + g.town[3] + 1]], 3, 'main', true);
      // переходы между платформами: прямые или с одним поворотом, от кромки до кромки
      const at = name => D.find(d => d.id === name);
      KAMINO_LINKS.forEach(l => {
        const A = at(l[0]), B = l[1] === 'strip' ? { x: A.x, y: N - STRIP - 5, r: 0 } : at(l[1]);
        const pts = kaminoWalk(A, B, l[3], l[2]);
        if (pts) g.corridor(pts, l[2], 'walk', true);
      });
      // укрытия: грузовые модули и ограждения — на палубах, не на площадках
      const onPad = (x, y) => D.some(d => d.kind === 'pad' && Math.hypot(x + 0.5 - d.x, y + 0.5 - d.y) <= d.r + 1);
      // у входов переходов — свободно (3 клетки): иначе толпа упирается в ящик у самого моста
      const nearWalk = (x, y) => { for (let j = -3; j <= 3; j++) for (let i = -3; i <= 3; i++) { const xx = x + i, yy = y + j; if (g.inb(xx, yy) && g.res[yy * N + xx] === 2) return true; } return false; };
      const off = (x, y) => !onPad(x, y) && !nearWalk(x, y);
      g.scatter(46, T.COVER, 0, { gap: 1, cluster: [1, 3], on: [T.OPEN], where: off });
      g.scatter(34, T.COVER, 0, { gap: 1, cluster: [1, 2], on: [T.OPEN], settled: true, where: off });
      D.forEach(d => { if (d.kind === 'mod') g.scatter(5, T.COVER, 0, { gap: 1, cluster: [2, 3], on: [T.OPEN], where: (x, y) => Math.hypot(x + 0.5 - d.x, y + 0.5 - d.y) <= d.r - 1.5 && !nearWalk(x, y) }); });
      g.noiseFill(5, 0.7, (x, y) => { if (g.t[y * N + x] === T.OPEN && !g.res[y * N + x] && off(x, y)) g.paint(x, y, T.ROUGH, 0); });
    }
  },

  // ---------------------------------------------------------------- Кашиик
  kashyyyk: {
    name: 'Кашиик', about: 'Лес вроширов: стволы-исполины, густой подлесок, поваленные деревья, озеро с песчаным берегом. Техника идёт по просекам.', ford: true,
    look: {
      ground: ['#2e4723', '#38552a', '#253c1e'], style: 'forest',
      rough: '#a39466', light: ['#2b4a1f', '#1d3416'], rock: ['#4a4436', '#6e6650'], bark: ['#5a4430', '#3a2c1f'],
      water: ['#1b3a3c', '#3f6f68'], road: '#6a5a3e', roadStyle: 'trail',
      mats: { 1: ['sand', 'roots'], 2: ['undergrowth', 'fern'], 3: ['log', 'stump', 'boulder'], 4: ['wroshyr', 'rock'] }
    },
    build(g, T) {
      // озеро на юго-востоке с песчаным берегом
      const lake = g.blob(116, 112, 520, (x, y) => g.paint(x, y, T.WATER, 0));
      lake.forEach(c => g.disk(c[0], c[1], 2.2, (x, y) => { if (g.t[y * N + x] === T.OPEN) g.paint(x, y, T.ROUGH, 0); }));
      // подлесок почти везде
      g.noiseFill(10, 0.38, (x, y, v) => { if (g.t[y * N + x] === T.OPEN) g.paint(x, y, T.LIGHT, v > 0.5 ? 1 : 0); }, 3);
      // стволы вроширов
      g.place(48, 2000, field, (x, y) => {
        const r = g.rnd(1.4, 3.6); return [g.diskCells(x, y, r), { k: 'wroshyr', x: x, y: y, r: r }];
      }, T.BLOCK, 0, 2, [T.OPEN, T.LIGHT, T.ROUGH]);
      // поваленные стволы и пни
      for (let i = 0; i < 26; i++) {
        const x0 = g.irnd(4, 138), y0 = g.irnd(52, 136), a = g.R() * Math.PI, L = g.irnd(3, 7);
        for (let k = 0; k < L; k++) { const x = Math.round(x0 + Math.cos(a) * k), y = Math.round(y0 + Math.sin(a) * k); if (g.okSpot(x, y, 0, {})) g.paint(x, y, T.COVER, 0); }
      }
      g.scatter(40, T.COVER, 1, { gap: 1, where: field });
      g.scatter(30, T.COVER, 2, { gap: 1, cluster: [1, 2], where: field });
      g.noiseFill(6, 0.72, (x, y) => { if (g.t[y * N + x] === T.LIGHT) g.paint(x, y, T.ROUGH, 1); });
      // дороги — по готовой местности: в обход скал, коротко через воду и пропасти
      g.mainRoads({ amp: 8 });
    }
  },

  // ---------------------------------------------------------------- Куат
  kuat: {
    name: 'Куат', about: 'Ухоженный мир: прямые каналы с мостиками, живые изгороди партеров, аллеи, виллы и фонтаны.',
    look: {
      ground: ['#4c873c', '#579646', '#457d35'], style: 'lawn',
      rough: '#b8b096', light: ['#62a04a', '#d86aa0'], rock: ['#a8a8a0', '#e8e6de'], hedge: '#2c5c28',
      water: ['#24647a', '#59a8c0'], road: '#d6d1c4', roadStyle: 'paved', bridge: 'stone',
      mats: { 1: ['gravel'], 2: ['meadow', 'flowers'], 3: ['hedge', 'tree', 'fountain'], 4: ['villa'] }
    },
    build(g, T) {
      g.mainRoads({ amp: 0 });
      // каналы — прямые, с мостиками на дорогах
      [96, 118].forEach(y => g.rect(0, y, N, 2, (i, j) => g.paint(i, j, T.WATER, 0)));
      [24, 118].forEach(x => g.rect(x, 50, 2, 90, (i, j) => g.paint(i, j, T.WATER, 0)));
      // мостики через каналы, кроме тех, что дали дороги
      [[12, 96], [50, 96], [92, 96], [132, 96], [12, 118], [50, 118], [92, 118], [132, 118], [24, 74], [118, 74], [24, 108], [118, 108], [24, 128], [118, 128]].forEach(p => {
        const horiz = p[0] === 24 || p[0] === 118;
        g.rect(horiz ? p[0] : p[0] - 1, horiz ? p[1] - 1 : p[1], horiz ? 2 : 3, horiz ? 3 : 2, (i, j) => { if (g.t[j * N + i] === T.WATER) g.paint(i, j, T.BRIDGE, 0); });
      });
      // виллы
      g.place(10, 500, field, (x, y) => {
        const w = g.irnd(6, 9), h = g.irnd(5, 7), x0 = Math.round(x), y0 = Math.round(y), cells = [];
        g.rect(x0, y0, w, h, (i, j) => cells.push([i, j]));
        return [cells, { k: 'villa', x: x0, y: y0, w: w, h: h, s: g.irnd(0, 2) }];
      }, T.BLOCK, 0, 2);
      // партеры: прямоугольники живых изгородей с проходами, внутри клумбы
      for (let i = 0; i < 16; i++) {
        const w = g.irnd(8, 14), h = g.irnd(6, 9), x0 = g.irnd(4, N - w - 4), y0 = g.irnd(52, 132 - h);
        let ok = true;
        g.rect(x0, y0, w + 1, h + 1, (x, y) => { if (g.res[y * N + x] || g.t[y * N + x] !== T.OPEN) ok = false; });
        if (!ok) continue;
        for (let k = 0; k <= w; k++) { if (Math.abs(k - w / 2) > 1.2) { g.paint(x0 + k, y0, T.COVER, 0); g.paint(x0 + k, y0 + h, T.COVER, 0); } }
        for (let k = 1; k < h; k++) { if (Math.abs(k - h / 2) > 1.2) { g.paint(x0, y0 + k, T.COVER, 0); g.paint(x0 + w, y0 + k, T.COVER, 0); } }
        g.rect(x0 + 2, y0 + 2, w - 3, h - 3, (x, y) => { if ((x + y) % 3) g.paint(x, y, T.LIGHT, 1); });
      }
      // аллеи деревьев вдоль дорог
      for (let y = 50; y < 134; y++) for (let x = 2; x < N - 2; x++) {
        const k = y * N + x;
        if (g.t[k] !== T.OPEN || g.res[k]) continue;
        const nearRoad = g.res[k - 1] === 2 || g.res[k + 1] === 2;
        if (nearRoad && y % 4 === 0) g.paint(x, y, T.COVER, 1);
      }
      g.place(6, 300, field, (x, y) => [g.diskCells(x, y, 1.1), { k: 'fountain', x: x, y: y }], T.COVER, 2, 2);
      g.noiseFill(8, 0.66, (x, y) => { if (g.t[y * N + x] === T.OPEN && !g.res[y * N + x]) g.paint(x, y, T.LIGHT, 0); });
    }
  },

  // ---------------------------------------------------------------- Майгито
  maygito: {
    name: 'Майгито', about: 'Ледяные пустоши: длинные разломы, ледяные скалы и шпили, снежные заносы. Снег замедляет пехоту.',
    look: {
      ground: ['#d4d0e1', '#c6c0d6', '#e2deec'], style: 'snow',
      rough: '#eceaf4', light: ['#b9c8e0', '#a8b8d4'], rock: ['#7d7896', '#b4b0c8'], ice: ['#8fb2dc', '#d8ecff'],
      void: 'crevasse', voidc: ['#0f1530', '#3a4a7a'], water: ['#2a3a6a', '#6a8ac0'], road: '#a9a4bd', roadStyle: 'packed',
      mats: { 1: ['snowdrift'], 2: ['frost'], 3: ['icecrystal', 'boulder'], 4: ['icecrag', 'icespire'], 6: ['crevasse'] }
    },
    build(g, T) {
      // разломы во льду — длинные трещины
      for (let i = 0; i < 7; i++) {
        const pts = g.walk(g.irnd(4, 140), g.irnd(54, 132), 9, 5, 0.45);
        g.stroke(pts, f => 1.6 + Math.sin(f * Math.PI) * 1.6, (x, y) => g.paint(x, y, T.VOID, 0));
      }
      // ледяные скалы
      g.noiseFill(11, 0.66, (x, y) => g.paint(x, y, T.BLOCK, 0), 4, field);
      g.place(14, 600, field, (x, y) => { const r = g.rnd(1.3, 2.4); return [g.diskCells(x, y, r), { k: 'icespire', x: x, y: y, r: r }]; }, T.BLOCK, 1, 1);
      // заносы снега — пехоту замедляют
      g.noiseFill(9, 0.48, (x, y) => { if (g.t[y * N + x] === T.OPEN) g.paint(x, y, T.ROUGH, 0); });
      g.scatter(70, T.COVER, 0, { gap: 1, cluster: [2, 4], where: field });
      g.scatter(40, T.COVER, 1, { gap: 1, where: field });
      g.noiseFill(7, 0.7, (x, y) => { if (g.t[y * N + x] === T.OPEN) g.paint(x, y, T.LIGHT, 0); });
      // дороги — по готовой местности: в обход скал, коротко через воду и пропасти
      g.mainRoads({ amp: 7 });
    }
  },

  // ---------------------------------------------------------------- Мустафар
  mustafar: {
    name: 'Мустафар', about: 'Базальтовые острова среди лавы, металлические переходы, вулканические столбы. Лава — только для авиации.',
    look: {
      ground: ['#2a1d1a', '#34241f', '#201614'], style: 'basalt',
      rough: '#4a3832', light: ['#3a2a24', '#5a2a18'], rock: ['#1a1210', '#4a3a34'],
      void: 'lava', voidc: ['#9a2208', '#ff6a1a', '#ffd25a'], water: ['#3a1a10', '#6a2a10'], road: '#4f4a48', roadStyle: 'metal', bridge: 'metal',
      mats: { 1: ['ash'], 2: ['cinder'], 3: ['obsidian', 'pipe'], 4: ['basaltspire', 'rock'], 6: ['lava'] }
    },
    build(g, T) {
      // лава всюду, где нет базальтовых островов
      const nz = g.noise(16, 4);
      for (let y = 48; y < N; y++) for (let x = 0; x < N; x++) if (nz(x, y) < 0.47) g.paint(x, y, T.VOID, 0);
      // лавовые реки от краёв
      for (let i = 0; i < 3; i++) g.stroke(g.walk(g.pick([2, 141]), g.irnd(60, 128), 10, 5, 0.4, null), f => 3 + 2 * Math.sin(f * Math.PI), (x, y) => g.paint(x, y, T.VOID, 0));
      g.place(20, 900, field, (x, y) => { const r = g.rnd(1.2, 2.4); return [g.diskCells(x, y, r), { k: 'basaltspire', x: x, y: y, r: r }]; }, T.BLOCK, 0, 1);
      g.noiseFill(7, 0.6, (x, y) => { if (g.t[y * N + x] === T.OPEN) g.paint(x, y, T.ROUGH, 0); });
      g.scatter(60, T.COVER, 0, { gap: 1, cluster: [1, 3], where: field });
      for (let i = 0; i < 5; i++) {
        const x0 = g.irnd(6, 128), y0 = g.irnd(52, 130), L = g.irnd(6, 12);
        for (let k = 0; k < L; k++) if (k % 5 !== 2 && g.okSpot(x0 + k, y0, 0, {})) g.paint(x0 + k, y0, T.COVER, 1);
      }
      // кромка у лавы — шлак (лёгкое укрытие)
      for (let y = 49; y < N - 1; y++) for (let x = 1; x < N - 1; x++) {
        const k = y * N + x;
        if (g.t[k] === T.OPEN && !g.res[k] && (g.t[k + 1] === T.VOID || g.t[k - 1] === T.VOID || g.t[k + N] === T.VOID || g.t[k - N] === T.VOID) && g.R() < 0.35) g.paint(x, y, T.LIGHT, 1);
      }
      // дороги — по готовой местности: в обход скал, коротко через воду и пропасти
      g.mainRoads({ amp: 4, sideW: 3 });
    }
  },

  // ---------------------------------------------------------------- Муунилинст
  muunilinst: {
    name: 'Муунилинст', about: 'Скалистые плато и нагорья, морские фьорды с запада и востока, каменные столбы.',
    look: { highTint: 0.3,
      ground: ['#c6bda4', '#b5ab93', '#d4cdba'], style: 'stone',
      rough: '#a39a85', light: ['#9aa48a', '#7f8a70'], rock: ['#958d7d', '#e2ddd0'], snow: '#f2f4f8',
      water: ['#1b5888', '#5aa1d2'], road: '#e2dccc', roadStyle: 'paved',
      mats: { 1: ['scree'], 2: ['heath'], 3: ['boulder', 'stele'], 4: ['rock', 'pillar'] }
    },
    build(g, T) {
      // фьорды с запада и востока
      [[0, 70], [0, 112], [N - 1, 62], [N - 1, 104], [N - 1, 128]].forEach(p => {
        const dir = p[0] === 0 ? 0 : Math.PI, pts = g.walk(p[0], p[1], g.irnd(5, 8), 4.5, 0.35, dir);
        g.stroke(pts, f => 10 * (1 - f) + 2.5, (x, y) => g.paint(x, y, T.WATER, 0));
      });
      // нагорья
      for (let i = 0; i < 5; i++) g.plateau(g.pick([g.irnd(14, 42), g.irnd(100, 128)]), g.irnd(56, 128), g.irnd(6, 11), 1, 3, 0.35);
      // каменные столбы
      g.place(26, 900, field, (x, y) => { const r = g.rnd(1, 2.2); return [g.diskCells(x, y, r), { k: 'pillar', x: x, y: y, r: r }]; }, T.BLOCK, 1, 1);
      g.noiseFill(10, 0.67, (x, y) => g.paint(x, y, T.BLOCK, 0), 3, field);
      g.noiseFill(7, 0.6, (x, y) => { if (g.t[y * N + x] === T.OPEN) g.paint(x, y, T.ROUGH, 0); });
      g.scatter(60, T.COVER, 0, { gap: 1, cluster: [1, 3], where: field });
      g.scatter(16, T.COVER, 1, { gap: 2, where: field });
      g.noiseFill(9, 0.66, (x, y) => { if (g.t[y * N + x] === T.OPEN) g.paint(x, y, T.LIGHT, 0); });
      // дороги — по готовой местности: в обход скал, коротко через воду и пропасти
      g.mainRoads({ amp: 6 });
    }
  },

  // ---------------------------------------------------------------- Набу
  naboo: {
    name: 'Набу', about: 'Холмистые луга, озёра и ручьи с бродами, болота, рощи и колоннады древних руин.', ford: true,
    look: { highTint: 0.12,
      ground: ['#58893a', '#669845', '#4c7a31'], style: 'grass',
      rough: '#6a7a4a', light: ['#4d6c38', '#3a5a2c'], rock: ['#9a9a88', '#d9d2bc'], stone: '#dcd3bb',
      water: ['#24687a', '#5aaab2'], road: '#cfc3a1', roadStyle: 'paved', bridge: 'stone',
      mats: { 1: ['mud'], 2: ['swamp', 'grove'], 3: ['column', 'tree', 'boulder'], 4: ['rock', 'ruinwall'] }
    },
    build(g, T) {
      // пологие холмы (много склонов)
      for (let i = 0; i < 6; i++) g.plateau(g.irnd(8, 136), g.irnd(56, 130), g.irnd(6, 10), 1, 6, 0.4);
      // озёра, ручьи, болота вокруг
      const lakes = [];
      for (let i = 0; i < 4; i++) {
        const cx = g.irnd(14, 130), cy = g.irnd(94, 130);
        lakes.push(g.blob(cx, cy, g.irnd(60, 160), (x, y) => { if (g.e[y * N + x] === 0) g.paint(x, y, T.WATER, 0); }));
        g.stroke(g.walk(cx, cy, 8, 5, 0.5), 1.5, (x, y) => { if (g.e[y * N + x] === 0) g.paint(x, y, T.WATER, 0); });
      }
      lakes.forEach(l => l.forEach(c => { if (g.R() < 0.2) g.disk(c[0], c[1], 3.2, (x, y) => { if (g.t[y * N + x] === T.OPEN) g.paint(x, y, T.LIGHT, 0); }, 0.4); }));
      // руины: колоннады
      for (let i = 0; i < 7; i++) {
        const x0 = g.irnd(6, 126), y0 = g.irnd(54, 130), horiz = g.R() < 0.5, L = g.irnd(6, 12);
        for (let k = 0; k < L; k += 2) { const x = horiz ? x0 + k : x0, y = horiz ? y0 : y0 + k; if (g.okSpot(x, y, 0, {})) g.paint(x, y, T.COVER, 0); }
        for (let k = 0; k < L; k += 2) { const x = horiz ? x0 + k : x0 + 4, y = horiz ? y0 + 4 : y0 + k; if (g.okSpot(x, y, 0, {})) g.paint(x, y, T.COVER, 0); }
      }
      g.noiseFill(9, 0.64, (x, y) => { if (g.t[y * N + x] === T.OPEN) g.paint(x, y, T.LIGHT, 1); });
      g.scatter(50, T.COVER, 1, { gap: 1, where: field });
      g.scatter(40, T.COVER, 2, { gap: 1, cluster: [1, 2], where: field });
      // дороги — по готовой местности: в обход скал, коротко через воду и пропасти
      g.mainRoads({ amp: 9 });
    }
  },

  // ---------------------------------------------------------------- Раксус
  raxus: {
    name: 'Раксус', about: 'Лиловые луга с высокой травой, рощи, круглые зеркальные озёра, парадные дороги со статуями. Трава скрывает пехоту вблизи.',
    look: {
      ground: ['#573c78', '#664887', '#4b3368'], style: 'grass',
      rough: '#7a6690', light: ['#8a64b4', '#3c2654'], rock: ['#6a5a80', '#c8bedc'], stone: '#d6cfe6',
      water: ['#24244e', '#8a8ad0'], road: '#cbc2dc', roadStyle: 'paved', bridge: 'stone',
      mats: { 1: ['gravel'], 2: ['tallgrass', 'lilacwood'], 3: ['statue', 'tree', 'boulder'], 4: ['rock', 'lilactree'] }
    },
    build(g, T) {
      g.mainRoads({ amp: 0, w: 4 });
      // зеркальные озёра — круглые
      g.place(5, 400, (x, y) => y > 92, (x, y) => [g.diskCells(x, y, g.rnd(4, 8)), { k: 'pond', x: x, y: y }], T.WATER, 0, 2);
      // высокая лиловая трава — скрывает пехоту вблизи
      g.noiseFill(12, 0.45, (x, y) => { if (g.t[y * N + x] === T.OPEN) g.paint(x, y, T.LIGHT, 0); }, 3);
      // лиловые рощи: деревья-скалы и подлесок
      g.noiseFill(10, 0.66, (x, y) => { if (g.t[y * N + x] === T.OPEN || g.t[y * N + x] === T.LIGHT) g.paint(x, y, T.LIGHT, 1); }, 3, field);
      g.place(40, 2000, field, (x, y) => { const r = g.rnd(0.9, 1.8); return [g.diskCells(x, y, r), { k: 'lilactree', x: x, y: y, r: r }]; }, T.BLOCK, 1, 1, [T.LIGHT]);
      // статуи вдоль парадных дорог
      for (let y = 50; y < 136; y += 5) for (let x = 2; x < N - 2; x++) {
        const k = y * N + x;
        if ((g.t[k] === T.OPEN || g.t[k] === T.LIGHT) && !g.res[k] && g.res[k - 1] === 2 && g.res[k + 1] !== 2) g.paint(x, y, T.COVER, 0);
        if ((g.t[k] === T.OPEN || g.t[k] === T.LIGHT) && !g.res[k] && g.res[k + 1] === 2 && g.res[k - 1] !== 2) g.paint(x, y, T.COVER, 0);
      }
      g.scatter(40, T.COVER, 1, { gap: 1, where: field, on: [T.OPEN, T.LIGHT] });
      g.scatter(40, T.COVER, 2, { gap: 1, cluster: [1, 2], where: field, on: [T.OPEN, T.LIGHT] });
    }
  },

  // ---------------------------------------------------------------- Рилот
  ryloth: {
    name: 'Рилот', about: 'Сухие мезы в два яруса, скальные гряды с проходами насквозь, пыльные равнины.',
    look: { highTint: 0.45,
      ground: ['#b5763a', '#c48645', '#a66a32'], style: 'sand',
      rough: '#cc9455', light: ['#7f7436', '#6e5e2a'], rock: ['#8a5428', '#d8a060'],
      water: ['#3a2a1a', '#7a5a3a'], road: '#d6a46a', roadStyle: 'trail',
      mats: { 1: ['dust'], 2: ['scrub'], 3: ['boulder', 'rockfin'], 4: ['mesa'], 0: ['ground', 'tunnel'] }
    },
    build(g, T) {
      // мезы — плато в два яруса
      for (let i = 0; i < 6; i++) {
        const cx = g.pick([g.irnd(10, 42), g.irnd(100, 134), g.irnd(40, 104)]), cy = g.irnd(96, 128), r = g.irnd(8, 13);
        g.plateau(cx, cy, r, 1, 3, 0.35);
        if (r > 10) g.plateau(cx + g.irnd(-2, 2), cy + g.irnd(-2, 2), r * 0.5, 2, 2, 0.3);
      }
      for (let i = 0; i < 3; i++) g.plateau(g.pick([g.irnd(8, 38), g.irnd(104, 136)]), g.irnd(56, 88), g.irnd(7, 11), 1, 3, 0.35);
      // скальные гряды и проходы сквозь них
      for (let i = 0; i < 6; i++) {
        const pts = g.walk(g.irnd(6, 138), g.irnd(54, 132), 5, 4, 0.4);
        g.stroke(pts, 4, (x, y) => { if (!g.res[y * N + x]) g.paint(x, y, T.BLOCK, 0); });
        // тоннель поперёк гряды
        const mid = pts[2], a = Math.atan2(pts[3][1] - pts[1][1], pts[3][0] - pts[1][0]) + Math.PI / 2;
        for (let k = -4; k <= 4; k++) { const x = Math.round(mid[0] + Math.cos(a) * k), y = Math.round(mid[1] + Math.sin(a) * k); if (g.inb(x, y) && g.t[y * N + x] === T.BLOCK) g.paint(x, y, T.OPEN, 1); }
        g.objs.push({ k: 'tunnel', x: mid[0], y: mid[1], a: a });
      }
      g.noiseFill(8, 0.6, (x, y) => { if (g.t[y * N + x] === T.OPEN && g.m[y * N + x] === 0) g.paint(x, y, T.ROUGH, 0); });
      g.scatter(60, T.COVER, 0, { gap: 1, cluster: [1, 3], where: field });
      g.scatter(20, T.COVER, 1, { gap: 2, cluster: [2, 3], line: [1, 0], where: field });
      g.noiseFill(7, 0.72, (x, y) => { if (g.t[y * N + x] === T.OPEN && g.m[y * N + x] === 0) g.paint(x, y, T.LIGHT, 0); });
      // дороги — по готовой местности: в обход скал, коротко через воду и пропасти
      g.mainRoads({ amp: 7 });
    }
  },

  // ---------------------------------------------------------------- Умбара
  umbara: {
    name: 'Умбара', about: 'Вечная тьма: скалистые гряды, грибовидные деревья, светящаяся флора выдаёт тех, кто рядом. Обзор ниже у всех.',
    look: {
      ground: ['#1d1525', '#251b2f', '#17111d'], style: 'moss',
      rough: '#2c2338', light: ['#2a1d3a', '#3a1a2e'], rock: ['#2b2236', '#4c3e5c'], glow: ['#ff5a7a', '#6affd4', '#b07aff'],
      water: ['#0c0a18', '#2a2050'], road: '#2e2638', roadStyle: 'trail',
      mats: { 1: ['moss'], 2: ['glowflora', 'thorns'], 3: ['boulder', 'pod'], 4: ['rock', 'shroom'] }
    },
    build(g, T) {
      // скалистые гряды
      for (let i = 0; i < 7; i++) {
        const pts = g.walk(g.irnd(4, 140), g.irnd(54, 132), 7, 5, 0.4);
        g.stroke(pts, f => 2 + 2.5 * Math.sin(f * Math.PI), (x, y) => g.paint(x, y, T.BLOCK, 0));
      }
      // грибовидные деревья
      g.place(36, 1500, field, (x, y) => { const r = g.rnd(1, 2.4); return [g.diskCells(x, y, r), { k: 'shroom', x: x, y: y, r: r, c: g.irnd(0, 2) }]; }, T.BLOCK, 1, 1);
      // светящаяся флора выдаёт тех, кто рядом; колючки — заросли
      g.noiseFill(8, 0.6, (x, y) => { if (g.t[y * N + x] === T.OPEN) g.paint(x, y, T.LIGHT, 0); });
      g.noiseFill(11, 0.62, (x, y) => { if (g.t[y * N + x] === T.OPEN) g.paint(x, y, T.LIGHT, 1); });
      g.noiseFill(7, 0.58, (x, y) => { if (g.t[y * N + x] === T.OPEN) g.paint(x, y, T.ROUGH, 0); });
      g.scatter(60, T.COVER, 0, { gap: 1, cluster: [1, 3], where: field });
      g.scatter(40, T.COVER, 1, { gap: 1, where: field });
      // дороги — по готовой местности: в обход скал, коротко через воду и пропасти
      g.mainRoads({ amp: 7 });
    }
  },

  // ---------------------------------------------------------------- Утапау
  utapau: {
    name: 'Утапау', about: 'Равнины с огромными провалами, кустарник, скальные островки. Провалы делят поле на части.',
    look: {
      ground: ['#b4976a', '#a5875b', '#c4a678'], style: 'sand',
      rough: '#c9b083', light: ['#7f8c4c', '#66723a'], rock: ['#8a7454', '#cdb68c'],
      void: 'sinkhole', voidc: ['#120e0a', '#4a3a28'], water: ['#3a5a5a', '#7aa0a0'], road: '#d2bb8e', roadStyle: 'trail', bridge: 'rope',
      mats: { 1: ['gravel'], 2: ['scrub'], 3: ['boulder', 'rockfin'], 4: ['rock'], 6: ['sinkhole'] }
    },
    build(g, T) {
      // провалы
      g.place(9, 900, field, (x, y) => {
        const r = g.rnd(5, 12); return [g.diskCells(x, y, r), { k: 'sinkhole', x: x, y: y, r: r }];
      }, T.VOID, 0, 3, [T.OPEN]);
      g.objs.filter(o => o.k === 'sinkhole').forEach(o => g.disk(o.x, o.y, o.r + 2.4, (x, y) => { if (g.t[y * N + x] === T.OPEN) g.paint(x, y, T.ROUGH, 0); }, 0.25));
      // кустарник, скальные островки
      g.noiseFill(7, 0.58, (x, y) => { if (g.t[y * N + x] === T.OPEN) g.paint(x, y, T.LIGHT, 0); });
      g.noiseFill(12, 0.69, (x, y) => g.paint(x, y, T.BLOCK, 0), 3, field);
      g.scatter(70, T.COVER, 0, { gap: 1, cluster: [1, 3], where: field });
      g.scatter(20, T.COVER, 1, { gap: 2, where: field });
      // дороги — по готовой местности: в обход скал, коротко через воду и пропасти
      g.mainRoads({ amp: 9 });
    }
  }
};
