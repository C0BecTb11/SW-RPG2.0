// Карта операций для окна «Тайные операции» (js/spy-ops.js). Штабы игрока, планеты в досягаемости групп (spy_max_jumps),
// гиперпути; группы в деле идут по пути от штаба к цели и обратно — по серверному времени операции.
// На выборе цели подсвечены планеты-цели, выбранная — в прицеле, путь к ней — бегущим пунктиром.
// Кадры идут, только пока окно открыто и вкладка видна. ES5, только браузер.

(function(root) {
  'use strict';

  var TAU = Math.PI * 2;
  var S = { box: null, cv: null, c: null, dpr: 1, w: 0, h: 0, st: null, skew: 0, opt: {}, sys: {}, adj: {}, img: {},
            on: false, raf: 0, t: 0, last: 0, pick: null, xy: {}, stars: null, err: 0, r: 12, lab: {}, labKey: '' };

  function rng(seed) { var s = seed >>> 0 || 1; return function() { s += 0x6D2B79F5; var t = s; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  function rgba(hex, a) { var v = parseInt(hex.slice(1), 16); return 'rgba(' + ((v >> 16) & 255) + ',' + ((v >> 8) & 255) + ',' + (v & 255) + ',' + a + ')'; }

  // путь по гиперпутям (в ширину)
  function path(a, b) {
    if (a === b) return [a];
    var prev = {}, q = [a]; prev[a] = a;
    while (q.length) {
      var x = q.shift(), n = S.adj[x] || [];
      for (var i = 0; i < n.length; i++) if (!(n[i] in prev)) { prev[n[i]] = x; if (n[i] === b) { q = []; break; } q.push(n[i]); }
    }
    if (!(b in prev)) return null;
    var out = [b]; while (out[0] !== a) out.unshift(prev[out[0]]);
    return out;
  }

  function layout() {
    var r = S.box.getBoundingClientRect(), w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
    S.dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (w !== S.w || h !== S.h || S.cv.width !== Math.round(w * S.dpr)) {
      S.w = w; S.h = h; S.cv.width = Math.round(w * S.dpr); S.cv.height = Math.round(h * S.dpr);
      S.cv.style.width = w + 'px'; S.cv.style.height = h + 'px'; S.stars = null;
    }
    // вписать планеты: поля под подписи и строку сверху
    var list = Object.keys(S.sys).map(function(k) { return S.sys[k]; }); if (!list.length) return;
    var x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    list.forEach(function(s) { x0 = Math.min(x0, s.x); x1 = Math.max(x1, s.x); y0 = Math.min(y0, s.y); y1 = Math.max(y1, s.y); });
    var pl = 46, pr = 46, pt = 52, pb = 30, sw = Math.max(1, x1 - x0), sh = Math.max(1, y1 - y0);
    // широкая карта в высоком окне (и наоборот): свободную ось растягиваем, но не больше чем в 1,6 раза — расклад узнаваем
    var kx = (S.w - pl - pr) / sw, ky = (S.h - pt - pb) / sh, k = Math.min(kx, ky);
    kx = Math.min(kx, k * 1.6); ky = Math.min(ky, k * 1.6);
    var ox = pl + (S.w - pl - pr - sw * kx) / 2, oy = pt + (S.h - pt - pb - sh * ky) / 2;
    list.forEach(function(s) { S.xy[s.id] = [ox + (s.x - x0) * kx, oy + (s.y - y0) * ky]; });
    var key = S.w + 'x' + S.h + ':' + list.length;
    if (key !== S.labKey) { S.labKey = key; place(list); }
  }

  // Радиус планет — по самому тесному соседству; подписи — снизу, сверху, справа или слева, где не налезут
  // на чужие планеты и подписи. Считается один раз на размер окна и набор планет.
  function place(list) {
    var dmin = Infinity, i, j;
    for (i = 0; i < list.length; i++) for (j = i + 1; j < list.length; j++) {
      var a = S.xy[list[i].id], b = S.xy[list[j].id], d = Math.sqrt((a[0] - b[0]) * (a[0] - b[0]) + (a[1] - b[1]) * (a[1] - b[1]));
      if (d < dmin) dmin = d;
    }
    S.r = Math.max(7, Math.min(15, S.w / 34, isFinite(dmin) ? dmin * 0.34 : 15));
    var c = S.c, fs = S.r < 10 ? 9 : 10, boxes = [], out = {};
    function hit(q) {
      var o = 0;
      if (q.x0 < 2 || q.x1 > S.w - 2 || q.y0 < 2 || q.y1 > S.h - 2) o += 400;
      list.forEach(function(s) {
        var p = S.xy[s.id], rr = (s.base ? S.r + 2 : S.r) + 3;
        var cx = Math.max(q.x0, Math.min(p[0], q.x1)), cy = Math.max(q.y0, Math.min(p[1], q.y1));
        var dx = p[0] - cx, dy = p[1] - cy; if (dx * dx + dy * dy < rr * rr) o += 3 * (rr * rr - dx * dx - dy * dy);   // подпись поверх планеты хуже, чем поверх подписи
      });
      boxes.forEach(function(b) { var w = Math.min(q.x1, b.x1) - Math.max(q.x0, b.x0), h = Math.min(q.y1, b.y1) - Math.max(q.y0, b.y0); if (w > 0 && h > 0) o += w * h; });
      return o;
    }
    // штабы и цели раскладываем первыми — им лучшие места
    var tg = S.opt.targets || [];
    list.slice().sort(function(a, b) { return ((b.base ? 2 : 0) + (tg.indexOf(b.id) >= 0 ? 1 : 0)) - ((a.base ? 2 : 0) + (tg.indexOf(a.id) >= 0 ? 1 : 0)); }).forEach(function(s) {
      var p = S.xy[s.id], r = (s.base ? S.r + 2 : S.r);
      c.font = 'bold ' + fs + 'px "Courier New", monospace';
      var w = c.measureText(s.name).width + 4, h = fs + 3, best = null;
      var dg = r * 0.72 + 2;                                   // снизу, сверху, справа, слева, затем по диагоналям
      [['c', 't', 0, r + 4], ['c', 'b', 0, -r - 4], ['l', 'm', r + 5, 0], ['r', 'm', -r - 5, 0],
       ['l', 't', dg, dg], ['r', 't', -dg, dg], ['l', 'b', dg, -dg], ['r', 'b', -dg, -dg]].forEach(function(v) {
        var x = p[0] + v[2], y = p[1] + v[3];
        var q = { x0: v[0] === 'c' ? x - w / 2 : v[0] === 'l' ? x : x - w, y0: v[1] === 't' ? y : v[1] === 'b' ? y - h : y - h / 2 };
        q.x1 = q.x0 + w; q.y1 = q.y0 + h; q.v = v; q.o = hit(q);
        if (!best || q.o < best.o) best = q;
      });
      boxes.push(best);
      out[s.id] = { dx: best.v[2], dy: best.v[3], al: best.v[0] === 'c' ? 'center' : best.v[0] === 'l' ? 'left' : 'right',
                    bl: best.v[1] === 't' ? 'top' : best.v[1] === 'b' ? 'bottom' : 'middle', fs: fs };
    });
    S.lab = out;
  }

  function planet(c, s, p, r, t) {
    var mine = s.mine, own = S.st && s.faction === S.st.faction, col = mine ? '#4a90d9' : own ? '#6f8fb3' : '#d94a4a';
    var targ = S.opt.targets && S.opt.targets.indexOf(s.id) >= 0, pick = S.opt.pick === s.id;
    if (s.base) {                                           // штаб: золотое кольцо и волна
      var wv = (t * 0.45) % 1;
      c.strokeStyle = rgba('#d9a940', 0.5 * (1 - wv)); c.lineWidth = 1.5; c.beginPath(); c.arc(p[0], p[1], r + 4 + wv * 14, 0, TAU); c.stroke();
    }
    if (targ && !pick) { var pk = 0.5 + 0.5 * Math.sin(t * 3 + p[0]); c.fillStyle = rgba('#d94a4a', 0.1 + 0.12 * pk); c.beginPath(); c.arc(p[0], p[1], r + 9, 0, TAU); c.fill(); }
    c.fillStyle = 'rgba(0,0,0,0.5)'; c.beginPath(); c.arc(p[0] + 1.5, p[1] + 2, r, 0, TAU); c.fill();
    var im = S.img[s.tex];
    c.save(); c.beginPath(); c.arc(p[0], p[1], r, 0, TAU); c.clip();
    if (im && im.complete && im.naturalWidth) c.drawImage(im, p[0] - r, p[1] - r, r * 2, r * 2);
    else { c.fillStyle = '#1c2530'; c.fillRect(p[0] - r, p[1] - r, r * 2, r * 2); }
    var sh = c.createRadialGradient(p[0] - r * 0.4, p[1] - r * 0.4, r * 0.2, p[0], p[1], r * 1.05);
    sh.addColorStop(0, 'rgba(255,255,255,0.08)'); sh.addColorStop(1, 'rgba(0,0,0,0.55)');
    c.fillStyle = sh; c.fillRect(p[0] - r, p[1] - r, r * 2, r * 2);
    c.restore();
    c.strokeStyle = s.base ? '#d9a940' : col; c.lineWidth = s.base || mine ? 2 : 1.2; c.beginPath(); c.arc(p[0], p[1], r + 1, 0, TAU); c.stroke();
    if (pick) {                                             // прицел на выбранной цели
      var a = t * 0.8; c.strokeStyle = '#d9a940'; c.lineWidth = 1.5;
      for (var i = 0; i < 4; i++) { var aa = a + i * Math.PI / 2; c.beginPath(); c.arc(p[0], p[1], r + 8, aa, aa + 0.9); c.stroke(); }
      c.beginPath(); c.moveTo(p[0] - r - 14, p[1]); c.lineTo(p[0] - r - 6, p[1]); c.moveTo(p[0] + r + 6, p[1]); c.lineTo(p[0] + r + 14, p[1]);
      c.moveTo(p[0], p[1] - r - 14); c.lineTo(p[0], p[1] - r - 6); c.moveTo(p[0], p[1] + r + 6); c.lineTo(p[0], p[1] + r + 14); c.stroke();
    }
    var L = S.lab[s.id] || { dx: 0, dy: r + 4, al: 'center', bl: 'top', fs: 10 }, lx = p[0] + L.dx, ly = p[1] + L.dy;
    if (pick && L.bl !== 'middle') ly += L.bl === 'top' ? 4 : -4;            // подпись выбранной цели — из-под прицела
    c.font = (s.base || pick ? 'bold ' : '') + L.fs + 'px "Courier New", monospace'; c.textAlign = L.al; c.textBaseline = L.bl;
    c.lineJoin = 'round'; c.lineWidth = 3; c.strokeStyle = 'rgba(5,7,11,0.9)'; c.strokeText(s.name, lx, ly);
    c.fillStyle = pick ? '#d9a940' : s.base ? '#e8d9a8' : targ ? '#ffb4a8' : '#8fa8c4'; c.fillText(s.name, lx, ly);
  }

  // где сейчас группа: по пути туда (перелёт), у цели (подход, действие, отход), по пути обратно
  function groupAt(g, now) {
    var o = g.op; if (!o) return null;
    var pth = path(o.base_system, o.target_system); if (!pth) return null;
    var c = S.st.cfg, t0 = new Date(o.launched_at).getTime(), ta = new Date(o.approach_at).getTime(), tb = new Date(o.back_at).getTime();
    var td = o.acted_at ? new Date(o.acted_at).getTime() : 0, tex = (td || new Date(o.act_at).getTime()) + c.exit_min * 60000;
    var f, back = false;
    if (now < ta) f = (now - t0) / Math.max(1, ta - t0);
    else if (!td || now < tex) f = 1;
    else { f = 1 - (now - tex) / Math.max(1, tb - tex); back = true; }
    f = Math.max(0, Math.min(1, f));
    var seg = (pth.length - 1) * f, i = Math.min(pth.length - 2, Math.floor(seg)), u = seg - i;
    if (pth.length < 2) return { p: S.xy[pth[0]], back: back, at: true, pth: pth };
    var a = S.xy[pth[i]], b = S.xy[pth[i + 1]];
    if (!a || !b) return null;
    return { p: [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u], ang: Math.atan2(b[1] - a[1], b[0] - a[0]) + (back ? Math.PI : 0),
             back: back, at: f >= 1 && !back, pth: pth };
  }

  function lanePath(c, pth, t, col) {
    c.save(); c.setLineDash([5, 6]); c.lineDashOffset = -t * 18; c.strokeStyle = col; c.lineWidth = 1.6;
    c.beginPath();
    pth.forEach(function(id, i) { var q = S.xy[id]; if (!q) return; if (i) c.lineTo(q[0], q[1]); else c.moveTo(q[0], q[1]); });
    c.stroke(); c.restore();
  }

  function draw() {
    var c = S.c, st = S.st; if (!c || !st) return;
    layout();
    var t = S.t, now = Date.now() + S.skew, r = S.r;
    c.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
    var g = c.createRadialGradient(S.w * 0.5, S.h * 0.45, 10, S.w * 0.5, S.h * 0.5, Math.max(S.w, S.h) * 0.75);
    g.addColorStop(0, '#111a26'); g.addColorStop(1, '#06080d');
    c.fillStyle = g; c.fillRect(0, 0, S.w, S.h);
    if (!S.stars) { var R = rng(17); S.stars = []; for (var i = 0; i < 90; i++) S.stars.push([R() * S.w, R() * S.h, R() * 1.1 + 0.2, R()]); }
    S.stars.forEach(function(s) { c.fillStyle = 'rgba(207,216,220,' + (0.12 + 0.3 * s[3] * (0.6 + 0.4 * Math.sin(t * 0.8 + s[0]))) + ')'; c.fillRect(s[0], s[1], s[2], s[2]); });
    // сетка тактической карты
    c.strokeStyle = 'rgba(143,168,196,0.04)'; c.lineWidth = 1;
    for (var x = 0; x < S.w; x += 40) { c.beginPath(); c.moveTo(x + 0.5, 0); c.lineTo(x + 0.5, S.h); c.stroke(); }
    for (var y = 0; y < S.h; y += 40) { c.beginPath(); c.moveTo(0, y + 0.5); c.lineTo(S.w, y + 0.5); c.stroke(); }
    // гиперпути
    c.strokeStyle = 'rgba(143,168,196,0.2)'; c.lineWidth = 1.2;
    ((st.map && st.map.lanes) || []).forEach(function(l) { var a = S.xy[l[0]], b = S.xy[l[1]]; if (!a || !b) return; c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); c.stroke(); });
    // путь к выбранной цели
    if (S.opt.from && S.opt.pick) { var pp = path(S.opt.from, S.opt.pick); if (pp) lanePath(c, pp, t, 'rgba(217,169,64,0.85)'); }
    // пути групп в деле
    var marks = [];
    (st.groups || []).forEach(function(gr) {
      if (gr.status !== 'mission' || !gr.op) return;
      var at = groupAt(gr, now); if (!at) return;
      lanePath(c, at.pth, t, rgba(at.back ? '#5fd968' : '#d9a940', 0.45));
      marks.push({ g: gr, at: at });
    });
    Object.keys(S.sys).forEach(function(k) { var p = S.xy[k]; if (p) planet(c, S.sys[k], p, S.sys[k].base ? r + 2 : r, t); });
    // группы: ромб с хвостом; у цели — кружат в тени
    marks.forEach(function(m, j) {
      var p = m.at.p, col = m.at.back ? '#5fd968' : '#d9a940';
      if (m.at.at) { var a = t * 1.4 + j * 2; p = [p[0] + Math.cos(a) * (r + 6), p[1] + Math.sin(a) * (r + 6)]; }
      c.save(); c.translate(p[0], p[1]); c.rotate(m.at.at ? t * 1.4 + j * 2 + Math.PI / 2 : m.at.ang || 0);
      c.fillStyle = rgba(col, 0.25); c.beginPath(); c.arc(0, 0, 8, 0, TAU); c.fill();
      c.fillStyle = col; c.beginPath(); c.moveTo(6, 0); c.lineTo(0, -4); c.lineTo(-5, 0); c.lineTo(0, 4); c.closePath(); c.fill();
      c.restore();
      c.font = '9px "Courier New", monospace'; c.textAlign = 'left'; c.textBaseline = 'middle';
      c.lineJoin = 'round'; c.lineWidth = 3; c.strokeStyle = 'rgba(5,7,11,0.9)'; c.strokeText(m.g.name, p[0] + 10, p[1] + 9);
      c.fillStyle = col; c.fillText(m.g.name, p[0] + 10, p[1] + 9);
    });
  }

  function loop(now) {
    if (!S.on) return;
    S.raf = requestAnimationFrame(loop);
    if (document.hidden) { S.last = now; return; }
    var dt = Math.min(0.1, (now - (S.last || now)) / 1000); S.last = now; S.t += dt;
    try { draw(); } catch (e) {
      if (S.cv) S.cv.width = S.cv.width;                  // сбросить «залипшие» save() и трансформации
      if (!S.err) { S.err = 1; if (root.errReport) root.errReport(e, 'spy.map'); }
    }
  }

  function onTap(e) {
    if (!S.pick || !S.opt.targets) return;
    var r = S.cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top, best = null, bd = 30 * 30;
    S.opt.targets.forEach(function(id) { var p = S.xy[id]; if (!p) return; var d = (p[0] - x) * (p[0] - x) + (p[1] - y) * (p[1] - y); if (d < bd) { bd = d; best = id; } });
    if (best) S.pick(best);
  }

  root.SOMap = {
    mount: function(box, onPick) {
      S.box = box; S.pick = onPick || null; S.err = 0;
      if (!S.cv || S.cv.parentNode !== box) {
        S.cv = document.createElement('canvas'); S.cv.className = 'so-cv'; box.insertBefore(S.cv, box.firstChild);
        S.c = S.cv.getContext('2d'); S.cv.addEventListener('click', onTap);
      }
      S.w = 0; S.st = null;
      if (!S.on) { S.on = true; S.last = 0; S.raf = requestAnimationFrame(loop); }
    },
    set: function(st, skew, opt) {
      S.st = st; S.skew = skew || 0; S.opt = opt || {}; S.sys = {}; S.adj = {}; S.labKey = '';
      ((st.map && st.map.systems) || []).forEach(function(s) {
        S.sys[s.id] = s;
        if (s.tex && !S.img[s.tex]) { var im = new Image(); im.src = '../' + s.tex; S.img[s.tex] = im; }
      });
      ((st.map && st.map.lanes) || []).forEach(function(l) { (S.adj[l[0]] = S.adj[l[0]] || []).push(l[1]); (S.adj[l[1]] = S.adj[l[1]] || []).push(l[0]); });
      if (S.box && S.box.classList) S.box.classList.toggle('dense', Object.keys(S.sys).length > 14);   // css/spy-ops.css: карте выше
    },
    sys: function(id) { return S.sys[id] || null; },
    stop: function() { S.on = false; if (S.raf) cancelAnimationFrame(S.raf); S.raf = 0; }
  };
})(typeof self !== 'undefined' ? self : this);
