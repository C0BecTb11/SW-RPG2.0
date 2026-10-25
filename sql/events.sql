-- ⚠ НЕ ПРИМЕНЯТЬ ПОВТОРНО ЦЕЛИКОМ (аудит 25.10.2026). Файл устарел относительно базы: его прогон откатит
--   event_status, event_list, event_join, event_leave, event_match_try, event_expire, rt_event_finish — потеряются окно 18–23, сбор и награда раз в день (sql/events_schedule.sql) и пары PvE (sql/events_defense.sql).
--   Нужна функция отсюда — бери её текущую версию из базы (pg_get_functiondef), а не из этого файла.
-- Ивенты: каталог, очередь и подбор, матчи, награды, трофеи, титулы, рейтинг, тест из DEV.
-- Каталог повторяет shared/rt-events-cat.js (награды, роли, титулы; сверка — tools/events/check.js).
-- Оборона (r_tessara, c_siege) и пары PvE-ивентов — sql/events_defense.sql.
-- Бой идёт в комнате сервера «ev:<матч>» (server/event-room.js): rt_event_open → бой → rt_event_finish.
-- Игрокам — только функции ниже; таблицы закрыты (RLS без политик, права сняты).

-- ---------------------------------------------------------------- таблицы
create table if not exists public.event_catalog (
  id text primary key,
  kind text not null check (kind in ('pvp', 'pve')),
  theater text not null check (theater in ('ground', 'space')),
  sides text[] not null,
  title text not null,
  troops text not null default 'event',
  ready boolean not null default false,
  roles jsonb not null default '[]',
  maps text[] not null default '{}',
  minutes integer[] not null default '{12,15,18}',
  reward_cr integer not null default 0,
  reward_res jsonb not null default '{}',
  titles jsonb not null default '{}',
  sort integer not null default 0
);
create table if not exists public.event_tiers (n integer primary key, name text not null, k numeric not null, pts integer not null);
create table if not exists public.event_matches (
  id uuid primary key default gen_random_uuid(),
  event_id text not null references public.event_catalog(id),
  tier integer not null,
  map text not null,
  status text not null default 'forming' check (status in ('forming', 'live', 'done', 'aborted')),
  players jsonb not null default '[]',
  test boolean not null default false,
  created_by uuid,
  seed integer not null default (floor(random() * 1000000))::integer,
  created_at timestamptz not null default now(),
  started_at timestamptz, ended_at timestamptz,
  result jsonb, winner text
);
alter table public.event_matches add column if not exists beat_at timestamptz;     -- сердцебиение комнаты боя
create index if not exists event_matches_status on public.event_matches (status, created_at);
create table if not exists public.event_queue (
  id bigserial primary key,
  user_id uuid not null,
  event_id text not null references public.event_catalog(id),
  tier integer not null,
  role text not null,
  side text not null,
  nick text,
  state text not null default 'waiting' check (state in ('waiting', 'matched', 'left', 'expired')),
  joined_at timestamptz not null default now(),
  match_id uuid, left_at timestamptz
);
create unique index if not exists event_queue_one on public.event_queue (user_id) where state = 'waiting';
create index if not exists event_queue_wait on public.event_queue (event_id, tier, state);
create table if not exists public.event_awards (
  match_id uuid not null, user_id uuid not null, role text, won boolean not null,
  credits integer not null default 0, resources jsonb not null default '{}', planet text, points integer not null default 0,
  at timestamptz not null default now(), primary key (match_id, user_id)
);
create table if not exists public.event_trophies (user_id uuid not null, event_id text not null, tier integer not null, match_id uuid, at timestamptz not null default now(), primary key (user_id, event_id, tier));
create table if not exists public.event_titles (user_id uuid not null, title text not null, event_id text, at timestamptz not null default now(), primary key (user_id, title));
create table if not exists public.event_profile (user_id uuid primary key, title text, points integer not null default 0, wins integer not null default 0, games integer not null default 0);

alter table public.event_catalog enable row level security;
alter table public.event_tiers enable row level security;
alter table public.event_matches enable row level security;
alter table public.event_queue enable row level security;
alter table public.event_awards enable row level security;
alter table public.event_trophies enable row level security;
alter table public.event_titles enable row level security;
alter table public.event_profile enable row level security;
revoke all on public.event_catalog, public.event_tiers, public.event_matches, public.event_queue, public.event_awards,
              public.event_trophies, public.event_titles, public.event_profile from anon, authenticated;
revoke all on sequence public.event_queue_id_seq from anon, authenticated;

-- ---------------------------------------------------------------- каталог
insert into public.event_tiers (n, name, k, pts) values (1, 'Новобранец', 1, 10), (2, 'Ветеран', 2.2, 25), (3, 'Легенда', 4, 60)
on conflict (n) do update set name = excluded.name, k = excluded.k, pts = excluded.pts;

insert into public.event_catalog (id, kind, theater, sides, title, troops, ready, roles, maps, minutes, reward_cr, reward_res, titles, sort) values
 ('hunt_sith', 'pvp', 'ground', '{republic,cis}', 'Охота на ситха', 'event', true,
  '[{"id":"sith","side":"cis","min":1,"max":1,"name":"Ситх"},{"id":"hunter","side":"republic","min":1,"max":4,"name":"Охотник"}]',
  '{kaer_tesh,holm7,sarn,mirr_vaal}', '{12,15,18}', 400, '{"durasteel":40,"electronics":20}', '{"sith":"Неуловимый","hunter":"Охотник на ситхов"}', 1),
 ('hunt_jedi', 'pvp', 'ground', '{republic,cis}', 'Охота на джедаев', 'event', true,
  '[{"id":"jedi","side":"republic","min":1,"max":2,"name":"Джедай"},{"id":"hunter","side":"cis","min":1,"max":4,"name":"Охотник"}]',
  '{ul_taren,drex,kess,niir}', '{12,15,18}', 400, '{"durasteel":40,"cells":20}', '{"jedi":"Тень Ордена","hunter":"Гроза джедаев"}', 2),
 ('envoy', 'pvp', 'ground', '{republic,cis}', 'Посол под огнём', 'event', false, '[]', '{}', '{12,15,18}', 450, '{"electronics":40}', '{}', 3),
 ('holocron', 'pvp', 'ground', '{republic,cis}', 'Голокрон Предтеч', 'event', false, '[]', '{}', '{12,15,18}', 420, '{"crystals":25}', '{}', 4),
 ('generator', 'pvp', 'ground', '{republic,cis}', 'Диверсия на генераторе', 'event', false, '[]', '{}', '{12,15,18}', 480, '{"cells":40}', '{}', 5),
 ('blockade', 'pvp', 'space', '{republic,cis}', 'Прорыв блокады', 'event', false, '[]', '{}', '{12,15,18}', 500, '{"durasteel":50}', '{}', 6),
 ('phantom', 'pvp', 'space', '{republic,cis}', 'Охота на «Призрака»', 'event', false, '[]', '{}', '{12,15,18}', 500, '{"electronics":40}', '{}', 7),
 ('aces', 'pvp', 'space', '{republic,cis}', 'Дуэль асов', 'event', false, '[]', '{}', '{12,15,18}', 350, '{"cells":30}', '{}', 8),
 ('orbis', 'pvp', 'space', '{republic,cis}', 'Станция «Орбис-9»', 'event', false, '[]', '{}', '{12,15,18}', 520, '{"durasteel":40,"electronics":20}', '{}', 9),
 ('flagship', 'pvp', 'space', '{republic,cis}', 'Абордаж флагмана', 'own', false, '[]', '{}', '{12,15,18}', 650, '{"durasteel":60}', '{}', 10),
 ('r_tessara', 'pve', 'ground', '{republic}', 'Оборона аванпоста «Тессара»', 'event', true,
  '[{"id":"defender","side":"republic","min":1,"max":4,"name":"Гарнизон"}]',
  '{tessara,tessara_pass}', '{10,15,21}', 420, '{"durasteel":40}', '{"defender":"Щит Тессары"}', 11),
 ('r_veilkrag', 'pve', 'ground', '{republic}', 'Плен на заводе «Вейл-Краг»', 'event', false, '[]', '{}', '{12,15,18}', 400, '{"food":60}', '{}', 12),
 ('r_duun', 'pve', 'ground', '{republic}', 'Логово в кратере Дуун', 'event', false, '[]', '{}', '{12,15,18}', 360, '{"food":50}', '{}', 13),
 ('r_meltarr', 'pve', 'ground', '{republic}', 'Завод «Мелтарр»', 'own', false, '[]', '{}', '{12,15,18}', 460, '{"electronics":40}', '{}', 14),
 ('r_pass', 'pve', 'ground', '{republic}', 'Скорбный перевал', 'event', false, '[]', '{}', '{12,15,18}', 420, '{"durasteel":40}', '{}', 15),
 ('r_bridge', 'pve', 'ground', '{republic}', 'Мост «Квентарр»', 'own', false, '[]', '{}', '{12,15,18}', 400, '{"cells":40}', '{}', 16),
 ('r_beacon', 'pve', 'ground', '{republic}', 'Маяк в тумане', 'event', false, '[]', '{}', '{12,15,18}', 420, '{"electronics":30}', '{}', 17),
 ('r_hermit', 'pve', 'ground', '{republic}', 'Тропа Отшельника', 'own', false, '[]', '{}', '{12,15,18}', 500, '{"crystals":20}', '{}', 18),
 ('r_mercy', 'pve', 'space', '{republic}', 'Госпитальный «Милосердие»', 'event', false, '[]', '{}', '{12,15,18}', 420, '{"cells":40}', '{}', 19),
 ('r_harron', 'pve', 'space', '{republic}', 'Конвой у Харрона', 'own', false, '[]', '{}', '{12,15,18}', 460, '{"durasteel":50}', '{}', 20),
 ('r_terminus', 'pve', 'space', '{republic}', 'Станция «Терминус»', 'own', false, '[]', '{}', '{12,15,18}', 600, '{"durasteel":60}', '{}', 21),
 ('r_courier', 'pve', 'space', '{republic}', 'Перехват курьера', 'event', false, '[]', '{}', '{12,15,18}', 380, '{"electronics":30}', '{}', 22),
 ('r_pirates', 'pve', 'space', '{republic}', 'Туманность Сайрус-Тан', 'own', false, '[]', '{}', '{12,15,18}', 520, '{"gas":60}', '{}', 23),
 ('r_argos', 'pve', 'space', '{republic}', 'Дрейфующий «Аргос»', 'event', false, '[]', '{}', '{12,15,18}', 480, '{"food":60}', '{}', 24),
 ('r_mardos', 'pve', 'space', '{republic}', 'Верфь «Кольцо Мардоса»', 'own', false, '[]', '{}', '{12,15,18}', 700, '{"durasteel":80}', '{}', 25),
 ('c_echo', 'pve', 'ground', '{cis}', 'Эхо-Ридж', 'own', false, '[]', '{}', '{12,15,18}', 420, '{"durasteel":40}', '{}', 26),
 ('c_trials', 'pve', 'ground', '{cis}', 'Полевые испытания', 'event', false, '[]', '{}', '{12,15,18}', 400, '{"electronics":40}', '{}', 27),
 ('c_irridan', 'pve', 'ground', '{cis}', 'Кристаллы Ирридана', 'own', false, '[]', '{}', '{12,15,18}', 440, '{"crystals":25}', '{}', 28),
 ('c_contract', 'pve', 'ground', '{cis}', 'Контракт на командира', 'event', false, '[]', '{}', '{12,15,18}', 460, '{"electronics":30}', '{}', 29),
 ('c_narkess', 'pve', 'ground', '{cis}', 'Нар-Кесс', 'own', false, '[]', '{}', '{12,15,18}', 420, '{"food":60}', '{}', 30),
 ('c_aurelis', 'pve', 'ground', '{cis}', 'Лаборатория «Аурелис»', 'event', false, '[]', '{}', '{12,15,18}', 440, '{"electronics":40}', '{}', 31),
 ('c_siege', 'pve', 'ground', '{cis}', 'Завод под осадой', 'event', true,
  '[{"id":"defender","side":"cis","min":1,"max":4,"name":"Гарнизон"}]',
  '{vex,vex_slag}', '{10,15,21}', 420, '{"durasteel":40}', '{"defender":"Стальная стена Векса"}', 32),
 ('c_grotto', 'pve', 'ground', '{cis}', 'Грот Шепчущих', 'own', false, '[]', '{}', '{12,15,18}', 500, '{"crystals":20}', '{}', 33),
 ('c_kolm', 'pve', 'space', '{cis}', 'Дрейф Кольм', 'own', false, '[]', '{}', '{12,15,18}', 480, '{"durasteel":50}', '{}', 34),
 ('c_vigil', 'pve', 'space', '{cis}', 'Ретранслятор «Вигил»', 'event', false, '[]', '{}', '{12,15,18}', 420, '{"electronics":40}', '{}', 35),
 ('c_scriptorium', 'pve', 'space', '{cis}', 'Станция «Скрипторий»', 'event', false, '[]', '{}', '{12,15,18}', 420, '{"cells":40}', '{}', 36),
 ('c_swarm', 'pve', 'space', '{cis}', 'Рой', 'event', false, '[]', '{}', '{12,15,18}', 380, '{"cells":30}', '{}', 37),
 ('c_quarantine', 'pve', 'space', '{cis}', 'Карантинная блокада', 'own', false, '[]', '{}', '{12,15,18}', 460, '{"gas":60}', '{}', 38),
 ('c_beacon', 'pve', 'space', '{cis}', 'Абордаж «Светоча»', 'event', false, '[]', '{}', '{12,15,18}', 480, '{"food":60}', '{}', 39),
 ('c_silence', 'pve', 'space', '{cis}', 'Сайленс-Порт', 'own', false, '[]', '{}', '{12,15,18}', 700, '{"durasteel":80}', '{}', 40)
on conflict (id) do update set kind = excluded.kind, theater = excluded.theater, sides = excluded.sides, title = excluded.title, troops = excluded.troops,
  ready = excluded.ready, roles = excluded.roles, maps = excluded.maps, minutes = excluded.minutes, reward_cr = excluded.reward_cr,
  reward_res = excluded.reward_res, titles = excluded.titles, sort = excluded.sort;

-- ---------------------------------------------------------------- служебное
-- Матч игрока: формируется или идёт, он в списке
create or replace function public.event_my_match(p_user uuid)
 returns public.event_matches
 language sql stable security definer set search_path to 'public', 'pg_temp'
as $function$
  select m.* from event_matches m
  where m.status in ('forming', 'live') and m.created_at > now() - interval '2 hours'
    and exists (select 1 from jsonb_array_elements(m.players) p where p->>'user' = p_user::text)
  order by m.created_at desc limit 1;
$function$;

-- Брошенные матчи: сервер не открыл за 3 минуты, бой «идёт» дольше 45 минут
create or replace function public.event_expire()
 returns integer
 language plpgsql security definer set search_path to 'public', 'pg_temp'
as $function$
declare n integer;
begin
  update event_matches set status = 'aborted', ended_at = now(), result = coalesce(result, '{}'::jsonb) || jsonb_build_object('why', 'сервер боя не открыл матч')
   where status = 'forming' and created_at < now() - interval '3 minutes';
  get diagnostics n = row_count;
  update event_matches set status = 'aborted', ended_at = now(), result = coalesce(result, '{}'::jsonb) || jsonb_build_object('why', 'бой не завершён')
   where status = 'live' and (started_at < now() - interval '45 minutes' or coalesce(beat_at, started_at) < now() - interval '2 minutes');
  update event_queue set state = 'expired', left_at = now() where state = 'waiting' and joined_at < now() - interval '30 minutes';
  return n;
end;
$function$;

-- Подбор: все роли набрали минимум и (все на максимуме или старший в очереди ждёт ≥ 30 с)
create or replace function public.event_match_try(p_event text, p_tier integer)
 returns uuid
 language plpgsql security definer set search_path to 'public', 'pg_temp'
as $function$
declare
  e record; r jsonb; rp jsonb; ok boolean := true; full_ boolean := true; oldest timestamptz; n integer;
  v_players jsonb := '[]'::jsonb; v_ids bigint[] := '{}'; v_id uuid; v_map text;
begin
  if not pg_try_advisory_xact_lock(hashtext('event_match:' || p_event || ':' || p_tier)) then return null; end if;
  select * into e from event_catalog where id = p_event and ready;
  if not found then return null; end if;
  for r in select * from jsonb_array_elements(e.roles) loop
    select count(*) into n from event_queue q where q.event_id = p_event and q.tier = p_tier and q.role = r->>'id' and q.state = 'waiting';
    if n < (r->>'min')::integer then ok := false; end if;
    if n < (r->>'max')::integer then full_ := false; end if;
  end loop;
  if not ok then return null; end if;
  select min(joined_at) into oldest from event_queue q where q.event_id = p_event and q.tier = p_tier and q.state = 'waiting';
  if not full_ and oldest > now() - interval '30 seconds' then return null; end if;
  for r in select * from jsonb_array_elements(e.roles) loop
    select coalesce(jsonb_agg(jsonb_build_object('user', q.user_id, 'role', q.role, 'side', q.side, 'nick', q.nick) order by q.joined_at), '[]'::jsonb),
           coalesce(array_agg(q.id), '{}')
      into rp, v_ids
      from (select * from event_queue q where q.event_id = p_event and q.tier = p_tier and q.role = r->>'id' and q.state = 'waiting'
            order by q.joined_at limit (r->>'max')::integer) q;
    v_players := v_players || rp;
    update event_queue set state = 'matched' where id = any(v_ids);
  end loop;
  v_map := e.maps[1 + floor(random() * array_length(e.maps, 1))::integer];
  insert into event_matches (event_id, tier, map, players) values (p_event, p_tier, v_map, v_players) returning id into v_id;
  update event_queue q set match_id = v_id
   where q.state = 'matched' and q.match_id is null and q.event_id = p_event and q.tier = p_tier
     and exists (select 1 from jsonb_array_elements(v_players) p where p->>'user' = q.user_id::text);
  return v_id;
end;
$function$;

-- ---------------------------------------------------------------- игроку
create or replace function public.event_status()
 returns jsonb
 language plpgsql security definer set search_path to 'public', 'pg_temp'
as $function$
declare v_me uuid := auth.uid(); q event_queue; m event_matches; cnt jsonb;
begin
  if v_me is null then raise exception 'Нужно войти'; end if;
  perform event_expire();
  select * into q from event_queue where user_id = v_me and state = 'waiting' order by id desc limit 1;
  if found then
    perform event_match_try(q.event_id, q.tier);
    select * into q from event_queue where id = q.id;
  end if;
  m := event_my_match(v_me);
  if q.id is not null and q.state = 'waiting' then
    select coalesce(jsonb_object_agg(x.role, x.n), '{}'::jsonb) into cnt
      from (select role, count(*) n from event_queue where event_id = q.event_id and tier = q.tier and state = 'waiting' group by role) x;
  end if;
  return jsonb_build_object(
    'queue', case when q.id is not null and q.state = 'waiting' then jsonb_build_object('event', q.event_id, 'tier', q.tier, 'role', q.role, 'since', q.joined_at, 'wait', extract(epoch from now() - q.joined_at)::integer, 'counts', cnt) end,
    'match', case when m.id is not null then jsonb_build_object('id', m.id, 'event', m.event_id, 'tier', m.tier, 'map', m.map, 'status', m.status, 'players', m.players, 'test', m.test) end,
    'server', rt_server_status());
end;
$function$;

create or replace function public.event_list()
 returns jsonb
 language plpgsql security definer set search_path to 'public', 'pg_temp'
as $function$
declare v_me uuid := auth.uid(); v_side text;
begin
  if v_me is null then raise exception 'Нужно войти'; end if;
  select faction into v_side from profiles where id = v_me;
  return jsonb_build_object(
    'side', v_side,
    'events', (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'ready', c.ready, 'roles', c.roles, 'maps', c.maps) order by c.sort), '[]'::jsonb) from event_catalog c where v_side = any(c.sides)),
    'trophies', (select coalesce(jsonb_agg(jsonb_build_array(t.event_id, t.tier)), '[]'::jsonb) from event_trophies t where t.user_id = v_me),
    'titles', (select coalesce(jsonb_agg(t.title order by t.at), '[]'::jsonb) from event_titles t where t.user_id = v_me),
    'profile', (select to_jsonb(p) - 'user_id' from event_profile p where p.user_id = v_me),
    'waiting', (select coalesce(jsonb_object_agg(x.k, x.n), '{}'::jsonb) from (select event_id || ':' || tier || ':' || role k, count(*) n from event_queue where state = 'waiting' group by 1) x),
    'admin', exists (select 1 from dev_admins where user_id = v_me and revoked_at is null));
end;
$function$;

create or replace function public.event_join(p_event text, p_tier integer, p_role text)
 returns jsonb
 language plpgsql security definer set search_path to 'public', 'pg_temp'
as $function$
declare v_me uuid := auth.uid(); v_side text; v_nick text; e record; r jsonb;
begin
  if v_me is null then raise exception 'Нужно войти'; end if;
  select faction, nickname into v_side, v_nick from profiles where id = v_me;
  if v_side is null then raise exception 'Сначала выбери сторону'; end if;
  select * into e from event_catalog where id = p_event;
  if not found or not e.ready then raise exception 'Этот ивент ещё не открыт'; end if;
  if p_tier not between 1 and 3 then raise exception 'Нет такого уровня'; end if;
  select x into r from jsonb_array_elements(e.roles) x where x->>'id' = p_role;
  if r is null then raise exception 'Нет такой роли'; end if;
  if r->>'side' <> v_side then raise exception 'Эта роль — за другую сторону'; end if;
  if (event_my_match(v_me)).id is not null then raise exception 'Ты уже в бою ивента'; end if;
  update event_queue set state = 'left', left_at = now() where user_id = v_me and state = 'waiting';
  insert into event_queue (user_id, event_id, tier, role, side, nick) values (v_me, p_event, p_tier, p_role, v_side, v_nick);
  perform event_match_try(p_event, p_tier);
  return event_status();
end;
$function$;

create or replace function public.event_leave()
 returns jsonb
 language plpgsql security definer set search_path to 'public', 'pg_temp'
as $function$
declare v_me uuid := auth.uid();
begin
  if v_me is null then raise exception 'Нужно войти'; end if;
  update event_queue set state = 'left', left_at = now() where user_id = v_me and state = 'waiting';
  return event_status();
end;
$function$;

create or replace function public.event_history(p_limit integer default 20)
 returns jsonb
 language sql stable security definer set search_path to 'public', 'pg_temp'
as $function$
  select coalesce(jsonb_agg(x order by x->>'at' desc), '[]'::jsonb) from (
    select jsonb_build_object('id', m.id, 'event', m.event_id, 'tier', m.tier, 'map', m.map, 'status', m.status, 'test', m.test,
                              'at', coalesce(m.ended_at, m.created_at), 'winner', m.winner, 'why', m.result->>'why', 't', (m.result->>'t')::integer,
                              'role', (select p->>'role' from jsonb_array_elements(m.players) p where p->>'user' = auth.uid()::text limit 1),
                              'award', (select to_jsonb(a) - 'match_id' - 'user_id' from event_awards a where a.match_id = m.id and a.user_id = auth.uid())) x
    from event_matches m
    where exists (select 1 from jsonb_array_elements(m.players) p where p->>'user' = auth.uid()::text)
    order by m.created_at desc limit greatest(1, least(50, p_limit))) s;
$function$;

create or replace function public.event_rating(p_side text default null)
 returns jsonb
 language sql stable security definer set search_path to 'public', 'pg_temp'
as $function$
  select coalesce(jsonb_agg(jsonb_build_object('nick', pr.nickname, 'side', pr.faction, 'points', e.points, 'wins', e.wins, 'games', e.games, 'title', e.title, 'me', e.user_id = auth.uid()) order by e.points desc, e.wins desc), '[]'::jsonb)
  from (select ep.* from event_profile ep join profiles p2 on p2.id = ep.user_id
        where ep.games > 0 and (p_side is null or p2.faction = p_side)
        order by ep.points desc, ep.wins desc limit 50) e
  join profiles pr on pr.id = e.user_id;
$function$;

create or replace function public.event_title_set(p_title text)
 returns jsonb
 language plpgsql security definer set search_path to 'public', 'pg_temp'
as $function$
declare v_me uuid := auth.uid();
begin
  if v_me is null then raise exception 'Нужно войти'; end if;
  if p_title is not null and not exists (select 1 from event_titles where user_id = v_me and title = p_title) then raise exception 'Этот титул ещё не получен'; end if;
  insert into event_profile (user_id, title) values (v_me, p_title) on conflict (user_id) do update set title = excluded.title;
  return jsonb_build_object('ok', true, 'title', p_title);
end;
$function$;

-- ---------------------------------------------------------------- администрации: тест без очереди
-- Своя роль — p_role, остальные — боты (охотников-ботов — p_bots, у роли с max 1 — один)
create or replace function public.dev_event_start(p_event text, p_tier integer, p_role text, p_map text default null, p_bots integer default 2)
 returns jsonb
 language plpgsql security definer set search_path to 'public', 'pg_temp'
as $function$
declare v_me uuid := dev_assert(); e record; r jsonb; v_players jsonb := '[]'::jsonb; v_id uuid; v_nick text; v_side text; i integer; n integer;
begin
  select * into e from event_catalog where id = p_event;
  if not found or not e.ready then raise exception 'Этот ивент ещё не открыт'; end if;
  if p_map is not null and not (p_map = any(e.maps)) then raise exception 'У ивента нет такой карты'; end if;
  select nickname, faction into v_nick, v_side from profiles where id = v_me;
  update event_queue set state = 'left', left_at = now() where user_id = v_me and state = 'waiting';
  update event_matches set status = 'aborted', ended_at = now(), result = jsonb_build_object('why', 'новый тест')
   where status in ('forming', 'live') and test and created_by = v_me;
  for r in select * from jsonb_array_elements(e.roles) loop
    if r->>'id' = p_role then
      v_players := v_players || jsonb_build_array(jsonb_build_object('user', v_me, 'role', p_role, 'side', r->>'side', 'nick', v_nick));
      n := (r->>'min')::integer - 1;
    else
      n := case when (r->>'max')::integer = 1 then 1 else greatest((r->>'min')::integer, least((r->>'max')::integer, coalesce(p_bots, 1))) end;
    end if;
    for i in 1..n loop
      v_players := v_players || jsonb_build_array(jsonb_build_object('user', 'bot:' || (r->>'id') || ':' || i, 'role', r->>'id', 'side', r->>'side', 'bot', true));
    end loop;
  end loop;
  if not exists (select 1 from jsonb_array_elements(v_players) p where p->>'user' = v_me::text) then raise exception 'Нет такой роли'; end if;
  insert into event_matches (event_id, tier, map, players, test, created_by)
  values (p_event, greatest(1, least(3, p_tier)), coalesce(p_map, e.maps[1 + floor(random() * array_length(e.maps, 1))::integer]), v_players, true, v_me)
  returning id into v_id;
  insert into dev_log (admin, action, target, data) values (v_me, 'event_start', v_me, jsonb_build_object('event', p_event, 'tier', p_tier, 'role', p_role, 'match', v_id));
  return event_status();
end;
$function$;

create or replace function public.dev_event_recent(p_limit integer default 20)
 returns jsonb
 language plpgsql security definer set search_path to 'public', 'pg_temp'
as $function$
declare v_me uuid := dev_assert();
begin
  return (select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'event', m.event_id, 'tier', m.tier, 'map', m.map, 'status', m.status, 'test', m.test,
            'at', m.created_at, 'winner', m.winner, 'why', m.result->>'why', 't', (m.result->>'t')::integer,
            'players', (select jsonb_agg(coalesce(p->>'nick', p->>'user')) from jsonb_array_elements(m.players) p)) order by m.created_at desc), '[]'::jsonb)
          from (select * from event_matches order by created_at desc limit greatest(1, least(50, p_limit))) m);
end;
$function$;

-- ---------------------------------------------------------------- сервер боёв
create or replace function public.rt_event_open(p_key text, p_match uuid)
 returns jsonb
 language plpgsql security definer set search_path to 'public', 'pg_temp'
as $function$
declare m event_matches; e record;
begin
  perform rt_need_key(p_key);
  update rt_servers set seen_at = now() where id = 'main';
  select * into m from event_matches where id = p_match for update;
  if not found then raise exception 'нет такого матча'; end if;
  if m.status not in ('forming', 'live') then raise exception 'матч уже %', m.status; end if;
  -- идущий матч без сердцебиения больше полутора минут не открывается заново (бой не восстановить)
  if m.status = 'live' and coalesce(m.beat_at, m.started_at) < now() - interval '90 seconds' then raise exception 'матч уже идёт'; end if;
  if m.status = 'forming' then update event_matches set status = 'live', started_at = now(), beat_at = now() where id = p_match;
  else update event_matches set beat_at = now() where id = p_match; end if;
  select * into e from event_catalog where id = m.event_id;
  return jsonb_build_object('id', m.id, 'event', m.event_id, 'tier', m.tier, 'map', m.map, 'players', m.players, 'test', m.test, 'seed', m.seed,
                            'created_by', m.created_by, 'minutes', e.minutes);
end;
$function$;

-- Итог: награды людям (не ботам и не в тесте), трофеи, титул уровня III, очки рейтинга
create or replace function public.rt_event_finish(p_key text, p_match uuid, p_result jsonb)
 returns jsonb
 language plpgsql security definer set search_path to 'public', 'pg_temp'
as $function$
declare
  m event_matches; e record; tr record; p jsonb; v_user uuid; v_won boolean; v_share numeric; v_t integer; v_present jsonb; v_void boolean;
  v_cr integer; v_res jsonb; v_planet text; v_fit integer; v_left integer; k text; v_amt integer; v_pts integer; v_title text; out_ jsonb := '[]'::jsonb;
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
  for p in select * from jsonb_array_elements(m.players) loop
    continue when coalesce((p->>'bot')::boolean, false) or (p->>'user') !~ '^[0-9a-f-]{36}$';
    -- не входил в бой — ни награды, ни боя в счёт
    continue when jsonb_typeof(v_present) = 'array' and not (v_present ? (p->>'user'));
    continue when v_void;
    v_user := (p->>'user')::uuid;
    v_won := (p->>'role') = (p_result->>'winner');
    v_share := case when v_won then 1 when v_t >= 180 then 0.25 else 0 end;
    v_cr := (round(e.reward_cr * tr.k * v_share / 5) * 5)::integer; v_res := '{}'::jsonb;
    select sc.system_id into v_planet from system_control sc where sc.controller_user_id = v_user order by sc.system_id limit 1;
    for k, v_amt in select key, (round(value::numeric * tr.k * v_share / 5) * 5)::integer from jsonb_each_text(e.reward_res) loop
      continue when v_amt <= 0;
      v_fit := case when v_planet is not null then add_planet_stock(v_planet, k, v_amt) else 0 end;
      v_left := v_amt - v_fit;
      if v_fit > 0 then v_res := v_res || jsonb_build_object(k, v_fit); end if;
      -- не влезло на склад (или планеты нет) — кредитами по цене ресурса
      if v_left > 0 then v_cr := v_cr + v_left * coalesce((select base_price from resources where id = k), 10); end if;
    end loop;
    if v_cr > 0 then update profiles set credits = credits + v_cr where id = v_user; end if;
    v_pts := case when v_won then tr.pts when v_t >= 180 then 3 else 0 end;
    insert into event_awards (match_id, user_id, role, won, credits, resources, planet, points)
    values (p_match, v_user, p->>'role', v_won, v_cr, v_res, case when v_res <> '{}'::jsonb then v_planet end, v_pts)
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
    out_ := out_ || jsonb_build_array(jsonb_build_object('user', v_user, 'won', v_won, 'credits', v_cr, 'res', v_res, 'points', v_pts, 'title', v_title));
  end loop;
  return jsonb_build_object('ok', true, 'awards', out_);
end;
$function$;

create or replace function public.rt_event_beat(p_key text, p_match uuid)
 returns void
 language plpgsql security definer set search_path to 'public', 'pg_temp'
as $function$
begin
  perform rt_need_key(p_key);
  update event_matches set beat_at = now() where id = p_match and status = 'live';
end;
$function$;

create or replace function public.rt_event_abort(p_key text, p_match uuid, p_why text)
 returns jsonb
 language plpgsql security definer set search_path to 'public', 'pg_temp'
as $function$
begin
  perform rt_need_key(p_key);
  update event_matches set status = 'aborted', ended_at = now(), result = jsonb_build_object('why', left(coalesce(p_why, ''), 200))
   where id = p_match and status in ('forming', 'live');
  return jsonb_build_object('ok', true);
end;
$function$;

-- ---------------------------------------------------------------- права
revoke all on function public.event_my_match(uuid), public.event_expire(), public.event_match_try(text, integer) from public, anon, authenticated;
revoke all on function public.rt_event_open(text, uuid), public.rt_event_finish(text, uuid, jsonb), public.rt_event_abort(text, uuid, text), public.rt_event_beat(text, uuid) from public, authenticated;
grant execute on function public.rt_event_open(text, uuid), public.rt_event_finish(text, uuid, jsonb), public.rt_event_abort(text, uuid, text), public.rt_event_beat(text, uuid) to anon;
revoke all on function public.event_status(), public.event_list(), public.event_join(text, integer, text), public.event_leave(), public.event_history(integer),
                       public.event_rating(text), public.event_title_set(text), public.dev_event_start(text, integer, text, text, integer), public.dev_event_recent(integer) from public, anon;
grant execute on function public.event_status(), public.event_list(), public.event_join(text, integer, text), public.event_leave(), public.event_history(integer),
                          public.event_rating(text), public.event_title_set(text), public.dev_event_start(text, integer, text, text, integer), public.dev_event_recent(integer) to authenticated;
