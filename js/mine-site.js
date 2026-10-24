// Участок добычи и перерабатывающий цех (план claude/mining-plan.md): бригада людей и дроидов, смены, автосмена,
// задачи, специалисты, найм. Выработку считает база (sql/mine_sites.sql, mine_depth.sql, mine_refine.sql); окно
// показывает её же числа и между опросами досчитывает сделанное за смену по той же ставке. Цех (st.refine) берёт
// сырьё со склада планеты на всю смену при старте. Префикс классов и функций — mn-/mn*.
// Открывается тапом по готовой производственной постройке (js/ground-battle.js → openMineSite).
// Диверсии (sql/mine_sabotage.sql, план claude/sabotage-plan.md): охрана, задача «Караул», происшествия со
// следствием (st.ops), бастующие и сбойные (hurt.why), испорченный паёк (st.spoiled). Таймеры — по времени сервера.

var mnState = null;        // последнее состояние с сервера
var mnBuilding = null;     // строка постройки
var mnAt = 0;              // когда пришло состояние (мс, часы клиента)
var mnSkew = 0;            // часы сервера − часы клиента, мс (st.now)
var mnWaitAt = 0, mnWaitN = 0;   // ожидание итога операции: когда последний раз переспросили базу и сколько раз
var mnPoll = null, mnTick = null, mnBusy = false, mnSeq = 0;
var mnOpenAt = 0, mnDownBack = false;   // касание фона закрывает шторку, только если оно на фоне и началось
var mnForm = { len: 8, pace: 'normal', task: 'extract', h: 0, d: 0, touched: false };
var MN_PACE = { careful: 'Бережно', normal: 'Обычно', rush: 'Аврал' };
var MN_PACE_HINT = {
  careful: 'медленнее, зато отдых вдвое короче',
  normal: 'обычная выработка и отдых',
  rush: 'быстрее, но отдых дольше, а часть бригады может выбыть'
};
var MN_TASKS = ['extract', 'prep', 'survey', 'maint', 'guard'];
var MN_TASK = { extract: 'Добыча', prep: 'Вскрыша', survey: 'Разведка жилы', maint: 'Обслуживание', guard: 'Караул' };
var MN_TASK_SUB = { extract: 'сырьё ×1', prep: '×0,2 → добыча +25 %', survey: 'жила +40 % на сутки', maint: 'ремонт оборудования', guard: '×0,6 · бригада сторожит' };
var MN_TASK_HINT = {
  extract: 'основная работа: сырьё на склад',
  prep: 'почти без выхода, зато следующая смена добычи даст +25 %',
  survey: 'без выхода: шанс найти богатую жилу — +40 % к добыче на сутки',
  maint: 'без выхода: бригада чинит оборудование, техники ускоряют ремонт',
  guard: 'добыча вполсилы, зато бригада смотрит по сторонам: пока идёт смена, шанс диверсии ниже'
};
// у цеха те же задачи под своими названиями: вскрыша — наладка линии, разведка жилы — отладка режима (экономия сырья)
var MN_TASK_R = { extract: 'Переработка', prep: 'Наладка линии', survey: 'Отладка режима', maint: 'Обслуживание', guard: 'Караул' };
var MN_TASK_SUB_R = { extract: 'сырьё → готовое', prep: '×0,2 → переработка +25 %', survey: 'сырья −25 % на сутки', maint: 'ремонт оборудования', guard: '×0,6 · бригада сторожит' };
var MN_TASK_HINT_R = {
  extract: 'основная работа: сырьё со склада планеты — в готовое',
  prep: 'почти без выхода, зато следующая переработка даст +25 %',
  survey: 'без выхода: шанс отладить режим — сутки сырья на единицу на 25 % меньше',
  maint: 'без выхода: бригада чинит оборудование, техники ускоряют ремонт',
  guard: 'переработка вполсилы, зато бригада смотрит по сторонам: пока идёт смена, шанс диверсии ниже'
};
// Диверсии: значки операций — тонкие линии в стиле значков бригады
var MN_OP_ICON = {
  blast: '<svg viewBox="0 0 20 20"><circle cx="8.5" cy="11" r="2.6"/><path d="M8.5 5v1.6M8.5 15.4V17M2.5 11h1.6M12.9 11h1.6M4.3 6.8l1.1 1.1M11.6 14.1l1.1 1.1M4.3 15.2l1.1-1.1"/><path d="M15.5 2.5 13 6.5h2.6l-2 4"/></svg>',
  strike: '<svg viewBox="0 0 20 20"><path d="M3 8.5v3h2.5l6 3.5v-10l-6 3.5z"/><path d="M14 8a3 3 0 0 1 0 4M16.2 6.2a5.6 5.6 0 0 1 0 7.6"/></svg>',
  virus: '<svg viewBox="0 0 20 20"><rect x="6" y="6" width="8" height="8" rx="1.3"/><path d="M8.5 3.5V6M11.5 3.5V6M8.5 14v2.5M11.5 14v2.5M3.5 8.5H6M3.5 11.5H6M14 8.5h2.5M14 11.5h2.5"/><path d="m8.5 8.5 3 3m0-3-3 3"/></svg>',
  poison: '<svg viewBox="0 0 20 20"><path d="M3.5 7 10 3.8 16.5 7v6.5L10 16.7l-6.5-3.2z"/><path d="M3.5 7 10 10.2 16.5 7M10 10.2v6.5"/><path d="m12.6 12 2.4 1.2m0-1.2-2.4 1.2"/></svg>',
  theft: '<svg viewBox="0 0 20 20"><path d="M3.5 8 10 4.8 16.5 8v7L10 18.2 3.5 15z"/><path d="M3.5 8 10 11.2 16.5 8M10 11.2v7"/><path d="M13.2 2.2h3v3M16.2 2.2l-3.4 3.4"/></svg>',
  near: '<svg viewBox="0 0 20 20"><path d="M2.5 10s2.8-4.5 7.5-4.5 7.5 4.5 7.5 4.5-2.8 4.5-7.5 4.5S2.5 10 2.5 10z"/><circle cx="10" cy="10" r="2.2"/></svg>',
  caught: '<svg viewBox="0 0 20 20"><path d="M10 2.8 4 5v4.6c0 3.7 2.6 6.4 6 7.6 3.4-1.2 6-3.9 6-7.6V5z"/><path d="m7.2 10 2 2 3.8-4"/></svg>',
  raid: '<svg viewBox="0 0 20 20"><path d="M3 15.5 12.5 6M5.5 17l-2-2 1.4-1.4 2 2zM12.5 6l1.6-2.6L16.6 6 14 7.6z"/><path d="M17 15.5 7.5 6M14.5 17l2-2-1.4-1.4-2 2z"/><path d="m7.5 6-1.6-2.6L3.4 6 6 7.6"/></svg>'
};
var MN_SIDE = { republic: 'Республика', cis: 'КНС' };
var MN_KIND = {
  rep_mine: 'Рудник', cis_mine: 'Рудник', rep_gas: 'Газовый промысел', cis_gas: 'Газовый промысел',
  rep_crystal: 'Кристальная выработка', cis_crystal: 'Кристальная выработка', rep_farm: 'Ферма', cis_farm: 'Ферма',
  rep_smelter: 'Плавильный цех', cis_smelter: 'Плавильный цех', rep_fuel: 'Топливный цех', cis_fuel: 'Топливный цех',
  rep_electronics: 'Сборочный цех', cis_electronics: 'Сборочный цех'
};
function mnRef() { return !!(mnState && mnState.refine); }
function mnW(mine, ref) { return mnRef() ? ref : mine; }
function mnTaskName(t) { return (mnRef() ? MN_TASK_R : MN_TASK)[t] || ''; }
// сырьё цеха: название по id и строка «руда 30, кристаллы 10»
function mnInName(id) { var a = (mnState && mnState.refine && mnState.refine.inputs) || []; for (var i = 0; i < a.length; i++) if (a[i].id === id) return a[i].name; return id; }
function mnInList(obj) { var out = []; for (var k in obj) if (Object.prototype.hasOwnProperty.call(obj, k) && obj[k] > 0) out.push(mnEsc(mnInName(k)).toLowerCase() + ' ' + obj[k]); return out.join(', '); }
// на сколько единиц готового хватит сырья на складе планеты (дроиды на смене возьмут руду на обслуживание)
function mnRoom(upkeepOre) {
  var r = mnState.refine, room = Infinity; if (!r) return Infinity;
  r.inputs.forEach(function(x) { if (x.k > 0) room = Math.min(room, Math.floor(Math.max(0, x.have - (x.id === 'ore' ? upkeepOre || 0 : 0)) / x.k)); });
  return room === Infinity ? 0 : room;
}
// сделанное за смену сейчас: по ставке от ответа сервера, не больше взятого сырья
function mnGot(r, now) {
  var t1 = new Date(r.ends_at).getTime(), v = r.accrued + r.rate * Math.max(0, Math.min(now, t1) - mnAt) / 3600000;
  return r.cap != null ? Math.min(r.cap, v) : v;
}

function mnEsc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function(c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
function mnNum(v, d) { var k = Math.pow(10, d || 0); return String(Math.round(v * k) / k).replace('.', ','); }
function mnLeft(ms) {
  var s = Math.max(0, Math.round(ms / 1000));
  if (s >= 3600) { var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return h + ' ч' + (m ? ' ' + m + ' мин' : ''); }
  if (s >= 60) return Math.floor(s / 60) + ' мин';
  return s + ' с';
}
function mnWorkers(n, kind) {
  var a = n % 10, b = n % 100, one = a === 1 && b !== 11, few = a >= 2 && a <= 4 && (b < 12 || b > 14);
  if (kind === 'h') return n + (one ? ' человек' : few ? ' человека' : ' человек');
  return n + (one ? ' дроид' : few ? ' дроида' : ' дроидов');
}

// Время сервера и «сколько осталось» до его отметки
function mnSrvNow() { return Date.now() + mnSkew; }
function mnLeftAt(iso) { return mnLeft((iso ? Date.parse(iso) : 0) - mnSrvNow()); }
// время — по часам сервера, как в ленте и в «18–23 по серверу» (js/credits-bar.js → svFormatTime)
function mnHm(iso) {
  if (!iso) return '';
  var t = Date.parse(iso);
  if (typeof svFormatTime === 'function') { try { var f = svFormatTime(t); if (f) return f; } catch (e) {} }
  return new Date(t).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

// Выбывшие по причинам: rush — травмы и поломки после аврала, strike — бастуют, virus — сбой дроидов
function mnHurt(st, kind) {
  var out = { rush: 0, strike: 0, virus: 0, strikeUntil: null, virusUntil: null };
  (st.hurt || []).forEach(function(x) {
    if (x.kind !== kind) return;
    var why = x.why === 'strike' || x.why === 'virus' ? x.why : 'rush';
    out[why] += x.n || 0;
    if (why !== 'rush' && (!out[why + 'Until'] || x.until > out[why + 'Until'])) out[why + 'Until'] = x.until;
  });
  return out;
}

// Ход операции на участке по времени сервера: approach — группа подбирается; acting — время действия прошло,
// база ещё не ответила; ok / caught — результат
function mnOpPhase(o, now) {
  if (o.acted_at) return o.result === 'caught' ? 'caught' : 'ok';
  return now < Date.parse(o.act_at) ? 'approach' : 'acting';
}

// Что случилось — по данным операции, теми же словами, что в ленте
function mnOpEffect(o, st) {
  var e = o.effect || {};
  if (o.kind === 'blast') return 'Установка №' + ((o.spot || 0) + 1) + ' выведена из строя: износ +' + (e.wear || 30) + ' %' + (e.shift ? ', смена оборвана' : '');
  if (o.kind === 'strike') return e.humans > 0 ? 'Бригада бастует: ' + mnWorkers(e.humans, 'h') + ' не выйдут 6 ч' : 'Подстрекатели у ворот, но людей в бригаде нет';
  if (o.kind === 'virus') return e.droids > 0 ? 'Сбой дроидов: ' + mnWorkers(e.droids, 'd') + ' встали на ' + mnNum(e.hours || 6, 0) + ' ч' : 'Вирус в сети, но дроидов в бригаде нет';
  if (o.kind === 'poison') return 'Снабжение сорвано: −' + (e.food || 0) + ' еды со склада планеты, ближайшая смена людей без пайка';
  if (o.kind === 'theft') {
    var rn = st.res && st.res.id === e.res ? st.res.name : e.res;
    return 'Склад вскрыт: пропало ' + (e.stolen || 0) + (rn ? ' — ' + mnEsc(rn).toLowerCase() : '');
  }
  return '';
}

// Карточки происшествий: подход, следствие, итоги; самые свежие сверху (так их отдаёт база)
function mnOpsHtml(st) {
  var ops = st.ops || [], raids = st.raids || []; if (!ops.length && !raids.length) return '';
  var now = mnSrvNow(), cards = [];
  raids.forEach(function(r) { cards.push({ t: Date.parse(r.acted_at || r.raid_at) || 0, html: mnRaidCard(r, st, now) }); });
  ops.forEach(function(o) {
    var html = '';
    var ph = mnOpPhase(o, now), side = MN_SIDE[o.side] || '';
    var cls = ph === 'approach' || ph === 'acting' ? 'near' : ph === 'caught' ? 'caught' : o.revealed ? 'known' : 'probe';
    var ico = ph === 'approach' || ph === 'acting' ? MN_OP_ICON.near : ph === 'caught' ? MN_OP_ICON.caught : MN_OP_ICON[o.kind] || MN_OP_ICON.near;
    var title, body = '', foot = '';
    if (ph === 'approach' || ph === 'acting') {
      title = 'Чужие у ' + mnW('участка', 'цеха');
      body = ph === 'approach'
        ? '<span class="mn-op-t" data-at="' + Date.parse(o.act_at) + '" data-pre="Подбираются к цели · действие через " data-done="Группа у цели…">Подбираются к цели</span>'
        : 'Группа у цели…';
      // остановить нельзя, но шанс считается в момент действия — охрана и караул ещё успеют
      if (ph === 'approach') foot = '<div class="mn-op-note">Остановить группу уже нельзя, но охрана и караул, выставленные сейчас, ещё успеют: шанс считается в момент действия.</div>' + mnDefendBtns(st);
    } else if (ph === 'caught') {
      title = 'Диверсанты задержаны';
      body = 'Охрана взяла группу на подходе: готовили «' + mnEsc(o.name || '') + '».';
      foot = '<div class="mn-op-who">Исполнитель — группа игрока <b>' + mnEsc(o.who || '?') + '</b>' + (side ? ' (' + side + ')' : '') + ' · награда за поимку зачислена</div>';
    } else {
      title = mnEsc(o.name || 'Происшествие');
      body = mnOpEffect(o, st);
      foot = o.revealed
        ? '<div class="mn-op-who">Итоги следствия: диверсия. Исполнитель — группа игрока <b>' + mnEsc(o.who || '?') + '</b>' + (side ? ' (' + side + ')' : '') + '</div>'
        : '<div class="mn-op-who probe"><i>?</i><span class="mn-op-t" data-at="' + Date.parse(o.reveal_at) + '" data-pre="Причина выясняется · итоги следствия через " data-done="Следствие заканчивается…">Причина выясняется</span></div>';
    }
    html = mnOpCard(cls, ico, title, mnHm(o.acted_at || o.approach_at), body, foot);
    cards.push({ t: Date.parse(o.acted_at || o.approach_at) || 0, html: html });
  });
  cards.sort(function(a, b) { return b.t - a.t; });
  return '<div class="mn-sec">Происшествия</div><div class="mn-ops">' + cards.map(function(c) { return c.html; }).join('') + '</div>';
}
function mnOpCard(cls, ico, title, hm, body, foot) {
  return '<div class="mn-op ' + cls + '">' +
    '<div class="mn-op-ico">' + ico + '</div>' +
    '<div class="mn-op-info">' +
      '<div class="mn-op-top"><b>' + title + '</b><span>' + hm + '</span></div>' +
      '<div class="mn-op-body">' + body + '</div>' + (foot || '') +
    '</div></div>';
}
// Охрана и караул прямо из карточки угрозы: успевают, пока группа или банда только подходит
function mnDefendBtns(st) {
  var run = st.run, gFull = (st.guards || 0) >= (st.guards_max || 0);
  var watchOn = run && run.task === 'guard', watchBusy = run && run.task !== 'guard';
  return '<div class="mn-op-btns">' +
    '<button type="button" class="mn-btn" data-mn="op-guard"' + (gFull ? ' disabled' : '') + '>' + (gFull ? 'Охрана полная' : '+ Нанять охрану') + (gFull ? '' : '<small>' + st.cfg.hire_g + ' кр</small>') + '</button>' +
    '<button type="button" class="mn-btn" data-mn="op-watch"' + (watchOn || watchBusy ? ' disabled' : '') + '>' + (watchOn ? 'Караул стоит' : 'Поставить караул') + (watchBusy ? '<small>идёт смена</small>' : '') + '</button>' +
  '</div>';
}

// Защитники участка сейчас (как mine_raid_defense в базе): охрана на посту, «Казармы ополчения», караул
function mnDefense(st) {
  return Math.min(st.guards || 0, st.guards_max || 0) + (st.garrison ? 1 : 0) + (st.run && st.run.task === 'guard' ? 1 : 0);
}
function mnRaidChance(d, n) { return d >= Math.max(1, n) ? 100 : Math.round(80 * Math.max(0, d) / Math.max(1, n)); }

// Налёт мародёров (sql/mine_raids.sql): предупреждение → банда у участка → бой → итог
function mnRaidPhase(r, now) {
  if (r.acted_at) return r.result === 'repelled' ? 'repelled' : 'lost';
  var ta = Date.parse(r.raid_at);
  return now < Date.parse(r.approach_at) ? 'warn' : now < ta ? 'near' : 'fight';
}
function mnRaidCard(r, st, now) {
  var ph = mnRaidPhase(r, now), n = r.n || 0, band = mnRaiders(n), cfg = st.cfg.raid || {};
  if (ph === 'repelled')
    return mnOpCard('caught', MN_OP_ICON.caught, 'Налёт отбит', mnHm(r.acted_at),
      'Охрана отбила ' + band + ' — на посту ' + mnDefenders(r.defense || 0) + '.',
      '<div class="mn-op-who">Трофеи · +' + (r.bounty || 0) + ' кр</div>');
  if (ph === 'lost') {
    var rn = st.res && st.res.id === r.loot_res ? st.res.name : r.loot_res, parts = [];
    if (r.loot > 0) parts.push('−' + r.loot + (rn ? ' ' + mnEsc(rn).toLowerCase() : '') + ' со склада планеты');
    if (r.shift_cut) parts.push('смена оборвана');
    parts.push('износ +' + (cfg.wear || 10) + ' %');
    return mnOpCard('known', MN_OP_ICON.raid, r.loot > 0 ? 'Налёт: банда ушла с добычей' : 'Налёт: банда прорвалась', mnHm(r.acted_at),
      band.charAt(0).toUpperCase() + band.slice(1) + ' против ' + mnDefenders(r.defense || 0) + ': ' + parts.join(', ') + '.', '');
  }
  var d = mnDefense(st), ch = mnRaidChance(d, n);
  var odds = ch >= 100 ? '<b class="ok">отобьёте</b>' : ch > 0 ? 'шанс отбиться <b>' + ch + ' %</b>' : '<b class="bad">отбиться некому</b>';
  var t = ph === 'warn' ? '<span class="mn-op-t" data-at="' + Date.parse(r.raid_at) + '" data-pre="' + band.charAt(0).toUpperCase() + band.slice(1) + ' будут около ' + mnHm(r.raid_at) + ' · через " data-done="Банда у ' + mnW('участка', 'цеха') + '">' + band + '</span>'
        : ph === 'near' ? '<span class="mn-op-t" data-at="' + Date.parse(r.raid_at) + '" data-pre="Банда у ' + mnW('участка', 'цеха') + ' · налёт через " data-done="Бой у склада…">Банда у ' + mnW('участка', 'цеха') + '</span>'
        : 'Бой у склада…';
  return mnOpCard('near', MN_OP_ICON.raid, ph === 'warn' ? 'Банда идёт к ' + mnW('участку', 'цеху') : 'Налёт', mnHm(r.raid_at), t,
    ph === 'fight' ? '' :
    '<div class="mn-op-note">Защитников на посту: ' + d + ' из ' + n + ' нужных — ' + odds + '. Не отобьёте — смена оборвётся, банда унесёт ' + (cfg.loot_pct || 20) + ' % ресурса со склада планеты (до ' + (cfg.loot_max || 60) + '), износ +' + (cfg.wear || 10) + ' %. Отобьёте — ' + (cfg.bounty || 40) + ' кр за налётчика.</div>' + mnDefendBtns(st));
}
function mnDefenders(n) { var a = n % 10, b = n % 100; return n + (a === 1 && b !== 11 ? ' защитника' : ' защитников'); }
function mnRaiders(n) { var a = n % 10, b = n % 100; return n + (a === 1 && b !== 11 ? ' налётчик' : a >= 2 && a <= 4 && (b < 12 || b > 14) ? ' налётчика' : ' налётчиков'); }

// Охрана и защита от диверсий: кто на посту, караул, узел связи — насколько это снижает шанс диверсанта
function mnGuardHtml(st) {
  var spy = st.cfg.spy || {}, run = st.run;
  var post = Math.min(st.guards || 0, st.guards_max || 0) + (st.garrison ? 1 : 0);
  var watch = !!(run && run.task === 'guard');
  var cut = post * (spy.guard || 12) + (watch ? spy.watch || 20 : 0) + (st.comms ? spy.comms || 10 : 0);
  var rows = [
    { on: post > 0, t: 'Охрана на посту: ' + post, v: post ? '−' + post * (spy.guard || 12) + ' %' : '' },
    { on: watch, t: 'Караул: ' + (watch ? 'бригада сторожит' : 'не выставлен'), v: watch ? '−' + (spy.watch || 20) + ' %' : '' },
    { on: !!st.comms, t: '«Узел связи» поселения: ' + (st.comms ? 'следствие 3 ч' : 'нет'), v: st.comms ? '−' + (spy.comms || 10) + ' %' : '' }
  ];
  return '<div class="mn-sec" id="mn-guard-sec">Охрана</div>' + mnSpecRow('g', st) +
    '<div class="mn-guard' + (cut ? ' on' : '') + '">' +
      '<div class="mn-guard-top"><span>Шанс диверсанта</span><b>' + (cut ? '−' + cut + ' %' : 'без защиты') + '</b></div>' +
      '<div class="mn-guard-rows">' + rows.map(function(r) {
        return '<div class="' + (r.on ? 'on' : '') + '"><i>' + (r.on ? '✓' : '·') + '</i><span>' + r.t + '</span><em>' + r.v + '</em></div>';
      }).join('') + '</div>' +
      '<div class="mn-note">Против налётов мародёров (вечером, 18–23 по серверу) стоят те же защитники: охрана на посту, ополчение и караул — один за охранника. Их не меньше, чем налётчиков (2–4 по размеру ' + mnW('участка', 'цеха') + '), — налёт отбит наверняка; меньше — шанс 80 % × защитники / налётчики.</div>' +
      '<div class="mn-note">Ночью (22–06 по серверу) диверсантам проще. Шанс считается в момент действия группы, поэтому охрана и караул помогают, даже если выставлены, пока она подбирается.' +
      (st.garrison ? '' : ' «Казармы ополчения» поселения дают ещё одного охранника бесплатно.') + '</div>' +
    '</div>';
}

// Постройка производит сырьё (добыча или передел) — у неё участок/цех с бригадой
function isMineBuilding(code) {
  if (!code || typeof buildingTypes === 'undefined' || !buildingTypes) return false;
  for (var i = 0; i < buildingTypes.length; i++) {
    var t = buildingTypes[i];
    if (t.code === code) return !!t.produces_resource;
  }
  return false;
}

function mnPanel() {
  var p = document.getElementById('mn-panel');
  if (p) return p;
  p = document.createElement('div');
  p.id = 'mn-panel';
  p.style.display = 'none';
  p.innerHTML =
    '<div id="mn-box">' +
      '<div id="mn-head"><div class="mn-ttl"><b id="mn-title">Участок</b><span id="mn-sub"></span></div>' +
        '<button id="mn-close" type="button" aria-label="Закрыть">✕</button></div>' +
      '<div id="mn-stage"><div class="mn-hud" id="mn-hud"></div></div>' +
      '<div id="mn-body"></div>' +
    '</div>';
  document.body.appendChild(p);
  // Тап, которым открыли участок (на карте планеты), браузер следом досылает щелчком — уже по фону
  // открытой шторки. Закрываем только касание, начатое на фоне, и не в первые 0,4 с.
  p.addEventListener('pointerdown', function(e) { mnDownBack = e.target === p; });
  p.addEventListener('click', function(e) { if (e.target === p && mnDownBack && Date.now() - mnOpenAt > 400) closeMineSite(); mnDownBack = false; });
  document.getElementById('mn-close').addEventListener('click', closeMineSite);
  document.getElementById('mn-body').addEventListener('click', mnClick);
  return p;
}

function openMineSite(building) {
  mnBuilding = building; mnOpenAt = Date.now(); mnDownBack = false; mnWaitN = 0;
  mnState = null;
  mnForm = { len: 8, pace: 'normal', task: 'extract', h: 0, d: 0, touched: false };
  var p = mnPanel();
  var t = building.building_types || {};
  document.getElementById('mn-title').textContent = MN_KIND[t.code] || 'Участок';
  document.getElementById('mn-sub').textContent = t.name || '';
  document.getElementById('mn-body').innerHTML = '<div class="mn-empty">Загрузка…</div>';
  p.style.display = 'flex';
  document.body.classList.add('mn-open');
  if (window.MNScene) { try { MNScene.mount(document.getElementById('mn-stage')); } catch (e) { if (window.errReport) errReport(e, 'mine.scene'); } }
  document.getElementById('mn-hud').textContent = '';
  mnLoad();
  if (mnPoll) clearInterval(mnPoll);
  mnPoll = setInterval(function() { if (!document.hidden) mnLoad(); }, 15000);
  if (mnTick) clearInterval(mnTick);
  mnTick = setInterval(mnLive, 1000);
}

function closeMineSite() {
  var p = document.getElementById('mn-panel');
  if (p) p.style.display = 'none';
  document.body.classList.remove('mn-open');
  if (window.MNScene) MNScene.stop();
  if (mnPoll) { clearInterval(mnPoll); mnPoll = null; }
  if (mnTick) { clearInterval(mnTick); mnTick = null; }
  mnBuilding = null; mnState = null;
}

function mnLoad() {
  if (!mnBuilding) return;
  var seq = ++mnSeq, bid = mnBuilding.id;
  supabase.rpc('mine_site_state', { p_building: bid }).then(function(r) {
    if (seq !== mnSeq || !mnBuilding || mnBuilding.id !== bid) return;
    if (r.error) { document.getElementById('mn-body').innerHTML = '<div class="mn-empty bad">' + mnEsc(r.error.message) + '</div>'; return; }
    mnSet(r.data);
  }, function() {
    if (seq === mnSeq && !mnState) document.getElementById('mn-body').innerHTML = '<div class="mn-empty bad">Нет связи с сервером</div>';
  });
}

function mnSet(st) {
  mnState = st; mnAt = Date.now();
  var sn = st && st.now ? Date.parse(st.now) : NaN;
  mnSkew = isNaN(sn) ? 0 : sn - mnAt;
  if (window.MNScene) { try { MNScene.set(st, mnAt); } catch (e) { if (window.errReport) errReport(e, 'mine.scene'); } }
  // по умолчанию на смену — все свободные и отдохнувшие, не больше мест
  if (!mnForm.touched) {
    var h = st.rest_h ? 0 : st.avail_h, d = st.rest_d ? 0 : st.avail_d;
    h = Math.min(h, st.places); d = Math.min(d, st.places - h);
    mnForm.h = h; mnForm.d = d;
  }
  mnClamp();
  mnRender();
}

function mnClamp() {
  var st = mnState; if (!st) return;
  var mh = st.rest_h ? 0 : st.avail_h, md = st.rest_d ? 0 : st.avail_d;
  mnForm.h = Math.max(0, Math.min(mnForm.h, mh, st.places));
  mnForm.d = Math.max(0, Math.min(mnForm.d, md, st.places - mnForm.h));
}

// Выработка в час по тем же правилам, что в базе: mine_rate_h × множитель участка (mine_mult) × задача × эффекты планеты
function mnMult(task) {
  var st = mnState, m = st.mult || 1;
  if (task !== 'extract' && st.prep) m = m / (1 + st.prep / 100);       // вскрыша копится только для добычи
  return m;
}
function mnRate(h, d, len, pace, fedH, fedD, task) {
  var st = mnState, c = st.cfg, tk = c.task && c.task[task || 'extract'] != null ? c.task[task || 'extract'] : 1;
  var k = c.rate * st.res_k * (c.pace[pace] || 1) *
          (h * (c.k_h[len] || 1) * (fedH ? 1 : c.hungry) + d * (c.k_d[len] || 1) * (fedD ? 1 : c.hungry));
  return k * mnMult(task || 'extract') * tk * Math.max(0, 100 + (st.eff || 0)) / 100;
}
// Износ за смену, %: как в mine_finish (бережно ×0,5, аврал ×2, мастерские ×0,7; разведка вполовину)
function mnWear(h, d, len, pace, task) {
  var st = mnState, c = st.cfg, pw = (pace === 'careful' ? 0.5 : pace === 'rush' ? 2 : 1) * (st.districts && st.districts.workshops ? 0.7 : 1);
  if (task === 'maint') return -(h + d) * len * 2 * (1 + 0.5 * Math.min(st.techs, st.techs_max));
  return len * pw * (h * c.wear_h + d * c.wear_d) * (task === 'survey' ? 0.5 : 1);
}
function mnStarsHtml(n) { var s = ''; for (var i = 0; i < 5; i++) s += '<i class="' + (i < n ? 'on' : '') + '">★</i>'; return s; }
function mnRestMin(kind, hours, pace) {
  var k = (mnState.cfg.rest[pace] || 1);
  return kind === 'h' ? Math.max(60, Math.round(hours * 30 * k)) : Math.max(30, Math.round(hours * 15 * k));
}
function mnRestText(min) { return min >= 60 ? mnNum(min / 60, 1) + ' ч' : min + ' мин'; }

function mnRender() {
  var st = mnState, body = document.getElementById('mn-body');
  if (!st || !body) return;
  var res = st.res || {}, col = res.color || '#8fa8c4', html = '';
  var dep = st.refine ? 'передел' + (st.refine.econ ? ' · режим отлажен' : '')
          : st.res_k >= 1 ? 'основная залежь' : st.res_k > 0 ? 'попутная залежь · вполовину' : 'залежи нет';

  // --- сводка
  html += '<div class="mn-card" style="border-left-color:' + col + '">' +
    '<div class="mn-res"><i style="background:' + col + '"></i><b>' + mnEsc(res.name) + '</b><span>' + dep + '</span></div>' +
    '<div class="mn-kpis">' +
      '<div><em>в сутки</em><b>' + (st.auto.on ? '≈ ' + st.day : '—') + '</b>' + mnDaySub(st) + '</div>' +
      '<div><em>бригада</em><b>' + (st.humans + st.droids) + '<small>/' + st.staff_max + '</small></b><span>мест работы ' + st.places + '</span></div>' +
      '<div><em>' + mnW('склад участка', 'склад цеха') + '</em><b>' + st.stock + '<small>/' + st.site_cap + '</small></b><span>планета ' + st.planet.res + '/' + st.planet.cap + '</span></div>' +
    '</div>' +
    mnInputHtml(st) +
    mnStateHtml(st) +
    (st.eff ? '<div class="mn-eff ' + (st.eff > 0 ? 'up' : 'down') + '">Эффекты планеты: ' + mnW('добыча', 'производство') + ' ' + (st.eff > 0 ? '+' : '−') + Math.abs(st.eff) + ' %</div>' : '') +
    (st.capture ? '<div class="mn-eff down">На планете идёт захват — новые смены не начать</div>' : '') +
    (st.spoiled ? '<div class="mn-eff down">Паёк испорчен: ближайшая смена людей выйдет без пайка</div>' : '') +
  '</div>';

  // --- происшествия: подход чужой группы, диверсии и их следствие
  html += mnOpsHtml(st);

  // --- смена
  html += '<div class="mn-sec">Смена</div>';
  html += st.run ? mnRunHtml() : mnFormHtml();

  // --- автосмена
  var a = st.auto;
  html += '<div class="mn-sec">Автосмена</div>' +
    '<div class="mn-auto' + (a.on ? ' on' : '') + '">' +
      '<button class="mn-toggle" type="button" data-mn="auto-toggle"><i></i><span>' + (a.on ? 'Включена' : 'Выключена') + '</span></button>' +
      '<div class="mn-chips">' + st.cfg.auto_lens.map(function(l) { return '<button type="button" class="mn-chip' + (a.len === l ? ' on' : '') + '" data-mn="auto-len" data-v="' + l + '">' + l + ' ч</button>'; }).join('') + '</div>' +
      '<div class="mn-chips">' + ['careful', 'normal', 'rush'].map(function(p) { return '<button type="button" class="mn-chip' + (a.pace === p ? ' on' : '') + (p === 'rush' ? ' rush' : '') + '" data-mn="auto-pace" data-v="' + p + '">' + MN_PACE[p] + '</button>'; }).join('') + '</div>' +
      '<div class="mn-note">Бригада сама выходит на смену, когда отдохнула: сначала дроиды, свободные места — людям. Так ' + mnW('участок', 'цех') + ' работает, пока тебя нет. Короткие смены (1–4 ч) дают больше в час, но их запускаешь сам.' +
      (st.refine ? ' Сырьё на смену цех берёт со склада планеты сам; нет сырья — ждёт.' : '') + '</div>' +
    '</div>';

  // --- бригада
  html += '<div class="mn-sec">Бригада · в бараке ' + (st.humans + st.droids) + ' из ' + st.staff_max + '</div>';
  html += mnCrewRow('h', st) + mnCrewRow('d', st);
  html += '<div class="mn-note">На смену выходит не больше ' + st.places + ' — по числу мест работы. Остальные отдыхают и сменяют уставших. ' +
    'Люди: паёк — 1 еда за смену (на планете ' + st.planet.food + '). Дроиды: обслуживание — 1 руда за смену (на планете ' + st.planet.ore + '). Без него выработка ×' + mnNum(st.cfg.hungry, 1) + '.</div>';

  // --- специалисты
  html += '<div class="mn-sec">Специалисты</div>' + mnSpecRow('f', st) + mnSpecRow('t', st);

  // --- охрана
  html += mnGuardHtml(st);

  // --- участок: места работы
  html += mnUpgradeHtml(st);

  // --- последние смены
  if (st.last && st.last.length) {
    html += '<div class="mn-sec">Последние смены</div><div class="mn-log">';
    st.last.forEach(function(x) {
      var when = new Date(x.ended_at || x.started_at), hm = when.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
      var crew = [x.humans ? mnWorkers(x.humans, 'h') : '', x.droids ? mnWorkers(x.droids, 'd') : ''].filter(Boolean).join(' + ');
      var tag = x.status === 'stopped' ? 'остановлена' : x.status === 'lost' ? 'сорвана' : x.auto ? 'авто' : '';
      var task = x.task && x.task !== 'extract' ? mnTaskName(x.task) + ' · ' : '';
      var used = x.used ? mnInList(x.used) : '';
      html += '<div class="mn-log-row"><span class="t">' + hm + '</span><span class="w">' + task + x.len + ' ч · ' + MN_PACE[x.pace].toLowerCase() + ' · ' + crew + (tag ? ' · <i>' + tag + '</i>' : '') + (x.fed ? '' : ' · <i class="bad">без пайка</i>') +
        (used ? '<br><i>сырья ушло: ' + used + '</i>' : '') +
        (x.result ? '<br><i class="res">' + mnEsc(x.result) + '</i>' : '') + '</span>' +
        (x.got || !x.task || x.task === 'extract' ? '<b style="color:' + col + '">+' + x.got + '</b>' : '') + (x.lost ? '<em class="bad">−' + x.lost + '</em>' : '') + '</div>';
    });
    html += '</div>';
  }
  var lostNow = 0; (st.last || []).forEach(function(x) { lostNow += x.lost || 0; });
  if (lostNow) html += '<div class="mn-note warn">Склад ' + mnW('участка', 'цеха') + ' переполнялся: потеряно ' + lostNow + '. Освободи склад планеты или подними его предел — тогда ' + mnW('добытое', 'готовое') + ' переходит туда само.</div>';
  html += '<div class="mn-err" id="mn-err"></div>';
  body.innerHTML = html;
  mnLive();
}

// Подпись под «в сутки»: у цеха суточная оценка — при полной загрузке; сырья на складе планеты меньше — так и пишем
function mnDaySub(st) {
  if (!st.auto.on) return '<span>автосмена выкл.</span>';
  if (st.refine) {
    var room = mnRoom(0);
    if (room < (st.day || 0)) return '<span class="warn">сырья на ' + room + '</span>';
  }
  return '<span>по автосмене</span>';
}

// Состояние участка: оборудование, опыт бригады, жила, вскрыша — и что это даёт к выработке
function mnStateHtml(st) {
  var w = st.wear || 0, wk = w >= 60 ? 'bad' : w >= 25 ? 'warn' : 'ok', now = Date.now();
  var star = st.stars || 0, next = st.hours_next;
  var html = '<div class="mn-state">' +
    '<div class="mn-st ' + wk + '"><em>оборудование</em><b>' + Math.max(0, Math.round(100 - w)) + ' %</b><span>' + (w > 0.5 ? 'износ ' + mnNum(w, 0) + ' % · ×' + mnNum(1 - w * 0.004, 2) : 'в порядке') + '</span></div>' +
    '<div class="mn-st"><em>опыт бригады</em><b class="mn-stars">' + mnStarsHtml(star) + '</b><span>' + (star ? '+' + star * 3 + ' % · ' : '') + (next ? st.hours + '/' + next + ' ч' : 'предел') + '</span></div>';
  if (st.vein_until) html += '<div class="mn-st gold"><em>' + mnW('богатая жила', 'отлаженный режим') + '</em><b>' + mnW('+40 %', 'сырья −25 %') + '</b><span>ещё ' + mnLeft(new Date(st.vein_until).getTime() - now) + '</span></div>';
  if (st.prep) html += '<div class="mn-st gold"><em>' + mnW('вскрыша', 'наладка линии') + '</em><b>+' + st.prep + ' %</b><span>' + mnW('к следующей добыче', 'к следующей переработке') + '</span></div>';
  html += '</div>';
  if (st.mult && Math.abs(st.mult - 1) > 0.005) html += '<div class="mn-eff ' + (st.mult > 1 ? 'up' : 'down') + '">' + mnW('Участок', 'Цех') + ' к выработке: ×' + mnNum(st.mult, 2) + '</div>';
  return html;
}

// Сырьё цеха: что берёт на единицу, сколько на складе планеты, на сколько хватит
function mnInputHtml(st) {
  var r = st.refine; if (!r) return '';
  var room = mnRoom(0), html = '<div class="mn-inputs">';
  r.inputs.forEach(function(x) {
    html += '<div class="mn-in' + (x.have < x.k ? ' bad' : '') + '"><i style="background:' + (x.color || '#8fa8c4') + '"></i>' +
      '<b>' + mnEsc(x.name) + '</b><span>на планете ' + x.have + '</span>' +
      '<em>' + mnNum(x.k, 2) + ' на единицу' + (st.auto.on && st.day ? ' · в сутки ≈ ' + Math.ceil(st.day * x.k) : '') + '</em></div>';
  });
  html += '</div>';
  if (room < 1) html += '<div class="mn-eff down">Цех стоит: на складе планеты не хватает сырья. Как только оно появится, автосмена начнёт сама.</div>';
  else html += '<div class="mn-eff">Сырья хватит на ≈ ' + room + ' ед. готового</div>';
  return html;
}

// Бригадир, техники и охрана
function mnSpecRow(kind, st) {
  var n = { f: st.foremen, t: st.techs, g: st.guards || 0 }[kind], max = { f: st.foremen_max, t: st.techs_max, g: st.guards_max || 0 }[kind];
  var price = { f: st.cfg.hire_f, t: st.cfg.hire_t, g: st.cfg.hire_g }[kind];
  var name = { f: 'Бригадир', t: 'Техники', g: 'Охрана' }[kind];
  var spy = st.cfg.spy || {};
  var what = {
    f: '+10 % к выработке смены, в аврале травм и поломок вдвое меньше',
    t: 'чинят оборудование: каждый — 1 % износа в час; на обслуживании ремонт быстрее на 50 %',
    g: 'каждый на посту — шанс диверсии −' + (spy.guard || 12) + ' %, следствие вдвое быстрее; в смены не выходит, паёк не нужен'
  }[kind];
  var ico = {
    f: '<svg viewBox="0 0 20 20"><path d="M5 8a5 5 0 0 1 10 0z"/><path d="M4 8h12"/><path d="M7 12h6M7 15h4"/></svg>',
    t: '<svg viewBox="0 0 20 20"><path d="M12.5 3.5a3.5 3.5 0 0 0-3.9 4.6L3.5 13.2l3.3 3.3 5.1-5.1a3.5 3.5 0 0 0 4.6-3.9l-2.2 2.2-2.3-.6-.6-2.3z"/></svg>',
    g: '<svg viewBox="0 0 20 20"><path d="M10 2.8 4 5v4.6c0 3.7 2.6 6.4 6 7.6 3.4-1.2 6-3.9 6-7.6V5z"/><path d="M10 6.5v7M7.3 9.2h5.4"/></svg>'
  }[kind];
  var extra = kind === 'g' && st.garrison ? '<span>+1 на посту от «Казарм ополчения»</span>' : '';
  return '<div class="mn-crew ' + kind + '">' +
    '<div class="mn-crew-ico">' + ico + '</div>' +
    '<div class="mn-crew-info"><b>' + name + ' · ' + n + '<small> из ' + max + '</small></b>' + extra + '<em>' + what + '</em></div>' +
    '<div class="mn-crew-btns">' +
      '<button type="button" class="mn-btn" data-mn="hire" data-k="' + kind + '"' + (n < max ? '' : ' disabled') + '>+ Нанять<small>' + price + ' кр</small></button>' +
      '<button type="button" class="mn-btn ghost" data-mn="fire" data-k="' + kind + '"' + (n > 0 ? '' : ' disabled') + '>− Уволить</button>' +
    '</div></div>';
}

// Улучшение мест работы и помощь районов поселения
function mnUpgradeHtml(st) {
  var u = st.upgrade, d = st.districts || {}, html = '<div class="mn-sec">' + mnW('Участок', 'Цех') + ' · мест работы ' + st.places + '</div>';
  if (u) {
    var okC = (st.credits || 0) >= u.credits, okD = st.planet.durasteel >= u.durasteel, okE = st.planet.electronics >= u.electronics;
    html += '<div class="mn-up">' +
      '<div class="mn-up-top"><b>' + st.places + ' → ' + u.places + ' мест</b><span>барак до ' + u.places * 2 + ' рабочих</span></div>' +
      '<div class="mn-up-cost"><span class="' + (okC ? '' : 'bad') + '">' + u.credits + ' кр</span>' +
        '<span class="' + (okD ? '' : 'bad') + '">дюрасталь ' + u.durasteel + ' <i>(' + st.planet.durasteel + ')</i></span>' +
        (u.electronics ? '<span class="' + (okE ? '' : 'bad') + '">электроника ' + u.electronics + ' <i>(' + st.planet.electronics + ')</i></span>' : '') + '</div>' +
      '<button type="button" class="mn-go" data-mn="upgrade"' + (okC && okD && okE && !st.capture ? '' : ' disabled') + '>' + mnW('Улучшить участок', 'Улучшить цех') + '</button>' +
    '</div>';
  } else html += '<div class="mn-note">' + mnW('Участок наибольший', 'Цех наибольший') + ' — 18 мест работы.</div>';
  var tips = [];
  tips.push((d.hospital ? '✓' : '·') + ' Госпиталь — травмы людей вдвое короче');
  tips.push((d.workshops ? '✓' : '·') + ' Мастерские — поломки дроидов вдвое короче, износ ×0,7');
  tips.push((d.market ? '✓' : '·') + ' Рынок — найм на 20 % дешевле');
  tips.push((d.warehouses ? '✓' : '·') + ' Склады — склад ' + mnW('участка', 'цеха') + ' +300');
  html += '<div class="mn-districts">' + tips.map(function(t) { return '<span class="' + (t.charAt(0) === '✓' ? 'on' : '') + '">' + t + '</span>'; }).join('') + '</div>';
  return html;
}

function mnCrewRow(kind, st) {
  var n = kind === 'h' ? st.humans : st.droids, free = kind === 'h' ? st.avail_h : st.avail_d;
  var rest = kind === 'h' ? st.rest_h : st.rest_d, hurt = mnHurt(st, kind);
  var busy = st.run ? (kind === 'h' ? st.run.humans : st.run.droids) : 0;
  var parts = [];
  if (busy) parts.push('на смене ' + busy);
  if (rest && free) parts.push('<span class="mn-rest" data-until="' + new Date(rest).getTime() + '">' + (kind === 'h' ? 'отдыхают' : 'на обслуживании') + '</span>');
  else if (free) parts.push('свободны ' + free);
  // выбывшие: травмы и поломки после аврала; бастуют (подстрекатели) и сбой (вирус) — после диверсии
  if (hurt.rush) parts.push('<span class="bad">' + (kind === 'h' ? 'травмы' : 'поломки') + ' ' + hurt.rush + '</span>');
  if (hurt.strike) parts.push('<span class="bad">бастуют ' + hurt.strike + ' · ещё ' + mnLeftAt(hurt.strikeUntil) + '</span>');
  if (hurt.virus) parts.push('<span class="bad">сбой ' + hurt.virus + ' · ещё ' + mnLeftAt(hurt.virusUntil) + '</span>');
  var price = kind === 'h' ? st.cfg.hire_h : st.cfg.hire_d, room = st.humans + st.droids < st.staff_max;
  return '<div class="mn-crew ' + kind + '">' +
    '<div class="mn-crew-ico">' + (kind === 'h' ? '<svg viewBox="0 0 20 20"><circle cx="10" cy="6" r="3.2"/><path d="M4 18c.6-4 3-6 6-6s5.4 2 6 6"/></svg>' : '<svg viewBox="0 0 20 20"><rect x="5" y="3" width="10" height="7" rx="2"/><circle cx="8.3" cy="6.5" r="1"/><circle cx="11.7" cy="6.5" r="1"/><path d="M7 10v3M13 10v3M5 13h10v4H5z"/></svg>') + '</div>' +
    '<div class="mn-crew-info"><b>' + (kind === 'h' ? 'Люди' : 'Дроиды') + ' · ' + n + '</b>' +
      '<span>' + (parts.length ? parts.join(' · ') : 'нет') + '</span>' +
      '<em>' + (kind === 'h' ? 'Короткие смены — до ×1,4 в час; устают: отдых — половина смены, не меньше часа' : 'Ровно держат долгие смены; отдых — четверть смены, не меньше 30 мин') + '</em></div>' +
    '<div class="mn-crew-btns">' +
      '<button type="button" class="mn-btn" data-mn="hire" data-k="' + kind + '"' + (room ? '' : ' disabled') + '>+ Нанять<small>' + price + ' кр</small></button>' +
      '<button type="button" class="mn-btn ghost" data-mn="fire" data-k="' + kind + '"' + (n - busy > 0 ? '' : ' disabled') + '>− Уволить</button>' +
    '</div></div>';
}

function mnRunHtml() {
  var r = mnState.run, col = (mnState.res || {}).color || '#8fa8c4';
  var crew = [r.humans ? mnWorkers(r.humans, 'h') : '', r.droids ? mnWorkers(r.droids, 'd') : ''].filter(Boolean).join(' + ');
  var warn = (!r.fed_h && r.humans) || (!r.fed_d && r.droids) ? '<div class="mn-note warn">' + (!r.fed_h && r.humans ? 'Людям не хватило пайка' : 'Дроидам не хватило обслуживания') + ' — выработка ×' + mnNum(mnState.cfg.hungry, 1) + '</div>' : '';
  return '<div class="mn-run" style="--mn-c:' + col + '">' +
    '<div class="mn-run-top"><span>' + (r.task && r.task !== 'extract' ? mnTaskName(r.task) + ' · ' : '') + r.len + ' ч · ' + MN_PACE[r.pace].toLowerCase() + (r.auto ? ' · автосмена' : '') + '</span><b id="mn-run-left"></b></div>' +
    '<div class="mn-run-crew">' + crew + (r.rate > 0 ? ' · ' + mnNum(r.rate, 1) + ' в час' : '') + (r.mult && Math.abs(r.mult - 1) > 0.005 ? ' · ' + mnW('участок', 'цех') + ' ×' + mnNum(r.mult, 2) : '') + '</div>' +
    (r.input ? '<div class="mn-run-crew">со склада взято: ' + mnInList(r.input) + ' — хватит на ' + r.cap + ' ед.</div>' : '') +
    '<div class="mn-bar"><i id="mn-run-bar"></i></div>' +
    mnRunGot(r, col) +
    warn +
    '<button type="button" class="mn-go danger" data-mn="stop">Закончить смену сейчас</button>' +
    '<div class="mn-note">' + (mnRef() ? {
      prep: 'Наладка засчитается, если отработать хотя бы половину смены: следующая переработка +25 %.',
      survey: 'Итог отладки — по концу смены. Закончить раньше можно, но шанс будет меньше: он растёт с отработанными часами.',
      maint: 'Ремонт засчитается по концу смены. Закончить раньше можно — починят за отработанные часы.',
      guard: 'Караул: пока идёт смена, бригада сторожит цех и шанс диверсии ниже. Готовое ляжет на склад по концу смены.'
    }[r.task] || 'Готовое ляжет на склад по концу смены; переработает всё взятое сырьё — смена закончится раньше. Закончить можно и самому: неизрасходованное сырьё вернётся на склад планеты.' : {
      prep: 'Вскрыша засчитается, если отработать хотя бы половину смены: следующая добыча +25 %.',
      survey: 'Итог разведки — по концу смены. Закончить раньше можно, но шанс будет меньше: он растёт с отработанными часами.',
      maint: 'Ремонт засчитается по концу смены. Закончить раньше можно — починят за отработанные часы.',
      guard: 'Караул: пока идёт смена, бригада сторожит участок и шанс диверсии ниже. Добытое ляжет на склад по концу смены.'
    }[r.task] || 'Добытое ляжет на склад по концу смены. Закончить раньше можно — придёт то, что успели.') + '</div>' +
  '</div>';
}

// Что даст идущая смена: добыча и вскрыша — счётчик, разведка — шанс, обслуживание — ремонт
function mnRunGot(r, col) {
  var st = mnState, n = (r.humans || 0) + (r.droids || 0);
  if (r.task === 'survey')
    return '<div class="mn-run-got"><span>' + mnW('Шанс найти жилу', 'Шанс отладить режим') + '</span><b style="color:#8fd3ff">' + Math.round(Math.min(0.6, 0.12 * r.len * n / 6) * 100) + ' %</b><em>к концу смены</em></div>';
  if (r.task === 'maint')
    return '<div class="mn-run-got"><span>Снимет износа</span><b style="color:#8fd3ff">−' + Math.round(Math.min(st.wear, n * r.len * 2 * (1 + 0.5 * Math.min(st.techs, st.techs_max)))) + ' %</b><em>сейчас ' + mnNum(st.wear, 0) + ' %</em></div>';
  return '<div class="mn-run-got"><span>' + mnW('Добыто', 'Сделано') + ' за смену</span><b id="mn-run-got" style="color:' + col + '"></b><em id="mn-run-of"></em></div>';
}

function mnFormHtml() {
  var st = mnState, f = mnForm, c = st.cfg, html = '';
  if (st.res_k <= 0) return '<div class="mn-empty bad">На планете нет залежи этого сырья — участок стоит</div>';
  var mh = st.rest_h ? 0 : st.avail_h, md = st.rest_d ? 0 : st.avail_d;
  html += '<div class="mn-form">';
  if (f.task === 'maint' && !(st.wear > 0)) f.task = 'extract';
  html += '<div class="mn-lab">Задача</div><div class="mn-chips tasks">' + MN_TASKS.map(function(t) {
    var off = t === 'maint' && !(st.wear > 0);
    return '<button type="button" class="mn-chip' + (f.task === t ? ' on' : '') + (t === 'guard' ? ' guard' : '') + '" data-mn="task" data-v="' + t + '"' + (off ? ' disabled' : '') + '>' + mnTaskName(t) + '<small>' + (mnRef() ? MN_TASK_SUB_R : MN_TASK_SUB)[t] + '</small></button>';
  }).join('') + '</div><div class="mn-hint">' + (mnRef() ? MN_TASK_HINT_R : MN_TASK_HINT)[f.task] +
    (f.task === 'guard' ? ' (−' + ((c.spy && c.spy.watch) || 20) + ' %)' : '') + '</div>';
  html += '<div class="mn-lab">Длина</div><div class="mn-chips lens">' + c.lens.map(function(l) {
    return '<button type="button" class="mn-chip' + (f.len === l ? ' on' : '') + '" data-mn="len" data-v="' + l + '">' + l + ' ч<small>×' + mnNum(c.k_h[l], 2) + '</small></button>';
  }).join('') + '</div>';
  html += '<div class="mn-hint">Чем короче смена, тем выше выработка в час, но всего за смену меньше. Множитель — для людей; у дроидов ' + mnNum(c.k_d[f.len], 2) + ' на ' + f.len + ' ч.</div>';
  html += '<div class="mn-lab">Темп</div><div class="mn-chips">' + ['careful', 'normal', 'rush'].map(function(p) {
    return '<button type="button" class="mn-chip' + (f.pace === p ? ' on' : '') + (p === 'rush' ? ' rush' : '') + '" data-mn="pace" data-v="' + p + '">' + MN_PACE[p] + '<small>×' + mnNum(c.pace[p], 2) + '</small></button>';
  }).join('') + '</div><div class="mn-hint">' + MN_PACE_HINT[f.pace] + (f.pace === 'rush' ? ' (~' + c.hurt_pct + ' % на ' + c.hurt_hours + ' ч)' : '') + '</div>';
  html += '<div class="mn-lab">Кто выходит · мест ' + st.places + '</div>';
  html += mnStepper('h', 'Люди', f.h, mh, st.rest_h) + mnStepper('d', 'Дроиды', f.d, md, st.rest_d);
  // прогноз
  // испорченный диверсантами паёк: ближайшая смена людей без пайка (как в mine_start)
  var fedH = st.planet.food >= f.h && !st.spoiled, fedD = st.planet.ore >= f.d, rate = mnRate(f.h, f.d, f.len, f.pace, fedH, fedD, f.task);
  var restH = f.h ? mnRestMin('h', f.len, f.pace) : 0, restD = f.d ? mnRestMin('d', f.len, f.pace) : 0;
  var wear = mnWear(f.h, f.d, f.len, f.pace, f.task), main, out = rate * f.len, take = '', noIn = false;
  // цех: сделает не больше, чем хватит сырья; столько и возьмёт со склада планеты
  if (st.refine && rate > 0 && (f.h + f.d) > 0) {
    var room = mnRoom(fedD ? f.d : 0), cap = Math.min(Math.ceil(out), room), tk = {};
    st.refine.inputs.forEach(function(x) { tk[x.id] = Math.ceil(cap * x.k); });
    noIn = cap < 1; out = Math.min(out, room);
    take = noIn ? '<span><i class="bad">нет сырья: ' + st.refine.inputs.map(function(x) { return mnEsc(x.name).toLowerCase() + ' ' + x.have; }).join(', ') + '</i></span>'
                : '<span>со склада возьмёт: ' + mnInList(tk) + (room < Math.ceil(rate * f.len) ? ' <i class="bad">— сырья хватит только на ' + room + '</i>' : '') + '</span>';
  }
  if (f.task === 'survey') main = '<b>' + Math.round(Math.min(0.6, 0.12 * f.len * (f.h + f.d) / 6) * 100) + ' %</b><span>' + mnW('шанс найти богатую жилу', 'шанс отладить режим') + '</span>';
  else if (f.task === 'maint') main = '<b>−' + Math.round(Math.min(st.wear, -wear)) + ' %</b><span>износа за смену (сейчас ' + mnNum(st.wear, 0) + ' %)</span>';
  else main = '<b>≈ ' + Math.round(out) + '</b><span>' + mnEsc((st.res || {}).name || '').toLowerCase() + ' за смену · ' + mnNum(rate, 1) + ' в час' + (f.task === 'prep' ? ' · потом ' + mnW('добыча', 'переработка') + ' +25 %' : '') + '</span>';
  html += '<div class="mn-fc">' +
    '<div class="mn-fc-main">' + main + '</div>' +
    '<div class="mn-fc-row">' +
      (f.h ? '<span>паёк: ' + (st.spoiled ? '<i class="bad">испорчен — смена выйдет без пайка</i>' : f.h + ' еды' + (fedH ? '' : ' <i class="bad">не хватает</i>')) + '</span>' : '') +
      (f.d ? '<span>обслуживание: ' + f.d + ' руды' + (fedD ? '' : ' <i class="bad">не хватает</i>') + '</span>' : '') +
      ((f.h || f.d) ? '<span>отдых после: ' + [restH ? 'люди ' + mnRestText(restH) : '', restD ? 'дроиды ' + mnRestText(restD) : ''].filter(Boolean).join(', ') + '</span>' : '') +
      ((f.h || f.d) && f.task !== 'maint' ? '<span>износ оборудования: +' + mnNum(wear, 1) + ' %</span>' : '') +
      take +
    '</div></div>';
  var can = (f.h + f.d) > 0 && !st.capture && !noIn;
  html += '<button type="button" class="mn-go" data-mn="start"' + (can ? '' : ' disabled') + '>Начать смену</button>';
  if (!mh && !md) html += '<div class="mn-note">Свободных и отдохнувших сейчас нет' + (st.auto.on ? ' — автосмена начнёт сама, как только бригада отдохнёт' : '') + '.</div>';
  html += '</div>';
  return html;
}

function mnStepper(kind, label, v, max, rest) {
  return '<div class="mn-step">' +
    '<span class="mn-step-lab">' + label + (rest ? ' <em class="mn-rest" data-until="' + new Date(rest).getTime() + '"></em>' : ' <em>можно ' + max + '</em>') + '</span>' +
    '<button type="button" class="mn-qty" data-mn="dec" data-k="' + kind + '"' + (v > 0 ? '' : ' disabled') + '>−</button>' +
    '<b>' + v + '</b>' +
    '<button type="button" class="mn-qty" data-mn="inc" data-k="' + kind + '"' + (v < max && mnForm.h + mnForm.d < mnState.places ? '' : ' disabled') + '>+</button>' +
  '</div>';
}

// Раз в секунду: ход смены и отдых — по часам клиента от момента ответа сервера
function mnLive() {
  var st = mnState; if (!st) return;
  var now = Date.now();
  mnHud(now);
  if (st.run) {
    var r = st.run, t0 = new Date(r.started_at).getTime(), t1 = new Date(r.ends_at).getTime();
    var got = mnGot(r, now), full = r.cap != null && got >= r.cap - 0.001;
    var k = Math.max(0, Math.min(1, (now - t0) / (t1 - t0)));
    var el = document.getElementById('mn-run-bar'); if (el) el.style.width = (k * 100).toFixed(1) + '%';
    el = document.getElementById('mn-run-got'); if (el) el.textContent = '+' + Math.floor(got);
    var of = r.accrued + r.rate * Math.max(0, t1 - mnAt) / 3600000; if (r.cap != null) of = Math.min(of, r.cap);
    el = document.getElementById('mn-run-of'); if (el) el.textContent = 'из ≈ ' + Math.round(of);
    el = document.getElementById('mn-run-left'); if (el) el.textContent = full ? 'сырьё переработано' : now < t1 ? 'ещё ' + mnLeft(t1 - now) : 'заканчивается…';
    // тик сервера раз в минуту закрыл смену (цех — и раньше конца, когда переработал всё взятое)
    if ((now > t1 + 70000 || (full && now - mnAt > 65000)) && !mnBusy) { mnAt = now; mnLoad(); }
  }
  var rs = document.querySelectorAll('#mn-body .mn-rest[data-until]'), due = false;
  for (var i = 0; i < rs.length; i++) {
    var u = +rs[i].getAttribute('data-until');
    if (u > now) rs[i].textContent = (rs[i].closest('.mn-step') ? 'отдых ' : (rs[i].textContent.indexOf('обслуж') >= 0 ? 'на обслуживании ' : 'отдыхают ')) + mnLeft(u - now);
    else due = true;
  }
  // происшествия: таймеры подхода и следствия по времени сервера
  var srv = mnSrvNow(), ts = document.querySelectorAll('#mn-body .mn-op-t[data-at]');
  for (i = 0; i < ts.length; i++) {
    var at = +ts[i].getAttribute('data-at');
    ts[i].textContent = at > srv ? ts[i].getAttribute('data-pre') + mnLeft(at - srv) : ts[i].getAttribute('data-done');
  }
  // момент действия или конец следствия прошёл — база решает это тактом раз в минуту, спрашиваем чаще обычного
  var wait = (st.ops || []).some(function(o) {
    return (!o.acted_at && srv > Date.parse(o.act_at)) || (o.result === 'ok' && !o.revealed && srv > Date.parse(o.reveal_at));
  }) || (st.raids || []).some(function(r) { return !r.acted_at && srv > Date.parse(r.raid_at); });
  // первые восемь раз — каждые 8 с, дальше раз в минуту (если такт базы застрял, окно не долбит её); в фоне — нет
  if (!wait) mnWaitN = 0;
  else if (!document.hidden && !mnBusy && now - mnAt > 8000 && now - mnWaitAt > (mnWaitN < 8 ? 8000 : 60000)) { mnWaitAt = now; mnWaitN++; mnLoad(); }
  if (!wait && due && !mnBusy && now - mnAt > 3000) mnLoad();
}

// Строка поверх сцены: что сейчас на участке
function mnHud(now) {
  var el = document.getElementById('mn-hud'), st = mnState; if (!el || !st) return;
  var html, srv = mnSrvNow(), near = null, fresh = null, band = null, bandDone = null;
  (st.ops || []).forEach(function(o) {
    if (!o.acted_at) { if (!near) near = o; }
    else if (!fresh && srv - Date.parse(o.acted_at) < 120000) fresh = o;
  });
  (st.raids || []).forEach(function(r) {
    if (!r.acted_at) { if (!band && srv >= Date.parse(r.approach_at)) band = r; }
    else if (!bandDone && srv - Date.parse(r.acted_at) < 120000) bandDone = r;
  });
  if (band) {
    var tr = Date.parse(band.raid_at);
    html = '<i class="alarm"></i>Банда у ' + mnW('участка', 'цеха') + ' · ' + (srv < tr ? 'налёт через ' + mnLeft(tr - srv) : 'бой у склада');
  } else if (bandDone) {
    html = bandDone.result === 'repelled' ? '<i class="on"></i>Налёт отбит · +' + (bandDone.bounty || 0) + ' кр' : '<i class="alarm"></i>Налёт · банда ушла с добычей';
  } else if (near) {
    var ta = Date.parse(near.act_at);
    html = '<i class="alarm"></i>Чужие у ' + mnW('участка', 'цеха') + ' · ' + (srv < ta ? 'действие через ' + mnLeft(ta - srv) : 'группа у цели');
  } else if (fresh) {
    html = fresh.result === 'caught' ? '<i class="alarm"></i>Тревога · диверсанты задержаны' : '<i class="alarm"></i>' + mnEsc(fresh.name || 'Происшествие');
  } else if (st.run) {
    var r = st.run, t1 = new Date(r.ends_at).getTime(), got = mnGot(r, now), full = r.cap != null && got >= r.cap - 0.001;
    var tn = r.task && r.task !== 'extract' ? mnTaskName(r.task) : 'Смена';
    html = '<i class="on"></i>' + tn + ' · ' + (full ? 'сырьё переработано' : now < t1 ? 'ещё ' + mnLeft(t1 - now) : 'заканчивается') + (r.rate > 0 ? ' · <b style="color:' + ((st.res || {}).color || '#cfd8dc') + '">+' + Math.floor(got) + '</b>' : '');
  } else if (st.res_k <= 0) html = '<i></i>Залежи нет';
  else if (st.refine && mnRoom(0) < 1) html = '<i class="warn"></i>Цех стоит · нет сырья';
  else if (st.rest_h || st.rest_d) html = '<i class="rest"></i>Бригада отдыхает' + (st.auto.on ? ' · автосмена ждёт' : '');
  else html = '<i></i>' + (st.auto.on ? 'Автосмена начнётся в течение минуты' : 'Смены нет');
  if (el.innerHTML !== html) el.innerHTML = html;
}

function mnErr(msg) { var e = document.getElementById('mn-err'); if (e) { e.textContent = msg || ''; e.style.display = msg ? 'block' : 'none'; } }

function mnCall(fn, args) {
  if (mnBusy || !mnBuilding) return;
  mnBusy = true; mnErr('');
  var bid = mnBuilding.id;
  args.p_building = bid;
  supabase.rpc(fn, args).then(function(r) {
    mnBusy = false;
    if (!mnBuilding || mnBuilding.id !== bid) return;
    if (r.error) { mnErr(r.error.message); return; }
    mnForm.touched = false;
    mnSet(r.data);
    if ((fn === 'mine_hire' || fn === 'mine_upgrade') && typeof refreshCreditsSoon === 'function') refreshCreditsSoon();
    if (typeof loadPlanetStock === 'function') loadPlanetStock();
  }, function() { mnBusy = false; mnErr('Нет связи с сервером'); });
}

function mnClick(e) {
  var b = e.target.closest('[data-mn]'); if (!b || b.disabled || !mnState) return;
  var act = b.getAttribute('data-mn'), v = b.getAttribute('data-v'), k = b.getAttribute('data-k'), st = mnState;
  if (act === 'len') { mnForm.len = +v; mnForm.touched = true; mnRender(); }
  else if (act === 'pace') { mnForm.pace = v; mnForm.touched = true; mnRender(); }
  else if (act === 'inc' || act === 'dec') {
    mnForm[k] += act === 'inc' ? 1 : -1; mnForm.touched = true; mnClamp(); mnRender();
  }
  else if (act === 'task') { mnForm.task = v; mnForm.touched = true; mnRender(); }
  else if (act === 'start') mnCall('mine_shift_start', { p_len: mnForm.len, p_pace: mnForm.pace, p_humans: mnForm.h, p_droids: mnForm.d, p_task: mnForm.task });
  else if (act === 'upgrade') {
    var u = st.upgrade, up = function() { mnCall('mine_upgrade', {}); };
    var items = [{ text: u.credits + ' кр.', kind: 'credits' }, { text: 'Дюрасталь ' + u.durasteel, color: '#8fa8c4', bad: st.planet.durasteel < u.durasteel }];
    if (u.electronics) items.push({ text: 'Электроника ' + u.electronics, color: '#4a90d9', bad: st.planet.electronics < u.electronics });
    if (typeof gameConfirm === 'function') gameConfirm({ tone: 'build', kicker: mnW('Улучшение участка', 'Улучшение цеха'), title: 'Мест работы: ' + st.places + ' → ' + u.places,
      rows: [{ label: 'Спишется', items: items }], note: 'Барак вырастет вместе с ' + mnW('участком', 'цехом') + ': до ' + u.places * 2 + ' рабочих. Сырьё — со склада планеты.', ok: 'Улучшить' }, up);
    else up();
  }
  else if (act === 'stop') {
    var go = function() { mnCall('mine_shift_stop', {}); };
    if (typeof gameConfirm === 'function') gameConfirm({ tone: 'danger', kicker: 'Смена', title: 'Закончить сейчас?', note: mnW('Придёт то, что успели добыть, бригада уйдёт на отдых.', 'Придёт то, что успели сделать, неизрасходованное сырьё вернётся на склад планеты, бригада уйдёт на отдых.'), ok: 'Закончить', cancel: 'Пусть работают' }, go);
    else if (confirm('Закончить смену сейчас?')) go();
  }
  else if (act === 'auto-toggle') mnCall('mine_auto_set', { p_on: !st.auto.on, p_len: st.auto.len, p_pace: st.auto.pace });
  else if (act === 'auto-len') mnCall('mine_auto_set', { p_on: st.auto.on, p_len: +v, p_pace: st.auto.pace });
  else if (act === 'auto-pace') mnCall('mine_auto_set', { p_on: st.auto.on, p_len: st.auto.len, p_pace: v });
  else if (act === 'op-guard') mnHireConfirm('g');
  else if (act === 'op-watch') {
    // караул — задача смены: выбираем её в форме и показываем форму
    mnForm.task = 'guard'; mnForm.touched = true; mnRender();
    var fm = document.querySelector('#mn-body .mn-form');
    if (fm && fm.scrollIntoView) fm.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  else if (act === 'hire') mnHireConfirm(k);
  else if (act === 'fire') {
    var fire = function() { mnCall('mine_fire', { p_kind: k, p_n: 1 }); };
    if (typeof gameConfirm === 'function') gameConfirm({ tone: 'danger', kicker: k === 'g' ? 'Охрана' : 'Бригада', title: { h: 'Уволить рабочего?', d: 'Списать дроида?', f: 'Уволить бригадира?', t: 'Уволить техника?', g: 'Снять охранника с поста?' }[k], note: 'Деньги за найм не вернутся.', ok: k === 'd' ? 'Списать' : 'Уволить' }, fire);
    else if (confirm('Уволить?')) fire();
  }
}

function mnHireConfirm(k) {
  var st = mnState; if (!st) return;
  var price = { h: st.cfg.hire_h, d: st.cfg.hire_d, f: st.cfg.hire_f, t: st.cfg.hire_t, g: st.cfg.hire_g }[k];
  var hire = function() { mnCall('mine_hire', { p_kind: k, p_n: 1 }); };
  var spy = st.cfg.spy || {};
  var HI = {
    h: ['Рабочий', 'Паёк — 1 еда за смену', 'Люди выгоднее на коротких сменах, но после смены дольше отдыхают.'],
    d: ['Дроид-рабочий', 'Обслуживание — 1 руда за смену', 'Дроиды ровно держат долгие смены и отдыхают меньше.'],
    f: ['Бригадир', 'Ведёт каждую смену ' + mnW('участка', 'цеха'), '+10 % к выработке; в аврале травм и поломок вдвое меньше.'],
    t: ['Техник', 'Чинит оборудование между сменами', 'Каждый техник снимает 1 % износа в час, на обслуживании — быстрее.'],
    g: ['Охранник', 'Стоит на посту у ' + mnW('участка', 'цеха'), 'Каждый на посту — шанс диверсии −' + (spy.guard || 12) + ' %, а следствие идёт вдвое быстрее. В смены не выходит, паёк не нужен.']
  }[k];
  if (typeof gameConfirm === 'function') gameConfirm({ tone: 'build', kicker: k === 'g' ? 'Охрана' : mnW('Найм на участок', 'Найм в цех'), title: HI[0], sub: HI[1],
    rows: [{ label: 'Спишется', items: [{ text: price + ' кр.', kind: 'credits' }] }], note: HI[2], ok: 'Нанять' }, hire);
  else hire();
}
