-- Снимок (pg_get_functiondef): рынок — лоты и брони. 24.10.2026
-- buy_market_lot, cancel_market_lot, create_market_lot, get_market_lots, get_my_market_lots, get_my_market_orders,
-- load_market_order, market_expire_tick, dispatch_market_pickup (вывоз покупки рейсом)

CREATE OR REPLACE FUNCTION public.buy_market_lot(p_lot_id uuid, p_amount integer)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
declare
  v_user uuid := auth.uid();
  l record; v_faction text; v_cost integer; v_credits integer; v_id uuid;
begin
  if v_user is null then raise exception 'Не авторизован'; end if;
  if p_amount < 1 then raise exception 'Некорректное количество'; end if;

  select * into l from market_lots where id = p_lot_id for update;
  if not found or not l.active then raise exception 'Лот не найден'; end if;
  if l.seller_user_id = v_user then raise exception 'Это твой собственный лот'; end if;

  select faction into v_faction from profiles where id = v_user;
  if l.open_to = 'faction' and l.seller_faction is distinct from v_faction then
    raise exception 'Продавец торгует только со своими';
  end if;

  if l.amount_left < p_amount then
    raise exception 'В лоте осталось только %', l.amount_left;
  end if;

  v_cost := p_amount * l.price_per_unit;
  select credits into v_credits from profiles where id = v_user;
  if v_credits < v_cost then raise exception 'Недостаточно кредитов: нужно %', v_cost; end if;

  update profiles set credits = credits - v_cost where id = v_user;
  update market_lots set amount_left = amount_left - p_amount where id = p_lot_id;

  insert into market_orders (lot_id, buyer_user_id, amount_left, price_per_unit,
                             paid, expires_at)
  values (p_lot_id, v_user, p_amount, l.price_per_unit, v_cost,
          now() + make_interval(hours => game_setting_int('market_order_hours', 24)))
  returning id into v_id;

  perform log_event(l.seller_user_id, l.seller_faction, l.system_id, 'market_sold',
                    l.resource, p_amount, 'private',
                    jsonb_build_object('price', l.price_per_unit));

  return v_id;
end;
$function$

-- ----------------------------------------
CREATE OR REPLACE FUNCTION public.cancel_market_lot(p_lot_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
declare v_user uuid := auth.uid(); l record; v_fit integer;
begin
  select * into l from market_lots where id = p_lot_id for update;
  if not found or not l.active then raise exception 'Лот не найден'; end if;
  if l.seller_user_id <> v_user then raise exception 'Это не твой лот'; end if;
  -- товар возвращается на склад планеты — только если планета всё ещё твоя
  if not exists (select 1 from system_control sc where sc.system_id = l.system_id and sc.controller_user_id = v_user) then
    raise exception 'Планета больше не под твоим контролем — товар лота остался на ней';
  end if;
  -- пока есть оплаченные брони, снимать нельзя: покупатель уже в пути
  if exists (select 1 from market_orders o where o.lot_id = p_lot_id and o.status = 'reserved') then
    raise exception 'По лоту есть неисполненные брони — дождись вывоза или их истечения';
  end if;

  -- что не влезло на склад, остаётся в лоте — не сгорает
  v_fit := add_planet_stock(l.system_id, l.resource, l.amount_left);
  update market_lots
     set amount_left = amount_left - v_fit,
         active = (amount_left - v_fit) > 0
   where id = p_lot_id;
  return v_fit;
end;
$function$

-- ----------------------------------------
CREATE OR REPLACE FUNCTION public.create_market_lot(p_system_id text, p_resource text, p_amount integer, p_price integer, p_open_to text DEFAULT 'faction'::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
declare
  v_user uuid := auth.uid();
  v_faction text; v_hub text; v_id uuid;
begin
  if v_user is null then raise exception 'Не авторизован'; end if;
  if p_amount < 1 then raise exception 'Некорректное количество'; end if;
  if p_price < game_setting_int('market_min_price', 1) then
    raise exception 'Цена не может быть меньше %', game_setting_int('market_min_price', 1);
  end if;
  if p_open_to not in ('faction', 'all') then
    raise exception 'Непонятный круг покупателей';
  end if;

  if not exists (select 1 from system_control sc
                 where sc.system_id = p_system_id and sc.controller_user_id = v_user) then
    raise exception 'Планета не под твоим контролем';
  end if;

  select faction into v_faction from profiles where id = v_user;
  v_hub := case when v_faction = 'republic' then 'rep_logistics' else 'cis_logistics' end;

  -- Торгуют через логистический узел: без него планета не в сети
  if not exists (
    select 1 from buildings b join building_types bt on bt.id = b.building_type_id
    where b.system_id = p_system_id and bt.code = v_hub
      and (b.completes_at is null or b.completes_at <= now())
      and b.faction = (select faction from systems where id = p_system_id)
  ) then
    raise exception 'На этой планете нет достроенного логистического узла';
  end if;

  perform take_planet_stock(p_system_id, p_resource, p_amount);

  insert into market_lots (seller_user_id, seller_faction, system_id, resource,
                           amount_left, price_per_unit, open_to)
  values (v_user, v_faction, p_system_id, p_resource, p_amount, p_price, p_open_to)
  returning id into v_id;

  return v_id;
end;
$function$

-- ----------------------------------------
CREATE OR REPLACE FUNCTION public.get_market_lots(p_resource text DEFAULT NULL::text)
 RETURNS TABLE(lot_id uuid, resource text, resource_name text, amount_left integer, price_per_unit integer, system_id text, system_name text, seller_faction text, seller_name text, open_to text, mine boolean, foreign_side boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
  select l.id, l.resource, r.name, l.amount_left, l.price_per_unit,
         l.system_id, s.name, l.seller_faction,
         coalesce(p.nickname, 'неизвестный'), l.open_to,
         l.seller_user_id = auth.uid(),
         l.seller_faction is distinct from me.faction
  from market_lots l
  join resources r on r.id = l.resource
  join systems s on s.id = l.system_id
  left join profiles p on p.id = l.seller_user_id
  cross join (select faction from profiles where id = auth.uid()) me
  where l.active and l.amount_left > 0
    and (p_resource is null or l.resource = p_resource)
    and (l.seller_user_id = auth.uid()
         or l.open_to = 'all'
         or l.seller_faction = me.faction)
  order by r.sort_order, l.price_per_unit;
$function$

-- ----------------------------------------
CREATE OR REPLACE FUNCTION public.get_my_market_lots()
 RETURNS TABLE(lot_id uuid, resource text, resource_name text, amount_left integer, price_per_unit integer, system_id text, system_name text, open_to text, reserved integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
  select l.id, l.resource, r.name, l.amount_left, l.price_per_unit,
         l.system_id, s.name, l.open_to,
         coalesce((select sum(o.amount_left)::integer from market_orders o
                   where o.lot_id = l.id and o.status = 'reserved'), 0)
  from market_lots l
  join resources r on r.id = l.resource
  join systems s on s.id = l.system_id
  where l.seller_user_id = auth.uid() and l.active
    and (l.amount_left > 0
         or exists (select 1 from market_orders o
                    where o.lot_id = l.id and o.status = 'reserved'))
  order by r.sort_order;
$function$

-- ----------------------------------------
CREATE OR REPLACE FUNCTION public.get_my_market_orders()
 RETURNS TABLE(order_id uuid, resource text, resource_name text, amount_left integer, price_per_unit integer, paid integer, system_id text, system_name text, expires_at timestamp with time zone, seconds_left integer, status text, fleet_sent boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
  select o.id, l.resource, r.name, o.amount_left, o.price_per_unit, o.paid,
         l.system_id, s.name, o.expires_at,
         greatest(0, ceil(extract(epoch from o.expires_at - now()))::integer),
         o.status,
         exists (select 1 from supply_routes sr where sr.order_id = o.id and sr.status <> 'stopped')
  from market_orders o
  join market_lots l on l.id = o.lot_id
  join resources r on r.id = l.resource
  join systems s on s.id = l.system_id
  where o.buyer_user_id = auth.uid() and o.status = 'reserved'
  order by o.expires_at;
$function$

-- ----------------------------------------
CREATE OR REPLACE FUNCTION public.load_market_order(p_ship_id uuid, p_order_id uuid, p_amount integer)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
declare
  v_user uuid := auth.uid();
  s record; o record; l record; st record;
  v_used integer; v_need integer; v_pay integer;
begin
  if v_user is null then raise exception 'Не авторизован'; end if;
  if p_amount < 1 then raise exception 'Некорректное количество'; end if;

  select * into o from market_orders where id = p_order_id for update;
  if not found then raise exception 'Бронь не найдена'; end if;
  if o.buyer_user_id <> v_user then raise exception 'Это не твоя бронь'; end if;
  if o.status <> 'reserved' then raise exception 'Бронь уже закрыта'; end if;
  if o.expires_at <= now() then raise exception 'Срок брони истёк'; end if;
  if o.amount_left < p_amount then
    raise exception 'По брони осталось только %', o.amount_left;
  end if;

  select * into l from market_lots where id = o.lot_id;

  select * into s from ships where id = p_ship_id for update;
  if not found then raise exception 'Корабль не найден'; end if;
  if s.owner_user_id <> v_user then raise exception 'Это не твой корабль'; end if;
  if s.in_transit then raise exception 'Корабль в гиперпространстве'; end if;

  -- Грузиться нужно там, где лежит товар. Планета при этом может быть
  -- чужой — именно бронь и даёт право подойти к чужому складу.
  if s.system_id <> l.system_id then
    raise exception 'Товар лежит в системе %, веди корабль туда', l.system_id;
  end if;

  select * into st from ship_stats(p_ship_id);
  v_used := ship_load_used(p_ship_id);
  v_need := resource_slots(p_amount);

  if v_used + v_need > st.capacity then
    raise exception 'В трюме не хватает места: занято % из %, нужно ещё %',
      v_used, st.capacity, v_need;
  end if;

  insert into ship_resource_cargo (ship_id, resource, amount)
  values (p_ship_id, l.resource, p_amount)
  on conflict (ship_id, resource) do update
    set amount = ship_resource_cargo.amount + excluded.amount;

  v_pay := p_amount * o.price_per_unit;
  update profiles set credits = credits + v_pay where id = l.seller_user_id;

  update market_orders
  set amount_left = amount_left - p_amount,
      status = case when amount_left - p_amount <= 0 then 'collected' else 'reserved' end
  where id = p_order_id;

  perform log_event(l.seller_user_id, l.seller_faction, l.system_id, 'market_paid',
                    l.resource, p_amount, 'private',
                    jsonb_build_object('credits', v_pay));
  perform log_event(v_user, s.faction, l.system_id, 'market_collected',
                    l.resource, p_amount, 'private', null);

  return st.capacity - ship_load_used(p_ship_id);
end;
$function$

-- ----------------------------------------
CREATE OR REPLACE FUNCTION public.market_expire_tick()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
declare o record; v_back integer;
begin
  for o in
    select * from market_orders mo
     where mo.status = 'reserved' and mo.expires_at <= now()
       and not (mo.expires_at > now() - interval '6 hours'
                and exists (select 1 from supply_routes sr where sr.order_id = mo.id and sr.status = 'active'))
     for update skip locked
  loop
    begin
      v_back := o.amount_left * o.price_per_unit;
      update profiles set credits = credits + v_back where id = o.buyer_user_id;
      update market_lots set amount_left = amount_left + o.amount_left where id = o.lot_id;
      update market_orders set status = 'expired', amount_left = 0 where id = o.id;
      perform log_event(o.buyer_user_id, null, null, 'market_expired', null, v_back, 'private', null);
    exception when others then
      perform err_db('market_expire_tick', sqlstate, sqlerrm, true);
    end;
  end loop;
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
  cm record; o record; v_pickup text; v_res text; v_faction text; v_pfac text; v_to_faction text; v_to_name text;
  v_free integer; v_ships integer; v_path text[]; v_back text[]; v_hops integer; v_sec integer; v_stops jsonb;
  v_id uuid; v_name text; v_pname text;
begin
  if v_user is null then raise exception 'Не авторизован'; end if;

  select * into o from market_orders where id = p_order_id for update;
  if not found or o.buyer_user_id <> v_user then raise exception 'Бронь не найдена'; end if;
  if o.status <> 'reserved' or o.amount_left <= 0 then raise exception 'Бронь уже закрыта'; end if;
  if o.expires_at <= now() then raise exception 'Срок брони истёк'; end if;
  if exists (select 1 from supply_routes sr where sr.order_id = p_order_id and sr.status <> 'stopped') then
    raise exception 'За этой покупкой уже отправлен флот';
  end if;

  select l.system_id, l.resource into v_pickup, v_res from market_lots l where l.id = o.lot_id;
  select s.faction, s.name into v_pfac, v_pname from systems s where s.id = v_pickup;
  select faction into v_faction from profiles where id = v_user;

  select * into cm from commanders where id = p_commander_id and user_id = v_user for update;
  if not found then raise exception 'Командир не найден'; end if;
  if not cm.unlocked then raise exception 'Командир ещё не открыт'; end if;
  if cm.moving_to is not null then raise exception 'Командир в пути — дождись прибытия'; end if;
  if cm.current_system is null then raise exception 'Неизвестно, где стоит флот'; end if;
  if exists (select 1 from supply_routes sr where sr.commander_id = p_commander_id and sr.status <> 'stopped') then
    raise exception 'У этого командира уже есть рейс — заверши его';
  end if;
  select count(*)::integer into v_ships from ships s where s.commander_id = p_commander_id and s.carrier_ship_id is null;
  if v_ships = 0 then raise exception 'У командира не осталось кораблей'; end if;

  select faction, name into v_to_faction, v_to_name from systems where id = p_to_system and not is_deep_space;
  if v_to_name is null then raise exception 'Такой планеты нет'; end if;
  if v_to_faction is distinct from v_faction then raise exception 'Выгружать можно только на планету своей стороны'; end if;

  -- весь заказ должен влезть: иначе часть осталась бы у продавца
  v_free := commander_free_cargo(p_commander_id);
  if o.amount_left > v_free then
    raise exception 'Во флот не влезет: куплено % ед., свободно % ед.', o.amount_left, v_free;
  end if;

  -- путь к продавцу через свои миры (сама планета продавца может быть чужой) и от него к месту выгрузки
  if cm.current_system = v_pickup then v_path := array[v_pickup];
  elsif v_pfac is distinct from v_faction then v_path := convoy_route_to(cm.current_system, v_pickup, v_faction);
  else v_path := convoy_route(cm.current_system, v_pickup, v_faction); end if;
  if v_path is null then raise exception 'До продавца нет пути через миры своей стороны'; end if;
  if p_to_system <> v_pickup and convoy_route(v_pickup, p_to_system, v_faction) is null then
    raise exception 'От продавца до % нет пути через миры своей стороны', v_to_name;
  end if;

  -- успеет ли флот до конца брони (по времени прыжков без событий)
  v_hops := coalesce(array_length(v_path, 1), 1) - 1;
  v_sec := v_hops * game_setting_int('travel_seconds', 60);
  if now() + make_interval(secs => v_sec) >= o.expires_at then
    raise exception 'Флот не успеет до конца брони: лететь около % мин', ceil(v_sec / 60.0);
  end if;

  v_stops := jsonb_build_array(jsonb_build_object('system_id', v_pickup, 'actions', jsonb_build_array(
               jsonb_build_object('op', 'pickup', 'order_id', p_order_id, 'resource', v_res, 'mode', 'amount', 'amount', o.amount_left))));
  -- выгружается только сама покупка: другой груз в трюмах флота остаётся при нём
  if p_to_system = v_pickup then
    v_stops := jsonb_set(v_stops, '{0,actions}', (v_stops -> 0 -> 'actions')
                 || jsonb_build_array(jsonb_build_object('op', 'unload', 'resource', v_res, 'mode', 'amount', 'amount', o.amount_left)));
  else
    v_stops := v_stops || jsonb_build_array(jsonb_build_object('system_id', p_to_system, 'actions', jsonb_build_array(
                 jsonb_build_object('op', 'unload', 'resource', v_res, 'mode', 'amount', 'amount', o.amount_left))));
  end if;
  if coalesce(p_return_home, false) and cm.current_system not in (p_to_system, v_pickup) then
    if convoy_route(p_to_system, cm.current_system, v_faction) is null then
      raise exception 'От % нет пути домой через миры своей стороны', v_to_name;
    end if;
    v_stops := v_stops || jsonb_build_array(jsonb_build_object('system_id', cm.current_system, 'actions', '[]'::jsonb));
  end if;

  v_name := left('Вывоз: ' || lower(coalesce((select name from resources where id = v_res), v_res)) || ' с ' || v_pname, 40);
  insert into supply_routes (owner_user_id, commander_id, name, stops, loop, status, stop_index, phase,
                             expect_system, last_note, order_id)
  values (v_user, p_commander_id, v_name, v_stops, false, 'active', 0, 'travel',
          cm.current_system, 'Флот отправлен за покупкой', p_order_id)
  returning id into v_id;
  perform supply_log(v_id, cm.current_system, 'Флот отправлен за покупкой: ' || o.amount_left || ' '
    || supply_res_gen(v_res) || ' · ' || v_pname || ' → ' || v_to_name, 0);
  perform log_event(v_user, v_faction, cm.current_system, 'convoy_departed', cm.name, o.amount_left, 'private',
                    jsonb_build_object('pickup', v_pickup, 'to', p_to_system, 'resource', v_res, 'route_id', v_id));

  -- первый шаг сразу, не дожидаясь такта: прыжок или погрузка, если флот уже у продавца.
  -- Встал на первом же шаге (флот не в зоне прыжка и т. п.) — отправка не состоялась, причина игроку
  perform supply_route_step(v_id);
  if (select status from supply_routes where id = v_id) = 'stalled' then
    raise exception '%', (select last_note from supply_routes where id = v_id);
  end if;
  return v_id;
end;
$function$
