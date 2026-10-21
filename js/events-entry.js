/* Кнопка «Ивенты» в нижней панели галактики: переход в лобби (game/events.html) и значок —
 * «!» найден бой, точка — стоишь в очереди. Найден бой — всплывашка с переходом. ES5.
 */
(function() {
  'use strict';
  var shown = null;
  function badge(st) {
    var b = document.getElementById('events-badge'); if (!b) return;
    if (st && st.match) { b.textContent = '!'; b.style.display = 'block'; b.style.background = '#5fd968'; }
    else if (st && st.queue) { b.textContent = '•'; b.style.display = 'block'; b.style.background = '#d9a940'; }
    else b.style.display = 'none';
    if (st && st.match && shown !== st.match.id) {
      shown = st.match.id;
      var go = function() { location.href = 'event-battle.html?m=' + encodeURIComponent(st.match.id); };
      if (typeof gameConfirm === 'function') gameConfirm({ tone: 'build', kicker: 'Ивент', title: 'Бой найден', sub: 'Игроки собраны — бой ждёт тебя', ok: 'В бой', cancel: 'Позже' }, go);
      else go();
    }
  }
  function check() {
    if (document.hidden || !window.supabase || !supabase.rpc) return;
    supabase.rpc('event_status').then(function(r) { if (!r.error) badge(r.data); }, function() {});
  }
  document.addEventListener('DOMContentLoaded', function() {
    var btn = document.getElementById('panel-item-events');
    if (btn) btn.addEventListener('click', function() { location.href = 'events.html'; });
    setTimeout(check, 2500);
    setInterval(check, 15000);
  });
})();
