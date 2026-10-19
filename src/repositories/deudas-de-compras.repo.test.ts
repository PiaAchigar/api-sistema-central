import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq, inArray, like } from "drizzle-orm";
import * as schema from "../db/schema";
import { customerPurchase, payments, service } from "../db/schema";
import type { Db } from "../db/client";
import { getDeudasDeCompras } from "./compras.repo";

/** `getDeudasDeCompras` contra la base local: final_amount menos pagos confirmados. */
const pgClient = postgres("postgresql://piubella:piubella@localhost:5499/piubella", {
  max: 1,
  fetch_types: false,
  prepare: false,
});
const db = drizzle(pgClient, { schema }) as unknown as Db;

const QA = "ZZ_QA_DEUDA";

let clienteId: string;
let servicioId: string;

async function limpiar() {
  const compras = await db
    .select({ id: customerPurchase.id })
    .from(customerPurchase)
    .where(like(customerPurchase.description, `${QA}%`));
  if (compras.length === 0) return;
  const ids = compras.map((c) => c.id);
  await db.delete(payments).where(inArray(payments.customerPurchaseId, ids));
  await db.delete(customerPurchase).where(inArray(customerPurchase.id, ids));
}

async function limpiarServicio() {
  await db.delete(service).where(like(service.name, `${QA}%`));
}

async function compra(nombre: string, opts: { cancelada?: boolean } = {}) {
  const [c] = await db
    .insert(customerPurchase)
    .values({
      customerId: clienteId,
      serviceId: servicioId,
      description: `${QA}_${nombre}`,
      sessionsTotal: 1,
      baseAmount: "10000",
      discountedAmount: "10000",
      finalAmount: "10000",
      cancelledAt: opts.cancelada ? new Date() : null,
    })
    .returning({ id: customerPurchase.id });
  return c!.id;
}

async function pago(compraId: string, amount: string, status = "confirmed") {
  await db.insert(payments).values({ customerPurchaseId: compraId, customerId: clienteId, amount, status });
}

beforeAll(async () => {
  await limpiar();
  await limpiarServicio();
  const [srv] = await db
    .insert(service)
    .values({ name: `${QA}_SERVICIO`, isActive: true, unitPriceList: "10000" })
    .returning({ id: service.id });
  servicioId = srv!.id;
  const [cli] = await db.execute<{ id: string }>("select id from customers limit 1" as never);
  clienteId = cli!.id;
});

afterAll(async () => {
  await limpiar();
  await limpiarServicio();
  await pgClient.end();
});

describe("getDeudasDeCompras", () => {
  it("resta lo confirmado del total", async () => {
    const id = await compra("PARCIAL");
    await pago(id, "4000");
    expect((await getDeudasDeCompras(db, [id])).get(id)).toBe(6000);
  });

  it("da 0 si está paga entera", async () => {
    const id = await compra("PAGA");
    await pago(id, "10000");
    expect((await getDeudasDeCompras(db, [id])).get(id)).toBe(0);
  });

  it("no incluye las canceladas", async () => {
    const id = await compra("CANCELADA", { cancelada: true });
    expect((await getDeudasDeCompras(db, [id])).has(id)).toBe(false);
  });

  it("ignora los pagos que no están confirmados", async () => {
    const id = await compra("PENDIENTE");
    await pago(id, "4000");
    await pago(id, "3000", "pending");
    await pago(id, "2000", "failed");
    expect((await getDeudasDeCompras(db, [id])).get(id)).toBe(6000);
  });

  it("sin ids devuelve un mapa vacío sin tocar la base", async () => {
    const mapa = await getDeudasDeCompras({} as Db, []);
    expect(mapa.size).toBe(0);
  });
});
