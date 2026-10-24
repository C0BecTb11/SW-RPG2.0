-- Снимок (pg_get_functiondef): груз в трюмах, окончание перелёта, чтение конвоев. 24.10.2026
-- boarding_drop_cargo, check_cargo_owner, commander_free_cargo, finish_commander_move, finish_due_commander_moves,
-- get_convoy_commanders, get_convoy_destinations, get_drop_ready_cargo, get_my_convoys, get_ship_resource_cargo,
-- log_lost_cargo, ship_load_used, supply_hold_total

CREATE OR REPLACE FUNCTION public.boarding_drop_cargo(p_ship uuid)
 RETURNS void
 LANGUAGE sql
 SET search_path TO 'public', 'pg_temp'
AS $function$
  delete from ship_cargo where ship_id = p_ship;
$function$

-- ----------------------------------------
CREATE OR REPLACE FUNCTION public.check_cargo_owner()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
declare
  v_owner uuid;
begin
  select owner_user_id into v_owner from ships where id = new.ship_id;
  if v_owner is distinct from auth.uid() and auth.uid() is not null then
    raise exception 'Это не твой корабль';
  end if;
  return new;
end;
$function$

-- ----------------------------------------
CREATE OR REPLACE FUNCTION public.commander_free_cargo(p_commander_id uuid)
 RETURNS integer
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
  select coalesce(sum(greatest(0, st.capacity - ship_load_used(s.id))), 0)::integer
         * game_setting_int('cargo_units_per_slot', 2)
  from ships s
  cross join lateral ship_stats(s.id) st
  where s.commander_id = p_commander_id and not s.in_transit;
$function$

-- ----------------------------------------
CREATE OR REPLACE FUNCTION public.finish_commander_move(p_commander_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_from text;
  v_to text;
  sh record;
begin
  select moving_from, moving_to into v_from, v_to
  from commanders
  where id = p_commander_id and moving_to is not null and arrives_at <= now()
  for update;

  if v_to is null then
    return;
  end if;

  update commanders
  set current_system = moving_to,
      moving_from = null,
      moving_to = null,
      departed_at = null,
      arrives_at = null
  where id = p_commander_id and moving_to is not null;

  for sh in
    select id from ships
    where commander_id = p_commander_id and system_id = v_from
      and in_transit and carrier_ship_id is null
    order by id
  loop
    perform place_ship_in_hyperspace(sh.id, v_to);
  end loop;

  perform unload_convoy_on_arrival(p_commander_id);

  -- Дальний маршрут: следующий прыжок без участия игрока
  perform commander_route_continue(p_commander_id);
end;
$function$

-- ----------------------------------------
CREATE OR REPLACE FUNCTION public.finish_due_commander_moves()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  c record; sh record;
begin
  for c in
    select id from commanders
    where moving_to is not null and arrives_at <= now()
  loop
    begin
      perform finish_commander_move(c.id);
    exception when others then
      perform err_db('finish_due_commander_moves', sqlstate, sqlerrm, true);
    end;
  end loop;

  for sh in
    select s.id, cm.current_system
    from ships s
    join commanders cm on cm.id = s.commander_id
    where s.in_transit and s.carrier_ship_id is null
      and cm.moving_to is null and cm.current_system is not null
    for update of s skip locked
  loop
    begin
      perform place_ship_in_hyperspace(sh.id, sh.current_system);
    exception when others then
      perform err_db('finish_due_commander_moves.place', sqlstate, sqlerrm, true);
    end;
  end loop;
end;
$function$

-- ----------------------------------------
CREATE OR REPLACE FUNCTION public.get_convoy_commanders(p_system_id text)
 RETURNS TABLE(commander_id uuid, name text, ships integer, ready integer, free_units integer, busy boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
  select c.id, c.name,
         (select count(*)::integer from ships s
          where s.commander_id = c.id and s.system_id = p_system_id and not s.in_transit),
         (select count(*)::integer from ships s join ship_types t on t.id = s.ship_type
          where s.commander_id = c.id and s.system_id = p_system_id and not s.in_transit
            and is_in_hyperspace_zone(s.y, ship_box_h(t.width_cells, t.height_cells, s.facing),
                                      hyperspace_side(p_system_id, s.faction))),
         commander_free_cargo(c.id),
         c.moving_to is not null
  from commanders c
  where c.user_id = auth.uid() and c.unlocked and c.current_system = p_system_id
  order by c.slot_index;
$function$

-- ----------------------------------------
CREATE OR REPLACE FUNCTION public.get_convoy_destinations(p_from text)
 RETURNS TABLE(system_id text, name text, hops integer, seconds integer, controlled boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
  with me as (select faction from profiles where id = auth.uid()),
  t as (select coalesce((select value::integer from game_settings
                         where key = 'travel_seconds'), 60) as sec)
  select s.id, s.name,
         array_length(convoy_route(p_from, s.id, me.faction), 1) - 1,
         (array_length(convoy_route(p_from, s.id, me.faction), 1) - 1) * t.sec,
         exists (select 1 from system_control sc
                 where sc.system_id = s.id and sc.controller_user_id = auth.uid())
  from systems s, me, t
  where s.id <> p_from and not s.is_deep_space and s.faction = me.faction
    and convoy_route(p_from, s.id, me.faction) is not null
  order by 3, s.name;
$function$

-- ----------------------------------------
CREATE OR REPLACE FUNCTION public.get_drop_ready_cargo(p_system_id text)
 RETURNS TABLE(ship_id uuid, ship_name text, zone integer, unit_type text, unit_name text, unit_image text, quantity integer, x integer, y integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
  select s.id, coalesce(s.name, st.name),
         is_in_orbital_drop(s.x, s.y,
           ship_box_w(st.width_cells, st.height_cells, s.facing),
           ship_box_h(st.width_cells, st.height_cells, s.facing)),
         u.unit_type, ut.name, ut.image, count(*)::integer, s.x, s.y
  from ships s
  join ship_types st on st.id = s.ship_type
  join unit_positions u on u.carrier_ship_id = s.id
  join unit_types ut on ut.id = u.unit_type
  where s.system_id = p_system_id
    and s.owner_user_id = auth.uid()
    and not s.in_transit
    and not coalesce(ut.is_vehicle, false) and not coalesce(ut.is_hero, false)
  group by s.id, st.name, st.width_cells, st.height_cells, s.facing, s.x, s.y,
           u.unit_type, ut.name, ut.image
  order by st.name, ut.name;
$function$

-- ----------------------------------------
CREATE OR REPLACE FUNCTION public.get_my_convoys()
 RETURNS TABLE(id uuid, kind text, stage text, from_name text, to_name text, pickup_name text, cargo_text text, seconds_left integer, status text, return_home boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
  select c.id, c.kind, c.stage, sf.name, st.name, sp.name,
         coalesce(
           (select string_agg(r.name || ' ' || (c.cargo ->> r.id), ', ' order by r.sort_order)
            from resources r where c.cargo ? r.id),
           (select r.name || ' ' || o.amount_left
            from market_orders o join market_lots l on l.id = o.lot_id
            join resources r on r.id = l.resource where o.id = c.order_id)),
         greatest(0, ceil(extract(epoch from coalesce(cm.arrives_at, now()) - now()))::integer),
         c.status, c.return_home
  from convoys c
  join systems sf on sf.id = c.from_system
  join systems st on st.id = c.to_system
  left join systems sp on sp.id = c.pickup_system
  left join commanders cm on cm.id = c.commander_id
  where c.owner_user_id = auth.uid()
    and (c.cargo is not null or c.kind = 'market')
    and (c.status in ('in_flight','stalled') or c.departed_at > now() - interval '1 day')
  order by c.departed_at desc;
$function$

-- ----------------------------------------
CREATE OR REPLACE FUNCTION public.get_ship_resource_cargo(p_ship_id uuid)
 RETURNS TABLE(resource text, name text, amount integer, slots integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
  select rc.resource, r.name, rc.amount, resource_slots(rc.amount)
  from ship_resource_cargo rc
  join resources r on r.id = rc.resource
  join ships s on s.id = rc.ship_id
  where rc.ship_id = p_ship_id and s.owner_user_id = auth.uid()
  order by r.sort_order;
$function$

-- ----------------------------------------
CREATE OR REPLACE FUNCTION public.log_lost_cargo()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
declare r record;
begin
  for r in select resource, amount from ship_resource_cargo where ship_id = old.id loop
    perform log_event(old.owner_user_id, old.faction, old.system_id,
                      'cargo_lost', r.resource, r.amount, 'private', null);
  end loop;
  return old;
end;
$function$

-- ----------------------------------------
CREATE OR REPLACE FUNCTION public.ship_load_used(p_ship_id uuid)
 RETURNS integer
 LANGUAGE sql
 STABLE
AS $function$
  select coalesce((
           select sum(c.quantity * coalesce(t.slot_size, 1))
           from ship_cargo c join unit_types t on t.id = c.unit_type
           where c.ship_id = p_ship_id
         ), 0)
       + coalesce((
           select sum(unit_total_slots(v.id))
           from unit_positions v
           where v.carrier_ship_id = p_ship_id
         ), 0)
       + coalesce((
           select sum(resource_slots(rc.amount))::integer
           from ship_resource_cargo rc
           where rc.ship_id = p_ship_id
         ), 0);
$function$

-- ----------------------------------------
CREATE OR REPLACE FUNCTION public.supply_hold_total(p_commander_id uuid)
 RETURNS integer
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select coalesce(sum(rc.amount), 0)::integer
  from ship_resource_cargo rc join ships s on s.id = rc.ship_id
  where s.commander_id = p_commander_id;
$function$
