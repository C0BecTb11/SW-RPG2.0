// Корабль 2.0 изнутри: чтение плана отсеков (shared/ships/*.json) и карта
// проходимости для боевого модуля (rt-core). Работает и в браузере, и в Node.
// План собирается из силуэта спрайта карты: tools/ships/build.py.

(function(root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SWShip = api;
})(typeof self !== 'undefined' ? self : this, function() {
  'use strict';

  // Коды клеток плана
  var K = { VOID: 0, TECH: 1, HULL: 2, WALL: 3, FLOOR: 4, DOOR: 5 };

  // Что за отсек: имя типа, система, которую он держит, и короткое описание
  var TYPES = {
    hangar:   { name: 'Ангар',            sys: 'ангар',      about: 'Стоянка и вылет малых кораблей. Пожар здесь задерживает вылет.' },
    bridge:   { name: 'Мостик',           sys: 'управление', about: 'Командование кораблём. Без мостика корабль хуже маневрирует.' },
    flight:   { name: 'Лётный контроль',  sys: 'ангар',      about: 'Управление вылетами и посадкой малых кораблей.' },
    cic:      { name: 'Тактический центр', sys: 'наведение', about: 'Сводит данные целей для орудийных постов.' },
    gun:      { name: 'Орудийный пост',   sys: 'орудие',     about: 'Расчёт этого поста ведёт огонь из орудия на корпусе над ним.' },
    pdgun:    { name: 'Пост ПВО',         sys: 'ПВО',        about: 'Лёгкая турель против истребителей и торпед.' },
    reactor:  { name: 'Реактор',          sys: 'энергия',    about: 'Питание всех систем. Повреждение бьёт по щитам и орудиям.' },
    shield:   { name: 'Генератор щитов',  sys: 'щиты',       about: 'Держит секторные щиты. Повреждён — щиты не восстанавливаются.' },
    engine:   { name: 'Двигатели',        sys: 'ход',        about: 'Скорость и манёвр. Повреждены — корабль медленнее.' },
    hyper:    { name: 'Гиперпривод',      sys: 'прыжок',     about: 'Прыжок в гиперпространство. Повреждён — не уйти из боя.' },
    quarters: { name: 'Кубрики',          sys: 'экипаж',     about: 'Отдых экипажа.' },
    troops:   { name: 'Казармы',          sys: 'десант',     about: 'Размещение десанта.' },
    mess:     { name: 'Столовая',         sys: 'экипаж',     about: 'Питание экипажа.' },
    medbay:   { name: 'Лазарет',          sys: 'лечение',    about: 'Лечение раненых членов экипажа.' },
    armory:   { name: 'Арсенал',          sys: 'оружие',     about: 'Оружие экипажа и десанта.' },
    storage:  { name: 'Склад',            sys: 'запасы',     about: 'Запасы и боеприпасы.' },
    hold:     { name: 'Трюм',             sys: 'груз',       about: 'Грузовой трюм.' },
    droids:   { name: 'Стеллажи дроидов', sys: 'десант',     about: 'Хранение боевых дроидов.' },
    vehicle:  { name: 'Техника',          sys: 'десант',     about: 'Наземная техника для высадки.' },
    dock:     { name: 'Док',              sys: 'ангар',      about: 'Причал для шаттлов.' },
    workshop: { name: 'Мастерская',       sys: 'ремонт',     about: 'Ремонтная бригада и запчасти.' },
    airlock:  { name: 'Шлюз',             sys: 'шлюз',       about: 'Выход в открытый космос и стыковка.' },
    comms:    { name: 'Связь',            sys: 'связь',      about: 'Дальняя связь и глушение.' },
    observe:  { name: 'Обзорная палуба',  sys: 'обзор',      about: 'Обзорное окно.' }
  };

  function unrle(arr, n) {
    var out = new Uint16Array(n), o = 0;
    for (var i = 0; i < arr.length; i += 2) {
      var v = arr[i], c = arr[i + 1];
      out.fill(v, o, o + c); o += c;
    }
    return out;
  }

  // План из JSON → удобный вид
  function load(data) {
    var n = data.w * data.h;
    var ship = {
      id: data.id, name: data.name, faction: data.faction, lengthM: data.length_m, cellM: data.cell_m,
      w: data.w, h: data.h, sprite: data.sprite, crop: data.crop,
      kind: unrle(data.kind, n), room: unrle(data.room, n),
      rooms: data.rooms, doors: data.doors, props: data.props, mounts: data.mounts,
      roomByN: {}
    };
    for (var i = 0; i < ship.rooms.length; i++) ship.roomByN[ship.rooms[i].n] = ship.rooms[i];
    // предметы → клетки (для проходимости и выбора)
    ship.prop = new Uint8Array(n);
    for (var p = 0; p < ship.props.length; p++) {
      var q = ship.props[p];
      for (var y = q.y; y < q.y + q.h; y++) for (var x = q.x; x < q.x + q.w; x++) ship.prop[y * ship.w + x] = q.s;
    }
    return ship;
  }

  // Карта для rt-core: пол и двери проходимы, укрытия — COVER, всё прочее — стена
  function rtMap(ship, SWRT) {
    var n = ship.w * ship.h, cells = new Uint8Array(n);
    for (var i = 0; i < n; i++) {
      var k = ship.kind[i];
      if (k === K.FLOOR || k === K.DOOR) cells[i] = ship.prop[i] === 1 ? SWRT.COVER : ship.prop[i] === 2 ? SWRT.WALL : SWRT.FLOOR;
      else cells[i] = SWRT.WALL;
    }
    return { w: ship.w, h: ship.h, seed: 1, cells: cells, cw: Math.ceil(ship.w / SWRT.CHUNK), ch: Math.ceil(ship.h / SWRT.CHUNK) };
  }

  function roomAt(ship, x, y) {
    x = Math.floor(x); y = Math.floor(y);
    if (x < 0 || y < 0 || x >= ship.w || y >= ship.h) return null;
    var n = ship.room[y * ship.w + x];
    return n ? ship.roomByN[n] : null;
  }

  return { K: K, TYPES: TYPES, load: load, rtMap: rtMap, roomAt: roomAt };
});
