-- ════════════════════════════════════════════════════════════════════════════
-- 1.6.0 — Promos: snapshot de montos + proveedora/pago por servicio
-- ════════════════════════════════════════════════════════════════════════════
-- Una promo agrupa varios servicios. Al guardar se CONGELAN (snapshot) los montos
-- para auditar el valor real de ese momento, aunque después cambien los precios de
-- catálogo (principio §1.2 / regla §4.10 de reglas_negocio.md):
--   · promotions.services_subtotal → suma de precios de lista de los servicios
--   · promotions.final_amount      → total de la promo con el descuento aplicado
--   · promotion_service.service_price → precio del servicio frizado por línea
--   · promotion_service.service_provider_id → proveedora asignada a ese servicio
--   · promotion_service.provider_payment    → pago a esa proveedora por la promo
-- Margen empresa = final_amount − Σ provider_payment (derivado, se calcula en vivo).
-- Idempotente: se puede correr más de una vez sin romper.

-- ── promotions (cabecera) ───────────────────────────────────────────────────
ALTER TABLE promotions
  ADD COLUMN IF NOT EXISTS services_subtotal DECIMAL(10,2);
ALTER TABLE promotions
  ADD COLUMN IF NOT EXISTS final_amount DECIMAL(10,2);

-- ── promotion_service (líneas) ──────────────────────────────────────────────
ALTER TABLE promotion_service
  ADD COLUMN IF NOT EXISTS service_provider_id UUID NULL;
ALTER TABLE promotion_service
  ADD COLUMN IF NOT EXISTS service_price DECIMAL(10,2);
ALTER TABLE promotion_service
  ADD COLUMN IF NOT EXISTS provider_payment DECIMAL(10,2);

-- FK de la proveedora asignada (guard para idempotencia).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_promo_service_provider'
  ) THEN
    ALTER TABLE promotion_service
      ADD CONSTRAINT fk_promo_service_provider
      FOREIGN KEY (service_provider_id) REFERENCES service_providers(id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_promo_service_provider
  ON promotion_service (service_provider_id);
