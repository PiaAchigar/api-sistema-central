import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq, inArray, like } from "drizzle-orm";
import * as schema from "../db/schema";
import {
  activities,
  activityAttendance,
  appointments,
  contacts,
  customers,
  machines,
  trainingSubscriptions,
} from "../db/schema";
import type { Db } from "../db/client";
import { TrainingSubscriptionsRepository } from "../repositories/trainingSubscriptionsRepository";
import { TrainingSubscriptionsService } from "./trainingSubscriptionsService";

/**
 * Lista de asistencia de una clase de máquina: dos máquinas a la misma hora
 * son dos clases, y la lista (y el guardado) es sólo de la máquina pedida.
 */
const pgClient = postgres("postgresql://piubella:piubella@localhost:5499/piubella", {
  max: 1,
  fetch_types: false,
  prepare: false,
});
const db = drizzle(pgClient, { schema }) as unknown as Db;
const repo = new TrainingSubscriptionsRepository();
repo.setDb(db);
const service = new TrainingSubscriptionsService(repo);

const QA = "ZZ_QA_ASIST_MAQ";
const INICIO = new Date("2026-03-02T13:00:00Z"); // pasada
const STARTS_AT = INICIO.toISOString();

let actividadId = "";
let maqA = "";
let maqB = "";
let subA = "";
let subB = "";

async function limpiar() {
  const acts = await db.select({ id: activities.id }).from(activities).where(like(activities.name, `${QA}%`));
  const ids = acts.map((a) => a.id);
  if (ids.length) {
    const subs = await db
      .select({ id: trainingSubscriptions.id })
      .from(trainingSubscriptions)
      .where(inArray(trainingSubscriptions.activityId, ids));
    if (subs.length) {
      await db.delete(activityAttendance).where(inArray(activityAttendance.subscriptionId, subs.map((s) => s.id)));
    }
    await db.delete(trainingSubscriptions).where(inArray(trainingSubscriptions.activityId, ids));
    await db.delete(appointments).where(inArray(appointments.activityId, ids));
  }
  const cts = await db.select({ id: contacts.id }).from(contacts).where(like(contacts.name, `${QA}%`));
  for (const ct of cts) {
    await db.delete(customers).where(eq(customers.contactId, ct.id));
    await db.delete(contacts).where(eq(contacts.id, ct.id));
  }
  if (ids.length) await db.delete(activities).where(inArray(activities.id, ids));
  await db.delete(machines).where(like(machines.name, `${QA}%`));
}

async function anotar(clave: string, machineId: string) {
  const [ct] = await db.insert(contacts).values({ name: `${QA}_${clave}` }).returning({ id: contacts.id });
  const [cu] = await db.insert(customers).values({ contactId: ct!.id }).returning({ id: customers.id });
  const [sub] = await db
    .insert(trainingSubscriptions)
    .values({
      activityId: actividadId,
      customerId: cu!.id,
      subscriptionStartDate: "2026-01-01",
      status: "active",
      monthlyAmount: "8000",
    })
    .returning({ id: trainingSubscriptions.id });
  await db.insert(appointments).values({
    customerId: cu!.id,
    activityId: actividadId,
    machineId,
    appointmentStart: INICIO,
    appointmentEnd: new Date(INICIO.getTime() + 3600_000),
    durationMinutes: 60,
    status: "scheduled",
    notes: `${QA} clase`,
  });
  return sub!.id;
}

beforeAll(async () => {
  await limpiar();
  const [ac] = await db
    .insert(activities)
    .values({ name: `${QA}_Thermo`, activityType: "machine", classesPerMonth: 4, monthlyBasePrice: "8000" })
    .returning({ id: activities.id });
  actividadId = ac!.id;
  const [ma] = await db.insert(machines).values({ name: `${QA}_A` }).returning({ id: machines.id });
  const [mb] = await db.insert(machines).values({ name: `${QA}_B` }).returning({ id: machines.id });
  maqA = ma!.id;
  maqB = mb!.id;
  subA = await anotar("ANA", maqA);
  subB = await anotar("BEA", maqB);
});

afterAll(async () => {
  await limpiar();
  await pgClient.end();
});

describe("asistencias por máquina", () => {
  it("con machineId el roster trae sólo la máquina pedida", async () => {
    const a = await service.getClassRoster(actividadId, STARTS_AT, maqA);
    expect(a.map((r) => r.customerName)).toEqual([`${QA}_ANA`]);
    const b = await service.getClassRoster(actividadId, STARTS_AT, maqB);
    expect(b.map((r) => r.customerName)).toEqual([`${QA}_BEA`]);
  });

  it("sin machineId trae las dos (igual que antes)", async () => {
    const todas = await service.getClassRoster(actividadId, STARTS_AT);
    expect(todas.map((r) => r.customerName)).toEqual([`${QA}_ANA`, `${QA}_BEA`]);
  });

  it("guardar con machineId=A rechaza la suscripción de B", async () => {
    await expect(
      service.markClassAttendance(actividadId, STARTS_AT, [{ subscriptionId: subB, attended: true }], maqA)
    ).rejects.toThrow(/no están agendadas a esta clase/);
    const ok = await service.markClassAttendance(
      actividadId,
      STARTS_AT,
      [{ subscriptionId: subA, attended: true }],
      maqA
    );
    expect(ok).toHaveLength(1);
    expect(ok[0]!.attended).toBe(true);
  });
});
