/**
 * La fila del historial de reagendamientos.
 *
 * Hasta la 1.40.0 mover un turno pisaba `appointment_start` sin dejar rastro:
 * la fecha anterior se perdía para siempre y no había forma de saber quién ni
 * cuándo lo movió. `appointment_reschedule` guarda ese antes/después, y esto
 * arma la fila.
 *
 * Vive acá, separado del servicio, porque es lógica pura: se puede testear sin
 * base de datos y sin Worker.
 */

/** Lo que hace falta del turno de ANTES de moverlo. */
export type TurnoPrevio = {
  id: string;
  appointmentStart: Date | null;
  appointmentEnd: Date | null;
  durationMinutes: number | null;
  /** Opcional: quien arma la fila de un turno que no trae la proveedora no se rompe. */
  serviceProviderId?: string | null;
};

/** La franja nueva, ya validada contra la disponibilidad. */
export type FranjaNueva = {
  start: Date;
  end: Date;
  durationMinutes: number;
  /** La proveedora a la que pasa el turno. Ausente = no cambia de proveedora. */
  providerId?: string | null;
};

export type QuienYPorQue = {
  userId?: string | null;
  reason?: string | null;
};

export type FilaDeReagendado = {
  appointmentId: string;
  previousStart: Date | null;
  previousEnd: Date | null;
  previousDurationMinutes: number | null;
  newStart: Date;
  newEnd: Date;
  newDurationMinutes: number;
  reason: string | null;
  rescheduledByUserId: string | null;
  previousProviderId: string | null;
  newProviderId: string | null;
};

export function filaDeReagendado(
  turno: TurnoPrevio,
  nueva: FranjaNueva,
  quien: QuienYPorQue,
): FilaDeReagendado {
  const motivo = quien.reason?.trim();
  return {
    appointmentId:           turno.id,
    previousStart:           turno.appointmentStart,
    previousEnd:             turno.appointmentEnd,
    previousDurationMinutes: turno.durationMinutes,
    newStart:                nueva.start,
    newEnd:                  nueva.end,
    newDurationMinutes:      nueva.durationMinutes,
    reason:                  motivo ? motivo : null,
    rescheduledByUserId:     quien.userId ?? null,
    previousProviderId:      turno.serviceProviderId ?? null,
    newProviderId:           nueva.providerId ?? turno.serviceProviderId ?? null,
  };
}

/**
 * ¿El turno se movió de verdad?
 *
 * Confirmar el mismo horario que ya tenía no es un reagendamiento. Sin este
 * filtro el historial se llena de filas donde el antes y el después son
 * idénticos, y deja de servir para leer qué pasó con el turno.
 */
export function huboMovimiento(turno: TurnoPrevio, nueva: FranjaNueva): boolean {
  // Pasarlo a otra proveedora es mover el turno aunque el horario sea el mismo.
  if (nueva.providerId && nueva.providerId !== (turno.serviceProviderId ?? null)) return true;
  if (!turno.appointmentStart) return true;
  if (turno.appointmentStart.getTime() !== nueva.start.getTime()) return true;
  return turno.appointmentEnd?.getTime() !== nueva.end.getTime();
}
