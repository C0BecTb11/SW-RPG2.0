#!/usr/bin/env node
// Генератор карт ивентов (выдуманные локации) для наземки 2.0.
//
//   node tools/events/gen.js            — все карты ивентов
//   node tools/events/gen.js sarn       — одна карта
//
// Тот же построитель, что у планет (tools/planets/gen.js), но без города, зон и участков:
// заповедны лагерь охотников, старты добычи, места задач и точки эвакуации. Связность
// проверяется от лагеря охотников до каждой из этих точек (пешком и техникой 2×2).
// Оборона (layout.kind = 'defense'): заповедны площадка базы вокруг ядра и точки высадки врага
// у краёв; дороги — от каждой высадки к базе; укрепления (окопы, бункеры, турели) ставятся на
// площадке лицом к высадкам и уходят в карту списком ev.forts — их строит сценарий.
// Готовые карты — shared/events/maps/<id>.json, список — shared/events/maps/index.json.
'use strict';

const fs = require('fs');
const path = require('path');
const P = require('../../shared/rt-planets.js');
const { Gen } = require('../planets/gen.js');
const MAPS = require('./maps.js');

const T = P.T, N = P.N;
const VERSION = 2;
const OUT = path.join(__dirname, '../../shared/events/maps');
const SITE = 5, EXIT = 6, PREY = 5, SPAWN = 8;
// Облик места задачи (рисует ground/terrain.js, OBJ.evsite): по названию места
const KIND = {
  'Алтарь Луны': 'altar', 'Святилище пирамиды': 'altar', 'Обсерватория': 'tower', 'Склеп жрецов': 'crypt', 'Зал голокронов': 'holocron',
  'Буровая №3': 'drill', 'Диспетчерская': 'terminal', 'Склад взрывчатки': 'crates', 'Насосная': 'pump', 'Реактор рудника': 'reactor',
  'Клиника': 'medcrates', 'Ратуша': 'terminal', 'Узел связи': 'antenna', 'Космопорт': 'pod', 'Хранилище данных': 'datacore',
  'Затонувший фрегат': 'wreck', 'Фактория': 'crates', 'Гнездо крикунов': 'nest', 'Маяк на сваях': 'tower', 'Лаборатория': 'reactor',
  'Келья наставника': 'altar', 'Зал медитаций': 'altar', 'Библиотека': 'holocron', 'Колокольня': 'tower', 'Ворота паломников': 'gate',
  'Пещера отшельника': 'crypt', 'Разбитый транспорт': 'wreck', 'Маяк контрабандистов': 'tower', 'Сухой колодец': 'well', 'Каменный мост': 'gate',
  'Спасательная капсула': 'pod', 'Мостик крейсера': 'wreck', 'Склад медикаментов': 'medcrates', 'Бункер связи': 'antenna', 'Эвакопункт': 'medcrates',
  'Купол оранжереи': 'dome', 'Старый сенат': 'gate', 'Шлюз акведука': 'pump', 'Колокол маяка': 'tower', 'Хранилище архивов': 'datacore'
};
// древние места — камень; остальные — металл
const ANCIENT = { altar: 1, crypt: 1, holocron: 1, gate: 1, well: 1, nest: 1 };

class EventGen extends Gen {
  constructor(id, prof) {
    super('event/' + id, prof);
    this.evId = id;
    this.z = { deploy: [], slots: [] };
    this.town = [-104, -104, 8, 8];
    this.lay = prof.layout;
  }
  reserveAll() {
    if (this.lay.kind === 'defense') return this.reserveDefense();
    const L = this.lay, b = L.base;
    // лагерь охотников и его окрестность
    this.reserveBox(b[0] - 3, b[1] - 3, b[2] + 6, b[3] + 6, 3);
    this.reserveBox(b[0], b[1], b[2], b[3], 1);
    L.prey.forEach(p => { this.reserveBox(p[0] - 2, p[1] - 2, PREY + 4, PREY + 4, 3); this.reserveBox(p[0], p[1], PREY, PREY, 1); });
    L.sites.forEach(s => { this.reserveBox(s[0] - 3, s[1] - 3, SITE + 6, SITE + 6, 3); this.reserveBox(s[0], s[1], SITE, SITE, 1); });
    L.exits.forEach(e => { this.reserveBox(e[0] - 2, e[1] - 2, EXIT + 4, EXIT + 4, 3); this.reserveBox(e[0], e[1], EXIT, EXIT, 1); });
    // край карты — ровно
    this.reserveBox(0, 0, N, 1, 3); this.reserveBox(0, N - 1, N, 1, 3);
    this.reserveBox(0, 0, 1, N, 3); this.reserveBox(N - 1, 0, 1, N, 3);
  }
  // Оборона: площадка базы (круг plaza вокруг ядра) — ровная и чистая, высадки — тоже
  reserveDefense() {
    const L = this.lay, c = L.core, R = L.plaza;
    this.reserveBox(c[0] - R - 4, c[1] - R - 4, R * 2 + 8, R * 2 + 8, 3);
    for (let y = c[1] - R; y <= c[1] + R; y++) for (let x = c[0] - R; x <= c[0] + R; x++) {
      if (!this.inb(x, y) || Math.hypot(x + 0.5 - c[0], y + 0.5 - c[1]) > R) continue;
      this.res[y * N + x] = 1;
    }
    L.spawns.forEach(p => { this.reserveBox(p[0] - 3, p[1] - 3, SPAWN + 6, SPAWN + 6, 3); this.reserveBox(p[0], p[1], SPAWN, SPAWN, 1); });
    this.reserveBox(0, 0, N, 1, 3); this.reserveBox(0, N - 1, N, 1, 3);
    this.reserveBox(0, 0, 1, N, 3); this.reserveBox(N - 1, 0, 1, N, 3);
  }
  // «Полоса вторжения» генератора — лагерь охотников (у обороны — площадка базы): от него проверяется, куда можно дойти
  stripStarts(size) {
    if (this.lay.kind === 'defense') {
      const c = this.lay.core, out = [];
      for (let y = c[1] - 4; y <= c[1] + 4 - size; y++) for (let x = c[0] - 8; x <= c[0] - 4; x++) out.push(y * N + x);
      return out;
    }
    const b = this.lay.base, out = [];
    for (let y = b[1]; y + size <= b[1] + b[3]; y++) for (let x = b[0]; x + size <= b[0] + b[2]; x++) out.push(y * N + x);
    return out;
  }
  targets() {
    const L = this.lay, out = [];
    if (L.kind === 'defense') {
      L.spawns.forEach(p => out.push([p[2], p[0] + 4, p[1] + 4]));
      out.push(['база, восток', L.core[0] + 5, L.core[1]], ['база, север', L.core[0], L.core[1] - 5], ['база, юг', L.core[0], L.core[1] + 5]);
      return out;
    }
    L.prey.forEach((p, i) => out.push(['старт ' + (i + 1), p[0] + 2, p[1] + 2]));
    L.sites.forEach(s => out.push([s[2], s[0] + 1, s[1] + 2]));      // середина места занята предметом
    L.exits.forEach(e => out.push([e[2], e[0] + 2, e[1] + 2]));
    return out;
  }
  // Дороги — сетью, а не веером от лагеря: лагерь — к двум ближним задачам, задачи — цепью
  // по кругу, каждая эвакуация — к ближней задаче. Всё по готовой местности, в обход скал.
  roads(opts) {
    opts = opts || {};
    if (this.lay.kind === 'defense') {
      // от каждой высадки — дорога к базе: по ней и пойдут волны
      const L = this.lay, w = opts.w || 3, wig = opts.wig != null ? opts.wig : 0.9;
      // до края площадки (сама площадка заповедна — путь по ней не прокладывается)
      L.spawns.forEach(p => {
        const sx = p[0] + 4, sy = p[1] + 4, dx = sx - L.core[0], dy = sy - L.core[1], l = Math.hypot(dx, dy), r = L.plaza + 1;
        this.corridor(this.route([sx, sy], [Math.round(L.core[0] + dx / l * r), Math.round(L.core[1] + dy / l * r)], { wig: wig }), w, 'main', true);
      });
      return;
    }
    const L = this.lay, b = L.base, w = opts.w || 3, wig = opts.wig != null ? opts.wig : 0.9;
    const base = [b[0] + (b[2] >> 1), b[1] - 1];
    const S = L.sites.map(s => [s[0] + 2, s[1] + 2]), E = L.exits.map(e => [e[0] + 3, e[1] + 3]);
    const d = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
    const go = (p, q, ww, k) => this.corridor(this.route(p, q, { wig: wig }), ww, k, true);
    S.slice().sort((p, q) => d(p, base) - d(q, base)).slice(0, 2).forEach(p => go(base, p, w, 'main'));
    const cx = S.reduce((a, p) => a + p[0], 0) / S.length, cy = S.reduce((a, p) => a + p[1], 0) / S.length;
    const ring = S.slice().sort((p, q) => Math.atan2(p[1] - cy, p[0] - cx) - Math.atan2(q[1] - cy, q[0] - cx));
    for (let i = 0; i < ring.length; i++) { const p = ring[i], q = ring[(i + 1) % ring.length]; if (i === ring.length - 1 && opts.open) break; go(p, q, Math.max(2, w - 1), 'side'); }
    E.forEach(e => { const p = S.slice().sort((a, c) => d(a, e) - d(c, e))[0]; go(p, e, 2, 'side'); });
  }
  // Предметы мест задач и эвакуации: у места задачи середина (1 клетка) — твёрдая, вокруг —
  // площадка, где стоит добыча; эвакуация — площадка без препятствий
  build() {
    super.build();
    const L = this.lay;
    if (L.kind === 'defense') return this.buildDefense();
    L.sites.forEach((s, i) => {
      const kind = KIND[s[2]];
      if (!kind) throw new Error(this.evId + ': нет облика места «' + s[2] + '»');
      const k = (s[1] + 2) * N + s[0] + 2;
      this.res[k] = 0; this.t[k] = T.BLOCK; this.m[k] = 18;
      this.objs.push({ k: 'evsite', s: kind, x: s[0] + SITE / 2, y: s[1] + SITE / 2, r: 3, i: i, old: ANCIENT[kind] ? 1 : 0 });
    });
    L.exits.forEach((e, i) => this.objs.push({ k: 'evexit', x: e[0] + EXIT / 2, y: e[1] + EXIT / 2, r: 3, i: i }));
    return this;
  }
  // Ядро базы (предмет в середине площадки) и укрепления лицом к высадкам. Клетки укреплений
  // проверяются: ровные, проходимые, не на ядре и не друг на друге; бункер — 2×2.
  buildDefense() {
    const L = this.lay, c = L.core, kind = L.coreKind || 'antenna';
    const k0 = c[1] * N + c[0];
    this.res[k0] = 0; this.t[k0] = T.BLOCK; this.m[k0] = 18;
    this.objs.push({ k: 'evsite', s: kind, x: c[0] + 0.5, y: c[1] + 0.5, r: 3, i: 0, old: 0 });
    const used = {}, forts = [];
    const free = (x, y, w, h) => {
      for (let j = y - 1; j <= y + h; j++) for (let i = x - 1; i <= x + w; i++) if (used[j * N + i]) return false;
      for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) {
        if (!this.inb(i, j) || this.t[j * N + i] !== T.OPEN || this.e[j * N + i] !== this.base) return false;
        if (Math.abs(i + 0.5 - c[0]) < 2.5 && Math.abs(j + 0.5 - c[1]) < 2.5) return false;
      }
      return true;
    };
    const put = (kind2, x, y, w, h) => {
      x = Math.round(x); y = Math.round(y);
      for (let r = 0; r < 4; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r || !free(x + dx, y + dy, w, h)) continue;
        for (let j = y + dy; j < y + dy + h; j++) for (let i = x + dx; i < x + dx + w; i++) used[j * N + i] = 1;
        forts.push([kind2, x + dx, y + dy]); return true;
      }
      return false;
    };
    // у каждой высадки — свой рубеж: бункер на подходе, окопы по бокам, турель за ними
    L.spawns.forEach(p => {
      const dx = p[0] + 4 - c[0], dy = p[1] + 4 - c[1], l = Math.hypot(dx, dy), ux = dx / l, uy = dy / l, px = -uy, py = ux, R = L.plaza;
      put('bunker', c[0] + ux * (R - 4) - 1, c[1] + uy * (R - 4) - 1, 2, 2);
      [-1, 1].forEach(s => { for (let q = 0; q < 2; q++) put('trench', c[0] + ux * (R - 3) + px * s * (3 + q), c[1] + uy * (R - 3) + py * s * (3 + q), 1, 1); });
      put('turret', c[0] + ux * (R - 8), c[1] + uy * (R - 8), 1, 1);
    });
    // у ядра — ещё две турели
    put('turret', c[0] - 3, c[1] + 3, 1, 1); put('turret', c[0] + 3, c[1] - 3, 1, 1);
    this.forts = forts;
    return this;
  }
  json() {
    const L = this.lay;
    const c = (p, s) => [p[0] + s / 2, p[1] + s / 2];
    if (L.kind === 'defense') {
      return { id: this.evId, v: VERSION, w: N, h: N, seed: this.seed,
        t: P.pack(this.t), e: P.pack(this.e), m: P.pack(this.m), objs: this.objs, paths: this.paths,
        name: this.prof.name, about: this.prof.about, look: this.prof.look, night: this.prof.night || 0,
        ev: { kind: 'defense', core: [L.core[0] + 0.5, L.core[1] + 0.5, L.coreName], zone: L.zone || 7, plaza: L.plaza, waveK: L.waveK || 1,
              spawns: L.spawns.map(p => [p[0] + SPAWN / 2, p[1] + SPAWN / 2, p[2]]), forts: this.forts || [] } };
    }
    return { id: this.evId, v: VERSION, w: N, h: N, seed: this.seed,
      t: P.pack(this.t), e: P.pack(this.e), m: P.pack(this.m), objs: this.objs, paths: this.paths,
      name: this.prof.name, about: this.prof.about, look: this.prof.look, night: this.prof.night || 0,
      ev: { base: L.base.slice(), prey: L.prey.map(p => c(p, PREY)), sites: L.sites.map(s => { const q = c(s, SITE); return [q[0], q[1], s[2]]; }), exits: L.exits.map(e => { const q = c(e, EXIT); return [q[0], q[1], e[2]]; }) } };
  }
}

function run(ids) {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
  let bad = 0;
  ids.forEach(id => {
    const prof = MAPS[id];
    if (!prof) { console.log(id + ': нет профиля'); bad++; return; }
    const g = new EventGen(id, prof).build();
    const res = g.check(), js = g.json(), txt = JSON.stringify(js);
    const back = P.load(JSON.parse(txt));
    for (let k = 0; k < N * N; k++) if (back.t[k] !== g.t[k] || back.e[k] !== g.e[k] || back.m[k] !== g.m[k]) { res.err.push('упаковка не сходится'); break; }
    fs.writeFileSync(path.join(OUT, id + '.json'), txt);
    const pct = c => Math.round((res.stat[c] || 0) / (N * N) * 1000) / 10;
    console.log((res.err.length ? '✗ ' : '✓ ') + id.padEnd(12) + (txt.length / 1024).toFixed(1).padStart(5) + ' КБ  проход ' +
      (res.walk / (N * N) * 100).toFixed(0) + '%  скалы ' + pct(T.BLOCK) + '%  вода ' + pct(T.WATER) + '%  пропасть ' + pct(T.VOID) +
      '%  укрытия ' + pct(T.COVER) + '%  заросли ' + pct(T.LIGHT) + '%  объектов ' + g.objs.length + (res.err.length ? '\n    ' + res.err.slice(0, 6).join('\n    ') : ''));
    if (res.err.length) bad++;
  });
  const all = Object.keys(MAPS);
  fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(all.map(id => ({ id: id, name: MAPS[id].name, hunt: MAPS[id].hunt, defense: MAPS[id].defense }))));
  return bad;
}

if (require.main === module) {
  const ids = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(MAPS);
  process.exit(run(ids) ? 1 : 0);
}
module.exports = { EventGen, run };
