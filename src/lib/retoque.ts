/**
 * #36 — La última sesión de un pack puede ser un retoque (no se cobra).
 *
 * Una línea comprada es el retoque cuando su compra viene de un pack con la
 * tilde y es la sesión N de N (`repeticion` = `sessionsTotal`). Lógica pura.
 */
export function esLineaDeRetoque(
  linea: { repeticion: number | null },
  compra: { sessionsTotal: number | null },
  ultimaSesionEsRetoque: boolean,
): boolean {
  if (!ultimaSesionEsRetoque) return false;
  if (linea.repeticion == null || compra.sessionsTotal == null) return false;
  return linea.repeticion === compra.sessionsTotal;
}
