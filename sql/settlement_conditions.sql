-- ⚠ НЕ ПРИМЕНЯТЬ ПОВТОРНО ЦЕЛИКОМ (аудит 25.10.2026). Файл устарел относительно базы: его прогон откатит
--   unrest_faction — потеряются мятежи и штрафы (sql/unrest_riot.sql).
--   Нужна функция отсюда — бери её текущую версию из базы (pg_get_functiondef), а не из этого файла.
-- Условия поселений: на виду, частичный зачёт, налёты вечером с самообороной, без лазарета на день,
-- ничьим — без условий и с падением довольства, лидеру — ушедшие управляющие (решения Артёма 23.10,
-- claude/rebellion-plan.md, раздел 2.1).
--
--  1. Зачёт по каждому условию: выполнено +settlement_task_gain (5), провалено −settlement_task_loss (4),
--     все — ещё +settlement_task_bonus (5). Было: все +15, любой провал −10.
--  2. Без управляющего условий нет, довольство падает на settlement_no_ruler_penalty (10) в сутки,
--     и в итоговом довольстве — строка «Нет управляющего −10». Назначили днём — условия выдаются сразу.
--  3. Налёт мародёров — вечером (marauder_window_start 18 … marauder_window_end 23 по серверу).
--     Самооборона: на планете нет живого боя, а своих бойцов в зоне поселения не меньше, чем налётчиков, —
--     гарнизон отбивает налёт сам, условие выполнено.
--  4. Лазарет больше не выдаётся условием дня.
--  5. Сводка условий своей фракции (unrest_faction: cond, seen_days, is_leader) — только своим;
--     утром — строка в ленту управляющему (условия всех его планет), вечером (за 8 ч до выдачи) —
--     напоминание, если что-то не сделано. Лидер может снять управляющего (leader_revoke_planet).

insert into public.game_settings (key, value) values
  ('settlement_task_gain', '5'),
  ('settlement_task_loss', '4'),
  ('settlement_task_bonus', '5'),
  ('settlement_no_ruler_penalty', '10'),
  ('settlement_remind_before_hours', '8'),
  ('settlement_morning_hours', '3')
on conflict (key) do nothing;
update public.game_settings set value = '18' where key = 'marauder_window_start';
update public.game_settings set value = '23' where key = 'marauder_window_end';

insert into public.event_types (type, category, title, tone, jumpable) values
  ('settlement_conditions', 'faction', 'Условия поселений на сутки', 'neutral', true),
  ('settlement_remind',     'faction', 'Не выполнены условия поселений', 'bad', true)
on conflict (type) do update set category = excluded.category, title = excluded.title, tone = excluded.tone, jumpable = excluded.jumpable;

-- Кому и что уже сказано за эти сутки (утро / вечер)
create table if not exists public.settlement_notices (
  user_id uuid not null,
  cycle   timestamptz not null,
  kind    text not null,
  at      timestamptz not null default now(),
  primary key (user_id, cycle, kind)
);
alter table public.settlement_notices enable row level security;
revoke all on public.settlement_notices from anon, authenticated;

-- Короткая подпись условия для галактики и ленты
create or replace function public.settlement_task_label(p_kind text, p_target integer, p_payload jsonb)
 returns text language sql stable set search_path to 'public', 'pg_temp'
as $function$
  select case p_kind
    when 'guard'     then 'охрана: ' || p_target || ' пех. на площади'
    when 'patrol'    then 'патруль: ' || p_target || ' техн. в поселении'
    when 'orbit'     then 'корабль в площадке сброса'
    when 'marauder'  then case coalesce(p_payload ->> 'stage', '')
                            when 'raid' then 'налёт идёт — отбить'
                            when 'scouted' then 'налёт около ' || to_char(((p_payload ->> 'raid_at')::timestamptz) at time zone server_tz(), 'HH24:MI')
                            when 'warned' then 'налёт около ' || to_char(((p_payload ->> 'raid_at')::timestamptz) at time zone server_tz(), 'HH24:MI')
                            else 'налёт мародёров' end
    when 'donation'  then 'пожертвование ' || p_target || ' кр.'
    when 'festival'  then 'праздник ' || p_target || ' кр.'
    when 'factories' then 'заводов не больше ' || p_target
    when 'medical'   then 'лазарет'
    else p_kind end;
$function$;

-- Условия планеты на текущие сутки: всего, выполнено, что осталось
create or replace function public.settlement_cond(p_system text)
 returns jsonb language plpgsql stable security definer set search_path to 'public', 'pg_temp'
as $function$
declare v_total integer := 0; v_done integer := 0; v_left jsonb := '[]'::jsonb; t record; d boolean;
begin
  for t in select tk.id, tk.kind, tk.target, tk.payload from settlement_tasks tk
             join settlement_state st on st.system_id = tk.system_id and st.cycle_started = tk.cycle_start
            where tk.system_id = p_system order by tk.kind loop
    v_total := v_total + 1;
    d := settlement_task_done(t.id);
    if d then v_done := v_done + 1;
    else v_left := v_left || to_jsonb(settlement_task_label(t.kind, t.target, t.payload)); end if;
  end loop;
  return jsonb_build_object('total', v_total, 'done', v_done, 'left', v_left);
end;
$function$;
revoke execute on function public.settlement_cond(text) from anon, authenticated;

-- 1 и 4: условия только планетам с управляющим, без лазарета
do $do$
declare d text;
begin
  d := pg_get_functiondef('public.issue_settlement_tasks(text, timestamptz)'::regprocedure);
  if position('settlement_conditions.sql' in d) > 0 then return; end if;
  if position($a$begin
  insert into settlement_tasks (system_id, cycle_start, kind, target)
  values (p_system_id, p_cycle, 'guard'$a$ in d) = 0 then raise exception 'issue_settlement_tasks: начало не найдено'; end if;
  if position($a$  if v_medical = 0 then v_pool := array_append(v_pool, 'medical'); end if;
$a$ in d) = 0 then raise exception 'issue_settlement_tasks: строка лазарета не найдена'; end if;
  d := replace(d, $a$begin
  insert into settlement_tasks (system_id, cycle_start, kind, target)
  values (p_system_id, p_cycle, 'guard'$a$, $a$begin
  -- без управляющего условий нет: довольство падает само (sql/settlement_conditions.sql)
  if not exists (select 1 from system_control c where c.system_id = p_system_id and c.controller_user_id is not null) then
    return;
  end if;
  insert into settlement_tasks (system_id, cycle_start, kind, target)
  values (p_system_id, p_cycle, 'guard'$a$);
  -- лазарет — стройка здания, а не дело на день (sql/settlement_conditions.sql)
  d := replace(d, $a$  if v_medical = 0 then v_pool := array_append(v_pool, 'medical'); end if;
$a$, '');
  execute d;
end $do$;

-- 1 и 2: частичный зачёт, падение без управляющего, строка в сводке доходов
do $do$
declare d text; a text; b text;
begin
  d := pg_get_functiondef('public.settlement_tick()'::regprocedure);
  if position('settlement_task_gain' in d) > 0 then return; end if;
  a := $a$    -- Всё сделал — растёт, что-то провалил — падает. Ниже нуля не уходит:
    -- минимальный доход поселение платит всегда.
    if v_total > 0 then
      if v_done = v_total then
        update settlement_state set satisfaction = least(v_max, satisfaction + v_step)
        where system_id = sys.id;
      else
        update settlement_state set satisfaction = greatest(0, satisfaction - v_pen)
        where system_id = sys.id;
      end if;
    end if;$a$;
  b := $a$    -- Каждое условие в зачёт: выполнено +gain, провалено −loss, все — ещё +bonus
    -- (sql/settlement_conditions.sql). Без управляющего условий нет, довольство падает.
    -- Ниже нуля не уходит: минимальный доход поселение платит всегда.
    if v_total > 0 then
      update settlement_state set satisfaction = least(v_max, greatest(0, satisfaction
          + v_done * game_setting_int('settlement_task_gain', 5)
          - (v_total - v_done) * game_setting_int('settlement_task_loss', 4)
          + case when v_done = v_total then game_setting_int('settlement_task_bonus', 5) else 0 end))
      where system_id = sys.id;
    elsif not exists (select 1 from system_control c where c.system_id = sys.id and c.controller_user_id is not null) then
      update settlement_state set satisfaction = greatest(0, satisfaction - game_setting_int('settlement_no_ruler_penalty', 10))
      where system_id = sys.id;
    end if;$a$;
  if position(a in d) = 0 then raise exception 'settlement_tick: блок зачёта не найден'; end if;
  d := replace(d, a, b);
  a := $a$case when v_done < v_total then ' — провал' else '' end$a$;
  if position(a in d) = 0 then raise exception 'settlement_tick: строка сводки не найдена'; end if;
  d := replace(d, a, $a$case when v_done < v_total then ' — частично' else ' — все' end$a$);
  execute d;
end $do$;

-- 2: строка «Нет управляющего» в итоговом довольстве
do $do$
declare d text; a text;
begin
  d := pg_get_functiondef('public.settlement_factors(text)'::regprocedure);
  if position('Нет управляющего' in d) > 0 then return; end if;
  a := $a$  label := 'Выполненные условия'; value := coalesce(st.satisfaction, 0); return next;
$a$;
  if position(a in d) = 0 then raise exception 'settlement_factors: первая строка не найдена'; end if;
  d := replace(d, a, a || $a$
  if not exists (select 1 from system_control c where c.system_id = p_system and c.controller_user_id is not null) then
    label := 'Нет управляющего'; value := -game_setting_int('settlement_no_ruler_penalty', 10); return next;
  end if;
$a$);
  execute d;
end $do$;

-- 3: самооборона гарнизона при налёте
do $do$
declare d text; a text;
begin
  d := pg_get_functiondef('public.marauder_raid_tick()'::regprocedure);
  if position('Гарнизон отбил налёт' in d) > 0 then return; end if;
  a := $a$    elsif v_stage = 'raid' then
      select count(*) into v_alive from unit_positions u where u.id = any(v_ids) and u.hp > 0;
$a$;
  if position(a in d) = 0 then raise exception 'marauder_raid_tick: ветка налёта не найдена'; end if;
  d := replace(d, a, a || $a$      -- Самооборона (sql/settlement_conditions.sql): на планете нет живого боя, а своих бойцов в зоне
      -- поселения не меньше, чем налётчиков, — гарнизон отбивает налёт сам, условие выполнено
      if v_alive > 0
         and not exists (select 1 from rt_battles rb where rb.system_id = t.system_id and rb.status = 'active'
                            and rb.heartbeat_at > now() - interval '2 minutes')
         and (select count(*) from unit_positions g join systems gs on gs.id = g.system_id
               where g.system_id = t.system_id and g.layer = 'ground' and g.hp > 0 and g.x is not null
                 and g.carrier_ship_id is null and g.owner_user_id is not null and g.faction = gs.faction
                 and is_in_settlement_zone(g.x, g.y)) >= v_alive then
        update unit_positions set hp = 0 where id = any(v_ids) and hp > 0;
        update npc_brains set state = 'leave' where unit_id = any(v_ids);
        update settlement_tasks
        set payload = payload || jsonb_build_object('stage', 'defeated', 'garrison', true, 'ended_at', now())
        where id = t.id;
        perform marauder_notify(t.system_id, 'marauder_defeated', 'Гарнизон отбил налёт · условие выполнено', 1,
                                jsonb_build_object('count', cardinality(v_ids), 'garrison', true), true);
        v_acts := v_acts + 1;
        continue;
      end if;
$a$);
  execute d;
end $do$;

-- 2: назначили управляющего днём — условия на текущие сутки сразу
create or replace function public.settlement_tasks_on_assign()
 returns trigger language plpgsql security definer set search_path to 'public', 'pg_temp'
as $function$
declare v_cycle timestamptz;
begin
  if new.controller_user_id is null then return null; end if;
  if tg_op = 'UPDATE' and old.controller_user_id is not null then return null; end if;
  select cycle_started into v_cycle from settlement_state where system_id = new.system_id;
  if v_cycle is null then return null; end if;
  if exists (select 1 from settlement_tasks where system_id = new.system_id and cycle_start = v_cycle) then return null; end if;
  perform issue_settlement_tasks(new.system_id, v_cycle);
  return null;
end;
$function$;
do $do$
begin
  if not exists (select 1 from pg_trigger where tgname = 'z_settlement_tasks_on_assign') then
    create trigger z_settlement_tasks_on_assign after insert or update of controller_user_id on public.system_control
      for each row execute function public.settlement_tasks_on_assign();
  end if;
end $do$;

-- 5: лидер снимает управляющего (планета становится ничьей; старому управляющему — «планета снята»)
create or replace function public.leader_revoke_planet(p_system text)
 returns boolean language plpgsql security definer set search_path to 'public', 'pg_temp'
as $function$
declare v_me uuid := auth.uid(); v_fac text; v_ctl uuid;
begin
  select faction into v_fac from profiles where id = v_me;
  if v_fac is null or not is_faction_leader(v_me, v_fac) then raise exception 'Снять управляющего может только лидер фракции'; end if;
  if (select faction from systems where id = p_system) is distinct from v_fac then raise exception 'Это не планета твоей фракции'; end if;
  select controller_user_id into v_ctl from system_control where system_id = p_system for update;
  if v_ctl is null then raise exception 'У планеты нет управляющего'; end if;
  if is_capture_active(p_system) then raise exception 'Идёт захват — управляющего не меняют'; end if;
  update system_control set controller_user_id = null where system_id = p_system;
  return true;
end;
$function$;
grant execute on function public.leader_revoke_planet(text) to authenticated;

-- 5: утренняя сводка и вечернее напоминание (pg_cron settlement-notice-tick, раз в 10 минут)
create or replace function public.settlement_notice_tick()
 returns integer language plpgsql security definer set search_path to 'public', 'pg_temp'
as $function$
declare
  v_cycle timestamptz := last_payout_at(); v_next timestamptz := next_payout_at(); u record; v_n integer := 0;
  v_kind text; v_list jsonb; v_left integer; v_one text; v_title text;
begin
  if now() < v_cycle + make_interval(hours => game_setting_int('settlement_morning_hours', 3)) then v_kind := 'morning';
  elsif now() >= v_next - make_interval(hours => game_setting_int('settlement_remind_before_hours', 8)) then v_kind := 'evening';
  else return 0; end if;

  for u in select sc.controller_user_id uid, s.faction from system_control sc join systems s on s.id = sc.system_id
            where sc.controller_user_id is not null group by 1, 2 loop
    -- уже сказано за эти сутки
    continue when exists (select 1 from settlement_notices n where n.user_id = u.uid and n.cycle = v_cycle and n.kind = v_kind);
    select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'total', (c ->> 'total')::integer,
                                                 'done', (c ->> 'done')::integer, 'left', c -> 'left') order by s.name), '[]'::jsonb)
      into v_list
      from system_control sc join systems s on s.id = sc.system_id
      join settlement_state st on st.system_id = s.id and st.cycle_started = v_cycle
      cross join lateral (select settlement_cond(s.id) c) q
     where sc.controller_user_id = u.uid and (q.c ->> 'total')::integer > 0;
    continue when jsonb_array_length(v_list) = 0;        -- условия этих суток ещё не выданы
    select coalesce(sum(jsonb_array_length(x -> 'left')), 0) into v_left from jsonb_array_elements(v_list) x;
    insert into settlement_notices (user_id, cycle, kind) values (u.uid, v_cycle, v_kind) on conflict do nothing;
    continue when v_kind = 'evening' and v_left = 0;      -- всё сделано — напоминать нечего
    v_one := case when jsonb_array_length(v_list) = 1 then v_list -> 0 ->> 'id' end;
    v_title := case when v_kind = 'morning'
      then 'Условия на сутки: ' || ru_plural(jsonb_array_length(v_list), 'планета', 'планеты', 'планет')
      else 'До итогов ' || game_setting_int('settlement_remind_before_hours', 8) || ' ч · не выполнено ' || v_left end;
    perform log_event(u.uid, u.faction, v_one, case when v_kind = 'morning' then 'settlement_conditions' else 'settlement_remind' end,
                      v_title, v_left, 'private', jsonb_build_object('planets', v_list, 'ends', v_next, 'digest', true,
                        'lines', (select coalesce(jsonb_agg(jsonb_build_object('txt', x ->> 'name' || ': ' ||
                                   case when jsonb_array_length(x -> 'left') = 0 then 'всё выполнено'
                                        else (select string_agg(l, ', ') from jsonb_array_elements_text(x -> 'left') l) end)), '[]'::jsonb)
                                  from jsonb_array_elements(v_list) x)));
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$function$;
revoke execute on function public.settlement_notice_tick() from anon, authenticated;

do $do$
begin
  if not exists (select 1 from cron.job where jobname = 'settlement-notice-tick') then
    perform cron.schedule('settlement-notice-tick', '*/10 * * * *', 'select public.settlement_notice_tick()');
  end if;
end $do$;

-- 5: окно фракции и карточки планет — напряжение, условия суток, давно ли заходил управляющий
create or replace function public.unrest_faction()
 returns jsonb language plpgsql stable security definer set search_path to 'public', 'pg_temp'
as $function$
declare v_me uuid := auth.uid(); v_fac text; v_out jsonb;
begin
  select faction into v_fac from profiles where id = v_me;
  if v_fac is null then return null; end if;
  select coalesce(jsonb_agg(r order by (r ->> 'value')::integer desc, r ->> 'name'), '[]'::jsonb) into v_out from (
    select jsonb_build_object('id', s.id, 'name', s.name, 'value', coalesce(u.value, 0),
             'state', unrest_state_of(coalesce(u.value, 0)), 'last_delta', u.last_delta,
             'forecast', (c ->> 'delta')::integer, 'cap', (c ->> 'cap')::integer, 'hold', c ->> 'hold',
             'controller', p.nickname, 'mine', sc.controller_user_id = v_me,
             'seen_days', case when p.id is not null then floor(extract(epoch from now() - coalesce(p.last_seen_at, p.created_at)) / 86400)::integer end,
             'cond', settlement_cond(s.id)) r
      from systems s
      left join settlement_unrest u on u.system_id = s.id
      left join system_control sc on sc.system_id = s.id
      left join profiles p on p.id = sc.controller_user_id
      cross join lateral (select unrest_calc(s.id) c) q
     where s.faction = v_fac and not coalesce(s.is_deep_space, false)) z;
  return jsonb_build_object('faction', v_fac, 'enabled', game_setting_int('unrest_enabled', 1) = 1, 'observe', true,
                            'planets', v_out, 'next_at', next_payout_at(), 'is_leader', is_faction_leader(v_me, v_fac),
                            'gain', game_setting_int('settlement_task_gain', 5), 'loss', game_setting_int('settlement_task_loss', 4),
                            'bonus', game_setting_int('settlement_task_bonus', 5), 'no_ruler', game_setting_int('settlement_no_ruler_penalty', 10));
end;
$function$;
