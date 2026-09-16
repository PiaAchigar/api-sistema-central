/**
 * Qué pasa con la plata cuando se cancela una compra.
 *
 * **Son DOS cosas distintas y no hay que confundirlas** (Laura vía Pia,
 * 2026-09-09):
 *
 * - **Saldo a favor** — generoso. CUALQUIER plata que haya entrado queda a
 *   favor, seña incluida, para usarla en otro tratamiento. Es lo primero que
 *   se le ofrece a la clienta y es lo que evita sacar plata de la caja.
 * - **Devolución** — restrictivo. Sacar plata de la caja y dársela en la mano
 *   exige que la compra esté pagada al 100%.
 *
 * En las dos se descuenta lo mismo: los servicios que ya se usaron. La
 * diferencia está en la puerta de entrada, no en la cuenta.
 *
 * **Y la seña, ¿cuándo se pierde?** Cuando la clienta no vuelve. No hace falta
 * decidirlo al cancelar: el saldo a favor vence a los 3 meses y ahí pasa a
 * caja. Si en ese plazo cambia de tratamiento, lo usa; si no aparece, se
 * perdió. Laura no tiene que adivinar al momento de cancelar qué va a hacer la
 * clienta.
 *
 * Lógica pura, sin base de datos.
 */

/** Un servicio comprado, para la cuenta de la cancelación. */
export type ServicioParaSaldo = {
  /**
   * Lo que valía este servicio cuando se vendió, congelado en
   * `customer_purchase_service.price`.
   *
   * `null` cuando la compra no se desglosa en servicios con precio propio —
   * un pack de depilación, una capacitación—. Ahí todas las filas valen lo
   * mismo y el reparto por partes iguales es el correcto.
   */
  price: number | null;
  /**
   * Ya se cobró: la clienta se lo hizo, o lo perdió por no venir. Los dos
   * cuentan igual — el turno ocupó una hora que nadie más pudo usar (regla de
   * Laura, 2026-09-09). Los agendados NO: todavía no pasó nada.
   */
  usado: boolean;
};

export type CompraCancelada = {
  /** Lo efectivamente COBRADO. Sólo se puede dejar a favor lo que entró. */
  pagado: number;
  /** El precio de la compra. */
  finalAmount: number;
  /** Los servicios comprados, con su precio y si ya se usaron. */
  servicios: readonly ServicioParaSaldo[];
};

/**
 * Qué proporción de la compra se llevó la clienta.
 *
 * **Pesa por PRECIO, no por cantidad, y esa es toda la corrección** (Pia,
 * 2026-09-16). Repartir en partes iguales sólo es correcto cuando todas las
 * partes valen lo mismo. En el Combo1-prueba de producción no: Baby Botox
 * $249.000 contra una depilación facial de $17.500. Cancelarlo con el Botox
 * hecho devolvía la mitad —$106.600— por un servicio de $17.500: Laura
 * regalaba $92.000 por cancelación.
 *
 * **No hace falta distinguir pack de combo.** Cuando todos los precios son
 * iguales —un pack del mismo servicio— la proporción de precio ES la
 * proporción de cantidad, así que el pack sigue dando exactamente lo que daba
 * antes. Una sola regla, sin ramas.
 *
 * Se cuenta en vez de pesar cuando no hay precios utilizables: o no se
 * cargaron (depilación, capacitaciones), o suman cero — hay 9 servicios
 * activos en producción sin ningún precio, y dividir por cero sería peor que
 * repartir en partes iguales.
 */
export function proporcionUsada(servicios: readonly ServicioParaSaldo[]): number {
  if (servicios.length === 0) return 0;

  const utilizables = servicios.every((s) => typeof s.price === "number" && isFinite(s.price));
  if (utilizables) {
    const total = servicios.reduce((suma, s) => suma + (s.price ?? 0), 0);
    if (total > 0) {
      const usado = servicios.reduce((suma, s) => suma + (s.usado ? (s.price ?? 0) : 0), 0);
      return usado / total;
    }
  }

  return servicios.filter((s) => s.usado).length / servicios.length;
}

/**
 * Cuánta plata de la compra se llevó la clienta en servicios.
 *
 * Se redondea UNA sola vez, acá, y el crédito es el resto: así nunca se
 * acredita más de lo que entró por un peso de redondeo.
 */
export function valorDeLoUsado(
  finalAmount: number,
  servicios: readonly ServicioParaSaldo[],
): number {
  return Math.round(finalAmount * proporcionUsada(servicios));
}

/**
 * El saldo a favor que deja una cancelación: lo pagado menos lo que valen los
 * servicios que ya se usaron.
 *
 * Se aplica SIEMPRE, haya pagado una seña o todo. Una seña también es plata de
 * la clienta y le queda a favor por si quiere cambiar de tratamiento.
 *
 * **Nunca negativo.** Con el mínimo del 40% una clienta puede haberse hecho
 * servicios que valen más de lo que pagó; ahí el saldo es cero. La deuda que
 * quede es una conversación entre Laura y la clienta, no un número escondido
 * en el saldo a favor.
 */
export function saldoAAcreditar(compra: CompraCancelada): number {
  if (compra.pagado <= 0) return 0;
  // Sin servicios comprados no hay nada que prorratear: vuelve todo lo pagado.
  // No debería pasar (toda compra crea al menos una fila), pero quedarse con
  // la plata sería lo peor de las dos opciones.
  if (compra.servicios.length === 0) return compra.pagado;

  return Math.max(0, compra.pagado - valorDeLoUsado(compra.finalAmount, compra.servicios));
}

/**
 * Si esta compra habilita DEVOLVER plata en mano.
 *
 * La condición es una sola: que esté pagada al 100%. Una seña no se devuelve
 * en efectivo — queda a favor, que es otra cosa. `>=` y no `===` porque si se
 * cobró de más, con más razón está paga.
 */
export function puedeDevolverse(compra: Pick<CompraCancelada, "pagado" | "finalAmount">): boolean {
  return compra.pagado > 0 && compra.pagado >= compra.finalAmount;
}
