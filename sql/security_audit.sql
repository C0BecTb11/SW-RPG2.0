-- Аудит прав базы (30.10.2026): что игрок может вызвать или записать мимо игры.
--
-- 1) Служебные функции с security definer, которые клиент не вызывает (их зовут только функции базы,
--    cron и триггеры) — закрыты от игроков. Функции из политик RLS (can_see_*, faction_power) остаются:
--    политики выполняются от имени игрока и без права на них таблицы перестали бы читаться.
-- 2) Права на запись в таблицы: всё пишется через функции базы, RLS и так запрещает прямую запись —
--    права INSERT/UPDATE/DELETE/TRUNCATE у anon и authenticated убраны (вторая линия защиты на случай,
--    если когда-нибудь политика окажется слишком широкой). Оставлено то, что клиент пишет сам:
--    profiles — вставка своей строки при регистрации (id, nickname), system_control — назначение
--    управляющего штабом (js/faction-control.js, политики «Faction staff can …»).

do $do$
declare r record;
  v_internal text[] := array['assert_dock_ready', 'find_spawn_box_near', 'finish_commander_move', 'ge_trade_mod', 'ge_travel_mod',
    'get_hangar', 'has_scout_on', 'is_my_faction_system', 'move_ground_unit', 'move_ship', 'my_faction_powers', 'rt_ground_battle',
    'rt_space_battle', 'spawn_space', 'void_find_open', 'log_control_transfer', 'log_lost_cargo', 'mark_hero_dead',
    'settlement_tasks_on_assign', 'spawn_character_on_faction_assignment', 'unrest_on_capture'];
begin
  for r in select p.oid::regprocedure f from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname = any(v_internal) loop
    execute format('revoke execute on function %s from public, anon, authenticated', r.f);
  end loop;
  -- только для вошедших: без входа эти функции ничего не дают
  for r in select p.oid::regprocedure f from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname in ('get_loadable_ships', 'scrap_trophy') loop
    execute format('revoke execute on function %s from public, anon', r.f);
  end loop;

  for r in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relkind = 'r' loop
    if r.relname = 'profiles' then
      execute format('revoke update, delete, truncate on public.%I from anon, authenticated', r.relname);
    elsif r.relname = 'system_control' then
      execute format('revoke delete, truncate on public.%I from anon, authenticated', r.relname);
      execute format('revoke insert, update on public.%I from anon', r.relname);
    else
      execute format('revoke insert, update, delete, truncate on public.%I from anon, authenticated', r.relname);
    end if;
  end loop;
end $do$;
