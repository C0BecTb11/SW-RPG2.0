-- Журнал ошибок сервера: база, pg_cron и сервер боёв в одном месте (DEV → «Ошибки» → «Сервер»).
-- Ошибки у игроков (браузер) — отдельно, sql/client_errors.sql.
--
-- Источники (server_errors.source):
--   db   — исключения, которые функции базы ловят и глотают, чтобы не сорвать такт
--          (exception when others → err_db). Раньше они пропадали бесследно: raise warning
--          видно только в логах Postgres, а «then null» не видно нигде.
--   cron — задания pg_cron, упавшие целиком (cron.job_run_details, status = 'failed').
--   rt   — сервер боёв: строки rt_server_log уровня error, падение процесса (перезапуск без
--          «остановки») и молчание дольше 3 минут.
--
-- Одинаковые ошибки склеиваются по подписи sig = md5(источник|место|текст без чисел и id):
-- растёт счётчик n, хранится последний текст и данные. Подписей не больше 3000.
-- Пишет только сервер (err_log — security definer, у игроков права нет); читать и отмечать
-- «исправлено» — админы DEV (dev_assert).
--
-- Важно: запись идёт в той же транзакции. Если вся транзакция откатилась (ошибка дошла до
-- игрока), строки здесь не будет — такие ловит браузер (js/supabase-client.js → client_errors,
-- место «rpc:имя») или сервер боёв (rt).
--
-- Встраивание в старые функции — DO-блоком по тексту (раздел внизу). Если старый файл
-- с такой функцией прогнать заново, вставка пропадёт — тогда прогнать и этот блок ещё раз.

create table if not exists public.server_errors (
  sig         text primary key,
  source      text not null,                 -- db / cron / rt
  ctx         text,                          -- функция, задание cron, событие сервера боёв
  msg         text not null,
  state       text,                          -- SQLSTATE
  data        jsonb,
  n           integer not null default 1,
  first_at    timestamptz not null default now(),
  last_at     timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid
);
create index if not exists server_errors_last_at on public.server_errors (last_at desc);
alter table public.server_errors enable row level security;
revoke all on public.server_errors from anon, authenticated;

-- Курсор разбора: последнее разобранное задание cron и строка журнала сервера боёв
create table if not exists public.server_error_scan (
  id      integer primary key default 1 check (id = 1),
  cron_runid bigint not null default 0,
  rt_at   timestamptz not null default now(),
  rt_down_at timestamptz
);
alter table public.server_error_scan enable row level security;
revoke all on public.server_error_scan from anon, authenticated;
insert into public.server_error_scan (id, cron_runid, rt_at)
values (1, coalesce((select max(runid) from cron.job_run_details), 0), now())
on conflict (id) do nothing;

-- Записать ошибку. Никогда не бросает исключений: сбой журнала не должен ронять то, что он сторожит.
create or replace function public.err_log(p_source text, p_ctx text, p_msg text, p_state text default null, p_data jsonb default null)
 returns void language plpgsql security definer set search_path to 'public', 'pg_temp'
as $function$
declare v_msg text; v_ctx text; v_sig text;
begin
  v_msg := left(coalesce(nullif(btrim(p_msg), ''), '(без текста)'), 1000);
  v_ctx := left(p_ctx, 120);
  -- в подпись — текст без id, чисел и значений в кавычках: одна ошибка с разными данными — одна строка
  v_sig := md5(coalesce(p_source, '') || '|' || coalesce(v_ctx, '') || '|' ||
               regexp_replace(regexp_replace(regexp_replace(v_msg,
                 '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', '‹id›', 'gi'),
                 '"[^"]*"', '"…"', 'g'),
                 '[0-9]+', '#', 'g'));
  if not exists (select 1 from server_errors where sig = v_sig)
     and (select count(*) from server_errors) >= 3000 then return; end if;
  insert into server_errors as e (sig, source, ctx, msg, state, data)
  values (v_sig, left(p_source, 16), v_ctx, v_msg, left(p_state, 8), p_data)
  on conflict (sig) do update
     set n = least(e.n + 1, 2000000000), last_at = now(), msg = excluded.msg,
         state = coalesce(excluded.state, e.state), data = coalesce(excluded.data, e.data);
exception when others then
  null;   -- журнал молчит сам
end;
$function$;

-- Из обработчика исключений функции базы: exception when others then perform err_db('имя', sqlstate, sqlerrm, …)
--   p_all = true  — записать любую ошибку (такты: выплаты, NPC, поставки…);
--   p_all = false — только неожиданные: «raise exception» с текстом для игрока (P0001) — это отказ, а не сбой.
-- Блокировки и конфликты сериализации (их повторяют) не пишем.
create or replace function public.err_db(p_fn text, p_state text, p_msg text, p_all boolean default true)
 returns void language plpgsql security definer set search_path to 'public', 'pg_temp'
as $function$
begin
  if p_state in ('40P01', '40001', '55P03') then return; end if;
  if not coalesce(p_all, true) and p_state = 'P0001' then return; end if;
  perform err_log('db', p_fn, p_msg, p_state, null);
end;
$function$;

-- Каждые 5 минут: упавшие задания cron, ошибки и падения сервера боёв, его молчание
create or replace function public.err_scan()
 returns integer language plpgsql security definer set search_path to 'public', 'pg_temp'
as $function$
declare s record; r record; v_max bigint; v_at timestamptz; v_n integer := 0; v_seen timestamptz; v_prev text;
begin
  if not pg_try_advisory_xact_lock(hashtext('err_scan')) then return 0; end if;
  select * into s from server_error_scan where id = 1 for update;

  -- pg_cron: задания, упавшие целиком
  select coalesce(max(runid), s.cron_runid) into v_max from cron.job_run_details where runid > s.cron_runid;
  for r in
    select j.jobname, d.return_message, d.start_time
      from cron.job_run_details d left join cron.job j on j.jobid = d.jobid
     where d.runid > s.cron_runid and d.runid <= v_max and d.status = 'failed'
     order by d.runid limit 500
  loop
    perform err_log('cron', coalesce(r.jobname, 'cron'), coalesce(r.return_message, 'задание упало'), null,
                    jsonb_build_object('at', r.start_time));
    v_n := v_n + 1;
  end loop;

  -- сервер боёв: ошибки из журнала и перезапуск без «остановки» (процесс упал)
  select coalesce(max(at), s.rt_at) into v_at from rt_server_log where at > s.rt_at;
  for r in
    select l.at, l.level, l.msg, l.data from rt_server_log l
     where l.at > s.rt_at and l.at <= v_at
       and (l.level = 'error' or l.msg like 'журнал: пропущено%' or l.msg = 'сервер запущен')
     order by l.at limit 2000
  loop
    if r.msg = 'сервер запущен' then
      select p.msg into v_prev from rt_server_log p where p.at < r.at and p.at > r.at - interval '2 hours'
       order by p.at desc limit 1;
      if v_prev is not null and v_prev not like 'остановка%' then
        perform err_log('rt', 'перезапуск', 'Сервер боёв перезапустился без остановки — процесс упал', null,
                        jsonb_build_object('at', r.at, 'before', v_prev));
        v_n := v_n + 1;
      end if;
      continue;
    end if;
    perform err_log('rt', r.msg, coalesce(r.data ->> 'err', r.data ->> 'error', r.msg), null, r.data);
    v_n := v_n + 1;
  end loop;

  -- сервер боёв молчит (сердцебиение — каждые 20 с): одна запись на каждое пропадание
  select max(seen_at) into v_seen from rt_servers where id = 'main';
  if v_seen is not null and v_seen < now() - interval '3 minutes' then
    if s.rt_down_at is null or s.rt_down_at < v_seen then
      perform err_log('rt', 'нет связи', 'Сервер боёв не на связи с базой больше 3 минут', null,
                      jsonb_build_object('seen_at', v_seen));
      update server_error_scan set rt_down_at = now() where id = 1;
      v_n := v_n + 1;
    end if;
  end if;

  update server_error_scan set cron_runid = v_max, rt_at = v_at where id = 1;
  return v_n;
end;
$function$;

-- ---- DEV: список (p_open = true — открытые и повторившиеся после отметки)
create or replace function public.dev_server_errors(p_open boolean default true, p_limit integer default 60)
 returns jsonb language plpgsql stable security definer set search_path to 'public', 'pg_temp'
as $function$
declare v jsonb;
begin
  perform dev_assert();
  select coalesce(jsonb_agg(x order by x.last_at desc), '[]'::jsonb) into v from (
    select e.sig, e.source, e.ctx, e.msg, e.state, e.data, e.n, e.first_at, e.last_at, e.resolved_at,
           (e.resolved_at is not null and e.last_at > e.resolved_at) as again
      from server_errors e
     where not coalesce(p_open, true) or e.resolved_at is null or e.last_at > e.resolved_at
     order by e.last_at desc
     limit least(greatest(coalesce(p_limit, 60), 1), 200)) x;
  return jsonb_build_object(
    'rows', v,
    'open', (select count(*) from server_errors e where e.resolved_at is null or e.last_at > e.resolved_at),
    'day', (select count(*) from server_errors e where e.last_at > now() - interval '24 hours'),
    'total', (select count(*) from server_errors));
end;
$function$;

-- ---- DEV: отметить исправленной (p_sig = null — все открытые)
create or replace function public.dev_server_error_resolve(p_sig text)
 returns integer language plpgsql security definer set search_path to 'public', 'pg_temp'
as $function$
declare v_me uuid := dev_assert(); v_n integer;
begin
  update server_errors set resolved_at = now(), resolved_by = v_me
   where (p_sig is null and (resolved_at is null or last_at > resolved_at)) or sig = p_sig;
  get diagnostics v_n = row_count;
  perform dev_note(v_me, 'errors_resolved', null, null, jsonb_build_object('n', v_n, 'server', true));
  return v_n;
end;
$function$;

-- ---- DEV: сколько открыто у игроков и на сервере (счётчик на вкладке)
create or replace function public.dev_error_counts()
 returns jsonb language plpgsql stable security definer set search_path to 'public', 'pg_temp'
as $function$
begin
  perform dev_assert();
  return jsonb_build_object(
    'client', (select count(*) from client_errors c where c.resolved_at is null or c.last_at > c.resolved_at),
    'server', (select count(*) from server_errors e where e.resolved_at is null or e.last_at > e.resolved_at));
end;
$function$;

revoke execute on function public.err_log(text, text, text, text, jsonb) from public, anon, authenticated;
revoke execute on function public.err_db(text, text, text, boolean) from public, anon, authenticated;
revoke execute on function public.err_scan() from public, anon, authenticated;
revoke execute on function public.dev_server_errors(boolean, integer) from public, anon;
revoke execute on function public.dev_server_error_resolve(text) from public, anon;
revoke execute on function public.dev_error_counts() from public, anon;
grant execute on function public.dev_server_errors(boolean, integer) to authenticated;
grant execute on function public.dev_server_error_resolve(text) to authenticated;
grant execute on function public.dev_error_counts() to authenticated;

-- ---- pg_cron: разбор раз в 5 минут
do $do$
begin
  if not exists (select 1 from cron.job where jobname = 'err-scan') then
    perform cron.schedule('err-scan', '*/5 * * * *', 'select public.err_scan()');
  end if;
end $do$;

-- ---- Встраивание в обработчики «exception when others then» старых функций
-- Сразу после «then» встаёт perform err_db('имя', sqlstate, sqlerrm, режим). Режим:
--   true  — такты и фоновые задачи: любая проглоченная ошибка — сбой;
--   false — обработчик здесь нарочно превращает отказ в «нельзя» (ход NPC, автодвижение,
--           перелёт по маршруту): пишем только неожиданные ошибки, не текст для игрока (P0001).
-- supply_normalize_stops не трогаем: там обработчик — проверка ввода игрока (не число).
-- Уже встроено — пропуск; функция не нашлась — пропуск (её могли переименовать).
do $do$
declare
  m record; d text; v_new text; v_cnt integer;
begin
  for m in
    select * from (values
      ('public.capture_tick()', true),
      ('public.settlement_tick()', true),
      ('public.finish_scout_moves()', true),
      ('public.npc_tick()', true),
      ('public.automove_tick()', true),
      ('public.start_auto_move(text, uuid[], integer, integer)', true),
      ('public.supply_tick()', true),
      ('public.marauder_alarm(uuid, text, text, integer, integer, integer, integer)', true),
      ('public.settle_due_orders()', true),
      ('public.boarding_tick()', true),
      ('public.report_apply(uuid, integer, boolean)', true),
      ('public.ge_start(text, boolean)', true),
      ('public.riot_tick()', true),
      ('public.convoy_jump(uuid, text)', false),
      ('public.convoy_load_order(uuid)', false),
      ('public.npc_ready(uuid)', false),
      ('public.npc_spend(uuid)', false),
      ('public.automove_step(uuid)', false),
      ('public.supply_route_step(uuid)', false),
      ('public.commander_route_continue(uuid)', false),
      ('public.hero_hire_check(uuid)', false)
    ) t(sig, all_)
  loop
    continue when to_regprocedure(m.sig) is null;
    d := pg_get_functiondef(m.sig::regprocedure);
    continue when position('err_db(' in d) > 0;
    v_new := regexp_replace(d, '(exception\s+when\s+others\s+then)',
               '\1 perform err_db(''' || split_part(split_part(m.sig, '.', 2), '(', 1) || ''', sqlstate, sqlerrm, ' || m.all_ || ');',
               'gi');
    select count(*) into v_cnt from regexp_matches(v_new, 'perform err_db\(', 'g');
    if v_cnt = 0 then raise exception '%: обработчик не найден', m.sig; end if;
    execute v_new;
  end loop;
end $do$;

