/**
 * El estado de una compra y de sus servicios comprados.
 *
 * `customer_purchase_service` NO tiene columna de estado, y por eso no puede
 * desincronizarse: se deriva. Un turno cancelado devuelve el servicio
 * comprado a *disponible* sin que nadie escriba nada — la condición deja de
 * cumplirse.
 *
 * Lógica pura, sin base de datos.
 */

export type EstadoSesion = "consumida" | "perdida" | "agendada" | "vencida" | "disponible";

export type ServicioCompradoCrudo = {
  consumedAt: Date | null;
  appointmentId: string | null;
  /** El estado del turno. Un turno cancelado o ausente no reserva la sesión. */
  appointmentStatus: string | null;
};

export type VigenciaCompra = {
  expiresAt: Date | null;
  cancelledAt: Date | null;
};

/**
 * Un turno CANCELADO libera la sesión: se avisó, se reagenda, no se perdió.
 *
 * El ausente NO está acá y es a propósito — ver `estadoDeSesion`.
 */
const NO_RESERVA = new Set(["cancelled"]);

/**
 * La clienta no vino y no avisó: la sesión se pierde y no se reagenda (regla
 * de Laura, 2026-09-09). El turno ocupó una hora de agenda que nadie más pudo
 * usar, así que esa sesión ya se cobró.
 */
const AUSENTE = "no_show";

/**
 * El orden importa y no es alfabético:
 *
 * 1. **Consumida** gana sobre todo. La sesión se usó cuando el pack estaba
 *    vigente; que hoy esté vencido no borra que se hizo.
 * 2. **Perdida** — la clienta no vino. Gana sobre vencida por lo mismo que
 *    consumida: ya pasó, y el vencimiento posterior no lo cambia.
 * 3. **Agendada** gana sobre vencida. El turno existe y alguien va a venir:
 *    decirle "vencida" haría que se la ignore y la clienta llegue a un turno
 *    que nadie esperaba.
 * 4. **Vencida** para lo que quedó sin usar, si el pack venció o se canceló.
 * 5. **Disponible** en cualquier otro caso.
 */
export function estadoDeSesion(
  sesion: ServicioCompradoCrudo,
  compra: VigenciaCompra,
  ahora: Date,
): EstadoSesion {
  if (sesion.consumedAt) return "consumida";

  // No vino: la sesión se perdió. NO vuelve a disponible — el turno ocupó una
  // hora que nadie más pudo usar.
  if (sesion.appointmentStatus === AUSENTE) return "perdida";

  const reservada =
    sesion.appointmentId != null && !NO_RESERVA.has(sesion.appointmentStatus ?? "");
  if (reservada) return "agendada";

  if (compra.cancelledAt) return "vencida";
  if (compra.expiresAt && compra.expiresAt < ahora) return "vencida";
  return "disponible";
}

/**
 * Los estados en los que el servicio comprado TIENE un turno de verdad.
 *
 * Un turno cancelado deja de existir para la ficha: el servicio vuelve a "a
 * agendar" y la fecha vieja no es su turno, es el turno que se dio de baja.
 * Mostrarla igual hacía leer la fila como si siguiera esperando a la clienta
 * ese día (Pia, 2026-09-16).
 *
 * Que el `appointment_id` siga escrito en la base es correcto y no se toca:
 * es el rastro de lo que pasó, y `serviciosDisponiblesPara` ya sabe que un
 * turno cancelado no reserva. Lo que no corresponde es publicarlo como si
 * fuera el turno vigente.
 *
 * **Ausente sí cuenta**: la clienta no vino, pero el turno existió y esa fecha
 * explica por qué el servicio figura perdido.
 */
const CON_TURNO = new Set<EstadoSesion>(["agendada", "consumida", "perdida"]);

/** Si la fila tiene un turno vigente que valga la pena mostrar. */
export function tieneTurno(estado: EstadoSesion): boolean {
  return CON_TURNO.has(estado);
}

export type ResumenCompra = {
  consumidas: number;
  /** Sesiones que la clienta perdió por no venir. */
  perdidas: number;
  /** Consumidas + perdidas: lo que ya no está disponible y ya se cobró. */
  usadas: number;
  agendadas: number;
  disponibles: number;
  vencidas: number;
  pagado: number;
  saldo: number;
  saldada: boolean;
};

/**
 * Los números de una compra: cuántos servicios comprados en cada estado,
 * cuánto se pagó y cuánto falta.
 *
 * `pagos` son los montos de los `payments` CONFIRMADOS de esta compra — el
 * saldo tiene una sola definición y es esta.
 */
export function resumenDeCompra(
  compra: { finalAmount: number } & VigenciaCompra,
  sesiones: readonly ServicioCompradoCrudo[],
  pagos: readonly number[],
  ahora: Date,
): ResumenCompra {
  const conteo = { consumida: 0, perdida: 0, agendada: 0, vencida: 0, disponible: 0 };
  for (const s of sesiones) conteo[estadoDeSesion(s, compra, ahora)] += 1;

  const pagado = pagos.reduce((a, b) => a + b, 0);
  // Nunca negativo: un saldo negativo se leería como "hay que devolverle
  // plata", que es otra cosa y vive en el saldo a favor del cliente.
  const saldo = Math.max(0, compra.finalAmount - pagado);

  return {
    consumidas: conteo.consumida,
    perdidas: conteo.perdida,
    usadas: conteo.consumida + conteo.perdida,
    agendadas: conteo.agendada,
    disponibles: conteo.disponible,
    vencidas: conteo.vencida,
    pagado,
    saldo,
    saldada: saldo === 0,
  };
}

/**
 * Cómo se llama una línea comprada.
 *
 * Tres fuentes, en orden de confianza:
 *
 * 1. **El servicio de la línea.** Lo normal.
 * 2. **El nombre propio de la línea** (1.55.0): el pack de depilación o la
 *    capacitación que la línea trae en su `depilation_combo_id` /
 *    `training_id`. En un paquete de promo es la ÚNICA fuente posible: la
 *    cabecera no puede decirlo porque puede haber dos packs distintos.
 * 3. **La cabecera de la compra.** Respaldo para las compras anteriores a la
 *    1.55.0, cuyas líneas no tienen la columna rellena.
 */
export function nombreDeLaLinea(
  serviceName: string | null,
  nombreDeLaCabecera: string | null,
  nombrePropioDeLaLinea: string | null = null,
): string | null {
  return serviceName ?? nombrePropioDeLaLinea ?? nombreDeLaCabecera;
}

/**
 * El nombre de respaldo de una compra: su pack de depilación o su capacitación.
 *
 * Una compra tiene UN solo origen, así que a lo sumo uno de los dos existe.
 * Cuando la promo se venda como paquete, la línea va a traer su propia
 * identidad y esto queda como respaldo para las compras viejas.
 */
export function nombreDeCabecera(
  compra: { depilationComboId: string | null; trainingId: string | null },
  nombrePorId: ReadonlyMap<string, string>,
): string | null {
  if (compra.depilationComboId) return nombrePorId.get(compra.depilationComboId) ?? null;
  if (compra.trainingId) return nombrePorId.get(compra.trainingId) ?? null;
  return null;
}
