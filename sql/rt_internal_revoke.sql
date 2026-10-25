-- Служебные функции боёв 2.0 закрыты от игроков и анонимов (аудит 25.10.2026).
-- Их зовут только rt_space_open/rt_space_pull и rt_ground_open/rt_ground_pull (SECURITY DEFINER, с ключом сервера).
-- rt_space_lock переписывал замки кораблей системы на любой бой — снимал защиту «в бою 2.0» и ломал запись итогов;
-- rt_space_state/rt_space_ships/rt_ground_state/rt_ground_units отдавали содержимое любой системы в обход тумана войны.
revoke all on function public.rt_space_lock(uuid, text) from public, anon, authenticated;
revoke all on function public.rt_space_state(text) from public, anon, authenticated;
revoke all on function public.rt_space_ships(text) from public, anon, authenticated;
revoke all on function public.rt_ground_state(text) from public, anon, authenticated;
revoke all on function public.rt_ground_units(text) from public, anon, authenticated;
