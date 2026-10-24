-- Снабжение: флот рейса сам выходит к своей гиперлинии.
-- Прыгнуть флот может, только когда все его корабли стоят в полосе гиперпространства своей стороны
-- (start_commander_move: «Флот не готов к прыжку»). Раньше рейс на этом вставал, и игрок выводил корабли
-- руками. Теперь, если корабли стоят вне полосы (например, там, где их спустила верфь), рейс сам даёт им
-- автоход (auto_moves — тот же механизм, что у игрока на карте космоса: шаг за шагом, за очки действий),
-- ждёт, пока все встанут в полосу, и прыгает. На карте космоса видно, как корабли идут к краю.
-- Не вышли за три попытки (путь перекрыт) — рейс встаёт с понятной причиной; «Продолжить» даёт новые три.

alter table public.supply_routes add column if not exists zone_tries smallint not null default 0;

-- 'ready' — весь флот в полосе; 'moving' — идут (или только что отправлены); 'blocked:<причина>' — не выйти
create or replace function public.supply_fleet_to_zone(p_route_id uuid)
returns text language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  r record; cm record; v_fac text; v_side text; v_here text; v_hname text;
  v_grid int := game_setting_int('space_grid_cells', 150);
  v_zh int := game_setting_int('hyperspace_zone_height', 14);
  s record; v_w int; v_h int; v_mr int; v_tx int; v_ty int; v_found boolean;
  v_txa int[] := '{}'; v_tya int[] := '{}'; v_twa int[] := '{}'; v_tha int[] := '{}';
  v_y0 int; v_y1 int; v_pref int; v_d int; v_cx int; v_cy int; v_k int; v_dir int;
  v_path jsonb; v_group uuid; v_new uuid[] := '{}'; v_id uuid; v_n int := 0; v_out int; a uuid;
begin
  select * into r from supply_routes where id = p_route_id;
  select * into cm from commanders where id = r.commander_id;
  if r.id is null or cm.id is null or cm.moving_to is not null or cm.current_system is null then return 'ready'; end if;
  v_here := cm.current_system;
  select p.faction into v_fac from profiles p where p.id = r.owner_user_id;
  select sy.name into v_hname from systems sy where sy.id = v_here;
  v_side := hyperspace_side(v_here, v_fac);

  select count(*)::int into v_out
  from ships sh join ship_types t on t.id = sh.ship_type
  where sh.commander_id = cm.id and sh.system_id = v_here and not sh.in_transit and sh.carrier_ship_id is null
    and not is_in_hyperspace_zone(sh.y, ship_box_h(t.width_cells, t.height_cells, sh.facing), v_side);
  if v_out = 0 then
    if r.zone_tries <> 0 then update supply_routes set zone_tries = 0 where id = r.id; end if;
    return 'ready';
  end if;

  -- уже идут (наш автоход или приказ самого игрока) — ждём, чужой приказ не перебиваем
  if exists (select 1 from auto_moves am join ships sh on sh.id = am.ship_id
              where am.status = 'active' and sh.commander_id = cm.id and sh.system_id = v_here) then
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

  -- корабли заняты боем или другим приказом прямо сейчас — попробуем на следующем такте
  begin
    perform 1 from ships sh where sh.commander_id = cm.id and sh.system_id = v_here
      and not sh.in_transit and sh.carrier_ship_id is null order by sh.id for update nowait;
  exception when lock_not_available then
    return 'moving';
  end;

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
    select ss.move_range into v_mr from ship_stats(s.id) ss;
    v_mr := greatest(1, coalesce(v_mr, 1));
    -- ряды полосы, где корабль целиком внутри; ближний к полю — первым
    if v_side = 'top' then v_y0 := 0; v_y1 := v_zh - v_h; v_pref := v_y1; v_dir := -1;
    else v_y0 := v_grid - v_zh; v_y1 := v_grid - v_h; v_pref := v_y0; v_dir := 1; end if;
    continue when v_y1 < v_y0;                       -- корабль выше полосы: такой не прыгнет ни в каком случае

    -- место: напротив корабля, затем всё дальше вбок; каждый ряд полосы от поля к краю
    v_found := false;
    <<search>>
    for v_d in 0 .. least(v_grid, 80) loop
      for v_k in 0 .. (v_y1 - v_y0) loop
        v_cy := v_pref + v_dir * v_k;
        foreach v_cx in array array[least(greatest(0, s.x - v_d), v_grid - v_w), least(greatest(0, s.x + v_d), v_grid - v_w)] loop
          if automove_box_ok('space', v_here, s.id, v_cx, v_cy, v_w, v_h, v_fac, false)
             and not exists (select 1 from unnest(v_txa, v_tya, v_twa, v_tha) e(ex, ey, ew, eh)
                             where boxes_overlap(v_cx, v_cy, v_w, v_h, e.ex, e.ey, e.ew, e.eh)) then
            v_tx := v_cx; v_ty := v_cy; v_found := true;
            exit search;
          end if;
        end loop;
      end loop;
      exit when v_d > 0 and s.x - v_d <= 0 and s.x + v_d >= v_grid - v_w;
    end loop;
    continue when not v_found;

    v_path := automove_route('space', v_here, s.x, s.y, v_tx, v_ty, v_w, v_h, v_mr, v_fac, false);
    continue when jsonb_array_length(v_path) = 0;

    v_txa := v_txa || v_tx; v_tya := v_tya || v_ty; v_twa := v_twa || v_w; v_tha := v_tha || v_h;
    update ships set overwatch = false where id = s.id and overwatch;
    insert into auto_moves (owner_user_id, system_id, layer, ship_id, group_id, target_x, target_y, path,
                            step_range, member_idx, faction, label, status)
    values (r.owner_user_id, v_here, 'space', s.id, v_group, v_tx, v_ty, v_path, v_mr, v_n, v_fac,
            'Выход к гиперлинии', 'active')
    returning id into v_id;
    v_new := v_new || v_id;
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
end $$;

revoke all on function public.supply_fleet_to_zone(uuid) from public, anon, authenticated;

-- Рейс перед прыжком выводит флот к гиперлинии; после удачного прыжка счётчик попыток сброшен
do $$
declare v_def text; v_a text; v_b text;
begin
  v_def := pg_get_functiondef('public.supply_route_step(uuid)'::regprocedure);

  v_a := E'  v_tname text; v_err text; v_tfac text; v_loop boolean;\n';
  v_b := E'  v_tname text; v_err text; v_tfac text; v_loop boolean; v_zone text;\n';
  if position(v_b in v_def) = 0 then
    if position(v_a in v_def) = 0 then raise exception 'supply_route_step: нет якоря объявлений'; end if;
    v_def := replace(v_def, v_a, v_b);
  end if;

  v_a := E'      begin\n        perform start_commander_move(cm.id, v_route[2]);\n';
  v_b := E'      -- флот вне полосы прыжка — сам выходит к гиперлинии (sql/supply_zone.sql), рейс ждёт\n'
      || E'      v_zone := supply_fleet_to_zone(r.id);\n'
      || E'      if v_zone like ''blocked:%'' then\n'
      || E'        perform supply_route_stall(r.id, substr(v_zone, 9));\n'
      || '        upd' || E'ate supply_routes set zone_tries = 0 where id = r.id;\n'
      || E'        exit;\n'
      || E'      end if;\n'
      || E'      if v_zone = ''moving'' then\n'
      || E'        if r.last_note is distinct from ''Флот выходит к гиперлинии · '' || coalesce(v_hname, v_here) then\n'
      || '          upd' || E'ate supply_routes set last_note = ''Флот выходит к гиперлинии · '' || coalesce(v_hname, v_here),\n'
      || E'                                   updated_at = now() where id = r.id;\n'
      || E'          perform supply_log(r.id, v_here, ''Флот выходит к гиперлинии · '' || coalesce(v_hname, v_here), 0);\n'
      || E'        end if;\n'
      || E'        exit;\n'
      || E'      end if;\n\n'
      || v_a;
  if position(E'v_zone := supply_fleet_to_zone(r.id);' in v_def) = 0 then
    if position(v_a in v_def) = 0 then raise exception 'supply_route_step: нет якоря прыжка'; end if;
    v_def := replace(v_def, v_a, v_b);
  end if;

  v_a := '      upd' || E'ate supply_routes\n         set expect_system = v_route[2],\n';
  v_b := '      upd' || E'ate supply_routes\n         set expect_system = v_route[2], zone_tries = 0,\n';
  if position(v_b in v_def) = 0 then
    if position(v_a in v_def) = 0 then raise exception 'supply_route_step: нет якоря после прыжка'; end if;
    v_def := replace(v_def, v_a, v_b);
  end if;

  execute v_def;
end $$;
