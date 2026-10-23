/* Галактические события: что сейчас происходит в галактике.
 *
 * Сервер (sql/galaxy_events.sql) решает всё сам: раз в 18–36 ч стартует новое событие (до двух разом),
 * на 1–3 суток; эффекты идут через общий слой (effect_sum), банды и находки — разово на старте.
 * galaxy_events_state — идущие события с задетыми планетами и недавние.
 *
 * Здесь: плашка под ником на карте галактики, шторка «Галактика · события», метки на задетых планетах,
 * строки в карточке планеты (gePlanetRows — зовёт planet-info.js), кнопка в ленте (openGalaxyEvents).
 * Префикс ge-. ES5.
 */
(function() {
  'use strict';

  var KIND = {
    extract:    { up: 'добыча',     unit: '%' },
    income:     { up: 'доход',      unit: '%' },
    mood:       { up: 'довольство', unit: '' },
    hire_time:  { time: 'найм' },
    build_time: { time: 'стройка' }
  };
  var RES = { ore: 'руды', gas: 'тибанны', crystals: 'кристаллов', food: 'продовольствия', durasteel: 'дюрастали', cells: 'топливных ячеек', electronics: 'электроники' };
  var FAC = { republic: 'Республика', cis: 'Конфедерация' };
  var FAC_GEN = { republic: 'Республики', cis: 'Конфедерации' };

  var st = { data: null, skew: 0, open: false, loading: false };
  var tickTimer = null;

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function ms(iso) { var t = new Date(iso).getTime(); return isNaN(t) ? 0 : t; }
  function now() { return Date.now() + st.skew; }
  function fmt(n) { return String(Math.round(Math.abs(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ' '); }
  function plural(n, a, b, c) { var x = Math.abs(n) % 100, y = x % 10; if (x > 10 && x < 20) return c; if (y > 1 && y < 5) return b; if (y === 1) return a; return c; }

  function left(iso) {
    var sec = Math.max(0, Math.floor((ms(iso) - now()) / 1000));
    var d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
    if (d > 0) return d + ' д' + (h ? ' ' + h + ' ч' : '');
    if (h > 0) return h + ' ч' + (m ? ' ' + m + ' мин' : '');
    return Math.max(1, m) + ' мин';
  }
  function ago(iso) {
    var sec = Math.max(0, Math.floor((now() - ms(iso)) / 1000));
    if (sec < 3600) return Math.max(1, Math.floor(sec / 60)) + ' мин назад';
    if (sec < 86400) return Math.floor(sec / 3600) + ' ч назад';
    var d = Math.floor(sec / 86400);
    return d + ' ' + plural(d, 'день', 'дня', 'дней') + ' назад';
  }

  function effect(e) {
    var k = KIND[e.kind] || { up: e.kind, unit: '' }, v = e.value | 0;
    if (k.time) return { good: v < 0, text: k.time + (v < 0 ? ' быстрее' : ' дольше') + ' на ' + Math.abs(v) + '%' };
    return { good: v > 0, text: k.up + ' ' + (v > 0 ? '+' : '−') + Math.abs(v) + k.unit };
  }

  function scopeText(ev) {
    var c = ev.center_name || '';
    switch (ev.scope) {
      case 'galaxy':  return 'Вся галактика';
      case 'faction': return 'Все планеты ' + (FAC_GEN[ev.faction] || 'фракции');
      case 'sector':  return 'Сектор: ' + c + ' и соседи';
      case 'planet':  return 'Планета ' + c;
      case 'front':   return 'Фронт · ' + c;
    }
    return '';
  }

  // Длительные действия события — такими же плашками, как эффекты
  function actionFx(a) {
    var out = [];
    a = a || {};
    if (a.travel) out.push({ good: a.travel < 0, text: 'прыжки флота ' + (a.travel < 0 ? 'быстрее' : 'дольше') + ' на ' + Math.abs(a.travel) + '%' });
    if (a.trade) out.push({ good: a.trade > 0, text: 'торговый пост платит ' + (a.trade > 0 ? '+' : '−') + Math.abs(a.trade) + '%' });
    return out;
  }

  function resultText(r, n) {
    var out = [];
    r = r || {};
    if (r.raid) out.push('банды мародёров у ' + r.raid + ' ' + plural(r.raid, 'поселения', 'поселений', 'поселений') + ' — по ' + (r.gang | 0) + ' бойца');
    if (r.stock) Object.keys(r.stock).forEach(function(k) { out.push('+' + fmt(r.stock[k]) + ' ' + (RES[k] || k) + (n > 1 ? ' на склад каждой планеты' : ' на склад планеты')); });
    if (r.gift) out.push('+' + r.gift + ' ' + plural(r.gift, 'боец', 'бойца', 'бойцов') + ' управляющему');
    if (r.credits) out.push('+' + fmt(r.credits) + ' кр. управляющему');
    if (r.unrest) out.push('напряжение ' + (r.unrest > 0 ? '+' : '−') + Math.abs(r.unrest) + (n > 1 ? ' на каждой планете' : ''));
    return out;
  }

  // ── Загрузка ───────────────────────────────────────────────────────

  function load() {
    if (st.loading || document.hidden || !window.supabase || !supabase.rpc) return;
    st.loading = true;
    Promise.resolve(supabase.rpc('galaxy_events_state')).then(function(r) {
      st.loading = false;
      if (!r || r.error || !r.data) return;
      st.data = r.data;
      if (r.data.now) st.skew = ms(r.data.now) - Date.now();
      paint();
    }, function() { st.loading = false; });
  }

  function active() {
    var n = now();
    return ((st.data && st.data.active) || []).filter(function(e) { return ms(e.ends) > n; });
  }

  function paint() {
    paintPill();
    paintMarks();
    if (st.open) renderSheet();
  }

  // ── Плашка на карте ────────────────────────────────────────────────

  function pillEl() {
    var el = document.getElementById('ge-pill');
    if (el) return el;
    el = document.createElement('button');
    el.type = 'button';
    el.id = 'ge-pill';
    el.style.display = 'none';
    el.addEventListener('click', openSheet);
    document.body.appendChild(el);
    return el;
  }

  // Важнее то, что касается меня: сначала события на моих планетах, потом на всю мою сторону, потом остальные
  function rank(ev, fac) {
    if ((ev.planets || []).some(function(p) { return p.mine; }) && ev.scope !== 'galaxy' && ev.scope !== 'faction') return 0;
    return touches(ev, fac) ? 1 : 2;
  }
  function ordered() {
    var mine = st.data && st.data.faction;
    return active().slice().sort(function(a, b) {
      return rank(a, mine) - rank(b, mine) || ms(a.ends) - ms(b.ends);
    });
  }
  function touches(ev, fac) {
    if (ev.scope === 'galaxy') return true;
    if (ev.scope === 'faction') return ev.faction === fac;
    return (ev.planets || []).some(function(p) { return p.mine; });
  }

  function paintPill() {
    var el = pillEl(), list = ordered();
    if (!list.length) { el.style.display = 'none'; return; }
    var ev = list[0];
    el.className = 'ge-pill t-' + ev.tone + (questUp() ? ' low' : '');
    el.innerHTML = '<span class="ge-pill-ico">' + esc(ev.glyph) + '</span>' +
      '<span class="ge-pill-body"><b>' + esc(ev.title) + '</b><i data-ge-left="' + ms(ev.ends) + '">' + esc(shortScope(ev)) + ' · ' + left(ev.ends) + '</i></span>' +
      (list.length > 1 ? '<span class="ge-pill-more">+' + (list.length - 1) + '</span>' : '');
    el.setAttribute('aria-label', 'Галактические события: ' + list.length);
    el.style.display = 'flex';
  }

  function shortScope(ev) {
    switch (ev.scope) {
      case 'galaxy':  return 'вся галактика';
      case 'faction': return FAC[ev.faction] || 'фракция';
      case 'sector':  return 'сектор ' + (ev.center_name || '');
      default:        return ev.center_name || '';
    }
  }

  // Трекер обучения стоит справа под кредитами — когда он виден, плашка опускается ниже
  function questUp() {
    var q = document.getElementById('quest-tracker');
    return !!(q && getComputedStyle(q).display !== 'none' && q.offsetWidth > 0 && window.innerWidth < 560);
  }

  // ── Метки на планетах ──────────────────────────────────────────────

  function paintMarks() {
    var seen = {};
    active().forEach(function(ev) {
      if (ev.scope === 'galaxy' || ev.scope === 'faction') return;
      (ev.planets || []).forEach(function(p) {
        if (seen[p.id]) return;
        seen[p.id] = ev;
      });
    });
    var old = document.querySelectorAll('.ge-mark');
    for (var i = 0; i < old.length; i++) {
      var pid = old[i].getAttribute('data-ge-planet');
      if (!seen[pid]) old[i].parentNode.removeChild(old[i]);
    }
    Object.keys(seen).forEach(function(id) {
      var w = document.querySelector('.planet-wrapper[data-planet-id="' + id + '"]');
      if (!w) return;
      var ev = seen[id], m = w.querySelector('.ge-mark');
      if (!m) { m = document.createElement('div'); m.setAttribute('data-ge-planet', id); w.appendChild(m); }
      m.className = 'ge-mark t-' + ev.tone;
      m.textContent = ev.glyph;
      m.title = ev.title;
    });
  }

  // ── Шторка ─────────────────────────────────────────────────────────

  function sheetEl() {
    var el = document.getElementById('ge-sheet');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'ge-sheet';
    el.style.display = 'none';
    el.innerHTML =
      '<div id="ge-box">' +
        '<div id="ge-head"><div><div id="ge-title">Галактика · события</div><div id="ge-sub"></div></div>' +
          '<button type="button" id="ge-close" aria-label="Закрыть">✕</button></div>' +
        '<div id="ge-body"></div>' +
      '</div>';
    document.body.appendChild(el);
    el.addEventListener('click', function(e) { if (e.target === el) closeSheet(); });
    el.querySelector('#ge-close').addEventListener('click', closeSheet);
    el.querySelector('#ge-body').addEventListener('click', function(e) {
      var b = e.target.closest('[data-ge-go]');
      if (!b) return;
      var id = b.getAttribute('data-ge-go');
      closeSheet();
      var ok = typeof focusGalaxySystem === 'function' && focusGalaxySystem(id);
      if (typeof openPlanetInfo === 'function') setTimeout(function() { openPlanetInfo(id); }, ok ? 450 : 0);
    });
    return el;
  }

  function openSheet() {
    var el = sheetEl();
    st.open = true;
    el.style.display = 'flex';
    renderSheet();
    load();
  }

  function closeSheet() {
    st.open = false;
    var el = document.getElementById('ge-sheet');
    if (el) el.style.display = 'none';
  }

  function renderSheet() {
    var body = document.getElementById('ge-body'), sub = document.getElementById('ge-sub');
    if (!body) return;
    var list = ordered(), recent = (st.data && st.data.recent) || [];
    if (sub) sub.textContent = list.length
      ? list.length + ' ' + plural(list.length, 'событие идёт', 'события идут', 'событий идут') + ' · новые — раз в 1–1,5 суток'
      : 'Сейчас спокойно · новые события — раз в 1–1,5 суток';
    if (!st.data) { body.innerHTML = '<div class="ge-empty">Загрузка…</div>'; return; }
    var h = '';
    if (!list.length) h += '<div class="ge-empty"><b>В галактике спокойно</b>Шторма, пираты, находки и торговые бумы приходят сами — по всей галактике, в сектор или на одну планету. Каждое длится сутки-трое.</div>';
    list.forEach(function(ev) { h += card(ev); });
    if (recent.length) {
      h += '<div class="ge-block">Недавно</div>';
      recent.forEach(function(r) {
        h += '<div class="ge-past t-' + esc(r.tone) + '"><span class="ge-past-ico">' + esc(r.glyph) + '</span><span class="ge-past-t"><b>' + esc(r.title) + '</b><i>' +
          esc(r.scope === 'galaxy' ? 'вся галактика' : r.scope === 'faction' ? (FAC[r.faction] || '') : (r.center_name || '')) + ' · закончилось ' + ago(r.ended) + '</i></span></div>';
      });
    }
    h += '<div class="ge-note">Эффекты событий складываются с законами, донесениями и проектами казны. Сумма по планете ограничена: довольство — ±30, остальное — ±50%.</div>';
    body.innerHTML = h;
  }

  function card(ev) {
    var mine = touches(ev, st.data && st.data.faction);
    var h = '<div class="ge-card t-' + esc(ev.tone) + (mine ? ' mine' : '') + '">' +
      '<div class="ge-card-head"><span class="ge-ico">' + esc(ev.glyph) + '</span>' +
        '<span class="ge-card-t"><b>' + esc(ev.title) + '</b><i>' + esc(scopeText(ev)) + '</i></span>' +
        '<span class="ge-left" data-ge-left="' + ms(ev.ends) + '">' + left(ev.ends) + '</span></div>' +
      '<div class="ge-text">' + esc(ev.text) + '</div>';
    var fx = (ev.effects || []).map(effect).concat(actionFx(ev.actions)), res = resultText(ev.result, (ev.planets || []).length);
    if (fx.length || res.length) {
      h += '<div class="ge-fx">' + fx.map(function(x) { return '<i class="' + (x.good ? 'up' : 'down') + '">' + esc(x.text) + '</i>'; }).join('') +
        res.map(function(t) { return '<i class="once">' + esc(t) + '</i>'; }).join('') + '</div>';
    }
    if (ev.scope !== 'galaxy' && ev.scope !== 'faction' && (ev.planets || []).length) {
      h += '<div class="ge-planets">' + ev.planets.map(function(p) {
        return '<button type="button" class="ge-planet f-' + esc(p.faction) + (p.mine ? ' mine' : '') + '" data-ge-go="' + esc(p.id) + '">' + esc(p.name) + (p.mine ? '<em>твоя</em>' : '') + '</button>';
      }).join('') + '</div>';
    } else if (mine) {
      h += '<div class="ge-touch">Касается и твоих планет</div>';
    }
    return h + '</div>';
  }

  // ── Карточка планеты ───────────────────────────────────────────────
  // planet-info.js зовёт gePlanetRows(systemId) и вставляет строки к остальным

  function planetRows(systemId) {
    var rows = [];
    if (!st.data) return rows;
    active().forEach(function(ev) {
      var hit = false;
      if (ev.scope === 'galaxy') hit = true;
      else if (ev.scope === 'faction') hit = (ev.planets || []).some(function(p) { return p.id === systemId; });
      else hit = (ev.planets || []).some(function(p) { return p.id === systemId; });
      if (!hit) return;
      var row = document.createElement('div');
      row.className = 'pi-stat ge-pi t-' + ev.tone;
      row.innerHTML = '<span>' + esc(ev.glyph) + ' Событие</span><b>' + esc(ev.title) + ' · ещё ' + left(ev.ends) + '</b>';
      row.addEventListener('click', openSheet);
      rows.push(row);
    });
    return rows;
  }

  // Отсчёты на плашке и в шторке без перерисовки
  function tick() {
    var els = document.querySelectorAll('[data-ge-left]'), due = false, n = now();
    for (var i = 0; i < els.length; i++) {
      var end = parseInt(els[i].getAttribute('data-ge-left'), 10);
      if (end <= n) { due = true; continue; }
      var t = left(new Date(end).toISOString());
      if (els[i].parentNode && els[i].parentNode.className === 'ge-pill-body') {
        var txt = els[i].textContent, cut = txt.lastIndexOf(' · ');
        els[i].textContent = (cut >= 0 ? txt.slice(0, cut) : txt) + ' · ' + t;
      } else els[i].textContent = t;
    }
    if (due) { paint(); setTimeout(load, 3000); }
    var p = document.getElementById('ge-pill');
    if (p && p.style.display !== 'none') p.classList.toggle('low', questUp());
  }

  window.openGalaxyEvents = openSheet;
  window.gePlanetRows = planetRows;
  window.geReload = load;

  document.addEventListener('DOMContentLoaded', function() {
    if (!document.getElementById('galaxy-layer')) return;
    setTimeout(load, 2000);
    // планеты рисуются после загрузки карты — метки догоняют их
    setTimeout(paintMarks, 6000);
    setInterval(load, 120000);
    tickTimer = setInterval(tick, 20000);
    document.addEventListener('visibilitychange', function() { if (!document.hidden) load(); });
  });
})();
