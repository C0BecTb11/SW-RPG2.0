-- ============================================================
-- Наземка 2.0 — база (этап 4). Применяется после rt_2_0_core.sql.
--   planet_maps          — маски проходимости планет (пехота, техника, репульсоры);
--   planet_cell_ok       — проверка клеток по маске; встроена в ground_box_free_for,
--                          is_ground_box_free и npc_cell_ok (высадка, появление, стройка);
--   rt_ground_open/pull/sync/map/act — комната наземки на игровом сервере.
-- Строки бойцов живой планеты заперты блокировкой боя 2.0 (rt_battle_locks): дозор, турели,
-- npc_tick и автоход их не трогают — их работу делает сервер. Захват (capture_tick) идёт
-- по позициям, которые сервер пишет в unit_positions.
-- Удаление погибших — в отдельном файле ground_2_0_delete.sql (SQL Editor).
-- ============================================================

create table if not exists public.planet_maps (
  system_id  text primary key,
  w          integer not null default 144,
  h          integer not null default 144,
  foot1      text not null,      -- по клетке: '1' можно стоять, '0' нет; индекс = y*w + x
  track1     text not null,
  track2     text not null,      -- 2×2: бит на верхней левой клетке
  hover1     text not null,
  hover2     text not null,
  version    text not null default 'base',   -- base — без города; town:<уровень> — с городом (пишет сервер)
  updated_at timestamptz not null default now()
);
alter table public.planet_maps enable row level security;
drop policy if exists planet_maps_read on public.planet_maps;
create policy planet_maps_read on public.planet_maps for select to authenticated using (true);

-- Род движения бойца: как в shared/rt-units.js (UNIT_MOVE)
create or replace function public.unit_move_kind(p_type text)
returns text
language sql immutable
as $$
  select case
    when p_type in ('rep_laat', 'cis_hmp') then 'air'
    when p_type in ('cis_aat', 'cis_mtt', 'cis_stap', 'rep_barc') then 'hover'
    when exists (select 1 from unit_types t where t.id = p_type and t.layer = 'space') then 'air'
    when exists (select 1 from unit_types t where t.id = p_type and coalesce(t.is_vehicle, false)) then 'track'
    else 'foot' end;
$$;

-- Клетки свободны по карте планеты? Нет строки карты — считаем, что да (планета без карты).
create or replace function public.planet_cell_ok(p_system text, p_x integer, p_y integer, p_w integer, p_h integer, p_move text)
returns boolean
language plpgsql stable
set search_path to 'public', 'pg_temp'
as $$
declare
  pm planet_maps%rowtype;
  mask text;
  i integer; j integer;
begin
  if p_move = 'air' then return true; end if;
  select * into pm from planet_maps where system_id = p_system;
  if not found then return true; end if;
  if p_x < 0 or p_y < 0 or p_x + p_w > pm.w or p_y + p_h > pm.h then return false; end if;
  if p_w >= 2 and p_h >= 2 then
    mask := case when p_move = 'hover' then pm.hover2 else pm.track2 end;
    -- большие машины: проверяем каждый квадрат 2×2 внутри (для 2×2 — один)
    for j in 0 .. p_h - 2 loop
      for i in 0 .. p_w - 2 loop
        if substr(mask, (p_y + j) * pm.w + p_x + i + 1, 1) <> '1' then return false; end if;
      end loop;
    end loop;
    return true;
  end if;
  mask := case when p_move = 'hover' then pm.hover1 when p_move = 'track' then pm.track1 else pm.foot1 end;
  for j in 0 .. p_h - 1 loop
    for i in 0 .. p_w - 1 loop
      if substr(mask, (p_y + j) * pm.w + p_x + i + 1, 1) <> '1' then return false; end if;
    end loop;
  end loop;
  return true;
end;
$$;

-- ---------- проверки клеток старой игры: добавлена маска ----------

create or replace function public.ground_box_free_for(p_system_id text, p_x integer, p_y integer, p_w integer, p_h integer, p_ignore_unit uuid, p_faction text, p_vehicle boolean)
returns boolean
language sql stable security definer
set search_path to 'public', 'pg_temp'
as $$
  select p_x >= 0 and p_y >= 0
    and p_x + p_w <= game_setting_int('ground_grid_cells', 144)
    and p_y + p_h <= game_setting_int('ground_grid_cells', 144)
    and planet_cell_ok(p_system_id, p_x, p_y, p_w, p_h, case when p_vehicle then 'track' else 'foot' end)
    and not exists (
      select 1 from unit_positions u
      join unit_types t on t.id = u.unit_type
      where u.system_id = p_system_id and u.layer = 'ground' and u.x is not null
        and (p_ignore_unit is null or u.id <> p_ignore_unit)
        and p_x < u.x + t.width_cells and p_x + p_w > u.x
        and p_y < u.y + t.height_cells and p_y + p_h > u.y
    )
    and not exists (
      select 1 from field_structures s join structure_types st on st.id = s.type_id
      where s.system_id = p_system_id
        and p_x < s.x + s.w and p_x + p_w > s.x
        and p_y < s.y + s.h and p_y + p_h > s.y
        and (not st.enterable
             or s.faction is distinct from p_faction
             or (st.infantry_only and p_vehicle))
    )
    and not ground_box_on_building(p_system_id, p_x, p_y, p_w, p_h)
    and ground_site_at(p_system_id, p_x, p_y, p_w, p_h) is null;
$$;

create or replace function public.is_ground_box_free(p_system_id text, p_x integer, p_y integer, p_w integer, p_h integer, p_ignore_unit uuid default null)
returns boolean
language sql stable security definer
set search_path to 'public', 'pg_temp'
as $$
  select p_x >= 0 and p_y >= 0
    and p_x + p_w <= game_setting_int('ground_grid_cells', 144)
    and p_y + p_h <= game_setting_int('ground_grid_cells', 144)
    and planet_cell_ok(p_system_id, p_x, p_y, p_w, p_h, case when p_w >= 2 then 'track' else 'foot' end)
    and not exists (
      select 1 from unit_positions u
      join unit_types t on t.id = u.unit_type
      where u.system_id = p_system_id
        and u.layer = 'ground'
        and u.x is not null
        and (p_ignore_unit is null or u.id <> p_ignore_unit)
        and p_x < u.x + t.width_cells and p_x + p_w > u.x
        and p_y < u.y + t.height_cells and p_y + p_h > u.y
    )
    and not exists (
      select 1 from field_structures s
      where s.system_id = p_system_id
        and p_x < s.x + s.w and p_x + p_w > s.x
        and p_y < s.y + s.h and p_y + p_h > s.y
    )
    and not ground_box_on_building(p_system_id, p_x, p_y, p_w, p_h)
    and ground_site_at(p_system_id, p_x, p_y, p_w, p_h) is null;
$$;

-- ---------- сторож боя 2.0: захват планеты (capture_tick) проходит сквозь блокировку ----------
create or replace function public.rt_battle_guard()
returns trigger
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  k text := case when tg_table_name = 'ships' then 'ship' else 'unit' end;
begin
  -- (старое значение возвращается при удалении строки, новое — при изменении)
  if coalesce(current_setting('app.rt_battle', true), '') = '1'
     or coalesce(current_setting('app.capture_transfer', true), '') = '1' then
    return case when tg_op = 'UPDATE' then new else old end;
  end if;
  if not exists (select 1 from rt_battle_locks l where l.obj_kind = k and l.obj_id = old.id) then
    return case when tg_op = 'UPDATE' then new else old end;
  end if;
  if rt_obj_busy_2_0(k, old.id) is null then
    return case when tg_op = 'UPDATE' then new else old end;
  end if;
  if auth.uid() is not null then
    raise exception '%', case when k = 'ship' then 'Корабль сейчас в бою 2.0' else 'Отряд сейчас в бою 2.0' end
      using errcode = 'P0001', hint = 'rt_busy';
  end if;
  return null;
end;
$$;

-- ---------- комната наземки ----------

-- Активный бой наземки на планете (живая комната), если есть
create or replace function public.rt_ground_battle(p_system text)
returns uuid
language sql stable security definer
set search_path to 'public', 'pg_temp'
as $$
  select b.id from rt_battles b
  where b.kind = 'ground' and b.system_id = p_system and b.status = 'active'
    and b.heartbeat_at > now() - interval '90 seconds'
  order by b.created_at desc limit 1;
$$;

-- Бойцы планеты для комнаты (земля, живые, на карте)
create or replace function public.rt_ground_units(p_system text)
returns jsonb
language sql stable security definer
set search_path to 'public', 'pg_temp'
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', u.id, 'type', u.unit_type, 'x', u.x, 'y', u.y, 'hp', u.hp, 'owner', u.owner_user_id, 'faction', u.faction,
    'hero', u.hero_id, 'name', u.hero_name, 'portrait', u.portrait,
    'bonus', jsonb_build_object('hp', coalesce(u.bonus_hp, 0), 'damage', coalesce(u.bonus_damage, 0), 'vision', coalesce(u.bonus_vision, 0),
                                'move', coalesce(u.bonus_move, 0), 'range', coalesce(u.bonus_range, 0), 'accuracy', coalesce(u.bonus_accuracy, 0), 'evasion', coalesce(u.bonus_evasion, 0)),
    'npc', (select b.kind from npc_brains b where b.unit_id = u.id),
    'ctrl', case when u.control_until is not null and u.control_until > now() then u.orig_faction end,
    'abil', (select coalesce(jsonb_agg(h.ability_id), '[]'::jsonb) from hero_learned h where h.hero_id = u.hero_id),
    'training', u.training_until is not null and u.training_until > now(),
    'carrier', u.carrier_unit_id,
    'updated', u.updated_at
  ) order by u.id), '[]'::jsonb)
  from unit_positions u
  where u.system_id = p_system and u.layer = 'ground' and u.x is not null and u.hp > 0
    and u.transit_to is null;
$$;

-- Полевые постройки, участки с постройками, поселение, захват — всё, что нужно комнате
create or replace function public.rt_ground_state(p_system text)
returns jsonb
language sql stable security definer
set search_path to 'public', 'pg_temp'
as $$
  select jsonb_build_object(
    'system', (select jsonb_build_object('id', s.id, 'name', s.name, 'faction', s.faction,
                                        'controller', (select c.controller_user_id from system_control c where c.system_id = s.id))
               from systems s where s.id = p_system),
    'settle', (select jsonb_build_object('level', st.level, 'name', l.name,
                 'districts', (select coalesce(jsonb_agg(jsonb_build_object('slot', d.slot, 'id', d.district_id, 'building', d.completes_at is not null and d.completes_at > now()) order by d.slot), '[]'::jsonb)
                               from settlement_districts d where d.system_id = st.system_id),
                 'satisfaction', settlement_effective(p_system), 'militia_ready_at', st.militia_ready_at)
               from settlement_state st join settlement_levels l on l.level = st.level where st.system_id = p_system),
    'structs', (select coalesce(jsonb_agg(jsonb_build_object('id', f.id, 'type', f.type_id, 'kind', st.kind, 'x', f.x, 'y', f.y, 'w', f.w, 'h', f.h, 'hp', f.hp, 'hpMax', st.max_hp,
                                                             'faction', f.faction, 'owner', f.owner_user_id, 'building', f.completes_at is not null and f.completes_at > now())), '[]'::jsonb)
                from field_structures f join structure_types st on st.id = f.type_id where f.system_id = p_system),
    'buildings', (select coalesce(jsonb_agg(jsonb_build_object('slot', b.slot_index, 'x', ps.x, 'y', ps.y, 'type', b.building_type_id, 'code', bt.code, 'name', bt.name, 'image', bt.image, 'faction', b.faction, 'owner', b.owner_user_id,
                                                               'ready', b.completes_at is null or b.completes_at <= now())), '[]'::jsonb)
                  from buildings b join planet_slots ps on ps.system_id = b.system_id and ps.slot_index = b.slot_index
                  left join building_types bt on bt.id = b.building_type_id
                  where b.system_id = p_system),
    'plots', (select coalesce(jsonb_agg(jsonb_build_object('slot', ps.slot_index, 'x', ps.x, 'y', ps.y) order by ps.slot_index), '[]'::jsonb) from planet_slots ps where ps.system_id = p_system),
    'zones', (select coalesce(jsonb_agg(jsonb_build_object('x', z.x, 'y', z.y, 'size', z.size)), '[]'::jsonb) from deploy_zones z where z.system_id = p_system),
    'capture', (select jsonb_build_object('faction', c.faction, 'progress', capture_progress(p_system), 'rate', c.rate, 'status', c.status,
                                          'goal', game_setting_int('capture_seconds', 60))
                from system_capture c where c.system_id = p_system),
    'capture_goal', game_setting_int('capture_seconds', 60),
    'zone_box', (select jsonb_build_object('x', b.x, 'y', b.y, 'size', b.size) from settlement_zone_box() b)
  );
$$;

-- Открыть комнату: бой наземки на планете, бойцы заперты, автоходы по земле отменены.
-- Повторный вызов при живом бое возвращает его же.
create or replace function public.rt_ground_open(p_key text, p_system text)
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
  bid := rt_ground_battle(p_system);
  if bid is null then
    update rt_battles set status = 'aborted', ended_at = now()
     where kind = 'ground' and system_id = p_system and status = 'active';
    insert into rt_battles (kind, system_id, meta) values ('ground', p_system, jsonb_build_object('opened', now()))
    returning id into bid;
  end if;
  -- бойцы планеты — в бой (строка прошлого боя переходит к новому)
  insert into rt_battle_locks (obj_kind, obj_id, battle_id)
  select 'unit', u.id, bid from unit_positions u
  where u.system_id = p_system and u.layer = 'ground' and u.x is not null and u.hp > 0 and u.transit_to is null
  on conflict (obj_kind, obj_id) do update set battle_id = excluded.battle_id, locked_at = now();
  -- автоходы по земле на этой планете — сервер ведёт сам
  update auto_moves m set status = 'stopped', stop_reason = 'rt_ground', updated_at = now()
   where m.system_id = p_system and m.layer = 'ground' and m.status = 'active';
  st := rt_ground_state(p_system);
  return st || jsonb_build_object('battle_id', bid, 'units', rt_ground_units(p_system));
end;
$$;

-- Свежее состояние планеты для комнаты (раз в несколько секунд): новые бойцы запираются
create or replace function public.rt_ground_pull(p_key text, p_battle uuid, p_system text)
returns jsonb
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  perform rt_need_key(p_key);
  perform set_config('app.rt_battle', '1', true);
  update rt_servers set seen_at = now() where id = 'main';
  update rt_battles set heartbeat_at = now() where id = p_battle and status = 'active';
  if not found then return jsonb_build_object('closed', true); end if;
  insert into rt_battle_locks (obj_kind, obj_id, battle_id)
  select 'unit', u.id, p_battle from unit_positions u
  where u.system_id = p_system and u.layer = 'ground' and u.x is not null and u.hp > 0 and u.transit_to is null
    and not exists (select 1 from rt_battle_locks l where l.obj_kind = 'unit' and l.obj_id = u.id and l.battle_id = p_battle)
  on conflict (obj_kind, obj_id) do update set battle_id = excluded.battle_id, locked_at = now();
  return rt_ground_state(p_system) || jsonb_build_object('units', rt_ground_units(p_system));
end;
$$;

-- Записать позиции и здоровье: p_units [{id, x, y, hp}], p_structs [{id, hp}].
-- Погибшие (hp 0) остаются строками с hp = 0 до ground_2_0_delete.sql (там — удаление и запись гибели).
create or replace function public.rt_ground_sync(p_key text, p_battle uuid, p_units jsonb default '[]'::jsonb, p_structs jsonb default '[]'::jsonb)
returns jsonb
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  n_u integer := 0; n_s integer := 0;
begin
  perform rt_need_key(p_key);
  perform set_config('app.rt_battle', '1', true);
  with rows as (
    select (r->>'id')::uuid as id, (r->>'x')::integer as x, (r->>'y')::integer as y, greatest(0, (r->>'hp')::integer) as hp
    from jsonb_array_elements(coalesce(p_units, '[]'::jsonb)) r)
  update unit_positions u
     set x = rows.x, y = rows.y, hp = rows.hp, updated_at = now()
    from rows join rt_battle_locks l on l.obj_kind = 'unit' and l.obj_id = rows.id and l.battle_id = p_battle
   where u.id = rows.id and u.layer = 'ground' and u.x is not null;
  get diagnostics n_u = row_count;
  with rows as (
    select (r->>'id')::uuid as id, greatest(0, (r->>'hp')::integer) as hp
    from jsonb_array_elements(coalesce(p_structs, '[]'::jsonb)) r)
  update field_structures f set hp = rows.hp from rows where f.id = rows.id;
  get diagnostics n_s = row_count;
  update rt_battles set heartbeat_at = now() where id = p_battle and status = 'active';
  return jsonb_build_object('units', n_u, 'structs', n_s);
end;
$$;

-- Маски проходимости с городом (сервер пишет при открытии комнаты)
create or replace function public.rt_ground_map(p_key text, p_system text, p_masks jsonb, p_version text default 'town')
returns boolean
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  perform rt_need_key(p_key);
  insert into planet_maps (system_id, w, h, foot1, track1, track2, hover1, hover2, version)
  values (p_system, coalesce((p_masks->>'w')::integer, 144), coalesce((p_masks->>'h')::integer, 144),
          p_masks->>'foot1', p_masks->>'track1', p_masks->>'track2', p_masks->>'hover1', p_masks->>'hover2', p_version)
  on conflict (system_id) do update
    set foot1 = excluded.foot1, track1 = excluded.track1, track2 = excluded.track2, hover1 = excluded.hover1, hover2 = excluded.hover2,
        version = excluded.version, updated_at = now();
  return true;
end;
$$;

-- Действие игрока руками сервера (погрузка на корабль из зоны): проверки старой функции
-- остаются, блокировка боя пропускает. Разрешены только перечисленные функции.
create or replace function public.rt_ground_act(p_key text, p_user uuid, p_fn text, p_args jsonb)
returns jsonb
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  res jsonb;
begin
  perform rt_need_key(p_key);
  perform set_config('app.rt_battle', '1', true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  if p_fn = 'load_unit_from_ground' then
    res := to_jsonb(load_unit_from_ground((p_args->>'unit')::uuid, (p_args->>'ship')::uuid));
  elsif p_fn = 'load_vehicle_to_ship' then
    res := to_jsonb(load_vehicle_to_ship((p_args->>'unit')::uuid, (p_args->>'ship')::uuid));
  elsif p_fn = 'build_structure' then
    -- инженер: комната подвела его к месту, действие и кредиты списывает сама build_structure
    res := to_jsonb(build_structure((p_args->>'unit')::uuid, p_args->>'type', (p_args->>'x')::integer, (p_args->>'y')::integer));
  else
    raise exception 'rt: действие не разрешено: %', p_fn;
  end if;
  return jsonb_build_object('ok', true, 'result', res);
end;
$$;

-- Закрыть комнату: позиции уже записаны; блокировки перестают действовать с закрытием боя
create or replace function public.rt_ground_close(p_key text, p_battle uuid, p_result jsonb default null)
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

-- Для экрана планеты: жива ли комната и адрес сервера
create or replace function public.rt_ground_status(p_system text)
returns jsonb
language sql stable security definer
set search_path to 'public', 'pg_temp'
as $$
  select jsonb_build_object('battle_id', rt_ground_battle(p_system), 'server', rt_server_status());
$$;

grant execute on function public.rt_ground_status(text) to authenticated;
grant execute on function public.planet_cell_ok(text, integer, integer, integer, integer, text) to authenticated;

-- Корабли игрока на площадках сброса с местом в трюме — для приказа «На борт»
-- (боец сам идёт в зону погрузки; погрузку делает сервер, когда он дошёл)
create or replace function public.get_loadable_ships(p_system text)
returns table(ship_id uuid, ship_name text, free_slots integer, x integer, y integer)
language sql stable security definer
set search_path to 'public', 'extensions', 'pg_temp'
as $$
  select s.id, coalesce(s.name, st.name),
         (select capacity from ship_stats(s.id)) - ship_load_used(s.id),
         s.x, s.y
  from ships s join ship_types st on st.id = s.ship_type
  where s.system_id = p_system and s.owner_user_id = auth.uid()
    and s.carrier_ship_id is null and not coalesce(s.in_transit, false)
    and (select capacity from ship_stats(s.id)) - ship_load_used(s.id) > 0
    and is_in_orbital_drop(s.x, s.y, ship_box_w(st.width_cells, st.height_cells, s.facing), ship_box_h(st.width_cells, st.height_cells, s.facing)) is not null
  order by st.name;
$$;
grant execute on function public.get_loadable_ships(text) to authenticated;

-- ---------------------------------------------------------------------------
-- Нанятые бойцы выходят у постройки (применено миграциями units_spawn_at_building,
-- units_spawn_capacity). Кольцо вокруг участка 6×6, только свободные клетки вне зданий,
-- укреплений, стен и зоны вражеского десанта; если вокруг тесно — зоны высадки, как раньше.
-- ---------------------------------------------------------------------------
create or replace function public.find_spawn_box_near(p_system_id text, p_building uuid, p_w integer, p_h integer)
returns table(x integer, y integer)
language sql stable security definer
set search_path to 'public', 'pg_temp'
as $$
  with slot as (
    select ps.x, ps.y, 6 as size
      from buildings b join planet_slots ps on ps.system_id = b.system_id and ps.slot_index = b.slot_index
     where b.id = p_building and b.system_id = p_system_id
  ),
  ring as (
    select s.x + dx as x, s.y + dy as y, greatest(abs(dx + (p_w - 1) / 2.0 - s.size / 2.0), abs(dy + (p_h - 1) / 2.0 - s.size / 2.0)) as d
      from slot s, generate_series(-8, s.size + 7) dx, generate_series(-8, s.size + 7) dy
     where (dx + p_w <= 0 or dx >= s.size or dy + p_h <= 0 or dy >= s.size)     -- не на самом участке
  )
  select r.x, r.y from ring r
   where r.x >= 0 and r.y >= 0 and r.x + p_w <= game_setting_int('ground_grid_cells', 144) and r.y + p_h <= game_setting_int('ground_grid_cells', 144)
     and not is_in_ground_attack_zone(r.y + p_h - 1)
     and not exists (select 1 from settlement_zone_box() z where r.x < z.x + z.size and r.x + p_w > z.x and r.y < z.y + z.size and r.y + p_h > z.y)
     and is_ground_box_free(p_system_id, r.x, r.y, p_w, p_h, null)
   order by r.d, r.y, r.x;
$$;

-- Место для новых бойцов: у постройки + зоны высадки, минус уже заказанное.
-- Используется в order_unit / hire_hero / hero_hire_check вместо подсчёта только зон высадки.
create or replace function public.spawn_space(p_system_id text, p_building uuid)
returns integer
language sql stable security definer
set search_path to 'public', 'pg_temp'
as $$
  select greatest(0,
    (select count(*)::integer from find_spawn_box_near(p_system_id, p_building, 1, 1))
    + (select count(*)::integer from free_deploy_cells(p_system_id, 0, 0))
    - coalesce((select sum(quantity)::integer from unit_orders where system_id = p_system_id and not delivered), 0));
$$;

-- deliver_ready_units: сначала find_spawn_box_near(system, building, w, h), затем find_deploy_box.
create or replace function public.deliver_ready_units()
returns void
language plpgsql security definer
set search_path to 'public', 'extensions', 'pg_temp'
as $$
declare
  o record; spot record; placed integer; v_hp integer; v_w integer; v_h integer; v_new uuid; h record;
begin
  for o in select * from unit_orders where not delivered and completes_at <= now() order by completes_at for update skip locked loop
    select max_hp, width_cells, height_cells into v_hp, v_w, v_h from unit_types where id = o.unit_type;
    v_w := coalesce(v_w, 1); v_h := coalesce(v_h, 1);
    placed := 0;
    while placed < o.quantity loop
      -- у постройки; если вокруг неё всё занято — в зоне высадки, как раньше
      select * into spot from find_spawn_box_near(o.system_id, o.building_id, v_w, v_h) limit 1;
      if not found then
        select * into spot from find_deploy_box(o.system_id, v_w, v_h, coalesce(o.target_x, 0), coalesce(o.target_y, 0)) limit 1;
      end if;
      exit when not found;
      insert into unit_positions (system_id, layer, x, y, owner_user_id, faction, unit_type, quantity, hp)
      values (o.system_id, 'ground', spot.x, spot.y, o.owner_user_id, o.faction, o.unit_type, 1, coalesce(v_hp, 100))
      returning id into v_new;
      if o.hero_id is not null then
        select name, portrait into h from heroes where id = o.hero_id;
        if found then update unit_positions set hero_id = o.hero_id, hero_name = h.name, portrait = h.portrait where id = v_new; end if;
      end if;
      if coalesce(array_length(o.upgrades, 1), 0) > 0 then perform apply_unit_upgrades(v_new, o.upgrades); end if;
      placed := placed + 1;
    end loop;
    if placed >= o.quantity then
      update unit_orders set delivered = true where id = o.id;
    elsif placed > 0 then
      update unit_orders set quantity = quantity - placed where id = o.id;
    end if;
  end loop;
end;
$$;
