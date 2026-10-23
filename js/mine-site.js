// Участок добычи (шаг 1 плана claude/mining-plan.md): бригада людей и дроидов, смены, автосмена, найм.
// Выработку считает база (sql/mine_sites.sql); окно показывает её же числа и между опросами
// досчитывает добытое за смену по той же ставке. Префикс классов и функций — mn-/mn*.
// Открывается тапом по готовой добывающей постройке (js/ground-battle.js → openMineSite).

var mnState = null;        // последнее состояние с сервера
var mnBuilding = null;     // строка постройки
var mnAt = 0;              // когда пришло состояние (мс, часы клиента)
var mnPoll = null, mnTick = null, mnBusy = false, mnSeq = 0;
var mnForm = { len: 8, pace: 'normal', h: 0, d: 0, touched: false };
var MN_PACE = { careful: 'Бережно', normal: 'Обычно', rush: 'Аврал' };
var MN_PACE_HINT = {
  careful: 'медленнее, зато отдых вдвое короче',
  normal: 'обычная выработка и отдых',
  rush: 'быстрее, но отдых дольше, а часть бригады может выбыть'
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
      '<div id="mn-body"></div>' +
    '</div>';
  document.body.appendChild(p);
  p.addEventListener('click', function(e) { if (e.target === p) closeMineSite(); });
  document.getElementById('mn-close').addEventListener('click', closeMineSite);
  document.getElementById('mn-body').addEventListener('click', mnClick);
  return p;
}

function openMineSite(building) {
  mnBuilding = building;
  mnState = null;
  mnForm = { len: 8, pace: 'normal', h: 0, d: 0, touched: false };
  var p = mnPanel();
  var t = building.building_types || {};
  document.getElementById('mn-title').textContent = MN_KIND[t.code] || 'Участок';
  document.getElementById('mn-sub').textContent = t.name || '';
  document.getElementById('mn-body').innerHTML = '<div class="mn-empty">Загрузка…</div>';
  p.style.display = 'flex';
  mnLoad();
  if (mnPoll) clearInterval(mnPoll);
  mnPoll = setInterval(function() { if (!document.hidden) mnLoad(); }, 15000);
  if (mnTick) clearInterval(mnTick);
  mnTick = setInterval(mnLive, 1000);
}

function closeMineSite() {
  var p = document.getElementById('mn-panel');
  if (p) p.style.display = 'none';
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

// Выработка в час по тем же правилам, что mine_rate_h в базе, с эффектами планеты
function mnRate(h, d, len, pace, fedH, fedD) {
  var st = mnState, c = st.cfg;
  var k = c.rate * st.res_k * (c.pace[pace] || 1) *
          (h * (c.k_h[len] || 1) * (fedH ? 1 : c.hungry) + d * (c.k_d[len] || 1) * (fedD ? 1 : c.hungry));
  return k * Math.max(0, 100 + (st.eff || 0)) / 100;
}
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

  // --- последние смены
  if (st.last && st.last.length) {
    html += '<div class="mn-sec">Последние смены</div><div class="mn-log">';
    st.last.forEach(function(x) {
      var when = new Date(x.ended_at || x.started_at), hm = when.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
      var crew = [x.humans ? mnWorkers(x.humans, 'h') : '', x.droids ? mnWorkers(x.droids, 'd') : ''].filter(Boolean).join(' + ');
      var tag = x.status === 'stopped' ? 'остановлена' : x.status === 'lost' ? 'сорвана' : x.auto ? 'авто' : '';
      html += '<div class="mn-log-row"><span class="t">' + hm + '</span><span class="w">' + x.len + ' ч · ' + MN_PACE[x.pace].toLowerCase() + ' · ' + crew + (tag ? ' · <i>' + tag + '</i>' : '') + (x.fed ? '' : ' · <i class="bad">без пайка</i>') + '</span>' +
        '<b style="color:' + col + '">+' + x.got + '</b>' + (x.lost ? '<em class="bad">−' + x.lost + '</em>' : '') + '</div>';
    });
    html += '</div>';
  }
  var lostNow = 0; (st.last || []).forEach(function(x) { lostNow += x.lost || 0; });
  if (lostNow) html += '<div class="mn-note warn">Склад участка переполнялся: потеряно ' + lostNow + '. Освободи склад планеты или подними его предел — тогда добытое переходит туда само.</div>';
  html += '<div class="mn-err" id="mn-err"></div>';
  body.innerHTML = html;
  mnLive();
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
    '<div class="mn-run-top"><span>' + r.len + ' ч · ' + MN_PACE[r.pace].toLowerCase() + (r.auto ? ' · автосмена' : '') + '</span><b id="mn-run-left"></b></div>' +
    '<div class="mn-run-crew">' + crew + ' · ' + mnNum(r.rate, 1) + ' в час</div>' +
    '<div class="mn-bar"><i id="mn-run-bar"></i></div>' +
    '<div class="mn-run-got"><span>Добыто за смену</span><b id="mn-run-got" style="color:' + col + '"></b><em id="mn-run-of"></em></div>' +
    warn +
    '<button type="button" class="mn-go danger" data-mn="stop">Закончить смену сейчас</button>' +
    '<div class="mn-note">Добытое ляжет на склад по концу смены. Закончить раньше можно — придёт то, что успели.</div>' +
  '</div>';
}

function mnFormHtml() {
  var st = mnState, f = mnForm, c = st.cfg, html = '';
  if (st.res_k <= 0) return '<div class="mn-empty bad">На планете нет залежи этого сырья — участок стоит</div>';
  var mh = st.rest_h ? 0 : st.avail_h, md = st.rest_d ? 0 : st.avail_d;
  html += '<div class="mn-form">';
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
  var fedH = st.planet.food >= f.h, fedD = st.planet.ore >= f.d, rate = mnRate(f.h, f.d, f.len, f.pace, fedH, fedD);
  var restH = f.h ? mnRestMin('h', f.len, f.pace) : 0, restD = f.d ? mnRestMin('d', f.len, f.pace) : 0;
  html += '<div class="mn-fc">' +
    '<div class="mn-fc-main"><b>≈ ' + Math.round(rate * f.len) + '</b><span>' + mnEsc((st.res || {}).name || '').toLowerCase() + ' за смену · ' + mnNum(rate, 1) + ' в час</span></div>' +
    '<div class="mn-fc-row">' +
      (f.h ? '<span>паёк: ' + f.h + ' еды' + (fedH ? '' : ' <i class="bad">не хватает</i>') + '</span>' : '') +
      (f.d ? '<span>обслуживание: ' + f.d + ' руды' + (fedD ? '' : ' <i class="bad">не хватает</i>') + '</span>' : '') +
      ((f.h || f.d) ? '<span>отдых после: ' + [restH ? 'люди ' + mnRestText(restH) : '', restD ? 'дроиды ' + mnRestText(restD) : ''].filter(Boolean).join(', ') + '</span>' : '') +
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
    if (fn === 'mine_hire' && typeof refreshCreditsSoon === 'function') refreshCreditsSoon();
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
  else if (act === 'start') mnCall('mine_shift_start', { p_len: mnForm.len, p_pace: mnForm.pace, p_humans: mnForm.h, p_droids: mnForm.d });
  else if (act === 'stop') {
    var go = function() { mnCall('mine_shift_stop', {}); };
    if (typeof gameConfirm === 'function') gameConfirm({ tone: 'danger', kicker: 'Смена', title: 'Закончить сейчас?', note: 'Придёт то, что успели добыть, бригада уйдёт на отдых.', ok: 'Закончить', cancel: 'Пусть работают' }, go);
    else if (confirm('Закончить смену сейчас?')) go();
  }
  else if (act === 'auto-toggle') mnCall('mine_auto_set', { p_on: !st.auto.on, p_len: st.auto.len, p_pace: st.auto.pace });
  else if (act === 'auto-len') mnCall('mine_auto_set', { p_on: st.auto.on, p_len: +v, p_pace: st.auto.pace });
  else if (act === 'auto-pace') mnCall('mine_auto_set', { p_on: st.auto.on, p_len: st.auto.len, p_pace: v });
  else if (act === 'hire') {
    var price = k === 'h' ? st.cfg.hire_h : st.cfg.hire_d;
    var hire = function() { mnCall('mine_hire', { p_kind: k, p_n: 1 }); };
    if (typeof gameConfirm === 'function') gameConfirm({ tone: 'build', kicker: 'Найм на участок', title: k === 'h' ? 'Рабочий' : 'Дроид-рабочий',
      sub: k === 'h' ? 'Паёк — 1 еда за смену' : 'Обслуживание — 1 руда за смену',
      rows: [{ label: 'Спишется', items: [{ text: price + ' кр.', kind: 'credits' }] }],
      note: k === 'h' ? 'Люди выгоднее на коротких сменах, но после смены дольше отдыхают.' : 'Дроиды ровно держат долгие смены и отдыхают меньше.', ok: 'Нанять' }, hire);
    else hire();
  }
  else if (act === 'fire') {
    var fire = function() { mnCall('mine_fire', { p_kind: k, p_n: 1 }); };
    if (typeof gameConfirm === 'function') gameConfirm({ tone: 'danger', kicker: 'Бригада', title: k === 'h' ? 'Уволить рабочего?' : 'Списать дроида?', note: 'Деньги за найм не вернутся.', ok: k === 'h' ? 'Уволить' : 'Списать' }, fire);
    else if (confirm('Уволить?')) fire();
  }
}
