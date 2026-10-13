-- ============================================================
-- Игра 2.0: служебные таблицы игрового сервера и блокировка
-- «объект в бою 2.0 / в пошаговой игре».
--
-- Старые функции не меняются. Блокировка сделана триггерами:
--   * в бою 2.0 юнит или корабль занят для старой игры:
--       - действие игрока (есть auth.uid()) → ошибка «… в бою 2.0»,
--         всё действие откатывается целиком, ничего не списано;
--       - тики cron (auth.uid() нет) → строка тихо пропускается,
--         тик идёт дальше для всех остальных.
--   * обратное — объект, занятый в старой игре, сервер 2.0 в бой
--     не возьмёт (rt_battle_open проверяет rt_obj_busy_old).
--   * сервер 2.0 пишет итоги с флагом app.rt_battle = '1'.
--   * если сервер пропал (нет сердцебиения 90 с), блокировка сама
--     перестаёт действовать — объекты не зависнут навсегда.
-- ============================================================

-- ---------- Таблицы ----------

create table if not exists public.rt_servers (
  id         text primary key default 'main',
  key_hash   text not null,
  url        text,
  version    text,
  started_at timestamptz,
  seen_at    timestamptz,
  info       jsonb
);

create table if not exists public.rt_battles (
  id           uuid primary key default gen_random_uuid(),
  kind         text not null check (kind in ('boarding','ground','space','proto')),
  system_id    text,
  status       text not null default 'active' check (status in ('active','finished','aborted')),
  server_id    text not null default 'main',
  created_at   timestamptz not null default now(),
  heartbeat_at timestamptz not null default now(),
  ended_at     timestamptz,
  snapshot     jsonb not null default '{}'::jsonb,
  snapshot_at  timestamptz,
  result       jsonb,
  meta         jsonb not null default '{}'::jsonb
);
create index if not exists rt_battles_active_idx on public.rt_battles (status) where status = 'active';

create table if not exists public.rt_battle_locks (
  obj_kind  text not null check (obj_kind in ('unit','ship')),
  obj_id    uuid not null,
  battle_id uuid not null references public.rt_battles(id) on delete cascade,
  locked_at timestamptz not null default now(),
  primary key (obj_kind, obj_id)
);
create index if not exists rt_battle_locks_battle_idx on public.rt_battle_locks (battle_id);

create table if not exists public.rt_server_log (
  id     bigserial primary key,
  at     timestamptz not null default now(),
  server text not null default 'main',
  level  text not null default 'info',
  msg    text not null,
  data   jsonb
);
create index if not exists rt_server_log_at_idx on public.rt_server_log (at desc);

-- Замеры прототипа с устройств игроков (плавность на телефоне)
create table if not exists public.rt_bench (
  id       bigserial primary key,
  at       timestamptz not null default now(),
  user_id  uuid,
  scenario text not null,
  device   jsonb,
  results  jsonb not null
);

alter table public.rt_servers      enable row level security;
alter table public.rt_battles      enable row level security;
alter table public.rt_battle_locks enable row level security;
alter table public.rt_server_log   enable row level security;
alter table public.rt_bench        enable row level security;
-- Политик нет намеренно: всё только через функции ниже.

-- ---------- Проверка ключа сервера ----------

create or replace function public.rt_key_ok(p_key text, p_server text default 'main')
returns boolean
language sql stable security definer
set search_path to 'public', 'pg_temp'
as $$
  select coalesce(p_key, '') <> '' and exists (
    select 1 from rt_servers s
    where s.id = coalesce(p_server, 'main')
      and s.key_hash = encode(sha256(convert_to(p_key, 'UTF8')), 'hex'));
$$;

create or replace function public.rt_need_key(p_key text)
returns void
language plpgsql stable security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  if not rt_key_ok(p_key) then
    raise exception 'rt: неверный ключ сервера' using errcode = '28000';
  end if;
end;
$$;

-- ---------- Занятость объектов ----------

-- Объект занят боем 2.0: есть блокировка, бой активен и сервер жив
create or replace function public.rt_obj_busy_2_0(p_kind text, p_id uuid)
returns uuid
language sql stable security definer
set search_path to 'public', 'pg_temp'
as $$
  select l.battle_id
  from rt_battle_locks l join rt_battles b on b.id = l.battle_id
  where l.obj_kind = p_kind and l.obj_id = p_id
    and b.status = 'active' and b.heartbeat_at > now() - interval '90 seconds'
  limit 1;
$$;

-- Объект занят в старой игре. Возвращает причину или null
create or replace function public.rt_obj_busy_old(p_kind text, p_id uuid)
returns text
language plpgsql stable security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  u unit_positions%rowtype;
  s ships%rowtype;
begin
  if p_kind = 'unit' then
    select * into u from unit_positions where id = p_id;
    if not found then return 'нет такого юнита'; end if;
    if u.transit_to is not null then return 'в пути'; end if;
    if u.training_until is not null and u.training_until > now() then return 'на обучении'; end if;
    if u.carrier_ship_id is not null and ship_active_boarding(u.carrier_ship_id) is not null then return 'в абордаже'; end if;
    if exists (select 1 from boarding_units bu join boardings b on b.id = bu.boarding_id
               where bu.unit_id = p_id and b.status = 'active') then return 'в абордаже'; end if;
    if u.ow_shot_at is not null and u.ow_shot_at > now() - interval '90 seconds' then return 'в бою'; end if;
  elsif p_kind = 'ship' then
    select * into s from ships where id = p_id;
    if not found then return 'нет такого корабля'; end if;
    if coalesce(s.in_transit, false) then return 'в пути'; end if;
    if ship_active_boarding(p_id) is not null then return 'в абордаже'; end if;
    if s.ow_shot_at is not null and s.ow_shot_at > now() - interval '90 seconds' then return 'в бою'; end if;
  else
    return 'неизвестный вид объекта';
  end if;

  if exists (select 1 from auto_moves m
             where m.status = 'active'
               and ((p_kind = 'unit' and m.unit_id = p_id) or (p_kind = 'ship' and m.ship_id = p_id))) then
    return 'идёт автопереход';
  end if;
  if exists (select 1 from repair_orders r
             where not coalesce(r.delivered, false)
               and ((p_kind = 'unit' and r.unit_id = p_id) or (p_kind = 'ship' and r.ship_id = p_id))) then
    return 'в ремонте или лазарете';
  end if;
  if exists (select 1 from troop_transfer_items i join troop_transfers t on t.id = i.transfer_id
             where t.status = 'pending' and i.kind = p_kind and i.item_id = p_id) then
    return 'идёт передача другому игроку';
  end if;
  -- Пошаговый бой: попадания, промахи, урон и дуэли за последние 90 с
  if exists (select 1 from game_events e
             where e.created_at > now() - interval '90 seconds'
               and e.type in ('unit_hit','unit_missed','unit_damaged','unit_killed',
                              'ship_hit','ship_missed','ship_lost','duel')
               and e.meta ->> (p_kind || '_id') = p_id::text) then
    return 'в бою';
  end if;
  return null;
end;
$$;

-- ---------- Триггеры старой игры ----------

-- unit_positions и ships: изменение или удаление занятой строки
create or replace function public.rt_battle_guard()
returns trigger
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  k text := case when tg_table_name = 'ships' then 'ship' else 'unit' end;
begin
  if coalesce(current_setting('app.rt_battle', true), '') = '1' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  -- Быстрый выход: блокировок нет — ничего не проверяем
  if not exists (select 1 from rt_battle_locks l where l.obj_kind = k and l.obj_id = old.id) then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if rt_obj_busy_2_0(k, old.id) is null then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if auth.uid() is not null then
    raise exception '%', case when k = 'ship' then 'Корабль сейчас в бою 2.0' else 'Отряд сейчас в бою 2.0' end
      using errcode = 'P0001', hint = 'rt_busy';
  end if;
  return null;   -- тик cron: пропускаем эту строку, остальные идут дальше
end;
$$;

-- Новые записи старой игры, которые ссылаются на занятый объект
create or replace function public.rt_battle_guard_ref()
returns trigger
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  j jsonb := to_jsonb(new);
  busy boolean := false;
begin
  if coalesce(current_setting('app.rt_battle', true), '') = '1' then return new; end if;
  if not exists (select 1 from rt_battle_locks) then return new; end if;

  if tg_table_name = 'troop_transfer_items' then
    busy := (j->>'kind') in ('unit','ship') and (j->>'item_id') is not null
            and rt_obj_busy_2_0(j->>'kind', (j->>'item_id')::uuid) is not null;
  elsif tg_table_name = 'boardings' then
    busy := ((j->>'attacker_ship_id') is not null and rt_obj_busy_2_0('ship', (j->>'attacker_ship_id')::uuid) is not null)
         or ((j->>'target_ship_id')   is not null and rt_obj_busy_2_0('ship', (j->>'target_ship_id')::uuid)   is not null);
  else
    busy := ((j->>'unit_id') is not null and rt_obj_busy_2_0('unit', (j->>'unit_id')::uuid) is not null)
         or ((j->>'ship_id') is not null and rt_obj_busy_2_0('ship', (j->>'ship_id')::uuid) is not null);
  end if;

  if not busy then return new; end if;
  if auth.uid() is not null then
    raise exception 'Отряд или корабль сейчас в бою 2.0' using errcode = 'P0001', hint = 'rt_busy';
  end if;
  return null;
end;
$$;

-- ---------- Функции игрового сервера ----------

-- Сервер стартовал: адрес, версия; в ответ — активные бои для продолжения
create or replace function public.rt_server_hello(p_key text, p_url text, p_version text, p_info jsonb default null)
returns jsonb
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  perform rt_need_key(p_key);
  update rt_servers set url = p_url, version = p_version, info = p_info,
         started_at = now(), seen_at = now()
   where id = 'main';
  delete from rt_server_log where at < now() - interval '14 days';
  delete from rt_bench where at < now() - interval '90 days';
  return coalesce((select jsonb_agg(jsonb_build_object('id', b.id, 'kind', b.kind, 'system_id', b.system_id,
                                                       'snapshot', b.snapshot, 'meta', b.meta))
                   from rt_battles b where b.status = 'active'), '[]'::jsonb);
end;
$$;

-- Пачка строк журнала: [{level, msg, data, at}]
create or replace function public.rt_log(p_key text, p_rows jsonb)
returns integer
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $$
declare n integer;
begin
  perform rt_need_key(p_key);
  update rt_servers set seen_at = now() where id = 'main';
  insert into rt_server_log (at, level, msg, data)
  select coalesce((r->>'at')::timestamptz, now()),
         left(coalesce(r->>'level', 'info'), 16),
         left(coalesce(r->>'msg', ''), 500),
         r->'data'
  from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r
  limit 500;
  get diagnostics n = row_count;
  return n;
end;
$$;

-- Открыть бой и занять объекты: [{kind:'unit'|'ship', id}]
-- Набор сам дополняется всем, что связано перевозкой: груз корабля, истребители
-- в ангаре, пехота в технике и наоборот — носитель груза. Иначе каскадное
-- удаление носителя в старой игре задело бы занятый груз.
-- Всё или ничего: если хоть один объект занят — ошибка со списком.
create or replace function public.rt_battle_open(p_key text, p_kind text, p_system text,
                                                 p_objs jsonb default '[]'::jsonb, p_meta jsonb default '{}'::jsonb)
returns jsonb
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  bid uuid;
  us uuid[];
  ss uuid[];
  n0 integer;
  x uuid;
  why text;
  busy text[] := '{}';
begin
  perform rt_need_key(p_key);
  if p_kind not in ('boarding','ground','space','proto') then raise exception 'rt: неверный вид боя'; end if;

  us := array(select distinct (o->>'id')::uuid from jsonb_array_elements(coalesce(p_objs, '[]'::jsonb)) o where o->>'kind' = 'unit');
  ss := array(select distinct (o->>'id')::uuid from jsonb_array_elements(coalesce(p_objs, '[]'::jsonb)) o where o->>'kind' = 'ship');
  if (select count(*) from jsonb_array_elements(coalesce(p_objs, '[]'::jsonb)) o
      where coalesce(o->>'kind', '') not in ('unit','ship')) > 0 then
    raise exception 'rt: неизвестный вид объекта';
  end if;

  loop
    n0 := cardinality(us) + cardinality(ss);
    us := array(select distinct v from unnest(us
            || array(select u.id from unit_positions u where u.carrier_ship_id = any(ss) or u.carrier_unit_id = any(us))
            || array(select u.carrier_unit_id from unit_positions u where u.id = any(us) and u.carrier_unit_id is not null)) v);
    ss := array(select distinct v from unnest(ss
            || array(select s.id from ships s where s.carrier_ship_id = any(ss))
            || array(select s.carrier_ship_id from ships s where s.id = any(ss) and s.carrier_ship_id is not null)
            || array(select u.carrier_ship_id from unit_positions u where u.id = any(us) and u.carrier_ship_id is not null)) v);
    exit when cardinality(us) + cardinality(ss) = n0;
  end loop;

  -- Блокировка строк: старая игра не вклинится между проверкой и захватом
  perform 1 from unit_positions where id = any(us) order by id for update;
  perform 1 from ships          where id = any(ss) order by id for update;

  foreach x in array us loop
    if rt_obj_busy_2_0('unit', x) is not null then busy := busy || (x::text || ': уже в бою 2.0'); continue; end if;
    why := rt_obj_busy_old('unit', x);
    if why is not null then busy := busy || (x::text || ': ' || why); end if;
  end loop;
  foreach x in array ss loop
    if rt_obj_busy_2_0('ship', x) is not null then busy := busy || (x::text || ': уже в бою 2.0'); continue; end if;
    why := rt_obj_busy_old('ship', x);
    if why is not null then busy := busy || (x::text || ': ' || why); end if;
  end loop;
  if cardinality(busy) > 0 then
    raise exception 'rt: заняты объекты: %', array_to_string(busy, '; ') using hint = 'rt_busy';
  end if;

  insert into rt_battles (kind, system_id, meta) values (p_kind, p_system, coalesce(p_meta, '{}'::jsonb))
  returning id into bid;

  -- Блокировки умершего боя (сервер пропал) больше не действуют — заменяем
  delete from rt_battle_locks where (obj_kind = 'unit' and obj_id = any(us)) or (obj_kind = 'ship' and obj_id = any(ss));
  insert into rt_battle_locks (obj_kind, obj_id, battle_id)
  select 'unit', v, bid from unnest(us) v
  union all
  select 'ship', v, bid from unnest(ss) v;

  return jsonb_build_object('battle_id', bid, 'units', to_jsonb(us), 'ships', to_jsonb(ss));
end;
$$;

-- Сердцебиение и снимок по изменившимся чанкам: {"c:3:5": {...}, ...}
-- Ключ со значением null удаляет чанк из снимка
create or replace function public.rt_battle_beat(p_key text, p_battle uuid, p_chunks jsonb default null)
returns boolean
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  perform rt_need_key(p_key);
  update rt_servers set seen_at = now() where id = 'main';
  if p_chunks is null or p_chunks = '{}'::jsonb then
    update rt_battles set heartbeat_at = now() where id = p_battle and status = 'active';
  else
    update rt_battles
       set heartbeat_at = now(), snapshot_at = now(),
           snapshot = (snapshot || p_chunks)
                      - array(select k from jsonb_each(p_chunks) e(k, v) where v = 'null'::jsonb)
     where id = p_battle and status = 'active';
  end if;
  return found;
end;
$$;

-- Закрыть бой: итог, снять блокировки
create or replace function public.rt_battle_close(p_key text, p_battle uuid, p_result jsonb default null,
                                                  p_status text default 'finished')
returns boolean
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $$
declare ok boolean;
begin
  perform rt_need_key(p_key);
  if p_status not in ('finished', 'aborted') then raise exception 'rt: неверный статус'; end if;
  update rt_battles set status = p_status, ended_at = now(), result = p_result
   where id = p_battle and status = 'active';
  ok := found;
  delete from rt_battle_locks where battle_id = p_battle;
  return ok;
end;
$$;

-- Для сайта 2.0: адрес сервера и жив ли он
create or replace function public.rt_server_status()
returns jsonb
language sql stable security definer
set search_path to 'public', 'pg_temp'
as $$
  select coalesce((select jsonb_build_object('url', url, 'version', version, 'seen_at', seen_at,
                                             'online', seen_at > now() - interval '60 seconds')
                   from rt_servers where id = 'main'), jsonb_build_object('online', false));
$$;

-- Замер прототипа с устройства игрока
create or replace function public.rt_bench_submit(p_scenario text, p_device jsonb, p_results jsonb)
returns bigint
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $$
declare rid bigint;
begin
  if auth.uid() is null then raise exception 'Нет входа в игру'; end if;
  if (select count(*) from rt_bench where user_id = auth.uid() and at > now() - interval '1 hour') >= 30 then
    raise exception 'Слишком много замеров, попробуй позже';
  end if;
  if length(coalesce(p_device::text, '')) > 4000 or length(coalesce(p_results::text, '')) > 20000 then
    raise exception 'Слишком большой замер';
  end if;
  insert into rt_bench (user_id, scenario, device, results)
  values (auth.uid(), left(coalesce(p_scenario, ''), 40), p_device, p_results)
  returning id into rid;
  return rid;
end;
$$;

-- ---------- Права ----------

revoke all on function public.rt_key_ok(text, text)            from public, anon, authenticated;
revoke all on function public.rt_need_key(text)                from public, anon, authenticated;
revoke all on function public.rt_obj_busy_2_0(text, uuid)      from public, anon, authenticated;
revoke all on function public.rt_obj_busy_old(text, uuid)      from public, anon, authenticated;
revoke all on function public.rt_battle_guard()                from public, anon, authenticated;
revoke all on function public.rt_battle_guard_ref()            from public, anon, authenticated;

revoke all on function public.rt_server_hello(text, text, text, jsonb)          from public, authenticated;
revoke all on function public.rt_log(text, jsonb)                               from public, authenticated;
revoke all on function public.rt_battle_open(text, text, text, jsonb, jsonb)    from public, authenticated;
revoke all on function public.rt_battle_beat(text, uuid, jsonb)                 from public, authenticated;
revoke all on function public.rt_battle_close(text, uuid, jsonb, text)          from public, authenticated;
grant execute on function public.rt_server_hello(text, text, text, jsonb)       to anon;
grant execute on function public.rt_log(text, jsonb)                            to anon;
grant execute on function public.rt_battle_open(text, text, text, jsonb, jsonb) to anon;
grant execute on function public.rt_battle_beat(text, uuid, jsonb)              to anon;
grant execute on function public.rt_battle_close(text, uuid, jsonb, text)       to anon;

revoke all on function public.rt_server_status()                from public, anon;
revoke all on function public.rt_bench_submit(text, jsonb, jsonb) from public, anon;
grant execute on function public.rt_server_status()             to authenticated;
grant execute on function public.rt_bench_submit(text, jsonb, jsonb) to authenticated;
