/**
 * Si una sesión de depilación se puede AGENDAR o sólo RESERVAR.
 *
 * **Sólo aplica a depilación.** El resto de la agenda sigue funcionando como
 * siempre: se agenda y se cobra cuando toque.
 *
 * Las reglas, tal como las definió la dueña del negocio:
 *
 * - **Reservar** guarda el lugar 24 horas y no exige nada. Si vence sin
 *   pagarse, el `pg_cron` la cancela y la sesión vuelve al pozo sola.
 * - **Un pack, combo o promo** se agenda con el **40%** — es la regla de "a lo
 *   sumo dos pagos, el primero de 40% para arriba" que ya vive en el cobro.
 * - **La última sesión libre exige el 100%.** Las primeras arrancan el
 *   tratamiento; la que lo cierra pide estar al día.
 * - Una compra de **una sola sesión** es a la vez la primera y la última, así
 *   que exige el 100% por los dos caminos: un servicio suelto se paga entero.
 */
const MINIMO_DE_PACK = 0.4;

export type EstadoDePuerta = {
  puedeAgendar: boolean;
  /** Siempre `true`: reservar es guardar el lugar, no cobrar. */
  puedeReservar: true;
  /** Por qué no se puede agendar. `null` cuando sí se puede. */
  motivo: string | null;
  /** Cuánto falta cobrar para que se pueda. `0` si ya se puede. */
  faltaCobrar: number;
};

export function puertaDePago(input: {
  finalAmount: number;
  pagado: number;
  esPaquete: boolean;
  sesionesTotales: number;
  sesionesLibres: number;
}): EstadoDePuerta {
  const { finalAmount, pagado, sesionesTotales, sesionesLibres } = input;
  const esLaUltima = sesionesLibres <= 1;
  const admiteDosPagos = sesionesTotales > 1 || input.esPaquete;

  const exigido =
    esLaUltima || !admiteDosPagos
      ? finalAmount
      : Math.round(finalAmount * MINIMO_DE_PACK);

  const falta = Math.max(0, exigido - pagado);
  if (falta <= 0) {
    return { puedeAgendar: true, puedeReservar: true, motivo: null, faltaCobrar: 0 };
  }

  // El motivo nombra la regla Y el monto. "No se puede agendar" a secas
  // obliga a Laura a adivinar qué falta, con la clienta enfrente.
  const motivo = esLaUltima && admiteDosPagos
    ? "Es la última sesión: para agendarla hay que estar al día"
    : admiteDosPagos
      ? "Para agendar hace falta al menos el 40%"
      : "Un servicio suelto se paga entero para poder agendarlo";

  return { puedeAgendar: false, puedeReservar: true, motivo, faltaCobrar: falta };
}
