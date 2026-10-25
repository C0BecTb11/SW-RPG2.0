-- Политика: законы Сената (Республика) и Совета сепаратистов (КНС). План — claude/mechanics-plan.md, этап 3.
--
-- * faction_laws — каталог: по 6 законов на сторону, у каждого плюс и минус (effects: [{kind, value}]).
-- * faction_bills — предложенные законы: голосование 48 ч → действует 7 дней; указ лидера — сразу на 24 ч.
-- * faction_votes — голоса: 1 игрок = 1 голос, голос можно поменять, пока идёт голосование.
-- * faction_effects — эффекты действующих законов на все планеты фракции (systems.faction).
--   effect_sum(планета, kind) складывает их с эффектами самой планеты (active_effects, донесения).
-- Правила:
--   одновременно не больше 2 законов фракции (действующие + на голосовании);
--   принят, если «за» больше «против» и проголосовало не меньше max(2, ⅓ активных за неделю),
--   но не больше числа активных; проголосовали все активные — итог сразу;
--   отклонённый закон можно предложить снова через 48 ч; указ — раз в 7 дней, только лидер.
-- Предлагает лидер и должности с полномочием «Законы» (laws). Голосуют все игроки фракции.
-- Встраивание: найм бойцов и кораблей × hire_time, стройка зданий × build_time (минус — быстрее).
-- Денежные законы (funds) связаны с казной фракции (sql/treasury.sql): налог с дохода поселений
-- ({"tax": %}) или заём ({"now": +кр. сразу, "end": −кр. в конце срока}). Они — только голосованием;
-- новый заём, пока казна в минусе, не дают.

-- ---------------------------------------------------------------- настройки
insert into public.game_settings (key, value) values
  ('law_vote_hours', '48'), ('law_days', '7'), ('law_slots', '2'), ('law_decree_hours', '24'),
  ('law_decree_cooldown_days', '7'), ('law_retry_hours', '48'), ('law_active_days', '7')
on conflict (key) do nothing;

-- ---------------------------------------------------------------- таблицы
create table if not exists public.faction_laws (
  id text primary key,
  faction text not null check (faction in ('republic', 'cis')),
  title text not null,
  text text not null,
  effects jsonb not null,
  funds jsonb,
  sort integer not null default 0,
  active boolean not null default true
);
alter table public.faction_laws add column if not exists funds jsonb;
create table if not exists public.faction_bills (
  id uuid primary key default gen_random_uuid(),
  faction text not null,
  law_id text not null references public.faction_laws(id),
  mode text not null default 'vote' check (mode in ('vote', 'decree')),
  status text not null default 'voting' check (status in ('voting', 'active', 'failed', 'expired')),
  proposed_by uuid,
  created_at timestamptz not null default now(),
  vote_ends_at timestamptz,
  closed_at timestamptz,
  starts_at timestamptz,
  ends_at timestamptz,
  yes integer not null default 0,
  no integer not null default 0,
  need integer
);
create index if not exists faction_bills_open on public.faction_bills (faction, status);
create table if not exists public.faction_votes (
  bill_id uuid not null references public.faction_bills(id),
  user_id uuid not null,
  yes boolean not null,
  at timestamptz not null default now(),
  primary key (bill_id, user_id)
);
create table if not exists public.faction_effects (
  id bigserial primary key,
  faction text not null,
  kind text not null check (kind in ('mood', 'extract', 'income', 'hire_time', 'build_time')),
  value integer not null,
  title text,
  source text not null default 'law',
  source_id uuid,
  system_id text,                                 -- null — на все планеты фракции; иначе одна планета (проекты казны)
  starts_at timestamptz not null default now(),
  ends_at timestamptz not null
);
alter table public.faction_effects add column if not exists system_id text;
create index if not exists faction_effects_fac on public.faction_effects (faction, kind, ends_at);

alter table public.faction_laws enable row level security;
alter table public.faction_bills enable row level security;
alter table public.faction_votes enable row level security;
alter table public.faction_effects enable row level security;
revoke all on public.faction_laws, public.faction_bills, public.faction_votes, public.faction_effects from anon, authenticated;
revoke all on sequence public.faction_effects_id_seq from anon, authenticated;

insert into public.event_types (type, category, title, tone, jumpable) values
  ('law_proposed', 'faction', 'Голосование', 'neutral', false),
  ('law_passed',   'faction', 'Закон принят', 'good', false),
  ('law_failed',   'faction', 'Закон отклонён', 'bad', false),
  ('law_decree',   'faction', 'Указ лидера', 'neutral', false),
  ('law_expired',  'faction', 'Закон истёк', 'neutral', false)
on conflict (type) do nothing;

-- полномочие «Законы» для должностей
create or replace function public.faction_power_list()
 returns text[] language sql immutable set search_path to 'public', 'pg_temp'
as $function$
  select array['manage_roles','planet_requests','planet_controllers','orders','economy','laws','treasury']::text[];
$function$;
-- проверка таблицы должностей — тот же список (иначе должность с «Законами» или «Казной» не сохранялась)
alter table public.faction_roles drop constraint if exists faction_roles_powers_known;
alter table public.faction_roles add constraint faction_roles_powers_known
  check (powers <@ array['manage_roles','planet_requests','planet_controllers','orders','economy','laws','treasury']::text[]);

-- ---------------------------------------------------------------- каталог
insert into public.faction_laws (id, faction, title, text, effects, sort) values
  ('rep_mobilization', 'republic', 'Акт о мобилизации', 'Камино и верфи Куата переходят на ускоренный выпуск. Казна платит за спешку.',
     '[{"kind":"hire_time","value":-25},{"kind":"income","value":-10}]', 1),
  ('rep_kuat', 'republic', 'Контракты Куата', 'Сенат оплачивает срочные заказы строительным корпусам и инженерным батальонам.',
     '[{"kind":"build_time","value":-25},{"kind":"income","value":-10}]', 2),
  ('rep_labor', 'republic', 'Трудовая повинность', 'Шахты и заводы переводят на военный график. Люди устают.',
     '[{"kind":"extract","value":15},{"kind":"mood","value":-8}]', 3),
  ('rep_outer_rim', 'republic', 'Льготы Внешнему кольцу', 'Пошлины снижены — торговцы охотнее везут грузы, но сырьё уходит на рынок.',
     '[{"kind":"income","value":15},{"kind":"extract","value":-10}]', 4),
  ('rep_relief', 'republic', 'Помощь мирам Республики', 'Пайки, медики и восстановление городов — за счёт части военных заказов.',
     '[{"kind":"mood","value":10},{"kind":"hire_time","value":15}]', 5),
  ('rep_martial', 'republic', 'Военное положение', 'Армия получает приоритет во всём: людях, цехах и транспорте. Комендантский час.',
     '[{"kind":"hire_time","value":-20},{"kind":"build_time","value":-15},{"kind":"mood","value":-12}]', 6),
  ('cis_techno', 'cis', 'Заказ Техносоюза', 'Литейные выпускают дроидов круглые сутки. Руду и газ забирают на корпуса.',
     '[{"kind":"hire_time","value":-25},{"kind":"extract","value":-10}]', 1),
  ('cis_factories', 'cis', 'Мобилизация заводов', 'Сборочные линии и стройдроиды работают на фронт. Гражданская торговля стоит.',
     '[{"kind":"build_time","value":-25},{"kind":"income","value":-10}]', 2),
  ('cis_droid_mines', 'cis', 'Дроиды в шахтах', 'Органиков в забоях заменяют дроиды-копатели. Шахтёры остаются без работы.',
     '[{"kind":"extract","value":15},{"kind":"mood","value":-8}]', 3),
  ('cis_bank', 'cis', 'Кредитная линия клана', 'Банковский клан открывает кредиты торговцам. Взамен — его доля в каждой стройке.',
     '[{"kind":"income","value":15},{"kind":"build_time","value":15}]', 4),
  ('cis_independence', 'cis', 'Пропаганда независимости', 'Праздники, голопередачи и раздачи — миры помнят, ради чего ушли из Республики.',
     '[{"kind":"mood","value":10},{"kind":"income","value":-10}]', 5),
  ('cis_total_war', 'cis', 'Протокол тотальной войны', 'Всё — фронту. Генерал Гривус требует войска вчера.',
     '[{"kind":"hire_time","value":-20},{"kind":"build_time","value":-15},{"kind":"mood","value":-12}]', 6)
on conflict (id) do update set faction = excluded.faction, title = excluded.title, text = excluded.text,
  effects = excluded.effects, sort = excluded.sort, active = true;

-- денежные законы — работают с казной фракции (sql/treasury.sql)
insert into public.faction_laws (id, faction, title, text, effects, funds, sort) values
  ('rep_war_tax', 'republic', 'Военный налог', 'Десятая часть доходов поселений идёт в казну Республики — на нужды фронта.',
     '[{"kind":"income","value":-10}]', '{"tax":10}', 7),
  ('rep_bonds', 'republic', 'Военные облигации', 'Банки Корусанта выкупают облигации Республики. Через неделю — расчёт с процентами.',
     '[]', '{"now":2000,"end":-2600}', 8),
  ('cis_guild_levy', 'cis', 'Сбор Гильдии коммерции', 'Десятая часть доходов поселений уходит в казну Конфедерации.',
     '[{"kind":"income","value":-10}]', '{"tax":10}', 7),
  ('cis_bank_debt', 'cis', 'Долг Банковскому клану', 'Муунские банкиры дают Совету кредит. Через неделю его придётся вернуть с процентами.',
     '[]', '{"now":2000,"end":-2600}', 8)
on conflict (id) do update set faction = excluded.faction, title = excluded.title, text = excluded.text,
  effects = excluded.effects, funds = excluded.funds, sort = excluded.sort, active = true;

-- ---------------------------------------------------------------- эффекты
-- Сумма по виду: эффекты планеты (донесения) + законы её фракции + проекты казны на этой планете. Потолок: довольство ±30, проценты ±50.
create or replace function public.effect_sum(p_system text, p_kind text)
 returns integer language sql stable security definer set search_path to 'public', 'pg_temp'
as $function$
  select greatest(case when p_kind = 'mood' then -30 else -50 end, least(case when p_kind = 'mood' then 30 else 50 end,
         coalesce((select sum(value) from active_effects where system_id = p_system and kind = p_kind and starts_at <= now() and ends_at > now()), 0)
       + coalesce((select sum(fe.value) from faction_effects fe join systems s on s.faction = fe.faction
                   where s.id = p_system and fe.kind = p_kind and fe.starts_at <= now() and fe.ends_at > now()
                     and (fe.system_id is null or fe.system_id = p_system)), 0)))::integer;
$function$;

-- ---------------------------------------------------------------- служебное
-- Активные игроки фракции: заходили за неделю
create or replace function public.law_members(p_faction text)
 returns integer language sql stable security definer set search_path to 'public', 'pg_temp'
as $function$
  select count(*)::integer from profiles
  where faction = p_faction and last_seen_at > now() - make_interval(days => event_setting_int('law_active_days', 7));
$function$;

-- Сколько голосов нужно: не меньше двух и трети активных, но не больше, чем их есть
create or replace function public.law_quorum(p_faction text)
 returns integer language sql stable security definer set search_path to 'public', 'pg_temp'
as $function$
  select greatest(1, least(greatest(law_members(p_faction), 1), greatest(2, ceil(law_members(p_faction) / 3.0)::integer)));
$function$;

-- Всем игрокам фракции — в личную ленту, во фракционную сводку — одной строкой
create or replace function public.law_notify(p_faction text, p_by uuid, p_type text, p_title text, p_meta jsonb, p_skip uuid)
 returns void language plpgsql security definer set search_path to 'public', 'pg_temp'
as $function$
declare m record;
begin
  perform log_event(p_by, p_faction, null, p_type, p_title, 1, 'faction', p_meta);
  for m in select id from profiles where faction = p_faction and id is distinct from p_skip loop
    perform log_event(m.id, p_faction, null, p_type, p_title, 1, 'private', p_meta);
  end loop;
end;
$function$;

create or replace function public.law_enact(p_bill uuid)
 returns void language plpgsql security definer set search_path to 'public', 'pg_temp'
as $function$
declare b faction_bills; l faction_laws; e jsonb;
begin
  select * into b from faction_bills where id = p_bill;
  select * into l from faction_laws where id = b.law_id;
  for e in select * from jsonb_array_elements(l.effects) loop
    insert into faction_effects (faction, kind, value, title, source, source_id, starts_at, ends_at)
    values (b.faction, e->>'kind', (e->>'value')::integer, l.title, case when b.mode = 'decree' then 'decree' else 'law' end, b.id, b.starts_at, b.ends_at);
  end loop;
  -- заём: деньги в казну сразу
  if l.funds ? 'now' then
    perform treasury_add(b.faction, (l.funds->>'now')::integer, 'law', b.proposed_by, null, null, l.title);
  end if;
end;
$function$;

-- Подвести итог голосования
create or replace function public.law_close(p_bill uuid)
 returns text language plpgsql security definer set search_path to 'public', 'pg_temp'
as $function$
declare b faction_bills; v_yes integer; v_no integer; v_need integer; v_title text; v_ok boolean;
begin
  select * into b from faction_bills where id = p_bill for update;
  if not found or b.status <> 'voting' then return null; end if;
  select count(*) filter (where yes), count(*) filter (where not yes) into v_yes, v_no from faction_votes where bill_id = b.id;
  v_need := law_quorum(b.faction);
  v_ok := v_yes > v_no and v_yes + v_no >= v_need;
  select title into v_title from faction_laws where id = b.law_id;
  if v_ok then
    update faction_bills set status = 'active', yes = v_yes, no = v_no, need = v_need, closed_at = now(),
           starts_at = now(), ends_at = now() + make_interval(days => event_setting_int('law_days', 7))
     where id = b.id;
    perform law_enact(b.id);
    perform law_notify(b.faction, b.proposed_by, 'law_passed', v_title, jsonb_build_object('bill', b.id, 'yes', v_yes, 'no', v_no), null);
    return 'passed';
  end if;
  update faction_bills set status = 'failed', yes = v_yes, no = v_no, need = v_need, closed_at = now() where id = b.id;
  perform law_notify(b.faction, b.proposed_by, 'law_failed', v_title,
    jsonb_build_object('bill', b.id, 'yes', v_yes, 'no', v_no, 'need', v_need, 'quorum', v_yes + v_no < v_need), null);
  return 'failed';
end;
$function$;

-- Такт: итоги голосований и конец действия законов (pg_cron, раз в 10 минут)
create or replace function public.law_tick()
 returns integer language plpgsql security definer set search_path to 'public', 'pg_temp'
as $function$
declare r record; v_n integer := 0;
begin
  if not pg_try_advisory_xact_lock(hashtext('law_tick')) then return 0; end if;
  for r in select id from faction_bills where status = 'voting' and vote_ends_at <= now() loop
    perform law_close(r.id); v_n := v_n + 1;
  end loop;
  for r in select b.id, b.faction, l.title, l.funds from faction_bills b join faction_laws l on l.id = b.law_id
           where b.status = 'active' and b.ends_at <= now() loop
    update faction_bills set status = 'expired' where id = r.id;
    perform log_event(null, r.faction, null, 'law_expired', r.title, 1, 'faction', jsonb_build_object('bill', r.id));
    -- заём: расчёт с процентами в конце срока (казна может уйти в минус — это долг)
    if r.funds ? 'end' then
      perform treasury_add(r.faction, (r.funds->>'end')::integer, 'debt', null, null, null, r.title);
      perform log_event(null, r.faction, null, 'treasury_debt', r.title, abs((r.funds->>'end')::integer), 'faction', jsonb_build_object('bill', r.id));
    end if;
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$function$;

-- ---------------------------------------------------------------- игроку
create or replace function public.law_state()
 returns jsonb language plpgsql security definer set search_path to 'public', 'pg_temp'
as $function$
declare v_me uuid := auth.uid(); v_fac text; v_lead boolean; v_last timestamptz; v_used integer;
begin
  if v_me is null then raise exception 'Нужно войти'; end if;
  select faction into v_fac from profiles where id = v_me;
  if v_fac is null then return jsonb_build_object('faction', null); end if;
  perform law_tick();
  v_lead := is_faction_leader(v_me, v_fac);
  select max(created_at) into v_last from faction_bills where faction = v_fac and mode = 'decree';
  select count(*) into v_used from faction_bills where faction = v_fac and status in ('voting', 'active');
  return jsonb_build_object(
    'faction', v_fac, 'now', now(), 'is_leader', v_lead,
    'can_propose', faction_power(v_me, v_fac, 'laws'),
    'decree_at', case when v_last is null then null else v_last + make_interval(days => event_setting_int('law_decree_cooldown_days', 7)) end,
    'slots', event_setting_int('law_slots', 2), 'used', v_used,
    'members', law_members(v_fac), 'quorum', law_quorum(v_fac),
    'vote_hours', event_setting_int('law_vote_hours', 48), 'law_days', event_setting_int('law_days', 7),
    'decree_hours', event_setting_int('law_decree_hours', 24), 'retry_hours', event_setting_int('law_retry_hours', 48),
    'treasury', coalesce((select credits from faction_treasury where faction = v_fac), 0),
    'laws', (select coalesce(jsonb_agg(jsonb_build_object('id', l.id, 'title', l.title, 'text', l.text, 'effects', l.effects, 'funds', l.funds,
               'busy', (select b.status from faction_bills b where b.law_id = l.id and b.status in ('voting', 'active') limit 1),
               'retry_at', (select max(b.closed_at) + make_interval(hours => event_setting_int('law_retry_hours', 48)) from faction_bills b
                            where b.law_id = l.id and b.status = 'failed'
                              and b.closed_at > now() - make_interval(hours => event_setting_int('law_retry_hours', 48))))
             order by l.sort), '[]'::jsonb) from faction_laws l where l.faction = v_fac and l.active),
    'bills', (select coalesce(jsonb_agg(x order by x->>'status' desc, x->>'at'), '[]'::jsonb) from (
       select jsonb_build_object('id', b.id, 'law', b.law_id, 'title', l.title, 'text', l.text, 'effects', l.effects, 'funds', l.funds, 'mode', b.mode, 'status', b.status,
                'by', p.nickname, 'at', b.created_at, 'vote_ends', b.vote_ends_at, 'starts', b.starts_at, 'ends', b.ends_at,
                'yes', case when b.status = 'voting' then (select count(*) from faction_votes v where v.bill_id = b.id and v.yes) else b.yes end,
                'no', case when b.status = 'voting' then (select count(*) from faction_votes v where v.bill_id = b.id and not v.yes) else b.no end,
                'mine', (select v.yes from faction_votes v where v.bill_id = b.id and v.user_id = v_me)) x
       from faction_bills b join faction_laws l on l.id = b.law_id left join profiles p on p.id = b.proposed_by
       where b.faction = v_fac and b.status in ('voting', 'active')) q),
    'history', (select coalesce(jsonb_agg(x order by x->>'at' desc), '[]'::jsonb) from (
       select jsonb_build_object('id', b.id, 'title', l.title, 'mode', b.mode, 'status', b.status, 'by', p.nickname,
                'at', coalesce(case when b.status = 'expired' then b.ends_at end, b.closed_at, b.created_at), 'yes', b.yes, 'no', b.no, 'need', b.need) x
       from faction_bills b join faction_laws l on l.id = b.law_id left join profiles p on p.id = b.proposed_by
       where b.faction = v_fac and b.status in ('failed', 'expired')
       order by coalesce(b.closed_at, b.created_at) desc limit 8) q));
end;
$function$;

create or replace function public.law_propose(p_law text)
 returns jsonb language plpgsql security definer set search_path to 'public', 'pg_temp'
as $function$
declare v_me uuid := auth.uid(); v_fac text; l faction_laws; v_id uuid; v_retry timestamptz;
begin
  if v_me is null then raise exception 'Нужно войти'; end if;
  select faction into v_fac from profiles where id = v_me;
  if v_fac is null then raise exception 'Нет фракции'; end if;
  if not faction_power(v_me, v_fac, 'laws') then raise exception 'Законы предлагает лидер и те, кому он это поручил'; end if;
  perform pg_advisory_xact_lock(hashtext('faction_laws:' || v_fac));
  perform law_tick();
  select * into l from faction_laws where id = p_law and active;
  if not found or l.faction <> v_fac then raise exception 'Такого закона нет'; end if;
  if exists (select 1 from faction_bills where law_id = l.id and status = 'active') then raise exception 'Этот закон уже действует'; end if;
  if exists (select 1 from faction_bills where law_id = l.id and status = 'voting') then raise exception 'За этот закон уже голосуют'; end if;
  select max(closed_at) + make_interval(hours => event_setting_int('law_retry_hours', 48)) into v_retry
    from faction_bills where law_id = l.id and status = 'failed';
  if v_retry > now() then raise exception 'Закон недавно отклонили — снова можно через % ч', ceil(extract(epoch from v_retry - now()) / 3600)::integer; end if;
  if (select count(*) from faction_bills where faction = v_fac and status in ('voting', 'active')) >= event_setting_int('law_slots', 2) then
    raise exception 'Уже % закона — действующие и на голосовании. Новый — когда один из них закончится', event_setting_int('law_slots', 2);
  end if;
  if l.funds ? 'now' and coalesce((select credits from faction_treasury where faction = v_fac), 0) < 0 then
    raise exception 'Казна в долгу — новый заём не дадут, пока долг не погашен';
  end if;
  insert into faction_bills (faction, law_id, mode, status, proposed_by, vote_ends_at)
  values (v_fac, l.id, 'vote', 'voting', v_me, now() + make_interval(hours => event_setting_int('law_vote_hours', 48)))
  returning id into v_id;
  insert into faction_votes (bill_id, user_id, yes) values (v_id, v_me, true);
  perform law_notify(v_fac, v_me, 'law_proposed', l.title, jsonb_build_object('bill', v_id, 'law', l.id), v_me);
  -- во фракции один игрок — итог сразу
  if law_members(v_fac) <= 1 then perform law_close(v_id); end if;
  return law_state();
end;
$function$;

create or replace function public.law_vote(p_bill uuid, p_yes boolean)
 returns jsonb language plpgsql security definer set search_path to 'public', 'pg_temp'
as $function$
declare v_me uuid := auth.uid(); v_fac text; b faction_bills;
begin
  if v_me is null then raise exception 'Нужно войти'; end if;
  if p_yes is null then raise exception 'За или против?'; end if;
  select faction into v_fac from profiles where id = v_me;
  select * into b from faction_bills where id = p_bill for update;
  if not found or b.faction is distinct from v_fac then raise exception 'Голосование не найдено'; end if;
  if b.status <> 'voting' or b.vote_ends_at <= now() then raise exception 'Голосование уже закончилось'; end if;
  insert into faction_votes (bill_id, user_id, yes) values (b.id, v_me, p_yes)
  on conflict (bill_id, user_id) do update set yes = excluded.yes, at = now();
  -- проголосовали все активные — итог не ждёт срока
  if (select count(*) from faction_votes where bill_id = b.id) >= greatest(law_members(v_fac), 1) then perform law_close(b.id); end if;
  return law_state();
end;
$function$;

create or replace function public.law_decree(p_law text)
 returns jsonb language plpgsql security definer set search_path to 'public', 'pg_temp'
as $function$
declare v_me uuid := auth.uid(); v_fac text; l faction_laws; v_id uuid; v_next timestamptz;
begin
  if v_me is null then raise exception 'Нужно войти'; end if;
  select faction into v_fac from profiles where id = v_me;
  if v_fac is null or not is_faction_leader(v_me, v_fac) then raise exception 'Указ издаёт только лидер фракции'; end if;
  perform pg_advisory_xact_lock(hashtext('faction_laws:' || v_fac));
  perform law_tick();
  select * into l from faction_laws where id = p_law and active;
  if not found or l.faction <> v_fac then raise exception 'Такого закона нет'; end if;
  if l.funds is not null then raise exception 'Денежные законы принимает только голосование'; end if;
  select max(created_at) + make_interval(days => event_setting_int('law_decree_cooldown_days', 7)) into v_next
    from faction_bills where faction = v_fac and mode = 'decree';
  if v_next > now() then raise exception 'Следующий указ — через % ч', ceil(extract(epoch from v_next - now()) / 3600)::integer; end if;
  if exists (select 1 from faction_bills where law_id = l.id and status in ('voting', 'active')) then
    raise exception 'Этот закон уже действует или за него голосуют';
  end if;
  if (select count(*) from faction_bills where faction = v_fac and status in ('voting', 'active')) >= event_setting_int('law_slots', 2) then
    raise exception 'Уже % закона — действующие и на голосовании', event_setting_int('law_slots', 2);
  end if;
  insert into faction_bills (faction, law_id, mode, status, proposed_by, closed_at, starts_at, ends_at)
  values (v_fac, l.id, 'decree', 'active', v_me, now(), now(), now() + make_interval(hours => event_setting_int('law_decree_hours', 24)))
  returning id into v_id;
  perform law_enact(v_id);
  perform law_notify(v_fac, v_me, 'law_decree', l.title, jsonb_build_object('bill', v_id, 'law', l.id), v_me);
  return law_state();
end;
$function$;

do $$
declare f text;
begin
  foreach f in array array['law_members(text)', 'law_quorum(text)', 'law_notify(text, uuid, text, text, jsonb, uuid)', 'law_enact(uuid)',
                           'law_close(uuid)', 'law_tick()']
  loop execute format('revoke all on function public.%s from public, anon, authenticated', f); end loop;
  foreach f in array array['law_state()', 'law_propose(text)', 'law_vote(uuid, boolean)', 'law_decree(text)']
  loop execute format('revoke all on function public.%s from public, anon', f); execute format('grant execute on function public.%s to authenticated', f); end loop;
end $$;

-- ---------------------------------------------------------------- встраивание в старое
-- Правка тел функций заменой строки: строка не найдена — ошибка, ничего не меняется.
do $$
declare d text; n text;
begin
  -- найм бойцов: время × hire_time (после бонусов здания и мастерских)
  d := pg_get_functiondef('public.order_unit(uuid, text, integer, integer, integer, text[])'::regprocedure);
  if position('hire_time' in d) = 0 then
    n := replace(d, E'    v_seconds := greatest(5, round(v_seconds * (100 - (select effect_value from district_types where id = ''workshops'')) / 100.0)::integer);\n  end if;\n',
                    E'    v_seconds := greatest(5, round(v_seconds * (100 - (select effect_value from district_types where id = ''workshops'')) / 100.0)::integer);\n  end if;\n  -- законы фракции: ±% времени найма\n  v_seconds := greatest(5, round(v_seconds * (100 + effect_sum(v_system, ''hire_time'')) / 100.0)::integer);\n');
    if n = d then raise exception 'order_unit: место для эффекта не найдено'; end if;
    execute n;
  end if;
  -- верфь: время × hire_time
  d := pg_get_functiondef('public.order_ship'::regproc);
  if position('hire_time' in d) = 0 then
    n := replace(d, E'             + coalesce(array_length(p_upgrades, 1), 0) * 10;\n',
                    E'             + coalesce(array_length(p_upgrades, 1), 0) * 10;\n  -- законы фракции: ±% времени найма\n  v_seconds := greatest(5, round(v_seconds * (100 + effect_sum(p_system_id, ''hire_time'')) / 100.0)::integer);\n');
    if n = d then raise exception 'order_ship: место для эффекта не найдено'; end if;
    execute n;
  end if;
  -- стройка зданий: время × build_time
  d := pg_get_functiondef('public.construct_building(text, integer, uuid)'::regprocedure);
  if position('build_time' in d) = 0 then
    n := replace(d, E'  v_seconds := coalesce(v_seconds, 60);\n',
                    E'  v_seconds := coalesce(v_seconds, 60);\n  -- законы фракции: ±% времени стройки\n  v_seconds := greatest(5, round(v_seconds * (100 + effect_sum(p_system_id, ''build_time'')) / 100.0)::integer);\n');
    if n = d then raise exception 'construct_building: место для эффекта не найдено'; end if;
    execute n;
  end if;
end $$;

-- такт итогов
select cron.schedule('law-tick', '*/10 * * * *', 'select public.law_tick()');

-- Значок на кнопке «Фракция»: сколько голосований ждут моего голоса
create or replace function public.law_badge()
 returns integer language sql stable security definer set search_path to 'public', 'pg_temp'
as $function$
  select count(*)::integer from faction_bills b join profiles p on p.id = auth.uid() and p.faction = b.faction
  where b.status = 'voting' and b.vote_ends_at > now()
    and not exists (select 1 from faction_votes v where v.bill_id = b.id and v.user_id = p.id);
$function$;
revoke all on function public.law_badge() from public, anon;
grant execute on function public.law_badge() to authenticated;
