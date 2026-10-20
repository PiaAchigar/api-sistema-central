import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { inArray, like } from "drizzle-orm";
import * as schema from "../db/schema";
import {
  appointments,
  contacts,
  customerPurchase,
  customers,
  payments,
  training,
  trainingSessions,
} from "../db/schema";
import type { Db } from "../db/client";
import { listInscriptas } from "./training-sessions.repo";

/** Inscriptas de una capacitación contra la base local, con datos propios ZZ_QA_. */
const pgClient = postgres("postgresql://piubella:piubella@localhost:5499/piubella", {
  max: 1,
  fetch_types: false,
  prepare: false,
});
const db = drizzle(pgClient, { schema }) as unknown as Db;

const QA = "ZZ_QA_INSCRIPTAS_";
let capId: string;
let otraCapId: string;
let anaId: string;
let beaId: string;
let encuentros: string[] = [];
let compraAna: string;
let compraBea: string;

async function limpiar() {
  await db.delete(appointments).where(like(appointments.notes, `${QA}%`));
  const caps = await db.select({ id: training.id }).from(training).where(like(training.name, `${QA}%`));
  const capIds = caps.map((c) => c.id);
  if (capIds.length) {
    const compras = await db
      .select({ id: customerPurchase.id })
      .from(customerPurchase)
      .where(inArray(customerPurchase.trainingId, capIds));
    if (compras.length) {
      await db.delete(payments).where(inArray(payments.customerPurchaseId, compras.map((c) => c.id)));
      await db.delete(customerPurchase).where(inArray(customerPurchase.id, compras.map((c) => c.id)));
    }
    await db.delete(trainingSessions).where(inArray(trainingSessions.trainingId, capIds));
    await db.delete(training).where(inArray(training.id, capIds));
  }
  const cons = await db.select({ id: contacts.id }).from(contacts).where(like(contacts.name, `${QA}%`));
  if (cons.length) {
    await db.delete(customers).where(inArray(customers.contactId, cons.map((c) => c.id)));
    await db.delete(contacts).where(inArray(contacts.id, cons.map((c) => c.id)));
  }
}

async function clienta(nombre: string) {
  const [ct] = await db.insert(contacts).values({ name: `${QA}${nombre}` }).returning({ id: contacts.id });
  const [cl] = await db.insert(customers).values({ contactId: ct!.id }).returning({ id: customers.id });
  return cl!.id;
}

async function compra(customerId: string, trainingId: string, cancelada = false) {
  const [c] = await db
    .insert(customerPurchase)
    .values({
      customerId,
      trainingId,
      description: `${QA}compra`,
      sessionsTotal: 1,
      baseAmount: "10000",
      discountedAmount: "10000",
      finalAmount: "10000",
      purchasedAt: new Date("2026-10-01T15:00:00Z"),
      cancelledAt: cancelada ? new Date() : null,
    })
    .returning({ id: customerPurchase.id });
  return c!.id;
}

async function turno(customerId: string, sessionId: string, status: string) {
  const t = new Date("2026-11-04T13:00:00Z");
  await db.insert(appointments).values({
    customerId, trainingSessionId: sessionId, status, notes: `${QA}t`, appointmentStart: t, appointmentEnd: t,
  });
}

beforeAll(async () => {
  await limpiar();
  const [c] = await db.insert(training).values({ name: `${QA}cap` }).returning({ id: training.id });
  capId = c!.id;
  const [o] = await db.insert(training).values({ name: `${QA}otra` }).returning({ id: training.id });
  otraCapId = o!.id;
  const filas = await db
    .insert(trainingSessions)
    .values([
      { trainingId: capId, sessionNumber: 1, sessionDate: "2026-11-04", startTime: "10:00:00", endTime: "12:00:00" },
      { trainingId: capId, sessionNumber: 2, sessionDate: "2026-11-11", startTime: "10:00:00", endTime: "12:00:00" },
      { trainingId: capId, sessionNumber: 3, sessionDate: "2026-11-18", startTime: "10:00:00", endTime: "12:00:00" },
      { trainingId: capId, sessionNumber: 4, sessionDate: "2026-11-25", startTime: "10:00:00", endTime: "12:00:00", isActive: false },
    ])
    .returning({ id: trainingSessions.id });
  encuentros = filas.map((f) => f.id);
  const [otroEnc] = await db
    .insert(trainingSessions)
    .values({ trainingId: otraCapId, sessionNumber: 1, sessionDate: "2026-11-04", startTime: "10:00:00", endTime: "12:00:00" })
    .returning({ id: trainingSessions.id });

  anaId = await clienta("Ana");
  beaId = await clienta("Bea");
  const cancelada = await clienta("Cande");
  compraAna = await compra(anaId, capId);
  compraBea = await compra(beaId, capId);
  await compra(cancelada, capId, true);
  await compra(anaId, otraCapId);

  await db.insert(payments).values([
    { customerPurchaseId: compraAna, customerId: anaId, amount: "10000", status: "confirmed" },
    { customerPurchaseId: compraBea, customerId: beaId, amount: "4000", status: "confirmed" },
    { customerPurchaseId: compraBea, customerId: beaId, amount: "3000", status: "pending" },
  ]);

  // Ana: 2 encuentros activos con turno vivo, uno cancelado, uno en encuentro inactivo, uno de otra capacitación.
  await turno(anaId, encuentros[0]!, "scheduled");
  await turno(anaId, encuentros[1]!, "completed");
  await turno(anaId, encuentros[2]!, "cancelled");
  await turno(anaId, encuentros[3]!, "scheduled");
  await turno(anaId, otroEnc!.id, "scheduled");
  // Bea: un turno de Ana-no, uno propio.
  await turno(beaId, encuentros[0]!, "scheduled");
});

afterAll(async () => {
  await limpiar();
  await pgClient.end();
});

describe("listInscriptas", () => {
  it("devuelve las compras vivas, ordenadas por nombre, con deuda y encuentros", async () => {
    const r = await listInscriptas(db, capId);
    expect(r).toHaveLength(2);
    expect(r.map((i) => i.nombre)).toEqual([`${QA}Ana`, `${QA}Bea`]);

    const [ana, bea] = r;
    expect(ana).toMatchObject({
      customerPurchaseId: compraAna,
      customerId: anaId,
      debe: 0,
      encuentrosAnotada: 2,
      encuentrosTotales: 3,
    });
    expect(bea).toMatchObject({
      customerPurchaseId: compraBea,
      customerId: beaId,
      debe: 6000,
      encuentrosAnotada: 1,
      encuentrosTotales: 3,
    });
    expect(ana!.compradaEl).toContain("2026-10-01");
  });

  it("una capacitación sin compras devuelve lista vacía", async () => {
    const [c] = await db.insert(training).values({ name: `${QA}vacia` }).returning({ id: training.id });
    expect(await listInscriptas(db, c!.id)).toEqual([]);
  });
});
