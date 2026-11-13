-- 005: inicio de sesión social (OAuth) y anuncios del dueño (alertas / publicidad).

-- Identidades externas vinculadas a una cuenta (Google, Microsoft…). Nunca guarda contraseñas del proveedor.
CREATE TABLE oauth_identities (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider ~ '^[a-z][a-z0-9_]{1,20}$'),
  provider_user_id TEXT NOT NULL,
  email TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_user_id)
);
CREATE INDEX oauth_identities_user_idx ON oauth_identities (user_id);

-- Marca de correo verificado (los proveedores OAuth entregan correos ya verificados).
ALTER TABLE users ADD COLUMN email_verified BOOLEAN NOT NULL DEFAULT false;

-- Anuncios creados por el dueño: avisos, promociones y publicidad propia mostrados a los miembros.
CREATE TABLE announcements (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  style TEXT NOT NULL DEFAULT 'promo' CHECK (style IN ('info','promo','alert','success')),
  image_url TEXT,
  cta_text TEXT,
  cta_url TEXT,
  placement TEXT NOT NULL DEFAULT 'both' CHECK (placement IN ('banner','feed','both')),
  audience TEXT NOT NULL DEFAULT 'all' CHECK (audience IN ('all','buyers','sellers','guest','basic','premium','staff')),
  active BOOLEAN NOT NULL DEFAULT true,
  dismissible BOOLEAN NOT NULL DEFAULT true,
  starts_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ends_at TIMESTAMPTZ,
  pushed_at TIMESTAMPTZ,                 -- cuándo se envió al buzón de notificaciones (si se hizo)
  created_by INT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX announcements_live_idx ON announcements (active, starts_at, ends_at);

-- Banners de anuncio que cada miembro ha cerrado (para no volver a mostrarlos).
CREATE TABLE announcement_dismissals (
  announcement_id INT NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  dismissed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (announcement_id, user_id)
);

CREATE TRIGGER announcements_set_updated_at BEFORE UPDATE ON announcements FOR EACH ROW EXECUTE FUNCTION set_updated_at();
