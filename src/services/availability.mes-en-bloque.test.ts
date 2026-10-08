import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { inArray, like } from "drizzle-orm";
import * as schema from "../db/schema";
import {
  appointments,
  machines,
  providerAvailabilityExceptions,
  providerSaturdaySchedule,
  service,
  serviceMachine,
  serviceProviderAvailability,
  serviceProviderMachine,
  serviceProviders,
  serviceProviderService,
} from "../db/schema";
import type { Db } from "../db/client";
import { diasDelMes } from "../lib/mes";
import { dayOfWeek, localDateTimeToUtc, todayLocal } from "../lib/time";

vi.mock("../repositories/ancla-de-depilacion.repo", () => ({
  anclaDeDepilacion: async () => {
    throw new Error("sin ancla");
  },
  anclaDeDepilacionOpcional: async () => null,
}));

const { getAvailability, getMonthAvailability } = await import("./availability.service");

const LOCAL_DB_URL = "postgresql://piubella:piubella@localhost:5499/piubella";
const pgClient = postgres(LOCAL_DB_URL, { max: 1 });
const db = drizzle(pgClient, { schema }) as unknown as Db;

const QA = "ZZ_QA_MES_BLOQUE";

/** El mes que viene, como YYYY-MM (siempre entero en el futuro). */
function mesQueViene(): string {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString().slice(0, 7);
}
const MES = mesQueViene();
const DIAS = diasDelMes(MES);
const dia = (n: number) => DIAS[n - 1]!;
const primerSabado = DIAS.find((d) => dayOfWeek(d) === 6)!;
const primerLunes = DIAS.find((d) => dayOfWeek(d) === 1)!;

let servicioId: string;
let servicioMaquinaId: string;
let provId: string;
let otraProvId: string;
let maquinaId: string;

/** Cuenta las consultas: cada una empieza con un `db.select(...)`. */
function contando(base: Db) {
  const cuenta = { n: 0 };
  const proxy = new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === "select") {
        return (...args: unknown[]) => {
          cuenta.n++;
          return (target.select as (...a: unknown[]) => unknown)(...args);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  return { db: proxy as Db, cuenta };
}

async function limpiar() {
  await db.delete(appointments).where(like(appointments.notes, `${QA}%`));
  const provs = await db
    .select({ id: serviceProviders.id })
    .from(serviceProviders)
    .where(like(serviceProviders.fullName, `${QA}%`));
  const ids = provs.map((p) => p.id);
  if (ids.length > 0) {
    await db.delete(providerAvailabilityExceptions).where(inArray(providerAvailabilityExceptions.serviceProviderId, ids));
    await db.delete(providerSaturdaySchedule).where(inArray(providerSaturdaySchedule.serviceProviderId, ids));
    await db.delete(serviceProviderMachine).where(inArray(serviceProviderMachine.serviceProviderId, ids));
    await db.delete(serviceProviderService).where(inArray(serviceProviderService.serviceProviderId, ids));
    await db.delete(serviceProviderAvailability).where(inArray(serviceProviderAvailability.serviceProviderId, ids));
    await db.delete(serviceProviders).where(inArray(serviceProviders.id, ids));
  }
  const maqs = await db.select({ id: machines.id }).from(machines).where(like(machines.name, `${QA}%`));
  if (maqs.length > 0) {
    const mids = maqs.map((m) => m.id);
    await db.delete(serviceMachine).where(inArray(serviceMachine.machineId, mids));
    await db.delete(machines).where(inArray(machines.id, mids));
  }
  await db.delete(service).where(like(service.name, `${QA}%`));
}

beforeAll(async () => {
  await limpiar();

  const servs = await db
    .insert(service)
    .values([
      { name: `${QA}_SERVICIO`, isActive: true, estimatedDurationMinutes: 60, requiresMachine: false },
      { name: `${QA}_CON_MAQUINA`, isActive: true, estimatedDurationMinutes: 60, requiresMachine: true },
    ])
    .returning({ id: service.id });
  servicioId = servs[0]!.id;
  servicioMaquinaId = servs[1]!.id;

  const provs = await db
    .insert(serviceProviders)
    .values([
      { fullName: `${QA}_PROV`, status: "active" },
      { fullName: `${QA}_OTRA`, status: "active" },
    ])
    .returning({ id: serviceProviders.id });
  provId = provs[0]!.id;
  otraProvId = provs[1]!.id;

  // El acuerdo con el servicio sin máquina VENCE el día 20: del 21 en
  // adelante esta proveedora no lo ofrece.
  await db.insert(serviceProviderService).values([
    { serviceProviderId: provId, serviceId: servicioId, paymentType: "fixed_per_service", rate: "1000", isActive: true, validUntil: dia(20) },
    { serviceProviderId: provId, serviceId: servicioMaquinaId, paymentType: "fixed_per_service", rate: "1000", isActive: true },
    { serviceProviderId: otraProvId, serviceId: servicioMaquinaId, paymentType: "fixed_per_service", rate: "1000", isActive: true },
  ]);

  // Lunes a viernes 09–13; los miércoles recién desde el día 15.
  await db.insert(serviceProviderAvailability).values([
    ...[1, 2, 4, 5].map((dow) => ({
      serviceProviderId: provId, dayOfWeek: dow, workStartTime: "09:00:00", workEndTime: "13:00:00", isActive: true,
    })),
    { serviceProviderId: provId, dayOfWeek: 3, workStartTime: "09:00:00", workEndTime: "13:00:00", isActive: true, validFrom: dia(15) },
    // La otra proveedora sólo para ocupar la máquina.
    ...[1, 2, 3, 4, 5].map((dow) => ({
      serviceProviderId: otraProvId, dayOfWeek: dow, workStartTime: "09:00:00", workEndTime: "13:00:00", isActive: true,
    })),
  ]);

  // Del 8 al 10 no trabaja (rango). El 22 sólo trabaja 09:00–09:30: no entra 1 h.
  await db.insert(providerAvailabilityExceptions).values([
    { serviceProviderId: provId, dateStart: dia(8), dateEnd: dia(10), isWorking: false },
    { serviceProviderId: provId, dateException: dia(22), isWorking: true, timeOverrideStart: "09:00:00", timeOverrideEnd: "09:30:00" },
  ]);

  // Un sábado puntual trabaja 10–12.
  await db.insert(providerSaturdaySchedule).values({
    serviceProviderId: provId, saturdayDate: primerSabado, isWorking: true, workStartTime: "10:00:00", workEndTime: "12:00:00",
  });

  // Máquina: las dos certificadas; el primer lunes la ocupa la otra proveedora toda la mañana.
  const [maq] = await db.insert(machines).values({ name: `${QA}_MAQ`, status: "active" }).returning({ id: machines.id });
  maquinaId = maq!.id;
  await db.insert(serviceMachine).values({ serviceId: servicioMaquinaId, machineId: maquinaId, isPrimaryMachine: true });
  await db.insert(serviceProviderMachine).values([
    { serviceProviderId: provId, machineId: maquinaId },
    { serviceProviderId: otraProvId, machineId: maquinaId },
  ]);
  await db.insert(appointments).values({
    serviceProviderId: otraProvId,
    serviceId: servicioMaquinaId,
    machineId: maquinaId,
    appointmentStart: localDateTimeToUtc(primerLunes, 9 * 60),
    appointmentEnd: localDateTimeToUtc(primerLunes, 13 * 60),
    durationMinutes: 240,
    status: "scheduled",
    notes: QA,
  });
}, 30000);

afterAll(async () => {
  await limpiar();
  await pgClient.end();
});

/** Lo que diría el cálculo de siempre, un día por vez. */
async function diaPorDia(serviceId: string, providerId: string): Promise<string[]> {
  const hoy = todayLocal();
  const libres: string[] = [];
  for (const d of DIAS.filter((x) => x >= hoy)) {
    const r = await getAvailability(db, serviceId, d, providerId);
    if (r.slots.length > 0) libres.push(d);
  }
  return libres;
}

describe("getMonthAvailability trae el mes en bloque", () => {
  it("da exactamente lo mismo que pedir día por día (vigencias, excepciones, sábados)", async () => {
    const esperado = await diaPorDia(servicioId, provId);
    // Sanidad del fixture: sí hay días, y los casos raros están adentro.
    expect(esperado.length).toBeGreaterThan(5);
    expect(esperado).not.toContain(dia(9)); // excepción de rango
    expect(esperado).not.toContain(dia(22)); // override que no alcanza
    expect(esperado).toContain(primerSabado); // sábado puntual
    expect(esperado.every((d) => d <= dia(20))).toBe(true); // acuerdo vencido

    const r = await getMonthAvailability(db, servicioId, provId, MES);
    expect(r.availableDays).toEqual(esperado);
  });

  it("con máquina: también lo mismo, y el día con la máquina ocupada no aparece", async () => {
    const esperado = await diaPorDia(servicioMaquinaId, provId);
    expect(esperado).not.toContain(primerLunes);

    const r = await getMonthAvailability(db, servicioMaquinaId, provId, MES);
    expect(r.availableDays).toEqual(esperado);
  });

  it("hace un puñado de consultas para todo el mes, no ~9 por día", async () => {
    // Antes: ~9 consultas por cada día del mes (~250). Contra producción
    // cada una cuesta cientos de ms, y el calendario tardaba ~20 s en pintar.
    const { db: contada, cuenta } = contando(db);
    await getMonthAvailability(contada, servicioMaquinaId, provId, MES);
    expect(cuenta.n).toBeLessThanOrEqual(12);
  });
});
