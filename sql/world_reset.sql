-- ============================================================================
-- СБРОС МИРА К НАЧАЛУ ИГРЫ (SW-RPG 2.0). Необратимо. Вставить целиком в SQL Editor.
--
-- Что делает:
--   1. Закрывает бои 2.0 и снимает блокировки.
--   2. Стирает всё, что нажито: войска, героев, корабли, постройки, укрепления, станции,
--      склады, очереди верфи и исследований, караваны, рынок, автоходы, абордажи, журнал.
--   3. Планеты — по сиду (sql/systems_seed.sql): фракции систем как в начале, поселения уровня 1,
--      без владельцев.
--   4. Игроки остаются (аккаунт, ник, фракция, лидеры фракций): кредиты 1000, персонаж и первый
--      командир в столице, остальные командиры заблокированы, обучение заново.
--   5. Игроков рассаживает по планетам своей фракции: лидеру — столица, остальным по планете
--      в порядке регистрации. Корабль и бойцов в столице выдаёт обучение (шаги «Штаб армии»
--      и «Командование флотом»), как новичку.
--   6. Выход всех из аккаунтов (сессии Supabase): после сброса все входят заново.
-- Справочники (типы, исследования, карты, маршруты) не трогаются.
-- ============================================================================
begin;
set local app.rt_battle = '1';            -- триггеры блокировок пропускают
set local app.owner_transfer = '1';
set local app.capture_transfer = '1';

-- 1. бои 2.0
delete from rt_battle_locks;
update rt_battles set status = 'finished', ended_at = now() where status = 'active';

-- 2. нажитое
delete from boarding_units;
delete from boardings;
delete from unit_effects;
delete from unit_ability_uses;
delete from unit_orders;
delete from auto_move_stops;
delete from auto_move_reports;
delete from auto_moves;
delete from hero_ability_uses;
delete from hero_kills;
delete from hero_learned;
delete from hero_training;
delete from troop_transfer_items;
delete from troop_transfers;
delete from repair_orders;
delete from interceptions;
delete from spotted_pairs;
delete from npc_brains;
delete from unit_positions;
delete from heroes;
update ships set in_transit = false, tractor_by = null, tractor_until = null;   -- иначе триггер трюма не даст стереть груз корабля в пути
delete from ship_cargo;
delete from ship_resource_cargo;
delete from ship_orders;
delete from convoys;
delete from supply_takes;
delete from supply_route_log;
delete from supply_routes;
delete from supply_rules;
delete from supply_grants;
delete from ships;
delete from field_structures;
delete from research_orders;
delete from production_leases;
delete from buildings;
delete from space_stations;
delete from player_research;
delete from commander_inventory;
delete from market_lots;
delete from market_orders;
delete from planet_requests;
delete from faction_targets;
delete from faction_directives;
delete from settlement_districts;
delete from settlement_tasks;
delete from system_capture;
delete from planet_maps;
delete from game_events;
update planet_stock set amount = 0;
update settlement_state
   set level = 1, satisfaction = 0, dev_points = 0, upgrade_until = null, upgrade_to = null, fed = null, food_short = 0,
       total_paid = 0, last_income = null, last_done = null, last_total = null, cycle_started = now(), last_paid_at = null,
       militia_ready_at = null, militia_raised_at = null;

-- 3. системы — по сиду
update systems s set faction = v.f
  from (values
    ('coruscant','republic'), ('kuat','republic'), ('corellia','republic'), ('alderaan','republic'), ('anaxes','republic'),
    ('naboo','republic'), ('kashyyyk','republic'), ('kamino','republic'), ('christophsis','republic'), ('ryloth','republic'),
    ('utapau','cis'), ('raxus','cis'), ('geonosis','cis'), ('muunilinst','cis'), ('catoneimoidia','cis'),
    ('feorust','cis'), ('hypori','cis'), ('maygito','cis'), ('mustafar','cis'), ('umbara','cis')
  ) v(id, f)
 where s.id = v.id;
delete from system_control;

-- 4. игроки
update profiles set credits = 1000;
update commanders
   set unlocked = (slot_index = 1),
       current_system = case when slot_index = 1 then tutorial_capital(faction) else null end,
       moving_from = null, moving_to = null, departed_at = null, arrives_at = null, warned_at = null, route = null;
update player_characters pc set current_system = tutorial_capital(p.faction) from profiles p where p.id = pc.user_id and p.faction in ('republic', 'cis');

-- 5. планеты игрокам: лидеру — столица, остальным по одной в порядке регистрации
insert into system_control (system_id, controller_user_id)
select pl2.system_id, pl.user_id
  from (
    select p.id as user_id, p.faction,
           row_number() over (partition by p.faction order by (l.leader_user_id = p.id) desc nulls last, p.created_at) as n
      from profiles p
      left join faction_leadership l on l.faction = p.faction
     where p.faction in ('republic', 'cis')
  ) pl
  join (values
    ('republic', 1, 'coruscant'), ('republic', 2, 'kuat'), ('republic', 3, 'corellia'), ('republic', 4, 'anaxes'), ('republic', 5, 'alderaan'),
    ('republic', 6, 'naboo'), ('republic', 7, 'kashyyyk'), ('republic', 8, 'kamino'), ('republic', 9, 'christophsis'), ('republic', 10, 'ryloth'),
    ('cis', 1, 'raxus'), ('cis', 2, 'geonosis'), ('cis', 3, 'muunilinst'), ('cis', 4, 'utapau'), ('cis', 5, 'catoneimoidia'),
    ('cis', 6, 'feorust'), ('cis', 7, 'hypori'), ('cis', 8, 'maygito'), ('cis', 9, 'mustafar'), ('cis', 10, 'umbara')
  ) pl2(faction, n, system_id) on pl2.faction = pl.faction and pl2.n = pl.n;

-- 6. обучение заново всем с фракцией
insert into tutorial_state (user_id)
select id from profiles where faction in ('republic', 'cis')
on conflict (user_id) do update
  set status = 'active', step_ord = 1, step_since = now(), step_done = false, meta = '{}'::jsonb, started_at = now(), finished_at = null;

-- 7. выход всех из аккаунтов
delete from auth.refresh_tokens;
delete from auth.sessions;

commit;

-- Проверка после сброса:
-- select system_id, controller_user_id from system_control order by 1;
-- select count(*) ships, (select count(*) from unit_positions) units, (select count(*) from buildings) buildings from ships;
