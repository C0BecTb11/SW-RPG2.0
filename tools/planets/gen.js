#!/usr/bin/env node
// Генератор постоянных карт планет для наземки 2.0.
//
//   node tools/planets/gen.js            — все 20 планет
//   node tools/planets/gen.js kamino     — одна планета
//
// Каждая планета строится из постоянного зерна и своего профиля (profiles.js):
// хребты, реки, пропасти, леса, укрытия. Генератор сам следит, чтобы зоны
// развёртывания, участки построек, полоса вторжения и место под город остались
// ровными и свободными, а из полосы вторжения можно было дойти и доехать до
// города и до зон. Готовые карты — shared/planets/<id>.json; их кладут в
// репозиторий и больше не пересоздают без нужды (иначе планета изменится).
// После правок — прогон войск: node tools/planets/walk.js
'use strict';

const fs = require('fs');
const path = require('path');
const P = require('../../shared/rt-planets.js');
const ZONES = require('./zones.json');
const PROFILES = require('./profiles.js');

const T = P.T, N = P.N;
const VERSION = 1;
const OUT = path.join(__dirname, '../../shared/planets');

// ---------------------------------------------------------------- случайность
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function mulberry32(a) {
  return function() {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
// Плавный шум по решётке (значения в узлах — из зерна), 0..1
function valueNoise(seed) {
  const R = mulberry32(seed), S = 256, v = new Float32Array(S * S);
  for (let i = 0; i < v.length; i++) v[i] = R();
  const at = (x, y) => v[((y & 255) << 8) | (x & 255)];
  const sm = t => t * t * (3 - 2 * t);
  return function(x, y) {
    const xi = Math.floor(x), yi = Math.floor(y), fx = sm(x - xi), fy = sm(y - yi);
    const a = at(xi, yi), b = at(xi + 1, yi), c = at(xi, yi + 1), d = at(xi + 1, yi + 1);
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  };
}

// Очередь с приоритетом для поиска пути
class Heap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(c, v) {
    const a = this.a; a.push([c, v]); let i = a.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (a[p][0] <= a[i][0]) break; [a[p], a[i]] = [a[i], a[p]]; i = p; }
  }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last; let i = 0;
      for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < a.length && a[l][0] < a[m][0]) m = l; if (r < a.length && a[r][0] < a[m][0]) m = r; if (m === i) break; [a[m], a[i]] = [a[i], a[m]]; i = m; }
    }
    return top;
  }
}

// ---------------------------------------------------------------- построитель
// res: 0 — свободно; 1 — заповедно (зоны, участки, полоса, город): только ровная земля;
// 2 — проход (дорога): без преград, вода и пропасть становятся мостом;
// 3 — обжитое (вокруг участков, зон и города): ровно, без скал, воды и пропастей,
//     можно мелкие укрытия, заросли, трудную землю.
class Gen {
  constructor(id, prof) {
    this.id = id; this.prof = prof;
    this.seed = hashStr('sw-ground/' + id + '/' + (prof.seedSalt || 0));
    this.R = mulberry32(this.seed);
    this.t = new Uint8Array(N * N); this.e = new Uint8Array(N * N); this.m = new Uint8Array(N * N);
    this.res = new Uint8Array(N * N); this.objMask = new Uint8Array(N * N); this.set3 = new Uint8Array(N * N);
    this.objs = []; this.paths = []; this.salt = 1;
    this.base = prof.base || 0;
    this.e.fill(this.base);
    this.z = ZONES[id];
    this.town = P.GEO.town;
    this.w = N; this.h = N;
  }
  rnd(a, b) { return a + (b - a) * this.R(); }
  irnd(a, b) { return Math.floor(this.rnd(a, b + 1)); }
  pick(arr) { return arr[Math.floor(this.R() * arr.length)]; }
  noise(scale, oct, salt) {
    const n = valueNoise(this.seed ^ hashStr('n' + (salt != null ? salt : this.salt++)));
    oct = oct || 3;
    return (x, y) => {
      let s = 0, a = 1, f = 1 / scale, tot = 0;
      for (let o = 0; o < oct; o++) { s += n(x * f + o * 17.3, y * f + o * 31.7) * a; tot += a; a *= 0.5; f *= 2; }
      return s / tot;
    };
  }
  inb(x, y) { return x >= 0 && y >= 0 && x < N && y < N; }
  i(x, y) { return y * N + x; }
  get(x, y) { return this.inb(x, y) ? this.t[y * N + x] : T.BLOCK; }

  // ---- заповедные места
  reserveBox(x, y, w, h, kind) {
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) {
      if (!this.inb(i, j)) continue;
      const k = j * N + i;
      if (kind === 3) this.set3[k] = 1;
      if (kind === 1 || this.res[k] === 0 || (kind === 2 && this.res[k] === 3)) this.res[k] = kind;
    }
  }
  reserveAll() {
    const z = this.z, tw = this.town;
    // обжитое вокруг зон и участков (3 клетки), сами зоны и участки +1 — заповедно
    z.deploy.forEach(d => this.reserveBox(d[0] - 3, d[1] - 3, d[2] + 6, d[2] + 6, 3));
    z.slots.forEach(s => this.reserveBox(s[0] - 3, s[1] - 3, P.GEO.plot + 6, P.GEO.plot + 6, 3));
    this.reserveBox(tw[0] - 4, tw[1] - 4, tw[2] + 8, tw[3] + 8, 3);
    this.reserveBox(0, N - P.GEO.strip - 6, N, 6, 3);
    z.deploy.forEach(d => this.reserveBox(d[0] - 1, d[1] - 1, d[2] + 2, d[2] + 2, 1));
    z.slots.forEach(s => this.reserveBox(s[0] - 1, s[1] - 1, P.GEO.plot + 2, P.GEO.plot + 2, 1));
    this.reserveBox(tw[0], tw[1], tw[2], tw[3], 1);
    this.reserveBox(0, N - P.GEO.strip - 1, N, P.GEO.strip + 1, 1);
    this.reserveBox(0, 0, N, 1, 3);
  }
  // Проход: ломаная с лёгким изгибом, ширина w; отмечается как res=2 и запоминается для дорог
  corridor(pts, w, kind, routed) {
    if (this.prof.ortho && !routed) {
      // только прямые участки (платформы, кварталы): ломаная → ступени по осям
      pts = [pts[0], pts[pts.length - 1]];
      const q = [pts[0]];
      for (let i = 1; i < pts.length; i++) { const a = q[q.length - 1], b = pts[i]; if (a[0] !== b[0] && a[1] !== b[1]) q.push([b[0], a[1]]); q.push(b); }
      pts = q.map(p => [Math.round(p[0]), Math.round(p[1])]);
    }
    const out = [];
    for (let s = 0; s + 1 < pts.length; s++) {
      const a = pts[s], b = pts[s + 1], L = Math.max(1, Math.hypot(b[0] - a[0], b[1] - a[1]));
      for (let k = 0; k <= L; k += 0.5) out.push([a[0] + (b[0] - a[0]) * k / L, a[1] + (b[1] - a[1]) * k / L]);
    }
    const r = (w - 1) / 2;
    out.forEach(p => this.reserveBox(Math.round(p[0] - r), Math.round(p[1] - r), w, w, 2));
    const keep = routed ? pts.filter((p, i) => i % 3 === 0 || i === pts.length - 1) : pts;
    this.paths.push({ k: kind || 'road', w: w, pts: keep.map(p => [Math.round(p[0] * 2) / 2, Math.round(p[1] * 2) / 2]) });
  }
  // Дорога в обход заповедного (участков, зон, города): поиск пути по клеткам.
  // Повороты дороже — дорога прямее; шум — лёгкие изгибы; у заповедного — с отступом.
  route(a, b, opts) {
    opts = opts || {};
    const ortho = !!this.prof.ortho, D = ortho ? 4 : 8, turn = opts.turn != null ? opts.turn : ortho ? 8 : 1.2, wig = opts.wig != null ? opts.wig : 0.8;
    const DX = [1, -1, 0, 0, 1, 1, -1, -1], DY = [0, 0, 1, -1, 1, -1, 1, -1];
    const nzf = this.noise(9, 2);
    const ax = Math.round(a[0]), ay = Math.round(a[1]), bx = Math.round(b[0]), by = Math.round(b[1]);
    const near = (x, y, px, py) => Math.abs(x - px) <= 3 && Math.abs(y - py) <= 3;
    const cellCost = new Float32Array(N * N);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const k = y * N + x;
      if (near(x, y, ax, ay) || near(x, y, bx, by)) { cellCost[k] = 0; continue; }
      if (this.res[k] === 1 || this.objMask[k]) { cellCost[k] = Infinity; continue; }
      let c = nzf(x, y) * wig * 2;
      // местность: дорога обходит скалы, коротко пересекает воду и пропасти
      const tc = this.t[k];
      if (tc === T.WATER) c += this.prof.ford ? 3 : 7;
      else if (tc === T.VOID) c += 8;
      else if (tc === T.BLOCK) c += 9;
      else if (tc === T.COVER || tc === T.TRAP) c += 1.5;
      for (let d = 0; d < 4; d++) { const nx = x + [1, -1, 0, 0][d], ny = y + [0, 0, 1, -1][d]; if (this.inb(nx, ny) && this.e[ny * N + nx] !== this.e[k]) { c += 2; break; } }
      for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) if (this.inb(x + i, y + j) && this.res[(y + j) * N + x + i] === 1) c += 3;
      cellCost[k] = c;
    }
    const S = N * N * D, cost = new Float64Array(S).fill(Infinity), prev = new Int32Array(S).fill(-1), h = new Heap();
    for (let d = 0; d < D; d++) { const st = (ay * N + ax) * D + d; cost[st] = 0; h.push(0, st); }
    let goal = -1;
    while (h.size) {
      const [c, st] = h.pop();
      if (c > cost[st]) continue;
      const k = (st / D) | 0, d = st % D, x = k % N, y = (k / N) | 0;
      if (x === bx && y === by) { goal = st; break; }
      for (let e = 0; e < D; e++) {
        const nx = x + DX[e], ny = y + DY[e];
        if (!this.inb(nx, ny)) continue;
        const nk = ny * N + nx, cc = cellCost[nk];
        if (cc === Infinity) continue;
        const nc = c + (e >= 4 ? 1.414 : 1) + (e !== d ? turn : 0) + cc, ns = nk * D + e;
        if (nc < cost[ns]) { cost[ns] = nc; prev[ns] = st; h.push(nc, ns); }
      }
    }
    if (goal < 0) return this.meander(a, b, 0);
    const pts = [];
    for (let st = goal; st >= 0; st = prev[st]) { const k = (st / D) | 0; pts.push([k % N, (k / N) | 0]); }
    return pts.reverse();
  }
  // Извилистая линия между точками (для дорог и рек): промежуточные точки сдвигаются шумом
  meander(a, b, amp, step) {
    const pts = [a], L = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.max(1, Math.round(L / (step || 12)));
    const nx = -(b[1] - a[1]) / L, ny = (b[0] - a[0]) / L;
    for (let k = 1; k < n; k++) {
      const f = k / n, off = (this.R() * 2 - 1) * amp * Math.sin(Math.PI * f);
      pts.push([a[0] + (b[0] - a[0]) * f + nx * off, a[1] + (b[1] - a[1]) * f + ny * off]);
    }
    pts.push(b);
    return pts;
  }
  // Главные дороги: от полосы вторжения к южным воротам города, от северных ворот — к зонам
  mainRoads(opts) {
    opts = opts || {};
    const tw = this.town, cx = Math.round(tw[0] + tw[2] / 2 - 0.5), w = opts.w || 3, amp = opts.amp != null ? opts.amp : 6;
    const wig = amp * 0.14;
    const sx = opts.stripX != null ? opts.stripX : cx;
    this.corridor(this.route([sx, N - 3], [cx, tw[1] + tw[3] + 1], { wig: wig }), w, 'main', true);
    this.z.deploy.forEach(d => {
      const zx = d[0] + d[2] / 2 - 0.5, zy = d[1] + d[2] + 1;
      this.corridor(this.route([cx, tw[1] - 2], [zx, zy], { wig: wig }), w, 'main', true);
    });
    if (opts.sides !== false) {
      // боковые: от западных и восточных ворот к краям, потом вниз к полосе (обходы)
      const cy = Math.round(tw[1] + tw[3] / 2 - 0.5);
      [[tw[0] - 2, this.irnd(14, 26)], [tw[0] + tw[2] + 1, this.irnd(118, 130)]].forEach(sd => {
        const gx = sd[0], ex = sd[1], my = cy + this.irnd(-8, 8);
        const p1 = this.route([gx, cy], [ex, my], { wig: wig }), p2 = this.route([ex, my], [ex + this.irnd(-6, 6), N - 3], { wig: wig });
        this.corridor(p1.concat(p2.slice(1)), opts.sideW || 2, 'side', true);
      });
    }
  }

  // ---- рисование местности (с учётом заповедного)
  paint(x, y, code, mat, force) {
    if (!this.inb(x, y)) return false;
    const k = y * N + x, r = this.res[k];
    if (!force && r) {
      if (r === 1) return false;
      if (code === T.BLOCK || code === T.VOID || code === T.WATER || code === T.TRAP) {
        if (r === 3 || this.set3[k]) return false;
        if (code === T.BLOCK || code === T.TRAP) return false;
        code = code === T.WATER && this.prof.ford ? T.FORD : T.BRIDGE; mat = 0;
      }
      if (code === T.COVER && r === 2) return false;
    }
    this.t[k] = code; this.m[k] = mat || 0;
    return true;
  }
  height(x, y, h, force) {
    if (!this.inb(x, y)) return;
    const k = y * N + x;
    if (!force && (this.res[k] === 1 || this.res[k] === 3)) return;
    this.e[k] = h;
  }
  // Круг с рваным краем
  disk(cx, cy, r, fn, jag) {
    const nz = jag ? this.noise(Math.max(3, r * 0.8), 2) : null;
    const R2 = Math.ceil(r + (jag || 0) * r + 1);
    for (let y = Math.floor(cy - R2); y <= cy + R2; y++) for (let x = Math.floor(cx - R2); x <= cx + R2; x++) {
      if (!this.inb(x, y)) continue;
      let d = Math.hypot(x - cx, y - cy);
      const rr = r * (1 + (nz ? (nz(x, y) - 0.5) * 2 * jag : 0));
      if (d <= rr) fn(x, y, d / Math.max(0.01, rr));
    }
  }
  // Толстая ломаная (хребет, река, пропасть); ширина может зависеть от доли пути
  stroke(pts, width, fn) {
    const wf = typeof width === 'function' ? width : () => width;
    let total = 0;
    for (let s = 0; s + 1 < pts.length; s++) total += Math.hypot(pts[s + 1][0] - pts[s][0], pts[s + 1][1] - pts[s][1]);
    let acc = 0;
    const seen = new Set();
    for (let s = 0; s + 1 < pts.length; s++) {
      const a = pts[s], b = pts[s + 1], L = Math.max(0.01, Math.hypot(b[0] - a[0], b[1] - a[1]));
      for (let k = 0; k <= L; k += 0.4) {
        const x = a[0] + (b[0] - a[0]) * k / L, y = a[1] + (b[1] - a[1]) * k / L, w = wf((acc + k) / total) / 2;
        for (let yy = Math.floor(y - w); yy <= Math.ceil(y + w); yy++) for (let xx = Math.floor(x - w); xx <= Math.ceil(x + w); xx++) {
          if (!this.inb(xx, yy) || Math.hypot(xx - x, yy - y) > w + 0.15) continue;
          const key = yy * N + xx; if (seen.has(key)) continue; seen.add(key);
          fn(xx, yy, Math.hypot(xx - x, yy - y) / Math.max(0.5, w));
        }
      }
      acc += L;
    }
  }
  // Случайное блуждание: точки ломаной
  walk(x, y, steps, len, turn, dir) {
    const pts = [[x, y]];
    let a = dir != null ? dir : this.R() * Math.PI * 2;
    for (let k = 0; k < steps; k++) {
      a += (this.R() * 2 - 1) * turn;
      x += Math.cos(a) * len; y += Math.sin(a) * len;
      pts.push([x, y]);
    }
    return pts;
  }
  // Пятно, растущее от точки
  blob(cx, cy, size, fn) {
    const seen = new Set([cy * N + cx]), front = [[cx, cy]], cells = [];
    while (front.length && cells.length < size) {
      const j = Math.floor(this.R() * front.length), p = front[j];
      front[j] = front[front.length - 1]; front.pop();
      cells.push(p);
      for (let d = 0; d < 4; d++) {
        const x = p[0] + [1, -1, 0, 0][d], y = p[1] + [0, 0, 1, -1][d];
        if (!this.inb(x, y) || seen.has(y * N + x)) continue;
        seen.add(y * N + x); front.push([x, y]);
      }
    }
    cells.forEach(p => fn(p[0], p[1]));
    return cells;
  }
  // Где шум выше порога
  noiseFill(scale, thr, fn, oct, mask) {
    const nz = this.noise(scale, oct || 3);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const v = nz(x, y);
      if (v > thr && (!mask || mask(x, y))) fn(x, y, (v - thr) / (1 - thr));
    }
  }
  rect(x, y, w, h, fn) { for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) if (this.inb(i, j)) fn(i, j); }
  // Годится ли клетка под мелкий предмет: не заповедно, не проход, нужного типа и вокруг (gap) пусто
  okSpot(x, y, gap, opts) {
    if (!this.inb(x, y)) return false;
    const k = y * N + x, r = this.res[k];
    if (r === 1 || r === 2 || (r === 3 && !opts.settled)) return false;
    if ((opts.on || [T.OPEN, T.ROUGH, T.LIGHT]).indexOf(this.t[k]) < 0) return false;
    for (let j = y - gap; j <= y + gap; j++) for (let i = x - gap; i <= x + gap; i++) {
      if (!this.inb(i, j)) continue;
      const c = this.t[j * N + i];
      if (c === T.COVER || c === T.BLOCK || c === T.TRAP || c === T.BRIDGE || c === T.RAMP) return false;
    }
    return true;
  }
  // Россыпь мелких укрытий: count групп по cluster[0..1] клеток, группы не ближе gap к чему-то твёрдому
  scatter(count, code, mat, opts) {
    opts = opts || {};
    const gap = opts.gap != null ? opts.gap : 1, cl = opts.cluster || [1, 1];
    let placed = 0, tries = 0;
    while (placed < count && tries++ < count * 80) {
      const x = this.irnd(1, N - 2), y = this.irnd(1, N - 2);
      if (opts.where && !opts.where(x, y)) continue;
      if (!this.okSpot(x, y, gap, opts)) continue;
      const n = this.irnd(cl[0], cl[1]), m = typeof mat === 'function' ? mat() : mat;
      let cx = x, cy = y;
      for (let k = 0; k < n; k++) {
        if (k === 0 || this.okSpot(cx, cy, 0, opts)) this.paint(cx, cy, code, m);
        if (opts.line) { cx += opts.line[0]; cy += opts.line[1]; }
        else if (this.R() < 0.5) cx += this.R() < 0.5 ? 1 : -1; else cy += this.R() < 0.5 ? 1 : -1;
      }
      placed++;
    }
    return placed;
  }
  // Клетки многоугольника (точки в клетках; клетка внутри, если внутри её центр)
  poly(pts) {
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    pts.forEach(p => { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); });
    const out = [];
    for (let y = Math.floor(y0); y <= Math.ceil(y1); y++) for (let x = Math.floor(x0); x <= Math.ceil(x1); x++) {
      const px = x + 0.5, py = y + 0.5;
      let ins = false;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const a = pts[i], b = pts[j];
        if ((a[1] > py) !== (b[1] > py) && px < (b[0] - a[0]) * (py - a[1]) / (b[1] - a[1]) + a[0]) ins = !ins;
      }
      if (ins && this.inb(x, y)) out.push([x, y]);
    }
    return out;
  }
  rotRect(cx, cy, w, h, a) {
    const c = Math.cos(a), s = Math.sin(a), hw = w / 2, hh = h / 2;
    return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(p => [cx + p[0] * c - p[1] * s, cy + p[0] * s + p[1] * c]);
  }
  diskCells(cx, cy, r) {
    const out = [];
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++)
      if (this.inb(x, y) && Math.hypot(x + 0.5 - cx, y + 0.5 - cy) <= r) out.push([x, y]);
    return out;
  }
  // Свободно ли место под крупный предмет: всё вне заповедного и проходов (с запасом pad) и без воды, пропасти, скал
  areaFree(cells, pad, codes) {
    pad = pad || 0;
    codes = codes || [T.OPEN, T.ROUGH, T.LIGHT];
    for (const p of cells) {
      for (let j = -pad; j <= pad; j++) for (let i = -pad; i <= pad; i++) {
        const x = p[0] + i, y = p[1] + j;
        if (!this.inb(x, y)) return false;
        const k = y * N + x;
        if (this.res[k]) return false;
        if (i === 0 && j === 0 && codes.indexOf(this.t[k]) < 0) return false;
        if (this.t[k] === T.BLOCK && (i || j)) return false;
      }
    }
    return true;
  }
  // Крупный предмет: если место свободно — клетки становятся code, предмет идёт в список для отрисовки
  stamp(cells, code, mat, o, pad, codes) {
    if (!cells.length || !this.areaFree(cells, pad, codes)) return false;
    const e0 = this.e[cells[0][1] * N + cells[0][0]];
    for (const p of cells) if (this.e[p[1] * N + p[0]] !== e0) return false;
    cells.forEach(p => { this.paint(p[0], p[1], code, mat); if (code === T.BLOCK) this.objMask[p[1] * N + p[0]] = 1; });
    if (o) this.objs.push(o);
    return true;
  }
  // Попробовать n раз поставить крупный предмет в случайное место (gen(x, y) → [клетки, предмет])
  place(n, tries, where, gen, code, mat, pad, codes) {
    let ok = 0;
    for (let t = 0; t < tries && ok < n; t++) {
      const x = this.rnd(3, N - 3), y = this.rnd(3, N - 3);
      if (where && !where(x, y)) continue;
      const g = gen(x, y);
      if (this.stamp(g[0], code, typeof mat === 'function' ? mat() : mat, g[1], pad, codes)) ok++;
    }
    return ok;
  }
  obj(o) { this.objs.push(o); return o; }
  // Плато заданной высоты (рваный круг) и склоны на нём
  plateau(cx, cy, r, h, ramps, jag) {
    const cells = [];
    this.disk(cx, cy, r, (x, y) => { if (this.res[y * N + x] !== 1 && this.res[y * N + x] !== 3) { this.e[y * N + x] = Math.max(this.e[y * N + x], h); cells.push([x, y]); } }, jag != null ? jag : 0.3);
    this.rampsAround(cells, h, ramps || 2);
    return cells;
  }
  // Склоны: на краю возвышенности (снаружи, на нижней высоте) — ширина 3
  rampsAround(cells, h, count) {
    const edge = [];
    cells.forEach(p => {
      for (let d = 0; d < 4; d++) {
        const x = p[0] + [1, -1, 0, 0][d], y = p[1] + [0, 0, 1, -1][d];
        if (this.inb(x, y) && this.e[y * N + x] === h - 1 && this.t[y * N + x] !== T.WATER && this.t[y * N + x] !== T.VOID) edge.push([x, y, d]);
      }
    });
    for (let k = 0; k < count && edge.length; k++) {
      const p = edge[Math.floor(this.R() * edge.length)];
      const along = p[2] < 2 ? [0, 1] : [1, 0];
      for (let s = -1; s <= 1; s++) {
        const x = p[0] + along[0] * s, y = p[1] + along[1] * s;
        if (this.inb(x, y) && this.e[y * N + x] === h - 1) { this.t[y * N + x] = T.RAMP; this.m[y * N + x] = 0; }
      }
    }
  }

  // ---------------------------------------------------------------- доводка
  // Заповедное — ровная открытая земля на базовой высоте; проходы — без преград
  enforce() {
    for (let k = 0; k < N * N; k++) {
      const r = this.res[k];
      if (r === 1) { this.t[k] = T.OPEN; this.m[k] = 0; this.e[k] = this.base; }
      else if (r === 3) {
        this.e[k] = this.base;
        if (this.t[k] === T.BLOCK || this.t[k] === T.WATER || this.t[k] === T.VOID || this.t[k] === T.TRAP || this.t[k] === T.BRIDGE) { this.t[k] = T.OPEN; this.m[k] = 0; }
      } else if (r === 2) {
        const c = this.t[k];
        if (c === T.BLOCK || c === T.COVER || c === T.TRAP) { this.t[k] = T.OPEN; this.m[k] = 0; }
        else if ((c === T.WATER || c === T.VOID || c === T.BRIDGE) && this.set3[k]) { this.t[k] = T.OPEN; this.m[k] = 0; this.e[k] = this.base; }
        else if (c === T.WATER) { this.t[k] = this.prof.ford ? T.FORD : T.BRIDGE; this.m[k] = 0; }
        else if (c === T.VOID) { this.t[k] = T.BRIDGE; this.m[k] = 0; }
        if ((this.t[k] === T.OPEN || this.t[k] === T.ROUGH || this.t[k] === T.LIGHT) && this.prof.road !== false) { this.t[k] = T.ROAD; this.m[k] = 0; }
      }
    }
    // проходы через перепад высот — склоны на нижней клетке
    for (let pass = 0; pass < 3; pass++) {
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        const k = y * N + x;
        if (this.res[k] !== 2) continue;
        for (let d = 0; d < 4; d++) {
          const nx = x + [1, -1, 0, 0][d], ny = y + [0, 0, 1, -1][d];
          if (!this.inb(nx, ny)) continue;
          const nk = ny * N + nx, dh = this.e[nk] - this.e[k];
          if (Math.abs(dh) > 1) { this.e[dh > 0 ? nk : k] = this.e[dh > 0 ? k : nk] + 1; }
          if (Math.abs(this.e[nk] - this.e[k]) === 1 && (this.res[nk] === 2 || this.res[nk] === 3 || this.res[nk] === 1)) {
            const lo = this.e[nk] < this.e[k] ? nk : k;
            if (this.res[lo] !== 1) { this.t[lo] = T.RAMP; this.m[lo] = 0; }
          }
        }
      }
    }
  }
  // Высота меняется не больше чем на 1 между соседями (иначе — отвесная стена; её делаем скалой)
  cliffs() {
    // у ровных мест (заповедное, обжитое) соседняя высота — не больше чем на 1 выше: уступ, а не стена
    for (let pass = 0; pass < 4; pass++) {
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        const k = y * N + x;
        if (this.res[k] === 1 || this.res[k] === 3) continue;
        for (let d = 0; d < 4; d++) {
          const nx = x + [1, -1, 0, 0][d], ny = y + [0, 0, 1, -1][d];
          if (!this.inb(nx, ny)) continue;
          const nk = ny * N + nx;
          if ((this.res[nk] === 1 || this.res[nk] === 3 || pass > 0) && this.e[k] > this.e[nk] + 1 && (this.res[nk] === 1 || this.res[nk] === 3)) this.e[k] = this.e[nk] + 1;
        }
      }
    }
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const k = y * N + x;
      for (let d = 0; d < 4; d++) {
        const nx = x + [1, -1, 0, 0][d], ny = y + [0, 0, 1, -1][d];
        if (!this.inb(nx, ny)) continue;
        const nk = ny * N + nx;
        if (this.e[nk] - this.e[k] > 1 && !this.res[k]) { this.t[k] = T.BLOCK; this.m[k] = 0; }
      }
    }
  }
  // Поиск пути с учётом преград: из множества стартов к цели; цена — сколько придётся «прорубить»
  carve(starts, goal, mv, width) {
    const cost = new Float64Array(N * N).fill(1e9), prev = new Int32Array(N * N).fill(-1);
    const heap = [];
    const push = (k, c) => { heap.push([c, k]); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
    const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
    starts.forEach(k => { cost[k] = 0; push(k, 0); });
    const gk = goal[1] * N + goal[0];
    while (heap.length) {
      const [c, k] = pop();
      if (c > cost[k]) continue;
      if (k === gk) break;
      const x = k % N, y = (k / N) | 0;
      for (let d = 0; d < 4; d++) {
        const nx = x + [1, -1, 0, 0][d], ny = y + [0, 0, 1, -1][d];
        if (!this.inb(nx, ny)) continue;
        const nk = ny * N + nx;
        let step = P.canStep(this, x, y, nx, ny, mv) ? 1 : 12;
        if (this.res[nk] === 1 && nk !== gk) step += 4;
        if (c + step < cost[nk]) { cost[nk] = c + step; prev[nk] = k; push(nk, c + step); }
      }
    }
    if (cost[gk] >= 1e9) return false;
    let k = gk, cut = 0;
    const path = [];
    while (k >= 0) { path.push(k); k = prev[k]; }
    path.reverse();
    for (let s = 0; s < path.length; s++) {
      const x = path[s] % N, y = (path[s] / N) | 0;
      for (let j = 0; j < width; j++) for (let i = 0; i < width; i++) {
        const xx = x + i, yy = y + j;
        if (!this.inb(xx, yy)) continue;
        const kk = yy * N + xx, c = this.t[kk];
        if (c === T.BLOCK || c === T.COVER || c === T.TRAP) { this.t[kk] = T.ROUGH; this.m[kk] = 0; cut++; }
        else if (c === T.WATER && mv !== 'hover') { this.t[kk] = this.prof.ford ? T.FORD : T.BRIDGE; this.m[kk] = 0; cut++; }
        else if (c === T.VOID) { this.t[kk] = T.BRIDGE; this.m[kk] = 0; cut++; }
      }
      if (s > 0) {
        const pk = path[s - 1], px = pk % N, py = (pk / N) | 0;
        const dh = this.e[path[s]] - this.e[pk];
        if (dh !== 0) {
          const lo = dh > 0 ? [px, py] : [x, y], hi = dh > 0 ? [x, y] : [px, py];
          const loH = this.e[lo[1] * N + lo[0]];
          if (Math.abs(dh) > 1) this.e[hi[1] * N + hi[0]] = loH + 1;
          // склон шириной width поперёк хода
          for (let w = 0; w < width; w++) {
            const xx = lo[0] + (px === x ? w : 0), yy = lo[1] + (py === y ? w : 0);
            if (this.inb(xx, yy) && this.res[yy * N + xx] !== 1) {
              const kk = yy * N + xx;
              if (this.t[kk] !== T.BRIDGE) { this.t[kk] = T.RAMP; this.m[kk] = 0; }
              this.e[kk] = loH;
              const hx = xx + (hi[0] - lo[0]), hy = yy + (hi[1] - lo[1]);
              if (this.inb(hx, hy) && this.res[hy * N + hx] !== 1) this.e[hy * N + hx] = loH + 1;
            }
          }
        }
      }
    }
    return cut;
  }
  // Кто откуда достижим (пешком — по клеткам; машиной 2×2 — по левому верхнему углу)
  reach(starts, mv, size) {
    const seen = new Uint8Array(N * N), q = [];
    starts.forEach(k => { if (!seen[k]) { seen[k] = 1; q.push(k); } });
    while (q.length) {
      const k = q.pop(), x = k % N, y = (k / N) | 0;
      for (let d = 0; d < 8; d++) {
        const dx = [1, -1, 0, 0, 1, 1, -1, -1][d], dy = [0, 0, 1, -1, 1, -1, 1, -1][d];
        const nx = x + dx, ny = y + dy;
        if (!this.inb(nx, ny) || seen[ny * N + nx]) continue;
        if (size > 1) {
          if (d >= 4) continue;
          if (nx + size > N || ny + size > N || !P.canBox(this, nx, ny, size, mv)) continue;
          let ok = true;
          for (let s = 0; s < size && ok; s++) {
            const ax = dx ? (dx > 0 ? x + size - 1 : x) : x + s, ay = dy ? (dy > 0 ? y + size - 1 : y) : y + s;
            const bx = ax + dx, by = ay + dy;
            if (!P.canStep(this, ax, ay, bx, by, mv)) ok = false;
          }
          if (!ok) continue;
        } else if (!P.canStep(this, x, y, nx, ny, mv)) continue;
        seen[ny * N + nx] = 1; q.push(ny * N + nx);
      }
    }
    return seen;
  }
  stripStarts(size) {
    const out = [], y = N - P.GEO.strip;
    for (let x = 0; x + size <= N; x++) out.push(y * N + x);
    return out;
  }
  targets() {
    const tw = this.town, cx = tw[0] + (tw[2] >> 1) - 1, out = [];
    out.push(['город, юг', cx, tw[1] + tw[3]], ['город, север', cx, tw[1] - 2],
             ['город, запад', tw[0] - 2, tw[1] + (tw[3] >> 1)], ['город, восток', tw[0] + tw[2], tw[1] + (tw[3] >> 1)]);
    this.z.deploy.forEach((d, i) => out.push(['зона ' + (i + 1), d[0] + 2, d[1] + 2]));
    return out;
  }
  // Связность: пешком — до всех целей и до каждого участка; машиной 2×2 — до города и зон.
  // Чего не хватает — прорубается. Отрезанные от всего карманы заливаются тем, что вокруг.
  connect() {
    let cut = 0;
    for (let round = 0; round < 4; round++) {
      let changed = false;
      const foot = this.reach(this.stripStarts(1), 'foot', 1);
      for (const tg of this.targets()) {
        const k = tg[2] * N + tg[1];
        if (!foot[k]) { const c = this.carve(this.stripStarts(1).filter(s => foot[s]), [tg[1], tg[2]], 'foot', 3); if (c !== false) { cut += c; changed = true; } }
      }
      // каждый участок: хоть одна соседняя клетка достижима
      const foot2 = changed ? this.reach(this.stripStarts(1), 'foot', 1) : foot;
      for (const s of this.z.slots) {
        let ok = false;
        for (let i = -1; i <= 6 && !ok; i++) for (const j of [-1, 6]) { if (this.inb(s[0] + i, s[1] + j) && foot2[(s[1] + j) * N + s[0] + i]) ok = true; }
        for (let j = -1; j <= 6 && !ok; j++) for (const i of [-1, 6]) { if (this.inb(s[0] + i, s[1] + j) && foot2[(s[1] + j) * N + s[0] + i]) ok = true; }
        if (!ok) { const reachable = []; for (let k = 0; k < N * N; k++) if (foot2[k]) reachable.push(k); const c = this.carve(reachable, [s[0] + 2, s[1] - 1], 'foot', 2); if (c !== false) { cut += c; changed = true; } }
      }
      const veh = this.reach(this.stripStarts(2), 'track', 2);
      for (const tg of this.targets()) {
        const k = tg[2] * N + tg[1];
        if (!veh[k] && !veh[k - 1] && !veh[k - N]) {
          const starts = this.stripStarts(2).filter(s => veh[s]);
          const c = this.carve(starts.length ? starts : this.stripStarts(2), [tg[1], tg[2]], 'track', 3);
          if (c !== false) { cut += c; changed = true; }
        }
      }
      if (!changed) break;
    }
    this.fillPockets();
    return cut;
  }
  // Отрезанные места: крупные — соединяются (склон, мост, проход), мелкие — заливаются тем, что вокруг
  fillPockets() {
    let filled = 0;
    for (let round = 0; round < 40; round++) {
      const foot = this.reach(this.stripStarts(1), 'foot', 1);
      const comp = new Int32Array(N * N).fill(-1), comps = [];
      for (let k = 0; k < N * N; k++) {
        if (foot[k] || comp[k] >= 0 || this.res[k] === 1 || !P.canStand(this, k % N, (k / N) | 0, 'foot')) continue;
        const id = comps.length, cells = [k]; comp[k] = id;
        for (let q = 0; q < cells.length; q++) {
          const c = cells[q], x = c % N, y = (c / N) | 0;
          for (let d = 0; d < 8; d++) {
            const nx = x + [1, -1, 0, 0, 1, 1, -1, -1][d], ny = y + [0, 0, 1, -1, 1, -1, 1, -1][d];
            if (!this.inb(nx, ny)) continue;
            const nk = ny * N + nx;
            if (foot[nk] || comp[nk] >= 0 || !P.canStep(this, x, y, nx, ny, 'foot')) continue;
            comp[nk] = id; cells.push(nk);
          }
        }
        comps.push(cells);
      }
      if (!comps.length) break;
      comps.sort((a, b) => b.length - a.length);
      const big = comps[0];
      if (big.length >= 24) {
        const reachable = [];
        for (let k = 0; k < N * N; k++) if (foot[k]) reachable.push(k);
        const c = big[(big.length / 2) | 0];
        this.carve(reachable, [c % N, (c / N) | 0], 'foot', big.length > 120 ? 3 : 2);
        continue;
      }
      comps.forEach(cells => cells.forEach(k => {
        const x = k % N, y = (k / N) | 0, cnt = {};
        for (let d = 0; d < 8; d++) {
          const nx = x + [1, -1, 0, 0, 1, 1, -1, -1][d], ny = y + [0, 0, 1, -1, 1, -1, 1, -1][d];
          if (!this.inb(nx, ny)) continue;
          const c = this.t[ny * N + nx];
          if (c === T.BLOCK || c === T.WATER || c === T.VOID) cnt[c] = (cnt[c] || 0) + 1;
        }
        let best = T.BLOCK, bn = -1;
        for (const c in cnt) if (cnt[c] > bn) { bn = cnt[c]; best = +c; }
        this.t[k] = best; this.m[k] = 0; filled++;
      }));
    }
    this.filled = filled;
  }
  // Связные куски одного типа (4 соседа)
  comps(test) {
    const seen = new Uint8Array(N * N), out = [];
    for (let k = 0; k < N * N; k++) {
      if (seen[k] || !test(k)) continue;
      const q = [k]; seen[k] = 1;
      for (let i = 0; i < q.length; i++) {
        const c = q[i], x = c % N, y = (c / N) | 0;
        for (let d = 0; d < 4; d++) {
          const nx = x + [1, -1, 0, 0][d], ny = y + [0, 0, 1, -1][d];
          if (!this.inb(nx, ny)) continue;
          const nk = ny * N + nx;
          if (!seen[nk] && test(nk)) { seen[nk] = 1; q.push(nk); }
        }
      }
      out.push(q);
    }
    return out;
  }
  // Мосты: каждый — прямой настил шириной 3 от берега до берега. Обрывки и мосты в никуда
  // убираются (под ними снова вода или пропасть); кривые мосты, проложенные поиском пути, выпрямляются.
  fixBridges() {
    this.objs = this.objs.filter(o => o.k !== 'bridge');
    const land = k => { const c = this.t[k]; return c !== T.BRIDGE && c !== T.WATER && c !== T.VOID && P.canStand(this, k % N, (k / N) | 0, 'foot'); };
    const comps = this.comps(k => this.t[k] === T.BRIDGE);
    let rebuilt = 0, removed = 0, kept = 0;
    comps.forEach(cells => {
      // что под мостом и где берега
      let voids = 0, waters = 0;
      const shore = new Map();
      cells.forEach(c => {
        const x = c % N, y = (c / N) | 0;
        for (let d = 0; d < 4; d++) {
          const nx = x + [1, -1, 0, 0][d], ny = y + [0, 0, 1, -1][d];
          if (!this.inb(nx, ny)) continue;
          const nk = ny * N + nx, t = this.t[nk];
          if (t === T.VOID) voids++; else if (t === T.WATER) waters++;
          else if (land(nk)) shore.set(nk, 1);
        }
      });
      const under = voids >= waters ? T.VOID : T.WATER;
      cells.forEach(c => { this.t[c] = voids + waters ? under : T.OPEN; this.m[c] = 0; });
      if (!voids && !waters) { removed++; return; }
      // берега — кучки клеток суши, касающиеся моста (соседние клетки — одна кучка).
      // Одна кучка — мост в никуда: убрать. Две — выпрямить. Больше — развилка: оставить как есть.
      const pts = [...shore.keys()], grp = new Map();
      let G = 0;
      pts.forEach(s0 => {
        if (grp.has(s0)) return;
        G++; const st = [s0]; grp.set(s0, G);
        while (st.length) {
          const c = st.pop(), x = c % N, y = (c / N) | 0;
          for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) { const nk = (y + j) * N + x + i; if (shore.has(nk) && !grp.has(nk)) { grp.set(nk, G); st.push(nk); } }
        }
      });
      if (G < 2) { removed++; return; }
      if (G > 2 || this.prof.ortho) {
        cells.forEach(c => { this.t[c] = T.BRIDGE; this.m[c] = 0; });
        kept++; return;
      }
      const bySize = {};
      grp.forEach(g => bySize[g] = (bySize[g] || 0) + 1);
      const order = Object.keys(bySize).sort((a, b) => bySize[b] - bySize[a]).map(Number);
      const A = pts.filter(k => grp.get(k) === order[0]), B = pts.filter(k => grp.get(k) === order[1]);
      // ближайшая пара берегов на одной высоте (если есть)
      let best = null, bd = 1e9;
      A.forEach(a => B.forEach(b => {
        const d = Math.hypot(a % N - b % N, ((a / N) | 0) - ((b / N) | 0)) + (this.e[a] !== this.e[b] ? 50 : 0);
        if (d < bd) { bd = d; best = [a, b]; }
      }));
      const ax = best[0] % N + 0.5, ay = ((best[0] / N) | 0) + 0.5, bx = best[1] % N + 0.5, by = ((best[1] / N) | 0) + 0.5, h0 = this.e[best[0]];
      const L = Math.hypot(bx - ax, by - ay), nx = -(by - ay) / L, ny = (bx - ax) / L;
      for (let k = 0; k <= L * 3; k++) {
        const f = k / (L * 3), px = ax + (bx - ax) * f, py = ay + (by - ay) * f;
        for (let w = -1.2; w <= 1.2; w += 0.4) {
          const x = Math.floor(px + nx * w), y = Math.floor(py + ny * w);
          if (!this.inb(x, y)) continue;
          const kk = y * N + x;
          if (this.t[kk] === T.WATER || this.t[kk] === T.VOID) { this.t[kk] = T.BRIDGE; this.m[kk] = 0; this.e[kk] = h0; }
        }
      }
      this.objs.push({ k: 'bridge', a: [ax, ay], b: [bx, by], w: 3, u: under === T.VOID ? 'void' : 'water' });
      rebuilt++;
    });
    return { rebuilt, removed, kept };
  }
  // Лишние обрывки: лужи и ямки, одиночные скалы, куски дорог, склоны в никуда
  tidy() {
    let n = 0;
    this.comps(k => this.t[k] === T.WATER || this.t[k] === T.VOID).forEach(c => {
      if (c.length >= 6) return;
      if (c.some(k => k % N === 0 || k % N === N - 1 || k < N || k >= N * (N - 1))) return;
      c.forEach(k => { this.t[k] = T.OPEN; this.m[k] = 0; n++; });
    });
    this.comps(k => this.t[k] === T.BLOCK && !this.objMask[k]).forEach(c => {
      if (c.length > 2) return;
      const cov = this.prof.look && this.prof.look.mats && this.prof.look.mats[3];
      c.forEach(k => { this.t[k] = cov ? T.COVER : T.OPEN; this.m[k] = 0; n++; });
    });
    this.comps(k => this.t[k] === T.ROAD).forEach(c => {
      if (c.length >= 10) return;
      c.forEach(k => { this.t[k] = T.OPEN; this.m[k] = 0; n++; });
    });
    for (let k = 0; k < N * N; k++) {
      if (this.t[k] !== T.RAMP) continue;
      const x = k % N, y = (k / N) | 0;
      let up = false;
      for (let d = 0; d < 4; d++) {
        const nx = x + [1, -1, 0, 0][d], ny = y + [0, 0, 1, -1][d];
        if (this.inb(nx, ny) && this.e[ny * N + nx] === this.e[k] + 1 && P.canStand(this, nx, ny, 'foot')) up = true;
      }
      if (!up) { this.t[k] = this.res[k] === 2 && this.prof.road !== false ? T.ROAD : T.OPEN; this.m[k] = 0; n++; }
    }
    return n;
  }
  // ---------------------------------------------------------------- проверки
  check() {
    const err = [], tw = this.town;
    for (let k = 0; k < N * N; k++) if (this.res[k] === 1 && (this.t[k] !== T.OPEN || this.e[k] !== this.base)) { err.push('заповедная клетка занята: ' + (k % N) + ',' + ((k / N) | 0)); break; }
    const foot = this.reach(this.stripStarts(1), 'foot', 1);
    const veh = this.reach(this.stripStarts(2), 'track', 2);
    for (const tg of this.targets()) {
      const k = tg[2] * N + tg[1];
      if (!foot[k]) err.push('пешком не дойти: ' + tg[0]);
      if (!veh[k] && !veh[k - 1] && !veh[k - N] && !veh[k - N - 1]) err.push('технике не доехать: ' + tg[0]);
    }
    let walk = 0, reach = 0;
    for (let k = 0; k < N * N; k++) { if (P.canStand(this, k % N, (k / N) | 0, 'foot')) { walk++; if (foot[k]) reach++; } }
    if (reach < walk) {
      let ex = '';
      for (let k = 0; k < N * N && ex.length < 60; k++) if (P.canStand(this, k % N, (k / N) | 0, 'foot') && !foot[k]) ex += ' ' + (k % N) + ',' + ((k / N) | 0) + ':' + this.t[k] + '/' + this.e[k];
      err.push('недостижимых клеток: ' + (walk - reach) + ' (' + ex + ')');
    }
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      for (let d = 0; d < 2; d++) {
        const nx = x + 1 - d, ny = y + d;
        if (nx < N && ny < N && Math.abs(this.e[y * N + x] - this.e[ny * N + nx]) > 1 && P.canStand(this, x, y, 'foot') && P.canStand(this, nx, ny, 'foot')) {
          err.push('перепад больше 1 у ' + x + ',' + y); y = N; break;
        }
      }
    }
    const stat = {};
    for (let k = 0; k < N * N; k++) stat[this.t[k]] = (stat[this.t[k]] || 0) + 1;
    return { err, walk, stat };
  }
  build() {
    this.reserveAll();
    this.prof.build(this, T);
    this.enforce();
    this.cliffs();
    this.cut = 0; this.tidied = 0;
    // доводка по кругу: связность → ровные места → мосты → обрывки; пока проверка не чиста
    for (let round = 0; round < 6; round++) {
      this.cut += this.connect();
      this.enforce();
      this.br = this.fixBridges();
      this.tidied += this.tidy();
      if (!this.check().err.length) break;
    }
    return this;
  }
  json() {
    return Object.assign({ id: this.id, v: VERSION, w: N, h: N, seed: this.seed, town: this.town,
      t: P.pack(this.t), e: P.pack(this.e), m: P.pack(this.m), objs: this.objs, paths: this.paths }, { name: this.prof.name, about: this.prof.about, look: this.prof.look, zones: { deploy: this.z.deploy, slots: this.z.slots } });
  }
}

// ---------------------------------------------------------------- запуск
function run(ids) {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
  let bad = 0;
  const index = {};
  ids.forEach(id => {
    const prof = PROFILES[id];
    if (!prof) { console.log(id + ': нет профиля'); bad++; return; }
    const g = new Gen(id, prof).build();
    const res = g.check(), js = g.json(), txt = JSON.stringify(js);
    // карта читается обратно так же
    const back = P.load(JSON.parse(txt));
    for (let k = 0; k < N * N; k++) if (back.t[k] !== g.t[k] || back.e[k] !== g.e[k] || back.m[k] !== g.m[k]) { res.err.push('упаковка не сходится'); break; }
    fs.writeFileSync(path.join(OUT, id + '.json'), txt);
    index[id] = { name: prof.name, kb: Math.round(txt.length / 102.4) / 10 };
    const pct = c => Math.round((res.stat[c] || 0) / (N * N) * 1000) / 10;
    console.log((res.err.length ? '✗ ' : '✓ ') + id.padEnd(14) + (txt.length / 1024).toFixed(1).padStart(5) + ' КБ  проход ' +
      (res.walk / (N * N) * 100).toFixed(0) + '%  скалы ' + pct(T.BLOCK) + '%  вода ' + pct(T.WATER) + '%  пропасть ' + pct(T.VOID) +
      '%  укрытия ' + pct(T.COVER) + '%  заросли ' + pct(T.LIGHT) + '%  мостов ' + g.br.rebuilt + ' (убрано ' + g.br.removed + ')  обрывков ' + g.tidied + '  залито ' + g.filled + '  объектов ' + g.objs.length +
      (res.err.length ? '\n    ' + res.err.slice(0, 6).join('\n    ') : ''));
    if (res.err.length) bad++;
  });
  // список планет (для экранов): только при полном прогоне
  if (ids.length === Object.keys(ZONES).length) {
    fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(Object.keys(index).map(id => ({ id: id, name: index[id].name })).sort((a, b) => a.name.localeCompare(b.name, 'ru'))));
  }
  return bad;
}

if (require.main === module) {
  const ids = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(ZONES).sort();
  const bad = run(ids);
  process.exit(bad ? 1 : 0);
}
module.exports = { Gen, run, valueNoise, mulberry32, hashStr };
