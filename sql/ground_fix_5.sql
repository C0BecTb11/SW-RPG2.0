-- Исправления наземки 2.0, этап 5: синхронизация (аудит 30.10.2026).
--
-- BUG-018  откаты героя и порабощение переживают переоткрытие комнаты: unit_positions.rt_state
--          ({cd: {способность: секунды эпохи}, mind: {by: сторона, until: секунды эпохи}}) пишет сверка
--          (поле st строки), читает rt_ground_units ('rt'). Сервер: server/ground-room.js stOf/restoreSt.
-- BUG-060  боец, павший, пока база грузила его на борт: строка с board = true снимает его и с борта
--          (только в системе боя и только запертого этим боем).
-- Остальное этапа — на сервере боёв и в клиенте (server/ground-room.js, server/index.js,
-- shared/rt-ground-net.js, shared/rt-ground.js, ground/ground.js).

alter table public.unit_positions add column if not exists rt_state jsonb;
comment on column public.unit_positions.rt_state is 'Бой 2.0: откаты способностей героя и порабощение в секундах эпохи (rt_ground_sync)';

create or replace function public.rt_ground_sync(p_key text, p_battle uuid, p_units jsonb default '[]'::jsonb, p_structs jsonb default '[]'::jsonb)
returns jsonb language plpgsql security definer set search_path to 'public', 'pg_temp' as $function$
declare
  n_u integer := 0; n_s integer := 0; n_d integer := 0; n_k integer := 0; n_b integer := 0; v_wait uuid[] := '{}';
  v_sys text; v_dead uuid[] := '{}';
  r record;
  rl record;
  fire jsonb;
begin
  perform rt_need_key(p_key);
  perform set_config('app.rt_battle', '1', true);

  -- писать можно только в живой бой и только по его планете (BUG-058)
  select b.system_id into v_sys from rt_battles b where b.id = p_battle and b.kind = 'ground' and b.status = 'active';
  if v_sys is null then
    return jsonb_build_object('closed', true);
  end if;

  -- погибшие: как в attack_unit — убийство герою, строка с карты долой. Первыми: клетка павшего
  -- свободна для живых в этом же пакете. Сначала все засчёты — пока строки убийц на месте
  -- (герой-убийца мог пасть в этой же сверке, BUG-059), потом удаление
  for r in
    select (x->>'id')::uuid as id, nullif(x->>'by', '')::uuid as killer, coalesce((x->>'board')::boolean, false) as board
    from jsonb_array_elements(coalesce(p_units, '[]'::jsonb)) x
    where coalesce((x->>'hp')::integer, 0) <= 0
  loop
    continue when r.id = any(v_dead);
    if not exists (select 1 from rt_battle_locks l where l.obj_kind = 'unit' and l.obj_id = r.id and l.battle_id = p_battle) then
      continue;
    end if;
    -- уже не на земле этой планеты (в пути, на борту): запоздавшая гибель не стирает бойца.
    -- Кроме board: пал, пока база грузила его на борт, — это комната знает точно (BUG-060)
    if not exists (select 1 from unit_positions t where t.id = r.id and t.system_id = v_sys and t.transit_to is null
                     and ((t.x is not null and t.carrier_ship_id is null) or (r.board and t.carrier_ship_id is not null))) then
      continue;
    end if;
    v_dead := v_dead || r.id;
    if r.killer is not null then
      perform record_hero_kill(r.killer, t.unit_type, t.faction, t.owner_user_id, t.system_id)
        from unit_positions t where t.id = r.id;
    end if;
  end loop;

  -- в журнал — «погиб» (строка удаляется с живым hp, и триггер записал бы «погружен», BUG-054);
  -- мародёр, ушедший с карты, без хозяина — ему журнала нет
  for r in
    select t.id, t.owner_user_id, t.faction, t.unit_type, t.x, t.y
    from unit_positions t where t.id = any(v_dead)
  loop
    perform log_event(r.owner_user_id, r.faction, v_sys, 'unit_killed', r.unit_type, 1, 'private',
                      jsonb_build_object('x', r.x, 'y', r.y, 'rt', true));
    perform set_config('app.rt_gone', r.id::text, true);
    delete from unit_positions where id = r.id;
    delete from rt_battle_locks where obj_kind = 'unit' and obj_id = r.id;
    n_d := n_d + 1;
  end loop;
  perform set_config('app.rt_gone', '', true);

  -- живые: клетка и прочность (только бойцы этого боя). По одному бойцу: в базе на клетку один
  -- боец (idx_unit_positions_cell), а в живом бою двое стоят в одной клетке или меняются местами —
  -- общий запрос падал целиком, и ни позиции, ни здоровье, ни погибшие не записывались.
  -- Клетка занята — второй заход после остальных (цепочки и обмены местами); всё ещё занята —
  -- боец остаётся в прежней клетке до следующей сверки, здоровье пишется всегда.
  -- Прочность — не выше предела бойца (BUG-058). st — откаты героя и порабощение в секундах эпохи
  -- (unit_positions.rt_state, BUG-018): есть в строке — записать (null — стереть)
  for rl in
    select (x->>'id')::uuid as id, (x->>'x')::integer as x, (x->>'y')::integer as y, (x->>'hp')::integer as hp,
           x ? 'st' as has_st, nullif(x->'st', 'null'::jsonb) as st
    from jsonb_array_elements(coalesce(p_units, '[]'::jsonb)) x
    join rt_battle_locks l on l.obj_kind = 'unit' and l.obj_id = (x->>'id')::uuid and l.battle_id = p_battle
    where coalesce((x->>'hp')::integer, 0) > 0
  loop
    begin
      update unit_positions u set x = rl.x, y = rl.y, hp = least(rl.hp, coalesce(t.max_hp + coalesce(u.bonus_hp, 0), rl.hp)),
          rt_state = case when rl.has_st then rl.st else u.rt_state end, updated_at = now()
        from unit_types t
       where u.id = rl.id and t.id = u.unit_type and u.system_id = v_sys and u.layer = 'ground' and u.x is not null;
      get diagnostics n_k = row_count; n_u := n_u + n_k;
    exception when unique_violation then
      v_wait := v_wait || rl.id;
    end;
  end loop;
  if array_length(v_wait, 1) > 0 then
    for rl in
      select (x->>'id')::uuid as id, (x->>'x')::integer as x, (x->>'y')::integer as y, (x->>'hp')::integer as hp,
             x ? 'st' as has_st, nullif(x->'st', 'null'::jsonb) as st
      from jsonb_array_elements(coalesce(p_units, '[]'::jsonb)) x
      where (x->>'id')::uuid = any(v_wait)
    loop
      begin
        update unit_positions u set x = rl.x, y = rl.y, hp = least(rl.hp, coalesce(t.max_hp + coalesce(u.bonus_hp, 0), rl.hp)),
          rt_state = case when rl.has_st then rl.st else u.rt_state end, updated_at = now()
          from unit_types t
         where u.id = rl.id and t.id = u.unit_type and u.system_id = v_sys and u.layer = 'ground' and u.x is not null;
        get diagnostics n_k = row_count; n_u := n_u + n_k;
      exception when unique_violation then
        update unit_positions u set hp = least(rl.hp, coalesce(t.max_hp + coalesce(u.bonus_hp, 0), rl.hp)),
          rt_state = case when rl.has_st then rl.st else u.rt_state end, updated_at = now()
          from unit_types t
         where u.id = rl.id and t.id = u.unit_type and u.system_id = v_sys and u.layer = 'ground' and u.x is not null;
        get diagnostics n_k = row_count; n_u := n_u + n_k; n_b := n_b + n_k;
      end;
    end loop;
  end if;

  -- постройки: только этой планеты и не выше предела типа (BUG-058)
  with rows as (
    select distinct on ((x->>'id')::uuid) (x->>'id')::uuid as id, greatest(0, (x->>'hp')::integer) as hp
    from jsonb_array_elements(coalesce(p_structs, '[]'::jsonb)) x)
  update field_structures f set hp = least(rows.hp, greatest(1, coalesce(st.max_hp, rows.hp)))
    from rows, structure_types st
   where f.id = rows.id and st.id = f.type_id and f.system_id = v_sys;
  get diagnostics n_s = row_count;

  -- разбитые в бою — долой с карты: место, предел построек, выплаты, обзор и стрельба (BUG-052).
  -- Сработавшие мины (тоже hp 0) убирает structures_tick
  for r in
    select f.id from field_structures f join structure_types st on st.id = f.type_id
    where f.system_id = v_sys and f.hp <= 0 and st.kind <> 'landmine'
  loop
    perform destroy_structure(r.id, null);
  end loop;

  -- кто под огнём (rt_battle_guard: погрузка на корабль и его уход закрыты 30 с после попадания)
  select coalesce(jsonb_object_agg(x->>'id', to_jsonb(now())), '{}'::jsonb) into fire
    from jsonb_array_elements(coalesce(p_units, '[]'::jsonb)) x where coalesce((x->>'fire')::boolean, false);
  update rt_battles b
     set heartbeat_at = now(),
         snapshot = jsonb_build_object('fire', coalesce((
           select jsonb_object_agg(k, v) from jsonb_each(coalesce(b.snapshot->'fire', '{}'::jsonb)) e(k, v)
            where (v #>> '{}')::timestamptz > now() - interval '60 seconds' and not (fire ? k)), '{}'::jsonb) || fire),
         snapshot_at = now()
   where b.id = p_battle and b.status = 'active';
  return jsonb_build_object('units', n_u, 'dead', n_d, 'structs', n_s, 'busy', n_b);
end;
$function$;

create or replace function public.rt_ground_units(p_system text)
returns jsonb language sql stable security definer set search_path to 'public', 'pg_temp' as $function$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', u.id, 'type', u.unit_type, 'x', u.x, 'y', u.y, 'hp', u.hp, 'owner', u.owner_user_id, 'faction', u.faction,
    'hero', u.hero_id, 'name', u.hero_name, 'portrait', u.portrait,
    'bonus', jsonb_build_object('hp', coalesce(u.bonus_hp, 0), 'damage', coalesce(u.bonus_damage, 0), 'vision', coalesce(u.bonus_vision, 0),
                                'move', coalesce(u.bonus_move, 0), 'range', coalesce(u.bonus_range, 0), 'accuracy', coalesce(u.bonus_accuracy, 0), 'evasion', coalesce(u.bonus_evasion, 0)),
    'npc', (select b.kind from npc_brains b where b.unit_id = u.id),
    'brain', (select jsonb_build_object('hx', b.home_x, 'hy', b.home_y, 'st', b.state)
                from npc_brains b where b.unit_id = u.id and b.kind = 'marauder'),
    'abil', (select coalesce(jsonb_agg(h.ability_id), '[]'::jsonb) from hero_learned h where h.hero_id = u.hero_id),
    'skills', (select coalesce(jsonb_agg(jsonb_build_array(substr(r.effect_kind, 9), r.effect_value, coalesce(r.ability_damage, 0)) order by r.sort_order), '[]'::jsonb)
                 from researches r where r.id = any(coalesce(u.upgrades, '{}')) and r.effect_kind like 'ability\_%'),
    'training', u.training_until is not null and u.training_until > now(),
    'carrier', u.carrier_unit_id,
    'rt', u.rt_state,
    'updated', u.updated_at
  ) order by u.id), '[]'::jsonb)
  from unit_positions u
  where u.system_id = p_system and u.layer = 'ground' and u.x is not null and u.hp > 0
    and u.transit_to is null;
$function$;
