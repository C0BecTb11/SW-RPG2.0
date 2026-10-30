-- Исправления наземки 2.0, этап 7 (аудит 30.10.2026).
--
-- BUG-021  площадь: порабощённый боец стоит за того, кто им управляет (unit_positions.rt_state.mind, пишет
--          бой 2.0 — sql/ground_fix_5.sql), как и в движке (shared/rt-ground.js, захват и районы по ctl).
-- BUG-028  матрица урона в базе — та же, что в движке (shared/rt-units.js, DM): недоставало
--          artillery→air, air→hero, turret→structure и ряда мины.

create or replace function public.capture_counts(p_system_id text)
returns table(attackers integer, defenders integer, attacker_faction text)
language sql stable security definer set search_path to 'public', 'pg_temp' as $function$
  with sys as (select faction from systems where id = p_system_id),
  units as (
    select f.faction, count(*)::integer as n
    from unit_positions u
    join unit_types t on t.id = u.unit_type
    -- порабощённый (бой 2.0, срок не вышел) — за хозяина: 0 — Республика, 1 — КНС, 2 — мародёры (не в счёт,
    -- как в движке: ctl > 1 площадь не держит)
    cross join lateral (
      select case
               when (u.rt_state -> 'mind' ->> 'until') ~ '^[0-9.]+$'
                and (u.rt_state -> 'mind' ->> 'until')::numeric > extract(epoch from now())
                and (u.rt_state -> 'mind' ->> 'by') in ('0', '1', '2')
               then case (u.rt_state -> 'mind' ->> 'by') when '0' then 'republic' when '1' then 'cis' else 'marauder' end
               else u.faction
             end as faction) f
    where u.system_id = p_system_id
      and u.layer = 'ground'
      and u.hp > 0
      and u.x is not null
      and not t.is_vehicle
      and f.faction in ('republic', 'cis')
      and is_in_settlement_zone(u.x, u.y)
    group by f.faction
  )
  select
    coalesce((select n from units where faction is distinct from (select faction from sys)), 0),
    coalesce((select n from units where faction = (select faction from sys)), 0),
    (select faction from units where faction is distinct from (select faction from sys) order by n desc limit 1);
$function$;

insert into public.damage_matrix (attacker_class, target_class, multiplier) values
  ('artillery', 'air', 0.3),
  ('air', 'hero', 1),
  ('turret', 'structure', 0.5),
  ('mine', 'infantry', 1), ('mine', 'vehicle', 1.5), ('mine', 'aa', 1.5), ('mine', 'artillery', 1.5),
  ('mine', 'hero', 0.6), ('mine', 'air', 0), ('mine', 'structure', 0.5)
on conflict do nothing;
