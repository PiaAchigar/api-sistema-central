import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import * as schema from "../db/schema";
import { combos, comboService, customerPurchase, customerPurchaseService, promotions } from "../db/schema";
import type { Db } from "../db/client";
import { createCompra, cancelCompra } from "./compras.repo";
import { createPromotion, deletePromotionPermanently } from "./promotions.repo";

const pgClient = postgres("postgresql://piubella:piubella@localhost:5499/piubella", {
  max: 1,
  fetch_types: false,
  prepare: false,
});
const db = drizzle(pgClient, { schema }) as unknown as Db;

const QA = "ZZ_QA_PAQUETE";
let clienteId: string;
let servicioId: string;
let comboId: string;
let promoId: string;

async function limpiar() {
  const promos = await db.select({ id: promotions.id }).from(promotions).where(eq(promotions.name, QA));
  for (const p of promos) await deletePromotionPermanently(db, p.id);
  const viejos = await db.select({ id: combos.id }).from(combos).where(eq(combos.name, QA));
  for (const c of viejos) {
    await db.delete(comboService).where(eq(comboService.comboId, c.id));
    await db.delete(combos).where(eq(combos.id, c.id));
  }
}

beforeAll(async () => {
  await limpiar();
  const [cli] = await db.execute<{ id: string }>("select id from customers limit 1" as never);
  const [srv] = await db.execute<{ id: string }>(
    "select id from service where is_active = true and unit_price_list > 0 limit 1" as never,
  );
  const [area] = await db.execute<{ id: string }>(
    "select id from categories where kind = 'area' limit 1" as never,
  );
  clienteId = cli!.id;
  servicioId = srv!.id;

  const [combo] = await db
    .insert(combos)
    .values({ name: QA, priceType: "fixed", fixedPrice: "80000", validityMonths: 12,
             isActive: true, isVisibleWeb: false, areaCategoryId: area!.id })
    .returning({ id: combos.id });
  comboId = combo!.id;
  await db.insert(comboService).values({
    comboId, serviceId: servicioId, sessionsIncluded: 1, servicePrice: "80000",
  });

  const promo = await createPromotion(
    db,
    { name: QA, promotionType: "paquete", precioDelPaquete: 250000 },
    [{ tipo: "combo", id: comboId, cantidad: 1 }, { tipo: "servicio", id: servicioId, cantidad: 3 }],
    [],
  );
  promoId = promo!.id;
});

afterAll(async () => {
  await limpiar();
  await pgClient.end();
});

describe("createCompra — el paquete", () => {
  it("crea UNA compra sin ningún origen suelto", async () => {
    const compra = await createCompra(db, {
      customerId: clienteId,
      esPaquete: true,
      promotionId: promoId,
      promotionName: QA,
      description: QA,
      sessionsTotal: 1,
      baseAmount: 335000,
      discountedAmount: 250000,
      finalAmount: 250000,
    });
    expect(compra.comboId).toBeNull();
    expect(compra.serviceId).toBeNull();

    const [fila] = await db
      .select({ es: customerPurchase.esPaqueteDePromo })
      .from(customerPurchase)
      .where(eq(customerPurchase.id, compra.id));
    expect(fila!.es).toBe(true);
    await cancelCompra(db, compra.id, "limpieza de test");
  });

  it("desglosa el paquete en una línea por cosa: 1 del combo + 3 del servicio", async () => {
    const compra = await createCompra(db, {
      customerId: clienteId, esPaquete: true, promotionId: promoId, promotionName: QA,
      description: QA, sessionsTotal: 1, baseAmount: 335000, discountedAmount: 250000, finalAmount: 250000,
    });
    const lineas = await db
      .select({ id: customerPurchaseService.id, price: customerPurchaseService.price })
      .from(customerPurchaseService)
      .where(eq(customerPurchaseService.customerPurchaseId, compra.id));
    expect(lineas).toHaveLength(4);
    await cancelCompra(db, compra.id, "limpieza de test");
  });

  it("las partes suman EXACTAMENTE el precio del paquete", async () => {
    // Si no sumara, cancelar le acreditaría a la clienta de más o de menos.
    const compra = await createCompra(db, {
      customerId: clienteId, esPaquete: true, promotionId: promoId, promotionName: QA,
      description: QA, sessionsTotal: 1, baseAmount: 335000, discountedAmount: 250000, finalAmount: 250000,
    });
    const lineas = await db
      .select({ price: customerPurchaseService.price })
      .from(customerPurchaseService)
      .where(eq(customerPurchaseService.customerPurchaseId, compra.id));
    const suma = lineas.reduce((a, l) => a + Number(l.price ?? 0), 0);
    expect(suma).toBe(250000);
    await cancelCompra(db, compra.id, "limpieza de test");
  });

  it("un paquete con un origen suelto NO se vende", async () => {
    // El CHECK de la base lo rechazaría igual, pero un error de Postgres crudo
    // no le dice nada a quien está vendiendo.
    await expect(
      createCompra(db, {
        customerId: clienteId, esPaquete: true, promotionId: promoId, promotionName: QA,
        comboId, description: QA, sessionsTotal: 1,
        baseAmount: 1, discountedAmount: 1, finalAmount: 1,
      }),
    ).rejects.toThrow(/paquete/i);
  });

  it("un paquete SIN promo no se vende: sin promo no hay qué desglosar", async () => {
    await expect(
      createCompra(db, {
        customerId: clienteId, esPaquete: true, description: QA, sessionsTotal: 1,
        baseAmount: 1, discountedAmount: 1, finalAmount: 1,
      }),
    ).rejects.toThrow(/promo/i);
  });
});
