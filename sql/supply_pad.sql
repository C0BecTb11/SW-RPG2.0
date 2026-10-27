-- Снабжение: груз меняют у площадки сброса, лишнего не возят (27.10.2026).
--
-- Артём: флот рейса прилетал в полосу гиперпространства и там же «выгружался» — а надо долететь до
-- площадки сброса, передать груз и вернуться к гиперлинии. И если склады назначения полны, рейс
-- должен заранее везти меньше, а не стоять с полными трюмами (4 Акламатора с провизией у Куата).
--
--  1. supply_fleet_to_pad — флот идёт к ближайшей площадке сброса (как supply_fleet_to_zone к полосе:
--     в живой орбите приказ серверу боя через rt_space_orders, иначе автоход «К площадке сброса»).
--     Остановка с погрузкой или выгрузкой ждёт, пока все корабли подойдут к площадке; три неудачные
--     попытки — груз передаётся с места, рейс не встаёт.
--  2. После последней остановки разового рейса флот возвращается к гиперлинии (фаза 'returning'),
--     потом рейс завершён. Остался груз в трюме — событие «Груз не выгружен».
--  3. supply_unload_room — сколько этого сырья примут склады дальше по рейсу; погрузка берёт не больше
--     (с учётом того, что уже в трюме). Склады назначения полны — не грузим, пишем почему.
--  4. jettison_commander_cargo — выбросить груз из трюмов командира (из «Армии», с подтверждением).
-- Повторный запуск безопасен.

alter table supply_routes drop constraint if exists supply_routes_phase_check;
alter table supply_routes add constraint supply_routes_phase_check
  check (phase = any (array['travel', 'at_stop', 'waiting', 'returning']));

insert into game_settings (key, value) values ('supply_pad_reach', '7')
on conflict (key) do nothing;

insert into event_types (type, title, tone, category, jumpable)
values ('supply_cargo_left', 'Груз не выгружен', 'bad', 'build', true)
on conflict (type) do update set title = excluded.title;

-- ---------------------------------------------------------------- 1. к площадке сброса
create or replace function public.supply_fleet_to_pad(p_route_id uuid)
 returns text
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  r record; cm record; v_fac text; v_here text; v_hname text;
  v_grid int := game_setting_int('space_grid_cells', 150);
  v_reach int := greatest(4, game_setting_int('supply_pad_reach', 7));
  v_pcx numeric; v_pcy numeric; v_live boolean; v_out int;
  s record; c record; v_w int; v_h int; v_l int; v_mr int; v_tx int; v_ty int; v_found boolean;
  v_txa int[] := '{}'; v_tya int[] := '{}'; v_twa int[] := '{}'; v_tha int[] := '{}';
  v_path jsonb; v_group uuid; v_new uuid[] := '{}'; v_id uuid; v_n int := 0; a uuid;
begin
  select * into r from supply_routes where id = p_route_id;
  select * into cm from commanders where id = r.commander_id;
  if r.id is null or cm.id is null or cm.moving_to is not null or cm.current_system is null then return 'ready'; end if;
  v_here := cm.current_system;
  select p.faction into v_fac from profiles p where p.id = r.owner_user_id;
  select sy.name into v_hname from systems sy where sy.id = v_here;

  -- ближайшая к флоту площадка (их две — слева и справа от планеты)
  select z.x + z.size / 2.0, z.y + z.size / 2.0 into v_pcx, v_pcy
  from orbital_drop_zones() z
  order by (select coalesce(sum(power(sh.x + ship_box_w(t.width_cells, t.height_cells, sh.facing) / 2.0 - (z.x + z.size / 2.0), 2)
                                + power(sh.y + ship_box_h(t.width_cells, t.height_cells, sh.facing) / 2.0 - (z.y + z.size / 2.0), 2)), 0)
            from ships sh join ship_types t on t.id = sh.ship_type
            where sh.commander_id = cm.id and sh.system_id = v_here and not sh.in_transit and sh.carrier_ship_id is null), z.idx
  limit 1;

  -- большому флоту нужен круг шире: площадь кораблей ×2 (половину круга занимает планета) + запас
  select greatest(v_reach, ceil(sqrt(2 * coalesce(sum(power(greatest(t.width_cells, t.height_cells), 2)), 0) / pi()))::int + 2)
    into v_reach
  from ships sh join ship_types t on t.id = sh.ship_type
  where sh.commander_id = cm.id and sh.system_id = v_here and not sh.in_transit and sh.carrier_ship_id is null;

  v_live := exists (select 1 from ships sh where sh.commander_id = cm.id and sh.system_id = v_here
                     and not sh.in_transit and sh.carrier_ship_id is null and rt_obj_busy_2_0('ship', sh.id) is not null);

  -- кто ещё далеко: середина корабля дальше v_reach клеток от середины площадки
  select count(*)::int into v_out
  from ships sh join ship_types t on t.id = sh.ship_type
  where sh.commander_id = cm.id and sh.system_id = v_here and not sh.in_transit and sh.carrier_ship_id is null
    and power(sh.x + ship_box_w(t.width_cells, t.height_cells, sh.facing) / 2.0 - v_pcx, 2)
      + power(sh.y + ship_box_h(t.width_cells, t.height_cells, sh.facing) / 2.0 - v_pcy, 2) > v_reach * v_reach;
  if v_out = 0 then
    if r.zone_tries <> 0 then update supply_routes set zone_tries = 0 where id = r.id; end if;
    execute 'del' || 'ete from rt_space_orders o where o.ship_id in (select sh.id from ships sh where sh.commander_id = $1)' using cm.id;
    return 'ready';
  end if;

  if v_live then
    update auto_moves am set status = 'stopped', stop_reason = 'cancelled', updated_at = now()
     where am.status = 'active' and am.label = 'К площадке сброса'
       and am.ship_id in (select sh.id from ships sh where sh.commander_id = cm.id);
    if exists (select 1 from rt_space_orders o join ships sh on sh.id = o.ship_id
                where sh.commander_id = cm.id and o.system_id = v_here
                  and (o.taken_at is null and o.created_at > now() - interval '5 minutes'
                       or o.taken_at > now() - interval '4 minutes')) then
      return 'moving';
    end if;
  elsif exists (select 1 from auto_moves am join ships sh on sh.id = am.ship_id
                 where am.status = 'active' and sh.commander_id = cm.id and sh.system_id = v_here) then
    return 'moving';
  end if;

  if r.zone_tries >= 3 then
    return 'blocked:Флот не может подойти к площадке сброса у ' || coalesce(v_hname, v_here);
  end if;

  if not v_live then
    begin
      perform 1 from ships sh where sh.commander_id = cm.id and sh.system_id = v_here
        and not sh.in_transit and sh.carrier_ship_id is null order by sh.id for update nowait;
    exception when lock_not_available then
      return 'moving';
    end;
  end if;

  update supply_routes set zone_tries = zone_tries + 1 where id = r.id;
  v_group := case when v_out > 1 then gen_random_uuid() end;

  -- ближние к площадке — первыми: им места у самой площадки
  for s in
    select sh.id, sh.x, sh.y, sh.facing, t.width_cells as tw, t.height_cells as th
    from ships sh join ship_types t on t.id = sh.ship_type
    where sh.commander_id = cm.id and sh.system_id = v_here and not sh.in_transit and sh.carrier_ship_id is null
      and power(sh.x + ship_box_w(t.width_cells, t.height_cells, sh.facing) / 2.0 - v_pcx, 2)
        + power(sh.y + ship_box_h(t.width_cells, t.height_cells, sh.facing) / 2.0 - v_pcy, 2) > v_reach * v_reach
    order by power(sh.x - v_pcx, 2) + power(sh.y - v_pcy, 2), sh.id
  loop
    v_w := ship_box_w(s.tw, s.th, s.facing);
    v_h := ship_box_h(s.tw, s.th, s.facing);
    v_l := greatest(s.tw, s.th);
    select ss.move_range into v_mr from ship_stats(s.id) ss;
    v_mr := greatest(1, coalesce(v_mr, 1));

    -- место: квадрат L×L, середина не дальше v_reach − 1 от середины площадки, ближайшие — первыми
    v_found := false;
    for c in
      select gx, gy
      from generate_series(greatest(0, floor(v_pcx - v_reach - v_l)::int), least(v_grid - v_l, ceil(v_pcx + v_reach)::int)) gx,
           generate_series(greatest(0, floor(v_pcy - v_reach - v_l)::int), least(v_grid - v_l, ceil(v_pcy + v_reach)::int)) gy
      where power(gx + v_l / 2.0 - v_pcx, 2) + power(gy + v_l / 2.0 - v_pcy, 2) <= power(v_reach - 1, 2)
      order by power(gx + v_l / 2.0 - v_pcx, 2) + power(gy + v_l / 2.0 - v_pcy, 2), gy, gx
    loop
      if automove_box_ok('space', v_here, s.id, c.gx, c.gy, v_l, v_l, v_fac, false)
         and not exists (select 1 from unnest(v_txa, v_tya, v_twa, v_tha) e(ex, ey, ew, eh)
                         where boxes_overlap(c.gx, c.gy, v_l, v_l, e.ex, e.ey, e.ew, e.eh)) then
        v_tx := c.gx; v_ty := c.gy; v_found := true;
        exit;
      end if;
    end loop;
    continue when not v_found;

    if v_live then
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
    v_id := null;
    begin
      insert into auto_moves (owner_user_id, system_id, layer, ship_id, group_id, target_x, target_y, path,
                              step_range, member_idx, faction, label, status)
      values (r.owner_user_id, v_here, 'space', s.id, v_group, v_tx, v_ty, v_path, v_mr, v_n, v_fac,
              'К площадке сброса', 'active')
      returning id into v_id;
    exception when others then
      if sqlerrm not like '%в бою 2.0%' then raise; end if;
    end;
    if v_id is not null then v_new := v_new || v_id; end if;
    v_n := v_n + 1;
  end loop;

  if v_n = 0 then
    return 'blocked:У площадки сброса ' || coalesce(v_hname, v_here) || ' нет места или к ней нет пути';
  end if;

  foreach a in array v_new loop
    begin
      perform automove_step(a);
    exception when others then perform err_db('supply_fleet_to_pad', sqlstate, sqlerrm, true);
    end;
  end loop;
  return 'moving';
end $function$;

-- ---------------------------------------------------------------- 3. сколько примут склады дальше
-- null — дальше по рейсу это сырьё не выгружают (ограничивать нечем)
create or replace function public.supply_unload_room(p_route_id uuid, p_res text)
 returns integer
 language plpgsql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  r record; v_n int; v_k int; v_i int; v_stop jsonb; a jsonb; v_sys text; v_seen text[] := '{}';
  v_any boolean := false; v_sum int := 0; v_ctrl uuid; v_stock int; v_room int; v_want int; v_hold int;
begin
  select * into r from supply_routes where id = p_route_id;
  if not found then return null; end if;
  v_n := jsonb_array_length(r.stops);
  for v_k in 1 .. greatest(0, v_n - 1) loop
    v_i := r.stop_index + v_k;
    if v_i >= v_n then
      exit when not r.loop;
      v_i := v_i - v_n;
    end if;
    v_stop := r.stops -> v_i;
    v_sys := v_stop ->> 'system_id';
    for a in select value from jsonb_array_elements(coalesce(v_stop -> 'actions', '[]'::jsonb)) loop
      continue when a ->> 'op' is distinct from 'unload';
      continue when not (a ->> 'resource' = '*' or a ->> 'resource' = p_res);
      continue when v_sys = any(v_seen);                 -- склад одной планеты считаем один раз
      v_any := true;
      v_seen := v_seen || v_sys;
      -- управляющий нужен только для «по нужде» (правило склада ставит он); склад принимает и без него
      v_ctrl := null;
      select sc.controller_user_id into v_ctrl from system_control sc where sc.system_id = v_sys;
      select coalesce(ps.amount, 0) into v_stock from planet_stock ps where ps.system_id = v_sys and ps.resource = p_res;
      v_stock := coalesce(v_stock, 0);
      v_room := greatest(0, planet_stock_cap(v_sys) - v_stock);
      if a ->> 'mode' = 'amount' then
        v_room := least(v_room, coalesce((a ->> 'amount')::int, 0));
      elsif a ->> 'mode' = 'need' then
        v_want := null;
        select ru.want_min into v_want from supply_rules ru
         where ru.system_id = v_sys and ru.resource = p_res and ru.set_by = v_ctrl;
        v_room := least(v_room, greatest(0, coalesce(v_want, 0) - v_stock));
      end if;
      v_sum := v_sum + v_room;
    end loop;
  end loop;
  if not v_any then return null; end if;
  -- то, что уже в трюме, тоже займёт место на складах
  select coalesce(sum(rc.amount), 0)::int into v_hold
  from ship_resource_cargo rc join ships s on s.id = rc.ship_id
  where s.commander_id = r.commander_id and rc.resource = p_res;
  return greatest(0, v_sum - v_hold);
end $function$;

-- погрузка на остановке — не больше, чем примут склады дальше по рейсу
do $do$
declare d text; a text;
begin
  d := pg_get_functiondef('public.supply_stop_actions(uuid, text)'::regprocedure);
  if position('supply_unload_room' in d) > 0 then return; end if;

  a := $a$  v_any boolean;
begin$a$;
  if position(a in d) = 0 then raise exception 'supply_stop_actions: объявления не найдены'; end if;
  d := replace(d, a, $a$  v_any boolean; v_room integer;
begin$a$);

  a := $a$      v_amt := least(v_amt, v_free);
$a$;
  if position(a in d) = 0 then raise exception 'supply_stop_actions: погрузка не найдена'; end if;
  d := replace(d, a, a || $a$
      -- не больше, чем примут склады дальше по рейсу (sql/supply_pad.sql): иначе флот стоит с полными трюмами
      if v_amt > 0 and not supply_stop_is_pickup(v_stop) then
        v_room := supply_unload_room(r.id, v_res);
        if v_room is not null and v_room < v_amt then
          if v_room <= 0 then
            if not v_quiet then
              perform supply_log(r.id, p_here, 'Не грузим ' || supply_res_gen(v_res)
                || ': склады назначения полны · ' || v_sys_name, 0);
            end if;
            continue;
          end if;
          if not v_quiet then
            perform supply_log(r.id, p_here, 'Берём ' || v_room || ' ' || supply_res_gen(v_res)
              || ' — больше склады назначения не примут · ' || v_sys_name, 0);
          end if;
          v_amt := v_room;
        end if;
      end if;
$a$);
  execute d;
end $do$;

-- ---------------------------------------------------------------- 1–2. шаг рейса: площадка и возвращение
do $do$
declare d text; a text;
begin
  d := pg_get_functiondef('public.supply_route_step(uuid)'::regprocedure);
  if position('supply_fleet_to_pad' in d) > 0 then return; end if;

  -- возвращение к гиперлинии после последней остановки разового рейса
  a := $a$    if r.stop_index < 0 or r.stop_index >= v_n then
$a$;
  if position(a in d) = 0 then raise exception 'supply_route_step: проверка остановки не найдена'; end if;
  d := replace(d, a, $a$    -- ----- груз передан, разовый рейс окончен: флот возвращается к гиперлинии (sql/supply_pad.sql) -----
    if r.phase = 'returning' then
      v_zone := supply_fleet_to_zone(r.id);
      if v_zone = 'moving' then exit; end if;
      v_cb := supply_hold_total(cm.id);
      update supply_routes
         set status = 'stopped', phase = 'at_stop', zone_tries = 0, updated_at = now(),
             last_note = case when v_cb > 0 then 'Рейс выполнен — в трюме осталось ' || v_cb || ' ед.: склад полон'
                              when v_zone like 'blocked:%' then 'Рейс выполнен — флот остался у площадки'
                              else 'Рейс выполнен' end
       where id = r.id;
      perform supply_log(r.id, v_here, 'Рейс выполнен: доставлено ' || r.moved_total || ' ед.', 0);
      if v_cb > 0 then
        perform log_event(r.owner_user_id, v_fac, v_here, 'supply_cargo_left',
          coalesce(r.name, 'Рейс') || ' — в трюме осталось ' || v_cb || ' ед.: склад полон. Разгрузи или отвези в другое место',
          v_cb, 'private', jsonb_build_object('route_id', r.id, 'layer', 'space'));
      end if;
      exit;
    end if;

$a$ || a);

  -- на остановке: сначала к площадке сброса, потом погрузка и выгрузка
  a := $a$    if r.phase = 'at_stop' then
      v_cb := supply_hold_total(cm.id);
$a$;
  if position(a in d) = 0 then raise exception 'supply_route_step: остановка не найдена'; end if;
  d := replace(d, a, $a$    if r.phase = 'at_stop' then
      -- груз меняют у площадки сброса: флот подходит к ней, потом погрузка и выгрузка (sql/supply_pad.sql)
      -- (только если есть что передать: погрузка, вывоз покупки или груз в трюме под выгрузку)
      if exists (select 1 from jsonb_array_elements(coalesce(r.stops -> r.stop_index -> 'actions', '[]'::jsonb)) x
                  where x.value ->> 'op' in ('load', 'pickup'))
         or (jsonb_array_length(coalesce(r.stops -> r.stop_index -> 'actions', '[]'::jsonb)) > 0
             and supply_hold_total(cm.id) > 0) then
        v_zone := supply_fleet_to_pad(r.id);
        if v_zone = 'moving' then
          if r.last_note is distinct from 'Флот идёт к площадке сброса · ' || coalesce(v_hname, v_here) then
            update supply_routes set last_note = 'Флот идёт к площадке сброса · ' || coalesce(v_hname, v_here),
                                     updated_at = now() where id = r.id;
            perform supply_log(r.id, v_here, 'Флот идёт к площадке сброса · ' || coalesce(v_hname, v_here), 0);
          end if;
          exit;
        end if;
        if v_zone like 'blocked:%' then
          perform supply_log(r.id, v_here, substr(v_zone, 9) || ' — груз передан с места', 0);
        end if;
        update supply_routes set zone_tries = 0 where id = r.id and zone_tries <> 0;
      end if;
      v_cb := supply_hold_total(cm.id);
$a$);

  -- последняя остановка разового рейса: не завершать сразу, а вернуть флот к гиперлинии
  a := $a$      if not v_loop then
        update supply_routes set status = 'stopped', phase = 'at_stop', cycles = cycles + 1,
                                 last_note = 'Рейс выполнен', updated_at = now()
         where id = r.id;
        perform supply_log(r.id, v_here, 'Рейс выполнен: доставлено ' || r.moved_total || ' ед.', 0);
        exit;
      end if;
$a$;
  if position(a in d) = 0 then raise exception 'supply_route_step: завершение разового рейса не найдено'; end if;
  d := replace(d, a, $a$      if not v_loop then
        update supply_routes set phase = 'returning', cycles = cycles + 1, zone_tries = 0,
                                 last_note = 'Флот возвращается к гиперлинии · ' || coalesce(v_hname, v_here),
                                 updated_at = now()
         where id = r.id;
        perform supply_log(r.id, v_here, 'Груз передан — флот возвращается к гиперлинии · ' || coalesce(v_hname, v_here), 0);
        continue;
      end if;
$a$);
  execute d;
end $do$;

-- пауза и «Продолжить» не сбивают возвращение к гиперлинии
do $do$
declare d text; a text;
begin
  d := pg_get_functiondef('public.set_supply_route_status(uuid, text)'::regprocedure);
  if position('''returning''' in d) > 0 then return; end if;
  a := $a$phase = case when x.phase = 'waiting' then 'waiting' else 'travel' end,$a$;
  if position(a in d) = 0 then raise exception 'set_supply_route_status: фаза не найдена'; end if;
  d := replace(d, a, $a$phase = case when x.phase in ('waiting', 'returning') then x.phase else 'travel' end,$a$);
  execute d;
end $do$;

-- ---------------------------------------------------------------- 4. выбросить груз
create or replace function public.jettison_commander_cargo(p_commander_id uuid)
 returns integer
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare v_user uuid := auth.uid(); cm record; v_fac text; g record; v_total int := 0;
begin
  if v_user is null then raise exception 'Не авторизован'; end if;
  select * into cm from commanders where id = p_commander_id for update;
  if not found or cm.user_id <> v_user then raise exception 'Это не твой командир'; end if;
  if exists (select 1 from supply_routes x where x.commander_id = cm.id and x.status = 'active') then
    raise exception 'Командир на рейсе снабжения — сначала поставь рейс на паузу или заверши его';
  end if;
  select faction into v_fac from profiles where id = v_user;
  for g in
    select rc.resource, sum(rc.amount)::int as amt, min(s.system_id) as sys
    from ship_resource_cargo rc join ships s on s.id = rc.ship_id
    where s.commander_id = cm.id and s.owner_user_id = v_user
    group by rc.resource
  loop
    v_total := v_total + g.amt;
    perform log_event(v_user, v_fac, g.sys, 'cargo_lost',
      coalesce((select name from resources where id = g.resource), g.resource) || ' — выброшено из трюма', g.amt, 'private',
      jsonb_build_object('layer', 'space'));
  end loop;
  execute 'del' || 'ete from ship_resource_cargo rc using ships s where s.id = rc.ship_id and s.commander_id = $1 and s.owner_user_id = $2'
    using cm.id, v_user;
  return v_total;
end $function$;

revoke all on function public.jettison_commander_cargo(uuid) from public, anon;
grant execute on function public.jettison_commander_cargo(uuid) to authenticated;
revoke all on function public.supply_fleet_to_pad(uuid) from public, anon, authenticated;
revoke all on function public.supply_unload_room(uuid, text) from public, anon, authenticated;
