-- ============================================================================
-- Панель разработчика (кнопка DEV). Применено миграцией dev_panel.
--
-- Защита — в базе, не в браузере:
--   * dev_admins закрыта RLS без единой политики и без прав у anon/authenticated:
--     игрок не может ни прочитать список, ни вписать себя. Админов назначают только
--     владельцем базы (SQL Editor / Claude через MCP), функциями dev_admin_grant/revoke,
--     которые игрокам тоже не выданы.
--   * каждое действие dev_* — SECURITY DEFINER и первым делом dev_assert(): auth.uid()
--     должен быть действующим админом, иначе «Нет доступа». Подделать auth.uid() нельзя —
--     он берётся из подписанного токена Supabase.
--   * код панели (js/dev-panel.js) загружается в браузер только после того, как база
--     подтвердила права (dev_is_admin), остальным его даже не присылают.
--   * всё, что сделано из панели, пишется в dev_log (кто, что, кому, когда).
--   * снятие админа — revoked_at, строка остаётся для истории.
-- ============================================================================

create table if not exists public.dev_admins (
  user_id    uuid primary key,
  note       text,
  granted_at timestamptz not null default now(),
  revoked_at timestamptz
);
alter table public.dev_admins enable row level security;
revoke all on public.dev_admins from anon, authenticated;

create table if not exists public.dev_log (
  id      bigserial primary key,
  at      timestamptz not null default now(),
  admin   uuid not null,
  action  text not null,
  target  uuid,
  system_id text,
  data    jsonb
);
alter table public.dev_log enable row level security;
revoke all on public.dev_log from anon, authenticated;
revoke all on sequence public.dev_log_id_seq from anon, authenticated;

-- ---- доступ
create or replace function public.dev_is_admin()
returns boolean language sql stable security definer set search_path to 'public', 'pg_temp' as $$
  select auth.uid() is not null and exists (select 1 from dev_admins where user_id = auth.uid() and revoked_at is null);
$$;

create or replace function public.dev_assert()
returns uuid language plpgsql stable security definer set search_path to 'public', 'pg_temp' as $$
declare v uuid := auth.uid();
begin
  if v is null or not exists (select 1 from dev_admins where user_id = v and revoked_at is null) then
    raise exception 'Нет доступа' using errcode = '42501';
  end if;
  return v;
end;
$$;

create or replace function public.dev_note(p_admin uuid, p_action text, p_target uuid, p_system text, p_data jsonb)
returns void language sql security definer set search_path to 'public', 'pg_temp' as $$
  insert into dev_log (admin, action, target, system_id, data) values (p_admin, p_action, p_target, p_system, p_data);
$$;

-- назначение и снятие — только владельцем базы (игрокам не выдано)
create or replace function public.dev_admin_grant(p_user uuid, p_note text default null)
returns void language sql security definer set search_path to 'public', 'pg_temp' as $$
  insert into dev_admins (user_id, note) values (p_user, p_note)
  on conflict (user_id) do update set revoked_at = null, granted_at = now(), note = coalesce(excluded.note, dev_admins.note);
$$;
create or replace function public.dev_admin_revoke(p_user uuid)
returns void language sql security definer set search_path to 'public', 'pg_temp' as $$
  update dev_admins set revoked_at = now() where user_id = p_user and revoked_at is null;
$$;

-- ---- справочник для панели: игроки, планеты, сырьё, бойцы, корабли
create or replace function public.dev_catalog()
returns jsonb language plpgsql stable security definer set search_path to 'public', 'pg_temp' as $$
declare v_me uuid := dev_assert();
begin
  return jsonb_build_object(
    'me', v_me,
    'players', (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'nick', coalesce(p.nickname, '—'), 'faction', p.faction, 'credits', p.credits,
                        'planet', (select sc.system_id from system_control sc where sc.controller_user_id = p.id limit 1)) order by p.nickname), '[]') from profiles p),
    'systems', (select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'faction', s.faction, 'station', exists (select 1 from station_slots z where z.system_id = s.id)) order by s.name), '[]') from systems s),
    'resources', (select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'name', r.name) order by r.name), '[]') from resources r),
    'units', (select coalesce(jsonb_agg(jsonb_build_object('id', u.id, 'name', u.name, 'faction', u.faction, 'vehicle', coalesce(u.is_vehicle, false)) order by u.faction, coalesce(u.is_vehicle, false), u.name), '[]')
                from unit_types u where not coalesce(u.is_hero, false) and u.faction in ('republic', 'cis')),
    'ships', (select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'faction', t.faction, 'cls', t.hull_class) order by t.faction, t.max_hp, t.name), '[]')
                from ship_types t where not coalesce(t.is_fighter, false) and t.faction in ('republic', 'cis'))
  );
end;
$$;

-- ---- кредиты игроку (отрицательное — списать; ниже нуля не уходит)
create or replace function public.dev_credits(p_user uuid, p_amount integer)
returns integer language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare v_me uuid := dev_assert(); v_new integer;
begin
  if p_amount is null or abs(p_amount) > 10000000 then raise exception 'Сумма от −10 000 000 до 10 000 000'; end if;
  update profiles set credits = greatest(0, credits + p_amount) where id = p_user returning credits into v_new;
  if not found then raise exception 'Игрок не найден'; end if;
  perform dev_note(v_me, 'credits', p_user, null, jsonb_build_object('amount', p_amount, 'now', v_new));
  return v_new;
end;
$$;

-- ---- сырьё на склад планеты (p_resource = 'all' — всё сырьё разом)
create or replace function public.dev_stock(p_system text, p_resource text, p_amount integer)
returns jsonb language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare v_me uuid := dev_assert(); r record;
begin
  if not exists (select 1 from systems where id = p_system) then raise exception 'Нет такой планеты'; end if;
  if p_amount is null or abs(p_amount) > 1000000 then raise exception 'Количество от −1 000 000 до 1 000 000'; end if;
  if p_resource <> 'all' and not exists (select 1 from resources where id = p_resource) then raise exception 'Нет такого сырья'; end if;
  for r in select id from resources where p_resource = 'all' or id = p_resource loop
    insert into planet_stock (system_id, resource, amount) values (p_system, r.id, greatest(0, p_amount))
    on conflict (system_id, resource) do update set amount = greatest(0, planet_stock.amount + p_amount);
  end loop;
  perform dev_note(v_me, 'stock', null, p_system, jsonb_build_object('resource', p_resource, 'amount', p_amount));
  return (select coalesce(jsonb_object_agg(resource, amount), '{}') from planet_stock where system_id = p_system);
end;
$$;

-- ---- бойцы игроку на планету (выходят в зоне высадки, как пополнение)
create or replace function public.dev_units(p_user uuid, p_system text, p_unit_type text, p_qty integer)
returns integer language plpgsql security definer set search_path to 'public', 'extensions', 'pg_temp' as $$
declare v_me uuid := dev_assert(); v_faction text; v_ut record; v_id uuid; v_left integer;
begin
  select faction into v_faction from profiles where id = p_user;
  if v_faction not in ('republic', 'cis') then raise exception 'У игрока нет фракции'; end if;
  select * into v_ut from unit_types where id = p_unit_type;
  if not found or coalesce(v_ut.is_hero, false) then raise exception 'Нет такого бойца'; end if;
  if v_ut.faction is distinct from v_faction then raise exception 'Боец другой фракции'; end if;
  if not exists (select 1 from systems where id = p_system) then raise exception 'Нет такой планеты'; end if;
  if p_qty is null or p_qty < 1 or p_qty > 50 then raise exception 'От 1 до 50 за раз'; end if;
  insert into unit_orders (system_id, building_id, unit_type, owner_user_id, faction, quantity, completes_at, upgrades)
  values (p_system, null, p_unit_type, p_user, v_faction, p_qty, now(), '{}') returning id into v_id;
  perform deliver_ready_units();
  select case when delivered then 0 else quantity end into v_left from unit_orders where id = v_id;
  if coalesce(v_left, 0) > 0 then update unit_orders set delivered = true where id = v_id; end if;   -- места не хватило — остаток не висит в очереди
  perform dev_note(v_me, 'units', p_user, p_system, jsonb_build_object('type', p_unit_type, 'qty', p_qty, 'placed', p_qty - coalesce(v_left, 0)));
  return p_qty - coalesce(v_left, 0);
end;
$$;

-- ---- корабли игроку на орбиту (встают у места станции, ангар полон истребителей)
create or replace function public.dev_ships(p_user uuid, p_system text, p_ship_type text, p_qty integer)
returns integer language plpgsql security definer set search_path to 'public', 'extensions', 'pg_temp' as $$
declare v_me uuid := dev_assert(); v_faction text; v_st record; i integer; v_ids uuid[] := '{}'; v_id uuid; v_ok integer;
begin
  select faction into v_faction from profiles where id = p_user;
  if v_faction not in ('republic', 'cis') then raise exception 'У игрока нет фракции'; end if;
  select * into v_st from ship_types where id = p_ship_type;
  if not found or coalesce(v_st.is_fighter, false) then raise exception 'Нет такого корабля'; end if;
  if v_st.faction is distinct from v_faction then raise exception 'Корабль другой фракции'; end if;
  if not exists (select 1 from station_slots where system_id = p_system) then raise exception 'У этой системы нет орбиты со станцией'; end if;
  if p_qty is null or p_qty < 1 or p_qty > 5 then raise exception 'От 1 до 5 за раз'; end if;
  for i in 1..p_qty loop
    insert into ship_orders (system_id, ship_type, owner_user_id, faction, completes_at, fighters, bombers, upgrades)
    values (p_system, p_ship_type, p_user, v_faction, now(), coalesce(v_st.hangar_slots, 0), 0, '{}') returning id into v_id;
    v_ids := v_ids || v_id;
  end loop;
  perform deliver_ready_ships();
  select count(*) into v_ok from ship_orders where id = any(v_ids) and delivered;
  update ship_orders set delivered = true where id = any(v_ids) and not delivered;          -- орбита забита — не висит в очереди
  perform dev_note(v_me, 'ships', p_user, p_system, jsonb_build_object('type', p_ship_type, 'qty', p_qty, 'placed', v_ok));
  return v_ok;
end;
$$;

-- ---- все исследования своей фракции игроку
create or replace function public.dev_research_all(p_user uuid)
returns integer language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare v_me uuid := dev_assert(); v_faction text; n integer;
begin
  select faction into v_faction from profiles where id = p_user;
  if v_faction not in ('republic', 'cis') then raise exception 'У игрока нет фракции'; end if;
  insert into player_research (user_id, research_id)
  select p_user, r.id from researches r
   where r.id not like (case v_faction when 'republic' then 'cis\_%' else 'rep\_%' end)
  on conflict do nothing;
  get diagnostics n = row_count;
  perform dev_note(v_me, 'research_all', p_user, null, jsonb_build_object('added', n));
  return n;
end;
$$;

-- ---- всё, что строится и готовится на планете, — готово сейчас
create or replace function public.dev_finish(p_system text)
returns jsonb language plpgsql security definer set search_path to 'public', 'extensions', 'pg_temp' as $$
declare v_me uuid := dev_assert(); a integer; b integer; c integer; d integer; e integer; f integer; g integer; h integer;
begin
  if not exists (select 1 from systems where id = p_system) then raise exception 'Нет такой планеты'; end if;
  update buildings set completes_at = now() where system_id = p_system and completes_at > now(); get diagnostics a = row_count;
  update unit_orders set completes_at = now() where system_id = p_system and not coalesce(delivered, false) and completes_at > now(); get diagnostics b = row_count;
  update research_orders set completes_at = now() where system_id = p_system and not coalesce(delivered, false) and completes_at > now(); get diagnostics c = row_count;
  update ship_orders set completes_at = now() where system_id = p_system and not coalesce(delivered, false) and completes_at > now(); get diagnostics d = row_count;
  update repair_orders set completes_at = now() where system_id = p_system and not coalesce(delivered, false) and completes_at > now(); get diagnostics e = row_count;
  update field_structures set completes_at = now() where system_id = p_system and completes_at > now(); get diagnostics f = row_count;
  update space_stations set completes_at = now() where system_id = p_system and completes_at > now(); get diagnostics g = row_count;
  update settlement_state set upgrade_until = now() where system_id = p_system and upgrade_until > now(); get diagnostics h = row_count;
  perform settle_due_orders();
  perform dev_note(v_me, 'finish', null, p_system, jsonb_build_object('buildings', a, 'units', b, 'research', c, 'ships', d, 'repairs', e, 'structs', f, 'station', g, 'settlement', h));
  return jsonb_build_object('buildings', a, 'units', b, 'research', c, 'ships', d, 'repairs', e, 'structs', f, 'station', g, 'settlement', h);
end;
$$;

-- ---- уровень поселения 1..4
create or replace function public.dev_settlement_level(p_system text, p_level integer)
returns void language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare v_me uuid := dev_assert();
begin
  if p_level is null or p_level < 1 or p_level > 4 then raise exception 'Уровень от 1 до 4'; end if;
  update settlement_state set level = p_level, upgrade_until = null, upgrade_to = null where system_id = p_system;
  if not found then raise exception 'У планеты нет поселения'; end if;
  perform dev_note(v_me, 'settlement_level', null, p_system, jsonb_build_object('level', p_level));
end;
$$;

-- ---- обучение: засчитать текущий шаг (награду игрок забирает сам)
create or replace function public.dev_tutorial_done(p_user uuid)
returns integer language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare v_me uuid := dev_assert(); v_ord integer;
begin
  update tutorial_state set step_done = true where user_id = p_user and status = 'active' returning step_ord into v_ord;
  if not found then raise exception 'Обучение не идёт'; end if;
  perform dev_note(v_me, 'tutorial_done', p_user, null, jsonb_build_object('step', v_ord));
  return v_ord;
end;
$$;

-- ---- журнал панели
create or replace function public.dev_recent(p_limit integer default 30)
returns table(at timestamptz, admin text, action text, target text, system_id text, data jsonb)
language plpgsql stable security definer set search_path to 'public', 'pg_temp' as $$
begin
  perform dev_assert();
  return query
  select l.at, coalesce(pa.nickname, '?'), l.action, pt.nickname, l.system_id, l.data
    from dev_log l left join profiles pa on pa.id = l.admin left join profiles pt on pt.id = l.target
   order by l.id desc limit least(greatest(coalesce(p_limit, 30), 1), 100);
end;
$$;

-- ---- права: только вошедшим игрокам и только эти функции; служебные — никому
do $$
declare f text;
begin
  foreach f in array array['dev_is_admin()', 'dev_assert()', 'dev_note(uuid, text, uuid, text, jsonb)', 'dev_admin_grant(uuid, text)', 'dev_admin_revoke(uuid)',
                           'dev_catalog()', 'dev_credits(uuid, integer)', 'dev_stock(text, text, integer)', 'dev_units(uuid, text, text, integer)',
                           'dev_ships(uuid, text, text, integer)', 'dev_research_all(uuid)', 'dev_finish(text)', 'dev_settlement_level(text, integer)',
                           'dev_tutorial_done(uuid)', 'dev_recent(integer)']
  loop execute format('revoke all on function public.%s from public, anon, authenticated', f); end loop;
  foreach f in array array['dev_is_admin()', 'dev_catalog()', 'dev_credits(uuid, integer)', 'dev_stock(text, text, integer)', 'dev_units(uuid, text, text, integer)',
                           'dev_ships(uuid, text, text, integer)', 'dev_research_all(uuid)', 'dev_finish(text)', 'dev_settlement_level(text, integer)',
                           'dev_tutorial_done(uuid)', 'dev_recent(integer)']
  loop execute format('grant execute on function public.%s to authenticated', f); end loop;
end $$;

-- первый админ — Артём (C0BecTb)
select public.dev_admin_grant('17fa55f1-4dd6-4281-b6eb-06bdc79925f9', 'C0BecTb · владелец');
