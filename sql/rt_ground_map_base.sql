-- Базовые маски проходимости планет (без города), аудит 25.10.2026.
-- Маску планеты писало только первое открытие её в 2.0 (rt_ground_map, version 'town:N'); до того planet_cell_ok
-- пропускал любую клетку — высадка и стройка старой игры не видели воду и скалы (11 из 20 планет).
-- Сервер боёв при запуске (server/index.js seedMasks) спрашивает, у кого маски нет, и пишет базовую из
-- shared/planets/<id>.json (tools/planets/masks.js). Городскую маску не трогает. sql/planet_maps_seed.sql в .gitignore —
-- слишком большой для репозитория и не нужен.
create or replace function public.rt_ground_map_missing(p_key text)
returns text[]
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  perform rt_need_key(p_key);
  return coalesce((select array_agg(s.id order by s.id) from systems s
                    where not coalesce(s.is_deep_space, false)
                      and not exists (select 1 from planet_maps pm where pm.system_id = s.id)), '{}');
end;
$$;

create or replace function public.rt_ground_map_base(p_key text, p_system text, p_masks jsonb)
returns boolean
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $$
declare n integer;
begin
  perform rt_need_key(p_key);
  insert into planet_maps (system_id, w, h, foot1, track1, track2, hover1, hover2, version)
  values (p_system, coalesce((p_masks->>'w')::integer, 144), coalesce((p_masks->>'h')::integer, 144),
          p_masks->>'foot1', p_masks->>'track1', p_masks->>'track2', p_masks->>'hover1', p_masks->>'hover2', 'base')
  on conflict (system_id) do nothing;
  get diagnostics n = row_count;
  return n > 0;
end;
$$;
revoke all on function public.rt_ground_map_missing(text) from public;
revoke all on function public.rt_ground_map_base(text, text, jsonb) from public;
grant execute on function public.rt_ground_map_missing(text) to anon, authenticated;
grant execute on function public.rt_ground_map_base(text, text, jsonb) to anon, authenticated;
