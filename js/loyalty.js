/* Настроения планет — за кого народ (sql/loyalty.sql, claude/loyalty-plan.md).
 *
 * Шкала −100…+100 у каждой планеты: плюс — за Республику, минус — за КНС. Сторону планета сама не
 * меняет — только захват войсками. Шкала решает, как быстро враг возьмёт площадь, сколько жителей
 * встанет на защиту и не встанут ли они за врага. Сдвигается раз в сутки (исконные настроения,
 * довольство, напряжение, гарнизон, законы) и тайными операциями: агитация штаба качает народ
 * к своим и плетёт сеть подполья, облава хозяина её рвёт.
 *
 * Здесь все показы одной шкалы (префикс lo-, всё внутри IIFE):
 *   loSettlementHtml(data) — блок во вкладке «Развитие» окна поселения (ground-battle.js);
 *   loPlanetRows(systemId) — строки в карточке планеты в галактике (planet-info.js);
 *   loFetch() / fsRenderLoyalty() — раздел «Настроения» в окне фракции (faction-panel.js);
 *   дуги у шатких планет в галактике — сами, по данным loyalty_map;
 *   LO — общие помощники для окна тайных операций (js/spy-ops.js: агитация).
 */
(function() {
  'use strict';

  // Ступени — по поддержке хозяина (как loyalty_stage_of в базе)
  var ST = {
    devoted: { t: 'предана',    n: 3 },
    loyal:   { t: 'верна',      n: 2 },
    calm:    { t: 'спокойна',   n: 1 },
    waver:   { t: 'колеблется', n: 0 },
    murmur:  { t: 'ропщет',     n: -1 },
    under:   { t: 'подполье',   n: -2 },
    wait:    { t: 'ждёт врага', n: -3 }
  };
  // Что ступень значит для хозяина — одной строкой под шкалой
  var MEANS = {
    devoted: 'Народ предан: враг берёт площадь вдвое дольше, ополченцев в полтора раза больше, доход и добыча +5 %.',
    loyal:   'Народ верен: захват в полтора раза дольше, ополченцев на четверть больше.',
    calm:    'Народ спокоен: обычный срок захвата, обычное ополчение.',
    waver:   'Народ колеблется: враг берёт площадь быстрее (×0,8), ополчение встаёт вполовину.',
    murmur:  'Народ ропщет: захват ×0,6, ополчение не встанет, напряжение растёт.',
    under:   'В городе подполье: захват ×0,35, врагу видно поселение, с его сетью жители встанут за него.',
    wait:    'Народ ждёт врага: площадь падает за пятую часть срока, подполье встаёт за наступающих.'
  };
  var FAC = { republic: 'Республика', cis: 'КНС' };
  var FAC_GEN = { republic: 'Республики', cis: 'КНС' };

  var cache = { map: null, at: 0, busy: false, by: {} };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function(ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }
  function stageKey(s) {
    s = s | 0;
    return s >= 80 ? 'devoted' : s >= 50 ? 'loyal' : s >= 20 ? 'calm' : s >= -19 ? 'waver' : s >= -49 ? 'murmur' : s >= -79 ? 'under' : 'wait';
  }
  function signed(n) { n = n | 0; return n > 0 ? '+' + n : n < 0 ? '−' + Math.abs(n) : '0'; }
  function trendCls(n) { return n > 0 ? 'up' : n < 0 ? 'down' : 'flat'; }
  function sb() { return typeof supabase !== 'undefined' ? supabase : null; }
  // время сервера (js/credits-bar.js): сроки — отметки сервера, часы телефона могут спешить или отставать
  function nowMs() { return typeof svNow === 'function' ? svNow() : Date.now(); }
  function leftMs(iso) { var t = Date.parse(iso); return isNaN(t) ? 0 : t - nowMs(); }
  function dur(sec) {
    sec = Math.max(0, Math.round(sec || 0));
    if (sec >= 3600) {
      var h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
      if (m === 60) { h++; m = 0; }
      return h + ' ч' + (m ? ' ' + m + ' мин' : '');
    }
    return Math.max(1, Math.round(sec / 60)) + ' мин';
  }
  function shortTo(iso) {
    var ms = leftMs(iso);
    if (!(ms > 0)) return '';
    return ms >= 3600000 ? Math.ceil(ms / 3600000) + ' ч' : Math.max(1, Math.ceil(ms / 60000)) + ' мин';
  }
  function kText(k) {
    k = Number(k);
    if (!(k > 0)) return 'не встанет';
    if (k < 1) return 'вполовину';
    return '×' + String(Math.round(k * 100) / 100).replace('.', ',');
  }
  function pips(n, max, cls) {
    var h = '';
    for (var i = 0; i < max; i++) h += '<i' + (i < n ? ' class="on"' : '') + '></i>';
    return '<span class="lo-pips' + (cls ? ' ' + cls : '') + '">' + h + '</span>';
  }

  // Шкала: слева КНС, справа Республика, середина — ноль. Заливка — от середины к значению,
  // насечки — пороги ступеней (±20, ±50, ±80), ромбик — исконные настроения планеты.
  function pos(v) { return Math.max(0, Math.min(100, ((v | 0) + 100) / 2)); }
  function scale(v, home, mini) {
    v = Math.max(-100, Math.min(100, v | 0));
    var p = pos(v), side = v >= 0 ? 'rep' : 'cis';
    var ticks = mini ? '' : [10, 25, 40, 60, 75, 90].map(function(x) { return '<s style="left:' + x + '%"></s>'; }).join('');
    return '<span class="lo-scale' + (mini ? ' mini' : '') + '">' +
      '<i class="lo-half cis"></i><i class="lo-half rep"></i>' + ticks +
      '<b class="lo-fill ' + side + '" style="left:' + Math.min(50, p) + '%;width:' + Math.abs(p - 50) + '%"></b>' +
      (home != null && !mini ? '<u class="lo-home" style="left:' + pos(home) + '%"></u>' : '') +
      (mini ? '' : '<em class="lo-dot ' + side + '" style="left:' + p + '%"></em>') +
    '</span>';
  }
  function homeText(home, fac) {
    var h = home | 0;
    if (Math.abs(h) < 5) return 'исконно — ни за кого';
    var who = h > 0 ? 'republic' : 'cis';
    return 'исконно — за ' + FAC[who] + (who === fac ? '' : ' · тянет к врагу');
  }

  // ── Окно поселения (своя планета) ─────────────────────────────────
  function settlementHtml(d) {
    if (!d || !d.enabled || d.s == null || !d.stage || !d.mine) return '';
    var s = d.s | 0, k = d.stage.k || stageKey(s), f = d.forecast || {}, fd = f.delta | 0;
    var html = '<div class="lo-box lo-s-' + k + '">';
    html += '<div class="stl-sec"><span>Настроения</span><em class="lo-st">народ ' + ST[k].t + '</em></div>';
    html += '<div class="lo-top">' +
      '<b class="lo-val">' + signed(s) + '</b>' +
      '<span class="lo-top-r"><i>поддержка ' + esc(FAC_GEN[d.faction] || '') + ' · из ±100</i>' +
        '<em class="lo-trend ' + trendCls(fd) + '">к утру ' + signed(fd) + '</em></span>' +
    '</div>';
    html += scale(d.v, d.home);
    html += '<div class="lo-ends"><span class="cis">КНС</span><span class="mid">' + esc(homeText(d.home, d.faction)) + '</span><span class="rep">Республика</span></div>';

    // Что ступень даёт прямо сейчас
    var goal = d.goal | 0, base = d.base | 0, gc = !d.effects ? '' : goal < base ? 'bad' : goal > base ? 'good' : '';
    var mk = d.effects ? Number(d.militia_k) : 1;
    html += '<div class="lo-fx">' +
      '<div class="' + gc + '"><b>' + dur(goal) + '</b><span>враг возьмёт площадь</span></div>' +
      '<div class="' + (mk > 1 ? 'good' : mk < 1 ? 'bad' : '') + '"><b>' + kText(mk) + '</b><span>ополчение</span></div>' +
      '<div class="' + (k === 'devoted' && d.effects ? 'good' : '') + '"><b>' + (k === 'devoted' && d.effects ? '+5 %' : '—') + '</b><span>доход и добыча</span></div>' +
    '</div>';
    html += '<div class="lo-means">' + (d.effects ? MEANS[k] : 'Последствия настроений сейчас выключены: шкала только считается.') + '</div>';

    // Сети подполья врага на планете
    var cells = d.cells || [];
    cells.forEach(function(c) { html += cellHtml(c, d); });
    if (cells.length && d.ops) html += sweepHtml(d.sweep || {});
    else if (d.sweep && d.sweep.last && d.sweep.last.status === 'ok' && leftMs(d.sweep.cd_until) > 0) {
      html += '<div class="lo-note good">Облава разгромила подполье · следующая — через ' + shortTo(d.sweep.cd_until) + '</div>';
    }

    // Прогноз на ближайшую выдачу
    var rows = f.rows || [];
    if (rows.length) {
      html += '<div class="lo-rows">' + rows.map(function(r) {
        var n = r.value | 0;
        return '<div class="lo-row"><span>' + esc(r.label) + '</span><b class="' + (n > 0 ? 'up' : 'down') + '">' + signed(n) + '</b></div>';
      }).join('') + '</div>';
      if ((f.raw | 0) !== fd && Math.abs(f.raw | 0) > Math.abs(fd)) html += '<div class="lo-cap">за сутки — не больше ±' + (f.cap | 0) + '</div>';
    }

    // Последние изменения: столбики от середины — вверх к нам, вниз к врагу
    var hist = d.history || [];
    if (hist.length > 1) {
      html += '<div class="lo-hist">' + hist.map(function(h) {
        var hv = Math.max(-100, Math.min(100, h.value | 0)), hk = stageKey(hv);
        return '<i class="lo-s-' + hk + (hv < 0 ? ' neg' : '') + '" style="height:' + Math.max(4, Math.abs(hv) / 2) + '%" title="' + signed(hv) + '"></i>';
      }).join('') + '</div><div class="lo-hist-cap">последние изменения</div>';
    }

    var notes = [];
    if (d.grace) notes.push('Перемена власти: ещё ' + shortTo(d.grace) + ' ступень не ускоряет захват, подполье молчит.');
    if (d.capital) notes.push('Столица: враг не возьмёт её быстрее 6 ч, подполье здесь не встаёт.');
    notes.push('<span class="obs">◈ Поднимают: довольство 40+ и 70+, гарнизон 5+ в поселении, управляющий, законы и «Голопередачи» казны, облавы. Роняют: волнения, враг на планете, подполье врага.</span>');
    html += '<div class="lo-notes">' + notes.map(function(n) { return n.charAt(0) === '<' ? n : '<span>' + n + '</span>'; }).join('') + '</div>';
    return html + '</div>';
  }

  function partisans(level, s, d) {
    if (d.capital || d.grace) return 0;
    return Math.min(9, (level | 0) * 2 + (s <= -80 ? 3 : s <= -50 && level ? 1 : 0));
  }
  function cellHtml(c, d) {
    var lv = c.level | 0, n = partisans(lv, d.s | 0, d);
    return '<div class="lo-cell">' +
      '<div class="lo-cell-top"><b>Подполье ' + esc(FAC_GEN[c.faction] || '') + '</b>' + pips(lv, 3) + '<em>ур. ' + lv + '</em></div>' +
      '<div class="lo-cell-txt">Каждые сутки −' + lv + ' к поддержке. ' +
        (n ? 'Начнёт враг захват — за него встанет ' + n + ' ' + plural(n, 'боец', 'бойца', 'бойцов') + '.' : 'Бойцов за врага пока не выставит.') +
        (lv >= 3 ? ' Сеть доносит врагу: в бою он видит поселение.' : '') +
        ' Сеть может раскрыться сама — гарнизон и узел связи помогают.</div>' +
    '</div>';
  }
  function plural(n, a, b, c) { var m = n % 10, h = n % 100; return m === 1 && h !== 11 ? a : m >= 2 && m <= 4 && (h < 12 || h > 14) ? b : c; }

  // Облава: гарнизон прочёсывает кварталы; отсчёт — через data-stl-end окна поселения (stlTick)
  function sweepHtml(w) {
    var html = '<div class="lo-sweep">' +
      '<div class="lo-sweep-h"><b>Облава</b><em>шанс ' + (w.chance | 0) + ' %</em></div>';
    if (w.active) {
      var endIso = w.active.resolves_at, startIso = w.active.started_at, left = leftMs(endIso);
      var span = Math.max(1, Math.round((Date.parse(endIso) - Date.parse(startIso)) / 1000));
      if (left <= 0) {                       // срок вышел — база подведёт итог в ближайшие пару минут
        return html + '<div class="lo-sweep-run"><span>Гарнизон прочёсывает кварталы</span><em>подводим итог…</em></div>' +
          '<div class="lo-bar"><i style="width:100%"></i></div></div>';
      }
      // конец — в часах телефона, округлён до секунды: одинаковый при каждой перерисовке (stlTick помнит истёкшие концы)
      var end = Math.round((Date.now() + left) / 1000) * 1000;
      html += '<div class="lo-sweep-run"><span>Гарнизон прочёсывает кварталы</span><em>итог через <b data-stl-end="' + end + '">' + shortTo(endIso) + '</b></em></div>' +
        '<div class="lo-bar"><i data-stl-end="' + end + '" data-stl-total="' + span + '"></i></div>';
      return html + '</div>';
    }
    html += '<div class="lo-sweep-txt">' + dur((w.minutes | 0) * 60) + ' на поиски. Шанс — 40 % и ещё 4 % за бойца в поселении (сейчас ' + (w.garrison | 0) +
      '), узел связи +10 %. Удача — сеть врага разгромлена, поддержка +3; неудача — −1.</div>';
    if (w.last) html += '<div class="lo-sweep-last ' + (w.last.status === 'ok' ? 'good' : 'bad') + '">Прошлая облава: ' + (w.last.status === 'ok' ? 'удалась' : 'впустую') + '</div>';
    html += '<button type="button" class="stl-go lo-sweep-go" data-lo-sweep="1"' + (w.block ? ' disabled' : '') + '>Начать облаву<em>' + (w.cost | 0) + ' кр.</em></button>';
    if (w.block) html += '<div class="lo-why">' + esc(w.block) + '</div>';
    return html + '</div>';
  }

  // Кнопка облавы живёт в окне поселения: один обработчик на документ
  document.addEventListener('click', function(e) {
    var btn = e.target && e.target.closest ? e.target.closest('[data-lo-sweep]') : null;
    if (!btn || btn.disabled) return;
    var s = sb(), sys = typeof systemId !== 'undefined' ? systemId : null;
    if (!s || !sys) return;
    var go = function() {
      btn.disabled = true; btn.classList.add('busy');
      Promise.resolve(s.rpc('loyalty_sweep', { p_system: sys })).then(function(r) {
        if (r && r.error) { btn.disabled = false; btn.classList.remove('busy'); alert(typeof gameErr === 'function' ? gameErr(r.error) : r.error.message); return; }
        cache.at = 0;
        if (typeof refreshCreditsSoon === 'function') refreshCreditsSoon();
        if (typeof loadSettlementPanel === 'function') loadSettlementPanel();
      }, function() { btn.disabled = false; btn.classList.remove('busy'); });
    };
    var cost = btn.querySelector('em') ? btn.querySelector('em').textContent : '';
    var note = 'Гарнизон два часа прочёсывает кварталы. Шанс считается в конце — держите бойцов в поселении. Спишется ' + cost + '.';
    if (typeof gameConfirm !== 'function') { if (confirm('Начать облаву? ' + note)) go(); return; }
    gameConfirm({ tone: 'danger', kicker: 'Облава', title: 'Разгромить подполье врага', note: note, ok: 'Начать', cancel: 'Не сейчас' }, go);
  });

  // ── Данные всех планет ────────────────────────────────────────────
  function fetchMap() {
    var s = sb();
    if (!s || !s.rpc || cache.busy) return Promise.resolve(cache.map);
    cache.busy = true;
    return Promise.resolve(s.rpc('loyalty_map')).then(function(r) {
      cache.busy = false;
      if (r && !r.error && r.data && r.data.planets) {
        cache.map = r.data; cache.at = Date.now(); cache.by = {};
        r.data.planets.forEach(function(p) { cache.by[p.id] = p; });
        paintArcs();
      }
      return cache.map;
    }, function() { cache.busy = false; return cache.map; });
  }
  function byId(id) { return cache.by[id] || null; }

  // ── Карточка планеты ──────────────────────────────────────────────
  function fillRows(systemId, rows) {
    rows.forEach(function(r) { r.innerHTML = ''; r.style.display = 'none'; });
    var p = byId(systemId), m = cache.map;
    if (!p || !m || !m.enabled || p.s == null) return;
    var k = stageKey(p.s), mine = m.faction && p.faction === m.faction, i = 0;
    function next(cls) { var r = rows[i++]; r.style.display = ''; r.className = 'pi-stat lo-pi ' + cls; return r; }

    var r1 = next('lo-s-' + k);
    r1.innerHTML = '<span>◐ Настроения</span><b><em class="lo-st">народ ' + ST[k].t + '</em> · ' + signed(p.s) + scale(p.v, null, true) + '</b>';

    if (m.effects) {
      var tags = [];
      if (p.capital) tags.push('столица');
      if (p.grace) tags.push('перемена власти · ' + shortTo(p.grace));
      var r2 = next('lo-goal ' + ((p.goal | 0) < (m.base | 0) ? (mine ? 'bad' : 'good') : (p.goal | 0) > (m.base | 0) ? (mine ? 'good' : 'bad') : ''));
      r2.innerHTML = '<span>⧗ Захват площади</span><b>' + dur(p.goal) + (tags.length ? ' · ' + esc(tags.join(' · ')) : '') + '</b>';
    }
    if (p.cell) {
      var r3 = next(mine ? 'lo-cellrow bad' : 'lo-cellrow good');
      r3.innerHTML = mine
        ? '<span>⚠ Подполье врага</span><b>ур. ' + (p.cell | 0) + pips(p.cell, 3, 'bad') + '</b>'
        : '<span>✦ Наша сеть</span><b>ур. ' + (p.cell | 0) + pips(p.cell, 3, 'good') + '</b>';
    }
    // Чужая планета, где подполье доносит нам (как loyalty_battle): кто стоит в поселении
    if (!mine && m.faction && m.effects && !p.capital && !p.grace && ((p.s | 0) <= -50 || (p.cell | 0) >= 3)) {
      var r4 = next('lo-intel'), s = sb();
      r4.innerHTML = '<span>☍ Донесения подполья</span><b>…</b>';
      if (s) Promise.resolve(s.rpc('loyalty_state', { p_system: systemId })).then(function(r) {
        var it = r && !r.error && r.data && r.data.intel;
        if (!it) { r4.style.display = 'none'; return; }
        var bits = [(it.infantry | 0) + ' пех.', (it.vehicles | 0) + ' техн.'];
        if (it.heroes | 0) bits.push((it.heroes | 0) + ' гер.');
        bits.push('ополч. ' + (it.militia | 0));
        r4.querySelector('b').textContent = bits.join(' · ');
      }, function() { r4.style.display = 'none'; });
    }
  }
  function planetRows(systemId) {
    var rows = [document.createElement('div'), document.createElement('div'), document.createElement('div'), document.createElement('div')];
    fillRows(systemId, rows);
    if (Date.now() - cache.at > 60000) fetchMap().then(function() { fillRows(systemId, rows); });
    return rows;
  }

  // ── Окно фракции ──────────────────────────────────────────────────
  function plRow(p, mine) {
    var s = p.s | 0, k = stageKey(s), m = cache.map || {};
    var line = [];
    if (m.effects) line.push('захват ' + dur(p.goal));
    if (p.cell) line.push(mine ? '<i class="bad">подполье врага ур. ' + (p.cell | 0) + '</i>' : '<i class="good">наша сеть ур. ' + (p.cell | 0) + '</i>');
    if (p.grace) line.push('перемена власти');
    if (p.capital) line.push('столица');
    var tr = mine && p.trend != null ? '<em class="lo-trend ' + trendCls(p.trend) + '">' + signed(p.trend) + '</em>' : '';
    var name = p.name || p.id;
    return '<button type="button" class="lo-pl lo-s-' + k + '" data-sys="' + esc(p.id) + '" data-info="1">' +
      '<span class="lo-pl-body">' +
        '<span class="lo-pl-top"><b>' + esc(name) + '</b><em class="lo-st">народ ' + ST[k].t + '</em></span>' +
        scale(p.v, null, true) +
        '<span class="lo-pl-line">' + (line.join(' · ') || '&nbsp;') + '</span>' +
      '</span>' +
      '<span class="lo-pl-v"><b>' + signed(s) + '</b>' + tr + '</span>' +
    '</button>';
  }
  function fsRenderLoyalty() {
    var m = cache.map;
    if (!m || !m.enabled || !m.planets || !m.faction) return '';
    var own = m.planets.filter(function(p) { return p.faction === m.faction && p.s != null; });
    var foe = m.planets.filter(function(p) { return p.faction && p.faction !== m.faction && p.s != null; });
    var shaky = own.filter(function(p) { return (p.s | 0) < 50 || p.cell; }).sort(function(a, b) { return (a.s | 0) - (b.s | 0); });
    var open = foe.filter(function(p) { return (p.s | 0) < 20 || p.cell; }).sort(function(a, b) { return (a.s | 0) - (b.s | 0); });
    var meta = (shaky.length ? '<b class="hot">шатких у нас ' + shaky.length + '</b>' : 'у нас прочно') + ' · окно у врага ' + open.length;
    var html = '<section class="fs-sec lo-sec">' + (typeof fsSecHead === 'function' ? fsSecHead('Настроения', meta) : '');
    if (!shaky.length) html += '<div class="fs-empty">Народ на всех наших планетах верен власти. Держите довольство и гарнизоны — и врагу придётся брать площадь долго.</div>';
    else shaky.slice(0, 5).forEach(function(p) { html += plRow(p, true); });
    if (shaky.length > 5) html += '<div class="lo-more">и ещё ' + (shaky.length - 5) + ' — в карточках планет</div>';
    html += '<div class="lo-sub">Окно у врага</div>';
    if (!open.length) html += '<div class="fs-empty">У врага народ спокоен. Агитация из штаба (тайные операции) раскачает его планеты и сплетёт подполье.</div>';
    else open.slice(0, 4).forEach(function(p) { html += plRow(p, false); });
    html += '<div class="lo-more">справа — поддержка хозяина планеты' + (shaky.length ? ' и сдвиг за прошлые сутки' : '') + '</div>';
    return html + '</section>';
  }

  // ── Галактика: дуга у шатких планет ───────────────────────────────
  // Кольцо вокруг диска: синяя доля — за Республику (от верха по часовой), красная — за КНС.
  // Рисуется, только когда хозяину планеты не до спокойствия (поддержка ниже 50).
  var R = 18, C = 2 * Math.PI * R, arcTry = 0;
  function paintArcs() {
    var layer = document.getElementById('galaxy-layer'), m = cache.map;
    if (!layer || !m || !m.planets) return;
    var miss = 0;
    m.planets.forEach(function(p) {
      var w = layer.querySelector('.planet-wrapper[data-planet-id="' + p.id + '"]');
      if (!w) { miss++; return; }
      var el = w.querySelector('.lo-ring'), show = m.enabled && p.s != null && ((p.s | 0) < 50 || p.cell);
      if (!show) { if (el) el.parentNode.removeChild(el); return; }
      if (!el) { el = document.createElement('div'); el.className = 'lo-ring'; w.insertBefore(el, w.firstChild); }
      var rep = Math.max(0, Math.min(1, ((p.v | 0) + 100) / 200)), gap = 1.6, a = Math.max(0, rep * C - gap), b = Math.max(0, (1 - rep) * C - gap);
      var k = stageKey(p.s);
      el.className = 'lo-ring lo-s-' + k;
      el.innerHTML = '<svg viewBox="0 0 40 40" aria-hidden="true">' +
        '<circle class="lo-r-rep" cx="20" cy="20" r="' + R + '" stroke-dasharray="' + a.toFixed(2) + ' ' + C.toFixed(2) + '" stroke-dashoffset="' + (-gap / 2).toFixed(2) + '"/>' +
        '<circle class="lo-r-cis" cx="20" cy="20" r="' + R + '" stroke-dasharray="' + b.toFixed(2) + ' ' + C.toFixed(2) + '" stroke-dashoffset="' + (-(rep * C + gap / 2)).toFixed(2) + '"/>' +
      '</svg>';
      el.title = 'Настроения: народ ' + ST[k].t + ' · ' + signed(p.s);
    });
    // планеты ещё рисуются — попробуем чуть позже
    if (miss && arcTry++ < 8) setTimeout(paintArcs, 1500);
  }

  // ── Окно тайных операций (агитация) ───────────────────────────────
  var LO = {
    stage: stageKey, ST: ST, MEANS: MEANS, scale: scale, signed: signed, dur: dur, pips: pips, FAC: FAC, FAC_GEN: FAC_GEN
  };

  window.LO = LO;
  window.loSettlementHtml = settlementHtml;
  window.loPlanetRows = planetRows;
  window.loFetch = fetchMap;
  window.fsRenderLoyalty = fsRenderLoyalty;

  // В галактике: данные для дуг и карточек — при входе и раз в 10 минут
  document.addEventListener('DOMContentLoaded', function() {
    if (!document.getElementById('galaxy-layer')) return;
    setTimeout(fetchMap, 2600);
    setInterval(function() { if (!document.hidden) fetchMap(); }, 600000);
  });
})();
