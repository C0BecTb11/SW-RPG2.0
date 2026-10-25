-- ⚠ НЕ ПРИМЕНЯТЬ ПОВТОРНО ЦЕЛИКОМ (аудит 25.10.2026). Файл устарел относительно базы: его прогон откатит
--   функции mine_* — потеряются охрана, караул, испорченный паёк (sql/mine_sabotage.sql), порядок блокировок (sql/audit_2026_10_25.sql).
--   Нужна функция отсюда — бери её текущую версию из базы (pg_get_functiondef), а не из этого файла.
-- Добыча через участки — шаг 5, переделы (24.10.2026). План — claude/mining-plan.md.
--
-- Перерабатывающие цеха (плавильня, топливный, электроника) работают так же, как участки добычи:
-- бригада людей и дроидов, смены, автосмена, задачи, специалисты, износ, опыт, места, районы.
-- Выработка цеха = ставка участка × (суточная норма цеха / 120): 6 дроидов на автосмене 8 ч — как прежние 40 (30) в сутки.
-- Сырьё (по прежней пропорции: consumes / produces_per_day на единицу готового) берётся со склада планеты
-- при старте смены — на всю смену по нынешним эффектам; цех не сделает больше, чем взял; остаток
-- возвращается по концу смены (сорванная — пропадает). Нет сырья — смена не начинается, автосмена ждёт,
-- хозяину одна строка «цех стоит».
-- Задачи у цеха: переработка, наладка линии (как вскрыша: ×0,2, затем +25 %), отладка режима (как разведка:
-- шанс, что 24 ч сырья на единицу на 25 % меньше), обслуживание. Эффекты планеты (законы, события,
-- волнения) действуют на цех, как на добычу.
-- Ежесуточная переработка в production_tick для цехов-участков выключена.

alter table public.mine_shifts add column if not exists input_k jsonb;      -- сырьё на единицу готового (цех)
alter table public.mine_shifts add column if not exists input jsonb;        -- взято со склада планеты при старте
alter table public.mine_shifts add column if not exists input_used jsonb;   -- ушло на сделанное
alter table public.mine_shifts add column if not exists cap integer;        -- больше этого цех за смену не сделает
alter table public.mine_sites add column if not exists idle_since timestamptz; -- цех стоит без сырья (для одной строки в ленте)

insert into public.game_settings (key, value) values ('mine_refine_base', '120') on conflict (key) do nothing;

-- ---------------------------------------------------------------- переделы: числа
-- на единицу готового: сколько сырья (прежняя суточная пропорция цеха)
create or replace function public.mine_input_base(p_resource text) returns jsonb
language sql stable set search_path to 'public', 'pg_temp' as $$
  select (select jsonb_object_agg(k, round((bt.consumes ->> k)::numeric / bt.produces_per_day, 4)) from jsonb_object_keys(bt.consumes) k)
    from building_types bt
   where bt.produces_resource = p_resource and bt.consumes <> '{}'::jsonb and bt.produces_per_day > 0
   order by bt.code limit 1;
$$;
create or replace function public.mine_is_refine(p_resource text) returns boolean
language sql stable set search_path to 'public', 'pg_temp' as $$
  select exists (select 1 from building_types where produces_resource = p_resource and consumes <> '{}'::jsonb);
$$;
-- сырьё на единицу у этого цеха сейчас: отлаженный режим — на 25 % меньше; у участка добычи — null
create or replace function public.mine_input_k(p_building uuid) returns jsonb
language sql stable set search_path to 'public', 'pg_temp' as $$
  select (select jsonb_object_agg(e.key, round(e.value::numeric * case when s.vein_until > now() then 0.75 else 1 end, 4))
            from jsonb_each_text(b) e)
    from mine_sites s, mine_input_base(s.resource) b
   where s.building_id = p_building and b is not null;
$$;
-- на сколько единиц готового хватит сырья на складе планеты (p_upkeep_ore — руда, которая уйдёт дроидам на обслуживание)
create or replace function public.mine_input_room(p_building uuid, p_upkeep_ore integer) returns integer
language sql stable set search_path to 'public', 'pg_temp' as $$
  select floor(min(greatest(0, coalesce(ps.amount, 0) - case when e.key = 'ore' then coalesce(p_upkeep_ore, 0) else 0 end) / e.value::numeric))::integer
    from mine_sites s
    cross join lateral jsonb_each_text(mine_input_k(s.building_id)) e
    left join planet_stock ps on ps.system_id = s.system_id and ps.resource = e.key
   where s.building_id = p_building and e.value::numeric > 0;
$$;
create or replace function public.mine_input_text(p_building uuid) returns text
language sql stable set search_path to 'public', 'pg_temp' as $$
  select 'на единицу — ' || string_agg(lower(r.name) || ' ' || replace(trim(trailing '.' from trim(trailing '0' from round(e.value::numeric, 2)::text)), '.', ','), ', ')
         || ' (на планете ' || string_agg(lower(r.name) || ' ' || coalesce(ps.amount, 0), ', ') || ')'
    from mine_sites s
    cross join lateral jsonb_each_text(mine_input_k(s.building_id)) e
    join resources r on r.id = e.key
    left join planet_stock ps on ps.system_id = s.system_id and ps.resource = e.key
   where s.building_id = p_building;
$$;
-- залежь: основная 1, попутная 0,5, нет — 0; у цеха — его доля от участка добычи (40/120, электроника 30/120)
create or replace function public.mine_res_k(p_system_id text, p_resource text) returns numeric
language sql stable set search_path to 'public', 'pg_temp' as $$
  select coalesce(
    (select max(bt.produces_per_day)::numeric / greatest(1, game_setting_int('mine_refine_base', 120))
       from building_types bt where bt.produces_resource = p_resource and bt.consumes <> '{}'::jsonb),
    (select case when s.primary_resource = p_resource then 1.0 when s.secondary_resource = p_resource then 0.5 else 0 end
       from systems s where s.id = p_system_id), 0);
$$;

-- хозяин планеты управляет и участками добычи, и цехами
create or replace function public.mine_own(p_building uuid) returns mine_sites
language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare b record; s mine_sites;
begin
  if auth.uid() is null then raise exception 'Не авторизован'; end if;
  select bd.system_id, bd.faction, bd.completes_at, bt.produces_resource res, bt.consumes, sy.faction sys_faction
    into b from buildings bd join building_types bt on bt.id = bd.building_type_id join systems sy on sy.id = bd.system_id
   where bd.id = p_building;
  if not found then raise exception 'Постройка не найдена'; end if;
  if b.res is null then raise exception 'Это не производственная постройка'; end if;
  if not exists (select 1 from system_control sc where sc.system_id = b.system_id and sc.controller_user_id = auth.uid()) then
    raise exception 'Производством управляет хозяин планеты';
  end if;
  if b.completes_at is not null and b.completes_at > now() then raise exception 'Постройка ещё не достроена'; end if;
  if b.faction is distinct from b.sys_faction then raise exception 'Трофейная постройка не работает на нового хозяина — её можно только снести'; end if;
  perform mine_site_ensure(p_building);
  select * into s from mine_sites where building_id = p_building for update;
  return s;
end;
$$;

create or replace function public.mine_mult(p_building uuid, p_task text) returns numeric
language sql stable set search_path to 'public', 'pg_temp' as $$
  select (1 + 0.10 * least(s.foremen, mine_max_foremen(s.places)))
       * (1 + 0.03 * mine_stars(s.worked_hours))
       * (1 - least(100, greatest(0, s.wear)) * 0.004)
       * case when s.vein_until > now() and not mine_is_refine(s.resource) then 1.4 else 1 end
       * case when coalesce(p_task, 'extract') = 'extract' then 1 + s.prep_bonus / 100.0 else 1 end
  from mine_sites s where s.building_id = p_building;
$$;

create or replace function public.mine_site_ensure(p_building uuid) returns boolean
language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare b record;
begin
  if exists (select 1 from mine_sites where building_id = p_building) then return true; end if;
  select bd.id, bd.system_id, bd.faction, bd.completes_at, bt.produces_resource res, bt.consumes, s.faction sys_faction
    into b
  from buildings bd join building_types bt on bt.id = bd.building_type_id join systems s on s.id = bd.system_id
  where bd.id = p_building;
  if not found or b.res is null then return false; end if;
  if b.completes_at is not null and b.completes_at > now() then return false; end if;
  insert into mine_sites (building_id, system_id, resource, droids, places, techs)
  values (p_building, b.system_id, b.res, game_setting_int('mine_places_start', 6), game_setting_int('mine_places_start', 6), 1)
  on conflict (building_id) do nothing;
  return true;
end;
$$;

create or replace function public.mine_start(p_building uuid, p_len integer, p_pace text, p_humans integer, p_droids integer,
                                             p_auto boolean, p_by uuid, p_task text) returns uuid
language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare s mine_sites; v_fh boolean := true; v_fd boolean := true; v_id uuid; v_have integer; v_mult numeric; v_task text := coalesce(p_task, 'extract');
  v_rate numeric; v_ik jsonb; v_cap integer; v_take jsonb; k text; v_n integer;
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
  v_rate := mine_rate_h(s.system_id, s.resource, p_humans, p_droids, p_len, p_pace, v_fh, v_fd) * v_mult * mine_task_k(v_task);
  -- цех: сырьё на всю смену берётся со склада планеты сейчас (по нынешним эффектам), остаток вернётся по концу
  v_ik := mine_input_k(p_building);
  if v_ik is not null and v_rate > 0 then
    v_cap := least(mine_input_room(p_building, 0),
                   ceil(v_rate * p_len * greatest(0, 100 + effect_sum(s.system_id, 'extract')) / 100.0)::integer);
    if coalesce(v_cap, 0) < 1 then raise exception 'Не хватает сырья: %', mine_input_text(p_building); end if;
    v_take := '{}'::jsonb;
    for k in select jsonb_object_keys(v_ik) loop
      v_n := ceil(v_cap * (v_ik ->> k)::numeric)::integer;
      perform take_planet_stock(s.system_id, k, v_n);
      v_take := v_take || jsonb_build_object(k, v_n);
    end loop;
  end if;
  if v_task = 'extract' and s.prep_bonus > 0 then update mine_sites set prep_bonus = 0 where building_id = p_building; end if;
  insert into mine_shifts (building_id, system_id, resource, ends_at, len_h, pace, humans, droids, fed_h, fed_d, base_rate, auto, started_by, task, mult,
                           input_k, input, cap)
  values (p_building, s.system_id, s.resource, now() + make_interval(hours => p_len), p_len, p_pace, p_humans, p_droids, v_fh, v_fd,
          v_rate, p_auto, p_by, v_task, v_mult, case when v_take is not null then v_ik end, v_take, v_cap)
  returning id into v_id;
  update mine_sites set idle_since = null where building_id = p_building and idle_since is not null;
  return v_id;
end;
$$;

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
     set accrued = least(coalesce(cap, 1e9), accrued + base_rate * greatest(0, 100 + effect_sum(system_id, 'extract')) / 100.0 * v_h),
         last_tick = v_to
   where id = p_shift;
end;
$$;

create or replace function public.mine_finish(p_shift uuid, p_status text) returns integer
language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare sh mine_shifts; s mine_sites; v_got integer; v_put integer; v_end timestamptz; v_hours numeric; v_n integer;
  v_ctrl uuid; v_fac text; v_hurt numeric := game_setting_int('mine_rush_hurt_pct', 10); v_wear numeric; v_pw numeric;
  v_res text; v_hh integer; v_hd integer; v_full boolean; v_chance numeric; v_ref boolean; v_used jsonb; k text; v_back integer;
begin
  perform mine_accrue(p_shift);
  select * into sh from mine_shifts where id = p_shift and status = 'run' for update;
  if not found then return 0; end if;
  select * into s from mine_sites where building_id = sh.building_id for update;
  v_end := least(now(), sh.ends_at);
  v_hours := greatest(0, extract(epoch from v_end - sh.started_at) / 3600.0);
  v_full := v_hours >= sh.len_h * 0.5;                        -- задача засчитывается, если отработали хотя бы половину
  v_got := case when p_status = 'lost' then 0 else round(sh.accrued)::integer end;
  v_ref := mine_is_refine(sh.resource);
  -- цех: сырьё ушло на сделанное, остаток взятого возвращается на склад планеты (сорванная смена — пропало)
  if sh.input is not null then
    v_used := '{}'::jsonb;
    for k in select jsonb_object_keys(sh.input) loop
      v_n := least((sh.input ->> k)::integer, ceil(v_got * coalesce((sh.input_k ->> k)::numeric, 0))::integer);
      v_used := v_used || jsonb_build_object(k, case when p_status = 'lost' then (sh.input ->> k)::integer else v_n end);
      v_back := (sh.input ->> k)::integer - v_n;
      if p_status <> 'lost' and v_back > 0 then
        perform add_planet_stock(sh.system_id, k, v_back);   -- в пределах склада планеты, как вся добыча
      end if;
    end loop;
    update mine_shifts set input_used = v_used where id = p_shift;
  end if;
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
    if v_full then update mine_sites set prep_bonus = 25 where building_id = sh.building_id;
      v_res := case when v_ref then 'линия налажена: следующая переработка +25 %' else 'вскрыша готова: следующая добыча +25 %' end;
    else v_res := case when v_ref then 'наладка не закончена' else 'вскрыша не закончена' end; end if;
  elsif sh.task = 'survey' and p_status <> 'lost' then
    v_chance := least(0.6, 0.12 * v_hours * (sh.humans + sh.droids) / 6.0);
    if random() < v_chance then
      update mine_sites set vein_until = greatest(coalesce(vein_until, now()), now()) + interval '24 hours' where building_id = sh.building_id;
      v_res := case when v_ref then 'режим отлажен: сырья на 25 % меньше на 24 ч' else 'найдена богатая жила: +40 % на 24 ч' end;
    else v_res := case when v_ref then 'отладить режим не вышло' else 'жилы не нашли' end || ' (шанс был ' || round(v_chance * 100)::integer || ' %)'; end if;
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
      perform log_event_digest(v_ctrl, v_fac, case when v_ref then 'resource_refined' else 'resource_extracted' end, sh.system_id || ':' || sh.resource, sh.system_id,
        (select name from systems where id = sh.system_id), (select name from resources where id = sh.resource), v_got,
        case when v_got > v_put then 'склад участка полон, потеряно ' || (v_got - v_put) end);
    end if;
  end if;
  return v_got;
end;
$$;

create or replace function public.mine_tick() returns void
language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare r record; v_h integer; v_d integer;
begin
  -- новые участки и цеха: готовые добывающие и перерабатывающие здания своей фракции
  for r in select bd.id from buildings bd join building_types bt on bt.id = bd.building_type_id join systems s on s.id = bd.system_id
           where bt.produces_resource is not null
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
      else
        perform mine_accrue(r.id);
        -- цех переработал всё взятое сырьё — смена кончается раньше, бригада раньше уходит на отдых
        if exists (select 1 from mine_shifts where id = r.id and status = 'run' and cap is not null and accrued >= cap - 0.001) then
          perform mine_finish(r.id, 'done');
        end if;
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
      -- цех без сырья ждёт; хозяину — одна строка «цех стоит», пока сырьё не появится
      if v_h + v_d > 0 and mine_is_refine(r.resource) and coalesce(mine_input_room(r.building_id, v_d), 0) < 1 then
        if r.idle_since is null then
          update mine_sites set idle_since = now() where building_id = r.building_id;
          perform log_event_digest(sc.controller_user_id, sy.faction, 'production_idle', r.building_id::text, r.system_id, sy.name,
                                   (select name from resources where id = r.resource), null, 'не хватает сырья', false)
             from systems sy left join system_control sc on sc.system_id = sy.id where sy.id = r.system_id;
        end if;
        continue;
      end if;
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
  if p_humans + p_droids > s.places then raise exception 'Мест работы: %', s.places; end if;
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

create or replace function public.mine_site_state(p_building uuid) returns jsonb
language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare s mine_sites; sh mine_shifts; v_eff integer; v_last jsonb; v_hurt jsonb; v_res record; v_run jsonb; v_market boolean; v_ik jsonb; v_ref jsonb;
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
    'accrued', round(sh.accrued, 2), 'rate', round(sh.base_rate * greatest(0, 100 + v_eff) / 100.0, 3),
    'cap', sh.cap, 'input', sh.input) end;
  select coalesce(jsonb_agg(jsonb_build_object('started_at', x.started_at, 'ended_at', x.ended_at, 'len', x.len_h, 'pace', x.pace, 'task', x.task,
           'humans', x.humans, 'droids', x.droids, 'got', x.delivered, 'lost', x.lost, 'status', x.status, 'auto', x.auto,
           'fed', x.fed_h and x.fed_d, 'result', x.result, 'used', x.input_used) order by x.started_at desc), '[]'::jsonb)
    into v_last
  from (select * from mine_shifts where building_id = p_building and status <> 'run' order by started_at desc limit 6) x;
  select coalesce(jsonb_agg(jsonb_build_object('kind', kind, 'n', n, 'until', until) order by until), '[]'::jsonb) into v_hurt
  from mine_hurt where building_id = p_building and until > now();
  -- цех: что и сколько уходит на единицу готового (с отлаженным режимом — меньше), сколько сырья на планете
  v_ik := mine_input_k(p_building);
  if v_ik is not null then
    select jsonb_build_object('econ', s.vein_until > now(), 'room', mine_input_room(p_building, 0), 'idle', s.idle_since is not null,
             'inputs', jsonb_agg(jsonb_build_object('id', r.id, 'name', r.name, 'color', r.color, 'k', (v_ik ->> r.id)::numeric,
               'have', coalesce((select amount from planet_stock where system_id = s.system_id and resource = r.id), 0)) order by r.sort_order))
      into v_ref
      from resources r where v_ik ? r.id;
  end if;
  return jsonb_build_object(
    'building_id', p_building, 'system_id', s.system_id, 'refine', v_ref,
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


-- ---------------------------------------------------------------- совмещение
-- production_tick: цеха-участки больше не перерабатывают раз в сутки — у них смены
do $$
declare d text;
  a text := $a$and (bt.consumes <> '{}'::jsonb or not exists (select 1 from mine_sites ms where ms.building_id = bd.id))$a$;
  b text := $b$and not exists (select 1 from mine_sites ms where ms.building_id = bd.id)$b$;
begin
  d := pg_get_functiondef('public.production_tick()'::regprocedure);
  if position(b in d) = 0 then
    if position(a in d) = 0 then raise exception 'production_tick: место правки не найдено'; end if;
    execute replace(d, a, b);
  end if;
end $$;

update public.event_types set title = 'Переработка' where type = 'resource_refined';

update public.tutorial_steps set
  mentor_republic = 'Армия ест сырьё. Поставь добычу на то, что залегает на твоей планете. Постройка — это участок с бригадой: шесть дроидов-рабочих уже на месте и сами выходят на смену, добытое приходит по концу каждой смены. Тапни постройку, чтобы нанять людей, выбрать длину и темп смен. Переработка устроена так же: в плавильне своя бригада, и на смену она берёт руду со склада планеты — без руды цех стоит. У склада есть предел, хранилище его поднимает.',
  mentor_cis = 'Производство требует сырья. Разместите добывающее предприятие на имеющейся залежи. Предприятие — это участок: бригада из шести дроидов-рабочих выходит на смены автоматически, добыча поступает по окончании каждой смены. Нажмите на постройку, чтобы нанять рабочих и задать длину и темп смен. Переработка устроена так же: плавильня работает сменами и берёт руду со склада планеты, без сырья цех простаивает. Вместимость склада ограничена, хранилище её увеличивает.'
where id = 'economy';

-- ---------------------------------------------------------------- права: всё новое — только сервису
do $$
declare f text;
begin
  foreach f in array array['mine_input_base(text)', 'mine_is_refine(text)', 'mine_input_k(uuid)', 'mine_input_room(uuid,integer)',
    'mine_input_text(uuid)', 'mine_res_k(text,text)', 'mine_own(uuid)', 'mine_mult(uuid,text)', 'mine_site_ensure(uuid)',
    'mine_start(uuid,integer,text,integer,integer,boolean,uuid,text)', 'mine_accrue(uuid)', 'mine_finish(uuid,text)', 'mine_tick()'] loop
    execute 'revoke all on function public.' || f || ' from public, anon, authenticated';
  end loop;
  foreach f in array array['mine_site_state(uuid)', 'mine_shift_start(uuid,integer,text,integer,integer,text)'] loop
    execute 'revoke all on function public.' || f || ' from public, anon';
    execute 'grant execute on function public.' || f || ' to authenticated';
  end loop;
end $$;
