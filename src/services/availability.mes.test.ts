import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { inArray, like } from "drizzle-orm";
import * as schema from "../db/schema";
import {
  appointments,
  service,
  serviceProviderAvailability,
  serviceProviders,
  serviceProviderService,
} from "../db/schema";
import type { Db } from "../db/client";
import { diasDelMes } from "../lib/mes";
import { dayOfWeek, todayLocal } from "../lib/time";

vi.mock("../repositories/ancla-de-depilacion.repo", () => ({
  anclaDeDepilacion: async () => {
    throw new Error("sin ancla");
  },
  anclaDeDepilacionOpcional: async () => null,
}));

const { createAppointment } = await import("./appointments.service");
const { getMonthAvailability } = await import("./availability.service");

const LOCAL_DB_URL = "postgresql://piubella:piubella@localhost:5499/piubella";
const pgClient = postgres(LOCAL_DB_URL, { max: 1 });
const db = drizzle(pgClient, { schema }) as unknown as Db;

const QA = "ZZ_QA_MES_DISPONIBLE";
const CUSTOMER_ID = "dddddddd-0000-0000-0000-000000000001";

let servicioId: string;
let provId: string;

/** El mes que viene, como YYYY-MM (siempre entero en el futuro). */
function mesQueViene(): string {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString().slice(0, 7);
}
const MES = mesQueViene();
const LUNES = diasDelMes(MES).filter((d) => dayOfWeek(d) === 1);

async function limpiar() {
  await db.delete(appointments).where(like(appointments.notes, `${QA}%`));
  const provs = await db
    .select({ id: serviceProviders.id })
    .from(serviceProviders)
    .where(like(serviceProviders.fullName, `${QA}%`));
  const ids = provs.map((p) => p.id);
  if (ids.length > 0) {
    await db.delete(serviceProviderService).where(inArray(serviceProviderService.serviceProviderId, ids));
    await db.delete(serviceProviderAvailability).where(inArray(serviceProviderAvailability.serviceProviderId, ids));
    await db.delete(serviceProviders).where(inArray(serviceProviders.id, ids));
  }
  await db.delete(service).where(like(service.name, `${QA}%`));
}

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
  provId = p!.id;
  await db.insert(serviceProviderService).values({
    serviceProviderId: provId,
    serviceId: servicioId,
    paymentType: "fixed_per_service",
    rate: "1000",
    isActive: true,
  });
  // Una ventana de EXACTAMENTE 30 minutos los lunes (10:00–10:30): un turno a esa
  // hora deja el día sin ningún hueco. Es lo que permite probar `excludeAppointmentId`.
  await db.insert(serviceProviderAvailability).values({
    serviceProviderId: provId,
    dayOfWeek: 1,
    workStartTime: "10:00:00",
    workEndTime: "10:30:00",
    isActive: true,
  });
}, 30000);

afterAll(async () => {
  await limpiar();
  await pgClient.end();
});

describe("getMonthAvailability", () => {
  it("devuelve exactamente los días en que la proveedora trabaja (los lunes) y nada más", async () => {
    const r = await getMonthAvailability(db, servicioId, provId, MES);
    expect(r.month).toBe(MES);
    expect(r.availableDays).toEqual(LUNES);
  });

  it("un día con el único hueco tomado deja de aparecer… salvo que el turno sea el propio", async () => {
    const lunes = LUNES[0]!;
    const t = await createAppointment(db, {
      customerId: CUSTOMER_ID,
      serviceId: servicioId,
      providerId: provId,
      start: `${lunes}T13:00:00.000Z`, // 10:00 en Argentina
      notes: QA,
    });

    const sin = await getMonthAvailability(db, servicioId, provId, MES);
    expect(sin.availableDays).not.toContain(lunes);
    expect(sin.availableDays).toEqual(LUNES.slice(1));

    const con = await getMonthAvailability(db, servicioId, provId, MES, t.id);
    expect(con.availableDays).toContain(lunes);
  });

  it("una proveedora que no ofrece el servicio no tiene ningún día", async () => {
    const [otra] = await db
      .insert(serviceProviders)
      .values({ fullName: `${QA}_OTRA`, status: "active" })
      .returning({ id: serviceProviders.id });
    const r = await getMonthAvailability(db, servicioId, otra!.id, MES);
    expect(r.availableDays).toEqual([]);
  });

  it("en el mes corriente nunca devuelve días pasados", async () => {
    const hoy = todayLocal();
    const r = await getMonthAvailability(db, servicioId, provId, hoy.slice(0, 7));
    expect(r.availableDays.every((d) => d >= hoy)).toBe(true);
  });
});
