#!/usr/bin/env node
// Генератор карт ивентов (выдуманные локации) для наземки 2.0.
//
//   node tools/events/gen.js            — все карты ивентов
//   node tools/events/gen.js sarn       — одна карта
//
// Тот же построитель, что у планет (tools/planets/gen.js), но без города, зон и участков:
// заповедны лагерь охотников, старты добычи, места задач и точки эвакуации. Связность
// проверяется от лагеря охотников до каждой из этих точек (пешком и техникой 2×2).
// Готовые карты — shared/events/maps/<id>.json, список — shared/events/maps/index.json.
'use strict';

const fs = require('fs');
const path = require('path');
const P = require('../../shared/rt-planets.js');
const { Gen } = require('../planets/gen.js');
const MAPS = require('./maps.js');

const T = P.T, N = P.N;
const VERSION = 1;
const OUT = path.join(__dirname, '../../shared/events/maps');
const SITE = 5, EXIT = 6, PREY = 5;

class EventGen extends Gen {
  constructor(id, prof) {
    super('event/' + id, prof);
    this.evId = id;
    this.z = { deploy: [], slots: [] };
    this.town = [-104, -104, 8, 8];
    this.lay = prof.layout;
  }
  reserveAll() {
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
  // «Полоса вторжения» генератора — лагерь охотников: от него проверяется, куда можно дойти
  stripStarts(size) {
    const b = this.lay.base, out = [];
    for (let y = b[1]; y + size <= b[1] + b[3]; y++) for (let x = b[0]; x + size <= b[0] + b[2]; x++) out.push(y * N + x);
    return out;
  }
  targets() {
    const L = this.lay, out = [];
    L.prey.forEach((p, i) => out.push(['старт ' + (i + 1), p[0] + 2, p[1] + 2]));
    L.sites.forEach(s => out.push([s[2], s[0] + 2, s[1] + 2]));
    L.exits.forEach(e => out.push([e[2], e[0] + 2, e[1] + 2]));
    return out;
  }
  // Дороги — сетью, а не веером от лагеря: лагерь — к двум ближним задачам, задачи — цепью
  // по кругу, каждая эвакуация — к ближней задаче. Всё по готовой местности, в обход скал.
  roads(opts) {
    opts = opts || {};
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
  json() {
    const L = this.lay;
    const c = (p, s) => [p[0] + s / 2, p[1] + s / 2];
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
  fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(all.map(id => ({ id: id, name: MAPS[id].name, hunt: MAPS[id].hunt }))));
  return bad;
}

if (require.main === module) {
  const ids = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(MAPS);
  process.exit(run(ids) ? 1 : 0);
}
module.exports = { EventGen, run };
