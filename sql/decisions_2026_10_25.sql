-- Решения Артёма по итогам аудита (25.10.2026).
do $$
declare r record; v_def text; n integer;
begin
  for r in select * from (values
    -- 2. заявка на планету с другим управляющим: выдать её — значит снять его, это полномочие «Управляющие»
    ('public.resolve_planet_request(uuid,boolean)', $a$  insert into system_control (system_id, controller_user_id)
  values (r.system_id, r.user_id)$a$, $a$  -- у планеты уже другой управляющий: выдать её — значит снять его, это полномочие «Управляющие»
  if exists (select 1 from system_control sc where sc.system_id = r.system_id
               and sc.controller_user_id is not null and sc.controller_user_id <> r.user_id)
     and not faction_power(v_me, r.faction, 'planet_controllers') then
    raise exception 'У планеты уже есть управляющий — сменить его может лидер или тот, у кого полномочие «Управляющие»';
  end if;

  insert into system_control (system_id, controller_user_id)
  values (r.system_id, r.user_id)$a$),
    -- 3. лот можно снять и после передачи планеты: товар возвращается на склад планеты, с которой выставлен
    --    (при захвате врагом лоты закрываются в refund_pending_on_capture — активный лот всегда на своей планете)
    ('public.cancel_market_lot(uuid)', $a$  -- товар возвращается на склад планеты — только если планета всё ещё твоя
  if not exists (select 1 from system_control sc where sc.system_id = l.system_id and sc.controller_user_id = v_user) then
    raise exception 'Планета больше не под твоим контролем — товар лота остался на ней';
  end if;
$a$, $a$  -- товар возвращается на склад планеты, с которой выставлен (и если планету уже передали другому управляющему —
  -- иначе лот висел бы вечно); при захвате врагом лоты закрываются раньше (refund_pending_on_capture)
$a$),
    -- 5. вывоз покупки рейсом — как любой рейс снабжения: нужен свой хаб
    ('public.dispatch_market_pickup(uuid,uuid,text,boolean)', $a$  if v_user is null then raise exception 'Не авторизован'; end if;

  select * into o from market_orders$a$, $a$  if v_user is null then raise exception 'Не авторизован'; end if;
  if not supply_has_hub(v_user) then
    raise exception 'Нужен штаб снабжения: достроенный логистический узел хотя бы на одной планете';
  end if;

  select * into o from market_orders$a$)
  ) as t(fn, a, b)
  loop
    v_def := pg_get_functiondef(r.fn::regprocedure);
    if position(r.b in v_def) > 0 then continue; end if;
    n := (length(v_def) - length(replace(v_def, r.a, ''))) / greatest(1, length(r.a));
    if n <> 1 then raise exception '%: якорь встречается % раз', r.fn, n; end if;
    execute replace(v_def, r.a, r.b);
  end loop;
end $$;

-- 4. ники: уникальные без учёта регистра и пробелов по краям, 2–24 знака
create unique index if not exists profiles_nickname_unique on public.profiles (lower(btrim(nickname)));
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'profiles_nickname_len' and conrelid = 'public.profiles'::regclass) then
    alter table public.profiles add constraint profiles_nickname_len check (char_length(btrim(nickname)) between 2 and 24);
  end if;
end $$;

-- 1. «Отражение выстрелов» и «Поглощение»: описание — как работает в бою 2.0 (shared/rt-ground.js: deflect — отбитый
--    выстрел не ранит, пока герой не рубит; absorb — любой урон по герою меньше на 30 %)
update public.hero_abilities set
  description = case id
    when 'deflect_light' then 'Клинок ловит болты. С шансом 30 процентов попавший выстрел отбит и не ранит — если герой в этот миг не рубит.'
    when 'absorb_dark'   then 'Выстрелы гаснут в ладони. Любой урон по ситху меньше на 30 процентов.' end,
  implemented = true
where id in ('deflect_light', 'absorb_dark');
