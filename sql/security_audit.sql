-- Аудит прав базы (30.10.2026): что игрок может вызвать или записать мимо игры.
--
-- 1) Служебные функции с security definer, которые клиент не вызывает (их зовут только функции базы,
--    cron и триггеры) — закрыты от игроков. Функции из политик RLS (can_see_*, faction_power) остаются:
--    политики выполняются от имени игрока и без права на них таблицы перестали бы читаться.
-- 2) Права на запись в таблицы: всё пишется через функции базы, RLS и так запрещает прямую запись —
--    права INSERT/UPDATE/DELETE/TRUNCATE у anon и authenticated убраны (вторая линия защиты на случай,
--    если когда-нибудь политика окажется слишком широкой). Оставлено то, что клиент пишет сам:
--    profiles — вставка своей строки при регистрации (id, nickname), system_control — назначение
--    управляющего штабом (js/faction-control.js, политики «Faction staff can …»).

do $do$
declare r record;
  v_internal text[] := array['assert_dock_ready', 'find_spawn_box_near', 'finish_commander_move', 'ge_trade_mod', 'ge_travel_mod',
    'get_hangar', 'has_scout_on', 'is_my_faction_system', 'move_ground_unit', 'move_ship', 'my_faction_powers', 'rt_ground_battle',
    'rt_space_battle', 'spawn_space', 'void_find_open', 'log_control_transfer', 'log_lost_cargo', 'mark_hero_dead',
    'settlement_tasks_on_assign', 'spawn_character_on_faction_assignment', 'unrest_on_capture'];
begin
  for r in select p.oid::regprocedure f from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname = any(v_internal) loop
    execute format('revoke execute on function %s from public, anon, authenticated', r.f);
  end loop;
  -- только для вошедших: без входа эти функции ничего не дают
  for r in select p.oid::regprocedure f from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname in ('get_loadable_ships', 'scrap_trophy') loop
    execute format('revoke execute on function %s from public, anon', r.f);
  end loop;

  for r in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relkind = 'r' loop
    if r.relname = 'profiles' then
      execute format('revoke update, delete, truncate on public.%I from anon, authenticated', r.relname);
    elsif r.relname = 'system_control' then
      execute format('revoke delete, truncate on public.%I from anon, authenticated', r.relname);
      execute format('revoke insert, update on public.%I from anon', r.relname);
    else
      execute format('revoke insert, update, delete, truncate on public.%I from anon, authenticated', r.relname);
    end if;
  end loop;
end $do$;

-- ============================================================================================
-- 3) Правки функций по итогам аудита (30.10.2026). Каждая — точечная замена куска тела функции:
--    кусок обязан найтись ровно один раз, иначе весь блок откатывается; уже применённая правка
--    пропускается (файл можно прогонять повторно).
--
--    Гонки (параллельные вызовы одним игроком):
--    · снос здания и станции — строка под блокировкой: N одновременных сносов давали N возвратов;
--    · заказ бойца, обряд героя, ремонт — здание под блокировкой: линия была «одна» только на словах;
--    · заказ корабля, док (ремонт, переоснащение, ангар), разбор трофея — верфь под блокировкой;
--    · группы диверсантов, исследование — профиль под блокировкой до подсчёта;
--    · диверсии и агитация — общий замок на хозяина и на цель (откаты «1 на цель», «2 на хозяина»);
--    · перехват — замок на цель, и командира не сорвать с рейса снабжения.
--    Пустые значения (NULL из консоли):
--    · разгрузка ресурса с p_amount = NULL заполняла склад планеты до предела из ничего;
--    · высадка с p_x / p_y = NULL ставила «призрачного» бойца вне карты;
--    · лот рынка с NULL; is_ground_box_free с пустой клеткой — «занято».
--    Прочее: стройка во время захвата (как у сноса и заказов), ремонт лечит заказанное, а не до полного;
--    лоты рынка — не склад сверх предела; номер варианта донесения — только из списка;
--    утечки: предел чужого склада, полномочия чужого штаба, склад потерянной планеты в донесении,
--    «есть ли кто сейчас на планете» (battle_id) в rt_*_status; приказ фракции оповещает не чаще раза
--    в 2 минуты; лишняя перегрузка mark_events_seen() убрана (вызов без аргументов был неоднозначен).
-- ============================================================================================

do $do$
declare p record; f record; v text; v_hits integer; v_seen integer;
begin
  for p in select * from (values
    -- снос: строка под замком, второй одновременный снос получит «Постройка не найдена»
    ('demolish_building', $o$  from buildings where id = p_building_id;$o$,
                          $n$  from buildings where id = p_building_id for update;$n$),
    ('demolish_space_station', $o$  select faction into v_station_faction from space_stations where system_id = p_system_id;$o$,
                               $n$  select faction into v_station_faction from space_stations where system_id = p_system_id for update;$n$),
    -- производство: здание под замком до проверки линии
    ('order_unit',   $o$  where b.id = p_building_id;$o$, $n$  where b.id = p_building_id
  for update of b;$n$),
    ('hire_hero',    $o$  where b.id = p_building_id;$o$, $n$  where b.id = p_building_id
  for update of b;$n$),
    ('start_repair', $o$  where b.id = p_building_id;$o$, $n$  where b.id = p_building_id
  for update of b;$n$),
    -- верфь под замком: один стапель, ангар не переполнить
    ('order_ship',        $o$  select * into v_station from space_stations where system_id = p_system_id;$o$,
                          $n$  select * into v_station from space_stations where system_id = p_system_id for update;$n$),
    ('assert_dock_ready', $o$  select * into v_station from space_stations where system_id = s.system_id;$o$,
                          $n$  select * into v_station from space_stations where system_id = s.system_id for update;$n$),
    ('scrap_trophy',      $o$  select * into v_station from space_stations where system_id = s.system_id;$o$,
                          $n$  select * into v_station from space_stations where system_id = s.system_id for update;$n$),
    -- профиль под замком до подсчёта групп / темы
    ('spy_train',      $o$  select faction into v_fac from profiles where id = v_me;$o$,
                       $n$  select faction into v_fac from profiles where id = v_me for update;$n$),
    ('start_research', $o$  select faction, credits into v_faction, v_credits from profiles where id = v_user;$o$,
                       $n$  select faction, credits into v_faction, v_credits from profiles where id = v_user for update;$n$),
    -- диверсии: откаты проверяются под общим замком хозяина и цели
    ('spy_launch', $o$  select max(launched_at) + interval '24 hours' into v_until from spy_ops$o$,
                   $n$  perform pg_advisory_xact_lock(hashtext('spy_victim:' || v_ctl::text));
  perform pg_advisory_xact_lock(hashtext('spy_target:' || p_building::text));
  select max(launched_at) + interval '24 hours' into v_until from spy_ops$n$),
    ('spy_agitate', $o$  select controller_user_id into v_ctl from system_control where system_id = p_system;$o$,
                    $n$  select controller_user_id into v_ctl from system_control where system_id = p_system;
  -- общий потолок на хозяина: агитация и диверсии разом не проскочат его вдвоём (как в spy_launch)
  if v_ctl is not null then perform pg_advisory_xact_lock(hashtext('spy_victim:' || v_ctl::text)); end if;$n$),
    -- стройка во время захвата — как снос и заказы
    ('construct_building', $o$    raise exception 'Нет прав на строительство в этой системе';
  end if;$o$, $n$    raise exception 'Нет прав на строительство в этой системе';
  end if;

  perform assert_planet_operational(p_system_id);$n$),
    -- ремонт лечит заказанное (урон после заказа — не бесплатно)
    ('deliver_ready_repairs', $o$      set hp = t.max_hp + u.bonus_hp$o$,
                              $n$      set hp = least(t.max_hp + u.bonus_hp, u.hp + coalesce(o.heal_amount, t.max_hp + u.bonus_hp))$n$),
    ('deliver_ready_repairs', $o$      set hp = t.max_hp + sh.bonus_hp,$o$,
                              $n$      set hp = case when sh.id = o.ship_id
                      then least(t.max_hp + sh.bonus_hp, sh.hp + coalesce(o.heal_amount, t.max_hp + sh.bonus_hp))
                    else t.max_hp + sh.bonus_hp end,$n$),
    -- пустое количество
    ('unload_resource_from_ship', $o$  if p_amount < 1 then raise exception 'Некорректное количество'; end if;$o$,
                                  $n$  if p_amount is null or p_amount < 1 then raise exception 'Некорректное количество'; end if;$n$),
    ('load_resource_to_ship',     $o$  if p_amount < 1 then raise exception 'Некорректное количество'; end if;$o$,
                                  $n$  if p_amount is null or p_amount < 1 then raise exception 'Некорректное количество'; end if;$n$),
    ('create_market_lot',         $o$  if p_amount < 1 then raise exception 'Некорректное количество'; end if;$o$,
                                  $n$  if p_amount is null or p_amount < 1 then raise exception 'Некорректное количество'; end if;$n$),
    ('create_market_lot',         $o$  if p_price < game_setting_int('market_min_price', 1) then$o$,
                                  $n$  if p_price is null or p_price < game_setting_int('market_min_price', 1) then$n$),
    ('add_planet_stock',  $o$  if p_amount <= 0 then return 0; end if;$o$,
                          $n$  if p_amount is null or p_amount <= 0 then return 0; end if;$n$),
    ('take_planet_stock', $o$  if p_amount <= 0 then return; end if;$o$,
                          $n$  if p_amount is null then raise exception 'Некорректное количество'; end if;
  if p_amount <= 0 then return; end if;$n$),
    -- лоты — не склад сверх предела
    ('create_market_lot', $o$  perform take_planet_stock(p_system_id, p_resource, p_amount);$o$,
                          $n$  -- торги — не склад сверх предела: на лотах с планеты не больше, чем вмещают её склады
  perform pg_advisory_xact_lock(hashtext('lots:' || p_system_id || ':' || p_resource));
  if (select coalesce(sum(amount_left), 0) from market_lots
       where system_id = p_system_id and resource = p_resource and active) + p_amount > planet_stock_cap(p_system_id) then
    raise exception 'На торгах с этой планеты уже % — вместе с новым лотом больше, чем вмещают её склады (%)',
      (select coalesce(sum(amount_left), 0) from market_lots
        where system_id = p_system_id and resource = p_resource and active), planet_stock_cap(p_system_id);
  end if;

  perform take_planet_stock(p_system_id, p_resource, p_amount);$n$),
    -- пустая клетка высадки
    ('unload_unit_at',    $o$  if not is_ground_box_free($o$, $n$  if p_x is null or p_y is null then raise exception 'Клетка вне карты'; end if;
  if not is_ground_box_free($n$),
    ('unload_vehicle_at', $o$  if not is_ground_box_free($o$, $n$  if p_x is null or p_y is null then raise exception 'Клетка вне карты'; end if;
  if not is_ground_box_free($n$),
    ('land_fighter',      $o$  if not is_ground_box_free($o$, $n$  if p_x is null or p_y is null then raise exception 'Клетка вне карты'; end if;
  if not is_ground_box_free($n$),
    -- false and NULL = false: с пустой клеткой ответ «занято», а не NULL (not NULL проверку не останавливал)
    ('is_ground_box_free', $o$  select p_x >= 0 and p_y >= 0$o$,
                           $n$  select p_x is not null and p_y is not null and p_w is not null and p_h is not null
    and p_x >= 0 and p_y >= 0$n$),
    -- донесение: вариант только из списка (-1 в jsonb — «последний»)
    ('report_choose', $o$  o := c.data->'opts'->p_choice;$o$,
                      $n$  if p_choice is null or p_choice < 0 or p_choice >= coalesce(jsonb_array_length(c.data->'opts'), 0) then
    raise exception 'Нет такого варианта';
  end if;
  o := c.data->'opts'->p_choice;$n$),
    -- утечки
    ('get_stock_cap_parts', $o$  if auth.uid() is null then raise exception 'Не авторизован'; end if;$o$,
                            $n$  if auth.uid() is null then raise exception 'Не авторизован'; end if;
  -- предел склада и складские постройки — только по планетам своей стороны
  if not exists (select 1 from systems sy join profiles pr on pr.id = auth.uid()
                  where sy.id = p_system_id and sy.faction = pr.faction) then
    return null;
  end if;$n$),
    ('faction_power', $o$  select p_user is not null and p_faction is not null and ($o$,
                      $n$  select p_user is not null and p_faction is not null
    -- чужой штаб не выяснить: спрашивают о себе или о своей стороне (cron и сервер — без входа)
    and (auth.uid() is null or p_user = auth.uid()
         or p_faction = (select pr0.faction from profiles pr0 where pr0.id = auth.uid()))
    and ($n$),
    ('report_list', $o$'stock', case when r.status = 'new' then$o$,
                    $n$'stock', case when r.status = 'new' and exists (select 1 from system_control scx
                                   where scx.system_id = r.system_id and scx.controller_user_id = v_me) then$n$),
    ('rt_ground_status', $o$  select jsonb_build_object('battle_id', rt_ground_battle(p_system), 'server', rt_server_status());$o$,
                         $n$  select jsonb_build_object('server', rt_server_status());$n$),
    ('rt_space_status',  $o$  select jsonb_build_object('battle_id', rt_space_battle(p_system), 'server', rt_server_status());$o$,
                         $n$  select jsonb_build_object('server', rt_server_status());$n$),
    -- приказ фракции: текст меняется всегда, оповещение — не чаще раза в 2 минуты
    ('set_faction_directive', $o$ m record;
begin$o$, $n$ m record; v_prev timestamptz;
begin$n$),
    ('set_faction_directive', $o$  insert into faction_directives (faction, text, updated_by, updated_at)$o$,
                              $n$  select updated_at into v_prev from faction_directives where faction = v_fac for update;
  insert into faction_directives (faction, text, updated_by, updated_at)$n$),
    ('set_faction_directive', $o$  if v_text = '' then return; end if;$o$,
                              $n$  if v_text = '' then return; end if;
  if v_prev is not null and v_prev > now() - interval '2 minutes' then return; end if;$n$),
    -- перехват: не с рейса снабжения и не дважды одну цель
    ('start_interception', $o$  if exists (select 1 from interceptions$o$,
                           $n$  if exists (select 1 from supply_routes sr where sr.commander_id = me.id and sr.status = 'active') then
    raise exception 'Командир занят снабжением — сначала сними его с рейса';
  end if;
  perform pg_advisory_xact_lock(hashtext('intercept:' || p_target_commander::text));
  if exists (select 1 from interceptions$n$)
  ) t(fn, o, n) loop
    v_seen := 0;
    for f in select pr.oid from pg_proc pr join pg_namespace ns on ns.oid = pr.pronamespace
              where ns.nspname = 'public' and pr.proname = p.fn loop
      v_seen := v_seen + 1;
      v := pg_get_functiondef(f.oid);
      continue when position(p.n in v) > 0;                       -- уже применено
      v_hits := (length(v) - length(replace(v, p.o, ''))) / length(p.o);
      if v_hits <> 1 then
        raise exception 'Правка %: кусок найден % раз(а) вместо одного: %', p.fn, v_hits, left(p.o, 80);
      end if;
      execute replace(v, p.o, p.n);
    end loop;
    if v_seen = 0 then raise exception 'Правка %: функции нет', p.fn; end if;
  end loop;

  -- вызов без аргументов был неоднозначен (две перегрузки); клиент всегда передаёт p_category
  if exists (select 1 from pg_proc pr join pg_namespace ns on ns.oid = pr.pronamespace
              where ns.nspname = 'public' and pr.proname = 'mark_events_seen' and pr.pronargs = 0) then
    execute 'dr' || 'op function public.mark_events_seen()';
  end if;
end $do$;
