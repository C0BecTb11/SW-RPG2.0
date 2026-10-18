-- Наземка 2.0 · снимок боя с удалением погибших.
-- Эту версию rt_ground_sync вставляют в SQL Editor вручную: через MCP любой текст с DELETE
-- не проходит. Пока она не применена, погибшие лежат в unit_positions с hp = 0 (с карты они
-- не читаются: rt_ground_units берёт только hp > 0), а после — уходят как у attack_unit:
-- убийство засчитывается герою (record_hero_kill), строка удаляется, триггеры делают остальное
-- (гибель героя, сводка событий).

create or replace function public.rt_ground_sync(p_key text, p_battle uuid, p_units jsonb default '[]'::jsonb, p_structs jsonb default '[]'::jsonb)
returns jsonb
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  n_u integer := 0; n_s integer := 0; n_d integer := 0;
  r record;
  fire jsonb;
begin
  perform rt_need_key(p_key);
  perform set_config('app.rt_battle', '1', true);

  -- живые: клетка и прочность (только бойцы этого боя)
  with rows as (
    select (x->>'id')::uuid as id, (x->>'x')::integer as x, (x->>'y')::integer as y, (x->>'hp')::integer as hp
    from jsonb_array_elements(coalesce(p_units, '[]'::jsonb)) x
    where coalesce((x->>'hp')::integer, 0) > 0)
  update unit_positions u
     set x = rows.x, y = rows.y, hp = rows.hp, updated_at = now()
    from rows join rt_battle_locks l on l.obj_kind = 'unit' and l.obj_id = rows.id and l.battle_id = p_battle
   where u.id = rows.id and u.layer = 'ground' and u.x is not null;
  get diagnostics n_u = row_count;

  -- погибшие: как в attack_unit — убийство герою, строка с карты долой
  for r in
    select (x->>'id')::uuid as id, nullif(x->>'by', '')::uuid as by
    from jsonb_array_elements(coalesce(p_units, '[]'::jsonb)) x
    where coalesce((x->>'hp')::integer, 0) <= 0
  loop
    if not exists (select 1 from rt_battle_locks l where l.obj_kind = 'unit' and l.obj_id = r.id and l.battle_id = p_battle) then
      continue;
    end if;
    if r.by is not null then
      perform record_hero_kill(r.by, t.unit_type, t.faction, t.owner_user_id, t.system_id)
        from unit_positions t where t.id = r.id;
    end if;
    delete from unit_positions where id = r.id;
    delete from rt_battle_locks where obj_kind = 'unit' and obj_id = r.id;
    n_d := n_d + 1;
  end loop;

  with rows as (
    select (x->>'id')::uuid as id, greatest(0, (x->>'hp')::integer) as hp
    from jsonb_array_elements(coalesce(p_structs, '[]'::jsonb)) x)
  update field_structures f set hp = rows.hp from rows where f.id = rows.id;
  get diagnostics n_s = row_count;

  -- кто под огнём (rt_battle_guard: погрузка на корабль и его уход закрыты 30 с после попадания)
  select coalesce(jsonb_object_agg(x->>'id', to_jsonb(now())), '{}'::jsonb) into fire
    from jsonb_array_elements(coalesce(p_units, '[]'::jsonb)) x where coalesce((x->>'fire')::boolean, false);
  update rt_battles b
     set heartbeat_at = now(),
         snapshot = jsonb_build_object('fire', coalesce((
           select jsonb_object_agg(k, v) from jsonb_each(coalesce(b.snapshot->'fire', '{}'::jsonb)) e(k, v)
            where (v #>> '{}')::timestamptz > now() - interval '60 seconds' and not (fire ? k)), '{}'::jsonb) || fire),
         snapshot_at = now()
   where b.id = p_battle and b.status = 'active';
  return jsonb_build_object('units', n_u, 'dead', n_d, 'structs', n_s);
end;
$$;
