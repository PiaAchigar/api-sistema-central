import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq, like, sql } from "drizzle-orm";
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
import { debeDeCicloSql, getCuotaDeCiclo } from "./cuotas.repo";

/**
 * La regla de Debe vive dos veces: en SQL (`debeDeCicloSql`, la usa la grilla de
 * clases) y en TS (`getCuotaDeCiclo`, la usa el cobro). Si divergen, la grilla
 * muestra un Debe distinto del que cobra el sistema. Este test las compara sobre
 * el mismo ciclo, para cada caso.
 */
const pgClient = postgres("postgresql://piubella:piubella@localhost:5499/piubella", {
  max: 1,
  fetch_types: false,
  prepare: false,
});
const db = drizzle(pgClient, { schema }) as unknown as Db;

const QA = "ZZ_QA_CUOTA_PARIDAD";
let clientaId = "";
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
        await db.delete(subscriptionBillingCycles).where(eq(subscriptionBillingCycles.trainingSubscriptionId, s.id));
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
  const [s] = await db
    .insert(trainingSubscriptions)
    .values({ activityId: ac!.id, customerId: clientaId, subscriptionStartDate: "2027-01-01", status: "active", monthlyAmount: "8000" })
    .returning({ id: trainingSubscriptions.id });
  subId = s!.id;
});

afterAll(async () => {
  await limpiar();
  await pgClient.end();
});

type Caso = {
  nombre: string;
  mes: string;
  pagado?: boolean;
  amountDue?: string | null;
  pagos?: { monto: string; estado: string }[];
  esperado: number;
};

const casos: Caso[] = [
  { nombre: "ciclo impago con pagos parciales", mes: "2027-01", amountDue: "8000", pagos: [{ monto: "3000", estado: "confirmed" }, { monto: "1500.50", estado: "confirmed" }], esperado: 3499.5 },
  { nombre: "ciclo pagado (is_paid) aunque no tenga pagos", mes: "2027-02", pagado: true, amountDue: "8000", esperado: 0 },
  { nombre: "ciclo sin pagos", mes: "2027-03", amountDue: "8000", esperado: 8000 },
  { nombre: "pago no confirmado: no descuenta", mes: "2027-04", amountDue: "8000", pagos: [{ monto: "5000", estado: "pending" }, { monto: "1000", estado: "confirmed" }], esperado: 7000 },
  { nombre: "pagó de más: el Debe no es negativo", mes: "2027-05", amountDue: "8000", pagos: [{ monto: "9000", estado: "confirmed" }], esperado: 0 },
  { nombre: "sin amount_due: usa el monthly_amount de la suscripción", mes: "2027-06", amountDue: null, pagos: [{ monto: "2000", estado: "confirmed" }], esperado: 6000 },
];

describe("regla de Debe: SQL y TS coinciden", () => {
  it.each(casos)("$nombre", async (c) => {
    const [ciclo] = await db
      .insert(subscriptionBillingCycles)
      .values({
        trainingSubscriptionId: subId,
        billingMonth: c.mes,
        billingPeriodStart: `${c.mes}-01`,
        billingPeriodEnd: `${c.mes}-28`,
        amountDue: c.amountDue === undefined ? "8000" : c.amountDue,
        isPaid: c.pagado ?? false,
      })
      .returning({ id: subscriptionBillingCycles.id });
    for (const p of c.pagos ?? []) {
      await db.insert(payments).values({
        customerId: clientaId,
        subscriptionBillingCycleId: ciclo!.id,
        amount: p.monto,
        paymentMethod: "cash",
        status: p.estado,
        paymentDate: new Date(),
      });
    }

    const ts = await getCuotaDeCiclo(db, ciclo!.id);
    const filas = (await db.execute(sql`
      SELECT ${debeDeCicloSql("cy", "s")} AS debe
      FROM subscription_billing_cycles cy
      JOIN training_subscriptions s ON s.id = cy.training_subscription_id
      WHERE cy.id = ${ciclo!.id}
    `)) as unknown as { debe: number }[];

    expect(Number(filas[0]!.debe)).toBe(ts!.debe);
    expect(ts!.debe).toBe(c.esperado);
  });
});
