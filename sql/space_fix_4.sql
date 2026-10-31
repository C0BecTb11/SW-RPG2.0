-- Космос, этап 4: абордаж и экипаж (аудит space-audit, SPACE-BUG-019, 027).
--  019 — пока на борту идёт абордаж, корабль не уйдёт в гиперпространство: сервер шлёт в строке корабля bd (секунды),
--        сверка держит снимок rt_battles.snapshot.board, сторож rt_battle_guard по нему отказывает.
--  027 — журнал: гибель бойцов орбиты — строкой на тип с числом (триггер ev_units писал одну на тип за транзакцию, amount 1);
--        захват — события «Корабль захвачен» прежнему хозяину и «Трофей» захватчику; оплаченные заказы верфи на трофей —
--        половина назад, как при захвате планеты (refund_pending_on_capture), а не молча «выполнены».
--  и правка этапа 2: сторож читал поля бойца (carrier_unit_id) и у строки корабля — любое изменение корабля падало.
-- Правки — заменой мест в живых функциях (как deliver_ready_repairs в space_fix_2.sql): место не найдено — ошибка, ничего не меняется.

insert into public.event_types (type, category, title, tone, jumpable) values
  ('ship_captured', 'combat', 'Корабль захвачен', 'bad', true),
  ('ship_trophy', 'combat', 'Трофей', 'good', true)
on conflict (type) do nothing;

do $patch$
declare d text; a text; b text;
begin
  d := pg_get_functiondef('public.rt_space_sync(text,uuid,jsonb,jsonb,jsonb,jsonb,jsonb)'::regprocedure);
  if position('ship_trophy' in d) = 0 then

  -- переменные
  a := $q$  v_max integer;$q$;
  b := $q$  v_max integer;
  v_old uuid; v_oldf text; v_type text; v_half integer; o record;
  brd jsonb; brd_off text[];$q$;
  if (length(d) - length(replace(d, a, ''))) / length(a) <> 1 then raise exception 'rt_space_sync: место 1 (переменные)'; end if;
  d := replace(d, a, b);

  -- трофей: прежний хозяин и тип — до передачи
  a := $q$    select t.max_hp + coalesce(s.bonus_hp, 0) into v_max from ships s join ship_types t on t.id = s.ship_type where s.id = r.id;$q$;
  b := $q$    select t.max_hp + coalesce(s.bonus_hp, 0), s.owner_user_id, s.faction, s.ship_type into v_max, v_old, v_oldf, v_type
      from ships s join ship_types t on t.id = s.ship_type where s.id = r.id;$q$;
  if (length(d) - length(replace(d, a, ''))) / length(a) <> 1 then raise exception 'rt_space_sync: место 2 (трофей)'; end if;
  d := replace(d, a, b);

  -- трофей: павшие в обороне — в журнал по одному
  a := $q$    delete from unit_positions where carrier_ship_id = r.id and carrier_unit_id is null and faction is distinct from r.faction;$q$;
  b := $q$    for o in select u.owner_user_id, u.faction, u.unit_type, count(*)::integer as n from unit_positions u
              where u.carrier_ship_id = r.id and u.carrier_unit_id is null and u.faction is distinct from r.faction group by 1, 2, 3 loop
      perform log_event(o.owner_user_id, o.faction, v_sys, 'unit_killed', o.unit_type, o.n, 'private',
                        jsonb_build_object('layer', 'space', 'ship_id', r.id, 'rt', true));
    end loop;
    for o in select u.id from unit_positions u
              where u.carrier_ship_id = r.id and u.carrier_unit_id is null and u.faction is distinct from r.faction loop
      perform set_config('app.rt_gone', o.id::text, true);
      delete from unit_positions where id = o.id;
    end loop;
    perform set_config('app.rt_gone', '', true);$q$;
  if (length(d) - length(replace(d, a, ''))) / length(a) <> 1 then raise exception 'rt_space_sync: место 3 (оборона)'; end if;
  d := replace(d, a, b);

  -- трофей: заказы верфи — половина назад; события захвата
  a := $q$    update repair_orders set delivered = true where ship_id = r.id and not delivered;$q$;
  b := $q$    for o in select ro.id, ro.owner_user_id, ro.cost, ro.kind from repair_orders ro where ro.ship_id = r.id and not ro.delivered loop
      v_half := floor(coalesce(o.cost, 0) / 2.0);
      if v_half > 0 then update profiles set credits = credits + v_half where id = o.owner_user_id; end if;
      delete from repair_orders where id = o.id;
      perform log_event(o.owner_user_id, null, v_sys, 'order_refunded',
                        case o.kind when 'refit' then 'Модернизация' when 'hangar' then 'Пополнение ангара' else 'Ремонт' end, 1, 'private',
                        jsonb_build_object('refund', v_half, 'reason', 'capture', 'layer', 'space'));
    end loop;
    perform log_event(v_old, v_oldf, v_sys, 'ship_captured', v_type, 1, 'private', jsonb_build_object('layer', 'space', 'by', r.faction));
    perform log_event(r.captor, r.faction, v_sys, 'ship_trophy', v_type, 1, 'private', jsonb_build_object('layer', 'space', 'ship_id', r.id));$q$;
  if (length(d) - length(replace(d, a, ''))) / length(a) <> 1 then raise exception 'rt_space_sync: место 4 (заказы)'; end if;
  d := replace(d, a, b);

  -- погибшие бойцы: в журнал по одному, триггер молчит (app.rt_gone)
  a := $q$  for r in
    select (x->>'id')::uuid as id from jsonb_array_elements(coalesce(p_units, '[]'::jsonb)) x where coalesce((x->>'hp')::integer, 0) <= 0
  loop
    delete from unit_positions u where u.id = r.id and u.carrier_ship_id is not null
       and exists (select 1 from rt_battle_locks l join ships c on c.id = l.obj_id
                    where l.obj_kind = 'ship' and l.obj_id = u.carrier_ship_id and l.battle_id = p_battle
                      and not coalesce(c.in_transit, false) and c.system_id = v_sys);
    n_d := n_d + 1;
  end loop;$q$;
  b := $q$  -- в журнал — одной строкой на тип и корабль (триггер ev_units писал одну на тип за транзакцию, SPACE-BUG-027)
  for r in
    select u.owner_user_id, u.faction, u.unit_type, u.carrier_ship_id, count(*)::integer as n
      from jsonb_array_elements(coalesce(p_units, '[]'::jsonb)) e(j)            -- не x: у бойца есть столбец x
      join unit_positions u on u.id = (e.j->>'id')::uuid
     where coalesce((e.j->>'hp')::integer, 0) <= 0 and u.carrier_ship_id is not null
       and exists (select 1 from rt_battle_locks l join ships c on c.id = l.obj_id
                    where l.obj_kind = 'ship' and l.obj_id = u.carrier_ship_id and l.battle_id = p_battle
                      and not coalesce(c.in_transit, false) and c.system_id = v_sys)
     group by 1, 2, 3, 4
  loop
    perform log_event(r.owner_user_id, r.faction, v_sys, 'unit_killed', r.unit_type, r.n, 'private',
                      jsonb_build_object('layer', 'space', 'ship_id', r.carrier_ship_id, 'rt', true));
  end loop;
  for r in
    select u.id
      from jsonb_array_elements(coalesce(p_units, '[]'::jsonb)) e(j)
      join unit_positions u on u.id = (e.j->>'id')::uuid
     where coalesce((e.j->>'hp')::integer, 0) <= 0 and u.carrier_ship_id is not null
       and exists (select 1 from rt_battle_locks l join ships c on c.id = l.obj_id
                    where l.obj_kind = 'ship' and l.obj_id = u.carrier_ship_id and l.battle_id = p_battle
                      and not coalesce(c.in_transit, false) and c.system_id = v_sys)
  loop
    perform set_config('app.rt_gone', r.id::text, true);
    delete from unit_positions where id = r.id;
    n_d := n_d + 1;
  end loop;
  perform set_config('app.rt_gone', '', true);$q$;
  if (length(d) - length(replace(d, a, ''))) / length(a) <> 1 then raise exception 'rt_space_sync: место 5 (гибель)'; end if;
  d := replace(d, a, b);

  -- абордаж на борту: до какого времени (сервер продлевает строкой корабля, 0 — кончился)
  a := $q$    from jsonb_array_elements(coalesce(p_ships, '[]'::jsonb)) x where x ? 'held' and coalesce((x->>'held')::numeric, 0) <= 0;$q$;
  b := a || $q$
  select coalesce(jsonb_object_agg(x->>'id', to_jsonb(now() + make_interval(secs => least(120, (x->>'bd')::numeric)::double precision))), '{}'::jsonb) into brd
    from jsonb_array_elements(coalesce(p_ships, '[]'::jsonb)) x where coalesce((x->>'bd')::numeric, 0) > 0;
  select coalesce(array_agg(x->>'id'), '{}') into brd_off
    from jsonb_array_elements(coalesce(p_ships, '[]'::jsonb)) x where x ? 'bd' and coalesce((x->>'bd')::numeric, 0) <= 0;$q$;
  if (length(d) - length(replace(d, a, ''))) / length(a) <> 1 then raise exception 'rt_space_sync: место 6 (абордаж)'; end if;
  d := replace(d, a, b);
  a := $q$                                       -- бойцы трюма в деле (сервер шлёт, когда список меняется)$q$;
  b := $q$                                       -- на борту абордаж — прыжок закрыт (SPACE-BUG-019)
                                       'board', coalesce((
           select jsonb_object_agg(k, v) from jsonb_each(coalesce(b.snapshot->'board', '{}'::jsonb)) e(k, v)
            where (v #>> '{}')::timestamptz > now() and not (brd ? k) and not (k = any(brd_off))), '{}'::jsonb) || brd,
$q$ || a;
  if (length(d) - length(replace(d, a, ''))) / length(a) <> 1 then raise exception 'rt_space_sync: место 7 (снимок)'; end if;
  d := replace(d, a, b);
  execute d;
  end if;

  -- сторож: под абордажем — не прыгнуть
  d := pg_get_functiondef('public.rt_battle_guard()'::regprocedure);
  if position('под абордажем' in d) = 0 then
    a := $q$          coalesce(old.name, (select t.name from ship_types t where t.id = old.ship_type), '') using errcode = 'P0001', hint = 'rt_busy';
      end if;
      return new;$q$;
    b := $q$          coalesce(old.name, (select t.name from ship_types t where t.id = old.ship_type), '') using errcode = 'P0001', hint = 'rt_busy';
      end if;
      select (b.snapshot->'board'->>old.id::text)::timestamptz into fire_at from rt_battles b where b.id = bid;
      if fire_at is not null and fire_at > now() then
        raise exception 'Корабль «%» под абордажем — в гиперпространство не уйти',
          coalesce(old.name, (select t.name from ship_types t where t.id = old.ship_type), '') using errcode = 'P0001', hint = 'rt_busy';
      end if;
      return new;$q$;
    if (length(d) - length(replace(d, a, ''))) / length(a) <> 1 then raise exception 'rt_battle_guard: место'; end if;
    execute replace(d, a, b);
  end if;
end $patch$;

-- сторож (этап 2): ветка бойца — только для бойцов
do $patch$
declare d text; a text; b text;
begin
  d := pg_get_functiondef('public.rt_battle_guard()'::regprocedure);
  if position('поля бойца читаются только' in d) > 0 then return; end if;
  a := $q$  if k = 'unit' and auth.uid() is not null and old.carrier_ship_id is not null
     and (tg_op$q$;
  b := $q$  -- поля бойца читаются только для бойцов: у строки корабля их нет (plpgsql берёт все поля выражения сразу)
  if k = 'unit' then
  if auth.uid() is not null and old.carrier_ship_id is not null
     and (tg_op$q$;
  if (length(d) - length(replace(d, a, ''))) / length(a) <> 1 then raise exception 'rt_battle_guard: место 1'; end if;
  d := replace(d, a, b);
  a := $q$      using errcode = 'P0001', hint = 'rt_busy';
  end if;
  select l.battle_id into bid$q$;
  b := $q$      using errcode = 'P0001', hint = 'rt_busy';
  end if;
  end if;
  select l.battle_id into bid$q$;
  if (length(d) - length(replace(d, a, ''))) / length(a) <> 1 then raise exception 'rt_battle_guard: место 2'; end if;
  execute replace(d, a, b);
end $patch$;
