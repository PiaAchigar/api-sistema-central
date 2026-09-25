import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { and, eq, inArray, like, ne } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "../db/schema";
import { service, serviceProviders, serviceProviderService } from "../db/schema";
import type { Db } from "../db/client";
import { anclaDeDepilacion } from "./ancla-de-depilacion.repo";
import { listCatalogoVendible } from "./catalogo-venta.repo";
import { listServices, listServicesForProvider } from "./services.repo";

const pgClient = postgres("postgresql://piubella:piubella@localhost:5499/piubella", {
  max: 1, fetch_types: false, prepare: false,
});
const db = drizzle(pgClient, { schema }) as unknown as Db;

afterAll(async () => { await pgClient.end(); });

describe("el servicio ancla", () => {
  it("se resuelve desde la config, no buscando por nombre", async () => {
    const id = await anclaDeDepilacion(db);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  /**
   * El ancla no es un servicio vendible: es donde viven la proveedora, la
   * máquina y la tarifa. Si se colara en la solapa "Servicios" del modal de
   * Vender, Laura le vendería a una clienta un servicio de $0.
   */
  it("NO aparece en el catálogo de venta", async () => {
    const ancla = await anclaDeDepilacion(db);
    const catalogo = await listCatalogoVendible(db);
    expect(catalogo.servicios.find((s) => s.id === ancla)).toBeUndefined();
  });

  it("NO aparece en el admin de servicios del dashboard", async () => {
    const ancla = await anclaDeDepilacion(db);
    const servicios = await listServices(db, {});
    expect(servicios.find((s) => s.id === ancla)).toBeUndefined();
  });

  /**
   * El ancla tiene `unit_price_list = 0`: publicada en la lista pública que
   * alimenta piubella_web sería un servicio gratis.
   */
  it("NO aparece en el listado público (el que alimenta piubella_web)", async () => {
    const ancla = await anclaDeDepilacion(db);
    const servicios = await listServices(db, { includeInactive: false });
    expect(servicios.find((s) => s.id === ancla)).toBeUndefined();
  });
});

/**
 * Ronda de arreglos 3 (Important 2). La puesta en marcha OBLIGA a Laura a
 * cargarle al ancla un acuerdo con al menos una proveedora —sin eso no se
 * agenda ninguna depilación—, y apenas lo hace el ancla aparecía en el
 * desplegable "Servicio" del modal de Nuevo Turno (`GET
 * /api/agenda/providers/:id/services`). Elegirla ahí termina en un 400 sin
 * salida: el camino correcto es la pastilla "A agendar" de la ficha.
 *
 * Fixture propio (proveedora + dos acuerdos) porque la base local no trae
 * ninguna proveedora habilitada para el ancla: no se vende, así que nadie la
 * cargó.
 */
describe("el ancla tampoco se ofrece en los servicios de una proveedora", () => {
  const QA = "ZZ_QA_ANCLA_PROV";
  let proveedoraId: string;
  let anclaId: string;
  let servicioNormalId: string;

  async function limpiar() {
    const proveedoras = await db
      .select({ id: serviceProviders.id })
      .from(serviceProviders)
      .where(like(serviceProviders.fullName, `${QA}%`));
    const ids = proveedoras.map((p) => p.id);
    if (ids.length === 0) return;
    await db
      .delete(serviceProviderService)
      .where(inArray(serviceProviderService.serviceProviderId, ids));
    await db.delete(serviceProviders).where(inArray(serviceProviders.id, ids));
  }

  beforeAll(async () => {
    await limpiar();
    anclaId = await anclaDeDepilacion(db);

    const [normal] = await db
      .select({ id: service.id })
      .from(service)
      .where(and(eq(service.isActive, true), ne(service.id, anclaId)))
      .limit(1);
    servicioNormalId = normal!.id;

    const [proveedora] = await db
      .insert(serviceProviders)
      .values({ fullName: `${QA}_PROVEEDORA`, status: "active" })
      .returning({ id: serviceProviders.id });
    proveedoraId = proveedora!.id;

    // Los dos acuerdos, el del ancla y uno normal: sin el segundo, un filtro
    // que devolviera lista vacía siempre pasaría este test.
    await db.insert(serviceProviderService).values([
      {
        serviceProviderId: proveedoraId,
        serviceId: anclaId,
        paymentType: "fixed_per_service",
        rate: "1000",
        isActive: true,
      },
      {
        serviceProviderId: proveedoraId,
        serviceId: servicioNormalId,
        paymentType: "fixed_per_service",
        rate: "1000",
        isActive: true,
      },
    ]);
  }, 30000);

  afterAll(async () => {
    await limpiar();
  });

  it("NO aparece en el desplegable de Servicio del Nuevo Turno", async () => {
    const servicios = await listServicesForProvider(db, proveedoraId);
    expect(servicios.find((s) => s.id === anclaId)).toBeUndefined();
  });

  it("pero el servicio normal de la misma proveedora sí", async () => {
    const servicios = await listServicesForProvider(db, proveedoraId);
    expect(servicios.find((s) => s.id === servicioNormalId)).toBeDefined();
  });
});
