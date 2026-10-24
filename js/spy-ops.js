// Тайные операции (шаг 4а плана claude/sabotage-plan.md): диверсионные группы штаба и операции против
// чужих участков и цехов. Всё решает база (sql/mine_sabotage.sql: spy_state, spy_train, spy_targets,
// spy_launch, spy_tick); окно показывает её числа и между опросами ведёт таймеры по серверному времени.
// Сверху — карта операций (js/spy-map.js): штабы, планеты в двух гиперпутях, группы в пути. Префикс — so-/so*.
// Вход — карточка «Тайные операции» в окне штаба (rep_hq) или центра управления (cis_control).

var soState = null;       // последнее состояние с сервера
var soSkew = 0;           // часы сервера − часы клиента, мс
var soBuilding = null;    // штаб, из которого открыли
var soPoll = null, soTick = null, soBusy = false, soSeq = 0;
var soOpenAt = 0, soDownBack = false;
var soView = 'home';      // home | target | op
var soPick = { group: null, targets: null, sys: null, site: null, kind: null, hq: null };

var SO_KINDS = [
  { id: 'blast', name: 'Саботаж оборудования',
    what: 'Группа выводит из строя установку у одного места работы. Идущая смена обрывается, износ оборудования +30 %.',
    pain: 'выработка −12 %, пока техники не починят — около суток' },
  { id: 'strike', name: 'Подстрекательство',
    what: 'Агитаторы у барака: люди бастуют 6 ч, напряжение на планете +4 на сутки.',
    pain: 'если в бригаде одни дроиды — впустую' },
  { id: 'virus', name: 'Вирус в дроидах',
    what: 'Сбой в сети участка: половина дроидов встаёт на 6 ч.',
    pain: 'людей не касается; «Мастерские» вдвое сокращают сбой' },
  { id: 'poison', name: 'Срыв снабжения',
    what: 'Группа срывает снабжение: четверть еды на складе планеты (до 40) пропадает, ближайшая смена людей выходит без пайка.',
    pain: 'бьёт по всей планете, а не только по участку' },
  { id: 'theft', name: 'Кража со склада',
    what: 'Группа выносит ресурс участка со склада планеты — 30 %, до 120. Унесённое ляжет на склад твоего штаба.',
    pain: 'единственная операция с добычей' }
];

// Значки операций — простые линии в стиле значков окон построек
var SO_ICON = {
  blast: '<svg viewBox="0 0 24 24"><circle cx="10" cy="13" r="3"/><path d="M10 6v2M10 18v2M3 13h2M15 13h2M5 8l1.4 1.4M13.6 16.6L15 18M5 18l1.4-1.4"/><path d="M18 3l-3 5h3l-2.5 5"/></svg>',
  strike: '<svg viewBox="0 0 24 24"><path d="M4 10v4h3l7 4V6L7 10z"/><path d="M17 9.5a3.5 3.5 0 0 1 0 5M19.5 7.5a6.5 6.5 0 0 1 0 9"/></svg>',
  virus: '<svg viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="1.5"/><path d="M10 4v3M14 4v3M10 17v3M14 17v3M4 10h3M4 14h3M17 10h3M17 14h3"/><path d="M10 10l4 4M14 10l-4 4"/></svg>',
  poison: '<svg viewBox="0 0 24 24"><path d="M4 8l8-4 8 4v8l-8 4-8-4z"/><path d="M4 8l8 4 8-4M12 12v8"/><path d="M15 14.5l3 1.5M18 14.5l-3 1.5"/></svg>',
  theft: '<svg viewBox="0 0 24 24"><path d="M4 9l8-4 8 4v9l-8 4-8-4z"/><path d="M4 9l8 4 8-4M12 13v9"/><path d="M15.5 3.5h3v3M18.5 3.5l-4 4"/></svg>'
};
// Портрет группы: Республика — шлем с узким визором и антенной; КНС — угловатая голова дроида с полосой сенсора
var SO_FACE = {
  republic: '<svg viewBox="0 0 32 32"><path d="M8 17c0-6 3.6-10 8-10s8 4 8 10v4l-3 3H11l-3-3z" fill="#2e3742"/><path d="M8 17c0-6 3.6-10 8-10s8 4 8 10" fill="none" stroke="#9aa6b2" stroke-width="1.4"/><rect x="10" y="15" width="12" height="2.6" rx="1.1" fill="#d9a940"/><path d="M22 9l3-4" stroke="#9aa6b2" stroke-width="1.2"/><path d="M12 21h8" stroke="#55606c" stroke-width="1.2"/></svg>',
  cis: '<svg viewBox="0 0 32 32"><path d="M9 10l5-3h4l5 3 1 9-3 6H11l-3-6z" fill="#262a30"/><path d="M9 10l5-3h4l5 3 1 9-3 6H11l-3-6z" fill="none" stroke="#7d848c" stroke-width="1.3"/><rect x="10.5" y="14" width="11" height="2" rx="1" fill="#ff6a3c"/><path d="M13 21h6M16 4v3" stroke="#55606c" stroke-width="1.2"/></svg>'
};

function soEsc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function(c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
function soNow() { return Date.now() + soSkew; }
function soT(iso) { return iso ? new Date(iso).getTime() : 0; }
function soLeft(ms) {
  var s = Math.max(0, Math.round(ms / 1000));
  if (s >= 3600) { var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return h + ' ч' + (m ? ' ' + m + ' мин' : ''); }
  if (s >= 60) return Math.floor(s / 60) + ' мин';
  return s + ' с';
}
function soMin(m) { return m >= 60 ? (m % 60 ? Math.floor(m / 60) + ' ч ' + (m % 60) + ' мин' : (m / 60) + ' ч') : m + ' мин'; }
function soJumps(n) { return n + (n === 1 ? ' гиперпуть' : ' гиперпути'); }
function soFace() { return SO_FACE[soState && soState.faction === 'cis' ? 'cis' : 'republic']; }
function soGroupById(id) { var a = (soState && soState.groups) || []; for (var i = 0; i < a.length; i++) if (a[i].id === id) return a[i]; return null; }
function soKind(id) { for (var i = 0; i < SO_KINDS.length; i++) if (SO_KINDS[i].id === id) return SO_KINDS[i]; return null; }

// ---------------------------------------------------------------- карточка в окне штаба
function soBox(building, box) {
  box.innerHTML = '<div class="so-box-head">Тайные операции</div><div class="so-box-empty">Загрузка…</div>';
  supabase.rpc('spy_state').then(function(r) {
    if (r.error || !r.data) { box.innerHTML = '<div class="so-box-head">Тайные операции</div><div class="so-box-empty">Не удалось прочитать</div>'; return; }
    var st = r.data, now = Date.parse(st.now);
    var busy = st.groups.filter(function(g) { return g.status === 'mission'; }).length;
    var ready = st.groups.filter(function(g) { return g.status === 'home' && soT(g.ready_at) <= now; }).length;
    var line = st.groups.length
      ? 'Групп ' + st.groups.length + ' из ' + st.max + (busy ? ' · в деле ' + busy : '') + (ready ? ' · готовы ' + ready : '')
      : 'Групп пока нет: штаб готовит диверсантов для операций против чужих участков и цехов';
    box.innerHTML = '<div class="so-box-head">Тайные операции</div>' +
      '<div class="so-box-row">' +
        '<div class="so-box-face">' + SO_FACE[st.faction === 'cis' ? 'cis' : 'republic'] + '</div>' +
        '<div class="so-box-info">' + soEsc(line) + '</div>' +
      '</div>' +
      '<button type="button" class="so-box-go">Открыть операции</button>';
    box.querySelector('.so-box-go').addEventListener('click', function() { openSpyOps(building); });
  });
}

// ---------------------------------------------------------------- окно
function soPanel() {
  var p = document.getElementById('so-panel');
  if (p) return p;
  p = document.createElement('div');
  p.id = 'so-panel';
  p.style.display = 'none';
  p.innerHTML =
    '<div id="so-box">' +
      '<div id="so-head"><div class="so-ttl"><b>Тайные операции</b><span id="so-sub"></span></div>' +
        '<button id="so-close" type="button" aria-label="Закрыть">✕</button></div>' +
      '<div id="so-stage"><div class="so-hud" id="so-hud"></div></div>' +
      '<div id="so-body"></div>' +
    '</div>';
  document.body.appendChild(p);
  // тап, которым открыли окно, браузер досылает щелчком по фону — закрываем только касание, начатое на фоне
  p.addEventListener('pointerdown', function(e) { soDownBack = e.target === p; });
  p.addEventListener('click', function(e) { if (e.target === p && soDownBack && Date.now() - soOpenAt > 400) closeSpyOps(); soDownBack = false; });
  document.getElementById('so-close').addEventListener('click', closeSpyOps);
  document.getElementById('so-body').addEventListener('click', soClick);
  return p;
}

function openSpyOps(building) {
  soBuilding = building || null; soOpenAt = Date.now(); soDownBack = false;
  soView = 'home'; soPick = { group: null, targets: null, sys: null, site: null, kind: null, hq: null };
  var p = soPanel();
  document.getElementById('so-body').innerHTML = '<div class="so-empty">Загрузка…</div>';
  document.getElementById('so-sub').textContent = '';
  document.getElementById('so-hud').textContent = '';
  p.style.display = 'flex';
  document.body.classList.add('so-open');
  if (window.SOMap) { try { SOMap.mount(document.getElementById('so-stage'), soMapPick); } catch (e) { if (window.errReport) errReport(e, 'spy.map'); } }
  soLoad();
  if (soPoll) clearInterval(soPoll);
  soPoll = setInterval(function() { if (!document.hidden && soView === 'home' && !soBusy) soLoad(); }, 20000);
  if (soTick) clearInterval(soTick);
  soTick = setInterval(soLive, 1000);
}

function closeSpyOps() {
  var p = document.getElementById('so-panel');
  if (p) p.style.display = 'none';
  document.body.classList.remove('so-open');
  if (soPoll) { clearInterval(soPoll); soPoll = null; }
  if (soTick) { clearInterval(soTick); soTick = null; }
  if (window.SOMap) SOMap.stop();
  soState = null; soSeq++;
}

function soLoad() {
  var seq = ++soSeq;
  supabase.rpc('spy_state').then(function(r) {
    if (seq !== soSeq) return;
    if (r.error) { document.getElementById('so-body').innerHTML = '<div class="so-empty bad">' + soEsc(r.error.message) + '</div>'; return; }
    soSet(r.data);
  }, function() {
    if (seq === soSeq && !soState) document.getElementById('so-body').innerHTML = '<div class="so-empty bad">Нет связи с сервером</div>';
  });
}

function soSet(st) {
  soState = st; soSkew = Date.parse(st.now) - Date.now();
  var hq = (soBuilding && st.hqs.filter(function(h) { return h.id === soBuilding.id; })[0]) || st.hqs[0];
  document.getElementById('so-sub').textContent = hq ? (st.faction === 'cis' ? 'Центр управления' : 'Оперативный штаб') + ' · ' + hq.system_name : 'штаба нет';
  soMapSync();
  soRender();
}

// карта знает выбор игрока: какие планеты подсветить и куда нацелен прицел
function soMapSync() {
  if (!window.SOMap || !soState) return;
  try {
    SOMap.set(soState, soSkew, {
      targets: soView !== 'home' && soPick.targets ? soPick.targets.map(function(p) { return p.system_id; }) : null,
      pick: soView !== 'home' ? soPick.sys : null,
      from: soView !== 'home' && soPick.group ? (soGroupById(soPick.group) || {}).base_system : null
    });
  } catch (e) { if (window.errReport) errReport(e, 'spy.map'); }
}
function soMapPick(sys) {
  if (soView !== 'target' || !soPick.targets) return;
  soPick.sys = sys; soMapSync(); soRender();
  var el = document.getElementById('so-p-' + sys); if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function soErr(msg) { var e = document.getElementById('so-err'); if (e) { e.textContent = msg || ''; e.style.display = msg ? 'block' : 'none'; } }

function soRender() {
  var body = document.getElementById('so-body'); if (!body || !soState) return;
  body.innerHTML = soView === 'target' ? soTargetHtml() : soView === 'op' ? soOpHtml() : soHomeHtml();
  soLive();
}

// ---------------------------------------------------------------- главный вид: группы, новая группа, журнал
// Фаза группы по серверному времени: перелёт → подход → действие → возвращение; дома — подготовка или отдых
function soGroupPhase(g, now) {
  var o = g.op, c = soState.cfg;
  if (g.status === 'mission' && o) {
    var t0 = soT(o.launched_at), ta = soT(o.approach_at), tc = soT(o.act_at), tb = soT(o.back_at), td = o.acted_at ? soT(o.acted_at) : 0;
    if (now < ta) return { cls: 'go', text: 'перелёт к цели · ' + soEsc(o.target_name), a: t0, b: ta, step: 0 };
    if (!td && now < tc) return { cls: 'go', text: 'подход: ' + soEsc(o.building_name || 'цель') + ' · ' + soEsc(o.target_name), a: ta, b: tc, step: 1 };
    if (!td) return { cls: 'go', text: 'действует…', a: 0, b: 0, step: 2 };
    return { cls: o.result === 'ok' ? 'ok' : 'dim', text: (o.result === 'ok' ? 'успех · ' : 'цели больше нет · ') + 'возвращается', a: td, b: tb, step: 3 };
  }
  var ready = soT(g.ready_at);
  if (ready > now) {
    var training = !g.wins && ready - soT(g.created_at) <= (c.train_min * 60 + 90) * 1000;
    return { cls: 'wait', text: training ? 'готовится' : 'отдыхает после операции', a: training ? soT(g.created_at) : ready - c.rest_h * 3600000, b: ready, step: -1 };
  }
  if (!g.hq_ok) return { cls: 'bad', text: 'штаб группы потерян', a: 0, b: 0, step: -1 };
  return { cls: 'ok', text: 'готова к операции', a: 0, b: 0, step: -1 };
}

function soStars(n) { var s = ''; for (var i = 0; i < 3; i++) s += '<i class="' + (i < n ? 'on' : '') + '">★</i>'; return s; }

function soGroupCard(g) {
  var st = soState, now = soNow(), ph = soGroupPhase(g, now), o = g.op;
  var html = '<div class="so-group ' + ph.cls + '">' +
    '<div class="so-face">' + soFace() + '</div>' +
    '<div class="so-g-info">' +
      '<div class="so-g-top"><b>' + soEsc(g.name) + '</b><span class="so-stars">' + soStars(Math.min(3, g.wins)) + '</span></div>' +
      '<div class="so-g-st"><span class="so-dot"></span><span>' + ph.text + '</span>' +
        (ph.b > now ? ' · <em class="so-left" data-until="' + ph.b + '"></em>' : '') + '</div>';
  if (g.status === 'mission' && o) {
    html += '<div class="so-steps">' + ['перелёт', 'подход', 'действие', 'возвращение'].map(function(s, i) {
      return '<span class="' + (i < ph.step ? 'done' : i === ph.step ? 'now' : '') + '">' + s + '</span>';
    }).join('') + '</div>' +
      '<div class="so-g-op">' + SO_ICON[o.kind] + '<span>' + soEsc(o.name) + ' · ' + soEsc(o.building_name || '') + '</span></div>';
  }
  if (ph.b > ph.a && ph.b > now) html += '<div class="so-bar"><i data-a="' + ph.a + '" data-b="' + ph.b + '"></i></div>';
  if (g.wins) html += '<div class="so-g-vet">опыт: +' + Math.min(3, g.wins) * st.cfg.vet + ' % к шансу · операций ' + g.wins + '</div>';
  html += '</div>';
  if (g.status === 'home') {
    var can = soT(g.ready_at) <= now && g.hq_ok;
    html += '<button type="button" class="so-btn" data-so="op-start" data-g="' + g.id + '"' + (can ? '' : ' disabled') + '>Операция</button>';
  }
  return html + '</div>';
}

function soHomeHtml() {
  var st = soState, c = st.cfg, html = '';
  html += '<div class="so-sec">Группы · ' + st.groups.length + ' из ' + st.max + '</div>';
  if (!st.groups.length) html += '<div class="so-note">Групп пока нет. Подготовь первую — двое бойцов, обученных проходить мимо охраны.</div>';
  st.groups.forEach(function(g) { html += soGroupCard(g); });

  if (st.groups.length < st.max) {
    if (!st.hqs.length) {
      html += '<div class="so-new off"><b>Новая группа</b><span>Группы готовит ' + (st.faction === 'cis' ? 'Центр управления' : 'Оперативный штаб') + ' на твоей планете — его нужно построить.</span></div>';
    } else {
      var hq = (soPick.hq && st.hqs.filter(function(h) { return h.id === soPick.hq; })[0]) ||
               (soBuilding && st.hqs.filter(function(h) { return h.id === soBuilding.id; })[0]) || st.hqs[0];
      soPick.hq = hq.id;
      var okC = st.credits >= c.cost, okE = hq.electronics >= c.electronics;
      html += '<div class="so-new">' +
        '<div class="so-new-top"><div class="so-face sm">' + soFace() + '</div><div><b>Новая группа</b><span>' +
          (st.faction === 'cis' ? 'звено инфильтраторов' : 'группа коммандос') + ' · подготовка ' + soMin(c.train_min) + '</span></div></div>' +
        (st.hqs.length > 1 ? '<div class="so-chips">' + st.hqs.map(function(h) {
          return '<button type="button" class="so-chip' + (h.id === hq.id ? ' on' : '') + '" data-so="hq" data-v="' + h.id + '">' + soEsc(h.system_name) + '</button>';
        }).join('') + '</div>' : '') +
        '<div class="so-cost"><span class="' + (okC ? '' : 'bad') + '">' + c.cost + ' кр</span>' +
          '<span class="' + (okE ? '' : 'bad') + '">электроника ' + c.electronics + ' <i>(' + hq.electronics + ' на ' + soEsc(hq.system_name) + ')</i></span></div>' +
        '<button type="button" class="so-go" data-so="train"' + (okC && okE ? '' : ' disabled') + '>Подготовить группу</button>' +
      '</div>';
    }
  }

  if (st.log.length) {
    html += '<div class="so-sec">Журнал операций</div><div class="so-log">';
    st.log.forEach(function(x) {
      var t = new Date(x.at), when = t.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }) + ' ' + t.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
      var res = x.result === 'ok' ? '<b class="ok">успех</b>' : x.result === 'caught' ? '<b class="bad">схвачены</b>' : '<b class="dim">сорвалась</b>';
      html += '<div class="so-log-row"><span class="so-ico">' + (SO_ICON[x.kind] || '') + '</span>' +
        '<div class="so-log-info"><span>' + soEsc(x.name) + ' · ' + soEsc(x.building_name || '') + ', ' + soEsc(x.target_name) + '</span>' +
        '<em>' + when + ' · ' + soEsc(x.group || '') + (x.chance ? ' · шанс ' + Math.round(x.chance) + ' %' : '') + (x.stolen ? ' · унесли ' + x.stolen : '') + '</em></div>' + res + '</div>';
    });
    html += '</div>';
  }

  html += '<div class="so-sec">Как это работает</div>' +
    '<div class="so-rules">' +
      '<div><b>Цель</b> — чужой участок или цех не дальше двух гиперпутей от штаба группы. Перелёт — ' + c.jump_min + ' мин на гиперпуть, подход — ' + c.approach_min + ' мин: в это время хозяин может увидеть группу в сцене участка.</div>' +
      '<div><b>Шанс</b> — ' + c.base + ' %, считается в момент действия: охранник −' + c.guard + ' %, караул −' + c.watch + ' %, узел связи −' + c.comms + ' %; ночью (22–06) +' + c.night + ' %, опыт группы до +' + 3 * c.vet + ' %.</div>' +
      '<div><b>Провал</b> — группа схвачена, хозяин сразу знает, чья она. <b>Успех</b> — хозяин видит последствия, а кто это был, узнаёт по итогам следствия через несколько часов.</div>' +
      '<div><b>Потолки</b> — по одной цели не чаще раза в сутки, одному хозяину не больше двух операций за сутки; после операции группа отдыхает ' + c.rest_h + ' ч.</div>' +
    '</div>' +
    '<div class="so-err" id="so-err"></div>';
  return html;
}

// ---------------------------------------------------------------- выбор цели
function soTargetHtml() {
  var g = soGroupById(soPick.group), c = soState.cfg, now = soNow();
  var html = '<button type="button" class="so-back" data-so="back">← К группам</button>' +
    '<div class="so-sec">Цель для «' + soEsc(g ? g.name : '') + '»</div>';
  if (!soPick.targets) return html + '<div class="so-empty">Разведка ищет цели…</div>';
  if (!soPick.targets.length) return html + '<div class="so-note">В двух гиперпутях от планеты ' + soEsc(g ? g.base_name : '') + ' нет чужих планет с участками и цехами.</div>';
  html += '<div class="so-hint">Тапни планету на карте или выбери участок в списке.</div>';
  soPick.targets.forEach(function(p) {
    var ms = window.SOMap ? SOMap.sys(p.system_id) : null;
    html += '<div class="so-planet' + (soPick.sys === p.system_id ? ' on' : '') + '" id="so-p-' + p.system_id + '">' +
      '<div class="so-planet-top">' +
        '<span class="so-thumb"' + (ms && ms.tex ? ' style="background-image:url(\'../' + soEsc(ms.tex) + '\')"' : '') + '></span>' +
        '<div class="so-planet-info"><b>' + soEsc(p.system_name) + '</b><span>' + soEsc(p.owner || '') + ' · ' + soJumps(p.jumps) + ' · перелёт ' + soMin(p.jumps * c.jump_min) + '</span></div>' +
        '<em title="без учёта охраны цели">≈ ' + p.chance + ' %</em>' +
      '</div>';
    if (p.victim_full) html += '<div class="so-note warn">Хозяин уже пережил две операции за сутки — его пока не трогают.</div>';
    p.sites.forEach(function(s) {
      var cd = s.cooldown_until ? soT(s.cooldown_until) : 0, off = p.victim_full || cd > now;
      html += '<button type="button" class="so-site" data-so="site" data-sys="' + p.system_id + '" data-v="' + s.building_id + '"' + (off ? ' disabled' : '') + '>' +
        '<i style="background:' + soEsc(s.color || '#8fa8c4') + '"></i>' +
        '<span><b>' + soEsc(s.name) + '</b><em>' + soEsc(s.res_name) + (s.refine ? ' · цех' : ' · участок') + ' · мест ' + s.places + '</em></span>' +
        (cd > now ? '<small>ещё ' + soLeft(cd - now) + '</small>' : '<small>›</small>') +
      '</button>';
    });
    html += '</div>';
  });
  return html + '<div class="so-err" id="so-err"></div>';
}

function soTargetOf() {
  var res = null;
  (soPick.targets || []).forEach(function(p) { p.sites.forEach(function(s) { if (s.building_id === soPick.site) res = { p: p, s: s }; }); });
  return res;
}

// ---------------------------------------------------------------- выбор операции
function soOpHtml() {
  var g = soGroupById(soPick.group), t = soTargetOf(), c = soState.cfg;
  var html = '<button type="button" class="so-back" data-so="back-target">← К целям</button>';
  if (!g || !t) return html + '<div class="so-empty">Цель не найдена</div>';
  var ch = t.p.chance, fly = t.p.jumps * c.jump_min;
  html += '<div class="so-target">' +
    '<i style="background:' + soEsc(t.s.color || '#8fa8c4') + '"></i>' +
    '<div><b>' + soEsc(t.s.name) + '</b><span>' + soEsc(t.p.system_name) + ' · ' + soEsc(t.p.owner || '') + ' · ' + soEsc(t.s.res_name) + '</span></div>' +
  '</div>';
  html += '<div class="so-chance">' +
    '<div class="so-ring" style="--p:' + ch + '"><b>' + ch + '%</b></div>' +
    '<div class="so-chance-info"><b>Шанс без учёта защиты цели</b>' +
      '<span>охранник −' + c.guard + ' %, караул −' + c.watch + ' %, узел связи −' + c.comms + ' %. Охрану разведка не видит — решается в момент действия.</span></div>' +
  '</div>';
  html += '<div class="so-time">' +
    '<span><b>' + soMin(fly) + '</b>перелёт</span><i></i>' +
    '<span><b>' + c.approach_min + ' мин</b>подход</span><i></i>' +
    '<span><b>!</b>действие</span><i></i>' +
    '<span><b>' + soMin(c.exit_min + fly) + '</b>назад</span>' +
  '</div>';
  html += '<div class="so-sec">Операция</div><div class="so-kinds">';
  SO_KINDS.forEach(function(k) {
    html += '<button type="button" class="so-kind' + (soPick.kind === k.id ? ' on' : '') + '" data-so="kind" data-v="' + k.id + '">' +
      '<span class="so-ico">' + SO_ICON[k.id] + '</span>' +
      '<span class="so-kind-info"><b>' + k.name + '</b><em>' + k.what + '</em><small>' + k.pain + '</small></span>' +
    '</button>';
  });
  html += '</div>';
  var okC = soState.credits >= c.op_cost;
  html += '<button type="button" class="so-go" data-so="launch"' + (soPick.kind && okC ? '' : ' disabled') + '>' +
    (soPick.kind ? 'Начать операцию · ' + c.op_cost + ' кр' : 'Выбери операцию') + '</button>' +
    (okC ? '' : '<div class="so-note warn">Не хватает кредитов: подготовка операции — ' + c.op_cost + ' кр.</div>') +
    '<div class="so-err" id="so-err"></div>';
  return html;
}

// ---------------------------------------------------------------- действия
function soCall(fn, args, after) {
  if (soBusy) return;
  soBusy = true; soErr('');
  supabase.rpc(fn, args).then(function(r) {
    soBusy = false;
    if (r.error) { soErr(r.error.message); return; }
    if (typeof refreshCreditsSoon === 'function') refreshCreditsSoon();
    if (typeof loadPlanetStock === 'function') loadPlanetStock();
    if (after) after();
    soSet(r.data);
  }, function() { soBusy = false; soErr('Нет связи с сервером'); });
}

function soClick(e) {
  var b = e.target.closest('[data-so]'); if (!b || b.disabled || !soState) return;
  var act = b.getAttribute('data-so'), v = b.getAttribute('data-v');
  if (act === 'hq') { soPick.hq = v; soRender(); }
  else if (act === 'train') {
    var c = soState.cfg, hq = soState.hqs.filter(function(h) { return h.id === soPick.hq; })[0];
    var go = function() { soCall('spy_train', { p_hq: soPick.hq }); };
    if (typeof gameConfirm === 'function') gameConfirm({ tone: 'build', kicker: 'Тайные операции',
      title: soState.faction === 'cis' ? 'Звено инфильтраторов' : 'Группа коммандос', sub: 'Подготовка — ' + soMin(c.train_min),
      rows: [{ label: 'Спишется', items: [{ text: c.cost + ' кр.', kind: 'credits' }, { text: 'Электроника ' + c.electronics, color: '#4a90d9' }] }],
      note: 'Электроника — со склада планеты ' + (hq ? hq.system_name : '') + '. Группа служит, пока её не схватят.', ok: 'Готовить' }, go);
    else go();
  }
  else if (act === 'op-start') {
    soPick = { group: b.getAttribute('data-g'), targets: null, sys: null, site: null, kind: null, hq: soPick.hq };
    soView = 'target'; soRender(); soMapSync();
    var gid = soPick.group;
    supabase.rpc('spy_targets', { p_group: gid }).then(function(r) {
      if (soView !== 'target' || soPick.group !== gid) return;
      if (r.error) { soPick.targets = []; soRender(); soErr(r.error.message); return; }
      soPick.targets = r.data || [];
      soMapSync(); soRender();
    });
  }
  else if (act === 'back') { soView = 'home'; soPick.targets = null; soPick.sys = null; soMapSync(); soRender(); }
  else if (act === 'back-target') { soView = 'target'; soPick.kind = null; soRender(); soMapSync(); }
  else if (act === 'site') { soPick.site = v; soPick.sys = b.getAttribute('data-sys'); soPick.kind = null; soView = 'op'; soRender(); soMapSync();
    var body = document.getElementById('so-body'); if (body) body.scrollTop = 0; }
  else if (act === 'kind') { soPick.kind = v; soRender(); }
  else if (act === 'launch') {
    var t = soTargetOf(), k = soKind(soPick.kind), g = soGroupById(soPick.group);
    if (!t || !k || !g) return;
    var launch = function() { soCall('spy_launch', { p_group: g.id, p_building: t.s.building_id, p_kind: k.id }, function() {
      soView = 'home'; soPick.targets = null; soPick.sys = null; soPick.site = null; soPick.kind = null;
      var body = document.getElementById('so-body'); if (body) body.scrollTop = 0;
    }); };
    if (typeof gameConfirm === 'function') gameConfirm({ tone: 'danger', kicker: g.name, title: k.name,
      sub: t.s.name + ' · ' + t.p.system_name,
      rows: [{ label: 'Спишется', items: [{ text: soState.cfg.op_cost + ' кр.', kind: 'credits' }] }],
      note: 'Перелёт ' + soMin(t.p.jumps * soState.cfg.jump_min) + ', подход ' + soState.cfg.approach_min + ' мин. Отменить после старта нельзя. Схватят — группа пропадёт.', ok: 'Начать' }, launch);
    else launch();
  }
}

// ---------------------------------------------------------------- раз в секунду: таймеры и полосы
function soLive() {
  var st = soState; if (!st) return;
  var now = soNow(), due = false;
  var ls = document.querySelectorAll('#so-body .so-left[data-until]');
  for (var i = 0; i < ls.length; i++) {
    var u = +ls[i].getAttribute('data-until');
    if (u > now) ls[i].textContent = 'ещё ' + soLeft(u - now); else { ls[i].textContent = 'сейчас'; due = true; }
  }
  var bs = document.querySelectorAll('#so-body .so-bar i[data-a]');
  for (i = 0; i < bs.length; i++) {
    var a = +bs[i].getAttribute('data-a'), b = +bs[i].getAttribute('data-b');
    bs[i].style.width = (Math.max(0, Math.min(1, (now - a) / Math.max(1, b - a))) * 100).toFixed(1) + '%';
  }
  // фаза сменилась или база уже решила операцию — свежее состояние (не чаще раза в 20 с)
  if (due && soView === 'home' && !soBusy && Date.now() - (soLive.last || 0) > 20000) { soLive.last = Date.now(); soLoad(); }
  soHud(now);
}

function soHud(now) {
  var el = document.getElementById('so-hud'), st = soState; if (!el || !st) return;
  var busy = st.groups.filter(function(g) { return g.status === 'mission'; }), html;
  if (!st.groups.length) html = '<i></i>Групп нет';
  else if (busy.length) {
    var g = busy[0], ph = soGroupPhase(g, now);
    html = '<i class="on"></i>' + soEsc(g.name) + ' · ' + ph.text.replace(/<[^>]+>/g, '') + (ph.b > now ? ' · ' + soLeft(ph.b - now) : '') + (busy.length > 1 ? ' · ещё ' + (busy.length - 1) : '');
  } else html = '<i></i>Групп ' + st.groups.length + ' из ' + st.max + ' · все дома';
  if (el.innerHTML !== html) el.innerHTML = html;
}
