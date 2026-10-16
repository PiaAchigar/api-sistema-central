import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq, like, notLike } from "drizzle-orm";
import * as schema from "../db/schema";
import { bodyZone, categories, combos, depilationCombo, service, serviceCategory, training } from "../db/schema";
import type { Db } from "../db/client";
import { AREA_CAPACITACIONES, AREA_DEPILACION, listCatalogoVendible } from "./catalogo-venta.repo";
import { crearCombo, hardDeleteCombo } from "./depilacion.repo";
import { createCombo, deleteComboPermanently } from "./combos.repo";

/**
 * "Vender desde el turno" (spec 2026-10-16): la agenda arma el select de
 * áreas con lo que viene acá, así que cada item tiene que decir de qué área
 * es. Un área ARCHIVADA se lee igual: Estética, Medicina y Masajes están
 * archivadas a propósito en producción (ver DOCUMENTACION_BD) y filtrar por
 * activas dejaría todo el catálogo en "Sin área".
 */
const pgClient = postgres("postgresql://piubella:piubella@localhost:5499/piubella", {
  max: 1,
  fetch_types: false,
  prepare: false,
});
const db = drizzle(pgClient, { schema }) as unknown as Db;

const QA = "ZZ_QA_AREA_VENTA";

let areaId: string;
let servicioConAreaId: string;
let servicioSinAreaId: string;
let comboId: string;
let packDepiId: string;
let capacitacionId: string;

async function limpiar() {
  const depi = await db.select({ id: depilationCombo.id }).from(depilationCombo).where(like(depilationCombo.name, `${QA}%`));
  for (const c of depi) await hardDeleteCombo(db, c.id);
  const gen = await db.select({ id: combos.id }).from(combos).where(like(combos.name, `${QA}%`));
  for (const c of gen) await deleteComboPermanently(db, c.id);
  const servs = await db.select({ id: service.id }).from(service).where(like(service.name, `${QA}%`));
  for (const s of servs) {
    await db.delete(serviceCategory).where(eq(serviceCategory.serviceId, s.id));
    await db.delete(service).where(eq(service.id, s.id));
  }
  await db.delete(training).where(like(training.name, `${QA}%`));
  await db.delete(categories).where(like(categories.name, `${QA}%`));
}

beforeAll(async () => {
  await limpiar();

  // Archivada a propósito: es el caso de producción.
  const [area] = await db
    .insert(categories)
    .values({ name: `${QA}_AREA`, kind: "area", isActive: false, displayOrder: 0 })
    .returning({ id: categories.id });
  areaId = area!.id;

  const [conArea] = await db
    .insert(service)
    .values({ name: `${QA}_SERVICIO_CON_AREA`, isActive: true, noVendible: false, unitPriceList: "10000", unitPriceCash: "9000" })
    .returning({ id: service.id });
  servicioConAreaId = conArea!.id;
  await db.insert(serviceCategory).values({ serviceId: servicioConAreaId, categoryId: areaId });

  const [sinArea] = await db
    .insert(service)
    .values({ name: `${QA}_SERVICIO_SIN_AREA`, isActive: true, noVendible: false, unitPriceList: "10000", unitPriceCash: "9000" })
    .returning({ id: service.id });
  servicioSinAreaId = sinArea!.id;

  const combo = await createCombo(
    db,
    { name: `${QA}_COMBO`, priceType: "percentage", discountPercentage: 10, validityMonths: 12, areaCategoryId: areaId, kind: "combo" },
    [{ serviceId: servicioConAreaId, sessionsIncluded: 1 }],
  );
  comboId = combo!.id;

  const [zona] = await db.select({ id: bodyZone.id }).from(bodyZone).where(notLike(bodyZone.name, "ZZ_QA%")).limit(1);
  const pack = await crearCombo(db, { name: `${QA}_PACK_DEPI`, kind: "pack_fijo", fixedPrice: 50000, zonaIds: [zona!.id] });
  packDepiId = pack!.id;

  const [cap] = await db
    .insert(training)
    .values({ name: `${QA}_CAPACITACION`, isActive: true, listPrice: "100000", cashPrice: "90000", totalSessions: 1 })
    .returning({ id: training.id });
  capacitacionId = cap!.id;
});

afterAll(async () => {
  await limpiar();
  await pgClient.end();
});

describe("el área de cada item del catálogo de venta", () => {
  it("un servicio trae su categoría de área, aunque esté archivada", async () => {
    const cat = await listCatalogoVendible(db);
    const s = cat.servicios.find((i) => i.id === servicioConAreaId);
    expect(s?.area).toEqual({ id: areaId, nombre: `${QA}_AREA` });
  });

  it("un servicio sin vínculo de área viene con area: null", async () => {
    const cat = await listCatalogoVendible(db);
    const s = cat.servicios.find((i) => i.id === servicioSinAreaId);
    expect(s).toBeDefined();
    expect(s!.area).toBeNull();
  });

  it("un combo trae el área de combos.area_category_id", async () => {
    const cat = await listCatalogoVendible(db);
    const c = cat.combos.find((i) => i.id === comboId);
    expect(c?.area).toEqual({ id: areaId, nombre: `${QA}_AREA` });
  });

  it("un pack de depilación trae el área Depilación Definitiva", async () => {
    const cat = await listCatalogoVendible(db);
    const p = cat.depilacion.find((i) => i.id === packDepiId);
    expect(p?.area?.nombre).toBe(AREA_DEPILACION);
  });

  it("una capacitación trae el área Capacitaciones", async () => {
    const cat = await listCatalogoVendible(db);
    const t = cat.capacitaciones.find((i) => i.id === capacitacionId);
    expect(t?.area?.nombre).toBe(AREA_CAPACITACIONES);
  });

  it("el resto de la forma del item no cambia: sólo se agrega `area`", async () => {
    const cat = await listCatalogoVendible(db);
    const s = cat.servicios.find((i) => i.id === servicioConAreaId)!;
    expect(Object.keys(s).sort()).toEqual(
      ["area", "desglose", "descripcion", "id", "nombre", "origen", "packDescuentoPct", "packSesiones", "politica", "precioDesde", "unitario"].sort(),
    );
  });
});
