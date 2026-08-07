-- ════════════════════════════════════════════════════════════════════════════
-- 1.22.0 — Add training_subscription_id to subscription_billing_cycles
-- ════════════════════════════════════════════════════════════════════════════
-- Purpose: Prepare subscription_billing_cycles to support multiple subscription types:
--   - training_subscription_id: suscripciones a actividades (Pilates, Yoga, etc.)
--   - subscription_id (future): suscripciones a servicios puntuales (depilación, masajes, etc.)
--
-- Changes:
--   1. Add training_subscription_id column (NOT NULL) referencing training_subscriptions
--   2. Make subscription_id nullable (currently NOT NULL, will be used for service subscriptions)
--   3. Add indexes on training_subscription_id
--   4. Add composite index on (subscription_id, training_subscription_id)
--   5. Add CHECK constraint to ensure at least one subscription type is set

-- ────────────────────────────────────────────────────────────────────────────
-- Step 1: Add training_subscription_id column
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE subscription_billing_cycles
  ADD COLUMN IF NOT EXISTS training_subscription_id UUID
  REFERENCES training_subscriptions(id) ON DELETE CASCADE;

-- Backfill: copy subscription_id values to training_subscription_id (since all current
-- rows in subscription_billing_cycles reference training_subscriptions)
UPDATE subscription_billing_cycles
SET training_subscription_id = subscription_id
WHERE subscription_id IS NOT NULL;

-- NOTA: acá iba un `ALTER COLUMN training_subscription_id SET NOT NULL` que la
-- migración 1.24.1 revierte, porque anulaba el propósito de la tabla: con la
-- columna obligatoria era imposible guardar un ciclo del otro tipo de
-- suscripción (subscription_id), que era justamente lo que esta migración
-- venía a habilitar.
--
-- Se eliminó de acá en vez de dejarlo: como las migraciones se aplican a mano,
-- re-correr este archivo "por las dudas" volvía a imponer el NOT NULL y rompía
-- de nuevo el marcado de pagos. La nulabilidad la define 1.24.1.

-- ────────────────────────────────────────────────────────────────────────────
-- Step 2: Make subscription_id nullable
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE subscription_billing_cycles
  ALTER COLUMN subscription_id DROP NOT NULL;

-- ────────────────────────────────────────────────────────────────────────────
-- Step 3: Add index on training_subscription_id
-- ────────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_billing_cycles_training_subscription_id
  ON subscription_billing_cycles(training_subscription_id);

-- ────────────────────────────────────────────────────────────────────────────
-- Step 4: Add composite index on (subscription_id, training_subscription_id)
-- ────────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_billing_cycles_subscription_types
  ON subscription_billing_cycles(subscription_id, training_subscription_id);

-- ────────────────────────────────────────────────────────────────────────────
-- Step 5: Add CHECK constraint to ensure at least one subscription type is set
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE subscription_billing_cycles
  DROP CONSTRAINT IF EXISTS chk_billing_cycles_subscription_type_required;

ALTER TABLE subscription_billing_cycles
  ADD CONSTRAINT chk_billing_cycles_subscription_type_required
  CHECK (subscription_id IS NOT NULL OR training_subscription_id IS NOT NULL);
