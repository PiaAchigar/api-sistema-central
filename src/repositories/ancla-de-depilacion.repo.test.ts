import { afterAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "../db/schema";
import type { Db } from "../db/client";
import { anclaDeDepilacion } from "./ancla-de-depilacion.repo";
import { listCatalogoVendible } from "./catalogo-venta.repo";
import { listServices } from "./services.repo";

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
