import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq, like } from "drizzle-orm";
import * as schema from "../db/schema";
import {
  activities,
  contacts,
  customers,
  payments,
  subscriptionBillingCycles,
  trainingSubscriptions,
} from "../db/schema";
import type { Db } from "../db/client";
import { asegurarCicloDelMes, getCuotaDelMes, marcarMesSiCorresponde } from "./cuotas.repo";

/** Cuota mensual de una suscripción a una actividad, contra la base local. */
const pgClient = postgres("postgresql://piubella:piubella@localhost:5499/piubella", {
  max: 1,
  fetch_types: false,
  prepare: false,
});
const db = drizzle(pgClient, { schema }) as unknown as Db;

const QA = "ZZ_QA_CUOTA_REPO";
const MES = "2026-11";
const OTRO_MES = "2026-12";

let clientaId = "";
let actividadId = "";
let subId = "";

async function limpiar() {
  const cts = await db.select({ id: contacts.id }).from(contacts).where(like(contacts.name, `${QA}%`));
  for (const ct of cts) {
    const cus = await db.select({ id: customers.id }).from(customers).where(eq(customers.contactId, ct.id));
    for (const cu of cus) {
      await db.delete(payments).where(eq(payments.customerId, cu.id));
      const subs = await db
        .select({ id: trainingSubscriptions.id })
        .from(trainingSubscriptions)
        .where(eq(trainingSubscriptions.customerId, cu.id));
      for (const s of subs) {
        await db
          .delete(subscriptionBillingCycles)
          .where(eq(subscriptionBillingCycles.trainingSubscriptionId, s.id));
      }
      await db.delete(trainingSubscriptions).where(eq(trainingSubscriptions.customerId, cu.id));
      await db.delete(customers).where(eq(customers.id, cu.id));
    }
    await db.delete(contacts).where(eq(contacts.id, ct.id));
  }
  await db.delete(activities).where(like(activities.name, `${QA}%`));
}

beforeAll(async () => {
  await limpiar();
  const [ct] = await db.insert(contacts).values({ name: `${QA}_CLIENTA` }).returning({ id: contacts.id });
  const [cu] = await db.insert(customers).values({ contactId: ct!.id }).returning({ id: customers.id });
  clientaId = cu!.id;
  const [ac] = await db
    .insert(activities)
    .values({ name: `${QA}_Pilates`, activityType: "class", classesPerMonth: 8, monthlyBasePrice: "8000" })
    .returning({ id: activities.id });
  actividadId = ac!.id;
});

beforeEach(async () => {
  await db.delete(payments).where(eq(payments.customerId, clientaId));
  if (subId) {
    await db
      .delete(subscriptionBillingCycles)
      .where(eq(subscriptionBillingCycles.trainingSubscriptionId, subId));
    await db.delete(trainingSubscriptions).where(eq(trainingSubscriptions.id, subId));
  }
  const [s] = await db
    .insert(trainingSubscriptions)
    .values({
      activityId: actividadId,
      customerId: clientaId,
      subscriptionStartDate: "2026-11-01",
      status: "active",
      monthlyAmount: "8000",
    })
    .returning({ id: trainingSubscriptions.id });
  subId = s!.id;
});

afterAll(async () => {
  await limpiar();
  await pgClient.end();
});

async function pagoDelCiclo(cicloId: string, amount: string, method = "cash", status = "confirmed") {
  await db.insert(payments).values({
    customerId: clientaId,
    subscriptionBillingCycleId: cicloId,
    amount,
    paymentMethod: method,
    status,
    paymentDate: new Date(),
  });
}

describe("getCuotaDelMes", () => {
  it("sin ciclo: la cuota es el monthly_amount y se debe entera", async () => {
    expect(await getCuotaDelMes(db, subId, MES)).toEqual({
      billingCycleId: null,
      mes: MES,
      cuota: 8000,
      pagado: 0,
      debe: 8000,
      isPaid: false,
    });
  });

  it("con ciclo: cuota = amount_due, pagado = pagos confirmados vinculados, ignora pendientes", async () => {
    const [c] = await db
      .insert(subscriptionBillingCycles)
      .values({
        trainingSubscriptionId: subId,
        billingMonth: MES,
        billingPeriodStart: "2026-11-01",
        billingPeriodEnd: "2026-11-30",
        amountDue: "16000",
        isPaid: false,
      })
      .returning({ id: subscriptionBillingCycles.id });
    await pagoDelCiclo(c!.id, "3000.50");
    await pagoDelCiclo(c!.id, "999", "cash", "pending");
    expect(await getCuotaDelMes(db, subId, MES)).toEqual({
      billingCycleId: c!.id,
      mes: MES,
      cuota: 16000,
      pagado: 3000.5,
      debe: 12999.5,
      isPaid: false,
    });
  });

  it("regla de Debe: un ciclo is_paid=true debe 0 aunque no tenga pagos vinculados (histórico)", async () => {
    const [c] = await db
      .insert(subscriptionBillingCycles)
      .values({
        trainingSubscriptionId: subId,
        billingMonth: MES,
        billingPeriodStart: "2026-11-01",
        billingPeriodEnd: "2026-11-30",
        amountDue: "8000",
        isPaid: true,
      })
      .returning({ id: subscriptionBillingCycles.id });
    const r = await getCuotaDelMes(db, subId, MES);
    expect(r).toMatchObject({ billingCycleId: c!.id, cuota: 8000, pagado: 0, debe: 0, isPaid: true });
  });

  it("suscripción inexistente: 404", async () => {
    await expect(
      getCuotaDelMes(db, "00000000-0000-0000-0000-000000000000", MES),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe("asegurarCicloDelMes", () => {
  it("crea el ciclo del mes con su período y amount_due = monthly_amount, y es idempotente", async () => {
    const id1 = await asegurarCicloDelMes(db, subId, MES);
    const id2 = await asegurarCicloDelMes(db, subId, MES);
    expect(id2).toBe(id1);
    const filas = await db
      .select()
      .from(subscriptionBillingCycles)
      .where(eq(subscriptionBillingCycles.trainingSubscriptionId, subId));
    expect(filas).toHaveLength(1);
    expect(filas[0]).toMatchObject({
      id: id1,
      billingMonth: MES,
      billingPeriodStart: "2026-11-01",
      billingPeriodEnd: "2026-11-30",
      isPaid: false,
    });
    expect(Number(filas[0]!.amountDue)).toBe(8000);
  });

  it("no toca el ciclo de otro mes", async () => {
    const otro = await asegurarCicloDelMes(db, subId, OTRO_MES);
    const este = await asegurarCicloDelMes(db, subId, MES);
    expect(este).not.toBe(otro);
    const [fila] = await db
      .select()
      .from(subscriptionBillingCycles)
      .where(eq(subscriptionBillingCycles.id, otro));
    expect(fila!.billingPeriodEnd).toBe("2026-12-31");
  });
});

describe("marcarMesSiCorresponde", () => {
  it("con Debe > 0 no marca nada", async () => {
    const id = await asegurarCicloDelMes(db, subId, MES);
    await pagoDelCiclo(id, "3000");
    await marcarMesSiCorresponde(db, id);
    const [c] = await db.select().from(subscriptionBillingCycles).where(eq(subscriptionBillingCycles.id, id));
    expect(c).toMatchObject({ isPaid: false, paymentDate: null });
  });

  it("con Debe = 0 marca pagado, suma amount_paid y copia el método del último pago", async () => {
    const id = await asegurarCicloDelMes(db, subId, MES);
    await pagoDelCiclo(id, "3000", "cash");
    await new Promise((r) => setTimeout(r, 15));
    await pagoDelCiclo(id, "5000", "bank_transfer");
    await marcarMesSiCorresponde(db, id);
    const [c] = await db.select().from(subscriptionBillingCycles).where(eq(subscriptionBillingCycles.id, id));
    expect(c!.isPaid).toBe(true);
    expect(c!.paymentDate).not.toBeNull();
    expect(Number(c!.amountPaid)).toBe(8000);
    expect(c!.paymentMethod).toBe("bank_transfer");
  });
});
