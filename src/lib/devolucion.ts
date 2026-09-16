/**
 * Devolver plata en mano: cuándo se puede y cuánto.
 *
 * Es el ÚLTIMO recurso, no el primero. Lo que Laura quiere ofrecerle a la
 * clienta es usar el saldo a favor en otro tratamiento; sacar plata de la caja
 * se hace sólo si la clienta no quiere nada (decisión de Laura vía Pia,
 * 2026-09-09).
 *
 * Por eso las condiciones son más duras que las del saldo a favor: acá se
 * exige que la compra esté **cancelada** y **pagada al 100%**.
 *
 * Lógica pura, sin base de datos. Mismo patrón que `compra-borrado.ts`.
 */

import { puedeDevolverse, saldoAAcreditar, type ServicioParaSaldo } from "./saldo-de-cancelacion";

export type CompraParaDevolver = {
  cancelada: boolean;
  pagado: number;
  finalAmount: number;
  /** Los servicios comprados, con su precio y si ya se usaron. Se devuelve el
   *  valor de los que NO se usaron: ver `proporcionUsada`. */
  servicios: readonly ServicioParaSaldo[];
  /** El saldo a favor que le queda HOY a la clienta. */
  saldoDisponible: number;
  yaDevuelta: boolean;
};

const pesos = (n: number) => `$${Math.round(n).toLocaleString("es-AR")}`;

/**
 * Los motivos por los que NO se puede devolver. Vacío = se puede.
 *
 * Se devuelven todos, no el primero: destrabar de a uno obliga a intentar a
 * ciegas sin saber cuánto falta.
 */
export function razonesParaNoDevolver(c: CompraParaDevolver): string[] {
  const motivos: string[] = [];

  if (!c.cancelada) {
    // Devolver la plata de algo que la clienta todavía tiene sería dejarle el
    // pack gratis.
    motivos.push("la compra sigue activa (hay que cancelarla primero)");
  }
  if (c.yaDevuelta) {
    motivos.push("ya se le devolvió la plata de esta compra");
  }
  if (!puedeDevolverse(c)) {
    motivos.push(
      `no está paga al 100% (se pagaron ${pesos(c.pagado)} de ${pesos(c.finalAmount)}) — ` +
        "esa plata queda a favor, pero no se devuelve en efectivo",
    );
  }

  // El saldo se mira ÚLTIMO y sólo si todo lo demás está bien.
  //
  // Una compra que todavía no se canceló no acreditó nada, así que su clienta
  // puede tener saldo cero por el simple hecho de que no hay nada acreditado.
  // Decirle ahí "lo usó en otra compra" es mentirle sobre por qué no se puede.
  if (motivos.length === 0 && c.saldoDisponible <= 0) {
    motivos.push("ya no tiene saldo a favor (lo usó en otra compra)");
  }

  return motivos;
}

/**
 * Cuánta plata se le devuelve: lo pagado menos los servicios que ya usó,
 * topeado por el saldo que efectivamente le queda.
 *
 * El tope importa: si gastó parte del saldo en otro tratamiento, esa plata ya
 * se la llevó en servicios y no se puede devolver de nuevo.
 */
export function montoADevolver(c: CompraParaDevolver): number {
  const teorico = saldoAAcreditar({
    pagado: c.pagado,
    finalAmount: c.finalAmount,
    servicios: c.servicios,
  });
  return Math.max(0, Math.min(teorico, c.saldoDisponible));
}
