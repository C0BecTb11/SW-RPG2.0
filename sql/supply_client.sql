-- Снабжение, шаг 3 (24.10.2026): чтение для окна.
-- get_supply_hub — есть ли у игрока штаб снабжения (тот же supply_has_hub, что проверяет запуск рейса):
-- без него окно делает «Новый рейс» неактивным и объясняет почему, а не отказывает после настройки рейса.
create or replace function public.get_supply_hub()
returns boolean language sql stable security definer set search_path to 'public', 'pg_temp' as $$
  select auth.uid() is not null and supply_has_hub(auth.uid());
$$;
revoke all on function public.get_supply_hub() from public, anon;
grant execute on function public.get_supply_hub() to authenticated;
