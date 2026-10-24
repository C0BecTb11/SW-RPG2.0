-- Снимок (pg_get_functiondef): функции других механик, от которых зависит снабжение. 24.10.2026
-- capture_tick, refund_pending_on_capture, start_commander_move

CREATE OR REPLACE FUNCTION public.capture_tick()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
declare
  v_capture_flag text := set_config('app.capture_transfer', '1', true);
  sysrec record; c record; v_row record;
  v_goal integer := game_setting_int('capture_seconds', 60);
  v_progress numeric; v_rate integer; v_status text; v_faction text;
begin
  for sysrec in
    select distinct s.id, s.faction
    from systems s
    where s.faction is not null
      and (exists (
        select 1 from unit_positions u
        join unit_types t on t.id = u.unit_type
        where u.system_id = s.id and u.layer = 'ground' and u.hp > 0
          and u.x is not null and not t.is_vehicle
          and is_in_settlement_zone(u.x, u.y))
      or exists (select 1 from system_capture sc where sc.system_id = s.id))
  loop
    select * into c from capture_counts(sysrec.id);
    select * into v_row from system_capture where system_id = sysrec.id;

    v_progress := coalesce(capture_progress(sysrec.id), 0);
    v_faction  := coalesce(v_row.faction, c.attacker_faction);

    if v_faction is null then
      delete from system_capture where system_id = sysrec.id;
      continue;
    end if;

    if c.attackers > c.defenders then
      -- О начале захвата сообщаем один раз, когда полоса только пошла
      if v_row is null or v_row.status is distinct from 'capturing' then
        perform log_event(
          (select controller_user_id from system_control where system_id = sysrec.id),
          sysrec.faction, sysrec.id, 'capture_started',
          c.attacker_faction, c.attackers, 'private',
          jsonb_build_object('attackers', c.attackers, 'defenders', c.defenders));

        -- Поселение поднимает ополчение (сбор раз в несколько часов)
        begin
          perform raise_militia(sysrec.id);
        exception when others then perform err_db('capture_tick', sqlstate, sqlerrm, true);
          raise warning 'raise_militia %: %', sysrec.id, sqlerrm;
        end;
      end if;

      v_rate := 1; v_status := 'capturing';
      v_faction := coalesce(c.attacker_faction, v_faction);
    elsif c.defenders > c.attackers then
      v_rate := -1; v_status := 'reverting';
    elsif c.attackers = 0 then
      v_rate := 0; v_status := 'stalled';
    else
      v_rate := 0; v_status := 'contested';
    end if;

    if v_progress <= 0 and v_rate <= 0 then
      delete from system_capture where system_id = sysrec.id;
      continue;
    end if;

    if v_progress >= v_goal then
      perform refund_pending_on_capture(sysrec.id);

      update systems set faction = v_faction where id = sysrec.id;

      -- Ополчение прежних хозяев расходится, иначе оно тут же «захватывало» бы обратно
      delete from unit_positions u
      using npc_brains nb
      where nb.unit_id = u.id and nb.kind = 'militia' and u.system_id = sysrec.id;
      delete from system_control where system_id = sysrec.id;

      -- Стороны перевернулись: разводим тех, кто остался в чужих зонах
      perform evacuate_zones_after_capture(sysrec.id, v_faction);

      update system_capture
      set progress = 0, rate = 0, status = 'distribution',
          faction = v_faction, updated_at = now()
      where system_id = sysrec.id;

      perform log_event(null, v_faction, sysrec.id, 'planet_captured', null, 1, 'all',
                        jsonb_build_object('from_faction', sysrec.faction));
      continue;
    end if;

    if v_row is null
       or v_row.rate is distinct from v_rate
       or v_row.faction is distinct from v_faction
       or v_row.status is distinct from v_status then

      insert into system_capture (system_id, faction, progress, rate, status, updated_at)
      values (sysrec.id, v_faction, v_progress, v_rate, v_status, now())
      on conflict (system_id) do update
        set faction = excluded.faction, progress = excluded.progress,
            rate = excluded.rate, status = excluded.status,
            updated_at = excluded.updated_at;
    end if;
  end loop;
end;
$function$

-- ----------------------------------------
CREATE OR REPLACE FUNCTION public.refund_pending_on_capture(p_system_id text)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
declare
  r record;
  v_half integer;
  o record;
  v_back integer;
  v_goods integer;
begin
  -- Юниты в производстве
  for r in
    select uo.id, uo.owner_user_id, uo.quantity, ut.cost, ut.name
    from unit_orders uo
    join unit_types ut on ut.id = uo.unit_type
    where uo.system_id = p_system_id and not uo.delivered
  loop
    v_half := floor(coalesce(r.cost, 0) * r.quantity / 2.0);
    update profiles set credits = credits + v_half where id = r.owner_user_id;
    delete from unit_orders where id = r.id;

    perform log_event(r.owner_user_id, null, p_system_id, 'order_refunded',
                      r.name, r.quantity, 'private',
                      jsonb_build_object('refund', v_half, 'reason', 'capture'));
  end loop;

  -- Незаконченный ремонт
  for r in
    select ro.id, ro.owner_user_id, ro.cost
    from repair_orders ro
    where ro.system_id = p_system_id and not ro.delivered
  loop
    v_half := floor(coalesce(r.cost, 0) / 2.0);
    update profiles set credits = credits + v_half where id = r.owner_user_id;
    delete from repair_orders where id = r.id;

    perform log_event(r.owner_user_id, null, p_system_id, 'order_refunded',
                      'Ремонт', 1, 'private',
                      jsonb_build_object('refund', v_half, 'reason', 'capture'));
  end loop;

  -- Корабли на стапеле
  for r in
    select so.id, so.owner_user_id, st.cost, st.name
    from ship_orders so
    join ship_types st on st.id = so.ship_type
    where so.system_id = p_system_id and not so.delivered
  loop
    v_half := floor(coalesce(r.cost, 0) / 2.0);
    update profiles set credits = credits + v_half where id = r.owner_user_id;
    delete from ship_orders where id = r.id;

    perform log_event(r.owner_user_id, null, p_system_id, 'order_refunded',
                      r.name, 1, 'private',
                      jsonb_build_object('refund', v_half, 'reason', 'capture'));
  end loop;

  -- Недостроенные здания
  for r in
    select b.id, b.owner_user_id, bt.cost, bt.name
    from buildings b
    join building_types bt on bt.id = b.building_type_id
    where b.system_id = p_system_id
      and b.completes_at is not null and b.completes_at > now()
  loop
    v_half := floor(coalesce(r.cost, 0) / 2.0);
    update profiles set credits = credits + v_half where id = r.owner_user_id;
    delete from buildings where id = r.id;

    perform log_event(r.owner_user_id, null, p_system_id, 'construction_refunded',
                      r.name, 1, 'private',
                      jsonb_build_object('refund', v_half, 'reason', 'capture'));
  end loop;

  -- Рынок: лоты на захваченной планете закрываются. Покупателям — деньги по броням,
  -- товар (непроданный и забронированный) остаётся на складе планеты: ресурсы при захвате остаются на ней
  for r in
    select l.* from market_lots l where l.system_id = p_system_id and l.active for update
  loop
    v_goods := r.amount_left;
    for o in
      select * from market_orders mo where mo.lot_id = r.id and mo.status = 'reserved' for update
    loop
      v_back := o.amount_left * o.price_per_unit;
      update profiles set credits = credits + v_back where id = o.buyer_user_id;
      update market_orders set status = 'cancelled', amount_left = 0 where id = o.id;
      v_goods := v_goods + o.amount_left;
      perform log_event(o.buyer_user_id, null, p_system_id, 'market_expired', null, v_back, 'private',
                        jsonb_build_object('reason', 'capture'));
    end loop;
    perform add_planet_stock(p_system_id, r.resource, v_goods);
    update market_lots set active = false, amount_left = 0 where id = r.id;
    perform log_event(r.seller_user_id, r.seller_faction, p_system_id, 'market_cancelled', r.resource, v_goods, 'private',
                      jsonb_build_object('reason', 'capture'));
  end loop;

  -- Недостроенная станция
  for r in
    select ss.system_id, ss.owner_user_id, ss.faction, bt.cost
    from space_stations ss
    left join building_types bt on bt.is_space and bt.faction = ss.faction
    where ss.system_id = p_system_id
      and ss.completes_at is not null and ss.completes_at > now()
  loop
    v_half := floor(coalesce(r.cost, 5000) / 2.0);
    update profiles set credits = credits + v_half where id = r.owner_user_id;
    delete from space_stations where system_id = p_system_id;

    perform log_event(r.owner_user_id, null, p_system_id, 'construction_refunded',
                      'Орбитальная станция', 1, 'private',
                      jsonb_build_object('refund', v_half, 'reason', 'capture'));
  end loop;
end;
$function$

-- ----------------------------------------
CREATE OR REPLACE FUNCTION public.start_commander_move(p_commander_id uuid, p_target_system text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
declare
  v_user_id uuid := auth.uid();
  v_current text;
  v_unlocked boolean;
  v_arrives timestamptz;
  v_seconds integer;
  v_side text;
  v_not_ready integer;
  v_held text;
  v_moving text;
begin
  if v_user_id is null then
    raise exception 'Не авторизован';
  end if;

  select current_system, unlocked, arrives_at, moving_to
    into v_current, v_unlocked, v_arrives, v_moving
  from commanders
  where id = p_commander_id and user_id = v_user_id
  for update;

  if v_current is null and v_unlocked is null then
    raise exception 'Командир не найден';
  end if;

  if not v_unlocked then
    raise exception 'Командир ещё не разблокирован';
  end if;

  if v_moving is not null then
    if v_arrives is not null and v_arrives > now() then
      raise exception 'Командир уже в пути';
    end if;
    raise exception 'Флот только что прибыл — подожди пару секунд и повтори';
  end if;

  if v_current is null then
    raise exception 'Неизвестна текущая система командира';
  end if;

  if v_current = p_target_system then
    raise exception 'Командир уже находится в этой системе';
  end if;

  if not exists (
    select 1 from hyperlanes h
    where (h.system_a = v_current and h.system_b = p_target_system)
       or (h.system_b = v_current and h.system_a = p_target_system)
  ) then
    raise exception 'Между системами нет прямого маршрута';
  end if;

  select hyperspace_side(v_current, faction) into v_side
  from profiles where id = v_user_id;

  select count(*) into v_not_ready
  from ships s
  join ship_types t on t.id = s.ship_type
  where s.commander_id = p_commander_id
    and s.system_id = v_current
    and not s.in_transit
    and s.carrier_ship_id is null
    and not is_in_hyperspace_zone(
      s.y, ship_box_h(t.width_cells, t.height_cells, s.facing), v_side);

  if v_not_ready > 0 then
    raise exception 'Флот не готов к прыжку: % корабль(ей) вне зоны гиперпространства', v_not_ready;
  end if;

  select coalesce(s.name, t.name) into v_held
  from ships s join ship_types t on t.id = s.ship_type
  where s.commander_id = p_commander_id and s.system_id = v_current
    and not s.in_transit and s.carrier_ship_id is null
    and ship_active_boarding(s.id) is not null
  limit 1;
  if v_held is not null then
    raise exception 'Флот не может прыгнуть: «%» сцеплен абордажем', v_held;
  end if;

  select coalesce(s.name, t.name) into v_held
  from ships s join ship_types t on t.id = s.ship_type
  where s.commander_id = p_commander_id and s.system_id = v_current
    and not s.in_transit and s.carrier_ship_id is null
    and s.tractor_until is not null and s.tractor_until > now()
  limit 1;
  if v_held is not null then
    raise exception 'Флот не может прыгнуть: «%» удерживается притягивающим лучом', v_held;
  end if;

  select coalesce(s.name, t.name) || '» — ещё ' || ceil(extract(epoch from s.jump_lock_until - now()) / 3600.0)::integer || ' ч'
    into v_held
  from ships s join ship_types t on t.id = s.ship_type
  where s.commander_id = p_commander_id and s.system_id = v_current
    and not s.in_transit and s.carrier_ship_id is null
    and s.jump_lock_until is not null and s.jump_lock_until > now()
  order by s.jump_lock_until desc
  limit 1;
  if v_held is not null then
    raise exception 'Флот не может прыгнуть: гипердвигатель трофея «% (ремонт в доке снимет запрет)', v_held;
  end if;

  select value::integer into v_seconds from game_settings where key = 'travel_seconds';
  v_seconds := coalesce(v_seconds, 60);
  -- галактические события на этом гиперпути: шторм дольше, линия снабжения быстрее (sql/galaxy_events_2.sql)
  v_seconds := greatest(10, round(v_seconds * (100 + ge_travel_mod(v_current, p_target_system)) / 100.0)::integer);

  update commanders
  set warned_at = null,
      moving_from = v_current,
      moving_to = p_target_system,
      departed_at = now(),
      arrives_at = now() + make_interval(secs => v_seconds)
  where id = p_commander_id;

  -- Флот уходит в гиперпространство одновременно с командиром:
  -- пропадает с карты и освобождает клетки
  update ships
  set in_transit = true
  where commander_id = p_commander_id and system_id = v_current
    and carrier_ship_id is null;
end;
$function$

-- ----------------------------------------
CREATE OR REPLACE FUNCTION public.interception_tick()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
declare i record; tgt record; sh record;
begin
  for i in
    select * from interceptions where status = 'pending' and resolves_at <= now()
  loop
    -- Досаживаем перехватчика в пустоту, если крон перелётов не успел
    perform finish_commander_move(i.hunter_commander);

    select * into tgt from commanders where id = i.target_commander;

    if tgt.moving_to is null or tgt.arrives_at is null or tgt.arrives_at <= now() then
      update interceptions set status = 'missed' where id = i.id;

      perform log_event(i.hunter_user, null, i.lane_system, 'interception_missed',
                        null, 1, 'private', null);
      continue;
    end if;

    -- Вырываем цель из гиперпространства
    for sh in
      select id from ships
      where commander_id = tgt.id and system_id = tgt.moving_from
      order by id
    loop
      perform place_ship_in_hyperspace(sh.id, i.lane_system);
    end loop;

    update commanders
    set current_system = i.lane_system, route = null,
        moving_from = null, moving_to = null,
        departed_at = null, arrives_at = null
    where id = tgt.id;

    update interceptions set status = 'engaged' where id = i.id;

    perform log_event(i.hunter_user, null, i.lane_system, 'interception_engaged',
                      tgt.name, 1, 'private', null);
    perform log_event(i.target_user, tgt.faction, i.lane_system, 'fleet_intercepted',
                      tgt.name, 1, 'private', null);
  end loop;
end;
$function$

-- ----------------------------------------
CREATE OR REPLACE FUNCTION public.approach_warning_tick()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
declare c record; v_owner uuid; v_pct numeric; v_trade boolean;
begin
  for c in
    select cm.id, cm.name, cm.faction, cm.user_id, cm.moving_from, cm.moving_to,
           cm.departed_at, cm.arrives_at
    from commanders cm
    join systems s on s.id = cm.moving_to
    where cm.moving_to is not null
      and cm.arrives_at > now()
      and cm.warned_at is null
      and not s.is_deep_space
  loop
    v_pct := extract(epoch from now() - c.departed_at)
             / nullif(extract(epoch from c.arrives_at - c.departed_at), 0) * 100;

    continue when coalesce(v_pct, 0) < game_setting_int('approach_warn_pct', 80);

    select sc.controller_user_id into v_owner
    from system_control sc
    join profiles p on p.id = sc.controller_user_id
    where sc.system_id = c.moving_to and p.faction is distinct from c.faction;

    if v_owner is not null then
      -- Летит ли этот флот за покупкой именно на эту планету
      v_trade := exists (
        select 1 from supply_routes sr
        where sr.commander_id = c.id and sr.status = 'active' and sr.order_id is not null
          and sr.stops -> sr.stop_index ->> 'system_id' = c.moving_to
          and supply_stop_is_pickup(sr.stops -> sr.stop_index));

      if v_trade then
        perform log_event(v_owner,
                          (select faction from systems where id = c.moving_to),
                          c.moving_to, 'trade_approaching',
                          (select nickname from profiles where id = c.user_id),
                          greatest(0, ceil(extract(epoch from c.arrives_at - now()))::integer),
                          'private', null);
      else
        perform log_event(v_owner,
                          (select faction from systems where id = c.moving_to),
                          c.moving_to, 'enemy_approaching',
                          c.name,
                          greatest(0, ceil(extract(epoch from c.arrives_at - now()))::integer),
                          'private',
                          jsonb_build_object('from', c.moving_from));
      end if;
    end if;

    update commanders set warned_at = now() where id = c.id;
  end loop;
end;
$function$

-- ----------------------------------------
-- Выдержка (не всё тело) — mine_finish, строки 15–25 ДО sql/supply_fixes.sql: неизрасходованное сырьё цеха возвращалось
-- в planet_stock прямым INSERT ... ON CONFLICT мимо add_planet_stock / planet_stock_cap. Теперь — add_planet_stock
-- (полное тело — sql/mine_refine.sql):
--   if p_status <> 'lost' and v_back > 0 then
--     insert into planet_stock (system_id, resource, amount) values (sh.system_id, k, v_back)
--     on conflict (system_id, resource) do update set amount = planet_stock.amount + v_back;
--   end if;
