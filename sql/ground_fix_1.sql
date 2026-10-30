-- Исправления наземки 2.0, этап 1 (аудит 30.10.2026, BUG-040).
-- Кто может ОТКРЫТЬ комнату планеты на сервере боёв (server/index.js). Открытие запирает всех бойцов планеты
-- (rt_ground_open), останавливает автоходы и занимает одно из 12 мест на сервере — поэтому только тот, у кого
-- на планете есть дело: планета своей стороны, своё управление, свои бойцы на земле или свой корабль в системе.
-- Войти в уже открытую комнату можно и без этого: туман войны покажет только своё.
create or replace function public.rt_can_open(p_key text, p_system text, p_user uuid, p_layer text)
returns boolean language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare v_fac text;
begin
  perform rt_need_key(p_key);
  select faction into v_fac from profiles where id = p_user;
  if v_fac is null or v_fac not in ('republic', 'cis') then return false; end if;
  if exists (select 1 from systems s where s.id = p_system and s.faction = v_fac) then return true; end if;
  if exists (select 1 from system_control sc where sc.system_id = p_system and sc.controller_user_id = p_user) then return true; end if;
  if p_layer = 'ground' and exists (select 1 from unit_positions u
       where u.system_id = p_system and u.owner_user_id = p_user and u.layer = 'ground' and u.x is not null and u.hp > 0) then
    return true;
  end if;
  return exists (select 1 from ships s where s.system_id = p_system and s.owner_user_id = p_user and not s.in_transit and s.hp > 0);
end $$;
