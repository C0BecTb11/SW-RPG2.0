-- Космос 2.0 в игре: комната системы (орбита в реальном времени).
-- Применено через MCP 18.10.2026. Удаления здесь нет: погибшие корабли и бойцы лежат с hp = 0,
-- их убирает версия rt_space_sync из sql/space_2_0_del.sql (вставляется в SQL Editor руками).
--
-- Как устроено:
--   rt_space_open(key, system)   — сервер открывает систему: rt_battles(kind='space'), блокировки
--                                  кораблей (и машин ангара), автоходы кораблей — stopped; возвращает состояние
--   rt_space_state(system)       — корабли на орбите с трюмом и ангаром, типы, настройки, зоны
--   rt_space_pull(key, battle, system) — то же для подхвата: прибывшие (блокируются), ушедшие
--   rt_space_sync(key, battle, ships, craft, units, captured) — снимок: корпус, щиты, клетка и разворот,
--                                  машины и бойцы (hp), трофеи; кто под огнём — в rt_battles.snapshot
--   rt_space_close(key, battle)  — закрыть комнату
--   rt_space_status(system)      — для экрана: жив ли бой и адрес сервера
--
-- Блокировка (rt_battle_guard) для кораблей мягче, чем для бойцов: уход в гиперпространство
-- (если не под огнём) и безобидные поля (имя, командир) проходят; ремонт и переоснащение
-- по крону (корпус растёт, место то же) проходят; всё боевое — нет.

-- ---------- блокировка ----------
create or replace function public.rt_battle_guard()
returns trigger
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  k text := case when tg_table_name = 'ships' then 'ship' else 'unit' end;
  bid uuid;
  fire_at timestamptz;
begin
  if coalesce(current_setting('app.rt_battle', true), '') = '1'
     or coalesce(current_setting('app.capture_transfer', true), '') = '1' then
    return case when tg_op = 'UPDATE' then new else old end;
  end if;
  select l.battle_id into bid from rt_battle_locks l where l.obj_kind = k and l.obj_id = old.id;
  if bid is null then
    return case when tg_op = 'UPDATE' then new else old end;
  end if;
  if rt_obj_busy_2_0(k, old.id) is null then
    return case when tg_op = 'UPDATE' then new else old end;
  end if;
  if k = 'ship' and tg_op = 'UPDATE' then
    -- уход в гиперпространство: можно, если корабль последние полминуты не под огнём
    if new.in_transit and not old.in_transit then
      select (b.snapshot->'fire'->>old.id::text)::timestamptz into fire_at from rt_battles b where b.id = bid;
      if fire_at is not null and fire_at > now() - interval '30 seconds' then
        raise exception 'Корабль под огнём — в гиперпространство не уйти' using errcode = 'P0001', hint = 'rt_busy';
      end if;
      return new;
    end if;
    -- имя, командир, прочее небоевое — пожалуйста
    if new.hp = old.hp and new.x is not distinct from old.x and new.y is not distinct from old.y and new.facing is not distinct from old.facing
       and new.system_id is not distinct from old.system_id and new.in_transit = old.in_transit
       and new.shield_fore is not distinct from old.shield_fore and new.shield_aft is not distinct from old.shield_aft
       and new.shield_port is not distinct from old.shield_port and new.shield_starboard is not distinct from old.shield_starboard
       and new.trophy is not distinct from old.trophy and new.owner_user_id is not distinct from old.owner_user_id
       and new.faction is not distinct from old.faction and new.carrier_ship_id is not distinct from old.carrier_ship_id
       and new.tractor_until is not distinct from old.tractor_until and new.tractor_by is not distinct from old.tractor_by
       and new.boarding_eff is not distinct from old.boarding_eff and new.overwatch is not distinct from old.overwatch
       and new.ap is not distinct from old.ap then
      return new;
    end if;
    -- крон: ремонт в доке и переоснащение (корпус растёт, корабль на месте) — комната подхватит
    if auth.uid() is null and new.hp >= old.hp and new.x is not distinct from old.x and new.y is not distinct from old.y
       and new.system_id is not distinct from old.system_id and new.in_transit = old.in_transit
       and new.owner_user_id is not distinct from old.owner_user_id and new.faction is not distinct from old.faction then
      return new;
    end if;
  end if;
  if auth.uid() is not null then
    raise exception '%', case when k = 'ship' then 'Корабль сейчас в бою 2.0' else 'Отряд сейчас в бою 2.0' end
      using errcode = 'P0001', hint = 'rt_busy';
  end if;
  return null;
end;
$$;

-- ---------- состояние системы ----------

-- Живой бой на орбите системы
create or replace function public.rt_space_battle(p_system text)
returns uuid
language sql stable security definer
set search_path to 'public', 'pg_temp'
as $$
  select b.id from rt_battles b
   where b.kind = 'space' and b.system_id = p_system and b.status = 'active'
     and b.heartbeat_at > now() - interval '90 seconds'
   order by b.created_at desc limit 1;
$$;

-- Корабли на орбите (не в пути, не в ангаре) с бойцами трюма и машинами ангара — строки как в таблицах
create or replace function public.rt_space_ships(p_system text)
returns jsonb
language sql stable security definer
set search_path to 'public', 'pg_temp'
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', s.id, 'ship_type', s.ship_type, 'name', s.name, 'owner_user_id', s.owner_user_id, 'faction', s.faction,
    'x', s.x, 'y', s.y, 'facing', coalesce(s.facing, 0), 'hp', s.hp,
    'shield_fore', s.shield_fore, 'shield_aft', s.shield_aft, 'shield_port', s.shield_port, 'shield_starboard', s.shield_starboard,
    'shields_updated_at', s.shields_updated_at, 'trophy', coalesce(s.trophy, false), 'boarding_eff', s.boarding_eff,
    'bonus_hp', s.bonus_hp, 'bonus_shield', s.bonus_shield, 'bonus_fore', s.bonus_fore, 'bonus_damage', s.bonus_damage,
    'bonus_vision', s.bonus_vision, 'bonus_move', s.bonus_move, 'bonus_hangar', s.bonus_hangar, 'bonus_capacity', s.bonus_capacity,
    'upgrades', to_jsonb(coalesce(s.upgrades, '{}'::text[])), 'commander_id', s.commander_id, 'jump_lock_until', s.jump_lock_until,
    'craft', (select coalesce(jsonb_agg(jsonb_build_object('id', f.id, 'ship_type', f.ship_type, 'hp', f.hp, 'carrier_ship_id', f.carrier_ship_id, 'owner_user_id', f.owner_user_id, 'faction', f.faction) order by f.created_at), '[]'::jsonb)
                from ships f where f.carrier_ship_id = s.id and f.hp > 0),
    'units', (select coalesce(jsonb_agg(jsonb_build_object('id', u.id, 'unit_type', u.unit_type, 'quantity', u.quantity, 'hp', u.hp,
                       'bonus_hp', u.bonus_hp, 'bonus_damage', u.bonus_damage, 'hero_name', u.hero_name, 'hero_id', u.hero_id,
                       'portrait', u.portrait, 'owner_user_id', u.owner_user_id, 'carrier_ship_id', u.carrier_ship_id)), '[]'::jsonb)
                from unit_positions u where u.carrier_ship_id = s.id and u.carrier_unit_id is null and u.hp > 0)
  ) order by s.created_at), '[]'::jsonb)
  from ships s
  where s.system_id = p_system and not coalesce(s.in_transit, false) and s.carrier_ship_id is null and s.hp > 0;
$$;

create or replace function public.rt_space_state(p_system text)
returns jsonb
language sql stable security definer
set search_path to 'public', 'pg_temp'
as $$
  select jsonb_build_object(
    'system', (select jsonb_build_object('id', s.id, 'name', s.name, 'faction', s.faction, 'deep', coalesce(s.is_deep_space, false),
                                         'controller', (select c.controller_user_id from system_control c where c.system_id = s.id))
                 from systems s where s.id = p_system),
    'ships', rt_space_ships(p_system),
    'types', (select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'faction', t.faction, 'max_hp', t.max_hp, 'max_shield', t.max_shield,
                        'shield_regen', t.shield_regen, 'damage', t.damage, 'capacity', t.capacity, 'hangar_slots', t.hangar_slots,
                        'width_cells', t.width_cells, 'height_cells', t.height_cells, 'is_fighter', coalesce(t.is_fighter, false), 'image', t.image)), '[]'::jsonb)
                from ship_types t),
    'settings', jsonb_build_object('grid', game_setting_int('space_grid_cells', 150), 'zone', game_setting_int('hyperspace_zone_height', 14),
                                   'pad', game_setting_int('orbital_drop_size', 6), 'regen', game_setting_int('shield_regen_seconds', 30)),
    -- площадки высадки на планету: те же две, что считает игра (четверть и три четверти ширины, середина высоты)
    'pads', (select jsonb_build_array(
               jsonb_build_object('idx', 1, 'x', g.grid / 4 - g.sz / 2, 'y', g.grid / 2 - g.sz / 2, 'size', g.sz),
               jsonb_build_object('idx', 2, 'x', g.grid * 3 / 4 - g.sz / 2, 'y', g.grid / 2 - g.sz / 2, 'size', g.sz))
             from (select game_setting_int('space_grid_cells', 150) as grid, game_setting_int('orbital_drop_size', 6) as sz) g),
    'station', (select jsonb_build_object('id', st.id, 'faction', st.faction, 'owner', st.owner_user_id, 'name', st.name,
                                          'ready', st.completes_at is null or st.completes_at <= now(),
                                          'x', sl.x, 'y', sl.y, 'size', sl.size)
                  from space_stations st left join station_slots sl on sl.system_id = st.system_id
                 where st.system_id = p_system limit 1),
    'slot', (select jsonb_build_object('x', sl.x, 'y', sl.y, 'size', sl.size) from station_slots sl where sl.system_id = p_system limit 1)
  );
$$;

-- Блокировки на все корабли орбиты и их ангары (только для этого боя)
create or replace function public.rt_space_lock(p_battle uuid, p_system text)
returns integer
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  n integer;
begin
  insert into rt_battle_locks (obj_kind, obj_id, battle_id)
  select 'ship', s.id, p_battle from ships s
   where (s.system_id = p_system and not coalesce(s.in_transit, false) and s.carrier_ship_id is null)
      or s.carrier_ship_id in (select c.id from ships c where c.system_id = p_system and not coalesce(c.in_transit, false) and c.carrier_ship_id is null)
  on conflict (obj_kind, obj_id) do update set battle_id = excluded.battle_id, locked_at = now();
  get diagnostics n = row_count;
  return n;
end;
$$;

-- Сервер открывает орбиту системы
create or replace function public.rt_space_open(p_key text, p_system text)
returns jsonb
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  bid uuid;
  st jsonb;
begin
  perform rt_need_key(p_key);
  perform set_config('app.rt_battle', '1', true);
  if not exists (select 1 from systems where id = p_system) then
    raise exception 'rt: нет системы %', p_system;
  end if;
  bid := rt_space_battle(p_system);
  if bid is null then
    update rt_battles set status = 'finished', ended_at = now() where kind = 'space' and system_id = p_system and status = 'active';
    insert into rt_battles (kind, system_id, meta) values ('space', p_system, jsonb_build_object('v', '2.0')) returning id into bid;
  else
    update rt_battles set heartbeat_at = now() where id = bid;
  end if;
  perform rt_space_lock(bid, p_system);
  update auto_moves set status = 'stopped', stop_reason = 'бой 2.0', updated_at = now()
   where system_id = p_system and layer = 'space' and status = 'active';
  st := rt_space_state(p_system);
  return st || jsonb_build_object('battle_id', bid);
end;
$$;

-- Подхват: прибывшие корабли блокируются, состояние — заново
create or replace function public.rt_space_pull(p_key text, p_battle uuid, p_system text)
returns jsonb
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  st jsonb;
begin
  perform rt_need_key(p_key);
  perform set_config('app.rt_battle', '1', true);
  if not exists (select 1 from rt_battles b where b.id = p_battle and b.status = 'active') then
    return jsonb_build_object('closed', true);
  end if;
  update rt_battles set heartbeat_at = now() where id = p_battle;
  perform rt_space_lock(p_battle, p_system);
  st := rt_space_state(p_system);
  return st || jsonb_build_object('battle_id', p_battle);
end;
$$;

-- Снимок боя. ships: [{id, x, y, facing, hp, sh:[нос, правый борт, корма, левый борт], fire}],
-- craft: [{id, hp}], units: [{id, hp}], captured: [{id, by, faction}]
create or replace function public.rt_space_sync(p_key text, p_battle uuid, p_ships jsonb default '[]'::jsonb, p_craft jsonb default '[]'::jsonb,
                                                p_units jsonb default '[]'::jsonb, p_captured jsonb default '[]'::jsonb)
returns jsonb
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  n_s integer := 0; n_c integer := 0; n_u integer := 0; n_t integer := 0;
  r record;
  v_max integer;
  fire jsonb;
begin
  perform rt_need_key(p_key);
  perform set_config('app.rt_battle', '1', true);
  with rows as (
    select (x->>'id')::uuid as id, (x->>'x')::integer as x, (x->>'y')::integer as y, (x->>'facing')::integer as facing,
           greatest(0, (x->>'hp')::integer) as hp,
           greatest(0, (x->'sh'->>0)::integer) as sf, greatest(0, (x->'sh'->>1)::integer) as ss,
           greatest(0, (x->'sh'->>2)::integer) as sa, greatest(0, (x->'sh'->>3)::integer) as sp
    from jsonb_array_elements(coalesce(p_ships, '[]'::jsonb)) x)
  update ships s
     set x = coalesce(rows.x, s.x), y = coalesce(rows.y, s.y), facing = coalesce(rows.facing, s.facing), hp = rows.hp,
         shield_fore = rows.sf, shield_starboard = rows.ss, shield_aft = rows.sa, shield_port = rows.sp, shields_updated_at = now()
    from rows join rt_battle_locks l on l.obj_kind = 'ship' and l.obj_id = rows.id and l.battle_id = p_battle
   where s.id = rows.id and not coalesce(s.in_transit, false);
  get diagnostics n_s = row_count;

  with rows as (
    select (x->>'id')::uuid as id, greatest(0, (x->>'hp')::integer) as hp
    from jsonb_array_elements(coalesce(p_craft, '[]'::jsonb)) x)
  update ships f set hp = rows.hp
    from rows join rt_battle_locks l on l.obj_kind = 'ship' and l.obj_id = rows.id and l.battle_id = p_battle
   where f.id = rows.id;
  get diagnostics n_c = row_count;

  -- бойцы трюма и абордажа: только те, что на кораблях этого боя
  with rows as (
    select (x->>'id')::uuid as id, greatest(0, (x->>'hp')::integer) as hp
    from jsonb_array_elements(coalesce(p_units, '[]'::jsonb)) x)
  update unit_positions u set hp = rows.hp, updated_at = now()
    from rows
   where u.id = rows.id and u.carrier_ship_id is not null
     and exists (select 1 from rt_battle_locks l where l.obj_kind = 'ship' and l.obj_id = u.carrier_ship_id and l.battle_id = p_battle);
  get diagnostics n_u = row_count;

  -- трофеи: как boarding_capture_ship, без строки абордажа; защитники на борту — потеряны
  for r in
    select (x->>'id')::uuid as id, (x->>'by')::uuid as by, x->>'faction' as faction
    from jsonb_array_elements(coalesce(p_captured, '[]'::jsonb)) x
  loop
    if r.by is null or r.faction not in ('republic', 'cis') then continue; end if;
    if not exists (select 1 from rt_battle_locks l where l.obj_kind = 'ship' and l.obj_id = r.id and l.battle_id = p_battle) then continue; end if;
    select t.max_hp + coalesce(s.bonus_hp, 0) into v_max from ships s join ship_types t on t.id = s.ship_type where s.id = r.id;
    update unit_positions set hp = 0, updated_at = now() where carrier_ship_id = r.id and carrier_unit_id is null;
    perform set_config('app.owner_transfer', '1', true);
    update ships set owner_user_id = r.by, faction = r.faction, commander_id = null,
                     hp = least(hp, greatest(1, ceil(coalesce(v_max, hp) * 0.25)::integer)),
                     shield_fore = 0, shield_aft = 0, shield_port = 0, shield_starboard = 0, shields_updated_at = now(),
                     trophy = true, jump_lock_until = now() + make_interval(hours => greatest(0, game_setting_int('trophy_jump_lock_hours', 12))),
                     overwatch = false, tractor_until = null, tractor_by = null, boarding_eff = null
     where id = r.id;
    update ships set owner_user_id = r.by, faction = r.faction where carrier_ship_id = r.id;
    perform set_config('app.owner_transfer', '', true);
    update ships set tractor_until = null, tractor_by = null where tractor_by = r.id;
    update repair_orders set delivered = true where ship_id = r.id and not delivered;
    n_t := n_t + 1;
  end loop;

  -- кто под огнём (для запрета прыжка): корабль → момент
  select coalesce(jsonb_object_agg(x->>'id', to_jsonb(now())), '{}'::jsonb) into fire
    from jsonb_array_elements(coalesce(p_ships, '[]'::jsonb)) x where (x->>'fire')::boolean;
  update rt_battles b
     set heartbeat_at = now(),
         snapshot = jsonb_build_object('fire', coalesce((
           select jsonb_object_agg(k, v) from jsonb_each(coalesce(b.snapshot->'fire', '{}'::jsonb)) e(k, v)
            where (v #>> '{}')::timestamptz > now() - interval '60 seconds' and not (fire ? k)), '{}'::jsonb) || fire),
         snapshot_at = now()
   where b.id = p_battle and b.status = 'active';
  return jsonb_build_object('ships', n_s, 'craft', n_c, 'units', n_u, 'captured', n_t);
end;
$$;

-- Закрыть комнату орбиты: позиции уже записаны; блокировки гаснут с концом боя
create or replace function public.rt_space_close(p_key text, p_battle uuid, p_result jsonb default null)
returns boolean
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  perform rt_need_key(p_key);
  update rt_battles set status = 'finished', ended_at = now(), result = p_result where id = p_battle and status = 'active';
  return found;
end;
$$;

-- Для экрана орбиты: жив ли бой и адрес сервера
create or replace function public.rt_space_status(p_system text)
returns jsonb
language sql stable security definer
set search_path to 'public', 'pg_temp'
as $$
  select jsonb_build_object('battle_id', rt_space_battle(p_system), 'server', rt_server_status());
$$;
grant execute on function public.rt_space_status(text) to authenticated;
