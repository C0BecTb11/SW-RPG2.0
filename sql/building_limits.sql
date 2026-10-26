-- Предел добывающих построек на планете (26.10.2026).
-- Раньше ферм, карьеров и вышек можно было ставить сколько влезет в участки. Теперь у типа есть
-- max_per_planet: сколько таких построек держит одна планета. Для добычи считаются все
-- добывающие этого сырья на планете — свои, трофейные и недостроенные (залежь одна на всех).
-- Провизия нужна почти везде, поэтому ферм больше всего. Уже стоящие сверх предела не сносятся,
-- просто новую не заложить. Повторный запуск безопасен.

alter table building_types add column if not exists max_per_planet integer;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'building_types_max_per_planet_check') then
    alter table building_types add constraint building_types_max_per_planet_check
      check (max_per_planet is null or max_per_planet > 0);
  end if;
end $$;

comment on column building_types.max_per_planet is
  'Сколько таких построек можно держать на одной планете; для добычи — всех добывающих это сырьё. null — без предела.';

update building_types set max_per_planet = 4 where code in ('rep_farm', 'cis_farm');
update building_types set max_per_planet = 3 where code in ('rep_mine', 'cis_mine');
update building_types set max_per_planet = 2 where code in ('rep_gas', 'cis_gas');
update building_types set max_per_planet = 2 where code in ('rep_crystal', 'cis_crystal');

create or replace function public.construct_building(p_system_id text, p_slot_index integer, p_building_type_id uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public', 'extensions', 'pg_temp'
as $function$
declare
  v_user_id uuid := auth.uid();
  v_faction text;
  v_cost integer;
  v_credits integer;
  v_type_faction text;
  v_is_space boolean;
  v_seconds integer;
begin
  if v_user_id is null then
    raise exception 'Не авторизован';
  end if;

  if not exists (
    select 1 from system_control sc
    where sc.system_id = p_system_id and sc.controller_user_id = v_user_id
  ) then
    raise exception 'Нет прав на строительство в этой системе';
  end if;

  -- Участок должен существовать и быть открыт уровнем поселения
  declare v_slot record; v_need integer;
  begin
    select * into v_slot from planet_slots where system_id = p_system_id and slot_index = p_slot_index;
    if not found then raise exception 'Нет такого участка'; end if;

    if p_slot_index > building_slot_cap(p_system_id) then
      v_need := building_slot_need_level(p_slot_index);
      raise exception 'Участок откроется, когда поселение станет «%»',
        coalesce((select name from settlement_levels where level = v_need), 'больше');
    end if;

    -- Здание не встаёт на головы бойцам: иначе они оказались бы внутри стен
    if exists (select 1 from unit_positions u join unit_types t on t.id = u.unit_type
               where u.system_id = p_system_id and u.layer = 'ground' and u.x is not null
                 and boxes_overlap(u.x, u.y, t.width_cells, t.height_cells, v_slot.x, v_slot.y, 6, 6)) then
      raise exception 'На участке стоят войска — сначала отведи их';
    end if;
  end;

  select faction, credits into v_faction, v_credits from profiles where id = v_user_id;

  select cost, faction, is_space into v_cost, v_type_faction, v_is_space
  from building_types where id = p_building_type_id;

  if v_cost is null then
    raise exception 'Неизвестный тип постройки';
  end if;

  -- Нельзя построить здание чужой фракции, даже если подсунуть его id вручную.
  if v_type_faction is distinct from v_faction then
    raise exception 'Эта постройка недоступна твоей фракции';
  end if;

  if v_is_space then
    raise exception 'Космические объекты строятся на орбитальной карте';
  end if;

  -- Добыча возможна только там, где сырьё залегает
  declare
    v_needs boolean; v_res text; v_res_name text;
    v_prim text; v_sec text; v_max integer; v_have integer;
  begin
    select needs_local_resource, produces_resource, max_per_planet into v_needs, v_res, v_max
    from building_types where id = p_building_type_id;

    if v_needs then
      select primary_resource, secondary_resource into v_prim, v_sec
      from systems where id = p_system_id;

      if v_res is distinct from v_prim and v_res is distinct from v_sec then
        select name into v_res_name from resources where id = v_res;
        raise exception 'На этой планете нет такого сырья: %', coalesce(v_res_name, v_res);
      end if;
    end if;

    -- Предел на планете. Две закладки разом не должны обе проскочить под предел:
    -- стройки одной планеты идут по очереди.
    if v_max is not null then
      perform pg_advisory_xact_lock(hashtext('construct:' || p_system_id));

      select count(*) into v_have
      from buildings b join building_types t on t.id = b.building_type_id
      where b.system_id = p_system_id
        and (t.id = p_building_type_id
             or (v_needs and t.needs_local_resource and t.produces_resource = v_res));

      if v_have >= v_max then
        if v_needs then
          select name into v_res_name from resources where id = v_res;
          raise exception 'Больше нельзя: на планете уже % на добыче «%» (предел %)',
            v_have, coalesce(v_res_name, v_res), v_max;
        end if;
        raise exception 'Больше нельзя: на планете уже % таких (предел %)', v_have, v_max;
      end if;
    end if;
  end;

  if v_credits < v_cost then
    raise exception 'Недостаточно кредитов';
  end if;

  select value::integer into v_seconds from game_settings where key = 'build_seconds';
  v_seconds := coalesce(v_seconds, 60);
  -- законы фракции: ±% времени стройки
  v_seconds := greatest(5, round(v_seconds * (100 + effect_sum(p_system_id, 'build_time')) / 100.0)::integer);

  insert into buildings (system_id, slot_index, building_type_id, owner_user_id, faction, completes_at)
  values (p_system_id, p_slot_index, p_building_type_id, v_user_id, v_faction,
          now() + make_interval(secs => v_seconds));

  perform take_build_resources(p_system_id,
             (select cost_resources from building_types where id = p_building_type_id), 1);

  update profiles set credits = credits - v_cost where id = v_user_id;
end;
$function$;
