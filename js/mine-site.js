// Участок добычи (шаг 1 плана claude/mining-plan.md): бригада людей и дроидов, смены, автосмена, найм.
// Выработку считает база (sql/mine_sites.sql); окно показывает её же числа и между опросами
// досчитывает добытое за смену по той же ставке. Префикс классов и функций — mn-/mn*.
// Открывается тапом по готовой добывающей постройке (js/ground-battle.js → openMineSite).

var mnState = null;        // последнее состояние с сервера
var mnBuilding = null;     // строка постройки
var mnAt = 0;              // когда пришло состояние (мс, часы клиента)
var mnPoll = null, mnTick = null, mnBusy = false, mnSeq = 0;
var mnOpenAt = 0, mnDownBack = false;   // касание фона закрывает шторку, только если оно на фоне и началось
var mnForm = { len: 8, pace: 'normal', task: 'extract', h: 0, d: 0, touched: false };
var MN_PACE = { careful: 'Бережно', normal: 'Обычно', rush: 'Аврал' };
var MN_PACE_HINT = {
  careful: 'медленнее, зато отдых вдвое короче',
  normal: 'обычная выработка и отдых',
  rush: 'быстрее, но отдых дольше, а часть бригады может выбыть'
};
var MN_TASK = { extract: 'Добыча', prep: 'Вскрыша', survey: 'Разведка жилы', maint: 'Обслуживание' };
var MN_TASK_SUB = { extract: 'сырьё ×1', prep: '×0,2 → добыча +25 %', survey: 'жила +40 % на сутки', maint: 'ремонт оборудования' };
var MN_TASK_HINT = {
  extract: 'основная работа: сырьё на склад',
  prep: 'почти без выхода, зато следующая смена добычи даст +25 %',
  survey: 'без выхода: шанс найти богатую жилу — +40 % к добыче на сутки',
  maint: 'без выхода: бригада чинит оборудование, техники ускоряют ремонт'
};
var MN_KIND = {
  rep_mine: 'Рудник', cis_mine: 'Рудник', rep_gas: 'Газовый промысел', cis_gas: 'Газовый промысел',
  rep_crystal: 'Кристальная выработка', cis_crystal: 'Кристальная выработка', rep_farm: 'Ферма', cis_farm: 'Ферма'
};

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

// Постройка — добыча (не передел)?
function isMineBuilding(code) {
  if (!code || typeof buildingTypes === 'undefined' || !buildingTypes) return false;
  for (var i = 0; i < buildingTypes.length; i++) {
    var t = buildingTypes[i];
    if (t.code === code) return !!t.produces_resource && (!t.consumes || !Object.keys(t.consumes).length);
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
  mnBuilding = building; mnOpenAt = Date.now(); mnDownBack = false;
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
  var dep = st.res_k >= 1 ? 'основная залежь' : st.res_k > 0 ? 'попутная залежь · вполовину' : 'залежи нет';

  // --- сводка
  html += '<div class="mn-card" style="border-left-color:' + col + '">' +
    '<div class="mn-res"><i style="background:' + col + '"></i><b>' + mnEsc(res.name) + '</b><span>' + dep + '</span></div>' +
    '<div class="mn-kpis">' +
      '<div><em>в сутки</em><b>' + (st.auto.on ? '≈ ' + st.day : '—') + '</b><span>' + (st.auto.on ? 'по автосмене' : 'автосмена выкл.') + '</span></div>' +
      '<div><em>бригада</em><b>' + (st.humans + st.droids) + '<small>/' + st.staff_max + '</small></b><span>мест работы ' + st.places + '</span></div>' +
      '<div><em>склад участка</em><b>' + st.stock + '<small>/' + st.site_cap + '</small></b><span>планета ' + st.planet.res + '/' + st.planet.cap + '</span></div>' +
    '</div>' +
    mnStateHtml(st) +
    (st.eff ? '<div class="mn-eff ' + (st.eff > 0 ? 'up' : 'down') + '">Эффекты планеты: добыча ' + (st.eff > 0 ? '+' : '−') + Math.abs(st.eff) + ' %</div>' : '') +
    (st.capture ? '<div class="mn-eff down">На планете идёт захват — новые смены не начать</div>' : '') +
  '</div>';

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
      '<div class="mn-note">Бригада сама выходит на смену, когда отдохнула: сначала дроиды, свободные места — людям. Так участок работает, пока тебя нет. Короткие смены (1–4 ч) дают больше в час, но их запускаешь сам.</div>' +
    '</div>';

  // --- бригада
  html += '<div class="mn-sec">Бригада · в бараке ' + (st.humans + st.droids) + ' из ' + st.staff_max + '</div>';
  html += mnCrewRow('h', st) + mnCrewRow('d', st);
  html += '<div class="mn-note">На смену выходит не больше ' + st.places + ' — по числу мест работы. Остальные отдыхают и сменяют уставших. ' +
    'Люди: паёк — 1 еда за смену (на планете ' + st.planet.food + '). Дроиды: обслуживание — 1 руда за смену (на планете ' + st.planet.ore + '). Без него выработка ×' + mnNum(st.cfg.hungry, 1) + '.</div>';

  // --- специалисты
  html += '<div class="mn-sec">Специалисты</div>' + mnSpecRow('f', st) + mnSpecRow('t', st);

  // --- участок: места работы
  html += mnUpgradeHtml(st);

  // --- последние смены
  if (st.last && st.last.length) {
    html += '<div class="mn-sec">Последние смены</div><div class="mn-log">';
    st.last.forEach(function(x) {
      var when = new Date(x.ended_at || x.started_at), hm = when.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
      var crew = [x.humans ? mnWorkers(x.humans, 'h') : '', x.droids ? mnWorkers(x.droids, 'd') : ''].filter(Boolean).join(' + ');
      var tag = x.status === 'stopped' ? 'остановлена' : x.status === 'lost' ? 'сорвана' : x.auto ? 'авто' : '';
      var task = x.task && x.task !== 'extract' ? MN_TASK[x.task] + ' · ' : '';
      html += '<div class="mn-log-row"><span class="t">' + hm + '</span><span class="w">' + task + x.len + ' ч · ' + MN_PACE[x.pace].toLowerCase() + ' · ' + crew + (tag ? ' · <i>' + tag + '</i>' : '') + (x.fed ? '' : ' · <i class="bad">без пайка</i>') +
        (x.result ? '<br><i class="res">' + mnEsc(x.result) + '</i>' : '') + '</span>' +
        (x.got || !x.task || x.task === 'extract' ? '<b style="color:' + col + '">+' + x.got + '</b>' : '') + (x.lost ? '<em class="bad">−' + x.lost + '</em>' : '') + '</div>';
    });
    html += '</div>';
  }
  var lostNow = 0; (st.last || []).forEach(function(x) { lostNow += x.lost || 0; });
  if (lostNow) html += '<div class="mn-note warn">Склад участка переполнялся: потеряно ' + lostNow + '. Освободи склад планеты или подними его предел — тогда добытое переходит туда само.</div>';
  html += '<div class="mn-err" id="mn-err"></div>';
  body.innerHTML = html;
  mnLive();
}

// Состояние участка: оборудование, опыт бригады, жила, вскрыша — и что это даёт к выработке
function mnStateHtml(st) {
  var w = st.wear || 0, wk = w >= 60 ? 'bad' : w >= 25 ? 'warn' : 'ok', now = Date.now();
  var star = st.stars || 0, next = st.hours_next;
  var html = '<div class="mn-state">' +
    '<div class="mn-st ' + wk + '"><em>оборудование</em><b>' + Math.max(0, Math.round(100 - w)) + ' %</b><span>' + (w > 0.5 ? 'износ ' + mnNum(w, 0) + ' % · ×' + mnNum(1 - w * 0.004, 2) : 'в порядке') + '</span></div>' +
    '<div class="mn-st"><em>опыт бригады</em><b class="mn-stars">' + mnStarsHtml(star) + '</b><span>' + (star ? '+' + star * 3 + ' % · ' : '') + (next ? st.hours + '/' + next + ' ч' : 'предел') + '</span></div>';
  if (st.vein_until) html += '<div class="mn-st gold"><em>богатая жила</em><b>+40 %</b><span>ещё ' + mnLeft(new Date(st.vein_until).getTime() - now) + '</span></div>';
  if (st.prep) html += '<div class="mn-st gold"><em>вскрыша</em><b>+' + st.prep + ' %</b><span>к следующей добыче</span></div>';
  html += '</div>';
  if (st.mult && Math.abs(st.mult - 1) > 0.005) html += '<div class="mn-eff ' + (st.mult > 1 ? 'up' : 'down') + '">Участок к выработке: ×' + mnNum(st.mult, 2) + '</div>';
  return html;
}

// Бригадир и техники
function mnSpecRow(kind, st) {
  var n = kind === 'f' ? st.foremen : st.techs, max = kind === 'f' ? st.foremen_max : st.techs_max, price = kind === 'f' ? st.cfg.hire_f : st.cfg.hire_t;
  var name = kind === 'f' ? 'Бригадир' : 'Техники';
  var what = kind === 'f' ? '+10 % к выработке смены, в аврале травм и поломок вдвое меньше'
                          : 'чинят оборудование: каждый — 1 % износа в час; на обслуживании ремонт быстрее на 50 %';
  return '<div class="mn-crew ' + kind + '">' +
    '<div class="mn-crew-ico">' + (kind === 'f' ? '<svg viewBox="0 0 20 20"><path d="M5 8a5 5 0 0 1 10 0z"/><path d="M4 8h12"/><path d="M7 12h6M7 15h4"/></svg>'
                                                : '<svg viewBox="0 0 20 20"><path d="M12.5 3.5a3.5 3.5 0 0 0-3.9 4.6L3.5 13.2l3.3 3.3 5.1-5.1a3.5 3.5 0 0 0 4.6-3.9l-2.2 2.2-2.3-.6-.6-2.3z"/></svg>') + '</div>' +
    '<div class="mn-crew-info"><b>' + name + ' · ' + n + '<small> из ' + max + '</small></b><em>' + what + '</em></div>' +
    '<div class="mn-crew-btns">' +
      '<button type="button" class="mn-btn" data-mn="hire" data-k="' + kind + '"' + (n < max ? '' : ' disabled') + '>+ Нанять<small>' + price + ' кр</small></button>' +
      '<button type="button" class="mn-btn ghost" data-mn="fire" data-k="' + kind + '"' + (n > 0 ? '' : ' disabled') + '>− Уволить</button>' +
    '</div></div>';
}

// Улучшение мест работы и помощь районов поселения
function mnUpgradeHtml(st) {
  var u = st.upgrade, d = st.districts || {}, html = '<div class="mn-sec">Участок · мест работы ' + st.places + '</div>';
  if (u) {
    var okC = (st.credits || 0) >= u.credits, okD = st.planet.durasteel >= u.durasteel, okE = st.planet.electronics >= u.electronics;
    html += '<div class="mn-up">' +
      '<div class="mn-up-top"><b>' + st.places + ' → ' + u.places + ' мест</b><span>барак до ' + u.places * 2 + ' рабочих</span></div>' +
      '<div class="mn-up-cost"><span class="' + (okC ? '' : 'bad') + '">' + u.credits + ' кр</span>' +
        '<span class="' + (okD ? '' : 'bad') + '">дюрасталь ' + u.durasteel + ' <i>(' + st.planet.durasteel + ')</i></span>' +
        (u.electronics ? '<span class="' + (okE ? '' : 'bad') + '">электроника ' + u.electronics + ' <i>(' + st.planet.electronics + ')</i></span>' : '') + '</div>' +
      '<button type="button" class="mn-go" data-mn="upgrade"' + (okC && okD && okE && !st.capture ? '' : ' disabled') + '>Улучшить участок</button>' +
    '</div>';
  } else html += '<div class="mn-note">Участок наибольший — 18 мест работы.</div>';
  var tips = [];
  tips.push((d.hospital ? '✓' : '·') + ' Госпиталь — травмы людей вдвое короче');
  tips.push((d.workshops ? '✓' : '·') + ' Мастерские — поломки дроидов вдвое короче, износ ×0,7');
  tips.push((d.market ? '✓' : '·') + ' Рынок — найм на 20 % дешевле');
  tips.push((d.warehouses ? '✓' : '·') + ' Склады — склад участка +300');
  html += '<div class="mn-districts">' + tips.map(function(t) { return '<span class="' + (t.charAt(0) === '✓' ? 'on' : '') + '">' + t + '</span>'; }).join('') + '</div>';
  return html;
}

function mnCrewRow(kind, st) {
  var n = kind === 'h' ? st.humans : st.droids, free = kind === 'h' ? st.avail_h : st.avail_d;
  var rest = kind === 'h' ? st.rest_h : st.rest_d, hurt = 0;
  (st.hurt || []).forEach(function(x) { if (x.kind === kind) hurt += x.n; });
  var busy = st.run ? (kind === 'h' ? st.run.humans : st.run.droids) : 0;
  var parts = [];
  if (busy) parts.push('на смене ' + busy);
  if (rest && free) parts.push('<span class="mn-rest" data-until="' + new Date(rest).getTime() + '">' + (kind === 'h' ? 'отдыхают' : 'на обслуживании') + '</span>');
  else if (free) parts.push('свободны ' + free);
  if (hurt) parts.push('<span class="bad">' + (kind === 'h' ? 'травмы' : 'поломки') + ' ' + hurt + '</span>');
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
    '<div class="mn-run-top"><span>' + (r.task && r.task !== 'extract' ? MN_TASK[r.task] + ' · ' : '') + r.len + ' ч · ' + MN_PACE[r.pace].toLowerCase() + (r.auto ? ' · автосмена' : '') + '</span><b id="mn-run-left"></b></div>' +
    '<div class="mn-run-crew">' + crew + (r.rate > 0 ? ' · ' + mnNum(r.rate, 1) + ' в час' : '') + (r.mult && Math.abs(r.mult - 1) > 0.005 ? ' · участок ×' + mnNum(r.mult, 2) : '') + '</div>' +
    '<div class="mn-bar"><i id="mn-run-bar"></i></div>' +
    mnRunGot(r, col) +
    warn +
    '<button type="button" class="mn-go danger" data-mn="stop">Закончить смену сейчас</button>' +
    '<div class="mn-note">' + ({
      prep: 'Вскрыша засчитается, если отработать хотя бы половину смены: следующая добыча +25 %.',
      survey: 'Итог разведки — по концу смены. Закончить раньше можно, но шанс будет меньше: он растёт с отработанными часами.',
      maint: 'Ремонт засчитается по концу смены. Закончить раньше можно — починят за отработанные часы.'
    }[r.task] || 'Добытое ляжет на склад по концу смены. Закончить раньше можно — придёт то, что успели.') + '</div>' +
  '</div>';
}

// Что даст идущая смена: добыча и вскрыша — счётчик, разведка — шанс, обслуживание — ремонт
function mnRunGot(r, col) {
  var st = mnState, n = (r.humans || 0) + (r.droids || 0);
  if (r.task === 'survey')
    return '<div class="mn-run-got"><span>Шанс найти жилу</span><b style="color:#8fd3ff">' + Math.round(Math.min(0.6, 0.12 * r.len * n / 6) * 100) + ' %</b><em>к концу смены</em></div>';
  if (r.task === 'maint')
    return '<div class="mn-run-got"><span>Снимет износа</span><b style="color:#8fd3ff">−' + Math.round(Math.min(st.wear, n * r.len * 2 * (1 + 0.5 * Math.min(st.techs, st.techs_max)))) + ' %</b><em>сейчас ' + mnNum(st.wear, 0) + ' %</em></div>';
  return '<div class="mn-run-got"><span>Добыто за смену</span><b id="mn-run-got" style="color:' + col + '"></b><em id="mn-run-of"></em></div>';
}

function mnFormHtml() {
  var st = mnState, f = mnForm, c = st.cfg, html = '';
  if (st.res_k <= 0) return '<div class="mn-empty bad">На планете нет залежи этого сырья — участок стоит</div>';
  var mh = st.rest_h ? 0 : st.avail_h, md = st.rest_d ? 0 : st.avail_d;
  html += '<div class="mn-form">';
  if (f.task === 'maint' && !(st.wear > 0)) f.task = 'extract';
  html += '<div class="mn-lab">Задача</div><div class="mn-chips tasks">' + ['extract', 'prep', 'survey', 'maint'].map(function(t) {
    var off = t === 'maint' && !(st.wear > 0);
    return '<button type="button" class="mn-chip' + (f.task === t ? ' on' : '') + '" data-mn="task" data-v="' + t + '"' + (off ? ' disabled' : '') + '>' + MN_TASK[t] + '<small>' + MN_TASK_SUB[t] + '</small></button>';
  }).join('') + '</div><div class="mn-hint">' + MN_TASK_HINT[f.task] + '</div>';
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
  var fedH = st.planet.food >= f.h, fedD = st.planet.ore >= f.d, rate = mnRate(f.h, f.d, f.len, f.pace, fedH, fedD, f.task);
  var restH = f.h ? mnRestMin('h', f.len, f.pace) : 0, restD = f.d ? mnRestMin('d', f.len, f.pace) : 0;
  var wear = mnWear(f.h, f.d, f.len, f.pace, f.task), main;
  if (f.task === 'survey') main = '<b>' + Math.round(Math.min(0.6, 0.12 * f.len * (f.h + f.d) / 6) * 100) + ' %</b><span>шанс найти богатую жилу</span>';
  else if (f.task === 'maint') main = '<b>−' + Math.round(Math.min(st.wear, -wear)) + ' %</b><span>износа за смену (сейчас ' + mnNum(st.wear, 0) + ' %)</span>';
  else main = '<b>≈ ' + Math.round(rate * f.len) + '</b><span>' + mnEsc((st.res || {}).name || '').toLowerCase() + ' за смену · ' + mnNum(rate, 1) + ' в час' + (f.task === 'prep' ? ' · потом добыча +25 %' : '') + '</span>';
  html += '<div class="mn-fc">' +
    '<div class="mn-fc-main">' + main + '</div>' +
    '<div class="mn-fc-row">' +
      (f.h ? '<span>паёк: ' + f.h + ' еды' + (fedH ? '' : ' <i class="bad">не хватает</i>') + '</span>' : '') +
      (f.d ? '<span>обслуживание: ' + f.d + ' руды' + (fedD ? '' : ' <i class="bad">не хватает</i>') + '</span>' : '') +
      ((f.h || f.d) ? '<span>отдых после: ' + [restH ? 'люди ' + mnRestText(restH) : '', restD ? 'дроиды ' + mnRestText(restD) : ''].filter(Boolean).join(', ') + '</span>' : '') +
      ((f.h || f.d) && f.task !== 'maint' ? '<span>износ оборудования: +' + mnNum(wear, 1) + ' %</span>' : '') +
    '</div></div>';
  var can = (f.h + f.d) > 0 && !st.capture;
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
    var got = r.accrued + r.rate * Math.max(0, Math.min(now, t1) - mnAt) / 3600000;
    var k = Math.max(0, Math.min(1, (now - t0) / (t1 - t0)));
    var el = document.getElementById('mn-run-bar'); if (el) el.style.width = (k * 100).toFixed(1) + '%';
    el = document.getElementById('mn-run-got'); if (el) el.textContent = '+' + Math.floor(got);
    el = document.getElementById('mn-run-of'); if (el) el.textContent = 'из ≈ ' + Math.round(r.accrued + r.rate * Math.max(0, t1 - mnAt) / 3600000);
    el = document.getElementById('mn-run-left'); if (el) el.textContent = now < t1 ? 'ещё ' + mnLeft(t1 - now) : 'заканчивается…';
    if (now > t1 + 70000 && !mnBusy) { mnAt = now; mnLoad(); }   // тик сервера раз в минуту закрыл смену
  }
  var rs = document.querySelectorAll('#mn-body .mn-rest[data-until]'), due = false;
  for (var i = 0; i < rs.length; i++) {
    var u = +rs[i].getAttribute('data-until');
    if (u > now) rs[i].textContent = (rs[i].closest('.mn-step') ? 'отдых ' : (rs[i].textContent.indexOf('обслуж') >= 0 ? 'на обслуживании ' : 'отдыхают ')) + mnLeft(u - now);
    else due = true;
  }
  if (due && !mnBusy && now - mnAt > 3000) mnLoad();
}

// Строка поверх сцены: что сейчас на участке
function mnHud(now) {
  var el = document.getElementById('mn-hud'), st = mnState; if (!el || !st) return;
  var html;
  if (st.run) {
    var r = st.run, t1 = new Date(r.ends_at).getTime(), got = r.accrued + r.rate * Math.max(0, Math.min(now, t1) - mnAt) / 3600000;
    var tn = r.task && r.task !== 'extract' ? MN_TASK[r.task] : 'Смена';
    html = '<i class="on"></i>' + tn + ' · ' + (now < t1 ? 'ещё ' + mnLeft(t1 - now) : 'заканчивается') + (r.rate > 0 ? ' · <b style="color:' + ((st.res || {}).color || '#cfd8dc') + '">+' + Math.floor(got) + '</b>' : '');
  } else if (st.res_k <= 0) html = '<i></i>Залежи нет';
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
    if (typeof gameConfirm === 'function') gameConfirm({ tone: 'build', kicker: 'Улучшение участка', title: 'Мест работы: ' + st.places + ' → ' + u.places,
      rows: [{ label: 'Спишется', items: items }], note: 'Барак вырастет вместе с участком: до ' + u.places * 2 + ' рабочих. Сырьё — со склада планеты.', ok: 'Улучшить' }, up);
    else up();
  }
  else if (act === 'stop') {
    var go = function() { mnCall('mine_shift_stop', {}); };
    if (typeof gameConfirm === 'function') gameConfirm({ tone: 'danger', kicker: 'Смена', title: 'Закончить сейчас?', note: 'Придёт то, что успели добыть, бригада уйдёт на отдых.', ok: 'Закончить', cancel: 'Пусть работают' }, go);
    else if (confirm('Закончить смену сейчас?')) go();
  }
  else if (act === 'auto-toggle') mnCall('mine_auto_set', { p_on: !st.auto.on, p_len: st.auto.len, p_pace: st.auto.pace });
  else if (act === 'auto-len') mnCall('mine_auto_set', { p_on: st.auto.on, p_len: +v, p_pace: st.auto.pace });
  else if (act === 'auto-pace') mnCall('mine_auto_set', { p_on: st.auto.on, p_len: st.auto.len, p_pace: v });
  else if (act === 'hire') {
    var price = { h: st.cfg.hire_h, d: st.cfg.hire_d, f: st.cfg.hire_f, t: st.cfg.hire_t }[k];
    var hire = function() { mnCall('mine_hire', { p_kind: k, p_n: 1 }); };
    var HI = {
      h: ['Рабочий', 'Паёк — 1 еда за смену', 'Люди выгоднее на коротких сменах, но после смены дольше отдыхают.'],
      d: ['Дроид-рабочий', 'Обслуживание — 1 руда за смену', 'Дроиды ровно держат долгие смены и отдыхают меньше.'],
      f: ['Бригадир', 'Ведёт каждую смену участка', '+10 % к выработке; в аврале травм и поломок вдвое меньше.'],
      t: ['Техник', 'Чинит оборудование между сменами', 'Каждый техник снимает 1 % износа в час, на обслуживании — быстрее.']
    }[k];
    if (typeof gameConfirm === 'function') gameConfirm({ tone: 'build', kicker: 'Найм на участок', title: HI[0], sub: HI[1],
      rows: [{ label: 'Спишется', items: [{ text: price + ' кр.', kind: 'credits' }] }], note: HI[2], ok: 'Нанять' }, hire);
    else hire();
  }
  else if (act === 'fire') {
    var fire = function() { mnCall('mine_fire', { p_kind: k, p_n: 1 }); };
    if (typeof gameConfirm === 'function') gameConfirm({ tone: 'danger', kicker: 'Бригада', title: { h: 'Уволить рабочего?', d: 'Списать дроида?', f: 'Уволить бригадира?', t: 'Уволить техника?' }[k], note: 'Деньги за найм не вернутся.', ok: k === 'd' ? 'Списать' : 'Уволить' }, fire);
    else if (confirm('Уволить?')) fire();
  }
}
