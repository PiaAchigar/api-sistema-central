import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq, like } from "drizzle-orm";
import * as schema from "../db/schema";
import { activities, appointments, contacts, customers } from "../db/schema";
import type { Db } from "../db/client";
import { updateAppointmentStatus } from "./appointments.service";

/**
 * Un turno de clase cancelado no se restaura por PATCH: saltearía el lock y el
 * conteo de cupo de anotar. Para volver a anotarla se usa Anotar.
 */
const pgClient = postgres("postgresql://piubella:piubella@localhost:5499/piubella", {
  max: 1,
  fetch_types: false,
  prepare: false,
});
const db = drizzle(pgClient, { schema }) as unknown as Db;

const QA = "ZZ_QA_CLASE_CANCELADA";
const MENSAJE = "Ese turno de clase está cancelado: para volver a anotarla usá Anotar";
let actividadId = "";
let clientaId = "";

async function limpiar() {
  const acts = await db.select({ id: activities.id }).from(activities).where(like(activities.name, `${QA}%`));
  for (const a of acts) await db.delete(appointments).where(eq(appointments.activityId, a.id));
  await db.delete(appointments).where(like(appointments.notes, `${QA}%`));
  const cts = await db.select({ id: contacts.id }).from(contacts).where(like(contacts.name, `${QA}%`));
  for (const ct of cts) {
    await db.delete(customers).where(eq(customers.contactId, ct.id));
    await db.delete(contacts).where(eq(contacts.id, ct.id));
  }
  for (const a of acts) await db.delete(activities).where(eq(activities.id, a.id));
}

async function turnoCancelado() {
  const inicio = new Date("2027-05-03T13:00:00Z");
  const [t] = await db
    .insert(appointments)
    .values({
      customerId: clientaId,
      activityId: actividadId,
      appointmentStart: inicio,
      appointmentEnd: new Date(inicio.getTime() + 3600_000),
      durationMinutes: 60,
      status: "cancelled",
      notes: `${QA} turno`,
    })
    .returning({ id: appointments.id });
  return t!.id;
}

beforeAll(async () => {
  await limpiar();
  const [a] = await db
    .insert(activities)
    .values({ name: `${QA}_Pilates`, activityType: "class", classesPerMonth: 4, monthlyBasePrice: "8000" })
    .returning({ id: activities.id });
  actividadId = a!.id;
  const [ct] = await db.insert(contacts).values({ name: `${QA}_ANA` }).returning({ id: contacts.id });
  const [cu] = await db.insert(customers).values({ contactId: ct!.id }).returning({ id: customers.id });
  clientaId = cu!.id;
});

afterAll(async () => {
  await limpiar();
  await pgClient.end();
});

describe("updateAppointmentStatus — turno de clase cancelado", () => {
  it.each(["scheduled", "completed", "reserved", "no_show"])("cancelled → %s se rechaza con 400", async (estado) => {
    const id = await turnoCancelado();
    await expect(updateAppointmentStatus(db, id, { status: estado })).rejects.toMatchObject({
      status: 400,
      message: MENSAJE,
    });
    const [t] = await db.select({ status: appointments.status }).from(appointments).where(eq(appointments.id, id));
    expect(t!.status).toBe("cancelled");
  });

  it("cancelled → cancelled sigue andando (no cambia de estado)", async () => {
    const id = await turnoCancelado();
    await expect(updateAppointmentStatus(db, id, { status: "cancelled" })).resolves.toBeTruthy();
  });
});
