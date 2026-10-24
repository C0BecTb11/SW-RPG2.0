-- Снимок (pg_get_functiondef): рынок — лоты и брони. 24.10.2026
-- buy_market_lot, cancel_market_lot, create_market_lot, get_market_lots, get_my_market_lots, get_my_market_orders,
-- load_market_order, market_expire_tick   (convoy_load_order / dispatch_market_pickup — в convoys.sql)

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
  if not found then raise exception 'Лот не найден'; end if;
  if l.seller_user_id <> v_user then raise exception 'Это не твой лот'; end if;

  -- Пока есть оплаченные брони, снимать нельзя: покупатель уже в пути
  if exists (select 1 from market_orders o
             where o.lot_id = p_lot_id and o.status = 'reserved') then
    raise exception 'По лоту есть неисполненные брони — дождись вывоза или их истечения';
  end if;

  v_fit := add_planet_stock(l.system_id, l.resource, l.amount_left);

  update market_lots set active = false, amount_left = 0 where id = p_lot_id;
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
         exists (select 1 from convoys c where c.order_id = o.id and c.status = 'in_flight')
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
    select * from market_orders where status = 'reserved' and expires_at <= now()
  loop
    v_back := o.amount_left * o.price_per_unit;

    update profiles set credits = credits + v_back where id = o.buyer_user_id;
    update market_lots set amount_left = amount_left + o.amount_left where id = o.lot_id;
    update market_orders set status = 'expired', amount_left = 0 where id = o.id;

    perform log_event(o.buyer_user_id, null, null, 'market_expired',
                      null, v_back, 'private', null);
  end loop;
end;
$function$
