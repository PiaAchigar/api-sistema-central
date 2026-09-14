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

/**
 * De qué combo salen los servicios que hay que crear al vender `comboId`.
 *
 * Un **pack** puede ser de dos formas: uno que REPITE otro combo —tiene
 * `packOfComboId` y ninguna línea propia— o uno armado con sus propios
 * servicios. En el primer caso los servicios hay que ir a buscarlos al combo
 * original; mirar las líneas del pack devolvería una lista vacía.
 *
 * **Por qué es una función y no un `? :` suelto** (revisión final de V3b,
 * 2026-09-14): si esta decisión se equivoca, la venta NO falla. Crea las filas
 * de `customer_purchase_service` con `service_id` NULL —que es lo legítimo
 * para depilación y capacitaciones— y la clienta se entera recién cuando
 * quiere agendar y no hay nada para elegir. Un error mudo que se descubre
 * tarde y con la plata ya cobrada merece su propio test.
 *
 * `packOfComboId` sólo significa algo para los packs: un combo común con la
 * columna sucia se sigue mirando a sí mismo.
 */
export function comboDelQueSalenLosServicios(
  kind: string | null,
  packOfComboId: string | null,
  comboId: string,
): string {
  return kind === "pack" && packOfComboId ? packOfComboId : comboId;
}

/** Lo mínimo para ordenar un servicio comprado en la ficha de la clienta. */
export type ServicioOrdenable = {
  id: string;
  repeticion: number | null;
  orden: number | null;
  serviceName: string | null;
};

/**
 * Cómo se muestran los servicios comprados de una compra: vuelta por vuelta, y
 * dentro de cada vuelta por `orden`.
 *
 * **El desempate por nombre e `id` no es cosmético** (revisión final de V3b,
 * 2026-09-14). En un combo de 2 servicios distintos las dos filas comparten
 * `repeticion` 1 y `orden` 1, así que los dos primeros criterios empatan.
 * `Array.prototype.sort` es estable, o sea que ante el empate deja el orden en
 * que vino la consulta — y un `SELECT` sin `ORDER BY` no promete ninguno: en
 * cuanto se agenda uno de los dos, el `UPDATE` reescribe la fila y Postgres
 * suele devolverla al final. Resultado: los dos servicios se daban vuelta
 * entre una visita a la ficha y la siguiente, sin que hubiera cambiado nada.
 *
 * Por eso el último criterio es el `id`, que no cambia nunca: así el orden es
 * total y la ficha se ve igual siempre.
 */
export function ordenDeServiciosComprados(a: ServicioOrdenable, b: ServicioOrdenable): number {
  return (
    (a.repeticion ?? 0) - (b.repeticion ?? 0) ||
    (a.orden ?? 0) - (b.orden ?? 0) ||
    (a.serviceName ?? "").localeCompare(b.serviceName ?? "", "es") ||
    a.id.localeCompare(b.id)
  );
}
