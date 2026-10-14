// Космический бой 2.0 — прототип в браузере.
// Расчёт — shared/rt-space.js (корабли, пушки, щиты, малые корабли) и
// shared/rt-crew.js (экипаж, пожары, ремонт внутри каждого корабля).
// Снаружи: корабли — те же спрайты, что на карте, в честном масштабе.
// Внутри: тот же разрез, что в «Кораблях 2.0», с огнём, поломками и людьми.
// ES5, без сборки.

(function() {
  'use strict';

  var S = window.SWRT, F = window.SWRTFig, SH = window.SWShip, SP = window.SWSpace, ART = window.ShipArt;
  var K = SH.K, TAU = Math.PI * 2, CH = 32;
  var $ = function(id) { return document.getElementById(id); };

  var SCEN = {
    vp:  { name: 'Венатор × Провиденс', ships: [['venator', 0, 0, 0], ['providence', 1, 9000, 1400]] },
    am:  { name: 'Акламатор × Щедрый', ships: [['acclamator', 0, 0, 0], ['munificent', 1, 8500, -1000]] },
    '2x2': { name: 'Два на два', ships: [['venator', 0, 0, -1300], ['acclamator', 0, -600, 1500], ['providence', 1, 9500, -900], ['munificent', 1, 9000, 1800]] }
  };
  var SIDE_NAME = ['Республика', 'КНС'];
  var COL = { 0: { bolt: '#8fd0ff', core: '#e6f6ff', ui: '#4a90d9' }, 1: { bolt: '#ff6a55', core: '#ffe2d8', ui: '#d94a4a' } };

  var G = {
    B: null, scen: 'vp', side: 0, sel: -1, foe: -1, gsel: {}, mode: 'space', aim: false, move: false,
    plans: {}, imgs: {}, craftImg: {}, fx: { shots: [], booms: [], shields: [] }, ended: false, follow: true, room: null
  };
  var CV = $('sp-canvas'), CTX = CV.getContext('2d');
  var CAM = { x: 0, y: 0, s: 0.03, vw: 0, vh: 0, dpr: 1 };      // снаружи: пикселей на метр
  var ICAM = { x: 0, y: 0, s: 6 };                                // внутри: пикселей на клетку

  // ---------------------------------------------------------------- загрузка
  function loadImg(src) {
    return new Promise(function(res, rej) {
      var im = new Image(); im.onload = function() { res(im); }; im.onerror = function() { rej(new Error('нет картинки ' + src)); }; im.src = src;
    });
  }
  function loadPlan(id) {
    if (G.plans[id]) return Promise.resolve(G.plans[id]);
    return fetch('../shared/ships/' + id + '.json?v=3').then(function(r) {
      if (!r.ok) throw new Error('план ' + id + ' не найден'); return r.json();
    }).then(function(d) {
      var p = SH.load(d);
      return loadImg('../' + p.sprite).then(function(im) { G.imgs[id] = im; G.plans[id] = p; return p; });
    });
  }
  function loadCraft() {
    return Promise.all(['arc170', 'ywing', 'vulture', 'hyena'].map(function(id) {
      return loadImg('../assets/ships/' + id + '.png').then(function(im) { G.craftImg[id] = im; }, function() {});
    }));
  }

  var START = 0;
  function start(scen, side) {
    var token = ++START;
    G.scen = scen; G.side = side;
    var sc = SCEN[scen];
    toast('Готовлю бой: ' + sc.name + '…', 'gold');
    var ids = []; sc.ships.forEach(function(s) { if (ids.indexOf(s[0]) < 0) ids.push(s[0]); });
    Promise.all(ids.map(loadPlan).concat([loadCraft()])).then(function() {
      if (token !== START) return;            // уже нажали другой бой
      var B = new SP.Battle({ seed: 1977 + Date.now() % 1000 });
      sc.ships.forEach(function(s) {
        var plan = G.plans[s[0]], rep = plan.faction === 'republic';
        var figs = rep ? [S.TYPE_BY_ID.rep_dc15a, S.TYPE_BY_ID.rep_heavy] : [S.TYPE_BY_ID.cis_b1, S.TYPE_BY_ID.cis_b1, S.TYPE_BY_ID.cis_b2];
        // каждый бой — свежий экипаж: план копируется не нужно, состояние живёт в Crew
        B.addShip({ cls: s[0], plan: plan, side: s[1], x: s[2], y: s[3], hd: s[1] === 0 ? 0 : Math.PI, figs: figs });
      });
      G.who = null;
      G.B = B; G.fx = { shots: [], booms: [], shields: [] }; G.ended = false; G.gsel = {}; G.aim = false; G.move = false; G.room = null;
      G.sel = -1; G.foe = -1;
      for (var i = 0; i < B.ships.length; i++) if (B.ships[i].side === G.side) { G.sel = i; break; }
      for (i = 0; i < B.ships.length; i++) if (B.ships[i].side !== G.side) { G.foe = i; break; }
      CHUNKS.clear(); TIER_N = { 4: 0, 8: 0, 16: 0, 32: 0 };
      setMode('space');
      buildFleet(); buildShipPanel(); hud(); fitAll();
      $('sp-end').hidden = true;
      $('sp-top').classList.toggle('cis', G.side === 1);
      $('sp-side').textContent = SIDE_NAME[G.side];
      var chips = document.querySelectorAll('#sp-scen .sp-chip');
      for (i = 0; i < chips.length; i++) chips[i].classList.toggle('on', chips[i].getAttribute('data-scen') === scen);
      try { localStorage.setItem('sp-scen', scen); localStorage.setItem('sp-side', String(side)); } catch (e) {}
      toast('Бой начался. Выбери пушки и цель', 'gold');
    }).catch(function(e) { toast('Не загрузилось: ' + e.message, 'bad'); });
  }

  // ---------------------------------------------------------------- камера
  function resize() {
    CAM.dpr = Math.min(window.devicePixelRatio || 1, 2);
    CAM.vw = window.innerWidth; CAM.vh = window.innerHeight;
    CV.width = Math.round(CAM.vw * CAM.dpr); CV.height = Math.round(CAM.vh * CAM.dpr);
    CV.style.width = CAM.vw + 'px'; CV.style.height = CAM.vh + 'px';
  }
  function view() {
    // свободная часть экрана между панелями
    var top = $('sp-top').getBoundingClientRect().bottom + 6, bot = $('sp-bottom').getBoundingClientRect().top - 6;
    if (bot - top < 120) { top = 0; bot = CAM.vh; }
    return { top: top, bot: bot, cy: (top + bot) / 2, h: bot - top };
  }
  function toS(x, y) { return [(x - CAM.x) * CAM.s + CAM.vw / 2, (y - CAM.y) * CAM.s + CAM.vh / 2]; }
  function toW(px, py) { return [(px - CAM.vw / 2) / CAM.s + CAM.x, (py - CAM.vh / 2) / CAM.s + CAM.y]; }
  // Рамка на все живые корабли; snap — сразу, иначе плавно (камера «Обзор» ведёт бой)
  function fitAll(snap) {
    var B = G.B; if (!B) return;
    G.follow = 'all';
    var f = fitRect(); if (!f) return;
    if (snap !== false) { CAM.s = f.s; CAM.x = f.x; CAM.y = f.y; }
  }
  function fitRect() {
    var B = G.B;
    var x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    B.ships.forEach(function(s) { if (s.dead) return; x0 = Math.min(x0, s.x - s.len / 2); x1 = Math.max(x1, s.x + s.len / 2); y0 = Math.min(y0, s.y - s.len / 2); y1 = Math.max(y1, s.y + s.len / 2); });
    if (x0 > x1) return null;
    var v = view(), m = 900;
    var s = Math.min((CAM.vw - 30) / (x1 - x0 + m), (v.h - 30) / (y1 - y0 + m));
    s = Math.max(0.012, Math.min(0.25, s));
    return { s: s, x: (x0 + x1) / 2, y: (y0 + y1) / 2 - (v.cy - CAM.vh / 2) / s };
  }
  function focusShip(sh, scale) {
    var v = view();
    CAM.s = scale || Math.max(CAM.s, Math.min(0.5, (Math.min(CAM.vw, v.h) * 0.8) / sh.len));
    CAM.x = sh.x; CAM.y = sh.y - (v.cy - CAM.vh / 2) / CAM.s;
  }
  // внутри
  function itoS(x, y) { return [(x - ICAM.x) * ICAM.s + CAM.vw / 2, (y - ICAM.y) * ICAM.s + CAM.vh / 2]; }
  function itoW(px, py) { return [(px - CAM.vw / 2) / ICAM.s + ICAM.x, (py - CAM.vh / 2) / ICAM.s + ICAM.y]; }

  // ---------------------------------------------------------------- кадр
  var FR = { last: 0, fps: 60, acc: 0, hud: 0 };
  function frame(t) {
    requestAnimationFrame(frame);
    var dt = FR.last ? Math.min(0.1, (t - FR.last) / 1000) : 0.016;
    FR.fps = FR.fps * 0.95 + (1 / Math.max(0.001, dt)) * 0.05; FR.last = t;
    var B = G.B; if (!B) return;
    if (!G.ended) B.step(dt);
    takeFx();
    if (G.mode === 'space' && G.follow === 'ship' && G.sel >= 0) {
      var sh = B.ships[G.sel];
      if (sh && !sh.dead) { var v = view(); CAM.x += (sh.x - CAM.x) * Math.min(1, dt * 3); CAM.y += (sh.y - (v.cy - CAM.vh / 2) / CAM.s - CAM.y) * Math.min(1, dt * 3); }
    } else if (G.mode === 'space' && G.follow === 'all') {
      var f = fitRect(), k = Math.min(1, dt * 1.5);
      if (f) { CAM.s = Math.exp(Math.log(CAM.s) + (Math.log(f.s) - Math.log(CAM.s)) * k); CAM.x += (f.x - CAM.x) * k; CAM.y += (f.y - CAM.y) * k; }
    }
    if (G.mode === 'inside' && (!B.ships[G.sel] || B.ships[G.sel].dead)) setMode('space');
    if (G.mode === 'inside') drawInside(t / 1000); else drawSpace(t / 1000);
    FR.hud += dt;
    if (FR.hud > 0.25) { FR.hud = 0; hud(); $('sp-fps').textContent = Math.round(FR.fps); }
    if (B.over >= 0 && !G.ended) endBattle();
  }
  function now() { return G.B.t + (G.B.acc || 0); }

  // События расчёта → эффекты с временем жизни
  function takeFx() {
    var e = G.B.takeEvents(), fx = G.fx, i;
    for (i = 0; i < e.shots.length; i++) fx.shots.push(e.shots[i]);
    for (i = 0; i < e.booms.length; i++) fx.booms.push(e.booms[i]);
    for (i = 0; i < e.shields.length; i++) {
      fx.shields.push(e.shields[i]);
      var sh = G.B.ships[e.shields[i].ship];
      if (e.shields[i].down && sh && sh.side === G.side) toast(sh.name + ': упал щит — ' + ['нос', 'правый борт', 'корма', 'левый борт'][e.shields[i].s], 'bad');
    }
    for (i = 0; i < e.kills.length; i++) {
      var k = e.kills[i];
      if (k.ship != null) {
        var s = G.B.ships[k.ship];
        toast(s.name + ' уничтожен' + (k.why === 'reactor' ? ' — взрыв реактора' : ''), s.side === G.side ? 'bad' : 'gold');
        if (k.ship === G.foe) { G.aim = false; G.foe = -1; }
        if (k.ship === G.sel) {
          // свой погиб — управление переходит к живому кораблю флота
          var next = G.B.ships.filter(function(x) { return !x.dead && x.side === G.side; })[0];
          if (next) { if (G.mode === 'inside') setMode('space'); selectShip(next.n); }
        }
        buildTargets(); hud();
      }
    }
    var t = now();
    fx.shots = fx.shots.filter(function(s) { return t - s.t0 < s.dur + (s.miss ? 1.2 : 0.15); });
    fx.booms = fx.booms.filter(function(b) { return t - b.t0 < (b.big ? 3 : 0.9); });
    fx.shields = fx.shields.filter(function(b) { return t - b.t0 < 0.7; });
    if (fx.shots.length > 600) fx.shots.splice(0, fx.shots.length - 600);
  }

  // ---------------------------------------------------------------- космос
  function drawSpace(T) {
    var c = CTX, B = G.B, s = CAM.s, i;
    c.setTransform(CAM.dpr, 0, 0, CAM.dpr, 0, 0);
    c.clearRect(0, 0, CAM.vw, CAM.vh);
    drawGrid(c);
    // корабли
    for (i = 0; i < B.ships.length; i++) drawShip(c, B.ships[i], T);
    // цели выбранного корабля
    if (G.sel >= 0) drawAims(c, B.ships[G.sel], T);
    // отсеки на схеме — в режиме прицела
    if (G.aim && G.foe >= 0) drawRooms(c, B.ships[G.foe], T);
    // малые корабли
    for (i = 0; i < B.craft.length; i++) drawCraft(c, B.craft[i]);
    // болты, щиты, взрывы
    drawShots(c);
    drawShields(c, T);
    drawBooms(c);
    // отметка касания
    if (G.mark) {
      var mk = (performance.now() - G.mark.t) / 600;
      if (mk < 1) { var mp = toS(G.mark.x, G.mark.y); c.strokeStyle = 'rgba(217,169,64,' + (1 - mk) + ')'; c.lineWidth = 2; c.beginPath(); c.arc(mp[0], mp[1], 6 + mk * 22, 0, TAU); c.stroke(); }
      else G.mark = null;
    }
    // точка хода
    if (G.sel >= 0) {
      var me = B.ships[G.sel];
      if (me && me.order && !me.dead) {
        var p = toS(me.order.x, me.order.y), q = toS(me.x, me.y);
        c.strokeStyle = 'rgba(217,169,64,0.55)'; c.setLineDash([5, 5]); c.lineWidth = 1;
        c.beginPath(); c.moveTo(q[0], q[1]); c.lineTo(p[0], p[1]); c.stroke(); c.setLineDash([]);
        c.strokeStyle = '#d9a940'; c.beginPath(); c.arc(p[0], p[1], 7 + Math.sin(T * 5) * 1.5, 0, TAU); c.stroke();
        if (me.order.face) {
          var ang = Math.atan2(p[1] - q[1], p[0] - q[0]);
          c.fillStyle = '#d9a940'; c.beginPath();
          c.moveTo(p[0] + Math.cos(ang) * 12, p[1] + Math.sin(ang) * 12);
          c.lineTo(p[0] + Math.cos(ang + 2.5) * 8, p[1] + Math.sin(ang + 2.5) * 8);
          c.lineTo(p[0] + Math.cos(ang - 2.5) * 8, p[1] + Math.sin(ang - 2.5) * 8); c.closePath(); c.fill();
        }
      }
    }
  }
  // Сетка — чтобы было видно движение и масштаб (1 км)
  function drawGrid(c) {
    var step = 1000, s = CAM.s;
    if (step * s < 26) step = 5000;
    var a = toW(0, 0), b = toW(CAM.vw, CAM.vh);
    c.strokeStyle = 'rgba(80,110,140,0.09)'; c.lineWidth = 1;
    c.beginPath();
    for (var x = Math.floor(a[0] / step) * step; x <= b[0]; x += step) { var p = toS(x, 0)[0]; c.moveTo(p, 0); c.lineTo(p, CAM.vh); }
    for (var y = Math.floor(a[1] / step) * step; y <= b[1]; y += step) { var q = toS(0, y)[1]; c.moveTo(0, q); c.lineTo(CAM.vw, q); }
    c.stroke();
    // мерная линейка
    var L = step * s, v = view();
    c.fillStyle = 'rgba(143,168,196,0.6)'; c.font = '9px "Courier New", monospace'; c.textAlign = 'left'; c.textBaseline = 'bottom';
    c.fillRect(12, v.bot - 10, L, 1); c.fillText(step / 1000 + ' км', 12, v.bot - 12);
  }

  function drawShip(c, sh, T) {
    var p = sh.plan, img = G.imgs[sh.cls], s = CAM.s, W = p.w * p.cellM, H = p.h * p.cellM, cr = p.crop;
    var q = toS(sh.x, sh.y);
    if (q[0] < -sh.len * s || q[0] > CAM.vw + sh.len * s || q[1] < -sh.len * s || q[1] > CAM.vh + sh.len * s) return;
    var dead = sh.dead, fade = dead ? Math.max(0, 1 - (now() - sh.deadAt) / 2.5) : 1;
    if (fade <= 0) return;
    c.save();
    c.translate(q[0], q[1]); c.rotate(sh.hd + Math.PI / 2); c.scale(s, s);
    c.globalAlpha = fade;
    // свечение двигателей
    if (!dead && sh.v > 3) {
      c.globalCompositeOperation = 'lighter';
      var eng = Math.min(1, sh.v / sh.vmax) * (0.4 + 0.6 * sh.eff.engine);
      var gcol = sh.side === 0 ? '120,190,255' : '255,150,90';
      var g = c.createRadialGradient(0, H / 2, 0, 0, H / 2, W * 0.45);
      g.addColorStop(0, 'rgba(' + gcol + ',' + (0.55 * eng) + ')'); g.addColorStop(1, 'rgba(' + gcol + ',0)');
      c.fillStyle = g; c.fillRect(-W * 0.5, H * 0.3, W, W * 0.6);
      c.globalCompositeOperation = 'source-over';
    }
    c.drawImage(img, cr[0], cr[1], cr[2] - cr[0], cr[3] - cr[1], -W / 2, -H / 2, W, H);
    // пожары видно снаружи
    var fires = sh.crew.burning, n = fires.length;
    if (n && !dead) {
      c.globalCompositeOperation = 'lighter';
      var step = Math.max(1, Math.floor(n / 90)), rr = Math.max(5, 2.2 / s);
      for (var i = 0; i < n; i += step) {
        var k = fires[i], fx = k % p.w, fy = (k - fx) / p.w, v = sh.crew.fire[k] / 100;
        var fl = 0.6 + 0.4 * Math.sin(T * 13 + k);
        c.fillStyle = 'rgba(255,' + Math.round(120 + 80 * fl) + ',40,' + (0.16 + 0.3 * v * fl) + ')';
        c.beginPath(); c.arc((fx + 0.5 - p.w / 2) * p.cellM, (fy + 0.5 - p.h / 2) * p.cellM, rr * (0.7 + v), 0, TAU); c.fill();
      }
      c.globalCompositeOperation = 'source-over';
    }
    // выбранный — рамка; цель — красный уголок
    c.globalAlpha = 1;
    var mark = sh.n === G.sel ? '#d9a940' : sh.n === G.foe ? (sh.side === G.side ? null : 'rgba(255,110,90,0.8)') : null;
    if (mark && !dead) {
      c.strokeStyle = mark; c.lineWidth = 1.5 / s;
      var m = 30, x0 = -W / 2 - m, y0 = -H / 2 - m, x1 = W / 2 + m, y1 = H / 2 + m, L = Math.min(W, H) * 0.22;
      c.beginPath();
      c.moveTo(x0, y0 + L); c.lineTo(x0, y0); c.lineTo(x0 + L, y0);
      c.moveTo(x1 - L, y0); c.lineTo(x1, y0); c.lineTo(x1, y0 + L);
      c.moveTo(x1, y1 - L); c.lineTo(x1, y1); c.lineTo(x1 - L, y1);
      c.moveTo(x0 + L, y1); c.lineTo(x0, y1); c.lineTo(x0, y1 - L);
      c.stroke();
    }
    c.restore();
    // подпись и полоски — только если корабль мелкий на экране
    if (!dead) {
      var lab = toS(sh.x, sh.y + sh.len * 0.55);
      if (sh.len * s < 140) {
        c.font = '10px "Courier New", monospace'; c.textAlign = 'center'; c.textBaseline = 'top';
        c.fillStyle = sh.side === G.side ? '#cfe3ff' : '#ffd0cc';
        c.fillText(sh.name + (sh.crit ? ' ⚠' : ''), lab[0], lab[1] + 4);
        bar(c, lab[0] - 22, lab[1] + 17, 44, sh.hull / sh.hullMax, '#5fd968');
        var shs = (sh.sh[0] + sh.sh[1] + sh.sh[2] + sh.sh[3]) / (4 * sh.shMax);
        bar(c, lab[0] - 22, lab[1] + 21, 44, shs, '#6fb8ff');
      }
    }
  }
  function bar(c, x, y, w, f, col) {
    c.fillStyle = 'rgba(20,26,34,0.9)'; c.fillRect(x, y, w, 2.5);
    c.fillStyle = col; c.fillRect(x, y, w * Math.max(0, Math.min(1, f)), 2.5);
  }

  // Орудия выбранного корабля и куда они бьют
  function drawAims(c, sh, T) {
    if (!sh || sh.dead) return;
    var B = G.B, s = CAM.s;
    for (var i = 0; i < sh.guns.length; i++) {
      var g = sh.guns[i], p = toS(g.x, g.y), on = !!G.gsel[i];
      var col = g.out ? '#ff8a5c' : g.aimAt ? '#d9a940' : 'rgba(143,168,196,0.7)';
      if (g.aimAt && (on || s > 0.12)) {
        var tx, ty;
        if (g.aimAt.craft) { tx = g.aimAt.craft.x; ty = g.aimAt.craft.y; }
        else {
          var r = g.aimAt.room && g.aimAt.ship.plan.roomByN[g.aimAt.room];
          var w = r ? B.toWorld(g.aimAt.ship, r.cx, r.cy) : [g.aimAt.ship.x, g.aimAt.ship.y];
          tx = w[0]; ty = w[1];
        }
        var q = toS(tx, ty);
        c.strokeStyle = on ? 'rgba(217,169,64,0.6)' : 'rgba(217,169,64,0.18)'; c.lineWidth = 1;
        c.setLineDash([3, 6]); c.lineDashOffset = -T * 20;
        c.beginPath(); c.moveTo(p[0], p[1]); c.lineTo(q[0], q[1]); c.stroke(); c.setLineDash([]);
        if (on && !g.aimAt.craft && g.aimAt.room) outlineRoom(c, g.aimAt.ship, g.aimAt.ship.plan.roomByN[g.aimAt.room], 'rgba(217,169,64,0.9)', T);
      }
      if (s > 0.05 || on) {
        c.strokeStyle = col; c.lineWidth = on ? 2 : 1.2;
        c.beginPath(); c.arc(p[0], p[1], on ? 5 : g.t === 'pd' ? 2.5 : 3.5, 0, TAU); c.stroke();
      }
    }
  }
  function roomPoly(sh, r) {
    var B = G.B, pts = [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]];
    return pts.map(function(p) { var w = B.toWorld(sh, p[0], p[1]); return toS(w[0], w[1]); });
  }
  function outlineRoom(c, sh, r, col, T) {
    if (!r) return;
    var pts = roomPoly(sh, r);
    c.strokeStyle = col; c.lineWidth = 1.5; c.setLineDash([4, 3]); c.lineDashOffset = -T * 14;
    c.beginPath(); c.moveTo(pts[0][0], pts[0][1]); for (var i = 1; i < 4; i++) c.lineTo(pts[i][0], pts[i][1]); c.closePath(); c.stroke();
    c.setLineDash([]);
  }
  // Режим прицела: все отсеки врага, системы подписаны
  function drawRooms(c, sh, T) {
    if (!sh || sh.dead) return;
    var rooms = sh.plan.rooms, s = CAM.s;
    for (var i = 0; i < rooms.length; i++) {
      var r = rooms[i], sys = sysOf(r.t);
      if (!sys && r.auto) continue;
      var pts = roomPoly(sh, r), st = sh.crew.rooms[r.n];
      c.fillStyle = sys ? 'rgba(217,169,64,0.10)' : 'rgba(143,168,196,0.06)';
      c.strokeStyle = sys ? 'rgba(217,169,64,0.55)' : 'rgba(143,168,196,0.25)'; c.lineWidth = 1;
      c.beginPath(); c.moveTo(pts[0][0], pts[0][1]); for (var k = 1; k < 4; k++) c.lineTo(pts[k][0], pts[k][1]); c.closePath(); c.fill(); c.stroke();
      if (st && st.integ < 99) {
        var cx = (pts[0][0] + pts[2][0]) / 2, cy = (pts[0][1] + pts[2][1]) / 2;
        c.fillStyle = st.integ < 30 ? '#ff8a5c' : '#e8d9a8'; c.font = '9px "Courier New", monospace'; c.textAlign = 'center'; c.textBaseline = 'middle';
        if (r.w * sh.plan.cellM * s > 26) c.fillText(Math.round(st.integ) + '%', cx, cy);
      }
    }
  }
  function sysOf(t) { for (var i = 0; i < SP.SYS.length; i++) if (SP.SYS[i].types.indexOf(t) >= 0) return SP.SYS[i]; return null; }

  function drawCraft(c, cr) {
    if (cr.dead) return;
    var img = G.craftImg[cr.img], p = toS(cr.x, cr.y);
    if (p[0] < -20 || p[1] < -20 || p[0] > CAM.vw + 20 || p[1] > CAM.vh + 20) return;
    var size = Math.max(cr.role === 'bomber' ? 15 : 12, cr.len * CAM.s * 1.6);
    c.save(); c.translate(p[0], p[1]); c.rotate(cr.hd + Math.PI / 2);
    // метка стороны под картинкой: малые корабли мелкие, свой/чужой должно быть видно
    c.fillStyle = cr.side === 0 ? 'rgba(74,144,217,0.28)' : 'rgba(217,74,74,0.28)';
    c.beginPath(); c.arc(0, 0, size * 0.62, 0, TAU); c.fill();
    if (img) c.drawImage(img, -size / 2, -size / 2, size, size);
    c.restore();
  }

  function drawShots(c) {
    var t = now(), s = CAM.s, fx = G.fx.shots;
    c.save(); c.globalCompositeOperation = 'lighter'; c.lineCap = 'round';
    for (var i = 0; i < fx.length; i++) {
      var b = fx[i], k = (t - b.t0) / Math.max(0.05, b.dur);
      if (k < 0) continue;
      var dx = b.x1 - b.x0, dy = b.y1 - b.y0, L = Math.sqrt(dx * dx + dy * dy) || 1;
      if (k > 1 && !b.miss) continue;
      var tail = (b.t === 'pd' || b.t === 'f') ? 60 : b.t === 'b' ? 30 : 220;
      var hx = b.x0 + dx * k, hy = b.y0 + dy * k, tk = Math.max(0, k - tail / L);
      var p = toS(hx, hy), q = toS(b.x0 + dx * tk, b.y0 + dy * tk);
      if ((p[0] < -50 && q[0] < -50) || (p[0] > CAM.vw + 50 && q[0] > CAM.vw + 50) || (p[1] < -50 && q[1] < -50) || (p[1] > CAM.vh + 50 && q[1] > CAM.vh + 50)) continue;
      var col = COL[b.side] || COL[0];
      var w = b.t === 'heavy' || b.t === 'long' ? 2.4 : b.t === 'ion' ? 3 : b.t === 'medium' ? 1.8 : 1.1;
      if (b.t === 'ion') col = { bolt: '#7fe8ff', core: '#f0ffff' };
      if (b.t === 'b') col = { bolt: '#ffb060', core: '#fff0d0' };
      var fade = k > 1 ? Math.max(0, 1 - (k - 1) * 1.5) : 1;
      c.globalAlpha = 0.55 * fade; c.strokeStyle = col.bolt; c.lineWidth = w * 2.2;
      c.beginPath(); c.moveTo(q[0], q[1]); c.lineTo(p[0], p[1]); c.stroke();
      c.globalAlpha = fade; c.strokeStyle = col.core; c.lineWidth = Math.max(0.8, w * 0.6);
      c.beginPath(); c.moveTo(q[0], q[1]); c.lineTo(p[0], p[1]); c.stroke();
    }
    c.restore();
  }
  function drawShields(c, T) {
    var t = now(), B = G.B, s = CAM.s;
    var list = G.fx.shields;
    for (var i = 0; i < list.length; i++) {
      var e = list[i], sh = B.ships[e.ship]; if (!sh || sh.dead) continue;
      var k = (t - e.t0) / 0.7; if (k < 0 || k > 1) continue;
      shieldArc(c, sh, e.s, (1 - k) * (e.down ? 1 : 0.8), e.down ? '#ff8a5c' : '#9fd8ff', sh.sh[e.s] / sh.shMax);
      // вспышка в точке удара о щит
      var p = toS(e.x, e.y);
      c.save(); c.globalCompositeOperation = 'lighter'; c.globalAlpha = (1 - k) * 0.8;
      c.fillStyle = '#bfe6ff'; c.beginPath(); c.arc(p[0], p[1], Math.max(2, 26 * s) * (0.6 + k), 0, TAU); c.fill(); c.restore();
    }
    // постоянные щиты выбранного и цели — тонко, по силе сектора
    [G.sel, G.foe].forEach(function(n) {
      var sh = n >= 0 && B.ships[n]; if (!sh || sh.dead || sh.len * s < 40) return;
      for (var q = 0; q < 4; q++) shieldArc(c, sh, q, 0.25, sh.sh[q] > 0 ? '#6fb8ff' : '#ff8a5c', sh.sh[q] / sh.shMax);
    });
  }
  function shieldArc(c, sh, sec, alpha, col, strength) {
    var p = toS(sh.x, sh.y), s = CAM.s, rx = (sh.wid / 2 + 70) * s, ry = (sh.len / 2 + 70) * s;
    var mid = [-Math.PI / 2, 0, Math.PI / 2, Math.PI][sec];
    c.save(); c.translate(p[0], p[1]); c.rotate(sh.hd + Math.PI / 2);
    c.globalAlpha = alpha; c.strokeStyle = col; c.lineWidth = 1 + 2.5 * Math.max(0, strength);
    c.beginPath(); c.ellipse(0, 0, rx, ry, 0, mid - Math.PI / 4 + 0.06, mid + Math.PI / 4 - 0.06); c.stroke();
    c.restore();
  }
  function drawBooms(c) {
    var t = now(), s = CAM.s, list = G.fx.booms;
    c.save(); c.globalCompositeOperation = 'lighter';
    for (var i = 0; i < list.length; i++) {
      var b = list[i], life = b.big ? 3 : 0.9, k = (t - b.t0) / life; if (k < 0 || k > 1) continue;
      var p = toS(b.x, b.y), r = Math.max(b.big ? 30 : b.craft ? 4 : 3, b.r * s) * (0.4 + k * (b.big ? 1.6 : 1));
      var g = c.createRadialGradient(p[0], p[1], 0, p[0], p[1], r);
      var a = (1 - k);
      if (b.ion) { g.addColorStop(0, 'rgba(220,250,255,' + a + ')'); g.addColorStop(0.4, 'rgba(120,220,255,' + a * 0.6 + ')'); g.addColorStop(1, 'rgba(60,160,255,0)'); }
      else { g.addColorStop(0, 'rgba(255,245,210,' + a + ')'); g.addColorStop(0.35, 'rgba(255,170,70,' + a * 0.7 + ')'); g.addColorStop(1, 'rgba(255,80,30,0)'); }
      c.fillStyle = g; c.beginPath(); c.arc(p[0], p[1], r, 0, TAU); c.fill();
    }
    c.restore();
  }

  // ---------------------------------------------------------------- внутри
  var CHUNKS = new Map(), CLIPS = {}, BUILD = { left: 2 }, CHUNK_MAX = { 4: 260, 8: 64, 16: 20, 32: 10 }, TIER_N = { 4: 0, 8: 0, 16: 0, 32: 0 };
  function tierFor(s) { return s < 5 ? 4 : s < 12 ? 8 : s < 26 ? 16 : 32; }
  function makeClip(sh, img) {
    var cw = sh.crop[2] - sh.crop[0], chh = sh.crop[3] - sh.crop[1];
    var m = document.createElement('canvas'); m.width = sh.w; m.height = sh.h;
    var mc = m.getContext('2d'), id = mc.createImageData(sh.w, sh.h), d = id.data;
    for (var i = 0, n = sh.w * sh.h; i < n; i++) {
      var k = sh.kind[i];
      if (k !== K.VOID && k !== K.HULL) { d[i * 4] = 58; d[i * 4 + 1] = 61; d[i * 4 + 2] = 66; d[i * 4 + 3] = 255; }
    }
    mc.putImageData(id, 0, 0);
    var cv = document.createElement('canvas'); cv.width = cw; cv.height = chh;
    var c = cv.getContext('2d'); c.drawImage(m, 0, 0, cw, chh);
    c.drawImage(img, sh.crop[0], sh.crop[1], cw, chh, 0, 0, cw, chh);
    return cv;
  }
  var ARTV = { ship: null, pal: null, clip: null, craft: null };
  function chunk(sh, cx, cy, tp) {
    var key = sh.cls + ':' + tp + ':' + cx + ':' + cy, ch = CHUNKS.get(key);
    if (ch) { CHUNKS.delete(key); CHUNKS.set(key, ch); return ch; }
    if (BUILD.left <= 0) {
      // бюджет кадра исчерпан: взять готовый кусок другого яруса или пропустить кадр
      return CHUNKS.get(sh.cls + ':8:' + cx + ':' + cy) || CHUNKS.get(sh.cls + ':4:' + cx + ':' + cy) ||
             CHUNKS.get(sh.cls + ':16:' + cx + ':' + cy) || null;
    }
    BUILD.left--;
    var p = sh.plan;
    if (!CLIPS[sh.cls]) CLIPS[sh.cls] = makeClip(p, G.imgs[sh.cls]);
    ARTV.ship = p; ARTV.pal = ART.PAL[p.faction] || ART.PAL.republic; ARTV.clip = CLIPS[sh.cls]; ARTV.craft = G.craftImg;
    ART.init(ARTV, K);
    ch = ART.chunk(cx, cy, tp);
    CHUNKS.set(key, ch); TIER_N[tp]++;
    // вытеснение по ярусу: старые куски этого же яруса
    if (TIER_N[tp] > CHUNK_MAX[tp]) {
      for (var k of CHUNKS.keys()) { if (CHUNKS.get(k).tp === tp) { CHUNKS.delete(k); TIER_N[tp]--; break; } }
    }
    return ch;
  }

  // Эффекты внутри: взрывы попаданий, выстрелы своих орудий, копоть, тряска
  var IN = { ship: -1, bt: -1, gt: -1, blasts: [], guns: [], scorch: [], shake: 0 };
  function innerFx(sh) {
    var cr = sh.crew, t = cr.t, i;
    if (IN.ship !== sh.n) { IN = { ship: sh.n, bt: t, gt: t, blasts: [], guns: [], scorch: [], shake: 0 }; return; }
    var bl = cr.ev.blasts, gn = cr.ev.guns;
    for (i = 0; i < bl.length; i++) if (bl[i].t > IN.bt) {
      IN.blasts.push({ x: bl[i].x, y: bl[i].y, r: bl[i].r, t: bl[i].t });
      if (Math.abs(bl[i].x - ICAM.x) * ICAM.s < CAM.vw && Math.abs(bl[i].y - ICAM.y) * ICAM.s < CAM.vh) IN.shake = Math.max(IN.shake, 0.45);
    }
    for (i = 0; i < gn.length; i++) if (gn[i].t > IN.gt) {
      IN.guns.push({ n: gn[i].n, t: gn[i].t });
      var gr = sh.plan.roomByN[gn[i].n];
      if (gr && Math.abs(gr.cx - ICAM.x) * ICAM.s < CAM.vw / 2 && Math.abs(gr.cy - ICAM.y) * ICAM.s < CAM.vh / 2) IN.shake = Math.max(IN.shake, 0.15);
    }
    if (bl.length) IN.bt = bl[bl.length - 1].t;
    if (gn.length) IN.gt = gn[gn.length - 1].t;
    IN.blasts = IN.blasts.filter(function(b) { return t - b.t < 0.9; });
    IN.guns = IN.guns.filter(function(g) { return t - g.t < 0.35; });
  }

  function drawInside(T) {
    var c = CTX, B = G.B, sh = B.ships[G.sel];
    c.setTransform(CAM.dpr, 0, 0, CAM.dpr, 0, 0);
    c.clearRect(0, 0, CAM.vw, CAM.vh);
    if (!sh) return;
    innerFx(sh);
    // тряска от попаданий рядом
    var sx0 = ICAM.x, sy0 = ICAM.y;
    if (IN.shake > 0) {
      IN.shake = Math.max(0, IN.shake - 1 / 60);
      var amp = IN.shake * 6 / ICAM.s;
      ICAM.x += (Math.random() - 0.5) * amp; ICAM.y += (Math.random() - 0.5) * amp;
    }
    drawInside2(c, sh, T);
    ICAM.x = sx0; ICAM.y = sy0;
  }
  function drawInside2(c, sh, T) {
    var s = ICAM.s;
    var p = sh.plan;
    // весь корабль на экране — разрез одной картинкой (кусками было бы сотни сборок)
    if (s < 2.6) {
      if (!CLIPS[sh.cls]) CLIPS[sh.cls] = makeClip(p, G.imgs[sh.cls]);
      var o0 = itoS(0, 0);
      c.drawImage(CLIPS[sh.cls], o0[0], o0[1], p.w * s, p.h * s);
      c.globalCompositeOperation = 'source-atop';
      c.fillStyle = 'rgba(28,32,38,0.55)'; c.fillRect(o0[0], o0[1], p.w * s, p.h * s);
      c.globalCompositeOperation = 'source-over';
      roomsFlat(c, sh, s);
    } else {
    BUILD.left = s >= 12 ? 1 : 2;
    var tp = tierFor(s * CAM.dpr / 1.2);
    var a = itoW(0, 0), b = itoW(CAM.vw, CAM.vh);
    var cw = Math.ceil(p.w / CH), chh = Math.ceil(p.h / CH);
    var cx0 = Math.max(0, Math.floor(a[0] / CH)), cy0 = Math.max(0, Math.floor(a[1] / CH));
    var cx1 = Math.min(cw - 1, Math.floor(b[0] / CH)), cy1 = Math.min(chh - 1, Math.floor(b[1] / CH));
    c.imageSmoothingEnabled = !(tp >= 16 && s >= tp * 1.2);
    for (var cy = cy0; cy <= cy1; cy++) for (var cx = cx0; cx <= cx1; cx++) {
      var ch = chunk(sh, cx, cy, tp), q = itoS(cx * CH, cy * CH);
      if (ch) c.drawImage(ch.cv, Math.floor(q[0]), Math.floor(q[1]), Math.ceil(CH * s) + 1, Math.ceil(CH * s) + 1);
    }
    c.imageSmoothingEnabled = true;
    }
    // поломки: красный налёт по целости, ионный удар — голубые искры
    var cr = sh.crew;
    for (var i = 0; i < cr.roomList.length; i++) {
      var st = cr.roomList[i], r = st.r;
      var o = itoS(r.x, r.y);
      if (o[0] > CAM.vw || o[1] > CAM.vh || o[0] + r.w * s < 0 || o[1] + r.h * s < 0) continue;
      if (st.integ < 98) { c.fillStyle = 'rgba(160,30,20,' + ((1 - st.integ / 100) * 0.32) + ')'; c.fillRect(o[0], o[1], r.w * s, r.h * s); }
      if (st.stun > 0) {
        c.save(); c.globalCompositeOperation = 'lighter';
        for (var z = 0; z < 6; z++) {
          var zx = r.x + ((Math.sin(T * 7.3 + z * 12.1 + r.n) + 1) / 2) * r.w, zy = r.y + ((Math.cos(T * 5.1 + z * 7.7 + r.n) + 1) / 2) * r.h, zq = itoS(zx, zy);
          c.fillStyle = 'rgba(140,230,255,' + (0.35 + 0.35 * Math.sin(T * 30 + z)) + ')';
          c.beginPath(); c.arc(zq[0], zq[1], Math.max(1.5, s * 0.5), 0, TAU); c.fill();
        }
        c.restore();
      }
      if (G.room === r) {
        c.strokeStyle = 'rgba(240,200,106,' + (0.65 + 0.3 * Math.sin(T * 4)) + ')'; c.lineWidth = 2;
        c.setLineDash([6, 4]); c.lineDashOffset = -T * 16; c.strokeRect(o[0], o[1], r.w * s, r.h * s); c.setLineDash([]);
      }
    }
    // огонь
    drawScorch(c, sh);
    drawGunFlash(c, sh, T);
    drawFire(c, sh, T);
    // люди и их дела
    drawCrew(c, sh, T);
    drawBlasts(c, sh);
    drawAlarm(c, sh, T);
    // подписи: имя, целость, огонь
    drawLabels(c, sh);
  }
  function drawScorch(c, sh) {
    var s = ICAM.s, list = sh.crew.scorch;
    for (var i = 0; i < list.length; i++) {
      var q = list[i], p = itoS(q.x, q.y), r = q.r * s;
      if (p[0] < -r || p[1] < -r || p[0] > CAM.vw + r || p[1] > CAM.vh + r) continue;
      var g = c.createRadialGradient(p[0], p[1], 0, p[0], p[1], r);
      g.addColorStop(0, 'rgba(12,10,8,0.6)'); g.addColorStop(0.6, 'rgba(20,16,12,0.3)'); g.addColorStop(1, 'rgba(20,16,12,0)');
      c.fillStyle = g; c.beginPath(); c.arc(p[0], p[1], r, 0, TAU); c.fill();
      // трещины
      if (s > 6) {
        c.strokeStyle = 'rgba(8,6,4,0.55)'; c.lineWidth = Math.max(1, s * 0.08);
        c.beginPath();
        for (var k = 0; k < 5; k++) { var a = q.a + k * 1.26; c.moveTo(p[0], p[1]); c.lineTo(p[0] + Math.cos(a) * r * 0.9, p[1] + Math.sin(a) * r * 0.9); }
        c.stroke();
      }
    }
  }
  // Выстрел своей пушки: вспышка у погона башни и отсвет по отсеку
  function drawGunFlash(c, sh, T) {
    var t = sh.crew.t, s = ICAM.s;
    c.save(); c.globalCompositeOperation = 'lighter';
    for (var i = 0; i < IN.guns.length; i++) {
      var g = IN.guns[i], r = sh.plan.roomByN[g.n]; if (!r) continue;
      var k = 1 - (t - g.t) / 0.35; if (k <= 0) continue;
      var p = itoS(r.cx, r.cy), rad = Math.max(r.w, r.h) * 0.6 * s;
      var gr = c.createRadialGradient(p[0], p[1], 0, p[0], p[1], rad);
      gr.addColorStop(0, 'rgba(255,230,170,' + 0.45 * k + ')'); gr.addColorStop(1, 'rgba(255,160,60,0)');
      c.fillStyle = gr; c.beginPath(); c.arc(p[0], p[1], rad, 0, TAU); c.fill();
    }
    c.restore();
  }
  // Попадание: вспышка, ударная волна, обломки
  function drawBlasts(c, sh) {
    var t = sh.crew.t, s = ICAM.s;
    c.save(); c.globalCompositeOperation = 'lighter';
    for (var i = 0; i < IN.blasts.length; i++) {
      var b = IN.blasts[i], k = (t - b.t) / 0.9; if (k < 0 || k > 1) continue;
      var p = itoS(b.x, b.y), R = b.r * s * (0.6 + k * 1.8);
      var g = c.createRadialGradient(p[0], p[1], 0, p[0], p[1], R);
      g.addColorStop(0, 'rgba(255,250,220,' + (1 - k) + ')'); g.addColorStop(0.4, 'rgba(255,160,60,' + (0.8 * (1 - k)) + ')'); g.addColorStop(1, 'rgba(255,60,20,0)');
      c.fillStyle = g; c.beginPath(); c.arc(p[0], p[1], R, 0, TAU); c.fill();
      c.strokeStyle = 'rgba(255,220,180,' + (0.6 * (1 - k)) + ')'; c.lineWidth = 2;
      c.beginPath(); c.arc(p[0], p[1], b.r * s * (0.5 + k * 3), 0, TAU); c.stroke();
      c.fillStyle = 'rgba(255,200,120,' + (1 - k) + ')';
      for (var d = 0; d < 10; d++) {
        var a = d * 0.628 + b.x, L = (b.r * 0.5 + k * b.r * 2.5) * s * (0.6 + (d % 3) * 0.25);
        c.fillRect(p[0] + Math.cos(a) * L - 1, p[1] + Math.sin(a) * L - 1, 2.2, 2.2);
      }
    }
    c.restore();
  }
  // Боевая тревога: красные огни пульсируют по краям; горящие отсеки — оранжевым
  function drawAlarm(c, sh, T) {
    var k = 0.5 + 0.5 * Math.sin(T * 4.2);
    var g = c.createRadialGradient(CAM.vw / 2, CAM.vh / 2, Math.min(CAM.vw, CAM.vh) * 0.45, CAM.vw / 2, CAM.vh / 2, Math.max(CAM.vw, CAM.vh) * 0.75);
    g.addColorStop(0, 'rgba(200,20,20,0)'); g.addColorStop(1, 'rgba(210,25,20,' + (0.14 + 0.16 * k) + ')');
    c.fillStyle = g; c.fillRect(0, 0, CAM.vw, CAM.vh);
    var s = ICAM.s, rs = sh.crew.roomList;
    for (var i = 0; i < rs.length; i++) {
      var st = rs[i]; if (!st.fires) continue;
      var r = st.r, o = itoS(r.x, r.y);
      if (o[0] > CAM.vw || o[1] > CAM.vh || o[0] + r.w * s < 0 || o[1] + r.h * s < 0) continue;
      c.fillStyle = 'rgba(255,90,30,' + (0.05 + 0.07 * k) + ')'; c.fillRect(o[0], o[1], r.w * s, r.h * s);
    }
  }
  // Отсеки плоско — для вида «весь корабль»
  function roomsFlat(c, sh, s) {
    var P = ART.PAL[sh.plan.faction] || ART.PAL.republic, rooms = sh.plan.rooms;
    for (var i = 0; i < rooms.length; i++) {
      var r = rooms[i], o = itoS(r.x, r.y);
      c.fillStyle = P.floor[r.t] || '#555'; c.fillRect(o[0] + s, o[1] + s, (r.w - 2) * s, (r.h - 2) * s);
      c.strokeStyle = P.wall; c.lineWidth = Math.max(1, s); c.strokeRect(o[0] + s / 2, o[1] + s / 2, (r.w - 1) * s, (r.h - 1) * s);
    }
  }
  function drawFire(c, sh, T) {
    var cr = sh.crew, p = sh.plan, s = ICAM.s, list = cr.burning;
    if (!list.length) return;
    var a = itoW(-20, -20), b = itoW(CAM.vw + 20, CAM.vh + 20);
    c.save(); c.globalCompositeOperation = 'lighter';
    for (var i = 0; i < list.length; i++) {
      var k = list[i], x = k % p.w, y = (k - x) / p.w;
      if (x < a[0] || x > b[0] || y < a[1] || y > b[1]) continue;
      var v = cr.fire[k] / 100, fl = 0.55 + 0.45 * Math.sin(T * 11 + k * 1.7), q = itoS(x + 0.5, y + 0.5);
      var r = s * (0.7 + 0.8 * v) * (0.85 + 0.25 * fl);
      var g = c.createRadialGradient(q[0], q[1], 0, q[0], q[1], r);
      g.addColorStop(0, 'rgba(255,240,180,' + (0.55 * v * fl + 0.15) + ')');
      g.addColorStop(0.45, 'rgba(255,130,40,' + (0.45 * v + 0.1) + ')');
      g.addColorStop(1, 'rgba(200,40,10,0)');
      c.fillStyle = g; c.beginPath(); c.arc(q[0], q[1], r, 0, TAU); c.fill();
    }
    c.restore();
    // дым: тёмные клубы над сильным огнём
    if (s > 4) {
      c.fillStyle = 'rgba(20,18,16,0.18)';
      for (var j = 0; j < list.length; j += 3) {
        var kk = list[j]; if (cr.fire[kk] < 60) continue;
        var xx = kk % p.w, yy = (kk - xx) / p.w, qq = itoS(xx + 0.5 + Math.sin(T + kk) * 0.6, yy - 0.3 + Math.cos(T * 0.7 + kk) * 0.6);
        c.beginPath(); c.arc(qq[0], qq[1], s * 1.1, 0, TAU); c.fill();
      }
    }
  }
  var ATLAS = null, ATLAS_TRIES = 0, SIZES = [56, 44, 36];
  function atlas() {
    if (!ATLAS || (ATLAS.bad && ATLAS_TRIES < SIZES.length)) {
      try { ATLAS = F.bake(S.TYPES, SIZES[Math.min(ATLAS_TRIES, SIZES.length - 1)]); } catch (e) { ATLAS = { bad: true }; }
      ATLAS_TRIES++;
      ATLAS.ok = !!ATLAS.canvas && F.check(ATLAS); ATLAS.bad = !ATLAS.ok; ATLAS.at = performance.now();
    } else if (ATLAS.ok && performance.now() - ATLAS.at > 3000) {
      ATLAS.at = performance.now();
      if (!F.check(ATLAS)) { ATLAS.ok = false; ATLAS.bad = true; }
    }
    return ATLAS;
  }
  // Фигурки крупнее жизни: человек 0,6 м в отсеке на 50 м иначе теряется
  var FIGK = 1.75;
  function drawCrew(c, sh, T) {
    var s = ICAM.s; if (s < 4) return;
    var A = atlas(), ag = sh.crew.agents, alpha = Math.min(1, (s - 4) / 3), p, i, m;
    var hw = CAM.vw / 2 / s + 2, hh = CAM.vh / 2 / s + 2, W = sh.plan.w;
    var vis = function(m) { return Math.abs(m.x - ICAM.x) <= hw && Math.abs(m.y - ICAM.y) <= hh; };
    c.globalAlpha = alpha;
    // погибшие — на полу
    for (i = 0; i < ag.length; i++) {
      m = ag[i]; if (m.alive || !vis(m)) continue;
      p = itoS(m.x, m.y);
      c.save(); c.translate(p[0], p[1]); F.corpse(c, S.TYPES[m.fig], m.aim + 0.6, s * FIGK); c.restore();
    }
    // дела: под фигурками
    c.save(); c.globalCompositeOperation = 'lighter';
    for (i = 0; i < ag.length; i++) {
      m = ag[i]; if (!m.alive || !m.at || !vis(m)) continue;
      p = itoS(m.x, m.y);
      if (m.job && m.job.kind === 'fire' && m.sprayAt >= 0) {
        // струя пены: частицы летят от бойца к огню
        var fx = m.sprayAt % W + 0.5, fy = (m.sprayAt - (m.sprayAt % W)) / W + 0.5, q = itoS(fx, fy);
        for (var k = 0; k < 9; k++) {
          var u = ((T * 2.2 + k / 9 + m.id * 0.37) % 1), jx = Math.sin(k * 7.1 + T * 9) * s * 0.25 * u, jy = Math.cos(k * 5.3 + T * 8) * s * 0.25 * u;
          c.fillStyle = 'rgba(210,235,255,' + (0.75 - u * 0.5) + ')';
          c.beginPath(); c.arc(p[0] + (q[0] - p[0]) * u + jx, p[1] + (q[1] - p[1]) * u + jy, Math.max(1, s * (0.1 + u * 0.18)), 0, TAU); c.fill();
        }
        // пар над тем, куда бьёт струя
        c.fillStyle = 'rgba(200,210,220,' + (0.18 + 0.1 * Math.sin(T * 6 + m.id)) + ')';
        c.beginPath(); c.arc(q[0] + Math.sin(T * 3 + m.id) * s * 0.3, q[1] - s * 0.3, s * 0.8, 0, TAU); c.fill();
      } else if (m.job && m.job.kind === 'fix' && m.fixAt >= 0) {
        // сварка: искры у машины
        var mx = m.fixAt % W + 0.5, my = (m.fixAt - (m.fixAt % W)) / W + 0.5, w0 = itoS((m.x + mx) / 2, (m.y + my) / 2);
        if (Math.sin(T * 17 + m.id * 3) > -0.3) {
          c.fillStyle = 'rgba(255,250,210,0.95)'; c.beginPath(); c.arc(w0[0], w0[1], Math.max(1.5, s * 0.16), 0, TAU); c.fill();
          for (var sp = 0; sp < 6; sp++) {
            var ua = ((T * 3 + sp / 6 + m.id * 0.21) % 1), ang = sp * 1.05 + m.id + Math.floor(T * 5);
            c.fillStyle = 'rgba(255,' + (190 - ua * 90 | 0) + ',60,' + (1 - ua) + ')';
            c.fillRect(w0[0] + Math.cos(ang) * ua * s * 0.9, w0[1] + Math.sin(ang) * ua * s * 0.9 + ua * ua * s * 0.4, Math.max(1, s * 0.08), Math.max(1, s * 0.08));
          }
        }
      } else if (m.job && m.job.kind === 'heal') {
        var pt = ag[m.job.who];
        if (pt && pt.alive) {
          var pq = itoS(pt.x, pt.y), gl = c.createRadialGradient(pq[0], pq[1], 0, pq[0], pq[1], s);
          gl.addColorStop(0, 'rgba(120,255,160,' + (0.3 + 0.15 * Math.sin(T * 5)) + ')'); gl.addColorStop(1, 'rgba(120,255,160,0)');
          c.fillStyle = gl; c.beginPath(); c.arc(pq[0], pq[1], s, 0, TAU); c.fill();
        }
      } else if (!m.job && m.task === 'post' && m.face != null && sh.crew.alertOn) {
        // работа у пульта: экран светится перед бойцом
        var cx = itoS(m.x + Math.cos(m.face) * 0.75, m.y + Math.sin(m.face) * 0.75);
        c.fillStyle = 'rgba(110,200,255,' + (0.35 + 0.25 * Math.sin(T * 3 + m.id)) + ')';
        c.beginPath(); c.arc(cx[0], cx[1], Math.max(1.2, s * 0.22), 0, TAU); c.fill();
      }
    }
    c.restore();
    // сами бойцы
    for (i = 0; i < ag.length; i++) {
      m = ag[i]; if (!m.alive || !vis(m)) continue;
      p = itoS(m.x, m.y);
      if (G.who === m.id) {
        c.strokeStyle = 'rgba(240,200,106,' + (0.7 + 0.3 * Math.sin(T * 6)) + ')'; c.lineWidth = 2;
        c.beginPath(); c.arc(p[0], p[1], s * 0.85, 0, TAU); c.stroke();
      }
      if (A.ok) {
        var size = s * A.scale * FIGK, half = size / 2, per = A.dirs * A.frames;
        var dir = Math.round(((m.aim % TAU) + TAU) % TAU / TAU * A.dirs) % A.dirs;
        var fr = m.mv > 0.3 ? 1 + Math.floor(m.phase / (TAU / 4)) % 4 : 0;
        var kk = m.fig * per + dir * A.frames + fr;
        c.drawImage(A.canvas, (kk % A.cols) * A.cell, Math.floor(kk / A.cols) * A.cell, A.cell, A.cell, p[0] - half, p[1] - half, size, size);
      } else {
        c.save(); c.translate(p[0], p[1]); c.scale(s * FIGK, s * FIGK);
        F.draw(c, S.TYPES[m.fig], { aim: m.aim, legs: m.legs, mv: m.mv, phase: m.phase });
        c.restore();
      }
      // в руках: ящик боеприпасов / огнетушитель; над головой — крест медика, ранение
      if (s > 6) {
        if (m.carry) {
          var bx = p[0] + Math.cos(m.aim) * s * 0.45, by = p[1] + Math.sin(m.aim) * s * 0.45, bs = s * 0.42;
          c.fillStyle = '#7a6a3a'; c.fillRect(bx - bs / 2, by - bs / 2, bs, bs);
          c.strokeStyle = '#d9a940'; c.lineWidth = 1; c.strokeRect(bx - bs / 2, by - bs / 2, bs, bs);
        }
        if (m.job && m.job.kind === 'fire') {
          var ex = p[0] + Math.cos(m.aim + 0.5) * s * 0.35, ey = p[1] + Math.sin(m.aim + 0.5) * s * 0.35;
          c.fillStyle = '#c0453a'; c.beginPath(); c.arc(ex, ey, Math.max(1.5, s * 0.14), 0, TAU); c.fill();
        }
        if (m.role === 'medic') {
          var hx = p[0], hy = p[1] - s * 0.95, cs = Math.max(2, s * 0.16);
          c.fillStyle = '#e8eef2'; c.fillRect(hx - cs * 1.5, hy - cs / 2, cs * 3, cs); c.fillRect(hx - cs / 2, hy - cs * 1.5, cs, cs * 3);
          c.fillStyle = '#c0453a'; c.fillRect(hx - cs, hy - cs / 4, cs * 2, cs / 2); c.fillRect(hx - cs / 4, hy - cs, cs / 2, cs * 2);
        }
        if (m.hp < 70) {
          c.fillStyle = 'rgba(20,26,34,0.9)'; c.fillRect(p[0] - s * 0.5, p[1] + s * 0.75, s, Math.max(2, s * 0.1));
          c.fillStyle = m.hp < 35 ? '#ff6a55' : '#e8d9a8'; c.fillRect(p[0] - s * 0.5, p[1] + s * 0.75, s * m.hp / 100, Math.max(2, s * 0.1));
        }
      }
    }
    c.globalAlpha = 1;
  }
  function drawLabels(c, sh) {
    var s = ICAM.s; if (s > 30) return;
    var rooms = sh.plan.rooms, fs = 10;
    c.font = fs + 'px "Courier New", monospace'; c.textAlign = 'center'; c.textBaseline = 'middle';
    for (var i = 0; i < rooms.length; i++) {
      var r = rooms[i], st = sh.crew.rooms[r.n];
      if (r.auto && s < 7 && st.integ > 98 && !st.fires) continue;
      if (r.h * s < 16) continue;
      var name = r.name.replace(/ \(.*\)$/, '');
      var extra = (st.integ < 99 ? ' ' + Math.round(st.integ) + '%' : '') + (st.fires ? ' 🔥' : '');
      var txt = name + extra, tw = c.measureText(txt).width;
      if (tw + 8 > r.w * s) { txt = extra ? extra.trim() : ''; tw = c.measureText(txt).width; if (!txt || tw + 8 > r.w * s) continue; }
      var p = itoS(r.x + r.w / 2, r.y + Math.min(r.h / 2, 3 + 14 / s));
      if (p[0] < -100 || p[1] < -20 || p[0] > CAM.vw + 100 || p[1] > CAM.vh + 20) continue;
      c.fillStyle = 'rgba(5,6,10,0.72)'; c.fillRect(p[0] - tw / 2 - 4, p[1] - fs / 2 - 3, tw + 8, fs + 6);
      c.fillStyle = st.fires ? '#ffb070' : st.integ < 40 ? '#ff8a5c' : r === G.room ? '#f0c86a' : '#cfd8dc';
      c.fillText(txt, p[0], p[1] + 0.5);
    }
  }

  // ---------------------------------------------------------------- режимы
  function setMode(m) {
    G.mode = m;
    document.body.classList.toggle('inside', m === 'inside');
    $('sp-inside').textContent = m === 'inside' ? 'К бою' : 'Внутри';
    $('sp-kicker').textContent = m === 'inside' ? 'Внутри корабля' : 'Космический бой 2.0';
    if (m === 'inside') {
      var sh = G.B.ships[G.sel]; if (!sh) return;
      G.aim = false; G.move = false;
      // начать с самого горячего места: огонь → поломка → мостик
      var p = sh.plan, best = null, score = -1;
      sh.crew.roomList.forEach(function(st) {
        var v = st.fires * 10 + (100 - st.integ) + (st.r.t === 'bridge' ? 5 : 0);
        if (v > score) { score = v; best = st.r; }
      });
      var v = view();
      ICAM.s = Math.max(10, Math.min(16, (CAM.vw - 20) / (best.w + 10)));
      ICAM.x = best.x + best.w / 2; ICAM.y = best.y + best.h / 2 - (v.cy - CAM.vh / 2) / ICAM.s;
      G.room = best;
    } else G.room = null;
    hud();
  }

  // ---------------------------------------------------------------- ввод
  var PTR = new Map(), GES = null, LONG = 0;
  function bind() {
    CV.addEventListener('pointerdown', function(e) {
      CV.setPointerCapture(e.pointerId);
      PTR.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY });
      if (PTR.size === 1) {
        GES = { moved: false };
        // удержание пальца в космосе — развернуть корабль носом к точке
        var g0 = GES, px0 = e.clientX, py0 = e.clientY;
        clearTimeout(LONG);
        if (G.mode === 'space') LONG = setTimeout(function() {
          if (GES !== g0 || g0.moved || PTR.size !== 1) return;
          g0.long = true; faceAt(px0, py0);
        }, 450);
      }
      else if (PTR.size === 2 && GES) {
        GES.moved = true;
        var ps = Array.from(PTR.values());
        var mid = [(ps[0].x + ps[1].x) / 2, (ps[0].y + ps[1].y) / 2];
        GES.pinch = { d: dist(ps[0], ps[1]), s: G.mode === 'inside' ? ICAM.s : CAM.s, mid: G.mode === 'inside' ? itoW(mid[0], mid[1]) : toW(mid[0], mid[1]) };
      }
    });
    CV.addEventListener('pointermove', function(e) {
      var p = PTR.get(e.pointerId); if (!p || !GES) return;
      var dx = e.clientX - p.x, dy = e.clientY - p.y; p.x = e.clientX; p.y = e.clientY;
      var ins = G.mode === 'inside';
      if (PTR.size === 2 && GES.pinch) {
        var ps = Array.from(PTR.values()), d = dist(ps[0], ps[1]), mx = (ps[0].x + ps[1].x) / 2, my = (ps[0].y + ps[1].y) / 2;
        if (ins) { ICAM.s = clampI(GES.pinch.s * d / Math.max(1, GES.pinch.d)); var w = itoW(mx, my); ICAM.x += GES.pinch.mid[0] - w[0]; ICAM.y += GES.pinch.mid[1] - w[1]; }
        else { CAM.s = clampS(GES.pinch.s * d / Math.max(1, GES.pinch.d)); var w2 = toW(mx, my); CAM.x += GES.pinch.mid[0] - w2[0]; CAM.y += GES.pinch.mid[1] - w2[1]; G.follow = false; }
        return;
      }
      if (Math.abs(p.x - p.x0) + Math.abs(p.y - p.y0) > 8) GES.moved = true;
      if (GES.moved) {
        if (ins) { ICAM.x -= dx / ICAM.s; ICAM.y -= dy / ICAM.s; }
        else { CAM.x -= dx / CAM.s; CAM.y -= dy / CAM.s; G.follow = false; }
      }
    });
    function up(e) {
      var p = PTR.get(e.pointerId); PTR.delete(e.pointerId);
      if (!GES) return;
      if (PTR.size === 0) { clearTimeout(LONG); if (p && !GES.moved && !GES.long && e.type === 'pointerup') tap(p.x, p.y); GES = null; }
      else GES.pinch = null;
    }
    CV.addEventListener('pointerup', up); CV.addEventListener('pointercancel', up);
    CV.addEventListener('wheel', function(e) {
      e.preventDefault();
      if (G.mode === 'inside') {
        var w = itoW(e.clientX, e.clientY); ICAM.s = clampI(ICAM.s * Math.exp(-e.deltaY * 0.0015));
        var w2 = itoW(e.clientX, e.clientY); ICAM.x += w[0] - w2[0]; ICAM.y += w[1] - w2[1];
      } else {
        var v = toW(e.clientX, e.clientY); CAM.s = clampS(CAM.s * Math.exp(-e.deltaY * 0.0015));
        var v2 = toW(e.clientX, e.clientY); CAM.x += v[0] - v2[0]; CAM.y += v[1] - v2[1]; G.follow = false;
      }
    }, { passive: false });
    window.addEventListener('resize', resize);
    document.addEventListener('visibilitychange', function() { if (document.visibilityState === 'visible' && ATLAS) ATLAS.at = 0; });
  }
  function dist(a, b) { var dx = a.x - b.x, dy = a.y - b.y; return Math.sqrt(dx * dx + dy * dy); }
  function clampS(s) { return Math.max(0.008, Math.min(1.2, s)); }
  function clampI(s) { return Math.max(1.2, Math.min(48, s)); }

  function tap(px, py) {
    var B = G.B; if (!B) return;
    if (G.mode === 'inside') {
      var sh0 = B.ships[G.sel], w = itoW(px, py), r = SH.roomAt(sh0.plan, w[0], w[1]);
      // боец под пальцем?
      var who = null, wd = Math.max(1.2, 16 / ICAM.s);
      wd *= wd;
      sh0.crew.agents.forEach(function(a) { if (!a.alive) return; var dx = a.x - w[0], dy = a.y - w[1], d = dx * dx + dy * dy; if (d < wd) { wd = d; who = a; } });
      G.who = who ? who.id : null;
      if (who) r = SH.roomAt(sh0.plan, who.x, who.y) || r;
      G.room = r || null; hud();
      return;
    }
    var p = toW(px, py);
    var hit = shipAt(p[0], p[1]);
    if (G.aim && G.foe >= 0) {
      var foe = B.ships[G.foe];
      if (hit === foe) {
        var l = B.toLocal(foe, p[0], p[1]), room = SH.roomAt(foe.plan, l[0], l[1]);
        if (!room) room = nearRoom(foe, l[0], l[1]);
        if (room) { assign({ k: 'room', ship: foe.n, room: room.n }, room.name); G.aim = false; hud(); return; }
      }
    }
    if (hit) {
      if (hit.side === G.side) { selectShip(hit.n); }
      else { G.foe = hit.n; buildTargets(); hud(); toast('Цель: ' + hit.name, 'gold'); }
      return;
    }
    // касание пустого космоса — курс своему кораблю
    if (G.aim) return;
    var me = B.ships[G.sel];
    if (me && !me.dead) {
      B.order(G.sel, p[0], p[1]);
      G.mark = { x: p[0], y: p[1], t: performance.now(), face: false };
      if (!G.taught) { G.taught = true; toast('Курс задан. Удержи палец — развернуться носом к точке', 'gold'); }
      hud();
    }
  }
  function faceAt(px, py) {
    var B = G.B, me = B && B.ships[G.sel]; if (!me || me.dead || G.aim) return;
    var p = toW(px, py);
    B.order(G.sel, p[0], p[1], true);
    G.mark = { x: p[0], y: p[1], t: performance.now(), face: true };
    try { if (navigator.vibrate) navigator.vibrate(15); } catch (e) {}
    toast('Разворот носом к точке', 'gold'); hud();
  }
  function nearRoom(sh, lx, ly) {
    var best = null, bd = 1e9;
    sh.plan.rooms.forEach(function(r) { var dx = r.cx - lx, dy = r.cy - ly, d = dx * dx + dy * dy; if (d < bd) { bd = d; best = r; } });
    return bd < 900 ? best : null;
  }
  function shipAt(x, y) {
    var B = G.B, best = null, bd = 1e18;
    for (var i = 0; i < B.ships.length; i++) {
      var s = B.ships[i]; if (s.dead) continue;
      var l = B.toLocal(s, x, y), m = 14 / CAM.s / s.plan.cellM;    // запас под палец
      if (l[0] < -m || l[1] < -m || l[0] > s.plan.w + m || l[1] > s.plan.h + m) continue;
      var dx = s.x - x, dy = s.y - y, d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = s; }
    }
    return best;
  }
  function selectShip(n) {
    if (G.sel !== n) { G.sel = n; G.gsel = {}; buildShipPanel(); }
    G.follow = 'ship'; G.aim = false; G.move = false;
    var sh = G.B.ships[n];
    if (sh.len * CAM.s < 60) focusShip(sh);
    hud();
  }

  // ---------------------------------------------------------------- цели
  function selectedGuns() { var out = []; for (var k in G.gsel) if (G.gsel[k]) out.push(+k); return out; }
  function assign(tgt, label) {
    var guns = selectedGuns();
    if (!guns.length) { toast('Сначала отметь пушки', 'bad'); return; }
    var n = G.B.setTarget(G.sel, guns, tgt);
    toast(n + ' ' + plural(n, 'пушка', 'пушки', 'пушек') + ' → ' + label, 'gold');
    hud();
  }
  function plural(n, a, b, c) { var m = n % 10, h = n % 100; return m === 1 && h !== 11 ? a : m >= 2 && m <= 4 && (h < 10 || h >= 20) ? b : c; }
  function tgtLabel(t) {
    var B = G.B, s = t.ship != null ? B.ships[t.ship] : null;
    if (t.k === 'auto') return 'сама';
    if (t.k === 'fighters') return 'истребители';
    if (!s) return '—';
    if (t.k === 'hull') return s.name + ' · корпус';
    if (t.k === 'sys') return s.name + ' · ' + SP.SYS_BY[t.sys].name.toLowerCase();
    if (t.k === 'room') { var r = s.plan.roomByN[t.room]; return s.name + ' · ' + (r ? r.name : 'отсек'); }
    return '—';
  }

  // ---------------------------------------------------------------- интерфейс
  function buildFleet() {
    var B = G.B, html = ['<div class="sp-fleet-col">', '<div class="sp-fleet-col">'];
    var cols = [[], []];
    B.ships.forEach(function(s) {
      var mine = s.side === G.side;
      cols[mine ? 0 : 1].push('<button class="sp-unit ' + (s.side === 0 ? 'rep' : 'cis') + '" data-ship="' + s.n + '">' +
        '<span class="sp-unit-name"><span>' + esc(s.name) + '</span><em id="sp-u-w' + s.n + '"></em></span>' +
        '<div class="sp-bar"><i id="sp-u-h' + s.n + '"></i></div><div class="sp-bar sh"><i id="sp-u-s' + s.n + '"></i></div></button>');
    });
    $('sp-fleet').innerHTML = '<div class="sp-fleet-col">' + cols[0].join('') + '</div><div class="sp-fleet-col">' + cols[1].join('') + '</div>';
  }
  function buildShipPanel() {
    var B = G.B, sh = B.ships[G.sel], box = $('sp-guns');
    if (!sh) { box.innerHTML = ''; return; }
    var rows = sh.guns.map(function(g, i) {
      return '<button class="sp-gun" data-gun="' + i + '" title="' + esc(g.name + ' — ' + g.T.name + '. ' + g.T.about) + '"><span class="box"></span><span class="ty ' + g.t + '">' + g.T.short + '</span>' +
        '<span class="nm">' + esc(shortGun(g.name)) + '</span><span class="tg" id="sp-g-t' + i + '"></span>' +
        '<span class="st" id="sp-g-s' + i + '"></span><span class="rl"><i id="sp-g-r' + i + '"></i></span></button>';
    });
    box.innerHTML = rows.join('');
    buildTargets();
  }
  // «Турболазер Л1» → «Л1»: тип уже на значке
  function shortGun(n) {
    var s = n.replace(/^(Тяжёлый турболазер|Тяжёлая турболазерная пушка|Турболазер|Ионная пушка|Дальнобойная пушка|Пост ПВО)\s*/, '');
    return s ? s : n;
  }
  function buildTargets() {
    var B = G.B, foes = B.ships.filter(function(s) { return s.side !== G.side && !s.dead; });
    if (G.foe < 0 || !B.ships[G.foe] || B.ships[G.foe].dead) G.foe = foes.length ? foes[0].n : -1;
    $('sp-tg-foe').innerHTML = foes.length < 2 ? '' : foes.map(function(s) {
      return '<button class="sp-chip' + (s.n === G.foe ? ' on' : '') + '" data-foe="' + s.n + '">' + esc(s.name) + '</button>';
    }).join('');
    var foe = B.ships[G.foe], btn = [];
    btn.push('<button class="sp-btn tgt" data-t="auto">Сама</button>');
    btn.push('<button class="sp-btn tgt" data-t="fighters">Истреб.</button>');
    if (foe) {
      btn.push('<button class="sp-btn tgt" data-t="hull">Корпус</button>');
      SP.SYS.forEach(function(sy) {
        var has = foe.plan.rooms.some(function(r) { return sy.types.indexOf(r.t) >= 0; });
        if (has) btn.push('<button class="sp-btn tgt" data-t="sys" data-sys="' + sy.id + '">' + sy.name + '</button>');
      });
      btn.push('<button class="sp-btn tgt gold' + (btn.length % 4 === 3 ? '' : ' wide') + '" data-t="aim">Отсек на схеме…</button>');
    }
    $('sp-tg-grid').innerHTML = btn.join('');
  }

  function hud() {
    var B = G.B; if (!B) return;
    // флот
    B.ships.forEach(function(s) {
      var h = $('sp-u-h' + s.n); if (!h) return;
      h.style.width = Math.max(0, s.hull / s.hullMax * 100) + '%';
      $('sp-u-s' + s.n).style.width = ((s.sh[0] + s.sh[1] + s.sh[2] + s.sh[3]) / (4 * s.shMax) * 100) + '%';
      $('sp-u-w' + s.n).textContent = s.dead ? '✗' : s.crit ? '⚠ ' + Math.ceil(s.crit) : s.crew.burning.length ? '🔥' : '';
      var el = h.parentNode.parentNode;
      el.classList.toggle('on', s.n === G.sel || s.n === G.foe);
      el.classList.toggle('dead', s.dead);
    });
    var t = B.t | 0; $('sp-time').textContent = Math.floor(t / 60) + ':' + ('0' + t % 60).slice(-2);
    // выбранный корабль
    var sh = B.ships[G.sel], box = $('sp-ship');
    if (!sh) { box.innerHTML = '<div class="sp-hint">Твоих кораблей не осталось.</div>'; return; }
    var e = sh.eff;
    var head = '<div class="sp-ship-head"><b>' + esc(sh.name) + '</b><span class="sp-tag">' + Math.max(0, Math.round(sh.hull / sh.hullMax * 100)) + '%</span>' +
      (sh.dead ? '<span class="sp-tag warn">уничтожен</span>' : sh.crit ? '<span class="sp-tag warn">реактор ' + Math.ceil(sh.crit) + ' с</span>' : '') +
      '<span class="r">экипаж <i>' + sh.crew.alive() + '</i>' + (sh.crew.burning.length ? ' · огонь <i style="color:#ffb070">' + sh.crew.burning.length + '</i>' : '') + '</span></div>';
    var shv = function(v) { return '<b' + (v <= 0 ? ' class="z"' : '') + '>' + Math.round(v / sh.shMax * 100) + '</b>'; };
    var sys = '<div class="sp-sys">' + sysCell('Ход', e.engine) + sysCell('Пит', e.reactor) + sysCell('Щит', e.shield) + sysCell('Мост', e.bridge) +
      '<div class="shd" title="Щиты: нос / правый борт / корма / левый борт, %">◇' + shv(sh.sh[0]) + shv(sh.sh[1]) + shv(sh.sh[2]) + shv(sh.sh[3]) + '</div></div>';
    var shs = '';
    var inside = '';
    if (G.mode === 'inside') {
      var r = G.room, st = r && sh.crew.rooms[r.n];
      if (st) {
        var ppl = 0, ff = 0, fx = 0;
        sh.crew.agents.forEach(function(a) {
          if (!a.alive) return;
          if (a.job && a.job.room === r.n) { if (a.job.kind === 'fire') ff++; else fx++; }
          else if (a.home === r.n) ppl++;
        });
        var T = SH.TYPES[r.t] || { name: r.t };
        inside = '<div class="sp-hint" style="margin-top:6px"><b>' + esc(r.name) + '</b> · ' + esc(T.name.toLowerCase()) + ' · целость <b>' + Math.round(st.integ) + '%</b>' +
          (st.stun > 0 ? ' · <b style="color:#9fe7ff">ионный сбой ' + Math.ceil(st.stun) + ' с</b>' : '') +
          '<br>на посту <b>' + st.staffed + '/' + st.need + '</b> · в отсеке за ним <b>' + ppl + '</b>' +
          (st.fires ? ' · горит клеток <b style="color:#ffb070">' + st.fires + '</b>' : '') + (ff ? ' · тушат <b>' + ff + '</b>' : '') + (fx ? ' · чинят <b>' + fx + '</b>' : '') + '</div>';
      } else inside = '<div class="sp-hint" style="margin-top:6px">Коснись отсека или бойца — покажу, что там происходит.</div>';
      var wa = G.who != null && sh.crew.agents[G.who];
      if (wa) inside = '<div class="sp-hint" style="margin-top:6px">' + whoLine(sh, wa) + '</div>' + inside;
    }
    box.innerHTML = head + sys + shs + inside;
    // пушки
    var any = false;
    sh.guns.forEach(function(g, i) {
      var row = document.querySelector('.sp-gun[data-gun="' + i + '"]'); if (!row) return;
      row.classList.toggle('on', !!G.gsel[i]); if (G.gsel[i]) any = true;
      $('sp-g-t' + i).textContent = tgtLabel(g.tgt);
      var st = $('sp-g-s' + i), room = g.room && sh.crew.rooms[g.room], txt, cls;
      if (sh.dead) { txt = '—'; cls = 'idle'; }
      else if (g.out) { txt = room && room.stun > 0 ? 'ионный сбой' : room && room.staffed === 0 ? 'нет расчёта' : 'разбита'; cls = 'bad'; }
      else if (g.aimAt) { txt = 'огонь'; cls = 'ok'; }
      else { txt = g.tgt.k === 'fighters' ? 'нет целей' : 'вне сектора'; cls = 'idle'; }
      if (room && !g.out && room.staffed < room.need) txt += ' ' + room.staffed + '/' + room.need;
      st.textContent = txt; st.className = 'st ' + cls;
      $('sp-g-r' + i).style.width = (g.out ? 0 : Math.max(0, 1 - Math.max(0, g.cd) / g.T.reload) * 100) + '%';
    });
    $('sp-tg').hidden = !any || sh.dead;
    $('sp-bottom').classList.toggle('sp-tg-open', any && !sh.dead);
    var foe = B.ships[G.foe];
    $('sp-tg-head').textContent = G.aim ? 'Коснись отсека на корабле «' + (foe ? foe.name : '') + '»' : 'Цель для выбранных';
    // текущая цель выбранных подсвечена
    var sel = selectedGuns(), same = null;
    if (sel.length) { same = sh.guns[sel[0]].tgt; for (var q = 1; q < sel.length; q++) if (JSON.stringify(sh.guns[sel[q]].tgt) !== JSON.stringify(same)) { same = null; break; } }
    var bt = document.querySelectorAll('#sp-tg-grid .sp-btn');
    for (var j = 0; j < bt.length; j++) {
      var b = bt[j], k = b.getAttribute('data-t'), cur = false;
      if (same) cur = k === same.k && (k === 'auto' || k === 'fighters' || same.ship === G.foe) && (k !== 'sys' || b.getAttribute('data-sys') === same.sys);
      if (k === 'aim') cur = G.aim || (same && same.k === 'room' && same.ship === G.foe);
      b.classList.toggle('cur', !!cur);
    }
    var mv = $('sp-move');
    mv.textContent = sh.ai ? 'Курс: сам' : 'Курс: твой';
    mv.classList.toggle('on', !sh.ai);
    $('sp-view').textContent = G.mode === 'inside' ? 'Весь корабль' : 'Обзор';
  }
  var ROLE = { post: 'расчёт поста', fixer: 'ремонтник', medic: 'медик', reserve: 'резерв' };
  function whoLine(sh, a) {
    var rn = function(n) { var r = sh.plan.roomByN[n]; return r ? r.name : 'коридор'; };
    if (!a.alive) return '<b>Погиб</b> · ' + ROLE[a.role];
    var j = a.job, what;
    if (j && j.kind === 'fire') what = a.at ? 'тушит пожар' : 'бежит тушить';
    else if (j && j.kind === 'fix') what = a.at ? 'чинит машины' : 'бежит чинить';
    else if (j && j.kind === 'heal') { var pt = sh.crew.agents[j.who]; what = (a.at ? 'перевязывает раненого' : 'бежит к раненому') + (pt ? ' (' + Math.round(pt.hp) + '%)' : ''); }
    else if (j && j.kind === 'carry') what = 'несёт боеприпасы к орудию';
    else if (j && j.kind === 'back') what = 'возвращается на склад';
    else what = a.at ? (sh.crew.alertOn ? 'на посту у пульта' : 'несёт вахту') : 'идёт на пост';
    var where = j && j.room ? rn(j.room) : rn(a.goalRoom || a.home);
    return '<b>' + ROLE[a.role].charAt(0).toUpperCase() + ROLE[a.role].slice(1) + '</b> · ' + what + ' · ' + esc(where) +
      ' · здоровье <b' + (a.hp < 50 ? ' style="color:#ff8a5c"' : '') + '>' + Math.round(a.hp) + '%</b>';
  }
  function sysCell(name, v) {
    var p = Math.round(v * 100), cls = p < 35 ? 'bad' : p < 75 ? 'mid' : '';
    return '<div class="' + cls + '">' + name + '<b>' + p + '%</b></div>';
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, function(ch) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]; }); }

  function bindUi() {
    $('sp-scen').addEventListener('click', function(e) {
      var b = e.target.closest('[data-scen]'); if (b) start(b.getAttribute('data-scen'), G.side);
    });
    $('sp-side').style.cursor = 'pointer';
    $('sp-side').addEventListener('click', function() { start(G.scen, 1 - G.side); });
    $('sp-fleet').addEventListener('click', function(e) {
      var b = e.target.closest('[data-ship]'); if (!b || !G.B) return;
      var s = G.B.ships[+b.getAttribute('data-ship')]; if (!s || s.dead) return;
      if (s.side === G.side) selectShip(s.n);
      else { G.foe = s.n; buildTargets(); if (G.mode === 'space') { focusShip(s); G.follow = false; } hud(); }
    });
    $('sp-guns').addEventListener('click', function(e) {
      var b = e.target.closest('[data-gun]'); if (!b || !G.B) return;
      var i = +b.getAttribute('data-gun'); G.gsel[i] = !G.gsel[i]; G.aim = false; hud();
    });
    $('sp-quick').addEventListener('click', function(e) {
      var b = e.target.closest('[data-q]'); if (!b) return;
      if (!G.B) return;
      var q = b.getAttribute('data-q'), sh = G.B.ships[G.sel]; if (!sh) return;
      G.gsel = {};
      sh.guns.forEach(function(g, i) { if (q === 'all' || (q === 'main' && g.t !== 'pd') || (q === 'pd' && g.t === 'pd')) G.gsel[i] = true; });
      G.aim = false; hud();
    });
    $('sp-tg-foe').addEventListener('click', function(e) {
      var b = e.target.closest('[data-foe]'); if (!b || !G.B) return;
      G.foe = +b.getAttribute('data-foe'); buildTargets(); hud();
    });
    $('sp-tg-grid').addEventListener('click', function(e) {
      var b = e.target.closest('[data-t]'); if (!b || !G.B) return;
      var k = b.getAttribute('data-t'), foe = G.B.ships[G.foe];
      if (foe && foe.dead) foe = null;
      if (k === 'auto') assign({ k: 'auto' }, 'сама выбирает цель');
      else if (k === 'fighters') assign({ k: 'fighters' }, 'по истребителям');
      else if (!foe) return;
      else if (k === 'hull') assign({ k: 'hull', ship: foe.n }, foe.name + ', корпус');
      else if (k === 'sys') { var sy = b.getAttribute('data-sys'); assign({ k: 'sys', ship: foe.n, sys: sy }, foe.name + ', ' + SP.SYS_BY[sy].name.toLowerCase()); }
      else if (k === 'aim') {
        G.aim = !G.aim;
        if (G.aim) {
          if (G.mode === 'inside') setMode('space');
          focusShip(foe, Math.min(0.5, Math.min(CAM.vw, view().h) * 0.9 / foe.len)); G.follow = false;
          toast('Коснись отсека на схеме врага', 'gold');
        }
      }
      hud();
    });
    $('sp-move').onclick = function() {
      var sh = G.B && G.B.ships[G.sel]; if (!sh || sh.dead) return;
      if (!sh.ai) { G.B.order(G.sel, null); toast('Корабль ведёт сам: дистанция и борт к врагу', 'gold'); }
      else { G.B.order(G.sel, 'hold'); toast('Курс твой: коснись космоса — ход, удержи — разворот', 'gold'); }
      hud();
    };
    $('sp-inside').onclick = function() { if (G.B && G.B.ships[G.sel] && !G.B.ships[G.sel].dead) setMode(G.mode === 'inside' ? 'space' : 'inside'); };
    $('sp-view').onclick = function() {
      if (!G.B) return;
      if (G.mode === 'inside') {
        var p = G.B.ships[G.sel].plan, v = view();
        ICAM.s = Math.min((CAM.vw - 20) / p.w, (v.h - 10) / p.h); ICAM.x = p.w / 2; ICAM.y = p.h / 2 - (v.cy - CAM.vh / 2) / ICAM.s;
      } else fitAll();
    };
    $('sp-fold').onclick = function() {
      var b = $('sp-bottom'); b.classList.toggle('min');
      $('sp-fold').textContent = b.classList.contains('min') ? '▴ приказы' : '▾ свернуть';
    };
    $('sp-end-again').onclick = function() { start(G.scen, G.side); };
    $('sp-end-look').onclick = function() { $('sp-end').hidden = true; };
  }

  function endBattle() {
    G.ended = true;
    var B = G.B, win = B.over === G.side, lost = B.ships.filter(function(s) { return s.dead && s.side === G.side; }).length;
    var killed = B.ships.filter(function(s) { return s.dead && s.side !== G.side; });
    $('sp-end-title').textContent = B.over === 2 ? 'Взаимное уничтожение' : win ? 'Победа' : 'Поражение';
    var t = B.t | 0;
    $('sp-end-text').innerHTML = 'Бой шёл ' + Math.floor(t / 60) + ' мин ' + (t % 60) + ' с.<br>' +
      'Уничтожено: ' + (killed.length ? killed.map(function(s) { return esc(s.name) + (s.why === 'reactor' ? ' (реактор)' : ''); }).join(', ') : 'никого') + '.<br>' +
      'Потери: ' + (lost ? lost + ' ' + plural(lost, 'корабль', 'корабля', 'кораблей') : 'нет') + '.';
    $('sp-end').hidden = false;
  }

  var toastT = 0, toastAt = 0;
  function toast(msg, kind) {
    var el = $('sp-toast'), t = performance.now();
    if (kind !== 'bad' && t - toastAt < 600 && el.classList.contains('bad')) return;   // важное не перебивать
    toastAt = t;
    el.textContent = msg; el.className = 'sp-toast show' + (kind ? ' ' + kind : '');
    clearTimeout(toastT); toastT = setTimeout(function() { el.className = 'sp-toast'; }, 2400);
  }

  // ---------------------------------------------------------------- старт
  resize(); bind(); bindUi();
  var scen = 'vp', side = 0;
  var qs = location.search;
  var m1 = qs.match(/[?&]scen=([\w]+)/), m2 = qs.match(/[?&]side=(rep|cis)/);
  if (m1 && SCEN[m1[1]]) scen = m1[1];
  else { try { scen = localStorage.getItem('sp-scen') || scen; } catch (e) {} }
  if (m2) side = m2[1] === 'cis' ? 1 : 0;
  else { try { side = +(localStorage.getItem('sp-side') || 0) === 1 ? 1 : 0; } catch (e) {} }
  if (!SCEN[scen]) scen = 'vp';
  start(scen, side);
  requestAnimationFrame(frame);
  window.__sp = { G: G, CAM: CAM, ICAM: ICAM, FR: FR, setMode: setMode, fitAll: fitAll, selectShip: selectShip };
})();
