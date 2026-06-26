-- ════════════════════════════════════════════════════════════════════════════
-- 1.4.0 — Cuentas de MercadoPago por proveedora de servicio
-- ════════════════════════════════════════════════════════════════════════════
-- Modelo: una cuenta MP PERTENECE a una service_provider (la FK va en el lado
-- "hijo": mercadopago_accounts). Relación 1:N — una proveedora puede tener
-- varias cuentas. La cuenta de la empresa/compañía entra por la persona física
-- de la dueña, que también es un service_provider. Por eso NO hay índice único
-- por proveedora y NO se usa company_config_id.
-- Idempotente: se puede correr más de una vez sin romper.

ALTER TABLE mercadopago_accounts
  ADD COLUMN IF NOT EXISTS service_provider_id UUID NULL;

-- Alias y CVU para recibir transferencias (distinto de las credenciales OAuth).
ALTER TABLE mercadopago_accounts
  ADD COLUMN IF NOT EXISTS alias VARCHAR(255);
ALTER TABLE mercadopago_accounts
  ADD COLUMN IF NOT EXISTS cvu VARCHAR(34);

-- FK hacia service_providers (guard para idempotencia).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_mp_provider'
  ) THEN
    ALTER TABLE mercadopago_accounts
      ADD CONSTRAINT fk_mp_provider
      FOREIGN KEY (service_provider_id) REFERENCES service_providers(id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_mp_provider
  ON mercadopago_accounts (service_provider_id);
