import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq, inArray, like } from "drizzle-orm";
import * as schema from "../db/schema";
import {
  areaPackPolicy,
  categories,
  combos,
  comboService,
  customerPurchase,
  customerPurchaseService,
  service,
} from "../db/schema";
import type { Db } from "../db/client";
import { createCombo, deleteComboPermanently, getComboById, updateCombo } from "./combos.repo";
import { createCompra, listComprasDeCliente } from "./compras.repo";

/**
 * #36 — "La última sesión es retoque": no se cobra, y la última sesión de lo
 * comprado lo dice. Cada test arma su propia área, tarifario y servicio: no
 * depende de la config que Laura edita.
 */
const pgClient = postgres("postgresql://piubella:piubella@localhost:5499/piubella", {
  max: 1,
  fetch_types: false,
  prepare: false,
});
const db = drizzle(pgClient, { schema }) as unknown as Db;
const QA = "ZZ_QA_RETOQUE";

let areaId: string;
let sBotox: string; // lista 10000 / efectivo 9000
let clienteId: string;

async function limpiar() {
  const compras = await db.select({ id: customerPurchase.id }).from(customerPurchase)
    .where(like(customerPurchase.description, `${QA}%`));
  for (const c of compras) {
    await db.delete(customerPurchaseService).where(eq(customerPurchaseService.customerPurchaseId, c.id));
    await db.delete(customerPurchase).where(eq(customerPurchase.id, c.id));
  }
  const cs = await db.select({ id: combos.id }).from(combos).where(like(combos.name, `${QA}%`));
  for (const c of cs) await db.delete(comboService).where(eq(comboService.comboId, c.id));
  await db.delete(combos).where(like(combos.name, `${QA}%`));
  await db.delete(service).where(like(service.name, `${QA}%`));
  const areas = await db.select({ id: categories.id }).from(categories).where(like(categories.name, `${QA}%`));
  if (areas.length) {
    await db.delete(areaPackPolicy).where(inArray(areaPackPolicy.areaCategoryId, areas.map((a) => a.id)));
    await db.delete(categories).where(like(categories.name, `${QA}%`));
  }
}

beforeAll(async () => {
  await limpiar();
  const [area] = await db.insert(categories)
    .values({ name: `${QA}_AREA`, kind: "area", isActive: true, displayOrder: 0 })
    .returning({ id: categories.id });
  areaId = area!.id;
  // 10% de descuento, redondeo a $100.
  await db.insert(areaPackPolicy).values({
    areaCategoryId: areaId, packSessions: 2, packDiscountPercentage: 10, packRoundingBase: 100,
  });
  const [s] = await db.insert(service)
    .values({ name: `${QA}_BOTOX`, isActive: true, unitPriceList: "10000", unitPriceCash: "9000" })
    .returning({ id: service.id });
  sBotox = s!.id;
  const [cli] = await db.execute<{ id: string }>(
    "select id from customers limit 1" as never,
  );
  clienteId = cli!.id;
});

afterAll(async () => {
  await limpiar();
  await pgClient.end();
});

const header = (extra: Record<string, unknown>) =>
  ({
    priceType: "percentage", discountPercentage: 0, areaCategoryId: areaId, validityWeeks: 52,
    kind: "pack", ...extra,
  }) as never;
const lineaBotox = () => [{ serviceId: sBotox, sessionsIncluded: 1 }];

describe("precio de un pack con retoque: el retoque no se cobra", () => {
  it("pack de 2 con retoque cuesta UNA sesión, con el descuento del pack", async () => {
    const p = await createCombo(
      db, header({ name: `${QA}_P2`, packSessions: 2, lastSessionIsTouchup: true }), lineaBotox());
    expect(p!.finalAmount).toBe(9000); // 10000 × 1 × 0,9
    expect(p!.finalAmountCash).toBe(8100); // 9000 × 1 × 0,9
    expect((p as any).lastSessionIsTouchup).toBe(true);
    // Se entrega igual el pack entero: 2 sesiones.
    expect((p as any).packEffectiveSessions).toBe(2);
    expect((p as any).packChargedSessions).toBe(1);
  });

  it("pack de 4 con retoque cobra 3", async () => {
    const p = await createCombo(
      db, header({ name: `${QA}_P4`, packSessions: 4, lastSessionIsTouchup: true }), lineaBotox());
    expect(p!.finalAmount).toBe(27000); // 10000 × 3 × 0,9
  });

  it("sin la tilde cobra todas, como siempre", async () => {
    const p = await createCombo(db, header({ name: `${QA}_P2_SIN`, packSessions: 2 }), lineaBotox());
    expect(p!.finalAmount).toBe(18000); // 10000 × 2 × 0,9
    expect((p as any).lastSessionIsTouchup).toBe(false);
    expect((p as any).packChargedSessions).toBe(2);
  });

  it("se puede tildar y destildar editando el pack", async () => {
    const p = await createCombo(db, header({ name: `${QA}_P2_EDIT`, packSessions: 2 }), lineaBotox());
    const con = await updateCombo(db, p!.id, { ...(header({ name: `${QA}_P2_EDIT` }) as object), lastSessionIsTouchup: true } as never);
    expect(con!.finalAmount).toBe(9000);
    const sin = await updateCombo(db, p!.id, { ...(header({ name: `${QA}_P2_EDIT` }) as object), lastSessionIsTouchup: false } as never);
    expect(sin!.finalAmount).toBe(18000);
    const leido = await getComboById(db, p!.id);
    expect((leido as any).lastSessionIsTouchup).toBe(false);
  });

  it("un combo (no pack) ignora la tilde: no hay retoque en un combo", async () => {
    const c = await createCombo(
      db, header({ name: `${QA}_COMBO`, kind: "combo", lastSessionIsTouchup: true }), lineaBotox());
    expect((c as any).lastSessionIsTouchup).toBe(false);
  });
});

describe("la compra de un pack con retoque marca la última sesión", () => {
  it("sólo la sesión N (y no las anteriores) viene con esRetoque", async () => {
    const p = await createCombo(
      db, header({ name: `${QA}_P3_COMPRA`, packSessions: 3, lastSessionIsTouchup: true }), lineaBotox());
    const compra = await createCompra(db, {
      customerId: clienteId, comboId: p!.id, description: `${QA}_COMPRA`, sessionsTotal: 3,
      baseAmount: 30000, discountedAmount: p!.finalAmount, finalAmount: p!.finalAmount,
    });
    const lista = await listComprasDeCliente(db, clienteId);
    const mia = lista.find((c) => c.id === compra.id)!;
    expect((mia as any).ultimaSesionEsRetoque).toBe(true);
    const marcas = mia.servicios
      .slice()
      .sort((a, b) => (a.repeticion ?? 0) - (b.repeticion ?? 0))
      .map((s) => [s.repeticion, (s as any).esRetoque]);
    expect(marcas).toEqual([[1, false], [2, false], [3, true]]);
  });

  it("un pack sin la tilde no marca ninguna", async () => {
    const p = await createCombo(db, header({ name: `${QA}_P2_NORMAL`, packSessions: 2 }), lineaBotox());
    const compra = await createCompra(db, {
      customerId: clienteId, comboId: p!.id, description: `${QA}_COMPRA_NORMAL`, sessionsTotal: 2,
      baseAmount: 20000, discountedAmount: p!.finalAmount, finalAmount: p!.finalAmount,
    });
    const mia = (await listComprasDeCliente(db, clienteId)).find((c) => c.id === compra.id)!;
    expect((mia as any).ultimaSesionEsRetoque).toBe(false);
    expect(mia.servicios.every((s) => (s as any).esRetoque === false)).toBe(true);
  });
});
