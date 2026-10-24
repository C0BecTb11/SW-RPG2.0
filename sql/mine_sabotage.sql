-- Диверсии на участках и цехах — шаг 4а (24.10.2026). План — claude/sabotage-plan.md.
--
-- Штаб (rep_hq) и центр управления (cis_control) готовят диверсионные группы (до двух на игрока). Группа идёт
-- на чужую планету в пределах двух гиперпутей: перелёт (30 мин на путь) → подход 15 мин (его видно в сцене
-- участка цели) → действие → отход 10 мин + перелёт → отдых 12 ч. Шанс считается в момент действия:
-- 75 % − 12 % за охранника (+1 от «Казарм ополчения») − 20 % за караул − 10 % за «Узел связи» + 10 % ночью
-- (22–06 по серверу) + 5 % за успех группы (до трёх), в пределах 10–90 %.
-- Операции: саботаж оборудования (износ +30 %, смена обрывается), подстрекательство (люди бастуют 6 ч, напряжение +4 на сутки),
-- вирус (половина дроидов сбоит 6 ч, с «Мастерскими» — 3 ч), срыв снабжения (−25 % еды планеты, до 40; ближайшая
-- смена людей без пайка), кража (30 % ресурса участка со склада планеты, до 120 — уходит на планету штаба).
-- Поймали — группа пропадает, хозяину награда 300 кр и имя сразу. Удалась — хозяин видит происшествие сразу,
-- а кто это — по итогам следствия через 8 ч («Узел связи» — 3 ч, охрана на посту — вдвое быстрее).
-- Потолки: по одной цели — раз в 24 ч; одной жертве — не больше двух операций за сутки.
-- Защита участка: охрана (новая роль бригады, 350 кр, до мест/6 + 1) и задача смены «Караул» (выработка ×0,6).

insert into public.game_settings (key, value) values
  ('spy_group_cost', '1200'), ('spy_group_electronics', '20'), ('spy_train_min', '120'), ('spy_max_groups', '2'),
  ('spy_op_cost', '200'), ('spy_jump_min', '30'), ('spy_approach_min', '15'), ('spy_exit_min', '10'), ('spy_rest_h', '12'),
  ('spy_base_pct', '75'), ('spy_guard_pct', '12'), ('spy_watch_pct', '20'), ('spy_comms_pct', '10'), ('spy_night_pct', '10'),
  ('spy_vet_pct', '5'), ('spy_reveal_h', '8'), ('spy_reveal_comms_h', '3'), ('spy_bounty', '300'),
  ('mine_hire_guard', '350')
on conflict (key) do nothing;

-- ---------------------------------------------------------------- таблицы
create table if not exists public.spy_groups (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null,
  faction text not null,
  hq_building uuid not null,
  base_system text not null,
  name text not null,
  status text not null default 'home',           -- home | mission | lost
  ready_at timestamptz not null,                  -- до этого готовится или отдыхает
  wins integer not null default 0,
  created_at timestamptz not null default now(),
  lost_at timestamptz
);
create index if not exists spy_groups_owner on public.spy_groups (owner_user_id) where status <> 'lost';

create table if not exists public.spy_ops (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null,
  attacker uuid not null,
  attacker_faction text not null,
  base_system text not null,
  target_building uuid not null,
  target_system text not null,
  victim uuid,
  kind text not null,                             -- blast (саботаж) | strike | virus | poison (срыв снабжения) | theft
  spot integer not null default -1,               -- место работы (саботаж, вирус); −1 склад, −2 барак
  jumps integer not null,
  seed integer not null,
  launched_at timestamptz not null default now(),
  approach_at timestamptz not null,
  act_at timestamptz not null,
  back_at timestamptz not null,
  acted_at timestamptz,
  status text not null default 'go',              -- go | acted | done
  result text,                                    -- ok | caught | void
  chance numeric,
  roll numeric,
  effect jsonb,
  stolen integer not null default 0,
  stolen_res text,
  reveal_at timestamptz,
  revealed boolean not null default false
);
create index if not exists spy_ops_target on public.spy_ops (target_building, approach_at desc);
create index if not exists spy_ops_attacker on public.spy_ops (attacker, launched_at desc);
create index if not exists spy_ops_open on public.spy_ops (status) where status <> 'done';
alter table public.spy_groups enable row level security;
alter table public.spy_ops enable row level security;

alter table public.mine_sites add column if not exists guards integer not null default 0;
alter table public.mine_sites add column if not exists spoiled_until timestamptz;    -- пайки испорчены: ближайшая смена людей без пайка
alter table public.mine_hurt add column if not exists reason text not null default 'rush';   -- rush | strike | virus

insert into public.event_types (type, category, title, tone, jumpable) values
  ('sabotage_incident', 'combat', 'Происшествие на участке', 'bad', true),
  ('sabotage_revealed', 'combat', 'Итоги следствия', 'warn', true),
  ('sabotage_caught', 'combat', 'Диверсанты задержаны', 'good', true),
  ('spy_result', 'combat', 'Тайная операция', 'neutral', false),
  ('spy_back', 'combat', 'Группа вернулась', 'good', false)
on conflict (type) do nothing;

-- ---------------------------------------------------------------- числа
create or replace function public.mine_max_guards(p_places integer) returns integer
language sql immutable set search_path to 'public', 'pg_temp' as $$ select p_places / 6 + 1; $$;

-- охрана на посту: нанятые + один от «Казарм ополчения»
create or replace function public.spy_guards(p_building uuid) returns integer
language sql stable set search_path to 'public', 'pg_temp' as $$
  select least(s.guards, mine_max_guards(s.places)) + case when settlement_has_district(s.system_id, 'garrison') then 1 else 0 end
    from mine_sites s where s.building_id = p_building;
$$;

-- задача смены «Караул»: бригада сторожит
create or replace function public.mine_task_k(p_task text) returns numeric
language sql immutable set search_path to 'public', 'pg_temp' as $$
  select case p_task when 'prep' then 0.2 when 'survey' then 0 when 'maint' then 0 when 'guard' then 0.6 else 1 end;
$$;

create or replace function public.spy_night(p_at timestamptz) returns boolean
language sql stable set search_path to 'public', 'pg_temp' as $$
  select extract(hour from p_at at time zone coalesce((select value from game_settings where key = 'server_tz'), 'Europe/Moscow')) not between 6 and 21;
$$;

-- шанс, известный нападающему: без охраны, караула и связи цели
create or replace function public.spy_chance_known(p_wins integer, p_at timestamptz) returns integer
language sql stable set search_path to 'public', 'pg_temp' as $$
  select greatest(10, least(90, game_setting_int('spy_base_pct', 75)
       + case when spy_night(p_at) then game_setting_int('spy_night_pct', 10) else 0 end
       + game_setting_int('spy_vet_pct', 5) * least(3, coalesce(p_wins, 0))));
$$;

-- полный шанс в момент действия
create or replace function public.spy_chance(p_building uuid, p_wins integer, p_at timestamptz) returns integer
language sql stable set search_path to 'public', 'pg_temp' as $$
  select greatest(10, least(90, game_setting_int('spy_base_pct', 75)
       + case when spy_night(p_at) then game_setting_int('spy_night_pct', 10) else 0 end
       + game_setting_int('spy_vet_pct', 5) * least(3, coalesce(p_wins, 0))
       - game_setting_int('spy_guard_pct', 12) * coalesce(spy_guards(p_building), 0)
       - case when exists (select 1 from mine_shifts sh where sh.building_id = p_building and sh.status = 'run' and sh.task = 'guard')
              then game_setting_int('spy_watch_pct', 20) else 0 end
       - case when settlement_has_district((select system_id from mine_sites where building_id = p_building), 'comms')
              then game_setting_int('spy_comms_pct', 10) else 0 end));
$$;

-- гиперпути между планетами, не дальше двух
create or replace function public.spy_jumps(p_a text, p_b text) returns integer
language sql stable set search_path to 'public', 'pg_temp' as $$
  with recursive w(sys, d) as (
    select p_a, 0
    union
    select case when h.system_a = w.sys then h.system_b else h.system_a end, w.d + 1
      from w join hyperlanes h on h.system_a = w.sys or h.system_b = w.sys
     where w.d < 2)
  select min(d) from w where sys = p_b;
$$;

create or replace function public.spy_kind_name(p_kind text) returns text
language sql immutable set search_path to 'public', 'pg_temp' as $$
  select case p_kind when 'blast' then 'Саботаж оборудования' when 'strike' then 'Подстрекательство' when 'virus' then 'Вирус в дроидах'
                     when 'poison' then 'Срыв снабжения' when 'theft' then 'Кража со склада' else p_kind end;
$$;

-- штаб игрока: готовый, своей фракции, на его планете
create or replace function public.spy_hq_ok(p_building uuid, p_user uuid) returns boolean
language sql stable set search_path to 'public', 'pg_temp' as $$
  select exists (
    select 1 from buildings bd join building_types bt on bt.id = bd.building_type_id join systems sy on sy.id = bd.system_id
      join system_control sc on sc.system_id = bd.system_id
     where bd.id = p_building and bt.code in ('rep_hq', 'cis_control')
       and (bd.completes_at is null or bd.completes_at <= now())
       and bd.faction is not distinct from sy.faction and sc.controller_user_id = p_user);
$$;

-- ---------------------------------------------------------------- для окна участка: что видно хозяину
-- Подход виден, как только группа на месте; что за операция — только после действия; кто — после следствия или поимки
create or replace function public.spy_site_ops(p_building uuid) returns jsonb
language sql stable security definer set search_path to 'public', 'pg_temp' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', o.id, 'approach_at', o.approach_at, 'act_at', o.act_at, 'acted_at', o.acted_at, 'seed', o.seed,
           'side', o.attacker_faction, 'spot', o.spot,
           'kind', case when o.acted_at is not null then o.kind end,
           'name', case when o.acted_at is not null then spy_kind_name(o.kind) end,
           'result', o.result, 'effect', case when o.acted_at is not null then o.effect end,
           'reveal_at', o.reveal_at, 'revealed', o.revealed,
           'who', case when o.revealed then (select nickname from profiles where id = o.attacker) end)
         order by o.approach_at desc), '[]'::jsonb)
    from spy_ops o
   where o.target_building = p_building and o.approach_at <= now() and o.approach_at > now() - interval '48 hours'
     and o.result is distinct from 'void';
$$;

-- ---------------------------------------------------------------- действие
create or replace function public.spy_resolve(p_op uuid) returns void
language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare o spy_ops; g spy_groups; s mine_sites; v_ctl uuid; v_vfac text; v_sname text; v_bname text; v_slot integer;
  v_ch integer; v_roll numeric; v_eff jsonb := '{}'::jsonb; v_sh mine_shifts; v_n integer; v_h numeric; v_have integer;
  v_txt text; v_take integer := 0; v_meta jsonb; v_aname text; v_bounty integer := game_setting_int('spy_bounty', 300);
begin
  select * into o from spy_ops where id = p_op and status = 'go' for update;
  if not found then return; end if;
  select * into g from spy_groups where id = o.group_id for update;
  select * into s from mine_sites where building_id = o.target_building for update;
  select sc.controller_user_id, sy.faction, sy.name into v_ctl, v_vfac, v_sname
    from systems sy left join system_control sc on sc.system_id = sy.id where sy.id = o.target_system;
  select bd.slot_index, bt.name into v_slot, v_bname
    from buildings bd join building_types bt on bt.id = bd.building_type_id where bd.id = o.target_building;
  select nickname into v_aname from profiles where id = o.attacker;
  v_meta := jsonb_build_object('slot', v_slot, 'building_id', o.target_building, 'op', o.id);

  -- цели больше нет или планета перешла к своим — группа возвращается ни с чем
  if s.building_id is null or s.gone or v_slot is null or v_ctl is null or v_vfac is not distinct from o.attacker_faction then
    update spy_ops set status = 'acted', acted_at = now(), result = 'void' where id = p_op;
    perform log_event(o.attacker, o.attacker_faction, o.target_system, 'spy_result',
      spy_kind_name(o.kind) || ': цели больше нет — группа возвращается', null, 'private', '{}'::jsonb);
    return;
  end if;

  v_ch := spy_chance(o.target_building, g.wins, now());
  v_roll := random() * 100;

  if v_roll >= v_ch then
    -- охрана заметила: группа схвачена, хозяин узнаёт сразу и получает награду
    update spy_ops set status = 'acted', acted_at = now(), result = 'caught', chance = v_ch, roll = v_roll, victim = v_ctl,
                       revealed = true, reveal_at = now() where id = p_op;
    update spy_groups set status = 'lost', lost_at = now() where id = g.id;
    update profiles set credits = credits + v_bounty where id = v_ctl;
    perform log_event(v_ctl, v_vfac, o.target_system, 'sabotage_caught',
      v_bname || ': охрана задержала диверсантов игрока ' || coalesce(v_aname, '?') || ' · награда ' || v_bounty || ' кр.',
      null, 'private', v_meta);
    perform log_event(o.attacker, o.attacker_faction, o.target_system, 'spy_result',
      'Провал: ' || g.name || ' в плену — ' || lower(spy_kind_name(o.kind)) || ', ' || v_bname || ' · шанс был ' || v_ch || ' %', null, 'private', '{}'::jsonb);
    return;
  end if;

  select * into v_sh from mine_shifts where building_id = s.building_id and status = 'run';
  if o.kind = 'blast' then
    update mine_sites set wear = least(100, wear + 30) where building_id = s.building_id;
    if v_sh.id is not null then perform mine_finish(v_sh.id, 'stopped'); end if;
    v_eff := jsonb_build_object('wear', 30, 'shift', v_sh.id is not null);
    v_txt := 'установка №' || (o.spot + 1) || ' выведена из строя: износ +30 %' || case when v_sh.id is not null then ', смена оборвана' else '' end;
  elsif o.kind = 'strike' then
    if s.humans > 0 then
      if v_sh.id is not null and v_sh.humans > 0 then perform mine_finish(v_sh.id, 'stopped'); end if;
      insert into mine_hurt (building_id, kind, n, until, reason) values (s.building_id, 'h', s.humans, now() + interval '6 hours', 'strike');
      v_txt := 'бригада бастует: ' || s.humans || ' чел. не выйдут 6 ч';
    else
      v_txt := 'подстрекатели у ворот, но людей в бригаде нет';
    end if;
    v_eff := jsonb_build_object('humans', s.humans);
  elsif o.kind = 'virus' then
    v_n := ceil(s.droids / 2.0)::integer;
    v_h := case when settlement_has_district(s.system_id, 'workshops') then 3 else 6 end;
    if v_n > 0 then
      if v_sh.id is not null and v_sh.droids > 0 then perform mine_finish(v_sh.id, 'stopped'); end if;
      insert into mine_hurt (building_id, kind, n, until, reason) values (s.building_id, 'd', v_n, now() + make_interval(hours => v_h::integer), 'virus');
      v_txt := 'сбой дроидов: ' || v_n || ' встали на ' || v_h || ' ч';
    else
      v_txt := 'вирус в сети, но дроидов в бригаде нет';
    end if;
    v_eff := jsonb_build_object('droids', v_n, 'hours', v_h);
  elsif o.kind = 'poison' then
    select coalesce(amount, 0) into v_have from planet_stock where system_id = s.system_id and resource = 'food' for update;
    v_n := least(40, ceil(coalesce(v_have, 0) * 0.25))::integer;
    if v_n > 0 then update planet_stock set amount = amount - v_n where system_id = s.system_id and resource = 'food'; end if;
    update mine_sites set spoiled_until = now() + interval '12 hours' where building_id = s.building_id;
    v_eff := jsonb_build_object('food', v_n);
    v_txt := 'снабжение сорвано: −' || coalesce(v_n, 0) || ' еды, ближайшая смена людей без пайка';
  else
    select coalesce(amount, 0) into v_have from planet_stock where system_id = s.system_id and resource = s.resource for update;
    v_take := least(120, floor(coalesce(v_have, 0) * 0.3))::integer;
    if v_take > 0 then update planet_stock set amount = amount - v_take where system_id = s.system_id and resource = s.resource; end if;
    v_eff := jsonb_build_object('stolen', v_take, 'res', s.resource);
    v_txt := 'склад вскрыт: пропало ' || v_take || ' — ' || lower((select name from resources where id = s.resource));
  end if;

  v_h := case when settlement_has_district(s.system_id, 'comms') then game_setting_int('spy_reveal_comms_h', 3) else game_setting_int('spy_reveal_h', 8) end
       * case when coalesce(spy_guards(s.building_id), 0) > 0 then 0.5 else 1 end;
  update spy_ops set status = 'acted', acted_at = now(), result = 'ok', chance = v_ch, roll = v_roll, victim = v_ctl, effect = v_eff,
                     stolen = v_take, stolen_res = case when v_take > 0 then s.resource end,
                     reveal_at = now() + make_interval(mins => round(v_h * 60)::integer)
   where id = p_op;
  perform log_event(v_ctl, v_vfac, o.target_system, 'sabotage_incident',
    v_bname || ': ' || v_txt || ' · причина выясняется, итоги следствия через ' || replace(rtrim(rtrim(to_char(v_h, 'FM990.0'), '0'), '.'), '.', ',') || ' ч',
    null, 'private', v_meta);
  perform log_event(o.attacker, o.attacker_faction, o.target_system, 'spy_result',
    g.name || ': «' || spy_kind_name(o.kind) || '» — успех, ' || v_bname || ', ' || v_sname || ' · ' || v_txt, null, 'private', '{}'::jsonb);
end;
$$;

-- ---------------------------------------------------------------- тик (раз в минуту)
create or replace function public.spy_tick() returns void
language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare r record; v integer; v_bname text; v_sname text; v_aname text; v_afac text;
begin
  -- действие: группа на месте, подход прошёл
  for r in select id from spy_ops where status = 'go' and act_at <= now() order by act_at loop
    begin perform spy_resolve(r.id);
    exception when others then perform err_db('spy_tick', sqlstate, sqlerrm, true); end;
  end loop;
  -- возвращение: отдых, опыт, добыча кражи — на склад планеты штаба
  for r in select * from spy_ops where status = 'acted' and back_at <= now() loop
    begin
      update spy_ops set status = 'done' where id = r.id;
      if r.result in ('ok', 'void') then
        update spy_groups set status = 'home', ready_at = now() + make_interval(hours => game_setting_int('spy_rest_h', 12)),
                              wins = wins + case when r.result = 'ok' then 1 else 0 end
         where id = r.group_id and status = 'mission';
        if r.stolen > 0 then
          v := add_planet_stock(r.base_system, r.stolen_res, r.stolen);
          perform log_event(r.attacker, r.attacker_faction, r.base_system, 'spy_back',
            (select name from spy_groups where id = r.group_id) || ' на базе: ' || lower((select name from resources where id = r.stolen_res)) || ' +' || v
            || case when v < r.stolen then ' (склад полон, потеряно ' || (r.stolen - v) || ')' else '' end, v, 'private', '{}'::jsonb);
        end if;
      end if;
    exception when others then perform err_db('spy_tick', sqlstate, sqlerrm, true); end;
  end loop;
  -- следствие: хозяину — кто это сделал
  for r in select * from spy_ops where result = 'ok' and not revealed and reveal_at <= now() loop
    begin
      update spy_ops set revealed = true where id = r.id;
      select bt.name, sy.name into v_bname, v_sname from buildings bd join building_types bt on bt.id = bd.building_type_id
        join systems sy on sy.id = bd.system_id where bd.id = r.target_building;
      select nickname into v_aname from profiles where id = r.attacker;
      v_afac := case r.attacker_faction when 'republic' then 'Республика' when 'cis' then 'КНС' else r.attacker_faction end;
      perform log_event(r.victim, (select faction from systems where id = r.target_system), r.target_system, 'sabotage_revealed',
        coalesce(v_bname, 'Участок') || ': ' || lower(spy_kind_name(r.kind)) || ' — диверсия. Исполнитель — группа игрока '
        || coalesce(v_aname, '?') || ' (' || v_afac || ')', null, 'private',
        jsonb_build_object('slot', (select slot_index from buildings where id = r.target_building), 'building_id', r.target_building, 'op', r.id));
    exception when others then perform err_db('spy_tick', sqlstate, sqlerrm, true); end;
  end loop;
end;
$$;

-- ---------------------------------------------------------------- игроку: штаб
create or replace function public.spy_state() returns jsonb
language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare v_me uuid := auth.uid(); v_fac text;
begin
  if v_me is null then raise exception 'Не авторизован'; end if;
  select faction into v_fac from profiles where id = v_me;
  return jsonb_build_object(
    'now', now(), 'faction', v_fac, 'credits', (select credits from profiles where id = v_me),
    'max', game_setting_int('spy_max_groups', 2),
    'hqs', (select coalesce(jsonb_agg(jsonb_build_object('id', bd.id, 'system_id', bd.system_id, 'system_name', sy.name,
              'electronics', coalesce((select amount from planet_stock where system_id = bd.system_id and resource = 'electronics'), 0))
              order by sy.name), '[]'::jsonb)
              from buildings bd join building_types bt on bt.id = bd.building_type_id join systems sy on sy.id = bd.system_id
             where bt.code in ('rep_hq', 'cis_control') and spy_hq_ok(bd.id, v_me)),
    'groups', (select coalesce(jsonb_agg(jsonb_build_object(
                 'id', g.id, 'name', g.name, 'status', g.status, 'ready_at', g.ready_at, 'wins', g.wins, 'created_at', g.created_at,
                 'base_system', g.base_system, 'base_name', (select name from systems where id = g.base_system),
                 'hq_ok', spy_hq_ok(g.hq_building, v_me),
                 'op', (select jsonb_build_object('id', o.id, 'kind', o.kind, 'name', spy_kind_name(o.kind), 'target_name', sy.name,
                          'target_system', o.target_system, 'base_system', o.base_system, 'jumps', o.jumps,
                          'building_name', bt.name, 'launched_at', o.launched_at, 'approach_at', o.approach_at, 'act_at', o.act_at,
                          'back_at', o.back_at, 'acted_at', o.acted_at, 'result', o.result, 'stolen', o.stolen)
                          from spy_ops o join systems sy on sy.id = o.target_system
                          left join buildings bd on bd.id = o.target_building left join building_types bt on bt.id = bd.building_type_id
                         where o.group_id = g.id and o.status <> 'done' order by o.launched_at desc limit 1))
                 order by g.created_at), '[]'::jsonb)
                 from spy_groups g where g.owner_user_id = v_me and g.status <> 'lost'),
    'log', (select coalesce(jsonb_agg(x order by x->>'at' desc), '[]'::jsonb) from (
              select jsonb_build_object('at', coalesce(o.acted_at, o.launched_at), 'name', spy_kind_name(o.kind), 'kind', o.kind,
                       'target_name', sy.name, 'building_name', bt.name, 'result', o.result, 'chance', o.chance, 'stolen', o.stolen,
                       'group', (select name from spy_groups where id = o.group_id)) x
                from spy_ops o join systems sy on sy.id = o.target_system
                left join buildings bd on bd.id = o.target_building left join building_types bt on bt.id = bd.building_type_id
               where o.attacker = v_me and o.result is not null and o.launched_at > now() - interval '7 days'
               order by o.launched_at desc limit 12) q),
    -- карта операций: штабы и группы, всё в двух гиперпутях от них, пути между этими планетами
    'map', (with bases as (
              select bd.system_id s from buildings bd join building_types bt on bt.id = bd.building_type_id
               where bt.code in ('rep_hq', 'cis_control') and spy_hq_ok(bd.id, v_me)
              union select base_system from spy_groups where owner_user_id = v_me and status <> 'lost'),
            near as (select distinct sy.id from systems sy, bases b where not sy.is_deep_space and spy_jumps(b.s, sy.id) is not null)
            select jsonb_build_object(
              'systems', (select coalesce(jsonb_agg(jsonb_build_object('id', sy.id, 'name', sy.name, 'tex', sy.texture, 'x', sy.world_x, 'y', sy.world_y,
                            'faction', sy.faction, 'base', sy.id in (select s from bases),
                            'mine', exists (select 1 from system_control sc where sc.system_id = sy.id and sc.controller_user_id = v_me))), '[]'::jsonb)
                            from systems sy where sy.id in (select id from near)),
              'lanes', (select coalesce(jsonb_agg(jsonb_build_array(h.system_a, h.system_b)), '[]'::jsonb) from hyperlanes h
                         where h.system_a in (select id from near) and h.system_b in (select id from near)))),
    'cfg', jsonb_build_object(
      'cost', game_setting_int('spy_group_cost', 1200), 'electronics', game_setting_int('spy_group_electronics', 20),
      'train_min', game_setting_int('spy_train_min', 120), 'op_cost', game_setting_int('spy_op_cost', 200),
      'jump_min', game_setting_int('spy_jump_min', 30), 'approach_min', game_setting_int('spy_approach_min', 15),
      'exit_min', game_setting_int('spy_exit_min', 10), 'rest_h', game_setting_int('spy_rest_h', 12),
      'base', game_setting_int('spy_base_pct', 75), 'guard', game_setting_int('spy_guard_pct', 12),
      'watch', game_setting_int('spy_watch_pct', 20), 'comms', game_setting_int('spy_comms_pct', 10),
      'night', game_setting_int('spy_night_pct', 10), 'vet', game_setting_int('spy_vet_pct', 5)));
end;
$$;

create or replace function public.spy_train(p_hq uuid) returns jsonb
language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare v_me uuid := auth.uid(); v_fac text; v_sys text; v_cr integer; v_cost integer := game_setting_int('spy_group_cost', 1200);
  v_name text; v_n integer;
begin
  if v_me is null then raise exception 'Не авторизован'; end if;
  if not spy_hq_ok(p_hq, v_me) then raise exception 'Группы готовит штаб на своей планете'; end if;
  select faction into v_fac from profiles where id = v_me;
  select system_id into v_sys from buildings where id = p_hq;
  perform assert_planet_operational(v_sys);
  if (select count(*) from spy_groups where owner_user_id = v_me and status <> 'lost') >= game_setting_int('spy_max_groups', 2) then
    raise exception 'Групп не больше %', game_setting_int('spy_max_groups', 2);
  end if;
  select credits into v_cr from profiles where id = v_me for update;
  if coalesce(v_cr, 0) < v_cost then raise exception 'Недостаточно кредитов: нужно %', v_cost; end if;
  perform take_planet_stock(v_sys, 'electronics', game_setting_int('spy_group_electronics', 20));
  update profiles set credits = credits - v_cost where id = v_me;
  select count(*) + 1 into v_n from spy_groups where owner_user_id = v_me;
  v_name := case when v_fac = 'cis'
    then 'Звено ИН-' || (10 + floor(random() * 89))::integer
    else 'Группа «' || (array['Тень', 'Сумрак', 'Шорох', 'Клинок', 'Вьюга', 'Полночь', 'Рысь', 'Туман'])[1 + floor(random() * 8)::integer] || '-' || v_n || '»' end;
  insert into spy_groups (owner_user_id, faction, hq_building, base_system, name, status, ready_at)
  values (v_me, v_fac, p_hq, v_sys, v_name, 'home', now() + make_interval(mins => game_setting_int('spy_train_min', 120)));
  return spy_state();
end;
$$;

-- цели группы: чужие участки и цеха в пределах двух гиперпутей от штаба
create or replace function public.spy_targets(p_group uuid) returns jsonb
language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare v_me uuid := auth.uid(); g spy_groups;
begin
  select * into g from spy_groups where id = p_group and owner_user_id = v_me and status <> 'lost';
  if not found then raise exception 'Группа не найдена'; end if;
  return (select coalesce(jsonb_agg(p order by (p->>'jumps')::integer, p->>'system_name'), '[]'::jsonb) from (
    select jsonb_build_object('system_id', sy.id, 'system_name', sy.name, 'jumps', spy_jumps(g.base_system, sy.id),
             'owner', (select nickname from profiles where id = sc.controller_user_id),
             'victim_full', (select count(*) from spy_ops o where o.victim = sc.controller_user_id and o.launched_at > now() - interval '24 hours'
                              and o.result is distinct from 'void') >= 2,
             'arrive', now() + make_interval(mins => spy_jumps(g.base_system, sy.id) * game_setting_int('spy_jump_min', 30)),
             'chance', spy_chance_known(g.wins, now() + make_interval(mins => spy_jumps(g.base_system, sy.id) * game_setting_int('spy_jump_min', 30)
                                                                       + game_setting_int('spy_approach_min', 15))),
             'sites', (select coalesce(jsonb_agg(jsonb_build_object('building_id', ms.building_id, 'code', bt.code, 'name', bt.name,
                         'resource', ms.resource, 'res_name', r.name, 'color', r.color, 'places', ms.places,
                         'refine', mine_is_refine(ms.resource),
                         'cooldown_until', (select max(o.launched_at) + interval '24 hours' from spy_ops o where o.target_building = ms.building_id
                                             and o.launched_at > now() - interval '24 hours' and o.result is distinct from 'void'))
                         order by bt.name), '[]'::jsonb)
                         from mine_sites ms join buildings bd on bd.id = ms.building_id join building_types bt on bt.id = bd.building_type_id
                         join resources r on r.id = ms.resource
                        where ms.system_id = sy.id and not ms.gone and bd.faction is not distinct from sy.faction)) p
      from systems sy join system_control sc on sc.system_id = sy.id
     where sy.id <> g.base_system and sc.controller_user_id is not null and sc.controller_user_id <> v_me
       and sy.faction is distinct from g.faction and spy_jumps(g.base_system, sy.id) between 1 and 2
       and exists (select 1 from mine_sites ms where ms.system_id = sy.id and not ms.gone)) q);
end;
$$;

create or replace function public.spy_launch(p_group uuid, p_building uuid, p_kind text) returns jsonb
language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare v_me uuid := auth.uid(); g spy_groups; s mine_sites; v_ctl uuid; v_sfac text; v_j integer; v_cr integer;
  v_cost integer := game_setting_int('spy_op_cost', 200); v_go timestamptz; v_until timestamptz;
begin
  if v_me is null then raise exception 'Не авторизован'; end if;
  if p_kind not in ('blast', 'strike', 'virus', 'poison', 'theft') then raise exception 'Нет такой операции'; end if;
  select * into g from spy_groups where id = p_group and owner_user_id = v_me for update;
  if not found or g.status = 'lost' then raise exception 'Группа не найдена'; end if;
  if g.status = 'mission' then raise exception 'Группа уже на задании'; end if;
  if g.ready_at > now() then raise exception 'Группа ещё не готова'; end if;
  if not spy_hq_ok(g.hq_building, v_me) then raise exception 'Штаб группы потерян — операции ведёт только действующий штаб'; end if;
  select * into s from mine_sites where building_id = p_building;
  if not found or s.gone then raise exception 'Цель не найдена'; end if;
  select sc.controller_user_id, sy.faction into v_ctl, v_sfac from systems sy left join system_control sc on sc.system_id = sy.id where sy.id = s.system_id;
  if v_ctl is null or v_ctl = v_me or v_sfac is not distinct from g.faction then raise exception 'Диверсия — только против чужой планеты'; end if;
  v_j := spy_jumps(g.base_system, s.system_id);
  if v_j is null or v_j < 1 then raise exception 'Цель дальше двух гиперпутей от штаба группы'; end if;
  select max(launched_at) + interval '24 hours' into v_until from spy_ops
   where target_building = p_building and launched_at > now() - interval '24 hours' and result is distinct from 'void';
  if v_until is not null then raise exception 'По этой цели уже работали — следующая операция не раньше чем через % ч', ceil(extract(epoch from v_until - now()) / 3600); end if;
  if (select count(*) from spy_ops where victim = v_ctl and launched_at > now() - interval '24 hours' and result is distinct from 'void') >= 2 then
    raise exception 'Хозяин этой планеты за сутки уже пережил две операции — его не трогают до завтра';
  end if;
  select credits into v_cr from profiles where id = v_me for update;
  if coalesce(v_cr, 0) < v_cost then raise exception 'Недостаточно кредитов: нужно %', v_cost; end if;
  update profiles set credits = credits - v_cost where id = v_me;
  v_go := now() + make_interval(mins => v_j * game_setting_int('spy_jump_min', 30));
  insert into spy_ops (group_id, attacker, attacker_faction, base_system, target_building, target_system, victim, kind, spot, jumps, seed,
                       approach_at, act_at, back_at)
  values (g.id, v_me, g.faction, g.base_system, p_building, s.system_id, v_ctl, p_kind,
          case when p_kind in ('blast', 'virus') then floor(random() * greatest(1, s.places))::integer when p_kind = 'strike' then -2 else -1 end,
          v_j, floor(random() * 1000000000)::integer, v_go,
          v_go + make_interval(mins => game_setting_int('spy_approach_min', 15)),
          v_go + make_interval(mins => game_setting_int('spy_approach_min', 15) + game_setting_int('spy_exit_min', 10) + v_j * game_setting_int('spy_jump_min', 30)));
  update spy_groups set status = 'mission' where id = g.id;
  return spy_state();
end;
$$;

-- ---------------------------------------------------------------- участок: охрана, караул, бастующие, испорченный паёк
create or replace function public.mine_hire(p_building uuid, p_kind text, p_n integer) returns jsonb
language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare s mine_sites; v_cost integer; v_cr integer; v_price integer;
begin
  s := mine_own(p_building);
  if p_kind not in ('h', 'd', 'f', 't', 'g') then raise exception 'Неизвестный вид рабочих'; end if;
  if p_n is null or p_n < 1 or p_n > 50 then raise exception 'Некорректное число'; end if;
  if p_kind in ('h', 'd') and s.humans + s.droids + p_n > s.places * game_setting_int('mine_staff_per_place', 2) then
    raise exception 'В бараке нет места: всего не больше % рабочих', s.places * game_setting_int('mine_staff_per_place', 2);
  end if;
  if p_kind = 'f' and s.foremen + p_n > mine_max_foremen(s.places) then raise exception 'Бригадиров не больше %', mine_max_foremen(s.places); end if;
  if p_kind = 't' and s.techs + p_n > mine_max_techs(s.places) then raise exception 'Техников не больше %', mine_max_techs(s.places); end if;
  if p_kind = 'g' and s.guards + p_n > mine_max_guards(s.places) then raise exception 'Охраны не больше %', mine_max_guards(s.places); end if;
  v_price := case p_kind when 'h' then game_setting_int('mine_hire_human', 150) when 'd' then game_setting_int('mine_hire_droid', 300)
                         when 'f' then game_setting_int('mine_hire_foreman', 600) when 'g' then game_setting_int('mine_hire_guard', 350)
                         else game_setting_int('mine_hire_tech', 400) end;
  if settlement_has_district(s.system_id, 'market') then v_price := round(v_price * 0.8); end if;
  v_cost := p_n * v_price;
  select credits into v_cr from profiles where id = auth.uid() for update;
  if coalesce(v_cr, 0) < v_cost then raise exception 'Недостаточно кредитов: нужно %', v_cost; end if;
  update profiles set credits = credits - v_cost where id = auth.uid();
  update mine_sites set humans = humans + case when p_kind = 'h' then p_n else 0 end,
                        droids = droids + case when p_kind = 'd' then p_n else 0 end,
                        foremen = foremen + case when p_kind = 'f' then p_n else 0 end,
                        techs = techs + case when p_kind = 't' then p_n else 0 end,
                        guards = guards + case when p_kind = 'g' then p_n else 0 end
   where building_id = p_building;
  return mine_site_state(p_building);
end;
$$;

create or replace function public.mine_fire(p_building uuid, p_kind text, p_n integer) returns jsonb
language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare s mine_sites; v_busy integer;
begin
  s := mine_own(p_building);
  if p_kind not in ('h', 'd', 'f', 't', 'g') then raise exception 'Неизвестный вид рабочих'; end if;
  if p_n is null or p_n < 1 then raise exception 'Некорректное число'; end if;
  if p_kind in ('f', 't', 'g') then
    if p_n > (case p_kind when 'f' then s.foremen when 't' then s.techs else s.guards end) then raise exception 'Столько нет'; end if;
    update mine_sites set foremen = foremen - case when p_kind = 'f' then p_n else 0 end,
                          techs = techs - case when p_kind = 't' then p_n else 0 end,
                          guards = guards - case when p_kind = 'g' then p_n else 0 end
     where building_id = p_building;
    return mine_site_state(p_building);
  end if;
  select coalesce(case when p_kind = 'h' then humans else droids end, 0) into v_busy from mine_shifts where building_id = p_building and status = 'run';
  if p_n > (case when p_kind = 'h' then s.humans else s.droids end) - coalesce(v_busy, 0) then
    raise exception 'Столько свободных нет: на смене рабочих не увольняют';
  end if;
  update mine_sites set humans = humans - case when p_kind = 'h' then p_n else 0 end,
                        droids = droids - case when p_kind = 'd' then p_n else 0 end
   where building_id = p_building;
  return mine_site_state(p_building);
end;
$$;

-- правки тел: задача «Караул» в ручной смене; испорченный паёк; бастующие и сбойные — в состоянии; охрана и операции — в окне
do $$
declare d text;
begin
  d := pg_get_functiondef('public.mine_shift_start(uuid,integer,text,integer,integer,text)'::regprocedure);
  if position('''guard''' in d) = 0 then
    if position($a$('extract', 'prep', 'survey', 'maint')$a$ in d) = 0 then raise exception 'mine_shift_start: место правки не найдено'; end if;
    execute replace(d, $a$('extract', 'prep', 'survey', 'maint')$a$, $b$('extract', 'prep', 'survey', 'maint', 'guard')$b$);
  end if;

  d := pg_get_functiondef('public.mine_start(uuid,integer,text,integer,integer,boolean,uuid,text)'::regprocedure);
  if position('spoiled_until' in d) = 0 then
    if position($a$    if coalesce(v_have, 0) >= p_humans then update planet_stock set amount = amount - p_humans where system_id = s.system_id and resource = 'food';
    else v_fh := false; end if;$a$ in d) = 0 then raise exception 'mine_start: место правки не найдено'; end if;
    execute replace(d, $a$    if coalesce(v_have, 0) >= p_humans then update planet_stock set amount = amount - p_humans where system_id = s.system_id and resource = 'food';
    else v_fh := false; end if;$a$, $b$    if coalesce(v_have, 0) >= p_humans and coalesce(s.spoiled_until, now()) <= now() then update planet_stock set amount = amount - p_humans where system_id = s.system_id and resource = 'food';
    else v_fh := false; end if;
    -- испорченный диверсантами паёк: эта смена людей без пайка, дальше снова как обычно
    if s.spoiled_until > now() then update mine_sites set spoiled_until = null where building_id = p_building; end if;$b$);
  end if;

  d := pg_get_functiondef('public.mine_site_state(uuid)'::regprocedure);
  if position('spy_site_ops' in d) = 0 then
    if position($a$jsonb_build_object('kind', kind, 'n', n, 'until', until)$a$ in d) = 0 or position($a$'foremen', s.foremen,$a$ in d) = 0
       or position($a$'hire_t', round($a$ in d) = 0 or position($a$'survey', 0, 'maint', 0)$a$ in d) = 0 then
      raise exception 'mine_site_state: место правки не найдено';
    end if;
    d := replace(d, $a$jsonb_build_object('kind', kind, 'n', n, 'until', until)$a$, $b$jsonb_build_object('kind', kind, 'n', n, 'until', until, 'why', reason)$b$);
    d := replace(d, $a$'foremen', s.foremen,$a$, $b$'guards', s.guards, 'guards_max', mine_max_guards(s.places), 'garrison', settlement_has_district(s.system_id, 'garrison'),
    'comms', settlement_has_district(s.system_id, 'comms'), 'spoiled', coalesce(s.spoiled_until > now(), false), 'ops', spy_site_ops(p_building),
    'foremen', s.foremen,$b$);
    d := replace(d, $a$'hire_t', round($a$, $b$'hire_g', round(game_setting_int('mine_hire_guard', 350) * case when v_market then 0.8 else 1 end),
      'spy', jsonb_build_object('guard', game_setting_int('spy_guard_pct', 12), 'watch', game_setting_int('spy_watch_pct', 20), 'comms', game_setting_int('spy_comms_pct', 10)),
      'hire_t', round($b$);
    d := replace(d, $a$'survey', 0, 'maint', 0)$a$, $b$'survey', 0, 'maint', 0, 'guard', mine_task_k('guard'))$b$);
    execute d;
  end if;
  -- время сервера в состоянии: сцена ведёт фигурки группы по нему, а не по часам телефона
  d := pg_get_functiondef('public.mine_site_state(uuid)'::regprocedure);
  if position($a$'now', now(), 'building_id', p_building,$a$ in d) = 0 then
    if position($a$    'building_id', p_building, 'system_id', s.system_id, 'refine', v_ref,$a$ in d) = 0 then raise exception 'mine_site_state: место правки (now) не найдено'; end if;
    execute replace(d, $a$    'building_id', p_building, 'system_id', s.system_id, 'refine', v_ref,$a$, $b$    'now', now(), 'building_id', p_building, 'system_id', s.system_id, 'refine', v_ref,$b$);
  end if;

  -- напряжение: подстрекатели на участках планеты за сутки
  d := pg_get_functiondef('public.unrest_calc(text,boolean,integer)'::regprocedure);
  if position('Подстрекатели' in d) = 0 then
    if position($a$'Бережная работа на участках', 'value', -2); end if;$a$ in d) = 0 then raise exception 'unrest_calc: место правки не найдено'; end if;
    execute replace(d, $a$'Бережная работа на участках', 'value', -2); end if;$a$, $b$'Бережная работа на участках', 'value', -2); end if;
  if exists (select 1 from spy_ops o where o.target_system = p_system and o.kind = 'strike' and o.result = 'ok' and o.acted_at > now() - interval '24 hours') then
    v_up := v_up + 4; v_rows := v_rows || jsonb_build_object('label', 'Подстрекатели на участках', 'value', 4);
  end if;$b$);
  end if;
end $$;

-- ---------------------------------------------------------------- права и расписание
do $$
declare f text;
begin
  foreach f in array array['mine_max_guards(integer)', 'spy_guards(uuid)', 'mine_task_k(text)', 'spy_night(timestamptz)',
    'spy_chance_known(integer,timestamptz)', 'spy_chance(uuid,integer,timestamptz)', 'spy_jumps(text,text)', 'spy_kind_name(text)',
    'spy_hq_ok(uuid,uuid)', 'spy_site_ops(uuid)', 'spy_resolve(uuid)', 'spy_tick()'] loop
    execute 'revoke all on function public.' || f || ' from public, anon, authenticated';
  end loop;
  foreach f in array array['spy_state()', 'spy_train(uuid)', 'spy_targets(uuid)', 'spy_launch(uuid,uuid,text)',
    'mine_hire(uuid,text,integer)', 'mine_fire(uuid,text,integer)'] loop
    execute 'revoke all on function public.' || f || ' from public, anon';
    execute 'grant execute on function public.' || f || ' to authenticated';
  end loop;
end $$;

select cron.schedule('spy-tick', '* * * * *', $$select public.spy_tick()$$);
