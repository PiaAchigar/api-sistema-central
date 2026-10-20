import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq, inArray, like } from "drizzle-orm";
import * as schema from "../db/schema";
import {
  activities,
  activityAttendance,
  activitySchedules,
  appointments,
  contacts,
  customers,
  machines,
  trainingSubscriptions,
} from "../db/schema";
import type { Db } from "../db/client";
import { listClassesForRange } from "./classes.repo";

/**
 * "Asistieron" se cuenta por clase: dos clases de la misma actividad el mismo día
 * (otra hora, u otra máquina a la misma hora) no comparten el número.
 */
const pgClient = postgres("postgresql://piubella:piubella@localhost:5499/piubella", {
  max: 1,
  fetch_types: false,
  prepare: false,
});
const db = drizzle(pgClient, { schema }) as unknown as Db;

const QA = "ZZ_QA_ASISTIERON";
// Lunes 12 de abril de 2027: 10:00 ART = 13:00Z, 18:00 ART = 21:00Z.
const FECHA = "2027-04-12";
const MANANA = new Date(`${FECHA}T13:00:00Z`);
const TARDE = new Date(`${FECHA}T21:00:00Z`);

let pilatesId = "";
let thermoId = "";
let maqA = "";
let maqB = "";

async function limpiar() {
  const acts = await db.select({ id: activities.id }).from(activities).where(like(activities.name, `${QA}%`));
  const ids = acts.map((a) => a.id);
  if (ids.length) await db.delete(appointments).where(inArray(appointments.activityId, ids));
  const cts = await db.select({ id: contacts.id }).from(contacts).where(like(contacts.name, `${QA}%`));
  for (const ct of cts) {
    const cus = await db.select({ id: customers.id }).from(customers).where(eq(customers.contactId, ct.id));
    for (const cu of cus) {
      const subs = await db.select({ id: trainingSubscriptions.id }).from(trainingSubscriptions).where(eq(trainingSubscriptions.customerId, cu.id));
      for (const s of subs) {
        await db.delete(activityAttendance).where(eq(activityAttendance.subscriptionId, s.id));
        await db.delete(trainingSubscriptions).where(eq(trainingSubscriptions.id, s.id));
      }
    }
    await db.delete(customers).where(eq(customers.contactId, ct.id));
    await db.delete(contacts).where(eq(contacts.id, ct.id));
  }
  if (ids.length) {
    await db.delete(activitySchedules).where(inArray(activitySchedules.activityId, ids));
    await db.delete(activities).where(inArray(activities.id, ids));
  }
  await db.delete(machines).where(like(machines.name, `${QA}%`));
}

/** Clienta suscripta y anotada a una clase; `asistio` deja la asistencia tildada. */
async function anotar(clave: string, activityId: string, inicio: Date, machineId: string | null, asistio: boolean) {
  const [ct] = await db.insert(contacts).values({ name: `${QA}_${clave}` }).returning({ id: contacts.id });
  const [cu] = await db.insert(customers).values({ contactId: ct!.id }).returning({ id: customers.id });
  const [sub] = await db
    .insert(trainingSubscriptions)
    .values({ customerId: cu!.id, activityId, status: "active", subscriptionStartDate: "2027-04-01", monthlyAmount: "1000" })
    .returning({ id: trainingSubscriptions.id });
  await db.insert(appointments).values({
    customerId: cu!.id,
    activityId,
    machineId,
    appointmentStart: inicio,
    appointmentEnd: new Date(inicio.getTime() + 3600_000),
    durationMinutes: 60,
    status: "scheduled",
  });
  if (asistio) await db.insert(activityAttendance).values({ subscriptionId: sub!.id, activityId, classDate: FECHA, attended: true });
}

async function horario(activityId: string, hora: string, machineId: string | null) {
  await db.insert(activitySchedules).values({
    activityId,
    dayOfWeek: 1,
    startTime: hora,
    endTime: `${String(Number(hora.slice(0, 2)) + 1).padStart(2, "0")}:00`,
    validFrom: FECHA,
    validUntil: FECHA,
    capacity: 5,
    machineId,
    isActive: true,
  });
}

beforeAll(async () => {
  await limpiar();
  const [p] = await db.insert(activities).values({ name: `${QA}_Pilates`, activityType: "class", classesPerMonth: 4, monthlyBasePrice: "8000" }).returning({ id: activities.id });
  const [t] = await db.insert(activities).values({ name: `${QA}_Thermo`, activityType: "class", classesPerMonth: 4, monthlyBasePrice: "8000" }).returning({ id: activities.id });
  pilatesId = p!.id;
  thermoId = t!.id;
  const [ma] = await db.insert(machines).values({ name: `${QA}_A` }).returning({ id: machines.id });
  const [mb] = await db.insert(machines).values({ name: `${QA}_B` }).returning({ id: machines.id });
  maqA = ma!.id;
  maqB = mb!.id;

  await horario(pilatesId, "10:00", null);
  await horario(pilatesId, "18:00", null);
  await anotar("ANA", pilatesId, MANANA, null, true);
  await anotar("BEA", pilatesId, TARDE, null, false);

  await horario(thermoId, "10:00", maqA);
  await horario(thermoId, "10:00", maqB);
  await anotar("CLA", thermoId, MANANA, maqA, true);
  await anotar("DAI", thermoId, MANANA, maqB, false);
});

afterAll(async () => {
  await limpiar();
  await pgClient.end();
});

describe("asistieron por clase", () => {
  it("dos horas el mismo día: sólo la clase donde se tildó cuenta la asistencia", async () => {
    const filas = (await listClassesForRange(db, FECHA, FECHA)).filter((f) => f.name === `${QA}_Pilates`);
    expect(filas).toHaveLength(2);
    const porHora = Object.fromEntries(filas.map((f) => [f.start_time.slice(0, 5), f]));
    expect(porHora["10:00"]!.attended_count).toBe(1);
    expect(porHora["18:00"]!.attended_count).toBe(0);
  });

  it("dos máquinas a la misma hora: cada una cuenta las suyas", async () => {
    const filas = (await listClassesForRange(db, FECHA, FECHA)).filter((f) => f.name === `${QA}_Thermo`);
    expect(filas).toHaveLength(2);
    const porMaquina = Object.fromEntries(filas.map((f) => [f.machine_id, f]));
    expect(porMaquina[maqA]!.attended_count).toBe(1);
    expect(porMaquina[maqB]!.attended_count).toBe(0);
  });
});
