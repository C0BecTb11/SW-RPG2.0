-- Снабжение, шаг 4: живая карта сети в окне «Снабжение» (js/supply-map.js).
-- Одним запросом: планеты своей стороны (и чужие или дальние, если там стоит или куда летит флот на рейсе),
-- гиперпути между ними, хабы на своих планетах и флоты моих живых рейсов —
-- откуда и куда летят, когда вылетели и когда прибудут. Нужды и излишки карта берёт из get_supply_network.
-- Только чтение; SECURITY DEFINER, как остальные get_supply_*: таблицы снабжения закрыты для прямого чтения.

create or replace function public.get_supply_map()
returns jsonb language plpgsql stable security definer set search_path to 'public', 'pg_temp' as $$
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
end $$;

revoke all on function public.get_supply_map() from public, anon;
grant execute on function public.get_supply_map() to authenticated;
