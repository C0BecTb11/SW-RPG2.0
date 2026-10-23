-- Казна фракции. План — claude/mechanics-plan.md, этап 3б. Применять после sql/laws.sql.
--
-- * faction_treasury — кредиты фракции (могут уйти в минус: это долг по займу).
-- * treasury_log — журнал, виден всей фракции: пожертвования, выдачи игрокам, проекты, налог, займы.
-- * treasury_projects — проекты казны на одну планету фракции: временный эффект в faction_effects
--   (system_id = планета, source = 'project:<id>'); один и тот же проект на планете — не чаще, чем идёт.
-- Пополняют: пожертвования игроков (от 100 кр.), налог с дохода поселений (закон с funds.tax —
--   settlement_tick после выплаты зовёт treasury_tax), займы (закон с funds.now / funds.end, см. laws.sql).
-- Тратят лидер и должности с полномочием «Казна» (treasury): проекты и выдача игрокам своей фракции.
-- Тратить можно только то, что есть: в минус казну уводит лишь расчёт по займу.

-- ---------------------------------------------------------------- настройки
insert into public.game_settings (key, value) values
  ('treasury_min_donate', '100'), ('treasury_min_grant', '50')
on conflict (key) do nothing;

-- ---------------------------------------------------------------- таблицы
create table if not exists public.faction_treasury (
  faction text primary key check (faction in ('republic', 'cis')),
  credits integer not null default 0,
  updated_at timestamptz not null default now()
);
create table if not exists public.treasury_log (
  id bigserial primary key,
  faction text not null,
  at timestamptz not null default now(),
  kind text not null check (kind in ('donate', 'grant', 'project', 'tax', 'law', 'debt')),
  amount integer not null,
  balance integer not null,
  user_id uuid,
  target_user uuid,
  system_id text,
  note text,
  n integer not null default 1                    -- налог: сколько планет в одной строке
);
create index if not exists treasury_log_fac on public.treasury_log (faction, at desc);
create table if not exists public.treasury_projects (
  id text primary key,
  title text not null,
  text text not null,
  kind text not null check (kind in ('mood', 'extract', 'income', 'hire_time', 'build_time')),
  value integer not null,
  hours integer not null,
  cost integer not null,
  sort integer not null default 0,
  active boolean not null default true
);

alter table public.faction_treasury enable row level security;
alter table public.treasury_log enable row level security;
alter table public.treasury_projects enable row level security;
revoke all on public.faction_treasury, public.treasury_log, public.treasury_projects from anon, authenticated;
revoke all on sequence public.treasury_log_id_seq from anon, authenticated;

insert into public.faction_treasury (faction) values ('republic'), ('cis') on conflict (faction) do nothing;

insert into public.event_types (type, category, title, tone, jumpable) values
  ('treasury_donate',  'faction', 'Взнос в казну', 'good', false),
  ('treasury_grant',   'faction', 'Выплата из казны', 'good', false),
  ('treasury_project', 'faction', 'Проект казны', 'neutral', false),
  ('treasury_debt',    'faction', 'Расчёт по займу', 'bad', false)
on conflict (type) do nothing;

insert into public.treasury_projects (id, title, text, kind, value, hours, cost, sort) values
  ('p_recruit',   'Призывной пункт',     'Казна оплачивает вербовщиков и транспорт: пополнение выходит быстрее.', 'hire_time',  -40, 24, 1500, 1),
  ('p_engineers', 'Инженерный батальон', 'На планету перебрасывают инженеров и технику — стройка идёт без простоев.', 'build_time', -40, 24, 1500, 2),
  ('p_survey',    'Геологоразведка',     'Разведка новых жил и ремонт буровых — добыча растёт на двое суток.', 'extract', 25, 48, 1200, 3),
  ('p_fair',      'Торговая ярмарка',    'Ярмарка собирает купцов со всего сектора — поселение богатеет.', 'income', 25, 48, 1000, 4),
  ('p_festival',  'Праздник для жителей', 'Угощение, музыка и парад гарнизона — жители довольны.', 'mood', 15, 48, 800, 5)
on conflict (id) do update set title = excluded.title, text = excluded.text, kind = excluded.kind, value = excluded.value,
  hours = excluded.hours, cost = excluded.cost, sort = excluded.sort, active = true;

-- ---------------------------------------------------------------- служебное
-- Движение по казне: новый остаток + строка журнала
create or replace function public.treasury_add(p_faction text, p_amount integer, p_kind text, p_user uuid, p_target uuid, p_system text, p_note text)
 returns integer language plpgsql security definer set search_path to 'public', 'pg_temp'
as $function$
declare v_bal integer;
begin
  insert into faction_treasury (faction, credits) values (p_faction, p_amount)
  on conflict (faction) do update set credits = faction_treasury.credits + excluded.credits, updated_at = now()
  returning credits into v_bal;
  insert into treasury_log (faction, kind, amount, balance, user_id, target_user, system_id, note)
  values (p_faction, p_kind, p_amount, v_bal, p_user, p_target, p_system, p_note);
  return v_bal;
end;
$function$;

-- Налог с дохода поселения (зовёт settlement_tick после выплаты). Строки одной выдачи склеиваются.
create or replace function public.treasury_tax(p_faction text, p_system text, p_income integer)
 returns integer language plpgsql security definer set search_path to 'public', 'pg_temp'
as $function$
declare v_pct integer; v_amt integer; v_bal integer; v_id bigint;
begin
  if p_faction is null or coalesce(p_income, 0) <= 0 then return 0; end if;
  select coalesce(sum((l.funds->>'tax')::integer), 0) into v_pct
  from faction_bills b join faction_laws l on l.id = b.law_id
  where b.faction = p_faction and b.status = 'active' and b.starts_at <= now() and b.ends_at > now() and l.funds ? 'tax';
  if v_pct <= 0 then return 0; end if;
  v_amt := round(p_income * least(v_pct, 50) / 100.0)::integer;
  if v_amt <= 0 then return 0; end if;
  insert into faction_treasury (faction, credits) values (p_faction, v_amt)
  on conflict (faction) do update set credits = faction_treasury.credits + excluded.credits, updated_at = now()
  returning credits into v_bal;
  update treasury_log set amount = amount + v_amt, balance = v_bal, n = n + 1, at = now()
   where id = (select id from treasury_log where faction = p_faction and kind = 'tax' and at > now() - interval '30 minutes' order by at desc limit 1)
  returning id into v_id;
  if v_id is null then
    insert into treasury_log (faction, kind, amount, balance, note) values (p_faction, 'tax', v_amt, v_bal, v_pct || '%');
  end if;
  return v_amt;
end;
$function$;

-- ---------------------------------------------------------------- игроку
create or replace function public.treasury_state()
 returns jsonb language plpgsql security definer set search_path to 'public', 'pg_temp'
as $function$
declare v_me uuid := auth.uid(); v_fac text; v_spend boolean;
begin
  if v_me is null then raise exception 'Нужно войти'; end if;
  select faction into v_fac from profiles where id = v_me;
  if v_fac is null then return jsonb_build_object('faction', null); end if;
  v_spend := faction_power(v_me, v_fac, 'treasury');
  return jsonb_build_object(
    'faction', v_fac, 'now', now(),
    'balance', coalesce((select credits from faction_treasury where faction = v_fac), 0),
    'can_spend', v_spend, 'is_leader', is_faction_leader(v_me, v_fac),
    'credits', (select credits from profiles where id = v_me),
    'min_donate', event_setting_int('treasury_min_donate', 100), 'min_grant', event_setting_int('treasury_min_grant', 50),
    'tax', (select coalesce(sum((l.funds->>'tax')::integer), 0) from faction_bills b join faction_laws l on l.id = b.law_id
            where b.faction = v_fac and b.status = 'active' and b.ends_at > now() and l.funds ? 'tax'),
    'debts', (select coalesce(jsonb_agg(jsonb_build_object('title', l.title, 'amount', (l.funds->>'end')::integer, 'at', b.ends_at) order by b.ends_at), '[]'::jsonb)
              from faction_bills b join faction_laws l on l.id = b.law_id
              where b.faction = v_fac and b.status = 'active' and b.ends_at > now() and l.funds ? 'end'),
    'projects', (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'title', p.title, 'text', p.text, 'kind', p.kind, 'value', p.value,
                   'hours', p.hours, 'cost', p.cost) order by p.sort), '[]'::jsonb) from treasury_projects p where p.active),
    'planets', (select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'owner', pr.nickname, 'mine', sc.controller_user_id = v_me,
                   'running', (select coalesce(jsonb_agg(jsonb_build_object('project', substr(fe.source, 9), 'title', fe.title, 'ends', fe.ends_at)), '[]'::jsonb)
                               from faction_effects fe where fe.system_id = s.id and fe.faction = v_fac and fe.source like 'project:%' and fe.ends_at > now()))
                 order by (sc.controller_user_id = v_me) desc nulls last, s.name), '[]'::jsonb)
                from systems s left join system_control sc on sc.system_id = s.id left join profiles pr on pr.id = sc.controller_user_id
                where s.faction = v_fac and not coalesce(s.is_deep_space, false)),
    'members', case when v_spend then (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'nick', p.nickname) order by lower(p.nickname)), '[]'::jsonb)
                from profiles p where p.faction = v_fac and p.id <> v_me and p.nickname is not null) else '[]'::jsonb end,
    'log', (select coalesce(jsonb_agg(x order by (x->>'id')::bigint desc), '[]'::jsonb) from (
       select jsonb_build_object('id', t.id, 'at', t.at, 'kind', t.kind, 'amount', t.amount, 'balance', t.balance, 'by', a.nickname, 'to', b.nickname,
                'planet', s.name, 'note', t.note, 'n', t.n) x
       from treasury_log t left join profiles a on a.id = t.user_id left join profiles b on b.id = t.target_user left join systems s on s.id = t.system_id
       where t.faction = v_fac order by t.id desc limit 30) q));
end;
$function$;

create or replace function public.treasury_donate(p_amount integer)
 returns jsonb language plpgsql security definer set search_path to 'public', 'pg_temp'
as $function$
declare v_me uuid := auth.uid(); v_fac text; v_cr integer; v_min integer := event_setting_int('treasury_min_donate', 100);
begin
  if v_me is null then raise exception 'Нужно войти'; end if;
  select faction, credits into v_fac, v_cr from profiles where id = v_me for update;
  if v_fac is null then raise exception 'Нет фракции'; end if;
  if p_amount is null or p_amount < v_min then raise exception 'Взнос — от % кр.', v_min; end if;
  if p_amount > 1000000 then raise exception 'Слишком большая сумма'; end if;
  if v_cr < p_amount then raise exception 'Не хватает кредитов: есть %', v_cr; end if;
  update profiles set credits = credits - p_amount where id = v_me;
  perform treasury_add(v_fac, p_amount, 'donate', v_me, null, null, null);
  perform log_event(v_me, v_fac, null, 'treasury_donate', null, p_amount, 'faction', null);
  return treasury_state();
end;
$function$;

create or replace function public.treasury_grant(p_user uuid, p_amount integer, p_note text default null)
 returns jsonb language plpgsql security definer set search_path to 'public', 'pg_temp'
as $function$
declare v_me uuid := auth.uid(); v_fac text; v_bal integer; v_to text; v_nick text; v_note text := nullif(btrim(coalesce(p_note, '')), '');
        v_min integer := event_setting_int('treasury_min_grant', 50);
begin
  if v_me is null then raise exception 'Нужно войти'; end if;
  select faction into v_fac from profiles where id = v_me;
  if v_fac is null or not faction_power(v_me, v_fac, 'treasury') then raise exception 'Казной распоряжается лидер и те, кому он это поручил'; end if;
  if p_user is null or p_user = v_me then raise exception 'Выбери другого игрока'; end if;
  select faction, nickname into v_to, v_nick from profiles where id = p_user;
  if v_to is distinct from v_fac then raise exception 'Игрок не из твоей фракции'; end if;
  if p_amount is null or p_amount < v_min then raise exception 'Выплата — от % кр.', v_min; end if;
  if v_note is not null and char_length(v_note) > 60 then raise exception 'Пометка — до 60 знаков'; end if;
  select credits into v_bal from faction_treasury where faction = v_fac for update;
  if coalesce(v_bal, 0) < p_amount then raise exception 'В казне только % кр.', greatest(coalesce(v_bal, 0), 0); end if;
  update profiles set credits = credits + p_amount where id = p_user;
  perform treasury_add(v_fac, -p_amount, 'grant', v_me, p_user, null, v_note);
  perform log_event(v_me, v_fac, null, 'treasury_grant', v_nick, p_amount, 'faction', jsonb_build_object('to', v_nick, 'note', v_note));
  perform log_event(p_user, v_fac, null, 'treasury_grant', coalesce(v_note, 'из казны фракции'), p_amount, 'private', jsonb_build_object('note', v_note));
  return treasury_state();
end;
$function$;

create or replace function public.treasury_project(p_project text, p_system text)
 returns jsonb language plpgsql security definer set search_path to 'public', 'pg_temp'
as $function$
declare v_me uuid := auth.uid(); v_fac text; p treasury_projects; v_bal integer; v_sys record; v_ctrl uuid;
begin
  if v_me is null then raise exception 'Нужно войти'; end if;
  select faction into v_fac from profiles where id = v_me;
  if v_fac is null or not faction_power(v_me, v_fac, 'treasury') then raise exception 'Казной распоряжается лидер и те, кому он это поручил'; end if;
  select * into p from treasury_projects where id = p_project and active;
  if not found then raise exception 'Такого проекта нет'; end if;
  select id, name, faction, coalesce(is_deep_space, false) deep into v_sys from systems where id = p_system;
  if not found or v_sys.faction is distinct from v_fac or v_sys.deep then raise exception 'Проект — только на планете своей фракции'; end if;
  select credits into v_bal from faction_treasury where faction = v_fac for update;
  if exists (select 1 from faction_effects where system_id = p_system and faction = v_fac and source = 'project:' || p.id and ends_at > now()) then
    raise exception '«%» на этой планете уже идёт', p.title;
  end if;
  if coalesce(v_bal, 0) < p.cost then raise exception 'В казне только % кр. — нужно %', greatest(coalesce(v_bal, 0), 0), p.cost; end if;
  insert into faction_effects (faction, kind, value, title, source, system_id, starts_at, ends_at)
  values (v_fac, p.kind, p.value, p.title, 'project:' || p.id, p_system, now(), now() + make_interval(hours => p.hours));
  perform treasury_add(v_fac, -p.cost, 'project', v_me, null, p_system, p.title);
  perform log_event(v_me, v_fac, p_system, 'treasury_project', p.title, p.cost, 'faction', jsonb_build_object('project', p.id));
  select controller_user_id into v_ctrl from system_control where system_id = p_system;
  if v_ctrl is not null and v_ctrl <> v_me then
    perform log_event(v_ctrl, v_fac, p_system, 'treasury_project', p.title, p.cost, 'private', jsonb_build_object('project', p.id));
  end if;
  return treasury_state();
end;
$function$;

do $$
declare f text;
begin
  foreach f in array array['treasury_add(text, integer, text, uuid, uuid, text, text)', 'treasury_tax(text, text, integer)']
  loop execute format('revoke all on function public.%s from public, anon, authenticated', f); end loop;
  foreach f in array array['treasury_state()', 'treasury_donate(integer)', 'treasury_grant(uuid, integer, text)', 'treasury_project(text, text)']
  loop execute format('revoke all on function public.%s from public, anon', f); execute format('grant execute on function public.%s to authenticated', f); end loop;
end $$;

-- ---------------------------------------------------------------- встраивание в старое
-- Налог — сразу после выплаты дохода поселения. Сбой казны выплату не срывает.
do $$
declare d text; n text;
begin
  d := pg_get_functiondef('public.settlement_tick()'::regprocedure);
  if position('treasury_tax' in d) = 0 then
    n := replace(d, E'      update profiles set credits = credits + v_income where id = v_controller;\n',
                    E'      update profiles set credits = credits + v_income where id = v_controller;\n      -- закон о налоге: доля дохода — в казну фракции\n      begin perform treasury_tax(sys.faction, sys.id, v_income); exception when others then null; end;\n');
    if n = d then raise exception 'settlement_tick: место для налога не найдено'; end if;
    execute n;
  end if;
end $$;
