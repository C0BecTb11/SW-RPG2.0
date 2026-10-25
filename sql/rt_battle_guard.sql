-- Защита объектов боя 2.0 (rt_battle_guard) — ТЕКУЩАЯ версия из базы (аудит 25.10.2026).
-- Ветка 'unit' (погрузка бойца из панелей игры, имя героя) жила только в базе. Более ранние определения
-- в sql/rt_2_0_core.sql, sql/ground_2_0.sql и sql/space_2_0.sql устарели: их повторный прогон откатит эту версию —
-- после любого из них примени этот файл снова. md5(prosrc) = bf6abc2628adf441157b26f5de438528.
CREATE OR REPLACE FUNCTION public.rt_battle_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
    if new.in_transit and not old.in_transit then
      select (b.snapshot->'fire'->>old.id::text)::timestamptz into fire_at from rt_battles b where b.id = bid;
      if fire_at is not null and fire_at > now() - interval '30 seconds' then
        raise exception 'Корабль под огнём — в гиперпространство не уйти' using errcode = 'P0001', hint = 'rt_busy';
      end if;
      return new;
    end if;
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
       and new.ap is not distinct from old.ap and new.overwatch is not distinct from old.overwatch and new.layer is not distinct from old.layer then
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
