-- Налёты мародёров на участки и цеха — шаг 4б (24.10.2026). План — claude/sabotage-plan.md, раздел «4б».
--
-- Раз в сутки (сутки — от выдачи до выдачи, как у поселений) у планеты с управляющим и участками шанс налёта 30 %,
-- при довольстве ниже 30 — 50 %. Цель — случайный участок или цех планеты, время — случайное в окне налётов
-- (marauder_window_start..end, 18–23 МСК; тот же marauder_raid_slot, что у налётов на поселения).
-- За 30 мин — предупреждение хозяину: сколько налётчиков, сколько охраны на посту. За 3 мин банду видно в сцене.
-- Налётчиков 1 + места/6 (2–4). Защита = охрана на посту (spy_guards: нанятые + «Казармы ополчения») + 1 за «Караул».
-- Защитников не меньше — налёт отбит; иначе шанс 80 % × защита / налётчики.
-- Отбили — 40 кр за налётчика. Нет — смена обрывается (сделанное сохраняется), со склада планеты уходит 20 % ресурса
-- участка (до 60), износ +10 %. Не трогаем: ничьи планеты, аккаунты моложе 7 дней, пустоту, планету в захвате.

insert into public.game_settings (key, value) values
  ('mine_raid_enabled', '1'), ('mine_raid_pct', '30'), ('mine_raid_pct_low', '50'), ('mine_raid_bounty', '40'),
  ('mine_raid_loot_pct', '20'), ('mine_raid_loot_max', '60'), ('mine_raid_wear', '10'), ('mine_raid_approach_min', '3')
on conflict (key) do nothing;

create table if not exists public.mine_raids (
  id uuid primary key default gen_random_uuid(),
  system_id text not null,
  cycle date not null,                            -- сутки сервера (от выдачи до выдачи)
  building_id uuid,
  status text not null,                           -- none (налёта нет) | plan | warned | done
  raid_at timestamptz,
  n integer,
  seed integer not null default floor(random() * 1000000000)::integer,
  acted_at timestamptz,
  result text,                                    -- repelled | lost | void
  defense integer,
  chance integer,
  roll numeric,
  loot integer not null default 0,
  loot_res text,
  bounty integer not null default 0,
  shift_cut boolean not null default false,
  created_at timestamptz not null default now(),
  unique (system_id, cycle)
);
create index if not exists mine_raids_open on public.mine_raids (status) where status in ('plan', 'warned');
create index if not exists mine_raids_building on public.mine_raids (building_id, raid_at desc);
alter table public.mine_raids enable row level security;

insert into public.event_types (type, category, title, tone, jumpable) values
  ('mine_raid_warn', 'combat', 'Банда идёт к участку', 'warn', true),
  ('mine_raid_repelled', 'combat', 'Налёт отбит', 'good', true),
  ('mine_raid_lost', 'combat', 'Налёт на участок', 'bad', true)
on conflict (type) do nothing;

-- ---------------------------------------------------------------- сутки и защита
create or replace function public.mine_raid_cycle(p_at timestamptz) returns date
language sql stable set search_path to 'public', 'pg_temp' as $$
  select ((p_at at time zone server_tz()) - make_interval(hours => game_setting_int('payout_hour', 4)))::date;
$$;

-- защитники участка сейчас: охрана на посту и караул бригады
create or replace function public.mine_raid_defense(p_building uuid) returns integer
language sql stable set search_path to 'public', 'pg_temp' as $$
  select coalesce(spy_guards(p_building), 0)
       + case when exists (select 1 from mine_shifts sh where sh.building_id = p_building and sh.status = 'run' and sh.task = 'guard') then 1 else 0 end;
$$;

create or replace function public.mine_raid_chance(p_defense integer, p_n integer) returns integer
language sql immutable set search_path to 'public', 'pg_temp' as $$
  select case when coalesce(p_defense, 0) >= greatest(1, p_n) then 100
              else round(80.0 * greatest(0, coalesce(p_defense, 0)) / greatest(1, p_n))::integer end;
$$;

-- ---------------------------------------------------------------- для окна участка
-- Налёт виден с предупреждения (за marauder_warn_minutes до начала) и сутки после
create or replace function public.mine_site_raids(p_building uuid) returns jsonb
language sql stable security definer set search_path to 'public', 'pg_temp' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', r.id, 'raid_at', r.raid_at, 'approach_at', r.raid_at - make_interval(mins => game_setting_int('mine_raid_approach_min', 3)),
           'n', r.n, 'seed', r.seed, 'acted_at', r.acted_at, 'result', r.result, 'defense', r.defense, 'chance', r.chance,
           'loot', r.loot, 'loot_res', r.loot_res, 'bounty', r.bounty, 'shift_cut', r.shift_cut)
         order by r.raid_at desc), '[]'::jsonb)
    from mine_raids r
   where r.building_id = p_building and r.status <> 'none' and r.result is distinct from 'void'
     and r.raid_at - make_interval(mins => game_setting_int('marauder_warn_minutes', 30)) <= now()
     and r.raid_at > now() - interval '24 hours';
$$;

-- ---------------------------------------------------------------- налёт
create or replace function public.mine_raid_resolve(p_raid uuid) returns void
language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare r mine_raids; s mine_sites; v_ctl uuid; v_fac text; v_bname text; v_slot integer; v_bfac text;
  v_def integer; v_ch integer; v_roll numeric; v_sh mine_shifts; v_have integer; v_take integer := 0; v_bounty integer := 0;
  v_meta jsonb; v_rname text;
begin
  select * into r from mine_raids where id = p_raid and status in ('plan', 'warned') for update;
  if not found then return; end if;
  select * into s from mine_sites where building_id = r.building_id for update;
  select sc.controller_user_id, sy.faction into v_ctl, v_fac from systems sy left join system_control sc on sc.system_id = sy.id where sy.id = r.system_id;
  select bd.slot_index, bt.name, bd.faction into v_slot, v_bname, v_bfac
    from buildings bd join building_types bt on bt.id = bd.building_type_id where bd.id = r.building_id;

  -- цели больше нет, планета ничья или чужая, идёт захват — налёта не было
  if s.building_id is null or s.gone or v_slot is null or v_ctl is null or v_bfac is distinct from v_fac or is_capture_active(r.system_id) then
    update mine_raids set status = 'done', result = 'void', acted_at = now() where id = p_raid;
    return;
  end if;

  v_def := mine_raid_defense(r.building_id);
  v_ch := mine_raid_chance(v_def, r.n);
  v_roll := random() * 100;
  v_meta := jsonb_build_object('slot', v_slot, 'building_id', r.building_id, 'raid', r.id);

  if v_roll < v_ch then
    v_bounty := game_setting_int('mine_raid_bounty', 40) * r.n;
    update profiles set credits = credits + v_bounty where id = v_ctl;
    update mine_raids set status = 'done', result = 'repelled', acted_at = now(), defense = v_def, chance = v_ch, roll = v_roll, bounty = v_bounty
     where id = p_raid;
    perform log_event(v_ctl, v_fac, r.system_id, 'mine_raid_repelled',
      v_bname || ': охрана отбила налёт — ' || ru_plural(r.n, 'налётчик', 'налётчика', 'налётчиков') || ' · +' || v_bounty || ' кр.',
      v_bounty, 'private', v_meta);
    return;
  end if;

  -- не отбили: бригада бросает смену, банда выносит часть ресурса участка со склада планеты, ломает оборудование
  select * into v_sh from mine_shifts where building_id = r.building_id and status = 'run';
  if v_sh.id is not null then perform mine_finish(v_sh.id, 'stopped'); end if;
  select coalesce(amount, 0) into v_have from planet_stock where system_id = r.system_id and resource = s.resource for update;
  v_take := least(game_setting_int('mine_raid_loot_max', 60), floor(coalesce(v_have, 0) * game_setting_int('mine_raid_loot_pct', 20) / 100.0))::integer;
  if v_take > 0 then update planet_stock set amount = amount - v_take where system_id = r.system_id and resource = s.resource; end if;
  update mine_sites set wear = least(100, wear + game_setting_int('mine_raid_wear', 10)) where building_id = r.building_id;
  select name into v_rname from resources where id = s.resource;
  update mine_raids set status = 'done', result = 'lost', acted_at = now(), defense = v_def, chance = v_ch, roll = v_roll,
                        loot = v_take, loot_res = case when v_take > 0 then s.resource end, shift_cut = v_sh.id is not null
   where id = p_raid;
  perform log_event(v_ctl, v_fac, r.system_id, 'mine_raid_lost',
    v_bname || ': банда ушла с добычей' || case when v_take > 0 then ' — −' || v_take || ' ' || lower(coalesce(v_rname, s.resource)) else '' end
      || case when v_sh.id is not null then ', смена оборвана' else '' end || ', износ +' || game_setting_int('mine_raid_wear', 10) || ' %',
    v_take, 'private', v_meta);
end;
$$;

-- ---------------------------------------------------------------- тик (раз в минуту)
create or replace function public.mine_raid_tick() returns void
language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare r record; v_cycle date := mine_raid_cycle(now()); v_pct integer; v_b uuid; v_places integer; v_at timestamptz;
  v_bname text; v_slot integer; v_warn integer := game_setting_int('marauder_warn_minutes', 30);
begin
  if game_setting_int('mine_raid_enabled', 1) = 0 then return; end if;

  -- план на сутки: один бросок на планету; нет налёта — строка «none», чтобы не бросать снова
  for r in select sy.id, sc.controller_user_id from systems sy join system_control sc on sc.system_id = sy.id
            join profiles pr on pr.id = sc.controller_user_id
           where sc.controller_user_id is not null and sy.faction is not null and not sy.is_deep_space
             and pr.created_at < now() - interval '7 days'
             and exists (select 1 from mine_sites ms join buildings bd on bd.id = ms.building_id
                          where ms.system_id = sy.id and not ms.gone and bd.faction is not distinct from sy.faction)
             and not exists (select 1 from mine_raids mr where mr.system_id = sy.id and mr.cycle = v_cycle) loop
    begin
      v_pct := case when settlement_effective(r.id) < 30 then game_setting_int('mine_raid_pct_low', 50) else game_setting_int('mine_raid_pct', 30) end;
      v_at := marauder_raid_slot(now());
      if v_at is null or random() * 100 >= v_pct then
        insert into mine_raids (system_id, cycle, status) values (r.id, v_cycle, 'none') on conflict (system_id, cycle) do nothing;
        continue;
      end if;
      select ms.building_id, ms.places into v_b, v_places from mine_sites ms join buildings bd on bd.id = ms.building_id join systems sy on sy.id = ms.system_id
       where ms.system_id = r.id and not ms.gone and bd.faction is not distinct from sy.faction order by random() limit 1;
      insert into mine_raids (system_id, cycle, building_id, status, raid_at, n)
      values (r.id, v_cycle, v_b, 'plan', v_at, 1 + ceil(coalesce(v_places, 6) / 6.0)::integer)
      on conflict (system_id, cycle) do nothing;
    exception when others then perform err_db('mine_raid_tick', sqlstate, sqlerrm, true); end;
  end loop;

  -- предупреждение хозяину за полчаса
  for r in select mr.* from mine_raids mr where mr.status = 'plan' and now() >= mr.raid_at - make_interval(mins => v_warn) and now() < mr.raid_at loop
    begin
      update mine_raids set status = 'warned' where id = r.id;
      select bd.slot_index, bt.name into v_slot, v_bname from buildings bd join building_types bt on bt.id = bd.building_type_id where bd.id = r.building_id;
      if v_slot is not null then
        perform log_event(sc.controller_user_id, sy.faction, r.system_id, 'mine_raid_warn',
          v_bname || ': ' || ru_plural(r.n, 'налётчик', 'налётчика', 'налётчиков') || ' будут около ' || marauder_hhmm(r.raid_at)
            || ' · защитников на посту: ' || mine_raid_defense(r.building_id),
          r.n, 'private', jsonb_build_object('slot', v_slot, 'building_id', r.building_id, 'raid', r.id, 'raid_at', r.raid_at))
          from systems sy join system_control sc on sc.system_id = sy.id where sy.id = r.system_id and sc.controller_user_id is not null;
      end if;
    exception when others then perform err_db('mine_raid_tick', sqlstate, sqlerrm, true); end;
  end loop;

  -- налёт
  for r in select id from mine_raids where status in ('plan', 'warned') and now() >= raid_at order by raid_at loop
    begin perform mine_raid_resolve(r.id);
    exception when others then perform err_db('mine_raid_tick', sqlstate, sqlerrm, true); end;
  end loop;
end;
$$;

-- ---------------------------------------------------------------- окно участка: налёты в состоянии
do $$
declare d text;
begin
  d := pg_get_functiondef('public.mine_site_state(uuid)'::regprocedure);
  if position('mine_site_raids' in d) = 0 then
    if position($a$'ops', spy_site_ops(p_building),$a$ in d) = 0 or position($a$'hire_t', round($a$ in d) = 0 then
      raise exception 'mine_site_state: место правки (налёты) не найдено';
    end if;
    d := replace(d, $a$'ops', spy_site_ops(p_building),$a$, $b$'ops', spy_site_ops(p_building), 'raids', mine_site_raids(p_building),$b$);
    d := replace(d, $a$'hire_t', round($a$, $b$'raid', jsonb_build_object('bounty', game_setting_int('mine_raid_bounty', 40), 'loot_pct', game_setting_int('mine_raid_loot_pct', 20),
        'loot_max', game_setting_int('mine_raid_loot_max', 60), 'wear', game_setting_int('mine_raid_wear', 10)),
      'hire_t', round($b$);
    execute d;
  end if;
end $$;

-- ---------------------------------------------------------------- права и расписание
do $$
declare f text;
begin
  foreach f in array array['mine_raid_cycle(timestamptz)', 'mine_raid_defense(uuid)', 'mine_raid_chance(integer,integer)',
    'mine_site_raids(uuid)', 'mine_raid_resolve(uuid)', 'mine_raid_tick()'] loop
    execute 'revoke all on function public.' || f || ' from public, anon, authenticated';
  end loop;
end $$;

select cron.schedule('mine-raid-tick', '* * * * *', $$select public.mine_raid_tick()$$);
