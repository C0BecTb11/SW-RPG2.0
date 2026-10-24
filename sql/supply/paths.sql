-- Снимок (pg_get_functiondef): прокладка пути через миры своей стороны. 24.10.2026
-- convoy_route, convoy_route_to — по ним ходят рейсы снабжения, вывоз покупок и дальние перелёты командиров.
-- Имена остались от конвоев; сами конвои удалены в шаге 5 (sql/supply_drop_convoys.sql).

CREATE OR REPLACE FUNCTION public.convoy_route(p_from text, p_to text, p_faction text)
 RETURNS text[]
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
declare
  frontier text[] := array[p_from];
  visited  text[] := array[p_from];
  parent   jsonb  := jsonb_build_object(p_from, null);
  nxt text[]; n text; cur text; path text[]; d integer := 0;
begin
  if p_from = p_to then return array[p_from]; end if;

  while coalesce(array_length(frontier, 1), 0) > 0 and d < 20 loop
    d := d + 1;
    nxt := '{}';

    for cur in select unnest(frontier) loop
      for n in
        select case when h.system_a = cur then h.system_b else h.system_a end
        from hyperlanes h
        join systems s on s.id = case when h.system_a = cur then h.system_b else h.system_a end
        where (h.system_a = cur or h.system_b = cur)
          and not s.is_deep_space
          and s.faction = p_faction
      loop
        continue when n = any(visited);
        visited := visited || n;
        nxt := nxt || n;
        parent := parent || jsonb_build_object(n, cur);

        if n = p_to then
          path := array[n];
          cur := parent ->> n;
          while cur is not null loop
            path := array[cur] || path;
            cur := parent ->> cur;
          end loop;
          return path;
        end if;
      end loop;
    end loop;

    frontier := nxt;
  end loop;

  return null;
end;
$function$

-- ----------------------------------------
CREATE OR REPLACE FUNCTION public.convoy_route_to(p_from text, p_to text, p_faction text)
 RETURNS text[]
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
declare
  frontier text[] := array[p_from];
  visited  text[] := array[p_from];
  parent   jsonb  := jsonb_build_object(p_from, null);
  nxt text[]; n text; cur text; path text[]; d integer := 0;
begin
  if p_from = p_to then return array[p_from]; end if;

  while coalesce(array_length(frontier, 1), 0) > 0 and d < 20 loop
    d := d + 1;
    nxt := '{}';

    for cur in select unnest(frontier) loop
      for n in
        select case when h.system_a = cur then h.system_b else h.system_a end
        from hyperlanes h
        join systems s on s.id = case when h.system_a = cur then h.system_b else h.system_a end
        where (h.system_a = cur or h.system_b = cur)
          and not s.is_deep_space
          and (s.faction = p_faction
               or s.id = p_to)          -- в цель можно, даже если она чужая
      loop
        continue when n = any(visited);
        visited := visited || n;
        parent := parent || jsonb_build_object(n, cur);

        if n = p_to then
          path := array[n];
          cur := parent ->> n;
          while cur is not null loop
            path := array[cur] || path;
            cur := parent ->> cur;
          end loop;
          return path;
        end if;

        -- дальше через чужую цель не идём: она только конечная
        nxt := nxt || n;
      end loop;
    end loop;

    frontier := nxt;
  end loop;

  return null;
end;
$function$
