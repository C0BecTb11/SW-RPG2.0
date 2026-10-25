-- Аудит проекта 25.10.2026 — правки базы (применены миграциями audit_*; файл идемпотентен).
-- Служебные функции боёв 2.0 — sql/rt_internal_revoke.sql.

-- Пределы с бонусами исследований (лечение, ангар, цель атаки) и закрытый при абордаже трюм для ресурсов и посадки.
do $$
declare
  r record; v_def text; n integer;
begin
  for r in select * from (values
    -- лечение: предел здоровья бойца — тип + бонус исследований (как unit_stats)
    ('public.get_ability_targets(uuid,text)', 'select t.id, tt.name, tt.image, t.hp, tt.max_hp, t.x, t.y', 'select t.id, tt.name, tt.image, t.hp, tt.max_hp + coalesce(t.bonus_hp, 0), t.x, t.y'),
    ('public.get_ability_targets(uuid,text)', '(not tt.is_vehicle and t.hp < tt.max_hp)', '(not tt.is_vehicle and t.hp < tt.max_hp + coalesce(t.bonus_hp, 0))'),
    ('public.use_ability(uuid,text,uuid)', 'if t.hp >= tt.max_hp then raise exception', 'if t.hp >= tt.max_hp + coalesce(t.bonus_hp, 0) then raise exception'),
    ('public.use_ability(uuid,text,uuid)', 'v_healed := least(ab.power, tt.max_hp - t.hp);', 'v_healed := least(ab.power, tt.max_hp + coalesce(t.bonus_hp, 0) - t.hp);'),
    -- ангар носителя — с бонусом исследований (как ship_stats / recall_fighter)
    ('public.lift_fighter(uuid,uuid)', $a$if hangar_used(p_carrier_id) >= ct.hangar_slots then
    raise exception 'Ангар полон: мест %', ct.hangar_slots;$a$, $a$if hangar_used(p_carrier_id) >= ct.hangar_slots + coalesce(c.bonus_hangar, 0) then
    raise exception 'Ангар полон: мест %', ct.hangar_slots + coalesce(c.bonus_hangar, 0);$a$),
    ('public.get_lift_carriers(uuid)', 'select c.id, coalesce(c.name, ct.name), ct.hangar_slots - hangar_used(c.id),', 'select c.id, coalesce(c.name, ct.name), ct.hangar_slots + coalesce(c.bonus_hangar, 0) - hangar_used(c.id),'),
    ('public.get_lift_carriers(uuid)', 'and ct.hangar_slots > 0
    and ct.hangar_slots - hangar_used(c.id) > 0', 'and ct.hangar_slots + coalesce(c.bonus_hangar, 0) > 0
    and ct.hangar_slots + coalesce(c.bonus_hangar, 0) - hangar_used(c.id) > 0'),
    -- цель атаки: предел корпуса с бонусом
    ('public.get_attack_targets(uuid)', 'ship_gap(p_ship_id, t.id), t.hp, tt.max_hp,', 'ship_gap(p_ship_id, t.id), t.hp, tt.max_hp + coalesce(t.bonus_hp, 0),'),
    -- трюм, сцепленный абордажем, закрыт и для ресурсов (для бойцов это делает boarding_hold_guard)
    ('public.load_resource_to_ship(uuid,text,integer)', $a$  if s.in_transit then raise exception 'Корабль в гиперпространстве'; end if;$a$, $a$  if s.in_transit then raise exception 'Корабль в гиперпространстве'; end if;
  if ship_active_boarding(p_ship_id) is not null then raise exception 'Трюм закрыт: корабль сцеплен абордажем'; end if;$a$),
    ('public.unload_resource_from_ship(uuid,text,integer)', $a$  if s.in_transit then raise exception 'Корабль в гиперпространстве'; end if;$a$, $a$  if s.in_transit then raise exception 'Корабль в гиперпространстве'; end if;
  if ship_active_boarding(p_ship_id) is not null then raise exception 'Трюм закрыт: корабль сцеплен абордажем'; end if;$a$),
    ('public.load_market_order(uuid,uuid,integer)', $a$  if s.in_transit then raise exception 'Корабль в гиперпространстве'; end if;$a$, $a$  if s.in_transit then raise exception 'Корабль в гиперпространстве'; end if;
  if ship_active_boarding(p_ship_id) is not null then raise exception 'Трюм закрыт: корабль сцеплен абордажем'; end if;$a$),
    -- посадка из ангара, который держит абордажная группа, — как и взлёт (launch_fighter)
    ('public.land_fighter(uuid,integer,integer)', $a$  if c.in_transit then raise exception 'Носитель в гиперпространстве'; end if;$a$, $a$  if c.in_transit then raise exception 'Носитель в гиперпространстве'; end if;
  if coalesce((c.boarding_eff ->> 'hangar')::boolean, false) then
    raise exception 'Ангар носителя у абордажной группы — машины не вылетают';
  end if;$a$)
  ) as t(fn, a, b)
  loop
    v_def := pg_get_functiondef(r.fn::regprocedure);
    if position(r.b in v_def) > 0 then continue; end if;                 -- уже применено
    n := (length(v_def) - length(replace(v_def, r.a, ''))) / greatest(1, length(r.a));
    if n <> 1 then raise exception '%: якорь встречается % раз: %', r.fn, n, left(r.a, 60); end if;
    execute replace(v_def, r.a, r.b);
  end loop;
end $$;

-- Участки: порядок блокировок как у mine_tick и mine_finish — сначала идущая смена, потом участок (иначе взаимная блокировка)
do $$
declare r record; v_def text; n integer;
begin
  for r in select * from (values
    ('public.mine_own(uuid)', $a$  perform mine_site_ensure(p_building);
  select * into s from mine_sites where building_id = p_building for update;$a$, $a$  perform mine_site_ensure(p_building);
  -- порядок блокировок как у mine_tick и mine_finish: сначала идущая смена, потом участок (иначе взаимная блокировка)
  perform 1 from mine_shifts where building_id = p_building and status = 'run' for update;
  select * into s from mine_sites where building_id = p_building for update;$a$),
    ('public.spy_resolve(uuid)', $a$  select * into s from mine_sites where building_id = o.target_building for update;$a$, $a$  -- порядок блокировок как у mine_tick и mine_finish: сначала идущая смена, потом участок
  perform 1 from mine_shifts where building_id = o.target_building and status = 'run' for update;
  select * into s from mine_sites where building_id = o.target_building for update;$a$),
    -- туман войны: очередь казармы и верфи — только своей стороне
    ('public.get_building_queue(uuid)', $a$  ) q
  order by q.completes_at$a$, $a$  ) q
  -- очередь видна только своей стороне: чужую казарму в обход тумана войны не разглядеть
  where exists (select 1 from buildings bd join profiles pr on pr.id = auth.uid()
                where bd.id = p_building_id and bd.faction = pr.faction)
  order by q.completes_at$a$),
    ('public.get_shipyard_state(text)', $a$  where auth.uid() is not null;$a$, $a$  where auth.uid() is not null
    -- верфь видна только своей стороне (что строится и чинится у врага — разведданные)
    and exists (select 1 from systems sy join profiles pr on pr.id = auth.uid()
                where sy.id = p_system_id and sy.faction = pr.faction);$a$),
    -- выход к гиперлинии: снятие дозора — внутри блока, который переживает «в бою 2.0»
    ('public.supply_fleet_to_zone(uuid)', $a$    update ships set overwatch = false where id = s.id and overwatch;
    v_id := null;
    begin
$a$, $a$    v_id := null;
    begin
      update ships set overwatch = false where id = s.id and overwatch;
$a$)
  ) as t(fn, a, b)
  loop
    v_def := pg_get_functiondef(r.fn::regprocedure);
    if position(r.b in v_def) > 0 then continue; end if;
    n := (length(v_def) - length(replace(v_def, r.a, ''))) / greatest(1, length(r.a));
    if n <> 1 then raise exception '%: якорь встречается % раз', r.fn, n; end if;
    execute replace(v_def, r.a, r.b);
  end loop;
end $$;

-- start_commander_move зовут только SECURITY DEFINER-функции (маршрут, снабжение, перехват); прямой вызов игроком
-- обходил проверку «командир занят снабжением» из start_commander_route
revoke all on function public.start_commander_move(uuid, text) from public, anon, authenticated;

-- err_scan: «сервер упал» — только если за минуту до запуска не было штатной остановки
-- (после «остановка: SIGTERM» сервер ещё пишет «орбита закрыта», «игрок вышел» — это не падение)
do $$
declare v_def text; a text := $x$      if v_prev is not null and v_prev not like 'остановка%' then$x$;
  b text := $x$      if v_prev is not null and v_prev not like 'остановка%'
         and not exists (select 1 from rt_server_log q where q.msg like 'остановка%' and q.at < r.at and q.at > r.at - interval '60 seconds') then$x$;
begin
  v_def := pg_get_functiondef('public.err_scan()'::regprocedure);
  if position(b in v_def) = 0 then
    if (length(v_def) - length(replace(v_def, a, ''))) / length(a) <> 1 then raise exception 'err_scan: нет якоря'; end if;
    execute replace(v_def, a, b);
  end if;
end $$;

-- дозор: сбой выстрела — в журнал ошибок (как все when others в проекте), а не только warning в лог Postgres
do $$
declare f text; v_def text; a text; b text;
begin
  foreach f in array array['overwatch_fire_ship', 'overwatch_fire_unit'] loop
    v_def := pg_get_functiondef(('public.' || f || '(uuid)')::regprocedure);
    a := format($x$      raise warning '%s %%: %%', p_id, sqlerrm;
      return false;$x$, f);
    b := format($x$      raise warning '%s %%: %%', p_id, sqlerrm;
      perform err_db('%s', sqlstate, sqlerrm, false);
      return false;$x$, f, f);
    if position(b in v_def) = 0 then
      if (length(v_def) - length(replace(v_def, a, ''))) / length(a) <> 1 then raise exception '%: нет якоря', f; end if;
      execute replace(v_def, a, b);
    end if;
  end loop;
end $$;
