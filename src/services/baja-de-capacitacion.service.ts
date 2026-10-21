import { sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { badRequest } from "../lib/errors";
import { compraSinTerminar } from "../lib/compra-de-capacitacion";
import { cancelCompra } from "../repositories/compras.repo";

/**
 * Dar de baja a una clienta de una capacitación (regla de Pia, 2026-10-21).
 * "Sacar" en un encuentro de capacitación siempre es esto: la saca de toda la
 * capacitación, nunca de un solo encuentro (si falta, se marca ausente).
 *
 * - **No empezó** (no pasó ningún encuentro): se cancelan sus turnos y la
 *   compra. No debe nada; lo pagado queda a favor (la cuenta de siempre de
 *   `cancelCompra`, que con el servicio sin usar devuelve todo).
 * - **Ya empezó**: Laura decide. La cuenta proporcional —precio × encuentros
 *   que pasaron / encuentros— es la sugerencia, y las faltas cuentan como
 *   pasados (el ausente cuenta como usado, regla de Laura 2026-09-09):
 *   - saldo a favor (o $0): se cancela la compra acreditando ESE monto;
 *   - queda debiendo: la compra NO se cancela (una cancelada no muestra
 *     deuda). Su total pasa a ser lo pagado + la deuda y su fila de servicio
 *     queda consumida: terminada, ya no la inscribe (`compraSinTerminar`).
 */

const ZONA = "America/Argentina/Buenos_Aires";

export type CuentaDeBaja = {
  compraId: string;
  /** Pasó al menos un encuentro activo */
  empezo: boolean;
  precio: number;
  pagado: number;
  encuentrosTotales: number;
  encuentrosPasados: number;
  /** De los pasados: a cuántos vino y a cuántos faltó (los sin marcar no suman a ninguno) */
  vino: number;
  falto: number;
  /** Lo que corresponde por los encuentros que pasaron */
  corresponde: number;
  /** Uno de los dos es 0 */
  sugerido: { saldoAFavor: number; debe: number };
};

type Compra = { id: string; precio: number; pagado: number };

async function compraViva(db: Db, trainingId: string, customerId: string, bloquear = false): Promise<Compra> {
  const [c] = (await db.execute(sql`
    SELECT cp.id, coalesce(cp.final_amount, 0)::numeric AS precio,
           coalesce((SELECT sum(p.amount) FROM payments p
                     WHERE p.customer_purchase_id = cp.id AND p.status = 'confirmed'), 0)::numeric AS pagado
    FROM customer_purchase cp
    WHERE cp.customer_id = ${customerId}::uuid AND cp.training_id = ${trainingId}::uuid
      AND cp.cancelled_at IS NULL AND ${compraSinTerminar(sql`cp.id`)}
    ORDER BY cp.purchased_at DESC NULLS LAST
    LIMIT 1
    ${bloquear ? sql`FOR UPDATE OF cp` : sql``}
  `)) as unknown as { id: string; precio: string; pagado: string }[];
  if (!c) throw badRequest("No compró esta capacitación");
  return { id: c.id, precio: Number(c.precio), pagado: Number(c.pagado) };
}

export async function cuentaDeBaja(
  db: Db,
  input: { trainingId: string; customerId: string; ahora?: Date },
): Promise<CuentaDeBaja> {
  const ahora = input.ahora ?? new Date();
  const compra = await compraViva(db, input.trainingId, input.customerId);

  // El inicio del encuentro es hora local ART: "ya pasó" se compara contra el instante real.
  const [f] = (await db.execute(sql`
    SELECT COUNT(*)::int AS totales,
           COUNT(*) FILTER (WHERE pasado)::int AS pasados,
           COUNT(*) FILTER (WHERE pasado AND estado = 'completed')::int AS vino,
           COUNT(*) FILTER (WHERE pasado AND estado = 'no_show')::int AS falto
    FROM (
      SELECT ((ts.session_date + ts.start_time) AT TIME ZONE ${ZONA}) <= ${ahora.toISOString()}::timestamptz AS pasado,
             (SELECT ap.status FROM appointments ap
              WHERE ap.training_session_id = ts.id AND ap.customer_id = ${input.customerId}::uuid
                AND ap.status <> 'cancelled'
              LIMIT 1) AS estado
      FROM training_sessions ts
      WHERE ts.training_id = ${input.trainingId}::uuid AND ts.is_active
    ) e
  `)) as unknown as { totales: number; pasados: number; vino: number; falto: number }[];

  const totales = f!.totales;
  const pasados = f!.pasados;
  const corresponde = totales > 0 ? Math.round((compra.precio * pasados) / totales) : 0;
  const diferencia = compra.pagado - corresponde;
  return {
    compraId: compra.id,
    empezo: pasados > 0,
    precio: compra.precio,
    pagado: compra.pagado,
    encuentrosTotales: totales,
    encuentrosPasados: pasados,
    vino: f!.vino,
    falto: f!.falto,
    corresponde,
    sugerido: { saldoAFavor: Math.max(0, diferencia), debe: Math.max(0, -diferencia) },
  };
}

export type ResultadoDeBaja = {
  /** Turnos de encuentros que todavía no pasaron, ahora cancelados */
  encuentrosCancelados: number;
  saldoAcreditado: number;
  /** Lo que queda debiendo de esta compra */
  debe: number;
};

export async function darDeBajaDeCapacitacion(
  db: Db,
  input: { trainingId: string; customerId: string; saldoAFavor?: number; debe?: number; ahora?: Date },
): Promise<ResultadoDeBaja> {
  const ahora = input.ahora ?? new Date();
  const { trainingId, customerId } = input;

  return await db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    // La compra bloqueada: dos bajas a la vez no acreditan dos veces.
    const compra = await compraViva(t, trainingId, customerId, true);
    const cuenta = await cuentaDeBaja(t, { trainingId, customerId, ahora });

    let saldoFijo: number | undefined;
    let debe = 0;
    if (cuenta.empezo) {
      const conSaldo = input.saldoAFavor !== undefined;
      const conDeuda = input.debe !== undefined;
      if (conSaldo === conDeuda) {
        throw badRequest("Indicá el saldo a favor o lo que queda debiendo, una de las dos");
      }
      if (conSaldo) {
        if (input.saldoAFavor! < 0 || input.saldoAFavor! > compra.pagado) {
          throw badRequest(`El saldo a favor va de $0 a lo que pagó ($${compra.pagado})`);
        }
        saldoFijo = input.saldoAFavor!;
      } else {
        const tope = Math.max(0, compra.precio - compra.pagado);
        if (input.debe! < 0 || input.debe! > tope) {
          throw badRequest(`Lo que queda debiendo va de $0 a lo que le falta pagar ($${tope})`);
        }
        debe = input.debe!;
      }
    }

    // Los encuentros que ya pasaron quedan como están: son historia (y la asistencia).
    const canceladas = (await t.execute(sql`
      UPDATE appointments ap SET status = 'cancelled',
             notes = coalesce(ap.notes || ' | ', '') || 'Baja de la capacitación',
             updated_at = now()
      FROM training_sessions ts
      WHERE ap.training_session_id = ts.id AND ts.training_id = ${trainingId}::uuid
        AND ap.customer_id = ${customerId}::uuid AND ap.status <> 'cancelled'
        AND ((ts.session_date + ts.start_time) AT TIME ZONE ${ZONA}) > ${ahora.toISOString()}::timestamptz
      RETURNING ap.id
    `)) as unknown as unknown[];

    if (debe > 0) {
      await t.execute(sql`
        UPDATE customer_purchase
        SET final_amount = ${compra.pagado + debe},
            notes = coalesce(notes || ' | ', '') || ${`Baja de la capacitación: queda debiendo $${debe}`},
            updated_at = now()
        WHERE id = ${compra.id}::uuid
      `);
      const marcadas = (await t.execute(sql`
        UPDATE customer_purchase_service SET consumed_at = now(), updated_at = now()
        WHERE customer_purchase_id = ${compra.id}::uuid AND consumed_at IS NULL
        RETURNING id
      `)) as unknown as unknown[];
      // Una compra vieja sin fila de servicio: se la crea ya terminada.
      if (marcadas.length === 0) {
        await t.execute(sql`
          INSERT INTO customer_purchase_service (customer_purchase_id, training_id, repeticion, orden, consumed_at)
          VALUES (${compra.id}::uuid, ${trainingId}::uuid, 1, 1, now())
        `);
      }
      return { encuentrosCancelados: canceladas.length, saldoAcreditado: 0, debe };
    }

    const motivo = cuenta.empezo ? "Baja de la capacitación ya empezada" : "Baja de la capacitación antes de empezar";
    const cancelada = await cancelCompra(t, compra.id, motivo, saldoFijo);
    return { encuentrosCancelados: canceladas.length, saldoAcreditado: cancelada?.saldoAcreditado ?? 0, debe: 0 };
  });
}
