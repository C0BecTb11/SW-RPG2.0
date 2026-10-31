/* Гибель корабля: спрайт корабля раскалывается на обломки.
 *
 * Обломки режутся из той же картинки, что летает в бою: каждой точке спрайта
 * назначается ближайшее «зерно» (с шумом — края рваные), получается набор
 * кусков. Края разлома светятся раскалённым металлом и остывают; по корпусу
 * идут вторичные взрывы; куски расходятся и медленно вращаются, остаются
 * висеть остовом до конца боя.
 *
 * Три варианта (выбирается по кораблю и случаю):
 *   - «перелом»  — корпус ломается поперёк на 2–3 части, медленно расходятся;
 *   - «цепь»     — серия взрывов вдоль корпуса, потом распад на 4–5 частей;
 *   - «реактор»  — белая вспышка и ударная волна, 7–9 кусков разлетаются быстро
 *                  (всегда при взрыве реактора).
 */
(function(root) {
  'use strict';

  var TAU = Math.PI * 2, MAXPX = 640;          // длинная сторона нарезки, пикселей

  function rng(seed) {
    var s = (seed >>> 0) || 1;
    return function() { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  }

  // Нарезка: img/crop — спрайт; W, H — размер корабля в метрах (нос вверху)
  function cut(img, crop, W, H, variant, R, maxPx) {
    var cw = crop[2] - crop[0], ch = crop[3] - crop[1];
    var k = Math.min(1, (maxPx || MAXPX) / Math.max(cw, ch));
    var w = Math.max(8, Math.round(cw * k)), h = Math.max(8, Math.round(ch * k));
    var src = document.createElement('canvas'); src.width = w; src.height = h;
    var sc = src.getContext('2d');
    sc.drawImage(img, crop[0], crop[1], cw, ch, 0, 0, w, h);
    var data = sc.getImageData(0, 0, w, h).data;

    // зёрна кусков (в долях ширины/высоты)
    var seeds = [], i, n;
    if (variant === 'split') {
      n = 2 + (R() < 0.5 ? 1 : 0);
      for (i = 0; i < n; i++) seeds.push([0.5 + (R() - 0.5) * 0.2, (i + 0.5) / n + (R() - 0.5) * 0.12]);
    } else if (variant === 'chain') {
      n = 4 + (R() < 0.5 ? 1 : 0);
      for (i = 0; i < n; i++) seeds.push([0.3 + R() * 0.4, (i + 0.5) / n + (R() - 0.5) * 0.1]);
    } else {
      n = 7 + Math.floor(R() * 3);
      for (i = 0; i < n; i++) seeds.push([0.1 + R() * 0.8, 0.06 + R() * 0.88]);
    }
    // «перелом» и «цепь» режут поперёк: расстояние по длине важнее, чем по ширине
    var ax = variant === 'shatter' ? 1 : 0.35;
    // шум границ: несколько синусоид — рваный, но связный край
    var f1 = 6 + R() * 6, f2 = 13 + R() * 9, p1 = R() * TAU, p2 = R() * TAU, amp = variant === 'split' ? 0.07 : 0.05;
    var lab = new Int8Array(w * h), x, y;
    for (y = 0; y < h; y++) {
      var v = y / h;
      for (x = 0; x < w; x++) {
        var o = (y * w + x) * 4;
        if (data[o + 3] < 30) { lab[y * w + x] = -1; continue; }
        var u = x / w;
        var nu = u + amp * Math.sin(v * f1 * TAU / 4 + p1) * 0.6 + amp * 0.4 * Math.sin((u + v) * f2 + p2);
        var nv = v + amp * Math.sin(u * f1 + p2) + amp * 0.5 * Math.sin((u - v) * f2 * 1.3 + p1);
        var best = 0, bd = 1e9;
        for (i = 0; i < seeds.length; i++) {
          var dx = (nu - seeds[i][0]) * ax, dy = nv - seeds[i][1], d = dx * dx + dy * dy;
          if (d < bd) { bd = d; best = i; }
        }
        lab[y * w + x] = best;
      }
    }
    // куски: своя картинка (темнее, с копотью) и светящаяся кромка разлома
    var pieces = [];
    for (i = 0; i < seeds.length; i++) {
      var x0 = w, y0 = h, x1 = -1, y1 = -1, cnt = 0, sx = 0, sy = 0;
      for (y = 0; y < h; y++) for (x = 0; x < w; x++) if (lab[y * w + x] === i) {
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; cnt++; sx += x; sy += y;
      }
      if (cnt < 40) continue;
      var pw = x1 - x0 + 1, ph = y1 - y0 + 1;
      var cv = document.createElement('canvas'); cv.width = pw; cv.height = ph;
      var ec = document.createElement('canvas'); ec.width = pw; ec.height = ph;
      var c = cv.getContext('2d'), e = ec.getContext('2d');
      var id = c.createImageData(pw, ph), ed = e.createImageData(pw, ph), D = id.data, E = ed.data;
      for (y = y0; y <= y1; y++) for (x = x0; x <= x1; x++) {
        if (lab[y * w + x] !== i) continue;
        var so = (y * w + x) * 4, to = ((y - y0) * pw + (x - x0)) * 4;
        // опалённый металл: темнее и чуть теплее
        var burn = 0.55 + 0.25 * Math.sin(x * 0.07 + y * 0.05 + i);
        D[to] = data[so] * burn * 1.05; D[to + 1] = data[so + 1] * burn * 0.92; D[to + 2] = data[so + 2] * burn * 0.85; D[to + 3] = data[so + 3];
        // кромка: рядом соседний кусок (не пустота) — раскалённый край
        var edge = 0;
        for (var dd = 1; dd <= 3 && !edge; dd++) {
          var L = x - dd >= 0 ? lab[y * w + x - dd] : -1, Rr = x + dd < w ? lab[y * w + x + dd] : -1;
          var U = y - dd >= 0 ? lab[(y - dd) * w + x] : -1, Dn = y + dd < h ? lab[(y + dd) * w + x] : -1;
          if ((L >= 0 && L !== i) || (Rr >= 0 && Rr !== i) || (U >= 0 && U !== i) || (Dn >= 0 && Dn !== i)) edge = 4 - dd;
        }
        if (edge) { E[to] = 255; E[to + 1] = 120 + edge * 30; E[to + 2] = 40; E[to + 3] = 70 * edge; }
      }
      c.putImageData(id, 0, 0); e.putImageData(ed, 0, 0);
      // центр куска и размер — в метрах корабля (от центра, нос вверху)
      var mx = W / w, my = H / h;
      pieces.push({ cv: cv, edge: ec, cx: ((sx / cnt) - w / 2) * mx, cy: ((sy / cnt) - h / 2) * my,
                    x0: (x0 - w / 2) * mx, y0: (y0 - h / 2) * my, pw: pw * mx, ph: ph * my, mass: cnt / (w * h) });
    }
    return pieces;
  }

  // Новый остов: sh — корабль из боя; why — причина гибели
  // maxPx — длинная сторона нарезки (на слабой графике меньше: быстрее и легче в памяти)
  function make(sh, img, plan, why, t, maxPx) {
    var R = rng((sh.n + 1) * 7919 + Math.floor(t * 10));
    var variant = why === 'reactor' ? 'shatter' : R() < 0.5 ? 'split' : 'chain';
    var W = plan.w * plan.cellM, H = plan.h * plan.cellM;
    var pieces = cut(img, plan.crop, W, H, variant, R, maxPx);
    var fast = variant === 'shatter' ? 0.7 : variant === 'chain' ? 0.45 : 0.25;
    var hold = variant === 'chain' ? 2.2 : variant === 'split' ? 0.6 : 0;          // корпус ещё цел, пока идут взрывы
    var vx = Math.cos(sh.hd) * sh.v, vy = Math.sin(sh.hd) * sh.v;
    pieces.forEach(function(p) {
      var d = Math.sqrt(p.cx * p.cx + p.cy * p.cy) || 1;
      var sp = (8 + R() * 18) * fast * 3 / (0.5 + p.mass * 2);
      p.lvx = p.cx / d * sp + (R() - 0.5) * 6 * fast; p.lvy = p.cy / d * sp + (R() - 0.5) * 6 * fast;   // в осях корабля
      p.w = (R() - 0.5) * (variant === 'shatter' ? 0.5 : 0.12) / (0.4 + p.mass * 2);
      p.a = 0; p.ox = 0; p.oy = 0;
    });
    // вторичные взрывы по корпусу (в осях корабля, метры) и искры
    var booms = [], nB = variant === 'chain' ? 9 : variant === 'split' ? 5 : 3;
    for (var i = 0; i < nB; i++) {
      var along = variant === 'chain' ? (i / (nB - 1) - 0.5) * H * 0.85 : (R() - 0.5) * H * 0.7;
      booms.push({ x: (R() - 0.5) * W * 0.5, y: along, at: variant === 'chain' ? i * hold / nB : R() * 1.4, r: Math.min(W, H) * (0.18 + R() * 0.2) + 40 });
    }
    var sparks = [];
    for (i = 0; i < 46; i++) {
      var a = R() * TAU, s2 = (60 + R() * 220) * (variant === 'shatter' ? 1.6 : 1);
      sparks.push({ x: (R() - 0.5) * W * 0.4, y: (R() - 0.5) * H * 0.6, vx: Math.cos(a) * s2, vy: Math.sin(a) * s2, life: 1.5 + R() * 3, hot: R() < 0.6 });
    }
    return { n: sh.n, x: sh.x, y: sh.y, hd: sh.hd, vx: vx * 0.6, vy: vy * 0.6, t0: t, variant: variant, hold: hold,
             pieces: pieces, booms: booms, sparks: sparks, W: W, H: H };
  }

  // toS(x, y) → [px, py]; s — пикселей на метр; t — время боя
  function draw(c, wr, t, toS, s, vw, vh) {
    var age = t - wr.t0, i;
    if (age < 0) return;
    var mt = Math.max(0, age - wr.hold);                       // время с начала распада
    // общий дрейф остова: затухает
    var drift = (1 - Math.exp(-age / 20)) * 20;
    var cx = wr.x + wr.vx * drift, cy = wr.y + wr.vy * drift;
    var q = toS(cx, cy), R = Math.max(wr.W, wr.H) * s;
    if (q[0] < -R * 2 || q[0] > vw + R * 2 || q[1] < -R * 2 || q[1] > vh + R * 2) return;
    var co = Math.cos(wr.hd + Math.PI / 2), si = Math.sin(wr.hd + Math.PI / 2);
    var spread = (1 - Math.exp(-mt / 14)) * 14;                 // путь кусков с затуханием, с
    var glow = Math.max(0, 1 - age / 9);
    for (i = 0; i < wr.pieces.length; i++) {
      var p = wr.pieces[i];
      var lx = p.cx + p.lvx * spread, ly = p.cy + p.lvy * spread, ang = p.w * spread;
      // ось корабля → мир: нос (−y плана) смотрит по hd
      var wx = co * lx - si * ly, wy = si * lx + co * ly;
      var pq = [q[0] + wx * s, q[1] + wy * s];
      c.save();
      c.translate(pq[0], pq[1]); c.rotate(wr.hd + Math.PI / 2 + ang); c.scale(s, s);
      c.translate(-p.cx, -p.cy);
      c.drawImage(p.cv, p.x0, p.y0, p.pw, p.ph);
      if (glow > 0) {
        c.globalCompositeOperation = 'lighter'; c.globalAlpha = glow * (0.75 + 0.25 * Math.sin(t * 9 + i));
        c.drawImage(p.edge, p.x0, p.y0, p.pw, p.ph);
        c.globalCompositeOperation = 'source-over'; c.globalAlpha = 1;
      }
      c.restore();
    }
    c.save(); c.globalCompositeOperation = 'lighter';
    // вспышка и ударная волна (реактор — белая и большая)
    if (age < 1.6) {
      var big = wr.variant === 'shatter', k = age / 1.6, rr = Math.max(wr.W, wr.H) * s * (big ? 1.4 : 0.8) * (0.3 + k);
      var g = c.createRadialGradient(q[0], q[1], 0, q[0], q[1], rr);
      g.addColorStop(0, big ? 'rgba(255,255,245,' + (1 - k) + ')' : 'rgba(255,220,150,' + (0.8 * (1 - k)) + ')');
      g.addColorStop(0.4, 'rgba(255,150,60,' + (0.5 * (1 - k)) + ')');
      g.addColorStop(1, 'rgba(255,80,20,0)');
      c.fillStyle = g; c.beginPath(); c.arc(q[0], q[1], rr, 0, TAU); c.fill();
      if (big) {
        c.strokeStyle = 'rgba(200,230,255,' + (0.7 * (1 - k)) + ')'; c.lineWidth = 2 + 6 * (1 - k);
        c.beginPath(); c.arc(q[0], q[1], Math.max(wr.W, wr.H) * s * (0.4 + 2.2 * k), 0, TAU); c.stroke();
      }
    }
    // вторичные взрывы
    for (i = 0; i < wr.booms.length; i++) {
      var b = wr.booms[i], bt = age - b.at; if (bt < 0 || bt > 1.1) continue;
      var bk = bt / 1.1, bwx = co * b.x - si * b.y, bwy = si * b.x + co * b.y, bq = [q[0] + bwx * s, q[1] + bwy * s];
      var br = Math.max(6, b.r * s * (0.4 + bk));
      var g2 = c.createRadialGradient(bq[0], bq[1], 0, bq[0], bq[1], br);
      g2.addColorStop(0, 'rgba(255,240,200,' + (0.9 * (1 - bk)) + ')');
      g2.addColorStop(0.35, 'rgba(255,140,50,' + (0.6 * (1 - bk)) + ')');
      g2.addColorStop(1, 'rgba(120,40,10,0)');
      c.fillStyle = g2; c.beginPath(); c.arc(bq[0], bq[1], br, 0, TAU); c.fill();
    }
    // искры и мелкие обломки
    for (i = 0; i < wr.sparks.length; i++) {
      var sp = wr.sparks[i]; if (age > sp.life) continue;
      var sk = age / sp.life, sx = sp.x + sp.vx * age, sy = sp.y + sp.vy * age;
      var sq = [q[0] + (co * sx - si * sy) * s, q[1] + (si * sx + co * sy) * s];
      c.fillStyle = sp.hot ? 'rgba(255,' + Math.round(200 - 120 * sk) + ',80,' + (1 - sk) + ')' : 'rgba(150,150,160,' + (0.8 * (1 - sk)) + ')';
      var sz = sp.hot ? 1.6 : 1.2;
      c.fillRect(sq[0] - sz / 2, sq[1] - sz / 2, sz, sz);
    }
    c.restore();
  }

  root.SPWreck = { make: make, draw: draw };
})(typeof self !== 'undefined' ? self : this);
