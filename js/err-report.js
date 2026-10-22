/* Журнал ошибок у игроков.
 *
 * Ловит падения скриптов на странице (window.onerror, необработанные промисы) и
 * ошибки, которые игра сама перехватывает в циклах кадра, чтобы не зависнуть
 * (там вызывается errReport(err, 'где')). Шлёт их пачкой в базу:
 * report_client_errors (sql/client_errors.sql). Смотреть — DEV → «Ошибки».
 *
 * Бережно к игроку и к базе:
 *   * одна и та же ошибка склеивается, в базу уходит счётчик повторов, а не поток;
 *   * не больше 25 разных ошибок за открытие страницы, первая отправка через 2 с,
 *     повторы — раз в минуту;
 *   * без входа ничего не шлём (гость получил бы 401);
 *   * сам сборщик никогда не бросает исключений.
 * Подключать сразу после supabase-client.js. ES5.
 */
(function() {
  'use strict';
  if (window.errReport) return;

  var MAX_SIGS = 25, MAX_TRIES = 3;
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
  // уходя со страницы — отправить, что накопилось
  window.addEventListener('pagehide', function() { if (timer) { clearTimeout(timer); timer = 0; } flush(); });

  // для перехваченных ошибок: errReport(err, 'ground.frame')
  window.errReport = function(err, ctx) { report(err, ctx); };
})();
