-- Охотники бара (28.10.2026): наёмники — охотники на одарённых, у КНС (cis_bar) и у Республики (rep_bar).
--   cis_bounty  Охотник за головами       — мандалорец в духе Бобы Фетта (плащ, золотая броня)
--   rep_mando   Мандалорец-наставник      — мандалорец в духе Джанго Фетта, из наставников клонов на Камино
--   cis_hunter  Трандошанский следопыт    — ящер с дробовиком и сетемётом
--   rep_hunter  Барабельский ловчий       — то же у Республики
-- Умения — в бою 2.0 (shared/rt-ground.js HUNT, флаги f/n/j в shared/rt-units.js): урон по героям ×1,3,
-- внушение и страх не берут; следопыт — дробовик и сеть (держит на месте, джедай не отражает выстрелы);
-- мандалорец — два бластера, наручная ракета, реактивный ранец (отскок от клинка).
-- Карточки — из моделек боя (tools/unit-cards.html), ?v=2 — у КНС картинка сменилась (раньше была модель BX).

update public.unit_types set
  description = 'Наёмник в мандалорской броне, охотник на одарённых. Два бластера, наручная ракета и реактивный ранец: от клинка уходит прыжком. Внушение и страх его не берут.',
  image = 'assets/units/models/cis_bounty.jpg?v=2'
 where id = 'cis_bounty';

update public.unit_types set
  damage = 50, weapon_range = 3,
  description = 'Трандошанин-следопыт, охотник на одарённых. Дробовик страшен в упор, сетемёт ловит джедая: в сети тот не сходит с места и не отражает выстрелы. Видит дальше всей строевой пехоты.',
  image = 'assets/units/models/cis_hunter.jpg?v=2'
 where id = 'cis_hunter';

insert into public.unit_types (id, name, icon, layer, max_hp, vision_range, is_relay, cost, faction, image, damage, move_range, produced_by,
  build_seconds, description, slot_size, width_cells, height_cells, carry_slots, is_vehicle, weapon_range, accuracy, evasion, hull_class,
  is_scout, stealth_range, is_hero, cost_resources, action_seconds, shot_ap, splash_size, can_build)
select 'rep_mando', 'Мандалорец-наставник', u.icon, u.layer, u.max_hp, u.vision_range, u.is_relay, u.cost, 'republic', 'assets/units/models/rep_mando.jpg',
       u.damage, u.move_range, 'rep_bar', u.build_seconds,
       'Мандалорец из наставников клонов на Камино, охотник на одарённых. Два бластера, наручная ракета и реактивный ранец: от клинка уходит прыжком. Внушение и страх его не берут.',
       u.slot_size, u.width_cells, u.height_cells, u.carry_slots, u.is_vehicle, u.weapon_range, u.accuracy, u.evasion, u.hull_class,
       u.is_scout, u.stealth_range, u.is_hero, u.cost_resources, u.action_seconds, u.shot_ap, u.splash_size, u.can_build
  from public.unit_types u where u.id = 'cis_bounty'
on conflict (id) do nothing;

insert into public.unit_types (id, name, icon, layer, max_hp, vision_range, is_relay, cost, faction, image, damage, move_range, produced_by,
  build_seconds, description, slot_size, width_cells, height_cells, carry_slots, is_vehicle, weapon_range, accuracy, evasion, hull_class,
  is_scout, stealth_range, is_hero, cost_resources, action_seconds, shot_ap, splash_size, can_build)
select 'rep_hunter', 'Барабельский ловчий', u.icon, u.layer, u.max_hp, u.vision_range, u.is_relay, u.cost, 'republic', 'assets/units/models/rep_hunter.jpg',
       u.damage, u.move_range, 'rep_bar', u.build_seconds,
       'Барабел-ловчий на службе Республики, охотник на одарённых. Дробовик страшен в упор, сетемёт ловит ситха: в сети тот не сходит с места и не применяет Силу. Видит дальше всей строевой пехоты.',
       u.slot_size, u.width_cells, u.height_cells, u.carry_slots, u.is_vehicle, u.weapon_range, u.accuracy, u.evasion, u.hull_class,
       u.is_scout, u.stealth_range, u.is_hero, u.cost_resources, u.action_seconds, u.shot_ap, u.splash_size, u.can_build
  from public.unit_types u where u.id = 'cis_hunter'
on conflict (id) do nothing;
