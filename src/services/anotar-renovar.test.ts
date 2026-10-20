import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq, inArray, like } from "drizzle-orm";
import * as schema from "../db/schema";
import {
  activities,
  activitySchedules,
  appointments,
  contacts,
  customers,
  subscriptionBillingCycles,
  subscriptionMonthSchedules,
  trainingSubscriptions,
} from "../db/schema";
import type { Db } from "../db/client";
import { renovar } from "./anotar.service";

/** renovar con un horario del mes anterior que ya no está vigente: el error dice cuál. */
const pgClient = postgres("postgresql://piubella:piubella@localhost:5499/piubella", {
  max: 1,
  fetch_types: false,
  prepare: false,
});
const db = drizzle(pgClient, { schema }) as unknown as Db;

const QA = "ZZ_QA_RENOVAR";
// Martes 20 de octubre de 2026, 11:00 ART.
const AHORA = new Date("2026-10-20T14:00:00Z");

let subId = "";

async function limpiar() {
  const acts = await db.select({ id: activities.id }).from(activities).where(like(activities.name, `${QA}%`));
  const actIds = acts.map((a) => a.id);
  const cts = await db.select({ id: contacts.id }).from(contacts).where(like(contacts.name, `${QA}%`));
  for (const ct of cts) {
    const cus = await db.select({ id: customers.id }).from(customers).where(eq(customers.contactId, ct.id));
    for (const cu of cus) {
      await db.delete(appointments).where(eq(appointments.customerId, cu.id));
      const subs = await db.select({ id: trainingSubscriptions.id }).from(trainingSubscriptions).where(eq(trainingSubscriptions.customerId, cu.id));
      for (const s of subs) {
        const cys = await db.select({ id: subscriptionBillingCycles.id }).from(subscriptionBillingCycles).where(eq(subscriptionBillingCycles.trainingSubscriptionId, s.id));
        if (cys.length) await db.delete(subscriptionMonthSchedules).where(inArray(subscriptionMonthSchedules.billingCycleId, cys.map((c) => c.id)));
        await db.delete(subscriptionBillingCycles).where(eq(subscriptionBillingCycles.trainingSubscriptionId, s.id));
      }
      await db.delete(trainingSubscriptions).where(eq(trainingSubscriptions.customerId, cu.id));
      await db.delete(customers).where(eq(customers.id, cu.id));
    }
    await db.delete(contacts).where(eq(contacts.id, ct.id));
  }
  if (actIds.length) {
    await db.delete(activitySchedules).where(inArray(activitySchedules.activityId, actIds));
    await db.delete(activities).where(inArray(activities.id, actIds));
  }
}

beforeAll(async () => {
  await limpiar();
  const [a] = await db
    .insert(activities)
    .values({ name: `${QA}_Pilates`, activityType: "class", classesPerMonth: 4, monthlyBasePrice: "8000", isActive: true })
    .returning({ id: activities.id });
  // Lunes 10:00, vigente sólo hasta fin de septiembre: en octubre ya no existe.
  const [sch] = await db
    .insert(activitySchedules)
    .values({ activityId: a!.id, dayOfWeek: 1, startTime: "10:00:00", endTime: "11:00:00", validUntil: "2026-09-30", isActive: true })
    .returning({ id: activitySchedules.id });
  const [ct] = await db.insert(contacts).values({ name: `${QA}_ANA` }).returning({ id: contacts.id });
  const [cu] = await db.insert(customers).values({ contactId: ct!.id }).returning({ id: customers.id });
  const [s] = await db
    .insert(trainingSubscriptions)
    .values({ activityId: a!.id, customerId: cu!.id, subscriptionStartDate: "2026-09-01", status: "active", monthlyAmount: "8000" })
    .returning({ id: trainingSubscriptions.id });
  subId = s!.id;
  const [cy] = await db
    .insert(subscriptionBillingCycles)
    .values({ trainingSubscriptionId: subId, billingMonth: "2026-09", billingPeriodStart: "2026-09-01", billingPeriodEnd: "2026-09-30", amountDue: "8000" })
    .returning({ id: subscriptionBillingCycles.id });
  await db.insert(subscriptionMonthSchedules).values({ billingCycleId: cy!.id, activityScheduleId: sch!.id });
});

afterAll(async () => {
  await limpiar();
  await pgClient.end();
});

describe("renovar", () => {
  it("si un horario del mes anterior ya no está vigente, el error dice cuál", async () => {
    await expect(renovar(db, { subscriptionId: subId, mes: "2026-10", ahora: AHORA })).rejects.toMatchObject({
      status: 400,
      message: "El horario Lun 10:00 ya no está vigente: anotala al mes eligiendo los horarios",
    });
  });
});
