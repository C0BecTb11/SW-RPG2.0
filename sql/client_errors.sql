-- Ошибки у игроков (PR «журнал ошибок»).
--
-- Браузер ловит падения скриптов (js/err-report.js) и шлёт их сюда пачкой.
-- Одинаковые ошибки склеиваются по подписи sig = md5(текст|файл?v|строка|столбец):
-- растёт счётчик n и число разных игроков users. Исправленный файл получает новый ?v=,
-- поэтому его ошибки — уже другая подпись, а старая показывает, что кто-то сидит на
-- закэшированной версии.
--
-- Защита:
--   * таблицы закрыты (RLS без политик, права anon/authenticated сняты);
--   * писать можно только через report_client_errors: только вошедшим, не больше
--     10 строк за вызов и 40 за 10 минут на игрока, поля обрезаются, всего
--     подписей не больше 3000 — база не раздуется, даже если клиент сломан или подделан;
--   * читать и отмечать «исправлено» — только админам DEV (dev_assert).

create table if not exists public.client_errors (
  sig text primary key,
  msg text not null,
  src text,
  line integer,
  col integer,
  stack text,
  page text,
  ctx text,
  ua text,
  n integer not null default 1,
  users integer not null default 1,
  first_at timestamptz not null default now(),
  last_at timestamptz not null default now(),
  last_user uuid,
  resolved_at timestamptz,
  resolved_by uuid
);
create index if not exists client_errors_last_at on public.client_errors (last_at desc);
alter table public.client_errors enable row level security;
revoke all on public.client_errors from anon, authenticated;

create table if not exists public.client_error_users (
  sig text not null,
  user_id uuid not null,
  primary key (sig, user_id)
);
alter table public.client_error_users enable row level security;
revoke all on public.client_error_users from anon, authenticated;

create table if not exists public.client_error_rate (
  user_id uuid primary key,
  win timestamptz not null default now(),
  n integer not null default 0
);
alter table public.client_error_rate enable row level security;
revoke all on public.client_error_rate from anon, authenticated;

-- ---- приём от браузера
create or replace function public.report_client_errors(p_items jsonb)
returns integer
language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  v_me uuid := auth.uid();
  v_n integer; v_acc integer := 0;
  it jsonb; v_msg text; v_src text; v_line integer; v_col integer; v_cnt integer; v_sig text;
begin
  if v_me is null or p_items is null or jsonb_typeof(p_items) <> 'array' then return 0; end if;

  -- окно 10 минут на игрока
  insert into client_error_rate as r (user_id, win, n) values (v_me, now(), 0)
  on conflict (user_id) do update
     set win = case when r.win < now() - interval '10 minutes' then now() else r.win end,
         n   = case when r.win < now() - interval '10 minutes' then 0 else r.n end
  returning n into v_n;
  if v_n >= 40 then return 0; end if;

  for it in select e from jsonb_array_elements(p_items) with ordinality q(e, o) where o <= 10 loop
    exit when v_n >= 40;
    continue when jsonb_typeof(it) <> 'object' or coalesce(btrim(it ->> 'msg'), '') = '';
    v_msg  := left(btrim(it ->> 'msg'), 500);
    v_src  := left(nullif(it ->> 'src', ''), 300);
    v_line := case when (it ->> 'line') ~ '^\d{1,7}$' then (it ->> 'line')::integer end;
    v_col  := case when (it ->> 'col') ~ '^\d{1,7}$' then (it ->> 'col')::integer end;
    v_cnt  := least(greatest(case when (it ->> 'n') ~ '^\d{1,7}$' then (it ->> 'n')::integer else 1 end, 1), 10000);
    v_sig  := md5(v_msg || '|' || coalesce(v_src, '') || '|' || coalesce(v_line::text, '') || '|' || coalesce(v_col::text, ''));

    if not exists (select 1 from client_errors where sig = v_sig)
       and (select count(*) from client_errors) >= 3000 then
      continue;
    end if;

    insert into client_errors as c (sig, msg, src, line, col, stack, page, ctx, ua, n, last_user)
    values (v_sig, v_msg, v_src, v_line, v_col,
            left(nullif(it ->> 'stack', ''), 4000), left(nullif(it ->> 'page', ''), 200),
            left(nullif(it ->> 'ctx', ''), 60), left(nullif(it ->> 'ua', ''), 300), v_cnt, v_me)
    on conflict (sig) do update
       set n = least(c.n + excluded.n, 2000000000), last_at = now(), last_user = v_me,
           stack = coalesce(excluded.stack, c.stack), page = coalesce(excluded.page, c.page),
           ctx = coalesce(excluded.ctx, c.ctx), ua = coalesce(excluded.ua, c.ua);

    insert into client_error_users (sig, user_id) values (v_sig, v_me) on conflict do nothing;
    if found then
      update client_errors set users = (select count(*) from client_error_users u where u.sig = v_sig) where sig = v_sig;
    end if;

    v_n := v_n + 1; v_acc := v_acc + 1;
  end loop;

  update client_error_rate set n = v_n where user_id = v_me;
  return v_acc;
end;
$$;

-- ---- DEV: список
-- p_open = true — только неотмеченные и те, что повторились после отметки
create or replace function public.dev_client_errors(p_open boolean default true, p_limit integer default 60)
returns jsonb
language plpgsql stable security definer set search_path to 'public', 'pg_temp' as $$
declare v jsonb;
begin
  perform dev_assert();
  select coalesce(jsonb_agg(x order by x.last_at desc), '[]'::jsonb) into v from (
    select c.sig, c.msg, c.src, c.line, c.col, c.stack, c.page, c.ctx, c.ua, c.n, c.users,
           c.first_at, c.last_at, c.resolved_at, p.nickname as last_nick,
           (c.resolved_at is not null and c.last_at > c.resolved_at) as again
      from client_errors c left join profiles p on p.id = c.last_user
     where not coalesce(p_open, true) or c.resolved_at is null or c.last_at > c.resolved_at
     order by c.last_at desc
     limit least(greatest(coalesce(p_limit, 60), 1), 200)
  ) x;
  return jsonb_build_object(
    'rows', v,
    'open', (select count(*) from client_errors c where c.resolved_at is null or c.last_at > c.resolved_at),
    'day',  (select count(*) from client_errors c where c.last_at > now() - interval '24 hours'),
    'total', (select count(*) from client_errors));
end;
$$;

-- ---- DEV: отметить исправленной (p_sig = null — все открытые)
create or replace function public.dev_client_error_resolve(p_sig text)
returns integer
language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare v_me uuid := dev_assert(); v_n integer;
begin
  update client_errors set resolved_at = now(), resolved_by = v_me
   where (p_sig is null and (resolved_at is null or last_at > resolved_at)) or sig = p_sig;
  get diagnostics v_n = row_count;
  perform dev_note(v_me, 'errors_resolved', null, null, jsonb_build_object('n', v_n));
  return v_n;
end;
$$;

do $$
declare f text;
begin
  foreach f in array array['report_client_errors(jsonb)', 'dev_client_errors(boolean, integer)', 'dev_client_error_resolve(text)']
  loop execute format('revoke all on function public.%s from public, anon, authenticated', f); end loop;
  foreach f in array array['report_client_errors(jsonb)', 'dev_client_errors(boolean, integer)', 'dev_client_error_resolve(text)']
  loop execute format('grant execute on function public.%s to authenticated', f); end loop;
end $$;
