-- copart · Réplica académica · Esquema inicial
-- Importes en céntimos de euro (BIGINT) para evitar errores de coma flotante.

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$ LANGUAGE plpgsql;

-- ───────────── Identidad, roles y permisos ─────────────
CREATE TABLE roles (
  id SERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE CHECK (code IN ('buyer','seller','admin','finance','ops')),
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE permissions (
  id SERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE role_permissions (
  role_id INT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id INT NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  account_type TEXT NOT NULL DEFAULT 'individual' CHECK (account_type IN ('individual','business')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  verification_status TEXT NOT NULL DEFAULT 'unverified' CHECK (verification_status IN ('unverified','pending','approved','rejected')),
  registration_step TEXT NOT NULL DEFAULT 'membership' CHECK (registration_step IN ('membership','documents','complete')),
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_lower_uq ON users (lower(email));

CREATE TABLE profiles (
  user_id INT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  phone_type TEXT NOT NULL DEFAULT 'mobile' CHECK (phone_type IN ('mobile','landline','work')),
  phone_prefix TEXT NOT NULL DEFAULT '+34',
  phone TEXT NOT NULL DEFAULT '',
  company_name TEXT,
  tax_id TEXT,
  address TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '',
  postal_code TEXT NOT NULL DEFAULT '',
  country TEXT NOT NULL DEFAULT 'ES',
  language TEXT NOT NULL DEFAULT 'en' CHECK (language IN ('en','es')),
  marketing_opt_in BOOLEAN NOT NULL DEFAULT false,
  terms_accepted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE user_roles (
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id INT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role_id)
);

CREATE TABLE sessions (
  id SERIAL PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ip TEXT,
  user_agent TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions(user_id);

CREATE TABLE password_resets (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ───────────── Membresías y verificación ─────────────
CREATE TABLE membership_plans (
  id SERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE CHECK (code IN ('guest','basic','premium')),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price_cents BIGINT NOT NULL DEFAULT 0 CHECK (price_cents >= 0),
  currency TEXT NOT NULL DEFAULT 'EUR',
  billing_period TEXT NOT NULL DEFAULT 'year',
  can_bid BOOLEAN NOT NULL DEFAULT false,
  max_bid_cents BIGINT CHECK (max_bid_cents IS NULL OR max_bid_cents > 0),      -- límite por vehículo
  max_total_cents BIGINT CHECK (max_total_cents IS NULL OR max_total_cents > 0), -- límite agregado por subasta
  max_lots_per_event INT CHECK (max_lots_per_event IS NULL OR max_lots_per_event > 0),
  requires_documents BOOLEAN NOT NULL DEFAULT true,
  features JSONB NOT NULL DEFAULT '[]',
  sort INT NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE subscriptions (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id INT NOT NULL REFERENCES membership_plans(id),
  status TEXT NOT NULL CHECK (status IN ('pending_payment','active','expired','cancelled')),
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  payment_reference TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX subscriptions_user_idx ON subscriptions(user_id, status);
-- Un usuario solo puede tener una suscripción activa a la vez.
CREATE UNIQUE INDEX subscriptions_one_active_uq ON subscriptions(user_id) WHERE status = 'active';

CREATE TABLE verification_documents (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  doc_type TEXT NOT NULL CHECK (doc_type IN ('id_card','passport','driving_license','business_license','proof_of_address')),
  file_path TEXT NOT NULL,
  original_name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size_bytes INT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  reviewed_by INT REFERENCES users(id),
  reviewed_at TIMESTAMPTZ,
  rejection_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX verification_documents_user_idx ON verification_documents(user_id);
CREATE INDEX verification_documents_status_idx ON verification_documents(status);

CREATE TABLE sellers (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  company_name TEXT NOT NULL,
  seller_type TEXT NOT NULL DEFAULT 'dealer' CHECK (seller_type IN ('insurance','dealer','rental','fleet','leasing','individual')),
  approved BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ───────────── Catálogo ─────────────
CREATE TABLE makes (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  slug TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE models (
  id SERIAL PRIMARY KEY,
  make_id INT NOT NULL REFERENCES makes(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (make_id, name)
);
CREATE TABLE vehicle_types (
  id SERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE damage_types (
  id SERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE locations (
  id SERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  address TEXT NOT NULL,
  city TEXT NOT NULL,
  province TEXT NOT NULL,
  postal_code TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  hours TEXT NOT NULL DEFAULT '',
  pickup_hours TEXT NOT NULL DEFAULT '',
  lat NUMERIC(9,6),
  lng NUMERIC(9,6),
  description TEXT NOT NULL DEFAULT '',
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE vehicles (
  id SERIAL PRIMARY KEY,
  seller_id INT NOT NULL REFERENCES sellers(id),
  make_id INT NOT NULL REFERENCES makes(id),
  model_id INT NOT NULL REFERENCES models(id),
  vehicle_type_id INT NOT NULL REFERENCES vehicle_types(id),
  primary_damage_id INT REFERENCES damage_types(id),
  secondary_damage_id INT REFERENCES damage_types(id),
  location_id INT NOT NULL REFERENCES locations(id),
  year INT NOT NULL CHECK (year BETWEEN 1920 AND 2100),
  trim TEXT NOT NULL DEFAULT '',
  vin TEXT NOT NULL,                       -- VIN ficticio (seed) / mascarado en vistas públicas
  odometer_km INT NOT NULL DEFAULT 0 CHECK (odometer_km >= 0),
  odometer_status TEXT NOT NULL DEFAULT 'actual' CHECK (odometer_status IN ('actual','not_actual','exempt')),
  fuel TEXT NOT NULL DEFAULT 'petrol' CHECK (fuel IN ('petrol','diesel','hybrid','electric','lpg','other')),
  transmission TEXT NOT NULL DEFAULT 'manual' CHECK (transmission IN ('manual','automatic')),
  engine TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT '',
  has_keys BOOLEAN NOT NULL DEFAULT true,
  runs_drives BOOLEAN NOT NULL DEFAULT true,
  condition TEXT NOT NULL DEFAULT 'used' CHECK (condition IN ('used','salvage')),
  document_type TEXT NOT NULL DEFAULT 'Permiso de circulación',
  highlights TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  estimated_value_cents BIGINT,
  featured BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending_approval','approved','rejected','withdrawn','sold')),
  rejection_reason TEXT,
  submitted_at TIMESTAMPTZ,
  approved_at TIMESTAMPTZ,
  approved_by INT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX vehicles_vin_uq ON vehicles(vin);
CREATE INDEX vehicles_status_idx ON vehicles(status);
CREATE INDEX vehicles_make_model_idx ON vehicles(make_id, model_id);
CREATE INDEX vehicles_location_idx ON vehicles(location_id);
CREATE INDEX vehicles_seller_idx ON vehicles(seller_id);

CREATE TABLE vehicle_images (
  id SERIAL PRIMARY KEY,
  vehicle_id INT NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  sort INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX vehicle_images_vehicle_idx ON vehicle_images(vehicle_id, sort);

CREATE TABLE vehicle_documents (
  id SERIAL PRIMARY KEY,
  vehicle_id INT NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  doc_type TEXT NOT NULL CHECK (doc_type IN ('registration','technical_sheet','insurance_report','ownership','other')),
  file_path TEXT NOT NULL,
  original_name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size_bytes INT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ───────────── Subastas ─────────────
-- Estado del EVENTO (sesión de subasta) separado del estado del LOTE.
CREATE TABLE auction_events (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  location_id INT REFERENCES locations(id),           -- NULL = subasta nacional (toda España)
  starts_at TIMESTAMPTZ NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'Europe/Madrid',
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','live','ended','cancelled')),
  current_lot_id INT,
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX auction_events_starts_idx ON auction_events(starts_at);

CREATE TABLE auction_lots (
  id SERIAL PRIMARY KEY,
  lot_number BIGINT NOT NULL UNIQUE,
  event_id INT NOT NULL REFERENCES auction_events(id),
  vehicle_id INT NOT NULL REFERENCES vehicles(id),
  sequence INT NOT NULL,
  status TEXT NOT NULL DEFAULT 'prebidding' CHECK (status IN ('scheduled','prebidding','live','ended','awarded','pending_seller_approval','no_sale','cancelled')),
  starting_bid_cents BIGINT NOT NULL CHECK (starting_bid_cents > 0),
  reserve_cents BIGINT NOT NULL DEFAULT 0 CHECK (reserve_cents >= 0),
  buy_now_cents BIGINT,
  current_bid_cents BIGINT,
  leader_user_id INT REFERENCES users(id),
  bid_count INT NOT NULL DEFAULT 0,
  live_started_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  version INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (event_id, sequence)
);
CREATE INDEX auction_lots_event_idx ON auction_lots(event_id, sequence);
CREATE INDEX auction_lots_status_idx ON auction_lots(status);
-- Un vehículo no puede estar en dos lotes abiertos a la vez.
CREATE UNIQUE INDEX auction_lots_vehicle_open_uq ON auction_lots(vehicle_id) WHERE status IN ('scheduled','prebidding','live','pending_seller_approval','awarded');
ALTER TABLE auction_events ADD CONSTRAINT auction_events_current_lot_fk FOREIGN KEY (current_lot_id) REFERENCES auction_lots(id);

CREATE TABLE bids (
  id BIGSERIAL PRIMARY KEY,
  lot_id INT NOT NULL REFERENCES auction_lots(id),
  user_id INT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('prebid','live','auto')),
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),   -- precio visible resultante
  max_cents BIGINT,                                        -- máximo privado (solo para el propio pujador)
  idempotency_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX bids_lot_idx ON bids(lot_id, id);
CREATE INDEX bids_user_idx ON bids(user_id);
CREATE UNIQUE INDEX bids_idempotency_uq ON bids(user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE proxy_bids (
  lot_id INT NOT NULL REFERENCES auction_lots(id),
  user_id INT NOT NULL REFERENCES users(id),
  max_cents BIGINT NOT NULL CHECK (max_cents > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (lot_id, user_id)
);

CREATE TABLE watchlist (
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lot_id INT NOT NULL REFERENCES auction_lots(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, lot_id)
);

CREATE TABLE saved_searches (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  query TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE vehicle_alerts (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id) ON DELETE SET NULL,
  vehicle_type_id INT REFERENCES vehicle_types(id),
  year_from INT NOT NULL,
  year_to INT NOT NULL,
  make_id INT NOT NULL REFERENCES makes(id),
  model_id INT REFERENCES models(id),
  frequency TEXT NOT NULL DEFAULT 'daily' CHECK (frequency IN ('instant','daily','weekly')),
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  email TEXT NOT NULL,
  consent BOOLEAN NOT NULL CHECK (consent),
  manage_token TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled')),
  last_sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (year_from <= year_to)
);
CREATE TABLE vehicle_alert_matches (
  alert_id INT NOT NULL REFERENCES vehicle_alerts(id) ON DELETE CASCADE,
  lot_id INT NOT NULL REFERENCES auction_lots(id) ON DELETE CASCADE,
  notified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (alert_id, lot_id)
);

-- ───────────── Compras, facturas y pagos ─────────────
CREATE TABLE sale_orders (
  id SERIAL PRIMARY KEY,
  order_number TEXT NOT NULL UNIQUE,
  lot_id INT NOT NULL UNIQUE REFERENCES auction_lots(id),   -- garantiza un único ganador por lote
  buyer_id INT NOT NULL REFERENCES users(id),
  seller_id INT NOT NULL REFERENCES sellers(id),
  hammer_cents BIGINT NOT NULL CHECK (hammer_cents > 0),
  status TEXT NOT NULL DEFAULT 'pending_payment' CHECK (status IN ('pending_payment','payment_review','paid','in_transport','ready_for_pickup','completed','cancelled')),
  delivery_method TEXT CHECK (delivery_method IN ('pickup','transport')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX sale_orders_buyer_idx ON sale_orders(buyer_id);
CREATE INDEX sale_orders_status_idx ON sale_orders(status);

CREATE TABLE order_status_history (
  id SERIAL PRIMARY KEY,
  order_id INT NOT NULL REFERENCES sale_orders(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status TEXT NOT NULL,
  actor_id INT REFERENCES users(id),
  note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE SEQUENCE invoice_number_seq START 1000;
CREATE TABLE invoices (
  id SERIAL PRIMARY KEY,
  invoice_number TEXT NOT NULL UNIQUE,
  order_id INT REFERENCES sale_orders(id),
  subscription_id INT REFERENCES subscriptions(id),
  user_id INT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL DEFAULT 'purchase' CHECK (kind IN ('purchase','membership','transport')),
  status TEXT NOT NULL DEFAULT 'issued' CHECK (status IN ('issued','partially_paid','paid','void')),
  subtotal_cents BIGINT NOT NULL,
  tax_cents BIGINT NOT NULL,
  total_cents BIGINT NOT NULL,
  paid_cents BIGINT NOT NULL DEFAULT 0,
  due_at TIMESTAMPTZ NOT NULL,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX invoices_user_idx ON invoices(user_id);
CREATE INDEX invoices_status_idx ON invoices(status);

CREATE TABLE invoice_items (
  id SERIAL PRIMARY KEY,
  invoice_id INT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK (category IN ('vehicle','buyer_fee','admin_fee','transport','storage','membership')),
  description TEXT NOT NULL,
  amount_cents BIGINT NOT NULL,
  tax_rate NUMERIC(5,2) NOT NULL DEFAULT 0,
  tax_cents BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE payments (
  id SERIAL PRIMARY KEY,
  invoice_id INT NOT NULL REFERENCES invoices(id),
  user_id INT NOT NULL REFERENCES users(id),
  method TEXT NOT NULL CHECK (method IN ('bank_transfer','card_demo')),
  scope TEXT NOT NULL CHECK (scope IN ('vehicle','fees','full')),
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
  status TEXT NOT NULL DEFAULT 'pending_review' CHECK (status IN ('pending_review','approved','rejected')),
  reference TEXT NOT NULL,
  review_note TEXT,
  reviewed_by INT REFERENCES users(id),
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX payments_status_idx ON payments(status);
CREATE INDEX payments_invoice_idx ON payments(invoice_id);

CREATE TABLE payment_proofs (
  id SERIAL PRIMARY KEY,
  payment_id INT NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  original_name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size_bytes INT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ───────────── Transporte y retiro ─────────────
CREATE TABLE transport_quotes (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id),
  order_id INT REFERENCES sale_orders(id),
  origin_location_id INT NOT NULL REFERENCES locations(id),
  service TEXT NOT NULL CHECK (service IN ('national','international','express')),
  destination_address TEXT NOT NULL,
  destination_city TEXT NOT NULL,
  destination_postal_code TEXT NOT NULL,
  destination_country TEXT NOT NULL DEFAULT 'ES',
  distance_km INT NOT NULL CHECK (distance_km >= 0),
  price_cents BIGINT NOT NULL CHECK (price_cents >= 0),
  status TEXT NOT NULL DEFAULT 'quoted' CHECK (status IN ('quoted','accepted','expired','cancelled')),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE transport_orders (
  id SERIAL PRIMARY KEY,
  quote_id INT NOT NULL UNIQUE REFERENCES transport_quotes(id),
  order_id INT NOT NULL REFERENCES sale_orders(id),
  carrier_name TEXT,
  tracking_code TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','assigned','picked_up','in_transit','delivered','cancelled')),
  eta DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE transport_events (
  id SERIAL PRIMARY KEY,
  transport_order_id INT NOT NULL REFERENCES transport_orders(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  actor_id INT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE pickup_passes (
  id SERIAL PRIMARY KEY,
  order_id INT NOT NULL UNIQUE REFERENCES sale_orders(id),
  pin_hash TEXT NOT NULL,         -- verificación (logística nunca ve el PIN)
  pin_code TEXT NOT NULL,         -- visible solo para el comprador titular
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','used','revoked')),
  failed_attempts INT NOT NULL DEFAULT 0,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  used_at TIMESTAMPTZ,
  validated_by INT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ───────────── Comunicación, soporte, auditoría, contenido ─────────────
CREATE TABLE notifications (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  link TEXT NOT NULL DEFAULT '/',
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_idx ON notifications(user_id, read_at);

CREATE TABLE email_outbox (
  id SERIAL PRIMARY KEY,
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE support_tickets (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  topic TEXT NOT NULL DEFAULT 'general',
  subject TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','closed')),
  response TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE audit_logs (
  id BIGSERIAL PRIMARY KEY,
  actor_id INT REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT,
  data JSONB NOT NULL DEFAULT '{}',
  ip TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_entity_idx ON audit_logs(entity, entity_id);
CREATE INDEX audit_logs_created_idx ON audit_logs(created_at DESC);

CREATE TABLE system_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE content_pages (
  id SERIAL PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  body_html TEXT NOT NULL,
  published BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE banners (
  id SERIAL PRIMARY KEY,
  placement TEXT NOT NULL DEFAULT 'top' CHECK (placement IN ('top','home')),
  text TEXT NOT NULL,
  link_text TEXT,
  link_url TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Triggers updated_at
DO $$ DECLARE t TEXT; BEGIN
  FOR t IN SELECT table_name FROM information_schema.columns
           WHERE column_name = 'updated_at' AND table_schema = 'public' LOOP
    EXECUTE format('CREATE TRIGGER %I_set_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t, t);
  END LOOP;
END $$;
