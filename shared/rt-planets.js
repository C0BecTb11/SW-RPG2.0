// Местность планет для наземки 2.0: что значит каждая клетка карты.
//
// Карта планеты — 144×144 клетки, как в базе (зоны, участки, бойцы — в тех же
// координатах). Карты постоянные: их один раз строит tools/planets/gen.js, они
// лежат в shared/planets/<id>.json и у всех игроков и на сервере одинаковые.
//
// В карте три слоя по клетке:
//   t — тип местности (T ниже): как по ней ходят, укрывает ли, закрывает ли обзор;
//   e — высота 0..3: плато, террасы, дно карьера; переход между высотами — только по склону (RAMP);
//   m — вид (0..3): чем именно клетка выглядит на этой планете (валун или обломок и т. п.).
// И список крупных предметов objs (небоскрёбы, остовы, стволы, воронки) — для отрисовки.
//
// Здесь только смысл и чтение карт; рисует ground/terrain.js. ES5, браузер и Node.

(function(root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SWPlanets = api;
})(typeof self !== 'undefined' ? self : this, function() {
  'use strict';

  var N = 144;                      // сторона карты, как ground_grid_cells в базе
  var T = { OPEN: 0, ROUGH: 1, LIGHT: 2, COVER: 3, BLOCK: 4, WATER: 5, VOID: 6, RAMP: 7, BRIDGE: 8, ROAD: 9, FORD: 10, TRAP: 11 };
  var NAME = ['Открытая местность', 'Трудная местность', 'Заросли', 'Укрытие', 'Скалы', 'Вода', 'Пропасть', 'Склон', 'Мост', 'Дорога', 'Брод', 'Заграждение'];

  // Как ходят по клетке разные бойцы: пешие, гусеницы и шагоходы, репульсоры, воздух.
  // Число — множитель скорости, 0 — нельзя.
  //            foot  track hover  air   укрытие  обзор
  var INFO = [
    /*OPEN  */ [1,    1,    1,     1,    1,       0],
    /*ROUGH */ [0.6,  0.8,  1,     1,    1,       0],
    /*LIGHT */ [0.8,  0.8,  0.9,   1,    0.75,    0],   // заросли: лёгкое укрытие, видно только вблизи
    /*COVER */ [0,    0,    0,     1,    0.5,     0],   // валуны, контейнеры: стоять рядом — укрытие
    /*BLOCK */ [0,    0,    0,     1,    1,       1],   // скалы, стволы, здания: закрывают обзор
    /*WATER */ [0,    0,    1,     1,    1,       0],
    /*VOID  */ [0,    0,    0,     1,    1,       0],   // лава, пропасть: только воздух
    /*RAMP  */ [0.9,  0.9,  1,     1,    1,       0],
    /*BRIDGE*/ [1,    1,    1,     1,    1,       0],
    /*ROAD  */ [1,    1.15, 1.1,   1,    1,       0],
    /*FORD  */ [0.6,  0.7,  1,     1,    1,       0],
    /*TRAP  */ [0.8,  0,    0,     1,    0.75,    0]    // противотанковые ежи: технику не пускают
  ];
  var MOVE = ['foot', 'track', 'hover', 'air'];
  var MOVE_I = { foot: 0, track: 1, hover: 2, air: 3 };
  // Чем ходит боец. По умолчанию — по классу корпуса (пехота и герои пешком,
  // техника — гусеницы и шаги, авиация — воздух).
  var UNIT_MOVE = {
    cis_aat: 'hover', cis_mtt: 'hover', cis_stap: 'hover', rep_barc: 'hover',
    rep_laat: 'air', cis_hmp: 'air', cis_hyena: 'air', cis_vulture: 'air', rep_arc170: 'air', rep_ywing: 'air'
  };
  function moveOf(unitType, hullClass) {
    if (UNIT_MOVE[unitType]) return UNIT_MOVE[unitType];
    if (hullClass === 'air') return 'air';
    if (hullClass === 'infantry' || hullClass === 'hero' || !hullClass) return 'foot';
    return 'track';
  }

  // Погода планеты: на сколько клеток меньше видят все. Цвет и вид — в отрисовке.
  var WEATHER = { catoneimoidia: ['fog', 1], kamino: ['rain', 1], hypori: ['ash', 1], umbara: ['dark', 2] };

  // Места, которые карта обязана оставить свободными (как в базе).
  var GEO = {
    strip: 4,                                  // полоса вторжения — нижние ground_attack_zone_height рядов
    town: [52, 52, 36, 36],                    // город: x, y, ширина, высота (поселение в центре)
    zone: 6, plot: 6                           // зоны развёртывания и участки — 6×6
  };

  // ---------------------------------------------------------------- упаковка слоёв
  // Слой — 144×144 байта. Храним как пары (повтор, значение) в base64: карты
  // из пятен и полос сжимаются в десятки раз.
  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  function b64enc(bytes) {
    var s = '', i;
    for (i = 0; i + 2 < bytes.length; i += 3) {
      var v = bytes[i] << 16 | bytes[i + 1] << 8 | bytes[i + 2];
      s += B64[v >> 18 & 63] + B64[v >> 12 & 63] + B64[v >> 6 & 63] + B64[v & 63];
    }
    var r = bytes.length - i;
    if (r === 1) { var a = bytes[i] << 16; s += B64[a >> 18 & 63] + B64[a >> 12 & 63] + '=='; }
    else if (r === 2) { var b = bytes[i] << 16 | bytes[i + 1] << 8; s += B64[b >> 18 & 63] + B64[b >> 12 & 63] + B64[b >> 6 & 63] + '='; }
    return s;
  }
  function b64dec(s) {
    var L = s.length, pad = s.charAt(L - 1) === '=' ? (s.charAt(L - 2) === '=' ? 2 : 1) : 0;
    var out = new Uint8Array(L / 4 * 3 - pad), o = 0;
    for (var i = 0; i < L; i += 4) {
      var v = B64.indexOf(s.charAt(i)) << 18 | B64.indexOf(s.charAt(i + 1)) << 12 |
              (B64.indexOf(s.charAt(i + 2)) & 63) << 6 | (B64.indexOf(s.charAt(i + 3)) & 63);
      if (o < out.length) out[o++] = v >> 16 & 255;
      if (o < out.length) out[o++] = v >> 8 & 255;
      if (o < out.length) out[o++] = v & 255;
    }
    return out;
  }
  function pack(arr) {
    var out = [], i = 0, n = arr.length;
    while (i < n) {
      var v = arr[i], k = 1;
      while (i + k < n && arr[i + k] === v && k < 255) k++;
      out.push(k, v); i += k;
    }
    return b64enc(out);
  }
  function unpack(s, n) {
    if (s && typeof s !== 'string') { if (s.length !== n) throw new Error('слой карты не той длины'); return new Uint8Array(s); }   // уже распакован (город наложен)
    var b = b64dec(s), out = new Uint8Array(n), o = 0;
    for (var i = 0; i + 1 < b.length; i += 2) { for (var k = 0; k < b[i] && o < n; k++) out[o++] = b[i + 1]; }
    if (o !== n) throw new Error('карта повреждена: ' + o + ' из ' + n);
    return out;
  }

  // Из файла карты — рабочая карта с массивами
  function load(json) {
    var n = (json.w || N) * (json.h || N);
    return {
      id: json.id, v: json.v, w: json.w || N, h: json.h || N, seed: json.seed,
      t: unpack(json.t, n), e: unpack(json.e, n), m: unpack(json.m, n),
      objs: json.objs || [], paths: json.paths || [], town: json.town || GEO.town
    };
  }
  function save(map) {
    return { id: map.id, v: map.v, w: map.w, h: map.h, seed: map.seed, town: map.town,
             t: pack(map.t), e: pack(map.e), m: pack(map.m), objs: map.objs, paths: map.paths || [] };
  }

  // ---------------------------------------------------------------- проходимость
  function code(map, x, y) { return x < 0 || y < 0 || x >= map.w || y >= map.h ? T.BLOCK : map.t[y * map.w + x]; }
  function speed(map, x, y, mv) {
    var c = code(map, x, y);
    return INFO[c][typeof mv === 'number' ? mv : MOVE_I[mv]];
  }
  function canStand(map, x, y, mv) { return speed(map, x, y, mv) > 0; }
  // Переход в соседнюю клетку: высоты равны или одна из клеток — склон (разница не больше 1)
  function canStep(map, x0, y0, x1, y1, mv) {
    var m = typeof mv === 'number' ? mv : MOVE_I[mv];
    if (!canStand(map, x1, y1, m)) return false;
    if (m === 3) return true;
    var W = map.w, a = map.e[y0 * W + x0], b = map.e[y1 * W + x1];
    if (a === b) return x0 === x1 || y0 === y1 || (canStand(map, x1, y0, m) && canStand(map, x0, y1, m));
    if (Math.abs(a - b) > 1) return false;
    var ra = map.t[y0 * W + x0] === T.RAMP, rb = map.t[y1 * W + x1] === T.RAMP;
    // склон стоит на нижней высоте и ведёт на верхнюю — переход только по прямой
    if (!(ra && a < b) && !(rb && b < a)) return false;
    return x0 === x1 || y0 === y1;
  }
  // Поместится ли машина size×size, левый верхний угол (x, y): все клетки годны, и машина
  // стоит ровно — или наполовину на склоне (нижние клетки — склон, верхние — на 1 выше)
  function canBox(map, x, y, size, mv) {
    var lo = 99, hi = -1, i, j;
    for (j = 0; j < size; j++) for (i = 0; i < size; i++) {
      if (!canStand(map, x + i, y + j, mv)) return false;
      var e = map.e[(y + j) * map.w + x + i];
      if (e < lo) lo = e; if (e > hi) hi = e;
    }
    if (MOVE_I[mv] === 3 || hi === lo) return true;
    if (hi - lo > 1) return false;
    for (j = 0; j < size; j++) for (i = 0; i < size; i++) {
      var k = (y + j) * map.w + x + i;
      if (map.e[k] === lo && map.t[k] !== T.RAMP) return false;
    }
    return true;
  }
  function blocksLos(map, x, y) { return INFO[code(map, x, y)][5] === 1; }
  function coverAt(map, x, y) { return INFO[code(map, x, y)][4]; }
  function heightAt(map, x, y) { return x < 0 || y < 0 || x >= map.w || y >= map.h ? 0 : map.e[y * map.w + x]; }

  return {
    N: N, T: T, NAME: NAME, INFO: INFO, MOVE: MOVE, MOVE_I: MOVE_I, UNIT_MOVE: UNIT_MOVE, WEATHER: WEATHER, GEO: GEO,
    moveOf: moveOf, pack: pack, unpack: unpack, load: load, save: save,
    code: code, speed: speed, canStand: canStand, canStep: canStep, canBox: canBox,
    blocksLos: blocksLos, coverAt: coverAt, heightAt: heightAt
  };
});
