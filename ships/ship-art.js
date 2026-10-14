// Корабли 2.0 — отрисовка отсеков вблизи: материалы пола, переборки с
// глубиной и светильниками, машинерия в техпространстве, убранство каждого
// типа отсека, техника и малые корабли (картинки из assets/ships).
// Всё рисуется один раз в кусок 32×32 клетки и потом только копируется.
// ES5, без сборки.

(function(root) {
  'use strict';

  var TAU = Math.PI * 2, CH = 32;
  var A = { V: null, K: null };

  function hash(x, y, s) {
    var h = (x * 374761393 + y * 668265263 + (s || 0) * 2246822519) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }
  function rgb(hex) { var n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
  function shade(hex, k) {
    var c = rgb(hex), f = function(v) { return Math.max(0, Math.min(255, Math.round(k > 0 ? v + (255 - v) * k : v * (1 + k)))); };
    return 'rgb(' + f(c[0]) + ',' + f(c[1]) + ',' + f(c[2]) + ')';
  }
  function rr(c, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    c.beginPath(); c.moveTo(x + r, y); c.lineTo(x + w - r, y); c.quadraticCurveTo(x + w, y, x + w, y + r);
    c.lineTo(x + w, y + h - r); c.quadraticCurveTo(x + w, y + h, x + w - r, y + h); c.lineTo(x + r, y + h);
    c.quadraticCurveTo(x, y + h, x, y + h - r); c.lineTo(x, y + r); c.quadraticCurveTo(x, y, x + r, y); c.closePath();
  }
  function disc(c, x, y, r) { c.beginPath(); c.arc(x, y, r, 0, TAU); c.fill(); }
  function ring(c, x, y, r) { c.beginPath(); c.arc(x, y, r, 0, TAU); c.stroke(); }

  // ---------------------------------------------------------------- материалы пола
  // Плитка 4×4 клетки (8 м), рисуется один раз на цвет и масштаб
  var STYLE = {
    hangar: 'deck', dock: 'deck', vehicle: 'deck',
    engine: 'grate', reactor: 'grate', hyper: 'grate', shield: 'grate', power: 'grate', pumps: 'grate',
    bridge: 'smooth', flight: 'smooth', cic: 'smooth', comms: 'smooth', observe: 'smooth',
    medbay: 'tile', mess: 'tile'
  };
  var PAT = {};
  function pattern(c, style, col, tp, rep) {
    var key = style + col + tp;
    if (PAT[key]) return PAT[key];
    // плитка 8×8 клеток (16 м): повторы не бросаются в глаза
    var T = tp * 8, cv = document.createElement('canvas'); cv.width = cv.height = T;
    var g = cv.getContext('2d'), i, j;
    g.fillStyle = col; g.fillRect(0, 0, T, T);
    var line = Math.max(1, tp * 0.07);
    if (style === 'plate') {
      for (i = 0; i < 4; i++) for (j = 0; j < 4; j++) {
        var px = i * tp * 2, py = j * tp * 2, s = tp * 2, v = hash(i, j, 3) - 0.5;
        g.fillStyle = shade(col, v * 0.12); g.fillRect(px, py, s, s);
        g.fillStyle = 'rgba(255,255,255,0.07)'; g.fillRect(px, py, s, line); g.fillRect(px, py, line, s);
        g.fillStyle = 'rgba(0,0,0,0.28)'; g.fillRect(px, py + s - line, s, line); g.fillRect(px + s - line, py, line, s);
        if (tp >= 16) {
          g.fillStyle = 'rgba(0,0,0,0.35)';
          var rv = tp * 0.07, m = tp * 0.22;
          disc(g, px + m, py + m, rv); disc(g, px + s - m, py + m, rv); disc(g, px + m, py + s - m, rv); disc(g, px + s - m, py + s - m, rv);
        }
        if (((i === 1 && j === 0) || (i === 3 && j === 2)) && tp >= 8) {
          // решётка вентиляции
          g.fillStyle = 'rgba(0,0,0,0.38)';
          for (var k = 0; k < 5; k++) g.fillRect(px + tp * 0.5, py + tp * (0.45 + k * 0.24), tp, Math.max(1, tp * 0.1));
        }
      }
    } else if (style === 'deck') {
      g.fillStyle = 'rgba(255,255,255,0.05)'; g.fillRect(0, 0, T, line); g.fillRect(0, 0, line, T);
      g.fillStyle = 'rgba(0,0,0,0.3)'; g.fillRect(0, T - line, T, line); g.fillRect(T - line, 0, line, T);
      g.fillStyle = 'rgba(0,0,0,0.3)'; g.fillRect(0, T / 2 - line / 2, T, line); g.fillRect(T / 2 - line / 2, 0, line, T);
      g.fillStyle = 'rgba(0,0,0,0.14)'; g.fillRect(T / 4 - line / 2, 0, line, T); g.fillRect(T * 3 / 4 - line / 2, 0, line, T);
      // потёртости и следы шасси
      for (k = 0; k < 16; k++) {
        var a = hash(k, 1, 9), b = hash(k, 2, 9);
        g.fillStyle = k % 2 ? 'rgba(0,0,0,0.09)' : 'rgba(255,255,255,0.04)';
        g.beginPath(); g.ellipse(a * T, b * T, tp * (0.4 + hash(k, 3, 9)), tp * 0.18, a * 3, 0, TAU); g.fill();
      }
      if (tp >= 16) { g.fillStyle = 'rgba(0,0,0,0.45)'; disc(g, tp * 0.5, tp * 0.5, tp * 0.12); disc(g, T - tp * 0.5, T - tp * 0.5, tp * 0.12); }
    } else if (style === 'grate') {
      g.fillStyle = shade(col, -0.35); g.fillRect(0, 0, T, T);
      g.fillStyle = shade(col, 0.05);
      var st = Math.max(2, tp * 0.25);
      for (k = 0; k < T; k += st) { g.fillRect(k, 0, Math.max(1, st * 0.45), T); }
      g.fillStyle = 'rgba(0,0,0,0.35)';
      for (k = 0; k < T; k += tp) g.fillRect(0, k, T, Math.max(1, tp * 0.12));
    } else if (style === 'smooth') {
      g.fillStyle = 'rgba(255,255,255,0.04)';
      g.beginPath(); g.moveTo(0, T * 0.65); g.lineTo(T * 0.65, 0); g.lineTo(T, 0); g.lineTo(0, T); g.closePath(); g.fill();
      g.fillStyle = 'rgba(0,0,0,0.22)';
      for (k = 0; k < T; k += tp * 4) { g.fillRect(0, k + tp * 4 - line, T, line); g.fillRect(k + tp * 4 - line, 0, line, T); }
      g.fillStyle = rep ? 'rgba(120,180,255,0.10)' : 'rgba(255,160,90,0.10)'; g.fillRect(0, T / 4, T, line); g.fillRect(0, T * 3 / 4, T, line);
    } else if (style === 'tile') {
      var q = tp / 2;
      for (i = 0; i < 16; i++) for (j = 0; j < 16; j++) {
        g.fillStyle = shade(col, (hash(i, j, 5) - 0.5) * 0.1); g.fillRect(i * q, j * q, q, q);
      }
      g.fillStyle = 'rgba(0,0,0,0.18)';
      for (k = 0; k <= T; k += q) { g.fillRect(k, 0, Math.max(1, line * 0.6), T); g.fillRect(0, k, T, Math.max(1, line * 0.6)); }
    }
    PAT[key] = g.createPattern(cv, 'repeat');
    return PAT[key];
  }

  // ---------------------------------------------------------------- кусок
  function chunk(cx, cy, tp) {
    var V = A.V, K = A.K, sh = V.ship, P = V.pal, rep = sh.faction === 'republic';
    var cv = document.createElement('canvas'); cv.width = cv.height = CH * tp;
    var c = cv.getContext('2d'), x0 = cx * CH, y0 = cy * CH, W = sh.w, x, y, i, k;
    var crop = sh.crop, sx = (crop[2] - crop[0]) / sh.w, sy = (crop[3] - crop[1]) / sh.h;
    var glows = [];
    // свет из предмета или отсека: свои координаты → координаты куска
    var mk = function(ox, oy) { return function(x, y, r, col) { glows.push([ox + x, oy + y, r, col]); }; };
    var at = function(gx, gy) { return (gx < 0 || gy < 0 || gx >= sh.w || gy >= sh.h) ? K.VOID : sh.kind[gy * W + gx]; };
    var open = function(gx, gy) { var kk = at(gx, gy); return kk === K.FLOOR || kk === K.DOOR; };
    var roomOf = function(gx, gy) { return (gx < 0 || gy < 0 || gx >= sh.w || gy >= sh.h) ? 0 : sh.room[gy * W + gx]; };
    var wallish = function(gx, gy) {
      var kk = at(gx, gy);
      if (kk === K.WALL) return true;
      if (kk !== K.TECH && kk !== K.HULL) return false;
      return open(gx - 1, gy) || open(gx + 1, gy) || open(gx, gy - 1) || open(gx, gy + 1);
    };

    // 1. корпус и техпространство
    c.imageSmoothingEnabled = true;
    c.drawImage(V.clip, x0 * sx, y0 * sy, CH * sx, CH * sy, 0, 0, CH * tp, CH * tp);
    c.globalCompositeOperation = 'source-atop';
    c.fillStyle = tp >= 8 ? P.plate : P.tech; c.fillRect(0, 0, CH * tp, CH * tp);
    c.globalCompositeOperation = 'source-over';
    if (tp >= 8) machinery(c, sh, K, x0, y0, tp, at, rep, glows);

    // 2. пол: материал по назначению отсека, полосами по строкам
    c.save(); c.translate(-x0 * tp, -y0 * tp);
    for (y = y0; y < y0 + CH && y < sh.h; y++) {
      var runStart = -1, runKey = null;
      for (x = x0; x <= x0 + CH; x++) {
        var key = null;
        if (x < x0 + CH && x < sh.w && open(x, y)) key = roomOf(x, y);
        if (key !== runKey) {
          if (runKey !== null) {
            var r0 = runKey ? sh.roomByN[runKey] : null, t = r0 ? r0.t : 'corridor';
            var col = r0 ? (P.floor[t] || P.corridor) : P.corridor;
            c.fillStyle = tp >= 8 ? pattern(c, STYLE[t] || 'plate', col, tp, rep) : col;
            c.fillRect(runStart * tp, y * tp, (x - runStart) * tp, tp);
          }
          runKey = key; runStart = x;
        }
      }
    }
    c.restore();

    // 3. убранство отсеков: разметка, ямы мостика, кольца опасности, трубы
    if (tp >= 8) {
      for (i = 0; i < sh.rooms.length; i++) {
        var r = sh.rooms[i];
        if (r.x > x0 + CH || r.y > y0 + CH || r.x + r.w < x0 || r.y + r.h < y0) continue;
        c.save(); c.translate((r.x - x0) * tp, (r.y - y0) * tp);
        decor(c, r, tp, rep, P, mk((r.x - x0) * tp, (r.y - y0) * tp), sh);
        c.restore();
      }
      corridors(c, sh, K, x0, y0, tp, at, roomOf, rep, P, glows);
    }

    // 4. тень у стен (затенение углов)
    if (tp >= 8) {
      var ao = [0.30, 0.16, 0.07], bw = tp * 0.18;
      for (y = 0; y < CH; y++) for (x = 0; x < CH; x++) {
        var gx = x0 + x, gy = y0 + y;
        if (!open(gx, gy)) continue;
        var n = wallish(gx, gy - 1), s2 = wallish(gx, gy + 1), w2 = wallish(gx - 1, gy), e = wallish(gx + 1, gy);
        if (!(n || s2 || w2 || e)) continue;
        for (k = 0; k < 3; k++) {
          c.fillStyle = 'rgba(0,0,0,' + ao[k] + ')';
          if (n) c.fillRect(x * tp, y * tp + k * bw, tp, bw);
          if (s2) c.fillRect(x * tp, (y + 1) * tp - (k + 1) * bw, tp, bw);
          if (w2) c.fillRect(x * tp + k * bw, y * tp, bw, tp);
          if (e) c.fillRect((x + 1) * tp - (k + 1) * bw, y * tp, bw, tp);
        }
      }
    }

    // 5. переборки: объём, швы, светильники, окна мостиков
    var lw = Math.max(1, tp * 0.14);
    for (y = 0; y < CH; y++) for (x = 0; x < CH; x++) {
      var wx = x0 + x, wy = y0 + y;
      if (!wallish(wx, wy)) continue;
      var px = x * tp, py = y * tp;
      c.fillStyle = P.wall; c.fillRect(px, py, tp, tp);
      if (tp >= 8) {
        c.fillStyle = 'rgba(255,255,255,0.10)'; c.fillRect(px, py, tp, tp * 0.22);
        c.fillStyle = 'rgba(0,0,0,0.16)'; c.fillRect(px, py + tp * 0.7, tp, tp * 0.3);
        if ((wx + wy) % 3 === 0) { c.fillStyle = 'rgba(0,0,0,0.22)'; c.fillRect(px + tp - 1, py, 1, tp); }
      }
      c.fillStyle = P.wallEdge;
      var fN = open(wx, wy - 1), fS = open(wx, wy + 1), fW = open(wx - 1, wy), fE = open(wx + 1, wy);
      if (fN) c.fillRect(px, py, tp, lw);
      if (fS) c.fillRect(px, py + tp - lw, tp, lw);
      if (fW) c.fillRect(px, py, lw, tp);
      if (fE) c.fillRect(px + tp - lw, py, lw, tp);
      // светильник на стене, свет падает на пол
      if (tp >= 8 && (fN || fS || fW || fE) && hash(wx, wy, 17) < 0.09) {
        var lx = px + tp / 2, ly = py + tp / 2, dx = fE ? 1 : fW ? -1 : 0, dy = fS ? 1 : fN ? -1 : 0;
        c.fillStyle = P.lamp; c.fillRect(lx - tp * 0.32 + dx * tp * 0.3, ly - tp * 0.32 + dy * tp * 0.3, tp * 0.64 - Math.abs(dx) * tp * 0.4, tp * 0.64 - Math.abs(dy) * tp * 0.4);
        glows.push([lx + dx * tp * 1.2, ly + dy * tp * 1.2, tp * 2.6, P.lampGlow]);
      }
    }
    // окна мостиков и обзорной палубы — по стене, обращённой к носу
    for (i = 0; i < sh.rooms.length; i++) {
      var rb = sh.rooms[i];
      if (rb.t !== 'bridge' && rb.t !== 'observe' && rb.t !== 'flight') continue;
      if (rb.y < y0 - 2 || rb.y > y0 + CH || rb.x > x0 + CH || rb.x + rb.w < x0) continue;
      for (x = rb.x + 2; x < rb.x + rb.w - 2; x++) {
        if (at(x, rb.y) !== K.WALL || !open(x, rb.y + 1)) continue;
        var wpx = (x - x0) * tp, wpy = (rb.y - y0) * tp;
        c.fillStyle = '#0b1220'; c.fillRect(wpx, wpy + tp * 0.15, tp, tp * 0.7);
        c.fillStyle = 'rgba(160,200,255,0.25)'; c.fillRect(wpx, wpy + tp * 0.15, tp, tp * 0.18);
        if (hash(x, rb.y, 4) < 0.35) { c.fillStyle = '#e8f0ff'; c.fillRect(wpx + hash(x, 1, 4) * tp, wpy + tp * (0.35 + hash(x, 2, 4) * 0.4), Math.max(1, tp * 0.06), Math.max(1, tp * 0.06)); }
        if (x % 3 === 0) { c.fillStyle = P.wall; c.fillRect(wpx, wpy, Math.max(1, tp * 0.15), tp); }
      }
    }

    // 6. двери
    for (i = 0; i < sh.doors.length; i++) {
      var d = sh.doors[i];
      if (d.x < x0 - 3 || d.y < y0 - 3 || d.x >= x0 + CH + 3 || d.y >= y0 + CH + 3) continue;
      door(c, d, (d.x - x0) * tp, (d.y - y0) * tp, tp, P, rep, glows);
    }

    // 6б. лазы
    if (sh.ducts && tp >= 4) for (i = 0; i < sh.ducts.length; i++) {
      var du = sh.ducts[i];
      [du.a, du.b].forEach(function(q) {
        if (q[0] < x0 - 2 || q[1] < y0 - 2 || q[0] >= x0 + CH + 2 || q[1] >= y0 + CH + 2) return;
        ductVent(c, (q[0] - x0 + 0.5) * tp, (q[1] - y0 + 0.5) * tp, tp);
      });
    }

    // 7. техника, мебель, малые корабли
    for (i = 0; i < sh.props.length; i++) {
      var p = sh.props[i];
      if (p.x + p.w + 1 < x0 || p.y + p.h + 1 < y0 || p.x - 1 > x0 + CH || p.y - 1 > y0 + CH) continue;
      c.save(); c.translate((p.x - x0) * tp, (p.y - y0) * tp);
      prop(c, p, tp, P, rep, mk((p.x - x0) * tp, (p.y - y0) * tp));
      c.restore();
    }

    // 8. свет: лампы, экраны, реакторы
    if (glows.length) {
      c.globalCompositeOperation = 'screen';
      for (i = 0; i < glows.length; i++) {
        var gl = glows[i], gr = c.createRadialGradient(gl[0], gl[1], 0, gl[0], gl[1], gl[2]);
        gr.addColorStop(0, gl[3]); gr.addColorStop(1, 'rgba(0,0,0,0)');
        c.fillStyle = gr; c.fillRect(gl[0] - gl[2], gl[1] - gl[2], gl[2] * 2, gl[2] * 2);
      }
      c.globalCompositeOperation = 'source-over';
    }

    // 9. по силуэту корпуса
    c.globalCompositeOperation = 'destination-in';
    c.drawImage(V.clip, x0 * sx, y0 * sy, CH * sx, CH * sy, 0, 0, CH * tp, CH * tp);
    c.globalCompositeOperation = 'source-over';
    return { cv: cv, tp: tp };
  }

  // ---------------------------------------------------------------- техпространство
  // Блоки 8×8 клеток: связки труб, баки, кабельные лотки, агрегаты
  function machinery(c, sh, K, x0, y0, tp, at, rep, glows) {
    var path = new Path2D(), any = false, x, y;
    for (y = 0; y < CH; y++) {
      var st = -1;
      for (x = 0; x <= CH; x++) {
        var tech = x < CH && at(x0 + x, y0 + y) === K.TECH;
        if (tech && st < 0) st = x;
        if (!tech && st >= 0) { path.rect(st * tp, y * tp, (x - st) * tp, tp); st = -1; any = true; }
      }
    }
    if (!any) return;
    c.save(); c.clip(path);
    var pipe = rep ? ['#5c636c', '#6c747e', '#4c535b'] : ['#5a5246', '#6a6152', '#4a433a'];
    for (var by = Math.floor(y0 / 8); by <= Math.floor((y0 + CH) / 8); by++) {
      for (var bx = Math.floor(x0 / 8); bx <= Math.floor((x0 + CH) / 8); bx++) {
        var h = hash(bx, by, 31), ox = (bx * 8 - x0) * tp, oy = (by * 8 - y0) * tp, B = 8 * tp;
        var m = Math.floor(h * 5);
        if (m === 0 || m === 1) {
          // связка труб вдоль или поперёк
          var vert = m === 1, n = 3 + Math.floor(hash(bx, by, 32) * 3);
          for (var i = 0; i < n; i++) {
            var w = tp * (0.35 + hash(bx + i, by, 33) * 0.5), off = tp * (1 + i * 1.3);
            c.fillStyle = 'rgba(0,0,0,0.45)';
            if (vert) c.fillRect(ox + off + tp * 0.12, oy, w, B); else c.fillRect(ox, oy + off + tp * 0.12, B, w);
            c.fillStyle = pipe[i % 3];
            if (vert) c.fillRect(ox + off, oy, w, B); else c.fillRect(ox, oy + off, B, w);
            c.fillStyle = 'rgba(255,255,255,0.12)';
            if (vert) c.fillRect(ox + off, oy, Math.max(1, w * 0.25), B); else c.fillRect(ox, oy + off, B, Math.max(1, w * 0.25));
            // фланцы
            c.fillStyle = 'rgba(0,0,0,0.4)';
            for (var f = tp * 2; f < B; f += tp * 3) {
              if (vert) c.fillRect(ox + off - tp * 0.08, oy + f, w + tp * 0.16, Math.max(1, tp * 0.14));
              else c.fillRect(ox + f, oy + off - tp * 0.08, Math.max(1, tp * 0.14), w + tp * 0.16);
            }
          }
        } else if (m === 2) {
          // баки
          for (var t2 = 0; t2 < 2; t2++) {
            var tx = ox + tp * (2.2 + t2 * 3.6), ty = oy + tp * (2.5 + hash(bx, by + t2, 34) * 3), tr = tp * 1.5;
            c.fillStyle = 'rgba(0,0,0,0.45)'; disc(c, tx + tp * 0.25, ty + tp * 0.25, tr);
            c.fillStyle = pipe[1]; disc(c, tx, ty, tr);
            c.fillStyle = pipe[2]; disc(c, tx, ty, tr * 0.7);
            c.strokeStyle = 'rgba(255,255,255,0.15)'; c.lineWidth = Math.max(1, tp * 0.08); ring(c, tx, ty, tr * 0.85);
          }
        } else if (m === 3) {
          // агрегаты с огоньками
          for (var a2 = 0; a2 < 3; a2++) {
            var ax = ox + tp * (1 + hash(bx, by, 40 + a2) * 4), ay = oy + tp * (1 + a2 * 2.3), aw = tp * (2 + hash(bx, by, 50 + a2) * 2), ah = tp * 1.6;
            c.fillStyle = 'rgba(0,0,0,0.45)'; c.fillRect(ax + tp * 0.2, ay + tp * 0.2, aw, ah);
            c.fillStyle = pipe[0]; c.fillRect(ax, ay, aw, ah);
            c.fillStyle = 'rgba(0,0,0,0.3)'; c.fillRect(ax + tp * 0.2, ay + tp * 0.3, aw - tp * 0.4, ah * 0.3);
            if (hash(bx, by, 60 + a2) < 0.5) { c.fillStyle = rep ? '#9fd0ff' : '#ffb067'; c.fillRect(ax + aw - tp * 0.5, ay + tp * 0.2, tp * 0.2, tp * 0.2); }
          }
        } else {
          // кабельный лоток
          c.fillStyle = 'rgba(0,0,0,0.35)'; c.fillRect(ox + tp * 3, oy, tp * 2, B);
          c.strokeStyle = rep ? 'rgba(150,170,190,0.5)' : 'rgba(170,150,110,0.5)'; c.lineWidth = Math.max(1, tp * 0.1);
          for (var cbl = 0; cbl < 4; cbl++) { c.beginPath(); c.moveTo(ox + tp * (3.3 + cbl * 0.45), oy); c.lineTo(ox + tp * (3.3 + cbl * 0.45), oy + B); c.stroke(); }
          c.fillStyle = 'rgba(255,255,255,0.08)';
          for (var rg = 0; rg < B; rg += tp * 1.5) c.fillRect(ox + tp * 3, oy + rg, tp * 2, Math.max(1, tp * 0.1));
        }
      }
    }
    c.restore();
  }

  // ---------------------------------------------------------------- коридоры
  function corridors(c, sh, K, x0, y0, tp, at, roomOf, rep, P, glows) {
    var corr = function(gx, gy) { var k = at(gx, gy); return (k === K.FLOOR || k === K.DOOR) && !roomOf(gx, gy); };
    for (var y = 0; y < CH; y++) for (var x = 0; x < CH; x++) {
      var gx = x0 + x, gy = y0 + y;
      if (!corr(gx, gy)) continue;
      var px = x * tp, py = y * tp;
      // огоньки вдоль стен коридора каждые 3 клетки
      var wn = !corr(gx, gy - 1) && at(gx, gy - 1) !== K.DOOR, ws = !corr(gx, gy + 1) && at(gx, gy + 1) !== K.DOOR;
      var ww = !corr(gx - 1, gy) && at(gx - 1, gy) !== K.DOOR, we = !corr(gx + 1, gy) && at(gx + 1, gy) !== K.DOOR;
      var r = Math.max(1, tp * 0.1);
      c.fillStyle = P.light;
      if (wn && gx % 3 === 0) { c.fillRect(px + tp * 0.4, py + tp * 0.3, r * 2, r); glows.push([px + tp / 2, py + tp * 0.4, tp * 0.9, P.stripGlow]); }
      if (ws && gx % 3 === 0) { c.fillRect(px + tp * 0.4, py + tp * 0.7 - r, r * 2, r); glows.push([px + tp / 2, py + tp * 0.6, tp * 0.9, P.stripGlow]); }
      if (ww && gy % 3 === 0) { c.fillRect(px + tp * 0.3, py + tp * 0.4, r, r * 2); glows.push([px + tp * 0.4, py + tp / 2, tp * 0.9, P.stripGlow]); }
      if (we && gy % 3 === 0) { c.fillRect(px + tp * 0.7 - r, py + tp * 0.4, r, r * 2); glows.push([px + tp * 0.6, py + tp / 2, tp * 0.9, P.stripGlow]); }
      // осевая полоса там, где коридор широкий
      var hz = corr(gx, gy - 2) && corr(gx, gy + 2) && corr(gx, gy - 1) && corr(gx, gy + 1);
      var vt = corr(gx - 2, gy) && corr(gx + 2, gy) && corr(gx - 1, gy) && corr(gx + 1, gy);
      if (hz && !vt && gy % 6 === 3) { c.fillStyle = P.corridorLine; c.fillRect(px, py + tp * 0.45, tp * 0.6, tp * 0.1); }
      if (vt && !hz && gx % 6 === 3) { c.fillStyle = P.corridorLine; c.fillRect(px + tp * 0.45, py, tp * 0.1, tp * 0.6); }
    }
  }

  // ---------------------------------------------------------------- убранство отсеков
  function decor(c, r, tp, rep, P, gl, sh) {
    var W = r.w * tp, H = r.h * tp, i, k;
    var hazA = rep ? '#c9c2b0' : '#d9a940', hazB = rep ? '#9a3a33' : '#1b1b1b';
    var props = roomProps(sh, r);
    var t = r.t;
    if (t === 'hangar') {
      // полоса вылета по оси, разметка, круги посадки
      var vert = r.h >= r.w;
      c.strokeStyle = 'rgba(232,200,90,0.55)'; c.lineWidth = Math.max(1, tp * 0.12); c.setLineDash([tp * 1.2, tp * 0.8]);
      if (vert) {
        var lx1 = W * 0.36, lx2 = W * 0.64;
        c.beginPath(); c.moveTo(lx1, tp * 3); c.lineTo(lx1, H - tp * 3); c.moveTo(lx2, tp * 3); c.lineTo(lx2, H - tp * 3); c.stroke();
        c.setLineDash([]);
        for (k = tp * 14; k < H - tp * 10; k += tp * 26) {
          c.strokeStyle = 'rgba(232,200,90,0.45)'; c.lineWidth = Math.max(1, tp * 0.14); ring(c, W / 2, k, tp * 4.2);
          c.fillStyle = 'rgba(232,200,90,0.35)';
          c.fillRect(W / 2 - tp * 1.4, k - tp * 0.15, tp * 2.8, tp * 0.3); c.fillRect(W / 2 - tp * 1.4, k - tp * 1.4, tp * 0.3, tp * 2.8); c.fillRect(W / 2 + tp * 1.1, k - tp * 1.4, tp * 0.3, tp * 2.8);
          // шевроны к носу
          c.fillStyle = 'rgba(232,200,90,0.3)';
          for (i = 0; i < 3; i++) {
            var cy2 = k + tp * 8 + i * tp * 1.6;
            c.beginPath(); c.moveTo(W / 2 - tp * 1.6, cy2 + tp); c.lineTo(W / 2, cy2); c.lineTo(W / 2 + tp * 1.6, cy2 + tp);
            c.lineTo(W / 2 + tp * 1.6, cy2 + tp * 1.5); c.lineTo(W / 2, cy2 + tp * 0.5); c.lineTo(W / 2 - tp * 1.6, cy2 + tp * 1.5); c.closePath(); c.fill();
          }
        }
      } else {
        c.beginPath(); c.moveTo(tp * 3, H * 0.5); c.lineTo(W - tp * 3, H * 0.5); c.stroke(); c.setLineDash([]);
      }
      // площадки стоянки под машинами
      props.forEach(function(p) {
        if (p.t !== 'craft') return;
        var px = (p.x - r.x) * tp, py = (p.y - r.y) * tp;
        c.strokeStyle = 'rgba(255,255,255,0.12)'; c.lineWidth = Math.max(1, tp * 0.08);
        c.strokeRect(px - tp * 0.5, py - tp * 0.5, p.w * tp + tp, p.h * tp + tp);
        c.fillStyle = 'rgba(232,200,90,0.35)';
        c.fillRect(px - tp * 0.5, py - tp * 0.5, tp * 1.2, Math.max(1, tp * 0.15)); c.fillRect(px - tp * 0.5, py - tp * 0.5, Math.max(1, tp * 0.15), tp * 1.2);
        // заправочный шланг к стене
        c.strokeStyle = 'rgba(30,30,30,0.6)'; c.lineWidth = Math.max(1, tp * 0.2);
        var side = p.x - r.x < r.w / 2 ? -1 : 1, hx = side < 0 ? px : px + p.w * tp;
        c.beginPath(); c.moveTo(hx, py + p.h * tp * 0.5); c.quadraticCurveTo(hx + side * tp * 1.5, py + p.h * tp * 0.8, side < 0 ? tp * 1.2 : W - tp * 1.2, py + p.h * tp * 0.6); c.stroke();
      });
    } else if (t === 'gun' || t === 'reactor' || t === 'shield' || t === 'hyper') {
      var core = null;
      props.forEach(function(p) { if (/turret_base|reactor_core|hyper_core|shield_gen/.test(p.t) && !core) core = p; });
      if (core) {
        var ccx = (core.x - r.x + core.w / 2) * tp, ccy = (core.y - r.y + core.h / 2) * tp, cr = Math.max(core.w, core.h) * tp / 2;
        // кабели и трубы от ядра к стенам
        var pipeCol = t === 'reactor' ? 'rgba(90,160,200,0.85)' : t === 'gun' ? (rep ? 'rgba(120,128,138,0.9)' : 'rgba(110,100,85,0.9)') : 'rgba(120,110,160,0.8)';
        c.lineCap = 'round';
        for (k = 0; k < 6; k++) {
          var an = k / 6 * TAU + 0.4;
          c.strokeStyle = 'rgba(0,0,0,0.45)'; c.lineWidth = tp * 0.7;
          c.beginPath(); c.moveTo(ccx + Math.cos(an) * cr, ccy + Math.sin(an) * cr + tp * 0.15); c.lineTo(ccx + Math.cos(an) * W, ccy + Math.sin(an) * H + tp * 0.15); c.stroke();
          c.strokeStyle = pipeCol; c.lineWidth = tp * 0.55;
          c.beginPath(); c.moveTo(ccx + Math.cos(an) * cr, ccy + Math.sin(an) * cr); c.lineTo(ccx + Math.cos(an) * W, ccy + Math.sin(an) * H); c.stroke();
        }
        c.lineCap = 'butt';
        // кольцо опасности
        var hr = cr + tp * 1.3;
        c.lineWidth = tp * 0.55;
        for (k = 0; k < 32; k++) {
          c.strokeStyle = k % 2 ? hazA : hazB;
          c.beginPath(); c.arc(ccx, ccy, hr, k / 32 * TAU, (k + 1) / 32 * TAU); c.stroke();
        }
      }
    } else if (t === 'bridge' || t === 'flight' || t === 'cic') {
      // ямы экипажа вдоль бортов, посередине — командный проход (как на мостике Венатора)
      var pitW = Math.max(tp * 3, W * 0.28), pitY = H * 0.24, pitH = H * 0.62;
      for (k = 0; k < 2; k++) {
        var pxp = k ? W - tp * 2 - pitW : tp * 2;
        c.fillStyle = 'rgba(0,0,0,0.38)'; c.fillRect(pxp, pitY, pitW, pitH);
        c.fillStyle = 'rgba(0,0,0,0.25)'; c.fillRect(pxp, pitY, pitW, tp * 0.35); c.fillRect(pxp, pitY, tp * 0.35, pitH);
        c.strokeStyle = 'rgba(255,255,255,0.10)'; c.lineWidth = 1; c.strokeRect(pxp + 0.5, pitY + 0.5, pitW - 1, pitH - 1);
        // ряды пультов в яме
        for (var row = pitY + tp; row < pitY + pitH - tp; row += tp * 2.2) {
          c.fillStyle = '#1a2028'; rr(c, pxp + tp * 0.5, row, pitW - tp, tp * 0.8, tp * 0.2); c.fill();
          c.fillStyle = P.light; c.globalAlpha = 0.7;
          for (var sc = pxp + tp * 0.8; sc < pxp + pitW - tp * 1.2; sc += tp * 1.2) c.fillRect(sc, row + tp * 0.15, tp * 0.8, tp * 0.25);
          c.globalAlpha = 1;
          gl(pxp + pitW / 2 + (r.x) * 0, row + tp * 0.3, pitW * 0.45, P.screenGlow);
        }
      }
      // командная дорожка
      c.fillStyle = 'rgba(255,255,255,0.05)'; c.fillRect(W / 2 - tp * 1.2, tp * 1.5, tp * 2.4, H - tp * 3);
      c.fillStyle = P.accentSoft; c.fillRect(W / 2 - tp * 1.2, tp * 1.5, tp * 0.15, H - tp * 3); c.fillRect(W / 2 + tp * 1.05, tp * 1.5, tp * 0.15, H - tp * 3);
    } else if (t === 'medbay') {
      c.fillStyle = rep ? 'rgba(190,60,50,0.35)' : 'rgba(60,110,200,0.3)';
      var mc = Math.min(W, H) * 0.12;
      c.fillRect(W / 2 - mc, H * 0.62 - mc * 3, mc * 2, mc * 6); c.fillRect(W / 2 - mc * 3, H * 0.62 - mc, mc * 6, mc * 2);
    } else if (t === 'quarters' || t === 'troops') {
      // шкафчики вдоль стен
      c.fillStyle = rep ? '#7b838d' : '#5f584b';
      for (k = tp * 1.5; k < W - tp * 1.5; k += tp * 0.9) { c.fillRect(k, tp * 1.05, tp * 0.8, tp * 0.7); c.fillRect(k, H - tp * 1.75, tp * 0.8, tp * 0.7); }
      c.fillStyle = 'rgba(0,0,0,0.3)';
      for (k = tp * 1.5; k < W - tp * 1.5; k += tp * 0.9) { c.fillRect(k + tp * 0.35, tp * 1.15, Math.max(1, tp * 0.06), tp * 0.5); }
    } else if (t === 'mess') {
      c.fillStyle = rep ? '#9aa2ab' : '#6e675a'; c.fillRect(tp * 1.2, tp * 1.1, W - tp * 2.4, tp * 1.1);
      c.fillStyle = 'rgba(255,255,255,0.15)'; c.fillRect(tp * 1.2, tp * 1.1, W - tp * 2.4, tp * 0.25);
    } else if (t === 'storage' || t === 'hold' || t === 'armory' || t === 'droids' || t === 'vehicle') {
      // жёлтая разметка зон хранения
      c.strokeStyle = 'rgba(230,190,70,0.4)'; c.lineWidth = Math.max(1, tp * 0.1);
      c.setLineDash([tp * 0.8, tp * 0.5]);
      c.strokeRect(tp * 1.6, tp * 1.6, W - tp * 3.2, H - tp * 3.2);
      c.setLineDash([]);
    } else if (t === 'engine') {
      c.lineWidth = tp * 0.5;
      for (k = 0; k < 24; k++) { c.strokeStyle = k % 2 ? hazA : hazB; c.beginPath(); c.moveTo(tp * 1.5 + k * (W - tp * 3) / 24, tp * 1.4); c.lineTo(tp * 1.5 + (k + 1) * (W - tp * 3) / 24, tp * 1.4); c.stroke(); }
    } else if (t === 'airlock') {
      c.save(); c.beginPath(); c.rect(tp, tp, W - tp * 2, H - tp * 2); c.clip();
      c.lineWidth = tp * 0.6;
      for (k = -H; k < W; k += tp * 1.2) { c.strokeStyle = (Math.round(k / tp / 1.2) % 2) ? hazA : hazB; c.beginPath(); c.moveTo(k, H); c.lineTo(k + H, 0); c.stroke(); }
      c.restore();
      c.fillStyle = 'rgba(0,0,0,0.35)'; c.fillRect(tp * 1.6, tp * 1.6, W - tp * 3.2, H - tp * 3.2);
    } else if (t === 'comms') {
      c.strokeStyle = 'rgba(110,170,230,0.35)'; c.lineWidth = Math.max(1, tp * 0.12);
      for (k = tp * 2; k < H - tp; k += tp * 1.6) { c.beginPath(); c.moveTo(tp * 1.5, k); c.lineTo(W - tp * 1.5, k); c.stroke(); }
    }
  }

  function roomProps(sh, r) {
    if (!sh._rp) {
      sh._rp = {};
      for (var i = 0; i < sh.props.length; i++) {
        var p = sh.props[i], n = sh.room[(p.y) * sh.w + p.x];
        (sh._rp[n] = sh._rp[n] || []).push(p);
      }
    }
    return sh._rp[r.n] || [];
  }

  // ---------------------------------------------------------------- двери
  function door(c, d, px, py, tp, P, rep, glows) {
    var len = (d.w || 2) * tp, deep = (d.d === 2 ? 2 : 1) * tp;
    var w = d.v ? deep : len, h = d.v ? len : deep;
    if (d.k === 'blast' || d.k === 'lock') return heavyDoor(c, d, px, py, w, h, tp, P, rep, glows);
    // рама
    c.fillStyle = P.wallEdge; c.fillRect(px, py, w, h);
    // створки, разъехавшиеся в стены
    c.fillStyle = P.door;
    if (d.v) { c.fillRect(px + w * 0.15, py, w * 0.7, tp * 0.35); c.fillRect(px + w * 0.15, py + h - tp * 0.35, w * 0.7, tp * 0.35); }
    else { c.fillRect(px, py + h * 0.15, tp * 0.35, h * 0.7); c.fillRect(px + w - tp * 0.35, py + h * 0.15, tp * 0.35, h * 0.7); }
    // порог с разметкой
    if (tp >= 8) {
      var n = 6, hazA = rep ? '#c9c2b0' : '#d9a940', hazB = rep ? '#9a3a33' : '#1b1b1b';
      for (var i = 0; i < n; i++) {
        c.fillStyle = i % 2 ? hazA : hazB;
        if (d.v) c.fillRect(px + w * 0.4, py + tp * 0.35 + i * (h - tp * 0.7) / n, w * 0.2, (h - tp * 0.7) / n);
        else c.fillRect(px + tp * 0.35 + i * (w - tp * 0.7) / n, py + h * 0.4, (w - tp * 0.7) / n, h * 0.2);
      }
      c.fillStyle = P.doorLight;
      var r = Math.max(1, tp * 0.14);
      if (d.v) { c.fillRect(px - r, py + h / 2 - r, r, r * 2); c.fillRect(px + w, py + h / 2 - r, r, r * 2); }
      else { c.fillRect(px + w / 2 - r, py - r, r * 2, r); c.fillRect(px + w / 2 - r, py + h, r * 2, r); }
      glows.push([px + w / 2, py + h / 2, tp * 1.4, P.doorGlow]);
    }
  }

  // Бронедверь (переборка) и внутренняя дверь шлюза: толстая рама, жёлто-чёрная
  // разметка, у шлюза — красные огни. При абордаже их запирают по тревоге.
  function heavyDoor(c, d, px, py, w, h, tp, P, rep, glows) {
    var lock = d.k === 'lock', fr = Math.max(1, tp * 0.28);
    c.fillStyle = '#1c2026'; c.fillRect(px - (d.v ? fr : 0), py - (d.v ? 0 : fr), w + (d.v ? fr * 2 : 0), h + (d.v ? 0 : fr * 2));
    c.fillStyle = P.wallEdge; c.fillRect(px, py, w, h);
    // створки сдвинуты, но видно массивные направляющие
    c.fillStyle = lock ? '#6d4a3a' : '#5d636b';
    if (d.v) { c.fillRect(px, py, w, tp * 0.5); c.fillRect(px, py + h - tp * 0.5, w, tp * 0.5); }
    else { c.fillRect(px, py, tp * 0.5, h); c.fillRect(px + w - tp * 0.5, py, tp * 0.5, h); }
    if (tp >= 6) {
      var n = Math.max(4, Math.round((d.v ? h : w) / tp * 1.5));
      for (var i = 0; i < n; i++) {
        c.fillStyle = i % 2 ? '#d9a940' : '#16181b';
        if (d.v) c.fillRect(px + w * 0.25, py + tp * 0.5 + i * (h - tp) / n, w * 0.5, (h - tp) / n);
        else c.fillRect(px + tp * 0.5 + i * (w - tp) / n, py + h * 0.25, (w - tp) / n, h * 0.5);
      }
      var r = Math.max(1, tp * 0.16);
      c.fillStyle = lock ? '#ff5a3a' : '#e3a24a';
      if (d.v) { c.fillRect(px - r * 1.5, py + h / 2 - r, r, r * 2); c.fillRect(px + w + r * 0.5, py + h / 2 - r, r, r * 2); }
      else { c.fillRect(px + w / 2 - r, py - r * 1.5, r * 2, r); c.fillRect(px + w / 2 - r, py + h + r * 0.5, r * 2, r); }
      glows.push([px + w / 2, py + h / 2, tp * 1.6, lock ? 'rgba(255,90,60,0.16)' : 'rgba(230,170,70,0.12)']);
    }
  }

  // Вход в лаз: решётка в полу у стены
  function ductVent(c, px, py, tp) {
    var s = tp * 1.6;
    c.fillStyle = '#121418'; c.fillRect(px - s / 2, py - s / 2, s, s);
    c.strokeStyle = '#5a616b'; c.lineWidth = Math.max(1, tp * 0.12); c.strokeRect(px - s / 2, py - s / 2, s, s);
    c.fillStyle = '#3a4048';
    for (var i = 1; i < 4; i++) c.fillRect(px - s / 2 + 1, py - s / 2 + i * s / 4, s - 2, Math.max(1, tp * 0.1));
  }

  // ---------------------------------------------------------------- предметы
  var CRAFT_SHADOW = {};
  function craftShadow(img, id) {
    if (CRAFT_SHADOW[id]) return CRAFT_SHADOW[id];
    var cv = document.createElement('canvas'); cv.width = img.width; cv.height = img.height;
    var g = cv.getContext('2d'); g.drawImage(img, 0, 0);
    g.globalCompositeOperation = 'source-in'; g.fillStyle = 'rgba(0,0,0,0.55)'; g.fillRect(0, 0, cv.width, cv.height);
    return (CRAFT_SHADOW[id] = cv);
  }

  function prop(c, p, tp, P, rep, gl) {
    var V = A.V, W = p.w * tp, H = p.h * tp, sd = 'rgba(0,0,0,0.38)', i, k;
    switch (p.t) {
      case 'craft': {
        var img = V.craft && V.craft[p.ship];
        if (!img) { c.fillStyle = sd; c.fillRect(0, 0, W, H); return; }
        c.drawImage(craftShadow(img, p.ship), tp * 0.5, tp * 0.6, W, H);
        c.drawImage(img, 0, 0, W, H);
        return;
      }
      case 'atte': case 'aat': return vehicle(c, W, H, tp, p.t);
      case 'pillar':
        c.fillStyle = sd; c.fillRect(tp * 0.3, tp * 0.3, W, H);
        c.fillStyle = P.wall; c.fillRect(0, 0, W, H);
        c.fillStyle = 'rgba(255,255,255,0.14)'; c.fillRect(0, 0, W, H * 0.22);
        c.fillStyle = P.wallEdge; c.fillRect(0, H - Math.max(1, tp * 0.12), W, Math.max(1, tp * 0.12));
        c.fillStyle = P.lamp; c.fillRect(W * 0.3, H * 0.4, W * 0.4, H * 0.12);
        gl(W / 2, H / 2, tp * 3, P.lampGlow);
        return;
      case 'bunk':
        c.fillStyle = sd; c.fillRect(tp * 0.2, tp * 0.2, W, H);
        c.fillStyle = rep ? '#8e97a1' : '#6e6858'; rr(c, 0, 0, W, H, tp * 0.2); c.fill();
        for (k = 0; k < 2; k++) {
          var by = k * H / 2;
          c.fillStyle = rep ? '#cfd5dc' : '#9c927d'; rr(c, tp * 0.12, by + tp * 0.12, W - tp * 0.24, H / 2 - tp * 0.2, tp * 0.12); c.fill();
          c.fillStyle = rep ? '#eef1f4' : '#c3b79e'; rr(c, tp * 0.2, by + tp * 0.2, tp * 0.7, H / 2 - tp * 0.36, tp * 0.12); c.fill();
          c.fillStyle = rep ? 'rgba(60,90,140,0.35)' : 'rgba(90,70,40,0.35)'; c.fillRect(W * 0.45, by + tp * 0.12, W * 0.5, H / 2 - tp * 0.2);
        }
        return;
      case 'table':
        c.fillStyle = 'rgba(0,0,0,0.3)';
        for (var s = tp * 0.6; s < W - tp * 0.3; s += tp) { disc(c, s, -tp * 0.35, tp * 0.24); disc(c, s, H + tp * 0.35, tp * 0.24); }
        c.fillStyle = sd; c.fillRect(tp * 0.2, tp * 0.2, W, H);
        c.fillStyle = rep ? '#a8b0b9' : '#80786a'; rr(c, 0, 0, W, H, tp * 0.3); c.fill();
        c.fillStyle = 'rgba(255,255,255,0.12)'; c.fillRect(tp * 0.2, tp * 0.15, W - tp * 0.4, tp * 0.2);
        for (s = tp * 0.7; s < W - tp * 0.4; s += tp * 1.4) { c.fillStyle = 'rgba(0,0,0,0.25)'; disc(c, s, H / 2, tp * 0.22); }
        return;
      case 'bed':
        c.fillStyle = sd; c.fillRect(tp * 0.2, tp * 0.2, W, H);
        c.fillStyle = '#c9d3d6'; rr(c, 0, 0, W, H, tp * 0.25); c.fill();
        c.fillStyle = '#7fbfb3'; c.fillRect(tp * 0.15, H * 0.3, W - tp * 0.3, H * 0.6);
        c.fillStyle = '#eef3f4'; c.fillRect(tp * 0.2, tp * 0.15, W - tp * 0.4, H * 0.18);
        c.fillStyle = '#1b2228'; c.fillRect(W - tp * 0.15, H * 0.1, tp * 0.35, tp * 0.6);
        c.fillStyle = '#7fe08a'; c.fillRect(W - tp * 0.1, H * 0.15, tp * 0.2, tp * 0.12);
        return;
      case 'bacta':
        gl(W / 2, H / 2, W * 1.3, 'rgba(90,220,210,0.55)');
        c.fillStyle = '#2a3b40'; disc(c, W / 2, H / 2, W * 0.48);
        c.fillStyle = 'rgba(120,240,225,0.85)'; disc(c, W / 2, H / 2, W * 0.35);
        c.fillStyle = 'rgba(255,255,255,0.6)'; disc(c, W * 0.42, H * 0.4, W * 0.08);
        return;
      case 'crates':
        for (var cx = 0; cx < p.w; cx++) for (var cy = 0; cy < p.h; cy++) {
          var hh = hash(p.x + cx, p.y + cy, 2);
          if (hh < 0.15) continue;
          var big = hh > 0.75, sz = big ? 0.92 : 0.7, ox = cx * tp + (1 - sz) * tp / 2, oy = cy * tp + (1 - sz) * tp / 2;
          c.fillStyle = sd; c.fillRect(ox + tp * 0.15, oy + tp * 0.15, sz * tp, sz * tp);
          var cc = rep ? (hh < 0.45 ? '#8e8a7a' : hh < 0.75 ? '#a7a18c' : '#6f7a86') : (hh < 0.45 ? '#6d6350' : hh < 0.75 ? '#857a62' : '#59606a');
          c.fillStyle = cc; c.fillRect(ox, oy, sz * tp, sz * tp);
          if (tp >= 8) {
            c.fillStyle = 'rgba(255,255,255,0.14)'; c.fillRect(ox, oy, sz * tp, Math.max(1, tp * 0.1));
            c.strokeStyle = 'rgba(0,0,0,0.35)'; c.lineWidth = 1; c.strokeRect(ox + tp * 0.12, oy + tp * 0.12, sz * tp - tp * 0.24, sz * tp - tp * 0.24);
            if (big) { c.fillStyle = rep ? 'rgba(190,60,50,0.6)' : 'rgba(230,170,60,0.6)'; c.fillRect(ox + sz * tp * 0.15, oy + sz * tp * 0.42, sz * tp * 0.7, sz * tp * 0.16); }
          }
        }
        return;
      case 'console': {
        var f = p.f || 0;
        c.fillStyle = sd; c.fillRect(tp * 0.15, tp * 0.15, W, H);
        c.fillStyle = '#20262e'; rr(c, 0, 0, W, H, tp * 0.2); c.fill();
        c.fillStyle = '#2d343d'; c.fillRect(tp * 0.1, f === 0 ? tp * 0.05 : H * 0.6, W - tp * 0.2, H * 0.35);
        c.fillStyle = P.light; c.globalAlpha = 0.85;
        for (i = 0; i < p.w; i++) c.fillRect(i * tp + tp * 0.18, f === 0 ? H * 0.5 : H * 0.12, tp * 0.64, H * 0.3);
        c.globalAlpha = 1;
        gl(W / 2, H / 2, W * 0.9, P.screenGlow);
        return;
      }
      case 'holotable':
        c.fillStyle = sd; disc(c, W / 2 + tp * 0.2, H / 2 + tp * 0.2, W * 0.5);
        c.fillStyle = '#1b2129'; disc(c, W / 2, H / 2, W * 0.5);
        c.strokeStyle = rep ? 'rgba(170,215,255,0.9)' : 'rgba(255,200,140,0.9)'; c.lineWidth = Math.max(1, tp * 0.1);
        ring(c, W / 2, H / 2, W * 0.32); ring(c, W / 2, H / 2, W * 0.18);
        c.beginPath(); c.moveTo(W * 0.2, H / 2); c.lineTo(W * 0.8, H / 2); c.moveTo(W / 2, H * 0.2); c.lineTo(W / 2, H * 0.8); c.stroke();
        gl(W / 2, H / 2, W * 1.1, rep ? 'rgba(120,190,255,0.55)' : 'rgba(255,170,90,0.5)');
        return;
      case 'turret_base': {
        var cxp = W / 2, cyp = H / 2, R = Math.min(W, H) / 2;
        c.fillStyle = sd; disc(c, cxp + tp * 0.4, cyp + tp * 0.4, R);
        c.fillStyle = rep ? '#7e868f' : '#5e564a'; disc(c, cxp, cyp, R);
        c.fillStyle = rep ? '#5a6169' : '#463f35'; disc(c, cxp, cyp, R * 0.86);
        c.strokeStyle = rep ? '#b9c0c8' : '#8e8370'; c.lineWidth = Math.max(1, tp * 0.12);
        c.beginPath();
        for (var a = 0; a < 48; a++) {
          var an = a / 48 * TAU, r1 = R * 0.88, r2 = R * (a % 4 ? 0.93 : 0.98);
          c.moveTo(cxp + Math.cos(an) * r1, cyp + Math.sin(an) * r1); c.lineTo(cxp + Math.cos(an) * r2, cyp + Math.sin(an) * r2);
        }
        c.stroke();
        c.fillStyle = '#23272d'; disc(c, cxp, cyp, R * 0.64);
        // подъёмники боеприпасов по кругу
        for (a = 0; a < 6; a++) {
          var aa = a / 6 * TAU + 0.5;
          c.fillStyle = rep ? '#8e959e' : '#6f6656'; rr(c, cxp + Math.cos(aa) * R * 0.52 - tp * 0.5, cyp + Math.sin(aa) * R * 0.52 - tp * 0.5, tp, tp, tp * 0.2); c.fill();
          c.fillStyle = P.light; c.fillRect(cxp + Math.cos(aa) * R * 0.52 - tp * 0.15, cyp + Math.sin(aa) * R * 0.52 - tp * 0.1, tp * 0.3, tp * 0.2);
        }
        // казённики двух стволов
        c.fillStyle = rep ? '#c9cfd6' : '#9a8e78'; rr(c, cxp - R * 0.3, cyp - R * 0.26, R * 0.6, R * 0.46, tp * 0.4); c.fill();
        c.fillStyle = 'rgba(0,0,0,0.25)'; c.fillRect(cxp - R * 0.3, cyp + R * 0.08, R * 0.6, R * 0.12);
        c.fillStyle = '#15181c';
        c.fillRect(cxp - R * 0.19, cyp - R * 0.92, R * 0.1, R * 0.68); c.fillRect(cxp + R * 0.09, cyp - R * 0.92, R * 0.1, R * 0.68);
        c.fillStyle = P.accent; c.fillRect(cxp - R * 0.3, cyp + R * 0.16, R * 0.6, R * 0.05);
        gl(cxp, cyp, R * 0.7, rep ? 'rgba(120,190,255,0.35)' : 'rgba(255,140,80,0.35)');
        return;
      }
      case 'pd_base':
        c.fillStyle = sd; disc(c, W / 2 + tp * 0.2, H / 2 + tp * 0.2, W * 0.48);
        c.fillStyle = rep ? '#9aa1aa' : '#6f6656'; disc(c, W / 2, H / 2, W * 0.48);
        c.fillStyle = '#262b31'; disc(c, W / 2, H / 2, W * 0.3);
        c.fillStyle = '#14171b'; c.fillRect(W * 0.4, 0, W * 0.08, H * 0.45); c.fillRect(W * 0.52, 0, W * 0.08, H * 0.45);
        return;
      case 'reactor_core':
        gl(W / 2, H / 2, W * 1.4, 'rgba(255,170,60,0.7)');
        c.fillStyle = '#2b2620'; disc(c, W / 2, H / 2, W * 0.5);
        c.strokeStyle = 'rgba(255,190,90,0.95)'; c.lineWidth = Math.max(1.5, tp * 0.22);
        ring(c, W / 2, H / 2, W * 0.42); ring(c, W / 2, H / 2, W * 0.28);
        c.strokeStyle = 'rgba(0,0,0,0.5)'; c.lineWidth = Math.max(1, tp * 0.15);
        for (k = 0; k < 8; k++) { var ak = k / 8 * TAU; c.beginPath(); c.moveTo(W / 2 + Math.cos(ak) * W * 0.3, H / 2 + Math.sin(ak) * W * 0.3); c.lineTo(W / 2 + Math.cos(ak) * W * 0.5, H / 2 + Math.sin(ak) * W * 0.5); c.stroke(); }
        c.fillStyle = 'rgba(255,240,200,1)'; disc(c, W / 2, H / 2, W * 0.14);
        return;
      case 'shield_gen':
        gl(W / 2, H / 2, W * 1.2, 'rgba(90,200,255,0.6)');
        c.fillStyle = '#26323a'; disc(c, W / 2, H / 2, W * 0.48);
        c.strokeStyle = 'rgba(140,220,255,0.95)'; c.lineWidth = Math.max(1, tp * 0.16);
        ring(c, W / 2, H / 2, W * 0.34); ring(c, W / 2, H / 2, W * 0.18);
        return;
      case 'hyper_core':
        gl(W / 2, H / 2, W * 1.2, 'rgba(170,120,255,0.6)');
        c.fillStyle = '#2a2433'; rr(c, 0, 0, W, H, tp * 0.6); c.fill();
        c.fillStyle = 'rgba(200,170,255,0.9)'; rr(c, W * 0.3, H * 0.15, W * 0.4, H * 0.7, tp * 0.4); c.fill();
        c.strokeStyle = 'rgba(0,0,0,0.4)'; c.lineWidth = Math.max(1, tp * 0.12);
        for (k = 1; k < 5; k++) { c.beginPath(); c.moveTo(W * 0.3, H * (0.15 + k * 0.14)); c.lineTo(W * 0.7, H * (0.15 + k * 0.14)); c.stroke(); }
        return;
      case 'engine_block':
        c.fillStyle = sd; c.fillRect(tp * 0.3, tp * 0.3, W, H);
        c.fillStyle = rep ? '#7d858f' : '#5f574b'; rr(c, 0, 0, W, H, tp * 0.8); c.fill();
        c.fillStyle = '#2a2f36'; rr(c, W * 0.18, H * 0.08, W * 0.64, H * 0.84, tp * 0.6); c.fill();
        c.strokeStyle = rep ? 'rgba(160,170,180,0.6)' : 'rgba(150,135,110,0.6)'; c.lineWidth = Math.max(1, tp * 0.12);
        for (k = 1; k < 5; k++) { c.beginPath(); c.moveTo(W * 0.18, H * k / 5); c.lineTo(W * 0.82, H * k / 5); c.stroke(); }
        gl(W / 2, H * 0.9, W * 0.9, rep ? 'rgba(120,190,255,0.6)' : 'rgba(255,150,80,0.55)');
        return;
      case 'droid_rack':
        c.fillStyle = sd; c.fillRect(tp * 0.2, tp * 0.2, W, H);
        c.fillStyle = '#2e2a24'; c.fillRect(0, 0, W, H);
        for (var dy = tp * 0.5; dy < H - tp * 0.2; dy += tp) {
          c.fillStyle = '#c9b88c'; c.beginPath(); c.ellipse(W / 2, dy, W * 0.34, tp * 0.2, 0, 0, TAU); c.fill();
          c.fillStyle = '#7a6845'; disc(c, W / 2, dy, tp * 0.12);
        }
        c.fillStyle = '#e3a24a'; c.fillRect(W * 0.1, tp * 0.1, W * 0.8, Math.max(1, tp * 0.08));
        return;
      case 'bench':
        c.fillStyle = sd; c.fillRect(tp * 0.2, tp * 0.2, W, H);
        c.fillStyle = rep ? '#8f969e' : '#6b6456'; c.fillRect(0, 0, W, H);
        c.fillStyle = '#3a4048'; c.fillRect(tp * 0.3, tp * 0.3, W * 0.35, H - tp * 0.6);
        c.fillStyle = '#c9a45c'; disc(c, W * 0.75, H * 0.5, tp * 0.3);
        c.fillStyle = P.light; c.globalAlpha = 0.6; c.fillRect(W * 0.55, tp * 0.2, W * 0.3, tp * 0.25); c.globalAlpha = 1;
        return;
      case 'hatch':
        c.fillStyle = '#2a2f36'; disc(c, W / 2, H / 2, W * 0.5);
        c.strokeStyle = '#d9a940'; c.lineWidth = Math.max(1, tp * 0.15); c.setLineDash([tp * 0.4, tp * 0.3]);
        ring(c, W / 2, H / 2, W * 0.4); c.setLineDash([]);
        c.fillStyle = '#4a5058'; disc(c, W / 2, H / 2, W * 0.22);
        return;
      case 'window':
        c.fillStyle = 'rgba(140,190,255,0.25)'; c.fillRect(0, 0, W, H);
        return;
      case 'apturret': {
        // противоабордажная турель: тумба, поворотная голова, два ствола к двери
        c.fillStyle = sd; disc(c, W / 2 + tp * 0.2, H / 2 + tp * 0.25, W * 0.5);
        c.fillStyle = '#2b3036'; disc(c, W / 2, H / 2, W * 0.48);
        c.fillStyle = rep ? '#b9c0c8' : '#8b8170'; disc(c, W / 2, H / 2, W * 0.34);
        c.strokeStyle = '#1b1e22'; c.lineWidth = Math.max(1, tp * 0.22);
        c.beginPath(); c.moveTo(W * 0.42, H * 0.5); c.lineTo(W * 0.42, -H * 0.15); c.moveTo(W * 0.58, H * 0.5); c.lineTo(W * 0.58, -H * 0.15); c.stroke();
        c.fillStyle = '#ff4a3a'; disc(c, W / 2, H / 2, Math.max(1, tp * 0.16));
        gl(W / 2, H / 2, tp * 1.8, 'rgba(255,70,50,0.18)');
        return;
      }
      case 'barricade':
        c.fillStyle = sd; c.fillRect(tp * 0.25, tp * 0.3, W, H);
        c.fillStyle = rep ? '#7a7f86' : '#6a6152'; c.fillRect(0, 0, W, H);
        c.fillStyle = '#d9a940'; c.fillRect(0, 0, W, Math.max(1, tp * 0.14)); c.fillRect(0, H - Math.max(1, tp * 0.14), W, Math.max(1, tp * 0.14));
        c.strokeStyle = 'rgba(0,0,0,0.4)'; c.lineWidth = Math.max(1, tp * 0.08); c.strokeRect(0, 0, W, H);
        return;
      case 'capacitor':
        c.fillStyle = sd; c.fillRect(tp * 0.3, tp * 0.3, W, H);
        c.fillStyle = '#2a2f36'; rr(c, 0, 0, W, H, tp * 0.3); c.fill();
        c.fillStyle = '#3d4550'; rr(c, W * 0.15, H * 0.15, W * 0.7, H * 0.7, tp * 0.2); c.fill();
        c.fillStyle = rep ? '#7fd0ff' : '#ffb060'; c.fillRect(W * 0.3, H * 0.42, W * 0.4, H * 0.16);
        gl(W / 2, H / 2, tp * 2.2, rep ? 'rgba(120,200,255,0.18)' : 'rgba(255,170,90,0.16)');
        return;
      case 'pump':
        c.fillStyle = sd; disc(c, W / 2 + tp * 0.25, H / 2 + tp * 0.3, W * 0.5);
        c.fillStyle = '#3a4a52'; disc(c, W / 2, H / 2, W * 0.48);
        c.strokeStyle = '#22292e'; c.lineWidth = Math.max(1, tp * 0.12); ring(c, W / 2, H / 2, W * 0.36);
        c.fillStyle = '#5c7380'; disc(c, W / 2, H / 2, W * 0.18);
        c.strokeStyle = '#2a3238'; c.lineWidth = Math.max(1, tp * 0.3);
        c.beginPath(); c.moveTo(W, H / 2); c.lineTo(W + tp, H / 2); c.stroke();
        return;
      default:
        c.fillStyle = sd; c.fillRect(0, 0, W, H);
    }
  }

  function vehicle(c, W, H, tp, kind) {
    c.fillStyle = 'rgba(0,0,0,0.4)'; c.fillRect(tp * 0.4, tp * 0.4, W, H);
    if (kind === 'atte') {
      c.fillStyle = '#5e6268';
      for (var i = 0; i < 3; i++) { c.fillRect(W * (0.18 + i * 0.28), 0, W * 0.08, H); }
      c.fillStyle = '#c6ccd2'; rr(c, W * 0.06, H * 0.2, W * 0.88, H * 0.6, tp * 0.4); c.fill();
      c.fillStyle = '#7d2a26'; c.fillRect(W * 0.06, H * 0.45, W * 0.88, H * 0.1);
      c.fillStyle = '#2a3440'; c.fillRect(W * 0.84, H * 0.38, W * 0.1, H * 0.24);
    } else {
      c.fillStyle = '#8e826b'; rr(c, 0, H * 0.1, W, H * 0.8, tp * 0.8); c.fill();
      c.fillStyle = '#6a604f'; disc(c, W * 0.55, H / 2, H * 0.28);
      c.fillStyle = '#2b2a26'; c.fillRect(W * 0.6, H * 0.46, W * 0.4, H * 0.08);
    }
  }

  // ---------- палитры ----------
  // Республика — светлые переборки, синие и красные метки; КНС — бронза и
  // тёмный металл, синие огни. Пол отсека тонирован по его назначению.
  A.PAL = {
    republic: {
      wall: '#c3c9d1', wallTop: '#e6eaef', wallEdge: '#4a525c', corridor: '#666e78', plate: 'rgba(28,32,38,0.93)',
      lamp: '#f2f6ff', lampGlow: 'rgba(200,225,255,0.22)', stripGlow: 'rgba(160,210,255,0.18)', screenGlow: 'rgba(120,190,255,0.16)',
      doorGlow: 'rgba(130,230,150,0.12)', accentSoft: 'rgba(192,69,58,0.55)', corridorLine: 'rgba(230,236,242,0.35)',
      accent: '#c0453a', light: '#9fd0ff', door: '#8b939c', doorLight: '#7fe08a', tech: 'rgba(6,9,14,0.55)',
      floor: {
        hangar: '#565d66', bridge: '#2b405c', flight: '#2b405c', cic: '#2e3f5a', gun: '#5d4640', pdgun: '#5a4642',
        reactor: '#5f5130', shield: '#2c5560', engine: '#544a40', hyper: '#463e5e', quarters: '#555d54', troops: '#525a52',
        mess: '#5c5b4c', medbay: '#3d5f59', armory: '#5d4b4b', storage: '#5a5548', hold: '#5a5548', workshop: '#5a5848',
        airlock: '#4a4e57', dock: '#4c5562', comms: '#33506a', observe: '#2b405c', vehicle: '#535a63', droids: '#585042',
        power: '#4a4f5c', pumps: '#3f5258'
      }
    },
    cis: {
      wall: '#8b8170', wallTop: '#b3a68e', wallEdge: '#2f2a23', corridor: '#4f4b45', plate: 'rgba(26,24,22,0.93)',
      lamp: '#ffd8a8', lampGlow: 'rgba(255,190,120,0.20)', stripGlow: 'rgba(110,160,240,0.18)', screenGlow: 'rgba(255,160,90,0.14)',
      doorGlow: 'rgba(230,160,70,0.12)', accentSoft: 'rgba(61,116,214,0.55)', corridorLine: 'rgba(110,160,230,0.35)',
      accent: '#3d74d6', light: '#7fb3ff', door: '#6c655a', doorLight: '#e3a24a', tech: 'rgba(8,8,10,0.6)',
      floor: {
        hangar: '#4a4741', bridge: '#2a3446', flight: '#2a3446', cic: '#2c3344', gun: '#54403a', pdgun: '#523f3a',
        reactor: '#58492a', shield: '#284650', engine: '#4a4038', hyper: '#3e3550', quarters: '#4b4c44', troops: '#4a4b44',
        mess: '#504d40', medbay: '#344c48', armory: '#504141', storage: '#4f4a3f', hold: '#4c473c', workshop: '#4f4c3e',
        airlock: '#40424a', dock: '#424852', comms: '#2c4258', observe: '#2a3446', vehicle: '#474b52', droids: '#4d4537',
        power: '#43464f', pumps: '#384a50'
      }
    }
  };

  A.chunk = chunk;
  A.init = function(V, K) { A.V = V; A.K = K; };
  root.ShipArt = A;
})(typeof self !== 'undefined' ? self : this);
