// Экран «Армия»: сводка сверху и три вкладки.
//   Флот     — командиры с их кораблями (корпус, трюм, ангар, перелёт со сроком прибытия),
//              ниже корабли без командира по планетам;
//   Войска   — бойцы на поверхности по планетам: сколько, кто, насколько потрёпаны;
//   Союзники — передача войск, входящие, аренда производства (кнопки строят
//              js/troop-transfer.js и js/production-lease.js).
// Корабль раскрывается и показывает трюм, там же «Заполнить трюм» (js/ship-cargo.js).
// Для обучения (js/quest.js) у корабля остаются .ship-block[data-ship-id], .ship-header
// и .ship-manage-btn. Снаружи зовут loadArmyData() — перерисовать после погрузки и передач.

var armyTicker = null;           // срок прибытия командиров и значок «Союзники», пока экран открыт
var armySeq = 0;                 // номер загрузки: поздний ответ не рисует поверх свежего
var armyOpenShips = {};          // какие корабли раскрыты — переживает перерисовку
var armyOpenGroups = {};         // какие группы кораблей без командира раскрыты

function openArmyScreen() {
  var scr = document.getElementById('army-screen');
  scr.style.display = 'block';
  armySetTab('fleet');
  loadArmyData();
  if (typeof questSeen === 'function') questSeen('army');
  if (armyTicker) clearInterval(armyTicker);
  armyTicker = setInterval(armyTick, 1000);
  armyTick();
}

// Рейс снабжения запущен поверх «Армии» (кнопка «Отвезти рейсом») — флот под окном перечитываем
document.addEventListener('supply-routes-changed', function() {
  var scr = document.getElementById('army-screen');
  if (scr && scr.style.display !== 'none' && scr.style.display !== '') loadArmyData();
});

function closeArmyScreen() {
  document.getElementById('army-screen').style.display = 'none';
  if (armyTicker) { clearInterval(armyTicker); armyTicker = null; }
}

function armySetTab(tab) {
  var scr = document.getElementById('army-screen');
  if (!scr) return;
  Array.prototype.forEach.call(scr.querySelectorAll('.ar-tab'), function(b) {
    var on = b.getAttribute('data-tab') === tab;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  Array.prototype.forEach.call(scr.querySelectorAll('.ar-pane'), function(p) {
    p.hidden = p.getAttribute('data-tab') !== tab;
  });
  scr.scrollTop = 0;
}

function armyNow() { return typeof svNow === 'function' ? svNow() : Date.now(); }

// Каждую секунду: оставшееся время перелётов и полоска пути; значок входящих на вкладке
function armyTick() {
  var scr = document.getElementById('army-screen');
  if (!scr || scr.style.display === 'none') { if (armyTicker) { clearInterval(armyTicker); armyTicker = null; } return; }
  var now = armyNow();
  Array.prototype.forEach.call(scr.querySelectorAll('[data-eta]'), function(el) {
    var t0 = +el.getAttribute('data-t0'), t1 = +el.getAttribute('data-eta');
    var left = Math.max(0, Math.round((t1 - now) / 1000));
    var txt = el.querySelector('.ar-eta-txt');
    if (txt) txt.textContent = left > 0 ? 'через ' + armyDur(left) : 'прибывает';
    var bar = el.querySelector('.ar-trip-bar i');
    if (bar && t1 > t0) bar.style.width = Math.max(0, Math.min(100, (now - t0) / (t1 - t0) * 100)) + '%';
  });
  var n = (typeof trPendingTransfers === 'number' ? trPendingTransfers : 0) +
          (typeof plPendingLeases === 'number' ? plPendingLeases : 0);
  var dot = scr.querySelector('.ar-tab[data-tab="allies"] .ar-tab-badge');
  if (dot) { dot.textContent = n > 9 ? '9+' : String(n); dot.hidden = !(n > 0); }
}

function armyDur(sec) {
  var h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
  if (h) return h + ' ч ' + (m < 10 ? '0' : '') + m + ' мин';
  return m + ':' + (s < 10 ? '0' : '') + s;
}

function armyNum(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' '); }

// окончания: 1 корабль, 2 корабля, 5 кораблей
function armyPlural(n, one, few, many) {
  var a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

// Цвет полоски здоровья — как у бойцов на поле: зелёный, золото, красный
function armyHpClass(k) { return k >= 0.66 ? 'ok' : k >= 0.33 ? 'mid' : 'low'; }

function armyGlobe(sys, big) {
  var tex = sys && sys.texture ? ' style="background-image:url(\'../' + armyEsc(sys.texture) + '\')"' : '';
  return '<i class="ar-globe' + (big ? ' big' : '') + '"' + tex + '></i>';
}

function loadArmyData() {
  var seq = ++armySeq;
  supabase.auth.getSession().then(function(res) {
    if (!res.data.session) return;
    var userId = res.data.session.user.id;
    Promise.all([
      supabase.from('commanders').select('*').eq('user_id', userId).order('slot_index'),
      supabase.from('systems').select('id, name, texture, faction').eq('is_deep_space', false),
      // Истребители в ангаре не стоят в системе сами по себе — их считаем отдельно, по носителю
      supabase.from('ships')
        .select('*, ship_types(name, image, capacity, is_fighter, hangar_slots, max_hp)')
        .eq('owner_user_id', userId).is('carrier_ship_id', null),
      // Трюм: пехота счётчиком, техника и герои — строками (с десантом внутри)
      supabase.rpc('get_ship_holds'),
      // Ресурсы лежат в том же трюме, что и десант
      supabase.from('ship_resource_cargo').select('ship_id, resource, amount'),
      supabase.from('resources').select('id, name, color, sort_order'),
      supabase.from('game_settings').select('value').eq('key', 'cargo_units_per_slot').maybeSingle(),
      // Бойцы на поверхности: у сидящих в транспорте и в трюме координат нет
      supabase.from('unit_positions').select('system_id, unit_type, hp')
        .eq('owner_user_id', userId).not('x', 'is', null),
      supabase.from('unit_types').select('id, name, image, max_hp, is_vehicle, is_hero'),
      // Истребители в ангарах — сколько у какого носителя
      supabase.from('ships').select('carrier_ship_id')
        .eq('owner_user_id', userId).not('carrier_ship_id', 'is', null),
      // Кто из командиров на рейсе снабжения: у них груз в трюме — по делу
      supabase.rpc('get_supply_commanders')
    ]).then(function(r) {
      if (seq !== armySeq) return;
      armyRender(armyModel(r));
    }, function() {
      if (seq !== armySeq) return;
      var l = document.getElementById('army-commanders-list');
      if (l) l.innerHTML = '<div class="ar-empty">Не удалось загрузить — нет связи с сервером</div>';
    });
  });
}

// Сырые ответы базы → то, что рисуем
function armyModel(r) {
  var M = { sys: {}, commanders: [], ships: [], holds: {}, goods: {}, hangar: {}, units: {}, types: {}, holdUnits: 0 };
  (r[1].data || []).forEach(function(s) { M.sys[s.id] = s; });
  (r[8].data || []).forEach(function(t) { M.types[t.id] = t; });

  var perSlot = (!r[6].error && r[6].data) ? Math.max(1, parseInt(r[6].data.value, 10) || 2) : 2;
  var resById = {};
  (r[5].data || []).forEach(function(x) { resById[x.id] = x; });
  (r[4].data || []).forEach(function(g) {
    if (!(g.amount > 0)) return;
    var rr = resById[g.resource] || {};
    (M.goods[g.ship_id] = M.goods[g.ship_id] || []).push({
      res: g.resource, name: rr.name || g.resource, color: rr.color, sort: rr.sort_order || 0, amount: g.amount,
      slots: Math.ceil(g.amount / perSlot)                  // тот же счёт, что у сервера
    });
  });
  Object.keys(M.goods).forEach(function(k) { M.goods[k].sort(function(a, b) { return a.sort - b.sort; }); });

  (r[3].data || []).forEach(function(c) {
    if (!(c.quantity > 0)) return;
    (M.holds[c.ship_id] = M.holds[c.ship_id] || []).push(c);
    M.holdUnits += c.quantity + (c.passengers || 0);
  });
  (r[9].data || []).forEach(function(f) { M.hangar[f.carrier_ship_id] = (M.hangar[f.carrier_ship_id] || 0) + 1; });
  // null — не узнали (нет связи): тогда о грузе не предупреждаем, чтобы не пугать зря
  M.supplyBusy = r[10] && !r[10].error ? {} : null;
  if (M.supplyBusy) (r[10].data || []).forEach(function(c) { M.supplyBusy[c.commander_id] = c.busy || ''; });

  M.ships = (r[2].error ? [] : (r[2].data || [])).map(function(sh) {
    var T = sh.ship_types || {};
    var cargo = M.holds[sh.id] || [], goods = M.goods[sh.id] || [];
    var used = cargo.reduce(function(a, c) { return a + (c.slots || c.quantity); }, 0) +
               goods.reduce(function(a, g) { return a + g.slots; }, 0);
    var hpMax = (T.max_hp || 0) + (sh.bonus_hp || 0);
    return {
      raw: sh, T: T, cargo: cargo, goods: goods, used: used,
      cap: (T.capacity || 0) + (sh.bonus_capacity || 0),
      hangarCap: (T.hangar_slots || 0) + (sh.bonus_hangar || 0), hangar: M.hangar[sh.id] || 0,
      hp: sh.hp, hpMax: hpMax, hpK: hpMax > 0 ? Math.max(0, Math.min(1, sh.hp / hpMax)) : 1,
      troops: cargo.reduce(function(a, c) { return a + (c.is_vehicle ? 1 + (c.passengers || 0) : c.quantity); }, 0)
    };
  });
  M.commanders = r[0].error ? [] : (r[0].data || []);

  (r[7].data || []).forEach(function(u) {
    var p = M.units[u.system_id] = M.units[u.system_id] || { by: {}, n: 0, hp: 0, hpMax: 0, veh: 0 };
    var t = M.types[u.unit_type] || {}, mx = t.max_hp || u.hp || 1;
    var g = p.by[u.unit_type] = p.by[u.unit_type] || { n: 0, hp: 0, hpMax: 0, hurt: 0 };
    g.n++; g.hp += Math.min(u.hp, mx); g.hpMax += mx; if (u.hp < mx) g.hurt++;
    p.n++; p.hp += Math.min(u.hp, mx); p.hpMax += mx; if (t.is_vehicle) p.veh++;
  });
  return M;
}

function armyRender(M) {
  armyRenderStats(M);
  armyRenderFleet(M);
  armyRenderTroops(M);
  armyTick();
}

// ---- сводка
function armyRenderStats(M) {
  var box = document.getElementById('ar-stats'); if (!box) return;
  var open = M.commanders.filter(function(c) { return c.unlocked; }).length;
  var fighters = Object.keys(M.hangar).reduce(function(a, k) { return a + M.hangar[k]; }, 0);
  var troops = Object.keys(M.units).reduce(function(a, k) { return a + M.units[k].n; }, 0);
  var planets = Object.keys(M.units).length;
  var hp = 0, hpMax = 0, hurt = 0;
  M.ships.forEach(function(s) { hp += Math.min(s.hp, s.hpMax); hpMax += s.hpMax; if (s.hpK < 0.999) hurt++; });
  var hull = hpMax ? Math.round(hp / hpMax * 100) : 100;
  box.innerHTML =
    armyStat('Командиры', open + '<small>/' + M.commanders.length + '</small>', open ? 'в строю' : 'нет в строю') +
    armyStat('Корабли', M.ships.length, fighters ? '+' + fighters + ' истреб.' : 'без истребителей') +
    armyStat('Войска', armyNum(troops + M.holdUnits),
             planets ? planets + ' ' + armyPlural(planets, 'планета', 'планеты', 'планет') : (M.holdUnits ? 'все в трюмах' : 'не нанято')) +
    (M.ships.length
      ? armyStat('Корпус', hull + '<small>%</small>', hurt ? hurt + ' ' + armyPlural(hurt, 'побит', 'побиты', 'побиты') : 'все целы', armyHpClass(hull / 100))
      : armyStat('Корпус', '—', 'кораблей нет'));
  var tf = document.querySelector('#army-screen .ar-tab[data-tab="fleet"] em');
  if (tf) tf.textContent = M.ships.length;
  var tt = document.querySelector('#army-screen .ar-tab[data-tab="troops"] em');
  if (tt) tt.textContent = troops;
}

function armyStat(label, val, sub, tone) {
  return '<div class="ar-stat' + (tone ? ' ' + tone : '') + '"><span>' + label + '</span><b>' + val + '</b><em>' + armyEsc(sub) + '</em></div>';
}

// ---- флот
function armyRenderFleet(M) {
  var list = document.getElementById('army-commanders-list'); if (!list) return;
  list.innerHTML = '';
  var byCmd = {};
  M.ships.forEach(function(s) { var k = s.raw.commander_id || 'free'; (byCmd[k] = byCmd[k] || []).push(s); });

  var locked = [];
  M.commanders.forEach(function(c) {
    if (!c.unlocked) { locked.push(c); return; }
    list.appendChild(armyCommanderCard(c, byCmd[c.id] || [], M));
  });
  if (locked.length) {
    var lk = document.createElement('div');
    lk.className = 'ar-locked';
    lk.innerHTML = '<span class="ar-locks">' + locked.map(function(c) { return '<i>' + c.slot_index + '</i>'; }).join('') + '</span>' +
      '<span>Ещё ' + locked.length + ' ' + armyPlural(locked.length, 'место командира закрыто', 'места командиров закрыты', 'мест командиров закрыто') + '</span>';
    list.appendChild(lk);
  }
  if (!M.commanders.length) list.insertAdjacentHTML('beforeend', '<div class="ar-empty">Командиров пока нет</div>');

  // Корабли без командира — по планетам: здесь они стоят гарнизоном
  var free = byCmd.free || [];
  if (free.length) {
    var head = document.createElement('div');
    head.className = 'ar-sec';
    head.innerHTML = '<span>Без командира</span><em>' + free.length + ' ' + armyPlural(free.length, 'корабль', 'корабля', 'кораблей') + ' стоят гарнизоном</em>';
    list.appendChild(head);
    var bySys = {};
    free.forEach(function(s) { var k = s.raw.in_transit ? '~transit' : s.raw.system_id; (bySys[k] = bySys[k] || []).push(s); });
    var keys = Object.keys(bySys).sort(function(a, b) { return bySys[b].length - bySys[a].length; });
    // немного групп — раскрыты сразу (и обучению видно нужный корабль), много — только самая большая
    keys.forEach(function(k, i) { list.appendChild(armyShipGroup(k, bySys[k], M, keys.length <= 3 || i === 0)); });
  }
}

function armyCommanderCard(c, ships, M) {
  var card = document.createElement('div');
  card.className = 'ar-cmd' + (c.moving_to ? ' moving' : '');
  var here = M.sys[c.current_system], to = M.sys[c.moving_to];

  var status;
  if (c.moving_to) status = '<b class="go">В пути</b> → ' + armyEsc(to ? to.name : c.moving_to);
  else status = here ? armyGlobe(here) + armyEsc(here.name) : 'вне системы';

  var troops = ships.reduce(function(a, s) { return a + s.troops; }, 0);
  var used = 0, cap = 0, hp = 0, hpMax = 0;
  ships.forEach(function(s) { if (!s.T.is_fighter) { used += s.used; cap += s.cap; } hp += Math.min(s.hp, s.hpMax); hpMax += s.hpMax; });
  var hull = hpMax ? Math.round(hp / hpMax * 100) : 0;

  card.innerHTML =
    '<div class="ar-cmd-head">' +
      '<div class="ar-medal"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 9l7-4 7 4M5 14l7-4 7 4M5 19l7-4 7 4"/></svg><b>' + c.slot_index + '</b></div>' +
      '<div class="ar-cmd-who">' +
        '<div class="ar-cmd-name">' + armyEsc(c.name) + '</div>' +
        '<div class="ar-cmd-where">' + status + '</div>' +
      '</div>' +
    '</div>';

  // Перелёт: откуда → куда, полоска пути, срок и остаток маршрута
  if (c.moving_to) {
    var t0 = c.departed_at ? new Date(c.departed_at).getTime() : 0, t1 = c.arrives_at ? new Date(c.arrives_at).getTime() : 0;
    var from = M.sys[c.moving_from];
    var trip = document.createElement('div');
    trip.className = 'ar-trip';
    if (t1) { trip.setAttribute('data-eta', t1); trip.setAttribute('data-t0', t0 || t1); }
    trip.innerHTML =
      '<div class="ar-trip-ends">' +
        '<span>' + (from ? armyGlobe(from) + armyEsc(from.name) : '') + '</span>' +
        '<span class="ar-eta-txt">' + (t1 ? '' : 'в пути') + '</span>' +
        '<span>' + (to ? armyEsc(to.name) + armyGlobe(to) : armyEsc(c.moving_to)) + '</span>' +
      '</div>' +
      '<div class="ar-trip-bar"><i></i></div>' +
      (c.route && c.route.length
        ? '<div class="ar-trip-route">далее: ' + c.route.map(function(id) { return '<span>' + armyEsc((M.sys[id] || {}).name || id) + '</span>'; }).join('<i>→</i>') + '</div>'
        : '');
    card.appendChild(trip);

    // Маршрут можно оборвать: командир сядет на ближайшей планете пути
    if (c.route && c.route.length) {
      var stop = document.createElement('button');
      stop.className = 'route-stop-btn ar-stop';
      stop.textContent = 'Остановиться: ' + ((to && to.name) || c.moving_to);
      stop.addEventListener('click', function() {
        stop.disabled = true;
        supabase.rpc('cancel_commander_route', { p_commander_id: c.id }).then(function(res) {
          if (res.error) { stop.disabled = false; alert(typeof gameErr === 'function' ? gameErr(res.error) : res.error.message); return; }
          loadArmyData();
        });
      });
      card.appendChild(stop);
    }
  }

  // Короткая сводка отряда
  if (ships.length) {
    card.insertAdjacentHTML('beforeend',
      '<div class="ar-cmd-sum">' +
        '<span><b>' + ships.length + '</b> ' + armyPlural(ships.length, 'корабль', 'корабля', 'кораблей') + '</span>' +
        '<span class="' + armyHpClass(hull / 100) + '">корпус <b>' + hull + '%</b></span>' +
        (cap ? '<span>трюм <b>' + used + '</b>/' + cap + '</span>' : '') +
        (troops ? '<span>десант <b>' + troops + '</b></span>' : '') +
      '</div>');
    var warn = armyCargoWarn(c, ships, M);
    if (warn) card.appendChild(warn);
    var fl = document.createElement('div');
    fl.className = 'ar-fleet';
    ships.slice().sort(armyShipOrder).forEach(function(s) { fl.appendChild(armyShipRow(s, M, false)); });
    card.appendChild(fl);
  } else {
    card.insertAdjacentHTML('beforeend', '<div class="ar-cmd-empty">Кораблей нет. Назначить командира — на орбите, вкладка «Командир» у корабля.</div>');
  }
  return card;
}

// Груз в трюмах без рейса снабжения (склад назначения был полон и т.п.): напоминание, чтобы
// не увести флот в бой с занятыми трюмами, и два выхода — отвезти рейсом или выбросить
function armyCargoWarn(c, ships, M) {
  if (c.moving_to || !M.supplyBusy || M.supplyBusy[c.id] === 'route') return null;
  var by = {}, order = [], total = 0;
  ships.forEach(function(s) {
    s.goods.forEach(function(g) {
      if (!by[g.res]) { by[g.res] = { res: g.res, name: g.name, color: g.color, sort: g.sort, amount: 0 }; order.push(by[g.res]); }
      by[g.res].amount += g.amount;
      total += g.amount;
    });
  });
  if (total <= 0) return null;
  order.sort(function(a, b) { return a.sort - b.sort; });

  var box = document.createElement('div');
  box.className = 'ar-cargo-warn';
  var canRoute = typeof window.supplyCargoRoute === 'function' && !!c.current_system;
  var canDrop = typeof window.supplyDropCargo === 'function';
  box.innerHTML =
    '<div class="ar-cargo-head"><i></i>В трюмах ' + armyNum(total) + ' ' + armyPlural(total, 'единица', 'единицы', 'единиц') + ' груза</div>' +
    '<div class="ar-cargo-text">Груз занимает место десанта. Выгрузи его на складе с местом — или выбрось, если везти некуда.</div>' +
    '<div class="ar-goods">' + order.map(function(g) {
      return '<span><i style="background:' + armyEsc(g.color || '#8fa8c4') + '"></i>' + armyEsc(g.name) + ' <b>' + armyNum(g.amount) + '</b></span>';
    }).join('') + '</div>' +
    (canRoute || canDrop
      ? '<div class="ar-ship-acts">' +
          (canRoute ? '<button type="button" class="ar-btn warn" data-a="route">Отвезти рейсом</button>' : '') +
          (canDrop ? '<button type="button" class="ar-btn danger" data-a="drop">Выбросить</button>' : '') +
        '</div>'
      : '');

  box.addEventListener('click', function(e) {
    var b = e.target.closest('button[data-a]');
    if (!b || b.disabled) return;
    var old = box.querySelector('.ar-cargo-err');
    if (old) old.parentNode.removeChild(old);
    if (b.getAttribute('data-a') === 'route') {
      var map = {};
      order.forEach(function(g) { map[g.res] = g.amount; });
      window.supplyCargoRoute(c.id, c.current_system, map);
      return;
    }
    var items = order.map(function(g) { return { text: g.name + ' ' + armyNum(g.amount), color: g.color, lost: true }; });
    window.supplyDropCargo(c.id, c.name, items, b, function(n, err) {
      if (err) {
        box.insertAdjacentHTML('beforeend', '<div class="ar-cargo-err">' + armyEsc(err) + '</div>');
        return;
      }
      loadArmyData();
    });
  });
  return box;
}

// Крупные вперёд, потом побитые выше целых — их чинить
function armyShipOrder(a, b) {
  return (b.hpMax - a.hpMax) || (a.hpK - b.hpK);
}

function armyShipGroup(key, ships, M, openByDefault) {
  var sys = M.sys[key], transit = key === '~transit';
  var counts = {};
  ships.forEach(function(s) { var nm = s.T.name || s.raw.ship_type; counts[nm] = (counts[nm] || 0) + 1; });
  var parts = Object.keys(counts).map(function(nm) { return counts[nm] > 1 ? nm + ' ×' + counts[nm] : nm; });
  var hurt = ships.filter(function(s) { return s.hpK < 0.999; }).length;

  var block = document.createElement('div');
  block.className = 'ar-group';
  var open = armyOpenGroups[key] != null ? armyOpenGroups[key] : openByDefault;

  var head = document.createElement('button');
  head.className = 'ar-group-head';
  head.setAttribute('aria-expanded', open ? 'true' : 'false');
  head.innerHTML =
    (transit ? '<i class="ar-globe hyper"></i>' : armyGlobe(sys, true)) +
    '<span class="ar-group-txt"><b>' + armyEsc(transit ? 'В гиперпространстве' : (sys ? sys.name : key)) + '</b>' +
      '<em>' + armyEsc(parts.join(' · ')) + (hurt ? ' · <u>повреждено: ' + hurt + '</u>' : '') + '</em></span>' +
    '<span class="ar-count">' + ships.length + '</span>' +
    '<span class="ar-chev"></span>';
  block.appendChild(head);

  var body = document.createElement('div');
  body.className = 'ar-group-body';
  body.hidden = !open;
  ships.slice().sort(armyShipOrder).forEach(function(s) { body.appendChild(armyShipRow(s, M, true)); });
  if (sys && !transit) {
    var go = document.createElement('a');
    go.className = 'ar-link';
    go.href = 'space-battle.html?system=' + encodeURIComponent(key);
    go.innerHTML = 'На орбиту ' + armyEsc(sys.name) + ' <span>›</span>';
    body.appendChild(go);
  }
  block.appendChild(body);

  head.addEventListener('click', function() {
    var now = body.hidden;
    body.hidden = !now; armyOpenGroups[key] = now;
    head.setAttribute('aria-expanded', now ? 'true' : 'false');
  });
  return block;
}

// Строка корабля: картинка, имя, место, корпус и трюм полосками; раскрывается — трюм и действия
function armyShipRow(s, M, inGroup) {
  var sh = s.raw, T = s.T, id = sh.id;
  var block = document.createElement('div');
  block.className = 'ship-block ar-ship' + (s.hpK < 0.33 ? ' crit' : '');
  block.setAttribute('data-ship-id', id);

  var title = sh.name ? '«' + sh.name + '»' : (T.name || sh.ship_type);
  var place = sh.in_transit ? 'в гиперпространстве' : ((M.sys[sh.system_id] || {}).name || sh.system_id);
  var sub = (sh.name ? (T.name || sh.ship_type) + (inGroup ? '' : ' · ') : '') + (inGroup ? '' : place);
  var hpPct = Math.round(s.hpK * 100);
  var hasHold = !T.is_fighter && s.cap > 0;
  var full = hasHold && s.used >= s.cap;

  var head = document.createElement('button');
  head.className = 'ship-header ar-ship-head';
  head.innerHTML =
    '<span class="ar-ship-img">' + (T.image ? '<img src="../' + armyEsc(T.image) + '" alt="">' : '') + '</span>' +
    '<span class="ar-ship-main">' +
      '<span class="ar-ship-name' + (sh.name ? ' named' : '') + '">' + armyEsc(title) + '</span>' +
      (sub ? '<span class="ar-ship-sub">' + armyEsc(sub) + '</span>' : '') +
      '<span class="ar-bars">' +
        '<span class="ar-bar hp ' + armyHpClass(s.hpK) + '" title="корпус ' + s.hp + ' / ' + s.hpMax + '"><i style="width:' + hpPct + '%"></i></span>' +
        (hasHold ? '<span class="ar-bar hold' + (full ? ' full' : '') + '" title="трюм ' + s.used + ' / ' + s.cap + '"><i style="width:' + Math.min(100, Math.round(s.used / s.cap * 100)) + '%"></i></span>' : '') +
      '</span>' +
    '</span>' +
    '<span class="ar-ship-nums">' +
      '<b class="' + armyHpClass(s.hpK) + '">' + hpPct + '%</b>' +
      (hasHold ? '<em' + (full ? ' class="full"' : '') + '>' + s.used + '/' + s.cap + '</em>' : (T.is_fighter ? '<em>истребитель</em>' : '')) +
      (s.hangarCap ? '<em>✈ ' + s.hangar + '/' + s.hangarCap + '</em>' : '') +
    '</span>' +
    '<span class="ar-chev"></span>';
  block.appendChild(head);

  var body = document.createElement('div');
  body.className = 'garrison-body ar-ship-body';
  var open = !!armyOpenShips[id];
  body.hidden = !open;
  head.setAttribute('aria-expanded', open ? 'true' : 'false');

  body.innerHTML =
    '<div class="ar-ship-facts">' +
      '<span>Корпус <b>' + armyNum(s.hp) + '</b> / ' + armyNum(s.hpMax) + '</span>' +
      (hasHold ? '<span>Трюм <b>' + s.used + '</b> / ' + s.cap + ' мест</span>' : '') +
      (s.hangarCap ? '<span>Ангар <b>' + s.hangar + '</b> / ' + s.hangarCap + '</span>' : '') +
    '</div>';

  if (hasHold) {
    if (!s.cargo.length && !s.goods.length) body.insertAdjacentHTML('beforeend', '<div class="ar-hold-empty">Трюм пуст</div>');
    if (s.cargo.length) {
      var grid = document.createElement('div');
      grid.className = 'ar-units';
      s.cargo.forEach(function(c) {
        grid.appendChild(armyUnitTile({ name: c.unit_name, image: c.unit_image }, c.quantity,
          c.passengers ? '+' + c.passengers + ' внутри' : '', null, c.is_vehicle));
      });
      body.appendChild(grid);
    }
    if (s.goods.length) {
      body.insertAdjacentHTML('beforeend', '<div class="ar-goods">' + s.goods.map(function(g) {
        return '<span><i style="background:' + armyEsc(g.color || '#8fa8c4') + '"></i>' + armyEsc(g.name) + ' <b>' + g.amount + '</b></span>';
      }).join('') + '</div>');
    }
  }

  var acts = document.createElement('div');
  acts.className = 'ar-ship-acts';
  if (hasHold) {
    var manage = document.createElement('button');
    manage.className = 'ship-manage-btn ar-btn gold';
    manage.textContent = 'Заполнить трюм';
    manage.addEventListener('click', function() {
      if (typeof openShipCargo === 'function') openShipCargo(sh, T);
    });
    acts.appendChild(manage);
  }
  if (!sh.in_transit && sh.system_id) {
    var orb = document.createElement('a');
    orb.className = 'ar-btn';
    orb.href = 'space-battle.html?system=' + encodeURIComponent(sh.system_id);
    orb.textContent = 'На орбиту';
    acts.appendChild(orb);
  }
  if (acts.children.length) body.appendChild(acts);
  block.appendChild(body);

  head.addEventListener('click', function() {
    var now = body.hidden;
    body.hidden = !now; armyOpenShips[id] = now;
    head.setAttribute('aria-expanded', now ? 'true' : 'false');
  });
  return block;
}

// ---- войска на планетах
function armyRenderTroops(M) {
  var list = document.getElementById('army-garrisons-list'); if (!list) return;
  var ids = Object.keys(M.units).sort(function(a, b) { return M.units[b].n - M.units[a].n; });
  list.innerHTML = '';
  if (M.holdUnits) {
    list.insertAdjacentHTML('beforeend', '<div class="ar-note">В трюмах кораблей ещё <b>' + M.holdUnits + '</b> — их видно во вкладке «Флот», у корабля.</div>');
  }
  if (!ids.length) {
    list.insertAdjacentHTML('beforeend', '<div class="ar-empty">Войск на планетах пока нет. Бойцов нанимают в казармах на планете.</div>');
    return;
  }
  ids.forEach(function(id) {
    var p = M.units[id], sys = M.sys[id] || { name: id };
    var k = p.hpMax ? p.hp / p.hpMax : 1;
    var inf = p.n - p.veh;
    var card = document.createElement('div');
    card.className = 'ar-planet';
    card.innerHTML =
      '<div class="ar-planet-head">' +
        armyGlobe(sys, true) +
        '<div class="ar-planet-txt">' +
          '<b>' + armyEsc(sys.name) + '</b>' +
          '<em>' + (inf ? inf + ' ' + armyPlural(inf, 'боец', 'бойца', 'бойцов') : '') +
                   (inf && p.veh ? ' · ' : '') + (p.veh ? p.veh + ' ' + armyPlural(p.veh, 'машина', 'машины', 'машин') : '') + '</em>' +
        '</div>' +
        '<div class="ar-planet-hp ' + armyHpClass(k) + '"><b>' + Math.round(k * 100) + '%</b><span><i style="width:' + Math.round(k * 100) + '%"></i></span></div>' +
      '</div>';
    var grid = document.createElement('div');
    grid.className = 'ar-units';
    Object.keys(p.by).sort(function(a, b) {
      var ta = M.types[a] || {}, tb = M.types[b] || {};
      return (tb.is_vehicle ? 1 : 0) - (ta.is_vehicle ? 1 : 0) || p.by[b].n - p.by[a].n;
    }).forEach(function(t) {
      var g = p.by[t], T = M.types[t] || { name: t };
      grid.appendChild(armyUnitTile(T, g.n, g.hurt ? 'ранено ' + g.hurt : '', g.hpMax ? g.hp / g.hpMax : 1, T.is_vehicle));
    });
    card.appendChild(grid);
    var go = document.createElement('a');
    go.className = 'ar-link';
    go.href = 'ground-battle.html?system=' + encodeURIComponent(id);
    go.innerHTML = 'На поверхность <span>›</span>';
    card.appendChild(go);
    list.appendChild(card);
  });
}

// Плитка бойца: портрет (у пехоты — голова и торс крупно), число, кто такой, сколько ранено
function armyUnitTile(T, n, note, hpK, vehicle) {
  var el = document.createElement('div');
  el.className = 'ar-unit' + (vehicle ? ' veh' : '');
  el.innerHTML =
    '<span class="ar-unit-pic">' + (T && T.image ? '<img src="../' + armyEsc(T.image) + '" alt="" loading="lazy">' : '') +
      '<b>×' + n + '</b></span>' +
    '<span class="ar-unit-name">' + armyEsc((T && T.name) || 'Боец') + '</span>' +
    (hpK != null && hpK < 0.999 ? '<span class="ar-bar hp ' + armyHpClass(hpK) + '"><i style="width:' + Math.round(hpK * 100) + '%"></i></span>' : '') +
    (note ? '<span class="ar-unit-note">' + armyEsc(note) + '</span>' : '');
  return el;
}

document.addEventListener('DOMContentLoaded', function() {
  var armyButton = document.getElementById('panel-item-army');
  var closeButton = document.getElementById('army-screen-close');
  if (armyButton) armyButton.addEventListener('click', openArmyScreen);
  if (closeButton) closeButton.addEventListener('click', closeArmyScreen);
  Array.prototype.forEach.call(document.querySelectorAll('#army-screen .ar-tab'), function(b) {
    b.addEventListener('click', function() { armySetTab(b.getAttribute('data-tab')); });
  });
});

function armyEsc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
