import { Hono } from "hono";
import { z } from "zod";
import { createDb } from "../../db/client";
import { listClassesForRange, type ClassOccurrenceRow } from "../../repositories/classes.repo";
import { requireAuth } from "../../middleware/auth";
import { zv } from "../../lib/validator";
import type { AppBindings, Variables } from "../../env";

const classesRouter = new Hono<{ Bindings: AppBindings; Variables: Variables }>();

/** Una clase del día, tal como la consume la Agenda. */
export type ClassOccurrence = {
  occurrenceId: string;
  kind: "activity" | "training";
  subjectId: string;
  sessionId: string | null;
  name: string;
  activityType: "class" | "machine" | null;
  sessionNumber: number | null;
  totalSessions: number | null;
  providerId: string | null;
  providerName: string | null;
  machineId: string | null;
  machineName: string | null;
  location: string | null;
  /** "HH:MM" en hora local del negocio */
  startTime: string;
  endTime: string;
  /** Fecha de la clase YYYY-MM-DD (necesaria cuando se pide un rango) */
  date: string;
  /** Instante UTC de inicio (ISO). Clave para abrir las asistencias. */
  startsAt: string;
  /** null = sin cupo declarado */
  capacity: number | null;
  enrolledCount: number;
  attendedCount: number;
  anotadas: { appointmentId: string; customerId: string | null; nombre: string | null; prueba: boolean; debe: number }[];
};

/** "HH:MM:SS" → "HH:MM" (a la Agenda no le sirven los segundos). */
function toHhMm(value: string): string {
  return value.slice(0, 5);
}

function toClassOccurrence(row: ClassOccurrenceRow): ClassOccurrence {
  return {
    occurrenceId: row.occurrence_id,
    kind: row.kind,
    subjectId: row.subject_id,
    sessionId: row.session_id,
    name: row.name,
    activityType: (row.activity_type as "class" | "machine" | null) ?? null,
    sessionNumber: row.session_number,
    totalSessions: row.total_sessions,
    providerId: row.provider_id,
    providerName: row.provider_name,
    machineId: row.machine_id,
    machineName: row.machine_name,
    location: row.location,
    startTime: toHhMm(row.start_time),
    endTime: toHhMm(row.end_time),
    startsAt: new Date(row.starts_at_utc).toISOString(),
    capacity: row.capacity === null ? null : Number(row.capacity),
    enrolledCount: Number(row.enrolled_count),
    attendedCount: Number(row.attended_count),
    date: row.the_date,
    anotadas: row.anotadas.map((a) => ({
      appointmentId: a.appointment_id,
      customerId: a.customer_id,
      nombre: a.nombre,
      prueba: a.prueba,
      debe: a.debe,
    })),
  };
}

const FECHA = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD")
  // 2027-02-31 pasa el regex pero no existe: Date lo corre a marzo, así que no vuelve igual.
  .refine((f) => {
    const d = new Date(`${f}T00:00:00Z`);
    // Mes 13 o 00: Invalid Date, y toISOString tiraría RangeError (500).
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === f;
  }, "fecha inexistente");
/** Mismo tope que el listado de turnos: seis semanas. */
const MAX_DIAS_RANGO = 42;
const MS_POR_DIA = 24 * 60 * 60 * 1000;

/** Un día (`date`) o un rango inclusive (`from` + `to`), nunca los dos. Mismo patrón que `listQuery` de turnos. */
export const classesQuery = z
  .object({ date: FECHA.optional(), from: FECHA.optional(), to: FECHA.optional() })
  .superRefine((q, ctx) => {
    const error = (message: string) => ctx.addIssue({ code: "custom", message });
    const hayRango = q.from !== undefined || q.to !== undefined;
    if (q.date && hayRango) return error("Pasá `date` o `from`/`to`, no las dos");
    if (!q.date && !hayRango) return error("Falta `date` o `from`/`to`");
    if (!q.date) {
      if (!q.from || !q.to) return error("El rango necesita `from` y `to`");
      if (q.from > q.to) return error("`from` no puede ser posterior a `to`");
      const dias = (Date.parse(q.to) - Date.parse(q.from)) / MS_POR_DIA + 1;
      if (dias > MAX_DIAS_RANGO) return error(`El rango no puede pasar de ${MAX_DIAS_RANGO} días`);
    }
  });

/**
 * GET /api/agenda/classes?date=YYYY-MM-DD  (o ?from=...&to=..., hasta 42 días)
 *
 * Clases que se dictan ese día o rango, con sus anotadas: actividades (derivadas del patrón semanal de
 * activity_schedules) y capacitaciones (training_sessions), en una sola lista.
 *
 * Devuelve UNA fila por clase, no una por inscripta — es lo que permite que la
 * Agenda dibuje una card por clase con "5/8 inscriptas", y que una clase sin
 * nadie anotado igual aparezca.
 */
classesRouter.get(
  "/",
  requireAuth,
  zv("query", classesQuery),
  async (c) => {
    const db = createDb(c.env);
    const { date, from, to } = c.req.valid("query");
    const rows = await listClassesForRange(db, date ?? from!, date ?? to!);
    return c.json({ success: true, data: rows.map(toClassOccurrence) });
  },
);

export { classesRouter };
