import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { and, eq, inArray, like, ne, sql } from "drizzle-orm";
import * as schema from "../db/schema";
import {
  appointments,
  service,
  serviceProviderAvailability,
  serviceProviders,
  serviceProviderService,
} from "../db/schema";
import type { Db } from "../db/client";

/**
 * Ronda de arreglos 3 (Important 1): si el worker sale ANTES que la migración
 * 1.56.0, no se cae la depilación — se cae el turnero ENTERO.
 *
 * `anclaDeDepilacion` tira cuando `depilation_pricing_config.anchor_service_id`
 * está en NULL, y `createAppointment`/`rescheduleAppointment`/
 * `updateAppointmentStatus` la llamaban incondicionalmente, antes de saber si
 * el turno era de depilación. Como las migraciones de este proyecto se
 * aplican A MANO en el SQL Editor de Supabase (CLAUDE.md §5), el orden
 * deploy↔migración no lo garantiza nada: una limpieza de cutis, una clase de
 * Pilates, todo respondía "Internal server error".
 *
 * El módulo del ancla se mockea —en vez de poner `anchor_service_id` en NULL
 * en la base— porque esa columna es GLOBAL: dejarla en NULL aunque sea un
 * instante rompería a cualquier otro archivo de la suite que corra en
 * paralelo. El mock reproduce exactamente el estado "migración sin aplicar":
 * la versión que tira, tira; la opcional devuelve `null`.
 */
vi.mock("../repositories/ancla-de-depilacion.repo", () => ({
  anclaDeDepilacion: async () => {
    throw new Error(
      "La configuración de depilación no tiene servicio ancla: falta aplicar la migración 1.56.0",
    );
  },
  anclaDeDepilacionOpcional: async () => null,
}));

const { createAppointment, rescheduleAppointment, updateAppointmentStatus } = await import(
  "./appointments.service"
);

const LOCAL_DB_URL = "postgresql://piubella:piubella@localhost:5499/piubella";
const pgClient = postgres(LOCAL_DB_URL, { max: 1 });
const db = drizzle(pgClient, { schema }) as unknown as Db;

const QA = "ZZ_QA_SIN_ANCLA";
const CUSTOMER_ID = "dddddddd-0000-0000-0000-000000000001";

let servicioNormalId: string;
let proveedoraId: string;

async function limpiar() {
  await db.delete(appointments).where(like(appointments.notes, `${QA}%`));
  const proveedoras = await db
    .select({ id: serviceProviders.id })
    .from(serviceProviders)
    .where(like(serviceProviders.fullName, `${QA}%`));
  const ids = proveedoras.map((p) => p.id);
  if (ids.length === 0) return;
  await db
    .delete(serviceProviderService)
    .where(inArray(serviceProviderService.serviceProviderId, ids));
  await db
    .delete(serviceProviderAvailability)
    .where(inArray(serviceProviderAvailability.serviceProviderId, ids));
  await db.delete(serviceProviders).where(inArray(serviceProviders.id, ids));
}

beforeAll(async () => {
  await limpiar();

  // Un servicio del catálogo real que NO pida máquina: el punto es que el
  // turno más común del salón se siga pudiendo dar sin el ancla.
  const [normal] = await db
    .select({ id: service.id })
    .from(service)
    .where(
      and(
        eq(service.isActive, true),
        ne(service.requiresMachine, true),
        ne(service.noVendible, true),
        sql`${service.estimatedDurationMinutes} between 15 and 60`,
      ),
    )
    .orderBy(service.id)
    .limit(1);
  servicioNormalId = normal!.id;

  const [proveedora] = await db
    .insert(serviceProviders)
    .values({ fullName: `${QA}_PROVEEDORA`, status: "active" })
    .returning({ id: serviceProviders.id });
  proveedoraId = proveedora!.id;

  await db.insert(serviceProviderService).values({
    serviceProviderId: proveedoraId,
    serviceId: servicioNormalId,
    paymentType: "fixed_per_service",
    rate: "1000",
    isActive: true,
  });
  // Lunes: las fechas de prueba (2026-10-19 y 2026-10-26) caen las dos lunes,
  // y `open_hours` abre 09–20 ese día.
  await db.insert(serviceProviderAvailability).values({
    serviceProviderId: proveedoraId,
    dayOfWeek: 1,
    workStartTime: "09:00:00",
    workEndTime: "20:00:00",
    isActive: true,
  });
}, 30000);

afterAll(async () => {
  await limpiar();
  await pgClient.end();
});

describe("sin el ancla cargada, la agenda que no es de depilación sigue viva", () => {
  let turnoId: string;

  it("se puede crear un turno normal", async () => {
    const turno = await createAppointment(db, {
      customerId: CUSTOMER_ID,
      serviceId: servicioNormalId,
      providerId: proveedoraId,
      start: "2026-10-19T13:00:00.000Z",
      notes: QA,
    });
    turnoId = turno.id;
    expect(turno.status).toBe("scheduled");
  });

  it("se puede reagendar", async () => {
    const movido = await rescheduleAppointment(db, turnoId, "2026-10-26T13:00:00.000Z");
    expect(movido).not.toBeNull();
    expect(movido!.appointmentStart).toEqual(new Date("2026-10-26T13:00:00.000Z"));
  });

  it("se puede confirmar una reserva", async () => {
    const reserva = await createAppointment(db, {
      customerId: CUSTOMER_ID,
      serviceId: servicioNormalId,
      providerId: proveedoraId,
      start: "2026-10-19T16:00:00.000Z",
      status: "reserved",
      expiryMinutes: 60,
      notes: QA,
    });
    const confirmado = await updateAppointmentStatus(db, reserva.id, { status: "scheduled" });
    expect(confirmado!.status).toBe("scheduled");
  });

  /**
   * La otra mitad: sin ancla NO se puede agendar depilación, y el error tiene
   * que ser el de la migración —no un turno creado a medias—. `esDepilacion`
   * pasa a ser `false`, así que un `POST` con `zonas` cae por la validación
   * de "sólo un turno de depilación lleva zonas", que es un 400 explícito.
   */
  it("pero un turno CON zonas sigue siendo rechazado, no creado a medias", async () => {
    await expect(
      createAppointment(db, {
        customerId: CUSTOMER_ID,
        serviceId: servicioNormalId,
        providerId: proveedoraId,
        start: "2026-10-19T18:00:00.000Z",
        zonas: ["11111111-1111-1111-1111-111111111111"],
        notes: QA,
      }),
    ).rejects.toThrow(/depilación/i);
  });
});
