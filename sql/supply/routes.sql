-- Снимок (pg_get_functiondef): рейсы снабжения. 24.10.2026
-- Часть 1: supply_route_step, supply_tick (такт 'supply-tick' каждые 20 с)

CREATE OR REPLACE FUNCTION public.supply_route_step(p_route_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  r record; cm record; v_fac text; v_here text; v_target text; v_route text[]; v_n integer;
  v_moved integer; v_cb integer; v_unl integer; i integer := 0; v_deep boolean; v_hname text;
  v_tname text; v_err text; v_tfac text; v_loop boolean; v_zone text;
begin
  loop
    i := i + 1;
    exit when i > 6;

    select * into r from supply_routes where id = p_route_id for update;
    exit when not found or r.status <> 'active';

    select * into cm from commanders where id = r.commander_id;
    if cm.id is null or cm.user_id <> r.owner_user_id or not cm.unlocked then
      update supply_routes set status = 'stopped', last_note = 'Командир недоступен — рейс завершён',
                               updated_at = now() where id = r.id;
      perform supply_log(r.id, null, 'Командир недоступен — рейс завершён', 0);
      exit;
    end if;

    select faction into v_fac from profiles where id = r.owner_user_id;
    v_n := jsonb_array_length(r.stops);

    -- ----- в пути -----
    if cm.moving_to is not null then
      if cm.moving_to is distinct from r.expect_system then
        v_tname := null;
        select name into v_tname from systems where id = cm.moving_to;
        perform supply_route_stall(r.id, 'Флот оказался не там, где ждали (курс на '
          || coalesce(v_tname, cm.moving_to) || ') — проверь и нажми «Продолжить»');
        exit;
      end if;
      if cm.arrives_at is not null and cm.arrives_at <= now() then
        begin
          perform finish_commander_move(cm.id);
        exception when others then
          if sqlerrm like '%в бою 2.0%' or sqlerrm like '%под огнём%' then exit; end if;
          raise;
        end;
        continue;
      end if;
      exit;
    end if;

    v_here := cm.current_system;
    v_deep := null; v_hname := null;
    select s.is_deep_space, s.name into v_deep, v_hname from systems s where s.id = v_here;

    if v_here is distinct from r.expect_system then
      if coalesce(v_deep, false) then
        perform supply_route_stall(r.id, 'Флот перехвачен в глубоком космосе · ' || coalesce(v_hname, v_here));
      else
        perform supply_route_stall(r.id, 'Флот оказался не там, где ждали (сейчас у '
          || coalesce(v_hname, v_here) || ') — проверь и нажми «Продолжить»');
      end if;
      exit;
    end if;

    -- ----- у командира не осталось кораблей -----
    if not exists (select 1 from ships s where s.commander_id = cm.id and s.carrier_ship_id is null) then
      perform supply_route_stall(r.id, 'У командира не осталось кораблей');
      exit;
    end if;

    -- ----- корабли выходят из гиперпространства (не дольше 5 минут) -----
    if exists (select 1 from ships s where s.commander_id = cm.id
               and s.in_transit and s.carrier_ship_id is null) then
      if r.transit_wait_since is null then
        update supply_routes set transit_wait_since = now() where id = r.id;
      elsif r.transit_wait_since < now() - interval '5 minutes' then
        perform supply_route_stall(r.id, 'Корабли не могут выйти из гиперпространства у '
          || coalesce(v_hname, v_here) || ' — зона прыжка занята, освободи место и нажми «Продолжить»');
      end if;
      exit;
    elsif r.transit_wait_since is not null then
      update supply_routes set transit_wait_since = null where id = r.id;
    end if;

    -- ----- ожидание после пустого круга: стоим на месте, пока не появится работа -----
    if r.phase = 'waiting' then
      exit when r.wait_until is not null and r.wait_until > now();
      if supply_route_has_work(r.id, cm.id) then
        update supply_routes set phase = 'travel', wait_until = null,
                                 last_note = 'Появился груз — рейс продолжается', updated_at = now()
         where id = r.id;
        perform supply_log(r.id, v_here, 'Появился груз — рейс продолжается', 0);
        continue;
      end if;
      update supply_routes set wait_until = now() + interval '10 minutes' where id = r.id;
      exit;
    end if;

    if r.stop_index < 0 or r.stop_index >= v_n then
      update supply_routes set stop_index = 0, phase = 'travel' where id = r.id;
      continue;
    end if;
    v_target := r.stops -> r.stop_index ->> 'system_id';

    v_tfac := null; v_tname := null;
    select s.faction, s.name into v_tfac, v_tname from systems s where s.id = v_target;

    if r.order_id is not null
       and ((supply_stop_is_pickup(r.stops -> r.stop_index) and not supply_pickup_live(r.stops -> r.stop_index))
            or (v_tfac is distinct from v_fac and not supply_stop_is_pickup(r.stops -> r.stop_index))) then
      perform supply_log(r.id, v_here,
        case when supply_stop_is_pickup(r.stops -> r.stop_index) then 'Покупка закрыта — к продавцу не летим'
             else coalesce(v_tname, v_target) || ' больше не планета фракции — остановка пропущена' end, 0);
      if r.stop_index + 1 < v_n then
        update supply_routes set stop_index = r.stop_index + 1, phase = 'travel', updated_at = now() where id = r.id;
        continue;
      end if;
      update supply_routes
         set status = 'stopped', phase = 'at_stop',
             last_note = case when supply_hold_total(cm.id) > 0 then 'Рейс завершён — груз остался в трюме' else 'Рейс завершён' end,
             updated_at = now()
       where id = r.id;
      perform supply_log(r.id, v_here, 'Рейс завершён: дальше лететь некуда', 0);
      exit;
    end if;
    if v_tfac is distinct from v_fac and not supply_stop_is_pickup(r.stops -> r.stop_index) then
      perform supply_route_stall(r.id, 'Остановка ' || (r.stop_index + 1) || ' ('
        || coalesce(v_tname, v_target) || ') больше не планета фракции — измени рейс');
      exit;
    end if;

    -- ----- перелёт к остановке -----
    if r.phase = 'travel' then
      if v_here = v_target then
        update supply_routes set phase = 'at_stop', updated_at = now() where id = r.id;
        continue;
      end if;

      v_route := case when v_tfac is distinct from v_fac then convoy_route_to(v_here, v_target, v_fac)
                      else convoy_route(v_here, v_target, v_fac) end;
      if v_route is null or array_length(v_route, 1) < 2 then
        perform supply_route_stall(r.id, 'Нет пути через миры своей стороны: '
          || coalesce(v_hname, v_here) || ' → ' || coalesce(v_tname, v_target));
        exit;
      end if;

      -- флот вне полосы прыжка — сам выходит к гиперлинии (sql/supply_zone.sql), рейс ждёт
      v_zone := supply_fleet_to_zone(r.id);
      if v_zone like 'blocked:%' then
        perform supply_route_stall(r.id, substr(v_zone, 9));
        update supply_routes set zone_tries = 0 where id = r.id;
        exit;
      end if;
      if v_zone = 'moving' then
        if r.last_note is distinct from 'Флот выходит к гиперлинии · ' || coalesce(v_hname, v_here) then
          update supply_routes set last_note = 'Флот выходит к гиперлинии · ' || coalesce(v_hname, v_here),
                                   updated_at = now() where id = r.id;
          perform supply_log(r.id, v_here, 'Флот выходит к гиперлинии · ' || coalesce(v_hname, v_here), 0);
        end if;
        exit;
      end if;

      begin
        perform start_commander_move(cm.id, v_route[2]);
      exception when others then perform err_db('supply_route_step', sqlstate, sqlerrm, false);
        if sqlstate in ('40P01', '40001', '55P03') then raise; end if;
        v_err := sqlerrm;
        if v_err like 'Корабль под огнём%' or v_err like '%в бою 2.0%' then
          update supply_routes set last_note = 'Флот под огнём — прыжок, когда бой стихнет', updated_at = now()
           where id = r.id and last_note is distinct from 'Флот под огнём — прыжок, когда бой стихнет';
          exit;
        end if;
        if sqlstate = 'P0001' then
          perform supply_route_stall(r.id, v_err);
        else
          perform supply_log(r.id, v_here, 'Сбой прыжка: ' || v_err, 0);
          perform supply_route_stall(r.id, 'Сбой рейса — попробуй «Продолжить»');
        end if;
        exit;
      end;

      update supply_routes
         set expect_system = v_route[2], zone_tries = 0,
             last_note = 'Летит к ' || coalesce(v_tname, v_target),
             updated_at = now()
       where id = r.id;
      exit;
    end if;

    -- ----- на остановке -----
    if r.phase = 'at_stop' then
      v_cb := supply_hold_total(cm.id);
      v_moved := supply_stop_actions(r.id, v_here);
      -- moved = погружено + выгружено, изменение трюма = погружено − выгружено
      v_unl := greatest(0, (v_moved - (supply_hold_total(cm.id) - v_cb)) / 2);

      update supply_routes
         set moved_total = moved_total + v_unl,
             moved_this_cycle = moved_this_cycle + v_moved,
             updated_at = now()
       where id = r.id
       returning * into r;

      if r.stop_index + 1 < v_n then
        update supply_routes set stop_index = r.stop_index + 1, phase = 'travel',
                                 last_note = case when v_moved > 0
                                                  then 'Погрузка и выгрузка: ' || v_moved || ' ед. · ' || v_hname
                                                  else last_note end
         where id = r.id;
        continue;
      end if;

      select x.loop into v_loop from supply_routes x where x.id = r.id;
      if not v_loop then
        update supply_routes set status = 'stopped', phase = 'at_stop', cycles = cycles + 1,
                                 last_note = 'Рейс выполнен', updated_at = now()
         where id = r.id;
        perform supply_log(r.id, v_here, 'Рейс выполнен: доставлено ' || r.moved_total || ' ед.', 0);
        exit;
      end if;

      if r.moved_this_cycle = 0 then
        update supply_routes
           set cycles = cycles + 1, stop_index = 0, moved_this_cycle = 0,
               idle_cycles = idle_cycles + 1, phase = 'waiting',
               wait_until = now() + interval '10 minutes',
               last_note = 'Круг без груза — ждём, пока появится груз', updated_at = now()
         where id = r.id;
        if r.idle_cycles = 0 then
          perform supply_log(r.id, v_here, 'Круг без груза — стоим и проверяем склады раз в 10 минут', 0);
        end if;
        exit;
      end if;

      update supply_routes
         set cycles = cycles + 1, stop_index = 0, moved_this_cycle = 0, idle_cycles = 0,
             phase = 'travel',
             last_note = 'Круг ' || (r.cycles + 1) || ' пройден · всего доставлено ' || r.moved_total || ' ед.',
             updated_at = now()
       where id = r.id;
      continue;
    end if;

    exit;
  end loop;
end $function$

-- ----------------------------------------
CREATE OR REPLACE FUNCTION public.supply_tick()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  rr record; v_claims text; v_sub text; v_quiet text; v_err text; v_state text;
begin
  if not pg_try_advisory_xact_lock(hashtext('supply_tick')) then return; end if;

  v_claims := current_setting('request.jwt.claims', true);
  v_sub    := current_setting('request.jwt.claim.sub', true);
  v_quiet  := current_setting('app.supply_quiet', true);

  for rr in
    select id, owner_user_id from supply_routes
    where status = 'active'
    order by updated_at
  loop
    begin
      -- от имени владельца (start_commander_move / unload_resource_from_ship смотрят auth.uid());
      -- app.supply_quiet глушит события прыжков и разгрузки
      perform set_config('request.jwt.claims',
        json_build_object('sub', rr.owner_user_id::text, 'role', 'authenticated')::text, true);
      perform set_config('request.jwt.claim.sub', rr.owner_user_id::text, true);
      perform set_config('app.supply_quiet', 'on', true);

      perform supply_route_step(rr.id);
    exception when others then perform err_db('supply_tick', sqlstate, sqlerrm, true);
      v_state := sqlstate;
      v_err := sqlerrm;
      if v_state not in ('40P01', '40001', '55P03') then
        begin
          perform set_config('app.supply_quiet', coalesce(v_quiet, ''), true);
          perform supply_log(rr.id, null, 'Сбой: ' || v_err, 0);
          perform supply_route_stall(rr.id, 'Сбой рейса — попробуй «Продолжить»');
        exception when others then perform err_db('supply_tick', sqlstate, sqlerrm, true);
          null;
        end;
      end if;
    end;
  end loop;

  perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
  perform set_config('request.jwt.claim.sub', coalesce(v_sub, ''), true);
  perform set_config('app.supply_quiet', coalesce(v_quiet, ''), true);
end $function$

-- ========================================
-- Часть 2: supply_put_cargo, supply_stop_actions, supply_take_info
-- ========================================
CREATE OR REPLACE FUNCTION public.supply_put_cargo(p_commander_id uuid, p_here text, p_res text, p_amount integer)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_unit integer := game_setting_int('cargo_units_per_slot', 2);
  sh record; v_left integer := p_amount; v_fit integer;
begin
  if p_amount <= 0 then return 0; end if;
  for sh in
    select s.id, st.capacity - ship_load_used(s.id) as free_slots
    from ships s cross join lateral ship_stats(s.id) st
    where s.commander_id = p_commander_id and not s.in_transit and s.system_id = p_here
    order by s.id
  loop
    exit when v_left <= 0;
    v_fit := least(v_left, greatest(0, sh.free_slots) * v_unit);
    continue when v_fit <= 0;
    insert into ship_resource_cargo (ship_id, resource, amount)
    values (sh.id, p_res, v_fit)
    on conflict (ship_id, resource) do update
      set amount = ship_resource_cargo.amount + excluded.amount;
    v_left := v_left - v_fit;
  end loop;
  return p_amount - v_left;
end $function$

-- ----------------------------------------
CREATE OR REPLACE FUNCTION public.supply_stop_actions(p_route_id uuid, p_here text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  r record; v_fac text; v_owner_name text; v_sys_name text; v_sys_fac text; v_stop jsonb; a jsonb;
  v_quiet boolean; v_moved integer := 0; ti record; v_free integer; v_amt integer; v_put integer;
  v_res text; v_have integer; v_want integer; v_stock integer; v_space integer; v_try integer;
  v_done integer; v_fit integer; v_ctrl uuid; v_rule record; v_need integer; sh record; v_left integer;
  v_any boolean;
begin
  select * into r from supply_routes where id = p_route_id;
  select faction, nickname into v_fac, v_owner_name from profiles where id = r.owner_user_id;
  select s.name, s.faction into v_sys_name, v_sys_fac from systems s where s.id = p_here;
  v_stop := r.stops -> r.stop_index;
  v_quiet := r.idle_cycles > 0;   -- повторные пустые круги не засоряют журнал

  if v_sys_fac is distinct from v_fac and not supply_stop_is_pickup(v_stop) then
    perform supply_log(r.id, p_here, 'Планета больше не наша — остановка пропущена · ' || v_sys_name, 0);
    return 0;
  end if;

  select sc.controller_user_id into v_ctrl from system_control sc where sc.system_id = p_here;

  for a in select value from jsonb_array_elements(coalesce(v_stop -> 'actions', '[]'::jsonb)) loop
    v_res := a ->> 'resource';

    -- ================= ЗАБРАТЬ ПОКУПКУ =================
    if a ->> 'op' = 'pickup' then
      v_moved := v_moved + supply_pickup_load(r.id, p_here, (a ->> 'order_id')::uuid);
      continue;
    end if;

    -- ================= ПОГРУЗКА =================
    if a ->> 'op' = 'load' then
      perform 1 from planet_stock ps where ps.system_id = p_here and ps.resource = v_res for update;
      select * into ti from supply_take_info(p_here, v_res, r.owner_user_id);
      v_free := supply_fleet_free(r.commander_id, p_here);
      v_amt := case when ti.can_take then ti.available else 0 end;
      if a ->> 'mode' = 'amount' then v_amt := least(v_amt, (a ->> 'amount')::integer); end if;
      v_amt := least(v_amt, v_free);

      if v_amt <= 0 then
        if not v_quiet then
          perform supply_log(r.id, p_here,
            'Нечего забрать: ' || lower(coalesce((select name from resources where id = v_res), v_res))
            || ' · ' || v_sys_name || ' — '
            || case when ti.can_take and ti.available > 0 and v_free <= 0 then 'трюм полон'
                    else coalesce(ti.reason, 'склад пуст') end, 0);
        end if;
        continue;
      end if;

      -- сначала в трюмы, потом со склада — ровно столько, сколько легло (половинки слотов не ломают погрузку)
      v_put := supply_put_cargo(r.commander_id, p_here, v_res, v_amt);
      if v_put <= 0 then
        if not v_quiet then
          perform supply_log(r.id, p_here, 'Трюм полон — ' || supply_res_gen(v_res) || ' не погрузить · ' || v_sys_name, 0);
        end if;
        continue;
      end if;
      perform take_planet_stock(p_here, v_res, v_put);
      v_amt := v_put;

      if ti.controller is distinct from r.owner_user_id then
        insert into supply_takes (system_id, resource, taker_user_id, owner_user_id, amount, route_id)
        values (p_here, v_res, r.owner_user_id, ti.controller, v_amt, r.id);
        perform log_event_digest(ti.controller, v_fac, 'supply_taken',
          'tk:' || p_here || ':' || v_res || ':' || r.owner_user_id::text, p_here,
          coalesce(v_owner_name, 'снабженец'), (select name from resources where id = v_res),
          v_amt, v_sys_name, true);
      end if;

      perform supply_log(r.id, p_here, 'Погружено ' || v_amt || ' ' || supply_res_gen(v_res) || ' · ' || v_sys_name, v_amt);
      v_moved := v_moved + v_amt;

    -- ================= РАЗГРУЗКА =================
    else
      if v_ctrl is null then
        if not v_quiet then
          perform supply_log(r.id, p_here, 'У планеты нет хозяина — выгрузка пропущена · ' || v_sys_name, 0);
        end if;
        continue;
      end if;

      v_any := false;
      for v_res in
        select rc.resource
        from ship_resource_cargo rc join ships s on s.id = rc.ship_id
        join resources rr on rr.id = rc.resource
        where s.commander_id = r.commander_id and s.system_id = p_here and not s.in_transit
          and (a ->> 'resource' = '*' or rc.resource = a ->> 'resource')
        group by rc.resource, rr.sort_order
        order by rr.sort_order
      loop
        v_any := true;
        select coalesce(sum(rc.amount), 0)::integer into v_have
        from ship_resource_cargo rc join ships s on s.id = rc.ship_id
        where s.commander_id = r.commander_id and s.system_id = p_here and not s.in_transit
          and rc.resource = v_res;

        select coalesce(ps.amount, 0) into v_stock from planet_stock ps
         where ps.system_id = p_here and ps.resource = v_res for update;
        v_stock := coalesce(v_stock, 0);

        v_want := v_have;
        if a ->> 'mode' = 'amount' then
          v_want := least(v_have, (a ->> 'amount')::integer);
        elsif a ->> 'mode' = 'need' then
          select * into v_rule from supply_rules ru
           where ru.system_id = p_here and ru.resource = v_res and ru.set_by = v_ctrl;
          v_need := greatest(0, coalesce(v_rule.want_min, 0) - v_stock);
          v_want := least(v_have, v_need);
          if v_want <= 0 then
            if not v_quiet then
              perform supply_log(r.id, p_here, 'Нужды нет: ' || supply_res_gen(v_res) || ' хватает · ' || v_sys_name, 0);
            end if;
            continue;
          end if;
        end if;
        continue when v_want <= 0;

        v_space := greatest(0, planet_stock_cap(p_here) - v_stock);
        v_try := least(v_want, v_space);
        v_done := 0;

        if v_try > 0 then
          v_left := v_try;
          for sh in
            select rc.ship_id, rc.amount
            from ship_resource_cargo rc join ships s on s.id = rc.ship_id
            where s.commander_id = r.commander_id and s.system_id = p_here and not s.in_transit
              and rc.resource = v_res
            order by rc.ship_id
          loop
            exit when v_left <= 0;
            v_fit := unload_resource_from_ship(sh.ship_id, v_res, least(v_left, sh.amount));
            v_done := v_done + v_fit;
            v_left := v_left - v_fit;
            exit when v_fit < least(v_left + v_fit, sh.amount);   -- склад упёрся в предел
          end loop;
        end if;

        if v_done > 0 then
          perform supply_log(r.id, p_here, 'Выгружено ' || v_done || ' ' || supply_res_gen(v_res) || ' · ' || v_sys_name, v_done);
          v_moved := v_moved + v_done;
          if v_ctrl is distinct from r.owner_user_id then
            perform log_event_digest(v_ctrl, v_fac, 'supply_delivered',
              'dl:' || p_here || ':' || v_res || ':' || r.owner_user_id::text, p_here,
              coalesce(v_owner_name, 'снабженец'), (select name from resources where id = v_res),
              v_done, v_sys_name, true);
          end if;
        end if;

        if v_want - v_done > 0 then
          perform supply_log(r.id, p_here,
            'Склад полон — ' || (v_want - v_done) || ' ' || supply_res_gen(v_res) || ' осталось в трюме · ' || v_sys_name, 0);
        end if;
      end loop;

      if not v_any and not v_quiet then
        perform supply_log(r.id, p_here,
          case when a ->> 'resource' = '*' then 'Трюм пуст — выгружать нечего'
               else 'Нечего выгружать: ' || supply_res_gen(a ->> 'resource') || ' в трюме нет' end
          || ' · ' || v_sys_name, 0);
      end if;
    end if;
  end loop;

  return v_moved;
end $function$

-- ----------------------------------------
CREATE OR REPLACE FUNCTION public.supply_take_info(p_system_id text, p_resource text, p_taker uuid)
 RETURNS TABLE(controller uuid, is_mine boolean, stock integer, available integer, can_take boolean, reason text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_ctrl uuid; v_stock integer; ru record; v_taken integer; v_avail integer;
  v_sys_fac text; v_tk_fac text; v_ct_fac text; v_ok boolean;
begin
  select sc.controller_user_id into v_ctrl from system_control sc where sc.system_id = p_system_id;
  select coalesce(ps.amount, 0) into v_stock from planet_stock ps
   where ps.system_id = p_system_id and ps.resource = p_resource;
  v_stock := coalesce(v_stock, 0);

  if v_ctrl is null then
    return query select null::uuid, false, v_stock, 0, false, 'у планеты нет хозяина'::text; return;
  end if;
  if v_ctrl = p_taker then
    return query select v_ctrl, true, v_stock, v_stock, true,
      case when v_stock = 0 then 'склад пуст' end; return;
  end if;

  select s.faction into v_sys_fac from systems s where s.id = p_system_id;
  select p.faction into v_tk_fac from profiles p where p.id = p_taker;
  select p.faction into v_ct_fac from profiles p where p.id = v_ctrl;
  if v_tk_fac is null or v_tk_fac is distinct from v_sys_fac or v_tk_fac is distinct from v_ct_fac then
    return query select v_ctrl, false, v_stock, 0, false, 'чужая сторона'::text; return;
  end if;

  select * into ru from supply_rules r
   where r.system_id = p_system_id and r.resource = p_resource and r.set_by = v_ctrl;
  if not found or not ru.share then
    return query select v_ctrl, false, v_stock, 0, false, 'склад не отдаёт в сеть'::text; return;
  end if;

  select coalesce(sum(t.amount), 0)::integer into v_taken from supply_takes t
   where t.system_id = p_system_id and t.resource = p_resource
     and t.owner_user_id = v_ctrl and t.taken_at >= last_payout_at();

  v_avail := greatest(0, least(v_stock - ru.keep_min,
                               coalesce(ru.max_per_day - v_taken, 2147483647)));
  v_ok := ru.audience = 'faction' or exists (
    select 1 from supply_grants g
     where g.owner_user_id = v_ctrl and g.grantee_user_id = p_taker and g.status = 'active');

  return query select v_ctrl, false, v_stock, v_avail, v_ok,
    case when not v_ok then 'только доверенным'
         when v_avail > 0 then null
         when v_stock = 0 then 'склад пуст'
         when v_stock <= ru.keep_min then 'запас на минимуме'
         else 'дневной лимит исчерпан' end;
end $function$

-- ========================================
-- Часть 3: вспомогательные — last_payout_at, supply_fleet_free, supply_has_hub, supply_log, supply_normalize_stops,
--         supply_res_gen, supply_route_has_work, supply_route_stall
-- ========================================
CREATE OR REPLACE FUNCTION public.last_payout_at()
 RETURNS timestamp with time zone
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select ((date_trunc('day', (now() at time zone server_tz())
                             - make_interval(hours => game_setting_int('payout_hour', 4)))
           + make_interval(hours => game_setting_int('payout_hour', 4)))
          at time zone server_tz());
$function$

-- ----------------------------------------
CREATE OR REPLACE FUNCTION public.supply_fleet_free(p_commander_id uuid, p_here text)
 RETURNS integer
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select coalesce(sum(greatest(0, st.capacity - ship_load_used(s.id))), 0)::integer
         * game_setting_int('cargo_units_per_slot', 2)
  from ships s cross join lateral ship_stats(s.id) st
  where s.commander_id = p_commander_id and not s.in_transit and s.system_id = p_here;
$function$

-- ----------------------------------------
CREATE OR REPLACE FUNCTION public.supply_has_hub(p_user uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select exists (
    select 1
    from buildings b
    join building_types bt on bt.id = b.building_type_id
    join systems sy on sy.id = b.system_id
    join profiles p on p.id = p_user
    left join system_control sc on sc.system_id = b.system_id
    where bt.code = case when p.faction = 'republic' then 'rep_logistics' else 'cis_logistics' end
      and (b.completes_at is null or b.completes_at <= now())
      and b.faction = p.faction
      and sy.faction = p.faction
      and (b.owner_user_id = p_user or sc.controller_user_id = p_user));
$function$

-- ----------------------------------------
CREATE OR REPLACE FUNCTION public.supply_log(p_route_id uuid, p_system_id text, p_text text, p_moved integer)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  insert into supply_route_log (route_id, system_id, text, moved)
  values (p_route_id, p_system_id, p_text, coalesce(p_moved, 0));
$function$

-- ----------------------------------------
CREATE OR REPLACE FUNCTION public.supply_normalize_stops(p_stops jsonb, p_faction text, p_loop boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_n integer; st jsonb; a jsonb; v_out jsonb := '[]'::jsonb; v_acts jsonb;
  v_sys text; v_name text; v_fac text; v_deep boolean; v_op text; v_res text; v_mode text; v_amt integer;
  v_prev text; v_first text; v_total_acts integer := 0; i integer := 0; v_pname text;
begin
  if p_stops is null or jsonb_typeof(p_stops) <> 'array' then
    raise exception 'Не заданы остановки рейса';
  end if;
  v_n := jsonb_array_length(p_stops);
  if v_n < 2 then raise exception 'В рейсе нужно не меньше двух остановок'; end if;
  if v_n > 6 then raise exception 'В рейсе не больше шести остановок'; end if;

  for st in select value from jsonb_array_elements(p_stops) loop
    i := i + 1;
    if jsonb_typeof(st) <> 'object' then raise exception 'Остановка % задана неверно', i; end if;
    v_sys := st ->> 'system_id';
    v_name := null;
    select s.name, s.faction, s.is_deep_space into v_name, v_fac, v_deep from systems s where s.id = v_sys;
    if v_name is null then raise exception 'Остановка %: такой планеты нет', i; end if;
    if v_deep then raise exception 'Остановка %: в глубоком космосе склада нет', i; end if;
    if v_fac is distinct from p_faction then
      raise exception 'Остановка %: % — не планета твоей стороны', i, v_name;
    end if;
    if v_prev is not null then
      if v_prev = v_sys then raise exception 'Остановки % и % — одна и та же планета', i - 1, i; end if;
      if convoy_route(v_prev, v_sys, p_faction) is null then
        select s.name into v_pname from systems s where s.id = v_prev;
        raise exception 'Нет пути через миры своей стороны: % → %', v_pname, v_name;
      end if;
    else
      v_first := v_sys;
    end if;

    v_acts := '[]'::jsonb;
    if st ? 'actions' and jsonb_typeof(st -> 'actions') <> 'array' then
      raise exception 'Остановка %: действия заданы неверно', i;
    end if;
    if jsonb_array_length(coalesce(st -> 'actions', '[]'::jsonb)) > 10 then
      raise exception 'Остановка %: не больше десяти действий', i;
    end if;
    for a in select value from jsonb_array_elements(coalesce(st -> 'actions', '[]'::jsonb)) loop
      if jsonb_typeof(a) <> 'object' then raise exception 'Остановка %: действие задано неверно', i; end if;
      v_op := a ->> 'op'; v_res := a ->> 'resource'; v_mode := coalesce(a ->> 'mode', 'all');
      if v_op is null or v_op not in ('load', 'unload') then
        raise exception 'Остановка %: неизвестное действие', i;
      end if;
      if v_res is null or (v_res <> '*' and not exists (select 1 from resources r where r.id = v_res)) then
        raise exception 'Остановка %: неизвестный ресурс', i;
      end if;
      if v_op = 'load' and v_res = '*' then
        raise exception 'Остановка %: для погрузки выбери конкретный ресурс', i;
      end if;
      if (v_op = 'load' and v_mode not in ('all', 'amount'))
         or (v_op = 'unload' and v_mode not in ('all', 'amount', 'need')) then
        raise exception 'Остановка %: неверный режим действия', i;
      end if;
      v_amt := null;
      if v_mode = 'amount' then
        begin
          v_amt := (a ->> 'amount')::numeric::integer;
        exception when others then
          raise exception 'Остановка %: количество должно быть целым числом', i;
        end;
        if v_amt is null or v_amt < 1 or v_amt > 100000 then
          raise exception 'Остановка %: количество должно быть от 1 до 100000', i;
        end if;
      end if;
      v_acts := v_acts || jsonb_build_array(jsonb_build_object(
        'op', v_op, 'resource', v_res, 'mode', v_mode, 'amount', v_amt));
      v_total_acts := v_total_acts + 1;
    end loop;

    v_out := v_out || jsonb_build_array(jsonb_build_object('system_id', v_sys, 'actions', v_acts));
    v_prev := v_sys;
  end loop;

  if v_total_acts = 0 then raise exception 'Добавь хотя бы одно действие: погрузить или выгрузить'; end if;

  if p_loop and v_prev = v_first then
    raise exception 'В рейсе по кругу последняя остановка не должна совпадать с первой';
  end if;
  if p_loop and v_prev <> v_first and convoy_route(v_prev, v_first, p_faction) is null then
    raise exception 'Круг не замкнуть: от последней остановки нет пути к первой';
  end if;
  return v_out;
end $function$

-- ----------------------------------------
CREATE OR REPLACE FUNCTION public.supply_res_gen(p_res text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select case p_res
    when 'ore' then 'руды' when 'gas' then 'тибанны' when 'crystals' then 'кристаллов'
    when 'food' then 'продовольствия' when 'durasteel' then 'дюрастали'
    when 'cells' then 'топливных ячеек' when 'electronics' then 'электроники'
    else p_res end;
$function$

-- ----------------------------------------
CREATE OR REPLACE FUNCTION public.supply_route_has_work(p_route_id uuid, p_commander_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  r record; st jsonb; a jsonb; v_sys text; v_free integer; ti record; v_ctrl uuid;
  rc record; v_stock integer; v_want integer;
begin
  select * into r from supply_routes where id = p_route_id;
  if not found then return false; end if;
  v_free := commander_free_cargo(p_commander_id);

  for st in select value from jsonb_array_elements(r.stops) loop
    v_sys := st ->> 'system_id';
    for a in select value from jsonb_array_elements(coalesce(st -> 'actions', '[]'::jsonb)) loop
      if a ->> 'op' = 'load' then
        continue when v_free <= 0;
        select * into ti from supply_take_info(v_sys, a ->> 'resource', r.owner_user_id);
        if ti.can_take and ti.available > 0 then return true; end if;
      else
        v_ctrl := null;
        select sc.controller_user_id into v_ctrl from system_control sc where sc.system_id = v_sys;
        continue when v_ctrl is null;
        for rc in
          select x.resource as res
          from ship_resource_cargo x join ships s on s.id = x.ship_id
          where s.commander_id = p_commander_id
            and (a ->> 'resource' = '*' or x.resource = a ->> 'resource')
          group by x.resource
        loop
          v_stock := null;
          select ps.amount into v_stock from planet_stock ps
           where ps.system_id = v_sys and ps.resource = rc.res;
          v_stock := coalesce(v_stock, 0);
          if a ->> 'mode' = 'need' then
            v_want := null;
            select ru.want_min into v_want from supply_rules ru
             where ru.system_id = v_sys and ru.resource = rc.res and ru.set_by = v_ctrl;
            if coalesce(v_want, 0) - v_stock > 0 then return true; end if;
          elsif planet_stock_cap(v_sys) - v_stock > 0 then
            return true;
          end if;
        end loop;
      end if;
    end loop;
  end loop;
  return false;
end $function$

-- ----------------------------------------
CREATE OR REPLACE FUNCTION public.supply_route_stall(p_route_id uuid, p_note text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare r record; v_here text; v_fac text;
begin
  select * into r from supply_routes where id = p_route_id for update;
  if not found or r.status <> 'active' then return; end if;
  select coalesce(c.current_system, c.moving_from) into v_here from commanders c where c.id = r.commander_id;
  select faction into v_fac from profiles where id = r.owner_user_id;
  update supply_routes set status = 'stalled', last_note = p_note, updated_at = now() where id = p_route_id;
  perform supply_log(p_route_id, v_here, 'Рейс встал: ' || p_note, 0);
  perform log_event(r.owner_user_id, v_fac, v_here, 'supply_route_stalled',
                    r.name || ' — ' || p_note, 1, 'private',
                    jsonb_build_object('route_id', r.id, 'layer', 'space'));
end $function$

-- ========================================
-- Часть 4: действия игрока — create_supply_route, set_supply_route_status, set_supply_rule, update_supply_route
-- ========================================
CREATE OR REPLACE FUNCTION public.create_supply_route(p_commander_id uuid, p_name text, p_stops jsonb, p_loop boolean)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_user uuid := auth.uid(); cm record; v_fac text; v_stops jsonb; v_id uuid; v_name text; v_ships integer;
begin
  if v_user is null then raise exception 'Не авторизован'; end if;
  select faction into v_fac from profiles where id = v_user;

  if not supply_has_hub(v_user) then
    raise exception 'Нужен штаб снабжения: достроенный логистический узел хотя бы на одной планете';
  end if;

  select * into cm from commanders where id = p_commander_id and user_id = v_user for update;
  if not found then raise exception 'Командир не найден'; end if;
  if not cm.unlocked then raise exception 'Командир ещё не открыт'; end if;
  if cm.moving_to is not null then raise exception 'Командир в пути — дождись прибытия'; end if;
  if cm.current_system is null then raise exception 'Неизвестно, где стоит флот'; end if;
  if exists (select 1 from supply_routes r where r.commander_id = p_commander_id and r.status <> 'stopped') then
    raise exception 'У этого командира уже есть рейс — заверши его';
  end if;
  select count(*)::integer into v_ships from ships s
   where s.commander_id = p_commander_id and s.carrier_ship_id is null;
  if v_ships = 0 then raise exception 'У командира не осталось кораблей'; end if;

  v_stops := supply_normalize_stops(p_stops, v_fac, coalesce(p_loop, true));
  v_name := left(nullif(btrim(coalesce(p_name, '')), ''), 40);
  if v_name is null then
    select 'Рейс ' || string_agg(s.name, ' — ' order by o) into v_name
    from jsonb_array_elements(v_stops) with ordinality x(st, o)
    join systems s on s.id = x.st ->> 'system_id' where o <= 2;
    v_name := left(v_name, 40);
  end if;

  insert into supply_routes (owner_user_id, commander_id, name, stops, loop, status, stop_index, phase,
                             expect_system, last_note)
  values (v_user, p_commander_id, v_name, v_stops, coalesce(p_loop, true), 'active', 0, 'travel',
          cm.current_system, 'Рейс запущен')
  returning id into v_id;

  perform supply_log(v_id, cm.current_system, 'Рейс запущен', 0);
  return v_id;
end $function$

-- ----------------------------------------
CREATE OR REPLACE FUNCTION public.set_supply_route_status(p_route_id uuid, p_status text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_user uuid := auth.uid(); r record; cm record; v_txt text;
begin
  if v_user is null then raise exception 'Не авторизован'; end if;
  if p_status is null or p_status not in ('active', 'paused', 'stopped') then
    raise exception 'Неверное состояние рейса';
  end if;
  select * into r from supply_routes x where x.id = p_route_id and x.owner_user_id = v_user for update;
  if not found then raise exception 'Рейс не найден'; end if;
  if r.status = 'stopped' then raise exception 'Рейс уже завершён'; end if;
  if r.status = p_status then return; end if;

  select * into cm from commanders c where c.id = r.commander_id;

  if p_status = 'active' then
    if cm.id is null or cm.user_id <> v_user or not cm.unlocked then
      raise exception 'Командир рейса недоступен';
    end if;
    if not exists (select 1 from ships s where s.commander_id = cm.id and s.carrier_ship_id is null) then
      raise exception 'У командира не осталось кораблей';
    end if;
    update supply_routes x
       set status = 'active',
           expect_system = coalesce(cm.moving_to, cm.current_system),
           phase = case when x.phase = 'waiting' then 'waiting' else 'travel' end,
           transit_wait_since = null,
           last_note = 'Рейс продолжен', updated_at = now()
     where x.id = r.id;
    v_txt := 'Рейс продолжен';
  elsif p_status = 'paused' then
    update supply_routes x set status = 'paused', last_note = 'Пауза', updated_at = now() where x.id = r.id;
    v_txt := 'Рейс на паузе';
  else
    update supply_routes x set status = 'stopped', last_note = 'Рейс завершён', wait_until = null,
                             updated_at = now() where x.id = r.id;
    v_txt := 'Рейс завершён игроком';
  end if;
  perform supply_log(r.id, (select c.current_system from commanders c where c.id = r.commander_id), v_txt, 0);
end $function$

-- ----------------------------------------
CREATE OR REPLACE FUNCTION public.set_supply_rule(p_system_id text, p_resource text, p_share boolean, p_keep_min integer, p_max_per_day integer, p_audience text, p_want_min integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_user uuid := auth.uid();
begin
  if v_user is null then raise exception 'Не авторизован'; end if;
  if not exists (select 1 from system_control sc
                 where sc.system_id = p_system_id and sc.controller_user_id = v_user) then
    raise exception 'Правила склада задаёт только хозяин планеты';
  end if;
  if not exists (select 1 from resources r where r.id = p_resource) then
    raise exception 'Неизвестный ресурс';
  end if;
  if coalesce(p_keep_min, 0) < 0 or coalesce(p_want_min, 0) < 0 or coalesce(p_max_per_day, 0) < 0 then
    raise exception 'Значения не могут быть отрицательными';
  end if;
  if coalesce(p_keep_min, 0) > 1000000 or coalesce(p_want_min, 0) > 1000000
     or coalesce(p_max_per_day, 0) > 1000000 then
    raise exception 'Слишком большое значение';
  end if;
  if coalesce(p_audience, 'faction') not in ('faction', 'trusted') then
    raise exception 'Кому отдавать: фракции или доверенным';
  end if;

  insert into supply_rules (system_id, resource, share, keep_min, max_per_day, audience, want_min, set_by, updated_at)
  values (p_system_id, p_resource, coalesce(p_share, false), coalesce(p_keep_min, 0), p_max_per_day,
          coalesce(p_audience, 'faction'), coalesce(p_want_min, 0), v_user, now())
  on conflict on constraint supply_rules_pkey do update
    set share = excluded.share, keep_min = excluded.keep_min, max_per_day = excluded.max_per_day,
        audience = excluded.audience, want_min = excluded.want_min,
        set_by = excluded.set_by, updated_at = now();
end $function$

-- ----------------------------------------
CREATE OR REPLACE FUNCTION public.update_supply_route(p_route_id uuid, p_name text, p_stops jsonb, p_loop boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_user uuid := auth.uid(); v_status text; v_old_loop boolean; v_old_name text;
        v_fac text; v_stops jsonb; v_name text; v_loop boolean;
begin
  if v_user is null then raise exception 'Не авторизован'; end if;
  select x.status, x.loop, x.name into v_status, v_old_loop, v_old_name
    from supply_routes x where x.id = p_route_id and x.owner_user_id = v_user for update;
  if v_status is null then raise exception 'Рейс не найден'; end if;
  if v_status = 'stopped' then raise exception 'Рейс уже завершён'; end if;
  if exists (select 1 from supply_routes x where x.id = p_route_id and x.order_id is not null) then
    raise exception 'Вывоз покупки не меняется — заверши его и отправь флот заново';
  end if;
  select faction into v_fac from profiles where id = v_user;

  v_loop := coalesce(p_loop, v_old_loop);
  v_stops := supply_normalize_stops(p_stops, v_fac, v_loop);
  v_name := coalesce(left(nullif(btrim(coalesce(p_name, '')), ''), 40), v_old_name);

  update supply_routes x
     set name = v_name, stops = v_stops, loop = v_loop,
         stop_index = 0,
         phase = case when x.phase = 'at_stop' then 'travel' else x.phase end,
         moved_this_cycle = 0, idle_cycles = 0,
         last_note = 'Маршрут изменён', updated_at = now()
   where x.id = p_route_id;
  perform supply_log(p_route_id, null, 'Маршрут изменён — начинаем с первой остановки', 0);
end $function$

-- ========================================
-- Часть 5: чтение — get_my_supply_planets, get_my_supply_routes, get_supply_commanders, get_supply_network,
--         get_supply_route_log, get_supply_takes
-- ========================================
CREATE OR REPLACE FUNCTION public.get_my_supply_planets()
 RETURNS TABLE(system_id text, system_name text, resource text, resource_name text, color text, stock integer, cap integer, share boolean, keep_min integer, max_per_day integer, audience text, want_min integer, taken_today integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_user uuid := auth.uid(); v_since timestamptz := last_payout_at();
begin
  if v_user is null then raise exception 'Не авторизован'; end if;
  return query
  select s.id, s.name, r.id, r.name, r.color,
         coalesce(ps.amount, 0)::integer,
         planet_stock_cap(s.id),
         coalesce(ru.share, false), coalesce(ru.keep_min, 0), ru.max_per_day,
         coalesce(ru.audience, 'faction'), coalesce(ru.want_min, 0),
         coalesce((select sum(t.amount) from supply_takes t
                   where t.system_id = s.id and t.resource = r.id and t.taken_at >= v_since and t.owner_user_id = v_user), 0)::integer
  from system_control sc
  join systems s on s.id = sc.system_id and not s.is_deep_space
  cross join resources r
  left join planet_stock ps on ps.system_id = s.id and ps.resource = r.id
  left join supply_rules ru on ru.system_id = s.id and ru.resource = r.id and ru.set_by = v_user
  where sc.controller_user_id = v_user
  order by s.name, r.sort_order;
end $function$

-- ----------------------------------------
CREATE OR REPLACE FUNCTION public.get_my_supply_routes()
 RETURNS TABLE(id uuid, name text, commander_id uuid, commander_name text, ships integer, free_cargo integer, cargo jsonb, stops jsonb, loop boolean, status text, stop_index integer, phase text, here_system_id text, here_name text, next_name text, seconds_left integer, last_note text, cycles integer, moved_total integer, updated_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_user uuid := auth.uid();
begin
  if v_user is null then raise exception 'Не авторизован'; end if;
  return query
  select r.id, r.name, r.commander_id, c.name,
         (select count(*)::integer from public.ships s where s.commander_id = r.commander_id and s.carrier_ship_id is null),
         commander_free_cargo(r.commander_id),
         coalesce((select jsonb_object_agg(x.res, x.amt)
                   from (select rc.resource as res, sum(rc.amount)::integer as amt
                         from ship_resource_cargo rc join public.ships s on s.id = rc.ship_id
                         where s.commander_id = r.commander_id
                         group by rc.resource) x), '{}'::jsonb),
         coalesce((select jsonb_agg(x.st || jsonb_build_object(
                     'system_name', sy.name,
                     'actions', coalesce((select jsonb_agg(y.a || jsonb_build_object(
                                   'resource_name', case when y.a ->> 'resource' = '*' then 'Всё' else rs.name end)
                                   order by y.ao)
                                 from jsonb_array_elements(x.st -> 'actions') with ordinality y(a, ao)
                                 left join resources rs on rs.id = y.a ->> 'resource'), '[]'::jsonb))
                   order by x.o)
                   from jsonb_array_elements(r.stops) with ordinality x(st, o)
                   left join systems sy on sy.id = x.st ->> 'system_id'), '[]'::jsonb),
         r.loop, r.status, r.stop_index, r.phase,
         case when c.moving_to is null then c.current_system end,
         hs.name,
         ns.name,
         (case when c.moving_to is not null and c.arrives_at is not null
                then greatest(0, ceil(extract(epoch from c.arrives_at - now())))
              when r.phase = 'waiting' and r.wait_until is not null and r.status = 'active'
                then greatest(0, ceil(extract(epoch from r.wait_until - now())))
              else 0 end)::integer,
         r.last_note, r.cycles, r.moved_total, r.updated_at
  from supply_routes r
  left join commanders c on c.id = r.commander_id
  left join systems hs on hs.id = c.current_system
  left join systems ns on ns.id = (r.stops -> r.stop_index ->> 'system_id')
  where r.owner_user_id = v_user
    and (r.status <> 'stopped' or r.updated_at > now() - interval '1 day')
  order by (r.status = 'stopped'), r.created_at;
end $function$

-- ----------------------------------------
CREATE OR REPLACE FUNCTION public.get_supply_commanders()
 RETURNS TABLE(commander_id uuid, name text, system_id text, system_name text, ships integer, free_cargo integer, ready boolean, busy text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_user uuid := auth.uid();
begin
  if v_user is null then raise exception 'Не авторизован'; end if;
  return query
  select c.id, c.name, c.current_system, s.name, q.n, commander_free_cargo(c.id),
         (c.moving_to is null and q.n > 0 and q.rdy = q.n),
         case when exists (select 1 from supply_routes r where r.commander_id = c.id
                           and r.status in ('active', 'paused', 'stalled')) then 'route'
              when c.moving_to is not null then 'moving' end
  from commanders c
  left join systems s on s.id = c.current_system
  cross join lateral (
    select count(*)::integer as n,
           (count(*) filter (where is_in_hyperspace_zone(
             sh.y, ship_box_h(t.width_cells, t.height_cells, sh.facing),
             hyperspace_side(c.current_system, sh.faction))))::integer as rdy
    from public.ships sh join ship_types t on t.id = sh.ship_type
    where sh.commander_id = c.id and sh.system_id = c.current_system
      and not sh.in_transit and sh.carrier_ship_id is null
  ) q
  where c.user_id = v_user and c.unlocked
  order by c.slot_index;
end $function$

-- ----------------------------------------
CREATE OR REPLACE FUNCTION public.get_supply_network()
 RETURNS TABLE(system_id text, system_name text, controller_id uuid, controller_name text, is_mine boolean, resource text, resource_name text, color text, available integer, need integer, audience text, can_take boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_user uuid := auth.uid(); v_fac text;
begin
  if v_user is null then raise exception 'Не авторизован'; end if;
  select p.faction into v_fac from profiles p where p.id = v_user;

  return query
  select q.sid, q.sname, q.ctrl, q.cname, q.mine, q.rid, q.rname, q.rcolor,
         case when q.can then q.avail else 0 end, q.nd, q.aud, q.can
  from (
    select s.id as sid, s.name as sname, sc.controller_user_id as ctrl, pc.nickname as cname,
           (sc.controller_user_id = v_user) as mine,
           r.id as rid, r.name as rname, r.color as rcolor, r.sort_order as rso,
           ti.available as avail,
           greatest(0, coalesce(ru.want_min, 0) - ti.stock)::integer as nd,
           coalesce(ru.audience, 'faction') as aud,
           ti.can_take as can,
           coalesce(ru.share, false) as shr
    from systems s
    join system_control sc on sc.system_id = s.id and sc.controller_user_id is not null
    left join profiles pc on pc.id = sc.controller_user_id
    cross join resources r
    left join supply_rules ru on ru.system_id = s.id and ru.resource = r.id
                             and ru.set_by = sc.controller_user_id
    cross join lateral supply_take_info(s.id, r.id, v_user) ti
    where s.faction = v_fac and not s.is_deep_space
  ) q
  where (q.shr and q.avail > 0) or q.nd > 0
  order by q.mine desc, q.sname, q.rso;
end $function$

-- ----------------------------------------
CREATE OR REPLACE FUNCTION public.get_supply_route_log(p_route_id uuid)
 RETURNS TABLE(at timestamp with time zone, system_name text, text text, moved integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_user uuid := auth.uid();
begin
  if v_user is null then raise exception 'Не авторизован'; end if;
  if not exists (select 1 from supply_routes r where r.id = p_route_id and r.owner_user_id = v_user) then
    raise exception 'Рейс не найден';
  end if;
  return query
  select l.at, s.name, l.text, l.moved
  from supply_route_log l left join systems s on s.id = l.system_id
  where l.route_id = p_route_id
  order by l.id desc
  limit 30;
end $function$

-- ----------------------------------------
CREATE OR REPLACE FUNCTION public.get_supply_takes(p_system_id text)
 RETURNS TABLE(taken_at timestamp with time zone, taker_name text, resource_name text, amount integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_user uuid := auth.uid();
begin
  if v_user is null then raise exception 'Не авторизован'; end if;
  if not exists (select 1 from system_control sc
                 where sc.system_id = p_system_id and sc.controller_user_id = v_user) then
    raise exception 'Это не твоя планета';
  end if;
  return query
  select t.taken_at, coalesce(p.nickname, 'неизвестный'), coalesce(r.name, t.resource), t.amount
  from supply_takes t
  left join profiles p on p.id = t.taker_user_id
  left join resources r on r.id = t.resource
  where t.system_id = p_system_id and t.owner_user_id = v_user
  order by t.taken_at desc
  limit 30;
end $function$

-- ----------------------------------------
CREATE OR REPLACE FUNCTION public.supply_stop_is_pickup(p_stop jsonb)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select exists (select 1 from jsonb_array_elements(coalesce(p_stop -> 'actions', '[]'::jsonb)) a
                  where a.value ->> 'op' = 'pickup');
$function$

-- ----------------------------------------
CREATE OR REPLACE FUNCTION public.supply_pickup_load(p_route_id uuid, p_here text, p_order_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare r record; o record; l record; v_free integer; v_put integer; v_pay integer; v_sys text; v_buyer_fac text;
begin
  select * into r from supply_routes where id = p_route_id;
  select name into v_sys from systems where id = p_here;
  select * into o from market_orders where id = p_order_id for update;
  if not found or o.status <> 'reserved' or o.amount_left <= 0 then
    perform supply_log(r.id, p_here, 'Покупку уже не забрать — '
      || case coalesce(o.status, '')
           when 'expired' then 'бронь истекла, деньги вернулись'
           when 'cancelled' then 'планету захватили, деньги вернулись'
           when 'collected' then 'она уже вывезена'
           else 'брони больше нет' end || ' · ' || coalesce(v_sys, p_here), 0);
    return 0;
  end if;
  -- пока за бронью летит флот, рынок держит её до 6 ч сверх срока (market_expire_tick) — здесь то же окно
  if o.expires_at <= now() - interval '6 hours' then
    perform supply_log(r.id, p_here, 'Бронь истекла — деньги вернутся с ближайшим тактом рынка · ' || coalesce(v_sys, p_here), 0);
    return 0;
  end if;

  select * into l from market_lots where id = o.lot_id;
  if l.system_id is distinct from p_here then
    perform supply_log(r.id, p_here, 'Товар лежит не здесь — покупка не забрана', 0);
    return 0;
  end if;

  v_free := supply_fleet_free(r.commander_id, p_here);
  v_put := supply_put_cargo(r.commander_id, p_here, l.resource, least(o.amount_left, v_free));
  if v_put <= 0 then
    perform supply_log(r.id, p_here, 'Трюм полон — покупку не забрать · ' || coalesce(v_sys, p_here), 0);
    return 0;
  end if;

  v_pay := v_put * o.price_per_unit;
  update profiles set credits = credits + v_pay where id = l.seller_user_id;
  update market_orders
     set amount_left = amount_left - v_put,
         status = case when amount_left - v_put <= 0 then 'collected' else 'reserved' end
   where id = o.id;

  select faction into v_buyer_fac from profiles where id = r.owner_user_id;
  perform log_event(l.seller_user_id, l.seller_faction, l.system_id, 'market_paid',
                    l.resource, v_put, 'private', jsonb_build_object('credits', v_pay));
  perform log_event(r.owner_user_id, v_buyer_fac, l.system_id, 'market_collected',
                    l.resource, v_put, 'private', jsonb_build_object('route_id', r.id));
  perform supply_log(r.id, p_here, 'Покупка забрана: ' || v_put || ' ' || supply_res_gen(l.resource)
    || ' · ' || coalesce(v_sys, p_here)
    || case when v_put < o.amount_left
            then ' — не влезло ' || (o.amount_left - v_put) || ', остаток ждёт по брони' else '' end, v_put);
  return v_put;
end;
$function$

-- ----------------------------------------
CREATE OR REPLACE FUNCTION public.supply_cleanup()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_del text := 'del' || 'ete from ';
begin
  -- журналы рейсов и supply_takes старше 7 дней и так чистит cleanup_old_records; здесь — то, что держат ссылки
  execute v_del || 'supply_route_log l using supply_routes r where l.route_id = r.id and r.status = ''stopped'' and r.updated_at < now() - interval ''14 days''';
  execute v_del || 'supply_routes where status = ''stopped'' and updated_at < now() - interval ''14 days''';
  execute v_del || 'market_orders o where o.status <> ''reserved'' and o.created_at < now() - interval ''14 days''
                     and not exists (select 1 from supply_routes r where r.order_id = o.id)';
  execute v_del || 'market_lots l where not l.active and l.created_at < now() - interval ''14 days''
                     and not exists (select 1 from market_orders o where o.lot_id = l.id)';
  execute v_del || 'supply_grants where status in (''revoked'', ''declined'') and coalesce(decided_at, created_at) < now() - interval ''30 days''';
exception when others then
  perform err_db('supply_cleanup', sqlstate, sqlerrm, true);
end;
$function$

-- ----------------------------------------
CREATE OR REPLACE FUNCTION public.supply_pickup_live(p_stop jsonb)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select exists (select 1 from jsonb_array_elements(coalesce(p_stop -> 'actions', '[]'::jsonb)) a
                 join market_orders o on o.id = (a.value ->> 'order_id')::uuid
                  where a.value ->> 'op' = 'pickup' and o.status = 'reserved');
$function$
-- ----------------------------------------
CREATE OR REPLACE FUNCTION public.get_supply_hub()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select auth.uid() is not null and supply_has_hub(auth.uid());
$function$

-- ----------------------------------------
CREATE OR REPLACE FUNCTION public.get_supply_map()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_me uuid := auth.uid();
  v_fac text;
begin
  if v_me is null then raise exception 'Не авторизован'; end if;
  select p.faction into v_fac from profiles p where p.id = v_me;

  return (
    with fl as (
      select r.id, r.name, r.status, r.phase, r.loop, r.stop_index, r.stops, r.wait_until, r.order_id,
             c.name as cname, c.current_system, c.moving_from, c.moving_to, c.departed_at, c.arrives_at
      from supply_routes r join commanders c on c.id = r.commander_id
      where r.owner_user_id = v_me and r.status <> 'stopped'
    ),
    ids as (
      select s.id from systems s where s.faction = v_fac and not s.is_deep_space
      union select x.value ->> 'system_id' from fl cross join lateral jsonb_array_elements(fl.stops) x
      union select fl.current_system from fl
      union select fl.moving_from from fl
      union select fl.moving_to from fl
    ),
    sy as (select s.* from systems s where s.id in (select ids.id from ids where ids.id is not null))
    select jsonb_build_object(
      'now', now(),
      'faction', v_fac,
      'systems', (select coalesce(jsonb_agg(jsonb_build_object(
                    'id', s.id, 'name', s.name, 'tex', s.texture, 'x', s.world_x, 'y', s.world_y,
                    'faction', s.faction, 'deep', s.is_deep_space,
                    'mine', exists (select 1 from system_control sc where sc.system_id = s.id and sc.controller_user_id = v_me),
                    -- хаб — только на планетах своей стороны: чужие постройки закрыты туманом (can_see_building),
                    -- а постройки снабжения работают только у нынешней стороны планеты (sql/supply_fixes.sql)
                    'hub', s.faction = v_fac and exists (select 1 from buildings b join building_types bt on bt.id = b.building_type_id
                                    where b.system_id = s.id and bt.code in ('rep_logistics', 'cis_logistics')
                                      and b.faction = s.faction and (b.completes_at is null or b.completes_at <= now()))
                  ) order by s.name), '[]'::jsonb) from sy s),
      'lanes', (select coalesce(jsonb_agg(jsonb_build_array(h.system_a, h.system_b)), '[]'::jsonb) from hyperlanes h
                 where h.system_a in (select sy.id from sy) and h.system_b in (select sy.id from sy)),
      'fleets', (select coalesce(jsonb_agg(jsonb_build_object(
                   'id', fl.id, 'name', fl.name, 'commander', fl.cname, 'status', fl.status, 'phase', fl.phase,
                   'loop', fl.loop, 'idx', fl.stop_index, 'pickup', fl.order_id is not null,
                   'stops', (select coalesce(jsonb_agg(x.value ->> 'system_id' order by x.ordinality), '[]'::jsonb)
                               from jsonb_array_elements(fl.stops) with ordinality x),
                   'at', case when fl.moving_to is null then fl.current_system end,
                   'from', case when fl.moving_to is not null then coalesce(fl.moving_from, fl.current_system) end,
                   'to', fl.moving_to, 'dep', fl.departed_at, 'arr', fl.arrives_at,
                   'wait', case when fl.phase = 'waiting' then fl.wait_until end
                 ) order by fl.name), '[]'::jsonb) from fl)
    )
  );
end $function$

-- ----------------------------------------
CREATE OR REPLACE FUNCTION public.supply_fleet_to_zone(p_route_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  r record; cm record; v_fac text; v_side text; v_here text; v_hname text;
  v_grid int := game_setting_int('space_grid_cells', 150);
  v_zh int := game_setting_int('hyperspace_zone_height', 14);
  s record; v_w int; v_h int; v_l int; v_mr int; v_tx int; v_ty int; v_found boolean; v_live boolean;
  v_txa int[] := '{}'; v_tya int[] := '{}'; v_twa int[] := '{}'; v_tha int[] := '{}';
  v_y0 int; v_y1 int; v_mid int; v_d int; v_cx int; v_cy int; v_k int; v_rows int[];
  v_path jsonb; v_group uuid; v_new uuid[] := '{}'; v_id uuid; v_n int := 0; v_out int; a uuid;
begin
  select * into r from supply_routes where id = p_route_id;
  select * into cm from commanders where id = r.commander_id;
  if r.id is null or cm.id is null or cm.moving_to is not null or cm.current_system is null then return 'ready'; end if;
  v_here := cm.current_system;
  select p.faction into v_fac from profiles p where p.id = r.owner_user_id;
  select sy.name into v_hname from systems sy where sy.id = v_here;
  v_side := hyperspace_side(v_here, v_fac);

  -- живая орбита: корабли ведёт сервер боя
  v_live := exists (select 1 from ships sh where sh.commander_id = cm.id and sh.system_id = v_here
                     and not sh.in_transit and sh.carrier_ship_id is null and rt_obj_busy_2_0('ship', sh.id) is not null);

  select count(*)::int into v_out
  from ships sh join ship_types t on t.id = sh.ship_type
  where sh.commander_id = cm.id and sh.system_id = v_here and not sh.in_transit and sh.carrier_ship_id is null
    and not is_in_hyperspace_zone(sh.y, ship_box_h(t.width_cells, t.height_cells, sh.facing), v_side);
  if v_out = 0 then
    if r.zone_tries <> 0 then update supply_routes set zone_tries = 0 where id = r.id; end if;
    execute 'del' || 'ete from rt_space_orders o where o.ship_id in (select sh.id from ships sh where sh.commander_id = $1)' using cm.id;
    return 'ready';
  end if;

  if v_live then
    -- наш автоход из базы в живой орбите не сделает ни шага — снимаем, дальше ведёт сервер боя
    update auto_moves am set status = 'stopped', stop_reason = 'cancelled', updated_at = now()
     where am.status = 'active' and am.label = 'Выход к гиперлинии'
       and am.ship_id in (select sh.id from ships sh where sh.commander_id = cm.id);
    -- приказ ещё не забран или корабли ещё идут (до 4 минут после выдачи)
    if exists (select 1 from rt_space_orders o join ships sh on sh.id = o.ship_id
                where sh.commander_id = cm.id and o.system_id = v_here
                  and (o.taken_at is null and o.created_at > now() - interval '5 minutes'
                       or o.taken_at > now() - interval '4 minutes')) then
      return 'moving';
    end if;
  elsif exists (select 1 from auto_moves am join ships sh on sh.id = am.ship_id
                 where am.status = 'active' and sh.commander_id = cm.id and sh.system_id = v_here) then
    -- уже идут (наш автоход или приказ самого игрока) — ждём, чужой приказ не перебиваем
    return 'moving';
  end if;

  if r.zone_tries >= 3 then
    return 'blocked:Флот не может выйти к гиперлинии у ' || coalesce(v_hname, v_here)
      || ': путь к полосе прыжка перекрыт — выведи корабли к краю карты космоса и нажми «Продолжить»';
  end if;

  -- корабли, которые не могут двигаться, — сразу причина
  select coalesce(sh.name, t.name) || case when ship_active_boarding(sh.id) is not null then '» сцеплен абордажем'
                                           else '» удерживается притягивающим лучом' end
    into v_hname
  from ships sh join ship_types t on t.id = sh.ship_type
  where sh.commander_id = cm.id and sh.system_id = v_here and not sh.in_transit and sh.carrier_ship_id is null
    and (ship_active_boarding(sh.id) is not null or (sh.tractor_until is not null and sh.tractor_until > now()))
  limit 1;
  if v_hname is not null then
    return 'blocked:Флот не может выйти к гиперлинии: «' || v_hname;
  end if;

  if not v_live then
    -- корабли заняты другим приказом прямо сейчас — попробуем на следующем такте
    begin
      perform 1 from ships sh where sh.commander_id = cm.id and sh.system_id = v_here
        and not sh.in_transit and sh.carrier_ship_id is null order by sh.id for update nowait;
    exception when lock_not_available then
      return 'moving';
    end;
  end if;

  update supply_routes set zone_tries = zone_tries + 1 where id = r.id;
  v_group := case when v_out > 1 then gen_random_uuid() end;

  -- ближние к полосе — первыми: им лучшие места
  for s in
    select sh.id, sh.x, sh.y, sh.facing, t.width_cells as tw, t.height_cells as th
    from ships sh join ship_types t on t.id = sh.ship_type
    where sh.commander_id = cm.id and sh.system_id = v_here and not sh.in_transit and sh.carrier_ship_id is null
      and not is_in_hyperspace_zone(sh.y, ship_box_h(t.width_cells, t.height_cells, sh.facing), v_side)
    order by case when v_side = 'top' then sh.y else -sh.y end, sh.x
  loop
    v_w := ship_box_w(s.tw, s.th, s.facing);
    v_h := ship_box_h(s.tw, s.th, s.facing);
    v_l := greatest(s.tw, s.th);                     -- в любом развороте корабль помещается в квадрат L×L
    select ss.move_range into v_mr from ship_stats(s.id) ss;
    v_mr := greatest(1, coalesce(v_mr, 1));
    -- ряды полосы, где квадрат целиком внутри; от середины полосы к краям
    if v_side = 'top' then v_y0 := 0; v_y1 := v_zh - v_l;
    else v_y0 := v_grid - v_zh; v_y1 := v_grid - v_l; end if;
    continue when v_y1 < v_y0;                       -- корабль длиннее полосы: такой не прыгнет ни в каком случае
    v_mid := (v_y0 + v_y1) / 2;
    select array_agg(g order by abs(g - v_mid), g) into v_rows from generate_series(v_y0, v_y1) g;

    -- место: напротив корабля, затем всё дальше вбок
    v_found := false;
    <<search>>
    for v_d in 0 .. least(v_grid, 80) loop
      foreach v_cy in array v_rows loop
        foreach v_cx in array array[least(greatest(0, s.x - v_d), v_grid - v_l), least(greatest(0, s.x + v_d), v_grid - v_l)] loop
          if automove_box_ok('space', v_here, s.id, v_cx, v_cy, v_l, v_l, v_fac, false)
             and not exists (select 1 from unnest(v_txa, v_tya, v_twa, v_tha) e(ex, ey, ew, eh)
                             where boxes_overlap(v_cx, v_cy, v_l, v_l, e.ex, e.ey, e.ew, e.eh)) then
            v_tx := v_cx; v_ty := v_cy; v_found := true;
            exit search;
          end if;
        end loop;
      end loop;
      exit when v_d > 0 and s.x - v_d <= 0 and s.x + v_d >= v_grid - v_l;
    end loop;
    continue when not v_found;

    if v_live then
      -- центр квадрата в метрах: сервер боя ведёт корабль туда в реальном времени
      v_txa := v_txa || v_tx; v_tya := v_tya || v_ty; v_twa := v_twa || v_l; v_tha := v_tha || v_l;
      insert into rt_space_orders (ship_id, system_id, x, y, reason, created_at, taken_at)
      values (s.id, v_here, round((v_tx + v_l / 2.0) * 200)::int, round((v_ty + v_l / 2.0) * 200)::int, 'supply', now(), null)
      on conflict (ship_id) do update set system_id = excluded.system_id, x = excluded.x, y = excluded.y,
                                          reason = excluded.reason, created_at = now(), taken_at = null;
      v_n := v_n + 1;
      continue;
    end if;

    v_path := automove_route('space', v_here, s.x, s.y, v_tx, v_ty, v_w, v_h, v_mr, v_fac, false);
    continue when jsonb_array_length(v_path) = 0;

    v_txa := v_txa || v_tx; v_tya := v_tya || v_ty; v_twa := v_twa || v_l; v_tha := v_tha || v_l;
    update ships set overwatch = false where id = s.id and overwatch;
    v_id := null;
    begin
      insert into auto_moves (owner_user_id, system_id, layer, ship_id, group_id, target_x, target_y, path,
                              step_range, member_idx, faction, label, status)
      values (r.owner_user_id, v_here, 'space', s.id, v_group, v_tx, v_ty, v_path, v_mr, v_n, v_fac,
              'Выход к гиперлинии', 'active')
      returning id into v_id;
    exception when others then
      -- орбиту как раз открыли (бой 2.0): автоход не нужен, на следующем такте приказ получит сервер боя
      if sqlerrm not like '%в бою 2.0%' then raise; end if;
    end;
    if v_id is not null then v_new := v_new || v_id; end if;
    v_n := v_n + 1;
  end loop;

  if v_n = 0 then
    return 'blocked:Флот не может выйти к гиперлинии у ' || coalesce((select name from systems where id = v_here), v_here)
      || ': в полосе прыжка нет свободного места или к ней нет пути — освободи место и нажми «Продолжить»';
  end if;

  -- первый шаг сразу — у кого есть очки действий
  foreach a in array v_new loop
    begin
      perform automove_step(a);
    exception when others then perform err_db('supply_fleet_to_zone', sqlstate, sqlerrm, true);
    end;
  end loop;
  return 'moving';
end $function$
