// Бойцы и техника наземки 2.0 — снимок unit_types, damage_matrix и structure_types из
// базы игры (17.10.2026) и перевод их чисел в реальное время.
//
// В игре ход пошаговый: 2 очка действия, по одному за 30 с; move_range — клеток за ход,
// damage — урон за выстрел, accuracy − evasion — шанс попасть. Здесь:
//   скорость   = move_range × SPEED_K клеток/с (пехота 4 → 1,4 кл/с: через карту ~100 с);
//   выстрел    — раз в rof секунд (по классу корпуса), урон тот же damage × матрица;
//   меткость   = clamp(5..95, accuracy − evasion) × укрытие × дальность, как в игре;
//   дальность  = weapon_range (клетки), обзор = vision_range;
//   артиллерия — залп по площади splash_size раз в ART_ROF с.
// Так средняя «скорость убийства» та же, что в игре за ход, только без ожидания очков.
// ES5, браузер и Node.

(function(root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SWUnits = api;
})(typeof self !== 'undefined' ? self : this, function() {
  'use strict';

  // id: [имя, сторона(0 респ, 1 КНС, 2 мародёры), класс, hp, урон, ход, дальность, обзор, меткость, уклонение,
  //      клеток по стороне, слоты (место в трюме), везёт (слоты), флаги]
  // флаги: v — техника, h — герой, s — разведчик (скрытный, stealth_range), r — ретранслятор, b — строит, a — артиллерия (splash),
  //        w — Колесо Смерти: катится быстро и без стрельбы, на месте раскрывается, ставит щит и бьёт спаренными бластерами
  var U = {
    rep_dc15a:      ['Клон с DC-15A', 0, 'infantry', 100, 20, 4, 3, 5, 75, 10, 1, 1, 0, ''],
    rep_heavy:      ['Клон-пулемётчик', 0, 'infantry', 120, 35, 4, 3, 4, 75, 10, 1, 1, 0, ''],
    rep_sniper:     ['Клон-снайпер', 0, 'infantry', 70, 40, 4, 3, 8, 75, 10, 1, 1, 0, ''],
    rep_launcher:   ['Клон-гранатомётчик', 0, 'infantry', 90, 45, 4, 3, 4, 75, 10, 1, 1, 0, ''],
    rep_arc:        ['Клон ARC', 0, 'infantry', 150, 40, 4, 3, 7, 75, 10, 1, 1, 0, 'r'],
    rep_commando:   ['Клон-коммандос', 0, 'infantry', 200, 60, 5, 4, 8, 88, 20, 1, 1, 0, ''],
    rep_engineer:   ['Клон-инженер', 0, 'infantry', 100, 12, 4, 3, 6, 70, 10, 1, 1, 0, 'b'],
    rep_medic:      ['Клон-медик', 0, 'infantry', 100, 15, 3, 3, 6, 70, 12, 1, 1, 0, 'm'],
    rep_officer:    ['Клон-офицер', 0, 'infantry', 150, 40, 4, 4, 9, 85, 15, 1, 1, 0, ''],
    rep_militia:    ['Ополченец', 0, 'infantry', 70, 14, 3, 3, 5, 65, 10, 1, 1, 0, ''],
    rep_probe:      ['Зонд-разведчик', 0, 'infantry', 50, 0, 7, 0, 12, 60, 35, 1, 1, 0, 's5'],
    rep_jedi:       ['Джедай', 0, 'hero', 280, 120, 6, 1, 8, 95, 45, 1, 1, 0, 'h'],
    rep_atrt:       ['AT-RT', 0, 'vehicle', 180, 40, 6, 5, 9, 80, 5, 1, 2, 0, 'v'],
    rep_barc:       ['Спидер BARC', 0, 'vehicle', 140, 35, 6, 5, 10, 80, 5, 1, 2, 0, 'v'],
    rep_atte:       ['AT-TE', 0, 'vehicle', 600, 90, 6, 5, 6, 80, 5, 2, 6, 0, 'v'],
    rep_laat:       ['Канонерка LAAT', 0, 'vehicle', 300, 50, 8, 5, 8, 80, 5, 2, 4, 8, 'v'],
    rep_turbo:      ['Турботанк HAVw A6', 0, 'vehicle', 350, 30, 5, 4, 7, 72, 6, 2, 4, 8, 'v'],
    rep_aa:         ['Зенитный танк TX-130', 0, 'aa', 420, 60, 4, 7, 10, 82, 5, 2, 6, 0, 'v'],
    rep_artillery:  ['Артиллерия SPHA', 0, 'artillery', 380, 140, 2, 144, 3, 75, 0, 2, 8, 0, 'va3'],
    rep_arc170:     ['ARC-170', 0, 'air', 90, 30, 6, 4, 9, 80, 30, 1, 2, 0, 'v'],
    rep_ywing:      ['Y-wing', 0, 'air', 140, 80, 5, 4, 7, 80, 30, 1, 2, 0, 'v'],
    cis_b1:         ['Дроид B1', 1, 'infantry', 70, 15, 4, 3, 5, 75, 10, 1, 1, 0, ''],
    cis_b1_launcher:['B1-гранатомётчик', 1, 'infantry', 70, 45, 4, 3, 4, 75, 10, 1, 1, 0, ''],
    cis_b1_sniper:  ['B1-снайпер', 1, 'infantry', 60, 40, 4, 3, 8, 75, 10, 1, 1, 0, ''],
    cis_b2:         ['Дроид B2', 1, 'infantry', 160, 35, 4, 3, 4, 75, 10, 1, 1, 0, ''],
    cis_bx:         ['BX-коммандос', 1, 'infantry', 140, 45, 4, 3, 7, 75, 10, 1, 1, 0, 'r'],
    cis_bounty:     ['Охотник за головами', 1, 'infantry', 180, 55, 5, 5, 8, 85, 25, 1, 1, 0, ''],
    cis_hunter:     ['Трандошанский следопыт', 1, 'infantry', 220, 45, 4, 4, 10, 80, 15, 1, 1, 0, ''],
    cis_engineer:   ['Инженерный дроид', 1, 'infantry', 80, 10, 4, 3, 6, 70, 10, 1, 1, 0, 'b'],
    cis_medic:      ['Дроид-техник', 1, 'infantry', 100, 15, 3, 3, 6, 70, 12, 1, 1, 0, 'm'],
    cis_militia:    ['Ополченец', 1, 'infantry', 70, 14, 3, 3, 5, 65, 10, 1, 1, 0, ''],
    cis_wheel:      ['Колесо Смерти', 1, 'infantry', 150, 25, 9, 4, 6, 78, 12, 1, 1, 0, 'w'],
    cis_probe:      ['Зонд-разведчик', 1, 'infantry', 50, 0, 7, 0, 12, 60, 35, 1, 1, 0, 's5'],
    cis_sith:       ['Ситх', 1, 'hero', 340, 155, 6, 1, 8, 96, 50, 1, 1, 0, 'h'],
    cis_stap:       ['Спидер STAP', 1, 'vehicle', 120, 35, 9, 4, 10, 76, 30, 1, 2, 0, 'v'],
    cis_aat:        ['Танк AAT', 1, 'vehicle', 600, 90, 6, 5, 6, 80, 5, 2, 6, 0, 'v'],
    cis_mtt:        ['Транспорт MTT', 1, 'vehicle', 350, 30, 5, 4, 7, 72, 6, 2, 4, 8, 'v'],
    cis_hmp:        ['Канонерка HMP', 1, 'vehicle', 300, 50, 8, 5, 8, 80, 5, 2, 4, 8, 'v'],
    cis_missile:    ['Ракетный шагоход', 1, 'vehicle', 480, 95, 3, 8, 8, 78, 4, 2, 6, 0, 'v'],
    cis_spider:     ['Паук-дроид ПВО', 1, 'aa', 420, 60, 4, 7, 10, 82, 5, 2, 6, 0, 'v'],
    cis_artillery:  ['Артиллерия КНС', 1, 'artillery', 380, 140, 2, 144, 3, 75, 0, 2, 8, 0, 'va3'],
    cis_vulture:    ['Стервятник', 1, 'air', 90, 30, 6, 4, 9, 80, 30, 1, 2, 0, 'v'],
    cis_hyena:      ['Гиена', 1, 'air', 140, 80, 5, 4, 7, 80, 30, 1, 2, 0, 'v'],
    marauder:       ['Мародёр', 2, 'infantry', 60, 15, 3, 3, 5, 75, 10, 1, 1, 0, '']
  };

  // Матрица урона (атакующий класс → цель), наземная часть damage_matrix
  var DM = {
    infantry: { infantry: 1, vehicle: 0.4, air: 0.5, aa: 0.4, hero: 1, artillery: 0.4, structure: 0.5 },
    vehicle:  { infantry: 1.3, vehicle: 1, air: 0.5, aa: 1, hero: 1.2, artillery: 1.1, structure: 1.5 },
    air:      { infantry: 1, vehicle: 1.6, air: 1, aa: 1.2, artillery: 1.8, structure: 1.2, hero: 1 },
    aa:       { air: 2.5, infantry: 0.5, vehicle: 0.4, aa: 0.8, hero: 0.5, artillery: 0.4, structure: 0.5 },
    hero:     { infantry: 1, vehicle: 1, aa: 1, air: 0.6, hero: 1, artillery: 1, structure: 1 },
    artillery:{ infantry: 1.2, vehicle: 1, aa: 1, hero: 1, artillery: 1, structure: 2, air: 0.3 },
    turret:   { infantry: 1, vehicle: 0.5, air: 0.6, aa: 0.6, hero: 0.8, artillery: 0.6, structure: 0.5 }
  };
  function mult(a, t) { var r = DM[a]; return r && r[t] != null ? r[t] : 1; }

  // Полевые постройки инженеров (structure_types): [имя, вид, размер, прочность, укрытие %, множитель урона изнутри,
  //   радиус, урон турели, меткость, можно войти, только пехота]
  var ST = {
    trench:    ['Окоп', 1, 200, 20, 1, 0, 0, 0, true, true],
    bunker:    ['Бункер', 2, 900, 50, 2, 0, 0, 0, true, true],
    turret:    ['Турель', 1, 150, 0, 1, 5, 30, 75, false, false],
    jammer:    ['Глушилка', 2, 50, 0, 1, 12, 0, 0, false, false],
    camo:      ['Маскировочная сеть', 1, 80, 0, 1, 1, 0, 0, true, true],
    radar:     ['Радар', 2, 50, 0, 1, 10, 0, 0, false, false],
    extractor: ['Добытчик', 2, 250, 0, 1, 0, 0, 0, false, false],
    cantina:   ['Кантина', 3, 600, 0, 1, 0, 0, 0, false, false],
    // город (shared/rt-town): ворота — свои проходят, чужие ломают; башня — турель на бастионе 2×2
    gate:      ['Ворота', 1, 1200, 0, 1, 0, 0, 0, true, false],
    tower:     ['Башня', 2, 500, 0, 1, 7, 40, 78, false, false]
  };
  function structKind(typeId) { return (typeId || '').replace(/^(rep|cis)_/, '').replace(/^mine_.*/, 'extractor'); }

  // ---------------------------------------------------------------- реальное время
  var SPEED_K = 0.35;                      // клеток/с на единицу move_range
  var ROF = { infantry: 1.6, hero: 0.9, vehicle: 2.4, aa: 1.2, air: 1.4, artillery: 12, turret: 6 };   // секунд между выстрелами
  var AIM_FALLOFF = 0.5;                   // на предельной дальности меткость ×(1 − это)
  var TURRET_TURN = 2.4;                   // рад/с — поворот башни
  var AA_VS_AIR_RANGE = 1;                 // ПВО бьёт по воздуху на полную дальность, остальные — на половину

  function get(id) { return U[id] || null; }
  function hasFlag(u, f) { return u && u[13].indexOf(f) >= 0; }
  // Полное описание типа для боя
  function type(id) {
    var u = U[id]; if (!u) return null;
    var cls = u[2];
    var fl = u[13], sm = /s(\d)/.exec(fl), am = /a(\d)/.exec(fl);
    return {
      id: id, name: u[0], side: u[1], cls: cls, hp: u[3], dmg: u[4],
      speed: u[5] * SPEED_K, range: u[6], vision: u[7], acc: u[8], eva: u[9], size: u[10], slots: u[11], carry: u[12],
      vehicle: fl.indexOf('v') >= 0, hero: fl.indexOf('h') >= 0, scout: !!sm, stealth: sm ? +sm[1] : 0, relay: fl.indexOf('r') >= 0,
      builder: fl.indexOf('b') >= 0, medic: fl.indexOf('m') >= 0, wheel: fl.indexOf('w') >= 0, artillery: !!am, splash: am ? +am[1] : 0,
      rof: ROF[cls] || 1.6, air: cls === 'air',
      move: cls === 'air' ? 'air' : fl.indexOf('v') >= 0 ? (id === 'cis_aat' || id === 'cis_mtt' || id === 'cis_stap' || id === 'rep_barc' ? 'hover' : (id === 'rep_laat' || id === 'cis_hmp' ? 'air' : 'track')) : 'foot'
    };
  }
  // Шанс попасть: как в игре, плюс укрытие и спад по дальности
  function hitChance(att, tgt, d, cover) {
    var p = Math.max(5, Math.min(95, att.acc - tgt.eva)) / 100;
    var f = att.range > 1 ? Math.max(0, Math.min(1, (d - 1) / Math.max(1, att.range - 1))) : 0;
    return p * (1 - AIM_FALLOFF * f * f) * (cover == null ? 1 : cover);
  }
  function damage(att, tgt, inside) {
    return Math.round(att.dmg * mult(att.cls, tgt.cls) * (inside || 1));
  }
  function all(side) { var out = []; for (var k in U) if (side == null || U[k][1] === side) out.push(k); return out; }

  return { U: U, DM: DM, ST: ST, SPEED_K: SPEED_K, ROF: ROF, TURRET_TURN: TURRET_TURN, get: get, type: type, mult: mult, hitChance: hitChance, damage: damage, all: all, structKind: structKind, hasFlag: hasFlag };
});
