-- ⚠ НЕ ПРИМЕНЯТЬ ПОВТОРНО ЦЕЛИКОМ (аудит 25.10.2026). Файл устарел относительно базы: его прогон откатит
--   ge_start, galaxy_events_state — потеряются DO-правки sql/galaxy_events_2.sql и вставки err_db.
--   Нужна функция отсюда — бери её текущую версию из базы (pg_get_functiondef), а не из этого файла.
-- Галактические события. План — claude/mechanics-plan.md, этап 4. Применять после sql/laws.sql и sql/reports.sql.
--
-- * galaxy_event_types — каталог: охват (вся галактика / фракция / сектор / планета / фронт), срок,
--   эффекты через faction_effects (source = 'event:<id события>'), разовые действия на старте:
--   raid — банда мародёров у поселения (только где есть управляющий), stock — ресурсы на склад планеты,
--   gift — свой боец управляющему планеты, cr — кредиты управляющим.
-- * galaxy_events — события: какие планеты задеты, когда кончается, что сделали разовые действия.
-- Такт galaxy_event_tick (pg_cron, раз в 15 минут): закрыть истёкшие; если активных меньше
--   galaxy_event_max (2) и подошло время — запустить новое (по весам, не из трёх последних);
--   следующее — через galaxy_event_gap_min..max часов (18–36).
-- Текст события: {planet} — центр (сектор, планета, фронт), подставляется как есть: ставить его только после «сектор»
--   или в начале «Планета {planet}: …», чтобы не было «вокруг Геонозис». {faction} / {faction_gen} / {house} — сторона.
-- Видно всем: galaxy_events_state. Администрации: dev_galaxy_event_start (тест, сразу).

-- ---------------------------------------------------------------- настройки
insert into public.game_settings (key, value) values
  ('galaxy_event_max', '2'), ('galaxy_event_gap_min', '18'), ('galaxy_event_gap_max', '36')
on conflict (key) do nothing;

-- ---------------------------------------------------------------- таблицы
create table if not exists public.galaxy_event_types (
  id text primary key,
  title text not null,
  text text not null,
  glyph text not null default '✦',
  tone text not null check (tone in ('good', 'bad', 'mixed')),
  scope text not null check (scope in ('galaxy', 'faction', 'sector', 'planet', 'front')),
  faction text check (faction in ('republic', 'cis')),
  weight integer not null default 2,
  hours integer not null,
  effects jsonb not null default '[]',
  actions jsonb not null default '{}',
  sort integer not null default 0,
  active boolean not null default true
);
create table if not exists public.galaxy_events (
  id uuid primary key default gen_random_uuid(),
  type_id text not null references public.galaxy_event_types(id),
  scope text not null,
  faction text,
  center text,
  systems text[] not null default '{}',
  started_at timestamptz not null default now(),
  ends_at timestamptz not null,
  status text not null default 'active' check (status in ('active', 'ended')),
  result jsonb not null default '{}',
  dev boolean not null default false
);
create index if not exists galaxy_events_open on public.galaxy_events (status, ends_at);
create table if not exists public.galaxy_event_state (
  k integer primary key default 1 check (k = 1),
  next_at timestamptz not null
);

alter table public.galaxy_event_types enable row level security;
alter table public.galaxy_events enable row level security;
alter table public.galaxy_event_state enable row level security;
revoke all on public.galaxy_event_types, public.galaxy_events, public.galaxy_event_state from anon, authenticated;

-- первое событие — через пару часов после применения (успеть выложить клиент)
insert into public.galaxy_event_state (k, next_at) values (1, now() + interval '2 hours') on conflict (k) do nothing;

insert into public.event_types (type, category, title, tone, jumpable) values
  ('galaxy_event', 'faction', 'Галактическое событие', 'neutral', false)
on conflict (type) do nothing;

-- ---------------------------------------------------------------- каталог
insert into public.galaxy_event_types (id, title, text, glyph, tone, scope, faction, weight, hours, effects, actions, sort) values
  -- вся галактика
  ('ge_trade_boom', 'Торговый бум', 'Гиперпути спокойны — купцы со всей галактики везут грузы. Доход поселений растёт.',
     '◈', 'good', 'galaxy', null, 2, 48, '[{"kind":"income","value":15}]', '{}', 1),
  ('ge_fuel_crisis', 'Перебои с тибанной', 'Танкеры с топливом застряли в блокаде. Верфи и стройки по всей галактике работают вполсилы.',
     '⛽', 'bad', 'galaxy', null, 2, 36, '[{"kind":"hire_time","value":15},{"kind":"build_time","value":15}]', '{}', 2),
  ('ge_podrace', 'Гонки на подах', 'Вся галактика смотрит Бунта Ив Классик на Татуине. В кантинах шумно, на улицах спокойно.',
     '⚑', 'good', 'galaxy', null, 2, 24, '[{"kind":"mood","value":8}]', '{}', 3),
  ('ge_solar_max', 'Солнечный максимум', 'Звёзды неспокойны: магнитные бури мешают спать, зато буры в разогретой породе идут легче.',
     '☀', 'mixed', 'galaxy', null, 2, 48, '[{"kind":"extract","value":10},{"kind":"mood","value":-5}]', '{}', 4),
  -- одна сторона
  ('ge_convoys', 'Конвои из центральных миров', '{faction}: из глубокого тыла пришли конвои с оружием и пополнением.',
     '⇉', 'good', 'faction', null, 2, 48, '[{"kind":"hire_time","value":-20}]', '{}', 10),
  ('ge_scandal', 'Скандал в {house}', 'Утечка в Голонет: чиновники {faction_gen} наживались на поставках. Люди возмущены, торговцы осторожничают.',
     '✉', 'bad', 'faction', null, 2, 24, '[{"kind":"income","value":-10},{"kind":"mood","value":-5}]', '{}', 11),
  ('ge_heroes', 'День героев', '{faction} чествует ветеранов последних сражений. Парады, награды и долгие речи.',
     '✶', 'good', 'faction', null, 2, 24, '[{"kind":"mood","value":10}]', '{}', 12),
  ('ge_strike', 'Всеобщая стачка', 'Профсоюзы {faction_gen} требуют пересмотра пайков. Шахты и рудники встали.',
     '⚒', 'bad', 'faction', null, 2, 24, '[{"kind":"extract","value":-15}]', '{}', 13),
  -- сектор: планета и её соседи по гиперпутям
  ('ge_ion_storm', 'Ионный шторм', 'Ионный шторм накрыл сектор {planet}: связь рвётся, техника выходит из строя.',
     '≋', 'bad', 'sector', null, 3, 48, '[{"kind":"extract","value":-20},{"kind":"build_time","value":25}]', '{}', 20),
  ('ge_pirates', 'Волна пиратов', 'Пиратский флот рыщет в секторе {planet}. Банды высаживаются у поселений.',
     '☠', 'bad', 'sector', null, 3, 36, '[{"kind":"mood","value":-5}]', '{"raid":3}', 21),
  ('ge_meteors', 'Метеорный поток', 'Сектор {planet} проходит сквозь метеорный поток: руда буквально падает с неба.',
     '✸', 'good', 'sector', null, 2, 48, '[{"kind":"extract","value":20}]', '{"stock":{"ore":60}}', 22),
  ('ge_refugees', 'Беженцы с фронта', 'Тысячи беженцев прибыли в сектор {planet}. Многие идут в армию, но города переполнены.',
     '⇶', 'mixed', 'sector', null, 2, 48, '[{"kind":"hire_time","value":-15},{"kind":"mood","value":-8}]', '{}', 23),
  ('ge_trade_route', 'Новый торговый путь', 'Разведчики проложили короткий гиперпуть через сектор {planet}. Купцы уже здесь.',
     '⇄', 'good', 'sector', null, 2, 72, '[{"kind":"income","value":20}]', '{}', 24),
  ('ge_epidemic', 'Эпидемия', 'Вспышка болезни в секторе {planet}. Карантин, очереди к медикам, пустые смены.',
     '✚', 'bad', 'sector', null, 2, 48, '[{"kind":"extract","value":-15},{"kind":"mood","value":-10}]', '{}', 25),
  -- одна планета
  ('ge_rich_vein', 'Богатая жила', 'Планета {planet}: геологи нашли жилу, о которой и мечтать не смели.',
     '◆', 'good', 'planet', null, 2, 72, '[{"kind":"extract","value":40}]', '{}', 30),
  ('ge_quake', 'Землетрясение', 'Планета {planet}: толчки разрушили дороги и шахтные стволы.',
     '⌇', 'bad', 'planet', null, 2, 24, '[{"kind":"build_time","value":40},{"kind":"extract","value":-25}]', '{}', 31),
  ('ge_relic', 'Древний артефакт', 'Планета {planet}: шахтёры вскрыли пещеру с кристаллами и древними росписями. Учёные в восторге.',
     '✧', 'good', 'planet', null, 2, 48, '[{"kind":"mood","value":10}]', '{"stock":{"crystals":40}}', 32),
  ('ge_fair', 'Ярмарка вольных торговцев', 'Планета {planet}: на орбите встал караван вольных торговцев. Поселение гуляет и богатеет.',
     '◈', 'good', 'planet', null, 2, 48, '[{"kind":"income","value":30}]', '{}', 33),
  -- фронт: планета рядом с планетами противника
  ('ge_defectors', 'Перебежчики', 'Планета {planet}: к гарнизону перешли солдаты противника — с оружием и картами.',
     '⇆', 'good', 'front', null, 2, 24, '[{"kind":"mood","value":5}]', '{"gift":2}', 40),
  ('ge_sabotage', 'Диверсия', 'Планета {planet}: диверсанты противника подорвали склады и цеха.',
     '✕', 'bad', 'front', null, 2, 24, '[{"kind":"build_time","value":30},{"kind":"hire_time","value":30}]', '{}', 41),
  ('ge_mercs', 'Охотники за головами', 'Планета {planet}: у поселения высадились наёмники с чужим контрактом.',
     '⌖', 'bad', 'front', null, 2, 24, '[]', '{"raid":4}', 42),
  ('ge_reserves', 'Резервы с тыла', 'Планета {planet}: командование перебросило сюда свежие резервы и боеприпасы.',
     '⇧', 'good', 'front', null, 2, 48, '[{"kind":"hire_time","value":-30}]', '{}', 43)
on conflict (id) do update set title = excluded.title, text = excluded.text, glyph = excluded.glyph, tone = excluded.tone,
  scope = excluded.scope, faction = excluded.faction, weight = excluded.weight, hours = excluded.hours,
  effects = excluded.effects, actions = excluded.actions, sort = excluded.sort, active = true;

-- ---------------------------------------------------------------- служебное
-- Соседи по гиперпутям (таблица hyperlanes; пустоты между планетами — тоже её строки)
create or replace function public.ge_neighbors(p_system text)
 returns text[] language sql stable security definer set search_path to 'public', 'pg_temp'
as $function$
  select coalesce(array_agg(distinct n), '{}') from (
    select case when system_a = p_system then system_b else system_a end n
    from hyperlanes where system_a = p_system or system_b = p_system) q
  where n in (select id from systems where faction in ('republic', 'cis') and not coalesce(is_deep_space, false));
$function$;

create or replace function public.ge_fill(p_text text, p_planet text, p_faction text)
 returns text language sql immutable set search_path to 'public', 'pg_temp'
as $function$
  select replace(replace(replace(replace(p_text,
    '{planet}', coalesce(p_planet, 'планеты')),
    '{faction}', case p_faction when 'republic' then 'Республика' when 'cis' then 'Конфедерация' else 'Фракция' end),
    '{faction_gen}', case p_faction when 'republic' then 'Республики' when 'cis' then 'Конфедерации' else 'фракции' end),
    '{house}', case p_faction when 'republic' then 'Сенате' when 'cis' then 'Совете' else 'правительстве' end);
$function$;

-- Запустить событие типа p_type (или случайное). Возвращает id события или null, если цели не нашлось.
create or replace function public.ge_start(p_type text default null, p_dev boolean default false)
 returns uuid language plpgsql security definer set search_path to 'public', 'pg_temp'
as $function$
declare
  t galaxy_event_types; v_busy text[]; v_center text; v_fac text; v_sys text[]; v_id uuid; s text; e jsonb; k text; v_ctrl uuid;
  v_res jsonb := '{}'::jsonb; v_raided integer := 0; v_gifts integer := 0; v_n integer; v_title text; v_name text;
begin
  -- планеты, где уже идёт местное событие (сектор, планета, фронт), второй раз не трогаем;
  -- общегалактические и фракционные задевают всех и занятыми не считаются
  select coalesce(array_agg(distinct x), '{}') into v_busy from galaxy_events g, unnest(g.systems) x
   where g.status = 'active' and g.ends_at > now() and g.scope in ('sector', 'planet', 'front');
  if p_type is not null then
    select * into t from galaxy_event_types where id = p_type and active;
    if not found then raise exception 'Нет такого события'; end if;
  else
    select * into t from galaxy_event_types et
    where et.active
      and et.id not in (select type_id from galaxy_events order by started_at desc limit 3)
      and not exists (select 1 from galaxy_events g where g.type_id = et.id and g.status = 'active' and g.ends_at > now())
      -- вторая общегалактическая разом — перебор
      and not (et.scope = 'galaxy' and exists (select 1 from galaxy_events g join galaxy_event_types gt on gt.id = g.type_id
                                               where g.status = 'active' and g.ends_at > now() and gt.scope = 'galaxy'))
    order by -ln(random()) / greatest(et.weight, 1) limit 1;
    if not found then return null; end if;
  end if;

  if t.scope = 'galaxy' then
    select coalesce(array_agg(id), '{}') into v_sys from systems where faction in ('republic', 'cis') and not coalesce(is_deep_space, false);
  elsif t.scope = 'faction' then
    v_fac := coalesce(t.faction, case when random() < 0.5 then 'republic' else 'cis' end);
    select coalesce(array_agg(id), '{}') into v_sys from systems where faction = v_fac and not coalesce(is_deep_space, false);
  else
    -- центр: планета без идущего события; управляемые — втрое чаще; фронт — рядом с противником
    select s0.id into v_center from systems s0 left join system_control sc on sc.system_id = s0.id
    where s0.faction in ('republic', 'cis') and not coalesce(s0.is_deep_space, false) and not (s0.id = any(v_busy))
      and (t.scope <> 'front' or exists (select 1 from unnest(ge_neighbors(s0.id)) nb join systems s1 on s1.id = nb where s1.faction <> s0.faction))
    order by -ln(random()) / case when sc.controller_user_id is not null then 3 else 1 end limit 1;
    if v_center is null then return null; end if;
    if t.scope = 'sector' then
      select array_agg(x) into v_sys from (select v_center x union select nb from unnest(ge_neighbors(v_center)) nb where not (nb = any(v_busy))) q;
    else
      v_sys := array[v_center];
    end if;
  end if;
  if coalesce(array_length(v_sys, 1), 0) = 0 then return null; end if;

  select name into v_name from systems where id = v_center;
  v_title := ge_fill(t.title, v_name, v_fac);
  insert into galaxy_events (type_id, scope, faction, center, systems, ends_at, dev)
  values (t.id, t.scope, v_fac, v_center, v_sys, now() + make_interval(hours => t.hours), p_dev)
  returning id into v_id;

  -- эффекты: вся галактика и сторона — на всю фракцию, иначе — на каждую задетую планету
  for e in select * from jsonb_array_elements(t.effects) loop
    if t.scope = 'galaxy' then
      insert into faction_effects (faction, kind, value, title, source, starts_at, ends_at)
      select f, e->>'kind', (e->>'value')::integer, v_title, 'event:' || v_id, now(), now() + make_interval(hours => t.hours)
      from unnest(array['republic', 'cis']) f;
    elsif t.scope = 'faction' then
      insert into faction_effects (faction, kind, value, title, source, starts_at, ends_at)
      values (v_fac, e->>'kind', (e->>'value')::integer, v_title, 'event:' || v_id, now(), now() + make_interval(hours => t.hours));
    else
      insert into faction_effects (faction, kind, value, title, source, system_id, starts_at, ends_at)
      select x.faction, e->>'kind', (e->>'value')::integer, v_title, 'event:' || v_id, x.id, now(), now() + make_interval(hours => t.hours)
      from systems x where x.id = any(v_sys) and x.faction in ('republic', 'cis');
    end if;
  end loop;

  -- разовые действия — только для планет, а не для всей галактики
  if t.scope not in ('galaxy', 'faction') then
    foreach s in array v_sys loop
      select controller_user_id into v_ctrl from system_control where system_id = s;
      if t.actions ? 'raid' and v_ctrl is not null then
        begin perform spawn_marauder_gang(s, (t.actions->>'raid')::integer); v_raided := v_raided + 1;
        exception when others then null; end;
      end if;
      if t.actions ? 'stock' then
        for k, v_n in select key, value::integer from jsonb_each_text(t.actions->'stock') loop
          begin perform add_planet_stock(s, k, v_n); exception when others then null; end;
        end loop;
      end if;
      if t.actions ? 'gift' and v_ctrl is not null then
        for v_n in 1..greatest(1, (t.actions->>'gift')::integer) loop
          begin if report_gift(s, v_ctrl, false) is not null then v_gifts := v_gifts + 1; end if;
          exception when others then null; end;
        end loop;
      end if;
      -- управляющему задетой планеты — лично в ленту
      if v_ctrl is not null then
        perform log_event(v_ctrl, (select faction from systems where id = s), s, 'galaxy_event', v_title, 1, 'private',
                          jsonb_build_object('event', v_id, 'type', t.id, 'tone', t.tone));
      end if;
    end loop;
    if v_raided > 0 then v_res := v_res || jsonb_build_object('raid', v_raided, 'gang', (t.actions->>'raid')::integer); end if;
    if t.actions ? 'stock' then v_res := v_res || jsonb_build_object('stock', t.actions->'stock'); end if;
    if v_gifts > 0 then v_res := v_res || jsonb_build_object('gift', v_gifts); end if;
    update galaxy_events set result = v_res where id = v_id;
  end if;

  -- всем — строкой в сводку (видно обеим сторонам)
  perform log_event(null, coalesce(v_fac, (select faction from systems where id = v_center)), v_center, 'galaxy_event', v_title, 1, 'all',
                    jsonb_build_object('event', v_id, 'type', t.id, 'tone', t.tone, 'scope', t.scope));
  return v_id;
end;
$function$;

-- Такт: закрыть истёкшие, запустить новое по расписанию
create or replace function public.galaxy_event_tick()
 returns integer language plpgsql security definer set search_path to 'public', 'pg_temp'
as $function$
declare v_next timestamptz; v_id uuid; v_lo integer := event_setting_int('galaxy_event_gap_min', 18); v_hi integer := event_setting_int('galaxy_event_gap_max', 36);
begin
  if not pg_try_advisory_xact_lock(hashtext('galaxy_event_tick')) then return 0; end if;
  update galaxy_events set status = 'ended' where status = 'active' and ends_at <= now();
  select next_at into v_next from galaxy_event_state where k = 1 for update;
  if v_next is null then insert into galaxy_event_state (k, next_at) values (1, now()) on conflict (k) do nothing; v_next := now(); end if;
  if v_next > now() then return 0; end if;
  if (select count(*) from galaxy_events where status = 'active' and ends_at > now() and not dev) >= event_setting_int('galaxy_event_max', 2) then return 0; end if;
  v_id := ge_start(null, false);
  update galaxy_event_state set next_at = now() + make_interval(mins => (v_lo * 60 + floor(random() * greatest(1, (v_hi - v_lo) * 60)))::integer)
   where k = 1;
  return case when v_id is null then 0 else 1 end;
end;
$function$;

-- ---------------------------------------------------------------- игроку
create or replace function public.galaxy_events_state()
 returns jsonb language plpgsql security definer set search_path to 'public', 'pg_temp'
as $function$
declare v_me uuid := auth.uid(); v_fac text;
begin
  if v_me is null then raise exception 'Нужно войти'; end if;
  select faction into v_fac from profiles where id = v_me;
  return jsonb_build_object(
    'now', now(), 'faction', v_fac,
    'active', (select coalesce(jsonb_agg(x order by x->>'ends'), '[]'::jsonb) from (
       select jsonb_build_object('id', g.id, 'type', t.id, 'title', ge_fill(t.title, c.name, g.faction), 'text', ge_fill(t.text, c.name, g.faction),
                'glyph', t.glyph, 'tone', t.tone, 'scope', g.scope, 'faction', g.faction, 'center', g.center, 'center_name', c.name,
                'effects', t.effects, 'result', g.result, 'started', g.started_at, 'ends', g.ends_at,
                'planets', (select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'faction', s.faction,
                               'mine', exists (select 1 from system_control sc where sc.system_id = s.id and sc.controller_user_id = v_me))
                             order by (s.id = g.center) desc, s.name), '[]'::jsonb)
                            from systems s where s.id = any(g.systems))) x
       from galaxy_events g join galaxy_event_types t on t.id = g.type_id left join systems c on c.id = g.center
       where g.status = 'active' and g.ends_at > now()) q),
    'recent', (select coalesce(jsonb_agg(x order by x->>'ended' desc), '[]'::jsonb) from (
       select jsonb_build_object('title', ge_fill(t.title, c.name, g.faction), 'glyph', t.glyph, 'tone', t.tone, 'scope', g.scope,
                'center_name', c.name, 'faction', g.faction, 'ended', g.ends_at) x
       from galaxy_events g join galaxy_event_types t on t.id = g.type_id left join systems c on c.id = g.center
       where g.ends_at <= now() and g.ends_at > now() - interval '5 days'
       order by g.ends_at desc limit 6) q),
    'next_hint', (select next_at > now() from galaxy_event_state where k = 1));
end;
$function$;

-- Администрации: запустить событие сразу (вне расписания и предела)
create or replace function public.dev_galaxy_event_start(p_type text)
 returns jsonb language plpgsql security definer set search_path to 'public', 'pg_temp'
as $function$
declare v_me uuid := dev_assert(); v_id uuid;
begin
  v_id := ge_start(p_type, true);
  if v_id is null then raise exception 'Цели для события не нашлось — все подходящие планеты заняты другими событиями'; end if;
  perform dev_note(v_me, 'galaxy_event', null, null, jsonb_build_object('type', p_type, 'event', v_id));
  return jsonb_build_object('id', v_id, 'systems', (select systems from galaxy_events where id = v_id));
end;
$function$;

create or replace function public.dev_galaxy_event_types()
 returns jsonb language plpgsql security definer set search_path to 'public', 'pg_temp'
as $function$
declare v_me uuid := dev_assert();
begin
  return (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'title', title, 'scope', scope, 'tone', tone) order by sort), '[]'::jsonb)
          from galaxy_event_types where active);
end;
$function$;

-- Досрочно закончить событие (тест). Эффекты гаснут сразу.
create or replace function public.dev_galaxy_event_end(p_id uuid)
 returns void language plpgsql security definer set search_path to 'public', 'pg_temp'
as $function$
declare v_me uuid := dev_assert();
begin
  update galaxy_events set status = 'ended', ends_at = least(ends_at, now()) where id = p_id;
  update faction_effects set ends_at = least(ends_at, now()) where source = 'event:' || p_id;
  perform dev_note(v_me, 'galaxy_event_end', null, null, jsonb_build_object('event', p_id));
end;
$function$;

do $$
declare f text;
begin
  foreach f in array array['ge_neighbors(text)', 'ge_fill(text, text, text)', 'ge_start(text, boolean)', 'galaxy_event_tick()']
  loop execute format('revoke all on function public.%s from public, anon, authenticated', f); end loop;
  foreach f in array array['galaxy_events_state()', 'dev_galaxy_event_start(text)', 'dev_galaxy_event_types()', 'dev_galaxy_event_end(uuid)']
  loop execute format('revoke all on function public.%s from public, anon', f); execute format('grant execute on function public.%s to authenticated', f); end loop;
end $$;

select cron.schedule('galaxy-event-tick', '*/15 * * * *', 'select public.galaxy_event_tick()');
