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
  ADD COLUMN training_subscription_id UUID
  REFERENCES training_subscriptions(id) ON DELETE CASCADE;

-- Backfill: copy subscription_id values to training_subscription_id (since all current
-- rows in subscription_billing_cycles reference training_subscriptions)
UPDATE subscription_billing_cycles
SET training_subscription_id = subscription_id
WHERE subscription_id IS NOT NULL;

-- Make training_subscription_id NOT NULL after backfill
ALTER TABLE subscription_billing_cycles
  ALTER COLUMN training_subscription_id SET NOT NULL;

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
  ADD CONSTRAINT chk_billing_cycles_subscription_type_required
  CHECK (subscription_id IS NOT NULL OR training_subscription_id IS NOT NULL);
