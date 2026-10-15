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

  // бои — общие с сервером (shared/rt-space-net.js)
  var NETLIB = window.SWSpaceNet, SCEN = NETLIB.SCEN;
  var SIDE_NAME = ['Республика', 'КНС'];
  var COL = { 0: { bolt: '#8fd0ff', core: '#e6f6ff', ui: '#4a90d9' }, 1: { bolt: '#ff6a55', core: '#ffe2d8', ui: '#d94a4a' } };

  var G = {
    B: null, scen: 'vp', side: 0, sel: -1, foe: -1, gsel: {}, mode: 'space', aim: false, move: false,
    plans: {}, imgs: {}, craftImg: {}, fx: { shots: [], booms: [], shields: [] }, ended: false, follow: true, room: null,
    view: -1, bsel: {}, bm: {}, vent: false, speed: 1, task: null
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
    return fetch('../shared/ships/' + id + '.json?v=5').then(function(r) {
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
  // scen — имя боя из списка, { cfg } своего боя или { name, ships } задачи;
  // opts: { idle — враг мишенью, task — задача полигона }
  function start(scen, side, opts) {
    opts = opts || {};
    G.opts = opts.task ? null : opts;
    if (G.net) netClose(true);
    var token = ++START;
    G.scen = scen; G.side = side;
    var sc = scObj(scen);
    if (!sc) { toast('Нет такого боя', 'bad'); return; }
    G.task = null; taskRow();
    toast('Готовлю бой: ' + sc.name + '…', 'gold');
    loadShips(sc).then(function() {
      if (token !== START) return;            // уже нажали другой бой
      // абордаж за противника решает ИИ, за игрока — сам игрок
      var B = makeBattle(sc, [G.side !== 0 && !opts.idle, G.side !== 1 && !opts.idle]);
      if (opts.idle) B.ships.forEach(function(s) { if (s.side !== G.side) window.SPTasks.idle(s); });
      setupBattle(B, scen);
      try { if (typeof scen === 'string') localStorage.setItem('sp-scen', scen); localStorage.setItem('sp-side', String(side)); } catch (e) {}
      if (opts.task) taskBegin(opts.task);
      else toast('Бой начался. Выбери пушки и цель', 'gold');
    }).catch(function(e) { toast('Не загрузилось: ' + e.message, 'bad'); });
  }
  function loadShips(sc) {
    var ids = []; sc.ships.forEach(function(s) { if (ids.indexOf(s[0]) < 0) ids.push(s[0]); });
    return Promise.all(ids.map(loadPlan).concat([loadCraft()]));
  }
  // s: [класс, сторона, x, y, армия] — армия из игры («Мой флот») или типовая для полигона
  function makeBattle(sc, aiBoard) {
    var B = new SP.Battle({ seed: 1977 + Date.now() % 1000, aiBoard: aiBoard });
    sc.ships.forEach(function(s) {
      var plan = G.plans[s[0]], army = s[4] || window.SWArmy.typicalArmy(s[0]);
      // каждый бой — свежий экипаж (состояние живёт в Crew, план общий и не меняется)
      B.addShip({ cls: s[0], plan: plan, side: s[1], x: s[2], y: s[3], hd: s[1] === 0 ? 0 : Math.PI, figMap: F.crewFigs(plan.faction, ALL), figIds: FIG_IDS,
                  army: army, name: army.name || window.SWArmy.shipName(s[0]) });
    });
    return B;
  }
  // Новый бой на экране (свой или сетевой): сброс выбора, камеры и панелей
  function setupBattle(B, scen) {
    var i;
    G.who = null; IN.ship = -1; if (!G.speed) G.speed = G.lastSpd || 1;
    G.B = B; G.fx = { shots: [], booms: [], shields: [] }; DOWN = {}; G.wrecks = []; G.ended = false; G.gsel = {}; G.aim = false; G.move = false; G.room = null;
    G.sel = -1; G.foe = -1; G.bsel = {}; G.bm = {}; G.vent = false; G.quiet = false;
    for (i = 0; i < B.ships.length; i++) if (B.ships[i].side === G.side) { G.sel = i; break; }
    for (i = 0; i < B.ships.length; i++) if (B.ships[i].side !== G.side) { G.foe = i; break; }
    CHUNKS.clear(); TIER_N = { 4: 0, 8: 0, 16: 0, 32: 0 };
    setMode('space');
    buildFleet(); buildShipPanel(); hud(); fitAll();
    $('sp-end').hidden = true;
    $('sp-top').classList.toggle('cis', G.side === 1);
    $('sp-side').textContent = SIDE_NAME[G.side];
    var chips = document.querySelectorAll('#sp-scen .sp-chip[data-scen]');
    for (i = 0; i < chips.length; i++) {
      var on = chips[i].getAttribute('data-scen') === scen;
      chips[i].classList.toggle('on', on);
      if (on) { var row = $('sp-scen'), c = chips[i]; row.scrollLeft = Math.max(0, c.offsetLeft - row.offsetLeft - (row.clientWidth - c.offsetWidth) / 2); }
    }
    netRow();
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
    B.ships.forEach(function(s) {
      if (s.dead) return;
      var p = shownPos(s); if (!p) return;          // скрытый туманом — по последней засечке
      x0 = Math.min(x0, p.x - s.len / 2); x1 = Math.max(x1, p.x + s.len / 2); y0 = Math.min(y0, p.y - s.len / 2); y1 = Math.max(y1, p.y + s.len / 2);
    });
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
    if (G.net) { if (!G.net.M || !G.net.M.update()) { drawSpace(t / 1000); return; } netView(); }
    else if (!G.ended && G.speed) { B.step(dt * G.speed); taskStep(dt * G.speed); }
    takeFx();
    if (G.mode === 'space' && G.follow === 'ship' && G.sel >= 0) {
      var sh = B.ships[G.sel];
      if (sh && !sh.dead) { var v = view(); CAM.x += (sh.x - CAM.x) * Math.min(1, dt * 3); CAM.y += (sh.y - (v.cy - CAM.vh / 2) / CAM.s - CAM.y) * Math.min(1, dt * 3); }
    } else if (G.mode === 'space' && G.follow === 'all') {
      var f = fitRect(), k = Math.min(1, dt * 1.5);
      if (f) { CAM.s = Math.exp(Math.log(CAM.s) + (Math.log(f.s) - Math.log(CAM.s)) * k); CAM.x += (f.x - CAM.x) * k; CAM.y += (f.y - CAM.y) * k; }
    }
    if (G.mode === 'inside' && (!B.ships[G.view] || B.ships[G.view].dead)) setMode('space');
    if (G.mode === 'inside') { loadStep(); drawInside(t / 1000); } else drawSpace(t / 1000);
    FR.hud += dt;
    if (FR.hud > 0.25) { FR.hud = 0; hud(); taskRow(); speedUi(); $('sp-fps').textContent = Math.round(FR.fps); }
    if (B.over >= 0 && !G.ended) endBattle();
  }
  function now() { return G.B.t + (G.B.acc || 0); }
  // остовы живут по настоящим часам: после конца боя расчёт стоит, а обломки — нет
  function T0() { return performance.now() / 1000; }

  // ---------------------------------------------------------------- звук
  // Громкость и панорама события в точке мира: на экране — в полную силу,
  // за краем — тише; в общем обзоре всё дальше и тише, вблизи — громче.
  // Внутри корабля громко только то, что касается своего корабля.
  function sfx(kind, x, y, shipN) {
    var X = window.SPSfx; if (!X) return;
    var vol, pan = 0;
    if (G.mode === 'inside') {
      var me = G.B.ships[G.view];
      var mine = shipN === G.view || (shipN == null && me && Math.abs(x - me.x) + Math.abs(y - me.y) < me.len * 0.8);
      vol = mine ? 0.95 : 0.22;
    } else {
      var p = toS(x, y), hx = CAM.vw / 2, hy = CAM.vh / 2;
      var dx = (p[0] - hx) / hx, dy = (p[1] - hy) / hy, d = Math.sqrt(dx * dx + dy * dy);
      var att = d <= 1.2 ? 1 : Math.max(0, 1 - (d - 1.2) / 2.5);
      var z = Math.max(0.35, Math.min(1, 0.35 + 0.65 * Math.log(CAM.s / 0.01) / Math.log(35)));
      vol = att * (kind === 'shipboom' ? Math.max(z, 0.75) : z);
      pan = Math.max(-1, Math.min(1, dx)) * 0.6;
    }
    X.play(kind, vol, pan);
  }

  var DOWN = {};       // когда последний раз сообщали «упал щит» по сектору
  // События расчёта → эффекты с временем жизни
  function takeFx() {
    var e = G.B.takeEvents(), fx = G.fx, i;
    for (i = 0; i < e.shots.length; i++) {
      var sh0 = e.shots[i]; fx.shots.push(sh0);
      sfx(sh0.t === 'f' ? 'fighter' : sh0.t, sh0.x0, sh0.y0, null);
    }
    for (i = 0; i < e.booms.length; i++) {
      var bm = e.booms[i]; fx.booms.push(bm);
      sfx(bm.craft ? 'craftboom' : bm.big ? 'shipboom' : bm.ion ? 'ionhit' : 'hull', bm.x, bm.y, bm.ship);
    }
    for (i = 0; i < e.shields.length; i++) {
      fx.shields.push(e.shields[i]);
      sfx('shield', e.shields[i].x, e.shields[i].y, e.shields[i].ship);
      var sh = G.B.ships[e.shields[i].ship];
      var sk = e.shields[i].ship + ':' + e.shields[i].s;
      if (e.shields[i].down && sh && sh.side === G.side && (DOWN[sk] == null || G.B.t - DOWN[sk] > 25) && ((DOWN[sk] = G.B.t), true)) toast(sh.name + ': упал щит — ' + ['нос', 'правый борт', 'корма', 'левый борт'][e.shields[i].s], 'bad');
    }
    boardMsgs();
    // таран: свой корабль ударился о чужой корпус
    (e.rams || []).forEach(function(r) {
      var a = G.B.ships[r.a], b = G.B.ships[r.b]; if (!a || !b) return;
      var mine = a.side === G.side ? a : b.side === G.side ? b : null; if (!mine) return;
      var other = mine === a ? b : a;
      sfx('shipboom', mine.x, mine.y, mine.n);
      toast('Столкновение: ' + mine.name + ' и ' + other.name + ' (' + r.v + ' м/с)', 'bad');
    });
    for (i = 0; i < e.boards.length; i++) {
      var be = e.boards[i], bs = G.B.ships[be.n], bt = G.B.ships[be.t];
      if (!be.dock && bs.side !== G.side && bt.side === G.side) toast('Абордаж! ' + bs.name + ' → ' + bt.name + ': ' + be.count + ' бойцов в шаттлах. Бей по ним ПВО', 'bad');
    }
    for (i = 0; i < e.kills.length; i++) {
      var k = e.kills[i];
      if (k.craft === 'shuttle' && k.party) toast('Сбит абордажный шаттл: ' + k.party + ' ' + plural(k.party, 'боец', 'бойца', 'бойцов') + (k.side === G.side ? ' погибли' : ' врага не дошли'), k.side === G.side ? 'bad' : 'gold');
      if (k.ship != null && k.why === 'captured') {
        var cs = G.B.ships[k.ship];
        toast(cs.name + ' захвачен' + (k.by === G.side ? ' — трофей наш!' : ' врагом'), k.by === G.side ? 'gold' : 'bad');
        if (k.ship === G.foe) { G.aim = false; G.foe = -1; }
        if (k.ship === G.sel) { var nx = G.B.ships.filter(function(x) { return !x.dead && x.side === G.side; })[0]; if (nx) { if (G.mode === 'inside') setMode('space'); selectShip(nx.n); } }
        buildTargets(); hud();
        continue;
      }
      if (k.ship != null) {
        var s = G.B.ships[k.ship];
        // остов: корабль раскалывается на куски своей же картинки
        if (window.SPWreck && G.imgs[s.cls]) { try { G.wrecks.push(window.SPWreck.make(s, G.imgs[s.cls], s.plan, k.why, T0())); s.wreck = true; } catch (er) {} }
        toast(s.name + ' уничтожен' + (k.why === 'reactor' ? ' — взрыв реактора' : k.why === 'ram' ? ' — столкновение' : ''), s.side === G.side ? 'bad' : 'gold');
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

  // ---------------------------------------------------------------- абордаж
  // Команда абордажа и защитники — тела экипажа корабля-цели (rt-crew), бой ведёт
  // rt-board. Здесь: панель приказов, отрисовка дверей, турелей, выстрелов, захвата.
  var TEAMC = { 0: '111,184,255', 1: '255,110,90' };
  var BD = window.SWBoard;
  function boardOf(n) { var s = G.B && G.B.ships[n]; var b = s && s.crew.board; return b && b.started ? b : null; }
  function liveBoards() {
    var out = [];
    G.B.ships.forEach(function(s) {
      var b = boardOf(s.n);
      if (b && b.over < 0 && !s.dead && (b.att === G.side || b.def === G.side)) out.push({ sh: s, b: b, mine: b.att === G.side });
    });
    return out;
  }
  // Смотрим внутрь вражеского корабля, где идёт наш абордаж
  function attView() {
    if (G.mode !== 'inside') return null;
    var s = G.B.ships[G.view], b = s && boardOf(s.n);
    return b && b.att === G.side && s.side !== G.side ? b : null;
  }
  // Смотрим внутрь своего корабля, на который высадился враг
  function defView() {
    if (G.mode !== 'inside') return null;
    var s = G.B.ships[G.view], b = s && boardOf(s.n);
    return b && b.def === G.side && s.side === G.side && b.over < 0 ? b : null;
  }
  // Абордажные шаттлы врага, что летят к нашим кораблям: [{c, ship, eta}]
  function shuttlesIn() {
    var B = G.B, out = [];
    for (var i = 0; i < B.craft.length; i++) {
      var c = B.craft[i];
      if (c.dead || c.role !== 'shuttle' || c.side === G.side || c.back || !B.visC[G.side][c.id]) continue;
      var t = c.tgt != null ? B.ships[c.tgt] : null;
      if (!t) { var bd = 1e18; B.ships.forEach(function(s) { if (s.side !== G.side || s.dead) return; var d = (s.x - c.x) * (s.x - c.x) + (s.y - c.y) * (s.y - c.y); if (d < bd) { bd = d; t = s; } }); }
      if (!t || t.side !== G.side || t.dead) continue;
      var d0 = Math.sqrt((t.x - c.x) * (t.x - c.x) + (t.y - c.y) * (t.y - c.y));
      out.push({ c: c, ship: t, eta: Math.max(1, d0 / 200) });
    }
    return out;
  }
  function mmss(t) { t = Math.max(0, t | 0); return Math.floor(t / 60) + ':' + ('0' + t % 60).slice(-2); }
  // Сообщения абордажа — всплывашками (свои успехи золотом, беды красным)
  function boardMsgs() {
    G.B.ships.forEach(function(s) {
      var b = s.crew.board; if (!b) return;
      if (G.bm[s.n] && G.bm[s.n].b !== b) G.bm[s.n] = null;
      var st = G.bm[s.n] || (G.bm[s.n] = { b: b, seq: 0 });
      var list = b.ev.msgs;
      for (var i = 0; i < list.length; i++) {
        var m = list[i]; if (m.seq <= st.seq) continue;
        st.seq = m.seq;
        if (b.att !== G.side && b.def !== G.side) continue;
        var good = (m.team === G.side) === (m.kind !== 'bad');
        toast(s.name + ': ' + m.text, good ? 'gold' : 'bad');
      }
    });
  }
  // Ключевые отсеки — кнопки целей: по одному на тип, ближайший к выбранным отрядам
  var OBJ = [['bridge', 'Мостик'], ['reactor', 'Реактор'], ['shield', 'Щиты'], ['comms', 'Связь'], ['power', 'Энергоузел'],
             ['engine', 'Двигатели'], ['hangar', 'Ангар'], ['pumps', 'Насосная'], ['cic', 'Тактика'], ['armory', 'Арсенал'], ['medbay', 'Лазарет']];
  function squadCenter(b, ids) {
    var x = 0, y = 0, n = 0, ag = b.c.agents;
    b.squads.forEach(function(q) {
      if (ids && !ids[q.id]) return;
      q.members.forEach(function(id) { var a = ag[id]; if (a && a.alive) { x += a.x; y += a.y; n++; } });
    });
    return n ? [x / n, y / n] : null;
  }
  function selIds() { var k = Object.keys(G.bsel).filter(function(i) { return G.bsel[i]; }); return k.length ? k.map(Number) : null; }
  function objectives(sh, b) {
    var sel = selIds(), selMap = {}; if (sel) sel.forEach(function(i) { selMap[i] = 1; });
    var c = squadCenter(b, sel ? selMap : null) || [sh.plan.w / 2, sh.plan.h / 2], out = [];
    OBJ.forEach(function(o) {
      var rooms = sh.plan.rooms.filter(function(r) { return r.t === o[0]; });
      if (!rooms.length) return;
      var held = 0, fight = 0, best = null, bd = 1e18;
      rooms.forEach(function(r) {
        var s = b.rs[r.n]; if (s.held) held++; if (s.cnt[0] && s.cnt[1]) fight++;
        var dx = r.cx - c[0], dy = r.cy - c[1], d = dx * dx + dy * dy;
        if (!s.held && d < bd) { bd = d; best = r; }
      });
      if (!best) best = rooms[0];
      var st = b.rs[best.n], state = held === rooms.length ? 'held' : fight ? 'fight' : st.hold > 0 ? 'taking' : '';
      var sub = state === 'held' ? 'наш' : state === 'fight' ? 'бой' : state === 'taking' ? 'захват ' + Math.floor(st.hold) + '/6' : (BD.ROOM_EFF[o[0]] || '');
      if (o[0] === 'bridge' && st.held) sub = Math.floor(b.bridgeT) + '/' + b.holdNeed + ' с';
      if (rooms.length > 1) sub += ' · ' + held + '/' + rooms.length;
      out.push({ n: best.n, name: o[1], sub: sub, state: state });
    });
    return out;
  }
  // Полоса абордажа в панели своего корабля: запуск, ход своих абордажей, враг на борту
  function boardStrip(sh) {
    var B = G.B, out = '';
    liveBoards().forEach(function(o) {
      var s = o.b.summary();
      if (!o.mine && o.sh.n === sh.n) {
        out += '<div class="sp-bd-strip bad"><span>Враг на борту: <b>' + s.att + '</b> · наши бойцы <b>' + s.def + '</b>' + heldCount(o.b) + defShort(o.b) + '</span>' +
          '<button class="sp-mini gold" data-ba="look" data-n="' + o.sh.n + '">Оборона ›</button>' +
          '<button class="sp-mini' + (o.b.alarm ? ' on' : '') + '" data-ba="alarm" data-n="' + o.sh.n + '">Тревога</button></div>';
      } else if (o.mine) {
        out += '<div class="sp-bd-strip"><span>Абордаж · <b>' + esc(o.sh.name) + '</b>: наших <b>' + s.att + '</b> · защитников <b>' + s.def + '</b>' + goalShort(o.b) + '</span>' +
          '<button class="sp-mini gold" data-ba="look" data-n="' + o.sh.n + '">Внутрь ›</button></div>';
      }
    });
    // шаттлы врага летят к нам: успеть сбить ПВО
    var inc = shuttlesIn().filter(function(x) { return x.ship.n === sh.n; });
    if (inc.length && !sh.dead) {
      var eta = Math.min.apply(null, inc.map(function(x) { return x.eta; }));
      var pdOn = sh.guns.some(function(g) { return g.tgt.k === 'shuttles'; });
      out += '<div class="sp-bd-strip bad"><span>Шаттлы абордажа: <b>' + inc.length + '</b> · до стыковки <b>~' + Math.ceil(eta) + ' с</b></span>' +
        '<button class="sp-mini' + (pdOn ? ' on' : ' gold') + '" data-ba="pdshut">' + (pdOn ? 'Огонь по шаттлам ✓' : 'Огонь по шаттлам') + '</button></div>';
    }
    var foe = B.ships[G.foe];
    if (foe && !foe.dead && seen(foe) && !sh.dead) {
      var own = !!(sh.crew.board && sh.crew.board.started && sh.crew.board.over < 0 && sh.crew.board.def === G.side);
      var can = B.canBoard(sh.n, foe.n, own), fly = foe.inbound;
      out += '<div class="sp-bd-go"><span class="sp-dim">абордаж · <b>' + esc(foe.name) + '</b></span>' +
        (can.ok ? '<button class="sp-mini gold" data-ba="go">' + (can.reinforce ? 'Подкрепление ' : own ? 'Контрабордаж ' : 'Высадить ') + can.party + '</button>'
                : '<span class="why">' + esc(can.why) + '</span>') +
        (fly ? '<span class="fly">в полёте ' + fly + ' ' + plural(fly, 'шаттл', 'шаттла', 'шаттлов') + '</span>' : '') + '</div>';
    }
    return out;
  }
  // Самое срочное для защитника — коротко в полосу
  function defShort(b) {
    if (b.charge && b.charge.armed) return ' · <b>заряд ' + Math.ceil(b.charge.left) + ' с!</b>';
    var br = b.bridge && b.rs[b.bridge];
    if (br && br.held) return ' · <b>мостик у врага ' + Math.floor(b.bridgeT) + '/' + b.holdNeed + '</b>';
    return '';
  }
  function heldCount(b) { var n = 0; for (var k in b.rs) if (b.rs[k].held) n++; return n ? ' · у врага отсеков <b>' + n + '</b>' : ''; }
  function goalShort(b) {
    if (b.charge) return b.charge.armed ? ' · заряд <b>' + Math.ceil(b.charge.left) + ' с</b>' : ' · ставим заряд';
    var br = b.bridge && b.rs[b.bridge];
    return br && br.held ? ' · мостик <b>' + Math.floor(b.bridgeT) + '/' + b.holdNeed + '</b>' : '';
  }
  // Панель абордажа: смотрим внутрь вражеского корабля
  function boardPanel(sh, b) {
    var s = b.summary();
    var head = '<div class="sp-ship-head"><b>Абордаж · ' + esc(sh.name) + '</b><span class="sp-tag">' + mmss(b.t) + '</span>' +
      '<span class="r">в шлюзах до <i>' + SP.boardCap(sh) + '</i></span></div>' +
      '<div class="sp-bd-count">наши <b>' + s.att + '</b><span>·</span>защитники <b class="foe">' + s.def + '</b><span>·</span>экипаж <b>' + s.crew + '</b>' +
      (sh.inbound ? '<span>·</span>в полёте <b>' + sh.inbound + '</b>' : '') + '</div>';
    var goal, pct;
    if (b.charge) {
      goal = b.charge.armed ? 'Заряд у реактора: взрыв через <b>' + Math.ceil(b.charge.left) + ' с</b>' + (b.charge.defuse > 0 ? ' · <b class="foe">снимают!</b>' : '') : 'Инженер ставит заряд у реактора…';
      pct = b.charge.armed ? 1 - b.charge.left / BD.FUSE : 1 - b.charge.plant / BD.PLANT;
    } else {
      var br = b.bridge && b.rs[b.bridge];
      if (!br) { goal = 'Мостика нет — цель: реактор'; pct = 0; }
      else if (br.held) { goal = 'Мостик наш: удержать <b>' + Math.floor(b.bridgeT) + ' / ' + b.holdNeed + ' с</b>' + (br.cnt[b.def] ? ' · <b class="foe">враг на мостике</b>' : ''); pct = b.bridgeT / b.holdNeed; }
      else if (br.hold > 0) { goal = 'Мостик: захват <b>' + Math.floor(br.hold) + ' / 6 с</b>'; pct = br.hold / 6 * 0.2; }
      else { goal = 'Цель — мостик: занять и удержать ' + b.holdNeed + ' с. Или заряд у реактора'; pct = 0; }
    }
    var gl = '<div class="sp-bd-goal"><span>' + goal + '</span><div class="sp-bar gold"><i style="width:' + Math.round(Math.max(0, Math.min(1, pct)) * 100) + '%"></i></div></div>';
    var none = !selIds();
    var sq = '<div class="sp-bd-row"><span class="lab">отряды</span><button class="sp-chip' + (none ? ' on' : '') + '" data-bsq="all">все</button>' +
      s.sq.map(function(q) {
        var r = sh.plan.roomByN[q.room];
        return '<button class="sp-chip' + (G.bsel[q.id] ? ' on' : '') + (q.n ? '' : ' dead') + '" data-bsq="' + q.id + '"><b>' + q.id + '</b> · ' + q.n +
          (r && q.n ? ' <em>' + esc(shortRoom(r.name)) + (q.auto ? '' : ' ✓') + '</em>' : '') + '</button>';
      }).join('') + '</div>';
    var grid = '<div class="sp-bd-row sp-bd-objs">' + objectives(sh, b).map(function(o) {
      return '<button class="sp-bd-obj ' + o.state + '" data-bo="' + o.n + '"><b>' + o.name + '</b><span>' + esc(o.sub) + '</span></button>';
    }).join('') + '</div>';
    var plant = b.canPlant(), vent = b.canVent(G.side), can = G.B.canBoard(G.sel, sh.n);
    var acts = '<div class="sp-btns sp-bd-acts">' +
      '<button class="sp-btn' + (plant === '' ? ' red' : ' off') + '" data-ba="plant" title="' + esc(plant || '') + '">Заряд в реактор</button>' +
      '<button class="sp-btn' + (vent === '' ? '' : ' off') + (G.vent ? ' on' : '') + '" data-ba="vent" data-n="' + sh.n + '" title="' + esc(vent || '') + '">' + (G.vent ? 'Отсек?' : 'Продуть отсек') + '</button>' +
      '<button class="sp-btn' + (can.ok ? ' gold' : ' off') + '" data-ba="go" title="' + esc(can.why || '') + '">' + (can.ok ? 'Ещё ' + can.party : 'Подкрепление') + '</button></div>';
    var me = G.B.ships[G.sel], hold = me && me.hold && me.hold[sh.n];
    acts += '<div class="sp-bd-fire"><span>Наши пушки по «' + esc(sh.name) + '»: ' + (hold ? '<b class="foe">молчат</b>' : '<b>бьют по её орудиям</b>, мимо отсеков с нашими') + '</span>' +
      '<button class="sp-mini' + (hold ? ' gold' : '') + '" data-ba="hold" data-n="' + sh.n + '">' + (hold ? 'Открыть огонь' : 'Прекратить огонь') + '</button></div>';
    var why = plant && plant !== null && !b.charge && b.rs[b.reactor] ? '' : '';
    var hint = '<div class="sp-dim sp-bd-hint">' + (G.vent ? 'Коснись отсека для продувки — удар по всем внутри' :
      'Коснись отсека на схеме — ' + (none ? 'все отряды' : 'выбранные') + ' пойдут туда') + why + '</div>';
    return head + gl + sq + grid + acts + hint;
  }
  // Панель обороны: смотрим внутрь своего корабля, на который высадился враг
  function defPanel(sh, b) {
    var s = b.summary(), ds = s.dsq || [];
    var head = '<div class="sp-ship-head"><b>Оборона · ' + esc(sh.name) + '</b><span class="sp-tag warn">' + mmss(b.t) + '</span>' +
      '<span class="r">шлюзы врага до <i>' + SP.boardCap(sh) + '</i></span></div>' +
      '<div class="sp-bd-count">враг <b class="foe">' + s.att + '</b><span>·</span>наши бойцы <b>' + s.def + '</b><span>·</span>экипаж <b>' + s.crew + '</b>' +
      (sh.inbound ? '<span>·</span>шаттлов в пути <b class="foe">' + sh.inbound + '</b>' : '') + '</div>';
    var goal, pct, br = b.bridge && b.rs[b.bridge], bad = true;
    if (b.charge && b.charge.armed) {
      goal = 'Заряд у реактора: взрыв через <b class="foe">' + Math.ceil(b.charge.left) + ' с</b>. ' + (b.charge.defuse > 0 ? 'Снимаем: <b>' + Math.floor(b.charge.defuse) + ' / ' + BD.DEFUSE + ' с</b>' : 'Выбей врага из реакторного зала — боец снимет заряд за ' + BD.DEFUSE + ' с');
      pct = b.charge.defuse > 0 ? b.charge.defuse / BD.DEFUSE : 1 - b.charge.left / BD.FUSE;
    } else if (b.charge) {
      goal = 'Враг ставит заряд у реактора — <b class="foe">убей инженера</b>'; pct = 1 - b.charge.plant / BD.PLANT;
    } else if (br && br.held) {
      goal = 'Мостик у врага: удержание <b class="foe">' + Math.floor(b.bridgeT) + ' / ' + b.holdNeed + ' с</b> — отбей, иначе корабль потерян'; pct = b.bridgeT / b.holdNeed;
    } else if (br && br.hold > 0 && br.cnt[b.att]) {
      goal = 'Враг берёт мостик: <b class="foe">' + Math.floor(br.hold) + ' / ' + BD.CAPTURE + ' с</b>'; pct = br.hold / BD.CAPTURE * 0.3;
    } else {
      goal = 'Не дай врагу удержать мостик ' + b.holdNeed + ' с и поставить заряд у реактора. Выбей всех — абордаж отбит';
      pct = 0; bad = false;
    }
    var gl = '<div class="sp-bd-goal"><span>' + goal + '</span><div class="sp-bar ' + (bad ? 'red' : 'gold') + '"><i style="width:' + Math.round(Math.max(0, Math.min(1, pct)) * 100) + '%"></i></div></div>';
    var none = !selIds();
    var sq = '<div class="sp-bd-row"><span class="lab">отряды</span><button class="sp-chip' + (none ? ' on' : '') + '" data-bsq="all">все</button>' +
      ds.map(function(q) {
        var r = sh.plan.roomByN[q.room];
        return '<button class="sp-chip' + (G.bsel[q.id] ? ' on' : '') + (q.n ? '' : ' dead') + '" data-bsq="' + q.id + '"><b>' + q.id + '</b> · ' + q.n +
          (q.n ? ' <em>' + (q.auto ? 'сами' : esc(shortRoom(r ? r.name : '')) + ' ✓') + '</em>' : '') + '</button>';
      }).join('') + '</div>';
    var grid = '<div class="sp-bd-row sp-bd-objs">' + defObjectives(sh, b).map(function(o) {
      return '<button class="sp-bd-obj ' + o.state + '" data-bo="' + o.n + '"><b>' + o.name + '</b><span>' + esc(o.sub) + '</span></button>';
    }).join('') + '</div>';
    var vent = b.canVent(G.side), hasCharge = !!(b.charge && b.reactor);
    var acts = '<div class="sp-btns sp-bd-acts sp-bd-acts4">' +
      '<button class="sp-btn' + (G.dmode === 'door' ? ' on' : '') + '" data-ba="dmode">' + (G.dmode === 'door' ? 'Дверь?' : 'Двери') + '</button>' +
      '<button class="sp-btn' + (G.dmode === 'weld' ? ' on' : '') + '" data-ba="wmode">' + (G.dmode === 'weld' ? 'Какую?' : 'Заварить') + '</button>' +
      '<button class="sp-btn' + (vent === '' ? '' : ' off') + (G.vent ? ' on' : '') + '" data-ba="vent" data-n="' + sh.n + '" title="' + esc(vent || '') + '">' + (G.vent ? 'Отсек?' : 'Продуть') + '</button>' +
      '<button class="sp-btn' + (b.alarm ? ' on' : '') + '" data-ba="alarm" data-n="' + sh.n + '">Тревога</button></div>' +
      '<div class="sp-btns sp-bd-acts sp-bd-acts4">' +
      '<button class="sp-btn' + (br ? ' gold' : ' off') + '" data-ba="dbridge">На мостик</button>' +
      '<button class="sp-btn' + (hasCharge ? ' red' : ' off') + '" data-ba="ddefuse">Снять заряд</button>' +
      '<button class="sp-btn" data-ba="dauto">Сами</button>';
    var foe = attackerOf(b), can = foe ? G.B.canBoard(sh.n, foe.n, true) : null;
    acts += '<button class="sp-btn' + (can && can.ok ? ' gold' : ' off') + '" data-ba="counter" data-n="' + (foe ? foe.n : -1) + '" title="' + esc(can ? can.why || '' : 'врага не видно') + '">' + (can && can.ok ? 'Контра ' + can.party : 'Контра') + '</button></div>';
    var hint = '<div class="sp-dim sp-bd-hint">' + (G.vent ? 'Коснись отсека для продувки — удар по всем внутри, и по своим' :
      G.dmode === 'door' ? 'Коснись двери: запереть или открыть. Запертую обычную дверь враг вскрывает 5 с, броню и шлюз — 10 с' :
      G.dmode === 'weld' ? 'Коснись запертой двери: ремонтник заварит её за ' + BD.WELD + ' с — вскрывать вдвое дольше' :
      'Коснись отсека — ' + (none ? 'все отряды' : 'выбранные') + ' встанут там. «Сами» — снова решают сами. «Контра» — абордаж в ответ') + '</div>';
    return head + gl + sq + grid + acts + hint;
  }
  // Ключевые отсеки глазами защитника: свой, бой, враг берёт, у врага
  function defObjectives(sh, b) {
    var out = [];
    OBJ.forEach(function(o) {
      var rooms = sh.plan.rooms.filter(function(r) { return r.t === o[0]; });
      if (!rooms.length) return;
      var held = 0, fight = 0, taking = 0, best = rooms[0];
      rooms.forEach(function(r) {
        var st = b.rs[r.n]; if (!st) return;
        if (st.held) { held++; best = r; }
        else if (st.cnt[b.att] && st.cnt[b.def]) { fight++; if (!held) best = r; }
        else if (st.hold > 0 && st.cnt[b.att]) { taking++; if (!held && !fight) best = r; }
      });
      var state = held ? 'lost' : fight ? 'fight' : taking ? 'taking' : '';
      var sub = held ? 'у врага' + (rooms.length > 1 ? ' ' + held + '/' + rooms.length : '') : fight ? 'бой' : taking ? 'враг берёт' : 'наш';
      if (o[0] === 'bridge' && held) sub = 'у врага ' + Math.floor(b.bridgeT) + '/' + b.holdNeed;
      if (o[0] === 'reactor' && b.charge) { sub = b.charge.armed ? 'заряд ' + Math.ceil(b.charge.left) + ' с' : 'ставят заряд'; state = 'lost'; }
      out.push({ n: best.n, name: o[1], sub: sub, state: state });
    });
    return out;
  }
  // Чей десант на нашем корабле: самый крупный живой корабль стороны атакующих
  function attackerOf(b) {
    var best = null;
    G.B.ships.forEach(function(s) { if (!s.dead && s.side === b.att && seen(s) && (!best || s.len > best.len)) best = s; });
    return best;
  }
  function shortRoom(n) { return n.replace(/ \(.*\)$/, '').replace(/^(Главный|Командный) /, '').slice(0, 14); }
  function boardAction(k, n, el) {
    var B = G.B, sh, b;
    if (k === 'go') {
      var tgt = G.mode === 'inside' && attView() ? G.view : G.foe;
      var mb = B.ships[G.sel] && B.ships[G.sel].crew.board, own = !!(mb && mb.started && mb.over < 0 && mb.def === G.side);
      var r = B.board(G.sel, tgt, own);
      if (r.ok) toast('На абордаж: ' + r.party + ' ' + plural(r.party, 'боец', 'бойца', 'бойцов') + ' в ' + r.shuttles + ' ' + plural(r.shuttles, 'шаттле', 'шаттлах', 'шаттлах') + '. Прикрой их от ПВО', 'gold');
      else toast(r.why, 'bad');
    } else if (k === 'look') {
      setMode('inside', +n);
    } else if (k === 'dmode' || k === 'wmode') {
      var md = k === 'dmode' ? 'door' : 'weld';
      G.dmode = G.dmode === md ? null : md; G.vent = false;
      if (G.dmode) toast(md === 'door' ? 'Коснись двери на схеме' : 'Коснись запертой двери', 'gold');
    } else if (k === 'dbridge' || k === 'ddefuse') {
      b = defView(); if (!b) return;
      var room = k === 'dbridge' ? b.bridge : b.reactor;
      if (!room) { toast(k === 'dbridge' ? 'Мостика нет' : 'Реактора нет', 'bad'); return; }
      if (k === 'ddefuse' && !b.charge) { toast('Заряда нет', 'bad'); return; }
      var cnt = b.order(G.side, null, room);
      G.bsel = {};
      toast(cnt ? (k === 'dbridge' ? 'Все отряды — на мостик' : 'Все отряды — в реакторный зал: выбить врага и снять заряд') : 'Некому идти', cnt ? 'gold' : 'bad');
      var rr0 = G.B.ships[G.view].plan.roomByN[room], vv0 = view(); if (rr0) { ICAM.x = rr0.cx; ICAM.y = rr0.cy - (vv0.cy - CAM.vh / 2) / ICAM.s; }
    } else if (k === 'dauto') {
      b = defView(); if (!b) return;
      var ids0 = selIds(); b.setAuto(G.side, ids0);
      toast((ids0 ? 'Выбранные отряды' : 'Все отряды') + ' обороняются сами: охрана мостика и реактора, охота на врага', 'gold');
    } else if (k === 'counter') {
      var home0 = G.mode === 'inside' && G.B.ships[G.view] && G.B.ships[G.view].side === G.side ? G.view : G.sel;
      if (+n < 0) { toast('Корабль врага не виден — некуда высаживаться', 'bad'); return; }
      var rc = B.board(home0, +n, true);
      if (rc.ok) toast('Контрабордаж: ' + rc.party + ' ' + plural(rc.party, 'боец', 'бойца', 'бойцов') + ' ушли с обороны в шаттлы', 'gold');
      else toast(rc.why, 'bad');
    } else if (k === 'pdshut') {
      var me0 = B.ships[G.sel]; if (!me0) return;
      // ПВО и турболазеры (скорострельные) — по шаттлам; тяжёлые и дальнобойные бьют корабль дальше
      var pd = []; me0.guns.forEach(function(g, i) { if (g.t === 'pd' || g.t === 'medium') pd.push(i); });
      if (!pd.length) { toast('Нет ПВО и турболазеров — бей шаттлы истребителями', 'bad'); return; }
      var on0 = me0.guns.some(function(g) { return g.tgt.k === 'shuttles'; });
      B.setTarget(G.sel, pd, on0 ? { k: 'auto' } : { k: 'shuttles' });
      toast(on0 ? 'Пушки снова выбирают цели сами' : 'ПВО и турболазеры — по абордажным шаттлам', 'gold');

    } else if (k === 'alarm') {
      b = boardOf(+n); if (!b) return;
      if (b.setAlarm(!b.alarm)) toast(b.alarm ? 'Тревога: шлюзы и бронедвери заперты' : 'Тревога снята: двери открыты', 'gold');
      else toast(b.heldType('comms') ? 'Узел связи у врага — тревогу не поднять' : 'Тревога готова через ' + Math.ceil(b.alarmCd) + ' с', 'bad');
    } else if (k === 'vent') {
      b = boardOf(+n); if (!b) return;
      var why = b.canVent(G.side);
      if (why) { toast(why, 'bad'); return; }
      if (G.mode !== 'inside' || G.view !== +n) setMode('inside', +n);
      G.vent = !G.vent;
      if (G.vent) toast('Коснись отсека: продувка ударит по всем внутри', 'gold');
    } else if (k === 'hold') {
      var me = B.ships[G.sel], on = !(me.hold && me.hold[+n]);
      B.setHold(G.sel, +n, on);
      toast(on ? 'Огонь по кораблю с нашим десантом прекращён' : 'Огонь открыт: по орудиям, мимо наших', 'gold');
    } else if (k === 'plant') {
      b = attView(); if (!b) return;
      var w = b.canPlant();
      if (w) toast(w, 'bad'); else if (b.plant(G.side)) toast('Инженер ставит заряд: 6 с, потом ' + BD.FUSE + ' с до взрыва', 'gold');
    }
    hud();
  }
  // Касание двери в режиме «Двери» / «Заварить»
  function doorTap(b, w) {
    var best = -1, bd = Math.max(2.2, 22 / ICAM.s); bd *= bd;
    for (var i = 0; i < b.doors.length; i++) {
      var d = b.doors[i], dx = d.x - w[0], dy = d.y - w[1], dd = dx * dx + dy * dy;
      if (dd < bd) { bd = dd; best = i; }
    }
    if (best < 0) { toast('Рядом нет двери — коснись проёма', 'bad'); return; }
    var d0 = b.doors[best], why;
    if (G.dmode === 'door') {
      why = b.canDoor(G.side, best);
      if (why) { toast(why, 'bad'); return; }
      var lock = d0.state !== 'locked';
      b.door(G.side, best);
      toast(lock ? 'Дверь заперта' : 'Дверь открыта', 'gold');
    } else {
      why = b.canWeld(G.side, best);
      if (why) { toast(why, 'bad'); return; }
      b.weld(G.side, best);
      toast('Ремонтник идёт заваривать дверь: ' + BD.WELD + ' с работы', 'gold');
      G.dmode = null;
    }
    hud();
  }
  // Касание отсека внутри: приказ отрядам / продувка
  function boardTap(sh, r) {
    var b = boardOf(sh.n); if (!b || !r) return false;
    if (G.vent) {
      G.vent = false;
      if (!b.vent(G.side, r.n)) toast(b.canVent(G.side) || 'Не вышло', 'bad');
      hud(); return true;
    }
    if (b.att !== G.side && b.def !== G.side) return false;
    var ids = selIds(), n = b.order(G.side, ids, r.n);
    if (n) toast((ids ? 'Отряд' + (ids.length > 1 ? 'ы ' : ' ') + ids.join(', ') : 'Все отряды') + ' → ' + r.name, 'gold');
    else toast('Некому идти: отряды выбиты', 'bad');
    hud(); return true;
  }

  // ---- отрисовка внутри
  // Под людьми: захват отсеков, двери, продувка, заряд
  function drawBoardUnder(c, sh, T) {
    var b = boardOf(sh.n); if (!b) return;
    var s = ICAM.s, W = sh.plan.w, t = sh.crew.t, k, i;
    // отсеки: чьи и кто берёт
    for (k in b.rs) {
      var st = b.rs[k], r = st.r, o = itoS(r.x, r.y);
      if (o[0] > CAM.vw || o[1] > CAM.vh || o[0] + r.w * s < 0 || o[1] + r.h * s < 0) continue;
      var col = TEAMC[b.att];
      if (st.held) {
        c.fillStyle = 'rgba(' + col + ',0.08)'; c.fillRect(o[0], o[1], r.w * s, r.h * s);
        c.strokeStyle = 'rgba(' + col + ',0.75)'; c.lineWidth = 2; c.strokeRect(o[0] + 1, o[1] + 1, r.w * s - 2, r.h * s - 2);
      } else if (st.hold > 0 && st.cnt[b.att]) {
        c.strokeStyle = 'rgba(' + col + ',' + (0.4 + 0.3 * Math.sin(T * 6)) + ')'; c.lineWidth = 2;
        c.setLineDash([5, 5]); c.lineDashOffset = -T * 12; c.strokeRect(o[0] + 1, o[1] + 1, r.w * s - 2, r.h * s - 2); c.setLineDash([]);
        // полоса захвата по верхней кромке
        c.fillStyle = 'rgba(' + col + ',0.9)'; c.fillRect(o[0] + 2, o[1] + 2, (r.w * s - 4) * Math.min(1, st.hold / BD.CAPTURE), Math.max(2, s * 0.25));
      }
      if (st.cnt[0] && st.cnt[1]) {
        // бой в отсеке: красные уголки мигают
        c.strokeStyle = 'rgba(255,90,60,' + (0.35 + 0.35 * Math.sin(T * 9)) + ')'; c.lineWidth = 1.5;
        c.strokeRect(o[0] + 3, o[1] + 3, r.w * s - 6, r.h * s - 6);
      }
    }
    // продувка: белый вихрь по отсеку
    for (i = 0; i < b.ev.vents.length; i++) {
      var v = b.ev.vents[i], age = t - v.t, rr = sh.plan.roomByN[v.n]; if (!rr || age > 4) continue;
      var oo = itoS(rr.x, rr.y), a = Math.max(0, 1 - age / 4);
      c.fillStyle = 'rgba(220,235,255,' + (0.35 * a) + ')'; c.fillRect(oo[0], oo[1], rr.w * s, rr.h * s);
      for (var z = 0; z < 14; z++) {
        var zx = rr.x + ((z * 0.37 + age * 0.9) % 1) * rr.w, zy = rr.y + ((z * 0.61 + Math.sin(z) * 0.2) % 1 + 1) % 1 * rr.h, zq = itoS(zx, zy);
        c.strokeStyle = 'rgba(240,248,255,' + (0.5 * a) + ')'; c.lineWidth = Math.max(1, s * 0.12);
        c.beginPath(); c.moveTo(zq[0], zq[1]); c.lineTo(zq[0] + s * 1.6, zq[1] - s * 0.3); c.stroke();
      }
    }
    // двери: заперты — красная решётка, вскрывают — искры и дуга, выбиты — копоть
    var dm = G.dmode && b.def === G.side;
    for (i = 0; i < b.doors.length; i++) {
      var d = b.doors[i];
      var p = itoS(d.x, d.y); if (p[0] < -40 || p[1] < -40 || p[0] > CAM.vw + 40 || p[1] > CAM.vh + 40) continue;
      // режим «Двери»: каждая дверь — метка (открыта — золотая рамка, можно запереть)
      if (dm && d.state !== 'broken') {
        var rr = Math.max(7, s * 1.5);
        c.strokeStyle = d.state === 'locked' ? 'rgba(255,110,90,0.95)' : 'rgba(240,200,106,' + (0.6 + 0.3 * Math.sin(T * 5 + i)) + ')';
        c.lineWidth = 2; c.setLineDash(d.state === 'locked' ? [] : [3, 3]);
        c.strokeRect(p[0] - rr, p[1] - rr, rr * 2, rr * 2); c.setLineDash([]);
      }
      if (d.weld && d.state === 'locked') {
        // заварена: стежки поперёк проёма
        c.strokeStyle = 'rgba(255,200,120,0.9)'; c.lineWidth = Math.max(1.5, s * 0.12);
        c.beginPath();
        for (var wz = -2; wz <= 2; wz++) { var ox = d.v ? 0 : wz * s * 0.45, oy = d.v ? wz * s * 0.45 : 0; c.moveTo(p[0] + ox - s * 0.3, p[1] + oy - s * 0.3); c.lineTo(p[0] + ox + s * 0.3, p[1] + oy + s * 0.3); }
        c.stroke();
      }
      if (d.weldP > 0 && d.state === 'locked' && !d.weld) {
        c.strokeStyle = 'rgba(140,220,255,0.95)'; c.lineWidth = Math.max(2, s * 0.18);
        c.beginPath(); c.arc(p[0], p[1], Math.max(9, s * 1.5), -Math.PI / 2, -Math.PI / 2 + TAU * Math.min(1, d.weldP)); c.stroke();
      }
      if (d.state === 'open') continue;
      if (d.state === 'broken') {
        var g = c.createRadialGradient(p[0], p[1], 0, p[0], p[1], s * 1.8);
        g.addColorStop(0, 'rgba(10,8,6,0.75)'); g.addColorStop(1, 'rgba(10,8,6,0)');
        c.fillStyle = g; c.beginPath(); c.arc(p[0], p[1], s * 1.8, 0, TAU); c.fill();
        continue;
      }
      var cells = d.cells;
      for (var j = 0; j < cells.length; j++) {
        var cx = cells[j] % W, cy = (cells[j] - cx) / W, q = itoS(cx, cy);
        c.fillStyle = 'rgba(70,14,10,0.85)'; c.fillRect(q[0], q[1], s, s);
        c.strokeStyle = 'rgba(255,90,60,0.85)'; c.lineWidth = Math.max(1, s * 0.12);
        c.beginPath();
        for (var h = 1; h < 4; h++) { if (d.v) { c.moveTo(q[0] + s * h / 4, q[1]); c.lineTo(q[0] + s * h / 4, q[1] + s); } else { c.moveTo(q[0], q[1] + s * h / 4); c.lineTo(q[0] + s, q[1] + s * h / 4); } }
        c.stroke();
      }
      if (d.breach > 0) {
        var bk = Math.min(1, d.breach / (b.breachNeed ? b.breachNeed(d) : BD.BREACH));
        c.strokeStyle = 'rgba(255,210,120,0.95)'; c.lineWidth = Math.max(2, s * 0.18);
        c.beginPath(); c.arc(p[0], p[1], Math.max(8, s * 1.3), -Math.PI / 2, -Math.PI / 2 + TAU * bk); c.stroke();
        c.save(); c.globalCompositeOperation = 'lighter';
        for (var sp = 0; sp < 7; sp++) {
          var ua = ((T * 3.3 + sp / 7) % 1), ang = sp * 0.9 + Math.floor(T * 7);
          c.fillStyle = 'rgba(255,' + (210 - ua * 120 | 0) + ',80,' + (1 - ua) + ')';
          c.fillRect(p[0] + Math.cos(ang) * ua * s * 1.4, p[1] + Math.sin(ang) * ua * s * 1.4 + ua * ua * s * 0.6, Math.max(1.5, s * 0.1), Math.max(1.5, s * 0.1));
        }
        c.restore();
      }
    }
    // заряд у реактора
    if (b.charge && b.reactor) {
      var rc = sh.plan.roomByN[b.reactor], pc = itoS(rc.cx, rc.cy), blink = Math.sin(T * (b.charge.armed ? 10 : 4)) > 0;
      c.strokeStyle = 'rgba(255,60,40,' + (blink ? 0.95 : 0.4) + ')'; c.lineWidth = 3;
      c.beginPath(); c.arc(pc[0], pc[1], Math.max(14, s * 3), 0, TAU); c.stroke();
      c.font = 'bold 12px "Courier New", monospace'; c.textAlign = 'center'; c.textBaseline = 'middle';
      var txt = b.charge.armed ? 'ЗАРЯД ' + Math.ceil(b.charge.left) + ' с' : 'СТАВЯТ ЗАРЯД';
      var tw = c.measureText(txt).width;
      c.fillStyle = 'rgba(40,4,2,0.85)'; c.fillRect(pc[0] - tw / 2 - 6, pc[1] - Math.max(14, s * 3) - 22, tw + 12, 18);
      c.fillStyle = '#ff8a70'; c.fillText(txt, pc[0], pc[1] - Math.max(14, s * 3) - 13);
    }
  }
  // Поверх людей: турели, выстрелы, вспышки, метки отрядов
  function drawBoardOver(c, sh, T) {
    var b = boardOf(sh.n); if (!b) return;
    var s = ICAM.s, t = sh.crew.t, i, dark = b.heldType('power');
    for (i = 0; i < b.turrets.length; i++) {
      var tu = b.turrets[i], p = itoS(tu.x, tu.y);
      if (p[0] < -30 || p[1] < -30 || p[0] > CAM.vw + 30 || p[1] > CAM.vh + 30) continue;
      if (tu.dead) {
        c.fillStyle = 'rgba(15,12,10,0.8)'; c.beginPath(); c.arc(p[0], p[1], Math.max(4, s * 1.1), 0, TAU); c.fill();
        c.fillStyle = 'rgba(120,120,120,' + (0.18 + 0.08 * Math.sin(T * 2 + i)) + ')'; c.beginPath(); c.arc(p[0] + Math.sin(T + i) * s * 0.4, p[1] - s * 0.9, s * 0.9, 0, TAU); c.fill();
        continue;
      }
      c.strokeStyle = dark ? '#555' : '#c9ccd2'; c.lineWidth = Math.max(2, s * 0.28);
      c.beginPath(); c.moveTo(p[0], p[1]); c.lineTo(p[0] + Math.cos(tu.aim) * s * 1.3, p[1] + Math.sin(tu.aim) * s * 1.3); c.stroke();
      c.fillStyle = dark ? 'rgba(90,90,90,0.9)' : tu.tgt >= 0 ? 'rgba(255,70,50,' + (0.7 + 0.3 * Math.sin(T * 12)) + ')' : 'rgba(255,170,60,0.8)';
      c.beginPath(); c.arc(p[0], p[1], Math.max(2, s * 0.32), 0, TAU); c.fill();
      if (s > 5 && tu.hp < BD.TURRET.hp) {
        c.fillStyle = 'rgba(20,26,34,0.9)'; c.fillRect(p[0] - s, p[1] + s * 1.2, s * 2, Math.max(2, s * 0.15));
        c.fillStyle = '#ff8a5c'; c.fillRect(p[0] - s, p[1] + s * 1.2, s * 2 * tu.hp / BD.TURRET.hp, Math.max(2, s * 0.15));
      }
    }
    // выстрелы: болт летит 0,12 с, попадание — вспышка
    c.save(); c.globalCompositeOperation = 'lighter'; c.lineCap = 'round';
    var shots = b.ev.shots;
    for (i = 0; i < shots.length; i++) {
      var sh2 = shots[i], age = t - sh2.t; if (age < 0 || age > 0.35) continue;
      var k = Math.min(1, age / 0.12), dx = sh2.x1 - sh2.x0, dy = sh2.y1 - sh2.y0, L = Math.sqrt(dx * dx + dy * dy) || 1;
      var tail = Math.min(1, 1.6 / L), hx = sh2.x0 + dx * k, hy = sh2.y0 + dy * k, k0 = Math.max(0, k - tail);
      var a = itoS(hx, hy), q = itoS(sh2.x0 + dx * k0, sh2.y0 + dy * k0);
      var col = sh2.w === 'turret' ? '255,190,90' : TEAMC[sh2.team === 0 ? 0 : 1];
      if (age < 0.12) {
        c.strokeStyle = 'rgba(' + col + ',0.9)'; c.lineWidth = Math.max(1.5, s * (sh2.w === 'turret' ? 0.3 : 0.17));
        c.beginPath(); c.moveTo(q[0], q[1]); c.lineTo(a[0], a[1]); c.stroke();
        c.strokeStyle = 'rgba(255,255,255,0.8)'; c.lineWidth = Math.max(0.8, s * 0.06);
        c.beginPath(); c.moveTo(q[0], q[1]); c.lineTo(a[0], a[1]); c.stroke();
      } else if (sh2.hit) {
        var e = itoS(sh2.x1, sh2.y1), ek = (age - 0.12) / 0.23;
        c.fillStyle = 'rgba(' + col + ',' + (0.8 * (1 - ek)) + ')';
        c.beginPath(); c.arc(e[0], e[1], Math.max(2, s * (0.25 + ek * 0.4)), 0, TAU); c.fill();
      }
      // вспышка у ствола
      if (age < 0.06) { var m0 = itoS(sh2.x0, sh2.y0); c.fillStyle = 'rgba(' + col + ',0.8)'; c.beginPath(); c.arc(m0[0], m0[1], Math.max(1.5, s * 0.22), 0, TAU); c.fill(); }
    }
    for (i = 0; i < b.ev.booms.length; i++) {
      var bm = b.ev.booms[i], ba = t - bm.t; if (ba > 1) continue;
      var bp = itoS(bm.x, bm.y), br = Math.max(8, bm.r * s * (0.5 + ba));
      var g = c.createRadialGradient(bp[0], bp[1], 0, bp[0], bp[1], br);
      g.addColorStop(0, 'rgba(255,240,200,' + (1 - ba) + ')'); g.addColorStop(0.4, 'rgba(255,140,50,' + (0.7 * (1 - ba)) + ')'); g.addColorStop(1, 'rgba(255,80,20,0)');
      c.fillStyle = g; c.beginPath(); c.arc(bp[0], bp[1], br, 0, TAU); c.fill();
    }
    c.restore();
    // метки отрядов (свои — номер над центром отряда; у защитников — их отряды)
    if (b.att === G.side || (b.def === G.side && b.over < 0)) {
      var ag = sh.crew.agents, list = b.att === G.side ? b.squads : (b.dsq || []);
      list.forEach(function(q) {
        var x = 0, y = 0, n = 0;
        q.members.forEach(function(id) { var m = ag[id]; if (m && m.alive) { x += m.x; y += m.y; n++; } });
        if (!n) return;
        var pp = itoS(x / n, y / n - 2.2), on = G.bsel[q.id];
        c.fillStyle = on ? 'rgba(217,169,64,0.95)' : 'rgba(8,11,17,0.85)';
        c.strokeStyle = on ? '#fff3c8' : 'rgba(' + TEAMC[G.side] + ',0.9)'; c.lineWidth = 1.5;
        c.beginPath(); c.arc(pp[0], pp[1], 9, 0, TAU); c.fill(); c.stroke();
        c.font = 'bold 11px "Courier New", monospace'; c.textAlign = 'center'; c.textBaseline = 'middle';
        c.fillStyle = on ? '#1a1206' : '#e8eef2'; c.fillText(String(q.id), pp[0], pp[1] + 0.5);
      });
    }
  }

  // ---------------------------------------------------------------- туман войны
  // Свои видят всё, что в радиусе датчиков кораблей и малых кораблей; выстрел
  // главного калибра выдаёт стрелка. Остальное — метка последней засечки.
  function seen(s) { return !s || s.side === G.side || s.dead || G.B.sees(G.side, s); }
  function lastOf(s) { return G.B.last[G.side][s.n] || null; }
  // где показывать корабль игроку: сам корабль или его последняя засечка
  function shownPos(s) { if (seen(s)) return s; var L = lastOf(s); return L ? { x: L.x, y: L.y, hd: L.hd } : null; }
  function drawGhost(c, sh, T) {
    if (sh.dead) return;
    var L = lastOf(sh); if (!L) return;
    var q = toS(L.x, L.y), s = CAM.s, p = sh.plan, img = G.imgs[sh.cls], cr = p.crop;
    var W = p.w * p.cellM, H = p.h * p.cellM, R = Math.max(14, sh.len * s * 0.6);
    if (q[0] < -R * 2 || q[0] > CAM.vw + R * 2 || q[1] < -R * 2 || q[1] > CAM.vh + R * 2) return;
    var age = G.B.t - L.t;
    // силуэт там, где видели в последний раз, — бледный и тающий
    c.save(); c.translate(q[0], q[1]); c.rotate(L.hd + Math.PI / 2); c.scale(s, s);
    c.globalAlpha = Math.max(0.06, 0.22 - age * 0.003);
    c.drawImage(img, cr[0], cr[1], cr[2] - cr[0], cr[3] - cr[1], -W / 2, -H / 2, W, H);
    c.restore();
    c.strokeStyle = 'rgba(255,110,90,0.55)'; c.lineWidth = 1; c.setLineDash([4, 5]); c.lineDashOffset = -T * 8;
    c.beginPath(); c.arc(q[0], q[1], R, 0, TAU); c.stroke(); c.setLineDash([]);
    c.font = '10px "Courier New", monospace'; c.textAlign = 'center'; c.textBaseline = 'top';
    c.fillStyle = 'rgba(255,208,204,0.75)';
    c.fillText(sh.name + ' · ' + (age < 60 ? Math.round(age) + ' с' : Math.floor(age / 60) + ' мин') + ' назад', q[0], q[1] + R + 4);
  }
  // Затемнение вне датчиков: тёмный слой с мягкими «окнами» вокруг своих глаз.
  // Считается в 1/4 разрешения — дёшево и края всё равно размыты.
  var FOG = { cv: null, cx: null };
  function drawFog(c, T) {
    var B = G.B; if (!B.fog) return;
    var k = 4, w = Math.ceil(CAM.vw / k), h = Math.ceil(CAM.vh / k);
    if (!FOG.cv) { FOG.cv = document.createElement('canvas'); FOG.cx = FOG.cv.getContext('2d'); }
    if (FOG.cv.width !== w || FOG.cv.height !== h) { FOG.cv.width = w; FOG.cv.height = h; }
    var f = FOG.cx;
    f.globalCompositeOperation = 'source-over'; f.clearRect(0, 0, w, h);
    f.fillStyle = 'rgba(2,3,7,0.5)'; f.fillRect(0, 0, w, h);
    f.globalCompositeOperation = 'destination-out';
    function hole(x, y, r) {
      var q = toS(x, y), R = r * CAM.s / k; if (R < 1) return;
      var g = f.createRadialGradient(q[0] / k, q[1] / k, R * 0.82, q[0] / k, q[1] / k, R);
      g.addColorStop(0, 'rgba(0,0,0,1)'); g.addColorStop(1, 'rgba(0,0,0,0)');
      f.fillStyle = g; f.beginPath(); f.arc(q[0] / k, q[1] / k, R, 0, TAU); f.fill();
    }
    var i;
    for (i = 0; i < B.ships.length; i++) { var o = B.ships[i]; if (!o.dead && o.side === G.side) hole(o.x, o.y, B.sensRange(o)); }
    for (i = 0; i < B.craft.length; i++) { var cr = B.craft[i]; if (!cr.dead && cr.side === G.side) hole(cr.x, cr.y, 3500); }
    c.drawImage(FOG.cv, 0, 0, w * k, h * k);
    // кромка датчиков выбранного корабля
    var me = B.ships[G.sel];
    if (me && !me.dead) {
      var q = toS(me.x, me.y), r = B.sensRange(me) * CAM.s;
      if (r > 30) {
        c.strokeStyle = 'rgba(111,184,255,0.22)'; c.lineWidth = 1; c.setLineDash([2, 7]); c.lineDashOffset = -T * 6;
        c.beginPath(); c.arc(q[0], q[1], r, 0, TAU); c.stroke(); c.setLineDash([]);
      }
    }
  }

  // ---------------------------------------------------------------- космос
  function drawSpace(T) {
    var c = CTX, B = G.B, s = CAM.s, i;
    c.setTransform(CAM.dpr, 0, 0, CAM.dpr, 0, 0);
    c.clearRect(0, 0, CAM.vw, CAM.vh);
    drawGrid(c);
    // остовы погибших — под живыми
    if (G.wrecks) for (i = 0; i < G.wrecks.length; i++) window.SPWreck.draw(c, G.wrecks[i], T0(), toS, s, CAM.vw, CAM.vh);
    // корабли: врага вне датчиков не видно — только метка последней засечки
    for (i = 0; i < B.ships.length; i++) {
      if (seen(B.ships[i])) drawShip(c, B.ships[i], T); else drawGhost(c, B.ships[i], T);
    }
    // куда бьёт враг по нашим кораблям
    drawThreats(c, T);
    // цели выбранного корабля
    if (G.sel >= 0) drawAims(c, B.ships[G.sel], T);
    // отсеки на схеме — в режиме прицела
    if (G.aim && G.foe >= 0 && seen(B.ships[G.foe])) drawRooms(c, B.ships[G.foe], T);
    // малые корабли
    for (i = 0; i < B.craft.length; i++) if (B.craft[i].side === G.side || B.visC[G.side][B.craft[i].id]) drawCraft(c, B.craft[i]);
    // болты, щиты, взрывы
    drawShots(c);
    drawShields(c, T);
    drawBooms(c);
    drawFog(c, T);
    // отладка: круги корпусов для столкновений (window.__sp.G.dbgCol = true)
    if (G.dbgCol && B.circles) B.ships.forEach(function(sh) { if (sh.dead) return; B.circles(sh).forEach(function(q) { var p = toS(q[0], q[1]); c.strokeStyle = 'rgba(95,217,104,0.7)'; c.lineWidth = 1; c.beginPath(); c.arc(p[0], p[1], q[2] * CAM.s, 0, TAU); c.stroke(); }); });
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
    if (sh.dead && sh.wreck) return;                 // вместо корабля рисуется остов
    var taken = sh.dead && sh.why === 'captured';      // трофей: корабль цел, но из боя вышел
    var dead = sh.dead, fade = taken ? 0.8 : dead ? Math.max(0, 1 - (now() - sh.deadAt) / 2.5) : 1;
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
    if (taken) {
      var tq = toS(sh.x, sh.y + sh.len * 0.55);
      c.font = '10px "Courier New", monospace'; c.textAlign = 'center'; c.textBaseline = 'top';
      c.fillStyle = sh.captured === G.side ? '#f0c86a' : '#ff8a70';
      c.fillText('⚑ ' + sh.name + ' — ' + (sh.captured === G.side ? 'трофей' : 'захвачен'), tq[0], tq[1] + 4);
    }
    // идёт абордаж — значок со счётом бойцов
    var obd = boardOf(sh.n);
    if (obd && obd.over < 0 && !dead) {
      var sm = obd.summary(), bq = toS(sh.x, sh.y - sh.len * 0.55), txt = '⚔ ' + sm.att + ' : ' + sm.def;
      c.font = 'bold 10px "Courier New", monospace'; c.textAlign = 'center'; c.textBaseline = 'bottom';
      var tw = c.measureText(txt).width;
      c.fillStyle = 'rgba(8,11,17,0.85)'; c.fillRect(bq[0] - tw / 2 - 5, bq[1] - 18, tw + 10, 15);
      c.strokeStyle = 'rgba(' + TEAMC[obd.att] + ',0.8)'; c.lineWidth = 1; c.strokeRect(bq[0] - tw / 2 - 5, bq[1] - 18, tw + 10, 15);
      c.fillStyle = '#e8eef2'; c.fillText(txt, bq[0], bq[1] - 4);
    }
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
  // Наведение вражеских пушек на наши корабли: {корабль: {отсек: число}}
  function threats() {
    var B = G.B, out = {};
    for (var i = 0; i < B.ships.length; i++) {
      var en = B.ships[i]; if (en.dead || en.side === G.side) continue;
      for (var k = 0; k < en.guns.length; k++) {
        var g = en.guns[k], a = g.aimAt;
        if (!a || a.craft || !a.ship || a.ship.side !== G.side) continue;
        var m = out[a.ship.n] || (out[a.ship.n] = {});
        m[a.room || 0] = (m[a.room || 0] || 0) + 1;
      }
    }
    return out;
  }
  function drawThreats(c, T) {
    var B = G.B, s = CAM.s;
    for (var i = 0; i < B.ships.length; i++) {
      var en = B.ships[i]; if (en.dead || en.side === G.side) continue;
      for (var k = 0; k < en.guns.length; k++) {
        var g = en.guns[k], a = g.aimAt;
        if (!a || a.craft || !a.ship || a.ship.side !== G.side || a.ship.dead) continue;
        var r = a.room && a.ship.plan.roomByN[a.room];
        var w = r ? B.toWorld(a.ship, r.cx, r.cy) : [a.ship.x, a.ship.y];
        var p = toS(g.x, g.y), q = toS(w[0], w[1]);
        c.strokeStyle = 'rgba(255,90,70,0.4)'; c.lineWidth = 1.2; c.setLineDash([2, 7]); c.lineDashOffset = T * 14;
        c.beginPath(); c.moveTo(p[0], p[1]); c.lineTo(q[0], q[1]); c.stroke(); c.setLineDash([]);
        if (r && s > 0.06) outlineRoom(c, a.ship, r, 'rgba(255,90,70,' + (0.5 + 0.3 * Math.sin(T * 6)) + ')', T);
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
    else if (cr.role === 'shuttle') {
      // абордажный шаттл: клин с кабиной и огнём двигателя
      var L = Math.max(14, size * 1.1), Wd = L * 0.62;
      c.fillStyle = 'rgba(255,190,110,0.85)'; c.beginPath(); c.arc(0, L * 0.5, L * 0.16, 0, TAU); c.fill();
      c.fillStyle = cr.faction === 'cis' ? '#8a7d6a' : '#c9ccd2';
      c.strokeStyle = 'rgba(10,12,16,0.9)'; c.lineWidth = 1;
      c.beginPath(); c.moveTo(0, -L / 2); c.lineTo(Wd / 2, L * 0.3); c.lineTo(Wd * 0.3, L / 2); c.lineTo(-Wd * 0.3, L / 2); c.lineTo(-Wd / 2, L * 0.3); c.closePath(); c.fill(); c.stroke();
      c.fillStyle = cr.side === 0 ? '#4a90d9' : '#d94a4a'; c.fillRect(-Wd * 0.18, -L * 0.12, Wd * 0.36, L * 0.3);
    }
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
      if (b.big && b.ship != null && G.B.ships[b.ship] && G.B.ships[b.ship].wreck) continue;   // у остова своя вспышка
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
    var c = CTX, B = G.B, sh = B.ships[G.view];
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
    // подложка — общий разрез: недостроенный кусок виден грубо, а не чёрной дырой (без мерцания)
    if (!CLIPS[sh.cls]) CLIPS[sh.cls] = makeClip(p, G.imgs[sh.cls]);
    var ux0 = Math.max(0, Math.floor(a[0])), uy0 = Math.max(0, Math.floor(a[1])), ux1 = Math.min(p.w, Math.ceil(b[0]) + 1), uy1 = Math.min(p.h, Math.ceil(b[1]) + 1);
    if (ux1 > ux0 && uy1 > uy0) {
      var CL = CLIPS[sh.cls], kx = CL.width / p.w, ky = CL.height / p.h, u0 = itoS(ux0, uy0);
      c.drawImage(CL, ux0 * kx, uy0 * ky, (ux1 - ux0) * kx, (uy1 - uy0) * ky, u0[0], u0[1], (ux1 - ux0) * s, (uy1 - uy0) * s);
      c.globalCompositeOperation = 'source-atop';          // затемнить только сам корпус
      c.fillStyle = 'rgba(28,32,38,0.55)'; c.fillRect(u0[0], u0[1], (ux1 - ux0) * s, (uy1 - uy0) * s);
      c.globalCompositeOperation = 'source-over';
    }
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
    var cr = sh.crew, TH = threats()[sh.n];
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
      var thr = TH && TH[r.n];
      if (thr) {
        // под прицелом врага: красные уголки
        var L = Math.min(r.w, r.h) * s * 0.25, x0 = o[0] + 2, y0 = o[1] + 2, x1 = o[0] + r.w * s - 2, y1 = o[1] + r.h * s - 2;
        c.strokeStyle = 'rgba(255,80,60,' + (0.55 + 0.35 * Math.sin(T * 6)) + ')'; c.lineWidth = 2.5;
        c.beginPath();
        c.moveTo(x0, y0 + L); c.lineTo(x0, y0); c.lineTo(x0 + L, y0); c.moveTo(x1 - L, y0); c.lineTo(x1, y0); c.lineTo(x1, y0 + L);
        c.moveTo(x1, y1 - L); c.lineTo(x1, y1); c.lineTo(x1 - L, y1); c.moveTo(x0 + L, y1); c.lineTo(x0, y1); c.lineTo(x0, y1 - L);
        c.stroke();
        if (r.w * s > 70) {
          var tx = 'под прицелом' + (thr > 1 ? ' ×' + thr : '');
          c.font = '10px "Courier New", monospace'; c.textAlign = 'center'; c.textBaseline = 'middle';
          var tw = c.measureText(tx).width, ty = o[1] + r.h * s - 14;
          c.fillStyle = 'rgba(40,6,4,0.8)'; c.fillRect(o[0] + r.w * s / 2 - tw / 2 - 4, ty - 8, tw + 8, 16);
          c.fillStyle = '#ff9a80'; c.fillText(tx, o[0] + r.w * s / 2, ty);
        }
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
    // абордаж: отсеки, двери; люди и их дела; выстрелы и турели
    drawBoardUnder(c, sh, T);
    drawCrew(c, sh, T);
    drawBoardOver(c, sh, T);
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
  var ALL = F.withCrew(S.TYPES);         // бойцы + экипаж кораблей
  var FIG_IDS = ALL.map(function(t) { return t.id; });
  var ATLAS = null, ATLAS_TRIES = 0, SIZES = [56, 44, 36];
  function atlas() {
    if (!ATLAS || (ATLAS.bad && ATLAS_TRIES < SIZES.length)) {
      try { ATLAS = F.bake(ALL, SIZES[Math.min(ATLAS_TRIES, SIZES.length - 1)], 20); } catch (e) { ATLAS = { bad: true }; }
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
    // абордажная команда видит только тех, кто на линии огня её бойцов (или весь корабль — с тактическим центром)
    var bd = boardOf(sh.n), fog = bd && bd.att === G.side ? bd.vis : null;
    var vis = function(m) { return !m.gone && Math.abs(m.x - ICAM.x) <= hw && Math.abs(m.y - ICAM.y) <= hh && (!fog || m.team === G.side || !m.alive || fog[m.id]); };
    c.globalAlpha = alpha;
    // погибшие — на полу
    for (i = 0; i < ag.length; i++) {
      m = ag[i]; if (m.alive || !vis(m)) continue;
      p = itoS(m.x, m.y);
      c.save(); c.translate(p[0], p[1]); F.corpse(c, ALL[m.fig], m.aim + 0.6, s * FIGK); c.restore();
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
      } else if (m.job && (m.job.kind === 'fix' || m.job.kind === 'weld') && m.fixAt >= 0) {
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
    // сами бойцы; в абордаже у бойцов кольцо стороны под ногами
    for (i = 0; i < ag.length; i++) {
      m = ag[i]; if (!m.alive || !vis(m)) continue;
      p = itoS(m.x, m.y);
      if (bd && bd.over < 0 && m.wpn && (m.team !== sh.side || (m.job && m.job.kind === 'defend'))) {
        c.strokeStyle = 'rgba(' + TEAMC[m.team] + ',0.85)'; c.lineWidth = Math.max(1.2, s * 0.1);
        c.beginPath(); c.arc(p[0], p[1] + s * 0.1, s * 0.62, 0, TAU); c.stroke();
        if (m.breach >= 0) { c.fillStyle = 'rgba(255,210,120,0.9)'; c.beginPath(); c.arc(p[0] + Math.cos(m.aim) * s * 0.55, p[1] + Math.sin(m.aim) * s * 0.55, Math.max(1.5, s * 0.15), 0, TAU); c.fill(); }
      }
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
        F.draw(c, ALL[m.fig], { aim: m.aim, legs: m.legs, mv: m.mv, phase: m.phase });
        c.restore();
      }
      // герой: световой меч светится, над головой — имя
      if (m.hero) {
        var hc = m.team === 0 ? '120,200,255' : '255,70,60', ha = m.aim + 0.35, hl = s * 1.05;
        c.save(); c.globalCompositeOperation = 'lighter'; c.lineCap = 'round';
        c.strokeStyle = 'rgba(' + hc + ',0.45)'; c.lineWidth = Math.max(2.5, s * 0.28);
        c.beginPath(); c.moveTo(p[0] + Math.cos(ha) * s * 0.25, p[1] + Math.sin(ha) * s * 0.25); c.lineTo(p[0] + Math.cos(ha) * hl, p[1] + Math.sin(ha) * hl); c.stroke();
        c.strokeStyle = 'rgba(255,255,255,0.9)'; c.lineWidth = Math.max(1, s * 0.08); c.stroke();
        c.restore();
        if (s > 5 && m.uname) {
          // имя — под фигуркой (над ней метка отряда)
          c.font = '10px "Courier New", monospace'; c.textAlign = 'center'; c.textBaseline = 'top';
          var hw = c.measureText('★ ' + m.uname).width, hy = p[1] + s * 1.0;
          c.fillStyle = 'rgba(5,6,10,0.75)'; c.fillRect(p[0] - hw / 2 - 3, hy - 1, hw + 6, 13);
          c.fillStyle = m.team === 0 ? '#9fd8ff' : '#ff9a88'; c.fillText('★ ' + m.uname, p[0], hy);
        }
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
        var hk = m.hp / (m.hpMax || 100);
        if (hk < 0.7) {
          c.fillStyle = 'rgba(20,26,34,0.9)'; c.fillRect(p[0] - s * 0.5, p[1] + s * 0.75, s, Math.max(2, s * 0.1));
          c.fillStyle = hk < 0.35 ? '#ff6a55' : '#e8d9a8'; c.fillRect(p[0] - s * 0.5, p[1] + s * 0.75, s * hk, Math.max(2, s * 0.1));
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
  // Вид изнутри собирается кусками; пока куски первого экрана строятся, показываем
  // короткую заставку — иначе на слабом телефоне разрез мерцает недостроенными кусками
  var LOAD = null;
  function preload(sh) {
    var s = ICAM.s, p = sh.plan, q = [];
    if (!CLIPS[sh.cls]) CLIPS[sh.cls] = makeClip(p, G.imgs[sh.cls]);
    if (s >= 2.6) {
      var tp = tierFor(s * CAM.dpr / 1.2), m = 1;          // плюс кайма в кусок — на первый сдвиг пальцем
      var a = itoW(0, 0), b = itoW(CAM.vw, CAM.vh);
      var cx0 = Math.max(0, Math.floor(a[0] / CH) - m), cy0 = Math.max(0, Math.floor(a[1] / CH) - m);
      var cx1 = Math.min(Math.ceil(p.w / CH) - 1, Math.floor(b[0] / CH) + m), cy1 = Math.min(Math.ceil(p.h / CH) - 1, Math.floor(b[1] / CH) + m);
      for (var cy = cy0; cy <= cy1; cy++) for (var cx = cx0; cx <= cx1; cx++)
        if (!CHUNKS.has(sh.cls + ':' + tp + ':' + cx + ':' + cy)) q.push([cx, cy, tp]);
    }
    if (!q.length) return;                                     // всё уже готово — без заставки
    LOAD = { sh: sh, q: q, n: q.length, t0: performance.now(), shown: false };
    loadStep();                                   // быстрый телефон успевает сразу — тогда без заставки
    if (!LOAD) return;
    LOAD.shown = true;
    $('sp-load-name').textContent = sh.name;
    $('sp-load-i').style.width = Math.round((1 - LOAD.q.length / LOAD.n) * 100) + '%';
    var el = $('sp-load'); el.hidden = false; el.classList.remove('out');
  }
  function loadStep() {
    if (!LOAD) return;
    var t0 = performance.now();
    // строим, пока укладываемся в ~12 мс кадра (на слабом телефоне — хоть по куску)
    do {
      var it = LOAD.q.shift(); if (!it) break;
      BUILD.left = 1; chunk(LOAD.sh, it[0], it[1], it[2]);
    } while (LOAD.q.length && performance.now() - t0 < 12);
    $('sp-load-i').style.width = Math.round((1 - LOAD.q.length / LOAD.n) * 100) + '%';
    if (!LOAD.q.length || G.mode !== 'inside') {
      var was = LOAD.shown; LOAD = null;
      if (!was) return;
      var el = $('sp-load'); el.classList.add('out');
      setTimeout(function() { if (!LOAD) el.hidden = true; }, 260);
    }
  }

  function setMode(m, viewN) {
    G.mode = m; G.vent = false; G.dmode = null; G.bsel = {};
    if (m === 'inside') G.view = viewN != null ? viewN : G.sel;
    var bv = m === 'inside' && G.B.ships[G.view] && G.B.ships[G.view].side !== G.side;
    if (m !== 'inside' && LOAD) { LOAD.q = []; loadStep(); }
    if (window.SPSfx) window.SPSfx.setInside(m === 'inside');
    document.body.classList.toggle('inside', m === 'inside');
    $('sp-inside').textContent = m === 'inside' ? 'К бою' : 'Внутри';
    $('sp-kicker').textContent = bv ? 'Абордаж' : m === 'inside' ? 'Внутри корабля' : 'Космический бой 2.0';
    if (m === 'inside') {
      var sh = G.B.ships[G.view]; if (!sh) return;
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
      // идёт абордаж — камера на абордажную команду
      var bb = boardOf(sh.n), bc = bb && squadCenter(bb, null);
      // оборона: камера на самое опасное — заряд у реактора, мостик у врага
      if (bb && bb.def === G.side && bb.over < 0) {
        var hot = bb.charge && bb.reactor ? bb.reactor : bb.bridge && bb.rs[bb.bridge] && (bb.rs[bb.bridge].held || bb.rs[bb.bridge].cnt[bb.att]) ? bb.bridge : 0;
        var hr = hot && sh.plan.roomByN[hot]; if (hr) bc = [hr.cx, hr.cy];
      }
      if (bc) { ICAM.s = 9; ICAM.x = bc[0]; ICAM.y = bc[1] - (v.cy - CAM.vh / 2) / ICAM.s; G.room = null; }
      preload(sh);
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
      var sh0 = B.ships[G.view], w = itoW(px, py), r = SH.roomAt(sh0.plan, w[0], w[1]);
      // боец под пальцем?
      var who = null, wd = Math.max(1.2, 16 / ICAM.s), bv = attView();
      wd *= wd;
      sh0.crew.agents.forEach(function(a) {
        if (!a.alive || a.gone || (bv && a.team !== G.side && !bv.vis[a.id])) return;
        var dx = a.x - w[0], dy = a.y - w[1], d = dx * dx + dy * dy; if (d < wd) { wd = d; who = a; }
      });
      // оборона: режим дверей — ближайшая дверь под пальцем
      var dv = defView();
      if (dv && G.dmode) { doorTap(dv, w); return; }
      // абордаж: свой боец — выбрать его отряд; отсек — приказ отрядам или продувка
      if (bv && who && who.team === G.side && who.sq && !G.vent) { G.bsel[who.sq] = !G.bsel[who.sq]; hud(); return; }
      if (dv && who && who.team === G.side && who.dsq && !G.vent) { G.bsel[who.dsq] = !G.bsel[who.dsq]; hud(); return; }
      // защитник: касание человека экипажа — показать, кто это; отсека — приказ отрядам
      var inspect = dv && who && !who.dsq && !G.vent;
      if ((bv || dv || G.vent) && !inspect && boardTap(sh0, r || (who && SH.roomAt(sh0.plan, who.x, who.y)))) return;
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
      var s = B.ships[i]; if (s.dead || !seen(s)) continue;
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
    // без приближения: камера только плавно ведёт корабль, масштаб — как выбрал игрок
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
    if (t.k === 'shuttles') return 'шаттлы абордажа';
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
    btn.push('<button class="sp-btn tgt" data-t="shuttles">Шаттлы</button>');
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

  // Трюм корабля: десант (живые / сколько было), герои, техника; недобор экипажа
  function holdLine(sh) {
    var c = sh.crew, alive = 0, all = 0, heroes = [];
    if (G.net && sh.netTroops) { alive = sh.netTroops[0]; all = sh.netTroops[1]; heroes = sh.netHeroes || []; }
    else c.agents.forEach(function(a) {
      if (a.team !== sh.side || !a.utype) return;
      all++; if (a.alive) alive++;
      if (a.hero && a.alive && a.uname) heroes.push(a.uname);
    });
    var out = '<div class="sp-hold">' +
      (all ? 'десант на борту <b>' + alive + '</b><em> из ' + all + '</em>' : '<span class="sp-dim">десанта в трюме нет — бойцов грузят в игре</span>') +
      (heroes.length ? ' · <b class="hero">★ ' + heroes.map(esc).join(', ') + '</b>' : '') +
      (sh.vehicles && sh.vehicles.length ? ' · техника <b>' + sh.vehicles.length + '</b>' : '') +
      (c.crewLost ? ' · <span class="foe">недобор экипажа ' + c.crewLost + '</span>' : '') + '</div>';
    return out;
  }
  // горящих клеток: в бою по сети снаружи видна только выборка, число — с сервера
  function burnN(s) { return s.netBurn != null && G.net ? s.netBurn : s.crew.burning.length; }
  function hud() {
    var B = G.B; if (!B) return;
    // флот
    B.ships.forEach(function(s) {
      var h = $('sp-u-h' + s.n); if (!h) return;
      var el = h.parentNode.parentNode, lost = !seen(s);
      el.classList.toggle('lost', lost);
      if (lost) { $('sp-u-w' + s.n).textContent = 'нет контакта'; return; }   // полоски застывают на последнем, что видели
      h.style.width = Math.max(0, s.hull / s.hullMax * 100) + '%';
      $('sp-u-s' + s.n).style.width = ((s.sh[0] + s.sh[1] + s.sh[2] + s.sh[3]) / (4 * s.shMax) * 100) + '%';
      var ob = boardOf(s.n);
      $('sp-u-w' + s.n).textContent = s.dead ? (s.why === 'captured' ? (s.captured === G.side ? '⚑ трофей' : '⚑ захвачен') : '✗') : ob && ob.over < 0 ? '⚔ абордаж' : s.crit ? '⚠ ' + Math.ceil(s.crit) : burnN(s) ? '🔥' : '';
      el.classList.toggle('on', s.n === G.sel || s.n === G.foe);
      el.classList.toggle('dead', s.dead);
    });
    var t = B.t | 0; $('sp-time').textContent = Math.floor(t / 60) + ':' + ('0' + t % 60).slice(-2);
    // выбранный корабль
    var sh = B.ships[G.sel], box = $('sp-ship');
    var bv = attView(), dvw = defView();
    document.body.classList.toggle('boardview', !!(bv || dvw));
    document.body.classList.toggle('defview', !!dvw);
    $('sp-kicker').textContent = bv ? 'Абордаж' : dvw ? 'Оборона корабля' : G.mode === 'inside' ? 'Внутри корабля' : 'Космический бой 2.0';
    if (!dvw && G.dmode) G.dmode = null;
    if (bv) { box.innerHTML = boardPanel(B.ships[G.view], bv); $('sp-view').textContent = 'Весь корабль'; return; }
    if (dvw) { box.innerHTML = defPanel(B.ships[G.view], dvw); $('sp-view').textContent = 'Весь корабль'; return; }
    if (!sh) { box.innerHTML = '<div class="sp-hint">Твоих кораблей не осталось.</div>'; return; }
    var e = sh.eff;
    var head = '<div class="sp-ship-head"><b>' + esc(sh.name) + '</b><span class="sp-tag">' + Math.max(0, Math.round(sh.hull / sh.hullMax * 100)) + '%</span>' +
      (sh.dead ? '<span class="sp-tag warn">уничтожен</span>' : sh.crit ? '<span class="sp-tag warn">реактор ' + Math.ceil(sh.crit) + ' с</span>' : '') +
      '<span class="r">экипаж <i>' + sh.crew.alive() + '</i>' + (burnN(sh) ? ' · огонь <i style="color:#ffb070">' + burnN(sh) + '</i>' : '') + '</span></div>' + holdLine(sh);
    var shv = function(v) { return '<b' + (v <= 0 ? ' class="z"' : '') + '>' + Math.round(v / sh.shMax * 100) + '</b>'; };
    var sys = '<div class="sp-sys">' + sysCell('Ход', e.engine) + sysCell('Пит', e.reactor) + sysCell('Ген', e.shield) + sysCell('Мост', e.bridge) + '</div>';
    // щиты по секторам: касание — усилить сектор (повторное — вернуть экипажу)
    var SN = ['нос', 'пр', 'корма', 'лев'], shRow = '<div class="sp-shd"><span>щиты</span>';
    [0, 3, 1, 2].forEach(function(q) {
      var cap = G.B.shieldCap(sh, q), v = Math.round(sh.sh[q] / Math.max(1, cap) * 100);
      shRow += '<button class="sp-shb' + (sh.focus === q ? ' on' : '') + (v <= 0 ? ' z' : '') + '" data-shf="' + q + '">' + SN[q] + ' <b>' + v + '</b></button>';
    });
    shRow += '<button class="sp-shb auto' + (sh.focusAuto ? ' on' : '') + '" data-shf="-1">' + (sh.focusAuto ? 'экипаж' : 'авто') + '</button></div>';
    sys += shRow;
    var th = threats()[sh.n], shs = '';
    if (th && !sh.dead) {
      var parts = Object.keys(th).map(function(n) {
        var r = sh.plan.roomByN[n]; return { name: r ? r.name : 'корпус', k: th[n] };
      }).sort(function(a, b) { return b.k - a.k; }).slice(0, 4);
      shs = '<div class="sp-dim" style="margin-top:4px">под огнём: ' + parts.map(function(p) { return '<b style="color:#ff8a70">' + esc(p.name) + (p.k > 1 ? ' ×' + p.k : '') + '</b>'; }).join(' · ') + '</div>';
    }
    var inside = '';
    if (G.mode === 'inside') {
      var r = G.room, st = r && sh.crew.rooms[r.n];
      if (st) {
        var ppl = 0, ff = 0, fx = 0;
        sh.crew.agents.forEach(function(a) {
          if (!a.alive) return;
          if (a.job && a.job.room === r.n && (a.job.kind === 'fire' || a.job.kind === 'fix')) { if (a.job.kind === 'fire') ff++; else fx++; }
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
    box.innerHTML = head + sys + shs + boardStrip(sh) + inside;
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
  var ROLE = { post: 'расчёт поста', fixer: 'ремонтник', medic: 'медик', reserve: 'резерв', boarder: 'абордажник', sapper: 'сапёр абордажа' };
  function whoLine(sh, a) {
    var rn = function(n) { var r = sh.plan.roomByN[n]; return r ? r.name : 'коридор'; };
    if (!a.alive) return '<b>Погиб</b> · ' + (ROLE[a.role] || 'боец');
    var j = a.job, what;
    if (j && j.kind === 'fire') what = a.at ? 'тушит пожар' : 'бежит тушить';
    else if (j && j.kind === 'fix') what = a.at ? 'чинит машины' : 'бежит чинить';
    else if (j && j.kind === 'heal') { var pt = sh.crew.agents[j.who]; what = (a.at ? 'перевязывает раненого' : 'бежит к раненому') + (pt ? ' (' + Math.round(pt.hp) + '%)' : ''); }
    else if (j && j.kind === 'carry') what = 'несёт боеприпасы к орудию';
    else if (j && j.kind === 'weld') what = a.fixAt >= 0 ? 'заваривает дверь' : 'бежит заваривать дверь';
    else if (j && j.kind === 'back') what = 'возвращается на склад';
    else if (j && j.kind === 'defend') what = a.tgt >= 0 ? 'ведёт бой' : a.guard ? 'держит оборону' : 'идёт на врага';
    else if (j && j.kind === 'board') what = a.breach >= 0 ? 'вскрывает дверь' : a.tgt >= 0 ? 'ведёт бой' : a.at ? 'держит отсек' : 'идёт к цели';
    else what = a.at ? (sh.crew.alertOn ? 'на посту у пульта' : 'несёт вахту') : 'идёт на пост';
    var where = j && j.room ? rn(j.room) : rn(a.goalRoom || a.home);
    // боец из игры — по типу (и имени героя); экипаж — по фигурке
    var ut = a.utype && window.SWArmy && window.SWArmy.unit(a.utype);
    var kind = ut ? (a.uname ? '★ ' + a.uname + ' · ' : '') + ut[0] : ALL[a.fig] ? ALL[a.fig].name : ROLE[a.role];
    var hp = Math.round(a.hp / (a.hpMax || 100) * 100), role = j && j.kind === 'defend' ? 'защитник' : ROLE[a.role] || 'боец';
    if (j && (j.kind === 'defend' || j.kind === 'board')) where = rn(a.goalRoom);
    return '<b>' + esc(kind) + '</b> (' + role + ') · ' + what + ' · ' + esc(where) +
      ' · здоровье <b' + (hp < 50 ? ' style="color:#ff8a5c"' : '') + '>' + hp + '%</b>';
  }
  function sysCell(name, v) {
    var p = Math.round(v * 100), cls = p < 35 ? 'bad' : p < 75 ? 'mid' : '';
    return '<div class="' + cls + '">' + name + '<b>' + p + '%</b></div>';
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, function(ch) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]; }); }

  function bindUi() {
    $('sp-scen').addEventListener('click', function(e) {
      if (e.target.closest('[data-net]')) { netPanel(true); return; }
      if (e.target.closest('[data-poly]')) { polyOpen(true); return; }
      var b = e.target.closest('[data-scen]'); if (b) start(b.getAttribute('data-scen'), G.side);
    });
    $('sp-side').style.cursor = 'pointer';
    $('sp-side').addEventListener('click', function() {
      if (G.net) { toast('В бою по сети сторону даёт сервер', 'bad'); return; }
      if (G.task) { G.side = 1 - G.side; runTask(G.task.i); return; }       // задача — заново за другую сторону
      start(G.scen, 1 - G.side, G.opts);
    });
    netBind(); polyBind();
    $('sp-pause').onclick = function() { setSpeed(G.speed === 0 || (G.net && G.net.spd === 0) ? (G.lastSpd || 1) : 0); };
    $('sp-spd').onclick = function() { var c = G.net ? (G.net.spd || 1) : (G.speed || G.lastSpd || 1); setSpeed(c === 1 ? 2 : c === 2 ? 4 : 1); };
    $('sp-fleet').addEventListener('click', function(e) {
      var b = e.target.closest('[data-ship]'); if (!b || !G.B) return;
      var s = G.B.ships[+b.getAttribute('data-ship')]; if (!s || s.dead) return;
      if (s.side === G.side) selectShip(s.n);
      else {
        G.foe = s.n; buildTargets();
        var sp = shownPos(s);
        if (G.mode === 'space' && sp) { focusShip({ x: sp.x, y: sp.y, len: s.len }); G.follow = false; }
        if (!seen(s)) toast(s.name + ': нет контакта — показана последняя засечка', 'bad');
        hud();
      }
    });
    $('sp-guns').addEventListener('click', function(e) {
      var b = e.target.closest('[data-gun]'); if (!b || !G.B) return;
      var i = +b.getAttribute('data-gun'); G.gsel[i] = !G.gsel[i]; G.aim = false; hud();
    });
    // панель корабля перерисовывается 4 раза в секунду — ловим нажатие сразу
    $('sp-ship').addEventListener('pointerdown', function(e) {
      if (!G.B) return;
      var ba = e.target.closest('[data-ba]'), bq = e.target.closest('[data-bsq]'), bo = e.target.closest('[data-bo]');
      if (ba) { e.preventDefault(); boardAction(ba.getAttribute('data-ba'), ba.getAttribute('data-n'), ba); return; }
      if (bq) {
        e.preventDefault(); var id = bq.getAttribute('data-bsq');
        if (id === 'all') G.bsel = {}; else G.bsel[+id] = !G.bsel[+id];
        hud(); return;
      }
      if (bo) {
        e.preventDefault(); var vs = G.B.ships[G.view], rr = vs && vs.plan.roomByN[+bo.getAttribute('data-bo')];
        if (rr) {
          boardTap(vs, rr);
          // камера — к цели
          var vv = view(); ICAM.x = rr.cx; ICAM.y = rr.cy - (vv.cy - CAM.vh / 2) / ICAM.s;
        }
        return;
      }
      var b = e.target.closest('[data-shf]'); if (!b) return;
      e.preventDefault();
      var sh = G.B.ships[G.sel]; if (!sh || sh.dead) return;
      var q = +b.getAttribute('data-shf');
      if (q < 0 || (sh.focus === q && !sh.focusAuto)) { if (G.B.autoShields) G.B.autoShields(G.sel); else sh.focusAuto = true; toast('Щиты распределяет экипаж: к ближайшему врагу', 'gold'); }
      else { G.B.setFocus(G.sel, q); toast('Щиты: усилен ' + ['нос', 'правый борт', 'корма', 'левый борт'][q], 'gold'); }
      hud();
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
      else if (k === 'shuttles') assign({ k: 'shuttles' }, 'по абордажным шаттлам');
      else if (!foe) return;
      else if (k === 'hull') assign({ k: 'hull', ship: foe.n }, foe.name + ', корпус');
      else if (k === 'sys') { var sy = b.getAttribute('data-sys'); assign({ k: 'sys', ship: foe.n, sys: sy }, foe.name + ', ' + SP.SYS_BY[sy].name.toLowerCase()); }
      else if (k === 'aim') {
        G.aim = !G.aim;
        if (G.aim) {
          if (G.mode === 'inside') setMode('space');
          if (!seen(foe)) { G.aim = false; toast(foe.name + ': нет контакта — схему не видно', 'bad'); hud(); return; }
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
    $('sp-inside').onclick = function() { if (G.B && G.B.ships[G.sel] && !G.B.ships[G.sel].dead) setMode(G.mode === 'inside' ? 'space' : 'inside'); else if (G.mode === 'inside') setMode('space'); };
    $('sp-view').onclick = function() {
      if (!G.B) return;
      if (G.mode === 'inside') {
        var p = G.B.ships[G.view].plan, v = view();
        ICAM.s = Math.min((CAM.vw - 20) / p.w, (v.h - 10) / p.h); ICAM.x = p.w / 2; ICAM.y = p.h / 2 - (v.cy - CAM.vh / 2) / ICAM.s;
      } else fitAll();
    };
    var snd = $('sp-snd'), SX = window.SPSfx;
    if (SX) {
      snd.classList.toggle('off', !SX.isOn());
      snd.onclick = function() { SX.setOn(!SX.isOn()); snd.classList.toggle('off', !SX.isOn()); toast(SX.isOn() ? 'Звук включён' : 'Звук выключен'); };
    } else snd.hidden = true;
    $('sp-fold').onclick = function() {
      var b = $('sp-bottom'); b.classList.toggle('min');
      $('sp-fold').textContent = b.classList.contains('min') ? '▴ приказы' : '▾ свернуть';
    };
    $('sp-end-again').onclick = function() {
      if (G.net) { netSend({ t: 'again' }); toast('Реванш: жду сервер…', 'gold'); $('sp-end').hidden = true; return; }
      if (G.task) { runTask(G.task.i); return; }
      start(G.scen, G.side, G.opts);
    };
    $('sp-end-look').onclick = function() { $('sp-end').hidden = true; };
  }

  function endBattle() {
    G.ended = true; $('sp-toast').className = 'sp-toast'; G.quiet = true;
    var B = G.B, win = B.over === G.side, lost = B.ships.filter(function(s) { return s.dead && s.side === G.side; }).length;
    var killed = B.ships.filter(function(s) { return s.dead && s.side !== G.side; });
    $('sp-end-title').textContent = B.over === 2 ? 'Взаимное уничтожение' : win ? 'Победа' : 'Поражение';
    var t = B.t | 0;
    $('sp-end-text').innerHTML = 'Бой шёл ' + Math.floor(t / 60) + ' мин ' + (t % 60) + ' с.<br>' +
      'Уничтожено: ' + (killed.length ? killed.map(function(s) { return esc(s.name) + (s.why === 'reactor' ? ' (реактор)' : s.why === 'ram' ? ' (столкновение)' : s.why === 'captured' ? ' (захвачен — трофей)' : ''); }).join(', ') : 'никого') + '.<br>' +
      'Потери: ' + (lost ? lost + ' ' + plural(lost, 'корабль', 'корабля', 'кораблей') : 'нет') + '.';
    $('sp-end-again').textContent = G.task ? 'Задачу заново' : G.net ? 'Реванш' : 'Ещё бой';
    $('sp-end').hidden = false;
  }

  var toastT = 0, toastAt = 0;
  function toast(msg, kind) {
    var el = $('sp-toast'), t = performance.now();
    if (G.quiet && !$('sp-end').hidden) return;          // поверх итога боя — не мешать
    if (kind !== 'bad' && t - toastAt < 600 && el.classList.contains('bad')) return;   // важное не перебивать
    toastAt = t;
    el.textContent = msg; el.className = 'sp-toast show' + (kind ? ' ' + kind : '');
    clearTimeout(toastT); toastT = setTimeout(function() { el.className = 'sp-toast'; }, 2400);
  }

  // ---------------------------------------------------------------- полигон
  // Окно перед боем: задачи этапа (каждая ставит ситуацию и сама проверяет
  // итог) и свой бой (корабли сторон, дистанция, враг воюет или стоит мишенью).
  var TASKS = window.SPTasks ? window.SPTasks.LIST : [];
  var POLY = { tab: 'tasks', side: 0, a: ['venator'], b: ['providence'], dist: 8000, idle: false, fill: 1 };
  function polyLoad() {
    try { var v = JSON.parse(localStorage.getItem('sp-poly') || 'null'); if (v && NETLIB.cfgClean(v)) { POLY.a = v.a; POLY.b = v.b; POLY.dist = v.dist; POLY.idle = !!v.idle; POLY.side = v.side === 1 ? 1 : 0; POLY.fill = v.fill === 0 || v.fill === 0.5 ? v.fill : 1; } } catch (e) {}
  }
  function polySave() { try { localStorage.setItem('sp-poly', JSON.stringify({ a: POLY.a, b: POLY.b, dist: POLY.dist, idle: POLY.idle, side: POLY.side, fill: POLY.fill })); } catch (e) {} }
  function doneMap() { try { return JSON.parse(localStorage.getItem('sp-tasks') || '{}') || {}; } catch (e) { return {}; } }
  function markDone(id, v) { var m = doneMap(); if (v === 'ok' || !m[id]) m[id] = v; try { localStorage.setItem('sp-tasks', JSON.stringify(m)); } catch (e) {} }
  // Описание боя в любом виде → { name, ships }
  function scObj(s) {
    if (typeof s === 'string') return SCEN[s];
    if (s && s.cfg) {
      // свой бой: трюмы — типовые, насколько заполнить задаёт игрок
      var lay = NETLIB.layout(s.cfg), fill = s.cfg.fill == null ? 1 : s.cfg.fill;
      lay.forEach(function(x) { x[4] = window.SWArmy.typicalArmy(x[0], fill); });
      return { name: NETLIB.cfgName(s.cfg), ships: lay };
    }
    return s;
  }
  function scName(s) { var o = scObj(s); return o ? o.name : ''; }
  // ---- «Мой флот»: корабли игрока из игры как есть (только чтение, итог боя пока не пишется)
  var FLEET = { state: 'idle', ships: [], sel: [], foe: ['providence'], err: '', side: 0, uid: null, sys: {} };
  function sbReady() {
    if (window.supabase && typeof window.supabase.rpc === 'function') return Promise.resolve();
    return loadScript('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2').then(function() { return loadScript('../js/supabase-client.js'); });
  }
  function fleetLoad() {
    FLEET.state = 'load'; FLEET.err = ''; polyDraw();
    var sb, uid;
    sbReady().then(function() { sb = window.supabase; return sb.auth.getSession(); }).then(function(r) {
      var ses = r && r.data && r.data.session;
      if (!ses) { FLEET.state = 'login'; polyDraw(); return null; }
      uid = ses.user.id; FLEET.uid = uid;
      return Promise.all([
        sb.from('profiles').select('faction').eq('id', uid).maybeSingle(),
        sb.from('ships').select('id,ship_type,name,hp,system_id,faction,in_transit,carrier_ship_id,shield_fore,shield_aft,shield_port,shield_starboard,shields_updated_at,trophy,boarding_eff,bonus_hp,bonus_shield,bonus_fore,bonus_damage,upgrades').eq('owner_user_id', uid),
        sb.from('unit_positions').select('id,unit_type,quantity,hp,bonus_hp,bonus_damage,hero_name,carrier_ship_id').eq('owner_user_id', uid).not('carrier_ship_id', 'is', null),
        sb.from('ship_types').select('id,name,max_hp,max_shield,shield_regen,damage,capacity'),
        sb.from('systems').select('id,name'),
        sb.from('game_settings').select('value').eq('key', 'shield_regen_seconds').maybeSingle()
      ]);
    }).then(function(res) {
      if (!res) return;
      for (var i = 0; i < res.length; i++) if (res[i].error) throw new Error(res[i].error.message);
      var prof = res[0].data || {}, ships = res[1].data || [], units = res[2].data || [], types = {}, sys = {};
      (res[3].data || []).forEach(function(t) { types[t.id] = t; });
      (res[4].data || []).forEach(function(s) { sys[s.id] = s.name; });
      FLEET.side = prof.faction === 'cis' ? 1 : 0; FLEET.sys = sys;
      var regenSec = parseInt(res[5].data && res[5].data.value, 10) || 30;
      var byShip = {}, hangar = {};
      units.forEach(function(u) { (byShip[u.carrier_ship_id] = byShip[u.carrier_ship_id] || []).push(u); });
      ships.forEach(function(s) { if (s.carrier_ship_id) (hangar[s.carrier_ship_id] = hangar[s.carrier_ship_id] || []).push(s); });
      FLEET.ships = ships.filter(function(s) { return !s.carrier_ship_id && window.SWArmy.SHIP[s.ship_type] && NETLIB.SHIP_BY[s.ship_type]; }).map(function(s) {
        var a = window.SWArmy.fromGame(s, types[s.ship_type] || null, byShip[s.id] || [], hangar[s.id] || [], { regenSec: regenSec });
        a.system = s.system_id; a.transit = !!s.in_transit; a.side = window.SWArmy.SHIP[s.ship_type][1];
        return a;
      }).sort(function(x, y) { return (x.system || '').localeCompare(y.system || '') || y.roster.length - x.roster.length; });
      FLEET.sel = FLEET.sel.filter(function(id) { return FLEET.ships.some(function(s) { return s.id === id; }); });
      FLEET.foe = [FLEET.side === 0 ? 'providence' : 'venator'];
      FLEET.state = 'ok'; polyDraw();
    }).catch(function(e) { FLEET.state = 'err'; FLEET.err = e.message || String(e); polyDraw(); });
  }
  function fleetDraw() {
    var box = $('sp-poly-fleet');
    if (FLEET.state === 'idle') { fleetLoad(); return; }
    if (FLEET.state === 'load') { box.innerHTML = '<p class="sp-poly-about">Загружаю твои корабли из игры…</p>'; return; }
    if (FLEET.state === 'login') {
      box.innerHTML = '<p class="sp-poly-about">Свой флот берётся из игры — нужно войти.</p><div class="sp-btns" style="grid-template-columns:1fr"><a class="sp-btn gold sp-a" href="../auth.html?next=' + encodeURIComponent('space/') + '">Войти в игру</a></div>';
      return;
    }
    if (FLEET.state === 'err') { box.innerHTML = '<div class="sp-net-err">Не загрузилось: ' + esc(FLEET.err) + '</div><div class="sp-btns" style="grid-template-columns:1fr"><button class="sp-btn" data-fleet-reload="1">Ещё раз</button></div>'; return; }
    if (!FLEET.ships.length) { box.innerHTML = '<p class="sp-poly-about">У тебя пока нет боевых кораблей. Их строят на верфи, а десант грузят в трюм в игре.</p>'; return; }
    var html = '<p class="sp-poly-about">Корабли как в игре: корпус, щиты, улучшения, десант в трюме поимённо, машины в ангаре. Итог боя в игру пока не пишется. До трёх кораблей.</p>', lastSys = null;
    FLEET.ships.forEach(function(a) {
      if (a.system !== lastSys) { lastSys = a.system; html += '<div class="sp-poly-lab">' + esc(FLEET.sys[a.system] || a.system || 'в пути') + '</div>'; }
      var on = FLEET.sel.indexOf(a.id) >= 0, sm = window.SWArmy.summary(a.roster), heroes = a.roster.filter(function(r) { return r.name; });
      html += '<button class="sp-fl' + (on ? ' on' : '') + (a.transit ? ' off' : '') + '" data-fship="' + a.id + '">' +
        '<span class="nm"><b>' + esc(a.name) + '</b><em>' + (a.name !== window.SWArmy.shipName(a.cls) ? esc(window.SWArmy.shipName(a.cls)) + ' · ' : '') + 'корпус ' + Math.round(a.hpK * 100) + '%' + (a.dmgK > 1.001 ? ' · пушки +' + Math.round((a.dmgK - 1) * 100) + '%' : '') + '</em></span>' +
        '<span class="cg">' + (a.roster.length ? 'десант <b>' + a.roster.length + '</b>' + (heroes.length ? ' · <b class="hero">★ ' + heroes.map(function(h) { return esc(h.name); }).join(', ') + '</b>' : '') : '<i>трюм пуст</i>') +
        (a.vehicles.length ? ' · техника ' + a.vehicles.length : '') + (a.hangar.length ? ' · машин ' + a.hangar.length : '') + '</span>' +
        (sm.length ? '<span class="sm">' + sm.slice(0, 4).map(function(x) { return esc(x[0]) + ' ×' + x[1]; }).join(' · ') + '</span>' : '') + '</button>';
    });
    var foes = NETLIB.SHIPS.filter(function(x) { return x[2] !== FLEET.side; }).map(function(x) {
      return '<button class="sp-chip' + (FLEET.foe.indexOf(x[0]) >= 0 ? ' on' : '') + '" data-ffoe="' + x[0] + '">' + esc(window.SWArmy.shipName(x[0])) + '</button>';
    }).join('');
    html += '<div class="sp-poly-lab">Противник · ИИ, типовой состав</div><div class="sp-poly-chips">' + foes + '</div>' +
      '<div class="sp-btns" style="grid-template-columns:1fr"><button class="sp-btn gold" data-fgo="1">' + (FLEET.sel.length ? 'В бой: ' + FLEET.sel.length + ' ' + plural(FLEET.sel.length, 'корабль', 'корабля', 'кораблей') : 'Выбери свои корабли') + '</button></div>';
    box.innerHTML = html;
  }
  function fleetGo() {
    if (!FLEET.sel.length) { toast('Выбери хотя бы один свой корабль', 'bad'); return; }
    var mine = FLEET.ships.filter(function(a) { return FLEET.sel.indexOf(a.id) >= 0; });
    var side = FLEET.side, cfg = { a: [], b: [], dist: POLY.dist };
    var list = side === 0 ? cfg.a : cfg.b, other = side === 0 ? cfg.b : cfg.a;
    mine.forEach(function(a) { list.push(a.cls); }); FLEET.foe.forEach(function(id) { other.push(id); });
    var lay = NETLIB.layout(cfg), k = 0;
    lay.forEach(function(s) { if (s[1] === side) s[4] = mine[k++]; });
    polyOpen(false);
    start({ name: 'Мой флот', ships: lay }, side);
  }
  function polyOpen(show) {
    var el = $('sp-poly');
    if (!show) { el.hidden = true; return; }
    if (G.net) { toast('Сейчас бой по сети — сначала «Выйти»', 'bad'); return; }
    polyDraw(); el.hidden = false;
  }
  function polyDraw() {
    var tabs = document.querySelectorAll('#sp-poly [data-ptab]');
    for (var i = 0; i < tabs.length; i++) tabs[i].classList.toggle('on', tabs[i].getAttribute('data-ptab') === POLY.tab);
    $('sp-poly-tasks').hidden = POLY.tab !== 'tasks';
    $('sp-poly-own').hidden = POLY.tab !== 'own';
    $('sp-poly-fleet').hidden = POLY.tab !== 'fleet';
    if (POLY.tab === 'fleet') fleetDraw();
    var dm = doneMap(), ok = 0;
    TASKS.forEach(function(t) { if (dm[t.id] === 'ok') ok++; });
    $('sp-poly-prog').innerHTML = 'пройдено <b>' + ok + '</b> из <b>' + TASKS.length + '</b>';
    $('sp-poly-list').innerHTML = TASKS.map(function(t, i) {
      var st = dm[t.id];
      return '<button class="sp-task' + (st === 'ok' ? ' ok' : st === 'fail' ? ' fail' : '') + '" data-task="' + i + '">' +
        '<span class="n">' + (st === 'ok' ? '✓' : i + 1) + '</span><span class="tx"><b>' + esc(t.title) + '</b><em>' + esc(t.goal) + '</em></span>' +
        '<span class="go">' + (st === 'ok' ? 'ещё раз' : 'начать') + '</span></button>';
    }).join('');
    // свой бой
    $('sp-poly-side').innerHTML = ['Республика', 'КНС'].map(function(n, s) { return '<button class="sp-chip' + (POLY.side === s ? ' on' : '') + '" data-pside="' + s + '">' + n + '</button>'; }).join('');
    var row = function(sd, list) {
      return NETLIB.SHIPS.filter(function(x) { return x[2] === sd; }).map(function(x) {
        var on = list.indexOf(x[0]) >= 0;
        return '<button class="sp-chip' + (on ? ' on' : '') + '" data-pship="' + x[0] + '">' + esc(x[1]) + '<em>' + (x[3] >= 1000 ? (x[3] / 1000).toFixed(1) + ' км' : x[3] + ' м') + '</em></button>';
      }).join('');
    };
    $('sp-poly-a').innerHTML = row(0, POLY.a);
    $('sp-poly-b').innerHTML = row(1, POLY.b);
    $('sp-poly-dist').innerHTML = [[4500, 'близко 4,5 км'], [8000, 'средне 8 км'], [14000, 'далеко 14 км']].map(function(d) {
      return '<button class="sp-chip' + (POLY.dist === d[0] ? ' on' : '') + '" data-pdist="' + d[0] + '">' + d[1] + '</button>';
    }).join('');
    $('sp-poly-foe').innerHTML = [[false, 'враг воюет'], [true, 'мишень: стоит, не стреляет']].map(function(d) {
      return '<button class="sp-chip' + (POLY.idle === d[0] ? ' on' : '') + '" data-pidle="' + (d[0] ? 1 : 0) + '">' + d[1] + '</button>';
    }).join('');
    $('sp-poly-fill').innerHTML = [[0, 'пустой'], [0.5, 'половина'], [1, 'полный']].map(function(d) {
      return '<button class="sp-chip' + (POLY.fill === d[0] ? ' on' : '') + '" data-pfill="' + d[0] + '">' + d[1] + '</button>';
    }).join('');
    // во что обойдётся десант в игре: типовой состав по трюмам
    var cs = [0, 0], cn = [0, 0];
    [POLY.a, POLY.b].forEach(function(list, sd) { list.forEach(function(id) { var r = window.SWArmy.typical(id, POLY.fill); cn[sd] += r.length; cs[sd] += window.SWArmy.cost(r); }); });
    $('sp-poly-sum').innerHTML = esc(NETLIB.cfgName(POLY)) + ' · ты за ' + SIDE_NAME[POLY.side] +
      '<br><span class="sp-dim">десант: Республика <b>' + cn[0] + '</b> (' + cs[0].toLocaleString('ru') + ' кр) · КНС <b>' + cn[1] + '</b> (' + cs[1].toLocaleString('ru') + ' кр) — типовой состав, в игре бойцов покупают</span>';
  }
  function polyBind() {
    var el = $('sp-poly');
    el.addEventListener('click', function(e) {
      var b = e.target.closest('button'); if (!b) return;
      if (b.hasAttribute('data-ptab')) { POLY.tab = b.getAttribute('data-ptab'); polyDraw(); return; }
      if (b.hasAttribute('data-task')) { polyOpen(false); runTask(+b.getAttribute('data-task')); return; }
      if (b.hasAttribute('data-pside')) { POLY.side = +b.getAttribute('data-pside'); polySave(); polyDraw(); return; }
      if (b.hasAttribute('data-pship')) {
        var id = b.getAttribute('data-pship'), sd = NETLIB.SHIP_BY[id][2], list = sd === 0 ? POLY.a : POLY.b, k = list.indexOf(id);
        if (k >= 0) { if (list.length > 1) list.splice(k, 1); else toast('Хотя бы один корабль на сторону', 'bad'); }
        else if (list.length >= 3) toast('Не больше трёх кораблей на сторону', 'bad');
        else list.push(id);
        polySave(); polyDraw(); return;
      }
      if (b.hasAttribute('data-pdist')) { POLY.dist = +b.getAttribute('data-pdist'); polySave(); polyDraw(); return; }
      if (b.hasAttribute('data-pidle')) { POLY.idle = b.getAttribute('data-pidle') === '1'; polySave(); polyDraw(); return; }
      if (b.hasAttribute('data-pfill')) { POLY.fill = +b.getAttribute('data-pfill'); polySave(); polyDraw(); return; }
      if (b.hasAttribute('data-fship')) {
        var fid = b.getAttribute('data-fship'), fk = FLEET.sel.indexOf(fid), fs = FLEET.ships.filter(function(x) { return x.id === fid; })[0];
        if (fs && fs.transit) { toast('Корабль в пути — в бой нельзя', 'bad'); return; }
        if (fk >= 0) FLEET.sel.splice(fk, 1); else if (FLEET.sel.length >= 3) toast('Не больше трёх кораблей', 'bad'); else FLEET.sel.push(fid);
        polyDraw(); return;
      }
      if (b.hasAttribute('data-ffoe')) {
        var ff = b.getAttribute('data-ffoe'), fi = FLEET.foe.indexOf(ff);
        if (fi >= 0) { if (FLEET.foe.length > 1) FLEET.foe.splice(fi, 1); } else if (FLEET.foe.length >= 3) toast('Не больше трёх врагов', 'bad'); else FLEET.foe.push(ff);
        polyDraw(); return;
      }
      if (b.hasAttribute('data-fgo')) { fleetGo(); return; }
      if (b.hasAttribute('data-fleet-reload')) { FLEET.state = 'idle'; polyDraw(); return; }
      if (b.id === 'sp-poly-go') { polyOpen(false); start({ cfg: NETLIB.cfgClean(POLY) }, POLY.side, { idle: POLY.idle }); return; }
      if (b.id === 'sp-poly-net') { polyOpen(false); G.side = POLY.side; netOpen(netCode(), 'vp', POLY.side, NETLIB.cfgClean(POLY)); return; }
      if (b.id === 'sp-poly-close') { polyOpen(false); return; }
    });
    $('sp-task-again').onclick = function() { if (G.task) runTask(G.task.i); };
    $('sp-task-list').onclick = function() { polyOpen(true); };
    $('sp-task-x').onclick = function() { G.task = null; taskRow(); };
  }
  // Задача: свой корабль против вражеского, ситуация — из prep
  function runTask(i) {
    var t = TASKS[i]; if (!t) return;
    var side = G.side === 1 ? 1 : 0, pair = t.ships[side];
    var sc = { name: t.title, ships: [[pair[0], side, 0, 0], [pair[1], 1 - side, t.dist || 8000, 600]] };
    start(sc, side, { task: { i: i, t: t } });
  }
  // После загрузки боя: поставить ситуацию задачи
  function taskBegin(task) {
    var B = G.B, t = task.t, x = { side: G.side, me: window.SPTasks.mine(B, G.side), foe: window.SPTasks.enemy(B, G.side), dt: 0, line: '' };
    G.task = { i: task.i, t: t, x: x, state: null, t0: B.t };
    B.sense();
    try { if (t.prep) t.prep(B, x); } catch (e) { toast('Задача не поставилась: ' + e.message, 'bad'); }
    B.sense(); buildTargets(); hud();
    if (t.look === 'foe') setMode('inside', x.foe.n);
    else if (t.look) setMode('inside', x.me.n);
    else fitAll();
    toast('Задача: ' + t.goal, 'gold');
    taskRow();
  }
  function taskStep(dt) {
    var T = G.task; if (!T || T.state || !G.B) return;
    var x = T.x; x.dt = dt; x.inside = G.mode === 'inside' && G.view === x.me.n;
    var r = null;
    try { r = T.t.check(G.B, x); } catch (e) { r = null; }
    if (r) {
      T.state = r; markDone(T.t.id, r);
      toast(r === 'ok' ? 'Задача выполнена: ' + T.t.title + ' ✓' : 'Не вышло: ' + T.t.title + ' — попробуй ещё раз', r === 'ok' ? 'gold' : 'bad');
    }
  }
  function taskRow() {
    var row = $('sp-taskrow'), T = G.task;
    document.body.classList.toggle('task', !!T);
    if (!T) { row.hidden = true; return; }
    row.hidden = false;
    row.className = 'sp-row sp-taskrow' + (T.state === 'ok' ? ' ok' : T.state === 'fail' ? ' fail' : '');
    $('sp-task-n').textContent = T.state === 'ok' ? '✓' : T.state === 'fail' ? '✗' : String(T.i + 1);
    $('sp-task-t').innerHTML = '<b>' + esc(T.t.title) + '</b> · ' + esc(T.state === 'ok' ? 'выполнено' : T.state === 'fail' ? 'не вышло' : T.x.line || T.t.goal);
    $('sp-task-how').textContent = T.state ? '' : T.t.how;
  }
  // Скорость боя: пауза, ×1, ×2, ×4 (по сети — для обоих)
  function setSpeed(v) {
    G.speed = v;
    if (G.net) netSend({ t: 'speed', v: v });
    speedUi();
  }
  function speedUi() {
    var v = G.net ? (G.net.spd != null ? G.net.spd : 1) : G.speed;
    $('sp-pause').classList.toggle('on', v === 0);
    $('sp-pause').innerHTML = v === 0 ? '▶' : '❚❚';
    $('sp-spd').textContent = '×' + (v === 0 ? (G.lastSpd || 1) : v);
    if (v) G.lastSpd = v;
  }

  // ---------------------------------------------------------------- бой по сети
  // Комната на двоих на игровом сервере: сервер считает бой целиком (корабли,
  // экипажи, абордаж, туман войны), телефон рисует присланное и шлёт приказы.
  // Ссылка: space/?room=КОД&scen=БОЙ. Пока второго нет — за его сторону ИИ.
  var NET_TRY = [1500, 3000, 6000, 10000, 15000];
  function netParam(k) { var m = location.search.match(new RegExp('[?&]' + k + '=([^&]+)')); return m ? decodeURIComponent(m[1]) : ''; }
  // замеры на своём сервере (RT_DEV): ?srv=http://127.0.0.1:8080&dev=1 — вход без базы
  var NET_DEV = netParam('dev') === '1' && /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(netParam('srv')) ? netParam('srv') : '';
  function netLink(code, scen, cfg) { return location.origin + location.pathname + '?room=' + code + (cfg ? '' : '&scen=' + scen); }
  function netCode() {
    var a = 'abcdefghjkmnpqrstuvwxyz23456789', s = '';
    var r = window.crypto && crypto.getRandomValues ? crypto.getRandomValues(new Uint8Array(5)) : null;
    for (var i = 0; i < 5; i++) s += a[(r ? r[i] : Math.floor(Math.random() * 256)) % a.length];
    return s;
  }
  function loadScript(src) {
    return new Promise(function(res, rej) {
      var el = document.createElement('script'); el.src = src; el.onload = res; el.onerror = function() { rej(new Error('не загрузилось: ' + src)); };
      document.head.appendChild(el);
    });
  }
  // Вход и адрес сервера: сессия игры (Supabase) и rt_server_status
  function netAuth() {
    if (NET_DEV) return Promise.resolve({ url: NET_DEV, token: 'dev' });
    var sb = window.supabase && typeof window.supabase.rpc === 'function' ? Promise.resolve() :
      loadScript('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2').then(function() { return loadScript('../js/supabase-client.js'); });
    return sb.then(function() { return window.supabase.auth.getSession(); }).then(function(r) {
      var ses = r && r.data && r.data.session;
      if (!ses) { var e = new Error('Нужно войти в игру'); e.login = true; throw e; }
      return window.supabase.rpc('rt_server_status').then(function(res) {
        var d = res && res.data;
        if (!d || !d.online || !d.url) throw new Error('Игровой сервер сейчас не на связи');
        return { url: d.url, token: ses.access_token };
      });
    });
  }
  function netOpen(code, scen, want, cfg) {
    if (G.net) netClose(true);
    ++START;                                         // местный бой, если грузился, больше не нужен
    G.task = null; taskRow();
    G.net = { code: code, scen: scen, cfg: cfg || null, want: want, ws: null, M: null, side: -1, seats: null, tries: 0, q: [], ready: false, round: 0, lastAt: 0, vkey: '' };
    try { history.replaceState(null, '', '?room=' + code + (cfg ? '' : '&scen=' + scen) + (NET_DEV ? '&srv=' + encodeURIComponent(NET_DEV) + '&dev=1' : '')); } catch (e) {}
    netPanel(false); netRow();
    toast('Бой по сети: подключаюсь…', 'gold');
    netAuth().then(function(a) { if (G.net && G.net.code === code) { G.net.auth = a; netConnect(); } }, function(e) {
      netFail(e.message, e.login);
    });
  }
  function netConnect() {
    var N = G.net; if (!N || !N.auth) return;
    var ws;
    try { ws = new WebSocket(N.auth.url.replace(/^http/, 'ws') + '/ws'); } catch (e) { netFail('Сервер недоступен'); return; }
    ws.binaryType = 'arraybuffer';
    N.ws = ws; N.ok = false; netRow();
    ws.onopen = function() { ws.send(JSON.stringify({ t: 'auth', token: N.auth.token, room: 'sp:' + N.code + ':' + N.scen, side: N.side >= 0 ? N.side : N.want, cfg: N.cfg || undefined })); };
    ws.onmessage = function(e) {
      if (G.net !== N || N.ws !== ws) return;
      N.lastAt = performance.now();
      if (typeof e.data !== 'string') { if (N.ready) N.M.onBin(e.data); else N.q.push(e.data); return; }
      var m; try { m = JSON.parse(e.data); } catch (er) { return; }
      if (m.t === 'hello') { N.ok = true; N.tries = 0; N.spd = m.spd != null ? m.spd : 1; netHello(m); return; }
      if (m.t === 'roster') { N.seats = m.seats; netRow(); return; }
      if (m.t === 's' && m.spd != null && m.spd !== N.spd) { N.spd = m.spd; speedUi(); }
      if (m.t === 'error') { N.err = m.msg; return; }
      if (m.t === 'note') { toast(m.msg, 'gold'); return; }
      if (m.t === 'pong') return;
      if (N.ready) N.M.onText(m); else N.q.push(m);
    };
    ws.onclose = function(ev) {
      if (G.net !== N || N.ws !== ws) return;
      N.ws = null; N.ready = N.ready && false; netRow();
      // отказ сервера (полная комната, вход не подтверждён) — не повторять
      if (ev.code === 4003 || ev.code === 4004 || ev.code === 4005 || ev.code === 4006) { netFail(N.err || 'Сервер не пустил в бой'); return; }
      if (N.tries >= NET_TRY.length) { netFail('Нет связи с сервером'); return; }
      toast(N.ok ? 'Связь прервалась — переподключаюсь…' : 'Сервер не ответил — пробую ещё', 'bad');
      setTimeout(function() { if (G.net === N) netConnect(); }, NET_TRY[N.tries++]);
    };
  }
  // Сервер прислал бой: собрать зеркало (те же корабли и экипажи — расчёт не идёт)
  function netHello(m) {
    var N = G.net, sc = m.cfg ? scObj({ cfg: m.cfg }) : SCEN[m.scen]; if (!sc) { netFail('Сервер прислал неизвестный бой'); return; }
    if (m.cfg) N.cfg = m.cfg;
    N.ready = false; N.q = []; N.side = m.side; N.round = m.round;
    var token = ++START;
    loadShips(sc).then(function() {
      if (token !== START || G.net !== N) return;
      var B = makeBattle(sc, [false, false]);
      G.side = m.side; G.scen = m.cfg ? { cfg: m.cfg } : m.scen;
      N.M = new NETLIB.Mirror(B, m.side, netSend, window.SWBoard);
      setupBattle(B, G.scen);
      N.ready = true; N.vkey = '';
      netRow();
      var q = N.q; N.q = [];
      for (var i = 0; i < q.length; i++) { if (q[i] instanceof ArrayBuffer) N.M.onBin(q[i]); else N.M.onText(q[i]); }
      toast((m.T > 1 ? 'Ты в бою: ' : 'Бой по сети начался: ') + SIDE_NAME[m.side] + '. Ссылка для соперника — «Ссылка»', 'gold');
    }).catch(function(e) { netFail('Не загрузилось: ' + e.message); });
  }
  function netSend(m) { var N = G.net; if (N && N.ws && N.ws.readyState === 1) N.ws.send(JSON.stringify(m)); }
  // Что игрок смотрит: сервер шлёт людей и отсеки только этого корабля
  function netView() {
    var N = G.net, v = G.mode === 'inside' ? G.view : -1, k = G.sel + ':' + G.foe + ':' + v, t = performance.now();
    N.M.viewN = v;
    if (k === N.vkey && t - (N.vAt || 0) < 3000) return;
    N.vkey = k; N.vAt = t;
    netSend({ t: 'cmd', k: 'view', sel: G.sel, foe: G.foe, view: v });
  }
  function netFail(msg, login) {
    var N = G.net; if (!N) return;
    N.fail = msg; N.login = !!login;
    netRow(); netPanel(true);
  }
  function netClose(quiet) {
    var N = G.net; if (!N) return;
    G.net = null;
    if (N.ws) { N.ws.onclose = null; try { N.ws.close(); } catch (e) {} }
    try { history.replaceState(null, '', location.pathname); } catch (e) {}
    netRow();
    if (!quiet) toast('Бой по сети закрыт', 'gold');
  }
  function netShare() {
    var N = G.net; if (!N) return;
    var url = netLink(N.code, N.scen, N.cfg);
    if (navigator.share) { navigator.share({ title: 'Космический бой 2.0', text: 'Бой по сети: ' + scName(N.cfg ? { cfg: N.cfg } : N.scen), url: url }).catch(function() {}); return; }
    var done = function() { toast('Ссылка скопирована — отправь сопернику', 'gold'); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(done, function() { window.prompt('Ссылка на бой', url); });
    else window.prompt('Ссылка на бой', url);
  }
  // Строка «по сети» в верхней панели: код, связь, соперник
  function netRow() {
    var row = $('sp-netrow'), N = G.net;
    document.body.classList.toggle('net', !!N);
    if (!N) { row.hidden = true; return; }
    row.hidden = false;
    var st = !N.ws ? (N.fail ? 'bad' : 'wait') : N.ready ? 'ok' : 'wait';
    var foe = '';
    if (N.fail) foe = esc(N.fail);
    else if (!N.ready) foe = 'подключаюсь…';
    else {
      var s = N.seats && N.seats[1 - N.side];
      foe = !s ? 'соперник: —' : s.on ? 'соперник в бою' + (s.nick ? ' · <b>' + esc(s.nick) + '</b>' : '') : s.away ? 'соперник вышел · ждём' : 'за соперника ИИ';
    }
    $('sp-net-dot').className = 'sp-net-dot ' + st;
    $('sp-net-code').textContent = N.code.toUpperCase();
    $('sp-net-foe').innerHTML = foe;
  }
  // Окно «Бой по сети»: создать комнату, войти по коду, ошибки связи
  function netPanel(show) {
    var el = $('sp-net');
    if (!show) { el.hidden = true; return; }
    var N = G.net;
    $('sp-net-scen').textContent = G.scen && G.scen.cfg || SCEN[G.scen] ? scName(G.scen) : SCEN.vp.name;
    var err = $('sp-net-err');
    if (N && N.fail) {
      err.hidden = false;
      err.innerHTML = esc(N.fail) + (N.login ? ' · <a href="../auth.html?next=' + encodeURIComponent('space/?room=' + N.code + '&scen=' + N.scen) + '">Войти</a>' : '');
      $('sp-net-retry').hidden = false;
    } else { err.hidden = true; $('sp-net-retry').hidden = true; }
    el.hidden = false;
  }
  function netBind() {
    $('sp-net-make').onclick = function() {
      // свой бой — с его кораблями; бой из списка — по имени; задача — обычный бой
      if (G.scen && G.scen.cfg) netOpen(netCode(), 'vp', G.side, G.scen.cfg);
      else netOpen(netCode(), typeof G.scen === 'string' ? G.scen : 'vp', G.side);
    };
    $('sp-net-join').onclick = function() {
      var v = String($('sp-net-in').value || '').trim().toLowerCase();
      // вставили всю ссылку — достать код и бой
      var m = v.match(/room=([a-z0-9]{3,12})/), sc = v.match(/scen=([a-z0-9]{2,4})/);
      var code = m ? m[1] : v.replace(/[^a-z0-9]/g, '');
      if (!/^[a-z0-9]{3,12}$/.test(code)) { toast('Код — 3–12 букв и цифр', 'bad'); return; }
      netOpen(code, sc && SCEN[sc[1]] ? sc[1] : typeof G.scen === 'string' ? G.scen : 'vp', -1);
    };
    $('sp-net-in').addEventListener('keydown', function(e) { if (e.key === 'Enter') $('sp-net-join').onclick(); });
    $('sp-net-close').onclick = function() {
      netPanel(false);
      // окно закрыли после ошибки связи — вернуться к своему бою
      if (G.net && G.net.fail) { netClose(true); start(G.scen, G.side >= 0 ? G.side : 0); }
    };
    $('sp-net-retry').onclick = function() { var N = G.net; if (N) netOpen(N.code, N.scen, N.want); };
    $('sp-net-link').onclick = netShare;
    $('sp-net-quit').onclick = function() { netClose(); start(G.scen, G.side); };
    // проверка связи раз в 3 с: давно нет кадров — «жёлтая» точка
    setInterval(function() {
      var N = G.net; if (!N) return;
      netSend({ t: 'ping', at: performance.now() });
      var dot = $('sp-net-dot');
      if (N.ready && N.ws && performance.now() - N.lastAt > 2500) dot.className = 'sp-net-dot wait';
      else if (N.ready && N.ws) dot.className = 'sp-net-dot ok';
    }, 3000);
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
  var mr = qs.match(/[?&]room=([a-z0-9]{3,12})/i);
  polyLoad();
  if (mr) { G.scen = scen; G.side = side; netOpen(mr[1].toLowerCase(), scen, m2 ? side : -1); }
  else {
    start(scen, side);
    // полигон — сразу, если бой не задан ссылкой
    if (!m1) { POLY.side = side; polyOpen(true); }
  }
  requestAnimationFrame(frame);
  window.__sp = { G: G, CAM: CAM, ICAM: ICAM, FR: FR, setMode: setMode, fitAll: fitAll, selectShip: selectShip, CHUNKS: CHUNKS, load: function() { return LOAD; }, boardAction: boardAction, fleet: FLEET, fleetGo: fleetGo, polyDraw: polyDraw };
})();
