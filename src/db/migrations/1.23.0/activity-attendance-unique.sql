-- ════════════════════════════════════════════════════════════════════════════
-- 1.23.0 — UNIQUE en ACTIVITY_ATTENDANCE por (suscripción, fecha de clase)
-- ════════════════════════════════════════════════════════════════════════════
-- La asistencia se marca desde la Agenda: el admin abre la card del slot, ve la
-- lista de clientes y tilda quién vino. Ese guardado es naturalmente repetible
-- (se corrige un tilde, se vuelve a guardar, se abre el modal dos veces), así
-- que necesita ser un upsert.
--
-- Sin este índice, cada guardado insertaría una fila nueva y el contador de
-- asistencias del mes contaría de más. Con él, el ON CONFLICT del repositorio
-- actualiza la fila existente.
--
-- Un cliente no puede tener dos clases de la MISMA actividad el MISMO día
-- (la suscripción es una por cliente+actividad), así que la clave natural es
-- (subscription_id, class_date).

-- Limpieza defensiva: si ya hubiera duplicados, deja el más reciente.
DELETE FROM activity_attendance a
USING activity_attendance b
WHERE a.subscription_id = b.subscription_id
  AND a.class_date = b.class_date
  AND a.ctid < b.ctid;

CREATE UNIQUE INDEX IF NOT EXISTS uq_activity_attendance_subscription_date
  ON activity_attendance(subscription_id, class_date);
