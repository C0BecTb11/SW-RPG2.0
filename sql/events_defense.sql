-- Ивенты обороны (PvE): «Оборона аванпоста «Тессара»» (Республика) и «Завод под осадой» (КНС).
-- Сценарий — shared/rt-events.js (Defense), карты — tools/events/maps.js (tessara, tessara_pass, vex, vex_slag).
--
-- * Пара: PvE-ивент одной стороны выпадает в паре с ивентом другой (event_catalog.pair). Ивент дня
--   хранится один (event_days — «ведущий» из пары, id меньше), игрок видит ивент своей стороны
--   (event_today_for). Так в день обороны обе стороны играют, каждая свою.
-- * Против бота ботов звать не нужно: сбор начинается сам (минимум роли — один игрок, через 30 с
--   или сразу при полном составе). Кнопка «С ботами» в PvE не показывается.
-- * Тест администрации: в PvE p_bots — сколько всего в гарнизоне (ты + боты-союзники).

alter table public.event_catalog add column if not exists pair text references public.event_catalog(id);

update public.event_catalog set
  troops = 'event', ready = true,
  roles = '[{"id":"defender","side":"republic","min":1,"max":4,"name":"Гарнизон"}]',
  maps = '{tessara,tessara_pass}', minutes = '{10,15,21}', reward_cr = 420, reward_res = '{"durasteel":40}',
  titles = '{"defender":"Щит Тессары"}', pair = 'c_siege'
 where id = 'r_tessara';
update public.event_catalog set
  troops = 'event', ready = true,
  roles = '[{"id":"defender","side":"cis","min":1,"max":4,"name":"Гарнизон"}]',
  maps = '{vex,vex_slag}', minutes = '{10,15,21}', reward_cr = 420, reward_res = '{"durasteel":40}',
  titles = '{"defender":"Стальная стена Векса"}', pair = 'r_tessara'
 where id = 'c_siege';

-- Ивент дня: из пары выпадает только «ведущий» (меньший id); пара вчерашнего дня не повторяется
do $$
declare v_def text; v_a text; v_b text;
begin
  v_def := pg_get_functiondef('public.event_day_row(date)'::regprocedure);
  v_a := $q$  select id into v_pick from event_catalog where ready and (v_prev is null or id <> v_prev or (select count(*) from event_catalog where ready) = 1)$q$;
  v_b := $q$  select id into v_pick from event_catalog where ready and (pair is null or id < pair or not exists (select 1 from event_catalog p where p.id = event_catalog.pair and p.ready))
     and (v_prev is null or (id <> v_prev and pair is distinct from v_prev) or (select count(*) from event_catalog where ready and (pair is null or id < pair)) = 1)$q$;
  if position('pair is null or id < pair' in v_def) = 0 then
    if position(v_a in v_def) = 0 then raise exception 'event_day_row: нет якоря'; end if;
    execute replace(v_def, v_a, v_b);
  end if;
end $$;

-- Сегодня для стороны: если ивент дня не её, а у него есть пара её стороны — пара
create or replace function public.event_today_for(p_side text)
 returns jsonb language plpgsql security definer set search_path to 'public', 'pg_temp'
as $function$
declare t jsonb := event_today(); e record;
begin
  if t->>'event' is null or p_side is null then return t; end if;
  select id, sides, pair into e from event_catalog where id = t->>'event';
  if e.id is not null and not (p_side = any(e.sides)) and e.pair is not null
     and exists (select 1 from event_catalog p where p.id = e.pair and p.ready and p_side = any(p.sides)) then
    t := t || jsonb_build_object('event', e.pair, 'pair_of', e.id);
  end if;
  return t;
end;
$function$;
revoke all on function public.event_today_for(text) from public, anon, authenticated;

-- event_status / event_list / event_join — ивент дня своей стороны; event_status — «С ботами» только в PvP
do $$
declare f text; v_def text; v_a text := 'v_today := event_today();'; v_b text := 'v_today := event_today_for((select faction from profiles where id = v_me));';
begin
  foreach f in array array['event_status()', 'event_list()', 'event_join(text, integer, text)'] loop
    v_def := pg_get_functiondef(('public.' || f)::regprocedure);
    if position(v_b in v_def) = 0 then
      if position(v_a in v_def) = 0 then raise exception '%: нет якоря', f; end if;
      execute replace(v_def, v_a, v_b);
    end if;
  end loop;

  v_def := pg_get_functiondef('public.event_status()'::regprocedure);
  v_a := $q$v_bots_in := greatest(0, event_setting_int('event_bots_after_seconds', 180) - extract(epoch from now() - q.joined_at)::integer);$q$;
  v_b := $q$v_bots_in := case when e.kind = 'pvp' then greatest(0, event_setting_int('event_bots_after_seconds', 180) - extract(epoch from now() - q.joined_at)::integer) end;$q$;
  if position(v_b in v_def) = 0 then
    if position(v_a in v_def) = 0 then raise exception 'event_status: нет якоря ботов'; end if;
    execute replace(v_def, v_a, v_b);
  end if;

  v_def := pg_get_functiondef('public.event_bots()'::regprocedure);
  v_a := $q$  if q.call_id is not null then raise exception 'Сбор уже идёт'; end if;$q$;
  v_b := $q$  if q.call_id is not null then raise exception 'Сбор уже идёт'; end if;
  if (select kind from event_catalog where id = q.event_id) = 'pve' then raise exception 'Против бота сбор начнётся сам — соперник не нужен'; end if;$q$;
  if position('соперник не нужен' in v_def) = 0 then
    if position(v_a in v_def) = 0 then raise exception 'event_bots: нет якоря'; end if;
    execute replace(v_def, v_a, v_b);
  end if;

  -- тест администрации: в PvE p_bots — размер гарнизона (ты + боты-союзники)
  v_def := pg_get_functiondef('public.dev_event_start(text, integer, text, text, integer)'::regprocedure);
  v_a := $q$      n := (r->>'min')::integer - 1;$q$;
  v_b := $q$      n := greatest((r->>'min')::integer - 1, case when e.kind = 'pve' then least((r->>'max')::integer, coalesce(p_bots, 1)) - 1 else 0 end);$q$;
  if position('e.kind = ''pve''' in v_def) = 0 then
    if position(v_a in v_def) = 0 then raise exception 'dev_event_start: нет якоря'; end if;
    execute replace(v_def, v_a, v_b);
  end if;
end $$;
