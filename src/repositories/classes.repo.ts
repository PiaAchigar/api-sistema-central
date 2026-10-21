import { sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { getDeudasDeCompras } from "./compras.repo";
import { debeDeCicloSql } from "./cuotas.repo";

/** Una clienta anotada a una clase (turno no cancelado). */
export type AnotadaRow = {
  appointment_id: string;
  customer_id: string | null;
  nombre: string | null;
  /** Clase de prueba: no cuenta como cuota */
  prueba: boolean;
  /** Plata que debe: cuota del mes (actividad) o saldo de su compra (capacitación) */
  debe: number;
  /** Suscripción activa cuyo ciclo da el Debe. null en prueba y en capacitación. */
  subscription_id: string | null;
  /** Compra viva de la capacitación. null en actividades. */
  compra_id: string | null;
};

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
  /** activity_schedules.id — sólo para actividades */
  schedule_id: string | null;
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
  /** Fecha de la clase YYYY-MM-DD (hora local del negocio) */
  the_date: string;
  /** Hora local ART "HH:MM:SS" */
  start_time: string;
  end_time: string;
  /** Instante UTC de inicio, ya resuelto — es la clave que usa la asistencia */
  starts_at_utc: string;
  capacity: number | null;
  enrolled_count: number;
  attended_count: number;
  /** Ordenadas por nombre */
  anotadas: AnotadaRow[];
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
  return listClassesForRange(db, dateStr, dateStr);
}

/** Fila cruda de la consulta: las anotadas llegan como JSON y sin la deuda de capacitaciones. */
type FilaCruda = Omit<ClassOccurrenceRow, "anotadas"> & {
  anotadas: string | AnotadaRow[];
};

/**
 * Lo mismo para un rango inclusive de fechas (YYYY-MM-DD), con las anotadas de
 * cada clase. Orden: fecha, hora, nombre.
 *
 * Son DOS consultas sin importar cuántos días ni cuántas clases haya: la de
 * las clases (con sus anotadas agrupadas en JSON y el Debe de las actividades
 * resuelto en SQL) y una para las deudas de las compras de capacitaciones.
 */
export async function listClassesForRange(
  db: Db,
  from: string,
  to: string,
): Promise<ClassOccurrenceRow[]> {
  const rows = await db.execute<FilaCruda>(sql`
    WITH target AS (
      SELECT
        d::date AS the_date,
        EXTRACT(DOW FROM d)::int AS dow
      FROM generate_series(${from}::date, ${to}::date, interval '1 day') d
    ),

    -- ── Actividades: ocurrencias del patrón semanal en esta fecha ──
    activity_classes AS (
      SELECT
        'activity-' || sch.id::text || '-' || t.the_date::text AS occurrence_id,
        'activity'::text        AS kind,
        a.id                    AS subject_id,
        NULL::uuid              AS session_id,
        sch.id                  AS schedule_id,
        a.name                  AS name,
        a.activity_type         AS activity_type,
        NULL::int               AS session_number,
        NULL::int               AS total_sessions,
        sch.service_provider_id AS provider_id,
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
      LEFT JOIN service_providers sp ON sp.id = sch.service_provider_id
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
        NULL::uuid              AS schedule_id,
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
        AND tsx.session_date BETWEEN ${from}::date AND ${to}::date
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
      r.schedule_id,
      r.name,
      r.activity_type,
      r.session_number,
      r.total_sessions,
      r.provider_id,
      r.provider_name,
      r.machine_id,
      r.machine_name,
      r.location,
      r.the_date::text AS the_date,
      r.start_time,
      r.end_time,
      r.starts_at_utc,
      r.capacity,
      -- Inscriptas: todo turno que no esté cancelado (scheduled, reserved,
      -- completed, no_show). Es la misma regla del cupo y de la lista de anotadas:
      -- actividad + inicio + máquina + proveedora (dos máquinas a la misma hora son dos clases).
      COALESCE(enr.enrolled_count, 0)::int AS enrolled_count,
      COALESCE(att.attended_count, 0)::int AS attended_count,
      anot.anotadas
    FROM resolved r
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS enrolled_count
      FROM appointments ap
      WHERE ap.status <> 'cancelled'
        AND (
          (r.kind = 'activity' AND ap.activity_id = r.subject_id
             AND ap.appointment_start = r.starts_at_utc
             AND ap.machine_id IS NOT DISTINCT FROM r.machine_id
             AND ap.service_provider_id IS NOT DISTINCT FROM r.provider_id)
          OR
          (r.kind = 'training' AND ap.training_session_id = r.session_id)
        )
    ) enr ON true
    -- Asistencias ya registradas. Sólo aplica a actividades: la asistencia de
    -- capacitaciones todavía no tiene dónde guardarse (ver planning/agenda_asistencia.md).
    LEFT JOIN LATERAL (
      -- activity_attendance sólo guarda (suscripción, fecha): no distingue hora ni máquina.
      -- La clase se identifica como en el roster: la suscripción lleva a la clienta y ésta tiene
      -- un turno no cancelado en ESTA clase (misma actividad, inicio y máquina, como enr).
      SELECT COUNT(*)::int AS attended_count
      FROM activity_attendance aa
      JOIN training_subscriptions tsa ON tsa.id = aa.subscription_id
      WHERE r.kind = 'activity'
        AND aa.activity_id = r.subject_id
        AND aa.class_date = r.the_date
        AND aa.attended = true
        AND EXISTS (
          SELECT 1 FROM appointments apa
          WHERE apa.customer_id = tsa.customer_id
            AND apa.status <> 'cancelled'
            AND apa.activity_id = r.subject_id
            AND apa.appointment_start = r.starts_at_utc
            AND apa.machine_id IS NOT DISTINCT FROM r.machine_id
            AND apa.service_provider_id IS NOT DISTINCT FROM r.provider_id
        )
    ) att ON true
    -- Anotadas: los turnos no cancelados de la clase, con su Debe.
    LEFT JOIN LATERAL (
      SELECT COALESCE(json_agg(json_build_object(
        'appointment_id', ap.id,
        'customer_id', ap.customer_id,
        'nombre', ct.name,
        'prueba', ap.is_trial,
        -- Actividad: Debe del ciclo del MES DE LA CLASE de su suscripción activa
        -- (0 si no hay ciclo o si es clase de prueba). Capacitación: se completa
        -- aparte con getDeudasDeCompras a partir de compra_id.
        'debe', CASE WHEN r.kind = 'activity' AND NOT ap.is_trial
                     THEN COALESCE(${debeDeCicloSql("cy", "ts")}, 0) ELSE 0 END,
        'subscription_id', CASE WHEN r.kind = 'activity' AND NOT ap.is_trial THEN ts.id ELSE NULL END,
        'compra_id', pur.id
      ) ORDER BY ct.name, ap.id), '[]'::json) AS anotadas
      FROM appointments ap
      LEFT JOIN customers cu ON cu.id = ap.customer_id
      LEFT JOIN contacts ct ON ct.id = cu.contact_id
      LEFT JOIN LATERAL (
        SELECT s.id, s.monthly_amount
        FROM training_subscriptions s
        WHERE r.kind = 'activity'
          AND s.customer_id = ap.customer_id
          AND s.activity_id = ap.activity_id
          AND s.status = 'active'
        ORDER BY s.subscription_start_date DESC NULLS LAST, s.id DESC
        LIMIT 1
      ) ts ON true
      LEFT JOIN subscription_billing_cycles cy
        ON cy.training_subscription_id = ts.id
       AND cy.billing_month = to_char(r.the_date, 'YYYY-MM')
      LEFT JOIN LATERAL (
        SELECT cp.id
        FROM customer_purchase cp
        WHERE r.kind = 'training'
          AND cp.customer_id = ap.customer_id
          AND cp.training_id = r.subject_id
          AND cp.cancelled_at IS NULL
        ORDER BY cp.purchased_at DESC NULLS LAST
        LIMIT 1
      ) pur ON true
      WHERE ap.status <> 'cancelled'
        AND (
          (r.kind = 'activity' AND ap.activity_id = r.subject_id
             AND ap.appointment_start = r.starts_at_utc
             AND ap.machine_id IS NOT DISTINCT FROM r.machine_id
             AND ap.service_provider_id IS NOT DISTINCT FROM r.provider_id)
          OR
          (r.kind = 'training' AND ap.training_session_id = r.session_id)
        )
    ) anot ON true
    ORDER BY r.the_date, r.start_time, r.name
  `);

  // El driver puede entregar el JSON ya parseado o como texto.
  const crudas = (rows as unknown as FilaCruda[]).map((f) => ({
    ...f,
    anotadas: typeof f.anotadas === "string" ? JSON.parse(f.anotadas) : f.anotadas,
  }));

  const compraIds = new Set<string>();
  for (const f of crudas) {
    if (f.kind !== "training") continue;
    for (const a of f.anotadas as { compra_id: string | null }[]) {
      if (a.compra_id) compraIds.add(a.compra_id);
    }
  }
  const deudas = await getDeudasDeCompras(db, [...compraIds]);

  return crudas.map((f) => ({
    ...f,
    anotadas: (f.anotadas as AnotadaRow[]).map((a) => ({
      ...a,
      debe: f.kind === "training" ? (a.compra_id ? (deudas.get(a.compra_id) ?? 0) : 0) : Number(a.debe),
    })),
  })) as ClassOccurrenceRow[];
}
