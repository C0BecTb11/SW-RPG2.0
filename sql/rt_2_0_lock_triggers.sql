-- ============================================================
-- Игра 2.0: включение блокировки в старой игре.
-- Применяется после rt_2_0_core.sql. Функции-сторожа описаны там.
-- Откат (вручную в SQL Editor): drop trigger a_rt_battle_lock on <таблица> — для всех семи.
-- ============================================================

-- Имя с «a_», чтобы срабатывал раньше остальных BEFORE-триггеров
create trigger a_rt_battle_lock before update or delete on public.unit_positions
  for each row execute function public.rt_battle_guard();

create trigger a_rt_battle_lock before update or delete on public.ships
  for each row execute function public.rt_battle_guard();

create trigger a_rt_battle_lock before insert on public.auto_moves
  for each row execute function public.rt_battle_guard_ref();

create trigger a_rt_battle_lock before insert on public.boardings
  for each row execute function public.rt_battle_guard_ref();

create trigger a_rt_battle_lock before insert on public.boarding_units
  for each row execute function public.rt_battle_guard_ref();

create trigger a_rt_battle_lock before insert on public.repair_orders
  for each row execute function public.rt_battle_guard_ref();

create trigger a_rt_battle_lock before insert on public.troop_transfer_items
  for each row execute function public.rt_battle_guard_ref();

