import type { LineaDeCombo } from "./servicios-comprados";

/**
 * Una cosa de las que lleva el paquete, ya resuelta contra el catálogo.
 *
 * El repositorio resuelve (sale a buscar las líneas del combo, el precio del
 * pack); esto sólo arma la lista final. Separarlo es lo que permite testear el
 * desglose sin levantar Postgres.
 */
export type ParteDelPaquete = {
  tipo: "servicio" | "combo" | "depilacion";
  id: string;
  /** Cuántas veces entra en el paquete. */
  cantidad: number;
  /** Lo que vale suelta. Es la base del reparto del precio (spec §5). */
  precioDeLista: number;
  /** En qué se desglosa UNA unidad de esta parte. */
  lineas: LineaDeCombo[];
};

/**
 * Las líneas que hay que crear al vender un paquete.
 *
 * Cada unidad de cada parte aporta sus líneas, en el orden en que Laura armó
 * la promo. El orden importa: es el que va a ver la clienta en su ficha, y es
 * el que decide cuál línea absorbe el redondeo del reparto (§5).
 *
 * **Una parte con cantidad 3 da 3 juegos de líneas, no uno con precio triple.**
 * Son 3 turnos distintos que la clienta va a agendar por separado.
 *
 * **`sessionsIncluded` se EXPANDE acá y nunca se propaga: sale siempre en 1.**
 * Más abajo, `filasDeServicioComprado` expande otra vez cada línea con
 * `sessionsIncluded > 1` en varias filas. Si acá se copiara el valor tal
 * cual, un renglón de combo con `sessionsIncluded: 2` produciría UN solo
 * monto repartido para DOS filas — las dos se llevarían el monto entero y la
 * suma de las partes superaría el precio del paquete (spec §5: «Σ montos =
 * precioDelPaquete»), cobrándole de más a la clienta al cancelar.
 */
export function lineasDelPaquete(partes: readonly ParteDelPaquete[]): LineaDeCombo[] {
  const salida: LineaDeCombo[] = [];
  for (const parte of partes) {
    for (let unidad = 0; unidad < Math.max(1, parte.cantidad); unidad++) {
      for (const linea of parte.lineas) {
        // `sessionsIncluded` se EXPANDE acá y no se propaga: más abajo
        // `filasDeServicioComprado` expandiría otra vez, y entonces habría un
        // solo monto repartido para varias filas — las partes sumarían más
        // que el precio del paquete y la clienta cobraría de más al cancelar.
        for (let s = 0; s < Math.max(1, linea.sessionsIncluded); s++) {
          salida.push({
            serviceId: linea.serviceId ?? null,
            depilationComboId: linea.depilationComboId ?? null,
            trainingId: linea.trainingId ?? null,
            sessionsIncluded: 1,
            price: linea.price,
          });
        }
      }
    }
  }
  return salida;
}
