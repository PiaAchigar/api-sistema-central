-- ════════════════════════════════════════════════════════════════════════════
-- 1.22.1 — Corrige 1.22.0: training_subscription_id nulleable + UNIQUE por mes
-- ════════════════════════════════════════════════════════════════════════════
-- La migración 1.22.0 dejó training_subscription_id como NOT NULL, lo que anula
-- el propósito de la tabla: SUBSCRIPTION_BILLING_CYCLES tiene que poder guardar
-- ciclos de los DOS tipos de suscripción —
--   - training_subscription_id → ACTIVIDADES (Pilates, Yoga...)
--   - subscription_id          → suscripciones a servicios / capacitaciones (futuro)
-- Con NOT NULL, una fila que solo tenga subscription_id es imposible de insertar,
-- y el CHECK chk_billing_cycles_subscription_type_required nunca puede fallar
-- (queda como código muerto).
--
-- Además 1.22.0 nunca creó el índice UNIQUE que la documentación describe. Sin
-- él, dos requests concurrentes al endpoint admin de pago pueden duplicar el
-- ciclo del mismo mes (el repositorio hace select-then-insert, no ON CONFLICT).
--
-- Cambios:
--   1. training_subscription_id → DROP NOT NULL
--   2. UNIQUE parcial (training_subscription_id, billing_month)
--   3. Índice de historial de pagos (training_subscription_id, payment_date DESC)

-- ────────────────────────────────────────────────────────────────────────────
-- Step 1: training_subscription_id vuelve a ser nulleable
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE subscription_billing_cycles
  ALTER COLUMN training_subscription_id DROP NOT NULL;

-- ────────────────────────────────────────────────────────────────────────────
-- Step 2: UNIQUE (training_subscription_id, billing_month)
-- ────────────────────────────────────────────────────────────────────────────
-- Parcial: las filas legacy con training_subscription_id NULL no deben chocar
-- entre sí (en Postgres los NULL no son iguales, pero el WHERE lo hace explícito
-- y mantiene el índice chico).
CREATE UNIQUE INDEX IF NOT EXISTS uq_billing_cycles_training_subscription_month
  ON subscription_billing_cycles(training_subscription_id, billing_month)
  WHERE training_subscription_id IS NOT NULL;

-- ────────────────────────────────────────────────────────────────────────────
-- Step 3: Índice de historial de pagos por suscripción
-- ────────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_billing_cycles_training_payment_history
  ON subscription_billing_cycles(training_subscription_id, payment_date DESC);
