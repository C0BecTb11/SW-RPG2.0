// Подключение к Supabase. Ключи тут одни на весь проект —
// меняешь один раз в этом файле, если понадобится (например при смене проекта).

var SUPABASE_URL = 'https://zqqaxhhajhgspaiwlyhy.supabase.co';
var SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpxcWF4aGhhamhnc3BhaXdseWh5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU0NDMyNjIsImV4cCI6MjEwMTAxOTI2Mn0.oauDY1aq02uU1dHsoj_H50fi4owBDypn_hMHDalHOSw';

// Ответы базы с ошибкой — в журнал ошибок (js/err-report.js → DEV → «Ошибки» → «Игроки»).
// Через этот fetch идут все запросы к таблицам и функциям (supabase.rpc, supabase.from).
// Пишем только сбои: отказ с текстом для игрока («raise exception», код P0001), «нет строки»
// у .single() (PGRST116) и истёкший вход (401, PGRST301/303) — это не ошибки игры.
// Обрыв сети тоже не пишем: на телефоне это норма, игра переспрашивает сама.
var SB_QUIET_CODES = { P0001: 1, PGRST116: 1, PGRST301: 1, PGRST303: 1 };
function sbClean(s) {
  return String(s == null ? '' : s)
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '‹id›')
    .replace(/"[^"]{0,80}"/g, '"…"').replace(/\d{3,}/g, '#');
}
function sbNoteFail(url, init, res) {
  if (!window.errReport || res.status === 401) return;
  var m = /\/rest\/v1\/(rpc\/)?([A-Za-z0-9_]+)/.exec(url);
  if (!m || m[2] === 'report_client_errors') return;            // сам журнал не пишет о себе — без петли
  var what = (m[1] ? 'rpc ' : 'таблица ') + m[2], method = (init && init.method) || 'GET';
  res.clone().text().then(function(t) {
    var j = null;
    try { j = JSON.parse(t); } catch (e) {}
    var code = j && j.code ? String(j.code) : '';
    if (SB_QUIET_CODES[code]) return;
    var msg = j && j.message ? sbClean(j.message) : ('HTTP ' + res.status + (t ? ' · ' + sbClean(t.slice(0, 120)) : ''));
    window.errReport({ name: 'База', message: what + ' · ' + (code ? code + ': ' : '') + msg,
                       stack: [method + ' ' + what, 'HTTP ' + res.status,
                               j && j.details ? 'details: ' + String(j.details).slice(0, 300) : '',
                               j && j.hint ? 'hint: ' + String(j.hint).slice(0, 300) : ''].filter(Boolean).join('\n') },
                     m[1] ? 'rpc:' + m[2] : 'db:' + m[2]);
  }, function() {});
}
function sbFetch(input, init) {
  var f = window.fetch(input, init);
  try {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    if (url.indexOf('/rest/v1/') >= 0) {
      f.then(function(res) { try { if (res && res.status >= 400) sbNoteFail(url, init, res); } catch (e) {} }, function() {});
    }
  } catch (e) { /* журнал не мешает запросу */ }
  return f;
}

var supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, { global: { fetch: sbFetch } });

// Realtime: канал не поднялся (CHANNEL_ERROR) или не ответил (TIMED_OUT) — в журнал.
// Только когда страница на виду и сеть есть: в фоне и без сети каналы рвутся законно.
(function() {
  var realChannel = supabase.channel.bind(supabase);
  supabase.channel = function(name) {
    var ch = realChannel.apply(null, arguments);
    try {
      var realSub = ch.subscribe.bind(ch);
      ch.subscribe = function(cb, timeout) {
        return realSub(function(status, err) {
          try {
            if ((status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') && window.errReport &&
                !document.hidden && navigator.onLine !== false) {
              window.errReport({ name: 'Realtime', message: 'канал ' + sbClean(name).replace(/-[A-Za-z0-9_]+$/, '-…') + ' · ' + status +
                                 (err && err.message ? ' · ' + sbClean(err.message) : '') }, 'realtime');
            }
          } catch (e) {}
          if (typeof cb === 'function') return cb.apply(this, arguments);
        }, timeout);
      };
    } catch (e) { /* без обёртки — как было */ }
    return ch;
  };
})();

// Игровые страницы без входа. Их открывают не только игроки: «Прочитать
// вслух» Google и роботы загружают страницу без сессии. Все игровые функции
// закрыты для гостя, поэтому каждый такой вызов давал 401 и строку ERROR в
// журнале базы. Пока сессии нет, отвечаем сами, без запроса к серверу, а
// galaxy.js / ground-battle.js / space-battle.js уводят на вход.
var SB_TOKEN_KEY = 'sb-' + SUPABASE_URL.split('//')[1].split('.')[0] + '-auth-token';

function sbHasStoredToken() {
  try { return !!window.localStorage.getItem(SB_TOKEN_KEY); } catch (e) { return true; }
}

// Уход на страницу входа с адресом возврата: после входа игрок попадает
// туда же, где был, а не на пустую страницу с одной кнопкой «Выйти»
function sbGoToAuth() {
  var tail = location.pathname.split('/game/')[1] || '';
  var next = tail ? 'game/' + tail + location.search + location.hash : '';
  location.href = '../auth.html' + (next ? '?next=' + encodeURIComponent(next) : '');
}

// Проверка входа на игровых страницах. getSession может на миг вернуть
// пустую сессию: токен обновляется, сеть моргнула, несколько вкладок игры
// делят одну блокировку. Раньше это сразу выкидывало на вход, а там игрок
// видел «Ты вошёл как …» и не мог вернуться. Теперь, если токен в браузере
// есть, спрашиваем ещё два раза и только потом уводим. Промис исполняется
// только при живой сессии и отдаёт тот же {data: {session}}, что getSession.
function sbSessionGate() {
  return new Promise(function(resolve) {
    var tries = 0, answered = false;
    // сессия молчит 8 с (блокировка сессии между вкладками, телефон проснулся) — в журнал:
    // так видно, если вход на страницу встал ещё до загрузки игры
    setTimeout(function() {
      if (!answered && window.errReport) errReport({ name: 'Вход', message: 'сессия не ответила за 8 с · ' + (location.pathname.split('/').pop() || '') }, 'auth.gate');
    }, 8000);
    function attempt() {
      supabase.auth.getSession().then(function(res) {
        answered = true;
        var s = res && res.data && res.data.session;
        if (s) { resolve({ data: { session: s }, error: null }); return; }
        retry();
      }, function() { answered = true; retry(); });
    }
    function retry() {
      if (tries < 2 && sbHasStoredToken()) {
        tries++;
        setTimeout(attempt, 800 * tries);
        return;
      }
      sbGoToAuth();
    }
    attempt();
  });
}

(function() {
  if (location.pathname.indexOf('/game/') < 0) return;
  var tokenKey = SB_TOKEN_KEY;
  var realRpc = supabase.rpc.bind(supabase);
  supabase.rpc = function() {
    var signedIn = true;
    try { signedIn = !!window.localStorage.getItem(tokenKey); } catch (e) {}
    if (!signedIn) {
      return Promise.resolve({ data: null, error: { message: 'Нет входа в игру', code: 'no_session' }, count: null, status: 401, statusText: 'no session' });
    }
    return realRpc.apply(null, arguments);
  };
})();

// Токен входа для сервера боёв. getSession иногда не отвечает (блокировка сессии между
// вкладками, телефон проснулся) — тогда через ms берём сохранённый токен напрямую, а случай
// пишем в журнал. Пустая строка — токена нет вовсе.
function sbStoredToken() {
  try {
    var j = JSON.parse(window.localStorage.getItem(SB_TOKEN_KEY) || 'null');
    return (j && (j.access_token || (j.currentSession && j.currentSession.access_token))) || '';
  } catch (e) { return ''; }
}
function sbAccessToken(ms) {
  ms = ms || 5000;
  var done = false;
  return Promise.race([
    supabase.auth.getSession().then(function(r) {
      done = true; var s = r && r.data && r.data.session; return s ? s.access_token : sbStoredToken();
    }, function() { done = true; return sbStoredToken(); }),
    new Promise(function(res) {
      setTimeout(function() {
        if (done) return;
        if (window.errReport) errReport({ name: 'Вход', message: 'сессия не ответила за ' + ms / 1000 + ' с — взят сохранённый токен' }, 'auth.slow');
        res(sbStoredToken());
      }, ms);
    })
  ]);
}
// Запрос с пределом ожидания: нет ответа за ms — отказ (вызывающий идёт запасным путём) и строка в журнал
function sbWithin(p, ms, what) {
  return new Promise(function(res, rej) {
    var t = setTimeout(function() {
      if (window.errReport) errReport({ name: 'База', message: what + ' не ответил за ' + ms / 1000 + ' с' }, 'slow:' + what);
      rej(new Error(what + ': нет ответа'));
    }, ms);
    Promise.resolve(p).then(function(v) { clearTimeout(t); res(v); }, function(e) { clearTimeout(t); rej(e); });
  });
}
