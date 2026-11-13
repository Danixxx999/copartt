-- 002: control total del propietario (suplantación auditada, roles personalizados)
--      y área de miembro estilo Copart (Buy It Now, contraofertas, vistos recientemente).

-- Suplantación: la sesión del usuario suplantado recuerda qué administrador la abrió.
ALTER TABLE sessions ADD COLUMN impersonator_id INT REFERENCES users(id) ON DELETE CASCADE;

-- Roles personalizados: el código ya no está limitado a los 5 roles del sistema.
ALTER TABLE roles DROP CONSTRAINT IF EXISTS roles_code_check;
ALTER TABLE roles ADD CONSTRAINT roles_code_format CHECK (code ~ '^[a-z][a-z0-9_]{1,30}$');
ALTER TABLE roles ADD COLUMN description TEXT NOT NULL DEFAULT '';
ALTER TABLE roles ADD COLUMN is_system BOOLEAN NOT NULL DEFAULT false;
UPDATE roles SET is_system = true WHERE code IN ('buyer','seller','admin','finance','ops');

-- Nuevos tipos de puja: compra inmediata y contraoferta aceptada.
ALTER TABLE bids DROP CONSTRAINT IF EXISTS bids_kind_check;
ALTER TABLE bids ADD CONSTRAINT bids_kind_check CHECK (kind IN ('prebid','live','auto','buy_now','counter'));

-- Contraoferta del vendedor cuando la puja más alta no alcanza la reserva, y vía de venta.
ALTER TABLE auction_lots ADD COLUMN counter_offer_cents BIGINT CHECK (counter_offer_cents IS NULL OR counter_offer_cents > 0);
ALTER TABLE auction_lots ADD COLUMN counter_offer_at TIMESTAMPTZ;
ALTER TABLE auction_lots ADD COLUMN sold_via TEXT CHECK (sold_via IN ('auction','buy_now','seller_approval','counter_offer'));
ALTER TABLE auction_lots ADD CONSTRAINT auction_lots_buy_now_positive CHECK (buy_now_cents IS NULL OR buy_now_cents > 0);
UPDATE auction_lots SET sold_via = 'auction' WHERE status = 'awarded' AND sold_via IS NULL;

-- Vehículos vistos recientemente (widget del panel del miembro).
CREATE TABLE lot_views (
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lot_id INT NOT NULL REFERENCES auction_lots(id) ON DELETE CASCADE,
  views INT NOT NULL DEFAULT 1,
  viewed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, lot_id)
);
CREATE INDEX lot_views_user_idx ON lot_views (user_id, viewed_at DESC);
