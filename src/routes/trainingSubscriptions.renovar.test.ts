import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq, inArray, like, sql } from "drizzle-orm";
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
import type { AppBindings, Variables } from "../env";
import { auth } from "../middleware/auth";
import { mesAnterior } from "../lib/time";
import { trainingSubscriptionsRouter } from "./trainingSubscriptions";
import { trainingSubscriptionsRepository } from "../repositories/trainingSubscriptionsRepository";
import { trainingSubscriptionsService } from "../services/trainingSubscriptionsService";
import { renovar } from "../services/anotar.service";

// Renovar el mes y horarios del mes en admin/list, contra Postgres local.
const LOCAL_DB_URL = "postgresql://piubella:piubella@localhost:5499/piubella";
const QA = "ZZ_QA_RENOVAR";

const pgClient = postgres(LOCAL_DB_URL, { max: 1, fetch_types: false, prepare: false });
const db = drizzle(pgClient, { schema }) as unknown as Db;

const API_KEY = "qa-renovar-test-key";
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

// El servicio y la ruta usan `ahora`/Date: se fija el reloj (sólo Date) para no depender de la fecha real.
// Martes 20 de octubre de 2026, 11:00 ART.
const AHORA = new Date("2026-10-20T14:00:00Z");

// Mes actual ART según la MISMA expresión que usa admin/list (el now() de Postgres).
async function mesActualSql(): Promise<string> {
  const r = (await db.execute(
    sql`SELECT to_char((now() AT TIME ZONE 'America/Argentina/Buenos_Aires'), 'YYYY-MM') AS m`,
  )) as unknown as Array<{ m: string }>;
  return r[0]!.m;
}

let clientaId = "";
let actividadId = "";
let schLun9 = "";
let schMar10 = "";
let subId = "";

async function limpiar() {
  const cts = await db.select({ id: contacts.id }).from(contacts).where(like(contacts.name, `${QA}%`));
  for (const ct of cts) {
    const cus = await db.select({ id: customers.id }).from(customers).where(eq(customers.contactId, ct.id));
    for (const cu of cus) {
      await db.delete(appointments).where(eq(appointments.customerId, cu.id));
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
  const acts = await db.select({ id: activities.id }).from(activities).where(like(activities.name, `${QA}%`));
  const ids = acts.map((a) => a.id);
  if (ids.length) {
    await db.delete(appointments).where(inArray(appointments.activityId, ids));
    await db.delete(activitySchedules).where(inArray(activitySchedules.activityId, ids));
    await db.delete(activities).where(inArray(activities.id, ids));
  }
}

async function crearCiclo(mes: string, horarios: string[]) {
  const [c] = await db
    .insert(subscriptionBillingCycles)
    .values({
      trainingSubscriptionId: subId,
      billingMonth: mes,
      billingPeriodStart: `${mes}-01`,
      billingPeriodEnd: `${mes}-28`,
      amountDue: "8000",
    })
    .returning({ id: subscriptionBillingCycles.id });
  if (horarios.length) {
    await db
      .insert(subscriptionMonthSchedules)
      .values(horarios.map((h) => ({ billingCycleId: c!.id, activityScheduleId: h })));
  }
  return c!.id;
}

async function horariosDelCiclo(mes: string) {
  const filas = await db
    .select({ s: subscriptionMonthSchedules.activityScheduleId, m: subscriptionBillingCycles.billingMonth })
    .from(subscriptionMonthSchedules)
    .innerJoin(subscriptionBillingCycles, eq(subscriptionBillingCycles.id, subscriptionMonthSchedules.billingCycleId))
    .where(eq(subscriptionBillingCycles.trainingSubscriptionId, subId));
  return filas.filter((f) => f.m === mes).map((f) => f.s).sort();
}

beforeAll(async () => {
  await limpiar();
  const [ct] = await db.insert(contacts).values({ name: `${QA}_CLIENTA` }).returning({ id: contacts.id });
  const [cu] = await db.insert(customers).values({ contactId: ct!.id }).returning({ id: customers.id });
  clientaId = cu!.id;
  const [ac] = await db
    .insert(activities)
    .values({ name: `${QA}_Pilates`, activityType: "class", classesPerMonth: 8, monthlyBasePrice: "8000", isActive: true })
    .returning({ id: activities.id });
  actividadId = ac!.id;
  const mk = async (dow: number, ini: string, fin: string) =>
    (
      await db
        .insert(activitySchedules)
        .values({ activityId: actividadId, dayOfWeek: dow, startTime: ini, endTime: fin, isActive: true })
        .returning({ id: activitySchedules.id })
    )[0]!.id;
  schMar10 = await mk(2, "10:00:00", "11:00:00");
  schLun9 = await mk(1, "09:00:00", "10:00:00");
});

beforeEach(async () => {
  if (subId) {
    await db.delete(appointments).where(eq(appointments.customerId, clientaId));
    await db.delete(subscriptionBillingCycles).where(eq(subscriptionBillingCycles.trainingSubscriptionId, subId));
    await db.delete(trainingSubscriptions).where(eq(trainingSubscriptions.id, subId));
  }
  const [s] = await db
    .insert(trainingSubscriptions)
    .values({
      activityId: actividadId,
      customerId: clientaId,
      subscriptionStartDate: "2026-01-01",
      status: "active",
      monthlyAmount: "9500",
    })
    .returning({ id: trainingSubscriptions.id });
  subId = s!.id;
});

afterAll(async () => {
  await limpiar();
  await pgClient.end();
});

describe("renovar (servicio)", () => {
  it("copia los horarios del mes anterior, usa monthly_amount y crea los turnos que faltan", async () => {
    await crearCiclo("2026-09", [schMar10, schLun9]);
    const r = await renovar(db, { subscriptionId: subId, mes: "2026-10", ahora: AHORA });
    expect(r.subscriptionId).toBe(subId);
    expect(r.anotadas).toBeGreaterThan(0);
    expect(await horariosDelCiclo("2026-10")).toEqual([schLun9, schMar10].sort());
    const [ciclo] = await db
      .select()
      .from(subscriptionBillingCycles)
      .where(eq(subscriptionBillingCycles.id, r.billingCycleId));
    expect(Number(ciclo!.amountDue)).toBe(9500);
    const turnos = await db.select().from(appointments).where(eq(appointments.customerId, clientaId));
    expect(turnos).toHaveLength(r.anotadas);
  });

  it.each(["cancelled", "paused"] as const)("suscripción %s: 400 y no crea nada", async (status) => {
    await crearCiclo("2026-09", [schMar10]);
    await db.update(trainingSubscriptions).set({ status }).where(eq(trainingSubscriptions.id, subId));
    await expect(renovar(db, { subscriptionId: subId, mes: "2026-10", ahora: AHORA })).rejects.toMatchObject({
      status: 400,
      message: status === "cancelled" ? "La suscripción está cancelada" : "La suscripción está pausada",
    });
    expect(await horariosDelCiclo("2026-10")).toEqual([]);
    const todas = await db.select().from(trainingSubscriptions).where(eq(trainingSubscriptions.customerId, clientaId));
    expect(todas).toHaveLength(1);
  });

  it("sin ciclo anterior con horarios: 400", async () => {
    await crearCiclo("2026-09", []);
    await expect(renovar(db, { subscriptionId: subId, mes: "2026-10", ahora: AHORA })).rejects.toMatchObject({
      status: 400,
      message: "No tiene horarios del mes anterior para repetir",
    });
  });
});

describe("POST /training-subscriptions/:id/renovar", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["Date"], now: AHORA }));
  afterEach(() => vi.useRealTimers());

  it("201 con el resultado y los horarios copiados", async () => {
    await crearCiclo("2026-09", [schMar10, schLun9]);
    const res = await pedir("POST", `/training-subscriptions/${subId}/renovar`, { mes: "2026-10" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { subscriptionId: string; billingCycleId: string };
    expect(body.subscriptionId).toBe(subId);
    expect(await horariosDelCiclo("2026-10")).toEqual([schLun9, schMar10].sort());
  });

  it("suscripción inexistente: 404", async () => {
    const res = await pedir("POST", `/training-subscriptions/00000000-0000-4000-8000-000000000000/renovar`, {
      mes: "2026-10",
    });
    expect(res.status).toBe(404);
  });

  it("sin mes anterior: 400 con el mensaje", async () => {
    const res = await pedir("POST", `/training-subscriptions/${subId}/renovar`, { mes: "2026-10" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("No tiene horarios del mes anterior para repetir");
  });

  it.each(["cancelled", "paused"] as const)("suscripción %s: 400", async (status) => {
    await crearCiclo("2026-09", [schMar10]);
    await db.update(trainingSubscriptions).set({ status }).where(eq(trainingSubscriptions.id, subId));
    expect((await pedir("POST", `/training-subscriptions/${subId}/renovar`, { mes: "2026-10" })).status).toBe(400);
  });

  it("mes mal formado: 400", async () => {
    expect((await pedir("POST", `/training-subscriptions/${subId}/renovar`, { mes: "2026-13" })).status).toBe(400);
  });
});

describe("GET /training-subscriptions/admin/list — horariosDelMes", () => {
  const fila = async () => {
    const res = await pedir("GET", `/training-subscriptions/admin/list?activityId=${actividadId}`);
    expect(res.status).toBe(200);
    return ((await res.json()) as { data: Array<Record<string, unknown>> }).data.find((s) => s.id === subId);
  };

  it("sin ciclo del mes: []", async () => {
    expect((await fila())!.horariosDelMes).toEqual([]);
  });

  it("formato 'Lun 09:00', de lunes a domingo y por hora; ignora otros meses", async () => {
    const actual = await mesActualSql();
    await crearCiclo(actual, [schMar10, schLun9]);
    await crearCiclo(mesAnterior(actual), [schMar10]);
    expect((await fila())!.horariosDelMes).toEqual(["Lun 09:00", "Mar 10:00"]);
  });
});
