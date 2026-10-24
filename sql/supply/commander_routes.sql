-- Снимок (pg_get_functiondef): дальние перелёты командира (автопрыжки). 24.10.2026
-- cancel_commander_route, commander_route_continue, get_route_candidates, start_commander_route

CREATE OR REPLACE FUNCTION public.cancel_commander_route(p_commander_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if auth.uid() is null then raise exception 'Не авторизован'; end if;
  update commanders set route = null where id = p_commander_id and user_id = auth.uid();
  if not found then raise exception 'Командир не найден'; end if;
end;
$function$

-- ----------------------------------------
CREATE OR REPLACE FUNCTION public.commander_route_continue(p_commander_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
declare c record; v_fac text; v_goal text; v_path text[]; v_prev text; v_err text;
begin
  select * into c from commanders where id = p_commander_id for update;
  if not found or c.moving_to is not null or coalesce(cardinality(c.route), 0) = 0 then
    return false;
  end if;

  v_goal := c.route[cardinality(c.route)];
  select faction into v_fac from profiles where id = c.user_id;
  v_path := convoy_route_to(c.current_system, v_goal, v_fac);

  if v_path is null or cardinality(v_path) < 2 then
    update commanders set route = null where id = c.id;
    perform log_event(c.user_id, v_fac, c.current_system, 'route_stalled',
                      'путь к цели перекрыт', 1, 'private',
                      jsonb_build_object('commander', c.name, 'goal', v_goal));
    return false;
  end if;

  -- Прыжок — той же функцией, что у игрока, от его имени: все проверки общие
  v_prev := current_setting('request.jwt.claims', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', c.user_id::text, 'role', 'authenticated')::text, true);
  begin
    perform start_commander_move(c.id, v_path[2]);
  exception when others then perform err_db('commander_route_continue', sqlstate, sqlerrm, false);
    v_err := sqlerrm;
  end;
  perform set_config('request.jwt.claims', coalesce(v_prev, ''), true);

  if v_err is not null then
    update commanders set route = null where id = c.id;
    perform log_event(c.user_id, v_fac, c.current_system, 'route_stalled', v_err, 1, 'private',
                      jsonb_build_object('commander', c.name, 'goal', v_goal));
    return false;
  end if;

  update commanders
  set route = case when cardinality(v_path) > 2 then v_path[3:] else null end
  where id = c.id;
  return true;
end;
$function$

-- ----------------------------------------
CREATE OR REPLACE FUNCTION public.get_route_candidates(p_target text)
 RETURNS TABLE(commander_id uuid, name text, from_system text, from_name text, ships integer, ready integer, fleet jsonb, cargo jsonb, resources integer, left_behind integer, route text[], route_names text[])
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_user uuid := auth.uid(); v_fac text;
begin
  if v_user is null then raise exception 'Не авторизован'; end if;
  select faction into v_fac from profiles where id = v_user;

  return query
  with cmd as (
    select c.id, c.name, c.current_system, c.slot_index, r.path
    from commanders c
    cross join lateral (select convoy_route_to(c.current_system, p_target, v_fac) as path) r
    where c.user_id = v_user and c.unlocked and c.moving_to is null
      and c.current_system is not null and c.current_system <> p_target
      and r.path is not null
      and not exists (select 1 from supply_routes sr where sr.commander_id = c.id and sr.status = 'active')
  ),
  fl as (
    select s.id, s.commander_id, s.ship_type, t.name, t.image,
           is_in_hyperspace_zone(s.y, ship_box_h(t.width_cells, t.height_cells, s.facing),
                                 hyperspace_side(s.system_id, s.faction)) as rdy
    from ships s
    join ship_types t on t.id = s.ship_type
    join cmd on cmd.id = s.commander_id and cmd.current_system = s.system_id
    where not s.in_transit and s.carrier_ship_id is null
  ),
  inside as (
    select fl.commander_id, 'fighter'::text kind, ft.name, ft.image, 1 as n
    from fl join ships f on f.carrier_ship_id = fl.id
    join ship_types ft on ft.id = f.ship_type
    union all
    select fl.commander_id, case when ut.is_hero then 'hero' when ut.is_vehicle then 'vehicle' else 'unit' end,
           coalesce(u.hero_name, ut.name), coalesce(u.portrait, ut.image), 1
    from fl join unit_positions u on u.carrier_ship_id = fl.id
    join unit_types ut on ut.id = u.unit_type
    union all
    select fl.commander_id, 'unit', ut.name, ut.image, 1
    from fl join unit_positions v on v.carrier_ship_id = fl.id
    join unit_positions u on u.carrier_unit_id = v.id
    join unit_types ut on ut.id = u.unit_type
  )
  select cmd.id, cmd.name, cmd.current_system, sy.name,
    (select count(*)::integer from fl where fl.commander_id = cmd.id),
    (select count(*)::integer from fl where fl.commander_id = cmd.id and fl.rdy),
    coalesce((select jsonb_agg(jsonb_build_object('name', g.name, 'image', g.image, 'count', g.n)
                                order by g.n desc, g.name)
              from (select fl.name, fl.image, count(*)::integer n from fl
                    where fl.commander_id = cmd.id group by fl.name, fl.image) g), '[]'::jsonb),
    coalesce((select jsonb_agg(jsonb_build_object('kind', g.kind, 'name', g.name,
                                                  'image', g.image, 'count', g.n)
                                order by g.kind, g.n desc, g.name)
              from (select i.kind, i.name, i.image, sum(i.n)::integer n from inside i
                    where i.commander_id = cmd.id group by i.kind, i.name, i.image) g), '[]'::jsonb),
    coalesce((select sum(r.amount)::integer from fl
              join ship_resource_cargo r on r.ship_id = fl.id
              where fl.commander_id = cmd.id), 0),
    (select count(*)::integer from ships s
     where s.owner_user_id = v_user and s.system_id = cmd.current_system
       and not s.in_transit and s.carrier_ship_id is null and s.commander_id is null),
    cmd.path,
    (select array_agg(coalesce(s2.name, p.sid) order by p.ord)
       from unnest(cmd.path) with ordinality p(sid, ord) left join systems s2 on s2.id = p.sid)
  from cmd
  join systems sy on sy.id = cmd.current_system
  order by cardinality(cmd.path), sy.name, cmd.slot_index;
end;
$function$

-- ----------------------------------------
CREATE OR REPLACE FUNCTION public.start_commander_route(p_commander_id uuid, p_target text)
 RETURNS text[]
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
declare v_user uuid := auth.uid(); c record; v_fac text; v_path text[];
begin
  if v_user is null then raise exception 'Не авторизован'; end if;
  select * into c from commanders where id = p_commander_id and user_id = v_user;
  if not found then raise exception 'Командир не найден'; end if;
  if not c.unlocked then raise exception 'Командир ещё не разблокирован'; end if;
  if c.moving_to is not null then raise exception 'Командир уже в пути'; end if;
  if c.current_system is null then raise exception 'Неизвестна текущая система командира'; end if;
  if c.current_system = p_target then raise exception 'Командир уже находится в этой системе'; end if;

  if exists (select 1 from supply_routes sr where sr.commander_id = c.id and sr.status = 'active') then
    raise exception 'Командир занят снабжением — сначала сними его с рейса';
  end if;

  select faction into v_fac from profiles where id = v_user;
  v_path := convoy_route_to(c.current_system, p_target, v_fac);
  if v_path is null then
    raise exception 'Нет пути через свои планеты — пролететь сквозь чужую систему нельзя';
  end if;

  perform start_commander_move(c.id, v_path[2]);

  update commanders
  set route = case when cardinality(v_path) > 2 then v_path[3:] else null end
  where id = c.id;

  return v_path;
end;
$function$
