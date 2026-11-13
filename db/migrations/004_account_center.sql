-- 004: centro de cuenta del miembro (Mi cuenta) y pasarela de pagos enchufable.
--  - Métodos de pago guardados: SOLO marca, últimos 4 y caducidad (nunca el número completo ni el CVC).
--    provider/provider_ref quedan listos para un proveedor real (token del proveedor).
--  - Depósitos (aumentan el poder adquisitivo), direcciones para envío de títulos y preferencias.

ALTER TABLE users ADD COLUMN password_changed_at TIMESTAMPTZ;
ALTER TABLE profiles ADD COLUMN title_name TEXT;
ALTER TABLE profiles ADD COLUMN mail_address TEXT NOT NULL DEFAULT '';
ALTER TABLE profiles ADD COLUMN mail_city TEXT NOT NULL DEFAULT '';
ALTER TABLE profiles ADD COLUMN mail_postal_code TEXT NOT NULL DEFAULT '';
ALTER TABLE profiles ADD COLUMN mail_country CHAR(2) NOT NULL DEFAULT 'ES';
ALTER TABLE profiles ADD COLUMN preferences JSONB NOT NULL DEFAULT '{}';

CREATE TABLE payment_methods (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'demo',
  provider_ref TEXT,                         -- token/identificador del proveedor de pagos
  brand TEXT NOT NULL CHECK (brand IN ('visa','mastercard','amex','discover','other')),
  last4 CHAR(4) NOT NULL CHECK (last4 ~ '^\d{4}$'),
  exp_month INT NOT NULL CHECK (exp_month BETWEEN 1 AND 12),
  exp_year INT NOT NULL CHECK (exp_year BETWEEN 2000 AND 2100),
  holder TEXT NOT NULL,
  is_default BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX payment_methods_one_default_uq ON payment_methods (user_id) WHERE is_default;
CREATE INDEX payment_methods_user_idx ON payment_methods (user_id);

CREATE TABLE deposits (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  payment_method_id INT REFERENCES payment_methods(id) ON DELETE SET NULL,
  provider TEXT NOT NULL DEFAULT 'demo',
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
  status TEXT NOT NULL DEFAULT 'held' CHECK (status IN ('held','refund_requested','refunded')),
  reference TEXT NOT NULL,
  refunded_by INT REFERENCES users(id),
  refunded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX deposits_user_idx ON deposits (user_id);

CREATE TABLE title_addresses (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  line1 TEXT NOT NULL,
  line2 TEXT NOT NULL DEFAULT '',
  country CHAR(2) NOT NULL DEFAULT 'ES',
  province TEXT NOT NULL,
  city TEXT NOT NULL,
  postal_code TEXT NOT NULL,
  location_codes TEXT[] NOT NULL DEFAULT '{}',   -- sedes cuyos títulos se envían a esta dirección (vacío = todas)
  is_default BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX title_addresses_user_idx ON title_addresses (user_id);

CREATE TRIGGER payment_methods_set_updated_at BEFORE UPDATE ON payment_methods FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER deposits_set_updated_at BEFORE UPDATE ON deposits FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER title_addresses_set_updated_at BEFORE UPDATE ON title_addresses FOR EACH ROW EXECUTE FUNCTION set_updated_at();
