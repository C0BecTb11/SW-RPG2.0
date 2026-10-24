-- Снимок (pg_get_functiondef): доверие и доступ к складам между игроками. 24.10.2026
-- get_supply_grants, get_supply_partners, grant_supply_access, request_supply_access, respond_supply_access, revoke_supply_access

CREATE OR REPLACE FUNCTION public.get_supply_grants()
 RETURNS TABLE(id uuid, other_user_id uuid, other_name text, direction text, status text, requested_by_me boolean, created_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_user uuid := auth.uid();
begin
  if v_user is null then raise exception 'Не авторизован'; end if;
  return query
  select g.id,
         case when g.owner_user_id = v_user then g.grantee_user_id else g.owner_user_id end,
         p.nickname,
         case when g.owner_user_id = v_user then 'i_trust' else 'trusts_me' end,
         g.status,
         coalesce(g.requested_by = v_user, false),
         g.created_at
  from supply_grants g
  left join profiles p on p.id = case when g.owner_user_id = v_user then g.grantee_user_id else g.owner_user_id end
  where (g.owner_user_id = v_user or g.grantee_user_id = v_user)
    and g.status in ('pending', 'active')
  order by g.created_at desc;
end $function$

-- ----------------------------------------
CREATE OR REPLACE FUNCTION public.get_supply_partners()
 RETURNS TABLE(user_id uuid, nickname text, planets integer, trust_status text, i_trust boolean, trusts_me boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_user uuid := auth.uid(); v_fac text;
begin
  if v_user is null then raise exception 'Не авторизован'; end if;
  select p.faction into v_fac from profiles p where p.id = v_user;
  return query
  select q.id, q.nick, q.pl,
         case when q.pin then 'pending_in' when q.pout then 'pending_out'
              when q.itr or q.tme then 'active' end,
         q.itr, q.tme
  from (
    select p.id, p.nickname as nick,
           (select count(*)::integer from system_control sc join systems s on s.id = sc.system_id
             where sc.controller_user_id = p.id and s.faction = v_fac and not s.is_deep_space) as pl,
           exists (select 1 from supply_grants g where g.owner_user_id = v_user and g.grantee_user_id = p.id
                   and g.status = 'pending') as pin,
           exists (select 1 from supply_grants g where g.owner_user_id = p.id and g.grantee_user_id = v_user
                   and g.status = 'pending') as pout,
           exists (select 1 from supply_grants g where g.owner_user_id = v_user and g.grantee_user_id = p.id
                   and g.status = 'active') as itr,
           exists (select 1 from supply_grants g where g.owner_user_id = p.id and g.grantee_user_id = v_user
                   and g.status = 'active') as tme
    from profiles p
    where p.faction = v_fac and p.id <> v_user
  ) q
  order by q.pl desc, q.nick;
end $function$

-- ----------------------------------------
CREATE OR REPLACE FUNCTION public.grant_supply_access(p_grantee_user_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_user uuid := auth.uid(); v_fac text; v_gfac text; g record; v_found boolean; v_id uuid; v_name text;
begin
  if v_user is null then raise exception 'Не авторизован'; end if;
  if p_grantee_user_id is null or p_grantee_user_id = v_user then raise exception 'Себе доверять не нужно'; end if;
  select faction, nickname into v_fac, v_name from profiles where id = v_user;
  select faction into v_gfac from profiles where id = p_grantee_user_id;
  if v_gfac is null then raise exception 'Игрок не найден'; end if;
  if v_gfac is distinct from v_fac then raise exception 'Доверять можно только своей стороне'; end if;

  select * into g from supply_grants x
   where x.owner_user_id = v_user and x.grantee_user_id = p_grantee_user_id
     and x.status in ('pending', 'active')
   for update;
  v_found := found;
  if v_found and g.status = 'active' then return g.id; end if;

  if v_found then
    update supply_grants set status = 'active', decided_at = now() where id = g.id;
    v_id := g.id;
  else
    insert into supply_grants (owner_user_id, grantee_user_id, status, requested_by, decided_at)
    values (v_user, p_grantee_user_id, 'active', v_user, now())
    returning id into v_id;
  end if;

  perform log_event(p_grantee_user_id, v_fac, null, 'supply_access_granted', v_name, 1, 'private',
                    jsonb_build_object('grant_id', v_id, 'from_user', v_user));
  return v_id;
end $function$

-- ----------------------------------------
CREATE OR REPLACE FUNCTION public.request_supply_access(p_owner_user_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_user uuid := auth.uid(); v_fac text; v_ofac text; v_id uuid; v_name text;
begin
  if v_user is null then raise exception 'Не авторизован'; end if;
  if p_owner_user_id is null or p_owner_user_id = v_user then raise exception 'Нельзя запросить доступ у себя'; end if;
  select faction, nickname into v_fac, v_name from profiles where id = v_user;
  select faction into v_ofac from profiles where id = p_owner_user_id;
  if v_ofac is null then raise exception 'Игрок не найден'; end if;
  if v_ofac is distinct from v_fac then raise exception 'Доступ можно просить только у своей стороны'; end if;

  select g.id into v_id from supply_grants g
   where g.owner_user_id = p_owner_user_id and g.grantee_user_id = v_user and g.status in ('pending', 'active');
  if v_id is not null then return v_id; end if;

  if exists (select 1 from supply_grants g
             where g.owner_user_id = p_owner_user_id and g.grantee_user_id = v_user
               and g.status in ('declined', 'revoked')
               and coalesce(g.decided_at, g.created_at) > now() - interval '10 minutes') then
    raise exception 'Запрос уже отклонён — попробуй позже';
  end if;

  insert into supply_grants (owner_user_id, grantee_user_id, status, requested_by)
  values (p_owner_user_id, v_user, 'pending', v_user)
  returning id into v_id;

  perform log_event(p_owner_user_id, v_fac, null, 'supply_access_requested', v_name, 1, 'private',
                    jsonb_build_object('grant_id', v_id, 'from_user', v_user));
  return v_id;
end $function$

-- ----------------------------------------
CREATE OR REPLACE FUNCTION public.respond_supply_access(p_grant_id uuid, p_accept boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_user uuid := auth.uid(); g record; v_fac text; v_name text;
begin
  if v_user is null then raise exception 'Не авторизован'; end if;
  select * into g from supply_grants where id = p_grant_id for update;
  if not found or g.owner_user_id <> v_user then raise exception 'Запрос не найден'; end if;
  if g.status <> 'pending' then raise exception 'Запрос уже рассмотрен'; end if;
  select faction, nickname into v_fac, v_name from profiles where id = v_user;

  if coalesce(p_accept, false) then
    if (select faction from profiles where id = g.grantee_user_id) is distinct from v_fac then
      raise exception 'Игрок уже не на твоей стороне';
    end if;
    update supply_grants set status = 'active', decided_at = now() where id = g.id;
    perform log_event(g.grantee_user_id, v_fac, null, 'supply_access_granted', v_name, 1, 'private',
                      jsonb_build_object('grant_id', g.id, 'from_user', v_user));
  else
    update supply_grants set status = 'declined', decided_at = now() where id = g.id;
  end if;
end $function$

-- ----------------------------------------
CREATE OR REPLACE FUNCTION public.revoke_supply_access(p_grant_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_user uuid := auth.uid(); g record; v_fac text; v_name text; v_other uuid;
begin
  if v_user is null then raise exception 'Не авторизован'; end if;
  select * into g from supply_grants where id = p_grant_id for update;
  if not found or (g.owner_user_id <> v_user and g.grantee_user_id <> v_user) then
    raise exception 'Доступ не найден';
  end if;
  if g.status not in ('pending', 'active') then return; end if;

  update supply_grants set status = 'revoked', decided_at = now() where id = g.id;

  if g.status = 'active' then
    select faction, nickname into v_fac, v_name from profiles where id = v_user;
    v_other := case when g.owner_user_id = v_user then g.grantee_user_id else g.owner_user_id end;
    perform log_event(v_other, v_fac, null, 'supply_access_revoked', v_name, 1, 'private',
                      jsonb_build_object('grant_id', g.id, 'from_user', v_user));
  end if;
end $function$
