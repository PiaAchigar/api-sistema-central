import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq, inArray, like } from "drizzle-orm";
import * as schema from "../db/schema";
import {
  appointments, areaPackPolicy, categories, combos, comboService,
  customerPurchase, customerPurchaseService, service,
} from "../db/schema";
import type { Db } from "../db/client";
import { createCombo } from "./combos.repo";
import { createCompra } from "./compras.repo";
import { getAppointmentDetail, listAppointmentsByRange } from "./appointments.repo";

/** #36 — El turno que es la última sesión de un pack con retoque viene con esRetoque. */
const pgClient = postgres("postgresql://piubella:piubella@localhost:5499/piubella", {
  max: 1, fetch_types: false, prepare: false,
});
const db = drizzle(pgClient, { schema }) as unknown as Db;
const QA = "ZZ_QA_TURNO_RETOQUE";
const DIA = new Date("2031-03-10T12:00:00Z");
let areaId: string;
let sBotox: string;
let clienteId: string;
const turnos: string[] = [];

async function limpiar() {
  const compras = await db.select({ id: customerPurchase.id }).from(customerPurchase)
    .where(like(customerPurchase.description, `${QA}%`));
  for (const c of compras) {
    await db.delete(customerPurchaseService).where(eq(customerPurchaseService.customerPurchaseId, c.id));
    await db.delete(customerPurchase).where(eq(customerPurchase.id, c.id));
  }
  await db.delete(appointments).where(like(appointments.notes, `${QA}%`));
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
  await db.insert(areaPackPolicy).values({
    areaCategoryId: areaId, packSessions: 2, packDiscountPercentage: 10, packRoundingBase: 100,
  });
  const [s] = await db.insert(service)
    .values({ name: `${QA}_BOTOX`, isActive: true, unitPriceList: "10000", unitPriceCash: "9000" })
    .returning({ id: service.id });
  sBotox = s!.id;
  const [cli] = await db.execute<{ id: string }>("select id from customers limit 1" as never);
  clienteId = cli!.id;
});
afterAll(async () => { await limpiar(); await pgClient.end(); });

async function comprarYAgendar(nombre: string, conRetoque: boolean) {
  const p = await createCombo(db, {
    name: `${QA}_${nombre}`, priceType: "percentage", discountPercentage: 0, areaCategoryId: areaId,
    validityWeeks: 52, kind: "pack", packSessions: 2, lastSessionIsTouchup: conRetoque,
  } as never, [{ serviceId: sBotox, sessionsIncluded: 1 }]);
  const compra = await createCompra(db, {
    customerId: clienteId, comboId: p!.id, description: `${QA}_C_${nombre}`, sessionsTotal: 2,
    baseAmount: 20000, discountedAmount: p!.finalAmount, finalAmount: p!.finalAmount,
  });
  const lineas = await db.select().from(customerPurchaseService)
    .where(eq(customerPurchaseService.customerPurchaseId, compra.id));
  const porRep = new Map<number, string>();
  for (const [i, l] of lineas.sort((a, b) => (a.repeticion ?? 0) - (b.repeticion ?? 0)).entries()) {
    const start = new Date(DIA.getTime() + (nombre === "SIN" ? 4 : 0) * 3600e3 + i * 1800e3);
    const [t] = await db.insert(appointments).values({
      customerId: clienteId, serviceId: sBotox, appointmentStart: start,
      appointmentEnd: new Date(start.getTime() + 1800e3), durationMinutes: 30,
      status: "scheduled", notes: `${QA}_${nombre}_${i}`,
    } as never).returning({ id: appointments.id });
    await db.update(customerPurchaseService).set({ appointmentId: t!.id }).where(eq(customerPurchaseService.id, l.id));
    porRep.set(l.repeticion ?? i + 1, t!.id);
    turnos.push(t!.id);
  }
  return porRep;
}

describe("esRetoque en el turno", () => {
  it("sólo el turno de la última sesión de un pack con retoque", async () => {
    const t = await comprarYAgendar("CON", true);
    const dia = await listAppointmentsByRange(
      db, { start: new Date("2031-03-10T00:00:00Z"), end: new Date("2031-03-11T00:00:00Z") }, {});
    const marca = (id: string) => (dia.find((x) => x.id === id) as any)?.esRetoque;
    expect(marca(t.get(1)!)).toBe(false);
    expect(marca(t.get(2)!)).toBe(true);
    expect(((await getAppointmentDetail(db, t.get(2)!)) as any).esRetoque).toBe(true);
    expect(((await getAppointmentDetail(db, t.get(1)!)) as any).esRetoque).toBe(false);
  });

  it("un pack sin la tilde, ninguno", async () => {
    const t = await comprarYAgendar("SIN", false);
    const dia = await listAppointmentsByRange(
      db, { start: new Date("2031-03-10T00:00:00Z"), end: new Date("2031-03-11T00:00:00Z") }, {});
    expect((dia.find((x) => x.id === t.get(2)!) as any).esRetoque).toBe(false);
  });

  it("un turno suelto (sin compra) es false, no null", async () => {
    const [t] = await db.insert(appointments).values({
      customerId: clienteId, serviceId: sBotox, appointmentStart: new Date("2031-03-10T20:00:00Z"),
      appointmentEnd: new Date("2031-03-10T20:30:00Z"), durationMinutes: 30, status: "scheduled", notes: `${QA}_SUELTO`,
    } as never).returning({ id: appointments.id });
    expect(((await getAppointmentDetail(db, t!.id)) as any).esRetoque).toBe(false);
  });
});
