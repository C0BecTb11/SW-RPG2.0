-- Ивенты по расписанию (решение 23.10.2026, план — claude/mechanics-plan.md, этап 1).
--
-- * Окно — 18:00–23:00 по времени сервера (game_settings.server_tz). Один ивент в день.
-- * Ивент дня и его уровень выпадают случайно (event_days, запись создаётся при первом запросе дня);
--   тот же ивент два дня подряд не выпадает. Уровень выбрать нельзя.
-- * Запись → «Сбор» (все записанные подтверждают «Готов» за 2 минуты) → бой.
--   Если на другую сторону никто не записался 3 минуты — можно позвать ботов (награда ×0,5).
-- * Награда за победу — одна в день; утешительная за поражение — только пока за день ничего не получено.
-- Тест администрации (dev_event_start) работает как раньше: вне окна и без наград.

-- ---------------------------------------------------------------- настройки
insert into public.game_settings (key, value) values
  ('event_open_hour', '18'), ('event_close_hour', '23'), ('event_tier_weights', '40,40,20'),
  ('event_call_seconds', '120'), ('event_bots_after_seconds', '180'), ('event_bots_reward_pct', '50')
on conflict (key) do nothing;

-- ---------------------------------------------------------------- таблицы
create table if not exists public.event_days (
  day date primary key,
  event_id text not null references public.event_catalog(id),
  tier integer not null check (tier between 1 and 3),
  created_at timestamptz not null default now()
);
alter table public.event_days enable row level security;
revoke all on public.event_days from anon, authenticated;

alter table public.event_queue add column if not exists day date;
alter table public.event_queue add column if not exists call_id uuid;
alter table public.event_queue add column if not exists call_mode text;
alter table public.event_queue add column if not exists called_at timestamptz;
alter table public.event_queue add column if not exists ready_at timestamptz;
create index if not exists event_queue_call on public.event_queue (call_id) where call_id is not null;

alter table public.event_matches add column if not exists day date;
alter table public.event_matches add column if not exists reward_k numeric not null default 1;
alter table public.event_matches add column if not exists bots boolean not null default false;

alter table public.event_awards add column if not exists paid boolean not null default false;
update public.event_awards set paid = true where not paid and (credits > 0 or resources <> '{}'::jsonb);

-- ---------------------------------------------------------------- время и день
create or replace function public.event_tz()
 returns text language sql stable security definer set search_path to 'public', 'pg_temp'
as $function$
  select coalesce((select value from game_settings where key = 'server_tz'), 'Europe/Moscow');
$function$;

create or replace function public.event_setting_int(p_key text, p_def integer)
 returns integer language sql stable security definer set search_path to 'public', 'pg_temp'
as $function$
  select coalesce((select case when value ~ '^\d{1,6}$' then value::integer end from game_settings where key = p_key), p_def);
$function$;

-- Ивент дня: создаётся при первом запросе дня. Случайный ивент (не вчерашний) и уровень по весам.
create or replace function public.event_day_row(p_day date)
 returns public.event_days language plpgsql security definer set search_path to 'public', 'pg_temp'
as $function$
declare d event_days; v_prev text; v_pick text; w integer[]; r numeric; v_tier integer;
begin
  select * into d from event_days where day = p_day;
  if found then return d; end if;
  perform pg_advisory_xact_lock(hashtext('event_day'));
  select * into d from event_days where day = p_day;
  if found then return d; end if;
  select event_id into v_prev from event_days where day < p_day order by day desc limit 1;
  select id into v_pick from event_catalog where ready and (v_prev is null or id <> v_prev or (select count(*) from event_catalog where ready) = 1)
   order by random() limit 1;
  if v_pick is null then return null; end if;
  select array_agg(case when x ~ '^\d+$' then x::integer else 0 end) into w
    from unnest(string_to_array(coalesce((select value from game_settings where key = 'event_tier_weights'), '40,40,20'), ',')) x;
  if coalesce(array_length(w, 1), 0) < 3 or w[1] + w[2] + w[3] <= 0 then w := array[40, 40, 20]; end if;
  r := random() * (w[1] + w[2] + w[3]);
  v_tier := case when r < w[1] then 1 when r < w[1] + w[2] then 2 else 3 end;
  insert into event_days (day, event_id, tier) values (p_day, v_pick, v_tier) on conflict (day) do nothing;
  select * into d from event_days where day = p_day;
  return d;
end;
$function$;

-- Сегодня: окно, ивент (только когда окно открыто), следующее открытие
create or replace function public.event_today()
 returns jsonb language plpgsql security definer set search_path to 'public', 'pg_temp'
as $function$
declare
  tz text := event_tz(); v_now timestamptz := now(); v_day date; v_open timestamptz; v_close timestamptz; v_next timestamptz; d event_days; v_is boolean;
begin
  v_day := (v_now at time zone tz)::date;
  v_open := (v_day + make_interval(hours => event_setting_int('event_open_hour', 18))) at time zone tz;
  v_close := (v_day + make_interval(hours => event_setting_int('event_close_hour', 23))) at time zone tz;
  v_is := v_now >= v_open and v_now < v_close;
  v_next := case when v_now < v_open then v_open else ((v_day + 1) + make_interval(hours => event_setting_int('event_open_hour', 18))) at time zone tz end;
  if v_is then d := event_day_row(v_day); end if;
  return jsonb_build_object('day', v_day, 'open', v_is and d.event_id is not null, 'event', d.event_id, 'tier', d.tier,
                            'opens_at', v_open, 'closes_at', v_close, 'next_at', v_next, 'now', v_now, 'tz', tz);
end;
$function$;

-- Получал ли игрок награду за день (победа / любая)
create or replace function public.event_paid_today(p_user uuid, p_day date)
 returns jsonb language sql stable security definer set search_path to 'public', 'pg_temp'
as $function$
  select jsonb_build_object(
    'win', exists (select 1 from event_awards a where a.user_id = p_user and a.paid and a.won and (a.at at time zone event_tz())::date = p_day),
    'any', exists (select 1 from event_awards a where a.user_id = p_user and a.paid and (a.at at time zone event_tz())::date = p_day));
$function$;

-- ---------------------------------------------------------------- просрочка
create or replace function public.event_expire()
 returns integer
 language plpgsql security definer set search_path to 'public', 'pg_temp'
as $function$
declare n integer; tz text := event_tz(); v_day date := (now() at time zone event_tz())::date;
  v_close timestamptz := (((now() at time zone event_tz())::date) + make_interval(hours => event_setting_int('event_close_hour', 23))) at time zone event_tz();
begin
  update event_matches set status = 'aborted', ended_at = now(), result = coalesce(result, '{}'::jsonb) || jsonb_build_object('why', 'сервер боя не открыл матч')
   where status = 'forming' and created_at < now() - interval '3 minutes';
  get diagnostics n = row_count;
  update event_matches set status = 'aborted', ended_at = now(), result = coalesce(result, '{}'::jsonb) || jsonb_build_object('why', 'бой не завершён')
   where status = 'live' and (started_at < now() - interval '45 minutes' or coalesce(beat_at, started_at) < now() - interval '2 minutes');
  update event_queue set state = 'expired', left_at = now() where state = 'waiting' and joined_at < now() - interval '30 minutes' and call_id is null;
  -- окно закрылось: запись без сбора гаснет (начатый сбор доводится до конца)
  update event_queue set state = 'expired', left_at = now()
   where state = 'waiting' and call_id is null and (coalesce(day, (joined_at at time zone tz)::date) < v_day or now() >= v_close);
  return n;
end;
$function$;

-- ---------------------------------------------------------------- сбор и матч
-- Матч из сбора: игроки сбора + боты на пустые роли (если сбор «с ботами»)
create or replace function public.event_call_start(p_call uuid)
 returns uuid
 language plpgsql security definer set search_path to 'public', 'pg_temp'
as $function$
declare
  q event_queue; e record; r jsonb; v_players jsonb := '[]'::jsonb; v_id uuid; v_map text; n integer; i integer; v_bots boolean;
begin
  select * into q from event_queue where call_id = p_call and state = 'waiting' limit 1;
  if not found then return null; end if;
  select * into e from event_catalog where id = q.event_id;
  v_bots := q.call_mode = 'bots';
  for r in select * from jsonb_array_elements(e.roles) loop
    select count(*) into n from event_queue where call_id = p_call and state = 'waiting' and role = r->>'id';
    v_players := v_players || coalesce((select jsonb_agg(jsonb_build_object('user', x.user_id, 'role', x.role, 'side', x.side, 'nick', x.nick) order by x.joined_at)
                                          from event_queue x where x.call_id = p_call and x.state = 'waiting' and x.role = r->>'id'), '[]'::jsonb);
    if v_bots and n < (r->>'min')::integer then
      -- пустая роль: один бот у одиночной роли, двое у групповой (как в тесте); неполная — до минимума
      for i in 1..(case when n > 0 then (r->>'min')::integer - n when (r->>'max')::integer = 1 then 1
                        else greatest((r->>'min')::integer, least((r->>'max')::integer, 2)) end) loop
        v_players := v_players || jsonb_build_array(jsonb_build_object('user', 'bot:' || (r->>'id') || ':' || i, 'role', r->>'id', 'side', r->>'side', 'bot', true));
      end loop;
    end if;
  end loop;
  v_map := e.maps[1 + floor(random() * array_length(e.maps, 1))::integer];
  insert into event_matches (event_id, tier, map, players, day, bots, reward_k)
  values (q.event_id, q.tier, v_map, v_players, q.day, v_bots,
          case when v_bots then greatest(0, least(100, event_setting_int('event_bots_reward_pct', 50))) / 100.0 else 1 end)
  returning id into v_id;
  update event_queue set state = 'matched', match_id = v_id where call_id = p_call and state = 'waiting';
  return v_id;
end;
$function$;

-- Подбор: идущий сбор — проверить готовность и срок; иначе, когда роли набрали минимум и
-- (все на максимуме или старший ждёт ≥ 30 с), — объявить сбор
create or replace function public.event_match_try(p_event text, p_tier integer)
 returns uuid
 language plpgsql security definer set search_path to 'public', 'pg_temp'
as $function$
declare
  e record; r jsonb; ok boolean := true; full_ boolean := true; oldest timestamptz; n integer; v_call uuid; v_at timestamptz; v_all boolean;
  v_ids bigint[]; v_sel bigint[] := '{}';
begin
  if not pg_try_advisory_xact_lock(hashtext('event_match:' || p_event || ':' || p_tier)) then return null; end if;
  select * into e from event_catalog where id = p_event and ready;
  if not found then return null; end if;
  -- идущий сбор
  select call_id, min(called_at), bool_and(ready_at is not null) into v_call, v_at, v_all
    from event_queue where event_id = p_event and tier = p_tier and state = 'waiting' and call_id is not null group by call_id limit 1;
  if v_call is not null then
    if v_all then return event_call_start(v_call); end if;
    if v_at < now() - make_interval(secs => event_setting_int('event_call_seconds', 120)) then
      -- не подтвердили вовремя — сняты с записи; подтвердившие снова ждут
      update event_queue set state = 'left', left_at = now() where call_id = v_call and state = 'waiting' and ready_at is null;
      update event_queue set call_id = null, call_mode = null, called_at = null, ready_at = null where call_id = v_call and state = 'waiting';
    else
      return null;
    end if;
  end if;
  for r in select * from jsonb_array_elements(e.roles) loop
    select count(*) into n from event_queue q where q.event_id = p_event and q.tier = p_tier and q.role = r->>'id' and q.state = 'waiting';
    if n < (r->>'min')::integer then ok := false; end if;
    if n < (r->>'max')::integer then full_ := false; end if;
  end loop;
  if not ok then return null; end if;
  select min(joined_at) into oldest from event_queue q where q.event_id = p_event and q.tier = p_tier and q.state = 'waiting';
  if not full_ and oldest > now() - interval '30 seconds' then return null; end if;
  for r in select * from jsonb_array_elements(e.roles) loop
    select coalesce(array_agg(x.id), '{}') into v_ids
      from (select q.id from event_queue q where q.event_id = p_event and q.tier = p_tier and q.role = r->>'id' and q.state = 'waiting'
            order by q.joined_at limit (r->>'max')::integer) x;
    v_sel := v_sel || v_ids;
  end loop;
  v_call := gen_random_uuid();
  update event_queue set call_id = v_call, call_mode = 'pvp', called_at = now(), ready_at = null where id = any(v_sel);
  return null;
end;
$function$;

-- ---------------------------------------------------------------- игроку
create or replace function public.event_status()
 returns jsonb
 language plpgsql security definer set search_path to 'public', 'pg_temp'
as $function$
declare
  v_me uuid := auth.uid(); q event_queue; m event_matches; cnt jsonb; e record; v_call jsonb; v_today jsonb; v_bots_in integer; v_other integer; v_day date;
begin
  if v_me is null then raise exception 'Нужно войти'; end if;
  perform event_expire();
  select * into q from event_queue where user_id = v_me and state = 'waiting' order by id desc limit 1;
  if found then
    perform event_match_try(q.event_id, q.tier);
    select * into q from event_queue where id = q.id;
  end if;
  m := event_my_match(v_me);
  v_today := event_today();
  v_day := (v_today->>'day')::date;
  if q.id is not null and q.state = 'waiting' then
    select coalesce(jsonb_object_agg(x.role, x.n), '{}'::jsonb) into cnt
      from (select role, count(*) n from event_queue where event_id = q.event_id and tier = q.tier and state = 'waiting' group by role) x;
    if q.call_id is not null then
      select jsonb_build_object('mode', q.call_mode, 'at', min(x.called_at),
               'deadline', min(x.called_at) + make_interval(secs => event_setting_int('event_call_seconds', 120)),
               'total', count(*), 'ready', count(x.ready_at), 'me_ready', q.ready_at is not null,
               'who', jsonb_agg(jsonb_build_object('nick', x.nick, 'role', x.role, 'ready', x.ready_at is not null) order by x.joined_at))
        into v_call from event_queue x where x.call_id = q.call_id and x.state = 'waiting';
    else
      -- можно позвать ботов: на другую сторону никто не записан, ждёшь дольше порога
      select * into e from event_catalog where id = q.event_id;
      select count(*) into v_other from event_queue x where x.event_id = q.event_id and x.tier = q.tier and x.state = 'waiting' and x.side <> q.side;
      v_bots_in := greatest(0, event_setting_int('event_bots_after_seconds', 180) - extract(epoch from now() - q.joined_at)::integer);
    end if;
  end if;
  return jsonb_build_object(
    'queue', case when q.id is not null and q.state = 'waiting' then jsonb_build_object('event', q.event_id, 'tier', q.tier, 'role', q.role, 'since', q.joined_at,
              'wait', extract(epoch from now() - q.joined_at)::integer, 'counts', cnt, 'call', v_call,
              'bots_in', case when q.call_id is null and coalesce(v_other, 0) = 0 then v_bots_in end) end,
    'match', case when m.id is not null then jsonb_build_object('id', m.id, 'event', m.event_id, 'tier', m.tier, 'map', m.map, 'status', m.status, 'players', m.players, 'test', m.test, 'bots', m.bots) end,
    'today', v_today,
    'paid', event_paid_today(v_me, v_day),
    'bots_pct', event_setting_int('event_bots_reward_pct', 50),
    'server', rt_server_status());
end;
$function$;

create or replace function public.event_list()
 returns jsonb
 language plpgsql security definer set search_path to 'public', 'pg_temp'
as $function$
declare v_me uuid := auth.uid(); v_side text; v_today jsonb;
begin
  if v_me is null then raise exception 'Нужно войти'; end if;
  select faction into v_side from profiles where id = v_me;
  v_today := event_today();
  return jsonb_build_object(
    'side', v_side,
    'today', v_today,
    'paid', event_paid_today(v_me, (v_today->>'day')::date),
    'bots_pct', event_setting_int('event_bots_reward_pct', 50),
    'events', (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'ready', c.ready, 'roles', c.roles, 'maps', c.maps) order by c.sort), '[]'::jsonb) from event_catalog c where v_side = any(c.sides)),
    'trophies', (select coalesce(jsonb_agg(jsonb_build_array(t.event_id, t.tier)), '[]'::jsonb) from event_trophies t where t.user_id = v_me),
    'titles', (select coalesce(jsonb_agg(t.title order by t.at), '[]'::jsonb) from event_titles t where t.user_id = v_me),
    'profile', (select to_jsonb(p) - 'user_id' from event_profile p where p.user_id = v_me),
    'waiting', (select coalesce(jsonb_object_agg(x.k, x.n), '{}'::jsonb) from (select event_id || ':' || tier || ':' || role k, count(*) n from event_queue where state = 'waiting' group by 1) x),
    'admin', exists (select 1 from dev_admins where user_id = v_me and revoked_at is null));
end;
$function$;

-- Запись на ивент дня. p_event и p_tier остались ради старых экранов: ивент должен быть сегодняшним,
-- уровень берётся дневной.
create or replace function public.event_join(p_event text, p_tier integer, p_role text)
 returns jsonb
 language plpgsql security definer set search_path to 'public', 'pg_temp'
as $function$
declare v_me uuid := auth.uid(); v_side text; v_nick text; e record; r jsonb; v_today jsonb;
begin
  if v_me is null then raise exception 'Нужно войти'; end if;
  select faction, nickname into v_side, v_nick from profiles where id = v_me;
  if v_side is null then raise exception 'Сначала выбери сторону'; end if;
  v_today := event_today();
  if not coalesce((v_today->>'open')::boolean, false) then raise exception 'Ивенты открыты с 18:00 до 23:00 по времени сервера'; end if;
  if p_event is distinct from v_today->>'event' then raise exception 'Сегодня открыт другой ивент'; end if;
  select * into e from event_catalog where id = p_event;
  if not found or not e.ready then raise exception 'Этот ивент ещё не открыт'; end if;
  select x into r from jsonb_array_elements(e.roles) x where x->>'id' = p_role;
  if r is null then raise exception 'Нет такой роли'; end if;
  if r->>'side' <> v_side then raise exception 'Эта роль — за другую сторону'; end if;
  if (event_my_match(v_me)).id is not null then raise exception 'Ты уже в бою ивента'; end if;
  if exists (select 1 from event_queue where user_id = v_me and state = 'waiting' and call_id is not null) then raise exception 'Идёт сбор — подтверди или выйди'; end if;
  update event_queue set state = 'left', left_at = now() where user_id = v_me and state = 'waiting';
  insert into event_queue (user_id, event_id, tier, role, side, nick, day)
  values (v_me, p_event, (v_today->>'tier')::integer, p_role, v_side, v_nick, (v_today->>'day')::date);
  perform event_match_try(p_event, (v_today->>'tier')::integer);
  return event_status();
end;
$function$;

-- «Готов» на сборе
create or replace function public.event_ready()
 returns jsonb
 language plpgsql security definer set search_path to 'public', 'pg_temp'
as $function$
declare v_me uuid := auth.uid(); q event_queue;
begin
  if v_me is null then raise exception 'Нужно войти'; end if;
  select * into q from event_queue where user_id = v_me and state = 'waiting' and call_id is not null order by id desc limit 1;
  if not found then raise exception 'Сбора нет — он мог закончиться'; end if;
  update event_queue set ready_at = coalesce(ready_at, now()) where id = q.id;
  perform event_match_try(q.event_id, q.tier);
  return event_status();
end;
$function$;

-- Играть с ботами: на другую сторону никто не записан дольше порога. Сбор — все записанные своей стороны.
create or replace function public.event_bots()
 returns jsonb
 language plpgsql security definer set search_path to 'public', 'pg_temp'
as $function$
declare v_me uuid := auth.uid(); q event_queue; e record; v_call uuid; v_sel bigint[] := '{}'; v_ids bigint[]; r jsonb;
begin
  if v_me is null then raise exception 'Нужно войти'; end if;
  select * into q from event_queue where user_id = v_me and state = 'waiting' order by id desc limit 1;
  if not found then raise exception 'Сначала запишись на ивент'; end if;
  if q.call_id is not null then raise exception 'Сбор уже идёт'; end if;
  if not pg_try_advisory_xact_lock(hashtext('event_match:' || q.event_id || ':' || q.tier)) then raise exception 'Подбор занят — попробуй через секунду'; end if;
  if exists (select 1 from event_queue x where x.event_id = q.event_id and x.tier = q.tier and x.state = 'waiting' and x.side <> q.side) then
    raise exception 'Соперник уже записался — ждём сбора';
  end if;
  if now() - q.joined_at < make_interval(secs => event_setting_int('event_bots_after_seconds', 180)) then raise exception 'Ботов можно позвать после 3 минут ожидания'; end if;
  select * into e from event_catalog where id = q.event_id;
  for r in select * from jsonb_array_elements(e.roles) loop
    select coalesce(array_agg(x.id), '{}') into v_ids
      from (select x.id from event_queue x where x.event_id = q.event_id and x.tier = q.tier and x.role = r->>'id' and x.state = 'waiting' and x.side = q.side
            order by x.joined_at limit (r->>'max')::integer) x;
    v_sel := v_sel || v_ids;
  end loop;
  v_call := gen_random_uuid();
  update event_queue set call_id = v_call, call_mode = 'bots', called_at = now(), ready_at = case when id = q.id then now() end where id = any(v_sel);
  perform event_call_start(v_call) where (select bool_and(ready_at is not null) from event_queue where call_id = v_call and state = 'waiting');
  return event_status();
end;
$function$;

create or replace function public.event_leave()
 returns jsonb
 language plpgsql security definer set search_path to 'public', 'pg_temp'
as $function$
declare v_me uuid := auth.uid(); q event_queue;
begin
  if v_me is null then raise exception 'Нужно войти'; end if;
  select * into q from event_queue where user_id = v_me and state = 'waiting' order by id desc limit 1;
  update event_queue set state = 'left', left_at = now() where user_id = v_me and state = 'waiting';
  -- ушёл со сбора — сбор распускается, остальные снова ждут
  if q.call_id is not null then
    update event_queue set call_id = null, call_mode = null, called_at = null, ready_at = null where call_id = q.call_id and state = 'waiting';
  end if;
  return event_status();
end;
$function$;

-- ---------------------------------------------------------------- итог: награда раз в день, бои с ботами ×доля
create or replace function public.rt_event_finish(p_key text, p_match uuid, p_result jsonb)
 returns jsonb
 language plpgsql security definer set search_path to 'public', 'pg_temp'
as $function$
declare
  m event_matches; e record; tr record; p jsonb; v_user uuid; v_won boolean; v_share numeric; v_t integer; v_present jsonb; v_void boolean;
  v_cr integer; v_res jsonb; v_planet text; v_fit integer; v_left integer; k text; v_amt integer; v_pts integer; v_title text; out_ jsonb := '[]'::jsonb;
  v_day date; v_paid jsonb; v_capped boolean;
begin
  perform rt_need_key(p_key);
  select * into m from event_matches where id = p_match for update;
  if not found then raise exception 'нет такого матча'; end if;
  if m.status = 'done' then return jsonb_build_object('ok', true, 'again', true); end if;
  if m.status <> 'live' then raise exception 'матч не идёт: %', m.status; end if;
  select * into e from event_catalog where id = m.event_id;
  select * into tr from event_tiers where n = m.tier;
  v_t := coalesce((p_result->>'t')::integer, 0);
  v_present := p_result->'present';                                              -- кто из людей входил в бой
  v_void := coalesce((p_result->>'forfeit')::boolean, false) and v_t < 180;       -- соперник ушёл в первые 3 минуты — без наград
  update event_matches set status = 'done', ended_at = now(), result = p_result, winner = p_result->>'winner' where id = p_match;
  if m.test then return jsonb_build_object('ok', true, 'test', true); end if;
  v_day := coalesce(m.day, (now() at time zone event_tz())::date);
  for p in select * from jsonb_array_elements(m.players) loop
    continue when coalesce((p->>'bot')::boolean, false) or (p->>'user') !~ '^[0-9a-f-]{36}$';
    continue when jsonb_typeof(v_present) = 'array' and not (v_present ? (p->>'user'));
    continue when v_void;
    v_user := (p->>'user')::uuid;
    v_won := (p->>'role') = (p_result->>'winner');
    v_paid := event_paid_today(v_user, v_day);
    -- победа — одна оплачиваемая в день; утешение — только пока за день ничего не получено; против ботов утешения нет
    v_capped := (v_won and (v_paid->>'win')::boolean) or (not v_won and ((v_paid->>'any')::boolean or m.bots));
    v_share := case when v_capped then 0 when v_won then 1 when v_t >= 180 then 0.25 else 0 end * coalesce(m.reward_k, 1);
    v_cr := (round(e.reward_cr * tr.k * v_share / 5) * 5)::integer; v_res := '{}'::jsonb;
    select sc.system_id into v_planet from system_control sc where sc.controller_user_id = v_user order by sc.system_id limit 1;
    for k, v_amt in select key, (round(value::numeric * tr.k * v_share / 5) * 5)::integer from jsonb_each_text(e.reward_res) loop
      continue when v_amt <= 0;
      v_fit := case when v_planet is not null then add_planet_stock(v_planet, k, v_amt) else 0 end;
      v_left := v_amt - v_fit;
      if v_fit > 0 then v_res := v_res || jsonb_build_object(k, v_fit); end if;
      if v_left > 0 then v_cr := v_cr + v_left * coalesce((select base_price from resources where id = k), 10); end if;
    end loop;
    if v_cr > 0 then update profiles set credits = credits + v_cr where id = v_user; end if;
    -- очки: против ботов — половина за победу, за поражение ничего
    v_pts := case when v_won then case when m.bots then ceil(tr.pts / 2.0)::integer else tr.pts end when v_t >= 180 and not m.bots then 3 else 0 end;
    insert into event_awards (match_id, user_id, role, won, credits, resources, planet, points, paid)
    values (p_match, v_user, p->>'role', v_won, v_cr, v_res, case when v_res <> '{}'::jsonb then v_planet end, v_pts, v_cr > 0 or v_res <> '{}'::jsonb)
    on conflict (match_id, user_id) do nothing;
    insert into event_profile (user_id, points, wins, games) values (v_user, v_pts, case when v_won then 1 else 0 end, 1)
    on conflict (user_id) do update set points = event_profile.points + excluded.points, wins = event_profile.wins + excluded.wins, games = event_profile.games + 1;
    v_title := null;
    if v_won then
      insert into event_trophies (user_id, event_id, tier, match_id) values (v_user, m.event_id, m.tier, p_match) on conflict do nothing;
      if m.tier = 3 then
        v_title := e.titles->>(p->>'role');
        if v_title is not null then insert into event_titles (user_id, title, event_id) values (v_user, v_title, m.event_id) on conflict do nothing; end if;
      end if;
    end if;
    out_ := out_ || jsonb_build_array(jsonb_build_object('user', v_user, 'won', v_won, 'credits', v_cr, 'res', v_res, 'points', v_pts, 'title', v_title, 'capped', v_capped));
  end loop;
  return jsonb_build_object('ok', true, 'awards', out_);
end;
$function$;

-- ---------------------------------------------------------------- права
do $$
declare f text;
begin
  foreach f in array array['event_tz()', 'event_setting_int(text, integer)', 'event_day_row(date)', 'event_paid_today(uuid, date)', 'event_call_start(uuid)', 'event_today()']
  loop execute format('revoke all on function public.%s from public, anon, authenticated', f); end loop;
  foreach f in array array['event_ready()', 'event_bots()']
  loop execute format('revoke all on function public.%s from public, anon', f); execute format('grant execute on function public.%s to authenticated', f); end loop;
end $$;
