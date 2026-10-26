-- ============================================================================
-- Удаление старого пошагового кода, шаг 4а: функции базы, которые никто не вызывает (26.10.2026).
-- Вставить целиком в Supabase → SQL Editor и выполнить. Одна транзакция: при любой ошибке ничего не удаляется.
--
-- Список посчитан по графу вызовов (1737 связей между 716 функциями) от всех корней: cron, триггеры, правила
-- доступа, умолчания и ограничения колонок, представления, вызовы из клиента и сервера боёв после чистки
-- клиента (#132). Это старые пошаговые механики: атаки, ход, разворот, способности, очки действий, дозор,
-- луч захвата, выпуск и возврат истребителей, старый абордаж, старый автоход игрока, первая версия API боёв.
-- Оставлены намеренно: разведчик (переносится в 2.0), спящие налёты на участки, ручные dev-функции,
-- ship_active_boarding, move_ship и spend_ship_action (автоход снабжения), всё, что зовут живые функции.
--
-- Перед удалением скрипт сам проверяет, что ни одна оставшаяся функция, задача cron или триггер не вызывает
-- удаляемые (иначе — ошибка с именами, и ничего не удаляется). Также удаляется пустая таблица
-- commander_inventory (0 строк, к ней не обращается ни одна функция и ни один файл).
-- ============================================================================
begin;

do $$
declare
  dead text[] := array['apply_ship_damage','assert_target_visible','attack_ship','attack_structure','attack_unit','automove_group_finish','board_carrier','boarding_actor','boarding_alarm','boarding_allowed','boarding_apply_shot','boarding_approach','boarding_armory','boarding_bridge_need','boarding_charge','boarding_combat','boarding_cover','boarding_door','boarding_edge_open','boarding_free_near','boarding_fx','boarding_geo','boarding_gun_blocked','boarding_los','boarding_los_step','boarding_move','boarding_pass','boarding_probe_noop','boarding_reach','boarding_reinforce','boarding_reinforce_def','boarding_shoot','boarding_step_ok','boarding_sync','boarding_tick','boarding_turret_hp','boarding_vent','boarding_watch','boarding_weld','boarding_withdraw','can_see_space','cancel_auto_move','deploy_used','disembark_carrier','extract_tick','get_ability_targets','get_attack_targets','get_boardable_units','get_boarding','get_boarding_drill','get_boarding_targets','get_capture_state','get_carriers_nearby','get_deploy_space','get_ground_targets','get_hero_ability_list','get_hero_kills','get_lift_carriers','get_move_candidates','get_my_auto_moves','get_my_vision','get_pickup_ready_ships','get_player_stats','get_recall_carriers','get_ship_abilities','get_structure_targets','get_system_boardings','get_tractor_targets','get_twin_candidates','get_unit_abilities','get_unit_upgrade_abilities','has_effect','is_captured_building','launch_fighter','lift_fighter','overwatch_fire_ship','overwatch_fire_unit','overwatch_tick','recall_fighter','release_mind_control','rotate_ship','rt_battle_beat','rt_battle_close','rt_battle_open','rt_obj_busy_old','set_overwatch','ship_ap_state','ship_boarding_template','ship_gap','ship_hit_arc','ship_hit_arc_roll','ship_is_flying','ship_shields','start_auto_move','start_boarding','unit_ap_state','unit_box_gap','unit_move_kind','use_ability','use_hero_ability','use_tractor','use_unit_ability'];
  v text; r record; n integer := 0;
begin
  -- 1) вызовы из оставшихся функций (вызов — имя и открывающая скобка)
  select string_agg(distinct p.proname || ' → ' || d, ', ') into v
    from pg_proc p, unnest(dead) d
   where p.pronamespace = 'public'::regnamespace and not (p.proname = any(dead))
     and p.prosrc ~ ('\m' || d || '\s*\(');
  if v is not null then raise exception 'Удаляемые функции ещё вызывают: %', v; end if;
  -- 2) cron и триггеры
  select string_agg(j.jobname, ', ') into v from cron.job j, unnest(dead) d where j.command ~ ('\m' || d || '\M');
  if v is not null then raise exception 'Удаляемые функции зовёт cron: %', v; end if;
  select string_agg(t.tgname, ', ') into v from pg_trigger t join pg_proc p on p.oid = t.tgfoid where p.proname = any(dead);
  if v is not null then raise exception 'Удаляемые функции — у триггеров: %', v; end if;

  -- удаление: все перегрузки каждой функции
  for r in select p.oid::regprocedure as sig from pg_proc p
            where p.pronamespace = 'public'::regnamespace and p.proname = any(dead) loop
    execute 'drop function ' || r.sig::text;
    n := n + 1;
  end loop;
  raise notice 'удалено функций: %', n;

  -- пустая таблица без читателей
  if exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prosrc like '%commander_inventory%') then
    raise exception 'commander_inventory ещё используется функциями';
  end if;
  if (select count(*) from public.commander_inventory) > 0 then raise exception 'commander_inventory не пустая'; end if;
  execute 'drop table public.commander_inventory';
end $$;

commit;

-- Проверено 26.10.2026 сухим прогоном с откатом: удаляются все 102 функции и таблица, ошибок зависимостей нет.
-- Такты дозора, старого абордажа и контроля разума сняты раньше (миграция legacy_unschedule_ticks):
--   вернуть при необходимости: select cron.schedule('overwatch-tick', '5 seconds', 'select public.overwatch_tick()'); и т. д.
