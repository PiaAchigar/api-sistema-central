-- ════════════════════════════════════════════════════════════════════════════
-- 1.66.0 / 01 — Efectivo de combos, plazo en semanas y aplazos de compras (#30, #31)
-- ════════════════════════════════════════════════════════════════════════════
-- 1) Los combos y packs tienen precio de lista Y precio en efectivo. El efectivo
--    de cada renglón se congela al guardar (igual que `service_price`), por la
--    misma razón: subirle el precio a un servicio no puede mover lo que muestran
--    los combos que ya existen.
-- 2) La vigencia pasa de meses a SEMANAS. `validity_months` se conserva sin uso;
--    borrarla es una migración aparte, cuando esté verificado que nada la lee.
-- 3) `customer_purchase.price_mode` dice con qué precio se vendió. NULL = venta
--    anterior a 1.66.0 (no se inventa).
-- 4) `purchase_expiry_postponements`: cada vez que se corre el vencimiento de una
--    compra queda una fila (antes, después, motivo, quién).
--
-- Las columnas y tablas son sentencias sueltas e idempotentes (SQL Editor de
-- Supabase: autocommit por sentencia). El backfill va en UN solo bloque DO, y
-- sólo llena lo que está en NULL, así que se puede correr dos veces.
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE combo_service ADD COLUMN IF NOT EXISTS service_price_cash numeric(10,2);

ALTER TABLE combos ADD COLUMN IF NOT EXISTS fixed_price_cash numeric(10,2);

ALTER TABLE combos ADD COLUMN IF NOT EXISTS validity_weeks integer
  CONSTRAINT ck_combos_validity_weeks CHECK (validity_weeks > 0);

ALTER TABLE depilation_combo ADD COLUMN IF NOT EXISTS validity_weeks integer
  CONSTRAINT ck_dc_validity_weeks CHECK (validity_weeks > 0);

ALTER TABLE customer_purchase ADD COLUMN IF NOT EXISTS price_mode varchar(10)
  CONSTRAINT ck_customer_purchase_price_mode CHECK (price_mode IN ('lista', 'efectivo'));

CREATE TABLE IF NOT EXISTS purchase_expiry_postponements (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_id         uuid NOT NULL REFERENCES customer_purchase(id) ON DELETE CASCADE,
  previous_expires_at timestamp NOT NULL,
  new_expires_at      timestamp NOT NULL,
  reason              text,
  user_id             uuid,
  user_email          varchar(255),
  created_at          timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_purchase_expiry_postponements_purchase
  ON purchase_expiry_postponements (purchase_id);

-- RLS como en el resto de las tablas de `public`: sin esto la clave publishable
-- podría leer y reescribir los aplazos por la Data API. El Worker entra como
-- dueño (postgres) y no se ve afectado.
ALTER TABLE purchase_expiry_postponements ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  n_cash int;
  n_combos int;
  n_dep int;
BEGIN
  -- Efectivo de cada renglón: el del servicio si tiene, si no la lista, si no
  -- lo que ya estaba congelado. `fixed_price_cash` NO se rellena: "Belleza de
  -- ojos completa" queda con el efectivo vacío hasta que Laura lo cargue.
  UPDATE combo_service cs
     SET service_price_cash = COALESCE(s.unit_price_cash, s.unit_price_list, cs.service_price)
    FROM service s
   WHERE s.id = cs.service_id AND cs.service_price_cash IS NULL;
  GET DIAGNOSTICS n_cash = ROW_COUNT;

  -- Meses a semanas, redondeando para arriba: nunca se acorta una vigencia.
  UPDATE combos
     SET validity_weeks = ceil(validity_months * 52 / 12.0)
   WHERE validity_weeks IS NULL AND validity_months IS NOT NULL;
  GET DIAGNOSTICS n_combos = ROW_COUNT;

  UPDATE depilation_combo
     SET validity_weeks = ceil(validity_months * 52 / 12.0)
   WHERE validity_weeks IS NULL AND validity_months IS NOT NULL;
  GET DIAGNOSTICS n_dep = ROW_COUNT;

  RAISE NOTICE '1.66.0: % renglones con efectivo, % combos y % packs de depilación con semanas', n_cash, n_combos, n_dep;
END $$;

-- Verificación (correr aparte):
-- SELECT c.name, c.validity_months, c.validity_weeks, c.fixed_price, c.fixed_price_cash FROM combos c ORDER BY 1;
-- SELECT count(*) FILTER (WHERE service_price_cash IS NULL) AS sin_efectivo FROM combo_service;
