-- Притягивающий луч в бою 2.0 (26.10.2026): корабль в луче не уходит в гиперпространство.
-- Сервер орбиты пишет в строке корабля rt_space_sync поле held — сколько секунд его ещё держат
-- (0 — отпустили); rt_space_sync хранит в снимке боя snapshot.held = { id корабля: до какого времени },
-- rt_battle_guard не даёт кораблю уйти в гиперпространство, пока срок не вышел.
-- Повторный запуск безопасен: каждая правка пропускается, если уже сделана.
do $$
declare v_def text; a text; b text;
begin
  -- 1) rt_space_sync: snapshot.held
  v_def := pg_get_functiondef('public.rt_space_sync(text,uuid,jsonb,jsonb,jsonb,jsonb)'::regprocedure);
  if position('held_off' in v_def) = 0 then
    a := $x$  fire jsonb;
$x$;
    if (length(v_def) - length(replace(v_def, a, ''))) / length(a) <> 1 then raise exception 'rt_space_sync: объявление не одно'; end if;
    v_def := replace(v_def, a, a || $x$  held jsonb; held_off text[];
$x$);
    a := $x$  update rt_battles b
     set heartbeat_at = now(),
         snapshot = jsonb_build_object('fire', coalesce((
           select jsonb_object_agg(k, v) from jsonb_each(coalesce(b.snapshot->'fire', '{}'::jsonb)) e(k, v)
            where (v #>> '{}')::timestamptz > now() - interval '60 seconds' and not (fire ? k)), '{}'::jsonb) || fire),
         snapshot_at = now()$x$;
    b := $x$  -- притягивающий луч: корабль держат до этого времени (rt_battle_guard не пускает в гиперпространство); 0 — отпустили
  select coalesce(jsonb_object_agg(x->>'id', to_jsonb(now() + make_interval(secs => least(60, (x->>'held')::numeric)::double precision))), '{}'::jsonb) into held
    from jsonb_array_elements(coalesce(p_ships, '[]'::jsonb)) x where coalesce((x->>'held')::numeric, 0) > 0;
  select coalesce(array_agg(x->>'id'), '{}') into held_off
    from jsonb_array_elements(coalesce(p_ships, '[]'::jsonb)) x where x ? 'held' and coalesce((x->>'held')::numeric, 0) <= 0;
  update rt_battles b
     set heartbeat_at = now(),
         snapshot = jsonb_build_object('fire', coalesce((
           select jsonb_object_agg(k, v) from jsonb_each(coalesce(b.snapshot->'fire', '{}'::jsonb)) e(k, v)
            where (v #>> '{}')::timestamptz > now() - interval '60 seconds' and not (fire ? k)), '{}'::jsonb) || fire,
                                       'held', coalesce((
           select jsonb_object_agg(k, v) from jsonb_each(coalesce(b.snapshot->'held', '{}'::jsonb)) e(k, v)
            where (v #>> '{}')::timestamptz > now() and not (held ? k) and not (k = any(held_off))), '{}'::jsonb) || held),
         snapshot_at = now()$x$;
    if (length(v_def) - length(replace(v_def, a, ''))) / length(a) <> 1 then raise exception 'rt_space_sync: снимок не один'; end if;
    execute replace(v_def, a, b);
  end if;

  -- 2) rt_battle_guard: в луче — в гиперпространство не уйти
  v_def := pg_get_functiondef('public.rt_battle_guard()'::regprocedure);
  if position('притягивающем луче' in v_def) = 0 then
    a := $x$        raise exception 'Корабль под огнём — в гиперпространство не уйти' using errcode = 'P0001', hint = 'rt_busy';
      end if;
$x$;
    b := a || $x$      select (b.snapshot->'held'->>old.id::text)::timestamptz into fire_at from rt_battles b where b.id = bid;
      if fire_at is not null and fire_at > now() then
        raise exception 'Корабль в притягивающем луче — в гиперпространство не уйти' using errcode = 'P0001', hint = 'rt_busy';
      end if;
$x$;
    if (length(v_def) - length(replace(v_def, a, ''))) / length(a) <> 1 then raise exception 'rt_battle_guard: якорь не один'; end if;
    execute replace(v_def, a, b);
  end if;
end $$;

-- 3) описание исследования — что луч делает в бою 2.0 и где кнопка
update researches
   set description = 'Луч держит вражеский корабль 20 с: ход скован, его тянет к вам, в гиперпространство не уйти, абордаж — даже при поднятых щитах. На орбите — кнопка «⊙ Луч» в строке цели, перезарядка 60 с.'
 where id = 'tractor';

-- 4) снабжение: флот, корабль которого держит луч, ждёт (как под огнём), а не встаёт с ошибкой;
-- 5) текст отказа называет корабль (во флоте из многих — какой именно держат)
do $$
declare v_def text; a text; b text;
begin
  v_def := pg_get_functiondef('public.supply_route_step'::regproc);
  if position('притягивающем луче' in v_def) = 0 then
    a := $x$        if v_err like 'Корабль под огнём%' or v_err like '%в бою 2.0%' then
$x$;
    b := $x$        if v_err like '%притягивающем луче%' then
          update supply_routes set last_note = 'Корабль флота в притягивающем луче врага — прыжок, когда отпустят', updated_at = now()
           where id = r.id and last_note is distinct from 'Корабль флота в притягивающем луче врага — прыжок, когда отпустят';
          exit;
        end if;
$x$ || a;
    if (length(v_def) - length(replace(v_def, a, ''))) / length(a) <> 1 then raise exception 'supply_route_step: якорь не один'; end if;
    execute replace(v_def, a, b);
  end if;
  v_def := pg_get_functiondef('public.rt_battle_guard()'::regprocedure);
  a := $x$        raise exception 'Корабль в притягивающем луче — в гиперпространство не уйти' using errcode = 'P0001', hint = 'rt_busy';$x$;
  if position(a in v_def) > 0 then
    b := $x$        raise exception 'Корабль «%» в притягивающем луче — в гиперпространство не уйти',
          coalesce(old.name, (select t.name from ship_types t where t.id = old.ship_type), '') using errcode = 'P0001', hint = 'rt_busy';$x$;
    if (length(v_def) - length(replace(v_def, a, ''))) / length(a) <> 1 then raise exception 'rt_battle_guard: текст не один'; end if;
    execute replace(v_def, a, b);
  end if;
end $$;
