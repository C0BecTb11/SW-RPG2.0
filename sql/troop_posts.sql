-- ⚠ НЕ ПРИМЕНЯТЬ ПОВТОРНО ЦЕЛИКОМ (аудит 25.10.2026). Файл устарел относительно базы: его прогон откатит
--   rt_space_ships — потеряются позы кораблей (sql/rt_space_pose.sql).
--   Нужна функция отсюда — бери её текущую версию из базы (pg_get_functiondef), а не из этого файла.
-- Посты десанта в бою 2.0: игрок ставит бойцов трюма на точки своего корабля
-- (uid бойца → [x, y] клетки плана). Сервер орбиты пишет их сюда, а при открытии орбиты
-- раздаёт обратно: бойцы стоят на постах и после сна корабля, и после нового открытия.

alter table public.ships add column if not exists troop_posts jsonb;

create or replace function public.rt_space_posts(p_key text, p_battle uuid, p_ships jsonb default '[]'::jsonb)
 returns integer
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare n integer := 0;
begin
  perform rt_need_key(p_key);
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

create or replace function public.rt_space_ships(p_system text)
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', s.id, 'ship_type', s.ship_type, 'name', s.name, 'owner_user_id', s.owner_user_id, 'faction', s.faction,
    'x', s.x, 'y', s.y, 'facing', coalesce(s.facing, 0), 'hp', s.hp,
    'shield_fore', s.shield_fore, 'shield_aft', s.shield_aft, 'shield_port', s.shield_port, 'shield_starboard', s.shield_starboard,
    'shields_updated_at', s.shields_updated_at, 'trophy', coalesce(s.trophy, false), 'boarding_eff', s.boarding_eff,
    'bonus_hp', s.bonus_hp, 'bonus_shield', s.bonus_shield, 'bonus_fore', s.bonus_fore, 'bonus_damage', s.bonus_damage,
    'bonus_vision', s.bonus_vision, 'bonus_move', s.bonus_move, 'bonus_hangar', s.bonus_hangar, 'bonus_capacity', s.bonus_capacity,
    'upgrades', to_jsonb(coalesce(s.upgrades, '{}'::text[])), 'commander_id', s.commander_id, 'jump_lock_until', s.jump_lock_until,
    'troop_posts', s.troop_posts,
    'craft', (select coalesce(jsonb_agg(jsonb_build_object('id', f.id, 'ship_type', f.ship_type, 'hp', f.hp, 'carrier_ship_id', f.carrier_ship_id, 'owner_user_id', f.owner_user_id, 'faction', f.faction) order by f.created_at), '[]'::jsonb)
                from ships f where f.carrier_ship_id = s.id and f.hp > 0),
    'units', (select coalesce(jsonb_agg(jsonb_build_object('id', u.id, 'unit_type', u.unit_type, 'quantity', u.quantity, 'hp', u.hp,
                       'bonus_hp', u.bonus_hp, 'bonus_damage', u.bonus_damage, 'hero_name', u.hero_name, 'hero_id', u.hero_id,
                       'portrait', u.portrait, 'owner_user_id', u.owner_user_id, 'carrier_ship_id', u.carrier_ship_id)), '[]'::jsonb)
                from unit_positions u where u.carrier_ship_id = s.id and u.carrier_unit_id is null and u.hp > 0)
  ) order by s.created_at), '[]'::jsonb)
  from ships s
  where s.system_id = p_system and not coalesce(s.in_transit, false) and s.carrier_ship_id is null and s.hp > 0;
$function$;
