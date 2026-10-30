import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq, inArray, like } from "drizzle-orm";
import * as schema from "../db/schema";
import {
  categories,
  combos,
  comboService,
  priceAdjustmentItems,
  priceAdjustments,
  service,
  serviceCategory,
} from "../db/schema";
import type { Db } from "../db/client";
import { AppError } from "../lib/errors";
import type { Ajuste } from "../lib/ajuste-de-precios";
import { aplicarAjuste, simularAjuste } from "./ajuste-de-precios.repo";

// Integración real contra Postgres local: los FOR UPDATE, la CTE recursiva y la
// transacción no se ejercitan con un doble de `Db`. Cada test arma sus datos.
const LOCAL_DB_URL = "postgresql://piubella:piubella@localhost:5499/piubella";
const P = "ZZ_QA_PRECIOS_";

const pgClient = postgres(LOCAL_DB_URL, { max: 1, fetch_types: false, prepare: false });
const db = drizzle(pgClient, { schema }) as unknown as Db;

const subir10: Ajuste = { direccion: "subir", modo: "porcentaje", valor: 10, redondeo: 1 };
const usuario = { id: "u-qa", email: "qa@piubella.test" };

let padre: string, hija: string, nieta: string, otra: string;
let sHija: string, sNieta: string, sAmbas: string, sInactivo: string, sNoVendible: string, sSinEfectivo: string, sAfuera: string;
let comboActivo: string, comboInactivo: string, packActivo: string;
const adjustmentIds: string[] = [];

async function crearServicio(nombre: string, lista: string | null, efectivo: string | null, extra: Partial<typeof service.$inferInsert> = {}) {
  const sid = crypto.randomUUID();
  await db.insert(service).values({
    id: sid, name: P + nombre, unitPriceList: lista, unitPriceCash: efectivo, isActive: true, noVendible: false, ...extra,
  });
  return sid;
}
const vincular = (serviceId: string, categoryId: string) =>
  db.insert(serviceCategory).values({ serviceId, categoryId });

async function precios(sid: string) {
  const [r] = await db.select({ l: service.unitPriceList, c: service.unitPriceCash }).from(service).where(eq(service.id, sid));
  return { l: r!.l === null ? null : Number(r!.l), c: r!.c === null ? null : Number(r!.c) };
}

async function limpiar() {
  const svcs = await db.select({ id: service.id }).from(service).where(like(service.name, `${P}%`));
  const cmbs = await db.select({ id: combos.id }).from(combos).where(like(combos.name, `${P}%`));
  const cats = await db.select({ id: categories.id }).from(categories).where(like(categories.name, `${P}%`));
  const sIds = svcs.map((s) => s.id), cIds = cmbs.map((c) => c.id), catIds = cats.map((c) => c.id);
  if (adjustmentIds.length) await db.delete(priceAdjustments).where(inArray(priceAdjustments.id, adjustmentIds));
  if (cIds.length) await db.delete(comboService).where(inArray(comboService.comboId, cIds));
  if (cIds.length) await db.delete(combos).where(inArray(combos.id, cIds));
  if (sIds.length) await db.delete(serviceCategory).where(inArray(serviceCategory.serviceId, sIds));
  if (sIds.length) await db.delete(service).where(inArray(service.id, sIds));
  if (catIds.length) await db.delete(categories).where(inArray(categories.id, catIds));
}

beforeAll(async () => {
  await limpiar();
  [padre, hija, nieta, otra] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
  await db.insert(categories).values([
    { id: padre, name: P + "padre", parentCategoryId: null },
    { id: hija, name: P + "hija", parentCategoryId: padre },
    { id: nieta, name: P + "nieta", parentCategoryId: hija },
    { id: otra, name: P + "otra", parentCategoryId: null },
  ]);
  sHija = await crearServicio("hija", "10000.00", "9000.00");
  sNieta = await crearServicio("nieta", "20000.00", "18000.00");
  sAmbas = await crearServicio("ambas", "30000.00", "27000.00");
  sInactivo = await crearServicio("inactivo", "1000.00", "900.00", { isActive: false });
  sNoVendible = await crearServicio("novendible", "1000.00", "900.00", { noVendible: true });
  sSinEfectivo = await crearServicio("sinefectivo", "5000.00", null);
  sAfuera = await crearServicio("afuera", "7000.00", "6000.00");
  await vincular(sHija, hija);
  await vincular(sNieta, nieta);
  await vincular(sAmbas, hija);
  await vincular(sAmbas, nieta);
  await vincular(sInactivo, hija);
  await vincular(sNoVendible, nieta);
  await vincular(sSinEfectivo, hija);
  await vincular(sAfuera, otra);

  comboActivo = crypto.randomUUID();
  comboInactivo = crypto.randomUUID();
  packActivo = crypto.randomUUID();
  await db.insert(combos).values([
    { id: comboActivo, name: P + "combo", isActive: true, priceType: "fixed", fixedPrice: "1000.00", validityMonths: 6, kind: "combo", areaCategoryId: padre },
    { id: comboInactivo, name: P + "combo inactivo", isActive: false, priceType: "fixed", fixedPrice: "1000.00", validityMonths: 6, kind: "combo", areaCategoryId: padre },
    { id: packActivo, name: P + "pack", isActive: true, priceType: "fixed", fixedPrice: "1000.00", validityMonths: 6, kind: "pack", packSessions: 4, areaCategoryId: padre },
  ]);
  await db.insert(comboService).values([
    { comboId: comboActivo, serviceId: sHija, sessionsIncluded: 1, servicePrice: "10000.00" },
    { comboId: comboInactivo, serviceId: sNieta, sessionsIncluded: 1, servicePrice: "20000.00" },
    { comboId: packActivo, serviceId: sHija, sessionsIncluded: 4, servicePrice: "10000.00" },
  ]);
});

afterAll(async () => {
  await limpiar();
  await pgClient.end();
});

describe("simularAjuste", () => {
  it("trae los servicios de la hija y la nieta, una sola vez el que está en las dos", async () => {
    const { servicios } = await simularAjuste(db, { categoryId: padre, ajuste: subir10 });
    const ids = servicios.map((s) => s.id);
    expect(ids.filter((i) => i === sAmbas)).toHaveLength(1);
    expect([...ids].sort()).toEqual([sHija, sNieta, sAmbas, sSinEfectivo].sort());
    const fila = servicios.find((s) => s.id === sHija)!;
    expect(fila).toMatchObject({ listaAntes: 10000, listaDespues: 11000, efectivoAntes: 9000, efectivoDespues: 9900, estado: "cambia" });
  });

  it("no trae servicios inactivos ni noVendible", async () => {
    const { servicios } = await simularAjuste(db, { categoryId: padre, ajuste: subir10 });
    const ids = servicios.map((s) => s.id);
    expect(ids).not.toContain(sInactivo);
    expect(ids).not.toContain(sNoVendible);
    expect(ids).not.toContain(sAfuera);
  });

  it("trae los combos activos que incluyen un servicio de la rama, no los inactivos", async () => {
    const { combos: cs } = await simularAjuste(db, { categoryId: padre, ajuste: subir10 });
    expect(cs.map((c) => c.id)).toContain(comboActivo);
    expect(cs.map((c) => c.id)).not.toContain(comboInactivo);
    expect(cs.find((c) => c.id === comboActivo)).toMatchObject({ nombre: P + "combo", areaId: padre, kind: "combo" });
  });

  it("trae también los packs y los marca con kind 'pack'", async () => {
    const { combos: cs } = await simularAjuste(db, { categoryId: padre, ajuste: subir10 });
    expect(cs.find((c) => c.id === packActivo)).toMatchObject({ nombre: P + "pack", areaId: padre, kind: "pack" });
  });
});

describe("aplicarAjuste", () => {
  it("actualiza los mandados, deja los no mandados y escribe el historial", async () => {
    const r = await aplicarAjuste(db, {
      categoryId: padre,
      ajuste: subir10,
      servicios: [
        { id: sHija, listaVista: 10000, efectivoVista: 9000 },
        { id: sNieta, listaVista: 20000, efectivoVista: 18000 },
      ],
      usuario,
    });
    adjustmentIds.push(r.ajusteId);
    expect(r.aplicados).toBe(2);
    expect(await precios(sHija)).toEqual({ l: 11000, c: 9900 });
    expect(await precios(sNieta)).toEqual({ l: 22000, c: 19800 });
    expect(await precios(sAmbas)).toEqual({ l: 30000, c: 27000 });

    const [cab] = await db.select().from(priceAdjustments).where(eq(priceAdjustments.id, r.ajusteId));
    if (!cab) throw new Error("sin cabecera");
    expect(cab).toMatchObject({ servicesCount: 2, direction: "subir", mode: "porcentaje", categoryId: padre, userEmail: usuario.email, userId: usuario.id, rounding: 1 });
    expect(Number(cab.value)).toBe(10);
    const items = await db.select().from(priceAdjustmentItems).where(eq(priceAdjustmentItems.adjustmentId, r.ajusteId));
    expect(items).toHaveLength(2);
    const it = items.find((i) => i.serviceId === sHija)!;
    expect([it.listBefore, it.listAfter, it.cashBefore, it.cashAfter].map(Number)).toEqual([10000, 11000, 9000, 9900]);
  });

  it("si el efectivo es null no escribe unit_price_cash", async () => {
    const r = await aplicarAjuste(db, {
      categoryId: padre, ajuste: subir10,
      servicios: [{ id: sSinEfectivo, listaVista: 5000, efectivoVista: null }],
      usuario,
    });
    adjustmentIds.push(r.ajusteId);
    expect(await precios(sSinEfectivo)).toEqual({ l: 5500, c: null });
    // y si el efectivo era 0, queda en 0
    await db.update(service).set({ unitPriceCash: "0.00" }).where(eq(service.id, sSinEfectivo));
    const r2 = await aplicarAjuste(db, {
      categoryId: padre, ajuste: subir10,
      servicios: [{ id: sSinEfectivo, listaVista: 5500, efectivoVista: 0 }],
      usuario,
    });
    adjustmentIds.push(r2.ajusteId);
    expect(await precios(sSinEfectivo)).toEqual({ l: 6050, c: 0 });
  });

  it("409 con el id en conflictos si el precio visto no coincide; nada cambia", async () => {
    const antes = await precios(sAmbas);
    const cuantos = (await db.select().from(priceAdjustments)).length;
    const err = await aplicarAjuste(db, {
      categoryId: padre, ajuste: subir10,
      servicios: [
        { id: sAmbas, listaVista: 1, efectivoVista: antes.c },
        { id: sHija, listaVista: 11000, efectivoVista: 9900 },
      ],
      usuario,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err.status).toBe(409);
    expect(err.conflictos).toEqual([sAmbas]);
    expect(await precios(sAmbas)).toEqual(antes);
    expect(await precios(sHija)).toEqual({ l: 11000, c: 9900 });
    expect((await db.select().from(priceAdjustments)).length).toBe(cuantos);
  });

  it("409 si cambió sólo el efectivo (la lista visto coincide); nada cambia", async () => {
    const antes = await precios(sHija);
    const err = await aplicarAjuste(db, {
      categoryId: padre, ajuste: subir10,
      servicios: [{ id: sHija, listaVista: antes.l, efectivoVista: (antes.c ?? 0) + 1 }],
      usuario,
    }).catch((e) => e);
    expect(err.status).toBe(409);
    expect(err.conflictos).toEqual([sHija]);
    expect(await precios(sHija)).toEqual(antes);
  });

  it("400 si un id está fuera de la rama; nada cambia", async () => {
    const err = await aplicarAjuste(db, {
      categoryId: padre, ajuste: subir10,
      servicios: [
        { id: sAmbas, listaVista: 30000, efectivoVista: 27000 },
        { id: sAfuera, listaVista: 7000, efectivoVista: 6000 },
      ],
      usuario,
    }).catch((e) => e);
    expect(err.status).toBe(400);
    expect(await precios(sAmbas)).toEqual({ l: 30000, c: 27000 });
    expect(await precios(sAfuera)).toEqual({ l: 7000, c: 6000 });
  });

  it("400 si bajar deja el precio en 0 o menos; nada cambia", async () => {
    const err = await aplicarAjuste(db, {
      categoryId: padre,
      ajuste: { direccion: "bajar", modo: "monto", valor: 30000, redondeo: 1 },
      servicios: [{ id: sAmbas, listaVista: 30000, efectivoVista: 27000 }],
      usuario,
    }).catch((e) => e);
    expect(err.status).toBe(400);
    expect(await precios(sAmbas)).toEqual({ l: 30000, c: 27000 });
  });
});
