const DIAS = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];

/** "Lun 10:00", de lunes a domingo y por hora. Lo comparten las opciones para anotar y el listado de suscripciones. */
export function formatearHorarios(horarios: Array<{ dayOfWeek: number | null; startTime: string | null }>): string[] {
  return horarios
    .map((h) => ({ dia: h.dayOfWeek ?? 0, hora: (h.startTime ?? "00:00:00").slice(0, 5) }))
    .sort((a, b) => ((a.dia + 6) % 7) - ((b.dia + 6) % 7) || a.hora.localeCompare(b.hora))
    .map((h) => `${DIAS[h.dia]} ${h.hora}`);
}
