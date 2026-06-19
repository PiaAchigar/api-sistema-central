-- ==============================================================================
-- 1.2.0 — Schema additions: web content tables + new columns + bug fix
-- Seguro de correr múltiples veces (idempotente).
-- Verificado contra el estado real de Supabase el 2026-06-16.
-- ==============================================================================

-- ── BUG FIX: service_providers.user_id tenía tipo TIMESTAMP en vez de UUID.
-- Todas las filas tienen NULL, así que el DROP/ADD es seguro.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'service_providers'
      AND column_name  = 'user_id'
      AND data_type   != 'uuid'
  ) THEN
    ALTER TABLE service_providers DROP COLUMN user_id;
    ALTER TABLE service_providers ADD COLUMN user_id UUID REFERENCES users(id);
  END IF;
END $$;

-- ── COLUMNA NUEVA en `users`: vincula con Supabase Auth (auth.users.id)
ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_id UUID UNIQUE;

-- ── COLUMNAS NUEVAS en `service_providers`: datos personales y laborales
ALTER TABLE service_providers ADD COLUMN IF NOT EXISTS dni         VARCHAR(50);
ALTER TABLE service_providers ADD COLUMN IF NOT EXISTS cuit        VARCHAR(50);
ALTER TABLE service_providers ADD COLUMN IF NOT EXISTS birthdate   DATE;
ALTER TABLE service_providers ADD COLUMN IF NOT EXISTS address     VARCHAR(255);
ALTER TABLE service_providers ADD COLUMN IF NOT EXISTS postal_code VARCHAR(20);
ALTER TABLE service_providers ADD COLUMN IF NOT EXISTS cv_url      TEXT;

-- ── COLUMNAS NUEVAS en `service`: visibilidad y presencia en piubella_web
ALTER TABLE service ADD COLUMN IF NOT EXISTS is_visible        BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE service ADD COLUMN IF NOT EXISTS web_image_r2_path VARCHAR(500);
ALTER TABLE service ADD COLUMN IF NOT EXISTS web_sort_order    INTEGER NOT NULL DEFAULT 0;

-- ── COLUMNAS NUEVAS en `company_config`: hero de la home de piubella_web
ALTER TABLE company_config ADD COLUMN IF NOT EXISTS hero_title    VARCHAR(255);
ALTER TABLE company_config ADD COLUMN IF NOT EXISTS hero_subtitle VARCHAR(500);

-- ── TABLA NUEVA: web_gallery
-- Fotos del sitio gestionadas desde el dashboard.
-- Las imágenes se almacenan en Cloudflare R2; acá se persiste el path y metadata.
CREATE TABLE IF NOT EXISTS web_gallery (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  r2_path     VARCHAR(500) NOT NULL,
  public_url  VARCHAR(500) NOT NULL,
  alt         VARCHAR(255),
  caption     VARCHAR(500),
  sort_order  INTEGER      NOT NULL DEFAULT 0,
  is_visible  BOOLEAN      NOT NULL DEFAULT true,
  created_at  TIMESTAMP    NOT NULL DEFAULT now()
);

-- ── TABLA NUEVA: web_testimonials
-- Testimonios de clientes, editables desde el dashboard.
CREATE TABLE IF NOT EXISTS web_testimonials (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  author_name  VARCHAR(255) NOT NULL,
  body         TEXT         NOT NULL,
  rating       INTEGER      CHECK (rating BETWEEN 1 AND 5),
  is_visible   BOOLEAN      NOT NULL DEFAULT true,
  created_at   TIMESTAMP    NOT NULL DEFAULT now()
);

-- ── TABLA NUEVA: contact_notes
-- Notas internas del staff sobre un contacto del CRM.
CREATE TABLE IF NOT EXISTS contact_notes (
  id          UUID      PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id  UUID      NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  body        TEXT      NOT NULL,
  created_by  UUID      REFERENCES users(id),
  created_at  TIMESTAMP NOT NULL DEFAULT now()
);

-- ── ÍNDICES de soporte
CREATE INDEX IF NOT EXISTS idx_web_gallery_sort      ON web_gallery (sort_order) WHERE is_visible;
CREATE INDEX IF NOT EXISTS idx_web_testimonials_vis  ON web_testimonials (is_visible, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_contact_notes_contact ON contact_notes (contact_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_users_auth_id         ON users (auth_id) WHERE auth_id IS NOT NULL;
