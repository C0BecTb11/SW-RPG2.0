-- Исследования в боях 2.0
--  1) Док на живой орбите: заказы верфи (ремонт, модернизация, ангар) для корабля, запертого
--     боем 2.0, проходят, если корабль не под огнём последние 30 с. Комната орбиты подхватывает
--     улучшения на ходу (server/system-room.js → Battle.refitShip).
--  2) Способности бойцов из исследований (граната, фугас, заградительный огонь, оглушение,
--     выстрел в голову, бронебойный, спаренный выстрел, рывок) уходят в наземку 2.0: skills.

create or replace function public.rt_battle_guard_ref()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  j jsonb;
  busy boolean := false;
  fire_at timestamptz;
begin
  if coalesce(current_setting('app.rt_battle', true), '') = '1' then return new; end if;
  -- Быстрый выход: нет ни одного идущего боя 2.0 (частичный индекс по status)
  if not exists (select 1 from rt_battles where status = 'active') then return new; end if;
  j := to_jsonb(new);
  -- верфь на живой орбите: можно, если корабль не под огнём (снимок боя: когда по нему били)
  if tg_table_name = 'repair_orders' and (j->>'ship_id') is not null then
    if rt_obj_busy_2_0('ship', (j->>'ship_id')::uuid) is null then return new; end if;
    select (b.snapshot->'fire'->>(j->>'ship_id'))::timestamptz into fire_at
      from rt_battle_locks l join rt_battles b on b.id = l.battle_id
     where l.obj_kind = 'ship' and l.obj_id = (j->>'ship_id')::uuid and b.status = 'active'
     limit 1;
    if fire_at is null or fire_at <= now() - interval '30 seconds' then return new; end if;
    if auth.uid() is not null then
      raise exception 'Корабль под огнём — верфь примет его, когда бой вокруг стихнет' using errcode = 'P0001', hint = 'rt_busy';
    end if;
    return null;
  end if;
  if tg_table_name = 'troop_transfer_items' then
    busy := (j->>'kind') in ('unit','ship') and (j->>'item_id') is not null
            and rt_obj_busy_2_0(j->>'kind', (j->>'item_id')::uuid) is not null;
  elsif tg_table_name = 'boardings' then
    busy := ((j->>'attacker_ship_id') is not null and rt_obj_busy_2_0('ship', (j->>'attacker_ship_id')::uuid) is not null)
         or ((j->>'target_ship_id')   is not null and rt_obj_busy_2_0('ship', (j->>'target_ship_id')::uuid)   is not null);
  else
    busy := ((j->>'unit_id') is not null and rt_obj_busy_2_0('unit', (j->>'unit_id')::uuid) is not null)
         or ((j->>'ship_id') is not null and rt_obj_busy_2_0('ship', (j->>'ship_id')::uuid) is not null);
  end if;
  if not busy then return new; end if;
  if auth.uid() is not null then
    raise exception 'Отряд или корабль сейчас в бою 2.0' using errcode = 'P0001', hint = 'rt_busy';
  end if;
  return null;
end;
$function$;

create or replace function public.rt_ground_units(p_system text)
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', u.id, 'type', u.unit_type, 'x', u.x, 'y', u.y, 'hp', u.hp, 'owner', u.owner_user_id, 'faction', u.faction,
    'hero', u.hero_id, 'name', u.hero_name, 'portrait', u.portrait,
    'bonus', jsonb_build_object('hp', coalesce(u.bonus_hp, 0), 'damage', coalesce(u.bonus_damage, 0), 'vision', coalesce(u.bonus_vision, 0),
                                'move', coalesce(u.bonus_move, 0), 'range', coalesce(u.bonus_range, 0), 'accuracy', coalesce(u.bonus_accuracy, 0), 'evasion', coalesce(u.bonus_evasion, 0)),
    'npc', (select b.kind from npc_brains b where b.unit_id = u.id),
    'ctrl', case when u.control_until is not null and u.control_until > now() then u.orig_faction end,
    'abil', (select coalesce(jsonb_agg(h.ability_id), '[]'::jsonb) from hero_learned h where h.hero_id = u.hero_id),
    -- способности из исследований: [вид, сила, урон] — бойцы 2.0 применяют их сами
    'skills', (select coalesce(jsonb_agg(jsonb_build_array(substr(r.effect_kind, 9), r.effect_value, coalesce(r.ability_damage, 0)) order by r.sort_order), '[]'::jsonb)
                 from researches r where r.id = any(coalesce(u.upgrades, '{}')) and r.effect_kind like 'ability\_%'),
    'training', u.training_until is not null and u.training_until > now(),
    'carrier', u.carrier_unit_id,
    'updated', u.updated_at
  ) order by u.id), '[]'::jsonb)
  from unit_positions u
  where u.system_id = p_system and u.layer = 'ground' and u.x is not null and u.hp > 0
    and u.transit_to is null;
$function$;
