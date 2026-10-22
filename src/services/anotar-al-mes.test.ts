import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import * as schema from "../db/schema";
import {
  activities,
  activitySchedules,
  appointments,
  contacts,
  customers,
  machines,
  payments,
  subscriptionBillingCycles,
  subscriptionMonthSchedules,
  trainingSubscriptions,
} from "../db/schema";
import type { Db } from "../db/client";
import { anotarAlMes } from "./anotar.service";

const URL = "postgresql://piubella:piubella@localhost:5499/piubella";
const pg1 = postgres(URL, { max: 1, fetch_types: false, prepare: false });
const pg2 = postgres(URL, { max: 1, fetch_types: false, prepare: false });
const db = drizzle(pg1, { schema }) as unknown as Db;
const db2 = drizzle(pg2, { schema }) as unknown as Db;

const QA = "ZZ_QA_ANOTAR_MES";
// Martes 20 de octubre de 2026, 11:00 ART (= 14:00 UTC).
const AHORA = new Date("2026-10-20T14:00:00Z");
const MES = "2026-10";

let actId = "";
let otraActId = "";
let clientaId = "";
let otraClientaId = "";
let schMar10 = ""; // martes 10:00 (hoy ya pasó)
let schMar12 = ""; // martes 12:00 (hoy todavía no)
let schJue18 = ""; // jueves 18:00, cupo 1
let schOtra = ""; // de otra actividad
let schSolo = ""; // jueves 29, un solo día, cupo 1
let schMaqA = ""; // viernes 23 09:00, máquina A, cupo 1
let schMaqB = ""; // viernes 23 09:00, máquina B, cupo 1
let schCorta = ""; // jueves 17:00 vigente del 8 al 22
let maqA = "";
let maqB = "";

async function crearClienta(nombre: string) {
  const [ct] = await db.insert(contacts).values({ name: `${QA}_${nombre}` }).returning({ id: contacts.id });
  const [cu] = await db.insert(customers).values({ contactId: ct!.id }).returning({ id: customers.id });
  return cu!.id;
}

async function limpiar() {
  const acts = await db.select({ id: activities.id }).from(activities).where(like(activities.name, `${QA}%`));
  const actIds = acts.map((a) => a.id);
  const cts = await db.select({ id: contacts.id }).from(contacts).where(like(contacts.name, `${QA}%`));
  const cuIds: string[] = [];
  for (const ct of cts) {
    const cus = await db.select({ id: customers.id }).from(customers).where(eq(customers.contactId, ct.id));
    cuIds.push(...cus.map((c) => c.id));
  }
  if (cuIds.length) {
    await db.delete(appointments).where(inArray(appointments.customerId, cuIds));
    await db.delete(payments).where(inArray(payments.customerId, cuIds));
    const subs = await db
      .select({ id: trainingSubscriptions.id })
      .from(trainingSubscriptions)
      .where(inArray(trainingSubscriptions.customerId, cuIds));
    const subIds = subs.map((s) => s.id);
    if (subIds.length) {
      await db
        .delete(subscriptionBillingCycles)
        .where(inArray(subscriptionBillingCycles.trainingSubscriptionId, subIds));
      await db.delete(trainingSubscriptions).where(inArray(trainingSubscriptions.id, subIds));
    }
    await db.delete(customers).where(inArray(customers.id, cuIds));
  }
  for (const ct of cts) await db.delete(contacts).where(eq(contacts.id, ct.id));
  if (actIds.length) {
    await db.delete(appointments).where(inArray(appointments.activityId, actIds));
    await db.delete(activitySchedules).where(inArray(activitySchedules.activityId, actIds));
    await db.delete(activities).where(inArray(activities.id, actIds));
  }
  await db.delete(machines).where(like(machines.name, `${QA}%`));
}

async function horario(activityId: string, dow: number, inicio: string, fin: string, extra: Partial<typeof activitySchedules.$inferInsert> = {}) {
  const [s] = await db
    .insert(activitySchedules)
    .values({ activityId, dayOfWeek: dow, startTime: inicio, endTime: fin, isActive: true, ...extra })
    .returning({ id: activitySchedules.id });
  return s!.id;
}

beforeAll(async () => {
  await limpiar();
  const [a] = await db
    .insert(activities)
    .values({ name: `${QA}_Pilates`, activityType: "class", classesPerMonth: 4, monthlyBasePrice: "8000", isActive: true })
    .returning({ id: activities.id });
  actId = a!.id;
  const [b] = await db
    .insert(activities)
    .values({ name: `${QA}_Otra`, activityType: "class", classesPerMonth: 4, monthlyBasePrice: "8000", isActive: true })
    .returning({ id: activities.id });
  otraActId = b!.id;
  schMar10 = await horario(actId, 2, "10:00:00", "11:00:00");
  schMar12 = await horario(actId, 2, "12:00:00", "13:00:00");
  schJue18 = await horario(actId, 4, "18:00:00", "19:00:00", { capacity: 1 });
  schSolo = await horario(actId, 4, "20:00:00", "21:00:00", {
    capacity: 1,
    validFrom: "2026-10-29",
    validUntil: "2026-10-29",
  });
  const [ma] = await db.insert(machines).values({ name: `${QA}_MaqA` }).returning({ id: machines.id });
  const [mb] = await db.insert(machines).values({ name: `${QA}_MaqB` }).returning({ id: machines.id });
  maqA = ma!.id;
  maqB = mb!.id;
  const solo23 = { capacity: 1, validFrom: "2026-10-23", validUntil: "2026-10-23" };
  schMaqA = await horario(actId, 5, "09:00:00", "10:00:00", { ...solo23, machineId: maqA });
  schMaqB = await horario(actId, 5, "09:00:00", "10:00:00", { ...solo23, machineId: maqB });
  schCorta = await horario(actId, 4, "17:00:00", "18:00:00", { validFrom: "2026-10-08", validUntil: "2026-10-22" });
  schOtra = await horario(otraActId, 2, "10:00:00", "11:00:00");
  clientaId = await crearClienta("CLIENTA");
  otraClientaId = await crearClienta("OTRA");
});

beforeEach(async () => {
  const cuIds = [clientaId, otraClientaId];
  await db.delete(appointments).where(inArray(appointments.customerId, cuIds));
  const subs = await db
    .select({ id: trainingSubscriptions.id })
    .from(trainingSubscriptions)
    .where(inArray(trainingSubscriptions.customerId, cuIds));
  const subIds = subs.map((s) => s.id);
  if (subIds.length) {
    await db.delete(subscriptionBillingCycles).where(inArray(subscriptionBillingCycles.trainingSubscriptionId, subIds));
    await db.delete(trainingSubscriptions).where(inArray(trainingSubscriptions.id, subIds));
  }
  await db.update(activities).set({ classesPerMonth: 4 }).where(eq(activities.id, actId));
});

afterAll(async () => {
  await limpiar();
  await pg1.end();
  await pg2.end();
});

const base = () => ({ activityId: actId, customerId: clientaId, mes: MES, cuota: 12000, ahora: AHORA });
const turnos = (customerId: string) =>
  db.select().from(appointments).where(and(eq(appointments.customerId, customerId), eq(appointments.activityId, actId)));

describe("anotarAlMes", () => {
  it("clienta nueva: crea suscripción, ciclo con la cuota, horarios y turnos solo de clases que no pasaron", async () => {
    // Mar 10:00 (hoy ya pasó: 27), Mar 12:00 (20 y 27), Jue 18:00 (22 y 29)
    const r = await anotarAlMes(db, { ...base(), scheduleIds: [schMar10, schMar12, schJue18] });
    expect(r.anotadas).toBe(1 + 2 + 2);
    expect(r.sinLugar).toEqual([]);
    expect(r.clasesDelMes).toBe(4 + 4 + 5);

    const [sub] = await db.select().from(trainingSubscriptions).where(eq(trainingSubscriptions.id, r.subscriptionId));
    expect(sub!.status).toBe("active");
    expect(Number(sub!.monthlyAmount)).toBe(12000);
    expect(sub!.subscriptionStartDate).toBe("2026-10-20");

    const [ciclo] = await db.select().from(subscriptionBillingCycles).where(eq(subscriptionBillingCycles.id, r.billingCycleId));
    expect(Number(ciclo!.amountDue)).toBe(12000);
    expect(ciclo!.billingMonth).toBe(MES);

    const hs = await db.select().from(subscriptionMonthSchedules).where(eq(subscriptionMonthSchedules.billingCycleId, r.billingCycleId));
    expect(hs.map((h) => h.activityScheduleId).sort()).toEqual([schMar10, schMar12, schJue18].sort());

    const ts = await turnos(clientaId);
    expect(ts).toHaveLength(5);
    expect(ts.every((t) => t.status === "scheduled" && t.isTrial === false)).toBe(true);
    const inicios = ts.map((t) => t.appointmentStart!.toISOString()).sort();
    // Mar 27 10:00 ART = 13:00Z; no existe el martes 20 a las 10:00
    expect(inicios).toContain("2026-10-27T13:00:00.000Z");
    expect(inicios).not.toContain("2026-10-20T13:00:00.000Z");
    expect(inicios).toContain("2026-10-20T15:00:00.000Z");
    expect(ts[0]!.durationMinutes).toBe(60);
    expect(ts[0]!.machineId).toBeNull();
  });

  it("clase llena: va a sinLugar y las demás se anotan", async () => {
    // La otra clienta ya ocupa el único lugar del jueves 22 a las 18:00 ART (21:00Z)
    await db.insert(appointments).values({
      customerId: otraClientaId, activityId: actId, status: "scheduled",
      appointmentStart: new Date("2026-10-22T21:00:00Z"), appointmentEnd: new Date("2026-10-22T22:00:00Z"),
      durationMinutes: 60,
    });
    const r = await anotarAlMes(db, { ...base(), scheduleIds: [schMar10, schJue18] });
    expect(r.sinLugar).toEqual(["2026-10-22T21:00:00.000Z"]);
    expect(r.anotadas).toBe(1 + 1);
  });

  it("todas las clases llenas: 409 y no crea suscripción, ciclo ni horarios", async () => {
    // schSolo = jueves 29 a las 20:00 ART (23:00Z), cupo 1, única clase: la otra clienta ya la ocupa.
    await db.insert(appointments).values({
      customerId: otraClientaId, activityId: actId, status: "scheduled",
      appointmentStart: new Date("2026-10-29T23:00:00Z"), appointmentEnd: new Date("2026-10-30T00:00:00Z"),
      durationMinutes: 60,
    });
    await expect(anotarAlMes(db, { ...base(), scheduleIds: [schSolo] })).rejects.toMatchObject({
      status: 409,
      message: "No hay lugar en ninguna de esas clases",
    });
    expect(await db.select().from(trainingSubscriptions).where(eq(trainingSubscriptions.customerId, clientaId))).toHaveLength(0);
    // Sin suscripción no hay ciclo: se cuentan sólo los de ESTA clienta (contar
    // todos los de la base fallaba cuando otro archivo de test creaba uno en paralelo).
    const ciclos = await db
      .select({ id: subscriptionBillingCycles.id })
      .from(subscriptionBillingCycles)
      .innerJoin(trainingSubscriptions, eq(trainingSubscriptions.id, subscriptionBillingCycles.trainingSubscriptionId))
      .where(eq(trainingSubscriptions.customerId, clientaId));
    expect(ciclos).toHaveLength(0);
    const hs = await db.select().from(subscriptionMonthSchedules).where(eq(subscriptionMonthSchedules.activityScheduleId, schSolo));
    expect(hs).toHaveLength(0);
    expect(await turnos(clientaId)).toHaveLength(0);
  });

  it("segunda vez el mismo mes: 409 y no duplica turnos", async () => {
    await anotarAlMes(db, { ...base(), scheduleIds: [schMar12] });
    await expect(anotarAlMes(db, { ...base(), scheduleIds: [schMar12] })).rejects.toMatchObject({
      status: 409,
      message: "Ya está anotada a octubre",
    });
    expect(await turnos(clientaId)).toHaveLength(2);
  });

  it("suscripción pausada: 400", async () => {
    await db.insert(trainingSubscriptions).values({
      activityId: actId, customerId: clientaId, status: "paused", monthlyAmount: "9000", subscriptionStartDate: "2026-01-01",
    });
    await expect(anotarAlMes(db, { ...base(), scheduleIds: [schMar12] })).rejects.toMatchObject({
      status: 400,
      message: "La suscripción está pausada",
    });
  });

  it("suscripción cancelada vieja: crea una nueva sin chocar", async () => {
    const [vieja] = await db.insert(trainingSubscriptions).values({
      activityId: actId, customerId: clientaId, status: "cancelled", monthlyAmount: "9000", subscriptionStartDate: "2026-01-01",
    }).returning({ id: trainingSubscriptions.id });
    const r = await anotarAlMes(db, { ...base(), scheduleIds: [schMar12] });
    expect(r.subscriptionId).not.toBe(vieja!.id);
    const subs = await db.select().from(trainingSubscriptions).where(eq(trainingSubscriptions.customerId, clientaId));
    expect(subs.filter((s) => s.status === "active")).toHaveLength(1);
  });

  it("suscripción activa existente con ciclo impago: lo reusa y deja amount_due = cuota", async () => {
    const [s] = await db.insert(trainingSubscriptions).values({
      activityId: actId, customerId: clientaId, status: "active", monthlyAmount: "5000", subscriptionStartDate: "2026-01-01",
    }).returning({ id: trainingSubscriptions.id });
    await db.insert(subscriptionBillingCycles).values({
      trainingSubscriptionId: s!.id, billingMonth: MES, billingPeriodStart: "2026-10-01", billingPeriodEnd: "2026-10-31",
      amountDue: "5000", isPaid: false,
    });
    const r = await anotarAlMes(db, { ...base(), scheduleIds: [schMar12] });
    expect(r.subscriptionId).toBe(s!.id);
    const [c] = await db.select().from(subscriptionBillingCycles).where(eq(subscriptionBillingCycles.id, r.billingCycleId));
    expect(Number(c!.amountDue)).toBe(12000);
  });

  it("horario de otra actividad: 400", async () => {
    await expect(anotarAlMes(db, { ...base(), scheduleIds: [schOtra] })).rejects.toMatchObject({
      status: 400,
      message: "Ese horario no es de esta actividad o no está vigente",
    });
  });

  it("horario con vigencia que no toca el mes: 400", async () => {
    await expect(anotarAlMes(db, { ...base(), mes: "2026-11", scheduleIds: [schSolo] })).rejects.toMatchObject({ status: 400 });
  });

  it("sin horarios: 400", async () => {
    await expect(anotarAlMes(db, { ...base(), scheduleIds: [] })).rejects.toMatchObject({
      status: 400,
      message: "Ese horario no es de esta actividad o no está vigente",
    });
  });

  it("mes anterior o lejano: 400; mes siguiente: ok y arranca el día 1", async () => {
    await expect(anotarAlMes(db, { ...base(), mes: "2026-09", scheduleIds: [schMar12] })).rejects.toMatchObject({
      status: 400,
      message: "Sólo se puede anotar al mes actual o al siguiente",
    });
    await expect(anotarAlMes(db, { ...base(), mes: "2026-12", scheduleIds: [schMar12] })).rejects.toMatchObject({ status: 400 });
    const r = await anotarAlMes(db, { ...base(), mes: "2026-11", scheduleIds: [schMar12] });
    expect(r.anotadas).toBe(4); // martes 3, 10, 17, 24 de noviembre
    const [sub] = await db.select().from(trainingSubscriptions).where(eq(trainingSubscriptions.id, r.subscriptionId));
    expect(sub!.subscriptionStartDate).toBe("2026-11-01");
  });

  it("superaPlan: 4 clases por mes y 2 horarios semanales", async () => {
    const r = await anotarAlMes(db, { ...base(), scheduleIds: [schMar12, schJue18] });
    expect(r.clasesDelMes).toBe(9);
    expect(r.superaPlan).toBe(true);
    await db.delete(subscriptionBillingCycles).where(eq(subscriptionBillingCycles.id, r.billingCycleId));
    await db.delete(appointments).where(eq(appointments.customerId, clientaId));
    await db.update(activities).set({ classesPerMonth: 0 }).where(eq(activities.id, actId));
    const r2 = await anotarAlMes(db, { ...base(), scheduleIds: [schMar12, schJue18] });
    expect(r2.superaPlan).toBe(false);
  });

  it("CONCURRENCIA: dos clientas a la última plaza de una clase, entra una sola", async () => {
    const res = await Promise.allSettled([
      anotarAlMes(db, { ...base(), customerId: clientaId, scheduleIds: [schSolo] }),
      anotarAlMes(db2, { ...base(), customerId: otraClientaId, scheduleIds: [schSolo] }),
    ]);
    // Entra una sola; la otra se queda sin lugar en su única clase: 409 y no se crea nada.
    const ok = res.filter((x) => x.status === "fulfilled");
    const mal = res.filter((x) => x.status === "rejected") as PromiseRejectedResult[];
    expect(ok).toHaveLength(1);
    expect(mal).toHaveLength(1);
    expect(mal[0]!.reason).toMatchObject({ status: 409, message: "No hay lugar en ninguna de esas clases" });
    const filas = await db
      .select()
      .from(appointments)
      .where(and(eq(appointments.activityId, actId), eq(appointments.appointmentStart, new Date("2026-10-29T23:00:00Z"))));
    expect(filas).toHaveLength(1);
  });

  it("CONCURRENCIA determinista: con la actividad bloqueada por otra anotación, espera y ve el lugar ocupado", async () => {
    // La suscripción ya existe: así el insert no se frena por la FK a la actividad y lo único que
    // puede hacer esperar a la anotación es el lock explícito del servicio.
    await db.insert(trainingSubscriptions).values({
      activityId: actId, customerId: clientaId, status: "active", monthlyAmount: "5000", subscriptionStartDate: "2026-01-01",
    });
    // Otra anotación (pg2) ya tomó el lock de la ACTIVIDAD y metió a la otra clienta, sin commitear.
    let liberar!: () => void;
    const puedeCommitear = new Promise<void>((r) => (liberar = r));
    let bloqueado!: () => void;
    const yaBloqueo = new Promise<void>((r) => (bloqueado = r));
    const otra = db2.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM activities WHERE id = ${actId} FOR UPDATE`);
      await tx.insert(appointments).values({
        customerId: otraClientaId, activityId: actId, status: "scheduled",
        appointmentStart: new Date("2026-10-29T23:00:00Z"), appointmentEnd: new Date("2026-10-30T00:00:00Z"),
        durationMinutes: 60,
      });
      bloqueado();
      await puedeCommitear;
    });
    await yaBloqueo;
    const mia = anotarAlMes(db, { ...base(), scheduleIds: [schSolo] });
    let termino = false;
    void mia.then(() => (termino = true), () => (termino = true));
    await new Promise((r) => setTimeout(r, 400));
    expect(termino).toBe(false); // sigue esperando el lock de la actividad
    liberar();
    await otra;
    await expect(mia).rejects.toMatchObject({ status: 409, message: "No hay lugar en ninguna de esas clases" });
  });

  it("dos máquinas a la misma hora son dos clases distintas, cada una con su cupo", async () => {
    const r1 = await anotarAlMes(db, { ...base(), customerId: clientaId, scheduleIds: [schMaqA] });
    const r2 = await anotarAlMes(db, { ...base(), customerId: otraClientaId, scheduleIds: [schMaqB] });
    expect(r1.anotadas).toBe(1);
    expect(r2.anotadas).toBe(1);
    expect(r2.sinLugar).toEqual([]);
    // y la máquina A ya está llena para una tercera clienta
    const [ct] = await db.insert(contacts).values({ name: `${QA}_TERCERA` }).returning({ id: contacts.id });
    const [cu] = await db.insert(customers).values({ contactId: ct!.id }).returning({ id: customers.id });
    await expect(anotarAlMes(db, { ...base(), customerId: cu!.id, scheduleIds: [schMaqA] })).rejects.toMatchObject({
      status: 409,
      message: "No hay lugar en ninguna de esas clases",
    });
  });

  it("dos anotaciones en paralelo de la misma clienta con ciclo ya existente y horarios distintos: una sola entra", async () => {
    const [s] = await db.insert(trainingSubscriptions).values({
      activityId: actId, customerId: clientaId, status: "active", monthlyAmount: "5000", subscriptionStartDate: "2026-01-01",
    }).returning({ id: trainingSubscriptions.id });
    await db.insert(subscriptionBillingCycles).values({
      trainingSubscriptionId: s!.id, billingMonth: MES, billingPeriodStart: "2026-10-01", billingPeriodEnd: "2026-10-31",
      amountDue: "5000", isPaid: false,
    });
    const res = await Promise.allSettled([
      anotarAlMes(db, { ...base(), scheduleIds: [schMar12] }),
      anotarAlMes(db2, { ...base(), scheduleIds: [schCorta] }),
    ]);
    expect(res.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    const rech = res.find((x) => x.status === "rejected") as PromiseRejectedResult;
    expect(rech.reason).toMatchObject({ status: 409 });
    const [c] = await db.select().from(subscriptionBillingCycles).where(eq(subscriptionBillingCycles.trainingSubscriptionId, s!.id));
    const hs = await db.select().from(subscriptionMonthSchedules).where(eq(subscriptionMonthSchedules.billingCycleId, c!.id));
    expect(hs).toHaveLength(1);
  });

  it("ciclo ya pagado: no se toca amount_due", async () => {
    const [s] = await db.insert(trainingSubscriptions).values({
      activityId: actId, customerId: clientaId, status: "active", monthlyAmount: "5000", subscriptionStartDate: "2026-01-01",
    }).returning({ id: trainingSubscriptions.id });
    await db.insert(subscriptionBillingCycles).values({
      trainingSubscriptionId: s!.id, billingMonth: MES, billingPeriodStart: "2026-10-01", billingPeriodEnd: "2026-10-31",
      amountDue: "5000", isPaid: true,
    });
    const r = await anotarAlMes(db, { ...base(), scheduleIds: [schMar12] });
    const [c] = await db.select().from(subscriptionBillingCycles).where(eq(subscriptionBillingCycles.id, r.billingCycleId));
    expect(Number(c!.amountDue)).toBe(5000);
    expect(r.anotadas).toBe(2);
  });

  it("vigencia que corta a mitad de mes: solo cuentan las fechas dentro (8, 15 y 22)", async () => {
    // Jueves 17:00 vigente del 8 al 22; ahora = martes 20: solo falta el 22.
    const r = await anotarAlMes(db, { ...base(), scheduleIds: [schCorta] });
    expect(r.clasesDelMes).toBe(3);
    expect(r.anotadas).toBe(1);
    const ts = await turnos(clientaId);
    expect(ts.map((t) => t.appointmentStart!.toISOString())).toEqual(["2026-10-22T20:00:00.000Z"]);
  });
});
