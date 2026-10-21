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
--   · activities.service_provider_id queda sin uso en la app (no se borra).
-- ════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  v_cargados integer;
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
END $$;

-- Verificación (correr aparte):
-- SELECT count(*) FILTER (WHERE service_provider_id IS NOT NULL) AS con_proveedora,
--        count(*) FILTER (WHERE service_provider_id IS NULL)     AS sin_proveedora
--   FROM activity_schedules;
