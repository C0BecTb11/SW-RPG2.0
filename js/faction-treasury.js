// Казна фракции: взносы игроков, налог и займы по законам, проекты на планетах, выплаты игрокам.
//
// Сервер (sql/treasury.sql) решает всё сам: treasury_state — остаток, налог, займы, проекты, планеты,
// журнал; treasury_donate / treasury_grant / treasury_project — действия, возвращают свежий treasury_state.
// Тратят лидер и должности с полномочием «Казна» — сервер проверяет это при каждом действии.
//
// Здесь: раздел «Казна» в окне фракции (fsRenderTreasury — его зовёт fsRender в faction-panel.js)
// и шторка «Казна» (режим 'treasury' общей шторки штаба из faction-staff.js) с вкладками
// «Взнос» / «Проекты» / «Выплаты» / «Журнал». Загрузка — вместе со сводкой фракции (tsFetch в fsLoad). ES5.

var TS_KIND = {
  extract:    { up: 'добыча',     unit: '%' },
  income:     { up: 'доход',      unit: '%' },
  mood:       { up: 'довольство', unit: '' },
  hire_time:  { time: 'найм' },
  build_time: { time: 'стройка' },
  loyalty:    { up: 'поддержка народа', unit: ' в сутки' }
};

var TS_LOG = {
  donate:  'взнос',
  grant:   'выплата',
  project: 'проект',
  tax:     'налог с поселений',
  law:     'заём по закону',
  debt:    'расчёт по займу'
};

var tsState = {
  data: null,
  tab: 'give',       // give | projects | grants | log
  planet: null,      // выбранная планета во вкладке «Проекты»
  busy: false,
  skew: 0
};

function tsEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function tsNum(n) { return typeof fsNum === 'function' ? fsNum(n) : String(Math.round(Number(n) || 0)); }
function tsMs(iso) { var t = new Date(iso).getTime(); return isNaN(t) ? 0 : t; }
function tsNow() { return Date.now() + tsState.skew; }
function tsAgo(iso) { return typeof fsAgo === 'function' ? (fsAgo(iso) || '') : ''; }

function tsLeft(iso) {
  var sec = Math.max(0, Math.floor((tsMs(iso) - tsNow()) / 1000));
  var d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  if (d > 0) return d + ' д' + (h ? ' ' + h + ' ч' : '');
  if (h > 0) return h + ' ч' + (m ? ' ' + m + ' мин' : '');
  return Math.max(1, m) + ' мин';
}

function tsEffect(kind, v) {
  var k = TS_KIND[kind] || { up: kind, unit: '' };
  v = v | 0;
  if (k.time) return { good: v < 0, text: k.time + (v < 0 ? ' быстрее' : ' дольше') + ' на ' + Math.abs(v) + '%' };
  return { good: v > 0, text: k.up + ' ' + (v > 0 ? '+' : '−') + Math.abs(v) + k.unit };
}

function tsHours(h) { return h % 24 === 0 && h >= 48 ? (h / 24) + ' ' + (typeof fsPlural === 'function' ? fsPlural(h / 24, 'сутки', 'суток', 'суток') : 'сут.') : h + ' ч'; }

// ── Загрузка ───────────────────────────────────────────────────────

function tsFetch() {
  if (typeof supabase === 'undefined') return Promise.resolve(null);
  return Promise.resolve(supabase.rpc('treasury_state')).then(function(r) {
    if (r && !r.error && r.data) tsSet(r.data);
    return tsState.data;
  }, function() { return tsState.data; });
}

function tsSet(d) {
  tsState.data = d;
  if (d && d.now) tsState.skew = tsMs(d.now) - Date.now();
  var planets = (d && d.planets) || [];
  if (!tsState.planet || !planets.some(function(p) { return p.id === tsState.planet; })) tsState.planet = planets.length ? planets[0].id : null;
}

function tsRepaint() {
  if (typeof fsState !== 'undefined' && fsState.open && fsState.data && typeof fsRender === 'function') fsRender(false);
  if (typeof hqState !== 'undefined' && hqState.mode === 'treasury') tsRenderSheet();
}

// ── Раздел в окне фракции ──────────────────────────────────────────

function fsRenderTreasury() {
  var d = tsState.data;
  if (!d || !d.faction) return '';
  var bal = d.balance | 0, debts = d.debts || [], running = 0;
  (d.planets || []).forEach(function(p) { running += (p.running || []).length; });

  var html = '<section class="fs-sec ts-sec">' + fsSecHead('Казна', d.can_spend ? 'распоряжаешься ты' : 'общая для фракции');
  html += '<button type="button" class="ts-card' + (bal < 0 ? ' debt' : '') + '" data-act="ts-open" data-tab="give">' +
    '<span class="ts-bal"><b>' + tsNum(bal) + '</b><i>кр.' + (bal < 0 ? ' · долг' : '') + '</i></span>' +
    '<span class="ts-tags">' +
      ((d.tax | 0) > 0 ? '<em class="up">налог ' + (d.tax | 0) + '% с поселений</em>' : '') +
      debts.map(function(x) { return '<em class="down">возврат ' + tsNum(Math.abs(x.amount)) + ' через ' + tsLeft(x.at) + '</em>'; }).join('') +
      (running ? '<em class="on">' + running + ' ' + (typeof fsPlural === 'function' ? fsPlural(running, 'проект идёт', 'проекта идут', 'проектов идут') : 'проектов') + '</em>' : '') +
      (!(d.tax | 0) && !debts.length && !running ? '<em>пополняют взносы, налог и займы</em>' : '') +
    '</span>' +
    '<span class="fs-chev">›</span>' +
  '</button>';

  var last = (d.log || []).slice(0, 3);
  if (last.length) {
    html += '<div class="ts-mini">';
    last.forEach(function(x) { html += tsLogRow(x, true); });
    html += '</div>';
  }
  html += '<div class="ts-acts">' +
    '<button type="button" class="fs-more" data-act="ts-open" data-tab="give">Сделать взнос</button>' +
    (d.can_spend ? '<button type="button" class="fs-more" data-act="ts-open" data-tab="projects">Проекты и выплаты</button>'
                 : '<button type="button" class="fs-more" data-act="ts-open" data-tab="log">Журнал казны</button>') +
  '</div>';
  return html + '</section>';
}

function tsLogText(x) {
  var who = x.by ? tsEsc(x.by) : '';
  switch (x.kind) {
    case 'donate':  return (who || 'игрок') + ' — взнос';
    case 'grant':   return (who ? who + ' → ' : '') + tsEsc(x.to || 'игрок') + (x.note ? ' · <em>' + tsEsc(x.note) + '</em>' : '');
    case 'project': return tsEsc(x.note || 'проект') + (x.planet ? ' · ' + tsEsc(x.planet) : '') + (who ? ' · ' + who : '');
    case 'tax':     return 'налог ' + tsEsc(x.note || '') + ' · ' + (x.n | 0) + ' ' + (typeof fsPlural === 'function' ? fsPlural(x.n | 0, 'планета', 'планеты', 'планет') : 'пл.');
    case 'law':     return 'заём · ' + tsEsc(x.note || '');
    case 'debt':    return 'возврат займа · ' + tsEsc(x.note || '');
  }
  return tsEsc(TS_LOG[x.kind] || x.kind);
}

function tsLogRow(x, mini) {
  var n = x.amount | 0;
  return '<div class="ts-log' + (mini ? ' mini' : '') + '">' +
    '<span class="ts-log-v ' + (n >= 0 ? 'up' : 'down') + '">' + (n > 0 ? '+' : '') + tsNum(n) + '</span>' +
    '<span class="ts-log-t">' + tsLogText(x) + (mini ? '' : '<i>' + tsEsc(tsAgo(x.at)) + ' · остаток ' + tsNum(x.balance) + '</i>') + '</span>' +
    (mini ? '<span class="ts-log-a">' + tsEsc(tsAgo(x.at)) + '</span>' : '') +
  '</div>';
}

// ── Действия ───────────────────────────────────────────────────────

function tsCall(name, args, okText) {
  if (tsState.busy) return;
  tsState.busy = true;
  tsRepaint();
  Promise.resolve(supabase.rpc(name, args)).then(function(r) {
    tsState.busy = false;
    if (r.error) {
      if (typeof hqToast === 'function') hqToast(gameErr(r.error), true);
      tsRepaint();
      return;
    }
    tsSet(r.data);
    tsRepaint();
    if (okText && typeof hqToast === 'function') hqToast(okText);
    if (typeof refreshCreditsBar === 'function') refreshCreditsBar();
  }, function() {
    tsState.busy = false;
    if (typeof hqToast === 'function') hqToast('Нет связи с сервером', true);
    tsRepaint();
  });
}

// Кнопки раздела в окне фракции (faction-panel.js передаёт сюда всё с data-act="ts-…")
function tsOnBody(act, t) {
  if (act === 'ts-open') {
    tsState.tab = t.getAttribute('data-tab') || 'give';
    if (typeof hqOpen === 'function') hqOpen('treasury');
  }
}

function tsValue(id) {
  var el = document.getElementById(id);
  var v = el ? parseInt(String(el.value).replace(/\s+/g, ''), 10) : NaN;
  return isFinite(v) ? v : 0;
}

// Кнопки шторки (faction-staff.js передаёт сюда всё с data-hq="ts-…")
function tsOnSheet(act, id, t) {
  var d = tsState.data || {};
  if (act === 'ts-tab') { tsState.tab = id; tsRenderSheet(); var b = document.getElementById('hq-body'); if (b) b.scrollTop = 0; return; }
  if (act === 'ts-amount') { var inp = document.getElementById(t.getAttribute('data-for')); if (inp) { inp.value = id; inp.focus(); } return; }
  if (act === 'ts-planet') { tsState.planet = id; tsRenderSheet(); return; }
  if (act === 'ts-donate') {
    var a = tsValue('ts-give-sum');
    if (a < (d.min_donate | 0)) { hqToast('Взнос — от ' + tsNum(d.min_donate) + ' кр.', true); return; }
    if (a > (d.credits | 0)) { hqToast('У тебя только ' + tsNum(d.credits) + ' кр.', true); return; }
    tsCall('treasury_donate', { p_amount: a }, 'В казну внесено ' + tsNum(a) + ' кр.');
    return;
  }
  if (act === 'ts-grant') {
    var who = document.getElementById('ts-grant-who'), note = document.getElementById('ts-grant-note');
    var sum = tsValue('ts-grant-sum'), uid = who ? who.value : '';
    if (!uid) { hqToast('Выбери игрока', true); return; }
    if (sum < (d.min_grant | 0)) { hqToast('Выплата — от ' + tsNum(d.min_grant) + ' кр.', true); return; }
    if (sum > (d.balance | 0)) { hqToast('В казне только ' + tsNum(Math.max(0, d.balance | 0)) + ' кр.', true); return; }
    var nick = who.options[who.selectedIndex] ? who.options[who.selectedIndex].text : '';
    var go = function() { tsCall('treasury_grant', { p_user: uid, p_amount: sum, p_note: note ? note.value : null }, nick + ': +' + tsNum(sum) + ' кр. из казны'); };
    if (typeof gameConfirm === 'function') gameConfirm({ tone: 'build', kicker: 'Казна', title: 'Выплатить ' + tsNum(sum) + ' кр.', sub: 'Игроку ' + nick + '. Выплата попадёт в журнал казны — его видит вся фракция.', ok: 'Выплатить', cancel: 'Отмена' }, go);
    else go();
    return;
  }
  if (act === 'ts-project') {
    var p = null, pl = null;
    (d.projects || []).forEach(function(x) { if (x.id === id) p = x; });
    (d.planets || []).forEach(function(x) { if (x.id === tsState.planet) pl = x; });
    if (!p || !pl) return;
    var fx = tsEffect(p.kind, p.value);
    var run = function() { tsCall('treasury_project', { p_project: p.id, p_system: pl.id }, '«' + p.title + '» — ' + pl.name); };
    if (typeof gameConfirm === 'function') gameConfirm({ tone: 'build', kicker: 'Проект казны · ' + pl.name, title: p.title, sub: fx.text + ' на ' + tsHours(p.hours) + '. Из казны уйдёт ' + tsNum(p.cost) + ' кр.', ok: 'Запустить', cancel: 'Отмена' }, run);
    else run();
  }
}

// ── Шторка «Казна» ─────────────────────────────────────────────────

function tsRenderSheet() {
  var d = tsState.data;
  var fac = d && d.faction;
  if (typeof hqSetHead === 'function') {
    hqSetHead('Казна · ' + (fac === 'cis' ? 'КНС' : 'Республика'),
      d ? tsNum(d.balance) + ' кр.' + ((d.tax | 0) > 0 ? ' · налог ' + (d.tax | 0) + '%' : '') + (d.can_spend ? ' · распоряжаешься ты' : '') : '');
  }
  var body = document.getElementById('hq-body'), foot = document.getElementById('hq-foot');
  if (!body) return;
  if (foot) foot.innerHTML = '';
  if (!d || !fac) { body.innerHTML = '<div class="hq-empty">Казна появится, когда у тебя будет фракция.</div>'; return; }

  var tabs = [['give', 'Взнос'], ['projects', 'Проекты']];
  if (d.can_spend) tabs.push(['grants', 'Выплаты']);
  tabs.push(['log', 'Журнал']);
  if (!tabs.some(function(t) { return t[0] === tsState.tab; })) tsState.tab = 'give';

  var h = '<div class="ts-tabs">' + tabs.map(function(t) {
    return '<button type="button" class="ts-tab' + (tsState.tab === t[0] ? ' on' : '') + '" data-hq="ts-tab" data-id="' + t[0] + '">' + t[1] + '</button>';
  }).join('') + '</div>';

  if (tsState.tab === 'give') h += tsSheetGive(d);
  else if (tsState.tab === 'projects') h += tsSheetProjects(d);
  else if (tsState.tab === 'grants') h += tsSheetGrants(d);
  else h += tsSheetLog(d);
  body.innerHTML = h;
}

function tsBalanceCard(d) {
  var bal = d.balance | 0, debts = d.debts || [];
  return '<div class="ts-card static' + (bal < 0 ? ' debt' : '') + '"><span class="ts-bal"><b>' + tsNum(bal) + '</b><i>кр. в казне' + (bal < 0 ? ' · долг' : '') + '</i></span>' +
    '<span class="ts-tags">' + ((d.tax | 0) > 0 ? '<em class="up">налог ' + (d.tax | 0) + '% с поселений</em>' : '') +
      debts.map(function(x) { return '<em class="down">возврат займа «' + tsEsc(x.title) + '» ' + tsNum(Math.abs(x.amount | 0)) + ' через ' + tsLeft(x.at) + '</em>'; }).join('') + '</span></div>';
}

function tsAmounts(input, list) {
  return '<div class="ts-chips">' + list.map(function(v) {
    return '<button type="button" class="ts-chip" data-hq="ts-amount" data-id="' + v + '" data-for="' + input + '">' + tsNum(v) + '</button>';
  }).join('') + '</div>';
}

function tsSheetGive(d) {
  var mine = d.credits | 0, min = d.min_donate | 0;
  var h = tsBalanceCard(d);
  h += '<div class="hq-block">Взнос в казну</div>' +
    '<div class="hq-note">У тебя ' + tsNum(mine) + ' кр. Взнос — от ' + tsNum(min) + ' кр., его видит вся фракция в журнале.</div>' +
    tsAmounts('ts-give-sum', [100, 500, 1000, 5000].filter(function(v) { return v <= Math.max(mine, min); })) +
    '<input class="hq-input" id="ts-give-sum" type="number" inputmode="numeric" min="' + min + '" step="100" value="' + Math.min(500, Math.max(min, mine)) + '">' +
    '<button type="button" class="hq-go" data-hq="ts-donate"' + (tsState.busy || mine < min ? ' disabled' : '') + '>' + (tsState.busy ? 'Отправляем…' : 'Внести в казну') + '</button>';
  h += '<div class="ts-how">' +
    '<b>Откуда деньги</b>' +
    '<span>взносы игроков;</span>' +
    '<span>налог с дохода поселений — по закону о налоге;</span>' +
    '<span>заём по закону — сразу в казну, через неделю возврат с процентами. Не хватит — казна уйдёт в долг, и новый заём не дадут.</span>' +
    '<b>На что тратится</b>' +
    '<span>проекты на планетах фракции и выплаты игрокам. Распоряжается лидер и должности с полномочием «Казна».</span>' +
  '</div>';
  return h;
}

function tsSheetProjects(d) {
  var planets = d.planets || [], pl = null;
  planets.forEach(function(p) { if (p.id === tsState.planet) pl = p; });
  if (!planets.length) return '<div class="hq-empty">У фракции нет планет — проектам негде идти.</div>';
  var h = '<div class="hq-note">' + (d.can_spend ? 'Проект даёт выбранной планете временный бонус. В казне ' + tsNum(d.balance) + ' кр.'
                                         : 'Проекты запускает лидер и должности с полномочием «Казна».') + '</div>';
  h += '<div class="ts-planets">' + planets.map(function(p) {
    var n = (p.running || []).length;
    return '<button type="button" class="ts-planet' + (p.id === tsState.planet ? ' on' : '') + '" data-hq="ts-planet" data-id="' + tsEsc(p.id) + '">' +
      tsEsc(p.name) + (n ? '<i>' + n + '</i>' : '') + '</button>';
  }).join('') + '</div>';
  if (pl) h += '<div class="ts-owner">' + (pl.owner ? 'управляет ' + tsEsc(pl.owner) + (pl.mine ? ' — это ты' : '') : 'без управляющего — доход поселения никому не идёт') + '</div>';

  (d.projects || []).forEach(function(p) {
    var run = null;
    ((pl && pl.running) || []).forEach(function(r) { if (r.project === p.id) run = r; });
    var fx = tsEffect(p.kind, p.value), poor = (d.balance | 0) < (p.cost | 0);
    h += '<div class="ts-proj' + (run ? ' on' : '') + '">' +
      '<div class="ts-proj-head"><b>' + tsEsc(p.title) + '</b><span>' + tsNum(p.cost) + ' кр.</span></div>' +
      '<div class="ts-proj-text">' + tsEsc(p.text) + '</div>' +
      '<div class="sn-fx"><i class="' + (fx.good ? 'up' : 'down') + '">' + tsEsc(fx.text) + '</i><i class="time">' + tsHours(p.hours) + '</i></div>';
    if (run) h += '<div class="ts-proj-run" data-ts-end="' + tsMs(run.ends) + '">идёт · ещё ' + tsLeft(run.ends) + '</div>';
    else if (d.can_spend) {
      h += '<button type="button" class="hq-small wide" data-hq="ts-project" data-id="' + tsEsc(p.id) + '"' + (poor || tsState.busy ? ' disabled' : '') + '>' +
        (poor ? 'В казне не хватает ' + tsNum((p.cost | 0) - Math.max(0, d.balance | 0)) + ' кр.' : 'Запустить · ' + tsNum(p.cost) + ' кр.') + '</button>';
    }
    h += '</div>';
  });
  return h;
}

function tsSheetGrants(d) {
  var members = d.members || [], bal = d.balance | 0;
  var h = tsBalanceCard(d);
  if (!members.length) return h + '<div class="hq-empty">Во фракции пока нет других игроков.</div>';
  h += '<div class="hq-block">Выплата игроку</div>' +
    '<div class="hq-note">Деньги уходят из казны игроку своей фракции. Выплата попадает в журнал — его видят все.</div>' +
    '<select class="hq-select" id="ts-grant-who"><option value="">— кому —</option>' +
      members.map(function(m) { return '<option value="' + tsEsc(m.id) + '">' + tsEsc(m.nick) + '</option>'; }).join('') + '</select>' +
    tsAmounts('ts-grant-sum', [100, 500, 1000, 2000].filter(function(v) { return v <= Math.max(bal, d.min_grant | 0); })) +
    '<input class="hq-input" id="ts-grant-sum" type="number" inputmode="numeric" min="' + (d.min_grant | 0) + '" step="50" value="' + Math.max(d.min_grant | 0, Math.min(500, bal)) + '">' +
    '<input class="hq-input" id="ts-grant-note" type="text" maxlength="60" placeholder="за что — необязательно">' +
    '<button type="button" class="hq-go" data-hq="ts-grant"' + (tsState.busy || bal < (d.min_grant | 0) ? ' disabled' : '') + '>' +
      (bal < (d.min_grant | 0) ? 'В казне пусто' : tsState.busy ? 'Отправляем…' : 'Выплатить') + '</button>';
  return h;
}

function tsSheetLog(d) {
  var log = d.log || [];
  if (!log.length) return '<div class="hq-empty">Журнал пуст: в казну ещё ничего не поступало.</div>';
  return '<div class="hq-note">Последние ' + log.length + ' движений. Журнал видит вся фракция.</div>' + log.map(function(x) { return tsLogRow(x, false); }).join('');
}

// Обратные отсчёты проектов без перерисовки
function tsTick() {
  var els = document.querySelectorAll('[data-ts-end]'), due = false;
  for (var i = 0; i < els.length; i++) {
    var end = parseInt(els[i].getAttribute('data-ts-end'), 10);
    if (end <= tsNow()) { due = true; continue; }
    els[i].textContent = 'идёт · ещё ' + tsLeft(new Date(end).toISOString());
  }
  if (due && !tsTick.wait) {
    tsTick.wait = true;
    setTimeout(function() { tsTick.wait = false; tsFetch().then(tsRepaint); }, 2000);
  }
}

document.addEventListener('DOMContentLoaded', function() {
  setInterval(function() { if (typeof hqState !== 'undefined' && hqState.mode === 'treasury') tsTick(); }, 1000);
});
