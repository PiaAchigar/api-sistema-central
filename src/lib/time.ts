// Los Workers corren en UTC; todas las conversiones a hora local del negocio
// pasan por acá. Argentina no tiene DST, offset fijo -03:00.
export const BUSINESS_TZ_OFFSET = "-03:00";

/** Minutos desde medianoche a partir de "HH:MM" o "HH:MM:SS". */
export function timeToMinutes(value: string): number {
  const [h = 0, m = 0] = value.split(":").map(Number);
  return h * 60 + m;
}

/** "HH:MM" a partir de minutos desde medianoche. */
export function minutesToTime(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Valida formato YYYY-MM-DD y que sea una fecha real. */
export function isValidDateString(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  return !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

/** Día de la semana (0=domingo ... 6=sábado) de una fecha YYYY-MM-DD. */
export function dayOfWeek(dateStr: string): number {
  return new Date(`${dateStr}T00:00:00Z`).getUTCDay();
}

/** Date UTC correspondiente a una fecha local ART + minutos desde medianoche. */
export function localDateTimeToUtc(dateStr: string, minutes: number): Date {
  return new Date(`${dateStr}T${minutesToTime(minutes)}:00${BUSINESS_TZ_OFFSET}`);
}

/** Rango UTC [inicio, fin) del día local ART dado. */
export function localDayRangeUtc(dateStr: string): { start: Date; end: Date } {
  const start = localDateTimeToUtc(dateStr, 0);
  return { start, end: new Date(start.getTime() + 24 * 60 * 60 * 1000) };
}

/** Fecha local ART (YYYY-MM-DD) de un instante UTC. */
export function utcToLocalDateString(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Argentina/Buenos_Aires",
  }).format(d);
}

/** Minutos desde medianoche local ART de un instante UTC. */
export function utcToLocalMinutes(d: Date): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/Argentina/Buenos_Aires",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
  return timeToMinutes(parts);
}

/** Fecha local ART de hoy (YYYY-MM-DD). */
export function todayLocal(): string {
  return utcToLocalDateString(new Date());
}
