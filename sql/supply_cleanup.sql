-- Снабжение, шаг 5 (уборка), часть 1: живые функции больше не смотрят в таблицу convoys и не зовут функции конвоев.
-- Конвои заменены рейсами в шаге 2 (#111): dispatch_convoy отключён, таблица пуста. После этого таблицу и функции
-- конвоев можно удалить — это sql/supply_drop_convoys.sql (запускается вручную в SQL Editor).
-- convoy_route и convoy_route_to остаются: по ним прокладывают путь рейсы снабжения и дальние перелёты.
--
-- Правки — заменой текста в теле функции (pg_get_functiondef): повторный прогон ничего не меняет,
-- а если якоря нет и функция всё ещё смотрит в convoys — ошибка, а не тихий пропуск.

do $$
declare
  r record; v_def text;
begin
  for r in
    select * from (values
      -- рейс: проверка «флот ведёт конвой»
      ('public.create_supply_route(uuid,text,jsonb,boolean)',
       E'  if exists (select 1 from convoys v where v.commander_id = p_commander_id and v.status = ''in_flight'') then\n    raise exception ''Флот везёт конвой — дождись доставки'';\n  end if;\n',
       ''),
      -- прибытие командира: выгрузка конвоя
      ('public.finish_commander_move(uuid)',
       E'  perform unload_convoy_on_arrival(p_commander_id);\n\n',
       ''),
      -- выбор флота для перелёта: «ведёт конвой»
      ('public.get_move_options(text)',
       E'      coalesce(\n        (select ''На рейсе снабжения «'' || sr.name || ''»'' from supply_routes sr\n          where sr.commander_id = c.id and sr.status = ''active'' limit 1),\n        (select ''Ведёт конвой''::text from convoys v\n          where v.commander_id = c.id and v.status = ''in_flight'' limit 1)) as busy',
       E'      (select ''На рейсе снабжения «'' || sr.name || ''»'' from supply_routes sr\n          where sr.commander_id = c.id and sr.status = ''active'' limit 1) as busy'),
      ('public.get_route_candidates(text)',
       E'      and not exists (select 1 from convoys v where v.commander_id = c.id and v.status = ''in_flight'')\n',
       ''),
      ('public.get_supply_commanders()',
       E'              when exists (select 1 from convoys v where v.commander_id = c.id and v.status = ''in_flight'') then ''convoy''\n',
       ''),
      ('public.start_commander_route(uuid,text)',
       E'  if exists (select 1 from convoys v where v.commander_id = c.id and v.status = ''in_flight'')\n     or exists (select 1 from supply_routes',
       E'  if exists (select 1 from supply_routes'),
      ('public.supply_cleanup()',
       E'  execute v_del || ''convoys where departed_at < now() - interval ''''14 days'''''';\n',
       '')
    ) as t(fn, a, b)
  loop
    v_def := pg_get_functiondef(r.fn::regprocedure);
    if position(r.a in v_def) > 0 then
      execute replace(v_def, r.a, r.b);
    elsif v_def ~* '\mconvoys\M|unload_convoy_on_arrival' then
      raise exception 'Не найден якорь в %: функция всё ещё ссылается на конвои', r.fn;
    end if;
  end loop;
end $$;
