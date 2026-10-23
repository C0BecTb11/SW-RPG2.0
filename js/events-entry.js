/* Кнопка «Ивенты» в нижней панели галактики: переход в лобби (game/events.html) и значок —
 * «!» зелёный — найден бой, «!» золотой — идёт сбор (нужно «Готов»), точка золотая — записан,
 * точка синяя — ивент дня открыт (18–23 по серверу) и победа за сегодня ещё не получена.
 * Найден бой или начался сбор — всплывашка. ES5.
 */
(function() {
  'use strict';
  var shown = null, called = null;
  function go(id) { location.href = 'event-battle.html?m=' + encodeURIComponent(id); }
  function badge(st) {
    var b = document.getElementById('events-badge'); if (!b) return;
    var q = st && st.queue, call = q && q.call, open = st && st.today && st.today.open && !(st.paid && st.paid.win);
    if (st && st.match) { b.textContent = '!'; b.style.display = 'block'; b.style.background = '#5fd968'; }
    else if (call && !call.me_ready) { b.textContent = '!'; b.style.display = 'block'; b.style.background = '#f0c86a'; }
    else if (q) { b.textContent = '•'; b.style.display = 'block'; b.style.background = '#d9a940'; }
    else if (open) { b.textContent = '•'; b.style.display = 'block'; b.style.background = '#4a90d9'; }
    else b.style.display = 'none';
    if (st && st.match && shown !== st.match.id) {
      shown = st.match.id;
      if (typeof gameConfirm === 'function') gameConfirm({ tone: 'build', kicker: 'Ивент', title: 'Бой найден', sub: 'Игроки собраны — бой ждёт тебя', ok: 'В бой', cancel: 'Позже' }, function() { go(st.match.id); });
      else go(st.match.id);
      return;
    }
    // сбор: подтвердить можно прямо из галактики
    if (call && !call.me_ready && called !== call.at) {
      called = call.at;
      var ready = function() {
        supabase.rpc('event_ready').then(function(r) {
          if (r.error) { location.href = 'events.html'; return; }
          if (r.data && r.data.match) go(r.data.match.id); else { badge(r.data); setTimeout(check, 2000); }
        }, function() { location.href = 'events.html'; });
      };
      try { if (navigator.vibrate) navigator.vibrate([120, 80, 120]); } catch (e) {}
      if (typeof gameConfirm === 'function') gameConfirm({ tone: 'build', kicker: 'Ивент дня', title: call.mode === 'bots' ? 'Бой с ботами' : 'Сбор!', sub: 'Все записанные на месте — подтверди за 2 минуты, иначе запись снимется', ok: 'Готов', cancel: 'Позже' }, ready);
      else location.href = 'events.html';
    }
  }
  var fast = false;
  function check() {
    if (document.hidden || !window.supabase || !supabase.rpc) return;
    supabase.rpc('event_status').then(function(r) { if (!r.error) { badge(r.data); fast = !!(r.data && r.data.queue); } }, function() {});
  }
  document.addEventListener('DOMContentLoaded', function() {
    var btn = document.getElementById('panel-item-events');
    if (btn) btn.addEventListener('click', function() { location.href = 'events.html'; });
    setTimeout(check, 2500);
    // записан — проверяем чаще: сбор длится всего 2 минуты
    var n = 0;
    setInterval(function() { n++; if (fast || n % 3 === 0) check(); }, 5000);
  });
})();
