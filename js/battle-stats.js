// Характеристики и тексты в единицах боя 2.0: карточка найма, исследования, полевые постройки.
// Бой считает по shared/rt-units.js (SWUnits) и shared/rt-ground.js (SWGround): дальность и обзор
// в клетках игры там ×3 (клетки поля боя), «ход» — скорость в клетках в секунду, темп стрельбы —
// по классу. Здесь те же числа, чтобы игрок видел то, что получит в бою, а не старые «клетки за ход».
// Корабли (scope = ship) — по формулам shared/rt-space.js: скорость (ход) × 9 м/с, датчики +1 км на единицу.

var BS_RK = 3;                                     // RANGE_K в rt-ground.js: клетка игры = 3 клетки боя
var BS_CLS = { infantry: 'пехота', hero: 'одарённые', vehicle: 'техника', aa: 'ПВО', artillery: 'артиллерия', air: 'авиация', structure: 'постройки' };
var BS_ORDER = ['infantry', 'hero', 'vehicle', 'aa', 'artillery', 'air', 'structure'];

function bsU() { return typeof SWUnits !== 'undefined' ? SWUnits : null; }
function bsG() { return typeof SWGround !== 'undefined' ? SWGround : null; }
// 1,4 · 0,35 — до двух цифр после запятой, целые — без неё
function bsNum(v) { var r = Math.round(v * 100) / 100; return String(r).replace('.', ','); }
function bsType(id) { var U = bsU(); return U && id ? U.type(id) : null; }
function bsCd(k, def) { var G = bsG(); return G && G.SKILL && G.SKILL[k] ? G.SKILL[k].cd : def; }

// Карточка найма: [значок, подпись, значение, подсказка] — как бой 2.0 видит бойца
function bsUnitStats(id) {
  var T = bsType(id); if (!T) return null;
  var out = [['❤', 'Прочность', T.hp]];
  if (T.hero) out.push(['⚔', 'Клинок', T.dmg], ['◷', 'Удар', '~1,5 с', 'удар клинком раз в ~1,5 с']);
  else if (T.dmg > 0) out.push(['⚔', 'Урон', T.wheel ? T.dmg + '×2' : T.dmg], ['◷', 'Выстрел', bsNum(T.rof) + ' с', 'выстрел раз в ' + bsNum(T.rof) + ' с']);
  if (T.artillery) out.push(['➶', 'Дальн.', '∞', 'на всю карту — куда видят свои']);
  else if (T.hero) out.push(['➶', 'Дальн.', 'вплотную']);
  else if (T.dmg > 0) out.push(['➶', 'Дальн.', T.range * BS_RK + ' кл.', 'дальность стрельбы в клетках поля боя']);
  out.push(['➔', 'Ход', bsNum(T.speed) + ' кл/с', 'скорость: клеток поля в секунду'], ['◉', 'Обзор', T.vision * BS_RK + ' кл.', 'обзор в клетках поля боя']);
  if (T.dmg > 0) out.push(['◎', 'Меткость', T.acc, 'шанс попасть в упор: меткость минус уклонение цели, %']);
  out.push(['⛨', 'Уклон', T.eva, 'уклонение: на столько меньше шанс попасть по нему']);
  return out;
}

// По кому бьёт сильнее и слабее (матрица урона боя): [['up'|'down', текст]]
function bsUnitMatrix(id) {
  var U = bsU(), T = bsType(id); if (!U || !T || T.dmg <= 0) return [];
  var up = {}, down = {};
  BS_ORDER.forEach(function(c) {
    if (T.artillery && c === 'air') return;                   // авиацию артиллерия не берёт — ниже отдельной строкой
    var m = U.mult(T.cls, c), key = bsNum(m);
    if (m >= 1.2) (up[key] = up[key] || []).push(BS_CLS[c]);
    else if (m <= 0.6) (down[key] = down[key] || []).push(BS_CLS[c]);
  });
  var join = function(g, desc) {
    return Object.keys(g).sort(function(a, b) { var x = parseFloat(a.replace(',', '.')), y = parseFloat(b.replace(',', '.')); return desc ? y - x : x - y; })
      .map(function(k) { return g[k].join(', ') + ' ×' + k; }).join(' · ');
  };
  var lines = [];
  if (Object.keys(up).length) lines.push(['up', '▲ Урон выше: ' + join(up, true)]);
  if (Object.keys(down).length) lines.push(['down', '▼ Урон ниже: ' + join(down, false)]);
  return lines;
}

// Особые строки карточки: [класс строки ('arty' — золото, '' — зелёная), текст]
function bsUnitNotes(id) {
  var T = bsType(id); if (!T) return [];
  var G = bsG(), out = [];
  var med = G && G.MEDIC ? G.MEDIC : { every: 2, r: 3, hp: 8 };
  if (T.artillery) out.push(['arty', '✹ Залп по кругу ' + T.splash + ' кл. в любую точку, которую видят свои · раз в ~' + bsNum(T.rof) + ' с · задевает и своих · авиацию не берёт']);
  if (T.hero) out.push(['', '⚔ Ближний бой: клинок достаёт вплотную. Силы и пассивы — в древе одарённого']);
  if (T.cls === 'aa') out.push(['', '▲ По авиации — на полную дальность']);
  else if (T.vehicle && T.cls === 'vehicle' && T.dmg > 0) out.push(['', 'По авиации сам не стреляет — только по приказу, на половину дальности']);
  else if (T.cls === 'infantry' && T.dmg > 0) out.push(['', 'По авиации — на половину дальности']);
  if (/launcher/.test(id)) out.push(['arty', '✹ Осколки: круг 1,6 кл. вокруг попадания, половина урона, задевают и своих']);
  if (id === 'cis_missile') out.push(['arty', '✹ Осколки: круг 2 кл. вокруг попадания, половина урона, задевают и своих']);
  if (T.wheel) out.push(['', 'Катится ' + bsNum(T.speed) + ' кл/с, на ходу не стреляет · встав, за секунду раскрывается: щит ' + (G && G.WHEEL ? G.WHEEL.sh : 180) + ' и два ствола']);
  if (T.scout) out.push(['', 'Не стреляет · враг замечает его только ближе ' + T.stealth * BS_RK + ' кл. или радаром · может улететь на соседнюю планету']);
  if (T.builder) out.push(['', '⚒ Строит окоп, а после изучения — укрепления и добычу']);
  if (T.medic) out.push(['', '✚ Лечит своих в ' + med.r + ' кл.: +' + med.hp + ' раз в ' + med.every + ' с самому раненому']);
  if (T.move === 'air' && T.cls !== 'air') out.push(['', 'Летит над местностью: ни стены, ни вода не мешают']);
  return out;
}

// ---- исследования

// Цена дополнения за бойца при найме — как order_unit: researches.unit_price (у B1 — своя, дешёвая:
// B1 — дешёвая масса), иначе четверть цены изучения. Корабли (order_ship, док) — всегда четверть
var BS_UNIT_PRICE = null;
function bsLoadUnitPrices() {
  if (BS_UNIT_PRICE) return Promise.resolve(BS_UNIT_PRICE);
  if (typeof supabase === 'undefined' || !supabase.from) return Promise.resolve({});
  return supabase.from('researches').select('id, unit_price').not('unit_price', 'is', null).then(function(res) {
    if (res.error) return {};
    var m = {}; (res.data || []).forEach(function(q) { m[q.id] = q.unit_price; });
    BS_UNIT_PRICE = m; return m;
  }, function() { return {}; });
}
function bsUpgradePrice(r) {
  var m = r.scope === 'unit' && BS_UNIT_PRICE || {};
  return m[r.id] != null ? m[r.id] : Math.floor((r.cost || 0) / 4);
}

function bsUnitOf(r) { return r && r.applies_units && r.applies_units.length === 1 ? bsType(r.applies_units[0]) : null; }
function bsArrow(a, b) { return ' (' + a + ' → ' + b + ')'; }

// Что исследование даёт в бою 2.0 — одной строкой
function bsResearchText(r) {
  var v = Number(r.effect_value) || 0, d = Number(r.ability_damage) || 0, T = bsUnitOf(r);
  var sp = function(dm) { return T ? bsArrow(bsNum(T.speed), bsNum(Math.max(0.2, T.speed + dm))) : ''; };
  if (r.scope === 'ship') {
    switch (r.effect_kind) {
      case 'hull':        return '+' + v + ' к прочности корпуса';
      case 'shield':      return '+' + v + ' к щиту каждого сектора';
      case 'fore_shield': return '+' + v + ' к щиту носа: нос держит больше остальных секторов';
      case 'damage':      return '+' + v + ' к урону орудий (ПВО и истребителей не касается)';
      case 'vision':      return 'Датчики +' + v + ' км: корабль видит и бьёт дальше';
      case 'move':        return 'Скорость +' + v * 9 + ' м/с';
      case 'hangar':      return '+' + v + ' ' + (v === 1 ? 'машина' : 'машины') + ' в ангаре';
      case 'capacity':    return '+' + v + ' мест в трюме';
      case 'tractor':     return 'Луч: держит врага 20 с, до 4 км, перезарядка 60 с — кнопка «⊙ Луч» на орбите';
      default:            return '';
    }
  }
  switch (r.effect_kind) {
    case 'hp':           return '+' + v + ' к прочности' + (T ? bsArrow(T.hp, T.hp + v) : '');
    case 'hp_slow':      return '+' + v + ' к прочности' + (T ? bsArrow(T.hp, T.hp + v) : '') + ', скорость −' + bsNum(0.35) + ' кл/с' + sp(-0.35);
    case 'move':         return 'Скорость +' + bsNum(v * 0.35) + ' кл/с' + sp(v * 0.35);
    case 'vision':       return 'Обзор +' + v * BS_RK + ' кл.' + (T ? bsArrow(T.vision * BS_RK, (T.vision + v) * BS_RK) : '');
    case 'damage':       return 'Урон за выстрел +' + v + (T ? bsArrow(T.dmg, T.dmg + v) : '') + ' — сильнее и спецприёмы';
    case 'weapon_range': return 'Дальность +' + v * BS_RK + ' кл.' + (T ? bsArrow(T.range * BS_RK, (T.range + v) * BS_RK) : '');
    case 'ability_grenade':
      return 'Сам, раз в ~' + bsCd('grenade', 24) + ' с: граната в скопление врагов — до ' + d + ' урона каждому в 3 кл., и своим тоже: если своих там не меньше, чем врагов, не бросает';
    case 'ability_he':
      return 'Сам, раз в ~' + bsCd('he', 20) + ' с: фугас по скоплению пехоты — до ' + d + ' урона каждому в 3 кл., и своим тоже; технику не берёт';
    case 'ability_suppression':
      return 'Сам, раз в ~' + bsCd('suppression', 28) + ' с: очередь по скоплению — до ' + d + ' урона каждому в 5 кл., и своим тоже; уцелевшие 6 с залегают: стреляют вдвое хуже и реже';
    case 'ability_stun':
      return v >= 100
        ? 'Сам, раз в ~' + bsCd('stun', 30) + ' с вместо выстрела: разряд без урона — цель 5 с не ходит и не стреляет. Одарённых не берёт'
        : 'Сам, раз в ~' + bsCd('stun', 30) + ' с: верный выстрел, с шансом ' + v + '% цель 5 с не ходит и не стреляет. Одарённых не берёт';
    case 'ability_ap':
      return 'Сам, раз в ~' + bsCd('ap', 14) + ' с по технике: верное попадание с двойным уроном';
    case 'ability_headshot':
      return 'Сам, раз в ~' + bsCd('headshot', 45) + ' с: верный выстрел — пехоту убивает наповал, одарённому снимает четверть прочности; по технике не работает';
    case 'ability_twin':
      return 'Сам, раз в ~' + bsCd('twin', 18) + ' с: верное попадание в цель и с шансом ' + v + '% — во второго врага рядом';
    case 'ability_lunge':
      return 'Сам, раз в ~' + bsCd('lunge', 22) + ' с: прыжок к врагу до ' + v * BS_RK + ' кл. и удар ' + d + ' — укрытие и щит не спасают';
    default: return '';
  }
}

// ---- полевые постройки (structure_types): что делают в бою 2.0
// Радиусы в базе — клетки игры (×3), турель стреляет раз в ROF.turret с, маскировка прячет только бойца внутри
function bsTurretEvery() { var U = bsU(); return U && U.ROF ? U.ROF.turret : 6; }
function bsStructLine(st) {
  switch (st.kind) {
    case 'trench': return 'по бойцу внутри попадают на ' + st.cover_pct + '% реже · сразу отвечает огнём';
    case 'bunker': return 'по пехоте внутри попадают на ' + st.cover_pct + '% реже · её урон ×' + Number(st.damage_mult);
    case 'camo':   return 'боец внутри виден врагу лишь ближе ' + 3 * BS_RK + ' кл. · выстрел выдаёт на 2 мин';
    case 'turret': return 'сама бьёт врагов в ' + st.radius * BS_RK + ' кл. · урон ' + st.damage + ' раз в ' + bsTurretEvery() + ' с';
    case 'jammer': return 'враги в ' + st.radius * BS_RK + ' кл. видят всего на ' + 2 * BS_RK + ' кл.';
    case 'radar':  return 'видит всех врагов в ' + st.radius * BS_RK + ' кл., даже под маскировкой';
    default:       return null;
  }
}
// Значки свойств постройки на её панели: [значок, подсказка, значение]
function bsStructProps(st) {
  switch (st.kind) {
    case 'turret': return [['◎', 'урон', st.damage], ['➶', 'радиус', st.radius * BS_RK + ' кл.'], ['◷', 'выстрел', bsTurretEvery() + ' с']];
    case 'jammer': return [['◈', 'поле помех: враги видят на ' + 2 * BS_RK + ' кл.', st.radius * BS_RK + ' кл.']];
    case 'radar':  return [['◉', 'зона обнаружения', st.radius * BS_RK + ' кл.']];
    case 'camo':   return [['◌', 'боец внутри виден лишь ближе', 3 * BS_RK + ' кл.']];
    default:       return [];
  }
}
