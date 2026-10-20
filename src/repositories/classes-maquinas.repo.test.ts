import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq, inArray, like } from "drizzle-orm";
import * as schema from "../db/schema";
import { activities, activitySchedules, appointments, contacts, customers, machines } from "../db/schema";
import type { Db } from "../db/client";
import { listClassesForRange } from "./classes.repo";

/**
 * Dos horarios de la misma actividad a la misma hora en máquinas distintas son
 * dos clases: cada una cuenta y lista sólo a sus anotadas (igual que el cupo).
 */
const pgClient = postgres("postgresql://piubella:piubella@localhost:5499/piubella", {
  max: 1,
  fetch_types: false,
  prepare: false,
});
const db = drizzle(pgClient, { schema }) as unknown as Db;

const QA = "ZZ_QA_CLASES_MAQ";
// Lunes 5 de abril de 2027, 10:00 ART = 13:00 UTC.
const FECHA = "2027-04-05";
const INICIO = new Date(`${FECHA}T13:00:00Z`);

let actividadId = "";
let maqA = "";
let maqB = "";

async function limpiar() {
  const acts = await db.select({ id: activities.id }).from(activities).where(like(activities.name, `${QA}%`));
  const ids = acts.map((a) => a.id);
  if (ids.length) await db.delete(appointments).where(inArray(appointments.activityId, ids));
  const cts = await db.select({ id: contacts.id }).from(contacts).where(like(contacts.name, `${QA}%`));
  for (const ct of cts) {
    await db.delete(customers).where(eq(customers.contactId, ct.id));
    await db.delete(contacts).where(eq(contacts.id, ct.id));
  }
  if (ids.length) {
    await db.delete(activitySchedules).where(inArray(activitySchedules.activityId, ids));
    await db.delete(activities).where(inArray(activities.id, ids));
  }
  await db.delete(machines).where(like(machines.name, `${QA}%`));
}

async function anotar(clave: string, machineId: string) {
  const [ct] = await db.insert(contacts).values({ name: `${QA}_${clave}` }).returning({ id: contacts.id });
  const [cu] = await db.insert(customers).values({ contactId: ct!.id }).returning({ id: customers.id });
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
}

beforeAll(async () => {
  await limpiar();
  const [ac] = await db
    .insert(activities)
    .values({ name: `${QA}_Thermo`, activityType: "class", classesPerMonth: 4, monthlyBasePrice: "8000" })
    .returning({ id: activities.id });
  actividadId = ac!.id;
  const [ma] = await db.insert(machines).values({ name: `${QA}_A` }).returning({ id: machines.id });
  const [mb] = await db.insert(machines).values({ name: `${QA}_B` }).returning({ id: machines.id });
  maqA = ma!.id;
  maqB = mb!.id;
  for (const machineId of [maqA, maqB]) {
    await db.insert(activitySchedules).values({
      activityId: actividadId,
      dayOfWeek: 1,
      startTime: "10:00",
      endTime: "11:00",
      validFrom: FECHA,
      validUntil: FECHA,
      capacity: 1,
      machineId,
      isActive: true,
    });
  }
  await anotar("ANA", maqA);
  await anotar("BEA", maqB);
});

afterAll(async () => {
  await limpiar();
  await pgClient.end();
});

describe("clases de máquina", () => {
  it("cada máquina cuenta y lista sólo a sus anotadas", async () => {
    const filas = (await listClassesForRange(db, FECHA, FECHA)).filter((f) => f.name.startsWith(QA));
    expect(filas).toHaveLength(2);
    const porMaquina = Object.fromEntries(filas.map((f) => [f.machine_id, f]));
    expect(porMaquina[maqA]!.enrolled_count).toBe(1);
    expect(porMaquina[maqA]!.anotadas.map((a) => a.nombre)).toEqual([`${QA}_ANA`]);
    expect(porMaquina[maqB]!.enrolled_count).toBe(1);
    expect(porMaquina[maqB]!.anotadas.map((a) => a.nombre)).toEqual([`${QA}_BEA`]);
  });
});
