-- Донесения с участков и цехов — шаг 4в (24.10.2026). План — claude/sabotage-plan.md, раздел «4в».
--
-- Та же система донесений (report_catalog, player_reports, report_choose/report_apply, окно js/reports.js), но донесение
-- привязано к участку (player_reports.building_id) и его исходы бьют по участку: fx.mine =
--   { wear: ±N, prep: N (к следующей смене добычи), vein: часы жилы, hurt: [{ k: 'h'|'d', n | pct, h: часы, why: rush|strike|virus }] }.
-- Пять донесений категории 'site' (общий пул report_pick их пропускает; side в каталоге обязателен — стоит 'republic', но
-- доставка своя и сторону не смотрит, тексты нейтральные): обвал (добыча) / авария на линии (цех), премия (есть люди),
-- жила (добыча, жилы нет), сбой дроидов (есть дроиды). Не больше одного в сутки на игрока, шанс 40 %, в часы донесений.

alter table public.player_reports add column if not exists building_id uuid;

insert into public.game_settings (key, value) values ('mine_report_pct', '40') on conflict (key) do nothing;

insert into public.report_catalog (id, side, cat, chain, w, def, active, data) values
('s_cave_in', 'republic', 'site', false, 1, 2, true, $j${
  "title": "Обвал в забое",
  "text": "На участке «{site}» {planet} обвалилась кровля забоя. Инструмент под завалом, часть бригады отрезана — ждут решения.",
  "opts": [
    {"label": "Разбирать вручную", "cost": {"cr": 150}, "risk": "sure", "bad": 0,
     "outs": [{"p": 1, "fx": {}, "text": "Завал разобрали за смену, все целы."}]},
    {"label": "Пустить дроидов", "cost": null, "risk": "luck", "bad": 60,
     "outs": [{"p": 4, "fx": {}, "text": "Дроиды расчистили забой без потерь."},
              {"p": 6, "fx": {"mine": {"hurt": [{"k": "d", "n": 2, "h": 8, "why": "rush"}]}}, "text": "Завал разобрали, но дроидов придавило — до двух в ремонте 8 ч."}]},
    {"label": "Закрыть забой", "cost": null, "risk": "risky", "bad": 100,
     "outs": [{"p": 1, "fx": {"mine": {"wear": 15}}, "text": "Забой стоит под завалом, оборудование ржавеет: износ +15 %."}]}
  ]}$j$::jsonb),
('s_line_fault', 'republic', 'site', false, 1, 2, true, $j${
  "title": "Авария на линии",
  "text": "В цехе «{site}» {planet} заклинило подачу: линия дымит, мастер просит остановить её на ремонт.",
  "opts": [
    {"label": "Остановить и починить", "cost": {"cr": 150}, "risk": "sure", "bad": 0,
     "outs": [{"p": 1, "fx": {}, "text": "Линию перебрали, работает ровно."}]},
    {"label": "Чинить на ходу", "cost": null, "risk": "luck", "bad": 50,
     "outs": [{"p": 5, "fx": {}, "text": "Обошлось: подачу поправили на ходу."},
              {"p": 5, "fx": {"mine": {"wear": 10}}, "text": "Подачу поправили, но станки побились: износ +10 %."}]},
    {"label": "Ждать техников", "cost": null, "risk": "risky", "bad": 100,
     "outs": [{"p": 1, "fx": {"mine": {"wear": 15}}, "text": "Пока ждали, линия выгорела: износ +15 %."}]}
  ]}$j$::jsonb),
('s_bonus', 'republic', 'site', false, 1, 2, true, $j${
  "title": "Бригада просит премию",
  "text": "Бригада участка «{site}» {planet} требует премию за переработки — иначе грозит выйти за ворота.",
  "opts": [
    {"label": "Выплатить", "cost": {"cr": 200}, "risk": "sure", "bad": 0,
     "outs": [{"p": 1, "fx": {"mine": {"prep": 25}}, "text": "Бригада довольна и работает с огоньком: следующая смена +25 %."}]},
    {"label": "Пообещать к выдаче", "cost": null, "risk": "luck", "bad": 40,
     "outs": [{"p": 6, "fx": {}, "text": "Поверили на слово и вернулись к работе."},
              {"p": 4, "fx": {"mine": {"hurt": [{"k": "h", "pct": 100, "h": 4, "why": "strike"}]}}, "text": "Не поверили: люди бастуют 4 ч."}]},
    {"label": "Отказать", "cost": null, "risk": "risky", "bad": 100,
     "outs": [{"p": 1, "fx": {"mine": {"hurt": [{"k": "h", "pct": 100, "h": 6, "why": "strike"}]}, "mood": [-3, 24]}, "text": "Бригада бастует 6 ч, в посёлке ворчат."}]}
  ]}$j$::jsonb),
('s_vein', 'republic', 'site', false, 1, 2, true, $j${
  "title": "Найдена жила",
  "text": "Бригада участка «{site}» {planet} вскрыла богатую жилу, но крепь над ней ненадёжная.",
  "opts": [
    {"label": "Укрепить и разрабатывать", "cost": {"res": {"durasteel": 20}}, "risk": "sure", "bad": 0,
     "outs": [{"p": 1, "fx": {"mine": {"vein": 24}}, "text": "Крепь поставили: жила даёт +40 % к добыче на сутки."}]},
    {"label": "Брать сразу", "cost": null, "risk": "gamble", "bad": 40,
     "outs": [{"p": 6, "fx": {"mine": {"vein": 12}}, "text": "Успели взять верхний слой: +40 % к добыче на 12 ч."},
              {"p": 4, "fx": {"mine": {"wear": 12}}, "text": "Крепь не выдержала — жилу засыпало, оборудование побито: износ +12 %."}]},
    {"label": "Не отвлекаться", "cost": null, "risk": "sure", "bad": 0,
     "outs": [{"p": 1, "fx": {}, "text": "Жилу засыпало следующей сменой."}]}
  ]}$j$::jsonb),
('s_droid_glitch', 'republic', 'site', false, 1, 2, true, $j${
  "title": "Сбой дроидов",
  "text": "Дроиды участка «{site}» {planet} сбоят: путают команды, один чуть не опрокинул вагонетку на людей.",
  "opts": [
    {"label": "Вызвать мастера", "cost": {"res": {"electronics": 6}}, "risk": "sure", "bad": 0,
     "outs": [{"p": 1, "fx": {}, "text": "Мастер перепрошил дроидов, сбой ушёл."}]},
    {"label": "Перезагрузить самим", "cost": null, "risk": "luck", "bad": 30,
     "outs": [{"p": 7, "fx": {}, "text": "Перезагрузка помогла."},
              {"p": 3, "fx": {"mine": {"hurt": [{"k": "d", "pct": 50, "h": 4, "why": "virus"}]}}, "text": "Не помогло: половина дроидов встала на 4 ч."}]},
    {"label": "Работать как есть", "cost": null, "risk": "risky", "bad": 100,
     "outs": [{"p": 1, "fx": {"mine": {"hurt": [{"k": "d", "pct": 50, "h": 6, "why": "virus"}], "wear": 5}}, "text": "Сбой разошёлся: половина дроидов встала на 6 ч, износ +5 %."}]}
  ]}$j$::jsonb)
on conflict (id) do update set data = excluded.data, cat = excluded.cat;   -- правки текстов из файла доходят до базы

-- ---------------------------------------------------------------- последствия на участке
-- Возвращает, что реально сделано: { wear, prep, vein, hurt: [{k, n, h, why}] }. Участка больше нет — ничего.
create or replace function public.mine_report_fx(p_building uuid, p_fx jsonb) returns jsonb
language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare s mine_sites; sh mine_shifts; h jsonb; v_out jsonb := '{}'::jsonb; v_hurt jsonb := '[]'::jsonb; v_n integer; v_tot integer; v_k text;
  v_w numeric;
begin
  -- порядок блокировок как у mine_finish и mine_tick (смена, потом участок), иначе возможна взаимная блокировка
  select * into sh from mine_shifts where building_id = p_building and status = 'run' for update;
  select * into s from mine_sites where building_id = p_building for update;
  if not found or s.gone or p_fx is null then return v_out; end if;
  if p_fx ? 'wear' then
    v_w := least(100, greatest(0, s.wear + (p_fx->>'wear')::numeric));
    update mine_sites set wear = v_w where building_id = p_building;
    -- в итог — сколько реально прибавилось (у потолка 100 % меньше заявленного)
    if round(v_w - s.wear) <> 0 then v_out := v_out || jsonb_build_object('wear', round(v_w - s.wear)::integer); end if;
  end if;
  -- как вскрыша (у цеха — наладка линии): к следующей смене основной работы
  if p_fx ? 'prep' then
    update mine_sites set prep_bonus = greatest(prep_bonus, (p_fx->>'prep')::integer) where building_id = p_building;
    v_out := v_out || jsonb_build_object('prep', (p_fx->>'prep')::integer);
  end if;
  if p_fx ? 'vein' then
    update mine_sites set vein_until = greatest(coalesce(vein_until, now()), now()) + make_interval(hours => (p_fx->>'vein')::integer) where building_id = p_building;
    v_out := v_out || jsonb_build_object('vein', (p_fx->>'vein')::integer);
  end if;
  for h in select * from jsonb_array_elements(coalesce(p_fx->'hurt', '[]'::jsonb)) loop
    v_k := h->>'k';
    continue when v_k not in ('h', 'd');
    -- считаем от тех, кто ещё не выбыл (уже бастующих или сломанных второй раз не считаем)
    v_tot := greatest(0, case when v_k = 'h' then s.humans else s.droids end
                         - coalesce((select sum(n) from mine_hurt where building_id = p_building and kind = v_k and until > now()), 0))::integer;
    v_n := least(v_tot, coalesce((h->>'n')::integer, ceil(v_tot * coalesce((h->>'pct')::numeric, 0) / 100.0)::integer));
    continue when coalesce(v_n, 0) <= 0;
    -- выбывших не держат на смене: если они там — смена обрывается (сделанное сохраняется), как при диверсии
    if sh.id is not null and (case when v_k = 'h' then sh.humans else sh.droids end) > 0 then
      perform mine_finish(sh.id, 'stopped');
      sh := null;                                                  -- смена закрыта: второй выбывший её не трогает
    end if;
    insert into mine_hurt (building_id, kind, n, until, reason)
    values (p_building, v_k, v_n, now() + make_interval(hours => greatest(1, coalesce((h->>'h')::integer, 4))), coalesce(h->>'why', 'rush'));
    v_hurt := v_hurt || jsonb_build_object('k', v_k, 'n', v_n, 'h', greatest(1, coalesce((h->>'h')::integer, 4)), 'why', coalesce(h->>'why', 'rush'));
  end loop;
  if jsonb_array_length(v_hurt) > 0 then v_out := v_out || jsonb_build_object('hurt', v_hurt); end if;
  return v_out;
end;
$$;

-- ---------------------------------------------------------------- доставка (раз в 10 мин)
-- У каждого игрока с участками в сутки (по часам донесений) — один бросок: шанс mine_report_pct и минута — из хэша
-- игрока и дня, поэтому строка «сегодня не будет» не нужна
create or replace function public.mine_report_tick() returns integer
language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare tz text := event_tz(); v_day date := (now() at time zone event_tz())::date; p record; s record; v_pick text; v_id uuid;
  v_start integer := event_setting_int('report_start_hour', 10); v_end integer := event_setting_int('report_end_hour', 22);
  v_due timestamptz; v_n integer := 0; v_opts text[];
begin
  if not pg_try_advisory_xact_lock(hashtext('mine_report_tick')) then return 0; end if;
  for p in select distinct pf.id from profiles pf join system_control sc on sc.controller_user_id = pf.id
            join mine_sites ms on ms.system_id = sc.system_id and not ms.gone
           where pf.faction is not null and pf.last_seen_at > now() - make_interval(days => event_setting_int('report_seen_days', 3)) loop
    begin
      continue when abs(hashtext(p.id::text || v_day::text || ':site-p')) % 100 >= game_setting_int('mine_report_pct', 40);
      v_due := ((v_day + make_interval(hours => v_start)) at time zone tz)
               + make_interval(mins => abs(hashtext(p.id::text || v_day::text || ':site-t')) % greatest(60, (v_end - v_start) * 60 - 30));
      continue when now() < v_due or now() >= ((v_day + make_interval(hours => v_end)) at time zone tz);
      continue when exists (select 1 from player_reports pr where pr.user_id = p.id and pr.day = v_day and pr.building_id is not null);
      select ms.building_id, ms.system_id, ms.humans, ms.droids, ms.vein_until, mine_is_refine(ms.resource) refine into s
        from mine_sites ms join system_control sc on sc.system_id = ms.system_id and sc.controller_user_id = p.id
        join buildings bd on bd.id = ms.building_id join systems sy on sy.id = ms.system_id
       where not ms.gone and bd.faction is not distinct from sy.faction
       order by random() limit 1;
      continue when s.building_id is null or is_capture_active(s.system_id);
      v_opts := array[case when s.refine then 's_line_fault' else 's_cave_in' end];
      if s.humans > 0 then v_opts := array_append(v_opts, 's_bonus'); end if;
      if not s.refine and coalesce(s.vein_until, now()) <= now() then v_opts := array_append(v_opts, 's_vein'); end if;
      if s.droids > 0 then v_opts := array_append(v_opts, 's_droid_glitch'); end if;
      v_pick := v_opts[1 + floor(random() * array_length(v_opts, 1))::integer];
      continue when not exists (select 1 from report_catalog where id = v_pick and active);
      v_id := report_deliver(p.id, v_pick, s.system_id, null);
      if v_id is not null then update player_reports set building_id = s.building_id where id = v_id; v_n := v_n + 1; end if;
    exception when others then perform err_db('mine_report_tick', sqlstate, sqlerrm, true); end;
  end loop;
  return v_n;
end;
$$;

-- ---------------------------------------------------------------- встраивание: исход бьёт по участку, в списке — название участка
do $$
declare d text; v_at text;
begin
  -- кусок со словом «обновить» собирается склейкой: MCP отменяет запросы, где он стоит без условия
  v_at := 'upd' || 'ate player_reports set status = case when p_auto then ''expired'' else ''done'' end, choice = p_choice, auto = p_auto, resolved_at = now(),';
  d := pg_get_functiondef('public.report_apply(uuid,integer,boolean)'::regprocedure);
  if position('mine_report_fx' in d) = 0 then
    if position('  ' || v_at in d) = 0 then raise exception 'report_apply: место правки не найдено'; end if;
    execute replace(d, '  ' || v_at, $b$  -- донесение с участка (sql/mine_reports.sql): последствия на самом участке
  if fx ? 'mine' and r.building_id is not null then
    begin v_got := v_got || jsonb_build_object('mine', mine_report_fx(r.building_id, fx->'mine'));
    exception when others then perform err_db('report_apply', sqlstate, sqlerrm, true); end;
  end if;
$b$ || '  ' || v_at);
  end if;

  -- общий подбор донесений не берёт донесения участков: их доставляет mine_report_tick
  d := pg_get_functiondef('public.report_pick(uuid,text)'::regprocedure);
  if position('''site''' in d) = 0 then
    if position('and not c.chain' in d) = 0 then raise exception 'report_pick: место правки не найдено'; end if;
    execute replace(d, 'and not c.chain', 'and not c.chain and c.cat <> ''site''');
  end if;

  -- DEV-отправка донесения: запасной подбор тоже не берёт донесения участков (им нужен участок)
  d := pg_get_functiondef('public.dev_report_send(uuid,text)'::regprocedure);
  if position('''site''' in d) = 0 then
    if position('and not chain' in d) = 0 or position('  v_id := report_deliver(p_user, v_pick, v_sys, null);' in d) = 0 then
      raise exception 'dev_report_send: место правки не найдено';
    end if;
    d := replace(d, 'and not chain', 'and not chain and cat <> ''site''');
    d := replace(d, '  v_id := report_deliver(p_user, v_pick, v_sys, null);',
      '  if (select cat from report_catalog where id = v_pick) = ''site'' then raise exception ''Донесения участков приходят сами — им нужен участок''; end if;' || chr(10) ||
      '  v_id := report_deliver(p_user, v_pick, v_sys, null);');
    execute d;
  end if;

  d := pg_get_functiondef('public.report_list()'::regprocedure);
  if position('''site''' in d) = 0 then
    if position($a$'system', r.system_id, 'planet', s.name,$a$ in d) = 0 then raise exception 'report_list: место правки не найдено'; end if;
    execute replace(d, $a$'system', r.system_id, 'planet', s.name,$a$,
      $b$'system', r.system_id, 'planet', s.name, 'site', (select bt.name from buildings bd join building_types bt on bt.id = bd.building_type_id where bd.id = r.building_id),$b$);
  end if;
end $$;

-- ---------------------------------------------------------------- права и расписание
revoke all on function public.mine_report_fx(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.mine_report_tick() from public, anon, authenticated;

select cron.schedule('mine-report-tick', '*/10 * * * *', $$select public.mine_report_tick()$$);
