-- ════════════════════════════════════════════════════════════════════════════
-- Verificación del esquema — pegar en el SQL Editor de Supabase
-- ════════════════════════════════════════════════════════════════════════════
-- Las migraciones se aplican a mano (ver CLAUDE.md §5), así que una puede no
-- llegar y el error aparece mucho después, en runtime. Pasó con el paso 2 de la
-- 1.22.0: `subscription_id` quedó NOT NULL y recién se notó al marcar un pago.
--
-- Este script no modifica nada. Cada fila dice OK o FALTA, y `detalle` muestra
-- lo que realmente hay en la base para no tener que adivinar.
-- Si algo dice FALTA, correr la migración indicada en `arreglar_con`.
--
-- ⚠️ OJO CON LA SELECCIÓN PARCIAL: el SQL Editor de Supabase ejecuta SOLO el
-- texto seleccionado si hay algo resaltado. Si un script queda a medias sin dar
-- error, el síntoma es exactamente ese — algunos chequeos en OK y otros en
-- FALTA dentro de la MISMA migración. Una migración que falla de verdad revierte
-- todo y deja en FALTA todos sus chequeos. Ante la duda: clic en el editor,
-- Ctrl+A y ejecutar.

SELECT * FROM (
  -- ── 1.22.0 / 1.24.1 — columnas de SUBSCRIPTION_BILLING_CYCLES ──
  SELECT
    'billing_cycles.training_subscription_id existe' AS chequeo,
    CASE WHEN EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'subscription_billing_cycles'
        AND column_name = 'training_subscription_id'
    ) THEN 'OK' ELSE 'FALTA' END AS estado,
    '1.22.0' AS arreglar_con,
    COALESCE((
      SELECT 'columna presente' FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'subscription_billing_cycles'
        AND column_name = 'training_subscription_id'
    ), 'columna ausente') AS detalle

  UNION ALL
  SELECT
    'billing_cycles.subscription_id es nulleable',
    CASE WHEN COALESCE((
      SELECT is_nullable FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'subscription_billing_cycles' AND column_name = 'subscription_id'
    ), 'NO') = 'YES' THEN 'OK' ELSE 'FALTA' END,
    '1.24.1',
    'is_nullable = ' || COALESCE((
      SELECT is_nullable FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'subscription_billing_cycles' AND column_name = 'subscription_id'
    ), '(columna ausente)')

  UNION ALL
  SELECT
    'billing_cycles.training_subscription_id es nulleable',
    CASE WHEN COALESCE((
      SELECT is_nullable FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'subscription_billing_cycles' AND column_name = 'training_subscription_id'
    ), 'NO') = 'YES' THEN 'OK' ELSE 'FALTA' END,
    '1.24.1',
    'is_nullable = ' || COALESCE((
      SELECT is_nullable FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'subscription_billing_cycles' AND column_name = 'training_subscription_id'
    ), '(columna ausente)')

  UNION ALL
  SELECT
    'billing_cycles: UNIQUE (training_subscription_id, billing_month)',
    CASE WHEN EXISTS (
      SELECT 1 FROM pg_indexes
      WHERE tablename = 'subscription_billing_cycles'
        AND indexname = 'uq_billing_cycles_training_subscription_month'
    ) THEN 'OK' ELSE 'FALTA' END,
    '1.24.1',
    'índice ' || 'uq_billing_cycles_training_subscription_month'

  -- ── 1.22.2 — el FK colgado hacia TRAINING no debe existir ──
  UNION ALL
  SELECT
    'training_subscriptions: FK colgado a training eliminado',
    CASE WHEN NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'training_subscriptions_training_id_fkey'
    ) THEN 'OK' ELSE 'FALTA' END,
    '1.22.2',
    'constraint training_subscriptions_training_id_fkey'

  -- ── 1.23.0 — asistencias idempotentes ──
  UNION ALL
  SELECT
    'activity_attendance: UNIQUE (subscription_id, class_date)',
    CASE WHEN EXISTS (
      SELECT 1 FROM pg_indexes
      WHERE tablename = 'activity_attendance'
        AND indexname = 'uq_activity_attendance_subscription_date'
    ) THEN 'OK' ELSE 'FALTA' END,
    '1.23.0',
    'índice ' || 'uq_activity_attendance_subscription_date'

  -- ── 1.24.0 — agenda de clases ──
  UNION ALL
  SELECT
    'activity_schedules.capacity existe',
    CASE WHEN EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'activity_schedules' AND column_name = 'capacity'
    ) THEN 'OK' ELSE 'FALTA' END,
    '1.24.0',
    'columna activity_schedules.capacity'

  UNION ALL
  SELECT
    'tabla training_sessions existe',
    CASE WHEN EXISTS (
      SELECT 1 FROM information_schema.tables WHERE table_name = 'training_sessions'
    ) THEN 'OK' ELSE 'FALTA' END,
    '1.24.0',
    'tabla training_sessions'

  UNION ALL
  SELECT
    'appointments.training_session_id existe',
    CASE WHEN EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'appointments' AND column_name = 'training_session_id'
    ) THEN 'OK' ELSE 'FALTA' END,
    '1.24.0',
    'columna appointments.training_session_id'

  -- ── 1.25.0 — historial de saldo a favor ──
  UNION ALL
  SELECT
    'tabla customer_credit_movements existe',
    CASE WHEN EXISTS (
      SELECT 1 FROM information_schema.tables WHERE table_name = 'customer_credit_movements'
    ) THEN 'OK' ELSE 'FALTA' END,
    '1.25.0',
    'tabla customer_credit_movements'

  -- Sin la tabla, cancelar un turno con seña paga revienta: `creditCustomer`
  -- inserta el movimiento SIEMPRE. Este chequeo es el que avisa antes.
  UNION ALL
  SELECT
    'FKs de credit_movements con su ON DELETE',
    CASE WHEN (
      SELECT count(*) FROM pg_constraint
      WHERE conname IN ('fk_credit_mov_customer','fk_credit_mov_appointment','fk_credit_mov_payment')
        AND confdeltype IN ('r','n')
    ) = 3 THEN 'OK' ELSE 'FALTA' END,
    '1.25.0',
    -- r=RESTRICT, n=SET NULL, a=NO ACTION (el default, que NO queremos)
    COALESCE((SELECT string_agg(conname || '=' || confdeltype::text, ', ' ORDER BY conname)
                FROM pg_constraint WHERE conname LIKE 'fk_credit_mov%'), 'ninguna')

  -- ── 1.26.0 — reestructura de categorías ──
  UNION ALL
  SELECT
    'service_category tiene UNIQUE',
    CASE WHEN EXISTS (SELECT 1 FROM pg_constraint WHERE conname='uq_service_category')
         THEN 'OK' ELSE 'FALTA' END,
    '1.26.0',
    'uq_service_category (service_id, category_id)'

  UNION ALL
  SELECT
    'backup de service_category existe',
    CASE WHEN EXISTS (SELECT 1 FROM information_schema.tables
                       WHERE table_name='service_category_backup_1260')
         THEN 'OK' ELSE 'FALTA' END,
    '1.26.0',
    'service_category_backup_1260'

  -- Un servicio activo sin ninguna categoría ACTIVA no se ve en la web. La
  -- 1.26.0/05 archivó los buckets `(Eje)` y le asignó categoría a `Cavado
  -- Completo`, así que desde esa migración el número tiene que ser 0 en
  -- punto — ya no se tolera 1 como en el chequeo original de la Task 1.
  --
  -- Ojo con el `AND c.is_active` del JOIN: antes de la 1.26.0/05 los `(Eje)`
  -- estaban `is_active=true` (la web los escondía filtrando el nombre, no el
  -- flag), así que un servicio colgado SOLO de un `(Eje)` pasaba este chequeo
  -- sin el JOIN aunque fuera invisible en pantalla. Con los Eje ya archivados,
  -- `c.is_active` los excluye solo y el chequeo queda correcto sin trampa.
  UNION ALL
  SELECT
    'todo servicio activo tiene categoría activa',
    CASE WHEN (SELECT count(*) FROM service s WHERE s.is_active
                AND NOT EXISTS (SELECT 1 FROM service_category sc
                                 JOIN categories c ON c.id=sc.category_id AND c.is_active
                                WHERE sc.service_id=s.id)) = 0
         THEN 'OK' ELSE 'REVISAR' END,
    '1.26.0',
    (SELECT count(*)::text || ' servicio(s) huérfano(s)' FROM service s WHERE s.is_active
      AND NOT EXISTS (SELECT 1 FROM service_category sc
                       JOIN categories c ON c.id=sc.category_id AND c.is_active
                      WHERE sc.service_id=s.id))
) t
ORDER BY CASE WHEN estado = 'FALTA' THEN 0 ELSE 1 END, chequeo;

-- ════════════════════════════════════════════════════════════════════════════
-- Cuadre del saldo a favor (1.25.0) — sale por "Messages", no por resultados
-- ════════════════════════════════════════════════════════════════════════════
-- La suma de los movimientos de un cliente tiene que dar su `credit_balance`;
-- los dos se escriben en la misma transacción. Si alguna vez no coincide, hay
-- un saldo que el historial no puede explicar.
--
-- Va en un DO con SQL dinámico a propósito: una consulta normal que nombre
-- `customer_credit_movements` falla al PARSEAR si la tabla todavía no existe, y
-- se llevaría puesto todo el bloque de arriba — justo cuando más se necesita.
DO $$
DECLARE descuadrados int;
BEGIN
  IF to_regclass('customer_credit_movements') IS NULL THEN
    RAISE NOTICE '1.25.0 sin aplicar — no se puede chequear el cuadre de saldos.';
    RETURN;
  END IF;

  EXECUTE $q$
    SELECT count(*) FROM customers c
     WHERE COALESCE(c.credit_balance, 0) <> COALESCE(
       (SELECT sum(m.amount) FROM customer_credit_movements m WHERE m.customer_id = c.id), 0)
  $q$ INTO descuadrados;

  IF descuadrados = 0 THEN
    RAISE NOTICE 'OK — el saldo a favor de todos los clientes cuadra con sus movimientos.';
  ELSE
    RAISE WARNING 'DESCUADRE — % cliente(s) con credit_balance distinto de la suma de sus movimientos.', descuadrados;
  END IF;
END $$;
