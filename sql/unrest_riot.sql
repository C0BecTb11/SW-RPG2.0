-- Напряжение, шаги 2 и 3 плана мятежей (claude/rebellion-plan.md): штрафы на 50/75, мятеж на 100, переговоры.
-- Всё собрано, но выключено переключателями до конца недели наблюдения (включить 26.10):
--   unrest_penalties_enabled — штрафы волнений и забастовок, ополчение не встаёт на 75+, переговоры;
--   unrest_riot_enabled      — мятеж на 100.
--
-- Штрафы (эффекты фракции с source = 'unrest' на планету, до следующей выдачи + 1 ч, пересчёт каждые сутки):
--   50–74 волнения  — добыча и доход −unrest_unrest_pct (15);
--   75–99 забастовки — −unrest_strike_pct (30), ополчение не встаёт.
-- Мятеж (не больше одного на фракцию; ничьи планеты и столицы до 100 не доходят):
--   у поселения банда повстанцев (4/6/8/10 по уровню поселения), на планете добыча и доход −50%,
--   стройка и набор вдвое дольше (source = 'riot'); 48 ч на подавление.
--   Подавлен (повстанцы перебиты)  — шкала 50, довольство −10 на сутки.
--   Не подавлен за 48 ч            — уровень поселения −1, развитие с нуля, управляющий снят,
--                                    добыча и доход −50% на сутки, шкала 40.
--   Планету захватили              — мятеж кончается тихо.
-- Переговоры (управляющий — своими кредитами, лидер или казначей — из казны): 500 кр. и 50 еды за уровень поселения,
--   шкала 60. Нельзя: мятеж идёт дольше 12 ч, забастовки дольше 3 суток, договаривались за последние 7 суток, голод.

insert into public.game_settings (key, value) values
  ('unrest_penalties_enabled', '0'),
  ('unrest_riot_enabled', '0'),
  ('unrest_unrest_pct', '15'),
  ('unrest_strike_pct', '30'),
  ('unrest_riot_hours', '48'),
  ('unrest_deal_credits', '500'),
  ('unrest_deal_food', '50'),
  ('unrest_deal_cooldown_days', '7'),
  ('unrest_deal_max_days', '3'),
  ('unrest_deal_riot_hours', '12')
on conflict (key) do nothing;

alter table public.settlement_unrest add column if not exists high_days integer not null default 0;   -- суток подряд на 75+
alter table public.settlement_unrest add column if not exists negotiated_at timestamptz;

create table if not exists public.settlement_riots (
  id          uuid primary key default gen_random_uuid(),
  system_id   text not null references public.systems(id),
  faction     text not null,
  status      text not null default 'active',          -- active / suppressed / negotiated / failed / captured
  rebels      uuid[] not null default '{}',
  total       integer not null default 0,
  level       integer,
  started_at  timestamptz not null default now(),
  ends_at     timestamptz not null,
  ended_at    timestamptz,
  result      jsonb
);
-- не больше одного мятежа на фракцию
create unique index if not exists settlement_riots_one_active on public.settlement_riots (faction) where status = 'active';
create index if not exists settlement_riots_sys on public.settlement_riots (system_id, started_at desc);
alter table public.settlement_riots enable row level security;
revoke all on public.settlement_riots from anon, authenticated;

insert into public.event_types (type, category, title, tone, jumpable) values
  ('unrest_near',      'faction', 'Мятеж близко',     'warn', true),
  ('unrest_riot',      'faction', 'Мятеж на планете', 'bad',  true),
  ('unrest_riot_end',  'faction', 'Мятеж окончен',    'good', true),
  ('unrest_riot_lost', 'faction', 'Мятеж не подавлен', 'bad', true)
on conflict (type) do update set category = excluded.category, title = excluded.title, tone = excluded.tone, jumpable = excluded.jumpable;

-- ---------------------------------------------------------------- штрафы волнений и забастовок
-- Старые штрафы планеты гасятся, новые ставятся по значению шкалы. Во время мятежа — только его эффекты.
create or replace function public.unrest_penalty(p_system text, p_value integer)
 returns integer language plpgsql security definer set search_path to 'public', 'pg_temp'
as $function$
declare v_fac text; v_pct integer; v_t text;
begin
  update faction_effects set ends_at = now() where system_id = p_system and source = 'unrest' and ends_at > now();
  select faction into v_fac from systems where id = p_system;
  if v_fac is null or v_fac not in ('republic', 'cis') or game_setting_int('unrest_penalties_enabled', 0) <> 1 then return 0; end if;
  if exists (select 1 from settlement_riots where system_id = p_system and status = 'active') then return 0; end if;
  if p_value >= 75 then v_pct := game_setting_int('unrest_strike_pct', 30); v_t := 'Забастовки';
  elsif p_value >= 50 then v_pct := game_setting_int('unrest_unrest_pct', 15); v_t := 'Волнения';
  else return 0; end if;
  insert into faction_effects (faction, kind, value, title, source, system_id, starts_at, ends_at)
  select v_fac, k, -v_pct, v_t, 'unrest', p_system, now(), next_payout_at() + interval '1 hour'
    from unnest(array['extract', 'income']) k;
  return v_pct;
end;
$function$;

-- ---------------------------------------------------------------- мятеж: начало
create or replace function public.riot_start(p_system text)
 returns uuid language plpgsql security definer set search_path to 'public', 'pg_temp'
as $function$
declare
  sy record; v_ctl uuid; v_lvl integer; v_ids uuid[]; v_n integer; v_id uuid; v_end timestamptz; v_meta jsonb; ld record;
  v_caps text[] := string_to_array(coalesce((select value from game_settings where key = 'unrest_capitals'), ''), ',');
begin
  select id, name, faction into sy from systems where id = p_system;
  if sy.faction is null or sy.faction not in ('republic', 'cis') or p_system = any(v_caps) then return null; end if;
  select controller_user_id into v_ctl from system_control where system_id = p_system;
  if v_ctl is null or is_capture_active(p_system) then return null; end if;
  if exists (select 1 from settlement_riots where faction = sy.faction and status = 'active') then return null; end if;

  begin
    select greatest(1, coalesce(level, 1)) into v_lvl from settlement_state where system_id = p_system;
    v_lvl := coalesce(v_lvl, 1);
    v_ids := spawn_marauder_gang(p_system, least(10, 2 + 2 * v_lvl));
    v_n := coalesce(array_length(v_ids, 1), 0);
    if v_n = 0 then return null; end if;                       -- банде негде встать — попробуем на следующих сутках
    v_end := now() + make_interval(hours => game_setting_int('unrest_riot_hours', 48));
    insert into settlement_riots (system_id, faction, rebels, total, level, ends_at)
    values (p_system, sy.faction, v_ids, v_n, v_lvl, v_end) returning id into v_id;
  exception when unique_violation then
    return null;                                               -- другая планета фракции успела раньше: банда откатилась вместе с записью
  end;

  update faction_effects set ends_at = now() where system_id = p_system and source = 'unrest' and ends_at > now();
  insert into faction_effects (faction, kind, value, title, source, system_id, starts_at, ends_at) values
    (sy.faction, 'extract',    -50, 'Мятеж', 'riot', p_system, now(), v_end),
    (sy.faction, 'income',     -50, 'Мятеж', 'riot', p_system, now(), v_end),
    (sy.faction, 'build_time',  50, 'Мятеж', 'riot', p_system, now(), v_end),
    (sy.faction, 'hire_time',   50, 'Мятеж', 'riot', p_system, now(), v_end);

  select u.x, u.y into ld from unit_positions u where u.id = v_ids[1];
  v_meta := jsonb_build_object('planet', sy.name, 'rebels', v_n, 'ends', v_end, 'riot', v_id, 'x', ld.x, 'y', ld.y);
  perform log_event(null, sy.faction, p_system, 'unrest_riot', sy.name || ': мятеж · повстанцев ' || v_n, v_n, 'faction', v_meta);
  perform log_event(v_ctl, sy.faction, p_system, 'unrest_riot', sy.name || ': мятеж · повстанцев ' || v_n, v_n, 'private', v_meta);
  return v_id;
end;
$function$;

-- ---------------------------------------------------------------- мятеж: конец
create or replace function public.riot_finish(p_id uuid, p_status text)
 returns void language plpgsql security definer set search_path to 'public', 'pg_temp'
as $function$
declare r record; sy record; v_ctl uuid; v_alive integer; v_val integer; v_lvl integer; v_txt text; v_meta jsonb;
begin
  if p_status not in ('suppressed', 'negotiated', 'failed', 'captured') then raise exception 'riot_finish: %', p_status; end if;
  select * into r from settlement_riots where id = p_id and status = 'active' for update;
  if not found then return; end if;
  select id, name, faction into sy from systems where id = r.system_id;
  select controller_user_id into v_ctl from system_control where system_id = r.system_id;
  select count(*) into v_alive from unit_positions x where x.id = any(r.rebels) and x.hp > 0;

  -- эффекты мятежа гаснут, уцелевшие повстанцы уходят (npc_tick и бой на сервере уводят state = 'leave')
  update faction_effects set ends_at = now() where system_id = r.system_id and source = 'riot' and ends_at > now();
  update npc_brains set state = 'leave' where unit_id = any(r.rebels) and state is distinct from 'leave';

  if p_status = 'suppressed' then
    v_val := 50; v_txt := sy.name || ': мятеж подавлен';
    insert into faction_effects (faction, kind, value, title, source, system_id, starts_at, ends_at)
    values (r.faction, 'mood', -10, 'После мятежа', 'riot_end', r.system_id, now(), now() + interval '24 hours');
  elsif p_status = 'negotiated' then
    v_val := 60; v_txt := sy.name || ': с повстанцами договорились';
  elsif p_status = 'failed' then
    v_val := 40; v_txt := sy.name || ': мятеж не подавлен';
    select level into v_lvl from settlement_state where system_id = r.system_id;
    -- как при захвате (reset_settlement_on_capture): ступень вниз, развитие с нуля, расширение отменено
    update settlement_state set level = greatest(1, coalesce(level, 1) - 1), dev_points = 0, upgrade_until = null, upgrade_to = null
     where system_id = r.system_id;
    if v_ctl is not null then update system_control set controller_user_id = null where system_id = r.system_id; end if;
    insert into faction_effects (faction, kind, value, title, source, system_id, starts_at, ends_at) values
      (r.faction, 'extract', -50, 'Разорение после мятежа', 'riot_end', r.system_id, now(), now() + interval '24 hours'),
      (r.faction, 'income',  -50, 'Разорение после мятежа', 'riot_end', r.system_id, now(), now() + interval '24 hours');
  end if;

  update settlement_riots set status = p_status, ended_at = now(),
         result = jsonb_build_object('alive', v_alive, 'controller', v_ctl, 'level_from', v_lvl)
   where id = p_id;

  if sy.faction is distinct from r.faction then return; end if;          -- захвачена: шкалу ставит unrest_on_capture
  if v_val is not null then
    update settlement_unrest set value = v_val, high_days = 0, updated_at = now() where system_id = r.system_id;
    perform unrest_penalty(r.system_id, v_val);
  end if;
  if v_txt is null then return; end if;

  v_meta := jsonb_build_object('planet', sy.name, 'status', p_status, 'total', r.total, 'alive', v_alive,
                               'level', case when v_lvl > 1 then v_lvl - 1 end, 'value', v_val);
  perform log_event(null, r.faction, r.system_id, case when p_status = 'failed' then 'unrest_riot_lost' else 'unrest_riot_end' end,
                    v_txt, r.total, 'faction', v_meta);
  if v_ctl is not null then
    perform log_event(v_ctl, r.faction, r.system_id, case when p_status = 'failed' then 'unrest_riot_lost' else 'unrest_riot_end' end,
                      v_txt, r.total, 'private', v_meta);
  end if;
end;
$function$;

-- Каждые 2 минуты: перебиты — подавлен, вышли 48 ч — провал, планета ушла — тихо
create or replace function public.riot_tick()
 returns void language plpgsql security definer set search_path to 'public', 'pg_temp'
as $function$
declare r record; v_fac text;
begin
  if not pg_try_advisory_xact_lock(hashtext('riot_tick')) then return; end if;
  for r in select * from settlement_riots where status = 'active' order by started_at loop
    begin
      select faction into v_fac from systems where id = r.system_id;
      if v_fac is distinct from r.faction then
        perform riot_finish(r.id, 'captured');
      elsif not exists (select 1 from unit_positions x where x.id = any(r.rebels) and x.hp > 0) then
        perform riot_finish(r.id, 'suppressed');
      elsif r.ends_at <= now() then
        perform riot_finish(r.id, 'failed');
      end if;
    exception when others then
      raise warning 'riot_tick %: %', r.id, sqlerrm;
    end;
  end loop;
end;
$function$;

-- ---------------------------------------------------------------- переговоры
-- Можно ли договориться и почём (для окна поселения и для самих переговоров)
create or replace function public.unrest_deal(p_system text, p_user uuid)
 returns jsonb language plpgsql stable security definer set search_path to 'public', 'pg_temp'
as $function$
declare
  sy record; u record; st record; rt record; v_ctl uuid; v_lvl integer; v_cr integer; v_food integer; v_have integer;
  v_self boolean; v_tre boolean; v_why text; v_again timestamptz; v_bank integer; v_mine integer;
begin
  select id, name, faction into sy from systems where id = p_system;
  if sy.faction is null or sy.faction not in ('republic', 'cis') then return null; end if;
  select * into u from settlement_unrest where system_id = p_system;
  select * into st from settlement_state where system_id = p_system;
  select * into rt from settlement_riots where system_id = p_system and status = 'active';
  select controller_user_id into v_ctl from system_control where system_id = p_system;
  v_lvl := greatest(1, coalesce(st.level, 1));
  v_cr := game_setting_int('unrest_deal_credits', 500) * v_lvl;
  v_food := game_setting_int('unrest_deal_food', 50) * v_lvl;
  select coalesce(amount, 0) into v_have from planet_stock where system_id = p_system and resource = 'food';
  v_self := p_user is not null and v_ctl = p_user;
  v_tre := p_user is not null and faction_power(p_user, sy.faction, 'treasury');
  v_again := u.negotiated_at + make_interval(days => game_setting_int('unrest_deal_cooldown_days', 7));

  v_why := case
    when game_setting_int('unrest_penalties_enabled', 0) <> 1 then 'Переговоры откроются вместе с последствиями напряжения'
    when rt.id is null and coalesce(u.value, 0) < 75 then 'Переговоры — при забастовках (75+) или мятеже'
    when rt.id is not null and rt.started_at < now() - make_interval(hours => game_setting_int('unrest_deal_riot_hours', 12))
      then 'Мятеж идёт дольше ' || game_setting_int('unrest_deal_riot_hours', 12) || ' ч — теперь только подавить'
    when rt.id is null and coalesce(u.high_days, 0) > game_setting_int('unrest_deal_max_days', 3)
      then 'Забастовки идут дольше ' || game_setting_int('unrest_deal_max_days', 3) || ' суток — обещаниям не верят'
    when v_again > now() then 'Уже договаривались — снова можно через ' ||
      case when v_again - now() > interval '1 day' then ceil(extract(epoch from v_again - now()) / 86400)::integer || ' сут.'
           else ceil(extract(epoch from v_again - now()) / 3600)::integer || ' ч' end
    when st.fed is false or coalesce(u.last_rows, '[]'::jsonb) @> '[{"label":"Голод"}]'::jsonb then 'Голод: пока склад пуст, слушать не станут'
    when not (v_self or v_tre) then 'Договориться может управляющий, лидер или казначей фракции'
  end;
  if v_self then select credits into v_mine from profiles where id = p_user; end if;
  if v_tre then select credits into v_bank from faction_treasury where faction = sy.faction; end if;
  return jsonb_build_object('ok', v_why is null, 'why', v_why, 'credits', v_cr, 'food', v_food, 'food_have', coalesce(v_have, 0),
    'self', v_self, 'treasury', v_tre, 'my_credits', v_mine, 'bank', coalesce(v_bank, 0), 'again_at', v_again,
    'riot', rt.id is not null, 'value', 60);
end;
$function$;

create or replace function public.unrest_negotiate(p_system text, p_treasury boolean default false)
 returns jsonb language plpgsql security definer set search_path to 'public', 'pg_temp'
as $function$
declare v_me uuid := auth.uid(); sy record; d jsonb; v_cr integer; v_food integer; v_have integer; v_bank integer; v_riot uuid; v_old integer;
begin
  if v_me is null then raise exception 'Нужно войти'; end if;
  select id, name, faction into sy from systems where id = p_system;
  if sy.faction is distinct from (select faction from profiles where id = v_me) then raise exception 'Это не планета твоей фракции'; end if;
  select value into v_old from settlement_unrest where system_id = p_system for update;     -- двое разом не договорятся
  d := unrest_deal(p_system, v_me);
  if d is null then raise exception 'Здесь договариваться не с кем'; end if;
  if not (d ->> 'ok')::boolean then raise exception '%', d ->> 'why'; end if;
  v_cr := (d ->> 'credits')::integer; v_food := (d ->> 'food')::integer;

  select coalesce(amount, 0) into v_have from planet_stock where system_id = p_system and resource = 'food' for update;
  if coalesce(v_have, 0) < v_food then raise exception 'На складе планеты не хватает еды: нужно %, есть %', v_food, coalesce(v_have, 0); end if;

  if p_treasury then
    if not (d ->> 'treasury')::boolean then raise exception 'Из казны платят лидер или казначей фракции'; end if;
    select credits into v_bank from faction_treasury where faction = sy.faction for update;
    if coalesce(v_bank, 0) < v_cr then raise exception 'В казне не хватает: нужно % кр.', v_cr; end if;
    perform treasury_add(sy.faction, -v_cr, 'project', v_me, null, p_system, 'Переговоры: ' || sy.name);
  else
    if not (d ->> 'self')::boolean then raise exception 'Своими кредитами платит только управляющий планеты'; end if;
    update profiles set credits = credits - v_cr where id = v_me and credits >= v_cr;
    if not found then raise exception 'Не хватает кредитов: нужно %', v_cr; end if;
  end if;
  update planet_stock set amount = amount - v_food where system_id = p_system and resource = 'food';

  update settlement_unrest set value = 60, high_days = 0, negotiated_at = now(), updated_at = now() where system_id = p_system;
  select id into v_riot from settlement_riots where system_id = p_system and status = 'active';
  if v_riot is not null then
    perform riot_finish(v_riot, 'negotiated');
  else
    perform unrest_penalty(p_system, 60);
    perform log_event(null, sy.faction, p_system, 'unrest_riot_end', sy.name || ': с забастовщиками договорились', 0, 'faction',
                      jsonb_build_object('planet', sy.name, 'status', 'deal', 'value', 60, 'prev', v_old));
  end if;
  return jsonb_build_object('value', 60, 'credits', v_cr, 'food', v_food, 'treasury', p_treasury);
end;
$function$;

-- ---------------------------------------------------------------- сутки шкалы (замена из sql/unrest.sql)
create or replace function public.unrest_day(p_system text, p_fed boolean, p_eff integer, p_controller uuid)
 returns void language plpgsql security definer set search_path to 'public', 'pg_temp'
as $function$
declare
  c jsonb; u record; v_old integer; v_new integer; v_d integer; s_old jsonb; s_new jsonb; sy record; v_lead uuid; v_meta jsonb; v_to uuid;
  v_riot uuid; v_started uuid; v_wait boolean := false; v_obs boolean := game_setting_int('unrest_penalties_enabled', 0) <> 1;
begin
  if game_setting_int('unrest_enabled', 1) <> 1 then return; end if;
  select id, name, faction into sy from systems where id = p_system;
  if sy.faction is null then return; end if;
  insert into settlement_unrest (system_id) values (p_system) on conflict (system_id) do nothing;
  select * into u from settlement_unrest where system_id = p_system for update;
  c := unrest_calc(p_system, p_fed, p_eff);
  if c is null then return; end if;

  v_old := u.value;
  select id into v_riot from settlement_riots where system_id = p_system and status = 'active';
  if v_riot is not null then
    v_new := 100;                                          -- пока идёт свой мятеж, шкала стоит на 100
  else
    v_d := (c ->> 'delta')::integer;
    if c ->> 'hold' is not null and v_d > 0 then v_d := 0; end if;
    v_new := least((c ->> 'cap')::integer, greatest(0, v_old + v_d));
    -- один мятеж на фракцию: пока он идёт на другой планете, здесь шкала держится на 99
    if v_new >= 100 and game_setting_int('unrest_riot_enabled', 0) = 1
       and exists (select 1 from settlement_riots r where r.faction = sy.faction and r.status = 'active') then
      v_new := 99; v_wait := true;
    end if;
  end if;

  update settlement_unrest
     set value = v_new,
         low_days = case when coalesce(p_eff, 0) < 20 then low_days + 1 else 0 end,
         high_days = case when v_new >= 75 then high_days + 1 else 0 end,
         last_delta = v_new - v_old, last_rows = c -> 'rows', last_at = now(), updated_at = now()
   where system_id = p_system;
  insert into settlement_unrest_log (system_id, value, delta, eff, rows) values (p_system, v_new, v_new - v_old, p_eff, c -> 'rows');

  -- штрафы на сутки и мятеж (переключатели unrest_penalties_enabled / unrest_riot_enabled)
  perform unrest_penalty(p_system, v_new);
  if v_riot is null and v_new >= 100 and game_setting_int('unrest_riot_enabled', 0) = 1 then
    v_started := riot_start(p_system);
  end if;

  select leader_user_id into v_lead from faction_leadership where faction = sy.faction;

  -- забастовки и следующие сутки с тем же ростом доведут до мятежа — вся фракция узнаёт заранее
  if v_riot is null and v_started is null and not v_wait and game_setting_int('unrest_riot_enabled', 0) = 1
     and v_new between 75 and 99 and v_new > v_old and v_new + (v_new - v_old) >= 100 then
    perform log_event(null, sy.faction, p_system, 'unrest_near', sy.name || ': мятеж близко · ' || v_new, v_new, 'faction',
                      jsonb_build_object('value', v_new, 'prev', v_old, 'planet', sy.name));
  end if;

  if v_started is not null or v_riot is not null then return; end if;   -- о мятеже — свои извещения
  s_old := unrest_state_of(v_old); s_new := unrest_state_of(v_new);
  if (s_new ->> 'n')::integer = (s_old ->> 'n')::integer then return; end if;
  if (s_new ->> 'n')::integer < (s_old ->> 'n')::integer and (s_new ->> 'n')::integer > 0 then return; end if;   -- спад, но не до спокойствия — без шума

  v_meta := jsonb_build_object('value', v_new, 'prev', v_old, 'state', s_new ->> 'k', 'state_t', s_new ->> 't', 'planet', sy.name, 'obs', v_obs);
  for v_to in select distinct x from unnest(array[p_controller, v_lead]) x where x is not null loop
    if (s_new ->> 'n')::integer = 0 then
      perform log_event(v_to, sy.faction, p_system, 'unrest_calm', sy.name || ': спокойно', v_new, 'private', v_meta);
    else
      perform log_event(v_to, sy.faction, p_system, 'unrest_level', sy.name || ': ' || (s_new ->> 't') || ' · ' || v_new, v_new, 'private', v_meta);
    end if;
  end loop;
end;
$function$;

-- ---------------------------------------------------------------- окно поселения и окно фракции
create or replace function public.unrest_riot_info(p_system text)
 returns jsonb language sql stable security definer set search_path to 'public', 'pg_temp'
as $function$
  select jsonb_build_object('id', r.id, 'started_at', r.started_at, 'ends_at', r.ends_at, 'total', r.total,
           'alive', (select count(*) from unit_positions x where x.id = any(r.rebels) and x.hp > 0),
           'x', (select x.x from unit_positions x where x.id = any(r.rebels) and x.hp > 0 and x.x is not null order by x.id limit 1),
           'y', (select x.y from unit_positions x where x.id = any(r.rebels) and x.hp > 0 and x.x is not null order by x.id limit 1))
    from settlement_riots r where r.system_id = p_system and r.status = 'active';
$function$;

-- Действующие эффекты напряжения планеты: штраф волнений, мятеж, последствия мятежа
create or replace function public.unrest_effects_of(p_system text)
 returns jsonb language sql stable security definer set search_path to 'public', 'pg_temp'
as $function$
  select coalesce(jsonb_agg(jsonb_build_object('kind', fe.kind, 'value', fe.value, 'title', fe.title, 'source', fe.source, 'ends', fe.ends_at)
                            order by fe.source, fe.kind), '[]'::jsonb)
    from faction_effects fe join systems s on s.id = fe.system_id and s.faction = fe.faction
   where fe.system_id = p_system and fe.source in ('unrest', 'riot', 'riot_end') and fe.starts_at <= now() and fe.ends_at > now();
$function$;

create or replace function public.unrest_state(p_system text)
 returns jsonb language plpgsql stable security definer set search_path to 'public', 'pg_temp'
as $function$
declare v_me uuid := auth.uid(); v_fac text; sy record; u record; c jsonb; v_hist jsonb; v_pen boolean; v_riots boolean; v_else text;
begin
  select faction into v_fac from profiles where id = v_me;
  select id, faction into sy from systems where id = p_system;
  if v_fac is null or sy.faction is distinct from v_fac then return null; end if;
  select * into u from settlement_unrest where system_id = p_system;
  c := unrest_calc(p_system);
  select coalesce(jsonb_agg(jsonb_build_object('at', l.at, 'value', l.value, 'delta', l.delta) order by l.at), '[]'::jsonb) into v_hist
    from (select * from settlement_unrest_log where system_id = p_system order by at desc limit 7) l;
  v_pen := game_setting_int('unrest_penalties_enabled', 0) = 1;
  v_riots := game_setting_int('unrest_riot_enabled', 0) = 1;
  select s.name into v_else from settlement_riots r join systems s on s.id = r.system_id
   where r.faction = v_fac and r.status = 'active' and r.system_id <> p_system;
  return jsonb_build_object(
    'enabled', game_setting_int('unrest_enabled', 1) = 1,
    'value', coalesce(u.value, 0), 'state', unrest_state_of(coalesce(u.value, 0)),
    'last_delta', u.last_delta, 'last_rows', coalesce(u.last_rows, '[]'::jsonb), 'last_at', u.last_at,
    'forecast', c, 'history', v_hist, 'next_at', next_payout_at(),
    'observe', not v_pen, 'penalties', v_pen, 'riots', v_riots,
    'pct', jsonb_build_object('unrest', game_setting_int('unrest_unrest_pct', 15), 'strike', game_setting_int('unrest_strike_pct', 30)),
    'high_days', coalesce(u.high_days, 0),
    'riot', unrest_riot_info(p_system), 'riot_elsewhere', v_else,
    'effects', unrest_effects_of(p_system),
    'deal', case when v_pen and (coalesce(u.value, 0) >= 75 or exists (select 1 from settlement_riots r where r.system_id = p_system and r.status = 'active'))
                 then unrest_deal(p_system, v_me) end);
end;
$function$;

create or replace function public.unrest_faction()
 returns jsonb language plpgsql stable security definer set search_path to 'public', 'pg_temp'
as $function$
declare v_me uuid := auth.uid(); v_fac text; v_out jsonb; v_pen boolean := game_setting_int('unrest_penalties_enabled', 0) = 1;
begin
  select faction into v_fac from profiles where id = v_me;
  if v_fac is null then return null; end if;
  select coalesce(jsonb_agg(r order by (r ->> 'value')::integer desc, r ->> 'name'), '[]'::jsonb) into v_out from (
    select jsonb_build_object('id', s.id, 'name', s.name, 'value', coalesce(u.value, 0),
             'state', unrest_state_of(coalesce(u.value, 0)), 'last_delta', u.last_delta,
             'forecast', (c ->> 'delta')::integer, 'cap', (c ->> 'cap')::integer, 'hold', c ->> 'hold',
             'controller', p.nickname, 'mine', sc.controller_user_id = v_me,
             'seen_days', case when p.id is not null then floor(extract(epoch from now() - coalesce(p.last_seen_at, p.created_at)) / 86400)::integer end,
             'cond', settlement_cond(s.id),
             'riot', unrest_riot_info(s.id),
             'pen', (select -min(fe.value) from faction_effects fe where fe.system_id = s.id and fe.faction = v_fac and fe.source = 'unrest'
                        and fe.kind = 'extract' and fe.starts_at <= now() and fe.ends_at > now())) r
      from systems s
      left join settlement_unrest u on u.system_id = s.id
      left join system_control sc on sc.system_id = s.id
      left join profiles p on p.id = sc.controller_user_id
      cross join lateral (select unrest_calc(s.id) c) q
     where s.faction = v_fac and not coalesce(s.is_deep_space, false)) z;
  return jsonb_build_object('faction', v_fac, 'enabled', game_setting_int('unrest_enabled', 1) = 1, 'observe', not v_pen,
                            'penalties', v_pen, 'riots', game_setting_int('unrest_riot_enabled', 0) = 1,
                            'planets', v_out, 'next_at', next_payout_at(), 'is_leader', is_faction_leader(v_me, v_fac),
                            'gain', game_setting_int('settlement_task_gain', 5), 'loss', game_setting_int('settlement_task_loss', 4),
                            'bonus', game_setting_int('settlement_task_bonus', 5), 'no_ruler', game_setting_int('settlement_no_ruler_penalty', 10));
end;
$function$;

-- Права. Новые функции получают EXECUTE для PUBLIC, поэтому отзывается и у него: служебные зовут только
-- cron и функции-владельцы (security definer). Заодно закрыты служебные функции шага 1 и условий поселений
-- (#83, #84): через PUBLIC их можно было вызвать напрямую — сдвинуть шкалу или подсмотреть условия врага.
revoke execute on function public.unrest_penalty(text, integer) from public, anon, authenticated;
revoke execute on function public.riot_start(text) from public, anon, authenticated;
revoke execute on function public.riot_finish(uuid, text) from public, anon, authenticated;
revoke execute on function public.riot_tick() from public, anon, authenticated;
revoke execute on function public.unrest_deal(text, uuid) from public, anon, authenticated;
revoke execute on function public.unrest_riot_info(text) from public, anon, authenticated;
revoke execute on function public.unrest_effects_of(text) from public, anon, authenticated;
revoke execute on function public.unrest_day(text, boolean, integer, uuid) from public, anon, authenticated;
revoke execute on function public.unrest_calc(text, boolean, integer) from public, anon, authenticated;
revoke execute on function public.settlement_cond(text) from public, anon, authenticated;
revoke execute on function public.settlement_notice_tick() from public, anon, authenticated;
revoke execute on function public.unrest_state(text) from public, anon;
revoke execute on function public.unrest_faction() from public, anon;
revoke execute on function public.unrest_negotiate(text, boolean) from public, anon;
revoke execute on function public.leader_revoke_planet(text) from public, anon;
grant execute on function public.unrest_state(text) to authenticated;
grant execute on function public.unrest_faction() to authenticated;
grant execute on function public.unrest_negotiate(text, boolean) to authenticated;
grant execute on function public.leader_revoke_planet(text) to authenticated;

-- ---------------------------------------------------------------- захват (замена из sql/unrest.sql)
-- Шкала на 30 («оккупация»), 72 ч не растёт; штрафы и мятеж прежних хозяев кончаются
create or replace function public.unrest_on_capture()
 returns trigger language plpgsql security definer set search_path to 'public', 'pg_temp'
as $function$
declare v_riot uuid;
begin
  if new.faction is distinct from old.faction then
    for v_riot in select id from settlement_riots where system_id = new.id and status = 'active' loop
      perform riot_finish(v_riot, 'captured');
    end loop;
    update faction_effects set ends_at = now() where system_id = new.id and source in ('unrest', 'riot', 'riot_end') and ends_at > now();
    insert into settlement_unrest (system_id, value, low_days, high_days, hold_until, hold_why, updated_at)
    values (new.id, case when new.faction is null then 0 else 30 end, 0, 0,
            now() + make_interval(hours => game_setting_int('unrest_hold_capture_hours', 72)), 'после захвата', now())
    on conflict (system_id) do update set value = excluded.value, low_days = 0, high_days = 0, hold_until = excluded.hold_until,
      hold_why = excluded.hold_why, last_delta = null, last_rows = null, updated_at = now();
  end if;
  return null;
end;
$function$;

-- ---------------------------------------------------------------- встраивание в старые функции (правка по тексту)
-- npc_tick: повстанцы мятежа не уходят через 10 минут без задачи поселения
do $do$
declare d text; a text;
begin
  d := pg_get_functiondef('public.npc_tick()'::regprocedure);
  if position('settlement_riots' in d) > 0 then return; end if;
  a := $a$or coalesce(t.payload -> 'unit_ids', '[]'::jsonb) ? u.id::text))));$a$;
  if position(a in d) = 0 then raise exception 'npc_tick: проверка задачи мародёра не найдена'; end if;
  d := replace(d, a, $a$or coalesce(t.payload -> 'unit_ids', '[]'::jsonb) ? u.id::text))
             -- повстанцы мятежа держатся до его конца (sql/unrest_riot.sql)
             and not exists (select 1 from settlement_riots rr where rr.status = 'active' and u.id = any(rr.rebels))));$a$);
  execute d;
end $do$;

-- raise_militia: при забастовках и мятеже ополчение не встаёт
do $do$
declare d text; a text;
begin
  d := pg_get_functiondef('public.raise_militia(text)'::regprocedure);
  if position('unrest_penalties_enabled' in d) > 0 then return; end if;
  a := $a$  if v_fac is null or v_fac not in ('republic', 'cis') then return 0; end if;
$a$;
  if position(a in d) = 0 then raise exception 'raise_militia: проверка фракции не найдена'; end if;
  d := replace(d, a, a || $a$  -- забастовки и мятеж (sql/unrest_riot.sql): люди не встают на защиту
  if game_setting_int('unrest_penalties_enabled', 0) = 1
     and coalesce((select value from settlement_unrest where system_id = p_system), 0) >= 75 then return 0; end if;
$a$);
  execute d;
end $do$;

-- report_list: эффекты напряжения подписаны своим источником
do $do$
declare d text; a text;
begin
  d := pg_get_functiondef('public.report_list()'::regprocedure);
  if position('Напряжение · ' in d) > 0 then return; end if;
  a := $a$case when source like 'event:%' then 'Событие · ' else 'Казна · ' end$a$;
  if position(a in d) = 0 then raise exception 'report_list: подпись эффектов не найдена'; end if;
  d := replace(d, a, $a$case when source like 'event:%' then 'Событие · ' when source in ('unrest', 'riot', 'riot_end') then 'Напряжение · ' else 'Казна · ' end$a$);
  execute d;
end $do$;

-- pg_cron: мятежи проверяются каждые 2 минуты
do $do$
begin
  if not exists (select 1 from cron.job where jobname = 'riot-tick') then
    perform cron.schedule('riot-tick', '*/2 * * * *', 'select public.riot_tick()');
  end if;
end $do$;
