-- ============================================================================
-- Удаление старого кода, шаг 5.6, этап B (26.10.2026): заглушки и остатки, которые больше никто не зовёт.
-- Вставить целиком в Supabase → SQL Editor и выполнить. Одна транзакция: при любой ошибке ничего не удаляется.
--
-- Запускать после этапа A (sql/deadcode_5_db_patch.sql, миграция deadcode_5_db_patch — живые функции уже
-- не зовут заглушки) и после выхода сайта, где список процессов не зовёт get_my_processes (js/processes.js).
--
-- Что удаляется:
--   функции: assert_unit_can_act(uuid), ship_active_boarding(uuid), effect_value(uuid,text) — заглушки
--     старого боя; get_my_processes() — первая версия списка процессов (есть v2);
--     duel_upsert(…, p_ow boolean) — старая подпись (новая, без дозора, уже работает);
--   настройки game_settings без читателей: capture_tick_seconds, deploy_capacity, extract_primary_per_day,
--     extract_secondary_per_day, max_units_per_order;
--   колонка unit_positions.orig_owner_user_id (остаток контроля разума, пустая).
-- Скрипт сам проверяет, что этап A применён, удаляемых функций никто не зовёт (функции, cron, триггеры),
-- настройки и колонку никто не читает, колонка пустая. Иначе — ошибка с именами, и ничего не удаляется.
-- ============================================================================
begin;

do $$
declare
  dead_fn text[] := array['assert_unit_can_act', 'ship_active_boarding', 'effect_value', 'get_my_processes'];
  dead_keys text[] := array['capture_tick_seconds', 'deploy_capacity', 'extract_primary_per_day', 'extract_secondary_per_day', 'max_units_per_order'];
  v text; r record; n integer := 0;
begin
  -- 0) этап A: новая duel_upsert есть, duel_log зовёт её
  if to_regprocedure('public.duel_upsert(uuid,text,jsonb,jsonb,text,boolean,integer,boolean)') is null then
    raise exception 'Сначала этап A: sql/deadcode_5_db_patch.sql';
  end if;
  if (select prosrc from pg_proc where oid = 'public.duel_log(text,uuid,uuid,boolean,integer,boolean)'::regprocedure) ~ 'v_ow' then
    raise exception 'Сначала этап A: duel_log ещё старая';
  end if;

  -- 1) удаляемые функции никто не зовёт
  select string_agg(distinct p.proname || ' → ' || d, ', ') into v
    from pg_proc p, unnest(dead_fn) d
   where p.pronamespace = 'public'::regnamespace and not (p.proname = any(dead_fn))
     and p.prosrc ~ ('\m' || d || '\s*\(');
  if v is not null then raise exception 'Удаляемые функции ещё вызывают: %', v; end if;
  select string_agg(j.jobname, ', ') into v from cron.job j, unnest(dead_fn) d where j.command ~ ('\m' || d || '\M');
  if v is not null then raise exception 'Удаляемые функции зовёт cron: %', v; end if;
  select string_agg(t.tgname, ', ') into v from pg_trigger t join pg_proc p on p.oid = t.tgfoid where p.proname = any(dead_fn);
  if v is not null then raise exception 'Удаляемые функции — у триггеров: %', v; end if;
  -- старая duel_upsert: вызовов с 9 аргументами (p_ow) не осталось
  select string_agg(p.proname, ', ') into v from pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.proname <> 'duel_upsert' and p.prosrc ~ 'duel_upsert\s*\(([^;]*,){8}[^;]*\)';
  if v is not null then raise exception 'Старую duel_upsert (9 аргументов) ещё вызывают: %', v; end if;

  -- 2) настройки и колонку никто не читает, колонка пустая
  select string_agg(distinct p.proname || ' → ' || k, ', ') into v
    from pg_proc p, unnest(dead_keys) k
   where p.pronamespace = 'public'::regnamespace and position(k in p.prosrc) > 0;
  if v is not null then raise exception 'Настройки ещё читают: %', v; end if;
  select string_agg(p.proname, ', ') into v from pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.prosrc like '%orig_owner_user_id%';
  if v is not null then raise exception 'orig_owner_user_id ещё читают: %', v; end if;
  if exists (select 1 from public.unit_positions where orig_owner_user_id is not null) then
    raise exception 'unit_positions.orig_owner_user_id не пустая';
  end if;

  -- 3) удаление
  for r in select p.oid::regprocedure as sig from pg_proc p
            where p.pronamespace = 'public'::regnamespace and p.proname = any(dead_fn) loop
    execute 'drop function ' || r.sig::text;
    n := n + 1;
  end loop;
  execute 'drop function public.duel_upsert(uuid,text,jsonb,jsonb,text,boolean,integer,boolean,boolean)';
  n := n + 1;
  delete from public.game_settings where key = any(dead_keys);
  alter table public.unit_positions drop column orig_owner_user_id;
  raise notice 'удалено функций: %, настройки и колонка — тоже', n;
end $$;

commit;
