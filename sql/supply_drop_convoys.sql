-- Снабжение, шаг 5 (уборка), часть 2: удаление старых конвоев. ЗАПУСКАТЬ ВРУЧНУЮ в Supabase → SQL Editor.
-- Перед этим должна быть применена часть 1 (sql/supply_cleanup.sql) и выложен клиент без конвоев (#114):
-- живые функции и игра к конвоям больше не обращаются.
--
-- Скрипт сам проверяет, что удалять безопасно, и при любом сомнении останавливается, ничего не тронув:
--   • в таблице convoys нет ни одной строки;
--   • ни одна оставшаяся функция не ссылается на convoys и на удаляемые функции.
-- Всё в одной транзакции: либо удалится всё, либо ничего.
-- convoy_route и convoy_route_to НЕ удаляются — по ним прокладывают путь рейсы снабжения и дальние перелёты.

begin;

do $$
declare v_rows bigint; v_users text;
begin
  select count(*) into v_rows from public.convoys;
  if v_rows > 0 then
    raise exception 'В таблице convoys есть строки (%) — удаление остановлено', v_rows;
  end if;

  select string_agg(p.proname, ', ' order by p.proname) into v_users
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname not in ('convoy_tick', 'convoy_jump', 'convoy_load_order', 'convoy_unload', 'dispatch_convoy',
                           'unload_convoy_on_arrival', 'get_my_convoys', 'get_convoy_commanders', 'get_convoy_destinations')
     and (p.prosrc ~* '\mconvoys\M'
          or p.prosrc ~* '\m(convoy_tick|convoy_jump|convoy_load_order|convoy_unload|dispatch_convoy|unload_convoy_on_arrival|get_my_convoys|get_convoy_commanders|get_convoy_destinations)\M');
  if v_users is not null then
    raise exception 'На конвои ещё ссылаются функции: % — удаление остановлено', v_users;
  end if;
end $$;

drop function if exists public.unload_convoy_on_arrival(uuid);
drop function if exists public.convoy_tick();
drop function if exists public.convoy_jump(uuid, text);
drop function if exists public.convoy_load_order(uuid);
drop function if exists public.convoy_unload(uuid);
drop function if exists public.dispatch_convoy(uuid, text, jsonb, boolean);
drop function if exists public.get_my_convoys();
drop function if exists public.get_convoy_commanders(text);
drop function if exists public.get_convoy_destinations(text);

drop table if exists public.convoys;

delete from public.game_settings where key in ('convoy_hop_seconds', 'convoy_max_amount');

commit;

-- Проверка после запуска (должно вернуть три нуля):
-- select (select count(*) from pg_proc where proname in ('convoy_tick','dispatch_convoy','get_my_convoys','unload_convoy_on_arrival')) as funcs,
--        (select count(*) from pg_class where relname = 'convoys') as tables,
--        (select count(*) from game_settings where key like 'convoy%') as settings;
