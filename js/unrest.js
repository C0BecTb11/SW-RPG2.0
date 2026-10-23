/* Напряжение на планетах — план мятежей (sql/unrest.sql, sql/unrest_riot.sql, claude/rebellion-plan.md).
 *
 * Шкала 0–100 у планеты: растёт от голода, врага у стен, ушедших с добычей мародёров и запустения,
 * гаснет от довольства, гарнизона, присмотра управляющего и спокойных суток. Считается раз в сутки
 * в час выдачи. Последствия (шаги 2 и 3) включаются переключателями на сервере: штрафы на 50/75,
 * мятеж на 100 (повстанцы у поселения, 48 ч на подавление), переговоры. Пока они выключены —
 * неделя наблюдения: шкала видна, последствий нет, интерфейс так и пишет.
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
  // Что ждёт на следующем пороге — подсказка под шкалой. Пока последствия выключены (неделя
  // наблюдения), к штрафам и мятежу приписано, что они ещё не действуют.
  function nextText(k, d) {
    var pct = d.pct || {}, pen = !!d.penalties, riots = !!d.riots;
    var later = ' (после недели наблюдения)';
    switch (k) {
      case 'calm':   return 'С 30 — ропот: предупреждения управляющему и лидеру.';
      case 'murmur': return 'С 50 — волнения: добыча и доход −' + (pct.unrest || 15) + '%' + (pen ? '.' : later + '.');
      case 'unrest': return 'С 75 — забастовки: −' + (pct.strike || 30) + '%, ополчение не встаёт' + (pen ? '.' : later + '.');
      case 'strike': return 'На 100 — мятеж: повстанцы у поселения, 48 ч на подавление' + (riots ? '.' : later + '.');
      default:       return riots ? 'Мятеж назрел: начнётся при выдаче.' : 'Мятеж назрел. Последствия включатся после недели наблюдения.';
    }
  }
  var KIND = { extract: 'добыча', income: 'доход', mood: 'довольство', build_time: 'стройка', hire_time: 'набор' };

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
  // Коротко, для строк карточки и списка: «45 ч» или «12 мин»
  function shortTo(iso) {
    var ms = new Date(iso).getTime() - Date.now();
    if (!(ms > 0)) return '';
    return ms >= 3600000 ? Math.ceil(ms / 3600000) + ' ч' : Math.max(1, Math.ceil(ms / 60000)) + ' мин';
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
    // мятеж на другой планете фракции держит шкалу на 99 — прогноз не обещает больше
    var cap = d.riot_elsewhere && d.riots ? Math.min(f.cap || 100, 99) : f.cap;
    var hold = f.hold, grow = expect(v, fd, cap, hold);
    var riot = d.riot || null;
    var html = '<div class="un-box un-s-' + k + '">';
    html += '<div class="stl-sec"><span>Напряжение</span><em class="un-st">' + (riot ? 'мятеж' : ST[k].t) + '</em></div>';
    html += '<div class="un-top">' +
      '<b class="un-val">' + v + '</b>' +
      '<span class="un-top-r"><i>из 100</i>' +
        (riot ? '<em class="un-trend up">пока идёт мятеж</em>'       // шкала стоит на 100 до его конца
              : '<em class="un-trend ' + trendCls(grow) + '">к утру ' + signed(grow) + '</em>') + '</span>' +
    '</div>';
    html += gauge(v, f.cap);
    html += '<div class="un-scale"><span style="left:30%">30</span><span style="left:50%">50</span><span style="left:75%">75</span></div>';

    // Мятеж и действующие штрафы — сразу под шкалой: это то, что происходит сейчас
    if (riot) html += riotHtml(riot);
    html += effectsHtml(d.effects || []);

    // Прогноз на ближайшую выдачу: из чего сложится (во время мятежа шкала не движется — не показываем)
    var rows = riot ? [] : (f.rows || []);
    if (rows.length) {
      html += '<div class="un-rows">' + rows.map(function(r) {
        var n = r.value | 0;
        return '<div class="un-row"><span>' + esc(r.label) + '</span><b class="' + (n > 0 ? 'up' : 'down') + '">' + signed(n) + '</b></div>';
      }).join('') + '</div>';
    }

    var notes = [];
    if (hold) notes.push('Шкала не растёт: ' + esc(hold) + (f.hold_until ? ' · ещё ' + daysTo(f.hold_until) : ''));
    if (f.cap_why) notes.push('Предел ' + (f.cap | 0) + ': ' + esc(f.cap_why));
    if (d.riot_elsewhere && !d.riot) notes.push('Мятеж на планете ' + esc(d.riot_elsewhere) + ': здесь шкала держится на 99, пока он не кончится');
    var hist = d.history || [];
    if (hist.length) {
      var max = 1;
      hist.forEach(function(h) { max = Math.max(max, h.value | 0); });
      html += '<div class="un-hist" title="Последние выдачи">' + hist.map(function(h) {
        var hv = h.value | 0;
        return '<i class="un-s-' + stateOf(hv) + '" style="height:' + Math.max(8, Math.round(hv / Math.max(30, max) * 100)) + '%"><em>' + hv + '</em></i>';
      }).join('') + '</div><div class="un-hist-cap">последние выдачи</div>';
    }
    // Переговоры — решение, после всех цифр
    if (d.deal) html += dealHtml(d.deal, !!riot);
    html += '<div class="un-note">' +
      (notes.length ? notes.map(function(n) { return '<span>' + n + '</span>'; }).join('') : '') +
      (d.observe
        ? '<span class="obs">◈ Неделя наблюдения: шкала считается, последствий пока нет. ' + nextText(k, d) + '</span>'
        : (d.riot ? '' : '<span class="obs">◈ ' + nextText(k, d) + '</span>')) +
    '</div>';
    return html + '</div>';
  }

  // Мятеж: сколько повстанцев осталось и сколько времени до провала.
  // Отсчёт и полоса времени — через data-stl-end окна поселения (stlTick), без своих таймеров.
  function riotHtml(r) {
    var total = Math.max(1, r.total | 0), alive = Math.max(0, Math.min(total, r.alive | 0));
    var end = new Date(r.ends_at).getTime(), start = new Date(r.started_at).getTime();
    var span = Math.max(1, Math.round((end - start) / 1000));
    var pips = '';
    for (var i = 0; i < total; i++) pips += '<i' + (i < alive ? ' class="on"' : '') + '></i>';
    return '<div class="un-riot">' +
      '<div class="un-riot-top"><b>⚑ Мятеж</b>' +
        '<em>до провала <span data-stl-end="' + end + '">' + hoursTo(r.ends_at) + '</span></em></div>' +
      '<div class="un-riot-time"><i data-stl-end="' + end + '" data-stl-total="' + span + '"></i></div>' +
      '<div class="un-riot-reb"><span>Повстанцы у поселения</span><span class="un-pips">' + pips + '</span>' +
        '<b>' + alive + ' из ' + total + '</b></div>' +
      '<div class="un-riot-txt">Добыча и доход −50%, стройка и набор вдвое дольше. Перебейте повстанцев — ' +
        'шкала упадёт до 50. Не успеете: уровень поселения −1, развитие с нуля, управляющий снят.</div>' +
    '</div>';
  }

  // Действующие эффекты напряжения (кроме самого мятежа — он расписан выше)
  function effectsHtml(list) {
    var groups = {};
    list.forEach(function(e) {
      if (e.source === 'riot') return;
      var key = e.source + '|' + e.title + '|' + e.value;
      if (!groups[key]) groups[key] = { title: e.title, value: e.value | 0, ends: e.ends, kinds: [] };
      if (KIND[e.kind]) groups[key].kinds.push(KIND[e.kind]);
    });
    var out = Object.keys(groups).map(function(key) {
      var g = groups[key], n = g.value, left = hoursTo(g.ends);
      var what = g.kinds.join(' и ') + ' ' + (n > 0 ? '+' + n : '−' + Math.abs(n)) + (g.kinds[0] === 'довольство' ? '' : '%');
      return '<div class="un-eff"><span>' + esc(g.title) + '</span>' +
        (left ? '<em>ещё ' + left + '</em>' : '') + '<b>' + esc(what) + '</b></div>';
    });
    return out.length ? '<div class="un-effs">' + out.join('') + '</div>' : '';
  }

  // Переговоры: цена и кнопки (управляющий — своими, лидер и казначей — из казны) или причина отказа
  function dealHtml(dl, riot) {
    var html = '<div class="un-deal">' +
      '<div class="un-deal-h"><b>Переговоры</b><em>шкала → ' + (dl.value | 0 || 60) + '</em></div>';
    if (!dl.ok) return html + '<div class="un-deal-why">' + esc(dl.why || 'Сейчас договориться нельзя') + '</div></div>';
    var cr = dl.credits | 0, food = dl.food | 0, noFood = (dl.food_have | 0) < food;
    html += '<div class="un-deal-cost"><b>' + fmt(cr) + ' кр.</b> и <b>' + fmt(food) + ' еды</b> со склада' +
      ' <i class="' + (noFood ? 'short' : '') + '">есть ' + fmt(dl.food_have | 0) + '</i></div>';
    if (dl.self) {
      var poor = (dl.my_credits | 0) < cr;
      html += '<button type="button" class="stl-go un-deal-go" data-un-deal="self"' + (poor || noFood ? ' disabled' : '') + '>' +
        'Договориться' + '<em>' + (poor ? 'не хватает кредитов' : noFood ? 'не хватает еды' : 'своими кредитами') + '</em></button>';
    }
    if (dl.treasury) {
      var thin = (dl.bank | 0) < cr;
      html += '<button type="button" class="stl-go un-deal-go alt" data-un-deal="bank"' + (thin || noFood ? ' disabled' : '') + '>' +
        'Из казны' + '<em>в казне ' + fmt(dl.bank | 0) + ' кр.</em></button>';
    }
    return html + '<div class="un-deal-why">' + (riot ? 'Повстанцы уйдут без боя. ' : 'Забастовки кончатся. ') +
      'Снова договориться — не раньше чем через 7 суток.</div></div>';
  }
  function fmt(n) { return String(n | 0).replace(/\B(?=(\d{3})+(?!\d))/g, ' '); }

  // Кнопки переговоров живут в окне поселения: один обработчик на документ
  document.addEventListener('click', function(e) {
    var btn = e.target && e.target.closest ? e.target.closest('[data-un-deal]') : null;
    if (!btn || btn.disabled) return;
    var s = sb(), sys = typeof systemId !== 'undefined' ? systemId : null;
    if (!s || !sys) return;
    var bank = btn.getAttribute('data-un-deal') === 'bank';
    var go = function() {
      btn.disabled = true; btn.classList.add('busy');
      Promise.resolve(s.rpc('unrest_negotiate', { p_system: sys, p_treasury: bank })).then(function(r) {
        if (r && r.error) { btn.disabled = false; btn.classList.remove('busy'); alert(r.error.message); return; }
        cache.at = 0;
        if (typeof loadSettlementPanel === 'function') loadSettlementPanel();
      }, function() { btn.disabled = false; btn.classList.remove('busy'); });
    };
    var cost = btn.closest('.un-deal').querySelector('.un-deal-cost');
    var note = (cost ? cost.textContent.replace(/\s*есть.*$/, '') : '') + (bank ? ' — из казны фракции.' : ' — из твоих кредитов.') +
      ' Шкала опустится до 60.';
    if (typeof gameConfirm !== 'function') { if (confirm('Договориться? ' + note)) go(); return; }
    gameConfirm({ kicker: 'Переговоры', title: 'Договориться с недовольными', note: note, ok: 'Договориться', cancel: 'Не сейчас' }, go);
  });

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

  // ── Условия суток и управляющий ───────────────────────────────────
  // Сервер отдаёт их только своей фракции (unrest_faction), карточка зовёт только для своих планет.
  var AWAY_DAYS = 3;
  function condText(p) {
    var c = p.cond || {}, d = cache.list || {};
    if (!p.controller) return { cls: 'bad', t: 'нет управляющего · довольство −' + (d.no_ruler || 10) + ' в сутки' };
    if (!(c.total | 0)) return { cls: '', t: 'на эти сутки нет' };
    var left = c.left || [];
    return { cls: left.length ? 'mid' : 'good',
             t: (c.done | 0) + '/' + (c.total | 0) + (left.length ? ' · осталось: ' + left.join(', ') : ' · всё выполнено') };
  }
  function seenText(n) { return n === 1 ? 'не заходит сутки' : 'не заходит ' + n + ' ' + (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? 'дня' : 'дней'); }

  function revoke(p) {
    var go = function() {
      var s = sb(); if (!s) return;
      Promise.resolve(s.rpc('leader_revoke_planet', { p_system: p.id })).then(function(r) {
        if (r && r.error) { if (typeof hqToast === 'function') hqToast(r.error.message, true); else alert(r.error.message); return; }
        if (typeof hqToast === 'function') hqToast(p.controller + ' больше не управляет: ' + p.name);
        fetchList().then(function() { if (typeof openPlanetInfo === 'function') openPlanetInfo(p.id); });
      });
    };
    if (typeof gameConfirm !== 'function') { if (confirm('Снять управляющего ' + p.controller + '?')) go(); return; }
    gameConfirm({ tone: 'danger', kicker: 'Снять управляющего', title: p.name,
      sub: p.controller + ' · ' + seenText(p.seen_days | 0),
      note: 'Планета станет ничьей: условий не будет, довольство начнёт падать. Новый управляющий — по заявке, как обычно.',
      ok: 'Снять', cancel: 'Оставить' }, go);
  }

  function fillRows(systemId, rows) {
    var p = byId(systemId);
    rows.forEach(function(r) { r.innerHTML = ''; r.style.display = 'none'; });
    if (!p) return;
    var i = 0;
    function next(cls) { var r = rows[i++]; r.style.display = ''; r.className = 'pi-stat ' + cls; return r; }

    var c = condText(p), r1 = next('un-pi un-cond ' + c.cls);
    r1.innerHTML = '<span>☑ Условия</span><b>' + esc(c.t) + '</b>';

    if (p.controller && (p.seen_days | 0) >= AWAY_DAYS) {
      var r2 = next('un-pi un-away');
      r2.innerHTML = '<span>⚠ Управляющий</span><b>' + esc(seenText(p.seen_days | 0)) + '</b>';
      if (cache.list && cache.list.is_leader) {
        var btn = document.createElement('button');
        btn.type = 'button'; btn.className = 'un-pi-btn'; btn.textContent = 'Снять';
        btn.addEventListener('click', function(e) { e.stopPropagation(); revoke(p); });
        r2.querySelector('b').appendChild(btn);
      }
    }

    var v = p.value | 0, f = expect(v, p.forecast, p.cap, p.hold);
    if (p.riot) {                                           // мятеж важнее шкалы: повстанцы и время
      var rr = next('un-pi un-s-riot un-pi-riot'), left = shortTo(p.riot.ends_at);
      rr.innerHTML = '<span>⚑ Мятеж</span><b>повстанцев ' + (p.riot.alive | 0) + ' из ' + (p.riot.total | 0) +
        (left ? ' · ещё ' + left : '') + '</b>';
    } else if (v || f > 0) {                                // спокойно и спокойным останется — не шумим
      var k = stateOf(v), r3 = next('un-pi un-s-' + k);
      r3.innerHTML = '<span>⚑ Напряжение</span><b>' + v + ' · ' + ST[k].t +
        (p.pen ? ' · добыча и доход −' + (p.pen | 0) + '%' : '') +
        (f ? ' <em class="un-trend ' + trendCls(f) + '">' + signed(f) + ' к утру</em>' : '') + '</b>';
    }
  }

  // ── Карточка планеты ──────────────────────────────────────────────
  // Строки создаются сразу (из того, что уже загружено), а если данным больше минуты —
  // перечитываются и строки обновляются на месте: условия меняются в течение дня.
  function planetRows(systemId) {
    if (!byId(systemId) && !cache.list) return [];
    var rows = [document.createElement('div'), document.createElement('div'), document.createElement('div')];
    fillRows(systemId, rows);
    if (Date.now() - cache.at > 60000) fetchList().then(function() { fillRows(systemId, rows); });
    return rows;
  }

  // ── Окно фракции: приписки к строке планеты ───────────────────────
  function planetBits(systemId) {
    var p = byId(systemId), out = [];
    if (!p) return out;
    if (p.riot) out.push('<span class="fs-mood bad">⚑ мятеж ' + (p.riot.alive | 0) + '/' + (p.riot.total | 0) + '</span>');
    var c = p.cond || {};
    if (p.controller && (c.total | 0)) {
      var left = (c.left || []).length;
      out.push('<span class="fs-mood ' + (left ? 'mid' : 'good') + '">☑ ' + (c.done | 0) + '/' + (c.total | 0) + '</span>');
    }
    if (p.controller && (p.seen_days | 0) >= AWAY_DAYS) out.push('<span class="fs-mood bad">' + esc(seenText(p.seen_days | 0)) + '</span>');
    return out;
  }

  // ── Окно фракции ──────────────────────────────────────────────────
  function fsRenderUnrest() {
    var d = cache.list;
    if (!d || !d.planets) return '';
    var list = d.planets.filter(function(p) { return (p.value | 0) > 0 || expect(p.value, p.forecast, p.cap, p.hold) > 0; });
    var hot = d.planets.filter(function(p) { return (p.value | 0) >= 30; }).length;
    var mode = d.observe ? 'наблюдение' : 'последствия действуют';
    var meta = hot ? '<b class="hot">неспокойных ' + hot + '</b> · ' + mode : mode;
    var html = '<section class="fs-sec un-sec">' + (typeof fsSecHead === 'function' ? fsSecHead('Напряжение', meta) : '');
    if (!list.length) {
      return html + '<div class="fs-empty">Все планеты спокойны. Шкала растёт от голода, врага у стен и мародёров, ' +
        'гаснет от довольства, гарнизона и присмотра управляющего.</div></section>';
    }
    list.slice(0, 6).forEach(function(p) {
      var v = p.value | 0, k = stateOf(v), f = expect(v, p.forecast, p.cap, p.hold);
      html += '<button type="button" class="un-pl un-s-' + k + '" data-sys="' + esc(p.id) + '" data-info="1">' +
        '<span class="un-pl-body">' +
          '<span class="un-pl-top"><b>' + esc(p.name) + '</b><em class="un-st">' + (p.riot ? 'мятеж' : ST[k].t) + '</em></span>' +
          gauge(v, p.cap, true) +
          '<span class="un-pl-line">' +
            (p.riot ? '<i class="riot">повстанцев ' + (p.riot.alive | 0) + '/' + (p.riot.total | 0) +
                        (shortTo(p.riot.ends_at) ? ' · ещё ' + shortTo(p.riot.ends_at) : '') + '</i> · ' : '') +
            (p.controller ? esc(p.controller) : '<i>ничья</i>') +
            (p.pen ? ' · штраф −' + (p.pen | 0) + '%' : '') +
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
  window.unPlanetBits = planetBits;
  window.unFetch = fetchList;
  window.fsRenderUnrest = fsRenderUnrest;

  // В галактике: данные для карточек планет — при входе и раз в 10 минут
  document.addEventListener('DOMContentLoaded', function() {
    if (!document.getElementById('galaxy-layer')) return;
    setTimeout(fetchList, 2500);
    setInterval(function() { if (!document.hidden) fetchList(); }, 600000);
  });
})();
