import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq, like, notLike } from "drizzle-orm";
import * as schema from "../db/schema";
import { bodyZone, depilationCombo, promotions } from "../db/schema";
import type { Db } from "../db/client";
import { obtenerPromoVendible, preciosDeListaDe } from "./catalogo-venta.repo";
import { cotizarPaquete } from "../lib/cotizacion-de-paquete";
import { crearCombo, hardDeleteCombo } from "./depilacion.repo";
import { createPromotion, deletePromotionPermanently } from "./promotions.repo";

/**
 * Task 7 (concern de la coordinadora): un pack de depilación `guardado` no
 * tiene `fixed_price` propio (CHECK `ck_dc_precio_guardado` lo garantiza
 * NULL) — se cotiza con la fórmula sobre zonas, un camino que la VENTA de un
 * paquete no usa nunca (`lineasDeUnPaquete` en `compras.repo.ts` sólo lee
 * `depilation_combo.fixed_price` y rechaza si es NULL). `preciosDeListaDe`
 * tiene que fallar de la misma forma, ANTES de la venta: cotizar con la
 * fórmula prometería un precio que confirmar la compra después niega.
 */
const pgClient = postgres("postgresql://piubella:piubella@localhost:5499/piubella", {
  max: 1,
  fetch_types: false,
  prepare: false,
});
const db = drizzle(pgClient, { schema }) as unknown as Db;

const QA = "ZZ_QA_CATALOGO_VENTA";

let zonaId: string;
let packFijoId: string;
let packGuardadoId: string;
let promoPackFijoId: string;
let promoPackGuardadoId: string;

async function limpiar() {
  const promos = await db.select({ id: promotions.id }).from(promotions).where(like(promotions.name, `${QA}%`));
  for (const p of promos) await deletePromotionPermanently(db, p.id);

  const combosQa = await db
    .select({ id: depilationCombo.id })
    .from(depilationCombo)
    .where(like(depilationCombo.name, `${QA}%`));
  for (const c of combosQa) await hardDeleteCombo(db, c.id);
}

beforeAll(async () => {
  await limpiar();

  // Una zona real, activa, que NO sea de un fixture QA de otra suite: un
  // `select ... limit 1` sin este filtro agarró una vez un fixture QA vivo
  // de otro archivo en una corrida anterior de la suite entera.
  const [zona] = await db
    .select({ id: bodyZone.id })
    .from(bodyZone)
    .where(notLike(bodyZone.name, "ZZ_QA%"))
    .orderBy(bodyZone.name)
    .limit(1);
  zonaId = zona!.id;

  // Regresión: un pack_fijo CON fixed_price cargado — tiene que seguir
  // cotizando exactamente igual que antes de este fix.
  const packFijo = await crearCombo(db, {
    name: `${QA}_PACK_FIJO`,
    kind: "pack_fijo",
    fixedPrice: 65000,
    zonaIds: [zonaId],
  });
  packFijoId = packFijo!.id;

  // El caso nuevo: un guardado, sin fixed_price (el CHECK de la base lo
  // exige NULL para este kind).
  const packGuardado = await crearCombo(db, {
    name: `${QA}_PACK_GUARDADO`,
    kind: "guardado",
    zonaIds: [zonaId],
  });
  packGuardadoId = packGuardado!.id;

  const promoPackFijo = await createPromotion(
    db,
    { name: `${QA}_PROMO_PACK_FIJO`, promotionType: "paquete", precioDelPaquete: 50000 },
    [{ tipo: "depilacion", id: packFijoId, cantidad: 1 }],
    [],
  );
  promoPackFijoId = promoPackFijo!.id;

  const promoPackGuardado = await createPromotion(
    db,
    { name: `${QA}_PROMO_PACK_GUARDADO`, promotionType: "paquete", precioDelPaquete: 50000 },
    [{ tipo: "depilacion", id: packGuardadoId, cantidad: 1 }],
    [],
  );
  promoPackGuardadoId = promoPackGuardado!.id;
});

afterAll(async () => {
  await limpiar();
  await pgClient.end();
});

describe("preciosDeListaDe — depilación pesa igual que la venta", () => {
  it("un pack_fijo con fixed_price cargado cotiza con ESE precio, sin tocar la fórmula", async () => {
    const promo = await obtenerPromoVendible(db, promoPackFijoId);
    const catalogo = await preciosDeListaDe(db, promo!.destinos);
    expect(catalogo.precios.get(packFijoId)).toBe(65000);

    const q = cotizarPaquete(promo!, catalogo, new Date());
    expect(q.baseAmount).toBe(65000);
    expect(q.finalAmount).toBe(50000);
  });

  it("un pack guardado (sin fixed_price) no resuelve precio: cotizarPaquete lo rechaza nombrándolo", async () => {
    const promo = await obtenerPromoVendible(db, promoPackGuardadoId);
    const catalogo = await preciosDeListaDe(db, promo!.destinos);
    // No lo resuelve — ni siquiera con la fórmula sobre zonas: sería un
    // precio que la venta real del paquete nunca usa.
    expect(catalogo.precios.has(packGuardadoId)).toBe(false);

    // NOMBRÁNDOLO, que es lo que dice el título y lo que el readme promete.
    // Este test antes exigía el UUID —cementaba el bug que decía arreglar—:
    // Laura leía "No se pudo resolver el precio de: 0d3e1a7c-…" y tenía que
    // ir a la promo a adivinar cuál de las cosas que tildó era esa.
    let mensaje = "";
    try {
      cotizarPaquete(promo!, catalogo, new Date());
    } catch (e) {
      mensaje = (e as Error).message;
    }
    expect(mensaje).toContain(`${QA}_PACK_GUARDADO`);
    expect(mensaje).not.toContain(packGuardadoId);
  });
});
