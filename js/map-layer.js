// Переход между земным и космическим пространством планеты прямо с карты, без захода в галактику.
// Ссылка #sp-layer стоит рядом с «← Галактика» (game/ground-battle.html, game/space-battle.html):
// здесь ей ставится адрес той же планеты; режим стройки сохраняется — как у переключателя стройки внизу.
// На орбите ссылка ждёт, пока страница узнает систему (js/space-battle.js снимает .wait): у пустоты
// поверхности нет, и там ссылка так и не появляется.
// Строка не должна наезжать на пилюлю кредитов (она растёт: часы, сумма, у админа — DEV): если тесно,
// у «← Галактика» остаётся только стрелка (#sp-nav.tight). ES5.
(function() {
  var nav = null, raf = 0, watched = null;

  function fit() {
    raf = 0;
    var bar = document.getElementById('credits-bar');
    if (!nav) return;
    if (bar && bar !== watched && window.MutationObserver) {         // сумма и DEV приходят позже — следим за пилюлей
      watched = bar;
      new MutationObserver(later).observe(bar, { childList: true, subtree: true, characterData: true });
    }
    nav.classList.remove('tight');
    if (!bar) return;
    var a = nav.getBoundingClientRect(), b = bar.getBoundingClientRect();
    if (b.width > 0 && b.top < a.bottom && a.top < b.bottom && a.right + 8 > b.left) nav.classList.add('tight');
  }
  function later() { if (!raf) raf = window.requestAnimationFrame(fit); }

  function init() {
    nav = document.getElementById('sp-nav');
    var a = document.getElementById('sp-layer');
    if (a) {
      var q = new URLSearchParams(window.location.search), sys = q.get('system');
      if (!sys) a.style.display = 'none';
      else a.href = a.getAttribute('data-page') + '?system=' + encodeURIComponent(sys) + (q.get('mode') === 'build' ? '&mode=build' : '');
      // на орбите ссылка показывается позже (снимают .wait) — тогда и перемерить
      if (window.MutationObserver) new MutationObserver(later).observe(a, { attributes: true, attributeFilter: ['class'] });
    }
    if (!nav) return;
    // пилюлю кредитов создают скрипты страницы — ждём её появления в body
    if (window.MutationObserver) new MutationObserver(later).observe(document.body, { childList: true });
    window.addEventListener('resize', later);
    window.addEventListener('orientationchange', later);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(later);
    later();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
