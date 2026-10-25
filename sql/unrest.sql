-- ⚠ НЕ ПРИМЕНЯТЬ ПОВТОРНО ЦЕЛИКОМ (аудит 25.10.2026). Файл устарел относительно базы: его прогон откатит
--   unrest_calc, unrest_day, unrest_state, unrest_faction, unrest_on_capture — потеряются штрафы, мятежи и переговоры (sql/unrest_riot.sql) и правки unrest_calc из sql/mine_depth.sql и sql/mine_sabotage.sql.
--   Нужна функция отсюда — бери её текущую версию из базы (pg_get_functiondef), а не из этого файла.
-- Напряжение на планетах — шаг 1 плана мятежей (claude/rebellion-plan.md): шкала и предупреждения,
-- без последствий (неделя наблюдения). Штрафы на 50/75 и сам мятеж — следующие шаги.
--
-- Шкала 0–100 у каждой планеты фракции считается раз в сутки в час выдачи (settlement_tick зовёт
-- unrest_day в своей обёртке исключений — сбой шкалы выплату не срывает).
--   растёт: голод +15; враг у стен или идёт захват +10; мародёры ушли с добычей +10;
--           запустение (итоговое довольство ниже 20 третьи сутки подряд и дальше) +5;
--   гасят:  довольство 40+ −10 / 60+ −20; гарнизон 5+ своих в зоне поселения −5 / 15+ −10;
--           управляющий заходил за сутки −3; спокойные сутки (ни одной причины роста) ещё −5.
--   пределы: ничья планета (без управляющего) — 49; столица — 74;
--            после захвата 72 ч и при новом управляющем (аккаунт моложе 7 дней) шкала не растёт.
-- Состояния: 0–29 спокойно, 30–49 ропот, 50–74 волнения, 75–99 забастовки, 100 — мятеж назрел.
-- Переход в состояние выше и возврат к спокойствию — в ленту управляющему и лидеру фракции.

insert into public.game_settings (key, value) values
  ('unrest_enabled', '1'),
  ('unrest_capitals', 'coruscant,raxus'),
  ('unrest_cap_capital', '74'),
  ('unrest_cap_free', '49'),
  ('unrest_hold_capture_hours', '72'),
  ('unrest_newbie_days', '7')
on conflict (key) do nothing;

create table if not exists public.settlement_unrest (
  system_id   text primary key references public.systems(id),
  value       integer not null default 0 check (value between 0 and 100),
  low_days    integer not null default 0,           -- суток подряд с итоговым довольством ниже 20
  hold_until  timestamptz,                          -- до этого времени шкала не растёт
  hold_why    text,
  last_delta  integer,
  last_rows   jsonb,
  last_at     timestamptz,
  updated_at  timestamptz not null default now()
);
alter table public.settlement_unrest enable row level security;
revoke all on public.settlement_unrest from anon, authenticated;

-- Журнал суток: для недели наблюдения и подбора чисел
create table if not exists public.settlement_unrest_log (
  id         bigserial primary key,
  system_id  text not null,
  at         timestamptz not null default now(),
  value      integer not null,
  delta      integer not null,
  eff        integer,
  rows       jsonb
);
create index if not exists settlement_unrest_log_sys on public.settlement_unrest_log (system_id, at desc);
alter table public.settlement_unrest_log enable row level security;
revoke all on public.settlement_unrest_log from anon, authenticated;

insert into public.event_types (type, category, title, tone, jumpable) values
  ('unrest_level', 'faction', 'Напряжение на планете', 'bad', true),
  ('unrest_calm',  'faction', 'Планета успокоилась', 'good', true)
on conflict (type) do update set category = excluded.category, title = excluded.title, tone = excluded.tone, jumpable = excluded.jumpable;

-- Состояние по значению: код и подпись
create or replace function public.unrest_state_of(p_value integer)
 returns jsonb language sql immutable set search_path to 'public', 'pg_temp'
as $function$
  select case
    when p_value >= 100 then '{"k":"riot","t":"мятеж назрел","n":4}'::jsonb
    when p_value >= 75 then '{"k":"strike","t":"забастовки","n":3}'::jsonb
    when p_value >= 50 then '{"k":"unrest","t":"волнения","n":2}'::jsonb
    when p_value >= 30 then '{"k":"murmur","t":"ропот","n":1}'::jsonb
    else '{"k":"calm","t":"спокойно","n":0}'::jsonb end;
$function$;

-- Сутки планеты: что поднимет и что погасит шкалу (без записи). p_fed / p_eff — из расчёта выдачи;
-- без них (прогноз в интерфейсе) голод и довольство считаются по текущему складу и множителям.
create or replace function public.unrest_calc(p_system text, p_fed boolean default null, p_eff integer default null)
 returns jsonb language plpgsql stable security definer set search_path to 'public', 'pg_temp'
as $function$
declare
  sy record; st record; u record; v_ctl uuid; v_seen timestamptz; v_born timestamptz;
  v_eff integer; v_need integer; v_have integer; v_fields integer; v_hunger boolean;
  v_enemy boolean; v_raid boolean; v_gar integer; v_cap integer := 100; v_cap_why text; v_hold text; v_hold_until timestamptz;
  v_rows jsonb := '[]'::jsonb; v_up integer := 0; v_down integer := 0;
  v_caps text[] := string_to_array(coalesce((select value from game_settings where key = 'unrest_capitals'), ''), ',');
begin
  select id, name, faction into sy from systems where id = p_system;
  if not found or sy.faction is null then return null; end if;
  select * into st from settlement_state where system_id = p_system;
  select * into u from settlement_unrest where system_id = p_system;
  select controller_user_id into v_ctl from system_control where system_id = p_system;
  if v_ctl is not null then select last_seen_at, created_at into v_seen, v_born from profiles where id = v_ctl; end if;

  v_eff := coalesce(p_eff, settlement_effective(p_system), 0);

  -- рост
  if p_fed is not null then v_hunger := p_fed is false;
  else
    select coalesce(food_per_day, 0) into v_need from settlement_levels where level = coalesce(st.level, 1);
    select coalesce(amount, 0) into v_have from planet_stock where system_id = p_system and resource = 'food';
    v_fields := case when settlement_has_district(p_system, 'fields') then (select effect_value from district_types where id = 'fields') else 0 end;
    v_hunger := coalesce(v_need, 0) > 0 and coalesce(v_have, 0) + coalesce(v_fields, 0) < v_need;
  end if;
  if v_hunger then v_up := v_up + 15; v_rows := v_rows || jsonb_build_object('label', 'Голод', 'value', 15); end if;

  v_enemy := is_capture_active(p_system) or exists (
    select 1 from unit_positions x
     where x.system_id = p_system and x.layer = 'ground' and x.hp > 0 and x.x is not null and x.carrier_ship_id is null
       and x.faction in ('republic', 'cis') and x.faction <> sy.faction and is_in_settlement_zone(x.x, x.y));
  if v_enemy then v_up := v_up + 10; v_rows := v_rows || jsonb_build_object('label', 'Враг у стен', 'value', 10); end if;

  v_raid := st.cycle_started is not null and exists (
    select 1 from settlement_tasks t where t.system_id = p_system and t.cycle_start = st.cycle_started
       and t.kind = 'marauder' and coalesce((t.payload ->> 'escaped')::boolean, false));
  if v_raid then v_up := v_up + 10; v_rows := v_rows || jsonb_build_object('label', 'Мародёры ушли с добычей', 'value', 10); end if;

  if v_eff < 20 and coalesce(u.low_days, 0) >= 2 then
    v_up := v_up + 5; v_rows := v_rows || jsonb_build_object('label', 'Запустение: довольство ниже 20', 'value', 5);
  end if;

  -- гасители
  if v_eff >= 60 then v_down := v_down + 20; v_rows := v_rows || jsonb_build_object('label', 'Довольство 60+', 'value', -20);
  elsif v_eff >= 40 then v_down := v_down + 10; v_rows := v_rows || jsonb_build_object('label', 'Довольство 40+', 'value', -10); end if;

  select count(*) into v_gar from unit_positions x
   where x.system_id = p_system and x.layer = 'ground' and x.hp > 0 and x.x is not null and x.carrier_ship_id is null
     and x.faction = sy.faction and x.owner_user_id is not null and is_in_settlement_zone(x.x, x.y);
  if v_gar >= 15 then v_down := v_down + 10; v_rows := v_rows || jsonb_build_object('label', 'Гарнизон в поселении: ' || v_gar, 'value', -10);
  elsif v_gar >= 5 then v_down := v_down + 5; v_rows := v_rows || jsonb_build_object('label', 'Гарнизон в поселении: ' || v_gar, 'value', -5); end if;

  if v_ctl is not null and v_seen > now() - interval '24 hours' then
    v_down := v_down + 3; v_rows := v_rows || jsonb_build_object('label', 'Присмотр управляющего', 'value', -3);
  end if;

  if v_up = 0 then v_down := v_down + 5; v_rows := v_rows || jsonb_build_object('label', 'Спокойные сутки', 'value', -5); end if;

  -- пределы и заморозка роста
  if v_ctl is null then v_cap := game_setting_int('unrest_cap_free', 49); v_cap_why := 'ничья планета — только ропот';
  elsif p_system = any(v_caps) then v_cap := game_setting_int('unrest_cap_capital', 74); v_cap_why := 'столица — без мятежа'; end if;
  if u.hold_until > now() then v_hold := coalesce(u.hold_why, 'передышка'); v_hold_until := u.hold_until;
  elsif v_ctl is not null and v_born > now() - make_interval(days => game_setting_int('unrest_newbie_days', 7)) then
    v_hold := 'новый управляющий'; v_hold_until := v_born + make_interval(days => game_setting_int('unrest_newbie_days', 7));
  end if;

  return jsonb_build_object('delta', v_up - v_down, 'up', v_up, 'down', v_down, 'rows', v_rows, 'eff', v_eff,
    'garrison', v_gar, 'cap', v_cap, 'cap_why', v_cap_why, 'hold', v_hold, 'hold_until', v_hold_until,
    'free', v_ctl is null, 'controller', v_ctl);
end;
$function$;

-- Сутки прошли (из settlement_tick): записать шкалу, журнал, известить о смене состояния
create or replace function public.unrest_day(p_system text, p_fed boolean, p_eff integer, p_controller uuid)
 returns void language plpgsql security definer set search_path to 'public', 'pg_temp'
as $function$
declare
  c jsonb; u record; v_old integer; v_new integer; v_d integer; s_old jsonb; s_new jsonb; sy record; v_lead uuid; v_meta jsonb; v_to uuid;
begin
  if game_setting_int('unrest_enabled', 1) <> 1 then return; end if;
  select id, name, faction into sy from systems where id = p_system;
  if sy.faction is null then return; end if;
  insert into settlement_unrest (system_id) values (p_system) on conflict (system_id) do nothing;
  select * into u from settlement_unrest where system_id = p_system for update;
  c := unrest_calc(p_system, p_fed, p_eff);
  if c is null then return; end if;

  v_old := u.value;
  v_d := (c ->> 'delta')::integer;
  if c ->> 'hold' is not null and v_d > 0 then v_d := 0; end if;
  v_new := least((c ->> 'cap')::integer, greatest(0, v_old + v_d));

  update settlement_unrest
     set value = v_new,
         low_days = case when coalesce(p_eff, 0) < 20 then low_days + 1 else 0 end,
         last_delta = v_new - v_old, last_rows = c -> 'rows', last_at = now(), updated_at = now()
   where system_id = p_system;
  insert into settlement_unrest_log (system_id, value, delta, eff, rows) values (p_system, v_new, v_new - v_old, p_eff, c -> 'rows');

  s_old := unrest_state_of(v_old); s_new := unrest_state_of(v_new);
  if (s_new ->> 'n')::integer = (s_old ->> 'n')::integer then return; end if;
  if (s_new ->> 'n')::integer < (s_old ->> 'n')::integer and (s_new ->> 'n')::integer > 0 then return; end if;   -- спад, но не до спокойствия — без шума

  select leader_user_id into v_lead from faction_leadership where faction = sy.faction;
  v_meta := jsonb_build_object('value', v_new, 'prev', v_old, 'state', s_new ->> 'k', 'state_t', s_new ->> 't', 'planet', sy.name);
  for v_to in select distinct x from unnest(array[p_controller, v_lead]) x where x is not null loop
    if (s_new ->> 'n')::integer = 0 then
      perform log_event(v_to, sy.faction, p_system, 'unrest_calm', sy.name || ': спокойно', v_new, 'private', v_meta);
    else
      perform log_event(v_to, sy.faction, p_system, 'unrest_level', sy.name || ': ' || (s_new ->> 't') || ' · ' || v_new, v_new, 'private', v_meta);
    end if;
  end loop;
end;
$function$;

-- Окно поселения: шкала, прогноз на утро, неделя истории (только своей фракции)
create or replace function public.unrest_state(p_system text)
 returns jsonb language plpgsql stable security definer set search_path to 'public', 'pg_temp'
as $function$
declare v_fac text; sy record; u record; c jsonb; v_hist jsonb;
begin
  select faction into v_fac from profiles where id = auth.uid();
  select id, faction into sy from systems where id = p_system;
  if v_fac is null or sy.faction is distinct from v_fac then return null; end if;
  select * into u from settlement_unrest where system_id = p_system;
  c := unrest_calc(p_system);
  select coalesce(jsonb_agg(jsonb_build_object('at', l.at, 'value', l.value, 'delta', l.delta) order by l.at), '[]'::jsonb) into v_hist
    from (select * from settlement_unrest_log where system_id = p_system order by at desc limit 7) l;
  return jsonb_build_object(
    'enabled', game_setting_int('unrest_enabled', 1) = 1,
    'value', coalesce(u.value, 0), 'state', unrest_state_of(coalesce(u.value, 0)),
    'last_delta', u.last_delta, 'last_rows', coalesce(u.last_rows, '[]'::jsonb), 'last_at', u.last_at,
    'forecast', c, 'history', v_hist, 'next_at', next_payout_at(), 'observe', true);
end;
$function$;

-- Окно фракции и карточки планет: шкала всех планет своей фракции
create or replace function public.unrest_faction()
 returns jsonb language plpgsql stable security definer set search_path to 'public', 'pg_temp'
as $function$
declare v_fac text; v_out jsonb;
begin
  select faction into v_fac from profiles where id = auth.uid();
  if v_fac is null then return null; end if;
  select coalesce(jsonb_agg(r order by (r ->> 'value')::integer desc, r ->> 'name'), '[]'::jsonb) into v_out from (
    select jsonb_build_object('id', s.id, 'name', s.name, 'value', coalesce(u.value, 0),
             'state', unrest_state_of(coalesce(u.value, 0)), 'last_delta', u.last_delta,
             'forecast', (c ->> 'delta')::integer, 'cap', (c ->> 'cap')::integer, 'hold', c ->> 'hold',
             'controller', p.nickname) r
      from systems s
      left join settlement_unrest u on u.system_id = s.id
      left join system_control sc on sc.system_id = s.id
      left join profiles p on p.id = sc.controller_user_id
      cross join lateral (select unrest_calc(s.id) c) q
     where s.faction = v_fac and not coalesce(s.is_deep_space, false)) z;
  return jsonb_build_object('faction', v_fac, 'enabled', game_setting_int('unrest_enabled', 1) = 1, 'observe', true,
                            'planets', v_out, 'next_at', next_payout_at());
end;
$function$;

grant execute on function public.unrest_state(text) to authenticated;
grant execute on function public.unrest_faction() to authenticated;
revoke execute on function public.unrest_day(text, boolean, integer, uuid) from anon, authenticated;
revoke execute on function public.unrest_calc(text, boolean, integer) from anon, authenticated;

-- Захват: шкала на 30 («оккупация»), 72 ч не растёт
create or replace function public.unrest_on_capture()
 returns trigger language plpgsql security definer set search_path to 'public', 'pg_temp'
as $function$
begin
  if new.faction is distinct from old.faction then
    insert into settlement_unrest (system_id, value, low_days, hold_until, hold_why, updated_at)
    values (new.id, case when new.faction is null then 0 else 30 end, 0,
            now() + make_interval(hours => game_setting_int('unrest_hold_capture_hours', 72)), 'после захвата', now())
    on conflict (system_id) do update set value = excluded.value, low_days = 0, hold_until = excluded.hold_until,
      hold_why = excluded.hold_why, last_delta = null, last_rows = null, updated_at = now();
  end if;
  return null;
end;
$function$;
-- триггер создаётся только если его ещё нет (повторно создавать безопасно; сам файл повторно не применять — см. начало)
do $do$
begin
  if not exists (select 1 from pg_trigger where tgname = 'z_unrest_on_capture') then
    create trigger z_unrest_on_capture after update of faction on public.systems
      for each row execute function public.unrest_on_capture();
  end if;
end $do$;

-- Все планеты фракций — со шкалой с нуля
insert into public.settlement_unrest (system_id)
select id from public.systems where faction is not null and not coalesce(is_deep_space, false)
on conflict (system_id) do nothing;

-- Встраивание в settlement_tick: после итогового довольства, в своей обёртке исключений
do $do$
declare d text;
begin
  d := pg_get_functiondef('public.settlement_tick()'::regprocedure);
  if position('unrest_day' in d) > 0 then return; end if;
  if position($a$    v_eff := settlement_effective(sys.id);$a$ in d) = 0 then raise exception 'settlement_tick: место встраивания не найдено'; end if;
  d := replace(d, $a$    v_eff := settlement_effective(sys.id);$a$, $a$    v_eff := settlement_effective(sys.id);
    -- напряжение на планете (sql/unrest.sql): сбой шкалы выплату не срывает
    begin perform unrest_day(sys.id, v_fed, v_eff, v_controller); exception when others then null; end;$a$);
  execute d;
end $do$;
