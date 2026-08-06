-- ════════════════════════════════════════════════════════════════════════════
-- Verificación del esquema — pegar en el SQL Editor de Supabase
-- ════════════════════════════════════════════════════════════════════════════
-- Las migraciones se aplican a mano (ver CLAUDE.md §5), así que una puede no
-- llegar y el error aparece mucho después, en runtime. Pasó con el paso 2 de la
-- 1.22.0: `subscription_id` quedó NOT NULL y recién se notó al marcar un pago.
--
-- Este script no modifica nada. Cada fila dice OK o FALTA.
-- Si algo dice FALTA, correr la migración indicada en la columna `arreglar_con`.

SELECT * FROM (
  -- ── 1.22.0 / 1.24.1 — columnas de SUBSCRIPTION_BILLING_CYCLES ──
  SELECT
    'billing_cycles.training_subscription_id existe' AS chequeo,
    CASE WHEN EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'subscription_billing_cycles'
        AND column_name = 'training_subscription_id'
    ) THEN 'OK' ELSE 'FALTA' END AS estado,
    '1.22.0' AS arreglar_con

  UNION ALL
  SELECT
    'billing_cycles.subscription_id es nulleable',
    CASE WHEN COALESCE((
      SELECT is_nullable FROM information_schema.columns
      WHERE table_name = 'subscription_billing_cycles' AND column_name = 'subscription_id'
    ), 'NO') = 'YES' THEN 'OK' ELSE 'FALTA' END,
    '1.24.1'

  UNION ALL
  SELECT
    'billing_cycles.training_subscription_id es nulleable',
    CASE WHEN COALESCE((
      SELECT is_nullable FROM information_schema.columns
      WHERE table_name = 'subscription_billing_cycles' AND column_name = 'training_subscription_id'
    ), 'NO') = 'YES' THEN 'OK' ELSE 'FALTA' END,
    '1.24.1'

  UNION ALL
  SELECT
    'billing_cycles: UNIQUE (training_subscription_id, billing_month)',
    CASE WHEN EXISTS (
      SELECT 1 FROM pg_indexes
      WHERE tablename = 'subscription_billing_cycles'
        AND indexname = 'uq_billing_cycles_training_subscription_month'
    ) THEN 'OK' ELSE 'FALTA' END,
    '1.24.1'

  -- ── 1.22.2 — el FK colgado hacia TRAINING no debe existir ──
  UNION ALL
  SELECT
    'training_subscriptions: FK colgado a training eliminado',
    CASE WHEN NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'training_subscriptions_training_id_fkey'
    ) THEN 'OK' ELSE 'FALTA' END,
    '1.22.2'

  -- ── 1.23.0 — asistencias idempotentes ──
  UNION ALL
  SELECT
    'activity_attendance: UNIQUE (subscription_id, class_date)',
    CASE WHEN EXISTS (
      SELECT 1 FROM pg_indexes
      WHERE tablename = 'activity_attendance'
        AND indexname = 'uq_activity_attendance_subscription_date'
    ) THEN 'OK' ELSE 'FALTA' END,
    '1.23.0'

  -- ── 1.24.0 — agenda de clases ──
  UNION ALL
  SELECT
    'activity_schedules.capacity existe',
    CASE WHEN EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'activity_schedules' AND column_name = 'capacity'
    ) THEN 'OK' ELSE 'FALTA' END,
    '1.24.0'

  UNION ALL
  SELECT
    'tabla training_sessions existe',
    CASE WHEN EXISTS (
      SELECT 1 FROM information_schema.tables WHERE table_name = 'training_sessions'
    ) THEN 'OK' ELSE 'FALTA' END,
    '1.24.0'

  UNION ALL
  SELECT
    'appointments.training_session_id existe',
    CASE WHEN EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'appointments' AND column_name = 'training_session_id'
    ) THEN 'OK' ELSE 'FALTA' END,
    '1.24.0'
) t
ORDER BY CASE WHEN estado = 'FALTA' THEN 0 ELSE 1 END, chequeo;
