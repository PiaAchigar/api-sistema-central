-- ════════════════════════════════════════════════════════════════════════════
-- 1.24.0 — Agenda de clases: cupo en ACTIVITY_SCHEDULES + sesiones de CAPACITACIÓN
-- ════════════════════════════════════════════════════════════════════════════
-- Hasta acá una clase grupal no existía como entidad: se deducía agrupando
-- APPOINTMENTS. Consecuencias: una clase sin inscriptas era invisible en la
-- Agenda (la profesora la dicta igual), y N inscriptas se dibujaban como N
-- cards apiladas en el mismo horario.
--
-- A partir de acá cada capa tiene un solo trabajo:
--   ACTIVITY_SCHEDULES / TRAINING_SESSIONS → CUÁNDO existe la clase
--   APPOINTMENTS                           → QUIÉN se anotó (sin cambios de forma)
--   ACTIVITY_ATTENDANCE                    → QUIÉN vino
--
-- Cambios:
--   1. activity_schedules.capacity — cupo por horario
--   2. training_sessions — las capacitaciones no tenían NINGUNA fecha
--   3. appointments.training_session_id — inscripción a una sesión de capacitación

-- ────────────────────────────────────────────────────────────────────────────
-- Step 1: Cupo por horario de actividad
-- ────────────────────────────────────────────────────────────────────────────
-- Va en el SCHEDULE y no en ACTIVITIES porque el cupo depende del horario: la
-- clase de las 10 puede entrar 6 y la de las 18 entrar 10 (y para las
-- actividades por máquina el límite lo da machine_id, que ya vive acá).
-- NULL = sin límite declarado.
ALTER TABLE activity_schedules
  ADD COLUMN IF NOT EXISTS capacity INTEGER;

ALTER TABLE activity_schedules
  ADD CONSTRAINT chk_activity_schedules_capacity_positive
  CHECK (capacity IS NULL OR capacity > 0);

-- ────────────────────────────────────────────────────────────────────────────
-- Step 2: TRAINING_SESSIONS — fechas concretas de una capacitación
-- ────────────────────────────────────────────────────────────────────────────
-- TRAINING (capacitaciones) tenía total_sessions y duration_per_session_minutes
-- pero NINGUNA fecha: no había forma de saber cuándo se dicta.
--
-- No se reusa ACTIVITY_SCHEDULES a propósito: ese modelo es un patrón semanal
-- recurrente (day_of_week + valid_from/valid_until), que sirve para "Pilates
-- todos los martes". Una capacitación es lo contrario — un evento fechado
-- ("el 15 de septiembre de 10 a 13"), habitualmente en una serie corta de
-- encuentros. Forzar un patrón recurrente ahí obligaría a inventar reglas para
-- representar fechas sueltas.
CREATE TABLE IF NOT EXISTS training_sessions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  training_id         UUID NOT NULL REFERENCES training(id) ON DELETE CASCADE,
  -- Quién la dicta. Nullable: puede definirse después de publicar la fecha.
  service_provider_id UUID REFERENCES service_providers(id) ON DELETE SET NULL,
  -- Número de encuentro dentro de la capacitación (1, 2, 3...). Se contrasta
  -- contra training.total_sessions.
  session_number      INTEGER NOT NULL DEFAULT 1,
  session_date        DATE NOT NULL,
  -- Hora LOCAL del negocio (ART, -03:00), igual que activity_schedules y
  -- service_provider_availability. La conversión a UTC pasa por src/lib/time.ts.
  start_time          TIME NOT NULL,
  end_time            TIME NOT NULL,
  location            VARCHAR(255),
  -- Cupo de ESTA fecha. NULL = se cae al training.max_participants del catálogo.
  capacity            INTEGER,
  notes               TEXT,
  is_active           BOOLEAN NOT NULL DEFAULT true,
  created_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT chk_training_sessions_time_order CHECK (end_time > start_time),
  CONSTRAINT chk_training_sessions_capacity_positive
    CHECK (capacity IS NULL OR capacity > 0),
  CONSTRAINT chk_training_sessions_number_positive CHECK (session_number > 0)
);

-- Una capacitación no puede tener dos veces el mismo encuentro.
CREATE UNIQUE INDEX IF NOT EXISTS uq_training_sessions_training_number
  ON training_sessions(training_id, session_number);

-- La Agenda pide "todas las sesiones de tal día": este es el índice que usa.
CREATE INDEX IF NOT EXISTS idx_training_sessions_date
  ON training_sessions(session_date);

CREATE INDEX IF NOT EXISTS idx_training_sessions_training_id
  ON training_sessions(training_id);

CREATE INDEX IF NOT EXISTS idx_training_sessions_provider
  ON training_sessions(service_provider_id);

-- ────────────────────────────────────────────────────────────────────────────
-- Step 3: Inscripción a una sesión de capacitación
-- ────────────────────────────────────────────────────────────────────────────
-- APPOINTMENTS ya es "quién está anotado a qué y cuándo", y ya convive con
-- service_id / activity_id / machine_id. Agregar training_session_id sigue ese
-- mismo patrón en vez de crear una tabla de inscripciones paralela que
-- duplicaría la lógica de cupo, cancelación y cobro.
ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS training_session_id UUID
  REFERENCES training_sessions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_appointments_training_session_id
  ON appointments(training_session_id);

-- Un cliente no se anota dos veces al mismo encuentro. Parcial: solo aplica a
-- los turnos que ocupan lugar (un turno cancelado no debe bloquear reinscribirse).
CREATE UNIQUE INDEX IF NOT EXISTS uq_appointments_training_session_customer
  ON appointments(training_session_id, customer_id)
  WHERE training_session_id IS NOT NULL
    AND status NOT IN ('cancelled', 'no_show');
