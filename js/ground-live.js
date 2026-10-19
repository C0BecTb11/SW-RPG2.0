/* Экран планеты на наземке 2.0 — связка нового боя (ground/ground.js по сети) со старыми
 * панелями планеты (js/ground-battle.js: постройки, поселение, найм, исследования,
 * логистика, высадка, инженерные постройки, задания).
 *
 * Как устроено:
 *   - бой рисует и ведёт ground.js в режиме живой планеты (window.GD_LIVE), сервер боёв —
 *     из rt_ground_status(); игрок входит по токену сессии Supabase;
 *   - старые панели работают как были: им отдаются те же глобальные переменные
 *     (unitsOnMap, unitTypeById, scale/panX/panY, ctx), только бойцы берутся из зеркала боя,
 *     а карта и приказы — у нового экрана;
 *   - старый тап-роутер не вызывается: касания идут через GD_ON_TAP (режимы высадки и
 *     размещения, площадь, участки, полевые постройки), остальное — выбор и приказы;
 *   - поверх боя старые наложения рисуются в старых координатах (GD_DRAW): клетки
 *     размещения, лоток десанта, установка укрепления, участки в режиме стройки.
 * ES5.
 */
(function() {
  'use strict';
  var CELL = 32;                                  // CELL_PX старого экрана: клетка = 32 px при scale 1
  var GD_SERVER_FALLBACK = 'https://2-31-45-237.sslip.io';
  var systemId = (/[?&]system=([a-z0-9_]+)/.exec(location.search) || [])[1] || '';
  var GL = { canvas: null, ready: false, rows: [], ships: [], shipsAt: 0 };
  window.GL = GL;

  function $(id) { return document.getElementById(id); }
  function sb() { return window.supabase; }

  // ---- запуск: сервер боёв и токен, потом ground.js
  function boot() {
    GL.canvas = $('sp-canvas');
    if (!systemId) return;
    window.GD_TOKEN = function() {
      return sb().auth.getSession().then(function(r) { var s = r && r.data && r.data.session; return s ? s.access_token : 'dev'; });
    };
    sb().rpc('rt_ground_status', { p_system: systemId }).then(function(r) {
      var srv = (r && r.data && r.data.server && r.data.server.url) || GD_SERVER_FALLBACK;
      if (r && r.data && r.data.server && r.data.server.online === false) toastSoon('Сервер боёв не на связи — планета может не открыться', 'bad');
      window.GD_LIVE = { system: systemId, srv: srv, ws: null, tries: 0 };
      var s = document.createElement('script'); s.src = '../ground/ground.js?v=8'; document.body.appendChild(s);
    }, function() {
      window.GD_LIVE = { system: systemId, srv: GD_SERVER_FALLBACK, ws: null, tries: 0 };
      var s = document.createElement('script'); s.src = '../ground/ground.js?v=8'; document.body.appendChild(s);
    });
  }
  var toastQ = [];
  function toastSoon(msg, kind) { if (window.GD && GD.toast) GD.toast(msg, kind); else toastQ.push([msg, kind]); }

  // ---- бойцы для старых панелей: строки как в unit_positions
  function rowOf(a) {
    var c = a.size === 2 ? [Math.round(a.x) - 1, Math.round(a.y) - 1] : [Math.floor(a.x), Math.floor(a.y)];
    return { id: a.uid, system_id: systemId, layer: 'ground', x: c[0], y: c[1], hp: Math.round(a.hp), unit_type: a.tid, quantity: 1,
             owner_user_id: a.owner, faction: a.team === 0 ? 'republic' : a.team === 1 ? 'cis' : 'marauder', hero_id: a.hero ? a.hero.hid || null : null, hero_name: a.hero ? a.name || null : null, portrait: a.hero ? a.hero.portrait : null,
             carrier_unit_id: null, passengers: 0, bonus_hp: 0, bonus_damage: 0, bonus_vision: 0, bonus_move: 0, bonus_range: 0, _agent: a.id };
  }
  GL.loadUnits = function() {
    var B = window.GD && GD.B; if (!B || !B.agents) return Promise.resolve();
    var rows = [];
    for (var i = 0; i < B.agents.length; i++) { var a = B.agents[i]; if (a && a.alive && a.uid && (a.team === GD.side || a.vis)) rows.push(rowOf(a)); }
    window.unitsOnMap = rows; GL.rows = rows;
    window.loadUnitsApplied = (window.loadUnitsApplied || 0) + 1;
    if (window.sceneLoader) sceneLoader.mark('units');
    if (typeof dtRefresh === 'function') { try { dtRefresh(); } catch (e) {} }
    return Promise.resolve();
  };
  // Справочник типов для старых панелей (лоток десанта, карточки) — один раз из базы
  function loadTypes() {
    return sb().from('unit_types').select('*').then(function(r) {
      if (r.error || !r.data || !r.data.length) return;
      var m = {}; r.data.forEach(function(t) { m[t.id] = t; });
      window.unitTypeById = m; window.unitTypesFresh = true;
    }, function() {});
  }
  GL.rowByAgent = function(id) { for (var i = 0; i < GL.rows.length; i++) if (GL.rows[i]._agent === id) return GL.rows[i]; return null; };
  // Старый экран ставит клетку в центр видимой части над открытым снизу лотком (uiBottomInset)
  GL.focusCell = function(cx, cy) {
    if (!window.GD || !GD.CAM) return;
    var inset = window.uiBottomInset || 0;
    if (inset && GD.CAM.s < 24) GD.CAM.s = 24;          // рабочий масштаб: клетки под палец
    GD.CAM.x = cx + 0.5; GD.CAM.y = cy + 0.5 + inset / 2 / GD.CAM.s;
  };

  // ---- старые координаты: scale/panX/panY/ctx следуют за камерой нового экрана
  function syncOldCam(c, s, dpr) {
    var o = GD.toS(0, 0);
    window.scale = s / CELL; window.panX = o[0]; window.panY = o[1]; window.gbDpr = dpr;
    window.ctx = c; window.canvas = GL.canvas; window.viewport = GL.canvas;
    c.setTransform(s / CELL * dpr, 0, 0, s / CELL * dpr, o[0] * dpr, o[1] * dpr);
  }
  window.GD_DRAW = function(c, s, dpr) {
    if (!GL.ready) return;
    c.save();
    syncOldCam(c, s, dpr);
    try {
      if (window.buildMode && typeof drawBuildSlots === 'function') drawBuildSlots();
      if (window.placingOrder && typeof drawPlacementCells === 'function') drawPlacementCells();
      if (window.placingStructure && typeof drawStructPlacement === 'function') drawStructPlacement();
      if (typeof drawDropCells === 'function') drawDropCells();
      if (typeof dtDraw === 'function') dtDraw();
      drawBuilding();
    } catch (e) { if (!GL.drawErr) { GL.drawErr = 1; console.warn('наложение старого экрана', e); } }
    c.restore();
  };

  // Укрепления, которые ещё строятся, бой не знает — их рисует старый экран (полупрозрачно, с таймером)
  function drawBuilding() {
    if (typeof drawStructures !== 'function' || !window.fieldStructures || !fieldStructures.length) return;
    var all = window.fieldStructures, now = typeof gbServerNow === 'function' ? gbServerNow() : Date.now();
    var mine = all.filter(function(s) { return s.completes_at && new Date(s.completes_at).getTime() > now; });
    if (!mine.length) return;
    window.fieldStructures = mine;
    try { drawStructures(); } finally { window.fieldStructures = all; }
  }

  // ---- стройка инженера: место выбирается как раньше, но боец сам идёт к нему, а закладывает комната
  function bindBuild() {
    var problem = window.structPlaceProblem;
    if (typeof problem === 'function') window.structPlaceProblem = function(unit, st, x, y) {
      var r = problem(unit, st, x, y);
      return r && r.indexOf('далеко') === 0 ? null : r;          // дальность не ограничена: инженер дойдёт
    };
    window.sendStructurePlacement = function() {
      var p = window.placingStructure; if (!p || !p.preview || p.preview.problem) return;
      var aid = p.unit && p.unit._agent; if (aid == null || !window.GD || !GD.B || !GD.B.orderBuild) return;
      GD.B.orderBuild(aid, p.type.id, p.preview.x, p.preview.y, p.type.width_cells || 1, p.type.height_cells || 1);
      GD.toast('Инженер идёт закладывать: ' + p.type.name, 'gold');
      if (typeof cancelStructurePlacement === 'function') cancelStructurePlacement();
      window.selectedUnit = null;
    };
    // наём: клетку в зоне высадки больше не выбирают — бойцы выходят у самой постройки (deliver_ready_units)
    window.updateDeployCounter = function() { var el = $('unit-panel-capacity'); if (el) { el.textContent = 'Новобранцы выйдут у постройки'; el.className = 'unit-panel-capacity'; } };
    window.startPlacement = function(unitTypeId, quantity, upgrades, heroName) {
      var bld = window.unitPanelBuilding; if (!bld) return;
      var t = window.unitTypeById && unitTypeById[unitTypeId], name = heroName || ((t && t.name) || 'бойцы');
      if (typeof closeUnitPanel === 'function') closeUnitPanel();
      var q = heroName ? sb().rpc('hire_hero', { p_building_id: bld.id, p_name: heroName })
                       : sb().rpc('order_unit', { p_building_id: bld.id, p_unit_type: unitTypeId, p_quantity: quantity, p_upgrades: upgrades || [] });
      q.then(function(res) {
        if (res.error) { GD.toast('Не удалось нанять: ' + res.error.message, 'bad'); return; }
        GD.toast(name + (heroName ? '' : ' ×' + quantity) + ': выйдут у постройки, как будут готовы', 'gold');
        if (typeof loadUnitOrders === 'function') loadUnitOrders();
      });
    };
  }

  // ---- касание: режимы старого экрана первыми, потом площадь, укрепления, участки
  window.GD_ON_TAP = function(cx, cy, agent, selCount, px, py) {
    if (!GL.ready) return false;
    var B = GD.B;
    syncOldCam(GL.canvas.getContext('2d'), GD.CAM.s, GD.dpr);
    if (window.placingStructure && typeof handleStructurePlacementTap === 'function') { handleStructurePlacementTap(cx, cy); return true; }
    if (typeof dtOpen !== 'undefined' && dtOpen && dtSelKey && (window.landingFighter || window.droppingVehicle || window.droppingUnit)) { dtTapPlace(cx, cy, px, py); return true; }
    if (typeof dtOpen !== 'undefined' && dtOpen) {
      if (cy >= 144 - (window.ATTACK_ZONE_H || 4) && cy < 144) { if (typeof dcFlash === 'function') dcFlash(px, py, 'Тяни карточку сюда', 'или выбери её тапом в лотке', 'move', 1600); return true; }
      closeDropTray();
    }
    if (window.landingFighter && typeof handleFighterLandingTap === 'function') { handleFighterLandingTap(cx, cy); return true; }
    if (window.placingOrder && typeof handlePlacementTap === 'function') { handlePlacementTap(cx, cy); return true; }
    if (selCount) return false;
    // площадь города — панель поселения
    if (cx >= B.sx && cx < B.sx + 8 && cy >= B.sy && cy < B.sy + 8 && !agent) { if (typeof openSettlementPanel === 'function') openSettlementPanel(); return true; }
    if (agent) return false;
    if (typeof structAt === 'function') { var st = structAt(cx, cy); if (st) { if (typeof openStructurePanel === 'function') openStructurePanel(st); return true; } }
    var slots = window.buildSlots || [];
    for (var i = 0; i < slots.length; i++) {
      var sl = slots[i];
      if (cx >= sl.x && cx < sl.x + 6 && cy >= sl.y && cy < sl.y + 6) {
        if (!window.buildingsBySlot[i + 1] && !window.buildMode) return false;
        onSlotTapped(i + 1); return true;
      }
    }
    return false;
  };

  // ---- вставка в лист «Войска»: погрузка на корабль, стройка инженера, древо героя
  window.GD_SHEET = function(sel) {
    if (!GL.ready || !sel.length) return '';
    var mine = sel.filter(function(a) { return a.owner === GL.user; });
    if (!mine.length) return '';
    var html = '<div class="sp-bd-row gl-row"><span class="lab">На борт</span>';
    if (GL.ships.length) GL.ships.forEach(function(sh) { html += '<button class="sp-chip" data-gl="load" data-ship="' + sh.ship_id + '">' + escapeHtml(sh.ship_name) + ' <em>мест ' + sh.free_slots + '</em></button>'; });
    else html += '<span class="sp-dim">нет своего корабля на площадке сброса</span>';
    html += '<button class="sp-chip" data-gl="ships" title="Обновить список">↻</button></div>';
    var eng = mine.filter(function(a) { return a.T.builder; })[0], hero = mine.filter(function(a) { return a.hero; })[0];
    if (eng || hero) {
      html += '<div class="sp-bd-row gl-row"><span class="lab">Ещё</span>';
      if (eng) html += '<button class="sp-chip" data-gl="build" data-id="' + eng.id + '">Укрепление <em>инженер</em></button>';
      if (hero) html += '<button class="sp-chip" data-gl="tree" data-id="' + hero.id + '">Древо героя</button>';
      html += '</div>';
    }
    return html;
  };
  function escapeHtml(s) { return String(s || '').replace(/[&<>"]/g, function(c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function loadShips(force) {
    if (!force && Date.now() - GL.shipsAt < 20000) return Promise.resolve(GL.ships);
    GL.shipsAt = Date.now();
    return sb().rpc('get_loadable_ships', { p_system: systemId }).then(function(r) { GL.ships = (!r.error && r.data) ? r.data : []; return GL.ships; });
  }
  function onSheetClick(e) {
    var t = e.target.closest('[data-gl]'); if (!t) return;
    e.preventDefault();
    var k = t.getAttribute('data-gl'), sel = GD.selected ? GD.selected() : [];
    if (k === 'load') {
      var ids = sel.filter(function(a) { return a.owner === GL.user; }).map(function(a) { return a.id; });
      if (!ids.length) return;
      GD.B.orderLoad(ids, t.getAttribute('data-ship'));
      GD.toast('На борт: ' + ids.length + ' — идут в зону погрузки', 'gold');
    } else if (k === 'ships') { loadShips(true).then(function() { GD.hud(); }); }
    else if (k === 'build') { var row = GL.rowByAgent(+t.getAttribute('data-id')); if (row && typeof openStructureBuildPanel === 'function') { window.selectedUnit = row; openStructureBuildPanel(row); } }
    else if (k === 'tree') { var hr = GL.rowByAgent(+t.getAttribute('data-id')); if (hr && typeof openHeroTree === 'function') openHeroTree(hr); }
  }

  // ---- бой открылся
  window.GD_ON_HELLO = function(h, B) {
    GL.ready = true; GL.hello = h;
    loadTypes().then(function() { GL.loadUnits(); });
    GL.loadUnits();
    loadShips(true).then(function() { if (GD.usel.length) GD.hud(); });
    if (window.sceneLoader) { sceneLoader.mark('terrain'); sceneLoader.mark('units'); sceneLoader.mark('settlement'); sceneLoader.mark('structures'); }
    if (!GL.timer) GL.timer = setInterval(function() { if (!document.hidden) GL.loadUnits(); }, 1000);
    while (toastQ.length) { var tq = toastQ.shift(); GD.toast(tq[0], tq[1]); }
    GD.toast(h.att === GD.side ? 'Штурм: твой десант в полосе вторжения. Площадь города — цель' : 'Твоя планета. Гарнизон держит площадь', 'gold');
  };

  // ---- кнопки нового низа: десант (лоток старого экрана)
  function bindDock() {
    var dock = $('sp-dock'); if (!dock) return;
    var mk = function(id, text, fn) { var b = document.createElement('button'); b.className = 'sp-btn'; b.id = id; b.type = 'button'; b.textContent = text; b.onclick = fn; dock.insertBefore(b, $('sp-view')); return b; };
    // поселение — кнопкой, а не только касанием площади (на ней стоят бойцы)
    mk('gl-settle', 'Поселение', function() { if (typeof openSettlementPanel === 'function') openSettlementPanel(); });
    // инженер выбран — стройка укрепления прямо из дока
    var eng = mk('gl-build', 'Стройка', function() {
      var sel = window.GD && GD.selected ? GD.selected() : [], e = sel.filter(function(a) { return a.T.builder && a.owner === GL.user; })[0];
      var row = e && GL.rowByAgent(e.id);
      if (row && typeof openStructureBuildPanel === 'function') { window.selectedUnit = row; openStructureBuildPanel(row); }
      else GD.toast('Выбери своего инженера', 'bad');
    });
    eng.hidden = true;
    setInterval(function() {
      var sel = window.GD && GD.selected ? GD.selected() : [];
      eng.hidden = !sel.some(function(a) { return a.T.builder && a.owner === GL.user; });
      document.body.classList.toggle('build', !!window.buildMode);          // стройка: боевой низ не нужен
      document.body.classList.toggle('placing', !!(window.placingStructure || window.placingOrder));   // выбор клетки — тоже
    }, 400);
    mk('gl-drop', 'Десант', function() { if (typeof openDropTray === 'function') openDropTray(); });
    window.GD_COMPACT = true;                    // верхней панели нет: захват площади — в нижней полосе
    $('sp-bottom').addEventListener('pointerdown', onSheetClick);
    // лоток десанта открыт — низ нового экрана уступает место
    var mo = new MutationObserver(function() { document.body.classList.toggle('dt-open', typeof dtOpen !== 'undefined' && !!dtOpen); });
    mo.observe(document.body, { childList: true, subtree: false, attributes: true, attributeFilter: ['class'] });
    setInterval(function() { document.body.classList.toggle('dt-open', typeof dtOpen !== 'undefined' && !!dtOpen); }, 500);
  }

  document.addEventListener('DOMContentLoaded', function() {
    bindDock(); bindBuild();
    sb().auth.getSession().then(function(r) { var s = r && r.data && r.data.session; GL.user = s ? s.user.id : null; });
    boot();
  });
})();
