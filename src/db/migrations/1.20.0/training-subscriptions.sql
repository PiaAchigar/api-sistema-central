-- ════════════════════════════════════════════════════════════════════════════
-- 1.20.0 — Suscripciones mensuales a actividades (Trainings)
-- ════════════════════════════════════════════════════════════════════════════
-- Tabla 1: TRAINING_SUBSCRIPTIONS — suscripción indefinida (1 por cliente/actividad)
-- Tabla 2: SUBSCRIPTION_BILLING_CYCLES — historial de pagos mensuales (1 por mes/cliente/actividad)
--
-- Uso: Pilates, Yoga, y otras actividades que se cobran mensualmente
-- Auditoría: SUBSCRIPTION_BILLING_CYCLES mantiene historial completo de pagos

-- ────────────────────────────────────────────────────────────────────────────
-- Tabla 1: TRAINING_SUBSCRIPTIONS
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS training_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Foreign Keys
  training_id UUID NOT NULL REFERENCES training(id) ON DELETE RESTRICT,
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,

  -- Lifecycle
  subscription_start_date DATE NOT NULL,
  subscription_end_date DATE, -- NULL = indefinida
  status VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'paused', 'cancelled')),

  -- Billing
  monthly_amount DECIMAL(10, 2) NOT NULL,

  -- Meta
  notes TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Índices para búsquedas frecuentes
CREATE INDEX IF NOT EXISTS idx_training_subscriptions_customer_id
  ON training_subscriptions(customer_id);
CREATE INDEX IF NOT EXISTS idx_training_subscriptions_training_id
  ON training_subscriptions(training_id);
CREATE INDEX IF NOT EXISTS idx_training_subscriptions_status
  ON training_subscriptions(status);

-- Constraint: máximo 1 suscripción activa por (customer_id, training_id)
-- (Las pausadas/canceladas no cuentan)
CREATE UNIQUE INDEX IF NOT EXISTS uq_training_subscriptions_customer_training_active
  ON training_subscriptions(customer_id, training_id)
  WHERE status = 'active';

-- ────────────────────────────────────────────────────────────────────────────
-- Tabla 2: SUBSCRIPTION_BILLING_CYCLES
-- ────────────────────────────────────────────────────────────────────────────
-- Historial de pagos: 1 registro por mes/cliente/actividad
-- AUDITORÍA: conserva todos los pagos (pasados, presentes, futuros)

CREATE TABLE IF NOT EXISTS subscription_billing_cycles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Foreign Keys
  subscription_id UUID NOT NULL REFERENCES training_subscriptions(id) ON DELETE CASCADE,

  -- Billing period
  billing_month VARCHAR(7) NOT NULL, -- Formato YYYY-MM (ej: 2026-08)
  billing_period_start DATE NOT NULL, -- 1er día del mes (ej: 2026-08-01)
  billing_period_end DATE NOT NULL,   -- Último día para pagar sin recargo (ej: 2026-08-10)

  -- Payment status
  is_paid BOOLEAN NOT NULL DEFAULT false,
  payment_date TIMESTAMP, -- Cuándo pagó (NULL si no pagó)
  payment_method VARCHAR(50), -- transferencia, efectivo, tarjeta, etc.
  amount_paid DECIMAL(10, 2), -- Monto pagado (puede incluir recargo si es late)

  -- Overdue & reminders
  is_overdue BOOLEAN NOT NULL DEFAULT false, -- true = pasó del 10 sin pagar
  payment_reminder_sent_at TIMESTAMP, -- Cuándo se envió recordatorio WhatsApp

  -- Facturación (ARCA)
  invoice_line_item_id UUID REFERENCES line_items(id) ON DELETE SET NULL,

  -- Meta
  notes TEXT, -- Notas (ej: "Pagó con recargo", "Aplazado")
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Índices para auditoría y consultas frecuentes
CREATE UNIQUE INDEX IF NOT EXISTS uq_billing_cycles_subscription_month
  ON subscription_billing_cycles(subscription_id, billing_month);
CREATE INDEX IF NOT EXISTS idx_billing_cycles_billing_month
  ON subscription_billing_cycles(billing_month);
CREATE INDEX IF NOT EXISTS idx_billing_cycles_is_paid
  ON subscription_billing_cycles(is_paid);
CREATE INDEX IF NOT EXISTS idx_billing_cycles_is_overdue
  ON subscription_billing_cycles(is_overdue);
CREATE INDEX IF NOT EXISTS idx_billing_cycles_payment_date
  ON subscription_billing_cycles(payment_date);

-- Búsquedas de auditoría: cliente + actividad + historial
CREATE INDEX IF NOT EXISTS idx_billing_cycles_subscription_payment_date
  ON subscription_billing_cycles(subscription_id, payment_date DESC);

-- ════════════════════════════════════════════════════════════════════════════
-- Ejemplo de uso (una vez corrida la migración):
-- ════════════════════════════════════════════════════════════════════════════
/*

1. Cliente se suscribe a Pilates:
   INSERT INTO training_subscriptions (
     training_id, customer_id, subscription_start_date, monthly_amount
   ) VALUES (
     'pilates-uuid', 'maria-uuid', '2026-08-01', 2500.00
   );

   Se crea el ciclo para agosto automáticamente (por job de n8n/cron):
   INSERT INTO subscription_billing_cycles (
     subscription_id, billing_month, billing_period_start, billing_period_end
   ) VALUES (
     'sub-maria-pilates', '2026-08', '2026-08-01', '2026-08-10'
   );

2. María paga antes del 10:
   UPDATE subscription_billing_cycles SET
     is_paid = true,
     payment_date = NOW(),
     payment_method = 'transferencia',
     amount_paid = 2500.00
   WHERE subscription_id = 'sub-maria-pilates' AND billing_month = '2026-08';

3. María no paga (después del 10):
   UPDATE subscription_billing_cycles SET
     is_overdue = true,
     payment_reminder_sent_at = NOW()
   WHERE subscription_id = 'sub-maria-pilates' AND billing_month = '2026-08';

   Si paga después (con recargo):
   UPDATE subscription_billing_cycles SET
     is_paid = true,
     payment_date = NOW(),
     amount_paid = 2750.00,  -- Incluye 10% recargo
     notes = 'Pagó con recargo (10% por atraso)'
   WHERE subscription_id = 'sub-maria-pilates' AND billing_month = '2026-08';

4. Auditoría: historial de pagos de María en Pilates (últimos 12 meses):
   SELECT
     sbc.billing_month,
     sbc.billing_period_start,
     sbc.billing_period_end,
     sbc.is_paid,
     sbc.payment_date,
     sbc.amount_paid,
     sbc.is_overdue,
     sbc.notes
   FROM subscription_billing_cycles sbc
   JOIN training_subscriptions ts ON sbc.subscription_id = ts.id
   WHERE ts.customer_id = 'maria-uuid'
     AND ts.training_id = 'pilates-uuid'
   ORDER BY sbc.billing_month DESC;

*/
