/* Палуба в бою 2.0: то, что видно только на экране (на расчёт боя не влияет).
 *
 *  - двери съезжаются, когда рядом никого, и разъезжаются перед бойцом;
 *  - попадание — искры и цифра урона над целью; промах летит до стены — искры и подпалина;
 *  - гибель: дроид разлетается на части с искрами и дымом, клон падает; тела — из
 *    готового набора картинок (одна копия на тело, а не рисунок линиями каждый кадр);
 *  - жетоны бойцов издалека (или всегда — по настройке);
 *  - мини-карта палубы и рамка выделения.
 * Сколько всего этого — решает качество графики (space-gfx.js).
 * Модуль получает от space.js камеру, бой и отрисовщики через init(). ES5.
 */
(function(root) {
  'use strict';

  var TAU = Math.PI * 2;
  var X = null;                 // окружение из space.js
  var S = { ship: -1, crew: null, lastT: 0, parts: [], nums: [], doors: {}, prev: null, objs: [], dead: {}, hit: {}, near: [], bdoor: null, bdFor: null, box: null, mini: null };
  var PORT = { rep_dc15a: 1, rep_heavy: 1, rep_sniper: 1, cis_b1: 1, cis_b2: 1, cis_bx: 1, rep_officer: 1, rep_engineer: 1, rep_medic: 1,
               cis_engineer: 1, cis_medic: 1, rep_arc: 1, rep_commando: 1, rep_launcher: 1, rep_aa: 1, rep_militia: 1, cis_b1_launcher: 1,
               cis_b1_sniper: 1, cis_militia: 1, cis_bounty: 1, cis_hunter: 1, marauder: 1,
               // 2 — портрета нет: картинка карточки найма (моделька боя, assets/units/models), середина кадра
               rep_mando: 2, rep_hunter: 2 };
  var PORT_ALIAS = { cis_b1_cmd: 'cis_b1', cis_b1_crew: 'cis_b1', rep_gunner: 'rep_dc15a' };
  var DEAD_T = 0.45;            // сколько длится гибель (потом — картинка из набора тел)

  function init(ctx) { X = ctx; }
  function Q() { return X.gfx.Q(); }
  function onScreen(x, y, m) {
    var p = X.itoS(x, y), mm = (m || 1) * X.ICAM.s + 20;
    return p[0] > -mm && p[1] > -mm && p[0] < X.CAM.vw + mm && p[1] < X.CAM.vh + mm;
  }

  // ---------------------------------------------------------------- шаг
  function reset(sh) {
    var c = sh.crew;
    S.ship = sh.n; S.crew = c; S.lastT = c.t; S.parts = []; S.nums = []; S.doors = {}; S.dead = {}; S.hit = {};
    S.prev = new Uint8Array(c.agents.length + 64); S.objs = [];
    for (var i = 0; i < c.agents.length; i++) { var a = c.agents[i]; if (a) { S.prev[i] = state(a); S.objs[i] = a; } }
    if (c.board) c.board.ev.shots.forEach(function(s) { s.fx = 1; });          // старые выстрелы — без эффектов
    S.bdoor = null; S.bdFor = null;
  }
  function state(a) { return !a.alive ? 2 : a.gone ? 3 : 1; }
  // Раз в кадр, до отрисовки: выстрелы → искры и цифры; гибель; двери; частицы
  function update(sh) {
    var c = sh.crew;
    if (S.ship !== sh.n || S.crew !== c) reset(sh);
    var t = c.t, dt = Math.max(0, Math.min(0.1, t - S.lastT));
    if (t > S.lastT) S.lastT = t;
    var q = Q(), bd = c.board, i;
    if (bd) {
      var sh2 = bd.ev.shots;
      for (i = 0; i < sh2.length; i++) { var s = sh2[i]; if (!s.fx && t - s.t >= 0.12) { s.fx = 1; impact(sh, bd, s, q, t); } }
    }
    deaths(sh, q, t);
    // кто на экране (с запасом) — для дверей
    // (скрытые туманом не в счёт: дверь не должна выдавать, что за ней враг)
    S.near.length = 0;
    var ag = c.agents, fogB = X.boardOf(sh.n);
    for (i = 0; i < ag.length; i++) { var a = ag[i]; if (a && a.alive && !a.gone && (!fogB || X.seenIn(fogB, a)) && onScreen(a.x, a.y, 4)) S.near.push(a); }
    doorsStep(sh, dt);
    // частицы
    if (dt > 0) {
      var keep = [];
      for (i = 0; i < S.parts.length; i++) {
        var p = S.parts[i]; p.life -= dt; if (p.life <= 0) continue;
        p.x += p.vx * dt; p.y += p.vy * dt;
        if (p.k === 'spark') { p.vx *= Math.pow(0.04, dt); p.vy *= Math.pow(0.04, dt); }
        keep.push(p);
      }
      S.parts = keep;
      // разбитые дроиды искрят первые секунды
      if (q.sparks) for (var id in S.dead) {
        var D = S.dead[id]; if (!D.droid || t - D.t0 > 3.5 || Math.random() > dt * 4) continue;
        var dd = ag[id]; if (!dd || !onScreen(dd.x, dd.y)) continue;
        var an = Math.random() * TAU, sp = 0.8 + Math.random() * 1.7;
        S.parts.push({ k: 'spark', x: dd.x, y: dd.y, vx: Math.cos(an) * sp, vy: Math.sin(an) * sp, life: 0.25, max: 0.3, col: '255,190,90' });
      }
    }
    if (S.parts.length > 900) S.parts.splice(0, S.parts.length - 900);
    S.nums = S.nums.filter(function(n) { return t - n.t0 < 0.8 && t >= n.t0 - 0.05; });
  }
  function sparks(x, y, n, ang, col, sp0, sp1) {
    for (var i = 0; i < n; i++) {
      var a = ang + (Math.random() * 2 - 1) * 1.2, sp = sp0 + Math.random() * (sp1 - sp0);
      S.parts.push({ k: 'spark', x: x, y: y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0.12 + Math.random() * 0.23, max: 0.35, col: col });
    }
  }
  function impact(sh, bd, s, q, t) {
    var dx = s.x1 - s.x0, dy = s.y1 - s.y0, ang = Math.atan2(dy, dx), vis = onScreen(s.x1, s.y1, 2);
    if (s.hit) {
      var tg = s.ti >= 0 ? sh.crew.agents[s.ti] : null;
      if (tg) S.hit[s.ti] = ang;
      if (!vis || (tg && !X.seenIn(bd, tg))) return;
      var T = tg && X.ALL[tg.fig], droid = T ? X.F.isDroid(T) : s.ti < 0;
      if (q.sparks) sparks(s.x1, s.y1, q.sparks, ang + Math.PI, s.ti < 0 ? '255,200,120' : droid ? '255,170,70' : '210,232,255', 1.2, 4.2);
      if (X.gfx.get('nums') && s.d > 0) {
        var mine = tg ? tg.team === X.G.side : bd.def === X.G.side;
        // в одного за миг — одна цифра (очередь Z-6 не сыпет столбик)
        var last = S.nums.length && S.nums[S.nums.length - 1];
        if (last && last.id === s.ti && s.ti >= 0 && t - last.t0 < 0.15) { last.v += s.d; return; }
        S.nums.push({ id: s.ti, x: (tg ? tg.x : s.x1) + (Math.random() - 0.5) * 0.3, y: (tg ? tg.y : s.y1) - 0.45, v: s.d, mine: mine, t0: t });
        if (S.nums.length > 40) S.nums.shift();
      }
      return;
    }
    // промах: искры у стены и подпалина на полу
    if (!vis) return;
    var col = s.w === 'turret' ? '255,190,90' : X.TEAMC[s.team === 0 ? 0 : 1];
    if (q.sparks) sparks(s.x1, s.y1, Math.ceil(q.sparks * 0.7), ang + Math.PI, col, 1, 3.5);
    if (q.decals && s.wall) {
      var dec = sh.crew._dec || (sh.crew._dec = []);
      dec.push({ x: s.x1 - Math.cos(ang) * 0.05, y: s.y1 - Math.sin(ang) * 0.05, r: 0.09 + Math.random() * 0.07, t0: t, a: Math.random() * 3 });
      if (dec.length > q.decals) dec.splice(0, dec.length - q.decals);
    }
  }
  function deaths(sh, q, t) {
    var ag = sh.crew.agents;
    if (S.prev.length < ag.length) { var np = new Uint8Array(ag.length + 64); np.set(S.prev); S.prev = np; }
    for (var i = 0; i < ag.length; i++) {
      var a = ag[i]; if (!a) continue;
      if (S.objs[i] !== a) { S.objs[i] = a; S.prev[i] = state(a); continue; }     // новый человек на этом месте
      var st = state(a), was = S.prev[i]; S.prev[i] = st;
      if (was !== 1 || st !== 2) continue;
      // погиб на глазах: отброшен от стрелка (или навзничь). Гибель — когда долетит смертельный болт:
      // по сети смерть приходит раньше, чем на экране долетит выстрел (выстрелы показаны с задержкой)
      var T = X.ALL[a.fig] || X.ALL[0], ang = S.hit[i] != null ? S.hit[i] : a.aim + Math.PI, t0 = t;
      var bs = sh.crew.board && sh.crew.board.ev.shots;
      if (bs) for (var k = bs.length - 1; k >= 0; k--) {
        var s = bs[k]; if (s.ti !== i || !s.hit) continue;
        ang = Math.atan2(s.y1 - s.y0, s.x1 - s.x0); if (!s.fx) t0 = Math.max(t, s.t + 0.12); break;
      }
      var DD = X.F.DEAD_DIRS, dir = ((Math.round(ang / TAU * DD) % DD) + DD) % DD, droid = X.F.isDroid(T);
      S.dead[i] = { t0: t0, dir: dir, droid: droid, fx: false };
    }
    // искры и дым — в миг попадания (сразу или когда долетит болт)
    for (var id in S.dead) {
      var D = S.dead[id]; if (D.fx || t < D.t0) continue;
      D.fx = true;
      var da = ag[id]; if (da) deathFx(da, X.ALL[da.fig] || X.ALL[0], D.dir / X.F.DEAD_DIRS * TAU, q);
    }
  }
  function deathFx(a, T, ang, q) {
    if (!onScreen(a.x, a.y, 2)) return;
    if (X.F.isDroid(T)) {
      var big = T.draw === 'b2';
      if (q.sparks) sparks(a.x, a.y, Math.round(q.sparks * (big ? 2.2 : 1.4)), ang, '255,170,70', 1.5, 5);
      if (q.smoke) { smoke(a.x, a.y, 0.18, 1.6); smoke(a.x, a.y, 0.14, 1.3); if (big) smoke(a.x, a.y, 0.24, 2); }
      if (big) S.parts.push({ k: 'boom', x: a.x, y: a.y, vx: 0, vy: 0, r: 0.9, life: 0.5, max: 0.5 });
    } else if (q.smoke) smoke(a.x, a.y, 0.12, 0.9);
  }
  function smoke(x, y, r, life) {
    S.parts.push({ k: 'smoke', x: x, y: y, vx: (Math.random() - 0.5) * 0.3, vy: -0.1 - Math.random() * 0.25, r: r, life: life, max: life });
  }

  // ---------------------------------------------------------------- двери
  // Обычные двери (не броня и не шлюз): разъезжаются перед бойцом, съезжаются за ним.
  function bdoors(sh) {
    var bd = sh.crew.board;
    if (S.bdoor && S.bdFor === bd) return S.bdoor;
    S.bdFor = bd; S.bdoor = {};
    if (bd) for (var i = 0; i < bd.doors.length; i++) S.bdoor[bd.doors[i].id] = bd.doors[i];
    return S.bdoor;
  }
  function doorRect(d) {
    var len = d.w || 2, deep = d.d === 2 ? 2 : 1;
    return d.v ? [d.x, d.y, deep, len] : [d.x, d.y, len, deep];
  }
  function doorsStep(sh, dt) {
    var ds = sh.plan.doors, bm = bdoors(sh);
    for (var i = 0; i < ds.length; i++) {
      var d = ds[i]; if (d.k === 'blast' || d.k === 'lock') continue;
      var r = doorRect(d); if (!onScreen(r[0] + r[2] / 2, r[1] + r[3] / 2, 3)) continue;
      var b = bm[d.id], st = b ? b.state : 'open', cur = S.doors[d.id];
      if (cur == null) cur = 1;                               // в кадр — открытой: не хлопает на глазах
      var want = 0;
      if (st === 'broken') want = 1;
      else if (st !== 'locked') {
        for (var j = 0; j < S.near.length; j++) {
          var a = S.near[j];
          if (a.x > r[0] - 1.45 && a.x < r[0] + r[2] + 1.45 && a.y > r[1] - 1.45 && a.y < r[1] + r[3] + 1.45) { want = 1; break; }
        }
      }
      S.doors[d.id] = want ? Math.min(1, cur + dt * 3.4) : Math.max(0, cur - dt * 2.6);
    }
  }
  function drawDoors(c, sh) {
    var s = X.ICAM.s; if (s < 3) return;
    var P = X.pal(sh), ds = sh.plan.doors;
    for (var i = 0; i < ds.length; i++) {
      var d = ds[i], k = S.doors[d.id]; if (k == null || k >= 1) continue;
      var r = doorRect(d), o = X.itoS(r[0], r[1]), w = r[2] * s, h = r[3] * s;
      if (o[0] > X.CAM.vw || o[1] > X.CAM.vh || o[0] + w < 0 || o[1] + h < 0) continue;
      var shut = 1 - k * k * (3 - 2 * k), stub = s * 0.35;
      c.fillStyle = P.door;
      if (d.v) {
        var lh = stub + (h / 2 - stub) * shut, x = o[0] + w * 0.15, ww = w * 0.7;
        c.fillRect(x, o[1], ww, lh); c.fillRect(x, o[1] + h - lh, ww, lh);
        if (shut > 0.97) { c.fillStyle = P.doorLight; c.fillRect(x, o[1] + h / 2 - Math.max(0.5, s * 0.04), ww, Math.max(1, s * 0.08)); }
        c.strokeStyle = 'rgba(0,0,0,0.35)'; c.lineWidth = 1; c.strokeRect(x + 0.5, o[1] + 0.5, ww - 1, lh - 1); c.strokeRect(x + 0.5, o[1] + h - lh + 0.5, ww - 1, lh - 1);
      } else {
        var lw = stub + (w / 2 - stub) * shut, y = o[1] + h * 0.15, hh = h * 0.7;
        c.fillRect(o[0], y, lw, hh); c.fillRect(o[0] + w - lw, y, lw, hh);
        if (shut > 0.97) { c.fillStyle = P.doorLight; c.fillRect(o[0] + w / 2 - Math.max(0.5, s * 0.04), y, Math.max(1, s * 0.08), hh); }
        c.strokeStyle = 'rgba(0,0,0,0.35)'; c.lineWidth = 1; c.strokeRect(o[0] + 0.5, y + 0.5, lw - 1, hh - 1); c.strokeRect(o[0] + w - lw + 0.5, y + 0.5, lw - 1, hh - 1);
      }
    }
  }

  // ---------------------------------------------------------------- под людьми
  function drawUnder(c, sh, T) {
    var s = X.ICAM.s, dec = sh.crew._dec, t = sh.crew.t, q = Q();
    if (dec && dec.length && s >= 3 && q.decals) {
      // подпалины пачкой: один путь на все
      c.fillStyle = 'rgba(14,10,7,0.5)'; c.beginPath();
      var any = false, i, d, p;
      for (i = 0; i < dec.length; i++) {
        d = dec[i]; p = X.itoS(d.x, d.y); var R = d.r * s * 1.4;
        if (p[0] < -R || p[1] < -R || p[0] > X.CAM.vw + R || p[1] > X.CAM.vh + R) continue;
        c.moveTo(p[0] + R, p[1]); c.arc(p[0], p[1], R, 0, TAU); any = true;
      }
      if (any) c.fill();
      c.fillStyle = 'rgba(6,4,3,0.55)'; c.beginPath();
      for (i = 0; i < dec.length; i++) {
        d = dec[i]; p = X.itoS(d.x, d.y); var r2 = d.r * s * 0.7;
        if (p[0] < -r2 || p[1] < -r2 || p[0] > X.CAM.vw + r2 || p[1] > X.CAM.vh + r2) continue;
        c.moveTo(p[0] + r2, p[1]); c.arc(p[0], p[1], r2, 0, TAU);
      }
      if (any) c.fill();
      if (q.embers) {
        c.save(); c.globalCompositeOperation = 'lighter';
        for (i = dec.length - 1; i >= 0; i--) {
          d = dec[i]; var age = t - d.t0; if (age > 1.4) break;
          if (age < 0) continue;
          p = X.itoS(d.x, d.y);
          c.fillStyle = 'rgba(255,150,60,' + (0.55 * (1 - age / 1.4)) + ')';
          c.beginPath(); c.arc(p[0], p[1], Math.max(1, d.r * s * 0.6), 0, TAU); c.fill();
        }
        c.restore();
      }
    }
    drawDoors(c, sh);
  }

  // ---------------------------------------------------------------- тела
  var DEADA = null, DEAD_TRIES = 0;
  // как и набор фигурок: телефон может потерять картинку — при потере (событие contextlost) пересборка помельче
  function deadAtlas() {
    var now = performance.now();
    if (!DEADA || (DEADA.bad && DEAD_TRIES < 3)) {
      var size = Math.round(Q().atlas * 2.2 / (1 + DEAD_TRIES * 0.35));
      try { DEADA = X.F.bakeDead(X.ALL, size, 16); DEADA.bad = !DEADA.canvas; } catch (e) { DEADA = { bad: true }; }
      DEAD_TRIES++; DEADA.at = now;
      // сброс — событием, без чтения точки из видеокарты (оно вешало слабый телефон)
      if (DEADA.canvas) { var D0 = DEADA; try { D0.canvas.addEventListener('contextlost', function() { D0.bad = true; }); } catch (e) {} }
    }
    return DEADA;
  }
  function drawDead(c, sh, T, vis) {
    var s = X.ICAM.s; if (s < 3) return;
    var ag = sh.crew.agents, t = sh.crew.t, A = deadAtlas(), FK = X.FIGK, DD = X.F.DEAD_DIRS, q = Q();
    var size = s * FK * (A.scale || 3), half = size / 2;
    c.globalAlpha = Math.min(1, (s - 3) / 2);
    for (var i = 0; i < ag.length; i++) {
      var m = ag[i]; if (!m || m.alive || !vis(m)) continue;
      var p = X.itoS(m.x, m.y);
      if (p[0] < -half || p[1] < -half || p[0] > X.CAM.vw + half || p[1] > X.CAM.vh + half) continue;
      var D = S.dead[i], dir = D ? D.dir : (((Math.round((m.aim + 0.6) / TAU * DD) % DD) + DD) % DD), Tf = X.ALL[m.fig] || X.ALL[0];
      var age = D ? t - D.t0 : 9;
      // age < 0: смерть уже пришла, болт ещё летит — стоит целым
      if (age < DEAD_T && (q.debris || !X.F.isDroid(Tf) || age < 0)) {
        c.save(); c.translate(p[0], p[1]); c.scale(s * FK, s * FK);
        X.F.dead(c, Tf, dir / DD * TAU, Math.max(0, age) / DEAD_T, dir);
        c.restore();
      } else if (A.canvas && !A.bad) {
        var kk = m.fig * DD + dir;
        c.drawImage(A.canvas, (kk % A.cols) * A.cell, Math.floor(kk / A.cols) * A.cell, A.cell, A.cell, p[0] - half, p[1] - half, size, size);
      } else {
        c.save(); c.translate(p[0], p[1]); X.F.corpse(c, Tf, m.aim + 0.6, s * FK); c.restore();
      }
    }
    c.globalAlpha = 1;
  }

  // ---------------------------------------------------------------- жетоны
  var PICS = {}, TOK = {};
  function portId(a) {
    var T = X.ALL[a.fig] || {}, u = a.utype;
    if (u && PORT[u]) return u;
    var id = PORT_ALIAS[T.id] || T.id;
    return PORT[id] ? id : null;
  }
  // Жетон с портретом: круг, лицо — верх картинки (как на пробной палубе); готовится один раз
  function token(id, team) {
    var key = id + ':' + team;
    if (TOK[key]) return TOK[key];
    var im = PICS[id];
    var model = PORT[id] === 2;
    if (!im) { im = PICS[id] = new Image(); im.src = '../assets/units/' + (model ? 'models/' : '') + id + '.jpg'; }
    if (!im.complete || !im.naturalWidth) return null;
    var N = 72, cv = document.createElement('canvas'); cv.width = cv.height = N;
    var c = cv.getContext('2d'), r = N / 2 - 1, ir = r * 0.84;
    c.fillStyle = '#0a0d14'; c.beginPath(); c.arc(N / 2, N / 2, r, 0, TAU); c.fill();
    c.save(); c.beginPath(); c.arc(N / 2, N / 2, ir, 0, TAU); c.clip();
    var iw = im.naturalWidth, ih = im.naturalHeight, sc = ir * 2 / Math.min(iw, ih);
    if (model) { var cw = Math.min(iw, ih) * 0.56; c.drawImage(im, (iw - cw) / 2, (ih - cw) / 2, cw, cw, N / 2 - ir, N / 2 - ir, ir * 2, ir * 2); }   // моделька — по центру кадра
    else c.drawImage(im, N / 2 - iw * sc / 2, N / 2 - ir, iw * sc, ih * sc);
    c.restore();
    TOK[key] = cv;
    return cv;
  }
  function drawTokens(c, sh, T, alpha, vis) {
    var s = X.ICAM.s, ag = sh.crew.agents, G = X.G, us = X.uSel(sh), sel = {}, i, a, p;
    us.forEach(function(u) { sel[u.id] = 1; });
    var dots = { 0: [], 1: [], crew: [] }, big = [], who = null;
    var rC = Math.max(2.2, s * 0.42), rK = Math.max(1.2, s * 0.24);
    for (i = 0; i < ag.length; i++) {
      a = ag[i]; if (!a || !a.alive || !vis(a)) continue;
      p = X.itoS(a.x, a.y);
      if (p[0] < -30 || p[1] < -30 || p[0] > X.CAM.vw + 30 || p[1] > X.CAM.vh + 30) continue;
      var combat = !!a.wpn;
      if (combat && rC >= 6) big.push([a, p]);
      else if (combat) dots[a.team === 1 ? 1 : 0].push(p, sel[a.id] ? 1 : 0);
      else dots.crew.push(p);
      if (G.who === a.id) who = p;
    }
    c.save(); c.globalAlpha = alpha;
    // экипаж — мелкие тусклые точки; бойцы — цветом стороны
    if (dots.crew.length && s >= 1.6) {
      c.fillStyle = 'rgba(160,172,186,0.55)'; c.beginPath();
      dots.crew.forEach(function(q) { c.moveTo(q[0] + rK, q[1]); c.arc(q[0], q[1], rK, 0, TAU); }); c.fill();
    }
    [0, 1].forEach(function(tm) {
      var L = dots[tm]; if (!L.length) return;
      c.fillStyle = 'rgb(' + X.TEAMC[tm] + ')'; c.strokeStyle = 'rgba(0,0,0,0.7)'; c.lineWidth = 1;
      c.beginPath();
      for (var k = 0; k < L.length; k += 2) { c.moveTo(L[k][0] + rC, L[k][1]); c.arc(L[k][0], L[k][1], rC, 0, TAU); }
      c.fill(); c.stroke();
      c.strokeStyle = '#f0c86a'; c.lineWidth = 2; c.beginPath(); var anyS = false;
      for (k = 0; k < L.length; k += 2) if (L[k + 1]) { c.moveTo(L[k][0] + rC + 1.5, L[k][1]); c.arc(L[k][0], L[k][1], rC + 1.5, 0, TAU); anyS = true; }
      if (anyS) c.stroke();
    });
    // крупные: портрет, здоровье дугой, куда смотрит — клин на кромке
    big.forEach(function(e) {
      var a = e[0], q = e[1], r = rC, col = X.TEAMC[a.team === 1 ? 1 : 0], pct = Math.max(0, Math.min(1, a.hp / (a.hpMax || 100)));
      c.fillStyle = 'rgba(0,0,0,0.5)'; c.beginPath(); c.ellipse(q[0] + r * 0.08, q[1] + r * 0.18, r * 1.02, r * 0.95, 0, 0, TAU); c.fill();
      if (sel[a.id]) {
        var gr = c.createRadialGradient(q[0], q[1], r * 0.8, q[0], q[1], r * 1.8);
        gr.addColorStop(0, 'rgba(240,200,106,' + (0.35 + 0.25 * (0.5 + 0.5 * Math.sin(T * 4))) + ')'); gr.addColorStop(1, 'rgba(240,200,106,0)');
        c.fillStyle = gr; c.beginPath(); c.arc(q[0], q[1], r * 1.8, 0, TAU); c.fill();
      }
      var id = portId(a), tk = id && token(id, a.team);
      if (tk) c.drawImage(tk, q[0] - r, q[1] - r, r * 2, r * 2);
      else {
        c.fillStyle = '#0a0d14'; c.beginPath(); c.arc(q[0], q[1], r, 0, TAU); c.fill();
        c.fillStyle = 'rgba(' + col + ',0.35)'; c.beginPath(); c.arc(q[0], q[1], r * 0.7, 0, TAU); c.fill();
      }
      var lw = Math.max(2, r * 0.15), r0 = r - lw / 2;
      c.lineWidth = lw; c.strokeStyle = 'rgba(20,24,30,0.95)'; c.beginPath(); c.arc(q[0], q[1], r0, 0, TAU); c.stroke();
      if (pct > 0) {
        c.strokeStyle = sel[a.id] ? '#f0c86a' : pct <= 0.3 ? '#ff8a3a' : 'rgb(' + col + ')';
        c.beginPath(); c.arc(q[0], q[1], r0, -Math.PI / 2, -Math.PI / 2 + TAU * pct); c.stroke();
      }
      var an = a.aim || 0, wx = q[0] + Math.cos(an) * (r + lw * 0.2), wy = q[1] + Math.sin(an) * (r + lw * 0.2);
      c.fillStyle = 'rgb(' + col + ')'; c.beginPath();
      c.moveTo(wx + Math.cos(an) * lw * 1.4, wy + Math.sin(an) * lw * 1.4);
      c.lineTo(wx + Math.cos(an + 1.9) * lw, wy + Math.sin(an + 1.9) * lw); c.lineTo(wx + Math.cos(an - 1.9) * lw, wy + Math.sin(an - 1.9) * lw);
      c.closePath(); c.fill();
    });
    // кого показали касанием («кто это») — кольцо, как у фигурок
    if (who) { c.strokeStyle = 'rgba(240,200,106,' + (0.7 + 0.3 * Math.sin(T * 6)) + ')'; c.lineWidth = 2; c.beginPath(); c.arc(who[0], who[1], Math.max(rC, 6) + 3, 0, TAU); c.stroke(); }
    c.restore();
  }

  // ---------------------------------------------------------------- поверх людей
  function drawOver(c, sh, T) {
    var s = X.ICAM.s, t = sh.crew.t, i, p;
    if (!S.parts.length && !S.nums.length) return;
    // дым — обычным смешением
    for (i = 0; i < S.parts.length; i++) {
      p = S.parts[i]; if (p.k !== 'smoke') continue;
      var k = p.life / p.max, q = X.itoS(p.x, p.y);
      c.fillStyle = 'rgba(70,76,86,' + (0.32 * k) + ')'; c.beginPath(); c.arc(q[0], q[1], p.r * (1.9 - k) * s * X.FIGK, 0, TAU); c.fill();
    }
    c.save(); c.globalCompositeOperation = 'lighter'; c.lineCap = 'round';
    // искры пачками по цвету и яркости: десяток обводок вместо сотни
    var bins = {};
    for (i = 0; i < S.parts.length; i++) {
      p = S.parts[i]; if (p.k !== 'spark') continue;
      var key = p.col + '|' + Math.ceil(p.life / p.max * 4);
      (bins[key] = bins[key] || []).push(p);
    }
    c.lineWidth = Math.max(1, s * 0.05);
    for (var bk in bins) {
      var kk = bk.split('|'), L = bins[bk];
      c.strokeStyle = 'rgba(' + kk[0] + ',' + (kk[1] / 4) + ')'; c.beginPath();
      for (var j = 0; j < L.length; j++) {
        var a = X.itoS(L[j].x, L[j].y), b = X.itoS(L[j].x - L[j].vx * 0.035, L[j].y - L[j].vy * 0.035);
        c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]);
      }
      c.stroke();
    }
    for (i = 0; i < S.parts.length; i++) {
      p = S.parts[i]; if (p.k !== 'boom') continue;
      var e = 1 - p.life / p.max, bq = X.itoS(p.x, p.y), R = p.r * s * X.FIGK * (0.5 + e * 0.9);
      var g = c.createRadialGradient(bq[0], bq[1], 0, bq[0], bq[1], R);
      g.addColorStop(0, 'rgba(255,240,200,' + (1 - e) + ')'); g.addColorStop(0.45, 'rgba(255,140,50,' + (0.7 * (1 - e)) + ')'); g.addColorStop(1, 'rgba(255,80,20,0)');
      c.fillStyle = g; c.beginPath(); c.arc(bq[0], bq[1], R, 0, TAU); c.fill();
    }
    c.restore();
    // цифры урона — читаются только вблизи
    if (S.nums.length && s >= 5) {
      c.save();
      c.font = 'bold ' + Math.round(Math.max(10, Math.min(13, s * 0.6))) + 'px "Courier New", monospace';
      c.textAlign = 'center'; c.textBaseline = 'middle'; c.lineWidth = 3; c.strokeStyle = 'rgba(3,5,9,0.9)';
      for (i = 0; i < S.nums.length; i++) {
        var n = S.nums[i], age = Math.max(0, t - n.t0), np = X.itoS(n.x, n.y), y = np[1] - age * 26;
        c.globalAlpha = Math.max(0, 1 - age / 0.8);
        c.strokeText('−' + n.v, np[0], y);
        c.fillStyle = n.mine ? '#ff9c8f' : '#f0d48a'; c.fillText('−' + n.v, np[0], y);
      }
      c.restore();
    }
  }

  // ---------------------------------------------------------------- мини-карта
  // Чертёж палубы, бойцы точками, рамка экрана. Касание — камера туда.
  function drawMini(c, sh, fitS) {
    S.mini = null;
    if (!X.gfx.get('mini') || X.ICAM.s < fitS * 1.3) return;
    var pl = sh.plan, v = X.view(), maxW = Math.min(132, X.CAM.vw * 0.34), maxH = Math.min(112, v.h * 0.24);
    var k = Math.min(maxW / pl.w, maxH / pl.h), mw = pl.w * k, mh = pl.h * k;
    var x = X.CAM.vw - mw - 14, y = v.top + 8;
    S.mini = { x: x, y: y, w: mw, h: mh, k: k };
    c.save();
    c.fillStyle = 'rgba(5,7,12,0.82)'; rrect(c, x - 5, y - 5, mw + 10, mh + 10, 7); c.fill();
    c.strokeStyle = '#2a3644'; c.lineWidth = 1; c.stroke();
    var clip = X.clip(sh);
    if (clip) { c.globalAlpha = 0.85; c.drawImage(clip, x, y, mw, mh); c.globalAlpha = 1; }
    var bd = X.boardOf(sh.n), ag = sh.crew.agents, own = [], foe = [];
    for (var i = 0; i < ag.length; i++) {
      var a = ag[i]; if (!a || !a.alive || a.gone || !a.wpn) continue;
      if (a.team === X.G.side) own.push(a); else if (!bd || X.seenIn(bd, a)) foe.push(a);
    }
    [[foe, X.TEAMC[1 - X.G.side]], [own, X.TEAMC[X.G.side]]].forEach(function(L) {
      if (!L[0].length) return;
      c.fillStyle = 'rgb(' + L[1] + ')';
      L[0].forEach(function(a) { c.fillRect(x + a.x * k - 1.25, y + a.y * k - 1.25, 2.5, 2.5); });
    });
    // рамка: свободная часть экрана между панелями
    var a0 = X.itoW(0, v.top), a1 = X.itoW(X.CAM.vw, v.bot);
    var rx = Math.max(x, x + a0[0] * k), ry = Math.max(y, y + a0[1] * k), rx2 = Math.min(x + mw, x + a1[0] * k), ry2 = Math.min(y + mh, y + a1[1] * k);
    c.strokeStyle = 'rgba(240,200,106,0.9)'; c.lineWidth = 1.2;
    c.strokeRect(rx, ry, Math.max(2, rx2 - rx), Math.max(2, ry2 - ry));
    c.restore();
  }
  function miniAt(px, py) {
    var m = S.mini; if (!m) return null;
    if (px < m.x - 6 || py < m.y - 6 || px > m.x + m.w + 6 || py > m.y + m.h + 6) return null;
    return [Math.max(0, Math.min(m.w, px - m.x)) / m.k, Math.max(0, Math.min(m.h, py - m.y)) / m.k];
  }
  function rrect(c, x, y, w, h, r) {
    c.beginPath(); c.moveTo(x + r, y); c.lineTo(x + w - r, y); c.quadraticCurveTo(x + w, y, x + w, y + r); c.lineTo(x + w, y + h - r);
    c.quadraticCurveTo(x + w, y + h, x + w - r, y + h); c.lineTo(x + r, y + h); c.quadraticCurveTo(x, y + h, x, y + h - r); c.lineTo(x, y + r);
    c.quadraticCurveTo(x, y, x + r, y); c.closePath();
  }
  // рамка выделения (экранные точки)
  function drawBox(c) {
    var b = S.box; if (!b) return;
    var x0 = Math.min(b.x0, b.x1), y0 = Math.min(b.y0, b.y1), w = Math.abs(b.x1 - b.x0), h = Math.abs(b.y1 - b.y0);
    c.save();
    c.fillStyle = 'rgba(240,200,106,0.08)'; c.fillRect(x0, y0, w, h);
    c.strokeStyle = 'rgba(240,200,106,0.9)'; c.lineWidth = 1.2; c.setLineDash([5, 4]); c.strokeRect(x0 + 0.5, y0 + 0.5, w, h);
    c.restore();
  }

  // Набор тел зависит от качества — пересобрать при смене
  function reset2() { DEADA = null; DEAD_TRIES = 0; }

  root.SPDeck = { init: init, update: update, drawUnder: drawUnder, drawDead: drawDead, drawTokens: drawTokens, drawOver: drawOver,
                  drawMini: drawMini, miniAt: miniAt, drawBox: drawBox, S: S, rebake: reset2 };
})(typeof self !== 'undefined' ? self : this);
