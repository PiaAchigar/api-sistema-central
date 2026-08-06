-- ════════════════════════════════════════════════════════════════════════════
-- 1.24.1 — Reconcilia la nulabilidad de SUBSCRIPTION_BILLING_CYCLES
-- ════════════════════════════════════════════════════════════════════════════
-- En producción quedó `subscription_id` como NOT NULL: al marcar una suscripción
-- como pagada, el insert del ciclo del mes (que sólo completa
-- training_subscription_id) fallaba con
--     null value in column "subscription_id" violates not-null constraint
--
-- Es el paso 2 de la migración 1.22.0, que no llegó a aplicarse. El resto de esa
-- serie sí está: la columna training_subscription_id existe (1.22.0 paso 1) y el
-- índice único parcial también (1.22.1) — se sabe porque el ON CONFLICT del
-- upsert se resuelve en la planificación, antes de ejecutar, así que si faltara
-- el índice el error habría sido otro y nunca se habría llegado al NOT NULL.
--
-- Esta migración deja el estado final correcto y es IDEMPOTENTE: se puede correr
-- esté como esté la base, haya corrido o no 1.22.0 y 1.22.1. Sirve tanto para
-- arreglar producción como para que una base nueva quede igual.

-- ────────────────────────────────────────────────────────────────────────────
-- Step 1: las DOS columnas de suscripción son nulleables
-- ────────────────────────────────────────────────────────────────────────────
-- La tabla sirve a los dos tipos de suscripción y cada fila usa una sola:
--   training_subscription_id → ACTIVIDADES
--   subscription_id          → servicios / capacitaciones (a futuro)
-- Que cualquiera de las dos sea obligatoria hace imposible el otro caso.
-- DROP NOT NULL no falla si la columna ya es nulleable.
ALTER TABLE subscription_billing_cycles
  ALTER COLUMN subscription_id DROP NOT NULL;

ALTER TABLE subscription_billing_cycles
  ALTER COLUMN training_subscription_id DROP NOT NULL;

-- ────────────────────────────────────────────────────────────────────────────
-- Step 2: el CHECK que garantiza que haya al menos una de las dos
-- ────────────────────────────────────────────────────────────────────────────
-- Es lo que impide que, ahora que ambas son nulleables, entre una fila huérfana.
ALTER TABLE subscription_billing_cycles
  DROP CONSTRAINT IF EXISTS chk_billing_cycles_subscription_type_required;

ALTER TABLE subscription_billing_cycles
  ADD CONSTRAINT chk_billing_cycles_subscription_type_required
  CHECK (subscription_id IS NOT NULL OR training_subscription_id IS NOT NULL);

-- ────────────────────────────────────────────────────────────────────────────
-- Step 3: índice único parcial por (suscripción de actividad, mes)
-- ────────────────────────────────────────────────────────────────────────────
-- Es el que usa el ON CONFLICT del upsert de pago. Si 1.22.1 ya corrió, no hace
-- nada; si no, lo crea.
CREATE UNIQUE INDEX IF NOT EXISTS uq_billing_cycles_training_subscription_month
  ON subscription_billing_cycles(training_subscription_id, billing_month)
  WHERE training_subscription_id IS NOT NULL;

-- ────────────────────────────────────────────────────────────────────────────
-- Step 4: el UNIQUE legacy no debe bloquear las filas de actividades
-- ────────────────────────────────────────────────────────────────────────────
-- uq_billing_cycles_subscription_month (1.21.0) es un UNIQUE total sobre
-- (subscription_id, billing_month). Con subscription_id ahora NULL en todas las
-- filas de actividades, en Postgres los NULL no colisionan entre sí, así que no
-- rompe. Se lo vuelve parcial de todos modos para dejar explícito que sólo
-- aplica a las filas legacy y para no arrastrar entradas inútiles en el índice.
DROP INDEX IF EXISTS uq_billing_cycles_subscription_month;

CREATE UNIQUE INDEX IF NOT EXISTS uq_billing_cycles_subscription_month
  ON subscription_billing_cycles(subscription_id, billing_month)
  WHERE subscription_id IS NOT NULL;
