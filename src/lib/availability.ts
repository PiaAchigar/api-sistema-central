/** Reconciliación del horario semanal recurrente (`service_provider_availability`).
 *
 *  Regla §1.4 (vigencias): cambiar un horario NO es un UPDATE del registro vigente.
 *  Se cierra el viejo (is_active=false + valid_until) y se crea uno nuevo, para que
 *  el pasado quede auditable. Esta función decide qué hacer comparando el estado
 *  actual con el deseado; es pura para poder testearla.
 *
 *  Cada fila se identifica por la tupla (dayOfWeek, workStartTime, workEndTime) —
 *  no por id — porque un mismo día puede tener varias franjas (turno partido) y
 *  lo que importa es si ESA franja exacta sigue existiendo, no un id estable. */

export type WeeklyAvailabilityInput = {
  dayOfWeek: number;
  workStartTime: string;
  workEndTime: string;
};

export type CurrentWeeklyRow = WeeklyAvailabilityInput & { id: string };

export type WeeklyAvailabilityDiff = {
  /** Franjas a dar de alta (nuevas o con horario cambiado). */
  toCreate: WeeklyAvailabilityInput[];
  /** Ids de filas vigentes a cerrar (quitadas o cambiadas). */
  toCloseIds: string[];
};

function slotKey(row: WeeklyAvailabilityInput): string {
  return `${row.dayOfWeek}|${row.workStartTime}|${row.workEndTime}`;
}

export function diffWeeklyAvailability(
  current: CurrentWeeklyRow[],
  desired: WeeklyAvailabilityInput[],
): WeeklyAvailabilityDiff {
  const currentKeys = new Set(current.map(slotKey));
  const desiredKeys = new Set(desired.map(slotKey));

  const toCreate = desired.filter((d) => !currentKeys.has(slotKey(d)));
  const toCloseIds = current.filter((c) => !desiredKeys.has(slotKey(c))).map((c) => c.id);

  return { toCreate, toCloseIds };
}
