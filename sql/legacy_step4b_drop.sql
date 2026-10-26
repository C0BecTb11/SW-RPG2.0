-- ============================================================================
-- Удаление старого пошагового кода, шаг 4б, этап B (26.10.2026): таблицы, колонки, триггеры и настройки
-- старого абордажа, дозора, луча захвата, контроля разума, эффектов и способностей пошагового боя.
-- Вставить целиком в Supabase → SQL Editor и выполнить. Одна транзакция: при любой ошибке ничего не удаляется.
--
-- Запускать после этапа A (sql/legacy_step4b_patch.sql, миграция legacy_step4b_patch — живые функции уже
-- не читают эти таблицы и колонки) и после выхода сайта, где флот на орбите больше не запрашивает
-- ships.boarding_eff (space/space.js?v=38).
--
-- Что удаляется:
--   триггеры ships_boarding_gone, unit_positions_boarding_hold, ships_ow_autoclear, unit_positions_ow_autoclear;
--   14 функций: boarding_ship_gone, boarding_hold_guard, boarding_finish, boarding_blow_ship,
--     boarding_capture_ship, boarding_clear_units, boarding_drop_cargo, boarding_kill, boarding_set_eff,
--     boarding_stat, boarding_zone, ow_autoclear_ship, ow_autoclear_unit, artillery_strike;
--   9 таблиц: boarding_units, boardings, deck_templates, unit_effects, unit_ability_uses, hero_ability_uses,
--     unit_type_abilities, abilities, player_characters;
--   колонки ships: overwatch, ow_hit, ow_shot_at, ow_target, tractor_by, tractor_until, tractor_used_at, boarding_eff;
--   колонки unit_positions: overwatch, ow_hit, ow_shot_at, ow_target, control_until, orig_faction, controller_hero_id;
--   26 настроек game_settings (boarding_*, tractor_*, mind_control_seconds, способности и эффекты пошагового боя).
-- Остаются: ap/ap_updated_at (автоход и NPC), boarding_drop_ship (разборка трофея), заглушки
--   ship_active_boarding, effect_value, assert_unit_can_act, hero_abilities (древо героя).
--
-- Перед удалением скрипт сам проверяет: этап A применён; ни одна оставшаяся функция не читает удаляемое
-- и не вызывает удаляемые функции; их не зовут cron и чужие триггеры; таблицы абордажа и эффектов пусты,
-- колонки пусты. Иначе — ошибка с именами, и ничего не удаляется.
-- ============================================================================
begin;

do $$
declare
  dead_fn text[] := array['boarding_ship_gone','boarding_hold_guard','boarding_finish','boarding_blow_ship',
    'boarding_capture_ship','boarding_clear_units','boarding_drop_cargo','boarding_kill','boarding_set_eff',
    'boarding_stat','boarding_zone','ow_autoclear_ship','ow_autoclear_unit','artillery_strike'];
  dead_trg text[] := array['ships_boarding_gone','unit_positions_boarding_hold','ships_ow_autoclear','unit_positions_ow_autoclear'];
  -- порядок важен: сначала те, что ссылаются на другие
  dead_tab text[] := array['boarding_units','boardings','deck_templates','unit_effects','unit_ability_uses',
    'hero_ability_uses','unit_type_abilities','abilities','player_characters'];
  empty_tab text[] := array['boarding_units','boardings','unit_effects','unit_ability_uses','hero_ability_uses'];
  ship_cols text[] := array['overwatch','ow_hit','ow_shot_at','ow_target','tractor_by','tractor_until','tractor_used_at','boarding_eff'];
  unit_cols text[] := array['overwatch','ow_hit','ow_shot_at','ow_target','control_until','orig_faction','controller_hero_id'];
  dead_keys text[] := array['boarding_alarm_seconds','boarding_bridge_seconds','boarding_bridge_seconds_flagship',
    'boarding_charge_seconds','boarding_drill_action_seconds','boarding_drill_bridge_seconds','boarding_medbay_heal',
    'boarding_minutes','boarding_open','boarding_testers','boarding_turret_accuracy','boarding_turret_damage',
    'boarding_turret_hp','boarding_turret_seconds','boarding_vent_damage','boarding_vent_seconds',
    'tractor_cooldown_seconds','tractor_hold_seconds','mind_control_seconds','ability_cooldown_seconds',
    'stun_seconds','suppress_seconds','hero_fear_seconds','hero_stun_seconds','hero_barrier_seconds','twin_shot_radius'];
  names_re text := '(\mboardings\M|boarding_units|deck_templates|unit_effects|unit_ability_uses|hero_ability_uses'
    || '|player_characters|\mabilities\M|unit_type_abilities|\moverwatch\M|\mow_(hit|shot_at|target)\M|tractor_by'
    || '|tractor_until|tractor_used_at|boarding_eff|control_until|orig_faction|controller_hero_id)';
  v text; r record; t text; c text; n_fn integer := 0; n_key integer := 0;
begin
  -- 0) этап A применён
  if (select p.prosrc from pg_proc p where p.oid = 'public.ship_active_boarding(uuid)'::regprocedure) !~ 'null::uuid' then
    raise exception 'Сначала этап A: sql/legacy_step4b_patch.sql';
  end if;

  -- 1) оставшиеся функции не читают удаляемое (rt_battle_guard_ref — только имя таблицы в своей ветке триггера)
  select string_agg(distinct p.proname, ', ') into v from pg_proc p
   where p.pronamespace = 'public'::regnamespace and not (p.proname = any(dead_fn))
     and p.proname <> 'rt_battle_guard_ref' and p.prosrc ~ names_re;
  if v is not null then raise exception 'Удаляемое ещё читают функции: %', v; end if;
  -- …и не вызывают удаляемые функции
  select string_agg(distinct p.proname || ' → ' || d, ', ') into v
    from pg_proc p, unnest(dead_fn) d
   where p.pronamespace = 'public'::regnamespace and not (p.proname = any(dead_fn))
     and p.prosrc ~ ('\m' || d || '\s*\(');
  if v is not null then raise exception 'Удаляемые функции ещё вызывают: %', v; end if;
  select string_agg(j.jobname, ', ') into v from cron.job j, unnest(dead_fn) d where j.command ~ ('\m' || d || '\M');
  if v is not null then raise exception 'Удаляемые функции зовёт cron: %', v; end if;
  select string_agg(tg.tgname, ', ') into v from pg_trigger tg join pg_proc p on p.oid = tg.tgfoid
   where p.proname = any(dead_fn) and not (tg.tgname = any(dead_trg));
  if v is not null then raise exception 'Удаляемые функции — у других триггеров: %', v; end if;
  -- настройки никто не читает
  select string_agg(distinct p.proname || ' → ' || k, ', ') into v
    from pg_proc p, unnest(dead_keys) k
   where p.pronamespace = 'public'::regnamespace and not (p.proname = any(dead_fn)) and position(k in p.prosrc) > 0;
  if v is not null then raise exception 'Настройки ещё читают: %', v; end if;

  -- 2) данные: таблицы абордажа и эффектов пусты, колонки пусты
  foreach t in array empty_tab loop
    execute format('select count(*) from public.%I', t) into n_fn;
    if n_fn > 0 then raise exception 'Таблица % не пустая: % строк', t, n_fn; end if;
  end loop;
  n_fn := 0;
  if exists (select 1 from public.ships where overwatch or ow_target is not null or ow_shot_at is not null
               or tractor_by is not null or tractor_until > now() or boarding_eff is not null) then
    raise exception 'В ships есть дозор, луч или абордаж — разобраться перед удалением';
  end if;
  if exists (select 1 from public.unit_positions where overwatch or ow_target is not null or control_until > now()) then
    raise exception 'В unit_positions есть дозор или контроль разума — разобраться перед удалением';
  end if;

  -- 3) удаление
  execute 'drop trigger if exists ships_boarding_gone on public.ships';
  execute 'drop trigger if exists unit_positions_boarding_hold on public.unit_positions';
  execute 'drop trigger if exists ships_ow_autoclear on public.ships';
  execute 'drop trigger if exists unit_positions_ow_autoclear on public.unit_positions';
  for r in select p.oid::regprocedure as sig from pg_proc p
            where p.pronamespace = 'public'::regnamespace and p.proname = any(dead_fn) loop
    execute 'drop function ' || r.sig::text;
    n_fn := n_fn + 1;
  end loop;
  foreach t in array dead_tab loop
    execute format('drop table if exists public.%I', t);
  end loop;
  foreach c in array ship_cols loop
    execute format('alter table public.ships drop column if exists %I', c);
  end loop;
  foreach c in array unit_cols loop
    execute format('alter table public.unit_positions drop column if exists %I', c);
  end loop;
  delete from public.game_settings where key = any(dead_keys);
  get diagnostics n_key = row_count;
  raise notice 'удалено: функций %, таблиц %, колонок %, настроек %', n_fn, array_length(dead_tab, 1),
    array_length(ship_cols, 1) + array_length(unit_cols, 1), n_key;
end $$;

commit;
