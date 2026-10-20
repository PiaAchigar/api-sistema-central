-- ════════════════════════════════════════════════════════════════════════════
-- 1.59.0 / 01 — Agenda grupal: cuota del mes, horarios elegidos, pago de cuota,
--               clase de prueba y sin doble anotación
-- ════════════════════════════════════════════════════════════════════════════
-- Un único bloque DO: el SQL Editor de Supabase hace autocommit por sentencia,
-- así que o corre entera o no corre. Idempotente (se puede volver a aplicar).
--
--   · subscription_billing_cycles.amount_due: lo que se le debe cobrar ese mes
--     (monthly_amount × cantidad de horarios elegidos). Los ciclos anteriores
--     quedan con amount_due = amount_paid (o el monthly_amount si nunca se pagó).
--   · subscription_month_schedules: qué horarios semanales eligió la alumna ese mes.
--   · payments.subscription_billing_cycle_id: un pago puede ser de una cuota,
--     pero nunca de una cuota Y de una compra a la vez.
--   · appointments.is_trial: clase de prueba (no cuenta como cuota).
--   · Índices únicos parciales: no se anota dos veces a la misma clase/encuentro.
-- ════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  v_completados integer;
  v_dup_clase   integer;
  v_dup_encuentro integer;
BEGIN
  -- 1. Columnas y tabla nueva ------------------------------------------------
  ALTER TABLE subscription_billing_cycles
    ADD COLUMN IF NOT EXISTS amount_due numeric(10,2);

  ALTER TABLE payments
    ADD COLUMN IF NOT EXISTS subscription_billing_cycle_id uuid
      REFERENCES subscription_billing_cycles(id);

  ALTER TABLE appointments
    ADD COLUMN IF NOT EXISTS is_trial boolean NOT NULL DEFAULT false;

  CREATE TABLE IF NOT EXISTS subscription_month_schedules (
    billing_cycle_id     uuid NOT NULL REFERENCES subscription_billing_cycles(id) ON DELETE CASCADE,
    activity_schedule_id uuid NOT NULL REFERENCES activity_schedules(id),
    created_at           timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (billing_cycle_id, activity_schedule_id)
  );

  CREATE INDEX IF NOT EXISTS ix_payments_billing_cycle
    ON payments (subscription_billing_cycle_id);

  -- 2. Backfill: los ciclos viejos quedan "sin deuda" (debido = lo pagado) ----
  UPDATE subscription_billing_cycles c
     SET amount_due = COALESCE(c.amount_paid, ts.monthly_amount)
    FROM training_subscriptions ts
   WHERE ts.id = c.training_subscription_id
     AND c.amount_due IS NULL;
  GET DIAGNOSTICS v_completados = ROW_COUNT;

  -- 3. Guarda: no crear los índices únicos si ya hay duplicados vivos ---------
  SELECT count(*) INTO v_dup_clase FROM (
    SELECT 1 FROM appointments
     WHERE activity_id IS NOT NULL AND status <> 'cancelled'
     GROUP BY customer_id, activity_id, appointment_start
    HAVING count(*) > 1) d;
  IF v_dup_clase > 0 THEN
    RAISE EXCEPTION '1.59.0: % clases duplicadas (mismo cliente/actividad/inicio). Verlas con: SELECT customer_id, activity_id, appointment_start, count(*) FROM appointments WHERE activity_id IS NOT NULL AND status <> ''cancelled'' GROUP BY 1,2,3 HAVING count(*) > 1;', v_dup_clase;
  END IF;

  SELECT count(*) INTO v_dup_encuentro FROM (
    SELECT 1 FROM appointments
     WHERE training_session_id IS NOT NULL AND status <> 'cancelled'
     GROUP BY customer_id, training_session_id
    HAVING count(*) > 1) d;
  IF v_dup_encuentro > 0 THEN
    RAISE EXCEPTION '1.59.0: % inscripciones duplicadas a un encuentro (mismo cliente/encuentro). Verlas con: SELECT customer_id, training_session_id, count(*) FROM appointments WHERE training_session_id IS NOT NULL AND status <> ''cancelled'' GROUP BY 1,2 HAVING count(*) > 1;', v_dup_encuentro;
  END IF;

  -- 4. Índices únicos y CHECK --------------------------------------------------
  CREATE UNIQUE INDEX IF NOT EXISTS ux_appt_clase_actividad
    ON appointments (customer_id, activity_id, appointment_start)
    WHERE activity_id IS NOT NULL AND status <> 'cancelled';

  CREATE UNIQUE INDEX IF NOT EXISTS ux_appt_encuentro
    ON appointments (customer_id, training_session_id)
    WHERE training_session_id IS NOT NULL AND status <> 'cancelled';

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_payments_compra_o_cuota') THEN
    ALTER TABLE payments
      ADD CONSTRAINT ck_payments_compra_o_cuota
      CHECK (customer_purchase_id IS NULL OR subscription_billing_cycle_id IS NULL);
  END IF;

  -- 5. Resumen -----------------------------------------------------------------
  RAISE NOTICE '1.59.0: % ciclos completados con amount_due', v_completados;
END $$;

-- Verificación (correr aparte):
-- SELECT count(*) FROM subscription_billing_cycles WHERE amount_due IS NULL;
-- SELECT indexname FROM pg_indexes WHERE indexname IN ('ux_appt_clase_actividad','ux_appt_encuentro');
