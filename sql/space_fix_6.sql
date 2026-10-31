-- Космос, этап 6: движение (аудит space-audit, SPACE-BUG-056).
--  056 — свободные истребители на орбите: сверка пишет их клетку (x, y), а не только целость; при новом открытии орбиты
--        машина стоит там, где её оставил бой, а не на клетке, с которой взлетела.
-- Правка — заменой мест в живой rt_space_sync: место не найдено — ошибка, ничего не меняется.
do $patch$
declare d text; a text; b text;
begin
  d := pg_get_functiondef('public.rt_space_sync(text,uuid,jsonb,jsonb,jsonb,jsonb,jsonb)'::regprocedure);
  if position('rows.cx' in d) > 0 then raise notice 'rt_space_sync: уже исправлена'; return; end if;
  a := $q$    select (x->>'id')::uuid as id, greatest(1, (x->>'hp')::integer) as hp, (x->>'seen')::integer as seen
    from jsonb_array_elements(coalesce(p_craft, '[]'::jsonb)) x$q$;
  b := $q$    select (x->>'id')::uuid as id, greatest(1, (x->>'hp')::integer) as hp, (x->>'seen')::integer as seen,
           (x->>'x')::integer as cx, (x->>'y')::integer as cy
    from jsonb_array_elements(coalesce(p_craft, '[]'::jsonb)) x$q$;
  if (length(d) - length(replace(d, a, ''))) / length(a) <> 1 then raise exception 'rt_space_sync: место 1'; end if;
  d := replace(d, a, b);
  a := $q$    select rows.id, rows.hp, t.max_hp + coalesce(f.bonus_hp, 0) as mhp,$q$;
  b := $q$    select rows.id, rows.hp, rows.cx, rows.cy, t.max_hp + coalesce(f.bonus_hp, 0) as mhp,$q$;
  if (length(d) - length(replace(d, a, ''))) / length(a) <> 1 then raise exception 'rt_space_sync: место 2'; end if;
  d := replace(d, a, b);
  a := $q$  upd as (update ships f set hp = least(calc.mhp, calc.hp + calc.rep_d) from calc where f.id = calc.id returning f.id, f.hp, calc.rep_d),$q$;
  b := $q$  -- свободная машина (не в ангаре): и клетка, где её оставил бой
  upd as (update ships f set hp = least(calc.mhp, calc.hp + calc.rep_d),
                             x = case when f.carrier_ship_id is null and calc.cx is not null then calc.cx else f.x end,
                             y = case when f.carrier_ship_id is null and calc.cy is not null then calc.cy else f.y end
            from calc where f.id = calc.id returning f.id, f.hp, calc.rep_d),$q$;
  if (length(d) - length(replace(d, a, ''))) / length(a) <> 1 then raise exception 'rt_space_sync: место 3'; end if;
  d := replace(d, a, b);
  execute d;
end $patch$;
