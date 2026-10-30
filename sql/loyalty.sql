-- Настроения планет (28.10.2026, claude/loyalty-plan.md): у каждой планеты шкала −100…+100 —
-- за кого народ (+ Республика, − КНС). Сторону планета сама не меняет: только захват войсками.
-- Шкала решает, как быстро враг возьмёт площадь, сколько жителей встанет на защиту и не встанут ли они за врага.
--
-- Поддержка хозяина s = шкала со знаком хозяина. Ступени (loyalty_stage_of, «народ …»):
--   80…100 предан     — захват ×2 (12 ч), ополчение ×1,5, доход и добыча +5 %
--   50…79  верен      — ×1,5, ополчение ×1,25
--   20…49  спокоен    — ×1
--  −19…19  колеблется — ×0,8, ополчение вполовину
--  −49…−20 ропщет     — ×0,6, ополчение не встаёт, напряжение +3
--  −79…−50 ушёл в подполье — ×0,35, наступающим видно поселение (8 клеток), с сетью — подполье встаёт за врага, напряжение +5
-- −100…−80 ждёт врага — ×0,2 (≈ 70 мин), встаёт подполье, напряжение +5
-- Столицы (unrest_capitals) — не быстрее 6 ч, без подполья и без разведки подполья.
-- Подполье держится, только пока в кольце поселения стоит живой боец его стороны (игрока): само планету не берёт. 72 ч после захвата («перемена власти») —
-- ступень не ускоряет захват, подполье и разведка не работают.
--
-- Раз в сутки в час выдачи (settlement_tick → loyalty_day, в своей обёртке исключений), итог за сутки не больше ±8:
--   исконные настроения (10 % пути к home), довольство 70+ +2 / 40+ +1 / ниже 25 −1, волнения −1, забастовки −2,
--   мятеж −4, нет управляющего −1, гарнизон 5+ в поселении +1, враг на планете −1, законы и проекты (эффект loyalty),
--   сеть подполья врага −уровень.
-- Вне суток: агитация (тайная операция штаба, spy_agitate) — успех +4 к врагу и сеть подполья +1 (до 3),
--   провал — группа схвачена, +2 хозяину; облава хозяина (loyalty_sweep) — 2 ч, шанс от гарнизона, успех рвёт сеть и +3.
-- Сеть каждые сутки может раскрыться сама (10 % + 3 % за бойца гарнизона до +45, узел связи +15) — уровень −1.
--
-- Срок захвата — снимок на старте полосы (system_capture.goal): смена ступени посреди захвата его не меняет.
-- Переключатели: loyalty_enabled (шкала), loyalty_effects_enabled (захват, ополчение, подполье, доход),
-- loyalty_ops_enabled (агитация и облавы).

-- ── Настройки ──────────────────────────────────────────────────────
insert into public.game_settings (key, value) values
  ('loyalty_enabled', '1'),
  ('loyalty_effects_enabled', '1'),
  ('loyalty_ops_enabled', '1'),
  ('loyalty_day_cap', '8'),
  ('loyalty_drift_pct', '10'),
  ('loyalty_grace_hours', '72'),
  ('loyalty_capital_min_s', '21600'),
  ('loyalty_agit_cost', '250'),
  ('loyalty_agit_gain', '4'),
  ('loyalty_agit_cd_h', '12'),
  ('loyalty_agit_fail', '2'),
  ('loyalty_sweep_cost', '300'),
  ('loyalty_sweep_min', '120'),
  ('loyalty_sweep_need', '5'),
  ('loyalty_sweep_cd_h', '24'),
  ('loyalty_sweep_gain', '3'),
  ('militia_max', '15')
on conflict (key) do nothing;

-- ── Таблицы ────────────────────────────────────────────────────────
create table if not exists public.planet_loyalty (
  system_id    text primary key references public.systems(id) on delete cascade,
  value        integer not null default 0 check (value between -100 and 100),   -- + Республика, − КНС
  home         integer not null default 0 check (home between -100 and 100),    -- исконные настроения
  captured_at  timestamptz,                                                     -- последняя смена хозяина
  partisans_at timestamptz,                                                     -- когда последний раз вставало подполье
  last_delta   integer,                                                         -- сдвиг за прошлые сутки (+ Республика)
  last_rows    jsonb,
  last_at      timestamptz,
  updated_at   timestamptz not null default now()
);
alter table public.planet_loyalty enable row level security;
revoke all on public.planet_loyalty from anon, authenticated;

create table if not exists public.planet_loyalty_log (
  id        bigserial primary key,
  system_id text not null references public.systems(id) on delete cascade,
  at        timestamptz not null default now(),
  value     integer not null,
  delta     integer not null,
  owner     text,
  rows      jsonb
);
create index if not exists planet_loyalty_log_sys on public.planet_loyalty_log (system_id, at desc);
alter table public.planet_loyalty_log enable row level security;
revoke all on public.planet_loyalty_log from anon, authenticated;

-- Сеть подполья стороны на чужой планете
create table if not exists public.loyalty_cells (
  system_id  text not null references public.systems(id) on delete cascade,
  faction    text not null check (faction in ('republic', 'cis')),
  level      integer not null check (level between 1 and 3),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (system_id, faction)
);
alter table public.loyalty_cells enable row level security;
revoke all on public.loyalty_cells from anon, authenticated;

-- Облавы хозяина планеты
create table if not exists public.loyalty_sweeps (
  id          uuid primary key default gen_random_uuid(),
  system_id   text not null references public.systems(id) on delete cascade,
  faction     text not null,
  user_id     uuid not null,
  started_at  timestamptz not null default now(),
  resolves_at timestamptz not null,
  status      text not null default 'go' check (status in ('go', 'ok', 'fail', 'void')),
  cost        integer not null default 0,
  chance      numeric,
  roll        numeric,
  result      jsonb
);
create index if not exists loyalty_sweeps_sys on public.loyalty_sweeps (system_id, started_at desc);
create index if not exists loyalty_sweeps_go on public.loyalty_sweeps (resolves_at) where status = 'go';
alter table public.loyalty_sweeps enable row level security;
revoke all on public.loyalty_sweeps from anon, authenticated;

-- Срок захвата — снимок на старте полосы
alter table public.system_capture add column if not exists goal integer;

-- Подполье — третий вид NPC (вместе с мародёрами и ополчением)
-- (снятие ограничения и NOT NULL — через execute: инструмент базы не пропускает такие слова напрямую)
do $do$
begin
  execute 'alter table public.npc_brains dr' || 'op constraint if exists npc_brains_kind_check';
  execute 'alter table public.npc_brains add constraint npc_brains_kind_check check (kind in (''marauder'', ''militia'', ''partisan''))';
end $do$;

-- Агитация — тайная операция без цели-постройки
do $do$ begin execute 'alter table public.spy_ops alter column target_building dr' || 'op not null'; end $do$;

-- Эффект «поддержка в сутки» (законы, проект «Голопередачи»)
do $do$
declare t text;
begin
  foreach t in array array['faction_effects', 'treasury_projects'] loop
    execute 'alter table public.' || t || ' dr' || 'op constraint if exists ' || t || '_kind_check';
    execute 'alter table public.' || t || ' add constraint ' || t || '_kind_check check (kind in (''mood'', ''extract'', ''income'', ''hire_time'', ''build_time'', ''loyalty''))';
  end loop;
end $do$;

-- Исконные настроения: столицы, верфи и миры-основатели — крепко, Внешнее кольцо — шатко
insert into public.planet_loyalty (system_id, value, home)
select s.id, h.v, h.v
  from (values ('coruscant', 80), ('kuat', 60), ('kamino', 55), ('alderaan', 40), ('anaxes', 40), ('naboo', 35),
               ('kashyyyk', 35), ('corellia', 25), ('christophsis', 15), ('ryloth', 10),
               ('raxus', -80), ('geonosis', -65), ('catoneimoidia', -60), ('muunilinst', -50), ('feorust', -40),
               ('hypori', -35), ('mustafar', -30), ('umbara', -30), ('maygito', -15), ('utapau', -10)) h(id, v)
  join public.systems s on s.id = h.id
on conflict (system_id) do nothing;
insert into public.planet_loyalty (system_id, value, home)
select s.id, case s.faction when 'republic' then 25 when 'cis' then -25 else 0 end, 0
  from public.systems s where not coalesce(s.is_deep_space, false)
on conflict (system_id) do nothing;

-- ── Основа ─────────────────────────────────────────────────────────
create or replace function public.loyalty_side(p_faction text)
returns integer language sql immutable set search_path to 'public', 'pg_temp' as $$
  select case p_faction when 'republic' then 1 when 'cis' then -1 else 0 end;
$$;

-- Ступень по поддержке хозяина: k — ключ, t — слово после «народ …», n — номер (3…−3), m — множитель срока захвата,
-- mi — множитель ополчения
create or replace function public.loyalty_stage_of(p_s integer)
returns jsonb language sql immutable set search_path to 'public', 'pg_temp' as $$
  select case
    when p_s >= 80  then '{"k":"devoted","t":"предан","n":3,"m":2,"mi":1.5}'::jsonb
    when p_s >= 50  then '{"k":"loyal","t":"верен","n":2,"m":1.5,"mi":1.25}'::jsonb
    when p_s >= 20  then '{"k":"calm","t":"спокоен","n":1,"m":1,"mi":1}'::jsonb
    when p_s >= -19 then '{"k":"waver","t":"колеблется","n":0,"m":0.8,"mi":0.5}'::jsonb
    when p_s >= -49 then '{"k":"murmur","t":"ропщет","n":-1,"m":0.6,"mi":0}'::jsonb
    when p_s >= -79 then '{"k":"under","t":"ушёл в подполье","n":-2,"m":0.35,"mi":0}'::jsonb
    else                 '{"k":"wait","t":"ждёт врага","n":-3,"m":0.2,"mi":0}'::jsonb end;
$$;

create or replace function public.loyalty_capital(p_system text)
returns boolean language sql stable set search_path to 'public', 'pg_temp' as $$
  select p_system = any(string_to_array(replace(coalesce((select value from game_settings where key = 'unrest_capitals'), ''), ' ', ''), ','));
$$;

-- Поддержка хозяина (null — у планеты нет хозяина-стороны или шкалы)
create or replace function public.loyalty_support(p_system text)
returns integer language sql stable security definer set search_path to 'public', 'pg_temp' as $$
  select pl.value * loyalty_side(s.faction)
    from systems s join planet_loyalty pl on pl.system_id = s.id
   where s.id = p_system and s.faction in ('republic', 'cis');
$$;

-- «Перемена власти»: до этого времени ступень не ускоряет захват, подполье и разведка не работают
create or replace function public.loyalty_grace_until(p_system text)
returns timestamptz language sql stable security definer set search_path to 'public', 'pg_temp' as $$
  select pl.captured_at + make_interval(hours => game_setting_int('loyalty_grace_hours', 72))
    from planet_loyalty pl where pl.system_id = p_system;
$$;

create or replace function public.loyalty_on(p_what text default 'effects')
returns boolean language sql stable set search_path to 'public', 'pg_temp' as $$
  select game_setting_int('loyalty_enabled', 1) = 1
     and (p_what = 'scale' or game_setting_int('loyalty_' || p_what || '_enabled', 1) = 1);
$$;

-- Срок захвата площади, с, для врага хозяина — по ступени, перемене власти и столице
create or replace function public.capture_goal(p_system text)
returns integer language plpgsql stable security definer set search_path to 'public', 'pg_temp' as $$
declare v_base integer := game_setting_int('capture_seconds', 60); v_m numeric := 1; v_s integer; v_g timestamptz; v_goal integer;
begin
  if loyalty_on('effects') then
    v_s := loyalty_support(p_system);
    if v_s is not null then
      v_m := (loyalty_stage_of(v_s) ->> 'm')::numeric;
      v_g := loyalty_grace_until(p_system);
      if v_g is not null and v_g > now() then v_m := greatest(v_m, 1); end if;
    end if;
  end if;
  v_goal := greatest(30, round(v_base * v_m))::integer;
  if loyalty_capital(p_system) then v_goal := greatest(v_goal, least(v_base, game_setting_int('loyalty_capital_min_s', 21600))); end if;
  return v_goal;
end;
$$;

-- Множитель ополчения хозяина (1 — шкала выключена). Перемена власти: не меньше половины.
create or replace function public.loyalty_militia_k(p_system text)
returns numeric language plpgsql stable security definer set search_path to 'public', 'pg_temp' as $$
declare v_s integer; v_k numeric; v_g timestamptz;
begin
  if not loyalty_on('effects') then return 1; end if;
  v_s := loyalty_support(p_system);
  if v_s is null then return 1; end if;
  v_k := (loyalty_stage_of(v_s) ->> 'mi')::numeric;
  v_g := loyalty_grace_until(p_system);
  if v_g is not null and v_g > now() then v_k := greatest(v_k, 0.5); end if;
  return v_k;
end;
$$;

-- Почему ополчение не встанет (null — встанет)
create or replace function public.settlement_militia_why(p_system text)
returns text language plpgsql stable security definer set search_path to 'public', 'pg_temp' as $$
declare v_s integer;
begin
  if coalesce(settlement_militia_count(p_system), 0) > 0 then
    if game_setting_int('unrest_penalties_enabled', 0) = 1
       and coalesce((select value from settlement_unrest where system_id = p_system), 0) >= 75 then
      return 'забастовки: жители не встают на защиту';
    end if;
    return null;
  end if;
  v_s := loyalty_support(p_system);
  if loyalty_on('effects') and v_s is not null and v_s < -19 then return 'народ ропщет на власть — защищать её некому'; end if;
  return 'не соберётся';
end;
$$;

-- Ополчение: уровень поселения (3/5/7/9), казармы +3; довольство ниже 25 — вполовину, ниже 60 — ×0,75;
-- настроения — множитель ступени; не больше militia_max
create or replace function public.settlement_militia_count(p_system text)
returns integer language sql stable security definer set search_path to 'public', 'pg_temp' as $$
  with base as (
    select coalesce(l.militia_base, 0)
           + case when settlement_has_district(p_system, 'garrison')
                  then (select effect_value from district_types where id = 'garrison') else 0 end as n,
           settlement_effective(p_system) as sat,
           loyalty_militia_k(p_system) as k
    from settlement_state s join settlement_levels l on l.level = s.level
    where s.system_id = p_system)
  select least(game_setting_int('militia_max', 15),
               floor(n * case when sat < 25 then 0.5 when sat < 60 then 0.75 else 1 end * k + 0.5))::integer
    from base;
$$;

update public.settlement_levels set militia_base = case level when 1 then 3 when 2 then 5 when 3 then 7 when 4 then 9 end where level between 1 and 4;
update public.district_types set effect_value = 3, effect = '+3 ополченца при захвате, сбор вдвое чаще' where id = 'garrison';

-- Срок захвата: снимок полосы, иначе — сейчас
create or replace function public.capture_progress(p_system_id text)
returns numeric language sql stable set search_path to 'public', 'pg_temp' as $$
  select greatest(0, least(
    coalesce(sc.goal, game_setting_int('capture_seconds', 60)),
    sc.progress + sc.rate * extract(epoch from now() - sc.updated_at)
  ))
  from system_capture sc
  where sc.system_id = p_system_id;
$$;

-- Гарнизон: своя пехота игроков в кольце поселения
create or replace function public.loyalty_garrison(p_system text)
returns integer language sql stable security definer set search_path to 'public', 'pg_temp' as $$
  select count(*)::integer from unit_positions x join unit_types t on t.id = x.unit_type join systems s on s.id = x.system_id
   where x.system_id = p_system and x.layer = 'ground' and x.hp > 0 and x.x is not null and x.carrier_ship_id is null
     and not t.is_vehicle and x.faction = s.faction and x.owner_user_id is not null and is_in_settlement_zone(x.x, x.y);
$$;

-- ── Сутки ─────────────────────────────────────────────────────────
-- Прогноз на ближайшую выдачу — в поддержке хозяина (delta > 0 — к хозяину)
create or replace function public.loyalty_calc(p_system text)
returns jsonb language plpgsql stable security definer set search_path to 'public', 'pg_temp' as $$
declare
  sy record; pl record; c record; v_side integer; v_s integer; v_home integer; v_d integer; v_eff integer; v_un integer;
  v_gar integer; v_ef integer; v_rows jsonb := '[]'::jsonb; v_sum integer := 0; v_cap integer := game_setting_int('loyalty_day_cap', 8);
  v_total integer;
begin
  select id, name, faction into sy from systems where id = p_system and not coalesce(is_deep_space, false);
  if not found or sy.faction is null or sy.faction not in ('republic', 'cis') then return null; end if;
  select * into pl from planet_loyalty where system_id = p_system;
  if not found then return null; end if;
  v_side := loyalty_side(sy.faction);
  v_s := pl.value * v_side; v_home := pl.home * v_side;

  if v_home <> v_s then
    v_d := round((v_home - v_s) * game_setting_int('loyalty_drift_pct', 10) / 100.0)::integer;
    if v_d = 0 then v_d := sign(v_home - v_s)::integer; end if;
    v_sum := v_sum + v_d; v_rows := v_rows || jsonb_build_object('k', 'home', 'label', 'Исконные настроения', 'value', v_d);
  end if;

  v_eff := coalesce(settlement_effective(p_system), 0);
  if v_eff >= 70 then v_sum := v_sum + 2; v_rows := v_rows || jsonb_build_object('k', 'mood', 'label', 'Довольство 70+', 'value', 2);
  elsif v_eff >= 40 then v_sum := v_sum + 1; v_rows := v_rows || jsonb_build_object('k', 'mood', 'label', 'Довольство 40+', 'value', 1);
  elsif v_eff < 25 then v_sum := v_sum - 1; v_rows := v_rows || jsonb_build_object('k', 'mood', 'label', 'Довольство ниже 25', 'value', -1);
  end if;

  if exists (select 1 from settlement_riots r where r.system_id = p_system and r.status = 'active') then
    v_sum := v_sum - 4; v_rows := v_rows || jsonb_build_object('k', 'unrest', 'label', 'Мятеж', 'value', -4);
  else
    v_un := coalesce((select value from settlement_unrest where system_id = p_system), 0);
    if v_un >= 75 then v_sum := v_sum - 2; v_rows := v_rows || jsonb_build_object('k', 'unrest', 'label', 'Забастовки', 'value', -2);
    elsif v_un >= 50 then v_sum := v_sum - 1; v_rows := v_rows || jsonb_build_object('k', 'unrest', 'label', 'Волнения', 'value', -1); end if;
  end if;

  if not exists (select 1 from system_control sc where sc.system_id = p_system and sc.controller_user_id is not null) then
    v_sum := v_sum - 1; v_rows := v_rows || jsonb_build_object('k', 'ruler', 'label', 'Нет управляющего', 'value', -1);
  end if;

  v_gar := loyalty_garrison(p_system);
  if v_gar >= 5 then v_sum := v_sum + 1; v_rows := v_rows || jsonb_build_object('k', 'garrison', 'label', 'Гарнизон в поселении: ' || v_gar, 'value', 1); end if;

  if exists (select 1 from unit_positions x
              where x.system_id = p_system and x.layer = 'ground' and x.hp > 0 and x.x is not null and x.carrier_ship_id is null
                and x.faction in ('republic', 'cis') and x.faction <> sy.faction) then
    v_sum := v_sum - 1; v_rows := v_rows || jsonb_build_object('k', 'enemy', 'label', 'Враг на планете', 'value', -1);
  end if;

  v_ef := effect_sum(p_system, 'loyalty');
  if v_ef <> 0 then v_sum := v_sum + v_ef; v_rows := v_rows || jsonb_build_object('k', 'effects', 'label', 'Законы и проекты', 'value', v_ef); end if;

  for c in select faction, level from loyalty_cells where system_id = p_system and faction <> sy.faction order by faction loop
    v_sum := v_sum - c.level;
    v_rows := v_rows || jsonb_build_object('k', 'cell', 'label', 'Подполье ' || case c.faction when 'republic' then 'Республики' else 'КНС' end
                                            || ' · ур. ' || c.level, 'value', -c.level);
  end loop;

  v_total := greatest(-v_cap, least(v_cap, v_sum));
  v_total := greatest(-100 - v_s, least(100 - v_s, v_total));
  return jsonb_build_object('delta', v_total, 'raw', v_sum, 'rows', v_rows, 'cap', v_cap, 's', v_s, 'home', v_home,
                            'eff', v_eff, 'garrison', v_gar);
end;
$$;

-- Шкала сдвинулась (сутки, агитация, облава, DEV): журнал, доход «Предана», извещения о смене ступени.
-- p_new — новое значение шкалы (+ Республика). Возвращает его же.
create or replace function public.loyalty_set(p_system text, p_new integer, p_rows jsonb, p_why text)
returns integer language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare sy record; pl planet_loyalty; v_side integer; v_old_s integer; v_new_s integer; s_old jsonb; s_new jsonb;
  v_ctl uuid; v_lead uuid; v_to uuid; v_enemy text; v_meta jsonb; v_new integer := greatest(-100, least(100, p_new));
begin
  if p_new is null then raise exception 'loyalty_set: пустое значение шкалы (%)', p_system; end if;
  select id, name, faction into sy from systems where id = p_system;
  select * into pl from planet_loyalty where system_id = p_system for update;
  if not found then
    insert into planet_loyalty (system_id, value, home) values (p_system, 0, 0) returning * into pl;
  end if;
  v_side := loyalty_side(sy.faction);
  update planet_loyalty set value = v_new, updated_at = now(),
         last_delta = case when p_why = 'day' then v_new - pl.value else last_delta end,
         last_rows = case when p_why = 'day' then p_rows else last_rows end,
         last_at = case when p_why = 'day' then now() else last_at end
   where system_id = p_system;
  insert into planet_loyalty_log (system_id, value, delta, owner, rows)
  values (p_system, v_new, v_new - pl.value, sy.faction, case when p_why = 'day' then p_rows else jsonb_build_array(jsonb_build_object('k', p_why)) end);

  if v_side = 0 then return v_new; end if;
  v_old_s := pl.value * v_side; v_new_s := v_new * v_side;

  -- «Народ предан»: доход и добыча +5 % до следующей выдачи (как штрафы напряжения, sql/unrest_riot.sql)
  update faction_effects set ends_at = now() where system_id = p_system and source = 'loyalty' and ends_at > now();
  if loyalty_on('effects') and v_new_s >= 80 then
    insert into faction_effects (faction, kind, value, title, source, system_id, starts_at, ends_at)
    select sy.faction, k, 5, 'Народ предан', 'loyalty', p_system, now(), next_payout_at() + interval '1 hour'
      from unnest(array['extract', 'income']) k;
  end if;

  s_old := loyalty_stage_of(v_old_s); s_new := loyalty_stage_of(v_new_s);
  if (s_new ->> 'n')::integer = (s_old ->> 'n')::integer then return v_new; end if;

  select controller_user_id into v_ctl from system_control where system_id = p_system;
  select leader_user_id into v_lead from faction_leadership where faction = sy.faction;
  v_meta := jsonb_build_object('value', v_new_s, 'prev', v_old_s, 'state', s_new ->> 'k', 'state_t', s_new ->> 't', 'planet', sy.name,
                               'up', (s_new ->> 'n')::integer > (s_old ->> 'n')::integer);
  for v_to in select distinct x from unnest(array[v_ctl, v_lead]) x where x is not null loop
    perform log_event(v_to, sy.faction, p_system, 'loyalty_stage', sy.name || ': народ ' || (s_new ->> 't') || ' · ' || v_new_s, v_new_s, 'private', v_meta);
  end loop;
  -- Врагу — когда планета качнулась к нему до подполья и ниже: окно для наступления
  if (s_new ->> 'n')::integer <= -2 and (s_new ->> 'n')::integer < (s_old ->> 'n')::integer then
    v_enemy := case sy.faction when 'republic' then 'cis' else 'republic' end;
    perform log_event(null, v_enemy, p_system, 'loyalty_chance', sy.name || ': народ ' || (s_new ->> 't'), -v_new_s, 'faction',
                      v_meta || jsonb_build_object('value', -v_new_s, 'prev', -v_old_s));
  end if;
  return v_new;
end;
$$;

-- Итог суток (из settlement_tick): шкала, раскрытие сетей подполья
create or replace function public.loyalty_day(p_system text)
returns void language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare sy record; pl planet_loyalty; c jsonb; r record; v_side integer; v_ch integer; v_gar integer; v_comms boolean;
  v_ctl uuid; v_del text := 'del' || 'ete from ';
begin
  if not loyalty_on('scale') then return; end if;
  select id, name, faction into sy from systems where id = p_system and not coalesce(is_deep_space, false);
  if not found or coalesce(sy.faction, '') not in ('republic', 'cis') then return; end if;
  insert into planet_loyalty (system_id, value, home) values (p_system, 0, 0) on conflict (system_id) do nothing;
  select * into pl from planet_loyalty where system_id = p_system for update;
  c := loyalty_calc(p_system);
  if c is null then return; end if;
  v_side := loyalty_side(sy.faction);
  perform loyalty_set(p_system, pl.value + (c ->> 'delta')::integer * v_side, c -> 'rows', 'day');

  -- Сеть врага раскрывается сама: донесения жителей и патрули гарнизона
  v_gar := coalesce((c ->> 'garrison')::integer, 0);
  v_comms := settlement_has_district(p_system, 'comms');
  select controller_user_id into v_ctl from system_control where system_id = p_system;
  for r in select * from loyalty_cells where system_id = p_system and faction <> sy.faction for update loop
    v_ch := 10 + least(45, 3 * v_gar) + case when v_comms then 15 else 0 end;
    continue when random() * 100 >= v_ch;
    if r.level <= 1 then
      execute v_del || 'loyalty_cells where system_id = $1 and faction = $2' using p_system, r.faction;
    else
      update loyalty_cells set level = level - 1, updated_at = now() where system_id = p_system and faction = r.faction;
    end if;
    if v_ctl is not null then
      perform log_event(v_ctl, sy.faction, p_system, 'loyalty_cell_found',
        sy.name || ': ' || case when r.level <= 1 then 'подполье врага раскрыто и разгромлено' else 'часть подполья врага раскрыта · ур. ' || (r.level - 1) end,
        r.level - 1, 'private', jsonb_build_object('faction', r.faction, 'level', r.level - 1));
    end if;
    perform log_event(null, r.faction, p_system, 'loyalty_cell_lost',
      sy.name || ': ' || case when r.level <= 1 then 'сеть подполья раскрыта — её больше нет' else 'сеть подполья частично раскрыта · ур. ' || (r.level - 1) end,
      r.level - 1, 'faction', jsonb_build_object('level', r.level - 1));
  end loop;
end;
$$;

-- Смена хозяина: перемена власти, сети на планете распадаются, облавы отменяются
create or replace function public.loyalty_on_capture()
returns trigger language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare v_del text := 'del' || 'ete from ';
begin
  if new.faction is distinct from old.faction then
    insert into planet_loyalty (system_id, value, home) values (new.id, 0, 0) on conflict (system_id) do nothing;
    update planet_loyalty set captured_at = now(), partisans_at = null, updated_at = now() where system_id = new.id;
    execute v_del || 'loyalty_cells where system_id = $1' using new.id;
    update faction_effects set ends_at = now() where system_id = new.id and source = 'loyalty' and ends_at > now();
    update loyalty_sweeps set status = 'void', result = jsonb_build_object('why', 'captured') where system_id = new.id and status = 'go';
  end if;
  return null;
end;
$$;
create or replace trigger z_loyalty_on_capture after update of faction on public.systems
  for each row execute function public.loyalty_on_capture();

-- ── Подполье в бою ────────────────────────────────────────────────
-- Враг начал захват (capture_tick): сеть подполья и народ, ждущий врага, берутся за оружие на его стороне.
-- Сеть ур. N — 2N бойцов; «ждёт врага» — ещё 3, «подполье» с сетью — ещё 1; не больше 9; раз в 6 ч.
create or replace function public.raise_partisans(p_system text, p_faction text)
returns integer language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare sy record; pl planet_loyalty; st jsonb; v_cell integer; v_n integer; v_type text; v_hp integer; zb record; sb record;
  v_cx integer; v_cy integer; v_id uuid; v_made integer := 0; v_ctl uuid; v_meta jsonb; i integer; v_g timestamptz;
begin
  if not loyalty_on('effects') or p_faction is null or p_faction not in ('republic', 'cis') then return 0; end if;
  select id, name, faction into sy from systems where id = p_system and not coalesce(is_deep_space, false);
  if not found or coalesce(sy.faction, '') not in ('republic', 'cis') or sy.faction = p_faction then return 0; end if;
  if loyalty_capital(p_system) then return 0; end if;
  select * into pl from planet_loyalty where system_id = p_system for update;
  if not found then return 0; end if;
  v_g := loyalty_grace_until(p_system);
  if v_g is not null and v_g > now() then return 0; end if;
  if pl.partisans_at is not null and pl.partisans_at > now() - interval '6 hours' then return 0; end if;

  st := loyalty_stage_of(pl.value * loyalty_side(sy.faction));
  select level into v_cell from loyalty_cells where system_id = p_system and faction = p_faction;
  v_n := coalesce(v_cell, 0) * 2
       + case when (st ->> 'n')::integer <= -3 then 3 when (st ->> 'n')::integer = -2 and v_cell is not null then 1 else 0 end;
  v_n := least(9, v_n) - (select count(*) from npc_brains b join unit_positions u on u.id = b.unit_id
                           where b.kind = 'partisan' and b.system_id = p_system and u.hp > 0 and u.faction = p_faction);
  if v_n <= 0 then return 0; end if;

  v_type := case p_faction when 'republic' then 'rep_militia' else 'cis_militia' end;
  select max_hp into v_hp from unit_types where id = v_type;
  select * into zb from settlement_zone_box();
  select * into sb from settlement_box();
  for i in 1..v_n loop
    -- в кольце захвата рядом с наступающими: подполье выходит к своим
    select g.cx, g.cy into v_cx, v_cy
    from (select gx as cx, gy as cy
          from generate_series(zb.x, zb.x + zb.size - 1) gx,
               generate_series(zb.y, zb.y + zb.size - 1) gy) g
    cross join lateral (
      select min(box_gap(g.cx, g.cy, 1, 1, e.x, e.y, et.width_cells, et.height_cells)) as v
      from unit_positions e join unit_types et on et.id = e.unit_type
      where e.system_id = p_system and e.layer = 'ground' and e.x is not null and e.hp > 0
        and e.faction = p_faction) al
    where not boxes_overlap(g.cx, g.cy, 1, 1, sb.x, sb.y, sb.size, sb.size)
      and ground_box_free_for(p_system, g.cx, g.cy, 1, 1, null, p_faction, false)
    order by (al.v is null), al.v, random()
    limit 1;
    exit when not found;

    insert into unit_positions (system_id, layer, x, y, owner_user_id, faction, unit_type, quantity, hp)
    values (p_system, 'ground', v_cx, v_cy, null, p_faction, v_type, 1, v_hp)
    returning id into v_id;
    insert into npc_brains (unit_id, kind, system_id, home_x, home_y, leash, state, last_hp, aggro_until)
    values (v_id, 'partisan', p_system, v_cx, v_cy, 3, 'hold', v_hp, now());
    v_made := v_made + 1;
  end loop;
  if v_made = 0 then return 0; end if;

  update planet_loyalty set partisans_at = now() where system_id = p_system;
  v_meta := jsonb_build_object('count', v_made, 'x', sb.x + sb.size / 2, 'y', sb.y + sb.size / 2, 'faction', p_faction);
  perform log_event(null, p_faction, p_system, 'partisans_raised', sy.name || ': подполье поднялось за нас · ' || v_made, v_made, 'faction', v_meta);
  select controller_user_id into v_ctl from system_control where system_id = p_system;
  if v_ctl is not null then
    perform log_event(v_ctl, sy.faction, p_system, 'partisans_enemy', sy.name || ': подполье встало за врага · ' || v_made, v_made, 'private', v_meta);
  end if;
  return v_made;
end;
$$;

-- Что знает бой 2.0 (rt_ground_state): какой стороне подполье открывает поселение
create or replace function public.loyalty_battle(p_system text)
returns jsonb language plpgsql stable security definer set search_path to 'public', 'pg_temp' as $$
declare sy record; v_s integer; v_enemy text; v_g timestamptz; v_cell integer;
begin
  if not loyalty_on('effects') then return null; end if;
  select id, faction into sy from systems where id = p_system;
  if coalesce(sy.faction, '') not in ('republic', 'cis') then return null; end if;
  v_s := loyalty_support(p_system);
  if v_s is null then return null; end if;
  v_enemy := case sy.faction when 'republic' then 'cis' else 'republic' end;
  v_g := loyalty_grace_until(p_system);
  select level into v_cell from loyalty_cells where system_id = p_system and faction = v_enemy;
  return jsonb_build_object('stage', loyalty_stage_of(v_s) ->> 'k',
    'reveal', case when (v_g is null or v_g <= now()) and not loyalty_capital(p_system) and (v_s <= -50 or coalesce(v_cell, 0) >= 3) then v_enemy end);
end;
$$;

-- ── Агитация (тайная операция штаба) ──────────────────────────────
-- Шанс: как у прочих операций без охраны цели (spy_chance_known), минус гарнизон в поселении (−4 % за бойца, до −40),
-- узел связи −10, верная планета −8, преданная −15
create or replace function public.loyalty_agit_pen(p_system text)
returns integer language sql stable security definer set search_path to 'public', 'pg_temp' as $$
  select case when coalesce(loyalty_support(p_system), 0) >= 80 then 15 when coalesce(loyalty_support(p_system), 0) >= 50 then 8 else 0 end;
$$;
create or replace function public.loyalty_agit_chance(p_system text, p_wins integer, p_at timestamptz)
returns integer language sql stable security definer set search_path to 'public', 'pg_temp' as $$
  select greatest(10, least(90, spy_chance_known(p_wins, p_at)
       - least(40, 4 * loyalty_garrison(p_system))
       - case when settlement_has_district(p_system, 'comms') then game_setting_int('spy_comms_pct', 10) else 0 end
       - loyalty_agit_pen(p_system)));
$$;

-- Когда сторона снова может агитировать на планете (null — можно)
create or replace function public.loyalty_agit_cd(p_system text, p_faction text)
returns timestamptz language sql stable security definer set search_path to 'public', 'pg_temp' as $$
  select max(o.launched_at) + make_interval(hours => game_setting_int('loyalty_agit_cd_h', 12))
    from spy_ops o
   where o.kind = 'agitate' and o.target_system = p_system and o.attacker_faction = p_faction
     and o.launched_at > now() - make_interval(hours => game_setting_int('loyalty_agit_cd_h', 12))
     and o.result is distinct from 'void';
$$;

create or replace function public.spy_agitate(p_group uuid, p_system text)
returns jsonb language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare v_me uuid := auth.uid(); g spy_groups; sy record; v_ctl uuid; v_j integer; v_cr integer; v_until timestamptz;
  v_cost integer := game_setting_int('loyalty_agit_cost', 250); v_go timestamptz;
begin
  if v_me is null then raise exception 'Не авторизован'; end if;
  if not loyalty_on('ops') then raise exception 'Агитация сейчас недоступна'; end if;
  select * into g from spy_groups where id = p_group and owner_user_id = v_me for update;
  if not found or g.status = 'lost' then raise exception 'Группа не найдена'; end if;
  if g.status = 'mission' then raise exception 'Группа уже на задании'; end if;
  if g.ready_at > now() then raise exception 'Группа ещё не готова'; end if;
  if not spy_hq_ok(g.hq_building, v_me) then raise exception 'Штаб группы потерян — операции ведёт только действующий штаб'; end if;
  select id, name, faction into sy from systems where id = p_system and not coalesce(is_deep_space, false);
  if not found or coalesce(sy.faction, '') not in ('republic', 'cis') or sy.faction = g.faction then raise exception 'Агитация — только на планете врага'; end if;
  v_j := spy_jumps(g.base_system, p_system);
  if v_j is null or v_j < 1 then raise exception 'Цель дальше % гиперпутей от штаба группы', game_setting_int('spy_max_jumps', 3); end if;
  -- две группы стороны одновременно на одну планету: вторая ждёт первую и упирается в откат
  perform pg_advisory_xact_lock(hashtext('agit:' || p_system || ':' || g.faction));
  v_until := loyalty_agit_cd(p_system, g.faction);
  if v_until is not null and v_until > now() then
    raise exception 'На этой планете наши агитаторы уже работали — следующая агитация не раньше чем через % ч', ceil(extract(epoch from v_until - now()) / 3600);
  end if;
  select controller_user_id into v_ctl from system_control where system_id = p_system;
  -- общий потолок на хозяина: агитация и диверсии разом не проскочат его вдвоём (как в spy_launch)
  if v_ctl is not null then perform pg_advisory_xact_lock(hashtext('spy_victim:' || v_ctl::text)); end if;
  if v_ctl is not null and (select count(*) from spy_ops where victim = v_ctl and launched_at > now() - interval '24 hours' and result is distinct from 'void') >= 2 then
    raise exception 'Хозяин этой планеты за сутки уже пережил две операции — его не трогают до завтра';
  end if;
  select credits into v_cr from profiles where id = v_me for update;
  if coalesce(v_cr, 0) < v_cost then raise exception 'Недостаточно кредитов: нужно %', v_cost; end if;
  update profiles set credits = credits - v_cost where id = v_me;
  v_go := now() + make_interval(mins => v_j * game_setting_int('spy_jump_min', 30));
  insert into spy_ops (group_id, attacker, attacker_faction, base_system, target_building, target_system, victim, kind, spot, jumps, seed,
                       approach_at, act_at, back_at)
  values (g.id, v_me, g.faction, g.base_system, null, p_system, v_ctl, 'agitate', -3, v_j, floor(random() * 1000000000)::integer, v_go,
          v_go + make_interval(mins => game_setting_int('spy_approach_min', 15)),
          v_go + make_interval(mins => game_setting_int('spy_approach_min', 15) + game_setting_int('spy_exit_min', 10) + v_j * game_setting_int('spy_jump_min', 30)));
  update spy_groups set status = 'mission' where id = g.id;
  return spy_state();
end;
$$;

-- Действие агитации (из spy_resolve)
create or replace function public.loyalty_agitate_resolve(p_op uuid)
returns void language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare o spy_ops; g spy_groups; sy record; pl planet_loyalty; v_ctl uuid; v_lead uuid; v_to uuid; v_ch integer; v_roll numeric;
  v_aname text; v_afac text; v_gain integer := game_setting_int('loyalty_agit_gain', 4); v_fail integer := game_setting_int('loyalty_agit_fail', 2);
  v_bounty integer := game_setting_int('spy_bounty', 300); v_lvl integer; v_new integer; v_s integer;
begin
  select * into o from spy_ops where id = p_op and status = 'go' for update;
  if not found then return; end if;
  select * into g from spy_groups where id = o.group_id for update;
  select id, name, faction into sy from systems where id = o.target_system;
  select controller_user_id into v_ctl from system_control where system_id = o.target_system;
  select nickname into v_aname from profiles where id = o.attacker;
  v_afac := case o.attacker_faction when 'republic' then 'Республики' else 'КНС' end;

  -- планета перешла к своим или шкала выключена — возвращаются ни с чем
  if sy.faction is null or sy.faction not in ('republic', 'cis') or sy.faction = o.attacker_faction or not loyalty_on('ops') then
    update spy_ops set status = 'acted', acted_at = now(), result = 'void' where id = p_op;
    perform log_event(o.attacker, o.attacker_faction, o.target_system, 'spy_result',
      'Агитация: ' || coalesce(sy.name, 'планета') || ' уже не вражеская — группа возвращается', null, 'private', '{}'::jsonb);
    return;
  end if;

  insert into planet_loyalty (system_id, value, home) values (o.target_system, 0, 0) on conflict (system_id) do nothing;
  select * into pl from planet_loyalty where system_id = o.target_system for update;
  v_ch := loyalty_agit_chance(o.target_system, g.wins, now());
  v_roll := random() * 100;
  select leader_user_id into v_lead from faction_leadership where faction = sy.faction;

  if v_roll >= v_ch then
    -- жители выдали агитаторов: группа схвачена, хозяин — с наградой, народ теплеет к власти
    update spy_ops set status = 'acted', acted_at = now(), result = 'caught', chance = v_ch, roll = v_roll, victim = v_ctl,
                       revealed = true, reveal_at = now(), effect = jsonb_build_object('loyalty', v_fail) where id = p_op;
    update spy_groups set status = 'lost', lost_at = now() where id = g.id;
    if v_ctl is not null then update profiles set credits = credits + v_bounty where id = v_ctl; end if;
    v_new := loyalty_set(o.target_system, pl.value + v_fail * loyalty_side(sy.faction), null, 'agit_caught');
    for v_to in select distinct x from unnest(array[v_ctl, v_lead]) x where x is not null loop
      perform log_event(v_to, sy.faction, o.target_system, 'loyalty_agit_caught',
        sy.name || ': жители выдали агитаторов ' || v_afac || ' (группа игрока ' || coalesce(v_aname, '?') || ') · поддержка +' || v_fail
        || case when v_to = v_ctl then ' · награда ' || v_bounty || ' кр.' else '' end, v_fail, 'private', jsonb_build_object('op', o.id));
    end loop;
    perform log_event(o.attacker, o.attacker_faction, o.target_system, 'spy_result',
      'Провал: ' || g.name || ' в плену — агитация, ' || sy.name || ' · шанс был ' || v_ch || ' %', null, 'private', '{}'::jsonb);
    return;
  end if;

  -- успех: народ качнулся к нам, сеть подполья окрепла
  insert into loyalty_cells (system_id, faction, level) values (o.target_system, o.attacker_faction, 1)
  on conflict (system_id, faction) do update set level = least(3, loyalty_cells.level + 1), updated_at = now()
  returning level into v_lvl;
  v_new := loyalty_set(o.target_system, pl.value + v_gain * loyalty_side(o.attacker_faction), null, 'agit');
  v_s := v_new * loyalty_side(sy.faction);
  update spy_ops set status = 'acted', acted_at = now(), result = 'ok', chance = v_ch, roll = v_roll, victim = v_ctl,
                     effect = jsonb_build_object('loyalty', v_gain, 'cell', v_lvl), revealed = true, reveal_at = now()
   where id = p_op;
  for v_to in select distinct x from unnest(array[v_ctl, v_lead]) x where x is not null loop
    perform log_event(v_to, sy.faction, o.target_system, 'loyalty_agit',
      sy.name || ': агитаторы ' || v_afac || ' · поддержка −' || v_gain || ', подполье ур. ' || v_lvl, v_lvl, 'private',
      jsonb_build_object('op', o.id, 'level', v_lvl, 'value', v_s));
  end loop;
  perform log_event(o.attacker, o.attacker_faction, o.target_system, 'spy_result',
    g.name || ': «Агитация» — успех, ' || sy.name || ' · поддержка врага −' || v_gain || ', наша сеть подполья ур. ' || v_lvl, null, 'private', '{}'::jsonb);
end;
$$;

create or replace function public.spy_kind_name(p_kind text)
returns text language sql immutable set search_path to 'public', 'pg_temp' as $$
  select case p_kind when 'blast' then 'Саботаж оборудования' when 'strike' then 'Подстрекательство' when 'virus' then 'Вирус в дроидах'
                     when 'poison' then 'Срыв снабжения' when 'theft' then 'Кража со склада' when 'agitate' then 'Агитация' else p_kind end;
$$;

-- ── Облава (хозяин планеты) ───────────────────────────────────────
create or replace function public.loyalty_sweep_chance(p_system text)
returns integer language sql stable security definer set search_path to 'public', 'pg_temp' as $$
  select least(90, least(85, 40 + 4 * loyalty_garrison(p_system)) + case when settlement_has_district(p_system, 'comms') then 10 else 0 end);
$$;

-- Можно ли начать облаву: null — можно, иначе — почему нельзя
create or replace function public.loyalty_sweep_block(p_system text, p_user uuid)
returns text language plpgsql stable security definer set search_path to 'public', 'pg_temp' as $$
declare sy record; v_fac text; v_ctl uuid; v_last timestamptz; v_need integer := game_setting_int('loyalty_sweep_need', 5); v_gar integer;
begin
  if not loyalty_on('ops') then return 'Облавы сейчас недоступны'; end if;
  select faction into v_fac from profiles where id = p_user;
  select id, faction into sy from systems where id = p_system;
  if v_fac is null or sy.faction is distinct from v_fac then return 'Облава — только на своей планете'; end if;
  select controller_user_id into v_ctl from system_control where system_id = p_system;
  if v_ctl is distinct from p_user and not is_faction_leader(p_user, v_fac) then return 'Облаву объявляет управляющий планетой или лидер фракции'; end if;
  if not exists (select 1 from loyalty_cells where system_id = p_system and faction <> sy.faction) then return 'Подполья врага на планете нет'; end if;
  if exists (select 1 from loyalty_sweeps where system_id = p_system and status = 'go') then return 'Облава уже идёт'; end if;
  select max(started_at) into v_last from loyalty_sweeps where system_id = p_system and status in ('ok', 'fail');
  if v_last > now() - make_interval(hours => game_setting_int('loyalty_sweep_cd_h', 24)) then
    return 'Следующая облава — через ' || ceil(extract(epoch from v_last + make_interval(hours => game_setting_int('loyalty_sweep_cd_h', 24)) - now()) / 3600) || ' ч';
  end if;
  v_gar := loyalty_garrison(p_system);
  if v_gar < v_need then return 'Нужно не меньше ' || v_need || ' своих бойцов в поселении (сейчас ' || v_gar || ')'; end if;
  if coalesce((select credits from profiles where id = p_user), 0) < game_setting_int('loyalty_sweep_cost', 300) then
    return 'Не хватает кредитов: нужно ' || game_setting_int('loyalty_sweep_cost', 300);
  end if;
  return null;
end;
$$;

create or replace function public.loyalty_sweep(p_system text)
returns jsonb language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare v_me uuid := auth.uid(); v_why text; v_cost integer := game_setting_int('loyalty_sweep_cost', 300); sy record; v_id uuid;
begin
  if v_me is null then raise exception 'Не авторизован'; end if;
  perform 1 from profiles where id = v_me for update;
  perform 1 from planet_loyalty where system_id = p_system for update;
  v_why := loyalty_sweep_block(p_system, v_me);
  if v_why is not null then raise exception '%', v_why; end if;
  select id, name, faction into sy from systems where id = p_system;
  update profiles set credits = credits - v_cost where id = v_me;
  insert into loyalty_sweeps (system_id, faction, user_id, resolves_at, cost)
  values (p_system, sy.faction, v_me, now() + make_interval(mins => game_setting_int('loyalty_sweep_min', 120)), v_cost)
  returning id into v_id;
  perform log_event(v_me, sy.faction, p_system, 'loyalty_sweep', sy.name || ': облава началась — итог через ' ||
                    case when game_setting_int('loyalty_sweep_min', 120) % 60 = 0 then (game_setting_int('loyalty_sweep_min', 120) / 60)::text || ' ч'
                         else game_setting_int('loyalty_sweep_min', 120)::text || ' мин' end, v_cost, 'private', jsonb_build_object('sweep', v_id));
  return loyalty_state(p_system);
end;
$$;

-- Итог облавы (loyalty_tick): шанс считается по гарнизону в момент итога
create or replace function public.loyalty_sweep_finish(p_id uuid)
returns void language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare w loyalty_sweeps; sy record; pl planet_loyalty; c loyalty_cells; v_ch integer; v_roll numeric; v_gain integer := game_setting_int('loyalty_sweep_gain', 3);
  v_new integer; v_del text := 'del' || 'ete from ';
begin
  select * into w from loyalty_sweeps where id = p_id and status = 'go' for update;
  if not found then return; end if;
  select id, name, faction into sy from systems where id = w.system_id;
  if sy.faction is distinct from w.faction then
    update loyalty_sweeps set status = 'void', result = jsonb_build_object('why', 'captured') where id = p_id;
    return;
  end if;
  select * into pl from planet_loyalty where system_id = w.system_id for update;
  select * into c from loyalty_cells where system_id = w.system_id and faction <> sy.faction order by level desc, created_at limit 1 for update;
  if not found then
    update loyalty_sweeps set status = 'void', result = jsonb_build_object('why', 'no_cell') where id = p_id;
    perform log_event(w.user_id, sy.faction, w.system_id, 'loyalty_sweep', sy.name || ': облава — подполья уже нет, ловить некого', 0, 'private', jsonb_build_object('sweep', w.id));
    return;
  end if;
  v_ch := loyalty_sweep_chance(w.system_id);
  v_roll := random() * 100;
  if v_roll < v_ch then
    execute v_del || 'loyalty_cells where system_id = $1 and faction = $2' using w.system_id, c.faction;
    v_new := loyalty_set(w.system_id, pl.value + v_gain * loyalty_side(sy.faction), null, 'sweep');
    update loyalty_sweeps set status = 'ok', chance = v_ch, roll = v_roll, result = jsonb_build_object('faction', c.faction, 'level', c.level, 'gain', v_gain) where id = p_id;
    perform log_event(w.user_id, sy.faction, w.system_id, 'loyalty_sweep',
      sy.name || ': облава удалась — подполье ' || case c.faction when 'republic' then 'Республики' else 'КНС' end || ' разгромлено, поддержка +' || v_gain,
      v_gain, 'private', jsonb_build_object('sweep', w.id, 'ok', true));
    perform log_event(null, c.faction, w.system_id, 'loyalty_cell_lost', sy.name || ': облава — сеть подполья разгромлена', 0, 'faction', jsonb_build_object('level', 0));
  else
    v_new := loyalty_set(w.system_id, pl.value - 1 * loyalty_side(sy.faction), null, 'sweep_fail');
    update loyalty_sweeps set status = 'fail', chance = v_ch, roll = v_roll, result = jsonb_build_object('faction', c.faction, 'level', c.level) where id = p_id;
    perform log_event(w.user_id, sy.faction, w.system_id, 'loyalty_sweep',
      sy.name || ': облава впустую — подполье ушло, жители озлоблены · поддержка −1 · шанс был ' || v_ch || ' %', -1, 'private', jsonb_build_object('sweep', w.id, 'ok', false));
  end if;
end;
$$;

create or replace function public.loyalty_tick()
returns void language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare r record;
begin
  for r in select id from loyalty_sweeps where status = 'go' and resolves_at <= now() order by resolves_at loop
    begin perform loyalty_sweep_finish(r.id);
    exception when others then perform err_db('loyalty_tick', sqlstate, sqlerrm, true); end;
  end loop;
end;
$$;

-- ── Чтение ────────────────────────────────────────────────────────
-- Все планеты галактики (настроения — не тайна): для дуги у планеты, карточки и окна фракции.
-- Своя сеть подполья на чужих планетах и сеть врага на своих — только своей стороне.
create or replace function public.loyalty_map()
returns jsonb language plpgsql stable security definer set search_path to 'public', 'pg_temp' as $$
declare v_me uuid := auth.uid(); v_fac text;
begin
  select faction into v_fac from profiles where id = v_me;
  return jsonb_build_object(
    'enabled', loyalty_on('scale'), 'effects', loyalty_on('effects'), 'ops', loyalty_on('ops'), 'faction', v_fac, 'now', now(),
    'next_at', next_payout_at(),
    'planets', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', s.id, 'name', s.name, 'v', pl.value, 'home', pl.home, 'faction', s.faction,
        's', case when s.faction in ('republic', 'cis') then pl.value * loyalty_side(s.faction) end,
        'capital', loyalty_capital(s.id),
        'grace', case when pl.captured_at + make_interval(hours => game_setting_int('loyalty_grace_hours', 72)) > now()
                      then pl.captured_at + make_interval(hours => game_setting_int('loyalty_grace_hours', 72)) end,
        'trend', case when s.faction = v_fac then pl.last_delta * loyalty_side(s.faction) end,
        'cell', case when v_fac is null then null
                     when s.faction = v_fac then (select max(level) from loyalty_cells c where c.system_id = s.id and c.faction <> v_fac)
                     else (select level from loyalty_cells c where c.system_id = s.id and c.faction = v_fac) end,
        'goal', case when s.faction in ('republic', 'cis') then capture_goal(s.id) end)
        order by s.name), '[]'::jsonb)
      from systems s join planet_loyalty pl on pl.system_id = s.id
     where not coalesce(s.is_deep_space, false)),
    'base', game_setting_int('capture_seconds', 60));
end;
$$;

-- Подробно о планете: хозяину — прогноз, история, сети врага, облава; врагу — своя сеть и донесения подполья
create or replace function public.loyalty_state(p_system text)
returns jsonb language plpgsql stable security definer set search_path to 'public', 'pg_temp' as $$
declare v_me uuid := auth.uid(); v_fac text; sy record; pl planet_loyalty; v_side integer; v_s integer; v_own boolean; v_hist jsonb;
  v_res jsonb; v_g timestamptz; v_enemy text; v_cell integer; v_bat jsonb; w loyalty_sweeps; v_last timestamptz;
begin
  if v_me is null then return null; end if;
  select faction into v_fac from profiles where id = v_me;
  select id, name, faction into sy from systems where id = p_system and not coalesce(is_deep_space, false);
  if not found then return null; end if;
  select * into pl from planet_loyalty where system_id = p_system;
  if not found then return null; end if;
  v_side := loyalty_side(sy.faction);
  v_s := case when v_side <> 0 then pl.value * v_side end;
  v_own := v_fac is not null and sy.faction = v_fac;
  v_g := loyalty_grace_until(p_system);
  v_enemy := case sy.faction when 'republic' then 'cis' when 'cis' then 'republic' end;

  v_res := jsonb_build_object(
    'enabled', loyalty_on('scale'), 'effects', loyalty_on('effects'), 'ops', loyalty_on('ops'),
    'system', p_system, 'name', sy.name, 'faction', sy.faction, 'mine', v_own,
    'v', pl.value, 'home', pl.home, 's', v_s, 'stage', case when v_s is not null then loyalty_stage_of(v_s) end,
    'capital', loyalty_capital(p_system), 'grace', case when v_g > now() then v_g end,
    'goal', case when v_s is not null then capture_goal(p_system) end, 'base', game_setting_int('capture_seconds', 60),
    'next_at', next_payout_at());

  if v_own then
    select coalesce(jsonb_agg(jsonb_build_object('at', l.at, 'value', l.value * v_side, 'delta', l.delta * v_side) order by l.at), '[]'::jsonb)
      into v_hist from (select * from planet_loyalty_log where system_id = p_system and owner = sy.faction order by at desc limit 10) l;
    select * into w from loyalty_sweeps where system_id = p_system and status = 'go' order by started_at desc limit 1;
    select max(started_at) into v_last from loyalty_sweeps where system_id = p_system and status in ('ok', 'fail');
    v_res := v_res || jsonb_build_object(
      'forecast', loyalty_calc(p_system), 'history', v_hist,
      'last_delta', case when pl.last_delta is not null then pl.last_delta * v_side end, 'last_rows', coalesce(pl.last_rows, '[]'::jsonb), 'last_at', pl.last_at,
      'cells', (select coalesce(jsonb_agg(jsonb_build_object('faction', c.faction, 'level', c.level, 'since', c.created_at)), '[]'::jsonb)
                  from loyalty_cells c where c.system_id = p_system and c.faction <> sy.faction),
      'militia_k', loyalty_militia_k(p_system),
      'sweep', jsonb_build_object(
        'active', case when w.id is not null then jsonb_build_object('id', w.id, 'started_at', w.started_at, 'resolves_at', w.resolves_at) end,
        'block', loyalty_sweep_block(p_system, v_me),
        'chance', loyalty_sweep_chance(p_system), 'garrison', loyalty_garrison(p_system),
        'need', game_setting_int('loyalty_sweep_need', 5), 'cost', game_setting_int('loyalty_sweep_cost', 300),
        'minutes', game_setting_int('loyalty_sweep_min', 120),
        'cd_until', case when v_last is not null then v_last + make_interval(hours => game_setting_int('loyalty_sweep_cd_h', 24)) end,
        'last', (select jsonb_build_object('status', x.status, 'at', x.resolves_at, 'chance', x.chance) from loyalty_sweeps x
                  where x.system_id = p_system and x.status in ('ok', 'fail') order by x.started_at desc limit 1)),
      'effects', (select coalesce(jsonb_agg(jsonb_build_object('kind', fe.kind, 'value', fe.value, 'title', fe.title, 'source', fe.source, 'ends', fe.ends_at)), '[]'::jsonb)
                    from faction_effects fe where fe.faction = sy.faction and (fe.system_id is null or fe.system_id = p_system)
                     and fe.kind = 'loyalty' and fe.starts_at <= now() and fe.ends_at > now()));
  elsif v_fac in ('republic', 'cis') and v_s is not null then
    select level into v_cell from loyalty_cells where system_id = p_system and faction = v_fac;
    v_bat := loyalty_battle(p_system);
    v_res := v_res || jsonb_build_object(
      'cell', v_cell, 'agit_cd', loyalty_agit_cd(p_system, v_fac),
      'partisans', case when loyalty_capital(p_system) or (v_g is not null and v_g > now()) then 0
                        else least(9, coalesce(v_cell, 0) * 2 + case when v_s <= -80 then 3 when v_s <= -50 and v_cell is not null then 1 else 0 end) end,
      'intel', case when v_bat ->> 'reveal' = v_fac then jsonb_build_object(
          'infantry', (select count(*) from unit_positions x join unit_types t on t.id = x.unit_type
                        where x.system_id = p_system and x.layer = 'ground' and x.hp > 0 and x.x is not null and x.faction = sy.faction
                          and not t.is_vehicle and not coalesce(t.is_hero, false) and is_in_settlement_zone(x.x, x.y)),
          'vehicles', (select count(*) from unit_positions x join unit_types t on t.id = x.unit_type
                        where x.system_id = p_system and x.layer = 'ground' and x.hp > 0 and x.x is not null and x.faction = sy.faction and t.is_vehicle),
          'heroes', (select count(*) from unit_positions x join unit_types t on t.id = x.unit_type
                        where x.system_id = p_system and x.layer = 'ground' and x.hp > 0 and x.x is not null and x.faction = sy.faction and coalesce(t.is_hero, false)),
          'militia', settlement_militia_count(p_system)) end);
  end if;
  return v_res;
end;
$$;

-- ── DEV-панель ────────────────────────────────────────────────────
create or replace function public.dev_loyalty(p_system text, p_value integer, p_cell_faction text default null, p_cell_level integer default null)
returns jsonb language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare v_me uuid := dev_assert(); v_del text := 'del' || 'ete from ';
begin
  if not exists (select 1 from planet_loyalty where system_id = p_system) then raise exception 'У планеты нет шкалы настроений'; end if;
  if p_value is not null then
    if p_value < -100 or p_value > 100 then raise exception 'Шкала от −100 до 100'; end if;
    perform loyalty_set(p_system, p_value, null, 'dev');
  end if;
  if p_cell_faction is not null then
    if p_cell_faction not in ('republic', 'cis') then raise exception 'Сторона — republic или cis'; end if;
    if coalesce(p_cell_level, 0) <= 0 then
      execute v_del || 'loyalty_cells where system_id = $1 and faction = $2' using p_system, p_cell_faction;
    else
      insert into loyalty_cells (system_id, faction, level) values (p_system, p_cell_faction, least(3, p_cell_level))
      on conflict (system_id, faction) do update set level = excluded.level, updated_at = now();
    end if;
  end if;
  perform dev_note(v_me, 'loyalty', null, p_system, jsonb_build_object('value', p_value, 'cell', p_cell_faction, 'level', p_cell_level));
  return (select jsonb_build_object('v', value, 'cells', (select coalesce(jsonb_agg(jsonb_build_object('faction', faction, 'level', level)), '[]'::jsonb)
            from loyalty_cells where system_id = p_system)) from planet_loyalty where system_id = p_system);
end;
$$;

-- ── События в ленте ───────────────────────────────────────────────
insert into public.event_types (type, category, title, tone, jumpable) values
  ('loyalty_stage', 'faction', 'Настроения планеты', 'neutral', true),
  ('loyalty_chance', 'faction', 'Народ ждёт перемен', 'good', true),
  ('loyalty_agit', 'faction', 'Агитаторы врага', 'bad', true),
  ('loyalty_agit_caught', 'faction', 'Агитаторы задержаны', 'good', true),
  ('loyalty_cell_found', 'faction', 'Подполье врага раскрыто', 'good', true),
  ('loyalty_cell_lost', 'faction', 'Сеть подполья раскрыта', 'bad', true),
  ('loyalty_sweep', 'faction', 'Облава', 'neutral', true),
  ('partisans_raised', 'combat', 'Подполье поднялось', 'good', true),
  ('partisans_enemy', 'combat', 'Подполье встало за врага', 'bad', true)
on conflict (type) do nothing;

-- ── Законы и проект казны ─────────────────────────────────────────
update public.faction_laws set effects = effects || '[{"kind": "loyalty", "value": 1}]'::jsonb
 where id in ('rep_relief', 'cis_independence') and not effects @> '[{"kind": "loyalty"}]'::jsonb;
update public.faction_laws set effects = effects || '[{"kind": "loyalty", "value": -1}]'::jsonb
 where id in ('rep_martial', 'cis_total_war') and not effects @> '[{"kind": "loyalty"}]'::jsonb;
insert into public.treasury_projects (id, title, text, kind, value, hours, cost, sort, active) values
  ('p_holonet', 'Голопередачи', 'Казна оплачивает новости, концерты и обращения к жителям — народ теплеет к власти: поддержка +2 в сутки трое суток.', 'loyalty', 2, 72, 900, 6, true)
on conflict (id) do nothing;

-- ── Права ─────────────────────────────────────────────────────────
revoke execute on function public.loyalty_set(text, integer, jsonb, text) from public, anon, authenticated;
revoke execute on function public.loyalty_day(text) from public, anon, authenticated;
revoke execute on function public.loyalty_calc(text) from public, anon, authenticated;
revoke execute on function public.raise_partisans(text, text) from public, anon, authenticated;
revoke execute on function public.loyalty_agitate_resolve(uuid) from public, anon, authenticated;
revoke execute on function public.loyalty_sweep_finish(uuid) from public, anon, authenticated;
revoke execute on function public.loyalty_tick() from public, anon, authenticated;
revoke execute on function public.loyalty_battle(text) from public, anon, authenticated;
revoke execute on function public.loyalty_sweep_block(text, uuid) from public, anon, authenticated;
revoke execute on function public.loyalty_on_capture() from public, anon, authenticated;
revoke execute on function public.loyalty_map() from public, anon;
revoke execute on function public.loyalty_state(text) from public, anon;
revoke execute on function public.loyalty_sweep(text) from public, anon;
revoke execute on function public.spy_agitate(uuid, text) from public, anon;
revoke execute on function public.dev_loyalty(text, integer, text, integer) from public, anon;
grant execute on function public.loyalty_map() to authenticated;
grant execute on function public.loyalty_state(text) to authenticated;
grant execute on function public.loyalty_sweep(text) to authenticated;
grant execute on function public.spy_agitate(uuid, text) to authenticated;
grant execute on function public.dev_loyalty(text, integer, text, integer) to authenticated;

-- ── Цели тайных операций: планеты врага в досягаемости, с агитацией ─
create or replace function public.spy_targets(p_group uuid)
returns jsonb language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare v_me uuid := auth.uid(); g spy_groups; v_ops boolean := loyalty_on('ops');
begin
  select * into g from spy_groups where id = p_group and owner_user_id = v_me and status <> 'lost';
  if not found then raise exception 'Группа не найдена'; end if;
  return (select coalesce(jsonb_agg(p order by (p->>'jumps')::integer, p->>'system_name'), '[]'::jsonb) from (
    select jsonb_build_object('system_id', sy.id, 'system_name', sy.name, 'jumps', spy_jumps(g.base_system, sy.id),
             'held', sc.controller_user_id is not null,       -- ник управляющего врагу не раскрываем
             'victim_full', sc.controller_user_id is not null
                            and (select count(*) from spy_ops o where o.victim = sc.controller_user_id and o.launched_at > now() - interval '24 hours'
                                  and o.result is distinct from 'void') >= 2,
             'arrive', now() + make_interval(mins => spy_jumps(g.base_system, sy.id) * game_setting_int('spy_jump_min', 30)),
             'chance', spy_chance_known(g.wins, now() + make_interval(mins => spy_jumps(g.base_system, sy.id) * game_setting_int('spy_jump_min', 30)
                                                                       + game_setting_int('spy_approach_min', 15))),
             'sites', case when sc.controller_user_id is null or sc.controller_user_id = v_me then '[]'::jsonb else (
                       select coalesce(jsonb_agg(jsonb_build_object('building_id', ms.building_id, 'code', bt.code, 'name', bt.name,
                         'resource', ms.resource, 'res_name', r.name, 'color', r.color, 'places', ms.places,
                         'refine', mine_is_refine(ms.resource),
                         'cooldown_until', (select max(o.launched_at) + interval '24 hours' from spy_ops o where o.target_building = ms.building_id
                                             and o.launched_at > now() - interval '24 hours' and o.result is distinct from 'void'))
                         order by bt.name), '[]'::jsonb)
                         from mine_sites ms join buildings bd on bd.id = ms.building_id join building_types bt on bt.id = bd.building_type_id
                         join resources r on r.id = ms.resource
                        where ms.system_id = sy.id and not ms.gone and bd.faction is not distinct from sy.faction) end,
             -- агитация (sql/loyalty.sql): поддержка хозяина, наша сеть, когда снова можно, шанс без учёта гарнизона
             'agit', case when v_ops then jsonb_build_object(
                       's', loyalty_support(sy.id), 'capital', loyalty_capital(sy.id),
                       'cell', (select c.level from loyalty_cells c where c.system_id = sy.id and c.faction = g.faction),
                       'cd_until', loyalty_agit_cd(sy.id, g.faction),
                       'chance', greatest(10, least(90, spy_chance_known(g.wins, now() + make_interval(mins => spy_jumps(g.base_system, sy.id) * game_setting_int('spy_jump_min', 30)
                                                                       + game_setting_int('spy_approach_min', 15))) - loyalty_agit_pen(sy.id))),
                       'cost', game_setting_int('loyalty_agit_cost', 250), 'gain', game_setting_int('loyalty_agit_gain', 4)) end) p
      from systems sy left join system_control sc on sc.system_id = sy.id
     where sy.id <> g.base_system and not coalesce(sy.is_deep_space, false)
       and sy.faction in ('republic', 'cis') and sy.faction <> g.faction
       and spy_jumps(g.base_system, sy.id) between 1 and game_setting_int('spy_max_jumps', 3)
       and ((sc.controller_user_id is not null and sc.controller_user_id <> v_me
             and exists (select 1 from mine_sites ms where ms.system_id = sy.id and not ms.gone))
            or v_ops)) q);
end;
$$;

-- ── Встраивание в действующие функции (точечные вставки, повторный прогон их не дублирует) ─
do $do$
declare d text; n text;
begin
  -- settlement_tick: шкала настроений — после напряжения, до дохода (доход «Предана» входит в эти же сутки)
  d := pg_get_functiondef('public.settlement_tick()'::regprocedure);
  if position('loyalty_day' in d) = 0 then
    n := $a$    begin perform unrest_day(sys.id, v_fed, v_eff, v_controller); exception when others then perform err_db('settlement_tick', sqlstate, sqlerrm, true); null; end;$a$;
    if position(n in d) = 0 then raise exception 'settlement_tick: место встраивания не найдено'; end if;
    d := replace(d, n, n || $a$
    -- настроения планеты (sql/loyalty.sql): сбой шкалы выплату не срывает
    begin perform loyalty_day(sys.id); exception when others then perform err_db('settlement_tick', sqlstate, sqlerrm, true); null; end;$a$);
    execute d;
  end if;

  -- unrest_calc: народ ропщет на власть — напряжение растёт
  d := pg_get_functiondef('public.unrest_calc(text, boolean, integer)'::regprocedure);
  if position('loyalty_support' in d) = 0 then
    n := $a$  -- гасители$a$;
    if position(n in d) = 0 then raise exception 'unrest_calc: место встраивания не найдено'; end if;
    d := replace(d, n, $a$  -- настроения планеты (sql/loyalty.sql): ропот на власть и подполье в городе
  if loyalty_on('effects') and coalesce(loyalty_support(p_system), 0) <= -20 then
    if loyalty_support(p_system) <= -50 then v_up := v_up + 5; v_rows := v_rows || jsonb_build_object('label', 'Подполье в городе', 'value', 5);
    else v_up := v_up + 3; v_rows := v_rows || jsonb_build_object('label', 'Народ ропщет на власть', 'value', 3); end if;
  end if;

$a$ || n);
    execute d;
  end if;

  -- capture_tick: срок захвата — снимок полосы, подполье встаёт на старте захвата, расходится после
  d := pg_get_functiondef('public.capture_tick()'::regprocedure);
  if position('capture_goal(' in d) = 0 then
    n := $a$  v_progress numeric; v_rate integer; v_status text; v_faction text;$a$;
    if position(n in d) = 0 then raise exception 'capture_tick: объявления не найдены'; end if;
    d := replace(d, n, n || $a$ v_g integer;$a$);

    n := $a$          raise warning 'raise_militia %: %', sysrec.id, sqlerrm;
        end;
$a$;
    if position(n in d) = 0 then raise exception 'capture_tick: сбор ополчения не найден'; end if;
    d := replace(d, n, n || $a$
        -- Подполье: сеть и народ, ждущий врага, встают за наступающих (sql/loyalty.sql)
        begin
          perform raise_partisans(sysrec.id, c.attacker_faction);
        exception when others then perform err_db('capture_tick', sqlstate, sqlerrm, true);
          raise warning 'raise_partisans %: %', sysrec.id, sqlerrm;
        end;
$a$);

    n := $a$    if v_progress >= v_goal then$a$;
    if position(n in d) = 0 then raise exception 'capture_tick: проверка захвата не найдена'; end if;
    d := replace(d, n, $a$    -- Срок захвата — снимок на старте полосы: настроения планеты (sql/loyalty.sql)
    if v_row is null or v_row.goal is null or v_row.status = 'distribution' or v_progress <= 0
       or v_row.faction is distinct from v_faction then
      v_g := capture_goal(sysrec.id);
    else
      v_g := v_row.goal;
    end if;

    if v_progress >= v_g then$a$);

    n := $a$      where nb.unit_id = u.id and nb.kind = 'militia' and u.system_id = sysrec.id;$a$;
    if position(n in d) = 0 then raise exception 'capture_tick: роспуск ополчения не найден'; end if;
    d := replace(d, n, $a$      where nb.unit_id = u.id and nb.kind in ('militia', 'partisan') and u.system_id = sysrec.id;$a$);

    n := $a$       or v_row.status is distinct from v_status then

      insert into system_capture (system_id, faction, progress, rate, status, updated_at)
      values (sysrec.id, v_faction, v_progress, v_rate, v_status, now())
      on conflict (system_id) do update
        set faction = excluded.faction, progress = excluded.progress,
            rate = excluded.rate, status = excluded.status,
            updated_at = excluded.updated_at;$a$;
    if position(n in d) = 0 then raise exception 'capture_tick: запись полосы не найдена'; end if;
    d := replace(d, n, $a$       or v_row.status is distinct from v_status
       or v_row.goal is distinct from v_g then

      insert into system_capture (system_id, faction, progress, rate, status, updated_at, goal)
      values (sysrec.id, v_faction, v_progress, v_rate, v_status, now(), v_g)
      on conflict (system_id) do update
        set faction = excluded.faction, progress = excluded.progress,
            rate = excluded.rate, status = excluded.status,
            updated_at = excluded.updated_at, goal = excluded.goal;$a$);
    execute d;
  end if;

  -- rt_ground_state: срок полосы и разведка подполья — серверу боя 2.0
  d := pg_get_functiondef('public.rt_ground_state(text)'::regprocedure);
  if position('loyalty_battle' in d) = 0 then
    n := $a$                                          'goal', game_setting_int('capture_seconds', 60))$a$;
    if position(n in d) = 0 then raise exception 'rt_ground_state: срок в полосе не найден'; end if;
    d := replace(d, n, $a$                                          'goal', case when c.status = 'distribution' then capture_goal(p_system) else coalesce(c.goal, capture_goal(p_system)) end)$a$);
    n := $a$    'capture_goal', game_setting_int('capture_seconds', 60),$a$;
    if position(n in d) = 0 then raise exception 'rt_ground_state: срок захвата не найден'; end if;
    d := replace(d, n, $a$    'capture_goal', coalesce((select sc.goal from system_capture sc where sc.system_id = p_system and sc.status <> 'distribution'), capture_goal(p_system)),
    'loyalty', loyalty_battle(p_system),$a$);
    execute d;
  end if;

  -- get_faction_overview: срок у каждой полосы свой
  d := pg_get_functiondef('public.get_faction_overview()'::regprocedure);
  if position('cgoal' in d) = 0 then
    n := $a$    select sc.system_id, sc.faction, sc.status, sc.rate,$a$;
    if position(n in d) = 0 then raise exception 'get_faction_overview: caps не найден'; end if;
    d := replace(d, n, $a$    select sc.system_id, sc.faction, sc.status, sc.rate, sc.goal,$a$);
    n := $a$           c.status cstatus, c.faction cfaction, c.progress cprogress, c.rate crate,$a$;
    if position(n in d) = 0 then raise exception 'get_faction_overview: planets не найден'; end if;
    d := replace(d, n, n || $a$ coalesce(c.goal, v_goal) cgoal,$a$);
    n := $a$'progress', round(p.cprogress, 1), 'rate', p.crate, 'goal', v_goal) end)$a$;
    if position(n in d) = 0 then raise exception 'get_faction_overview: capture планеты не найден'; end if;
    d := replace(d, n, $a$'progress', round(p.cprogress, 1), 'rate', p.crate, 'goal', p.cgoal) end)$a$);
    n := $a$'progress', round(c.progress, 1), 'rate', c.rate, 'goal', v_goal,$a$;
    if position(n in d) = 0 then raise exception 'get_faction_overview: captures не найден'; end if;
    d := replace(d, n, $a$'progress', round(c.progress, 1), 'rate', c.rate, 'goal', coalesce(c.goal, v_goal),$a$);
    n := $a$ceil((v_goal - c.progress) / c.rate)$a$;
    if position(n in d) = 0 then raise exception 'get_faction_overview: seconds_left не найден'; end if;
    d := replace(d, n, $a$ceil((coalesce(c.goal, v_goal) - c.progress) / c.rate)$a$);
    execute d;
  end if;

  -- get_settlement_dev: почему ополчение не встанет и множитель настроений
  d := pg_get_functiondef('public.get_settlement_dev(text)'::regprocedure);
  if position('settlement_militia_why' in d) = 0 then
    n := $a$        'count', settlement_militia_count(p_system_id),$a$;
    if position(n in d) = 0 then raise exception 'get_settlement_dev: ополчение не найдено'; end if;
    d := replace(d, n, n || $a$ 'why', settlement_militia_why(p_system_id), 'k', loyalty_militia_k(p_system_id),$a$);
    execute d;
  end if;

  -- npc_tick: подполье расходится, когда планета своя или захват кончился
  d := pg_get_functiondef('public.npc_tick()'::regprocedure);
  if position('partisan' in d) = 0 then
    n := $a$  where b.unit_id = u.id and b.kind = 'militia' and s.id = b.system_id
    and s.faction is distinct from u.faction;
$a$;
    if position(n in d) = 0 then raise exception 'npc_tick: роспуск при смене хозяев не найден'; end if;
    d := replace(d, n, n || $a$
  -- Подполье (sql/loyalty.sql): планета перешла к своим — бойцы подполья расходятся по домам
  delete from unit_positions u
  using npc_brains b, systems s
  where b.unit_id = u.id and b.kind = 'partisan' and s.id = b.system_id
    and s.faction is not distinct from u.faction;
$a$);
    n := $a$                      and box_gap(e.x, e.y, 1, 1, z.x, z.y, z.size, z.size) <= 6));
$a$;
    if position(n in d) = 0 then raise exception 'npc_tick: тревога ополчения не найдена'; end if;
    d := replace(d, n, n || $a$
  -- Подполье держится, пока идёт полоса захвата и в кольце стоит живой боец его стороны (игрока)
  update npc_brains b set aggro_until = now()
  from unit_positions pu
  where b.kind = 'partisan' and pu.id = b.unit_id
    and exists (select 1 from system_capture c where c.system_id = b.system_id and c.status <> 'distribution')
    and exists (select 1 from unit_positions x
                 where x.system_id = b.system_id and x.layer = 'ground' and x.hp > 0 and x.x is not null
                   and x.faction = pu.faction and x.owner_user_id is not null and is_in_settlement_zone(x.x, x.y));
$a$);
    n := $a$  where b.unit_id = u.id and b.kind = 'militia'
    and coalesce(b.aggro_until, b.created_at) < now() - interval '3 minutes';$a$;
    if position(n in d) = 0 then raise exception 'npc_tick: роспуск по тишине не найден'; end if;
    d := replace(d, n, $a$  where b.unit_id = u.id and b.kind in ('militia', 'partisan')
    and coalesce(b.aggro_until, b.created_at) < now() - interval '3 minutes';$a$);
    execute d;
  end if;

  -- npc_militia_act: общие глаза — только у своих (ополчение с ополчением, подполье с подпольем)
  d := pg_get_functiondef('public.npc_militia_act(uuid)'::regprocedure);
  if position('mb.kind = br.kind' in d) = 0 then
    n := $a$  where mb.kind = 'militia' and mb.system_id = br.system_id and mb.unit_id <> p_unit$a$;
    if position(n in d) = 0 then raise exception 'npc_militia_act: общие глаза не найдены'; end if;
    d := replace(d, n, $a$  where mb.kind = br.kind and mb.system_id = br.system_id and mb.unit_id <> p_unit and m.faction = me.faction$a$);
    execute d;
  end if;

  -- npc_return_fire: по подполью, как и по ополчению, прикрытие не бьёт
  d := pg_get_functiondef('public.npc_return_fire(uuid, uuid)'::regprocedure);
  if position('partisan' in d) = 0 then
    n := $a$  if not found or br.kind = 'militia' then return 0; end if;$a$;
    if position(n in d) = 0 then raise exception 'npc_return_fire: проверка вида не найдена'; end if;
    d := replace(d, n, $a$  if not found or br.kind in ('militia', 'partisan') then return 0; end if;$a$);
    execute d;
  end if;

  -- spy_resolve: агитация решается своей функцией
  d := pg_get_functiondef('public.spy_resolve(uuid)'::regprocedure);
  if position('loyalty_agitate_resolve' in d) = 0 then
    n := $a$  select * into o from spy_ops where id = p_op and status = 'go' for update;
  if not found then return; end if;
$a$;
    if position(n in d) = 0 then raise exception 'spy_resolve: начало не найдено'; end if;
    d := replace(d, n, n || $a$  -- агитация — без цели-постройки (sql/loyalty.sql)
  if o.kind = 'agitate' then perform loyalty_agitate_resolve(p_op); return; end if;
$a$);
    execute d;
  end if;
end $do$;

-- Правка 29.10 (проверка): подполье без живых бойцов своей стороны расходится — переписать уже вставленный текст npc_tick
do $do$
declare d text; o text; n text;
begin
  d := pg_get_functiondef('public.npc_tick()'::regprocedure);
  o := $a$  -- Подполье держится, пока идёт полоса захвата
  update npc_brains b set aggro_until = now()
  where b.kind = 'partisan'
    and exists (select 1 from system_capture c where c.system_id = b.system_id and c.status <> 'distribution');
$a$;
  n := $a$  -- Подполье держится, пока идёт полоса захвата и в кольце стоит живой боец его стороны (игрока)
  update npc_brains b set aggro_until = now()
  from unit_positions pu
  where b.kind = 'partisan' and pu.id = b.unit_id
    and exists (select 1 from system_capture c where c.system_id = b.system_id and c.status <> 'distribution')
    and exists (select 1 from unit_positions x
                 where x.system_id = b.system_id and x.layer = 'ground' and x.hp > 0 and x.x is not null
                   and x.faction = pu.faction and x.owner_user_id is not null and is_in_settlement_zone(x.x, x.y));
$a$;
  if position(o in d) > 0 then execute replace(d, o, n); end if;
end $do$;

-- Донесения: эффект «Народ предан» подписан как настроения, а не казна
do $do$
declare d text; o text := $a$when source in ('unrest', 'riot', 'riot_end') then 'Напряжение · '$a$;
begin
  d := pg_get_functiondef('public.report_list()'::regprocedure);
  if position('Настроения · ' in d) = 0 and position(o in d) > 0 then
    execute replace(d, o, o || $a$ when source = 'loyalty' then 'Настроения · '$a$);
  end if;
end $do$;

-- Полосы, начатые до настроений, дотягивают со старым сроком (не обрываются мгновенно)
update public.system_capture set goal = greatest(game_setting_int('capture_seconds', 60), ceil(progress)::integer)
 where goal is null and status <> 'distribution';

-- Помощники с security definer — только для функций базы (иначе гарнизон чужой планеты виден из консоли)
revoke execute on function public.loyalty_garrison(text) from public, anon, authenticated;
revoke execute on function public.loyalty_sweep_chance(text) from public, anon, authenticated;
revoke execute on function public.loyalty_agit_chance(text, integer, timestamptz) from public, anon, authenticated;
revoke execute on function public.loyalty_agit_pen(text) from public, anon, authenticated;
revoke execute on function public.loyalty_agit_cd(text, text) from public, anon, authenticated;
revoke execute on function public.loyalty_support(text) from public, anon, authenticated;
revoke execute on function public.loyalty_grace_until(text) from public, anon, authenticated;
revoke execute on function public.loyalty_militia_k(text) from public, anon, authenticated;
revoke execute on function public.capture_goal(text) from public, anon, authenticated;
revoke execute on function public.settlement_militia_count(text) from public, anon, authenticated;
revoke execute on function public.settlement_militia_why(text) from public, anon, authenticated;

-- Облавы — раз в 2 минуты
do $do$
begin
  if not exists (select 1 from cron.job where command like '%loyalty_tick%') then
    perform cron.schedule('loyalty_tick', '*/2 * * * *', 'select public.loyalty_tick()');
  end if;
end $do$;
