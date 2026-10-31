-- Экономика, этап 1–2 (аудит claude/econ-audit.md, ECON-BUG-004, 005, 007, 009, 012, 016, 018, 022, 024, 030, 033).
--  004 — во время захвата склад остаётся захватчику: нельзя продать посту, выставить на торги, погрузить в корабль,
--        вывезти рейсом снабжения и забрать с него купленное (решение Артёма 31.10: «запретить всё»).
--  005 — управляющего не меняют, пока идёт захват: прямая запись в system_control обходила запрет leader_revoke_planet.
--  007 — верх цены лота: base_price × market_max_price_x (20).
--  009 — количество NULL отсекается явно, а не побочным NOT NULL.
--  012 — задачу поселения прошлых суток оплатить нельзя (деньги списывались без зачёта).
--  016 — снос участка добычи или цеха: смена закрывается, склад участка — на склад планеты целиком, даже сверх предела
--        (решение Артёма 31.10: ресурсы при сносе и захвате с планеты не исчезают).
--  018 — цех: неизрасходованное сырьё возвращается на склад целиком, даже сверх предела (оно лежало там до смены).
--  022 — неизвестные и повторные id дополнений в order_ship / start_ship_refit — отказ, как в order_unit.
--  024 — станцию не снести, пока в доке идут работы.
--  030 — трюм корабля в живом бою 2.0 не перекладывают (погрузка, выгрузка, вывоз покупки).
--  033 — тот же ресурс докладывается в начатый слот (половинки слотов).
-- Правки — заменой мест в живых функциях (как в space_fix_*.sql): место не найдено — ошибка, ничего не меняется.
-- Повторный прогон ничего не делает: функции с меткой econ_fix_1 пропускаются.

create or replace function pg_temp.econ_sub(d text, a text, b text, tag text) returns text
language plpgsql as $f$
begin
  if (length(d) - length(replace(d, a, ''))) / length(a) <> 1 then
    raise exception 'econ_fix_1: место не найдено или не одно — %', tag;
  end if;
  return replace(d, a, b);
end $f$;

-- ===== 004 + 009: торговый пост =====
do $patch$
declare d text;
begin
  d := pg_get_functiondef('public.sell_to_trade_post(text,text,integer)'::regprocedure);
  if position('econ_fix_1' in d) = 0 then
    d := pg_temp.econ_sub(d,
$q$  if p_amount < 1 then raise exception 'Некорректное количество'; end if;$q$,
$q$  if p_amount is null or p_amount < 1 then raise exception 'Некорректное количество'; end if;   -- econ_fix_1$q$,
      'sell_to_trade_post: количество');
    d := pg_temp.econ_sub(d,
$q$    raise exception 'Планета не под твоим контролем';
  end if;$q$,
$q$    raise exception 'Планета не под твоим контролем';
  end if;
  -- захват: склад достаётся захватчику, распродать его посту нельзя (ECON-BUG-004)
  if is_capture_active(p_system_id) then
    raise exception 'На планете идёт захват — склад закрыт, пока он не кончится';
  end if;$q$,
      'sell_to_trade_post: захват');
    execute d;
  end if;
end $patch$;

-- ===== 004 + 007: лот рынка =====
do $patch$
declare d text;
begin
  d := pg_get_functiondef('public.create_market_lot(text,text,integer,integer,text)'::regprocedure);
  if position('econ_fix_1' in d) = 0 then
    d := pg_temp.econ_sub(d,
$q$  if p_open_to not in ('faction', 'all') then$q$,
$q$  -- верх цены: лот по миллиарду никто не купит, а место на торгах он занимает (ECON-BUG-007, econ_fix_1)
  if p_price > coalesce((select base_price from resources where id = p_resource), 10) * game_setting_int('market_max_price_x', 20) then
    raise exception 'Цена не может быть больше %',
      coalesce((select base_price from resources where id = p_resource), 10) * game_setting_int('market_max_price_x', 20);
  end if;
  if p_open_to not in ('faction', 'all') then$q$,
      'create_market_lot: цена');
    d := pg_temp.econ_sub(d,
$q$    raise exception 'Планета не под твоим контролем';
  end if;$q$,
$q$    raise exception 'Планета не под твоим контролем';
  end if;
  -- захват: склад достаётся захватчику, на торги его не выставить (ECON-BUG-004)
  if is_capture_active(p_system_id) then
    raise exception 'На планете идёт захват — склад закрыт, пока он не кончится';
  end if;$q$,
      'create_market_lot: захват');
    execute d;
  end if;
end $patch$;

-- ===== 004 + 030 + 033: погрузка со склада =====
do $patch$
declare d text;
begin
  d := pg_get_functiondef('public.load_resource_to_ship(uuid,text,integer)'::regprocedure);
  if position('econ_fix_1' in d) = 0 then
    d := pg_temp.econ_sub(d,
$q$  if s.in_transit then raise exception 'Корабль в гиперпространстве'; end if;$q$,
$q$  if s.in_transit then raise exception 'Корабль в гиперпространстве'; end if;
  -- живой бой 2.0: трюм не перекладывают, пока стычка не кончится (ECON-BUG-030, econ_fix_1)
  if rt_obj_busy_2_0('ship', p_ship_id) is not null then
    raise exception 'Корабль в бою — груз перекладывают, когда стычка кончится' using errcode = 'P0001', hint = 'rt_busy';
  end if;$q$,
      'load_resource_to_ship: бой');
    d := pg_temp.econ_sub(d,
$q$    raise exception 'Планета не под твоим контролем';
  end if;$q$,
$q$    raise exception 'Планета не под твоим контролем';
  end if;
  -- захват: склад достаётся захватчику, вывезти его нельзя (ECON-BUG-004)
  if is_capture_active(s.system_id) then
    raise exception 'На планете идёт захват — склад закрыт, пока он не кончится';
  end if;$q$,
      'load_resource_to_ship: захват');
    d := pg_temp.econ_sub(d,
$q$  v_need := resource_slots(p_amount);$q$,
$q$  -- тот же ресурс докладывается в начатый слот (ECON-BUG-033)
  v_need := resource_slots(coalesce((select amount from ship_resource_cargo where ship_id = p_ship_id and resource = p_resource), 0) + p_amount)
          - resource_slots(coalesce((select amount from ship_resource_cargo where ship_id = p_ship_id and resource = p_resource), 0));$q$,
      'load_resource_to_ship: слоты');
    execute d;
  end if;
end $patch$;

-- ===== 030: выгрузка на склад =====
do $patch$
declare d text;
begin
  d := pg_get_functiondef('public.unload_resource_from_ship(uuid,text,integer)'::regprocedure);
  if position('econ_fix_1' in d) = 0 then
    d := pg_temp.econ_sub(d,
$q$  if s.in_transit then raise exception 'Корабль в гиперпространстве'; end if;$q$,
$q$  if s.in_transit then raise exception 'Корабль в гиперпространстве'; end if;
  -- живой бой 2.0: трюм не перекладывают, пока стычка не кончится (ECON-BUG-030, econ_fix_1)
  if rt_obj_busy_2_0('ship', p_ship_id) is not null then
    raise exception 'Корабль в бою — груз перекладывают, когда стычка кончится' using errcode = 'P0001', hint = 'rt_busy';
  end if;$q$,
      'unload_resource_from_ship: бой');
    execute d;
  end if;
end $patch$;

-- ===== 004 + 009 + 030 + 033: вывоз покупки своим кораблём =====
do $patch$
declare d text;
begin
  d := pg_get_functiondef('public.load_market_order(uuid,uuid,integer)'::regprocedure);
  if position('econ_fix_1' in d) = 0 then
    d := pg_temp.econ_sub(d,
$q$  if p_amount < 1 then raise exception 'Некорректное количество'; end if;$q$,
$q$  if p_amount is null or p_amount < 1 then raise exception 'Некорректное количество'; end if;   -- econ_fix_1$q$,
      'load_market_order: количество');
    d := pg_temp.econ_sub(d,
$q$  select * into l from market_lots where id = o.lot_id;$q$,
$q$  select * into l from market_lots where id = o.lot_id;
  -- захват: товар лота при захвате возвращается на склад планеты — вывозить его нельзя (ECON-BUG-004)
  if is_capture_active(l.system_id) then
    raise exception 'На планете идёт захват — склад закрыт, пока он не кончится';
  end if;$q$,
      'load_market_order: захват');
    d := pg_temp.econ_sub(d,
$q$  if s.in_transit then raise exception 'Корабль в гиперпространстве'; end if;$q$,
$q$  if s.in_transit then raise exception 'Корабль в гиперпространстве'; end if;
  -- живой бой 2.0: трюм не перекладывают, пока стычка не кончится (ECON-BUG-030)
  if rt_obj_busy_2_0('ship', p_ship_id) is not null then
    raise exception 'Корабль в бою — груз перекладывают, когда стычка кончится' using errcode = 'P0001', hint = 'rt_busy';
  end if;$q$,
      'load_market_order: бой');
    d := pg_temp.econ_sub(d,
$q$  v_need := resource_slots(p_amount);$q$,
$q$  -- тот же ресурс докладывается в начатый слот (ECON-BUG-033)
  v_need := resource_slots(coalesce((select amount from ship_resource_cargo where ship_id = p_ship_id and resource = l.resource), 0) + p_amount)
          - resource_slots(coalesce((select amount from ship_resource_cargo where ship_id = p_ship_id and resource = l.resource), 0));$q$,
      'load_market_order: слоты');
    execute d;
  end if;
end $patch$;

-- ===== 009: покупка лота =====
do $patch$
declare d text;
begin
  d := pg_get_functiondef('public.buy_market_lot(uuid,integer)'::regprocedure);
  if position('econ_fix_1' in d) = 0 then
    d := pg_temp.econ_sub(d,
$q$  if p_amount < 1 then raise exception 'Некорректное количество'; end if;$q$,
$q$  if p_amount is null or p_amount < 1 then raise exception 'Некорректное количество'; end if;   -- econ_fix_1$q$,
      'buy_market_lot: количество');
    execute d;
  end if;
end $patch$;

-- ===== 004: рейс снабжения забирает покупку =====
do $patch$
declare d text;
begin
  d := pg_get_functiondef('public.supply_pickup_load(uuid,text,uuid)'::regprocedure);
  if position('econ_fix_1' in d) = 0 then
    d := pg_temp.econ_sub(d,
$q$  select * into l from market_lots where id = o.lot_id;$q$,
$q$  select * into l from market_lots where id = o.lot_id;
  -- захват: товар лота при захвате возвращается на склад планеты — рейс его не забирает (ECON-BUG-004, econ_fix_1)
  if is_capture_active(l.system_id) then
    perform supply_log(r.id, p_here, 'Идёт захват — склад закрыт, покупку не забрать · ' || coalesce(v_sys, p_here), 0);
    return 0;
  end if;$q$,
      'supply_pickup_load: захват');
    execute d;
  end if;
end $patch$;

-- ===== 004: рейс снабжения грузит со склада =====
do $patch$
declare d text;
begin
  d := pg_get_functiondef('public.supply_stop_actions(uuid,text)'::regprocedure);
  if position('econ_fix_1' in d) = 0 then
    d := pg_temp.econ_sub(d,
$q$    if a ->> 'op' = 'load' then
      perform 1 from planet_stock ps where ps.system_id = p_here and ps.resource = v_res for update;$q$,
$q$    if a ->> 'op' = 'load' then
      -- захват: склад достаётся захватчику, рейс не грузит (ECON-BUG-004, econ_fix_1)
      if is_capture_active(p_here) then
        if not v_quiet then
          perform supply_log(r.id, p_here, 'Идёт захват — погрузка остановлена · ' || v_sys_name, 0);
        end if;
        continue;
      end if;
      perform 1 from planet_stock ps where ps.system_id = p_here and ps.resource = v_res for update;$q$,
      'supply_stop_actions: захват');
    execute d;
  end if;
end $patch$;

-- ===== 022: дополнения корабля на верфи =====
do $patch$
declare d text;
begin
  d := pg_get_functiondef('public.order_ship(text,text,integer,integer,text[])'::regprocedure);
  if position('econ_fix_1' in d) = 0 then
    d := pg_temp.econ_sub(d,
$q$  select r.name into v_missing
  from unnest(coalesce(p_upgrades, '{}')) u
  join researches r on r.id = u
  where not exists ($q$,
$q$  -- неизвестные и повторные id не видит ни одна проверка ниже, а время шло по длине списка (ECON-BUG-022, econ_fix_1)
  if exists (select 1 from unnest(coalesce(p_upgrades, '{}')) u2
             where not exists (select 1 from researches r2 where r2.id = u2)) then
    raise exception 'Неизвестное дополнение';
  end if;
  if (select count(*) <> count(distinct u3) from unnest(coalesce(p_upgrades, '{}')) u3) then
    raise exception 'Дополнение указано дважды';
  end if;

  select r.name into v_missing
  from unnest(coalesce(p_upgrades, '{}')) u
  join researches r on r.id = u
  where not exists ($q$,
      'order_ship: дополнения');
    execute d;
  end if;
end $patch$;

do $patch$
declare d text;
begin
  d := pg_get_functiondef('public.start_ship_refit(uuid,text[])'::regprocedure);
  if position('econ_fix_1' in d) = 0 then
    d := pg_temp.econ_sub(d,
$q$  if v_n = 0 then raise exception 'Не выбрано ни одного улучшения'; end if;$q$,
$q$  if v_n = 0 then raise exception 'Не выбрано ни одного улучшения'; end if;
  -- неизвестные и повторные id: цена шла по найденным темам, время — по длине списка (ECON-BUG-022, econ_fix_1)
  if exists (select 1 from unnest(p_upgrades) u2
             where not exists (select 1 from researches r2 where r2.id = u2)) then
    raise exception 'Неизвестное дополнение';
  end if;
  if (select count(*) <> count(distinct u3) from unnest(p_upgrades) u3) then
    raise exception 'Дополнение указано дважды';
  end if;$q$,
      'start_ship_refit: дополнения');
    execute d;
  end if;
end $patch$;

-- ===== 012: задачи поселения прошлых суток =====
do $patch$
declare d text;
begin
  d := pg_get_functiondef('public.settlement_pay_task(uuid)'::regprocedure);
  if position('econ_fix_1' in d) = 0 then
    d := pg_temp.econ_sub(d,
$q$  if t.done then raise exception 'Уже выполнено'; end if;$q$,
$q$  if t.done then raise exception 'Уже выполнено'; end if;
  -- зачёт идёт только за текущие сутки: старая задача съела бы деньги впустую (ECON-BUG-012, econ_fix_1)
  if not exists (select 1 from settlement_state st
                 where st.system_id = t.system_id and st.cycle_started = t.cycle_start) then
    raise exception 'Срок этой задачи вышел — обнови окно поселения';
  end if;$q$,
      'settlement_pay_task: сутки');
    execute d;
  end if;
end $patch$;

-- ===== 024: снос станции при работах в доке =====
do $patch$
declare d text;
begin
  d := pg_get_functiondef('public.demolish_space_station(text)'::regprocedure);
  if position('econ_fix_1' in d) = 0 then
    d := pg_temp.econ_sub(d,
$q$    raise exception 'Сначала дождись схода корабля со стапеля';
  end if;$q$,
$q$    raise exception 'Сначала дождись схода корабля со стапеля';
  end if;
  -- док: ремонт, модернизация и пополнение ангара ещё идут (ECON-BUG-024, econ_fix_1)
  if exists (select 1 from repair_orders ro
             where ro.system_id = p_system_id and ro.kind in ('ship', 'refit', 'hangar') and not ro.delivered) then
    raise exception 'Сначала дождись конца работ в доке';
  end if;$q$,
      'demolish_space_station: док');
    execute d;
  end if;
end $patch$;

-- ===== 016: снос участка добычи или цеха =====
do $patch$
declare d text;
begin
  d := pg_get_functiondef('public.demolish_building(uuid)'::regprocedure);
  if position('econ_fix_1' in d) = 0 then
    d := pg_temp.econ_sub(d,
$q$  v_cost integer; v_half integer; v_pending integer; v_credits integer;$q$,
$q$  v_cost integer; v_half integer; v_pending integer; v_credits integer;
  v_shift uuid; v_ms record;   -- econ_fix_1$q$,
      'demolish_building: переменные');
    d := pg_temp.econ_sub(d,
$q$  if v_bld_faction is distinct from v_sys_faction then$q$,
$q$  -- участок добычи или цех: смена закрывается, склад участка уходит на склад планеты целиком, даже сверх предела —
  -- ресурсы при сносе, как и при захвате, остаются на планете (ECON-BUG-016)
  for v_shift in select id from mine_shifts where building_id = p_building_id and status = 'run' loop
    perform mine_finish(v_shift, case when v_bld_faction is distinct from v_sys_faction then 'lost' else 'stopped' end);
  end loop;
  select * into v_ms from mine_sites where building_id = p_building_id for update;
  if found then
    if v_ms.stock > 0 then
      insert into planet_stock (system_id, resource, amount) values (v_system_id, v_ms.resource, v_ms.stock)
      on conflict (system_id, resource) do update set amount = planet_stock.amount + excluded.amount;
    end if;
    update mine_sites set stock = 0, gone = true, auto_on = false where building_id = p_building_id;
  end if;

  if v_bld_faction is distinct from v_sys_faction then$q$,
      'demolish_building: участок');
    execute d;
  end if;
end $patch$;

-- ===== 018: цех возвращает сырьё целиком =====
do $patch$
declare d text;
begin
  d := pg_get_functiondef('public.mine_finish(uuid,text)'::regprocedure);
  if position('econ_fix_1' in d) = 0 then
    d := pg_temp.econ_sub(d,
$q$        perform add_planet_stock(sh.system_id, k, v_back);   -- в пределах склада планеты, как вся добыча$q$,
$q$        -- сырьё лежало на этом складе до смены — возвращается целиком, даже сверх предела (ECON-BUG-018, econ_fix_1)
        insert into planet_stock (system_id, resource, amount) values (sh.system_id, k, v_back)
        on conflict (system_id, resource) do update set amount = planet_stock.amount + excluded.amount;$q$,
      'mine_finish: возврат сырья');
    execute d;
  end if;
end $patch$;

-- ===== 005: управляющий не меняется, пока идёт захват =====
create or replace function public.system_control_capture_guard() returns trigger
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  -- такты и служебные функции (захват, бунт) меняют управляющего сами; запрет — для действий игроков
  if auth.uid() is null then return new; end if;
  if tg_op = 'UPDATE' and new.controller_user_id is not distinct from old.controller_user_id then return new; end if;
  if is_capture_active(new.system_id) then
    raise exception 'На планете идёт захват — управляющего не меняют, пока он не кончится' using errcode = 'P0001';
  end if;
  return new;
end $$;
revoke all on function public.system_control_capture_guard() from public, anon, authenticated;

do $t$
begin
  if not exists (select 1 from pg_trigger where tgname = 'a_system_control_capture_guard') then
    create trigger a_system_control_capture_guard
      before insert or update of controller_user_id on public.system_control
      for each row execute function public.system_control_capture_guard();
  end if;
end $t$;

insert into public.game_settings (key, value)
values ('market_max_price_x', '20')
on conflict (key) do nothing;

-- ================= Доработка после ревью (econ_fix_1b) =================
--  • is_capture_active смотрела на сохранённый progress, а capture_tick пишет строку только при смене статуса:
--    чистый захват (progress 0, rate 1) не считался идущим — ни старые запреты (стройка, найм, смены), ни новые
--    не срабатывали. Теперь захват идёт, пока полоса растёт или стоит выше нуля (status <> 'distribution').
--  • рейс снабжения на остановке ждёт, пока корабль флота в живом бою 2.0 (раньше выгрузка падала, рейс вставал),
--    и не забирает покупку с планеты, где идёт захват, — ждёт его конца (раньше разовый рейс завершался пустым).
--  • покупка лота с планеты, где идёт захват, — отказ.
--  • снос: склад участка переносится после возврата 50 % ресурсов постройки (возврат идёт в пределах склада).
--  • верх цены лота: base_price 0 считается как 10 (как при отсутствии ресурса).
--  • задача поселения: строка суток читается под for share — смена суток не проскочит между проверкой и оплатой.

create or replace function public.is_capture_active(p_system_id text) returns boolean
language sql stable
as $$
  -- захват идёт, пока полоса растёт (rate > 0) или стоит выше нуля; строку capture_tick пишет только при смене статуса,
  -- поэтому сохранённый progress у чистого захвата остаётся 0 (econ_fix_1b)
  select exists (
    select 1 from system_capture
    where system_id = p_system_id and status <> 'distribution' and (progress > 0 or rate > 0)
  );
$$;

do $patch$
declare d text;
begin
  d := pg_get_functiondef('public.supply_route_step(uuid)'::regprocedure);
  if position('econ_fix_1b' in d) = 0 then
    d := pg_temp.econ_sub(d,
$q$    if r.phase = 'at_stop' then$q$,
$q$    if r.phase = 'at_stop' then
      -- корабль флота в живом бою 2.0: груз не перекладывают, ждём конца стычки (ECON-BUG-030, econ_fix_1b)
      if exists (select 1 from ships s where s.commander_id = cm.id and s.system_id = v_here and not s.in_transit
                  and s.carrier_ship_id is null and rt_obj_busy_2_0('ship', s.id) is not null) then
        update supply_routes set last_note = 'Флот в бою — груз передадут, когда стычка кончится', updated_at = now()
         where id = r.id and last_note is distinct from 'Флот в бою — груз передадут, когда стычка кончится';
        exit;
      end if;
      -- вывоз покупки с планеты, где идёт захват: ждём его конца (захватят — бронь вернут деньгами) (ECON-BUG-004)
      if supply_stop_is_pickup(r.stops -> r.stop_index) and is_capture_active(v_here) then
        update supply_routes set last_note = 'Идёт захват — покупку заберём, когда он кончится · ' || coalesce(v_hname, v_here),
                                 updated_at = now()
         where id = r.id and last_note is distinct from 'Идёт захват — покупку заберём, когда он кончится · ' || coalesce(v_hname, v_here);
        exit;
      end if;$q$,
      'supply_route_step: бой и захват');
    execute d;
  end if;
end $patch$;

do $patch$
declare d text;
begin
  d := pg_get_functiondef('public.buy_market_lot(uuid,integer)'::regprocedure);
  if position('econ_fix_1b' in d) = 0 then
    d := pg_temp.econ_sub(d,
$q$  if l.seller_user_id = v_user then raise exception 'Это твой собственный лот'; end if;$q$,
$q$  if l.seller_user_id = v_user then raise exception 'Это твой собственный лот'; end if;
  -- захват: склад планеты достаётся захватчику, торги с неё закрыты (ECON-BUG-004, econ_fix_1b)
  if is_capture_active(l.system_id) then
    raise exception 'На планете продавца идёт захват — торги закрыты, пока он не кончится';
  end if;$q$,
      'buy_market_lot: захват');
    execute d;
  end if;
end $patch$;

do $patch$
declare d text; blk text;
begin
  d := pg_get_functiondef('public.demolish_building(uuid)'::regprocedure);
  if position('econ_fix_1b' in d) = 0 then
    blk := $q$  -- участок добычи или цех: смена закрывается, склад участка уходит на склад планеты целиком, даже сверх предела —
  -- ресурсы при сносе, как и при захвате, остаются на планете (ECON-BUG-016)
  for v_shift in select id from mine_shifts where building_id = p_building_id and status = 'run' loop
    perform mine_finish(v_shift, case when v_bld_faction is distinct from v_sys_faction then 'lost' else 'stopped' end);
  end loop;
  select * into v_ms from mine_sites where building_id = p_building_id for update;
  if found then
    if v_ms.stock > 0 then
      insert into planet_stock (system_id, resource, amount) values (v_system_id, v_ms.resource, v_ms.stock)
      on conflict (system_id, resource) do update set amount = planet_stock.amount + excluded.amount;
    end if;
    update mine_sites set stock = 0, gone = true, auto_on = false where building_id = p_building_id;
  end if;
$q$;
    d := pg_temp.econ_sub(d, blk || E'\n', '', 'demolish_building: убрать перенос до сноса');
    d := pg_temp.econ_sub(d,
$q$      (select cost_resources from building_types where id = v_building_type_id), 0.5);
  end if;$q$,
$q$      (select cost_resources from building_types where id = v_building_type_id), 0.5);
  end if;

  -- после возврата 50 % ресурсов постройки (он идёт в пределах склада) — econ_fix_1b
$q$ || blk,
      'demolish_building: перенос после возврата');
    execute d;
  end if;
end $patch$;

do $patch$
declare d text;
begin
  d := pg_get_functiondef('public.create_market_lot(text,text,integer,integer,text)'::regprocedure);
  if position('econ_fix_1b' in d) = 0 then
    d := pg_temp.econ_sub(d,
$q$  if p_price > coalesce((select base_price from resources where id = p_resource), 10) * game_setting_int('market_max_price_x', 20) then
    raise exception 'Цена не может быть больше %',
      coalesce((select base_price from resources where id = p_resource), 10) * game_setting_int('market_max_price_x', 20);$q$,
$q$  if p_price > coalesce((select nullif(base_price, 0) from resources where id = p_resource), 10) * game_setting_int('market_max_price_x', 20) then
    raise exception 'Цена не может быть больше %',   -- econ_fix_1b: base_price 0 — как 10
      coalesce((select nullif(base_price, 0) from resources where id = p_resource), 10) * game_setting_int('market_max_price_x', 20);$q$,
      'create_market_lot: base_price 0');
    execute d;
  end if;
end $patch$;

do $patch$
declare d text;
begin
  d := pg_get_functiondef('public.settlement_pay_task(uuid)'::regprocedure);
  if position('econ_fix_1b' in d) = 0 then
    d := pg_temp.econ_sub(d,
$q$  if not exists (select 1 from settlement_state st
                 where st.system_id = t.system_id and st.cycle_started = t.cycle_start) then$q$,
$q$  perform 1 from settlement_state st
   where st.system_id = t.system_id and st.cycle_started = t.cycle_start for share;   -- econ_fix_1b: смена суток ждёт оплату
  if not found then$q$,
      'settlement_pay_task: for share');
    execute d;
  end if;
end $patch$;
