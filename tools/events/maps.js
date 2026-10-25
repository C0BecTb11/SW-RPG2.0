// Профили карт ивентов (выдуманные локации) для генератора tools/events/gen.js.
//
// layout — разметка ивента: base — лагерь охотников [x, y, w, h]; prey — старты добычи
// (ситха или джедаев), sites — места задач 5×5 [x, y, имя], exits — точки эвакуации 6×6.
// build(g, T) рисует местность тем же построителем, что у планет; заповедное он бережёт сам.
// hunt — для какой охоты карта: 'sith' или 'jedi'. night — насколько клеток игры меньше видят все.
//
// Оборона (defense: 'r' — Республика держит аванпост, 'c' — КНС держит завод): layout.kind = 'defense',
// core — ядро базы [x, y] (предмет coreKind, имя coreName), plaza — радиус ровной площадки базы,
// zone — радиус зоны ядра (там враг ломает базу), spawns — высадки врага 8×8 [x, y, имя] у краёв,
// waveK — поправка силы волн на этой карте.
'use strict';

const N = 144;
const inner = (x, y) => x > 6 && y > 6 && x < N - 7 && y < N - 7;
// Далеко ли точка от разметки ивента (лагерь, старты, задачи, эвакуация) — для высот:
// заповедное лежит на базовой высоте, и холм рядом дал бы обрыв
function far(g, x, y, r) {
  const L = g.lay, boxes = [];
  if (L.kind === 'defense') { boxes.push([L.core[0] - L.plaza, L.core[1] - L.plaza, L.plaza * 2, L.plaza * 2]); L.spawns.forEach(p => boxes.push([p[0], p[1], 8, 8])); }
  else {
    boxes.push([L.base[0], L.base[1], L.base[2], L.base[3]]);
    L.prey.forEach(p => boxes.push([p[0], p[1], 5, 5])); L.sites.forEach(p => boxes.push([p[0], p[1], 5, 5])); L.exits.forEach(p => boxes.push([p[0], p[1], 6, 6]));
  }
  return boxes.every(b => Math.max(b[0] - x, x - (b[0] + b[2]), 0) > r || Math.max(b[1] - y, y - (b[1] + b[3]), 0) > r);
}
// Холм в два яруса со склонами, не ближе r+6 к разметке; n попыток
function hills(g, n, r0, r1, two) {
  let made = 0;
  for (let t = 0; t < n * 40 && made < n; t++) {
    const x = g.irnd(12, N - 13), y = g.irnd(12, N - 13), r = g.irnd(r0, r1);
    if (!far(g, x, y, r + 6)) continue;
    g.plateau(x, y, r, 1, 3, 0.3);
    if (two && r >= 8) g.plateau(x, y, Math.round(r * 0.5), 2, 2, 0.25);
    made++;
  }
  return made;
}

module.exports = {

  // ================================================================ охота на ситха
  // ---------------------------------------------------------------- Руины Каэр-Теш
  kaer_tesh: {
    hunt: 'sith', name: 'Руины Каэр-Теш',
    about: 'Храм забытого ордена в джунглях: ступенчатая пирамида в центре, колоннады, ручьи и сплошной подлесок. Видно недалеко — враг выходит из зарослей вплотную.',
    look: { highTint: 0.1,
      ground: ['#2f4824', '#3a5a2c', '#28401f'], style: 'forest',
      rough: '#8d8462', light: ['#2f5222', '#1f3a17'], rock: ['#6a6656', '#a39e88'], stone: '#cfc6a8', bark: ['#5a4430', '#3a2c1f'],
      water: ['#1d3c38', '#3f6e60'], road: '#9a8a64', roadStyle: 'stone', bridge: 'stone',
      mats: { 1: ['mud', 'roots'], 2: ['undergrowth', 'fern'], 3: ['column', 'stump', 'ruin'], 4: ['ruinwall', 'wroshyr'] }
    },
    layout: {
      base: [56, 128, 32, 10],
      prey: [[14, 10], [70, 6], [124, 12]],
      sites: [[22, 52, 'Алтарь Луны'], [62, 62, 'Святилище пирамиды'], [114, 48, 'Обсерватория'], [32, 96, 'Склеп жрецов'], [104, 96, 'Зал голокронов']],
      exits: [[4, 70, 'Западная поляна'], [134, 76, 'Восточный причал'], [70, 22, 'Северные врата']]
    },
    build(g, T) {
      // ручьи с бродами
      for (let i = 0; i < 3; i++) {
        const pts = g.walk(g.irnd(10, 134), g.irnd(30, 110), 10, 6, 0.5);
        g.stroke(pts, 1.8, (x, y) => g.paint(x, y, T.WATER, 0));
      }
      // ступенчатая пирамида: три яруса с лестницами
      [[72, 70, 20, 1], [72, 70, 13, 2], [72, 70, 7, 3]].forEach(p => {
        const cells = [];
        g.rect(p[0] - p[2], p[1] - p[2], p[2] * 2, p[2] * 2, (x, y) => { if (!g.res[y * N + x] || g.res[y * N + x] === 2) { g.e[y * N + x] = Math.max(g.e[y * N + x], p[3]); cells.push([x, y]); } });
        g.rampsAround(cells, p[3], 4);
      });
      // колоннады и обрушенные стены
      for (let i = 0; i < 14; i++) {
        const x0 = g.irnd(8, 130), y0 = g.irnd(20, 120), hor = g.R() < 0.5, L = g.irnd(6, 14);
        for (let k = 0; k < L; k += 2) { const x = hor ? x0 + k : x0, y = hor ? y0 : y0 + k; if (g.okSpot(x, y, 0, {})) g.paint(x, y, T.COVER, 0); }
      }
      for (let i = 0; i < 18; i++) {
        const x0 = g.irnd(8, 130), y0 = g.irnd(16, 124), a = g.R() * Math.PI, L = g.irnd(3, 8);
        for (let k = 0; k < L; k++) { const x = Math.round(x0 + Math.cos(a) * k), y = Math.round(y0 + Math.sin(a) * k); if (g.okSpot(x, y, 0, {})) g.paint(x, y, T.BLOCK, 0); }
      }
      // гиганты джунглей
      g.place(34, 2000, inner, (x, y) => { const r = g.rnd(1.3, 3); return [g.diskCells(x, y, r), { k: 'wroshyr', x: x, y: y, r: r }]; }, T.BLOCK, 1, 2, [T.OPEN, T.LIGHT, T.ROUGH]);
      g.place(10, 600, inner, (x, y) => { const r = g.rnd(0.8, 1.3); return [g.diskCells(x, y, r), { k: 'pillar', x: x, y: y, r: r }]; }, T.BLOCK, 0, 1);
      // подлесок почти сплошной
      g.noiseFill(9, 0.47, (x, y, v) => { if (g.t[y * N + x] === T.OPEN && !g.res[y * N + x]) g.paint(x, y, T.LIGHT, v > 0.5 ? 1 : 0); }, 3);
      g.noiseFill(6, 0.74, (x, y) => { if (g.t[y * N + x] === T.LIGHT) g.paint(x, y, T.ROUGH, 0); });
      g.scatter(40, T.COVER, 1, { gap: 1, where: inner });
      g.roads({ w: 2, wig: 1.2 });
    }
  },

  // ---------------------------------------------------------------- Ледяной рудник Хольм-7
  holm7: {
    hunt: 'sith', name: 'Ледяной рудник Хольм-7', seedSalt: 3, night: 1,
    about: 'Брошенный рудник на ледяной луне: трещины во льду, отвалы, склады и контейнеры. Метель режет обзор, снег замедляет пехоту, у складов — укрытия.',
    look: {
      ground: ['#d6d4e2', '#c8c3d8', '#e4e1ee'], style: 'snow',
      rough: '#eeecf5', light: ['#bccbe2', '#a9b9d4'], rock: ['#7b7794', '#b2aec6'], ice: ['#8fb2dc', '#d8ecff'],
      void: 'crevasse', voidc: ['#0f1530', '#3a4a7a'], water: ['#2a3a6a', '#6a8ac0'], road: '#a7a2bb', roadStyle: 'packed', bridge: 'metal',
      mats: { 1: ['snowdrift', 'ore'], 2: ['frost'], 3: ['container', 'icecrystal', 'oretruck'], 4: ['icecrag', 'icespire'], 6: ['crevasse'] }
    },
    layout: {
      base: [56, 128, 32, 10],
      prey: [[10, 14], [66, 8], [128, 16]],
      sites: [[26, 44, 'Буровая №3'], [72, 50, 'Диспетчерская'], [112, 40, 'Склад взрывчатки'], [40, 92, 'Насосная'], [100, 90, 'Реактор рудника']],
      exits: [[2, 96, 'Западный шлюз'], [136, 64, 'Посадочная площадка'], [100, 4, 'Подъёмник']]
    },
    build(g, T) {
      // трещины во льду
      for (let i = 0; i < 6; i++) {
        const pts = g.walk(g.irnd(6, 138), g.irnd(20, 118), 8, 6, 0.45);
        g.stroke(pts, f => 1.4 + Math.sin(f * Math.PI) * 1.4, (x, y) => g.paint(x, y, T.VOID, 0));
      }
      // отвалы и снежные холмы с подъёмами
      hills(g, 5, 6, 10, false);
      g.place(4, 400, inner, (x, y) => [[[Math.round(x), Math.round(y)]], { k: 'spoil', x: x, y: y }], T.ROUGH, 0, 1);
      // склады и бараки
      g.place(12, 800, inner, (x, y) => {
        const w = g.irnd(5, 9), h = g.irnd(4, 6), x0 = Math.round(x), y0 = Math.round(y), cells = [];
        g.rect(x0, y0, w, h, (i, j) => cells.push([i, j]));
        return [cells, { k: 'warehouse', x: x0, y: y0, w: w, h: h, s: g.irnd(0, 3) }];
      }, T.BLOCK, 0, 2);
      // ледяные шпили и глыбы
      g.place(22, 1200, inner, (x, y) => { const r = g.rnd(1, 2.4); return [g.diskCells(x, y, r), { k: 'icespire', x: x, y: y, r: r }]; }, T.BLOCK, 1, 2);
      // контейнеры рядами у складов
      for (let i = 0; i < 16; i++) g.scatter(1, T.COVER, 0, { gap: 1, cluster: [2, 4], line: g.R() < 0.5 ? [1, 0] : [0, 1], where: inner });
      g.scatter(30, T.COVER, 1, { gap: 1, cluster: [1, 2], where: inner });
      // заносы
      g.noiseFill(7, 0.6, (x, y) => { if (g.t[y * N + x] === T.OPEN && !g.res[y * N + x]) g.paint(x, y, T.ROUGH, 0); });
      g.roads({ w: 3, wig: 0.5 });
    }
  },

  // ---------------------------------------------------------------- Город-призрак Сарн
  sarn: {
    hunt: 'sith', name: 'Город-призрак Сарн',
    about: 'Колония, покинутая после чумы: кварталы пустых домов, проспекты с баррикадами, воронки и остовы техники. Бой на коротких улицах, за углами.',
    night: 1,
    look: {
      ground: ['#4a4844', '#55524c', '#3f3d3a'], style: 'concrete',
      rough: '#6f6a60', light: ['#3d3c38', '#47463f'], rock: ['#76746e', '#a3a099'],
      water: ['#1d2b33', '#34505c'], road: '#6c6962', roadStyle: 'asphalt', bridge: 'metal',
      mats: { 1: ['rubble', 'debris'], 2: ['weeds', 'crater'], 3: ['barrier', 'tankwreck', 'ruin'], 4: ['rock', 'wreck'] }
    },
    layout: {
      base: [56, 128, 32, 10],
      prey: [[12, 8], [70, 10], [126, 8]],
      sites: [[20, 40, 'Клиника'], [68, 44, 'Ратуша'], [116, 36, 'Узел связи'], [28, 88, 'Космопорт'], [108, 84, 'Хранилище данных']],
      exits: [[2, 58, 'Тоннель метро'], [136, 110, 'Стоки'], [44, 2, 'Северная крыша']]
    },
    ortho: true,
    build(g, T) {
      // кварталы: сетка улиц, в каждом — дома с проходами
      for (let by = 12; by < 124; by += 16) for (let bx = 6; bx < 136; bx += 16) {
        if (g.R() < 0.18) continue;                                   // пустырь
        const w = g.irnd(6, 11), h = g.irnd(5, 10), x0 = bx + g.irnd(1, 3), y0 = by + g.irnd(1, 3), cells = [];
        g.rect(x0, y0, w, h, (i, j) => cells.push([i, j]));
        if (!g.stamp(cells, T.BLOCK, 0, { k: g.R() < 0.6 ? 'warehouse' : 'tower', x: x0, y: y0, w: w, h: h, z: g.irnd(1, 4), s: g.irnd(0, 3) }, 1)) continue;
      }
      // баррикады поперёк улиц
      for (let i = 0; i < 22; i++) g.scatter(1, T.COVER, 0, { gap: 1, cluster: [3, 5], line: g.R() < 0.5 ? [1, 0] : [0, 1], where: inner });
      // воронки и остовы
      g.place(12, 600, inner, (x, y) => { const r = g.rnd(1.6, 3.2); return [g.diskCells(x, y, r), { k: 'crater', x: x, y: y, r: r }]; }, T.ROUGH, 0, 0);
      g.scatter(26, T.COVER, 1, { gap: 1, where: inner });
      g.scatter(30, T.COVER, 2, { gap: 1, cluster: [1, 2], where: inner });
      g.noiseFill(6, 0.66, (x, y) => { if (g.t[y * N + x] === T.OPEN && !g.res[y * N + x]) g.paint(x, y, T.ROUGH, 0); });
      g.roads({ w: 3, wig: 0.2 });
    }
  },

  // ---------------------------------------------------------------- Болота Мирр-Ваал
  mirr_vaal: {
    hunt: 'sith', name: 'Болота Мирр-Ваал',
    about: 'Туманные топи: протоки и броды, тростник по пояс, грибные рощи и сваи старой фактории. В тростнике не видно дальше нескольких шагов.',
    ford: true,
    look: { highTint: 0.08,
      ground: ['#3a4a32', '#45573a', '#33422c'], style: 'moss',
      rough: '#5e5a3c', light: ['#4e6a3a', '#3a5230'], rock: ['#5a5a4e', '#8a8a76'],
      water: ['#24382e', '#4a6a54'], road: '#6e6248', roadStyle: 'walkway', bridge: 'pier',
      mats: { 1: ['mud', 'puddles'], 2: ['swamp', 'tallgrass'], 3: ['log', 'shroom', 'stump'], 4: ['rock', 'lilacwood'] }
    },
    layout: {
      base: [56, 128, 32, 10],
      prey: [[16, 12], [72, 8], [122, 14]],
      sites: [[24, 48, 'Затонувший фрегат'], [70, 56, 'Фактория'], [112, 52, 'Гнездо крикунов'], [40, 96, 'Маяк на сваях'], [96, 100, 'Лаборатория']],
      exits: [[4, 120, 'Лодочная станция'], [134, 30, 'Старая просека'], [66, 2, 'Скалистый гребень']]
    },
    build(g, T) {
      // протоки (броды — где их пересекают дороги)
      for (let i = 0; i < 8; i++) {
        const pts = g.walk(g.irnd(4, 140), g.irnd(16, 124), 12, 5, 0.6);
        g.stroke(pts, f => 1.6 + Math.sin(f * Math.PI * 2) * 0.8, (x, y) => g.paint(x, y, T.WATER, 0));
      }
      for (let i = 0; i < 6; i++) g.blob(g.irnd(10, 134), g.irnd(20, 120), g.irnd(40, 120), (x, y) => g.paint(x, y, T.WATER, 0));
      // грибные рощи и кривые деревья
      g.place(26, 1500, inner, (x, y) => { const r = g.rnd(1.2, 2.6); return [g.diskCells(x, y, r), { k: 'shroom', x: x, y: y, r: r, c: g.irnd(0, 2) }]; }, T.BLOCK, 1, 1);
      g.place(18, 1200, inner, (x, y) => { const r = g.rnd(1.3, 2.4); return [g.diskCells(x, y, r), { k: 'lilactree', x: x, y: y, r: r }]; }, T.BLOCK, 1, 1);
      // тростник и топь
      g.noiseFill(8, 0.58, (x, y, v) => { if (g.t[y * N + x] === T.OPEN && !g.res[y * N + x]) g.paint(x, y, T.LIGHT, v > 0.45 ? 1 : 0); }, 3);
      g.noiseFill(5, 0.6, (x, y) => { if ((g.t[y * N + x] === T.OPEN || g.t[y * N + x] === T.LIGHT) && !g.res[y * N + x]) g.paint(x, y, T.ROUGH, 0); });
      g.scatter(36, T.COVER, 0, { gap: 1, cluster: [1, 3], where: inner, on: [T.OPEN, T.ROUGH, T.LIGHT] });
      g.roads({ w: 2, wig: 1 });
    }
  },

  // ================================================================ охота на джедаев
  // ---------------------------------------------------------------- Монастырь Ул-Тарен
  ul_taren: {
    hunt: 'jedi', name: 'Монастырь Ул-Тарен',
    about: 'Горный монастырь на террасах: лестницы между ярусами, колоннады, кельи и башни. Кто выше — тот видит дальше; к верхним дворам ведут узкие подъёмы.',
    look: { highTint: 0.14,
      ground: ['#8a8676', '#99947f', '#7d7968'], style: 'stone',
      rough: '#a39a85', light: ['#8a9a7a', '#73806a'], rock: ['#958d7d', '#e2ddd0'], snow: '#f2f4f8', stone: '#e0d8c4',
      water: ['#1b5888', '#5aa1d2'], road: '#d8d0bc', roadStyle: 'paved', bridge: 'arch',
      mats: { 1: ['scree', 'gravel'], 2: ['heath'], 3: ['column', 'stele', 'statue'], 4: ['rock', 'pillar'] }
    },
    layout: {
      base: [56, 128, 32, 10],
      prey: [[16, 10], [70, 4], [124, 10]],
      sites: [[24, 40, 'Келья наставника'], [70, 36, 'Зал медитаций'], [114, 42, 'Библиотека'], [36, 84, 'Колокольня'], [104, 86, 'Ворота паломников']],
      exits: [[2, 20, 'Горная тропа'], [136, 20, 'Канатная дорога'], [136, 100, 'Нижний мост']]
    },
    build(g, T) {
      // террасы: горные уступы в два яруса между дворами монастыря
      hills(g, 9, 8, 14, true);
      // скалы по краям
      g.noiseFill(7, 0.7, (x, y) => { if ((x < 14 || x > 130) && g.t[y * N + x] === T.OPEN) g.paint(x, y, T.BLOCK, 0); });
      // кельи и башни
      g.place(14, 900, inner, (x, y) => {
        const w = g.irnd(4, 7), h = g.irnd(4, 6), x0 = Math.round(x), y0 = Math.round(y), cells = [];
        g.rect(x0, y0, w, h, (i, j) => cells.push([i, j]));
        return [cells, { k: 'tower', x: x0, y: y0, w: w, h: h, z: g.irnd(1, 3), s: g.irnd(0, 3) }];
      }, T.BLOCK, 0, 2);
      g.place(18, 900, inner, (x, y) => { const r = g.rnd(0.8, 1.2); return [g.diskCells(x, y, r), { k: 'pillar', x: x, y: y, r: r }]; }, T.BLOCK, 1, 1);
      // колоннады вдоль террас
      for (let y = 30; y <= 70; y += 20) for (let x = 12; x < N - 12; x += 3) if (g.R() < 0.45 && g.okSpot(x, y + 2, 0, {})) g.paint(x, y + 2, T.COVER, 0);
      g.scatter(30, T.COVER, 1, { gap: 1, where: inner });
      g.noiseFill(8, 0.64, (x, y) => { if (g.t[y * N + x] === T.OPEN && !g.res[y * N + x]) g.paint(x, y, T.LIGHT, 0); });
      g.roads({ w: 3, wig: 0.6 });
    }
  },

  // ---------------------------------------------------------------- Каньоны Дрэкса
  drex: {
    hunt: 'jedi', name: 'Каньоны Дрэкса',
    about: 'Красные каньоны: узкие проходы между столовыми горами, обрывы, базальтовые иглы и сухие русла. На гребнях — снайперская позиция, внизу — засада за каждым поворотом.',
    look: {
      ground: ['#a8643a', '#b5703f', '#9a5a33'], style: 'sand',
      rough: '#c27342', light: ['#7a5a30', '#6e4426'], rock: ['#7a3418', '#c2703f'],
      water: ['#3a2a20', '#6a4a30'], road: '#c88452', roadStyle: 'trail',
      mats: { 1: ['dunes', 'scree'], 2: ['scrub'], 3: ['boulder', 'rockfin'], 4: ['mesa', 'basaltspire'] }
    },
    layout: {
      base: [56, 128, 32, 10],
      prey: [[12, 12], [68, 6], [126, 10]],
      sites: [[18, 46, 'Пещера отшельника'], [66, 52, 'Разбитый транспорт'], [118, 44, 'Маяк контрабандистов'], [34, 92, 'Сухой колодец'], [104, 92, 'Каменный мост']],
      exits: [[2, 74, 'Западное ущелье'], [136, 70, 'Восточный каньон'], [98, 2, 'Плато']]
    },
    build(g, T) {
      // столовые горы: каньоны между ними
      for (let i = 0; i < 16; i++) {
        const cx = g.irnd(10, 134), cy = g.irnd(14, 120), r = g.irnd(5, 10);
        g.disk(cx, cy, r, (x, y) => g.paint(x, y, T.BLOCK, 0), 0.35);
        if (g.R() < 0.4) g.objs.push({ k: 'mesa', x: cx, y: cy, r: r });
      }
      // гребни-высоты с подъёмами
      for (let i = 0; i < 5; i++) g.plateau(g.irnd(16, 128), g.irnd(20, 116), g.irnd(5, 8), 1, 2, 0.3);
      // базальтовые иглы
      g.place(20, 1200, inner, (x, y) => { const r = g.rnd(0.8, 1.6); return [g.diskCells(x, y, r), { k: 'basaltspire', x: x, y: y, r: r }]; }, T.BLOCK, 1, 1);
      // сухие русла
      for (let i = 0; i < 3; i++) g.stroke(g.walk(g.irnd(10, 134), g.irnd(20, 120), 9, 6, 0.4), 2.2, (x, y) => { if (g.t[y * N + x] === T.OPEN) g.paint(x, y, T.ROUGH, 0); });
      g.scatter(40, T.COVER, 0, { gap: 1, cluster: [1, 3], where: inner });
      g.scatter(20, T.COVER, 1, { gap: 1, where: inner });
      g.noiseFill(8, 0.68, (x, y) => { if (g.t[y * N + x] === T.OPEN && !g.res[y * N + x]) g.paint(x, y, T.LIGHT, 0); });
      g.roads({ w: 2, wig: 1 });
    }
  },

  // ---------------------------------------------------------------- Пустошь Кесс
  kess: {
    hunt: 'jedi', name: 'Пустошь Кесс',
    about: 'Пепельная равнина после орбитальной бомбардировки: воронки, обломки крейсера, остовы танков и провалы. Пепельная буря скрывает дальние цели — укрытие только в обломках.',
    night: 1,
    look: {
      ground: ['#4c4642', '#57504a', '#433e3a'], style: 'ash',
      rough: '#6a625a', light: ['#5a5248', '#4a443c'], rock: ['#3a3634', '#6a6460'],
      void: 'sinkhole', voidc: ['#0c0a0a', '#2a2420'], water: ['#2a2a2a', '#4a4a48'], road: '#6e665e', roadStyle: 'gravel',
      mats: { 1: ['ash', 'cinder'], 2: ['crater', 'scrub'], 3: ['tankwreck', 'debris', 'boulder'], 4: ['hull', 'rock'] }
    },
    layout: {
      base: [56, 128, 32, 10],
      prey: [[14, 8], [70, 6], [124, 8]],
      sites: [[26, 42, 'Спасательная капсула'], [70, 60, 'Мостик крейсера'], [110, 40, 'Склад медикаментов'], [30, 92, 'Бункер связи'], [108, 96, 'Эвакопункт']],
      exits: [[2, 30, 'Северо-западный разлом'], [136, 54, 'Шаттл контрабандистов'], [2, 112, 'Старая шахта']]
    },
    build(g, T) {
      // воронки
      g.place(26, 1600, inner, (x, y) => { const r = g.rnd(2, 5); return [g.diskCells(x, y, r), { k: 'crater', x: x, y: y, r: r }]; }, T.ROUGH, 0, 0);
      // провалы
      for (let i = 0; i < 5; i++) { const cx = g.irnd(12, 132), cy = g.irnd(18, 118); g.disk(cx, cy, g.rnd(2, 4), (x, y) => g.paint(x, y, T.VOID, 0), 0.3); g.objs.push({ k: 'sinkhole', x: cx, y: cy, r: 3 }); }
      // обломки крейсера: длинный корпус через карту
      const pts = []; for (let k = 0; k < 6; k++) pts.push([40 + k * 12, 74 + Math.round(Math.sin(k) * 4)]);
      pts.forEach((p, i) => { if (i % 2) return; const a = 0.08 * i, w = g.irnd(7, 10), h = g.irnd(4, 5); const cells = g.poly(g.rotRect(p[0], p[1], w, h, a)); g.stamp(cells, T.BLOCK, 0, { k: 'hull', pts: g.rotRect(p[0], p[1], w, h, a), a: a, w: w, h: h, x: p[0], y: p[1], s: g.irnd(0, 2) }, 1); });
      // остовы танков и мусор
      g.place(16, 900, inner, (x, y) => { const a = g.R() * Math.PI, pts2 = g.rotRect(x, y, g.rnd(2.5, 4), g.rnd(1.6, 2.2), a); return [g.poly(pts2), { k: 'wreck', pts: pts2, a: a, s: g.irnd(0, 2) }]; }, T.BLOCK, 0, 1);
      g.scatter(80, T.COVER, 0, { gap: 1, cluster: [1, 3], where: inner });
      g.scatter(50, T.COVER, 1, { gap: 1, cluster: [1, 3], where: inner });
      g.place(10, 900, inner, (x, y) => { const a = g.R() * Math.PI, pts2 = g.rotRect(x, y, g.rnd(2.5, 4), g.rnd(1.6, 2.2), a); return [g.poly(pts2), { k: 'wreck', pts: pts2, a: a, s: g.irnd(0, 2) }]; }, T.BLOCK, 0, 1);
      g.noiseFill(6, 0.62, (x, y) => { if (g.t[y * N + x] === T.OPEN && !g.res[y * N + x]) g.paint(x, y, T.ROUGH, 0); });
      g.roads({ w: 2, wig: 0.8 });
    }
  },

  // ---------------------------------------------------------------- Затонувший город Ниир
  niir: {
    hunt: 'jedi', name: 'Затонувший город Ниир',
    about: 'Город, ушедший под воду: кварталы-острова, мостки и арки, затопленные площади. Над водой стоит туман; обойти можно только по мостам.',
    night: 1,
    look: {
      ground: ['#5a6670', '#66727c', '#505c66'], style: 'plates',
      rough: '#78848c', light: ['#4e6a6a', '#3e5a5a'], rock: ['#5a646c', '#9aa4ac'],
      water: ['#18384a', '#3a6a82'], road: '#8a949c', roadStyle: 'walkway', bridge: 'walkway',
      mats: { 1: ['puddles', 'grate'], 2: ['moss', 'weeds'], 3: ['railing', 'crate', 'statue'], 4: ['rock', 'ruinwall'] }
    },
    layout: {
      base: [56, 128, 32, 10],
      prey: [[12, 12], [70, 8], [126, 12]],
      sites: [[22, 44, 'Купол оранжереи'], [68, 50, 'Старый сенат'], [114, 42, 'Шлюз акведука'], [30, 92, 'Колокол маяка'], [104, 90, 'Хранилище архивов']],
      exits: [[2, 66, 'Канал контрабандистов'], [136, 80, 'Плавучий док'], [36, 2, 'Северная дамба']]
    },
    ortho: true,
    build(g, T) {
      // вода — каналы сеткой, между ними острова кварталов
      for (let y = 28; y < 124; y += 22) g.rect(0, y, N, 3, (i, j) => g.paint(i, j, T.WATER, 0));
      for (let x = 22; x < 130; x += 24) g.rect(x, 10, 3, 118, (i, j) => g.paint(i, j, T.WATER, 0));
      // затопленные площади
      for (let i = 0; i < 5; i++) g.blob(g.irnd(14, 130), g.irnd(20, 116), g.irnd(30, 80), (x, y) => g.paint(x, y, T.WATER, 0));
      // мостки через каналы
      for (let y = 28; y < 124; y += 22) for (let x = 6; x < N - 6; x += 11) g.rect(x, y - 1, 3, 5, (i, j) => { if (g.t[j * N + i] === T.WATER) g.paint(i, j, T.BRIDGE, 0); });
      for (let x = 22; x < 130; x += 24) for (let y = 14; y < 126; y += 11) g.rect(x - 1, y, 5, 3, (i, j) => { if (g.t[j * N + i] === T.WATER) g.paint(i, j, T.BRIDGE, 0); });
      // дома и купола
      g.place(20, 1200, inner, (x, y) => {
        const w = g.irnd(4, 8), h = g.irnd(4, 7), x0 = Math.round(x), y0 = Math.round(y), cells = [];
        g.rect(x0, y0, w, h, (i, j) => cells.push([i, j]));
        return [cells, { k: 'warehouse', x: x0, y: y0, w: w, h: h, s: g.irnd(0, 3) }];
      }, T.BLOCK, 0, 1);
      g.place(6, 600, inner, (x, y) => { const r = g.rnd(2, 3); return [g.diskCells(x, y, r), { k: 'dome', x: x, y: y, r: r }]; }, T.BLOCK, 0, 1);
      g.place(12, 600, inner, (x, y) => { const r = g.rnd(0.7, 1.1); return [g.diskCells(x, y, r), { k: 'pillar', x: x, y: y, r: r }]; }, T.BLOCK, 1, 1);
      g.scatter(40, T.COVER, 0, { gap: 1, cluster: [1, 3], where: inner });
      g.noiseFill(7, 0.66, (x, y) => { if (g.t[y * N + x] === T.OPEN && !g.res[y * N + x]) g.paint(x, y, T.LIGHT, 0); });
      g.roads({ w: 2, wig: 0.3 });
    }
  },

  // ================================================================ оборона: аванпост «Тессара» (Республика)
  // ---------------------------------------------------------------- Плато Тессара
  tessara: {
    defense: 'r', name: 'Плато Тессара',
    about: 'Аванпост связи на высоком плато: столовые горы, сухие русла и базальтовые иглы. Дроиды поднимаются с трёх сторон — из каньона, по гребню и по старой дороге.',
    look: {
      ground: ['#b08a5a', '#bd9764', '#a37e50'], style: 'sand',
      rough: '#c49a62', light: ['#8a7a4a', '#7a6a3e'], rock: ['#7a5634', '#c79a68'],
      water: ['#3a2e22', '#6a5236'], road: '#d1aa74', roadStyle: 'trail',
      mats: { 1: ['dunes', 'scree'], 2: ['scrub'], 3: ['boulder', 'rockfin'], 4: ['mesa', 'basaltspire'] }
    },
    layout: {
      kind: 'defense', core: [72, 42], plaza: 15, zone: 7, coreKind: 'antenna', coreName: 'Узел связи',
      spawns: [[68, 134, 'Южный каньон'], [2, 98, 'Западный гребень'], [134, 102, 'Старая дорога']]
    },
    build(g, T) {
      for (let i = 0; i < 14; i++) {
        const cx = g.irnd(10, 134), cy = g.irnd(14, 128), r = g.irnd(5, 9);
        if (!far(g, cx, cy, r + 4)) continue;
        g.disk(cx, cy, r, (x, y) => g.paint(x, y, T.BLOCK, 0), 0.35);
        if (g.R() < 0.5) g.objs.push({ k: 'mesa', x: cx, y: cy, r: r });
      }
      for (let i = 0; i < 6; i++) { const x = g.irnd(16, 128), y = g.irnd(24, 120), r = g.irnd(5, 8); if (far(g, x, y, r + 6)) g.plateau(x, y, r, 1, 2, 0.3); }
      g.place(18, 1200, inner, (x, y) => { const r = g.rnd(0.8, 1.6); return [g.diskCells(x, y, r), { k: 'basaltspire', x: x, y: y, r: r }]; }, T.BLOCK, 1, 1);
      for (let i = 0; i < 4; i++) g.stroke(g.walk(g.irnd(10, 134), g.irnd(50, 130), 9, 6, 0.4), 2.2, (x, y) => { if (g.t[y * N + x] === T.OPEN) g.paint(x, y, T.ROUGH, 0); });
      g.scatter(46, T.COVER, 0, { gap: 1, cluster: [1, 3], where: inner });
      g.scatter(22, T.COVER, 1, { gap: 1, where: inner });
      g.noiseFill(8, 0.7, (x, y) => { if (g.t[y * N + x] === T.OPEN && !g.res[y * N + x]) g.paint(x, y, T.LIGHT, 0); });
      g.roads({ w: 3, wig: 0.9 });
    }
  },

  // ---------------------------------------------------------------- Перевал Тессары
  tessara_pass: {
    defense: 'r', name: 'Перевал Тессары', seedSalt: 5,
    about: 'Аванпост на северном краю перевала между двумя хребтами. Снизу к нему поднимаются два ущелья и тропа по дну долины. Узкие проходы держатся малыми силами, но прорыв доходит до базы быстро.',
    look: { highTint: 0.12,
      ground: ['#9a6a48', '#a6744f', '#8c5f40'], style: 'sand',
      rough: '#b07a52', light: ['#6e5a36', '#5e4a2c'], rock: ['#5e3a24', '#a8704a'],
      water: ['#2e2218', '#5a4430'], road: '#c08a5e', roadStyle: 'trail',
      mats: { 1: ['scree', 'dunes'], 2: ['scrub'], 3: ['boulder', 'rockfin'], 4: ['rock', 'basaltspire'] }
    },
    layout: {
      kind: 'defense', core: [72, 40], plaza: 15, zone: 7, coreKind: 'antenna', coreName: 'Узел связи',
      spawns: [[4, 132, 'Западное ущелье'], [68, 134, 'Тропа по долине'], [132, 132, 'Восточное ущелье']]
    },
    build(g, T) {
      // два хребта: запад и восток, между ними седловина с базой
      const nz = g.noise(14, 3);
      for (let y = 4; y < N - 4; y++) for (let x = 4; x < N - 4; x++) {
        const side = Math.min(x, N - 1 - x), k = y * N + x;
        if (g.res[k]) continue;
        if (side < 34 && nz(x, y) > 0.38 + side / 90) g.paint(x, y, T.BLOCK, 0);
      }
      hills(g, 6, 6, 10, true);
      g.place(16, 1000, inner, (x, y) => { const r = g.rnd(0.9, 1.8); return [g.diskCells(x, y, r), { k: 'basaltspire', x: x, y: y, r: r }]; }, T.BLOCK, 1, 1);
      g.scatter(50, T.COVER, 0, { gap: 1, cluster: [1, 3], where: inner });
      g.noiseFill(7, 0.66, (x, y) => { if (g.t[y * N + x] === T.OPEN && !g.res[y * N + x]) g.paint(x, y, T.ROUGH, 0); });
      g.noiseFill(9, 0.72, (x, y) => { if (g.t[y * N + x] === T.OPEN && !g.res[y * N + x]) g.paint(x, y, T.LIGHT, 0); });
      g.roads({ w: 3, wig: 0.7 });
    }
  },

  // ================================================================ оборона: завод «Векс» (КНС)
  // ---------------------------------------------------------------- Завод Векс
  vex: {
    defense: 'c', name: 'Завод Векс', ortho: true,
    about: 'Дроидный завод: цеха, склады и ряды контейнеров вокруг главного реактора. Клоны идут через сортировочную, южные ворота и доки — в узких проходах между цехами.',
    look: {
      ground: ['#4a4a4e', '#55555a', '#404044'], style: 'concrete',
      rough: '#6a6660', light: ['#3f4040', '#4a4a48'], rock: ['#6e6c68', '#9c9890'],
      water: ['#1e1a16', '#3a3028'], road: '#6a6862', roadStyle: 'asphalt', bridge: 'metal',
      mats: { 1: ['debris', 'rubble'], 2: ['weeds', 'crater'], 3: ['container', 'barrier', 'crate'], 4: ['rock', 'wreck'] }
    },
    layout: {
      kind: 'defense', core: [72, 44], plaza: 15, zone: 7, coreKind: 'reactor', coreName: 'Главный реактор', waveK: 0.9,   // в тесных цехах враг подходит вплотную — волны слабее
      spawns: [[2, 120, 'Сортировочная'], [68, 134, 'Южные ворота'], [134, 116, 'Доки']]
    },
    build(g, T) {
      // цеха кварталами
      for (let by = 8; by < 128; by += 18) for (let bx = 4; bx < 136; bx += 18) {
        if (g.R() < 0.15) continue;
        const w = g.irnd(7, 13), h = g.irnd(6, 11), x0 = bx + g.irnd(1, 4), y0 = by + g.irnd(1, 4), cells = [];
        if (!far(g, x0 + w / 2, y0 + h / 2, Math.max(w, h) / 2 + 3)) continue;
        g.rect(x0, y0, w, h, (i, j) => cells.push([i, j]));
        g.stamp(cells, T.BLOCK, 0, { k: g.R() < 0.7 ? 'warehouse' : 'tower', x: x0, y: y0, w: w, h: h, z: g.irnd(1, 4), s: g.irnd(0, 3) }, 1);
      }
      // ряды контейнеров и баррикады
      for (let i = 0; i < 26; i++) g.scatter(1, T.COVER, 0, { gap: 1, cluster: [3, 5], line: g.R() < 0.5 ? [1, 0] : [0, 1], where: inner });
      g.scatter(30, T.COVER, 2, { gap: 1, cluster: [1, 2], where: inner });
      g.noiseFill(6, 0.68, (x, y) => { if (g.t[y * N + x] === T.OPEN && !g.res[y * N + x]) g.paint(x, y, T.ROUGH, 0); });
      g.roads({ w: 3, wig: 0.2 });
    }
  },

  // ---------------------------------------------------------------- Шлаковые поля Векса
  vex_slag: {
    defense: 'c', name: 'Шлаковые поля Векса', seedSalt: 7, night: 1,
    about: 'Литейный цех над полями шлака: озёра расплава, отвалы и трубопроводы. Над полями висит дым — видно недалеко; клоны спускаются с отвалов на севере.',
    look: {
      ground: ['#2e2622', '#382e29', '#26201c'], style: 'basalt',
      rough: '#4a3c34', light: ['#3a2e28', '#4e3020'], rock: ['#1e1814', '#4e423a'],
      void: 'lava', voidc: ['#9a2208', '#ff6a1a', '#ffd25a'], water: ['#3a1a10', '#6a2a10'], road: '#55504c', roadStyle: 'metal', bridge: 'metal',
      mats: { 1: ['ash', 'cinder'], 2: ['cinder'], 3: ['pipe', 'obsidian', 'container'], 4: ['basaltspire', 'rock'], 6: ['lava'] }
    },
    layout: {
      kind: 'defense', core: [72, 100], plaza: 15, zone: 7, coreKind: 'reactor', coreName: 'Литейный цех',
      spawns: [[4, 4, 'Западный отвал'], [68, 2, 'Северная дорога'], [132, 8, 'Восточный отвал']]
    },
    build(g, T) {
      // озёра расплава
      for (let i = 0; i < 9; i++) {
        const cx = g.irnd(12, 132), cy = g.irnd(16, 128), r = g.rnd(2.5, 5);
        if (!far(g, cx, cy, r + 5)) continue;
        g.disk(cx, cy, r, (x, y) => g.paint(x, y, T.VOID, 0), 0.35);
      }
      for (let i = 0; i < 2; i++) g.stroke(g.walk(g.pick([2, 141]), g.irnd(30, 80), 9, 5, 0.4, null), f => 1.8 + 1.4 * Math.sin(f * Math.PI), (x, y) => { if (!g.res[y * N + x]) g.paint(x, y, T.VOID, 0); });
      hills(g, 5, 5, 9, false);
      g.place(18, 1000, inner, (x, y) => { const r = g.rnd(1, 2.2); return [g.diskCells(x, y, r), { k: 'basaltspire', x: x, y: y, r: r }]; }, T.BLOCK, 1, 1);
      // трубопроводы
      for (let i = 0; i < 6; i++) {
        const x0 = g.irnd(6, 126), y0 = g.irnd(14, 128), L = g.irnd(6, 14), hor = g.R() < 0.5;
        for (let k = 0; k < L; k++) { const x = hor ? x0 + k : x0, y = hor ? y0 : y0 + k; if (k % 5 !== 2 && g.okSpot(x, y, 0, {})) g.paint(x, y, T.COVER, 0); }
      }
      g.scatter(50, T.COVER, 1, { gap: 1, cluster: [1, 3], where: inner });
      g.noiseFill(7, 0.6, (x, y) => { if (g.t[y * N + x] === T.OPEN && !g.res[y * N + x]) g.paint(x, y, T.ROUGH, 0); });
      for (let y = 1; y < N - 1; y++) for (let x = 1; x < N - 1; x++) {
        const k = y * N + x;
        if (g.t[k] === T.OPEN && !g.res[k] && (g.t[k + 1] === T.VOID || g.t[k - 1] === T.VOID || g.t[k + N] === T.VOID || g.t[k - N] === T.VOID) && g.R() < 0.35) g.paint(x, y, T.LIGHT, 1);
      }
      g.roads({ w: 3, wig: 0.8 });
    }
  }

};
