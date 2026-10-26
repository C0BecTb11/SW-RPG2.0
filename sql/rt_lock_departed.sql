-- ⚠ (26.10.2026) Если этот файл переопределяет rt_space_sync или rt_battle_guard целиком — после него примени
--   sql/tractor_2_0.sql и sql/rt_battle_guard.sql (притягивающий луч: snapshot.held и запрет прыжка в луче).
-- Корабль, ушедший из живой орбиты (бой 2.0), больше не считается «в бою».
-- Замок rt_battle_locks ставится на корабли орбиты и снимается только с закрытием орбиты. Корабль, прыгнувший
-- из смотримой орбиты, нёс замок с собой: по прибытии в другую систему его строку нельзя было обновить —
-- рейс снабжения вставал «Сбой: Корабль сейчас в бою 2.0» (24.10, Куат → Анаксис), а такт прибытий
-- (без auth.uid) молча пропускал запись кораблей. Теперь корабль занят боем, только пока он в его системе
-- и не в гиперпространстве. Плюс: снимок орбиты не пишет в корабль, который уже не в этой системе, и рейс
-- пересиживает «в бою 2.0» на прибытии, а не встаёт.

create or replace function public.rt_obj_busy_2_0(p_kind text, p_id uuid)
returns uuid language sql stable security definer set search_path to 'public', 'pg_temp' as $$
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
  limit 1;
$$;

do $$
declare v_def text; v_a text; v_b text;
begin
  -- снимок орбиты пишет только корабли, которые всё ещё в её системе
  v_def := pg_get_functiondef('public.rt_space_sync(text,uuid,jsonb,jsonb,jsonb,jsonb)'::regprocedure);
  v_a := E'   where s.id = rows.id and not coalesce(s.in_transit, false);\n';
  v_b := E'   where s.id = rows.id and not coalesce(s.in_transit, false)\n'
      || E'     and s.system_id = (select b.system_id from rt_battles b where b.id = p_battle);\n';
  if position(v_b in v_def) = 0 then
    if position(v_a in v_def) = 0 then raise exception 'rt_space_sync: нет якоря'; end if;
    v_def := replace(v_def, v_a, v_b);
    execute v_def;
  end if;

  -- рейс: прибытие, которое пока не записать (корабль ещё под замком боя), — подождать такт, а не вставать
  v_def := pg_get_functiondef('public.supply_route_step(uuid)'::regprocedure);
  v_a := E'        perform finish_commander_move(cm.id);\n        continue;\n';
  v_b := E'        begin\n'
      || E'          perform finish_commander_move(cm.id);\n'
      || E'        exception when others then\n'
      || E'          if sqlerrm like ''%в бою 2.0%'' or sqlerrm like ''%под огнём%'' then exit; end if;\n'
      || E'          raise;\n'
      || E'        end;\n'
      || E'        continue;\n';
  if position(E'          perform finish_commander_move(cm.id);\n' in v_def) = 0 then
    if position(v_a in v_def) = 0 then raise exception 'supply_route_step: нет якоря прибытия'; end if;
    v_def := replace(v_def, v_a, v_b);
    execute v_def;
  end if;
end $$;
