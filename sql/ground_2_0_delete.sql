-- Наземка 2.0 · снимок боя с удалением погибших.
-- Эту версию rt_ground_sync вставляют в SQL Editor вручную: через MCP любой текст с DELETE
-- не проходит. Пока она не применена, погибшие лежат в unit_positions с hp = 0 (с карты они
-- не читаются: rt_ground_units берёт только hp > 0), а после — уходят как у attack_unit:
-- убийство засчитывается герою (record_hero_kill), строка удаляется, триггеры делают остальное
-- (гибель героя, сводка событий).
--
-- 23.10.2026 (правка в базе DO-блоком по тексту функции — в теле есть DELETE):
--   * поле убийцы в записи — killer, а не by: BY — служебное слово PL/pgSQL, обращение r.by
--     падало всегда, и первая же гибель в бою ломала всю сверку комнаты до её закрытия;
--   * погибшие — первыми, их клетки свободны для живых в этом же пакете;
--   * живые — по одному: в базе на клетку один боец (idx_unit_positions_cell), а в живом бою
--     двое стоят в одной клетке. Общий запрос падал целиком — позиции высаженных бойцов не
--     сохранялись. Теперь занятая клетка — второй заход, потом боец ждёт следующей сверки
--     (здоровье пишется всегда); в ответе busy — сколько таких.

create or replace function public.rt_ground_sync(p_key text, p_battle uuid, p_units jsonb default '[]'::jsonb, p_structs jsonb default '[]'::jsonb)
returns jsonb
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  n_u integer := 0; n_s integer := 0; n_d integer := 0; n_k integer := 0; n_b integer := 0; v_wait uuid[] := '{}';
  r record;
  rl record;
  fire jsonb;
begin
  perform rt_need_key(p_key);
  perform set_config('app.rt_battle', '1', true);

  -- погибшие: как в attack_unit — убийство герою, строка с карты долой. Первыми: клетка павшего
  -- свободна для живых в этом же пакете
  for r in
    select (x->>'id')::uuid as id, nullif(x->>'by', '')::uuid as killer
    from jsonb_array_elements(coalesce(p_units, '[]'::jsonb)) x
    where coalesce((x->>'hp')::integer, 0) <= 0
  loop
    if not exists (select 1 from rt_battle_locks l where l.obj_kind = 'unit' and l.obj_id = r.id and l.battle_id = p_battle) then
      continue;
    end if;
    if r.killer is not null then
      perform record_hero_kill(r.killer, t.unit_type, t.faction, t.owner_user_id, t.system_id)
        from unit_positions t where t.id = r.id;
    end if;
    delete from unit_positions where id = r.id;
    delete from rt_battle_locks where obj_kind = 'unit' and obj_id = r.id;
    n_d := n_d + 1;
  end loop;

  -- живые: клетка и прочность (только бойцы этого боя). По одному бойцу: в базе на клетку один
  -- боец (idx_unit_positions_cell), а в живом бою двое стоят в одной клетке или меняются местами —
  -- общий запрос падал целиком, и ни позиции, ни здоровье, ни погибшие не записывались.
  -- Клетка занята — второй заход после остальных (цепочки и обмены местами); всё ещё занята —
  -- боец остаётся в прежней клетке до следующей сверки, здоровье пишется всегда.
  for rl in
    select (x->>'id')::uuid as id, (x->>'x')::integer as x, (x->>'y')::integer as y, (x->>'hp')::integer as hp
    from jsonb_array_elements(coalesce(p_units, '[]'::jsonb)) x
    join rt_battle_locks l on l.obj_kind = 'unit' and l.obj_id = (x->>'id')::uuid and l.battle_id = p_battle
    where coalesce((x->>'hp')::integer, 0) > 0
  loop
    begin
      update unit_positions u set x = rl.x, y = rl.y, hp = rl.hp, updated_at = now()
       where u.id = rl.id and u.layer = 'ground' and u.x is not null;
      get diagnostics n_k = row_count; n_u := n_u + n_k;
    exception when unique_violation then
      v_wait := v_wait || rl.id;
    end;
  end loop;
  if array_length(v_wait, 1) > 0 then
    for rl in
      select (x->>'id')::uuid as id, (x->>'x')::integer as x, (x->>'y')::integer as y, (x->>'hp')::integer as hp
      from jsonb_array_elements(coalesce(p_units, '[]'::jsonb)) x
      where (x->>'id')::uuid = any(v_wait)
    loop
      begin
        update unit_positions u set x = rl.x, y = rl.y, hp = rl.hp, updated_at = now()
         where u.id = rl.id and u.layer = 'ground' and u.x is not null;
        get diagnostics n_k = row_count; n_u := n_u + n_k;
      exception when unique_violation then
        update unit_positions u set hp = rl.hp, updated_at = now()
         where u.id = rl.id and u.layer = 'ground' and u.x is not null;
        get diagnostics n_k = row_count; n_u := n_u + n_k; n_b := n_b + n_k;
      end;
    end loop;
  end if;

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
  return jsonb_build_object('units', n_u, 'dead', n_d, 'structs', n_s, 'busy', n_b);
end;
$$;
