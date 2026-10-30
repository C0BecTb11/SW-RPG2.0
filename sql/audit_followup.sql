-- Решения Артёма по итогам аудита (30.10.2026), sql/security_audit.sql — продолжение.
--
-- 1) Цели диверсий (spy_targets): ник управляющего врагу не раскрываем — только «есть ли управляющий»
--    (held). Тело функции — в sql/loyalty.sql, здесь та же правка для базы.
-- 2) Станции под туманом войны: чужую станцию видно, только если наш корабль подошёл к месту станции
--    на дальность обзора (как корабли в can_see_ship_box, но по всей стороне — как на орбите 2.0, где
--    туман общий на сторону). Свою станцию и любую станцию на своей планете (трофей) видно всегда.
--    Орбита 2.0 решает то же на сервере (server/system-room.js: slotKnown, slotSight).
-- 3) Заявки на планету: отозвал — ту же планету снова не раньше чем через 10 минут, всего не больше
--    6 заявок в час (иначе «запросить → отменить» по кругу засыпал лидера уведомлениями).
-- 4) Ивенты: вышел из сбора (или сбор сорвался без подтверждения) — снова записаться через 60 с,
--    иначе выход-вход срывал подбор всем на этом уровне.

do $do$
declare p record; f record; v text; v_hits integer; v_seen integer;
begin
  for p in select * from (values
    ('spy_targets', $o$             'owner', (select nickname from profiles where id = sc.controller_user_id),
$o$, $n$             'held', sc.controller_user_id is not null,       -- ник управляющего врагу не раскрываем
$n$),
    ('request_planet', $o$  if (select count(*) from planet_requests where user_id = v_me and status = 'pending') >= 3 then$o$,
                       $n$  -- запросить → отозвать по кругу: пауза на ту же планету и общий предел в час
  perform pg_advisory_xact_lock(hashtext('planet_request:' || v_me::text));
  if exists (select 1 from planet_requests where user_id = v_me and system_id = p_system_id
              and status = 'cancelled' and resolved_at > now() - interval '10 minutes') then
    raise exception 'Эту планету ты только что отозвал — попросить снова можно через несколько минут';
  end if;
  if (select count(*) from planet_requests where user_id = v_me and created_at > now() - interval '1 hour') >= 6 then
    raise exception 'Слишком много запросов за час — подожди немного';
  end if;

  if (select count(*) from planet_requests where user_id = v_me and status = 'pending') >= 3 then$n$),
    ('event_join', $o$  update event_queue set state = 'left', left_at = now() where user_id = v_me and state = 'waiting';$o$,
                   $n$  -- вышел из сбора или не подтвердил его — короткая пауза, иначе выход-вход срывает подбор всем
  if exists (select 1 from event_queue where user_id = v_me and state = 'left' and call_id is not null
              and left_at > now() - interval '60 seconds') then
    raise exception 'Сбор сорвался — записаться снова можно через % с',
      greatest(1, ceil(extract(epoch from (select max(left_at) from event_queue where user_id = v_me and state = 'left'
                                            and call_id is not null) + interval '60 seconds' - now()))::integer);
  end if;
  update event_queue set state = 'left', left_at = now() where user_id = v_me and state = 'waiting';$n$)
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

-- Видна ли игроку станция в системе (туман войны)
create or replace function public.can_see_station(p_system text, p_faction text)
returns boolean language plpgsql stable security definer set search_path to 'public', 'pg_temp' as $$
declare v_me text; sl record;
begin
  select faction into v_me from profiles where id = auth.uid();
  if v_me is null then return false; end if;
  if p_faction = v_me then return true; end if;
  if exists (select 1 from systems where id = p_system and faction = v_me) then return true; end if;
  select x, y, size into sl from station_slots where system_id = p_system limit 1;
  if not found then return false; end if;
  return exists (
    select 1
    from ships s
    join ship_types st on st.id = s.ship_type
    cross join lateral (
      select ship_box_w(st.width_cells, st.height_cells, s.facing) as w,
             ship_box_h(st.width_cells, st.height_cells, s.facing) as h) b
    where s.system_id = p_system
      and s.faction = v_me
      and s.hp > 0
      and not s.in_transit
      and s.carrier_ship_id is null
      and s.x is not null
      and greatest(
            greatest(sl.x - (s.x + b.w - 1), s.x - (sl.x + sl.size - 1), 0),
            greatest(sl.y - (s.y + b.h - 1), s.y - (sl.y + sl.size - 1), 0))
          <= st.vision_range + coalesce(s.bonus_vision, 0));
end $$;
revoke execute on function public.can_see_station(text, text) from public, anon;
grant execute on function public.can_see_station(text, text) to authenticated;

do $do$
begin
  if exists (select 1 from pg_policy where polrelid = 'public.space_stations'::regclass and polname = 'Anyone can view space stations') then
    execute 'dr' || 'op policy "Anyone can view space stations" on public.space_stations';
  end if;
  if not exists (select 1 from pg_policy where polrelid = 'public.space_stations'::regclass and polname = 'Stations under fog of war') then
    execute 'create policy "Stations under fog of war" on public.space_stations for select to authenticated using (can_see_station(system_id, faction))';
  end if;
end $do$;
