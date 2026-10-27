-- Мины инженера (27.10.2026). Прикопанная мина проходима, врагу не видна ни на экране, ни в базе;
-- наступил враг — взрыв в бою 2.0 (shared/rt-ground.js minesStep, числа — SWUnits.ST.landmine и MINE).
-- Сработавшая мина (прочность 0) из базы убирается тиком построек. Повторный запуск безопасен.

-- вид постройки
alter table structure_types drop constraint if exists structure_types_kind_check;
alter table structure_types add constraint structure_types_kind_check
  check (kind = any (array['trench', 'camo', 'bunker', 'jammer', 'turret', 'extractor', 'cantina', 'radar', 'landmine']));

-- исследования: открывают мины инженеру своей фракции
insert into researches (id, name, description, category, icon, tier, requires, cost, research_seconds,
                        effect_kind, effect_value, sort_order, icon_image, applies_to, scope, applies_units)
values
  ('rep_eng_mines', 'Минирование',
   'Инженер прикапывает мины: враг их не видит, а наступив — подрывается. Взрыв задевает всех рядом, технике достаётся сильнее.',
   'Фортификация', '⚒', 1, null, 1600, 90, 'unlock_structure', 1, 507, 'assets/research/rep_eng_mines.png',
   '{}', 'structure', array['rep_engineer']),
  ('cis_eng_mines', 'Минирование',
   'Инженерный дроид прикапывает мины: враг их не видит, а наступив — подрывается. Взрыв задевает всех рядом, технике достаётся сильнее.',
   'Фортификация', '⚒', 1, null, 1600, 90, 'unlock_structure', 1, 507, 'assets/research/cis_eng_mines.png',
   '{}', 'structure', array['cis_engineer'])
on conflict (id) do update set name = excluded.name, description = excluded.description, icon_image = excluded.icon_image;

-- мина — сразу после турели в списке инженера
update structure_types set sort_order = sort_order + 1
 where sort_order >= 5 and kind <> 'landmine'
   and not exists (select 1 from structure_types where kind = 'landmine');

insert into structure_types (id, faction, kind, name, description, image, width_cells, height_cells, max_hp, cost,
                             cost_resources, build_seconds, research_id, max_per_planet, enterable, infantry_only,
                             cover_pct, damage_mult, radius, damage, accuracy, cooldown_seconds, sort_order)
values
  ('rep_landmine', 'republic', 'landmine', 'Мина',
   'Прикопана в землю — враг её не видит. Наступит — взрыв: урон 150 в 2 клетках, к краю вдвое меньше, технике в полтора раза больше. Свои ходят по ней спокойно, но взрыв задевает всех рядом.',
   'assets/structures/rep_landmine.png', 1, 1, 40, 350, '{"durasteel": 10, "cells": 15}', 40, 'rep_eng_mines', 16,
   false, false, 0, 1, 0, 150, 0, 0, 5),
  ('cis_landmine', 'cis', 'landmine', 'Мина',
   'Прикопана в землю — враг её не видит. Наступит — взрыв: урон 150 в 2 клетках, к краю вдвое меньше, технике в полтора раза больше. Свои ходят по ней спокойно, но взрыв задевает всех рядом.',
   'assets/structures/cis_landmine.png', 1, 1, 40, 350, '{"durasteel": 10, "cells": 15}', 40, 'cis_eng_mines', 16,
   false, false, 0, 1, 0, 150, 0, 0, 5)
on conflict (id) do update set description = excluded.description, damage = excluded.damage, max_per_planet = excluded.max_per_planet;

-- чужую мину не видно: ни в списке построек, ни по касанию
create or replace function public.can_see_structure(p_system text, p_faction text, p_type text, p_x integer, p_y integer, p_w integer, p_h integer)
 returns boolean
 language plpgsql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare v_me text; v_kind text;
begin
  select faction into v_me from profiles where id = auth.uid();
  if v_me is null then return false; end if;
  if p_faction = v_me then return true; end if;

  select kind into v_kind from structure_types where id = p_type;
  if v_kind = 'landmine' then return false; end if;
  if v_kind = 'camo' then
    return observer_near(p_system, p_x, p_y, p_w, p_h, game_setting_int('camo_detect_cells', 3))
        or radar_covers(p_system, v_me, p_x, p_y, p_w, p_h);
  end if;

  return exists (select 1 from generate_series(p_x, p_x + p_w - 1) gx,
                               generate_series(p_y, p_y + p_h - 1) gy
                 where can_see_position(p_system, 'ground', gx, gy));
end;
$function$;

-- тик построек: сработавшие мины (прочность 0 после боя) убираем — не держат место и предел
do $$
declare d text;
begin
  d := pg_get_functiondef('public.structures_tick()'::regprocedure);
  if position('kind = ''landmine''' in d) = 0 then
    d := replace(d, '  -- Достроено',
'  -- Сработавшие мины: бой записал им прочность 0 — убираем, место и предел свободны
  delete from field_structures f using structure_types t
   where t.id = f.type_id and t.kind = ''landmine'' and f.hp <= 0;

  -- Достроено');
    execute d;
  end if;
end $$;
