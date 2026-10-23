-- Добыча через участки — шаг 3, глубина (24.10.2026). План — claude/mining-plan.md.
--
-- Специалисты: бригадир (+10 % к выработке, вдвое меньше травм в аврале; 1, при 14+ местах — 2) и техник
-- (чинит оборудование, 1 % износа в час каждый; до места/6 + 1). Охрана — в шаге 4 вместе с диверсиями.
-- Износ оборудования 0–100 %: растёт за отработанные часы (люди 0,08 %, дроиды 0,18 % на рабочего в час;
-- бережно ×0,5, аврал ×2; «Мастерские» ×0,7), выработка ×(1 − износ × 0,004) — при 100 % ×0,6.
-- Задачи смены (ручной): добыча; вскрыша (×0,2, следующей добыче +25 %); разведка жилы (без выхода, шанс
-- богатой жилы +40 % на 24 ч); обслуживание (без выхода, −2 % износа на рабочего в час, техники +50 %).
-- Опыт бригады: звёзды за отработанные рабочие-часы (150/400/900/1800/3500), +3 % за звезду.
-- Места работы: 6 → 10 → 14 → 18 за кредиты и дюрасталь/электронику со склада планеты.
-- Районы: «Госпиталь» — травмы людей вдвое короче; «Мастерские» — поломки дроидов вдвое короче и износ ×0,7;
-- «Рынок» — найм −20 %; «Склады» — склад участка +300.
-- Напряжение планеты: авралы и смены без пайка за сутки поднимают, бережная работа — снижает (unrest_calc).

insert into public.game_settings (key, value) values
  ('mine_hire_foreman', '600'), ('mine_hire_tech', '400'),
  ('mine_wear_h_x100', '8'), ('mine_wear_d_x100', '18'), ('mine_tech_repair_x100', '100')
on conflict (key) do nothing;

alter table public.mine_sites add column if not exists foremen integer not null default 0;
alter table public.mine_sites add column if not exists techs integer not null default 0;
alter table public.mine_sites add column if not exists wear numeric not null default 0;
alter table public.mine_sites add column if not exists prep_bonus integer not null default 0;
alter table public.mine_sites add column if not exists vein_until timestamptz;
alter table public.mine_shifts add column if not exists task text not null default 'extract';
alter table public.mine_shifts add column if not exists mult numeric not null default 1;
alter table public.mine_shifts add column if not exists result text;

-- уже работающим участкам — техник, как у новых
update public.mine_sites set techs = 1 where techs = 0;

-- ---------------------------------------------------------------- числа
create or replace function public.mine_stars(p_hours numeric) returns integer
language sql immutable set search_path to 'public', 'pg_temp' as $$
  select case when p_hours >= 3500 then 5 when p_hours >= 1800 then 4 when p_hours >= 900 then 3
              when p_hours >= 400 then 2 when p_hours >= 150 then 1 else 0 end;
$$;
create or replace function public.mine_star_next(p_hours numeric) returns integer
language sql immutable set search_path to 'public', 'pg_temp' as $$
  select case when p_hours < 150 then 150 when p_hours < 400 then 400 when p_hours < 900 then 900
              when p_hours < 1800 then 1800 when p_hours < 3500 then 3500 end;
$$;
create or replace function public.mine_site_cap(p_system text) returns integer
language sql stable set search_path to 'public', 'pg_temp' as $$
  select game_setting_int('mine_site_cap', 300) + case when settlement_has_district(p_system, 'warehouses') then 300 else 0 end;
$$;
create or replace function public.mine_max_foremen(p_places integer) returns integer
language sql immutable set search_path to 'public', 'pg_temp' as $$ select case when p_places >= 14 then 2 else 1 end; $$;
create or replace function public.mine_max_techs(p_places integer) returns integer
language sql immutable set search_path to 'public', 'pg_temp' as $$ select p_places / 6 + 1; $$;
create or replace function public.mine_task_k(p_task text) returns numeric
language sql immutable set search_path to 'public', 'pg_temp' as $$
  select case p_task when 'prep' then 0.2 when 'survey' then 0 when 'maint' then 0 else 1 end;
$$;
-- множитель участка к выработке: бригадиры, опыт, износ, жила, вскрыша (только для добычи)
create or replace function public.mine_mult(p_building uuid, p_task text) returns numeric
language sql stable set search_path to 'public', 'pg_temp' as $$
  select (1 + 0.10 * least(s.foremen, mine_max_foremen(s.places)))
       * (1 + 0.03 * mine_stars(s.worked_hours))
       * (1 - least(100, greatest(0, s.wear)) * 0.004)
       * case when s.vein_until > now() then 1.4 else 1 end
       * case when coalesce(p_task, 'extract') = 'extract' then 1 + s.prep_bonus / 100.0 else 1 end
  from mine_sites s where s.building_id = p_building;
$$;
-- следующее улучшение мест: [места, кредиты, дюрасталь, электроника] или null
create or replace function public.mine_upgrade_cost(p_places integer) returns jsonb
language sql immutable set search_path to 'public', 'pg_temp' as $$
  select case when p_places < 10 then '{"places": 10, "credits": 2500, "durasteel": 60, "electronics": 0}'::jsonb
              when p_places < 14 then '{"places": 14, "credits": 5000, "durasteel": 120, "electronics": 40}'::jsonb
              when p_places < 18 then '{"places": 18, "credits": 9000, "durasteel": 200, "electronics": 80}'::jsonb end;
$$;

-- ---------------------------------------------------------------- участок
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
  insert into mine_sites (building_id, system_id, resource, droids, places, techs)
  values (p_building, b.system_id, b.res, game_setting_int('mine_places_start', 6), game_setting_int('mine_places_start', 6), 1)
  on conflict (building_id) do nothing;
  return true;
end;
$$;

-- Начать смену с задачей (без проверок прав): паёк людям — еда, обслуживание дроидам — руда; нет — ×0,8.
-- Множитель участка замораживается на смену; вскрыша для добычи тратится при старте.
create or replace function public.mine_start(p_building uuid, p_len integer, p_pace text, p_humans integer, p_droids integer,
                                             p_auto boolean, p_by uuid, p_task text) returns uuid
language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare s mine_sites; v_fh boolean := true; v_fd boolean := true; v_id uuid; v_have integer; v_mult numeric; v_task text := coalesce(p_task, 'extract');
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
  v_mult := coalesce(mine_mult(p_building, v_task), 1);
  if v_task = 'extract' and s.prep_bonus > 0 then update mine_sites set prep_bonus = 0 where building_id = p_building; end if;
  insert into mine_shifts (building_id, system_id, resource, ends_at, len_h, pace, humans, droids, fed_h, fed_d, base_rate, auto, started_by, task, mult)
  values (p_building, s.system_id, s.resource, now() + make_interval(hours => p_len), p_len, p_pace, p_humans, p_droids, v_fh, v_fd,
          mine_rate_h(s.system_id, s.resource, p_humans, p_droids, p_len, p_pace, v_fh, v_fd) * v_mult * mine_task_k(v_task),
          p_auto, p_by, v_task, v_mult)
  returning id into v_id;
  return v_id;
end;
$$;
-- прежняя подпись (без задачи) — добыча
create or replace function public.mine_start(p_building uuid, p_len integer, p_pace text, p_humans integer, p_droids integer,
                                             p_auto boolean, p_by uuid) returns uuid
language sql security definer set search_path to 'public', 'pg_temp' as $$
  select mine_start(p_building, p_len, p_pace, p_humans, p_droids, p_auto, p_by, 'extract');
$$;

-- Закончить смену: добытое — на склад участка, износ, итог задачи, отдых, травмы после аврала, сводка хозяину
create or replace function public.mine_finish(p_shift uuid, p_status text) returns integer
language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare sh mine_shifts; s mine_sites; v_got integer; v_put integer; v_end timestamptz; v_hours numeric; v_n integer;
  v_ctrl uuid; v_fac text; v_hurt numeric := game_setting_int('mine_rush_hurt_pct', 10); v_wear numeric; v_pw numeric;
  v_res text; v_hh integer; v_hd integer; v_full boolean; v_chance numeric;
begin
  perform mine_accrue(p_shift);
  select * into sh from mine_shifts where id = p_shift and status = 'run' for update;
  if not found then return 0; end if;
  select * into s from mine_sites where building_id = sh.building_id for update;
  v_end := least(now(), sh.ends_at);
  v_hours := greatest(0, extract(epoch from v_end - sh.started_at) / 3600.0);
  v_full := v_hours >= sh.len_h * 0.5;                        -- задача засчитывается, если отработали хотя бы половину
  v_got := case when p_status = 'lost' then 0 else round(sh.accrued)::integer end;
  if s.building_id is null then
    update mine_shifts set status = p_status, ended_at = v_end, delivered = v_got where id = p_shift;
    return v_got;
  end if;
  v_put := least(v_got, greatest(0, mine_site_cap(s.system_id) - coalesce(s.stock, 0)));
  -- износ: отработанные часы бригады; обслуживание — наоборот, чинит
  v_pw := case sh.pace when 'careful' then 0.5 when 'rush' then 2 else 1 end
        * case when settlement_has_district(s.system_id, 'workshops') then 0.7 else 1 end;
  if sh.task = 'maint' then
    v_wear := - (sh.humans + sh.droids) * v_hours * 2 * (1 + 0.5 * least(s.techs, mine_max_techs(s.places)));
    v_res := 'износ −' || round(least(s.wear, -v_wear))::integer || ' %';
  else
    v_wear := v_hours * v_pw * (sh.humans * game_setting_int('mine_wear_h_x100', 8) + sh.droids * game_setting_int('mine_wear_d_x100', 18)) / 100.0
            * case when sh.task = 'survey' then 0.5 else 1 end;
  end if;
  if sh.task = 'prep' and p_status <> 'lost' then
    if v_full then update mine_sites set prep_bonus = 25 where building_id = sh.building_id; v_res := 'вскрыша готова: следующая добыча +25 %';
    else v_res := 'вскрыша не закончена'; end if;
  elsif sh.task = 'survey' and p_status <> 'lost' then
    v_chance := least(0.6, 0.12 * v_hours * (sh.humans + sh.droids) / 6.0);
    if random() < v_chance then
      update mine_sites set vein_until = greatest(coalesce(vein_until, now()), now()) + interval '24 hours' where building_id = sh.building_id;
      v_res := 'найдена богатая жила: +40 % на 24 ч';
    else v_res := 'жилы не нашли (шанс был ' || round(v_chance * 100)::integer || ' %)'; end if;
  end if;
  update mine_shifts set status = p_status, ended_at = v_end, delivered = v_got, lost = v_got - v_put, result = v_res where id = p_shift;
  update mine_sites
     set stock = stock + v_put, lost = lost + (v_got - v_put),
         wear = least(100, greatest(0, wear + v_wear)),
         worked_hours = worked_hours + case when sh.task = 'extract' then v_hours * (sh.humans + sh.droids) else 0 end,
         humans_rest_until = case when sh.humans > 0 then greatest(coalesce(humans_rest_until, now()), v_end + make_interval(mins => mine_rest_min('h', v_hours, sh.pace))) else humans_rest_until end,
         droids_rest_until = case when sh.droids > 0 then greatest(coalesce(droids_rest_until, now()), v_end + make_interval(mins => mine_rest_min('d', v_hours, sh.pace))) else droids_rest_until end
   where building_id = sh.building_id;
  -- аврал: травмы людей и поломки дроидов; бригадир — вдвое реже; госпиталь и мастерские — вдвое короче
  if sh.pace = 'rush' and p_status = 'done' then
    if s.foremen > 0 then v_hurt := v_hurt / 2; end if;
    v_hh := game_setting_int('mine_hurt_hours', 12) * case when settlement_has_district(s.system_id, 'hospital') then 0.5 else 1 end;
    v_hd := game_setting_int('mine_hurt_hours', 12) * case when settlement_has_district(s.system_id, 'workshops') then 0.5 else 1 end;
    v_n := floor(sh.humans * v_hurt / 100.0 + random())::integer;
    if v_n > 0 then insert into mine_hurt (building_id, kind, n, until) values (sh.building_id, 'h', v_n, now() + make_interval(hours => v_hh)); end if;
    v_n := floor(sh.droids * v_hurt / 100.0 + random())::integer;
    if v_n > 0 then insert into mine_hurt (building_id, kind, n, until) values (sh.building_id, 'd', v_n, now() + make_interval(hours => v_hd)); end if;
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

-- Оценка добычи в сутки по автосмене (всей бригадой, с пайком, с множителем участка и эффектами)
create or replace function public.mine_day_estimate(p_building uuid) returns integer
language plpgsql stable security definer set search_path to 'public', 'pg_temp' as $$
declare s mine_sites; v_h integer; v_d integer; v_rate numeric; v_rest integer;
begin
  select * into s from mine_sites where building_id = p_building;
  if not found or not s.auto_on or s.gone then return 0; end if;
  v_d := least(s.droids, s.places); v_h := least(s.humans, s.places - v_d);
  if v_h + v_d = 0 then return 0; end if;
  v_rate := mine_rate_h(s.system_id, s.resource, v_h, v_d, s.auto_len, s.auto_pace, true, true)
          * coalesce(mine_mult(p_building, 'extract'), 1)
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
  -- техники чинят оборудование: каждый — 1 % в час (тик раз в минуту)
  begin
    update mine_sites
       set wear = greatest(0, wear - least(techs, mine_max_techs(places)) * game_setting_int('mine_tech_repair_x100', 100) / 100.0 / 60.0)
     where wear > 0 and techs > 0 and not gone;
  exception when others then perform err_db('mine_tick', sqlstate, sqlerrm, true); end;
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
      if v_h + v_d > 0 then perform mine_start(r.building_id, r.auto_len, r.auto_pace, v_h, v_d, true, null, 'extract'); end if;
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
create or replace function public.mine_site_state(p_building uuid) returns jsonb
language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare s mine_sites; sh mine_shifts; v_eff integer; v_last jsonb; v_hurt jsonb; v_res record; v_run jsonb; v_market boolean;
begin
  s := mine_own(p_building);
  select * into sh from mine_shifts where building_id = p_building and status = 'run';
  if found then perform mine_accrue(sh.id); select * into sh from mine_shifts where id = sh.id; end if;
  v_eff := effect_sum(s.system_id, 'extract');
  v_market := settlement_has_district(s.system_id, 'market');
  select r.id, r.name, r.color into v_res from resources r where r.id = s.resource;
  v_run := case when sh.id is null then null else jsonb_build_object(
    'id', sh.id, 'started_at', sh.started_at, 'ends_at', sh.ends_at, 'len', sh.len_h, 'pace', sh.pace, 'task', sh.task, 'mult', round(sh.mult, 3),
    'humans', sh.humans, 'droids', sh.droids, 'fed_h', sh.fed_h, 'fed_d', sh.fed_d, 'auto', sh.auto,
    'accrued', round(sh.accrued, 2), 'rate', round(sh.base_rate * greatest(0, 100 + v_eff) / 100.0, 3)) end;
  select coalesce(jsonb_agg(jsonb_build_object('started_at', x.started_at, 'ended_at', x.ended_at, 'len', x.len_h, 'pace', x.pace, 'task', x.task,
           'humans', x.humans, 'droids', x.droids, 'got', x.delivered, 'lost', x.lost, 'status', x.status, 'auto', x.auto,
           'fed', x.fed_h and x.fed_d, 'result', x.result) order by x.started_at desc), '[]'::jsonb)
    into v_last
  from (select * from mine_shifts where building_id = p_building and status <> 'run' order by started_at desc limit 6) x;
  select coalesce(jsonb_agg(jsonb_build_object('kind', kind, 'n', n, 'until', until) order by until), '[]'::jsonb) into v_hurt
  from mine_hurt where building_id = p_building and until > now();
  return jsonb_build_object(
    'building_id', p_building, 'system_id', s.system_id,
    'res', jsonb_build_object('id', v_res.id, 'name', v_res.name, 'color', v_res.color), 'res_k', mine_res_k(s.system_id, s.resource),
    'humans', s.humans, 'droids', s.droids, 'places', s.places, 'staff_max', s.places * game_setting_int('mine_staff_per_place', 2),
    'foremen', s.foremen, 'techs', s.techs, 'foremen_max', mine_max_foremen(s.places), 'techs_max', mine_max_techs(s.places),
    'avail_h', mine_avail(p_building, 'h'), 'avail_d', mine_avail(p_building, 'd'),
    'rest_h', case when s.humans_rest_until > now() then s.humans_rest_until end,
    'rest_d', case when s.droids_rest_until > now() then s.droids_rest_until end,
    'hurt', v_hurt, 'stock', s.stock, 'site_cap', mine_site_cap(s.system_id), 'lost', s.lost,
    'wear', round(s.wear, 1), 'stars', mine_stars(s.worked_hours), 'hours', round(s.worked_hours), 'hours_next', mine_star_next(s.worked_hours),
    'prep', s.prep_bonus, 'vein_until', case when s.vein_until > now() then s.vein_until end,
    'mult', round(coalesce(mine_mult(p_building, 'extract'), 1), 3),
    'upgrade', mine_upgrade_cost(s.places),
    'districts', jsonb_build_object('hospital', settlement_has_district(s.system_id, 'hospital'), 'workshops', settlement_has_district(s.system_id, 'workshops'),
                                    'market', v_market, 'warehouses', settlement_has_district(s.system_id, 'warehouses')),
    'auto', jsonb_build_object('on', s.auto_on, 'len', s.auto_len, 'pace', s.auto_pace), 'day', mine_day_estimate(p_building),
    'run', v_run, 'last', v_last, 'eff', v_eff, 'capture', is_capture_active(s.system_id),
    'planet', jsonb_build_object(
      'cap', planet_stock_cap(s.system_id),
      'res', coalesce((select amount from planet_stock where system_id = s.system_id and resource = s.resource), 0),
      'food', coalesce((select amount from planet_stock where system_id = s.system_id and resource = 'food'), 0),
      'ore', coalesce((select amount from planet_stock where system_id = s.system_id and resource = 'ore'), 0),
      'durasteel', coalesce((select amount from planet_stock where system_id = s.system_id and resource = 'durasteel'), 0),
      'electronics', coalesce((select amount from planet_stock where system_id = s.system_id and resource = 'electronics'), 0)),
    'credits', (select credits from profiles where id = auth.uid()),
    'cfg', jsonb_build_object(
      'rate', game_setting_int('mine_rate_x100', 125) / 100.0, 'hungry', game_setting_int('mine_hungry_pct', 80) / 100.0,
      'hire_h', round(game_setting_int('mine_hire_human', 150) * case when v_market then 0.8 else 1 end),
      'hire_d', round(game_setting_int('mine_hire_droid', 300) * case when v_market then 0.8 else 1 end),
      'hire_f', round(game_setting_int('mine_hire_foreman', 600) * case when v_market then 0.8 else 1 end),
      'hire_t', round(game_setting_int('mine_hire_tech', 400) * case when v_market then 0.8 else 1 end),
      'hurt_pct', game_setting_int('mine_rush_hurt_pct', 10), 'hurt_hours', game_setting_int('mine_hurt_hours', 12),
      'wear_h', game_setting_int('mine_wear_h_x100', 8) / 100.0, 'wear_d', game_setting_int('mine_wear_d_x100', 18) / 100.0,
      'lens', jsonb_build_array(1, 2, 4, 8, 12, 16), 'auto_lens', jsonb_build_array(8, 12, 16),
      'k_h', (select jsonb_object_agg(l, mine_len_k('h', l)) from unnest(array[1, 2, 4, 8, 12, 16]) l),
      'k_d', (select jsonb_object_agg(l, mine_len_k('d', l)) from unnest(array[1, 2, 4, 8, 12, 16]) l),
      'pace', jsonb_build_object('careful', mine_pace_k('careful'), 'normal', 1, 'rush', mine_pace_k('rush')),
      'rest', jsonb_build_object('careful', 0.5, 'normal', 1, 'rush', 1.5),
      'task', jsonb_build_object('extract', 1, 'prep', mine_task_k('prep'), 'survey', 0, 'maint', 0)));
end;
$$;

create or replace function public.mine_hire(p_building uuid, p_kind text, p_n integer) returns jsonb
language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare s mine_sites; v_cost integer; v_cr integer; v_price integer;
begin
  s := mine_own(p_building);
  if p_kind not in ('h', 'd', 'f', 't') then raise exception 'Неизвестный вид рабочих'; end if;
  if p_n is null or p_n < 1 or p_n > 50 then raise exception 'Некорректное число'; end if;
  if p_kind in ('h', 'd') and s.humans + s.droids + p_n > s.places * game_setting_int('mine_staff_per_place', 2) then
    raise exception 'В бараке нет места: всего не больше % рабочих', s.places * game_setting_int('mine_staff_per_place', 2);
  end if;
  if p_kind = 'f' and s.foremen + p_n > mine_max_foremen(s.places) then raise exception 'Бригадиров на участке не больше %', mine_max_foremen(s.places); end if;
  if p_kind = 't' and s.techs + p_n > mine_max_techs(s.places) then raise exception 'Техников на участке не больше %', mine_max_techs(s.places); end if;
  v_price := case p_kind when 'h' then game_setting_int('mine_hire_human', 150) when 'd' then game_setting_int('mine_hire_droid', 300)
                         when 'f' then game_setting_int('mine_hire_foreman', 600) else game_setting_int('mine_hire_tech', 400) end;
  if settlement_has_district(s.system_id, 'market') then v_price := round(v_price * 0.8); end if;
  v_cost := p_n * v_price;
  select credits into v_cr from profiles where id = auth.uid() for update;
  if coalesce(v_cr, 0) < v_cost then raise exception 'Недостаточно кредитов: нужно %', v_cost; end if;
  update profiles set credits = credits - v_cost where id = auth.uid();
  update mine_sites set humans = humans + case when p_kind = 'h' then p_n else 0 end,
                        droids = droids + case when p_kind = 'd' then p_n else 0 end,
                        foremen = foremen + case when p_kind = 'f' then p_n else 0 end,
                        techs = techs + case when p_kind = 't' then p_n else 0 end
   where building_id = p_building;
  return mine_site_state(p_building);
end;
$$;

create or replace function public.mine_fire(p_building uuid, p_kind text, p_n integer) returns jsonb
language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare s mine_sites; v_busy integer;
begin
  s := mine_own(p_building);
  if p_kind not in ('h', 'd', 'f', 't') then raise exception 'Неизвестный вид рабочих'; end if;
  if p_n is null or p_n < 1 then raise exception 'Некорректное число'; end if;
  if p_kind in ('f', 't') then
    if p_n > (case when p_kind = 'f' then s.foremen else s.techs end) then raise exception 'Столько нет'; end if;
    update mine_sites set foremen = foremen - case when p_kind = 'f' then p_n else 0 end,
                          techs = techs - case when p_kind = 't' then p_n else 0 end
     where building_id = p_building;
    return mine_site_state(p_building);
  end if;
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

create or replace function public.mine_shift_start(p_building uuid, p_len integer, p_pace text, p_humans integer, p_droids integer, p_task text) returns jsonb
language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare s mine_sites; v_task text := coalesce(p_task, 'extract');
begin
  s := mine_own(p_building);
  perform assert_planet_operational(s.system_id);
  if p_len not in (1, 2, 4, 8, 12, 16) then raise exception 'Нет такой длины смены'; end if;
  if p_pace not in ('careful', 'normal', 'rush') then raise exception 'Нет такого темпа'; end if;
  if v_task not in ('extract', 'prep', 'survey', 'maint') then raise exception 'Нет такой задачи'; end if;
  p_humans := coalesce(p_humans, 0); p_droids := coalesce(p_droids, 0);
  if p_humans < 0 or p_droids < 0 or p_humans + p_droids < 1 then raise exception 'Выбери, кто выйдет на смену'; end if;
  if p_humans + p_droids > s.places then raise exception 'Мест работы на участке: %', s.places; end if;
  if mine_res_k(s.system_id, s.resource) <= 0 and v_task <> 'maint' then raise exception 'На планете нет залежи'; end if;
  if v_task = 'maint' and s.wear <= 0 then raise exception 'Оборудование в порядке — обслуживать нечего'; end if;
  if exists (select 1 from mine_shifts where building_id = p_building and status = 'run') then raise exception 'Смена уже идёт'; end if;
  if p_humans > 0 and not mine_rested(p_building, 'h') then raise exception 'Люди ещё отдыхают'; end if;
  if p_droids > 0 and not mine_rested(p_building, 'd') then raise exception 'Дроиды ещё на обслуживании'; end if;
  if p_humans > mine_avail(p_building, 'h') then raise exception 'Свободных людей: %', mine_avail(p_building, 'h'); end if;
  if p_droids > mine_avail(p_building, 'd') then raise exception 'Свободных дроидов: %', mine_avail(p_building, 'd'); end if;
  perform mine_start(p_building, p_len, p_pace, p_humans, p_droids, false, auth.uid(), v_task);
  return mine_site_state(p_building);
end;
$$;
-- прежняя подпись (без задачи) — добыча; на случай старой страницы в кэше
create or replace function public.mine_shift_start(p_building uuid, p_len integer, p_pace text, p_humans integer, p_droids integer) returns jsonb
language sql security definer set search_path to 'public', 'pg_temp' as $$
  select mine_shift_start(p_building, p_len, p_pace, p_humans, p_droids, 'extract');
$$;

-- Улучшить участок: больше мест работы (и барак под них); кредиты игрока, сырьё — со склада планеты
create or replace function public.mine_upgrade(p_building uuid) returns jsonb
language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare s mine_sites; c jsonb; v_cr integer;
begin
  s := mine_own(p_building);
  c := mine_upgrade_cost(s.places);
  if c is null then raise exception 'Участок уже наибольший'; end if;
  perform assert_planet_operational(s.system_id);
  select credits into v_cr from profiles where id = auth.uid() for update;
  if coalesce(v_cr, 0) < (c ->> 'credits')::integer then raise exception 'Недостаточно кредитов: нужно %', c ->> 'credits'; end if;
  perform take_planet_stock(s.system_id, 'durasteel', (c ->> 'durasteel')::integer);
  perform take_planet_stock(s.system_id, 'electronics', (c ->> 'electronics')::integer);
  update profiles set credits = credits - (c ->> 'credits')::integer where id = auth.uid();
  update mine_sites set places = (c ->> 'places')::integer where building_id = p_building;
  return mine_site_state(p_building);
end;
$$;

-- ---------------------------------------------------------------- напряжение планеты
-- unrest_calc: авралы и смены без пайка за сутки поднимают напряжение, бережная работа снижает
do $$
declare d text; a text := $a$  -- гасители$a$;
  b text := $b$  -- участки добычи за сутки: авралы и голодные смены — ропот, бережная работа — спокойнее
  select count(*) filter (where sh.pace = 'rush'), count(*) filter (where not (sh.fed_h and sh.fed_d)), count(*) filter (where sh.pace = 'careful'), count(*)
    into v_mrush, v_mhungry, v_mcare, v_mall
    from mine_shifts sh where sh.system_id = p_system and sh.started_at > now() - interval '24 hours' and sh.status <> 'lost';
  if v_mrush > 0 then v_up := v_up + least(8, 3 * v_mrush); v_rows := v_rows || jsonb_build_object('label', 'Авралы на участках: ' || v_mrush, 'value', least(8, 3 * v_mrush)); end if;
  if v_mhungry > 0 then v_up := v_up + 4; v_rows := v_rows || jsonb_build_object('label', 'Бригады без пайка', 'value', 4); end if;
  if v_mall > 0 and v_mcare * 2 >= v_mall and v_mrush = 0 then v_down := v_down + 2; v_rows := v_rows || jsonb_build_object('label', 'Бережная работа на участках', 'value', -2); end if;

  -- гасители$b$;
  dv text := $c$v_rows jsonb := '[]'::jsonb; v_up integer := 0; v_down integer := 0;$c$;
  dv2 text := $e$v_rows jsonb := '[]'::jsonb; v_up integer := 0; v_down integer := 0; v_mrush integer; v_mhungry integer; v_mcare integer; v_mall integer;$e$;
begin
  d := pg_get_functiondef('public.unrest_calc(text,boolean,integer)'::regprocedure);
  if position('v_mrush' in d) = 0 then
    if position(a in d) = 0 or position(dv in d) = 0 then raise exception 'unrest_calc: место правки не найдено'; end if;
    d := replace(d, dv, dv2);
    d := replace(d, a, b);
    execute d;
  end if;
end $$;

-- ---------------------------------------------------------------- права
do $$
declare f text;
begin
  foreach f in array array['mine_stars(numeric)', 'mine_star_next(numeric)', 'mine_site_cap(text)', 'mine_max_foremen(integer)', 'mine_max_techs(integer)',
    'mine_task_k(text)', 'mine_mult(uuid,text)', 'mine_upgrade_cost(integer)', 'mine_site_ensure(uuid)',
    'mine_start(uuid,integer,text,integer,integer,boolean,uuid,text)', 'mine_start(uuid,integer,text,integer,integer,boolean,uuid)',
    'mine_finish(uuid,text)', 'mine_flush(uuid)', 'mine_day_estimate(uuid)', 'mine_tick()'] loop
    execute 'revoke all on function public.' || f || ' from public, anon, authenticated';
  end loop;
  foreach f in array array['mine_site_state(uuid)', 'mine_hire(uuid,text,integer)', 'mine_fire(uuid,text,integer)',
    'mine_shift_start(uuid,integer,text,integer,integer,text)', 'mine_shift_start(uuid,integer,text,integer,integer)', 'mine_upgrade(uuid)'] loop
    execute 'revoke all on function public.' || f || ' from public, anon';
    execute 'grant execute on function public.' || f || ' to authenticated';
  end loop;
end $$;
