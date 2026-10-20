import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq, inArray, like } from "drizzle-orm";
import * as schema from "../db/schema";
import {
  activities,
  cashRegister,
  contacts,
  customers,
  invoices,
  lineItems,
  payments,
  subscriptionBillingCycles,
  trainingSubscriptions,
} from "../db/schema";
import type { Db } from "../db/client";
import type { AppBindings, Variables } from "../env";
import { auth } from "../middleware/auth";
import { todayLocal } from "../lib/time";
import { trainingSubscriptionsRouter } from "./trainingSubscriptions";
import { trainingSubscriptionsRepository } from "../repositories/trainingSubscriptionsRepository";
import { trainingSubscriptionsService } from "../services/trainingSubscriptionsService";

// Cobro de la cuota del mes contra Postgres local: mismo harness que
// routes/crm/compras.test.ts (Hono + x-api-key, que entra como admin).
const LOCAL_DB_URL = "postgresql://piubella:piubella@localhost:5499/piubella";
const QA = "ZZ_QA_CUOTA_RUTA";
const MES = "2026-11";

const pgClient = postgres(LOCAL_DB_URL, { max: 1, fetch_types: false, prepare: false });
const db = drizzle(pgClient, { schema }) as unknown as Db;

const API_KEY = "qa-cuota-test-key";
const ENV = {
  HYPERDRIVE: { connectionString: LOCAL_DB_URL },
  API_KEY,
  ARCA_MODE: "mock",
} as unknown as AppBindings;

const app = new Hono<{ Bindings: AppBindings; Variables: Variables }>();
app.onError((err, c) => {
  if ("status" in err && typeof err.status === "number") {
    return c.json({ error: err.message }, err.status as 400 | 401 | 403 | 404 | 409 | 422 | 500);
  }
  return c.json({ error: "Internal server error" }, 500);
});
// index.ts inyecta el db en los singletons en el primer request; acá, a mano.
trainingSubscriptionsRepository.setDb(db);
trainingSubscriptionsService.setDb(db);
app.use("*", auth);
app.route("/", trainingSubscriptionsRouter);

function pedir(method: string, path: string, body?: unknown) {
  return app.request(
    path,
    {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    ENV,
  );
}

let clientaId = "";
let actividadId = "";
let subId = "";

async function limpiarCobros() {
  if (!clientaId) return;
  const pagos = await db.select({ id: payments.id }).from(payments).where(eq(payments.customerId, clientaId));
  const ids = pagos.map((p) => p.id);
  if (ids.length > 0) {
    await db.delete(cashRegister).where(inArray(cashRegister.paymentId, ids));
    await db.delete(lineItems).where(inArray(lineItems.paymentId, ids));
  }
  const facturas = await db.select({ id: invoices.id }).from(invoices).where(eq(invoices.customerId, clientaId));
  if (facturas.length > 0) {
    await db.delete(lineItems).where(inArray(lineItems.invoiceId, facturas.map((f) => f.id)));
  }
  await db.delete(payments).where(eq(payments.customerId, clientaId));
  await db.delete(invoices).where(eq(invoices.customerId, clientaId));
}

async function limpiar() {
  await limpiarCobros();
  const cts = await db.select({ id: contacts.id }).from(contacts).where(like(contacts.name, `${QA}%`));
  for (const ct of cts) {
    const cus = await db.select({ id: customers.id }).from(customers).where(eq(customers.contactId, ct.id));
    for (const cu of cus) {
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

async function crearSuscripcion(status = "active") {
  const [s] = await db
    .insert(trainingSubscriptions)
    .values({
      activityId: actividadId,
      customerId: clientaId,
      subscriptionStartDate: "2026-11-01",
      status,
      monthlyAmount: "8000",
    })
    .returning({ id: trainingSubscriptions.id });
  return s!.id;
}

beforeAll(async () => {
  await limpiar();
  const [ct] = await db.insert(contacts).values({ name: `${QA}_CLIENTA` }).returning({ id: contacts.id });
  const [cu] = await db.insert(customers).values({ contactId: ct!.id }).returning({ id: customers.id });
  clientaId = cu!.id;
  const [ac] = await db
    .insert(activities)
    .values({ name: `${QA}_Pilates Power 360`, activityType: "class", classesPerMonth: 8, monthlyBasePrice: "8000" })
    .returning({ id: activities.id });
  actividadId = ac!.id;
});

beforeEach(async () => {
  await limpiarCobros();
  if (subId) {
    await db
      .delete(subscriptionBillingCycles)
      .where(eq(subscriptionBillingCycles.trainingSubscriptionId, subId));
    await db.delete(trainingSubscriptions).where(eq(trainingSubscriptions.id, subId));
  }
  subId = await crearSuscripcion();
});

afterAll(async () => {
  await limpiar();
  await pgClient.end();
});

const cobrar = (body: Record<string, unknown>) =>
  pedir("POST", `/training-subscriptions/${subId}/cobrar`, {
    mes: MES,
    method: "cash",
    wantsInvoice: false,
    ...body,
  });

async function ciclos() {
  return db
    .select()
    .from(subscriptionBillingCycles)
    .where(eq(subscriptionBillingCycles.trainingSubscriptionId, subId));
}

describe("GET /training-subscriptions/:id/cuota", () => {
  it("sin ciclo devuelve la cuota entera y no crea nada", async () => {
    const res = await pedir("GET", `/training-subscriptions/${subId}/cuota?mes=${MES}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      billingCycleId: null,
      mes: MES,
      cuota: 8000,
      pagado: 0,
      debe: 8000,
      isPaid: false,
    });
    expect(await ciclos()).toHaveLength(0);
  });

  it("mes mal formado: 400", async () => {
    expect((await pedir("GET", `/training-subscriptions/${subId}/cuota?mes=2026-13`)).status).toBe(400);
    expect((await pedir("GET", `/training-subscriptions/${subId}/cuota`)).status).toBe(400);
  });
});

describe("POST /training-subscriptions/:id/cobrar", () => {
  it("cobro parcial: crea el ciclo, Debe 5000, pago vinculado, línea con el concepto y caja si es efectivo", async () => {
    const res = await cobrar({ amount: 3000 });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { cuota: Record<string, unknown>; payment: { id: string } };
    expect(body.cuota).toMatchObject({ mes: MES, cuota: 8000, pagado: 3000, debe: 5000, isPaid: false });

    const [ciclo] = await ciclos();
    expect(ciclo!.isPaid).toBe(false);
    expect(Number(ciclo!.amountDue)).toBe(8000);

    const pagos = await db.select().from(payments).where(eq(payments.customerId, clientaId));
    expect(pagos).toHaveLength(1);
    expect(pagos[0]).toMatchObject({
      subscriptionBillingCycleId: ciclo!.id,
      customerPurchaseId: null,
      status: "confirmed",
      paymentMethod: "cash",
    });
    expect(Number(pagos[0]!.amount)).toBe(3000);

    const caja = await db.select().from(cashRegister).where(eq(cashRegister.paymentId, pagos[0]!.id));
    expect(caja).toHaveLength(1);
    expect(Number(caja[0]!.amount)).toBe(3000);

    const lineas = await db.select().from(lineItems).where(eq(lineItems.paymentId, pagos[0]!.id));
    expect(lineas).toHaveLength(1);
    expect(lineas[0]!.description).toBe(`${QA}_Pilates Power 360 — noviembre 2026`);
  });

  it("el segundo cobro que completa la cuota marca el mes pagado", async () => {
    await cobrar({ amount: 3000 });
    const res = await cobrar({ amount: 5000, method: "bank_transfer" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { cuota: Record<string, unknown> };
    expect(body.cuota).toMatchObject({ pagado: 8000, debe: 0, isPaid: true });

    const [ciclo] = await ciclos();
    expect(ciclo!.isPaid).toBe(true);
    expect(Number(ciclo!.amountPaid)).toBe(8000);
    expect(ciclo!.paymentDate).not.toBeNull();
    expect(ciclo!.paymentMethod).toBe("bank_transfer");
  });

  it("cobrar más de lo que se debe: 400 con el mensaje exacto y sin pagos", async () => {
    const res = await cobrar({ amount: 9000 });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "No se puede cobrar: el monto supera lo que debe ($8000)" });
    expect(await db.select().from(payments).where(eq(payments.customerId, clientaId))).toHaveLength(0);
  });

  it("un mes ya pagado no admite más cobros", async () => {
    await cobrar({ amount: 8000 });
    const res = await cobrar({ amount: 1 });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("supera lo que debe ($0)");
  });

  it("suscripción cancelada: 400", async () => {
    await db.update(trainingSubscriptions).set({ status: "cancelled" }).where(eq(trainingSubscriptions.id, subId));
    const res = await cobrar({ amount: 1000 });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "La suscripción está cancelada" });
    expect(await db.select().from(payments).where(eq(payments.customerId, clientaId))).toHaveLength(0);
  });

  it("el ciclo de otro mes no se toca", async () => {
    await cobrar({ amount: 8000, mes: "2026-12" });
    const res = await cobrar({ amount: 2000 });
    expect(res.status).toBe(201);
    const filas = await ciclos();
    const dic = filas.find((c) => c.billingMonth === "2026-12")!;
    const nov = filas.find((c) => c.billingMonth === MES)!;
    expect(dic.isPaid).toBe(true);
    expect(nov.isPaid).toBe(false);
    expect(Number(nov.amountPaid ?? 0)).toBe(0);
  });

  it("con factura: genera el borrador y el pago declarado queda vinculado al ciclo", async () => {
    const res = await cobrar({ amount: 8000, wantsInvoice: true });
    expect(res.status).toBe(201);
    const fact = await db.select().from(invoices).where(eq(invoices.customerId, clientaId));
    expect(fact).toHaveLength(1);
    expect(Number(fact[0]!.totalAmount)).toBe(8000);
    const [pago] = await db.select().from(payments).where(eq(payments.customerId, clientaId));
    expect(pago).toMatchObject({ isDeclared: true, invoiceId: fact[0]!.id });
    expect(pago!.subscriptionBillingCycleId).not.toBeNull();
  });

  it("monto no positivo: 400", async () => {
    expect((await cobrar({ amount: 0 })).status).toBe(400);
  });
});

describe("GET /training-subscriptions/admin/list", () => {
  it("trae cuotaDelMes y debeDelMes del mes actual en ART", async () => {
    const mesActual = todayLocal().slice(0, 7);
    const res0 = await pedir("GET", `/training-subscriptions/admin/list?activityId=${actividadId}`);
    expect(res0.status).toBe(200);
    const fila0 = ((await res0.json()) as { data: Array<Record<string, unknown>> }).data.find((s) => s.id === subId);
    expect(fila0).toMatchObject({ cuotaDelMes: 8000, debeDelMes: 8000 });

    expect(
      (await pedir("POST", `/training-subscriptions/${subId}/cobrar`, {
        mes: mesActual,
        amount: 3000,
        method: "cash",
        wantsInvoice: false,
      })).status,
    ).toBe(201);
    const res1 = await pedir("GET", `/training-subscriptions/admin/list?activityId=${actividadId}`);
    const fila1 = ((await res1.json()) as { data: Array<Record<string, unknown>> }).data.find((s) => s.id === subId);
    expect(fila1).toMatchObject({ cuotaDelMes: 8000, debeDelMes: 5000 });
  });

  it("regla de Debe: un ciclo histórico is_paid=true sin pagos vinculados debe 0", async () => {
    await db.insert(subscriptionBillingCycles).values({
      trainingSubscriptionId: subId,
      billingMonth: todayLocal().slice(0, 7),
      billingPeriodStart: `${todayLocal().slice(0, 7)}-01`,
      billingPeriodEnd: `${todayLocal().slice(0, 7)}-28`,
      amountDue: "8000",
      amountPaid: "8000",
      isPaid: true,
      paymentDate: new Date(),
    });
    const res = await pedir("GET", `/training-subscriptions/admin/list?activityId=${actividadId}`);
    const fila = ((await res.json()) as { data: Array<Record<string, unknown>> }).data.find((s) => s.id === subId);
    expect(fila).toMatchObject({ cuotaDelMes: 8000, debeDelMes: 0 });
  });
});
