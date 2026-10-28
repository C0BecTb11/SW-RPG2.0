// Фигурки бойцов сверху — те же, что в демо «Палуба Мандатора»
// (клоны, B1, B2, BX). Рисуются кодом один раз в набор картинок:
// вид × поворот × кадр шага. В бою кадр только копируется на экран.
// Только браузер (canvas), ES5.

(function(root) {
  'use strict';

  var TAU = Math.PI * 2;
  var LEGION = '#3d74d6';
  var GRIP = { dc15a: [0.17, 0.055, 0.32, 0.045], dc15s: [0.15, 0.055, 0.26, 0.045], z6: [0.1, 0.125, 0.3, 0.06], e5: [0.13, 0.05, 0.27, 0.04],
               none: [0.2, 0.085, 0.2, -0.085], tool: [0.24, 0.07, 0.17, -0.1], kit: [0.2, 0.09, 0.2, -0.09] };
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
    if (g === 'none') return;
    if (g === 'tool') {
      // гидроключ/сварочник
      c.strokeStyle = '#3a3f46'; c.lineWidth = 0.034; line(c, 0.17, 0.07, 0.36, 0.06);
      c.fillStyle = '#d9a940'; rr(c, 0.33, 0.03, 0.06, 0.06, 0.012); c.fill();
      return;
    }
    if (g === 'kit') {
      // аптечка в руках
      c.fillStyle = '#eef1f4'; rr(c, 0.17, -0.07, 0.12, 0.14, 0.02); c.fill();
      c.strokeStyle = '#8a929b'; c.lineWidth = 0.008; c.stroke();
      c.fillStyle = '#c0453a'; c.fillRect(0.215, -0.045, 0.03, 0.09); c.fillRect(0.185, -0.015, 0.09, 0.03);
      return;
    }
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
    var heavy = u.gun === 'z6', sniper = u.gun === 'sniper', mark = u.mark || (sniper ? '#5a6b3a' : LEGION);
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
      c.fillStyle = mark; c.fillRect(-0.035, k * 0.168 - 0.07, 0.034, 0.14);
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
    c.strokeStyle = mark; c.lineWidth = 0.028; line(c, -0.065, 0, 0.1, 0);
    c.strokeStyle = '#14171c'; c.lineWidth = 0.032;
    c.beginPath(); c.arc(0.035, 0, 0.098, -0.78, 0.78); c.stroke();
    c.lineWidth = 0.028; line(c, 0.115, 0, 0.152, 0);
    c.restore();
  }

  function b1(c, u) {
    var unarmed = u.gun === 'none';
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
    // метки по службе: пилоты — синие, командование — жёлтые (как в каноне OOM)
    if (u.mark) { c.fillStyle = u.mark; rr(c, -0.07, -0.05, 0.07, 0.1, 0.015); c.fill(); }
    c.lineCap = 'butt';
    if (!unarmed) {
      c.strokeStyle = '#33363b'; c.lineWidth = 0.04; line(c, -0.01, 0.06, 0.41, 0.04);
      c.strokeStyle = '#5c6067'; c.lineWidth = 0.012; line(c, 0.18, 0.033, 0.4, 0.033);
      c.fillStyle = '#25272b'; c.fillRect(0.08, 0.055, 0.05, 0.03);
    }
    c.lineCap = 'round';
    var gp = unarmed ? GRIP.none : GRIP.e5;
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
    if (u.mark) { c.fillStyle = u.mark; c.beginPath(); c.ellipse(0.12, 0, 0.05, 0.03, 0, 0, TAU); c.fill(); }
    c.fillStyle = '#2a231a'; dot(c, 0.205, 0.03, 0.012); dot(c, 0.205, -0.03, 0.012);
    c.restore();
  }

  // Офицер флота Республики: серый китель, фуражка, без брони
  function officer(c, u) {
    legs(c, u, { w: 0.06, hip: 0.06, foot: 0.075, st: 0.17, col: '#4b525b', bootCol: '#1c1f23', boot: [0.058, 0.034] });
    c.save(); c.rotate(u.aim);
    c.lineJoin = 'round';
    c.fillStyle = grad(c, 'ofT', function(x) {
      var g = x.createLinearGradient(0, -0.19, 0, 0.19);
      g.addColorStop(0, '#7e8791'); g.addColorStop(0.5, '#c3cad2'); g.addColorStop(1, '#7e8791'); return g;
    });
    c.beginPath(); c.ellipse(-0.02, 0, 0.12, 0.2, 0, 0, TAU); c.fill();
    c.strokeStyle = '#3d434a'; c.lineWidth = 0.012; c.stroke();
    // планка с наградами
    c.fillStyle = '#c0453a'; c.fillRect(0.0, 0.05, 0.03, 0.05); c.fillStyle = '#4a90d9'; c.fillRect(0.0, 0.1, 0.03, 0.03);
    // руки за спиной/у планшета
    c.strokeStyle = '#a9b1ba'; c.lineWidth = 0.05; c.lineCap = 'round';
    c.beginPath(); c.moveTo(0.0, 0.15); c.lineTo(0.1, 0.12); c.lineTo(0.17, 0.05); c.stroke();
    c.beginPath(); c.moveTo(0.0, -0.15); c.lineTo(0.1, -0.12); c.lineTo(0.17, -0.05); c.stroke();
    c.fillStyle = '#2a3440'; rr(c, 0.15, -0.07, 0.07, 0.14, 0.015); c.fill();
    c.fillStyle = 'rgba(120,200,255,0.8)'; c.fillRect(0.165, -0.05, 0.04, 0.1);
    // голова в фуражке
    c.fillStyle = '#4b525b'; dot(c, 0.03, 0, 0.1);
    c.fillStyle = '#8d959f'; dot(c, 0.03, 0, 0.075);
    c.fillStyle = '#d9a940'; c.fillRect(0.045, -0.02, 0.03, 0.04);
    c.fillStyle = '#1c1f23'; c.beginPath(); c.ellipse(0.1, 0, 0.035, 0.08, 0, -1.4, 1.4); c.fill();
    c.restore();
  }

  // Ремонтный дроид КНС: приземистый корпус, две руки-манипулятора, оптика
  function droidEng(c, u, med) {
    legs(c, u, { w: 0.045, hip: 0.07, foot: 0.09, st: 0.14, col: '#4e4a42', bootCol: '#2e2b26', boot: [0.05, 0.035] });
    var sway = Math.sin(u.phase) * 0.05 * u.mv;
    c.save(); c.rotate(u.aim + sway);
    c.lineJoin = 'round';
    c.fillStyle = grad(c, med ? 'dmT' : 'deT', function(x) {
      var g = x.createRadialGradient(-0.02, -0.03, 0.01, 0, 0, 0.16);
      g.addColorStop(0, med ? '#c9d2da' : '#b8a27a'); g.addColorStop(1, med ? '#5a6570' : '#5e5038'); return g;
    });
    dot(c, -0.01, 0, 0.14);
    c.strokeStyle = '#2a2620'; c.lineWidth = 0.012; c.stroke();
    // манипуляторы
    c.strokeStyle = '#3e3a33'; c.lineWidth = 0.03; c.lineCap = 'round';
    line(c, 0.05, 0.1, 0.24, 0.1); line(c, 0.05, -0.1, 0.24, -0.08);
    c.fillStyle = med ? '#4a90d9' : '#d9a940'; dot(c, 0.25, 0.1, 0.028); dot(c, 0.25, -0.08, 0.028);
    // оптика
    c.fillStyle = '#1a1814'; rr(c, 0.06, -0.05, 0.08, 0.1, 0.02); c.fill();
    c.fillStyle = med ? '#7fd8ff' : '#ff7a3a'; dot(c, 0.12, -0.022, 0.016); dot(c, 0.12, 0.022, 0.016);
    if (med) { c.fillStyle = '#e8eef2'; c.fillRect(-0.07, -0.015, 0.08, 0.03); c.fillRect(-0.045, -0.04, 0.03, 0.08); }
    c.restore();
  }
  function droidMed(c, u) { droidEng(c, u, true); }

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

  // ---------------------------------------------------------------- охотники бара
  // Мандалорец (как Джанго и Боба Фетт): реактивный ранец с ракетой, Т-образный визор, наплечники,
  // по бластеру в каждой руке; у охотника КНС — плащ. Окраска — по u.mark (ключ MANDO)
  var MANDO = {
    jango: { suit: ['#2d3642', '#4e5b6c'], armor: ['#6f8296', '#d3dbe3'], helm: ['#8796a6', '#eef2f6'], visor: '#0d1116', pack: ['#7c8792', '#d8dee4'],
             trim: '#3366a8', cape: null, boot: '#1f252c', glove: '#3a4552', tip: '#c43d2e' },
    boba:  { suit: ['#3f433b', '#62685a'], armor: ['#7d6c34', '#dcc277'], helm: ['#8c7638', '#ecd593'], visor: '#0f110d', pack: ['#4f5a3c', '#8c9a6c'],
             trim: '#8c2f20', cape: '#4a3323', boot: '#3b3026', glove: '#5a4430', tip: '#d9a940' }
  };
  function mando(c, u) {
    var P = MANDO[u.mark] || MANDO.jango;
    legs(c, u, { w: 0.07, hip: 0.065, foot: 0.08, st: 0.18, col: P.suit[1], bootCol: P.boot, bootEdge: 'rgba(0,0,0,0.5)', boot: [0.06, 0.036] });
    var bob = 1 + 0.03 * u.mv * Math.abs(Math.sin(u.phase));
    c.save(); c.rotate(u.aim); c.scale(bob, bob);
    c.lineJoin = 'round';
    // плащ: от плеч назад, складки
    if (P.cape) {
      var sw = Math.sin(u.phase) * 0.025 * u.mv;
      c.fillStyle = P.cape;
      c.beginPath(); c.moveTo(-0.02, -0.17); c.quadraticCurveTo(-0.2, -0.24 + sw, -0.34, -0.17 + sw); c.lineTo(-0.36, 0.17 + sw); c.quadraticCurveTo(-0.2, 0.24 + sw, -0.02, 0.17); c.closePath(); c.fill();
      c.strokeStyle = 'rgba(0,0,0,0.35)'; c.lineWidth = 0.012;
      for (var f = -1; f <= 1; f++) line(c, -0.12, f * 0.09, -0.33, f * 0.11 + sw);
    }
    // ранец: корпус, два сопла, ракета посередине
    c.fillStyle = grad(c, 'mdP' + u.mark, function(x) { var g = x.createLinearGradient(0, -0.1, 0, 0.1); g.addColorStop(0, P.pack[0]); g.addColorStop(0.5, P.pack[1]); g.addColorStop(1, P.pack[0]); return g; });
    rr(c, -0.245, -0.105, 0.12, 0.21, 0.03); c.fill();
    c.strokeStyle = 'rgba(0,0,0,0.45)'; c.lineWidth = 0.01; c.stroke();
    for (var k = -1; k <= 1; k += 2) {
      c.fillStyle = P.pack[1]; rr(c, -0.275, k * 0.075 - 0.03, 0.13, 0.06, 0.03); c.fill();
      c.strokeStyle = 'rgba(0,0,0,0.5)'; c.lineWidth = 0.01; c.stroke();
      c.fillStyle = '#15181c'; c.beginPath(); c.ellipse(-0.268, k * 0.075, 0.012, 0.022, 0, 0, TAU); c.fill();
    }
    c.fillStyle = '#c9ced4'; dot(c, -0.19, 0, 0.026);
    c.fillStyle = P.tip; dot(c, -0.19, 0, 0.013);
    // торс в комбинезоне, нагрудник и пояс
    c.fillStyle = grad(c, 'mdS' + u.mark, function(x) { var g = x.createLinearGradient(0, -0.2, 0, 0.2); g.addColorStop(0, P.suit[0]); g.addColorStop(0.5, P.suit[1]); g.addColorStop(1, P.suit[0]); return g; });
    c.beginPath(); c.ellipse(-0.03, 0, 0.12, 0.195, 0, 0, TAU); c.fill();
    c.strokeStyle = 'rgba(0,0,0,0.45)'; c.lineWidth = 0.011; c.stroke();
    c.fillStyle = grad(c, 'mdA' + u.mark, function(x) { var g = x.createLinearGradient(0, -0.14, 0, 0.14); g.addColorStop(0, P.armor[0]); g.addColorStop(0.45, P.armor[1]); g.addColorStop(1, P.armor[0]); return g; });
    c.beginPath(); c.moveTo(-0.04, -0.12); c.lineTo(0.06, -0.1); c.quadraticCurveTo(0.1, 0, 0.06, 0.1); c.lineTo(-0.04, 0.12); c.quadraticCurveTo(-0.01, 0, -0.04, -0.12); c.closePath(); c.fill();
    c.strokeStyle = 'rgba(0,0,0,0.4)'; c.lineWidth = 0.009; c.stroke();
    c.strokeStyle = P.trim; c.lineWidth = 0.014; line(c, 0.0, -0.075, 0.0, 0.075);
    // наплечники
    for (var k2 = -1; k2 <= 1; k2 += 2) {
      c.fillStyle = grad(c, 'mdH' + u.mark + k2, function(x) { var g = x.createRadialGradient(-0.03, k2 * 0.15, 0.005, -0.01, k2 * 0.168, 0.075); g.addColorStop(0, P.armor[1]); g.addColorStop(1, P.armor[0]); return g; });
      dot(c, -0.012, k2 * 0.168, 0.066);
      c.strokeStyle = 'rgba(0,0,0,0.45)'; c.lineWidth = 0.01; c.stroke();
      c.strokeStyle = P.trim; c.lineWidth = 0.012; c.beginPath(); c.arc(-0.012, k2 * 0.168, 0.045, k2 > 0 ? -2.2 : 0.6, k2 > 0 ? -0.6 : 2.2); c.stroke();
    }
    // руки вперёд: по бластеру в каждой, наручи цвета брони
    c.lineCap = 'round';
    var hx = 0.215, hy = 0.105;
    c.strokeStyle = P.suit[1]; c.lineWidth = 0.052;
    c.beginPath(); c.moveTo(0.0, 0.16); c.lineTo(0.1, 0.16); c.lineTo(hx, hy); c.stroke();
    c.beginPath(); c.moveTo(0.0, -0.16); c.lineTo(0.1, -0.16); c.lineTo(hx, -hy); c.stroke();
    c.strokeStyle = P.armor[0]; c.lineWidth = 0.056;
    line(c, 0.12, 0.148, 0.18, 0.123); line(c, 0.12, -0.148, 0.18, -0.123);
    c.lineCap = 'butt';
    for (var k3 = -1; k3 <= 1; k3 += 2) {
      c.strokeStyle = '#24282e'; c.lineWidth = 0.036; line(c, hx - 0.02, k3 * hy, hx + 0.16, k3 * (hy - 0.006));
      c.strokeStyle = '#59616b'; c.lineWidth = 0.01; line(c, hx + 0.01, k3 * (hy - 0.01), hx + 0.15, k3 * (hy - 0.014));
      c.fillStyle = '#121418'; c.fillRect(hx + 0.13, k3 * (hy - 0.006) - 0.012, 0.035, 0.024);
      c.fillStyle = P.glove; dot(c, hx, k3 * hy, 0.03);
    }
    // шлем: Т-визор впереди, дальномер слева, гребень цвета отделки
    c.fillStyle = grad(c, 'mdK' + u.mark, function(x) { var g = x.createRadialGradient(0.0, -0.035, 0.008, 0.03, 0, 0.12); g.addColorStop(0, P.helm[1]); g.addColorStop(1, P.helm[0]); return g; });
    dot(c, 0.03, 0, 0.105);
    c.strokeStyle = 'rgba(0,0,0,0.5)'; c.lineWidth = 0.011; c.stroke();
    c.strokeStyle = P.trim; c.lineWidth = 0.014; line(c, -0.055, 0, 0.03, 0);
    c.strokeStyle = P.visor; c.lineWidth = 0.026;
    c.beginPath(); c.arc(0.03, 0, 0.082, -0.58, 0.58); c.stroke();
    c.lineWidth = 0.02; line(c, 0.075, 0, 0.11, 0);
    c.strokeStyle = '#2c3138'; c.lineWidth = 0.012; line(c, 0.0, -0.1, 0.05, -0.155);
    c.fillStyle = '#c33a2b'; dot(c, 0.052, -0.158, 0.012);
    c.restore();
  }

  // Ящер-следопыт (трандошанин, барабел): чешуя, морда вперёд, жёлтые глаза; дробовик в обеих руках,
  // на спине барабан сетемёта, через грудь патронташ. Окраска — по u.mark (ключ LIZARD)
  var LIZARD = {
    trando:  { skin: ['#4b6128', '#8ea552'], scale: 'rgba(30,45,15,0.45)', suit: ['#9a6c24', '#dcae54'], strap: '#4a3220', eye: '#ffb02e', ridge: '#34461c', spikes: false },
    barabel: { skin: ['#6a5634', '#b39a62'], scale: 'rgba(60,42,20,0.45)', suit: ['#35485c', '#6e86a0'], strap: '#3a2a1c', eye: '#ffd84a', ridge: '#4a3a22', spikes: true }
  };
  function lizard(c, u) {
    var P = LIZARD[u.mark] || LIZARD.trando;
    legs(c, u, { w: 0.08, hip: 0.07, foot: 0.088, st: 0.16, col: P.skin[0], bootCol: P.ridge, bootEdge: 'rgba(0,0,0,0.45)', boot: [0.068, 0.04] });
    var bob = 1 + 0.03 * u.mv * Math.abs(Math.sin(u.phase));
    c.save(); c.rotate(u.aim); c.scale(bob, bob);
    c.lineJoin = 'round';
    // барабан сетемёта за спиной: сетка на крышке
    c.fillStyle = '#3a3f46'; dot(c, -0.2, -0.05, 0.072);
    c.strokeStyle = 'rgba(0,0,0,0.55)'; c.lineWidth = 0.01; c.stroke();
    c.save(); c.beginPath(); c.arc(-0.2, -0.05, 0.056, 0, TAU); c.clip();
    c.fillStyle = '#5a6068'; c.fillRect(-0.26, -0.11, 0.12, 0.12);
    c.strokeStyle = 'rgba(220,210,170,0.65)'; c.lineWidth = 0.007;
    for (var nx = -0.27; nx < -0.13; nx += 0.022) { line(c, nx, -0.11, nx + 0.06, 0.01); line(c, nx + 0.06, -0.11, nx, 0.01); }
    c.restore();
    c.fillStyle = '#2a2e33'; rr(c, -0.17, 0.03, 0.06, 0.09, 0.015); c.fill();
    // торс в лётном комбинезоне, плечи широкие
    c.fillStyle = grad(c, 'lzS' + u.mark, function(x) { var g = x.createLinearGradient(0, -0.22, 0, 0.22); g.addColorStop(0, P.suit[0]); g.addColorStop(0.5, P.suit[1]); g.addColorStop(1, P.suit[0]); return g; });
    c.beginPath(); c.ellipse(-0.035, 0, 0.13, 0.215, 0, 0, TAU); c.fill();
    c.strokeStyle = 'rgba(0,0,0,0.45)'; c.lineWidth = 0.012; c.stroke();
    // патронташ через грудь
    c.strokeStyle = P.strap; c.lineWidth = 0.034; line(c, -0.11, -0.16, 0.06, 0.15);
    c.fillStyle = '#c9a24a';
    for (var b = 0; b < 5; b++) { var q = 0.15 + b * 0.16; c.fillRect(-0.11 + 0.17 * q - 0.008, -0.16 + 0.31 * q - 0.008, 0.016, 0.016); }
    // дробовик: толстый ствол, широкий раструб, барабан
    c.lineCap = 'butt';
    c.strokeStyle = '#2a2d31'; c.lineWidth = 0.062; line(c, -0.04, 0.066, 0.44, 0.05);
    c.strokeStyle = '#555c64'; c.lineWidth = 0.014; line(c, 0.06, 0.038, 0.42, 0.03);
    c.fillStyle = '#1b1e22'; rr(c, 0.42, 0.0, 0.07, 0.1, 0.018); c.fill();
    c.fillStyle = '#0b0c0e'; c.fillRect(0.47, 0.022, 0.022, 0.056);
    c.fillStyle = '#3c4148'; dot(c, 0.14, 0.11, 0.04); c.fillStyle = '#7d858e'; dot(c, 0.14, 0.11, 0.016);
    // руки — чешуя, когти
    c.lineCap = 'round';
    c.strokeStyle = P.skin[0]; c.lineWidth = 0.052;
    c.beginPath(); c.moveTo(0.0, 0.17); c.lineTo(0.085, 0.165); c.lineTo(0.17, 0.08); c.stroke();
    c.beginPath(); c.moveTo(0.0, -0.17); c.lineTo(0.13, -0.12); c.lineTo(0.29, 0.05); c.stroke();
    c.fillStyle = P.ridge; dot(c, 0.17, 0.08, 0.03); dot(c, 0.29, 0.05, 0.03);
    c.strokeStyle = '#e8e2cf'; c.lineWidth = 0.007;
    line(c, 0.185, 0.068, 0.208, 0.06); line(c, 0.305, 0.036, 0.33, 0.032);
    // голова: вытянутая морда вперёд, гребень, надбровья, глаза по бокам, ноздри; у барабела — рожки на затылке
    if (P.spikes) {
      c.fillStyle = P.ridge;
      for (var sp = -1; sp <= 1; sp++) { var sy = sp * 0.04; c.beginPath(); c.moveTo(-0.02, sy - 0.016); c.lineTo(-0.075 - (sp ? 0 : 0.012), sy * 1.6); c.lineTo(-0.02, sy + 0.016); c.closePath(); c.fill(); }
    }
    c.fillStyle = grad(c, 'lzH' + u.mark, function(x) { var g = x.createRadialGradient(0.04, -0.025, 0.01, 0.06, 0, 0.14); g.addColorStop(0, P.skin[1]); g.addColorStop(1, P.skin[0]); return g; });
    c.beginPath(); c.moveTo(-0.03, -0.062); c.quadraticCurveTo(0.06, -0.085, 0.14, -0.045); c.quadraticCurveTo(0.195, -0.018, 0.195, 0);
    c.quadraticCurveTo(0.195, 0.018, 0.14, 0.045); c.quadraticCurveTo(0.06, 0.085, -0.03, 0.062); c.quadraticCurveTo(-0.058, 0, -0.03, -0.062); c.closePath(); c.fill();
    c.strokeStyle = 'rgba(0,0,0,0.5)'; c.lineWidth = 0.01; c.stroke();
    // чешуя: мелкие пятна вдоль морды, гуще к затылку
    c.fillStyle = P.scale;
    for (var sx = -0.015; sx < 0.12; sx += 0.026) for (var sr = -1; sr <= 1; sr += 2) dot(c, sx, sr * (0.03 - sx * 0.08), 0.009 - sx * 0.03);
    c.strokeStyle = P.ridge; c.lineWidth = 0.014; line(c, -0.035, 0, 0.09, 0);
    c.lineWidth = 0.012; c.beginPath(); c.arc(0.075, -0.035, 0.026, -2.4, -0.4); c.stroke(); c.beginPath(); c.arc(0.075, 0.035, 0.026, 0.4, 2.4); c.stroke();
    for (var e = -1; e <= 1; e += 2) {
      c.fillStyle = P.eye; c.beginPath(); c.ellipse(0.085, e * 0.057, 0.019, 0.01, e * 0.3, 0, TAU); c.fill();
      c.fillStyle = '#120c04'; c.fillRect(0.083, e * 0.057 - 0.0035, 0.007, 0.007);
    }
    c.fillStyle = '#1a1208'; dot(c, 0.178, -0.012, 0.006); dot(c, 0.178, 0.012, 0.006);
    c.restore();
  }

  var DRAW = { clone: clone, b1: b1, b2: b2, bx: bx, officer: officer, droideng: droidEng, droidmed: droidMed, mando: mando, lizard: lizard };

  // Экипаж кораблей — не строевые бойцы (имена — как у юнитов игры)
  var CREW = [
    { id: 'rep_officer',   name: 'Клон-офицер',         draw: 'officer',  gun: 'none', rad: 0.32 },
    { id: 'rep_gunner',    name: 'Клон-артиллерист',    draw: 'clone',    gun: 'none', mark: '#7d858f', rad: 0.34 },
    { id: 'rep_engineer',  name: 'Клон-инженер',        draw: 'clone',    gun: 'tool', mark: '#d9a940', rad: 0.34 },
    { id: 'rep_medic',     name: 'Клон-медик',          draw: 'clone',    gun: 'kit',  mark: '#c0453a', rad: 0.34 },
    { id: 'cis_b1_cmd',    name: 'Командный дроид B1',  draw: 'b1',       gun: 'none', mark: '#d9a940', rad: 0.32 },
    { id: 'cis_b1_crew',   name: 'Дроид-пилот B1',      draw: 'b1',       gun: 'none', mark: '#3d74d6', rad: 0.32 },
    { id: 'cis_engineer',  name: 'Инженерный дроид',    draw: 'droideng', gun: 'none', rad: 0.34 },
    { id: 'cis_medic',     name: 'Дроид-техник',        draw: 'droidmed', gun: 'none', rad: 0.34 }
  ];

  // Тень под фигуркой
  function shadow(c, r) {
    var g = c.createRadialGradient(0.05, 0.07, 0, 0.05, 0.07, r * 1.25);
    g.addColorStop(0, 'rgba(0,0,0,0.55)'); g.addColorStop(0.55, 'rgba(0,0,0,0.3)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = g; dot(c, 0.05, 0.07, r * 1.25);
  }

  // Набор картинок: для каждого вида — DIRS поворотов × FRAMES кадров.
  // Кадр 0 — стойка, 1..4 — шаг. Клетка атласа — cell×cell пикселей.
  var DIRS = 16, FRAMES = 5;
  function bake(types, cell, cols) {
    // сетка 10 столбцов: атлас узкий и не упирается в пределы холста телефона
    var COLS = cols || 10, per = DIRS * FRAMES;
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
          var u = { aim: ang, legs: ang, mv: f === 0 ? 0 : 1, phase: f === 0 ? 0 : (f - 1) * (TAU / 4), gun: gun, mark: T.mark };
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
    var u = { aim: 0.5, legs: -0.4, mv: 0, phase: 0, gun: T.id === 'rep_sniper' ? 'sniper' : T.gun, mark: T.mark };
    DRAW[T.draw](c, u);
    c.restore();
  }

  // ---------------------------------------------------------------- гибель
  // Дроид разлетается на части (как на пробной палубе), клон падает навзничь.
  // k — ход анимации 0..1 (1 — лежит, как в атласе тел); seed — раскладка обломков.
  var WRECK = {
    b1:       { limb: '#b9a476', torso: '#d6c597', dark: '#6a5a3e', head: '#c9b689', big: false },
    bx:       { limb: '#4d4841', torso: '#746c61', dark: '#23201c', head: '#8a8277', big: false },
    b2:       { limb: '#56616d', torso: '#7f8b98', dark: '#2b3138', head: null, big: true },
    droideng: { limb: '#6f6a60', torso: '#9a9384', dark: '#3a3630', head: '#8a8477', big: false },
    droidmed: { limb: '#6f6a60', torso: '#a8a294', dark: '#3a3630', head: '#8a8477', big: false }
  };
  function isDroid(T) { return !!WRECK[T.draw]; }
  function srnd(seed) { var s = (seed * 2654435761) >>> 0 || 1; return function() { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
  function ease(k) { k = Math.max(0, Math.min(1, k)); return 1 - (1 - k) * (1 - k) * (1 - k); }
  // c сдвинут в точку гибели и масштабирован в клетки поля; ang — куда отбросило
  function dead(c, T, ang, k, seed) {
    var W0 = WRECK[T.draw], e = ease(k);
    c.save(); c.scale(FIG, FIG);
    if (!W0) {
      // клон: стоял — падает по направлению удара, тень расползается
      var sw = Math.min(1, k / 0.6);
      c.rotate(ang);
      c.fillStyle = 'rgba(10,8,6,' + (0.45 * sw) + ')';
      c.beginPath(); c.ellipse(0.02 + 0.1 * e, 0.02, 0.32 * (0.6 + 0.4 * e), 0.22, 0, 0, TAU); c.fill();
      c.translate(0.12 * e, 0);
      c.globalAlpha *= 0.6 + 0.4 * (1 - e);
      var u = { aim: 0.5 * e, legs: -0.4 * e, mv: 0, phase: 0, gun: T.id === 'rep_sniper' ? 'sniper' : T.gun, mark: T.mark };
      c.scale(1 + (1 - e) * 0.12, 1 + (1 - e) * 0.12);
      DRAW[T.draw](c, u);
      c.restore();
      return;
    }
    var R = srnd(seed + 7), big = W0.big;
    // подпалина под обломками
    var sg = c.createRadialGradient(0, 0, 0, 0, 0, big ? 0.55 : 0.42);
    sg.addColorStop(0, 'rgba(12,9,6,' + (0.7 * Math.min(1, k * 3)) + ')'); sg.addColorStop(1, 'rgba(12,9,6,0)');
    c.fillStyle = sg; dot(c, 0, 0, big ? 0.55 : 0.42);
    var parts = big ? [['torso', 0.12, 0.3], ['arm', 0.5, 1.4], ['arm', 0.32, 2], ['leg', 0.18, 2.5], ['leg', 0.22, 2.5]]
                    : [['torso', 0.14, 0.4], ['head', 0.5 + R() * 0.45, 0.7], ['arm', 0.35, 1.6], ['arm', 0.28, 2.2], ['leg', 0.2, 2.6], ['leg', 0.26, 2.6], ['gun', 0.35 + R() * 0.35, 1.8]];
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i], a = ang + (R() * 2 - 1) * p[2], dist = p[1], r0 = R() * TAU, spin = (R() * 2 - 1) * (p[0] === 'head' ? 6 : 3);
      var hop = p[0] === 'head' || p[0] === 'gun' ? Math.sin(Math.PI * Math.min(1, k)) * 0.35 : 0;
      c.save();
      c.translate(Math.cos(a) * dist * e, Math.sin(a) * dist * e - hop);
      c.rotate(r0 + spin * e);
      c.lineCap = 'round';
      if (p[0] === 'torso') {
        var tw = big ? 0.3 : 0.15, th = big ? 0.42 : 0.18;
        c.fillStyle = W0.torso; rr(c, -tw / 2, -th / 2, tw, th, big ? 0.06 : 0.035); c.fill();
        c.strokeStyle = W0.dark; c.lineWidth = 0.012; c.stroke();
        c.fillStyle = 'rgba(255,150,60,' + (0.6 * (1 - Math.min(1, k * 1.2))) + ')'; dot(c, 0, 0, big ? 0.07 : 0.035);
      } else if (p[0] === 'head') {
        c.fillStyle = W0.head || W0.torso; c.beginPath(); c.ellipse(0, 0, 0.075, 0.05, 0, 0, TAU); c.fill();
        c.strokeStyle = W0.dark; c.lineWidth = 0.01; c.stroke();
      } else if (p[0] === 'arm' || p[0] === 'leg') {
        var L = big ? (p[0] === 'arm' ? 0.26 : 0.2) : (p[0] === 'arm' ? 0.2 : 0.18);
        c.strokeStyle = W0.limb; c.lineWidth = big ? 0.085 : 0.042; line(c, -L / 2, 0, L / 2, 0);
        c.fillStyle = W0.dark; dot(c, L / 2, 0, big ? 0.045 : 0.022);
      } else {
        c.strokeStyle = '#2f3237'; c.lineWidth = 0.035; line(c, -0.16, 0, 0.16, 0);
      }
      c.restore();
    }
    // первые мгновения — ещё целый дроид, тает поверх обломков
    if (k < 0.22) {
      c.globalAlpha *= 1 - k / 0.22;
      shadow(c, T.rad);
      DRAW[T.draw](c, { aim: ang + Math.PI, legs: ang + Math.PI, mv: 0, phase: 0, gun: T.gun, mark: T.mark });
    }
    c.restore();
  }
  // Атлас тел: для каждого вида — DEAD_DIRS направлений, обломки разложены как в конце анимации
  var DEAD_DIRS = 8;
  function bakeDead(types, cell, cols) {
    var COLS = cols || 16, cv = document.createElement('canvas');
    cv.width = COLS * cell; cv.height = Math.ceil(types.length * DEAD_DIRS / COLS) * cell;
    var c = cv.getContext('2d'), sc = 2.6, k = cell / sc;    // клетка атласа — 2,6 клетки поля: обломки разлетаются
    for (var t = 0; t < types.length; t++) for (var d = 0; d < DEAD_DIRS; d++) {
      var idx = t * DEAD_DIRS + d;
      c.save();
      c.translate((idx % COLS) * cell + cell / 2, Math.floor(idx / COLS) * cell + cell / 2);
      c.scale(k, k);
      dead(c, types[t], d / DEAD_DIRS * TAU, 1, d);
      c.restore();
    }
    return { canvas: cv, cell: cell, dirs: DEAD_DIRS, cols: COLS, scale: sc };
  }

  // Нарисовать бойца прямо на экран, без атласа (запасной путь, если
  // браузер потерял содержимое картинки-атласа). c уже сдвинут в точку бойца
  // и масштабирован в клетки поля.
  function draw(c, T, u) {
    u.gun = T.id === 'rep_sniper' ? 'sniper' : T.gun; u.mark = T.mark;
    c.scale(FIG, FIG);
    shadow(c, T.rad);
    DRAW[T.draw](c, u);
  }

  // Есть ли в атласе картинка: центр первой фигурки должен быть непрозрачным
  function check(A) {
    try {
      var d = A.canvas.getContext('2d').getImageData(Math.floor(A.cell / 2), Math.floor(A.cell / 2), 1, 1).data;
      return d[3] > 0;
    } catch (e) { return false; }
  }

  // Наёмники бара — строевые бойцы игры, но не из демо-палубы (их фигурки — только здесь)
  var BAR = [
    { id: 'cis_bounty', name: 'Охотник за головами',     draw: 'mando',  gun: 'pistols', mark: 'boba',    rad: 0.35 },
    { id: 'rep_mando',  name: 'Мандалорец-наставник',    draw: 'mando',  gun: 'pistols', mark: 'jango',   rad: 0.35 },
    { id: 'cis_hunter', name: 'Трандошанский следопыт',  draw: 'lizard', gun: 'scatter', mark: 'trando',  rad: 0.37 },
    { id: 'rep_hunter', name: 'Барабельский ловчий',     draw: 'lizard', gun: 'scatter', mark: 'barabel', rad: 0.37 }
  ];

  // Все виды для отрисовки кораблей: бойцы боя + экипаж + наёмники бара (порядок — номера фигурок
  // на сервере и у игроков: добавлять только в конец); и кто где служит
  function withCrew(types) { return types.concat(CREW, BAR); }
  function crewFigs(faction, all) {
    var at = function(ids) { return ids.map(function(id) { for (var i = 0; i < all.length; i++) if (all[i].id === id) return i; return 0; }); };
    return faction === 'cis'
      ? { bridge: at(['cis_b1_cmd']), post: at(['cis_b1_crew']), eng: at(['cis_engineer']), medic: at(['cis_medic']),
          troops: at(['cis_b1', 'cis_b1', 'cis_b2']), crew: at(['cis_b1_crew']) }
      : { bridge: at(['rep_officer']), post: at(['rep_gunner']), eng: at(['rep_engineer']), medic: at(['rep_medic']),
          troops: at(['rep_dc15a', 'rep_dc15a', 'rep_heavy']), crew: at(['rep_gunner', 'rep_engineer']) };
  }

  root.SWRTFig = { withCrew: withCrew, crewFigs: crewFigs, bake: bake, corpse: corpse, draw: draw, check: check, DIRS: DIRS, FRAMES: FRAMES, FIG: FIG, TAU: TAU, CREW: CREW,
                   dead: dead, bakeDead: bakeDead, isDroid: isDroid, DEAD_DIRS: DEAD_DIRS };
})(typeof self !== 'undefined' ? self : this);
