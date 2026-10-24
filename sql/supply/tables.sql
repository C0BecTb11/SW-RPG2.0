-- Снимок таблиц снабжения (схема public), проект zqqaxhhajhgspaiwlyhy, 24.10.2026
-- Восстановлено по pg_attribute / pg_constraint / pg_indexes / pg_trigger / pg_policies. Справка, а не миграция.
-- У всех таблиц включён RLS. У роли authenticated права SELECT, INSERT, UPDATE, TRUNCATE (выдача Supabase по умолчанию);
-- запись закрыта RLS — политик INSERT/UPDATE нет.

CREATE TABLE public.convoys (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL,
  faction text NOT NULL,
  from_system text NOT NULL,
  to_system text NOT NULL,
  resource text,
  amount integer,
  departed_at timestamptz NOT NULL DEFAULT now(),
  arrives_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'in_flight',
  seized_by uuid,
  order_id uuid,
  commander_id uuid,
  cargo jsonb,
  route text[],
  kind text NOT NULL DEFAULT 'transfer',
  pickup_system text,
  home_system text,
  return_home boolean NOT NULL DEFAULT false,
  stage text NOT NULL DEFAULT 'to_dest',
  CONSTRAINT convoys_pkey PRIMARY KEY (id),
  CONSTRAINT convoys_amount_check CHECK (amount > 0),
  CONSTRAINT convoys_commander_id_fkey FOREIGN KEY (commander_id) REFERENCES commanders(id) ON DELETE SET NULL,
  CONSTRAINT convoys_from_system_fkey FOREIGN KEY (from_system) REFERENCES systems(id),
  CONSTRAINT convoys_to_system_fkey FOREIGN KEY (to_system) REFERENCES systems(id),
  CONSTRAINT convoys_home_system_fkey FOREIGN KEY (home_system) REFERENCES systems(id),
  CONSTRAINT convoys_pickup_system_fkey FOREIGN KEY (pickup_system) REFERENCES systems(id),
  CONSTRAINT convoys_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES auth.users(id),
  CONSTRAINT convoys_resource_fkey FOREIGN KEY (resource) REFERENCES resources(id)
);
-- на status / kind / stage нет CHECK
CREATE INDEX convoys_due_idx ON public.convoys USING btree (arrives_at) WHERE (status = 'in_flight');
CREATE INDEX convoys_to_idx  ON public.convoys USING btree (to_system)  WHERE (status = 'in_flight');
-- POLICY convoys_select_own: SELECT TO public USING (owner_user_id = auth.uid())

CREATE TABLE public.market_lots (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  seller_user_id uuid NOT NULL,
  seller_faction text NOT NULL,
  system_id text NOT NULL,
  resource text NOT NULL,
  amount_left integer NOT NULL,
  price_per_unit integer NOT NULL,
  open_to text NOT NULL DEFAULT 'faction',
  created_at timestamptz NOT NULL DEFAULT now(),
  active boolean NOT NULL DEFAULT true,
  CONSTRAINT market_lots_pkey PRIMARY KEY (id),
  CONSTRAINT market_lots_amount_left_check CHECK (amount_left >= 0),
  CONSTRAINT market_lots_price_per_unit_check CHECK (price_per_unit > 0),
  CONSTRAINT market_lots_resource_fkey FOREIGN KEY (resource) REFERENCES resources(id),
  CONSTRAINT market_lots_seller_user_id_fkey FOREIGN KEY (seller_user_id) REFERENCES auth.users(id),
  CONSTRAINT market_lots_system_id_fkey FOREIGN KEY (system_id) REFERENCES systems(id)
);
-- на open_to нет CHECK
CREATE INDEX market_lots_open_idx ON public.market_lots USING btree (resource) WHERE active;
-- POLICY market_lots_select: SELECT TO authenticated USING (seller_user_id = auth.uid() OR open_to = 'all'
--        OR seller_faction = (SELECT profiles.faction FROM profiles WHERE profiles.id = auth.uid()))

CREATE TABLE public.market_orders (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  lot_id uuid NOT NULL,
  buyer_user_id uuid NOT NULL,
  amount_left integer NOT NULL,
  price_per_unit integer NOT NULL,
  paid integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'reserved',
  CONSTRAINT market_orders_pkey PRIMARY KEY (id),
  CONSTRAINT market_orders_amount_left_check CHECK (amount_left >= 0),
  CONSTRAINT market_orders_buyer_user_id_fkey FOREIGN KEY (buyer_user_id) REFERENCES auth.users(id),
  CONSTRAINT market_orders_lot_id_fkey FOREIGN KEY (lot_id) REFERENCES market_lots(id)
);
-- на status нет CHECK
CREATE INDEX market_orders_buyer_idx  ON public.market_orders USING btree (buyer_user_id) WHERE (status = 'reserved');
CREATE INDEX market_orders_expiry_idx ON public.market_orders USING btree (expires_at)    WHERE (status = 'reserved');
-- POLICY market_orders_select: SELECT TO authenticated USING (buyer_user_id = auth.uid()
--        OR EXISTS (SELECT 1 FROM market_lots l WHERE l.id = market_orders.lot_id AND l.seller_user_id = auth.uid()))

CREATE TABLE public.planet_stock (
  system_id text NOT NULL,
  resource text NOT NULL,
  amount integer NOT NULL DEFAULT 0,
  CONSTRAINT planet_stock_pkey PRIMARY KEY (system_id, resource),
  CONSTRAINT planet_stock_amount_check CHECK (amount >= 0),
  CONSTRAINT planet_stock_resource_fkey FOREIGN KEY (resource) REFERENCES resources(id),
  CONSTRAINT planet_stock_system_id_fkey FOREIGN KEY (system_id) REFERENCES systems(id)
);
-- POLICY planet_stock_select_controller: SELECT TO authenticated USING (EXISTS (SELECT 1 FROM system_control sc
--        WHERE sc.system_id = planet_stock.system_id AND sc.controller_user_id = auth.uid()))

CREATE TABLE public.ship_cargo (           -- troops carried in ship holds (not resources)
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  ship_id uuid NOT NULL,
  unit_type text NOT NULL,
  quantity integer NOT NULL DEFAULT 0,
  CONSTRAINT ship_cargo_pkey PRIMARY KEY (id),
  CONSTRAINT ship_cargo_ship_id_unit_type_key UNIQUE (ship_id, unit_type),
  CONSTRAINT ship_cargo_ship_id_fkey FOREIGN KEY (ship_id) REFERENCES ships(id) ON DELETE CASCADE,
  CONSTRAINT ship_cargo_unit_type_fkey FOREIGN KEY (unit_type) REFERENCES unit_types(id)
);
CREATE TRIGGER trg_cargo_owner BEFORE INSERT OR UPDATE ON public.ship_cargo FOR EACH ROW EXECUTE FUNCTION check_cargo_owner();
CREATE TRIGGER trg_ship_transit_guard BEFORE INSERT OR DELETE OR UPDATE ON public.ship_cargo FOR EACH ROW EXECUTE FUNCTION ship_transit_guard();
-- POLICY "Own ship cargo": SELECT TO public USING (EXISTS (SELECT 1 FROM ships s WHERE s.id = ship_cargo.ship_id AND s.owner_user_id = auth.uid()))

CREATE TABLE public.ship_resource_cargo (  -- resources carried by ships (convoys / routes)
  ship_id uuid NOT NULL,
  resource text NOT NULL,
  amount integer NOT NULL,
  CONSTRAINT ship_resource_cargo_pkey PRIMARY KEY (ship_id, resource),
  CONSTRAINT ship_resource_cargo_amount_check CHECK (amount > 0),
  CONSTRAINT ship_resource_cargo_resource_fkey FOREIGN KEY (resource) REFERENCES resources(id),
  CONSTRAINT ship_resource_cargo_ship_id_fkey FOREIGN KEY (ship_id) REFERENCES ships(id) ON DELETE CASCADE
);
-- на ship_resource_cargo нет триггеров (в отличие от ship_cargo — нет защиты на время перелёта)
-- POLICY ship_resource_cargo_select_own: SELECT TO public USING (EXISTS (SELECT 1 FROM ships s WHERE s.id = ship_resource_cargo.ship_id AND s.owner_user_id = auth.uid()))

CREATE TABLE public.supply_grants (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL,
  grantee_user_id uuid NOT NULL,
  status text NOT NULL,
  requested_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  CONSTRAINT supply_grants_pkey PRIMARY KEY (id),
  CONSTRAINT supply_grants_check CHECK (owner_user_id <> grantee_user_id),
  CONSTRAINT supply_grants_status_check CHECK (status = ANY (ARRAY['pending','active','revoked','declined']))
);
CREATE INDEX supply_grants_grantee ON public.supply_grants USING btree (grantee_user_id);
CREATE UNIQUE INDEX supply_grants_live_pair ON public.supply_grants USING btree (owner_user_id, grantee_user_id) WHERE (status = ANY (ARRAY['pending','active']));
-- политик нет: только через RPC

CREATE TABLE public.supply_route_log (
  id bigint NOT NULL DEFAULT nextval('supply_route_log_id_seq'),
  route_id uuid NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  system_id text,
  text text NOT NULL,
  moved integer NOT NULL DEFAULT 0,
  CONSTRAINT supply_route_log_pkey PRIMARY KEY (id),
  CONSTRAINT supply_route_log_route_id_fkey FOREIGN KEY (route_id) REFERENCES supply_routes(id)
);
CREATE INDEX supply_route_log_route_at ON public.supply_route_log USING btree (route_id, id DESC);
-- политик нет: только через RPC

CREATE TABLE public.supply_routes (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL,
  commander_id uuid NOT NULL,          -- NOTE: no FK to commanders
  name text NOT NULL DEFAULT 'Рейс',
  stops jsonb NOT NULL,
  loop boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'active',
  stop_index integer NOT NULL DEFAULT 0,
  phase text NOT NULL DEFAULT 'travel',
  wait_until timestamptz,
  last_note text,
  cycles integer NOT NULL DEFAULT 0,
  moved_total integer NOT NULL DEFAULT 0,
  moved_this_cycle integer NOT NULL DEFAULT 0,
  expect_system text,
  idle_cycles integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  transit_wait_since timestamptz,
  CONSTRAINT supply_routes_pkey PRIMARY KEY (id),
  CONSTRAINT supply_routes_phase_check CHECK (phase = ANY (ARRAY['travel','at_stop','waiting'])),
  CONSTRAINT supply_routes_status_check CHECK (status = ANY (ARRAY['active','paused','stalled','stopped']))
);
CREATE UNIQUE INDEX supply_routes_one_per_commander ON public.supply_routes USING btree (commander_id) WHERE (status <> 'stopped');
CREATE INDEX supply_routes_owner  ON public.supply_routes USING btree (owner_user_id);
CREATE INDEX supply_routes_status ON public.supply_routes USING btree (status);
-- политик нет: только через RPC

CREATE TABLE public.supply_rules (
  system_id text NOT NULL,
  resource text NOT NULL,
  share boolean NOT NULL DEFAULT false,
  keep_min integer NOT NULL DEFAULT 0,
  max_per_day integer,
  audience text NOT NULL DEFAULT 'faction',
  want_min integer NOT NULL DEFAULT 0,
  set_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT supply_rules_pkey PRIMARY KEY (system_id, resource),
  CONSTRAINT supply_rules_audience_check CHECK (audience = ANY (ARRAY['faction','trusted'])),
  CONSTRAINT supply_rules_keep_min_check CHECK (keep_min >= 0),
  CONSTRAINT supply_rules_max_per_day_check CHECK (max_per_day >= 0),
  CONSTRAINT supply_rules_want_min_check CHECK (want_min >= 0),
  CONSTRAINT supply_rules_resource_fkey FOREIGN KEY (resource) REFERENCES resources(id),
  CONSTRAINT supply_rules_system_id_fkey FOREIGN KEY (system_id) REFERENCES systems(id)
);
-- политик нет: только через RPC

CREATE TABLE public.supply_takes (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  system_id text NOT NULL,
  resource text NOT NULL,
  taker_user_id uuid NOT NULL,
  owner_user_id uuid,
  amount integer NOT NULL,
  route_id uuid,
  taken_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT supply_takes_pkey PRIMARY KEY (id),
  CONSTRAINT supply_takes_amount_check CHECK (amount > 0)
);
CREATE INDEX supply_takes_sys_res_at ON public.supply_takes USING btree (system_id, resource, taken_at);
-- политик нет: только через RPC

-- ============================================================================
-- game_settings (ключи про снабжение, конвои, рынок, торговлю, груз, склад, пределы), 24.10.2026
--   cargo_units_per_slot = 2        (resource_slots, commander_free_cargo, supply_fleet_free, supply_put_cargo, dispatch_convoy, convoy_load_order)
--   convoy_hop_seconds   = 180      (нигде не используется)
--   convoy_max_amount    = 400      (нигде не используется)
--   market_min_price     = 1        (create_market_lot)
--   market_order_hours   = 24       (buy_market_lot)
--   planet_stock_base_cap= 200      (planet_stock_cap)
--   trade_post_pct       = 60       (trade_post_price)
--   travel_seconds       = 60       (start_commander_move, get_convoy_destinations, start_interception)
--   payout_hour          = 4        (last_payout_at → суточные лимиты снабжения, production_tick)
--   approach_warn_pct    = 80       (approach_warning_tick)
--   mine_site_cap = 300, capture_seconds = 21600, deploy_capacity = 72 (к снабжению не относятся)
-- district_types 'warehouses'.effect_value = 300 (прибавка к пределу склада планеты)
-- building_types: rep_depot/cis_depot storage_bonus = 800 (цена 1800); rep_logistics (1500) / cis_logistics (3000) и
--   rep_trade / cis_trade (2000) — storage_bonus 0. На 24.10.2026 ни одной из этих шести построек в мире нет.
--
-- такты pg_cron, связанные со снабжением (за последние 2 суток все прошли без ошибок):
--   supply-tick            20 seconds   select supply_tick()
--   market-expiry          */5 * * * *  select market_expire_tick()
--   finish-commander-moves 30 seconds   select finish_due_commander_moves()   -> finish_commander_move -> unload_convoy_on_arrival
--   interceptions          15 seconds   select interception_tick()
--   approach-warnings      15 seconds   select approach_warning_tick()
--   extract-resources      * * * * *    select production_tick()
--   (convoy_tick is NOT scheduled)
