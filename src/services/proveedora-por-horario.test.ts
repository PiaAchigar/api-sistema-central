import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { and, eq, inArray, like } from "drizzle-orm";
import * as schema from "../db/schema";
import {
  activities,
  activityAttendance,
  activitySchedules,
  appointments,
  contacts,
  customers,
  machines,
  serviceProviders,
  subscriptionBillingCycles,
  trainingSubscriptions,
} from "../db/schema";
import type { Db } from "../db/client";
import type { AppBindings, Variables } from "../env";
import { auth } from "../middleware/auth";
import { activitiesRepository } from "../repositories/activitiesRepository";
import { activitySchedulesRepository } from "../repositories/activitySchedulesRepository";
import { trainingSubscriptionsRepository } from "../repositories/trainingSubscriptionsRepository";
import { trainingSubscriptionsService } from "./trainingSubscriptionsService";
import { activitySchedulesRouter } from "../routes/activitySchedules";
import { trainingSubscriptionsRouter } from "../routes/trainingSubscriptions";
import { listClassesForRange } from "../repositories/classes.repo";
import { anotarAClase, anotarAlMes, opcionesParaAnotar } from "./anotar.service";

// La proveedora va en cada horario: dos horarios a la misma hora con distinta
// proveedora son dos clases (cupo, anotadas y asistencias propios).
const LOCAL_DB_URL = "postgresql://piubella:piubella@localhost:5499/piubella";
const QA = "ZZ_QA_PROV_HORARIO";

const pgClient = postgres(LOCAL_DB_URL, { max: 1, fetch_types: false, prepare: false });
const db = drizzle(pgClient, { schema }) as unknown as Db;

const API_KEY = "qa-prov-horario-key";
const ENV = { HYPERDRIVE: { connectionString: LOCAL_DB_URL }, API_KEY, ARCA_MODE: "mock" } as unknown as AppBindings;

const app = new Hono<{ Bindings: AppBindings; Variables: Variables }>();
app.onError((err, c) => {
  if ("status" in err && typeof err.status === "number") {
    return c.json({ error: err.message }, err.status as 400 | 401 | 403 | 404 | 409 | 422 | 500);
  }
  return c.json({ error: "Internal server error" }, 500);
});
activitiesRepository.setDb(db);
activitySchedulesRepository.setDb(db);
trainingSubscriptionsRepository.setDb(db);
trainingSubscriptionsService.setDb(db);
app.use("*", auth);
app.route("/", activitySchedulesRouter);
app.route("/", trainingSubscriptionsRouter);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async (r: Response) => (await r.json()) as { error?: string; data?: any };

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

// Martes 20 de octubre de 2026, 11:00 ART. El miércoles 21 a las 12:00 ART son las 15:00 UTC.
const AHORA = new Date("2026-10-20T14:00:00Z");
const MES = "2026-10";
const MIE12_21 = "2026-10-21T15:00:00.000Z";
const MIE12_28 = "2026-10-28T15:00:00.000Z";

let lucia = "";
let ana = "";
let actId = "";
let schLucia = ""; // miércoles 12:00, cupo 1, Lucía
let schAna = ""; // miércoles 12:00, cupo 1, Ana
let schLun = ""; // lunes 09:00, Lucía (para que las clientas estén anotadas al mes)
const clientas: string[] = [];

async function crearClienta(nombre: string) {
  const [ct] = await db.insert(contacts).values({ name: `${QA}_${nombre}` }).returning({ id: contacts.id });
  const [cu] = await db.insert(customers).values({ contactId: ct!.id }).returning({ id: customers.id });
  clientas.push(cu!.id);
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
  if (actIds.length) await db.delete(appointments).where(inArray(appointments.activityId, actIds));
  if (cuIds.length) {
    await db.delete(appointments).where(inArray(appointments.customerId, cuIds));
    const subs = await db
      .select({ id: trainingSubscriptions.id })
      .from(trainingSubscriptions)
      .where(inArray(trainingSubscriptions.customerId, cuIds));
    const subIds = subs.map((s) => s.id);
    if (subIds.length) {
      await db.delete(activityAttendance).where(inArray(activityAttendance.subscriptionId, subIds));
      await db
        .delete(subscriptionBillingCycles)
        .where(inArray(subscriptionBillingCycles.trainingSubscriptionId, subIds));
      await db.delete(trainingSubscriptions).where(inArray(trainingSubscriptions.id, subIds));
    }
    await db.delete(customers).where(inArray(customers.id, cuIds));
  }
  for (const ct of cts) await db.delete(contacts).where(eq(contacts.id, ct.id));
  if (actIds.length) {
    await db.delete(activitySchedules).where(inArray(activitySchedules.activityId, actIds));
    await db.delete(activities).where(inArray(activities.id, actIds));
  }
  await db.delete(machines).where(like(machines.name, `${QA}%`));
  await db.delete(serviceProviders).where(like(serviceProviders.fullName, `${QA}%`));
}

async function horario(
  activityId: string,
  dow: number,
  inicio: string,
  fin: string,
  extra: Partial<typeof activitySchedules.$inferInsert> = {},
) {
  const [s] = await db
    .insert(activitySchedules)
    .values({ activityId, dayOfWeek: dow, startTime: inicio, endTime: fin, isActive: true, ...extra })
    .returning({ id: activitySchedules.id });
  return s!.id;
}

const grilla = async (dia: string, activityId = actId) =>
  (await listClassesForRange(db, dia, dia)).filter((c) => c.kind === "activity" && c.subject_id === activityId);
const turnos = (customerId: string) =>
  db.select().from(appointments).where(and(eq(appointments.customerId, customerId), eq(appointments.activityId, actId)));

beforeAll(async () => {
  await limpiar();
  const [l] = await db.insert(serviceProviders).values({ fullName: `${QA}_Lucia` }).returning({ id: serviceProviders.id });
  const [an] = await db.insert(serviceProviders).values({ fullName: `${QA}_Ana` }).returning({ id: serviceProviders.id });
  lucia = l!.id;
  ana = an!.id;
  // La actividad ya no lleva proveedora: va en cada horario.
  const [a] = await db
    .insert(activities)
    .values({ name: `${QA}_Pilates`, activityType: "class", classesPerMonth: 4, monthlyBasePrice: "8000", isActive: true })
    .returning({ id: activities.id });
  actId = a!.id;
  schLucia = await horario(actId, 3, "12:00:00", "13:00:00", { capacity: 1, serviceProviderId: lucia });
  schAna = await horario(actId, 3, "12:00:00", "13:00:00", { capacity: 1, serviceProviderId: ana });
  schLun = await horario(actId, 1, "09:00:00", "10:00:00", { serviceProviderId: lucia });
});

beforeEach(async () => {
  await db.delete(appointments).where(eq(appointments.activityId, actId));
  if (clientas.length) {
    const subs = await db
      .select({ id: trainingSubscriptions.id })
      .from(trainingSubscriptions)
      .where(inArray(trainingSubscriptions.customerId, clientas));
    const subIds = subs.map((s) => s.id);
    if (subIds.length) {
      await db.delete(activityAttendance).where(inArray(activityAttendance.subscriptionId, subIds));
      await db
        .delete(subscriptionBillingCycles)
        .where(inArray(subscriptionBillingCycles.trainingSubscriptionId, subIds));
      await db.delete(trainingSubscriptions).where(inArray(trainingSubscriptions.id, subIds));
    }
  }
});

afterAll(async () => {
  await limpiar();
  await pgClient.end();
});

const alMes = (customerId: string, scheduleIds: string[]) =>
  anotarAlMes(db, { activityId: actId, customerId, mes: MES, scheduleIds, cuota: 9000, ahora: AHORA });

describe("dos horarios de Pilates el miércoles a las 12 (Lucía y Ana, cupo 1 cada uno)", () => {
  it("la grilla da dos clases, cada una con su proveedora y su enrolled_count", async () => {
    const c1 = await crearClienta("C1");
    await alMes(c1, [schLucia]);
    const clases = await grilla("2026-10-21");
    expect(clases).toHaveLength(2);
    const deLucia = clases.find((c) => c.provider_id === lucia)!;
    const deAna = clases.find((c) => c.provider_id === ana)!;
    expect(deLucia.provider_name).toBe(`${QA}_Lucia`);
    expect(deAna.provider_name).toBe(`${QA}_Ana`);
    expect(deLucia.enrolled_count).toBe(1);
    expect(deLucia.anotadas).toHaveLength(1);
    expect(deAna.enrolled_count).toBe(0);
    expect(deAna.anotadas).toHaveLength(0);
  });

  it("anotar al mes con el horario de Lucía crea turnos con Lucía", async () => {
    const c1 = await crearClienta("C1");
    await alMes(c1, [schLucia]);
    const ts = await turnos(c1);
    expect(ts.length).toBeGreaterThan(0);
    expect(ts.every((t) => t.serviceProviderId === lucia)).toBe(true);
  });

  it("con la de Lucía llena, anotarAClase con el scheduleId de Ana anota en la de Ana", async () => {
    const c1 = await crearClienta("C1");
    const c2 = await crearClienta("C2");
    await alMes(c1, [schLucia]);
    await alMes(c2, [schLun]);
    const r = await anotarAClase(db, { activityId: actId, startsAt: MIE12_21, customerId: c2, scheduleId: schAna, ahora: AHORA });
    const [t] = await db.select().from(appointments).where(eq(appointments.id, r.appointmentId));
    expect(t!.serviceProviderId).toBe(ana);
    const clases = await grilla("2026-10-21");
    expect(clases.find((c) => c.provider_id === ana)!.enrolled_count).toBe(1);
    expect(clases.find((c) => c.provider_id === lucia)!.enrolled_count).toBe(1);
  });

  it("sin scheduleId toma la primera con lugar: con Lucía llena, la de Ana", async () => {
    const c1 = await crearClienta("C1");
    const c2 = await crearClienta("C2");
    await alMes(c1, [schLucia]);
    await alMes(c2, [schLun]);
    const r = await anotarAClase(db, { activityId: actId, startsAt: MIE12_21, customerId: c2, ahora: AHORA });
    const [t] = await db.select().from(appointments).where(eq(appointments.id, r.appointmentId));
    expect(t!.serviceProviderId).toBe(ana);
  });

  it("anotarAClase con el scheduleId de Lucía llena: 409 'La clase está llena'", async () => {
    const c1 = await crearClienta("C1");
    const c2 = await crearClienta("C2");
    await alMes(c1, [schLucia]);
    await alMes(c2, [schLun]);
    await expect(
      anotarAClase(db, { activityId: actId, startsAt: MIE12_21, customerId: c2, scheduleId: schLucia, ahora: AHORA }),
    ).rejects.toMatchObject({ status: 409, message: "La clase está llena" });
  });

  it("anotar al mes con Lucía llena y Ana libre: el cupo es por proveedora", async () => {
    const c1 = await crearClienta("C1");
    const c2 = await crearClienta("C2");
    await alMes(c1, [schLucia]);
    const r = await alMes(c2, [schAna]);
    expect(r.sinLugar).toEqual([]);
    expect((await turnos(c2)).every((t) => t.serviceProviderId === ana)).toBe(true);
  });

  it("opcionesParaAnotar: cada horario trae su proveedora y horariosDelMes las distingue", async () => {
    const c1 = await crearClienta("C1");
    await alMes(c1, [schLucia, schLun]);
    const o = await opcionesParaAnotar(db, { activityId: actId, customerId: c1, mes: MES, ahora: AHORA });
    const mie = o.horarios.filter((h) => h.etiqueta === "Mié 12:00");
    expect(mie).toHaveLength(2);
    expect(mie.find((h) => h.scheduleId === schLucia)!.proveedora).toBe(`${QA}_Lucia`);
    expect(mie.find((h) => h.scheduleId === schAna)!.proveedora).toBe(`${QA}_Ana`);
    expect(o.horarios.find((h) => h.scheduleId === schLun)!.proveedora).toBe(`${QA}_Lucia`);
    // El lunes no se repite: su etiqueta queda como siempre. El miércoles se distingue.
    expect(o.horariosDelMes).toEqual([`Lun 09:00`, `Mié 12:00 · ${QA}_Lucia`]);
  });

  it("el roster con providerId=Lucía trae sólo a la de Lucía", async () => {
    const c1 = await crearClienta("C1");
    const c2 = await crearClienta("C2");
    await alMes(c1, [schLucia]);
    await alMes(c2, [schAna]);
    const deLucia = await trainingSubscriptionsService.getClassRoster(actId, MIE12_21, undefined, lucia);
    expect(deLucia.map((r) => r.customerName)).toEqual([`${QA}_C1`]);
    const deAna = await trainingSubscriptionsService.getClassRoster(actId, MIE12_21, undefined, ana);
    expect(deAna.map((r) => r.customerName)).toEqual([`${QA}_C2`]);
    const todas = await trainingSubscriptionsService.getClassRoster(actId, MIE12_21);
    expect(todas).toHaveLength(2);
  });

  it("guardar asistencias con providerId=Lucía rechaza la suscripción de Ana", async () => {
    // Clase pasada: mismo miércoles a las 12, el 4 de marzo de 2026.
    const pasada = new Date("2026-03-04T15:00:00Z");
    const c1 = await crearClienta("C1");
    const c2 = await crearClienta("C2");
    const subs: string[] = [];
    for (const [cu, pr] of [[c1, lucia], [c2, ana]] as const) {
      const [s] = await db
        .insert(trainingSubscriptions)
        .values({ activityId: actId, customerId: cu, subscriptionStartDate: "2026-01-01", status: "active", monthlyAmount: "8000" })
        .returning({ id: trainingSubscriptions.id });
      subs.push(s!.id);
      await db.insert(appointments).values({
        customerId: cu, activityId: actId, serviceProviderId: pr, status: "scheduled",
        appointmentStart: pasada, appointmentEnd: new Date(pasada.getTime() + 3600_000), durationMinutes: 60,
      });
    }
    await expect(
      trainingSubscriptionsService.markClassAttendance(actId, pasada.toISOString(), [{ subscriptionId: subs[1]!, attended: true }], undefined, lucia),
    ).rejects.toThrow(/no están agendadas a esta clase/);
    const ok = await trainingSubscriptionsService.markClassAttendance(
      actId, pasada.toISOString(), [{ subscriptionId: subs[0]!, attended: true }], undefined, lucia,
    );
    expect(ok).toHaveLength(1);
    expect(ok[0]!.attended).toBe(true);
  });

  it("un turno anotado antes de la migración (proveedora de la actividad = la del horario) sigue contando en su clase", async () => {
    const c1 = await crearClienta("C1");
    await db.insert(appointments).values({
      customerId: c1, activityId: actId, serviceProviderId: lucia, status: "scheduled",
      appointmentStart: new Date(MIE12_28), appointmentEnd: new Date(new Date(MIE12_28).getTime() + 3600_000), durationMinutes: 60,
    });
    const clases = await grilla("2026-10-28");
    expect(clases.find((c) => c.provider_id === lucia)!.enrolled_count).toBe(1);
    expect(clases.find((c) => c.provider_id === ana)!.enrolled_count).toBe(0);
  });
});

describe("POST/GET de horarios", () => {
  it("alta de Clase sin proveedora: 400 'Elegí la proveedora del horario'", async () => {
    const r = await pedir("POST", `/activities/${actId}/schedules`, {
      dayOfWeek: 5, startTime: "10:00:00", endTime: "11:00:00",
    });
    expect(r.status).toBe(400);
    expect((await json(r)).error).toBe("Elegí la proveedora del horario");
    const n = await pedir("POST", `/activities/${actId}/schedules`, {
      dayOfWeek: 5, startTime: "10:00:00", endTime: "11:00:00", serviceProviderId: null,
    });
    expect(n.status).toBe(400);
  });

  it("alta de Clase con proveedora: 201 y el GET trae serviceProviderId y providerName", async () => {
    const r = await pedir("POST", `/activities/${actId}/schedules`, {
      dayOfWeek: 5, startTime: "10:00:00", endTime: "11:00:00", serviceProviderId: ana,
    });
    expect(r.status).toBe(201);
    const creado = (await json(r)).data;
    expect(creado.serviceProviderId).toBe(ana);
    const g = await pedir("GET", `/activities/${actId}/schedules`);
    const fila = (await json(g)).data.find((s: { id: string }) => s.id === creado.id);
    expect(fila.serviceProviderId).toBe(ana);
    expect(fila.providerName).toBe(`${QA}_Ana`);
    await db.delete(activitySchedules).where(eq(activitySchedules.id, creado.id));
  });

  it("alta de Máquina sin proveedora: 201 y providerName null", async () => {
    const [m] = await db.insert(machines).values({ name: `${QA}_Maq` }).returning({ id: machines.id });
    const [ac] = await db
      .insert(activities)
      .values({ name: `${QA}_Thermo`, activityType: "machine", classesPerMonth: 0, monthlyBasePrice: "8000", isActive: true })
      .returning({ id: activities.id });
    const r = await pedir("POST", `/activities/${ac!.id}/schedules`, {
      machineId: m!.id, dayOfWeek: 5, startTime: "10:00:00", endTime: "11:00:00",
    });
    expect(r.status).toBe(201);
    const g = await pedir("GET", `/activities/${ac!.id}/schedules`);
    const fila = (await json(g)).data[0];
    expect(fila.serviceProviderId).toBeNull();
    expect(fila.providerName).toBeNull();
  });
});

describe("PATCH: cambio de proveedora de un horario", () => {
  const PASADO = new Date("2026-03-04T15:00:00Z"); // miércoles 12:00 ART, ya pasó
  const FUTURO = new Date("2030-01-02T15:00:00Z"); // miércoles 12:00 ART, futuro
  let sch = "";

  async function turno(customerId: string, inicio: Date, extra: Partial<typeof appointments.$inferInsert> = {}) {
    const [t] = await db
      .insert(appointments)
      .values({
        customerId, activityId: actId, serviceProviderId: lucia, status: "scheduled",
        appointmentStart: inicio, appointmentEnd: new Date(inicio.getTime() + 3600_000), durationMinutes: 60, ...extra,
      })
      .returning({ id: appointments.id });
    return t!.id;
  }
  const proveedoraDe = async (id: string) =>
    (await db.select().from(appointments).where(eq(appointments.id, id)))[0]!.serviceProviderId;

  beforeAll(async () => {
    // Horario propio, miércoles 18:00 (distinto de los de arriba), de Lucía.
    sch = await horario(actId, 3, "18:00:00", "19:00:00", { serviceProviderId: lucia });
  });

  it("el turno futuro pasa a la nueva proveedora y el pasado queda", async () => {
    const c1 = await crearClienta("C1");
    const ini = (d: Date) => new Date(d.getTime() + 6 * 3600_000); // 12:00 -> 18:00 ART
    const pasado = await turno(c1, ini(PASADO));
    const futuro = await turno(c1, ini(FUTURO));
    const cancelado = await turno(c1, new Date(ini(FUTURO).getTime() + 7 * 24 * 3600_000), { status: "cancelled" });
    const otraHora = await turno(c1, FUTURO); // miércoles 12:00: es de otro horario
    const r = await pedir("PATCH", `/activities/schedules/${sch}`, { serviceProviderId: ana });
    expect(r.status).toBe(200);
    expect((await json(r)).data.serviceProviderId).toBe(ana);
    expect(await proveedoraDe(futuro)).toBe(ana);
    expect(await proveedoraDe(pasado)).toBe(lucia);
    expect(await proveedoraDe(cancelado)).toBe(lucia);
    expect(await proveedoraDe(otraHora)).toBe(lucia);
    await db.update(activitySchedules).set({ serviceProviderId: lucia }).where(eq(activitySchedules.id, sch));
  });

  it("un turno futuro fuera de la vigencia del horario no se toca", async () => {
    const c1 = await crearClienta("C1");
    const acotado = await horario(actId, 3, "20:00:00", "21:00:00", {
      serviceProviderId: lucia, validFrom: "2026-01-01", validUntil: "2026-12-31",
    });
    const fuera = await turno(c1, new Date("2030-01-02T23:00:00Z")); // 20:00 ART, año 2030
    const r = await pedir("PATCH", `/activities/schedules/${acotado}`, { serviceProviderId: ana });
    expect(r.status).toBe(200);
    expect(await proveedoraDe(fuera)).toBe(lucia);
  });

  it("el cambio a una proveedora que ya tiene ese horario: 409 con el mensaje", async () => {
    // schLucia y schAna son el mismo miércoles 12:00: pasar el de Lucía a Ana las fusionaría.
    const r = await pedir("PATCH", `/activities/schedules/${schLucia}`, { serviceProviderId: ana });
    expect(r.status).toBe(409);
    expect((await json(r)).error).toBe(`Esa proveedora ya tiene un horario de ${QA}_Pilates a esa hora`);
    const [s] = await db.select().from(activitySchedules).where(eq(activitySchedules.id, schLucia));
    expect(s!.serviceProviderId).toBe(lucia);
  });

  it("cambiar la proveedora y el horario a la vez: 400 y no cambia nada", async () => {
    const c1 = await crearClienta("C1");
    const futuro = await turno(c1, new Date(FUTURO.getTime() + 6 * 3600_000));
    for (const extra of [{ dayOfWeek: 4 }, { startTime: "19:00:00", endTime: "20:00:00" }]) {
      const r = await pedir("PATCH", `/activities/schedules/${sch}`, { serviceProviderId: ana, ...extra });
      expect(r.status).toBe(400);
      expect((await json(r)).error).toBe("Cambiá la proveedora y el día u horario por separado");
    }
    const [s] = await db.select().from(activitySchedules).where(eq(activitySchedules.id, sch));
    expect(s!.serviceProviderId).toBe(lucia);
    expect(s!.dayOfWeek).toBe(3);
    expect(s!.startTime).toBe("18:00:00");
    expect(await proveedoraDe(futuro)).toBe(lucia);
  });

  it("alta duplicada (mismo día, hora, máquina y proveedora): 409", async () => {
    const r = await pedir("POST", `/activities/${actId}/schedules`, {
      dayOfWeek: 3, startTime: "12:00:00", endTime: "13:00:00", serviceProviderId: lucia,
    });
    expect(r.status).toBe(409);
    expect((await json(r)).error).toBe(`Esa proveedora ya tiene un horario de ${QA}_Pilates a esa hora`);
  });

  it("mover un horario al lugar de otro de la misma proveedora: 409; a un lugar libre: 200", async () => {
    const mover = await horario(actId, 3, "19:00:00", "20:00:00", { serviceProviderId: lucia });
    const r = await pedir("PATCH", `/activities/schedules/${mover}`, { startTime: "12:00:00", endTime: "13:00:00" });
    expect(r.status).toBe(409);
    expect((await json(r)).error).toBe(`Esa proveedora ya tiene un horario de ${QA}_Pilates a esa hora`);
    const ok = await pedir("PATCH", `/activities/schedules/${mover}`, { startTime: "19:30:00", endTime: "20:30:00" });
    expect(ok.status).toBe(200);
  });

  it("proveedora que no existe: 400 'Esa proveedora no existe' en alta y en PATCH", async () => {
    const fantasma = "00000000-0000-4000-8000-000000000000";
    const a = await pedir("POST", `/activities/${actId}/schedules`, {
      dayOfWeek: 6, startTime: "10:00:00", endTime: "11:00:00", serviceProviderId: fantasma,
    });
    expect(a.status).toBe(400);
    expect((await json(a)).error).toBe("Esa proveedora no existe");
    const b = await pedir("PATCH", `/activities/schedules/${sch}`, { serviceProviderId: fantasma });
    expect(b.status).toBe(400);
    expect((await json(b)).error).toBe("Esa proveedora no existe");
  });

  it("con la proveedora archivada se puede editar el cupo mandando la misma serviceProviderId; cambiar A una archivada da 400", async () => {
    const [arch] = await db
      .insert(serviceProviders)
      .values({ fullName: `${QA}_Archivada` })
      .returning({ id: serviceProviders.id });
    const archSch = await horario(actId, 5, "08:00:00", "09:00:00", { serviceProviderId: arch!.id, capacity: 2 });
    await db.update(serviceProviders).set({ status: "inactive" }).where(eq(serviceProviders.id, arch!.id));
    const ok = await pedir("PATCH", `/activities/schedules/${archSch}`, { capacity: 5, serviceProviderId: arch!.id });
    expect(ok.status).toBe(200);
    expect((await json(ok)).data.capacity).toBe(5);
    const mal = await pedir("PATCH", `/activities/schedules/${sch}`, { serviceProviderId: arch!.id });
    expect(mal.status).toBe(400);
    expect((await json(mal)).error).toBe("Esa proveedora no existe");
  });

  it("dejar una Clase sin proveedora: 400", async () => {
    const r = await pedir("PATCH", `/activities/schedules/${sch}`, { serviceProviderId: null });
    expect(r.status).toBe(400);
  });
});

describe("/api/class-attendance acepta machineId y providerId en null", () => {
  it("POST con machineId: null y providerId: null da 200 y guarda la asistencia", async () => {
    const pasada = new Date("2026-03-04T15:00:00Z");
    const c1 = await crearClienta("C1");
    const [s] = await db
      .insert(trainingSubscriptions)
      .values({ activityId: actId, customerId: c1, subscriptionStartDate: "2026-01-01", status: "active", monthlyAmount: "8000" })
      .returning({ id: trainingSubscriptions.id });
    await db.insert(appointments).values({
      customerId: c1, activityId: actId, serviceProviderId: lucia, status: "scheduled",
      appointmentStart: pasada, appointmentEnd: new Date(pasada.getTime() + 3600_000), durationMinutes: 60,
    });
    const r = await pedir("POST", "/class-attendance", {
      activityId: actId, startsAt: pasada.toISOString(), machineId: null, providerId: null,
      entries: [{ subscriptionId: s!.id, attended: true }],
    });
    expect(r.status).toBe(200);
    const filas = await db.select().from(activityAttendance).where(eq(activityAttendance.subscriptionId, s!.id));
    expect(filas).toHaveLength(1);
    expect(filas[0]!.attended).toBe(true);
  });
});

describe("la clase sin proveedora: el roster no mezcla la de al lado", () => {
  // Máquina con un horario "Sin proveedora" y otro de Lucía a la misma hora:
  // son dos clases, y Asistencias de la vacía no puede traer a la de Lucía.
  const pasada = new Date("2026-03-04T15:00:00Z");
  async function dosClases() {
    const c1 = await crearClienta("C1");
    const c2 = await crearClienta("C2");
    const subs: string[] = [];
    for (const [cu, pr] of [[c1, null], [c2, lucia]] as const) {
      const [s] = await db
        .insert(trainingSubscriptions)
        .values({ activityId: actId, customerId: cu, subscriptionStartDate: "2026-01-01", status: "active", monthlyAmount: "8000" })
        .returning({ id: trainingSubscriptions.id });
      subs.push(s!.id);
      await db.insert(appointments).values({
        customerId: cu, activityId: actId, serviceProviderId: pr, status: "scheduled",
        appointmentStart: pasada, appointmentEnd: new Date(pasada.getTime() + 3600_000), durationMinutes: 60,
      });
    }
    return subs;
  }

  it("getClassRoster con providerId null trae sólo los turnos sin proveedora", async () => {
    await dosClases();
    const vacia = await trainingSubscriptionsService.getClassRoster(actId, pasada.toISOString(), undefined, null);
    expect(vacia.map((r) => r.customerName)).toEqual([`${QA}_C1`]);
  });

  it("GET ?providerId=none trae sólo la clase sin proveedora; sin providerId, las dos", async () => {
    await dosClases();
    const q = `activityId=${actId}&startsAt=${encodeURIComponent(pasada.toISOString())}`;
    const vacia = await (await pedir("GET", `/class-attendance?${q}&providerId=none&machineId=none`)).json() as { data: { customerName: string }[] };
    expect(vacia.data.map((r) => r.customerName)).toEqual([`${QA}_C1`]);
    const todas = await (await pedir("GET", `/class-attendance?${q}`)).json() as { data: unknown[] };
    expect(todas.data).toHaveLength(2);
  });

  it("POST con providerId 'none' rechaza la suscripción de la clase de Lucía", async () => {
    const subs = await dosClases();
    const mal = await pedir("POST", "/class-attendance", {
      activityId: actId, startsAt: pasada.toISOString(), providerId: "none", machineId: "none",
      entries: [{ subscriptionId: subs[1]!, attended: true }],
    });
    expect(mal.status).toBe(400);
    const bien = await pedir("POST", "/class-attendance", {
      activityId: actId, startsAt: pasada.toISOString(), providerId: "none", machineId: "none",
      entries: [{ subscriptionId: subs[0]!, attended: true }],
    });
    expect(bien.status).toBe(200);
  });
});
