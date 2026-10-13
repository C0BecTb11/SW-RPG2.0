-- ============================================================
-- Игра 2.0: включение блокировки в старой игре.
-- Применяется после rt_2_0_core.sql. Функции-сторожа описаны там.
-- Откат: drop trigger a_rt_battle_lock on <таблица> — для всех семи.
-- ============================================================

-- Имя с «a_», чтобы срабатывал раньше остальных BEFORE-триггеров
drop trigger if exists a_rt_battle_lock on public.unit_positions;
create trigger a_rt_battle_lock before update or delete on public.unit_positions
  for each row execute function public.rt_battle_guard();

drop trigger if exists a_rt_battle_lock on public.ships;
create trigger a_rt_battle_lock before update or delete on public.ships
  for each row execute function public.rt_battle_guard();

drop trigger if exists a_rt_battle_lock on public.auto_moves;
create trigger a_rt_battle_lock before insert on public.auto_moves
  for each row execute function public.rt_battle_guard_ref();

drop trigger if exists a_rt_battle_lock on public.boardings;
create trigger a_rt_battle_lock before insert on public.boardings
  for each row execute function public.rt_battle_guard_ref();

drop trigger if exists a_rt_battle_lock on public.boarding_units;
create trigger a_rt_battle_lock before insert on public.boarding_units
  for each row execute function public.rt_battle_guard_ref();

drop trigger if exists a_rt_battle_lock on public.repair_orders;
create trigger a_rt_battle_lock before insert on public.repair_orders
  for each row execute function public.rt_battle_guard_ref();

drop trigger if exists a_rt_battle_lock on public.troop_transfer_items;
create trigger a_rt_battle_lock before insert on public.troop_transfer_items
  for each row execute function public.rt_battle_guard_ref();

