-- ⚠ НЕ ПРИМЕНЯТЬ ПОВТОРНО (26.10.2026): supply_fleet_to_zone в базе уже без проверок абордажа, луча и дозора
--   (sql/legacy_step4b_patch.sql), а этих колонок в ships больше нет — прогон файла сломает рейсы снабжения.
--   Нужна функция отсюда — бери её текущую версию из базы (pg_get_functiondef).
-- Снабжение: выход к гиперлинии и в живой орбите (бой 2.0).
-- Пока орбиту смотрит игрок, корабли ведёт сервер боя (server/system-room.js): база двигать их не может
-- (rt_battle_guard, auto_moves закрыты триггером rt_battle_guard_ref). Поэтому для живой орбиты рейс
-- пишет приказ в rt_space_orders, сервер боя забирает его (rt_space_orders_take, раз в 5 с) и ведёт корабль
-- к полосе прыжка — игрок видит это на карте в реальном времени. Без живой орбиты — как раньше, автоходом.
-- Цель — квадрат со стороной длины корабля в середине полосы: как бы корабль ни развернулся по пути,
-- он целиком в полосе. Флот под огнём — рейс не встаёт, ждёт, пока бой стихнет.

create table if not exists public.rt_space_orders (
  ship_id    uuid primary key,                 -- без внешнего ключа: корабль может погибнуть — строку снимет supply_fleet_to_zone / очистка
  system_id  text not null,
  x          integer not null,                 -- цель в метрах орбиты (клетка 200 м), центр корабля
  y          integer not null,
  reason     text not null default 'supply',
  created_at timestamptz not null default now(),
  taken_at   timestamptz
);
alter table public.rt_space_orders enable row level security;
revoke all on table public.rt_space_orders from anon, authenticated;

-- Сервер боя забирает приказы для своей орбиты (ключ сервера — как у rt_space_pull)
create or replace function public.rt_space_orders_take(p_key text, p_battle uuid, p_system text)
returns jsonb language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare v jsonb;
begin
  perform rt_need_key(p_key);
  with t as (
    update rt_space_orders o set taken_at = now()
     where o.system_id = p_system and o.taken_at is null and o.created_at > now() - interval '5 minutes'
    returning o.ship_id, o.x, o.y
  )
  select coalesce(jsonb_agg(jsonb_build_object('ship_id', t.ship_id, 'x', t.x, 'y', t.y)), '[]'::jsonb) into v from t;
  return v;
end $$;

create or replace function public.supply_fleet_to_zone(p_route_id uuid)
returns text language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
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
end $$;

revoke all on function public.supply_fleet_to_zone(uuid) from public, anon, authenticated;

-- Флот под огнём или в бою 2.0 в момент прыжка — рейс не встаёт, а ждёт: бой стихнет, прыгнет сам
do $$
declare v_def text; v_a text; v_b text;
begin
  v_def := pg_get_functiondef('public.supply_route_step(uuid)'::regprocedure);
  v_a := E'        v_err := sqlerrm;\n        if sqlstate = ''P0001'' then\n';
  v_b := E'        v_err := sqlerrm;\n'
      || E'        if v_err like ''Корабль под огнём%'' or v_err like ''%в бою 2.0%'' then\n'
      || '          upd' || E'ate supply_routes set last_note = ''Флот под огнём — прыжок, когда бой стихнет'', updated_at = now()\n'
      || E'           where id = r.id and last_note is distinct from ''Флот под огнём — прыжок, когда бой стихнет'';\n'
      || E'          exit;\n'
      || E'        end if;\n'
      || E'        if sqlstate = ''P0001'' then\n';
  if position(E'Флот под огнём — прыжок, когда бой стихнет' in v_def) = 0 then
    if position(v_a in v_def) = 0 then raise exception 'supply_route_step: нет якоря ошибки прыжка'; end if;
    v_def := replace(v_def, v_a, v_b);
    execute v_def;
  end if;
end $$;
