import { sql } from "drizzle-orm";
import type { Db } from "../db/client";

/**
 * Una clase que se dicta en una fecha concreta, tal como sale de Postgres.
 *
 * "Clase" acá es el EVENTO (la clase de Pilates del martes 10:00), no la
 * inscripción de una clienta. Existe aunque no se haya anotado nadie — que es
 * justamente lo que no se podía representar cuando la Agenda dibujaba una card
 * por appointment.
 */
export type ClassOccurrenceRow = {
  /** Id sintético y estable: identifica la ocurrencia, no una fila de tabla */
  occurrence_id: string;
  kind: "activity" | "training";
  /** activity_id o training_id según kind */
  subject_id: string;
  /** training_sessions.id — sólo para capacitaciones */
  session_id: string | null;
  name: string;
  /** 'class' | 'machine' para actividades; null para capacitaciones */
  activity_type: string | null;
  session_number: number | null;
  total_sessions: number | null;
  provider_id: string | null;
  provider_name: string | null;
  machine_id: string | null;
  machine_name: string | null;
  location: string | null;
  /** Hora local ART "HH:MM:SS" */
  start_time: string;
  end_time: string;
  /** Instante UTC de inicio, ya resuelto — es la clave que usa la asistencia */
  starts_at_utc: string;
  capacity: number | null;
  enrolled_count: number;
  attended_count: number;
};

/**
 * Clases que se dictan en una fecha (hora local del negocio).
 *
 * Actividades: se derivan del patrón semanal de ACTIVITY_SCHEDULES. No se
 * materializan filas por fecha — el día se calcula al vuelo con el day_of_week
 * y la ventana valid_from/valid_until.
 *
 * Capacitaciones: salen de TRAINING_SESSIONS, que ya son fechas concretas.
 *
 * Las dos ramas se unen con el mismo shape para que la Agenda dibuje una sola
 * grilla. `starts_at_utc` se resuelve acá (hora local + offset del negocio)
 * para que el front no tenga que rehacer esa conversión.
 */
export async function listClassesForDate(
  db: Db,
  dateStr: string,
): Promise<ClassOccurrenceRow[]> {
  const rows = await db.execute<ClassOccurrenceRow>(sql`
    WITH target AS (
      SELECT
        ${dateStr}::date AS the_date,
        EXTRACT(DOW FROM ${dateStr}::date)::int AS dow
    ),

    -- ── Actividades: ocurrencias del patrón semanal en esta fecha ──
    activity_classes AS (
      SELECT
        'activity-' || sch.id::text || '-' || t.the_date::text AS occurrence_id,
        'activity'::text        AS kind,
        a.id                    AS subject_id,
        NULL::uuid              AS session_id,
        a.name                  AS name,
        a.activity_type         AS activity_type,
        NULL::int               AS session_number,
        NULL::int               AS total_sessions,
        a.service_provider_id   AS provider_id,
        sp.full_name            AS provider_name,
        sch.machine_id          AS machine_id,
        m.name                  AS machine_name,
        NULL::varchar           AS location,
        sch.start_time          AS start_time,
        sch.end_time            AS end_time,
        sch.capacity            AS capacity,
        t.the_date              AS the_date
      FROM activity_schedules sch
      CROSS JOIN target t
      JOIN activities a ON a.id = sch.activity_id
      LEFT JOIN service_providers sp ON sp.id = a.service_provider_id
      LEFT JOIN machines m ON m.id = sch.machine_id
      WHERE sch.is_active = true
        AND a.is_active = true
        AND sch.day_of_week = t.dow
        AND (sch.valid_from  IS NULL OR sch.valid_from  <= t.the_date)
        AND (sch.valid_until IS NULL OR sch.valid_until >= t.the_date)
    ),

    -- ── Capacitaciones: encuentros fechados ──
    training_classes AS (
      SELECT
        'training-' || tsx.id::text AS occurrence_id,
        'training'::text        AS kind,
        tr.id                   AS subject_id,
        tsx.id                  AS session_id,
        tr.name                 AS name,
        NULL::varchar           AS activity_type,
        tsx.session_number      AS session_number,
        tr.total_sessions       AS total_sessions,
        tsx.service_provider_id AS provider_id,
        sp.full_name            AS provider_name,
        NULL::uuid              AS machine_id,
        NULL::varchar           AS machine_name,
        COALESCE(tsx.location, tr.location) AS location,
        tsx.start_time          AS start_time,
        tsx.end_time            AS end_time,
        -- El cupo de la fecha manda; si no se declaró, el del catálogo
        COALESCE(tsx.capacity, tr.max_participants) AS capacity,
        tsx.session_date        AS the_date
      FROM training_sessions tsx
      JOIN training tr ON tr.id = tsx.training_id
      LEFT JOIN service_providers sp ON sp.id = tsx.service_provider_id
      WHERE tsx.is_active = true
        AND tr.is_active = true
        AND tsx.session_date = ${dateStr}::date
    ),

    all_classes AS (
      SELECT * FROM activity_classes
      UNION ALL
      SELECT * FROM training_classes
    ),

    -- El instante UTC de inicio se resuelve una sola vez acá: es la clave con
    -- la que se cuentan inscriptas y con la que la Agenda abre las asistencias.
    resolved AS (
      SELECT
        c.*,
        ((c.the_date + c.start_time) AT TIME ZONE 'America/Argentina/Buenos_Aires')
          AS starts_at_utc
      FROM all_classes c
    )

    SELECT
      r.occurrence_id,
      r.kind,
      r.subject_id,
      r.session_id,
      r.name,
      r.activity_type,
      r.session_number,
      r.total_sessions,
      r.provider_id,
      r.provider_name,
      r.machine_id,
      r.machine_name,
      r.location,
      r.start_time,
      r.end_time,
      r.starts_at_utc,
      r.capacity,
      -- Inscriptas: los turnos que ocupan lugar. 'reserved' cuenta porque
      -- retiene el cupo hasta que expire; 'cancelled' y 'no_show' no.
      COALESCE(enr.enrolled_count, 0)::int AS enrolled_count,
      COALESCE(att.attended_count, 0)::int AS attended_count
    FROM resolved r
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS enrolled_count
      FROM appointments ap
      WHERE ap.status IN ('scheduled', 'reserved')
        AND (
          (r.kind = 'activity' AND ap.activity_id = r.subject_id
             AND ap.appointment_start = r.starts_at_utc)
          OR
          (r.kind = 'training' AND ap.training_session_id = r.session_id)
        )
    ) enr ON true
    -- Asistencias ya registradas. Sólo aplica a actividades: la asistencia de
    -- capacitaciones todavía no tiene dónde guardarse (ver planning/agenda_asistencia.md).
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS attended_count
      FROM activity_attendance aa
      WHERE r.kind = 'activity'
        AND aa.activity_id = r.subject_id
        AND aa.class_date = r.the_date
        AND aa.attended = true
    ) att ON true
    ORDER BY r.start_time, r.name
  `);

  return rows as unknown as ClassOccurrenceRow[];
}
