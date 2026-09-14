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
 * En las dos se descuenta lo mismo: los servicios que ya se hicieron. La
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

export type CompraCancelada = {
  /** Lo efectivamente COBRADO. Sólo se puede dejar a favor lo que entró. */
  pagado: number;
  /** El precio de la compra. Define dos cosas: cuánto vale cada servicio
   *  entregado, y si el pago fue completo (que habilita la devolución). */
  finalAmount: number;
  /**
   * Cuántas FILAS de `customer_purchase_service` tiene la compra: el total de
   * cosas que la clienta compró y puede agendar.
   *
   * **No es `sessions_total`** y por eso no se llama así (revisión final de
   * V3b, 2026-09-14). `sessions_total` son las REPETICIONES de la compra;
   * hasta V3b los dos números coincidían y el campo se llamaba `sessionsTotal`
   * sin que molestara. Desde que la unidad de consumo es el servicio ya no
   * coinciden: un combo de 2 servicios vendido suelto tiene `sessions_total`
   * 1 y DOS filas, y un pack de 3 de ese combo tiene 3 y SEIS.
   *
   * Prorratear por las repeticiones inflaba lo consumido —siempre en el mismo
   * sentido, porque las filas son ≥ que las repeticiones— y le acreditaba de
   * menos a la clienta: el combo de $213.200 con un servicio hecho le dejaba
   * $0 a favor en vez de $106.600.
   */
  totalDeServicios: number;
  /**
   * Servicios ya USADOS: los consumidos más los PERDIDOS por ausente. Los dos
   * se cobraron — uno porque el tratamiento se hizo, el otro porque el turno
   * ocupó una hora que nadie más pudo usar (regla de Laura, 2026-09-09).
   *
   * Los agendados NO cuentan: todavía no pasó nada.
   */
  consumidas: number;
};

/**
 * Lo que vale UNO de los servicios comprados de esta compra.
 *
 * El denominador es la cantidad de filas de `customer_purchase_service`, no
 * las repeticiones: ver `totalDeServicios`.
 *
 * **No se llama `valorDeUnaSesion`** (revisión final de V3b, 2026-09-14). Se
 * llamaba así, y era la misma trampa que causó el bug del prorrateo en chico:
 * lo que reparte el precio es el servicio comprado, tenga turno o no. Una
 * *sesión* es un servicio que YA tiene fecha y hora, y acá se divide entre
 * todos —los agendados y los que están a agendar—, así que el nombre viejo
 * describía mal justo el número del que cuelga la plata.
 */
export function valorDeUnServicioComprado(
  finalAmount: number,
  totalDeServicios: number,
): number {
  return totalDeServicios <= 0 ? 0 : finalAmount / totalDeServicios;
}

/**
 * El saldo a favor que deja una cancelación: lo pagado menos lo que valen los
 * servicios que ya se hicieron.
 *
 * Se aplica SIEMPRE, haya pagado una seña o todo. Una seña también es plata de
 * la clienta y le queda a favor por si quiere cambiar de tratamiento.
 *
 * Se redondea UNA sola vez, sobre lo consumido, y el crédito es el resto: así
 * nunca se acredita más de lo que entró por un peso de redondeo.
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
  if (compra.totalDeServicios <= 0) return compra.pagado;

  const valorConsumido = Math.round(
    valorDeUnServicioComprado(compra.finalAmount, compra.totalDeServicios) * compra.consumidas,
  );
  return Math.max(0, compra.pagado - valorConsumido);
}

/**
 * Si esta compra habilita DEVOLVER plata en mano.
 *
 * La condición es una sola: que esté pagada al 100%. Una seña no se devuelve
 * en efectivo — queda a favor, que es otra cosa. `>=` y no `===` porque si se
 * cobró de más, con más razón está paga.
 *
 * Lo que se devuelve es `saldoAAcreditar`: el mismo descuento por servicios
 * consumidos. La puerta es distinta; la cuenta es la misma.
 */
export function puedeDevolverse(compra: Pick<CompraCancelada, "pagado" | "finalAmount">): boolean {
  return compra.pagado > 0 && compra.pagado >= compra.finalAmount;
}
