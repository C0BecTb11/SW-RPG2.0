-- Разведчик между системами в бою 2.0 (26.10.2026, решение Артёма: перенести в 2.0).
-- Зонд-разведчик уходит с планеты через сервер боёв: комната ведёт его в зону (полоса вторжения
-- у нападающего, зона высадки у своих) и вызывает start_scout_move через rt_ground_act.
-- Прилёт по-прежнему делает cron finish-scout-moves (finish_scout_moves).
--  1) rt_ground_act: разрешено действие start_scout_move;
--  2) start_scout_move: без assert_unit_can_act (очков действий и оглушения в 2.0 нет);
--  3) rt_obj_busy_2_0: замок боя не держит бойца, который в пути (transit_to) или уже не на планете
--     боя — иначе прилёт разведчика (cron, без игрока) молча отменялся rt_battle_guard, пока
--     открыта планета, с которой он улетел;
--  4) rt_ground_sync: гибель из записи боя не стирает бойца, который уже не на земле (в пути или
--     на борту) — сервер мог прислать её вдогонку за вылетом или погрузкой.
-- Повторный запуск безопасен: каждая правка пропускается, если уже сделана.
do $$
declare v_def text; a text; b text;
begin
  -- 1) rt_ground_act
  v_def := pg_get_functiondef('public.rt_ground_act(text,uuid,text,jsonb)'::regprocedure);
  if position('start_scout_move' in v_def) = 0 then
    a := $x$  else
    raise exception 'rt: действие не разрешено: %', p_fn;$x$;
    b := $x$  elsif p_fn = 'start_scout_move' then
    res := to_jsonb(start_scout_move((p_args->>'unit')::uuid, p_args->>'system'));
  else
    raise exception 'rt: действие не разрешено: %', p_fn;$x$;
    if (length(v_def) - length(replace(v_def, a, ''))) / length(a) <> 1 then raise exception 'rt_ground_act: якорь не один'; end if;
    execute replace(v_def, a, b);
  end if;

  -- 2) start_scout_move
  v_def := pg_get_functiondef('public.start_scout_move(uuid,text)'::regprocedure);
  a := $x$  perform assert_unit_can_act(p_unit_id);

$x$;
  if position(a in v_def) > 0 then
    if (length(v_def) - length(replace(v_def, a, ''))) / length(a) <> 1 then raise exception 'start_scout_move: якорь не один'; end if;
    execute replace(v_def, a, '');
  end if;

  -- 3) rt_obj_busy_2_0
  v_def := pg_get_functiondef('public.rt_obj_busy_2_0(text,uuid)'::regprocedure);
  if position('u.transit_to is not null' in v_def) = 0 then
    a := $x$                  or (s.carrier_ship_id is null and s.system_id is distinct from b.system_id))))
  limit 1;$x$;
    b := $x$                  or (s.carrier_ship_id is null and s.system_id is distinct from b.system_id))))
    -- боец в пути (разведчик) или уже не на планете боя — замок тоже не его
    and (p_kind <> 'unit' or not exists (
          select 1 from unit_positions u
           where u.id = p_id
             and (u.transit_to is not null or u.system_id is distinct from b.system_id)))
  limit 1;$x$;
    if (length(v_def) - length(replace(v_def, a, ''))) / length(a) <> 1 then raise exception 'rt_obj_busy_2_0: якорь не один'; end if;
    execute replace(v_def, a, b);
  end if;

  -- 4) rt_ground_sync
  v_def := pg_get_functiondef('public.rt_ground_sync(text,uuid,jsonb,jsonb)'::regprocedure);
  if position('t.transit_to is null and t.carrier_ship_id is null' in v_def) = 0 then
    a := $x$    if not exists (select 1 from rt_battle_locks l where l.obj_kind = 'unit' and l.obj_id = r.id and l.battle_id = p_battle) then
      continue;
    end if;
$x$;
    b := a || $x$    -- уже не на земле (в пути, на борту): запоздавшая гибель не стирает бойца
    if not exists (select 1 from unit_positions t where t.id = r.id and t.x is not null and t.transit_to is null and t.carrier_ship_id is null) then
      continue;
    end if;
$x$;
    if (length(v_def) - length(replace(v_def, a, ''))) / length(a) <> 1 then raise exception 'rt_ground_sync: якорь не один'; end if;
    execute replace(v_def, a, b);
  end if;
end $$;
