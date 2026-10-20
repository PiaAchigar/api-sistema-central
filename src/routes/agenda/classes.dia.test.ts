import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq, inArray, like, sql } from "drizzle-orm";
import * as schema from "../../db/schema";
import {
  activities,
  activitySchedules,
  appointments,
  contacts,
  customers,
  subscriptionBillingCycles,
  trainingSubscriptions,
} from "../../db/schema";
import type { Db } from "../../db/client";
import type { AppBindings, Variables } from "../../env";
import { asegurarCicloDelMes } from "../../repositories/cuotas.repo";

// El router de suscripciones monta su propio `auth`, que pisaría el rol: se reemplaza por uno que
// lo toma del header x-rol (el resto del middleware, requirePermission incluido, es el real).
vi.mock("../../middleware/auth", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../middleware/auth")>();
  return {
    ...real,
    auth: async (c: any, next: any) => {
      const rol = c.req.header("x-rol") ?? null;
      c.set("userId", rol ? "u-test" : null);
      c.set("userRole", rol);
      await next();
    },
  };
});

const { auth, requireAnyPermission } = await import("../../middleware/auth");
const { classesRouter } = await import("./classes");
const { trainingSubscriptionsRouter } = await import("../trainingSubscriptions");
const { trainingSubscriptionsRepository } = await import("../../repositories/trainingSubscriptionsRepository");
const { trainingSubscriptionsService } = await import("../../services/trainingSubscriptionsService");

const LOCAL_DB_URL = "postgresql://piubella:piubella@localhost:5499/piubella";
const QA = "ZZ_QA_CLASES_DIA";
// Lunes 5 de abril de 2027, 10:00 ART = 13:00 UTC.
const FECHA = "2027-04-05";
const MES = "2027-04";
const INICIO = new Date(`${FECHA}T13:00:00Z`);

const pgClient = postgres(LOCAL_DB_URL, { max: 1, fetch_types: false, prepare: false });
const db = drizzle(pgClient, { schema }) as unknown as Db;
const ENV = { HYPERDRIVE: { connectionString: LOCAL_DB_URL }, ARCA_MODE: "mock" } as unknown as AppBindings;

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
app.route("/classes", classesRouter);
app.route("/", trainingSubscriptionsRouter);
app.get("/solo-config-o-agenda", requireAnyPermission(["config-local", "view"], ["agenda", "view"]), (c) => c.json({ ok: true }));

const pedir = (method: string, path: string, rol: string | null, body?: unknown) =>
  app.request(
    path,
    {
      method,
      headers: { "Content-Type": "application/json", ...(rol ? { "x-rol": rol } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    ENV,
  );

let actId = "";
let schId = "";
let trainingId = "";
let sesionId = "";
let subId = "";
let compraId = "";
let clientaSub = "";
let clientaPrueba = "";
let clientaCapa = "";

async function crearClienta(nombre: string) {
  const [ct] = await db.insert(contacts).values({ name: `${QA}_${nombre}` }).returning({ id: contacts.id });
  const [cu] = await db.insert(customers).values({ contactId: ct!.id }).returning({ id: customers.id });
  return cu!.id;
}

async function limpiar() {
  const cts = await db.select({ id: contacts.id }).from(contacts).where(like(contacts.name, `${QA}%`));
  const cuIds: string[] = [];
  for (const ct of cts) {
    const cus = await db.select({ id: customers.id }).from(customers).where(eq(customers.contactId, ct.id));
    cuIds.push(...cus.map((c) => c.id));
  }
  if (cuIds.length) {
    await db.delete(appointments).where(inArray(appointments.customerId, cuIds));
    await db.execute(sql`DELETE FROM customer_purchase WHERE customer_id IN (${sql.join(cuIds.map((i) => sql`${i}::uuid`), sql`, `)})`);
    const subs = await db
      .select({ id: trainingSubscriptions.id })
      .from(trainingSubscriptions)
      .where(inArray(trainingSubscriptions.customerId, cuIds));
    const subIds = subs.map((s) => s.id);
    if (subIds.length) {
      await db.delete(subscriptionBillingCycles).where(inArray(subscriptionBillingCycles.trainingSubscriptionId, subIds));
      await db.delete(trainingSubscriptions).where(inArray(trainingSubscriptions.id, subIds));
    }
    await db.delete(customers).where(inArray(customers.id, cuIds));
  }
  for (const ct of cts) await db.delete(contacts).where(eq(contacts.id, ct.id));
  const acts = await db.select({ id: activities.id }).from(activities).where(like(activities.name, `${QA}%`));
  const ids = acts.map((a) => a.id);
  if (ids.length) {
    await db.delete(appointments).where(inArray(appointments.activityId, ids));
    await db.delete(activitySchedules).where(inArray(activitySchedules.activityId, ids));
    await db.delete(activities).where(inArray(activities.id, ids));
  }
  await db.execute(sql`DELETE FROM appointments WHERE training_session_id IN (SELECT ts.id FROM training_sessions ts JOIN training t ON t.id = ts.training_id WHERE t.name LIKE ${QA + "%"})`);
  await db.execute(sql`DELETE FROM training_sessions WHERE training_id IN (SELECT id FROM training WHERE name LIKE ${QA + "%"})`);
  await db.execute(sql`DELETE FROM training WHERE name LIKE ${QA + "%"}`);
}

const turno = (customerId: string, extra: Partial<typeof appointments.$inferInsert>) =>
  db.insert(appointments).values({
    customerId, status: "scheduled", appointmentStart: INICIO,
    appointmentEnd: new Date(INICIO.getTime() + 3600_000), durationMinutes: 60, ...extra,
  });

beforeAll(async () => {
  await limpiar();
  const [a] = await db
    .insert(activities)
    .values({ name: `${QA}_Pilates`, activityType: "class", classesPerMonth: 4, monthlyBasePrice: "9000", isActive: true })
    .returning({ id: activities.id });
  actId = a!.id;
  const [s] = await db
    .insert(activitySchedules)
    .values({ activityId: actId, dayOfWeek: 1, startTime: "10:00:00", endTime: "11:00:00", validFrom: FECHA, validUntil: FECHA, capacity: 5, isActive: true })
    .returning({ id: activitySchedules.id });
  schId = s!.id;

  clientaSub = await crearClienta("SUB");
  clientaPrueba = await crearClienta("PRUEBA");
  clientaCapa = await crearClienta("CAPA");

  const [sub] = await db
    .insert(trainingSubscriptions)
    .values({ activityId: actId, customerId: clientaSub, status: "active", monthlyAmount: "9000", subscriptionStartDate: "2027-04-01" })
    .returning({ id: trainingSubscriptions.id });
  subId = sub!.id;
  await asegurarCicloDelMes(db, subId, MES, 9000);
  await turno(clientaSub, { activityId: actId });
  await turno(clientaPrueba, { activityId: actId, isTrial: true });

  const [t] = (await db.execute(sql`
    INSERT INTO training (id, name, max_participants, is_active) VALUES (gen_random_uuid(), ${QA + "_Capa"}, 10, true) RETURNING id`)) as unknown as { id: string }[];
  trainingId = t!.id;
  const [se] = (await db.execute(sql`
    INSERT INTO training_sessions (training_id, session_number, session_date, start_time, end_time, is_active, notes)
    VALUES (${trainingId}, 1, ${FECHA}::date, '15:00'::time, '17:00'::time, true, ${QA}) RETURNING id`)) as unknown as { id: string }[];
  sesionId = se!.id;
  const [cp] = (await db.execute(sql`
    INSERT INTO customer_purchase (customer_id, training_id, description, sessions_total, base_amount, discounted_amount, final_amount, notes)
    VALUES (${clientaCapa}, ${trainingId}, ${QA}, 1, 100, 0, 100, ${QA}) RETURNING id`)) as unknown as { id: string }[];
  compraId = cp!.id;
  await turno(clientaCapa, { trainingSessionId: sesionId, appointmentStart: new Date(`${FECHA}T18:00:00Z`), appointmentEnd: new Date(`${FECHA}T20:00:00Z`) });
});

afterAll(async () => {
  await limpiar();
  await pgClient.end();
});

describe("GET /classes?date= trae los ids que la agenda necesita", () => {
  it("scheduleId en actividades y null en encuentros; subscriptionId y compraId en las anotadas", async () => {
    const res = await pedir("GET", `/classes?date=${FECHA}`, "operator");
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: any[] };

    const clase = data.find((c) => c.subjectId === actId);
    expect(clase.scheduleId).toBe(schId);
    const porNombre = Object.fromEntries(clase.anotadas.map((a: any) => [a.nombre, a]));
    expect(porNombre[`${QA}_SUB`]).toMatchObject({ subscriptionId: subId, compraId: null, debe: 9000 });
    expect(porNombre[`${QA}_PRUEBA`]).toMatchObject({ subscriptionId: null, compraId: null, prueba: true });

    const encuentro = data.find((c) => c.subjectId === trainingId);
    expect(encuentro.scheduleId).toBeNull();
    expect(encuentro.anotadas).toHaveLength(1);
    expect(encuentro.anotadas[0]).toMatchObject({ compraId, subscriptionId: null, debe: 100 });
  });
});

describe("permisos: agenda·view alcanza para mirar, agenda·edit para anotar y cobrar", () => {
  it("requireAnyPermission pasa con cualquiera de los pares y da el mismo 403 si no cumple ninguno", async () => {
    expect((await pedir("GET", "/solo-config-o-agenda", "operator")).status).toBe(200); // sólo el 2º par
    expect((await pedir("GET", "/solo-config-o-agenda", "admin")).status).toBe(200);
    const res = await pedir("GET", "/solo-config-o-agenda", "sales");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
  });

  it("agenda·view: 200 en /cuota, /opciones y /opciones-capacitacion", async () => {
    const cuota = await pedir("GET", `/training-subscriptions/${subId}/cuota?mes=${MES}`, "operator");
    expect(cuota.status).toBe(200);
    const opc = await pedir("GET", `/classes/opciones?activityId=${actId}&customerId=${clientaSub}&mes=${MES}`, "operator");
    expect(opc.status).toBe(200);
    const cap = await pedir("GET", `/classes/opciones-capacitacion?trainingId=${trainingId}&customerId=${clientaCapa}`, "operator");
    expect(cap.status).toBe(200);
    expect(((await cap.json()) as any).data).toMatchObject({ compraId, debe: 100 });
  });

  it("sin agenda ni catálogo: 403 en /cuota, /opciones y /opciones-capacitacion", async () => {
    for (const rol of ["sales", "accountant"]) {
      expect((await pedir("GET", `/training-subscriptions/${subId}/cuota?mes=${MES}`, rol)).status).toBe(403);
      expect((await pedir("GET", `/classes/opciones?activityId=${actId}&customerId=${clientaSub}&mes=${MES}`, rol)).status).toBe(403);
      expect((await pedir("GET", `/classes/opciones-capacitacion?trainingId=${trainingId}&customerId=${clientaCapa}`, rol)).status).toBe(403);
    }
  });

  it("sin agenda·edit: 403 al anotar y al cobrar", async () => {
    for (const rol of ["sales", "accountant"]) {
      expect((await pedir("POST", "/classes/anotar-al-mes", rol, {})).status).toBe(403);
      expect((await pedir("POST", "/classes/anotar-a-clase", rol, {})).status).toBe(403);
      expect((await pedir("POST", "/classes/anotar-a-capacitacion", rol, {})).status).toBe(403);
      expect((await pedir("POST", `/training-subscriptions/${subId}/cobrar`, rol, {})).status).toBe(403);
    }
  });

  it("sin sesión: 401", async () => {
    expect((await pedir("GET", `/training-subscriptions/${subId}/cuota?mes=${MES}`, null)).status).toBe(401);
  });
});
