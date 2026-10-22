import { and, asc, eq, isNotNull } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  combos,
  customerPurchase,
  depilationCombo,
  promotions,
  promotionTarget,
} from "../db/schema";
import { comboDelQueSalenLosServicios } from "../lib/servicios-comprados";
import { leerDiasEntreSesiones } from "./depilacion.repo";

// Los días sugeridos entre sesiones de una compra (spec 2026-10-22-planificador-de-la-compra).

/** Lo que se sugiere cuando nadie cargó los días. */
const DIAS_POR_DEFECTO = 30;

export type IntervaloDeLaCompra = { dias: number; cargado: boolean };

/** Los días propios de un combo o pack; si es un pack sin días, los de su combo. */
async function diasDeUnCombo(db: Db, comboId: string): Promise<number | null> {
  const [c] = await db
    .select({ dias: combos.sessionIntervalDays, kind: combos.kind, packOf: combos.packOfComboId })
    .from(combos)
    .where(eq(combos.id, comboId))
    .limit(1);
  if (!c) return null;
  if (c.dias != null) return c.dias;
  const origen = comboDelQueSalenLosServicios(c.kind, c.packOf, comboId);
  if (origen === comboId) return null;
  const [o] = await db
    .select({ dias: combos.sessionIntervalDays })
    .from(combos)
    .where(eq(combos.id, origen))
    .limit(1);
  return o?.dias ?? null;
}

/**
 * Los días propios de una promo; si no tiene, los del primer combo o pack de
 * adentro que los tenga. "Primero" = por `created_at` de `promotion_target` y,
 * a igual fecha, por `id`: así el resultado no depende del orden en que
 * Postgres devuelva las filas.
 */
async function diasDeUnaPromo(db: Db, promocionId: string): Promise<number | null> {
  const [p] = await db
    .select({ dias: promotions.sessionIntervalDays })
    .from(promotions)
    .where(eq(promotions.id, promocionId))
    .limit(1);
  if (p?.dias != null) return p.dias;
  const destinos = await db
    .select({ comboId: promotionTarget.comboId })
    .from(promotionTarget)
    .where(and(eq(promotionTarget.promotionId, promocionId), isNotNull(promotionTarget.comboId)))
    .orderBy(asc(promotionTarget.createdAt), asc(promotionTarget.id));
  for (const d of destinos) {
    const dias = await diasDeUnCombo(db, d.comboId!);
    if (dias != null) return dias;
  }
  return null;
}

/**
 * Cada cuántos días se sugiere la siguiente sesión de una compra. Orden: lo
 * propio de lo que se compró → (pack de combo) el de su combo → (promo) el del
 * primer combo o pack de adentro que lo tenga → (depilación) el de
 * `depilation_pricing_config` → 30 con `cargado: false`, para que la pantalla
 * avise que es un número supuesto.
 */
export async function intervaloDeLaCompra(db: Db, compraId: string): Promise<IntervaloDeLaCompra> {
  const [c] = await db
    .select({
      comboId: customerPurchase.comboId,
      depilacionId: customerPurchase.depilationComboId,
      promocionId: customerPurchase.promotionId,
    })
    .from(customerPurchase)
    .where(eq(customerPurchase.id, compraId))
    .limit(1);

  let dias: number | null = null;
  if (c?.comboId) dias = await diasDeUnCombo(db, c.comboId);
  if (dias == null && c?.promocionId) dias = await diasDeUnaPromo(db, c.promocionId);
  if (dias == null && c?.depilacionId) {
    const [d] = await db
      .select({ dias: depilationCombo.sessionIntervalDays })
      .from(depilationCombo)
      .where(eq(depilationCombo.id, c.depilacionId))
      .limit(1);
    dias = d?.dias ?? (await leerDiasEntreSesiones(db));
  }
  return dias != null ? { dias, cargado: true } : { dias: DIAS_POR_DEFECTO, cargado: false };
}
