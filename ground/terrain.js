/* Местность планеты в наземке 2.0: как выглядит карта (на расчёт боя не влияет).
 *
 * Карта — из shared/planets/<id>.json (SWPlanets.load), вид — из её look.
 * Рисуется кусками: render(ctx, x0, y0, w, h, ppc) кладёт клетки [x0..x0+w)×[y0..y0+h)
 * на холст ctx в точку (0, 0), по ppc точек на клетку. Два прохода:
 *   1) по точкам — земля, трава, песок, дороги, вода, лава, пропасти, скалы; рельеф
 *      освещён с северо-запада, высокие места отбрасывают тени, края — рваные (шум);
 *   2) предметы — укрытия по клеткам (валуны, контейнеры, изгороди) и крупное из objs
 *      (небоскрёбы, остовы, стволы, шпили), каждое со своей тенью.
 * Всё детерминировано: одна и та же клетка всегда выглядит одинаково.
 * ES5, только браузер.
 */
(function(root) {
  'use strict';

  var P = root.SWPlanets, TT = P.T;
  var TAU = Math.PI * 2;
  var LX = -0.56, LY = -0.66, LZ = 0.5;          // свет с северо-запада
  (function() { var l = Math.sqrt(LX * LX + LY * LY + LZ * LZ); LX /= l; LY /= l; LZ /= l; })();

  // ---------------------------------------------------------------- цвета и шум
  function rgb(hex) {
    if (!hex) return [128, 128, 128];
    var v = parseInt(hex.slice(1), 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  }
  function css(c, k, a) {
    k = k == null ? 1 : k;
    var r = Math.max(0, Math.min(255, Math.round(c[0] * k))), g = Math.max(0, Math.min(255, Math.round(c[1] * k))), b = Math.max(0, Math.min(255, Math.round(c[2] * k)));
    return a == null ? 'rgb(' + r + ',' + g + ',' + b + ')' : 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
  }
  function mixc(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
  function hash(x, y, s) {
    var h = (x * 374761393 + y * 668265263 + (s || 0) * 2246822519) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }
  function smooth(t) { return t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t); }

  // Шумовые текстуры 256×256, бесшовные (для деталей земли)
  var NS = 256, NT = null;
  function makeNoise(seed) {
    var out = new Float32Array(NS * NS), tot = 0;
    for (var o = 0; o < 5; o++) {
      var cells = 4 << o, amp = 1 / (1 << o), lat = new Float32Array(cells * cells);
      for (var i = 0; i < lat.length; i++) lat[i] = hash(i, o, seed);
      var step = NS / cells;
      for (var y = 0; y < NS; y++) for (var x = 0; x < NS; x++) {
        var gx = x / step, gy = y / step, xi = Math.floor(gx), yi = Math.floor(gy), fx = smooth(gx - xi), fy = smooth(gy - yi);
        var x1 = (xi + 1) % cells, y1 = (yi + 1) % cells;
        var a = lat[yi * cells + xi], b = lat[yi * cells + x1], c = lat[y1 * cells + xi], d = lat[y1 * cells + x1];
        out[y * NS + x] += (a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy) * amp;
      }
      tot += amp;
    }
    for (var k = 0; k < out.length; k++) out[k] /= tot;
    return out;
  }
  function noises() {
    if (!NT) NT = [makeNoise(11), makeNoise(29), makeNoise(53)];
    return NT;
  }
  // плавная выборка шума (u, v — в точках текстуры)
  function nz(T, u, v) {
    var x = u - Math.floor(u / NS) * NS, y = v - Math.floor(v / NS) * NS;
    var xi = x | 0, yi = y | 0, fx = x - xi, fy = y - yi, x1 = (xi + 1) & 255, y1 = (yi + 1) & 255;
    var a = T[yi * NS + xi], b = T[yi * NS + x1], c = T[y1 * NS + xi], d = T[y1 * NS + x1];
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  }

  // ---------------------------------------------------------------- подготовка карты
  // Материалы города (слой m с 8, см. shared/rt-town.js) — не зависят от палитры планеты
  var TOWN_MAT = { 8: 'wall', 9: 'palisade', 10: 'stall', 11: 'crate', 12: 'statue', 13: 'planterbox', 14: 'barrier', 15: 'fence', 16: 'hedge', 17: 'pavement', 18: 'bldg' };
  var TOWN_LOOK_DEF = { wall: 'stone', roof: 'flat', c: [180, 176, 168], roofC: [120, 116, 110], trim: [80, 78, 74] };
  // Какие «скалы» рисуются рельефом по точкам (остальное непроходимое — предметами)
  var ROCKLIKE = { rock: 1, outcrop: 1, mesa: 1, spoil: 1, icecrag: 1, crystalridge: 1, cliff: 1 };
  var ROCK_H = { rock: 1.7, outcrop: 1.3, mesa: 2.4, spoil: 1.1, icecrag: 1.6, crystalridge: 1.4, cliff: 1.8 };

  function Terrain(json) {
    var map = P.load(json), N = map.w, n = N * N, L = json.look || {};
    this.map = map; this.look = L; this.N = N; this.id = json.id;
    var mats = L.mats || {};
    this.matName = function(code, m) { if (m >= 8 && TOWN_MAT[m]) return TOWN_MAT[m]; var a = mats[code]; return a && a[m] ? a[m] : (a && a[0]) || ''; };
    this.tlook = (json.settle && json.settle.look) || TOWN_LOOK_DEF;
    // цвета
    this.C = {
      g: (L.ground || ['#5a6a40', '#66764a', '#4e5e38']).map(rgb),
      rough: rgb(L.rough || '#8a8068'),
      light: (L.light || ['#4a6a30', '#3a5a26']).map(rgb),
      rock: (L.rock || ['#77736b', '#b0aca2']).map(rgb),
      water: (L.water || ['#1d4a6a', '#4a8ab0']).map(rgb),
      road: rgb(L.road || '#8a7a5a'),
      voidc: (L.voidc || ['#080808', '#2a2a2a']).map(rgb),
      accent: rgb(L.accent || '#ffd27a')
    };
    this.ground = L.style || 'soil';
    // поля по клеткам
    var t = map.t, e = map.e, m = map.m;
    var R = new Float32Array(n), Lf = new Float32Array(n), D = new Float32Array(n), B = new Float32Array(n),
        W = new Float32Array(n), V = new Float32Array(n), F = new Float32Array(n), E = new Float32Array(n), Lm = new Uint8Array(n), Rm = new Uint8Array(n);
    var objCell = new Uint8Array(n);
    for (var k = 0; k < n; k++) {
      var c = t[k], x = k % N, y = (k / N) | 0, h = e[k];
      if (c === TT.ROUGH) { R[k] = 1; Rm[k] = m[k]; }
      else if (c === TT.LIGHT) { Lf[k] = 1; Lm[k] = m[k]; }
      else if (c === TT.TRAP) { R[k] = 0.6; }
      if (c === TT.ROAD) D[k] = 1;
      else if (c === TT.RAMP || c === TT.BRIDGE) {
        // склон на дороге — тоже дорога
        for (var d = 0; d < 4; d++) {
          var nx = x + [1, -1, 0, 0][d], ny = y + [0, 0, 1, -1][d];
          if (nx >= 0 && ny >= 0 && nx < N && ny < N && t[ny * N + nx] === TT.ROAD) { D[k] = 1; break; }
        }
      }
      if (c === TT.WATER || c === TT.FORD) W[k] = 1;
      if (c === TT.FORD) F[k] = 1;
      if (c === TT.VOID) V[k] = 1;
      if (c === TT.BRIDGE) {
        // под мостом — то, что он перекрывает (вода или пропасть рядом)
        var under = 0;
        for (var d2 = 0; d2 < 4; d2++) {
          var ax = x + [1, -1, 0, 0][d2], ay = y + [0, 0, 1, -1][d2];
          if (ax < 0 || ay < 0 || ax >= N || ay >= N) continue;
          var cc = t[ay * N + ax];
          if (cc === TT.VOID) under = 2; else if (cc === TT.WATER && under !== 2) under = 1;
        }
        if (under === 2) V[k] = 1; else if (under === 1 || L.ocean) W[k] = 1;
      }
      var hh = h;
      if (c === TT.BLOCK) {
        var nm = this.matName(TT.BLOCK, m[k]);
        if (ROCKLIKE[nm] || !nm) { B[k] = 1; hh += (ROCK_H[nm] || 1.7) * (0.75 + 0.5 * hash(x, y, 7)); }
        else objCell[k] = 1;
      }
      E[k] = hh;
    }
    // мелкий рельеф: пологие бугры и ложбины (только на вид — для хода земля ровная)
    var relief = L.relief != null ? L.relief : 0.45, NR = noises()[1];
    if (relief) for (k = 0; k < n; k++) E[k] += (nz(NR, (k % N) * 3.1, ((k / N) | 0) * 3.1) - 0.5) * relief * 2;
    // вид клетки внутри типа (заросли: луг или роща и т. п.) — долей, чтобы смена вида шла плавно
    var L1 = new Float32Array(n), R1 = new Float32Array(n);
    for (k = 0; k < n; k++) { if (Lf[k] && Lm[k] === 1) L1[k] = 1; if (R[k] && Rm[k] === 1) R1[k] = 1; }
    // маски чуть размыты: контуры круглее, тонкие реки не рвутся
    this.R = R; this.L = Lf; this.D = D; this.B = B; this.W = W; this.V = V; this.F = F;
    this.L1 = L1; this.R1 = R1;
    this.Lm = Lm; this.Rm = Rm; this.objCell = objCell;
    // глубина воды и пропасти — расстояние до берега (в клетках, до 6)
    this.WD = distField(W, N, 6); this.VD = distField(V, N, 6);
    // поверхность пропастей и воды уходит вниз — для теней и освещения
    var voidDepth = L.void === 'lava' ? 0.35 : L.void === 'crevasse' ? 2.2 : 3;
    for (k = 0; k < n; k++) {
      if (V[k] && t[k] !== TT.BRIDGE) E[k] -= Math.min(voidDepth, 0.6 + this.VD[k] * 0.9);
      else if (W[k] && t[k] !== TT.BRIDGE) E[k] -= L.ocean ? 1.1 : Math.min(0.8, 0.25 + this.WD[k] * 0.15);
    }
    // воронки — ямы в рельефе
    var self = this;
    map.objs.forEach(function(o) {
      if (o.k === 'crater') {
        for (var yy = Math.floor(o.y - o.r - 2); yy <= o.y + o.r + 2; yy++) for (var xx = Math.floor(o.x - o.r - 2); xx <= o.x + o.r + 2; xx++) {
          if (xx < 0 || yy < 0 || xx >= N || yy >= N) continue;
          var dd = Math.hypot(xx + 0.5 - o.x, yy + 0.5 - o.y) / o.r;
          if (dd < 1) E[yy * N + xx] -= 0.7 * (1 - dd * dd);
          else if (dd < 1.45) E[yy * N + xx] += 0.25 * Math.sin((dd - 1) / 0.45 * Math.PI);
        }
      }
    });
    this.E = E;
    var EL = new Float32Array(n), cntE = {};
    for (k = 0; k < n; k++) { EL[k] = e[k]; cntE[e[k]] = (cntE[e[k]] || 0) + 1; }
    var base = 0, bc = -1;
    for (var lv in cntE) if (cntE[lv] > bc) { bc = cntE[lv]; base = +lv; }
    this.EL = EL; this.base = base;
    var ER = new Float32Array(n);
    for (k = 0; k < n; k++) ER[k] = E[k] - EL[k];
    this.ER = ER;
    // тени: насколько клетку закрывает рельеф со стороны света
    var S = new Float32Array(n);
    for (y = 0; y < N; y++) for (x = 0; x < N; x++) {
      var e0 = E[y * N + x], s = 0;
      for (var st = 1; st <= 5; st++) {
        var sx = Math.round(x + LX / 0.86 * st), sy = Math.round(y + LY / 0.86 * st);
        if (sx < 0 || sy < 0 || sx >= N || sy >= N) break;
        var dh = (E[sy * N + sx] - e0 - st * 0.7) * 0.8;
        if (dh > s) s = dh;
      }
      S[y * N + x] = Math.min(1, s);
    }
    this.S = S;
    // затенение впадин: насколько клетка ниже соседей
    var AO = new Float32Array(n);
    for (y = 0; y < N; y++) for (x = 0; x < N; x++) {
      var sum = 0, cnt = 0;
      for (var j = -2; j <= 2; j++) for (var i = -2; i <= 2; i++) {
        var qx = x + i, qy = y + j;
        if (qx < 0 || qy < 0 || qx >= N || qy >= N) continue;
        sum += E[qy * N + qx]; cnt++;
      }
      AO[y * N + x] = Math.max(0, Math.min(0.5, (sum / cnt - E[y * N + x]) * 0.45));
    }
    this.AO = AO;
    // отсвет лавы на соседнюю землю
    if (L.void === 'lava') {
      var G = new Float32Array(n), VO = distField(invert(V), N, 3);
      for (k = 0; k < n; k++) if (!V[k]) G[k] = Math.max(0, 1 - (VO[k] - 0.5) / 2.2);
      this.GL = G;
    }
    // все поля — вдвое подробнее и сглажены: ступеньки клеток становятся плавными краями
    var self2 = this;
    ['R', 'L', 'L1', 'R1', 'D', 'B', 'W', 'V', 'F', 'EL', 'ER', 'S', 'AO', 'WD', 'VD', 'GL'].forEach(function(f) { if (self2[f]) self2[f] = up2(self2[f], N); });
    this.groundFn = GROUND[this.ground] || GROUND.soil;
    // прямые мосты рисуются целиком (настил от берега до берега), их клетки — не по одной
    var BM = new Uint8Array(n);
    map.objs.forEach(function(o) {
      if (o.k !== 'bridge') return;
      var dx = o.b[0] - o.a[0], dy = o.b[1] - o.a[1], L = Math.sqrt(dx * dx + dy * dy) || 1, ux = dx / L, uy = dy / L;
      for (var q = -0.5; q <= L + 0.5; q += 0.25) for (var w = -o.w / 2; w <= o.w / 2; w += 0.25) {
        var x = Math.floor(o.a[0] + ux * q - uy * w), y = Math.floor(o.a[1] + uy * q + ux * w);
        if (x >= 0 && y >= 0 && x < N && y < N && t[y * N + x] === TT.BRIDGE) BM[y * N + x] = 1;
      }
    });
    this.BM = BM;
    // круглые платформы (Камино): кромка — точная окружность, а не ступеньки клеток; KPI — какие платформы рядом с клеткой
    var KP = map.objs.filter(function(o) { return o.k === 'kplat'; });
    if (KP.length) {
      var KPI = new Array(n);
      KP.forEach(function(o, i) {
        var R2 = o.r + 2.5;
        for (var yy = Math.max(0, Math.floor(o.y - R2)); yy <= Math.min(N - 1, Math.floor(o.y + R2)); yy++)
          for (var xx = Math.max(0, Math.floor(o.x - R2)); xx <= Math.min(N - 1, Math.floor(o.x + R2)); xx++) {
            var kk = yy * N + xx; (KPI[kk] || (KPI[kk] = [])).push(i);
          }
      });
      this.KP = KP; this.KPI = KPI;
    }
    // причал вдоль полосы вторжения: верхний край — прямая
    this.KD = map.objs.filter(function(o) { return o.k === 'kdock'; })[0] || null;
    // у круглых платформ клетки суши по краю срезаны окружностью — переход продлевается на клетку палубы,
    // чтобы между ним и кромкой не было щели
    if (KP.length || this.KD) {
      var BX = [], seenX = {};
      for (k = 0; k < n; k++) {
        if (t[k] !== TT.BRIDGE) continue;
        var bx = k % N, by = (k / N) | 0;
        for (var dd = 0; dd < 4; dd++) {
          var ddx = [1, -1, 0, 0][dd], ddy = [0, 0, 1, -1][dd], ex2 = bx + ddx, ey2 = by + ddy, px2 = bx - ddx, py2 = by - ddy;
          if (ex2 < 0 || ey2 < 0 || ex2 >= N || ey2 >= N || px2 < 0 || py2 < 0 || px2 >= N || py2 >= N) continue;
          var ec = t[ey2 * N + ex2];
          if ((ec === TT.OPEN || ec === TT.ROAD || ec === TT.ROUGH) && t[py2 * N + px2] === TT.BRIDGE && !seenX[ey2 * N + ex2]) { seenX[ey2 * N + ex2] = 1; BX.push(ex2, ey2); }
        }
      }
      this.BX = BX;
    }
    this.cache = {};
  }
  function up2(F, N) {
    var M = N * 2, o = new Float32Array(M * M), tmp = new Float32Array(M * M), x, y, k, pass;
    for (y = 0; y < M; y++) for (x = 0; x < M; x++) o[y * M + x] = F[(y >> 1) * N + (x >> 1)];
    for (pass = 0; pass < 2; pass++) {
      for (y = 0; y < M; y++) for (x = 0; x < M; x++) {
        k = y * M + x;
        tmp[k] = (o[k] * 2 + (x > 0 ? o[k - 1] : o[k]) + (x < M - 1 ? o[k + 1] : o[k])) / 4;
      }
      for (y = 0; y < M; y++) for (x = 0; x < M; x++) {
        k = y * M + x;
        o[k] = (tmp[k] * 2 + (y > 0 ? tmp[k - M] : tmp[k]) + (y < M - 1 ? tmp[k + M] : tmp[k])) / 4;
      }
    }
    return o;
  }
  function blur(F, N) {
    var o = new Float32Array(N * N), tmp = new Float32Array(N * N), x, y, k;
    for (y = 0; y < N; y++) for (x = 0; x < N; x++) {
      k = y * N + x;
      tmp[k] = (F[k] * 4 + (x > 0 ? F[k - 1] : F[k]) + (x < N - 1 ? F[k + 1] : F[k])) / 6;
    }
    for (y = 0; y < N; y++) for (x = 0; x < N; x++) {
      k = y * N + x;
      o[k] = (tmp[k] * 4 + (y > 0 ? tmp[k - N] : tmp[k]) + (y < N - 1 ? tmp[k + N] : tmp[k])) / 6;
    }
    return o;
  }
  function invert(F) { var o = new Float32Array(F.length); for (var i = 0; i < F.length; i++) o[i] = F[i] ? 0 : 1; return o; }
  // расстояние внутри маски до её края (0 — снаружи, 1 — крайняя клетка)
  function distField(F, N, max) {
    var D = new Float32Array(N * N), q = [], k;
    for (k = 0; k < N * N; k++) {
      if (!F[k]) continue;
      var x = k % N, y = (k / N) | 0, edge = false;
      for (var d = 0; d < 4 && !edge; d++) {
        var nx = x + [1, -1, 0, 0][d], ny = y + [0, 0, 1, -1][d];
        if (nx >= 0 && ny >= 0 && nx < N && ny < N && !F[ny * N + nx]) edge = true;
      }
      if (edge) { D[k] = 1; q.push(k); } else D[k] = 0;
    }
    for (var h = 0; h < q.length; h++) {
      k = q[h];
      var cx = k % N, cy = (k / N) | 0;
      for (var d2 = 0; d2 < 4; d2++) {
        var ax = cx + [1, -1, 0, 0][d2], ay = cy + [0, 0, 1, -1][d2];
        if (ax < 0 || ay < 0 || ax >= N || ay >= N) continue;
        var ak = ay * N + ax;
        if (F[ak] && D[ak] === 0) { D[ak] = Math.min(max, D[k] + 1); q.push(ak); }
      }
    }
    for (k = 0; k < N * N; k++) if (F[k] && D[k] === 0) D[k] = max;
    return D;
  }

  // ---------------------------------------------------------------- земля по стилю планеты
  // u, v — клетки (дробные); n0..n2 — шум; на выходе — цвет в out
  function g3(C, n0, n1) {
    var a = C.g[0], b = C.g[1], c = C.g[2], t = smooth((n0 - 0.32) / 0.36);
    var r = mixc(a, b, t);
    return mixc(r, c, smooth((n1 - 0.45) / 0.3) * 0.7);
  }
  // Палуба круглой платформы: кольца панелей шириной 3 клетки, радиальные швы, светлая кромка
  function deckCol(C, o, u, v, s, n0, f) {
    var dx = u - o.x, dy = v - o.y, rr = o.r - s, ri = Math.floor(rr / 3), fr = rr / 3 - ri;
    var ns = ri ? Math.max(6, Math.round(TAU * (ri + 0.5))) : 1, a = (Math.atan2(dy, dx) / TAU + 1) * ns, si = Math.floor(a) % ns, fa = a - Math.floor(a);
    var arc = TAU * Math.max(0.5, rr) / ns, hs = hash(ri * 37 + si, (o.x * 7 + o.y) | 0, 3);
    var c = mixc(C.g[0], hs < 0.5 ? C.g[1] : C.g[2], hash(si, ri + 11, 5) * 0.7);
    var seam = Math.min(fr, 1 - fr) * 3 < 0.035 || (ns > 1 && Math.min(fa, 1 - fa) * arc < 0.035) ? 0.72 : 1;
    if (seam === 1 && ((fr > 0.06 && fr < 0.1) || fr > 0.9 && fr < 0.94) && ns > 1 && ((fa * arc > 0.14 && fa * arc < 0.24) || ((1 - fa) * arc > 0.14 && (1 - fa) * arc < 0.24))) seam = 0.8;   // заклёпки
    var lip = s < 0.06 ? 0.62 : s < 0.5 ? 1.13 : s < 0.62 ? 0.84 : 1;                      // кромка: тёмный край, светлый бортик, шов
    var b = seam * lip * (1 - Math.max(0, n0 - 0.6) * 0.5) * (0.97 + f * 0.06);
    return [c[0] * b, c[1] * b, c[2] * b];
  }
  var GROUND = {
    soil: function(C, u, v, n0, n1, n2, f, hf) { var c = g3(C, n0, n1); var p = (n2 > 0.62 ? 0.88 : n2 < 0.3 ? 1.06 : 1) * (0.92 + (hf - 0.5) * 0.3 + f * 0.1); return [c[0] * p, c[1] * p, c[2] * p]; },
    grass: function(C, u, v, n0, n1, n2, f, hf) { var c = g3(C, n0, n1), b = 0.86 + f * 0.18 + (hf - 0.5) * 0.34; return [c[0] * b, c[1] * b * 1.02, c[2] * b]; },
    lawn: function(C, u, v, n0, n1, n2, f, hf) {
      var c = g3(C, n0 * 0.5 + 0.25, n1), band = (Math.floor(u / 2) & 1) ? 1.04 : 0.96, b = band * (0.93 + f * 0.1 + (hf - 0.5) * 0.18);
      return [c[0] * b, c[1] * b, c[2] * b];
    },
    forest: function(C, u, v, n0, n1, n2, f, hf) { var c = g3(C, n0, n1), b = 0.78 + f * 0.3 + (hf - 0.5) * 0.4; if (hf > 0.72) c = mixc(c, [110, 80, 50], 0.4); return [c[0] * b, c[1] * b * 0.98, c[2] * b * 0.9]; },
    sand: function(C, u, v, n0, n1, n2, f, hf) {
      var c = g3(C, n0, n1), rip = Math.sin((u * 0.9 + v * 0.45 + n1 * 6) * 3.1) * 0.035 + 1 + (hf - 0.5) * 0.08;
      return [c[0] * rip, c[1] * rip, c[2] * rip];
    },
    snow: function(C, u, v, n0, n1, n2, f, hf) {
      var c = g3(C, n0, n1), sh = 1 - Math.max(0, n2 - 0.55) * 0.35, sp = hf > 0.8 ? 1.06 : 1;
      return [c[0] * sh * sp, c[1] * sh * sp, c[2] * Math.min(1.1, sh + 0.06) * sp];
    },
    plates: function(C, u, v, n0, n1, n2, f) {
      var px = Math.floor(u / 2), py = Math.floor(v / 2), fx = u / 2 - px, fy = v / 2 - py;
      var c = mixc(C.g[0], hash(px, py, 3) < 0.5 ? C.g[1] : C.g[2], hash(px, py, 5) * 0.7);
      var seam = fx < 0.025 || fy < 0.025 ? 0.72 : fx > 0.975 || fy > 0.975 ? 1.08 : 1;
      var dirt = 1 - Math.max(0, n0 - 0.6) * 0.5;
      var rv = ((fx > 0.06 && fx < 0.1) || (fx > 0.9 && fx < 0.94)) && ((fy > 0.06 && fy < 0.1) || (fy > 0.9 && fy < 0.94)) ? 0.8 : 1;
      var b = seam * dirt * rv * (0.97 + f * 0.06);
      return [c[0] * b, c[1] * b, c[2] * b];
    },
    concrete: function(C, u, v, n0, n1, n2, f) {
      var px = Math.floor(u / 4), py = Math.floor(v / 4), fx = u / 4 - px, fy = v / 4 - py;
      var c = mixc(g3(C, n0, n1), C.g[2], hash(px, py, 9) * 0.4);
      var seam = fx < 0.012 || fy < 0.012 ? 0.75 : 1, stain = 1 - Math.max(0, n2 - 0.58) * 0.6;
      var b = seam * stain * (0.96 + f * 0.08);
      return [c[0] * b, c[1] * b, c[2] * b];
    },
    stone: function(C, u, v, n0, n1, n2, f, hf) {
      // плиты неправильной формы: границы по ступеням шума
      var c = g3(C, n0, n1), q = n2 * 7, edge = Math.abs(q - Math.round(q)) < 0.05 ? 0.82 : 1;
      var b = edge * (0.93 + f * 0.1 + (hf - 0.5) * 0.12);
      return [c[0] * b, c[1] * b, c[2] * b];
    },
    glass: function(C, u, v, n0, n1, n2, f) {
      var c = g3(C, n0, n1), q = n2 * 6, facet = 0.9 + (q - Math.floor(q)) * 0.22;
      var spark = f > 0.992 ? 1.5 : 1;
      return [c[0] * facet * spark, c[1] * facet * spark, c[2] * facet * spark];
    },
    ash: function(C, u, v, n0, n1, n2, f, hf) { var c = g3(C, n0, n1), b = 0.9 + f * 0.12 + (hf - 0.5) * 0.2 + Math.max(0, n2 - 0.6) * 0.35; return [c[0] * b, c[1] * b, c[2] * b]; },
    basalt: function(C, u, v, n0, n1, n2, f, hf) {
      var c = g3(C, n0, n1), q = n2 * 8, crack = Math.abs(q - Math.round(q)) < 0.05 ? 0.6 : 1;
      var b = crack * (0.88 + f * 0.16 + (hf - 0.5) * 0.24);
      return [c[0] * b, c[1] * b, c[2] * b];
    },
    moss: function(C, u, v, n0, n1, n2, f, hf) { var c = g3(C, n0, n1), b = 0.86 + f * 0.2 + (hf - 0.5) * 0.24; return [c[0] * b, c[1] * b, c[2] * b * 1.04]; }
  };

  // ---------------------------------------------------------------- проход по точкам
  // Цвет зарослей по виду (луг, роща, болото…); в out — цвет, out[3] — добавочное свечение
  var SPARSE = { scrub: 1, heath: 1, frost: 1, moss: 1, ore: 1, weeds: 1, cinder: 1, thorns: 1 };
  function lightCol(st, C, q, r, g, b, u, v, n2, f, hf, glow, out) {
    var lc = C.light[q] || C.light[0], lk = 0.82 + f * 0.26 + (hf - 0.5) * 0.3, add = 0, ac = null;
    if (st === 'crater') lk = 0.55 + n2 * 0.25;
    else if (st === 'trench') lk = 0.58 + hf * 0.1;
    else if (st === 'glowflora') { lk = 0.72 + f * 0.2; if (hf > 0.74 && glow) { ac = glow[(Math.floor(u * 3) + Math.floor(v * 3)) % glow.length]; add = (hf - 0.74) * 2.6; } }
    else if (st === 'flowers') { if (hf > 0.6) { lc = hash(Math.floor(u * 4), Math.floor(v * 4), 2) < 0.5 ? C.light[1] : [240, 224, 120]; lk = 1.05; } else { lc = C.light[0]; } }
    else if (st === 'swamp') { if (n2 > 0.6) { lc = C.water[1]; lk = 0.75; } else lk = 0.8 + hf * 0.3; }
    else if (st === 'crystalbed') { lk = 0.88 + n2 * 0.2; if (hf > 0.8) { ac = [200, 240, 255]; add = (hf - 0.8) * 1.6; } }
    else if (st === 'puddles') { if (n2 > 0.6) { lc = C.water[1]; lk = 1.1; } else { out[0] = r; out[1] = g; out[2] = b; out[3] = 0; return out; } }
    else if (st === 'tallgrass' || st === 'meadow') lk = 0.74 + nz(NT[2], u * 40 + v * 6, v * 14) * 0.5;
    else if (st === 'cinder') { lk = 0.75; if (hf > 0.86) { ac = [255, 110, 30]; add = (hf - 0.86) * 5; } }
    else if (st === 'grove' || st === 'undergrowth' || st === 'fern' || st === 'lilacwood' || st === 'thorns') {
      // кроны и кусты: пятна с тенью снизу-справа
      var cl = nz(NT[0], u * 22, v * 22), cl2 = nz(NT[0], u * 22 - 0.9, v * 22 - 1.1);
      lk = 0.62 + cl * 0.65 + (cl - cl2) * 0.9;
    }
    out[0] = lc[0] * lk; out[1] = lc[1] * lk; out[2] = lc[2] * lk; out[3] = 0;
    if (SPARSE[st]) {
      // редкая поросль: пучки по земле, а не сплошное пятно
      var tn = nz(NT[0], u * 110, v * 110) * 0.6 + hf * 0.4, tuft = smooth((tn - 0.45) / 0.18) * (0.6 + f * 0.4), k = 0.25 + 0.75 * tuft;
      out[0] = r + (out[0] - r) * k; out[1] = g + (out[1] - g) * k; out[2] = b + (out[2] - b) * k;
    }
    if (ac) { out[0] += ac[0] * add; out[1] += ac[1] * add; out[2] += ac[2] * add; out[3] = add; }
    return out;
  }
  Terrain.prototype.pixels = function(img, x0, y0, wc, hc, ppc) {
    var N = this.N, C = this.C, L = this.look, NTs = noises(), N0 = NTs[0], N1 = NTs[1], N2 = NTs[2];
    var R = this.R, Lf = this.L, L1 = this.L1, R1 = this.R1, D = this.D, B = this.B, W = this.W, V = this.V, F = this.F, S = this.S, AO = this.AO, GL = this.GL;
    var WD = this.WD, VD = this.VD, objCell = this.objCell, Mm = this.map.m;
    var W2 = Math.round(wc * ppc), H2 = Math.round(hc * ppc), d = img.data, inv = 1 / ppc, gfn = this.groundFn;
    var voidKind = L.void || 'chasm', ocean = !!L.ocean, roadStyle = L.roadStyle || 'trail';
    var ls0 = this.matName(TT.LIGHT, 0), ls1 = this.matName(TT.LIGHT, 1), rs0 = this.matName(TT.ROUGH, 0), rs1 = this.matName(TT.ROUGH, 1);
    var glow = L.glow ? (typeof L.glow === 'string' ? [rgb(L.glow)] : L.glow.map(rgb)) : null;
    var rockA = C.rock[0], rockB = C.rock[1], EL = this.EL, ER = this.ER, base = this.base, highTint = L.highTint || 0;
    var TH = 0.4, TW = 1 / 0.12;
    var KP = this.KP, KPI = this.KPI, KD = this.KD, kpo, kps, kpl;
    var oa = [0, 0, 0, 0], ob = [0, 0, 0, 0];
    var M = N * 2, Mm1 = M - 1.001;
    function bl(Fd, u, v) {
      var x = u * 2 - 0.5, y = v * 2 - 0.5;
      if (x < 0) x = 0; else if (x > Mm1) x = Mm1;
      if (y < 0) y = 0; else if (y > Mm1) y = Mm1;
      var xi = x | 0, yi = y | 0, fx = x - xi, fy = y - yi, i = yi * M + xi;
      var xa = xi + 1 > M - 1 ? i : i + 1, ya = yi + 1 > M - 1 ? 0 : M;
      var a = Fd[i], b = Fd[xa], c = Fd[i + ya], e = Fd[xa + ya];
      return a + (b - a) * fx + (c - a) * fy + (a - b - c + e) * fx * fy;
    }
    function rough(st, rc, u, v, n1, n2, f, hf) {
      if (st === 'sand' || st === 'dunes' || st === 'dust') return 1 + Math.sin((u * 1.1 + v * 0.5 + n1 * 5) * 3.3) * 0.06 + (hf - 0.5) * 0.08;
      if (st === 'snowdrift') return 1.02 + (n2 - 0.5) * 0.12;
      if (st === 'mud') return 0.8 + n2 * 0.18;
      if (st === 'rail') { var fr = v - Math.floor(v); return (fr > 0.28 && fr < 0.36) || (fr > 0.64 && fr < 0.72) ? 1.55 : ((u * 3) % 1 < 0.22 ? 0.62 : 0.86); }
      return 0.8 + hf * 0.32 + f * 0.1 + (hf > 0.74 ? 0.12 : 0);             // осыпь, гравий, пепел
    }
    // высота с чёткими уступами: уровни плато сжаты к краю, остальное — плавно
    function hgt(u, v) {
      var e1 = bl(EL, u, v), k = Math.floor(e1), fr = e1 - k;
      return k + smooth((fr - 0.5) * 3.2 + 0.5) + bl(ER, u, v);
    }
    var eps = 0.22, kz = 1.1 / (2 * eps);
    var p = 0;
    for (var py = 0; py < H2; py++) {
      var v = y0 + (py + 0.5) * inv;
      for (var px = 0; px < W2; px++, p += 4) {
        var u = x0 + (px + 0.5) * inv;
        // шум: n0..n2 — средний масштаб, f — около клетки, hf — мельче клетки (трава, крошка)
        var n0 = nz(N0, u * 9, v * 9), n1 = nz(N1, u * 4.5, v * 4.5), n2 = nz(N2, u * 14, v * 14), f = nz(N2, u * 61, v * 61), hf = nz(N1, u * 230, v * 230), gr = nz(N0, u * 620, v * 620);
        // рваные края: смещение выборки масок
        var dx = (nz(N1, u * 38, v * 38) - 0.5) * 0.55 + (n1 - 0.5) * 0.5, dy = (nz(N0, u * 38 + 77, v * 38 + 13) - 0.5) * 0.55 + (nz(N0, u * 4.5 + 91, v * 4.5 + 37) - 0.5) * 0.5;
        var su = u + dx, sv = v + dy;
        var col = gfn(C, u, v, n0, n1, n2, f, hf);
        // круглая платформа: насколько точка внутри (kps > 0 — на палубе); палуба — кольца панелей от центра
        kpo = null; kps = -9; kpl = null;
        if (KPI) {
          kpl = KPI[Math.min(N - 1, Math.max(0, Math.floor(v))) * N + Math.min(N - 1, Math.max(0, Math.floor(u)))];
          if (kpl) for (var qi = 0; qi < kpl.length; qi++) { var ko = KP[kpl[qi]], ks = ko.r - Math.sqrt((u - ko.x) * (u - ko.x) + (v - ko.y) * (v - ko.y)); if (ks > kps) { kps = ks; kpo = ko; } }
        }
        if (KD && v > KD.y - 2.4 && v - KD.y > kps) { kps = v - KD.y; kpo = KD; }
        if (kpo && kps > 0) {
          if (kpo === KD) { var dl = kps < 0.06 ? 0.62 : kps < 0.5 ? 1.13 : kps < 0.62 ? 0.84 : 1; col = [col[0] * dl, col[1] * dl, col[2] * dl]; }
          else col = deckCol(C, kpo, u, v, kps, n0, f);
        }
        var r = col[0], g = col[1], b = col[2], t, w, k2;
        // трудная земля
        w = bl(R, su, sv);
        if (w > 0.12) {
          t = smooth((w - 0.2) / 0.45) * (0.45 + 0.4 * smooth((n2 - 0.25) / 0.5));
          var w1 = bl(R1, su, sv) / Math.max(0.01, w);
          k2 = rough(w1 > 0.5 ? rs1 : rs0, C.rough, u, v, n1, n2, f, hf);
          r += (C.rough[0] * k2 - r) * t; g += (C.rough[1] * k2 - g) * t; b += (C.rough[2] * k2 - b) * t;
        }
        // заросли
        w = bl(Lf, su, sv);
        if (w > TH - 0.12) {
          t = smooth((w - TH) * TW + 0.5);
          var m1 = smooth((bl(L1, su, sv) / Math.max(0.01, w) - 0.35) / 0.3);
          var lc = m1 < 1 ? lightCol(ls0, C, 0, r, g, b, u, v, n2, f, hf, glow, oa) : null;
          if (m1 > 0) { var lc1 = lightCol(ls1, C, 1, r, g, b, u, v, n2, f, hf, glow, ob); lc = lc ? [lc[0] + (lc1[0] - lc[0]) * m1, lc[1] + (lc1[1] - lc[1]) * m1, lc[2] + (lc1[2] - lc[2]) * m1] : lc1; }
          r += (lc[0] - r) * t; g += (lc[1] - g) * t; b += (lc[2] - b) * t;
        }
        // дороги — края почти ровные
        w = bl(D, u + dx * 0.25, v + dy * 0.25);
        if (w > TH - 0.12) {
          t = smooth((w - TH) * TW + 0.5);
          var dc = C.road, dk, pcell = Mm[(v | 0) * N + (u | 0)] === 17;
          if (pcell) { var pq = (Math.floor(u * 2) + Math.floor(v * 2)) & 1; dk = ((u * 2) % 1 < 0.06 || (v * 2) % 1 < 0.06 ? 0.86 : 1.06) * (0.98 + pq * 0.05 + f * 0.04); }
          else if (roadStyle === 'trail') dk = 0.88 + n2 * 0.2 + (hf - 0.5) * 0.12;
          else if (roadStyle === 'paved' || roadStyle === 'stone') { var sq = (Math.floor(u * 2) + Math.floor(v * 2)) & 1; dk = ((u * 2) % 1 < 0.05 || (v * 2) % 1 < 0.05 ? 0.84 : 1) * (0.95 + sq * 0.04 + f * 0.05); }
          else if (roadStyle === 'walkway' || roadStyle === 'metal') { var gx = (u * 4) % 1, gy = (v * 4) % 1; dk = gx < 0.1 || gy < 0.1 ? 0.76 : 1.02; }
          else if (roadStyle === 'avenue' || roadStyle === 'asphalt') dk = 0.9 + f * 0.1 - Math.max(0, n0 - 0.62) * 0.4 + (hf - 0.5) * 0.06;
          else dk = 0.92 + f * 0.1 + (hf - 0.5) * 0.14;
          r += (dc[0] * dk - r) * t; g += (dc[1] * dk - g) * t; b += (dc[2] * dk - b) * t;
        }
        // скалы: слои, трещины, крошка
        w = bl(B, su, sv);
        if (w > TH - 0.12) {
          t = smooth((w - TH) * TW + 0.5);
          var hh = bl(EL, u, v) + bl(ER, u, v), strata = 0.86 + (Math.sin(hh * 8 + n1 * 5 + n2 * 2) * 0.5 + 0.5) * 0.16;
          var rc2 = mixc(rockA, rockB, Math.min(1, Math.max(0, (hh - 1) / 2.6 + (n2 - 0.5) * 0.5)));
          var rg = 1 - Math.abs(nz(N0, u * 16 + 7, v * 16) * 2 - 1), crack = rg > 0.95 && n2 > 0.5 ? 0.82 : 1;
          var rk = strata * crack * (0.86 + f * 0.16 + (hf - 0.5) * 0.18);
          r += (rc2[0] * rk - r) * t; g += (rc2[1] * rk - g) * t; b += (rc2[2] * rk - b) * t;
        }
        var ci = Math.min(N - 1, Math.max(0, Math.floor(v))) * N + Math.min(N - 1, Math.max(0, Math.floor(u)));
        // высота: выше — светлее и ближе к цвету камня, ниже — темнее
        var el = bl(EL, su, sv) - base;
        if (el > 0.05) { var ht = Math.min(1, el) * highTint; r += (rockB[0] * 0.9 - r) * ht; g += (rockB[1] * 0.9 - g) * ht; b += (rockB[2] * 0.9 - b) * ht; var hk = 1 + el * 0.05; r *= hk; g *= hk; b *= hk; }
        else if (el < -0.05) { var lk2 = 1 + el * 0.07; r *= lk2; g *= lk2 * 0.99; b *= lk2 * 0.97; }
        // освещение рельефа
        var ex = hgt(su + eps, sv) - hgt(su - eps, sv), ey = hgt(su, sv + eps) - hgt(su, sv - eps);
        if (kpo && kps > -0.2) { ex = 0; ey = 0; }                          // палуба ровная, без бугров
        var nx = -ex * kz, ny = -ey * kz, nl = (nx * LX + ny * LY + LZ) / Math.sqrt(nx * nx + ny * ny + 1);
        var sh = Math.max(0.5, Math.min(1.32, 0.4 + 0.6 * nl / LZ));
        var lit = sh * (1 - 0.32 * bl(S, su, sv) - bl(AO, su, sv) * 0.45) * (0.94 + gr * 0.12);
        r *= lit; g *= lit; b *= lit;
        // вода
        var wv = bl(W, su, sv);
        if (kpo && kps > -2.4) {
          // у платформы вода и суша — по окружности, без рваного края; дальше — как было
          var kw = kps > -1.4 ? 1 : (kps + 2.4);
          wv += (smooth(0.5 - kps / 0.12) - wv) * kw;
        }
        if (wv > TH - 0.12) {
          t = smooth((wv - TH) * TW + 0.5);
          var dep = bl(WD, u, v), fd = bl(F, su, sv), dt = Math.max(0, Math.min(1, (dep - 0.6) / (ocean ? 5 : 2.2))) * (1 - fd * 0.8);
          var wc2 = mixc(C.water[1], C.water[0], smooth(dt));
          var wave = 1 + (nz(N1, u * 9 + v * 3, v * 9) - 0.5) * (ocean ? 0.34 : 0.18) + (nz(N2, u * 30, v * 30) - 0.5) * 0.08;
          var foam = !ocean && wv < TH + 0.1 ? Math.max(0, 1 - (wv - TH + 0.02) * 10) * (0.5 + hf * 0.6) : 0;
          var spec = Math.max(0, nz(N0, u * 12 + 5, v * 12) - 0.66) * 1.4;
          var wl = 0.72 + 0.28 * (1 - 0.32 * bl(S, u, v));
          if ((kpl || KD) && kps < 0) {
            // тень платформы на воде (свет с северо-запада) и светлая кайма у свай
            var shd = KD ? v + LY * 1.1 - KD.y : -9;
            if (kpl) for (var qj = 0; qj < kpl.length; qj++) { var so = KP[kpl[qj]], sx2 = u + LX * 1.1 - so.x, sy2 = v + LY * 1.1 - so.y, s2 = so.r - Math.sqrt(sx2 * sx2 + sy2 * sy2); if (s2 > shd) shd = s2; }
            if (shd > -0.4) wl *= 1 - 0.36 * smooth((shd + 0.4) / 0.8);
            if (kps > -0.35) wl *= 1 + 0.18 * smooth(1 + kps / 0.35);
          }
          var wr = (wc2[0] * wave + 255 * spec * 0.22) * wl, wg = (wc2[1] * wave + 255 * spec * 0.26) * wl, wb = (wc2[2] * wave + 255 * spec * 0.3) * wl;
          wr += (235 - wr) * foam * 0.6; wg += (245 - wg) * foam * 0.6; wb += (250 - wb) * foam * 0.6;
          r += (wr - r) * t; g += (wg - g) * t; b += (wb - b) * t;
        }
        // пропасти и лава
        var vv = bl(V, su, sv);
        if (vv > TH - 0.12) {
          t = smooth((vv - TH) * TW + 0.5);
          var vd = bl(VD, u, v), vr, vg, vb;
          if (voidKind === 'lava') {
            var crust = nz(N1, u * 6 + 33, v * 6), core = Math.min(1, (vd - 0.4) / 2.2);
            var lc2 = mixc(C.voidc[0], C.voidc[1], core * 0.8 + 0.2);
            if (crust > 0.52) lc2 = mixc(lc2, [38, 16, 10], Math.min(1, (crust - 0.52) * 3.2) * (0.6 + hf * 0.4));
            if (vd < 1.6) lc2 = mixc(lc2, [70, 22, 10], (1.6 - vd) * 0.45);
            if (n2 > 0.68 && crust < 0.55) lc2 = mixc(lc2, C.voidc[2] || [255, 220, 120], (n2 - 0.68) * 2.4);
            vr = lc2[0]; vg = lc2[1]; vb = lc2[2];
          } else {
            // стены уходят вниз: у края светлее (камень), дальше — темнота
            var depth = Math.min(1, (vd - 0.5) / (voidKind === 'crevasse' ? 1.6 : 3));
            var wallc = voidKind === 'crevasse' ? C.voidc[1] : mixc(rockA, C.voidc[1], 0.45);
            var band = voidKind === 'sinkhole' ? 0.84 + Math.sin(vd * 5 + n1 * 3) * 0.16 : 0.88 + n2 * 0.2 + (hf - 0.5) * 0.1;
            var vc = mixc(wallc, C.voidc[0], smooth(depth));
            vr = vc[0] * band; vg = vc[1] * band; vb = vc[2] * band;
          }
          r += (vr - r) * t; g += (vg - g) * t; b += (vb - b) * t;
        }
        if (GL) {
          var gl = bl(GL, u, v);
          if (gl > 0) { r += 210 * gl * 0.5; g += 72 * gl * 0.5; b += 20 * gl * 0.35; }
        }
        d[p] = r > 255 ? 255 : r < 0 ? 0 : r;
        d[p + 1] = g > 255 ? 255 : g < 0 ? 0 : g;
        d[p + 2] = b > 255 ? 255 : b < 0 ? 0 : b;
        d[p + 3] = 255;
      }
    }
  };

  // ---------------------------------------------------------------- предметы
  // Тень предмета: тот же контур, сдвинутый от света
  function shadowOf(ctx, path, dx, dy, a) {
    ctx.save(); ctx.translate(dx, dy); ctx.fillStyle = 'rgba(0,0,0,' + a + ')'; path(); ctx.fill(); ctx.restore();
  }
  function blobPath(ctx, cx, cy, r, n, jit, seed) {
    ctx.beginPath();
    for (var i = 0; i <= n; i++) {
      var a = i / n * TAU, rr = r * (1 - jit + jit * 2 * hash(i % n, seed, 13));
      var x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
  }
  function radial(ctx, cx, cy, r, c, kHi, kLo) {
    var gr = ctx.createRadialGradient(cx - r * 0.4, cy - r * 0.45, r * 0.05, cx, cy, r * 1.1);
    gr.addColorStop(0, css(c, kHi)); gr.addColorStop(1, css(c, kLo));
    return gr;
  }
  function same(T, x, y, code, m) {
    var N = T.N;
    if (x < 0 || y < 0 || x >= N || y >= N) return false;
    var k = y * N + x;
    return T.map.t[k] === code && (m == null || T.map.m[k] === m);
  }

  // Мелкие укрытия — по виду клетки
  var COVER = {
    boulder: function(ctx, T, x, y, hsh, det) {
      var cx = x + 0.5 + (hsh - 0.5) * 0.2, cy = y + 0.5 + (hash(x, y, 4) - 0.5) * 0.2, r = 0.36 + hash(x, y, 5) * 0.12;
      var c = mixc(T.C.rock[0], T.C.rock[1], hash(x, y, 6) * 0.6);
      var p = function() { blobPath(ctx, cx, cy, r, 7, 0.22, x * 31 + y); };
      shadowOf(ctx, p, 0.12, 0.14, 0.38);
      p(); ctx.fillStyle = radial(ctx, cx, cy, r, c, 1.25, 0.62); ctx.fill();
      if (det) { ctx.strokeStyle = css(c, 0.45, 0.7); ctx.lineWidth = 0.03; ctx.stroke(); }
    },
    obsidian: function(ctx, T, x, y, hsh, det) {
      var cx = x + 0.5, cy = y + 0.5, r = 0.4;
      var p = function() { blobPath(ctx, cx, cy, r, 6, 0.28, x * 17 + y); };
      shadowOf(ctx, p, 0.1, 0.12, 0.45);
      p(); ctx.fillStyle = radial(ctx, cx, cy, r, [40, 30, 32], 1.6, 0.5); ctx.fill();
      ctx.strokeStyle = 'rgba(255,120,40,0.45)'; ctx.lineWidth = 0.04; ctx.stroke();
    },
    icecrystal: function(ctx, T, x, y, hsh) { crystals(ctx, x, y, [190, 220, 255], 3, 0.5, false); },
    crystal: function(ctx, T, x, y, hsh) { crystals(ctx, x, y, [120, 210, 255], 4 + Math.floor(hsh * 2), 0.62, true); },
    crystalsmall: function(ctx, T, x, y, hsh) { crystals(ctx, x, y, [150, 225, 255], 2, 0.42, true); },
    tree: function(ctx, T, x, y, hsh) {
      var cx = x + 0.5, cy = y + 0.5, r = 0.55 + hsh * 0.18, c = T.look.style === 'grass' || T.look.style === 'lawn' ? mixc(T.C.light[1] || T.C.light[0], [30, 60, 25], 0.3) : T.C.light[1] || T.C.light[0];
      if (T.id === 'raxus') c = [90, 50, 120];
      var p = function() { blobPath(ctx, cx, cy, r, 9, 0.16, x * 7 + y * 3); };
      shadowOf(ctx, p, 0.22, 0.26, 0.4);
      p(); ctx.fillStyle = radial(ctx, cx, cy, r, c, 1.5, 0.7); ctx.fill();
      for (var i = 0; i < 4; i++) {
        var a = hash(x, y, 20 + i) * TAU, d = r * 0.45;
        ctx.beginPath(); ctx.arc(cx + Math.cos(a) * d - 0.05, cy + Math.sin(a) * d - 0.05, r * 0.32, 0, TAU);
        ctx.fillStyle = css(c, 1.35, 0.55); ctx.fill();
      }
    },
    fence: function(ctx, T, x, y) { linked(ctx, T, x, y, TT.COVER, T.map.m[y * T.N + x], 0.24, mixc(T.C.rock[0], T.C.rock[1], 0.5), 'stones'); },
    hedge: function(ctx, T, x, y) { linked(ctx, T, x, y, TT.COVER, T.map.m[y * T.N + x], 0.62, rgb(T.look.hedge || '#2c5c28'), 'hedge'); },
    balustrade: function(ctx, T, x, y) { linked(ctx, T, x, y, TT.COVER, T.map.m[y * T.N + x], 0.22, T.C.rock[1], 'rail'); },
    chainfence: function(ctx, T, x, y) { linked(ctx, T, x, y, TT.COVER, T.map.m[y * T.N + x], 0.08, [150, 150, 146], 'rail'); },
    railing: function(ctx, T, x, y) { linked(ctx, T, x, y, TT.COVER, T.map.m[y * T.N + x], 0.12, [190, 200, 205], 'rail'); },
    conveyor: function(ctx, T, x, y) { linked(ctx, T, x, y, TT.COVER, T.map.m[y * T.N + x], 0.5, [70, 66, 62], 'belt'); },
    pipe: function(ctx, T, x, y) { linked(ctx, T, x, y, TT.COVER, T.map.m[y * T.N + x], 0.4, [90, 82, 78], 'pipe'); },
    log: function(ctx, T, x, y) { linked(ctx, T, x, y, TT.COVER, T.map.m[y * T.N + x], 0.62, rgb((T.look.bark || ['#5a4430'])[0]), 'log'); },
    container: function(ctx, T, x, y, hsh) {
      var pal = [[150, 64, 42], [52, 92, 132], [188, 150, 60], [96, 104, 104], [70, 110, 80]];
      var c = pal[Math.floor(hash(x >> 1, y, 2) * pal.length)];
      var horiz = same(T, x - 1, y, TT.COVER) || same(T, x + 1, y, TT.COVER);
      var w = horiz ? 0.96 : 0.62, h = horiz ? 0.62 : 0.96, cx = x + 0.5, cy = y + 0.5;
      ctx.fillStyle = 'rgba(0,0,0,0.42)'; ctx.fillRect(cx - w / 2 + 0.12, cy - h / 2 + 0.14, w, h);
      var gr = ctx.createLinearGradient(cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2);
      gr.addColorStop(0, css(c, 1.2)); gr.addColorStop(1, css(c, 0.75));
      ctx.fillStyle = gr; ctx.fillRect(cx - w / 2, cy - h / 2, w, h);
      ctx.strokeStyle = css(c, 0.55, 0.8); ctx.lineWidth = 0.025;
      for (var i = 1; i < 6; i++) {
        ctx.beginPath();
        if (horiz) { ctx.moveTo(cx - w / 2 + w * i / 6, cy - h / 2); ctx.lineTo(cx - w / 2 + w * i / 6, cy + h / 2); }
        else { ctx.moveTo(cx - w / 2, cy - h / 2 + h * i / 6); ctx.lineTo(cx + w / 2, cy - h / 2 + h * i / 6); }
        ctx.stroke();
      }
      ctx.strokeRect(cx - w / 2, cy - h / 2, w, h);
    },
    crate: function(ctx, T, x, y, hsh) {
      var s = 0.5 + hsh * 0.14, cx = x + 0.5 + (hsh - 0.5) * 0.2, cy = y + 0.5, c = [140, 110, 70];
      ctx.save(); ctx.translate(cx, cy); ctx.rotate((hsh - 0.5) * 0.6);
      ctx.fillStyle = 'rgba(0,0,0,0.4)'; ctx.fillRect(-s / 2 + 0.08, -s / 2 + 0.1, s, s);
      ctx.fillStyle = css(c); ctx.fillRect(-s / 2, -s / 2, s, s);
      ctx.strokeStyle = css(c, 0.6); ctx.lineWidth = 0.04; ctx.strokeRect(-s / 2, -s / 2, s, s);
      ctx.beginPath(); ctx.moveTo(-s / 2, -s / 2); ctx.lineTo(s / 2, s / 2); ctx.moveTo(s / 2, -s / 2); ctx.lineTo(-s / 2, s / 2); ctx.stroke();
      ctx.restore();
    },
    module: function(ctx, T, x, y, hsh) {
      var horiz = hsh < 0.5, w = horiz ? 0.92 : 0.58, h = horiz ? 0.58 : 0.92, cx = x + 0.5, cy = y + 0.5;
      ctx.fillStyle = 'rgba(0,0,0,0.38)'; rrect(ctx, cx - w / 2 + 0.1, cy - h / 2 + 0.12, w, h, 0.1); ctx.fill();
      var gr = ctx.createLinearGradient(cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2);
      gr.addColorStop(0, '#eef3f5'); gr.addColorStop(1, '#a8b2b8');
      ctx.fillStyle = gr; rrect(ctx, cx - w / 2, cy - h / 2, w, h, 0.1); ctx.fill();
      ctx.fillStyle = 'rgba(80,190,240,0.75)';
      if (horiz) ctx.fillRect(cx - w / 2 + 0.08, cy - 0.04, w - 0.16, 0.08); else ctx.fillRect(cx - 0.04, cy - h / 2 + 0.08, 0.08, h - 0.16);
    },
    tankwreck: function(ctx, T, x, y, hsh) {
      var cx = x + 0.5, cy = y + 0.5, a = hsh * TAU;
      ctx.save(); ctx.translate(cx, cy); ctx.rotate(a);
      ctx.fillStyle = 'rgba(0,0,0,0.4)'; ctx.fillRect(-0.4 + 0.1, -0.28 + 0.12, 0.8, 0.56);
      ctx.fillStyle = '#4f4b45'; ctx.fillRect(-0.4, -0.28, 0.8, 0.56);
      ctx.fillStyle = '#3a3733'; ctx.fillRect(-0.44, -0.32, 0.88, 0.1); ctx.fillRect(-0.44, 0.22, 0.88, 0.1);
      ctx.beginPath(); ctx.arc(0.02, 0, 0.17, 0, TAU); ctx.fillStyle = '#5c5750'; ctx.fill();
      ctx.strokeStyle = '#2a2724'; ctx.lineWidth = 0.07; ctx.beginPath(); ctx.moveTo(0.1, 0); ctx.lineTo(0.5, 0.05); ctx.stroke();
      ctx.fillStyle = 'rgba(20,16,12,0.5)'; ctx.beginPath(); ctx.arc(-0.15, 0.08, 0.16, 0, TAU); ctx.fill();
      ctx.restore();
    },
    ruin: function(ctx, T, x, y, hsh) {
      var cx = x + 0.5, cy = y + 0.5, c = mixc(T.C.rock[0], T.C.rock[1], 0.4);
      ctx.save(); ctx.translate(cx, cy); ctx.rotate(Math.floor(hsh * 4) * Math.PI / 2);
      ctx.fillStyle = 'rgba(0,0,0,0.4)'; ctx.fillRect(-0.4 + 0.1, -0.4 + 0.12, 0.8, 0.22); ctx.fillRect(-0.4 + 0.1, -0.4 + 0.12, 0.22, 0.7);
      ctx.fillStyle = css(c, 1.05); ctx.fillRect(-0.4, -0.4, 0.8, 0.22); ctx.fillRect(-0.4, -0.4, 0.22, 0.7);
      ctx.fillStyle = css(c, 1.3); ctx.fillRect(-0.4, -0.4, 0.8, 0.05);
      ctx.restore();
    },
    debris: function(ctx, T, x, y, hsh) {
      var c = T.look.metal ? rgb(T.look.metal[0]) : [110, 104, 96];
      for (var i = 0; i < 3; i++) {
        var a = hash(x, y, 40 + i) * TAU, cx = x + 0.3 + hash(x, y, 50 + i) * 0.4, cy = y + 0.3 + hash(x, y, 60 + i) * 0.4;
        ctx.save(); ctx.translate(cx, cy); ctx.rotate(a);
        ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.fillRect(-0.18 + 0.06, -0.07 + 0.07, 0.36, 0.14);
        ctx.fillStyle = css(c, 0.8 + hash(x, y, 70 + i) * 0.5); ctx.fillRect(-0.18, -0.07, 0.36, 0.14);
        ctx.restore();
      }
    },
    speeder: function(ctx, T, x, y, hsh) {
      var cx = x + 0.5, cy = y + 0.5, a = hsh < 0.5 ? 0 : Math.PI / 2, pal = [[180, 60, 50], [210, 190, 90], [70, 110, 170], [200, 200, 205]];
      var c = pal[Math.floor(hsh * 7) % pal.length];
      ctx.save(); ctx.translate(cx, cy); ctx.rotate(a);
      ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.beginPath(); ctx.ellipse(0.1, 0.12, 0.42, 0.22, 0, 0, TAU); ctx.fill();
      ctx.beginPath(); ctx.ellipse(0, 0, 0.42, 0.22, 0, 0, TAU); ctx.fillStyle = radial(ctx, 0, 0, 0.42, c, 1.3, 0.7); ctx.fill();
      ctx.beginPath(); ctx.ellipse(0.08, 0, 0.14, 0.12, 0, 0, TAU); ctx.fillStyle = 'rgba(120,180,220,0.85)'; ctx.fill();
      ctx.restore();
    },
    barrier: function(ctx, T, x, y) { linked(ctx, T, x, y, TT.COVER, T.map.m[y * T.N + x], 0.3, [170, 162, 150], 'block'); },
    // стена города: по облику планеты (камень, металл, дерево, улей, кристалл, лёд); парапет и зубцы
    wall: function(ctx, T, x, y, hsh, det) {
      var lk = T.tlook, kind = lk.wall, col = wallColor(lk, T);
      // тень на юго-восток, корпус во всю клетку, дорожка по гребню, зубцы по углам
      ctx.fillStyle = 'rgba(0,0,0,0.45)'; ctx.fillRect(x + 0.2, y + 0.25, 1, 1);
      ctx.fillStyle = css(col, 0.62); ctx.fillRect(x, y, 1, 1);
      ctx.fillStyle = css(col, 0.98); ctx.fillRect(x, y, 0.86, 0.86);
      if (kind === 'hive') { ctx.fillStyle = css(col, 1.2); ctx.beginPath(); ctx.arc(x + 0.5, y + 0.45, 0.34, 0, TAU); ctx.fill(); ctx.fillStyle = css(col, 0.7); ctx.beginPath(); ctx.arc(x + 0.5 + (hsh - 0.5) * 0.2, y + 0.45, 0.1, 0, TAU); ctx.fill(); return; }
      if (kind === 'wood') { ctx.strokeStyle = css(col, 0.6, 0.7); ctx.lineWidth = 0.03; for (var q = 0.2; q < 1; q += 0.2) { ctx.beginPath(); ctx.moveTo(x + q, y); ctx.lineTo(x + q, y + 0.88); ctx.stroke(); } }
      ctx.fillStyle = css(col, 1.22); ctx.fillRect(x + 0.26, y + 0.26, 0.36, 0.36);
      ctx.fillStyle = css(col, kind === 'crystal' || kind === 'ice' ? 1.5 : 1.3);
      ctx.fillRect(x + 0.04, y + 0.04, 0.24, 0.24); ctx.fillRect(x + 0.6, y + 0.04, 0.24, 0.24); ctx.fillRect(x + 0.04, y + 0.6, 0.24, 0.24); ctx.fillRect(x + 0.6, y + 0.6, 0.24, 0.24);
      if (kind === 'metal' && det) { ctx.fillStyle = 'rgba(255,214,130,0.8)'; if (hsh < 0.3) ctx.fillRect(x + 0.42, y + 0.42, 0.06, 0.06); }
    },
    palisade: function(ctx, T, x, y, hsh) {
      var lk = T.tlook, m = T.map.m[y * T.N + x], col = lk.wall === 'metal' || lk.wall === 'ice' || lk.wall === 'crystal' ? [128, 130, 134] : [120, 88, 56];
      linked(ctx, T, x, y, TT.COVER, m, 0.42, col, 'log');
      ctx.fillStyle = css(col, 1.3); ctx.beginPath(); ctx.arc(x + 0.5, y + 0.5, 0.16, 0, TAU); ctx.fill();
    },
    // торговый лоток: навес в полоску
    stall: function(ctx, T, x, y, hsh) {
      var cx = x + 0.5, cy = y + 0.5, hor = hsh < 0.5, w = hor ? 0.8 : 0.5, h = hor ? 0.5 : 0.8;
      var pal = [[200, 70, 60], [60, 110, 180], [210, 160, 50], [70, 140, 90]], c = pal[Math.floor(hash(x, y, 11) * pal.length)];
      ctx.fillStyle = 'rgba(0,0,0,0.38)'; ctx.fillRect(cx - w / 2 + 0.1, cy - h / 2 + 0.13, w, h);
      ctx.fillStyle = css(c, 1.05); ctx.fillRect(cx - w / 2, cy - h / 2, w, h);
      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      for (var i = 0; i < 4; i++) { if (hor) ctx.fillRect(cx - w / 2 + i * w / 4 + w / 16, cy - h / 2, w / 8, h); else ctx.fillRect(cx - w / 2, cy - h / 2 + i * h / 4 + h / 16, w, h / 8); }
      ctx.strokeStyle = 'rgba(40,30,20,0.6)'; ctx.lineWidth = 0.03; ctx.strokeRect(cx - w / 2, cy - h / 2, w, h);
    },
    planterbox: function(ctx, T, x, y) {
      ctx.fillStyle = 'rgba(0,0,0,0.38)'; ctx.fillRect(x + 0.18, y + 0.2, 0.7, 0.7);
      ctx.fillStyle = '#8a8070'; ctx.fillRect(x + 0.12, y + 0.12, 0.76, 0.76);
      ctx.fillStyle = radial(ctx, x + 0.5, y + 0.5, 0.3, [70, 120, 60], 1.3, 0.7); ctx.beginPath(); ctx.arc(x + 0.5, y + 0.5, 0.3, 0, TAU); ctx.fill();
    },
    oretruck: function(ctx, T, x, y, hsh) {
      var cx = x + 0.5, cy = y + 0.5;
      ctx.save(); ctx.translate(cx, cy); ctx.rotate(Math.floor(hsh * 4) * Math.PI / 2);
      ctx.fillStyle = 'rgba(0,0,0,0.42)'; ctx.fillRect(-0.44 + 0.1, -0.3 + 0.12, 0.88, 0.6);
      ctx.fillStyle = '#b08a3a'; ctx.fillRect(-0.44, -0.3, 0.6, 0.6);
      ctx.fillStyle = '#6a5a4a'; ctx.fillRect(-0.4, -0.24, 0.52, 0.48);
      ctx.fillStyle = '#9a6a3a'; ctx.beginPath(); ctx.arc(-0.14, 0, 0.17, 0, TAU); ctx.fill();
      ctx.fillStyle = '#c8a050'; ctx.fillRect(0.18, -0.26, 0.26, 0.52);
      ctx.fillStyle = 'rgba(140,200,230,0.8)'; ctx.fillRect(0.34, -0.2, 0.07, 0.4);
      ctx.restore();
    },
    stump: function(ctx, T, x, y, hsh) {
      var cx = x + 0.5, cy = y + 0.5, r = 0.32 + hsh * 0.1, c = rgb((T.look.bark || ['#5a4430'])[0]);
      ctx.fillStyle = 'rgba(0,0,0,0.38)'; ctx.beginPath(); ctx.arc(cx + 0.1, cy + 0.12, r, 0, TAU); ctx.fill();
      ctx.fillStyle = css(c); ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.fill();
      ctx.strokeStyle = css(c, 1.5, 0.6); ctx.lineWidth = 0.03;
      for (var i = 1; i < 4; i++) { ctx.beginPath(); ctx.arc(cx, cy, r * i / 4, 0, TAU); ctx.stroke(); }
    },
    column: function(ctx, T, x, y, hsh) {
      var cx = x + 0.5, cy = y + 0.5, c = rgb(T.look.stone || '#d8d0b8');
      if (hsh < 0.25) {        // упавшая
        ctx.save(); ctx.translate(cx, cy); ctx.rotate(hsh * 8);
        ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.fillRect(-0.45 + 0.06, -0.16 + 0.08, 0.9, 0.32);
        ctx.fillStyle = css(c, 0.95); ctx.fillRect(-0.45, -0.16, 0.9, 0.32);
        ctx.restore(); return;
      }
      ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.beginPath(); ctx.arc(cx + 0.22, cy + 0.26, 0.3, 0, TAU); ctx.fill();
      ctx.fillStyle = css(c, 0.8); ctx.fillRect(cx - 0.36, cy - 0.36, 0.72, 0.72);
      ctx.beginPath(); ctx.arc(cx, cy, 0.28, 0, TAU); ctx.fillStyle = radial(ctx, cx, cy, 0.28, c, 1.15, 0.8); ctx.fill();
      ctx.strokeStyle = css(c, 0.7, 0.6); ctx.lineWidth = 0.02;
      for (var i = 0; i < 8; i++) { var a = i / 8 * TAU; ctx.beginPath(); ctx.moveTo(cx + Math.cos(a) * 0.12, cy + Math.sin(a) * 0.12); ctx.lineTo(cx + Math.cos(a) * 0.27, cy + Math.sin(a) * 0.27); ctx.stroke(); }
    },
    statue: function(ctx, T, x, y, hsh) {
      var cx = x + 0.5, cy = y + 0.5, c = rgb(T.look.stone || '#d0c8e0');
      ctx.fillStyle = 'rgba(0,0,0,0.4)'; ctx.fillRect(cx - 0.34 + 0.16, cy - 0.34 + 0.2, 0.68, 0.68);
      ctx.fillStyle = css(c, 0.75); ctx.fillRect(cx - 0.36, cy - 0.36, 0.72, 0.72);
      ctx.fillStyle = css(c, 0.9); ctx.fillRect(cx - 0.28, cy - 0.28, 0.56, 0.56);
      ctx.beginPath(); ctx.ellipse(cx, cy, 0.2, 0.13, 0, 0, TAU); ctx.fillStyle = radial(ctx, cx, cy, 0.2, c, 1.25, 0.8); ctx.fill();
      ctx.beginPath(); ctx.arc(cx, cy - 0.02, 0.08, 0, TAU); ctx.fillStyle = css(c, 1.3); ctx.fill();
    },
    stele: function(ctx, T, x, y, hsh) {
      var cx = x + 0.5, cy = y + 0.5, c = T.C.rock[1];
      ctx.fillStyle = 'rgba(0,0,0,0.42)'; ctx.fillRect(cx - 0.18 + 0.3, cy - 0.32 + 0.34, 0.36, 0.64);
      ctx.fillStyle = css(c, 0.9); ctx.fillRect(cx - 0.18, cy - 0.32, 0.36, 0.64);
      ctx.fillStyle = css(c, 1.15); ctx.fillRect(cx - 0.18, cy - 0.32, 0.36, 0.08);
    },
    rockfin: function(ctx, T, x, y, hsh) {
      var cx = x + 0.5, cy = y + 0.5, a = hsh * Math.PI, c = mixc(T.C.rock[0], T.C.rock[1], 0.4);
      ctx.save(); ctx.translate(cx, cy); ctx.rotate(a);
      var p = function() { ctx.beginPath(); ctx.moveTo(-0.5, 0); ctx.lineTo(-0.1, -0.2); ctx.lineTo(0.5, -0.04); ctx.lineTo(0.2, 0.18); ctx.closePath(); };
      shadowOf(ctx, p, 0.12, 0.14, 0.4);
      p(); ctx.fillStyle = radial(ctx, 0, 0, 0.5, c, 1.25, 0.65); ctx.fill();
      ctx.restore();
    },
    pod: function(ctx, T, x, y, hsh) {
      var cx = x + 0.5, cy = y + 0.5, g = T.look.glow ? rgb(T.look.glow[Math.floor(hsh * 3) % 3]) : [200, 120, 255];
      var gr = ctx.createRadialGradient(cx, cy, 0, cx, cy, 0.7);
      gr.addColorStop(0, css(g, 1, 0.45)); gr.addColorStop(1, css(g, 1, 0));
      ctx.fillStyle = gr; ctx.fillRect(x - 0.3, y - 0.3, 1.6, 1.6);
      ctx.beginPath(); ctx.arc(cx, cy, 0.24, 0, TAU); ctx.fillStyle = radial(ctx, cx, cy, 0.24, g, 1.6, 0.6); ctx.fill();
    },
    fountain: function() {}            // рисуется целиком из objs
  };
  COVER.planter = COVER.planterbox;

  function rrect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y); ctx.closePath();
  }
  function crystals(ctx, x, y, c, n, size, glow) {
    var cx = x + 0.5, cy = y + 0.5;
    if (glow) {
      var gr = ctx.createRadialGradient(cx, cy, 0, cx, cy, size * 1.3);
      gr.addColorStop(0, css(c, 1, 0.3)); gr.addColorStop(1, css(c, 1, 0));
      ctx.fillStyle = gr; ctx.fillRect(cx - size * 1.3, cy - size * 1.3, size * 2.6, size * 2.6);
    }
    for (var i = 0; i < n; i++) {
      var a = -2.3 + (hash(x, y, 80 + i) - 0.5) * 2.4, L = size * (0.55 + hash(x, y, 90 + i) * 0.5), w = L * 0.22;
      var ox = (hash(x, y, 100 + i) - 0.5) * 0.3, oy = (hash(x, y, 110 + i) - 0.5) * 0.3;
      ctx.save(); ctx.translate(cx + ox, cy + oy); ctx.rotate(a);
      ctx.fillStyle = 'rgba(0,0,30,0.3)';
      ctx.beginPath(); ctx.moveTo(0.08, 0.1); ctx.lineTo(L + 0.08, 0.1); ctx.lineTo(L * 0.8 + 0.08, w + 0.1); ctx.lineTo(0.08, w + 0.1); ctx.fill();
      ctx.beginPath(); ctx.moveTo(0, -w); ctx.lineTo(L * 0.82, -w); ctx.lineTo(L, 0); ctx.lineTo(L * 0.82, w); ctx.lineTo(0, w); ctx.closePath();
      var g2 = ctx.createLinearGradient(0, -w, 0, w);
      g2.addColorStop(0, css(c, 1.45)); g2.addColorStop(0.5, css(c, 1.05)); g2.addColorStop(1, css(c, 0.6));
      ctx.fillStyle = g2; ctx.fill();
      ctx.strokeStyle = css(c, 1.6, 0.7); ctx.lineWidth = 0.02; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(L, 0); ctx.stroke();
      ctx.restore();
    }
  }
  // Предметы, тянущиеся линией: соединяются с такими же соседями
  function linked(ctx, T, x, y, code, m, w, c, style) {
    var cx = x + 0.5, cy = y + 0.5, segs = [];
    var dirs = [[1, 0], [0, 1], [-1, 0], [0, -1]];
    for (var i = 0; i < 4; i++) if (same(T, x + dirs[i][0], y + dirs[i][1], code, m)) segs.push(dirs[i]);
    if (!segs.length) segs.push(hash(x, y, 3) < 0.5 ? [1, 0] : [0, 1], hash(x, y, 3) < 0.5 ? [-1, 0] : [0, -1]);
    ctx.lineCap = style === 'block' ? 'butt' : 'round';
    var draw = function(dx, dy, col, lw) {
      ctx.strokeStyle = col; ctx.lineWidth = lw;
      ctx.beginPath();
      segs.forEach(function(s) { ctx.moveTo(cx + dx, cy + dy); ctx.lineTo(cx + dx + s[0] * (segs.length === 1 ? 0.45 : 0.5), cy + dy + s[1] * (segs.length === 1 ? 0.45 : 0.5)); });
      if (segs.length === 1 || segs.length === 2 && segs[0][0] + segs[1][0] === 0 && segs[0][1] + segs[1][1] === 0) {} else { ctx.moveTo(cx + dx, cy + dy); ctx.arc(cx + dx, cy + dy, 0.001, 0, TAU); }
      ctx.stroke();
    };
    draw(0.1, 0.13, 'rgba(0,0,0,0.38)', w);
    if (style === 'hedge') {
      draw(0, 0, css(c, 0.85), w);
      draw(-0.04, -0.05, css(c, 1.25), w * 0.55);
      for (var k = 0; k < 3; k++) { ctx.fillStyle = css(c, 1.5, 0.5); ctx.beginPath(); ctx.arc(x + 0.25 + hash(x, y, k) * 0.5, y + 0.25 + hash(x, y, k + 5) * 0.5, w * 0.16, 0, TAU); ctx.fill(); }
    } else if (style === 'log') {
      draw(0, 0, css(c, 0.8), w);
      draw(-0.03, -0.06, css(c, 1.15), w * 0.5);
      ctx.strokeStyle = css(c, 0.55, 0.6); ctx.lineWidth = 0.025;
      for (var j = 0; j < 3; j++) { var o = (hash(x, y, 30 + j) - 0.5) * w * 0.6; ctx.beginPath(); segs.forEach(function(s) { ctx.moveTo(cx - s[1] * o, cy + s[0] * o); ctx.lineTo(cx - s[1] * o + s[0] * 0.5, cy + s[0] * o + s[1] * 0.5); }); ctx.stroke(); }
    } else if (style === 'belt') {
      draw(0, 0, css(c, 0.9), w);
      draw(0, 0, 'rgba(30,28,26,1)', w * 0.62);
      ctx.strokeStyle = 'rgba(170,150,110,0.6)'; ctx.lineWidth = 0.03;
      segs.forEach(function(s) { for (var q = 0.1; q < 0.5; q += 0.2) { ctx.beginPath(); ctx.moveTo(cx + s[0] * q - s[1] * w * 0.3, cy + s[1] * q - s[0] * w * 0.3); ctx.lineTo(cx + s[0] * q + s[1] * w * 0.3, cy + s[1] * q + s[0] * w * 0.3); ctx.stroke(); } });
      // руда на ленте
      ctx.fillStyle = 'rgba(150,90,50,0.9)'; ctx.beginPath(); ctx.arc(cx + (hash(x, y, 9) - 0.5) * 0.2, cy, 0.08, 0, TAU); ctx.fill();
    } else if (style === 'pipe') {
      draw(0, 0, css(c, 0.8), w);
      draw(-0.03, -0.05, css(c, 1.3), w * 0.35);
    } else if (style === 'rail') {
      draw(0, 0, css(c, 0.85), w);
      draw(-0.01, -0.02, css(c, 1.2), w * 0.4);
      ctx.fillStyle = css(c, 1.25);
      ctx.beginPath(); ctx.arc(cx, cy, w * 0.7, 0, TAU); ctx.fill();
    } else if (style === 'block') {
      draw(0, 0, css(c, 0.95), w);
      draw(-0.02, -0.03, css(c, 1.18), w * 0.45);
    } else {
      // камни изгороди
      for (var s2 = 0; s2 < segs.length; s2++) for (var q2 = 0; q2 < 3; q2++) {
        var f = q2 / 3 * 0.5, sx = cx + segs[s2][0] * f, sy = cy + segs[s2][1] * f, r = w * (0.75 + hash(x * 3 + q2, y, s2) * 0.4);
        ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.beginPath(); ctx.arc(sx + 0.06, sy + 0.08, r, 0, TAU); ctx.fill();
        ctx.fillStyle = radial(ctx, sx, sy, r, c, 1.25, 0.7); ctx.beginPath(); ctx.arc(sx, sy, r, 0, TAU); ctx.fill();
      }
    }
  }

  // Противотанковые ежи
  function hedgehog(ctx, x, y, hsh) {
    var cx = x + 0.5, cy = y + 0.5;
    ctx.save(); ctx.translate(cx, cy); ctx.rotate(hsh * 0.8);
    ctx.lineCap = 'butt';
    [[0.1, 0.12, 'rgba(0,0,0,0.4)'], [0, 0, '#5d5a55']].forEach(function(s) {
      ctx.strokeStyle = s[2]; ctx.lineWidth = 0.1;
      ctx.beginPath(); ctx.moveTo(-0.32 + s[0], -0.32 + s[1]); ctx.lineTo(0.32 + s[0], 0.32 + s[1]);
      ctx.moveTo(0.32 + s[0], -0.32 + s[1]); ctx.lineTo(-0.32 + s[0], 0.32 + s[1]);
      ctx.moveTo(s[0], -0.36 + s[1]); ctx.lineTo(s[0], 0.36 + s[1]); ctx.stroke();
    });
    ctx.strokeStyle = '#8a857c'; ctx.lineWidth = 0.035;
    ctx.beginPath(); ctx.moveTo(-0.3, -0.32); ctx.lineTo(0.3, 0.28); ctx.stroke();
    ctx.restore();
  }

  // Мосты: настил поперёк воды или пропасти, перила по краям
  function bridge(ctx, T, x, y) {
    var N = T.N, t = T.map.t, st = T.look.bridge || 'plank';
    var open = function(dx, dy) { var xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= N || yy >= N) return false; var c = t[yy * N + xx]; return c !== TT.WATER && c !== TT.VOID; };
    var horiz = (open(1, 0) || open(-1, 0)) && !(open(0, 1) || open(0, -1)) ? true : (open(0, 1) || open(0, -1)) && !(open(1, 0) || open(-1, 0)) ? false : null;
    if (horiz === null) horiz = !(same(T, x, y - 1, TT.BRIDGE) || same(T, x, y + 1, TT.BRIDGE));
    var pal = { arch: [168, 182, 176], stone: [206, 198, 180], pier: [92, 88, 84], walkway: [196, 204, 208], metal: [70, 66, 64], rope: [140, 108, 70], plank: [130, 100, 66] };
    var c = pal[st] || pal.plank;
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(x + 0.12, y + 0.16, 1, 1);
    var gr = horiz ? ctx.createLinearGradient(x, y, x, y + 1) : ctx.createLinearGradient(x, y, x + 1, y);
    gr.addColorStop(0, css(c, 1.15)); gr.addColorStop(1, css(c, 0.82));
    ctx.fillStyle = gr; ctx.fillRect(x, y, 1, 1);
    ctx.strokeStyle = css(c, 0.6, 0.8); ctx.lineWidth = 0.025;
    if (st === 'walkway' || st === 'metal') {
      for (var i = 1; i < 4; i++) { ctx.beginPath(); if (horiz) { ctx.moveTo(x + i / 4, y); ctx.lineTo(x + i / 4, y + 1); } else { ctx.moveTo(x, y + i / 4); ctx.lineTo(x + 1, y + i / 4); } ctx.stroke(); }
      if (st === 'metal') { ctx.fillStyle = 'rgba(230,180,40,0.75)'; }
    } else {
      for (var j = 1; j < 5; j++) { ctx.beginPath(); if (horiz) { ctx.moveTo(x + j / 5, y); ctx.lineTo(x + j / 5, y + 1); } else { ctx.moveTo(x, y + j / 5); ctx.lineTo(x + 1, y + j / 5); } ctx.stroke(); }
    }
    // перила там, где край
    ctx.fillStyle = st === 'metal' ? 'rgba(230,180,40,0.85)' : css(c, 0.6);
    if (horiz) {
      if (!same(T, x, y - 1, TT.BRIDGE) && !open(0, -1)) ctx.fillRect(x, y, 1, 0.08);
      if (!same(T, x, y + 1, TT.BRIDGE) && !open(0, 1)) ctx.fillRect(x, y + 0.92, 1, 0.08);
    } else {
      if (!same(T, x - 1, y, TT.BRIDGE) && !open(-1, 0)) ctx.fillRect(x, y, 0.08, 1);
      if (!same(T, x + 1, y, TT.BRIDGE) && !open(1, 0)) ctx.fillRect(x + 0.92, y, 0.08, 1);
    }
  }

  // Переход у круглой платформы или причала: настил обрезан по кромке — упирается в неё ровной дугой
  function bridgeAtRim(ctx, T, x, y) {
    var N = T.N, best = null, bs = -9, li = T.KPI && T.KPI[y * N + x], KD = T.KD;
    if (li) for (var i = 0; i < li.length; i++) { var o = T.KP[li[i]], s = o.r - Math.hypot(x + 0.5 - o.x, y + 0.5 - o.y); if (s > bs) { bs = s; best = o; } }
    var nearDock = KD && y + 1.5 >= KD.y;
    if ((!best || bs < -1.6) && !nearDock) { bridge(ctx, T, x, y); return; }
    ctx.save();
    ctx.beginPath();
    ctx.rect(x - 0.3, y - 0.3, 1.6, nearDock ? Math.max(0, KD.y + 0.3 - (y - 0.3)) : 1.6);
    if (best && bs >= -1.6) { ctx.moveTo(best.x + best.r - 0.3, best.y); ctx.arc(best.x, best.y, best.r - 0.3, 0, TAU); }
    ctx.clip('evenodd');
    bridge(ctx, T, x, y);
    ctx.restore();
  }

  // Прямой мост: настил от берега до берега, доски поперёк, перила со столбиками, тень вниз
  function deck(ctx, T, o) {
    var st = T.look.bridge || 'plank';
    var pal = { arch: [168, 182, 176], stone: [206, 198, 180], pier: [92, 88, 84], walkway: [196, 204, 208], metal: [74, 70, 68], rope: [140, 108, 70], plank: [134, 102, 66] };
    var c = pal[st] || pal.plank;
    var dx = o.b[0] - o.a[0], dy = o.b[1] - o.a[1], L = Math.sqrt(dx * dx + dy * dy) || 1, ang = Math.atan2(dy, dx), hw = o.w / 2 - 0.05;
    ctx.save();
    ctx.translate(o.a[0], o.a[1]); ctx.rotate(ang);
    var x0 = -0.75, x1 = L + 0.75;
    // тень: над пропастью — далеко и слабее, над водой — рядом
    ctx.save(); ctx.rotate(-ang);
    var sx = o.u === 'void' ? 0.9 : 0.35, sy = o.u === 'void' ? 1.1 : 0.45;
    ctx.translate(sx, sy); ctx.rotate(ang);
    ctx.fillStyle = o.u === 'void' ? 'rgba(0,0,0,0.3)' : 'rgba(0,0,0,0.38)';
    ctx.fillRect(x0 + 0.6, -hw, x1 - x0 - 1.2, hw * 2);
    ctx.restore();
    // опоры (над водой, длинный мост)
    if (o.u !== 'void' && L > 6) {
      ctx.fillStyle = css(c, 0.45);
      for (var p = 3; p < L - 1; p += 4) { ctx.fillRect(p - 0.2, -hw - 0.15, 0.4, 0.3); ctx.fillRect(p - 0.2, hw - 0.15, 0.4, 0.3); }
    }
    // настил
    var g = ctx.createLinearGradient(0, -hw, 0, hw);
    g.addColorStop(0, css(c, 1.18)); g.addColorStop(0.5, css(c, 1)); g.addColorStop(1, css(c, 0.8));
    ctx.fillStyle = g; ctx.fillRect(x0, -hw, x1 - x0, hw * 2);
    ctx.strokeStyle = css(c, 0.62, 0.75); ctx.lineWidth = 0.03;
    var step = st === 'walkway' || st === 'metal' ? 0.5 : st === 'stone' || st === 'arch' ? 0.7 : 0.28;
    for (var q = x0 + step; q < x1; q += step) { ctx.beginPath(); ctx.moveTo(q, -hw); ctx.lineTo(q, hw); ctx.stroke(); }
    if (st === 'walkway' || st === 'metal') { ctx.beginPath(); ctx.moveTo(x0, 0); ctx.lineTo(x1, 0); ctx.stroke(); }
    // перила
    var rc = st === 'metal' ? [230, 180, 40] : st === 'walkway' ? [225, 232, 236] : mixc(c, [40, 30, 20], 0.35);
    ctx.fillStyle = css(rc, 1); ctx.fillRect(x0, -hw, x1 - x0, 0.1); ctx.fillRect(x0, hw - 0.1, x1 - x0, 0.1);
    ctx.fillStyle = css(rc, 0.75);
    for (var r = x0 + 0.3; r < x1; r += 1) { ctx.fillRect(r - 0.07, -hw - 0.04, 0.14, 0.18); ctx.fillRect(r - 0.07, hw - 0.14, 0.14, 0.18); }
    if (st === 'arch' || st === 'stone') {
      ctx.strokeStyle = 'rgba(255,255,255,0.25)'; ctx.lineWidth = 0.05;
      ctx.beginPath(); ctx.moveTo(x0, -hw + 0.12); ctx.lineTo(x1, -hw + 0.12); ctx.stroke();
    }
    ctx.restore();
  }

  // Крупные предметы из objs
  // Здание города: корпус в цвете планеты и крыша по стилю (flat, dome, gable, organic, panel, wood, crystal, tier);
  // над районом — его знак (госпиталь, связь, казармы, мастерские, склады)
  function bldgRoof(ctx, T, o, lk) {
    var x = o.x, y = o.y, w = o.w, h = o.h, c = lk.c, rc = lk.roofC, tr = lk.trim, st = lk.roof, z = o.z || 1;
    var sh = 0.35 + z * 0.3;
    ctx.fillStyle = 'rgba(0,0,0,0.42)';
    ctx.beginPath(); ctx.moveTo(x + w, y); ctx.lineTo(x + w + sh, y + sh * 1.1); ctx.lineTo(x + w + sh, y + h + sh * 1.1); ctx.lineTo(x + sh, y + h + sh * 1.1); ctx.lineTo(x, y + h); ctx.closePath(); ctx.fill();
    // стены: светлая северо-западная кромка, тёмная юго-восточная
    ctx.fillStyle = css(c, 0.82); ctx.fillRect(x, y, w, h);
    ctx.fillStyle = css(c, 1.08); ctx.fillRect(x, y, w - 0.12, h - 0.12);
    var ix = x + 0.14, iy = y + 0.14, iw = w - 0.28, ih = h - 0.28;
    if (st === 'dome') {
      ctx.fillStyle = css(rc, 0.9); ctx.fillRect(ix, iy, iw, ih);
      var r = Math.min(iw, ih) / 2 * 0.9, cx = ix + iw / 2, cy = iy + ih / 2;
      if (iw > ih * 1.6) { for (var d = 0; d < 2; d++) { var dcx = ix + iw * (0.27 + d * 0.46); ctx.beginPath(); ctx.arc(dcx, cy, r * 0.85, 0, TAU); ctx.fillStyle = radial(ctx, dcx, cy, r * 0.85, rc, 1.35, 0.62); ctx.fill(); } }
      else { ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.fillStyle = radial(ctx, cx, cy, r, rc, 1.35, 0.6); ctx.fill(); ctx.strokeStyle = css(rc, 1.5, 0.6); ctx.lineWidth = 0.04; ctx.beginPath(); ctx.arc(cx, cy, r * 0.6, 0, TAU); ctx.stroke(); }
    } else if (st === 'gable') {
      var hor = iw >= ih, g = hor ? ctx.createLinearGradient(ix, iy, ix, iy + ih) : ctx.createLinearGradient(ix, iy, ix + iw, iy);
      g.addColorStop(0, css(rc, 1.25)); g.addColorStop(0.5, css(rc, 1.05)); g.addColorStop(0.5, css(rc, 0.78)); g.addColorStop(1, css(rc, 0.66));
      ctx.fillStyle = g; ctx.fillRect(ix, iy, iw, ih);
      ctx.strokeStyle = css(rc, 1.45, 0.8); ctx.lineWidth = 0.05; ctx.beginPath();
      if (hor) { ctx.moveTo(ix, iy + ih / 2); ctx.lineTo(ix + iw, iy + ih / 2); } else { ctx.moveTo(ix + iw / 2, iy); ctx.lineTo(ix + iw / 2, iy + ih); } ctx.stroke();
      if (o.w >= 3 && o.h >= 3) { ctx.fillStyle = css(tr, 0.9); ctx.fillRect(ix + iw * 0.7, iy + ih * 0.2, 0.3, 0.3); }
    } else if (st === 'organic') {
      var p = function() { blobPath(ctx, ix + iw / 2, iy + ih / 2, Math.min(iw, ih) / 2 * 1.05, 9, 0.12, o.x * 7 + o.y); };
      ctx.fillStyle = css(c, 0.95); ctx.fillRect(ix, iy, iw, ih);
      p(); ctx.fillStyle = radial(ctx, ix + iw / 2, iy + ih / 2, Math.min(iw, ih) / 2, rc, 1.3, 0.7); ctx.fill();
      ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.beginPath(); ctx.arc(ix + iw / 2, iy + ih / 2, Math.min(iw, ih) * 0.12, 0, TAU); ctx.fill();
    } else if (st === 'panel' || st === 'crystal') {
      ctx.fillStyle = css(rc, 1); ctx.fillRect(ix, iy, iw, ih);
      ctx.strokeStyle = css(rc, st === 'crystal' ? 1.6 : 0.7, 0.8); ctx.lineWidth = 0.035;
      for (var px = 1; px < iw; px += 1) { ctx.beginPath(); ctx.moveTo(ix + px, iy); ctx.lineTo(ix + px, iy + ih); ctx.stroke(); }
      for (var py = 1; py < ih; py += 1) { ctx.beginPath(); ctx.moveTo(ix, iy + py); ctx.lineTo(ix + iw, iy + py); ctx.stroke(); }
      if (st === 'crystal') { ctx.fillStyle = 'rgba(200,240,255,0.35)'; ctx.beginPath(); ctx.moveTo(ix, iy + ih); ctx.lineTo(ix + iw * 0.5, iy); ctx.lineTo(ix + iw, iy + ih * 0.4); ctx.closePath(); ctx.fill(); }
    } else if (st === 'wood') {
      ctx.fillStyle = css(rc, 1); ctx.fillRect(ix, iy, iw, ih);
      ctx.strokeStyle = css(rc, 0.65, 0.7); ctx.lineWidth = 0.03;
      for (var wy = 0.3; wy < ih; wy += 0.3) { ctx.beginPath(); ctx.moveTo(ix, iy + wy); ctx.lineTo(ix + iw, iy + wy); ctx.stroke(); }
    } else if (st === 'tier') {
      ctx.fillStyle = css(rc, 0.95); ctx.fillRect(ix, iy, iw, ih);
      var t2 = Math.min(iw, ih) * 0.22;
      ctx.fillStyle = css(rc, 1.15); ctx.fillRect(ix + t2, iy + t2, iw - t2 * 2, ih - t2 * 2);
      ctx.fillStyle = css(rc, 1.3); ctx.fillRect(ix + t2 * 2, iy + t2 * 2, Math.max(0.3, iw - t2 * 4), Math.max(0.3, ih - t2 * 4));
    } else {
      // плоская: парапет, вентиляция, пара огней
      ctx.fillStyle = css(rc, 1); ctx.fillRect(ix, iy, iw, ih);
      ctx.strokeStyle = css(c, 1.2, 0.9); ctx.lineWidth = 0.06; ctx.strokeRect(ix, iy, iw, ih);
      var nv = Math.min(3, Math.floor(iw * ih / 4));
      for (var i = 0; i < nv; i++) { var vx = ix + 0.3 + hash(o.x, o.y, 10 + i) * (iw - 0.9), vy = iy + 0.3 + hash(o.x, o.y, 20 + i) * (ih - 0.9), vs = 0.3 + hash(o.x, o.y, 30 + i) * 0.3; ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.fillRect(vx + 0.08, vy + 0.1, vs, vs); ctx.fillStyle = css(rc, 1.25); ctx.fillRect(vx, vy, vs, vs); }
    }
    // знак района
    var cxs = x + w / 2, cys = y + h / 2, rs = Math.min(w, h) * 0.22;
    if (o.s === 'hospital') { ctx.fillStyle = 'rgba(255,255,255,0.92)'; ctx.beginPath(); ctx.arc(cxs, cys, rs * 1.25, 0, TAU); ctx.fill(); ctx.fillStyle = '#d23c3c'; ctx.fillRect(cxs - rs * 0.3, cys - rs, rs * 0.6, rs * 2); ctx.fillRect(cxs - rs, cys - rs * 0.3, rs * 2, rs * 0.6); }
    else if (o.s === 'garrison') { ctx.fillStyle = css(tr, 1, 0.95); ctx.beginPath(); ctx.moveTo(cxs, cys - rs * 1.2); ctx.lineTo(cxs + rs, cys - rs * 0.6); ctx.lineTo(cxs + rs * 0.8, cys + rs * 0.6); ctx.lineTo(cxs, cys + rs * 1.2); ctx.lineTo(cxs - rs * 0.8, cys + rs * 0.6); ctx.lineTo(cxs - rs, cys - rs * 0.6); ctx.closePath(); ctx.fill(); ctx.fillStyle = 'rgba(255,255,255,0.8)'; ctx.fillRect(cxs - rs * 0.15, cys - rs * 0.7, rs * 0.3, rs * 1.4); }
    else if (o.s === 'workshop') { ctx.strokeStyle = css(tr, 1, 0.95); ctx.lineWidth = rs * 0.35; ctx.beginPath(); ctx.arc(cxs, cys, rs * 0.7, 0, TAU); ctx.stroke(); ctx.fillStyle = css(tr, 1, 0.95); for (var g2 = 0; g2 < 8; g2++) { var ga = g2 / 8 * TAU; ctx.fillRect(cxs + Math.cos(ga) * rs - rs * 0.12, cys + Math.sin(ga) * rs - rs * 0.12, rs * 0.24, rs * 0.24); } }
    else if (o.s === 'warehouse') { ctx.strokeStyle = css(tr, 0.9, 0.7); ctx.lineWidth = 0.04; for (var wl = 0.5; wl < w; wl += 0.5) { ctx.beginPath(); ctx.moveTo(x + wl, y + 0.2); ctx.lineTo(x + wl, y + h - 0.2); ctx.stroke(); } }
    else if (o.s === 'market') { ctx.fillStyle = 'rgba(210,70,60,0.9)'; ctx.fillRect(x + 0.2, y + h - 0.45, w - 0.4, 0.25); ctx.fillStyle = 'rgba(255,255,255,0.8)'; for (var mk = 0.3; mk < w - 0.4; mk += 0.6) ctx.fillRect(x + mk, y + h - 0.45, 0.3, 0.25); }
    else if (o.s === 'comms') { ctx.fillStyle = css(tr, 1.1, 0.9); ctx.fillRect(cxs - 0.12, y + 0.2, 0.24, h - 0.4); }
    // огни по углам у больших
    if (w >= 3 && h >= 3) { ctx.fillStyle = 'rgba(255,214,130,0.9)'; ctx.fillRect(x + 0.18, y + 0.18, 0.1, 0.1); ctx.fillRect(x + w - 0.3, y + h - 0.3, 0.1, 0.1); }
  }
  function wallColor(lk, T) {
    var kind = lk.wall;
    return kind === 'metal' ? [104, 108, 114] : kind === 'wood' ? [104, 76, 48] : kind === 'hive' ? [138, 92, 62] : kind === 'crystal' ? [96, 156, 206] : kind === 'ice' ? [150, 178, 206] : mixc(lk.trim, lk.c, 0.2);
  }
  // плоские предметы — под мостами и укрытиями
  var UNDER = { crater: 1, kplat: 1, kpad: 1, kdock: 1 };
  var OBJ = {
    bldg: function(ctx, T, o) { bldgRoof(ctx, T, o, T.tlook); },
    // башня на углу стены: круглый бастион 2×2 (орудие рисует экран боя)
    bastion: function(ctx, T, o) {
      var lk = T.tlook, col = wallColor(lk, T), cx = o.x + 1, cy = o.y + 1;
      ctx.fillStyle = 'rgba(0,0,0,0.45)'; ctx.beginPath(); ctx.arc(cx + 0.3, cy + 0.36, 1.05, 0, TAU); ctx.fill();
      ctx.beginPath(); ctx.arc(cx, cy, 1.05, 0, TAU); ctx.fillStyle = radial(ctx, cx, cy, 1.05, col, 1.3, 0.72); ctx.fill();
      ctx.strokeStyle = css(col, 0.6); ctx.lineWidth = 0.06; ctx.stroke();
      ctx.fillStyle = css(col, 1.35);
      for (var i = 0; i < 8; i++) { var a = i / 8 * TAU; ctx.fillRect(cx + Math.cos(a) * 0.86 - 0.11, cy + Math.sin(a) * 0.86 - 0.11, 0.22, 0.22); }
      ctx.fillStyle = css(col, 0.85); ctx.beginPath(); ctx.arc(cx, cy, 0.55, 0, TAU); ctx.fill();
    },
    // столбы ворот по краям проёма
    gateposts: function(ctx, T, o) {
      var lk = T.tlook, col = wallColor(lk, T), hor = o.w > o.h, pts = hor ? [[o.x - 0.5, o.y + 0.5], [o.x + o.w + 0.5, o.y + 0.5]] : [[o.x + 0.5, o.y - 0.5], [o.x + 0.5, o.y + o.h + 0.5]];
      pts.forEach(function(p) {
        ctx.fillStyle = 'rgba(0,0,0,0.4)'; ctx.beginPath(); ctx.arc(p[0] + 0.14, p[1] + 0.18, 0.5, 0, TAU); ctx.fill();
        ctx.beginPath(); ctx.arc(p[0], p[1], 0.5, 0, TAU); ctx.fillStyle = radial(ctx, p[0], p[1], 0.5, col, 1.3, 0.7); ctx.fill();
        ctx.fillStyle = 'rgba(255,214,130,0.9)'; ctx.beginPath(); ctx.arc(p[0], p[1], 0.1, 0, TAU); ctx.fill();
      });
    },
    antenna: function(ctx, T, o) {
      // мачта с тарелкой над узлом связи
      ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.beginPath(); ctx.arc(o.x + 0.5, o.y + 0.6, 0.9, 0, TAU); ctx.fill();
      ctx.strokeStyle = 'rgba(200,204,210,0.9)'; ctx.lineWidth = 0.08;
      for (var i = 0; i < 3; i++) { var a = i / 3 * TAU + 0.5; ctx.beginPath(); ctx.moveTo(o.x, o.y); ctx.lineTo(o.x + Math.cos(a) * 0.9, o.y + Math.sin(a) * 0.9); ctx.stroke(); }
      ctx.beginPath(); ctx.arc(o.x, o.y, 0.7, 0, TAU); ctx.fillStyle = radial(ctx, o.x, o.y, 0.7, [190, 196, 204], 1.35, 0.6); ctx.fill();
      ctx.strokeStyle = 'rgba(70,80,90,0.6)'; ctx.lineWidth = 0.04; ctx.beginPath(); ctx.arc(o.x, o.y, 0.42, 0, TAU); ctx.stroke();
      ctx.fillStyle = '#ff6a5a'; ctx.beginPath(); ctx.arc(o.x, o.y, 0.1, 0, TAU); ctx.fill();
    },
    tower: function(ctx, T, o) {
      var z = o.z || 2, sh = 0.5 + z * 0.55, pal = [[118, 108, 96], [96, 104, 112], [132, 118, 100], [86, 82, 78]], c = pal[o.s % pal.length];
      // тень — вытянутый к юго-востоку контур
      ctx.fillStyle = 'rgba(0,0,0,0.42)';
      ctx.beginPath(); ctx.moveTo(o.x + o.w, o.y); ctx.lineTo(o.x + o.w + sh, o.y + sh * 1.15); ctx.lineTo(o.x + o.w + sh, o.y + o.h + sh * 1.15);
      ctx.lineTo(o.x + sh, o.y + o.h + sh * 1.15); ctx.lineTo(o.x, o.y + o.h); ctx.closePath(); ctx.fill();
      var gr = ctx.createLinearGradient(o.x, o.y, o.x + o.w, o.y + o.h);
      gr.addColorStop(0, css(c, 1.18)); gr.addColorStop(1, css(c, 0.82));
      ctx.fillStyle = gr; ctx.fillRect(o.x, o.y, o.w, o.h);
      ctx.strokeStyle = css(c, 1.45); ctx.lineWidth = 0.08; ctx.strokeRect(o.x + 0.04, o.y + 0.04, o.w - 0.08, o.h - 0.08);
      ctx.fillStyle = css(c, 0.7); ctx.fillRect(o.x + 0.45, o.y + 0.45, o.w - 0.9, o.h - 0.9);
      ctx.fillStyle = css(c, 1.05); ctx.fillRect(o.x + 0.6, o.y + 0.6, o.w - 1.2, o.h - 1.2);
      // крыша: площадка, вентиляция, огни
      var k = hash(o.x, o.y, 1);
      if (k < 0.35 && o.w > 4 && o.h > 4) {
        var r = Math.min(o.w, o.h) / 2 - 1, cx = o.x + o.w / 2, cy = o.y + o.h / 2;
        ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.fillStyle = css(c, 0.6); ctx.fill();
        ctx.strokeStyle = 'rgba(255,210,120,0.8)'; ctx.lineWidth = 0.08; ctx.beginPath(); ctx.arc(cx, cy, r - 0.25, 0, TAU); ctx.stroke();
        ctx.fillStyle = 'rgba(255,210,120,0.7)'; ctx.font = (r * 0.9) + 'px monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('H', cx, cy);
      } else {
        for (var i = 0; i < 3 + Math.floor(k * 4); i++) {
          var vx = o.x + 0.9 + hash(o.x, o.y, 10 + i) * (o.w - 2.2), vy = o.y + 0.9 + hash(o.x, o.y, 20 + i) * (o.h - 2.2), s = 0.4 + hash(o.x, o.y, 30 + i) * 0.5;
          ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.fillRect(vx + 0.1, vy + 0.12, s, s);
          ctx.fillStyle = css(c, 0.95 + hash(o.x, o.y, 40 + i) * 0.35); ctx.fillRect(vx, vy, s, s);
        }
      }
      ctx.fillStyle = 'rgba(255,214,130,0.9)';
      [[o.x + 0.2, o.y + 0.2], [o.x + o.w - 0.3, o.y + 0.2], [o.x + 0.2, o.y + o.h - 0.3], [o.x + o.w - 0.3, o.y + o.h - 0.3]].forEach(function(p) { ctx.fillRect(p[0], p[1], 0.1, 0.1); });
    },
    warehouse: function(ctx, T, o) {
      var pal = [[112, 108, 104], [128, 92, 70], [86, 98, 108], [104, 100, 82]], c = pal[o.s % pal.length];
      ctx.fillStyle = 'rgba(0,0,0,0.45)'; ctx.beginPath();
      ctx.moveTo(o.x + o.w, o.y); ctx.lineTo(o.x + o.w + 0.9, o.y + 1); ctx.lineTo(o.x + o.w + 0.9, o.y + o.h + 1); ctx.lineTo(o.x + 0.9, o.y + o.h + 1); ctx.lineTo(o.x, o.y + o.h); ctx.closePath(); ctx.fill();
      var horiz = o.w >= o.h;
      var gr = horiz ? ctx.createLinearGradient(o.x, o.y, o.x, o.y + o.h) : ctx.createLinearGradient(o.x, o.y, o.x + o.w, o.y);
      gr.addColorStop(0, css(c, 1.25)); gr.addColorStop(0.5, css(c, 1)); gr.addColorStop(0.51, css(c, 0.78)); gr.addColorStop(1, css(c, 0.68));
      ctx.fillStyle = gr; ctx.fillRect(o.x, o.y, o.w, o.h);
      ctx.strokeStyle = css(c, 0.55, 0.6); ctx.lineWidth = 0.03;
      for (var i = 0.4; i < (horiz ? o.w : o.h); i += 0.4) {
        ctx.beginPath(); if (horiz) { ctx.moveTo(o.x + i, o.y); ctx.lineTo(o.x + i, o.y + o.h); } else { ctx.moveTo(o.x, o.y + i); ctx.lineTo(o.x + o.w, o.y + i); } ctx.stroke();
      }
      ctx.fillStyle = 'rgba(190,220,235,0.55)';
      for (var j = 1; j < (horiz ? o.w : o.h) - 1; j += 3) { if (horiz) ctx.fillRect(o.x + j, o.y + o.h * 0.2, 0.9, 0.35); else ctx.fillRect(o.x + o.w * 0.2, o.y + j, 0.35, 0.9); }
      ctx.strokeStyle = css(c, 0.5); ctx.lineWidth = 0.06; ctx.strokeRect(o.x, o.y, o.w, o.h);
      if (T.look.accent) { ctx.fillStyle = css(T.C.accent, 1, 0.9); ctx.fillRect(o.x + 0.1, o.y + o.h - 0.2, 0.12, 0.12); ctx.fillRect(o.x + o.w - 0.22, o.y + o.h - 0.2, 0.12, 0.12); }
    },
    villa: function(ctx, T, o) {
      var c = [236, 232, 222], roof = [176, 96, 70];
      ctx.fillStyle = 'rgba(0,0,0,0.38)'; ctx.fillRect(o.x + 0.6, o.y + 0.7, o.w, o.h);
      ctx.fillStyle = css(c); ctx.fillRect(o.x, o.y, o.w, o.h);
      var gr = ctx.createLinearGradient(o.x, o.y, o.x, o.y + o.h);
      gr.addColorStop(0, css(roof, 1.2)); gr.addColorStop(0.5, css(roof, 1)); gr.addColorStop(0.5, css(roof, 0.75)); gr.addColorStop(1, css(roof, 0.65));
      ctx.fillStyle = gr; ctx.fillRect(o.x + 0.3, o.y + 0.3, o.w * 0.62, o.h - 0.6);
      ctx.fillStyle = '#5ab0c8'; rrect(ctx, o.x + o.w * 0.7, o.y + 0.7, o.w * 0.24, o.h - 1.4, 0.2); ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.6)'; ctx.lineWidth = 0.05; ctx.stroke();
    },
    dome: function(ctx, T, o) {
      ctx.fillStyle = 'rgba(0,0,0,0.4)'; ctx.beginPath(); ctx.arc(o.x + 0.6, o.y + 0.7, o.r, 0, TAU); ctx.fill();
      ctx.beginPath(); ctx.arc(o.x, o.y, o.r, 0, TAU); ctx.fillStyle = radial(ctx, o.x, o.y, o.r, [196, 206, 212], 1.3, 0.62); ctx.fill();
      ctx.strokeStyle = 'rgba(80,100,110,0.5)'; ctx.lineWidth = 0.05;
      for (var i = 0; i < 8; i++) { var a = i / 8 * TAU; ctx.beginPath(); ctx.moveTo(o.x, o.y); ctx.lineTo(o.x + Math.cos(a) * o.r, o.y + Math.sin(a) * o.r); ctx.stroke(); }
      for (var j = 1; j < 3; j++) { ctx.beginPath(); ctx.arc(o.x, o.y, o.r * j / 3, 0, TAU); ctx.stroke(); }
      ctx.fillStyle = 'rgba(120,220,255,0.9)';
      for (var k = 0; k < 6; k++) { var b = k / 6 * TAU + 0.3; ctx.beginPath(); ctx.arc(o.x + Math.cos(b) * o.r * 0.82, o.y + Math.sin(b) * o.r * 0.82, 0.1, 0, TAU); ctx.fill(); }
    },
    // Круглая платформа Камино: сваи и тень у кромки, бортик с огнями — только по внешнему краю
    // (где круги сливаются в одну палубу, кромки нет)
    kplat: function(ctx, T, o) {
      var KP = T.KP || [], arcs = [], step = Math.min(0.08, 0.5 / o.r), on = false, a0 = 0;
      function outer(a) {
        var px = o.x + Math.cos(a) * (o.r + 0.02), py = o.y + Math.sin(a) * (o.r + 0.02);
        for (var i = 0; i < KP.length; i++) { var q = KP[i]; if (q !== o && Math.hypot(px - q.x, py - q.y) < q.r - 0.02) return false; }
        return true;
      }
      for (var a = 0; a <= TAU + step * 0.5; a += step) {
        var ok = outer(a);
        if (ok && !on) { on = true; a0 = a; } else if (!ok && on) { on = false; arcs.push([a0, a]); }
      }
      if (on) arcs.push([a0, TAU]);
      if (arcs.length === 1 && arcs[0][0] === 0 && arcs[0][1] >= TAU) arcs = [[0, TAU]];
      if (!arcs.length) return;
      function stroke(r, w, c) { ctx.strokeStyle = c; ctx.lineWidth = w; arcs.forEach(function(s) { ctx.beginPath(); ctx.arc(o.x, o.y, r, s[0], s[1]); ctx.stroke(); }); }
      // сваи: тёмные опоры под кромкой с юго-востока (в тени)
      var n = Math.max(8, Math.round(TAU * o.r / 3.2));
      ctx.fillStyle = 'rgba(8,14,18,0.55)';
      for (var i = 0; i < n; i++) {
        var b = (i + 0.5) / n * TAU;
        if (!arcs.some(function(s) { return b >= s[0] && b <= s[1]; })) continue;
        var cx = o.x + Math.cos(b) * (o.r + 0.32) + 0.22, cy = o.y + Math.sin(b) * (o.r + 0.32) + 0.3;
        ctx.beginPath(); ctx.arc(cx, cy, 0.2, 0, TAU); ctx.fill();
      }
      stroke(o.r + 0.05, 0.1, 'rgba(10,18,22,0.6)');
      stroke(o.r - 0.25, 0.08, 'rgba(240,246,250,0.55)');
      // огни по бортику
      ctx.fillStyle = 'rgba(127,216,255,0.9)';
      var m = Math.max(6, Math.round(TAU * o.r / 2.4));
      for (var j = 0; j < m; j++) {
        var c = j / m * TAU;
        if (!arcs.some(function(s) { return c >= s[0] && c <= s[1]; })) continue;
        ctx.beginPath(); ctx.arc(o.x + Math.cos(c) * (o.r - 0.25), o.y + Math.sin(c) * (o.r - 0.25), 0.075, 0, TAU); ctx.fill();
      }
    },
    // Причал: прямая кромка с бортиком, сваями и огнями (рисуется только видимый кусок)
    kdock: function(ctx, T, o, x0, wc) {
      var xa = Math.max(o.x, Math.floor((x0 || 0) / 3) * 3), xb = Math.min(o.x + o.w, (x0 || 0) + (wc || o.w) + 3);
      ctx.fillStyle = 'rgba(8,14,18,0.45)';
      for (var x = xa + 1.5; x < xb; x += 3) { ctx.beginPath(); ctx.arc(x + 0.22, o.y - 0.3, 0.2, 0, TAU); ctx.fill(); }
      ctx.strokeStyle = 'rgba(10,18,22,0.6)'; ctx.lineWidth = 0.1; ctx.beginPath(); ctx.moveTo(xa, o.y - 0.05); ctx.lineTo(xb, o.y - 0.05); ctx.stroke();
      ctx.strokeStyle = 'rgba(240,246,250,0.55)'; ctx.lineWidth = 0.08; ctx.beginPath(); ctx.moveTo(xa, o.y + 0.25); ctx.lineTo(xb, o.y + 0.25); ctx.stroke();
      ctx.fillStyle = 'rgba(127,216,255,0.9)';
      for (var lx = Math.floor(xa / 2.4) * 2.4 + 1.2; lx < xb; lx += 2.4) { ctx.beginPath(); ctx.arc(lx, o.y + 0.25, 0.075, 0, TAU); ctx.fill(); }
    },
    // Посадочная площадка: кольца разметки, риски, круг с крестом и огни посадки
    kpad: function(ctx, T, o) {
      var r = o.r;
      ctx.strokeStyle = 'rgba(236,242,246,0.75)'; ctx.lineWidth = 0.16;
      ctx.beginPath(); ctx.arc(o.x, o.y, r, 0, TAU); ctx.stroke();
      ctx.setLineDash([0.7, 0.45]); ctx.lineWidth = 0.08;
      ctx.beginPath(); ctx.arc(o.x, o.y, r - 0.55, 0, TAU); ctx.stroke(); ctx.setLineDash([]);
      ctx.lineWidth = 0.12;
      for (var i = 0; i < 12; i++) {
        var a = i / 12 * TAU, l = i % 3 ? 0.45 : 0.9;
        ctx.beginPath(); ctx.moveTo(o.x + Math.cos(a) * (r - 0.9 - l), o.y + Math.sin(a) * (r - 0.9 - l)); ctx.lineTo(o.x + Math.cos(a) * (r - 0.9), o.y + Math.sin(a) * (r - 0.9)); ctx.stroke();
      }
      var ri = Math.max(1.2, r * 0.36);
      ctx.fillStyle = 'rgba(40,52,58,0.28)'; ctx.beginPath(); ctx.arc(o.x, o.y, ri, 0, TAU); ctx.fill();
      ctx.strokeStyle = 'rgba(236,242,246,0.8)'; ctx.lineWidth = 0.14; ctx.stroke();
      ctx.strokeStyle = 'rgba(127,216,255,0.75)'; ctx.lineWidth = 0.22;
      ctx.beginPath(); ctx.moveTo(o.x - ri * 0.55, o.y); ctx.lineTo(o.x + ri * 0.55, o.y); ctx.moveTo(o.x, o.y - ri * 0.55); ctx.lineTo(o.x, o.y + ri * 0.55); ctx.stroke();
      ctx.fillStyle = 'rgba(255,214,120,0.95)';
      for (var j = 0; j < 8; j++) { var b = (j + 0.5) / 8 * TAU; ctx.beginPath(); ctx.arc(o.x + Math.cos(b) * (r - 0.55), o.y + Math.sin(b) * (r - 0.55), 0.09, 0, TAU); ctx.fill(); }
    },
    platform: function(ctx, T, o) {
      // кромка платформы и сваи
      ctx.strokeStyle = 'rgba(230,236,240,0.7)'; ctx.lineWidth = 0.12; ctx.strokeRect(o.x + 0.06, o.y + 0.06, o.w - 0.12, o.h - 0.12);
      ctx.fillStyle = 'rgba(127,216,255,0.85)';
      for (var i = 1; i < o.w; i += 3) { ctx.fillRect(o.x + i, o.y + 0.02, 0.14, 0.14); ctx.fillRect(o.x + i, o.y + o.h - 0.16, 0.14, 0.14); }
    },
    wreck: function(ctx, T, o) {
      var c = [84, 80, 74], p = function() { poly(ctx, o.pts); };
      shadowOf(ctx, p, 0.45, 0.55, 0.45);
      p(); var gr = ctx.createLinearGradient(o.pts[0][0], o.pts[0][1], o.pts[2][0], o.pts[2][1]);
      gr.addColorStop(0, css(c, 1.3)); gr.addColorStop(1, css(c, 0.7)); ctx.fillStyle = gr; ctx.fill();
      ctx.strokeStyle = 'rgba(30,28,25,0.8)'; ctx.lineWidth = 0.06; ctx.stroke();
      var cx = (o.pts[0][0] + o.pts[2][0]) / 2, cy = (o.pts[0][1] + o.pts[2][1]) / 2;
      ctx.save(); ctx.translate(cx, cy); ctx.rotate(o.a);
      ctx.fillStyle = css(c, 1.1); ctx.beginPath(); ctx.arc(0.6, 0, 0.8, 0, TAU); ctx.fill();
      ctx.strokeStyle = css(c, 0.6); ctx.lineWidth = 0.22; ctx.beginPath(); ctx.moveTo(1.2, 0); ctx.lineTo(2.6, 0.3); ctx.stroke();
      ctx.fillStyle = 'rgba(15,12,10,0.6)'; ctx.beginPath(); ctx.arc(-0.6, 0.2, 0.7, 0, TAU); ctx.fill();
      ctx.fillStyle = 'rgba(160,60,30,0.4)'; ctx.beginPath(); ctx.arc(-0.2, -0.3, 0.4, 0, TAU); ctx.fill();
      ctx.restore();
    },
    hull: function(ctx, T, o) {
      var m = T.look.metal ? T.look.metal.map(rgb) : [[96, 90, 84], [140, 132, 122]];
      var p = function() { poly(ctx, o.pts); };
      shadowOf(ctx, p, 0.7, 0.85, 0.5);
      p(); var gr = ctx.createLinearGradient(o.pts[0][0], o.pts[0][1], o.pts[3][0], o.pts[3][1]);
      gr.addColorStop(0, css(m[1], 1.1)); gr.addColorStop(0.45, css(m[0], 1)); gr.addColorStop(1, css(m[0], 0.6));
      ctx.fillStyle = gr; ctx.fill();
      ctx.save(); p(); ctx.clip();
      ctx.translate(o.x, o.y); ctx.rotate(o.a);
      ctx.strokeStyle = 'rgba(20,18,16,0.55)'; ctx.lineWidth = 0.08;
      for (var i = -o.w / 2 + 1; i < o.w / 2; i += 1.3) { ctx.beginPath(); ctx.moveTo(i, -o.h / 2); ctx.lineTo(i, o.h / 2); ctx.stroke(); }
      ctx.lineWidth = 0.04; ctx.beginPath(); ctx.moveTo(-o.w / 2, 0); ctx.lineTo(o.w / 2, 0); ctx.stroke();
      // пробоины, ржавчина, обгоревшие пятна
      for (var j = 0; j < 4; j++) {
        var hx = (hash(o.x | 0, o.y | 0, j) - 0.5) * o.w * 0.8, hy = (hash(o.x | 0, o.y | 0, j + 9) - 0.5) * o.h * 0.6, hr = 0.4 + hash(o.x | 0, o.y | 0, j + 3) * 0.8;
        ctx.fillStyle = j % 2 ? 'rgba(10,8,6,0.75)' : 'rgba(150,70,30,0.4)'; blobPath(ctx, hx, hy, hr, 7, 0.4, j); ctx.fill();
      }
      ctx.restore();
      if (T.look.accent && hash(o.x | 0, o.y | 0, 77) < 0.6) {
        var fx = o.x + Math.cos(o.a) * o.w * 0.2, fy = o.y + Math.sin(o.a) * o.w * 0.2;
        var g2 = ctx.createRadialGradient(fx, fy, 0, fx, fy, 1.4); g2.addColorStop(0, 'rgba(255,140,50,0.55)'); g2.addColorStop(1, 'rgba(255,140,50,0)');
        ctx.fillStyle = g2; ctx.fillRect(fx - 1.4, fy - 1.4, 2.8, 2.8);
      }
    },
    wroshyr: function(ctx, T, o) {
      // исполин сверху: корни у подножия, над стволом — плотная крона (ствол под ней, пройти нельзя)
      var bark = (T.look.bark || ['#5a4430', '#3a2c1f']).map(rgb), leaf = T.C.light[0], hx = o.x | 0, hy = o.y | 0;
      softShadow(ctx, o.x + o.r * 0.9, o.y + o.r * 1.05, o.r * 2.1, 0.5);
      for (var k = 0; k < 7; k++) {
        var b = k / 7 * TAU + hash(hx, hy, 30 + k) * 0.5, L = o.r * (1.05 + hash(hx, hy, 40 + k) * 0.35);
        ctx.save(); ctx.translate(o.x + Math.cos(b) * L * 0.55, o.y + Math.sin(b) * L * 0.55); ctx.rotate(b);
        ctx.beginPath(); ctx.ellipse(0, 0, L * 0.62, o.r * 0.26, 0, 0, TAU);
        var g = ctx.createLinearGradient(0, -o.r * 0.26, 0, o.r * 0.26);
        g.addColorStop(0, css(bark[0], 1.25)); g.addColorStop(1, css(bark[1], 0.75));
        ctx.fillStyle = g; ctx.fill();
        ctx.restore();
      }
      // крона: слои листвы, светлее к северо-западу
      var R = o.r * 1.32;
      blobPath(ctx, o.x, o.y, R, 14, 0.12, hx + hy);
      ctx.fillStyle = radial(ctx, o.x, o.y, R, mixc(leaf, [20, 40, 15], 0.35), 1.15, 0.55); ctx.fill();
      for (var i = 0; i < 9; i++) {
        var a = hash(hx, hy, i) * TAU, d = R * (0.2 + hash(hx, hy, i + 9) * 0.55), rr = R * (0.28 + hash(hx, hy, i + 18) * 0.18);
        var cx = o.x + Math.cos(a) * d, cy = o.y + Math.sin(a) * d;
        ctx.beginPath(); ctx.arc(cx + rr * 0.18, cy + rr * 0.22, rr, 0, TAU); ctx.fillStyle = 'rgba(0,12,0,0.28)'; ctx.fill();
        ctx.beginPath(); ctx.arc(cx, cy, rr, 0, TAU); ctx.fillStyle = radial(ctx, cx, cy, rr, mixc(leaf, [60, 90, 40], 0.3), 1.45, 0.8); ctx.fill();
      }
      ctx.strokeStyle = 'rgba(10,20,8,0.45)'; ctx.lineWidth = 0.06; blobPath(ctx, o.x, o.y, R, 14, 0.12, hx + hy); ctx.stroke();
    },
    hive: function(ctx, T, o) {
      var c = mixc(T.C.rock[0], T.C.rock[1], 0.5);
      softShadow(ctx, o.x + o.r * 0.55, o.y + o.r * 0.65, o.r * 1.35, 0.45);
      for (var i = 0; i < 4; i++) {
        var r = o.r * (1 - i * 0.22), off = -i * o.r * 0.12;
        blobPath(ctx, o.x + off, o.y + off, r, 10, 0.18, i + 1);
        ctx.fillStyle = radial(ctx, o.x + off, o.y + off, r, c, 0.85 + i * 0.18, 0.55 + i * 0.1); ctx.fill();
      }
      ctx.fillStyle = 'rgba(30,10,5,0.75)';
      for (var j = 0; j < 5; j++) { var a = hash(o.x | 0, o.y | 0, j) * TAU, d = o.r * (0.3 + hash(o.x | 0, o.y | 0, j + 4) * 0.5); ctx.beginPath(); ctx.ellipse(o.x + Math.cos(a) * d, o.y + Math.sin(a) * d, o.r * 0.12, o.r * 0.08, a, 0, TAU); ctx.fill(); }
    },
    crystalspire: function(ctx, T, o) { spire(ctx, o, [110, 200, 255], 7, true); },
    icespire: function(ctx, T, o) { spire(ctx, o, [185, 215, 250], 6, false); },
    basaltspire: function(ctx, T, o) {
      var g = ctx.createRadialGradient(o.x, o.y, o.r * 0.6, o.x, o.y, o.r * 1.8);
      g.addColorStop(0, 'rgba(255,90,20,0.35)'); g.addColorStop(1, 'rgba(255,90,20,0)'); ctx.fillStyle = g; ctx.fillRect(o.x - o.r * 2, o.y - o.r * 2, o.r * 4, o.r * 4);
      var sd = (o.x * 7 + o.y) | 0;
      softShadow(ctx, o.x + o.r * 0.8, o.y + o.r * 0.95, o.r * 1.6, 0.55);
      blobPath(ctx, o.x, o.y, o.r, 11, 0.22, sd); ctx.fillStyle = radial(ctx, o.x, o.y, o.r, [56, 42, 40], 1.45, 0.42); ctx.fill();
      ctx.strokeStyle = 'rgba(255,110,40,0.4)'; ctx.lineWidth = 0.05; ctx.stroke();
      // грани столба
      ctx.strokeStyle = 'rgba(20,12,10,0.6)'; ctx.lineWidth = 0.04;
      for (var q = 0; q < 5; q++) { var qa = hash(sd, q, 3) * TAU; ctx.beginPath(); ctx.moveTo(o.x + Math.cos(qa) * o.r * 0.2, o.y + Math.sin(qa) * o.r * 0.2); ctx.lineTo(o.x + Math.cos(qa) * o.r * 0.9, o.y + Math.sin(qa) * o.r * 0.9); ctx.stroke(); }
    },
    pillar: function(ctx, T, o) {
      var c = mixc(T.C.rock[0], T.C.rock[1], 0.55);
      ctx.fillStyle = 'rgba(0,0,0,0.45)'; ctx.beginPath(); ctx.ellipse(o.x + o.r * 1.6, o.y + o.r * 1.9, o.r, o.r * 0.95, 0, 0, TAU); ctx.fill();
      blobPath(ctx, o.x, o.y, o.r, 8, 0.12, 5); ctx.fillStyle = radial(ctx, o.x, o.y, o.r, c, 1.3, 0.62); ctx.fill();
      ctx.strokeStyle = css(c, 0.7, 0.6); ctx.lineWidth = 0.04;
      for (var i = 1; i < 3; i++) { blobPath(ctx, o.x - 0.05 * i, o.y - 0.05 * i, o.r * (1 - i * 0.28), 8, 0.12, 5 + i); ctx.stroke(); }
      if (T.look.snow) { ctx.fillStyle = 'rgba(245,248,252,0.75)'; blobPath(ctx, o.x - o.r * 0.25, o.y - o.r * 0.3, o.r * 0.5, 7, 0.3, 9); ctx.fill(); }
    },
    shroom: function(ctx, T, o) {
      var g = T.look.glow ? rgb(T.look.glow[(o.c || 0) % T.look.glow.length]) : [200, 120, 255];
      var gr = ctx.createRadialGradient(o.x, o.y, o.r * 0.5, o.x, o.y, o.r * 2.2);
      gr.addColorStop(0, css(g, 1, 0.22)); gr.addColorStop(1, css(g, 1, 0)); ctx.fillStyle = gr; ctx.fillRect(o.x - o.r * 2.2, o.y - o.r * 2.2, o.r * 4.4, o.r * 4.4);
      ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.beginPath(); ctx.arc(o.x + o.r * 0.9, o.y + o.r, o.r * 1.15, 0, TAU); ctx.fill();
      blobPath(ctx, o.x, o.y, o.r * 1.2, 11, 0.1, 4); ctx.fillStyle = radial(ctx, o.x, o.y, o.r * 1.2, [70, 50, 90], 1.4, 0.55); ctx.fill();
      ctx.strokeStyle = css(g, 0.9, 0.5); ctx.lineWidth = 0.04;
      for (var i = 0; i < 12; i++) { var a = i / 12 * TAU; ctx.beginPath(); ctx.moveTo(o.x + Math.cos(a) * o.r * 0.3, o.y + Math.sin(a) * o.r * 0.3); ctx.lineTo(o.x + Math.cos(a) * o.r * 1.1, o.y + Math.sin(a) * o.r * 1.1); ctx.stroke(); }
      ctx.fillStyle = css(g, 1.2, 0.95);
      for (var j = 0; j < 5; j++) { var b = hash(o.x | 0, o.y | 0, j) * TAU, d = o.r * hash(o.x | 0, o.y | 0, j + 5) * 0.9; ctx.beginPath(); ctx.arc(o.x + Math.cos(b) * d, o.y + Math.sin(b) * d, 0.07 + o.r * 0.05, 0, TAU); ctx.fill(); }
    },
    lilactree: function(ctx, T, o) {
      ctx.fillStyle = 'rgba(0,0,0,0.42)'; blobPath(ctx, o.x + 0.5, o.y + 0.6, o.r * 1.35, 10, 0.18, 2); ctx.fill();
      blobPath(ctx, o.x, o.y, o.r * 1.35, 10, 0.18, 2); ctx.fillStyle = radial(ctx, o.x, o.y, o.r * 1.35, [96, 58, 140], 1.45, 0.55); ctx.fill();
      for (var i = 0; i < 5; i++) {
        var a = hash(o.x | 0, o.y | 0, i) * TAU, d = o.r * 0.6;
        ctx.beginPath(); ctx.arc(o.x + Math.cos(a) * d - 0.1, o.y + Math.sin(a) * d - 0.1, o.r * 0.45, 0, TAU); ctx.fillStyle = 'rgba(190,150,230,0.35)'; ctx.fill();
      }
    },
    fountain: function(ctx, T, o) {
      ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.beginPath(); ctx.arc(o.x + 0.2, o.y + 0.25, 1.15, 0, TAU); ctx.fill();
      ctx.beginPath(); ctx.arc(o.x, o.y, 1.15, 0, TAU); ctx.fillStyle = '#e4dfd2'; ctx.fill();
      ctx.beginPath(); ctx.arc(o.x, o.y, 0.95, 0, TAU); ctx.fillStyle = radial(ctx, o.x, o.y, 0.95, [80, 170, 200], 1.3, 0.8); ctx.fill();
      ctx.beginPath(); ctx.arc(o.x, o.y, 0.25, 0, TAU); ctx.fillStyle = '#efeadf'; ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.6)'; ctx.lineWidth = 0.04; ctx.beginPath(); ctx.arc(o.x, o.y, 0.55, 0, TAU); ctx.stroke();
    },
    crater: function(ctx, T, o) {
      var g = ctx.createRadialGradient(o.x, o.y, o.r * 0.2, o.x, o.y, o.r * 1.5);
      g.addColorStop(0, 'rgba(10,8,6,0.35)'); g.addColorStop(0.7, 'rgba(10,8,6,0.12)'); g.addColorStop(1, 'rgba(10,8,6,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(o.x, o.y, o.r * 1.5, 0, TAU); ctx.fill();
    },
    // места задач ивентов (tools/events/gen.js): площадка и предмет в середине (сама середина — твёрдая)
    evsite: function(ctx, T, o) {
      var f = EVSITE[o.s] || EVSITE.altar, sd = (o.x * 7 + o.y) | 0;
      // площадка: камень у древних мест, настил у машин; обломки и гнёзда лежат прямо на земле
      var base = o.s === 'wreck' ? evScorch : o.s === 'pod' || o.s === 'nest' ? null : o.old || (o.s === 'tower' && T.look.stone) ? evDaisStone : evDeck;
      if (base) base(ctx, T, o.x, o.y, 2.35, sd);
      f(ctx, T, o.x, o.y, (o.x * 13 + o.y * 7) | 0);
    },
    // точка эвакуации: расчищенная посадочная площадка с огнями
    evexit: function(ctx, T, o) { evPad(ctx, T, o.x, o.y); }
  };

  // ---------------------------------------------------------------- места задач ивентов
  function evStone(T) { return T.look.stone ? rgb(T.look.stone) : mixc(T.C.rock[0], T.C.rock[1], 0.6); }
  function evMetal(T) { return T.look.metal ? rgb(T.look.metal[0]) : [112, 116, 122]; }
  function evOct(ctx, x, y, r, rot) { ctx.beginPath(); for (var i = 0; i < 8; i++) { var a = (i + 0.5) / 8 * TAU + (rot || 0); if (i) ctx.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r); else ctx.moveTo(x + Math.cos(a) * r, y + Math.sin(a) * r); } ctx.closePath(); }
  // каменная площадка: плиты по кругу, стёртый край, мох или пыль в швах
  function evDaisStone(ctx, T, x, y, r, sd) {
    var c = evStone(T), moss = T.C.light[1];
    softShadow(ctx, x + 0.25, y + 0.3, r + 0.5, 0.35);
    blobPath(ctx, x, y, r, 18, 0.05, sd); ctx.fillStyle = radial(ctx, x, y, r, c, 1.02, 0.7); ctx.fill();
    ctx.save(); blobPath(ctx, x, y, r, 18, 0.05, sd); ctx.clip();
    ctx.strokeStyle = css(c, 0.5, 0.55); ctx.lineWidth = 0.035;
    [0.62, 1.3, 2].forEach(function(rr) { ctx.beginPath(); ctx.arc(x, y, rr, 0, TAU); ctx.stroke(); });
    for (var i = 0; i < 16; i++) { var a = i / 16 * TAU + (i % 2) * 0.1, r0 = i % 2 ? 1.3 : 0.62; ctx.beginPath(); ctx.moveTo(x + Math.cos(a) * r0, y + Math.sin(a) * r0); ctx.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r); ctx.stroke(); }
    // выщербленные плиты и мох
    for (var j = 0; j < 9; j++) {
      var b = hash(sd, j, 3) * TAU, d = 0.9 + hash(sd, j, 4) * 1.3, px = x + Math.cos(b) * d, py = y + Math.sin(b) * d;
      ctx.fillStyle = j % 3 ? css(c, 0.72, 0.55) : css(moss, 1, 0.45); blobPath(ctx, px, py, 0.18 + hash(sd, j, 5) * 0.25, 7, 0.35, sd + j); ctx.fill();
    }
    ctx.restore();
    ctx.strokeStyle = css(c, 0.55, 0.8); ctx.lineWidth = 0.07; blobPath(ctx, x, y, r, 18, 0.05, sd); ctx.stroke();
    ctx.strokeStyle = css(c, 1.25, 0.5); ctx.lineWidth = 0.04; ctx.beginPath(); ctx.arc(x - 0.03, y - 0.03, r - 0.12, Math.PI * 0.9, Math.PI * 1.6); ctx.stroke();
  }
  // металлический настил: восьмигранник из плит, полосы опасности, болты и огни по краю
  function evDeck(ctx, T, x, y, r, sd) {
    var m = evMetal(T);
    ctx.save(); ctx.translate(0.22, 0.28); ctx.fillStyle = 'rgba(0,0,0,0.38)'; evOct(ctx, x, y, r, 0); ctx.fill(); ctx.restore();
    evOct(ctx, x, y, r, 0); var g = ctx.createLinearGradient(x - r, y - r, x + r, y + r); g.addColorStop(0, css(m, 1.18)); g.addColorStop(1, css(m, 0.78)); ctx.fillStyle = g; ctx.fill();
    ctx.save(); evOct(ctx, x, y, r, 0); ctx.clip();
    ctx.strokeStyle = 'rgba(20,22,26,0.45)'; ctx.lineWidth = 0.035;
    for (var i = -3; i <= 3; i++) { ctx.beginPath(); ctx.moveTo(x + i * 0.78, y - r); ctx.lineTo(x + i * 0.78, y + r); ctx.stroke(); ctx.beginPath(); ctx.moveTo(x - r, y + i * 0.78 + 0.39); ctx.lineTo(x + r, y + i * 0.78 + 0.39); ctx.stroke(); }
    // полоса опасности по кромке
    ctx.lineWidth = 0.2; ctx.setLineDash([0.28, 0.28]); ctx.strokeStyle = 'rgba(214,170,52,0.75)'; evOct(ctx, x, y, r - 0.12, 0); ctx.stroke();
    ctx.setLineDash([0.28, 0.28]); ctx.lineDashOffset = 0.28; ctx.strokeStyle = 'rgba(24,22,20,0.7)'; evOct(ctx, x, y, r - 0.12, 0); ctx.stroke(); ctx.setLineDash([]); ctx.lineDashOffset = 0;
    // потёртости
    for (var j = 0; j < 6; j++) { var b = hash(sd, j, 6) * TAU, d = 0.6 + hash(sd, j, 7) * 1.2; ctx.fillStyle = 'rgba(30,26,22,0.22)'; blobPath(ctx, x + Math.cos(b) * d, y + Math.sin(b) * d, 0.2 + hash(sd, j, 8) * 0.25, 7, 0.4, sd + j); ctx.fill(); }
    ctx.restore();
    ctx.strokeStyle = css(m, 0.5); ctx.lineWidth = 0.06; evOct(ctx, x, y, r, 0); ctx.stroke();
    ctx.strokeStyle = css(m, 1.4, 0.5); ctx.lineWidth = 0.035; evOct(ctx, x - 0.03, y - 0.03, r - 0.06, 0); ctx.stroke();
    for (var k = 0; k < 8; k++) { var a = k / 8 * TAU, lx = x + Math.cos(a) * (r - 0.38), ly = y + Math.sin(a) * (r - 0.38); ctx.fillStyle = 'rgba(0,0,0,0.45)'; ctx.beginPath(); ctx.arc(lx + 0.03, ly + 0.04, 0.09, 0, TAU); ctx.fill(); ctx.fillStyle = k % 2 ? 'rgba(255,214,130,0.95)' : css(m, 1.5); ctx.beginPath(); ctx.arc(lx, ly, 0.07, 0, TAU); ctx.fill(); }
  }
  // выжженная земля после падения: тёмное пятно, борозда, мелкие обломки
  function evScorch(ctx, T, x, y, r, sd) {
    var g = ctx.createRadialGradient(x, y, 0.3, x, y, r + 0.4); g.addColorStop(0, 'rgba(16,12,10,0.62)'); g.addColorStop(0.7, 'rgba(16,12,10,0.3)'); g.addColorStop(1, 'rgba(16,12,10,0)');
    ctx.fillStyle = g; blobPath(ctx, x, y, r + 0.4, 14, 0.18, sd); ctx.fill();
    ctx.strokeStyle = 'rgba(20,14,10,0.45)'; ctx.lineWidth = 0.5; ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo(x - 2.3, y - 1.4); ctx.quadraticCurveTo(x - 1.2, y - 0.5, x - 0.4, y - 0.2); ctx.stroke(); ctx.lineCap = 'butt';
    for (var i = 0; i < 10; i++) { var a = hash(sd, i, 21) * TAU, d = 1 + hash(sd, i, 22) * 1.4; ctx.fillStyle = i % 3 ? 'rgba(70,66,60,0.9)' : 'rgba(150,70,30,0.6)'; ctx.fillRect(x + Math.cos(a) * d, y + Math.sin(a) * d, 0.08 + hash(sd, i, 23) * 0.12, 0.06 + hash(sd, i, 24) * 0.1); }
  }
  // блок с тенью: прямоугольник (повёрнутый), верх светлее
  function evBlock(ctx, x, y, w, h, a, c, z) {
    z = z || 0.3;
    ctx.save(); ctx.translate(x, y); ctx.rotate(a || 0);
    ctx.fillStyle = 'rgba(0,0,0,0.42)'; rrect(ctx, -w / 2 + z * 0.8, -h / 2 + z, w, h, Math.min(w, h) * 0.12); ctx.fill();
    ctx.fillStyle = css(c, 0.72); rrect(ctx, -w / 2, -h / 2 + z * 0.25, w, h, Math.min(w, h) * 0.12); ctx.fill();
    var g = ctx.createLinearGradient(-w / 2, -h / 2, w / 2, h / 2); g.addColorStop(0, css(c, 1.25)); g.addColorStop(1, css(c, 0.92));
    ctx.fillStyle = g; rrect(ctx, -w / 2, -h / 2, w, h, Math.min(w, h) * 0.12); ctx.fill();
    ctx.strokeStyle = css(c, 0.55, 0.8); ctx.lineWidth = 0.035; ctx.stroke();
    ctx.restore();
  }
  function evGlow(ctx, x, y, r, col, a) { var g = ctx.createRadialGradient(x, y, 0, x, y, r); g.addColorStop(0, 'rgba(' + col + ',' + a + ')'); g.addColorStop(1, 'rgba(' + col + ',0)'); ctx.fillStyle = g; ctx.fillRect(x - r, y - r, r * 2, r * 2); }
  function evCyl(ctx, x, y, r, c, z) {
    softShadow(ctx, x + r * 0.55 + (z || 0.3), y + r * 0.65 + (z || 0.3), r * 1.5, 0.5);
    ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fillStyle = radial(ctx, x, y, r, c, 1.35, 0.6); ctx.fill();
    ctx.strokeStyle = css(c, 0.5, 0.8); ctx.lineWidth = 0.04; ctx.stroke();
  }
  function evPipe(ctx, x0, y0, x1, y1, w, c) {
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = w; ctx.beginPath(); ctx.moveTo(x0 + 0.08, y0 + 0.12); ctx.lineTo(x1 + 0.08, y1 + 0.12); ctx.stroke();
    ctx.strokeStyle = css(c, 0.8); ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    ctx.strokeStyle = css(c, 1.4, 0.7); ctx.lineWidth = w * 0.3; ctx.beginPath(); ctx.moveTo(x0 - w * 0.12, y0 - w * 0.15); ctx.lineTo(x1 - w * 0.12, y1 - w * 0.15); ctx.stroke();
    ctx.lineCap = 'butt';
  }
  var EVSITE = {
    // алтарь: четыре стоячих камня, кольцо рун, плита с печатью
    altar: function(ctx, T, x, y, sd) {
      var c = evStone(T);
      ctx.strokeStyle = 'rgba(20,16,12,0.5)'; ctx.lineWidth = 0.06; ctx.beginPath(); ctx.arc(x, y, 1.35, 0, TAU); ctx.stroke();
      ctx.strokeStyle = 'rgba(235,214,150,0.35)'; ctx.lineWidth = 0.03; ctx.beginPath(); ctx.arc(x - 0.02, y - 0.02, 1.35, 0, TAU); ctx.stroke();
      ctx.fillStyle = 'rgba(20,16,12,0.55)';
      for (var i = 0; i < 12; i++) { var a = i / 12 * TAU; ctx.save(); ctx.translate(x + Math.cos(a) * 1.35, y + Math.sin(a) * 1.35); ctx.rotate(a); ctx.fillRect(-0.05, -0.12, 0.1, 0.24); ctx.restore(); }
      for (var k = 0; k < 4; k++) { var b = (k + 0.5) / 4 * TAU; evBlock(ctx, x + Math.cos(b) * 1.85, y + Math.sin(b) * 1.85, 0.42, 0.62, b + 0.2 * (hash(sd, k, 1) - 0.5), mixc(c, [90, 86, 78], 0.25), 0.55); }
      evBlock(ctx, x, y, 1.05, 0.78, 0.05, mixc(c, [120, 112, 100], 0.15), 0.4);
      ctx.strokeStyle = 'rgba(230,206,140,0.55)'; ctx.lineWidth = 0.04; ctx.beginPath(); ctx.arc(x, y, 0.22, 0, TAU); ctx.moveTo(x, y - 0.32); ctx.lineTo(x, y + 0.32); ctx.moveTo(x - 0.32, y); ctx.lineTo(x + 0.32, y); ctx.stroke();
    },
    // склеп: саркофаг, обломки колонн, ступени вниз
    crypt: function(ctx, T, x, y, sd) {
      var c = evStone(T), d = mixc(c, [70, 66, 60], 0.35);
      for (var s = 0; s < 4; s++) { ctx.fillStyle = 'rgba(10,8,6,' + (0.25 + s * 0.15) + ')'; ctx.fillRect(x - 0.6 + s * 0.04, y + 1.05 + s * 0.2, 1.2 - s * 0.08, 0.2); }
      evBlock(ctx, x - 1.55, y - 1.2, 0.55, 0.55, 0.3, d, 0.5); evBlock(ctx, x + 1.6, y - 1.05, 0.5, 0.5, -0.2, d, 0.4); evBlock(ctx, x + 1.35, y + 1.45, 0.62, 0.3, 0.9, d, 0.2);
      evBlock(ctx, x, y, 1.55, 0.78, 0, mixc(c, [110, 104, 92], 0.2), 0.42);
      ctx.strokeStyle = css(c, 0.55, 0.8); ctx.lineWidth = 0.04; rrect(ctx, x - 0.62, y - 0.28, 1.24, 0.56, 0.1); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x - 0.45, y); ctx.lineTo(x + 0.45, y); ctx.moveTo(x - 0.3, y - 0.15); ctx.lineTo(x - 0.3, y + 0.15); ctx.moveTo(x + 0.3, y - 0.15); ctx.lineTo(x + 0.3, y + 0.15); ctx.stroke();
    },
    // голокрон на постаменте, полукругом — полки с записями
    holocron: function(ctx, T, x, y, sd) {
      var c = evStone(T), wood = (T.look.bark || ['#6a5034']).map(rgb)[0];
      for (var i = 0; i < 3; i++) {
        var a0 = Math.PI * (0.95 + i * 0.4), a1 = a0 + 0.32;
        ctx.lineCap = 'butt'; ctx.strokeStyle = 'rgba(0,0,0,0.4)'; ctx.lineWidth = 0.42; ctx.beginPath(); ctx.arc(x + 0.12, y + 0.16, 1.75, a0, a1); ctx.stroke();
        ctx.strokeStyle = css(wood, 0.9); ctx.beginPath(); ctx.arc(x, y, 1.75, a0, a1); ctx.stroke();
        for (var q = 0; q < 6; q++) { var b = a0 + (q + 0.5) / 6 * (a1 - a0); ctx.fillStyle = ['#b0563c', '#c9a456', '#5a7a9c', '#7c5c8c'][(q + i) % 4]; ctx.save(); ctx.translate(x + Math.cos(b) * 1.75, y + Math.sin(b) * 1.75); ctx.rotate(b); ctx.fillRect(-0.12, -0.035, 0.24, 0.07); ctx.restore(); }
      }
      ctx.save(); ctx.translate(0.2, 0.26); ctx.fillStyle = 'rgba(0,0,0,0.45)'; evOct(ctx, x, y, 0.62, 0.2); ctx.fill(); ctx.restore();
      evOct(ctx, x, y, 0.62, 0.2); ctx.fillStyle = radial(ctx, x, y, 0.62, c, 1.2, 0.7); ctx.fill(); ctx.strokeStyle = css(c, 0.5); ctx.lineWidth = 0.04; ctx.stroke();
      evGlow(ctx, x, y, 0.75, '170,210,255', 0.35);
      ctx.save(); ctx.translate(x, y); ctx.rotate(Math.PI / 4);
      ctx.fillStyle = 'rgba(30,40,60,0.9)'; ctx.fillRect(-0.24, -0.24, 0.48, 0.48);
      var g = ctx.createLinearGradient(-0.24, -0.24, 0.24, 0.24); g.addColorStop(0, 'rgba(200,230,255,0.95)'); g.addColorStop(1, 'rgba(90,140,200,0.9)'); ctx.fillStyle = g; ctx.fillRect(-0.18, -0.18, 0.36, 0.36);
      ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.lineWidth = 0.03; ctx.strokeRect(-0.1, -0.1, 0.2, 0.2);
      ctx.restore();
    },
    // ядро данных: колонна с кольцами огней, стойки серверов вокруг
    datacore: function(ctx, T, x, y, sd) {
      var m = evMetal(T);
      for (var i = 0; i < 6; i++) {
        var a = i / 6 * TAU + 0.26; evBlock(ctx, x + Math.cos(a) * 1.6, y + Math.sin(a) * 1.6, 0.42, 0.72, a, mixc(m, [40, 44, 52], 0.45), 0.45);
        ctx.fillStyle = i % 2 ? 'rgba(110,220,255,0.9)' : 'rgba(120,255,170,0.85)';
        for (var q = 0; q < 3; q++) { var px = x + Math.cos(a) * 1.6 + Math.cos(a + Math.PI / 2) * (q - 1) * 0.18, py = y + Math.sin(a) * 1.6 + Math.sin(a + Math.PI / 2) * (q - 1) * 0.18; ctx.fillRect(px - 0.03, py - 0.03, 0.06, 0.06); }
      }
      ctx.strokeStyle = 'rgba(30,30,34,0.7)'; ctx.lineWidth = 0.07; for (var k = 0; k < 6; k++) { var b = k / 6 * TAU + 0.26; ctx.beginPath(); ctx.moveTo(x + Math.cos(b) * 0.7, y + Math.sin(b) * 0.7); ctx.lineTo(x + Math.cos(b) * 1.3, y + Math.sin(b) * 1.3); ctx.stroke(); }
      evCyl(ctx, x, y, 0.72, mixc(m, [60, 70, 90], 0.3), 0.5);
      ctx.strokeStyle = 'rgba(110,220,255,0.85)'; ctx.lineWidth = 0.05; ctx.beginPath(); ctx.arc(x, y, 0.5, 0, TAU); ctx.stroke(); ctx.beginPath(); ctx.arc(x, y, 0.28, 0, TAU); ctx.stroke();
      evGlow(ctx, x, y, 0.5, '110,220,255', 0.45);
    },
    // пульт управления: дуга из консолей с экранами, кресло, мачта
    terminal: function(ctx, T, x, y, sd) {
      var m = evMetal(T);
      ctx.lineCap = 'butt'; ctx.strokeStyle = 'rgba(0,0,0,0.45)'; ctx.lineWidth = 0.6; ctx.beginPath(); ctx.arc(x + 0.15, y + 0.6, 0.95, Math.PI * 1.1, Math.PI * 1.9); ctx.stroke();
      ctx.strokeStyle = css(m, 0.62); ctx.beginPath(); ctx.arc(x, y + 0.42, 0.95, Math.PI * 1.1, Math.PI * 1.9); ctx.stroke();
      ctx.strokeStyle = css(m, 1.15); ctx.lineWidth = 0.3; ctx.beginPath(); ctx.arc(x, y + 0.42, 1.08, Math.PI * 1.1, Math.PI * 1.9); ctx.stroke();
      for (var i = 0; i < 4; i++) { var a = Math.PI * (1.18 + i * 0.18); ctx.save(); ctx.translate(x + Math.cos(a) * 0.9, y + 0.42 + Math.sin(a) * 0.9); ctx.rotate(a + Math.PI / 2); ctx.fillStyle = 'rgba(8,14,22,0.95)'; ctx.fillRect(-0.17, -0.1, 0.34, 0.2); ctx.fillStyle = i === 1 ? 'rgba(255,140,90,0.9)' : 'rgba(110,200,255,0.9)'; ctx.fillRect(-0.13, -0.07, 0.26, 0.14); ctx.fillStyle = 'rgba(255,255,255,0.45)'; ctx.fillRect(-0.1, -0.04, 0.12, 0.02); ctx.restore(); }
      evCyl(ctx, x, y + 0.45, 0.22, [70, 66, 62], 0.15);
      // мачта с антенной
      evCyl(ctx, x + 1.45, y - 1.35, 0.3, m, 0.6); ctx.strokeStyle = css(m, 1.4); ctx.lineWidth = 0.05; ctx.beginPath(); ctx.moveTo(x + 1.45, y - 1.35); ctx.lineTo(x + 1.95, y - 1.75); ctx.stroke(); ctx.fillStyle = '#ff6a5a'; ctx.beginPath(); ctx.arc(x + 1.45, y - 1.35, 0.07, 0, TAU); ctx.fill();
      evBlock(ctx, x - 1.55, y + 1.3, 0.5, 0.4, 0.2, mixc(m, [60, 60, 60], 0.3), 0.3);
    },
    // узел связи: большая тарелка на треноге, кабели
    antenna: function(ctx, T, x, y, sd) {
      var m = evMetal(T);
      ctx.strokeStyle = 'rgba(26,26,30,0.7)'; ctx.lineWidth = 0.08; for (var k = 0; k < 3; k++) { var b = k / 3 * TAU + 0.6; ctx.beginPath(); ctx.moveTo(x, y); ctx.quadraticCurveTo(x + Math.cos(b + 0.4) * 1.2, y + Math.sin(b + 0.4) * 1.2, x + Math.cos(b) * 2.1, y + Math.sin(b) * 2.1); ctx.stroke(); }
      evBlock(ctx, x + 1.5, y + 1.25, 0.55, 0.42, -0.3, mixc(m, [60, 64, 70], 0.3), 0.35);
      ctx.fillStyle = 'rgba(0,0,0,0.4)'; ctx.beginPath(); ctx.ellipse(x + 0.6, y + 0.7, 1.05, 0.9, 0.5, 0, TAU); ctx.fill();
      ctx.save(); ctx.translate(x, y); ctx.rotate(-0.5);
      ctx.beginPath(); ctx.ellipse(0, 0, 1.02, 0.9, 0, 0, TAU); var g = ctx.createRadialGradient(-0.3, -0.25, 0.05, 0, 0, 1.05); g.addColorStop(0, css([214, 220, 226], 1.1)); g.addColorStop(1, css([150, 156, 166], 0.8)); ctx.fillStyle = g; ctx.fill();
      ctx.strokeStyle = 'rgba(70,80,92,0.6)'; ctx.lineWidth = 0.035; for (var i = 0; i < 10; i++) { var a = i / 10 * TAU; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(Math.cos(a) * 1.02, Math.sin(a) * 0.9); ctx.stroke(); }
      ctx.beginPath(); ctx.ellipse(0, 0, 0.6, 0.53, 0, 0, TAU); ctx.stroke(); ctx.lineWidth = 0.06; ctx.strokeStyle = 'rgba(60,66,76,0.8)'; ctx.beginPath(); ctx.ellipse(0, 0, 1.02, 0.9, 0, 0, TAU); ctx.stroke();
      ctx.strokeStyle = 'rgba(200,206,214,0.9)'; ctx.lineWidth = 0.05; [0, 2.1, 4.2].forEach(function(a) { ctx.beginPath(); ctx.moveTo(Math.cos(a) * 0.95, Math.sin(a) * 0.83); ctx.lineTo(0, 0); ctx.stroke(); });
      ctx.restore();
      ctx.fillStyle = '#ff6a5a'; ctx.beginPath(); ctx.arc(x, y, 0.1, 0, TAU); ctx.fill();
    },
    // реактор: кожух, светящееся ядро, трубы к краям
    reactor: function(ctx, T, x, y, sd) {
      var m = evMetal(T), hot = T.look.glow ? '120,230,255' : '255,170,80';
      for (var i = 0; i < 4; i++) { var a = i / 4 * TAU + Math.PI / 4; evPipe(ctx, x + Math.cos(a) * 0.8, y + Math.sin(a) * 0.8, x + Math.cos(a) * 2.05, y + Math.sin(a) * 2.05, 0.26, mixc(m, [150, 120, 90], 0.2)); evCyl(ctx, x + Math.cos(a) * 2.05, y + Math.sin(a) * 2.05, 0.2, m, 0.1); }
      evBlock(ctx, x - 1.55, y + 0.05, 0.35, 0.8, 0, mixc(m, [50, 50, 54], 0.4), 0.25); evBlock(ctx, x + 1.55, y - 0.05, 0.35, 0.8, 0, mixc(m, [50, 50, 54], 0.4), 0.25);
      evCyl(ctx, x, y, 0.98, mixc(m, [80, 80, 84], 0.3), 0.6);
      ctx.strokeStyle = css(m, 1.4, 0.6); ctx.lineWidth = 0.05; for (var k = 0; k < 12; k++) { var b = k / 12 * TAU; ctx.beginPath(); ctx.moveTo(x + Math.cos(b) * 0.72, y + Math.sin(b) * 0.72); ctx.lineTo(x + Math.cos(b) * 0.95, y + Math.sin(b) * 0.95); ctx.stroke(); }
      evGlow(ctx, x, y, 0.75, hot, 0.8); ctx.fillStyle = 'rgba(255,250,235,0.9)'; ctx.beginPath(); ctx.arc(x, y, 0.16, 0, TAU); ctx.fill();
      ctx.strokeStyle = 'rgba(' + hot + ',0.8)'; ctx.lineWidth = 0.04; ctx.beginPath(); ctx.arc(x, y, 0.5, 0, TAU); ctx.stroke();
    },
    // насосная: два бака, коллектор труб, вентиль
    pump: function(ctx, T, x, y, sd) {
      var m = evMetal(T), w = T.C.water[1];
      ctx.fillStyle = css(w, 0.9, 0.45); blobPath(ctx, x + 0.8, y + 1.35, 0.6, 9, 0.3, sd); ctx.fill();
      evPipe(ctx, x - 1.75, y - 0.55, x + 1.75, y - 0.55, 0.22, mixc(m, [90, 110, 120], 0.25)); evPipe(ctx, x - 0.9, y - 0.55, x - 0.9, y + 1.2, 0.18, mixc(m, [90, 110, 120], 0.25));
      evCyl(ctx, x - 1.1, y + 0.75, 0.55, mixc(m, [80, 110, 120], 0.2), 0.5); evCyl(ctx, x + 1.25, y - 1.3, 0.5, mixc(m, [80, 110, 120], 0.2), 0.5);
      evCyl(ctx, x, y, 0.62, mixc(m, [70, 74, 80], 0.3), 0.45);
      ctx.strokeStyle = 'rgba(200,60,50,0.95)'; ctx.lineWidth = 0.08; ctx.beginPath(); ctx.arc(x, y, 0.36, 0, TAU); ctx.stroke();
      ctx.lineWidth = 0.05; for (var i = 0; i < 4; i++) { var a = i / 4 * TAU + 0.4; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(a) * 0.36, y + Math.sin(a) * 0.36); ctx.stroke(); }
    },
    // буровая: вышка (рама сверху), ствол, трубы штабелем, грязь
    drill: function(ctx, T, x, y, sd) {
      var m = evMetal(T), mud = mixc(T.C.rough, [60, 50, 40], 0.4);
      ctx.fillStyle = css(mud, 0.8, 0.75); blobPath(ctx, x + 0.3, y + 0.3, 1.3, 11, 0.3, sd); ctx.fill();
      for (var i = 0; i < 5; i++) evPipe(ctx, x - 1.95, y + 1.25 + i * 0.16, x - 0.55, y + 1.25 + i * 0.16, 0.14, [120, 104, 90]);
      ctx.save(); ctx.translate(0.5, 0.6); ctx.strokeStyle = 'rgba(0,0,0,0.4)'; ctx.lineWidth = 0.14; ctx.strokeRect(x - 0.95, y - 0.95, 1.9, 1.9); ctx.restore();
      ctx.strokeStyle = 'rgba(214,170,52,0.95)'; ctx.lineWidth = 0.14; ctx.strokeRect(x - 0.95, y - 0.95, 1.9, 1.9);
      ctx.lineWidth = 0.07; ctx.beginPath(); ctx.moveTo(x - 0.95, y - 0.95); ctx.lineTo(x + 0.95, y + 0.95); ctx.moveTo(x + 0.95, y - 0.95); ctx.lineTo(x - 0.95, y + 0.95); ctx.stroke();
      ctx.strokeStyle = 'rgba(214,170,52,0.75)'; ctx.lineWidth = 0.06; ctx.strokeRect(x - 0.5, y - 0.5, 1, 1);
      ctx.fillStyle = 'rgba(10,8,6,0.9)'; ctx.beginPath(); ctx.arc(x, y, 0.3, 0, TAU); ctx.fill();
      ctx.strokeStyle = css(m, 1.3); ctx.lineWidth = 0.1; ctx.beginPath(); ctx.arc(x, y, 0.32, 0, TAU); ctx.stroke();
      [[-0.95, -0.95], [0.95, -0.95], [-0.95, 0.95], [0.95, 0.95]].forEach(function(p) { ctx.fillStyle = css(m, 0.8); ctx.fillRect(x + p[0] - 0.13, y + p[1] - 0.13, 0.26, 0.26); });
      evBlock(ctx, x + 1.5, y - 1.3, 0.65, 0.48, 0.15, [150, 72, 50], 0.35);
    },
    // склад: штабели ящиков и контейнер, взрывчатка — с красной маркировкой
    crates: function(ctx, T, x, y, sd) { evCrates(ctx, T, x, y, sd, false); },
    medcrates: function(ctx, T, x, y, sd) { evCrates(ctx, T, x, y, sd, true); },
    // обломки корабля: изогнутый кусок корпуса с рёбрами, разбросанные плиты, тлеет
    wreck: function(ctx, T, x, y, sd) {
      var m = T.look.metal ? rgb(T.look.metal[0]) : [104, 100, 96];
      for (var j = 0; j < 6; j++) { var b = hash(sd, j, 11) * TAU, d = 1.5 + hash(sd, j, 12) * 0.6; evBlock(ctx, x + Math.cos(b) * d, y + Math.sin(b) * d, 0.3 + hash(sd, j, 13) * 0.3, 0.16 + hash(sd, j, 14) * 0.2, b * 3, mixc(m, [60, 56, 50], 0.3), 0.12); }
      var pts = [[x - 1.2, y - 0.5], [x - 0.2, y - 1.0], [x + 1.25, y - 0.65], [x + 1.0, y + 0.45], [x - 0.3, y + 0.8], [x - 1.1, y + 0.35]];
      var p = function() { poly(ctx, pts); };
      shadowOf(ctx, p, 0.35, 0.45, 0.45);
      p(); var g = ctx.createLinearGradient(x - 1.2, y - 1, x + 1.2, y + 0.8); g.addColorStop(0, css(m, 1.3)); g.addColorStop(1, css(m, 0.6)); ctx.fillStyle = g; ctx.fill();
      ctx.save(); p(); ctx.clip(); ctx.strokeStyle = 'rgba(20,18,16,0.55)'; ctx.lineWidth = 0.07;
      for (var i = -1.2; i < 1.4; i += 0.4) { ctx.beginPath(); ctx.moveTo(x + i, y - 1.1); ctx.lineTo(x + i + 0.3, y + 0.9); ctx.stroke(); }
      ctx.fillStyle = 'rgba(10,8,6,0.75)'; blobPath(ctx, x + 0.35, y + 0.05, 0.4, 8, 0.4, sd); ctx.fill();
      ctx.fillStyle = 'rgba(150,70,30,0.4)'; blobPath(ctx, x - 0.55, y - 0.2, 0.35, 7, 0.4, sd + 3); ctx.fill();
      ctx.restore();
      ctx.strokeStyle = 'rgba(30,28,25,0.8)'; ctx.lineWidth = 0.05; p(); ctx.stroke();
      evGlow(ctx, x + 0.35, y + 0.05, 0.7, '255,140,50', 0.45);
    },
    // спасательная капсула: обгоревшая воронка, капсула с люком и стабилизаторами
    pod: function(ctx, T, x, y, sd) {
      var g = ctx.createRadialGradient(x, y, 0.4, x, y, 2.2); g.addColorStop(0, 'rgba(14,10,8,0.6)'); g.addColorStop(1, 'rgba(14,10,8,0)'); ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, 2.2, 0, TAU); ctx.fill();
      ctx.save(); ctx.translate(x, y); ctx.rotate(0.6);
      ctx.fillStyle = 'rgba(0,0,0,0.45)'; ctx.beginPath(); ctx.ellipse(0.35, 0.3, 1.05, 0.62, 0, 0, TAU); ctx.fill();
      [[-0.75, -0.55], [-0.75, 0.55]].forEach(function(f) { ctx.fillStyle = 'rgba(90,86,80,1)'; ctx.beginPath(); ctx.moveTo(-0.5, f[1] * 0.6); ctx.lineTo(-1.15, f[1] * 1.4); ctx.lineTo(-0.95, f[1] * 0.5); ctx.closePath(); ctx.fill(); });
      ctx.beginPath(); ctx.ellipse(0, 0, 1.0, 0.6, 0, 0, TAU); var gg = ctx.createLinearGradient(-1, -0.6, 1, 0.6); gg.addColorStop(0, '#e6e2d8'); gg.addColorStop(1, '#8a8478'); ctx.fillStyle = gg; ctx.fill();
      ctx.strokeStyle = 'rgba(40,36,32,0.7)'; ctx.lineWidth = 0.04; ctx.stroke(); ctx.beginPath(); ctx.moveTo(-0.4, -0.55); ctx.lineTo(-0.4, 0.55); ctx.stroke();
      ctx.fillStyle = 'rgba(190,60,40,0.85)'; ctx.fillRect(-0.85, -0.08, 0.35, 0.16);
      ctx.fillStyle = 'rgba(30,50,70,0.95)'; ctx.beginPath(); ctx.ellipse(0.45, 0, 0.3, 0.22, 0, 0, TAU); ctx.fill(); ctx.fillStyle = 'rgba(160,210,240,0.5)'; ctx.beginPath(); ctx.ellipse(0.4, -0.06, 0.12, 0.07, 0, 0, TAU); ctx.fill();
      ctx.fillStyle = 'rgba(20,14,10,0.4)'; blobPath(ctx, -0.95, 0.1, 0.32, 7, 0.4, sd); ctx.fill();
      ctx.restore();
    },
    // маяк / башня: круглая крыша, зубцы или фермы, фонарь в середине
    tower: function(ctx, T, x, y, sd, oldS) {
      var c = T.look.stone ? rgb(T.look.stone) : evMetal(T);
      ctx.fillStyle = 'rgba(0,0,0,0.42)'; ctx.beginPath(); ctx.moveTo(x - 0.9, y + 0.3); ctx.lineTo(x + 1.0, y + 2.1); ctx.lineTo(x + 2.0, y + 1.3); ctx.lineTo(x + 0.4, y - 0.8); ctx.closePath(); ctx.fill();
      ctx.beginPath(); ctx.arc(x, y, 1.05, 0, TAU); ctx.fillStyle = radial(ctx, x, y, 1.05, c, 1.25, 0.7); ctx.fill(); ctx.strokeStyle = css(c, 0.5); ctx.lineWidth = 0.06; ctx.stroke();
      ctx.fillStyle = css(c, 1.3); for (var i = 0; i < 10; i++) { var a = i / 10 * TAU; ctx.save(); ctx.translate(x + Math.cos(a) * 0.92, y + Math.sin(a) * 0.92); ctx.rotate(a); ctx.fillRect(-0.09, -0.12, 0.18, 0.24); ctx.restore(); }
      ctx.beginPath(); ctx.arc(x, y, 0.66, 0, TAU); ctx.fillStyle = css(c, 0.75); ctx.fill();
      ctx.strokeStyle = 'rgba(40,40,44,0.8)'; ctx.lineWidth = 0.05; for (var k = 0; k < 6; k++) { var b = k / 6 * TAU; ctx.beginPath(); ctx.moveTo(x + Math.cos(b) * 0.2, y + Math.sin(b) * 0.2); ctx.lineTo(x + Math.cos(b) * 0.62, y + Math.sin(b) * 0.62); ctx.stroke(); }
      evGlow(ctx, x, y, 1.6, '255,214,130', 0.35); ctx.fillStyle = 'rgba(255,236,190,0.95)'; ctx.beginPath(); ctx.arc(x, y, 0.2, 0, TAU); ctx.fill();
      ctx.strokeStyle = 'rgba(255,230,170,0.6)'; ctx.lineWidth = 0.04; ctx.beginPath(); ctx.arc(x, y, 0.32, 0, TAU); ctx.stroke();
    },
    // гнездо: кольцо из прутьев и костей, яйца в чаше
    nest: function(ctx, T, x, y, sd) {
      var tw = (T.look.bark || ['#5a4430', '#3a2c1f']).map(rgb);
      softShadow(ctx, x + 0.35, y + 0.4, 1.9, 0.45);
      ctx.beginPath(); ctx.arc(x, y, 1.45, 0, TAU); ctx.fillStyle = radial(ctx, x, y, 1.45, tw[1], 1.1, 0.7); ctx.fill();
      ctx.lineCap = 'round';
      for (var i = 0; i < 70; i++) { var a = hash(sd, i, 1) * TAU, r0 = 0.75 + hash(sd, i, 2) * 0.75, l = 0.35 + hash(sd, i, 3) * 0.5, b = a + Math.PI / 2 + (hash(sd, i, 4) - 0.5) * 0.9; var px = x + Math.cos(a) * r0, py = y + Math.sin(a) * r0; ctx.strokeStyle = css(tw[i % 2], 0.8 + hash(sd, i, 5) * 0.7); ctx.lineWidth = 0.05 + hash(sd, i, 6) * 0.05; ctx.beginPath(); ctx.moveTo(px - Math.cos(b) * l / 2, py - Math.sin(b) * l / 2); ctx.lineTo(px + Math.cos(b) * l / 2, py + Math.sin(b) * l / 2); ctx.stroke(); }
      ctx.lineCap = 'butt';
      ctx.beginPath(); ctx.arc(x, y, 0.72, 0, TAU); ctx.fillStyle = 'rgba(20,14,8,0.75)'; ctx.fill();
      [[-0.22, -0.12, 0.3], [0.2, -0.18, -0.4], [0.02, 0.24, 0.1], [0.32, 0.18, 0.8]].forEach(function(e) { ctx.fillStyle = 'rgba(0,0,0,0.4)'; ctx.beginPath(); ctx.ellipse(x + e[0] + 0.04, y + e[1] + 0.05, 0.17, 0.12, e[2], 0, TAU); ctx.fill(); ctx.beginPath(); ctx.ellipse(x + e[0], y + e[1], 0.17, 0.12, e[2], 0, TAU); ctx.fillStyle = radial(ctx, x + e[0], y + e[1], 0.17, [214, 206, 170], 1.2, 0.75); ctx.fill(); });
      ctx.strokeStyle = 'rgba(226,220,200,0.85)'; ctx.lineWidth = 0.06; ctx.beginPath(); ctx.moveTo(x + 1.2, y + 0.7); ctx.lineTo(x + 1.75, y + 1.1); ctx.moveTo(x - 1.6, y - 0.5); ctx.lineTo(x - 1.2, y - 1.0); ctx.stroke();
    },
    // врата / руины: два столба, рухнувшая перемычка, плита с надписью в середине
    gate: function(ctx, T, x, y, sd) {
      var c = evStone(T), d = mixc(c, [90, 86, 78], 0.3);
      evBlock(ctx, x - 1.55, y - 0.1, 0.72, 0.72, 0, d, 0.9); evBlock(ctx, x + 1.55, y - 0.1, 0.72, 0.72, 0, d, 0.9);
      evBlock(ctx, x + 0.55, y + 1.45, 2.3, 0.45, 0.18, mixc(c, [100, 96, 86], 0.2), 0.2);
      ctx.strokeStyle = css(c, 0.5, 0.7); ctx.lineWidth = 0.035; for (var i = -0.5; i <= 1.5; i += 0.5) { ctx.beginPath(); ctx.moveTo(x + i - 0.03, y + 1.25); ctx.lineTo(x + i + 0.06, y + 1.65); ctx.stroke(); }
      evBlock(ctx, x, y, 0.78, 0.6, 0, mixc(c, [120, 112, 100], 0.12), 0.35);
      ctx.fillStyle = 'rgba(40,32,24,0.6)'; for (var k = 0; k < 3; k++) ctx.fillRect(x - 0.22, y - 0.16 + k * 0.12, 0.44 - (k === 2 ? 0.16 : 0), 0.04);
    },
    // колодец: каменное кольцо, тёмная глубина, ворот с ведром
    well: function(ctx, T, x, y, sd) {
      var c = evStone(T), wood = (T.look.bark || ['#6a5034', '#4a3824']).map(rgb);
      softShadow(ctx, x + 0.3, y + 0.35, 1.3, 0.45);
      ctx.beginPath(); ctx.arc(x, y, 0.9, 0, TAU); ctx.fillStyle = radial(ctx, x, y, 0.9, c, 1.2, 0.7); ctx.fill();
      ctx.strokeStyle = css(c, 0.5, 0.8); ctx.lineWidth = 0.035; for (var i = 0; i < 10; i++) { var a = i / 10 * TAU; ctx.beginPath(); ctx.moveTo(x + Math.cos(a) * 0.62, y + Math.sin(a) * 0.62); ctx.lineTo(x + Math.cos(a) * 0.9, y + Math.sin(a) * 0.9); ctx.stroke(); }
      var g = ctx.createRadialGradient(x - 0.1, y - 0.1, 0, x, y, 0.62); g.addColorStop(0, 'rgba(4,4,6,1)'); g.addColorStop(1, 'rgba(30,26,22,1)'); ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, 0.6, 0, TAU); ctx.fill();
      evBlock(ctx, x - 0.95, y, 0.2, 0.2, 0, wood[1], 0.6); evBlock(ctx, x + 0.95, y, 0.2, 0.2, 0, wood[1], 0.6);
      ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.fillRect(x - 0.9, y + 0.12, 1.85, 0.14); ctx.fillStyle = css(wood[0], 1.1); ctx.fillRect(x - 0.95, y - 0.07, 1.9, 0.14);
      ctx.strokeStyle = 'rgba(200,180,140,0.7)'; ctx.lineWidth = 0.025; ctx.beginPath(); ctx.moveTo(x + 0.15, y); ctx.lineTo(x + 0.15, y + 0.3); ctx.stroke();
      evBlock(ctx, x + 0.15, y + 0.36, 0.2, 0.16, 0, [110, 90, 66], 0.05);
    },
    // купол оранжереи: стеклянные сегменты, зелень внутри, переходный рукав
    dome: function(ctx, T, x, y, sd) {
      var m = evMetal(T);
      evBlock(ctx, x + 1.45, y + 0.9, 0.85, 0.42, 0.55, m, 0.25);
      ctx.fillStyle = 'rgba(0,0,0,0.4)'; ctx.beginPath(); ctx.arc(x + 0.45, y + 0.55, 1.15, 0, TAU); ctx.fill();
      ctx.beginPath(); ctx.arc(x, y, 1.15, 0, TAU); ctx.fillStyle = 'rgba(30,60,40,0.95)'; ctx.fill();
      for (var i = 0; i < 9; i++) { var a = hash(sd, i, 1) * TAU, d = hash(sd, i, 2) * 0.8; ctx.beginPath(); ctx.arc(x + Math.cos(a) * d, y + Math.sin(a) * d, 0.18 + hash(sd, i, 3) * 0.18, 0, TAU); ctx.fillStyle = radial(ctx, x + Math.cos(a) * d, y + Math.sin(a) * d, 0.3, [70, 130, 70], 1.35, 0.7); ctx.fill(); }
      var g = ctx.createRadialGradient(x - 0.45, y - 0.5, 0.05, x, y, 1.2); g.addColorStop(0, 'rgba(230,250,255,0.55)'); g.addColorStop(0.5, 'rgba(160,210,230,0.18)'); g.addColorStop(1, 'rgba(120,170,200,0.3)'); ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, 1.15, 0, TAU); ctx.fill();
      ctx.strokeStyle = css(m, 1.3, 0.9); ctx.lineWidth = 0.05; for (var k = 0; k < 8; k++) { var b = k / 8 * TAU; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(b) * 1.15, y + Math.sin(b) * 1.15); ctx.stroke(); }
      [0.4, 0.8].forEach(function(r) { ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.stroke(); }); ctx.lineWidth = 0.08; ctx.beginPath(); ctx.arc(x, y, 1.15, 0, TAU); ctx.stroke();
    }
  };
  function evCrates(ctx, T, x, y, sd, med) {
    var pal = med ? [[214, 210, 200], [190, 188, 182], [168, 172, 176]] : [[132, 100, 64], [104, 110, 80], [118, 112, 102]];
    var spots = [[-1.45, -1.05, 0.62, 0.0], [-0.85, -1.55, 0.5, 0.3], [1.5, -0.95, 0.66, -0.2], [1.6, 0.75, 0.55, 0.15], [-1.5, 0.95, 0.7, 0.05], [-0.95, 1.6, 0.5, -0.35], [0.95, 1.55, 0.46, 0.4]];
    spots.forEach(function(p, i) {
      var c = pal[(i + sd) % pal.length]; evBlock(ctx, x + p[0], y + p[1], p[2], p[2], p[3], c, 0.35);
      ctx.save(); ctx.translate(x + p[0], y + p[1]); ctx.rotate(p[3]);
      if (med) { ctx.fillStyle = 'rgba(205,50,50,0.95)'; ctx.fillRect(-p[2] * 0.08, -p[2] * 0.28, p[2] * 0.16, p[2] * 0.56); ctx.fillRect(-p[2] * 0.28, -p[2] * 0.08, p[2] * 0.56, p[2] * 0.16); }
      else { ctx.strokeStyle = css(c, 0.55, 0.9); ctx.lineWidth = 0.035; ctx.strokeRect(-p[2] * 0.36, -p[2] * 0.36, p[2] * 0.72, p[2] * 0.72); ctx.beginPath(); ctx.moveTo(-p[2] * 0.36, -p[2] * 0.36); ctx.lineTo(p[2] * 0.36, p[2] * 0.36); ctx.stroke(); }
      ctx.restore();
    });
    // контейнер в середине
    var cc = med ? [226, 224, 218] : [150, 70, 46];
    evBlock(ctx, x, y, 1.45, 0.82, 0, cc, 0.55);
    ctx.strokeStyle = css(cc, 0.6, 0.8); ctx.lineWidth = 0.035; for (var i = -0.55; i <= 0.56; i += 0.18) { ctx.beginPath(); ctx.moveTo(x + i, y - 0.38); ctx.lineTo(x + i, y + 0.38); ctx.stroke(); }
    if (med) { ctx.fillStyle = 'rgba(205,50,50,0.95)'; ctx.fillRect(x - 0.07, y - 0.26, 0.14, 0.52); ctx.fillRect(x - 0.26, y - 0.07, 0.52, 0.14); }
    else { ctx.save(); ctx.beginPath(); ctx.rect(x - 0.72, y - 0.12, 1.44, 0.24); ctx.clip(); for (var k = -1; k < 1; k += 0.2) { ctx.fillStyle = 'rgba(240,200,60,0.95)'; ctx.beginPath(); ctx.moveTo(x + k, y - 0.12); ctx.lineTo(x + k + 0.1, y - 0.12); ctx.lineTo(x + k + 0.2, y + 0.12); ctx.lineTo(x + k + 0.1, y + 0.12); ctx.closePath(); ctx.fill(); } ctx.restore(); }
  }
  // посадочная площадка эвакуации
  function evPad(ctx, T, x, y) {
    var c = mixc(T.C.road, [120, 120, 118], 0.45), r = 2.6;
    softShadow(ctx, x + 0.15, y + 0.2, r + 0.5, 0.25);
    ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fillStyle = radial(ctx, x, y, r, c, 1.05, 0.82); ctx.fill();
    ctx.strokeStyle = css(c, 0.6, 0.8); ctx.lineWidth = 0.05; ctx.stroke();
    ctx.strokeStyle = 'rgba(240,232,210,0.7)'; ctx.lineWidth = 0.12; ctx.beginPath(); ctx.arc(x, y, r - 0.4, 0, TAU); ctx.stroke();
    ctx.lineWidth = 0.05; ctx.setLineDash([0.3, 0.22]); ctx.beginPath(); ctx.arc(x, y, r - 0.75, 0, TAU); ctx.stroke(); ctx.setLineDash([]);
    // шевроны к середине
    ctx.fillStyle = 'rgba(240,200,80,0.85)';
    for (var i = 0; i < 4; i++) { var a = i / 4 * TAU + Math.PI / 4; ctx.save(); ctx.translate(x + Math.cos(a) * 1.1, y + Math.sin(a) * 1.1); ctx.rotate(a); ctx.beginPath(); ctx.moveTo(0.22, 0); ctx.lineTo(-0.12, -0.24); ctx.lineTo(-0.02, 0); ctx.lineTo(-0.12, 0.24); ctx.closePath(); ctx.fill(); ctx.restore(); }
    ctx.strokeStyle = 'rgba(240,232,210,0.55)'; ctx.lineWidth = 0.06; ctx.beginPath(); ctx.arc(x, y, 0.35, 0, TAU); ctx.stroke();
    for (var k = 0; k < 8; k++) { var b = k / 8 * TAU, lx = x + Math.cos(b) * (r - 0.15), ly = y + Math.sin(b) * (r - 0.15); ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.beginPath(); ctx.arc(lx + 0.03, ly + 0.04, 0.12, 0, TAU); ctx.fill(); evGlow(ctx, lx, ly, 0.35, '120,255,150', 0.35); ctx.fillStyle = 'rgba(160,255,180,0.95)'; ctx.beginPath(); ctx.arc(lx, ly, 0.08, 0, TAU); ctx.fill(); }
  }
  function softShadow(ctx, x, y, r, a) {
    var g = ctx.createRadialGradient(x, y, r * 0.3, x, y, r);
    g.addColorStop(0, 'rgba(0,0,0,' + a + ')'); g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  function poly(ctx, pts) { ctx.beginPath(); pts.forEach(function(p, i) { if (i) ctx.lineTo(p[0], p[1]); else ctx.moveTo(p[0], p[1]); }); ctx.closePath(); }
  function spire(ctx, o, c, n, glow) {
    if (glow) {
      var g = ctx.createRadialGradient(o.x, o.y, 0, o.x, o.y, o.r * 2.4);
      g.addColorStop(0, css(c, 1, 0.35)); g.addColorStop(1, css(c, 1, 0)); ctx.fillStyle = g; ctx.fillRect(o.x - o.r * 2.4, o.y - o.r * 2.4, o.r * 4.8, o.r * 4.8);
    }
    // тень — длинная, шпиль высокий
    ctx.fillStyle = 'rgba(0,0,20,0.35)';
    ctx.beginPath(); ctx.moveTo(o.x - o.r * 0.5, o.y); ctx.lineTo(o.x + o.r * 2.6, o.y + o.r * 3); ctx.lineTo(o.x, o.y + o.r * 0.5); ctx.closePath(); ctx.fill();
    var a0 = o.a || 0;
    for (var i = 0; i < n; i++) {
      var a = a0 + i / n * TAU, L = o.r * (0.75 + hash(o.x | 0, o.y | 0, i) * 0.5), w = 0.28 * o.r;
      ctx.save(); ctx.translate(o.x, o.y); ctx.rotate(a);
      ctx.beginPath(); ctx.moveTo(0, -w); ctx.lineTo(L, 0); ctx.lineTo(0, w); ctx.closePath();
      var g2 = ctx.createLinearGradient(0, -w, 0, w);
      var lit = Math.cos(a + 2.3) * 0.5 + 0.5;
      g2.addColorStop(0, css(c, 0.9 + lit * 0.6)); g2.addColorStop(1, css(c, 0.55 + lit * 0.3));
      ctx.fillStyle = g2; ctx.fill();
      ctx.restore();
    }
    ctx.beginPath(); ctx.arc(o.x, o.y, o.r * 0.35, 0, TAU); ctx.fillStyle = css(c, 1.5); ctx.fill();
  }

  // Проход 2: предметы в области (с запасом, чтобы край куска не резал тени)
  Terrain.prototype.things = function(ctx, x0, y0, wc, hc, ppc) {
    var N = this.N, t = this.map.t, m = this.map.m, det = ppc >= 10, self = this;
    ctx.save();
    ctx.scale(ppc, ppc); ctx.translate(-x0, -y0);
    ctx.beginPath(); ctx.rect(x0, y0, wc, hc); ctx.clip();
    var pad = 3, xa = Math.max(0, x0 - pad), ya = Math.max(0, y0 - pad), xb = Math.min(N, x0 + wc + pad), yb = Math.min(N, y0 + hc + pad);
    // воронки — под всем
    this.map.objs.forEach(function(o) { if (o.k === 'kdock' && o.y - 2 < y0 + hc && o.y + o.h + 1 > y0) OBJ.kdock(ctx, self, o, x0, wc); });
    this.map.objs.forEach(function(o) { if (UNDER[o.k] && o.r && o.x + o.r + 2 > x0 && o.x - o.r - 2 < x0 + wc && o.y + o.r + 2 > y0 && o.y - o.r - 2 < y0 + hc) OBJ[o.k](ctx, self, o); });
    // мосты
    var bdraw = this.BX ? bridgeAtRim : bridge;
    for (var y = ya; y < yb; y++) for (var x = xa; x < xb; x++) if (t[y * N + x] === TT.BRIDGE && !this.BM[y * N + x]) bdraw(ctx, this, x, y);
    if (this.BX) for (var bi = 0; bi < this.BX.length; bi += 2) { var qx = this.BX[bi], qy = this.BX[bi + 1]; if (qx >= xa && qx < xb && qy >= ya && qy < yb) bdraw(ctx, this, qx, qy); }
    this.map.objs.forEach(function(o) {
      if (o.k !== 'bridge') return;
      var bx0 = Math.min(o.a[0], o.b[0]) - 3, bx1 = Math.max(o.a[0], o.b[0]) + 3, by0 = Math.min(o.a[1], o.b[1]) - 3, by1 = Math.max(o.a[1], o.b[1]) + 3;
      if (bx1 > x0 && bx0 < x0 + wc && by1 > y0 && by0 < y0 + hc) deck(ctx, self, o);
    });
    // укрытия и заграждения
    for (y = ya; y < yb; y++) for (x = xa; x < xb; x++) {
      var k = y * N + x, c = t[k];
      if (c === TT.COVER) {
        var fn = COVER[this.matName(TT.COVER, m[k])] || COVER.boulder;
        fn(ctx, this, x, y, hash(x, y, 1), det);
      } else if (c === TT.TRAP) hedgehog(ctx, x, y, hash(x, y, 2));
    }
    // крупные предметы — по возрастанию y, чтобы южные перекрывали тени северных
    var big = this.map.objs.filter(function(o) {
      if (!OBJ[o.k] || UNDER[o.k]) return false;
      var bx0, by0, bx1, by1;
      if (o.pts) { bx0 = 1e9; by0 = 1e9; bx1 = -1e9; by1 = -1e9; o.pts.forEach(function(p) { bx0 = Math.min(bx0, p[0]); by0 = Math.min(by0, p[1]); bx1 = Math.max(bx1, p[0]); by1 = Math.max(by1, p[1]); }); }
      else if (o.w != null) { bx0 = o.x; by0 = o.y; bx1 = o.x + o.w; by1 = o.y + o.h; }
      else { var r = (o.r || 1.2) * 3; bx0 = o.x - r; by0 = o.y - r; bx1 = o.x + r; by1 = o.y + r; }
      return bx1 + 4 > x0 && bx0 - 1 < x0 + wc && by1 + 4 > y0 && by0 - 1 < y0 + hc;
    }).sort(function(a, b) { return (a.y || 0) - (b.y || 0); });
    big.forEach(function(o) { OBJ[o.k](ctx, self, o); });
    ctx.restore();
  };

  // Нарисовать кусок карты
  Terrain.prototype.render = function(ctx, x0, y0, wc, hc, ppc) {
    var img = ctx.createImageData(Math.round(wc * ppc), Math.round(hc * ppc));
    this.pixels(img, x0, y0, wc, hc, ppc);
    ctx.putImageData(img, 0, 0);
    this.things(ctx, x0, y0, wc, hc, ppc);
  };
  // Кусок в кэше: холст CH×CH клеток при данной плотности
  Terrain.prototype.chunk = function(cx, cy, ppc, CH) {
    var key = ppc + ':' + cx + ':' + cy, c = this.cache[key];
    if (c) { c.used = Date.now(); return c; }
    c = document.createElement('canvas');
    c.width = c.height = CH * ppc;
    this.render(c.getContext('2d'), cx * CH, cy * CH, CH, CH, ppc);
    c.used = Date.now();
    this.cache[key] = c;
    var keys = Object.keys(this.cache);
    var MAX = this.cacheMax || 48;
    if (keys.length > MAX) {
      var self = this;
      keys.sort(function(a, b) { return self.cache[a].used - self.cache[b].used; }).slice(0, keys.length - MAX).forEach(function(k) { delete self.cache[k]; });
    }
    return c;
  };

  root.GTerrain = {
    create: function(json) { return new Terrain(json); },
    rgb: rgb, css: css
  };
})(typeof self !== 'undefined' ? self : this);
