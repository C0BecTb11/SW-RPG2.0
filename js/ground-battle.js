// Панели планеты (system=id в URL) поверх наземки 2.0: карту, бойцов и бой рисует
// ground/ground.js, а этот файл ведёт поселение, участки под здания, наём, исследования,
// экономику, укрепления инженера и десант с орбиты. Свои рисунки на поле (участки,
// постройки, клетки высадки) он отдаёт через GD_DRAW (js/ground-live.js).
// Строить может только игрок, назначенный контролёром системы
// (system_control) — проверка реально идёт на уровне RLS в БД при записи.

// 120 игрового поля плюс приросшие снизу 4 ряда полосы вторжения
var GRID_SIZE = 144;   // 140 игрового поля плюс 4 ряда полосы вторжения
var CELL_PX = 32;     // размер клетки в px на канвасе (уменьшен под возросший размер поля)
var SLOT_COUNT = 7;
var SLOT_SIZE = 6;    // 6x6 клеток на слот

var systemId = null;
var buildMode = false;   // пустые слоты показываем только в режиме стройки
var scale = 1;
var panX = 0;
var panY = 0;

var viewport, canvas, ctx;
var buildSlots = [];       // [{x,y}] верхний левый угол каждого слота
var deployZones = [];      // две зоны высадки 6x6 у верхнего края карты
var DEPLOY_SIZE = 6;
var ATTACK_ZONE_H = 4;   // высота полосы вторжения, приходит из game_settings
var iAmAttacker = null;  // null — ещё не выяснено
var myFaction = null;
var sysFaction = null;

// Геометрию поселения берём из базы: расхождение значило бы, что игрок
// видит одну зону, а захват считается по другой
var settlement = null;
var settlementZone = null;

function loadSettlement() {
  return Promise.all([
    supabase.rpc('settlement_box'),
    supabase.rpc('settlement_zone_box')
  ]).then(function(r) {
    if (!r[0].error && r[0].data && r[0].data.length) settlement = r[0].data[0];
    if (!r[1].error && r[1].data && r[1].data.length) settlementZone = r[1].data[0];
    if (window.sceneLoader) sceneLoader.mark('settlement');
  });
}

// ===== Разведсводка =====
// Единственный способ узнать о вражеском командире: свой разведчик
// на планете. Полоса появляется только когда есть что сообщить.
function loadScoutReport() {
  supabase.rpc('get_scouted_commanders', { p_system_id: systemId }).then(function(res) {
    var bar = document.getElementById('scout-bar');
    if (!bar) return;

    var list = (!res.error && res.data) ? res.data : [];

    if (!list.length) { bar.style.display = 'none'; return; }

    // Раньше сводка висела полосой во всю ширину посреди карты и закрывала
    // обзор. Теперь это компактная плашка в углу: число и тревожный цвет,
    // если кто-то на подходе. Подробности — по нажатию.
    var here = list.filter(function(c) { return !c.arriving; }).length;
    var soon = list.length - here;

    var lines = list.map(function(c) {
      var who = escHtml(c.commander_name) + (c.player_name ? ' · ' + escHtml(c.player_name) : '');
      return c.arriving
        ? '<i class="scout-soon">' + who + ' — прибудет через ' +
          formatLeft(c.seconds_left) + '</i>'
        : '<i>' + who + ' — здесь</i>';
    });

    bar.classList.toggle('alert', soon > 0);
    bar.innerHTML =
      '<div class="scout-chip">' +
        '<b>Разведка</b>' +
        '<span>' + (here ? here + ' здесь' : '') +
          (here && soon ? ' · ' : '') + (soon ? soon + ' на подходе' : '') + '</span>' +
      '</div>' +
      '<div class="scout-list">' + lines.join('') + '</div>';
    bar.style.display = 'block';

    if (!bar.dataset.bound) {
      bar.dataset.bound = '1';
      bar.addEventListener('click', function() { bar.classList.toggle('open'); });
    }
  });
}

// ===== Панель поселения =====
// Довольство, доход и суточные задачи. Данные отдаёт сервер только своей
// фракции: по задачам видно, где слабая охрана и где нет флота, — это
// разведданные, а не украшение.

var SETTLEMENT_TASKS = {
  guard:     { title: 'Охрана поселения', hint: 'пехоты в зоне' },
  patrol:    { title: 'Патруль', hint: 'техники в зоне' },
  orbit:     { title: 'Прикрытие с орбиты', hint: 'корабль в площадке сброса' },
  // Дневной налёт: строку рисует stlMarauderState по этапу из payload;
  // sub — запасной текст для старых задач без времени налёта
  marauder:  { title: 'Налёт мародёров', hint: '', sub: function(n) {
    return n > 1 ? 'Уничтожить налётчиков: ' + n : 'Уничтожить налётчика';
  } },
  donation:  { title: 'Пожертвование', hint: 'кредитов' },
  festival:  { title: 'Праздник', hint: 'кредитов' },
  factories: { title: 'Слишком много заводов', hint: 'оставить не больше' },
  // Здание у сторон своё: у Республики «Центр медицины», у КНС «Ремонтный
  // цех». Раньше задача звала его «лечебницей», и игроки искали в стройке
  // то, чего там нет. Имя берём из справочника построек, как в панели стройки.
  medical:   { title: function() { return 'Нужен ' + stlMedicalName(); },
               hint: '', sub: function() { return 'Здание из панели стройки · квартал «Госпиталь» не в счёт'; } }
};

function stlMedicalName() {
  var code = myFaction === 'cis' ? 'cis_repair' : 'rep_medical';
  var bt = (buildingTypes || []).filter(function(b) { return b.code === code; })[0];
  return bt ? '«' + bt.name + '»' : (myFaction === 'cis' ? '«Ремонтный цех»' : '«Центр медицины»');
}

var settlementTimer = null;

// Зачёт условий суток — как settlement_task_gain / _loss / _bonus и settlement_no_ruler_penalty в game_settings
var STL_GAIN = 5, STL_LOSS = 4, STL_BONUS = 5, STL_NO_RULER = 10;

// ===== Развитие поселения =====
// Уровень, кварталы, провизия и ополчение. Сводку считает сервер
// (get_settlement_dev), клиент только показывает её и ведёт обратные
// отсчёты локально — раз в секунду база не нужна.
var settlementDev = null;        // последняя сводка: и для панели, и для плашки на карте
var stlTab = 'dev';              // открытая вкладка переживает автообновление и повторное открытие
var stlPicker = null;            // номер участка, для которого открыт выбор квартала
var stlLevels = null;            // settlement_levels — справочник, читаем один раз
var stlDistrictTypes = null;     // district_types — тоже справочник
var stlLast = null;              // последние данные панели: вкладки перерисовываются без запроса
var stlTickTimer = null;
var stlLoadSeq = 0;              // номер запроса панели: опоздавший ответ не затирает свежий
var stlDevSeq = 0;               // то же для сводки: панель и опрос карты спрашивают её независимо
var stlDevApplied = 0;
var stlBusy = false;             // действие в пути — второй тап не проходит
var stlExpiredEnds = {};         // отсчёты, по окончании которых уже просили свежие данные
var stlImgFailed = {};           // картинки кварталов, которых нет: больше не просим
var stlImgOk = {};               // уже загружались: при перерисовке символ под ними не мигает
var STL_ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI'];

function openSettlementPanel() {
  var panel = document.getElementById('settlement-panel');
  if (!panel) return;

  panel.style.display = 'flex';
  stlPicker = null;
  document.getElementById('settlement-body').innerHTML =
    '<div class="stl-empty">Загрузка…</div>';

  loadSettlementPanel();

  if (settlementTimer) clearInterval(settlementTimer);
  settlementTimer = setInterval(loadSettlementPanel, 15000);

  // Обратные отсчёты (расширение, стройка кварталов, сбор ополчения)
  // тикают локально, между запросами
  if (stlTickTimer) clearInterval(stlTickTimer);
  stlTickTimer = setInterval(stlTick, 1000);
}

function closeSettlementPanel() {
  var panel = document.getElementById('settlement-panel');
  if (panel) panel.style.display = 'none';
  if (settlementTimer) { clearInterval(settlementTimer); settlementTimer = null; }
  if (stlTickTimer) { clearInterval(stlTickTimer); stlTickTimer = null; }
  stlPicker = null;
}

function formatSettlementLeft(sec) {
  var h = Math.floor(sec / 3600);
  var m = Math.floor((sec % 3600) / 60);
  if (h > 0) return h + ' ч ' + m + ' мин';
  if (m > 0) return m + ' мин';
  return sec + ' с';
}

// Длительность без «0 мин»: 4 ч, 1 ч 30 мин, 45 мин
function stlDur(sec) {
  sec = Math.max(0, Math.round(Number(sec) || 0));
  var h = Math.floor(sec / 3600);
  var m = Math.floor((sec % 3600) / 60);
  if (h > 0) return h + ' ч' + (m ? ' ' + m + ' мин' : '');
  if (m > 0) return m + ' мин';
  return sec + ' с';
}

// Тикающий отсчёт: 1:12:05 / 12:05 — цифры не прыгают по ширине
function formatSettlementClock(sec) {
  sec = Math.max(0, Math.ceil(sec));
  var h = Math.floor(sec / 3600);
  var m = Math.floor((sec % 3600) / 60);
  var s = sec % 60;
  var mm = (m < 10 ? '0' : '') + m;
  var ss = (s < 10 ? '0' : '') + s;
  return h > 0 ? h + ':' + mm + ':' + ss : m + ':' + ss;
}

// Любой запрос превращаем в {data, error}: упавшая сеть или отсутствующая
// функция на сервере не должны ронять всю панель
function stlSafe(p) {
  return Promise.resolve(p).then(function(r) {
    return r || { data: null, error: null };
  }, function(e) {
    return { data: null, error: { message: (e && e.message) || 'нет связи с сервером' } };
  });
}

// jsonb приходит объектом, но на всякий случай разворачиваем и массив
function stlNormDev(data) {
  if (Array.isArray(data)) data = data.length ? data[0] : null;
  return (data && typeof data === 'object' && data.level) ? data : null;
}

// Функции на сервере нет — дёргать её раз в минуту бессмысленно
function stlRpcMissing(err) {
  if (!err) return false;
  return err.code === 'PGRST202' || err.code === '42883' ||
    /could not find the function|does not exist/i.test(err.message || '');
}

// Запоминаем сводку; опоздавший ответ не затирает свежий
function applySettlementDev(dev, seq) {
  if (seq) {
    if (seq < stlDevApplied) return;
    stlDevApplied = seq;
  }
  // Поселение выросло — открылись новые участки под здания
  var grew = settlementDev && dev && dev.level !== settlementDev.level;
  settlementDev = dev;
  if (grew && typeof loadBuildings === 'function') loadBuildings();
}

// Серверное время в часы клиента: сдвиг сверяется при загрузке
function stlLocalMs(iso) {
  var off = (typeof gbTimeOffset === 'number') ? gbTimeOffset : 0;
  return new Date(iso).getTime() - off;
}

function stlLevelRow(n) {
  if (!stlLevels) return null;
  for (var i = 0; i < stlLevels.length; i++) {
    if (stlLevels[i].level === n) return stlLevels[i];
  }
  return null;
}

// На каком уровне открывается участок: первый, где district_slots до него
// дотягивается. Без справочника — уровень равен номеру участка, как в базе.
function stlSlotLevel(slot) {
  if (stlLevels && stlLevels.length) {
    var rows = stlLevels.slice().sort(function(a, b) { return a.level - b.level; });
    for (var i = 0; i < rows.length; i++) {
      if ((rows[i].district_slots || 0) >= slot) return rows[i];
    }
  }
  return { level: slot, name: '' };
}

function stlDistrictType(id) {
  if (!stlDistrictTypes) return null;
  for (var i = 0; i < stlDistrictTypes.length; i++) {
    if (stlDistrictTypes[i].id === id) return stlDistrictTypes[i];
  }
  return null;
}

function stlSigned(v) {
  v = Number(v) || 0;
  return (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v);
}

function stlMult(v) {
  var n = Math.round((Number(v) || 1) * 100) / 100;
  return '×' + String(n).replace('.', ',');
}

function stlPips(level, max, upTo) {
  var html = '<span class="stl-pips">';
  for (var i = 1; i <= max; i++) {
    html += '<i class="' + (i <= level ? 'on' : (upTo && i === upTo ? 'up' : '')) + '"></i>';
  }
  return html + '</span>';
}

// Картинка квартала поверх символа: пока файла нет или он грузится,
// виден символ в плитке, а не значок битой картинки
function stlArtHtml(id, icon, image, cls, overlay) {
  var path = image || ('assets/districts/' + id + '.png');
  var img = stlImgFailed[path] ? '' :
    '<img src="../' + escHtml(path) + '" alt="" data-stl-img="' + escHtml(path) + '"' +
    ' onload="stlImgLoad(this)" onerror="stlImgError(this)">';
  if (img && stlImgOk[path]) cls += ' has-img';
  return '<div class="' + cls + '"><span class="stl-glyph">' + escHtml(icon || '◇') + '</span>' + img +
    (overlay || '') + '</div>';
}

// Та же картинка квартала, что на плитке; не нашлась там — не тянем и в окно
function stlArtSrc(id, image) {
  var path = image || ('assets/districts/' + id + '.png');
  return stlImgFailed[path] ? null : '../' + path;
}

function stlImgLoad(img) {
  stlImgOk[img.getAttribute('data-stl-img')] = true;
  if (img.parentNode) img.parentNode.classList.add('has-img');
}

function stlImgError(img) {
  stlImgFailed[img.getAttribute('data-stl-img')] = true;
  if (img.parentNode) img.parentNode.removeChild(img);
}

// Цена со склада: нехватка красным и сколько есть — как в каталоге построек
function stlResCost(resources, stock) {
  var parts = [];
  var short = false;
  for (var key in (resources || {})) {
    if (!Object.prototype.hasOwnProperty.call(resources, key)) continue;
    var need = Number(resources[key]) || 0;
    if (!need) continue;
    var have = stock ? (Number(stock[key]) || 0) : null;
    var lack = have !== null && have < need;
    if (lack) short = true;
    parts.push('<span class="' + (lack ? 'short' : '') + '">' + escHtml(resourceName(key)) + ' ' + need +
      (lack ? ' <em>(есть ' + have + ')</em>' : '') + '</span>');
  }
  return { html: parts.join(' · '), short: short };
}

function loadSettlementPanel() {
  var seq = ++stlLoadSeq;
  var devSeq = ++stlDevSeq;
  var jobs = [
    stlSafe(supabase.rpc('get_settlement_state', { p_system_id: systemId })),
    stlSafe(supabase.rpc('get_settlement_tasks', { p_system_id: systemId })),
    stlSafe(supabase.rpc('get_settlement_dev', { p_system_id: systemId })),
    stlLevels ? null : stlSafe(supabase.from('settlement_levels').select('*').order('level')),
    stlDistrictTypes ? null : stlSafe(supabase.from('district_types').select('*').order('sort_order')),
    // Напряжение на планете (js/unrest.js): нет функции на сервере — блок просто не рисуется
    typeof unSettlementHtml === 'function' ? stlSafe(supabase.rpc('unrest_state', { p_system: systemId })) : null,
    // Названия сырья для требований и цен: справочник грузится один раз
    new Promise(function(done) {
      if (typeof loadResourceNames === 'function') loadResourceNames(done); else done();
    })
  ];

  Promise.all(jobs).then(function(r) {
    // Пока шёл запрос, ушёл более новый (по таймеру, после действия или
    // по окончании отсчёта) — этот ответ уже устарел
    if (seq !== stlLoadSeq) return;
    var panel = document.getElementById('settlement-panel');
    var body = document.getElementById('settlement-body');
    if (!body || !panel || panel.style.display === 'none') return;

    if (r[3] && !r[3].error && r[3].data) stlLevels = r[3].data;
    if (r[4] && !r[4].error && r[4].data) stlDistrictTypes = r[4].data;

    var st = (!r[0].error && r[0].data && r[0].data.length) ? r[0].data[0] : null;

    // Чужая планета — сервер ничего не отдаёт, и это правильно
    if (!st) {
      body.innerHTML = '<div class="stl-empty">Поселение не делится сведениями ' +
        'с чужой фракцией</div>';
      return;
    }

    // Вводный курс: управляющий осмотрел своё поселение
    if (st.is_controller && typeof questSeen === 'function') questSeen('settlement', systemId);

    var tasks = (!r[1].error && r[1].data) ? r[1].data : [];

    var dev = null;
    var devErr = r[2].error || null;
    if (!devErr) {
      dev = stlNormDev(r[2].data);
      applySettlementDev(dev, devSeq);
    }

    // Время получения храним вместе с данными: от него считаются концы
    // отсчётов, и опрос карты его не сдвигает
    var unrest = (r[5] && !r[5].error) ? r[5].data : null;
    stlLast = { st: st, tasks: tasks, dev: dev, devErr: devErr, unrest: unrest, at: Date.now() };
    renderSettlementPanel();
  });
}

// Каркас с вкладками строится один раз, дальше меняется только
// содержимое вкладок: прокрутка и выбранная вкладка не сбрасываются
function stlEnsureFrame(body) {
  if (body.querySelector('.stl-tabs')) return;

  body.innerHTML =
    '<div class="stl-tabs">' +
      '<button class="stl-tab" data-act="tab" data-tab="dev">Развитие<i></i></button>' +
      '<button class="stl-tab" data-act="tab" data-tab="districts">Кварталы<i></i></button>' +
      '<button class="stl-tab" data-act="tab" data-tab="tasks">Условия<i></i></button>' +
    '</div>' +
    '<div class="stl-pane" data-pane="dev"></div>' +
    '<div class="stl-pane" data-pane="districts"></div>' +
    '<div class="stl-pane" data-pane="tasks"></div>';

  // Один обработчик на всю панель: содержимое перерисовывается,
  // а привязки не теряются
  if (!body.getAttribute('data-stl-bound')) {
    body.setAttribute('data-stl-bound', '1');
    body.addEventListener('click', stlOnClick);
  }
}

function renderSettlementPanel() {
  var body = document.getElementById('settlement-body');
  if (!body || !stlLast) return;

  var box = document.getElementById('settlement-box');
  var scroll = box ? box.scrollTop : 0;

  stlEnsureFrame(body);

  var d = stlLast.dev;
  var st = stlLast.st;
  var tasks = stlLast.tasks;
  var doneCount = tasks.filter(function(t) { return t.done_now; }).length;

  // Счётчики на вкладках: что требует внимания, видно не открывая
  var tabs = body.querySelectorAll('.stl-tab');
  for (var i = 0; i < tabs.length; i++) {
    var key = tabs[i].getAttribute('data-tab');
    var mark = tabs[i].querySelector('i');
    var txt = '';
    var cls = '';
    if (key === 'dev' && d) {
      txt = STL_ROMAN[d.level] || d.level;
      if (d.can_upgrade) cls = 'go';
      else if (d.upgrade_until) cls = 'busy';
    } else if (key === 'districts' && d) {
      var built = (d.districts || []).length;
      txt = built + '/' + (d.slots || 0);
      if (d.is_controller && built < (d.slots || 0)) cls = 'go';
    } else if (key === 'tasks' && tasks.length) {
      txt = doneCount + '/' + tasks.length;
      cls = doneCount === tasks.length ? 'ok' : stlOnlyRaidLeft(tasks) ? 'go' : 'bad';
    }
    mark.textContent = txt;
    mark.className = cls;
    tabs[i].classList.toggle('active', key === stlTab);
  }

  var panes = body.querySelectorAll('.stl-pane');
  for (var j = 0; j < panes.length; j++) {
    panes[j].style.display = panes[j].getAttribute('data-pane') === stlTab ? 'block' : 'none';
  }

  body.querySelector('[data-pane="dev"]').innerHTML = stlDevHtml(stlLast);
  body.querySelector('[data-pane="districts"]').innerHTML = stlDistrictsHtml(stlLast);
  renderSettlementTasks(body.querySelector('[data-pane="tasks"]'), st, tasks, !!d);

  if (box) box.scrollTop = scroll;
  stlTick();
}

// Сервер не ответил на сводку развития: говорим прямо, остальное работает
function stlDevErrorHtml(err) {
  var missing = stlRpcMissing(err);
  return '<div class="stl-alert">' +
    '<b>' + (missing ? 'Развитие поселений ещё не включено' : 'Сводка развития недоступна') + '</b>' +
    '<span>' + (missing
      ? 'Сервер пока не знает об уровнях и кварталах. Условия и выплаты работают как прежде.'
      : 'Не удалось получить данные. Панель повторит запрос сама.') + '</span>' +
    (err && err.message ? '<code>' + escHtml(err.message) + '</code>' : '') +
  '</div>';
}

// Прежний верх панели: довольство, доход, выплачено. Показываем, когда
// сводки развития нет, — сведения не должны пропадать
function stlLegacyTopHtml(st) {
  return '<div class="stl-top">' +
      '<div class="stl-mood">' +
        '<div class="stl-mood-value">' + st.satisfaction + '</div>' +
        '<div class="stl-mood-label">довольство</div>' +
      '</div>' +
      '<div class="stl-money">' +
        '<div class="stl-money-row"><span>Доход за сутки</span><b>' + st.income + '</b></div>' +
        '<div class="stl-money-row"><span>Станет при росте</span><em>' + st.next_income + '</em></div>' +
        '<div class="stl-money-row"><span>Всего выплачено</span><em>' + st.total_paid + '</em></div>' +
        (st.structure_bonus > 0
          ? '<div class="stl-money-row"><span>Кантина · довольство</span><b>+' + st.structure_bonus + '</b></div>'
          : '') +
      '</div>' +
    '</div>' +
    '<div class="stl-track"><i style="width:' + st.satisfaction + '%"></i></div>';
}

function stlDevHtml(L) {
  var d = L.dev;
  var st = L.st;
  if (!d) {
    return (L.devErr ? stlDevErrorHtml(L.devErr)
      : '<div class="stl-alert"><b>Сводка развития недоступна</b></div>') + stlLegacyTopHtml(st);
  }

  var max = d.max_level || 4;
  var isMax = !d.next && !d.upgrade_until;
  var upTo = d.upgrade_until ? (d.upgrade_to || d.level + 1) : null;
  var html = '';

  // Уровень: герб с римской цифрой, название, шкала ступеней
  html += '<div class="stl-lvl' + (isMax ? ' max' : '') + '">' +
    '<div class="stl-lvl-emb">' + (STL_ROMAN[d.level] || d.level) + '</div>' +
    '<div class="stl-lvl-info">' +
      '<div class="stl-lvl-name">' + escHtml(d.level_name) + '</div>' +
      '<div class="stl-lvl-sub">уровень ' + d.level + ' из ' + max + ' · ' +
        (d.slots || 0) + ' ' + stlPlural(d.slots || 0, 'участок', 'участка', 'участков') +
        (d.build_slots ? ' · зданий ' + (d.build_used || 0) + '/' + d.build_slots : '') + '</div>' +
    '</div>' +
    stlPips(d.level, max, upTo) +
  '</div>';

  // Довольство: итог крупно, из чего сложилось — рядом
  var factors = d.factors || [];
  var fl = factors.map(function(f, i) {
    var v = Number(f.value) || 0;
    var cls = i === 0 ? 'base' : (v > 0 ? 'pos' : v < 0 ? 'neg' : '');
    return '<div class="stl-factor"><span>' + escHtml(f.label) + '</span>' +
      '<b class="' + cls + '">' + (i === 0 ? v : stlSigned(v)) + '</b></div>';
  }).join('');
  var eff = Math.max(0, Math.min(100, Number(d.effective) || 0));
  // Порог нужен, пока расширение впереди: во время стройки он уже пройден
  var need = (d.next && !d.upgrade_until) ? d.next.min_satisfaction : null;
  var moodCls = need !== null && need !== undefined ? (eff >= need ? ' ok' : ' low') : '';

  html += '<div class="stl-top stl-top-dev">' +
    '<div class="stl-mood' + moodCls + '">' +
      '<div class="stl-mood-value">' + eff + '</div>' +
      '<div class="stl-mood-label">довольство</div>' +
    '</div>' +
    '<div class="stl-factors">' + (fl || '<div class="stl-factor"><span>Без надбавок</span></div>') + '</div>' +
  '</div>';

  html += '<div class="stl-track stl-mood-track"><i style="width:' + eff + '%"></i>' +
    (need ? '<s style="left:' + need + '%"></s>' : '') + '</div>';
  if (need) {
    html += '<div class="stl-track-cap"><span>0</span>' +
      '<em style="left:' + need + '%">порог ' + need + '</em><span>100</span></div>';
  }

  // Напряжение: шкала, прогноз на утро, история (js/unrest.js)
  if (typeof unSettlementHtml === 'function') html += unSettlementHtml(L.unrest);

  // Доход: итоговый множитель — чтобы было понятно, откуда цифра. income_mult из базы уже
  // включает рынок (уровень × рынок), поэтому рынок не дописывается сверху второй раз
  var market = (d.districts || []).some(function(x) { return x.id === 'market' && !x.building; });
  html += '<div class="stl-income">' +
    '<div class="stl-income-row"><span>Доход за сутки</span>' +
      '<b>' + d.income + ' кр.</b></div>' +
    '<div class="stl-income-row sub"><span>Множитель ' + stlMult(d.income_mult) +
      (market ? ' · с рынком' : ' · уровня') + '</span><em>выплачено всего ' + (st.total_paid || 0) + '</em></div>' +
  '</div>';

  // Следующая ступень, идущее расширение или предел
  if (d.upgrade_until) html += stlUpgradeHtml(d);
  else if (isMax) html += stlMaxHtml(d);
  else if (d.next) html += stlNextHtml(d);

  html += stlFoodHtml(d);
  html += stlMilitiaHtml(d, L.at);

  return html;
}

function stlPlural(n, one, few, many) {
  n = Math.abs(n) % 100;
  var n1 = n % 10;
  if (n > 10 && n < 20) return many;
  if (n1 > 1 && n1 < 5) return few;
  if (n1 === 1) return one;
  return many;
}

function stlNextHtml(d) {
  var nx = d.next;
  var html = '<div class="stl-sec"><span>Расширение</span>' +
    '<em>' + (STL_ROMAN[nx.level] || nx.level) + ' · ' + escHtml(nx.name) + '</em></div>';

  // Очки развития — по делению на очко: видно, сколько осталось
  var needPts = nx.dev_need || d.dev_need || 0;
  var pts = Math.min(d.dev_points || 0, needPts);
  if (needPts > 0) {
    html += '<div class="stl-devbar">';
    for (var i = 0; i < needPts; i++) html += '<i class="' + (i < pts ? 'on' : '') + '"></i>';
    html += '</div>';
  }

  // Требования по строкам: что уже есть, чего нет
  var reqs = [];
  reqs.push({ ok: (d.dev_points || 0) >= needPts, label: 'Очки развития',
    val: (d.dev_points || 0) + ' / ' + needPts });
  reqs.push({ ok: (Number(d.effective) || 0) >= nx.min_satisfaction,
    label: 'Довольство ≥ ' + nx.min_satisfaction, val: 'сейчас ' + (d.effective || 0) });
  if (nx.credits) reqs.push({ ok: null, label: 'Кредиты', val: nx.credits + ' кр.' });

  var res = nx.resources || {};
  for (var key in res) {
    if (!Object.prototype.hasOwnProperty.call(res, key)) continue;
    var needR = Number(res[key]) || 0;
    if (!needR) continue;
    var have = Number((d.stock || {})[key]) || 0;
    reqs.push({ ok: have >= needR, label: resourceName(key), val: have + ' / ' + needR });
  }

  html += '<div class="stl-reqs">' + reqs.map(function(q) {
    var cls = q.ok === null ? 'info' : q.ok ? 'ok' : 'bad';
    var mark = q.ok === null ? '◈' : q.ok ? '✓' : '✗';
    return '<div class="stl-req ' + cls + '"><i>' + mark + '</i><span>' + escHtml(q.label) + '</span>' +
      '<b>' + q.val + '</b></div>';
  }).join('') + '</div>';

  // Что даст новая ступень
  var lvl = stlLevelRow(nx.level);
  var gains = [];
  if (nx.slots) gains.push([nx.slots, stlPlural(nx.slots, 'участок', 'участка', 'участков')]);
  // Новые места под здания — главная выгода роста для производства
  if (nx.build_slots) gains.push(['+' + nx.build_slots, 'под здания']);
  if (nx.income_mult) gains.push([stlMult(nx.income_mult), 'доход']);
  if (lvl && lvl.militia_base) gains.push([lvl.militia_base, 'ополчение']);
  if (nx.food_per_day) gains.push([nx.food_per_day, 'провизии/сут']);
  if (gains.length) {
    html += '<div class="stl-gains-cap">' + escHtml(nx.name) + ' даст</div>' +
      '<div class="stl-gains" style="grid-template-columns:repeat(' + (gains.length > 4 ? 3 : gains.length) + ',minmax(0,1fr))">' +
      gains.map(function(g) {
        return '<div><b>' + g[0] + '</b><span>' + g[1] + '</span></div>';
      }).join('') + '</div>';
  }

  if (!d.is_controller) {
    html += '<div class="stl-note">Расширение начинает управляющий поселением</div>';
  } else {
    if (!d.can_upgrade && d.upgrade_block) {
      html += '<div class="stl-note warn">' + escHtml(d.upgrade_block) + '</div>';
    }
    html += '<button class="stl-go" data-act="upgrade"' + (d.can_upgrade ? '' : ' disabled') + '>' +
      'Расширить до «' + escHtml(nx.name) + '»' +
      (nx.seconds ? '<em>' + stlDur(nx.seconds) + '</em>' : '') + '</button>';
  }

  return html;
}

function stlUpgradeHtml(d) {
  var to = d.upgrade_to || (d.next && d.next.level) || d.level + 1;
  var row = stlLevelRow(to);
  var name = (d.next && d.next.level === to && d.next.name) || (row && row.name) || '';
  var total = (d.next && d.next.level === to && d.next.seconds) ||
    (row && row.build_seconds) || (d.next && d.next.seconds) || 0;
  var end = stlLocalMs(d.upgrade_until);

  return '<div class="stl-sec"><span>Расширение</span><em>' +
      (STL_ROMAN[d.level] || d.level) + ' → ' + (STL_ROMAN[to] || to) + '</em></div>' +
    '<div class="stl-upg">' +
      '<div class="stl-upg-head"><span>Идёт стройка</span><b>' + escHtml(name) + '</b></div>' +
      '<div class="stl-upg-bar"><i data-stl-end="' + end + '" data-stl-total="' + total + '"></i></div>' +
      '<div class="stl-upg-foot"><span>до завершения</span>' +
        '<b data-stl-end="' + end + '">—</b></div>' +
    '</div>';
}

function stlMaxHtml(d) {
  return '<div class="stl-max">' +
    '<div class="stl-max-title">Высший уровень</div>' +
    '<div class="stl-max-text">' + escHtml(d.level_name) +
      ' — предел развития. Держите довольство и кварталы: доход идёт по полной.</div>' +
  '</div>';
}

// Провизия: сколько ест поселение, чем сыто и надолго ли хватит
function stlFoodHtml(d) {
  var f = d.food || {};
  var state, chip;
  // «Не нужна» — только когда поселение не ест вовсе. После расширения
  // fed ещё пуст: первое кормление в конце суток, это не голод
  if (!f.per_day) {
    state = 'idle'; chip = 'не нужна';
  } else if (f.fed === null || f.fed === undefined) {
    state = 'wait'; chip = 'ждёт';
  } else if (f.fed) {
    state = 'ok'; chip = 'сыто';
  } else {
    state = 'bad'; chip = 'голод';
  }

  var html = '<div class="stl-card ' + state + '">' +
    '<div class="stl-card-head"><span>Провизия</span><em>' + chip + '</em></div>';

  if (state === 'idle') {
    html += '<div class="stl-card-text">' + escHtml(d.level_name) +
      ' кормится сам. Провизия понадобится после расширения.' +
      (f.have ? ' На складе: ' + f.have + '.' : '') + '</div>';
  } else {
    var days = f.days_left === null || f.days_left === undefined ? '—' : f.days_left;
    html += '<div class="stl-stats">' +
      '<div><b>' + f.per_day + '</b><span>в сутки</span></div>' +
      '<div><b>' + (f.have || 0) + '</b><span>на складе</span></div>' +
      '<div class="' + (state === 'bad' || days === 0 ? 'bad' : days <= 1 ? 'warn' : '') + '"><b>' + days + '</b>' +
        '<span>' + (typeof days === 'number' ? stlPlural(days, 'сутки', 'суток', 'суток') : 'суток') + ' хватит</span></div>' +
    '</div>';
    if (state === 'wait') {
      html += '<div class="stl-card-text">Первое кормление — в конце суток.</div>';
    } else if (state === 'bad') {
      html += '<div class="stl-card-text bad">Жители голодают: −15 к довольству, пока на складе ' +
        'меньше суточной нормы. Подвезите провизию или постройте угодья.</div>';
    }
  }
  return html + '</div>';
}

// Ополчение: сколько встанет на защиту и когда соберётся
function stlMilitiaHtml(d, at) {
  var m = d.militia || {};
  var none = !(m.count > 0);
  var ready = !none && (!!m.ready || !(m.ready_in > 0));
  var end = (at || Date.now()) + (m.ready_in || 0) * 1000;
  var state = none ? 'warn' : ready ? 'ok' : 'wait';

  var third;
  if (none) third = '<div class="warn"><b>—</b><span>сбора нет</span></div>';
  else if (ready) third = '<div class="ok"><b>✓</b><span>сбор готов</span></div>';
  else third = '<div class="wait"><b data-stl-end="' + end + '">' + formatSettlementClock(m.ready_in) + '</b>' +
    '<span>до сбора</span></div>';

  return '<div class="stl-card militia ' + state + '">' +
    '<div class="stl-card-head"><span>Ополчение</span>' +
      '<em>' + (none ? 'не соберётся' : ready ? 'готово' : 'сбор') + '</em></div>' +
    '<div class="stl-stats">' +
      '<div><b>' + (m.count || 0) + '</b><span>поднимется</span></div>' +
      '<div><b>' + (m.alive || 0) + '</b><span>в строю</span></div>' +
      third +
    '</div>' +
    (none ? '<div class="stl-card-text warn">Не соберётся — довольство ниже 25.</div>' : '') +
  '</div>';
}

function stlDistrictsHtml(L) {
  var d = L.dev;
  if (!d) {
    return L.devErr ? stlDevErrorHtml(L.devErr)
      : '<div class="stl-empty">Сведений о кварталах нет</div>';
  }

  var bySlot = {};
  (d.districts || []).forEach(function(x) { bySlot[x.slot] = x; });

  // Выбор квартала открыт, но участок уже занят или прав нет — закрываем
  if (stlPicker && (bySlot[stlPicker] || !d.is_controller || stlPicker > (d.slots || 0))) stlPicker = null;
  if (stlPicker) return stlPickerHtml(d, bySlot);

  var slots = d.slots || 0;
  var built = (d.districts || []).length;
  var total = Math.max(4, slots);
  var html = '<div class="stl-sec"><span>Участки</span><em>занято ' + built + ' из ' + slots + '</em></div>';

  if (!d.is_controller) {
    html += '<div class="stl-note">Кварталы строит и сносит управляющий' +
      (L.st && L.st.controller ? ' — ' + escHtml(L.st.controller) : '') + '</div>';
  }

  html += '<div class="stl-slots">';
  for (var s = 1; s <= total; s++) {
    var x = bySlot[s];
    var no = '<span class="stl-slot-no">' + (s < 10 ? '0' : '') + s + '</span>';

    if (x) {
      var t = stlDistrictType(x.id) || {};
      var building = x.building && x.seconds_left > 0;
      var end = (L.at || Date.now()) + (x.seconds_left || 0) * 1000;
      html += '<div class="stl-slot ' + (building ? 'building' : 'built') + '">' + no +
        '<span class="stl-slot-tag">' + (building ? 'стройка' : 'действует') + '</span>' +
        stlArtHtml(x.id, x.icon || t.icon, t.image, 'stl-slot-art', building
          ? '<div class="stl-slot-prog"><em data-stl-end="' + end + '">' +
              formatSettlementClock(x.seconds_left) + '</em>' +
              '<div><i data-stl-end="' + end + '" data-stl-total="' + (t.build_seconds || 0) + '"></i></div></div>'
          : '') +
        '<div class="stl-slot-name">' + escHtml(x.name || t.name || x.id) + '</div>' +
        '<div class="stl-slot-eff">' + escHtml(x.effect || t.effect || '') + '</div>' +
        (d.is_controller
          ? '<button class="stl-slot-act demolish" data-act="demolish" data-slot="' + s + '">Снести</button>'
          : '') +
      '</div>';
    } else if (s <= slots) {
      html += '<div class="stl-slot empty' + (d.is_controller ? '' : ' ro') + '"' +
          (d.is_controller ? ' data-act="pick" data-slot="' + s + '"' : '') + '>' + no +
        '<div class="stl-slot-art"><span class="stl-glyph">+</span></div>' +
        '<div class="stl-slot-name">Свободный участок</div>' +
        '<div class="stl-slot-eff">' + (d.is_controller ? 'Можно заложить квартал' : 'Квартал не заложен') + '</div>' +
        (d.is_controller
          ? '<button class="stl-slot-act pick" data-act="pick" data-slot="' + s + '">Выбрать квартал</button>'
          : '') +
      '</div>';
    } else {
      var lv = stlSlotLevel(s);
      html += '<div class="stl-slot locked">' + no +
        '<div class="stl-slot-art"><span class="stl-glyph">' + (STL_ROMAN[lv.level] || lv.level) + '</span></div>' +
        '<div class="stl-slot-name">Закрыт</div>' +
        '<div class="stl-slot-eff">откроется на уровне ' + lv.level +
          (lv.name ? ' · ' + escHtml(lv.name) : '') + '</div>' +
      '</div>';
    }
  }
  html += '</div>';

  html += '<div class="stl-hint">Квартал строится за кредиты и сырьё со склада планеты. ' +
    'Снос возвращает половину кредитов и сырья.</div>';
  return html;
}

function stlPickerHtml(d, bySlot) {
  var taken = {};
  (d.districts || []).forEach(function(x) { taken[x.id] = true; });

  var html = '<div class="stl-pick-head">' +
    '<button class="stl-back" data-act="back">← Участки</button>' +
    '<span>Квартал на участок ' + (stlPicker < 10 ? '0' : '') + stlPicker + '</span>' +
  '</div>';

  if (!stlDistrictTypes) {
    return html + '<div class="stl-alert"><b>Справочник кварталов не загрузился</b>' +
      '<span>Панель повторит запрос при следующем обновлении.</span></div>';
  }

  var list = stlDistrictTypes.filter(function(t) { return !taken[t.id]; });
  if (!list.length) return html + '<div class="stl-empty">Все кварталы уже построены</div>';

  html += '<div class="stl-pick-list">';
  list.forEach(function(t) {
    var cost = stlResCost(t.cost_resources, d.stock);
    // Сырья не хватает — сервер всё равно откажет, честнее сказать сразу
    html += '<button class="stl-dist' + (cost.short ? ' short' : '') + '" data-act="build" data-id="' + escHtml(t.id) + '"' +
        (cost.short ? ' disabled' : '') + '>' +
      stlArtHtml(t.id, t.icon, t.image, 'stl-dist-art') +
      '<div class="stl-dist-info">' +
        '<div class="stl-dist-name"><span>' + escHtml(t.name) + '</span>' +
          (t.build_seconds ? '<em>' + stlDur(t.build_seconds) + '</em>' : '') + '</div>' +
        '<div class="stl-dist-eff">' + escHtml(t.effect || '') + '</div>' +
        (t.description ? '<div class="stl-dist-desc">' + escHtml(t.description) + '</div>' : '') +
        '<div class="stl-dist-cost"><b>' + (t.cost_credits || 0) + ' кр.</b>' +
          (cost.html ? ' · ' + cost.html : '') + '</div>' +
        (cost.short ? '<div class="stl-dist-why">На складе не хватает сырья</div>' : '') +
      '</div>' +
    '</button>';
  });
  html += '</div>';
  return html;
}

// Задача «Налёт мародёров»: утром разведка называет время, днём банда
// приходит на marauder_raid_hours и уходит с добычей, если её не перебить.
// Сервер кладёт этап в payload (stage, raid_at, raid_ends, alive/total).
// Старые задачи без времени налёта — null, строка рисуется как раньше.
function stlMarauderState(t) {
  var p = t.payload || {};
  var stage = p.stage;
  if (!stage) return null;

  var now = svNow();
  var at = p.raid_at ? new Date(p.raid_at).getTime() : 0;
  var end = p.raid_ends ? new Date(p.raid_ends).getTime() : 0;
  var clock = function(ms) {
    return svDayWord(ms) + 'в ' + svFormatTime(ms) + ' ' + svClock.label;
  };
  var line = function(cls, main, note) {
    return '<div class="stl-task-sub stl-raid ' + cls + '"><b>' + main + '</b>' +
      (note ? '<span>' + note + '</span>' : '') + '</div>';
  };

  if ((stage === 'scouted' || stage === 'warned') && at) {
    if (now < at) {
      return { cls: 'wait', mark: '◷',
        html: line('wait', 'Налёт ожидается ' + clock(at) + ' · через ' + svLeftText((at - now) / 1000),
                   'Пробудет до ' + svFormatTime(end) + ' — перебить всю банду') };
    }
    return { cls: 'raid', mark: '!', html: line('raid', 'Банда вот-вот появится у поселения', '') };
  }

  if (stage === 'raid') {
    var total = p.total || t.target || 0;
    var alive = typeof p.alive === 'number' ? p.alive : total;
    // Всех перебили, а сервер ещё не перевёл этап (тик раз в 15 с) — уже отбит
    if (alive === 0 && total > 0) {
      return { cls: 'ok', html: line('ok', 'Налёт отбит', 'Банда разбита — условие выполнено') };
    }
    var span = Math.max(1, Math.round((end - at) / 1000));
    return { cls: 'raid', mark: '!',
      html: line('raid', 'Налёт идёт · банда уйдёт ' + clock(end) +
                 ' · осталось ' + alive + ' из ' + total, '') +
        '<div class="stl-raid-bar"><i data-stl-end="' + stlLocalMs(p.raid_ends) +
          '" data-stl-total="' + span + '" style="width:' +
          Math.max(0, Math.min(100, (now - at) / (end - at) * 100)).toFixed(2) + '%"></i></div>' };
  }

  if (stage === 'defeated') return { cls: 'ok', html: line('ok', 'Налёт отбит', 'Банда разбита — условие выполнено') };
  if (stage === 'escaped') {
    return { cls: 'fail', mark: '✕',
      html: line('fail', 'Банда ушла с добычей', 'Ушло: ' + (p.left || 0) + ' · условие провалено') };
  }
  if (stage === 'cancelled') return { cls: 'ok', html: line('ok', 'Налёт отменён', 'Условие засчитано') };
  if (stage === 'calm') return { cls: 'ok', html: line('ok', 'Налёта не было', 'Условие засчитано') };
  return null;
}

// Не выполнен только налёт, который ещё впереди или идёт: это не провал, а дело на день
function stlOnlyRaidLeft(tasks) {
  var open = tasks.filter(function(t) { return !t.done_now; });
  return open.length > 0 && open.every(function(t) {
    var ms = t.kind === 'marauder' ? stlMarauderState(t) : null;
    return !!ms && (ms.cls === 'wait' || ms.cls === 'raid');
  });
}

// Вкладка «Условия» — прежний список суточных задач с кнопками оплаты
function renderSettlementTasks(pane, st, tasks, hasDev) {
  var doneCount = tasks.filter(function(t) { return t.done_now; }).length;
  var allDone = tasks.length > 0 && doneCount === tasks.length;

  var html = '';

  // Со сводкой развития итоговое довольство и доход живут на первой
  // вкладке; здесь — та часть, что растёт от выполненных условий
  if (hasDev) {
    html += '<div class="stl-base"><span>Довольство от условий</span><b>' + st.satisfaction + '</b></div>' +
      '<div class="stl-track"><i style="width:' + st.satisfaction + '%"></i></div>';
  } else {
    html += stlLegacyTopHtml(st);
  }

  html += '<div class="stl-meta">' +
    'Управляет: ' + escHtml(st.controller || 'не назначен') +
    ' · до итогов ' + formatSettlementLeft(st.seconds_left) +
    '</div>';

  // Итог дня заранее: каждое условие в зачёт (как settlement_task_* на сервере).
  // Налёт, который ещё впереди, — не провал, а дело на вечер
  var onlyRaid = !allDone && stlOnlyRaidLeft(tasks);
  var dayDelta = function(done, total) { return done * STL_GAIN - (total - done) * STL_LOSS + (done === total ? STL_BONUS : 0); };
  var dayNow = dayDelta(doneCount, tasks.length);
  var noRuler = !st.controller;
  html += '<div class="stl-verdict ' + (tasks.length === 0 ? (noRuler ? 'bad' : 'wait') : allDone ? 'good' : onlyRaid ? 'wait' : dayNow >= 0 ? 'wait' : 'bad') + '">' +
    (tasks.length === 0 ? (noRuler ? 'Управляющего нет — условий нет, довольство падает на ' + STL_NO_RULER + ' в сутки'
                                   : 'Условий на эти сутки нет')
      : allDone ? 'Все условия выполнены — довольство +' + dayNow
      : onlyRaid ? 'Выполнено ' + doneCount + ' из ' + tasks.length + ' — отбей налёт: +' +
                   dayDelta(tasks.length, tasks.length) + ', иначе ' + stlSigned(dayNow)
                : 'Выполнено ' + doneCount + ' из ' + tasks.length + ' — к итогам довольство ' + stlSigned(dayNow)) +
    '</div>';
  if (tasks.length) {
    html += '<div class="stl-note un-rule">Каждое выполненное условие +' + STL_GAIN + ', проваленное −' + STL_LOSS +
      ', все — ещё +' + STL_BONUS + '. Налёт отбивает и гарнизон: своих в поселении не меньше, чем налётчиков.</div>';
  }

  pane.innerHTML = html;

  tasks.forEach(function(t) {
    var meta = SETTLEMENT_TASKS[t.kind] || { title: t.kind, hint: '' };

    var row = document.createElement('div');
    // Налёт мародёров: этап (ждём / идёт / отбит / ушли) решает вид строки
    var ms = t.kind === 'marauder' ? stlMarauderState(t) : null;
    row.className = 'stl-task' + (t.done_now ? ' done' : '') + (ms ? ' mar-' + ms.cls : '');

    var payable = (t.kind === 'donation' || t.kind === 'festival');

    row.innerHTML =
      '<div class="stl-task-head">' +
        '<span class="stl-task-title">' +
          (typeof meta.title === 'function' ? meta.title() : meta.title) + '</span>' +
        '<span class="stl-task-mark">' + (ms && ms.mark ? ms.mark : t.done_now ? '✓' : '·') + '</span>' +
      '</div>' +
      (ms ? ms.html
          : '<div class="stl-task-sub">' + (meta.sub ? meta.sub(t.target) : t.target + ' ' + meta.hint) + '</div>');

    // Платные задачи закрываются кнопкой, остальные — делом
    if (payable && !t.done_now && st.is_controller) {
      var btn = document.createElement('button');
      btn.className = 'stl-pay';
      btn.textContent = 'Заплатить ' + t.target;
      btn.addEventListener('click', function() {
        btn.disabled = true;
        supabase.rpc('settlement_pay_task', { p_task_id: t.id }).then(function(res) {
          if (res.error) { alert(gbErr(res.error)); btn.disabled = false; return; }
          loadSettlementPanel();
        });
      });
      row.appendChild(btn);
    }

    pane.appendChild(row);
  });
}

function stlOnClick(e) {
  var el = e.target;
  while (el && el !== e.currentTarget && !el.getAttribute('data-act')) el = el.parentNode;
  if (!el || el === e.currentTarget) return;

  var act = el.getAttribute('data-act');
  var d = stlLast && stlLast.dev;
  var box = document.getElementById('settlement-box');

  if (act === 'tab') {
    var tab = el.getAttribute('data-tab');
    if (tab === stlTab) return;
    stlTab = tab;
    stlPicker = null;
    renderSettlementPanel();
    if (box) box.scrollTop = 0;
    return;
  }

  if (!d || !d.is_controller) return;

  if (act === 'pick') {
    stlPicker = parseInt(el.getAttribute('data-slot'), 10) || null;
    renderSettlementPanel();
    if (box) box.scrollTop = 0;
    return;
  }

  if (act === 'back') {
    stlPicker = null;
    renderSettlementPanel();
    if (box) box.scrollTop = 0;
    return;
  }

  if (act === 'upgrade') {
    if (!d.can_upgrade || !d.next) return;
    var nx = d.next;
    stlAsk({
      tone: 'build',
      kicker: 'Подтверди расширение',
      title: 'Поселение → «' + nx.name + '»',
      sub: 'Уровень ' + (STL_ROMAN[nx.level] || nx.level) +
           (nx.seconds ? ' · стройка ' + stlDur(nx.seconds) : ''),
      rows: [{ label: 'Спишется', items: stlCostItems(nx.credits, nx.resources, d.stock) }],
      note: 'Пока идёт расширение, кварталы работают как обычно.',
      ok: 'Расширить'
    }, function() {
      stlAction(el, 'start_settlement_upgrade', { p_system_id: systemId });
    }, 'Расширить поселение до «' + nx.name + '»?\n\nСтройка займёт ' + stlDur(nx.seconds || 0) + '.');
    return;
  }

  if (act === 'build') {
    var t = stlDistrictType(el.getAttribute('data-id'));
    if (!t || !stlPicker) return;
    var pickSlot = stlPicker;
    stlAsk({
      tone: 'build',
      kicker: 'Подтверди стройку',
      title: t.name,
      image: stlArtSrc(t.id, t.image),
      sub: 'Участок ' + (pickSlot < 10 ? '0' : '') + pickSlot +
           (t.build_seconds ? ' · стройка ' + stlDur(t.build_seconds) : ''),
      rows: [{ label: 'Спишется', items: stlCostItems(t.cost_credits, t.cost_resources, d.stock) }],
      note: 'Если потом снести — вернётся половина кредитов и сырья.',
      ok: 'Заложить'
    }, function() {
      stlAction(el, 'build_district', { p_system_id: systemId, p_slot: pickSlot, p_district: t.id });
    }, 'Заложить «' + t.name + '» на участке ' + pickSlot + '?');
    return;
  }

  if (act === 'demolish') {
    var slot = parseInt(el.getAttribute('data-slot'), 10);
    var x = (d.districts || []).filter(function(q) { return q.slot === slot; })[0];
    if (!x) return;
    var xt = stlDistrictType(x.id) || {};
    var doDemolish = function() {
      stlAction(el, 'demolish_district', { p_system_id: systemId, p_slot: slot });
    };
    if (!gcReady()) {
      if (confirm('Снести «' + (x.name || xt.name) + '» на участке ' + slot + '?')) doDemolish();
      return;
    }
    loadPlanetStock(function() {
      // Панель закрыли, пока грузился склад — окно не всплывает само по себе
      var sp = document.getElementById('settlement-panel');
      if (!sp || sp.style.display === 'none') return;
      // Снесённые склады перестают расширять предел ещё до возврата сырья
      var drop = (x.id === 'warehouses' && !(x.building && x.seconds_left > 0))
        ? Number(xt.effect_value) || 0 : 0;
      var r = gcRefund(Math.floor((xt.cost_credits || 0) / 2), xt.cost_resources, 1, 2, drop);
      gameConfirm({
        tone: 'danger',
        kicker: 'Подтверди снос',
        title: x.name || xt.name || 'Квартал',
        image: stlArtSrc(x.id, xt.image),
        sub: 'Участок ' + (slot < 10 ? '0' : '') + slot,
        rows: [{ label: 'Вернётся', dir: 'in', items: r.items }],
        warn: gcJoin(gcCapWarn(drop), gcLostWarn(r)),
        note: 'Квартал исчезнет сразу вместе со своим эффектом — отменить снос нельзя.',
        ok: 'Снести'
      }, doDemolish);
    });
  }
}

// Цена квартала или расширения: склад поселения приходит вместе с панелью
function stlCostItems(credits, res, stock) {
  var items = [];
  if (credits) items.push({ kind: 'credits', text: credits + ' кр.' });
  for (var k in (res || {})) {
    if (!Object.prototype.hasOwnProperty.call(res, k)) continue;
    var need = Number(res[k]) || 0;
    if (!need) continue;
    items.push({
      text: resourceName(k) + ' ' + need,
      color: gcResColor(k),
      bad: !!stock && (Number(stock[k]) || 0) < need
    });
  }
  return items;
}

// Окно подтверждения, а без него — прежний системный вопрос
function stlAsk(o, go, plain) {
  if (gcReady()) { gameConfirm(o, go); return; }
  if (confirm(plain)) go();
}

function stlAction(btn, fn, args) {
  if (stlBusy) return;
  stlBusy = true;
  btn.disabled = true;
  btn.classList.add('busy');

  stlSafe(supabase.rpc(fn, args)).then(function(res) {
    stlBusy = false;
    if (res.error) {
      btn.disabled = false;
      btn.classList.remove('busy');
      alert(gbErr(res.error));
      return;
    }
    stlPicker = null;
    loadSettlementPanel();
  });
}

// Раз в секунду: отсчёты и полосы прогресса без запросов к базе.
// Отсчёт дошёл до нуля — один раз просим свежие данные, не дожидаясь
// планового обновления.
function stlTick() {
  var body = document.getElementById('settlement-body');
  if (!body) return;
  var now = Date.now();
  var expired = false;

  var els = body.querySelectorAll('[data-stl-end]');
  for (var i = 0; i < els.length; i++) {
    var el = els[i];
    var end = Number(el.getAttribute('data-stl-end')) || 0;
    var left = Math.max(0, (end - now) / 1000);
    if (left <= 0 && end && !stlExpiredEnds[end]) { stlExpiredEnds[end] = true; expired = true; }

    if (el.hasAttribute('data-stl-total')) {
      var total = Number(el.getAttribute('data-stl-total')) || 0;
      var pct = total > 0 ? Math.max(0, Math.min(100, (1 - left / total) * 100)) : 0;
      el.style.width = pct.toFixed(2) + '%';
    } else {
      el.textContent = formatSettlementClock(left);
    }
  }

  if (expired) loadSettlementPanel();
}

// Сколько экрана занято панелями снизу: карта должна уметь подняться
// над ними, иначе нижние ряды остаются недосягаемыми
var uiBottomInset = 0;

// ===== Время =====
// Часы сверяем с сервером один раз при загрузке: отсчёты панелей идут локально
var gbTimeOffset = 0;

// Текст ошибки для игрока: отказы функций базы — как есть (они по-русски), внутренние ошибки
// (англ. «violates…», сбой сети) — понятным текстом (gameErr из js/err-report.js)
function gbErr(e) {
  if (typeof gameErr === 'function') return gameErr(e);
  return (e && e.message) || 'Не удалось — попробуй ещё раз';
}

function gbServerNow() {
  return Date.now() + gbTimeOffset;
}

function syncGroundTime() {
  return supabase.rpc('get_server_time').then(function(res) {
    if (!res.error && res.data) {
      gbTimeOffset = new Date(res.data).getTime() - Date.now();
    }
  });
}

// Снизу открыта панель: фокус камеры (GL.focusCell) ставит клетку над ней
function setBottomInset(px) {
  uiBottomInset = px;
}

function insetFor(el) {
  if (!el) return 0;
  var r = el.getBoundingClientRect();
  if (!r.height) return 0;
  return Math.max(0, window.innerHeight - r.top + 8);
}

function focusCell(cx, cy) {
  GL.focusCell(cx, cy);
}
var systemFaction = null;
var buildingsBySlot = {};  // slot_index(1..N) -> запись из buildings (с подставленным building_type)
var buildingTypes = [];    // справочник типов построек
var currentUserFaction = null;
var buildingImages = {};   // путь -> Image, чтобы не грузить одну картинку дважды
var redrawTimer = null;    // пока идёт стройка, обновляем таймер раз в секунду

// Картинки зданий грузим один раз и переиспользуем. Пока не загрузилась —
// рисуем заглушку, а после загрузки перерисовываем сцену.
function getBuildingImage(path) {
  if (!path) return null;
  if (buildingImages[path]) return buildingImages[path];

  var img = new Image();
  img.src = '../' + path;
  img.onerror = function() { img.failed = true; };
  buildingImages[path] = img;
  return img;
}
var currentUserId = null;
var isController = false;  // может ли текущий игрок строить на этой планете

function getSystemIdFromUrl() {
  var params = new URLSearchParams(window.location.search);
  return params.get('system');
}

function isBuildMode() {
  var params = new URLSearchParams(window.location.search);
  return params.get('mode') === 'build';
}

// Простой детерминированный хэш строки -> число, для сида генератора
function hashStringToSeed(str) {
  var h = 0;
  for (var i = 0; i < str.length; i++) {
    h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  }
  return h >>> 0;
}

// Малберри32 — маленький быстрый seeded PRNG
function mulberry32(seed) {
  var a = seed;
  return function() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    var t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Генерирует позиции 7 слотов построек в верхней части карты, вразброс,
// но не слишком далеко друг от друга (минимальная и максимальная дистанция
// от "центра кластера" одновременно). Отдельный сид от рельефа, чтобы
// не зависеть от того, сколько случайных чисел потратил генератор рельефа.
function generateBuildSlots(seed) {
  var rand = mulberry32(seed ^ 0x9E3779B9);
  var slots = [];

  // Начинаем ниже верхнего края: там теперь стоят зоны высадки.
  var bandTop = 13;
  var bandBottom = Math.floor(GRID_SIZE * 0.34) - SLOT_SIZE;
  var minDist = 9;   // минимальная дистанция между слотами (с запасом на размер 6x6)
  var maxDist = 34;  // максимальная дистанция от первого слота (кластер, не в разброс по всей карте)

  var firstX = Math.min(GRID_SIZE - SLOT_SIZE - 2, Math.floor(GRID_SIZE * 0.3 + rand() * GRID_SIZE * 0.4));
  var firstY = bandTop + Math.floor(rand() * (bandBottom - bandTop));
  slots.push({ x: firstX, y: firstY });

  var attempts = 0;
  while (slots.length < SLOT_COUNT && attempts < 500) {
    attempts++;
    var x = Math.max(2, Math.min(GRID_SIZE - SLOT_SIZE - 2, Math.floor(rand() * GRID_SIZE)));
    var y = bandTop + Math.floor(rand() * (bandBottom - bandTop));

    var okDistance = true;
    for (var i = 0; i < slots.length; i++) {
      var dx = slots[i].x - x;
      var dy = slots[i].y - y;
      var d = Math.sqrt(dx * dx + dy * dy);
      if (d < minDist) { okDistance = false; break; }
    }

    var dxFirst = firstX - x;
    var dyFirst = firstY - y;
    var distFromFirst = Math.sqrt(dxFirst * dxFirst + dyFirst * dyFirst);

    if (okDistance && distFromFirst <= maxDist) {
      slots.push({ x: x, y: y });
    }
  }

  // если за 500 попыток не набрали 7 (маловероятно) — дозаполняем без строгой проверки дистанции
  while (slots.length < SLOT_COUNT) {
    var fx2 = Math.max(2, Math.min(GRID_SIZE - SLOT_SIZE - 2, Math.floor(rand() * GRID_SIZE)));
    var fy2 = bandTop + Math.floor(rand() * (bandBottom - bandTop));
    slots.push({ x: fx2, y: fy2 });
  }

  return slots;
}

// Зона высадки живёт в нижней части карты, а слоты построек — в верхней,
// поэтому пересечься они не могут в принципе, отдельная проверка не нужна.
// Зоны приходят из БД — там же их проверяет сервер при размещении войск,
// поэтому клиент их не выдумывает, а только рисует.
function loadDeployZones() {
  return supabase.from('deploy_zones').select('*').eq('system_id', systemId).then(function(res) {
    deployZones = (res.error || !res.data) ? [] : res.data;
  });
}

// Настройки тянем отдельным запросом и ничего им не блокируем: до ответа
// работает значение по умолчанию, полоса просто перерисуется, если в базе
// стоит другая высота.
// Обороняющемуся полосу вторжения не показываем: иначе он увидит,
// где выстроен десант, и будет ждать на месте высадки
function loadGroundSides() {
  return supabase.auth.getSession().then(function(res) {
    if (!res.data.session) return;
    return Promise.all([
      supabase.from('profiles').select('faction').eq('id', res.data.session.user.id).maybeSingle(),
      supabase.from('systems').select('faction').eq('id', systemId).maybeSingle()
    ]).then(function(r) {
      // Обе фракции читаем до первого использования: раньше sysFaction
      // присваивался выше объявления sys и из-за подъёма переменной
      // всегда получал undefined — трофейные постройки не распознавались.
      var mine = r[0].data && r[0].data.faction;
      var sys = r[1].data && r[1].data.faction;

      myFaction = mine || null;
      sysFaction = sys || null;

      if (!mine) return;
      iAmAttacker = (sys !== mine);

      // Сторона приходит отдельным запросом и может опоздать за грузом:
      // открытый лоток пересчитывает, куда высаживать
      updateDropBtn();
    });
  });
}

function loadGroundSettings() {
  return supabase.from('game_settings').select('key, value').then(function(res) {
    if (res.error || !res.data) return;
    res.data.forEach(function(row) {
      if (row.key === 'ground_attack_zone_height') {
        ATTACK_ZONE_H = parseInt(row.value, 10) || 4;
      }
    });
  });
}

// ===== Камера =====
// Холст и камеру ведёт бой 2.0 (ground/ground.js); scale/panX/panY ему в тон
// подставляет js/ground-live.js. Своей плотности пикселей у старых панелей нет.
var gbDpr = 1;

// Сколько пикселей экрана (физических) приходится на пиксель поля
function gbScaleK() {
  return scale * gbDpr;
}

// ===== Чёткие картинки на любом масштабе =====
// Исходники крупные (512–1024 px), а на экране боец занимает от десятка
// до пары сотен точек. Ужимать большой файл в каждом кадре дорого и даёт
// «зубчики» на отдалении. Держим уменьшенные копии ступенями 32…512 (каждая
// получена из вдвое большей — так уменьшение остаётся гладким) и рисуем
// ближайшую не меньше нужного. На приближении берётся сам исходник.
var gbMipCache = {};
// Выше 256 точек копии не держим: столько боец занимает на экране только
// на самом крупном зуме, а там лучше рисовать прямо из исходника
var GB_MIP_STEPS = [32, 64, 128, 256];

function gbMip(img, sx, sy, sw, sh, step, key) {
  var set = gbMipCache[key] || (gbMipCache[key] = {});
  if (set[step]) return set[step];
  var srcMax = Math.max(sw, sh);
  var r = step / srcMax;
  var c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(sw * r));
  c.height = Math.max(1, Math.round(sh * r));
  var g = c.getContext('2d');
  g.imageSmoothingEnabled = true;
  if ('imageSmoothingQuality' in g) g.imageSmoothingQuality = 'high';
  // Из вдвое большей копии уменьшение глаже, но ради неё не строим всю
  // лестницу: нет готовой — берём исходник (качество «high» его вытянет)
  var big = set[step * 2];
  if (big) {
    g.drawImage(big, 0, 0, big.width, big.height, 0, 0, c.width, c.height);
  } else {
    g.drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height);
  }
  set[step] = c;
  return c;
}

function gbDrawSprite(img, sx, sy, sw, sh, dx, dy, dw, dh) {
  var need = Math.max(dw, dh) * gbScaleK();
  var srcMax = Math.max(sw, sh);
  var step = 0;
  for (var i = 0; i < GB_MIP_STEPS.length; i++) {
    if (GB_MIP_STEPS[i] >= need) { step = GB_MIP_STEPS[i]; break; }
  }
  if (!step || step * 1.5 >= srcMax) {
    ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
    return;
  }
  var c = gbMip(img, sx, sy, sw, sh, step, img.src + '|' + sx + ',' + sy + ',' + sw + ',' + sh);
  ctx.drawImage(c, 0, 0, c.width, c.height, dx, dy, dw, dh);
}

// Вся картинка целиком — частный случай
function gbDrawImage(img, dx, dy, dw, dh) {
  gbDrawSprite(img, 0, 0, img.naturalWidth, img.naturalHeight, dx, dy, dw, dh);
}

// ===== Участки под здания на карте (рисуются через GD_DRAW) =====
function drawBuildSlots() {
  var now = gbServerNow();

  for (var i = 0; i < buildSlots.length; i++) {
    var slot = buildSlots[i];
    var slotIndex = i + 1;
    var px = slot.x * CELL_PX;
    var py = slot.y * CELL_PX;
    var size = SLOT_SIZE * CELL_PX;

    var building = buildingsBySlot[slotIndex];

    if (!building) {
      // Вне режима стройки пустые слоты не показываем — на обычной карте
      // должны быть видны только реально существующие здания.
      if (!buildMode) continue;

      // Участок ещё закрыт: его откроет рост поселения. Рисуем приглушённо,
      // с номером нужного уровня — видно, ради чего расширять поселение.
      if (slot.locked) {
        drawLockedSlot(slot, px, py, size);
        continue;
      }

      ctx.fillStyle = 'rgba(120,170,220,0.15)';
      ctx.fillRect(px, py, size, size);
      ctx.strokeStyle = 'rgba(120,170,220,0.6)';
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 4]);
      ctx.strokeRect(px, py, size, size);
      ctx.setLineDash([]);
      continue;
    }

    var type = building.building_types || {};
    var img = getBuildingImage(type.image);
    var ready = !building.completes_at || new Date(building.completes_at).getTime() <= now;

    if (img && img.complete && !img.failed && img.naturalWidth > 0) {
      ctx.save();
      if (!ready) ctx.globalAlpha = 0.45; // недостроенное здание бледнее
      gbDrawImage(img, px, py, size, size);
      ctx.restore();
    } else {
      // картинки нет или ещё грузится — заглушка с символом
      ctx.fillStyle = 'rgba(217,169,64,0.35)';
      ctx.fillRect(px, py, size, size);
      ctx.fillStyle = '#0a0d14';
      ctx.font = (size * 0.4) + 'px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(type.icon || '■', px + size / 2, py + size / 2);
    }

    ctx.strokeStyle = ready ? '#d9a940' : 'rgba(120,170,220,0.9)';
    ctx.lineWidth = 2;
    ctx.strokeRect(px, py, size, size);

    if (!ready) {
      drawConstructionProgress(building, px, py, size, now);
    }
  }
}

function drawLockedSlot(slot, px, py, size) {
  ctx.fillStyle = 'rgba(10,13,20,0.42)';
  ctx.fillRect(px, py, size, size);
  ctx.strokeStyle = 'rgba(143,168,196,0.38)';
  ctx.lineWidth = 2;
  ctx.setLineDash([3, 6]);
  ctx.strokeRect(px, py, size, size);
  ctx.setLineDash([]);

  // Замок: дужка и корпус, без шрифтовых значков — они на телефонах разные
  var cx = px + size / 2, cy = py + size * 0.42, u = size * 0.07;
  ctx.strokeStyle = 'rgba(217,169,64,0.75)';
  ctx.lineWidth = Math.max(2, u * 0.55);
  ctx.beginPath();
  ctx.arc(cx, cy - u * 0.4, u * 1.15, Math.PI, 0);
  ctx.stroke();
  ctx.fillStyle = 'rgba(217,169,64,0.75)';
  ctx.fillRect(cx - u * 1.7, cy - u * 0.4, u * 3.4, u * 2.6);

  ctx.fillStyle = 'rgba(207,216,220,0.8)';
  ctx.font = Math.round(size * 0.13) + 'px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText('уровень ' + (STL_ROMAN[slot.need_level] || slot.need_level || '?'), cx, py + size * 0.68);
}

// Полоса прогресса и обратный отсчёт на строящемся здании.
function drawConstructionProgress(building, px, py, size, now) {
  var endMs = new Date(building.completes_at).getTime();
  var startMs = new Date(building.built_at).getTime();
  var total = endMs - startMs;
  var progress = total > 0 ? (now - startMs) / total : 1;
  if (progress < 0) progress = 0;
  if (progress > 1) progress = 1;

  var barH = Math.max(4, size * 0.06);
  var barY = py + size - barH - 4;

  ctx.fillStyle = 'rgba(5,6,10,0.75)';
  ctx.fillRect(px + 4, barY, size - 8, barH);
  ctx.fillStyle = '#4a90d9';
  ctx.fillRect(px + 4, barY, (size - 8) * progress, barH);

  var left = Math.max(0, Math.ceil((endMs - now) / 1000));
  var mm = Math.floor(left / 60);
  var ss = left % 60;
  var label = mm > 0 ? (mm + ':' + (ss < 10 ? '0' : '') + ss) : (ss + 'с');

  ctx.fillStyle = '#cfd8dc';
  ctx.font = Math.round(size * 0.16) + 'px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillText(label, px + size / 2, barY - 4);
}

function onSlotTapped(slotIndex) {
  var existing = buildingsBySlot[slotIndex];
  if (existing) {
    var ready = !existing.completes_at || new Date(existing.completes_at).getTime() <= gbServerNow();
    var mine = existing.owner_user_id === currentUserId;

    var code = (existing.building_types || {}).code;

    // Арендатор: тап по сданному ему зданию сразу открывает найм.
    // Кэш мог устареть — карточка постройки перечитает аренду сама.
    if (!buildMode && ready && !mine && typeof plIsTenant === 'function' &&
        plIsTenant(plLeaseOf(gbLeaseMap, existing.id))) {
      openUnitPanel(existing);
      return;
    }
    var isLab = code === 'rep_research' || code === 'cis_lab';
    var isHub = code === 'rep_logistics' || code === 'cis_logistics';
    var isTrade = code === 'rep_trade' || code === 'cis_trade';
    var isEconomy = isEconomyBuilding(code);
    var isDepot = code === 'rep_depot' || code === 'cis_depot';
    // Хаб, пост и склад работают на планету: их открывает и хозяин планеты, даже если строил не он.
    // Трофейные (старой фракции) не работают — захватчик их сносит, поэтому для них только карточка.
    var planetSvc = isHub || isTrade || isDepot;
    var alien = sysFaction && existing.faction && existing.faction !== sysFaction;

    // В обычном режиме тап по своему готовому зданию открывает его занятие:
    // у казармы это наём, у научного центра — исследования. Карточка
    // со сносом остаётся в режиме стройки.
    if (!buildMode && ready && (mine || (planetSvc && isController)) && !(planetSvc && alien)) {
      if (isLab) openResearchPanel(existing);
      // Хаб — вход в общий экран «Снабжение» (рейсы, склады, рынок) от этой планеты
      else if (isHub && typeof openSupplyScreen === 'function') openSupplyScreen('routes', { hub: existing.system_id || systemId });
      else if (isTrade) openTradePanel(existing);
      // добыча — участок с бригадой и сменами (js/mine-site.js), остальное хозяйство — окно экономики
      else if (isEconomy && typeof openMineSite === 'function' && isMineBuilding(code)) openMineSite(existing);
      else if (isEconomy) openEconomyPanel(existing);
      else openUnitPanel(existing);
    } else {
      openBuildingInfo(existing);
    }
    return;
  }

  if (!isController) {
    alert('У тебя нет прав на строительство на этой планете');
    return;
  }

  var slot = buildSlots[slotIndex - 1];
  if (slot && slot.locked) {
    alert('Участок откроется, когда поселение станет «' + (slot.need_name || 'больше') + '»' +
          ' (уровень ' + (STL_ROMAN[slot.need_level] || slot.need_level) + ').\n\n' +
          'Расширяет поселение управляющий — в окне поселения.');
    return;
  }

  openBuildPanel(slotIndex);
}

// Карточка существующей постройки: название и снос за половину стоимости
// (возврат считается на сервере функцией demolish_building, клиент не может
// подменить сумму возврата).
var buildingInfoSeq = 0;        // какая карточка открыта: поздние ответы к чужой не липнут
var buildingDemolishBusy = false;

function buildingInfoShown() {
  var p = document.getElementById('building-info-panel');
  return !!p && p.style.display !== 'none';
}

function openBuildingInfo(building) {
  var seq = ++buildingInfoSeq;
  var panel = document.getElementById('building-info-panel');
  var nameEl = document.getElementById('building-info-name');
  var refundEl = document.getElementById('building-info-refund');
  var demolishBtn = document.getElementById('building-info-demolish');

  var type = building.building_types || {};
  nameEl.textContent = type.name || 'Постройка';

  // Трофейная постройка: её фракция разошлась с фракцией планеты
  var captured = sysFaction && building.faction && building.faction !== sysFaction;
  var half = Math.floor((type.cost || 0) / 2);

  if (captured && isController) {
    refundEl.textContent = 'Трофейная постройка. Снос обойдётся в ' + half;
    refundEl.style.display = 'block';
  } else if (isController) {
    var fullType = buildingTypeByCode(type.code);
    var hasRes = fullType && fullType.cost_resources && Object.keys(fullType.cost_resources).length > 0;
    refundEl.textContent = 'При сносе вернётся: ' + half + ' кр.' + (hasRes ? ' и половина сырья' : '');
    refundEl.style.display = 'block';
  } else {
    refundEl.textContent = '';
    refundEl.style.display = 'none';
  }

  // Научный центр открывает исследования: это его единственное занятие,
  // поэтому кнопка ведёт прямо в каталог
  var researchBtn = document.getElementById('building-info-research');
  var isLab = type.code === 'rep_research' || type.code === 'cis_lab';

  if (researchBtn) {
    researchBtn.style.display = (isLab && isController && !captured) ? 'block' : 'none';
    researchBtn.onclick = function() {
      closeBuildingInfo();
      openResearchPanel(building);
    };
  }

  demolishBtn.style.display = isController ? 'block' : 'none';
  demolishBtn.disabled = buildingDemolishBusy;

  gbPaintBuildingLease(building, seq, captured);
  demolishBtn.onclick = function() {
    if (demolishBtn.disabled || buildingDemolishBusy) return;
    askDemolishBuilding(building, captured && isController, function() {
      if (buildingDemolishBusy) return;
      buildingDemolishBusy = true;
      demolishBtn.disabled = true;
      var finish = function() {
        buildingDemolishBusy = false;
        demolishBtn.disabled = false;
        // Закрываем только свою карточку, а не ту, что открыли следом
        if (seq === buildingInfoSeq) closeBuildingInfo();
      };
      supabase.rpc('demolish_building', { p_building_id: building.id }).then(function(res) {
        finish();
        if (res.error) {
          alert('Не удалось снести: ' + gbErr(res.error));
          return;
        }
        loadBuildings();
        // Возвращённое сырьё сразу видно в полосе запаса при следующей стройке
        loadPlanetStock();
      }, function(e) {
        finish();
        alert('Не удалось снести: ' + ((e && e.message) || 'нет связи с сервером'));
      });
    });
  };

  panel.style.display = 'flex';
}

// ===== Исследования =====
// Каталог личный: изученное принадлежит игроку, а не фракции. Ступени
// идут по порядку, вторая без первой не берётся.

var researchBuilding = null;
var researchTimer = null;
var researchShip = null;        // по какому кораблю смотрим ветку
var researchShipNames = {};

function openResearchPanel(building) {
  researchBuilding = building;

  var panel = document.getElementById('research-panel');
  if (!panel) return;

  panel.style.display = 'flex';
  document.getElementById('research-list').innerHTML =
    '<div class="rs-empty">Загрузка…</div>';

  researchActiveId = null;
  researchActiveKey = null;
  loadResearchPanel();

  if (researchTimer) clearInterval(researchTimer);
  researchTimer = setInterval(loadResearchPanel, 5000);
  if (researchTickTimer) clearInterval(researchTickTimer);
  researchTickTimer = setInterval(researchTick, 1000);
}

function closeResearchPanel() {
  var panel = document.getElementById('research-panel');
  if (panel) panel.style.display = 'none';
  if (researchTimer) { clearInterval(researchTimer); researchTimer = null; }
  if (researchTickTimer) { clearInterval(researchTickTimer); researchTickTimer = null; }
}

// Готовое по времени сервер выдаёт на тике раз в 30 секунд. Чтобы таймер
// не стоял на нуле всё это время, клиент сам просит выдать своё готовое.
// Один запрос за раз и не чаще раза в три секунды. Промис отдаёт true,
// если запрос действительно ушёл: только тогда есть смысл перечитывать —
// иначе застрявший заказ (нет места в зоне высадки) крутил бы перечитку
// без остановки.
var claimInFlight = null;
var claimLastAt = 0;

function claimReadyNow() {
  if (claimInFlight) return claimInFlight;
  if (Date.now() - claimLastAt < 3000) return Promise.resolve(false);
  claimLastAt = Date.now();
  claimInFlight = supabase.rpc('claim_ready_now').then(
    function() { claimInFlight = null; return true; },
    function() { claimInFlight = null; return true; });
  return claimInFlight;
}

// Секунды идут локально между опросами: раньше цифра менялась раз
// в 5 секунд, а на нуле стояла до выдачи на сервере
var researchTickTimer = null;
var researchActiveId = null;    // открытое описание
var researchActiveKey = null;   // его состояние: перерисовываем только при смене

function researchTick() {
  var now = Date.now();
  var due = false;

  var tiles = document.querySelectorAll('#research-list .rs-tile[data-until]');
  for (var i = 0; i < tiles.length; i++) {
    var left = Math.max(0, Math.ceil((parseInt(tiles[i].getAttribute('data-until'), 10) - now) / 1000));
    var note = tiles[i].querySelector('.rs-note');
    if (note) note.textContent = left > 0 ? formatResearchLeft(left) : 'готово';
    if (left <= 0) due = true;
  }

  var infoLeft = document.getElementById('rs-info-left');
  if (infoLeft && infoLeft.getAttribute('data-until')) {
    var l2 = Math.max(0, Math.ceil((parseInt(infoLeft.getAttribute('data-until'), 10) - now) / 1000));
    infoLeft.textContent = l2 > 0 ? 'Изучается: ' + formatResearchLeft(l2) : 'Готово, записываем…';
  }

  if (due) claimReadyNow().then(function(sent) { if (sent) loadResearchPanel(); });
}

function formatResearchLeft(sec) {
  if (sec >= 60) return Math.floor(sec / 60) + ' мин ' + (sec % 60) + ' с';
  return sec + ' с';
}

// Названия техники для веток каталога не меняются — берём один раз,
// а не каждые 5 секунд вместе со списком исследований
var researchNamesLoaded = false;

function loadResearchPanel() {
  Promise.all([
    supabase.rpc('get_researches'),
    researchNamesLoaded ? Promise.resolve({ data: [] }) : supabase.from('ship_types').select('id, name').eq('is_fighter', false),
    researchNamesLoaded ? Promise.resolve({ data: [] }) : supabase.from('unit_types').select('id, name')
  ]).then(function(r) {
    if (!r[1].error && !r[2].error && (r[1].data || []).length && (r[2].data || []).length) researchNamesLoaded = true;
    var res = r[0];
    var list = document.getElementById('research-list');
    if (!list) return;

    if (res.error) {
      list.innerHTML = '<div class="rs-empty">Ошибка: ' + gbErr(res.error) + '</div>';
      return;
    }

    (r[1].data || []).forEach(function(t) { researchShipNames[t.id] = t.name; });
    (r[2].data || []).forEach(function(t) { researchShipNames[t.id] = t.name; });

    var all = res.data || [];

    // Ветки принадлежат конкретной технике — кораблю или бойцу. Показывать
    // их одним списком нельзя: каталог превратится в свалку, где половина
    // строк не относится к тому, что игрок собирается строить.
    var ships = [];
    all.forEach(function(x) {
      (x.applies_to || []).concat(x.applies_units || []).forEach(function(sid) {
        if (ships.indexOf(sid) === -1) ships.push(sid);
      });
    });

    if (!researchShip || ships.indexOf(researchShip) === -1) researchShip = ships[0] || null;

    var rows = all.filter(function(x) {
      return (x.applies_to || []).indexOf(researchShip) !== -1
          || (x.applies_units || []).indexOf(researchShip) !== -1;
    });

    list.innerHTML = '';

    if (ships.length > 1) {
      var picker = document.createElement('div');
      picker.className = 'rs-ships';

      ships.forEach(function(sid) {
        var b = document.createElement('button');
        b.className = 'rs-ship' + (sid === researchShip ? ' active' : '');
        b.textContent = researchShipNames[sid] || sid;
        b.addEventListener('click', function() {
          researchShip = sid;
          loadResearchPanel();
        });
        picker.appendChild(b);
      });

      list.appendChild(picker);
    }

    // Группируем по разделам, как в исходном списке
    var order = [];
    var byCat = {};
    rows.forEach(function(r) {
      if (!byCat[r.category]) { byCat[r.category] = []; order.push(r.category); }
      byCat[r.category].push(r);
    });

    // Строим цепочки: у каждой ветки корень и то, что из него растёт.
    // Так видно путь целиком, а не набор разрозненных плиток.
    var byId = {};
    rows.forEach(function(r) { byId[r.id] = r; });

    var childOf = {};
    rows.forEach(function(r) {
      var parent = null;
      // Предшественник известен по названию: сверяем с каталогом
      rows.forEach(function(o) { if (o.name === r.requires_name) parent = o.id; });
      if (parent) {
        if (!childOf[parent]) childOf[parent] = [];
        childOf[parent].push(r);
      }
      r._parent = parent;
    });

    order.forEach(function(cat) {
      var head = document.createElement('div');
      head.className = 'rs-cat';
      head.textContent = cat;
      list.appendChild(head);

      byCat[cat].filter(function(r) { return !r._parent; }).forEach(function(root) {
        var chain = document.createElement('div');
        chain.className = 'rs-chain';

        var addTile = function(r, last) {
          chain.appendChild(makeResearchTile(r));
          if (!last) {
            var arrow = document.createElement('span');
            arrow.className = 'rs-arrow';
            arrow.textContent = '›';
            chain.appendChild(arrow);
          }
        };

        var line = [root];
        var cur = root;
        while (childOf[cur.id] && childOf[cur.id].length) {
          cur = childOf[cur.id][0];
          line.push(cur);
        }

        line.forEach(function(r, i) { addTile(r, i === line.length - 1); });
        list.appendChild(chain);

        // Ветки, отходящие вбок, ставим отдельной строкой под цепочкой
        line.forEach(function(r) {
          var kids = (childOf[r.id] || []).slice(1);
          kids.forEach(function(k) {
            var branch = document.createElement('div');
            branch.className = 'rs-chain branch';
            var from = document.createElement('span');
            from.className = 'rs-arrow';
            from.textContent = '↳';
            branch.appendChild(from);
            branch.appendChild(makeResearchTile(k));
            list.appendChild(branch);
          });
        });
      });
    });

    // Открытое описание живёт дальше: подсветку возвращаем, а текст
    // меняем, только если исследование сменило состояние — иначе опрос
    // раз в 5 секунд выбивал бы кнопку «Изучить» из-под пальца
    if (researchActiveId) {
      var cur = byId[researchActiveId];
      var tile = list.querySelector('.rs-tile[data-id="' + researchActiveId + '"]');
      if (cur && tile) {
        tile.classList.add('active');
        if (researchStateKey(cur) !== researchActiveKey) showResearchInfo(cur, tile);
      }
    }
  });
}

function researchStateKey(r) {
  return (r.done ? 'd' : '') + (r.in_progress ? 'p' : '') + (r.available ? 'a' : '');
}

function makeResearchTile(r) {
  var tile = document.createElement('button');
  tile.className = 'rs-tile' +
    (r.done ? ' done' : '') +
    (r.in_progress ? ' busy' : '') +
    (!r.available && !r.done ? ' locked' : '');
  tile.setAttribute('data-id', r.id);
  if (r.in_progress) tile.setAttribute('data-until', String(Date.now() + (r.seconds_left || 0) * 1000));

  tile.innerHTML =
    '<img class="rs-icon" src="../' + r.icon_image + '" alt="">' +
    '<span class="rs-name">' + r.name + '</span>' +
    '<span class="rs-note">' +
      (r.done ? 'изучено'
       : r.in_progress ? (r.seconds_left > 0 ? formatResearchLeft(r.seconds_left) : 'готово')
       : !r.available ? 'закрыто'
       : r.cost + ' кр') +
    '</span>';

  tile.addEventListener('click', function() { showResearchInfo(r, tile); });
  return tile;
}

function showResearchInfo(r, tile) {
  var info = document.getElementById('research-info');
  if (!info) return;

  var all = document.querySelectorAll('.rs-tile');
  for (var i = 0; i < all.length; i++) all[i].classList.remove('active');
  tile.classList.add('active');
  researchActiveId = r.id;
  researchActiveKey = researchStateKey(r);

  info.innerHTML =
    '<div class="rs-info-name">' + r.name + '</div>' +
    '<div class="rs-info-text">' + r.description + '</div>' +
    '<div class="rs-info-meta">' + researchEffectText(r) + '</div>';

  if (r.done) {
    info.innerHTML += '<div class="rs-info-meta ok">' +
      (r.effect_kind === 'unlock_structure' ? 'Изучено — инженер может строить'
       : r.scope === 'unit' ? 'Изучено — можно брать при найме'
       : 'Изучено — можно ставить на новые корабли') + '</div>';
    return;
  }

  if (r.in_progress) {
    info.innerHTML += '<div class="rs-info-meta warn" id="rs-info-left" data-until="' +
      (Date.now() + (r.seconds_left || 0) * 1000) + '">' +
      (r.seconds_left > 0 ? 'Изучается: ' + formatResearchLeft(r.seconds_left) : 'Готово, записываем…') +
      '</div>';
    return;
  }

  if (!r.available) {
    info.innerHTML += '<div class="rs-info-meta warn">Сначала: ' + (r.requires_name || '') + '</div>';
    return;
  }

  var go = document.createElement('button');
  go.className = 'rs-go';
  go.textContent = 'Изучить · ' + r.cost;
  go.addEventListener('click', function() {
    go.disabled = true;
    supabase.rpc('start_research', {
      p_building_id: researchBuilding.id, p_research_id: r.id
    }).then(function(res) {
      if (res.error) { alert(gbErr(res.error)); go.disabled = false; return; }
      loadResearchPanel();
      info.innerHTML = '<div class="rs-info-meta ok">Исследование запущено</div>';
    });
  });
  info.appendChild(go);
}

// Человеческое описание эффекта: из вида и величины
function researchEffectText(r) {
  var v = r.effect_value;
  var d = r.ability_damage;

  switch (r.effect_kind) {
    case 'hp':           return '+' + v + ' к прочности';
    case 'hp_slow':      return '+' + v + ' к прочности, −1 к дальности хода';
    case 'move':         return '+' + v + ' к дальности хода';
    case 'weapon_range': return '+' + v + ' к дальности атаки';

    case 'ability_grenade':
      return 'урон ' + d + ' по области ' + v + '×' + v;
    case 'ability_he':
      return 'урон ' + d + ' по области ' + v + '×' + v + ', только по пехоте';
    case 'ability_suppression':
      return 'урон ' + d + ' по области ' + v + '×' + v + ' и залегание: цель не ходит и не стреляет';
    case 'ability_stun':
      return v >= 100 ? 'оглушает цель наверняка' : 'шанс ' + v + '% оглушить цель';
    case 'ability_ap':   return 'двойной урон по технике';
    case 'ability_headshot': return 'уничтожает выбранную цель';
    case 'ability_twin':
      return 'бьёт первую цель, вторую рядом с шансом ' + v + '%';
    case 'ability_lunge':
      return 'рывок к врагу до ' + v + ' клеток и удар клинком · урон ' + d + ', укрытие не спасает';
    case 'unlock_structure':
      return structUnlockText(r);
  }

  switch (r.effect_kind) {
    case 'hull':        return '+' + v + ' к прочности';
    case 'shield':      return '+' + v + ' к щитам всех секторов';
    case 'fore_shield': return '+' + v + ' к носовому щиту';
    case 'damage':      return '+' + v + ' к урону';
    case 'vision':      return '+' + v + ' к дальности обзора';
    case 'move':        return '+' + v + ' к дальности хода';
    case 'hangar':      return '+' + v + ' к местам в ангаре';
    case 'capacity':    return '+' + v + ' к вместимости трюма';
    case 'tractor':     return 'способность: удержание вражеского судна';
    default:            return '';
  }
}

function closeBuildingInfo() {
  document.getElementById('building-info-panel').style.display = 'none';
  var lease = document.getElementById('building-info-lease');
  if (lease && typeof plStopTick === 'function') plStopTick(lease);
}

// ===== Аренда производства =====
// Управляющий сдаёт казарму, завод техники или храм союзнику на срок.
// Пока аренда идёт, нанимает только арендатор. Кто кому что сдал —
// карта «здание → аренда» по этой планете (js/production-lease.js).

var gbLeaseMap = {};
var unitLeaseSeq = 0;

function gbLoadLeases() {
  if (typeof plSystemLeases !== 'function') return Promise.resolve(gbLeaseMap);
  return plSystemLeases(systemId).then(function(map) {
    gbLeaseMap = map || {};
    return gbLeaseMap;
  });
}

// Блок аренды в карточке постройки: сдать, отозвать, сколько осталось,
// а арендатору — вход в найм
function gbPaintBuildingLease(building, seq, captured) {
  var host = document.getElementById('building-info-lease');
  if (!host) return;
  var type = building.building_types || {};
  if (typeof plRenderBlock !== 'function' || !plLeasable(type.code)) {
    if (typeof plStopTick === 'function') plStopTick(host);
    host.style.display = 'none';
    host.innerHTML = '';
    return;
  }

  var ready = !building.completes_at || new Date(building.completes_at).getTime() <= gbServerNow();
  var demolishBtn = document.getElementById('building-info-demolish');

  var paint = function(row) {
    plRenderBlock(host, {
      systemId: systemId,
      buildingId: building.id,
      name: type.name || 'Постройка',
      image: type.image || null,
      planetName: plPlanetName(),
      lease: row,
      canOffer: isController && ready && !captured,
      onOpen: function() { closeBuildingInfo(); openUnitPanel(building); },
      onChanged: function() {
        gbLoadLeases().then(function() {
          if (seq === buildingInfoSeq && buildingInfoShown()) openBuildingInfo(building);
        });
      }
    });
    // Сданное или предложенное не сносится — сервер откажет, кнопку гасим заранее
    if (demolishBtn && isController) {
      var held = !!row && row.role === 'lessor';
      demolishBtn.disabled = held || buildingDemolishBusy;
      demolishBtn.title = held ? 'Сначала дождись конца аренды или отзови предложение' : '';
    }
  };

  // Сразу — по кэшу, затем свежий ответ сервера
  paint(plLeaseOf(gbLeaseMap, building.id));
  gbLoadLeases().then(function(map) {
    if (seq !== buildingInfoSeq || !buildingInfoShown()) return;
    paint(plLeaseOf(map, building.id));
  });
}

// Плашка аренды в окне найма и замок на кнопках у хозяина сданного
function gbPaintUnitLease(building) {
  var my = ++unitLeaseSeq;
  var panel = document.getElementById('unit-panel');
  var host = document.getElementById('unit-panel-lease');
  if (!host) {
    host = document.createElement('div');
    host.id = 'unit-panel-lease';
    var slot = document.getElementById('unit-panel-slot');
    if (slot && slot.parentNode) slot.parentNode.insertBefore(host, slot);
  }

  var type = building.building_types || {};
  var leasable = typeof plLeasable === 'function' && plLeasable(type.code);
  var ready = !building.completes_at || new Date(building.completes_at).getTime() <= gbServerNow();
  var captured = sysFaction && building.faction && building.faction !== sysFaction;

  var apply = function(row) {
    if (!leasable) row = null;
    unitPanelLeaseBlock = !!row && plIsLockedOwner(row);
    if (panel) panel.classList.toggle('pl-locked', unitPanelLeaseBlock);
    setUnitButtonsEnabled(unitSlotOn);

    var again = function() {
      if (my === unitLeaseSeq && unitPanelBuilding && unitPanelBuilding.id === building.id) {
        gbPaintUnitLease(building);
        if (typeof unitPanelMax !== 'undefined') renderProductionSlot(building, unitPanelMax);
      }
    };
    // Хозяин видит здесь и вход в аренду — в карточку постройки он попадает
    // только в режиме стройки
    plRenderBanner(host, row, {
      kind: 'building',
      canOffer: leasable && isController && ready && !captured,
      offer: { systemId: systemId, buildingId: building.id, name: type.name || 'Постройка',
               image: type.image || null, planetName: plPlanetName() },
      // Срок вышел: перечитываем, кто теперь хозяин линии
      onEnd: again,
      onChanged: again
    });
  };

  if (typeof plSystemLeases !== 'function') {
    unitPanelLeaseBlock = false;
    if (panel) panel.classList.remove('pl-locked');
    host.style.display = 'none';
    return;
  }

  apply(plLeaseOf(gbLeaseMap, building.id));
  gbLoadLeases().then(function(map) {
    if (my !== unitLeaseSeq) return;
    apply(plLeaseOf(map, building.id));
  });
}

function openBuildPanel(slotIndex) {
  var panel = document.getElementById('build-panel');
  var list = document.getElementById('build-panel-list');
  list.innerHTML = '';
  panel.classList.remove('struct-mode');
  var head = panel.querySelector('.build-panel-title');
  if (head) head.textContent = 'Выбери постройку';

  // Карточки решают по справочнику и по запасу планеты, можно ли здесь
  // строить. Оба приходят с сервера асинхронно, и раньше карточки
  // рисовались до их прихода: полоса запаса показывала правду, а под ней
  // добыча помечалась «нет такого сырья». Поэтому ждём оба ответа и только
  // потом рисуем. Запас обновляем при каждом открытии — решение, что
  // строить, принимается здесь, и цифры должны быть свежими.
  var namesReady = Object.keys(resourceNames).length > 0;
  var pending = namesReady ? 1 : 2;

  function ready() {
    pending--;
    if (pending > 0) return;
    renderStockStrip(slotIndex);
    renderBuildCards(slotIndex, panel, list);
  }

  if (!namesReady) loadResourceNames(ready);
  loadPlanetStock(ready);
}

function renderBuildCards(slotIndex, panel, list) {

  // Показываем только постройки своей фракции и только наземные —
  // космическая станция ставится на орбитальной карте.
  var available = buildingTypes.filter(function(t) {
    return t.faction === currentUserFaction && !t.is_space;
  });

  if (available.length === 0) {
    list.innerHTML = '<div class="build-panel-empty">Нет доступных построек</div>';
    panel.style.display = 'flex';
    return;
  }

  available.forEach(function(type) {
    var item = document.createElement('button');
    item.className = 'build-panel-item';
    item.setAttribute('data-code', type.code);

    var thumb = document.createElement('div');
    thumb.className = 'build-panel-thumb';
    if (type.image) {
      var im = document.createElement('img');
      im.src = '../' + type.image;
      im.alt = '';
      im.onerror = function() { thumb.textContent = type.icon || '■'; im.remove(); };
      thumb.appendChild(im);
    } else {
      thumb.textContent = type.icon || '■';
    }
    item.appendChild(thumb);

    var info = document.createElement('div');
    info.className = 'build-panel-info';

    var nameEl = document.createElement('div');
    nameEl.className = 'build-panel-name';
    nameEl.textContent = type.name;
    info.appendChild(nameEl);

    if (type.description) {
      var descEl = document.createElement('div');
      descEl.className = 'build-panel-desc';
      descEl.textContent = type.description;
      info.appendChild(descEl);
    }

    var costEl = document.createElement('div');
    costEl.className = 'build-panel-cost';
    costEl.textContent = type.cost + ' кр.';

    // Что постройка даёт планете
    if (type.produces_resource) {
      var rate = stockRateFor(type);
      var eats = consumesText(type.consumes);
      costEl.textContent += eats
        ? ' · ' + eats + ' → ' + resourceName(type.produces_resource) + ' ' + rate
        : ' · ' + resourceName(type.produces_resource) + ' ' + rate + ' в сутки';
    } else if (type.storage_bonus > 0) {
      costEl.textContent += ' · запас +' + type.storage_bonus;
    }
    info.appendChild(costEl);

    // Цена в ресурсах отдельной строкой: её платит склад планеты,
    // а не кошелёк, и нехватка видна сразу по красному
    var resCost = consumesText(type.cost_resources);
    if (resCost) {
      var rc = document.createElement('div');
      rc.className = 'build-panel-rescost' +
                     (canAffordResources(type.cost_resources) ? '' : ' short');
      rc.textContent = 'Со склада: ' + resCost;
      info.appendChild(rc);
    }

    item.appendChild(info);

    // Добывающую нельзя ставить там, где сырья нет. Сервер это отобьёт,
    // но честнее сказать заранее, чем после нажатия.
    var blocked = type.needs_local_resource && !planetHasResource(type.produces_resource);

    if (blocked) {
      item.classList.add('blocked');
      var why = document.createElement('div');
      why.className = 'build-panel-why';
      why.textContent = 'На этой планете нет такого сырья';
      info.appendChild(why);
    }

    item.addEventListener('click', function() {
      if (blocked) {
        alert('На этой планете нет такого сырья');
        return;
      }
      askConstructBuilding(slotIndex, type);
    });
    list.appendChild(item);
  });

  panel.style.display = 'flex';
}

function closeBuildPanel() {
  var panel = document.getElementById('build-panel');
  panel.style.display = 'none';
  panel.classList.remove('struct-mode');
}

// Строительство идёт через защищённую серверную функцию: она сама проверяет
// права контролёра, берёт цену из БД и списывает кредиты одной транзакцией —
// клиент не может подменить ни цену, ни права.
var constructBusy = false;   // запрос ушёл: второй тап по карточке не шлём

function constructBuilding(slotIndex, buildingTypeId) {
  if (constructBusy) return;
  constructBusy = true;
  supabase.rpc('construct_building', {
    p_system_id: systemId,
    p_slot_index: slotIndex,
    p_building_type_id: buildingTypeId
  }).then(function(res) {
    constructBusy = false;
    closeBuildPanel();
    if (res.error) {
      alert('Не удалось построить: ' + gbErr(res.error));
      return;
    }
    loadBuildings();
  }, function(e) {
    constructBusy = false;
    alert('Не удалось построить: ' + ((e && e.message) || 'нет связи с сервером'));
  });
}

// ===== Подтверждение стройки и сноса =====
// Окно «Точно?» (js/game-confirm.js) показывает цену и возврат по тем же
// правилам, что на сервере: снос своего возвращает половину кредитов и
// половину сырья (укрепление — урезанную по прочности), а сырьё сверх
// вместимости склада пропадает. Окна нет (старая страница без скрипта) —
// действие идёт сразу, как раньше.

function gcReady() {
  return typeof gameConfirm === 'function';
}

function gcResColor(key) {
  var row = stockRow(key);
  return resourceColors[key] || (row && row.color) || null;
}

// «Спишется»: кредиты и сырьё со склада, нехватку подсвечиваем красным
function gcCostItems(credits, res) {
  var items = [];
  if (credits) items.push({ kind: 'credits', text: credits + ' кр.' });
  for (var k in (res || {})) {
    if (!Object.prototype.hasOwnProperty.call(res, k)) continue;
    var need = Number(res[k]) || 0;
    if (!need) continue;
    var row = stockRow(k);
    items.push({
      text: resourceName(k) + ' ' + need,
      color: gcResColor(k),
      bad: planetStock.length > 0 && (!row || row.amount < need)
    });
  }
  return items;
}

// «Вернётся»: часть сырья, которая влезет на склад; остальное — зачёркнутым.
// Доля — дробью num/den и целочисленно, как на сервере (половина — 1/2,
// укрепление — hp / (2 * max_hp)). capDrop — на сколько упадёт предел
// склада после сноса (склады, хранилище): сервер кладёт сырьё уже после.
function gcRefund(credits, res, num, den, capDrop) {
  var out = { items: [], lost: [], unknown: false };
  if (credits) out.items.push({ kind: 'credits', text: '+' + credits + ' кр.' });
  // Склад видит только управляющий: без сведений не обещаем, что влезет
  var known = planetStock.length > 0;
  var cap0 = known ? Number(planetStock[0].cap) || 0 : 0;
  den = Math.max(1, den || 1);
  for (var k in (res || {})) {
    if (!Object.prototype.hasOwnProperty.call(res, k)) continue;
    var amt = Math.floor((Number(res[k]) || 0) * (num || 0) / den);
    if (amt <= 0) continue;
    if (!known) {
      out.unknown = true;
      out.items.push({ text: resourceName(k) + ' до +' + amt, color: gcResColor(k) });
      continue;
    }
    var row = stockRow(k);
    var cap = Math.max(0, (row ? Number(row.cap) || cap0 : cap0) - (capDrop || 0));
    var fit = Math.max(0, Math.min(amt, cap - (row ? Number(row.amount) || 0 : 0)));
    if (fit > 0) out.items.push({ text: resourceName(k) + ' +' + fit, color: gcResColor(k) });
    if (fit < amt) {
      out.items.push({ text: resourceName(k) + ' ' + (amt - fit), lost: true });
      out.lost.push(resourceName(k).toLowerCase() + ' ' + (amt - fit));
    }
  }
  return out;
}

function gcLostWarn(r) {
  if (r.lost.length) return 'Склад полон: ' + r.lost.join(', ') + ' не поместится и пропадёт.';
  if (r.unknown) return 'Сырьё ляжет на склад планеты — что не поместится в предел, пропадёт.';
  return '';
}

// Достроенное здание или квартал, которые прибавляют к пределу склада
function gcCapWarn(drop) {
  return drop > 0 ? 'Предел склада планеты упадёт на ' + drop + '.' : '';
}

function gcJoin(a, b) {
  return a && b ? a + ' ' + b : (a || b || '');
}

function buildingTypeByCode(code) {
  for (var i = 0; i < buildingTypes.length; i++) {
    if (buildingTypes[i].code === code) return buildingTypes[i];
  }
  return null;
}

function askConstructBuilding(slotIndex, type) {
  if (!gcReady()) { constructBuilding(slotIndex, type.id); return; }
  if (constructBusy) return;
  var res = type.cost_resources || {};
  gameConfirm({
    tone: 'build',
    tag: type.code,
    kicker: 'Подтверди стройку',
    title: type.name,
    image: type.image ? '../' + type.image : null,
    sub: 'Участок ' + slotIndex,
    rows: [{ label: 'Спишется', items: gcCostItems(type.cost, res) }],
    note: 'Если потом снести — вернётся половина кредитов' +
          (Object.keys(res).length ? ' и сырья.' : '.'),
    ok: 'Построить'
  }, function() { constructBuilding(slotIndex, type.id); });
}

// Снос здания: склад перечитываем, чтобы честно сказать, что не влезет
function askDemolishBuilding(building, captured, go) {
  if (!gcReady()) { go(); return; }
  var bt = building.building_types || {};
  var full = buildingTypeByCode(bt.code) || {};
  var half = Math.floor((bt.cost || full.cost || 0) / 2);

  if (captured) {
    gameConfirm({
      tone: 'danger',
      kicker: 'Подтверди снос',
      title: bt.name || 'Постройка',
      image: bt.image ? '../' + bt.image : null,
      sub: 'Трофейная постройка · участок ' + building.slot_index,
      rows: [{ label: 'Спишется', items: [{ kind: 'credits', text: half + ' кр.' }] }],
      note: 'Расчистка чужой постройки платная. Вернуть её будет нельзя.',
      ok: 'Снести'
    }, go);
    return;
  }

  var seq = buildingInfoSeq;
  loadPlanetStock(function() {
    // Пока склад грузился, карточку закрыли или открыли другую — молчим
    if (seq !== buildingInfoSeq || !buildingInfoShown()) return;
    var done = !building.completes_at || new Date(building.completes_at).getTime() <= gbServerNow();
    var drop = done ? Number(full.storage_bonus) || 0 : 0;
    var r = gcRefund(half, full.cost_resources, 1, 2, drop);
    gameConfirm({
      tone: 'danger',
      kicker: 'Подтверди снос',
      title: bt.name || 'Постройка',
      image: bt.image ? '../' + bt.image : null,
      sub: 'Участок ' + building.slot_index,
      rows: [{ label: 'Вернётся', dir: 'in', items: r.items }],
      warn: gcJoin(gcCapWarn(drop), gcLostWarn(r)),
      note: 'Постройка исчезнет сразу — отменить снос нельзя.',
      ok: 'Снести'
    }, go);
  });
}

var buildingsLoaded = false;   // первый ответ пришёл: переход из ленты ждёт здания

// Участки приходят из базы: их там проверяет сервер, а число открытых
// растёт с уровнем поселения (7 + 1 / 2 / 4 / 7). Пока ответа нет,
// карта рисует первые семь по старому генератору — они совпадают с базой.
function applyBuildSlots(rows) {
  if (!rows || !rows.length) return;
  var list = [];
  rows.forEach(function(r) {
    list[r.slot_index - 1] = {
      x: r.x, y: r.y, index: r.slot_index,
      need_level: r.need_level, need_name: r.need_name,
      locked: r.unlocked === false
    };
  });
  // Дыр в нумерации быть не должно, но на всякий случай берём только подряд
  var out = [];
  for (var i = 0; i < list.length && list[i]; i++) out.push(list[i]);
  buildSlots = out;
}

function loadBuildings() {
  // Участки и здания одним заходом: здание на участке 8–14 без координат
  // участка не нарисовать, а переход из ленты ждёт обоих.
  // Здания — через функцию, а не прямым запросом: чужим она отдаёт
  // completes_at пустым, и враг видит только то, что в обзоре его бойцов.
  Promise.all([
    supabase.rpc('get_building_slots', { p_system_id: systemId }),
    supabase.rpc('get_system_buildings', { p_system_id: systemId })
  ]).then(function(r) {
    if (!r[0].error && r[0].data) applyBuildSlots(r[0].data);
    var res = r[1];
    buildingsBySlot = {};
    if (!res.error && res.data) {
      res.data.forEach(function(b) {
        b.building_types = {
          name: b.type_name, code: b.type_code, icon: b.type_icon,
          image: b.type_image, cost: b.type_cost
        };
        buildingsBySlot[b.slot_index] = b;
      });
    }
    buildingsLoaded = true;
    updateRedrawTimer();
    if (window.sceneLoader) sceneLoader.mark('buildings');
  });
}

// Карту и бой рисует бой 2.0 (ground/ground.js) каждый кадр — просить перерисовку не нужно.
// Пока на карте есть недостроенное здание, раз в секунду смотрим, не достроилось ли: достроилось всё —
// таймер выключаем и перечитываем здания.
function updateRedrawTimer() {
  var now = gbServerNow();
  var hasPending = Object.keys(buildingsBySlot).some(function(k) {
    var b = buildingsBySlot[k];
    return b.completes_at && new Date(b.completes_at).getTime() > now;
  });

  if (hasPending && !redrawTimer) {
    redrawTimer = setInterval(function() {
      var stillPending = Object.keys(buildingsBySlot).some(function(k) {
        var b = buildingsBySlot[k];
        return b.completes_at && new Date(b.completes_at).getTime() > gbServerNow();
      });
      if (!stillPending) {
        clearInterval(redrawTimer);
        redrawTimer = null;
        loadBuildings();
      }
    }, 1000);
  }
}

function checkBuildRights() {
  return supabase.auth.getSession().then(function(res) {
    if (!res.data.session) return;
    currentUserId = res.data.session.user.id;

    return Promise.all([
      supabase.from('system_control').select('controller_user_id').eq('system_id', systemId).maybeSingle().then(function(controlRes) {
        isController = !controlRes.error && controlRes.data && controlRes.data.controller_user_id === currentUserId;
      }),
      supabase.rpc('get_my_profile').then(function(profRes) {
        if (!profRes.error && profRes.data && profRes.data.length > 0) {
          currentUserFaction = profRes.data[0].faction;
          // Цвет своей стороны для каталога исследований и кнопок науки
          document.body.classList.toggle('fac-cis', currentUserFaction === 'cis');
        }
      }),
      supabase.from('systems').select('faction').eq('id', systemId).maybeSingle().then(function(sysRes) {
        if (!sysRes.error && sysRes.data) systemFaction = sysRes.data.faction;
      })
    ]);
  });
}

// Пачка событий — одна перезагрузка. Автоход, залп или высадка двигают
// десяток бойцов одной транзакцией, и раньше каждое событие тянуло все
// войска планеты заново и перерисовывало карту. Теперь события за
// короткое окно сливаются в один запрос.
var gbSoonTimers = {};
function gbSoon(key, fn, ms) {
  if (gbSoonTimers[key]) return;
  gbSoonTimers[key] = setTimeout(function() {
    gbSoonTimers[key] = null;
    fn();
  }, ms);
}

// Realtime: любое изменение построек на этой планете — перерисовываем слоты у всех.
function subscribeToGroundChanges() {
  if (!systemId) return;
  supabase
    .channel('ground-' + systemId)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'buildings', filter: 'system_id=eq.' + systemId }, function() {
      gbSoon('buildings', loadBuildings, 250);
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'field_structures', filter: 'system_id=eq.' + systemId }, function() {
      gbSoon('structures', loadStructures, 250);
    })
    .subscribe();
}

// На телефоне консоли нет, и любая ошибка выглядит одинаково — чёрный
// экран. Показываем её прямо на странице, чтобы было с чем работать.
function showFatal(text) {
  var box = document.getElementById('fatal-box');
  if (!box) {
    box = document.createElement('div');
    box.id = 'fatal-box';
    box.style.cssText = 'position:fixed;left:8px;right:8px;top:60px;z-index:9999;' +
      'padding:12px;background:#2a1015;border:1px solid #d94a4a;border-radius:8px;' +
      'color:#ffb3b3;font-family:monospace;font-size:11px;line-height:1.5;' +
      'white-space:pre-wrap;word-break:break-word;max-height:50vh;overflow:auto;';
    document.body.appendChild(box);
  }
  box.textContent = text;
}

window.addEventListener('error', function(e) {
  showFatal('Ошибка: ' + e.message + '\n' +
            (e.filename || '') + ':' + (e.lineno || '?'));
});

window.addEventListener('unhandledrejection', function(e) {
  showFatal('Запрос не прошёл: ' + ((e.reason && e.reason.message) || e.reason));
});

function initGroundBattle() {
  systemId = getSystemIdFromUrl();
  buildMode = isBuildMode();

  // Наземка 2.0 (js/ground-live.js): карту и бой рисует новый экран на своём холсте,
  // панели планеты работают поверх него в тех же координатах
  canvas = document.getElementById('sp-canvas');
  viewport = canvas;
  ctx = canvas ? canvas.getContext('2d') : null;

  if (!canvas) showFatal('В разметке нет <canvas id="sp-canvas">');

  // Клиент Supabase создаётся в supabase-client.js поверх библиотеки с CDN.
  // Если что-то из этого не загрузилось, в глобальной переменной остаётся
  // библиотека без .auth — и падает всё, что ходит в базу.
  if (typeof supabase === 'undefined' || !supabase.auth) {
    showFatal('Клиент Supabase не создан.\n\n' +
      'Не загрузилась библиотека с CDN или js/supabase-client.js. ' +
      'Проверь интернет в предпросмотре и перезапусти его.');
    return;
  }

  var buildPanelClose = document.getElementById('build-panel-close');
  if (buildPanelClose) buildPanelClose.addEventListener('click', closeBuildPanel);

  var buildingInfoClose = document.getElementById('building-info-close');
  if (buildingInfoClose) buildingInfoClose.addEventListener('click', closeBuildingInfo);

  var unitPanelClose = document.getElementById('unit-panel-close');
  if (unitPanelClose) unitPanelClose.addEventListener('click', closeUnitPanel);

  // Вход проверяем с повтором: краткий сбой не выкидывает из игры
  sbSessionGate().then(function(res) {

    if (!systemId) {
      // Карта строится от сида системы: без ?system= в адресе строить
      // нечего. Раньше код молча выходил и оставлял чёрный экран.
      if (window.sceneLoader) sceneLoader.hide();
      showFatal('В адресе нет ?system=\n\n' +
        'Эту страницу открывают тапом по планете с карты галактики, ' +
        'а не напрямую. Сейчас адрес: ' + window.location.search);
      return;
    }

    if (window.sceneLoader) {
      sceneLoader.expect([['terrain', 'Местность'], ['settlement', 'Поселение'], ['buildings', 'Постройки'],
                          ['structures', 'Укрепления'], ['units', 'Войска']]);
    }

    var slotSeed = hashStringToSeed(systemId);
    buildSlots = generateBuildSlots(slotSeed);

    Promise.all([
      supabase.from('building_types').select('*').then(function(res2) {
        buildingTypes = res2.error ? [] : res2.data;
      }),
      checkBuildRights()
    ]).then(function() {
      // Одна отрисовка на загрузку, как было изначально: на 120x120
      // клетках каждая лишняя перерисовка ощутимо блокирует поток,
      // и карта начинает дёргаться под пальцем.
      loadDeployZones().then(function() {
        loadUnits();
      });
      loadStructureTypes().then(loadStructures);
      loadGroundSettings();
      loadGroundSides();
      loadScoutReport();
      // Опросы — только пока вкладка на экране; вернулся — сразу свежие
      setInterval(function() { if (!document.hidden) loadScoutReport(); }, 20000);
      syncGroundTime();
      loadSettlement();
      loadDropCargo();
      gbLoadLeases();
      gbDeepLink();

      var rsClose = document.getElementById('research-close');
      if (rsClose) rsClose.addEventListener('click', closeResearchPanel);

      var stlClose = document.getElementById('settlement-close');
      if (stlClose) stlClose.addEventListener('click', closeSettlementPanel);

      var logiClose = document.getElementById('logi-close');
      if (logiClose) logiClose.addEventListener('click', closeLogisticsPanel);

      initTreeGestures();
      loadBuildings();
      loadUnitOrders();
      setInterval(function() { if (!document.hidden) loadUnitOrders(); }, 5000);
      document.addEventListener('visibilitychange', function() {
        if (document.hidden) return;
        loadUnitOrders();
        loadScoutReport();
        // Пока вкладка спала, реалтайм мог пропустить события (бойцов ведёт бой 2.0 — им не нужно)
        gbSoon('buildings', loadBuildings, 50);
        gbSoon('structures', loadStructures, 50);
      });
      initBuildToggle(false);
      subscribeToGroundChanges();
    });
  });
}

document.addEventListener('DOMContentLoaded', initGroundBattle);

// ===== Наём войск =====
// Характеристики берутся из справочника в БД и показываются как есть.
// Сервер при заказе всё равно перечитывает их сам, поэтому подменить
// цену или урон через клиент невозможно.

var unitPanelBuilding = null;
var unitPanelMax = 5;

// Состояние производственной линии в окне найма: что делается, сколько
// осталось и можно ли ставить новый заказ. Раньше игрок узнавал о занятой
// линии только из отказа после нажатия.
var unitPanelTimer = null;

// Номер отрисовки: ответ, пришедший после более нового вызова, ничего
// не трогает — иначе таймер старой отрисовки мог потерять свой id и
// дёргать базу без конца
var unitPanelSeq = 0;
// Готовые заказы, которые уже просили выдать: застрявший (нет места в зоне
// высадки) дожидается тика сервера, а не повторных просьб
var claimedOrderKeys = {};

function renderProductionSlot(building, maxPerOrder) {
  var box = document.getElementById('unit-panel-slot');
  if (!box) return;

  var seq = ++unitPanelSeq;
  if (unitPanelTimer) { clearInterval(unitPanelTimer); unitPanelTimer = null; }

  supabase.rpc('get_building_queue', { p_building_id: building.id }).then(function(res) {
    if (seq !== unitPanelSeq) return;
    var q = (!res.error && res.data && res.data.length) ? res.data[0] : null;

    if (!q) {
      box.className = 'prod-slot free';
      box.innerHTML = '<div class="prod-slot-title">Линия свободна</div>' +
        '<div class="prod-slot-sub">За раз можно заказать до ' + maxPerOrder + '</div>';
      setUnitButtonsEnabled(true);
      if (unitPanelTimer) { clearInterval(unitPanelTimer); unitPanelTimer = null; }
      return;
    }

    box.className = 'prod-slot busy';
    setUnitButtonsEnabled(false);

    var draw = function(left) {
      var total = Math.max(1, q.seconds_left || 1);
      if (!draw.total) draw.total = total;
      var pct = Math.max(0, Math.min(100, (1 - left / draw.total) * 100));

      box.innerHTML =
        '<div class="prod-slot-title">' + escHtml(q.unit_name || 'Производство') +
          ' ×' + q.quantity + (q.mine ? '' : ' <em>чужой заказ</em>') + '</div>' +
        '<div class="prod-slot-track"><i style="width:' + pct + '%"></i></div>' +
        '<div class="prod-slot-sub">Готово через ' + formatLeft(left) + '</div>';
    };

    var left = q.seconds_left;
    if (unitPanelTimer) { clearInterval(unitPanelTimer); unitPanelTimer = null; }

    // Время вышло, а заказ ещё не выдан: просим выдать сразу и смотрим
    // снова через пару секунд. Раньше здесь висело «Готово через 0 с»
    // до тика сервера, а клиент дёргал базу каждую секунду.
    if (left <= 0) {
      draw(0);
      var sub = box.querySelector('.prod-slot-sub');
      if (sub) sub.textContent = q.mine ? 'Готово, выводим на поле…' : 'Готово, ждёт выдачи';
      var key = building.id + '|' + q.completes_at;
      var first = q.mine && !claimedOrderKeys[key];
      var again = function() {
        if (seq !== unitPanelSeq) return;
        if (unitPanelTimer) { clearInterval(unitPanelTimer); unitPanelTimer = null; }
        unitPanelTimer = setTimeout(function() {
          unitPanelTimer = null;
          var up = document.getElementById('unit-panel');
          if (seq === unitPanelSeq && up && up.style.display !== 'none' &&
              unitPanelBuilding && unitPanelBuilding.id === building.id) {
            renderProductionSlot(building, maxPerOrder);
          }
        }, first ? 2500 : 5000);
      };
      if (first) { claimedOrderKeys[key] = true; claimReadyNow().then(again); }
      else again();
      return;
    }

    draw(left);
    var tick = setInterval(function() {
      // Свой id держим при себе: общий unitPanelTimer мог уже смениться
      if (seq !== unitPanelSeq) { clearInterval(tick); return; }
      left -= 1;
      if (left <= 0) {
        clearInterval(tick);
        if (unitPanelTimer === tick) unitPanelTimer = null;
        renderProductionSlot(building, maxPerOrder);
        return;
      }
      draw(left);
    }, 1000);
    unitPanelTimer = tick;
  });
}

function formatLeft(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  if (sec >= 3600) {
    var h = Math.floor(sec / 3600);
    var mm = Math.floor((sec % 3600) / 60);
    return h + ' ч' + (mm ? ' ' + mm + ' мин' : '');
  }
  if (sec >= 60) {
    var m = Math.floor(sec / 60);
    return m + ' мин ' + (sec % 60) + ' с';
  }
  return sec + ' с';
}

// Линия свободна (последний ответ очереди) и закрыт ли найм арендой
var unitSlotOn = true;
var unitPanelLeaseBlock = false;

function setUnitButtonsEnabled(on) {
  unitSlotOn = !!on;
  var panel = document.getElementById('unit-panel');
  if (!panel) return;
  var btns = panel.querySelectorAll('.unit-card-order, .unit-order-btn');
  for (var i = 0; i < btns.length; i++) {
    // Кнопку одарённого держит закрытой своя проверка, пока не ответит «можно»
    var gated = btns[i].getAttribute('data-gate');
    btns[i].disabled = !on || unitPanelLeaseBlock || (!!gated && gated !== 'ok');
  }
}

// Что изучено для пехоты: показываем только подходящее этому бойцу
var unitUpgradesDone = [];

function loadUnitUpgrades() {
  return supabase.rpc('get_researches').then(function(res) {
    if (!res.error && res.data) {
      unitUpgradesDone = res.data.filter(function(r) {
        return r.done && r.scope === 'unit';
      });
    }
  });
}

function openUnitPanel(building) {
  // Запас нужен для подсветки нехватки, справочник — для названий
  loadPlanetStock();
  loadResourceNames();
  unitPanelBuilding = building;
  var panel = document.getElementById('unit-panel');
  var list = document.getElementById('unit-panel-list');
  var title = document.getElementById('unit-panel-title');

  title.textContent = (building.building_types && building.building_types.name) || 'Производство';
  list.innerHTML = '<div class="unit-panel-empty">Загрузка...</div>';
  panel.style.display = 'flex';

  // Аренда: плашка над линией и замок на найме у хозяина сданного
  gbPaintUnitLease(building);

  var code = building.building_types && building.building_types.code;

  // Показываем занятость зон высадки: сервер всё равно откажет при нехватке,
  // но лучше предупредить заранее, чем ловить ошибку после нажатия.
  updateDeployCounter();

  // Предел партии задан типом постройки: казарма делает пятёрками,
  // завод техники — по одной машине
  loadUnitUpgrades();

  Promise.all([
    supabase.from('unit_types').select('*').eq('produced_by', code),
    supabase.from('building_types').select('max_per_order').eq('code', code).maybeSingle()
  ]).then(function(r) {
    var res = r[0];
    var maxPerOrder = (!r[1].error && r[1].data) ? (r[1].data.max_per_order || 5) : 5;
    unitPanelMax = maxPerOrder;

    renderProductionSlot(building, maxPerOrder);

    if (res.error || !res.data || res.data.length === 0) {
      // Здание без найма: линия производства ему не нужна вовсе
      closeUnitPanel();
      openEconomyPanel(building);
      return;
    }
    list.innerHTML = '';

    // Если постройка готовит одарённых, над карточкой найма встаёт список
    // уже нанятых — живые с их счётом и павшие, которых храм помнит.
    var hasHero = res.data.some(function(u) { return u.is_hero; });
    if (hasHero) {
      var roster = document.createElement('div');
      roster.className = 'hero-roster';
      roster.innerHTML = '<div class="hero-roster-empty">Загрузка...</div>';
      list.appendChild(roster);
      loadHeroRoster(building, roster);
    }

    // Штаб не заменяет наём, а дополняет его: сводка разведки встаёт
    // над карточками офицеров и разведдроидов, ничего не вытесняя.
    if (code === 'rep_hq' || code === 'cis_control') {
      var intelBox = document.createElement('div');
      intelBox.className = 'intel-box';
      intelBox.innerHTML = '<div class="intel-head">Разведка</div>' +
                           '<div class="intel-empty">Загрузка...</div>';
      list.appendChild(intelBox);
      loadIntel(building, intelBox);
      // тайные операции: диверсионные группы штаба (js/spy-ops.js)
      if (typeof soBox === 'function') {
        var soEl = document.createElement('div');
        soEl.className = 'so-box';
        list.appendChild(soEl);
        soBox(building, soEl);
      }
    }

    // Медцентр и ремцех штопают пехоту, заводы техники — машины.
    // Ремонт делит производственную линию с наймом, поэтому блок стоит
    // рядом с карточками, а не в отдельном окне.
    if (REPAIR_BUILDINGS[code]) {
      var repairBox = document.createElement('div');
      repairBox.className = 'rp-box';
      repairBox.innerHTML = '<div class="rp-empty">Загрузка...</div>';
      list.appendChild(repairBox);
      loadRepairList(building, repairBox);
    }

    res.data.forEach(function(unit) {
      list.appendChild(buildUnitCard(unit));
    });
  });
}

// Постройки, у которых есть ремонтное место, и что именно они чинят.
// Тот же список продублирован на сервере в repair_building_kind —
// клиент только рисует, решение принимает база.
var REPAIR_BUILDINGS = {
  rep_medical: 'infantry',
  cis_repair: 'infantry',
  rep_vehicle: 'vehicle',
  cis_vehicle: 'vehicle'
};

function loadRepairList(building, box) {
  var kind = REPAIR_BUILDINGS[(building.building_types || {}).code];
  var title = kind === 'vehicle' ? 'Ремонтный док' : 'Лазарет';

  supabase.rpc('get_repairable_units', { p_building_id: building.id }).then(function(res) {
    if (res.error) {
      box.innerHTML = '<div class="rp-empty">Не удалось прочитать список</div>';
      return;
    }

    var rows = res.data || [];
    box.innerHTML = '<div class="rp-head">' + title + '</div>';

    if (!rows.length) {
      var hint = document.createElement('div');
      hint.className = 'rp-empty';
      hint.textContent = kind === 'vehicle'
        ? 'Побитой техники в зонах высадки нет'
        : 'Раненых в зонах высадки нет';
      box.appendChild(hint);
      return;
    }

    rows.forEach(function(u) {
      var pct = u.full_hp ? Math.max(0, Math.min(100, u.hp / u.full_hp * 100)) : 100;

      var row = document.createElement('div');
      row.className = 'rp-row';
      row.innerHTML =
        '<div class="rp-face">' +
          ((u.portrait || u.image) ? '<img src="../' + (u.portrait || u.image) + '" alt="">' : '') +
        '</div>' +
        '<div class="rp-info">' +
          '<div class="rp-name">' + escHtml(u.hero_name || u.name) + '</div>' +
          '<div class="rp-hp">' +
            '<span>' + u.hp + ' / ' + u.full_hp + '</span>' +
            '<div class="rp-track"><i style="width:' + pct + '%"></i></div>' +
          '</div>' +
          '<div class="rp-sub">' + u.x + ':' + u.y + ' · ' + formatLeft(u.seconds) + '</div>' +
        '</div>';

      var btn = document.createElement('button');
      btn.className = 'rp-go';
      btn.innerHTML = 'Чинить<span>' + u.cost + '</span>';
      btn.addEventListener('click', function() {
        if (unitPanelLeaseBlock) return;
        btn.disabled = true;
        supabase.rpc('start_repair', {
          p_building_id: building.id,
          p_unit_id: u.unit_id
        }).then(function(r2) {
          btn.disabled = false;
          if (r2.error) { alert('Не вышло: ' + gbErr(r2.error)); return; }
          renderProductionSlot(building, unitPanelMax);
          loadRepairList(building, box);
          updateDeployCounter();
        });
      });

      row.appendChild(btn);
      box.appendChild(row);
    });
  });
}

// Список одарённых игрока. Он общий, а не привязан к планете: герой,
// нанятый на одной планете, виден в любом храме своей фракции.
function loadHeroRoster(building, box) {
  supabase.rpc('get_hero_roster', { p_building_id: building.id }).then(function(res) {
    if (res.error) {
      box.innerHTML = '<div class="hero-roster-empty">Не удалось прочитать список</div>';
      return;
    }

    var rows = res.data || [];
    if (!rows.length) {
      box.innerHTML = '<div class="hero-roster-empty">Одарённых пока нет</div>';
      return;
    }

    var live = rows.filter(function(h) { return !h.died_at; });
    var fallen = rows.filter(function(h) { return h.died_at; });

    box.innerHTML = '<div class="hero-roster-head">Одарённые · ' + live.length +
                    (fallen.length ? ' · павших ' + fallen.length : '') + '</div>';

    rows.forEach(function(h) {
      var row = document.createElement('div');
      row.className = 'hero-row' + (h.died_at ? ' fallen' : '');

      var where = h.died_at ? 'Пал на планете ' + (h.died_system_id || '—')
                : h.training_name ? 'Обучение: ' + h.training_name +
                                    ' · ' + formatLeft(h.training_left || 0)
                : (h.on_map ? 'В бою · ' + (h.system_id || '') : 'В пути');

      row.innerHTML =
        '<div class="hero-face"><img src="../' + h.portrait + '" alt=""></div>' +
        '<div class="hero-info">' +
          '<div class="hero-nick">' + escHtml(h.name) + '</div>' +
          '<div class="hero-where">' + where + '</div>' +
        '</div>' +
        '<div class="hero-kills">' + h.kills + '<span>убито</span></div>';

      // Переименовать можно только живого: павшего храм помнит под тем
      // именем, под которым он погиб.
      if (!h.died_at) {
        var rename = document.createElement('button');
        rename.className = 'hero-rename';
        rename.textContent = '✎';
        rename.title = 'Сменить кличку';
        rename.addEventListener('click', function() {
          var next = prompt('Новая кличка для ' + h.name, h.name);
          if (next === null) return;
          rename.disabled = true;
          supabase.rpc('rename_hero', { p_hero_id: h.hero_id, p_name: next.trim() })
            .then(function(r2) {
              rename.disabled = false;
              if (r2.error) { alert('Не вышло: ' + gbErr(r2.error)); return; }
              loadHeroRoster(building, box);
              loadUnits();
            });
        });
        row.appendChild(rename);
      }

      box.appendChild(row);
    });
  });
}

function buildUnitCard(unit) {
  var card = document.createElement('div');
  card.className = 'unit-card';
  card.setAttribute('data-unit', unit.id);

  var media = document.createElement('div');
  media.className = 'unit-card-media';
  // Пехота снята в полный рост (1:2) и встаёт в высокую рамку. Технику
  // снимали квадратом: в той же рамке она висела крошкой между чёрными
  // полосами. Для неё карточка раскладывается иначе — снимок широкой
  // полосой сверху. Решает настоящая пропорция файла, а не тип юнита:
  // артиллерия, например, снята как пехота, в рост.
  if (unit.is_vehicle && unit.image) card.classList.add('wide');
  if (unit.image) {
    // Широкий снимок показываем целиком, а пустые края полосы
    // закрывает размытая копия того же кадра
    var bg = document.createElement('img');
    bg.className = 'bg';
    bg.alt = '';
    bg.src = '../' + unit.image;
    media.appendChild(bg);

    var img = document.createElement('img');
    img.className = 'fg';
    img.alt = '';
    img.addEventListener('load', function() {
      if (!img.naturalHeight) return;
      card.classList.toggle('wide', img.naturalWidth / img.naturalHeight > 0.8);
    });
    img.src = '../' + unit.image;
    media.appendChild(img);
  }
  card.appendChild(media);

  var body = document.createElement('div');
  body.className = 'unit-card-body';

  var name = document.createElement('div');
  name.className = 'unit-card-name';
  name.textContent = unit.name;
  body.appendChild(name);

  if (unit.description) {
    var desc = document.createElement('div');
    desc.className = 'unit-card-desc';
    desc.textContent = unit.description;
    body.appendChild(desc);
  }

  var stats = document.createElement('div');
  stats.className = 'unit-card-stats';
  stats.appendChild(makeStat('❤', 'Прочность', unit.max_hp));
  stats.appendChild(makeStat('⚔', 'Урон', unit.damage));
  stats.appendChild(makeStat('➔', 'Манёвр', unit.move_range + ' кл.'));
  stats.appendChild(makeStat('◉', 'Обзор', unit.vision_range + ' кл.'));
  body.appendChild(stats);

  if (unit.splash_size > 0) {
    var arty = document.createElement('div');
    arty.className = 'unit-card-relay unit-card-arty';
    arty.textContent = '✹ Залп ' + unit.splash_size + '×' + unit.splash_size +
      ' через всю карту · ' + (unit.shot_ap || 2) + ' действия · откат ' +
      (unit.action_seconds || 30) + ' с';
    body.appendChild(arty);
  }

  if (unit.is_relay) {
    var relay = document.createElement('div');
    relay.className = 'unit-card-relay';
    relay.textContent = '⌖ Держит связь: делится обзором с союзниками';
    body.appendChild(relay);
  }

  // Ресурсы со склада планеты — отдельной строкой перед кнопкой найма. Сервер (order_unit →
  // take_build_resources) списывает сырьё за всю партию, поэтому строка и проверка — за выбранное
  // количество; пересчитывает их updatePrice
  var urc = null;
  if (consumesText(unit.cost_resources)) {
    urc = document.createElement('div');
    urc.className = 'build-panel-rescost';
    body.appendChild(urc);
  }
  function resFor(n) {
    var out = {}, c = unit.cost_resources || {};
    for (var rk in c) if (Object.prototype.hasOwnProperty.call(c, rk)) out[rk] = c[rk] * n;
    return out;
  }

  var footer = document.createElement('div');
  footer.className = 'unit-card-footer';

  // Одарённый нанимается поштучно и под собственной кличкой, поэтому
  // вместо счётчика количества у него поле имени. Кличку сервер проверит
  // ещё раз: длину и занятость среди живых героев игрока.
  var heroInput = null;
  var heroGate = null;
  var nameBox = null;

  if (unit.is_hero) {
    // Сначала спрашиваем сервер, можно ли вообще начать обряд (кредиты,
    // сырьё, занятая постройка, место в зоне высадки), и только потом
    // даём придумывать кличку — а не после ввода имени и выбора клетки.
    heroGate = document.createElement('div');
    heroGate.className = 'hero-gate wait';
    heroGate.textContent = 'Проверяем, можно ли начать обряд…';
    body.appendChild(heroGate);

    nameBox = document.createElement('div');
    nameBox.className = 'hero-name-box';
    nameBox.style.display = 'none';
    heroInput = document.createElement('input');
    heroInput.className = 'hero-name-input';
    heroInput.type = 'text';
    heroInput.maxLength = 24;
    heroInput.placeholder = 'Кличка';
    nameBox.appendChild(heroInput);
    var look = document.createElement('div');
    look.className = 'hero-name-note';
    look.textContent = 'Облик одарённому выпадет при обряде';
    nameBox.appendChild(look);
    body.appendChild(nameBox);
  }

  var qty = document.createElement('div');
  qty.className = 'unit-qty';
  var minus = document.createElement('button');
  minus.className = 'unit-qty-btn';
  minus.textContent = '−';
  var val = document.createElement('span');
  val.className = 'unit-qty-value';
  val.textContent = '1';
  var plus = document.createElement('button');
  plus.className = 'unit-qty-btn';
  plus.textContent = '+';
  minus.addEventListener('click', function() {
    var n = Math.max(1, parseInt(val.textContent, 10) - 1);
    val.textContent = n;
    updatePrice();
  });
  plus.addEventListener('click', function() {
    // Потолок задаёт постройка: 99 из воздуха сервер всё равно отвергнет
    var n = Math.min(unitPanelMax, parseInt(val.textContent, 10) + 1);
    val.textContent = n;
    updatePrice();
  });
  qty.appendChild(minus); qty.appendChild(val); qty.appendChild(plus);
  if (!unit.is_hero) footer.appendChild(qty);

  var order = document.createElement('button');
  order.className = 'unit-order-btn';
  if (unitPanelLeaseBlock) order.disabled = true;
  footer.appendChild(order);

  // Дополнения ставятся на каждого бойца и оплачиваются за каждого:
  // изучение даёт право, а не скидку на всю армию
  var chosen = {};

  var mine = unitUpgradesDone.filter(function(r) {
    return (r.applies_units || []).indexOf(unit.id) !== -1;
  });

  if (mine.length) {
    var box = document.createElement('div');
    box.className = 'unit-up';

    var head = document.createElement('div');
    head.className = 'unit-up-head';
    head.textContent = 'Дополнения · доступно ' + mine.length;
    box.appendChild(head);

    var grid = document.createElement('div');
    grid.className = 'unit-up-grid';

    mine.forEach(function(r) {
      var t = document.createElement('button');
      t.className = 'unit-up-tile';
      t.innerHTML = '<img src="../' + r.icon_image + '" alt="">';
      t.title = r.name + ' — ' + r.description;
      t.addEventListener('click', function() {
        if (chosen[r.id]) delete chosen[r.id]; else chosen[r.id] = r;
        t.classList.toggle('active', !!chosen[r.id]);
        updatePrice();
      });
      grid.appendChild(t);
    });

    box.appendChild(grid);

    var sub = document.createElement('div');
    sub.className = 'unit-up-sub';
    box.appendChild(sub);

    body.appendChild(box);
    var subEl = sub;
  }

  function upgradeCost() {
    var sum = 0;
    for (var k in chosen) sum += Math.floor(chosen[k].cost / 4);
    return sum;
  }

  function updatePrice() {
    var n = parseInt(val.textContent, 10);
    if (urc) {
      var need = resFor(n);
      urc.className = 'build-panel-rescost' + (canAffordResources(need) ? '' : ' short');
      urc.textContent = 'Со склада: ' + consumesText(need);
    }
    if (order.getAttribute('data-gate') !== 'bad') {
      order.textContent = 'Нанять · ' + ((unit.cost + upgradeCost()) * n);
    }

    var sub = body.querySelector('.unit-up-sub');
    if (sub) {
      var names = [];
      for (var k in chosen) names.push(chosen[k].name);
      sub.textContent = names.length
        ? names.join(', ') + ' · +' + upgradeCost() + ' на бойца'
        : 'Дополнения не выбраны';
    }
  }
  updatePrice();

  // Ответ проверки: можно — открываем поле клички, нельзя — пишем почему
  function applyHeroGate(reason) {
    if (!heroGate) return;
    if (reason) {
      heroGate.className = 'hero-gate bad';
      heroGate.style.display = '';
      heroGate.textContent = reason;
      nameBox.style.display = 'none';
      order.setAttribute('data-gate', 'bad');
      order.disabled = true;
      order.textContent = 'Обряд недоступен';
    } else {
      heroGate.className = 'hero-gate';
      heroGate.style.display = 'none';
      nameBox.style.display = '';
      order.setAttribute('data-gate', 'ok');
      // Храм сдан в аренду — у хозяина кнопка остаётся закрытой
      order.disabled = unitPanelLeaseBlock;
      updatePrice();
    }
  }

  function checkHeroGate(done) {
    var bld = unitPanelBuilding;
    stlSafe(supabase.rpc('hero_hire_check', { p_building_id: bld && bld.id })).then(function(r) {
      // Панель уже закрыли или открыли другую постройку — ответ не наш
      if (unitPanelBuilding !== bld || !document.body.contains(card)) return;
      // Старая база без проверки — ведём себя как раньше: поле сразу
      if (r.error && stlRpcMissing(r.error)) { applyHeroGate(null); if (done) done(null); return; }
      var reason = r.error ? ('Не удалось проверить: ' + gbErr(r.error)) : (r.data || null);
      applyHeroGate(reason);
      if (done) done(reason);
    });
  }

  if (unit.is_hero) {
    order.setAttribute('data-gate', 'wait');
    order.disabled = true;
    checkHeroGate();
  }

  order.addEventListener('click', function() {
    var n = parseInt(val.textContent, 10);

    if (unit.is_hero) {
      var nick = (heroInput.value || '').trim();
      if (nick.length < 2) {
        alert('Придумай кличку — хотя бы два символа');
        heroInput.focus();
        return;
      }
      // Пока придумывали кличку, могло что-то измениться — сверяемся ещё раз,
      // и только потом выбираем место на карте; заказ уходит после клетки.
      order.disabled = true;
      order.setAttribute('data-gate', 'wait');
      checkHeroGate(function(reason) {
        if (!reason) startPlacement(unit.id, 1, [], nick);
      });
      return;
    }

    startPlacement(unit.id, n, Object.keys(chosen));
  });

  body.appendChild(footer);
  card.appendChild(body);
  return card;
}

function makeStat(icon, label, value) {
  var el = document.createElement('div');
  el.className = 'unit-stat';
  el.innerHTML = '<span class="unit-stat-icon">' + icon + '</span>' +
                 '<span class="unit-stat-label">' + label + '</span>' +
                 '<span class="unit-stat-value">' + value + '</span>';
  return el;
}

function closeUnitPanel() {
  document.getElementById('unit-panel').style.display = 'none';
  unitLeaseSeq++;
  var leaseHost = document.getElementById('unit-panel-lease');
  if (leaseHost && typeof plStopTick === 'function') plStopTick(leaseHost);
  // Отсчёт линии нужен только открытому окну: при следующем открытии
  // renderProductionSlot запустит его заново
  unitPanelSeq++;
  if (unitPanelTimer) { clearInterval(unitPanelTimer); unitPanelTimer = null; }
}

// Полоса текущих заказов внизу экрана — своя очередь видна только владельцу,
// политика в БД чужим её не отдаёт.
function loadUnitOrders() {
  supabase.from('unit_orders').select('*, unit_types(name)')
    .eq('system_id', systemId).eq('delivered', false)
    .then(function(res) {
      var bar = document.getElementById('order-queue');
      if (!bar) return;
      if (res.error || !res.data || res.data.length === 0) {
        bar.style.display = 'none';
        return;
      }
      bar.innerHTML = '';
      bar.style.display = 'flex';
      var due = false;
      res.data.forEach(function(o) {
        var left = Math.max(0, Math.ceil((new Date(o.completes_at).getTime() - gbServerNow()) / 1000));
        // Просим выдать один раз на заказ: если он застрял, ждёт тика
        if (left <= 0 && !claimedOrderKeys['o|' + o.id]) {
          claimedOrderKeys['o|' + o.id] = true;
          due = true;
        }
        var item = document.createElement('div');
        item.className = 'order-chip';
        item.textContent = (o.unit_types ? o.unit_types.name : o.unit_type) +
                           ' ×' + o.quantity + ' · ' + (left > 0 ? left + 'с' : 'готово');
        bar.appendChild(item);
      });
      // Срок вышел — просим выдать сразу, не дожидаясь тика сервера
      if (due) claimReadyNow().then(function(sent) { if (sent) { loadUnitOrders(); loadUnits(); } });
    });
}

// ===== Юниты на карте и выбор места при заказе =====

var unitsOnMap = [];
var unitTypeById = {};
var unitImages = {};   // путь -> Image

function getUnitImage(path) {
  if (!path) return null;
  if (unitImages[path]) return unitImages[path];
  var img = new Image();
  img.src = '../' + path;
  img.onerror = function() { img.failed = true; };
  unitImages[path] = img;
  return img;
}

// Сколько раз зеркало боя отдало бойцов (js/ground-live.js) — 0, пока карта не пришла ни разу
var loadUnitsApplied = 0;
// Бойцы — из зеркала боя 2.0 (js/ground-live.js); старые панели читают unitsOnMap
function loadUnits() {
  return GL.loadUnits();
}

// Юнит занимает одну клетку. Свои — зелёные, союзные — синие,
// вражеские — красные: туман войны в БД пропускает только тех, кого видно.
// Габариты юнита в клетках: пехота 1x1, AT-TE и канонерка 2x2
function unitBox(u) {
  var t = unitTypeById[u.unit_type];
  return { w: (t && t.width_cells) || 1, h: (t && t.height_cells) || 1 };
}

// Кличку одарённого придумывает игрок, а видят её и союзники, и враги.
// Всё, что от игрока, перед вставкой в разметку обязано пройти здесь,
// иначе чужое имя со скобками выполнится в чужом браузере.
function escHtml(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Карта занятых клеток с учётом корпуса: техника 2x2 закрывает четыре
// клетки, а не одну. Считать по одной верхней левой клетке нельзя —
// сервер в is_ground_box_free проверяет пересечение прямоугольников,
// и подсветка обещала бы место, которого нет.
function buildOccupancy(ignoreUnitId) {
  var map = {};
  unitsOnMap.forEach(function(u) {
    if (u.x === null || u.x === undefined) return;
    if (ignoreUnitId && u.id === ignoreUnitId) return;
    var b = unitBox(u);
    for (var dx = 0; dx < b.w; dx++) {
      for (var dy = 0; dy < b.h; dy++) {
        map[(u.x + dx) + ':' + (u.y + dy)] = true;
      }
    }
  });
  return map;
}

// Влезает ли прямоугольник w×h в клетку x,y: и по краям карты, и по соседям
function isBoxFree(occupied, x, y, w, h) {
  if (x < 0 || y < 0 || x + w > GRID_SIZE || y + h > GRID_SIZE) return false;
  for (var dx = 0; dx < w; dx++) {
    for (var dy = 0; dy < h; dy++) {
      if (occupied[(x + dx) + ':' + (y + dy)]) return false;
    }
  }
  return true;
}

// Какой кусок картинки бойца показывать на клетке: [sx, sy, sw, sh].
// Исходник вытянутый 1:2, а клетка квадратная. Берём из кадра квадратный
// кусок с головой и торсом — так юнит узнаётся даже на иконке в 32 пикселя,
// и фигура не сплющивается. У техники кадр квадратный и весь по делу.
function gbUnitCrop(img, type) {
  if (type && type.is_vehicle && img.naturalHeight > img.naturalWidth * 1.2) {
    // Высокая машина (артиллерия) снята в полный рост, как пехота:
    // файл не режем, а на клетке показываем квадрат по корпусу
    var w = img.naturalWidth;
    return [0, Math.max(0, Math.min(img.naturalHeight - w, img.naturalHeight * 0.55 - w / 2)), w, w];
  }
  if (type && type.is_vehicle) return [0, 0, img.naturalWidth, img.naturalHeight];
  var sw = img.naturalWidth * 0.70;
  return [(img.naturalWidth - sw) / 2, img.naturalHeight * 0.07, sw, sw];
}

var selectedUnit = null;

// ===== Высадка десанта =====
// Высадка выгружает из трюма: на своей планете — в зоны высадки,
// при вторжении — в полосу вторжения.
var droppingUnit = null;   // {shipId, unitType, name}
var dropCargo = [];        // ответ get_drop_ready_cargo

// Клетка поля под точкой экрана (лоток десанта тянет карточку пальцем)
function gbClientCell(cx, cy) {
  var rect = viewport.getBoundingClientRect();
  return {
    x: Math.floor(((cx - rect.left - panX) / scale) / CELL_PX),
    y: Math.floor(((cy - rect.top - panY) / scale) / CELL_PX)
  };
}

function hidePickup() {
  var bar = document.getElementById('pickup-bar');
  if (!bar || bar.style.visibility === 'hidden') return;
  bar.removeAttribute('data-struct');
  bar.removeAttribute('data-side');
  bar.style.visibility = 'hidden';
  setBottomInset(0);
}

var dropVehicles = [];
var dropFighters = [];

function loadDropCargo() {
  return Promise.all([
    supabase.rpc('get_drop_ready_cargo', { p_system_id: systemId }),
    supabase.rpc('get_drop_ready_vehicles', { p_system_id: systemId }),
    supabase.rpc('get_landable_fighters', { p_system_id: systemId })
  ]).then(function(r) {
      var res = r[0];
      dropCargo = (res.error || !res.data) ? [] : res.data;
      dropVehicles = (r[1].error || !r[1].data) ? [] : r[1].data;
      dropFighters = (r[2].error || !r[2].data) ? [] : r[2].data;

      updateDropBtn();
    });
}

// Что можно высадить с орбиты на эту планету. При вторжении — в полосу вторжения, на своей
// и союзной — в зоны высадки (сервер: unload_unit_at / unload_vehicle_at / land_fighter;
// корабль с войсками и техникой должен стоять в площадке сброса). Показывает лоток десанта.
function dropListFor() {
  return {
    fighters: dropFighters,
    vehicles: dropVehicles,
    cargo: dropCargo
  };
}

// Груз трюмов или сторона обновились — открытый лоток десанта перерисовывается
function updateDropBtn() {
  if (typeof dtOpen !== 'undefined' && dtOpen && typeof dtRefresh === 'function') dtRefresh();
}

// Куда можно сесть: при вторжении — полоса вторжения, на своей планете —
// зоны высадки. Ровно те же правила проверяет land_fighter на сервере.
function fighterLandCellAllowed(cx, cy) {
  if (cx < 0 || cy < 0 || cx >= GRID_SIZE || cy >= GRID_SIZE) return false;
  if (iAmAttacker) return cy >= GRID_SIZE - ATTACK_ZONE_H;
  return deployZones.some(function(z) {
    var size = z.size || DEPLOY_SIZE;
    return cx >= z.x && cx < z.x + size && cy >= z.y && cy < z.y + size;
  });
}

var droppingVehicle = null;
var landingFighter = null;

function startFighterLanding(f) {
  // Отдельный режим (ссылка «на грунт» из ангара) — лоток убираем
  if (typeof dtOpen !== 'undefined' && dtOpen) closeDropTray();
  landingFighter = f;
  droppingUnit = null;
  droppingVehicle = null;

  var hint = document.getElementById('placement-hint');
  hint.innerHTML = '<span>Куда сажать: ' + escHtml(f.name) + '</span>' +
                   '<button id="drop-cancel">Готово</button>';
  hint.style.display = 'flex';
  document.getElementById('drop-cancel').addEventListener('click', cancelDrop);

  setBottomInset(insetFor(hint));
  var midX = (viewport.clientWidth / 2 - panX) / scale / CELL_PX;
  focusCell(midX, iAmAttacker
    ? GRID_SIZE - ATTACK_ZONE_H + ATTACK_ZONE_H / 2
    : (deployZones.length ? deployZones[0].y : 10));
}

var landingBusy = false;
var dropHintTimer = null;

// Короткое пояснение прямо в строке подсказки режима: отдельное окно
// здесь лишнее, а молчаливый тап выглядел как поломка
function gbToast(text) {
  var span = document.querySelector('#placement-hint span');
  if (!span) return;
  if (!span.dataset.base) span.dataset.base = span.textContent;
  span.textContent = text;
  clearTimeout(dropHintTimer);
  dropHintTimer = setTimeout(function() {
    if (span.dataset.base) span.textContent = span.dataset.base;
    delete span.dataset.base;
  }, 2200);
}

function handleFighterLandingTap(cellX, cellY) {
  // Тап мимо разрешённой зоны не молчит: подсказываем, куда садиться
  if (!fighterLandCellAllowed(cellX, cellY)) {
    gbToast(iAmAttacker ? 'Садиться можно только в полосе вторжения'
                        : 'Садиться можно только в зону высадки');
    return;
  }
  if (!isBoxFree(buildOccupancy(), cellX, cellY, 1, 1)) {
    gbToast('Клетка занята');
    return;
  }
  if (landingBusy) return;
  landingBusy = true;

  var f = landingFighter;
  supabase.rpc('land_fighter', {
    p_fighter_id: f.fighter_id, p_x: cellX, p_y: cellY
  }).then(function(r) {
    landingBusy = false;
    if (r.error) { alert('Не удалось посадить: ' + gbErr(r.error)); return; }
    cancelDrop();
    loadUnits();
    loadDropCargo();
  }, function() { landingBusy = false; });
}

function cancelDrop() {
  droppingUnit = null;
  droppingVehicle = null;
  landingFighter = null;
  document.getElementById('placement-hint').style.display = 'none';

  updateDropBtn();

  setBottomInset(0);
  if (typeof dtAfterCancel === 'function') dtAfterCancel();
}

// Подсветка свободных клеток полосы вторжения
function drawDropCells() {
  if (!droppingUnit && !droppingVehicle && !landingFighter) return;

  var vw = droppingVehicle ? droppingVehicle.width_cells : 1;
  var vh = droppingVehicle ? droppingVehicle.height_cells : 1;

  var occupied = buildOccupancy();

  // На своей планете высадка (пехота, техника, посадка истребителя) идёт в зоны
  // высадки: красим их свободные клетки тем же зелёным, что и при найме.
  // Полоса вторжения хозяину не подсвечивается нигде, в том числе из лотка
  if (!iAmAttacker) {
    // клетка зелёная ровно тогда, когда касание по ней примет лоток (dtTapPlace → dtWhy): рамка машины
    // встаёт центром на клетку, вся — в зоне высадки и на свободном месте (у пехоты — сама клетка)
    var lit = {}, ox = Math.floor((vw - 1) / 2), oy = Math.floor((vh - 1) / 2);
    deployZones.forEach(function(zone) {
      var size = zone.size || DEPLOY_SIZE;
      for (var dx = 0; dx < size; dx++) {
        for (var dy = 0; dy < size; dy++) {
          var cx = zone.x + dx, cy = zone.y + dy, bx = cx - ox, by = cy - oy, ok = isBoxFree(occupied, bx, by, vw, vh);
          for (var ix = 0; ok && ix < vw; ix++) for (var iy = 0; ok && iy < vh; iy++) if (!fighterLandCellAllowed(bx + ix, by + iy)) ok = false;
          if (ok) lit[cx + ',' + cy] = 1;
        }
      }
    });
    ctx.fillStyle = 'rgba(95,217,104,0.25)';
    Object.keys(lit).forEach(function(k) {
      var p = k.split(','), lx = +p[0], ly = +p[1];
      ctx.fillRect(lx * CELL_PX + 3, ly * CELL_PX + 3, CELL_PX - 6, CELL_PX - 6);
    });
    return;
  }

  var y0 = GRID_SIZE - ATTACK_ZONE_H;
  for (var cy = y0; cy < GRID_SIZE; cy++) {
    for (var cx = 0; cx < GRID_SIZE; cx++) {
      if (!isBoxFree(occupied, cx, cy, vw, vh)) continue;
      ctx.fillStyle = 'rgba(217,74,74,0.22)';
      ctx.fillRect(cx * CELL_PX + 3, cy * CELL_PX + 3,
                   CELL_PX * vw - 6, CELL_PX * vh - 6);
    }
  }
}

// Переключатель режима стройки прямо на карте: осмотр и наём войск —
// в обычном режиме, а слоты и постройка зданий — по этой кнопке.
function initBuildToggle(isSpace) {
  if (!isController) return;

  var btn = document.createElement('button');
  btn.id = 'build-toggle';
  btn.textContent = buildMode ? 'Выйти из стройки' : 'Строительство';
  if (buildMode) btn.classList.add('active');
  document.body.appendChild(btn);

  btn.addEventListener('click', function() {
    var page = isSpace ? 'space-battle.html' : 'ground-battle.html';
    window.location.href = page + '?system=' + systemId + (buildMode ? '' : '&mode=build');
  });
}

// ===== Древо развития одарённого =====
// Полотно листается и масштабируется как галактическая карта: узлов
// двенадцать у джедая и тринадцать у ситха, списком это не читается.

var TREE_STEP_X = 150;      // расстояние между ветками
var TREE_STEP_Y = 165;      // расстояние между ступенями
var TREE_NODE = 96;         // сторона узла
var TREE_PAD = 70;          // поля вокруг полотна

var treeUnit = null;
var treeNodes = [];
var treePan = { x: 0, y: 0, scale: 1 };

function openHeroTree(unit) {
  treeUnit = unit;

  var panel = document.getElementById('tree-panel');
  var title = document.getElementById('tree-title');
  var info = document.getElementById('tree-info');

  title.textContent = 'Развитие · ' + (unit.hero_name || 'одарённый');   // textContent — без экранирования
  info.innerHTML = '<div class="tree-hint">Загрузка...</div>';
  panel.style.display = 'flex';

  supabase.rpc('get_hero_tree', { p_hero_id: unit.hero_id }).then(function(res) {
    if (res.error) {
      info.innerHTML = '<div class="tree-hint">Не удалось прочитать древо</div>';
      return;
    }
    treeNodes = res.data || [];
    buildHeroTree();
  });
}

function closeHeroTree() {
  document.getElementById('tree-panel').style.display = 'none';
  treeUnit = null;
  treeNodes = [];
}

function buildHeroTree() {
  var world = document.getElementById('tree-world');
  var nodesBox = document.getElementById('tree-nodes');
  var svg = document.getElementById('tree-links');

  var maxCol = 0, maxRow = 0;
  treeNodes.forEach(function(n) {
    maxCol = Math.max(maxCol, parseFloat(n.tree_col));
    maxRow = Math.max(maxRow, parseFloat(n.tree_row));
  });

  var w = TREE_PAD * 2 + maxCol * TREE_STEP_X + TREE_NODE;
  var h = TREE_PAD * 2 + maxRow * TREE_STEP_Y + TREE_NODE;

  world.style.width = w + 'px';
  world.style.height = h + 'px';
  svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
  svg.setAttribute('width', w);
  svg.setAttribute('height', h);

  var pos = {};
  treeNodes.forEach(function(n) {
    pos[n.ability_id] = {
      x: TREE_PAD + parseFloat(n.tree_col) * TREE_STEP_X,
      y: TREE_PAD + parseFloat(n.tree_row) * TREE_STEP_Y
    };
  });

  // Связи рисуем первыми, чтобы узлы легли поверх
  var links = '';
  treeNodes.forEach(function(n) {
    (n.requires || []).forEach(function(req) {
      var a = pos[req], b = pos[n.ability_id];
      if (!a || !b) return;
      var x1 = a.x + TREE_NODE / 2, y1 = a.y + TREE_NODE;
      var x2 = b.x + TREE_NODE / 2, y2 = b.y;
      var mid = (y1 + y2) / 2;
      var done = n.learned || n.unlocked;
      links += '<path d="M' + x1 + ' ' + y1 +
               ' C' + x1 + ' ' + mid + ' ' + x2 + ' ' + mid + ' ' + x2 + ' ' + y2 + '" ' +
               'class="tree-link' + (done ? ' open' : '') + '"/>';
    });
  });
  svg.innerHTML = links;

  nodesBox.innerHTML = '';
  treeNodes.forEach(function(n) {
    var p = pos[n.ability_id];
    var el = document.createElement('button');

    var state = n.learned ? 'learned'
              : n.in_training ? 'training'
              : n.unlocked ? 'open' : 'locked';

    el.className = 'tree-node ' + state;
    el.style.left = p.x + 'px';
    el.style.top = p.y + 'px';
    el.innerHTML = '<img src="../' + n.icon + '" alt="">' +
                   '<span class="tree-node-name">' + n.name + '</span>' +
                   (n.kind === 'passive' ? '<i class="tree-node-kind">пассив</i>' : '');

    el.addEventListener('click', function(e) {
      e.stopPropagation();
      selectTreeNode(n.ability_id);
    });

    nodesBox.appendChild(el);
  });

  // Ставим полотно так, чтобы первый доступный узел был на виду
  var vp = document.getElementById('tree-viewport');
  treePan.scale = 1;
  treePan.x = (vp.clientWidth - w) / 2;
  treePan.y = 20;
  clampTreePan();
  applyTreePan();

  var first = null;
  for (var i = 0; i < treeNodes.length; i++) {
    if (!treeNodes[i].learned && treeNodes[i].unlocked) { first = treeNodes[i]; break; }
  }
  selectTreeNode(first ? first.ability_id : (treeNodes[0] || {}).ability_id);
}

function selectTreeNode(id) {
  var nodes = document.querySelectorAll('.tree-node');
  var idx = 0;
  treeNodes.forEach(function(n) {
    if (nodes[idx]) nodes[idx].classList.toggle('active', n.ability_id === id);
    idx++;
  });

  var n = null;
  treeNodes.forEach(function(x) { if (x.ability_id === id) n = x; });

  var info = document.getElementById('tree-info');
  if (!n) { info.innerHTML = ''; return; }

  var lack = [];
  if (!n.unlocked) lack.push('нужна предыдущая ступень');
  if (n.kills_have < n.kills_required) {
    lack.push('убитых ' + n.kills_have + ' из ' + n.kills_required);
  }

  var head = '<div class="tree-info-head">' +
      '<span class="tree-info-name">' + n.name + '</span>' +
      '<span class="tree-info-branch">' + n.branch + ' · ступень ' + n.tier + '</span>' +
    '</div>' +
    '<div class="tree-info-desc">' + n.description + '</div>';

  var meta = '<div class="tree-info-meta">' +
      '<span>' + n.cost_credits + ' кр</span>' +
      '<span>' + n.kills_required + ' убитых</span>' +
      '<span>' + formatLeft(n.train_seconds) + '</span>' +
    '</div>';

  info.innerHTML = head + meta;

  if (n.learned) {
    info.innerHTML += '<div class="tree-hint done">Освоено</div>';
    return;
  }
  if (n.in_training) {
    info.innerHTML += '<div class="tree-hint">Обучение идёт</div>';
    return;
  }
  if (lack.length) {
    info.innerHTML += '<div class="tree-hint">Не хватает: ' + lack.join(', ') + '</div>';
    return;
  }

  var go = document.createElement('button');
  go.className = 'tree-go';
  go.textContent = 'Начать обучение · ' + n.cost_credits;
  go.addEventListener('click', function() {
    go.disabled = true;
    supabase.rpc('start_hero_training', {
      p_unit_id: treeUnit.id,
      p_ability_id: n.ability_id
    }).then(function(r) {
      go.disabled = false;
      if (r.error) { alert('Не вышло: ' + gbErr(r.error)); return; }
      closeHeroTree();
      selectedUnit = null;
      hidePickup();
      loadUnits();
    });
  });
  info.appendChild(go);
}

// ===== панорамирование и масштаб полотна =====

function clampTreePan() {
  var vp = document.getElementById('tree-viewport');
  var world = document.getElementById('tree-world');
  var w = world.offsetWidth * treePan.scale;
  var h = world.offsetHeight * treePan.scale;

  // Если полотно уже влезает — держим по центру, иначе не даём уехать за край
  if (w <= vp.clientWidth) treePan.x = (vp.clientWidth - w) / 2;
  else treePan.x = Math.min(0, Math.max(vp.clientWidth - w, treePan.x));

  if (h <= vp.clientHeight) treePan.y = (vp.clientHeight - h) / 2;
  else treePan.y = Math.min(0, Math.max(vp.clientHeight - h, treePan.y));
}

function applyTreePan() {
  var world = document.getElementById('tree-world');
  world.style.transform = 'translate(' + treePan.x + 'px,' + treePan.y + 'px) ' +
                          'scale(' + treePan.scale + ')';
}

function initTreeGestures() {
  var vp = document.getElementById('tree-viewport');
  var drag = null, pinch = null, moved = 0;

  var dist = function(t) {
    var dx = t[0].clientX - t[1].clientX, dy = t[0].clientY - t[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
  };
  var mid = function(t) {
    return { x: (t[0].clientX + t[1].clientX) / 2,
             y: (t[0].clientY + t[1].clientY) / 2 };
  };

  vp.addEventListener('touchstart', function(e) {
    if (e.touches.length === 2) {
      var m = mid(e.touches), r = vp.getBoundingClientRect();
      pinch = { d: dist(e.touches), scale: treePan.scale,
                ax: m.x - r.left, ay: m.y - r.top,
                wx: (m.x - r.left - treePan.x) / treePan.scale,
                wy: (m.y - r.top - treePan.y) / treePan.scale };
      drag = null;
    } else if (e.touches.length === 1) {
      drag = { x: e.touches[0].clientX - treePan.x,
               y: e.touches[0].clientY - treePan.y };
      pinch = null;
      moved = 0;
    }
  }, { passive: true });

  vp.addEventListener('touchmove', function(e) {
    if (pinch && e.touches.length === 2) {
      var k = dist(e.touches) / (pinch.d || 1);
      treePan.scale = Math.max(0.45, Math.min(1.6, pinch.scale * k));
      // Тянем к пальцам: точка под пинчем остаётся на месте
      treePan.x = pinch.ax - pinch.wx * treePan.scale;
      treePan.y = pinch.ay - pinch.wy * treePan.scale;
      clampTreePan();
      applyTreePan();
      e.preventDefault();
    } else if (drag && e.touches.length === 1) {
      var nx = e.touches[0].clientX - drag.x;
      var ny = e.touches[0].clientY - drag.y;
      moved += Math.abs(nx - treePan.x) + Math.abs(ny - treePan.y);
      treePan.x = nx; treePan.y = ny;
      clampTreePan();
      applyTreePan();
      if (moved > 8) e.preventDefault();
    }
  }, { passive: false });

  vp.addEventListener('touchend', function(e) {
    if (e.touches.length === 0) { drag = null; pinch = null; }
  }, { passive: true });

  document.getElementById('tree-close')
    .addEventListener('click', closeHeroTree);
}

// ===== Запас планеты =====
// Ресурсы лежат на планете, а не в кошельке, поэтому показываем их там,
// где принимается решение — прямо в панели строительства.

var planetStock = [];

// Справочник ресурсов держим отдельно от запаса планеты. Запас приходит
// только по своим планетам и позже, чем рисуются карточки, поэтому
// названия из него не успевали подставиться и в панели светились коды.
var resourceNames = {};
var resourceColors = {};

function loadResourceNames(done) {
  if (Object.keys(resourceNames).length) { if (done) done(); return; }

  supabase.from('resources').select('id, name, color').then(function(res) {
    (res.error ? [] : (res.data || [])).forEach(function(r) {
      resourceNames[r.id] = r.name;
      resourceColors[r.id] = r.color;
    });
    if (done) done();
  });
}

function loadPlanetStock(done) {
  supabase.rpc('get_planet_stock', { p_system_id: systemId }).then(function(res) {
    planetStock = (res.error || !res.data) ? [] : res.data;
    if (done) done();
  });
}

function stockRow(resourceId) {
  for (var i = 0; i < planetStock.length; i++) {
    if (planetStock[i].resource === resourceId) return planetStock[i];
  }
  return null;
}

// Пока справочник не пришёл (или запрос сорвался), код ресурса не должен
// всплывать латиницей — держим русские названия под рукой
var RESOURCE_NAMES_RU = {
  ore: 'Руда', gas: 'Тибанна', crystals: 'Кристаллы', food: 'Продовольствие',
  durasteel: 'Дюрасталь', electronics: 'Электроника', cells: 'Топливные ячейки'
};

function resourceName(resourceId) {
  if (resourceNames[resourceId]) return resourceNames[resourceId];
  var r = stockRow(resourceId);
  return r ? r.name : (RESOURCE_NAMES_RU[resourceId] || resourceId);
}

// Есть ли на планете это сырьё — основное или попутное
function planetHasResource(resourceId) {
  var r = stockRow(resourceId);
  return !!r && (r.is_primary || r.is_secondary);
}

// Что цех потребляет за сутки: {"ore":60} превращается в «60 руды»
function consumesText(consumes) {
  if (!consumes) return '';
  var parts = [];
  for (var key in consumes) {
    if (!Object.prototype.hasOwnProperty.call(consumes, key)) continue;
    parts.push(consumes[key] + ' ' + resourceName(key).toLowerCase());
  }
  return parts.join(' + ');
}

// Попутное сырьё добывается вдвое медленнее — то же правило, что на сервере
function canAffordResources(cost) {
  if (!cost) return true;
  for (var key in cost) {
    if (!Object.prototype.hasOwnProperty.call(cost, key)) continue;
    var row = stockRow(key);
    if (!row || row.amount < cost[key]) return false;
  }
  return true;
}

function stockRateFor(type) {
  var r = stockRow(type.produces_resource);
  if (r && r.is_secondary && !r.is_primary) return Math.floor(type.produces_per_day / 2);
  return type.produces_per_day;
}

function renderStockStrip(slotIndex) {
  var box = document.getElementById('build-panel-box');
  var old = document.getElementById('stock-strip');
  if (old) old.remove();

  if (!planetStock.length) return;

  var strip = document.createElement('div');
  strip.id = 'stock-strip';

  var cap = planetStock[0].cap;
  strip.innerHTML = '<div class="stock-head">Запас планеты · предел ' + cap + '</div>';

  var row = document.createElement('div');
  row.className = 'stock-row';

  planetStock.forEach(function(r) {
    // Чего на планете нет и не производится — не засоряем строку
    if (!r.amount && !r.per_day && !r.is_primary && !r.is_secondary) return;

    var cell = document.createElement('div');
    cell.className = 'stock-cell';

    if (r.is_primary) cell.classList.add('primary');
    else if (r.is_secondary) cell.classList.add('secondary');

    // Цвет ресурса кромкой слева — тот же, что на плашках в карточке планеты
    if (r.color) cell.style.borderLeft = '3px solid ' + r.color;

    if (r.cap && r.amount >= r.cap) cell.classList.add('full');

    cell.innerHTML =
      '<span class="stock-name">' + r.name + '</span>' +
      '<span class="stock-val">' + r.amount + '</span>' +
      '<span class="stock-rate">' +
        (r.per_day ? '+' + r.per_day + ' в сутки'
         : r.is_primary ? 'нужна добыча'
         : r.is_secondary ? 'попутное' : '') +
      '</span>';

    row.appendChild(cell);
  });

  strip.appendChild(row);

  var title = box.querySelector('.build-panel-title');
  box.insertBefore(strip, title ? title.nextSibling : box.firstChild);
}

// ===== Панель построек: торговый пост и экономические постройки =====
// Одно окно (#logi-panel) на постройки без своего экрана. Хаб открывает общий экран «Снабжение» (js/supply.js),
// старая панель хаба с конвоями и рынком удалена в шаге 5 уборки снабжения.

var logiBuilding = null;

function closeLogisticsPanel() {
  document.getElementById('logi-panel').style.display = 'none';
  logiBuilding = null;
}

function logiSection(title) {
  var d = document.createElement('div');
  d.className = 'logi-section';
  d.textContent = title;
  return d;
}

// Счётчик с крупным шагом: ресурсы считают десятками
function logiAmount(max) {
  var box = document.createElement('div');
  box.className = 'logi-qty';

  var minus = document.createElement('button');
  minus.className = 'logi-qty-btn'; minus.textContent = '−';
  var val = document.createElement('span');
  val.className = 'logi-qty-value'; val.textContent = Math.min(10, max);
  var plus = document.createElement('button');
  plus.className = 'logi-qty-btn'; plus.textContent = '+';
  var all = document.createElement('button');
  all.className = 'logi-qty-btn'; all.textContent = 'всё';

  minus.addEventListener('click', function() {
    val.textContent = Math.max(1, parseInt(val.textContent, 10) - 10);
  });
  plus.addEventListener('click', function() {
    val.textContent = Math.min(max, parseInt(val.textContent, 10) + 10);
  });
  all.addEventListener('click', function() { val.textContent = max; });

  box.appendChild(minus); box.appendChild(val); box.appendChild(plus); box.appendChild(all);
  box.valueEl = val;
  return box;
}

// ===== Торговый пост =====
// Клапан для забитых складов: сбыть излишки сразу в кредиты, без поиска
// покупателя и без перевозки. Платит меньше рынка — в этом и смысл.
// Окно — общая панель построек (#logi-panel).

function openTradePanel(building) {
  logiBuilding = building;
  document.getElementById('logi-panel').style.display = 'flex';
  document.getElementById('logi-title').textContent =
    (building.building_types || {}).name || 'Торговый пост';
  renderTradePanel();
}

// Торговый пост: продажа излишков склада планеты NPC. Сверху — из чего цена (доля базовой и поправка событий
// галактики), ниже — карточка на ресурс: ромб и цена, сколько на складе и сколько дадут за выбранное число,
// счётчик и «Продать». Ответ продажи приходит, даже если панель уже закрыли — тогда его просто не рисуем.
// Итог продажи и ошибки — строкой в самой панели.
function renderTradePanel(msg) {
  var building = logiBuilding;
  if (!building) return;
  var sysId = building.system_id;
  var body = document.getElementById('logi-body');
  if (!msg) body.innerHTML = '<div class="logi-empty">Загрузка...</div>';

  Promise.all([
    supabase.rpc('get_trade_prices', { p_system_id: sysId }),
    supabase.rpc('get_trade_post_info').then(null, function() { return { data: null }; })
  ]).then(function(res) {
      if (logiBuilding !== building) return;                      // панель закрыли или открыли другую
      if (res[0].error) {
        body.innerHTML = '<div class="logi-empty">Цены не загрузились — закрой и открой пост ещё раз</div>';
        return;
      }

      var rows = (res[0].data || []).filter(function(r) { return r.amount > 0; });
      var info = res[1] && res[1].data;

      body.innerHTML = '';
      if (info) {
        var mod = Number(info.mod) || 0;
        var head = document.createElement('div');
        head.className = 'eco-card trade-head';
        head.innerHTML =
          '<div class="eco-what">Пост платит <b>' + (Number(info.pct) || 60) + '%</b> базовой цены</div>' +
          '<div class="eco-status ' + (mod > 0 ? 'ok' : mod < 0 ? 'bad' : 'dim') + '">' +
            (mod > 0 ? 'Событие в галактике: цены выше на ' + mod + '%'
             : mod < 0 ? 'Событие в галактике: цены ниже на ' + (-mod) + '%'
             : 'События в галактике цены сейчас не двигают') + '</div>';
        body.appendChild(head);
      }
      body.appendChild(logiSection('Скупка излишков'));

      var line = document.createElement('div');
      line.className = 'logi-trade-msg' + (msg ? ' ' + msg.cls : '');
      line.textContent = msg ? msg.text : '';
      body.appendChild(line);

      if (!rows.length) {
        var e = document.createElement('div');
        e.className = 'logi-empty';
        e.textContent = 'На складе планеты пусто — продавать нечего';
        body.appendChild(e);
        return;
      }

      rows.forEach(function(r) {
        var row = document.createElement('div');
        row.className = 'trade-row';
        if (r.color) row.style.borderLeftColor = r.color;

        var top = document.createElement('div');
        top.className = 'trade-top';
        top.innerHTML =
          '<span class="trade-name"><i' + (r.color ? ' style="background:' + escHtml(r.color) + '"' : '') + '></i>' + escHtml(r.name) + '</span>' +
          '<span class="trade-price"><b>' + r.price + '</b> кр/ед</span>';
        row.appendChild(top);

        var sub = document.createElement('div');
        sub.className = 'trade-sub';
        row.appendChild(sub);

        var ctl = document.createElement('div');
        ctl.className = 'trade-ctl';
        var qty = logiAmount(r.amount);
        ctl.appendChild(qty);

        // сколько дадут — за то число, что сейчас на счётчике
        function paintSum() {
          var n = parseInt(qty.valueEl.textContent, 10) || 0;
          sub.innerHTML = 'на складе ' + r.amount + ' · за ' + n + ' дадут <b>' + (n * r.price) + ' кр</b>';
        }
        qty.addEventListener('click', function() { setTimeout(paintSum, 0); });
        paintSum();

        var sell = document.createElement('button');
        sell.className = 'logi-go small';
        sell.textContent = 'Продать';
        sell.addEventListener('click', function() {
          var n = parseInt(qty.valueEl.textContent, 10);
          if (!(n > 0)) return;
          sell.disabled = true;
          supabase.rpc('sell_to_trade_post', { p_system_id: sysId, p_resource: r.resource, p_amount: n })
            .then(function(r2) {
              if (logiBuilding !== building) return;
              sell.disabled = false;
              if (r2.error) {
                var m = r2.error.message || '';
                line.className = 'logi-trade-msg bad';
                line.textContent = /[А-Яа-яЁё]/.test(m) ? m : 'Не продалось — попробуй ещё раз';
                return;
              }
              // Счётчик кредитов обновится сам: он слушает profiles по realtime
              renderTradePanel({ cls: 'ok', text: 'Продано: ' + String(r.name || '').toLowerCase() + ' ' + n + ' · +' + (r2.data || n * r.price) + ' кр' });
            }, function() {
              if (logiBuilding !== building) return;
              sell.disabled = false;
              line.className = 'logi-trade-msg bad';
              line.textContent = 'Нет связи с сервером';
            });
        });
        ctl.appendChild(sell);
        row.appendChild(ctl);

        body.appendChild(row);
      });

      var note = document.createElement('div');
      note.className = 'logi-note';
      note.textContent = 'Пост платит меньше, чем можно выручить на рынке. Зато сразу и без перевозки.';
      body.appendChild(note);
    }, function() {
      if (logiBuilding !== building) return;
      body.innerHTML = '<div class="logi-empty">Нет связи с сервером</div>';
    });
}

// ===== Разведка: чужие флоты на ближних гиперпутях =====
// Перехватить можно только то, о чём знаешь. Штаб показывает, кто идёт
// рядом, с чем и сколько ему осталось лететь.

function loadIntel(building, box) {
  supabase.rpc('get_enemy_transits', { p_system_id: building.system_id })
    .then(function(res) {
      if (res.error) {
        box.innerHTML = '<div class="intel-head">Разведка</div>' +
                        '<div class="intel-empty">Не удалось получить сводку</div>';
        return;
      }

      var rows = res.data || [];
      box.innerHTML = '<div class="intel-head">Разведка · чужие перелёты рядом</div>';

      if (!rows.length) {
        var e = document.createElement('div');
        e.className = 'intel-empty';
        e.textContent = 'Движения не замечено';
        box.appendChild(e);
        return;
      }

      rows.forEach(function(t) {
        var row = document.createElement('div');
        row.className = 'intel-row' + (t.cargo ? ' loaded' : '');

        row.innerHTML =
          '<div class="intel-info">' +
            '<div class="intel-route">' + t.from_name + ' → ' + t.to_name + '</div>' +
            '<div class="intel-sub">' + escHtml(t.owner_name) +
              ' · ' + escHtml(t.commander_name || 'без имени') +
              ' · кораблей ' + t.ships + '</div>' +
            (t.cargo
              ? '<div class="intel-cargo">Везут: ' + t.cargo + '</div>'
              : '<div class="intel-sub dim">Трюмы пусты</div>') +
          '</div>' +
          '<div class="intel-eta">' + formatLeft(t.seconds_left) + '</div>';

        box.appendChild(row);

        // Выйти наперехват можно только с конца того же пути: прыжок идёт
        // по прямой, из другого угла карты не дотянуться
        var reachable = t.lane_system &&
          (t.from_system === building.system_id || t.to_system === building.system_id);

        if (reachable) {
          var go = document.createElement('button');
          go.className = 'intel-go';
          go.textContent = 'Выйти на перехват';
          go.addEventListener('click', function() {
            go.disabled = true;
            showInterceptChoice(building, t, box, go);
          });
          box.appendChild(go);
        }
      });

      var note = document.createElement('div');
      note.className = 'intel-note';
      note.textContent = 'Сводка охватывает пути через эту систему и соседние.';
      box.appendChild(note);
    });
}

// Выбор командира для перехвата. Отдельным списком под строкой сводки:
// важно видеть, сколько кораблей у каждого уже стоит в зоне прыжка.
function showInterceptChoice(building, transit, box, btn) {
  var old = document.getElementById('intercept-choice');
  if (old) old.remove();

  supabase.rpc('get_my_commanders_at', { p_system_id: building.system_id })
    .then(function(res) {
      btn.disabled = false;

      var wrap = document.createElement('div');
      wrap.id = 'intercept-choice';
      wrap.className = 'intel-choice';

      var free = (res.error ? [] : (res.data || [])).filter(function(c) {
        return !c.busy && c.ships > 0;
      });

      if (!free.length) {
        wrap.innerHTML = '<div class="intel-empty">Свободных командиров с флотом ' +
                         'на этой планете нет</div>';
        box.insertBefore(wrap, btn.nextSibling);
        return;
      }

      wrap.innerHTML = '<div class="intel-choice-head">Кого отправить</div>';

      free.forEach(function(c) {
        var row = document.createElement('div');
        row.className = 'intel-cmd';

        var ok = c.ready === c.ships;
        row.innerHTML =
          '<div class="intel-info">' +
            '<div class="intel-route">' + escHtml(c.name || 'Без имени') + '</div>' +
            '<div class="intel-sub' + (ok ? '' : ' warn') + '">' +
              'в зоне прыжка ' + c.ready + ' из ' + c.ships + '</div>' +
          '</div>';

        var send = document.createElement('button');
        send.className = 'intel-go small';
        send.textContent = 'Вперёд';
        send.addEventListener('click', function() {
          send.disabled = true;
          supabase.rpc('start_interception', {
            p_commander_id: c.commander_id,
            p_target_commander: transit.commander_id
          }).then(function(r2) {
            send.disabled = false;
            if (r2.error) { alert(gbErr(r2.error)); return; }
            alert('Флот вышел на перехват. Встреча в пустоте на пути ' +
                  transit.from_name + ' — ' + transit.to_name + '.');
            wrap.remove();
            loadIntel(building, box);
          });
        });

        row.appendChild(send);
        wrap.appendChild(row);
      });

      box.insertBefore(wrap, btn.nextSibling);
    });
}

// ===== Экономические постройки =====
// Добыча, передел и склады не нанимают юнитов и не изучают, поэтому
// линия производства им ни к чему. Вместо неё — что постройка делает
// и что лежит на складе планеты. Окно открывается только владельцу:
// чужой видит нейтральную карточку, а сервер и сам не отдаёт состояние
// производства и запас никому, кроме хозяина планеты.

function isEconomyBuilding(code) {
  if (!code || !buildingTypes) return false;
  var t = null;
  for (var i = 0; i < buildingTypes.length; i++) {
    if (buildingTypes[i].code === code) { t = buildingTypes[i]; break; }
  }
  return !!t && (!!t.produces_resource || (t.storage_bonus || 0) > 0);
}

var ECONOMY_STATUS = {
  working:    { text: 'Работает',                          cls: 'ok' },
  building:   { text: 'Ещё строится',                      cls: 'dim' },
  no_deposit: { text: 'На планете нет залежи',             cls: 'bad' },
  no_input:   { text: 'Простаивает: не хватает сырья',     cls: 'warn' },
  no_room:    { text: 'Простаивает: склад переполнен',     cls: 'warn' },
  passive:    { text: 'Работает постоянно',                cls: 'ok' }
};

function openEconomyPanel(building) {
  logiBuilding = building;
  document.getElementById('logi-panel').style.display = 'flex';
  document.getElementById('logi-title').textContent =
    (building.building_types || {}).name || 'Постройка';

  var body = document.getElementById('logi-body');
  body.innerHTML = '<div class="logi-empty">Загрузка...</div>';

  var done = 0, status = null, capParts = null;
  function step() {
    done++;
    if (done < 4) return;
    if (logiBuilding !== building) return;                       // панель закрыли или открыли другую
    renderEconomyPanel(body, status, capParts);
  }

  supabase.rpc('get_building_status', { p_building_id: building.id }).then(function(res) {
    status = (!res.error && res.data && res.data.length) ? res.data[0] : null;
    step();
  });
  loadPlanetStock(step);
  loadResourceNames(step);
  // из чего сложился предел склада (sql/supply_buildings.sql) — главное, что показывает окно склада
  supabase.rpc('get_stock_cap_parts', { p_system_id: building.system_id }).then(function(res) {
    capParts = res.error ? null : res.data;
    step();
  }, step);
}

function renderEconomyPanel(body, st, capParts) {
  body.innerHTML = '';

  // --- что постройка делает ---
  if (st) {
    body.appendChild(logiSection(st.produces_resource ? 'Производство' : 'Назначение'));

    var card = document.createElement('div');
    card.className = 'eco-card';
    if (st.produces_color) card.style.borderLeftColor = st.produces_color;

    var what = '';
    var eats = consumesText(st.consumes);

    if (st.produces_resource && eats) {
      what = 'Перерабатывает ' + eats + ' → ' + st.produces_name + ' ' + st.per_day + ' в сутки';
    } else if (st.produces_resource) {
      what = 'Добывает ' + st.produces_name + ' · ' + st.per_day + ' в сутки';
    } else if (st.storage_bonus > 0) {
      what = 'Поднимает предел запаса планеты на ' + st.storage_bonus +
             ' по каждому ресурсу';
    } else {
      for (var bi = 0; bi < buildingTypes.length; bi++) {
        if (buildingTypes[bi].code === st.code) {
          what = buildingTypes[bi].description || '';
          break;
        }
      }
    }

    var stat = ECONOMY_STATUS[st.status] || ECONOMY_STATUS.working;
    var next = '';
    if (st.next_at && (st.status === 'working')) {
      var left = Math.max(0, Math.round((new Date(st.next_at).getTime() - gbServerNow()) / 1000));
      next = left > 0 ? ' · следующая выдача через ' + formatLeft(left) : ' · выдача вот-вот';
    }

    card.innerHTML =
      '<div class="eco-what">' + what + '</div>' +
      '<div class="eco-status ' + stat.cls + '">' + stat.text + next + '</div>';
    body.appendChild(card);

    // склад — часть снабжения: что отдавать в сеть и сколько держать, задаётся там
    if (st.storage_bonus > 0 && typeof openSupplyScreen === 'function') {
      var go = document.createElement('button');
      go.type = 'button';
      go.className = 'logi-go eco-supply';
      go.textContent = 'Правила склада — в «Снабжении»';
      go.addEventListener('click', function() {
        if (typeof closeLogisticsPanel === 'function') closeLogisticsPanel();
        openSupplyScreen('stores');
      });
      body.appendChild(go);
    }
  }

  // --- склад планеты ---
  var cap = planetStock.length ? planetStock[0].cap : 0;
  if (!cap && capParts) cap = Number(capParts.total) || 0;
  body.appendChild(logiSection('Склад планеты · предел ' + cap));

  // предел по частям: база, район «Склады», склады нынешней стороны планеты
  if (capParts) {
    var parts = ['<span><b>' + (Number(capParts.base) || 0) + '</b> база</span>'];
    if (Number(capParts.district) > 0) parts.push('<span><b>+' + Number(capParts.district) + '</b> район «Склады»</span>');
    var dn = Number(capParts.depot_count) || 0;
    parts.push(dn > 0
      ? '<span class="on"><b>+' + (Number(capParts.depots) || 0) + '</b> ' + dn + ' ' + (dn === 1 ? 'склад' : dn < 5 ? 'склада' : 'складов') + '</span>'
      : '<span class="dim">складов нет</span>');
    var cp = document.createElement('div');
    cp.className = 'eco-cap';
    cp.innerHTML = parts.join('<i>·</i>') + '<em>по каждому ресурсу</em>';
    body.appendChild(cp);
  }

  var rows = planetStock.filter(function(r) {
    return r.amount > 0 || r.per_day > 0 || r.is_primary || r.is_secondary;
  });

  if (!rows.length) {
    var e = document.createElement('div');
    e.className = 'logi-empty';
    e.textContent = 'Склад пуст';
    body.appendChild(e);
    return;
  }

  rows.forEach(function(r) {
    var row = document.createElement('div');
    row.className = 'eco-stock';
    var color = r.color || '#2a3644';
    row.style.borderLeftColor = color;

    var pct = cap ? Math.min(100, Math.round(r.amount / cap * 100)) : 0;
    var note = r.per_day ? '+' + r.per_day + ' в сутки'
             : r.is_primary ? 'основное, нужна добыча'
             : r.is_secondary ? 'попутное' : '';

    row.innerHTML =
      '<div class="eco-stock-top">' +
        '<span class="eco-stock-name"><i style="background:' + escHtml(color) + '"></i>' + escHtml(r.name) + '</span>' +
        '<span class="eco-stock-val' + (r.amount >= cap ? ' full' : '') + '">' +
          r.amount + '</span>' +
      '</div>' +
      '<div class="eco-bar"><i style="width:' + pct + '%;background:' + color + '"></i></div>' +
      (note ? '<div class="eco-stock-note">' + note + '</div>' : '');

    body.appendChild(row);
  });
}

// ===== Инженер и полевые постройки =====
// Окопы, бункеры, турели и прочее ставит инженер рядом с собой. Всё
// решает сервер: где можно строить, хватает ли денег и склада, кто кого
// видит. Клиент заранее подсвечивает подходящие клетки и рисует то, что
// пропустил туман войны: свои постройки фракция видит всегда, чужие —
// только в обзоре войск, а маскировочную сеть — лишь подойдя вплотную.

var fieldStructures = [];
var structTypeById = {};
var structResearchDone = {};
var structTimer = null;
var selectedStructure = null;
var placingStructure = null;      // { unit, type, preview }

var STRUCT_KIND_ROLE = {
  trench: 'Укрытие', bunker: 'Укрытие', camo: 'Маскировка', turret: 'Оборона',
  jammer: 'Радиоэлектроника', radar: 'Разведка', extractor: 'Добыча', cantina: 'Заработок'
};

function loadStructureTypes() {
  return supabase.from('structure_types').select('*').order('sort_order').then(function(r) {
    structTypeById = {};
    (r.error ? [] : (r.data || [])).forEach(function(t) { structTypeById[t.id] = t; });
  });
}

function loadStructures() {
  if (!systemId) return Promise.resolve();
  return supabase.from('field_structures').select('*').eq('system_id', systemId).then(function(res) {
    fieldStructures = (res.error || !res.data) ? [] : res.data;

    // Выбранная постройка могла исчезнуть или смениться прочность
    if (selectedStructure) {
      var fresh = fieldStructures.filter(function(s) { return s.id === selectedStructure.id; })[0];
      if (!fresh) { selectedStructure = null; hidePickup(); }
      else { selectedStructure = fresh; if (structPanelOpen()) openStructurePanel(fresh, true); }
    }

    updateStructTimer();
    if (window.sceneLoader) sceneLoader.mark('structures');
  });
}

function structReady(s) {
  return !s.completes_at || new Date(s.completes_at).getTime() <= gbServerNow();
}

// Пока что-то строится, раз в секунду перерисовываем отсчёт
function updateStructTimer() {
  var pending = fieldStructures.some(function(s) { return !structReady(s); });
  if (pending && !structTimer) {
    structTimer = setInterval(function() {
      var still = fieldStructures.some(function(s) { return !structReady(s); });
      if (selectedStructure && structPanelOpen()) paintStructStatus(selectedStructure);
      if (!still) {
        clearInterval(structTimer);
        structTimer = null;
        loadStructures();
      }
    }, 1000);
  }
}

function structSide(s) {
  if (s.owner_user_id === currentUserId) return 'mine';
  if (myFaction && s.faction === myFaction) return 'ally';
  return 'enemy';
}

var STRUCT_SIDE_COLOR = { mine: '#5fd968', ally: '#4a90d9', enemy: '#d94a4a' };

function structAt(cellX, cellY) {
  for (var i = fieldStructures.length - 1; i >= 0; i--) {
    var s = fieldStructures[i];
    if (cellX >= s.x && cellX < s.x + s.w && cellY >= s.y && cellY < s.y + s.h) return s;
  }
  return null;
}

// ---------- Отрисовка ----------

function drawStructures() {
  if (!fieldStructures.length) return;
  var now = gbServerNow();

  // Зоны своей маскировки — чтобы было видно, кого она укрывает
  fieldStructures.forEach(function(s) {
    var st = structTypeById[s.type_id];
    if (!st || st.kind !== 'camo' || structSide(s) === 'enemy' || !structReady(s)) return;
    var r = st.radius || 0;
    var zx = (s.x - r) * CELL_PX, zy = (s.y - r) * CELL_PX;
    var zw = (s.w + r * 2) * CELL_PX, zh = (s.h + r * 2) * CELL_PX;
    ctx.fillStyle = 'rgba(95,217,190,0.10)';
    ctx.fillRect(zx, zy, zw, zh);
    ctx.strokeStyle = 'rgba(95,217,190,0.55)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]);
    ctx.strokeRect(zx + 1, zy + 1, zw - 2, zh - 2);
    ctx.setLineDash([]);
  });

  fieldStructures.forEach(function(s) {
    var st = structTypeById[s.type_id] || {};
    var px = s.x * CELL_PX, py = s.y * CELL_PX;
    var w = s.w * CELL_PX, h = s.h * CELL_PX;
    var ready = !s.completes_at || new Date(s.completes_at).getTime() <= now;
    var color = STRUCT_SIDE_COLOR[structSide(s)];

    // Тень под постройкой: картинка вырезана, без неё она «висит» над травой
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.30)';
    ctx.beginPath();
    ctx.ellipse(px + w / 2, py + h * 0.78, w * 0.46, h * 0.20, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    var img = getBuildingImage(st.image);
    ctx.save();
    if (!ready) ctx.globalAlpha = 0.5;
    if (img && img.complete && !img.failed && img.naturalWidth > 0) {
      gbDrawImage(img, px + 1, py + 1, w - 2, h - 2);
    } else {
      ctx.fillStyle = 'rgba(217,169,64,0.30)';
      ctx.fillRect(px + 2, py + 2, w - 4, h - 4);
    }
    ctx.restore();

    // Уголки цвета стороны: своё, союзное, вражеское — видно сразу
    var len = Math.max(6, Math.min(w, h) * 0.26);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(px + 1, py + 1 + len); ctx.lineTo(px + 1, py + 1); ctx.lineTo(px + 1 + len, py + 1);
    ctx.moveTo(px + w - 1 - len, py + 1); ctx.lineTo(px + w - 1, py + 1); ctx.lineTo(px + w - 1, py + 1 + len);
    ctx.moveTo(px + w - 1, py + h - 1 - len); ctx.lineTo(px + w - 1, py + h - 1); ctx.lineTo(px + w - 1 - len, py + h - 1);
    ctx.moveTo(px + 1 + len, py + h - 1); ctx.lineTo(px + 1, py + h - 1); ctx.lineTo(px + 1, py + h - 1 - len);
    ctx.stroke();

    if (!ready) {
      drawStructProgress(s, px, py, w, h, now);
    } else if (st.max_hp && s.hp < st.max_hp) {
      var pct = Math.max(0, s.hp / st.max_hp);
      ctx.fillStyle = 'rgba(5,6,10,0.8)';
      ctx.fillRect(px + 3, py + 3, w - 6, 4);
      ctx.fillStyle = pct > 0.6 ? '#5fd968' : pct > 0.3 ? '#d9a940' : '#d94a4a';
      ctx.fillRect(px + 3, py + 3, (w - 6) * pct, 4);
    }

    if (selectedStructure && selectedStructure.id === s.id) {
      ctx.strokeStyle = '#d9a940';
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 4]);
      ctx.strokeRect(px - 2, py - 2, w + 4, h + 4);
      ctx.setLineDash([]);
    }
  });
}

function drawStructProgress(s, px, py, w, h, now) {
  var st = structTypeById[s.type_id] || {};
  var endMs = new Date(s.completes_at).getTime();
  var total = (st.build_seconds || 60) * 1000;
  var progress = 1 - (endMs - now) / total;
  if (progress < 0) progress = 0;
  if (progress > 1) progress = 1;

  var barH = Math.max(3, h * 0.08);
  var barY = py + h - barH - 3;
  ctx.fillStyle = 'rgba(5,6,10,0.8)';
  ctx.fillRect(px + 3, barY, w - 6, barH);
  ctx.fillStyle = '#4a90d9';
  ctx.fillRect(px + 3, barY, (w - 6) * progress, barH);

  var left = Math.max(0, Math.ceil((endMs - now) / 1000));
  var mm = Math.floor(left / 60), ss = left % 60;
  var label = mm > 0 ? (mm + ':' + (ss < 10 ? '0' : '') + ss) : (ss + 'с');

  ctx.font = 'bold ' + Math.max(9, Math.round(Math.min(w, 64) * 0.26)) + 'px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(5,6,10,0.9)';
  ctx.strokeText(label, px + w / 2, barY - 2);
  ctx.fillStyle = '#cfd8dc';
  ctx.fillText(label, px + w / 2, barY - 2);
}

// ---------- Где можно поставить ----------
// Те же правила, что у сервера в build_structure. Сервер всё равно
// перепроверит, но подсветка должна обещать только реальные места.

function boxOverlap(ax, ay, aw, ah, bx, by, bw, bh) {
  return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
}

function structPlaceProblem(unit, st, x, y) {
  var w = st.width_cells || 1, h = st.height_cells || 1;

  // дальность не проверяем: в бою 2.0 инженер сам идёт к месту (сервер боёв, onBuild)
  if (x < 0 || y < 0 || x + w > GRID_SIZE || y + h > GRID_SIZE) return 'за краем карты';
  if (y + h > GRID_SIZE - ATTACK_ZONE_H) return 'в полосе вторжения не строят';

  for (var i = 0; i < deployZones.length; i++) {
    var z = deployZones[i];
    if (boxOverlap(x, y, w, h, z.x, z.y, z.size || DEPLOY_SIZE, z.size || DEPLOY_SIZE)) {
      return 'зона высадки должна оставаться свободной';
    }
  }
  // Кольцо захвата вокруг поселения всегда свободно — как и на сервере
  var sz = settlementZone || settlement;
  if (sz && boxOverlap(x, y, w, h, sz.x, sz.y, sz.size, sz.size)) {
    return 'у поселения не строят: кольцо захвата должно быть свободным';
  }
  for (var k = 0; k < buildSlots.length; k++) {
    if (boxOverlap(x, y, w, h, buildSlots[k].x, buildSlots[k].y, SLOT_SIZE, SLOT_SIZE)) {
      return 'здесь участок под здание';
    }
  }
  for (var j = 0; j < fieldStructures.length; j++) {
    var s = fieldStructures[j];
    if (boxOverlap(x, y, w, h, s.x, s.y, s.w, s.h)) return 'место занято укреплением';
  }
  for (var n = 0; n < unitsOnMap.length; n++) {
    var u = unitsOnMap[n];
    if (u.x === null || u.x === undefined) continue;
    var b = unitBox(u);
    if (!boxOverlap(x, y, w, h, u.x, u.y, b.w, b.h)) continue;
    var ut = unitTypeById[u.unit_type] || {};
    if (!st.enterable) return 'место занято';
    if (u.faction !== myFaction) return 'место занято';
    if (st.infantry_only && ut.is_vehicle) return 'здесь стоит техника — окоп, бункер и сеть только для пехоты';
  }
  return null;
}

// Тап по клетке: у больших построек палец попадает в середину, а не в угол
function structAnchor(st, cellX, cellY) {
  return {
    x: cellX - Math.floor(((st.width_cells || 1) - 1) / 2),
    y: cellY - Math.floor(((st.height_cells || 1) - 1) / 2)
  };
}

function drawStructPlacement() {
  var p = placingStructure;
  var st = p.type;
  var w = st.width_cells || 1, h = st.height_cells || 1;

  // место выбирает игрок где угодно на карте — инженер дойдёт сам; здесь только превью
  if (!p.preview) return;

  var pv = p.preview;
  var px = pv.x * CELL_PX, py = pv.y * CELL_PX;
  var img = getBuildingImage(st.image);
  ctx.save();
  ctx.globalAlpha = 0.72;
  if (img && img.complete && !img.failed && img.naturalWidth > 0) {
    gbDrawImage(img, px + 1, py + 1, w * CELL_PX - 2, h * CELL_PX - 2);
  }
  ctx.restore();
  ctx.fillStyle = pv.problem ? 'rgba(217,74,74,0.25)' : 'rgba(95,217,104,0.18)';
  ctx.fillRect(px, py, w * CELL_PX, h * CELL_PX);
  ctx.strokeStyle = pv.problem ? '#d94a4a' : '#5fd968';
  ctx.lineWidth = 3;
  ctx.strokeRect(px + 1, py + 1, w * CELL_PX - 2, h * CELL_PX - 2);
}

// ---------- Каталог построек инженера ----------

function structTypesForMe() {
  return Object.keys(structTypeById).map(function(k) { return structTypeById[k]; })
    .filter(function(t) { return t.faction === myFaction; })
    .sort(function(a, b) { return (a.sort_order || 0) - (b.sort_order || 0); });
}

function structCountHere(typeId) {
  return fieldStructures.filter(function(s) { return s.type_id === typeId; }).length;
}

function structEffectLine(st) {
  switch (st.kind) {
    case 'trench':    return 'урон по бойцу −' + st.cover_pct + '% · ответный огонь';
    case 'bunker':    return 'урон по пехоте −' + st.cover_pct + '% · её урон ×' + Number(st.damage_mult);
    case 'camo':      return 'прячет своих в ' + (st.width_cells + st.radius * 2) + '×' +
                             (st.height_cells + st.radius * 2) + ' клетках';
    case 'turret':    return 'урон ' + st.damage + ' · радиус ' + st.radius + ' · раз в ' +
                             Math.round(st.cooldown_seconds / 60) + ' мин';
    case 'jammer':    return 'сжигает разведчиков в ' + st.radius + ' клетках вокруг';
    case 'radar':     return 'видит всех врагов в ' + st.radius + ' клетках вокруг, даже под маскировкой';
    case 'extractor': return '+' + st.produces_per_day + ' ' +
                             resourceName(st.produces_resource).toLowerCase() + ' в сутки';
    case 'cantina':   return '+' + st.credits_per_day + ' кр. в сутки · довольство +' + st.satisfaction_bonus;
    default:          return '';
  }
}

function formatBuildTime(sec) {
  if (sec >= 60) return Math.floor(sec / 60) + ' мин' + (sec % 60 ? ' ' + (sec % 60) + ' с' : '');
  return sec + ' с';
}

function openStructureBuildPanel(unit) {
  var panel = document.getElementById('build-panel');
  var list = document.getElementById('build-panel-list');
  var box = document.getElementById('build-panel-box');
  var title = box.querySelector('.build-panel-title');
  var utype = unitTypeById[unit.unit_type] || {};

  title.textContent = 'Полевые постройки · ' + (utype.name || 'инженер');
  list.innerHTML = '<div class="build-panel-empty">Загрузка…</div>';
  var oldStrip = document.getElementById('stock-strip');
  if (oldStrip) oldStrip.remove();
  panel.classList.add('struct-mode');
  panel.style.display = 'flex';

  Promise.all([
    supabase.rpc('get_researches'),
    new Promise(function(done) { loadResourceNames(done); }),
    new Promise(function(done) { loadPlanetStock(done); })
  ]).then(function(r) {
    // Окно успели закрыть или открыть под здание — чужой список не рисуем
    if (panel.style.display === 'none' || !panel.classList.contains('struct-mode')) return;
    structResearchDone = {};
    (r[0].error ? [] : (r[0].data || [])).forEach(function(x) {
      structResearchNames[x.id] = x.name;
      if (x.done) structResearchDone[x.id] = true;
    });
    renderStockStrip(0);
    renderStructureCards(unit, list);
  });
}

function renderStructureCards(unit, list) {
  list.innerHTML = '';

  var types = structTypesForMe();
  var own = sysFaction && myFaction && sysFaction === myFaction;

  var note = document.createElement('div');
  note.className = 'struct-note' + (own ? '' : ' warn');
  note.textContent = own
    ? 'Инженер сам дойдёт до места и заложит. ' +
      'Нельзя: зоны высадки, участки зданий, поселение с кольцом захвата и полоса вторжения.'
    : 'Строить можно только на планетах своей фракции.';
  list.appendChild(note);

  if (!types.length) {
    list.insertAdjacentHTML('beforeend', '<div class="build-panel-empty">Постройки пока не завезли</div>');
    return;
  }

  var labName = myFaction === 'cis' ? 'лаборатории' : 'научном центре';

  types.forEach(function(st) {
    var item = document.createElement('button');
    item.className = 'build-panel-item struct-card';
    item.setAttribute('data-code', st.id);

    var learned = !st.research_id || structResearchDone[st.research_id];
    var count = structCountHere(st.id);
    var capped = st.max_per_planet && count >= st.max_per_planet;
    var enough = canAffordResources(st.cost_resources);

    item.innerHTML =
      '<div class="build-panel-thumb struct-thumb">' +
        (st.image ? '<img src="../' + st.image + '" alt="">' : '■') +
        '<span class="struct-size">' + st.width_cells + '×' + st.height_cells + '</span>' +
      '</div>' +
      '<div class="build-panel-info">' +
        '<div class="build-panel-name">' + escHtml(st.name) +
          (!st.research_id ? ' <i class="struct-tag">базовая</i>' : '') + '</div>' +
        '<div class="struct-effect">' + escHtml(structEffectLine(st)) + '</div>' +
        '<div class="build-panel-cost">' + st.cost + ' кр. · ' + formatBuildTime(st.build_seconds) + '</div>' +
        (consumesText(st.cost_resources)
          ? '<div class="build-panel-rescost' + (enough ? '' : ' short') + '">Со склада: ' +
            escHtml(consumesText(st.cost_resources)) + '</div>' : '') +
        '<div class="struct-limit">прочность ' + st.max_hp + ' · на планете ' + count + ' из ' + st.max_per_planet + '</div>' +
      '</div>';

    var why = null;
    if (!own) why = 'чужая планета';
    else if (!learned) why = 'Изучить в ' + labName + ': ' +
      ((st.research_id && researchNameById(st.research_id)) || 'исследование');
    else if (capped) why = 'Предел на этой планете';
    else if (!enough) why = 'На складе не хватает сырья';

    if (why) {
      item.classList.add('blocked');
      if (!learned) item.classList.add('struct-locked');
      var w = document.createElement('div');
      w.className = 'build-panel-why';
      w.textContent = why;
      item.querySelector('.build-panel-info').appendChild(w);
    }

    item.addEventListener('click', function() {
      if (why) return;
      closeBuildPanel();
      startStructurePlacement(unit, st);
    });

    list.appendChild(item);
  });
}

var structResearchNames = {};
function researchNameById(id) { return structResearchNames[id] || null; }

// ---------- Постановка на карту ----------

function startStructurePlacement(unit, st) {
  selectedStructure = null;
  selectedUnit = null;
  placingStructure = { unit: unit, type: st, preview: null };
  hidePickup();
  showStructPlacementHint();
  focusCell(unit.x, unit.y);
}

function showStructPlacementHint() {
  var p = placingStructure;
  if (!p) return;
  var st = p.type;
  var hint = document.getElementById('placement-hint');
  var head = escHtml(st.name) + ' ' + st.width_cells + '×' + st.height_cells;

  if (!p.preview) {
    hint.innerHTML = '<span>' + head + ' · коснись места на карте — инженер дойдёт сам</span>' +
                     '<button id="struct-cancel">Отмена</button>';
  } else if (p.preview.problem) {
    hint.innerHTML = '<span>' + head + ' · <b class="warn-own">' + escHtml(p.preview.problem) + '</b></span>' +
                     '<button id="struct-cancel">Отмена</button>';
  } else {
    hint.innerHTML = '<span>' + head + ' · ' + st.cost + ' кр. · ' + formatBuildTime(st.build_seconds) + '</span>' +
                     '<button id="area-go">Строить</button>' +
                     '<button id="struct-cancel">Отмена</button>';
  }
  hint.style.display = 'flex';

  document.getElementById('struct-cancel').addEventListener('click', cancelStructurePlacement);
  var go = document.getElementById('area-go');
  if (go) go.addEventListener('click', confirmStructurePlacement);
  setBottomInset(insetFor(hint));
}

function cancelStructurePlacement() {
  placingStructure = null;
  document.getElementById('placement-hint').style.display = 'none';
  setBottomInset(0);
}

function handleStructurePlacementTap(cellX, cellY) {
  var p = placingStructure;
  var a = structAnchor(p.type, cellX, cellY);
  p.preview = { x: a.x, y: a.y, problem: structPlaceProblem(p.unit, p.type, a.x, a.y) };
  showStructPlacementHint();
}

function confirmStructurePlacement() {
  var p = placingStructure;
  if (!p || !p.preview || p.preview.problem) return;
  if (!gcReady()) { sendStructurePlacement(); return; }
  var st = p.type;
  gameConfirm({
    tone: 'build',
    kicker: 'Подтверди стройку',
    title: st.name,
    image: st.image ? '../' + st.image : null,
    sub: st.width_cells + '×' + st.height_cells + ' · клетка ' + p.preview.x + ':' + p.preview.y +
         (st.build_seconds ? ' · ' + formatBuildTime(st.build_seconds) : ''),
    rows: [{ label: 'Спишется', items: gcCostItems(st.cost, st.cost_resources) }],
    note: 'Инженер сам дойдёт до места. Разобрать можно потом — вернётся половина, ' +
          'если укрепление цело.',
    ok: 'Построить'
  }, function() {
    // Пока окно было открыто, постановку могли отменить или сдвинуть
    if (placingStructure === p && p.preview && !p.preview.problem) sendStructurePlacement();
  });
}

// ---------- Панель постройки ----------

function structPanelOpen() {
  var bar = document.getElementById('pickup-bar');
  return !!(bar && bar.style.visibility === 'visible' && bar.getAttribute('data-struct'));
}

function openStructurePanel(s, keepView) {
  var bar = document.getElementById('pickup-bar');
  if (!bar) return;

  selectedStructure = s;
  selectedUnit = null;

  var st = structTypeById[s.type_id] || {};
  var side = structSide(s);
  var hpPct = st.max_hp ? Math.max(0, Math.min(100, s.hp / st.max_hp * 100)) : 100;
  var sideText = side === 'mine' ? 'Твоя' : side === 'ally' ? 'Союзная' : 'Вражеская';

  var props = [];
  if (st.cover_pct) props.push('<span title="укрытие">⛨ −' + st.cover_pct + '%</span>');
  if (Number(st.damage_mult) > 1) props.push('<span title="урон стрелка">◎ ×' + Number(st.damage_mult) + '</span>');
  if (st.kind === 'turret') {
    props.push('<span title="урон">◎ ' + st.damage + '</span>');
    props.push('<span title="радиус">➶ ' + st.radius + '</span>');
    props.push('<span title="перезарядка">◷ ' + Math.round(st.cooldown_seconds / 60) + ' мин</span>');
  }
  if (st.kind === 'jammer') props.push('<span title="поле помех">◈ ' + st.radius + ' кл.</span>');
  if (st.kind === 'radar') props.push('<span title="зона обнаружения">◉ ' + st.radius + ' кл.</span>');
  if (st.kind === 'camo') props.push('<span title="укрывает">◌ ' + (s.w + st.radius * 2) + '×' + (s.h + st.radius * 2) + '</span>');
  if (st.produces_per_day) props.push('<span title="в сутки">⛏ +' + st.produces_per_day + ' ' +
                                      escHtml(resourceName(st.produces_resource).toLowerCase()) + '</span>');
  if (st.credits_per_day) props.push('<span title="в сутки">◈ +' + st.credits_per_day + '</span>');
  if (st.satisfaction_bonus) props.push('<span title="довольство поселения">☺ +' + st.satisfaction_bonus + '</span>');

  bar.setAttribute('data-struct', s.id);
  bar.setAttribute('data-side', side);
  bar.innerHTML =
    '<div class="gu-top">' +
      '<div class="gu-portrait struct side-' + side + '">' +
        (st.image ? '<img src="../' + st.image + '" alt="">' : '') +
      '</div>' +
      '<div class="gu-stats">' +
        '<div class="gu-name">' + escHtml(st.name || 'Постройка') + '</div>' +
        '<div class="gu-role"><b class="struct-side side-' + side + '">' + sideText + '</b> · ' +
          (STRUCT_KIND_ROLE[st.kind] || 'Постройка') + ' · ' + s.w + '×' + s.h + ' · ' + s.x + ':' + s.y + '</div>' +
        '<div class="gu-hp">' +
          '<span class="gu-hp-num">' + s.hp + ' / ' + (st.max_hp || s.hp) + '</span>' +
          '<div class="gu-hp-track"><i style="width:' + hpPct + '%"></i></div>' +
        '</div>' +
        '<div class="gu-props">' + props.join('') + '</div>' +
      '</div>' +
      '<button class="gu-close" id="gu-close">✕</button>' +
    '</div>' +
    '<div class="gu-ap-row struct-status" id="struct-status"></div>' +
    '<div class="gu-panel struct-panel">' +
      '<div class="gu-desc">' + escHtml(st.description || '') + '</div>' +
      '<div id="struct-actions"></div>' +
    '</div>';

  paintStructStatus(s);

  if (side === 'mine') {
    // Как на сервере: половина цены, урезанная по целости постройки
    // Целочисленно: cost * hp / (2 * max_hp), остаток отбрасывается
    var maxHp = Math.max(1, st.max_hp || s.hp || 1);
    var hpNow = Math.max(0, Math.min(s.hp || 0, maxHp));
    var whole = hpNow / maxHp;
    var back = Math.floor((st.cost || 0) * hpNow / (2 * maxHp));
    var btn = document.createElement('button');
    btn.className = 'gu-abil-go struct-demolish';
    btn.textContent = 'Разобрать · вернётся ' + back + ' кр.';
    btn.addEventListener('click', function() {
      if (btn.disabled) return;
      var go = function() {
        btn.disabled = true;
        supabase.rpc('demolish_structure', { p_id: s.id }).then(function(res) {
          if (res.error) { btn.disabled = false; alert(gbErr(res.error)); return; }
          selectedStructure = null;
          hidePickup();
          loadStructures();
          loadPlanetStock();
        }, function(e) {
          btn.disabled = false;
          alert((e && e.message) || 'нет связи с сервером');
        });
      };
      if (!gcReady()) {
        if (confirm('Разобрать «' + st.name + '»? Вернётся ' + back + ' кр.')) go();
        return;
      }
      // Сырьё возвращается на склад только своей планеты — как на сервере
      var ownPlanet = !!myFaction && sysFaction === myFaction;
      loadPlanetStock(function() {
        // Пока склад грузился, выбрали другое или закрыли панель
        if (!selectedStructure || selectedStructure.id !== s.id) return;
        var r = gcRefund(back, ownPlanet ? st.cost_resources : null, hpNow, 2 * maxHp, 0);
        gameConfirm({
          tone: 'danger',
          kicker: 'Подтверди разбор',
          title: st.name || 'Укрепление',
          image: st.image ? '../' + st.image : null,
          sub: s.w + '×' + s.h + ' · клетка ' + s.x + ':' + s.y + ' · прочность ' + s.hp + ' / ' + (st.max_hp || s.hp),
          rows: [{ label: 'Вернётся', dir: 'in', items: r.items.length ? r.items : [{ text: 'ничего', lost: true }] }],
          warn: gcJoin(whole < 1
            ? 'Укрепление повреждено — возврат урезан по прочности (' + Math.floor(whole * 100) + '%).'
            : '', gcLostWarn(r)),
          note: 'Укрепление исчезнет сразу — отменить разбор нельзя.',
          ok: 'Разобрать'
        }, go);
      });
    });
    document.getElementById('struct-actions').appendChild(btn);
  }

  document.getElementById('gu-close').addEventListener('click', function() {
    selectedStructure = null;
    hidePickup();
  });

  bar.style.visibility = 'visible';
  setBottomInset(insetFor(bar));
  if (!keepView) focusCell(s.x + Math.floor(s.w / 2), s.y + Math.floor(s.h / 2));
}

// Строка состояния: стройка, ближайшая выдача или готовность турели
var structPayTimer = null;

function paintStructStatus(s) {
  var box = document.getElementById('struct-status');
  if (!box) return;
  var st = structTypeById[s.type_id] || {};
  var now = gbServerNow();

  if (!structReady(s)) {
    var end = new Date(s.completes_at).getTime();
    var total = (st.build_seconds || 60) * 1000;
    var pct = Math.max(0, Math.min(100, (1 - (end - now) / total) * 100));
    box.innerHTML = '<span class="struct-st-label">Строится</span>' +
      '<div class="struct-st-track"><i style="width:' + pct + '%"></i></div>' +
      '<span class="struct-st-time">' + formatLeft(Math.max(0, Math.ceil((end - now) / 1000))) + '</span>';
    return;
  }

  var text = 'В строю';
  if ((st.produces_per_day || st.credits_per_day) && structSide(s) !== 'enemy') {
    // Выдача у всех одна — в 04:00 по серверу. Заложенное в окне перед
    // выдачей получает первую долю только через сутки.
    if (systemFaction && s.faction && s.faction !== systemFaction) {
      // Сервер платит только на планете своей фракции
      text = 'Планета под чужим флагом — выдачи нет';
    } else if (typeof svFirstPayoutFor === 'function' && svClock.ready) {
      var started = s.created_at ? new Date(s.created_at).getTime() : 0;
      var done = s.completes_at ? new Date(s.completes_at).getTime() : 0;
      var next = svFirstPayoutFor(started, done);
      text = 'Выдача ' + svDayWord(next) + 'в ' + svFormatTime(next) + ' ' + svClock.label +
             ' · через ' + svLeftText((next - svNow()) / 1000);
      // Отсчёт поминутный: обновляем строку, пока панель этой постройки открыта
      clearTimeout(structPayTimer);
      structPayTimer = setTimeout(function() {
        if (selectedStructure === s && structPanelOpen()) paintStructStatus(s);
      }, 30000);
    } else {
      text = 'Выдача — в 04:00 по серверу';
    }
  } else if (st.kind === 'turret' && structSide(s) !== 'enemy') {
    text = s.spotted_at ? 'Цель в прицеле — огонь раз в ' + Math.round(st.cooldown_seconds / 60) + ' мин'
                        : 'Врагов в радиусе нет';
  }
  box.innerHTML = '<span class="struct-st-label ok">' + text + '</span>';
}

// ---------- Тексты исследований ----------

function structUnlockText(r) {
  var names = Object.keys(structTypeById).map(function(k) { return structTypeById[k]; })
    .filter(function(t) { return t.research_id === r.id; })
    .map(function(t) { return t.name + ' ' + t.width_cells + '×' + t.height_cells; });
  return names.length ? 'инженер сможет строить: ' + names.join(', ')
                      : 'открывает постройку для инженера';
}

// ===== Переход по ссылке из ленты и процессов =====
// ?system=…&x=…&y=…  — показать клетку
// &unit=…            — выбрать бойца (свой — панель управления, чужой — разведка)
// &slot=N&open=slot  — участок базы; open=slot открывает занятие здания
// &open=settlement   — поселение и его панель
// Параметры убираются из адреса, чтобы перезагрузка страницы не уводила
// карту обратно к старому событию.

function gbDeepLink() {
  var q = new URLSearchParams(window.location.search);
  var link = {
    x: q.get('x') !== null ? parseInt(q.get('x'), 10) : null,
    y: q.get('y') !== null ? parseInt(q.get('y'), 10) : null,
    unit: q.get('unit'),
    slot: q.get('slot') !== null ? parseInt(q.get('slot'), 10) : null,
    bid: q.get('bid'),
    open: q.get('open'),
    tab: q.get('tab'),
    land: q.get('land')
  };
  if (link.x === null && !link.unit && link.slot === null && !link.open && !link.land) return;

  try {
    var keep = '?system=' + encodeURIComponent(systemId) + (isBuildMode() ? '&mode=build' : '');
    window.history.replaceState(null, '', window.location.pathname + keep);
  } catch (e) {}

  // Ждём, пока карта получит войска, здания и поселение
  var tries = 0;
  var wait = setInterval(function() {
    tries++;
    var unitsReady = loadUnitsApplied > 0;
    var slotsReady = (link.slot === null && link.open !== 'lease') || buildingsLoaded;
    var stlReady = link.open !== 'settlement' || !!settlement;
    // Посадке нужна сторона: от неё зависит, куда можно садиться
    var sideReady = !link.land || iAmAttacker !== null;
    if (!(unitsReady && slotsReady && stlReady && sideReady) && tries < 50) return;
    clearInterval(wait);
    gbApplyLink(link);
  }, 200);
}

function gbApplyLink(link) {

  // «На грунт» из ангара: сразу открываем посадку этого истребителя.
  // Список посадочных берём свежим — сторона и груз могли прийти позже.
  if (link.land) {
    loadDropCargo().then(function() {
      var f = dropFighters.filter(function(x) { return x.fighter_id === link.land; })[0];
      if (!f) { alert('Истребителя уже нет в ангаре над этой планетой'); return; }
      if (f.zone === null || f.zone === undefined) {
        alert('Носитель должен целиком стоять в площадке сброса');
        return;
      }
      startFighterLanding(f);
    });
    return;
  }

  // Боец из ленты («выведен», «ремонт готов»): в бою 2.0 — выбрать его и навести камеру. Старую пошаговую панель
  // бойца не открываем: её кнопки двигали и атаковали в базе в обход сервера боёв
  if (link.unit) {
    var u = unitsOnMap.filter(function(x) { return x.id === link.unit; })[0];
    if (u && u.x !== null && u.x !== undefined && window.GL && window.GD) {
      var b = unitBox(u);
      selectedStructure = null;
      GL.focusCell(u.x + b.w / 2 - 0.5, u.y + b.h / 2 - 0.5);
      if (u._agent != null && GD.select && u.owner_user_id === currentUserId) GD.select([u._agent]);
      return;
    }
    // Боец ушёл, погиб или скрылся в тумане — показываем место события
  }

  if (link.open === 'settlement' && settlement) {
    focusCell(settlement.x + settlement.size / 2 - 0.5, settlement.y + settlement.size / 2 - 0.5);
    // События налёта и условий открывают сразу вкладку «Условия»
    if (link.tab === 'tasks' || link.tab === 'districts' || link.tab === 'dev') stlTab = link.tab;
    openSettlementPanel();
    return;
  }

  // Из шторки аренды: здание по id — показать и открыть его занятие
  if (link.open === 'lease' && link.bid) {
    var leaseSlot = null;
    Object.keys(buildingsBySlot).forEach(function(k) {
      if (buildingsBySlot[k] && buildingsBySlot[k].id === link.bid) leaseSlot = parseInt(k, 10);
    });
    var ls = leaseSlot !== null ? buildSlots[leaseSlot - 1] : null;
    // Постройки так и не загрузились — молчим, а не пугаем «её нет»
    if (!buildingsLoaded) return;
    if (!ls) { alert('Этой постройки на планете уже нет'); return; }
    focusCell(ls.x + SLOT_SIZE / 2 - 0.5, ls.y + SLOT_SIZE / 2 - 0.5);
    gbLoadLeases().then(function() {
      setTimeout(function() { onSlotTapped(leaseSlot); }, 350);
    });
    return;
  }

  if (link.slot !== null && buildSlots[link.slot - 1]) {
    var sl = buildSlots[link.slot - 1];
    focusCell(sl.x + SLOT_SIZE / 2 - 0.5, sl.y + SLOT_SIZE / 2 - 0.5);
    // На месте снесённого здания могло встать другое — его не открываем
    var bld = buildingsBySlot[link.slot];
    if (link.open === 'slot' && bld && (!link.bid || bld.id === link.bid)) {
      setTimeout(function() { onSlotTapped(link.slot); }, 350);
    }
    return;
  }

  if (link.x !== null && link.y !== null && !isNaN(link.x) && !isNaN(link.y)) {
    focusCell(link.x, link.y);
  }
}

