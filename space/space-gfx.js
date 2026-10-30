/* Настройки графики и вида (бой 2.0).
 *
 * Качество — набор чисел, которые читают отрисовка и эффекты:
 *   dpr     — чёткость холста (не выше плотности экрана);
 *   atlas   — размер картинки одной фигурки в наборе (крупнее — чётче вблизи);
 *   sparks  — искр на попадание и промах;
 *   smoke   — дым от разбитых дроидов;
 *   decals  — сколько подпалин от промахов хранит палуба;
 *   debris  — дроиды разлетаются на части (иначе — сразу лежат);
 *   embers  — тлеющие подпалины и отсветы.
 * «Авто» — по устройству: телефон — «средне», компьютер — «высоко».
 * Хранится у игрока в браузере (localStorage) — это удобство, не общий стейт.
 */
(function(root) {
  'use strict';

  var PRESET = {
    low:   { name: 'Минимум', dpr: 1,   atlas: 36, sparks: 0,  smoke: false, decals: 0,   debris: false, embers: false,
             about: 'Обычная чёткость, без искр, дыма и подпалин. Для слабых телефонов и долгих боёв.' },
    mid:   { name: 'Средне',  dpr: 1.5, atlas: 44, sparks: 3,  smoke: true,  decals: 120, debris: true,  embers: false,
             about: 'Чёткость ×1,5, немного искр, подпалины от промахов, дроиды разлетаются.' },
    high:  { name: 'Высоко',  dpr: 2,   atlas: 56, sparks: 6,  smoke: true,  decals: 300, debris: true,  embers: true,
             about: 'Чёткость ×2, искры и дым, тлеющие подпалины.' },
    ultra: { name: 'Ультра',  dpr: 3,   atlas: 72, sparks: 10, smoke: true,  decals: 700, debris: true,  embers: true,
             about: 'Полная чёткость экрана, крупные фигурки, все эффекты. Для мощных телефонов и компьютеров.' }
  };
  var DEF = { q: 'auto', view: 'auto', nums: true, mini: true, shake: true, eco: false };
  var KEY = 'sp-gfx1';
  var S = load(), subs = [];

  function load() {
    var o = {}, k;
    for (k in DEF) o[k] = DEF[k];
    try {
      var s = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (s && typeof s === 'object') for (k in DEF) if (typeof s[k] === typeof DEF[k]) o[k] = s[k];
    } catch (e) {}
    if (o.q !== 'auto' && !PRESET[o.q]) o.q = 'auto';
    if (['auto', 'tokens', 'figures'].indexOf(o.view) < 0) o.view = 'auto';
    return o;
  }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) {} }
  // телефон: палец вместо мыши или маленький экран
  function phone() {
    var coarse = false;
    try { coarse = root.matchMedia && root.matchMedia('(pointer: coarse)').matches; } catch (e) {}
    return coarse || Math.min(root.screen ? root.screen.width : 1e4, root.screen ? root.screen.height : 1e4) < 820;
  }
  function autoQ() {
    var mem = root.navigator && root.navigator.deviceMemory, cores = root.navigator && root.navigator.hardwareConcurrency;
    if ((mem && mem <= 2) || (cores && cores <= 2)) return 'low';
    return phone() ? 'mid' : 'high';
  }
  var AUTO = null;                 // устройство за бой не меняется — решаем один раз
  function level() { return S.q === 'auto' ? (AUTO || (AUTO = autoQ())) : S.q; }
  function Q() { return PRESET[level()]; }
  function set(k, v) {
    if (!(k in DEF) || S[k] === v) return;
    S[k] = v; save();
    for (var i = 0; i < subs.length; i++) { try { subs[i](k, v); } catch (e) {} }
  }

  // ---------------------------------------------------------------- окно
  var el = null;
  function chips(key, list) {
    return list.map(function(o) {
      return '<button type="button" class="sp-chip' + (S[key] === o[0] ? ' on' : '') + '" data-gk="' + key + '" data-gv="' + o[0] + '">' + o[1] +
        (o[2] ? '<em>' + o[2] + '</em>' : '') + '</button>';
    }).join('');
  }
  function toggle(key, name, about) {
    return '<button type="button" class="sp-gfx-tg' + (S[key] ? ' on' : '') + '" data-gt="' + key + '"><i></i><span><b>' + name + '</b><em>' + about + '</em></span></button>';
  }
  // ctx — что умеет экран: наземка без жетонов и тряски (hide), своя подпись мини-карты (mini)
  var CTX = {};
  function render(fps) {
    if (!el) return;
    var lv = level(), P = PRESET[lv], hide = CTX.hide || {};
    el.querySelector('.sp-gfx-body').innerHTML =
      '<div class="sp-poly-lab">Качество графики</div><div class="sp-poly-chips">' +
      chips('q', [['auto', 'Авто', S.q === 'auto' ? PRESET[AUTO || (AUTO = autoQ())].name.toLowerCase() : ''], ['low', 'Минимум'], ['mid', 'Средне'], ['high', 'Высоко'], ['ultra', 'Ультра']]) + '</div>' +
      '<p class="sp-gfx-about">' + P.about + (fps ? ' <span>Сейчас ' + fps + ' к/с.</span>' : '') + '</p>' +
      (hide.view ? '' : '<div class="sp-poly-lab">Бойцы на палубе</div><div class="sp-poly-chips">' +
      chips('view', [['auto', 'Авто', 'по масштабу'], ['tokens', 'Жетоны'], ['figures', 'Фигурки']]) + '</div>') +
      '<div class="sp-poly-lab">Экран боя</div><div class="sp-gfx-tgs">' +
      (hide.nums ? '' : toggle('nums', 'Цифры урона', 'над бойцом при попадании')) +
      (hide.mini ? '' : toggle('mini', CTX.mini || 'Мини-карта палубы', 'в углу; касание — камера туда')) +
      (hide.shake ? '' : toggle('shake', 'Тряска', 'от попаданий по своему кораблю')) +
      toggle('eco', 'Экономия заряда', 'не чаще 30 кадров в секунду') + '</div>';
  }
  function open(fps, ctx) {
    CTX = ctx || {};
    if (!el) {
      el = document.createElement('div');
      el.className = 'sp-end sp-poly sp-gfx'; el.id = 'sp-gfx'; el.hidden = true;
      el.innerHTML = '<div class="sp-end-card"><div class="sp-kicker">Настройки</div><h2>Графика и вид</h2><div class="sp-gfx-body"></div>' +
        '<div class="sp-btns" style="grid-template-columns:1fr"><button class="sp-btn gold" type="button" data-gx="1">Готово</button></div></div>';
      document.body.appendChild(el);
      el.addEventListener('click', function(e) {
        if (e.target === el || e.target.closest('[data-gx]')) { el.hidden = true; return; }
        var c = e.target.closest('[data-gk]'), t = e.target.closest('[data-gt]');
        if (c) set(c.getAttribute('data-gk'), c.getAttribute('data-gv'));
        else if (t) set(t.getAttribute('data-gt'), !S[t.getAttribute('data-gt')]);
        else return;
        render(el._fps);
      });
    }
    el._fps = fps; render(fps); el.hidden = false;
  }

  root.SPGfx = {
    Q: Q, level: level, get: function(k) { return S[k]; }, set: set, open: open, PRESET: PRESET,
    on: function(fn) { subs.push(fn); }
  };

  // Нажатие в нижней панели боя (полоса, шторка): действие — когда палец отпущен на месте, а не в момент
  // касания. Иначе прокрутка шторки пальцем выбирала бойцов и отправляла их на борт (аудит 30.10, BUG-063).
  // Панель перерисовывается 4 раза в секунду, поэтому click (он требует того же элемента под пальцем при
  // нажатии и отпускании) теряется — цель берётся заново под точкой отпускания. Прокрутка (pointercancel,
  // сдвиг больше 8 px, сдвиг прокрутки) — не нажатие.
  root.SPTap = function(rootEl, fn) {
    var st = null;
    function scrolls(t) { var s = 0; for (var e = t; e && e !== rootEl.parentNode; e = e.parentNode) s += e.scrollTop || 0; return s; }
    rootEl.addEventListener('pointerdown', function(e) { if (e.button > 0) return; st = { id: e.pointerId, x: e.clientX, y: e.clientY, t: Date.now(), tg: e.target, sc: scrolls(e.target) }; });
    rootEl.addEventListener('pointercancel', function(e) { if (st && st.id === e.pointerId) st = null; });
    rootEl.addEventListener('pointerup', function(e) {
      var s0 = st; st = null;
      if (!s0 || s0.id !== e.pointerId) return;
      if (Math.abs(e.clientX - s0.x) + Math.abs(e.clientY - s0.y) > 8 || Date.now() - s0.t > 1200) return;
      if (s0.tg.isConnected && scrolls(s0.tg) !== s0.sc) return;
      var t = document.elementFromPoint(e.clientX, e.clientY) || e.target;
      if (!rootEl.contains(t)) return;
      fn({ target: t, preventDefault: function() { e.preventDefault(); }, clientX: e.clientX, clientY: e.clientY });
    });
  };
})(typeof self !== 'undefined' ? self : this);
