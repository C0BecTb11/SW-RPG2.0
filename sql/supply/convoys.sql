-- Снимок (pg_get_functiondef): конвои, проект zqqaxhhajhgspaiwlyhy, 24.10.2026
-- Часть 1: convoy_jump, convoy_load_order, convoy_route, convoy_route_to, convoy_tick, convoy_unload

CREATE OR REPLACE FUNCTION public.convoy_jump(p_convoy_id uuid, p_next text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
declare c record; v_prev text; v_ok boolean := true;
begin
  select * into c from convoys where id = p_convoy_id;

  v_prev := current_setting('request.jwt.claims', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', c.owner_user_id::text, 'role', 'authenticated')::text, true);

  begin
    perform start_commander_move(c.commander_id, p_next);
  exception when others then perform err_db('convoy_jump', sqlstate, sqlerrm, false);
    v_ok := false;
    update convoys set status = 'stalled' where id = p_convoy_id;
    perform log_event(c.owner_user_id, c.faction,
                      (select current_system from commanders where id = c.commander_id),
                      'convoy_stalled', sqlerrm, 1, 'private', null);
  end;

  perform set_config('request.jwt.claims', coalesce(v_prev, ''), true);
  return v_ok;
end;
$function$

-- ----------------------------------------
CREATE OR REPLACE FUNCTION public.convoy_load_order(p_convoy_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
declare
  c record; o record; sh record; v_prev text;
  v_left integer; v_fit integer; v_loaded integer := 0; v_res text;
  v_unit integer := game_setting_int('cargo_units_per_slot', 2);
begin
  select * into c from convoys where id = p_convoy_id;
  select * into o from market_orders where id = c.order_id;
  if not found or o.status <> 'reserved' then return 0; end if;

  select l.resource into v_res from market_lots l where l.id = o.lot_id;
  v_left := o.amount_left;

  v_prev := current_setting('request.jwt.claims', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', c.owner_user_id::text, 'role', 'authenticated')::text, true);

  for sh in
    select s.id, st.capacity - ship_load_used(s.id) as free_slots
    from ships s cross join lateral ship_stats(s.id) st
    where s.commander_id = c.commander_id and not s.in_transit
    order by s.id
  loop
    exit when v_left <= 0;
    v_fit := least(v_left, greatest(0, sh.free_slots) * v_unit);
    continue when v_fit <= 0;

    begin
      perform load_market_order(sh.id, c.order_id, v_fit);
      v_left := v_left - v_fit;
      v_loaded := v_loaded + v_fit;
    exception when others then perform err_db('convoy_load_order', sqlstate, sqlerrm, false);
      exit;
    end;
  end loop;

  perform set_config('request.jwt.claims', coalesce(v_prev, ''), true);

  -- В трюме теперь лежит именно это: его и разгрузим у получателя
  update convoys set cargo = jsonb_build_object(v_res, v_loaded) where id = p_convoy_id;

  if v_loaded > 0 then
    perform log_event(c.owner_user_id, c.faction, c.pickup_system, 'convoy_loaded',
                      v_res, v_loaded, 'private',
                      jsonb_build_object('left_on_order', v_left));
  end if;

  return v_loaded;
end;
$function$

-- ----------------------------------------
CREATE OR REPLACE FUNCTION public.convoy_route(p_from text, p_to text, p_faction text)
 RETURNS text[]
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
declare
  frontier text[] := array[p_from];
  visited  text[] := array[p_from];
  parent   jsonb  := jsonb_build_object(p_from, null);
  nxt text[]; n text; cur text; path text[]; d integer := 0;
begin
  if p_from = p_to then return array[p_from]; end if;

  while coalesce(array_length(frontier, 1), 0) > 0 and d < 20 loop
    d := d + 1;
    nxt := '{}';

    for cur in select unnest(frontier) loop
      for n in
        select case when h.system_a = cur then h.system_b else h.system_a end
        from hyperlanes h
        join systems s on s.id = case when h.system_a = cur then h.system_b else h.system_a end
        where (h.system_a = cur or h.system_b = cur)
          and not s.is_deep_space
          and s.faction = p_faction
      loop
        continue when n = any(visited);
        visited := visited || n;
        nxt := nxt || n;
        parent := parent || jsonb_build_object(n, cur);

        if n = p_to then
          path := array[n];
          cur := parent ->> n;
          while cur is not null loop
            path := array[cur] || path;
            cur := parent ->> cur;
          end loop;
          return path;
        end if;
      end loop;
    end loop;

    frontier := nxt;
  end loop;

  return null;
end;
$function$

-- ----------------------------------------
CREATE OR REPLACE FUNCTION public.convoy_route_to(p_from text, p_to text, p_faction text)
 RETURNS text[]
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
declare
  frontier text[] := array[p_from];
  visited  text[] := array[p_from];
  parent   jsonb  := jsonb_build_object(p_from, null);
  nxt text[]; n text; cur text; path text[]; d integer := 0;
begin
  if p_from = p_to then return array[p_from]; end if;

  while coalesce(array_length(frontier, 1), 0) > 0 and d < 20 loop
    d := d + 1;
    nxt := '{}';

    for cur in select unnest(frontier) loop
      for n in
        select case when h.system_a = cur then h.system_b else h.system_a end
        from hyperlanes h
        join systems s on s.id = case when h.system_a = cur then h.system_b else h.system_a end
        where (h.system_a = cur or h.system_b = cur)
          and not s.is_deep_space
          and (s.faction = p_faction
               or s.id = p_to)          -- в цель можно, даже если она чужая
      loop
        continue when n = any(visited);
        visited := visited || n;
        parent := parent || jsonb_build_object(n, cur);

        if n = p_to then
          path := array[n];
          cur := parent ->> n;
          while cur is not null loop
            path := array[cur] || path;
            cur := parent ->> cur;
          end loop;
          return path;
        end if;

        -- дальше через чужую цель не идём: она только конечная
        nxt := nxt || n;
      end loop;
    end loop;

    frontier := nxt;
  end loop;

  return null;
end;
$function$

-- ----------------------------------------
CREATE OR REPLACE FUNCTION public.convoy_tick()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
declare c record; v_fit integer;
begin
  for c in
    select * from convoys where status = 'in_flight' and arrives_at <= now()
    order by arrives_at
  loop
    if exists (
      select 1 from ships s join ship_types t on t.id = s.ship_type
      where s.system_id = c.to_system and not s.in_transit
        and s.hp > 0 and not t.is_fighter
        and s.faction is distinct from c.faction
    ) then
      v_fit := add_planet_stock(c.from_system, c.resource, c.amount);
      update convoys set status = 'returned' where id = c.id;

      perform log_event(c.owner_user_id, c.faction, c.from_system, 'convoy_returned',
                        c.resource, c.amount, 'private',
                        jsonb_build_object('reason', 'blockade',
                                           'lost_to_cap', c.amount - v_fit));
      continue;
    end if;

    v_fit := add_planet_stock(c.to_system, c.resource, c.amount);
    update convoys set status = 'delivered' where id = c.id;

    perform log_event(c.owner_user_id, c.faction, c.to_system, 'convoy_arrived',
                      c.resource, v_fit, 'private',
                      jsonb_build_object('lost_to_cap', c.amount - v_fit));
  end loop;
end;
$function$

-- ----------------------------------------
CREATE OR REPLACE FUNCTION public.convoy_unload(p_convoy_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
declare
  c record; k text; v_need integer; sh record; v_fit integer;
  v_delivered integer; v_total integer := 0; v_receiver uuid; v_name text;
begin
  select * into c from convoys where id = p_convoy_id;
  if c.cargo is null then return 0; end if;

  select controller_user_id into v_receiver from system_control where system_id = c.to_system;
  select nickname into v_name from profiles where id = c.owner_user_id;

  for k in select jsonb_object_keys(c.cargo) loop
    v_need := coalesce((c.cargo ->> k)::integer, 0);
    v_delivered := 0;

    for sh in
      select rc.ship_id, rc.amount
      from ship_resource_cargo rc join ships s on s.id = rc.ship_id
      where s.commander_id = c.commander_id and rc.resource = k
      order by rc.ship_id
    loop
      exit when v_need <= 0;
      v_fit := add_planet_stock(c.to_system, k, least(v_need, sh.amount));
      exit when v_fit <= 0;   -- склад полон: остаток остаётся в трюме

      if sh.amount - v_fit <= 0 then
        delete from ship_resource_cargo where ship_id = sh.ship_id and resource = k;
      else
        update ship_resource_cargo set amount = amount - v_fit
        where ship_id = sh.ship_id and resource = k;
      end if;

      v_need := v_need - v_fit;
      v_delivered := v_delivered + v_fit;
    end loop;

    if v_delivered > 0 then
      v_total := v_total + v_delivered;

      perform log_event(c.owner_user_id, c.faction, c.to_system, 'convoy_arrived',
                        k, v_delivered, 'private',
                        jsonb_build_object('left_in_hold', v_need));

      if v_receiver is not null and v_receiver is distinct from c.owner_user_id then
        perform log_event(v_receiver, c.faction, c.to_system, 'convoy_received',
                          k, v_delivered, 'private',
                          jsonb_build_object('from_player', coalesce(v_name, 'союзник')));
      end if;
    end if;
  end loop;

  return v_total;
end;
$function$

-- ========================================
-- Часть 2: dispatch_convoy, dispatch_market_pickup, unload_convoy_on_arrival
-- ========================================
CREATE OR REPLACE FUNCTION public.dispatch_convoy(p_commander_id uuid, p_to_system text, p_cargo jsonb, p_return_home boolean DEFAULT false)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
declare
  v_user uuid := auth.uid();
  cm record; v_faction text; v_hub text; v_to_faction text;
  v_total integer := 0; v_free integer; k text; v_need integer;
  sh record; v_left integer; v_fit integer; v_id uuid; v_route text[];
  v_unit integer := game_setting_int('cargo_units_per_slot', 2);
begin
  if v_user is null then raise exception 'Не авторизован'; end if;
  if p_cargo is null or p_cargo = '{}'::jsonb then raise exception 'Не выбран груз'; end if;

  select * into cm from commanders where id = p_commander_id and user_id = v_user;
  if not found then raise exception 'Командир не найден'; end if;
  if not cm.unlocked then raise exception 'Командир ещё не открыт'; end if;
  if cm.moving_to is not null then raise exception 'Командир уже в пути'; end if;
  if exists (select 1 from supply_routes sr where sr.commander_id = p_commander_id
             and sr.status in ('active','paused','stalled')) then
    raise exception 'Флот работает на рейсе снабжения — останови рейс';
  end if;

  if not exists (select 1 from system_control sc
                 where sc.system_id = cm.current_system and sc.controller_user_id = v_user) then
    raise exception 'Командир стоит не на твоей планете';
  end if;

  select faction into v_faction from profiles where id = v_user;
  v_hub := case when v_faction = 'republic' then 'rep_logistics' else 'cis_logistics' end;

  if not exists (
    select 1 from buildings b join building_types bt on bt.id = b.building_type_id
    where b.system_id = cm.current_system and bt.code = v_hub
      and (b.completes_at is null or b.completes_at <= now())
      and b.faction = (select faction from systems where id = cm.current_system)
  ) then
    raise exception 'На этой планете нет достроенного логистического узла';
  end if;

  select faction into v_to_faction from systems where id = p_to_system and not is_deep_space;
  if v_to_faction is null then raise exception 'Такой планеты нет'; end if;
  if v_to_faction is distinct from v_faction then
    raise exception 'Конвой везут только на планету своей стороны';
  end if;

  v_route := convoy_route(cm.current_system, p_to_system, v_faction);
  if v_route is null then
    raise exception 'До этой планеты нет пути через миры своей стороны';
  end if;

  for k in select jsonb_object_keys(p_cargo) loop
    v_need := coalesce((p_cargo ->> k)::integer, 0);
    if v_need < 0 then raise exception 'Некорректное количество'; end if;
    v_total := v_total + v_need;
  end loop;
  if v_total < 1 then raise exception 'Не выбран груз'; end if;

  v_free := commander_free_cargo(p_commander_id);
  if v_total > v_free then
    raise exception 'Во флот не влезет: груз % ед., свободно % ед.', v_total, v_free;
  end if;

  for k in select jsonb_object_keys(p_cargo) loop
    v_need := coalesce((p_cargo ->> k)::integer, 0);
    continue when v_need <= 0;

    perform take_planet_stock(cm.current_system, k, v_need);

    v_left := v_need;
    for sh in
      select s.id, st.capacity - ship_load_used(s.id) as free_slots
      from ships s cross join lateral ship_stats(s.id) st
      where s.commander_id = p_commander_id and not s.in_transit
      order by s.id
    loop
      exit when v_left <= 0;
      v_fit := least(v_left, greatest(0, sh.free_slots) * v_unit);
      continue when v_fit <= 0;

      insert into ship_resource_cargo (ship_id, resource, amount)
      values (sh.id, k, v_fit)
      on conflict (ship_id, resource) do update
        set amount = ship_resource_cargo.amount + excluded.amount;

      v_left := v_left - v_fit;
    end loop;

    if v_left > 0 then raise exception 'Не удалось разместить груз по трюмам'; end if;
  end loop;

  -- Упадёт прыжок — откатится и погрузка, и списание со склада
  perform start_commander_move(p_commander_id, v_route[2]);

  insert into convoys (owner_user_id, faction, from_system, to_system, commander_id,
                       cargo, arrives_at, route, kind, home_system, return_home, stage)
  values (v_user, v_faction, cm.current_system, p_to_system, p_commander_id,
          p_cargo, (select arrives_at from commanders where id = p_commander_id),
          v_route, 'transfer', cm.current_system, coalesce(p_return_home, false), 'to_dest')
  returning id into v_id;

  perform log_event(v_user, v_faction, cm.current_system, 'convoy_departed',
                    cm.name, v_total, 'private',
                    jsonb_build_object('to', p_to_system, 'cargo', p_cargo));
  return v_id;
end;
$function$

-- ----------------------------------------
CREATE OR REPLACE FUNCTION public.dispatch_market_pickup(p_commander_id uuid, p_order_id uuid, p_to_system text, p_return_home boolean DEFAULT false)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
declare
  v_user uuid := auth.uid();
  cm record; o record; v_pickup text; v_faction text; v_to_faction text;
  v_free integer; v_route text[]; v_id uuid; v_res text;
begin
  if v_user is null then raise exception 'Не авторизован'; end if;

  select * into o from market_orders where id = p_order_id;
  if not found or o.buyer_user_id <> v_user then raise exception 'Бронь не найдена'; end if;
  if o.status <> 'reserved' or o.amount_left <= 0 then raise exception 'Бронь уже закрыта'; end if;
  if o.expires_at <= now() then raise exception 'Срок брони истёк'; end if;

  if exists (select 1 from convoys
             where order_id = p_order_id and status = 'in_flight') then
    raise exception 'За этой покупкой уже отправлен флот';
  end if;

  select l.system_id, l.resource into v_pickup, v_res
  from market_lots l where l.id = o.lot_id;

  select * into cm from commanders where id = p_commander_id and user_id = v_user;
  if not found then raise exception 'Командир не найден'; end if;
  if not cm.unlocked then raise exception 'Командир ещё не открыт'; end if;
  if cm.moving_to is not null then raise exception 'Командир уже в пути'; end if;
  if exists (select 1 from supply_routes sr where sr.commander_id = p_commander_id
             and sr.status in ('active','paused','stalled')) then
    raise exception 'Флот работает на рейсе снабжения — останови рейс';
  end if;

  select faction into v_faction from profiles where id = v_user;

  select faction into v_to_faction from systems where id = p_to_system and not is_deep_space;
  if v_to_faction is null then raise exception 'Такой планеты нет'; end if;
  if v_to_faction is distinct from v_faction then
    raise exception 'Выгружать можно только на планету своей стороны';
  end if;

  -- Весь заказ должен влезть: иначе часть осталась бы у продавца
  v_free := commander_free_cargo(p_commander_id);
  if o.amount_left > v_free then
    raise exception 'Во флот не влезет: куплено % ед., свободно % ед.', o.amount_left, v_free;
  end if;

  if cm.current_system = v_pickup then
    v_route := array[v_pickup];
  else
    v_route := convoy_route_to(cm.current_system, v_pickup, v_faction);
    if v_route is null then
      raise exception 'До продавца нет пути через миры своей стороны';
    end if;
  end if;

  insert into convoys (owner_user_id, faction, from_system, to_system, commander_id,
                       arrives_at, route, kind, order_id, pickup_system,
                       home_system, return_home, stage)
  values (v_user, v_faction, cm.current_system, p_to_system, p_commander_id,
          now(), v_route, 'market', p_order_id, v_pickup,
          cm.current_system, coalesce(p_return_home, false), 'to_pickup')
  returning id into v_id;

  if cm.current_system = v_pickup then
    -- Флот уже у продавца: грузимся сразу и идём к получателю
    perform unload_convoy_on_arrival(p_commander_id);
  else
    perform start_commander_move(p_commander_id, v_route[2]);
    update convoys set arrives_at = (select arrives_at from commanders where id = p_commander_id)
    where id = v_id;
  end if;

  perform log_event(v_user, v_faction, cm.current_system, 'convoy_departed',
                    cm.name, o.amount_left, 'private',
                    jsonb_build_object('pickup', v_pickup, 'to', p_to_system, 'resource', v_res));
  return v_id;
end;
$function$

-- ----------------------------------------
CREATE OR REPLACE FUNCTION public.unload_convoy_on_arrival(p_commander_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
declare
  c record; v_here text; v_leg_target text; v_pos integer; v_route text[];
begin
  select current_system into v_here from commanders where id = p_commander_id;

  for c in
    select * from convoys where commander_id = p_commander_id and status = 'in_flight'
  loop
    v_leg_target := case c.stage
      when 'to_pickup' then c.pickup_system
      when 'returning' then c.home_system
      else c.to_system end;

    -- ===== промежуточная точка текущего этапа: прыгаем дальше =====
    if v_here is distinct from v_leg_target then
      v_pos := array_position(c.route, v_here);
      continue when v_pos is null or c.route[v_pos + 1] is null;  -- ушли с маршрута
      perform convoy_jump(c.id, c.route[v_pos + 1]);
      continue;
    end if;

    -- ===== у продавца: грузим и берём курс на получателя =====
    if c.stage = 'to_pickup' then
      perform convoy_load_order(c.id);

      if v_here = c.to_system then
        perform convoy_unload(c.id);
        update convoys set status = 'delivered' where id = c.id;
        continue;
      end if;

      v_route := convoy_route(v_here, c.to_system, c.faction);
      if v_route is null then v_route := convoy_route_to(v_here, c.to_system, c.faction); end if;

      if v_route is null then
        update convoys set status = 'stalled' where id = c.id;
        perform log_event(c.owner_user_id, c.faction, v_here, 'convoy_stalled',
                          'нет пути к получателю', 1, 'private', null);
        continue;
      end if;

      update convoys set stage = 'to_dest', route = v_route where id = c.id;
      perform convoy_jump(c.id, v_route[2]);
      continue;
    end if;

    -- ===== у получателя: разгрузка и, по желанию, домой =====
    if c.stage = 'to_dest' then
      perform convoy_unload(c.id);

      if c.return_home and c.home_system is not null and c.home_system <> v_here then
        v_route := convoy_route(v_here, c.home_system, c.faction);
        if v_route is null then
          v_route := convoy_route_to(v_here, c.home_system, c.faction);
        end if;

        if v_route is not null then
          update convoys set stage = 'returning', route = v_route where id = c.id;
          perform convoy_jump(c.id, v_route[2]);
          continue;
        end if;
      end if;

      update convoys set status = 'delivered' where id = c.id;
      continue;
    end if;

    -- ===== дома =====
    if c.stage = 'returning' then
      update convoys set status = 'delivered' where id = c.id;
      perform log_event(c.owner_user_id, c.faction, v_here, 'convoy_returned_home',
                        null, 1, 'private', null);
    end if;
  end loop;
end;
$function$
