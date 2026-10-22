import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq, inArray, like } from "drizzle-orm";
import * as schema from "../db/schema";
import {
  appointments,
  bodyZone,
  customerPurchase,
  customerPurchaseService,
  depilationCombo,
  machines,
  payments,
  serviceMachine,
  serviceProviderAvailability,
  serviceProviderMachine,
  serviceProviderService,
  serviceProviders,
} from "../db/schema";
import type { Db } from "../db/client";
import { anclaDeDepilacion } from "../repositories/ancla-de-depilacion.repo";
import { createCompra } from "../repositories/compras.repo";
import { crearCombo, hardDeleteCombo } from "../repositories/depilacion.repo";
import { createAppointment, crearTurnosEnLote, ErrorDeLote } from "./appointments.service";
import { usarConfigDeDepilacionDeTest } from "../test-support/depilation-config";

// La config de depilación la edita Laura: el archivo arma la suya (ver test-support).
usarConfigDeDepilacionDeTest();

/**
 * Task 5 del planificador: varios turnos en UNA transacción, todos o ninguno.
 * Contra base real, con el mismo armado que `appointments.depilacion.test.ts`
 * (el ancla no tiene proveedora ni máquina en la base local: se arman acá).
 */

/** Lunes seguidos a 8+ semanas de hoy (la proveedora de prueba sólo trabaja ese día). */
const LUNES: string[] = (() => {
  const d = new Date(Date.now() + 56 * 86_400_000);
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
  return Array.from({ length: 8 }, (_, i) =>
    new Date(d.getTime() + i * 7 * 86_400_000).toISOString().slice(0, 10),
  );
})();
/** `n`-ésimo turno de media hora del lunes `dia` (13:00Z = 10:00 en Buenos Aires). */
const hora = (dia: number, n: number) =>
  new Date(Date.parse(`${LUNES[dia]}T13:00:00.000Z`) + n * 30 * 60_000).toISOString();

const LOCAL_DB_URL = "postgresql://piubella:piubella@localhost:5499/piubella";
const pgClient = postgres(LOCAL_DB_URL, { max: 1 });
const db = drizzle(pgClient, { schema }) as unknown as Db;

const QA = "ZZ_QA_PLAN_LOTE5";
const CUSTOMER_ID = "dddddddd-0000-0000-0000-000000000001";

let anclaId: string;
let proveedoraId: string;
let maquinaId: string;
let piernaId: string;
let axilaId: string;
let packId: string;

async function limpiar() {
  const compras = await db
    .select({ id: customerPurchase.id })
    .from(customerPurchase)
    .where(like(customerPurchase.description, `${QA}%`));
  if (compras.length > 0) {
    const ids = compras.map((c) => c.id);
    await db.delete(payments).where(inArray(payments.customerPurchaseId, ids));
    await db.delete(customerPurchase).where(inArray(customerPurchase.id, ids));
  }
  await db.delete(appointments).where(like(appointments.notes, `${QA}%`));

  const packs = await db
    .select({ id: depilationCombo.id })
    .from(depilationCombo)
    .where(like(depilationCombo.name, `${QA}%`));
  for (const p of packs) await hardDeleteCombo(db, p.id);
  await db.delete(bodyZone).where(like(bodyZone.name, `${QA}%`));

  const provs = await db
    .select({ id: serviceProviders.id })
    .from(serviceProviders)
    .where(like(serviceProviders.fullName, `${QA}%`));
  const provIds = provs.map((p) => p.id);
  if (provIds.length > 0) {
    await db.delete(serviceProviderMachine).where(inArray(serviceProviderMachine.serviceProviderId, provIds));
    await db.delete(serviceProviderService).where(inArray(serviceProviderService.serviceProviderId, provIds));
    await db.delete(serviceProviderAvailability).where(inArray(serviceProviderAvailability.serviceProviderId, provIds));
    await db.delete(serviceProviders).where(inArray(serviceProviders.id, provIds));
  }
  const maqs = await db.select({ id: machines.id }).from(machines).where(like(machines.name, `${QA}%`));
  const maqIds = maqs.map((m) => m.id);
  if (maqIds.length > 0) {
    await db.delete(serviceMachine).where(inArray(serviceMachine.machineId, maqIds));
    await db.delete(machines).where(inArray(machines.id, maqIds));
  }
}

/** Una compra de `sesiones` sesiones del pack con `pagado` ya cobrado (confirmado). */
async function comprar(sufijo: string, sesiones: number, pagado: number) {
  const compra = await createCompra(db, {
    customerId: CUSTOMER_ID,
    depilationComboId: packId,
    description: `${QA}_${sufijo}`,
    sessionsTotal: sesiones,
    baseAmount: 100000,
    discountedAmount: 100000,
    finalAmount: 100000,
  });
  if (pagado > 0) {
    const ahora = new Date();
    await db.insert(payments).values({
      customerId: CUSTOMER_ID,
      customerPurchaseId: compra.id,
      amount: String(pagado),
      paymentMethod: "cash",
      status: "confirmed",
      paymentDate: ahora,
      isDeclared: true,
      confirmedAt: ahora,
    });
  }
  const lineas = await db
    .select({ id: customerPurchaseService.id })
    .from(customerPurchaseService)
    .where(eq(customerPurchaseService.customerPurchaseId, compra.id))
    .orderBy(customerPurchaseService.id);
  return { compraId: compra.id, lineas: lineas.map((l) => l.id) };
}

const turno = (linea: string, start: string, extra: Record<string, unknown> = {}) => ({
  customerId: CUSTOMER_ID,
  serviceId: anclaId,
  providerId: proveedoraId,
  start,
  customerPurchaseServiceId: linea,
  zonas: [piernaId, axilaId],
  notes: QA,
  ...extra,
});

async function turnosDeLaCompra(compraId: string) {
  const filas = await db
    .select({ appointmentId: customerPurchaseService.appointmentId })
    .from(customerPurchaseService)
    .where(eq(customerPurchaseService.customerPurchaseId, compraId));
  return filas.filter((f) => f.appointmentId != null).length;
}

async function cuantosTurnosQA() {
  const filas = await db.select({ id: appointments.id }).from(appointments).where(like(appointments.notes, `${QA}%`));
  return filas.length;
}

beforeAll(async () => {
  await limpiar();
  anclaId = await anclaDeDepilacion(db);

  const [pierna] = await db
    .insert(bodyZone)
    .values({ name: `${QA}_PIERNA`, category: "grande", displayOrder: 930, isActive: true })
    .returning({ id: bodyZone.id });
  piernaId = pierna!.id;
  const [axila] = await db
    .insert(bodyZone)
    .values({ name: `${QA}_AXILA`, category: "chica", displayOrder: 931, isActive: true })
    .returning({ id: bodyZone.id });
  axilaId = axila!.id;

  const pack = await crearCombo(db, {
    name: `${QA}_PACK`,
    kind: "pack_fijo",
    fixedPrice: 100000,
    fixedDurationMinutes: 30,
    choiceZoneCount: 0,
    zonaIds: [piernaId, axilaId],
  });
  packId = pack!.id;

  const [maquina] = await db.insert(machines).values({ name: `${QA}_MAQUINA`, status: "active" }).returning({ id: machines.id });
  maquinaId = maquina!.id;
  await db.insert(serviceMachine).values({ serviceId: anclaId, machineId: maquinaId, isPrimaryMachine: true });

  const [prov] = await db
    .insert(serviceProviders)
    .values({ fullName: `${QA}_PROVEEDORA`, status: "active" })
    .returning({ id: serviceProviders.id });
  proveedoraId = prov!.id;
  await db.insert(serviceProviderService).values({
    serviceProviderId: proveedoraId,
    serviceId: anclaId,
    paymentType: "fixed_per_service",
    rate: "1000",
    isActive: true,
  });
  await db.insert(serviceProviderMachine).values({ serviceProviderId: proveedoraId, machineId: maquinaId });
  // Lunes (day_of_week=1): `open_hours` del local ya abre 09–20 ese día (no se toca).
  await db.insert(serviceProviderAvailability).values({
    serviceProviderId: proveedoraId,
    dayOfWeek: 1,
    workStartTime: "09:00:00",
    workEndTime: "20:00:00",
    isActive: true,
  });
}, 30000);

afterAll(async () => {
  await limpiar();
  await pgClient.end();
});

describe("crear turnos en lote", () => {
  it("crea los 3 turnos y toma las 3 líneas de la compra", async () => {
    const { compraId, lineas } = await comprar("OK3", 3, 100000);
    const creados = await crearTurnosEnLote(
      db,
      lineas.map((l, i) => turno(l, hora(0, i))),
    );
    expect(creados).toHaveLength(3);
    expect(await turnosDeLaCompra(compraId)).toBe(3);
  });

  it("si el 2º choca con un turno existente no crea ninguno: 409 con indice 1", async () => {
    const { compraId, lineas } = await comprar("CHOCA", 3, 100000);
    const antes = await cuantosTurnosQA();
    // Ocupa la hora 5 del lunes 1.
    const { lineas: otras } = await comprar("EXISTENTE", 1, 100000);
    await createAppointment(db, turno(otras[0]!, hora(1, 5)));

    const inputs = [turno(lineas[0]!, hora(1, 0)), turno(lineas[1]!, hora(1, 5)), turno(lineas[2]!, hora(1, 2))];
    const err = await crearTurnosEnLote(db, inputs).catch((e) => e);
    expect(err).toBeInstanceOf(ErrorDeLote);
    expect(err.status).toBe(409);
    expect(err.indice).toBe(1);
    expect(await turnosDeLaCompra(compraId)).toBe(0);
    expect(await cuantosTurnosQA()).toBe(antes + 1); // sólo el existente
  });

  it("dos turnos del lote con la misma prestadora y hora: 409 con indice 1", async () => {
    const { compraId, lineas } = await comprar("MISMAHORA", 3, 100000);
    const antes = await cuantosTurnosQA();
    const err = await crearTurnosEnLote(db, [
      turno(lineas[0]!, hora(2, 0)),
      turno(lineas[1]!, hora(2, 0)),
    ]).catch((e) => e);
    expect(err).toBeInstanceOf(ErrorDeLote);
    expect(err.status).toBe(409);
    expect(err.indice).toBe(1);
    expect(await turnosDeLaCompra(compraId)).toBe(0);
    expect(await cuantosTurnosQA()).toBe(antes);
  });

  it("pack de depilación de 6 con 50% pago: las 6 juntas → 400 indice 5 'Es la última sesión…'; 5 de las 6 → 201", async () => {
    const { compraId, lineas } = await comprar("PACK6", 6, 50000);
    const seis = lineas.map((l, i) => turno(l, hora(3, i)));

    const err = await crearTurnosEnLote(db, seis).catch((e) => e);
    expect(err).toBeInstanceOf(ErrorDeLote);
    expect(err.status).toBe(400);
    expect(err.indice).toBe(5);
    expect(err.message).toContain("Es la última sesión");
    expect(await turnosDeLaCompra(compraId)).toBe(0);

    const creados = await crearTurnosEnLote(db, seis.slice(0, 5));
    expect(creados).toHaveLength(5);
    expect(await turnosDeLaCompra(compraId)).toBe(5);
  });

  it("con 30% pago, un turno 'scheduled' de depilación → 400 'Para agendar hace falta al menos el 40%'", async () => {
    const { compraId, lineas } = await comprar("TREINTA", 3, 30000);
    const err = await crearTurnosEnLote(db, [
      turno(lineas[0]!, hora(4, 0), { status: "scheduled" }),
    ]).catch((e) => e);
    expect(err).toBeInstanceOf(ErrorDeLote);
    expect(err.status).toBe(400);
    expect(err.indice).toBe(0);
    expect(err.message).toContain("Para agendar hace falta al menos el 40%");
    expect(await turnosDeLaCompra(compraId)).toBe(0);
  });
});
