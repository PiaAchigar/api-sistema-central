-- ============================================================
-- Migración 1.3.0 — Soporte de reservas temporales
-- ============================================================
-- Aplicar en: base local Docker + Supabase
-- Requisitos: appointments ya existe (migración 1.0.0)
-- ============================================================

-- 1. Columna para la fecha de expiración de la reserva.
--    NULL en turnos scheduled/completed/cancelled (solo relevante en 'reserved').
ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS reservation_expires_at TIMESTAMP;

-- 2. Índice parcial: solo indexa las filas en estado 'reserved',
--    que son las únicas que se consultan por expiración.
CREATE INDEX IF NOT EXISTS idx_appointments_reserved_expiry
  ON appointments(reservation_expires_at)
  WHERE status = 'reserved';

-- ============================================================
-- pg_cron — Auto-cancelación de reservas expiradas
-- ============================================================
-- IMPORTANTE: postgres:16-alpine (Docker local) NO incluye
-- pg_cron. Ejecutar SOLO en Supabase donde está disponible.
--
-- En Supabase: ir a Database → Extensions → habilitar pg_cron,
-- luego ejecutar el bloque de abajo en el SQL Editor.
--
-- En local: el Worker hace el rol del cron (ver endpoint
-- /api/agenda/appointments/expire-reservations o polling
-- desde el frontend con React Query refetchInterval).
-- ============================================================

/*  ── SOLO SUPABASE ────────────────────────────────────────

SELECT cron.schedule(
  'expire-reservations',
  '* /5 * * * *',
  $$
    UPDATE appointments
    SET
      status    = 'cancelled',
      notes     = COALESCE(notes || ' | ', '') ||
                  'Reserva expirada automáticamente (' || now()::text || ')',
      updated_at = now()
    WHERE status = 'reserved'
      AND reservation_expires_at < now();
  $$
);

──────────────────────────────────────────────────────────── */

-- ============================================================
-- Verificación rápida post-migración
-- ============================================================
-- SELECT column_name, data_type
-- FROM information_schema.columns
-- WHERE table_name = 'appointments'
--   AND column_name = 'reservation_expires_at';
--
-- SELECT indexname FROM pg_indexes
-- WHERE tablename = 'appointments'
--   AND indexname = 'idx_appointments_reserved_expiry';
-- ============================================================
