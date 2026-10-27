/* Находки в Пустоте: карта галактики.
 *
 * Сервер (sql/void_finds.sql) решает всё сам: раз в 3,5–7 суток, вечером, в узле Пустоты на фронте появляется
 * находка под охраной NPC. Охрану бьют в живом бою на орбите узла; потом — удержание зоны: кто первым наберёт
 * 3 часа (только своя сторона в зоне), тот забирает находку. void_find_state_json — идущие и недавние.
 *
 * Здесь: метка узла на карте (узлов Пустоты на карте нет — метка встаёт в их точку, туда же ставятся фишки
 * и ракеты командиров), плашка под ником, шторка «Находка в Пустоте» с флотами игрока: к находке, к гиперлинии,
 * домой. window.openVoidFind(id) — из ленты. Префикс vf-. ES5.
 */
(function() {
  'use strict';

  var FAC = { republic: 'Республика', cis: 'Конфедерация' };
  var FAC_SHORT = { republic: 'Республика', cis: 'КНС' };
  var RES = { ore: 'руда', gas: 'тибанна', crystals: 'кристаллы', food: 'продовольствие', durasteel: 'дюрасталь', cells: 'топливные ячейки', electronics: 'электроника' };
  var KIND = {
    extract:    { up: 'добыча',     unit: '%' },
    income:     { up: 'доход',      unit: '%' },
    mood:       { up: 'довольство', unit: '' },
    hire_time:  { time: 'найм' },
    build_time: { time: 'стройка' }
  };

  var st = { data: null, skew: 0, open: false, loading: false, focus: null, busy: {}, msg: {} };
  var deep = null;        // узлы Пустоты: id → { name, x, y, near: [id] }
  var nodes = {};         // нарисованные метки: id → элемент
  var nodeSig = '';

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function ms(iso) { var t = new Date(iso).getTime(); return isNaN(t) ? 0 : t; }
  function now() { return Date.now() + st.skew; }
  function fmt(n) { return String(Math.round(Math.abs(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ' '); }
  function plural(n, a, b, c) { var x = Math.abs(n) % 100, y = x % 10; if (x > 10 && x < 20) return c; if (y > 1 && y < 5) return b; if (y === 1) return a; return c; }
  function myFac() { return (st.data && st.data.faction) || window.currentUserFaction || null; }
  function foeOf(f) { return f === 'republic' ? 'cis' : f === 'cis' ? 'republic' : null; }

  // Длительность: «3 ч», «1 ч 12 мин», «45 мин»
  function dur(sec) {
    sec = Math.max(0, Math.round(sec));
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
    if (h > 0) return h + ' ч' + (m ? ' ' + m + ' мин' : '');
    if (m > 0) return m + ' мин';
    return sec > 0 ? 'меньше минуты' : '0 мин';
  }
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
  function errText(e) {
    if (typeof gameErr === 'function') return gameErr(e);
    return (e && e.message) || 'Не вышло';
  }

  // ── Состояние находки ──────────────────────────────────────────────

  function need() { return (st.data && st.data.need) || 10800; }
  function active() {
    var n = now();
    return ((st.data && st.data.active) || []).filter(function(f) { return ms(f.ends) > n; });
  }
  function byId(id) {
    var list = active();
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }
  function bySystem(sys) {
    var list = active();
    for (var i = 0; i < list.length; i++) if (list[i].system_id === sys) return list[i];
    return null;
  }

  // Набранное удержание стороны: база считает раз в минуту — между тактами досчитываем сами (не дальше 90 с)
  function held(f, fac) {
    var v = (f.hold && f.hold[fac]) || 0;
    if (f.down && f.holder === fac && f.tick) v += Math.min(90, Math.max(0, (now() - ms(f.tick)) / 1000));
    return Math.min(need(), v);
  }
  function aliveGuards(f) { return (f.guards || []).filter(function(g) { return (g.hp || 0) > 0; }).length; }

  // Что сейчас с находкой — для плашки, метки и карточки
  function phase(f) {
    var me = myFac(), foe = foeOf(me);
    if (!f.down) return { k: 'guard', tone: 'g', text: 'охрана · ' + aliveGuards(f) + ' из ' + (f.guards || []).length + ' на посту' };
    if (f.holder === me) return { k: 'mine', tone: 'me', text: 'наши держат · до победы ' + dur(need() - held(f, me)) };
    if (f.holder === foe) return { k: 'foe', tone: 'foe', text: (FAC_SHORT[foe] || 'враг') + ' держит · до потери ' + dur(need() - held(f, foe)) };
    if (f.holder === 'contested') return { k: 'cont', tone: 'cont', text: 'спорная зона · удержание стоит' };
    return { k: 'open', tone: 'open', text: 'охрана разбита · зона пуста' };
  }

  // Кольцо прогресса: наше — по часовой от верха, чужое — против
  function ringStyle(f) {
    var me = myFac(), a = 0, b = 0;
    if (f.down) { a = held(f, me) / need() * 100; b = held(f, foeOf(me)) / need() * 100; }
    return '--vf-a:' + a.toFixed(1) + '%;--vf-b:' + (100 - b).toFixed(1) + '%';
  }

  // ── Загрузка ───────────────────────────────────────────────────────

  function load() {
    if (st.loading || document.hidden || !window.supabase || !supabase.rpc) return;
    st.loading = true;
    Promise.resolve(supabase.rpc('void_find_state_json')).then(function(r) {
      st.loading = false;
      if (!r || r.error || !r.data) return;
      st.data = r.data;
      if (r.data.now) st.skew = ms(r.data.now) - Date.now();
      paint();
    }, function() { st.loading = false; });
  }

  // Узлы Пустоты: карта их не рисует (только планеты), а флоту, летящему к находке, нужна точка на карте
  function loadDeep() {
    if (deep || !window.supabase || !supabase.from) return;
    Promise.all([
      supabase.from('systems').select('id, name, world_x, world_y').eq('is_deep_space', true),
      supabase.from('hyperlanes').select('system_a, system_b')
    ]).then(function(r) {
      if (r[0].error || !r[0].data) return;
      var map = {};
      r[0].data.forEach(function(s) {
        if (s.world_x === null || s.world_y === null) return;
        map[s.id] = { name: s.name, x: +s.world_x, y: +s.world_y, near: [] };
      });
      ((r[1] && !r[1].error && r[1].data) || []).forEach(function(l) {
        if (map[l.system_a] && !map[l.system_b]) map[l.system_a].near.push(l.system_b);
        if (map[l.system_b] && !map[l.system_a]) map[l.system_b].near.push(l.system_a);
      });
      deep = map;
      paintNodes(true);
    }, function() {});
  }

  function paint() {
    paintNodes(false);
    paintPill();
    if (st.open) renderSheet();
  }

  // ── Метка узла на карте ────────────────────────────────────────────
  // Метка — обёртка как у планеты (.planet-wrapper с data-planet-id): к ней ведёт focusGalaxySystem,
  // в неё planets.js ставит фишки командиров (planetElements), к её точке летят ракеты (systemPositions).

  function mapReady() {
    return !!(document.getElementById('galaxy-layer') && window.flightLayer && window.systemPositions && window.planetElements);
  }

  // Узлы, где есть что показать: открытая находка или наш командир (стоит, летит туда или оттуда)
  function wanted() {
    var out = {};
    active().forEach(function(f) { if (deep && deep[f.system_id]) out[f.system_id] = 'find'; });
    (window.lastCommanders || []).forEach(function(c) {
      [c.current_system, c.moving_to, c.moving_from].forEach(function(id) {
        if (id && deep && deep[id] && !out[id]) out[id] = 'idle';
      });
    });
    return out;
  }

  function paintNodes(force) {
    if (!deep || !mapReady()) return;
    var layer = document.getElementById('galaxy-layer');
    var want = wanted(), changed = false;

    // точка каждого узла — для ракет и пунктира маршрута (дёшево и безвредно: гиперлинии уже нарисованы)
    Object.keys(deep).forEach(function(id) {
      if (!systemPositions[id]) { systemPositions[id] = { x: deep[id].x, y: deep[id].y }; changed = true; }
    });

    Object.keys(nodes).forEach(function(id) {
      if (want[id]) return;
      var el = nodes[id];
      if (el.parentNode) el.parentNode.removeChild(el);
      delete nodes[id];
      if (planetElements[id] && planetElements[id].vf) delete planetElements[id];
      changed = true;
    });

    Object.keys(want).forEach(function(id) {
      var el = nodes[id], d = deep[id];
      if (!el) {
        el = document.createElement('div');
        el.setAttribute('data-planet-id', id);
        el.style.left = d.x + 'px';
        el.style.top = d.y + 'px';
        el.innerHTML = '<div class="vf-node-mk"><span class="vf-node-glow"></span><span class="vf-node-ring"></span>' +
          '<span class="vf-node-core"></span></div><div class="planet-label vf-node-label"></div>';
        var box = document.createElement('div');
        box.className = 'commander-marker-box vf-node-cmd';
        el.appendChild(box);
        el.addEventListener('click', function() { openSheet(id); });
        layer.appendChild(el);
        nodes[id] = el;
        planetElements[id] = { labelEl: el.querySelector('.vf-node-label'), wrapperEl: el, markerBoxEl: box, faction: 'neutral', vf: true };
        changed = true;
      }
      paintNode(id, el, want[id] === 'find' ? bySystem(id) : null);
    });

    var sig = Object.keys(want).sort().join(',');
    if (sig !== nodeSig) { nodeSig = sig; changed = true; }
    if ((changed || force) && window.lastCommanders) {
      try {
        if (typeof renderCommanderMarkers === 'function') renderCommanderMarkers(lastCommanders);
        if (typeof renderFlights === 'function') renderFlights(lastCommanders);
      } catch (e) { console.error('Находка:', e); if (window.errReport) errReport(e, 'void-finds.nodes'); }
    }
  }

  function paintNode(id, el, f) {
    var core = el.querySelector('.vf-node-core'), label = el.querySelector('.vf-node-label'), ring = el.querySelector('.vf-node-ring');
    if (!f) {
      el.className = 'planet-wrapper vf-node idle';
      core.textContent = '◇';
      label.textContent = 'Пустота';
      ring.removeAttribute('style');
      el.title = deep[id].name;
      return;
    }
    var ph = phase(f);
    el.className = 'planet-wrapper vf-node t-' + ph.tone + ' a-' + (f.art || 'cache');
    core.textContent = f.glyph || '◈';
    label.textContent = '◈ ' + f.title;
    ring.setAttribute('style', ringStyle(f));
    el.title = 'Находка в Пустоте: ' + f.title + ' — ' + ph.text;
  }

  // ── Плашка ─────────────────────────────────────────────────────────

  function pillEl() {
    var el = document.getElementById('vf-pill');
    if (el) return el;
    el = document.createElement('button');
    el.type = 'button';
    el.id = 'vf-pill';
    el.style.display = 'none';
    el.addEventListener('click', function() { openSheet(null); });
    document.body.appendChild(el);
    return el;
  }

  // Важнее та, где решается сейчас: враг держит → наши держат → спорная → открыта → под охраной
  var RANK = { foe: 0, mine: 1, cont: 2, open: 3, guard: 4 };
  function ordered() {
    return active().slice().sort(function(a, b) {
      return RANK[phase(a).k] - RANK[phase(b).k] || ms(a.ends) - ms(b.ends);
    });
  }

  function paintPill() {
    var el = pillEl(), list = ordered();
    if (!list.length) { el.style.display = 'none'; return; }
    var f = list[0], ph = phase(f);
    el.className = 'vf-pill t-' + ph.tone;
    el.innerHTML = '<span class="vf-pill-ico" style="' + ringStyle(f) + '"><i>' + esc(f.glyph) + '</i></span>' +
      '<span class="vf-pill-body"><b>Находка · ' + esc(f.title) + '</b><i>' + esc(ph.text) + '</i></span>' +
      (list.length > 1 ? '<span class="vf-pill-more">+' + (list.length - 1) + '</span>' : '');
    el.setAttribute('aria-label', 'Находка в Пустоте: ' + f.title);
    el.style.display = 'flex';
    placePill();
  }

  // Под плашкой событий галактики, если она видна; иначе — на её месте
  function placePill() {
    var el = document.getElementById('vf-pill');
    if (!el || el.style.display === 'none') return;
    var ge = document.getElementById('ge-pill'), top = 62;
    if (ge && ge.style.display !== 'none' && ge.offsetHeight > 0) top = Math.round(ge.getBoundingClientRect().bottom + 6);
    else if (questUp()) top = 104;
    if (el.style.top !== top + 'px') el.style.top = top + 'px';
  }
  function questUp() {
    var q = document.getElementById('quest-tracker');
    return !!(q && getComputedStyle(q).display !== 'none' && q.offsetWidth > 0 && window.innerWidth < 560);
  }

  // ── Шторка ─────────────────────────────────────────────────────────

  function sheetEl() {
    var el = document.getElementById('vf-sheet');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'vf-sheet';
    el.style.display = 'none';
    el.innerHTML =
      '<div id="vf-box">' +
        '<div id="vf-head"><div><div id="vf-title">Находка в Пустоте</div><div id="vf-sub"></div></div>' +
          '<button type="button" id="vf-close" aria-label="Закрыть">✕</button></div>' +
        '<div id="vf-body"></div>' +
      '</div>';
    document.body.appendChild(el);
    el.addEventListener('click', function(e) { if (e.target === el) closeSheet(); });
    el.querySelector('#vf-close').addEventListener('click', closeSheet);
    el.querySelector('#vf-body').addEventListener('click', onBody);
    return el;
  }

  function openSheet(focus) {
    var el = sheetEl();
    st.open = true;
    st.focus = focus || null;
    el.style.display = 'flex';
    renderSheet();
    load();
    if (focus) setTimeout(function() {
      var c = document.querySelector('#vf-body [data-vf-sys="' + focus + '"], #vf-body [data-vf-card="' + focus + '"]');
      if (c && c.scrollIntoView) c.scrollIntoView({ block: 'start' });
    }, 0);
  }

  function closeSheet() {
    st.open = false;
    var el = document.getElementById('vf-sheet');
    if (el) el.style.display = 'none';
  }

  function renderSheet() {
    var body = document.getElementById('vf-body'), sub = document.getElementById('vf-sub');
    if (!body) return;
    var list = ordered(), recent = (st.data && st.data.recent) || [];
    if (sub) sub.textContent = list.length
      ? (list.length > 1 ? list.length + ' находки · ' : '') + 'удержание — ' + dur(need()) + ' · кто первым, тот и забрал'
      : 'Находки приходят 1–2 раза в неделю, вечером';
    if (!st.data) { body.innerHTML = '<div class="vf-empty">Загрузка…</div>'; return; }
    var scroll = body.scrollTop, h = '';
    if (!list.length) {
      h += '<div class="vf-empty"><span class="vf-empty-ico">◇</span><b>Пустота молчит</b>' +
        'Раз-два в неделю, вечером, в Пустоте между фронтовыми планетами находят что-то ценное: обломки дредноута, ' +
        'голокрон, тайник. Её стерегут пираты или наёмники. Разбейте охрану, удержите зону ' + dur(need()) + ' — и находка ваша.</div>';
    }
    list.forEach(function(f) { h += card(f); });
    h += stray();
    if (recent.length) {
      h += '<div class="vf-block">Недавно</div>';
      recent.forEach(function(r) { h += past(r); });
    }
    h += '<div class="vf-rules"><b>Как забрать находку</b>' +
      '<p><em>1</em>Лети в узел Пустоты — «Отправить флот». Прилетевший флот сам идёт к находке.</p>' +
      '<p><em>2</em>Разбей охрану на орбите узла. Пока она жива, удержание не идёт ни у кого.</p>' +
      '<p><em>3</em>Держи зону ' + dur(need()) + ': в ней только корабли твоей стороны. Обе стороны — спорная зона, счёт стоит. ' +
        'Время не сгорает: ушёл и вернулся — продолжаешь.</p>' +
      '<p><em>4</em>Награду делят игроки победившей стороны, стоявшие в зоне, — по времени в ней. Груз — в трюмы их флота в узле.</p></div>';
    body.innerHTML = h;
    body.scrollTop = scroll;
  }

  function card(f) {
    var me = myFac(), foe = foeOf(me), ph = phase(f);
    var where = (f.near || []).map(function(p) { return p.name; }).join(' — ');
    var h = '<div class="vf-card t-' + ph.tone + ' a-' + esc(f.art) + '" data-vf-card="' + esc(f.system_id) + '">' +
      '<div class="vf-card-head">' +
        '<span class="vf-art" style="' + ringStyle(f) + '"><i>' + esc(f.glyph) + '</i></span>' +
        '<span class="vf-card-t"><b>' + esc(f.title) + '</b><i>Пустота' + (where ? ' · ' + esc(where) : '') + '</i></span>' +
        '<span class="vf-left" data-vf-left="' + ms(f.ends) + '">ещё ' + left(f.ends) + '</span>' +
      '</div>' +
      '<div class="vf-text">' + esc(f.text) + '</div>' +
      steps(f) +
      (f.down ? holdBlock(f, me, foe) : guardBlock(f));

    h += '<div class="vf-label">Награда <em>делят по времени в зоне</em></div>' + reward(f.reward);
    h += fleets(f);

    var mine = f.mine || [];
    if (mine.length) {
      h += '<div class="vf-label">Держали из наших</div><div class="vf-holders">' + mine.map(function(m) {
        return '<span class="vf-holder' + (m.me ? ' me' : '') + '"><b>' + esc(m.nick) + '</b><i>' + dur(m.seconds) + '</i></span>';
      }).join('') + '</div>';
    }

    h += '<div class="vf-acts">' +
      '<button type="button" class="vf-btn main" data-vf-act="send" data-v="' + esc(f.system_id) + '">Отправить флот</button>' +
      '<button type="button" class="vf-btn" data-vf-act="orbit" data-v="' + esc(f.system_id) + '">На орбиту</button>' +
      '<button type="button" class="vf-btn icon" data-vf-act="map" data-v="' + esc(f.system_id) + '" aria-label="Показать на карте" title="Показать на карте">⌖</button>' +
    '</div>';
    if (st.msg[f.system_id]) h += '<div class="vf-msg ' + (st.msg[f.system_id].bad ? 'bad' : '') + '">' + esc(st.msg[f.system_id].text) + '</div>';
    return h + '</div>';
  }

  // Охрана → удержание → итог
  function steps(f) {
    var s = f.down ? 2 : 1;
    return '<div class="vf-steps">' + ['Охрана', 'Удержание', 'Находка'].map(function(t, i) {
      var n = i + 1;
      return '<span class="vf-step' + (n < s ? ' done' : n === s ? ' on' : '') + '"><em>' + (n < s ? '✓' : n) + '</em>' + t + '</span>';
    }).join('<i class="vf-step-sep"></i>') + '</div>';
  }

  function guardBlock(f) {
    var g = f.guards || [];
    return '<div class="vf-stage">' +
      '<div class="vf-stage-t"><b>☠ ' + esc(f.guard_name) + '</b><i>' + aliveGuards(f) + ' из ' + g.length + ' на посту</i></div>' +
      g.map(function(x) {
        var hp = Math.max(0, Math.min(1, x.hp || 0)), dead = hp <= 0;
        return '<div class="vf-guard' + (dead ? ' dead' : '') + (x.lead ? ' lead' : '') + '">' +
          '<span class="vf-guard-t"><b>' + esc(x.name) + '</b><i>' + esc(x.type_name || x.cls || '') + (x.lead ? ' · вожак' : '') + '</i></span>' +
          (dead ? '<span class="vf-guard-dead">разбит</span>'
            : '<span class="vf-guard-hp"><span class="vf-track"><i style="width:' + (hp * 100).toFixed(0) + '%"></i></span><em>' + Math.round(hp * 100) + '%</em></span>') +
        '</div>';
      }).join('') +
      '<div class="vf-hint">Пока охрана жива, удержание не идёт. Она крепкая: в одиночку не взять — собирайте 3–4 средних корабля. ' +
        'Пираты просыпаются, когда подходишь ближе 7 км, и далеко от находки не уходят.</div>' +
    '</div>';
  }

  function holdBlock(f, me, foe) {
    var n = need(), a = held(f, me), b = held(f, foe);
    var z = f.zone || {}, here = f.here || {}, zm = z[me] || 0, zf = z[foe] || 0;
    var line;
    if (f.holder === me) line = '<b class="me">Наши держат зону</b> — до победы ' + dur(n - a) + '. Не пускайте врага в зону.';
    else if (f.holder === foe) line = '<b class="foe">' + esc(FAC[foe] || 'Враг') + ' держит зону</b> — через ' + dur(n - b) + ' находка уйдёт к ней. Встань в зону — счёт остановится.';
    else if (f.holder === 'contested') line = '<b class="cont">Спорная зона</b> — в ней обе стороны, удержание стоит. Выбейте врага.';
    else line = '<b>Зона пуста</b> — встань в неё, и счёт пойдёт.';
    return '<div class="vf-stage">' +
      bar('Наши', a, n, 'me', f.holder === me) +
      bar(FAC_SHORT[foe] || 'Враг', b, n, 'foe', f.holder === foe) +
      '<div class="vf-hold-line">' + line + '</div>' +
      // в зоне — обе стороны (за неё и спор); в узле — только наши: чужой флот в узле видно разведкой, не отсюда
      '<div class="vf-counts"><span>в зоне <b class="me">' + zm + '</b> : <b class="foe">' + zf + '</b></span>' +
        '<em>кораблей, наши : враг</em><span>наших в узле <b class="me">' + (here[me] || 0) + '</b></span></div>' +
    '</div>';
  }

  function bar(name, v, n, cls, live) {
    return '<div class="vf-bar ' + cls + (live ? ' live' : '') + '"><span class="vf-bar-n">' + esc(name) + '</span>' +
      '<span class="vf-track"><i style="width:' + Math.min(100, v / n * 100).toFixed(1) + '%"></i></span>' +
      '<span class="vf-bar-v">' + dur(v) + '<em> / ' + dur(n) + '</em></span></div>';
  }

  function effect(e) {
    var k = KIND[e.kind] || { up: e.kind, unit: '' }, v = e.value | 0;
    var t = k.time ? k.time + (v < 0 ? ' быстрее' : ' дольше') + ' на ' + Math.abs(v) + '%'
      : k.up + ' ' + (v > 0 ? '+' : '−') + Math.abs(v) + k.unit;
    return t + ' · ' + (e.hours | 0) + ' ч';
  }

  function reward(r) {
    r = r || {};
    var h = '<div class="vf-fx">';
    if (r.credits) h += '<i class="cr">' + fmt(r.credits) + ' кр.</i>';
    Object.keys(r.cargo || {}).forEach(function(k) { h += '<i class="cargo">' + esc(RES[k] || k) + ' ' + fmt(r.cargo[k]) + '</i>'; });
    (r.effects || []).forEach(function(e) { h += '<i class="up">' + esc(effect(e)) + '</i>'; });
    h += '</div>';
    var notes = [];
    if (r.cargo && Object.keys(r.cargo).length) notes.push('груз — в трюмы флота в узле, что не влезет — останется в обломках');
    if (r.effects && r.effects.length) notes.push('эффект — на всю сторону-победителя');
    if (notes.length) h += '<div class="vf-hint">' + esc(notes.join('; ').replace(/^./, function(c) { return c.toUpperCase(); })) + '.</div>';
    return h;
  }

  // Мои флоты у находки и в пути к ней
  function fleets(f) {
    var list = f.fleets || [];
    var h = '<div class="vf-label">Твои флоты</div>';
    if (!list.length) return h + '<div class="vf-none">Здесь твоих флотов нет. Отправь флот — путь откроется к узлу, пока находка не закрыта.</div>';
    return h + list.map(function(c) { return fleetRow(c, f.system_id, f); }).join('');
  }

  function fleetRow(c, sys, f, where) {
    var busy = st.busy[c.id], ships = c.ships | 0;
    var sub, chip, acts = '';
    if (where) {
      sub = where;
      chip = '<span class="vf-chip">в узле</span>';
      acts = '<button type="button" class="vf-btn sm main" data-vf-act="band" data-v="' + esc(c.id) + '"' + (busy ? ' disabled' : '') + '>К гиперлинии</button>' +
        '<button type="button" class="vf-btn sm" data-vf-act="home" data-v="' + esc(sys) + '">Домой</button>';
    } else if (c.state === 'flying') {
      sub = ships + ' ' + plural(ships, 'корабль', 'корабля', 'кораблей') + ' · прибудет ' + (c.arrives && ms(c.arrives) > now() ? 'через ' + left(c.arrives) : 'вот-вот');
      chip = '<span class="vf-chip fly">в пути</span>';
    } else {
      var inz = c.in_zone | 0;
      sub = ships + ' ' + plural(ships, 'корабль', 'корабля', 'кораблей') + ' · в зоне ' + inz;
      chip = c.moving ? '<span class="vf-chip go">идёт</span>'
        : inz && inz >= ships ? '<span class="vf-chip ok">в зоне</span>'
        : inz ? '<span class="vf-chip warn">частью в зоне</span>'
        : '<span class="vf-chip">вне зоны</span>';
      acts += '<button type="button" class="vf-btn sm main" data-vf-act="zone" data-v="' + esc(c.id) + '"' + (busy ? ' disabled' : '') + '>К находке</button>';
      acts += '<button type="button" class="vf-btn sm" data-vf-act="band" data-v="' + esc(c.id) + '"' + (busy ? ' disabled' : '') + '>К гиперлинии</button>';
      acts += '<button type="button" class="vf-btn sm" data-vf-act="home" data-v="' + esc(sys) + '">Домой</button>';
    }
    return '<div class="vf-fleet">' +
      '<div class="vf-fleet-row"><span class="vf-pawn">♟</span>' +
        '<span class="vf-fleet-t"><b>' + esc(c.name || 'Командир') + '</b><i>' + esc(sub) + '</i></span>' + chip + '</div>' +
      (acts ? '<div class="vf-fleet-acts">' + acts + '</div>' : '') +
    '</div>';
  }

  // Мои флоты в Пустоте, где находки уже нет: вывести к гиперлинии и домой
  function stray() {
    if (!deep) return '';
    var uid = window.currentUserId, rows = [];
    (window.lastCommanders || []).forEach(function(c) {
      if (c.user_id !== uid || c.moving_to || !c.current_system || !deep[c.current_system] || bySystem(c.current_system)) return;
      rows.push(c);
    });
    if (!rows.length) return '';
    var h = '<div class="vf-block">Флоты в Пустоте</div><div class="vf-card t-idle" data-vf-sys="' + esc(rows[0].current_system) + '">' +
      '<div class="vf-hint top">Находки здесь уже нет. Выведи флот к гиперлинии — и домой.</div>';
    rows.forEach(function(c) {
      h += fleetRow({ id: c.id, name: c.name }, c.current_system, null, deep[c.current_system].name);
    });
    if (st.msg.stray) h += '<div class="vf-msg ' + (st.msg.stray.bad ? 'bad' : '') + '">' + esc(st.msg.stray.text) + '</div>';
    return h + '</div>';
  }

  function past(r) {
    var me = myFac(), won = r.status === 'won', ours = won && r.winner === me;
    var t = won ? (ours ? 'наши забрали' : (FAC[r.winner] || 'враг') + ' забрала') : 'ушла в Пустоту';
    var mine = r.mine ? '<em class="vf-past-me">твоя доля: ' + fmt(r.mine.credits || 0) + ' кр.' +
      (r.mine.cargo && Object.keys(r.mine.cargo).length ? ' и груз' : '') + '</em>' : '';
    return '<div class="vf-past ' + (won ? (ours ? 'good' : 'bad') : 'lost') + '"><span class="vf-past-ico">' + esc(r.glyph) + '</span>' +
      '<span class="vf-past-t"><b>' + esc(r.title) + '</b><i>' + esc(t) + ' · ' + ago(r.ended) + '</i>' + mine + '</span></div>';
  }

  // ── Действия ───────────────────────────────────────────────────────

  function note(key, text, bad) {
    st.msg[key] = { text: text, bad: !!bad };
    renderSheet();
    setTimeout(function() { if (st.msg[key] && st.msg[key].text === text) { delete st.msg[key]; if (st.open) renderSheet(); } }, 5000);
  }

  // Своя планета рядом с узлом — туда «Домой»; своей нет — любая соседняя
  function homeOf(sys) {
    var f = bySystem(sys), me = myFac(), list = [];
    if (f) list = (f.near || []).map(function(p) { return { id: p.id, name: p.name, faction: p.faction }; });
    else if (deep && deep[sys]) list = deep[sys].near.map(function(id) {
      var pe = window.planetElements && planetElements[id];
      return { id: id, name: pe && pe.labelEl ? pe.labelEl.textContent : id, faction: pe ? pe.faction : null };
    });
    var own = list.filter(function(p) { return p.faction === me; });
    return own[0] || list[0] || null;
  }

  function onBody(e) {
    var b = e.target.closest('[data-vf-act]');
    if (!b || b.disabled) return;
    var act = b.getAttribute('data-vf-act'), v = b.getAttribute('data-v');
    if (act === 'send') {
      var f = bySystem(v);
      closeSheet();
      if (typeof openMovePanel === 'function') openMovePanel(v, (f && f.system_name) || 'Пустота');
    } else if (act === 'orbit') {
      window.location.href = 'space-battle.html?system=' + encodeURIComponent(v);
    } else if (act === 'map') {
      closeSheet();
      if (typeof focusGalaxySystem === 'function') focusGalaxySystem(v);
    } else if (act === 'home') {
      var home = homeOf(v);
      if (!home) return;
      closeSheet();
      if (typeof openMovePanel === 'function') openMovePanel(home.id, home.name);
    } else if (act === 'zone' || act === 'band') {
      var key = cardKey(b);
      st.busy[v] = true;
      renderSheet();
      Promise.resolve(supabase.rpc('void_find_fleet', { p_commander: v, p_to: act })).then(function(r) {
        delete st.busy[v];
        if (r.error) { note(key, errText(r.error), true); return; }
        var to = act === 'zone' ? 'к находке' : 'к гиперлинии';
        note(key, r.data === 'ready' ? 'Флот уже ' + (act === 'zone' ? 'у находки' : 'в полосе прыжка') : 'Флот идёт ' + to + (act === 'band' ? ' — потом «Домой»' : ''));
        setTimeout(load, 1500);
      }, function(err) { delete st.busy[v]; note(key, errText(err), true); });
    }
  }
  function cardKey(b) {
    var c = b.closest('[data-vf-card]');
    return c ? c.getAttribute('data-vf-card') : 'stray';
  }

  // Отсчёты и кольца без перезапроса
  function tick() {
    var n = now(), due = false;
    var els = document.querySelectorAll('[data-vf-left]');
    for (var i = 0; i < els.length; i++) {
      var end = parseInt(els[i].getAttribute('data-vf-left'), 10);
      if (end <= n) { due = true; continue; }
      els[i].textContent = 'ещё ' + left(new Date(end).toISOString());
    }
    if (due) setTimeout(load, 3000);
    // командиры сменились (прилёт, вылет) — метки узлов догоняют
    var w = Object.keys(wanted()).sort().join(',');
    if (w !== nodeSig) paintNodes(false);
    else Object.keys(nodes).forEach(function(id) { var f = bySystem(id); if (f) paintNode(id, nodes[id], f); });
    paintPill();
    if (st.open && !document.querySelector('#vf-body .vf-btn:active')) renderSheet();
  }

  window.openVoidFind = function(id) {
    var f = id ? (byId(id) || null) : null;
    openSheet(f ? f.system_id : null);
  };
  window.vfReload = load;

  document.addEventListener('DOMContentLoaded', function() {
    if (!document.getElementById('galaxy-layer')) return;
    setTimeout(load, 2500);
    // точки узлов — когда карта уже нарисована (planets.js ставит systemPositions после загрузки систем)
    var tries = 0;
    var wait = setInterval(function() {
      tries++;
      if (mapReady() && Object.keys(planetElements).length) { clearInterval(wait); loadDeep(); }
      else if (tries > 60) clearInterval(wait);
    }, 1000);
    setInterval(function() { if (active().length || st.open) load(); }, 60000);
    setInterval(function() { if (!active().length && !st.open) load(); }, 300000);
    setInterval(tick, 15000);
    setInterval(placePill, 2000);
    window.addEventListener('resize', placePill);
    document.addEventListener('visibilitychange', function() { if (!document.hidden) load(); });
  });
})();
