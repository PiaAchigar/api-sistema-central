const DIAS = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];

/** "Lun 10:00", de lunes a domingo y por hora. Lo comparten las opciones para anotar y el listado de suscripciones. */
export function formatearHorarios(
  horarios: Array<{
    dayOfWeek: number | null;
    startTime: string | null;
    /** Nombre de la proveedora del horario */
    proveedora?: string | null;
    /** La actividad tiene otro horario activo el mismo día y hora: hay que nombrar a la proveedora */
    ambiguo?: boolean;
  }>,
): string[] {
  return horarios
    .map((h) => ({
      dia: h.dayOfWeek ?? 0,
      hora: (h.startTime ?? "00:00:00").slice(0, 5),
      sufijo: h.ambiguo && h.proveedora ? ` · ${h.proveedora}` : "",
    }))
    .sort((a, b) => ((a.dia + 6) % 7) - ((b.dia + 6) % 7) || a.hora.localeCompare(b.hora) || a.sufijo.localeCompare(b.sufijo))
    .map((h) => `${DIAS[h.dia]} ${h.hora}${h.sufijo}`);
}

/** SQL: el horario `alias` comparte actividad, día y hora con otro horario activo (dos proveedoras a la misma hora). */
export const horarioAmbiguoSql = (alias: string) => `EXISTS (
  SELECT 1 FROM activity_schedules o
   WHERE o.activity_id = ${alias}.activity_id AND o.id <> ${alias}.id AND o.is_active
     AND o.day_of_week = ${alias}.day_of_week AND o.start_time = ${alias}.start_time)`;
