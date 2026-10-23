/* Экран «Донесения»: вести с планет игрока и выбор, что делать.
 *
 * Сервер (sql/reports.sql): report_list — донесения, действующие эффекты и сводка по планетам;
 * report_choose(id, вариант) — списать цену и бросить исход; report_badge — сколько ждут ответа.
 * Исходы вариантов клиенту не приходят — только цена и риск («надёжно», «как повезёт», «риск N%»).
 * Без ответа за отведённое время срабатывает вариант по умолчанию — он подписан на карточке.
 *
 * Снаружи: openReports(tab) — нижняя панель галактики и лента событий; closeReports().
 * Вкладки: 'new' | 'done' | 'fx'. Значок на панели — раз в минуту одним лёгким запросом. ES5.
 */
(function() {
  'use strict';

  var TABS = [
    { id: 'new',  label: 'Новые' },
    { id: 'done', label: 'Решённые' },
    { id: 'fx',   label: 'Эффекты' }
  ];

  var CAT = {
    mine: 'Шахты', spy: 'Разведка', refugees: 'Беженцы', debris: 'Орбита', senate: 'Сенат', jedi: 'Джедаи',
    clone: 'Гарнизон', smuggler: 'Контрабанда', plague: 'Медицина', festival: 'Жители', pirates: 'Наёмники и пираты',
    science: 'Наука', weather: 'Стихия', bank: 'Банкиры', politics: 'Политика', factory: 'Производство',
    trade: 'Торговля', military: 'Военные', wildlife: 'Фауна', droid: 'Дроиды', sith: 'Тёмная сторона',
    food: 'Продовольствие', hutt: 'Хатты'
  };

  // Справочник ресурсов — как в «Снабжении»
  var RES = {
    ore:         { name: 'Руда',             color: '#b08968' },
    gas:         { name: 'Тибанна',          color: '#4ad9c8' },
    crystals:    { name: 'Кристаллы',        color: '#a34ad9' },
    food:        { name: 'Продовольствие',   color: '#5fd968' },
    durasteel:   { name: 'Дюрасталь',        color: '#8fa8c4' },
    cells:       { name: 'Топливные ячейки', color: '#d9a940' },
    electronics: { name: 'Электроника',      color: '#4a90d9' }
  };

  var RISK = { sure: 'Надёжно', luck: 'Как повезёт', risky: 'Риск', gamble: 'Риск' };
  var KIND = { mood: 'довольство', extract: 'добыча', income: 'доход' };

  var st = {
    open: false, tab: 'new', data: null, error: null, skew: 0,
    armed: {},      // донесение → номер выбранного, но не подтверждённого варианта
    busy: {},       // донесение → ждём ответа сервера
    errs: {},       // донесение → текст ошибки выбора
    fresh: {}       // донесение → только что решено: показываем исход во «Новых», пока экран открыт
  };
  var timer = null, toastTimer = null, badgeTimer = null, loading = false;

  // ── Мелочи ─────────────────────────────────────────────────────────

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function fmt(n) { return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' '); }
  function sign(n) { return (n > 0 ? '+' : n < 0 ? '−' : '') + fmt(Math.abs(n)); }
  function plural(n, one, few, many) {
    var a = Math.abs(n) % 100, b = a % 10;
    if (a > 10 && a < 20) return many;
    if (b > 1 && b < 5) return few;
    if (b === 1) return one;
    return many;
  }
  function now() { return Date.now() + st.skew; }
  function ms(iso) { var t = new Date(iso).getTime(); return isNaN(t) ? 0 : t; }

  function leftText(sec) {
    sec = Math.max(0, Math.floor(sec));
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
    if (h >= 48) return Math.floor(h / 24) + ' д' + (h % 24 ? ' ' + (h % 24) + ' ч' : '');
    if (h > 0) return h + ' ч' + (m ? ' ' + m + ' мин' : '');
    if (m > 0) return m + ' мин';
    return 'меньше минуты';
  }
  function hoursText(h) { return h % 24 === 0 && h >= 48 ? (h / 24) + ' ' + plural(h / 24, 'сутки', 'суток', 'суток') : h + ' ч'; }

  function whenText(iso) {
    var t = ms(iso); if (!t) return '';
    var d = new Date(t), hm = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
    if (typeof svFormatTime === 'function') hm = svFormatTime(t);
    var key = typeof svDayKey === 'function' ? svDayKey : function(x) { return new Date(x).toDateString(); };
    var n = now();
    if (key(t) === key(n)) return 'сегодня ' + hm;
    if (key(t) === key(n - 86400000)) return 'вчера ' + hm;
    return ('0' + d.getDate()).slice(-2) + '.' + ('0' + (d.getMonth() + 1)).slice(-2) + ' ' + hm;
  }

  function call(name, args) {
    var p;
    try { p = supabase.rpc(name, args || {}); }
    catch (e) { return Promise.resolve({ data: null, error: { message: 'Нет связи с сервером' } }); }
    return Promise.resolve(p).then(function(r) { return r || { data: null, error: null }; },
      function() { return { data: null, error: { message: 'Нет связи с сервером' } }; });
  }
  function errText(err) {
    var m = err && (err.message || err.details) || '';
    if (!m || /function|schema cache|permission denied|JWT|violates/i.test(m)) return 'Не получилось — попробуй ещё раз';
    return m;
  }

  function toast(msg, bad) {
    var t = document.getElementById('rep-toast');
    if (!t) { t = document.createElement('div'); t.id = 'rep-toast'; t.className = 'rep-toast'; document.body.appendChild(t); }
    t.textContent = msg;
    t.className = 'rep-toast show' + (bad ? ' bad' : '');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function() { t.className = 'rep-toast' + (bad ? ' bad' : ''); }, bad ? 4200 : 2600);
  }

  function screenEl() { return document.getElementById('reports-screen'); }
  function bodyEl() { return document.getElementById('rep-body'); }

  // ── Каркас ─────────────────────────────────────────────────────────

  function buildShell() {
    var el = screenEl();
    if (!el) {
      el = document.createElement('div');
      el.id = 'reports-screen';
      el.style.display = 'none';
      document.body.appendChild(el);
    }
    if (el.getAttribute('data-ready')) return el;
    el.setAttribute('data-ready', '1');
    el.innerHTML =
      '<div class="rep-head">' +
        '<div class="rep-head-row">' +
          '<div class="rep-title-box"><span class="rep-h">Донесения</span><span class="rep-sub" id="rep-sub"></span></div>' +
          '<button type="button" class="rep-close" id="rep-close" aria-label="Закрыть">✕</button>' +
        '</div>' +
        '<div class="rep-tabs" id="rep-tabs">' +
          TABS.map(function(t) {
            return '<button type="button" class="rep-tab" data-tab="' + t.id + '">' + t.label + '<i class="rep-tab-n" data-n="' + t.id + '"></i></button>';
          }).join('') +
        '</div>' +
      '</div>' +
      '<div class="rep-body" id="rep-body"></div>';
    el.querySelector('#rep-close').addEventListener('click', closeReports);
    el.querySelector('#rep-tabs').addEventListener('click', function(e) {
      var b = e.target.closest('.rep-tab');
      if (b) switchTab(b.getAttribute('data-tab'));
    });
    el.querySelector('#rep-body').addEventListener('click', onBody);
    return el;
  }

  function openReports(tab) {
    var el = buildShell();
    if (tab && (tab === 'new' || tab === 'done' || tab === 'fx')) st.tab = tab;
    st.open = true;
    st.armed = {}; st.errs = {}; st.fresh = {};
    el.style.display = 'block';
    el.scrollTop = 0;
    markTabs();
    if (!st.data) bodyEl().innerHTML = '<div class="rep-loading">Загрузка…</div>';
    else render();
    load();
    if (timer) clearInterval(timer);
    var ticks = 0;
    timer = setInterval(function() {
      ticks++;
      tick();
      if (ticks % 60 === 0 && !Object.keys(st.busy).length) load(true);
    }, 1000);
  }

  function closeReports() {
    st.open = false;
    var el = screenEl();
    if (el) el.style.display = 'none';
    if (timer) { clearInterval(timer); timer = null; }
    st.fresh = {};
    paintBadge();
  }

  function switchTab(tab) {
    st.tab = tab;
    markTabs();
    var el = screenEl(); if (el) el.scrollTop = 0;
    render();
  }

  function markTabs() {
    var b = document.querySelectorAll('#rep-tabs .rep-tab');
    for (var i = 0; i < b.length; i++) b[i].classList.toggle('active', b[i].getAttribute('data-tab') === st.tab);
  }

  function setTabCount(tab, n, kind) {
    var el = document.querySelector('#rep-tabs .rep-tab-n[data-n="' + tab + '"]');
    if (!el) return;
    el.textContent = n > 99 ? '99+' : String(n);
    el.className = 'rep-tab-n' + (n > 0 ? ' show' : '') + (kind ? ' ' + kind : '');
  }

  // ── Данные ─────────────────────────────────────────────────────────

  function load(silent) {
    if (loading) return;
    loading = true;
    call('report_list').then(function(r) {
      loading = false;
      if (r.error) {
        st.error = errText(r.error);
        if (!silent || !st.data) render();
        return;
      }
      st.error = null;
      st.data = r.data || {};
      if (st.data.now) st.skew = ms(st.data.now) - Date.now();
      // донесение, решённое на другом устройстве, больше не держим «вооружённым»
      for (var id in st.armed) if (st.armed.hasOwnProperty(id) && !findNew(id)) delete st.armed[id];
      if (st.open) render();
      paintBadge();
    });
  }

  function reports() { return (st.data && st.data.reports) || []; }
  function pending() {
    var n = now();
    return reports().filter(function(r) { return r.status === 'new' && ms(r.expires) > n; });
  }
  function findNew(id) {
    var p = pending();
    for (var i = 0; i < p.length; i++) if (p[i].id === id) return p[i];
    return null;
  }
  function find(id) {
    var a = reports();
    for (var i = 0; i < a.length; i++) if (a[i].id === id) return a[i];
    return null;
  }
  function effects() { return (st.data && st.data.effects) || []; }

  // ── Отрисовка ──────────────────────────────────────────────────────

  function render() {
    var body = bodyEl();
    if (!body || !st.open) return;
    paintSub();
    var p = pending();
    setTabCount('new', p.length, 'gold');
    setTabCount('fx', effects().length + ((st.data && st.data.laws) || []).length, '');
    setTabCount('done', 0, '');
    if (!st.data) {
      body.innerHTML = st.error
        ? '<div class="rep-empty"><b>' + esc(st.error) + '</b><button type="button" class="rep-btn" data-act="reload">Повторить</button></div>'
        : '<div class="rep-loading">Загрузка…</div>';
      return;
    }
    if (st.tab === 'new') body.innerHTML = renderNew(p);
    else if (st.tab === 'done') body.innerHTML = renderDone();
    else body.innerHTML = renderFx();
  }

  function paintSub() {
    var el = document.getElementById('rep-sub'); if (!el || !st.data) return;
    var d = st.data, per = d.per_day | 0;
    el.textContent = per > 0
      ? per + ' в сутки · ' + pad(d.from_h) + '–' + pad(d.to_h) + ' по серверу · ответ ' + (d.answer_h || 12) + ' ч'
      : 'Новые вести временно не поступают';
  }
  function pad(h) { return ('0' + (h | 0)).slice(-2); }

  function noPlanets() { return st.data && st.data.planets && st.data.planets.length === 0; }

  function renderNew(p) {
    var h = '';
    var fresh = reports().filter(function(r) { return st.fresh[r.id] && r.status !== 'new'; });
    fresh.forEach(function(r) { h += cardDone(r, true); });
    p.forEach(function(r) { h += cardNew(r); });
    if (!h) {
      if (noPlanets()) {
        h = '<div class="rep-empty"><b>Донесения получают правители планет</b>Когда у тебя появится своя планета, оттуда начнут приходить вести: просьбы, происшествия, предложения. ' +
            'Решение влияет на добычу, доход и довольство поселения.</div>';
      } else {
        var d = st.data || {};
        h = '<div class="rep-empty"><b>Новых донесений нет</b>' +
            ((d.per_day | 0) > 0 ? 'Вести приходят в течение дня, с ' + pad(d.from_h) + ':00 до ' + pad(d.to_h) + ':00 по серверу. Сообщим в ленте событий.' : 'Сейчас вести не поступают.') +
            (reports().length ? '<button type="button" class="rep-btn ghost" data-act="tab" data-v="done">Решённые</button>' : '') + '</div>';
      }
    }
    return h;
  }

  function catLine(r) {
    return '<span class="rep-cat">' + esc(CAT[r.cat] || 'Донесение') + (r.chain ? ' · <em>продолжение</em>' : '') + '</span>';
  }

  function textOf(r) {
    var planet = '<b>' + esc(r.planet || 'планеты') + '</b>';
    return esc(r.data && r.data.text || '').replace('{planet}', planet);
  }

  function leftChip(r) {
    var sec = (ms(r.expires) - now()) / 1000;
    return '<span class="rep-left' + (sec < 3600 ? ' urgent' : '') + '" data-exp="' + ms(r.expires) + '">ответ — ' + leftText(sec) + '</span>';
  }

  function costChips(r, o) {
    var c = o.cost, h = '', short = false, credits = st.data ? st.data.credits | 0 : 0, stock = r.stock || {};
    if (!c) return { html: '<span class="rep-chip free">бесплатно</span>', short: false };
    if (c.cr) {
      var s1 = credits < c.cr; short = short || s1;
      h += '<span class="rep-chip cost' + (s1 ? ' short' : '') + '">' + fmt(c.cr) + ' кр.</span>';
    }
    var res = c.res || {};
    Object.keys(res).forEach(function(k) {
      var info = RES[k] || { name: k, color: '#8fa8c4' }, have = stock[k] | 0, s2 = have < res[k];
      short = short || s2;
      h += '<span class="rep-chip cost' + (s2 ? ' short' : '') + '" title="на складе ' + fmt(have) + '"><i style="background:' + info.color + '"></i>' +
           fmt(res[k]) + ' ' + esc(info.name.toLowerCase()) + '</span>';
    });
    return { html: h, short: short };
  }

  function riskChip(o) {
    var k = RISK[o.risk] ? o.risk : 'sure';
    // все исходы с минусом — это не риск, а цена решения
    var t = (k === 'risky' || k === 'gamble') && o.bad >= 100 ? 'Будут минусы'
          : RISK[k] + ((k === 'risky' || k === 'gamble') && o.bad ? ' ' + o.bad + '%' : '');
    return '<span class="rep-risk ' + k + '">' + t + '</span>';
  }

  function cardNew(r) {
    var opts = (r.data && r.data.opts) || [], armed = st.armed[r.id], busy = !!st.busy[r.id];
    var h = '<div class="rep-card' + (r.chain ? ' chain' : '') + '" data-id="' + esc(r.id) + '">' +
      '<div class="rep-top">' + catLine(r) + leftChip(r) + '</div>' +
      '<div class="rep-name">' + esc(r.data && r.data.title) + '</div>' +
      '<div class="rep-planet"><i></i>' + esc(r.planet || r.system) + '</div>' +
      '<div class="rep-text">' + textOf(r) + '</div>' +
      '<div class="rep-opts">';
    opts.forEach(function(o, i) {
      var cc = costChips(r, o), on = armed === i;
      h += '<button type="button" class="rep-opt' + (on ? ' armed' : '') + (cc.short ? ' short' : '') + '" data-act="arm" data-id="' + esc(r.id) + '" data-i="' + i + '"' + (busy ? ' disabled' : '') + '>' +
        '<span class="rep-opt-label">' + esc(o.label) + '</span>' +
        '<span class="rep-opt-meta">' + cc.html + riskChip(o) + (i === r.def ? '<span class="rep-def-tag">· без ответа</span>' : '') + '</span>' +
      '</button>';
      if (on) {
        h += '<div class="rep-confirm">' +
          '<button type="button" class="rep-btn gold' + (busy ? ' busy' : '') + '" data-act="choose" data-id="' + esc(r.id) + '" data-i="' + i + '"' + (cc.short ? ' disabled' : '') + '>' +
            (busy ? 'Отправляем…' : cc.short ? 'Не хватает' : 'Решено') + '</button>' +
          '<button type="button" class="rep-btn ghost" data-act="unarm" data-id="' + esc(r.id) + '"' + (busy ? ' disabled' : '') + '>Отмена</button>' +
        '</div>';
      }
    });
    h += '</div>';
    if (st.errs[r.id]) h += '<div class="rep-err">' + esc(st.errs[r.id]) + '</div>';
    var d = opts[r.def];
    if (d) h += '<div class="rep-note">Без ответа сработает «<b>' + esc(d.label) + '</b>».</div>';
    return h + '</div>';
  }

  // Что принёс исход — фишки и общий тон
  function gotInfo(got, next) {
    var h = '', up = 0, down = 0;
    got = got || {};
    ['mood', 'extract', 'income'].forEach(function(k) {
      var v = got[k]; if (!v) return;
      var n = v[0] | 0, hrs = v[1] | 0;
      if (n > 0) up++; else down++;
      h += '<span class="rep-got ' + (n > 0 ? 'up' : 'down') + '">' + sign(n) + (k === 'mood' ? '' : '%') + ' ' + KIND[k] + ' · ' + hoursText(hrs) + '</span>';
    });
    if (got.cr) {
      if (got.cr > 0) up++; else down++;
      h += '<span class="rep-got ' + (got.cr > 0 ? 'up' : 'down') + '">' + sign(got.cr) + ' кр.</span>';
    }
    var res = got.res || {};
    Object.keys(res).forEach(function(k) {
      var n = res[k] | 0; if (!n) return;
      if (n > 0) up++; else down++;
      h += '<span class="rep-got ' + (n > 0 ? 'up' : 'down') + '">' + sign(n) + ' ' + esc((RES[k] || { name: k }).name.toLowerCase()) + '</span>';
    });
    if (got.raid) { down++; h += '<span class="rep-got down">банда мародёров · ' + got.raid + '</span>'; }
    if (got.gift) { up++; h += '<span class="rep-got up">+ ' + (got.gift === 'veh' ? 'техника' : 'боец') + ' на планете</span>'; }
    if (next) h += '<span class="rep-got next">продолжение — через сутки</span>';
    return { html: h ? '<div class="rep-gots">' + h + '</div>' : '', tone: up && down ? 'mixed' : up ? 'good' : down ? 'bad' : '' };
  }

  function cardDone(r, fresh) {
    var out = r.outcome || {}, opts = (r.data && r.data.opts) || [], o = opts[r.choice];
    var g = gotInfo(out.got, r.next || (fresh && st.fresh[r.id] && st.fresh[r.id].next));
    var who = out.lost ? 'Планета потеряна'
      : r.auto ? 'Без ответа · <b>' + esc(o ? o.label : '—') + '</b>'
      : 'Решение · <b>' + esc(o ? o.label : '—') + '</b>';
    return '<div class="rep-card done ' + g.tone + (fresh ? ' fresh' : '') + (r.chain ? ' chain' : '') + '" data-id="' + esc(r.id) + '">' +
      '<div class="rep-top">' + catLine(r) + '<span class="rep-when">' + esc(whenText(r.resolved || r.at)) + '</span></div>' +
      '<div class="rep-name">' + esc(r.data && r.data.title) + '</div>' +
      '<div class="rep-planet"><i></i>' + esc(r.planet || r.system) + '</div>' +
      (fresh ? '<div class="rep-text">' + textOf(r) + '</div>' : '') +
      '<div class="rep-out ' + g.tone + '"><div class="rep-out-k">' + who + '</div>' +
        '<div class="rep-out-text">' + esc(out.text || '') + '</div>' + g.html + '</div>' +
    '</div>';
  }

  function renderDone() {
    var list = reports().filter(function(r) { return r.status !== 'new'; });
    if (!list.length) return '<div class="rep-empty"><b>Решённых пока нет</b>Здесь хранятся решения и их последствия за последнюю неделю.</div>';
    list.sort(function(a, b) { return ms(b.resolved || b.at) - ms(a.resolved || a.at); });
    return list.map(function(r) { return cardDone(r, false); }).join('');
  }

  function effRow(e, tag) {
    var n = e.value | 0;
    return '<div class="rep-eff"><div class="rep-eff-row"><span class="rep-got ' + (n > 0 ? 'up' : 'down') + '">' + sign(n) + (e.kind === 'mood' ? '' : '%') + ' ' + KIND[e.kind] + '</span>' +
      '<span class="rep-eff-l" data-end="' + ms(e.ends) + '">' + leftText((ms(e.ends) - now()) / 1000) + '</span></div>' +
      '<div class="rep-eff-t">' + (tag ? tag + ' · ' : '') + esc(e.title || '') + '</div></div>';
  }

  function renderFx() {
    var planets = (st.data && st.data.planets) || [], eff = effects(), laws = (st.data && st.data.laws) || [];
    if (!planets.length) return '<div class="rep-empty"><b>Своих планет нет</b>Эффекты донесений действуют на планеты, которыми ты правишь.</div>';
    var h = '';
    if (!eff.length && !laws.length) h += '<div class="rep-empty"><b>Действующих эффектов нет</b>Они появляются от решений в донесениях: прибавка к добыче, доходу или довольству — или наоборот.</div>';
    // законы фракции (Сенат / Совет) действуют на все её планеты сразу
    if (laws.length) {
      h += '<div class="rep-pcard law"><div class="rep-pname">Законы фракции</div>';
      laws.forEach(function(e) { h += effRow(e, e.decree ? 'указ' : 'закон'); });
      h += '</div>';
    }
    planets.slice().sort(function(a, b) { return String(a.planet).localeCompare(String(b.planet)); }).forEach(function(p) {
      var mine = eff.filter(function(e) { return e.system === p.system; });
      if (!mine.length && !laws.length) return;
      h += '<div class="rep-pcard on"><div class="rep-pname">' + esc(p.planet || p.system) + '</div><div class="rep-meters">' +
        meter(p.mood | 0, '', 'довольство') + meter(p.extract | 0, '%', 'добыча') + meter(p.income | 0, '%', 'доход') + '</div>';
      mine.forEach(function(e) { h += effRow(e, ''); });
      if (laws.length) h += '<div class="rep-eff-t rep-eff-law">Цифры вверху — с учётом законов фракции</div>';
      h += '</div>';
    });
    if (eff.length || laws.length) h += '<div class="rep-note">Сумма по планете ограничена: довольство — ±30, добыча и доход — ±50%. Довольство видно в поселении строкой «События».</div>';
    return h;
  }

  function meter(v, unit, label) {
    return '<div class="rep-meter' + (v > 0 ? ' up' : v < 0 ? ' down' : '') + '"><b>' + (v ? sign(v) + unit : '0') + '</b><span>' + label + '</span></div>';
  }

  // Обратные отсчёты без перерисовки; истёкшее — перечитать с сервера
  function tick() {
    if (!st.open) return;
    var n = now(), expired = false;
    var a = document.querySelectorAll('#rep-body [data-exp]');
    for (var i = 0; i < a.length; i++) {
      var sec = (parseInt(a[i].getAttribute('data-exp'), 10) - n) / 1000;
      if (sec <= 0) { expired = true; continue; }
      a[i].textContent = 'ответ — ' + leftText(sec);
      a[i].classList.toggle('urgent', sec < 3600);
    }
    var b = document.querySelectorAll('#rep-body [data-end]');
    for (var j = 0; j < b.length; j++) {
      var s2 = (parseInt(b[j].getAttribute('data-end'), 10) - n) / 1000;
      if (s2 <= 0) expired = true;
      else b[j].textContent = leftText(s2);
    }
    // сервер закрывает просроченное раз в 10 минут — подождём его, а пока уберём карточку
    if (expired && !loading) { render(); setTimeout(function() { load(true); }, 1500); }
  }

  // ── Действия ───────────────────────────────────────────────────────

  function onBody(e) {
    var b = e.target.closest('[data-act]');
    if (!b || b.disabled) return;
    var act = b.getAttribute('data-act'), id = b.getAttribute('data-id');
    if (act === 'reload') { load(); return; }
    if (act === 'tab') { switchTab(b.getAttribute('data-v')); return; }
    if (act === 'arm') {
      var i = parseInt(b.getAttribute('data-i'), 10);
      st.armed[id] = st.armed[id] === i ? undefined : i;
      if (st.armed[id] === undefined) delete st.armed[id];
      delete st.errs[id];
      render();
      return;
    }
    if (act === 'unarm') { delete st.armed[id]; delete st.errs[id]; render(); return; }
    if (act === 'choose') choose(id, parseInt(b.getAttribute('data-i'), 10));
  }

  function choose(id, i) {
    var r = findNew(id);
    if (!r || st.busy[id]) return;
    st.busy[id] = true;
    delete st.errs[id];
    render();
    call('report_choose', { p_id: id, p_choice: i }).then(function(res) {
      delete st.busy[id];
      if (res.error) {
        st.errs[id] = errText(res.error);
        render();
        // уже решено или просрочено — правда на сервере
        if (/уже принято|вышло|не найдено/i.test(st.errs[id])) load(true);
        return;
      }
      var out = res.data || {};
      delete st.armed[id];
      // показываем исход сразу, не дожидаясь перечитки
      r.status = 'done'; r.choice = i; r.auto = false; r.resolved = new Date(now()).toISOString();
      r.outcome = { i: out.i, text: out.text, got: out.got || {}, lost: !!out.lost };
      r.next = !!out.next;
      st.fresh[id] = { next: !!out.next };
      var o = r.data.opts[i];
      if (o && o.cost && o.cost.cr && st.data) st.data.credits = (st.data.credits | 0) - o.cost.cr;
      if (out.got && out.got.cr && st.data) st.data.credits = (st.data.credits | 0) + out.got.cr;
      render();
      var g = gotInfo(out.got, out.next);
      toast(out.lost ? 'Планета потеряна — донесение закрыто' : g.tone === 'bad' ? 'Решение принято. Последствия — неприятные' : 'Решение принято', g.tone === 'bad');
      if (typeof refreshCreditsBar === 'function') refreshCreditsBar();
      paintBadge();
      setTimeout(function() { load(true); }, 800);
    });
  }

  // ── Значок на нижней панели ────────────────────────────────────────

  function paintBadge(n) {
    var b = document.getElementById('reports-badge');
    if (!b) return;
    if (n === undefined) n = st.data ? pending().length : 0;
    b.textContent = n > 9 ? '9+' : String(n);
    b.style.display = n > 0 ? 'block' : 'none';
    b.style.background = '#d9a940';
    b.style.color = '#0a0d14';
  }

  function refreshBadge() {
    if (document.hidden || !window.supabase || !supabase.rpc) return;
    if (st.open) return;
    call('report_badge').then(function(r) { if (!r.error) paintBadge(r.data | 0); });
  }

  window.openReports = openReports;
  window.closeReports = closeReports;

  document.addEventListener('DOMContentLoaded', function() {
    var btn = document.getElementById('panel-item-reports');
    if (btn) btn.addEventListener('click', function() { openReports(pendingCount() ? 'new' : st.tab); });
    if (!document.getElementById('reports-badge')) return;
    setTimeout(refreshBadge, 3000);
    badgeTimer = setInterval(refreshBadge, 60000);
    document.addEventListener('visibilitychange', function() { if (!document.hidden) refreshBadge(); });
  });

  function pendingCount() {
    var b = document.getElementById('reports-badge');
    return b && b.style.display === 'block';
  }
})();
