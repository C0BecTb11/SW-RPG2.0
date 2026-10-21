/* Каталог ивентов: что есть, для кого, какие роли, награды и титулы. Одно описание на экран
 * лобби, комнату сервера (shared/rt-events.js) и базу (sql/events.sql повторяет награды и роли —
 * сверяет tools/events/check.js). ES5, UMD → window.SWEventsCat.
 *
 * kind: pvp | pve; theater: ground | space; sides: какие стороны его видят;
 * troops: event — войска выдаёт ивент, own — свои; ready: можно играть (остальное — «скоро»).
 * roles: [{ id, side, min, max, name, about }] — роли и сколько игроков на роль.
 * reward: { cr — кредиты уровня I, res — ресурсы уровня I }; уровни II и III — ×TIER.k.
 * titles: титул за победу на уровне III по ролям.
 */
(function(root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SWEventsCat = api;
})(typeof self !== 'undefined' ? self : this, function() {
  'use strict';

  var TIERS = [
    { n: 1, name: 'Новобранец', k: 1, pts: 10, about: 'Меньше врагов и задач, больше времени, подсказки на карте.' },
    { n: 2, name: 'Ветеран', k: 2.2, pts: 25, about: 'Обычный бой. Часть карт — ночью или в тумане.' },
    { n: 3, name: 'Легенда', k: 4, pts: 60, about: 'Больше задач и элита, меньше времени, почти без подсказок. Титул за победу.' }
  ];
  var LOSS_SHARE = 0.25, LOSS_MIN_SEC = 180;     // утешительная доля проигравшему в PvP, если бой шёл дольше

  var HUNT_SITH_MAPS = ['kaer_tesh', 'holm7', 'sarn', 'mirr_vaal'], HUNT_JEDI_MAPS = ['ul_taren', 'drex', 'kess', 'niir'];

  function ev(o) { o.ready = !!o.ready; o.roles = o.roles || []; o.maps = o.maps || []; o.titles = o.titles || {}; return o; }
  var LIST = [
    // ================================================================ PvP
    ev({ id: 'hunt_sith', kind: 'pvp', theater: 'ground', sides: ['republic', 'cis'], troops: 'event', ready: true, icon: 'sith',
      title: 'Охота на ситха', place: 'Каэр-Теш · Хольм-7 · Сарн · Мирр-Ваал',
      about: 'Один ситх в полной силе против отрядов клонов. Ситх выполняет задачи и уходит на эвакуацию. Охотники выслеживают его по сенсорным импульсам офицеров.',
      goal: { cis: 'Выполни задачи и уйди на эвакуацию — или перебей всех охотников', republic: 'Найди и уничтожь ситха до эвакуации' },
      roles: [{ id: 'sith', side: 'cis', min: 1, max: 1, name: 'Ситх', about: 'Один герой тёмной стороны со всеми силами уровня' },
              { id: 'hunter', side: 'republic', min: 1, max: 4, name: 'Охотник', about: 'Отряд клонов с офицером-сенсорщиком' }],
      maps: HUNT_SITH_MAPS, minutes: [12, 15, 18], reward: { cr: 400, res: { durasteel: 40, electronics: 20 } },
      titles: { sith: 'Неуловимый', hunter: 'Охотник на ситхов' } }),
    ev({ id: 'hunt_jedi', kind: 'pvp', theater: 'ground', sides: ['republic', 'cis'], troops: 'event', ready: true, icon: 'jedi',
      title: 'Охота на джедаев', place: 'Ул-Тарен · Дрэкс · Кесс · Ниир',
      about: 'Один или два джедая против охотников КНС. Джедаи выполняют задачи и уходят. Охотники с наёмником-следопытом идут по их следу.',
      goal: { republic: 'Выполни задачи и уведи джедаев на эвакуацию', cis: 'Выследи и уничтожь джедаев' },
      roles: [{ id: 'jedi', side: 'republic', min: 1, max: 2, name: 'Джедай', about: 'Герой светлой стороны со всеми силами уровня' },
              { id: 'hunter', side: 'cis', min: 1, max: 4, name: 'Охотник', about: 'Отряд дроидов с охотником за головами' }],
      maps: HUNT_JEDI_MAPS, minutes: [12, 15, 18], reward: { cr: 400, res: { durasteel: 40, cells: 20 } },
      titles: { jedi: 'Тень Ордена', hunter: 'Гроза джедаев' } }),
    ev({ id: 'envoy', kind: 'pvp', theater: 'ground', sides: ['republic', 'cis'], troops: 'event', icon: 'envoy', title: 'Посол под огнём', place: 'Перевал Аш-Мерр',
      about: 'Эскорт ведёт посла к шаттлу через горный перевал, засада КНС пытается его перехватить.', reward: { cr: 450, res: { electronics: 40 } } }),
    ev({ id: 'holocron', kind: 'pvp', theater: 'ground', sides: ['republic', 'cis'], troops: 'event', icon: 'holocron', title: 'Голокрон Предтеч', place: 'Руины Сеннар',
      about: 'Две команды борются за три точки в руинах. Кто дольше держит больше точек — забирает голокрон.', reward: { cr: 420, res: { crystals: 25 } } }),
    ev({ id: 'generator', kind: 'pvp', theater: 'ground', sides: ['republic', 'cis'], troops: 'event', icon: 'generator', title: 'Диверсия на генераторе', place: 'Станция Тарвен',
      about: 'Два раунда со сменой сторон: одни подрывают щитовой генератор, другие держат оборону.', reward: { cr: 480, res: { cells: 40 } } }),
    ev({ id: 'blockade', kind: 'pvp', theater: 'space', sides: ['republic', 'cis'], troops: 'event', icon: 'blockade', title: 'Прорыв блокады', place: 'Гипермаяк Вейра',
      about: 'Конвой Республики прорывается к гипермаяку, линия блокады КНС его не пропускает.', reward: { cr: 500, res: { durasteel: 50 } } }),
    ev({ id: 'phantom', kind: 'pvp', theater: 'space', sides: ['republic', 'cis'], troops: 'event', icon: 'phantom', title: 'Охота на «Призрака»', place: 'Туманность Сольвен',
      about: 'Корвет-невидимка КНС против охотников Республики. Охотники ставят сенсорные буи, «Призрак» сбрасывает погоню.', reward: { cr: 500, res: { electronics: 40 } } }),
    ev({ id: 'aces', kind: 'pvp', theater: 'space', sides: ['republic', 'cis'], troops: 'event', icon: 'aces', title: 'Дуэль асов', place: 'Пояс Ксеррен',
      about: 'Звенья истребителей сходятся в поясе астероидов: один на один или два на два.', reward: { cr: 350, res: { cells: 30 } } }),
    ev({ id: 'orbis', kind: 'pvp', theater: 'space', sides: ['republic', 'cis'], troops: 'event', icon: 'station', title: 'Станция «Орбис-9»', place: 'Орбита Орбис',
      about: 'Командные бои за три маяка-ретранслятора вокруг брошенной станции.', reward: { cr: 520, res: { durasteel: 40, electronics: 20 } } }),
    ev({ id: 'flagship', kind: 'pvp', theater: 'space', sides: ['republic', 'cis'], troops: 'own', icon: 'boarding', title: 'Абордаж флагмана', place: 'Дрейф Хааль',
      about: 'Повреждённый флагман: одни прорываются к мостику, другие держат отсеки.', reward: { cr: 650, res: { durasteel: 60 } } }),

    // ================================================================ PvE Республика
    ev({ id: 'r_tessara', kind: 'pve', theater: 'ground', sides: ['republic'], troops: 'own', icon: 'outpost', title: 'Оборона аванпоста «Тессара»', place: 'Тессара', about: 'Волны дроидов на аванпост: 5, 10 или 15 волн.', reward: { cr: 380, res: { durasteel: 40 } } }),
    ev({ id: 'r_veilkrag', kind: 'pve', theater: 'ground', sides: ['republic'], troops: 'event', icon: 'rescue', title: 'Плен на заводе «Вейл-Краг»', place: 'Вейл-Краг', about: 'Скрытно освободить пленных и вывести их к шаттлу.', reward: { cr: 400, res: { food: 60 } } }),
    ev({ id: 'r_duun', kind: 'pve', theater: 'ground', sides: ['republic'], troops: 'event', icon: 'beast', title: 'Логово в кратере Дуун', place: 'Кратер Дуун', about: 'Зачистить гнёзда хищных тварей.', reward: { cr: 360, res: { food: 50 } } }),
    ev({ id: 'r_meltarr', kind: 'pve', theater: 'ground', sides: ['republic'], troops: 'own', icon: 'factory', title: 'Завод «Мелтарр»', place: 'Мелтарр', about: 'Пробиться и подорвать линию сборки дроидов.', reward: { cr: 460, res: { electronics: 40 } } }),
    ev({ id: 'r_pass', kind: 'pve', theater: 'ground', sides: ['republic'], troops: 'event', icon: 'convoy', title: 'Скорбный перевал', place: 'Скорбный перевал', about: 'Провести колонну AT-TE через ущелье.', reward: { cr: 420, res: { durasteel: 40 } } }),
    ev({ id: 'r_bridge', kind: 'pve', theater: 'ground', sides: ['republic'], troops: 'own', icon: 'bridge', title: 'Мост «Квентарр»', place: 'Квентарр', about: 'Удержать мост до подхода подкрепления.', reward: { cr: 400, res: { cells: 40 } } }),
    ev({ id: 'r_beacon', kind: 'pve', theater: 'ground', sides: ['republic'], troops: 'event', icon: 'stealth', title: 'Маяк в тумане', place: 'Топи Ораль', about: 'Провести группу ARC к маяку незамеченной.', reward: { cr: 420, res: { electronics: 30 } } }),
    ev({ id: 'r_hermit', kind: 'pve', theater: 'ground', sides: ['republic'], troops: 'own', icon: 'jedi', title: 'Тропа Отшельника', place: 'Пики Аэн', about: 'Испытание своего джедая против стражей тропы.', reward: { cr: 500, res: { crystals: 20 } } }),
    ev({ id: 'r_mercy', kind: 'pve', theater: 'space', sides: ['republic'], troops: 'event', icon: 'medship', title: 'Госпитальный «Милосердие»', place: 'Орбита Каллиды', about: 'Отбить волны «Стервятников» от госпитального корабля.', reward: { cr: 420, res: { cells: 40 } } }),
    ev({ id: 'r_harron', kind: 'pve', theater: 'space', sides: ['republic'], troops: 'own', icon: 'convoy', title: 'Конвой у Харрона', place: 'Пояс Харрон', about: 'Провести конвой сквозь пояс астероидов.', reward: { cr: 460, res: { durasteel: 50 } } }),
    ev({ id: 'r_terminus', kind: 'pve', theater: 'space', sides: ['republic'], troops: 'own', icon: 'station', title: 'Станция «Терминус»', place: 'Терминус', about: 'Уничтожить станцию снабжения КНС.', reward: { cr: 600, res: { durasteel: 60 } } }),
    ev({ id: 'r_courier', kind: 'pve', theater: 'space', sides: ['republic'], troops: 'event', icon: 'courier', title: 'Перехват курьера', place: 'Трасса Ремма', about: 'Остановить курьера до прыжка в гипер.', reward: { cr: 380, res: { electronics: 30 } } }),
    ev({ id: 'r_pirates', kind: 'pve', theater: 'space', sides: ['republic'], troops: 'own', icon: 'pirates', title: 'Туманность Сайрус-Тан', place: 'Сайрус-Тан', about: 'Разгромить пиратскую базу в туманности.', reward: { cr: 520, res: { gas: 60 } } }),
    ev({ id: 'r_argos', kind: 'pve', theater: 'space', sides: ['republic'], troops: 'event', icon: 'boarding', title: 'Дрейфующий «Аргос»', place: 'Дрейф Мельк', about: 'Спасти экипаж, зачистить дроидов на борту.', reward: { cr: 480, res: { food: 60 } } }),
    ev({ id: 'r_mardos', kind: 'pve', theater: 'space', sides: ['republic'], troops: 'own', icon: 'shipyard', title: 'Верфь «Кольцо Мардоса»', place: 'Мардос', about: 'Тяжёлый рейд на верфь КНС.', reward: { cr: 700, res: { durasteel: 80 } } }),

    // ================================================================ PvE КНС
    ev({ id: 'c_echo', kind: 'pve', theater: 'ground', sides: ['cis'], troops: 'own', icon: 'outpost', title: 'Эхо-Ридж', place: 'Эхо-Ридж', about: 'Штурм аванпоста клонов.', reward: { cr: 420, res: { durasteel: 40 } } }),
    ev({ id: 'c_trials', kind: 'pve', theater: 'ground', sides: ['cis'], troops: 'event', icon: 'droid', title: 'Полевые испытания', place: 'Колония Фенрис', about: 'Рота B2 прорывает оборону колонии.', reward: { cr: 400, res: { electronics: 40 } } }),
    ev({ id: 'c_irridan', kind: 'pve', theater: 'ground', sides: ['cis'], troops: 'own', icon: 'mine', title: 'Кристаллы Ирридана', place: 'Ирридан', about: 'Захватить шахту у местного ополчения.', reward: { cr: 440, res: { crystals: 25 } } }),
    ev({ id: 'c_contract', kind: 'pve', theater: 'ground', sides: ['cis'], troops: 'event', icon: 'bounty', title: 'Контракт на командира', place: 'Застава Корр', about: 'Устранить командира клонов под охраной.', reward: { cr: 460, res: { electronics: 30 } } }),
    ev({ id: 'c_narkess', kind: 'pve', theater: 'ground', sides: ['cis'], troops: 'own', icon: 'city', title: 'Нар-Кесс', place: 'Нар-Кесс', about: 'Подавить восстание в городе.', reward: { cr: 420, res: { food: 60 } } }),
    ev({ id: 'c_aurelis', kind: 'pve', theater: 'ground', sides: ['cis'], troops: 'event', icon: 'lab', title: 'Лаборатория «Аурелис»', place: 'Аурелис', about: 'Похитить данные и вынести их.', reward: { cr: 440, res: { electronics: 40 } } }),
    ev({ id: 'c_siege', kind: 'pve', theater: 'ground', sides: ['cis'], troops: 'own', icon: 'factory', title: 'Завод под осадой', place: 'Завод Векс', about: 'Удержать дроидный завод против волн десанта.', reward: { cr: 460, res: { durasteel: 40 } } }),
    ev({ id: 'c_grotto', kind: 'pve', theater: 'ground', sides: ['cis'], troops: 'own', icon: 'sith', title: 'Грот Шепчущих', place: 'Грот Шепчущих', about: 'Испытание своего ситха.', reward: { cr: 500, res: { crystals: 20 } } }),
    ev({ id: 'c_kolm', kind: 'pve', theater: 'space', sides: ['cis'], troops: 'own', icon: 'ambush', title: 'Дрейф Кольм', place: 'Дрейф Кольм', about: 'Засада на конвой Республики.', reward: { cr: 480, res: { durasteel: 50 } } }),
    ev({ id: 'c_vigil', kind: 'pve', theater: 'space', sides: ['cis'], troops: 'event', icon: 'relay', title: 'Ретранслятор «Вигил»', place: 'Вигил', about: 'Разрушить узел связи Республики.', reward: { cr: 420, res: { electronics: 40 } } }),
    ev({ id: 'c_scriptorium', kind: 'pve', theater: 'space', sides: ['cis'], troops: 'event', icon: 'station', title: 'Станция «Скрипторий»', place: 'Скрипторий', about: 'Оборона станции от волн Y-wing.', reward: { cr: 420, res: { cells: 40 } } }),
    ev({ id: 'c_swarm', kind: 'pve', theater: 'space', sides: ['cis'], troops: 'event', icon: 'swarm', title: 'Рой', place: 'Пояс Тиррен', about: '«Стервятники» против корвета-охотника.', reward: { cr: 380, res: { cells: 30 } } }),
    ev({ id: 'c_quarantine', kind: 'pve', theater: 'space', sides: ['cis'], troops: 'own', icon: 'blockade', title: 'Карантинная блокада', place: 'Орбита Сеоль', about: 'Не пропустить транспорты контрабандистов.', reward: { cr: 460, res: { gas: 60 } } }),
    ev({ id: 'c_beacon', kind: 'pve', theater: 'space', sides: ['cis'], troops: 'event', icon: 'boarding', title: 'Абордаж «Светоча»', place: 'Трасса Ильмар', about: 'Захватить госпитальный корабль.', reward: { cr: 480, res: { food: 60 } } }),
    ev({ id: 'c_silence', kind: 'pve', theater: 'space', sides: ['cis'], troops: 'own', icon: 'shipyard', title: 'Сайленс-Порт', place: 'Сайленс-Порт', about: 'Тяжёлый рейд на верфь Республики.', reward: { cr: 700, res: { durasteel: 80 } } })
  ];
  var BY = {}; LIST.forEach(function(e) { BY[e.id] = e; });

  // Награда уровня: кредиты и ресурсы × k (округление до 5)
  function reward(id, tier, share) {
    var e = BY[id], T = TIERS[(tier | 0) - 1]; if (!e || !T) return null;
    var k = T.k * (share == null ? 1 : share), r5 = function(v) { return Math.round(v * k / 5) * 5; }, res = {};
    Object.keys(e.reward.res || {}).forEach(function(r) { res[r] = r5(e.reward.res[r]); });
    return { cr: r5(e.reward.cr), res: res };
  }
  function role(id, rid) { var e = BY[id]; if (!e) return null; for (var i = 0; i < e.roles.length; i++) if (e.roles[i].id === rid) return e.roles[i]; return null; }
  function forSide(side) { return LIST.filter(function(e) { return e.sides.indexOf(side) >= 0; }); }

  var RES_NAME = { ore: 'руда', gas: 'тибанна', crystals: 'кристаллы', food: 'продовольствие', durasteel: 'дюрасталь', cells: 'топливные ячейки', electronics: 'электроника' };
  return { TIERS: TIERS, LIST: LIST, BY: BY, reward: reward, role: role, forSide: forSide, LOSS_SHARE: LOSS_SHARE, LOSS_MIN_SEC: LOSS_MIN_SEC, RES_NAME: RES_NAME };
});
