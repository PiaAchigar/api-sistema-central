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
  customerPurchase,
  customers,
  payments,
  subscriptionBillingCycles,
  training,
  trainingSessions,
  trainingSubscriptions,
} from "../db/schema";
import type { Db } from "../db/client";
import { listClassesForDate, listClassesForRange } from "./classes.repo";
import { classesQuery } from "../routes/agenda/classes";

/**
 * Clases por rango con sus anotadas, contra la base local. Datos propios
 * ZZ_QA_, en marzo de 2027 (lejos de cualquier dato real). Los turnos se
 * marcan en `notes` para poder borrarlos.
 */
const pgClient = postgres("postgresql://piubella:piubella@localhost:5499/piubella", {
  max: 1,
  fetch_types: false,
  prepare: false,
});
const db = drizzle(pgClient, { schema }) as unknown as Db;

const QA = "ZZ_QA_CLASES_RANGO";
// Lunes de marzo 2027: 1, 8, 15, 22, 29. Hora local 10:00 ART = 13:00 UTC.
const DESDE = "2027-03-01";
const HASTA = "2027-03-31";

let actividadId = "";
let capId = "";
let encuentroId = "";
let compraId = "";
const clientas: Record<string, string> = {};

/** Cuenta cada consulta: las que arrancan con select y las de db.execute. */
function contando(base: Db) {
  const cuenta = { n: 0 };
  const proxy = new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === "select" || prop === "execute") {
        return (...args: unknown[]) => {
          cuenta.n++;
          return (target[prop] as (...a: unknown[]) => unknown)(...args);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  return { db: proxy as Db, cuenta };
}

async function limpiar() {
  await db.delete(appointments).where(like(appointments.notes, `${QA}%`));
  const cts = await db.select({ id: contacts.id }).from(contacts).where(like(contacts.name, `${QA}%`));
  for (const ct of cts) {
    const cus = await db.select({ id: customers.id }).from(customers).where(eq(customers.contactId, ct.id));
    for (const cu of cus) {
      await db.delete(payments).where(eq(payments.customerId, cu.id));
      await db.delete(customerPurchase).where(eq(customerPurchase.customerId, cu.id));
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
  if (acts.length) {
    await db.delete(activitySchedules).where(inArray(activitySchedules.activityId, acts.map((a) => a.id)));
    await db.delete(activities).where(inArray(activities.id, acts.map((a) => a.id)));
  }
  const caps = await db.select({ id: training.id }).from(training).where(like(training.name, `${QA}%`));
  if (caps.length) {
    await db.delete(trainingSessions).where(inArray(trainingSessions.trainingId, caps.map((c) => c.id)));
    await db.delete(training).where(inArray(training.id, caps.map((c) => c.id)));
  }
}

async function crearClienta(clave: string) {
  const [ct] = await db.insert(contacts).values({ name: `${QA}_${clave}` }).returning({ id: contacts.id });
  const [cu] = await db.insert(customers).values({ contactId: ct!.id }).returning({ id: customers.id });
  clientas[clave] = cu!.id;
  return cu!.id;
}

/** Suscripción activa + ciclo de marzo con la cuota y los pagos dados. */
async function suscribir(clienta: string, opts: { pagado?: boolean; pagos?: string[] }) {
  const [s] = await db
    .insert(trainingSubscriptions)
    .values({ activityId: actividadId, customerId: clienta, subscriptionStartDate: "2027-03-01", status: "active", monthlyAmount: "8000" })
    .returning({ id: trainingSubscriptions.id });
  const [c] = await db
    .insert(subscriptionBillingCycles)
    .values({
      trainingSubscriptionId: s!.id,
      billingMonth: "2027-03",
      billingPeriodStart: "2027-03-01",
      billingPeriodEnd: "2027-03-31",
      amountDue: "8000",
      isPaid: opts.pagado ?? false,
    })
    .returning({ id: subscriptionBillingCycles.id });
  for (const monto of opts.pagos ?? []) {
    await db.insert(payments).values({
      customerId: clienta,
      subscriptionBillingCycleId: c!.id,
      amount: monto,
      paymentMethod: "cash",
      status: "confirmed",
      paymentDate: new Date(),
    });
  }
}

async function anotarEnClase(clienta: string, fecha: string, estado = "scheduled", prueba = false) {
  const inicio = new Date(`${fecha}T13:00:00Z`);
  await db.insert(appointments).values({
    customerId: clienta,
    activityId: actividadId,
    isTrial: prueba,
    appointmentStart: inicio,
    appointmentEnd: new Date(inicio.getTime() + 3600_000),
    durationMinutes: 60,
    status: estado,
    notes: `${QA} clase`,
  });
}

beforeAll(async () => {
  await limpiar();
  const [ac] = await db
    .insert(activities)
    .values({ name: `${QA}_Pilates`, activityType: "class", classesPerMonth: 8, monthlyBasePrice: "8000" })
    .returning({ id: activities.id });
  actividadId = ac!.id;
  // Lunes 10:00, con vigencia 15 → 22 de marzo: sólo el 15 y el 22 existen.
  await db.insert(activitySchedules).values({
    activityId: actividadId,
    dayOfWeek: 1,
    startTime: "10:00",
    endTime: "11:00",
    validFrom: "2027-03-15",
    validUntil: "2027-03-22",
    capacity: 6,
    isActive: true,
  });

  const [cap] = await db
    .insert(training)
    .values({ name: `${QA}_Cap`, totalSessions: 2, maxParticipants: 10, isActive: true })
    .returning({ id: training.id });
  capId = cap!.id;
  const [enc] = await db
    .insert(trainingSessions)
    .values({ trainingId: capId, sessionNumber: 1, sessionDate: "2027-03-10", startTime: "09:00", endTime: "12:00", isActive: true })
    .returning({ id: trainingSessions.id });
  encuentroId = enc!.id;

  const ana = await crearClienta("ANA");
  const bea = await crearClienta("BEA");
  const cata = await crearClienta("CATA");
  const dora = await crearClienta("DORA");
  const eli = await crearClienta("ELI");

  await suscribir(ana, { pagos: ["3000"] }); // debe 5000
  await suscribir(bea, { pagos: [] }); // es prueba: debe 0 aunque el ciclo esté impago
  await suscribir(cata, {}); // cancelada: no aparece
  await suscribir(dora, { pagado: true }); // is_paid: 0
  // eli: sin suscripción ni ciclo → 0

  await anotarEnClase(ana, "2027-03-22");
  await anotarEnClase(bea, "2027-03-22", "scheduled", true);
  await anotarEnClase(cata, "2027-03-22", "cancelled");
  await anotarEnClase(dora, "2027-03-22");
  await anotarEnClase(eli, "2027-03-15");

  const [compra] = await db
    .insert(customerPurchase)
    .values({ customerId: ana, trainingId: capId, description: `${QA} compra`, sessionsTotal: 1, baseAmount: "5000", discountedAmount: "5000", finalAmount: "5000", purchasedAt: new Date() })
    .returning({ id: customerPurchase.id });
  compraId = compra!.id;
  await db.insert(payments).values({
    customerId: ana,
    customerPurchaseId: compraId,
    amount: "2000",
    paymentMethod: "cash",
    status: "confirmed",
    paymentDate: new Date(),
  });
  await db.insert(appointments).values({
    customerId: ana,
    trainingSessionId: encuentroId,
    appointmentStart: new Date("2027-03-10T12:00:00Z"),
    appointmentEnd: new Date("2027-03-10T15:00:00Z"),
    status: "scheduled",
    notes: `${QA} encuentro`,
  });
});

afterAll(async () => {
  await limpiar();
  await pgClient.end();
});

const delQA = (filas: Awaited<ReturnType<typeof listClassesForRange>>) =>
  filas.filter((f) => f.name.startsWith(QA));

describe("listClassesForRange", () => {
  it("el horario sólo aparece dentro de su vigencia (valid_from y valid_until)", async () => {
    const filas = delQA(await listClassesForRange(db, DESDE, HASTA)).filter((f) => f.kind === "activity");
    expect(filas.map((f) => f.the_date)).toEqual(["2027-03-15", "2027-03-22"]);
  });

  it("incluye los encuentros del rango y los deja fuera si no caen en él", async () => {
    const dentro = delQA(await listClassesForRange(db, DESDE, HASTA)).filter((f) => f.kind === "training");
    expect(dentro.map((f) => f.the_date)).toEqual(["2027-03-10"]);
    const fuera = delQA(await listClassesForRange(db, "2027-03-11", HASTA)).filter((f) => f.kind === "training");
    expect(fuera).toEqual([]);
  });

  it("ordena por fecha, hora y nombre", async () => {
    const filas = delQA(await listClassesForRange(db, DESDE, HASTA));
    expect(filas.map((f) => f.the_date)).toEqual(["2027-03-10", "2027-03-15", "2027-03-22"]);
  });

  it("anotadas: excluye cancelados, marca prueba y calcula el debe del mes de la clase", async () => {
    const clase = delQA(await listClassesForRange(db, DESDE, HASTA)).find((f) => f.the_date === "2027-03-22")!;
    const porNombre = Object.fromEntries(clase.anotadas.map((a) => [a.nombre, a]));
    expect(Object.keys(porNombre).sort()).toEqual([`${QA}_ANA`, `${QA}_BEA`, `${QA}_DORA`]);
    expect(porNombre[`${QA}_ANA`]).toMatchObject({ customer_id: clientas.ANA, prueba: false, debe: 5000 });
    expect(porNombre[`${QA}_BEA`]).toMatchObject({ prueba: true, debe: 0 });
    expect(porNombre[`${QA}_DORA`]).toMatchObject({ prueba: false, debe: 0 });
    expect(clase.anotadas[0]!.appointment_id).toBeTruthy();
  });

  it("anotada sin suscripción ni ciclo: debe 0", async () => {
    const clase = delQA(await listClassesForRange(db, DESDE, HASTA)).find((f) => f.the_date === "2027-03-15")!;
    expect(clase.anotadas).toHaveLength(1);
    expect(clase.anotadas[0]).toMatchObject({ customer_id: clientas.ELI, debe: 0 });
  });

  it("capacitación: debe = deuda de su compra viva", async () => {
    const clase = delQA(await listClassesForRange(db, DESDE, HASTA)).find((f) => f.kind === "training")!;
    expect(clase.anotadas).toHaveLength(1);
    expect(clase.anotadas[0]).toMatchObject({ customer_id: clientas.ANA, prueba: false, debe: 3000 });
  });

  it("una clase sin anotadas trae la lista vacía", async () => {
    const filas = delQA(await listClassesForRange(db, "2027-03-10", "2027-03-10"));
    const [cap] = filas;
    expect(cap!.anotadas).toHaveLength(1);
    await db.delete(appointments).where(eq(appointments.trainingSessionId, encuentroId));
    const sinNadie = delQA(await listClassesForRange(db, "2027-03-10", "2027-03-10"));
    expect(sinNadie[0]!.anotadas).toEqual([]);
    await db.insert(appointments).values({
      customerId: clientas.ANA,
      trainingSessionId: encuentroId,
      appointmentStart: new Date("2027-03-10T12:00:00Z"),
      appointmentEnd: new Date("2027-03-10T15:00:00Z"),
      status: "scheduled",
      notes: `${QA} encuentro`,
    });
  });

  it("un rango de 42 días hace como mucho 4 consultas", async () => {
    const { db: contada, cuenta } = contando(db);
    await listClassesForRange(contada, "2027-02-01", "2027-03-14");
    expect(cuenta.n).toBeGreaterThan(0);
    expect(cuenta.n).toBeLessThanOrEqual(4);
  });

  it("enrolledCount cuenta todo turno no cancelado (completed y no_show incluidos), igual que las anotadas", async () => {
    const hoy = await crearClienta("FEDE");
    const otra = await crearClienta("GINA");
    await anotarEnClase(hoy, "2027-03-15", "completed");
    await anotarEnClase(otra, "2027-03-15", "no_show");
    const clase = delQA(await listClassesForRange(db, "2027-03-15", "2027-03-15"))[0]!;
    expect(clase.anotadas).toHaveLength(3);
    expect(clase.enrolled_count).toBe(clase.anotadas.length);
  });

  it("listClassesForDate es el rango de un día", async () => {
    const a = await listClassesForDate(db, "2027-03-22");
    const b = await listClassesForRange(db, "2027-03-22", "2027-03-22");
    expect(a).toEqual(b);
  });
});

describe("classesQuery (date XOR from+to)", () => {
  it("acepta un día o un rango", () => {
    expect(classesQuery.safeParse({ date: "2027-03-22" }).success).toBe(true);
    expect(classesQuery.safeParse({ from: "2027-03-01", to: "2027-04-11" }).success).toBe(true);
  });
  it("rechaza date junto con from/to", () => {
    expect(classesQuery.safeParse({ date: "2027-03-22", from: "2027-03-01", to: "2027-03-02" }).success).toBe(false);
  });
  it("rechaza fechas inexistentes como 2027-02-31", () => {
    expect(classesQuery.safeParse({ date: "2027-02-31" }).success).toBe(false);
    expect(classesQuery.safeParse({ from: "2027-02-31", to: "2027-03-02" }).success).toBe(false);
    // Pasan el regex pero Date da Invalid Date: antes tiraba RangeError (500).
    expect(classesQuery.safeParse({ date: "2027-13-01" }).success).toBe(false);
    expect(classesQuery.safeParse({ date: "2027-00-10" }).success).toBe(false);
  });
  it("rechaza 43 días, from > to, rango incompleto y nada", () => {
    expect(classesQuery.safeParse({ from: "2027-03-01", to: "2027-04-12" }).success).toBe(false);
    expect(classesQuery.safeParse({ from: "2027-03-05", to: "2027-03-01" }).success).toBe(false);
    expect(classesQuery.safeParse({ from: "2027-03-05" }).success).toBe(false);
    expect(classesQuery.safeParse({}).success).toBe(false);
  });
});
