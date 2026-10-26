-- Удаление старого кода, шаг 4б, этап A (26.10.2026): живые функции перестают читать таблицы и колонки
-- старого абордажа, дозора, луча захвата, контроля разума, эффектов и способностей пошагового боя.
-- Ничего не удаляет: после него sql/legacy_step4b_drop.sql (SQL Editor) убирает сами таблицы и колонки.
--  - заглушки с той же подписью: ship_active_boarding → всегда «нет абордажа», effect_value → 0,
--    assert_unit_can_act → ничего не проверяет (таблицы пусты — поведение не меняется);
--  - rt_battle_guard и ещё 18 функций — без чтения overwatch, tractor_*, boarding_eff, control_until,
--    orig_faction, unit_effects, *_ability_uses (опись: claude/deadcode-plan.md);
--  - spawn_character_on_faction_assignment — без записи в player_characters (5 слотов командиров остаются).
-- Каждая правка проверяет, что найдено ровно ожидаемое число мест; иначе — ошибка и откат всего.
-- Применено миграцией legacy_step4b_patch. Повторно запускать нельзя (второй раз места не найдутся).
do $do$
declare r record; v_def text; v_n integer;
begin
  execute $f$create or replace function public.ship_active_boarding(p_ship uuid) returns uuid
    language sql stable security definer set search_path = public, pg_temp
    as $b$ select null::uuid $b$$f$;
  execute $f$create or replace function public.effect_value(p_unit_id uuid, p_effect text) returns integer
    language sql stable security definer set search_path = public, extensions, pg_temp
    as $b$ select 0 $b$$f$;
  execute $f$create or replace function public.assert_unit_can_act(p_unit_id uuid) returns void
    language plpgsql stable
    as $b$ begin return; end; $b$$f$;

  for r in select * from (values
    (1, 'public.rt_battle_guard()', $p$       and new.tractor_until is not distinct from old.tractor_until and new.tractor_by is not distinct from old.tractor_by
       and new.boarding_eff is not distinct from old.boarding_eff and new.overwatch is not distinct from old.overwatch
$p$,
     $p$$p$, 1),
    (2, 'public.rt_battle_guard()', $p$and new.ap is not distinct from old.ap and new.overwatch is not distinct from old.overwatch and new.layer is not distinct from old.layer then$p$,
     $p$and new.ap is not distinct from old.ap and new.layer is not distinct from old.layer then$p$, 1),
    (3, 'public.spend_ship_action(uuid)', $p$ap_updated_at = v_anchor,
         overwatch = overwatch and coalesce(current_setting('app.overwatch_fire', true), '') = '1'
  where id = p_ship_id;$p$,
     $p$ap_updated_at = v_anchor
  where id = p_ship_id;$p$, 1),
    (4, 'public.spend_unit_action(uuid)', $p$ap_updated_at = v_anchor,
         overwatch = overwatch and coalesce(current_setting('app.overwatch_fire', true), '') = '1'
  where id = p_unit_id;$p$,
     $p$ap_updated_at = v_anchor
  where id = p_unit_id;$p$, 1),
    (5, 'public.supply_fleet_to_zone(uuid)', $p$      update ships set overwatch = false where id = s.id and overwatch;
$p$,
     $p$$p$, 1),
    (6, 'public.supply_fleet_to_zone(uuid)', $p$  -- корабли, которые не могут двигаться, — сразу причина
  select coalesce(sh.name, t.name) || case when ship_active_boarding(sh.id) is not null then '» сцеплен абордажем'
                                           else '» удерживается притягивающим лучом' end
    into v_hname
  from ships sh join ship_types t on t.id = sh.ship_type
  where sh.commander_id = cm.id and sh.system_id = v_here and not sh.in_transit and sh.carrier_ship_id is null
    and (ship_active_boarding(sh.id) is not null or (sh.tractor_until is not null and sh.tractor_until > now()))
  limit 1;
  if v_hname is not null then
    return 'blocked:Флот не может выйти к гиперлинии: «' || v_hname;
  end if;

$p$,
     $p$$p$, 1),
    (7, 'public.automove_step(uuid)', $p$    -- Ждём, не отменяя: обучение, оглушение, подавление
    if e.training_until is not null and e.training_until > now() then return 'wait'; end if;
    if exists (select 1 from unit_effects f where f.unit_id = e.id and f.until > now()
               and f.effect in ('stun', 'suppressed')) then
      return 'wait';
    end if;
$p$,
     $p$    -- Ждём, не отменяя: обучение
    if e.training_until is not null and e.training_until > now() then return 'wait'; end if;
$p$, 1),
    (8, 'public.automove_step(uuid)', $p$    -- Луч захвата: ждём
    if e.tractor_until is not null and e.tractor_until > now() then return 'wait'; end if;

$p$,
     $p$$p$, 1),
    (9, 'public.move_ship(uuid,integer,integer,integer)', $p$  if s.tractor_until is not null and now() < s.tractor_until then
    raise exception 'Корабль удерживается притягивающим лучом: осталось % с',
      ceil(extract(epoch from s.tractor_until - now()))::integer;
  end if;

  if ship_active_boarding(p_ship_id) is not null then
    raise exception 'Корабль сцеплен абордажем — с места не сдвинется';
  end if;

$p$,
     $p$$p$, 1),
    (10, 'public.start_commander_move(uuid,text)', $p$  select coalesce(s.name, t.name) into v_held
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

$p$,
     $p$$p$, 1),
    (11, 'public.transfer_block_ship(uuid)', $p$  if ship_active_boarding(p_ship_id) is not null then return 'сцеплен абордажем'; end if;
  if s.tractor_until is not null and s.tractor_until > now() then return 'пойман лучом'; end if;
$p$,
     $p$$p$, 1),
    (12, 'public.transfer_block_ship(uuid)', $p$where ct.is_hero or c.hero_id is not null or c.control_until is not null) then$p$,
     $p$where ct.is_hero or c.hero_id is not null) then$p$, 1),
    (13, 'public.transfer_block_unit(uuid)', $p$  if u.control_until is not null then return 'подчинён силой, не твой по праву'; end if;
$p$,
     $p$$p$, 1),
    (14, 'public.transfer_block_unit(uuid)', $p$where ct.is_hero or c.hero_id is not null or c.control_until is not null) then$p$,
     $p$where ct.is_hero or c.hero_id is not null) then$p$, 1),
    (15, 'public.transfer_block_unit(uuid)', $p$'внутри одарённый или подчинённый — высади его'$p$,
     $p$'внутри одарённый — высади его'$p$, 1),
    (16, 'public.rt_space_sync(text,uuid,jsonb,jsonb,jsonb,jsonb)', $p$game_setting_int('trophy_jump_lock_hours', 12))),
                     overwatch = false, tractor_until = null, tractor_by = null, boarding_eff = null
     where id = r.id;$p$,
     $p$game_setting_int('trophy_jump_lock_hours', 12)))
     where id = r.id;$p$, 1),
    (17, 'public.rt_space_sync(text,uuid,jsonb,jsonb,jsonb,jsonb)', $p$    update ships set tractor_until = null, tractor_by = null where tractor_by = r.id;
$p$,
     $p$$p$, 1),
    (18, 'public.rt_space_ships(text)', $p$'trophy', coalesce(s.trophy, false), 'boarding_eff', s.boarding_eff,$p$,
     $p$'trophy', coalesce(s.trophy, false),$p$, 1),
    (19, 'public.land_fighter(uuid,integer,integer)', $p$  if coalesce((c.boarding_eff ->> 'hangar')::boolean, false) then
    raise exception 'Ангар носителя у абордажной группы — машины не вылетают';
  end if;

$p$,
     $p$$p$, 1),
    (20, 'public.rt_ground_units(text)', $p$    'ctrl', case when u.control_until is not null and u.control_until > now() then u.orig_faction end,
$p$,
     $p$$p$, 1),
    (21, 'public.get_faction_overview()', $p$coalesce(u.orig_faction, u.faction) = v_fac$p$,
     $p$u.faction = v_fac$p$, 2),
    (22, 'public.forbid_owner_change()', $p$    -- Подчинение разума: только там, где есть метка control_until
    if (to_jsonb(new) ? 'control_until')
       and (to_jsonb(new) ->> 'control_until')
           is distinct from (to_jsonb(old) ->> 'control_until') then
      return new;
    end if;

$p$,
     $p$$p$, 1),
    (23, 'public.npc_return_fire(uuid,uuid)', $p$      and not exists (select 1 from unit_effects e
                      where e.unit_id = u.id and e.until > now() and e.effect in ('stun', 'suppressed'))
$p$,
     $p$$p$, 1),
    (24, 'public.unit_in_trench(uuid)', $p$
  and not exists (
    select 1 from unit_effects e
    where e.unit_id = p_unit_id and e.until > now() and e.effect in ('stun', 'suppressed'));$p$,
     $p$;$p$, 1),
    (28, 'public.cleanup_old_records()', $p$v_uses integer; v_huses integer; v_eff integer; $p$,
     $p$$p$, 1),
    (26, 'public.cleanup_old_records()', $p$  -- Отметки применения способностей: самая долгая перезарядка — 30 минут
  $p$ || 'del' || 'ete' || $p$ from unit_ability_uses where used_at < now() - interval '1 day';
  get diagnostics v_uses = row_count;
  $p$ || 'del' || 'ete' || $p$ from hero_ability_uses where used_at < now() - interval '1 day';
  get diagnostics v_huses = row_count;

  -- Истёкшие эффекты на юнитах
  $p$ || 'del' || 'ete' || $p$ from unit_effects where until < now() - interval '1 day';
  get diagnostics v_eff = row_count;

$p$,
     $p$$p$, 1),
    (27, 'public.cleanup_old_records()', $p$    'unit_ability_uses', v_uses, 'hero_ability_uses', v_huses,
    'unit_effects', v_eff, 'troop_transfers', v_tr,$p$,
     $p$    'troop_transfers', v_tr,$p$, 1)
  ) v(ord, sig, a, b, n) order by ord loop
    v_def := pg_get_functiondef(r.sig::regprocedure);
    v_n := (length(v_def) - length(replace(v_def, r.a, ''))) / length(r.a);
    if v_n <> r.n then raise exception 'правка % (%): мест %, ожидалось %', r.ord, r.sig, v_n, r.n; end if;
    execute replace(v_def, r.a, r.b);
  end loop;

  -- триггер выдачи фракции: без player_characters
  v_def := pg_get_functiondef('public.spawn_character_on_faction_assignment()'::regprocedure);
  if (select count(*) from regexp_matches(v_def, 'insert into player_characters', 'g')) <> 1 then
    raise exception 'spawn_character_on_faction_assignment: вставка не одна';
  end if;
  v_def := regexp_replace(v_def, '\n[ ]*insert into player_characters[^;]*;', '');
  if position('player_characters' in v_def) > 0 then raise exception 'spawn_character_on_faction_assignment: не вырезано'; end if;
  execute v_def;
end $do$;
