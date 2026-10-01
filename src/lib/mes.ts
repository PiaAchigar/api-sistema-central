/** Todas las fechas YYYY-MM-DD de un mes YYYY-MM, en orden. */
export function diasDelMes(month: string): string[] {
  const [anio = 0, mes = 1] = month.split("-").map(Number);
  const cantidad = new Date(Date.UTC(anio, mes, 0)).getUTCDate();
  return Array.from({ length: cantidad }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`);
}
