import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq, like } from "drizzle-orm";
import * as schema from "../db/schema";
import { customerPurchase, promotions } from "../db/schema";
import type { Db } from "../db/client";
import { cancelCompra, createCompra } from "./compras.repo";

/**
 * El cupo de una promo (`usage_limit`) se controlaba en la RUTA, antes de
 * `createCompra` y fuera de su transacción: leer cuántas ventas quedan e
 * insertar eran dos pasos sueltos. Dos ventas simultáneas con el cupo en N−1
 * leían "queda una" y pasaban las dos. Ahora `createCompra` bloquea la fila de
 * la promo y cuenta adentro de la misma transacción que inserta.
 *
 * Pool de 4 conexiones (y no de 1 como el resto de los tests de repos): con
 * una sola, las dos ventas "simultáneas" se harían en fila y el test no
 * probaría nada.
 */
const pgClient = postgres("postgresql://piubella:piubella@localhost:5499/piubella", {
  max: 4,
  fetch_types: false,
  prepare: false,
});
const db = drizzle(pgClient, { schema }) as unknown as Db;

const QA = "ZZ_QA_CUPO_PROMO";
let clienteId: string;
let packDepilacionId: string;
let promoId: string;

async function limpiar() {
  await db.delete(customerPurchase).where(like(customerPurchase.description, `${QA}%`));
  await db.delete(promotions).where(like(promotions.name, `${QA}%`));
}

beforeAll(async () => {
  await limpiar();
  const [cli] = await db.execute<{ id: string }>("select id from customers limit 1" as never);
  const [pack] = await db.execute<{ id: string }>(
    "select id from depilation_combo where is_active = true and name not like 'ZZ_QA%' order by id limit 1" as never,
  );
  clienteId = cli!.id;
  packDepilacionId = pack!.id;
});

beforeEach(async () => {
  await limpiar();
  const [p] = await db
    .insert(promotions)
    .values({
      name: `${QA}_UNA_SOLA`,
      promotionType: "percentage",
      discountPercentage: "20",
      status: "active",
      usageLimit: 1,
    })
    .returning({ id: promotions.id });
  promoId = p!.id;
});

afterAll(async () => {
  await limpiar();
  await pgClient.end();
});

function vender() {
  return createCompra(db, {
    customerId: clienteId,
    depilationComboId: packDepilacionId,
    description: `${QA}_VENTA`,
    sessionsTotal: 1,
    baseAmount: 10000,
    discountedAmount: 8000,
    finalAmount: 8000,
    promotionId: promoId,
  });
}

describe("createCompra — el cupo de la promo se controla dentro de la venta", () => {
  it("con el cupo agotado, la venta se rechaza y no se crea nada", async () => {
    await vender();
    await expect(vender()).rejects.toThrow(/se agotó/i);
    const ventas = await db
      .select({ id: customerPurchase.id })
      .from(customerPurchase)
      .where(eq(customerPurchase.promotionId, promoId));
    expect(ventas).toHaveLength(1);
  });

  it("dos ventas AL MISMO TIEMPO con un solo uso libre: pasa una sola", async () => {
    const resultados = await Promise.allSettled([vender(), vender(), vender()]);
    const ok = resultados.filter((r) => r.status === "fulfilled");
    const rechazadas = resultados.filter((r) => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(rechazadas).toHaveLength(2);
    for (const r of rechazadas) {
      expect(String((r as PromiseRejectedResult).reason)).toMatch(/se agotó/i);
    }
  });

  it("cancelar una venta libera el uso", async () => {
    const primera = await vender();
    await cancelCompra(db, primera.id, "test");
    await expect(vender()).resolves.toBeTruthy();
  });

  it("una promo sin límite no frena nada", async () => {
    await db.update(promotions).set({ usageLimit: null }).where(eq(promotions.id, promoId));
    await vender();
    await vender();
    await expect(vender()).resolves.toBeTruthy();
  });
});
