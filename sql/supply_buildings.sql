-- Снабжение, шаг 4: окна построек — торговый пост и склад (js/ground-battle.js).
-- Только чтение, для подсказок в окнах: из чего сложилась цена поста и предел склада планеты.

-- Цена поста: доля базовой цены (trade_post_pct) и поправка событий галактики (ge_trade_mod) — как в trade_post_price
create or replace function public.get_trade_post_info()
returns jsonb language sql stable security definer set search_path to 'public', 'pg_temp' as $$
  select case when auth.uid() is null then null else
    jsonb_build_object('pct', game_setting_int('trade_post_pct', 60), 'mod', ge_trade_mod()) end;
$$;

-- Предел склада планеты по частям — как в planet_stock_cap: база, район «Склады», склады нынешней стороны планеты
create or replace function public.get_stock_cap_parts(p_system_id text)
returns jsonb language plpgsql stable security definer set search_path to 'public', 'extensions', 'pg_temp' as $$
declare v_base integer; v_dist integer; v_dep integer; v_n integer;
begin
  if auth.uid() is null then raise exception 'Не авторизован'; end if;
  v_base := game_setting_int('planet_stock_base_cap', 200);
  v_dist := case when settlement_has_district(p_system_id, 'warehouses')
                 then (select effect_value from district_types where id = 'warehouses') else 0 end;
  select coalesce(sum(bt.storage_bonus), 0)::integer, count(*)::integer into v_dep, v_n
    from buildings b join building_types bt on bt.id = b.building_type_id
    join systems sy on sy.id = b.system_id
   where b.system_id = p_system_id and bt.storage_bonus > 0
     and (b.completes_at is null or b.completes_at <= now())
     and b.faction = sy.faction;
  return jsonb_build_object('base', v_base, 'district', coalesce(v_dist, 0), 'depots', v_dep, 'depot_count', v_n,
                            'total', planet_stock_cap(p_system_id));
end $$;

revoke all on function public.get_trade_post_info() from public, anon;
grant execute on function public.get_trade_post_info() to authenticated;
revoke all on function public.get_stock_cap_parts(text) from public, anon;
grant execute on function public.get_stock_cap_parts(text) to authenticated;
