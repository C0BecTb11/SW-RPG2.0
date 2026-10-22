/* Экран орбиты на космосе 2.0 — связка живого боя системы (space/space.js по сети)
 * со старыми панелями орбиты (js/space-battle.js и js/ship-control.js: станция, верфь,
 * карточка корабля и командиры, трюм, ангар, очередь верфи, журнал).
 *
 * Как устроено:
 *   - бой рисует и ведёт space/space.js в режиме орбиты системы (window.SP_LIVE): адрес
 *     сервера — из rt_space_status(), вход по токену сессии Supabase, комната so:<система>;
 *   - старые панели работают как были: строки кораблей (shipsInSystem) они берут из базы
 *     сами, а карту, приказы и бой — новый экран; сетка, разворот, ход, атака, тягач и
 *     запуск истребителей старого экрана не используются (бой делает это сам);
 *   - в листе «Корабль» нового экрана — чипы игры: «Трюм и ангар» (панель старого экрана
 *     без боевых вкладок), «Командир», «Верфь», «Станция»;
 *   - касание пустого космоса сначала идёт сюда (SP_ON_TAP): место станции — панель станции.
 * ES5.
 */
(function() {
  'use strict';
  var SP_SERVER_FALLBACK = 'https://2-31-45-237.sslip.io';
  var systemId = (/[?&]system=([a-z0-9_]+)/.exec(location.search) || [])[1] || '';
  var SL = { ready: false, user: null, hello: null };
  window.SL = SL;

  function $(id) { return document.getElementById(id); }
  function sb() { return window.supabase; }
  function sp() { return window.__sp || null; }

  // ---- запуск: сервер боёв и токен, потом space.js
  function boot() {
    if (!systemId) return;
    window.SP_TOKEN = function() {
      return sb().auth.getSession().then(function(r) { var s = r && r.data && r.data.session; return s ? s.access_token : 'dev'; });
    };
    var go = function(srv, online) {
      window.SP_LIVE = { system: systemId, srv: srv };
      if (online === false) toastSoon('Сервер боёв не на связи — орбита может не открыться', 'bad');
      var s = document.createElement('script'); s.src = '../space/space.js?v=32'; document.body.appendChild(s);
    };
    sb().rpc('rt_space_status', { p_system: systemId }).then(function(r) {
      var d = r && r.data, srv = (d && d.server && d.server.url) || SP_SERVER_FALLBACK;
      go(srv, d && d.server ? d.server.online : null);
    }, function() { go(SP_SERVER_FALLBACK, null); });
  }
  var toastQ = [];
  function toastSoon(msg, kind) { var S = sp(); if (S && S.toast) S.toast(msg, kind); else toastQ.push([msg, kind]); }

  // ---- строка корабля из базы по кораблю боя (старым панелям нужны их поля)
  SL.rowOf = function(sh) {
    var list = window.shipsInSystem || [], id = sh && (sh.gameId || sh.id);
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  };
  SL.typeOf = function(row) { return row && window.shipTypeById ? shipTypeById[row.ship_type] : null; };

  // ---- вставка в лист «Корабль»: трюм и ангар, командир, верфь, станция
  window.SP_SHEET = function(sh) {
    if (!SL.ready || !sh) return '';
    var row = SL.rowOf(sh), mine = row && row.owner_user_id === SL.user;
    var html = '';
    if (mine) {
      html += '<div class="sp-bd-row sl-row"><span class="lab">В игре</span>';
      html += '<button class="sp-chip" data-sl="hold">Трюм и ангар</button>';
      html += '<button class="sp-chip" data-sl="cmd">Командир</button>';
      if (SL.dockHere()) html += '<button class="sp-chip" data-sl="yard">Верфь</button>';
      html += '</div>';
    }
    return html;
  };
  // своя (или союзная готовая) станция в системе — есть куда зайти в верфь
  SL.dockHere = function() {
    var st = window.stationRecord, my = window.spaceMyFaction;
    return !!(st && my && st.faction === my && (!st.completes_at || new Date(st.completes_at).getTime() <= Date.now()));
  };
  function onSheetClick(e) {
    var t = e.target.closest('[data-sl]'); if (!t) return;
    e.preventDefault();
    var S = sp(), G = S && S.G, sh = G && G.B && G.B.ships[G.sel]; if (!sh) return;
    var row = SL.rowOf(sh), type = SL.typeOf(row);
    var k = t.getAttribute('data-sl');
    if (k === 'hold') { if (row && type && typeof onOwnShipTapped === 'function') { window.scTab = 'cargo'; onOwnShipTapped(row, type); } else S.toast('Корабль ещё не перечитан из базы — секунду', 'bad'); }
    else if (k === 'cmd') { if (row && type && typeof openShipInfo === 'function') openShipInfo(row, type); }
    else if (k === 'yard') { if (typeof openShipyard === 'function') openShipyard(); }
  }

  // ---- касание пустого космоса: место станции — панель станции
  window.SP_ON_TAP = function(wx, wy, px, py, group) {
    if (!SL.ready) return false;
    var G = sp().G, sys = G.sys; if (!sys) return false;
    var M = sys.cellM, sl = sys.slot;
    if (sl && wx >= sl.x * M && wx < (sl.x + sl.size) * M && wy >= sl.y * M && wy < (sl.y + sl.size) * M) {
      if (typeof onStationSlotTapped === 'function') { onStationSlotTapped(); return true; }
    }
    // площадка сброса: свой корабль летит в неё и встаёт целиком (сервер ставит ровно по прибытии)
    // группе площадка не нужна: она идёт строем к точке (в площадку встаёт один корабль)
    var pad = group ? null : SL.padAt(wx, wy), me = G.B && G.B.ships[G.sel];
    if (pad && me && !me.dead && me.side === G.side && me.ctl !== false) {
      var t = typeof shipTypeById !== 'undefined' && shipTypeById[me.cls], fit = !t || Math.min(t.width_cells, t.height_cells) <= pad.size && Math.max(t.width_cells, t.height_cells) <= pad.size;
      if (!fit) { sp().toast(me.name + ' не помещается в площадку сброса — грузить и высаживать будет другой корабль', 'bad'); return true; }
      G.B.order(G.sel, (pad.x + pad.size / 2) * M, (pad.y + pad.size / 2) * M);
      G.mark = { x: (pad.x + pad.size / 2) * M, y: (pad.y + pad.size / 2) * M, t: performance.now(), face: false };
      sp().toast(me.name + ' идёт в площадку ' + pad.idx + ' — там погрузка и высадка войск', 'gold');
      sp().hud();
      return true;
    }
    return false;
  };
  SL.padAt = function(wx, wy) {
    var sys = sp() && sp().G.sys; if (!sys) return null;
    var M = sys.cellM, pads = sys.pads || [];
    for (var i = 0; i < pads.length; i++) { var p = pads[i]; if (wx >= p.x * M && wx < (p.x + p.size) * M && wy >= p.y * M && wy < (p.y + p.size) * M) return p; }
    return null;
  };
  // Корабль целиком в площадке — так же, как его увидит база (клетка и разворот, как пишет сервер)
  SL.onPad = function(gameId) {
    var S = sp(), G = S && S.G, sys = G && G.sys; if (!sys || !G.B) return null;
    var sh = null; for (var i = 0; i < G.B.ships.length; i++) if (G.B.ships[i].id === gameId && !G.B.ships[i].dead) { sh = G.B.ships[i]; break; }
    var t = sh && typeof shipTypeById !== 'undefined' && shipTypeById[sh.cls]; if (!t) return null;
    var d = Math.round(sh.hd * 180 / Math.PI + 90); d = ((d % 360) + 360) % 360; var f = Math.round(d / 90) * 90 % 360;
    var w = f === 90 || f === 270 ? t.height_cells : t.width_cells, h = f === 90 || f === 270 ? t.width_cells : t.height_cells, M = sys.cellM;
    var cx = Math.round(sh.x / M - w / 2), cy = Math.round(sh.y / M - h / 2), pads = sys.pads || [];
    for (i = 0; i < pads.length; i++) { var p = pads[i]; if (cx >= p.x && cx + w <= p.x + p.size && cy >= p.y && cy + h <= p.y + p.size) return p; }
    return null;
  };

  // ---- бой открылся
  window.SP_ON_HELLO = function(h, B) {
    SL.ready = true; SL.hello = h;
    if (window.sceneLoader) { sceneLoader.mark('station'); sceneLoader.mark('ships'); }
    while (toastQ.length) { var tq = toastQ.shift(); sp().toast(tq[0], tq[1]); }
    // ссылка с карты галактики на корабль — выбрать его в новом экране
    var want = (/[?&]ship=([0-9a-f-]{36})/.exec(location.search) || [])[1];
    if (want) for (var i = 0; i < B.ships.length; i++) if (B.ships[i].gameId === want || B.ships[i].id === want) { sp().selectShip(i); sp().focusShip(B.ships[i]); break; }
    // строки из базы — панелям; бой уже на экране
    if (typeof loadShips === 'function') loadShips();
    if (!SL.timer) SL.timer = setInterval(function() { if (!document.hidden && typeof loadShips === 'function') loadShips(); }, 15000);
  };

  // ---- старая панель корабля: закрывать по касанию поля, чипы листа
  function bind() {
    var bottom = $('sp-bottom'); if (bottom) bottom.addEventListener('pointerdown', onSheetClick);

    var cv = $('sp-canvas'); if (cv) cv.addEventListener('pointerdown', function() { if (typeof scDeselect === 'function' && window.scShip) scDeselect(); });
  }

  document.addEventListener('DOMContentLoaded', function() {
    bind();
    sb().auth.getSession().then(function(r) { var s = r && r.data && r.data.session; SL.user = s ? s.user.id : null; });
    boot();
  });
})();
