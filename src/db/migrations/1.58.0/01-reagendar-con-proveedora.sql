-- ════════════════════════════════════════════════════════════════════════════
-- 1.58.0 / 01 — El historial de reagendamientos también guarda la proveedora
-- ════════════════════════════════════════════════════════════════════════════
-- UNA SOLA SENTENCIA (bloque DO): el SQL Editor de Supabase hace autocommit por
-- sentencia, y un error a mitad de camino dejaría la tabla a medio armar.
--
-- QUÉ AGREGA
-- Hasta la 1.57.0, reagendar sólo movía fecha/hora: la proveedora no cambiaba
-- nunca, así que el historial (1.40.0) no guardaba con quién. Ahora "Reagendar"
-- también puede pasar el turno a otra proveedora que ofrezca el mismo servicio,
-- y sin estas dos columnas ese cambio se perdería igual que antes se perdía la
-- fecha: nadie podría responder "¿esto lo hacía Gabi y lo pasaron a Lu?".
--
-- ON DELETE SET NULL (y no NO ACTION): el sistema permite borrar proveedoras
-- de verdad. Una FK restrictiva impediría ese borrado sólo porque alguna vez
-- movieron un turno suyo; con SET NULL el historial sobrevive (queda la fecha y
-- el motivo, sin el nombre de la proveedora borrada).
--
-- Sin NOT NULL: las filas viejas no tienen este dato, y un movimiento que no
-- cambia de proveedora igual guarda las dos columnas (iguales).
--
-- Idempotente: ADD COLUMN IF NOT EXISTS. Correrla dos veces no rompe nada.

DO $$
BEGIN
  ALTER TABLE appointment_reschedule
    ADD COLUMN IF NOT EXISTS previous_provider_id uuid
      REFERENCES service_providers(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS new_provider_id uuid
      REFERENCES service_providers(id) ON DELETE SET NULL;

  RAISE NOTICE 'appointment_reschedule: columnas de proveedora listas';
END $$;

-- ── Verificación (correr aparte, no forma parte de la migración) ────────────
-- SELECT column_name, data_type, is_nullable
--   FROM information_schema.columns
--  WHERE table_name = 'appointment_reschedule'
--    AND column_name IN ('previous_provider_id', 'new_provider_id');
