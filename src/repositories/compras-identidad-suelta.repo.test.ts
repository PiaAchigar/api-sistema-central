import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import * as schema from "../db/schema";
import { customerPurchaseService } from "../db/schema";
import type { Db } from "../db/client";
import { createCompra, cancelCompra } from "./compras.repo";

/**
 * `ck_cpsv_identidad_unica` (1.55.0) exige EXACTAMENTE un id no nulo por fila
 * de `customer_purchase_service`. Un pack de depilación o una capacitación
 * vendidos SUELTOS (sin combo, como hasta la 1.55.0) generan filas con
 * `lineas = []`, que no traen identidad propia — tiene que salir de la
 * CABECERA de la compra. Sin ese respaldo, `createCompra` reventaba entero
 * contra el CHECK para el camino de venta más común fuera de los combos.
 */
const pgClient = postgres("postgresql://piubella:piubella@localhost:5499/piubella", {
  max: 1,
  fetch_types: false,
  prepare: false,
});
const db = drizzle(pgClient, { schema }) as unknown as Db;

let clienteId: string;
let packDepilacionId: string;

beforeAll(async () => {
  const [cli] = await db.execute<{ id: string }>("select id from customers limit 1" as never);
  const [pack] = await db.execute<{ id: string }>(
    "select id from depilation_combo where is_active = true limit 1" as never,
  );
  clienteId = cli!.id;
  packDepilacionId = pack!.id;
});

afterAll(async () => {
  await pgClient.end();
});

describe("createCompra — venta suelta de un pack de depilación", () => {
  it("2 sesiones dan 2 filas, las dos con depilation_combo_id cargado y service_id NULL", async () => {
    const compra = await createCompra(db, {
      customerId: clienteId,
      depilationComboId: packDepilacionId,
      description: "ZZ_QA_IDENTIDAD_SUELTA",
      sessionsTotal: 2,
      baseAmount: 65000,
      discountedAmount: 65000,
      finalAmount: 65000,
    });

    const filas = await db
      .select({
        serviceId: customerPurchaseService.serviceId,
        depilationComboId: customerPurchaseService.depilationComboId,
        trainingId: customerPurchaseService.trainingId,
      })
      .from(customerPurchaseService)
      .where(eq(customerPurchaseService.customerPurchaseId, compra.id));

    expect(filas).toHaveLength(2);
    for (const f of filas) {
      expect(f.depilationComboId).toBe(packDepilacionId);
      expect(f.serviceId).toBeNull();
      expect(f.trainingId).toBeNull();
    }

    await cancelCompra(db, compra.id, "limpieza de test");
  });
});
