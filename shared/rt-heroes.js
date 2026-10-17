// Герои сверху для боя 2.0: джедаи Республики и ситхи КНС — по портретам из игры
// (assets/units/heroes): джедаи в коричнево-песочных одеждах с плащом, клинки
// синие, зелёные или лиловые; ситхи в чёрном с капюшоном или в броне, клинки красные.
//
// Рисуются живьём каждый кадр (героев в бою единицы), в масштабе фигурок бойцов
// (rt-figures: радиус тела ~0.34 клетки). Нос по +x, центр (0, 0).
//
// u: { aim — куда смотрит, legs — куда идут ноги, mv 0..1, phase — шаг,
//      act — поза (ниже), k — ход позы 0..1, blade — цвет клинка, cloak — плащ,
//      hood — капюшон, armor — броня (ситхи), hair — цвет волос, skin — цвет кожи }
// Позы под способности из игры (hero_abilities):
//   idle      — стойка, меч у бедра;        run     — бег, меч назад;
//   slash     — удар: клинок проходит дугу перед собой (бой в ближнем ряду, «Ярость», «Форма боя»);
//   deflect   — «Отражение выстрелов»: клинок крутится перед грудью;
//   push      — «Толчок Силы», «Телекинетический бросок»: обе руки вперёд;
//   throw     — «Бросок светового меча», «Клинок-палач»: рука вперёд, клинок летит отдельно (fx.blade);
//   dash      — «Стремительный выпад», «Бросок хищника»: наклон вперёд, шлейф;
//   lightning — «Удар молниями»: обе руки вперёд, молнии (fx.lightning);
//   choke     — «Удушение», «Вытягивание жизни»: одна рука вперёд, сжата;
//   mind      — «Внушение», «Порабощение», «Умиротворение», «Волна страха»: рука у виска, кольцо (fx.ring);
//   heal      — «Исцеление Силой», «Медитация»: на колене, ладони вниз, мягкий свет;
//   barrier   — «Защитный купол»: руки вверх, купол (fx.dome).
// fx.* — эффекты в мировых координатах, которые бой рисует поверх всех.
// Только браузер (canvas), ES5.

(function(root) {
  'use strict';

  var TAU = Math.PI * 2;
  function dot(c, x, y, r) { c.beginPath(); c.arc(x, y, r, 0, TAU); c.fill(); }
  function line(c, x0, y0, x1, y1) { c.beginPath(); c.moveTo(x0, y0); c.lineTo(x1, y1); c.stroke(); }
  function clamp(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function ease(t) { t = clamp(t); return t * t * (3 - 2 * t); }

  // Цвета клинков — по портретам (jedi_NN / sith_NN из hero_portraits)
  var BLADE = { blue: '#4aa8ff', green: '#5cf06a', purple: '#b56cff', red: '#ff3b2f', yellow: '#ffd84a' };
  var PORTRAIT_BLADE = { jedi_01: 'blue', jedi_02: 'blue', jedi_03: 'purple', jedi_04: 'blue', jedi_05: 'green', jedi_06: 'purple',
                         jedi_07: 'blue', jedi_08: 'green', jedi_09: 'green', jedi_10: 'green', jedi_11: 'green' };
  var JEDI = { robe: '#8c6a46', robe2: '#6a4e33', tunic: '#cdbb98', belt: '#4a3524', cloak: '#5f4630', hilt: '#9aa3ad' };
  var SITH = { robe: '#1d1b20', robe2: '#0f0e12', tunic: '#2b2830', belt: '#15131a', cloak: '#141217', hilt: '#6a6f78', armor: '#3a3d45', trim: '#7a2a2a' };

  // Облик по портрету и стороне
  function look(faction, portrait) {
    var sith = faction === 'cis';
    var n = parseInt((portrait || '').slice(-2), 10) || 1;
    return {
      sith: sith, P: sith ? SITH : JEDI,
      blade: BLADE[sith ? 'red' : (PORTRAIT_BLADE[portrait] || 'blue')],
      cloak: sith ? true : (n % 3 !== 1), hood: sith ? (n % 2 === 1) : false, armor: sith ? (n % 3 === 2) : false,
      hair: sith ? '#111' : ['#2b1d12', '#3a2a1a', '#1e1a16', '#5a3b22'][n % 4], skin: sith && n === 1 ? '#c7542b' : '#d9b48f',
      female: !sith && (n === 1 || n === 5 || n === 11)
    };
  }

  // ---------------------------------------------------------------- части
  // Световой меч: рукоять (hx, hy) → клинок длиной L под углом a. glow — яркость свечения
  function saber(c, hx, hy, a, L, col, hilt, glow, w) {
    w = w || 0.045; glow = glow == null ? 1 : glow;
    var ex = hx + Math.cos(a) * L, ey = hy + Math.sin(a) * L;
    c.lineCap = 'round';
    // рукоять
    c.strokeStyle = hilt; c.lineWidth = w * 1.4; line(c, hx - Math.cos(a) * 0.09, hy - Math.sin(a) * 0.09, hx + Math.cos(a) * 0.03, hy + Math.sin(a) * 0.03);
    c.strokeStyle = 'rgba(0,0,0,0.5)'; c.lineWidth = w * 0.5; line(c, hx - Math.cos(a) * 0.06, hy - Math.sin(a) * 0.06, hx - Math.cos(a) * 0.02, hy - Math.sin(a) * 0.02);
    if (L <= 0) return;
    // свечение в три слоя и белая сердцевина
    c.save(); c.globalCompositeOperation = 'lighter';
    c.strokeStyle = col; c.globalAlpha = 0.18 * glow; c.lineWidth = w * 5; line(c, hx, hy, ex, ey);
    c.globalAlpha = 0.45 * glow; c.lineWidth = w * 2.4; line(c, hx, hy, ex, ey);
    c.restore();
    c.strokeStyle = col; c.lineWidth = w * 1.3; line(c, hx, hy, ex, ey);
    c.strokeStyle = '#ffffff'; c.lineWidth = w * 0.55; line(c, hx, hy, ex, ey);
  }
  // след клинка: дуга от угла a0 до a1 вокруг (cx, cy), затухающая
  function trail(c, cx, cy, r0, r1, a0, a1, col, alpha) {
    c.save(); c.globalCompositeOperation = 'lighter';
    var n = 10;
    for (var i = 0; i < n; i++) {
      var t0 = i / n, t1 = (i + 1) / n, b0 = a0 + (a1 - a0) * t0, b1 = a0 + (a1 - a0) * t1;
      var ccw = a1 < a0;
      c.beginPath(); c.arc(cx, cy, r1, b0, b1, ccw); c.arc(cx, cy, r0, b1, b0, !ccw); c.closePath();
      c.fillStyle = col; c.globalAlpha = alpha * t1 * t1 * 0.55; c.fill();
    }
    c.restore();
  }
  function legs(c, u, P, st) {
    var ph = u.phase || 0, mv = u.mv || 0, idle = 1 - mv;
    c.save(); c.rotate(u.legs == null ? u.aim || 0 : u.legs); c.lineCap = 'round';
    for (var s = -1; s <= 1; s += 2) {
      var fx = Math.sin(ph + (s > 0 ? 0 : Math.PI)) * st * mv + idle * s * 0.02;
      c.strokeStyle = P.robe2; c.lineWidth = 0.08; line(c, 0, s * 0.07, fx, s * 0.085);
      c.fillStyle = '#2a211a'; c.beginPath(); c.ellipse(fx + 0.03, s * 0.085, 0.065, 0.038, 0, 0, TAU); c.fill();
    }
    c.restore();
  }
  // тело: плащ (если есть) → туника → пояс → плечи
  function torso(c, u, L, lean, sway) {
    var P = L.P, mv = u.mv || 0, ph = u.phase || 0;
    if (L.cloak) {
      // плащ развевается назад при беге
      var fl = 0.1 + mv * 0.16, wob = Math.sin(ph * 2) * 0.03 * mv;
      c.fillStyle = P.cloak;
      c.beginPath(); c.moveTo(0.05, -0.24); c.quadraticCurveTo(-0.3 - fl, -0.3 + wob, -0.36 - fl * 1.6, -0.1 + wob);
      c.quadraticCurveTo(-0.42 - fl * 1.6, 0.0, -0.36 - fl * 1.6, 0.1 - wob); c.quadraticCurveTo(-0.3 - fl, 0.3 - wob, 0.05, 0.24); c.closePath(); c.fill();
      c.strokeStyle = 'rgba(0,0,0,0.35)'; c.lineWidth = 0.012; c.stroke();
    }
    // туника/робы: овал, чуть вытянут по ходу
    var g = c.createRadialGradient(-0.06, -0.08, 0.02, 0, 0, 0.3);
    g.addColorStop(0, L.sith ? '#3a3742' : '#e4d6b8'); g.addColorStop(1, P.tunic);
    c.fillStyle = g; c.beginPath(); c.ellipse(lean, 0, 0.26, 0.21, 0, 0, TAU); c.fill();
    c.strokeStyle = 'rgba(0,0,0,0.4)'; c.lineWidth = 0.012; c.stroke();
    // наплечники/рукава тёмной робы
    c.fillStyle = P.robe; c.beginPath(); c.ellipse(lean - 0.06, -0.17, 0.11, 0.07, -0.3, 0, TAU); c.fill(); c.beginPath(); c.ellipse(lean - 0.06, 0.17, 0.11, 0.07, 0.3, 0, TAU); c.fill();
    if (L.armor) { c.fillStyle = SITH.armor; c.beginPath(); c.ellipse(lean, 0, 0.2, 0.15, 0, 0, TAU); c.fill(); c.strokeStyle = SITH.trim; c.lineWidth = 0.014; c.stroke(); c.strokeStyle = 'rgba(0,0,0,0.5)'; line(c, lean - 0.1, 0, lean + 0.15, 0); }
    else { c.strokeStyle = 'rgba(0,0,0,0.35)'; c.lineWidth = 0.014; line(c, lean - 0.1, -0.06, lean + 0.2, -0.02); line(c, lean - 0.1, 0.06, lean + 0.2, 0.02); }
    // пояс
    c.strokeStyle = P.belt; c.lineWidth = 0.05; line(c, lean - 0.03, -0.2, lean - 0.03, 0.2);
    c.fillStyle = L.sith ? '#9a9aa0' : '#c9a24a'; c.fillRect(lean - 0.05, -0.025, 0.045, 0.05);
  }
  function head(c, u, L, x, y) {
    c.fillStyle = 'rgba(0,0,0,0.35)'; dot(c, x + 0.012, y + 0.015, 0.11);
    if (L.hood) {
      var g = c.createRadialGradient(x - 0.04, y - 0.04, 0.01, x, y, 0.13);
      g.addColorStop(0, '#34313a'); g.addColorStop(1, '#0e0d11');
      c.fillStyle = g; c.beginPath(); c.ellipse(x - 0.01, y, 0.13, 0.115, 0, 0, TAU); c.fill();
      c.fillStyle = '#0a0a0d'; c.beginPath(); c.ellipse(x + 0.04, y, 0.06, 0.07, 0, 0, TAU); c.fill();
      c.fillStyle = L.skin; dot(c, x + 0.06, y, 0.035);
      return;
    }
    // волосы сверху, лицо спереди
    var hg = c.createRadialGradient(x - 0.03, y - 0.03, 0.01, x, y, 0.11);
    hg.addColorStop(0, L.hair); hg.addColorStop(1, '#000');
    c.fillStyle = hg; dot(c, x, y, 0.105);
    c.fillStyle = L.skin; c.beginPath(); c.ellipse(x + 0.06, y, 0.05, 0.075, 0, 0, TAU); c.fill();
    if (L.female) { c.fillStyle = L.hair; c.beginPath(); c.ellipse(x - 0.08, y, 0.05, 0.04, 0, 0, TAU); c.fill(); }
  }
  // рука: от плеча (sx, sy) к кисти (hx, hy)
  function arm(c, L, sx, sy, hx, hy) {
    c.lineCap = 'round';
    c.strokeStyle = L.P.robe; c.lineWidth = 0.075; line(c, sx, sy, hx, hy);
    c.fillStyle = L.sith && L.armor ? '#2a2a30' : L.skin; dot(c, hx, hy, 0.038);
  }

  // ---------------------------------------------------------------- позы
  function draw(c, u) {
    var L = u.look || look(u.faction, u.portrait), P = L.P, act = u.act || (u.mv ? 'run' : 'idle'), k = u.k == null ? 0 : u.k;
    var aim = u.aim || 0, col = u.blade || L.blade;
    c.save();
    // тень
    var g = c.createRadialGradient(0.05, 0.07, 0, 0.05, 0.07, 0.4);
    g.addColorStop(0, 'rgba(0,0,0,0.5)'); g.addColorStop(0.6, 'rgba(0,0,0,0.25)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = g; dot(c, 0.05, 0.07, 0.4);
    legs(c, u, P, act === 'run' || act === 'dash' ? 0.2 : 0.14);
    c.rotate(aim);
    var lean = act === 'dash' ? 0.1 : act === 'run' ? 0.05 : act === 'heal' ? -0.04 : 0;
    // шлейф рывка — за спиной
    if (act === 'dash') { c.save(); c.globalCompositeOperation = 'lighter'; for (var i = 1; i <= 4; i++) { c.globalAlpha = 0.14 * (1 - i / 5); c.fillStyle = col; c.beginPath(); c.ellipse(-0.25 * i, 0, 0.26, 0.2, 0, 0, TAU); c.fill(); } c.restore(); }
    torso(c, u, L, lean);
    var sL = [lean - 0.04, -0.2], sR = [lean - 0.04, 0.2];          // плечи: левое (−y), правое (+y)
    var hilt = P.hilt, bl = 0.62;
    if (act === 'idle') {
      arm(c, L, sL[0], sL[1], lean + 0.08, -0.26);
      arm(c, L, sR[0], sR[1], lean + 0.12, 0.24);
      saber(c, lean + 0.14, 0.25, 0.35 + Math.sin((u.phase || 0) * 0.5) * 0.05, bl, col, hilt, 1);
    } else if (act === 'run') {
      arm(c, L, sL[0], sL[1], lean + 0.2, -0.22);
      arm(c, L, sR[0], sR[1], lean - 0.1, 0.26);
      saber(c, lean - 0.1, 0.28, Math.PI - 0.5, bl, col, hilt, 1);
    } else if (act === 'slash') {
      // клинок от правого плеча через перед к левому: −1.6 → +1.4 рад за k
      var a0 = 1.5, a1 = -1.5, a = a0 + (a1 - a0) * ease(k);
      var hx = lean + 0.22 + Math.cos(a) * 0.1, hy = Math.sin(a) * 0.12;
      if (k > 0.15) trail(c, lean + 0.2, 0, 0.1, bl + 0.1, a0 + (a1 - a0) * ease(Math.max(0, k - 0.3)), a, col, 0.9);
      arm(c, L, sL[0], sL[1], hx - 0.05, hy - 0.05);
      arm(c, L, sR[0], sR[1], hx, hy);
      saber(c, hx, hy, a, bl, col, hilt, 1.2);
    } else if (act === 'deflect') {
      var spin = (u.phase || 0) * 7 + k * 20, r = 0.22;
      arm(c, L, sL[0], sL[1], lean + 0.2, -0.14);
      arm(c, L, sR[0], sR[1], lean + 0.22, 0.12);
      c.save(); c.globalCompositeOperation = 'lighter'; c.globalAlpha = 0.12; c.fillStyle = col; c.beginPath(); c.arc(lean + 0.3, 0, bl * 0.55, -1.9, 1.9); c.lineTo(lean + 0.3, 0); c.fill(); c.restore();
      saber(c, lean + 0.3, 0, spin, bl * 0.55, col, hilt, 1.1, 0.04);
      saber(c, lean + 0.3, 0, spin + Math.PI, bl * 0.55, col, hilt, 1.1, 0.04);
    } else if (act === 'push' || act === 'lightning') {
      arm(c, L, sL[0], sL[1], lean + 0.34, -0.1);
      arm(c, L, sR[0], sR[1], lean + 0.34, 0.1);
      saber(c, lean - 0.06, 0.24, Math.PI - 0.3, act === 'push' ? 0 : 0, col, hilt, 1);     // меч на поясе
      if (act === 'push') {
        var pr = 0.2 + k * 1.4;
        c.save(); c.globalCompositeOperation = 'lighter'; c.strokeStyle = 'rgba(200,225,255,' + (0.6 * (1 - k)) + ')'; c.lineWidth = 0.08 * (1 - k * 0.6);
        c.beginPath(); c.arc(lean + 0.2, 0, pr, -0.7, 0.7); c.stroke(); c.lineWidth = 0.04; c.beginPath(); c.arc(lean + 0.2, 0, pr * 0.7, -0.8, 0.8); c.stroke(); c.restore();
      }
    } else if (act === 'throw') {
      arm(c, L, sL[0], sL[1], lean + 0.1, -0.24);
      arm(c, L, sR[0], sR[1], lean + 0.36, 0.06);
      // клинок уже в полёте (fx.blade), в руке пусто
    } else if (act === 'dash') {
      arm(c, L, sL[0], sL[1], lean + 0.26, -0.2);
      arm(c, L, sR[0], sR[1], lean + 0.1, 0.28);
      saber(c, lean + 0.1, 0.3, -0.2, bl, col, hilt, 1.3);
    } else if (act === 'choke') {
      arm(c, L, sL[0], sL[1], lean + 0.0, -0.26);
      arm(c, L, sR[0], sR[1], lean + 0.36, 0.0);
      c.fillStyle = L.skin; dot(c, lean + 0.37, 0, 0.045);
      c.strokeStyle = 'rgba(0,0,0,0.5)'; c.lineWidth = 0.012; for (var f = -1; f <= 1; f++) line(c, lean + 0.35, f * 0.025, lean + 0.4, f * 0.03);
      saber(c, lean - 0.06, 0.24, Math.PI - 0.3, 0, col, hilt, 1);
    } else if (act === 'mind') {
      arm(c, L, sL[0], sL[1], lean + 0.12, -0.1);         // рука у виска
      arm(c, L, sR[0], sR[1], lean + 0.3, 0.14);
      saber(c, lean - 0.06, 0.24, Math.PI - 0.3, 0, col, hilt, 1);
    } else if (act === 'heal') {
      arm(c, L, sL[0], sL[1], lean + 0.22, -0.16);
      arm(c, L, sR[0], sR[1], lean + 0.22, 0.16);
      saber(c, lean - 0.06, 0.24, Math.PI - 0.3, 0, col, hilt, 1);
      c.save(); c.globalCompositeOperation = 'lighter'; var hg = c.createRadialGradient(lean + 0.25, 0, 0, lean + 0.25, 0, 0.45);
      hg.addColorStop(0, 'rgba(180,255,210,' + (0.35 + 0.25 * Math.sin(k * TAU)) + ')'); hg.addColorStop(1, 'rgba(180,255,210,0)'); c.fillStyle = hg; dot(c, lean + 0.25, 0, 0.45); c.restore();
    } else if (act === 'barrier') {
      arm(c, L, sL[0], sL[1], lean + 0.1, -0.32);
      arm(c, L, sR[0], sR[1], lean + 0.1, 0.32);
      saber(c, lean - 0.06, 0.24, Math.PI - 0.3, 0, col, hilt, 1);
    }
    head(c, u, L, lean + 0.02, 0);
    c.restore();
  }

  // ---------------------------------------------------------------- эффекты (мировые координаты, единица — клетка)
  var fx = {
    // летящий клинок: крутится, с шлейфом; (x, y) — где сейчас, t — время
    blade: function(c, x, y, t, col) {
      var a = t * 18;
      trail(c, x, y, 0.05, 0.42, a - 2.2, a, col, 0.6);
      saber(c, x, y, a, 0.4, col, '#9aa3ad', 1.2, 0.04);
      saber(c, x, y, a + Math.PI, 0.4, col, '#9aa3ad', 1.2, 0.04);
    },
    // молния от (x0, y0) к (x1, y1): ломаная с ветками, seed — чтобы дрожала
    lightning: function(c, x0, y0, x1, y1, seed, alpha) {
      alpha = alpha == null ? 1 : alpha;
      var s = (seed * 9301 + 49297) % 233280, rnd = function() { s = (s * 9301 + 49297) % 233280; return s / 233280; };
      var pts = [[x0, y0]], n = 9, dx = x1 - x0, dy = y1 - y0, L = Math.sqrt(dx * dx + dy * dy) || 1, nx = -dy / L, ny = dx / L;
      for (var i = 1; i < n; i++) { var f = i / n, off = (rnd() - 0.5) * 0.5 * Math.sin(f * Math.PI); pts.push([x0 + dx * f + nx * off, y0 + dy * f + ny * off]); }
      pts.push([x1, y1]);
      c.save(); c.globalCompositeOperation = 'lighter'; c.lineCap = 'round'; c.lineJoin = 'round';
      [[0.16, 'rgba(120,80,255,' + 0.35 * alpha + ')'], [0.06, 'rgba(190,160,255,' + 0.9 * alpha + ')'], [0.025, 'rgba(255,255,255,' + alpha + ')']].forEach(function(w) {
        c.strokeStyle = w[1]; c.lineWidth = w[0]; c.beginPath(); pts.forEach(function(p, i) { if (i) c.lineTo(p[0], p[1]); else c.moveTo(p[0], p[1]); }); c.stroke();
      });
      // ветки
      c.strokeStyle = 'rgba(200,170,255,' + 0.6 * alpha + ')'; c.lineWidth = 0.03;
      for (var b = 2; b < n - 1; b += 3) { var p = pts[b]; c.beginPath(); c.moveTo(p[0], p[1]); c.lineTo(p[0] + (rnd() - 0.5) * 0.5, p[1] + (rnd() - 0.5) * 0.5); c.stroke(); }
      c.restore();
    },
    // кольцо воздействия на разум / страха: расходящееся
    ring: function(c, x, y, k, col) {
      c.save(); c.globalCompositeOperation = 'lighter'; c.strokeStyle = col || 'rgba(255,230,160,1)'; c.globalAlpha = 0.8 * (1 - k); c.lineWidth = 0.06;
      c.beginPath(); c.arc(x, y, 0.3 + k * 2.5, 0, TAU); c.stroke(); c.globalAlpha = 0.4 * (1 - k); c.beginPath(); c.arc(x, y, 0.2 + k * 1.6, 0, TAU); c.stroke(); c.restore();
    },
    // купол: радиус r, пульсирует
    dome: function(c, x, y, r, t) {
      var g = c.createRadialGradient(x, y, r * 0.5, x, y, r);
      g.addColorStop(0, 'rgba(120,200,255,0.05)'); g.addColorStop(0.85, 'rgba(120,200,255,0.18)'); g.addColorStop(1, 'rgba(180,230,255,0.5)');
      c.save(); c.globalCompositeOperation = 'lighter'; c.fillStyle = g; dot(c, x, y, r);
      c.strokeStyle = 'rgba(200,240,255,' + (0.5 + 0.3 * Math.sin(t * 4)) + ')'; c.lineWidth = 0.04; c.beginPath(); c.arc(x, y, r, 0, TAU); c.stroke(); c.restore();
    },
    // волна толчка: от (x, y) по углу a, k 0..1
    wave: function(c, x, y, a, k) {
      c.save(); c.translate(x, y); c.rotate(a); c.globalCompositeOperation = 'lighter';
      c.strokeStyle = 'rgba(200,225,255,' + 0.7 * (1 - k) + ')'; c.lineWidth = 0.1 * (1 - k * 0.5);
      c.beginPath(); c.arc(0, 0, 0.3 + k * 2.2, -0.8, 0.8); c.stroke(); c.restore();
    },
    // удушение: тёмные нити к цели
    choke: function(c, x0, y0, x1, y1, t) {
      c.save(); c.globalCompositeOperation = 'multiply'; c.strokeStyle = 'rgba(60,0,80,0.55)'; c.lineWidth = 0.05; c.lineCap = 'round';
      for (var i = 0; i < 3; i++) { var o = Math.sin(t * 6 + i * 2) * 0.12; c.beginPath(); c.moveTo(x0, y0); c.quadraticCurveTo((x0 + x1) / 2 + o, (y0 + y1) / 2 - o, x1, y1); c.stroke(); }
      c.restore();
      c.save(); c.strokeStyle = 'rgba(140,40,200,' + (0.5 + 0.3 * Math.sin(t * 9)) + ')'; c.lineWidth = 0.05; c.beginPath(); c.arc(x1, y1, 0.3, 0, TAU); c.stroke(); c.restore();
    },
    // вытягивание жизни: красные искры от цели к ситху
    drain: function(c, x0, y0, x1, y1, t) {
      c.save(); c.globalCompositeOperation = 'lighter'; c.fillStyle = 'rgba(255,60,60,0.9)';
      for (var i = 0; i < 8; i++) { var f = ((t * 0.8 + i / 8) % 1), px = x1 + (x0 - x1) * f, py = y1 + (y0 - y1) * f + Math.sin(f * 9 + i) * 0.12; dot(c, px, py, 0.04 * (1 - f * 0.5)); }
      c.restore();
    }
  };

  var ACTS = ['idle', 'run', 'slash', 'deflect', 'push', 'throw', 'dash', 'lightning', 'choke', 'mind', 'heal', 'barrier'];
  // какая поза у какой способности из игры
  var ABILITY_ACT = { throw_light: 'throw', throw_dark: 'throw', dash_light: 'dash', dash_dark: 'dash', push_light: 'push', push_dark: 'push',
                      lightning_dark: 'lightning', choke_dark: 'choke', drain_dark: 'choke', fear_dark: 'mind', mind_enslave: 'mind', mind_suasion: 'mind',
                      pacify_light: 'mind', heal_light: 'heal', hp_light: 'heal', barrier_light: 'barrier', deflect_light: 'deflect' };

  root.SWHeroes = { draw: draw, look: look, fx: fx, BLADE: BLADE, ACTS: ACTS, ABILITY_ACT: ABILITY_ACT, rad: 0.34 };
})(typeof self !== 'undefined' ? self : this);
