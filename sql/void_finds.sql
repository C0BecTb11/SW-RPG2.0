-- Находки в Пустоте (27.10.2026). План — claude/void-finds-plan.md в проекте.
--
-- Раз в 3,5–7 суток, вечером, в узле Пустоты на фронте появляется находка. Её стерегут NPC (пираты —
-- в бою 2.0 третья сторона, живут в комнате орбиты, здесь — только их корпус и место). Охрана разбита —
-- открыто удержание: в зоне находки корабли одной фракции — её счётчик растёт, обеих — «спорная зона».
-- Кто первым наберёт 3 часа — забирает находку: кредиты и груз участникам по их времени в зоне, эффекты фракции.
-- Не забрали за 48 ч — находка потеряна.
--
-- Такт void-find-tick раз в минуту. Повторный запуск файла безопасен.

-- ---------------------------------------------------------------- таблицы
create table if not exists public.void_find_types (
  id text primary key,
  title text not null,
  glyph text not null,
  art text not null check (art in ('wreck', 'holocron', 'beacon', 'cache')),
  text text not null,
  guard_name text not null,
  guards jsonb not null,            -- [{cls, name, lead}]
  reward jsonb not null,            -- {credits, cargo: {ресурс: сколько}, effects: [{kind, value, hours}]}
  weight integer not null default 10,
  active boolean not null default true
);

create table if not exists public.void_finds (
  id uuid primary key default gen_random_uuid(),
  type_id text not null references public.void_find_types(id),
  system_id text not null references public.systems(id),
  near text[] not null,             -- планеты по концам гиперпути
  status text not null default 'active' check (status in ('active', 'won', 'lost')),
  started_at timestamptz not null default now(),
  ends_at timestamptz not null,
  cx integer not null, cy integer not null, r integer not null,   -- середина и радиус зоны, клетки орбиты
  guards jsonb not null default '[]'::jsonb,                      -- [{i, cls, name, lead, hp 0..1, x, y, hd}] — метры боя
  guards_down_at timestamptz,
  hold_rep integer not null default 0,                            -- секунды удержания
  hold_cis integer not null default 0,
  holder text check (holder in ('republic', 'cis', 'contested')),
  holder_since timestamptz,
  noted jsonb not null default '{}'::jsonb,                       -- когда кому уже писали про удержание
  tick_at timestamptz not null default now(),
  winner text, ended_at timestamptz,
  result jsonb,
  dev boolean not null default false
);
create unique index if not exists void_finds_one_active on public.void_finds (system_id) where status = 'active';
create index if not exists void_finds_status on public.void_finds (status, ends_at);

create table if not exists public.void_find_holders (
  find_id uuid not null references public.void_finds(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  faction text not null,
  seconds integer not null default 0,
  primary key (find_id, user_id)
);

create table if not exists public.void_find_fleets (
  find_id uuid not null references public.void_finds(id) on delete cascade,
  commander_id uuid not null references public.commanders(id) on delete cascade,
  arrived_at timestamptz not null default now(),
  primary key (find_id, commander_id)
);

create table if not exists public.void_find_state (
  id integer primary key default 1 check (id = 1),
  next_at timestamptz
);
insert into public.void_find_state (id, next_at) values (1, null) on conflict (id) do nothing;

alter table public.void_find_types enable row level security;
alter table public.void_finds enable row level security;
alter table public.void_find_holders enable row level security;
alter table public.void_find_fleets enable row level security;
alter table public.void_find_state enable row level security;
revoke all on public.void_find_types, public.void_finds, public.void_find_holders, public.void_find_fleets, public.void_find_state from anon, authenticated;

-- ---------------------------------------------------------------- настройки и события ленты
insert into game_settings (key, value) values
  ('void_find_enabled', '1'),
  ('void_find_hold_min', '180'),     -- сколько держать, минут
  ('void_find_hours', '48'),         -- сколько живёт находка
  ('void_find_gap_min', '84'),       -- между находками, часы (1–2 в неделю)
  ('void_find_gap_max', '168'),
  ('void_find_hour_from', '18'),     -- появляется вечером по времени сервера
  ('void_find_hour_to', '21'),
  ('void_find_zone', '15')           -- радиус зоны, клетки (3 км)
on conflict (key) do nothing;

insert into event_types (type, category, title, tone, jumpable) values
  ('void_find_new',    'faction', 'Находка в Пустоте',          'neutral', true),
  ('void_find_guards', 'combat',  'Охрана находки разбита',     'good',    true),
  ('void_find_hold',   'combat',  'Удержание находки',          'warn',    true),
  ('void_find_won',    'faction', 'Находка забрана',            'good',    true),
  ('void_find_lost',   'faction', 'Находка потеряна',           'bad',     true),
  ('void_find_reward', 'income',  'Награда за находку',         'good',    true),
  ('void_find_fleet',  'combat',  'Флот у находки',             'neutral', true)
on conflict (type) do update set category = excluded.category, title = excluded.title, tone = excluded.tone, jumpable = excluded.jumpable;

-- ---------------------------------------------------------------- каталог
insert into public.void_find_types (id, title, glyph, art, text, guard_name, guards, reward, weight) values
  ('wreck', 'Обломки дредноута', '⚙', 'wreck',
   'В Пустоте дрейфует остов дредноута времён Старой Республики. Броня и электроника целы — если успеть поднять их на борт раньше других.',
   'Мусорщики Хондо Онаки',
   '[{"cls":"hardcell","name":"Ржавый коготь","lead":true},{"cls":"tantive","name":"Удача Вигу"},{"cls":"tantive","name":"Шальная звезда"}]',
   '{"credits":1500,"cargo":{"durasteel":300,"electronics":150}}', 10),
  ('holocron', 'Голокрон Предтеч', '◆', 'holocron',
   'Сканеры засекли древний голокрон в обломках разведчика. Знания Предтеч ускорят верфи и казармы всей стороны.',
   'Охотники за реликвиями',
   '[{"cls":"cis_diamond","name":"Жадный алмаз","lead":true},{"cls":"tantive","name":"Тихий охотник"},{"cls":"hardcell","name":"Скупщик"}]',
   '{"credits":1000,"effects":[{"kind":"hire_time","value":-15,"hours":72},{"kind":"build_time","value":-15,"hours":72}]}', 8),
  ('beacon', 'Сигнал бедствия', '✚', 'beacon',
   'Маяк спасательной капсулы зовёт на помощь: на борту — сенатор и казна его миссии. Пираты уже рядом.',
   'Пираты «Чёрного солнца»',
   '[{"cls":"rep_arquitens","name":"Чёрный клинок","lead":true},{"cls":"tantive","name":"Тень Вигу"},{"cls":"tantive","name":"Ночной гость"}]',
   '{"credits":2500,"effects":[{"kind":"mood","value":5,"hours":48}]}', 8),
  ('cache', 'Тайник контрабандистов', '▣', 'cache',
   'Контрабандисты бросили грузовой контейнер у гиперпути: тибанна, кристаллы, топливные ячейки. Хатты прислали за ним наёмников.',
   'Наёмники хаттов',
   '[{"cls":"munificent","name":"Слизень Дурги","lead":true},{"cls":"hardcell","name":"Долговая яма"},{"cls":"tantive","name":"Быстрый Рорк"}]',
   '{"credits":1200,"cargo":{"gas":200,"crystals":150,"cells":150}}', 10)
on conflict (id) do update set title = excluded.title, glyph = excluded.glyph, art = excluded.art, text = excluded.text,
  guard_name = excluded.guard_name, guards = excluded.guards, reward = excluded.reward, weight = excluded.weight;

-- ---------------------------------------------------------------- помощники
-- Открыта ли находка в узле (в него можно лететь целью — convoy_route_to)
create or replace function public.void_find_open(p_system text)
 returns boolean
 language sql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
  select exists (select 1 from void_finds f where f.system_id = p_system and f.status = 'active' and f.ends_at > now());
$function$;

-- Время по-человечески: «2 ч 10 мин»
create or replace function public.void_find_dur(p_sec integer)
 returns text
 language sql
 immutable
 set search_path to 'public', 'pg_temp'
as $function$
  select case when greatest(0, p_sec) >= 3600
              then (greatest(0, p_sec) / 3600) || ' ч' || case when (greatest(0, p_sec) % 3600) / 60 > 0 then ' ' || (greatest(0, p_sec) % 3600) / 60 || ' мин' else '' end
              else greatest(1, greatest(0, p_sec) / 60) || ' мин' end;
$function$;

-- Строка в ленту всем, кто играл за последние 3 дня (p_faction — только этой стороне)
create or replace function public.void_find_notify(p_type text, p_system text, p_subject text, p_meta jsonb, p_faction text default null)
 returns integer
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare p record; n integer := 0;
begin
  for p in
    select pf.id, pf.faction from profiles pf
    where pf.faction in ('republic', 'cis') and (p_faction is null or pf.faction = p_faction)
      and pf.last_seen_at > now() - interval '3 days'
  loop
    perform log_event(p.id, p.faction, p_system, p_type, p_subject, 0, 'private', p_meta);
    n := n + 1;
  end loop;
  return n;
end $function$;

-- Сколько кораблей каждой стороны (и чьих) в зоне находки: середина корабля в круге
create or replace function public.void_find_in_zone(p_find uuid)
 returns table (user_id uuid, faction text, ships integer)
 language sql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
  select s.owner_user_id, s.faction, count(*)::integer
  from void_finds f
  join ships s on s.system_id = f.system_id and not s.in_transit and s.carrier_ship_id is null
  join ship_types t on t.id = s.ship_type and not coalesce(t.is_fighter, false)
  where f.id = p_find
    and power(s.x + ship_box_w(t.width_cells, t.height_cells, s.facing) / 2.0 - (f.cx + 0.5), 2)
      + power(s.y + ship_box_h(t.width_cells, t.height_cells, s.facing) / 2.0 - (f.cy + 0.5), 2) <= power(f.r, 2)
  group by s.owner_user_id, s.faction;
$function$;

-- Ближайший вечер (окно void_find_hour_from..to по времени сервера) не раньше p_after, минута — случайная
create or replace function public.void_find_next_at(p_after timestamptz)
 returns timestamptz
 language plpgsql
 volatile
 set search_path to 'public', 'pg_temp'
as $function$
declare
  tz text := event_tz();
  h0 integer := least(23, greatest(0, game_setting_int('void_find_hour_from', 18)));
  h1 integer := least(24, greatest(h0 + 1, game_setting_int('void_find_hour_to', 21)));
  d date := (p_after at time zone tz)::date;
  t timestamptz;
begin
  for k in 0 .. 2 loop
    t := ((d + k)::timestamp + make_interval(mins => (h0 * 60 + floor(random() * (h1 - h0) * 60))::integer)) at time zone tz;
    if t >= p_after then return t; end if;
  end loop;
  return p_after + interval '1 day';
end $function$;

-- ---------------------------------------------------------------- флот: к находке или к гиперлинии
-- Как выход рейса к гиперлинии (supply_fleet_to_zone): в живой орбите — приказ серверу боя (rt_space_orders),
-- иначе автоход. К находке — места в зоне на своей половине (Республика приходит сверху, КНС — снизу),
-- не ближе 7 клеток к живой охране. Возвращает 'ready' (уже там), 'moving' или 'blocked:<причина>'.
create or replace function public.void_find_move(p_find uuid, p_commander uuid, p_to text)
 returns text
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  f record; cm record; v_fac text; v_side text; v_here text; v_label text; v_live boolean;
  v_grid int := game_setting_int('space_grid_cells', 150);
  v_zh int := game_setting_int('hyperspace_zone_height', 14);
  s record; c record; g jsonb; v_w int; v_h int; v_l int; v_mr int; v_tx int; v_ty int; v_found boolean;
  v_txa int[] := '{}'; v_tya int[] := '{}'; v_twa int[] := '{}'; v_tha int[] := '{}';
  v_gx numeric[] := '{}'; v_gy numeric[] := '{}';
  v_zx numeric; v_zy numeric; v_fy numeric; v_y0 int; v_y1 int; v_mid int; v_d int; v_cx int; v_cy int; v_rows int[];
  v_path jsonb; v_group uuid; v_new uuid[] := '{}'; v_id uuid; v_n int := 0; v_out int := 0; a uuid;
begin
  select * into f from void_finds where id = p_find;
  select * into cm from commanders where id = p_commander;
  -- к гиперлинии можно и от закрытой находки: флоту надо как-то улететь домой
  if f.id is null or (f.status <> 'active' and p_to <> 'band') or cm.id is null or cm.moving_to is not null
     or cm.current_system is distinct from f.system_id then return 'ready'; end if;
  v_here := f.system_id;
  select p.faction into v_fac from profiles p where p.id = cm.user_id;
  v_side := hyperspace_side(v_here, v_fac);
  v_label := case when p_to = 'band' then 'К гиперлинии' else 'К находке' end;
  v_zx := f.cx + 0.5; v_zy := f.cy + 0.5;
  -- середина своей половины зоны: туда флот и встаёт, лицом к чужой
  v_fy := case when v_side = 'top' then v_zy - f.r * 0.45 else v_zy + f.r * 0.45 end;

  v_live := exists (select 1 from ships sh where sh.commander_id = cm.id and sh.system_id = v_here
                     and not sh.in_transit and sh.carrier_ship_id is null and rt_obj_busy_2_0('ship', sh.id) is not null);

  if f.guards_down_at is null then
    for g in select value from jsonb_array_elements(f.guards) loop
      continue when coalesce((g ->> 'hp')::numeric, 0) <= 0;
      v_gx := v_gx || ((g ->> 'x')::numeric / 200); v_gy := v_gy || ((g ->> 'y')::numeric / 200);
    end loop;
  end if;

  -- прежний наш приказ этому флоту (к находке или к гиперлинии) снимаем: новый важнее
  update auto_moves am set status = 'stopped', stop_reason = 'cancelled', updated_at = now()
   where am.status = 'active' and am.label in ('К находке', 'К гиперлинии')
     and am.ship_id in (select sh.id from ships sh where sh.commander_id = cm.id);

  if not v_live then
    begin
      perform 1 from ships sh where sh.commander_id = cm.id and sh.system_id = v_here
        and not sh.in_transit and sh.carrier_ship_id is null order by sh.id for update nowait;
    exception when lock_not_available then
      return 'blocked:Корабли заняты другим приказом — попробуй через минуту';
    end;
  end if;

  for s in
    select sh.id, sh.x, sh.y, sh.facing, t.width_cells as tw, t.height_cells as th
    from ships sh join ship_types t on t.id = sh.ship_type
    where sh.commander_id = cm.id and sh.system_id = v_here and not sh.in_transit and sh.carrier_ship_id is null
    order by case when p_to = 'band' then (case when v_side = 'top' then sh.y else -sh.y end)
                  else power(sh.x - v_zx, 2) + power(sh.y - v_zy, 2) end, sh.id
  loop
    v_w := ship_box_w(s.tw, s.th, s.facing);
    v_h := ship_box_h(s.tw, s.th, s.facing);
    v_l := greatest(s.tw, s.th);
    -- уже на месте
    if p_to = 'band' then
      continue when is_in_hyperspace_zone(s.y, v_h, v_side);
    else
      continue when power(s.x + v_w / 2.0 - v_zx, 2) + power(s.y + v_h / 2.0 - v_zy, 2) <= power(f.r - 1, 2);
    end if;
    v_out := v_out + 1;
    select ss.move_range into v_mr from ship_stats(s.id) ss;
    v_mr := greatest(1, coalesce(v_mr, 1));

    v_found := false;
    if p_to = 'band' then
      if v_side = 'top' then v_y0 := 0; v_y1 := v_zh - v_l; else v_y0 := v_grid - v_zh; v_y1 := v_grid - v_l; end if;
      continue when v_y1 < v_y0;
      v_mid := (v_y0 + v_y1) / 2;
      select array_agg(gg order by abs(gg - v_mid), gg) into v_rows from generate_series(v_y0, v_y1) gg;
      <<band>>
      for v_d in 0 .. least(v_grid, 80) loop
        foreach v_cy in array v_rows loop
          foreach v_cx in array array[least(greatest(0, s.x - v_d), v_grid - v_l), least(greatest(0, s.x + v_d), v_grid - v_l)] loop
            if automove_box_ok('space', v_here, s.id, v_cx, v_cy, v_l, v_l, v_fac, false)
               and not exists (select 1 from unnest(v_txa, v_tya, v_twa, v_tha) e(ex, ey, ew, eh)
                               where boxes_overlap(v_cx, v_cy, v_l, v_l, e.ex, e.ey, e.ew, e.eh)) then
              v_tx := v_cx; v_ty := v_cy; v_found := true;
              exit band;
            end if;
          end loop;
        end loop;
        exit when v_d > 0 and s.x - v_d <= 0 and s.x + v_d >= v_grid - v_l;
      end loop;
    else
      for c in
        select gx, gy
        from generate_series(greatest(0, floor(v_zx - f.r - v_l)::int), least(v_grid - v_l, ceil(v_zx + f.r)::int)) gx,
             generate_series(greatest(0, floor(v_zy - f.r - v_l)::int), least(v_grid - v_l, ceil(v_zy + f.r)::int)) gy
        where power(gx + v_l / 2.0 - v_zx, 2) + power(gy + v_l / 2.0 - v_zy, 2) <= power(f.r - 2, 2)
          and (case when v_side = 'top' then gy + v_l / 2.0 <= v_zy - 1 else gy + v_l / 2.0 >= v_zy + 1 end)
          and not exists (select 1 from unnest(v_gx, v_gy) q(qx, qy)
                          where power(gx + v_l / 2.0 - q.qx, 2) + power(gy + v_l / 2.0 - q.qy, 2) < 49)
        order by power(gx + v_l / 2.0 - v_zx, 2) * 0.35 + power(gy + v_l / 2.0 - v_fy, 2), gx
      loop
        if automove_box_ok('space', v_here, s.id, c.gx, c.gy, v_l, v_l, v_fac, false)
           and not exists (select 1 from unnest(v_txa, v_tya, v_twa, v_tha) e(ex, ey, ew, eh)
                           where boxes_overlap(c.gx, c.gy, v_l, v_l, e.ex, e.ey, e.ew, e.eh)) then
          v_tx := c.gx; v_ty := c.gy; v_found := true;
          exit;
        end if;
      end loop;
    end if;
    continue when not v_found;

    if v_live then
      v_txa := v_txa || v_tx; v_tya := v_tya || v_ty; v_twa := v_twa || v_l; v_tha := v_tha || v_l;
      insert into rt_space_orders (ship_id, system_id, x, y, reason, created_at, taken_at)
      values (s.id, v_here, round((v_tx + v_l / 2.0) * 200)::int, round((v_ty + v_l / 2.0) * 200)::int, 'find', now(), null)
      on conflict (ship_id) do update set system_id = excluded.system_id, x = excluded.x, y = excluded.y,
                                          reason = excluded.reason, created_at = now(), taken_at = null;
      v_n := v_n + 1;
      continue;
    end if;

    v_path := automove_route('space', v_here, s.x, s.y, v_tx, v_ty, v_w, v_h, v_mr, v_fac, false);
    continue when jsonb_array_length(v_path) = 0;

    v_txa := v_txa || v_tx; v_tya := v_tya || v_ty; v_twa := v_twa || v_l; v_tha := v_tha || v_l;
    if v_group is null then v_group := gen_random_uuid(); end if;
    v_id := null;
    begin
      insert into auto_moves (owner_user_id, system_id, layer, ship_id, group_id, target_x, target_y, path,
                              step_range, member_idx, faction, label, status)
      values (cm.user_id, v_here, 'space', s.id, v_group, v_tx, v_ty, v_path, v_mr, v_n, v_fac, v_label, 'active')
      returning id into v_id;
    exception when others then
      if sqlerrm not like '%в бою 2.0%' then raise; end if;
    end;
    if v_id is not null then v_new := v_new || v_id; end if;
    v_n := v_n + 1;
  end loop;

  if v_out = 0 then return 'ready'; end if;
  if v_n = 0 then
    return 'blocked:' || case when p_to = 'band' then 'В полосе прыжка нет свободного места или к ней нет пути'
                              else 'У находки нет свободного места или к ней нет пути' end;
  end if;

  foreach a in array v_new loop
    begin
      perform automove_step(a);
    exception when others then perform err_db('void_find_move', sqlstate, sqlerrm, true);
    end;
  end loop;
  return 'moving';
end $function$;

-- ---------------------------------------------------------------- появление
-- p_type / p_system — для DEV (иначе — по весам и любой узел фронта). Возвращает id или null (некуда).
create or replace function public.void_find_spawn(p_type text default null, p_system text default null, p_dev boolean default false)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  t void_find_types; v_sys text; v_near text[]; v_grid int := game_setting_int('space_grid_cells', 150);
  v_c int; v_r int := greatest(6, game_setting_int('void_find_zone', 15)); v_n int; v_g jsonb := '[]'::jsonb;
  g jsonb; i int := 0; v_ang numeric; v_rad numeric; v_id uuid; v_names text;
begin
  if p_type is not null then
    select * into t from void_find_types where id = p_type and active;
    if not found then raise exception 'Нет такой находки'; end if;
  else
    select * into t from void_find_types vt
    where vt.active and vt.id is distinct from (select type_id from void_finds order by started_at desc limit 1)
    order by -ln(random()) / greatest(vt.weight, 1) limit 1;
    if not found then return null; end if;
  end if;

  -- узел Пустоты на фронте: одним концом к Республике, другим к КНС; недавние узлы — в последнюю очередь
  select s.id into v_sys
  from systems s
  where s.is_deep_space and (p_system is null or s.id = p_system)
    and not exists (select 1 from void_finds f where f.system_id = s.id and f.status = 'active')
    and (p_system is not null or (
         exists (select 1 from hyperlanes h join systems a on a.id = case when h.system_a = s.id then h.system_b else h.system_a end
                 where (h.system_a = s.id or h.system_b = s.id) and not a.is_deep_space and a.faction = 'republic')
     and exists (select 1 from hyperlanes h join systems a on a.id = case when h.system_a = s.id then h.system_b else h.system_a end
                 where (h.system_a = s.id or h.system_b = s.id) and not a.is_deep_space and a.faction = 'cis')))
  order by (select count(*) from void_finds f where f.system_id = s.id and f.started_at > now() - interval '21 days'), random()
  limit 1;
  if v_sys is null then return null; end if;

  select coalesce(array_agg(a.id order by a.faction, a.id), '{}') into v_near
  from hyperlanes h join systems a on a.id = case when h.system_a = v_sys then h.system_b else h.system_a end
  where (h.system_a = v_sys or h.system_b = v_sys) and not a.is_deep_space;

  -- охрана кольцом вокруг находки: вожак ближе, сопровождение дальше; нос — наружу
  v_c := v_grid / 2;
  v_n := jsonb_array_length(t.guards);
  for g in select value from jsonb_array_elements(t.guards) loop
    v_ang := pi() / 2 + i * 2 * pi() / greatest(1, v_n) + pi() / 6;
    v_rad := case when coalesce((g ->> 'lead')::boolean, false) then 700 else 1700 end;
    v_g := v_g || jsonb_build_object('i', i, 'cls', g ->> 'cls', 'name', g ->> 'name', 'lead', coalesce((g ->> 'lead')::boolean, false),
                                     'hp', 1, 'x', round((v_c + 0.5) * 200 + cos(v_ang) * v_rad), 'y', round((v_c + 0.5) * 200 + sin(v_ang) * v_rad),
                                     'hd', round(v_ang::numeric, 3),
                                     -- пост: куда охрана возвращается (x/y/hd бой переписывает, пост — нет)
                                     'px', round((v_c + 0.5) * 200 + cos(v_ang) * v_rad), 'py', round((v_c + 0.5) * 200 + sin(v_ang) * v_rad),
                                     'phd', round(v_ang::numeric, 3));
    i := i + 1;
  end loop;

  insert into void_finds (type_id, system_id, near, ends_at, cx, cy, r, guards, dev)
  values (t.id, v_sys, v_near, now() + make_interval(hours => greatest(1, game_setting_int('void_find_hours', 48))),
          v_c, v_c, v_r, v_g, p_dev)
  returning id into v_id;

  select string_agg(a.name, ' — ' order by a.faction desc) into v_names from systems a where a.id = any(v_near);
  perform void_find_notify('void_find_new', v_sys,
    t.title || ' · ' || coalesce(v_names, 'Пустота') || '. Стерегут: ' || t.guard_name,
    jsonb_build_object('find', v_id, 'type', t.id, 'layer', 'space'));
  return v_id;
end $function$;

-- ---------------------------------------------------------------- итог
-- p_winner — сторона, набравшая удержание; null — время вышло, находка потеряна
create or replace function public.void_find_finish(p_find uuid, p_winner text)
 returns void
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  f record; t void_find_types; h record; c record; e jsonb; k text; v_amt int; v_left int; v_total numeric;
  v_share numeric; v_cr int; v_put jsonb; v_lost jsonb; v_rows jsonb := '[]'::jsonb; v_text text;
  v_fname text; v_meta jsonb;
begin
  select * into f from void_finds where id = p_find for update;
  if not found or f.status <> 'active' then return; end if;
  select * into t from void_find_types where id = f.type_id;
  v_meta := jsonb_build_object('find', f.id, 'type', f.type_id, 'layer', 'space');

  -- находка закрывается: флоты в узле сами выходят к гиперлинии — домой (корабли остаются в узле, груз ниже доходит)
  for c in select cm.id from commanders cm where cm.current_system = f.system_id and cm.moving_to is null and cm.unlocked loop
    begin
      perform void_find_move(f.id, c.id, 'band');
    exception when others then perform err_db('void_find_finish', sqlstate, sqlerrm, true);
    end;
  end loop;

  if p_winner is null then
    update void_finds set status = 'lost', ended_at = now(), holder = null where id = f.id;
    perform void_find_notify('void_find_lost', f.system_id,
      t.title || ' — никто не удержал за ' || void_find_dur(extract(epoch from f.ends_at - f.started_at)::int) || '. Находка ушла в Пустоту, флоты выходят к гиперлинии', v_meta);
    return;
  end if;

  v_fname := case p_winner when 'republic' then 'Республика' else 'Конфедерация' end;
  select coalesce(sum(seconds), 0) into v_total from void_find_holders where find_id = f.id and faction = p_winner and seconds > 0;

  for h in
    select hd.user_id, hd.seconds, p.nickname from void_find_holders hd join profiles p on p.id = hd.user_id
    where hd.find_id = f.id and hd.faction = p_winner and hd.seconds > 0 and p.faction = p_winner
    order by hd.seconds desc
  loop
    v_share := case when v_total > 0 then h.seconds / v_total else 1 end;
    v_cr := greatest(50, round(coalesce((t.reward ->> 'credits')::int, 0) * v_share)::int);
    update profiles set credits = credits + v_cr where id = h.user_id;
    v_put := '{}'::jsonb; v_lost := '{}'::jsonb;
    for k, v_amt in select key, round(value::numeric * v_share)::int from jsonb_each_text(coalesce(t.reward -> 'cargo', '{}'::jsonb)) loop
      continue when v_amt <= 0;
      v_left := v_amt;
      for c in select cm.id from commanders cm where cm.user_id = h.user_id and cm.current_system = f.system_id and cm.moving_to is null order by cm.slot_index loop
        exit when v_left <= 0;
        v_left := v_left - supply_put_cargo(c.id, f.system_id, k, v_left);
      end loop;
      if v_amt - v_left > 0 then v_put := v_put || jsonb_build_object(k, v_amt - v_left); end if;
      if v_left > 0 then v_lost := v_lost || jsonb_build_object(k, v_left); end if;
    end loop;
    v_rows := v_rows || jsonb_build_object('user', h.user_id, 'nick', h.nickname, 'seconds', h.seconds, 'credits', v_cr, 'cargo', v_put, 'lost', v_lost);
    v_text := t.title || ' · ' || v_cr || ' кр.'
      || coalesce((select ' · в трюм: ' || string_agg(lower(r.name) || ' ' || x.value, ', ' order by r.sort_order)
                     from jsonb_each_text(v_put) x join resources r on r.id = x.key), '')
      || coalesce((select ' · не влезло: ' || string_agg(lower(r.name) || ' ' || x.value, ', ' order by r.sort_order)
                     from jsonb_each_text(v_lost) x join resources r on r.id = x.key), '');
    perform log_event(h.user_id, p_winner, f.system_id, 'void_find_reward', v_text, 0, 'private',
                      v_meta || jsonb_build_object('credits', v_cr, 'cargo', v_put, 'lost', v_lost, 'seconds', h.seconds));
  end loop;

  for e in select value from jsonb_array_elements(coalesce(t.reward -> 'effects', '[]'::jsonb)) loop
    insert into faction_effects (faction, kind, value, title, source, source_id, starts_at, ends_at, system_id)
    values (p_winner, e ->> 'kind', (e ->> 'value')::int, t.title, 'find:' || f.id, f.id, now(),
            now() + make_interval(hours => greatest(1, (e ->> 'hours')::int)), null);
  end loop;

  update void_finds set status = 'won', winner = p_winner, ended_at = now(), holder = null,
                        result = jsonb_build_object('rows', v_rows)
   where id = f.id;

  perform void_find_notify('void_find_won', f.system_id,
    v_fname || ' забрала «' || t.title || '»' || case when jsonb_array_length(v_rows) > 0
      then ' · держали: ' || (select string_agg(x ->> 'nick', ', ') from jsonb_array_elements(v_rows) x) else '' end,
    v_meta || jsonb_build_object('winner', p_winner));
end $function$;

-- ---------------------------------------------------------------- такт (раз в минуту)
create or replace function public.void_find_tick()
 returns integer
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  st record; f record; t void_find_types; c record; v_need int; v_dt int; v_rep int; v_cis int; v_holder text; v_prev text;
  v_gap numeric; v_n int := 0; v_meta jsonb; v_left int; v_name text; v_res text;
begin
  if not pg_try_advisory_xact_lock(hashtext('void_find_tick')) then return 0; end if;
  if game_setting_int('void_find_enabled', 1) <> 1 then return 0; end if;
  v_need := greatest(1, game_setting_int('void_find_hold_min', 180)) * 60;

  -- 1. появление: по расписанию, одна обычная находка за раз
  select * into st from void_find_state where id = 1 for update;
  if st.next_at is null then
    update void_find_state set next_at = void_find_next_at(now()) where id = 1;
  elsif st.next_at <= now() and not exists (select 1 from void_finds where status = 'active' and not dev) then
    if void_find_spawn(null, null, false) is not null then v_n := v_n + 1; end if;
    v_gap := game_setting_int('void_find_gap_min', 84) + random() * greatest(0, game_setting_int('void_find_gap_max', 168) - game_setting_int('void_find_gap_min', 84));
    update void_find_state set next_at = void_find_next_at(now() + make_interval(hours => v_gap::int)) where id = 1;
  end if;

  -- 2. идущие
  for f in select * from void_finds where status = 'active' order by started_at loop
    if f.ends_at <= now() then perform void_find_finish(f.id, null); continue; end if;
    select * into t from void_find_types where id = f.type_id;
    v_meta := jsonb_build_object('find', f.id, 'type', f.type_id, 'layer', 'space');
    v_dt := least(120, greatest(0, extract(epoch from now() - f.tick_at)::int));

    -- прибывшие флоты сами идут к находке (раз за прилёт); улетевших забываем
    execute 'del' || 'ete from void_find_fleets vf where vf.find_id = $1 and not exists (select 1 from commanders cm '
         || 'where cm.id = vf.commander_id and cm.current_system = $2 and cm.moving_to is null)' using f.id, f.system_id;
    for c in
      select cm.id, cm.user_id, cm.name from commanders cm
      where cm.current_system = f.system_id and cm.moving_to is null and cm.unlocked
        and exists (select 1 from ships s where s.commander_id = cm.id and s.system_id = f.system_id and not s.in_transit and s.carrier_ship_id is null)
        and not exists (select 1 from void_find_fleets vf where vf.find_id = f.id and vf.commander_id = cm.id)
    loop
      -- отметка «обработан» — в том же блоке: упал ход или корабли заняты — повторим на следующем такте
      begin
        insert into void_find_fleets (find_id, commander_id) values (f.id, c.id) on conflict do nothing;
        v_res := void_find_move(f.id, c.id, 'zone');
        if v_res like 'blocked:Корабли заняты%' then
          execute 'del' || 'ete from void_find_fleets where find_id = $1 and commander_id = $2' using f.id, c.id;
          continue;
        end if;
        perform log_event(c.user_id, null, f.system_id, 'void_find_fleet',
          coalesce(c.name, 'Флот') || case when v_res = 'moving' then ' идёт к находке «' || t.title || '»'
                                           when v_res = 'ready' then ' у находки «' || t.title || '»'
                                           else ' прибыл к находке «' || t.title || '» — ' || substr(v_res, 9) end,
          0, 'private', v_meta);
      exception when others then perform err_db('void_find_tick', sqlstate, sqlerrm, true);
      end;
    end loop;

    -- охрана жива: удержания нет
    if f.guards_down_at is null then
      update void_finds set tick_at = now(), holder = null, holder_since = case when holder is null then holder_since else now() end where id = f.id;
      continue;
    end if;

    select coalesce(sum(z.ships) filter (where z.faction = 'republic'), 0), coalesce(sum(z.ships) filter (where z.faction = 'cis'), 0)
      into v_rep, v_cis from void_find_in_zone(f.id) z;
    v_holder := case when v_rep > 0 and v_cis > 0 then 'contested' when v_rep > 0 then 'republic' when v_cis > 0 then 'cis' end;
    v_prev := f.holder;

    if v_holder in ('republic', 'cis') and v_dt > 0 then
      insert into void_find_holders (find_id, user_id, faction, seconds)
      select f.id, z.user_id, z.faction, v_dt from void_find_in_zone(f.id) z where z.faction = v_holder
      on conflict (find_id, user_id) do update set seconds = void_find_holders.seconds + excluded.seconds;
    end if;

    update void_finds set tick_at = now(),
           hold_rep = hold_rep + case when v_holder = 'republic' then v_dt else 0 end,
           hold_cis = hold_cis + case when v_holder = 'cis' then v_dt else 0 end,
           holder = v_holder,
           holder_since = case when holder is distinct from v_holder then now() else holder_since end
     where id = f.id
     returning * into f;

    -- одна сторона встала в зону — обеим в ленту (не чаще раза в 30 минут на сторону)
    if v_holder in ('republic', 'cis') and v_prev is distinct from v_holder
       and coalesce((f.noted ->> v_holder)::timestamptz, now() - interval '1 day') < now() - interval '30 minutes' then
      v_left := v_need - case when v_holder = 'republic' then f.hold_rep else f.hold_cis end;
      v_name := case v_holder when 'republic' then 'Республика' else 'Конфедерация' end;
      perform void_find_notify('void_find_hold', f.system_id,
        'Наши держат «' || t.title || '» — до победы ' || void_find_dur(v_left) || '. Не пускайте врага в зону', v_meta, v_holder);
      perform void_find_notify('void_find_hold', f.system_id,
        v_name || ' держит «' || t.title || '» — через ' || void_find_dur(v_left) || ' находка уйдёт к ней. Встань в зону — удержание остановится', v_meta,
        case v_holder when 'republic' then 'cis' else 'republic' end);
      update void_finds set noted = noted || jsonb_build_object(v_holder, now()) where id = f.id;
    end if;

    if (v_holder = 'republic' and f.hold_rep >= v_need) or (v_holder = 'cis' and f.hold_cis >= v_need) then
      perform void_find_finish(f.id, v_holder);
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end $function$;

-- ---------------------------------------------------------------- для сервера боя
-- Находка в узле — для комнаты орбиты (rt_space_state): зона, охрана, удержание
create or replace function public.void_find_room(p_system text)
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
  select jsonb_build_object('id', f.id, 'type', f.type_id, 'title', t.title, 'glyph', t.glyph, 'art', t.art, 'guard_name', t.guard_name,
                            'cx', f.cx, 'cy', f.cy, 'r', f.r, 'guards', f.guards, 'down', f.guards_down_at is not null,
                            'hold', jsonb_build_object('republic', f.hold_rep, 'cis', f.hold_cis),
                            'need', greatest(1, game_setting_int('void_find_hold_min', 180)) * 60,
                            'holder', f.holder, 'since', f.holder_since, 'tick', f.tick_at, 'ends', f.ends_at, 'now', now())
  from void_finds f join void_find_types t on t.id = f.type_id
  where f.system_id = p_system and f.status = 'active'
  limit 1;
$function$;

-- Сервер боя пишет охрану: корпус (только вниз — гонка записей не лечит пирата), место, разворот.
-- Последний пират погиб — удержание открыто, всем в ленту. Возвращает находку как void_find_room.
create or replace function public.rt_void_sync(p_key text, p_battle uuid, p_find uuid, p_guards jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare f record; t void_find_types;
begin
  perform rt_need_key(p_key);
  select * into f from void_finds where id = p_find and status = 'active' for update;
  if not found then return jsonb_build_object('closed', true); end if;

  update void_finds set guards = (
    select coalesce(jsonb_agg(g || coalesce((
             select jsonb_build_object('hp', least(coalesce((g ->> 'hp')::numeric, 1), greatest(0, least(1, round((u ->> 'hp')::numeric, 3)))),
                                       'x', round((u ->> 'x')::numeric), 'y', round((u ->> 'y')::numeric), 'hd', round((u ->> 'hd')::numeric, 3))
             from jsonb_array_elements(coalesce(p_guards, '[]'::jsonb)) u
             where (u ->> 'i')::int = (g ->> 'i')::int and jsonb_typeof(u -> 'hp') = 'number'
             limit 1), '{}'::jsonb) order by (g ->> 'i')::int), '[]'::jsonb)
    from jsonb_array_elements(f.guards) g)
   where id = f.id
   returning * into f;

  if f.guards_down_at is null and not exists (select 1 from jsonb_array_elements(f.guards) g where (g ->> 'hp')::numeric > 0) then
    update void_finds set guards_down_at = now(), tick_at = now() where id = f.id;
    select * into t from void_find_types where id = f.type_id;
    perform void_find_notify('void_find_guards', f.system_id,
      t.guard_name || ' разбиты у находки «' || t.title || '». Удержание открыто: '
        || void_find_dur(greatest(1, game_setting_int('void_find_hold_min', 180)) * 60) || ' в зоне — и находка ваша',
      jsonb_build_object('find', f.id, 'type', f.type_id, 'layer', 'space'));
  end if;
  return void_find_room(f.system_id);
end $function$;

-- находка — в состояние орбиты для сервера боя
do $do$
declare d text; a text;
begin
  d := pg_get_functiondef('public.rt_space_state(text)'::regprocedure);
  if position('void_find_room' in d) > 0 then return; end if;
  a := $a$'slot', (select jsonb_build_object('x', sl.x, 'y', sl.y, 'size', sl.size) from station_slots sl where sl.system_id = p_system limit 1)$a$;
  if position(a in d) = 0 then raise exception 'rt_space_state: место станции не найдено'; end if;
  d := replace(d, a, a || $a$,
    'find', void_find_room(p_system)$a$);
  execute d;
end $do$;

-- ---------------------------------------------------------------- для окна
create or replace function public.void_find_state_json()
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare v_me uuid := auth.uid(); v_fac text;
begin
  if v_me is null then raise exception 'Нужно войти'; end if;
  select faction into v_fac from profiles where id = v_me;
  return jsonb_build_object(
    'now', now(), 'faction', v_fac, 'need', greatest(1, game_setting_int('void_find_hold_min', 180)) * 60,
    'next', (select next_at from void_find_state where id = 1),
    'active', (select coalesce(jsonb_agg(x order by x ->> 'started'), '[]'::jsonb) from (
      select jsonb_build_object(
        'id', f.id, 'type', f.type_id, 'title', t.title, 'glyph', t.glyph, 'art', t.art, 'text', t.text, 'guard_name', t.guard_name,
        'reward', t.reward, 'system_id', f.system_id, 'system_name', sy.name,
        'pos', jsonb_build_object('x', sy.world_x, 'y', sy.world_y),
        'near', (select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name, 'faction', a.faction) order by a.faction desc), '[]'::jsonb)
                   from systems a where a.id = any(f.near)),
        'started', f.started_at, 'ends', f.ends_at, 'tick', f.tick_at,
        'guards', (select coalesce(jsonb_agg(jsonb_build_object('name', g ->> 'name', 'cls', g ->> 'cls', 'lead', coalesce((g ->> 'lead')::boolean, false),
                                                                'hp', (g ->> 'hp')::numeric, 'type_name', st.name) order by (g ->> 'i')::int), '[]'::jsonb)
                   from jsonb_array_elements(f.guards) g left join ship_types st on st.id = g ->> 'cls'),
        'down', f.guards_down_at,
        'hold', jsonb_build_object('republic', f.hold_rep, 'cis', f.hold_cis),
        'holder', f.holder, 'since', f.holder_since,
        'zone', (select coalesce(jsonb_object_agg(z.faction, z.n), '{}'::jsonb)
                   from (select q.faction, sum(q.ships)::int n from void_find_in_zone(f.id) q group by q.faction) z),
        'here', (select coalesce(jsonb_object_agg(z.faction, z.n), '{}'::jsonb)
                   from (select s.faction, count(*)::int n from ships s join ship_types tt on tt.id = s.ship_type
                         where s.system_id = f.system_id and not s.in_transit and s.carrier_ship_id is null and not coalesce(tt.is_fighter, false)
                           and s.faction = v_fac   -- чужие корабли в узле — только разведкой, не отсюда
                         group by s.faction) z),
        -- свои: кто держал и сколько (чужих имён не видно)
        'mine', (select coalesce(jsonb_agg(jsonb_build_object('nick', p.nickname, 'seconds', h.seconds, 'me', h.user_id = v_me) order by h.seconds desc), '[]'::jsonb)
                   from void_find_holders h join profiles p on p.id = h.user_id
                   where h.find_id = f.id and h.faction = v_fac and h.seconds > 0),
        -- мои командиры: у находки (в зоне или нет) и в пути к ней
        'fleets', (select coalesce(jsonb_agg(jsonb_build_object(
                      'id', cm.id, 'name', cm.name,
                      'state', case when cm.moving_to = f.system_id then 'flying' else 'here' end,
                      'arrives', case when cm.moving_to = f.system_id then cm.arrives_at end,
                      'ships', (select count(*) from ships s where s.commander_id = cm.id and s.carrier_ship_id is null
                                  and (s.system_id = f.system_id or cm.moving_to = f.system_id)),
                      'in_zone', (select count(*) from ships s join ship_types tt on tt.id = s.ship_type
                                  where s.commander_id = cm.id and s.system_id = f.system_id and not s.in_transit and s.carrier_ship_id is null
                                    and power(s.x + ship_box_w(tt.width_cells, tt.height_cells, s.facing) / 2.0 - (f.cx + 0.5), 2)
                                      + power(s.y + ship_box_h(tt.width_cells, tt.height_cells, s.facing) / 2.0 - (f.cy + 0.5), 2) <= power(f.r, 2)),
                      'moving', exists (select 1 from auto_moves am join ships s on s.id = am.ship_id
                                        where s.commander_id = cm.id and am.status = 'active' and am.label in ('К находке', 'К гиперлинии'))
                    ) order by cm.slot_index), '[]'::jsonb)
                   from commanders cm
                   where cm.user_id = v_me and cm.unlocked
                     and (cm.moving_to = f.system_id or (cm.current_system = f.system_id and cm.moving_to is null)))
      ) x
      from void_finds f join void_find_types t on t.id = f.type_id join systems sy on sy.id = f.system_id
      where f.status = 'active' and f.ends_at > now()) q),
    'recent', (select coalesce(jsonb_agg(x order by x ->> 'ended' desc), '[]'::jsonb) from (
      select jsonb_build_object('id', f.id, 'title', t.title, 'glyph', t.glyph, 'status', f.status, 'winner', f.winner, 'ended', f.ended_at,
                                'system_name', sy.name,
                                'mine', (select x2 from jsonb_array_elements(coalesce(f.result -> 'rows', '[]'::jsonb)) x2 where (x2 ->> 'user')::uuid = v_me limit 1)) x
      from void_finds f join void_find_types t on t.id = f.type_id join systems sy on sy.id = f.system_id
      where f.status <> 'active' and f.ended_at > now() - interval '7 days' and not f.dev
      order by f.ended_at desc limit 4) q)
  );
end $function$;

-- Вывести свой флот у находки: к находке ('zone') или к гиперлинии ('band', чтобы улететь)
create or replace function public.void_find_fleet(p_commander uuid, p_to text)
 returns text
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare v_me uuid := auth.uid(); cm record; f record; v text;
begin
  if v_me is null then raise exception 'Нужно войти'; end if;
  if p_to not in ('zone', 'band') then raise exception 'Куда вести флот — к находке или к гиперлинии'; end if;
  select * into cm from commanders where id = p_commander and user_id = v_me;
  if not found then raise exception 'Это не твой командир'; end if;
  if cm.moving_to is not null then raise exception 'Командир в пути'; end if;
  select * into f from void_finds where system_id = cm.current_system and status = 'active';
  -- находка закрыта, флот ещё в узле — к гиперлинии всё равно выведем
  if not found and p_to = 'band' then
    select * into f from void_finds where system_id = cm.current_system order by started_at desc limit 1;
  end if;
  if f.id is null then raise exception 'Здесь нет находки'; end if;
  if exists (select 1 from supply_routes x where x.commander_id = cm.id and x.status = 'active') then
    raise exception 'Командир на рейсе снабжения';
  end if;
  v := void_find_move(f.id, cm.id, p_to);
  if v like 'blocked:%' then raise exception '%', substr(v, 9); end if;
  return v;
end $function$;

-- ---------------------------------------------------------------- DEV
create or replace function public.dev_void_find_start(p_type text default null, p_system text default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare v_me uuid := dev_assert(); v_id uuid;
begin
  v_id := void_find_spawn(nullif(p_type, ''), nullif(p_system, ''), true);
  if v_id is null then raise exception 'Свободного узла на фронте не нашлось'; end if;
  perform dev_note(v_me, 'void_find', null, null, jsonb_build_object('type', p_type, 'find', v_id));
  return jsonb_build_object('id', v_id, 'system', (select system_id from void_finds where id = v_id));
end $function$;

-- p_what: 'guards' — охрана разбита; 'hold:republic' / 'hold:cis' — удержание почти набрано (минута до победы); 'end' — потерять
create or replace function public.dev_void_find_poke(p_find uuid, p_what text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare v_me uuid := dev_assert(); f record; v_need int := greatest(1, game_setting_int('void_find_hold_min', 180)) * 60;
begin
  select * into f from void_finds where id = p_find and status = 'active';
  if not found then raise exception 'Находка уже закрыта'; end if;
  if p_what = 'guards' then
    update void_finds set guards = (select coalesce(jsonb_agg(g || '{"hp":0}'::jsonb order by (g ->> 'i')::int), '[]'::jsonb) from jsonb_array_elements(guards) g),
                          guards_down_at = coalesce(guards_down_at, now()), tick_at = now()
     where id = f.id;
  elsif p_what = 'hold:republic' then
    update void_finds set hold_rep = greatest(hold_rep, v_need - 60), guards_down_at = coalesce(guards_down_at, now()) where id = f.id;
  elsif p_what = 'hold:cis' then
    update void_finds set hold_cis = greatest(hold_cis, v_need - 60), guards_down_at = coalesce(guards_down_at, now()) where id = f.id;
  elsif p_what = 'end' then
    perform void_find_finish(f.id, null);
  else
    raise exception 'Неизвестное действие';
  end if;
  perform dev_note(v_me, 'void_find', null, null, jsonb_build_object('find', f.id, 'what', p_what));
  return void_find_room(f.system_id);
end $function$;

-- ---------------------------------------------------------------- полёт в узел с находкой
-- Цель — узел Пустоты с открытой находкой (только целью: насквозь через Пустоту по-прежнему не летают)
do $do$
declare d text; a text;
begin
  d := pg_get_functiondef('public.convoy_route_to(text, text, text)'::regprocedure);
  if position('void_find_open' in d) > 0 then return; end if;
  a := $a$          and not s.is_deep_space
          and (s.faction = p_faction$a$;
  if position(a in d) = 0 then raise exception 'convoy_route_to: условие не найдено'; end if;
  d := replace(d, a, $a$          and (not s.is_deep_space or (s.id = p_to and void_find_open(p_to)))
          and (s.faction = p_faction$a$);
  execute d;
end $do$;

-- ---------------------------------------------------------------- донесения: эффекты находки — своей меткой
do $do$
declare d text; a text;
begin
  d := pg_get_functiondef('public.report_list()'::regprocedure);
  if position('''find:%''' in d) > 0 then return; end if;
  a := $a$case when fe.source like 'event:%' then 'event' when fe.source = 'decree'$a$;
  if position(a in d) = 0 then raise exception 'report_list: метка не найдена'; end if;
  execute replace(d, a, $a$case when fe.source like 'event:%' then 'event' when fe.source like 'find:%' then 'find' when fe.source = 'decree'$a$);
end $do$;

-- ---------------------------------------------------------------- права и такт
revoke all on function public.void_find_open(text) from public, anon;
grant execute on function public.void_find_open(text) to authenticated;
revoke all on function public.void_find_notify(text, text, text, jsonb, text) from public, anon, authenticated;
revoke all on function public.void_find_in_zone(uuid) from public, anon, authenticated;
revoke all on function public.void_find_next_at(timestamptz) from public, anon, authenticated;
revoke all on function public.void_find_move(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.void_find_spawn(text, text, boolean) from public, anon, authenticated;
revoke all on function public.void_find_finish(uuid, text) from public, anon, authenticated;
revoke all on function public.void_find_tick() from public, anon, authenticated;
revoke all on function public.void_find_room(text) from public, anon, authenticated;
-- сервер боя ходит с ключом (rt_need_key), как к rt_space_sync
revoke all on function public.rt_void_sync(text, uuid, uuid, jsonb) from public;
grant execute on function public.rt_void_sync(text, uuid, uuid, jsonb) to anon, authenticated;
revoke all on function public.void_find_state_json() from public, anon;
grant execute on function public.void_find_state_json() to authenticated;
revoke all on function public.void_find_fleet(uuid, text) from public, anon;
grant execute on function public.void_find_fleet(uuid, text) to authenticated;
revoke all on function public.dev_void_find_start(text, text) from public, anon;
grant execute on function public.dev_void_find_start(text, text) to authenticated;
revoke all on function public.dev_void_find_poke(uuid, text) from public, anon;
grant execute on function public.dev_void_find_poke(uuid, text) to authenticated;

select cron.schedule('void-find-tick', '* * * * *', $$select public.void_find_tick()$$)
where not exists (select 1 from cron.job where jobname = 'void-find-tick');
