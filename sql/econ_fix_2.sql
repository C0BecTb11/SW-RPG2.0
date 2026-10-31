-- Экономика, этап 3: транзакции (аудит claude/econ-audit.md, ECON-BUG-023, 037, 040, 032, попутно 017).
--  023 — возврат 50 % при захвате берёт заказы под блокировкой и перепроверяет «не выдан»: выдача, начатая в ту же секунду,
--        больше не даёт и бойцов (корабль), и половину их цены. То же — возврат за работы дока при захвате корабля в бою 2.0.
--  037 — суточная выплата поселений, старая суточная добыча и сутки полевых построек — каждая планета (здание, постройка)
--        в своей подтранзакции: сбой одной больше не откатывает выплату всем. Повторный запуск в ту же секунду (ручной вызов
--        во время такта) — не платит второй раз (advisory-блокировка такта, строка суток под блокировкой).
--  017 — старая суточная добыча — только зданиям своей фракции (трофей без участка не добывает захватчику).
--  040 — списание кредитов в минус: вместо сырой ошибки ограничения 23514 — «Недостаточно кредитов: не хватает N»
--        (триггер на profiles, одно место на все ~25 функций трат; CHECK остаётся последней страховкой).
--  032 — рейс снабжения кладёт груз в трюм под блокировкой корабля (одновременная ручная погрузка не переполнит трюм).
-- Правки — заменой мест в живых функциях (как в econ_fix_1.sql): место не найдено — ошибка, ничего не меняется.
-- Повторный прогон ничего не делает: функции с меткой econ_fix_2 пропускаются.

create or replace function pg_temp.econ_sub(d text, a text, b text, tag text) returns text
language plpgsql as $f$
begin
  if (length(d) - length(replace(d, a, ''))) / length(a) <> 1 then
    raise exception 'econ_fix_2: место не найдено или не одно — %', tag;
  end if;
  return replace(d, a, b);
end $f$;

-- ===== 023: возврат при захвате планеты =====
do $patch$
declare d text;
begin
  d := pg_get_functiondef('public.refund_pending_on_capture(text)'::regprocedure);
  if position('econ_fix_2' in d) = 0 then
    d := pg_temp.econ_sub(d,
$q$    where uo.system_id = p_system_id and not uo.delivered
  loop$q$,
$q$    where uo.system_id = p_system_id and not uo.delivered
    -- под блокировкой: выдача (deliver_ready_units, skip locked) заказ не возьмёт, а уже начатая — дождётся,
    -- и строка с delivered = true сюда не попадёт (ECON-BUG-023, econ_fix_2)
    for update of uo
  loop$q$,
      'refund: бойцы');
    d := pg_temp.econ_sub(d,
$q$    where ro.system_id = p_system_id and not ro.delivered
  loop$q$,
$q$    where ro.system_id = p_system_id and not ro.delivered
    for update of ro   -- ECON-BUG-023
  loop$q$,
      'refund: ремонт');
    d := pg_temp.econ_sub(d,
$q$    where so.system_id = p_system_id and not so.delivered
  loop$q$,
$q$    where so.system_id = p_system_id and not so.delivered
    for update of so   -- ECON-BUG-023
  loop$q$,
      'refund: корабли');
    execute d;
  end if;
end $patch$;

-- ===== 023: возврат за работы дока при захвате корабля в бою 2.0 =====
do $patch$
declare d text;
begin
  d := pg_get_functiondef('public.rt_space_sync(text,uuid,jsonb,jsonb,jsonb,jsonb,jsonb)'::regprocedure);
  if position('econ_fix_2' in d) = 0 then
    d := pg_temp.econ_sub(d,
$q$    for o in select ro.id, ro.owner_user_id, ro.cost, ro.kind from repair_orders ro where ro.ship_id = r.id and not ro.delivered loop$q$,
$q$    for o in select ro.id, ro.owner_user_id, ro.cost, ro.kind from repair_orders ro where ro.ship_id = r.id and not ro.delivered
             for update of ro loop   -- выданное не возвращается второй раз (ECON-BUG-023, econ_fix_2)$q$,
      'rt_space_sync: возврат дока');
    execute d;
  end if;
end $patch$;

-- ===== 037: суточная выплата поселений =====
do $patch$
declare d text;
begin
  d := pg_get_functiondef('public.settlement_tick()'::regprocedure);
  if position('econ_fix_2' in d) = 0 then
    d := pg_temp.econ_sub(d,
$q$begin
  perform settlement_dev_tick();
$q$,
$q$begin
  -- ручной вызов во время такта не платит второй раз (econ_fix_2)
  if not pg_try_advisory_xact_lock(hashtext('settlement_tick')) then return; end if;
  begin perform settlement_dev_tick(); exception when others then perform err_db('settlement_tick', sqlstate, sqlerrm, true); end;
$q$,
      'settlement_tick: начало');
    d := pg_temp.econ_sub(d,
$q$                 where faction is not null and not is_deep_space loop

    select * into st from settlement_state where system_id = sys.id;
$q$,
$q$                 where faction is not null and not is_deep_space loop
   -- каждая планета — своя подтранзакция: сбой одной не откатывает выплату остальным (ECON-BUG-037)
   begin

    select * into st from settlement_state where system_id = sys.id for update;
$q$,
      'settlement_tick: тело цикла');
    d := pg_temp.econ_sub(d,
$q$    update settlement_state set cycle_started = v_p where system_id = sys.id;
    perform issue_settlement_tasks(sys.id, v_p);
  end loop;
end;$q$,
$q$    update settlement_state set cycle_started = v_p where system_id = sys.id;
    perform issue_settlement_tasks(sys.id, v_p);
   exception when others then
     perform err_db('settlement_tick', sqlstate, sys.id || ': ' || sqlerrm, true);
   end;
  end loop;
end;$q$,
      'settlement_tick: конец цикла');
    execute d;
  end if;
end $patch$;

-- ===== 037 + 017: старая суточная добыча зданий =====
do $patch$
declare d text;
begin
  d := pg_get_functiondef('public.production_tick()'::regprocedure);
  if position('econ_fix_2' in d) = 0 then
    d := pg_temp.econ_sub(d,
$q$begin
  for b in$q$,
$q$begin
  if not pg_try_advisory_xact_lock(hashtext('production_tick')) then return; end if;   -- econ_fix_2
  for b in$q$,
      'production_tick: начало');
    d := pg_temp.econ_sub(d,
$q$      and payout_eligible(bd.built_at, bd.completes_at, v_p)
  loop
    if b.consumes = '{}'::jsonb then$q$,
$q$      and payout_eligible(bd.built_at, bd.completes_at, v_p)
      and bd.faction is not distinct from s.faction   -- трофей без участка не добывает захватчику (ECON-BUG-017)
  loop
   -- каждое здание — своя подтранзакция (ECON-BUG-037)
   begin
    if b.consumes = '{}'::jsonb then$q$,
      'production_tick: тело цикла');
    d := pg_temp.econ_sub(d,
$q$      update buildings set last_extract_at = now() where id = b.id;
    end if;
  end loop;
end;$q$,
$q$      update buildings set last_extract_at = now() where id = b.id;
    end if;
   exception when others then
     perform err_db('production_tick', sqlstate, b.id || ': ' || sqlerrm, true);
   end;
  end loop;
end;$q$,
      'production_tick: конец цикла');
    execute d;
  end if;
end $patch$;

-- ===== 037: сутки полевых построек =====
do $patch$
declare d text;
begin
  d := pg_get_functiondef('public.structures_tick()'::regprocedure);
  if position('econ_fix_2' in d) = 0 then
    d := pg_temp.econ_sub(d,
$q$      and sy.faction = fs.faction and fs.hp > 0
    for update of fs
  loop
    if s.produces_resource is not null and s.produces_per_day > 0 then$q$,
$q$      and sy.faction = fs.faction and fs.hp > 0
    for update of fs
  loop
   -- каждая постройка — своя подтранзакция (ECON-BUG-037, econ_fix_2)
   begin
    if s.produces_resource is not null and s.produces_per_day > 0 then$q$,
      'structures_tick: начало суток');
    d := pg_temp.econ_sub(d,
$q$    update field_structures set last_tick_at = now() where id = s.id;
  end loop;$q$,
$q$    update field_structures set last_tick_at = now() where id = s.id;
   exception when others then
     perform err_db('structures_tick', sqlstate, s.id || ': ' || sqlerrm, true);
   end;
  end loop;$q$,
      'structures_tick: конец суток');
    execute d;
  end if;
end $patch$;

-- ===== 032: рейс снабжения кладёт груз под блокировкой корабля =====
do $patch$
declare d text;
begin
  d := pg_get_functiondef('public.supply_put_cargo(uuid,text,text,integer)'::regprocedure);
  if position('econ_fix_2' in d) = 0 then
    d := pg_temp.econ_sub(d,
$q$  sh record; v_left integer := p_amount; v_fit integer;$q$,
$q$  sh record; v_left integer := p_amount; v_fit integer; v_free integer;$q$,
      'supply_put_cargo: переменные');
    d := pg_temp.econ_sub(d,
$q$  for sh in
    select s.id, st.capacity - ship_load_used(s.id) as free_slots
    from ships s cross join lateral ship_stats(s.id) st
    where s.commander_id = p_commander_id and not s.in_transit and s.system_id = p_here
    order by s.id
  loop
    exit when v_left <= 0;
    v_fit := least(v_left, greatest(0, sh.free_slots) * v_unit);$q$,
$q$  -- корабль под блокировкой, место считается после неё: ручная погрузка в ту же секунду не переполнит трюм
  -- (порядок по id — как в ручных функциях, без взаимоблокировок) (ECON-BUG-032, econ_fix_2)
  for sh in
    select s.id from ships s
    where s.commander_id = p_commander_id and not s.in_transit and s.system_id = p_here
    order by s.id
    for update
  loop
    exit when v_left <= 0;
    select st.capacity - ship_load_used(sh.id) into v_free from ship_stats(sh.id) st;
    v_fit := least(v_left, greatest(0, coalesce(v_free, 0)) * v_unit);$q$,
      'supply_put_cargo: блокировка');
    execute d;
  end if;
end $patch$;

-- ===== 040: понятный отказ вместо ошибки ограничения =====
create or replace function public.profiles_credits_guard() returns trigger
language plpgsql
set search_path to 'public', 'pg_temp'
as $$
begin
  -- трата больше остатка (две траты разом, проверка без блокировки): отказ с понятным текстом;
  -- CHECK profiles_credits_nonneg остаётся последней страховкой (ECON-BUG-040, econ_fix_2)
  if new.credits < 0 and new.credits < old.credits then
    raise exception 'Недостаточно кредитов: не хватает %', - new.credits
      using errcode = 'P0001', hint = 'credits';
  end if;
  return new;
end $$;
revoke all on function public.profiles_credits_guard() from public, anon, authenticated;

do $t$
begin
  if not exists (select 1 from pg_trigger where tgname = 'a_profiles_credits_guard') then
    create trigger a_profiles_credits_guard
      before update of credits on public.profiles
      for each row execute function public.profiles_credits_guard();
  end if;
end $t$;
