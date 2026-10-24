-- Снимок (pg_get_functiondef): склад планеты и ручная погрузка/выгрузка кораблей. 24.10.2026
-- add_planet_stock, dev_stock, get_planet_stock, load_resource_to_ship, planet_stock_cap, refund_build_resources,
-- resource_slots, take_build_resources, take_planet_stock, unload_resource_from_ship

CREATE OR REPLACE FUNCTION public.add_planet_stock(p_system_id text, p_resource text, p_amount integer)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
declare v_cap integer; v_have integer; v_fit integer;
begin
  if p_amount <= 0 then return 0; end if;
  v_cap := planet_stock_cap(p_system_id);
  -- строка склада под блокировкой: два одновременных пополнения не поднимут запас выше предела
  insert into planet_stock (system_id, resource, amount) values (p_system_id, p_resource, 0)
  on conflict (system_id, resource) do nothing;
  select amount into v_have from planet_stock
   where system_id = p_system_id and resource = p_resource for update;
  v_fit := least(p_amount, greatest(0, v_cap - coalesce(v_have, 0)));
  if v_fit = 0 then return 0; end if;
  update planet_stock set amount = amount + v_fit where system_id = p_system_id and resource = p_resource;
  return v_fit;
end;
$function$

-- ----------------------------------------
CREATE OR REPLACE FUNCTION public.dev_stock(p_system text, p_resource text, p_amount integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_me uuid := dev_assert(); r record;
begin
  if not exists (select 1 from systems where id = p_system) then raise exception 'Нет такой планеты'; end if;
  if p_amount is null or abs(p_amount) > 1000000 then raise exception 'Количество от −1 000 000 до 1 000 000'; end if;
  if p_resource <> 'all' and not exists (select 1 from resources where id = p_resource) then raise exception 'Нет такого сырья'; end if;
  for r in select id from resources where p_resource = 'all' or id = p_resource loop
    insert into planet_stock (system_id, resource, amount) values (p_system, r.id, greatest(0, p_amount))
    on conflict (system_id, resource) do update set amount = greatest(0, planet_stock.amount + p_amount);
  end loop;
  perform dev_note(v_me, 'stock', null, p_system, jsonb_build_object('resource', p_resource, 'amount', p_amount));
  return (select coalesce(jsonb_object_agg(resource, amount), '{}') from planet_stock where system_id = p_system);
end;
$function$

-- ----------------------------------------
CREATE OR REPLACE FUNCTION public.get_planet_stock(p_system_id text)
 RETURNS TABLE(resource text, name text, kind text, amount integer, cap integer, is_primary boolean, is_secondary boolean, per_day integer, color text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
  select r.id, r.name, r.kind,
         coalesce(ps.amount, 0),
         planet_stock_cap(p_system_id),
         s.primary_resource = r.id,
         s.secondary_resource = r.id,
         coalesce((
           select sum(case
                        when ms.building_id is not null then mine_day_estimate(b.id)
                        when s.primary_resource = bt.produces_resource
                          then bt.produces_per_day
                        when s.secondary_resource = bt.produces_resource
                          then bt.produces_per_day / 2
                        else bt.produces_per_day
                      end)::integer
           from buildings b join building_types bt on bt.id = b.building_type_id
           left join mine_sites ms on ms.building_id = b.id
           where b.system_id = p_system_id
             and bt.produces_resource = r.id
             and (b.completes_at is null or b.completes_at <= now())
         ), 0),
         r.color
  from systems s
  cross join resources r
  left join planet_stock ps on ps.system_id = s.id and ps.resource = r.id
  where s.id = p_system_id
    and (exists (select 1 from system_control sc
                 where sc.system_id = p_system_id
                   and sc.controller_user_id = auth.uid())
         or exists (select 1 from production_leases l
                    where l.system_id = p_system_id and l.lessee_id = auth.uid()
                      and l.status = 'active' and lease_is_live(l)))
  order by r.sort_order;
$function$

-- ----------------------------------------
CREATE OR REPLACE FUNCTION public.load_resource_to_ship(p_ship_id uuid, p_resource text, p_amount integer)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
declare
  v_user uuid := auth.uid();
  s record; st record; v_used integer; v_need integer;
begin
  if v_user is null then raise exception 'Не авторизован'; end if;
  if p_amount < 1 then raise exception 'Некорректное количество'; end if;

  select * into s from ships where id = p_ship_id for update;
  if not found then raise exception 'Корабль не найден'; end if;
  if s.owner_user_id <> v_user then raise exception 'Это не твой корабль'; end if;
  if s.in_transit then raise exception 'Корабль в гиперпространстве'; end if;

  -- Грузить можно только со своей планеты: чужие склады берут штурмом,
  -- а не подлетают и вывозят
  if not exists (select 1 from system_control sc
                 where sc.system_id = s.system_id and sc.controller_user_id = v_user) then
    raise exception 'Планета не под твоим контролем';
  end if;

  select * into st from ship_stats(p_ship_id);
  v_used := ship_load_used(p_ship_id);
  v_need := resource_slots(p_amount);

  if v_used + v_need > st.capacity then
    raise exception 'В трюме не хватает места: занято % из %, нужно ещё %',
      v_used, st.capacity, v_need;
  end if;

  perform take_planet_stock(s.system_id, p_resource, p_amount);

  insert into ship_resource_cargo (ship_id, resource, amount)
  values (p_ship_id, p_resource, p_amount)
  on conflict (ship_id, resource) do update
    set amount = ship_resource_cargo.amount + excluded.amount;

  return st.capacity - ship_load_used(p_ship_id);
end;
$function$

-- ----------------------------------------
CREATE OR REPLACE FUNCTION public.planet_stock_cap(p_system_id text)
 RETURNS integer
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
  select game_setting_int('planet_stock_base_cap', 200)
       + case when settlement_has_district(p_system_id, 'warehouses')
              then (select effect_value from district_types where id = 'warehouses') else 0 end
       + coalesce((
           select sum(bt.storage_bonus)::integer
           from buildings b join building_types bt on bt.id = b.building_type_id
           join systems sy on sy.id = b.system_id
           where b.system_id = p_system_id
             and (b.completes_at is null or b.completes_at <= now())
             and b.faction = sy.faction
         ), 0);
$function$

-- ----------------------------------------
CREATE OR REPLACE FUNCTION public.refund_build_resources(p_system_id text, p_cost jsonb, p_share numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
declare k text; v_amt integer; v_got integer; v_out jsonb := '{}'::jsonb;
begin
  if p_cost is null or p_cost = '{}'::jsonb or coalesce(p_share, 0) <= 0 then return v_out; end if;
  for k in select jsonb_object_keys(p_cost) loop
    v_amt := floor(coalesce((p_cost ->> k)::numeric, 0) * least(1, p_share))::integer;
    continue when v_amt <= 0;
    v_got := add_planet_stock(p_system_id, k, v_amt);
    v_out := v_out || jsonb_build_object(k, coalesce(v_got, 0));
  end loop;
  return v_out;
end;
$function$

-- ----------------------------------------
CREATE OR REPLACE FUNCTION public.resource_slots(p_amount integer)
 RETURNS integer
 LANGUAGE sql
 STABLE
AS $function$
  select ceil(p_amount::numeric
              / greatest(1, game_setting_int('cargo_units_per_slot', 2)))::integer;
$function$

-- ----------------------------------------
CREATE OR REPLACE FUNCTION public.take_build_resources(p_system_id text, p_cost jsonb, p_multiplier integer DEFAULT 1)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
declare k text;
begin
  if p_cost is null or p_cost = '{}'::jsonb then return; end if;

  for k in select jsonb_object_keys(p_cost) loop
    perform take_planet_stock(p_system_id, k,
                              (p_cost ->> k)::integer * greatest(1, p_multiplier));
  end loop;
end;
$function$

-- ----------------------------------------
CREATE OR REPLACE FUNCTION public.take_planet_stock(p_system_id text, p_resource text, p_amount integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
declare v_have integer; v_name text;
begin
  if p_amount <= 0 then return; end if;

  select amount into v_have from planet_stock
  where system_id = p_system_id and resource = p_resource for update;

  if coalesce(v_have, 0) < p_amount then
    select name into v_name from resources where id = p_resource;
    raise exception 'На планете не хватает: % (нужно %, есть %)',
      coalesce(v_name, p_resource), p_amount, coalesce(v_have, 0);
  end if;

  update planet_stock set amount = amount - p_amount
  where system_id = p_system_id and resource = p_resource;
end;
$function$

-- ----------------------------------------
CREATE OR REPLACE FUNCTION public.unload_resource_from_ship(p_ship_id uuid, p_resource text, p_amount integer)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
declare
  v_user uuid := auth.uid();
  s record; v_have integer; v_sys_faction text; v_fit integer;
begin
  if v_user is null then raise exception 'Не авторизован'; end if;
  if p_amount < 1 then raise exception 'Некорректное количество'; end if;

  select * into s from ships where id = p_ship_id for update;
  if not found then raise exception 'Корабль не найден'; end if;
  if s.owner_user_id <> v_user then raise exception 'Это не твой корабль'; end if;
  if s.in_transit then raise exception 'Корабль в гиперпространстве'; end if;

  select faction into v_sys_faction from systems where id = s.system_id;
  if v_sys_faction is distinct from s.faction then
    raise exception 'Эта планета не за твою сторону';
  end if;

  select amount into v_have from ship_resource_cargo
  where ship_id = p_ship_id and resource = p_resource for update;

  if coalesce(v_have, 0) < p_amount then
    raise exception 'В трюме столько нет: есть %', coalesce(v_have, 0);
  end if;

  v_fit := add_planet_stock(s.system_id, p_resource, p_amount);

  if v_fit = 0 then
    raise exception 'Склады планеты полны, разгружать некуда';
  end if;

  if v_have - v_fit <= 0 then
    delete from ship_resource_cargo
    where ship_id = p_ship_id and resource = p_resource;
  else
    update ship_resource_cargo set amount = amount - v_fit
    where ship_id = p_ship_id and resource = p_resource;
  end if;

  perform log_event(case when coalesce(current_setting('app.supply_quiet', true), '') = 'on'
                         then null::uuid else v_user end, s.faction, s.system_id, 'cargo_delivered',
                    p_resource, v_fit, 'private', null);

  return v_fit;
end;
$function$
