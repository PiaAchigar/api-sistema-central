import { Hono } from "hono";
import { z } from "zod";
import { createDb } from "../../db/client";
import { listClassesForDate, type ClassOccurrenceRow } from "../../repositories/classes.repo";
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
  /** Instante UTC de inicio (ISO). Clave para abrir las asistencias. */
  startsAt: string;
  /** null = sin cupo declarado */
  capacity: number | null;
  enrolledCount: number;
  attendedCount: number;
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
  };
}

/**
 * GET /api/agenda/classes?date=YYYY-MM-DD
 *
 * Clases que se dictan ese día: actividades (derivadas del patrón semanal de
 * activity_schedules) y capacitaciones (training_sessions), en una sola lista.
 *
 * Devuelve UNA fila por clase, no una por inscripta — es lo que permite que la
 * Agenda dibuje una card por clase con "5/8 inscriptas", y que una clase sin
 * nadie anotado igual aparezca.
 */
classesRouter.get(
  "/",
  requireAuth,
  zv("query", z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD") })),
  async (c) => {
    const db = createDb(c.env);
    const { date } = c.req.valid("query");
    const rows = await listClassesForDate(db, date);
    return c.json({ success: true, data: rows.map(toClassOccurrence) });
  },
);

export { classesRouter };
