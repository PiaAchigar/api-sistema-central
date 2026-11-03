/**
 * Aplazar el vencimiento de un saldo a favor.
 *
 * Laura elige **una fecha exacta**, no una cantidad de meses: el caso real es
 * "la clienta estuvo internada, dale hasta fin de año", no "sumale 60 días".
 *
 * **No hay concepto nuevo.** Aplazar es mover `expires_at`, la misma columna
 * que se estampa al acreditar. No existe un estado "perdonado" ni una tabla
 * paralela: un saldo está vencido o no según su fecha, siempre.
 *
 * El rastro va pegado al texto del origen, igual que hace el sistema con las
 * reservas que expiran solas (ver el pg_cron de CLAUDE.md). Así no hace falta
 * una columna nueva y el "por qué" viaja con el movimiento.
 *
 * Lógica pura, sin base de datos.
 */

/** Lo que separa el origen de la plata de su historial de aplazos. */
export const SEPARADOR = " | ";

/** dd/mm/aaaa leyendo las partes UTC: todo el sistema guarda UTC. */
export function fechaCorta(d: Date): string {
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${d.getUTCFullYear()}`;
}

export type LoteAplazable = {
  /** NULL = no vence. No hay nada que aplazar. */
  venceEl: Date | null;
  /** false para los consumos: un débito no tiene vencimiento propio. */
  esAcreditacion: boolean;
};

/**
 * Por qué NO se puede aplazar este lote a esta fecha. Vacío = se puede.
 *
 * Devuelve una lista y no un booleano para poder decirle a Laura cuál es el
 * problema. "No se puede" sin motivo obliga a adivinar.
 */
export function razonesParaNoAplazar(
  lote: LoteAplazable,
  nuevaFecha: Date,
  hoy: Date,
): string[] {
  const razones: string[] = [];

  if (!lote.esAcreditacion) {
    razones.push("Esto no es una acreditación: los consumos no vencen.");
  }
  if (lote.venceEl == null) {
    razones.push("Este saldo no tiene fecha de vencimiento, así que no hay nada que aplazar.");
  }
  if (nuevaFecha <= hoy) {
    razones.push("La fecha nueva tiene que ser posterior a hoy.");
  }
  // Sólo si ya pasaron las anteriores: con `venceEl` en null esta comparación
  // no significa nada y sumaría un segundo mensaje que confunde.
  if (razones.length === 0 && lote.venceEl != null && nuevaFecha <= lote.venceEl) {
    razones.push(
      `Aplazar es correr la fecha para adelante. Este saldo ya vence el ${fechaCorta(lote.venceEl)}.`,
    );
  }

  return razones;
}

export type CompraAplazable = {
  /** NULL = no vence. No hay nada que aplazar. */
  venceEl: Date | null;
  cancelada: boolean;
};

/**
 * Por qué NO se puede aplazar esta compra a esta fecha. Vacío = se puede.
 *
 * Una compra vencida pero no cancelada SÍ se aplaza: es justo el caso de la
 * clienta que se pasó de fecha y Laura le da una prórroga.
 */
export function razonesParaNoAplazarCompra(
  compra: CompraAplazable,
  nuevaFecha: Date,
  hoy: Date,
): string[] {
  const razones: string[] = [];

  if (compra.cancelada) razones.push("Esta compra está cancelada.");
  if (compra.venceEl == null) {
    razones.push("Esta compra no tiene fecha de vencimiento, así que no hay nada que aplazar.");
  }
  if (nuevaFecha <= hoy) razones.push("La fecha nueva tiene que ser posterior a hoy.");
  // Sólo si no salió ninguna de las anteriores: con `venceEl` en null esta
  // comparación no significa nada y sumaría un segundo mensaje que confunde.
  if (razones.length === 0 && compra.venceEl != null && nuevaFecha <= compra.venceEl) {
    razones.push(
      `Aplazar es correr la fecha para adelante. Esta compra ya vence el ${fechaCorta(compra.venceEl)}.`,
    );
  }

  return razones;
}

/**
 * El texto del movimiento después de aplazarlo.
 *
 * Deja el origen intacto y agrega el aplazo detrás. Aplazar dos veces deja las
 * dos líneas: la cadena completa es el historial.
 */
export function notasConAplazo(
  notas: string | null,
  fechaVieja: Date | null,
  fechaNueva: Date,
  motivo?: string | null,
): string {
  const desde = fechaVieja ? `del ${fechaCorta(fechaVieja)} ` : "";
  const limpio = motivo?.trim();
  const linea = `Aplazado ${desde}al ${fechaCorta(fechaNueva)}${limpio ? `: ${limpio}` : ""}`;
  return notas ? `${notas}${SEPARADOR}${linea}` : linea;
}

/**
 * Parte el texto guardado en el origen y sus aplazos.
 *
 * El cartel y la ficha muestran el origen solo: sin esto, un saldo aplazado
 * tres veces se leería como un chorizo donde no se encuentra de dónde salió la
 * plata.
 */
export function origenYAplazos(notas: string | null): { origen: string | null; aplazos: string[] } {
  if (!notas) return { origen: null, aplazos: [] };
  const partes = notas.split(SEPARADOR);
  return { origen: partes[0] ?? null, aplazos: partes.slice(1) };
}
