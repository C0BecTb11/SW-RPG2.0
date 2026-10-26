// Армия корабля для боя 2.0 — из того, что есть в игре.
//
// В бою на корабле только те бойцы, что куплены и погружены в трюм (unit_positions
// с carrier_ship_id), и только те истребители, что стоят в его ангаре (ships с
// carrier_ship_id). Экипаж приходит с кораблём; погибшие выбывают до пополнения
// на верфи (ships.crew_lost — следующий шаг, пока читается, если есть).
//
// Здесь: бойцы по типам (фигурка, оружие, урон), трюмы и ангары кораблей,
// «типовой состав» для полигона (явно, с ценой) и перевод строк базы в описание
// корабля для SWSpace.Battle.addShip. ES5, браузер и Node.

(function(root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SWArmy = api;
})(typeof self !== 'undefined' ? self : this, function() {
  'use strict';

  // Пехота: [имя, сторона, здоровье, урон, цена, фигурка, оружие, особое]
  // особое: eng — ставит заряд и вскрывает двери вдвое быстрее; medic; hero — герой
  var UNIT = {
    rep_dc15a:      ['Клон с DC-15A', 0, 100, 20, 100, 'rep_dc15a', 'rifle'],
    rep_heavy:      ['Клон-пулемётчик', 0, 120, 35, 200, 'rep_heavy', 'heavy'],
    rep_sniper:     ['Клон-снайпер', 0, 70, 40, 220, 'rep_sniper', 'sniper'],
    rep_launcher:   ['Клон-гранатомётчик', 0, 90, 45, 250, 'rep_heavy', 'launcher'],
    rep_arc:        ['Клон ARC', 0, 150, 40, 400, 'rep_dc15a', 'rifle'],
    rep_commando:   ['Клон-коммандос', 0, 200, 60, 800, 'rep_heavy', 'rifle'],
    rep_engineer:   ['Клон-инженер', 0, 100, 12, 900, 'rep_engineer', 'tool', 'eng'],
    rep_medic:      ['Клон-медик', 0, 100, 15, 400, 'rep_medic', 'rifle', 'medic'],
    rep_officer:    ['Клон-офицер', 0, 150, 40, 600, 'rep_officer', 'rifle'],
    rep_militia:    ['Ополченец', 0, 70, 14, 0, 'rep_dc15a', 'rifle'],
    rep_jedi:       ['Джедай', 0, 280, 120, 2500, 'rep_officer', 'saber', 'hero'],
    cis_b1:         ['Дроид B1', 1, 70, 15, 60, 'cis_b1', 'b1'],
    cis_b2:         ['Дроид B2', 1, 160, 35, 220, 'cis_b2', 'b2'],
    cis_bx:         ['BX-коммандос', 1, 140, 45, 400, 'cis_bx', 'bx'],
    cis_b1_sniper:  ['B1-снайпер', 1, 60, 40, 190, 'cis_b1', 'sniper'],
    cis_b1_launcher:['B1-гранатомётчик', 1, 70, 45, 200, 'cis_b1', 'launcher'],
    cis_engineer:   ['Инженерный дроид', 1, 80, 10, 800, 'cis_engineer', 'tool', 'eng'],
    cis_medic:      ['Дроид-техник', 1, 100, 15, 400, 'cis_medic', 'b1', 'medic'],
    cis_bounty:     ['Охотник за головами', 1, 180, 55, 700, 'cis_bx', 'bx'],
    cis_hunter:     ['Трандошанский следопыт', 1, 220, 45, 700, 'cis_bx', 'bx'],
    cis_militia:    ['Ополченец', 1, 70, 14, 0, 'cis_b1', 'b1'],
    cis_sith:       ['Ситх', 1, 340, 155, 4000, 'cis_b1_cmd', 'saber', 'hero']
  };
  // Урон оружия в бою внутри рассчитан на «базового» бойца; сильнее по урону в
  // игре — во столько же раз сильнее и здесь
  var WPN_BASE = { rifle: 20, heavy: 35, b1: 15, b2: 35, bx: 45, tool: 12, saber: 120, sniper: 40, launcher: 45 };

  // Корабли: [имя в игре, сторона, трюм (слоты), ангар (машин)] — из ship_types
  var SHIP = {
    venator: ['Венатор', 0, 30, 3], acclamator: ['Акламатор', 0, 28, 0], rep_mandator: ['Мандатор', 0, 40, 6],
    rep_victory: ['Победа', 0, 36, 2], rep_valiant: ['Валиант', 0, 6, 0], rep_arquitens: ['Аркитенс', 0, 10, 0], tantive: ['Тантив', 0, 8, 0],
    providence: ['Провидение', 1, 30, 3], munificent: ['Щедрый', 1, 28, 0], cis_subjugator: ['Покоритель', 1, 30, 4],
    cis_lucrehulk: ['Лукрехалк', 1, 50, 8], cis_recusant: ['Бунтарь', 1, 6, 0], cis_diamond: ['Алмаз', 1, 12, 0], hardcell: ['Хардсел', 1, 12, 0]
  };
  // Истребители в ангаре: тип корабля в игре → машина боя
  var CRAFT = { rep_arc170: 'arc170', rep_ywing: 'ywing', cis_vulture: 'vulture', cis_hyena: 'hyena' };
  // Типовой ангар (для полигона): полный по hangar_slots, одна машина на место — как в игре
  var HANGAR = { venator: ['arc170', 'arc170', 'ywing'], providence: ['vulture', 'vulture', 'hyena'], rep_mandator: ['arc170', 'arc170', 'arc170', 'ywing', 'ywing', 'arc170'],
                 rep_victory: ['arc170', 'ywing'], cis_subjugator: ['vulture', 'vulture', 'hyena', 'hyena'],
                 cis_lucrehulk: ['vulture', 'vulture', 'vulture', 'vulture', 'hyena', 'hyena', 'vulture', 'hyena'] };

  function unit(id) { return Object.prototype.hasOwnProperty.call(UNIT, id) ? UNIT[id] : null; }
  function shipName(id) { return SHIP[id] ? SHIP[id][0] : id; }

  // Боец трюма → запись состава: { type, hp, hpMax, name, uid }
  // dmgX — улучшение урона бойца в игре (bonus_damage)
  function soldier(type, hp, hpMax, name, uid, dmgX) {
    var u = unit(type); if (!u) return null;
    var mx = hpMax || u[2], h = hp == null ? mx : hp;
    if (h <= 0) return null;                              // погибший в базе — не боец
    return { type: type, hp: Math.min(mx, h), hpMax: mx, name: name || '', uid: uid || '', dmgX: dmgX || 1 };
  }
  // Для экипажа боя: фигурка, оружие, множитель урона, особое
  function kit(type) {
    var u = unit(type); if (!u) return null;
    return { fig: u[5], wpn: u[6], dmgK: u[3] / (WPN_BASE[u[6]] || 20), eng: u[7] === 'eng', medic: u[7] === 'medic', hero: u[7] === 'hero', label: u[0] };
  }

  // Типовой состав трюма (только для полигона и проверок — в игре бойцов покупают):
  // инженер для заряда, медик, пулемётчики/B2, снайпер, остальное — линейная пехота
  function typical(shipId, fill) {
    var S = SHIP[shipId]; if (!S) return [];
    var cap = Math.round(S[2] * (fill == null ? 1 : fill)), side = S[1], out = [];
    var add = function(t, n) { for (var i = 0; i < n && out.length < cap; i++) out.push(soldier(t)); };
    if (side === 0) {
      add('rep_engineer', 1); if (cap >= 10) add('rep_medic', 1);
      add('rep_heavy', Math.floor(cap * 0.2)); if (cap >= 20) add('rep_sniper', 1);
      add('rep_dc15a', cap);
    } else {
      add('cis_engineer', 1); if (cap >= 10) add('cis_medic', 1);
      add('cis_b2', Math.floor(cap * 0.25)); if (cap >= 20) add('cis_bx', 1);
      add('cis_b1', cap);
    }
    return out;
  }
  // Типовая армия корабля для полигона: полный трюм и штатный ангар
  function typicalArmy(shipId, fill) { return { roster: typical(shipId, fill), hangar: (HANGAR[shipId] || []).slice(), typical: true }; }
  function cost(roster) { var c = 0; (roster || []).forEach(function(s) { var u = unit(s.type); if (u) c += u[4]; }); return c; }
  // Сводка состава: [[имя, число], …] по убыванию
  function summary(roster) {
    var m = {}, order = [];
    (roster || []).forEach(function(s) { var u = unit(s.type); var k = s.name ? '★ ' + s.name + ' (' + (u ? u[0] : s.type) + ')' : (u ? u[0] : s.type); if (!m[k]) { m[k] = 0; order.push(k); } m[k]++; });
    return order.map(function(k) { return [k, m[k]]; }).sort(function(a, b) { return b[1] - a[1]; });
  }

  // Строки базы → описание корабля для боя.
  //  ship  — строка ships (hp, shield_*, bonus_*, name, ship_type, id)
  //  type  — строка ship_types (max_hp, max_shield, damage) или null
  //  units — строки unit_positions с carrier_ship_id = ship.id
  //  craft — строки ships с carrier_ship_id = ship.id (истребители в ангаре)
  //  opt   — { now (мс), regenSec } для подзарядки щитов, как ship_shields в игре
  function fromGame(ship, type, units, craft, opt) {
    opt = opt || {};
    var roster = [], vehicles = [], other = [];
    (units || []).forEach(function(u) {
      var k = unit(u.unit_type), n = Math.max(1, u.quantity || 1);
      for (var i = 0; i < n; i++) {
        if (k) { var sd = soldier(u.unit_type, u.hp, k[2] + (u.bonus_hp || 0), u.hero_name || '', u.id, (k[3] + (u.bonus_damage || 0)) / k[3]); if (sd) roster.push(sd); }
        else if (/aat|atte|atrt|barc|stap|hmp|mtt|laat|turbo|spider|missile|artillery|aa$/.test(u.unit_type)) vehicles.push(u.unit_type);
        else other.push(u.unit_type);
      }
    });
    var maxHp = type ? (type.max_hp || 0) + (ship.bonus_hp || 0) : null;
    var maxSh = type ? (type.max_shield || 0) + (ship.bonus_shield || 0) : null;
    var dmg = type && type.damage ? (type.damage + (ship.bonus_damage || 0)) / type.damage : 1;
    // щит, как его считает игра: записанное при последнем ударе + подзарядка с тех пор, не выше предела;
    // трофей до ремонта — без щитов
    var regen = 0;
    if (ship.shields_updated_at && type && type.shield_regen) {
      var step = (opt.regenSec || 30) * 1000, now = opt.now || Date.now();
      regen = Math.max(0, Math.floor((now - new Date(ship.shields_updated_at).getTime()) / step)) * type.shield_regen;
    }
    var off = !!ship.trophy;
    var sh = function(v, extra) {
      if (maxSh == null) return null;
      var cap = Math.max(1, maxSh + (extra || 0));
      return off ? 0 : Math.max(0, Math.min(1, ((Number(v) || 0) + regen) / cap));
    };
    return {
      cls: ship.ship_type, id: ship.id, name: ship.name || shipName(ship.ship_type),
      hpK: maxHp && ship.hp != null ? Math.max(0.02, Math.min(1, ship.hp / maxHp)) : 1, hpBonus: maxHp && type.max_hp ? maxHp / type.max_hp : 1,
      shK: [sh(ship.shield_fore, ship.bonus_fore), sh(ship.shield_starboard), sh(ship.shield_aft), sh(ship.shield_port)],
      shBonus: type && type.max_shield ? maxSh / type.max_shield : 1, dmgK: dmg,
      foreK: maxSh > 0 && ship.bonus_fore > 0 ? (maxSh + Number(ship.bonus_fore)) / maxSh : 1,   // носовой сектор («Мастер лобовой атаки»)
      moveB: ship.bonus_move || 0, visB: ship.bonus_vision || 0,             // ход и сонар из исследований (клетки игры)
      tractor: !!(ship.has_tractor || (ship.upgrades || []).indexOf('tractor') >= 0),   // исследование «Притягивающие лучи»
      roster: roster, vehicles: vehicles, other: other,
      hangar: (craft || []).map(function(c) { return CRAFT[c.ship_type]; }).filter(Boolean),
      crewLost: ship.crew_lost || 0
    };
  }

  return { UNIT: UNIT, SHIP: SHIP, CRAFT: CRAFT, HANGAR: HANGAR, WPN_BASE: WPN_BASE, unit: unit, kit: kit, soldier: soldier,
           typical: typical, typicalArmy: typicalArmy, cost: cost, summary: summary, fromGame: fromGame, shipName: shipName };
});
