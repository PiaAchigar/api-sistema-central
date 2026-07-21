-- ════════════════════════════════════════════════════════════════════════════
-- 1.7.0 — Trazabilidad pago ↔ turno (desglose de comisión en caja)
-- ════════════════════════════════════════════════════════════════════════════
-- El checkout ya neteaba la factura por la comisión de la proveedora
-- (service_provider_service, ver 1.1.0), pero no quedaba registro de QUÉ pago
-- vino de qué turno — así que la Rendición de caja no podía mostrar cuánto de
-- cada cobro corresponde a la proveedora. payments.appointment_id cierra ese
-- vínculo (nullable: los pagos sin turno asociado, ítems sueltos, etc. quedan
-- en NULL). Idempotente: se puede correr más de una vez sin romper.

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS appointment_id UUID NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_payments_appointment'
  ) THEN
    ALTER TABLE payments
      ADD CONSTRAINT fk_payments_appointment
      FOREIGN KEY (appointment_id) REFERENCES appointments(id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_payments_appointment ON payments (appointment_id);
