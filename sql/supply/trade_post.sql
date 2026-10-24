-- Снимок (pg_get_functiondef): торговый пост (продажа NPC). 24.10.2026
-- ge_trade_mod, get_trade_prices, sell_to_trade_post, trade_post_price

CREATE OR REPLACE FUNCTION public.ge_trade_mod()
 RETURNS integer
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select greatest(-50, least(100, coalesce(sum((t.actions ->> 'trade')::integer), 0)))::integer  -- без событий — 0 (greatest/least пропускают null)
    from galaxy_events g join galaxy_event_types t on t.id = g.type_id
   where g.status = 'active' and g.ends_at > now() and t.actions ? 'trade' and g.scope = 'galaxy';
$function$

-- ----------------------------------------
CREATE OR REPLACE FUNCTION public.get_trade_prices(p_system_id text)
 RETURNS TABLE(resource text, name text, color text, amount integer, price integer, total integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
  select r.id, r.name, r.color,
         coalesce(ps.amount, 0),
         trade_post_price(r.id),
         coalesce(ps.amount, 0) * trade_post_price(r.id)
  from resources r
  left join planet_stock ps on ps.resource = r.id and ps.system_id = p_system_id
  where exists (select 1 from system_control sc
                where sc.system_id = p_system_id and sc.controller_user_id = auth.uid())
  order by r.sort_order;
$function$

-- ----------------------------------------
CREATE OR REPLACE FUNCTION public.sell_to_trade_post(p_system_id text, p_resource text, p_amount integer)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
declare
  v_user uuid := auth.uid();
  v_faction text; v_post text; v_price integer; v_total integer;
begin
  if v_user is null then raise exception 'Не авторизован'; end if;
  if p_amount < 1 then raise exception 'Некорректное количество'; end if;

  if not exists (select 1 from system_control sc
                 where sc.system_id = p_system_id and sc.controller_user_id = v_user) then
    raise exception 'Планета не под твоим контролем';
  end if;

  select faction into v_faction from profiles where id = v_user;
  v_post := case when v_faction = 'republic' then 'rep_trade' else 'cis_trade' end;

  if not exists (
    select 1 from buildings b join building_types bt on bt.id = b.building_type_id
    where b.system_id = p_system_id and bt.code = v_post
      and (b.completes_at is null or b.completes_at <= now())
      and b.faction = (select faction from systems where id = p_system_id)
  ) then
    raise exception 'На этой планете нет достроенного торгового поста';
  end if;

  perform take_planet_stock(p_system_id, p_resource, p_amount);

  v_price := trade_post_price(p_resource);
  v_total := v_price * p_amount;

  update profiles set credits = credits + v_total where id = v_user;

  perform log_event(v_user, v_faction, p_system_id, 'trade_sold',
                    p_resource, p_amount, 'private',
                    jsonb_build_object('credits', v_total, 'price', v_price));

  return v_total;
end;
$function$

-- ----------------------------------------
CREATE OR REPLACE FUNCTION public.trade_post_price(p_resource text)
 RETURNS integer
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select greatest(1, round(r.base_price * game_setting_int('trade_post_pct', 60) / 100.0 * (100 + ge_trade_mod()) / 100.0)::integer)
  from resources r where r.id = p_resource;
$function$
