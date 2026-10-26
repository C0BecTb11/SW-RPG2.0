-- ⚠ НЕ ПРИМЕНЯТЬ ПОВТОРНО ЦЕЛИКОМ (аудит 25.10.2026). Файл устарел относительно базы: его прогон откатит
--   rt_space_sync — потеряются позы кораблей rt_x/rt_y/rt_hd (sql/rt_space_pose.sql) и проверка системы (sql/rt_lock_departed.sql).
--   Нужна функция отсюда — бери её текущую версию из базы (pg_get_functiondef), а не из этого файла.
--   После прогона примени sql/tractor_2_0.sql (притягивающий луч: snapshot.held в rt_space_sync, запрет прыжка в луче).
-- Космос 2.0 · снимок орбиты с удалением погибших.
-- Эту версию rt_space_sync вставляют в SQL Editor руками: через MCP текст с удалением не
-- проходит. Пока она не применена, погибшие корабли и машины лежат в ships с hp = 0, бойцы
-- погибшего корабля — в unit_positions с hp = 0 (в выдачу rt_space_ships они не попадают).
-- После — уходят, как в старой игре: корабль с грузом и ангаром (каскад), бойцы с hp 0.

create or replace function public.rt_space_sync(p_key text, p_battle uuid, p_ships jsonb default '[]'::jsonb, p_craft jsonb default '[]'::jsonb,
                                                p_units jsonb default '[]'::jsonb, p_captured jsonb default '[]'::jsonb)
returns jsonb
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  n_s integer := 0; n_c integer := 0; n_u integer := 0; n_t integer := 0; n_d integer := 0;
  r record;
  v_max integer;
  fire jsonb;
begin
  perform rt_need_key(p_key);
  perform set_config('app.rt_battle', '1', true);

  -- живые корабли: клетка, разворот, корпус, щиты
  with rows as (
    select (x->>'id')::uuid as id, (x->>'x')::integer as x, (x->>'y')::integer as y, (x->>'facing')::integer as facing,
           greatest(0, (x->>'hp')::integer) as hp,
           greatest(0, (x->'sh'->>0)::integer) as sf, greatest(0, (x->'sh'->>1)::integer) as ss,
           greatest(0, (x->'sh'->>2)::integer) as sa, greatest(0, (x->'sh'->>3)::integer) as sp
    from jsonb_array_elements(coalesce(p_ships, '[]'::jsonb)) x
    where coalesce((x->>'hp')::integer, 0) > 0)
  update ships s
     set x = coalesce(rows.x, s.x), y = coalesce(rows.y, s.y), facing = coalesce(rows.facing, s.facing), hp = rows.hp,
         shield_fore = rows.sf, shield_starboard = rows.ss, shield_aft = rows.sa, shield_port = rows.sp, shields_updated_at = now()
    from rows join rt_battle_locks l on l.obj_kind = 'ship' and l.obj_id = rows.id and l.battle_id = p_battle
   where s.id = rows.id and not coalesce(s.in_transit, false);
  get diagnostics n_s = row_count;

  -- машины ангара и истребители на орбите
  with rows as (
    select (x->>'id')::uuid as id, greatest(0, (x->>'hp')::integer) as hp
    from jsonb_array_elements(coalesce(p_craft, '[]'::jsonb)) x
    where coalesce((x->>'hp')::integer, 0) > 0)
  update ships f set hp = rows.hp
    from rows join rt_battle_locks l on l.obj_kind = 'ship' and l.obj_id = rows.id and l.battle_id = p_battle
   where f.id = rows.id;
  get diagnostics n_c = row_count;

  -- бойцы на борту
  with rows as (
    select (x->>'id')::uuid as id, greatest(0, (x->>'hp')::integer) as hp
    from jsonb_array_elements(coalesce(p_units, '[]'::jsonb)) x
    where coalesce((x->>'hp')::integer, 0) > 0)
  update unit_positions u set hp = rows.hp, updated_at = now()
    from rows
   where u.id = rows.id and u.carrier_ship_id is not null
     and exists (select 1 from rt_battle_locks l where l.obj_kind = 'ship' and l.obj_id = u.carrier_ship_id and l.battle_id = p_battle);
  get diagnostics n_u = row_count;

  -- трофеи
  for r in
    select (x->>'id')::uuid as id, (x->>'by')::uuid as captor, x->>'faction' as faction
    from jsonb_array_elements(coalesce(p_captured, '[]'::jsonb)) x
  loop
    if r.captor is null or r.faction not in ('republic', 'cis') then continue; end if;
    if not exists (select 1 from rt_battle_locks l where l.obj_kind = 'ship' and l.obj_id = r.id and l.battle_id = p_battle) then continue; end if;
    select t.max_hp + coalesce(s.bonus_hp, 0) into v_max from ships s join ship_types t on t.id = s.ship_type where s.id = r.id;
    delete from unit_positions where carrier_ship_id = r.id and carrier_unit_id is null;
    perform set_config('app.owner_transfer', '1', true);
    update ships set owner_user_id = r.captor, faction = r.faction, commander_id = null,
                     hp = least(hp, greatest(1, ceil(coalesce(v_max, hp) * 0.25)::integer)),
                     shield_fore = 0, shield_aft = 0, shield_port = 0, shield_starboard = 0, shields_updated_at = now(),
                     trophy = true, jump_lock_until = now() + make_interval(hours => greatest(0, game_setting_int('trophy_jump_lock_hours', 12))),
                     overwatch = false, tractor_until = null, tractor_by = null, boarding_eff = null
     where id = r.id;
    update ships set owner_user_id = r.captor, faction = r.faction where carrier_ship_id = r.id;
    perform set_config('app.owner_transfer', '', true);
    update ships set tractor_until = null, tractor_by = null where tractor_by = r.id;
    update repair_orders set delivered = true where ship_id = r.id and not delivered;
    n_t := n_t + 1;
  end loop;

  -- погибшие: бойцы, машины, корабли (груз и ангар уходят каскадом, как в старой игре)
  for r in
    select (x->>'id')::uuid as id from jsonb_array_elements(coalesce(p_units, '[]'::jsonb)) x where coalesce((x->>'hp')::integer, 0) <= 0
  loop
    delete from unit_positions u where u.id = r.id and u.carrier_ship_id is not null
       and exists (select 1 from rt_battle_locks l where l.obj_kind = 'ship' and l.obj_id = u.carrier_ship_id and l.battle_id = p_battle);
    n_d := n_d + 1;
  end loop;
  for r in
    select (x->>'id')::uuid as id from jsonb_array_elements(coalesce(p_craft, '[]'::jsonb) || coalesce(p_ships, '[]'::jsonb)) x where coalesce((x->>'hp')::integer, 0) <= 0
  loop
    if not exists (select 1 from rt_battle_locks l where l.obj_kind = 'ship' and l.obj_id = r.id and l.battle_id = p_battle) then continue; end if;
    delete from ships where id = r.id;
    delete from rt_battle_locks where obj_kind = 'ship' and obj_id = r.id;
    n_d := n_d + 1;
  end loop;

  -- кто под огнём (для запрета прыжка)
  select coalesce(jsonb_object_agg(x->>'id', to_jsonb(now())), '{}'::jsonb) into fire
    from jsonb_array_elements(coalesce(p_ships, '[]'::jsonb)) x where (x->>'fire')::boolean;
  update rt_battles b
     set heartbeat_at = now(),
         snapshot = jsonb_build_object('fire', coalesce((
           select jsonb_object_agg(k, v) from jsonb_each(coalesce(b.snapshot->'fire', '{}'::jsonb)) e(k, v)
            where (v #>> '{}')::timestamptz > now() - interval '60 seconds' and not (fire ? k)), '{}'::jsonb) || fire),
         snapshot_at = now()
   where b.id = p_battle and b.status = 'active';
  return jsonb_build_object('ships', n_s, 'craft', n_c, 'units', n_u, 'captured', n_t, 'gone', n_d);
end;
$$;
