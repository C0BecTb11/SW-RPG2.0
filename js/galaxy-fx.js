// Галактическая карта: живой космос вокруг планет. ES5.
//
// Слои снизу вверх:
//   #gx-sky       — звёзды в экранных координатах, три слоя с параллаксом (дальние сдвигаются медленнее);
//   .gx-nebula    — туманности и свет Глубинного Ядра, мир, рисуется один раз шумом (без плитки и швов);
//   .gx-terr      — территории фракций: поле влияния планет, ярче у границ и у линии фронта;
//   .gx-lanes     — гиперлинии (SVG, вектор — чёткие при любом зуме), цвет по хозяевам концов, линия фронта;
//   .gx-fx        — трафик по гиперлиниям, стычки на линиях фронта, следы перелётов командиров.
//                   Холст размером с экран, но вложен в мир с обратным преобразованием: так он стоит
//                   под планетами, а рисовать приходится только видимое.
// Планеты, подписи и ракеты остаются за js/planets.js; он зовёт gxFxInit / gxFxView / gxFxFaction.
// Пока карту закрывает панель или вкладка скрыта — ничего не рисуется. «Меньше движения» в системе —
// без трафика и мерцания.
(function() {
  'use strict';

  var COL = { republic: [74, 144, 217], cis: [217, 74, 74] };
  var OWN = [95, 217, 104], ALLY = [74, 144, 217];   // как фишки командиров в js/planets.js
  var RM = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  var DPR = Math.min(window.devicePixelRatio || 1, 2);
  // Холст трафика перерисовывается 30 раз в секунду — в плотности 1×: огоньки мягкие, разницы не видно,
  // а пикселей вчетверо меньше. Звёздный холст рисуется только при сдвиге карты — ему можно чётко.
  var FX_DPR = 1;
  var SVGNS = 'http://www.w3.org/2000/svg';

  var scroll = null, area = null;
  var sky = null, skyCtx = null, fx = null, fxCtx = null;
  var neb = null, terr = null, lanesSvg = null;
  var W = 2600, H = 1500, vw = 0, vh = 0;
  var data = null;              // { systems, lanes, pos, fac, caps }
  var lanes = [];               // { a, b, ax, ay, bx, by, len, kind: 'own'|'front'|'none', fa, fb }
  var parts = [];
  var viewDirty = true, lastK = -1, lastMk = -1;
  var running = false, lastFx = 0, lastT = 0;
  var intro = false, tickErr = false, frameNo = 0, syncFrame = -1, lastSize = 0, coveredCls = false;

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function smooth(a, b, x) { var t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }
  function rgba(c, a) { return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')'; }
  function light(c, k) { return [Math.round(c[0] + (255 - c[0]) * k), Math.round(c[1] + (255 - c[1]) * k), Math.round(c[2] + (255 - c[2]) * k)]; }

  // Детерминированный генератор: у всех игроков одна и та же галактика
  function rng(seed) {
    var a = seed >>> 0;
    return function() {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function view() {
    return {
      s: typeof galaxyScale === 'number' ? galaxyScale : 1,
      x: typeof galaxyPanX === 'number' ? galaxyPanX : 0,
      y: typeof galaxyPanY === 'number' ? galaxyPanY : 0
    };
  }

  function covered(now) {
    var c = document.hidden || (typeof isMapCovered === 'function' ? isMapCovered(now) : false);
    // под панелью и «дыхание» фронта стоит
    if (c !== coveredCls) { coveredCls = c; document.body.classList.toggle('gx-covered', c); }
    return c;
  }

  // ── Каркас ────────────────────────────────────────────────────────

  function setup() {
    scroll = document.getElementById('map-scroll');
    area = document.getElementById('map-area');
    if (!scroll || !area || sky) return;

    sky = document.createElement('canvas');
    sky.id = 'gx-sky';
    scroll.insertBefore(sky, scroll.firstChild);
    skyCtx = sky.getContext('2d');

    neb = document.createElement('canvas');
    neb.className = 'gx-nebula';
    terr = document.createElement('canvas');
    terr.className = 'gx-terr';
    lanesSvg = document.createElementNS(SVGNS, 'svg');
    lanesSvg.setAttribute('class', 'gx-lanes');
    fx = document.createElement('canvas');
    fx.className = 'gx-fx';
    fxCtx = fx.getContext('2d');

    var first = area.firstChild;
    [neb, terr, lanesSvg, fx].forEach(function(el) { area.insertBefore(el, first); });

    document.body.classList.add('gx-on');
    try { intro = !sessionStorage.getItem('gx-intro'); sessionStorage.setItem('gx-intro', '1'); } catch (e) { intro = false; }
    if (intro && !RM) document.body.classList.add('gx-intro');

    makeStars();
    resize();
    window.addEventListener('resize', function() { resize(); });
    window.addEventListener('orientationchange', function() { setTimeout(resize, 200); });
    document.addEventListener('visibilitychange', function() { viewDirty = true; });
    start();
  }

  function resize() {
    vw = scroll.clientWidth; vh = scroll.clientHeight;
    // большой экран с плотными пикселями — звёздный холст не больше ~4 Мпикс
    DPR = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(4e6 / Math.max(1, vw * vh)));
    sky.width = Math.round(vw * DPR); sky.height = Math.round(vh * DPR);
    sky.style.width = vw + 'px'; sky.style.height = vh + 'px';
    fx.width = Math.round(vw * FX_DPR); fx.height = Math.round(vh * FX_DPR);
    fx.style.width = vw + 'px'; fx.style.height = vh + 'px';
    viewDirty = true;
    syncView();
  }

  // Камера сдвинулась: холст трафика держим ровно на экране, подписи — в своём размере
  function syncView() {
    if (!area || !fx) return;
    var v = view();
    fx.style.transform = 'scale(' + (1 / v.s) + ') translate(' + (-v.x) + 'px,' + (-v.y) + 'px)';
    var k = Math.round(clamp(1 / v.s, 0.55, 2.4) * 100) / 100;
    if (k !== lastK) { lastK = k; area.style.setProperty('--gx-k', k); }
    var mk = Math.round(clamp(0.85 / v.s, 0.75, 1.8) * 100) / 100;
    if (mk !== lastMk) { lastMk = mk; area.style.setProperty('--gx-mk', mk); }
    // Перерисовка сразу, в том же кадре, что и сдвиг мира: отложенная на кадр отставала бы от планет и ракет —
    // след перелёта «отрывался» от ракеты, если камеру двигает кадровый цикл. Но не чаще раза за кадр:
    // касания на 120-герцевых экранах приходят чаще кадров — лишние сдвиги дорисует ближайший кадр.
    if (syncFrame !== frameNo && vw > 0) {
      var now = window.performance ? performance.now() : Date.now();
      if (!covered(now)) {
        syncFrame = frameNo;
        drawSky();
        drawFx(now, 0); lastFx = now;
        viewDirty = false;
        return;
      }
    }
    viewDirty = true;
  }

  // Размер окна карты и мира — раз в полсекунды: карту прячут (экран ожидания фракции), мир расширяют
  // в настройках, а событие resize в эти моменты не приходит
  function checkSize() {
    if (scroll.clientWidth !== vw || scroll.clientHeight !== vh) { if (scroll.clientWidth > 0) resize(); }
    if (data && area.offsetWidth > 0 && (area.offsetWidth !== W || area.offsetHeight !== H)) build();
  }

  window.gxFxView = function() {
    try { syncView(); } catch (e) { console.error('Галактика:', e); }
  };

  // ── Звёзды ────────────────────────────────────────────────────────
  // Три слоя, у каждого своя плитка (разные размеры — повтор не заметен) и своя доля сдвига.

  var LAYERS = [
    { T: 613,  n: 560, f: 0.10, z: 0.12, r0: 0.8, r1: 1.3, a0: 0.3, a1: 0.85, seed: 11 },
    { T: 797,  n: 170, f: 0.22, z: 0.25, r0: 0.8,  r1: 1.5, a0: 0.45, a1: 0.95, seed: 23 },
    { T: 1031, n: 24,  f: 0.40, z: 0.45, bright: true, seed: 37 }
  ];
  var sprites = {};

  function starSprite(c) {
    var key = c.join(',');
    if (sprites[key]) return sprites[key];
    var s = document.createElement('canvas'), n = 48;
    s.width = s.height = n;
    var g = s.getContext('2d'), m = n / 2;
    var gr = g.createRadialGradient(m, m, 0, m, m, m);
    gr.addColorStop(0, 'rgba(255,255,255,1)');
    gr.addColorStop(0.08, rgba(c, 0.95));
    gr.addColorStop(0.25, rgba(c, 0.28));
    gr.addColorStop(1, rgba(c, 0));
    g.fillStyle = gr; g.fillRect(0, 0, n, n);
    // лучи
    g.globalCompositeOperation = 'lighter';
    var lg = g.createLinearGradient(0, m, n, m);
    lg.addColorStop(0, rgba(c, 0)); lg.addColorStop(0.5, rgba(c, 0.55)); lg.addColorStop(1, rgba(c, 0));
    g.fillStyle = lg; g.fillRect(0, m - 0.5, n, 1);
    lg = g.createLinearGradient(m, 0, m, n);
    lg.addColorStop(0, rgba(c, 0)); lg.addColorStop(0.5, rgba(c, 0.55)); lg.addColorStop(1, rgba(c, 0));
    g.fillStyle = lg; g.fillRect(m - 0.5, 0, 1, n);
    sprites[key] = s;
    return s;
  }

  function makeStars() {
    LAYERS.forEach(function(L) {
      var r = rng(L.seed), list = [];
      for (var i = 0; i < L.n; i++) {
        var t = r(), c;
        c = t < 0.62 ? [205, 222, 255] : t < 0.86 ? [255, 244, 228] : t < 0.96 ? [255, 214, 170] : [255, 170, 150];
        list.push({
          x: r() * L.T, y: r() * L.T,
          rad: L.bright ? 9 + r() * 12 : L.r0 + r() * (L.r1 - L.r0),
          a: L.bright ? 0.55 + r() * 0.45 : L.a0 + r() * (L.a1 - L.a0),
          c: c, col: rgba(c, 1),
          tw: 0.6 + r() * 1.8, ph: r() * 6.283
        });
      }
      L.stars = list;
      if (L.bright) list.forEach(function(st) { st.sp = starSprite(st.c); });
    });
  }

  // Дальние слои — на звёздном холсте (неподвижны, пока стоит карта), яркие мерцающие — на холсте трафика
  function drawSky() {
    var g = skyCtx;
    g.setTransform(DPR, 0, 0, DPR, 0, 0);
    g.clearRect(0, 0, vw, vh);
    drawStars(g, 0, 0, 2);
  }

  function drawStars(g, t, from, to) {
    var v = view();
    for (var li = from; li < to; li++) {
      var L = LAYERS[li];
      var zf = 1 + (v.s - 1) * L.z;
      var T = L.T * zf;
      var ox = ((v.x * L.f) % T + T) % T - T, oy = ((v.y * L.f) % T + T) % T - T;
      for (var ty = oy; ty < vh; ty += T) {
        for (var tx = ox; tx < vw; tx += T) {
          for (var i = 0; i < L.stars.length; i++) {
            var st = L.stars[i];
            var x = tx + st.x * zf, y = ty + st.y * zf;
            if (x < -24 || y < -24 || x > vw + 24 || y > vh + 24) continue;
            var a = st.a;
            if (!RM && L.bright) a *= 0.66 + 0.34 * Math.sin(t * 0.001 * st.tw + st.ph);
            g.globalAlpha = a;
            if (L.bright) {
              var d = st.rad * clamp(zf, 0.7, 1.6);
              g.drawImage(st.sp, x - d / 2, y - d / 2, d, d);
            } else {
              g.fillStyle = st.col;
              var rr = st.rad * clamp(zf, 0.8, 1.5);
              g.fillRect(x - rr / 2, y - rr / 2, rr, rr);
            }
          }
        }
      }
    }
    g.globalAlpha = 1;
  }

  // ── Шум для туманностей ───────────────────────────────────────────

  var PERM = null, VAL = null;
  function noiseInit() {
    var r = rng(4242);
    PERM = new Uint16Array(512); VAL = new Float32Array(256);
    var p = [], i;
    for (i = 0; i < 256; i++) { p.push(i); VAL[i] = r(); }
    for (i = 255; i > 0; i--) { var j = Math.floor(r() * (i + 1)), tmp = p[i]; p[i] = p[j]; p[j] = tmp; }
    for (i = 0; i < 512; i++) PERM[i] = p[i & 255];
  }
  function vn(x, y) {
    var xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    xi &= 255; yi &= 255;
    var u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    var a = VAL[PERM[PERM[xi] + yi]], b = VAL[PERM[PERM[xi + 1] + yi]];
    var c = VAL[PERM[PERM[xi] + yi + 1]], d = VAL[PERM[PERM[xi + 1] + yi + 1]];
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }
  function fbm(x, y, oct) {
    var s = 0, amp = 0.5, norm = 0;
    for (var o = 0; o < oct; o++) {
      s += amp * vn(x, y); norm += amp;
      // поворот между октавами — без «сетки» в узоре
      var nx = x * 1.6 - y * 1.2 + 17.3, ny = x * 1.2 + y * 1.6 + 5.1;
      x = nx; y = ny; amp *= 0.5;
    }
    return s / norm;
  }

  // ── Туманности ────────────────────────────────────────────────────
  // Глубинное Ядро — за левым краем карты (за Корусантом): оттуда свет и галактический рукав
  // к Внешнему Кольцу справа. Шум с искажением даёт облака, второй шум — тёмные пылевые прожилки.

  var nebJob = 0;

  function buildNebula() {
    var job = ++nebJob;
    var Q = 4, NW = Math.ceil(W / Q), NH = Math.ceil(H / Q);
    var small = document.createElement('canvas');
    small.width = NW; small.height = NH;
    var sg = small.getContext('2d');
    var img = sg.createImageData(NW, NH), px = img.data;
    if (!PERM) noiseInit();

    var coreX = -W * 0.08, coreY = H * 0.56;
    // ось рукава: от ядра вправо и чуть вверх
    var ax = W * 1.1, ay = -H * 0.22, al = Math.sqrt(ax * ax + ay * ay);
    var nx = -ay / al, ny = ax / al;
    var bandW = H * 0.36;
    var row = 0;

    function step() {
      if (job !== nebJob) return;
      var t0 = Date.now();
      while (row < NH && Date.now() - t0 < 10) {
        for (var i = 0; i < NW; i++) {
          var wx = (i + 0.5) * Q, wy = (row + 0.5) * Q;
          var x = wx * 0.0015, y = wy * 0.0015;
          var qx = fbm(x + 1.7, y + 9.2, 3), qy = fbm(x + 8.3, y + 2.8, 3);
          var n = fbm(x + 2.1 * qx, y + 2.1 * qy, 5);
          var dx = wx - coreX, dy = wy - coreY;
          var d = Math.abs(dx * nx + dy * ny);
          var band = Math.exp(-(d * d) / (bandW * bandW));
          var along = Math.exp(-Math.max(0, dx) / (W * 1.1));
          // облака
          var dens = smooth(0.47, 0.82, n) * (0.22 + 0.78 * band) * (0.4 + 0.6 * along);
          // газовые волокна: гребни искажённого шума — тонкие светлые нити внутри облаков
          var rr = 1 - Math.abs(2 * fbm(x * 2.1 + qx * 1.6 + 3.1, y * 2.1 + qy * 1.6 + 7.7, 4) - 1);
          var fil = rr * rr * rr * rr * rr * rr * smooth(0.36, 0.72, n) * (0.35 + 0.65 * band);
          // тёмные пылевые прожилки поперёк рукава
          var dust = fbm(x * 3.4 + 4.1 + qy, y * 3.4 + 1.3 + qx, 4);
          var dk = 1 - 0.75 * smooth(0.5, 0.7, dust) * (0.25 + 0.75 * band);
          dens *= dk;
          var haze = band * along * 0.14 * dk;
          var hue = smooth(0.34, 0.66, fbm(x * 0.55 + 3.3, y * 0.55 + 5.5, 3));
          var mag = smooth(0.6, 0.78, fbm(x * 1.05 + 9.1, y * 1.05 + 0.7, 3));
          // бирюза → индиго, пурпурные языки; волокна — к холодно-белому
          var r = 26 + 74 * hue, gg = 112 - 58 * hue, b = 162 + 16 * hue;
          r += (178 - r) * mag * 0.75; gg += (54 - gg) * mag * 0.75; b += (138 - b) * mag * 0.75;
          var hot = clamp(fil * 1.6 + smooth(0.7, 0.98, n) * band * 0.5, 0, 1);
          r += (196 - r) * hot * 0.7; gg += (226 - gg) * hot * 0.7; b += (255 - b) * hot * 0.7;
          // свет Ядра — тёплый, у левого края
          var core = Math.exp(-(dx * dx + dy * dy * 1.6) / (W * W * 0.10));
          r += (255 - r) * core * 0.55; gg += (228 - gg) * core * 0.55; b += (196 - b) * core * 0.55;
          var edge = smooth(0, 280, Math.min(wx, wy, W - wx, H - wy));
          var a = clamp(dens * 0.85 + fil * 0.6 * dk + haze + core * 0.5, 0, 0.9) * edge;
          // газ светится, а не заслоняет: непрозрачность не выше 0,5, яркость добираем цветом —
          // звёзды дальнего плана просвечивают сквозь туманность
          var a2 = Math.min(a, 0.5), boost = a2 > 0 ? a / a2 : 1;
          var k = (row * NW + i) * 4;
          px[k] = Math.min(255, r * boost); px[k + 1] = Math.min(255, gg * boost); px[k + 2] = Math.min(255, b * boost); px[k + 3] = a2 * 255;
        }
        row++;
      }
      if (row < NH) { requestAnimationFrame(step); return; }

      sg.putImageData(img, 0, 0);
      neb.width = Math.round(W / 2); neb.height = Math.round(H / 2);
      neb.style.width = W + 'px'; neb.style.height = H + 'px';
      var g = neb.getContext('2d');
      g.imageSmoothingEnabled = true;
      if ('imageSmoothingQuality' in g) g.imageSmoothingQuality = 'high';
      g.clearRect(0, 0, neb.width, neb.height);
      g.drawImage(small, 0, 0, neb.width, neb.height);
      neb.classList.add('on');
    }
    requestAnimationFrame(step);
  }

  // ── Территории и фронт ────────────────────────────────────────────
  // Влияние планеты — гауссово пятно. Клетка принадлежит фракции с большим влиянием.
  // Заливка слабая, к краю территории и к фронту — ярче (как полоса границы у державы).

  var SIGMA = 165, G = 10, FAR = SIGMA * 3;
  var frontPath = '';

  function field(gx, gy) {
    var acc = {}, wx = gx * G, wy = gy * G;
    for (var i = 0; i < data.systems.length; i++) {
      var s = data.systems[i], f = data.fac[s.id];
      if (!COL[f]) continue;
      var p = data.pos[s.id], dx = wx - p.x, dy = wy - p.y;
      if (dx > FAR || dx < -FAR || dy > FAR || dy < -FAR) continue;   // дальше 3σ — вклад ничтожен
      var w = Math.exp(-(dx * dx + dy * dy) / (2 * SIGMA * SIGMA)) * (data.caps[s.id] ? 1.25 : 1);
      acc[f] = (acc[f] || 0) + w;
    }
    return acc;
  }

  function buildTerritory() {
    var GW = Math.ceil(W / G) + 1, GH = Math.ceil(H / G) + 1;
    var small = document.createElement('canvas');
    small.width = GW; small.height = GH;
    var sg = small.getContext('2d');
    var img = sg.createImageData(GW, GH), px = img.data;
    var facs = Object.keys(COL), diff = new Float32Array(GW * GH), mx = new Float32Array(GW * GH);
    var TH = 0.26;

    for (var gy = 0; gy < GH; gy++) {
      for (var gx = 0; gx < GW; gx++) {
        var acc = field(gx, gy), best = null, b1 = 0, b2 = 0;
        for (var fi = 0; fi < facs.length; fi++) {
          var v = acc[facs[fi]] || 0;
          if (v > b1) { b2 = b1; b1 = v; best = facs[fi]; } else if (v > b2) b2 = v;
        }
        var idx = gy * GW + gx;
        diff[idx] = (acc.republic || 0) - (acc.cis || 0);
        mx[idx] = b1;
        if (!best) continue;
        var inside = smooth(TH - 0.06, TH + 0.05, b1);
        var rim = Math.exp(-Math.pow((b1 - TH) / 0.05, 2));
        var front = b2 > 0.1 ? Math.exp(-(b1 - b2) / 0.09) * inside : 0;
        // у краёв мира заливка сходит на нет — при отдалении нет резкого прямоугольника
        var ex = gx * G, ey = gy * G;
        var wedge = smooth(0, 160, Math.min(ex, ey, W - ex, H - ey));
        var a = (inside * (0.055 + 0.045 * smooth(0.4, 1.4, b1)) + rim * 0.26 + front * 0.30) * wedge;
        // цвет — смесь фракций с резким перевесом сильной: граница цвета гладкая, без ступенек сетки
        var cr = 0, cg = 0, cb = 0, ws = 0;
        for (fi = 0; fi < facs.length; fi++) {
          var vf = (acc[facs[fi]] || 0) / b1;
          if (vf <= 0) continue;
          vf *= vf; vf *= vf; vf *= vf;
          var cf = COL[facs[fi]];
          cr += cf[0] * vf; cg += cf[1] * vf; cb += cf[2] * vf; ws += vf;
        }
        var c = light([cr / ws, cg / ws, cb / ws], 0.18 + 0.25 * Math.max(rim, front));
        var k = idx * 4;
        px[k] = c[0]; px[k + 1] = c[1]; px[k + 2] = c[2]; px[k + 3] = clamp(a, 0, 0.55) * 255;
      }
    }
    sg.putImageData(img, 0, 0);
    terr.width = Math.round(W / 2); terr.height = Math.round(H / 2);
    terr.style.width = W + 'px'; terr.style.height = H + 'px';
    var g = terr.getContext('2d');
    g.imageSmoothingEnabled = true;
    if ('imageSmoothingQuality' in g) g.imageSmoothingQuality = 'high';
    g.clearRect(0, 0, terr.width, terr.height);
    g.drawImage(small, 0, 0, GW - 1, GH - 1, 0, 0, (GW - 1) * G / 2, (GH - 1) * G / 2);

    // Линия фронта — изолиния «влияния поровну», только там, где обе стороны реально присутствуют
    var segs = [];
    function interp(a, b) { return a / (a - b); }
    for (gy = 0; gy < GH - 1; gy++) {
      for (gx = 0; gx < GW - 1; gx++) {
        var i0 = gy * GW + gx, i1 = i0 + 1, i2 = i0 + GW + 1, i3 = i0 + GW;
        if (Math.min(mx[i0], mx[i1], mx[i2], mx[i3]) < TH) continue;
        var v0 = diff[i0], v1 = diff[i1], v2 = diff[i2], v3 = diff[i3];
        var pts = [];
        if ((v0 > 0) !== (v1 > 0)) pts.push([gx + interp(v0, v1), gy]);
        if ((v1 > 0) !== (v2 > 0)) pts.push([gx + 1, gy + interp(v1, v2)]);
        if ((v3 > 0) !== (v2 > 0)) pts.push([gx + interp(v3, v2), gy + 1]);
        if ((v0 > 0) !== (v3 > 0)) pts.push([gx, gy + interp(v0, v3)]);
        if (pts.length >= 2) segs.push(pts[0], pts[1]);
        if (pts.length === 4) segs.push(pts[2], pts[3]);
      }
    }
    frontPath = joinSegments(segs);
  }

  // Отрезки изолинии склеиваем в ломаные — так пунктир идёт ровно, а путь короче
  function joinSegments(segs) {
    var key = function(p) { return Math.round(p[0] * 100) + ':' + Math.round(p[1] * 100); };
    var adj = {}, used = [], i;
    for (i = 0; i < segs.length; i += 2) {
      var ka = key(segs[i]), kb = key(segs[i + 1]);
      (adj[ka] = adj[ka] || []).push(i);
      (adj[kb] = adj[kb] || []).push(i);
      used.push(false);
    }
    var out = [];
    function other(si, k) { return key(segs[si]) === k ? segs[si + 1] : segs[si]; }
    for (i = 0; i < segs.length; i += 2) {
      if (used[i / 2]) continue;
      used[i / 2] = true;
      var line = [segs[i], segs[i + 1]];
      // в обе стороны
      for (var dir = 0; dir < 2; dir++) {
        var guard = 0;
        while (guard++ < 5000) {
          var end = dir ? line[0] : line[line.length - 1], k = key(end), nxt = -1;
          var cand = adj[k] || [];
          for (var c = 0; c < cand.length; c++) if (!used[cand[c] / 2]) { nxt = cand[c]; break; }
          if (nxt < 0) break;
          used[nxt / 2] = true;
          var p = other(nxt, k);
          if (dir) line.unshift(p); else line.push(p);
        }
      }
      if (line.length < 3) continue;
      out.push('M' + line.map(function(p) { return (p[0] * G).toFixed(1) + ' ' + (p[1] * G).toFixed(1); }).join('L'));
    }
    return out.join('');
  }

  // ── Гиперлинии ────────────────────────────────────────────────────

  function laneKind(fa, fb) {
    if (!COL[fa] || !COL[fb]) return 'none';
    return fa === fb ? 'own' : 'front';
  }

  function buildLanes() {
    var seen = {};
    lanes = [];
    data.lanes.forEach(function(l) {
      var a = data.pos[l.system_a], b = data.pos[l.system_b];
      if (!a || !b) return;
      var k = l.system_a < l.system_b ? l.system_a + '|' + l.system_b : l.system_b + '|' + l.system_a;
      if (seen[k]) return;
      seen[k] = true;
      var dx = b.x - a.x, dy = b.y - a.y, len = Math.sqrt(dx * dx + dy * dy);
      if (len < 1) return;
      lanes.push({ a: l.system_a, b: l.system_b, ax: a.x, ay: a.y, bx: b.x, by: b.y, len: len, ux: dx / len, uy: dy / len });
    });
    paintLanes();
    makeParts();
  }

  // Где линия упирается в планету: край атмосферы, у столицы — за кольцом
  function rimOf(id) {
    var r = Math.round((data.rad[id] || 14) * (typeof PLANET_SCALE === 'number' ? PLANET_SCALE : 1.3));
    return data.caps[id] ? (r + 4) * 1.6 + 8 : r + 8;
  }

  function paintLanes() {
    while (lanesSvg.firstChild) lanesSvg.removeChild(lanesSvg.firstChild);
    lanesSvg.setAttribute('width', W); lanesSvg.setAttribute('height', H);
    lanesSvg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    var defs = document.createElementNS(SVGNS, 'defs');
    lanesSvg.appendChild(defs);

    // Фронт — под гиперлиниями
    var fg = document.createElementNS(SVGNS, 'g');
    fg.setAttribute('class', 'gx-front-g');
    lanesSvg.appendChild(fg);
    paintFront();

    var order = lanes.slice().sort(function(p, q) { return (p.ax + p.bx) - (q.ax + q.bx); });
    order.forEach(function(l, n) {
      l.fa = data.fac[l.a]; l.fb = data.fac[l.b];
      l.kind = laneKind(l.fa, l.fb);
      var ca = COL[l.fa] ? light(COL[l.fa], 0.3) : [143, 168, 196];
      var cb = COL[l.fb] ? light(COL[l.fb], 0.3) : [143, 168, 196];
      var id = 'gxl' + n;
      var gr = document.createElementNS(SVGNS, 'linearGradient');
      gr.setAttribute('id', id);
      gr.setAttribute('gradientUnits', 'userSpaceOnUse');
      gr.setAttribute('x1', l.ax); gr.setAttribute('y1', l.ay);
      gr.setAttribute('x2', l.bx); gr.setAttribute('y2', l.by);
      [[0, ca], [0.5, l.kind === 'front' ? [235, 225, 245] : ca], [1, cb]].forEach(function(s, si) {
        var stop = document.createElementNS(SVGNS, 'stop');
        stop.setAttribute('offset', s[0]);
        stop.setAttribute('stop-color', 'rgb(' + s[1].join(',') + ')');
        if (si === 1 && l.kind === 'front') stop.setAttribute('stop-opacity', '0.9');
        gr.appendChild(stop);
      });
      defs.appendChild(gr);

      // концы — у края планеты, а не в её центре
      var ra = rimOf(l.a), rb = rimOf(l.b);
      if (l.len < ra + rb + 6) return;                 // планеты почти касаются — линия не нужна
      var x1 = l.ax + l.ux * ra, y1 = l.ay + l.uy * ra, x2 = l.bx - l.ux * rb, y2 = l.by - l.uy * rb;
      ['halo', 'glow', 'core'].forEach(function(part) {
        var ln = document.createElementNS(SVGNS, 'line');
        ln.setAttribute('x1', x1.toFixed(1)); ln.setAttribute('y1', y1.toFixed(1));
        ln.setAttribute('x2', x2.toFixed(1)); ln.setAttribute('y2', y2.toFixed(1));
        ln.setAttribute('stroke', 'url(#' + id + ')');
        ln.setAttribute('class', 'gx-lane-' + part + ' k-' + l.kind);
        if (part === 'core' && document.body.classList.contains('gx-intro')) {
          var L = Math.max(1, l.len - ra - rb);
          ln.style.strokeDasharray = L + ' ' + L;
          ln.style.strokeDashoffset = L;
          ln.style.animationDelay = (0.25 + (l.ax + l.bx) / 2 / W * 1.1).toFixed(2) + 's';
        }
        lanesSvg.appendChild(ln);
      });
    });
  }

  function paintFront() {
    var fg = lanesSvg.querySelector('.gx-front-g');
    if (!fg) return;
    while (fg.firstChild) fg.removeChild(fg.firstChild);
    if (!frontPath) return;
    ['gx-front-glow', 'gx-front'].forEach(function(cls) {
      var fp = document.createElementNS(SVGNS, 'path');
      fp.setAttribute('d', frontPath);
      fp.setAttribute('class', cls);
      fg.appendChild(fp);
    });
  }

  // ── Трафик и стычки ───────────────────────────────────────────────

  function makeParts() {
    parts = [];
    var r = rng(991);
    lanes.forEach(function(l, i) {
      if (l.kind === 'own') {
        var n = l.len > 420 ? 2 : 1;
        for (var k = 0; k < n; k++) {
          parts.push({ l: l, own: true, dir: r() < 0.5 ? 1 : -1, t: r(), v: (24 + r() * 26) / l.len, c: light(COL[l.fa], 0.45) });
        }
      } else if (l.kind === 'front') {
        // с каждой стороны к середине идёт свой огонёк, встреча — вспышка
        var ph = r();
        parts.push({ l: l, clash: true, ph: ph, per: 3.2 + r() * 1.6, ca: light(COL[l.fa], 0.4), cb: light(COL[l.fb], 0.4) });
      }
    });
  }

  var dotSprites = {};
  function dot(c) {
    var key = c.join(',');
    if (dotSprites[key]) return dotSprites[key];
    var s = document.createElement('canvas'), n = 32, m = 16;
    s.width = s.height = n;
    var g = s.getContext('2d');
    var gr = g.createRadialGradient(m, m, 0, m, m, m);
    gr.addColorStop(0, 'rgba(255,255,255,1)');
    gr.addColorStop(0.18, rgba(c, 0.9));
    gr.addColorStop(0.45, rgba(c, 0.25));
    gr.addColorStop(1, rgba(c, 0));
    g.fillStyle = gr; g.fillRect(0, 0, n, n);
    dotSprites[key] = s;
    return s;
  }

  function drawFx(t, dt) {
    var g = fxCtx, v = view(), s = v.s;
    g.setTransform(FX_DPR, 0, 0, FX_DPR, 0, 0);
    g.clearRect(0, 0, vw, vh);
    drawStars(g, t, 2, 3);
    g.globalCompositeOperation = 'lighter';
    var ds = clamp(s, 0.45, 1.8);

    function sx(wx) { return v.x + wx * s; }
    function sy(wy) { return v.y + wy * s; }
    function vis(x, y) { return x > -40 && y > -40 && x < vw + 40 && y < vh + 40; }

    if (!RM) {
      for (var i = 0; i < parts.length; i++) {
        var p = parts[i], l = p.l;
        if (p.own) {
          p.t += p.v * dt;
          if (p.t > 1) p.t -= 1;
          var u = p.dir > 0 ? p.t : 1 - p.t;
          // у планет огонёк гаснет — «ныряет» в систему
          var fade = smooth(0, 0.08, u) * smooth(1, 0.92, u);
          var wx = l.ax + (l.bx - l.ax) * u, wy = l.ay + (l.by - l.ay) * u;
          var x = sx(wx), y = sy(wy);
          if (!vis(x, y)) continue;
          var tl = 18 * s, tx = -l.ux * p.dir * tl, ty = -l.uy * p.dir * tl;
          var tg = g.createLinearGradient(x + tx, y + ty, x, y);
          tg.addColorStop(0, rgba(p.c, 0));
          tg.addColorStop(1, rgba(p.c, 0.55 * fade));
          g.strokeStyle = tg; g.lineWidth = 1.4 * ds; g.lineCap = 'round';
          g.beginPath(); g.moveTo(x + tx, y + ty); g.lineTo(x, y); g.stroke();
          var d = 11 * ds;
          g.globalAlpha = fade;
          g.drawImage(dot(p.c), x - d / 2, y - d / 2, d, d);
          g.globalAlpha = 1;
        } else if (p.clash) {
          var ph = ((t / 1000) / p.per + p.ph) % 1;
          var mxw = (l.ax + l.bx) / 2, myw = (l.ay + l.by) / 2;
          var mx = sx(mxw), my = sy(myw);
          if (!vis(mx, my) && !vis(sx(l.ax), sy(l.ay)) && !vis(sx(l.bx), sy(l.by))) continue;
          if (ph < 0.7) {
            var k = ph / 0.7, e = k * k;
            // огонёк стороны A идёт от 25% длины к середине, B — навстречу
            var pa = 0.25 + 0.25 * e, pb = 0.75 - 0.25 * e;
            var axs = sx(l.ax + (l.bx - l.ax) * pa), ays = sy(l.ay + (l.by - l.ay) * pa);
            var bxs = sx(l.ax + (l.bx - l.ax) * pb), bys = sy(l.ay + (l.by - l.ay) * pb);
            var al = smooth(0, 0.2, k);
            var dd = 10 * ds;
            g.globalAlpha = al;
            g.drawImage(dot(p.ca), axs - dd / 2, ays - dd / 2, dd, dd);
            g.drawImage(dot(p.cb), bxs - dd / 2, bys - dd / 2, dd, dd);
            g.globalAlpha = 1;
          } else {
            var q = (ph - 0.7) / 0.3;
            var rr = (6 + 26 * q) * ds;
            g.globalAlpha = (1 - q) * 0.9;
            g.drawImage(dot([255, 236, 205]), mx - rr, my - rr, rr * 2, rr * 2);
            g.globalAlpha = 1;
          }
        }
      }
    }

    // Следы перелётов: светящийся хвост за ракетой и тонкий пунктир впереди — до цели
    var fl = window.activeFlights || [];
    if (fl.length && typeof serverNow === 'function') {
      var now = serverNow();
      for (var j = 0; j < fl.length; j++) {
        var f = fl[j];
        var tot = f.endMs - f.startMs;
        var pr = tot > 0 ? clamp((now - f.startMs) / tot, 0, 1) : 1;
        var fdx = f.to.x - f.from.x, fdy = f.to.y - f.from.y, flen = Math.sqrt(fdx * fdx + fdy * fdy) || 1;
        var hx = f.from.x + fdx * pr, hy = f.from.y + fdy * pr;
        var back = Math.min(pr * flen, 170) / flen;
        var tx0 = f.from.x + fdx * (pr - back), ty0 = f.from.y + fdy * (pr - back);
        var c = f.own ? OWN : ALLY;
        var X = sx(hx), Y = sy(hy), X0 = sx(tx0), Y0 = sy(ty0);
        g.globalCompositeOperation = 'source-over';
        g.setLineDash([3 * ds, 5 * ds]);
        g.strokeStyle = rgba(c, 0.32); g.lineWidth = 1 * ds;
        g.beginPath(); g.moveTo(X, Y); g.lineTo(sx(f.to.x), sy(f.to.y)); g.stroke();
        g.setLineDash([]);
        g.globalCompositeOperation = 'lighter';
        var trg = g.createLinearGradient(X0, Y0, X, Y);
        trg.addColorStop(0, rgba(c, 0));
        trg.addColorStop(0.7, rgba(light(c, 0.2), 0.35));
        trg.addColorStop(1, rgba(light(c, 0.6), 0.85));
        g.strokeStyle = trg; g.lineCap = 'round';
        g.lineWidth = 5 * ds; g.globalAlpha = 0.35;
        g.beginPath(); g.moveTo(X0, Y0); g.lineTo(X, Y); g.stroke();
        g.lineWidth = 1.6 * ds; g.globalAlpha = 1;
        g.beginPath(); g.moveTo(X0, Y0); g.lineTo(X, Y); g.stroke();
        var hd = (22 + 4 * Math.sin(t * 0.012)) * ds;
        g.drawImage(dot(light(c, 0.3)), X - hd / 2, Y - hd / 2, hd, hd);
      }
    }
    g.globalCompositeOperation = 'source-over';
    g.globalAlpha = 1;
  }

  // ── Цикл ──────────────────────────────────────────────────────────

  function start() {
    if (running) return;
    running = true;
    requestAnimationFrame(tick);
  }

  function tick(t) {
    requestAnimationFrame(tick);
    frameNo++;
    try {
      if (t - lastSize > 500) { lastSize = t; checkSize(); }
      var dt = lastT ? Math.min(0.1, (t - lastT) / 1000) : 0;
      // Кадр пропущен — время не копим, чтобы огоньки не прыгали
      if (viewDirty) {
        if (covered(t)) { lastT = t; return; }
        viewDirty = false;
        drawSky();
        drawFx(t, dt); lastFx = t; lastT = t;
        return;
      }
      // «Меньше движения»: огоньков нет, но след перелёта идёт за ракетой — пару раз в секунду
      if (RM) {
        lastT = t;
        if ((window.activeFlights || []).length && t - lastFx > 500 && !covered(t)) { drawFx(t, 0); lastFx = t; }
        return;
      }
      if (t - lastFx < 33 - 4) return;
      if (covered(t)) { lastT = t; return; }
      drawFx(t, dt); lastFx = t; lastT = t;
    } catch (e) {
      lastT = t;
      if (!tickErr) {
        tickErr = true;
        console.error('Галактика:', e);
        if (window.errReport) errReport(e, 'galaxy-fx.tick');
      }
    }
  }

  // ── Сборка по данным карты ────────────────────────────────────────

  function build() {
    W = area.offsetWidth || 2600; H = area.offsetHeight || 1500;
    buildNebula();
    buildTerritory();
    buildLanes();
    markPlanets();
    viewDirty = true;
  }

  // Столицы и планеты фронта (гиперлиния к чужой фракции)
  function markPlanets() {
    var front = {};
    lanes.forEach(function(l) { if (l.kind === 'front') { front[l.a] = 1; front[l.b] = 1; } });
    data.systems.forEach(function(s) {
      var w = document.querySelector('.planet-wrapper[data-planet-id="' + s.id + '"]');
      if (!w) return;
      w.classList.toggle('gx-front', !!front[s.id]);
      w.classList.toggle('gx-capital', !!data.caps[s.id]);
      if (data.caps[s.id] && !w.querySelector('.gx-ring')) {
        var ring = document.createElement('div');
        ring.className = 'gx-ring';
        w.insertBefore(ring, w.firstChild);
      }
      if (document.body.classList.contains('gx-intro')) {
        var c = w.querySelector('.planet-icon');
        if (c) c.style.animationDelay = (0.1 + data.pos[s.id].x / W * 1.1).toFixed(2) + 's';
      }
    });
  }

  // Вход закончился: снимаем покадровые стили вступления, иначе без анимации линии снова спрятались бы
  function endIntro() {
    document.body.classList.remove('gx-intro');
    var ls = lanesSvg.querySelectorAll('.gx-lane-core');
    for (var i = 0; i < ls.length; i++) { ls[i].style.strokeDasharray = ''; ls[i].style.strokeDashoffset = ''; ls[i].style.animationDelay = ''; }
    var ps = document.querySelectorAll('#galaxy-layer .planet-icon');
    for (i = 0; i < ps.length; i++) ps[i].style.animationDelay = '';
  }

  window.gxFxInit = function(systems, lanesIn, positions) {
    setup();
    if (!area) return;
    data = { systems: systems || [], lanes: lanesIn || [], pos: positions || {}, fac: {}, caps: {}, rad: {} };
    data.systems.forEach(function(s) { data.fac[s.id] = s.faction; data.rad[s.id] = s.radius; });
    if (intro) setTimeout(endIntro, 4200);   // до сборки: если она упадёт, вступление всё равно закончится
    build();
    // Столицы — из настроек игры (их же знают мятежи)
    supabase.from('game_settings').select('value').eq('key', 'unrest_capitals').maybeSingle().then(function(res) {
      if (res.error || !res.data || !res.data.value) return;
      String(res.data.value).split(',').forEach(function(id) { id = id.trim(); if (id) data.caps[id] = true; });
      buildTerritory(); paintLanes(); markPlanets();
    }, function() {});
  };

  // Планета сменила хозяина — граница и линии перестраиваются, территория вспыхивает
  // Несколько захватов подряд (волна realtime) — одна пересборка
  var facTimer = 0;
  window.gxFxFaction = function(id, faction) {
    if (!data || data.fac[id] === faction) return;
    data.fac[id] = faction;
    clearTimeout(facTimer);
    facTimer = setTimeout(function() {
      terr.classList.add('flash');
      buildTerritory(); paintLanes(); makeParts(); markPlanets();
      setTimeout(function() { terr.classList.remove('flash'); }, 60);
      viewDirty = true;
    }, 150);
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setup);
  else setup();
})();
