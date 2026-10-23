-- Колесо-страж (cis_wheel) — дроид-колесо Конфедерации, 23.10.2026.
-- Бой: shared/rt-units.js (флаг w), shared/rt-ground.js (WHEEL: качение, раскрытие, щит, спаренные бластеры),
-- вид — shared/rt-vehicles.js guard(), карточка — assets/units/models/cis_wheel.jpg (tools/unit-cards.html).
-- Делает «Фабрика дроидов» (cis_droid). Класс корпуса — пехота (матрица урона, ход пешком: unit_move_kind → foot).
insert into public.unit_types (id, name, layer, max_hp, vision_range, is_relay, cost, faction, image, damage, move_range,
  produced_by, build_seconds, description, slot_size, width_cells, height_cells, carry_slots, is_vehicle, weapon_range,
  accuracy, evasion, hull_class, is_scout, is_hero, cost_resources, shot_ap, splash_size, can_build)
values ('cis_wheel', 'Колесо-страж', 'ground', 150, 6, false, 550, 'cis', 'assets/units/models/cis_wheel.jpg', 25, 9,
  'cis_droid', 90,
  'Дроид-колесо. Катится быстрее всей пехоты, но на ходу не стреляет. Встав, за секунду раскрывается, поднимает щит и бьёт спаренными бластерами. Щит держит огонь пехоты, турелей и техники издали, но не артиллерию, не технику в упор и не клинки; пробитый — восстанавливается не сразу.',
  1, 1, 1, 0, false, 4, 78, 12, 'infantry', false, false, '{"durasteel":20,"electronics":10}'::jsonb, 1, 0, false)
on conflict (id) do nothing;
