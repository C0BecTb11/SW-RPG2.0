-- Удаление старого кода, шаг 5.5–5.6, этап A (26.10.2026): мёртвые ветки и встраивание заглушек в живые функции.
-- Ничего не удаляет; после него sql/deadcode_5_db_drop.sql (SQL Editor) убирает сами заглушки, старую duel_upsert,
-- get_my_processes, 5 настроек и колонку unit_positions.orig_owner_user_id.
--  - log_event, duel_log, duel_upsert: без app.overwatch_fire (её никто не ставит); duel_upsert — новая подпись без p_ow;
--  - log_event_digest: без overwatch_report/overwatch_space; rt_battle_guard_ref: без ветки таблицы boardings;
--  - assert_unit_can_act (ничего не проверяла), ship_active_boarding (всегда null), effect_value (всегда 0) —
--    вызовы убраны, урон и меткость считаются как раньше бит-в-бит.
-- Каждая правка проверяет точное число мест; иначе — ошибка и откат всего. Применено миграцией deadcode_5_db_patch.
do $do$
declare r record; v_def text; v_n integer;
begin
  -- новая duel_upsert без p_ow (старую с p_ow удаляет этап B)
  v_def := pg_get_functiondef('public.duel_upsert(uuid,text,jsonb,jsonb,text,boolean,integer,boolean,boolean)'::regprocedure);
  for r in select * from (values
    ($p$p_killed boolean, p_ow boolean)$p$, $p$p_killed boolean)$p$),
    ($p$'dmg', 0, 'ow', 0),$p$, $p$'dmg', 0),$p$),
    ($p$  if p_dir = 'out' and p_ow then
    v_side := v_side || jsonb_build_object('ow', coalesce((v_side ->> 'ow')::integer, 0) + 1);
  end if;
$p$, '')
  ) v(a, b) loop
    if (length(v_def) - length(replace(v_def, r.a, ''))) / length(r.a) <> 1 then raise exception 'duel_upsert: место не одно: %', r.a; end if;
    v_def := replace(v_def, r.a, r.b);
  end loop;
  execute v_def;
  execute 'revoke all on function public.duel_upsert(uuid,text,jsonb,jsonb,text,boolean,integer,boolean) from public, anon, authenticated';
  execute 'grant execute on function public.duel_upsert(uuid,text,jsonb,jsonb,text,boolean,integer,boolean) to service_role';

  for r in select * from (values
    (1, 'public.log_event(uuid,text,text,text,text,integer,text,jsonb)', $p$    and not (coalesce(current_setting('app.overwatch_fire', true), '') = '1'
             and p_type in ('unit_hit', 'unit_missed', 'ship_hit', 'ship_missed'))
$p$,
     $p$$p$, 1),
    (2, 'public.log_event_digest', $p$p_type in ('turret_report', 'overwatch_report', 'overwatch_space') then$p$,
     $p$p_type = 'turret_report' then$p$, 1),
    (3, 'public.rt_battle_guard_ref()', $p$  elsif tg_table_name = 'boardings' then
    busy := ((j->>'attacker_ship_id') is not null and rt_obj_busy_2_0('ship', (j->>'attacker_ship_id')::uuid) is not null)
         or ((j->>'target_ship_id')   is not null and rt_obj_busy_2_0('ship', (j->>'target_ship_id')::uuid)   is not null);
$p$,
     $p$$p$, 1),
    (4, 'public.build_structure(uuid,text,integer,integer)', $p$  perform assert_unit_can_act(p_unit_id);

$p$,
     $p$$p$, 1),
    (5, 'public.move_ground_unit(uuid,integer,integer)', $p$  perform assert_unit_can_act(p_unit_id);

$p$,
     $p$$p$, 1),
    (6, 'public.npc_ready(uuid)', $p$  begin
    perform assert_unit_can_act(p_unit);
  exception when others then perform err_db('npc_ready', sqlstate, sqlerrm, false);
    return false;
  end;
$p$,
     $p$$p$, 1),
    (7, 'public.load_market_order(uuid,uuid,integer)', $p$  if ship_active_boarding(p_ship_id) is not null then raise exception 'Трюм закрыт: корабль сцеплен абордажем'; end if;
$p$,
     $p$$p$, 1),
    (8, 'public.load_resource_to_ship(uuid,text,integer)', $p$  if ship_active_boarding(p_ship_id) is not null then raise exception 'Трюм закрыт: корабль сцеплен абордажем'; end if;
$p$,
     $p$$p$, 1),
    (9, 'public.unload_resource_from_ship(uuid,text,integer)', $p$  if ship_active_boarding(p_ship_id) is not null then raise exception 'Трюм закрыт: корабль сцеплен абордажем'; end if;
$p$,
     $p$$p$, 1),
    (10, 'public.scrap_trophy(uuid)', $p$  if ship_active_boarding(s.id) is not null then raise exception 'Корабль сцеплен абордажем'; end if;
$p$,
     $p$$p$, 1),
    (11, 'public.hero_strike(uuid,uuid,integer)', $p$  v_dmg := greatest(1, round(p_damage *
             (100 - least(90, effect_value(p_target, 'shielded'))) / 100.0)::integer);$p$,
     $p$  v_dmg := greatest(1, p_damage);$p$, 1),
    (12, 'public.npc_shot(uuid,uuid)', $p$  cross join lateral (select greatest(1, round(d1.v * (100 - least(90, effect_value(p_target, 'shielded')))
                             / 100.0)::integer) as v) d2$p$,
     $p$  cross join lateral (select greatest(1, d1.v) as v) d2$p$, 1),
    (13, 'public.npc_shot(uuid,uuid)', $p$  -- Из бункера стрелок бьёт сильнее, щит и укрытие цели гасят часть урона$p$,
     $p$  -- Из бункера стрелок бьёт сильнее, укрытие цели гасит часть урона$p$, 1),
    (14, 'public.structures_tick()', $p$    v_dmg := greatest(1, round(v_dmg * (100 - least(90, effect_value(tg.id, 'shielded'))) / 100.0)::integer);$p$,
     $p$    v_dmg := greatest(1, v_dmg);$p$, 1),
    (15, 'public.trench_return_fire(uuid,uuid)', $p$  v_dmg := greatest(1, round(v_dmg * (100 - least(90, effect_value(p_attacker, 'shielded'))) / 100.0)::integer);$p$,
     $p$  v_dmg := greatest(1, v_dmg);$p$, 1),
    (16, 'public.unit_stats(uuid)', $p$t.accuracy + u.bonus_accuracy - effect_value(u.id, 'fear')$p$,
     $p$t.accuracy + u.bonus_accuracy$p$, 1),
    (17, 'public.unit_stats(uuid)', $p$t.evasion + u.bonus_evasion - effect_value(u.id, 'fear')$p$,
     $p$t.evasion + u.bonus_evasion$p$, 1),
    (25, 'public.duel_log(text,uuid,uuid,boolean,integer,boolean)', $p$declare s jsonb; t jsonb; v_ow boolean;$p$,
     $p$declare s jsonb; t jsonb;$p$, 1),
    (19, 'public.duel_log(text,uuid,uuid,boolean,integer,boolean)', $p$  v_ow := coalesce(current_setting('app.overwatch_fire', true), '') = '1';
$p$,
     $p$$p$, 1),
    (20, 'public.duel_log(text,uuid,uuid,boolean,integer,boolean)', $p$, p_killed, v_ow);$p$,
     $p$, p_killed);$p$, 1),
    (21, 'public.duel_log(text,uuid,uuid,boolean,integer,boolean)', $p$, p_killed, false);$p$,
     $p$, p_killed);$p$, 1)
  ) v(ord, sig, a, b, n) order by ord loop
    v_def := pg_get_functiondef(case when r.sig like '%(%' then r.sig::regprocedure::oid else r.sig::regproc::oid end);
    v_n := (length(v_def) - length(replace(v_def, r.a, ''))) / length(r.a);
    if v_n <> r.n then raise exception 'правка % (%): мест %, ожидалось %', r.ord, r.sig, v_n, r.n; end if;
    execute replace(v_def, r.a, r.b);
  end loop;
end $do$;
