-- ==============================================================================
-- 1.1.0 — Sincronización idempotente entre init.sql y el estado documentado
-- de la BD viva (DOCUMENTACION_BD.md v2.1/v2.2), más columnas nuevas del
-- sistema de cobranza. Seguro de correr múltiples veces.
-- ==============================================================================

-- SERVICE: dos precios (lista y efectivo) — doc v2.x
ALTER TABLE service ADD COLUMN IF NOT EXISTS unit_price_list DECIMAL(10,2);
ALTER TABLE service ADD COLUMN IF NOT EXISTS unit_price_cash DECIMAL(10,2);
-- Backfill desde unit_price si la columna vieja existe y los precios nuevos están vacíos
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'service' AND column_name = 'unit_price'
  ) THEN
    EXECUTE 'UPDATE service SET unit_price_list = COALESCE(unit_price_list, unit_price), unit_price_cash = COALESCE(unit_price_cash, unit_price)';
  END IF;
END $$;

-- CUSTOMERS: dni/cuit separados (doc v1.2+; init.sql traía tax_id)
ALTER TABLE customers ADD COLUMN IF NOT EXISTS dni VARCHAR(50);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS cuit VARCHAR(50);

-- INVOICES: recargo/descuento (doc v2.1)
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS adjustment_amount DECIMAL(10,2);

-- LINE_ITEMS: updated_at (doc v2.1)
ALTER TABLE line_items ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP;

-- APPOINTMENTS: snapshots de pago a proveedora (doc v2.2)
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS provider_payment_type VARCHAR(50);
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS provider_rate DECIMAL(10,2);
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS provider_earning DECIMAL(10,2);

-- PAYMENTS: pago transferido directo a la profesional (nuevo, sistema de cobranza)
ALTER TABLE payments ADD COLUMN IF NOT EXISTS received_by_provider_id UUID;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'fk_pay_received_by_provider'
  ) THEN
    ALTER TABLE payments
      ADD CONSTRAINT fk_pay_received_by_provider
      FOREIGN KEY (received_by_provider_id) REFERENCES service_providers(id);
  END IF;
END $$;

-- SERVICE_PROVIDER_SERVICE: acuerdo de pago por (proveedora, servicio) — doc v2.2
CREATE TABLE IF NOT EXISTS service_provider_service (
  id UUID PRIMARY KEY,
  service_provider_id UUID NOT NULL,
  service_id UUID NOT NULL,
  payment_type VARCHAR(50) NOT NULL, -- per_hour | percentage | fixed_per_service
  rate DECIMAL(10,2) NOT NULL,
  valid_from DATE,
  valid_until DATE,
  is_active BOOLEAN DEFAULT true,
  notes TEXT,
  created_at TIMESTAMP,
  updated_at TIMESTAMP,
  CONSTRAINT chk_sps_rate CHECK (
    rate > 0 AND (payment_type <> 'percentage' OR rate <= 100)
  )
);
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'fk_sps_provider'
  ) THEN
    ALTER TABLE service_provider_service
      ADD CONSTRAINT fk_sps_provider
      FOREIGN KEY (service_provider_id) REFERENCES service_providers(id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'fk_sps_service'
  ) THEN
    ALTER TABLE service_provider_service
      ADD CONSTRAINT fk_sps_service
      FOREIGN KEY (service_id) REFERENCES service(id);
  END IF;
END $$;
-- Un solo acuerdo activo por (proveedora, servicio); el historial queda is_active=false
CREATE UNIQUE INDEX IF NOT EXISTS uq_sps_active
  ON service_provider_service (service_provider_id, service_id)
  WHERE is_active;

-- VIEW de normalización a $/hora (doc v2.2)
CREATE OR REPLACE VIEW provider_rates_per_hour AS
SELECT
  sps.id,
  sps.service_provider_id,
  sp.full_name AS provider_name,
  sps.service_id,
  s.name AS service_name,
  sps.payment_type,
  sps.rate,
  CASE sps.payment_type
    WHEN 'per_hour' THEN sps.rate
    WHEN 'fixed_per_service' THEN round(sps.rate * 60.0 / NULLIF(s.estimated_duration_minutes, 0), 2)
    WHEN 'percentage' THEN round((sps.rate / 100.0) * s.unit_price_cash * 60.0 / NULLIF(s.estimated_duration_minutes, 0), 2)
  END AS equivalent_hourly_rate
FROM service_provider_service sps
JOIN service s ON s.id = sps.service_id
JOIN service_providers sp ON sp.id = sps.service_provider_id
WHERE sps.is_active;

-- Índices de soporte para queries calientes de agenda y caja
CREATE INDEX IF NOT EXISTS idx_appt_provider_start ON appointments (service_provider_id, appointment_start);
CREATE INDEX IF NOT EXISTS idx_appt_machine_start ON appointments (machine_id, appointment_start);
CREATE INDEX IF NOT EXISTS idx_payments_date ON payments (payment_date);
CREATE INDEX IF NOT EXISTS idx_cash_registration_date ON cash_register (registration_date);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices (status);
