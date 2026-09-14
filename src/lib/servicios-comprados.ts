/**
 * Cuántas filas de `customer_purchase_service` genera una compra, y con qué
 * `repeticion` y `orden` cada una.
 *
 * Lógica pura, sin base de datos: es lo único de la venta que vale la pena
 * testear, y así se testea sin levantar Postgres.
 *
 * Vocabulario (spec 2026-09-11 §2): cada fila es un SERVICIO COMPRADO. Pasa a
 * ser una *sesión* recién cuando se le engancha un turno.
 */

/** Un renglón del combo que se está vendiendo. */
export type LineaDeCombo = {
  serviceId: string;
  /** Cuántas veces entra ESE servicio en una vuelta. Casi siempre 1. */
  sessionsIncluded: number;
};

export type FilaDeServicioComprado = {
  /** NULL para depilación y capacitaciones: no se desglosan en servicios. */
  serviceId: string | null;
  repeticion: number;
  orden: number;
};

/**
 * @param repeticiones cuántas veces se repite la compra — `sessionsTotal`.
 * @param lineas los servicios de una vuelta. Vacío = la compra no se desglosa.
 *
 * El orden de salida es vuelta por vuelta, y dentro de cada vuelta el de las
 * líneas: así la ficha de la clienta las muestra agrupadas sin reordenar nada.
 */
export function filasDeServicioComprado(
  repeticiones: number,
  lineas: readonly LineaDeCombo[],
): FilaDeServicioComprado[] {
  if (repeticiones < 1) {
    throw new Error("La compra necesita al menos una repetición");
  }

  const filas: FilaDeServicioComprado[] = [];
  for (let repeticion = 1; repeticion <= repeticiones; repeticion++) {
    if (lineas.length === 0) {
      // Depilación y capacitaciones: una fila por vuelta y nada que desglosar.
      filas.push({ serviceId: null, repeticion, orden: 1 });
      continue;
    }
    for (const linea of lineas) {
      // `sessionsIncluded` puede ser > 1 porque la API todavía lo acepta.
      // Ignorarlo crearía UNA fila para algo que la clienta pagó tres veces, y
      // se enteraría recién al querer agendar la segunda.
      for (let orden = 1; orden <= Math.max(1, linea.sessionsIncluded); orden++) {
        filas.push({ serviceId: linea.serviceId, repeticion, orden });
      }
    }
  }
  return filas;
}
