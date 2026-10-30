-- Исправления наземки 2.0, этап 3: экономика базы (аудит 30.10.2026).
--
-- BUG-052  разбитая в бою постройка оставалась в базе с hp = 0 и продолжала платить, давать обзор,
--          маскировку, довольство и стрелять. Теперь rt_ground_sync сносит её (destroy_structure, как
--          npc_fire_structure); мины по-прежнему убирает structures_tick. Второй рубеж — hp > 0 там,
--          где постройки работают.
-- BUG-053  готовый ремонт бойца, запертого живым боем, отмечался выданным, а сторож молча отменял
--          лечение. Теперь такой заказ ждёт, пока бой отпустит бойца. Ручное «забрать готовое» больше
--          не падает целиком из-за корабля в бою 2.0 — его заказ выдаст cron.
-- BUG-054  гибель в бою 2.0 писалась в журнал как «погружен на корабль»: строка удалялась с живым hp.
--          Теперь сверка сама пишет «погиб» и снимает строку тихо (app.rt_gone).
-- BUG-055  npc_tick и турели/глушилки structures_tick стреляли по бойцам живой планеты: сторож
--          отменял урон, а журнал получал ложные гибели. Живую планету считает бой — такты её пропускают.
-- BUG-057  боец в трюме оставался «в бою»: высадка на той же планете и уход корабля падали. Боец на
--          борту теперь свободен (rt_obj_busy_2_0).
-- BUG-058  rt_ground_sync писала и в закрытый бой, по чужим постройкам и без верхней границы hp;
--          запирания закрытых боёв копились. Теперь — только активный бой своей планеты, hp не выше
--          предела, rt_ground_close снимает запирания.
-- BUG-059  убийство не засчитывалось, если герой-убийца пал в той же сверке. Теперь сначала все
--          засчёты, потом удаление.
-- BUG-061  погрузка: проверки hp и слоя у техники, NULL-количество, высадка только живых.
-- BUG-062  разбор полевой постройки во время захвата планеты закрыт (assert_planet_operational).

-- ---------------------------------------------------------------------------------------------
-- Журнал: удаление бойца, чью гибель уже записала сверка боя 2.0, — без второй строки
create or replace function public.ev_units()
returns trigger language plpgsql as $function$
begin
  if tg_op = 'INSERT' then
    if new.carrier_ship_id is not null then return null; end if;
    perform log_event(new.owner_user_id, new.faction, new.system_id,
                      'unit_deployed', new.unit_type, 1, 'private', jsonb_build_object('unit_id', new.id, 'x', new.x, 'y', new.y));
  else
    -- гибель в бою 2.0: строку в журнал уже записал rt_ground_sync
    if coalesce(current_setting('app.rt_gone', true), '') = old.id::text then
      return null;
    end if;
    -- Удаление юнита — это и гибель, и погрузка обратно в трюм.
    -- Различаем по прочности: у погруженного она осталась.
    if old.hp > 0 and old.carrier_ship_id is null then
      perform log_event(old.owner_user_id, old.faction, old.system_id,
                        'unit_loaded', old.unit_type, 1, 'private', jsonb_build_object('x', old.x, 'y', old.y));
    elsif coalesce(current_setting('app.duel_kill', true), '') = old.id::text then
      null;  -- погиб в схватке: строка уже в сводке
    elsif not exists (
      select 1 from game_events g
      where g.user_id = old.owner_user_id and g.type = 'unit_killed'
        and g.created_at = now() and g.system_id is not distinct from old.system_id
        and g.subject in (old.unit_type, (select t.name from unit_types t where t.id = old.unit_type))
    ) then
      perform log_event(old.owner_user_id, old.faction, old.system_id,
                        'unit_killed', old.unit_type, 1, 'private', jsonb_build_object('x', old.x, 'y', old.y));
    end if;
  end if;
  return null;
end $function$;

-- ---------------------------------------------------------------------------------------------
-- Сверка живого боя с базой
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
    select (x->>'id')::uuid as id, nullif(x->>'by', '')::uuid as killer
    from jsonb_array_elements(coalesce(p_units, '[]'::jsonb)) x
    where coalesce((x->>'hp')::integer, 0) <= 0
  loop
    continue when r.id = any(v_dead);
    if not exists (select 1 from rt_battle_locks l where l.obj_kind = 'unit' and l.obj_id = r.id and l.battle_id = p_battle) then
      continue;
    end if;
    -- уже не на земле этой планеты (в пути, на борту): запоздавшая гибель не стирает бойца
    if not exists (select 1 from unit_positions t where t.id = r.id and t.system_id = v_sys
                     and t.x is not null and t.transit_to is null and t.carrier_ship_id is null) then
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
  -- Прочность — не выше предела бойца (BUG-058)
  for rl in
    select (x->>'id')::uuid as id, (x->>'x')::integer as x, (x->>'y')::integer as y, (x->>'hp')::integer as hp
    from jsonb_array_elements(coalesce(p_units, '[]'::jsonb)) x
    join rt_battle_locks l on l.obj_kind = 'unit' and l.obj_id = (x->>'id')::uuid and l.battle_id = p_battle
    where coalesce((x->>'hp')::integer, 0) > 0
  loop
    begin
      update unit_positions u set x = rl.x, y = rl.y, hp = least(rl.hp, coalesce(t.max_hp + coalesce(u.bonus_hp, 0), rl.hp)), updated_at = now()
        from unit_types t
       where u.id = rl.id and t.id = u.unit_type and u.system_id = v_sys and u.layer = 'ground' and u.x is not null;
      get diagnostics n_k = row_count; n_u := n_u + n_k;
    exception when unique_violation then
      v_wait := v_wait || rl.id;
    end;
  end loop;
  if array_length(v_wait, 1) > 0 then
    for rl in
      select (x->>'id')::uuid as id, (x->>'x')::integer as x, (x->>'y')::integer as y, (x->>'hp')::integer as hp
      from jsonb_array_elements(coalesce(p_units, '[]'::jsonb)) x
      where (x->>'id')::uuid = any(v_wait)
    loop
      begin
        update unit_positions u set x = rl.x, y = rl.y, hp = least(rl.hp, coalesce(t.max_hp + coalesce(u.bonus_hp, 0), rl.hp)), updated_at = now()
          from unit_types t
         where u.id = rl.id and t.id = u.unit_type and u.system_id = v_sys and u.layer = 'ground' and u.x is not null;
        get diagnostics n_k = row_count; n_u := n_u + n_k;
      exception when unique_violation then
        update unit_positions u set hp = least(rl.hp, coalesce(t.max_hp + coalesce(u.bonus_hp, 0), rl.hp)), updated_at = now()
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

-- ---------------------------------------------------------------------------------------------
-- Закрытие боя снимает его запирания (их копилось сотни от закрытых боёв, BUG-058)
create or replace function public.rt_ground_close(p_key text, p_battle uuid, p_result jsonb default null::jsonb)
returns boolean language plpgsql security definer set search_path to 'public', 'pg_temp' as $function$
declare v_ok boolean;
begin
  perform rt_need_key(p_key);
  update rt_battles set status = 'finished', ended_at = now(), result = p_result where id = p_battle and status = 'active';
  v_ok := found;
  delete from rt_battle_locks where battle_id = p_battle;
  return v_ok;
end;
$function$;

-- Боец на борту корабля — уже не в бою планеты: высадка и уход корабля не упираются в старое
-- запирание (BUG-057). Остальное — как было
create or replace function public.rt_obj_busy_2_0(p_kind text, p_id uuid)
returns uuid language sql stable security definer set search_path to 'public', 'pg_temp' as $function$
  select l.battle_id
  from rt_battle_locks l join rt_battles b on b.id = l.battle_id
  where l.obj_kind = p_kind and l.obj_id = p_id
    and b.status = 'active' and b.heartbeat_at > now() - interval '90 seconds'
    -- корабль ушёл из системы боя (гиперпространство, другая система) — замок уже не его
    and (p_kind <> 'ship' or not exists (
          select 1 from ships s
           where s.id = p_id
             and (coalesce(s.in_transit, false)
                  or (s.carrier_ship_id is null and s.system_id is distinct from b.system_id))))
    -- боец в пути (разведчик), в трюме корабля или уже не на планете боя — замок тоже не его
    and (p_kind <> 'unit' or not exists (
          select 1 from unit_positions u
           where u.id = p_id
             and (u.transit_to is not null or u.carrier_ship_id is not null or u.system_id is distinct from b.system_id)))
  limit 1;
$function$;

-- ---------------------------------------------------------------------------------------------
-- Постройки работают, пока целы (BUG-052, второй рубеж)
create or replace function public.radar_covers(p_system text, p_faction text, p_x integer, p_y integer, p_w integer, p_h integer)
returns boolean language sql stable security definer set search_path to 'public', 'pg_temp' as $function$
  select p_faction is not null and p_x is not null and exists (
    select 1 from field_structures s join structure_types st on st.id = s.type_id
    where s.system_id = p_system and st.kind = 'radar' and s.faction = p_faction
      and s.completes_at <= now() and s.hp > 0
      and box_gap(p_x, p_y, p_w, p_h, s.x, s.y, s.w, s.h) <= st.radius);
$function$;

create or replace function public.settlement_structure_bonus(p_system text)
returns integer language sql stable set search_path to 'public', 'pg_temp' as $function$
  select coalesce(sum(st.satisfaction_bonus), 0)::integer
  from field_structures s
  join structure_types st on st.id = s.type_id
  join systems sy on sy.id = s.system_id
  where s.system_id = p_system and s.faction = sy.faction
    and s.completes_at <= now() and s.hp > 0 and st.satisfaction_bonus > 0;
$function$;

create or replace function public.camo_hidden(p_system text, p_layer text, p_x integer, p_y integer)
returns boolean language plpgsql stable security definer set search_path to 'public', 'pg_temp' as $function$
declare u record; v_me text; v_found boolean;
begin
  if p_layer is distinct from 'ground' or p_x is null then return false; end if;
  select faction into v_me from profiles where id = auth.uid();

  -- Быстрый выход: чужой маскировки на планете нет — прятаться негде
  if not exists (
    select 1 from field_structures s join structure_types st on st.id = s.type_id
    where s.system_id = p_system and st.kind = 'camo'
      and s.faction is distinct from v_me and s.completes_at <= now() and s.hp > 0
  ) then
    return false;
  end if;

  select up.owner_user_id, up.faction, up.revealed_until,
         ut.width_cells as w, ut.height_cells as h
    into u
  from unit_positions up join unit_types ut on ut.id = up.unit_type
  where up.system_id = p_system and up.layer = p_layer and up.x = p_x and up.y = p_y
    and up.hp > 0
  limit 1;
  v_found := found;
  if not v_found then return false; end if;

  if u.owner_user_id is not null and u.owner_user_id = auth.uid() then return false; end if;
  if v_me is not null and u.faction = v_me then return false; end if;
  if u.revealed_until is not null and u.revealed_until > now() then return false; end if;
  if radar_covers(p_system, v_me, p_x, p_y, u.w, u.h) then return false; end if;

  if not exists (
    select 1 from field_structures s join structure_types st on st.id = s.type_id
    where s.system_id = p_system and st.kind = 'camo' and s.faction = u.faction
      and s.completes_at <= now() and s.hp > 0
      and boxes_overlap(p_x, p_y, u.w, u.h,
                        s.x - st.radius, s.y - st.radius, s.w + st.radius * 2, s.h + st.radius * 2)
  ) then
    return false;
  end if;

  return not observer_near(p_system, p_x, p_y, u.w, u.h, game_setting_int('camo_detect_cells', 3));
end;
$function$;

-- остов разбитой постройки (и сработавшая мина до такта) клетку не занимает
create or replace function public.is_ground_box_free(p_system_id text, p_x integer, p_y integer, p_w integer, p_h integer, p_ignore_unit uuid default null::uuid)
returns boolean language sql stable security definer set search_path to 'public', 'pg_temp' as $function$
  select p_x is not null and p_y is not null and p_w is not null and p_h is not null
    and p_x >= 0 and p_y >= 0
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
      where s.system_id = p_system_id and s.hp > 0
        and p_x < s.x + s.w and p_x + p_w > s.x
        and p_y < s.y + s.h and p_y + p_h > s.y
    )
    and not ground_box_on_building(p_system_id, p_x, p_y, p_w, p_h)
    and ground_site_at(p_system_id, p_x, p_y, p_w, p_h) is null;
$function$;

-- ---------------------------------------------------------------------------------------------
-- Точечные правки больших функций: кусок должен встретиться ровно один раз; уже применённое — пропуск
do $do$
declare p record; f record; v text; v_hits integer; v_seen integer;
begin
  for p in select * from (values
    -- BUG-053: ремонт запертого боем бойца ждёт; ручная выдача не падает из-за корабля в бою 2.0
    ('deliver_ready_repairs', $o$    for update skip locked
  loop
    if o.kind = 'unit' then$o$, $n$    for update skip locked
  loop
    -- боец заперт живым боем 2.0: здоровье считает бой, сторож отменил бы лечение — выдадим, когда отпустит
    continue when o.kind = 'unit' and rt_obj_busy_2_0('unit', o.unit_id) is not null;
    -- корабль в бою 2.0: из рук игрока сторож не пустит и откатит весь вызов — заказ выдаст cron
    continue when o.kind in ('ship', 'refit') and auth.uid() is not null and rt_obj_busy_2_0('ship', o.ship_id) is not null;
    if o.kind = 'unit' then$n$),
    -- BUG-055: живую планету считает бой
    ('npc_tick', $o$    where u.layer = 'ground' and u.x is not null and u.hp > 0
    order by b.kind desc, b.created_at, b.unit_id$o$, $n$    where u.layer = 'ground' and u.x is not null and u.hp > 0
      and rt_ground_battle(u.system_id) is null          -- живую планету ведёт бой 2.0
    order by b.kind desc, b.created_at, b.unit_id$n$),
    -- BUG-052: платит только целая постройка
    ('structures_tick', $o$      and (st.produces_per_day > 0 or st.credits_per_day > 0)
      and sy.faction = fs.faction$o$, $n$      and (st.produces_per_day > 0 or st.credits_per_day > 0)
      and sy.faction = fs.faction and fs.hp > 0$n$),
    -- BUG-055 + BUG-052: глушилка и турель — только целые и только на планете без живого боя
    ('structures_tick', $o$    where st.kind = 'jammer' and fs.completes_at <= now() and sy.faction = fs.faction$o$,
                        $n$    where st.kind = 'jammer' and fs.completes_at <= now() and sy.faction = fs.faction and fs.hp > 0
      and rt_ground_battle(fs.system_id) is null          -- живую планету ведёт бой 2.0$n$),
    ('structures_tick', $o$    where st.kind = 'turret' and fs.completes_at <= now() and sy.faction = fs.faction$o$,
                        $n$    where st.kind = 'turret' and fs.completes_at <= now() and sy.faction = fs.faction and fs.hp > 0
      and rt_ground_battle(fs.system_id) is null          -- живую планету ведёт бой 2.0$n$),
    ('structures_tick', $o$             where c.system_id = s.system_id and ct.kind = 'camo' and c.faction = u.faction
               and c.completes_at <= now()$o$, $n$             where c.system_id = s.system_id and ct.kind = 'camo' and c.faction = u.faction
               and c.completes_at <= now() and c.hp > 0$n$),
    -- BUG-061: погрузка
    ('load_vehicle_to_ship', $o$  if u.x is null then raise exception 'Юнит уже погружен'; end if;

  select * into ut from unit_types where id = u.unit_type;$o$, $n$  if u.x is null then raise exception 'Юнит уже погружен'; end if;
  if u.layer <> 'ground' then raise exception 'Грузить можно только с поверхности'; end if;
  if u.hp <= 0 then raise exception 'Юнит уничтожен'; end if;

  select * into ut from unit_types where id = u.unit_type;$n$),
    ('load_to_ship', $o$  if p_quantity < 1 then raise exception 'Некорректное количество'; end if;$o$,
                     $n$  if p_quantity is null or p_quantity < 1 then raise exception 'Некорректное количество'; end if;$n$),
    ('load_to_ship', $o$      and u.owner_user_id = v_user and u.unit_type = p_unit_type and u.x is not null
$o$, $n$      and u.owner_user_id = v_user and u.unit_type = p_unit_type and u.x is not null and u.hp > 0
$n$),
    ('unload_unit_at', $o$    and not coalesce(ut.is_vehicle, false) and not coalesce(ut.is_hero, false)
  order by$o$, $n$    and not coalesce(ut.is_vehicle, false) and not coalesce(ut.is_hero, false)
    and hp > 0
  order by$n$),
    -- BUG-058: брошенный бой (сервер упал, без закрытия) — его запирания снимаются при новом открытии
    ('rt_ground_open', $o$     where kind = 'ground' and system_id = p_system and status = 'active';
$o$, $n$     where kind = 'ground' and system_id = p_system and status = 'active';
    delete from rt_battle_locks l using rt_battles b
     where b.id = l.battle_id and b.kind = 'ground' and b.system_id = p_system and b.status <> 'active';
$n$),
    -- BUG-062: во время захвата планеты разбирать нельзя (как строить)
    ('demolish_structure', $o$  if s.owner_user_id is distinct from v_user then raise exception 'Разобрать может только тот, кто строил'; end if;
$o$, $n$  if s.owner_user_id is distinct from v_user then raise exception 'Разобрать может только тот, кто строил'; end if;
  perform assert_planet_operational(s.system_id);
$n$)
  ) t(fn, o, n) loop
    v_seen := 0;
    for f in select pr.oid from pg_proc pr join pg_namespace ns on ns.oid = pr.pronamespace
              where ns.nspname = 'public' and pr.proname = p.fn loop
      v_seen := v_seen + 1;
      v := pg_get_functiondef(f.oid);
      continue when position(p.n in v) > 0;                       -- уже применено
      v_hits := (length(v) - length(replace(v, p.o, ''))) / length(p.o);
      if v_hits <> 1 then
        raise exception 'Правка %: кусок найден % раз(а) вместо одного: %', p.fn, v_hits, left(p.o, 80);
      end if;
      execute replace(v, p.o, p.n);
    end loop;
    if v_seen = 0 then raise exception 'Правка %: функции нет', p.fn; end if;
  end loop;
end $do$;

-- Запирания закрытых и брошенных боёв — долой (rt_obj_busy_2_0 их и так не считает)
delete from rt_battle_locks l
 where not exists (select 1 from rt_battles b where b.id = l.battle_id and b.status = 'active');
