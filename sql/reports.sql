-- Донесения с выбором и слой эффектов (план — claude/mechanics-plan.md, этап 2).
--
-- * report_catalog — каталог (заполняет sql/reports_catalog.sql, собранный tools/reports/build.js).
-- * player_reports — донесения игроков: 2 в сутки на игрока, у которого есть своя планета и кто заходил
--   за последние 3 дня; приходят в 10–22 по серверу; на ответ 12 часов, без ответа — вариант по умолчанию.
-- * active_effects — временные эффекты на планете: mood (очки довольства, строка «События»),
--   extract (% добычи), income (% дохода поселения). Сумма по виду ограничена: довольство ±30, проценты ±50.
-- * Встраивание в старое (правка тел функций заменой строки — см. конец файла):
--   production_tick — добыча × эффект extract; settlement_day_income — доход × эффект income;
--   settlement_factors — строка «События» с эффектом mood.
-- Таблицы закрыты; игроку — report_list / report_choose / report_badge; администрации — dev_report_send.

-- ---------------------------------------------------------------- настройки
insert into public.game_settings (key, value) values
  ('report_per_day', '2'), ('report_start_hour', '10'), ('report_end_hour', '22'), ('report_answer_hours', '12'), ('report_seen_days', '3')
on conflict (key) do nothing;

-- ---------------------------------------------------------------- таблицы
create table if not exists public.report_catalog (
  id text primary key,
  side text not null check (side in ('republic', 'cis')),
  cat text not null,
  chain boolean not null default false,
  w integer not null default 1,
  def integer not null default 0,
  data jsonb not null,
  active boolean not null default true
);
create table if not exists public.player_reports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  report_id text not null references public.report_catalog(id),
  system_id text not null,
  day date not null,
  slot integer,                                   -- номер донесения дня (0, 1…); у продолжений — null
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  status text not null default 'new' check (status in ('new', 'done', 'expired')),
  choice integer,
  auto boolean not null default false,
  outcome jsonb,
  resolved_at timestamptz,
  next_id text,
  next_at timestamptz,
  next_sent boolean not null default false
);
create index if not exists player_reports_user on public.player_reports (user_id, status, created_at desc);
create index if not exists player_reports_due on public.player_reports (status, expires_at);
create index if not exists player_reports_next on public.player_reports (next_at) where next_id is not null and not next_sent;
create table if not exists public.active_effects (
  id bigserial primary key,
  system_id text not null,
  kind text not null check (kind in ('mood', 'extract', 'income')),
  value integer not null,
  title text,
  source text not null default 'report',
  source_id uuid,
  user_id uuid,
  starts_at timestamptz not null default now(),
  ends_at timestamptz not null
);
create index if not exists active_effects_sys on public.active_effects (system_id, kind, ends_at);

alter table public.report_catalog enable row level security;
alter table public.player_reports enable row level security;
alter table public.active_effects enable row level security;
revoke all on public.report_catalog, public.player_reports, public.active_effects from anon, authenticated;
revoke all on sequence public.active_effects_id_seq from anon, authenticated;

insert into public.event_types (type, category, title, tone, jumpable) values
  ('report_new', 'build', 'Донесение', 'neutral', false),
  ('report_result', 'build', 'Исход донесения', 'neutral', false)
on conflict (type) do update set jumpable = excluded.jumpable;   -- в ленте — «Ответить», а не прыжок к планете

-- ---------------------------------------------------------------- эффекты
create or replace function public.effect_sum(p_system text, p_kind text)
 returns integer language sql stable security definer set search_path to 'public', 'pg_temp'
as $function$
  select greatest(case when p_kind = 'mood' then -30 else -50 end, least(case when p_kind = 'mood' then 30 else 50 end,
         coalesce((select sum(value) from active_effects where system_id = p_system and kind = p_kind and starts_at <= now() and ends_at > now()), 0)))::integer;
$function$;

-- Свой боец на планете — без случайности подарка поселения
create or replace function public.report_gift(p_system text, p_user uuid, p_vehicle boolean)
 returns uuid language plpgsql security definer set search_path to 'public', 'pg_temp'
as $function$
declare v_faction text; v_type record; z record; cx integer; cy integer; tries integer := 0; v_id uuid;
begin
  select faction into v_faction from profiles where id = p_user;
  if v_faction is null then return null; end if;
  select * into v_type from unit_types where faction = v_faction and is_vehicle = coalesce(p_vehicle, false) and produced_by is not null order by random() limit 1;
  if not found then return null; end if;
  select * into z from settlement_zone_box();
  while tries < 80 loop
    tries := tries + 1;
    cx := z.x - 4 + floor(random() * (z.size + 8))::integer;
    cy := z.y - 4 + floor(random() * (z.size + 8))::integer;
    continue when not is_ground_box_free(p_system, cx, cy, v_type.width_cells, v_type.height_cells, null);
    insert into unit_positions (system_id, layer, x, y, owner_user_id, faction, unit_type, quantity, hp)
    values (p_system, 'ground', cx, cy, p_user, v_faction, v_type.id, 1, v_type.max_hp) returning id into v_id;
    return v_id;
  end loop;
  return null;
end;
$function$;

-- ---------------------------------------------------------------- выдача
create or replace function public.report_deliver(p_user uuid, p_report text, p_system text, p_slot integer)
 returns uuid language plpgsql security definer set search_path to 'public', 'pg_temp'
as $function$
declare c report_catalog; v_id uuid; v_fac text;
begin
  select * into c from report_catalog where id = p_report;
  if not found then return null; end if;
  select faction into v_fac from profiles where id = p_user;
  insert into player_reports (user_id, report_id, system_id, day, slot, expires_at)
  values (p_user, p_report, p_system, (now() at time zone event_tz())::date, p_slot,
          now() + make_interval(hours => event_setting_int('report_answer_hours', 12)))
  returning id into v_id;
  perform log_event(p_user, v_fac, p_system, 'report_new', c.data->>'title', 1, 'private', jsonb_build_object('report', v_id));
  return v_id;
end;
$function$;

-- Случайное донесение стороны: не продолжение, не приходившее этому игроку последние 14 дней
create or replace function public.report_pick(p_user uuid, p_side text)
 returns text language sql stable security definer set search_path to 'public', 'pg_temp'
as $function$
  select c.id from report_catalog c
  where c.side = p_side and c.active and not c.chain
    and not exists (select 1 from player_reports r where r.user_id = p_user and r.report_id = c.id and r.created_at > now() - interval '14 days')
  order by -ln(random()) / greatest(c.w, 1) limit 1;
$function$;

-- ---------------------------------------------------------------- исход
-- Применить вариант: бросок по весам, эффекты, кредиты, склад, банда, подарок, продолжение.
create or replace function public.report_apply(p_id uuid, p_choice integer, p_auto boolean)
 returns jsonb language plpgsql security definer set search_path to 'public', 'pg_temp'
as $function$
declare
  r player_reports; c report_catalog; o jsonb; u jsonb; fx jsonb; v_tot numeric := 0; v_roll numeric; v_i integer := 0; v_pick integer := 0; k text; v_n integer;
  v_got jsonb := '{}'::jsonb; v_title text; v_fac text; v_have integer; v_take integer; v_res jsonb := '{}'::jsonb; v_cr integer := 0; v_unit uuid;
begin
  select * into r from player_reports where id = p_id for update;
  if not found or r.status <> 'new' then return null; end if;
  select * into c from report_catalog where id = r.report_id;
  o := c.data->'opts'->p_choice;
  if o is null then raise exception 'Нет такого варианта'; end if;
  select faction into v_fac from profiles where id = r.user_id;
  -- планета уже не своя: донесение закрывается без последствий (чужой склад и поселение не трогаем)
  if not exists (select 1 from system_control where system_id = r.system_id and controller_user_id = r.user_id) then
    u := jsonb_build_object('i', -1, 'text', 'Планета больше не под нашим контролем — донесение потеряло смысл.', 'got', '{}'::jsonb, 'lost', true);
    update player_reports set status = 'expired', choice = null, auto = true, resolved_at = now(), outcome = u where id = r.id;
    perform log_event(r.user_id, v_fac, r.system_id, 'report_result', (c.data->>'title') || ': планета потеряна', 1, 'private', jsonb_build_object('report', r.id, 'auto', true));
    return u || jsonb_build_object('next', false);
  end if;
  for u in select * from jsonb_array_elements(o->'outs') loop v_tot := v_tot + (u->>'p')::numeric; end loop;
  v_roll := random() * v_tot;
  for u in select * from jsonb_array_elements(o->'outs') loop
    v_roll := v_roll - (u->>'p')::numeric;
    if v_roll < 0 then v_pick := v_i; exit; end if;
    v_i := v_i + 1;
    v_pick := v_i;
  end loop;
  v_pick := least(v_pick, jsonb_array_length(o->'outs') - 1);
  u := o->'outs'->v_pick; fx := coalesce(u->'fx', '{}'::jsonb);
  v_title := (c.data->>'title') || ' · ' || (o->>'label');
  -- эффекты на планете
  foreach k in array array['mood', 'extract', 'income'] loop
    if fx ? k then
      insert into active_effects (system_id, kind, value, title, source, source_id, user_id, ends_at)
      values (r.system_id, k, (fx->k->>0)::integer, v_title, 'report', r.id, r.user_id, now() + make_interval(hours => (fx->k->>1)::integer));
      v_got := v_got || jsonb_build_object(k, fx->k);
    end if;
  end loop;
  -- кредиты (в минус не уходят)
  if fx ? 'cr' then
    v_n := (fx->>'cr')::integer;
    if v_n < 0 then select greatest(-credits, v_n) into v_n from profiles where id = r.user_id; end if;
    update profiles set credits = credits + v_n where id = r.user_id;
    v_cr := v_n; v_got := v_got || jsonb_build_object('cr', v_n);
  end if;
  -- склад планеты: прибавка — сколько влезло, убыль — сколько было
  if fx ? 'res' then
    for k, v_n in select key, value::integer from jsonb_each_text(fx->'res') loop
      if v_n > 0 then v_take := add_planet_stock(r.system_id, k, v_n);
      else
        select coalesce(amount, 0) into v_have from planet_stock where system_id = r.system_id and resource = k;
        v_take := least(coalesce(v_have, 0), -v_n);
        if v_take > 0 then perform take_planet_stock(r.system_id, k, v_take); end if;
        v_take := -v_take;
      end if;
      if v_take <> 0 then v_res := v_res || jsonb_build_object(k, v_take); end if;
    end loop;
    if v_res <> '{}'::jsonb then v_got := v_got || jsonb_build_object('res', v_res); end if;
  end if;
  if fx ? 'raid' then
    begin perform spawn_marauder_gang(r.system_id, (fx->>'raid')::integer); v_got := v_got || jsonb_build_object('raid', (fx->>'raid')::integer);
    exception when others then null; end;
  end if;
  if fx ? 'gift' then
    begin v_unit := report_gift(r.system_id, r.user_id, fx->>'gift' = 'veh'); if v_unit is not null then v_got := v_got || jsonb_build_object('gift', fx->>'gift'); end if;
    exception when others then null; end;
  end if;
  update player_reports set status = case when p_auto then 'expired' else 'done' end, choice = p_choice, auto = p_auto, resolved_at = now(),
         outcome = jsonb_build_object('i', v_pick, 'text', u->>'text', 'got', v_got),
         next_id = fx->>'next', next_at = case when fx ? 'next' then now() + make_interval(hours => 20 + floor(random() * 8)::integer) end
   where id = r.id;
  perform log_event(r.user_id, v_fac, r.system_id, 'report_result', (c.data->>'title') || ': ' || left(u->>'text', 80), 1, 'private', jsonb_build_object('report', r.id, 'auto', p_auto));
  return jsonb_build_object('i', v_pick, 'text', u->>'text', 'got', v_got, 'next', fx ? 'next');
end;
$function$;

-- ---------------------------------------------------------------- такт (pg_cron, раз в 10 минут)
create or replace function public.report_tick()
 returns integer language plpgsql security definer set search_path to 'public', 'pg_temp'
as $function$
declare
  tz text := event_tz(); v_now timestamptz := now(); v_day date := (now() at time zone event_tz())::date; r record; p record;
  v_start integer := event_setting_int('report_start_hour', 10); v_end integer := event_setting_int('report_end_hour', 22);
  v_per integer := greatest(0, least(6, event_setting_int('report_per_day', 2))); v_block numeric; v_k integer; v_due timestamptz; v_sys text; v_pick text; v_n integer := 0;
begin
  if not pg_try_advisory_xact_lock(hashtext('report_tick')) then return 0; end if;
  -- 1) просроченные — вариант по умолчанию
  for r in select pr.id, c.def from player_reports pr join report_catalog c on c.id = pr.report_id where pr.status = 'new' and pr.expires_at <= v_now loop
    perform report_apply(r.id, r.def, true);
  end loop;
  -- 2) продолжения: на ту же планету, если она ещё своя, иначе на любую свою
  for r in select pr.* from player_reports pr where pr.next_id is not null and not pr.next_sent and pr.next_at <= v_now loop
    update player_reports set next_sent = true where id = r.id;
    select coalesce((select system_id from system_control where system_id = r.system_id and controller_user_id = r.user_id),
                    (select system_id from system_control where controller_user_id = r.user_id order by random() limit 1)) into v_sys;
    if v_sys is not null then perform report_deliver(r.user_id, r.next_id, v_sys, null); v_n := v_n + 1; end if;
  end loop;
  -- 3) донесения дня: k-е — после start + k·блок + сдвиг (свой у игрока и дня), до конца окна
  if v_per = 0 then return v_n; end if;
  v_block := (v_end - v_start) * 60.0 / v_per;
  for p in select pf.id, pf.faction from profiles pf
            where pf.faction is not null and pf.last_seen_at > v_now - make_interval(days => event_setting_int('report_seen_days', 3))
              and exists (select 1 from system_control sc where sc.controller_user_id = pf.id) loop
    select count(*) into v_k from player_reports where user_id = p.id and day = v_day and slot is not null;
    continue when v_k >= v_per;
    v_due := ((v_day + make_interval(hours => v_start)) at time zone tz)
             + make_interval(mins => floor(v_k * v_block + abs(hashtext(p.id::text || v_day::text || v_k)) % greatest(1, floor(v_block * 0.6)::integer))::integer);
    continue when v_now < v_due or v_now >= ((v_day + make_interval(hours => v_end)) at time zone tz);
    select system_id into v_sys from system_control where controller_user_id = p.id order by random() limit 1;
    v_pick := report_pick(p.id, p.faction);
    continue when v_pick is null or v_sys is null;
    perform report_deliver(p.id, v_pick, v_sys, v_k);
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$function$;

-- ---------------------------------------------------------------- игроку
create or replace function public.report_badge()
 returns integer language sql stable security definer set search_path to 'public', 'pg_temp'
as $function$
  select count(*)::integer from player_reports where user_id = auth.uid() and status = 'new' and expires_at > now();
$function$;

create or replace function public.report_list()
 returns jsonb language plpgsql security definer set search_path to 'public', 'pg_temp'
as $function$
declare v_me uuid := auth.uid();
begin
  if v_me is null then raise exception 'Нужно войти'; end if;
  return jsonb_build_object(
    'now', now(),
    'per_day', event_setting_int('report_per_day', 2), 'from_h', event_setting_int('report_start_hour', 10),
    'to_h', event_setting_int('report_end_hour', 22), 'answer_h', event_setting_int('report_answer_hours', 12),
    'credits', (select credits from profiles where id = v_me),
    'reports', (select coalesce(jsonb_agg(x order by x->>'status' = 'new' desc, x->>'at' desc), '[]'::jsonb) from (
       select jsonb_build_object('id', r.id, 'report', r.report_id, 'cat', c.cat, 'chain', c.chain, 'status', r.status, 'at', r.created_at, 'expires', r.expires_at,
                'system', r.system_id, 'planet', s.name, 'def', c.def, 'choice', r.choice, 'auto', r.auto, 'outcome', r.outcome, 'resolved', r.resolved_at,
                'next', r.next_id is not null and not r.next_sent,
                -- исходы вариантов игроку не отдаём: видно только цену и риск
                'data', jsonb_build_object('title', c.data->'title', 'text', c.data->'text',
                          'opts', (select jsonb_agg(o - 'outs' order by n) from jsonb_array_elements(c.data->'opts') with ordinality t(o, n))),
                'stock', case when r.status = 'new' then (select coalesce(jsonb_object_agg(ps.resource, ps.amount), '{}'::jsonb) from planet_stock ps where ps.system_id = r.system_id) end) x
       from player_reports r join report_catalog c on c.id = r.report_id left join systems s on s.id = r.system_id
       where r.user_id = v_me and (r.status = 'new' or r.resolved_at > now() - interval '7 days')
       order by r.created_at desc limit 40) q),
    -- эффекты своих планет: донесения и проекты казны фракции (sql/treasury.sql)
    'effects', (select coalesce(jsonb_agg(jsonb_build_object('system', e.system_id, 'planet', s.name, 'kind', e.kind, 'value', e.value, 'title', e.title, 'ends', e.ends_at) order by e.ends_at), '[]'::jsonb)
       from (select system_id, kind, value, title, ends_at from active_effects where ends_at > now() and starts_at <= now()
             union all
             select system_id, kind, value, 'Казна · ' || title, ends_at from faction_effects
              where system_id is not null and kind in ('mood', 'extract', 'income') and ends_at > now() and starts_at <= now()
                and faction = (select faction from profiles where id = v_me)) e
       left join systems s on s.id = e.system_id
       where e.system_id in (select system_id from system_control where controller_user_id = v_me)),
    -- законы фракции (sql/laws.sql) действуют на все её планеты — показываем отдельно
    'laws', (select coalesce(jsonb_agg(jsonb_build_object('kind', fe.kind, 'value', fe.value, 'title', fe.title, 'ends', fe.ends_at, 'decree', fe.source = 'decree') order by fe.ends_at), '[]'::jsonb)
       from faction_effects fe where fe.faction = (select faction from profiles where id = v_me) and fe.starts_at <= now() and fe.ends_at > now()
         and fe.system_id is null and fe.kind in ('mood', 'extract', 'income')),
    'planets', (select coalesce(jsonb_agg(jsonb_build_object('system', sc.system_id, 'planet', s.name,
                  'mood', effect_sum(sc.system_id, 'mood'), 'extract', effect_sum(sc.system_id, 'extract'), 'income', effect_sum(sc.system_id, 'income'))), '[]'::jsonb)
       from system_control sc join systems s on s.id = sc.system_id where sc.controller_user_id = v_me));
end;
$function$;

create or replace function public.report_choose(p_id uuid, p_choice integer)
 returns jsonb language plpgsql security definer set search_path to 'public', 'pg_temp'
as $function$
declare v_me uuid := auth.uid(); r player_reports; c report_catalog; o jsonb; k text; v_n integer; v_have integer; v_res jsonb;
begin
  if v_me is null then raise exception 'Нужно войти'; end if;
  select * into r from player_reports where id = p_id and user_id = v_me for update;
  if not found then raise exception 'Донесение не найдено'; end if;
  if r.status <> 'new' then raise exception 'Решение уже принято'; end if;
  if r.expires_at <= now() then raise exception 'Время на ответ вышло'; end if;
  select * into c from report_catalog where id = r.report_id;
  o := c.data->'opts'->p_choice;
  if o is null then raise exception 'Нет такого варианта'; end if;
  -- планета потеряна — закрыть без цены и последствий
  if not exists (select 1 from system_control where system_id = r.system_id and controller_user_id = v_me) then
    return report_apply(r.id, p_choice, false);
  end if;
  -- цена: кредиты и склад планеты донесения
  if o->'cost' is not null and jsonb_typeof(o->'cost') = 'object' then
    if (o->'cost') ? 'cr' then
      if (select credits from profiles where id = v_me) < (o->'cost'->>'cr')::integer then raise exception 'Не хватает кредитов: нужно %', o->'cost'->>'cr'; end if;
    end if;
    v_res := coalesce(o->'cost'->'res', '{}'::jsonb);
    for k, v_n in select key, value::integer from jsonb_each_text(v_res) loop
      select coalesce(amount, 0) into v_have from planet_stock where system_id = r.system_id and resource = k;
      if coalesce(v_have, 0) < v_n then raise exception 'На складе планеты не хватает: % (нужно %, есть %)', coalesce((select name from resources where id = k), k), v_n, coalesce(v_have, 0); end if;
    end loop;
    if (o->'cost') ? 'cr' then update profiles set credits = credits - (o->'cost'->>'cr')::integer where id = v_me; end if;
    for k, v_n in select key, value::integer from jsonb_each_text(v_res) loop perform take_planet_stock(r.system_id, k, v_n); end loop;
  end if;
  return report_apply(r.id, p_choice, false);
end;
$function$;

-- ---------------------------------------------------------------- администрации
create or replace function public.dev_report_send(p_user uuid, p_report text default null)
 returns jsonb language plpgsql security definer set search_path to 'public', 'pg_temp'
as $function$
declare v_me uuid := dev_assert(); v_side text; v_sys text; v_pick text; v_id uuid;
begin
  select faction into v_side from profiles where id = p_user;
  if v_side is null then raise exception 'У игрока нет стороны'; end if;
  select system_id into v_sys from system_control where controller_user_id = p_user order by random() limit 1;
  if v_sys is null then raise exception 'У игрока нет своей планеты — донесениям некуда приходить'; end if;
  v_pick := coalesce(p_report, report_pick(p_user, v_side), (select id from report_catalog where side = v_side and active and not chain order by random() limit 1));
  if not exists (select 1 from report_catalog where id = v_pick and side = v_side) then raise exception 'Донесение другой стороны'; end if;
  v_id := report_deliver(p_user, v_pick, v_sys, null);
  perform dev_note(v_me, 'report_send', p_user, v_sys, jsonb_build_object('report', v_pick));
  return jsonb_build_object('id', v_id, 'report', v_pick, 'system', v_sys);
end;
$function$;

do $$
declare f text;
begin
  foreach f in array array['effect_sum(text, text)', 'report_gift(text, uuid, boolean)', 'report_deliver(uuid, text, text, integer)', 'report_pick(uuid, text)',
                           'report_apply(uuid, integer, boolean)', 'report_tick()']
  loop execute format('revoke all on function public.%s from public, anon, authenticated', f); end loop;
  foreach f in array array['report_badge()', 'report_list()', 'report_choose(uuid, integer)', 'dev_report_send(uuid, text)']
  loop execute format('revoke all on function public.%s from public, anon', f); execute format('grant execute on function public.%s to authenticated', f); end loop;
end $$;

-- ---------------------------------------------------------------- встраивание в старое
-- Правка тел функций заменой строки: если строка не найдена — ошибка, ничего не меняется.
do $$
declare d text; n text;
begin
  -- добыча × эффект extract (только сырьё; передел не трогаем)
  d := pg_get_functiondef('public.production_tick()'::regprocedure);
  if position('effect_sum(b.system_id' in d) = 0 then
    n := replace(d, E'      else  v_rate := 0;\n      end if;\n',
                    E'      else  v_rate := 0;\n      end if;\n      -- донесения и события: ±% добычи на планете\n      if v_rate > 0 then v_rate := greatest(0, round(v_rate * (100 + effect_sum(b.system_id, ''extract'')) / 100.0))::integer; end if;\n');
    if n = d then raise exception 'production_tick: место для эффекта не найдено'; end if;
    execute n;
  end if;
  -- доход поселения × эффект income
  d := pg_get_functiondef('public.settlement_day_income(text, integer)'::regprocedure);
  if position('effect_sum' in d) = 0 then
    n := replace(d, E'                      else 1 end)::integer;',
                    E'                      else 1 end\n               * (100 + effect_sum(p_system, ''income'')) / 100.0)::integer;');
    if n = d then raise exception 'settlement_day_income: место для эффекта не найдено'; end if;
    execute n;
  end if;
  -- довольство: строка «События»
  d := pg_get_functiondef('public.settlement_factors(text)'::regprocedure);
  if position('effect_sum' in d) = 0 then
    n := replace(d, E'  select * into b from settlement_box();',
                    E'  v_ev := effect_sum(p_system, ''mood'');\n  if v_ev <> 0 then label := ''События''; value := v_ev; return next; end if;\n\n  select * into b from settlement_box();');
    n := replace(n, E'declare st record; v_bonus integer;', E'declare v_ev integer; st record; v_bonus integer;');
    if n = d or position('v_ev integer' in n) = 0 then raise exception 'settlement_factors: место для эффекта не найдено'; end if;
    execute n;
  end if;
end $$;

-- такт выдачи
select cron.schedule('report-tick', '*/10 * * * *', 'select public.report_tick()');
