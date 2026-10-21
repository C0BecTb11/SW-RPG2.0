-- Мародёры в наземке 2.0
--  1) rt_ground_units отдаёт мозг мародёра (логово и состояние npc_brains): комната наземки ведёт
--     банду сама (shared/rt-ground.js → aiRaid), а по концу налёта (state = 'leave') уводит её с карты.
--  2) Цель обучения («убей мародёра» после высадки) встаёт вне выстрела всех бойцов и турелей
--     планеты: в бою 2.0 дальность втрое больше клеток игры (RANGE_K = 3), и прежние 3–7 клеток
--     от бойца означали, что его сбивали раньше, чем игрок открывал карту.
--  3) Цель обучения не считается брошенным мародёром: marauder_raid_tick не отправляет её «уходить»,
--     пока обучение идёт.

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
    -- мародёр: логово и состояние (leave — налёт кончился, банда уходит)
    'brain', (select jsonb_build_object('hx', b.home_x, 'hy', b.home_y, 'st', b.state)
                from npc_brains b where b.unit_id = u.id and b.kind = 'marauder'),
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

create or replace function public.tutorial_spawn_target(p_user uuid, p_since timestamp with time zone)
 returns uuid
 language plpgsql
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_sys text; u record; c record;
  v_grid integer := game_setting_int('ground_grid_cells', 144);
  v_r integer; v_zx integer; v_zy integer; v_id uuid;
begin
  select g.system_id into v_sys from game_events g
  where g.user_id = p_user and g.type = 'unit_deployed' and g.created_at >= p_since
  order by g.created_at desc limit 1;
  if v_sys is null then return null; end if;

  select * into u from unit_positions
  where owner_user_id = p_user and system_id = v_sys and x is not null and layer = 'ground'
  order by updated_at desc nulls last limit 1;
  if not found then return null; end if;

  -- Бой 2.0 бьёт втрое дальше клеток игры: кольцо поиска — за самой дальней пушкой на планете
  select greatest(12, coalesce(max((coalesce(t.weapon_range, 0) + coalesce(g.bonus_range, 0)) * 3), 0) + 4) into v_r
  from unit_positions g join unit_types t on t.id = g.unit_type
  where g.system_id = v_sys and g.layer = 'ground' and g.x is not null and g.hp > 0 and g.faction <> 'marauder';
  select z.x + z.size / 2, z.y + z.size / 2 into v_zx, v_zy from settlement_zone_box() z;

  for c in
    select q.cx, q.cy
    from (select u.x + dx as cx, u.y + dy as cy, greatest(abs(dx), abs(dy)) as r
          from generate_series(-(v_r + 10), v_r + 10) dx, generate_series(-(v_r + 10), v_r + 10) dy
          where greatest(abs(dx), abs(dy)) between v_r and v_r + 10) q
    where q.cx >= 2 and q.cy >= 2 and q.cx < v_grid - 2 and q.cy < v_grid - 2
      and not is_in_settlement_zone(q.cx, q.cy)
      -- вне выстрела любого бойца на планете (с запасом на захват цели)
      and not exists (select 1 from unit_positions g join unit_types t on t.id = g.unit_type
                      where g.system_id = v_sys and g.layer = 'ground' and g.x is not null and g.hp > 0 and g.faction <> 'marauder'
                        and greatest(abs(g.x - q.cx), abs(g.y - q.cy)) <= (coalesce(t.weapon_range, 0) + coalesce(g.bonus_range, 0)) * 3 + 3)
      -- и вне турелей
      and not exists (select 1 from field_structures s join structure_types st on st.id = s.type_id
                      where s.system_id = v_sys and st.kind = 'turret'
                        and greatest(abs(s.x - q.cx), abs(s.y - q.cy)) <= coalesce(st.radius, 0) * 3 + 3)
    -- сперва вне досягаемости городских башен, ближе к бойцам и в сторону города
    order by greatest(abs(q.cx - v_zx), abs(q.cy - v_zy)) <= 42, q.r,
             (q.cx - v_zx) * (q.cx - v_zx) + (q.cy - v_zy) * (q.cy - v_zy), q.cx, q.cy
  loop
    continue when not is_ground_box_free(v_sys, c.cx, c.cy, 1, 1, null);
    insert into unit_positions (system_id, layer, x, y, owner_user_id, faction, unit_type, quantity, hp)
    values (v_sys, 'ground', c.cx, c.cy, null, 'marauder', 'marauder', 1, 60)
    returning id into v_id;
    return v_id;
  end loop;
  return null;
end;
$function$;

create or replace function public.marauder_raid_tick()
 returns integer
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  t record; ld record;
  v_stage text; v_at timestamptz; v_end timestamptz; v_ids uuid[]; v_gang uuid[];
  v_alive integer; v_n integer; v_acts integer := 0;
  v_warn integer := game_setting_int('marauder_warn_minutes', 30);
begin
  -- Брошенный мародёр без мозга (налёт стёрся) уходит. Кроме цели обучения: она ждёт игрока.
  insert into npc_brains (unit_id, kind, system_id, home_x, home_y, leash, state, last_hp)
  select u.id, 'marauder', u.system_id, coalesce(u.x, 0), coalesce(u.y, 0), 8, 'leave', u.hp
  from unit_positions u
  where u.faction = 'marauder' and u.owner_user_id is null
    and coalesce(u.updated_at, '-infinity'::timestamptz) < now() - interval '10 minutes'
    and not exists (select 1 from npc_brains b where b.unit_id = u.id)
    and not exists (select 1 from tutorial_state ts
                    where ts.status = 'active' and ts.meta ->> 'target_id' = u.id::text)
  on conflict (unit_id) do nothing;

  for t in
    select tk.id, tk.system_id, tk.payload
    from settlement_tasks tk
    join settlement_state st on st.system_id = tk.system_id and st.cycle_started = tk.cycle_start
    join systems sy on sy.id = tk.system_id
    where tk.kind = 'marauder' and sy.faction is not null
      and coalesce(tk.payload ->> 'stage', '') in ('scouted', 'warned', 'raid', 'escaped', 'cancelled')
    order by tk.system_id
    for update of tk skip locked
  loop
    v_stage := t.payload ->> 'stage';
    v_ids := array(select j.v::uuid
                   from jsonb_array_elements_text(coalesce(t.payload -> 'unit_ids', '[]'::jsonb)) j(v));

    if v_stage in ('escaped', 'cancelled') then
      update npc_brains set state = 'leave'
      where unit_id = any(v_ids) and state is distinct from 'leave';
      continue;
    end if;

    v_at := (t.payload ->> 'raid_at')::timestamptz;
    v_end := (t.payload ->> 'raid_ends')::timestamptz;
    continue when v_at is null or v_end is null;

    if v_stage = 'scouted' and now() < v_at and now() >= v_at - make_interval(mins => v_warn) then
      perform marauder_notify(t.system_id, 'marauder_approach',
                              'Банда будет у поселения около ' || marauder_hhmm(v_at), 1,
                              jsonb_build_object('raid_at', v_at), true);
      update settlement_tasks
      set payload = payload || jsonb_build_object('stage', 'warned', 'warned_at', now())
      where id = t.id;
      v_acts := v_acts + 1;

    elsif v_stage in ('scouted', 'warned') and now() >= v_at then
      if now() >= v_end then
        -- Налёт так и не начался (тики стояли): игроку не в укор
        update settlement_tasks set payload = payload || jsonb_build_object('stage', 'calm') where id = t.id;
        continue;
      end if;

      -- Недовольное поселение привлекает банду, а не одиночку
      v_n := case when settlement_effective(t.system_id) < 30 then 2 + floor(random() * 2)::integer else 1 end;
      v_gang := spawn_marauder_gang(t.system_id, v_n);
      -- Нет места для логова — пробуем следующим тиком
      continue when coalesce(array_length(v_gang, 1), 0) = 0;
      v_n := array_length(v_gang, 1);

      update settlement_tasks
      set target = v_n,
          payload = payload || jsonb_build_object('stage', 'raid', 'unit_id', v_gang[1],
                                                  'unit_ids', to_jsonb(v_gang), 'spawned_at', now())
      where id = t.id;

      select u.x, u.y into ld from unit_positions u where u.id = v_gang[1];
      perform marauder_notify(t.system_id, 'marauder_raid',
        case when v_n > 1 then 'Банда: ' || ru_plural(v_n, 'налётчик', 'налётчика', 'налётчиков')
             else 'Одиночный налётчик' end || ' · уйдёт около ' || marauder_hhmm(v_end),
        1, jsonb_build_object('count', v_n, 'x', ld.x, 'y', ld.y, 'raid_ends', v_end), true);
      v_acts := v_acts + 1;

    elsif v_stage = 'raid' then
      select count(*) into v_alive from unit_positions u where u.id = any(v_ids) and u.hp > 0;
      if v_alive = 0 then
        update settlement_tasks
        set payload = payload || jsonb_build_object('stage', 'defeated', 'ended_at', now())
        where id = t.id;
        perform marauder_notify(t.system_id, 'marauder_defeated',
                                'Банда разбита · условие выполнено', 1,
                                jsonb_build_object('count', cardinality(v_ids)), true);
        v_acts := v_acts + 1;
      elsif now() >= v_end then
        update settlement_tasks
        set payload = payload || jsonb_build_object('stage', 'escaped', 'escaped', true,
                                                    'left', v_alive, 'ended_at', now())
        where id = t.id;
        update npc_brains set state = 'leave' where unit_id = any(v_ids);
        perform marauder_notify(t.system_id, 'marauder_left',
                                'Ушло ' || ru_plural(v_alive, 'налётчик', 'налётчика', 'налётчиков') ||
                                ' · условие провалено', 1,
                                jsonb_build_object('count', v_alive), true);
        v_acts := v_acts + 1;
      end if;
    end if;
  end loop;
  return v_acts;
end;
$function$;
