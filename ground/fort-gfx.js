// Полевые постройки инженера сверху — рисуются кодом, как техника (shared/rt-vehicles.js).
//
// Единица — клетка поля, центр постройки — (0, 0), место w×h клеток. Свет — с северо-запада,
// тень ложится на юго-восток. У каждой фракции свой материал: Республика — светлый
// ферробетон и белая броня с красной разметкой, Конфедерация — песочный дюрасталь дроидных
// заводов с тёмными стыками; огни — цвета стороны (синие / красные).
//
// Постройка — две части:
//   base — всё неподвижное (запекается в картинку и кэшируется по размеру);
//   top  — живое поверх: голова турели по углу u.aim и вспышка выстрела u.fire,
//          тарелка радара, волны глушилки, мерцание маскировки, бур добытчика, вывеска кантины.
// u: { team, w, h, res — сырьё добытчика, aim — угол головы, fire — 0..1 сразу после выстрела,
//      t — время, с; hp — 0..1, dead }
//
// SWForts.draw(c, kind, u, part) — нарисовать; SWForts.icon(id, px) — картинка для панелей
// (id — тип постройки из базы, например rep_turret или cis_mine_gas). Только браузер, ES5.

(function(root) {
  'use strict';

  var TAU = Math.PI * 2;
  var LX = -0.6, LY = -0.72;                       // свет (мировой), как у местности и техники

  // ---------------------------------------------------------------- цвета
  function rgb(h) { var v = parseInt(h.slice(1), 16); return [(v >> 16) & 255, (v >> 8) & 255, v & 255]; }
  function k(h, f, a) {
    var c = rgb(h), r = Math.min(255, Math.round(c[0] * f)), g = Math.min(255, Math.round(c[1] * f)), b = Math.min(255, Math.round(c[2] * f));
    return a == null ? 'rgb(' + r + ',' + g + ',' + b + ')' : 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
  }
  var PAL = [
    // Республика: ферробетон, белая броня, красная разметка клонов, синие огни
    { wall: '#c3c7c9', plate: '#dfe3e6', mid: '#aab1b8', dark: '#6d757d', line: '#3f464d', mark: '#a8323a', light: '#6fb8ff', bag: '#b7a47c', glass: '#5d86b3' },
    // Конфедерация: песочный дюрасталь, тёмные стыки, синяя эмблема, красные огни
    { wall: '#b49a72', plate: '#cdb48a', mid: '#9c8160', dark: '#5e4a32', line: '#33271a', mark: '#3c5f93', light: '#ff5a48', bag: '#8d8a84', glass: '#7a3a34' },
    // мародёры и прочие: ржавое железо, жёлтые огни
    { wall: '#8d8478', plate: '#a49a8c', mid: '#7a7166', dark: '#4c463f', line: '#2a2622', mark: '#8a5a2a', light: '#ffd06a', bag: '#9a8a6a', glass: '#6a6040' }
  ];
  var RES = { ore: '#b08968', gas: '#4ad9c8', food: '#5fd968', crystals: '#a34ad9', crystal: '#a34ad9' };   // тип в базе — mine_crystal
  function pal(team) { return PAL[team === 1 ? 1 : team === 0 ? 0 : 2]; }

  // ---------------------------------------------------------------- приёмы
  function lit(c, x, y, r, hex, hi, lo) {
    var g = c.createLinearGradient(x + LX * r, y + LY * r, x - LX * r, y - LY * r);
    g.addColorStop(0, k(hex, hi)); g.addColorStop(1, k(hex, lo));
    return g;
  }
  function dome(c, x, y, r, hex, hi, lo) {
    var g = c.createRadialGradient(x + LX * r * 0.42, y + LY * r * 0.42, r * 0.05, x, y, r * 1.05);
    g.addColorStop(0, k(hex, hi)); g.addColorStop(1, k(hex, lo));
    return g;
  }
  // свет в повёрнутой системе (голова турели, тарелка): градиент должен остаться с северо-запада
  function litR(c, ang, x, y, r, hex, hi, lo) {
    var cs = Math.cos(-ang), sn = Math.sin(-ang), lx = LX * cs - LY * sn, ly = LX * sn + LY * cs;
    var g = c.createLinearGradient(x + lx * r, y + ly * r, x - lx * r, y - ly * r);
    g.addColorStop(0, k(hex, hi)); g.addColorStop(1, k(hex, lo));
    return g;
  }
  function rr(c, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    c.beginPath();
    c.moveTo(x + r, y); c.lineTo(x + w - r, y); c.quadraticCurveTo(x + w, y, x + w, y + r);
    c.lineTo(x + w, y + h - r); c.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    c.lineTo(x + r, y + h); c.quadraticCurveTo(x, y + h, x, y + h - r);
    c.lineTo(x, y + r); c.quadraticCurveTo(x, y, x + r, y); c.closePath();
  }
  function ngon(c, x, y, r, n, rot) {
    c.beginPath();
    for (var i = 0; i < n; i++) { var a = rot + i / n * TAU, px = x + Math.cos(a) * r, py = y + Math.sin(a) * r; if (i) c.lineTo(px, py); else c.moveTo(px, py); }
    c.closePath();
  }
  function poly(c, pts) { c.beginPath(); for (var i = 0; i < pts.length; i++) { if (i) c.lineTo(pts[i][0], pts[i][1]); else c.moveTo(pts[i][0], pts[i][1]); } c.closePath(); }
  function dot(c, x, y, r) { c.beginPath(); c.arc(x, y, r, 0, TAU); c.fill(); }
  function line(c, x0, y0, x1, y1, w, col) { c.strokeStyle = col; c.lineWidth = w; c.beginPath(); c.moveTo(x0, y0); c.lineTo(x1, y1); c.stroke(); }
  function edge(c, col, w) { c.strokeStyle = col; c.lineWidth = w || 0.02; c.lineJoin = 'round'; c.stroke(); }
  function seam(c, x0, y0, x1, y1, w) {
    line(c, x0, y0, x1, y1, w || 0.018, 'rgba(0,0,0,0.38)');
    line(c, x0 + 0.012, y0 + 0.014, x1 + 0.012, y1 + 0.014, (w || 0.018) * 0.7, 'rgba(255,255,255,0.2)');
  }
  function bolts(c, pts, r) { c.fillStyle = 'rgba(0,0,0,0.38)'; for (var i = 0; i < pts.length; i++) dot(c, pts[i][0], pts[i][1], r || 0.018); }
  // тень постройки: та же фигура со сдвигом на юго-восток
  function shadow(c, h, fn) {
    c.save(); c.translate(0.07 * h, 0.09 * h); c.fillStyle = 'rgba(0,0,0,0.38)'; fn(); c.fill(); c.restore();
  }
  // огонёк: ядро и ореол
  function glow(c, x, y, r, hex, a) {
    a = a == null ? 1 : a;
    var g = c.createRadialGradient(x, y, 0, x, y, r * 3);
    g.addColorStop(0, k(hex, 1.2, 0.55 * a)); g.addColorStop(1, k(hex, 1, 0));
    c.fillStyle = g; dot(c, x, y, r * 3);
    c.fillStyle = k(hex, 1.35, a); dot(c, x, y, r);
  }
  // псевдослучай по зерну — одна и та же постройка всегда выглядит одинаково
  function rnd(seed) { var x = Math.sin(seed * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); }

  // ---------------------------------------------------------------- окоп
  // Яма в земле; у Республики — кольцо мешков с песком, у дроидов — сварные щиты из дюрастали
  function trench(c, u) {
    var P = pal(u.team), hw = u.w / 2, hh = u.h / 2, ins = 0.06;
    var x0 = -hw + ins, y0 = -hh + ins, W = u.w - ins * 2, H = u.h - ins * 2, R = Math.min(W, H) * 0.42;
    // яма
    var g = c.createRadialGradient(-0.05, -0.06, 0, 0, 0, Math.max(W, H) * 0.6);
    g.addColorStop(0, '#2a2017'); g.addColorStop(0.65, '#3b2e20'); g.addColorStop(1, '#5a4631');
    c.fillStyle = g; rr(c, x0, y0, W, H, R); c.fill();
    c.fillStyle = 'rgba(0,0,0,0.25)'; rr(c, x0 + 0.08, y0 + 0.08, W - 0.16, H - 0.16, R * 0.7); c.fill();
    // бруствер по кругу
    var per = 2 * (W + H), n = Math.max(10, Math.round(per / 0.17)), pts = [];
    for (var i = 0; i < n; i++) {
      var d = i / n * per, px, py, ang;
      if (d < W) { px = x0 + d; py = y0; ang = 0; }
      else if (d < W + H) { px = x0 + W; py = y0 + d - W; ang = Math.PI / 2; }
      else if (d < 2 * W + H) { px = x0 + W - (d - W - H); py = y0 + H; ang = 0; }
      else { px = x0; py = y0 + H - (d - 2 * W - H); ang = Math.PI / 2; }
      // углы скругляем: точка тянется к центру
      var cx = Math.max(x0 + R, Math.min(x0 + W - R, px)), cy = Math.max(y0 + R, Math.min(y0 + H - R, py)), dx = px - cx, dy = py - cy, L = Math.sqrt(dx * dx + dy * dy);
      if (L > R) { px = cx + dx / L * R; py = cy + dy / L * R; ang = Math.atan2(dy, dx) + Math.PI / 2; }
      pts.push([px, py, ang]);
    }
    if (u.team === 1) {
      // сварные щиты дроидов: наклонные пластины с заклёпками
      for (i = 0; i < pts.length; i += 2) {
        var q = pts[i];
        c.save(); c.translate(q[0], q[1]); c.rotate(q[2]);
        c.fillStyle = 'rgba(0,0,0,0.4)'; c.fillRect(-0.15, -0.04, 0.32, 0.13);
        c.fillStyle = lit(c, 0, 0, 0.16, P.plate, 1.15, 0.62); poly(c, [[-0.17, -0.07], [0.17, -0.07], [0.14, 0.07], [-0.14, 0.07]]); c.fill(); edge(c, k(P.line, 1, 0.7), 0.014);
        line(c, -0.14, -0.035, 0.14, -0.035, 0.012, 'rgba(255,255,255,0.28)');
        bolts(c, [[-0.11, 0.02], [0.11, 0.02]], 0.014);
        c.restore();
      }
    } else {
      // мешки с песком, два ряда вразбежку
      for (var row = 0; row < 2; row++) for (i = row; i < pts.length; i += 1) {
        if ((i + row) % 2) continue;
        var b = pts[i], j = rnd(i * 3.7 + row) * 0.04;
        c.save(); c.translate(b[0] * (1 - row * 0.05), b[1] * (1 - row * 0.05)); c.rotate(b[2] + (rnd(i) - 0.5) * 0.3);
        c.fillStyle = 'rgba(0,0,0,0.35)'; c.beginPath(); c.ellipse(0.025, 0.035, 0.15, 0.09, 0, 0, TAU); c.fill();
        c.fillStyle = dome(c, 0, 0, 0.15, P.bag, row ? 1.5 : 1.4, 0.7 + j); c.beginPath(); c.ellipse(0, 0, 0.15, 0.09, 0, 0, TAU); c.fill();
        edge(c, 'rgba(60,45,25,0.55)', 0.012);
        line(c, -0.06, -0.07, -0.06, 0.07, 0.012, 'rgba(60,45,25,0.4)');
        c.restore();
      }
    }
  }

  // ---------------------------------------------------------------- бункер
  // Республика — восьмигранный дот из ферробетона: бойницы на четыре стороны, люк, красная полоса.
  // Конфедерация — приплюснутый купол дюрасталевых сегментов с красным глазом сенсора.
  function bunker(c, u) {
    var P = pal(u.team), R = Math.min(u.w, u.h) / 2 * 0.96;
    if (u.team === 1) {
      shadow(c, 1.4, function() { ngon(c, 0, 0, R, 12, 0); });
      c.fillStyle = dome(c, 0, 0, R, P.wall, 1.22, 0.55); ngon(c, 0, 0, R, 12, 0); c.fill(); edge(c, k(P.line, 1, 0.8), 0.025);
      // сегменты брони
      for (var i = 0; i < 12; i++) { var a = i / 12 * TAU; seam(c, Math.cos(a) * R * 0.42, Math.sin(a) * R * 0.42, Math.cos(a) * R * 0.97, Math.sin(a) * R * 0.97, 0.016); }
      // бойницы: тёмные щели по кругу
      for (i = 0; i < 6; i++) {
        var b = i / 6 * TAU + Math.PI / 6;
        c.save(); c.rotate(b);
        c.fillStyle = '#16120d'; rr(c, R * 0.72, -0.13, R * 0.2, 0.26, 0.05); c.fill();
        c.fillStyle = 'rgba(255,255,255,0.12)'; c.fillRect(R * 0.72, -0.13, R * 0.2, 0.025);
        c.restore();
      }
      // верхний купол и сенсор
      c.fillStyle = dome(c, 0, 0, R * 0.42, P.plate, 1.3, 0.62); dot(c, 0, 0, R * 0.42); edge(c, k(P.line, 1, 0.6), 0.02);
      c.strokeStyle = k(P.mark, 1, 0.9); c.lineWidth = 0.05; c.beginPath(); c.arc(0, 0, R * 0.3, 0, TAU); c.stroke();
      c.fillStyle = '#1b1210'; dot(c, 0, 0, R * 0.14);
    } else {
      shadow(c, 1.4, function() { ngon(c, 0, 0, R, 8, Math.PI / 8); });
      // стены
      c.fillStyle = lit(c, 0, 0, R, P.wall, 1.18, 0.6); ngon(c, 0, 0, R, 8, Math.PI / 8); c.fill(); edge(c, k(P.line, 1, 0.75), 0.025);
      // бойницы в каждой стороне света
      for (var s = 0; s < 4; s++) {
        c.save(); c.rotate(s * Math.PI / 2);
        c.fillStyle = '#121416'; c.fillRect(R * 0.8, -0.2, R * 0.14, 0.4);
        c.fillStyle = 'rgba(255,255,255,0.15)'; c.fillRect(R * 0.8, -0.2, R * 0.14, 0.03);
        c.restore();
      }
      // крыша: плита пониже, швы опалубки
      var r2 = R * 0.74;
      c.fillStyle = lit(c, 0, 0, r2, P.mid, 1.22, 0.7); ngon(c, 0, 0, r2, 8, Math.PI / 8); c.fill(); edge(c, 'rgba(0,0,0,0.3)', 0.02);
      seam(c, -r2 * 0.92, -r2 * 0.25, r2 * 0.92, -r2 * 0.25); seam(c, -r2 * 0.92, r2 * 0.25, r2 * 0.92, r2 * 0.25);
      // красная полоса Республики по кромке
      c.save(); ngon(c, 0, 0, r2, 8, Math.PI / 8); c.clip();
      c.fillStyle = k(P.mark, 1, 0.92); c.fillRect(-r2, -r2, r2 * 2, r2 * 0.16);
      c.restore();
      // люк
      c.fillStyle = dome(c, r2 * 0.32, r2 * 0.36, 0.2, P.plate, 1.25, 0.6); dot(c, r2 * 0.32, r2 * 0.36, 0.2); edge(c, k(P.line, 1, 0.7), 0.016);
      line(c, r2 * 0.32 - 0.12, r2 * 0.36, r2 * 0.32 + 0.12, r2 * 0.36, 0.022, 'rgba(0,0,0,0.4)');
      bolts(c, [[-r2 * 0.6, -r2 * 0.5], [r2 * 0.6, -r2 * 0.5], [-r2 * 0.6, r2 * 0.55], [r2 * 0.6, r2 * 0.55]], 0.022);
      // антенна
      line(c, -r2 * 0.45, r2 * 0.15, -r2 * 0.45, -r2 * 0.05, 0.02, k(P.line, 1));
    }
  }
  function bunkerTop(c, u) {
    var P = pal(u.team), R = Math.min(u.w, u.h) / 2 * 0.96, t = u.t || 0;
    if (u.team === 1) glow(c, 0, 0, R * 0.08, P.light, 0.65 + 0.35 * Math.sin(t * 2.2));
    else glow(c, -R * 0.45, -R * 0.08, 0.035, P.light, 0.5 + 0.5 * (Math.sin(t * 3) > 0 ? 1 : 0.3));
  }

  // ---------------------------------------------------------------- турель
  // Тумба на месте, голова поворачивается за целью: у Республики — сдвоенный бластер в белой
  // броне с красной полосой, у дроидов — сплюснутая голова с тремя стволами и глазом.
  function turretBase(c, u, sc) {
    var P = pal(u.team), r = 0.44 * sc;
    shadow(c, 1.1 * sc, function() { ngon(c, 0, 0, r, 8, Math.PI / 8); });
    c.fillStyle = lit(c, 0, 0, r, P.wall, 1.2, 0.58); ngon(c, 0, 0, r, 8, Math.PI / 8); c.fill(); edge(c, k(P.line, 1, 0.8), 0.022 * sc);
    // упоры
    for (var i = 0; i < 4; i++) {
      var a = Math.PI / 4 + i * Math.PI / 2;
      c.fillStyle = k(P.dark, 1); c.save(); c.rotate(a); c.fillRect(r * 0.62, -0.05 * sc, r * 0.42, 0.1 * sc); c.restore();
    }
    // погон
    c.fillStyle = '#23272b'; dot(c, 0, 0, r * 0.74);
    c.strokeStyle = 'rgba(255,255,255,0.14)'; c.lineWidth = 0.02 * sc; c.beginPath(); c.arc(0, 0, r * 0.74, Math.PI, Math.PI * 1.6); c.stroke();
    bolts(c, [[r * 0.8, 0], [-r * 0.8, 0], [0, r * 0.8], [0, -r * 0.8]], 0.022 * sc);
  }
  function turretHead(c, u, sc) {
    var P = pal(u.team), a = u.aim || 0, f = u.fire || 0, rec = f * 0.06 * sc, t = u.t || 0;
    c.save(); c.rotate(a);
    // тень головы на тумбе
    c.fillStyle = 'rgba(0,0,0,0.3)'; c.save(); c.rotate(-a); c.translate(0.04 * sc, 0.05 * sc); c.rotate(a); rr(c, -0.24 * sc, -0.2 * sc, 0.46 * sc, 0.4 * sc, 0.1 * sc); c.fill(); c.restore();
    var bl = 0.5 * sc;
    if (u.team === 1) {
      // три ствола
      for (var i = -1; i <= 1; i++) {
        var y = i * 0.085 * sc;
        line(c, 0.1 * sc - rec, y, 0.1 * sc + bl - rec, y, 0.055 * sc, '#2b2622');
        line(c, 0.1 * sc - rec, y - 0.012 * sc, 0.1 * sc + bl - rec, y - 0.012 * sc, 0.018 * sc, 'rgba(255,255,255,0.18)');
      }
      c.fillStyle = litR(c, a, 0, 0, 0.26 * sc, P.plate, 1.25, 0.6);
      poly(c, [[-0.24 * sc, -0.2 * sc], [0.12 * sc, -0.24 * sc], [0.24 * sc, -0.08 * sc], [0.24 * sc, 0.08 * sc], [0.12 * sc, 0.24 * sc], [-0.24 * sc, 0.2 * sc]]); c.fill(); edge(c, k(P.line, 1, 0.85), 0.02 * sc);
      seam(c, -0.08 * sc, -0.2 * sc, -0.08 * sc, 0.2 * sc, 0.014 * sc);
      c.fillStyle = k(P.mark, 1, 0.9); c.fillRect(-0.22 * sc, -0.05 * sc, 0.12 * sc, 0.1 * sc);
      glow(c, 0.13 * sc, 0, 0.04 * sc, P.light, 0.8 + 0.2 * Math.sin(t * 5));
    } else {
      // сдвоенный бластер
      for (var j = -1; j <= 1; j += 2) {
        var yy = j * 0.09 * sc;
        line(c, 0.12 * sc - rec, yy, 0.12 * sc + bl - rec, yy, 0.07 * sc, '#3a4148');
        line(c, 0.12 * sc - rec, yy - 0.016 * sc, 0.12 * sc + bl - rec, yy - 0.016 * sc, 0.022 * sc, 'rgba(255,255,255,0.25)');
        c.fillStyle = '#16191c'; dot(c, 0.12 * sc + bl - rec, yy, 0.03 * sc);
        // кожух у казённика
        c.fillStyle = '#4a5259'; c.fillRect(0.14 * sc - rec, yy - 0.05 * sc, 0.14 * sc, 0.1 * sc);
      }
      c.fillStyle = litR(c, a, 0, 0, 0.26 * sc, P.plate, 1.18, 0.66);
      rr(c, -0.25 * sc, -0.21 * sc, 0.44 * sc, 0.42 * sc, 0.12 * sc); c.fill(); edge(c, k(P.line, 1, 0.8), 0.02 * sc);
      c.fillStyle = k(P.mark, 1, 0.95); c.fillRect(-0.25 * sc + 0.04 * sc, -0.21 * sc, 0.06 * sc, 0.42 * sc);
      c.fillStyle = '#1e2a38'; rr(c, 0.06 * sc, -0.12 * sc, 0.1 * sc, 0.24 * sc, 0.03 * sc); c.fill();
      c.fillStyle = 'rgba(160,210,255,0.45)'; c.fillRect(0.08 * sc, -0.1 * sc, 0.03 * sc, 0.12 * sc);
      glow(c, -0.12 * sc, 0.1 * sc, 0.025 * sc, P.light, 0.55 + 0.45 * Math.sin(t * 2));
    }
    // вспышка у дульного среза
    if (f > 0) {
      var mx = 0.12 * sc + bl + 0.04 * sc - rec, g = c.createRadialGradient(mx, 0, 0, mx, 0, 0.32 * sc);
      g.addColorStop(0, 'rgba(255,245,210,' + f + ')'); g.addColorStop(0.35, 'rgba(255,190,90,' + 0.8 * f + ')'); g.addColorStop(1, 'rgba(255,140,40,0)');
      c.fillStyle = g; dot(c, mx, 0, 0.32 * sc);
    }
    c.restore();
  }

  // ---------------------------------------------------------------- глушилка
  // Площадка с четырьмя мачтами и излучателем посередине; живое — волны помех и огни на мачтах
  function jammer(c, u) {
    var P = pal(u.team), hw = u.w / 2 - 0.12, hh = u.h / 2 - 0.12;
    shadow(c, 1, function() { rr(c, -hw, -hh, hw * 2, hh * 2, 0.22); });
    c.fillStyle = lit(c, 0, 0, hw, P.mid, 1.18, 0.62); rr(c, -hw, -hh, hw * 2, hh * 2, 0.22); c.fill(); edge(c, k(P.line, 1, 0.75), 0.024);
    // решётчатый настил
    c.save(); rr(c, -hw, -hh, hw * 2, hh * 2, 0.22); c.clip();
    for (var x = -hw; x < hw; x += 0.16) line(c, x, -hh, x + hh * 2, hh, 0.012, 'rgba(0,0,0,0.16)');
    c.restore();
    // кабели к центру
    var m = [[-hw * 0.78, -hh * 0.78], [hw * 0.78, -hh * 0.78], [hw * 0.78, hh * 0.78], [-hw * 0.78, hh * 0.78]];
    for (var i = 0; i < 4; i++) line(c, m[i][0], m[i][1], 0, 0, 0.035, 'rgba(20,20,22,0.65)');
    // мачты: тень-растяжка и шар излучателя
    for (i = 0; i < 4; i++) {
      c.fillStyle = 'rgba(0,0,0,0.3)'; dot(c, m[i][0] + 0.05, m[i][1] + 0.07, 0.11);
      c.fillStyle = dome(c, m[i][0], m[i][1], 0.11, P.plate, 1.3, 0.55); dot(c, m[i][0], m[i][1], 0.11); edge(c, k(P.line, 1, 0.6), 0.016);
    }
    // излучатель
    if (u.team === 1) {
      // шпиль дроидов: ступенчатые кольца
      for (var r = 0.46; r > 0.08; r -= 0.1) { c.fillStyle = dome(c, 0, 0, r, P.plate, 1.25 - r * 0.4, 0.55); dot(c, 0, 0, r); edge(c, 'rgba(0,0,0,0.25)', 0.012); }
    } else {
      // три тарелки на треноге
      c.fillStyle = k(P.dark, 1); dot(c, 0, 0, 0.18);
      for (i = 0; i < 3; i++) {
        var a = -Math.PI / 2 + i / 3 * TAU, px = Math.cos(a) * 0.3, py = Math.sin(a) * 0.3;
        line(c, 0, 0, px, py, 0.05, k(P.line, 1));
        c.fillStyle = dome(c, px, py, 0.17, P.plate, 1.35, 0.6); dot(c, px, py, 0.17); edge(c, k(P.line, 1, 0.6), 0.016);
        c.fillStyle = 'rgba(0,0,0,0.35)'; dot(c, px, py, 0.04);
      }
    }
  }
  function jammerTop(c, u) {
    var P = pal(u.team), t = u.t || 0, hw = u.w / 2 - 0.12, hh = u.h / 2 - 0.12;
    // волны помех расходятся от излучателя
    for (var i = 0; i < 3; i++) {
      var ph = ((t * 0.55 + i / 3) % 1), r = 0.25 + ph * Math.max(u.w, u.h) * 0.75;
      c.strokeStyle = k(P.light, 1, 0.42 * (1 - ph)); c.lineWidth = 0.04 * (1 - ph * 0.6);
      c.setLineDash([0.12, 0.08]); c.beginPath(); c.arc(0, 0, r, t * 0.6 + i, t * 0.6 + i + TAU * 0.85); c.stroke();
    }
    c.setLineDash([]);
    var m = [[-hw * 0.78, -hh * 0.78], [hw * 0.78, -hh * 0.78], [hw * 0.78, hh * 0.78], [-hw * 0.78, hh * 0.78]];
    for (i = 0; i < 4; i++) { var on = Math.sin(t * 4 + i * 1.6) > 0.2; glow(c, m[i][0], m[i][1], 0.035, P.light, on ? 0.95 : 0.25); }
    glow(c, 0, 0, 0.06, P.light, 0.55 + 0.45 * Math.sin(t * 6));
  }

  // ---------------------------------------------------------------- маскировка
  // Республика — маскировочная сеть на четырёх стойках с голоэмиттерами;
  // Конфедерация — голопроектор: прозрачный купол со строками развёртки.
  function camo(c, u) {
    var P = pal(u.team), hw = u.w / 2 - 0.08, hh = u.h / 2 - 0.08;
    var posts = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]];
    if (u.team === 1) {
      c.fillStyle = 'rgba(0,0,0,0.28)'; c.beginPath(); c.ellipse(0.05, 0.06, hw * 0.95, hh * 0.95, 0, 0, TAU); c.fill();
      c.fillStyle = dome(c, 0, 0, 0.14, P.plate, 1.25, 0.55); dot(c, 0, 0, 0.14); edge(c, k(P.line, 1, 0.7), 0.016);
      c.fillStyle = '#1a2a3a'; dot(c, 0, 0, 0.06);
      return;
    }
    // сеть: лоскуты пятнами
    c.save(); rr(c, -hw, -hh, hw * 2, hh * 2, 0.12); c.clip();
    c.fillStyle = 'rgba(78,92,52,0.78)'; c.fillRect(-hw, -hh, hw * 2, hh * 2);
    var cols = ['rgba(54,66,36,0.85)', 'rgba(104,98,62,0.8)', 'rgba(40,48,30,0.8)'];
    for (var i = 0; i < 14; i++) {
      c.fillStyle = cols[i % 3]; c.beginPath();
      c.ellipse(-hw + rnd(i * 2.1) * hw * 2, -hh + rnd(i * 3.3 + 1) * hh * 2, 0.08 + rnd(i) * 0.12, 0.05 + rnd(i + 9) * 0.08, rnd(i + 4) * 3, 0, TAU); c.fill();
    }
    for (var x = -hw; x <= hw; x += 0.11) line(c, x, -hh, x + 0.2, hh, 0.008, 'rgba(20,24,14,0.5)');
    for (x = -hw; x <= hw + 0.2; x += 0.11) line(c, x, -hh, x - 0.2, hh, 0.008, 'rgba(20,24,14,0.5)');
    c.restore();
    for (i = 0; i < 4; i++) { c.fillStyle = '#2a2d2f'; dot(c, posts[i][0], posts[i][1], 0.06); }
  }
  function camoTop(c, u) {
    var P = pal(u.team), t = u.t || 0, hw = u.w / 2 - 0.08, hh = u.h / 2 - 0.08;
    if (u.team === 1) {
      // голокупол: прозрачная полусфера, строки развёртки бегут вниз, края мерцают
      var R = Math.min(hw, hh) * 1.02;
      var g = c.createRadialGradient(-R * 0.3, -R * 0.35, 0, 0, 0, R);
      g.addColorStop(0, 'rgba(150,220,255,0.06)'); g.addColorStop(0.8, 'rgba(110,190,255,0.14)'); g.addColorStop(1, 'rgba(140,210,255,0.32)');
      c.fillStyle = g; dot(c, 0, 0, R);
      c.save(); c.beginPath(); c.arc(0, 0, R, 0, TAU); c.clip();
      for (var y = -R; y < R; y += 0.07) { var ph = ((y + R) / (2 * R) + t * 0.35) % 1; c.fillStyle = 'rgba(150,215,255,' + (0.05 + 0.1 * Math.max(0, Math.sin(ph * TAU))) + ')'; c.fillRect(-R, y, R * 2, 0.022); }
      c.restore();
      c.strokeStyle = 'rgba(150,215,255,' + (0.35 + 0.2 * Math.sin(t * 3)) + ')'; c.lineWidth = 0.025; c.beginPath(); c.arc(0, 0, R, 0, TAU); c.stroke();
      return;
    }
    // голоэмиттеры на стойках и бегущая полоса мерцания по сети
    var posts = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]];
    c.save(); rr(c, -hw, -hh, hw * 2, hh * 2, 0.12); c.clip();
    var sx = -hw - 0.4 + ((t * 0.4) % 1) * (hw * 2 + 0.8), gg = c.createLinearGradient(sx - 0.25, 0, sx + 0.25, 0);
    gg.addColorStop(0, 'rgba(150,220,255,0)'); gg.addColorStop(0.5, 'rgba(170,230,255,0.22)'); gg.addColorStop(1, 'rgba(150,220,255,0)');
    c.fillStyle = gg; c.fillRect(-hw, -hh, hw * 2, hh * 2);
    c.restore();
    for (var i = 0; i < 4; i++) glow(c, posts[i][0], posts[i][1], 0.025, P.light, 0.5 + 0.5 * Math.sin(t * 3 + i));
  }

  // ---------------------------------------------------------------- радар
  function radar(c, u) {
    var P = pal(u.team), R = Math.min(u.w, u.h) / 2 * 0.92;
    shadow(c, 1, function() { c.beginPath(); c.arc(0, 0, R, 0, TAU); });
    c.fillStyle = dome(c, 0, 0, R, P.wall, 1.15, 0.58); dot(c, 0, 0, R); edge(c, k(P.line, 1, 0.75), 0.024);
    // разметка площадки
    c.strokeStyle = 'rgba(0,0,0,0.25)'; c.lineWidth = 0.02; c.beginPath(); c.arc(0, 0, R * 0.78, 0, TAU); c.stroke();
    c.strokeStyle = k(P.mark, 1, 0.7); c.lineWidth = 0.05;
    for (var i = 0; i < 8; i++) { var a = i / 8 * TAU; c.beginPath(); c.arc(0, 0, R * 0.88, a, a + 0.28); c.stroke(); }
    // будка с аппаратурой
    c.fillStyle = lit(c, R * 0.45, R * 0.45, 0.3, P.plate, 1.25, 0.6); rr(c, R * 0.22, R * 0.28, 0.42, 0.32, 0.05); c.fill(); edge(c, k(P.line, 1, 0.7), 0.016);
    c.fillStyle = '#1d2a36'; c.fillRect(R * 0.22 + 0.06, R * 0.28 + 0.06, 0.12, 0.06);
    // мачта
    c.fillStyle = '#2a2e32'; dot(c, 0, 0, 0.13);
  }
  function radarTop(c, u) {
    var P = pal(u.team), t = u.t || 0, R = Math.min(u.w, u.h) / 2 * 0.92, a = t * 0.9;
    // луч обзора
    var g = c.createRadialGradient(0, 0, 0, 0, 0, R * 1.25);
    g.addColorStop(0, k(P.light, 1, 0.22)); g.addColorStop(1, k(P.light, 1, 0));
    c.fillStyle = g; c.beginPath(); c.moveTo(0, 0); c.arc(0, 0, R * 1.25, a - 0.5, a); c.closePath(); c.fill();
    // тарелка
    c.save(); c.rotate(a);
    c.fillStyle = 'rgba(0,0,0,0.3)'; c.beginPath(); c.ellipse(0.06, 0.07, 0.2, R * 0.78, 0, 0, TAU); c.fill();
    c.fillStyle = litR(c, a, 0, 0, R * 0.7, P.plate, 1.3, 0.55); c.beginPath(); c.ellipse(0, 0, 0.2, R * 0.78, 0, 0, TAU); c.fill(); edge(c, k(P.line, 1, 0.75), 0.02);
    for (var y = -R * 0.6; y <= R * 0.61; y += R * 0.3) line(c, -0.16, y, 0.16, y, 0.012, 'rgba(0,0,0,0.25)');
    line(c, 0.02, 0, 0.42, 0, 0.035, k(P.line, 1));
    c.fillStyle = k(P.dark, 1); dot(c, 0.44, 0, 0.05);
    c.restore();
    glow(c, 0, 0, 0.04, P.light, 0.6 + 0.4 * Math.sin(t * 4));
  }

  // ---------------------------------------------------------------- добытчик
  // Рама площадки общая; посередине — то, что добывают: руда (буровая вышка и отвал), газ (баки и
  // насос), еда (гидропонная теплица), кристаллы (друза между тремя пилонами).
  function extractor(c, u) {
    var P = pal(u.team), hw = u.w / 2 - 0.1, hh = u.h / 2 - 0.1, res = RES[u.res] ? u.res : 'ore', rc = RES[res];
    shadow(c, 1, function() { rr(c, -hw, -hh, hw * 2, hh * 2, 0.16); });
    c.fillStyle = lit(c, 0, 0, hw, P.mid, 1.12, 0.6); rr(c, -hw, -hh, hw * 2, hh * 2, 0.16); c.fill(); edge(c, k(P.line, 1, 0.75), 0.024);
    // жёлто-чёрная кромка — рабочая площадка
    c.save(); rr(c, -hw, -hh, hw * 2, hh * 2, 0.16); c.clip();
    c.strokeStyle = 'rgba(30,26,20,0.75)'; c.lineWidth = 0.09; rr(c, -hw, -hh, hw * 2, hh * 2, 0.16); c.stroke();
    c.setLineDash([0.08, 0.08]); c.strokeStyle = 'rgba(214,176,64,0.8)'; c.lineWidth = 0.05; rr(c, -hw + 0.02, -hh + 0.02, hw * 2 - 0.04, hh * 2 - 0.04, 0.14); c.stroke(); c.setLineDash([]);
    c.restore();
    if (res === 'ore') {
      // отвал руды
      for (var i = 0; i < 9; i++) {
        var px = hw * 0.35 + rnd(i * 1.7) * hw * 0.45, py = hh * 0.25 + rnd(i * 2.9) * hh * 0.5, s = 0.08 + rnd(i * 5.1) * 0.08;
        c.fillStyle = dome(c, px, py, s, rc, 1.2, 0.55); ngon(c, px, py, s, 5, rnd(i) * 3); c.fill();
      }
      // конвейер
      c.fillStyle = '#2b2b2b'; c.save(); c.rotate(0.6); c.fillRect(0, -0.06, hw * 0.95, 0.12); c.restore();
      // вышка: квадратная рама с раскосами
      var q = 0.42;
      c.fillStyle = 'rgba(0,0,0,0.3)'; c.fillRect(-q + 0.06, -q + 0.07, q * 2, q * 2);
      c.strokeStyle = k(P.plate, 1.05); c.lineWidth = 0.06; c.strokeRect(-q, -q, q * 2, q * 2);
      line(c, -q, -q, q, q, 0.035, k(P.plate, 0.85)); line(c, q, -q, -q, q, 0.035, k(P.plate, 0.85));
      c.fillStyle = '#1b1612'; dot(c, 0, 0, 0.2);
    } else if (res === 'gas') {
      // баки
      var tanks = [[-hw * 0.45, -hh * 0.42], [-hw * 0.45, hh * 0.42], [hw * 0.42, -hh * 0.42]];
      for (var j = 0; j < tanks.length; j++) {
        var tx = tanks[j][0], ty = tanks[j][1];
        c.fillStyle = 'rgba(0,0,0,0.3)'; dot(c, tx + 0.06, ty + 0.07, 0.3);
        c.fillStyle = dome(c, tx, ty, 0.3, P.plate, 1.3, 0.55); dot(c, tx, ty, 0.3); edge(c, k(P.line, 1, 0.7), 0.016);
        c.strokeStyle = k(rc, 0.9, 0.85); c.lineWidth = 0.05; c.beginPath(); c.arc(tx, ty, 0.21, 0, TAU); c.stroke();
        c.fillStyle = 'rgba(0,0,0,0.35)'; dot(c, tx, ty, 0.05);
      }
      // трубы к насосу
      line(c, tanks[0][0], tanks[0][1], hw * 0.42, hh * 0.42, 0.06, '#4a4f53'); line(c, tanks[1][0], tanks[1][1], hw * 0.42, hh * 0.42, 0.06, '#4a4f53'); line(c, tanks[2][0], tanks[2][1], hw * 0.42, hh * 0.42, 0.06, '#4a4f53');
      c.fillStyle = '#2b3034'; dot(c, hw * 0.42, hh * 0.42, 0.26);
    } else if (res === 'food') {
      // теплица: прозрачная крыша над грядками
      var W = hw * 1.6, H = hh * 1.5;
      c.fillStyle = '#3b2c1e'; rr(c, -W / 2, -H / 2, W, H, 0.12); c.fill();
      for (var r0 = 0; r0 < 5; r0++) {
        var yy = -H / 2 + 0.12 + r0 * (H - 0.24) / 4;
        for (var x0 = -W / 2 + 0.1; x0 < W / 2 - 0.05; x0 += 0.11) { c.fillStyle = k(rc, 0.7 + rnd(x0 * 13 + r0) * 0.5); dot(c, x0, yy, 0.05); }
      }
      c.fillStyle = 'rgba(200,235,255,0.2)'; rr(c, -W / 2, -H / 2, W, H, 0.12); c.fill();
      c.strokeStyle = 'rgba(220,240,255,0.55)'; c.lineWidth = 0.025; rr(c, -W / 2, -H / 2, W, H, 0.12); c.stroke();
      for (var xr = -W / 2 + W / 4; xr < W / 2 - 0.01; xr += W / 4) line(c, xr, -H / 2, xr, H / 2, 0.02, 'rgba(220,240,255,0.4)');
      c.fillStyle = 'rgba(255,255,255,0.22)'; c.fillRect(-W / 2 + 0.06, -H / 2 + 0.05, W * 0.4, 0.05);
    } else {
      // друза
      for (var n = 0; n < 7; n++) {
        var ca = n / 7 * TAU + 0.3, cd = n ? 0.22 + rnd(n) * 0.12 : 0, cx = Math.cos(ca) * cd, cy = Math.sin(ca) * cd, cl = 0.18 + rnd(n * 3) * 0.16;
        c.save(); c.translate(cx, cy); c.rotate(ca + 0.4);
        c.fillStyle = 'rgba(0,0,0,0.3)'; poly(c, [[0.04, -0.07], [cl + 0.05, 0.03], [0.04, 0.12]]); c.fill();
        c.fillStyle = lit(c, 0, 0, cl, rc, 1.55, 0.6); poly(c, [[0, -0.08], [cl, 0], [0, 0.08], [-0.05, 0]]); c.fill();
        line(c, 0, 0, cl, 0, 0.012, 'rgba(255,255,255,0.45)');
        c.restore();
      }
      // пилоны
      for (var pq = 0; pq < 3; pq++) {
        var pa = -Math.PI / 2 + pq / 3 * TAU, ppx = Math.cos(pa) * hw * 0.78, ppy = Math.sin(pa) * hh * 0.78;
        c.fillStyle = dome(c, ppx, ppy, 0.12, P.plate, 1.3, 0.55); ngon(c, ppx, ppy, 0.12, 6, 0); c.fill(); edge(c, k(P.line, 1, 0.7), 0.014);
      }
    }
  }
  function extractorTop(c, u) {
    var P = pal(u.team), t = u.t || 0, hw = u.w / 2 - 0.1, hh = u.h / 2 - 0.1, res = RES[u.res] ? u.res : 'ore', rc = RES[res];
    if (res === 'ore') {
      // бур крутится
      c.save(); c.rotate(t * 2.4);
      c.fillStyle = '#5a5f63'; ngon(c, 0, 0, 0.17, 8, 0); c.fill();
      for (var i = 0; i < 4; i++) { c.rotate(Math.PI / 2); c.fillStyle = '#8a9095'; c.fillRect(0.02, -0.03, 0.15, 0.06); }
      c.fillStyle = '#2a2d30'; dot(c, 0, 0, 0.05);
      c.restore();
      glow(c, -hw * 0.8, -hh * 0.8, 0.03, P.light, Math.sin(t * 3) > 0 ? 0.9 : 0.25);
    } else if (res === 'gas') {
      // вентилятор насоса
      c.save(); c.translate(hw * 0.42, hh * 0.42); c.rotate(t * 4);
      for (var b = 0; b < 3; b++) { c.rotate(TAU / 3); c.fillStyle = '#9aa2a8'; c.beginPath(); c.ellipse(0.1, 0, 0.1, 0.04, 0, 0, TAU); c.fill(); }
      c.fillStyle = '#1e2225'; dot(c, 0, 0, 0.04);
      c.restore();
      // утечка газа: лёгкое облачко
      var ph = (t * 0.35) % 1;
      c.fillStyle = k(rc, 1, 0.18 * (1 - ph)); dot(c, hw * 0.42 + 0.15 + ph * 0.3, hh * 0.42 - 0.3 - ph * 0.4, 0.08 + ph * 0.2);
    } else if (res === 'food') {
      glow(c, hw * 0.8, -hh * 0.8, 0.03, P.light, 0.6 + 0.4 * Math.sin(t * 2));
      // капельный полив: бегущие блики
      var W = hw * 1.6, x = -W / 2 + ((t * 0.3) % 1) * W;
      c.fillStyle = 'rgba(180,230,255,0.25)'; c.fillRect(x, -hh * 0.75, 0.05, hh * 1.5);
    } else {
      // друза светится, пилоны пускают лучи
      var pulse = 0.5 + 0.5 * Math.sin(t * 2.2);
      var g = c.createRadialGradient(0, 0, 0, 0, 0, 0.75);
      g.addColorStop(0, k(rc, 1.4, 0.35 + 0.2 * pulse)); g.addColorStop(1, k(rc, 1, 0));
      c.fillStyle = g; dot(c, 0, 0, 0.75);
      for (var pq = 0; pq < 3; pq++) {
        var pa = -Math.PI / 2 + pq / 3 * TAU, ppx = Math.cos(pa) * hw * 0.78, ppy = Math.sin(pa) * hh * 0.78;
        line(c, ppx, ppy, 0, 0, 0.03, k(rc, 1.5, 0.25 + 0.3 * pulse));
        glow(c, ppx, ppy, 0.03, rc, 0.7 + 0.3 * pulse);
      }
    }
  }

  // ---------------------------------------------------------------- кантина
  // Глинобитные купола, как на Татуине: большой зал, пристройка, вход с навесом, вывеска
  function cantina(c, u) {
    var P = pal(u.team), R = Math.min(u.w, u.h) / 2 * 0.62, sand = u.team === 1 ? '#c9b08a' : '#d8c4a0';
    var mx = -0.25, my = -0.2, sx = 0.75, sy = 0.62, sr = R * 0.55;
    shadow(c, 1.6, function() { c.beginPath(); c.arc(mx, my, R, 0, TAU); c.moveTo(sx + sr, sy); c.arc(sx, sy, sr, 0, TAU); });
    // двор
    var yard = c.createRadialGradient(0, 0, 0, 0, 0, u.w * 0.55);
    yard.addColorStop(0, 'rgba(196,170,126,0.55)'); yard.addColorStop(0.75, 'rgba(176,150,108,0.4)'); yard.addColorStop(1, 'rgba(176,150,108,0)');
    c.fillStyle = yard; dot(c, 0, 0, u.w * 0.55);
    // пристройка
    c.fillStyle = dome(c, sx, sy, sr, sand, 1.2, 0.6); dot(c, sx, sy, sr); edge(c, 'rgba(70,52,30,0.5)', 0.02);
    c.fillStyle = 'rgba(40,30,20,0.6)'; dot(c, sx + 0.05, sy - 0.05, sr * 0.28);
    // главный купол: пояс и вентиляция наверху
    c.fillStyle = dome(c, mx, my, R, sand, 1.22, 0.58); dot(c, mx, my, R); edge(c, 'rgba(70,52,30,0.5)', 0.025);
    c.strokeStyle = 'rgba(90,68,40,0.45)'; c.lineWidth = 0.04; c.beginPath(); c.arc(mx, my, R * 0.72, 0, TAU); c.stroke();
    c.fillStyle = dome(c, mx, my, R * 0.3, sand, 1.0, 0.5); dot(c, mx, my, R * 0.3);
    c.fillStyle = '#2a1e14'; dot(c, mx, my, R * 0.16);
    for (var i = 0; i < 6; i++) { var a = i / 6 * TAU; c.fillStyle = 'rgba(40,28,18,0.55)'; dot(c, mx + Math.cos(a) * R * 0.5, my + Math.sin(a) * R * 0.5, 0.04); }
    // вход с навесом (на юг)
    c.fillStyle = 'rgba(0,0,0,0.3)'; c.fillRect(mx - 0.36 + 0.05, my + R * 0.82 + 0.06, 0.72, 0.36);
    c.fillStyle = lit(c, mx, my + R, 0.4, P.mark, 1.25, 0.7); poly(c, [[mx - 0.38, my + R * 0.8], [mx + 0.38, my + R * 0.8], [mx + 0.32, my + R * 0.8 + 0.34], [mx - 0.32, my + R * 0.8 + 0.34]]); c.fill();
    for (var st = 0; st < 4; st++) line(c, mx - 0.3 + st * 0.2, my + R * 0.8, mx - 0.27 + st * 0.18, my + R * 0.8 + 0.34, 0.03, 'rgba(255,255,255,0.18)');
    // ящики и бочки во дворе
    c.fillStyle = lit(c, -1.05, 0.85, 0.15, '#8a6a40', 1.2, 0.6); c.fillRect(-1.15, 0.7, 0.24, 0.24); c.fillRect(-0.88, 0.82, 0.18, 0.18);
    c.fillStyle = dome(c, 1.0, -0.95, 0.12, '#6a7076', 1.3, 0.6); dot(c, 1.0, -0.95, 0.12); dot(c, 1.18, -0.78, 0.1);
  }
  function cantinaTop(c, u) {
    var t = u.t || 0, R = Math.min(u.w, u.h) / 2 * 0.62, mx = -0.25, my = -0.2;
    // неоновая вывеска над входом мигает
    var on = Math.sin(t * 3.1) > -0.4 || Math.sin(t * 17) > 0.6;
    var x = mx + 0.45, y = my + R * 0.75;
    c.fillStyle = 'rgba(20,14,10,0.85)'; rr(c, x - 0.02, y - 0.09, 0.42, 0.16, 0.04); c.fill();
    if (on) { glow(c, x + 0.08, y - 0.01, 0.03, '#ff5ab4', 0.95); glow(c, x + 0.19, y - 0.01, 0.03, '#ffd060', 0.95); glow(c, x + 0.3, y - 0.01, 0.03, '#5ad8ff', 0.95); }
  }

  // ---------------------------------------------------------------- башня поселения
  // Бастион рисует местность; здесь — крупная турель (та же голова, что у полевой, в 1,6 раза больше)
  function tower(c, u) { turretBase(c, u, 1.55); }
  function towerTop(c, u) { turretHead(c, u, 1.55); }

  // ---------------------------------------------------------------- развалины
  function ruin(c, u) {
    var hw = u.w / 2, hh = u.h / 2;
    c.fillStyle = 'rgba(18,14,10,0.55)'; c.beginPath(); c.ellipse(0, 0, hw * 0.95, hh * 0.95, 0, 0, TAU); c.fill();
    for (var i = 0; i < 6 + u.w * 4; i++) {
      var px = (rnd(i * 1.3 + u.w) - 0.5) * u.w * 0.85, py = (rnd(i * 2.7 + u.h) - 0.5) * u.h * 0.85, s = 0.06 + rnd(i * 4.1) * 0.12;
      c.fillStyle = dome(c, px, py, s, pal(u.team).mid, 0.9, 0.35); ngon(c, px, py, s, 4 + (i % 3), rnd(i) * 3); c.fill();
    }
  }

  var KINDS = {
    trench:    { base: trench,    top: null },
    bunker:    { base: bunker,    top: bunkerTop },
    turret:    { base: function(c, u) { turretBase(c, u, 1); }, top: function(c, u) { turretHead(c, u, 1); }, aims: true },
    jammer:    { base: jammer,    top: jammerTop },
    camo:      { base: camo,      top: camoTop },
    radar:     { base: radar,     top: radarTop },
    extractor: { base: extractor, top: extractorTop },
    cantina:   { base: cantina,   top: cantinaTop },
    tower:     { base: tower,     top: towerTop, aims: true }
  };

  // копоть: чем меньше прочности, тем больше пятен
  function scorch(c, u) {
    var d = 1 - (u.hp == null ? 1 : u.hp); if (d < 0.35) return;
    var n = Math.round(3 + d * 6 * Math.max(1, u.w));
    for (var i = 0; i < n; i++) {
      var px = (rnd(i * 5.3 + 1) - 0.5) * u.w * 0.8, py = (rnd(i * 7.1 + 2) - 0.5) * u.h * 0.8, r = 0.08 + rnd(i * 3.3) * 0.14;
      var g = c.createRadialGradient(px, py, 0, px, py, r);
      g.addColorStop(0, 'rgba(15,10,6,' + (0.35 + d * 0.35) + ')'); g.addColorStop(1, 'rgba(15,10,6,0)');
      c.fillStyle = g; dot(c, px, py, r);
    }
  }

  // part: 'base' — неподвижное, 'top' — живое, иначе всё
  function draw(c, kind, u, part) {
    var K = KINDS[kind]; if (!K) return false;
    c.save(); c.lineCap = 'round'; c.lineJoin = 'round';
    if (u.dead) { if (part !== 'top') ruin(c, u); c.restore(); return true; }
    if (part !== 'top') { K.base(c, u); scorch(c, u); }
    if (part !== 'base' && K.top) K.top(c, u);
    c.restore();
    return true;
  }

  // Картинка для панелей: тип из базы → вид постройки на прозрачном фоне
  var ICON = {}, URLS = {};
  function parseId(id) {
    var m = /^(rep|cis)_(.+)$/.exec(String(id || '')); if (!m) return null;
    var rest = m[2], res = null, kind = rest;
    if (/^mine_/.test(rest)) { kind = 'extractor'; res = rest.slice(5); }
    return { team: m[1] === 'cis' ? 1 : 0, kind: kind, res: res };
  }
  var SIZE = { trench: 1, bunker: 2, turret: 1, jammer: 2, camo: 1, radar: 2, extractor: 2, cantina: 3, tower: 2 };
  function icon(id, px) {
    px = px || 128;
    var key = id + '|' + px; if (ICON[key]) return ICON[key];
    var p = parseId(id); if (!p || !KINDS[p.kind]) return null;
    var n = SIZE[p.kind] || 1, pad = 0.18, cv = document.createElement('canvas');
    cv.width = cv.height = px;
    var c = cv.getContext('2d'), ppc = px / (n + pad * 2);
    c.translate(px / 2, px / 2); c.scale(ppc, ppc);
    draw(c, p.kind, { team: p.team, w: n, h: n, res: p.res, aim: -Math.PI / 4, t: 0.7, hp: 1 });
    ICON[key] = cv;
    return cv;
  }
  function iconURL(id, px) {
    var key = id + '|' + (px || 128); if (URLS[key]) return URLS[key];
    var cv = icon(id, px); if (!cv) return null;
    try { URLS[key] = cv.toDataURL('image/png'); } catch (e) { return null; }
    return URLS[key];
  }

  root.SWForts = { KINDS: KINDS, draw: draw, icon: icon, iconURL: iconURL, parseId: parseId, aims: function(kind) { return !!(KINDS[kind] && KINDS[kind].aims); } };
})(typeof self !== 'undefined' ? self : this);
