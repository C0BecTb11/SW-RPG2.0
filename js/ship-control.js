// Панель своего корабля на орбите: трюм, ангар, описание, командир и имя.
//
// Ход, огонь и щиты ведёт бой в реальном времени (js/space-live.js) —
// здесь только то, что делается вне боя. Время сервера (get_server_time)
// нужно для подписей со сроками: трофей, выход из ремонта.

var scShip = null;         // выбранный корабль
var scType = null;         // его тип
var scTimeOffset = 0;      // серверное время минус локальное, мс
var scJustSelected = false;

// ===== служебное =====

function scServerNow() {
  return Date.now() + scTimeOffset;
}

function scSyncTime() {
  return supabase.rpc('get_server_time').then(function(res) {
    if (!res.error && res.data) {
      scTimeOffset = new Date(res.data).getTime() - Date.now();
    }
  });
}

// Габариты с учётом разворота — та же формула, что в ship_box_w/h на сервере
function scBox(type, facing) {
  return (facing === 90 || facing === 270)
    ? { w: type.height_cells, h: type.width_cells }
    : { w: type.width_cells, h: type.height_cells };
}

// Классы корпуса для подписи: крейсер — между корветом и крупным кораблём
var SC_HULL_NAMES = { corvette: 'Корвет', cruiser: 'Крейсер', capital: 'Крупный корабль' };

// Вместимость своего корабля с улучшениями — как ship_stats на сервере.
// Раньше брали паспорт типа: прокачанный «Провиденс» с шестью
// истребителями внутри показывал «ангар 6 из 3».
function scHangarCap(ship, type) {
  return ((type && type.hangar_slots) || 0) + ((ship && ship.bonus_hangar) || 0);
}

function scCargoCap(ship, type) {
  return ((type && type.capacity) || 0) + ((ship && ship.bonus_capacity) || 0);
}

// ===== HUD =====

function scEnsureHud() {
  var hud = document.getElementById('ship-hud');
  if (hud) return hud;

  hud = document.createElement('div');
  hud.id = 'ship-hud';
  hud.style.display = 'none';
  // Устройство то же, что у наземной панели: портрет сверху, вкладки снизу
  hud.innerHTML =
    '<div class="sc-top">' +
      '<div class="sc-portrait"><img id="sc-portrait-img" alt=""></div>' +
      '<div class="sc-stats">' +
        '<div class="sc-name-row">' +
          '<div class="sc-name" id="sc-name">—</div>' +
          '<button type="button" class="sc-rename" id="sc-rename" aria-label="Имя корабля">✎</button>' +
        '</div>' +
        '<div class="sc-role" id="sc-sub"></div>' +
        '<div class="sc-rename-box" id="sc-rename-box">' +
          '<div class="sc-rename-line">' +
            '<input type="text" id="sc-rename-input" maxlength="24" autocomplete="off" ' +
              'autocapitalize="sentences" spellcheck="false" enterkeyhint="done" placeholder="Имя корабля">' +
            '<button type="button" class="sc-rename-ok" id="sc-rename-ok" aria-label="Сохранить">✓</button>' +
            '<button type="button" class="sc-rename-no" id="sc-rename-no" aria-label="Отмена">✕</button>' +
          '</div>' +
          '<div class="sc-rename-hint" id="sc-rename-hint"></div>' +
        '</div>' +
        '<div class="sc-hp">' +
          '<span class="sc-hp-num" id="sc-hp-num"></span>' +
          '<div class="sc-hp-track"><i id="sc-hp-fill"></i></div>' +
        '</div>' +
      '</div>' +
      '<button class="sc-close" id="sc-close">✕</button>' +
    '</div>' +

    '<div class="sc-tabs" id="sc-tabs"></div>' +
    '<div class="sc-panel">' +
      '<div id="sc-tab-cargo"></div>' +
      '<div id="sc-tab-hangar"><div id="sc-hangar"></div></div>' +
      '<div id="sc-tab-info"><div id="sc-cmd"></div><div class="sc-desc" id="sc-desc"></div></div>' +
    '</div>';

  document.body.appendChild(hud);

  document.getElementById('sc-close').addEventListener('click', scDeselect);
  document.getElementById('sc-rename').addEventListener('click', scRenameOpen);
  document.getElementById('sc-rename-ok').addEventListener('click', scRenameSave);
  document.getElementById('sc-rename-no').addEventListener('click', scRenameClose);
  document.getElementById('sc-rename-input').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') { e.preventDefault(); scRenameSave(); }
    else if (e.key === 'Escape') { e.preventDefault(); scRenameClose(); }
  });

  return hud;
}

function scRenderHud() {
  if (!scShip || !scType) return;
  var hud = scEnsureHud();
  hud.style.display = 'block';

  // Камеру доводим до корабля только при выборе: HUD перерисовывается
  // на каждом обновлении списка кораблей, и экран прыгал бы обратно
  setTimeout(function() {
    if (!scJustSelected) return;
    scJustSelected = false;
    if (typeof focusCell === 'function' && scShip && scType) {
      var box = scBox(scType, scShip.facing);
      focusCell(scShip.x + box.w / 2, scShip.y + box.h / 2);
    }
  }, 0);

  // Редактор имени открыт для другого корабля — закрываем
  if (scRenameFor && scRenameFor !== scShip.id) scRenameClose();

  // Своё имя — крупно, заводское название типа уходит в подпись
  var named = !!scShip.name;
  var nameEl = document.getElementById('sc-name');
  nameEl.textContent = named ? '«' + scShip.name + '»' : scType.name;
  nameEl.classList.toggle('named', named);
  var renBtn = document.getElementById('sc-rename');
  renBtn.title = named ? 'Переименовать корабль' : 'Дать кораблю имя';
  renBtn.classList.toggle('named', named);

  var role = scType.is_fighter
    ? (scType.hull_class === 'bomber' ? 'Бомбардировщик' : 'Истребитель')
    : (SC_HULL_NAMES[scType.hull_class] || 'Крупный корабль');

  document.getElementById('sc-sub').textContent =
    (named ? scType.name + ' · ' : '') + role + ' · ' + scShip.x + ':' + scShip.y;

  var img = document.getElementById('sc-portrait-img');
  if (img && scType.image) img.src = '../' + scType.image;

  var hpMaxOwn = (scType.max_hp || scShip.hp) + (scShip.bonus_hp || 0);
  var hpPct = Math.max(0, Math.min(100, (scShip.hp / hpMaxOwn) * 100));
  document.getElementById('sc-hp-num').textContent = scShip.hp + ' / ' + hpMaxOwn;
  document.getElementById('sc-hp-fill').style.width = hpPct + '%';

  // Трофей и последствия абордажа — строками под корпусом
  var bm = document.getElementById('sc-board-marks');
  if (!bm) {
    bm = document.createElement('div');
    bm.id = 'sc-board-marks';
    bm.className = 'ui-marks sc-board-marks';
    var hp = hud.querySelector('.sc-hp');
    if (hp && hp.parentNode) hp.parentNode.insertBefore(bm, hp.nextSibling);
  }
  var bml = sxBoardMarks(scShip);
  bm.innerHTML = bml.map(function(m) { return '<span class="ui-mark ' + m.cls + '">' + sxEsc(m.text) + '</span>'; }).join('');
  bm.style.display = bml.length ? '' : 'none';

  scRenderTabs();

  var desc = document.getElementById('sc-desc');
  if (desc) desc.textContent = scType.description || 'Описание пока не заполнено';

  scRenderCommander();
}

// ===== Вкладки =====
// Ход, атаку и щиты ведёт бой (космос 2.0) — здесь только трюм, ангар и описание
var scTab = 'cargo';
var scTabKey = '';   // корабль:вкладка, чьё содержимое уже нарисовано (трюм и ангар грузятся при показе)

function scRenderTabs() {
  var box = document.getElementById('sc-tabs');
  if (!box) return;

  var tabs = [];
  // Трюм только у тех, кто возит: у истребителя вместимость ноль
  if (scCargoCap(scShip, scType) > 0) tabs.push({ id: 'cargo', label: 'Трюм' });
  // Ангар только у носителей
  if (scHangarCap(scShip, scType) > 0) tabs.push({ id: 'hangar', label: 'Ангар' });
  tabs.push({ id: 'info', label: 'Описание' });

  // Вкладка могла исчезнуть при смене корабля — тогда открываем первую
  if (!tabs.some(function(t) { return t.id === scTab; })) scTab = tabs[0].id;

  box.innerHTML = '';
  tabs.forEach(function(t) {
    var b = document.createElement('button');
    b.className = 'sc-tab' + (scTab === t.id ? ' active' : '');
    b.setAttribute('data-tab', t.id);
    b.textContent = t.label;
    b.addEventListener('click', function() {
      scTab = t.id;
      scTabKey = '';                 // нажатие — всегда свежий трюм и ангар
      scRenderTabs();
    });
    box.appendChild(b);
  });

  scApplyTab();
  // трюм и ангар грузятся при показе: в 2.0 панель сразу открывается на них — без этого вкладка была пустой
  var key = scShip ? scShip.id + ':' + scTab : '';
  if (key !== scTabKey) {
    scTabKey = key;
    if (scTab === 'cargo') scRenderCargo();
    else if (scTab === 'hangar') scRenderHangar();
  }
}

function scApplyTab() {
  ['cargo', 'hangar', 'info'].forEach(function(id) {
    var el = document.getElementById('sc-tab-' + id);
    if (el) el.style.display = (scTab === id) ? 'block' : 'none';
  });
}

// Трюм: пехота лежит счётчиком, техника отдельными строками. Показываем
// обе части и даём высадить прямо отсюда. На своей планете место подбирает
// сервер, при вторжении высадка идёт поштучно с наземной карты.
function scRenderCargo() {
  var box = document.getElementById('sc-tab-cargo');
  if (!box || !scShip) return;

  var forShip = scShip.id;
  box.innerHTML = '<div class="sc-hangar-head">Трюм</div>' +
                  '<div class="sc-hangar-empty">Загрузка…</div>';

  Promise.all([
    supabase.rpc('get_ship_holds'),
    supabase.rpc('get_carried_units', { p_carrier_unit_id: null, p_ship_id: forShip }),
    // Ресурсы делят тот же трюм: без них полный грузом корабль
    // показывался здесь пустым, а в «Армии» — забитым
    supabase.rpc('get_ship_resource_cargo', { p_ship_id: forShip }),
    scResourceColors()
  ]).then(function(r) {
    if (!scShip || scShip.id !== forShip || scTab !== 'cargo') return;

    var holds = (!r[0].error && r[0].data) ? r[0].data : [];
    var mine = holds.filter(function(h) { return h.ship_id === forShip && !h.is_vehicle; });
    var vehicles = (!r[1].error && r[1].data) ? r[1].data : [];
    var goods = (!r[2].error && r[2].data) ? r[2].data : [];

    var used = 0;
    holds.forEach(function(h) { if (h.ship_id === forShip) used += (h.slots || 0); });
    goods.forEach(function(g) { used += (g.slots || 0); });

    var cap = scCargoCap(scShip, scType);
    box.innerHTML = '<div class="sc-hangar-head">Трюм · ' +
      '<span class="' + (cap && used >= cap ? 'sc-cargo-full' : '') + '">' +
      used + ' из ' + cap + '</span></div>';

    // Орбита 2.0: погрузка и высадка — только из площадки сброса; говорим заранее, а не после отказа
    if (window.SL && window.SL.onPad && (mine.length || vehicles.length) && !window.SL.onPad(forShip)) {
      var padNote = document.createElement('div');
      padNote.className = 'sc-hangar-empty sc-pad-warn';
      padNote.textContent = 'Высадка только из площадки сброса. Коснись квадрата «ПЛОЩАДКА» на орбите — корабль встанет в неё целиком';
      box.appendChild(padNote);
    }

    if (!mine.length && !vehicles.length && !goods.length) {
      var empty = document.createElement('div');
      empty.className = 'sc-hangar-empty';
      empty.textContent = 'Пусто';
      box.appendChild(empty);
      return;
    }

    vehicles.forEach(function(v) {
      var row = document.createElement('div');
      row.className = 'sc-hangar-row';
      row.innerHTML = '<div class="sc-hangar-line"><span>' + v.unit_name +
        (v.passengers ? ' · десант ' + v.passengers : '') + '</span>' +
        '<em>' + v.slots + ' сл.</em></div>';

      var b = document.createElement('button');
      b.className = 'sc-hangar-btn wide';
      b.textContent = 'Высадить';
      b.addEventListener('click', function() {
        b.disabled = true;
        supabase.rpc('unload_vehicle_auto', { p_unit_id: v.unit_id }).then(function(res) {
          if (res.error) { scFail(res.error.message); b.disabled = false; return; }
          scRenderCargo();
          loadShips();
        });
      });
      row.appendChild(b);
      box.appendChild(row);
    });

    // Пачкой высаживают только на своей планете. На чужой и ничейной
    // сервер отклоняет такой приказ — там высадка идёт поштучно в полосу
    // вторжения с наземной карты, поэтому кнопок пачки тут не показываем.
    var ownPlanet = typeof sysFaction !== 'undefined' && !!sysFaction &&
      sysFaction === scShip.faction;

    mine.forEach(function(h) {
      var row = document.createElement('div');
      row.className = 'sc-hangar-row';
      row.innerHTML = '<div class="sc-hangar-line"><span>' + h.unit_name + '</span>' +
        '<em>×' + h.quantity + '</em></div>';

      var acts = document.createElement('div');
      acts.className = 'sc-hangar-acts';

      [1, 5].forEach(function(n) {
        if (!ownPlanet || n > h.quantity) return;
        var b = document.createElement('button');
        b.className = 'sc-hangar-btn';
        b.textContent = 'Высадить ' + n;
        b.addEventListener('click', function() {
          b.disabled = true;
          supabase.rpc('unload_from_ship', {
            p_ship_id: forShip, p_unit_type: h.unit_type, p_quantity: n
          }).then(function(res) {
            if (res.error) { scFail(res.error.message); b.disabled = false; return; }
            scRenderCargo();
            loadShips();
          });
        });
        acts.appendChild(b);
      });

      if (acts.children.length) row.appendChild(acts);
      box.appendChild(row);
    });

    if (mine.length || vehicles.length) {
      var note = document.createElement('div');
      note.className = 'sc-hangar-empty';
      note.textContent = 'На чужой планете высадка идёт поштучно с наземной карты';
      box.appendChild(note);

      if (mine.length && !ownPlanet) {
        var go = document.createElement('button');
        go.className = 'sc-hangar-btn wide';
        go.textContent = 'К наземной карте';
        go.addEventListener('click', function() {
          window.location.href = 'ground-battle.html?system=' + encodeURIComponent(systemId);
        });
        box.appendChild(go);
      }
    }

    if (goods.length) scRenderCargoGoods(box, forShip, goods, r[3] || {});
  });
}

// Цвета ресурсов нужны только для полоски у строки груза — спрашиваем
// один раз за страницу
var scResColors = null;
function scResourceColors() {
  if (scResColors) return Promise.resolve(scResColors);
  return supabase.from('resources').select('id, color').then(function(res) {
    var map = {};
    (res.data || []).forEach(function(x) { map[x.id] = x.color; });
    if (!res.error) scResColors = map;
    return map;
  });
}

// Груз выгружается на склад планеты, над которой стоит корабль. Правила
// (своя сторона, место на складе) проверяет сервер — его ответ показываем
// прямо в трюме, а не в подсказке над плитками, которой тут не видно.
function scRenderCargoGoods(box, forShip, goods, colors) {
  var head = document.createElement('div');
  head.className = 'sc-hangar-head sc-cargo-sub';
  head.textContent = 'Груз · выгрузить на склад';
  box.appendChild(head);

  var err = document.createElement('div');
  err.className = 'sc-cargo-err';
  err.style.display = 'none';
  box.appendChild(err);

  // Строка груза короткая: название и объём слева, кнопки справа.
  // Семь ресурсов в полный рост растягивали панель на два экрана.
  goods.forEach(function(g) {
    var row = document.createElement('div');
    row.className = 'sc-hangar-row sc-cargo-goods';
    if (colors[g.resource]) row.style.borderLeftColor = colors[g.resource];

    var txt = document.createElement('div');
    txt.className = 'sc-goods-txt';
    var nm = document.createElement('span');
    nm.textContent = g.name;
    var meta = document.createElement('em');
    meta.textContent = g.amount + ' ед. · ' + g.slots + ' сл.';
    txt.appendChild(nm);
    txt.appendChild(meta);
    row.appendChild(txt);

    var acts = document.createElement('div');
    acts.className = 'sc-hangar-acts';
    var steps = g.amount > 10 ? [10, g.amount] : [g.amount];
    steps.forEach(function(n) {
      var b = document.createElement('button');
      b.className = 'sc-hangar-btn';
      b.textContent = n === g.amount ? 'Всё' : String(n);
      b.addEventListener('click', function() {
        b.disabled = true;
        supabase.rpc('unload_resource_from_ship', {
          p_ship_id: forShip, p_resource: g.resource, p_amount: n
        }).then(function(res) {
          if (res.error) {
            b.disabled = false;
            err.textContent = res.error.message;
            err.style.display = 'block';
            return;
          }
          scRenderCargo();
        });
      });
      acts.appendChild(b);
    });
    row.appendChild(acts);
    box.appendChild(row);
  });

  var note = document.createElement('div');
  note.className = 'sc-hangar-empty';
  note.textContent = 'Выгрузка — только на планете своей стороны, пока на складе есть место';
  box.appendChild(note);
}

// Командир нужен только для перелётов между планетами. Корабль без
// командира — это не забытый корабль, а гарнизон: он остаётся оборонять
// систему. Поэтому здесь нейтральная формулировка, а не предупреждение.
var scCommandersCache = null;

function scRenderCommander() {
  var box = document.getElementById('sc-cmd');
  if (!box || !scShip) return;

  box.innerHTML = '<div class="sc-cmd-title">Командир</div>' +
    '<div class="sc-cmd-state">…</div>';

  var fill = function(list) {
    var here = list.filter(function(c) {
      return c.unlocked && !c.moving_to && c.current_system === scShip.system_id;
    });

    var current = null;
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === scShip.commander_id) { current = list[i]; break; }
    }

    // Командир нужен редко, а места занимал много. Сворачиваем в строку,
    // которая раскрывается по тапу.
    box.innerHTML = '';

    var head = document.createElement('button');
    head.className = 'sc-cmd-head' + (current ? ' assigned' : '');
    head.innerHTML = '<span class="sc-cmd-arrow">▸</span> Командир: ' +
      (current ? current.name : 'в обороне');
    box.appendChild(head);

    var details = document.createElement('div');
    details.className = 'sc-cmd-details';
    box.appendChild(details);

    head.addEventListener('click', function() {
      var open = box.classList.toggle('open');
      head.querySelector('.sc-cmd-arrow').textContent = open ? '▾' : '▸';
    });

    var state = document.createElement('div');
    state.className = 'sc-cmd-state' + (current ? ' assigned' : '');
    state.textContent = current
      ? 'ведёт ' + current.name + ' — уйдёт вместе с ним'
      : 'в обороне системы — остаётся на месте';
    details.appendChild(state);

    var sel = document.createElement('select');
    sel.className = 'sc-cmd-select';

    var none = document.createElement('option');
    none.value = '';
    none.textContent = '— оставить в обороне —';
    sel.appendChild(none);

    // Командир, который уже ведёт корабль, может быть не в этой системе
    // (например, флот ещё не догнал его) — держим его в списке, иначе
    // выбор молча сбросился бы
    if (current && here.indexOf(current) === -1) here.unshift(current);

    here.forEach(function(c) {
      var opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.name;
      if (scShip.commander_id === c.id) opt.selected = true;
      sel.appendChild(opt);
    });

    sel.addEventListener('change', function() {
      sel.disabled = true;
      supabase.rpc('assign_ship', {
        p_ship_id: scShip.id,
        p_commander_id: sel.value || null
      }).then(function(r) {
        sel.disabled = false;
        if (r.error) { scFail(r.error.message); return; }
        loadShips();
      });
    });

    details.appendChild(sel);

    if (here.length === 0) {
      var hint = document.createElement('div');
      hint.className = 'sc-cmd-hint';
      hint.textContent = 'Свободных командиров в этой системе нет';
      details.appendChild(hint);
    }
  };

  if (scCommandersCache) { fill(scCommandersCache); return; }

  supabase.from('commanders').select('*').eq('user_id', currentUserId)
    .then(function(res) {
      scCommandersCache = res.error ? [] : (res.data || []);
      fill(scCommandersCache);
    });
}

// ===== Ангар =====
// Истребители в ангаре и на карте — это один и тот же корабль, просто
// в разных состояниях, поэтому прочность и повреждения сохраняются.
// Выпускает их бой (космос 2.0); отсюда — только посадка на грунт.

function scRenderHangar() {
  var box = document.getElementById('sc-hangar');
  if (!box || !scShip || !scType) return;

  // Ангар есть не у всех, и это нормально
  if (!scHangarCap(scShip, scType)) {
    box.innerHTML = '';
    return;
  }

  var forShip = scShip.id;
  box.innerHTML = '<div class="sc-hangar-head">Ангар</div>' +
                  '<div class="sc-hangar-empty">Загрузка…</div>';

  // Читаем ангар прямо из таблицы: истребители внутри принадлежат игроку,
  // права на чтение у него есть. Так убирается лишнее звено — раньше
  // содержимое шло через функцию, и любой сбой в ней выглядел как
  // пустой ангар, без всякого объяснения.
  supabase.from('ships')
    .select('id, hp, name, ship_type, ship_types(name, image, max_hp)')
    .eq('carrier_ship_id', forShip)
    .then(function(res) {
    if (!scShip || scShip.id !== forShip || scTab !== 'hangar') return;

    if (res.error) {
      box.innerHTML = '<div class="sc-hangar-head">Ангар</div>' +
        '<div class="sc-hangar-empty">Ошибка: ' + res.error.message + '</div>';
      return;
    }

    var list = (res.data || []).map(function(f) {
      var t = f.ship_types || {};
      return { fighter_id: f.id, name: f.name || t.name || f.ship_type,
               hp: f.hp, max_hp: t.max_hp || f.hp };
    });

    var html = '<div class="sc-hangar-head">Ангар · ' +
      list.length + ' из ' + scHangarCap(scShip, scType) + '</div>';
    box.innerHTML = html;

    if (!list.length) {
      var empty = document.createElement('div');
      empty.className = 'sc-hangar-empty';
      empty.textContent = 'Пусто';
      box.appendChild(empty);
      return;
    }

    list.forEach(function(f) {
      var hpPct = f.max_hp ? Math.max(0, f.hp / f.max_hp * 100) : 100;

      var row = document.createElement('div');
      row.className = 'sc-hangar-row';
      row.innerHTML =
        '<div class="sc-hangar-line"><span>' + sxEsc(f.name) + '</span>' +
        '<em>' + f.hp + '/' + f.max_hp + '</em></div>' +
        '<div class="sc-hangar-track"><i style="width:' + hpPct + '%"></i></div>';

      var acts = document.createElement('div');
      acts.className = 'sc-hangar-acts';

      var land = document.createElement('button');
      land.className = 'sc-hangar-btn';
      land.textContent = 'На грунт';
      land.addEventListener('click', function() { scStartLand(f); });
      acts.appendChild(land);

      row.appendChild(acts);
      box.appendChild(row);
    });
  });
}

// Посадка идёт на наземной карте: сразу переходим туда с этим
// истребителем в режиме посадки. Раньше кнопка лишь просила открыть
// карту самому, а там на своей планете не было даже кнопки высадки.
function scStartLand(f) {
  // Носитель не в площадке сброса — садиться неоткуда, на землю не ведём
  supabase.rpc('get_landable_fighters', { p_system_id: systemId }).then(function(res) {
    var row = (!res.error && res.data) ? res.data.filter(function(x) {
      return x.fighter_id === f.fighter_id;
    })[0] : null;
    if (row && (row.zone === null || row.zone === undefined)) {
      scFail('Сначала поставь носитель целиком в площадку сброса');
      return;
    }
    window.location.href = 'ground-battle.html?system=' + encodeURIComponent(systemId) +
      '&land=' + encodeURIComponent(f.fighter_id);
  });
}

// ===== имя корабля =====
// Хозяин даёт кораблю имя: его видят все, кто видит корабль, — в карточке
// врага, в сводках боя и списках. Правила и цензуру проверяет сервер
// (rename_ship); пустое поле возвращает заводское название.

var scRenameFor = null;     // корабль, чьё имя сейчас правят
var scRenameBusy = false;

function scRenameHint(text, bad) {
  var h = document.getElementById('sc-rename-hint');
  if (!h) return;
  h.textContent = text;
  h.classList.toggle('bad', !!bad);
}

function scRenameOpen() {
  if (!scShip || !scType) return;
  var stats = document.querySelector('#ship-hud .sc-stats');
  var input = document.getElementById('sc-rename-input');
  if (!stats || !input) return;
  scRenameFor = scShip.id;
  stats.classList.add('renaming');
  input.value = scShip.name || '';
  input.placeholder = scType.name;
  scRenameHint('2–24 символа: буквы, цифры, пробел, дефис. Пусто — «' + scType.name + '»');
  input.focus();
  try { input.setSelectionRange(input.value.length, input.value.length); } catch (e) {}
}

function scRenameClose() {
  scRenameFor = null;
  var stats = document.querySelector('#ship-hud .sc-stats');
  if (stats) stats.classList.remove('renaming');
  var input = document.getElementById('sc-rename-input');
  if (input && document.activeElement === input) input.blur();
}

function scRenameSave() {
  if (!scShip || scRenameFor !== scShip.id || scRenameBusy) return;
  var input = document.getElementById('sc-rename-input');
  var next = (input.value || '').replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
  if ((next || null) === (scShip.name || null)) { scRenameClose(); return; }
  if (next && next.length < 2) { scRenameHint('Нужно хотя бы 2 символа', true); return; }

  var shipId = scShip.id;
  scRenameBusy = true;
  var ok = document.getElementById('sc-rename-ok');
  if (ok) ok.disabled = true;
  scRenameHint('Сохраняем…');
  Promise.resolve(supabase.rpc('rename_ship', { p_ship_id: shipId, p_name: next }))
    .then(function(r) {
      scRenameBusy = false;
      if (ok) ok.disabled = false;
      if (r && r.error) {
        var msg = r.error.message || 'Не вышло';
        if (/could not find the function|does not exist/i.test(msg)) msg = 'Имена кораблей пока не включены на сервере';
        scRenameHint(msg, true);
        return;
      }
      var name = r ? r.data : null;
      // Сразу у себя: реалтайм догонит остальных
      shipsInSystem.forEach(function(x) { if (x.id === shipId) x.name = name || null; });
      if (scShip && scShip.id === shipId) scShip.name = name || null;
      scRenameClose();
      scRenderHud();
    }, function(e) {
      scRenameBusy = false;
      if (ok) ok.disabled = false;
      scRenameHint((e && e.message) || 'Нет связи с сервером', true);
    });
}

// ===== выбор корабля =====

function onOwnShipTapped(ship, type) {
  scJustSelected = (!scShip || scShip.id !== ship.id);

  // Каждый корабль открывается заново, без чужих списков. Иначе панель
  // показывала ангар «Венатора» при выборе истребителя: раздел оставался
  // нарисованным с прошлого раза.
  if (scJustSelected) scResetSections();

  scShip = ship;
  scType = type;
  scRenderHud();
}

function scDeselect() {
  scRenameClose();
  scShip = null;
  scType = null;
  scResetSections();

  var hud = document.getElementById('ship-hud');
  if (hud) hud.style.display = 'none';
}

// Полная очистка разделов: содержимое и вкладка
function scResetSections() {
  // Каждый корабль открывается на первой вкладке: иначе остаётся вкладка
  // от предыдущего, а у него мог быть ангар, которого здесь нет
  scTab = 'cargo';
  scTabKey = '';

  var hangar = document.getElementById('sc-hangar');
  if (hangar) hangar.innerHTML = '';

  var cmd = document.getElementById('sc-cmd');
  if (cmd) cmd.classList.remove('open');
}

// После перезагрузки списка кораблей обновляем выбранный
function onShipsReloaded() {
  if (!scShip) return;
  var fresh = null;
  for (var i = 0; i < shipsInSystem.length; i++) {
    if (shipsInSystem[i].id === scShip.id) { fresh = shipsInSystem[i]; break; }
  }
  // Ушёл в ангар носителя — на карте его больше нет, держать HUD незачем
  if (!fresh || fresh.carrier_ship_id || fresh.x === null || fresh.x === undefined) {
    scDeselect(); return;
  }
  scShip = fresh;
  scRenderHud();
}

// ===== ответ базы =====

function scFail(msg) {
  // Корабль погиб или ушёл, пока панель была открыта: повторные приказы
  // по нему бессмысленны — перечитываем флот и закрываем панель
  if (msg && /^Корабль не найден/.test(msg)) {
    if (typeof loadShips === 'function') loadShips();
    if (typeof scDeselect === 'function') scDeselect();
    return;
  }
  // Ответ базы всплывает уведомлением боя (js/space-live.js)
  var m2 = msg || 'Не получилось';
  if (/площадке сброса/.test(m2)) m2 += '. Коснись квадрата «ПЛОЩАДКА» на орбите — корабль встанет в неё';
  if (window.__sp && window.__sp.toast) window.__sp.toast(m2, 'bad');
  else alert(m2);
}

document.addEventListener('DOMContentLoaded', function() {
  scSyncTime();
});

// ===== Список кораблей и переход по ссылке =====

var sxShipsSeq = 0;
var sxShipsApplied = 0;

function sxEsc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function sxShipById(id) {
  for (var i = 0; i < shipsInSystem.length; i++) if (shipsInSystem[i].id === id) return shipsInSystem[i];
  return null;
}

// ---------- Порядок ответов и разница между загрузками ----------

// Вызывается из loadShips до запроса: номер и время запроса
function sxShipsRequested() {
  return { seq: ++sxShipsSeq, at: Date.now() };
}

// Ответ свежее показанного? Старый поверх нового откатил бы корабли назад
function sxShipsFresh(req) {
  if (!req || req.seq <= sxShipsApplied) return false;
  sxShipsApplied = req.seq;
  return true;
}

// ---------- Переход по ссылке из ленты и процессов ----------
// ?system=…&ship=… — выбрать корабль (это делает бой 2.0, SL.wantShip)
// &x=…&y=…         — показать точку
// &open=shipyard   — верфь станции; open=station — панель станции

function sxDeepLink() {
  var q = new URLSearchParams(window.location.search);
  var link = {
    ship: q.get('ship'),
    x: q.get('x') !== null ? parseInt(q.get('x'), 10) : null,
    y: q.get('y') !== null ? parseInt(q.get('y'), 10) : null,
    open: q.get('open')
  };
  if (!link.ship && link.x === null && !link.open) return;
  // корабль выбирает бой 2.0 (SP_ON_HELLO в space-live.js): передать ему до того, как адрес почищен
  if (link.ship && window.SL) window.SL.wantShip = link.ship;

  try {
    var keep = '?system=' + encodeURIComponent(systemId) +
               (typeof isBuildMode === 'function' && isBuildMode() ? '&mode=build' : '');
    window.history.replaceState(null, '', window.location.pathname + keep);
  } catch (e) {}

  var tries = 0;
  var wait = setInterval(function() {
    tries++;
    var ready = sxShipsApplied > 0 && (typeof stationLoaded === 'undefined' || stationLoaded);
    if (!ready && tries < 50) return;
    clearInterval(wait);
    sxApplyLink(link);
  }, 200);
}

function sxApplyLink(link) {
  // бой 2.0 сам выбирает корабль и наводит камеру
  if (link.ship) return;

  if (link.open === 'shipyard' || link.open === 'station') {
    // Слота станции в системе нет — показывать нечего, остаёмся на обзоре
    if (typeof stationSlot === 'undefined' || !stationSlot) return;
    focusCell(stationSlot.x + STATION_SIZE / 2 - 0.5, stationSlot.y + STATION_SIZE / 2 - 0.5);
    setTimeout(function() {
      if (typeof onStationSlotTapped !== 'function') return;
      // Панель станции сама решает, доступна ли верфь: стройка, трофей,
      // чужой контроль. Если кнопка верфи видна — сразу в верфь,
      // иначе остаётся панель с объяснением
      onStationSlotTapped();
      var yardBtn = document.getElementById('station-shipyard-btn');
      if (link.open === 'shipyard' && yardBtn && yardBtn.style.display === 'block' &&
          typeof openShipyard === 'function') {
        if (typeof closeStationPanel === 'function') closeStationPanel();
        openShipyard();
      }
    }, 350);
    return;
  }

  if (link.x !== null && link.y !== null && !isNaN(link.x) && !isNaN(link.y)) {
    focusCell(link.x, link.y);
  }
}

// Что делает с кораблём трофейный статус и абордаж: строки для панели
function sxBoardMarks(ship) {
  var out = [];
  if (!ship) return out;
  if (ship.trophy) {
    var left = ship.jump_lock_until ? new Date(ship.jump_lock_until).getTime() - scServerNow() : 0;
    out.push({ text: 'Трофей: щиты выключены, ход и урон ×½' + (left > 0 ? ', прыжки закрыты ещё ' + Math.ceil(left / 3600000) + ' ч' : '') + ' · ремонт в доке снимет', cls: 'reveal' });
  }
  var e = ship.boarding_eff;
  if (e) {
    var w = [];
    if (e.shields) w.push('щиты погашены');
    if (e.gun_port && e.gun_star) w.push('борта не стреляют');
    else if (e.gun_port) w.push('левый борт не стреляет');
    else if (e.gun_star) w.push('правый борт не стреляет');
    if (e.hangar) w.push('ангар захвачен');
    if (e.engine) w.push('машинное захвачено');
    if (w.length) out.push({ text: 'Абордаж: ' + w.join(', '), cls: 'wound' });
  }
  return out;
}
