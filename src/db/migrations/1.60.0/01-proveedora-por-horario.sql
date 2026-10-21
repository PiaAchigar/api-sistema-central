-- ════════════════════════════════════════════════════════════════════════════
-- ANTES DE APLICAR — tres consultas de SOLO LECTURA para correr en Supabase.
-- Sirven para saber si el alineo de turnos de abajo toca algo inesperado.
--
-- (A) Turnos no cancelados de actividades cuya proveedora difiere de la de su
--     actividad, por actividad, tipo y futuro/pasado:
--   SELECT a.name, a.activity_type,
--          (ap.appointment_start > now() AT TIME ZONE 'UTC') AS futuro,
--          count(*) AS turnos
--     FROM appointments ap JOIN activities a ON a.id = ap.activity_id
--    WHERE ap.status <> 'cancelled'
--      AND ap.service_provider_id IS DISTINCT FROM a.service_provider_id
--    GROUP BY a.name, a.activity_type, futuro ORDER BY a.name;
--
-- (B) Actividades de clase SIN proveedora que tienen horarios activos
--     (sus horarios quedarían sin proveedora tras el backfill):
--   SELECT a.id, a.name, count(s.id) AS horarios_activos
--     FROM activities a JOIN activity_schedules s ON s.activity_id = a.id AND s.is_active
--    WHERE a.activity_type = 'class' AND a.service_provider_id IS NULL
--    GROUP BY a.id, a.name;
--
-- (C) Horarios activos duplicados (misma actividad, día, hora y máquina):
--   SELECT activity_id, day_of_week, start_time, machine_id, count(*) AS repetidos
--     FROM activity_schedules WHERE is_active
--    GROUP BY activity_id, day_of_week, start_time, machine_id HAVING count(*) > 1;
-- ════════════════════════════════════════════════════════════════════════════
-- ════════════════════════════════════════════════════════════════════════════
-- 1.60.0 / 01 — Agenda grupal: la proveedora va en cada horario de la actividad
-- ════════════════════════════════════════════════════════════════════════════
-- Un único bloque DO: el SQL Editor de Supabase hace autocommit por sentencia,
-- así que o corre entera o no corre. Idempotente (se puede volver a aplicar).
--
--   · activity_schedules.service_provider_id: quién da la clase de ESE horario.
--     Antes la proveedora era una sola por actividad (activities.service_provider_id);
--     ahora una misma actividad puede tener, a la misma hora, una clase por proveedora.
--   · Backfill: cada horario hereda la proveedora de su actividad. Los turnos ya
--     anotados tienen esa misma proveedora, así que siguen contando en su clase.
--   · Alineo: los turnos FUTUROS no cancelados de cada horario pasan a la
--     proveedora del horario (la clase se identifica por actividad + inicio +
--     máquina + proveedora, así que un turno con la proveedora vieja quedaría
--     huérfano de su clase). Los pasados no se tocan, ni los de horarios
--     repetidos (misma hora y máquina, otra proveedora): ahí no se adivina. appointment_start es
--     TIMESTAMP (sin zona) guardado en UTC; día y hora se leen en ART.
--   · activities.service_provider_id queda sin uso en la app (no se borra).
-- ════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  v_cargados integer;
  v_alineados integer;
BEGIN
  ALTER TABLE activity_schedules
    ADD COLUMN IF NOT EXISTS service_provider_id uuid
      REFERENCES service_providers(id) ON DELETE SET NULL;

  CREATE INDEX IF NOT EXISTS ix_activity_schedules_provider
    ON activity_schedules (service_provider_id);

  UPDATE activity_schedules s
     SET service_provider_id = a.service_provider_id
    FROM activities a
   WHERE a.id = s.activity_id
     AND s.service_provider_id IS NULL
     AND a.service_provider_id IS NOT NULL;
  GET DIAGNOSTICS v_cargados = ROW_COUNT;

  RAISE NOTICE '1.60.0: % horarios heredaron la proveedora de su actividad', v_cargados;

  UPDATE appointments ap
     SET service_provider_id = s.service_provider_id, updated_at = now()
    FROM activity_schedules s
   WHERE s.activity_id = ap.activity_id AND s.is_active
     AND s.service_provider_id IS NOT NULL
     AND ap.status <> 'cancelled'
     AND (ap.appointment_start AT TIME ZONE 'UTC') > now()
     AND EXTRACT(DOW FROM (ap.appointment_start AT TIME ZONE 'UTC' AT TIME ZONE 'America/Argentina/Buenos_Aires'))::int = s.day_of_week
     AND (ap.appointment_start AT TIME ZONE 'UTC' AT TIME ZONE 'America/Argentina/Buenos_Aires')::time = s.start_time
     AND (s.valid_from  IS NULL OR s.valid_from  <= (ap.appointment_start AT TIME ZONE 'UTC' AT TIME ZONE 'America/Argentina/Buenos_Aires')::date)
     AND (s.valid_until IS NULL OR s.valid_until >= (ap.appointment_start AT TIME ZONE 'UTC' AT TIME ZONE 'America/Argentina/Buenos_Aires')::date)
     AND ap.machine_id IS NOT DISTINCT FROM s.machine_id
     AND ap.service_provider_id IS DISTINCT FROM s.service_provider_id
     -- Si hay dos horarios iguales (misma hora, distinta proveedora) no se adivina: el turno queda como está.
     AND NOT EXISTS (
       SELECT 1 FROM activity_schedules o
        WHERE o.activity_id = s.activity_id AND o.id <> s.id AND o.is_active
          AND o.day_of_week = s.day_of_week AND o.start_time = s.start_time
          AND o.machine_id IS NOT DISTINCT FROM s.machine_id);
  GET DIAGNOSTICS v_alineados = ROW_COUNT;

  RAISE NOTICE '1.60.0: % turnos futuros pasaron a la proveedora de su horario', v_alineados;
END $$;

-- Verificación (correr aparte):
-- SELECT count(*) FILTER (WHERE service_provider_id IS NOT NULL) AS con_proveedora,
--        count(*) FILTER (WHERE service_provider_id IS NULL)     AS sin_proveedora
--   FROM activity_schedules;
