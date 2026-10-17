// Техника сверху для наземки 2.0 — по моделям из игры (assets/units/*.jpg).
//
// Каждая машина рисуется кодом: нос по +x, центр в (0, 0), единица — клетка поля.
// Машина 2×2 занимает примерно ±1.15 клетки (чуть больше своего места, как фигурки),
// машина 1×1 — около ±0.6. Свет — с северо-запада, как у местности: градиенты
// считаются от мирового направления света, поэтому при повороте машины блик
// остаётся с той же стороны. Тень лежит на земле со сдвигом на юго-восток, у
// летающих — дальше и слабее.
//
// u: { ang — курс (радианы), mv — 0..1 движется ли, phase — фаза шага/качения,
//      turret — угол башни (абсолютный), hp — 0..1 (повреждения: копоть) }
// bake() собирает набор картинок (курс × кадр), как rt-figures. Только браузер, ES5.

(function(root) {
  'use strict';

  var TAU = Math.PI * 2;
  var LX = -0.6, LY = -0.72;                  // направление света (мировое)
  var SH = [0.07, 0.09];                      // сдвиг тени на земле на единицу высоты

  // ---------------------------------------------------------------- цвета
  function rgb(h) { var v = parseInt(h.slice(1), 16); return [(v >> 16) & 255, (v >> 8) & 255, v & 255]; }
  function k(h, f, a) {
    var c = rgb(h), r = Math.min(255, Math.round(c[0] * f)), g = Math.min(255, Math.round(c[1] * f)), b = Math.min(255, Math.round(c[2] * f));
    return a == null ? 'rgb(' + r + ',' + g + ',' + b + ')' : 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
  }
  var REP = { base: '#d9dde1', mid: '#b9bfc5', dark: '#7c848c', line: '#4a5159', red: '#a2323b', red2: '#7d262d', glass: '#5d86b3', gold: '#d2aa45' };
  var TF  = { base: '#cfa070', mid: '#b38558', dark: '#7d5a3a', line: '#4e3620', rust: '#8a4a2a' };
  var CISW = { base: '#d7d9d6', mid: '#b0b3b0', dark: '#6f736f', line: '#3f433f', red: '#b23a33' };
  var CISB = { base: '#6d8fc2', mid: '#4f6fa0', dark: '#2f4a73', line: '#1d2d48', tan: '#c9a877' };

  // ---------------------------------------------------------------- свет и тень
  function lightLocal(u) {
    var a = -(u.ang || 0), cs = Math.cos(a), sn = Math.sin(a);
    return [LX * cs - LY * sn, LX * sn + LY * cs];
  }
  // линейный градиент по свету: от hi (к свету) до lo
  function lit(c, u, x, y, r, hex, hi, lo) {
    var l = lightLocal(u), g = c.createLinearGradient(x + l[0] * r, y + l[1] * r, x - l[0] * r, y - l[1] * r);
    g.addColorStop(0, k(hex, hi)); g.addColorStop(1, k(hex, lo));
    return g;
  }
  // выпуклость: радиальный градиент со смещённым к свету бликом
  function dome(c, u, x, y, r, hex, hi, lo) {
    var l = lightLocal(u), g = c.createRadialGradient(x + l[0] * r * 0.45, y + l[1] * r * 0.45, r * 0.05, x, y, r * 1.05);
    g.addColorStop(0, k(hex, hi)); g.addColorStop(1, k(hex, lo));
    return g;
  }
  // цилиндр поперёк направления (dx, dy): полоса света вдоль оси
  function tube(c, u, x0, y0, x1, y1, w, hex) {
    var dx = x1 - x0, dy = y1 - y0, L = Math.sqrt(dx * dx + dy * dy) || 1, nx = -dy / L, ny = dx / L;
    var l = lightLocal(u), s = nx * l[0] + ny * l[1];            // с какой стороны свет
    var g = c.createLinearGradient(x0 + nx * w / 2, y0 + ny * w / 2, x0 - nx * w / 2, y0 - ny * w / 2);
    var a = s > 0 ? 0.25 : 0.75;
    g.addColorStop(0, k(hex, s > 0 ? 1.25 : 0.55)); g.addColorStop(a, k(hex, 1.3)); g.addColorStop(1, k(hex, s > 0 ? 0.55 : 1.25));
    c.strokeStyle = g; c.lineWidth = w; c.lineCap = 'butt';
    c.beginPath(); c.moveTo(x0, y0); c.lineTo(x1, y1); c.stroke();
  }
  function shadowOf(c, u, h, fn) {
    var a = -(u.ang || 0), cs = Math.cos(a), sn = Math.sin(a), sx = SH[0] * h, sy = SH[1] * h;
    c.save(); c.translate(sx * cs - sy * sn, sx * sn + sy * cs);
    c.fillStyle = 'rgba(0,0,0,' + (h > 3 ? 0.28 : 0.42) + ')';
    fn(); c.fill();
    c.restore();
  }
  // мягкая тень (для летающих)
  function softShadow(c, u, h, rx, ry) {
    var a = -(u.ang || 0), cs = Math.cos(a), sn = Math.sin(a), sx = SH[0] * h, sy = SH[1] * h;
    c.save(); c.translate(sx * cs - sy * sn, sx * sn + sy * cs);
    var g = c.createRadialGradient(0, 0, 0, 0, 0, 1);
    g.addColorStop(0, 'rgba(0,0,0,0.32)'); g.addColorStop(0.7, 'rgba(0,0,0,0.18)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    c.scale(rx, ry); c.fillStyle = g; c.beginPath(); c.arc(0, 0, 1, 0, TAU); c.fill();
    c.restore();
  }
  // свечение репульсоров под днищем
  function hoverGlow(c, x, y, rx, ry, col) {
    var g = c.createRadialGradient(x, y, 0, x, y, 1);
    g.addColorStop(0, col || 'rgba(120,190,255,0.45)'); g.addColorStop(1, 'rgba(120,190,255,0)');
    c.save(); c.translate(x, y); c.scale(rx, ry); c.fillStyle = g; c.beginPath(); c.arc(0, 0, 1, 0, TAU); c.fill(); c.restore();
  }

  // ---------------------------------------------------------------- фигуры
  function rr(c, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    c.beginPath();
    c.moveTo(x + r, y); c.lineTo(x + w - r, y); c.quadraticCurveTo(x + w, y, x + w, y + r);
    c.lineTo(x + w, y + h - r); c.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    c.lineTo(x + r, y + h); c.quadraticCurveTo(x, y + h, x, y + h - r);
    c.lineTo(x, y + r); c.quadraticCurveTo(x, y, x + r, y); c.closePath();
  }
  function poly(c, pts) { c.beginPath(); for (var i = 0; i < pts.length; i++) { if (i) c.lineTo(pts[i][0], pts[i][1]); else c.moveTo(pts[i][0], pts[i][1]); } c.closePath(); }
  function dot(c, x, y, r) { c.beginPath(); c.arc(x, y, r, 0, TAU); c.fill(); }
  function line(c, x0, y0, x1, y1, w, col) { c.strokeStyle = col; c.lineWidth = w; c.beginPath(); c.moveTo(x0, y0); c.lineTo(x1, y1); c.stroke(); }
  function edge(c, col, w) { c.strokeStyle = col; c.lineWidth = w || 0.014; c.lineJoin = 'round'; c.stroke(); }
  // стык панелей: тёмная линия и светлая кромка рядом
  function seam(c, x0, y0, x1, y1, w) {
    line(c, x0, y0, x1, y1, w || 0.014, 'rgba(0,0,0,0.42)');
    line(c, x0 + 0.01, y0 + 0.012, x1 + 0.01, y1 + 0.012, (w || 0.014) * 0.7, 'rgba(255,255,255,0.22)');
  }
  function bolts(c, pts, r) { c.fillStyle = 'rgba(0,0,0,0.35)'; for (var i = 0; i < pts.length; i++) dot(c, pts[i][0], pts[i][1], r || 0.012); }

  // шаровая турель с коротким стволом
  function ballTurret(c, u, x, y, r, ang, hex, barrel) {
    c.fillStyle = 'rgba(0,0,0,0.35)'; dot(c, x + 0.015, y + 0.02, r);
    c.fillStyle = dome(c, u, x, y, r, hex, 1.35, 0.6); dot(c, x, y, r);
    var bl = barrel || r * 2.2;
    tube(c, u, x + Math.cos(ang) * r * 0.6, y + Math.sin(ang) * r * 0.6, x + Math.cos(ang) * (r * 0.6 + bl), y + Math.sin(ang) * (r * 0.6 + bl), r * 0.55, '#50565c');
    c.fillStyle = '#1e2226'; dot(c, x + Math.cos(ang) * (r * 0.6 + bl), y + Math.sin(ang) * (r * 0.6 + bl), r * 0.2);
  }
  // пушечный ствол: тёмный с бликом, дульный срез
  function cannon(c, u, x0, y0, x1, y1, w, hex) {
    tube(c, u, x0, y0, x1, y1, w, hex || '#5a6066');
    var dx = x1 - x0, dy = y1 - y0, L = Math.sqrt(dx * dx + dy * dy) || 1;
    c.fillStyle = '#15181b'; dot(c, x1, y1, w * 0.33);
    // кольца у казённика
    c.strokeStyle = 'rgba(0,0,0,0.45)'; c.lineWidth = w * 1.25; c.lineCap = 'butt';
    for (var q = 0.12; q < 0.3; q += 0.1) { var px = x0 + dx * q, py = y0 + dy * q; c.beginPath(); c.moveTo(px - dy / L * w * 0.6, py + dx / L * w * 0.6); c.lineTo(px + dy / L * w * 0.6, py - dx / L * w * 0.6); c.stroke(); }
  }
  // нога шагохода: бедро → колено → ступня. lift 0..1 — приподнята (светлее, ближе)
  function leg(c, u, hip, knee, foot, w, hex, lift, footR) {
    var cs = 1 + 0.12 * lift;
    c.lineCap = 'round'; c.lineJoin = 'round';
    if (lift < 0.5) { c.strokeStyle = 'rgba(0,0,0,0.35)'; c.lineWidth = w * 1.1; c.beginPath(); c.moveTo(hip[0] + 0.03, hip[1] + 0.04); c.lineTo(knee[0] + 0.03, knee[1] + 0.04); c.lineTo(foot[0] + 0.03, foot[1] + 0.04); c.stroke(); }
    c.strokeStyle = k(hex, 0.62); c.lineWidth = w * cs; c.beginPath(); c.moveTo(hip[0], hip[1]); c.lineTo(knee[0], knee[1]); c.lineTo(foot[0], foot[1]); c.stroke();
    c.strokeStyle = k(hex, 1.15 + lift * 0.2); c.lineWidth = w * 0.5 * cs; c.beginPath(); c.moveTo(hip[0] - 0.008, hip[1] - 0.012); c.lineTo(knee[0] - 0.008, knee[1] - 0.012); c.lineTo(foot[0] - 0.008, foot[1] - 0.012); c.stroke();
    c.fillStyle = k(hex, 0.8); dot(c, knee[0], knee[1], w * 0.62 * cs);
    c.fillStyle = k(hex, 1.1); dot(c, knee[0] - 0.01, knee[1] - 0.012, w * 0.3 * cs);
    // ступня
    var fr = (footR || w * 0.95) * cs;
    c.fillStyle = k(hex, 0.55); dot(c, foot[0], foot[1], fr);
    c.fillStyle = k(hex, 0.95 + lift * 0.25); dot(c, foot[0] - 0.008, foot[1] - 0.01, fr * 0.7);
    c.fillStyle = 'rgba(0,0,0,0.4)'; dot(c, foot[0], foot[1], fr * 0.22);
  }
  // шлем клона (наездник / стрелок) сверху
  function cloneHead(c, u, x, y, r, mark) {
    c.fillStyle = 'rgba(0,0,0,0.3)'; dot(c, x + 0.012, y + 0.016, r);
    c.fillStyle = dome(c, u, x, y, r, '#eef1f4', 1.05, 0.68); dot(c, x, y, r);
    c.strokeStyle = mark || '#3d74d6'; c.lineWidth = r * 0.3; c.beginPath(); c.arc(x, y, r * 0.72, -2.2, -0.9); c.stroke();
    c.fillStyle = '#2a2f36'; c.fillRect(x + r * 0.55, y - r * 0.35, r * 0.35, r * 0.7);
  }
  // голова B1 сверху (вытянутая)
  function b1Head(c, u, x, y, r, hex) {
    c.save(); c.translate(x, y);
    c.fillStyle = 'rgba(0,0,0,0.3)'; c.beginPath(); c.ellipse(0.012, 0.016, r * 1.5, r * 0.7, 0, 0, TAU); c.fill();
    c.fillStyle = dome(c, u, 0, 0, r, hex || TF.base, 1.2, 0.7); c.beginPath(); c.ellipse(0, 0, r * 1.5, r * 0.7, 0, 0, TAU); c.fill();
    c.fillStyle = '#2b2520'; dot(c, r * 0.9, -r * 0.3, r * 0.17); dot(c, r * 0.9, r * 0.3, r * 0.17);
    c.restore();
  }
  // копоть по повреждениям
  function scorch(c, u, pts) {
    var d = 1 - (u.hp == null ? 1 : u.hp);
    if (d < 0.35) return;
    c.fillStyle = 'rgba(20,14,10,' + (0.25 + d * 0.45) + ')';
    for (var i = 0; i < pts.length * Math.min(1, d * 1.4); i++) { var p = pts[i | 0]; dot(c, p[0], p[1], p[2]); }
  }
  function wheel(c, u, x, y, rx, ry, phase, hex) {
    c.save(); c.translate(x, y);
    c.fillStyle = 'rgba(0,0,0,0.4)'; c.beginPath(); c.ellipse(0.02, 0.025, rx, ry, 0, 0, TAU); c.fill();
    c.fillStyle = lit(c, u, 0, 0, ry, hex, 0.9, 0.45); c.beginPath(); c.ellipse(0, 0, rx, ry, 0, 0, TAU); c.fill();
    // протектор: полоски бегут по фазе
    c.save(); c.beginPath(); c.ellipse(0, 0, rx, ry, 0, 0, TAU); c.clip();
    c.strokeStyle = 'rgba(0,0,0,0.5)'; c.lineWidth = rx * 0.22;
    for (var q = -1.2; q <= 1.2; q += 0.34) { var px = ((q + phase / TAU * 0.34) % 0.34 + 0.34) % 0.34 + q - (q % 0.34) ; var xx = (q + (phase / TAU) * 0.34); xx = ((xx + rx) % (rx * 2) + rx * 2) % (rx * 2) - rx; c.beginPath(); c.moveTo(xx, -ry); c.lineTo(xx, ry); c.stroke(); }
    c.restore();
    c.strokeStyle = 'rgba(255,255,255,0.18)'; c.lineWidth = 0.012; c.beginPath(); c.ellipse(0, 0, rx, ry, 0, 0, TAU); c.stroke();
    c.restore();
  }

  // ---------------------------------------------------------------- Республика
  // AT-TE: два корпуса на гармошке, 6 ног, массдрайвер сверху со стрелком, 4 + 2 шаровые турели
  function atte(c, u) {
    var P = REP, ph = u.phase || 0, mv = u.mv || 0;
    var _b = body(u);
    if (_b) {
    // ноги: тройки, шаг по фазе (трёхногая походка: 0,2,4 против 1,3,5)
    var hips = [[0.62, -0.4], [0, -0.42], [-0.62, -0.4], [0.62, 0.4], [0, 0.42], [-0.62, 0.4]];
    var lean = [0.32, 0, -0.32];
    var legsOrder = [];
    for (var i = 0; i < 6; i++) {
      var side = i < 3 ? -1 : 1, j = i % 3, grp = (i + (i < 3 ? 0 : 1)) % 2;
      var sw = Math.sin(ph + grp * Math.PI) * 0.16 * mv, lift = Math.max(0, Math.cos(ph + grp * Math.PI)) * mv;
      var hip = hips[i], knee = [hip[0] + lean[j] * 0.45 + sw * 0.5, side * 0.72], foot = [hip[0] + lean[j] + sw, side * 1.0];
      legsOrder.push([hip, knee, foot, lift]);
    }
    shadowOf(c, u, 1.6, function() { rr(c, -1.12, -0.46, 2.24, 0.92, 0.3); });
    for (i = 0; i < 6; i++) leg(c, u, legsOrder[i][0], legsOrder[i][1], legsOrder[i][2], 0.13, '#9aa2aa', legsOrder[i][3], 0.1);
    // тазобедренные диски на бортах
    for (i = 0; i < 6; i++) { c.fillStyle = dome(c, u, hips[i][0], hips[i][1], 0.09, P.mid, 1.3, 0.6); dot(c, hips[i][0], hips[i][1], 0.09); edge(c, P.line, 0.01); }
    // гармошка
    c.fillStyle = lit(c, u, 0, 0, 0.4, P.dark, 1.1, 0.7); rr(c, -0.22, -0.36, 0.44, 0.72, 0.06); c.fill();
    for (var s = -0.18; s <= 0.18; s += 0.06) line(c, s, -0.36, s, 0.36, 0.016, 'rgba(0,0,0,0.45)');
    // корпуса
    function hull(x0, x1, front) {
      c.beginPath();
      if (front) { c.moveTo(x0, -0.4); c.lineTo(x1 - 0.5, -0.46); c.quadraticCurveTo(x1 + 0.04, -0.42, x1 + 0.04, -0.14); c.lineTo(x1 + 0.04, 0.14); c.quadraticCurveTo(x1 + 0.04, 0.42, x1 - 0.5, 0.46); c.lineTo(x0, 0.4); }
      else { c.moveTo(x1, -0.4); c.lineTo(x0 + 0.5, -0.46); c.quadraticCurveTo(x0 - 0.04, -0.42, x0 - 0.04, -0.14); c.lineTo(x0 - 0.04, 0.14); c.quadraticCurveTo(x0 - 0.04, 0.42, x0 + 0.5, 0.46); c.lineTo(x1, 0.4); }
      c.closePath();
    }
    hull(0.16, 1.12, true); c.fillStyle = lit(c, u, 0.64, 0, 0.6, P.base, 1.04, 0.72); c.fill(); edge(c, P.line, 0.016);
    hull(-1.12, -0.16, false); c.fillStyle = lit(c, u, -0.64, 0, 0.6, P.base, 1.04, 0.72); c.fill(); edge(c, P.line, 0.016);
    // верхняя площадка корпусов (ступенька), панели
    c.fillStyle = lit(c, u, 0.6, 0, 0.5, P.base, 1.12, 0.84); rr(c, 0.26, -0.3, 0.7, 0.6, 0.08); c.fill(); edge(c, 'rgba(0,0,0,0.3)');
    c.fillStyle = lit(c, u, -0.6, 0, 0.5, P.base, 1.12, 0.84); rr(c, -0.96, -0.3, 0.7, 0.6, 0.08); c.fill(); edge(c, 'rgba(0,0,0,0.3)');
    seam(c, 0.16, 0, 1.1, 0); seam(c, -1.1, 0, -0.16, 0);
    seam(c, 0.5, -0.44, 0.5, 0.44); seam(c, 0.82, -0.44, 0.82, 0.44); seam(c, -0.5, -0.44, -0.5, 0.44); seam(c, -0.82, -0.44, -0.82, 0.44);
    // вентиляция по бортам, лючки
    c.fillStyle = 'rgba(0,0,0,0.35)';
    for (var v = 0.3; v < 1.0; v += 0.14) { c.fillRect(v, -0.43, 0.08, 0.05); c.fillRect(v, 0.38, 0.08, 0.05); c.fillRect(-v - 0.08, -0.43, 0.08, 0.05); c.fillRect(-v - 0.08, 0.38, 0.08, 0.05); }
    bolts(c, [[0.3, -0.25], [0.3, 0.25], [0.92, -0.25], [0.92, 0.25], [-0.3, -0.25], [-0.3, 0.25], [-0.92, -0.25], [-0.92, 0.25]]);
    // кабина: тёмное остекление в носу
    c.fillStyle = lit(c, u, 1.0, 0, 0.15, P.glass, 1.2, 0.55); poly(c, [[0.96, -0.16], [1.1, -0.1], [1.1, 0.1], [0.96, 0.16]]); c.fill(); edge(c, P.line, 0.012);
    // шаровые турели: 4 спереди (две по носу, две по скулам), 2 сзади
    ballTurret(c, u, 1.02, -0.3, 0.075, -0.35, P.mid); ballTurret(c, u, 1.02, 0.3, 0.075, 0.35, P.mid);
    ballTurret(c, u, 0.7, -0.47, 0.065, -1.1, P.mid, 0.1); ballTurret(c, u, 0.7, 0.47, 0.065, 1.1, P.mid, 0.1);
    ballTurret(c, u, -1.0, -0.3, 0.07, Math.PI + 0.4, P.mid); ballTurret(c, u, -1.0, 0.3, 0.07, Math.PI - 0.4, P.mid);
    // массдрайвер на задней половине: опора, станина, ствол вперёд, стрелок
    }
    if (top(u)) {
    var ta = (u.turret == null ? u.ang || 0 : u.turret) - (u.ang || 0);
    c.save(); c.translate(-0.38, 0); c.rotate(ta);
    c.fillStyle = 'rgba(0,0,0,0.35)'; dot(c, 0.02, 0.03, 0.2);
    c.fillStyle = dome(c, u, 0, 0, 0.2, P.mid, 1.3, 0.7); dot(c, 0, 0, 0.2); edge(c, P.line, 0.012);
    c.fillStyle = lit(c, u, 0.05, 0, 0.12, P.dark, 1.2, 0.7); rr(c, -0.1, -0.11, 0.3, 0.22, 0.04); c.fill();
    cannon(c, u, 0.05, 0, 1.0, 0, 0.1, '#4f565d');
    tube(c, u, 0.1, -0.07, 0.42, -0.07, 0.035, '#8b949c'); tube(c, u, 0.1, 0.07, 0.42, 0.07, 0.035, '#8b949c');
    cloneHead(c, u, -0.2, 0, 0.07, P.gold);
    c.restore();
    }
    if (_b) {

    scorch(c, u, [[0.5, -0.2, 0.12], [-0.6, 0.25, 0.14], [0.9, 0.1, 0.1], [-0.2, -0.3, 0.1]]);
    }
  }

  // AT-RT: двуногий разведчик с клоном в седле
  function atrt(c, u) {
    var P = REP, ph = u.phase || 0, mv = u.mv || 0;
    shadowOf(c, u, 1.3, function() { rr(c, -0.38, -0.2, 0.76, 0.4, 0.12); });
    for (var s = -1; s <= 1; s += 2) {
      var sw = Math.sin(ph + (s > 0 ? 0 : Math.PI)) * 0.2 * mv, lift = Math.max(0, Math.cos(ph + (s > 0 ? 0 : Math.PI))) * mv;
      leg(c, u, [-0.05, s * 0.14], [-0.22 + sw * 0.4, s * 0.38], [0.05 + sw, s * 0.48], 0.065, '#a7aeb5', lift, 0.06);
    }
    // корпус: узкое тело, сиденье, нос с пушкой
    c.fillStyle = lit(c, u, 0, 0, 0.3, P.base, 1.08, 0.72); poly(c, [[-0.34, -0.1], [0.1, -0.14], [0.36, -0.08], [0.36, 0.08], [0.1, 0.14], [-0.34, 0.1]]); c.fill(); edge(c, P.line, 0.012);
    seam(c, 0.1, -0.14, 0.1, 0.14, 0.01);
    c.fillStyle = 'rgba(0,0,0,0.3)'; c.fillRect(-0.32, -0.06, 0.1, 0.12);
    cannon(c, u, 0.2, 0, 0.58, 0, 0.045, '#4f565d');
    // наездник: плечи и шлем
    c.fillStyle = lit(c, u, -0.1, 0, 0.12, '#e8ebee', 1.05, 0.7); rr(c, -0.2, -0.13, 0.2, 0.26, 0.06); c.fill(); edge(c, 'rgba(0,0,0,0.35)', 0.01);
    cloneHead(c, u, -0.07, 0, 0.075, '#3d74d6');
    scorch(c, u, [[0.2, 0.05, 0.08]]);
  }

  // BARC: длинный спидер, два носовых орудия, два задних выноса двигателей
  function barc(c, u) {
    var P = REP;
    softShadow(c, u, 1.2, 0.5, 0.2);
    hoverGlow(c, -0.1, 0, 0.42, 0.16);
    // двигательные выносы сзади
    c.fillStyle = lit(c, u, -0.4, 0, 0.1, P.dark, 1.15, 0.65);
    rr(c, -0.58, -0.2, 0.3, 0.1, 0.04); c.fill(); rr(c, -0.58, 0.1, 0.3, 0.1, 0.04); c.fill();
    c.fillStyle = 'rgba(90,160,255,0.8)'; c.fillRect(-0.58, -0.18, 0.03, 0.06); c.fillRect(-0.58, 0.12, 0.03, 0.06);
    // тело
    c.fillStyle = lit(c, u, 0, 0, 0.2, P.base, 1.1, 0.72); poly(c, [[-0.4, -0.08], [-0.1, -0.11], [0.3, -0.1], [0.56, -0.04], [0.56, 0.04], [0.3, 0.1], [-0.1, 0.11], [-0.4, 0.08]]); c.fill(); edge(c, P.line, 0.012);
    c.fillStyle = P.red; c.fillRect(0.2, -0.1, 0.06, 0.2);
    seam(c, 0.34, -0.09, 0.34, 0.09, 0.01);
    // носовые орудия на выносах
    tube(c, u, 0.42, -0.14, 0.6, -0.14, 0.03, '#50565c'); tube(c, u, 0.42, 0.14, 0.6, 0.14, 0.03, '#50565c');
    line(c, 0.42, -0.14, 0.42, 0.14, 0.03, k(P.dark, 0.9));
    // руль и наездник
    line(c, 0.12, -0.16, 0.12, 0.16, 0.025, '#3a4046');
    c.fillStyle = lit(c, u, -0.12, 0, 0.1, '#e8ebee', 1.05, 0.7); rr(c, -0.24, -0.12, 0.22, 0.24, 0.06); c.fill(); edge(c, 'rgba(0,0,0,0.35)', 0.01);
    cloneHead(c, u, -0.08, 0, 0.07, '#3d74d6');
  }

  // LAAT/i: широкие крылья, два пузыря кабины, шаровые турели по бортам, два ракетных пилона сверху, хвост
  function laat(c, u) {
    var P = REP;
    softShadow(c, u, 4, 1.0, 0.8);
    // крылья: широкие, прямые, чуть назад
    c.fillStyle = lit(c, u, 0, 0, 0.9, P.base, 1.0, 0.7);
    poly(c, [[0.35, -0.3], [0.05, -1.12], [-0.45, -1.12], [-0.4, -0.3]]); c.fill(); edge(c, P.line, 0.016);
    poly(c, [[0.35, 0.3], [0.05, 1.12], [-0.45, 1.12], [-0.4, 0.3]]); c.fill(); edge(c, P.line, 0.016);
    // полосы на крыльях
    c.fillStyle = P.red; poly(c, [[0.2, -0.35], [0.0, -1.05], [-0.1, -1.05], [0.1, -0.35]]); c.fill(); poly(c, [[0.2, 0.35], [0.0, 1.05], [-0.1, 1.05], [0.1, 0.35]]); c.fill();
    seam(c, -0.2, -0.32, -0.3, -1.1); seam(c, -0.2, 0.32, -0.3, 1.1);
    // крыльевые лазеры (на концах)
    tube(c, u, -0.2, -1.08, 0.15, -1.08, 0.035, '#50565c'); tube(c, u, -0.2, 1.08, 0.15, 1.08, 0.035, '#50565c');
    // хвостовая балка и киль
    c.fillStyle = lit(c, u, -0.8, 0, 0.2, P.mid, 1.1, 0.7); rr(c, -1.12, -0.14, 0.5, 0.28, 0.05); c.fill(); edge(c, P.line, 0.014);
    line(c, -1.1, 0, -0.65, 0, 0.05, k(P.dark, 0.9));
    ballTurret(c, u, -1.06, 0, 0.055, Math.PI, P.mid, 0.08);
    // фюзеляж
    c.fillStyle = lit(c, u, 0.1, 0, 0.5, P.base, 1.1, 0.74);
    poly(c, [[1.04, -0.26], [1.12, -0.18], [1.12, 0.18], [1.04, 0.26], [0.5, 0.36], [-0.7, 0.34], [-0.7, -0.34], [0.5, -0.36]]); c.fill(); edge(c, P.line, 0.016);
    c.fillStyle = P.red; c.fillRect(-0.6, -0.34, 0.08, 0.68); c.fillRect(-0.25, -0.34, 0.05, 0.68);
    seam(c, 0.5, -0.36, 0.5, 0.36); seam(c, 0.1, -0.35, 0.1, 0.35);
    // кабина: два пузыря друг за другом
    c.fillStyle = dome(c, u, 0.95, 0, 0.1, P.glass, 1.3, 0.5); c.beginPath(); c.ellipse(0.92, 0, 0.14, 0.1, 0, 0, TAU); c.fill(); edge(c, P.line, 0.01);
    c.fillStyle = dome(c, u, 0.68, 0, 0.1, P.glass, 1.3, 0.5); c.beginPath(); c.ellipse(0.66, 0, 0.14, 0.11, 0, 0, TAU); c.fill(); edge(c, P.line, 0.01);
    // ракетные пилоны сверху
    for (var s = -1; s <= 1; s += 2) {
      tube(c, u, -0.45, s * 0.2, 0.42, s * 0.2, 0.09, '#8d959c');
      c.fillStyle = '#2b2f33'; dot(c, 0.42, s * 0.2, 0.03);
      c.fillStyle = k(P.dark, 0.8); c.fillRect(-0.5, s * 0.2 - 0.06, 0.12, 0.12);
    }
    // бортовые шаровые турели на выносах
    ballTurret(c, u, 0.3, -0.42, 0.07, -0.6, P.mid); ballTurret(c, u, 0.3, 0.42, 0.07, 0.6, P.mid);
    // подбородочные пушки
    tube(c, u, 1.0, -0.12, 1.16, -0.12, 0.03, '#50565c'); tube(c, u, 1.0, 0.12, 1.16, 0.12, 0.03, '#50565c');
    scorch(c, u, [[0.0, 0.2, 0.12], [-0.5, -0.5, 0.14], [0.6, -0.1, 0.1]]);
  }

  // HAVw A6: десять колёс, длинный корпус, башни, командирская вышка, красные полосы
  function turbo(c, u) {
    var P = REP, ph = u.phase || 0;
    var _b = body(u);
    if (_b) {
    shadowOf(c, u, 2.4, function() { rr(c, -1.14, -0.46, 2.28, 0.92, 0.22); });
    // колёса — по пять с борта, выступают из-под корпуса
    for (var i = 0; i < 5; i++) {
      var x = -0.86 + i * 0.43;
      wheel(c, u, x, -0.5, 0.17, 0.11, ph, '#3b3f44'); wheel(c, u, x, 0.5, 0.17, 0.11, ph, '#3b3f44');
    }
    // корпус: длинная коробка со скосами на носу и корме
    c.fillStyle = lit(c, u, 0, 0, 0.9, P.base, 1.06, 0.72);
    poly(c, [[1.14, -0.3], [1.14, 0.3], [0.98, 0.42], [-0.98, 0.42], [-1.14, 0.3], [-1.14, -0.3], [-0.98, -0.42], [0.98, -0.42]]); c.fill(); edge(c, P.line, 0.016);
    // крыша чуть уже и выше
    c.fillStyle = lit(c, u, 0, 0, 0.8, P.base, 1.14, 0.82); rr(c, -0.9, -0.3, 1.8, 0.6, 0.06); c.fill(); edge(c, 'rgba(0,0,0,0.3)');
    // полосы
    c.fillStyle = P.red; c.fillRect(-0.9, -0.3, 1.8, 0.05); c.fillRect(-0.9, 0.25, 1.8, 0.05); c.fillRect(0.3, -0.3, 0.1, 0.6);
    for (var s = -0.6; s <= 0.6; s += 0.3) seam(c, s, -0.42, s, 0.42);
    seam(c, -0.9, 0, 0.9, 0, 0.012);
    // люки и вентиляция
    c.fillStyle = 'rgba(0,0,0,0.35)';
    for (var v = -0.8; v < -0.2; v += 0.12) { c.fillRect(v, -0.2, 0.06, 0.04); c.fillRect(v, 0.16, 0.06, 0.04); }
    rr(c, -0.5, -0.1, 0.16, 0.2, 0.03); c.fillStyle = k(P.mid, 0.9); c.fill(); edge(c, 'rgba(0,0,0,0.4)', 0.01);
    // командирская вышка у носа
    c.fillStyle = 'rgba(0,0,0,0.3)'; dot(c, 0.74, 0.03, 0.14);
    c.fillStyle = dome(c, u, 0.72, 0, 0.13, P.mid, 1.3, 0.65); dot(c, 0.72, 0, 0.13); edge(c, P.line, 0.012);
    c.fillStyle = lit(c, u, 0.72, 0, 0.08, P.glass, 1.2, 0.6); dot(c, 0.72, 0, 0.07);
    // носовые спаренные бластеры
    tube(c, u, 1.05, -0.22, 1.24, -0.22, 0.035, '#50565c'); tube(c, u, 1.05, -0.16, 1.24, -0.16, 0.035, '#50565c');
    tube(c, u, 1.05, 0.22, 1.24, 0.22, 0.035, '#50565c'); tube(c, u, 1.05, 0.16, 1.24, 0.16, 0.035, '#50565c');
    // башня с тяжёлым лазером (середина) и роторная турель (корма)
    }
    if (top(u)) {
    var ta = (u.turret == null ? u.ang || 0 : u.turret) - (u.ang || 0);
    c.save(); c.translate(0.1, 0); c.rotate(ta);
    c.fillStyle = 'rgba(0,0,0,0.35)'; dot(c, 0.02, 0.03, 0.2);
    c.fillStyle = dome(c, u, 0, 0, 0.2, P.base, 1.25, 0.66); dot(c, 0, 0, 0.2); edge(c, P.line, 0.012);
    c.fillStyle = P.red; c.beginPath(); c.arc(0, 0, 0.2, 2.2, 4.1); c.lineTo(0, 0); c.fill();
    cannon(c, u, 0.08, 0, 0.78, 0, 0.075, '#4f565d');
    c.restore();
    }
    if (_b) {

    c.save(); c.translate(-0.62, 0); c.rotate(ta * 0.6);
    c.fillStyle = dome(c, u, 0, 0, 0.12, P.mid, 1.25, 0.66); dot(c, 0, 0, 0.12); edge(c, P.line, 0.01);
    tube(c, u, 0.05, -0.03, 0.38, -0.03, 0.03, '#50565c'); tube(c, u, 0.05, 0.03, 0.38, 0.03, 0.03, '#50565c');
    cloneHead(c, u, -0.05, 0, 0.055, P.gold);
    c.restore();
    scorch(c, u, [[-0.3, 0.2, 0.14], [0.5, -0.25, 0.12], [-0.8, -0.1, 0.1]]);
    }
  }

  // TX-130: клиновидный ховертанк, две спаренные пушки в бортовых гондолах, башня сверху
  function tx130(c, u) {
    var P = REP;
    var _b = body(u);
    if (_b) {
    softShadow(c, u, 1.4, 1.05, 0.7);
    hoverGlow(c, -0.1, 0, 0.9, 0.5, 'rgba(120,190,255,0.35)');
    // бортовые гондолы
    for (var s = -1; s <= 1; s += 2) {
      c.fillStyle = lit(c, u, 0.3, s * 0.62, 0.3, P.mid, 1.1, 0.68); poly(c, [[0.7, s * 0.5], [0.75, s * 0.72], [-0.6, s * 0.76], [-0.7, s * 0.5]]); c.fill(); edge(c, P.line, 0.014);
      c.fillStyle = P.red; poly(c, [[0.1, s * 0.52], [0.1, s * 0.74], [-0.05, s * 0.74], [-0.05, s * 0.52]]); c.fill();
      tube(c, u, 0.6, s * 0.58, 1.12, s * 0.58, 0.05, '#50565c'); tube(c, u, 0.6, s * 0.67, 1.12, s * 0.67, 0.05, '#50565c');
      c.fillStyle = '#15181b'; dot(c, 1.12, s * 0.58, 0.018); dot(c, 1.12, s * 0.67, 0.018);
      // пусковые на спонсонах
      c.fillStyle = 'rgba(0,0,0,0.4)'; for (var q = 0; q < 3; q++) dot(c, -0.45 + q * 0.12, s * 0.66, 0.025);
    }
    // корпус-клин
    c.fillStyle = lit(c, u, 0.1, 0, 0.8, P.base, 1.08, 0.72);
    poly(c, [[1.05, -0.08], [1.05, 0.08], [0.5, 0.42], [-0.7, 0.5], [-0.95, 0.3], [-0.95, -0.3], [-0.7, -0.5], [0.5, -0.42]]); c.fill(); edge(c, P.line, 0.016);
    seam(c, 0.5, -0.42, 0.5, 0.42); seam(c, -0.3, -0.48, -0.3, 0.48);
    c.fillStyle = P.red; poly(c, [[0.9, -0.03], [0.9, 0.03], [0.55, 0.2], [0.55, -0.2]]); c.fill();
    // двигатели сзади
    c.fillStyle = '#2b2f33'; rr(c, -0.98, -0.22, 0.08, 0.14, 0.02); c.fill(); rr(c, -0.98, 0.08, 0.08, 0.14, 0.02); c.fill();
    c.fillStyle = 'rgba(100,170,255,0.8)'; c.fillRect(-0.99, -0.2, 0.025, 0.1); c.fillRect(-0.99, 0.1, 0.025, 0.1);
    // кабина и башня
    c.fillStyle = lit(c, u, 0.45, 0, 0.12, P.glass, 1.25, 0.55); rr(c, 0.3, -0.12, 0.26, 0.24, 0.08); c.fill(); edge(c, P.line, 0.01);
    }
    if (top(u)) {
    var ta = (u.turret == null ? u.ang || 0 : u.turret) - (u.ang || 0);
    c.save(); c.translate(-0.3, 0); c.rotate(ta);
    c.fillStyle = 'rgba(0,0,0,0.35)'; dot(c, 0.02, 0.03, 0.17);
    c.fillStyle = dome(c, u, 0, 0, 0.17, P.base, 1.25, 0.66); dot(c, 0, 0, 0.17); edge(c, P.line, 0.012);
    tube(c, u, 0.05, -0.045, 0.5, -0.045, 0.035, '#50565c'); tube(c, u, 0.05, 0.045, 0.5, 0.045, 0.035, '#50565c');
    c.fillStyle = '#15181b'; dot(c, 0.5, -0.045, 0.013); dot(c, 0.5, 0.045, 0.013);
    c.restore();
    }
    if (_b) {

    scorch(c, u, [[0.2, -0.3, 0.12], [-0.5, 0.3, 0.12]]);
    }
  }

  // Артиллерия Республики (по модели: шагающее орудие с длинным стволом, белое с красным, клон рядом)
  function sphaRep(c, u) {
    var P = REP, ph = u.phase || 0, mv = u.mv || 0;
    var _b = body(u);
    if (_b) {
    shadowOf(c, u, 1.5, function() { rr(c, -0.8, -0.5, 1.4, 1.0, 0.25); });
    // четыре короткие ноги
    var hips = [[0.3, -0.42], [-0.5, -0.42], [0.3, 0.42], [-0.5, 0.42]];
    for (var i = 0; i < 4; i++) {
      var s = i < 2 ? -1 : 1, g = i % 2, sw = Math.sin(ph + g * Math.PI) * 0.14 * mv, lift = Math.max(0, Math.cos(ph + g * Math.PI)) * mv;
      leg(c, u, hips[i], [hips[i][0] + sw * 0.5, s * 0.72], [hips[i][0] + sw + (g ? -0.15 : 0.15), s * 0.95], 0.1, '#9aa2aa', lift, 0.085);
    }
    // станина: широкий короб
    c.fillStyle = lit(c, u, -0.1, 0, 0.6, P.base, 1.06, 0.72); rr(c, -0.8, -0.5, 1.3, 1.0, 0.12); c.fill(); edge(c, P.line, 0.016);
    c.fillStyle = P.red; c.fillRect(-0.8, -0.5, 1.3, 0.06); c.fillRect(-0.8, 0.44, 1.3, 0.06);
    seam(c, -0.3, -0.5, -0.3, 0.5); seam(c, 0.2, -0.5, 0.2, 0.5);
    c.fillStyle = 'rgba(0,0,0,0.35)'; for (var v = -0.7; v < -0.35; v += 0.1) { c.fillRect(v, -0.4, 0.05, 0.1); c.fillRect(v, 0.3, 0.05, 0.1); }
    // генераторы по углам
    c.fillStyle = dome(c, u, -0.6, -0.3, 0.1, P.mid, 1.3, 0.6); dot(c, -0.6, -0.3, 0.1); c.fillStyle = dome(c, u, -0.6, 0.3, 0.1, P.mid, 1.3, 0.6); dot(c, -0.6, 0.3, 0.1);
    // орудие: люлька, длинный ствол далеко вперёд, противооткат
    }
    if (top(u)) {
    var ta = (u.turret == null ? u.ang || 0 : u.turret) - (u.ang || 0);
    c.save(); c.translate(-0.15, 0); c.rotate(ta);
    c.fillStyle = 'rgba(0,0,0,0.35)'; dot(c, 0.02, 0.03, 0.3);
    c.fillStyle = dome(c, u, 0, 0, 0.3, P.base, 1.2, 0.68); dot(c, 0, 0, 0.3); edge(c, P.line, 0.014);
    c.fillStyle = P.red; c.beginPath(); c.arc(0, 0, 0.3, 2.4, 3.9); c.lineTo(0, 0); c.fill();
    c.fillStyle = lit(c, u, 0.1, 0, 0.15, P.dark, 1.2, 0.7); rr(c, -0.15, -0.16, 0.45, 0.32, 0.05); c.fill(); edge(c, P.line, 0.012);
    tube(c, u, 0.2, -0.1, 0.6, -0.1, 0.05, '#8b949c'); tube(c, u, 0.2, 0.1, 0.6, 0.1, 0.05, '#8b949c');
    cannon(c, u, 0.1, 0, 1.3, 0, 0.11, '#4f565d');
    c.fillStyle = '#3a4046'; rr(c, 1.08, -0.08, 0.14, 0.16, 0.03); c.fill();
    c.restore();
    }
    if (_b) {

    // расчёт: клон у станины
    cloneHead(c, u, -0.68, 0, 0.065, '#3d74d6');
    scorch(c, u, [[0.0, 0.3, 0.12], [-0.5, -0.1, 0.1]]);
    }
  }

  // ---------------------------------------------------------------- КНС
  // AAT: лопатообразный корпус, башня с длинной пушкой сзади, бортовые лазеры, носовые пусковые
  function aat(c, u) {
    var P = TF;
    var _b = body(u);
    if (_b) {
    softShadow(c, u, 1.5, 1.1, 0.75);
    hoverGlow(c, -0.1, 0, 0.95, 0.6, 'rgba(255,170,90,0.28)');
    // нижний корпус-лопата
    c.fillStyle = lit(c, u, 0.1, 0, 0.9, P.base, 1.04, 0.66);
    c.beginPath(); c.moveTo(1.12, -0.12); c.quadraticCurveTo(1.14, 0, 1.12, 0.12); c.lineTo(0.5, 0.55); c.quadraticCurveTo(0.1, 0.72, -0.4, 0.68); c.lineTo(-0.95, 0.5); c.lineTo(-0.95, -0.5); c.lineTo(-0.4, -0.68); c.quadraticCurveTo(0.1, -0.72, 0.5, -0.55); c.closePath(); c.fill(); edge(c, P.line, 0.016);
    // носовой скос с пусковыми (три тёмных отверстия по скуле)
    c.fillStyle = lit(c, u, 0.85, 0, 0.3, P.mid, 1.1, 0.7); poly(c, [[1.1, -0.1], [1.1, 0.1], [0.55, 0.48], [0.4, 0.3], [0.4, -0.3], [0.55, -0.48]]); c.fill(); edge(c, 'rgba(0,0,0,0.35)');
    c.fillStyle = '#2a1e14'; for (var q = 0; q < 3; q++) { c.beginPath(); c.ellipse(0.78 - q * 0.12, -0.3 - q * 0.08, 0.045, 0.03, -0.6, 0, TAU); c.fill(); c.beginPath(); c.ellipse(0.78 - q * 0.12, 0.3 + q * 0.08, 0.045, 0.03, 0.6, 0, TAU); c.fill(); }
    // верхний корпус (уже)
    c.fillStyle = lit(c, u, -0.1, 0, 0.7, P.base, 1.14, 0.8); poly(c, [[0.45, -0.3], [0.45, 0.3], [0.2, 0.5], [-0.85, 0.44], [-0.85, -0.44], [0.2, -0.5]]); c.fill(); edge(c, P.line, 0.014);
    seam(c, 0.2, -0.5, 0.2, 0.5); seam(c, -0.55, -0.44, -0.55, 0.44);
    c.fillStyle = 'rgba(0,0,0,0.35)'; for (var v = -0.8; v < -0.6; v += 0.07) c.fillRect(v, -0.3, 0.035, 0.6);
    bolts(c, [[0.3, -0.38], [0.3, 0.38], [-0.4, -0.4], [-0.4, 0.4]]);
    // бортовые лазеры в скулах с короткими стволами и спаренными бластерами
    for (var s = -1; s <= 1; s += 2) {
      c.fillStyle = dome(c, u, 0.42, s * 0.52, 0.08, P.mid, 1.3, 0.6); dot(c, 0.42, s * 0.52, 0.08); edge(c, P.line, 0.01);
      tube(c, u, 0.48, s * 0.52, 0.78, s * 0.52, 0.04, '#4a3a2a'); tube(c, u, 0.46, s * 0.6, 0.66, s * 0.6, 0.025, '#4a3a2a');
      c.fillStyle = '#15181b'; dot(c, 0.78, s * 0.52, 0.015);
    }
    // башня сзади с длинной пушкой
    }
    if (top(u)) {
    var ta = (u.turret == null ? u.ang || 0 : u.turret) - (u.ang || 0);
    c.save(); c.translate(-0.35, 0); c.rotate(ta);
    c.fillStyle = 'rgba(0,0,0,0.35)'; c.beginPath(); c.ellipse(0.02, 0.03, 0.3, 0.26, 0, 0, TAU); c.fill();
    c.fillStyle = dome(c, u, 0, 0, 0.3, P.base, 1.3, 0.62); c.beginPath(); c.ellipse(0, 0, 0.3, 0.26, 0, 0, TAU); c.fill(); edge(c, P.line, 0.014);
    c.fillStyle = dome(c, u, -0.02, 0, 0.14, P.mid, 1.3, 0.7); dot(c, -0.02, 0, 0.14); edge(c, 'rgba(0,0,0,0.35)', 0.01);
    c.fillStyle = 'rgba(0,0,0,0.3)'; dot(c, -0.1, 0.1, 0.05);
    cannon(c, u, 0.15, 0, 1.25, 0, 0.065, '#4a3a2a');
    tube(c, u, 0.3, 0, 0.6, 0, 0.09, '#5b4532');
    c.restore();
    }
    if (_b) {

    // задние жалюзи
    c.fillStyle = 'rgba(0,0,0,0.4)'; for (var r = -0.4; r <= 0.4; r += 0.1) c.fillRect(-0.95, r - 0.02, 0.06, 0.04);
    scorch(c, u, [[0.3, 0.1, 0.14], [-0.6, -0.3, 0.12], [0.7, -0.2, 0.1]]);
    }
  }

  // MTT: слоноподобный транспорт — широкая голова впереди, узкое тело назад, кабина сверху, носовые бластеры
  function mtt(c, u) {
    var P = TF;
    softShadow(c, u, 1.6, 1.15, 0.8);
    hoverGlow(c, 0, 0, 1.0, 0.6, 'rgba(255,170,90,0.28)');
    // тело: задняя часть уже
    c.fillStyle = lit(c, u, -0.4, 0, 0.9, P.base, 1.02, 0.66);
    c.beginPath(); c.moveTo(0.2, -0.62); c.lineTo(-0.9, -0.5); c.quadraticCurveTo(-1.14, -0.45, -1.14, -0.25); c.lineTo(-1.14, 0.25); c.quadraticCurveTo(-1.14, 0.45, -0.9, 0.5); c.lineTo(0.2, 0.62); c.closePath(); c.fill(); edge(c, P.line, 0.016);
    // голова: широкая, скруглённая спереди
    c.fillStyle = lit(c, u, 0.55, 0, 0.9, P.base, 1.1, 0.7);
    c.beginPath(); c.moveTo(0.1, -0.8); c.lineTo(0.75, -0.8); c.quadraticCurveTo(1.14, -0.72, 1.14, -0.3); c.lineTo(1.14, 0.3); c.quadraticCurveTo(1.14, 0.72, 0.75, 0.8); c.lineTo(0.1, 0.8); c.closePath(); c.fill(); edge(c, P.line, 0.016);
    // носовой скос (светлее к свету), ряд панелей
    c.fillStyle = lit(c, u, 0.95, 0, 0.4, P.mid, 1.15, 0.72); poly(c, [[0.8, -0.78], [1.12, -0.3], [1.12, 0.3], [0.8, 0.78]]); c.fill(); edge(c, 'rgba(0,0,0,0.35)');
    seam(c, 0.8, -0.78, 0.8, 0.78); seam(c, 0.4, -0.8, 0.4, 0.8); seam(c, 0.1, -0.8, 0.1, 0.8); seam(c, -0.4, -0.56, -0.4, 0.56); seam(c, -0.8, -0.5, -0.8, 0.5);
    seam(c, -1.1, 0, 0.1, 0, 0.012);
    c.fillStyle = 'rgba(0,0,0,0.35)';
    for (var v = -0.7; v <= 0.7; v += 0.14) { c.fillRect(0.5, v - 0.02, 0.2, 0.04); }
    for (var r = -0.35; r <= 0.35; r += 0.1) c.fillRect(-1.12, r - 0.02, 0.07, 0.04);
    bolts(c, [[0.25, -0.7], [0.25, 0.7], [-0.6, -0.42], [-0.6, 0.42]]);
    // кабина сверху у головы с люком за ней
    c.fillStyle = dome(c, u, 0.45, 0, 0.16, P.mid, 1.3, 0.65); c.beginPath(); c.ellipse(0.45, 0, 0.18, 0.16, 0, 0, TAU); c.fill(); edge(c, P.line, 0.012);
    c.fillStyle = lit(c, u, 0.5, 0, 0.08, '#3b3127', 1.3, 0.6); c.beginPath(); c.ellipse(0.5, 0, 0.09, 0.1, 0, 0, TAU); c.fill();
    c.fillStyle = 'rgba(0,0,0,0.3)'; dot(c, 0.08, 0, 0.14); c.fillStyle = dome(c, u, 0.06, 0, 0.13, P.base, 1.2, 0.75); dot(c, 0.06, 0, 0.13); edge(c, 'rgba(0,0,0,0.4)', 0.01);
    // носовые спаренные бластеры
    for (var s = -1; s <= 1; s += 2) { tube(c, u, 1.05, s * 0.52, 1.24, s * 0.52, 0.035, '#4a3a2a'); tube(c, u, 1.05, s * 0.6, 1.24, s * 0.6, 0.035, '#4a3a2a'); }
    scorch(c, u, [[0.4, 0.3, 0.16], [-0.7, -0.2, 0.14], [0.9, -0.4, 0.1]]);
  }

  // STAP: узкая платформа с B1, два носовых бластера (по модели — ржаво-рыжая)
  function stap(c, u) {
    var P = { base: '#a6552f', mid: '#7f3f22', line: '#3a1c0e' };
    softShadow(c, u, 1.6, 0.45, 0.2);
    hoverGlow(c, -0.05, 0, 0.35, 0.16, 'rgba(255,170,90,0.35)');
    // платформа
    c.fillStyle = lit(c, u, 0, 0, 0.3, P.base, 1.1, 0.7); poly(c, [[-0.5, -0.07], [-0.2, -0.12], [0.3, -0.1], [0.5, -0.05], [0.5, 0.05], [0.3, 0.1], [-0.2, 0.12], [-0.5, 0.07]]); c.fill(); edge(c, P.line, 0.012);
    // носовые бластеры на вилке
    line(c, 0.3, -0.16, 0.3, 0.16, 0.03, k(P.mid, 0.9));
    tube(c, u, 0.32, -0.16, 0.6, -0.16, 0.03, '#4a3a2a'); tube(c, u, 0.32, 0.16, 0.6, 0.16, 0.03, '#4a3a2a');
    // руль, дроид: плечи и вытянутая голова
    line(c, 0.1, -0.14, 0.1, 0.14, 0.02, '#3a2a1c');
    c.fillStyle = lit(c, u, -0.1, 0, 0.1, '#c99a6c', 1.1, 0.7); rr(c, -0.22, -0.11, 0.2, 0.22, 0.05); c.fill(); edge(c, 'rgba(0,0,0,0.35)', 0.01);
    b1Head(c, u, -0.06, 0, 0.065);
  }

  // Канонерка HMP: тарелка, носовая «голова стервятника», два коротких крыла, кормовые двигатели
  function hmp(c, u) {
    var P = CISW;
    softShadow(c, u, 4, 1.0, 0.85);
    // крылья (S-foils) под углом назад
    c.fillStyle = lit(c, u, -0.3, 0, 0.9, P.mid, 1.05, 0.7);
    poly(c, [[-0.1, -0.45], [-0.55, -1.12], [-0.85, -1.12], [-0.6, -0.5]]); c.fill(); edge(c, P.line, 0.014);
    poly(c, [[-0.1, 0.45], [-0.55, 1.12], [-0.85, 1.12], [-0.6, 0.5]]); c.fill(); edge(c, P.line, 0.014);
    tube(c, u, -0.75, -1.08, -0.35, -1.08, 0.035, '#3f433f'); tube(c, u, -0.75, 1.08, -0.35, 1.08, 0.035, '#3f433f');
    // двигатели сзади
    c.fillStyle = lit(c, u, -0.9, 0, 0.3, P.dark, 1.15, 0.65); rr(c, -1.12, -0.42, 0.4, 0.22, 0.06); c.fill(); rr(c, -1.12, 0.2, 0.4, 0.22, 0.06); c.fill();
    c.fillStyle = 'rgba(120,200,255,0.85)'; c.fillRect(-1.12, -0.38, 0.04, 0.14); c.fillRect(-1.12, 0.24, 0.04, 0.14);
    // тарелка
    c.fillStyle = 'rgba(0,0,0,0.25)'; c.beginPath(); c.ellipse(-0.08, 0.03, 0.78, 0.7, 0, 0, TAU); c.fill();
    c.fillStyle = dome(c, u, -0.1, 0, 0.75, P.base, 1.1, 0.68); c.beginPath(); c.ellipse(-0.1, 0, 0.78, 0.7, 0, 0, TAU); c.fill(); edge(c, P.line, 0.016);
    c.fillStyle = dome(c, u, -0.1, 0, 0.45, P.base, 1.14, 0.8); c.beginPath(); c.ellipse(-0.1, 0, 0.5, 0.44, 0, 0, TAU); c.fill(); edge(c, 'rgba(0,0,0,0.3)');
    // радиальные стыки и маркировка
    for (var a = 0; a < TAU; a += TAU / 8) seam(c, -0.1 + Math.cos(a) * 0.5, Math.sin(a) * 0.44, -0.1 + Math.cos(a) * 0.76, Math.sin(a) * 0.68, 0.01);
    c.fillStyle = P.red; c.beginPath(); c.ellipse(-0.1, 0, 0.78, 0.7, 0, 1.2, 1.7); c.lineTo(-0.1, 0); c.fill(); c.beginPath(); c.ellipse(-0.1, 0, 0.78, 0.7, 0, -1.7, -1.2); c.lineTo(-0.1, 0); c.fill();
    c.fillStyle = dome(c, u, -0.1, 0, 0.22, P.mid, 1.3, 0.7); dot(c, -0.1, 0, 0.22); edge(c, P.line, 0.012);
    c.fillStyle = '#2b2f2b'; dot(c, -0.1, 0, 0.08);
    // голова: вперёд и вниз, с глазами-сенсорами и тяжёлой пушкой под ней
    c.fillStyle = lit(c, u, 0.85, 0, 0.3, P.mid, 1.15, 0.65); poly(c, [[0.55, -0.22], [1.0, -0.18], [1.14, -0.06], [1.14, 0.06], [1.0, 0.18], [0.55, 0.22]]); c.fill(); edge(c, P.line, 0.014);
    c.fillStyle = '#c0282a'; dot(c, 1.0, -0.1, 0.03); dot(c, 1.0, 0.1, 0.03);
    tube(c, u, 0.9, 0, 1.22, 0, 0.04, '#3f433f');
    tube(c, u, 0.7, -0.3, 0.95, -0.3, 0.03, '#3f433f'); tube(c, u, 0.7, 0.3, 0.95, 0.3, 0.03, '#3f433f');
    scorch(c, u, [[-0.3, 0.3, 0.14], [0.2, -0.3, 0.12]]);
  }

  // Паук-дроид ПВО (по модели: белый шар с красным глазом на четырёх длинных ногах, тарелка сверху)
  function spider(c, u) {
    var P = CISW, ph = u.phase || 0, mv = u.mv || 0;
    var _b = body(u);
    if (_b) {
    shadowOf(c, u, 2.2, function() { dot(c, 0, 0, 0.42); });
    // четыре длинные ноги по диагоналям, высокие колени
    for (var i = 0; i < 4; i++) {
      var a = Math.PI / 4 + i * Math.PI / 2, g = i % 2, sw = Math.sin(ph + g * Math.PI) * 0.14 * mv, lift = Math.max(0, Math.cos(ph + g * Math.PI)) * mv;
      var hip = [Math.cos(a) * 0.3, Math.sin(a) * 0.3], knee = [Math.cos(a) * 0.85 + sw * 0.4, Math.sin(a) * 0.85], foot = [Math.cos(a) * 1.08 + sw, Math.sin(a) * 1.08];
      leg(c, u, hip, knee, foot, 0.07, '#c7cac6', lift, 0.07);
    }
    // шар
    c.fillStyle = dome(c, u, 0, 0, 0.42, P.base, 1.15, 0.6); dot(c, 0, 0, 0.42); edge(c, P.line, 0.016);
    seam(c, -0.42, 0, 0.42, 0, 0.012); seam(c, 0, -0.42, 0, 0.42, 0.012);
    c.fillStyle = P.red; c.beginPath(); c.arc(0, 0, 0.42, 2.0, 2.4); c.lineTo(0, 0); c.fill(); c.beginPath(); c.arc(0, 0, 0.42, -2.4, -2.0); c.lineTo(0, 0); c.fill();
    // глаз спереди
    c.fillStyle = '#5a0e0e'; dot(c, 0.33, 0, 0.09); c.fillStyle = '#e63a2e'; dot(c, 0.35, 0, 0.055); c.fillStyle = 'rgba(255,200,200,0.8)'; dot(c, 0.36, -0.02, 0.02);
    // тарелка-излучатель и стволы ПВО сверху
    }
    if (top(u)) {
    var ta = (u.turret == null ? u.ang || 0 : u.turret) - (u.ang || 0);
    c.save(); c.rotate(ta);
    c.fillStyle = dome(c, u, -0.05, 0, 0.16, P.mid, 1.3, 0.7); dot(c, -0.05, 0, 0.16); edge(c, P.line, 0.01);
    c.strokeStyle = 'rgba(0,0,0,0.4)'; c.lineWidth = 0.012; c.beginPath(); c.arc(-0.05, 0, 0.1, 0, TAU); c.stroke();
    tube(c, u, 0.0, -0.05, 0.42, -0.05, 0.035, '#3f433f'); tube(c, u, 0.0, 0.05, 0.42, 0.05, 0.035, '#3f433f');
    c.restore();
    }
    if (_b) {

    scorch(c, u, [[0.1, 0.2, 0.12]]);
    }
  }

  // Ракетный шагоход (по модели: песочный дроид с двумя высокими ракетными пакетами, две ноги)
  function missile(c, u) {
    var P = TF, ph = u.phase || 0, mv = u.mv || 0;
    shadowOf(c, u, 2.0, function() { rr(c, -0.6, -0.55, 1.2, 1.1, 0.3); });
    for (var s = -1; s <= 1; s += 2) {
      var sw = Math.sin(ph + (s > 0 ? 0 : Math.PI)) * 0.18 * mv, lift = Math.max(0, Math.cos(ph + (s > 0 ? 0 : Math.PI))) * mv;
      leg(c, u, [-0.1, s * 0.25], [-0.35 + sw * 0.4, s * 0.62], [0.05 + sw, s * 0.78], 0.09, '#b08a5e', lift, 0.09);
    }
    // корпус: голова-коробка с глазом
    c.fillStyle = lit(c, u, 0.1, 0, 0.5, P.base, 1.1, 0.68); poly(c, [[0.55, -0.22], [0.62, 0], [0.55, 0.22], [0.1, 0.36], [-0.5, 0.3], [-0.5, -0.3], [0.1, -0.36]]); c.fill(); edge(c, P.line, 0.016);
    seam(c, 0.1, -0.36, 0.1, 0.36); c.fillStyle = '#2a1e14'; rr(c, 0.3, -0.1, 0.18, 0.2, 0.04); c.fill(); c.fillStyle = '#e63a2e'; dot(c, 0.4, 0, 0.035);
    // ракетные пакеты по бокам: от головы назад, видны торцы труб решёткой
    for (s = -1; s <= 1; s += 2) {
      c.fillStyle = 'rgba(0,0,0,0.38)'; rr(c, -0.78, s * 0.46 - 0.17 + 0.03, 0.95, 0.34, 0.04); c.fill();
      c.fillStyle = lit(c, u, -0.3, s * 0.46, 0.3, P.mid, 1.15, 0.7); rr(c, -0.82, s * 0.46 - 0.17, 0.95, 0.34, 0.04); c.fill(); edge(c, P.line, 0.014);
      for (var i = 0; i < 5; i++) for (var j = 0; j < 2; j++) {
        var x = -0.72 + i * 0.19, y = s * 0.46 - 0.085 + j * 0.17;
        c.fillStyle = k(P.dark, 0.9); dot(c, x, y, 0.065); c.fillStyle = '#1a1410'; dot(c, x, y, 0.04);
        c.fillStyle = 'rgba(255,255,255,0.18)'; dot(c, x - 0.02, y - 0.02, 0.015);
      }
    }
    scorch(c, u, [[0.0, 0.0, 0.12], [-0.4, 0.4, 0.1]]);
  }

  // Артиллерия КНС (по модели: сине-серый шагающий модуль с длинным стволом, песочные опоры)
  function artCis(c, u) {
    var P = CISB, ph = u.phase || 0, mv = u.mv || 0;
    var _b = body(u);
    if (_b) {
    shadowOf(c, u, 1.6, function() { dot(c, -0.1, 0, 0.55); });
    var hips = [[0.25, -0.35], [-0.45, -0.35], [0.25, 0.35], [-0.45, 0.35]];
    for (var i = 0; i < 4; i++) {
      var s = i < 2 ? -1 : 1, g = i % 2, sw = Math.sin(ph + g * Math.PI) * 0.14 * mv, lift = Math.max(0, Math.cos(ph + g * Math.PI)) * mv;
      leg(c, u, hips[i], [hips[i][0] + sw * 0.5 + (g ? -0.1 : 0.1), s * 0.72], [hips[i][0] + sw + (g ? -0.2 : 0.2), s * 0.96], 0.1, P.tan, lift, 0.09);
    }
    // тело: округлый модуль с песочными панелями
    c.fillStyle = dome(c, u, -0.1, 0, 0.55, P.base, 1.15, 0.6); c.beginPath(); c.ellipse(-0.1, 0, 0.6, 0.5, 0, 0, TAU); c.fill(); edge(c, P.line, 0.016);
    c.fillStyle = lit(c, u, -0.1, 0, 0.4, P.tan, 1.1, 0.75); poly(c, [[-0.65, -0.2], [-0.4, -0.45], [0.1, -0.45], [0.1, -0.25], [-0.45, -0.25]]); c.fill(); edge(c, 'rgba(0,0,0,0.35)');
    poly(c, [[-0.65, 0.2], [-0.4, 0.45], [0.1, 0.45], [0.1, 0.25], [-0.45, 0.25]]); c.fill(); edge(c, 'rgba(0,0,0,0.35)');
    seam(c, 0.1, -0.5, 0.1, 0.5, 0.012);
    c.fillStyle = 'rgba(0,0,0,0.35)'; for (var v = -0.6; v < -0.35; v += 0.08) c.fillRect(v, -0.1, 0.04, 0.2);
    c.fillStyle = '#e63a2e'; dot(c, 0.38, -0.14, 0.03); dot(c, 0.38, 0.14, 0.03);
    // орудие: цапфы, длинный ствол
    }
    if (top(u)) {
    var ta = (u.turret == null ? u.ang || 0 : u.turret) - (u.ang || 0);
    c.save(); c.translate(0.0, 0); c.rotate(ta);
    c.fillStyle = 'rgba(0,0,0,0.35)'; dot(c, 0.02, 0.03, 0.24);
    c.fillStyle = dome(c, u, 0, 0, 0.24, P.mid, 1.3, 0.65); dot(c, 0, 0, 0.24); edge(c, P.line, 0.012);
    c.fillStyle = lit(c, u, 0.1, 0, 0.12, P.dark, 1.2, 0.7); rr(c, -0.1, -0.13, 0.4, 0.26, 0.05); c.fill(); edge(c, P.line, 0.01);
    tube(c, u, 0.2, -0.09, 0.55, -0.09, 0.045, P.tan); tube(c, u, 0.2, 0.09, 0.55, 0.09, 0.045, P.tan);
    cannon(c, u, 0.1, 0, 1.28, 0, 0.1, '#3a4652');
    c.fillStyle = '#2a333d'; rr(c, 1.05, -0.08, 0.15, 0.16, 0.03); c.fill();
    c.restore();
    }
    if (_b) {

    scorch(c, u, [[-0.3, 0.2, 0.14], [0.2, -0.3, 0.1]]);
    }
  }

  // ---------------------------------------------------------------- набор
  // size — клеток по стороне; h — высота (для тени); walk — есть ли анимация шага/качения
  // k — во сколько раз рисунок крупнее своих «чертёжных» единиц: масштаб к пехотинцу
  // (клетка ≈ 2,5 м; боец ≈ 0,8 клетки): AT-TE 13 м, AAT 10 м, LAAT 17 м, MTT и турботанк
  // в игре ограничены шестью клетками, чтобы влезать на дороги и мосты.
  var TYPES = {
    rep_atte:      { name: 'AT-TE',               draw: atte,    size: 2, walk: true,  turret: true, span: 2.5, k: 1.8 },
    rep_atrt:      { name: 'AT-RT',               draw: atrt,    size: 1, walk: true,  span: 1.3, k: 1.3 },
    rep_barc:      { name: 'Спидер BARC',         draw: barc,    size: 1, walk: false, span: 1.3, k: 1.4 },
    rep_laat:      { name: 'Канонерка LAAT',      draw: laat,    size: 2, walk: false, span: 2.5, k: 2.0 },
    rep_turbo:     { name: 'Турботанк HAVw A6',   draw: turbo,   size: 2, walk: true,  turret: true, span: 2.6, k: 2.3 },
    rep_aa:        { name: 'Зенитный танк TX-130', draw: tx130,  size: 2, walk: false, turret: true, span: 2.4, k: 1.35 },
    rep_artillery: { name: 'Артиллерия SPHA',     draw: sphaRep, size: 2, walk: true,  turret: true, span: 2.6, k: 2.1 },
    cis_aat:       { name: 'Танк AAT',            draw: aat,     size: 2, walk: false, turret: true, span: 2.5, k: 1.45 },
    cis_mtt:       { name: 'Транспорт MTT',       draw: mtt,     size: 2, walk: false, span: 2.6, k: 2.3 },
    cis_stap:      { name: 'Спидер STAP',         draw: stap,    size: 1, walk: false, span: 1.3, k: 1.15 },
    cis_hmp:       { name: 'Канонерка HMP',       draw: hmp,     size: 2, walk: false, span: 2.5, k: 1.8 },
    cis_spider:    { name: 'Паук-дроид ПВО',      draw: spider,  size: 2, walk: true,  turret: true, span: 2.4, k: 1.35 },
    cis_missile:   { name: 'Ракетный шагоход',    draw: missile, size: 2, walk: true,  span: 2.0, k: 1.6 },
    cis_artillery: { name: 'Артиллерия КНС',      draw: artCis,  size: 2, walk: true,  turret: true, span: 2.6, k: 1.55 }
  };
  // span — чертёжный размах; в клетках поля машина занимает span × k
  Object.keys(TYPES).forEach(function(id) { var T = TYPES[id]; T.span0 = T.span; T.span = +(T.span * T.k).toFixed(2); });

  // Нарисовать машину: контекст уже в клетках поля, центр машины — (0, 0).
  // u.part: 'body' — только корпус (для набора картинок), 'turret' — только башня (рисуется
  // живьём поверх картинки, со своим углом u.turret), иначе — всё.
  function draw(c, id, u) {
    var T = TYPES[id]; if (!T) return false;
    if (u.part === 'turret' && !T.turret) return true;
    c.save(); c.rotate(u.ang || 0); c.scale(T.k, T.k); c.lineCap = 'round'; c.lineJoin = 'round';
    T.draw(c, u);
    c.restore();
    return true;
  }
  function body(u) { return u.part !== 'turret'; }
  function top(u) { return u.part !== 'body'; }

  // Набор картинок: у каждой машины свой холст (курс × кадр; кадр 0 — стоит, 1..FRAMES-1 — шаг;
  // у машин без шага — только кадр 0). cell — желаемых точек на клетку поля; у крупных
  // машин плотность ниже, чтобы картинка не превышала maxPx точек по стороне.
  var DIRS = 16, FRAMES = 8, TDIRS = 32;
  function bake(ids, cell, maxPx) {
    maxPx = maxPx || 160;
    var out = { dirs: DIRS, frames: FRAMES, by: {}, ids: ids, cell: cell };
    ids.forEach(function(id) {
      var T = TYPES[id], frames = T.walk ? FRAMES : 1, ppc = Math.min(cell, maxPx / (T.span + 0.3)), px = Math.ceil(ppc * (T.span + 0.3)), cols = 8;
      var cv = document.createElement('canvas');
      cv.width = cols * px; cv.height = Math.ceil(DIRS * frames / cols) * px;
      var c = cv.getContext('2d');
      for (var d = 0; d < DIRS; d++) for (var f = 0; f < frames; f++) {
        var idx = d * frames + f;
        c.save();
        c.translate((idx % cols) * px + px / 2, Math.floor(idx / cols) * px + px / 2);
        c.scale(ppc, ppc);
        draw(c, id, { ang: d / DIRS * TAU, mv: f === 0 ? 0 : 1, phase: f === 0 ? 0 : (f - 1) * (TAU / (FRAMES - 1)), part: 'body' });
        c.restore();
      }
      var ent = { canvas: cv, px: px, ppc: ppc, cols: cols, frames: frames, span: px / ppc };
      if (T.turret) {
        // башня — отдельным листом по TDIRS курсам (угол башни абсолютный)
        var tv = document.createElement('canvas'); tv.width = cols * px; tv.height = Math.ceil(TDIRS / cols) * px;
        var tc = tv.getContext('2d');
        for (var k = 0; k < TDIRS; k++) {
          tc.save(); tc.translate((k % cols) * px + px / 2, Math.floor(k / cols) * px + px / 2); tc.scale(ppc, ppc);
          draw(tc, id, { ang: 0, turret: k / TDIRS * TAU, part: 'turret' });
          tc.restore();
        }
        ent.tur = tv;
      }
      out.by[id] = ent;
    });
    return out;
  }

  root.SWVehicles = { TYPES: TYPES, draw: draw, bake: bake, DIRS: DIRS, FRAMES: FRAMES, TDIRS: TDIRS };
})(typeof self !== 'undefined' ? self : this);
