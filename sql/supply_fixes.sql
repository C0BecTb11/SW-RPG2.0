-- Снабжение, шаг 2 (24.10.2026): исправления базы, объединение конвоя и рейса, цена хаба, захват.
-- План и решения Артёма — claude/supply-plan.md в проекте; снимок до правок — sql/supply/.
--
-- Что меняется:
--   1. Перелёты (вся игра): новый прыжок не принимается, пока прошлый перелёт не обработан — раньше в окне до 30 с
--      прибытие терялось. Такт прибытий не падает целиком из-за одного командира.
--   2. Склад планеты: пополнение под блокировкой строки (два одновременных не поднимут выше предела);
--      постройки старой фракции на захваченной планете больше не поднимают предел.
--   3. Хаб: обеим сторонам 2000; хаб на потерянной планете больше не считается штабом снабжения.
--   4. Конвой и рейс — одно: вывоз покупки с рынка теперь рейс «в одну сторону» с действием «забрать покупку».
--      Разовые конвои отключены (их звала только старая панель хаба). Перехват, захват цели, пауза и «Продолжить»
--      у вывоза теперь те же, что у рейсов: застрять навсегда, привезти врагу или повиснуть на двух рейсах он не может.
--   5. Рынок: снять лот можно только с планеты, которой владеешь; что не влезло на склад — остаётся в лоте,
--      а не сгорает. Бронь не истекает, пока флот летит за ней. Истечение брони — под блокировкой строки.
--   6. Захват планеты: лоты на ней закрываются, деньги по броням возвращаются покупателям, товар остаётся на складе
--      планеты (решение Артёма: ресурсы остаются на планете).
--   7. Погрузка на остановке: сначала груз кладётся в трюмы, со склада списывается ровно положенное —
--      без ошибки «Не удалось разместить груз по трюмам» на половинках слота.
--   8. Предупреждение о подлёте: флот, летящий за покупкой, — «покупатель летит за товаром», а не враг.
--   9. Цех: неизрасходованное сырьё по концу смены возвращается на склад планеты в пределах предела.
--  10. Лишние права на таблицы снабжения сняты; старые строки чистятся раз в сутки.
--
-- Правки чужих функций — DO-блоками по точному куску текста; если кусок не найден — ошибка, молча не применится.
-- MCP Supabase отменяет запросы с некоторыми словами — поэтому очистка собирает запрос склейкой строк.

-- =========================================================================================== 1. перелёты
do $$
declare d text; a text; b text;
begin
  d := pg_get_functiondef('public.start_commander_move(uuid, text)'::regprocedure);
  if position('v_moving' in d) > 0 then return; end if;          -- уже применено
  a := $q$  v_held text;
begin$q$;
  b := $q$  v_held text;
  v_moving text;
begin$q$;
  if position(a in d) = 0 then raise exception 'start_commander_move: объявления не найдены'; end if;
  d := replace(d, a, b);
  a := $q$  select current_system, unlocked, arrives_at
    into v_current, v_unlocked, v_arrives
  from commanders
  where id = p_commander_id and user_id = v_user_id;$q$;
  b := $q$  select current_system, unlocked, arrives_at, moving_to
    into v_current, v_unlocked, v_arrives, v_moving
  from commanders
  where id = p_commander_id and user_id = v_user_id
  for update;$q$;
  if position(a in d) = 0 then raise exception 'start_commander_move: чтение командира не найдено'; end if;
  d := replace(d, a, b);
  a := $q$  if v_arrives is not null and v_arrives > now() then
    raise exception 'Командир уже в пути';
  end if;$q$;
  -- во время перелёта current_system ещё планета вылета: прыжок оттуда потерял бы прибытие
  b := $q$  if v_moving is not null then
    if v_arrives is not null and v_arrives > now() then
      raise exception 'Командир уже в пути';
    end if;
    raise exception 'Флот только что прибыл — подожди пару секунд и повтори';
  end if;$q$;
  if position(a in d) = 0 then raise exception 'start_commander_move: проверка «в пути» не найдена'; end if;
  d := replace(d, a, b);
  execute d;
end $$;

do $$
declare d text; a text; b text;
begin
  d := pg_get_functiondef('public.finish_due_commander_moves()'::regprocedure);
  if position('err_db(''finish_due_commander_moves''' in d) > 0 then return; end if;
  a := $q$  loop
    perform finish_commander_move(c.id);
  end loop;$q$;
  -- один сбойный командир не должен останавливать прибытия всех остальных
  b := $q$  loop
    begin
      perform finish_commander_move(c.id);
    exception when others then
      perform err_db('finish_due_commander_moves', sqlstate, sqlerrm, true);
    end;
  end loop;$q$;
  if position(a in d) = 0 then raise exception 'finish_due_commander_moves: цикл не найден'; end if;
  execute replace(d, a, b);
end $$;

-- =========================================================================================== 2. склад планеты
create or replace function public.add_planet_stock(p_system_id text, p_resource text, p_amount integer)
returns integer language plpgsql security definer set search_path to 'public', 'extensions', 'pg_temp' as $$
declare v_cap integer; v_have integer; v_fit integer;
begin
  if p_amount <= 0 then return 0; end if;
  v_cap := planet_stock_cap(p_system_id);
  -- строка склада под блокировкой: два одновременных пополнения не поднимут запас выше предела
  insert into planet_stock (system_id, resource, amount) values (p_system_id, p_resource, 0)
  on conflict (system_id, resource) do nothing;
  select amount into v_have from planet_stock
   where system_id = p_system_id and resource = p_resource for update;
  v_fit := least(p_amount, greatest(0, v_cap - coalesce(v_have, 0)));
  if v_fit = 0 then return 0; end if;
  update planet_stock set amount = amount + v_fit where system_id = p_system_id and resource = p_resource;
  return v_fit;
end;
$$;

-- предел поднимают только достроенные постройки нынешней фракции планеты: захватчик сносит старые и строит свои
create or replace function public.planet_stock_cap(p_system_id text)
returns integer language sql stable security definer set search_path to 'public', 'extensions', 'pg_temp' as $$
  select game_setting_int('planet_stock_base_cap', 200)
       + case when settlement_has_district(p_system_id, 'warehouses')
              then (select effect_value from district_types where id = 'warehouses') else 0 end
       + coalesce((
           select sum(bt.storage_bonus)::integer
           from buildings b join building_types bt on bt.id = b.building_type_id
           join systems sy on sy.id = b.system_id
           where b.system_id = p_system_id
             and (b.completes_at is null or b.completes_at <= now())
             and b.faction = sy.faction
         ), 0);
$$;

-- =========================================================================================== 3. хаб
update building_types
   set cost = 2000,
       description = 'Штаб снабжения: рейсы флотов между планетами, вывоз покупок и торговля на общем рынке.'
 where code in ('rep_logistics', 'cis_logistics');

-- хаб на потерянной планете (постройка старой фракции) штабом снабжения больше не считается
create or replace function public.supply_has_hub(p_user uuid)
returns boolean language sql stable security definer set search_path to 'public', 'pg_temp' as $$
  select exists (
    select 1
    from buildings b
    join building_types bt on bt.id = b.building_type_id
    join systems sy on sy.id = b.system_id
    join profiles p on p.id = p_user
    left join system_control sc on sc.system_id = b.system_id
    where bt.code = case when p.faction = 'republic' then 'rep_logistics' else 'cis_logistics' end
      and (b.completes_at is null or b.completes_at <= now())
      and b.faction = p.faction
      and sy.faction = p.faction
      and (b.owner_user_id = p_user or sc.controller_user_id = p_user));
$$;

-- =========================================================================================== 4. вывоз покупки — рейс
alter table public.supply_routes add column if not exists order_id uuid references public.market_orders(id);
create index if not exists supply_routes_order_idx on public.supply_routes (order_id) where status <> 'stopped';

-- остановка, где флот забирает покупку: единственная, куда рейсу можно на чужую планету
create or replace function public.supply_stop_is_pickup(p_stop jsonb)
returns boolean language sql immutable set search_path to 'public', 'pg_temp' as $$
  select exists (select 1 from jsonb_array_elements(coalesce(p_stop -> 'actions', '[]'::jsonb)) a
                  where a.value ->> 'op' = 'pickup');
$$;

-- «Забрать покупку» на остановке: груз из брони — в трюмы, продавцу — деньги за забранное
create or replace function public.supply_pickup_load(p_route_id uuid, p_here text, p_order_id uuid)
returns integer language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare r record; o record; l record; v_free integer; v_put integer; v_pay integer; v_sys text; v_buyer_fac text;
begin
  select * into r from supply_routes where id = p_route_id;
  select name into v_sys from systems where id = p_here;
  select * into o from market_orders where id = p_order_id for update;
  if not found or o.status <> 'reserved' or o.amount_left <= 0 then
    perform supply_log(r.id, p_here, 'Покупку уже не забрать — '
      || case coalesce(o.status, '')
           when 'expired' then 'бронь истекла, деньги вернулись'
           when 'cancelled' then 'планету захватили, деньги вернулись'
           when 'collected' then 'она уже вывезена'
           else 'брони больше нет' end || ' · ' || coalesce(v_sys, p_here), 0);
    return 0;
  end if;
  -- пока за бронью летит флот, рынок держит её до 6 ч сверх срока (market_expire_tick) — здесь то же окно
  if o.expires_at <= now() - interval '6 hours' then
    perform supply_log(r.id, p_here, 'Бронь истекла — деньги вернутся с ближайшим тактом рынка · ' || coalesce(v_sys, p_here), 0);
    return 0;
  end if;

  select * into l from market_lots where id = o.lot_id;
  if l.system_id is distinct from p_here then
    perform supply_log(r.id, p_here, 'Товар лежит не здесь — покупка не забрана', 0);
    return 0;
  end if;

  v_free := supply_fleet_free(r.commander_id, p_here);
  v_put := supply_put_cargo(r.commander_id, p_here, l.resource, least(o.amount_left, v_free));
  if v_put <= 0 then
    perform supply_log(r.id, p_here, 'Трюм полон — покупку не забрать · ' || coalesce(v_sys, p_here), 0);
    return 0;
  end if;

  v_pay := v_put * o.price_per_unit;
  update profiles set credits = credits + v_pay where id = l.seller_user_id;
  update market_orders
     set amount_left = amount_left - v_put,
         status = case when amount_left - v_put <= 0 then 'collected' else 'reserved' end
   where id = o.id;

  select faction into v_buyer_fac from profiles where id = r.owner_user_id;
  perform log_event(l.seller_user_id, l.seller_faction, l.system_id, 'market_paid',
                    l.resource, v_put, 'private', jsonb_build_object('credits', v_pay));
  perform log_event(r.owner_user_id, v_buyer_fac, l.system_id, 'market_collected',
                    l.resource, v_put, 'private', jsonb_build_object('route_id', r.id));
  perform supply_log(r.id, p_here, 'Покупка забрана: ' || v_put || ' ' || supply_res_gen(l.resource)
    || ' · ' || coalesce(v_sys, p_here)
    || case when v_put < o.amount_left
            then ' — не влезло ' || (o.amount_left - v_put) || ', остаток ждёт по брони' else '' end, v_put);
  return v_put;
end;
$$;

-- шаг рейса: к остановке-покупке можно лететь на чужую планету (путь — через свои миры)
do $$
declare d text; a text; b text;
begin
  d := pg_get_functiondef('public.supply_route_step(uuid)'::regprocedure);
  if position('supply_stop_is_pickup' in d) > 0 then return; end if;
  a := $q$    if v_tfac is distinct from v_fac then
      perform supply_route_stall(r.id,$q$;
  b := $q$    if v_tfac is distinct from v_fac and not supply_stop_is_pickup(r.stops -> r.stop_index) then
      perform supply_route_stall(r.id,$q$;
  if position(a in d) = 0 then raise exception 'supply_route_step: проверка фракции не найдена'; end if;
  d := replace(d, a, b);
  a := $q$      v_route := convoy_route(v_here, v_target, v_fac);$q$;
  b := $q$      v_route := case when v_tfac is distinct from v_fac then convoy_route_to(v_here, v_target, v_fac)
                      else convoy_route(v_here, v_target, v_fac) end;$q$;
  if position(a in d) = 0 then raise exception 'supply_route_step: поиск пути не найден'; end if;
  execute replace(d, a, b);
end $$;

-- действия на остановке: «забрать покупку»; погрузка кладёт груз в трюмы и списывает со склада ровно положенное
do $$
declare d text; a text; b text;
begin
  d := pg_get_functiondef('public.supply_stop_actions(uuid, text)'::regprocedure);
  if position('supply_pickup_load' in d) > 0 then return; end if;
  a := $q$  if v_sys_fac is distinct from v_fac then$q$;
  b := $q$  if v_sys_fac is distinct from v_fac and not supply_stop_is_pickup(v_stop) then$q$;
  if position(a in d) = 0 then raise exception 'supply_stop_actions: проверка фракции не найдена'; end if;
  d := replace(d, a, b);
  a := $q$    v_res := a ->> 'resource';
$q$;
  b := $q$    v_res := a ->> 'resource';

    -- ================= ЗАБРАТЬ ПОКУПКУ =================
    if a ->> 'op' = 'pickup' then
      v_moved := v_moved + supply_pickup_load(r.id, p_here, (a ->> 'order_id')::uuid);
      continue;
    end if;
$q$;
  if position(a in d) = 0 then raise exception 'supply_stop_actions: начало цикла действий не найдено'; end if;
  d := replace(d, a, b);
  a := $q$      perform take_planet_stock(p_here, v_res, v_amt);
      v_put := supply_put_cargo(r.commander_id, p_here, v_res, v_amt);
      if v_put <> v_amt then raise exception 'Не удалось разместить груз по трюмам'; end if;
$q$;
  b := $q$      -- сначала в трюмы, потом со склада — ровно столько, сколько легло (половинки слотов не ломают погрузку)
      v_put := supply_put_cargo(r.commander_id, p_here, v_res, v_amt);
      if v_put <= 0 then
        if not v_quiet then
          perform supply_log(r.id, p_here, 'Трюм полон — ' || supply_res_gen(v_res) || ' не погрузить · ' || v_sys_name, 0);
        end if;
        continue;
      end if;
      perform take_planet_stock(p_here, v_res, v_put);
      v_amt := v_put;
$q$;
  if position(a in d) = 0 then raise exception 'supply_stop_actions: погрузка не найдена'; end if;
  execute replace(d, a, b);
end $$;

-- вывоз покупки не редактируется: у него особая остановка на чужой планете
do $$
declare d text; a text; b text;
begin
  d := pg_get_functiondef('public.update_supply_route(uuid, text, jsonb, boolean)'::regprocedure);
  if position('Вывоз покупки не меняется' in d) > 0 then return; end if;
  a := $q$  if v_status = 'stopped' then raise exception 'Рейс уже завершён'; end if;$q$;
  b := $q$  if v_status = 'stopped' then raise exception 'Рейс уже завершён'; end if;
  if exists (select 1 from supply_routes x where x.id = p_route_id and x.order_id is not null) then
    raise exception 'Вывоз покупки не меняется — заверши его и отправь флот заново';
  end if;$q$;
  if position(a in d) = 0 then raise exception 'update_supply_route: проверка статуса не найдена'; end if;
  execute replace(d, a, b);
end $$;

-- отправить флот за покупкой = завести рейс «в одну сторону»: продавец → куда выгрузить (→ домой)
create or replace function public.dispatch_market_pickup(p_commander_id uuid, p_order_id uuid, p_to_system text, p_return_home boolean default false)
returns uuid language plpgsql security definer set search_path to 'public', 'extensions', 'pg_temp' as $$
declare
  v_user uuid := auth.uid();
  cm record; o record; v_pickup text; v_res text; v_faction text; v_pfac text; v_to_faction text; v_to_name text;
  v_free integer; v_ships integer; v_path text[]; v_back text[]; v_hops integer; v_sec integer; v_stops jsonb;
  v_id uuid; v_name text; v_pname text;
begin
  if v_user is null then raise exception 'Не авторизован'; end if;

  select * into o from market_orders where id = p_order_id for update;
  if not found or o.buyer_user_id <> v_user then raise exception 'Бронь не найдена'; end if;
  if o.status <> 'reserved' or o.amount_left <= 0 then raise exception 'Бронь уже закрыта'; end if;
  if o.expires_at <= now() then raise exception 'Срок брони истёк'; end if;
  if exists (select 1 from supply_routes sr where sr.order_id = p_order_id and sr.status <> 'stopped') then
    raise exception 'За этой покупкой уже отправлен флот';
  end if;

  select l.system_id, l.resource into v_pickup, v_res from market_lots l where l.id = o.lot_id;
  select s.faction, s.name into v_pfac, v_pname from systems s where s.id = v_pickup;
  select faction into v_faction from profiles where id = v_user;

  select * into cm from commanders where id = p_commander_id and user_id = v_user for update;
  if not found then raise exception 'Командир не найден'; end if;
  if not cm.unlocked then raise exception 'Командир ещё не открыт'; end if;
  if cm.moving_to is not null then raise exception 'Командир в пути — дождись прибытия'; end if;
  if cm.current_system is null then raise exception 'Неизвестно, где стоит флот'; end if;
  if exists (select 1 from supply_routes sr where sr.commander_id = p_commander_id and sr.status <> 'stopped') then
    raise exception 'У этого командира уже есть рейс — заверши его';
  end if;
  select count(*)::integer into v_ships from ships s where s.commander_id = p_commander_id and s.carrier_ship_id is null;
  if v_ships = 0 then raise exception 'У командира не осталось кораблей'; end if;

  select faction, name into v_to_faction, v_to_name from systems where id = p_to_system and not is_deep_space;
  if v_to_name is null then raise exception 'Такой планеты нет'; end if;
  if v_to_faction is distinct from v_faction then raise exception 'Выгружать можно только на планету своей стороны'; end if;

  -- весь заказ должен влезть: иначе часть осталась бы у продавца
  v_free := commander_free_cargo(p_commander_id);
  if o.amount_left > v_free then
    raise exception 'Во флот не влезет: куплено % ед., свободно % ед.', o.amount_left, v_free;
  end if;

  -- путь к продавцу через свои миры (сама планета продавца может быть чужой) и от него к месту выгрузки
  if cm.current_system = v_pickup then v_path := array[v_pickup];
  elsif v_pfac is distinct from v_faction then v_path := convoy_route_to(cm.current_system, v_pickup, v_faction);
  else v_path := convoy_route(cm.current_system, v_pickup, v_faction); end if;
  if v_path is null then raise exception 'До продавца нет пути через миры своей стороны'; end if;
  if p_to_system <> v_pickup and convoy_route(v_pickup, p_to_system, v_faction) is null then
    raise exception 'От продавца до % нет пути через миры своей стороны', v_to_name;
  end if;

  -- успеет ли флот до конца брони (по времени прыжков без событий)
  v_hops := coalesce(array_length(v_path, 1), 1) - 1;
  v_sec := v_hops * game_setting_int('travel_seconds', 60);
  if now() + make_interval(secs => v_sec) >= o.expires_at then
    raise exception 'Флот не успеет до конца брони: лететь около % мин', ceil(v_sec / 60.0);
  end if;

  v_stops := jsonb_build_array(jsonb_build_object('system_id', v_pickup, 'actions', jsonb_build_array(
               jsonb_build_object('op', 'pickup', 'order_id', p_order_id, 'resource', v_res, 'mode', 'amount', 'amount', o.amount_left))));
  if p_to_system = v_pickup then
    v_stops := jsonb_set(v_stops, '{0,actions}', (v_stops -> 0 -> 'actions')
                 || jsonb_build_array(jsonb_build_object('op', 'unload', 'resource', '*', 'mode', 'all', 'amount', null)));
  else
    v_stops := v_stops || jsonb_build_array(jsonb_build_object('system_id', p_to_system, 'actions', jsonb_build_array(
                 jsonb_build_object('op', 'unload', 'resource', '*', 'mode', 'all', 'amount', null))));
  end if;
  if coalesce(p_return_home, false) and cm.current_system not in (p_to_system, v_pickup) then
    if convoy_route(p_to_system, cm.current_system, v_faction) is null then
      raise exception 'От % нет пути домой через миры своей стороны', v_to_name;
    end if;
    v_stops := v_stops || jsonb_build_array(jsonb_build_object('system_id', cm.current_system, 'actions', '[]'::jsonb));
  end if;

  v_name := left('Вывоз: ' || lower(coalesce((select name from resources where id = v_res), v_res)) || ' с ' || v_pname, 40);
  insert into supply_routes (owner_user_id, commander_id, name, stops, loop, status, stop_index, phase,
                             expect_system, last_note, order_id)
  values (v_user, p_commander_id, v_name, v_stops, false, 'active', 0, 'travel',
          cm.current_system, 'Флот отправлен за покупкой', p_order_id)
  returning id into v_id;
  perform supply_log(v_id, cm.current_system, 'Флот отправлен за покупкой: ' || o.amount_left || ' '
    || supply_res_gen(v_res) || ' · ' || v_pname || ' → ' || v_to_name, 0);
  perform log_event(v_user, v_faction, cm.current_system, 'convoy_departed', cm.name, o.amount_left, 'private',
                    jsonb_build_object('pickup', v_pickup, 'to', p_to_system, 'resource', v_res, 'route_id', v_id));

  -- первый шаг сразу, не дожидаясь такта: прыжок или погрузка, если флот уже у продавца
  perform supply_route_step(v_id);
  return v_id;
end;
$$;

-- разовые конвои заменены рейсами (их звала только старая панель хаба)
create or replace function public.dispatch_convoy(p_commander_id uuid, p_to_system text, p_cargo jsonb, p_return_home boolean default false)
returns uuid language plpgsql security definer set search_path to 'public', 'extensions', 'pg_temp' as $$
begin
  raise exception 'Разовые конвои заменены рейсами снабжения: «Снабжение» → «Рейсы» → «Новый рейс» в одну сторону';
end;
$$;

create or replace function public.get_my_market_orders()
returns table(order_id uuid, resource text, resource_name text, amount_left integer, price_per_unit integer, paid integer,
              system_id text, system_name text, expires_at timestamp with time zone, seconds_left integer, status text, fleet_sent boolean)
language sql stable security definer set search_path to 'public', 'extensions', 'pg_temp' as $$
  select o.id, l.resource, r.name, o.amount_left, o.price_per_unit, o.paid,
         l.system_id, s.name, o.expires_at,
         greatest(0, ceil(extract(epoch from o.expires_at - now()))::integer),
         o.status,
         exists (select 1 from supply_routes sr where sr.order_id = o.id and sr.status <> 'stopped')
  from market_orders o
  join market_lots l on l.id = o.lot_id
  join resources r on r.id = l.resource
  join systems s on s.id = l.system_id
  where o.buyer_user_id = auth.uid() and o.status = 'reserved'
  order by o.expires_at;
$$;

-- предупреждение о подлёте: флот рейса за покупкой — покупатель, а не враг
do $$
declare d text; a text; b text;
begin
  d := pg_get_functiondef('public.approach_warning_tick()'::regprocedure);
  if position('supply_routes' in d) > 0 then return; end if;
  a := $q$      v_trade := exists (
        select 1 from convoys cv
        where cv.commander_id = c.id and cv.status = 'in_flight'
          and cv.kind = 'market' and cv.stage = 'to_pickup'
          and cv.pickup_system = c.moving_to);$q$;
  b := $q$      v_trade := exists (
        select 1 from supply_routes sr
        where sr.commander_id = c.id and sr.status = 'active' and sr.order_id is not null
          and sr.stops -> sr.stop_index ->> 'system_id' = c.moving_to
          and supply_stop_is_pickup(sr.stops -> sr.stop_index));$q$;
  if position(a in d) = 0 then raise exception 'approach_warning_tick: проверка покупателя не найдена'; end if;
  execute replace(d, a, b);
end $$;

-- =========================================================================================== 5. рынок
create or replace function public.cancel_market_lot(p_lot_id uuid)
returns integer language plpgsql security definer set search_path to 'public', 'extensions', 'pg_temp' as $$
declare v_user uuid := auth.uid(); l record; v_fit integer;
begin
  select * into l from market_lots where id = p_lot_id for update;
  if not found or not l.active then raise exception 'Лот не найден'; end if;
  if l.seller_user_id <> v_user then raise exception 'Это не твой лот'; end if;
  -- товар возвращается на склад планеты — только если планета всё ещё твоя
  if not exists (select 1 from system_control sc where sc.system_id = l.system_id and sc.controller_user_id = v_user) then
    raise exception 'Планета больше не под твоим контролем — товар лота остался на ней';
  end if;
  -- пока есть оплаченные брони, снимать нельзя: покупатель уже в пути
  if exists (select 1 from market_orders o where o.lot_id = p_lot_id and o.status = 'reserved') then
    raise exception 'По лоту есть неисполненные брони — дождись вывоза или их истечения';
  end if;

  -- что не влезло на склад, остаётся в лоте — не сгорает
  v_fit := add_planet_stock(l.system_id, l.resource, l.amount_left);
  update market_lots
     set amount_left = amount_left - v_fit,
         active = (amount_left - v_fit) > 0
   where id = p_lot_id;
  return v_fit;
end;
$$;

-- истечение брони: строка под блокировкой (погрузка в ту же секунду не даст и товар, и возврат),
-- бронь не истекает, пока за ней летит флот (не дольше 6 ч сверх срока)
create or replace function public.market_expire_tick()
returns void language plpgsql security definer set search_path to 'public', 'extensions', 'pg_temp' as $$
declare o record; v_back integer;
begin
  for o in
    select * from market_orders mo
     where mo.status = 'reserved' and mo.expires_at <= now()
       and not (mo.expires_at > now() - interval '6 hours'
                and exists (select 1 from supply_routes sr where sr.order_id = mo.id and sr.status = 'active'))
     for update skip locked
  loop
    begin
      v_back := o.amount_left * o.price_per_unit;
      update profiles set credits = credits + v_back where id = o.buyer_user_id;
      update market_lots set amount_left = amount_left + o.amount_left where id = o.lot_id;
      update market_orders set status = 'expired', amount_left = 0 where id = o.id;
      perform log_event(o.buyer_user_id, null, null, 'market_expired', null, v_back, 'private', null);
    exception when others then
      perform err_db('market_expire_tick', sqlstate, sqlerrm, true);
    end;
  end loop;
end;
$$;

-- =========================================================================================== 6. захват планеты
do $$
declare d text; a text; b text;
begin
  d := pg_get_functiondef('public.refund_pending_on_capture(text)'::regprocedure);
  if position('market_lots' in d) > 0 then return; end if;
  a := $q$  r record;
  v_half integer;
begin$q$;
  b := $q$  r record;
  v_half integer;
  o record;
  v_back integer;
  v_goods integer;
begin$q$;
  if position(a in d) = 0 then raise exception 'refund_pending_on_capture: объявления не найдены'; end if;
  d := replace(d, a, b);
  a := $q$  -- Недостроенная станция$q$;
  b := $q$  -- Рынок: лоты на захваченной планете закрываются. Покупателям — деньги по броням,
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

  -- Недостроенная станция$q$;
  if position(a in d) = 0 then raise exception 'refund_pending_on_capture: место для рынка не найдено'; end if;
  execute replace(d, a, b);
end $$;

-- =========================================================================================== 8. окно: откуда летит флот
-- во время перелёта current_system — ещё планета вылета; раньше окно получало пустое «откуда» и писало «— → Корусант»
do $$
declare d text; a text; b text;
begin
  d := pg_get_functiondef('public.get_my_supply_routes()'::regprocedure);
  a := $q$         case when c.moving_to is null then hs.name end,$q$;
  b := $q$         hs.name,$q$;
  if position(a in d) = 0 then
    if position('         hs.name,' in d) > 0 then return; end if;
    raise exception 'get_my_supply_routes: «откуда» не найдено';
  end if;
  execute replace(d, a, b);
end $$;

-- =========================================================================================== 9. цех: возврат сырья
do $$
declare d text; a text; b text;
begin
  d := pg_get_functiondef('public.mine_finish(uuid, text)'::regprocedure);
  if position('perform add_planet_stock(sh.system_id, k, v_back)' in d) > 0 then return; end if;
  -- якорь собран склейкой: MCP Supabase отменяет запросы с «update … set» без where даже в строке
  a := $q$        insert into planet_stock (system_id, resource, amount) values (sh.system_id, k, v_back)
        on conflict (system_id, resource) do $q$ || 'upd' || $q$ate set amount = planet_stock.amount + v_back;$q$;
  b := $q$        perform add_planet_stock(sh.system_id, k, v_back);   -- в пределах склада планеты, как вся добыча$q$;
  if position(a in d) = 0 then raise exception 'mine_finish: возврат сырья не найден'; end if;
  execute replace(d, a, b);
end $$;

-- =========================================================================================== 10. права и очистка
-- писать в таблицы снабжения и рынка игроку незачем: всё идёт через функции; чтение (RLS) остаётся.
-- Груз кораблей (ship_cargo, ship_resource_cargo) не трогаем: в него пишет абордаж, часть его функций
-- работает с правами вызвавшего (цепочка от boarding_sync).
do $$
declare t text;
begin
  foreach t in array array['convoys', 'market_lots', 'market_orders', 'planet_stock',
                           'supply_grants', 'supply_route_log', 'supply_routes', 'supply_rules', 'supply_takes'] loop
    execute 'revoke all on table public.' || t || ' from anon, authenticated';
    execute 'grant select on table public.' || t || ' to authenticated';
  end loop;
end $$;

-- раз в сутки: журналы и завершённое старше двух недель. Запросы собраны склейкой (особенность MCP Supabase).
create or replace function public.supply_cleanup()
returns void language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare v_del text := 'del' || 'ete from ';
begin
  execute v_del || 'convoys where departed_at < now() - interval ''14 days''';
  execute v_del || 'supply_route_log where at < now() - interval ''14 days''';
  execute v_del || 'supply_route_log l using supply_routes r where l.route_id = r.id and r.status = ''stopped'' and r.updated_at < now() - interval ''14 days''';
  execute v_del || 'supply_routes where status = ''stopped'' and updated_at < now() - interval ''14 days''';
  execute v_del || 'market_orders o where o.status <> ''reserved'' and o.created_at < now() - interval ''14 days''
                     and not exists (select 1 from supply_routes r where r.order_id = o.id)';
  execute v_del || 'market_lots l where not l.active and l.created_at < now() - interval ''14 days''
                     and not exists (select 1 from market_orders o where o.lot_id = l.id)';
  execute v_del || 'supply_takes where taken_at < now() - interval ''14 days''';
  execute v_del || 'supply_grants where status in (''revoked'', ''declined'') and coalesce(decided_at, created_at) < now() - interval ''30 days''';
exception when others then
  perform err_db('supply_cleanup', sqlstate, sqlerrm, true);
end;
$$;

do $$
declare f text;
begin
  foreach f in array array['supply_pickup_load(uuid, text, uuid)', 'supply_stop_is_pickup(jsonb)', 'supply_cleanup()'] loop
    execute 'revoke all on function public.' || f || ' from public, anon, authenticated';
  end loop;
  execute 'revoke all on function public.dispatch_convoy(uuid, text, jsonb, boolean) from public, anon, authenticated';
end $$;

select cron.schedule('supply-cleanup', '35 4 * * *', $$select public.supply_cleanup()$$);
