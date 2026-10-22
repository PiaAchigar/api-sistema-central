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
// Las fechas y la ventana de la proveedora salen del horario del local, sólo LEÍDO:
// open_hours no se escribe, porque lo leen otros tests en paralelo.

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

/** "HH:MM[:SS]" a minutos desde medianoche. */
const aMinutos = (hora: string) => {
  const [h, m] = hora.split(":").map(Number);
  return h! * 60 + m!;
};
const aHora = (min: number) =>
  `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}:00`;

const VENTANA_MIN = 120; // ventana de la proveedora: 120 min, dentro del día abierto

const horarios = await db
  .select({
    dayOfWeek: openHours.dayOfWeek,
    openingTime: openHours.openingTime,
    closingTime: openHours.closingTime,
    isOpen: openHours.isOpen,
  })
  .from(openHours);

// Un día abierto con al menos 180 min (60 de margen + la ventana) y uno cerrado, si existen.
const abierto = horarios.find(
  (h) =>
    h.isOpen === true &&
    h.dayOfWeek != null &&
    h.openingTime != null &&
    h.closingTime != null &&
    aMinutos(h.closingTime) - aMinutos(h.openingTime) >= 180,
);
const cerrado = horarios.find((h) => h.isOpen === false && h.dayOfWeek != null);

const DIA_ABIERTO = abierto ? proximo(abierto.dayOfWeek!) : "";
const DIA_CERRADO = cerrado ? proximo(cerrado.dayOfWeek!) : "";

let servicioId: string;

async function limpiar() {
  const provs = db
    .select({ id: serviceProviders.id })
    .from(serviceProviders)
    .where(like(serviceProviders.fullName, `${QA}%`));
  await db.delete(serviceProviderAvailability).where(inArray(serviceProviderAvailability.serviceProviderId, provs));
  await db.delete(serviceProviderService).where(inArray(serviceProviderService.serviceProviderId, provs));
  await db.delete(serviceProviders).where(like(serviceProviders.fullName, `${QA}%`));
  await db.delete(service).where(like(service.name, `${QA}%`));
}

afterAll(async () => {
  await limpiar();
  await pgClient.end();
});

describe.skipIf(!abierto)("POST /api/agenda/availability/lote", () => {
  beforeAll(async () => {
    await limpiar();
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
    // Ventana dentro de las horas del día abierto: arranca 60 min después de la apertura.
    const inicio = aMinutos(abierto!.openingTime!) + 60;
    await db.insert(serviceProviderAvailability).values({
      serviceProviderId: p!.id,
      dayOfWeek: abierto!.dayOfWeek!,
      workStartTime: aHora(inicio),
      workEndTime: aHora(inicio + VENTANA_MIN),
      isActive: true,
    });
  }, 30000);

  it("devuelve un resultado por consulta, en orden", async () => {
    // El día del medio es cerrado si el local tiene alguno; si no, otro día abierto.
    const medio = DIA_CERRADO || DIA_ABIERTO;
    const res = await postLote({
      consultas: [
        { serviceId: servicioId, date: DIA_ABIERTO },
        { serviceId: servicioId, date: medio },
        { serviceId: servicioId, date: DIA_ABIERTO, durationMinutes: 15 },
      ],
    });
    expect(res.status).toBe(200);
    const { resultados } = (await res.json()) as { resultados: any[] };
    expect(resultados.map((r) => [r.date, r.serviceId])).toEqual([
      [DIA_ABIERTO, servicioId],
      [medio, servicioId],
      [DIA_ABIERTO, servicioId],
    ]);
    // Sin durationMinutes usa la duración del servicio (30).
    expect(resultados[0].durationMinutes).toBe(30);
    expect(resultados[2].durationMinutes).toBe(15);
  });

  it("durationMinutes cambia los slots (60 min ofrece menos inicios que 15)", async () => {
    const res = await postLote({
      consultas: [
        { serviceId: servicioId, date: DIA_ABIERTO, durationMinutes: 60 },
        { serviceId: servicioId, date: DIA_ABIERTO, durationMinutes: 15 },
      ],
    });
    const { resultados } = (await res.json()) as { resultados: any[] };
    expect(resultados[0].slots.length).toBeGreaterThan(0);
    expect(resultados[0].slots.length).toBeLessThan(resultados[1].slots.length);
  });

  it.skipIf(!cerrado)("un día cerrado devuelve reason closed", async () => {
    const res = await postLote({ consultas: [{ serviceId: servicioId, date: DIA_CERRADO }] });
    const { resultados } = (await res.json()) as { resultados: any[] };
    expect(resultados[0].reason).toBe("closed");
    expect(resultados[0].slots).toEqual([]);
  });

  it("más de 60 consultas: 400", async () => {
    const consulta = { serviceId: servicioId, date: DIA_ABIERTO };
    const res = await postLote({ consultas: Array(61).fill(consulta) });
    expect(res.status).toBe(400);
  });

  it("sin consultas: 400", async () => {
    expect((await postLote({ consultas: [] })).status).toBe(400);
  });
});
