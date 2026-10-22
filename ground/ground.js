/* Наземный бой 2.0 — экран (полигон). Движок — shared/rt-ground.js, местность —
 * terrain.js, фигурки — rt-figures (набор картинок), техника — rt-vehicles (набор
 * картинок, башни живьём), герои — rt-heroes (живьём). Оформление и худ — как в
 * космическом бою: верхняя панель, узкая полоса с вкладками и шторка снизу.
 *
 * Управление (как в абордаже): касание своего — выбрать, двойное — весь отряд;
 * касание земли — идти; касание врага — атаковать; долгое нажатие — рамка;
 * кнопки способностей героя: нажал — потом цель. ES5.
 */
(function() {
  'use strict';

  var $ = function(id) { return document.getElementById(id); };
  var TAU = Math.PI * 2;
  var P = window.SWPlanets, U = window.SWUnits, GR = window.SWGround, F = window.SWRTFig, S = window.SWRT, V = window.SWVehicles, H = window.SWHeroes, Army = window.SWArmy, GFX = window.SPGfx, TOWN = window.SWTown, NET = window.SWGroundNet;
  var N = P.N, SQ = GR.SQUARE;
  var TEAMC = { 0: '111,184,255', 1: '255,110,90', 2: '230,200,90' };
  // Масштаб: клетка ≈ 2,5 м. Пехотинец ≈ 0,8 клетки, техника — по своим размерам (AT-TE 4,5 клетки).
  var FIGK = 0.85, HK = FIGK * F.FIG;
  var cv = $('sp-canvas'), ctx = cv.getContext('2d');

  var G = { B: null, ter: null, side: 0, speed: 1, lastSpd: 1, ended: false, usel: [], sheet: '', arm: null, t: 0, dpr: 1, vw: 0, vh: 0, planet: 'naboo',
            poly: { planet: 'naboo', side: 0, role: 'att', size: 'mid', foe: 'ai', cap: 120, lvl: 3 }, layers: { zones: true }, msgSeq: 0, lastTap: null, fps: 0, fpsN: 0, fpsT: 0 };
  // кварталы полигона по уровню: как в игре — по одному на слот
  var POLY_DISTRICTS = [{ slot: 1, id: 'market' }, { slot: 2, id: 'garrison' }, { slot: 3, id: 'hospital' }, { slot: 4, id: 'comms' }];
  var CAM = { x: 72, y: 100, s: 16 };
  var TIERS = [[8, 16], [16, 8], [32, 4], [64, 2]], FOG = null, FOG_T = -1;   // [точек на клетку, клеток в куске]: чем ближе, тем мельче куски
  var ALL = F.withCrew(S.TYPES), FIG_IDX = {}; ALL.forEach(function(t, i) { FIG_IDX[t.id] = i; });
  var ATLAS = null, VAT = null, DEAD = null, ATLAS_PX = 0;

  // ---------------------------------------------------------------- загрузка
  function fetchJson(url) { return fetch(url, { cache: 'no-cache' }).then(function(r) { if (!r.ok) throw new Error(url + ': ' + r.status); return r.json(); }); }
  function loading(on, text) { var el = $('gd-load'); el.classList.toggle('off', !on); if (text) el.querySelector('div').lastChild.textContent = text; }
  var PLANETS = [];
  // Живая планета (игра): ?live=<планета>&srv=<адрес сервера>; токен даёт страница (window.GD_TOKEN) или «dev»
  var LIVE = (function() { var q = /[?&]live=([a-z0-9_]+)/.exec(location.search), sv = /[?&]srv=([^&]+)/.exec(location.search); return q ? { system: q[1], srv: sv ? decodeURIComponent(sv[1]) : (window.GD_SERVER || ''), ws: null, tries: 0 } : (window.GD_LIVE || null); })();
  G.live = LIVE;
  if (LIVE) {
    document.body.classList.add('live');
    fetchJson('../shared/planets/index.json').then(function(list) { PLANETS = list; connectLive(); }).catch(function() { connectLive(); });
  } else fetchJson('../shared/planets/index.json').then(function(list) {
    PLANETS = list;
    $('gd-poly-planet').innerHTML = list.map(function(p) { return '<button class="sp-chip" data-pp="' + p.id + '" type="button">' + p.name + '</button>'; }).join('');
    var q = /[?&]p=([a-z]+)/.exec(location.search);
    start(q && list.some(function(p) { return p.id === q[1]; }) ? q[1] : 'naboo');
  }).catch(function(e) { loading(false); toast('Не загрузился список планет: ' + e.message, 'bad'); });

  // ---------------------------------------------------------------- живая планета по сети
  function connectLive() {
    if (!LIVE.srv) { loading(false); toast('Не задан адрес сервера боёв', 'bad'); return; }
    loading(true, 'Связь с планетой…');
    var url = LIVE.srv.replace(/^http/, 'ws').replace(/\/$/, '') + '/ws', ws;
    try { ws = new WebSocket(url); } catch (e) { loading(false); toast('Сервер боёв недоступен', 'bad'); return; }
    LIVE.ws = ws; G.closing = false;
    // рукопожатие потерялось (связь «заморожена») — сокет висит в подключении вечно: бросить и повторить
    clearTimeout(LIVE.openT);
    LIVE.openT = setTimeout(function() {
      if (LIVE.ws !== ws || ws.readyState !== 0) return;
      LIVE.ws = null; ws.onclose = null; ws.onmessage = null; ws.onopen = null; try { ws.close(); } catch (e) {}
      LIVE.tries++; retryLive(Math.min(5000, 1000 * LIVE.tries) + Math.random() * 500);
    }, 7000);
    ws.onopen = function() {
      Promise.resolve(window.GD_TOKEN ? window.GD_TOKEN() : 'dev').then(function(token) {
        var auth = { t: 'auth', token: token || 'dev', room: LIVE.room || 'gr:' + LIVE.system };
        if (/[?&]side=(0|1)/.test(location.search)) auth.side = +/[?&]side=(0|1)/.exec(location.search)[1];
        ws.send(JSON.stringify(auth));
      });
    };
    ws.onmessage = function(e) {
      LIVE.lastMsg = Date.now();
      var m; try { m = JSON.parse(e.data); } catch (err) { return; }
      if (m.t === 'hello') { LIVE.tries = 0; onHello(m, ws); return; }
      if (m.t === 'error') { loading(false); toast(m.msg || 'Ошибка связи', 'bad'); G.closing = true; return; }
      if (m.t === 'reset') { toast(m.msg || 'Планета изменилась', 'gold'); G.B = null; return; }
      if (m.t === 'note') { toast(m.msg, m.kind || 'gold'); return; }
      if (m.t === 'ev' || m.t === 'evend') { if (window.GD_ON_EV) window.GD_ON_EV(m); return; }     // ивент: худ и итог (js/event-live.js)
      if (G.B && G.B.onText) G.B.onText(m);
    };
    ws.onclose = function() {
      if (G.closing || LIVE.ws !== ws) return;
      LIVE.tries++;
      toast('Связь с планетой прервана, переподключение…', 'bad');
      retryLive(Math.min(5000, 1000 * LIVE.tries) + Math.random() * 500);
    };
  }
  // Переподключение: одна попытка в очереди; сразу — когда сеть вернулась или вкладку открыли снова
  function retryLive(ms) { clearTimeout(LIVE.retryT); LIVE.retryT = setTimeout(function() { LIVE.retryT = 0; connectLive(); }, ms); }
  function liveDown() { return !LIVE.ws || LIVE.ws.readyState > 1; }
  // Связь умерла молча (тоннель, лифт: сокет «открыт», кадров нет) — бросить сокет и переподключиться.
  // Кадры идут 5 раз в секунду: 5 с тишины при открытой вкладке — точно обрыв.
  function liveWatch() {
    if (!G.live || G.closing || !LIVE.ws || LIVE.ws.readyState !== 1 || !LIVE.lastMsg) return;
    if (document.visibilityState === 'hidden' || Date.now() - LIVE.lastMsg < 5000) return;
    var dead = LIVE.ws; LIVE.ws = null; LIVE.lastMsg = 0;
    dead.onclose = null; dead.onmessage = null; try { dead.close(); } catch (e) {}
    LIVE.tries++; toast('Нет связи с сервером боёв — переподключение…', 'bad'); retryLive(300);
  }
  function onHello(h, ws) {
    G.planet = h.system; G.side = h.side;
    var B = new NET.Mirror(h, h.side, function(s) {
      if (ws.readyState === 1 && LIVE.ws === ws) { ws.send(s); return; }
      // приказ ушёл в пустоту — сказать игроку (не чаще раза в 3 с)
      var nw = Date.now(); if (!G.offT || nw - G.offT > 3000) { G.offT = nw; toast('Нет связи — приказ не дошёл, переподключение…', 'bad'); }
    });
    B.noTown = h.kind === 'event';                   // ивент: своя карта без города
    B.buildings = h.buildings || []; B.plots = h.plots || []; B.zones = { deploy: (h.zones || []).map(function(z) { return [z.x, z.y, z.size]; }), slots: (h.plots || []).map(function(p) { return [p.x, p.y]; }) };
    G.B = B; G.ended = false; G.usel = []; G.arm = null; G.sheet = ''; G.autoSel = false; FOG_T = -1; G.t = 0;
    document.body.classList.toggle('cisside', G.side === 1);
    $('sp-side').textContent = G.side === 0 ? 'Республика' : 'КНС';
    $('gd-planet').textContent = h.name || h.system;
    var att = h.att === G.side;
    if (!B.noTown) { $('gd-globe').style.backgroundImage = 'url(../assets/planets/' + h.system + '.png)'; $('gd-goal').textContent = att ? 'Штурм: занять площадь города' : 'Оборона: удержать площадь'; $('gd-goal').className = 'gd-goal' + (att ? ' att' : ''); }
    $('gd-poly-b').hidden = true;
    if (!G.ter || G.terFor !== h.system + '/' + (h.map.settle && h.map.settle.level)) {
      G.ter = window.GTerrain.create(h.map); G.ter.cacheMax = 220; workersStart(h.map); G.terFor = h.system + '/' + (h.map.settle && h.map.settle.level);
      G.base = document.createElement('canvas'); G.base.width = G.base.height = N * 4;
      G.ter.render(G.base.getContext('2d'), 0, 0, N, N, 4);
    }
    if (!G.camSet && !B.noTown) { var tw = B.town; CAM.x = tw[0] + tw[2] / 2; CAM.y = att ? N - 20 : tw[1] + tw[3] / 2; CAM.s = Math.max(6, Math.min(G.vw, G.vh) / 40); G.camSet = true; }
    loading(false); hud();
    if (window.GD_ON_HELLO) window.GD_ON_HELLO(h, B);
  }

  // ---------------------------------------------------------------- бой
  var ARMY = {
    0: { small: [['rep_dc15a', 10], ['rep_heavy', 2], ['rep_sniper', 1], ['rep_medic', 1], ['rep_jedi', 1], ['rep_atrt', 1], ['rep_atte', 1]],
         mid: [['rep_dc15a', 24], ['rep_heavy', 6], ['rep_sniper', 3], ['rep_launcher', 4], ['rep_arc', 4], ['rep_medic', 2], ['rep_engineer', 1], ['rep_jedi', 1], ['rep_atte', 2], ['rep_atrt', 3], ['rep_barc', 2], ['rep_aa', 1], ['rep_laat', 1], ['rep_artillery', 1], ['rep_turbo', 1]],
         big: [['rep_dc15a', 60], ['rep_heavy', 14], ['rep_sniper', 6], ['rep_launcher', 8], ['rep_arc', 8], ['rep_commando', 4], ['rep_medic', 4], ['rep_engineer', 2], ['rep_jedi', 2], ['rep_atte', 4], ['rep_atrt', 6], ['rep_barc', 4], ['rep_aa', 2], ['rep_laat', 2], ['rep_artillery', 2], ['rep_turbo', 2]] },
    1: { small: [['cis_b1', 16], ['cis_b2', 3], ['cis_bx', 1], ['cis_medic', 1], ['cis_sith', 1], ['cis_stap', 1], ['cis_aat', 1]],
         mid: [['cis_b1', 36], ['cis_b2', 8], ['cis_bx', 4], ['cis_b1_sniper', 3], ['cis_b1_launcher', 4], ['cis_medic', 2], ['cis_engineer', 1], ['cis_sith', 1], ['cis_aat', 2], ['cis_stap', 3], ['cis_spider', 1], ['cis_hmp', 1], ['cis_missile', 1], ['cis_artillery', 1], ['cis_mtt', 1]],
         big: [['cis_b1', 90], ['cis_b2', 18], ['cis_bx', 8], ['cis_b1_sniper', 6], ['cis_b1_launcher', 8], ['cis_bounty', 2], ['cis_hunter', 2], ['cis_medic', 4], ['cis_engineer', 2], ['cis_sith', 2], ['cis_aat', 4], ['cis_stap', 6], ['cis_spider', 2], ['cis_hmp', 2], ['cis_missile', 2], ['cis_artillery', 2], ['cis_mtt', 2]] }
  };
  var PORTRAITS = { 0: ['jedi_01', 'jedi_02', 'jedi_03', 'jedi_04', 'jedi_05', 'jedi_06', 'jedi_07', 'jedi_08', 'jedi_09', 'jedi_10', 'jedi_11'], 1: ['sith_01', 'sith_02', 'sith_03', 'sith_04', 'sith_05', 'sith_06'] };
  function placeArmy(B, team, list, box, R, aim) {
    var taken = {}, n = 0, hi = 0;
    list.forEach(function(e) {
      var tid = e[0], Ty = U.type(tid);
      for (var i = 0; i < e[1]; i++) for (var t = 0; t < 500; t++) {
        var x = box[0] + Math.floor(R() * box[2]), y = box[1] + Math.floor(R() * box[3]), size = Ty.size, c = y * N + x;
        if (taken[c] || (size === 2 && (taken[c + 1] || taken[c + N] || taken[c + N + 1]))) continue;
        if (!B.pass[Ty.move + size][c]) continue;
        taken[c] = 1; if (size === 2) { taken[c + 1] = taken[c + N] = taken[c + N + 1] = 1; }
        var ex = { aim: aim };
        if (Ty.hero) { var pl = PORTRAITS[team]; ex.portrait = pl[(hi++) % pl.length]; ex.name = (team === 0 ? 'Джедай ' : 'Ситх ') + hi; ex.passive = team === 0 ? { deflect: 30, acc: 4, evasion: 10, hp: 60, vision: 3 } : { damage: 25, absorb: 30, evasion: 10, hp: 60, vision: 3 }; }
        B.add(tid, team, x + size / 2, y + size / 2, ex); n++; break;
      }
    });
    return n;
  }
  function makeBattle(js) {
    var po = G.poly, att = po.role === 'att' ? po.side : 1 - po.side;
    var B = new GR.Ground(js, { seed: (Date.now() % 100000) | 0, auto0: po.side !== 0, auto1: po.side !== 1, att: att, captureSeconds: po.cap, settle: { level: po.lvl, districts: POLY_DISTRICTS.slice(0, po.lvl) }, militiaAuto: true });
    if (po.foe === 'idle') B.teams[1 - po.side].auto = false;
    var R = GR.rng((Date.now() % 7919) | 0), def = 1 - att, tw = B.town;
    placeArmy(B, att, ARMY[att][po.size], [20, N - 12, 104, 10], R, -Math.PI / 2);
    placeArmy(B, def, ARMY[def][po.size], [tw[0] - 4, tw[1] + tw[3] - 6, tw[2] + 8, 14], R, Math.PI / 2);
    B.addStruct('turret', def, tw[0] + 6, tw[1] + tw[3] + 2); B.addStruct('turret', def, tw[0] + tw[2] - 7, tw[1] + tw[3] + 2);
    B.addStruct('trench', def, tw[0] + 12, tw[1] + tw[3] + 1); B.addStruct('trench', def, tw[0] + 13, tw[1] + tw[3] + 1); B.addStruct('bunker', def, tw[0] + 16, tw[1] + tw[3] + 3);
    B.addStruct('radar', def, tw[0] + 2, tw[1] + 2);
    // гарнизон с самого начала стоит на постах перед площадью (своих потом можно переставить)
    B.deployDefense(def);
    // сторона игрока — без автоприказов; своя оборона по умолчанию держит площадь
    G.side = po.side;
    document.body.classList.toggle('cisside', G.side === 1);
    $('sp-side').textContent = G.side === 0 ? 'Республика' : 'КНС';
    return B;
  }
  function start(planet) {
    loading(true, 'Готовлю планету…');
    G.planet = planet; G.poly.planet = planet;
    var pi = null; PLANETS.forEach(function(p) { if (p.id === planet) pi = p; });
    $('gd-planet').textContent = pi ? pi.name : planet; $('gd-globe').style.backgroundImage = 'url(../assets/planets/' + planet + '.png)';
    fetchJson('../shared/planets/' + planet + '.json').then(function(js) {
      setTimeout(function() {
        G.B = makeBattle(js); G.ended = false; G.usel = []; G.arm = null; G.sheet = ''; G.autoSel = false; FOG_T = -1; G.t = 0;
        // местность — с наложенным городом (стены, кварталы), как в движке
        G.ter = window.GTerrain.create(G.B.mapJson); G.ter.cacheMax = 220; workersStart(G.B.mapJson);
        G.base = document.createElement('canvas'); G.base.width = G.base.height = N * 4;
        G.ter.render(G.base.getContext('2d'), 0, 0, N, N, 4);
        $('sp-end').hidden = true;
        try { history.replaceState(null, '', '?p=' + planet); } catch (e) {}
        var tw = G.B.town; CAM.x = tw[0] + tw[2] / 2; CAM.y = G.side === G.B.att ? N - 20 : tw[1] + tw[3] + 2; CAM.s = Math.max(6, Math.min(G.vw, G.vh) / 40);
        var att = G.B.att === G.side; $('gd-goal').textContent = att ? 'Штурм: занять площадь города' : 'Оборона: удержать площадь города'; $('gd-goal').className = 'gd-goal' + (att ? ' att' : '');
        loading(false); hud();
        toast(att ? 'Штурм: ваш десант внизу карты. Займите площадь в центре города' : 'Оборона: ваш гарнизон у города. Не пустите врага на площадь', 'gold');
      }, 30);
    }).catch(function(e) { loading(false); toast('Планета не загрузилась: ' + e.message, 'bad'); });
  }

  // ---------------------------------------------------------------- наборы картинок
  function atlas() {
    if (ATLAS && ATLAS.ok) return ATLAS;
    if (ATLAS && ATLAS.bad) return ATLAS;
    try {
      var px = Math.round(GFX.Q().atlas);
      ATLAS = F.bake(ALL, px, 10); ATLAS.ok = F.check(ATLAS); if (!ATLAS.ok) ATLAS.bad = true;
      DEAD = F.bakeDead(ALL, px * 2, 16);
      var ids = Object.keys(V.TYPES);
      VAT = V.bake(ids, Math.round(px / (F.FIG * 1.15)), Math.max(72, Math.min(128, px * 2))); if (V.check && !V.check(VAT)) VAT = null;
      ATLAS_PX = px;
    } catch (e) { ATLAS = { bad: true }; }
    return ATLAS;
  }

  // ---------------------------------------------------------------- камера
  function resize() {
    G.dpr = Math.min(window.devicePixelRatio || 1, GFX.Q().dpr); G.vw = window.innerWidth; G.vh = window.innerHeight;
    cv.width = Math.round(G.vw * G.dpr); cv.height = Math.round(G.vh * G.dpr); cv.style.width = G.vw + 'px'; cv.style.height = G.vh + 'px';
    viewCentre();
  }
  // Середина поля на экране. Телефон боком: панели — колонкой слева (ground.css), поле — справа,
  // и камера смотрит в середину свободной части, а не под панели.
  var LAND = window.matchMedia ? window.matchMedia('(orientation: landscape) and (max-height: 500px)') : null;
  function viewCentre() {
    G.cxs = G.vw / 2; G.dockLeft = false;
    if (!LAND || !LAND.matches) return;
    var r = $('sp-bottom').getBoundingClientRect();
    if (r.width && r.right < G.vw * 0.7) { G.cxs = (r.right + G.vw) / 2; G.dockLeft = true; }
  }
  function toS(x, y) { return [(x - CAM.x) * CAM.s + G.cxs, (y - CAM.y) * CAM.s + G.vh / 2]; }
  function toW(px, py) { return [(px - G.cxs) / CAM.s + CAM.x, (py - G.vh / 2) / CAM.s + CAM.y]; }
  function zoomAt(px, py, k) { var w = toW(px, py), s = Math.max(2.5, Math.min(64, CAM.s * k)); CAM.s = s; CAM.x = w[0] - (px - G.cxs) / s; CAM.y = w[1] - (py - G.vh / 2) / s; clampCam(); }
  function clampCam() { var m = 30 / CAM.s; CAM.x = Math.max(-m, Math.min(N + m, CAM.x)); CAM.y = Math.max(-m, Math.min(N + m, CAM.y)); }
  function fitAll() { CAM.s = Math.max(2.5, Math.min(G.vw, G.vh - 220) / N); CAM.x = N / 2; CAM.y = N / 2; }

  // ---------------------------------------------------------------- отрисовка
  function frame(now) {
    // следующий кадр — сразу: любая ошибка ниже пропускает один кадр, а не останавливает бой навсегда
    requestAnimationFrame(frame);
    try { frameBody(now); } catch (err) { if (!G.frameErr || now - G.frameErr > 5000) { G.frameErr = now; console.error('Такт экрана не прошёл:', err); } if (window.errReport) errReport(err, 'ground.frame'); }
  }
  function frameBody(now) {
    var dt = Math.min(0.1, (now - (G.last || now)) / 1000); G.last = now;
    G.vcT = (G.vcT || 0) + dt; if (G.vcT > 0.5) { G.vcT = 0; viewCentre(); }
    G.fpsN++; if (now - G.fpsT > 1000) { G.fps = G.fpsN; G.fpsN = 0; G.fpsT = now; $('sp-fps').textContent = G.fps; }
    var B = G.B;
    if (B) {
      if (G.live) { B.step(dt); G.t = B.t; } else if (!G.ended && G.speed) { B.step(dt * G.speed); G.t = B.t; }
      $('sp-time').textContent = Math.floor(B.t / 60) + ':' + ('0' + Math.floor(B.t % 60)).slice(-2);
      // ошибка в одном кадре не должна останавливать бой: кадр пропускается, цикл живёт
      var d0 = performance.now(); try { draw(); } catch (err) { if (ctx.reset) ctx.reset(); else cv.width = cv.width; if (!G.drawErr || now - G.drawErr > 5000) { G.drawErr = now; console.error('Кадр не отрисован:', err); } if (window.errReport) errReport(err, 'ground.draw'); } G.drawMs = G.drawMs * 0.9 + (performance.now() - d0) * 0.1 || 0; takeMsgs();
      if (B.over >= 0 && !G.ended) endBattle();
    }
    G.hudT = (G.hudT || 0) + dt; if (G.hudT > 0.25) { G.hudT = 0; try { hud(); } catch (err) { if (!G.hudErr || now - G.hudErr > 5000) { G.hudErr = now; console.error('Панель не обновилась:', err); } if (window.errReport) errReport(err, 'ground.hud'); } }
    // раз в 5 с: листы картинок на месте? (браузер телефона может их сбросить — тогда перепечь)
    G.chkT = (G.chkT || 0) + dt; if (G.chkT > 5) { G.chkT = 0; if ((ATLAS && ATLAS.ok && F.check && !F.check(ATLAS)) || (VAT && V.check && !V.check(VAT))) { ATLAS = null; VAT = null; } }
  }
  function draw() {
    var c = ctx, s = CAM.s, dpr = G.dpr, B = G.B, T = G.ter, t = B.t;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.fillStyle = '#05060a'; c.fillRect(0, 0, G.vw, G.vh);
    c.imageSmoothingEnabled = true;
    var a0 = toW(0, 0), b0 = toW(G.vw, G.vh), vis = [Math.max(0, Math.floor(a0[0])), Math.max(0, Math.floor(a0[1])), Math.min(N, Math.ceil(b0[0])), Math.min(N, Math.ceil(b0[1]))];
    drawGround(c, s, dpr, vis);
    if (G.layers.zones) drawZones(c, s);
    if (G.live) drawBuildings(c, s, vis);
    drawStructs(c, s, vis);
    // слой сценария под бойцами (места задач ивента и т. п.)
    if (window.GD_UNDER) { c.save(); GD_UNDER(c, s, dpr, t); c.restore(); c.setTransform(dpr, 0, 0, dpr, 0, 0); }
    drawDead(c, s, vis);
    drawShells(c, s, t);
    drawUnits(c, s, vis, t);
    drawOrders(c, s);
    drawShots(c, s, t);
    drawFx(c, s, t);
    drawFog(c, s);
    if (window.GD_DRAW) { c.save(); GD_DRAW(c, s, dpr); c.restore(); c.setTransform(dpr, 0, 0, dpr, 0, 0); }
    drawLabels(c, s);
    if (G.box) { c.strokeStyle = 'rgba(240,200,106,0.9)'; c.lineWidth = 1.5; c.strokeRect(Math.min(G.box[0], G.box[2]), Math.min(G.box[1], G.box[3]), Math.abs(G.box[2] - G.box[0]), Math.abs(G.box[3] - G.box[1])); }
    drawMini(c);
  }
  // Куски местности считают фоновые потоки (где есть Worker и OffscreenCanvas); иначе — в кадре
  var TW = { ws: [], pending: {}, n: 0, gen: 0, i: 0 };
  function workersStart(js) {
    TW.ws.forEach(function(w) { w.terminate(); }); TW.ws = []; TW.pending = {}; TW.n = 0; TW.gen++;
    if (!window.Worker || !window.OffscreenCanvas) return;
    try {
      var cnt = Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 2) - 1));
      for (var i = 0; i < cnt; i++) {
        var w = new Worker('../ground/terrain-worker.js?v=3');
        w.onmessage = function(e) {
          var m = e.data; if (m.k !== 'chunk') return;
          delete TW.pending[m.key]; TW.n--;
          if (m.gen !== TW.gen || !G.ter) { m.bmp.close(); return; }
          m.bmp.used = Date.now(); G.ter.cache[m.key] = m.bmp;
          chunkTrim(G.ter.cache, G.ter.cacheMax || 48);
        };
        w.onerror = function() { TW.ws.forEach(function(x) { x.terminate(); }); TW.ws = []; TW.pending = {}; TW.n = 0; };
        w.postMessage({ k: 'map', json: js, gen: TW.gen });
        TW.ws.push(w);
      }
    } catch (e) { TW.ws = []; }
  }
  // Лишние куски — из кэша, самые давние первыми. Кусок, нарисованный за последние полторы
  // секунды, не трогаем: он на экране. Картинку закрываем не сразу, а через 2 с — кадр с ней
  // мог ещё не дорисоваться видеокартой, и закрытая картинка выходила чёрным квадратом
  // (мигающие чёрные клетки на телефонах, когда кусков на экране больше, чем мест в кэше).
  function chunkTrim(cc, MAX) {
    var keys = Object.keys(cc); if (keys.length <= MAX) return;
    var now = Date.now(), old = [];
    keys.sort(function(a, b) { return cc[a].used - cc[b].used; });
    for (var i = 0; i < keys.length - MAX; i++) {
      var b = cc[keys[i]]; if (now - b.used < 1500) break;
      delete cc[keys[i]]; if (b.close) old.push(b);
    }
    if (old.length) setTimeout(function() { old.forEach(function(b) { try { b.close(); } catch (e) {} }); }, 2000);
  }
  // Земля: грубая подложка (4 точки на клетку) всегда, поверх — куски местности нужной
  // плотности из кэша; недостающие заказываются потокам (или рисуются по одному в кадре), от середины экрана.
  function drawGround(c, s, dpr, vis) {
    if (vis[2] <= vis[0] || vis[3] <= vis[1]) return;
    var vp = toS(vis[0], vis[1]);
    c.drawImage(G.base, vis[0] * 4, vis[1] * 4, (vis[2] - vis[0]) * 4, (vis[3] - vis[1]) * 4, vp[0], vp[1], (vis[2] - vis[0]) * s, (vis[3] - vis[1]) * s);
    var need = s * dpr; if (need <= 5) return;
    var tier = TIERS[TIERS.length - 1];
    for (var i = 0; i < TIERS.length; i++) if (TIERS[i][0] >= need * 0.9) { tier = TIERS[i]; break; }
    var ppc = tier[0], CH = tier[1], T = G.ter, list = [];
    var mx = (vis[0] + vis[2]) / 2, my = (vis[1] + vis[3]) / 2;
    for (var cy = Math.floor(vis[1] / CH); cy * CH < vis[3]; cy++) for (var cx = Math.floor(vis[0] / CH); cx * CH < vis[2]; cx++) {
      var dx = cx * CH + CH / 2 - mx, dy = cy * CH + CH / 2 - my; list.push([dx * dx + dy * dy, cx, cy]);
    }
    list.sort(function(a, b) { return a[0] - b[0]; });
    // кэш всегда с запасом больше, чем кусков на экране, иначе куски вытесняют друг друга каждый кадр
    T.cacheMax = Math.min(700, Math.max(220, Math.ceil(list.length * 1.4) + 24));
    var t0 = performance.now(), budget = G.fps && G.fps < 40 ? 6 : 12, px = CH * ppc, w = CH * s + 0.6;
    for (i = 0; i < list.length; i++) {
      var k = list[i], key = ppc + ':' + k[1] + ':' + k[2], ch = T.cache[key];
      if (!ch) {
        if (TW.ws.length) {
          if (!TW.pending[key] && TW.n < TW.ws.length * 3) { TW.pending[key] = 1; TW.n++; TW.ws[TW.i++ % TW.ws.length].postMessage({ k: 'chunk', key: key, cx: k[1], cy: k[2], ppc: ppc, CH: CH, gen: TW.gen }); }
          continue;
        }
        if (performance.now() - t0 > budget) continue; ch = T.chunk(k[1], k[2], ppc, CH);
      } else ch.used = Date.now();
      var p = toS(k[1] * CH, k[2] * CH);
      c.drawImage(ch, 0, 0, px, px, p[0], p[1], w, w);
    }
  }
  function label(c, text, x, y, col, size) {
    c.font = 'bold ' + size + 'px "Courier New", monospace'; c.textAlign = 'center'; c.textBaseline = 'middle';
    var w = text.length * size * 0.62 + 6; c.fillStyle = 'rgba(5,6,10,0.6)'; c.fillRect(x - w / 2, y - size * 0.6, w, size * 1.2);
    c.fillStyle = col; c.fillText(text, x, y);
  }
  function drawZones(c, s) {
    var B = G.B, z = B.zones, tw = B.town, fs = Math.max(9, Math.min(12, s * 1.1));
    if (B.noTown) return;                            // ивент: разметку рисует его худ (GD_DRAW)
    // полоса вторжения — только нападающему: туда он высаживает десант (хозяину планеты она ни к чему)
    if (G.side === B.att) {
      var a = toS(0, N - P.GEO.strip);
      c.fillStyle = 'rgba(217,74,74,0.1)'; c.fillRect(a[0], a[1], N * s, P.GEO.strip * s);
      c.strokeStyle = 'rgba(217,74,74,0.6)'; c.lineWidth = 1; c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(a[0] + N * s, a[1]); c.stroke();
    }
    z.deploy.forEach(function(d, i) { var p = toS(d[0], d[1]), w = d[2] * s; c.strokeStyle = 'rgba(217,169,64,0.7)'; c.strokeRect(p[0], p[1], w, w); if (w > 22) label(c, 'ЗОНА ' + (i + 1), p[0] + w / 2, p[1] + w / 2, 'rgba(232,217,168,0.8)', fs); });
    z.slots.forEach(function(sl) { var p = toS(sl[0], sl[1]), w = 6 * s; c.strokeStyle = 'rgba(143,168,196,0.35)'; c.lineWidth = 1; c.strokeRect(p[0], p[1], w, w); });
    var tp = toS(tw[0], tw[1]); c.strokeStyle = 'rgba(217,169,64,0.5)'; c.strokeRect(tp[0], tp[1], tw[2] * s, tw[3] * s);
    // площадь — точка захвата
    var sp = toS(B.sx, B.sy), cp = B.cap, col = cp.status === 'capturing' ? 'rgba(255,110,90,' : cp.status === 'contested' ? 'rgba(240,200,106,' : 'rgba(111,184,255,';
    c.fillStyle = col + '0.12)'; c.fillRect(sp[0], sp[1], SQ * s, SQ * s);
    c.strokeStyle = col + '0.9)'; c.lineWidth = 2; c.strokeRect(sp[0], sp[1], SQ * s, SQ * s);
    if (SQ * s > 40) label(c, 'ПЛОЩАДЬ ГОРОДА', sp[0] + SQ * s / 2, sp[1] - 8, 'rgba(232,217,168,0.9)', fs);
  }
  var SIMG = {};
  function simg(kind, team) { var k = (team === 0 ? 'rep_' : 'cis_') + (kind === 'extractor' ? 'mine_ore' : kind); if (!SIMG[k]) { var im = new Image(); im.src = '../assets/structures/' + k + '.png'; SIMG[k] = im; } return SIMG[k]; }
  // Постройки игры на участках 6×6 (картинки игры)
  var BIMG = {};
  function bimg(path) { if (!BIMG[path]) { var im = new Image(); im.src = '../' + path; BIMG[path] = im; } return BIMG[path]; }
  function drawBuildings(c, s, vis) {
    var B = G.B, list = B.buildings || [];
    for (var i = 0; i < list.length; i++) {
      var b = list[i]; if (b.x + 6 < vis[0] || b.x > vis[2] || b.y + 6 < vis[1] || b.y > vis[3]) continue;
      var p = toS(b.x, b.y), im = b.image ? bimg(b.image) : null;
      if (im && im.complete && im.naturalWidth) { c.save(); if (!b.ready) c.globalAlpha = 0.55; c.drawImage(im, p[0], p[1], 6 * s, 6 * s); c.restore(); }
      else { c.fillStyle = 'rgba(40,46,56,0.75)'; c.fillRect(p[0], p[1], 6 * s, 6 * s); c.strokeStyle = 'rgba(217,169,64,0.6)'; c.strokeRect(p[0], p[1], 6 * s, 6 * s); }
      if (s >= 6 && b.name) label(c, b.name, p[0] + 3 * s, p[1] + 6 * s + 7, 'rgba(232,217,168,0.85)', Math.max(8, Math.min(11, s * 0.8)));
    }
  }
  function drawStructs(c, s, vis) {
    var B = G.B;
    for (var i = 0; i < B.structs.length; i++) {
      var st = B.structs[i]; if (st.x + st.w < vis[0] || st.x > vis[2] || st.y + st.h < vis[1] || st.y > vis[3]) continue;
      var seen = B.seen[G.side][st.y * N + st.x]; if (!seen && st.team !== G.side) continue;
      var p = toS(st.x, st.y);
      if (st.kind === 'gate') { drawGate(c, st, s, p); }
      else if (st.kind === 'tower') { drawTower(c, st, s, p); }
      else {
        var im = simg(st.kind, st.team);
        c.save(); if (st.dead) c.globalAlpha = 0.45;
        if (im.complete && im.naturalWidth) c.drawImage(im, p[0], p[1], st.w * s, st.h * s);
        else { c.fillStyle = 'rgba(' + TEAMC[st.team] + ',0.5)'; c.fillRect(p[0], p[1], st.w * s, st.h * s); }
        c.restore();
      }
      if (!st.dead && st.hp < st.hpMax) { c.fillStyle = '#141a22'; c.fillRect(p[0], p[1] - 4, st.w * s, 3); c.fillStyle = '#5fd968'; c.fillRect(p[0], p[1] - 4, st.w * s * st.hp / st.hpMax, 3); }
    }
  }
  // Ворота: две створки в цвете стены, у своих — приоткрыты; выбитые — обломки
  function drawGate(c, st, s, p) {
    var lk = G.B.settle.look, col = lk.wall === 'wood' ? '#6a4c2e' : lk.wall === 'metal' ? '#5c6268' : lk.wall === 'hive' ? '#8a5c3e' : lk.wall === 'crystal' || lk.wall === 'ice' ? '#7aa6cc' : '#8a8070';
    var hor = st.w > st.h, L = (hor ? st.w : st.h) * s, th = Math.max(3, s * 0.5), open = st.team === G.side ? 0.35 : 0;
    c.save(); c.translate(p[0] + st.w * s / 2, p[1] + st.h * s / 2); if (!hor) c.rotate(Math.PI / 2);
    if (st.dead) {
      c.fillStyle = 'rgba(30,24,20,0.7)'; for (var i = 0; i < 5; i++) { var rx = (i / 5 - 0.4) * L, ry = (((i * 7) % 3) - 1) * s * 0.4; c.fillRect(rx, ry - th * 0.3, s * 0.5, th * 0.6); }
      c.restore(); return;
    }
    c.fillStyle = 'rgba(0,0,0,0.35)'; c.fillRect(-L / 2 + 2, -th / 2 + 3, L, th);
    c.fillStyle = col;
    var half = L / 2 * (1 - open);
    c.fillRect(-L / 2, -th / 2, half, th); c.fillRect(L / 2 - half, -th / 2, half, th);
    c.strokeStyle = 'rgba(255,255,255,0.35)'; c.lineWidth = 1; c.strokeRect(-L / 2, -th / 2, half, th); c.strokeRect(L / 2 - half, -th / 2, half, th);
    c.fillStyle = 'rgba(255,214,130,0.9)'; c.fillRect(-L / 2 + half - 2, -1, 2, 2); c.fillRect(L / 2 - half, -1, 2, 2);
    c.restore();
    if (st.hp < st.hpMax) { c.fillStyle = '#141a22'; c.fillRect(p[0], p[1] - 5, st.w * s, 3); c.fillStyle = st.team === G.side ? '#5fd968' : '#ff6a5a'; c.fillRect(p[0], p[1] - 5, st.w * s * st.hp / st.hpMax, 3); }
  }
  // Башня: орудие на бастионе (сам бастион — в местности)
  function drawTower(c, st, s, p) {
    var cx = p[0] + st.w * s / 2, cy = p[1] + st.h * s / 2, r = s * 0.55;
    c.save(); c.translate(cx, cy);
    if (st.dead) { c.fillStyle = 'rgba(20,16,14,0.75)'; c.beginPath(); c.arc(0, 0, r, 0, TAU); c.fill(); c.restore(); return; }
    c.rotate(st.aim || Math.PI / 2);
    c.fillStyle = 'rgba(0,0,0,0.4)'; c.beginPath(); c.arc(3, 4, r, 0, TAU); c.fill();
    c.fillStyle = '#3a4248'; c.beginPath(); c.arc(0, 0, r, 0, TAU); c.fill();
    c.fillStyle = '#5a646c'; c.beginPath(); c.arc(0, 0, r * 0.65, 0, TAU); c.fill();
    c.fillStyle = '#2a3238'; c.fillRect(0, -r * 0.16, r * 1.9, r * 0.32); c.fillRect(0, -r * 0.42, r * 0.9, r * 0.2); c.fillRect(0, r * 0.22, r * 0.9, r * 0.2);
    c.fillStyle = 'rgba(' + TEAMC[st.team] + ',0.9)'; c.beginPath(); c.arc(0, 0, r * 0.2, 0, TAU); c.fill();
    c.restore();
    if (st.hp < st.hpMax) { c.fillStyle = '#141a22'; c.fillRect(p[0], p[1] - 5, st.w * s, 3); c.fillStyle = st.team === G.side ? '#5fd968' : '#ff6a5a'; c.fillRect(p[0], p[1] - 5, st.w * s * st.hp / st.hpMax, 3); }
  }
  function drawDead(c, s, vis) {
    var B = G.B, ag = B.agents, A = atlas();
    for (var i = 0; i < ag.length; i++) {
      var a = ag[i]; if (a.alive || a.gone) continue;
      if (a.x < vis[0] - 4 || a.x > vis[2] + 4 || a.y < vis[1] - 4 || a.y > vis[3] + 4) continue;
      var p = toS(a.x, a.y), age = B.t - a.diedAt, al = Math.max(0, Math.min(1, 1 - (age - 25) / 15));
      c.save(); c.globalAlpha = al;
      if (a.T.vehicle || a.hero) {
        // техника: тёмный остов на месте
        if (a.T.vehicle) drawVehicle(c, a, s, p, 0.4, true); else { c.save(); c.translate(p[0], p[1]); c.scale(s * HK, s * HK); c.globalAlpha = al * 0.7; H.draw(c, { aim: a.aim, mv: 0, phase: 0, act: 'idle', look: H.look(a.team === 0 ? 'republic' : 'cis', a.hero.portrait), blade: 'rgba(0,0,0,0)' }); c.restore(); }
      } else {
        var fi = figOf(a), T = ALL[fi];
        if (DEAD && age > 0.5) { var size = s * DEAD.scale * FIGK, dd = Math.round(((a.aim % TAU) + TAU) % TAU / TAU * DEAD.dirs) % DEAD.dirs, kk = fi * DEAD.dirs + dd; c.drawImage(DEAD.canvas, (kk % DEAD.cols) * DEAD.cell, Math.floor(kk / DEAD.cols) * DEAD.cell, DEAD.cell, DEAD.cell, p[0] - size / 2, p[1] - size / 2, size, size); }
        else { c.translate(p[0], p[1]); c.scale(s * FIGK, s * FIGK); F.dead(c, T, a.aim, Math.min(1, age / 0.5), a.id); }
      }
      c.restore();
    }
  }
  function figOf(a) { if (a._fi != null) return a._fi; var k = Army.kit(a.tid); var id = k ? k.fig : (a.team === 0 ? 'rep_dc15a' : 'cis_b1'); a._fi = FIG_IDX[id] != null ? FIG_IDX[id] : 0; return a._fi; }
  function drawVehicle(c, a, s, p, alpha, wreck) {
    var id = a.tid, vt = V.TYPES[id]; if (!vt) return;
    c.save(); if (alpha != null) c.globalAlpha = alpha;
    var E = VAT && VAT.by[id];
    if (E && s * G.dpr <= E.ppc * 1.7) {
      var dir = Math.round(((a.aim % TAU) + TAU) % TAU / TAU * VAT.dirs) % VAT.dirs, fr = E.frames > 1 && !wreck && a.mv > 0.3 ? 1 + Math.floor(a.phase / (TAU / (VAT.frames - 1))) % (VAT.frames - 1) : 0;
      var kk = dir * E.frames + fr, size = E.span * s, half = size / 2;
      c.drawImage(E.canvas, (kk % E.cols) * E.px, Math.floor(kk / E.cols) * E.px, E.px, E.px, p[0] - half, p[1] - half, size, size);
      if (vt.turret && !wreck) {
        var td = Math.round(((a.turretA % TAU) + TAU) % TAU / TAU * V.TDIRS) % V.TDIRS;
        c.drawImage(E.tur, (td % E.cols) * E.px, Math.floor(td / E.cols) * E.px, E.px, E.px, p[0] - half, p[1] - half, size, size);
      }
    } else { c.translate(p[0], p[1]); c.scale(s, s); V.draw(c, id, { ang: a.aim, mv: wreck ? 0 : a.mv, phase: a.phase, turret: a.turretA, hp: wreck ? 0 : a.hp / a.hpMax }); }   // вблизи — живьём, чтобы не мылить
    c.restore();
    if (wreck) {
      // остов: копоть поверх
      c.save(); c.globalAlpha = (alpha == null ? 1 : alpha) * 0.6; c.fillStyle = '#0a0806';
      c.beginPath(); c.ellipse(p[0], p[1], s * vt.span * 0.42, s * vt.span * 0.3, a.aim, 0, TAU); c.fill(); c.restore();
    }
  }
  // Кружок стороны под бойцом — картинкой: заливка дуги на каждом бойце дорога на больших размерах
  var DISC = {};
  function disc(team) {
    if (!TEAMC[team]) team = 2;                          // сторона неизвестна — цвет мародёров, а не 'rgba(undefined)'
    if (DISC[team]) return DISC[team];
    var cv = document.createElement('canvas'); cv.width = cv.height = 64; var c = cv.getContext('2d');
    var g = c.createRadialGradient(32, 32, 10, 32, 32, 32); g.addColorStop(0, 'rgba(' + TEAMC[team] + ',1)'); g.addColorStop(0.75, 'rgba(' + TEAMC[team] + ',0.9)'); g.addColorStop(1, 'rgba(' + TEAMC[team] + ',0)');
    c.fillStyle = g; c.fillRect(0, 0, 64, 64);
    return (DISC[team] = cv);
  }
  // Радиус бойца на экране в клетках: техника — по виду сверху, пехота и герои — по фигурке
  function vrad(m) { if (m.T.vehicle) { var vt = V.TYPES[m.tid]; return vt ? vt.span * 0.4 : 1; } return 0.42 * HK; }
  // Куда идут свои: линия от бойца к его клетке и квадрат места — у выбранных всегда,
  // у остальных 4 с после приказа (как на палубе при абордаже)
  function drawOrders(c, s) {
    var B = G.B, ag = B.agents, now = Date.now(), sel = {};
    G.usel.forEach(function(id) { sel[id] = 1; });
    c.save(); c.lineWidth = 1;
    for (var i = 0; i < ag.length; i++) {
      var a = ag[i]; if (!a.alive || B.ctl(a) !== G.side || !a.goal || a.at) continue;
      var fresh = now - (a.ordT || 0) < 4000;
      if (!sel[a.id] && !fresh) continue;
      var off = a.size === 2 ? 1 : 0.5, p = toS(a.x, a.y), q = toS(a.goal[0] + off, a.goal[1] + off);
      var al = sel[a.id] ? 0.85 : Math.max(0.15, 0.85 * (1 - (now - (a.ordT || 0)) / 4000));
      c.strokeStyle = 'rgba(240,200,106,' + al.toFixed(2) + ')';
      c.setLineDash([4, 4]); c.beginPath(); c.moveTo(p[0], p[1]); c.lineTo(q[0], q[1]); c.stroke(); c.setLineDash([]);
      var w = a.size * s;
      c.strokeRect(q[0] - w / 2, q[1] - w / 2, w, w);
    }
    // точка касания — общая цель приказа
    if (G.ordMark && now - G.ordMark.t < 1200) { var mk = toS(G.ordMark.x + 0.5, G.ordMark.y + 0.5), k = (now - G.ordMark.t) / 1200; c.strokeStyle = 'rgba(240,200,106,' + (1 - k).toFixed(2) + ')'; c.lineWidth = 1.5; c.beginPath(); c.arc(mk[0], mk[1], 4 + k * 14, 0, TAU); c.stroke(); }
    c.restore();
  }
  function drawUnits(c, s, vis, t) {
    var B = G.B, ag = B.agents, A = atlas(), side = G.side, sel = {};
    G.usel.forEach(function(id) { sel[id] = 1; });
    var order = [];
    for (var i = 0; i < ag.length; i++) { var a = ag[i]; if (!a.alive) continue; if (a.x < vis[0] - 4 || a.x > vis[2] + 4 || a.y < vis[1] - 4 || a.y > vis[3] + 4) continue; if (a.team !== side && !B.canSee(side, a)) continue; order.push(a); }
    order.sort(function(a, b) { return (a.air || a.fly ? 1 : 0) - (b.air || b.fly ? 1 : 0) || a.y - b.y; });
    for (i = 0; i < order.length; i++) {
      var m = order[i], p = toS(m.x, m.y), mine = B.ctl(m) === side;
      // кольцо стороны и выделение
      var rr = vrad(m) * s;
      if (sel[m.id]) { c.strokeStyle = 'rgba(240,200,106,0.95)'; c.lineWidth = 2; c.beginPath(); c.arc(p[0], p[1], rr + 3, 0, TAU); c.stroke(); }
      else { var dr = rr * 0.8; c.globalAlpha = m.T.vehicle ? 0.18 : 0.3; c.drawImage(disc(B.ctl(m)), p[0] - dr, p[1] + rr * 0.55 - dr, dr * 2, dr * 2); c.globalAlpha = 1; }
      if (m.air || m.fly) { var sp = vrad(m) * 2.5, sh = toS(m.x + sp * 0.35, m.y + sp * 0.45); c.fillStyle = 'rgba(0,0,0,0.25)'; c.beginPath(); c.ellipse(sh[0], sh[1], s * sp * 0.45, s * sp * 0.3, m.aim, 0, TAU); c.fill(); }
      if (m.T.vehicle) drawVehicle(c, m, s, p, null, false);
      else if (m.hero) {
        c.save(); c.translate(p[0], p[1]); c.scale(s * HK, s * HK);
        var hr = m.hero;
        H.draw(c, { aim: m.aim, legs: m.legs, mv: m.mv, phase: m.phase, act: hr.actT > 0 ? hr.act : (m.mv > 0.3 ? 'run' : 'idle'), k: hr.k, look: heroLook(m) });
        c.restore();
      } else if (A.ok && s * G.dpr * A.scale * FIGK <= A.cell * 1.7) {
        var size = s * A.scale * FIGK, half = size / 2, per = A.dirs * A.frames;
        var dir = Math.round(((m.aim % TAU) + TAU) % TAU / TAU * A.dirs) % A.dirs, fr = m.mv > 0.3 ? 1 + Math.floor(m.phase / (TAU / 4)) % 4 : 0;
        var kk = figOf(m) * per + dir * A.frames + fr;
        c.drawImage(A.canvas, (kk % A.cols) * A.cell, Math.floor(kk / A.cols) * A.cell, A.cell, A.cell, p[0] - half, p[1] - half, size, size);
      } else { c.save(); c.translate(p[0], p[1]); c.scale(s * FIGK, s * FIGK); F.draw(c, ALL[figOf(m)], { aim: m.aim, legs: m.legs, mv: m.mv, phase: m.phase }); c.restore(); }
      // состояния
      if (m.stun > 0) { c.fillStyle = 'rgba(200,170,255,0.9)'; for (var q = 0; q < 3; q++) { var qa = t * 5 + q * 2.1; c.beginPath(); c.arc(p[0] + Math.cos(qa) * s * 0.5, p[1] - s * 0.6 + Math.sin(qa) * s * 0.15, 2, 0, TAU); c.fill(); } }
      if (m.barrier > t) { c.strokeStyle = 'rgba(120,200,255,0.5)'; c.lineWidth = 1.5; c.beginPath(); c.arc(p[0], p[1], rr + 1, 0, TAU); c.stroke(); }
      if (m.mind && m.mind.until > t) { c.fillStyle = 'rgba(255,230,160,0.9)'; label(c, '◈', p[0], p[1] - rr - 8, 'rgba(255,230,160,0.9)', 11); }
      // полоска здоровья: раненым, выбранным, технике
      if (m.hp < m.hpMax * 0.999 || sel[m.id] || m.size === 2) {
        var w = Math.max(14, rr * 1.6), hpk = m.hp / m.hpMax;
        c.fillStyle = 'rgba(5,6,10,0.7)'; c.fillRect(p[0] - w / 2, p[1] - rr - 5, w, 3);
        c.fillStyle = hpk < 0.35 ? '#ff8a3a' : mine ? '#5fd968' : '#ff6a5a'; c.fillRect(p[0] - w / 2, p[1] - rr - 5, w * hpk, 3);
      }
      if (m.hero && s > 7) label(c, m.name || (m.team === 0 ? 'Джедай' : 'Ситх'), p[0], p[1] + rr + 9, mine ? '#9fd8ff' : '#ff9a88', 10);
    }
  }
  // у бойца из сети сведения о герое могут ещё не прийти — тогда обычный вид, без запоминания
  function heroLook(m) {
    if (m._look) return m._look;
    var lk = H.look(m.team === 0 ? 'republic' : 'cis', m.hero ? m.hero.portrait : null);
    if (m.hero) m._look = lk;
    return lk;
  }
  function drawShots(c, s, t) {
    var sh = G.B.ev.shots;
    for (var i = 0; i < sh.length; i++) {
      var q = sh[i], age = t - q.t; if (age < 0 || age > 0.35) continue;
      if (q.melee) { continue; }
      var dx = q.x1 - q.x0, dy = q.y1 - q.y0, L = Math.sqrt(dx * dx + dy * dy) || 1;
      var spd = q.w === 'lightning' ? 1 : 0.12, k = Math.min(1, age / spd), tail = Math.min(1, 2.2 / L), k0 = Math.max(0, k - tail);
      var a = toS(q.x0 + dx * k, q.y0 + dy * k), b = toS(q.x0 + dx * k0, q.y0 + dy * k0);
      var col = q.w === 'turret' ? '255,190,90' : q.w === 'lightning' ? '190,160,255' : TEAMC[q.team];
      if (q.w === 'lightning') { if (age < 1) H.fx.lightning(c, 0, 0, 0, 0, 0, 0); }
      var heavy = q.w === 'vehicle' || q.w === 'aa' || q.w === 'air';
      if (age < spd + 0.02) {
        c.strokeStyle = 'rgba(' + col + ',0.9)'; c.lineWidth = Math.max(1.5, s * (heavy ? 0.26 : 0.15)); c.beginPath(); c.moveTo(b[0], b[1]); c.lineTo(a[0], a[1]); c.stroke();
        c.strokeStyle = 'rgba(255,255,255,0.8)'; c.lineWidth = Math.max(0.8, s * 0.05); c.beginPath(); c.moveTo(b[0], b[1]); c.lineTo(a[0], a[1]); c.stroke();
      } else if (q.hit) {
        var e = toS(q.x1, q.y1), ek = (age - 0.12) / 0.23;
        c.fillStyle = 'rgba(' + col + ',' + (0.8 * (1 - ek)) + ')'; c.beginPath(); c.arc(e[0], e[1], Math.max(2, s * (0.25 + ek * 0.4)), 0, TAU); c.fill();
        if (GFX.get('nums') && q.d > 0 && age < 0.3) label(c, '−' + q.d, e[0], e[1] - s * 0.6 - ek * 12, q.team === G.side ? '#ffd27a' : '#ff9a88', 11);
      }
      if (age < 0.06) { var m0 = toS(q.x0, q.y0); c.fillStyle = 'rgba(' + col + ',0.8)'; c.beginPath(); c.arc(m0[0], m0[1], Math.max(1.5, s * 0.2), 0, TAU); c.fill(); }
    }
    // удары мечом: цифры
    for (i = 0; i < sh.length; i++) { var m = sh[i]; if (!m.melee || t - m.t > 0.5) continue; if (GFX.get('nums') && m.d > 0) { var mp = toS(m.x1, m.y1); label(c, '−' + m.d, mp[0], mp[1] - s * 0.6 - (t - m.t) * 20, m.team === G.side ? '#ffd27a' : '#ff9a88', 11); } }
    var bo = G.B.ev.booms;
    for (i = 0; i < bo.length; i++) {
      var bm = bo[i], ba = t - bm.t; if (ba > 1) continue;
      var bp = toS(bm.x, bm.y), br = Math.max(8, bm.r * s * (0.5 + ba));
      var g = c.createRadialGradient(bp[0], bp[1], 0, bp[0], bp[1], br);
      g.addColorStop(0, 'rgba(255,240,200,' + (1 - ba) + ')'); g.addColorStop(0.4, 'rgba(255,140,50,' + (0.7 * (1 - ba)) + ')'); g.addColorStop(1, 'rgba(255,80,20,0)');
      c.fillStyle = g; c.beginPath(); c.arc(bp[0], bp[1], br, 0, TAU); c.fill();
    }
  }
  function drawShells(c, s, t) {
    var sh = G.B.ev.shells;
    for (var i = 0; i < sh.length; i++) {
      var q = sh[i], k = (t - q.t0) / (q.t1 - q.t0); if (k < 0 || k > 1) continue;
      var x = q.x0 + (q.x1 - q.x0) * k, y = q.y0 + (q.y1 - q.y0) * k, h = Math.sin(k * Math.PI) * 6;
      var p = toS(x, y - h), g = toS(x, y);
      c.fillStyle = 'rgba(0,0,0,0.25)'; c.beginPath(); c.arc(g[0], g[1], Math.max(2, s * 0.2), 0, TAU); c.fill();
      c.fillStyle = '#ffd27a'; c.beginPath(); c.arc(p[0], p[1], Math.max(2, s * 0.22), 0, TAU); c.fill();
      // метка падения
      var tp = toS(q.x1, q.y1); c.strokeStyle = 'rgba(255,110,90,' + (0.3 + k * 0.5) + ')'; c.lineWidth = 1.5; c.beginPath(); c.arc(tp[0], tp[1], q.r * s, 0, TAU); c.stroke();
    }
  }
  function drawFx(c, s, t) {
    var fx = G.B.ev.fx, B = G.B;
    c.save(); c.translate(G.cxs - CAM.x * s, G.vh / 2 - CAM.y * s); c.scale(s, s); c.lineCap = 'round';
    for (var i = 0; i < fx.length; i++) {
      var f = fx[i], age = t - f.t, a = B.agents[f.id];
      if (age < 0) continue;                                // своё время отстаёт от сервера: эффект ещё не наступил
      if (f.k === 'push' && age < 0.7) H.fx.wave(c, f.x, f.y, a ? a.aim : 0, age / 0.7);
      else if (f.k === 'throw' && age < 1.1 && a) { var k = age / 1.1, kk = k < 0.5 ? k * 2 : (1 - k) * 2, tx = a.x + (f.tx - a.x) * kk, ty = a.y + (f.ty - a.y) * kk; H.fx.blade(c, tx, ty, t, heroLook(a).blade); }
      else if (f.k === 'lightning' && age < 1.6 && a) { var tg = f.tid != null ? B.agents[f.tid] : null; var ex = tg ? tg.x : a.x + Math.cos(a.aim) * 8, ey = tg ? tg.y : a.y + Math.sin(a.aim) * 8; H.fx.lightning(c, a.x + Math.cos(a.aim) * 0.4, a.y + Math.sin(a.aim) * 0.4, ex, ey, (t * 25) | 0, 1 - age / 1.6); H.fx.lightning(c, a.x + Math.cos(a.aim + 0.3) * 0.4, a.y + Math.sin(a.aim + 0.3) * 0.4, ex + 0.6, ey - 0.4, (t * 25 + 9) | 0, 0.7 * (1 - age / 1.6)); }
      else if (f.k === 'choke' && age < 2.5 && a) { var tc = f.tid != null ? B.agents[f.tid] : null; if (tc) H.fx.choke(c, a.x, a.y, tc.x, tc.y, t); }
      else if (f.k === 'mind' && age < 1.5) H.fx.ring(c, f.x, f.y, age / 1.5);
      else if (f.k === 'dome' && t < f.until && a) H.fx.dome(c, a.x, a.y, f.r, t);
      else if (f.k === 'healed' && age < 1) { c.save(); c.globalAlpha = 1 - age; c.strokeStyle = 'rgba(180,255,210,0.9)'; c.lineWidth = 0.06; c.beginPath(); c.arc(f.x, f.y, 0.5 + age * 0.8, 0, TAU); c.stroke(); c.restore(); }
      else if (f.k === 'deflect' && age < 0.3 && a) { c.save(); c.globalAlpha = 1 - age / 0.3; c.strokeStyle = heroLook(a).blade; c.lineWidth = 0.08; c.beginPath(); c.arc(a.x, a.y, 0.6, 0, TAU); c.stroke(); c.restore(); }
      else if (f.k === 'artfire' && age < 0.3) { c.save(); c.globalAlpha = 1 - age / 0.3; c.fillStyle = '#ffd27a'; c.beginPath(); c.arc(f.x, f.y, 0.6 + age * 2, 0, TAU); c.fill(); c.restore(); }
      // способность бойца из исследований: название над ним (свои — золотом, враг — красным)
      else if (f.k === 'skill' && age < 1.6) {
        var sa = a && a.alive ? a : f;
        c.save(); c.translate(sa.x, sa.y - 1.1 - age * 0.5); c.scale(1 / s, 1 / s); c.globalAlpha = Math.min(1, (1.6 - age) * 2);
        c.font = 'bold 11px "Courier New", monospace'; c.textAlign = 'center'; c.textBaseline = 'bottom';
        c.lineWidth = 3; c.strokeStyle = 'rgba(5,6,10,0.85)'; c.strokeText(f.name, 0, 0);
        c.fillStyle = f.team === G.side ? '#f0c86a' : '#ff9a80'; c.fillText(f.name, 0, 0); c.restore();
      }
    }
    c.restore();
  }
  // Туман: картинка 144×144 по seen стороны игрока, пересобирается раз в полсекунды
  function drawFog(c, s) {
    var B = G.B;
    if (FOG_T !== B.fogN || !FOG) {
      FOG_T = B.fogN;
      if (!FOG) { FOG = document.createElement('canvas'); FOG.width = FOG.height = N; }
      // плотность тумана по клетке, сглаженная по 3×3, чтобы край не был ступенчатым
      var fc = FOG.getContext('2d'), img = fc.createImageData(N, N), d = img.data, sn = B.seen[G.side], al = G.fogA || (G.fogA = new Uint8Array(N * N));
      for (var i = 0; i < N * N; i++) { var v = sn[i]; al[i] = v === 2 ? 0 : v === 1 ? 110 : 215; }
      for (var y = 0; y < N; y++) for (var x = 0; x < N; x++) {
        var sum = 0, n = 0;
        for (var yy = Math.max(0, y - 1); yy <= Math.min(N - 1, y + 1); yy++) for (var xx = Math.max(0, x - 1); xx <= Math.min(N - 1, x + 1); xx++) { sum += al[yy * N + xx]; n++; }
        var p = (y * N + x) * 4; d[p] = 5; d[p + 1] = 6; d[p + 2] = 10; d[p + 3] = Math.round(sum / n);
      }
      fc.putImageData(img, 0, 0);
    }
    var a0 = toW(0, 0), b0 = toW(G.vw, G.vh), x0 = Math.max(0, Math.floor(a0[0])), y0 = Math.max(0, Math.floor(a0[1])), x1 = Math.min(N, Math.ceil(b0[0])), y1 = Math.min(N, Math.ceil(b0[1]));
    if (x1 <= x0 || y1 <= y0) return;
    var vp = toS(x0, y0);
    c.drawImage(FOG, x0, y0, x1 - x0, y1 - y0, vp[0], vp[1], (x1 - x0) * s, (y1 - y0) * s);
  }
  function drawLabels(c, s) {
    var B = G.B;
    // районы: название и кто держит (видны при среднем приближении)
    if (s >= 5) B.districts.forEach(function(d) {
      var r = d.rect, p = toS(r[0] + r[2] / 2, r[1] + r[3] / 2), mine = d.by === G.side;
      label(c, d.name.toUpperCase(), p[0], p[1], mine ? 'rgba(159,216,255,0.85)' : 'rgba(255,154,136,0.85)', Math.max(8, Math.min(11, s * 0.9)));
    });
    // номера отрядов над центром
    B.teams[G.side].squads.forEach(function(q) {
      var n = 0, x = 0, y = 0;
      q.members.forEach(function(id) { var a = B.agents[id]; if (a && a.alive) { n++; x += a.x; y += a.y; } });
      if (!n) return;
      var p = toS(x / n, y / n);
      c.fillStyle = 'rgba(5,6,10,0.8)'; c.beginPath(); c.arc(p[0], p[1] - s * 1.6 - 8, 9, 0, TAU); c.fill();
      c.strokeStyle = 'rgba(217,169,64,0.8)'; c.lineWidth = 1; c.stroke();
      label(c, String(q.id), p[0], p[1] - s * 1.6 - 8, '#e8d9a8', 10);
    });
  }
  function drawMini(c) {
    var abb = $('gd-abbar'), btop = $('sp-bottom').getBoundingClientRect().top; if (abb && !abb.hidden) btop = Math.min(btop, abb.getBoundingClientRect().top);
    if (G.dockLeft) btop = G.vh;                         // панели слева — мини-карта в правом нижнем углу
    var B = G.B, W = Math.min(120, G.vw * 0.3), x0 = G.vw - W - 10, y0 = btop - W - 10, k = W / N;
    if (!GFX.get('mini')) return;
    c.save(); c.globalAlpha = 0.9;
    c.drawImage(G.base, x0, y0, W, W);
    c.drawImage(FOG, x0, y0, W, W);
    var tw = B.town; if (!B.noTown) { c.strokeStyle = 'rgba(217,169,64,0.7)'; c.lineWidth = 1; c.strokeRect(x0 + tw[0] * k, y0 + tw[1] * k, tw[2] * k, tw[3] * k); }
    if (window.GD_MINI) GD_MINI(c, x0, y0, k);
    for (var i = 0; i < B.agents.length; i++) { var a = B.agents[i]; if (!a.alive) continue; if (a.team !== G.side && !B.canSee(G.side, a)) continue; c.fillStyle = 'rgb(' + (TEAMC[B.ctl(a)] || TEAMC[2]) + ')'; c.fillRect(x0 + a.x * k - 1, y0 + a.y * k - 1, a.size === 2 ? 3 : 2, a.size === 2 ? 3 : 2); }
    var a0 = toW(0, 0), b0 = toW(G.vw, G.vh); c.strokeStyle = 'rgba(255,255,255,0.7)'; c.strokeRect(x0 + a0[0] * k, y0 + a0[1] * k, (b0[0] - a0[0]) * k, (b0[1] - a0[1]) * k);
    c.strokeStyle = '#1c2530'; c.strokeRect(x0 - 0.5, y0 - 0.5, W + 1, W + 1);
    c.restore();
    G.mini = [x0, y0, W];
  }

  // ---------------------------------------------------------------- худ
  function selected() { var B = G.B; return G.usel.map(function(id) { return B.agents[id]; }).filter(function(a) { return a && a.alive && B.ctl(a) === G.side; }); }
  function hud() {
    var B = G.B; if (!B) return;
    var cp = B.cap, el = $('gd-cap'), mineAtt = G.side === B.att;
    var stName = { capturing: mineAtt ? 'захватываем' : 'враг захватывает', reverting: mineAtt ? 'враг отбивает' : 'отбиваем', contested: 'спор на площади', stalled: mineAtt ? 'на площади никого' : 'площадь наша' }[cp.status];
    el.className = 'sp-row gd-cap' + ((cp.status === 'capturing' && !mineAtt) || (cp.status === 'reverting' && mineAtt) ? ' bad' : '');
    el.innerHTML = '<span>Площадь: <b>' + stName + '</b> · наших ' + cp.cnt[G.side] + ', врагов ' + cp.cnt[1 - G.side] + '</span><i><b style="width:' + (cp.prog / B.capNeed * 100).toFixed(1) + '%"></b></i><span><b>' + Math.round(cp.prog / B.capNeed * 100) + '%</b></span>';
    var dl = $('gd-dist'), dh = B.settle.name + (B.districts.length ? ' · ' + B.districts.map(function(d) { return '<i class="' + (d.by === G.side ? 'my' : 'foe') + '"></i>' + d.name; }).join(' ') : '');
    if (dl.innerHTML !== dh) dl.innerHTML = dh;
    // единственный свой боец — герой (охота): выбран сразу, касание земли ведёт его
    if (!G.usel.length && !G.autoSel) { var own = B.agents.filter(function(a) { return a && a.alive && B.ctl(a) === G.side; }); if (own.length === 1 && own[0].hero) { G.usel = [own[0].id]; G.autoSel = true; } }
    var sel = selected(), alive = B.alive(G.side), foe = B.alive(1 - G.side);
    var stat = '<span>Своих <b>' + alive + '</b> · врагов видно <b>' + B.agents.filter(function(a) { return a.alive && B.ctl(a) !== G.side && B.canSee(G.side, a); }).length + '</b> из ' + foe + '</span>';
    // подсказка по шагу: что сейчас сделает касание
    var one = sel.length === 1 ? sel[0] : null, oneCv = one && B.coverInfo ? B.coverInfo(one) : null;
    var tip = G.arm ? 'Цель для «' + GR.ABIL_NAME[G.arm.ab] + '»: коснись ' + (GR.ABIL[G.arm.ab][1] === 'area' ? 'места' : GR.ABIL[G.arm.ab][1] === 'ally' ? 'союзника' : 'врага')
      : one ? '<b>' + (one.name || one.T.name) + '</b> · ' + Math.round(one.hp) + '/' + one.hpMax + (oneCv ? ' · ' + (oneCv.k === 'struct' ? '🛡 ' : '') + oneCv.text.split(' (')[0].split(' ·')[0] : '') + (one.focus >= 0 ? ' · атакует ' + unitName(B, one.focus) : one.tgt >= 0 && one.tgt < 100000 ? ' · стреляет по ' + unitName(B, one.tgt) : one.goal && !one.at ? ' · идёт' : '')
      : sel.length ? 'Выбрано <b>' + sel.length + '</b> · касание земли — идти, врага — атаковать'
      : 'Коснись своего бойца, чтобы выбрать · долгое нажатие — рамка';
    // в игре верхней панели нет — захват площади одной строкой в полосе
    var capLine = window.GD_EV_LINE ? GD_EV_LINE() : window.GD_COMPACT ? '<div class="sp-bd-strip gd-capline' + ((cp.status === 'capturing' && !mineAtt) || (cp.status === 'reverting' && mineAtt) ? ' bad' : '') + '"><span>Площадь: <b>' + stName + '</b></span><i><b style="width:' + (cp.prog / B.capNeed * 100).toFixed(1) + '%"></b></i><span><b>' + Math.round(cp.prog / B.capNeed * 100) + '%</b></span></div>' : '';
    $('sp-stat').innerHTML = capLine + '<div class="sp-bd-strip' + (cp.status === 'capturing' && !mineAtt ? ' bad' : '') + '">' + stat + '<span class="gd-tip">' + tip + '</span></div>';
    dockTabs([['units', 'Войска', B.teams[G.side].squads.length ? '<em class="dot"></em>' : ''], ['act', 'Приказы']]);
    $('gd-all').classList.toggle('on', G.usel.length > 0); $('gd-all').textContent = G.usel.length ? 'Снять' : 'Все свои';
    if (G.sheet === 'units') $('sp-ship').innerHTML = unitsPanel(B, sel);
    else if (G.sheet === 'act') $('sp-ship').innerHTML = actPanel(B, sel);
    sheetShow();
    abBar(B, sel);
  }
  // Полоса сил героя над нижней панелью: выбран герой, шторка закрыта. Сила → касание цели на поле.
  var AB_SHORT = { push_dark: 'Телекинез', drain_dark: 'Вытягивание', heal_light: 'Исцеление', barrier_light: 'Купол', lightning_dark: 'Молнии', fear_dark: 'Страх', dash_dark: 'Бросок', throw_dark: 'Клинок', push_light: 'Толчок' };
  function abBar(B, sel) {
    var el = $('gd-abbar');
    if (!el) { el = document.createElement('div'); el.id = 'gd-abbar'; el.className = 'gd-abbar'; el.hidden = true; $('sp-bottom').appendChild(el); }
    var hero = null; for (var i = 0; i < sel.length; i++) if (sel[i].hero) { hero = sel[i]; break; }
    var html = '';
    if (hero && !G.sheet && !G.ended) {
      hero.hero.abil.forEach(function(ab) {
        var A = GR.ABIL[ab]; if (!A || !A[0]) return;
        var cd = Math.max(0, (hero.hero.cds[ab] || 0) - B.t);
        html += '<button class="sp-chip' + (cd > 0 ? ' cd' : '') + (G.arm && G.arm.ab === ab ? ' arm' : '') + '" data-ab="' + ab + '" type="button" title="' + GR.ABIL_NAME[ab] + '">' + (AB_SHORT[ab] || GR.ABIL_NAME[ab]) + (cd > 0 ? '<em>' + Math.ceil(cd) + 'с</em>' : '') + '</button>';
      });
      if (html) html = '<span class="lab">Силы</span>' + html + (G.arm ? '<button class="sp-chip x" data-abx="1" type="button">✕ отмена</button>' : '');
    }
    if (el.innerHTML !== html) el.innerHTML = html;
    el.hidden = !html;
  }
  function unitsPanel(B, sel) {
    var html = '', selIds = {}; G.usel.forEach(function(i) { selIds[i] = 1; });
    var sqs = B.teams[G.side].squads, loose = [], byType = {};
    B.agents.forEach(function(a) { if (!a.alive || B.ctl(a) !== G.side) return; if (!a.sq) loose.push(a); });
    html += '<div class="sp-bd-row"><span class="lab">Отряды</span>';
    sqs.forEach(function(q) { var n = 0, hp = 0, mx = 0; q.members.forEach(function(id) { var a = B.agents[id]; if (a && a.alive) { n++; hp += a.hp; mx += a.hpMax; } }); var on = q.members.length && q.members.every(function(id) { return selIds[id]; }); html += '<button class="sp-chip' + (on ? ' on' : '') + (n ? '' : ' dead') + '" data-sq="' + q.id + '"><b>' + q.id + '</b> ' + n + '<em> · ' + Math.round(hp / Math.max(1, mx) * 100) + '%</em></button>'; });
    html += '<button class="sp-chip' + (loose.length && loose.every(function(a) { return selIds[a.id]; }) ? ' on' : '') + '" data-sq="loose">без отряда <em>' + loose.length + '</em></button></div>';
    // по видам
    B.agents.forEach(function(a) { if (!a.alive || B.ctl(a) !== G.side) return; (byType[a.tid] = byType[a.tid] || []).push(a); });
    html += '<div class="gd-units">';
    Object.keys(byType).forEach(function(tid) { var L = byType[tid], Ty = U.type(tid), on = L.every(function(a) { return selIds[a.id]; }), hp = 0, mx = 0; L.forEach(function(a) { hp += a.hp; mx += a.hpMax; }); html += '<button class="sp-chip' + (on ? ' on' : '') + '" data-type="' + tid + '">' + Ty.name + ' <em>×' + L.length + '</em><i><b class="' + (hp / mx < 0.4 ? 'low' : '') + '" style="width:' + Math.round(hp / mx * 100) + '%"></b></i></button>'; });
    html += '</div>';
    if (sel.length === 1) html += unitCard(B, sel[0]);
    if (window.GD_SHEET) html += GD_SHEET(sel);
    html += '<p class="gd-hint">Касание бойца — выбрать, двойное — весь его отряд. Долгое нажатие на поле — рамка. Касание земли — идти, врага — атаковать.</p>';
    return html;
  }
  function unitName(B, id) { var b = B.agents[id]; return b ? (b.name || b.T.name) : ''; }
  var CLS_RU = { infantry: 'пехота', vehicle: 'техника', artillery: 'артиллерия', air: 'авиация', hero: 'одарённый' };
  function unitCard(B, a) {
    var Ty = a.T, st = a.hold ? 'держит позицию' : a.post && !a.at ? 'идёт к точке' : a.focus >= 0 ? 'атакует: ' + unitName(B, a.focus) : a.tgt >= 0 && a.tgt < 100000 ? 'стреляет по: ' + unitName(B, a.tgt) : a.goal && !a.at ? 'идёт' : 'стоит';
    var cv = B.coverInfo ? B.coverInfo(a) : null;
    var html = '<div class="sp-ucard"><div class="nm"><b' + (a.hero ? ' class="hero"' : '') + '>' + (a.name || Ty.name) + '</b><em>' + Ty.name + ' · урон ' + Ty.dmg + ' · дальность ' + Ty.range + (CLS_RU[Ty.cls] ? ' · ' + CLS_RU[Ty.cls] : '') + '</em></div>' +
      '<div class="hp' + (a.hp / a.hpMax < 0.35 ? ' low' : '') + '"><span>' + Math.round(a.hp) + ' / ' + a.hpMax + '</span><i><b style="width:' + Math.round(a.hp / a.hpMax * 100) + '%"></b></i></div><div class="st' + (a.tgt >= 0 ? ' fire' : '') + '">' + st + (a.stun > 0 ? ' · оглушён' : '') + (a.fear > 0 ? ' · бежит в страхе' : '') + '</div>' +
      (cv ? '<div class="st cv ' + cv.k + '">' + (cv.k === 'struct' ? '🛡 ' : cv.k === 'cover' ? '◧ ' : '') + cv.text + '</div>' : '');
    if (a.hero) {
      html += '<div class="gd-ab">';
      a.hero.abil.forEach(function(ab) { var A = GR.ABIL[ab]; if (!A || !A[0]) return; var cd = Math.max(0, (a.hero.cds[ab] || 0) - B.t); html += '<button class="sp-chip' + (cd > 0 ? ' cd' : '') + (G.arm && G.arm.ab === ab ? ' arm' : '') + '" data-ab="' + ab + '">' + GR.ABIL_NAME[ab] + (cd > 0 ? '<em> ' + Math.ceil(cd) + 'с</em>' : '') + '</button>'; });
      html += '</div>';
    }
    return html + '</div>';
  }
  function actPanel(B, sel) {
    var n = sel.length, html = '<div class="sp-bd-row"><span class="lab">Выбрано ' + n + '</span>';
    html += '<button class="sp-chip' + (n ? '' : ' dead') + '" data-ba="hold">Держать здесь</button><button class="sp-chip' + (n ? '' : ' dead') + '" data-ba="stop">Стоп</button><button class="sp-chip' + (n ? '' : ' dead') + '" data-ba="auto">Сами (ИИ)</button></div>';
    html += '<div class="sp-bd-row"><span class="lab">В отряд</span>';
    B.teams[G.side].squads.forEach(function(q) { html += '<button class="sp-chip' + (n ? '' : ' dead') + '" data-as="' + q.id + '"><b>' + q.id + '</b></button>'; });
    html += '<button class="sp-chip' + (n ? '' : ' dead') + '" data-as="0">+ новый</button><button class="sp-chip' + (n ? '' : ' dead') + '" data-as="-1">без отряда</button></div>';
    html += '<p class="gd-hint"><b>Ход</b> — касание земли. <b>Атака</b> — касание врага. <b>Держать здесь</b> — стоят и стреляют, не сходя с места. <b>Стоп</b> — отменить приказ. <b>Сами</b> — выбранных ведёт ИИ, пока ты не отдашь им свой приказ.</p>';
    return html;
  }
  function dockTabs(list) {
    var html = list.map(function(t) { return '<button class="sp-btn sp-tab' + (G.sheet === t[0] ? ' open' : '') + '" data-tab="' + t[0] + '" type="button">' + t[1] + (t[2] || '') + '</button>'; }).join('');
    var el = $('sp-tabs'); if (el.innerHTML !== html) el.innerHTML = html;
  }
  var SHEET_T = { units: 'Войска', act: 'Приказы' };
  // Нижняя кромка всего, что висит сверху (панель боя, «Галактика», кредиты, «Строительство», кнопки справа):
  // на странице планеты верхней панели нет, и мерить только её — значит отдать шторке весь экран
  function topEdge() {
    var y = 0;
    ['sp-top', 'sp-back', 'credits-bar', 'build-toggle', 'sp-tr', 'sp-tl'].forEach(function(id) {
      var e = document.getElementById(id); if (!e) return;
      var r = e.getBoundingClientRect(); if (r.width > 0 && r.height > 0 && r.top < window.innerHeight * 0.45) y = Math.max(y, r.bottom);
    });
    return y;
  }
  function sheetShow() {
    var on = !!G.sheet, el = $('sp-sheet'); el.hidden = !on; if (!on) return;
    var room = $('sp-bottom').getBoundingClientRect().top - topEdge() - 14;
    // шторка не закрывает поле целиком: над ней остаётся не меньше трети места под карту
    el.style.maxHeight = Math.max(Math.min(110, room), Math.min(440, room * 0.66, window.innerHeight * 0.6)) + 'px';
    $('sp-sheet-t').textContent = SHEET_T[G.sheet] || '';
  }
  var toastT = 0;
  function toast(msg, kind) { var el = $('sp-toast'); el.textContent = msg; el.className = 'sp-toast show' + (kind ? ' ' + kind : ''); clearTimeout(toastT); toastT = setTimeout(function() { el.className = 'sp-toast'; }, 2600); }
  function takeMsgs() { var ms = G.B.ev.msgs; for (var i = 0; i < ms.length; i++) { var m = ms[i]; if (m.seq <= G.msgSeq) continue; G.msgSeq = m.seq; if (m.team === G.side) toast(m.text, m.kind); } }
  function endBattle() {
    G.ended = true; var B = G.B, win = B.over === G.side;
    if (window.GD_ON_END) { window.GD_ON_END(win, B.why); return; }
    $('sp-end-title').textContent = win ? 'Победа' : 'Поражение';
    $('sp-end-text').textContent = B.why + '. Своих осталось ' + B.alive(G.side) + ', врагов ' + B.alive(1 - G.side) + '. Бой длился ' + Math.round(B.t / 60) + ' мин.';
    $('sp-end').hidden = false;
  }

  // ---------------------------------------------------------------- ввод
  var PTR = {}, GES = null, pressT = 0;
  function agentAt(px, py) {
    var B = G.B, w = toW(px, py), best = -1, bd = 1e9;
    for (var i = 0; i < B.agents.length; i++) { var a = B.agents[i]; if (!a.alive) continue; if (a.team !== G.side && !B.canSee(G.side, a)) continue; var r = vrad(a) + 0.25, dx = a.x - w[0], dy = a.y - w[1], d = dx * dx + dy * dy; if (d < r * r && d < bd) { bd = d; best = i; } }
    return best;
  }
  function tap(px, py) {
    var B = G.B, w = toW(px, py), cx = Math.floor(w[0]), cy = Math.floor(w[1]);
    if (G.mini && px >= G.mini[0] && px <= G.mini[0] + G.mini[2] && py >= G.mini[1] && py <= G.mini[1] + G.mini[2]) { CAM.x = (px - G.mini[0]) / G.mini[2] * N; CAM.y = (py - G.mini[1]) / G.mini[2] * N; return; }
    var hit = agentAt(px, py), a = hit >= 0 ? B.agents[hit] : null, sel = selected();
    // страница игры: режимы высадки и размещения, участки, площадь — её касание первым
    if (!G.arm && window.GD_ON_TAP && window.GD_ON_TAP(cx, cy, a, sel.length, px, py) === true) return;
    if (G.arm) {
      var hero = B.agents[G.arm.id], A = GR.ABIL[G.arm.ab], err;
      if (A[1] === 'area') err = B.useAbility(G.side, G.arm.id, G.arm.ab, { x: w[0], y: w[1] });
      else if (a) err = B.useAbility(G.side, G.arm.id, G.arm.ab, { tid: a.id });
      else err = 'нужна цель';
      if (err) toast(err, 'bad'); G.arm = null; hud(); return;
    }
    if (a && B.ctl(a) === G.side) {
      var now = performance.now(), dbl = G.lastTap && G.lastTap[0] === hit && now - G.lastTap[1] < 400;
      G.lastTap = [hit, now];
      if (dbl) { G.usel = []; if (a.sq) { var q = B.squadOf(G.side, a.sq); if (q) G.usel = q.members.slice(); } else B.agents.forEach(function(b) { if (b.alive && B.ctl(b) === G.side && b.tid === a.tid) G.usel.push(b.id); }); }
      else { var k = G.usel.indexOf(hit); if (k >= 0) G.usel.splice(k, 1); else G.usel.push(hit); }
      hud(); return;
    }
    if (a && sel.length) { var n = B.orderAttack(G.side, G.usel, hit); if (n) toast('Атаковать: ' + (a.name || a.T.name), 'gold'); return; }
    if (sel.length && cx >= 0 && cy >= 0 && cx < N && cy < N) { var m = B.orderMove(G.side, G.usel, cx, cy); if (!m) toast('Туда не пройти', 'bad'); else { var nowO = Date.now(); sel.forEach(function(a) { a.ordT = nowO; }); G.ordMark = { x: cx, y: cy, t: nowO }; } return; }
    if (a) { toast((a.name || a.T.name) + ' · ' + Math.round(a.hp) + ' / ' + a.hpMax); return; }
    // ничего: район или пояснение клетки
    for (var di = 0; di < B.districts.length; di++) { var dd = B.districts[di], dr = dd.rect; if (cx >= dr[0] && cx < dr[0] + dr[2] && cy >= dr[1] && cy < dr[1] + dr[3]) { toast(dd.name + ' — ' + (dd.by === G.side ? 'держим мы' : 'держит враг') + '. ' + dd.effect, dd.by === G.side ? 'gold' : 'bad'); return; } }
    var code = P.code(B.map, cx, cy); toast(P.NAME[code] + (B.seen[G.side][cy * N + cx] < 2 ? ' · не видно' : ''));
  }
  function boxSelect(b) {
    var B = G.B, x0 = Math.min(b[0], b[2]), y0 = Math.min(b[1], b[3]), x1 = Math.max(b[0], b[2]), y1 = Math.max(b[1], b[3]);
    G.usel = [];
    for (var i = 0; i < B.agents.length && G.usel.length < 160; i++) { var a = B.agents[i]; if (!a.alive || B.ctl(a) !== G.side) continue; var p = toS(a.x, a.y); if (p[0] >= x0 && p[0] <= x1 && p[1] >= y0 && p[1] <= y1) G.usel.push(i); }
    hud();
  }
  function bind() {
    cv.addEventListener('pointerdown', function(e) {
      cv.setPointerCapture(e.pointerId); PTR[e.pointerId] = [e.clientX, e.clientY];
      var ids = Object.keys(PTR);
      if (ids.length === 1) { GES = { k: 'tap', x: e.clientX, y: e.clientY, cx: CAM.x, cy: CAM.y, t: performance.now(), shift: e.shiftKey }; clearTimeout(pressT); pressT = setTimeout(function() { if (GES && GES.k === 'tap') { GES.k = 'box'; G.box = [GES.x, GES.y, GES.x, GES.y]; } }, 380); if (e.shiftKey && e.pointerType === 'mouse') { GES.k = 'box'; G.box = [GES.x, GES.y, GES.x, GES.y]; } }
      else if (ids.length === 2) { clearTimeout(pressT); var a = PTR[ids[0]], b = PTR[ids[1]]; GES = { k: 'pinch', d: Math.hypot(a[0] - b[0], a[1] - b[1]), s: CAM.s, mx: (a[0] + b[0]) / 2, my: (a[1] + b[1]) / 2 }; G.box = null; }
    });
    cv.addEventListener('pointermove', function(e) {
      if (!PTR[e.pointerId]) return; PTR[e.pointerId] = [e.clientX, e.clientY];
      if (!GES) return;
      var ids = Object.keys(PTR);
      if (GES.k === 'pinch' && ids.length === 2) { var a = PTR[ids[0]], b = PTR[ids[1]], d = Math.hypot(a[0] - b[0], a[1] - b[1]); zoomAt(GES.mx, GES.my, GES.s * d / GES.d / CAM.s); return; }
      if (GES.k === 'box') { G.box[2] = e.clientX; G.box[3] = e.clientY; return; }
      var dx = e.clientX - GES.x, dy = e.clientY - GES.y;
      if (GES.k === 'tap' && Math.abs(dx) + Math.abs(dy) > 6) { GES.k = 'pan'; clearTimeout(pressT); }
      if (GES.k === 'pan') { CAM.x = GES.cx - dx / CAM.s; CAM.y = GES.cy - dy / CAM.s; clampCam(); }
    });
    function up(e) {
      clearTimeout(pressT);
      if (GES && PTR[e.pointerId] && Object.keys(PTR).length === 1) {
        if (GES.k === 'tap') tap(e.clientX, e.clientY);
        else if (GES.k === 'box') { if (Math.abs(G.box[2] - G.box[0]) > 6 && Math.abs(G.box[3] - G.box[1]) > 6) boxSelect(G.box); else tap(e.clientX, e.clientY); }
      }
      delete PTR[e.pointerId];
      if (!Object.keys(PTR).length) { GES = null; G.box = null; }
    }
    cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
    cv.addEventListener('wheel', function(e) { e.preventDefault(); zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0015)); }, { passive: false });
    $('sp-view').onclick = fitAll;
    $('gd-all').onclick = function() { var B = G.B; if (G.usel.length) G.usel = []; else B.agents.forEach(function(a) { if (a.alive && B.ctl(a) === G.side) G.usel.push(a.id); }); hud(); };
    $('sp-pause').onclick = function() { setSpeed(G.speed === 0 ? (G.lastSpd || 1) : 0); };
    $('sp-spd').onclick = function() { var c = G.speed || G.lastSpd || 1; setSpeed(c === 1 ? 2 : c === 2 ? 4 : 1); };
    $('sp-gfx-b').onclick = function() { GFX.open(G.fps); };
    GFX.on(function(k) { if (k === 'q') { ATLAS = null; VAT = null; resize(); } });
    $('sp-bottom').addEventListener('pointerdown', function(e) {
      var t = e.target.closest('[data-tab],[data-ba],[data-as],[data-sq],[data-type],[data-ab],[data-abx],#sp-sheet-x'); if (!t) return;
      e.preventDefault();
      var B = G.B;
      if (t.id === 'sp-sheet-x') { G.sheet = ''; hud(); return; }
      if (t.hasAttribute('data-abx')) { G.arm = null; hud(); return; }
      if (t.hasAttribute('data-tab')) { var k = t.getAttribute('data-tab'); G.sheet = G.sheet === k ? '' : k; hud(); return; }
      if (t.hasAttribute('data-ba')) {
        var ba = t.getAttribute('data-ba');
        if (ba === 'hold') B.orderHold(G.side, G.usel); else if (ba === 'stop') B.orderStop(G.side, G.usel); else if (ba === 'auto') { B.setAuto(G.side, G.usel, true); toast('Выбранных ведёт ИИ: любой ваш приказ вернёт их', 'gold'); }
        hud(); return;
      }
      if (t.hasAttribute('data-as')) { var r = B.assign(G.side, G.usel, +t.getAttribute('data-as')); if (r === false) toast('Отрядов уже ' + 12, 'bad'); hud(); return; }
      if (t.hasAttribute('data-sq')) { var sq = t.getAttribute('data-sq'); if (sq === 'loose') { G.usel = []; B.agents.forEach(function(a) { if (a.alive && B.ctl(a) === G.side && !a.sq) G.usel.push(a.id); }); } else { var q = B.squadOf(G.side, +sq); G.usel = q ? q.members.slice() : []; } hud(); return; }
      if (t.hasAttribute('data-type')) { var tid = t.getAttribute('data-type'); G.usel = []; B.agents.forEach(function(a) { if (a.alive && B.ctl(a) === G.side && a.tid === tid) G.usel.push(a.id); }); hud(); return; }
      if (t.hasAttribute('data-ab')) {
        var ab = t.getAttribute('data-ab'), sel = selected(), hero = sel.filter(function(a) { return a.hero; })[0]; if (!hero) return;
        var A = GR.ABIL[ab];
        if (A[1] === 'self' || !A[1]) { var err = B.useAbility(G.side, hero.id, ab, null); if (err) toast(err, 'bad'); }
        else if (A[1] === 'ally' && ab === 'heal_light') { var err2 = B.useAbility(G.side, hero.id, ab, { tid: hero.id }); if (err2) { G.arm = { id: hero.id, ab: ab }; toast('Выбери союзника рядом', 'gold'); } }
        else { G.arm = G.arm && G.arm.ab === ab ? null : { id: hero.id, ab: ab }; if (G.arm) toast('Теперь коснись цели на поле', 'gold'); }
        // цель выбирают на поле — шторка не должна его закрывать
        if (G.arm) G.sheet = '';
        hud(); return;
      }
    });
    $('gd-poly-b').onclick = polyOpen;
    $('sp-end-look').onclick = function() { $('sp-end').hidden = true; };
    $('sp-end-again').onclick = function() { $('sp-end').hidden = true; start(G.planet); };
    window.addEventListener('resize', resize);
    // живой бой: следить за связью; вернулась сеть / открыли вкладку — переподключиться сразу
    if (window.GD_LIVE) {
      setInterval(liveWatch, 1000);
      var kick = function() { if (G.live && !G.closing && liveDown()) retryLive(0); else if (LIVE.ws) LIVE.lastMsg = Date.now(); };
      window.addEventListener('online', kick);
      document.addEventListener('visibilitychange', function() { if (document.visibilityState === 'visible') kick(); });
    }
  }
  function setSpeed(v) { if (v) G.lastSpd = v; G.speed = v; $('sp-pause').innerHTML = v === 0 ? '▶' : '❚❚'; $('sp-spd').textContent = '×' + (v || G.lastSpd); }

  // ---------------------------------------------------------------- полигон
  function polyOpen() {
    var po = G.poly;
    var chips = function(id, list, cur) { $(id).innerHTML = list.map(function(o) { return '<button class="sp-chip' + (o[0] === cur ? ' on' : '') + '" data-v="' + o[0] + '" type="button">' + o[1] + '</button>'; }).join(''); };
    Array.prototype.forEach.call($('gd-poly-planet').children, function(b) { b.classList.toggle('on', b.getAttribute('data-pp') === po.planet); });
    chips('gd-poly-side', [[0, 'Республика'], [1, 'КНС']], po.side);
    chips('gd-poly-role', [['att', 'Штурм'], ['def', 'Оборона']], po.role);
    chips('gd-poly-size', [['small', 'Малые'], ['mid', 'Средние'], ['big', 'Большие']], po.size);
    chips('gd-poly-foe', [['ai', 'Воюет (ИИ)'], ['idle', 'Стоит мишенью']], po.foe);
    chips('gd-poly-cap', [[120, '2 мин'], [600, '10 мин'], [21600, '6 ч как в игре']], po.cap);
    chips('gd-poly-lvl', [[1, '1 Посёлок'], [2, '2 Городок'], [3, '3 Город'], [4, '4 Столица']], po.lvl);
    $('gd-poly-lvl-h').textContent = { 1: 'Дворы и один квартал, без стены. Ополчение: 1.', 2: 'Частокол, ворота с юга и севера, два квартала. Ополчение: 2 (+2 с казармами).', 3: 'Стена, четыре ворот, две башни к полосе вторжения, три квартала. Ополчение: 3 (+2).', 4: 'Полная стена, четыре башни, четыре квартала. Ополчение: 4 (+2).' }[po.lvl] + ' Кварталы: ' + POLY_DISTRICTS.slice(0, po.lvl).map(function(d) { return TOWN.DISTRICTS[d.id].name.toLowerCase(); }).join(', ') + '.';
    $('gd-poly-role-h').textContent = po.role === 'att' ? 'Твой десант высаживается у нижнего края. Нужно дойти до площади в центре города и удержать её.' : 'Твой гарнизон стоит у города. Враг идёт снизу; не дай ему удержать площадь.';
    $('gd-poly-size-h').textContent = { small: 'Около 15 бойцов с каждой стороны — чтобы освоить управление.', mid: 'Около 60 с каждой стороны, с техникой, героем и артиллерией.', big: 'Около 130 с каждой стороны — проверка на нагрузку.' }[po.size];
    $('gd-poly-foe-h').textContent = po.foe === 'ai' ? 'Другую сторону ведёт ИИ: штурм идёт колоннами, оборона держит рубеж перед площадью.' : 'Враг стоит на месте и только отстреливается — удобно проверять приказы и способности.';
    $('sp-poly').hidden = false;
  }
  $('sp-poly').addEventListener('click', function(e) {
    var b = e.target.closest('.sp-chip'); var po = G.poly;
    if (b && b.hasAttribute('data-pp')) { po.planet = b.getAttribute('data-pp'); polyOpen(); return; }
    if (b && b.hasAttribute('data-v')) { var box = b.parentNode.id, v = b.getAttribute('data-v'); if (box === 'gd-poly-side') po.side = +v; else if (box === 'gd-poly-role') po.role = v; else if (box === 'gd-poly-size') po.size = v; else if (box === 'gd-poly-foe') po.foe = v; else if (box === 'gd-poly-cap') po.cap = +v; else if (box === 'gd-poly-lvl') po.lvl = +v; polyOpen(); return; }
    if (e.target.id === 'gd-poly-go' || e.target === $('sp-poly')) { $('sp-poly').hidden = true; if (e.target.id === 'gd-poly-go') start(po.planet); }
  });

  resize(); bind(); requestAnimationFrame(frame);
  G.CAM = CAM; G.TW = TW; G.focusOn = function(id) { var a = G.B.agents[id]; if (a) { CAM.x = a.x; CAM.y = a.y; } };
  G.toast = toast; G.hud = hud; G.toW = toW; G.toS = toS; G.selected = selected; G.select = function(ids) { G.usel = ids.slice(); hud(); };
  window.GD = G;
})();
