// Живая карта сети снабжения для окна «Снабжение» (js/supply.js). Данные — get_supply_map (sql/supply_map.sql):
// планеты своей стороны, гиперпути между ними, хабы и флоты моих рейсов. Нужды и излишки планет, выбранную планету,
// выбранный рейс и черновик нового рейса передаёт окно (view). Флоты идут по прыжку от вылета до прибытия —
// по серверному времени; маршрут рейса — пунктиром через миры своей стороны, как его прокладывает сервер (convoy_route).
// Кадры идут, только пока окно открыто и вкладка видна. ES5, только браузер. Язык рисования — как у карты операций (js/spy-map.js).

(function(root) {
  'use strict';

  var TAU = Math.PI * 2;
  var COL = { travel: '#4a90d9', stop: '#5fd968', waiting: '#d9a940', stalled: '#d94a4a', paused: '#8fa8c4' };
  var S = { box: null, cv: null, c: null, dpr: 1, w: 0, h: 0, d: null, skew: 0, v: {}, sys: {}, adj: {}, img: {},
            on: false, raf: 0, t: 0, last: 0, xy: {}, stars: null, err: 0, r: 12, lab: {}, labKey: '', h_: {}, marks: [] };

  function rng(seed) { var s = seed >>> 0 || 1; return function() { s += 0x6D2B79F5; var t = s; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  function rgba(hex, a) { var v = parseInt(hex.slice(1), 16); return 'rgba(' + ((v >> 16) & 255) + ',' + ((v >> 8) & 255) + ',' + (v & 255) + ',' + a + ')'; }
  function ms(iso) { var v = iso ? Date.parse(iso) : NaN; return isNaN(v) ? 0 : v; }

  // Путь как у сервера (convoy_route / convoy_route_to): через планеты своей стороны, чужая — только конечной
  function path(a, b) {
    if (!a || !b) return null;
    if (a === b) return [a];
    var fac = S.d && S.d.faction, prev = {}, q = [a]; prev[a] = a;
    while (q.length) {
      var x = q.shift(), n = S.adj[x] || [];
      for (var i = 0; i < n.length; i++) {
        var y = n[i], s = S.sys[y];
        if (y in prev || !s) continue;
        if (y !== b && (s.deep || s.faction !== fac)) continue;
        prev[y] = x;
        if (y === b) { q = []; break; }
        q.push(y);
      }
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
    var list = Object.keys(S.sys).map(function(k) { return S.sys[k]; }); if (!list.length) return;
    var x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    list.forEach(function(s) { x0 = Math.min(x0, s.x); x1 = Math.max(x1, s.x); y0 = Math.min(y0, s.y); y1 = Math.max(y1, s.y); });
    // поля: сверху строка состояния, по бокам и снизу — подписи планет
    var pl = 44, pr = 44, pt = 50, pb = 28, sw = Math.max(1, x1 - x0), sh = Math.max(1, y1 - y0);
    var kx = (S.w - pl - pr) / sw, ky = (S.h - pt - pb) / sh, k = Math.min(kx, ky);
    kx = Math.min(kx, k * 1.6); ky = Math.min(ky, k * 1.6);           // растяжка свободной оси — не больше 1,6: расклад узнаваем
    var ox = pl + (S.w - pl - pr - sw * kx) / 2, oy = pt + (S.h - pt - pb - sh * ky) / 2;
    list.forEach(function(s) { S.xy[s.id] = [ox + (s.x - x0) * kx, oy + (s.y - y0) * ky]; });
    var key = S.w + 'x' + S.h + ':' + list.length;
    if (key !== S.labKey) { S.labKey = key; place(list); }
  }

  // Радиус планет — по самому тесному соседству; подписи — туда, где не налезут на чужие планеты и подписи
  function place(list) {
    var dmin = Infinity, i, j;
    for (i = 0; i < list.length; i++) for (j = i + 1; j < list.length; j++) {
      var a = S.xy[list[i].id], b = S.xy[list[j].id], d = Math.sqrt((a[0] - b[0]) * (a[0] - b[0]) + (a[1] - b[1]) * (a[1] - b[1]));
      if (d < dmin) dmin = d;
    }
    S.r = Math.max(7, Math.min(14, S.w / 34, isFinite(dmin) ? dmin * 0.32 : 14));
    var c = S.c, fs = S.r < 10 ? 9 : 10, boxes = [], out = {};
    function hit(q) {
      var o = 0;
      if (q.x0 < 2 || q.x1 > S.w - 2 || q.y0 < 2 || q.y1 > S.h - 2) o += 400;
      if (q.y0 < 40 && q.x0 < Math.min(S.w, 330)) o += 260;                  // строка состояния сверху слева
      if (q.y1 > S.h - 20 && q.x1 > S.w - 190) o += 160;                     // легенда снизу справа
      list.forEach(function(s) {
        var p = S.xy[s.id], rr = rad(s) + 4;
        var cx = Math.max(q.x0, Math.min(p[0], q.x1)), cy = Math.max(q.y0, Math.min(p[1], q.y1));
        var dx = p[0] - cx, dy = p[1] - cy; if (dx * dx + dy * dy < rr * rr) o += 3 * (rr * rr - dx * dx - dy * dy);
      });
      boxes.forEach(function(b) { var w = Math.min(q.x1, b.x1) - Math.max(q.x0, b.x0), h = Math.min(q.y1, b.y1) - Math.max(q.y0, b.y0); if (w > 0 && h > 0) o += w * h; });
      return o;
    }
    // свои планеты и хабы раскладываем первыми — им лучшие места
    function rank(s) { return (s.mine ? 2 : 0) + (s.hub ? 1 : 0) - (s.deep ? 4 : 0); }
    list.slice().sort(function(a, b) { return rank(b) - rank(a); }).forEach(function(s) {
      var p = S.xy[s.id], r = rad(s);
      c.font = (s.mine ? 'bold ' : '') + fs + 'px "Courier New", monospace';
      var w = c.measureText(s.name).width + 4, h = fs + 3, best = null, dg = r * 0.72 + 2;
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

  function rad(s) { return s.deep ? Math.max(4, S.r * 0.45) : s.mine ? S.r + 1 : S.r; }

  function diamond(c, x, y, s, fill, stroke) {
    c.beginPath(); c.moveTo(x, y - s); c.lineTo(x + s, y); c.lineTo(x, y + s); c.lineTo(x - s, y); c.closePath();
    if (fill) { c.fillStyle = fill; c.fill(); }
    if (stroke) { c.strokeStyle = stroke; c.lineWidth = 1.2; c.stroke(); }
  }

  function planet(c, s, p, t) {
    var r = rad(s), v = S.v, fac = S.d.faction, own = s.faction === fac;
    var net = (v.net && v.net[s.id]) || null, sel = v.sel === s.id, inDraft = v.draft && v.draft.indexOf(s.id) >= 0;
    var col = s.mine ? '#4a90d9' : own ? '#6f8fb3' : '#d94a4a';
    if (s.deep) {                                           // дальний космос: только точка, флоты через него не ходят
      c.fillStyle = '#10151e'; c.strokeStyle = '#2a3644'; c.lineWidth = 1;
      c.beginPath(); c.arc(p[0], p[1], r, 0, TAU); c.fill(); c.stroke();
    } else {
      if (net && net.need) {                                // нужда: золотое дыхание вокруг планеты
        var pk = 0.5 + 0.5 * Math.sin(t * 2.4 + p[0] * 0.05);
        c.fillStyle = rgba('#d9a940', 0.08 + 0.12 * pk); c.beginPath(); c.arc(p[0], p[1], r + 7 + 2 * pk, 0, TAU); c.fill();
      }
      c.fillStyle = 'rgba(0,0,0,0.5)'; c.beginPath(); c.arc(p[0] + 1.5, p[1] + 2, r, 0, TAU); c.fill();
      var im = S.img[s.tex];
      c.save(); c.beginPath(); c.arc(p[0], p[1], r, 0, TAU); c.clip();
      if (im && im.complete && im.naturalWidth) c.drawImage(im, p[0] - r, p[1] - r, r * 2, r * 2);
      else { c.fillStyle = '#1c2530'; c.fillRect(p[0] - r, p[1] - r, r * 2, r * 2); }
      var sh = c.createRadialGradient(p[0] - r * 0.4, p[1] - r * 0.4, r * 0.2, p[0], p[1], r * 1.05);
      sh.addColorStop(0, 'rgba(255,255,255,0.08)'); sh.addColorStop(1, 'rgba(0,0,0,0.55)');
      c.fillStyle = sh; c.fillRect(p[0] - r, p[1] - r, r * 2, r * 2);
      c.restore();
      c.strokeStyle = col; c.lineWidth = s.mine ? 2 : 1.2; c.beginPath(); c.arc(p[0], p[1], r + 1, 0, TAU); c.stroke();
      if (net && net.take) {                                 // излишки: зелёная дуга снизу — отсюда можно забрать
        c.strokeStyle = 'rgba(95,217,104,0.85)'; c.lineWidth = 2;
        c.beginPath(); c.arc(p[0], p[1], r + 4, Math.PI * 0.2, Math.PI * 0.8); c.stroke();
      }
      if (net && net.need) {
        c.strokeStyle = 'rgba(217,169,64,0.9)'; c.lineWidth = 2;
        c.beginPath(); c.arc(p[0], p[1], r + 4, Math.PI * 1.2, Math.PI * 1.8); c.stroke();
      }
      if (s.hub) diamond(c, p[0] + r * 0.78, p[1] - r * 0.78, 3.6, '#d9a940', 'rgba(5,7,11,0.9)');   // хаб / узел
    }
    if (sel) {                                               // выбранная планета — в рамке
      var a = t * 0.8; c.strokeStyle = '#d9a940'; c.lineWidth = 1.5;
      for (var i = 0; i < 4; i++) { var aa = a + i * Math.PI / 2; c.beginPath(); c.arc(p[0], p[1], r + 8, aa, aa + 0.9); c.stroke(); }
    }
    var L = S.lab[s.id] || { dx: 0, dy: r + 4, al: 'center', bl: 'top', fs: 10 }, lx = p[0] + L.dx, ly = p[1] + L.dy;
    if (sel && L.bl !== 'middle') ly += L.bl === 'top' ? 4 : -4;
    c.font = (s.mine || sel ? 'bold ' : '') + L.fs + 'px "Courier New", monospace'; c.textAlign = L.al; c.textBaseline = L.bl;
    c.lineJoin = 'round'; c.lineWidth = 3; c.strokeStyle = 'rgba(5,7,11,0.9)'; c.strokeText(s.name, lx, ly);
    c.fillStyle = sel ? '#d9a940' : s.deep ? '#55606c' : !own ? '#ffb4a8' : s.mine ? '#cfd8dc' : inDraft ? '#e8d9a8' : '#8fa8c4';
    c.fillText(s.name, lx, ly);
  }

  // состояние флота для цвета: как у карточки рейса
  function fleetKind(f) {
    if (f.status === 'stalled') return 'stalled';
    if (f.status === 'paused') return 'paused';
    if (f.to) return 'travel';
    if (f.phase === 'waiting') return 'waiting';
    if (f.phase === 'travel') return 'travel';
    return 'stop';
  }

  // где флот сейчас: в прыжке — между планетами по времени, иначе у планеты
  function fleetAt(f, now) {
    if (f.to && f.from) {
      var a = S.xy[f.from], b = S.xy[f.to]; if (!a || !b) return null;
      var t0 = ms(f.dep), t1 = ms(f.arr), u = t1 > t0 ? (now - t0) / (t1 - t0) : 1;
      u = Math.max(0, Math.min(1, u));
      if (u >= 1) return { p: b, node: f.to, at: true };
      return { p: [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u], ang: Math.atan2(b[1] - a[1], b[0] - a[0]), node: f.to, at: false };
    }
    var q = S.xy[f.at]; return q ? { p: q, node: f.at, at: true } : null;
  }

  // путь рейса целиком: остановки по порядку (и назад к первой, если по кругу)
  function routeLegs(stops, loop) {
    var legs = [];
    for (var i = 1; i < stops.length; i++) legs.push(path(stops[i - 1], stops[i]));
    if (loop && stops.length > 1) legs.push(path(stops[stops.length - 1], stops[0]));
    return legs;
  }

  function polyline(c, pts, col, w, dash, t) {
    if (!pts || pts.length < 2) return;
    c.save();
    if (dash) { c.setLineDash(dash); c.lineDashOffset = -t * 18; }
    c.strokeStyle = col; c.lineWidth = w; c.lineJoin = 'round'; c.lineCap = 'round';
    c.beginPath();
    pts.forEach(function(q, i) { if (i) c.lineTo(q[0], q[1]); else c.moveTo(q[0], q[1]); });
    c.stroke(); c.restore();
  }
  function pts(ids) { var out = []; (ids || []).forEach(function(id) { var q = S.xy[id]; if (q) out.push(q); }); return out; }

  function draw() {
    var c = S.c, d = S.d; if (!c || !d) return;
    layout();
    var t = S.t, now = Date.now() + S.skew, v = S.v;
    c.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
    var g = c.createRadialGradient(S.w * 0.5, S.h * 0.45, 10, S.w * 0.5, S.h * 0.5, Math.max(S.w, S.h) * 0.75);
    g.addColorStop(0, '#111a26'); g.addColorStop(1, '#06080d');
    c.fillStyle = g; c.fillRect(0, 0, S.w, S.h);
    if (!S.stars) { var R = rng(29); S.stars = []; for (var i = 0; i < 90; i++) S.stars.push([R() * S.w, R() * S.h, R() * 1.1 + 0.2, R()]); }
    S.stars.forEach(function(s) { c.fillStyle = 'rgba(207,216,220,' + (0.12 + 0.3 * s[3] * (0.6 + 0.4 * Math.sin(t * 0.8 + s[0]))) + ')'; c.fillRect(s[0], s[1], s[2], s[2]); });
    c.strokeStyle = 'rgba(143,168,196,0.04)'; c.lineWidth = 1;
    for (var x = 0; x < S.w; x += 40) { c.beginPath(); c.moveTo(x + 0.5, 0); c.lineTo(x + 0.5, S.h); c.stroke(); }
    for (var y = 0; y < S.h; y += 40) { c.beginPath(); c.moveTo(0, y + 0.5); c.lineTo(S.w, y + 0.5); c.stroke(); }
    // гиперпути
    c.strokeStyle = 'rgba(143,168,196,0.18)'; c.lineWidth = 1.2;
    (d.lanes || []).forEach(function(l) { var a = S.xy[l[0]], b = S.xy[l[1]]; if (!a || !b) return; c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); c.stroke(); });

    // черновик нового рейса: золотой бегущий пунктир через выбранные остановки
    var draft = (v.draft || []).filter(function(id) { return !!S.xy[id]; });
    if (draft.length > 1) routeLegs(draft, v.draftLoop).forEach(function(leg) { polyline(c, pts(leg), 'rgba(217,169,64,0.85)', 1.8, [6, 6], t); });

    // рейсы: весь путь — тусклым пунктиром, текущий перелёт — ярким бегущим.
    // Пока собирают новый рейс, чужие для него флоты не мешают — их нет на карте
    S.marks = [];
    var atCount = {};
    (v.draft ? [] : d.fleets || []).forEach(function(f) {
      var kind = fleetKind(f), col = COL[kind], on = v.route === f.id, dim = v.route && !on;
      var stops = f.stops || [];
      routeLegs(stops, f.loop).forEach(function(leg) { polyline(c, pts(leg), rgba(col, on ? 0.5 : dim ? 0.08 : 0.2), on ? 1.6 : 1.2, [3, 5], 0); });
      var at = fleetAt(f, now); if (!at) return;
      var target = stops[f.idx] || null;
      if (target && f.status !== 'paused') {
        var rest = path(at.node, target), lead = at.at ? pts(rest) : [at.p].concat(pts(rest));
        polyline(c, lead, rgba(col, dim ? 0.2 : 0.85), on ? 2 : 1.6, [5, 6], t);
      }
      if (at.at) { atCount[at.node] = (atCount[at.node] || 0) + 1; at.k = atCount[at.node] - 1; }
      S.marks.push({ f: f, at: at, col: col, kind: kind, on: on, dim: dim });
    });

    // номера остановок черновика
    Object.keys(S.sys).forEach(function(k) { var p = S.xy[k]; if (p) planet(c, S.sys[k], p, t); });
    if (draft.length) {
      var seen = {};
      draft.forEach(function(id, i) {
        var p = S.xy[id], r = rad(S.sys[id]) ; if (!p) return;
        var n = seen[id] || 0; seen[id] = n + 1;
        var bx = p[0] - r * 0.85 - n * 13, by = p[1] - r * 0.85;
        c.fillStyle = '#d9a940'; c.beginPath(); c.arc(bx, by, 6.5, 0, TAU); c.fill();
        c.strokeStyle = 'rgba(5,7,11,0.9)'; c.lineWidth = 1.5; c.stroke();
        c.fillStyle = '#0a0d14'; c.font = 'bold 9px "Courier New", monospace'; c.textAlign = 'center'; c.textBaseline = 'middle';
        c.fillText(String(i + 1), bx, by + 0.5);
      });
    }

    // флоты: ромб с ореолом; у планеты — кружат на орбите, в прыжке — смотрят по ходу
    S.marks.forEach(function(m) {
      var p = m.at.p, r = S.r, col = m.col, a;
      if (m.at.at) {
        // стоящий флот — сверху слева от планеты: там реже всего подпись
        a = (m.kind === 'stalled' || m.kind === 'paused' ? -Math.PI * 0.75 : t * 0.9) + m.at.k * 2.1;
        p = [p[0] + Math.cos(a) * (r + 7), p[1] + Math.sin(a) * (r + 7)];
      }
      m.p = p;
      c.save(); c.globalAlpha = m.dim ? 0.45 : 1; c.translate(p[0], p[1]);
      c.rotate(m.at.at ? a + Math.PI / 2 : m.at.ang || 0);
      var glow = m.kind === 'stalled' ? 0.25 + 0.2 * Math.sin(t * 5) : 0.25;
      c.fillStyle = rgba(col, glow); c.beginPath(); c.arc(0, 0, m.on ? 10 : 8, 0, TAU); c.fill();
      c.fillStyle = col; c.beginPath(); c.moveTo(6, 0); c.lineTo(0, -4); c.lineTo(-5, 0); c.lineTo(0, 4); c.closePath(); c.fill();
      if (m.on) { c.strokeStyle = '#cfd8dc'; c.lineWidth = 1; c.stroke(); }
      c.restore();
      if (m.on) {                                            // подпись — только у выбранного: иначе флоты закрывают имена планет
        var lab = m.f.commander || m.f.name || '';
        if (lab.length > 18) lab = lab.slice(0, 17) + '…';
        c.font = '9px "Courier New", monospace'; c.textAlign = 'left'; c.textBaseline = 'middle';
        c.lineJoin = 'round'; c.lineWidth = 3; c.strokeStyle = 'rgba(5,7,11,0.9)'; c.strokeText(lab, p[0] + 10, p[1] + 9);
        c.fillStyle = col; c.fillText(lab, p[0] + 10, p[1] + 9);
      }
    });
  }

  function loop(now) {
    if (!S.on) return;
    S.raf = requestAnimationFrame(loop);
    if (document.hidden) { S.last = now; return; }
    var dt = Math.min(0.1, (now - (S.last || now)) / 1000); S.last = now; S.t += dt;
    try { draw(); } catch (e) {
      if (S.cv) S.cv.width = S.cv.width;                  // сбросить «залипшие» save() и трансформации
      if (!S.err) { S.err = 1; if (root.errReport) root.errReport(e, 'supply.map'); }
    }
  }

  // Тап: по самой планете — планета; рядом с ней — флот на орбите или в пути; иначе ближайшая планета
  function onTap(e) {
    if (!S.d) return;
    var r = S.cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    var bp = null, dp = Infinity, bf = null, df = Infinity;
    Object.keys(S.xy).forEach(function(id) { var p = S.xy[id], d = Math.sqrt((p[0] - x) * (p[0] - x) + (p[1] - y) * (p[1] - y)); if (d < dp) { dp = d; bp = id; } });
    S.marks.forEach(function(m) { if (!m.p) return; var d = Math.sqrt((m.p[0] - x) * (m.p[0] - x) + (m.p[1] - y) * (m.p[1] - y)); if (d < df) { df = d; bf = m.f.id; } });
    var onPlanet = bp && dp <= rad(S.sys[bp]) + 3;
    if (!onPlanet && bf && df <= 18 && S.h_.fleet) { S.h_.fleet(bf); return; }
    if (S.h_.planet) S.h_.planet(bp && dp <= 30 ? bp : null);
  }

  root.SupMap = {
    mount: function(box, handlers) {
      S.box = box; S.h_ = handlers || {}; S.err = 0;
      if (!S.cv || S.cv.parentNode !== box) {
        S.cv = document.createElement('canvas'); S.cv.className = 'sup-cv'; box.insertBefore(S.cv, box.firstChild);
        S.c = S.cv.getContext('2d'); S.cv.addEventListener('click', onTap);
      }
      S.w = 0;
      if (!S.on) { S.on = true; S.last = 0; S.raf = requestAnimationFrame(loop); }
    },
    set: function(d) {
      S.d = d || null; S.sys = {}; S.adj = {}; S.labKey = '';
      S.skew = d && d.now ? Date.parse(d.now) - Date.now() : 0;
      if (isNaN(S.skew)) S.skew = 0;
      ((d && d.systems) || []).forEach(function(s) {
        if (s.x === null || s.x === undefined || s.y === null || s.y === undefined) return;
        S.sys[s.id] = s;
        if (s.tex && !S.img[s.tex]) { var im = new Image(); im.src = '../' + s.tex; S.img[s.tex] = im; }
      });
      ((d && d.lanes) || []).forEach(function(l) { (S.adj[l[0]] = S.adj[l[0]] || []).push(l[1]); (S.adj[l[1]] = S.adj[l[1]] || []).push(l[0]); });
    },
    view: function(v) { S.v = v || {}; },
    has: function(id) { return !!S.sys[id]; },
    pos: function(id) { return S.xy[id] ? S.xy[id].slice() : null; },     // экранные координаты планеты (для проверок)
    stop: function() { S.on = false; if (S.raf) cancelAnimationFrame(S.raf); S.raf = 0; }
  };
})(typeof self !== 'undefined' ? self : this);
