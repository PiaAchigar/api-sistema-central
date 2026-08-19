-- api-sistema-central/src/db/migrations/1.30.0/01-combos.sql
-- ═══════════════════════════════════════════════════════════════════════════
-- 1.30.0 — Combos (fase 1: catálogo)
--
-- Un combo es un paquete de sesiones que la clienta compra una vez y consume
-- a lo largo de meses. NO es una promo: una promo caduca, un combo se
-- consume. Por eso son tablas propias y no una extensión de `promotions`.
--
-- Esta migración crea SOLO el catálogo. La compra (`customer_combos`) y el
-- consumo (`customer_combo_consumptions`) son las fases 2 y 3.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS combos (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                varchar(200)   NOT NULL,
  description         text,
  price_type          varchar(20)    NOT NULL,
  fixed_price         numeric(10,2),
  discount_percentage numeric(5,2),
  validity_months     integer        NOT NULL,
  is_active           boolean        NOT NULL DEFAULT true,
  is_visible_web      boolean        NOT NULL DEFAULT true,
  display_order       integer        NOT NULL DEFAULT 0,
  created_at          timestamp      NOT NULL DEFAULT now(),
  updated_at          timestamp      NOT NULL DEFAULT now(),

  -- Cada tipo de precio exige su propio campo. Sin esto se puede guardar un
  -- combo 'fixed' sin precio, que después no se sabe cuánto sale.
  CONSTRAINT combos_price_type_check
    CHECK (price_type IN ('fixed', 'percentage')),
  CONSTRAINT combos_fixed_needs_price
    CHECK (price_type <> 'fixed' OR fixed_price IS NOT NULL),
  CONSTRAINT combos_percentage_needs_pct
    CHECK (price_type <> 'percentage'
           OR (discount_percentage IS NOT NULL
               AND discount_percentage >= 0
               AND discount_percentage <= 100)),
  CONSTRAINT combos_validity_positive
    CHECK (validity_months > 0)
);

CREATE TABLE IF NOT EXISTS combo_service (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  combo_id           uuid    NOT NULL REFERENCES combos(id) ON DELETE CASCADE,
  service_id         uuid    NOT NULL REFERENCES service(id),
  sessions_included  integer NOT NULL,
  service_price      numeric(10,2),
  created_at         timestamp NOT NULL DEFAULT now(),

  -- Un servicio no puede estar dos veces en el mismo combo: si hacen falta
  -- más sesiones se sube sessions_included, no se agrega otra fila.
  CONSTRAINT uq_combo_service UNIQUE (combo_id, service_id),
  CONSTRAINT combo_service_sessions_positive CHECK (sessions_included > 0)
);

CREATE INDEX IF NOT EXISTS idx_combo_service_combo_id   ON combo_service(combo_id);
CREATE INDEX IF NOT EXISTS idx_combo_service_service_id ON combo_service(service_id);
CREATE INDEX IF NOT EXISTS idx_combos_active_web        ON combos(is_active, is_visible_web);
