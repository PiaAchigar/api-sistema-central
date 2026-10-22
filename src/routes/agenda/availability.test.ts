import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { inArray, like } from "drizzle-orm";
import * as schema from "../../db/schema";
import {
  openHours,
  service,
  serviceProviderAvailability,
  serviceProviderService,
  serviceProviders,
} from "../../db/schema";
import type { Db } from "../../db/client";
import type { AppBindings } from "../../env";
import { todayLocal } from "../../lib/time";
import { availability, availabilityQuery, loteBody, monthQuery } from "./availability";

const UUID = "11111111-1111-4111-8111-111111111111";

describe("availabilityQuery", () => {
  it("sin excludeAppointmentId sigue siendo válida (el camino de siempre)", () => {
    expect(availabilityQuery.safeParse({ date: "2026-10-19" }).success).toBe(true);
  });

  it("acepta excludeAppointmentId uuid", () => {
    expect(
      availabilityQuery.safeParse({ date: "2026-10-19", excludeAppointmentId: UUID }).success,
    ).toBe(true);
  });

  it("rechaza excludeAppointmentId que no es uuid", () => {
    expect(
      availabilityQuery.safeParse({ date: "2026-10-19", excludeAppointmentId: "x" }).success,
    ).toBe(false);
  });
});

describe("monthQuery", () => {
  it("pide proveedora y mes", () => {
    expect(monthQuery.safeParse({ providerId: UUID, month: "2026-10" }).success).toBe(true);
  });

  it("la proveedora es obligatoria (el calendario siempre pinta para UNA)", () => {
    expect(monthQuery.safeParse({ month: "2026-10" }).success).toBe(false);
  });

  it("rechaza un mes mal formado o inexistente", () => {
    expect(monthQuery.safeParse({ providerId: UUID, month: "2026-13" }).success).toBe(false);
    expect(monthQuery.safeParse({ providerId: UUID, month: "2026-1" }).success).toBe(false);
    expect(monthQuery.safeParse({ providerId: UUID, month: "2026-10-01" }).success).toBe(false);
  });
});

describe("loteBody", () => {
  it("entre 1 y 60 consultas", () => {
    const una = { serviceId: UUID, date: "2026-10-19" };
    expect(loteBody.safeParse({ consultas: [una] }).success).toBe(true);
    expect(loteBody.safeParse({ consultas: [] }).success).toBe(false);
    expect(loteBody.safeParse({ consultas: Array(61).fill(una) }).success).toBe(false);
  });
});

// --- POST /lote contra la base local (cada test arma sus propios datos) ---

const LOCAL_DB_URL = "postgresql://piubella:piubella@localhost:5499/piubella";
const QA = "ZZ_QA_PLAN_LOTE";
const ENV = { HYPERDRIVE: { connectionString: LOCAL_DB_URL } } as unknown as AppBindings;
const pgClient = postgres(LOCAL_DB_URL, { max: 1 });
const db = drizzle(pgClient, { schema }) as unknown as Db;

const app = new Hono<{ Bindings: AppBindings }>();
app.route("/api/agenda/availability", availability);

const postLote = (body: unknown) =>
  app.request(
    "/api/agenda/availability/lote",
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    ENV,
  );

/** Próxima fecha futura (estrictamente después de hoy) con ese día de la semana, YYYY-MM-DD. */
function proximo(diaSemana: number): string {
  const d = new Date(`${todayLocal()}T00:00:00Z`);
  do d.setUTCDate(d.getUTCDate() + 1);
  while (d.getUTCDay() !== diaSemana);
  return d.toISOString().slice(0, 10);
}
const LUNES = proximo(1);
const DOMINGO = proximo(0);

let servicioId: string;
// Horario del local que estos tests necesitan (lunes abierto, domingo cerrado) y el valor
// original, para restaurarlo al terminar: el local lo puede editar.
let horarioOriginal: { id: string; dayOfWeek: number | null; isOpen: boolean | null; openingTime: string | null; closingTime: string | null }[] = [];

beforeAll(async () => {
  await db.delete(serviceProviderAvailability).where(inArray(serviceProviderAvailability.serviceProviderId,
    db.select({ id: serviceProviders.id }).from(serviceProviders).where(like(serviceProviders.fullName, `${QA}%`))));
  await db.delete(serviceProviderService).where(inArray(serviceProviderService.serviceProviderId,
    db.select({ id: serviceProviders.id }).from(serviceProviders).where(like(serviceProviders.fullName, `${QA}%`))));
  await db.delete(serviceProviders).where(like(serviceProviders.fullName, `${QA}%`));
  await db.delete(service).where(like(service.name, `${QA}%`));

  horarioOriginal = await db.select().from(openHours).where(inArray(openHours.dayOfWeek, [0, 1]));
  for (const fila of horarioOriginal) {
    await db
      .update(openHours)
      .set(
        fila.dayOfWeek === 0
          ? { isOpen: false }
          : { isOpen: true, openingTime: "09:00:00", closingTime: "20:00:00" },
      )
      .where(inArray(openHours.id, [fila.id]));
  }

  const [s] = await db
    .insert(service)
    .values({ name: `${QA}_SERVICIO`, isActive: true, estimatedDurationMinutes: 30, requiresMachine: false })
    .returning({ id: service.id });
  servicioId = s!.id;
  const [p] = await db
    .insert(serviceProviders)
    .values({ fullName: `${QA}_PROV`, status: "active" })
    .returning({ id: serviceProviders.id });
  await db.insert(serviceProviderService).values({
    serviceProviderId: p!.id,
    serviceId: servicioId,
    paymentType: "fixed_per_service",
    rate: "1000",
    isActive: true,
  });
  // Lunes 10:00–12:00: 120 minutos de ventana, así 15 y 60 min dan cantidades distintas de inicios.
  await db.insert(serviceProviderAvailability).values({
    serviceProviderId: p!.id,
    dayOfWeek: 1,
    workStartTime: "10:00:00",
    workEndTime: "12:00:00",
    isActive: true,
  });
}, 30000);

afterAll(async () => {
  for (const fila of horarioOriginal) {
    await db
      .update(openHours)
      .set({
        isOpen: fila.isOpen,
        openingTime: fila.openingTime,
        closingTime: fila.closingTime,
      })
      .where(inArray(openHours.id, [fila.id]));
  }
  await db.delete(serviceProviderAvailability).where(inArray(serviceProviderAvailability.serviceProviderId,
    db.select({ id: serviceProviders.id }).from(serviceProviders).where(like(serviceProviders.fullName, `${QA}%`))));
  await db.delete(serviceProviderService).where(inArray(serviceProviderService.serviceProviderId,
    db.select({ id: serviceProviders.id }).from(serviceProviders).where(like(serviceProviders.fullName, `${QA}%`))));
  await db.delete(serviceProviders).where(like(serviceProviders.fullName, `${QA}%`));
  await db.delete(service).where(like(service.name, `${QA}%`));
  await pgClient.end();
});

describe("POST /api/agenda/availability/lote", () => {
  it("devuelve un resultado por consulta, en orden", async () => {
    const res = await postLote({
      consultas: [
        { serviceId: servicioId, date: LUNES },
        { serviceId: servicioId, date: DOMINGO },
        { serviceId: servicioId, date: LUNES, durationMinutes: 15 },
      ],
    });
    expect(res.status).toBe(200);
    const { resultados } = (await res.json()) as { resultados: any[] };
    expect(resultados.map((r) => [r.date, r.serviceId])).toEqual([
      [LUNES, servicioId],
      [DOMINGO, servicioId],
      [LUNES, servicioId],
    ]);
    // Sin durationMinutes usa la duración del servicio (30).
    expect(resultados[0].durationMinutes).toBe(30);
    expect(resultados[2].durationMinutes).toBe(15);
  });

  it("durationMinutes cambia los slots (60 min ofrece menos inicios que 15)", async () => {
    const res = await postLote({
      consultas: [
        { serviceId: servicioId, date: LUNES, durationMinutes: 60 },
        { serviceId: servicioId, date: LUNES, durationMinutes: 15 },
      ],
    });
    const { resultados } = (await res.json()) as { resultados: any[] };
    expect(resultados[0].slots.length).toBeGreaterThan(0);
    expect(resultados[0].slots.length).toBeLessThan(resultados[1].slots.length);
  });

  it("un domingo devuelve reason closed", async () => {
    const res = await postLote({ consultas: [{ serviceId: servicioId, date: DOMINGO }] });
    const { resultados } = (await res.json()) as { resultados: any[] };
    expect(resultados[0].reason).toBe("closed");
    expect(resultados[0].slots).toEqual([]);
  });

  it("más de 60 consultas: 400", async () => {
    const consulta = { serviceId: servicioId, date: LUNES };
    const res = await postLote({ consultas: Array(61).fill(consulta) });
    expect(res.status).toBe(400);
  });

  it("sin consultas: 400", async () => {
    expect((await postLote({ consultas: [] })).status).toBe(400);
  });
});
