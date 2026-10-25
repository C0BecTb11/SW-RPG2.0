/* Кнопка «Назад» (Android, браузер) сначала закрывает открытое окно игры, а не уводит со страницы.
 *
 * Пока на экране открыто окно (панель, шторка, карточка — поверх карты, с кнопкой «✕»), в истории
 * лежит одна запись-«сторож». «Назад» снимает её: окно закрывается его же кнопкой «✕», страница
 * остаётся. Окон нет — «Назад» работает как раньше (сторож, если остался, пропускается сам).
 * Приложение Android (MainActivity) отдаёт «Назад» в историю WebView — правка в нём не нужна.
 *
 * Окно ищется само: видимый элемент с position: fixed на весь экран или большую его часть,
 * поверх карты (z-index ≥ 1000), с кнопкой закрытия (✕, «Закрыть», id …-close). Из нескольких — верхнее.
 * Окна без кнопки закрытия (брифинг боя, итог) не трогаются. ES5.
 */
(function() {
  'use strict';
  if (!window.history || !history.pushState) return;
  var armed = !!(history.state && history.state.swBack), leaving = false, raf = 0, shut = null, shutAt = 0;

  function visible(el) {
    if (!el || el.hidden) return false;
    var cs = getComputedStyle(el);
    // закрытое окно с плавным угасанием сразу перестаёт ловить касания — оно уже не «открыто»
    return cs.display !== 'none' && cs.visibility !== 'hidden' && +cs.opacity > 0.05 && cs.pointerEvents !== 'none';
  }
  function closer(el) {
    var list = el.querySelectorAll('button, [role="button"], .close, [data-close]');
    for (var i = 0; i < list.length; i++) {
      var b = list[i], id = b.id || '', tx = (b.textContent || '').replace(/\s+/g, ''), al = b.getAttribute('aria-label') || '';
      if ((/(^|-)close$/.test(id) || tx === '✕' || tx === '×' || /^Закрыть/.test(al)) && visible(b) && !b.disabled) return b;
    }
    return null;
  }
  // Верхнее открытое окно с кнопкой закрытия
  function top() {
    var best = null, bz = -1, vw = window.innerWidth, vh = window.innerHeight, kids = document.body ? document.body.children : [];
    for (var i = 0; i < kids.length; i++) {
      var el = kids[i];
      if (el.tagName === 'SCRIPT' || !visible(el)) continue;
      var cs = getComputedStyle(el); if (cs.position !== 'fixed') continue;
      var z = parseInt(cs.zIndex, 10) || 0; if (z < 1000) continue;
      var r = el.getBoundingClientRect(); if (r.width < vw * 0.6 && r.height < vh * 0.5) continue;
      var b = closer(el); if (!b) continue;
      if (z >= bz) { bz = z; best = { el: el, btn: b }; }
    }
    return best;
  }
  function check() {
    raf = 0;
    if (leaving) return;
    var o = !armed && top();
    // окно, которое только что закрывали «Назад», не взводит сторожа полсекунды: если «✕» его не спрятал,
    // «Назад» не застрянет на нём, а пойдёт дальше
    if (o && !(o.el === shut && Date.now() - shutAt < 500)) { try { history.pushState({ swBack: 1 }, '', location.href); armed = true; } catch (e) {} }
  }
  function later() { if (!raf) raf = requestAnimationFrame(check); }

  window.addEventListener('popstate', function(e) {
    var onGuard = !!(e.state && e.state.swBack);
    if (!armed) { armed = onGuard; return; }                 // «Вперёд» на сторожа — он снова наш
    armed = onGuard;
    var o = top();
    if (o) { shut = o.el; shutAt = Date.now(); o.btn.click(); setTimeout(later, 80); }   // закрыли окно; под ним ещё одно — сторож снова
    else if (!leaving) history.back();                       // окна уже нет — «Назад» идёт дальше, как раньше
  });
  window.addEventListener('pagehide', function() { leaving = true; });
  window.addEventListener('pageshow', function() { leaving = false; armed = !!(history.state && history.state.swBack); later(); });

  function init() {
    // окна — прямые потомки body: открываются сменой стиля, класса, hidden или появлением. Следим только
    // за ними (не за всем деревом — на карте каждый кадр меняются стили ракет и холстов); раз в секунду — сверка
    if (window.MutationObserver) {
      var opt = { attributes: true, attributeFilter: ['style', 'class', 'hidden'] };
      var mo = new MutationObserver(function(list) {
        for (var i = 0; i < list.length; i++) {
          var m = list[i];
          if (m.type === 'childList') for (var j = 0; j < m.addedNodes.length; j++) if (m.addedNodes[j].nodeType === 1) mo.observe(m.addedNodes[j], opt);
        }
        later();
      });
      mo.observe(document.body, { childList: true });
      for (var k = 0; k < document.body.children.length; k++) mo.observe(document.body.children[k], opt);
    }
    setInterval(function() { if (!document.hidden) later(); }, 1000);
    later();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
