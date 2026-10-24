-- Живая орбита (бой 2.0): корабль остаётся там и так, как его оставили.
-- В базе корабль лежит клеткой (200 м) и разворотом с шагом 90° — по ним считает вся игра (зона прыжка,
-- занятость клеток, старая карта). Сервер боя теперь пишет и точную позу: метры и курс (ships.rt_x, rt_y, rt_hd),
-- а при открытии орбиты берёт её, если она сходится с клеткой и разворотом в базе. Если корабль за это время
-- двигала сама игра (автоход, прыжок, верфь) — поза не сходится, и корабль встаёт по клетке, как раньше.

alter table public.ships add column if not exists rt_x double precision;
alter table public.ships add column if not exists rt_y double precision;
alter table public.ships add column if not exists rt_hd double precision;

do $$
declare v_def text; v_a text; v_b text;
begin
  -- 1) снимок орбиты пишет позу
  v_def := pg_get_functiondef('public.rt_space_sync(text,uuid,jsonb,jsonb,jsonb,jsonb)'::regprocedure);
  if position('rt_hd' in v_def) = 0 then
    v_a := E'           greatest(0, (x->''sh''->>2)::integer) as sa, greatest(0, (x->''sh''->>3)::integer) as sp\n';
    v_b := E'           greatest(0, (x->''sh''->>2)::integer) as sa, greatest(0, (x->''sh''->>3)::integer) as sp,\n'
        || E'           (x->>''mx'')::double precision as mx, (x->>''my'')::double precision as my, (x->>''hd'')::double precision as hd\n';
    if position(v_a in v_def) = 0 then raise exception 'rt_space_sync: нет якоря строк'; end if;
    v_def := replace(v_def, v_a, v_b);
    v_a := E'shield_port = rows.sp, shields_updated_at = now()\n';
    v_b := E'shield_port = rows.sp, shields_updated_at = now(),\n'
        || E'         rt_x = rows.mx, rt_y = rows.my, rt_hd = rows.hd\n';
    if position(v_a in v_def) = 0 then raise exception 'rt_space_sync: нет якоря записи'; end if;
    v_def := replace(v_def, v_a, v_b);
    execute v_def;
  end if;

  -- 2) открытие орбиты отдаёт позу серверу боя
  v_def := pg_get_functiondef('public.rt_space_ships(text)'::regprocedure);
  if position('rt_pose' in v_def) = 0 then
    v_a := E'    ''troop_posts'', s.troop_posts,\n';
    v_b := E'    ''troop_posts'', s.troop_posts,\n'
        || E'    ''rt_pose'', case when s.rt_x is not null and s.rt_y is not null and s.rt_hd is not null then jsonb_build_array(s.rt_x, s.rt_y, s.rt_hd) end,\n';
    if position(v_a in v_def) = 0 then raise exception 'rt_space_ships: нет якоря'; end if;
    v_def := replace(v_def, v_a, v_b);
    execute v_def;
  end if;
end $$;
