import { afterAll, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { and, eq, inArray, like } from "drizzle-orm";
import * as schema from "../db/schema";
import { service, serviceProviders, serviceProviderService } from "../db/schema";
import type { Db } from "../db/client";
import { listAgreementRowsForService, setServiceAgreements } from "./providers.repo";

// Integración real contra Postgres local: lo que se prueba acá es la
// ATOMICIDAD de dos escrituras, y eso no existe sin una base de verdad.
const LOCAL_DB_URL = "postgresql://piubella:piubella@localhost:5499/piubella";
const QA = "ZZ_QA_ACUERDOS_TX_";

const pgClient = postgres(LOCAL_DB_URL, { max: 1, fetch_types: false, prepare: false });
const db = drizzle(pgClient, { schema }) as unknown as Db;

const HOY = "2026-09-29";
let servicioId = "";
let provId = "";

async function limpiar() {
  const provs = await db
    .select({ id: serviceProviders.id })
    .from(serviceProviders)
    .where(like(serviceProviders.fullName, `${QA}%`));
  const svcs = await db
    .select({ id: service.id })
    .from(service)
    .where(like(service.name, `${QA}%`));
  const provIds = provs.map((p) => p.id);
  const svcIds = svcs.map((s) => s.id);
  if (svcIds.length > 0) {
    await db.delete(serviceProviderService).where(inArray(serviceProviderService.serviceId, svcIds));
    await db.delete(service).where(inArray(service.id, svcIds));
  }
  if (provIds.length > 0) {
    await db.delete(serviceProviders).where(inArray(serviceProviders.id, provIds));
  }
}

beforeEach(async () => {
  await limpiar();
  const [p] = await db
    .insert(serviceProviders)
    .values({ fullName: `${QA}ROMINA`, status: "active" })
    .returning({ id: serviceProviders.id });
  provId = p!.id;
  const [s] = await db
    .insert(service)
    .values({ name: `${QA}SERVICIO`, isActive: true })
    .returning({ id: service.id });
  servicioId = s!.id;

  // El acuerdo vigente que NO se tiene que perder.
  await db.insert(serviceProviderService).values({
    serviceProviderId: provId,
    serviceId: servicioId,
    paymentType: "per_hour",
    rate: "20000",
    validFrom: HOY,
    isActive: true,
  });
});

afterAll(async () => {
  await limpiar();
  await pgClient.end();
});

describe("setServiceAgreements — o pasan las dos escrituras o no pasa ninguna", () => {
  // `setServiceAgreements` cierra los acuerdos viejos con varios UPDATE y
  // DESPUÉS inserta los nuevos. Sin transacción, un INSERT que falla deja los
  // cierres commiteados y a la proveedora SIN acuerdo activo: el turno no
  // calcula `provider_earning`, queda NULL, y desaparece de la liquidación
  // del mes. `rate = 0` es la palanca porque viola `chk_sps_rate` —el mismo
  // CHECK existe en producción como `service_provider_service_rate_check`.
  it("si el INSERT falla, el acuerdo viejo sigue vigente", async () => {
    await expect(
      setServiceAgreements(db, servicioId, [{ serviceProviderId: provId, paymentType: "per_hour", rate: 0 }], HOY),
    ).rejects.toThrow();

    const vigentes = await listAgreementRowsForService(db, servicioId);
    expect(vigentes).toHaveLength(1);
    expect(Number(vigentes[0]!.rate)).toBe(20000);
  });

  it("si el INSERT anda, el cambio se aplica entero", async () => {
    await setServiceAgreements(
      db,
      servicioId,
      [{ serviceProviderId: provId, paymentType: "fixed_per_service", rate: 35000 }],
      HOY,
    );
    const vigentes = await listAgreementRowsForService(db, servicioId);
    expect(vigentes).toHaveLength(1);
    expect(vigentes[0]!.paymentType).toBe("fixed_per_service");
    expect(Number(vigentes[0]!.rate)).toBe(35000);

    // Y el viejo quedó cerrado, no borrado (§4: cerrar viejo + crear nuevo).
    const todas = await db
      .select({ isActive: serviceProviderService.isActive })
      .from(serviceProviderService)
      .where(
        and(
          eq(serviceProviderService.serviceId, servicioId),
          eq(serviceProviderService.serviceProviderId, provId),
        ),
      );
    expect(todas).toHaveLength(2);
    expect(todas.filter((t) => t.isActive)).toHaveLength(1);
  });
});
