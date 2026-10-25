-- ⚠ НЕ ПРИМЕНЯТЬ ПОВТОРНО ЦЕЛИКОМ (аудит 25.10.2026). Файл устарел относительно базы: его прогон откатит
--   13 функций mine_* — потеряются переделы (sql/mine_refine.sql), охрана, караул, испорченный паёк (sql/mine_sabotage.sql), порядок блокировок (sql/audit_2026_10_25.sql).
--   Нужна функция отсюда — бери её текущую версию из базы (pg_get_functiondef), а не из этого файла.
-- Добыча через участки и рабочих — шаг 1 (24.10.2026). План — claude/mining-plan.md.
--
-- Добывающее здание (produces_resource без consumes) становится участком: бригада людей и дроидов
-- работает сменами. Смена = длина × темп × сколько рабочих. Добытое копится за смену и по её концу
-- ложится на склад участка, оттуда — на склад планеты, сколько влезет (каждую минуту).
-- Люди: короткие смены выгоднее в час, отдых дольше, паёк — 1 еда за смену.
-- Дроиды: ровнее по длине, отдых короче, обслуживание — 1 руда за смену. Без пайка/обслуживания — ×0,8.
-- Автосмена (8/12/16 ч) сама начинается, когда бригада отдохнула (дроиды первыми, затем люди; лишние сменяют отдыхающих). Аврал: ×1,35, отдых ×1,5, ~10 % травм/поломок на 12 ч.
-- Старое начисление production_tick для участков отключено; переделы — как раньше.
-- Ставка: 1,25 в час на рабочего (основной ресурс; попутный — половина). 6 дроидов на автосмене 8 ч ≈ 120 в сутки.

-- ---------------------------------------------------------------- настройки
insert into public.game_settings (key, value) values
  ('mine_rate_x100', '125'), ('mine_places_start', '6'), ('mine_staff_per_place', '2'),
  ('mine_hire_human', '150'), ('mine_hire_droid', '300'), ('mine_site_cap', '300'),
  ('mine_hungry_pct', '80'), ('mine_rush_hurt_pct', '10'), ('mine_hurt_hours', '12')
on conflict (key) do nothing;

-- ---------------------------------------------------------------- таблицы
create table if not exists public.mine_sites (
  building_id uuid primary key,
  system_id text not null,
  resource text not null,
  humans integer not null default 0 check (humans >= 0),
  droids integer not null default 0 check (droids >= 0),
  places integer not null default 6,
  stock integer not null default 0,
  lost integer not null default 0,
  humans_rest_until timestamptz,
  droids_rest_until timestamptz,
  auto_on boolean not null default true,
  auto_len integer not null default 8,
  auto_pace text not null default 'normal',
  worked_hours numeric not null default 0,
  gone boolean not null default false,
  created_at timestamptz not null default now()
);
create table if not exists public.mine_shifts (
  id uuid primary key default gen_random_uuid(),
  building_id uuid not null,
  system_id text not null,
  resource text not null,
  started_at timestamptz not null default now(),
  ends_at timestamptz not null,
  ended_at timestamptz,
  len_h integer not null,
  pace text not null,
  humans integer not null default 0,
  droids integer not null default 0,
  fed_h boolean not null default true,
  fed_d boolean not null default true,
  base_rate numeric not null,
  accrued numeric not null default 0,
  delivered integer not null default 0,
  lost integer not null default 0,
  last_tick timestamptz not null default now(),
  status text not null default 'run',
  auto boolean not null default false,
  started_by uuid
);
create unique index if not exists mine_shifts_one_run on public.mine_shifts (building_id) where status = 'run';
create index if not exists mine_shifts_site on public.mine_shifts (building_id, started_at desc);
create table if not exists public.mine_hurt (
  id bigserial primary key,
  building_id uuid not null,
  kind text not null,
  n integer not null,
  until timestamptz not null
);
create index if not exists mine_hurt_site on public.mine_hurt (building_id, until);
alter table public.mine_sites enable row level security;
alter table public.mine_shifts enable row level security;
alter table public.mine_hurt enable row level security;

update public.event_types set title = 'Добыча' where type = 'resource_extracted';

-- ---------------------------------------------------------------- числа
-- длина смены → множитель выработки в час (h — люди, d — дроиды)
create or replace function public.mine_len_k(p_kind text, p_len integer) returns numeric
language sql immutable set search_path to 'public', 'pg_temp' as $$
  select case when p_kind = 'h' then
    case p_len when 1 then 1.40 when 2 then 1.25 when 4 then 1.10 when 8 then 1.00 when 12 then 0.85 when 16 then 0.70 end
  else
    case p_len when 1 then 0.95 when 2 then 0.92 when 4 then 0.90 when 8 then 0.85 when 12 then 0.82 when 16 then 0.80 end
  end;
$$;
create or replace function public.mine_pace_k(p_pace text) returns numeric
language sql immutable set search_path to 'public', 'pg_temp' as $$
  select case p_pace when 'careful' then 0.80 when 'rush' then 1.35 else 1.00 end;
$$;
-- отдых после смены, минуты: люди — половина отработанного (не меньше часа), дроиды — четверть (не меньше 30 мин)
create or replace function public.mine_rest_min(p_kind text, p_hours numeric, p_pace text) returns integer
language sql immutable set search_path to 'public', 'pg_temp' as $$
  select case when p_kind = 'h' then greatest(60, round(p_hours * 30 * case p_pace when 'careful' then 0.5 when 'rush' then 1.5 else 1 end))
              else greatest(30, round(p_hours * 15 * case p_pace when 'careful' then 0.5 when 'rush' then 1.5 else 1 end)) end::integer;
$$;
-- залежь: основная 1, попутная 0,5, нет — 0
create or replace function public.mine_res_k(p_system_id text, p_resource text) returns numeric
language sql stable set search_path to 'public', 'pg_temp' as $$
  select coalesce((select case when s.primary_resource = p_resource then 1.0 when s.secondary_resource = p_resource then 0.5 else 0 end
                   from systems s where s.id = p_system_id), 0);
$$;
-- выработка в час без эффектов планеты
create or replace function public.mine_rate_h(p_system_id text, p_resource text, p_humans integer, p_droids integer,
                                              p_len integer, p_pace text, p_fed_h boolean, p_fed_d boolean) returns numeric
language sql stable set search_path to 'public', 'pg_temp' as $$
  select game_setting_int('mine_rate_x100', 125) / 100.0 * mine_res_k(p_system_id, p_resource) * mine_pace_k(p_pace)
       * (p_humans * mine_len_k('h', p_len) * case when p_fed_h then 1 else game_setting_int('mine_hungry_pct', 80) / 100.0 end
        + p_droids * mine_len_k('d', p_len) * case when p_fed_d then 1 else game_setting_int('mine_hungry_pct', 80) / 100.0 end);
$$;
-- сколько рабочих вида можно поставить на смену: всего − травмы − уже на смене; отдыхающих нет
create or replace function public.mine_avail(p_building uuid, p_kind text) returns integer
language sql stable set search_path to 'public', 'pg_temp' as $$
  select greatest(0,
           (select case when p_kind = 'h' then ms.humans else ms.droids end from mine_sites ms where ms.building_id = p_building)
         - coalesce((select sum(n) from mine_hurt h where h.building_id = p_building and h.kind = p_kind and h.until > now()), 0)
         - coalesce((select case when p_kind = 'h' then sh.humans else sh.droids end from mine_shifts sh where sh.building_id = p_building and sh.status = 'run'), 0))::integer;
$$;
create or replace function public.mine_rested(p_building uuid, p_kind text) returns boolean
language sql stable set search_path to 'public', 'pg_temp' as $$
  select coalesce((select case when p_kind = 'h' then ms.humans_rest_until else ms.droids_rest_until end from mine_sites ms where ms.building_id = p_building), now()) <= now();
$$;

-- ---------------------------------------------------------------- участок
-- Участок для готового добывающего здания своей фракции: стартовая бригада — 6 дроидов на автосмене 8 ч
create or replace function public.mine_site_ensure(p_building uuid) returns boolean
language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare b record;
begin
  if exists (select 1 from mine_sites where building_id = p_building) then return true; end if;
  select bd.id, bd.system_id, bd.faction, bd.completes_at, bt.produces_resource res, bt.consumes, s.faction sys_faction
    into b
  from buildings bd join building_types bt on bt.id = bd.building_type_id join systems s on s.id = bd.system_id
  where bd.id = p_building;
  if not found or b.res is null or b.consumes <> '{}'::jsonb then return false; end if;
  if b.completes_at is not null and b.completes_at > now() then return false; end if;
  insert into mine_sites (building_id, system_id, resource, droids, places)
  values (p_building, b.system_id, b.res, game_setting_int('mine_places_start', 6), game_setting_int('mine_places_start', 6))
  on conflict (building_id) do nothing;
  return true;
end;
$$;

-- Начать смену (без проверок прав): паёк людям — еда, обслуживание дроидам — руда; нет — работают на ×0,8
create or replace function public.mine_start(p_building uuid, p_len integer, p_pace text, p_humans integer, p_droids integer,
                                             p_auto boolean, p_by uuid) returns uuid
language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare s mine_sites; v_fh boolean := true; v_fd boolean := true; v_id uuid; v_have integer;
begin
  select * into s from mine_sites where building_id = p_building for update;
  if p_humans > 0 then
    select amount into v_have from planet_stock where system_id = s.system_id and resource = 'food' for update;
    if coalesce(v_have, 0) >= p_humans then update planet_stock set amount = amount - p_humans where system_id = s.system_id and resource = 'food';
    else v_fh := false; end if;
  end if;
  if p_droids > 0 then
    select amount into v_have from planet_stock where system_id = s.system_id and resource = 'ore' for update;
    if coalesce(v_have, 0) >= p_droids then update planet_stock set amount = amount - p_droids where system_id = s.system_id and resource = 'ore';
    else v_fd := false; end if;
  end if;
  insert into mine_shifts (building_id, system_id, resource, ends_at, len_h, pace, humans, droids, fed_h, fed_d, base_rate, auto, started_by)
  values (p_building, s.system_id, s.resource, now() + make_interval(hours => p_len), p_len, p_pace, p_humans, p_droids, v_fh, v_fd,
          mine_rate_h(s.system_id, s.resource, p_humans, p_droids, p_len, p_pace, v_fh, v_fd), p_auto, p_by)
  returning id into v_id;
  return v_id;
end;
$$;

-- Досчитать смену до момента (или до конца) по текущим эффектам планеты (законы, события, забастовки)
create or replace function public.mine_accrue(p_shift uuid) returns void
language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare sh mine_shifts; v_to timestamptz; v_h numeric;
begin
  select * into sh from mine_shifts where id = p_shift and status = 'run' for update;
  if not found then return; end if;
  v_to := least(now(), sh.ends_at);
  v_h := extract(epoch from v_to - sh.last_tick) / 3600.0;
  if v_h <= 0 then return; end if;
  update mine_shifts
     set accrued = accrued + base_rate * greatest(0, 100 + effect_sum(system_id, 'extract')) / 100.0 * v_h,
         last_tick = v_to
   where id = p_shift;
end;
$$;

-- Закончить смену: добытое — на склад участка (сверх его предела теряется), отдых, травмы после аврала, сводка хозяину
create or replace function public.mine_finish(p_shift uuid, p_status text) returns integer
language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare sh mine_shifts; s mine_sites; v_got integer; v_put integer; v_end timestamptz; v_hours numeric; v_n integer;
  v_ctrl uuid; v_fac text; v_hurt integer := game_setting_int('mine_rush_hurt_pct', 10);
begin
  perform mine_accrue(p_shift);
  select * into sh from mine_shifts where id = p_shift and status = 'run' for update;
  if not found then return 0; end if;
  select * into s from mine_sites where building_id = sh.building_id for update;
  v_end := least(now(), sh.ends_at);
  v_hours := greatest(0, extract(epoch from v_end - sh.started_at) / 3600.0);
  v_got := case when p_status = 'lost' then 0 else round(sh.accrued)::integer end;
  v_put := least(v_got, greatest(0, game_setting_int('mine_site_cap', 300) - coalesce(s.stock, 0)));
  update mine_shifts set status = p_status, ended_at = v_end, delivered = v_got, lost = v_got - v_put where id = p_shift;
  if s.building_id is null then return v_got; end if;
  update mine_sites
     set stock = stock + v_put, lost = lost + (v_got - v_put),
         worked_hours = worked_hours + v_hours * (sh.humans + sh.droids),
         humans_rest_until = case when sh.humans > 0 then greatest(coalesce(humans_rest_until, now()), v_end + make_interval(mins => mine_rest_min('h', v_hours, sh.pace))) else humans_rest_until end,
         droids_rest_until = case when sh.droids > 0 then greatest(coalesce(droids_rest_until, now()), v_end + make_interval(mins => mine_rest_min('d', v_hours, sh.pace))) else droids_rest_until end
   where building_id = sh.building_id;
  -- аврал: травмы людей и поломки дроидов (в среднем v_hurt %)
  if sh.pace = 'rush' and p_status = 'done' then
    v_n := floor(sh.humans * v_hurt / 100.0 + random())::integer;
    if v_n > 0 then insert into mine_hurt (building_id, kind, n, until) values (sh.building_id, 'h', v_n, now() + make_interval(hours => game_setting_int('mine_hurt_hours', 12))); end if;
    v_n := floor(sh.droids * v_hurt / 100.0 + random())::integer;
    if v_n > 0 then insert into mine_hurt (building_id, kind, n, until) values (sh.building_id, 'd', v_n, now() + make_interval(hours => game_setting_int('mine_hurt_hours', 12))); end if;
  end if;
  if v_got > 0 then
    select sc.controller_user_id, s2.faction into v_ctrl, v_fac
      from systems s2 left join system_control sc on sc.system_id = s2.id where s2.id = sh.system_id;
    if v_ctrl is not null then
      perform log_event_digest(v_ctrl, v_fac, 'resource_extracted', sh.system_id || ':' || sh.resource, sh.system_id,
        (select name from systems where id = sh.system_id), (select name from resources where id = sh.resource), v_got,
        case when v_got > v_put then 'склад участка полон, потеряно ' || (v_got - v_put) end);
    end if;
  end if;
  return v_got;
end;
$$;

-- Склад участка → склад планеты, сколько влезет
create or replace function public.mine_flush(p_building uuid) returns integer
language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare s mine_sites; v integer;
begin
  select * into s from mine_sites where building_id = p_building for update;
  if not found or s.stock <= 0 then return 0; end if;
  v := add_planet_stock(s.system_id, s.resource, s.stock);
  if v > 0 then update mine_sites set stock = stock - v where building_id = p_building; end if;
  return v;
end;
$$;

-- Участок работает? Здание на месте, достроено, своей фракции, участок не брошен
create or replace function public.mine_site_ok(p_building uuid) returns boolean
language sql stable set search_path to 'public', 'pg_temp' as $$
  select exists (select 1 from buildings bd join systems s on s.id = bd.system_id
                 where bd.id = p_building and (bd.completes_at is null or bd.completes_at <= now())
                   and bd.faction is not distinct from s.faction);
$$;

-- Оценка добычи в сутки по автосмене (всей бригадой, с пайком, по текущим эффектам)
create or replace function public.mine_day_estimate(p_building uuid) returns integer
language plpgsql stable security definer set search_path to 'public', 'pg_temp' as $$
declare s mine_sites; v_h integer; v_d integer; v_rate numeric; v_rest integer;
begin
  select * into s from mine_sites where building_id = p_building;
  if not found or not s.auto_on or s.gone then return 0; end if;
  v_d := least(s.droids, s.places); v_h := least(s.humans, s.places - v_d);
  if v_h + v_d = 0 then return 0; end if;
  v_rate := mine_rate_h(s.system_id, s.resource, v_h, v_d, s.auto_len, s.auto_pace, true, true)
          * greatest(0, 100 + effect_sum(s.system_id, 'extract')) / 100.0;
  v_rest := greatest(case when v_h > 0 then mine_rest_min('h', s.auto_len, s.auto_pace) else 0 end,
                     case when v_d > 0 then mine_rest_min('d', s.auto_len, s.auto_pace) else 0 end);
  return floor(v_rate * s.auto_len * 24.0 / (s.auto_len + v_rest / 60.0))::integer;
end;
$$;

-- ---------------------------------------------------------------- тик (раз в минуту)
create or replace function public.mine_tick() returns void
language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare r record; v_h integer; v_d integer;
begin
  -- новые участки: готовые добывающие здания своей фракции
  for r in select bd.id from buildings bd join building_types bt on bt.id = bd.building_type_id join systems s on s.id = bd.system_id
           where bt.produces_resource is not null and bt.consumes = '{}'::jsonb
             and (bd.completes_at is null or bd.completes_at <= now()) and bd.faction is not distinct from s.faction
             and not exists (select 1 from mine_sites ms where ms.building_id = bd.id) loop
    begin perform mine_site_ensure(r.id);
    exception when others then perform err_db('mine_tick', sqlstate, sqlerrm, true); end;
  end loop;
  -- идущие смены
  for r in select id, building_id, ends_at from mine_shifts where status = 'run' loop
    begin
      if not mine_site_ok(r.building_id) then
        perform mine_finish(r.id, 'lost');
        update mine_sites set auto_on = false, gone = not exists (select 1 from buildings where id = r.building_id) where building_id = r.building_id;
      elsif now() >= r.ends_at then perform mine_finish(r.id, 'done');
      else perform mine_accrue(r.id);
      end if;
    exception when others then perform err_db('mine_tick', sqlstate, sqlerrm, true); end;
  end loop;
  -- автосмены: бригада отдохнула — новая смена всеми свободными (дроиды первыми), не больше мест
  for r in select ms.* from mine_sites ms where ms.auto_on and not ms.gone
             and not exists (select 1 from mine_shifts sh where sh.building_id = ms.building_id and sh.status = 'run') loop
    begin
      if not mine_site_ok(r.building_id) then
        update mine_sites set auto_on = false, gone = not exists (select 1 from buildings where id = r.building_id) where building_id = r.building_id;
        continue;
      end if;
      if mine_res_k(r.system_id, r.resource) <= 0 or is_capture_active(r.system_id) then continue; end if;
      v_h := case when mine_rested(r.building_id, 'h') then mine_avail(r.building_id, 'h') else 0 end;
      v_d := case when mine_rested(r.building_id, 'd') then mine_avail(r.building_id, 'd') else 0 end;
      v_d := least(v_d, r.places); v_h := least(v_h, r.places - v_d);    -- дроиды первыми: долгие смены — их работа
      if v_h + v_d > 0 then perform mine_start(r.building_id, r.auto_len, r.auto_pace, v_h, v_d, true, null); end if;
    exception when others then perform err_db('mine_tick', sqlstate, sqlerrm, true); end;
  end loop;
  -- склад участка → склад планеты
  for r in select building_id from mine_sites where stock > 0 and not gone loop
    begin perform mine_flush(r.building_id);
    exception when others then perform err_db('mine_tick', sqlstate, sqlerrm, true); end;
  end loop;
end;
$$;

-- ---------------------------------------------------------------- игроку
-- Участок, которым управляет игрок: хозяин планеты, здание готово и своей фракции
create or replace function public.mine_own(p_building uuid) returns mine_sites
language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare b record; s mine_sites;
begin
  if auth.uid() is null then raise exception 'Не авторизован'; end if;
  select bd.system_id, bd.faction, bd.completes_at, bt.produces_resource res, bt.consumes, sy.faction sys_faction
    into b from buildings bd join building_types bt on bt.id = bd.building_type_id join systems sy on sy.id = bd.system_id
   where bd.id = p_building;
  if not found then raise exception 'Постройка не найдена'; end if;
  if b.res is null or b.consumes <> '{}'::jsonb then raise exception 'Это не добывающая постройка'; end if;
  if not exists (select 1 from system_control sc where sc.system_id = b.system_id and sc.controller_user_id = auth.uid()) then
    raise exception 'Участком управляет хозяин планеты';
  end if;
  if b.completes_at is not null and b.completes_at > now() then raise exception 'Постройка ещё не достроена'; end if;
  if b.faction is distinct from b.sys_faction then raise exception 'Трофейная постройка не работает на нового хозяина — её можно только снести'; end if;
  perform mine_site_ensure(p_building);
  select * into s from mine_sites where building_id = p_building for update;
  return s;
end;
$$;

create or replace function public.mine_site_state(p_building uuid) returns jsonb
language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare s mine_sites; sh mine_shifts; v_eff integer; v_last jsonb; v_hurt jsonb; v_res record; v_run jsonb;
begin
  s := mine_own(p_building);
  select * into sh from mine_shifts where building_id = p_building and status = 'run';
  if found then perform mine_accrue(sh.id); select * into sh from mine_shifts where id = sh.id; end if;
  v_eff := effect_sum(s.system_id, 'extract');
  select r.id, r.name, r.color into v_res from resources r where r.id = s.resource;
  v_run := case when sh.id is null then null else jsonb_build_object(
    'id', sh.id, 'started_at', sh.started_at, 'ends_at', sh.ends_at, 'len', sh.len_h, 'pace', sh.pace,
    'humans', sh.humans, 'droids', sh.droids, 'fed_h', sh.fed_h, 'fed_d', sh.fed_d, 'auto', sh.auto,
    'accrued', round(sh.accrued, 2), 'rate', round(sh.base_rate * greatest(0, 100 + v_eff) / 100.0, 3)) end;
  select coalesce(jsonb_agg(jsonb_build_object('started_at', x.started_at, 'ended_at', x.ended_at, 'len', x.len_h, 'pace', x.pace,
           'humans', x.humans, 'droids', x.droids, 'got', x.delivered, 'lost', x.lost, 'status', x.status, 'auto', x.auto,
           'fed', x.fed_h and x.fed_d) order by x.started_at desc), '[]'::jsonb)
    into v_last
  from (select * from mine_shifts where building_id = p_building and status <> 'run' order by started_at desc limit 6) x;
  select coalesce(jsonb_agg(jsonb_build_object('kind', kind, 'n', n, 'until', until) order by until), '[]'::jsonb) into v_hurt
  from mine_hurt where building_id = p_building and until > now();
  return jsonb_build_object(
    'building_id', p_building, 'system_id', s.system_id,
    'res', jsonb_build_object('id', v_res.id, 'name', v_res.name, 'color', v_res.color), 'res_k', mine_res_k(s.system_id, s.resource),
    'humans', s.humans, 'droids', s.droids, 'places', s.places, 'staff_max', s.places * game_setting_int('mine_staff_per_place', 2),
    'avail_h', mine_avail(p_building, 'h'), 'avail_d', mine_avail(p_building, 'd'),
    'rest_h', case when s.humans_rest_until > now() then s.humans_rest_until end,
    'rest_d', case when s.droids_rest_until > now() then s.droids_rest_until end,
    'hurt', v_hurt, 'stock', s.stock, 'site_cap', game_setting_int('mine_site_cap', 300), 'lost', s.lost,
    'auto', jsonb_build_object('on', s.auto_on, 'len', s.auto_len, 'pace', s.auto_pace), 'day', mine_day_estimate(p_building),
    'run', v_run, 'last', v_last, 'eff', v_eff, 'capture', is_capture_active(s.system_id),
    'planet', jsonb_build_object(
      'cap', planet_stock_cap(s.system_id),
      'res', coalesce((select amount from planet_stock where system_id = s.system_id and resource = s.resource), 0),
      'food', coalesce((select amount from planet_stock where system_id = s.system_id and resource = 'food'), 0),
      'ore', coalesce((select amount from planet_stock where system_id = s.system_id and resource = 'ore'), 0)),
    'credits', (select credits from profiles where id = auth.uid()),
    'cfg', jsonb_build_object(
      'rate', game_setting_int('mine_rate_x100', 125) / 100.0, 'hungry', game_setting_int('mine_hungry_pct', 80) / 100.0,
      'hire_h', game_setting_int('mine_hire_human', 150), 'hire_d', game_setting_int('mine_hire_droid', 300),
      'hurt_pct', game_setting_int('mine_rush_hurt_pct', 10), 'hurt_hours', game_setting_int('mine_hurt_hours', 12),
      'lens', jsonb_build_array(1, 2, 4, 8, 12, 16), 'auto_lens', jsonb_build_array(8, 12, 16),
      'k_h', (select jsonb_object_agg(l, mine_len_k('h', l)) from unnest(array[1, 2, 4, 8, 12, 16]) l),
      'k_d', (select jsonb_object_agg(l, mine_len_k('d', l)) from unnest(array[1, 2, 4, 8, 12, 16]) l),
      'pace', jsonb_build_object('careful', mine_pace_k('careful'), 'normal', 1, 'rush', mine_pace_k('rush')),
      'rest', jsonb_build_object('careful', 0.5, 'normal', 1, 'rush', 1.5)));
end;
$$;

create or replace function public.mine_hire(p_building uuid, p_kind text, p_n integer) returns jsonb
language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare s mine_sites; v_cost integer; v_cr integer;
begin
  s := mine_own(p_building);
  if p_kind not in ('h', 'd') then raise exception 'Неизвестный вид рабочих'; end if;
  if p_n is null or p_n < 1 or p_n > 50 then raise exception 'Некорректное число'; end if;
  if s.humans + s.droids + p_n > s.places * game_setting_int('mine_staff_per_place', 2) then
    raise exception 'В бараке нет места: всего не больше % рабочих', s.places * game_setting_int('mine_staff_per_place', 2);
  end if;
  v_cost := p_n * case when p_kind = 'h' then game_setting_int('mine_hire_human', 150) else game_setting_int('mine_hire_droid', 300) end;
  select credits into v_cr from profiles where id = auth.uid() for update;
  if coalesce(v_cr, 0) < v_cost then raise exception 'Недостаточно кредитов: нужно %', v_cost; end if;
  update profiles set credits = credits - v_cost where id = auth.uid();
  update mine_sites set humans = humans + case when p_kind = 'h' then p_n else 0 end,
                        droids = droids + case when p_kind = 'd' then p_n else 0 end
   where building_id = p_building;
  return mine_site_state(p_building);
end;
$$;

create or replace function public.mine_fire(p_building uuid, p_kind text, p_n integer) returns jsonb
language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare s mine_sites; v_busy integer;
begin
  s := mine_own(p_building);
  if p_kind not in ('h', 'd') then raise exception 'Неизвестный вид рабочих'; end if;
  if p_n is null or p_n < 1 then raise exception 'Некорректное число'; end if;
  select coalesce(case when p_kind = 'h' then humans else droids end, 0) into v_busy from mine_shifts where building_id = p_building and status = 'run';
  if p_n > (case when p_kind = 'h' then s.humans else s.droids end) - coalesce(v_busy, 0) then
    raise exception 'Столько свободных нет: на смене рабочих не увольняют';
  end if;
  update mine_sites set humans = humans - case when p_kind = 'h' then p_n else 0 end,
                        droids = droids - case when p_kind = 'd' then p_n else 0 end
   where building_id = p_building;
  return mine_site_state(p_building);
end;
$$;

create or replace function public.mine_shift_start(p_building uuid, p_len integer, p_pace text, p_humans integer, p_droids integer) returns jsonb
language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare s mine_sites;
begin
  s := mine_own(p_building);
  perform assert_planet_operational(s.system_id);
  if p_len not in (1, 2, 4, 8, 12, 16) then raise exception 'Нет такой длины смены'; end if;
  if p_pace not in ('careful', 'normal', 'rush') then raise exception 'Нет такого темпа'; end if;
  p_humans := coalesce(p_humans, 0); p_droids := coalesce(p_droids, 0);
  if p_humans < 0 or p_droids < 0 or p_humans + p_droids < 1 then raise exception 'Выбери, кто выйдет на смену'; end if;
  if p_humans + p_droids > s.places then raise exception 'Мест работы на участке: %', s.places; end if;
  if mine_res_k(s.system_id, s.resource) <= 0 then raise exception 'На планете нет залежи'; end if;
  if exists (select 1 from mine_shifts where building_id = p_building and status = 'run') then raise exception 'Смена уже идёт'; end if;
  if p_humans > 0 and not mine_rested(p_building, 'h') then raise exception 'Люди ещё отдыхают'; end if;
  if p_droids > 0 and not mine_rested(p_building, 'd') then raise exception 'Дроиды ещё на обслуживании'; end if;
  if p_humans > mine_avail(p_building, 'h') then raise exception 'Свободных людей: %', mine_avail(p_building, 'h'); end if;
  if p_droids > mine_avail(p_building, 'd') then raise exception 'Свободных дроидов: %', mine_avail(p_building, 'd'); end if;
  perform mine_start(p_building, p_len, p_pace, p_humans, p_droids, false, auth.uid());
  return mine_site_state(p_building);
end;
$$;

create or replace function public.mine_shift_stop(p_building uuid) returns jsonb
language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare s mine_sites; v_id uuid;
begin
  s := mine_own(p_building);
  select id into v_id from mine_shifts where building_id = p_building and status = 'run';
  if v_id is null then raise exception 'Смена не идёт'; end if;
  perform mine_finish(v_id, 'stopped');
  perform mine_flush(p_building);
  return mine_site_state(p_building);
end;
$$;

create or replace function public.mine_auto_set(p_building uuid, p_on boolean, p_len integer, p_pace text) returns jsonb
language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare s mine_sites;
begin
  s := mine_own(p_building);
  if p_len not in (8, 12, 16) then raise exception 'Автосмена — 8, 12 или 16 часов'; end if;
  if p_pace not in ('careful', 'normal', 'rush') then raise exception 'Нет такого темпа'; end if;
  update mine_sites set auto_on = coalesce(p_on, false), auto_len = p_len, auto_pace = p_pace where building_id = p_building;
  return mine_site_state(p_building);
end;
$$;

-- ---------------------------------------------------------------- совмещение
-- Склад планеты: «в сутки» для участков — оценка автосмены
create or replace function public.get_planet_stock(p_system_id text)
 returns table(resource text, name text, kind text, amount integer, cap integer, is_primary boolean, is_secondary boolean, per_day integer, color text)
 language sql stable security definer set search_path to 'public', 'extensions', 'pg_temp'
as $function$
  select r.id, r.name, r.kind,
         coalesce(ps.amount, 0),
         planet_stock_cap(p_system_id),
         s.primary_resource = r.id,
         s.secondary_resource = r.id,
         coalesce((
           select sum(case
                        when ms.building_id is not null then mine_day_estimate(b.id)
                        when s.primary_resource = bt.produces_resource
                          then bt.produces_per_day
                        when s.secondary_resource = bt.produces_resource
                          then bt.produces_per_day / 2
                        else bt.produces_per_day
                      end)::integer
           from buildings b join building_types bt on bt.id = b.building_type_id
           left join mine_sites ms on ms.building_id = b.id
           where b.system_id = p_system_id
             and bt.produces_resource = r.id
             and (b.completes_at is null or b.completes_at <= now())
         ), 0),
         r.color
  from systems s
  cross join resources r
  left join planet_stock ps on ps.system_id = s.id and ps.resource = r.id
  where s.id = p_system_id
    and (exists (select 1 from system_control sc
                 where sc.system_id = p_system_id
                   and sc.controller_user_id = auth.uid())
         or exists (select 1 from production_leases l
                    where l.system_id = p_system_id and l.lessee_id = auth.uid()
                      and l.status = 'active' and lease_is_live(l)))
  order by r.sort_order;
$function$;

-- production_tick: добычу участков больше не начисляет (переделы — как раньше)
do $$
declare d text; a text := $a$where bt.produces_resource is not null$a$;
  b text := $b$where bt.produces_resource is not null
      and (bt.consumes <> '{}'::jsonb or not exists (select 1 from mine_sites ms where ms.building_id = bd.id))$b$;
begin
  d := pg_get_functiondef('public.production_tick'::regproc);
  if position('mine_sites' in d) = 0 then
    if position(a in d) = 0 then raise exception 'production_tick: место правки не найдено'; end if;
    execute replace(d, a, b);
  end if;
end $$;

-- обучение: добыча теперь сменами
update public.tutorial_steps set
  mentor_republic = 'Армия ест сырьё. Поставь добычу на то, что залегает на твоей планете. Постройка — это участок с бригадой: шесть дроидов-рабочих уже на месте и сами выходят на смену, добытое приходит по концу каждой смены. Тапни постройку, чтобы нанять людей, выбрать длину и темп смен. Если залежей нет — ставь переработку, например плавильню: она делает дюрасталь из руды. У склада есть предел, хранилище его поднимает.',
  mentor_cis = 'Производство требует сырья. Разместите добывающее предприятие на имеющейся залежи. Предприятие — это участок: бригада из шести дроидов-рабочих выходит на смены автоматически, добыча поступает по окончании каждой смены. Нажмите на постройку, чтобы нанять рабочих и задать длину и темп смен. При отсутствии залежей используйте переработку — плавильня получает дюрасталь из руды. Вместимость склада ограничена, хранилище её увеличивает.'
where id = 'economy';

-- права: игроку — свои функции, остальное — только сервису
do $$
declare f text;
begin
  foreach f in array array['mine_len_k(text,integer)', 'mine_pace_k(text)', 'mine_rest_min(text,numeric,text)', 'mine_res_k(text,text)',
    'mine_rate_h(text,text,integer,integer,integer,text,boolean,boolean)', 'mine_avail(uuid,text)', 'mine_rested(uuid,text)',
    'mine_site_ensure(uuid)', 'mine_start(uuid,integer,text,integer,integer,boolean,uuid)', 'mine_accrue(uuid)', 'mine_finish(uuid,text)',
    'mine_flush(uuid)', 'mine_site_ok(uuid)', 'mine_day_estimate(uuid)', 'mine_tick()', 'mine_own(uuid)'] loop
    execute 'revoke all on function public.' || f || ' from public, anon, authenticated';
  end loop;
  foreach f in array array['mine_site_state(uuid)', 'mine_hire(uuid,text,integer)', 'mine_fire(uuid,text,integer)',
    'mine_shift_start(uuid,integer,text,integer,integer)', 'mine_shift_stop(uuid)', 'mine_auto_set(uuid,boolean,integer,text)'] loop
    execute 'revoke all on function public.' || f || ' from public, anon';
    execute 'grant execute on function public.' || f || ' to authenticated';
  end loop;
end $$;

-- раз в минуту
select cron.schedule('mine-tick', '* * * * *', $$select public.mine_tick()$$);
