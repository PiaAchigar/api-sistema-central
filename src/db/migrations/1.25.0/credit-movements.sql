-- ════════════════════════════════════════════════════════════════════════════
-- 1.25.0 — Historial de saldo a favor del cliente
-- ════════════════════════════════════════════════════════════════════════════
-- `customers.credit_balance` (1.8.0) es un número acumulado: dice CUÁNTO tiene
-- a favor un cliente, pero no de dónde salió ni en qué se usó. Mientras el saldo
-- solo subía (al cancelar un turno con seña paga) se podía vivir con eso; ahora
-- que además se CONSUME al reservar, sin historial un saldo mal quedaría
-- imposible de reconstruir.
--
-- Cada fila es un movimiento:
--   · amount > 0  → acredita (ej: se canceló un turno con seña paga)
--   · amount < 0  → consume  (ej: se usó como seña de un turno nuevo)
--
-- El saldo de `customers.credit_balance` siempre debe ser igual a la suma de los
-- movimientos del cliente; ambos se escriben en la misma transacción.
--
-- Idempotente: se puede correr más de una vez sin romper.

CREATE TABLE IF NOT EXISTS customer_credit_movements (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id    UUID NOT NULL,
  -- Positivo acredita, negativo consume. Nunca cero.
  amount         DECIMAL(10,2) NOT NULL,
  -- appointment_cancelled | deposit_paid_with_credit | manual_adjustment
  reason         VARCHAR(50) NOT NULL,
  appointment_id UUID NULL,
  payment_id     UUID NULL,
  notes          TEXT,
  created_at     TIMESTAMP DEFAULT now(),
  CONSTRAINT chk_credit_movement_amount CHECK (amount <> 0)
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_credit_mov_customer') THEN
    ALTER TABLE customer_credit_movements
      ADD CONSTRAINT fk_credit_mov_customer
      FOREIGN KEY (customer_id) REFERENCES customers(id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_credit_mov_appointment') THEN
    ALTER TABLE customer_credit_movements
      ADD CONSTRAINT fk_credit_mov_appointment
      FOREIGN KEY (appointment_id) REFERENCES appointments(id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_credit_mov_payment') THEN
    ALTER TABLE customer_credit_movements
      ADD CONSTRAINT fk_credit_mov_payment
      FOREIGN KEY (payment_id) REFERENCES payments(id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_credit_mov_customer
  ON customer_credit_movements (customer_id, created_at DESC);
