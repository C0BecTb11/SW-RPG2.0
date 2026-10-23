/* Напряжение на планетах — шаг 1 плана мятежей (sql/unrest.sql, claude/rebellion-plan.md).
 *
 * Шкала 0–100 у планеты: растёт от голода, врага у стен, ушедших с добычей мародёров и запустения,
 * гаснет от довольства, гарнизона, присмотра управляющего и спокойных суток. Считается раз в сутки
 * в час выдачи. Сейчас — наблюдение: шкала видна, последствий нет.
 *
 * Здесь три показа одной шкалы (префикс un-, всё внутри IIFE):
 *   unSettlementHtml(data) — блок во вкладке «Развитие» окна поселения (ground-battle.js);
 *   unPlanetRows(systemId) — строка в карточке планеты в галактике (planet-info.js);
 *   unFetch() / fsRenderUnrest() — раздел «Напряжение» в окне фракции (faction-panel.js).
 */
(function() {
  'use strict';

  var ST = {
    calm:   { t: 'спокойно',      c: 'calm' },
    murmur: { t: 'ропот',         c: 'murmur' },
    unrest: { t: 'волнения',      c: 'unrest' },
    strike: { t: 'забастовки',    c: 'strike' },
    riot:   { t: 'мятеж назрел',  c: 'riot' }
  };
  // Что будет на пороге, когда включатся последствия (шаги 2 и 3) — подсказка под шкалой
  var NEXT = {
    calm:   'С 30 — ропот: предупреждения управляющему и лидеру.',
    murmur: 'С 50 — волнения: добыча и доход −15% (после недели наблюдения).',
    unrest: 'С 75 — забастовки: −30%, ополчение не встаёт.',
    strike: 'На 100 — мятеж: повстанцы у поселения, 48 ч на подавление.',
    riot:   'Мятеж назрел. Последствия включатся после недели наблюдения.'
  };

  var cache = { list: null, at: 0, busy: false };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function(ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }
  function stateOf(v) {
    v = v | 0;
    return v >= 100 ? 'riot' : v >= 75 ? 'strike' : v >= 50 ? 'unrest' : v >= 30 ? 'murmur' : 'calm';
  }
  // Сколько шкала реально сдвинется к утру: с заморозкой роста, пределом и нулём
  function expect(v, delta, cap, hold) {
    v = v | 0; var g = delta | 0;
    if (g > 0 && hold) g = 0;
    if (g > 0) g = Math.min(g, Math.max(0, (cap || 100) - v));
    if (g < 0) g = Math.max(g, -v);
    return g;
  }
  function signed(n) { n = n | 0; return n > 0 ? '+' + n : n < 0 ? '−' + Math.abs(n) : '0'; }
  function trendCls(n) { return n > 0 ? 'up' : n < 0 ? 'down' : 'flat'; }
  function sb() { return typeof supabase !== 'undefined' ? supabase : null; }
  function hoursTo(iso) {
    var ms = new Date(iso).getTime() - Date.now();
    if (!(ms > 0)) return '';
    var h = Math.floor(ms / 3600000), m = Math.floor(ms % 3600000 / 60000);
    return h > 0 ? h + ' ч' + (m ? ' ' + m + ' мин' : '') : m + ' мин';
  }
  function daysTo(iso) {
    var ms = new Date(iso).getTime() - Date.now();
    if (!(ms > 0)) return '';
    var d = Math.ceil(ms / 86400000);
    return d > 1 ? d + ' ' + (d < 5 ? 'дня' : 'дней') : hoursTo(iso);
  }

  // Шкала с порогами: зоны 30/50/75 подкрашены, заливка до значения, предел (если ниже 100) отмечен
  function gauge(v, cap, mini) {
    v = Math.max(0, Math.min(100, v | 0));
    var st = stateOf(v);
    return '<span class="un-gauge' + (mini ? ' mini' : '') + ' un-s-' + st + '">' +
      '<i class="un-z z0"></i><i class="un-z z1"></i><i class="un-z z2"></i><i class="un-z z3"></i>' +
      '<b class="un-fill" style="width:' + v + '%"></b>' +
      (cap && cap < 100 ? '<s class="un-cap" style="left:' + cap + '%"></s>' : '') +
      (mini ? '' : '<em class="un-dot" style="left:' + v + '%"></em>') +
    '</span>';
  }

  // ── Окно поселения ────────────────────────────────────────────────
  function settlementHtml(d) {
    if (!d || d.value == null) return '';
    var v = d.value | 0, k = stateOf(v), f = d.forecast || {}, fd = f.delta | 0;
    var hold = f.hold, grow = expect(v, fd, f.cap, hold);
    var html = '<div class="un-box un-s-' + k + '">';
    html += '<div class="stl-sec"><span>Напряжение</span><em class="un-st">' + ST[k].t + '</em></div>';
    html += '<div class="un-top">' +
      '<b class="un-val">' + v + '</b>' +
      '<span class="un-top-r"><i>из 100</i>' +
        '<em class="un-trend ' + trendCls(grow) + '">к утру ' + signed(grow) + '</em></span>' +
    '</div>';
    html += gauge(v, f.cap);
    html += '<div class="un-scale"><span style="left:30%">30</span><span style="left:50%">50</span><span style="left:75%">75</span></div>';

    // Прогноз на ближайшую выдачу: из чего сложится
    var rows = f.rows || [];
    if (rows.length) {
      html += '<div class="un-rows">' + rows.map(function(r) {
        var n = r.value | 0;
        return '<div class="un-row"><span>' + esc(r.label) + '</span><b class="' + (n > 0 ? 'up' : 'down') + '">' + signed(n) + '</b></div>';
      }).join('') + '</div>';
    }

    var notes = [];
    if (hold) notes.push('Шкала не растёт: ' + esc(hold) + (f.hold_until ? ' · ещё ' + daysTo(f.hold_until) : ''));
    if (f.cap_why) notes.push('Предел ' + (f.cap | 0) + ': ' + esc(f.cap_why));
    var hist = d.history || [];
    if (hist.length) {
      var max = 1;
      hist.forEach(function(h) { max = Math.max(max, h.value | 0); });
      html += '<div class="un-hist" title="Последние выдачи">' + hist.map(function(h) {
        var hv = h.value | 0;
        return '<i class="un-s-' + stateOf(hv) + '" style="height:' + Math.max(8, Math.round(hv / Math.max(30, max) * 100)) + '%"><em>' + hv + '</em></i>';
      }).join('') + '</div><div class="un-hist-cap">последние выдачи</div>';
    }
    html += '<div class="un-note">' +
      (notes.length ? notes.map(function(n) { return '<span>' + n + '</span>'; }).join('') : '') +
      '<span class="obs">◈ Неделя наблюдения: шкала считается, последствий пока нет. ' + NEXT[k] + '</span>' +
    '</div>';
    return html + '</div>';
  }

  // ── Данные для галактики и окна фракции ───────────────────────────
  function fetchList() {
    var s = sb();
    if (!s || !s.rpc || cache.busy) return Promise.resolve(cache.list);
    cache.busy = true;
    return Promise.resolve(s.rpc('unrest_faction')).then(function(r) {
      cache.busy = false;
      if (r && !r.error && r.data && r.data.planets) { cache.list = r.data; cache.at = Date.now(); }
      return cache.list;
    }, function() { cache.busy = false; return cache.list; });
  }
  function byId(id) {
    var l = cache.list && cache.list.planets;
    if (!l) return null;
    for (var i = 0; i < l.length; i++) if (l[i].id === id) return l[i];
    return null;
  }

  // ── Карточка планеты ──────────────────────────────────────────────
  function planetRows(systemId) {
    var p = byId(systemId), rows = [];
    if (!p) return rows;
    var v = p.value | 0, f = expect(v, p.forecast, p.cap, p.hold);
    if (!v && f <= 0) return rows;                         // спокойно и спокойным останется — не шумим
    var k = stateOf(v);
    var row = document.createElement('div');
    row.className = 'pi-stat un-pi un-s-' + k;
    row.innerHTML = '<span>⚑ Напряжение</span><b>' + v + ' · ' + ST[k].t +
      (f ? ' <em class="un-trend ' + trendCls(f) + '">' + signed(f) + ' к утру</em>' : '') + '</b>';
    rows.push(row);
    return rows;
  }

  // ── Окно фракции ──────────────────────────────────────────────────
  function fsRenderUnrest() {
    var d = cache.list;
    if (!d || !d.planets) return '';
    var list = d.planets.filter(function(p) { return (p.value | 0) > 0 || expect(p.value, p.forecast, p.cap, p.hold) > 0; });
    var hot = d.planets.filter(function(p) { return (p.value | 0) >= 30; }).length;
    var meta = hot ? '<b class="hot">неспокойных ' + hot + '</b> · наблюдение' : 'наблюдение';
    var html = '<section class="fs-sec un-sec">' + (typeof fsSecHead === 'function' ? fsSecHead('Напряжение', meta) : '');
    if (!list.length) {
      return html + '<div class="fs-empty">Все планеты спокойны. Шкала растёт от голода, врага у стен и мародёров, ' +
        'гаснет от довольства, гарнизона и присмотра управляющего.</div></section>';
    }
    list.slice(0, 6).forEach(function(p) {
      var v = p.value | 0, k = stateOf(v), f = expect(v, p.forecast, p.cap, p.hold);
      html += '<button type="button" class="un-pl un-s-' + k + '" data-sys="' + esc(p.id) + '" data-info="1">' +
        '<span class="un-pl-body">' +
          '<span class="un-pl-top"><b>' + esc(p.name) + '</b><em class="un-st">' + ST[k].t + '</em></span>' +
          gauge(v, p.cap, true) +
          '<span class="un-pl-line">' + (p.controller ? esc(p.controller) : '<i>ничья</i>') +
            (p.hold ? ' · ' + esc(p.hold) : '') + '</span>' +
        '</span>' +
        '<span class="un-pl-v"><b>' + v + '</b><em class="un-trend ' + trendCls(f) + '">' + signed(f) + '</em></span>' +
      '</button>';
    });
    html += '<div class="un-more">' + (list.length > 6 ? 'и ещё ' + (list.length - 6) + ' ниже · ' : '') +
      'справа — шкала и её изменение к утренней выдаче</div>';
    return html + '</section>';
  }

  window.unSettlementHtml = settlementHtml;
  window.unPlanetRows = planetRows;
  window.unFetch = fetchList;
  window.fsRenderUnrest = fsRenderUnrest;

  // В галактике: данные для карточек планет — при входе и раз в 10 минут
  document.addEventListener('DOMContentLoaded', function() {
    if (!document.getElementById('galaxy-layer')) return;
    setTimeout(fetchList, 2500);
    setInterval(function() { if (!document.hidden) fetchList(); }, 600000);
  });
})();
