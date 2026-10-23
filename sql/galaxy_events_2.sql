-- Галактические события, вторая партия (23.10.2026): +18 событий (всего 40) и четыре новых действия.
--
--   travel  — % ко времени прыжка флота по гиперпути, если путь касается задетых планет (galaxy — везде);
--             минус — быстрее. Считается в start_commander_move (ge_travel_mod).
--   trade   — % к цене, по которой торговый пост скупает сырьё (только «вся галактика»; trade_post_price).
--   credits — кредиты управляющему каждой задетой планеты (разово, при старте).
--   unrest  — сдвиг шкалы напряжения задетых планет (разово, при старте; sql/unrest.sql).
--
-- Клиент (js/galaxy-events.js) показывает travel / trade плашками эффектов, credits / unrest — итогом старта.

-- ---------------------------------------------------------------- длительные действия
create or replace function public.ge_travel_mod(p_from text, p_to text)
 returns integer language sql stable security definer set search_path to 'public', 'pg_temp'
as $function$
  select greatest(-50, least(100, coalesce(sum((t.actions ->> 'travel')::integer), 0)))::integer  -- без событий — 0 (greatest/least пропускают null)
    from galaxy_events g join galaxy_event_types t on t.id = g.type_id
   where g.status = 'active' and g.ends_at > now() and t.actions ? 'travel'
     and (g.scope = 'galaxy' or g.systems && array[p_from, p_to]);
$function$;

create or replace function public.ge_trade_mod()
 returns integer language sql stable security definer set search_path to 'public', 'pg_temp'
as $function$
  select greatest(-50, least(100, coalesce(sum((t.actions ->> 'trade')::integer), 0)))::integer  -- без событий — 0 (greatest/least пропускают null)
    from galaxy_events g join galaxy_event_types t on t.id = g.type_id
   where g.status = 'active' and g.ends_at > now() and t.actions ? 'trade' and g.scope = 'galaxy';
$function$;

-- Пост скупает по базовой цене × trade_post_pct, с поправкой событий
create or replace function public.trade_post_price(p_resource text)
 returns integer language sql stable set search_path to 'public', 'pg_temp'
as $function$
  select greatest(1, round(r.base_price * game_setting_int('trade_post_pct', 60) / 100.0 * (100 + ge_trade_mod()) / 100.0)::integer)
  from resources r where r.id = p_resource;
$function$;

-- Прыжок флота: время с поправкой событий на этом гиперпути
do $do$
declare d text; a text;
begin
  d := pg_get_functiondef('public.start_commander_move(uuid, text)'::regprocedure);
  if position('ge_travel_mod' in d) > 0 then return; end if;
  a := $a$  v_seconds := coalesce(v_seconds, 60);
$a$;
  if position(a in d) = 0 then raise exception 'start_commander_move: время прыжка не найдено'; end if;
  d := replace(d, a, a || $a$  -- галактические события на этом гиперпути: шторм дольше, линия снабжения быстрее (sql/galaxy_events_2.sql)
  v_seconds := greatest(10, round(v_seconds * (100 + ge_travel_mod(v_current, p_target_system)) / 100.0)::integer);
$a$);
  execute d;
end $do$;

-- ---------------------------------------------------------------- разовые действия при старте
do $do$
declare d text; a text;
begin
  d := pg_get_functiondef('public.ge_start(text, boolean)'::regprocedure);
  if position('''credits''' in d) > 0 then return; end if;
  a := $a$      if v_ctrl is not null then
        perform log_event(v_ctrl, (select faction from systems where id = s), s, 'galaxy_event'$a$;
  if position(a in d) = 0 then raise exception 'ge_start: место действий не найдено'; end if;
  d := replace(d, a, $a$      if t.actions ? 'credits' and v_ctrl is not null then
        update profiles set credits = credits + (t.actions ->> 'credits')::integer where id = v_ctrl;
        v_res := v_res || jsonb_build_object('paid', coalesce((v_res ->> 'paid')::integer, 0) + 1);
      end if;
      if t.actions ? 'unrest' and exists (select 1 from systems x where x.id = s and x.faction in ('republic', 'cis')) then
        begin
          insert into settlement_unrest (system_id, value) values (s, greatest(0, least(100, (t.actions ->> 'unrest')::integer)))
          on conflict (system_id) do update
            set value = greatest(0, least(100, settlement_unrest.value + (t.actions ->> 'unrest')::integer)), updated_at = now();
        exception when others then null; end;
      end if;
$a$ || a);
  a := $a$    if v_gifts > 0 then v_res := v_res || jsonb_build_object('gift', v_gifts); end if;
$a$;
  if position(a in d) = 0 then raise exception 'ge_start: итог не найден'; end if;
  d := replace(d, a, a || $a$    if v_res ? 'paid' then v_res := v_res || jsonb_build_object('credits', (t.actions ->> 'credits')::integer); end if;
    if t.actions ? 'unrest' then v_res := v_res || jsonb_build_object('unrest', (t.actions ->> 'unrest')::integer); end if;
$a$);
  execute d;
end $do$;

-- Клиенту — и длительные действия события (travel / trade показываются плашками)
do $do$
declare d text; a text;
begin
  d := pg_get_functiondef('public.galaxy_events_state()'::regprocedure);
  if position('''actions'', t.actions' in d) > 0 then return; end if;
  a := $a$'effects', t.effects, 'result', g.result,$a$;
  if position(a in d) = 0 then raise exception 'galaxy_events_state: эффекты не найдены'; end if;
  d := replace(d, a, $a$'effects', t.effects, 'actions', t.actions, 'result', g.result,$a$);
  execute d;
end $do$;

-- ---------------------------------------------------------------- каталог: +18
insert into public.galaxy_event_types (id, title, text, glyph, tone, scope, faction, weight, hours, effects, actions, sort) values
  -- вся галактика
  ('ge_trade_fever', 'Лихорадка спроса', 'Верфи по всей галактике скупают сырьё впрок. Торговые посты платят щедрее обычного.',
     '⚖', 'good', 'galaxy', null, 2, 48, '[]', '{"trade":25}', 5),
  ('ge_hyper_storm', 'Гиперпространственная буря', 'Аномалия в гиперпространстве сбивает навикомпьютеры. Прыжки идут медленнее, пилоты нервничают.',
     '⌁', 'bad', 'galaxy', null, 2, 24, '[]', '{"travel":40}', 6),
  ('ge_holonet_blackout', 'Сбой Голонета', 'Ретрансляторы Голонета молчат. Слухи расползаются быстрее новостей, сделки срываются.',
     '◌', 'bad', 'galaxy', null, 2, 24, '[{"kind":"mood","value":-5},{"kind":"income","value":-5}]', '{}', 7),
  ('ge_comet', 'Хвост кометы', 'Через галактику проходит древняя комета. Шахтёры собирают лёд и металл, но обломки мешают стройкам.',
     '☄', 'mixed', 'galaxy', null, 2, 36, '[{"kind":"extract","value":15},{"kind":"build_time","value":10}]', '{}', 8),
  -- одна сторона
  ('ge_supply_line', 'Новая линия снабжения', '{faction}: флот проложил защищённые коридоры. Корабли прыгают быстрее, конвои не ждут сопровождения.',
     '⇢', 'good', 'faction', null, 2, 48, '[]', '{"travel":-25}', 14),
  ('ge_spy_ring', 'Раскрыта шпионская сеть', 'Контрразведка {faction_gen} вскрыла сеть агентов. Проверки тормозят набор, люди подозревают соседей.',
     '◎', 'bad', 'faction', null, 2, 24, '[{"kind":"hire_time","value":15},{"kind":"mood","value":-4}]', '{}', 15),
  ('ge_shipyard_rush', 'Аврал на верфях', '{faction} перебросила рабочих на стройки и ремонт. Шахты пустеют.',
     '⚙', 'mixed', 'faction', null, 2, 36, '[{"kind":"build_time","value":-20},{"kind":"extract","value":-10}]', '{}', 16),
  -- сектор
  ('ge_lane_storm', 'Шторм на гиперпутях', 'Ионный фронт лёг на гиперпути у сектора {planet}. Прыжки сюда и отсюда затягиваются.',
     '≈', 'bad', 'sector', null, 2, 36, '[{"kind":"mood","value":-3}]', '{"travel":50}', 26),
  ('ge_smugglers', 'Контрабандисты', 'Контрабандисты облюбовали сектор {planet}. Деньги текут рекой, но порядок трещит.',
     '⚓', 'mixed', 'sector', null, 2, 48, '[{"kind":"income","value":15}]', '{"unrest":5}', 27),
  ('ge_derelict', 'Брошенный крейсер', 'В секторе {planet} нашли брошенный крейсер. Инженеры разбирают его на дюрасталь и электронику.',
     '⛴', 'good', 'sector', null, 2, 24, '[{"kind":"build_time","value":-10}]', '{"stock":{"durasteel":50,"electronics":20}}', 28),
  ('ge_cure', 'Найдено лекарство', 'Медики сектора {planet} победили местную лихорадку. Люди выдохнули.',
     '✚', 'good', 'sector', null, 2, 48, '[{"kind":"mood","value":8}]', '{"unrest":-10}', 29),
  -- одна планета
  ('ge_spice', 'Спайс-лихорадка', 'Планета {planet}: в доках гуляет спайс. Кантины полны, кошельки тоже, но стража не справляется.',
     '✶', 'mixed', 'planet', null, 2, 48, '[{"kind":"income","value":25},{"kind":"mood","value":-5}]', '{"unrest":10}', 34),
  ('ge_sandstorm', 'Песчаная буря', 'Планета {planet}: буря закрыла небо. Рудники засыпаны, посадка — вслепую.',
     '≋', 'bad', 'planet', null, 2, 24, '[{"kind":"extract","value":-30}]', '{"travel":30}', 35),
  ('ge_patron', 'Меценат из Сената', 'Планета {planet}: богатый покровитель оплатил ремонт улиц и праздник. Управляющему — пожертвование.',
     '❖', 'good', 'planet', null, 2, 24, '[{"kind":"mood","value":5}]', '{"credits":400}', 36),
  ('ge_crash', 'Крушение транспорта', 'Планета {planet}: у поселения рухнул грузовой транспорт. Груз растащили по складам.',
     '⤓', 'good', 'planet', null, 2, 24, '[{"kind":"mood","value":-3}]', '{"stock":{"food":80,"ore":40}}', 37),
  -- фронт
  ('ge_artillery', 'Артиллерийская дуэль', 'Планета {planet}: дальнобойные батареи противника бьют по окраинам. Стройки встают, люди злы.',
     '✹', 'bad', 'front', null, 2, 24, '[{"kind":"build_time","value":20}]', '{"unrest":10}', 44),
  ('ge_leaflets', 'Листовки противника', 'Планета {planet}: ночью город засыпали листовками врага. Слухи, споры, драки у кантин.',
     '✉', 'bad', 'front', null, 2, 24, '[{"kind":"mood","value":-6}]', '{"unrest":5}', 45),
  ('ge_hero_arrives', 'Прославленный командир', 'Планета {planet}: прибыл герой недавних сражений. Добровольцы выстраиваются в очередь.',
     '★', 'good', 'front', null, 2, 48, '[{"kind":"hire_time","value":-25},{"kind":"mood","value":5}]', '{"unrest":-10,"gift":1}', 46)
on conflict (id) do update set title = excluded.title, text = excluded.text, glyph = excluded.glyph, tone = excluded.tone,
  scope = excluded.scope, faction = excluded.faction, weight = excluded.weight, hours = excluded.hours,
  effects = excluded.effects, actions = excluded.actions, sort = excluded.sort, active = true;
