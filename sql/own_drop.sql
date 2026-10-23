-- Высадка с орбиты на свою и союзную планету через лоток десанта (23.10.2026).
--
-- Лоток десанта на экране земли теперь показывает войска и технику в трюмах и на своей /
-- союзной планете: карточку тянут в зону высадки (js/ground-battle.js dropListFor, js/drop-tray.js).
-- Правило «высадка — только из площадки сброса» до сих пор было у пачечной выгрузки
-- (unload_from_ship) и у техники (unload_vehicle_at), а у поштучной выгрузки бойца на свою
-- планету (unload_unit_at) его не было. Выравниваем: корабль целиком в площадке — для всех.
do $do$
declare d text; a text;
begin
  d := pg_get_functiondef('public.unload_unit_at(uuid, text, integer, integer)'::regprocedure);
  if position('-- Своя и союзная планета: тоже только из площадки сброса' in d) > 0 then return; end if;
  a := $a$  else
    -- Своя планета: работают обычные зоны высадки
    if not is_in_deploy_zone(s.system_id, p_x, p_y) then$a$;
  if position(a in d) = 0 then raise exception 'unload_unit_at: ветка своей планеты не найдена'; end if;
  d := replace(d, a, $a$  else
    -- Своя и союзная планета: тоже только из площадки сброса (как unload_from_ship и unload_vehicle_at)
    if is_in_orbital_drop(s.x, s.y,
         ship_box_w(t.width_cells, t.height_cells, s.facing),
         ship_box_h(t.width_cells, t.height_cells, s.facing)) is null then
      raise exception 'Корабль должен целиком стоять в площадке сброса';
    end if;
    -- Своя планета: работают обычные зоны высадки
    if not is_in_deploy_zone(s.system_id, p_x, p_y) then$a$);
  execute d;
end $do$;
