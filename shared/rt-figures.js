// Фигурки бойцов сверху — те же, что в демо «Палуба Мандатора»
// (клоны, B1, B2, BX). Рисуются кодом один раз в набор картинок:
// вид × поворот × кадр шага. В бою кадр только копируется на экран.
// Только браузер (canvas), ES5.

(function(root) {
  'use strict';

  var TAU = Math.PI * 2;
  var LEGION = '#3d74d6';
  var GRIP = { dc15a: [0.17, 0.055, 0.32, 0.045], dc15s: [0.15, 0.055, 0.26, 0.045], z6: [0.1, 0.125, 0.3, 0.06], e5: [0.13, 0.05, 0.27, 0.04] };
  var FIG = 1.3;            // фигурка крупнее клетки: читается и на телефоне

  function dot(c, x, y, r) { c.beginPath(); c.arc(x, y, r, 0, TAU); c.fill(); }
  function line(c, x0, y0, x1, y1) { c.beginPath(); c.moveTo(x0, y0); c.lineTo(x1, y1); c.stroke(); }
  function rr(c, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    c.beginPath();
    c.moveTo(x + r, y);
    c.lineTo(x + w - r, y); c.quadraticCurveTo(x + w, y, x + w, y + r);
    c.lineTo(x + w, y + h - r); c.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    c.lineTo(x + r, y + h); c.quadraticCurveTo(x, y + h, x, y + h - r);
    c.lineTo(x, y + r); c.quadraticCurveTo(x, y, x + r, y);
    c.closePath();
  }
  // Градиенты кешируем на каждый холст отдельно
  var GCW = new WeakMap();
  function grad(c, key, mk) {
    var m = GCW.get(c); if (!m) { m = {}; GCW.set(c, m); }
    return m[key] || (m[key] = mk(c));
  }

  // Ноги: шаг маятником по направлению хода, в покое — стойка
  function legs(c, u, o) {
    var st = o.st * u.mv, ph = u.phase, idle = 1 - u.mv;
    c.save(); c.rotate(u.legs);
    c.lineCap = 'round';
    for (var k = -1; k <= 1; k += 2) {
      var fx = Math.sin(ph + (k > 0 ? 0 : Math.PI)) * st + idle * k * 0.03;
      c.strokeStyle = o.col; c.lineWidth = o.w;
      line(c, 0, k * o.hip, fx, k * o.foot);
      c.fillStyle = o.bootCol;
      c.beginPath(); c.ellipse(fx + o.boot[0] * 0.45, k * o.foot, o.boot[0], o.boot[1], 0, 0, TAU); c.fill();
      if (o.bootEdge) { c.strokeStyle = o.bootEdge; c.lineWidth = 0.012; c.stroke(); }
    }
    c.restore();
  }

  function cloneGun(c, u) {
    var g = u.gun;
    c.lineCap = 'butt';
    if (g === 'z6') {
      c.strokeStyle = '#b8953c'; c.lineWidth = 0.022; c.setLineDash([0.018, 0.012]);
      c.beginPath(); c.moveTo(-0.13, 0.1); c.quadraticCurveTo(-0.02, 0.2, 0.12, 0.13); c.stroke(); c.setLineDash([]);
      c.fillStyle = '#383d45'; rr(c, 0.02, 0.03, 0.41, 0.085, 0.02); c.fill();
      c.fillStyle = '#4f565e'; rr(c, 0.06, 0.1, 0.12, 0.05, 0.015); c.fill();
      c.strokeStyle = 'rgba(255,255,255,0.12)'; c.lineWidth = 0.01; line(c, 0.05, 0.045, 0.4, 0.045);
      c.save(); c.translate(0.45, 0.072);
      c.fillStyle = '#24282d'; dot(c, 0, 0, 0.046);
      c.fillStyle = '#8a929b';
      for (var i = 0; i < 3; i++) { var a = i * 2.094; dot(c, Math.cos(a) * 0.024, Math.sin(a) * 0.024, 0.011); }
      c.restore();
    } else {
      var L = g === 'dc15s' ? 0.37 : g === 'sniper' ? 0.66 : 0.52;
      c.strokeStyle = '#2b3037'; c.lineWidth = 0.046; line(c, -0.05, 0.062, L, 0.045);
      c.strokeStyle = '#5b636d'; c.lineWidth = 0.014; line(c, 0.1, 0.039, L - 0.03, 0.035);
      c.fillStyle = '#1b1f24'; c.fillRect(0.13, 0.034, 0.1, 0.024);
      c.fillStyle = '#6d7680'; c.fillRect(L - 0.035, 0.03, 0.035, 0.03);
      if (g === 'sniper') { c.fillStyle = '#1b1f24'; rr(c, 0.18, 0.0, 0.16, 0.03, 0.012); c.fill(); }
    }
  }

  function clone(c, u) {
    var heavy = u.gun === 'z6', sniper = u.gun === 'sniper';
    legs(c, u, { w: 0.075, hip: 0.07, foot: 0.082, st: 0.17, col: '#cdd3da', bootCol: '#eef1f4', bootEdge: '#59626d', boot: [0.062, 0.038] });
    var bob = 1 + 0.035 * u.mv * Math.abs(Math.sin(u.phase));
    c.save(); c.rotate(u.aim); c.scale(bob, bob);
    c.lineJoin = 'round';
    c.fillStyle = heavy ? '#7b838e' : '#99a1ab';
    rr(c, heavy ? -0.23 : -0.21, heavy ? -0.125 : -0.095, heavy ? 0.14 : 0.1, heavy ? 0.25 : 0.19, 0.03); c.fill();
    c.strokeStyle = 'rgba(0,0,0,0.4)'; c.lineWidth = 0.012; c.stroke();
    c.fillStyle = 'rgba(0,0,0,0.25)'; c.fillRect(heavy ? -0.2 : -0.185, -0.06, 0.05, 0.12);
    c.fillStyle = grad(c, 'clT', function(x) {
      var g = x.createLinearGradient(0, -0.21, 0, 0.21);
      g.addColorStop(0, '#a9b0b9'); g.addColorStop(0.5, '#f6f8fa'); g.addColorStop(1, '#a9b0b9'); return g;
    });
    c.beginPath(); c.ellipse(-0.02, 0, 0.125, 0.205, 0, 0, TAU); c.fill();
    c.strokeStyle = '#69727d'; c.lineWidth = 0.012; c.stroke();
    for (var k = -1; k <= 1; k += 2) {
      c.fillStyle = '#eef1f4'; dot(c, -0.01, k * 0.168, 0.07);
      c.strokeStyle = '#76808b'; c.lineWidth = 0.012; c.stroke();
      c.save(); c.beginPath(); c.arc(-0.01, k * 0.168, 0.064, 0, TAU); c.clip();
      c.fillStyle = sniper ? '#5a6b3a' : LEGION; c.fillRect(-0.035, k * 0.168 - 0.07, 0.034, 0.14);
      c.restore();
    }
    cloneGun(c, u);
    var gp = GRIP[u.gun === 'sniper' ? 'dc15a' : u.gun];
    c.strokeStyle = '#e4e8ec'; c.lineWidth = 0.058; c.lineCap = 'round';
    c.beginPath(); c.moveTo(0.0, 0.16); c.lineTo(0.08, 0.155); c.lineTo(gp[0], gp[1]); c.stroke();
    c.beginPath(); c.moveTo(0.0, -0.16); c.lineTo(0.12, -0.11); c.lineTo(gp[2], gp[3]); c.stroke();
    c.strokeStyle = 'rgba(80,90,100,0.45)'; c.lineWidth = 0.01;
    line(c, 0.06, 0.135, 0.085, 0.175); line(c, 0.09, -0.15, 0.1, -0.11);
    c.fillStyle = '#262a30'; dot(c, gp[0], gp[1], 0.03); dot(c, gp[2], gp[3], 0.03);
    c.fillStyle = grad(c, 'clH', function(x) {
      var g = x.createRadialGradient(0.0, -0.035, 0.01, 0.035, 0, 0.12);
      g.addColorStop(0, '#ffffff'); g.addColorStop(1, '#bfc6ce'); return g;
    });
    dot(c, 0.035, 0, 0.113);
    c.strokeStyle = '#69727d'; c.lineWidth = 0.012; c.stroke();
    c.strokeStyle = sniper ? '#5a6b3a' : LEGION; c.lineWidth = 0.028; line(c, -0.065, 0, 0.1, 0);
    c.strokeStyle = '#14171c'; c.lineWidth = 0.032;
    c.beginPath(); c.arc(0.035, 0, 0.098, -0.78, 0.78); c.stroke();
    c.lineWidth = 0.028; line(c, 0.115, 0, 0.152, 0);
    c.restore();
  }

  function b1(c, u) {
    legs(c, u, { w: 0.032, hip: 0.05, foot: 0.072, st: 0.2, col: '#b9a476', bootCol: '#8a7651', boot: [0.055, 0.026] });
    c.save(); c.rotate(u.aim);
    c.lineJoin = 'round';
    c.fillStyle = '#9a8559'; rr(c, -0.155, -0.06, 0.075, 0.12, 0.02); c.fill();
    c.strokeStyle = 'rgba(60,48,30,0.6)'; c.lineWidth = 0.01; c.stroke();
    c.fillStyle = grad(c, 'b1T', function(x) {
      var g = x.createLinearGradient(0, -0.09, 0, 0.09);
      g.addColorStop(0, '#a38e5c'); g.addColorStop(0.5, '#e4d4a8'); g.addColorStop(1, '#a38e5c'); return g;
    });
    rr(c, -0.095, -0.088, 0.145, 0.176, 0.035); c.fill();
    c.strokeStyle = '#6a5a3e'; c.lineWidth = 0.01; c.stroke();
    c.strokeStyle = 'rgba(80,64,40,0.5)'; c.lineWidth = 0.008;
    for (var i = -1; i <= 1; i++) line(c, -0.075, i * 0.04, 0.03, i * 0.04);
    c.fillStyle = '#7a6845'; dot(c, -0.01, 0.102, 0.03); dot(c, -0.01, -0.102, 0.03);
    c.lineCap = 'butt';
    c.strokeStyle = '#33363b'; c.lineWidth = 0.04; line(c, -0.01, 0.06, 0.41, 0.04);
    c.strokeStyle = '#5c6067'; c.lineWidth = 0.012; line(c, 0.18, 0.033, 0.4, 0.033);
    c.fillStyle = '#25272b'; c.fillRect(0.08, 0.055, 0.05, 0.03);
    c.lineCap = 'round';
    var gp = GRIP.e5;
    c.strokeStyle = '#c3ae80'; c.lineWidth = 0.03;
    c.beginPath(); c.moveTo(-0.01, 0.102); c.lineTo(0.065, 0.125); c.lineTo(gp[0], gp[1]); c.stroke();
    c.beginPath(); c.moveTo(-0.01, -0.102); c.lineTo(0.12, -0.075); c.lineTo(gp[2], gp[3]); c.stroke();
    c.fillStyle = '#7a6845'; dot(c, gp[0], gp[1], 0.02); dot(c, gp[2], gp[3], 0.02);
    c.strokeStyle = '#7a6845'; c.lineWidth = 0.03; line(c, -0.005, 0, 0.07, 0);
    c.fillStyle = grad(c, 'b1H', function(x) {
      var g = x.createLinearGradient(0.03, 0, 0.25, 0);
      g.addColorStop(0, '#dccb9f'); g.addColorStop(1, '#b49e70'); return g;
    });
    c.beginPath(); c.ellipse(0.145, 0, 0.112, 0.047, 0, 0, TAU); c.fill();
    c.strokeStyle = '#6a5a3e'; c.lineWidth = 0.01; c.stroke();
    c.fillStyle = '#2a231a'; dot(c, 0.205, 0.03, 0.012); dot(c, 0.205, -0.03, 0.012);
    c.restore();
  }

  function b2(c, u) {
    legs(c, u, { w: 0.08, hip: 0.1, foot: 0.12, st: 0.13, col: '#4a535e', bootCol: '#383f48', boot: [0.085, 0.052], bootEdge: '#1d2228' });
    var sway = Math.sin(u.phase) * 0.06 * u.mv;
    c.save(); c.rotate(u.aim + sway);
    c.lineJoin = 'round';
    for (var k = -1; k <= 1; k += 2) {
      c.fillStyle = '#39414b'; dot(c, -0.03, k * 0.235, 0.08);
      c.strokeStyle = '#1d2228'; c.lineWidth = 0.012; c.stroke();
      c.strokeStyle = '#56616d'; c.lineWidth = 0.085; c.lineCap = 'round';
      line(c, -0.02, k * 0.235, 0.24, k * 0.205);
      c.fillStyle = '#2b3138'; rr(c, 0.22, k * 0.2 - 0.046, 0.17, 0.092, 0.022); c.fill();
      c.strokeStyle = 'rgba(255,255,255,0.1)'; c.lineWidth = 0.01; line(c, 0.24, k * 0.2 - 0.03, 0.37, k * 0.2 - 0.03);
      c.fillStyle = '#121519'; dot(c, 0.39, k * 0.2, 0.022);
    }
    c.fillStyle = grad(c, 'b2T', function(x) {
      var g = x.createLinearGradient(0, -0.25, 0, 0.25);
      g.addColorStop(0, '#3b434d'); g.addColorStop(0.5, '#8793a1'); g.addColorStop(1, '#3b434d'); return g;
    });
    c.beginPath();
    c.moveTo(-0.17, -0.2); c.lineTo(0.04, -0.23); c.lineTo(0.15, -0.1); c.lineTo(0.18, 0); c.lineTo(0.15, 0.1); c.lineTo(0.04, 0.23); c.lineTo(-0.17, 0.2);
    c.closePath(); c.fill();
    c.strokeStyle = '#1d2228'; c.lineWidth = 0.014; c.stroke();
    c.fillStyle = 'rgba(255,255,255,0.09)';
    c.beginPath(); c.moveTo(-0.05, -0.14); c.lineTo(0.1, -0.08); c.lineTo(0.125, 0); c.lineTo(0.1, 0.08); c.lineTo(-0.05, 0.14); c.closePath(); c.fill();
    c.strokeStyle = 'rgba(0,0,0,0.35)'; c.lineWidth = 0.01; line(c, -0.16, 0, -0.02, 0);
    c.fillStyle = '#272d34'; dot(c, 0.0, 0, 0.056);
    c.fillStyle = '#5c6672'; dot(c, 0.018, -0.015, 0.018);
    c.restore();
  }

  function bx(c, u) {
    legs(c, u, { w: 0.04, hip: 0.055, foot: 0.076, st: 0.22, col: '#4d4841', bootCol: '#35312c', boot: [0.06, 0.03] });
    c.save(); c.rotate(u.aim);
    c.lineJoin = 'round';
    c.fillStyle = '#3e3a34'; rr(c, -0.16, -0.065, 0.075, 0.13, 0.025); c.fill();
    c.fillStyle = grad(c, 'bxT', function(x) {
      var g = x.createLinearGradient(0, -0.1, 0, 0.1);
      g.addColorStop(0, '#38342f'); g.addColorStop(0.5, '#746c61'); g.addColorStop(1, '#38342f'); return g;
    });
    rr(c, -0.1, -0.1, 0.16, 0.2, 0.05); c.fill();
    c.strokeStyle = '#23201c'; c.lineWidth = 0.01; c.stroke();
    c.fillStyle = '#2c2925'; dot(c, -0.01, 0.115, 0.038); dot(c, -0.01, -0.115, 0.038);
    c.lineCap = 'butt';
    c.strokeStyle = '#2a2c30'; c.lineWidth = 0.04; line(c, -0.01, 0.06, 0.41, 0.04);
    c.strokeStyle = '#575b62'; c.lineWidth = 0.012; line(c, 0.18, 0.033, 0.4, 0.033);
    var gp = GRIP.e5;
    c.lineCap = 'round'; c.strokeStyle = '#5a544c'; c.lineWidth = 0.036;
    c.beginPath(); c.moveTo(-0.01, 0.115); c.lineTo(0.07, 0.13); c.lineTo(gp[0], gp[1]); c.stroke();
    c.beginPath(); c.moveTo(-0.01, -0.115); c.lineTo(0.12, -0.08); c.lineTo(gp[2], gp[3]); c.stroke();
    c.fillStyle = grad(c, 'bxH', function(x) {
      var g = x.createRadialGradient(0.02, -0.025, 0.005, 0.045, 0, 0.07);
      g.addColorStop(0, '#8a8277'); g.addColorStop(1, '#3a3631'); return g;
    });
    dot(c, 0.045, 0, 0.068);
    c.strokeStyle = '#1e1b18'; c.lineWidth = 0.01; c.stroke();
    var gl = c.createRadialGradient(0.098, 0, 0, 0.098, 0, 0.05);
    gl.addColorStop(0, 'rgba(255,255,255,0.9)'); gl.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = gl; dot(c, 0.098, 0, 0.05);
    c.fillStyle = '#f4f8ff'; dot(c, 0.095, 0, 0.014);
    c.restore();
  }

  var DRAW = { clone: clone, b1: b1, b2: b2, bx: bx };

  // Тень под фигуркой
  function shadow(c, r) {
    var g = c.createRadialGradient(0.05, 0.07, 0, 0.05, 0.07, r * 1.25);
    g.addColorStop(0, 'rgba(0,0,0,0.55)'); g.addColorStop(0.55, 'rgba(0,0,0,0.3)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = g; dot(c, 0.05, 0.07, r * 1.25);
  }

  // Набор картинок: для каждого вида — DIRS поворотов × FRAMES кадров.
  // Кадр 0 — стойка, 1..4 — шаг. Клетка атласа — cell×cell пикселей.
  var DIRS = 16, FRAMES = 5;
  function bake(types, cell) {
    // сетка 10 столбцов: атлас узкий и не упирается в пределы холста телефона
    var COLS = 10, per = DIRS * FRAMES;
    var cv = document.createElement('canvas');
    cv.width = COLS * cell; cv.height = Math.ceil(types.length * per / COLS) * cell;
    var c = cv.getContext('2d');
    var k = cell / (FIG * 1.15);           // пикселей на клетку поля внутри картинки
    for (var t = 0; t < types.length; t++) {
      var T = types[t];
      var gun = T.id === 'rep_sniper' ? 'sniper' : T.gun;
      for (var d = 0; d < DIRS; d++) {
        var ang = d / DIRS * TAU;
        for (var f = 0; f < FRAMES; f++) {
          var u = { aim: ang, legs: ang, mv: f === 0 ? 0 : 1, phase: f === 0 ? 0 : (f - 1) * (TAU / 4), gun: gun };
          c.save();
          var idx = t * per + d * FRAMES + f;
          c.translate((idx % COLS) * cell + cell / 2, Math.floor(idx / COLS) * cell + cell / 2);
          c.scale(k * FIG, k * FIG);
          shadow(c, T.rad);
          DRAW[T.draw](c, u);
          c.restore();
        }
      }
    }
    return { canvas: cv, cell: cell, dirs: DIRS, frames: FRAMES, cols: COLS, scale: FIG * 1.15 };
  }

  // Тело на полу: тот же облик, лёжа, потемнее — впечатывается в слой пола
  function corpse(c, T, ang, px) {
    c.save();
    c.scale(px, px);
    c.rotate(ang);
    c.fillStyle = 'rgba(10,8,6,0.45)';
    c.beginPath(); c.ellipse(0.02, 0.02, 0.32, 0.22, 0, 0, TAU); c.fill();
    c.globalAlpha = 0.6;
    var u = { aim: 0.5, legs: -0.4, mv: 0, phase: 0, gun: T.id === 'rep_sniper' ? 'sniper' : T.gun };
    DRAW[T.draw](c, u);
    c.restore();
  }

  root.SWRTFig = { bake: bake, corpse: corpse, DIRS: DIRS, FRAMES: FRAMES, FIG: FIG, TAU: TAU };
})(typeof self !== 'undefined' ? self : this);
