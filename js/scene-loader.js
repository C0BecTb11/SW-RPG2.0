// Экран загрузки при переходе на поверхность и на орбиту.
// Разметка уже стоит в HTML страницы и видна с первого кадра: игрок не
// видит, как карта собирается по кускам — сначала рельеф, потом здания,
// войска, картинки, — каждый кусок перерисовывает всё поле, и слабый
// телефон в эти секунды мигает чёрным. Страница отмечает готовые части
// (sceneLoader.mark), экран уходит, когда собрано всё и карта успела
// успокоиться. Таймеры — только setTimeout: в скрытой панели
// предпросмотра кадровые колбэки не выполняются.
(function() {
  var el = document.getElementById('scene-loader');
  if (!el) return;

  var MIN_MS = 700;      // меньше — экран мелькает и сам раздражает
  var SETTLE_MS = 450;   // догрузка картинок и последние перерисовки
  var MAX_MS = 9000;     // что бы ни случилось, игру не держим

  var started = Date.now();
  var need = [];
  var got = {};
  var finished = false;
  var settleTimer = null;
  var labels = {};

  // Замер долгой загрузки: когда какой шаг готов, самая длинная «заморозка» страницы
  // (поток занят, таймеры не идут) и сворачивали ли её. Загрузка дольше SLOW_MS или уход со
  // страницы до конца загрузки — строка в журнал ошибок (DEV → «Ошибки») с подробностями:
  // так видно, на чём встаёт слабый телефон. Свёрнутая страница тоже «замерзает» — это помечено.
  var SLOW_MS = 9000;
  var at = {};
  var gapMax = 0, gapAt = 0, tickLast = Date.now(), wasHidden = !!document.hidden;
  var ticker = setInterval(function() {
    var now = Date.now(), gap = now - tickLast - 250;
    if (gap > gapMax) { gapMax = gap; gapAt = now - started; }
    tickLast = now;
    if (document.hidden) wasHidden = true;
  }, 250);
  document.addEventListener('visibilitychange', function() { if (document.hidden) wasHidden = true; });
  var reported = false;
  function slowReport(why) {
    if (reported || !window.errReport) return;
    var total = Date.now() - started;
    if (total < (why === 'ушёл со страницы' ? 5000 : SLOW_MS)) return;
    reported = true;
    var steps = need.map(function(k) { return k + ' ' + (got[k] ? (at[k] / 1000).toFixed(1) + ' с' : 'нет'); });
    var nav = navigator || {};
    var info = [
      'Итог: ' + why + ', ' + (total / 1000).toFixed(1) + ' с',
      'Шаги: ' + (steps.join(', ') || '—'),
      'Самая долгая заморозка: ' + (gapMax / 1000).toFixed(1) + ' с (на ' + (gapAt / 1000).toFixed(1) + ' с)' + (wasHidden ? ', страницу сворачивали' : ''),
      'Устройство: ядер ' + (nav.hardwareConcurrency || '?') + ', память ' + (nav.deviceMemory || '?') + ' ГБ, экран ' +
        (window.innerWidth || 0) + '×' + (window.innerHeight || 0) + ' ×' + (window.devicePixelRatio || 1)
    ].join('\n');
    try { errReport({ message: 'Долгая загрузка сцены · ' + (location.pathname.split('/').pop() || ''), stack: info }, 'scene.slow'); } catch (e) {}
  }

  var bar = el.querySelector('.sl-bar i');
  var stepEl = el.querySelector('.sl-step');

  function paint() {
    var total = need.length || 1;
    var done = need.filter(function(k) { return got[k]; }).length;
    // Не дотягиваем до конца, пока экран не ушёл: полоса не «зависает» на 100%
    var pct = Math.round(8 + 84 * done / total);
    if (bar) bar.style.width = pct + '%';
    var next = need.filter(function(k) { return !got[k]; })[0];
    if (stepEl) stepEl.textContent = next ? (labels[next] || '') : 'Готово';
  }

  function hide(why) {
    if (finished) return;
    finished = true;
    clearInterval(ticker);
    slowReport(typeof why === 'string' ? why : (need.some(function(k) { return !got[k]; }) ? 'не дождались' : 'готово'));
    if (bar) bar.style.width = '100%';
    el.classList.add('sl-out');
    setTimeout(function() {
      if (el.parentNode) el.parentNode.removeChild(el);
    }, 380);
  }

  function tryFinish() {
    if (finished) return;
    if (need.some(function(k) { return !got[k]; })) return;
    if (settleTimer) clearTimeout(settleTimer);
    var wait = Math.max(SETTLE_MS, MIN_MS - (Date.now() - started));
    settleTimer = setTimeout(hide, wait);
  }

  window.sceneLoader = {
    // steps: [['terrain', 'Местность'], ...] — что должно быть готово
    expect: function(steps) {
      steps.forEach(function(s) {
        if (need.indexOf(s[0]) < 0) need.push(s[0]);
        labels[s[0]] = s[1];
      });
      paint();
    },
    mark: function(key) {
      if (finished || got[key]) return;
      got[key] = true;
      at[key] = Date.now() - started;
      paint();
      tryFinish();
    },
    hide: hide,
    isOpen: function() { return !finished; }
  };

  // Название и вид планеты — отдельным лёгким запросом
  var sys = null;
  try { sys = new URLSearchParams(window.location.search).get('system'); } catch (e) {}
  var nameEl = el.querySelector('.sl-name');
  var globe = el.querySelector('.sl-globe');
  if (sys && typeof supabase !== 'undefined' && supabase.from) {
    supabase.from('systems').select('name, texture, faction').eq('id', sys).maybeSingle().then(function(res) {
      var s = res && res.data;
      if (!s) return;
      if (nameEl && s.name) nameEl.textContent = s.name;
      if (globe && s.texture) {
        var img = new Image();
        img.onload = function() {
          globe.style.backgroundImage = 'url(../' + s.texture + ')';
          globe.classList.add('sl-has-tex');
        };
        img.src = '../' + s.texture;
      }
      if (s.faction === 'cis' || s.faction === 'republic') el.classList.add('sl-' + s.faction);
    });
  }

  // Ошибка страницы видна поверх экрана: прячем его, чтобы не мешал читать
  window.addEventListener('error', function() { setTimeout(hide, 0); });

  setTimeout(function() { hide('по таймеру ' + MAX_MS / 1000 + ' с'); }, MAX_MS);
  // Ушёл, не дождавшись: строку — раньше, чем журнал отправит накопленное на уходе
  // (слушатель с захватом срабатывает первым)
  window.addEventListener('pagehide', function() { if (!finished) slowReport('ушёл со страницы'); }, true);
})();
