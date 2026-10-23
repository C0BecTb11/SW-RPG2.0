/* Журнал ошибок у игроков.
 *
 * Что ловит:
 *   * падения скриптов (window.onerror) и необработанные промисы;
 *   * ошибки, которые игра сама перехватывает в циклах кадра (errReport(err, 'где'));
 *   * console.error из кода игры (место «console»; если та же ошибка ушла через errReport — один раз);
 *   * файлы, которые не загрузились: скрипты, стили, картинки (место «load»);
 *   * зависания: страница на виду не отвечала 8 с и дольше (место «freeze»);
 *   * ответы базы с ошибкой и сбои каналов realtime — их передаёт js/supabase-client.js
 *     (места «rpc:имя», «db:таблица», «realtime»); сервер боёв — ground/ground.js («rt.*»).
 * Шлёт их пачкой в базу: report_client_errors (sql/client_errors.sql). Смотреть — DEV → «Ошибки».
 *
 * Бережно к игроку и к базе:
 *   * одна и та же ошибка склеивается, в базу уходит счётчик повторов, а не поток;
 *   * не больше 40 разных ошибок за открытие страницы, первая отправка через 2 с,
 *     повторы — раз в минуту;
 *   * без входа ничего не шлём (гость получил бы 401);
 *   * сам сборщик никогда не бросает исключений.
 * Подключать сразу после supabase-client.js. ES5.
 */
(function() {
  'use strict';
  if (window.errReport) return;

  var MAX_SIGS = 40, MAX_TRIES = 3;
  var Q = {}, keys = [], timer = 0, timerAt = 0, busy = false, inside = false, tries = 0;
  var ORIGIN = location.origin || (location.protocol + '//' + location.host);
  // шум, который не про нашу игру: расширения браузера, чужие скрипты, сеть
  var NOISE = /^(Script error\.?|ResizeObserver loop|Non-Error promise rejection)|Failed to fetch|NetworkError|Load failed|AbortError|The user aborted|cancell?ed|чтение отменено/i;
  var FOREIGN = /^(chrome|moz|safari(-web)?|ms-browser)-extension:|^webkit-masked-url:/;

  function clip(s, n) { s = s == null ? '' : String(s); return s.length > n ? s.slice(0, n) : s; }
  // значения ключей и токенов из адресов не храним — ни в странице, ни в файле, ни в стеке
  var SECRET = /([?&#](?:token|key|code|access_token|refresh_token|srv)=)[^&#\s)]*/gi;
  function local(s) { return String(s || '').split(ORIGIN).join('').replace(SECRET, '$1…'); }
  function page() { return clip(local(location.pathname + location.search), 200); }
  function frame(stack) {
    // первая строка стека с адресом файла: «…(https://…/x.js?v=3:120:5)» или «f@https://…:120:5»
    var m = /((?:https?|file):\/\/[^\s()]+?):(\d+):(\d+)/.exec(stack || '');
    return m ? { src: m[1], line: +m[2], col: +m[3] } : null;
  }

  function report(err, ctx, src, line, col) {
    if (inside) return;
    inside = true;
    try {
      var msg, stack = '';
      if (err && typeof err === 'object') {
        try { err.__rep = 1; } catch (e) { /* замороженный объект */ }   // console.error с той же ошибкой — не дублировать
        msg = err.message != null ? String(err.message) : '';
        if (err.name && msg.indexOf(err.name) !== 0) msg = err.name + ': ' + msg;
        if (!err.message && !err.name) { try { msg = JSON.stringify(err); } catch (e) { msg = String(err); } }
        stack = typeof err.stack === 'string' ? err.stack : '';
      } else msg = String(err);
      msg = clip(msg.replace(/\s+/g, ' ').trim(), 500);
      if (!msg || NOISE.test(msg)) return;
      if (!src) { var f = frame(stack); if (f) { src = f.src; line = f.line; col = f.col; } }
      if (src && FOREIGN.test(src)) return;
      src = clip(local(src), 300);
      var key = msg + '|' + src + '|' + (line || '') + '|' + (col || '');
      var q = Q[key];
      if (q) { q.n++; q.d++; plan(60000); return; }
      if (keys.length >= MAX_SIGS) return;
      Q[key] = {
        msg: msg, src: src || null, line: line || null, col: col || null,
        stack: clip(local(stack).split('\n').slice(0, 10).join('\n'), 4000) || null,
        ctx: ctx ? clip(ctx, 60) : null, page: page(), n: 1, d: 1, sent: false
      };
      keys.push(key);
      plan(2000);
    } catch (e) { /* сборщик молчит */ } finally { inside = false; }
  }

  // новая ошибка — через 2 с, повторы — не чаще раза в минуту; ранний срок важнее позднего
  function plan(ms) {
    var at = Date.now() + ms;
    if (timer && timerAt <= at) return;
    if (timer) clearTimeout(timer);
    timerAt = at;
    timer = setTimeout(function() { timer = 0; flush(); }, ms);
  }
  function canSend() {
    if (typeof supabase === 'undefined' || !supabase || typeof supabase.rpc !== 'function') return false;
    if (typeof sbHasStoredToken === 'function' && !sbHasStoredToken()) return false;
    return navigator.onLine !== false;
  }
  function flush() {
    if (busy || tries >= MAX_TRIES) return;
    var items = [], took = [];
    for (var i = 0; i < keys.length && items.length < 10; i++) {
      var q = Q[keys[i]];
      if (!q.d) continue;
      items.push({ msg: q.msg, src: q.src, line: q.line, col: q.col, n: q.d,
                   stack: q.sent ? null : q.stack, ctx: q.ctx, page: q.page,
                   ua: q.sent ? null : clip(navigator.userAgent, 300) });
      took.push([q, q.d]);
    }
    if (!items.length) return;
    if (!canSend()) { plan(60000); return; }
    busy = true;
    took.forEach(function(t) { t[0].d -= t[1]; t[0].sent = true; });
    function back() { took.forEach(function(t) { t[0].d += t[1]; }); tries++; }
    try {
      supabase.rpc('report_client_errors', { p_items: items }).then(function(r) {
        busy = false;
        if (r && r.error) back(); else tries = 0;
        // ещё не отправленные новые — следом, повторы старых — через минуту
        var fresh = false, more = false;
        keys.forEach(function(k) { if (Q[k].d > 0) { more = true; if (!Q[k].sent) fresh = true; } });
        if (more) plan(fresh ? 2000 : 60000);
      }, function() { busy = false; back(); plan(60000); });
    } catch (e) { busy = false; back(); }
  }

  window.addEventListener('error', function(e) {
    // ошибка загрузки картинки/скрипта приходит без message — это не падение кода
    if (!e || !e.message) return;
    report(e.error || e.message, null, e.filename, e.lineno, e.colno);
  });
  window.addEventListener('unhandledrejection', function(e) {
    var r = e && e.reason;
    if (r == null) return;
    report(r, 'promise');
  });
  // Файл не загрузился (ошибка ресурса не всплывает — ловим на погружении): скрипт, стиль, картинка.
  // Без сети не пишем — это не поломка игры.
  window.addEventListener('error', function(e) {
    try {
      var t = e && e.target;
      if (!t || t === window || !t.tagName || navigator.onLine === false) return;
      var tag = t.tagName, url = tag === 'LINK' ? t.href : (t.currentSrc || t.src);
      if (!url || /^(data|blob):/.test(url)) return;
      if (tag !== 'SCRIPT' && tag !== 'IMG' && !(tag === 'LINK' && /stylesheet/i.test(t.rel || ''))) return;
      var what = tag === 'SCRIPT' ? 'не загрузился скрипт' : tag === 'LINK' ? 'не загрузился стиль' : 'не загрузилась картинка';
      report({ name: 'Загрузка', message: what + ' ' + clip(local(url), 200) }, 'load', local(url));
    } catch (x) { /* сборщик молчит */ }
  }, true);

  // console.error из кода игры. Отправляем на следующем такте: если ту же ошибку
  // тут же передали в errReport (так делают циклы кадра), второй записи не будет.
  // Ошибки ответа базы (у них code и details) уже записал js/supabase-client.js.
  (function() {
    var real = console && console.error;
    if (typeof real !== 'function') return;
    console.error = function() {
      var args = arguments;
      try { real.apply(console, args); } catch (e) { /* консоль недоступна */ }
      try {
        var obj = null, parts = [];
        for (var i = 0; i < args.length && i < 6; i++) {
          var a = args[i];
          if (a && typeof a === 'object') {
            if (a.message != null || a.stack) { if (!obj) obj = a; parts.push((a.name ? a.name + ': ' : '') + a.message); }
            else { try { parts.push(JSON.stringify(a).slice(0, 200)); } catch (x) { parts.push(String(a)); } }
          } else parts.push(String(a));
        }
        if (obj && 'code' in obj && ('details' in obj || 'hint' in obj)) return;
        var text = parts.join(' ');
        setTimeout(function() {
          if (obj && obj.__rep) return;
          report({ name: 'console.error', message: text, stack: obj && typeof obj.stack === 'string' ? obj.stack : '' }, 'console');
        }, 0);
      } catch (e) { /* сборщик молчит */ }
    };
  })();

  // Зависание: таймер раз в секунду; если между тиками прошло 8 с+, а страница всё время
  // была на виду — главный поток стоял (долгий расчёт, тяжёлая отрисовка). В фоне и после
  // сна телефона таймеры стоят законно — такие паузы отсекает visibilitychange.
  (function() {
    var last = Date.now();
    document.addEventListener('visibilitychange', function() { last = Date.now(); });
    window.addEventListener('pageshow', function() { last = Date.now(); });
    setInterval(function() {
      var now = Date.now(), gap = now - last;
      last = now;
      if (document.hidden || gap < 8000 || gap > 600000) return;
      var band = gap < 15000 ? '8–15 с' : gap < 30000 ? '15–30 с' : 'больше 30 с';
      report({ name: 'Зависание', message: 'страница не отвечала ' + band,
               stack: 'пауза ' + Math.round(gap / 100) / 10 + ' с · ' + page() }, 'freeze');
    }, 1000);
  })();

  // уходя со страницы — отправить, что накопилось
  window.addEventListener('pagehide', function() { if (timer) { clearTimeout(timer); timer = 0; } flush(); });

  // для перехваченных ошибок: errReport(err, 'ground.frame')
  window.errReport = function(err, ctx) { report(err, ctx); };
})();
