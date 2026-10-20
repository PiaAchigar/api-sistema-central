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
import { anotarAlMes, anotarAClase, opcionesParaAnotar } from "./anotar.service";

const URL = "postgresql://piubella:piubella@localhost:5499/piubella";
const pg1 = postgres(URL, { max: 1, fetch_types: false, prepare: false });
const pg2 = postgres(URL, { max: 1, fetch_types: false, prepare: false });
const db = drizzle(pg1, { schema }) as unknown as Db;
const db2 = drizzle(pg2, { schema }) as unknown as Db;

const QA = "ZZ_QA_ANOTAR_CLASE";
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
  await db.delete(appointments).where(eq(appointments.activityId, actId)); // incluye las de clientas sueltas de un test
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


const MAR12_HOY = "2026-10-20T15:00:00.000Z"; // martes 20, 12:00 ART
const MAR12_27 = "2026-10-27T15:00:00.000Z";
const JUE18_22 = "2026-10-22T21:00:00.000Z"; // cupo 1
const VIE9_23 = "2026-10-23T12:00:00.000Z"; // dos máquinas, cupo 1 cada una
const turnos = (customerId: string) =>
  db.select().from(appointments).where(and(eq(appointments.customerId, customerId), eq(appointments.activityId, actId)));
const alMes = (customerId = clientaId) =>
  anotarAlMes(db, { activityId: actId, customerId, mes: MES, scheduleIds: [schMar10], cuota: 9000, ahora: AHORA });
const ocupar = (customerId: string, inicio: string, machineId: string | null = null, extra: Partial<typeof appointments.$inferInsert> = {}) =>
  db.insert(appointments).values({
    customerId, activityId: actId, status: "scheduled", machineId,
    appointmentStart: new Date(inicio), appointmentEnd: new Date(new Date(inicio).getTime() + 3600_000),
    durationMinutes: 60, ...extra,
  });

describe("anotarAClase (pase libre)", () => {
  it("anotada al mes: suma un turno sin prueba, con máquina y duración de la clase", async () => {
    await alMes();
    const r = await anotarAClase(db, { activityId: actId, startsAt: MAR12_HOY, customerId: clientaId, ahora: AHORA });
    const [t] = await db.select().from(appointments).where(eq(appointments.id, r.appointmentId));
    expect(t!.isTrial).toBe(false);
    expect(t!.status).toBe("scheduled");
    expect(t!.durationMinutes).toBe(60);
    expect(t!.appointmentStart!.toISOString()).toBe(MAR12_HOY);
  });

  it("sin anotar al mes: 400 con el mes en letras", async () => {
    await expect(anotarAClase(db, { activityId: actId, startsAt: MAR12_HOY, customerId: clientaId, ahora: AHORA }))
      .rejects.toMatchObject({ status: 400, message: "No está anotada a octubre: anotala al mes o como prueba" });
  });

  it("suscripción activa pero sin ciclo del mes de la clase: 400", async () => {
    await alMes();
    await expect(anotarAClase(db, { activityId: actId, startsAt: "2026-11-03T15:00:00.000Z", customerId: clientaId, ahora: AHORA }))
      .rejects.toMatchObject({ status: 400, message: "No está anotada a noviembre: anotala al mes o como prueba" });
  });

  it("horario que no existe: 400", async () => {
    await expect(anotarAClase(db, { activityId: actId, startsAt: "2026-10-27T14:00:00.000Z", customerId: clientaId, ahora: AHORA }))
      .rejects.toMatchObject({ status: 400, message: `No hay clase de ${QA}_Pilates en ese horario` });
  });

  it("clase que ya pasó: 400", async () => {
    await expect(anotarAClase(db, { activityId: actId, startsAt: "2026-10-20T13:00:00.000Z", customerId: clientaId, ahora: AHORA }))
      .rejects.toMatchObject({ status: 400, message: "Esa clase ya pasó" });
  });

  it("clase llena: 409", async () => {
    await alMes();
    await ocupar(otraClientaId, JUE18_22);
    await expect(anotarAClase(db, { activityId: actId, startsAt: JUE18_22, customerId: clientaId, ahora: AHORA }))
      .rejects.toMatchObject({ status: 409, message: "La clase está llena" });
  });

  it("dos máquinas a la misma hora: elige la que tiene lugar; si ambas llenas, 409", async () => {
    await alMes();
    await ocupar(otraClientaId, VIE9_23, maqA);
    const r = await anotarAClase(db, { activityId: actId, startsAt: VIE9_23, customerId: clientaId, ahora: AHORA });
    const [t] = await db.select().from(appointments).where(eq(appointments.id, r.appointmentId));
    expect(t!.machineId).toBe(maqB);
  });

  it("dos máquinas llenas: 409", async () => {
    await alMes();
    const tercera = await crearClienta("TERCERA");
    await ocupar(otraClientaId, VIE9_23, maqA);
    await ocupar(tercera, VIE9_23, maqB);
    await expect(anotarAClase(db, { activityId: actId, startsAt: VIE9_23, customerId: clientaId, ahora: AHORA }))
      .rejects.toMatchObject({ status: 409, message: "La clase está llena" });
  });

  it("con scheduleId anota en la máquina de ese horario aunque la otra tenga lugar", async () => {
    await alMes();
    const r = await anotarAClase(db, { activityId: actId, startsAt: VIE9_23, customerId: clientaId, scheduleId: schMaqB, ahora: AHORA });
    const [t] = await db.select().from(appointments).where(eq(appointments.id, r.appointmentId));
    expect(t!.machineId).toBe(maqB);
  });

  it("con scheduleId de un horario lleno: 409 aunque la otra máquina tenga lugar", async () => {
    await alMes();
    await ocupar(otraClientaId, VIE9_23, maqB);
    await expect(anotarAClase(db, { activityId: actId, startsAt: VIE9_23, customerId: clientaId, scheduleId: schMaqB, ahora: AHORA }))
      .rejects.toMatchObject({ status: 409, message: "La clase está llena" });
    expect((await turnos(clientaId)).filter((t) => t.appointmentStart!.toISOString() === VIE9_23)).toHaveLength(0);
  });

  it("con scheduleId que no coincide con el inicio: 400", async () => {
    await alMes();
    await expect(anotarAClase(db, { activityId: actId, startsAt: VIE9_23, customerId: clientaId, scheduleId: schJue18, ahora: AHORA }))
      .rejects.toMatchObject({ status: 400, message: `No hay clase de ${QA}_Pilates en ese horario` });
  });

  it("ya anotada en esa clase: 409", async () => {
    await alMes();
    await anotarAClase(db, { activityId: actId, startsAt: MAR12_HOY, customerId: clientaId, ahora: AHORA });
    await expect(anotarAClase(db, { activityId: actId, startsAt: MAR12_HOY, customerId: clientaId, ahora: AHORA }))
      .rejects.toMatchObject({ status: 409, message: "Ya está anotada en esa clase" });
  });

  it("dos anotaciones simultáneas al último lugar: una pasa y la otra recibe 409 (no 500)", async () => {
    await alMes();
    await alMes(otraClientaId);
    const res = await Promise.allSettled([
      anotarAClase(db, { activityId: actId, startsAt: JUE18_22, customerId: clientaId, ahora: AHORA }),
      anotarAClase(db2, { activityId: actId, startsAt: JUE18_22, customerId: otraClientaId, ahora: AHORA }),
    ]);
    expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rech = res.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rech.reason).toMatchObject({ status: 409, message: "La clase está llena" });
  });
});

describe("anotarAClase (prueba)", () => {
  it("sin historial: turno is_trial = true", async () => {
    const r = await anotarAClase(db, { activityId: actId, startsAt: MAR12_HOY, customerId: clientaId, prueba: true, ahora: AHORA });
    const [t] = await db.select().from(appointments).where(eq(appointments.id, r.appointmentId));
    expect(t!.isTrial).toBe(true);
  });

  it("ya tuvo una prueba: 409", async () => {
    await anotarAClase(db, { activityId: actId, startsAt: MAR12_HOY, customerId: clientaId, prueba: true, ahora: AHORA });
    await expect(anotarAClase(db, { activityId: actId, startsAt: MAR12_27, customerId: clientaId, prueba: true, ahora: AHORA }))
      .rejects.toMatchObject({ status: 409, message: `Ya tuvo su clase de prueba de ${QA}_Pilates` });
  });

  it("una prueba cancelada no cuenta", async () => {
    await ocupar(clientaId, MAR12_HOY, null, { isTrial: true, status: "cancelled" });
    const r = await anotarAClase(db, { activityId: actId, startsAt: MAR12_HOY, customerId: clientaId, prueba: true, ahora: AHORA });
    expect(r.appointmentId).toBeTruthy();
  });

  it("con suscripción (aun pausada): 409", async () => {
    await alMes();
    await db.update(trainingSubscriptions).set({ status: "paused" }).where(eq(trainingSubscriptions.customerId, clientaId));
    await expect(anotarAClase(db, { activityId: actId, startsAt: MAR12_27, customerId: clientaId, prueba: true, ahora: AHORA }))
      .rejects.toMatchObject({ status: 409, message: `Ya está suscripta a ${QA}_Pilates: sumala con el pase libre` });
  });

  it("la prueba de otra actividad no cuenta", async () => {
    await db.insert(appointments).values({
      customerId: clientaId, activityId: otraActId, status: "scheduled", isTrial: true,
      appointmentStart: new Date(MAR12_HOY), appointmentEnd: new Date("2026-10-20T16:00:00Z"), durationMinutes: 60,
    });
    const r = await anotarAClase(db, { activityId: actId, startsAt: MAR12_HOY, customerId: clientaId, prueba: true, ahora: AHORA });
    expect(r.appointmentId).toBeTruthy();
  });
});

describe("opcionesParaAnotar", () => {
  const op = (customerId = clientaId) => opcionesParaAnotar(db, { activityId: actId, customerId, mes: MES });

  it("sin nada: puede prueba, cuota sugerida = precio base de la actividad", async () => {
    expect(await op()).toMatchObject({ anotadaAlMes: false, suscripcion: null, puedePrueba: true, cuotaSugerida: 8000, horariosDelMes: [], subscriptionId: null, clasesDelPlan: 4 });
  });

  it("anotada al mes: horarios formateados y ordenados, cuota de su suscripción, sin prueba", async () => {
    await anotarAlMes(db, { activityId: actId, customerId: clientaId, mes: MES, scheduleIds: [schJue18, schMar12, schMar10], cuota: 9000, ahora: AHORA });
    expect(await op()).toMatchObject({
      anotadaAlMes: true, suscripcion: "activa", puedePrueba: false, cuotaSugerida: 9000,
      horariosDelMes: ["Mar 10:00", "Mar 12:00", "Jue 18:00"],
    });
  });

  it("suscripción activa sin anotar a ese mes", async () => {
    await alMes();
    const r = await opcionesParaAnotar(db, { activityId: actId, customerId: clientaId, mes: "2026-11" });
    expect(r).toMatchObject({ anotadaAlMes: false, suscripcion: "activa", puedePrueba: false, cuotaSugerida: 9000, horariosDelMes: [] });
  });

  it("pausada", async () => {
    await alMes();
    await db.update(trainingSubscriptions).set({ status: "paused" }).where(eq(trainingSubscriptions.customerId, clientaId));
    const r = await op();
    expect(r).toMatchObject({ anotadaAlMes: false, suscripcion: "pausada", puedePrueba: false, cuotaSugerida: 9000 });
  });

  it("subscriptionId: la activa; la pausada si sólo hay pausada; null si nada", async () => {
    expect((await op()).subscriptionId).toBeNull();
    await alMes();
    const [sub] = await db.select({ id: trainingSubscriptions.id }).from(trainingSubscriptions).where(eq(trainingSubscriptions.customerId, clientaId));
    expect((await op()).subscriptionId).toBe(sub!.id);
    await db.update(trainingSubscriptions).set({ status: "paused" }).where(eq(trainingSubscriptions.customerId, clientaId));
    expect((await op()).subscriptionId).toBe(sub!.id);
  });

  it("ya tuvo prueba: no puede otra", async () => {
    await ocupar(clientaId, MAR12_HOY, null, { isTrial: true });
    expect(await op()).toMatchObject({ suscripcion: null, puedePrueba: false, cuotaSugerida: 8000 });
  });
});

describe("opcionesParaAnotar: horarios del mes", () => {
  it("trae los activos y vigentes en el mes, por día y hora, con las clases que quedan", async () => {
    const [a] = await db
      .insert(activities)
      .values({ name: `${QA}_Horarios`, activityType: "class", classesPerMonth: 8, monthlyBasePrice: "5000", isActive: true })
      .returning({ id: activities.id });
    const id = a!.id;
    const mie = await horario(id, 3, "18:30:00", "19:30:00", { machineId: maqA }); // 21 y 28
    const lun = await horario(id, 1, "09:00:00", "10:00:00"); // 5, 12, 19 pasaron; queda el 26
    await horario(id, 5, "10:00:00", "11:00:00", { isActive: false });
    await horario(id, 2, "10:00:00", "11:00:00", { validUntil: "2026-09-30" });
    const r = await opcionesParaAnotar(db, { activityId: id, customerId: clientaId, mes: MES, ahora: AHORA });
    expect(r.clasesDelPlan).toBe(8);
    expect(r.horarios).toEqual([
      { scheduleId: lun, etiqueta: "Lun 09:00", maquina: null, clases: 1 },
      { scheduleId: mie, etiqueta: "Mié 18:30", maquina: `${QA}_MaqA`, clases: 2 },
    ]);
  });
});
