/* Панель разработчика (кнопка DEV в пилюле кредитов).
 *
 * Этот файл загружается в браузер ТОЛЬКО админам: credits-bar.js спрашивает базу
 * dev_is_admin() и лишь при «да» подключает его. Но защита не в этом: каждое действие —
 * функция базы dev_*, которая сама проверяет, что вошедший игрок есть в dev_admins
 * (sql/dev_panel.sql). Без прав любая кнопка вернёт «Нет доступа», даже если код
 * панели кто-то скопирует себе.
 *
 * Ники игроков приходят из базы и вставляются только через textContent / esc().
 * ES5.
 */
(function() {
  'use strict';
  if (window.DevPanel) return;

  var CAT = null, el = null, tab = 'res', busy = false;
  var S = { user: null, system: null };
  var SYS_FROM_URL = (/[?&]system=([a-z0-9_]+)/.exec(location.search) || [])[1] || null;

  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
  function fmt(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' '); }
  function $(s) { return el.querySelector(s); }
  function player(id) { return (CAT.players || []).filter(function(p) { return p.id === id; })[0] || null; }
  function sys(id) { return (CAT.systems || []).filter(function(s) { return s.id === id; })[0] || null; }
  var FAC = { republic: 'Республика', cis: 'КНС' };

  function rpc(fn, args) {
    if (busy) return Promise.reject(new Error('Подожди, прошлое действие ещё идёт'));
    busy = true; el.classList.add('busy');
    return supabase.rpc(fn, args || {}).then(function(r) {
      busy = false; el.classList.remove('busy');
      if (r.error) throw new Error(r.error.message || 'Ошибка базы');
      return r.data;
    }, function(e) { busy = false; el.classList.remove('busy'); throw e; });
  }
  function say(text, bad) {
    var s = $('.dv-status'); if (!s) return;
    s.textContent = text; s.className = 'dv-status show' + (bad ? ' bad' : '');
    clearTimeout(say.t); say.t = setTimeout(function() { s.className = 'dv-status'; }, 4500);
  }
  function fail(e) { say(e && e.message ? e.message : String(e), true); }
  function credits() { if (typeof refreshCreditsSoon === 'function') refreshCreditsSoon(); }

  // ---- окно
  function build() {
    el = document.createElement('div');
    el.id = 'dev-panel';
    el.innerHTML =
      '<div class="dv-box" role="dialog" aria-label="Панель разработчика">' +
        '<div class="dv-top"><div><div class="dv-kicker">Панель разработчика</div><div class="dv-title">DEV</div></div>' +
        '<button type="button" class="dv-x" aria-label="Закрыть">✕</button></div>' +
        '<div class="dv-pick">' +
          '<label><span>Игрок</span><select class="dv-user"></select></label>' +
          '<label><span>Планета</span><select class="dv-sys"></select></label>' +
        '</div>' +
        '<div class="dv-tabs">' +
          '<button type="button" data-tab="res">Ресурсы</button><button type="button" data-tab="army">Войска</button>' +
          '<button type="button" data-tab="misc">Прочее</button><button type="button" data-tab="log">Журнал</button>' +
        '</div>' +
        '<div class="dv-body"></div>' +
        '<div class="dv-status"></div>' +
      '</div>';
    document.body.appendChild(el);
    el.addEventListener('click', function(e) { if (e.target === el) close(); });
    $('.dv-x').addEventListener('click', close);
    $('.dv-tabs').addEventListener('click', function(e) { var b = e.target.closest('[data-tab]'); if (b) { tab = b.getAttribute('data-tab'); render(); } });
    $('.dv-user').addEventListener('change', function() {
      S.user = this.value;
      var p = player(S.user); if (p && p.planet && !SYS_FROM_URL) S.system = p.planet;
      fillPick(); render();
    });
    $('.dv-sys').addEventListener('change', function() { S.system = this.value; render(); });
    $('.dv-body').addEventListener('click', onBody);
    document.addEventListener('keydown', function(e) { if (el.classList.contains('open') && (e.key === 'Escape' || e.keyCode === 27)) close(); });
  }
  function fillPick() {
    $('.dv-user').innerHTML = CAT.players.map(function(p) {
      return '<option value="' + esc(p.id) + '"' + (p.id === S.user ? ' selected' : '') + '>' + esc(p.nick) + (p.id === CAT.me ? ' (я)' : '') + ' · ' + esc(FAC[p.faction] || 'без фракции') + '</option>';
    }).join('');
    $('.dv-sys').innerHTML = CAT.systems.map(function(s) {
      return '<option value="' + esc(s.id) + '"' + (s.id === S.system ? ' selected' : '') + '>' + esc(s.name) + ' · ' + esc(FAC[s.faction] || 'ничья') + '</option>';
    }).join('');
  }

  // ---- вкладки
  function chips(name, list) { return '<div class="dv-chips">' + list.map(function(v) { return '<button type="button" class="dv-chip" data-set="' + name + '" data-v="' + v + '">' + (v > 0 ? '+' : '') + fmt(v) + '</button>'; }).join('') + '</div>'; }
  function render() {
    [].forEach.call(el.querySelectorAll('.dv-tabs button'), function(b) { b.classList.toggle('on', b.getAttribute('data-tab') === tab); });
    var p = player(S.user) || {}, s = sys(S.system) || {}, h = '';
    if (tab === 'res') {
      h += '<section><h4>Кредиты игроку <em>' + esc(p.nick || '') + ' · сейчас ' + fmt(p.credits || 0) + '</em></h4>' +
        chips('cr', [1000, 10000, 100000]) +
        '<div class="dv-row"><input class="dv-in" id="dv-cr" type="number" inputmode="numeric" value="10000" step="1000">' +
        '<button type="button" class="dv-go" data-act="credits">Начислить</button><button type="button" class="dv-go bad" data-act="credits-">Списать</button></div></section>';
      h += '<section><h4>Сырьё на склад <em>' + esc(s.name || '') + '</em></h4>' +
        '<div class="dv-row"><select class="dv-in" id="dv-res"><option value="all">Всё сырьё</option>' + CAT.resources.map(function(r) { return '<option value="' + esc(r.id) + '">' + esc(r.name) + '</option>'; }).join('') + '</select></div>' +
        chips('st', [100, 1000, 10000]) +
        '<div class="dv-row"><input class="dv-in" id="dv-st" type="number" inputmode="numeric" value="1000" step="100">' +
        '<button type="button" class="dv-go" data-act="stock">Добавить</button><button type="button" class="dv-go bad" data-act="stock-">Убрать</button></div></section>';
    } else if (tab === 'army') {
      var units = CAT.units.filter(function(u) { return u.faction === p.faction; }), ships = CAT.ships.filter(function(t) { return t.faction === p.faction; });
      if (!p.faction) h += '<p class="dv-note">У игрока нет фракции — войска выдать некому.</p>';
      else {
        h += '<section><h4>Бойцы и техника <em>' + esc(p.nick) + ' → ' + esc(s.name || '') + '</em></h4>' +
          '<div class="dv-row"><select class="dv-in" id="dv-unit">' + units.map(function(u) { return '<option value="' + esc(u.id) + '">' + (u.vehicle ? '⛟ ' : '') + esc(u.name) + '</option>'; }).join('') + '</select></div>' +
          '<div class="dv-row"><input class="dv-in" id="dv-uq" type="number" inputmode="numeric" value="5" min="1" max="50"><button type="button" class="dv-go" data-act="units">Высадить</button></div>' +
          '<p class="dv-note">Встают в зоне высадки планеты. До 50 за раз.</p></section>';
        h += '<section><h4>Корабли <em>' + esc(p.nick) + ' → орбита ' + esc(s.name || '') + '</em></h4>' +
          '<div class="dv-row"><select class="dv-in" id="dv-ship">' + ships.map(function(t) { return '<option value="' + esc(t.id) + '">' + esc(t.name) + '</option>'; }).join('') + '</select></div>' +
          '<div class="dv-row"><input class="dv-in" id="dv-sq" type="number" inputmode="numeric" value="1" min="1" max="5"><button type="button" class="dv-go" data-act="ships"' + (s.station ? '' : ' disabled') + '>Пригнать</button></div>' +
          '<p class="dv-note">' + (s.station ? 'Встают у места станции, ангар полон истребителей. До 5 за раз.' : 'У этой системы нет орбиты со станцией — корабли не выдаются.') + '</p></section>';
      }
    } else if (tab === 'misc') {
      h += '<section><h4>Планета <em>' + esc(s.name || '') + '</em></h4>' +
        '<div class="dv-row"><button type="button" class="dv-go wide" data-act="finish">Достроить и выдать всё, что в очередях</button></div>' +
        '<p class="dv-note">Здания, станция, укрепления, наём, верфь, ремонт, исследования, рост поселения.</p>' +
        '<div class="dv-lbl">Уровень поселения</div><div class="dv-chips">' + [1, 2, 3, 4].map(function(n) { return '<button type="button" class="dv-chip" data-act="level" data-v="' + n + '">' + n + '</button>'; }).join('') + '</div></section>';
      h += '<section><h4>Игрок <em>' + esc(p.nick || '') + '</em></h4>' +
        '<div class="dv-row"><button type="button" class="dv-go wide" data-act="research">Открыть все исследования фракции</button></div>' +
        '<div class="dv-row"><button type="button" class="dv-go wide" data-act="tutorial">Засчитать текущий шаг обучения</button></div>' +
        '<p class="dv-note">Шаг обучения засчитывается, награду игрок забирает сам — так выдаются корабль и бойцы шага.</p></section>';
    } else {
      h += '<section><h4>Последние действия</h4><div class="dv-log">Загрузка…</div></section>';
      rpc('dev_recent', { p_limit: 40 }).then(function(rows) {
        var box = $('.dv-log'); if (!box) return;
        box.innerHTML = (rows || []).length ? rows.map(function(r) {
          var t = new Date(r.at), when = ('0' + t.getDate()).slice(-2) + '.' + ('0' + (t.getMonth() + 1)).slice(-2) + ' ' + ('0' + t.getHours()).slice(-2) + ':' + ('0' + t.getMinutes()).slice(-2);
          return '<div class="dv-li"><b>' + esc(when) + '</b> ' + esc(r.admin) + ' · ' + esc(ACT[r.action] || r.action) + (r.target ? ' → ' + esc(r.target) : '') + (r.system_id ? ' · ' + esc((sys(r.system_id) || {}).name || r.system_id) : '') + '<i>' + esc(brief(r.data)) + '</i></div>';
        }).join('') : '<p class="dv-note">Пока пусто.</p>';
      }, fail);
    }
    $('.dv-body').innerHTML = h;
  }
  var ACT = { credits: 'кредиты', stock: 'сырьё', units: 'бойцы', ships: 'корабли', research_all: 'исследования', finish: 'достроить всё', settlement_level: 'уровень поселения', tutorial_done: 'шаг обучения' };
  function brief(d) { if (!d) return ''; var o = []; for (var k in d) if (d.hasOwnProperty(k) && d[k] !== 0) o.push(k + ' ' + d[k]); return o.join(', '); }
  function num(id, lo, hi) { var v = parseInt($(id).value, 10); if (!isFinite(v) || v < lo || v > hi) throw new Error('Число от ' + fmt(lo) + ' до ' + fmt(hi)); return v; }

  function onBody(e) {
    var c = e.target.closest('[data-set]');
    if (c) { var inp = $(c.getAttribute('data-set') === 'cr' ? '#dv-cr' : '#dv-st'); if (inp) inp.value = c.getAttribute('data-v'); return; }
    var b = e.target.closest('[data-act]'); if (!b || b.disabled) return;
    var a = b.getAttribute('data-act'), p = player(S.user) || {}, s = sys(S.system) || {};
    try {
      if (a === 'credits' || a === 'credits-') {
        var cr = num('#dv-cr', 1, 10000000) * (a === 'credits-' ? -1 : 1);
        rpc('dev_credits', { p_user: S.user, p_amount: cr }).then(function(v) { p.credits = v; say(p.nick + ': ' + (cr > 0 ? '+' : '') + fmt(cr) + ' кр. · теперь ' + fmt(v)); credits(); render(); }, fail);
      } else if (a === 'stock' || a === 'stock-') {
        var am = num('#dv-st', 1, 1000000) * (a === 'stock-' ? -1 : 1), res = $('#dv-res').value;
        rpc('dev_stock', { p_system: S.system, p_resource: res, p_amount: am }).then(function() { say(s.name + ': ' + (res === 'all' ? 'всё сырьё' : $('#dv-res').selectedOptions[0].textContent) + ' ' + (am > 0 ? '+' : '') + fmt(am)); }, fail);
      } else if (a === 'units') {
        var uq = num('#dv-uq', 1, 50), ut = $('#dv-unit').value;
        rpc('dev_units', { p_user: S.user, p_system: S.system, p_unit_type: ut, p_qty: uq }).then(function(n) { say(n === uq ? 'Высажено ' + n + ' на ' + s.name : 'Высажено ' + n + ' из ' + uq + ' — в зонах высадки не хватило места', n < uq); }, fail);
      } else if (a === 'ships') {
        var sq = num('#dv-sq', 1, 5), st = $('#dv-ship').value;
        rpc('dev_ships', { p_user: S.user, p_system: S.system, p_ship_type: st, p_qty: sq }).then(function(n) { say(n === sq ? 'На орбите ' + s.name + ': ' + n : 'Встало ' + n + ' из ' + sq + ' — орбита у станции занята', n < sq); }, fail);
      } else if (a === 'finish') {
        rpc('dev_finish', { p_system: S.system }).then(function(r) { var n = 0; for (var k in r) n += r[k] || 0; say(n ? s.name + ': готово ' + n + ' — ' + brief(r) : s.name + ': в очередях пусто'); credits(); }, fail);
      } else if (a === 'level') {
        var lv = +b.getAttribute('data-v');
        rpc('dev_settlement_level', { p_system: S.system, p_level: lv }).then(function() { say(s.name + ': поселение — уровень ' + lv); }, fail);
      } else if (a === 'research') {
        rpc('dev_research_all', { p_user: S.user }).then(function(n) { say(p.nick + ': открыто исследований — ' + n); }, fail);
      } else if (a === 'tutorial') {
        rpc('dev_tutorial_done', { p_user: S.user }).then(function(n) { say(p.nick + ': шаг обучения ' + n + ' засчитан'); }, fail);
      }
    } catch (err) { fail(err); }
  }

  function open() {
    if (!el) build();
    el.classList.add('open'); document.body.classList.add('dv-open');
    rpc('dev_catalog').then(function(c) {
      CAT = c;
      if (!S.user) S.user = c.me;
      if (!S.system) { var me = player(S.user); S.system = SYS_FROM_URL || (me && me.planet) || (c.systems[0] && c.systems[0].id); }
      fillPick(); render();
    }, function(e) { fail(e); });
  }
  function close() { if (!el) return; el.classList.remove('open'); document.body.classList.remove('dv-open'); }

  window.DevPanel = { open: open, close: close };
})();
