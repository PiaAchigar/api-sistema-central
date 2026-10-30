import { eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { combos, comboService, priceAdjustmentItems, priceAdjustments, service } from "../db/schema";
import { AppError, badRequest } from "../lib/errors";
import { calcularFila, type Ajuste, type EstadoFila } from "../lib/ajuste-de-precios";

// Simular y aplicar el ajuste de precios en bloque sobre una rama de categorías.
// La cuenta vive en lib/ajuste-de-precios.ts; acá sólo se lee, se compara y se guarda.

export type FilaSimulada = {
  id: string;
  nombre: string;
  listaAntes: number | null;
  listaDespues: number | null;
  efectivoAntes: number | null;
  efectivoDespues: number | null;
  estado: EstadoFila;
};

/** `kind` distingue combo de pack (columna `combos.kind`); los packs también congelan
 *  `combo_service.service_price`, por eso entran al aviso. */
export type ComboAfectado = { id: string; nombre: string; areaId: string | null; kind: "combo" | "pack" };

export type ServicioAAplicar = { id: string; listaVista: number | null; efectivoVista: number | null };

/** 409 que lleva los ids con precio desactualizado. La ruta responde
 *  `{ error: err.message, conflictos: err.conflictos }`. */
export class ConflictoDePrecios extends AppError {
  constructor(public readonly conflictos: string[]) {
    super(409, "Los precios cambiaron mientras mirabas la simulación. Volvé a simular.");
    this.name = "ConflictoDePrecios";
  }
}

const num = (v: string | null): number | null => (v === null ? null : Number(v));
const money = (v: number | null): string | null => (v === null ? null : v.toFixed(2));

// Ids de los servicios vendibles y activos de la categoría y todas sus
// descendientes. DISTINCT: un servicio en dos categorías de la rama cuenta una vez.
async function idsDeLaRama(db: Db, categoryId: string): Promise<string[]> {
  const rows = await db.execute(sql`
    WITH RECURSIVE rama AS (
      SELECT id FROM categories WHERE id = ${categoryId}
      UNION
      SELECT c.id FROM categories c JOIN rama r ON c.parent_category_id = r.id
    )
    SELECT DISTINCT s.id
    FROM service s
    JOIN service_category sc ON sc.service_id = s.id
    WHERE sc.category_id IN (SELECT id FROM rama)
      AND s.is_active = true
      AND COALESCE(s.no_vendible, false) = false
  `);
  return (rows as unknown as { id: string }[]).map((r) => r.id);
}

export async function simularAjuste(
  db: Db,
  p: { categoryId: string; ajuste: Ajuste },
): Promise<{ servicios: FilaSimulada[]; combos: ComboAfectado[] }> {
  const ids = await idsDeLaRama(db, p.categoryId);
  if (ids.length === 0) return { servicios: [], combos: [] };

  const filas = await db
    .select({ id: service.id, name: service.name, lista: service.unitPriceList, efectivo: service.unitPriceCash })
    .from(service)
    .where(inArray(service.id, ids))
    .orderBy(service.name);

  const servicios = filas.map((f): FilaSimulada => {
    const listaAntes = num(f.lista);
    const efectivoAntes = num(f.efectivo);
    const r = calcularFila(listaAntes, efectivoAntes, p.ajuste);
    return { id: f.id, nombre: f.name ?? "", listaAntes, efectivoAntes, ...r };
  });

  const cs = await db
    .selectDistinct({ id: combos.id, name: combos.name, areaId: combos.areaCategoryId, kind: combos.kind })
    .from(combos)
    .innerJoin(comboService, eq(comboService.comboId, combos.id))
    .where(sql`${combos.isActive} = true AND ${inArray(comboService.serviceId, ids)}`)
    .orderBy(combos.name);

  return { servicios, combos: cs.map((c) => ({ id: c.id, nombre: c.name ?? "", areaId: c.areaId, kind: c.kind === "pack" ? "pack" : "combo" })) };
}

export async function aplicarAjuste(
  db: Db,
  p: {
    categoryId: string;
    ajuste: Ajuste;
    servicios: ServicioAAplicar[];
    usuario: { id: string | null; email: string | null };
  },
): Promise<{ ajusteId: string; aplicados: number }> {
  const pedidos = p.servicios;
  if (pedidos.length === 0) throw badRequest("No hay servicios para ajustar");
  const pedidosIds = pedidos.map((s) => s.id);
  if (new Set(pedidosIds).size !== pedidosIds.length) throw badRequest("Hay servicios repetidos");

  return db.transaction(async (tx) => {
    const txDb = tx as unknown as Db;
    const enRama = new Set(await idsDeLaRama(txDb, p.categoryId));
    if (pedidosIds.some((i) => !enRama.has(i))) {
      throw badRequest("Hay servicios que no pertenecen a la categoría elegida");
    }

    // Los precios se releen bajo lock: nadie los cambia entre la comparación y el UPDATE.
    const actuales = await tx
      .select({ id: service.id, lista: service.unitPriceList, efectivo: service.unitPriceCash })
      .from(service)
      .where(inArray(service.id, pedidosIds))
      .for("update");
    const porId = new Map(actuales.map((a) => [a.id, a]));

    const conflictos = pedidos
      .filter((s) => {
        const a = porId.get(s.id);
        return !a || num(a.lista) !== s.listaVista || num(a.efectivo) !== s.efectivoVista;
      })
      .map((s) => s.id);
    if (conflictos.length > 0) throw new ConflictoDePrecios(conflictos);

    const calculados = pedidos.map((s) => {
      const a = porId.get(s.id)!;
      const listaAntes = num(a.lista);
      const efectivoAntes = num(a.efectivo);
      return { id: s.id, listaAntes, efectivoAntes, ...calcularFila(listaAntes, efectivoAntes, p.ajuste) };
    });
    if (calculados.some((c) => c.estado === "invalido" || c.estado === "sin_precio")) {
      throw badRequest("Hay servicios sin precio o que quedarían en 0 o menos");
    }

    const [cab] = await tx
      .insert(priceAdjustments)
      .values({
        userId: p.usuario.id,
        userEmail: p.usuario.email,
        categoryId: p.categoryId,
        direction: p.ajuste.direccion,
        mode: p.ajuste.modo,
        value: money(p.ajuste.valor)!,
        rounding: p.ajuste.redondeo,
        servicesCount: calculados.length,
      })
      .returning({ id: priceAdjustments.id });
    if (!cab) throw new Error("No se pudo guardar el historial");

    for (const c of calculados) {
      await tx
        .update(service)
        .set({
          unitPriceList: money(c.listaDespues),
          // Sin efectivo (null o 0) no se escribe: queda como estaba.
          ...(c.efectivoDespues !== null ? { unitPriceCash: money(c.efectivoDespues) } : {}),
          updatedAt: new Date(),
        })
        .where(eq(service.id, c.id));
    }

    await tx.insert(priceAdjustmentItems).values(
      calculados.map((c) => ({
        adjustmentId: cab.id,
        serviceId: c.id,
        listBefore: money(c.listaAntes),
        listAfter: money(c.listaDespues),
        cashBefore: money(c.efectivoAntes),
        // Si el efectivo no se tocó, "después" es lo que ya había.
        cashAfter: money(c.efectivoDespues ?? c.efectivoAntes),
      })),
    );

    return { ajusteId: cab.id, aplicados: calculados.length };
  });
}
