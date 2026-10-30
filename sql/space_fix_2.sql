-- Исправления космоса 2.0, этап 2: запись орбиты в базу (аудит 30.10.2026, SPACE-BUG-013…028).
--
-- SPACE-BUG-014  бойцы трюма, что дерутся на орбите (абордаж, оборона, шаттл, сборы у шлюза), — в снимке боя
--                (rt_battles.snapshot.busy, пишет сервер); сторож не даёт их высадить, перевести или распустить.
-- SPACE-BUG-015  трюм погибшего корабля: кто жив на чужом борту — переписан в трюм того корабля (поле on), а не удалён;
--                трофей: удаляется только трюм прежней стороны, десант захватчика остаётся на борту.
-- SPACE-BUG-017  все ветки сверки (машины, бойцы, трофеи, погибшие) — только для кораблей в системе боя и не в пути.
-- SPACE-BUG-018  ремонт в доке при открытой орбите: rt_battle_locks.hp_sync — последний записанный боем корпус;
--                что база прибавила сверх него (ремонт), сверка добавляет к корпусу боя и возвращает серверу (rep).
-- SPACE-BUG-021  ships.rt_state: погибший экипаж и целость отсеков переживают закрытие орбиты; ремонт до полного — стирает.
-- SPACE-BUG-022  сверка и посты — только в активный бой (ответ closed); закрытие снимает замки, открытие — замки закрытых боёв.
-- SPACE-BUG-023  машина ангара свободна от замка, когда её носитель ушёл из системы боя.
-- SPACE-BUG-026  верхний предел корпуса, щитов, машин и бойцов в сверке.
-- SPACE-BUG-028  rt_space_lock не переписывает замки, что уже за этим боем.

alter table public.ships add column if not exists rt_state jsonb;
alter table public.rt_battle_locks add column if not exists hp_sync integer;

-- ---------------------------------------------------------------- замки
create or replace function public.rt_space_lock(p_battle uuid, p_system text)
returns integer language plpgsql security definer set search_path to 'public', 'pg_temp' as $function$
declare
  n integer;
begin
  -- только недостающие и чужие (другого боя): раньше каждый pull (5 с) переписывал все замки системы
  insert into rt_battle_locks (obj_kind, obj_id, battle_id, hp_sync)
  select 'ship', s.id, p_battle, s.hp from ships s
   where (s.system_id = p_system and not coalesce(s.in_transit, false) and s.carrier_ship_id is null)
      or s.carrier_ship_id in (select c.id from ships c where c.system_id = p_system and not coalesce(c.in_transit, false) and c.carrier_ship_id is null)
  on conflict (obj_kind, obj_id) do update set battle_id = excluded.battle_id, locked_at = now(), hp_sync = excluded.hp_sync
   where rt_battle_locks.battle_id is distinct from excluded.battle_id;
  get diagnostics n = row_count;
  return n;
end;
$function$;

create or replace function public.rt_obj_busy_2_0(p_kind text, p_id uuid)
returns uuid language sql stable security definer set search_path to 'public', 'pg_temp' as $function$
  select l.battle_id
  from rt_battle_locks l join rt_battles b on b.id = l.battle_id
  where l.obj_kind = p_kind and l.obj_id = p_id
    and b.status = 'active' and b.heartbeat_at > now() - interval '90 seconds'
    -- корабль ушёл из системы боя (гиперпространство, другая система) — замок уже не его;
    -- машина ангара — по носителю: носитель ушёл, и она с ним (SPACE-BUG-023)
    and (p_kind <> 'ship' or not exists (
          select 1 from ships s
           where s.id = p_id
             and (coalesce(s.in_transit, false)
                  or (s.carrier_ship_id is null and s.system_id is distinct from b.system_id)
                  or (s.carrier_ship_id is not null and exists (
                        select 1 from ships c where c.id = s.carrier_ship_id
                           and (coalesce(c.in_transit, false) or c.system_id is distinct from b.system_id))))))
    -- боец в пути (разведчик), в трюме корабля или уже не на планете боя — замок тоже не его
    and (p_kind <> 'unit' or not exists (
          select 1 from unit_positions u
           where u.id = p_id
             and (u.transit_to is not null or u.carrier_ship_id is not null or u.system_id is distinct from b.system_id)))
  limit 1;
$function$;

-- ---------------------------------------------------------------- открытие, закрытие, посты
create or replace function public.rt_space_open(p_key text, p_system text)
returns jsonb language plpgsql security definer set search_path to 'public', 'pg_temp' as $function$
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
  -- замки прошлых (закрытых) орбит этой системы — вон
  delete from rt_battle_locks l using rt_battles b
   where b.id = l.battle_id and b.kind = 'space' and b.system_id = p_system and b.status <> 'active';
  perform rt_space_lock(bid, p_system);
  update auto_moves set status = 'stopped', stop_reason = 'бой 2.0', updated_at = now()
   where system_id = p_system and layer = 'space' and status = 'active';
  st := rt_space_state(p_system);
  return st || jsonb_build_object('battle_id', bid);
end;
$function$;

create or replace function public.rt_space_close(p_key text, p_battle uuid, p_result jsonb default null::jsonb)
returns boolean language plpgsql security definer set search_path to 'public', 'pg_temp' as $function$
declare v boolean;
begin
  perform rt_need_key(p_key);
  update rt_battles set status = 'finished', ended_at = now(), result = p_result where id = p_battle and status = 'active';
  v := found;
  delete from rt_battle_locks where battle_id = p_battle;
  return v;
end;
$function$;

create or replace function public.rt_space_posts(p_key text, p_battle uuid, p_ships jsonb default '[]'::jsonb)
returns integer language plpgsql security definer set search_path to 'public', 'pg_temp' as $function$
declare n integer := 0;
begin
  perform rt_need_key(p_key);
  if not exists (select 1 from rt_battles b where b.id = p_battle and b.kind = 'space' and b.status = 'active') then return 0; end if;
  perform set_config('app.rt_battle', '1', true);
  with rows as (
    select (x->>'id')::uuid as id, case when jsonb_typeof(x->'posts') = 'object' and x->'posts' <> '{}'::jsonb then x->'posts' end as posts
    from jsonb_array_elements(coalesce(p_ships, '[]'::jsonb)) x)
  update ships s set troop_posts = rows.posts
    from rows join rt_battle_locks l on l.obj_kind = 'ship' and l.obj_id = rows.id and l.battle_id = p_battle
   where s.id = rows.id;
  get diagnostics n = row_count;
  return n;
end;
$function$;

-- ---------------------------------------------------------------- что читает бой: + rt_state
create or replace function public.rt_space_ships(p_system text)
returns jsonb language sql stable security definer set search_path to 'public', 'pg_temp' as $function$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', s.id, 'ship_type', s.ship_type, 'name', s.name, 'owner_user_id', s.owner_user_id, 'faction', s.faction,
    'x', s.x, 'y', s.y, 'facing', coalesce(s.facing, 0), 'hp', s.hp,
    'shield_fore', s.shield_fore, 'shield_aft', s.shield_aft, 'shield_port', s.shield_port, 'shield_starboard', s.shield_starboard,
    'shields_updated_at', s.shields_updated_at, 'trophy', coalesce(s.trophy, false),
    'bonus_hp', s.bonus_hp, 'bonus_shield', s.bonus_shield, 'bonus_fore', s.bonus_fore, 'bonus_damage', s.bonus_damage,
    'bonus_vision', s.bonus_vision, 'bonus_move', s.bonus_move, 'bonus_hangar', s.bonus_hangar, 'bonus_capacity', s.bonus_capacity,
    'upgrades', to_jsonb(coalesce(s.upgrades, '{}'::text[])), 'commander_id', s.commander_id, 'jump_lock_until', s.jump_lock_until,
    'troop_posts', s.troop_posts, 'rt_state', s.rt_state,
    'rt_pose', case when s.rt_x is not null and s.rt_y is not null and s.rt_hd is not null then jsonb_build_array(s.rt_x, s.rt_y, s.rt_hd) end,
    'craft', (select coalesce(jsonb_agg(jsonb_build_object('id', f.id, 'ship_type', f.ship_type, 'hp', f.hp, 'carrier_ship_id', f.carrier_ship_id, 'owner_user_id', f.owner_user_id, 'faction', f.faction) order by f.created_at), '[]'::jsonb)
                from ships f where f.carrier_ship_id = s.id and f.hp > 0),
    'units', (select coalesce(jsonb_agg(jsonb_build_object('id', u.id, 'unit_type', u.unit_type, 'quantity', u.quantity, 'hp', u.hp,
                       'bonus_hp', u.bonus_hp, 'bonus_damage', u.bonus_damage, 'hero_name', u.hero_name, 'hero_id', u.hero_id,
                       'portrait', u.portrait, 'owner_user_id', u.owner_user_id, 'carrier_ship_id', u.carrier_ship_id)), '[]'::jsonb)
                -- чужой десант, застрявший на борту (орбиту закрыли посреди абордажа), — не экипаж этого корабля
                from unit_positions u where u.carrier_ship_id = s.id and u.carrier_unit_id is null and u.hp > 0
                  and u.faction is not distinct from s.faction)
  ) order by s.created_at), '[]'::jsonb)
  from ships s
  where s.system_id = p_system and not coalesce(s.in_transit, false) and s.carrier_ship_id is null and s.hp > 0;
$function$;

-- ---------------------------------------------------------------- сверка
-- новый параметр p_busy — старую подпись прочь, иначе PostgREST видит две функции
drop function if exists public.rt_space_sync(text, uuid, jsonb, jsonb, jsonb, jsonb);

create or replace function public.rt_space_sync(p_key text, p_battle uuid, p_ships jsonb default '[]'::jsonb, p_craft jsonb default '[]'::jsonb,
                                                p_units jsonb default '[]'::jsonb, p_captured jsonb default '[]'::jsonb, p_busy jsonb default null)
returns jsonb language plpgsql security definer set search_path to 'public', 'pg_temp' as $function$
declare
  n_s integer := 0; n_c integer := 0; n_u integer := 0; n_t integer := 0; n_d integer := 0; n_m integer := 0;
  r record;
  v_max integer;
  v_sys text;
  rep jsonb := '{}'::jsonb; rep2 jsonb;
  fire jsonb;
  held jsonb; held_off text[];
begin
  perform rt_need_key(p_key);
  -- бой закрыт — ничего не пишем, сервер узнаёт из ответа (как rt_ground_sync)
  select b.system_id into v_sys from rt_battles b where b.id = p_battle and b.kind = 'space' and b.status = 'active';
  if v_sys is null then return jsonb_build_object('closed', true); end if;
  perform set_config('app.rt_battle', '1', true);

  -- живые корабли: клетка, разворот, корпус (+ ремонт в доке сверх записанного боем), щиты, состояние экипажа
  with rows as (
    select (x->>'id')::uuid as id, (x->>'x')::integer as x, (x->>'y')::integer as y, (x->>'facing')::integer as facing,
           greatest(1, (x->>'hp')::integer) as hp,
           greatest(0, (x->'sh'->>0)::integer) as sf, greatest(0, (x->'sh'->>1)::integer) as ss,
           greatest(0, (x->'sh'->>2)::integer) as sa, greatest(0, (x->'sh'->>3)::integer) as sp,
           (x->>'mx')::double precision as mx, (x->>'my')::double precision as my, (x->>'hd')::double precision as hd,
           x ? 'st' as has_st, case when jsonb_typeof(x->'st') = 'object' then x->'st' end as st,
           (x->>'seen')::integer as seen
    from jsonb_array_elements(coalesce(p_ships, '[]'::jsonb)) x
    where coalesce((x->>'hp')::integer, 0) > 0),
  calc as (
    select rows.*, t.max_hp + coalesce(s.bonus_hp, 0) as mhp, t.max_shield + coalesce(s.bonus_shield, 0) as msh, coalesce(s.bonus_fore, 0) as mfore,
           -- ремонт — сверх записанного боем и сверх того, что бой уже принял из базы (seen): иначе подхваченный
           -- через pull ремонт прибавлялся второй раз
           greatest(0, s.hp - greatest(coalesce(l.hp_sync, s.hp), coalesce(rows.seen, 0))) as rep_d
    from rows
    join rt_battle_locks l on l.obj_kind = 'ship' and l.obj_id = rows.id and l.battle_id = p_battle
    join ships s on s.id = rows.id join ship_types t on t.id = s.ship_type
    where not coalesce(s.in_transit, false) and s.system_id = v_sys and s.carrier_ship_id is null),
  upd as (
    update ships s
       set x = coalesce(calc.x, s.x), y = coalesce(calc.y, s.y), facing = coalesce(calc.facing, s.facing),
           hp = least(calc.mhp, calc.hp + calc.rep_d),
           shield_fore = least(calc.sf, calc.msh + calc.mfore), shield_starboard = least(calc.ss, calc.msh),
           shield_aft = least(calc.sa, calc.msh), shield_port = least(calc.sp, calc.msh), shields_updated_at = now(),
           rt_x = calc.mx, rt_y = calc.my, rt_hd = calc.hd,
           rt_state = case when calc.has_st then calc.st else s.rt_state end
      from calc where s.id = calc.id
    returning s.id, s.hp, calc.rep_d),
  lk as (
    update rt_battle_locks l set hp_sync = upd.hp from upd
     where l.obj_kind = 'ship' and l.obj_id = upd.id and l.battle_id = p_battle
    returning upd.id, upd.hp, upd.rep_d)
  select count(*), coalesce(jsonb_object_agg(id::text, hp) filter (where rep_d > 0), '{}'::jsonb) into n_s, rep2 from lk;
  rep := rep || rep2;

  -- машины ангара и истребители на орбите (носитель — или сама машина — в системе боя и не в пути)
  with rows as (
    select (x->>'id')::uuid as id, greatest(1, (x->>'hp')::integer) as hp, (x->>'seen')::integer as seen
    from jsonb_array_elements(coalesce(p_craft, '[]'::jsonb)) x
    where coalesce((x->>'hp')::integer, 0) > 0),
  calc as (
    select rows.id, rows.hp, t.max_hp + coalesce(f.bonus_hp, 0) as mhp,
           greatest(0, f.hp - greatest(coalesce(l.hp_sync, f.hp), coalesce(rows.seen, 0))) as rep_d
    from rows
    join rt_battle_locks l on l.obj_kind = 'ship' and l.obj_id = rows.id and l.battle_id = p_battle
    join ships f on f.id = rows.id join ship_types t on t.id = f.ship_type
    join ships c on c.id = coalesce(f.carrier_ship_id, f.id)
    where not coalesce(c.in_transit, false) and c.system_id = v_sys),
  upd as (update ships f set hp = least(calc.mhp, calc.hp + calc.rep_d) from calc where f.id = calc.id returning f.id, f.hp, calc.rep_d),
  lk as (
    update rt_battle_locks l set hp_sync = upd.hp from upd
     where l.obj_kind = 'ship' and l.obj_id = upd.id and l.battle_id = p_battle
    returning upd.id, upd.hp, upd.rep_d)
  select count(*), coalesce(jsonb_object_agg(id::text, hp) filter (where rep_d > 0), '{}'::jsonb) into n_c, rep2 from lk;
  rep := rep || rep2;

  -- десант погибшего корабля, живой на чужом борту: в трюм того корабля (поле on) — до удаления своего (каскад)
  with rows as (
    select (x->>'id')::uuid as id, greatest(1, (x->>'hp')::integer) as hp, (x->>'on')::uuid as on_id
    from jsonb_array_elements(coalesce(p_units, '[]'::jsonb)) x
    where x ? 'on' and coalesce((x->>'hp')::integer, 0) > 0)
  update unit_positions u
     set carrier_ship_id = rows.on_id, hp = least(ut.max_hp + coalesce(u.bonus_hp, 0), rows.hp), updated_at = now()
    from rows, unit_types ut
   where u.id = rows.id and ut.id = u.unit_type and u.carrier_ship_id is not null and u.carrier_unit_id is null
     and exists (select 1 from rt_battle_locks l where l.obj_kind = 'ship' and l.obj_id = u.carrier_ship_id and l.battle_id = p_battle)
     and exists (select 1 from rt_battle_locks l join ships c on c.id = l.obj_id
                  where l.obj_kind = 'ship' and l.obj_id = rows.on_id and l.battle_id = p_battle
                    and c.carrier_ship_id is null and not coalesce(c.in_transit, false) and c.system_id = v_sys);
  get diagnostics n_m = row_count;

  -- бойцы на борту: здоровье, не выше предела типа (носитель — в системе боя и не в пути)
  with rows as (
    select (x->>'id')::uuid as id, greatest(1, (x->>'hp')::integer) as hp
    from jsonb_array_elements(coalesce(p_units, '[]'::jsonb)) x
    where not (x ? 'on') and coalesce((x->>'hp')::integer, 0) > 0)
  update unit_positions u set hp = least(ut.max_hp + coalesce(u.bonus_hp, 0), rows.hp), updated_at = now()
    from rows, unit_types ut
   where u.id = rows.id and ut.id = u.unit_type and u.carrier_ship_id is not null
     and exists (select 1 from rt_battle_locks l join ships c on c.id = l.obj_id
                  where l.obj_kind = 'ship' and l.obj_id = u.carrier_ship_id and l.battle_id = p_battle
                    and not coalesce(c.in_transit, false) and c.system_id = v_sys);
  get diagnostics n_u = row_count;

  -- трофеи
  for r in
    select (x->>'id')::uuid as id, (x->>'by')::uuid as captor, x->>'faction' as faction
    from jsonb_array_elements(coalesce(p_captured, '[]'::jsonb)) x
  loop
    if r.captor is null or r.faction not in ('republic', 'cis') then continue; end if;
    if not exists (select 1 from rt_battle_locks l join ships c on c.id = l.obj_id
                    where l.obj_kind = 'ship' and l.obj_id = r.id and l.battle_id = p_battle
                      and not coalesce(c.in_transit, false) and c.system_id = v_sys) then continue; end if;
    select t.max_hp + coalesce(s.bonus_hp, 0) into v_max from ships s join ship_types t on t.id = s.ship_type where s.id = r.id;
    -- трюм прежней стороны — погиб в обороне; десант захватчика остаётся на борту трофея
    delete from unit_positions where carrier_ship_id = r.id and carrier_unit_id is null and faction is distinct from r.faction;
    perform set_config('app.owner_transfer', '1', true);
    update ships set owner_user_id = r.captor, faction = r.faction, commander_id = null, rt_state = null,
                     hp = least(hp, greatest(1, ceil(coalesce(v_max, hp) * 0.25)::integer)),
                     shield_fore = 0, shield_aft = 0, shield_port = 0, shield_starboard = 0, shields_updated_at = now(),
                     trophy = true, jump_lock_until = now() + make_interval(hours => greatest(0, game_setting_int('trophy_jump_lock_hours', 12)))
     where id = r.id;
    update ships set owner_user_id = r.captor, faction = r.faction where carrier_ship_id = r.id;
    perform set_config('app.owner_transfer', '', true);
    update repair_orders set delivered = true where ship_id = r.id and not delivered;
    n_t := n_t + 1;
  end loop;

  -- погибшие: бойцы, машины, корабли (груз и ангар уходят каскадом, как в старой игре)
  for r in
    select (x->>'id')::uuid as id from jsonb_array_elements(coalesce(p_units, '[]'::jsonb)) x where coalesce((x->>'hp')::integer, 0) <= 0
  loop
    delete from unit_positions u where u.id = r.id and u.carrier_ship_id is not null
       and exists (select 1 from rt_battle_locks l join ships c on c.id = l.obj_id
                    where l.obj_kind = 'ship' and l.obj_id = u.carrier_ship_id and l.battle_id = p_battle
                      and not coalesce(c.in_transit, false) and c.system_id = v_sys);
    n_d := n_d + 1;
  end loop;
  for r in
    select (x->>'id')::uuid as id from jsonb_array_elements(coalesce(p_craft, '[]'::jsonb) || coalesce(p_ships, '[]'::jsonb)) x where coalesce((x->>'hp')::integer, 0) <= 0
  loop
    if not exists (select 1 from rt_battle_locks l join ships f on f.id = l.obj_id join ships c on c.id = coalesce(f.carrier_ship_id, f.id)
                    where l.obj_kind = 'ship' and l.obj_id = r.id and l.battle_id = p_battle
                      and not coalesce(c.in_transit, false) and c.system_id = v_sys) then continue; end if;
    delete from ships where id = r.id;
    delete from rt_battle_locks where obj_kind = 'ship' and obj_id = r.id;
    n_d := n_d + 1;
  end loop;

  -- кто под огнём (для запрета прыжка)
  select coalesce(jsonb_object_agg(x->>'id', to_jsonb(now())), '{}'::jsonb) into fire
    from jsonb_array_elements(coalesce(p_ships, '[]'::jsonb)) x where (x->>'fire')::boolean;
  -- притягивающий луч: корабль держат до этого времени (rt_battle_guard не пускает в гиперпространство); 0 — отпустили
  select coalesce(jsonb_object_agg(x->>'id', to_jsonb(now() + make_interval(secs => least(60, (x->>'held')::numeric)::double precision))), '{}'::jsonb) into held
    from jsonb_array_elements(coalesce(p_ships, '[]'::jsonb)) x where coalesce((x->>'held')::numeric, 0) > 0;
  select coalesce(array_agg(x->>'id'), '{}') into held_off
    from jsonb_array_elements(coalesce(p_ships, '[]'::jsonb)) x where x ? 'held' and coalesce((x->>'held')::numeric, 0) <= 0;
  update rt_battles b
     set heartbeat_at = now(),
         snapshot = jsonb_build_object('fire', coalesce((
           select jsonb_object_agg(k, v) from jsonb_each(coalesce(b.snapshot->'fire', '{}'::jsonb)) e(k, v)
            where (v #>> '{}')::timestamptz > now() - interval '60 seconds' and not (fire ? k)), '{}'::jsonb) || fire,
                                       'held', coalesce((
           select jsonb_object_agg(k, v) from jsonb_each(coalesce(b.snapshot->'held', '{}'::jsonb)) e(k, v)
            where (v #>> '{}')::timestamptz > now() and not (held ? k) and not (k = any(held_off))), '{}'::jsonb) || held,
                                       -- бойцы трюма в деле (сервер шлёт, когда список меняется)
                                       'busy', case when jsonb_typeof(p_busy) = 'array' then p_busy else coalesce(b.snapshot->'busy', '[]'::jsonb) end),
         snapshot_at = now()
   where b.id = p_battle and b.status = 'active';
  return jsonb_build_object('ships', n_s, 'craft', n_c, 'units', n_u, 'moved', n_m, 'captured', n_t, 'gone', n_d, 'rep', rep);
end;
$function$;
grant execute on function public.rt_space_sync(text, uuid, jsonb, jsonb, jsonb, jsonb, jsonb) to public;

-- ---------------------------------------------------------------- сторож: бойцы трюма в деле
create or replace function public.rt_battle_guard()
returns trigger language plpgsql security definer set search_path to 'public', 'pg_temp' as $function$
declare
  k text := case when tg_table_name = 'ships' then 'ship' else 'unit' end;
  bid uuid;
  fire_at timestamptz;
begin
  if coalesce(current_setting('app.rt_battle', true), '') = '1'
     or coalesce(current_setting('app.capture_transfer', true), '') = '1' then
    return case when tg_op = 'UPDATE' then new else old end;
  end if;
  -- боец трюма дерётся на орбите (абордаж, оборона, шаттл, сборы у шлюза — rt_battles.snapshot.busy): не высадить,
  -- не перевести, не распустить — иначе он воевал бы и в космосе, и на земле (SPACE-BUG-014)
  -- поля бойца читаются только для бойцов: у строки корабля их нет (plpgsql берёт все поля выражения сразу)
  if k = 'unit' then
  if auth.uid() is not null and old.carrier_ship_id is not null
     and (tg_op = 'DELETE' or new.carrier_ship_id is distinct from old.carrier_ship_id or new.carrier_unit_id is distinct from old.carrier_unit_id
          or new.owner_user_id is distinct from old.owner_user_id or new.layer is distinct from old.layer)
     and exists (select 1 from rt_battle_locks l join rt_battles b on b.id = l.battle_id
                  where l.obj_kind = 'ship' and l.obj_id = old.carrier_ship_id and b.kind = 'space' and b.status = 'active'
                    and b.heartbeat_at > now() - interval '90 seconds' and coalesce(b.snapshot->'busy', '[]'::jsonb) ? old.id::text) then
    raise exception 'Отряд сейчас дерётся на орбите — высадить или перевести его можно, когда стычка кончится'
      using errcode = 'P0001', hint = 'rt_busy';
  end if;
  end if;
  select l.battle_id into bid from rt_battle_locks l where l.obj_kind = k and l.obj_id = old.id;
  if bid is null then
    return case when tg_op = 'UPDATE' then new else old end;
  end if;
  if rt_obj_busy_2_0(k, old.id) is null then
    return case when tg_op = 'UPDATE' then new else old end;
  end if;
  if k = 'ship' and tg_op = 'UPDATE' then
    if new.in_transit and not old.in_transit then
      select (b.snapshot->'fire'->>old.id::text)::timestamptz into fire_at from rt_battles b where b.id = bid;
      if fire_at is not null and fire_at > now() - interval '30 seconds' then
        raise exception 'Корабль под огнём — в гиперпространство не уйти' using errcode = 'P0001', hint = 'rt_busy';
      end if;
      select (b.snapshot->'held'->>old.id::text)::timestamptz into fire_at from rt_battles b where b.id = bid;
      if fire_at is not null and fire_at > now() then
        raise exception 'Корабль «%» в притягивающем луче — в гиперпространство не уйти',
          coalesce(old.name, (select t.name from ship_types t where t.id = old.ship_type), '') using errcode = 'P0001', hint = 'rt_busy';
      end if;
      return new;
    end if;
    if new.hp = old.hp and new.x is not distinct from old.x and new.y is not distinct from old.y and new.facing is not distinct from old.facing
       and new.system_id is not distinct from old.system_id and new.in_transit = old.in_transit
       and new.shield_fore is not distinct from old.shield_fore and new.shield_aft is not distinct from old.shield_aft
       and new.shield_port is not distinct from old.shield_port and new.shield_starboard is not distinct from old.shield_starboard
       and new.trophy is not distinct from old.trophy and new.owner_user_id is not distinct from old.owner_user_id
       and new.faction is not distinct from old.faction and new.carrier_ship_id is not distinct from old.carrier_ship_id
       and new.ap is not distinct from old.ap then
      return new;
    end if;
    if auth.uid() is null and new.hp >= old.hp and new.x is not distinct from old.x and new.y is not distinct from old.y
       and new.system_id is not distinct from old.system_id and new.in_transit = old.in_transit
       and new.owner_user_id is not distinct from old.owner_user_id and new.faction is not distinct from old.faction then
      return new;
    end if;
  end if;
  if k = 'unit' and tg_op = 'UPDATE' then
    -- погрузка на корабль или в технику из панелей игры (армия, трюм): можно, если боец не под огнём
    if (new.carrier_ship_id is not null and old.carrier_ship_id is null) or (new.carrier_unit_id is not null and old.carrier_unit_id is null) then
      select (b.snapshot->'fire'->>old.id::text)::timestamptz into fire_at from rt_battles b where b.id = bid;
      if fire_at is not null and fire_at > now() - interval '30 seconds' then
        raise exception 'Боец под огнём — погрузка невозможна' using errcode = 'P0001', hint = 'rt_busy';
      end if;
      return new;
    end if;
    -- имя героя и прочее небоевое
    if new.hp = old.hp and new.x is not distinct from old.x and new.y is not distinct from old.y and new.system_id is not distinct from old.system_id
       and new.owner_user_id is not distinct from old.owner_user_id and new.faction is not distinct from old.faction
       and new.carrier_ship_id is not distinct from old.carrier_ship_id and new.carrier_unit_id is not distinct from old.carrier_unit_id
       and new.ap is not distinct from old.ap and new.layer is not distinct from old.layer then
      return new;
    end if;
  end if;
  if auth.uid() is not null then
    raise exception '%', case when k = 'ship' then 'Корабль сейчас в бою 2.0' else 'Отряд сейчас в бою 2.0' end
      using errcode = 'P0001', hint = 'rt_busy';
  end if;
  return null;
end;
$function$;

-- ---------------------------------------------------------------- ремонт до полного стирает след боя
do $patch$
declare d text; a text; b text;
begin
  d := pg_get_functiondef('public.deliver_ready_repairs()'::regprocedure);
  a := 'jump_lock_until = case when sh.id = o.ship_id then null else sh.jump_lock_until end';
  b := a || E',\n          rt_state = case when sh.id = o.ship_id and sh.hp + coalesce(o.heal_amount, t.max_hp + sh.bonus_hp) >= t.max_hp + sh.bonus_hp then null else sh.rt_state end';
  if position('rt_state' in d) = 0 then
    if (length(d) - length(replace(d, a, ''))) / length(a) <> 1 then raise exception 'deliver_ready_repairs: место правки не найдено'; end if;
    execute replace(d, a, b);
  end if;
end $patch$;

-- замки орбит, что уже закрыты (раньше закрытие их не снимало)
delete from public.rt_battle_locks l using public.rt_battles b where b.id = l.battle_id and b.kind = 'space' and b.status <> 'active';
