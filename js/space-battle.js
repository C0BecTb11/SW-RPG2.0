// Орбита конкретной планеты (system=id в URL): данные страницы — станция,
// верфь и док, список кораблей, сторона прыжка. Карту, ход и бой рисует
// космос 2.0 (js/space-live.js и space/*), он же читает отсюда глобальные
// shipsInSystem, shipTypeById, stationRecord, spaceMyFaction.

var systemId = null;
var STATION_SIZE = 8;      // слот станции, размер приходит из БД

// Арт станции по фракции. Своей таблицы типов у станций нет — вариант
// ровно один на фракцию, поэтому держим соответствие здесь, как сделано
// с цветами фракций в planets.js и bottom-panel.js.
var STATION_IMAGES = {
  republic: 'assets/stations/station-republic.png',
  cis: 'assets/stations/station-cis.png'
};
var stationSlot = null;    // {x, y} — позиция слота в клетках
var stationLoaded = false; // первый ответ о станции пришёл
var stationRecord = null;  // запись из space_stations, если станция построена
var currentUserId = null;
var isController = false;  // может ли текущий игрок строить в этой системе

// Позиция слота станции приходит из БД: там же её проверяет сервер,
// когда расставляет построенные корабли вокруг станции.
function loadStationSlot() {
  return supabase.from('station_slots').select('*').eq('system_id', systemId).maybeSingle()
    .then(function(res) {
      if (res.error) {
        console.error('Не удалось загрузить слот станции:', res.error);
      } else if (!res.data && !isDeepSpace) {
        console.error('Для этой системы нет записи в station_slots — выполни sql/ships.sql');
      }
      stationSlot = (res.error || !res.data) ? null : res.data;
      if (stationSlot && stationSlot.size) STATION_SIZE = stationSlot.size;
    });
}

// ===== Аренда верфи =====
// Управляющий может сдать верфь станции союзнику на срок
// (js/production-lease.js). Пока аренда идёт, строит и чинит в доке
// только арендатор.
var spLeaseMap = {};
var spStationSeq = 0;

function spLoadLeases() {
  if (typeof plSystemLeases !== 'function') return Promise.resolve(spLeaseMap);
  return plSystemLeases(systemId).then(function(map) {
    spLeaseMap = map || {};
    return spLeaseMap;
  });
}

function spStationLease() {
  return typeof plLeaseOf === 'function' ? plLeaseOf(spLeaseMap, null) : null;
}

function onStationSlotTapped() {
  var my = ++spStationSeq;
  spPaintStationPanel(spStationLease());
  // Кэш мог устареть: свежий ответ перерисует кнопки и блок аренды
  spLoadLeases().then(function() {
    var panel = document.getElementById('station-panel');
    if (my !== spStationSeq || !panel || panel.style.display === 'none') return;
    spPaintStationPanel(spStationLease());
  });
}

function spPaintStationPanel(lease) {
  var panel = document.getElementById('station-panel');
  var titleEl = document.getElementById('station-panel-title');
  var textEl = document.getElementById('station-panel-text');
  var buildBtn = document.getElementById('station-build-btn');
  var demolishBtn = document.getElementById('station-demolish-btn');

  var shipyardBtn = document.getElementById('station-shipyard-btn');

  if (stationRecord) {
    var building = stationRecord.completes_at
      && new Date(stationRecord.completes_at).getTime() > sbNow();
    var captured = sysFaction && stationRecord.faction
      && stationRecord.faction !== sysFaction;

    titleEl.textContent = stationRecord.name || 'Космическая станция';

    // Космос и земля — одна планета: право на верфь даёт контроль над
    // системой, а не то, кто станцию построил. Иначе после передачи
    // планеты верфь осталась бы у прежнего хозяина.
    if (building) {
      var left = Math.max(0, Math.ceil(
        (new Date(stationRecord.completes_at).getTime() - sbNow()) / 1000));
      textEl.textContent = 'Станция строится: осталось ' + left + ' с';
    } else if (captured) {
      textEl.textContent = 'Трофейная станция — работать не будет, только снос';
    } else {
      textEl.textContent = 'Верфь готова к постройке кораблей';
    }

    buildBtn.style.display = 'none';
    demolishBtn.style.display = isController ? 'block' : 'none';

    // Аренда: арендатор получает верфь, хозяин сданной — нет
    var tenant = typeof plIsTenant === 'function' && plIsTenant(lease);
    var lockedOwner = typeof plIsLockedOwner === 'function' && plIsLockedOwner(lease);
    var held = !!lease && lease.role === 'lessor';
    if (tenant && !building && !captured) {
      textEl.textContent = 'Верфь в аренде у тебя — строй и чини корабли здесь';
    } else if (lockedOwner && !building && !captured) {
      textEl.textContent = 'Верфь сдана в аренду';
    }
    // Гасим только сами и только сами снимаем: пока окно «Точно?» ждёт
    // цену, кнопку держит закрытой askStation
    if (held) demolishBtn.disabled = true;
    else if (demolishBtn._plHeld) demolishBtn.disabled = false;
    demolishBtn._plHeld = held;
    demolishBtn.title = held ? 'Сначала дождись конца аренды или отзови предложение' : '';

    if (shipyardBtn) shipyardBtn.style.display =
      (((isController && !lockedOwner) || tenant) && !building && !captured) ? 'block' : 'none';

    spPaintStationLease(lease, isController && !building && !captured);
  } else {
    titleEl.textContent = 'Слот космической станции';
    textEl.textContent = isController ? 'Здесь можно построить станцию' : 'У тебя нет прав на строительство здесь';
    buildBtn.style.display = isController ? 'block' : 'none';
    demolishBtn.style.display = 'none';
    if (shipyardBtn) shipyardBtn.style.display = 'none';
    spPaintStationLease(null, false);
  }

  panel.style.display = 'flex';
}

function spPaintStationLease(lease, canOffer) {
  var host = document.getElementById('station-lease');
  if (!host) return;
  if (typeof plRenderBlock !== 'function') { host.style.display = 'none'; return; }
  var fac = (stationRecord && stationRecord.faction) || sysFaction;
  plRenderBlock(host, {
    systemId: systemId,
    buildingId: null,
    name: 'Верфь',
    image: (typeof STATION_IMAGES !== 'undefined' && STATION_IMAGES[fac]) || null,
    planetName: plPlanetName(),
    lease: lease,
    canOffer: !!canOffer,
    onOpen: function() { closeStationPanel(); openShipyard(); },
    onChanged: function() {
      var my = ++spStationSeq;
      spLoadLeases().then(function() {
        var panel = document.getElementById('station-panel');
        if (my !== spStationSeq || !panel || panel.style.display === 'none') return;
        spPaintStationPanel(spStationLease());
      });
    }
  });
}

function closeStationPanel() {
  document.getElementById('station-panel').style.display = 'none';
  spStationSeq++;
  var host = document.getElementById('station-lease');
  if (host && typeof plStopTick === 'function') plStopTick(host);
}

// Цена станции — из справочника построек по фракции (как считает сервер).
// Кэшируем: справочник за игру не меняется.
var stationCostCache = {};

function stationCost(faction, done) {
  if (!faction) { done(null); return; }
  if (stationCostCache[faction] !== undefined) { done(stationCostCache[faction]); return; }
  supabase.from('building_types').select('cost, image').eq('is_space', true).eq('faction', faction)
    .limit(1).then(function(res) {
      var row = (!res.error && res.data && res.data[0]) || null;
      stationCostCache[faction] = row ? { cost: row.cost, image: row.image } : null;
      done(stationCostCache[faction]);
    }, function() { done(null); });
}

function askStation(kind) {
  var btnId = kind === 'build' ? 'station-build-btn' : 'station-demolish-btn';
  var btn = document.getElementById(btnId);
  if (btn && btn.disabled) return;
  var go = kind === 'build' ? buildStation : demolishStation;
  if (typeof gameConfirm !== 'function') { go(); return; }

  var fac = kind === 'build' ? spaceMyFaction : (stationRecord && stationRecord.faction);
  var captured = kind !== 'build' && sysFaction && stationRecord && stationRecord.faction &&
                 stationRecord.faction !== sysFaction;
  if (btn) btn.disabled = true;

  stationCost(fac, function(info) {
    if (btn) btn.disabled = false;
    // Пока ждали цену, панель станции закрыли — окно само не всплывает
    var sp = document.getElementById('station-panel');
    if (!sp || sp.style.display === 'none') return;
    var cost = info ? info.cost : 5000;
    var half = Math.floor(cost / 2);
    var art = STATION_IMAGES[fac] || (info && info.image) || null;
    var img = art ? '../' + art : null;
    var o;
    if (kind === 'build') {
      o = {
        tone: 'build', kicker: 'Подтверди стройку', title: 'Космическая станция',
        image: img, sub: 'Верфь и оборона на орбите',
        rows: [{ label: 'Спишется', items: [{ kind: 'credits', text: cost + ' кр.' }] }],
        note: 'Если потом снести — вернётся половина цены.',
        ok: 'Построить'
      };
    } else if (captured) {
      o = {
        tone: 'danger', kicker: 'Подтверди снос', title: (stationRecord && stationRecord.name) || 'Космическая станция',
        image: img, sub: 'Трофейная станция',
        rows: [{ label: 'Спишется', items: [{ kind: 'credits', text: half + ' кр.' }] }],
        note: 'Расчистка чужой станции платная. Вернуть её будет нельзя.',
        ok: 'Снести'
      };
    } else {
      o = {
        tone: 'danger', kicker: 'Подтверди снос', title: (stationRecord && stationRecord.name) || 'Космическая станция',
        image: img, sub: 'Вместе со станцией пропадёт верфь',
        rows: [{ label: 'Вернётся', dir: 'in', items: [{ kind: 'credits', text: '+' + half + ' кр.' }] }],
        note: 'Станция исчезнет сразу — отменить снос нельзя.',
        ok: 'Снести'
      };
    }
    gameConfirm(o, go);
  });
}

function buildStation() {
  var btn = document.getElementById('station-build-btn');
  btn.disabled = true;
  supabase.rpc('construct_space_station', { p_system_id: systemId }).then(function(res) {
    btn.disabled = false;
    closeStationPanel();
    if (res.error) {
      alert('Не удалось построить: ' + res.error.message);
      return;
    }
    loadStation();
  });
}

function demolishStation() {
  var btn = document.getElementById('station-demolish-btn');
  btn.disabled = true;
  supabase.rpc('demolish_space_station', { p_system_id: systemId }).then(function(res) {
    btn.disabled = false;
    closeStationPanel();
    if (res.error) {
      alert('Не удалось снести: ' + res.error.message);
      return;
    }
    loadStation();
  });
}

function loadStation() {
  supabase.from('space_stations').select('*').eq('system_id', systemId).maybeSingle().then(function(res) {
    stationRecord = (!res.error && res.data) ? res.data : null;
    stationLoaded = true;
    if (window.sceneLoader) sceneLoader.mark('station');
  });
}

// Сторона прыжка (сверху — хозяин системы, снизу — пришедший): по ней
// курс новичка показывает полосу прыжка (js/quest.js)
var myZoneSide = null;
var sysFaction = null;   // фракция планеты: по ней видно, трофейна ли станция
var spaceMyFaction = null; // своя фракция: союзные корабли отличаем от вражеских

function loadHyperspaceZone() {
  return supabase.auth.getSession().then(function(res) {
    if (!res.data.session) return;

    return Promise.all([
      supabase.from('profiles').select('faction').eq('id', res.data.session.user.id).maybeSingle(),
      supabase.from('systems').select('faction, is_deep_space, name').eq('id', systemId).maybeSingle()
    ]).then(function(r) {
      var myFaction = (r[0].data && r[0].data.faction) || null;
      spaceMyFaction = myFaction;
      sysFaction = (r[1].data && r[1].data.faction) || null;
      isDeepSpace = !!(r[1].data && r[1].data.is_deep_space);

      // У пустоты фракция стоит 'neutral' только потому, что поле
      // не допускает пустого значения. Хозяина у неё нет, и стороны
      // должны раскладываться как в ничейной системе.
      if (sysFaction === 'neutral') sysFaction = null;

      if (isDeepSpace) markDeepSpace(r[1].data.name);
      // переход на поверхность (js/map-layer.js): система известна, у пустоты его нет — body.deep-space
      var layer = document.getElementById('sp-layer');
      if (layer && r[1].data) layer.classList.remove('wait');

      if (!myFaction) return;

      // Та же логика, что в hyperspace_side на сервере: хозяин системы
      // обороняется сверху, пришедший заходит снизу. У ничейной системы
      // стороны закреплены за фракциями, иначе враги делили бы одну полосу.
      if (!sysFaction) {
        myZoneSide = (myFaction === 'republic') ? 'top' : 'bottom';
      } else {
        myZoneSide = (sysFaction === myFaction) ? 'top' : 'bottom';
      }
    });
  });
}

function checkStationRights() {
  return supabase.auth.getSession().then(function(res) {
    if (!res.data.session) return;
    currentUserId = res.data.session.user.id;
    return supabase.from('system_control').select('controller_user_id').eq('system_id', systemId).maybeSingle().then(function(controlRes) {
      isController = !controlRes.error && controlRes.data && controlRes.data.controller_user_id === currentUserId;
    });
  });
}

function getSystemIdFromUrl() {
  var params = new URLSearchParams(window.location.search);
  return params.get('system');
}

// Доводит камеру боя до клетки (клетка орбиты — 200 м)
function focusCell(cx, cy) {
  if (!window.__sp) return;
  var C = __sp.CAM; C.x = (cx + 0.5) * 200; C.y = (cy + 0.5) * 200; __sp.G.follow = '';
}

// Realtime орбиты: станция и корабли системы.
// Пачка событий — одна перезагрузка: залп, автоход или выход из гиперпрыжка
// двигают несколько кораблей разом, и каждое событие раньше тянуло весь
// флот системы и пересобирало все спрайты заново
var spSoonTimers = {};
function spSoon(key, fn, ms) {
  if (spSoonTimers[key]) return;
  spSoonTimers[key] = setTimeout(function() {
    spSoonTimers[key] = null;
    fn();
  }, ms);
}

function subscribeToSpaceChanges() {
  if (!systemId) return;
  supabase
    .channel('space-' + systemId)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'space_stations', filter: 'system_id=eq.' + systemId }, function() {
      spSoon('station', loadStation, 250);
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'ships', filter: 'system_id=eq.' + systemId }, function() {
      spSoon('ships', loadShips, 150);
    })
    .subscribe();
}

function initSpaceBattle() {
  systemId = getSystemIdFromUrl();

  var stationPanelClose = document.getElementById('station-panel-close');
  if (stationPanelClose) stationPanelClose.addEventListener('click', closeStationPanel);

  var stationBuildBtn = document.getElementById('station-build-btn');
  if (stationBuildBtn) stationBuildBtn.addEventListener('click', function() { askStation('build'); });

  var stationDemolishBtn = document.getElementById('station-demolish-btn');
  if (stationDemolishBtn) stationDemolishBtn.addEventListener('click', function() { askStation('demolish'); });

  loadFighterInfo();

  var shipyardOpen = document.getElementById('station-shipyard-btn');
  if (shipyardOpen) shipyardOpen.addEventListener('click', function() {
    closeStationPanel();
    openShipyard();
  });

  var shipyardClose = document.getElementById('shipyard-close');
  if (shipyardClose) shipyardClose.addEventListener('click', closeShipyard);

  var shipInfoClose = document.getElementById('ship-info-close');
  if (shipInfoClose) shipInfoClose.addEventListener('click', closeShipInfo);

  // Очередь верфи — только пока вкладка на экране
  setInterval(function() { if (!document.hidden && systemId) loadShipOrders(); }, 5000);

  // Вход проверяем с повтором: краткий сбой не выкидывает из игры
  sbSessionGate().then(function(res) {
    if (!systemId) { if (window.sceneLoader) sceneLoader.hide(); return; }
    if (window.sceneLoader) sceneLoader.expect([['station', 'Станция'], ['ships', 'Флот']]);

    Promise.all([loadStationSlot(), checkStationRights(), loadHyperspaceZone(), spLoadLeases()]).then(function() {
      loadStation();
      loadShips();
      initBuildToggle();
      subscribeToSpaceChanges();
      // Пока вкладка спала, реалтайм мог пропустить события. Слушаем
      // только после загрузки: раньше это сбило бы экран загрузки
      document.addEventListener('visibilitychange', function() {
        if (document.hidden) return;
        spSoon('ships', loadShips, 50);
        spSoon('station', loadStation, 50);
      });
      if (typeof sxDeepLink === 'function') sxDeepLink();
    });
  });
}

document.addEventListener('DOMContentLoaded', initSpaceBattle);

// ===== Корабли =====

var shipsInSystem = [];
var shipTypeById = {};

// Справочник типов кораблей по ходу боя не меняется — один раз, и заново
// только если в системе появился неизвестный тип
var shipTypesFresh = false;

function loadShips() {
  // Номер запроса: старый ответ не должен лечь поверх нового
  var req = typeof sxShipsRequested === 'function' ? sxShipsRequested() : null;
  Promise.all([
    // Корабли в гиперпространстве на карте не показываем: они уже
    // покинули систему и физически здесь их нет
    supabase.from('ships').select('*').eq('system_id', systemId).eq('in_transit', false),
    shipTypesFresh ? Promise.resolve(null) : supabase.from('ship_types').select('*')
  ]).then(function(r) {
    if (req && typeof sxShipsFresh === 'function' && !sxShipsFresh(req)) return;
    // Сбой запроса не стирает корабли с карты
    if (r[0].error || !r[0].data) return;
    shipsInSystem = r[0].data;
    if (r[1] && !r[1].error && r[1].data && r[1].data.length) {
      shipTypeById = {};
      r[1].data.forEach(function(t) { shipTypeById[t.id] = t; });
      shipTypesFresh = true;
    }
    if (shipsInSystem.some(function(sh) { return !shipTypeById[sh.ship_type]; })) shipTypesFresh = false;
    if (window.sceneLoader) sceneLoader.mark('ships');
    loadShipOrders();
    if (typeof onShipsReloaded === 'function') onShipsReloaded();
  });
}

// Время сервера (сдвиг считает ship-control.js): отметки базы сравниваются с ним, а не с часами телефона
function sbNow() { return typeof scServerNow === 'function' ? scServerNow() : Date.now(); }

function openShipInfo(ship, type) {
  var panel = document.getElementById('ship-info');
  document.getElementById('ship-info-name').textContent = ship.name ? '«' + ship.name + '» · ' + type.name : type.name;
  fillShipCommanders(ship);
  // как бой 2.0 видит корабль: тип + бонусы исследований (shared/rt-army.js, rt-space.js);
  // трофей до ремонта — без щитов
  var bn = function(k) { return Number(ship[k]) || 0; };
  var sh = (type.max_shield || 0) + bn('bonus_shield'), fore = bn('bonus_fore');
  var el = document.getElementById('ship-info-stats');
  el.innerHTML =
    '<div><span>Прочность</span><b>' + ship.hp + ' / ' + ((type.max_hp || 0) + bn('bonus_hp')) + '</b></div>' +
    '<div><span>Щит сектора</span><b>' + (ship.trophy ? 'нет' : sh) + '</b></div>' +
    (fore && !ship.trophy ? '<div><span>Щит носа</span><b>' + (sh + fore) + '</b></div>' : '') +
    '<div><span>Урон</span><b>' + ((type.damage || 0) + bn('bonus_damage')) + '</b></div>' +
    '<div><span>Скорость</span><b>' + spSpeed(type, bn('bonus_move')) + '</b></div>' +
    '<div><span>Датчики</span><b data-sens>…</b></div>' +
    '<div><span>Трюм</span><b>' + ((type.capacity || 0) + bn('bonus_capacity')) + ' мест</b></div>' +
    (ship.trophy ? '<div class="wide"><span>Трофей до ремонта</span><b>щиты не работают</b></div>' : '');
  spSensFill(el.querySelector('[data-sens]'), type.id, bn('bonus_vision'));
  panel.style.display = 'flex';
}

// Скорость в бою: ход × 9 м/с (rt-space.js: vmax = (move + moveB) × 9)
function spSpeed(type, moveB) { return ((type.move_range || 0) + (moveB || 0)) * 9 + ' м/с'; }
// Датчики в бою — по длине корпуса (shared/ships/index.json) и сонару; список длин грузится один раз
var spShipLen = null;
function spSensFill(el, typeId, visB) {
  if (!el) return;
  if (!spShipLen) {
    spShipLen = fetch('../shared/ships/index.json?v=1').then(function(r) { return r.ok ? r.json() : []; })
      .then(function(list) { var m = {}; (list || []).forEach(function(s) { m[s.id] = s.length_m; }); return m; })
      .catch(function() { spShipLen = null; return {}; });
  }
  spShipLen.then(function(m) {
    var L = m[typeId];
    el.textContent = L && window.SWSpace && SWSpace.sensOf ? String(Math.round(SWSpace.sensOf(L, visB) / 100) / 10).replace('.', ',') + ' км' : '—';
  });
}

// Передача корабля командиру: в списке только свои командиры, которые
// стоят в этой же системе и не в пути — остальных сервер всё равно отклонит.
function fillShipCommanders(ship) {
  var box = document.getElementById('ship-info-commander');
  if (!box) return;

  if (ship.owner_user_id !== currentUserId) {
    box.innerHTML = '';
    return;
  }

  box.innerHTML = '<div class="ship-assign-title">Командир флота</div>' +
    '<div class="ship-assign-note">Корабль сам никуда не летит. Прикрепи его ' +
    'к своему командиру в этой системе — тогда он пойдёт за ним на другую планету.</div>';

  supabase.from('commanders').select('*')
    .eq('user_id', currentUserId).eq('unlocked', true)
    .then(function(res) {
      var here = (res.data || []).filter(function(c) {
        return !c.moving_to && c.current_system === ship.system_id;
      });

      var select = document.createElement('select');
      select.className = 'ship-assign-select';

      var none = document.createElement('option');
      none.value = '';
      none.textContent = '— без командира —';
      select.appendChild(none);

      here.forEach(function(c) {
        var opt = document.createElement('option');
        opt.value = c.id;
        opt.textContent = c.name;
        if (ship.commander_id === c.id) opt.selected = true;
        select.appendChild(opt);
      });

      select.addEventListener('change', function() {
        supabase.rpc('assign_ship', {
          p_ship_id: ship.id,
          p_commander_id: select.value || null
        }).then(function(r) {
          if (r.error) { alert(r.error.message); return; }
          ship.commander_id = select.value || null;
          loadShips();
        });
      });

      box.appendChild(select);

      if (here.length === 0) {
        var hint = document.createElement('div');
        hint.className = 'ship-assign-hint';
        hint.textContent = 'В этой системе нет твоих свободных командиров';
        box.appendChild(hint);
      }
    });
}

function closeShipInfo() {
  document.getElementById('ship-info').style.display = 'none';
}

// ===== Верфь: заказ кораблей на станции =====

// Склад планеты и занятость стапеля — чтобы карточка честно говорила
// «не хватает дюрастали» или «стапель занят» до нажатия, а не отказом
var syStock = null;      // resource → { name, amount, color }; null — склад не виден
var syResNames = null;   // справочник названий для тех, кому склад не показан
var syBusy = null;       // { name, until } — что сейчас строится или чинится
var sySeq = 0;

// keep — перечитать уже открытую верфь (после заказа в доке, по концу
// работ): без «Загрузки» и с тем же местом прокрутки
function openShipyard(keep) {
  var panel = document.getElementById('shipyard-panel');
  var list = document.getElementById('shipyard-list');
  keep = keep === true && panel.style.display !== 'none';
  var keepTop = keep ? list.scrollTop : 0;
  if (!keep) list.innerHTML = '<div class="shipyard-empty">Загрузка...</div>';
  panel.style.display = 'flex';
  var my = ++sySeq;

  // Фракция уже известна с загрузки карты — лишний запрос не нужен
  var facReady = spaceMyFaction ? Promise.resolve(spaceMyFaction)
    : Promise.resolve(supabase.rpc('get_my_profile')).then(function(pr) {
        return (pr && !pr.error && pr.data && pr.data.length) ? pr.data[0].faction : null;
      });

  facReady.then(function(faction) {
    Promise.all([
      // От дешёвых к дорогим: корвет, крейсеры, линкоры, дредноут
      supabase.from('ship_types').select('*').eq('is_fighter', false).eq('faction', faction).order('cost'),
      // Корабли, временно закрытые настройкой (например, на время теста)
      supabase.from('game_settings').select('value').eq('key', 'locked_for_test').maybeSingle(),
      supabase.rpc('get_planet_stock', { p_system_id: systemId }),
      supabase.rpc('get_shipyard_state', { p_system_id: systemId }),
      syResNames ? Promise.resolve(null) : supabase.from('resources').select('id, name, color')
    ]).then(function(rr) {
      if (my !== sySeq) return;
      var res = rr[0];
      syApplyState(rr[2], rr[3], rr[4]);
      var locked = (rr[1] && !rr[1].error && rr[1].data && rr[1].data.value)
        ? String(rr[1].data.value).split(',').map(function(x) { return x.trim(); }) : [];
      if (!res.error && res.data) {
        res.data = res.data.filter(function(t) { return locked.indexOf(t.id) === -1; });
      }
      if (res.error || !res.data || res.data.length === 0) {
        list.innerHTML = '<div class="shipyard-empty">Нет доступных кораблей</div>';
        return;
      }
      list.innerHTML = '';

      // Аренда: кому сейчас принадлежит верфь и сколько осталось
      spPaintShipyardLease(list);
      // Стапель занят — одна строка сверху вместо отказа на каждой кнопке
      syPaintBusy(list);

      // Док стоит над стапелем: чинить и дооснащать уже построенное
      // обычно нужнее, чем закладывать новый корпус.
      var dock = document.createElement('div');
      dock.className = 'dock-box';
      dock.innerHTML = '<div class="dock-empty">Загрузка...</div>';
      list.appendChild(dock);
      loadDock(dock);

      res.data.forEach(function(type) {
        list.appendChild(makeShipCard(type));
      });
      if (keep) list.scrollTop = keepTop;
    });
  });
}

function syApplyState(stockRes, busyRes, namesRes) {
  syStock = null;
  if (stockRes && !stockRes.error && stockRes.data && stockRes.data.length) {
    syStock = {};
    stockRes.data.forEach(function(r) {
      syStock[r.resource] = { name: r.name, amount: r.amount || 0, color: r.color };
    });
  }
  if (namesRes && !namesRes.error && namesRes.data) {
    syResNames = {};
    namesRes.data.forEach(function(r) { syResNames[r.id] = { name: r.name, color: r.color }; });
  }
  var b = (busyRes && !busyRes.error && busyRes.data && busyRes.data.length) ? busyRes.data[0] : null;
  syBusy = b ? { name: b.busy_name, until: Date.now() + (b.seconds_left || 0) * 1000 } : null;
}

function syBusyLeft() {
  return syBusy ? Math.max(0, Math.ceil((syBusy.until - Date.now()) / 1000)) : 0;
}

function syLeftText(sec) {
  if (sec >= 60) return Math.floor(sec / 60) + ' мин ' + (sec % 60) + ' с';
  return sec + ' с';
}

// Строка «Стапель занят» над доком; по нулю перечитываем верфь целиком
function syPaintBusy(list) {
  if (!syBusy || syBusyLeft() <= 0) return;
  var el = document.createElement('div');
  el.className = 'sy-busy';
  el.innerHTML = '<span class="sy-busy-ico">⧗</span>' +
    '<span class="sy-busy-txt"><b>Стапель занят</b><i></i></span>';
  var txt = el.querySelector('i');
  var paint = function() {
    txt.textContent = (syBusy ? syBusy.name : 'работа') + ' · готово через ' + syLeftText(syBusyLeft());
  };
  paint();
  var lease = document.getElementById('shipyard-lease');
  list.insertBefore(el, lease ? lease.nextSibling : list.firstChild);
  var my = sySeq;
  var tick = setInterval(function() {
    var panel = document.getElementById('shipyard-panel');
    if (my !== sySeq || !document.body.contains(el) || !panel || panel.style.display === 'none') {
      clearInterval(tick); return;
    }
    if (syBusyLeft() <= 0) { clearInterval(tick); openShipyard(true); return; }
    paint();
  }, 1000);
}

// Сырьё корабля со склада планеты: чипы с подсветкой нехватки.
// Возвращает названия того, чего не хватает (если склад виден)
function syResourceLine(costRes, box) {
  var keys = Object.keys(costRes || {});
  if (!keys.length) return [];
  var short = [];
  var line = document.createElement('div');
  line.className = 'sy-res';
  var lbl = document.createElement('span');
  lbl.className = 'sy-res-lbl';
  lbl.textContent = 'Со склада';
  line.appendChild(lbl);
  keys.forEach(function(k) {
    var need = costRes[k];
    var info = (syStock && syStock[k]) || (syResNames && syResNames[k]) || { name: k };
    var have = syStock && syStock[k] ? syStock[k].amount : null;
    var lack = have !== null && have < need;
    if (lack) short.push(info.name);
    var chip = document.createElement('span');
    chip.className = 'sy-res-chip' + (lack ? ' short' : '');
    if (info.color) chip.style.borderLeftColor = info.color;
    chip.textContent = info.name + ' ' + need + (have !== null ? ' / ' + have : '');
    chip.title = have !== null ? ('на складе ' + have) : '';
    line.appendChild(chip);
  });
  box.appendChild(line);
  return short;
}

// ===== Док: ремонт корпуса, модернизация, пополнение ангара =====
// Стапель и док делят одну очередь, поэтому после любой отправки
// карточки перерисовываются целиком.
function loadDock(box) {
  supabase.rpc('get_dock_ships', { p_system_id: systemId }).then(function(res) {
    if (res.error) {
      box.innerHTML = '<div class="dock-empty">Не удалось прочитать список</div>';
      return;
    }

    var ships = res.data || [];
    box.innerHTML = '<div class="dock-head">Док</div>';

    if (!ships.length) {
      var hint = document.createElement('div');
      hint.className = 'dock-empty';
      hint.textContent = 'В этой системе нет твоих кораблей';
      box.appendChild(hint);
      return;
    }

    ships.forEach(function(s) { box.appendChild(makeDockCard(s, box)); });
  });
}

// Разобрать трофей: 40% сырья его стоимости — на склад планеты
function makeScrapButton(s, stype) {
  var cr = (stype && stype.cost_resources) || {};
  var parts = [];
  Object.keys(cr).forEach(function(k) {
    var n = Math.floor((Number(cr[k]) || 0) * 0.4);
    if (n <= 0) return;
    var info = (syStock && syStock[k]) || (syResNames && syResNames[k]) || { name: k };
    parts.push(info.name + ' +' + n);
  });
  var b = document.createElement('button');
  b.className = 'dock-go dock-scrap';
  b.textContent = 'Разобрать на сырьё' + (parts.length ? ' · ' + parts.join(', ') : '');
  b.addEventListener('click', function() {
    var go = function() {
      b.disabled = true;
      supabase.rpc('scrap_trophy', { p_ship_id: s.ship_id }).then(function(r) {
        b.disabled = false;
        if (r.error) { alert('Не вышло: ' + r.error.message); return; }
        var got = (r.data && r.data.got) || {}, lost = [];
        Object.keys(cr).forEach(function(k) {
          var want = Math.floor((Number(cr[k]) || 0) * 0.4);
          if (want > 0 && (got[k] || 0) < want) lost.push(((syStock && syStock[k]) || (syResNames && syResNames[k]) || { name: k }).name);
        });
        if (lost.length) alert('Трофей разобран. Склад полон — не поместилось: ' + lost.join(', '));
        if (typeof loadShips === 'function') loadShips();
        openShipyard(true);
      });
    };
    if (typeof gameConfirm !== 'function') { go(); return; }
    gameConfirm({
      tone: 'danger', kicker: 'Верфь', title: 'Разобрать «' + s.name + '»?',
      image: s.image ? '../' + s.image : null,
      sub: 'Корабль уйдёт с орбиты насовсем',
      note: parts.length ? 'На склад планеты: ' + parts.join(', ') + '. Что не влезет в склад — пропадёт.' : 'Сырья с этой модели не вернуть.',
      ok: 'Разобрать', cancel: 'Оставить'
    }, go);
  });
  return b;
}

function makeDockCard(s, box) {
  var card = document.createElement('div');
  card.className = 'dock-card';

  var pct = s.full_hp ? Math.max(0, Math.min(100, s.hp / s.full_hp * 100)) : 100;

  var head = document.createElement('div');
  head.className = 'dock-top';
  head.innerHTML =
    '<div class="dock-face">' +
      (s.image ? '<img src="../' + s.image + '" alt="">' : '') +
    '</div>' +
    '<div class="dock-info">' +
      '<div class="dock-name">' + sxEsc(s.name) + '</div>' +
      '<div class="dock-hp">' +
        '<span>' + s.hp + ' / ' + s.full_hp + '</span>' +
        '<div class="dock-track"><i style="width:' + pct + '%"></i></div>' +
      '</div>' +
      '<div class="dock-sub">Ангар: ' + s.hangar_used + ' из ' + s.hangar_max + '</div>' +
    '</div>';
  card.appendChild(head);

  // Трофей абордажа: дебафы до ремонта, разборка на сырьё
  var row = typeof sxShipById === 'function' ? sxShipById(s.ship_id) : null;
  var trophy = !!(row && row.trophy);
  var stype = shipTypeById[s.ship_type] || null;
  var foreign = !!(row && stype && stype.faction && stype.faction !== row.faction);
  if (trophy) {
    var left = row.jump_lock_until ? new Date(row.jump_lock_until).getTime() - sbNow() : 0;
    var tn = document.createElement('div');
    tn.className = 'dock-trophy';
    tn.innerHTML = '<b>Трофей</b><span>Щиты выключены, ход и урон вдвое ниже' +
      (left > 0 ? ', прыжки закрыты ещё ' + Math.ceil(left / 3600000) + ' ч' : '') +
      '. Ремонт снимет всё это' + (foreign ? '; улучшать чужую модель нельзя' : '') + '.</span>';
    card.appendChild(tn);
  }

  // Корабль не у причала или уже в работе — показываем причину
  // и ничего не предлагаем, вместо отказа после нажатия
  if (s.busy || !s.at_dock || syBusyLeft() > 0) {
    var lock = document.createElement('div');
    lock.className = 'dock-lock';
    lock.textContent = s.busy
      ? 'Уже в работе'
      : !s.at_dock ? 'Подведи корабль к станции — док работает только у причала'
      : 'Стапель занят — док освободится через ' + syLeftText(syBusyLeft());
    card.appendChild(lock);
    // Разборке стапель не нужен — её можно и пока он занят
    if (trophy && s.at_dock && !s.busy) card.appendChild(makeScrapButton(s, stype));
    return card;
  }

  // Док и стапель — одна очередь: после заказа перечитываем верфь целиком,
  // иначе кнопки постройки остались бы активными до отказа сервера
  var refresh = function() { openShipyard(true); };

  // --- ремонт корпуса ---
  var fix = document.createElement('button');
  fix.className = 'dock-go';
  if (s.missing > 0 || (trophy && s.repair_cost > 0)) {
    fix.textContent = (trophy ? 'Ремонт трофея · ' : 'Починить · ') + s.repair_cost + ' · ' + formatDockLeft(s.repair_seconds);
    fix.addEventListener('click', function() {
      fix.disabled = true;
      supabase.rpc('start_ship_repair', { p_ship_id: s.ship_id }).then(function(r) {
        fix.disabled = false;
        if (r.error) { alert('Не вышло: ' + r.error.message); return; }
        refresh();
      });
    });
  } else {
    fix.textContent = 'Корпус цел';
    fix.disabled = true;
  }
  card.appendChild(fix);

  // Разборка трофея на сырьё
  if (trophy) card.appendChild(makeScrapButton(s, stype));

  // --- модернизация: только изученное, подходящее и ещё не стоящее ---
  // Трофей чужой фракции не улучшают
  var installed = s.upgrades || [];
  var mine = foreign ? [] : shipyardUpgrades.filter(function(r) {
    return (r.applies_to || []).indexOf(s.ship_type) !== -1
        && installed.indexOf(r.id) === -1;
  });

  if (mine.length) {
    var chosen = {};

    var up = document.createElement('div');
    up.className = 'ship-addon';
    up.innerHTML = '<div class="ship-addon-head">Модернизация · доступно ' + mine.length + '</div>';

    var grid = document.createElement('div');
    grid.className = 'ship-up-grid';

    var sub = document.createElement('div');
    sub.className = 'ship-addon-sub';

    var go = document.createElement('button');
    go.className = 'dock-go';

    var recount = function() {
      var ids = Object.keys(chosen), sum = 0;
      ids.forEach(function(k) { sum += Math.floor(chosen[k].cost / 4); });
      sub.textContent = ids.length
        ? 'Выбрано ' + ids.length + ' · ' + sum + ' кредитов'
        : 'Ничего не выбрано';
      go.textContent = 'Установить · ' + sum;
      go.disabled = ids.length === 0;
    };

    mine.forEach(function(r) {
      var t = document.createElement('button');
      t.className = 'ship-up';
      t.innerHTML = '<img src="../' + r.icon_image + '" alt="">' +
                    '<span>' + r.name + '</span>';
      t.title = (typeof bsResearchText === 'function' && bsResearchText(r)) || r.description || '';
      t.addEventListener('click', function() {
        if (chosen[r.id]) delete chosen[r.id]; else chosen[r.id] = r;
        t.classList.toggle('active', !!chosen[r.id]);
        recount();
      });
      grid.appendChild(t);
    });

    go.addEventListener('click', function() {
      go.disabled = true;
      supabase.rpc('start_ship_refit', {
        p_ship_id: s.ship_id,
        p_upgrades: Object.keys(chosen)
      }).then(function(r) {
        go.disabled = false;
        if (r.error) { alert('Не вышло: ' + r.error.message); return; }
        refresh();
      });
    });

    up.appendChild(grid);
    up.appendChild(sub);
    up.appendChild(go);
    card.appendChild(up);
    recount();
  }

  // --- пополнение ангара ---
  var free = Math.max(0, s.hangar_max - s.hangar_used);
  if (free > 0 && (hangarTypes.fighter || hangarTypes.bomber)) {
    var pick = { fighter: 0, bomber: 0 };

    var han = document.createElement('div');
    han.className = 'ship-addon';
    han.innerHTML = '<div class="ship-addon-head">Ангар · свободно ' + free + '</div>';

    var hsub = document.createElement('div');
    hsub.className = 'ship-addon-sub';

    var hgo = document.createElement('button');
    hgo.className = 'dock-go';

    var rows = {};

    var hcount = function() {
      var total = pick.fighter + pick.bomber;
      var sum = pick.fighter * ((hangarTypes.fighter && hangarTypes.fighter.cost) || 0)
              + pick.bomber * ((hangarTypes.bomber && hangarTypes.bomber.cost) || 0);

      hsub.textContent = total
        ? 'Займут ' + total + ' из ' + free + ' мест'
        : 'Ничего не выбрано';
      hgo.textContent = 'Пополнить · ' + sum;
      hgo.disabled = total === 0;

      // Гасим то, что уже не влезет: правило видно до нажатия
      ['fighter', 'bomber'].forEach(function(kind) {
        if (!rows[kind]) return;
        var other = kind === 'fighter' ? pick.bomber : pick.fighter;
        var all = rows[kind].querySelectorAll('.ship-addon-btn');
        for (var i = 0; i < all.length; i++) {
          var n = parseInt(all[i].textContent, 10);
          all[i].disabled = (n + other) > free;
          all[i].classList.toggle('active', n === pick[kind]);
        }
      });
    };

    var addRow = function(kind, label, t) {
      if (!t) return;
      var line = document.createElement('div');
      line.className = 'ship-addon-line';
      line.innerHTML = '<span>' + label + '</span><em>' + t.cost + ' кр</em>';
      han.appendChild(line);

      var row = document.createElement('div');
      row.className = 'ship-addon-row';
      rows[kind] = row;

      for (var i = 0; i <= free; i++) {
        (function(n) {
          var b = document.createElement('button');
          b.className = 'ship-addon-btn' + (n === 0 ? ' active' : '');
          b.textContent = n;
          b.addEventListener('click', function() {
            if (b.disabled) return;
            pick[kind] = n;
            hcount();
          });
          row.appendChild(b);
        })(i);
      }
      han.appendChild(row);
    };

    addRow('fighter', 'Истребители', hangarTypes.fighter);
    addRow('bomber', 'Бомбардировщики', hangarTypes.bomber);

    hgo.addEventListener('click', function() {
      hgo.disabled = true;
      supabase.rpc('start_hangar_restock', {
        p_ship_id: s.ship_id,
        p_fighters: pick.fighter,
        p_bombers: pick.bomber
      }).then(function(r) {
        hgo.disabled = false;
        if (r.error) { alert('Не вышло: ' + r.error.message); return; }
        refresh();
      });
    });

    han.appendChild(hsub);
    han.appendChild(hgo);
    card.appendChild(han);
    hcount();
  }

  return card;
}

function formatDockLeft(sec) {
  if (sec >= 60) return Math.floor(sec / 60) + ' мин ' + (sec % 60) + ' с';
  return sec + ' с';
}

function closeShipyard() {
  document.getElementById('shipyard-panel').style.display = 'none';
  var host = document.getElementById('shipyard-lease');
  if (host && typeof plStopTick === 'function') plStopTick(host);
}

function spPaintShipyardLease(list) {
  if (typeof plRenderBanner !== 'function') return;
  var host = document.createElement('div');
  host.id = 'shipyard-lease';
  list.insertBefore(host, list.firstChild);

  var fac = (stationRecord && stationRecord.faction) || sysFaction;
  var ok = stationRecord && !(stationRecord.completes_at &&
    new Date(stationRecord.completes_at).getTime() > sbNow()) &&
    !(sysFaction && stationRecord.faction && stationRecord.faction !== sysFaction);

  var paint = function(row) {
    plRenderBanner(host, row, {
      kind: 'station',
      canOffer: isController && !!ok,
      offer: { systemId: systemId, buildingId: null, name: 'Верфь',
               image: (typeof STATION_IMAGES !== 'undefined' && STATION_IMAGES[fac]) || null,
               planetName: plPlanetName() },
      onEnd: function() {
        // Срок вышел у арендатора: верфь вернулась хозяину — закрываем,
        // чтобы не заказывать впустую. Хозяину просто перерисовываем
        var panel = document.getElementById('shipyard-panel');
        if (!panel || panel.style.display === 'none' || !document.body.contains(host)) return;
        if (row && row.role === 'lessee') {
          closeShipyard();
          spLoadLeases();
          if (typeof plToast === 'function') plToast('Аренда верфи закончилась');
        } else {
          spLoadLeases().then(function() { if (document.body.contains(host)) paint(spStationLease()); });
        }
      },
      onChanged: function() {
        spLoadLeases().then(function() { if (document.body.contains(host)) paint(spStationLease()); });
      }
    });
  };

  paint(spStationLease());
  spLoadLeases().then(function() {
    if (!document.body.contains(host)) return;
    paint(spStationLease());
  });
}

// Цены машин ангара берём из базы, чтобы карточка не врала после
// правок баланса
var hangarTypes = { fighter: null, bomber: null };
var shipyardHangarSeconds = 20;

// Что игрок изучил: только это можно ставить на корабль
var shipyardUpgrades = [];

function loadFighterInfo() {
  supabase.rpc('get_researches').then(function(res) {
    if (!res.error && res.data) {
      shipyardUpgrades = res.data.filter(function(r) { return r.done; });
    }
  });

  Promise.all([
    supabase.from('ship_types').select('id, name, cost, hull_class, damage, max_hp')
      .eq('is_fighter', true),
    supabase.from('game_settings').select('value')
      .eq('key', 'fighter_build_seconds').maybeSingle()
  ]).then(function(r) {
    if (!r[0].error && r[0].data) {
      r[0].data.forEach(function(t) {
        if (t.hull_class === 'bomber') hangarTypes.bomber = t;
        else hangarTypes.fighter = t;
      });
    }
    if (!r[1].error && r[1].data) shipyardHangarSeconds = parseInt(r[1].data.value, 10) || 20;
  });
}

function makeShipCard(type) {
  var card = document.createElement('div');
  card.className = 'ship-card';

  var media = document.createElement('div');
  media.className = 'ship-card-media';
  if (type.image) {
    var im = document.createElement('img');
    im.src = '../' + type.image;
    media.appendChild(im);
  }
  card.appendChild(media);

  var body = document.createElement('div');
  body.className = 'ship-card-body';

  var name = document.createElement('div');
  name.className = 'ship-card-name';
  name.textContent = type.name;
  body.appendChild(name);

  if (type.description) {
    var d = document.createElement('div');
    d.className = 'ship-card-desc';
    d.textContent = type.description;
    body.appendChild(d);
  }

  var stats = document.createElement('div');
  stats.className = 'ship-card-stats';
  stats.innerHTML =
    '<div><span>Прочность</span><b>' + type.max_hp + '</b></div>' +
    '<div><span>Щит сектора</span><b>' + (type.max_shield || 0) + '</b></div>' +
    '<div><span>Урон</span><b>' + type.damage + '</b></div>' +
    '<div><span>Скорость</span><b>' + spSpeed(type, 0) + '</b></div>' +
    '<div><span>Датчики</span><b data-sens>…</b></div>' +
    '<div><span>Трюм</span><b>' + type.capacity + '</b></div>';
  spSensFill(stats.querySelector('[data-sens]'), type.id, 0);
  body.appendChild(stats);

  // Сырьё со склада планеты: нехватку видно сразу
  var shortRes = syResourceLine(type.cost_resources, body);

  // Ангар собирают на стапеле, пристегнуть его потом нельзя. Истребители
  // и бомбардировщики делят одни и те же места, поэтому выбор состава —
  // это выбор между прикрытием и ударной силой.
  var pick = { fighter: 0, bomber: 0 };
  var chosen = {};
  var slots = type.hangar_slots || 0;
  var priceEl, upSub = null, hangHead = null;
  var rows = {};
  // «Расширенный ангар» из дополнений поднимает предел: кнопки — до самого большого возможного числа мест,
  // лишние гаснут, пока дополнение не выбрано
  var hangarMax = slots;
  shipyardUpgrades.forEach(function(r) {
    if ((r.applies_to || []).indexOf(type.id) !== -1 && r.effect_kind === 'hangar') hangarMax += r.effect_value || 0;
  });

  var btn = document.createElement('button');
  btn.className = 'ship-order-btn';

  var upgradeCost = function() {
    var sum = 0;
    for (var k in chosen) sum += Math.floor(chosen[k].cost / 4);
    return sum;
  };

  var upgradeCount = function() {
    var n = 0;
    for (var k in chosen) n++;
    return n;
  };

  var extraCost = function() {
    return pick.fighter * ((hangarTypes.fighter && hangarTypes.fighter.cost) || 0)
         + pick.bomber  * ((hangarTypes.bomber  && hangarTypes.bomber.cost)  || 0)
         + upgradeCost();
  };

  var updatePrice = function() {
    btn.textContent = 'Построить · ' + (type.cost + extraCost());
    // Заведомый отказ не шлём: стапель занят или сырья не хватает
    if (syBusyLeft() > 0) {
      btn.disabled = true;
      btn.textContent = 'Стапель занят';
    } else if (shortRes.length) {
      btn.disabled = true;
      btn.textContent = 'Не хватает: ' + shortRes.join(', ');
    }

    // Расширенный ангар добавляет места ещё до постройки: иначе игрок
    // не понял бы, почему третий истребитель вдруг влезает
    var bonusSlots = 0;
    for (var k in chosen) {
      if (chosen[k].effect_kind === 'hangar') bonusSlots += chosen[k].effect_value;
    }
    slots = (type.hangar_slots || 0) + bonusSlots;
    // сняли «Расширенный ангар» — выбранные машины не должны остаться сверх мест
    while (pick.fighter + pick.bomber > slots) { if (pick.bomber > 0) pick.bomber--; else pick.fighter--; }

    if (hangHead) hangHead.textContent = 'Ангар · мест ' + slots;
    // строка своей карточки (раньше искалась по общему id и уходила в карточку другого корабля)
    if (upSub) {
      upSub.textContent = upgradeCount() === 0
        ? 'Дополнения не выбраны'
        : 'Выбрано ' + upgradeCount() + ' · +' + upgradeCost() +
          ' кредитов и +' + (upgradeCount() * 10) + ' с к сроку';
    }

    if (!priceEl) return;

    var total = pick.fighter + pick.bomber;
    priceEl.textContent = total === 0
      ? 'Ангар пуст · свободно ' + slots
      : 'Занято ' + total + ' из ' + slots + ' · +' + extraCost() +
        ' кредитов и +' + (total * shipyardHangarSeconds) + ' с к сроку';

    // Кнопки, которые не влезут в оставшиеся места, гасим — так правило
    // видно до нажатия, а не в отказе сервера
    ['fighter','bomber'].forEach(function(kind) {
      if (!rows[kind]) return;
      var other = kind === 'fighter' ? pick.bomber : pick.fighter;
      var all = rows[kind].querySelectorAll('.ship-addon-btn');
      for (var i = 0; i < all.length; i++) {
        var n = parseInt(all[i].textContent, 10);
        all[i].disabled = (n + other) > slots;
        all[i].classList.toggle('active', n === pick[kind]);
      }
    });
  };

  var makeRow = function(kind, label, t) {
    if (!t) return;

    var head = document.createElement('div');
    head.className = 'ship-addon-line';
    head.innerHTML = '<span>' + label + '</span>' +
      '<em>' + t.cost + ' кр · урон ' + t.damage + ' · прочность ' + t.max_hp + '</em>';
    addon.appendChild(head);

    var row = document.createElement('div');
    row.className = 'ship-addon-row';
    rows[kind] = row;

    for (var i = 0; i <= hangarMax; i++) {
      (function(n) {
        var b = document.createElement('button');
        b.className = 'ship-addon-btn' + (n === 0 ? ' active' : '');
        b.textContent = n;
        b.addEventListener('click', function() {
          if (b.disabled) return;
          pick[kind] = n;
          updatePrice();
        });
        row.appendChild(b);
      })(i);
    }

    addon.appendChild(row);
  };

  var addon;

  if (hangarMax > 0) {
    addon = document.createElement('div');
    addon.className = 'ship-addon';

    hangHead = document.createElement('div');
    hangHead.className = 'ship-addon-head';
    hangHead.textContent = 'Ангар · мест ' + slots;
    addon.appendChild(hangHead);

    makeRow('fighter', 'Истребители', hangarTypes.fighter);
    makeRow('bomber', 'Бомбардировщики', hangarTypes.bomber);

    priceEl = document.createElement('div');
    priceEl.className = 'ship-addon-sub';
    addon.appendChild(priceEl);

    body.appendChild(addon);
  }

  // Дополнения ставятся из изученного. Каждое стоит четверть цены
  // исследования и добавляет десять секунд к сроку: право ставить
  // не значит бесплатную установку.
  // Показываем только то, что подходит этому кораблю: ветки принадлежат
  // конкретным классам, и чужие дополнения здесь только мешали бы
  var mineUpgrades = shipyardUpgrades.filter(function(r) {
    return (r.applies_to || []).indexOf(type.id) !== -1;
  });

  if (mineUpgrades.length) {
    var up = document.createElement('div');
    up.className = 'ship-addon';

    var uhead = document.createElement('div');
    uhead.className = 'ship-addon-head';
    uhead.textContent = 'Дополнения · доступно ' + mineUpgrades.length;
    up.appendChild(uhead);

    // Имя upGrid, а не grid: локальная grid перекрывала бы глобальную
    // ссылку на саму космическую карту внутри всей этой функции
    var upGrid = document.createElement('div');
    upGrid.className = 'ship-up-grid';

    mineUpgrades.forEach(function(r) {
      var t = document.createElement('button');
      t.className = 'ship-up';
      t.innerHTML = '<img src="../' + r.icon_image + '" alt="">' +
        '<span>' + r.name + '</span>';
      t.title = (typeof bsResearchText === 'function' && bsResearchText(r)) || r.description || '';

      t.addEventListener('click', function() {
        if (chosen[r.id]) delete chosen[r.id];
        else chosen[r.id] = r;
        t.classList.toggle('active', !!chosen[r.id]);
        updatePrice();
      });

      upGrid.appendChild(t);
    });

    up.appendChild(upGrid);

    upSub = document.createElement('div');
    upSub.className = 'ship-addon-sub';
    up.appendChild(upSub);

    body.appendChild(up);
  }

  btn.addEventListener('click', function() {
    btn.disabled = true;
    supabase.rpc('order_ship', {
      p_system_id: systemId, p_ship_type: type.id,
      p_fighters: pick.fighter, p_bombers: pick.bomber,
      p_upgrades: Object.keys(chosen)
    }).then(function(res) {
        btn.disabled = false;
        if (res.error) { alert(res.error.message); return; }
        closeShipyard();
        loadShipOrders();
      });
  });

  updatePrice();
  body.appendChild(btn);

  card.appendChild(body);
  return card;
}

function loadShipOrders() {
  supabase.from('ship_orders').select('*, ship_types(name)')
    .eq('system_id', systemId).eq('delivered', false)
    .then(function(res) {
      var bar = document.getElementById('ship-queue');
      if (!bar) return;
      if (res.error || !res.data || res.data.length === 0) {
        bar.style.display = 'none';
        return;
      }
      bar.innerHTML = '';
      bar.style.display = 'flex';
      res.data.forEach(function(o) {
        var left = Math.max(0, Math.ceil((new Date(o.completes_at).getTime() - sbNow()) / 1000));
        var chip = document.createElement('div');
        chip.className = 'order-chip';
        chip.textContent = (o.ship_types ? o.ship_types.name : o.ship_type) + ' · ' + left + 'с';
        bar.appendChild(chip);
      });
    });
}

// Кнопка «Строительство» управляющего системой: на орбите строят одну станцию —
// камера летит к месту под неё, место подсвечивается, открывается панель станции
// (заложить, верфь, снос). Без перезагрузки: бой и выбранный корабль остаются как были.
function initBuildToggle() {
  if (!isController || document.getElementById('build-toggle')) return;

  var btn = document.createElement('button');
  btn.id = 'build-toggle';
  btn.textContent = 'Строительство';
  document.body.appendChild(btn);

  btn.addEventListener('click', function() {
    var S = window.__sp;
    if (!stationSlot) {
      if (S && S.toast) S.toast('В этой системе нет места под станцию', 'bad');
      return;
    }
    // место берём у боя (оно пришло с сервера), пока бой не загружен — из базы
    if (!(S && S.focusSlot && S.focusSlot())) focusCell(stationSlot.x + STATION_SIZE / 2 - 0.5, stationSlot.y + STATION_SIZE / 2 - 0.5);
    clearTimeout(btn._open);
    btn._open = setTimeout(onStationSlotTapped, 550);   // панель — когда камера почти долетела
  });
}

// ===== Открытый космос =====
// Точка на гиперпути: ни планеты, ни станции, ни площадок сброса.
// Помечаем это явно, иначе пустая сетка выглядит поломкой.

var isDeepSpace = false;

function markDeepSpace(name) {
  document.body.classList.add('deep-space');

  var old = document.getElementById('deep-space-mark');
  if (old) old.remove();

  var el = document.createElement('div');
  el.id = 'deep-space-mark';
  el.innerHTML = '<b>Открытый космос</b>' +
                 '<span>' + (name || 'Точка на гиперпути') + '</span>' +
                 '<i>Ни планеты, ни станции. Только то, что привели с собой.</i>';
  document.body.appendChild(el);
}
