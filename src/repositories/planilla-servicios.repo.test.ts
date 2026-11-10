import { afterAll, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { and, eq, inArray, like } from "drizzle-orm";
import * as schema from "../db/schema";
import {
  categories,
  combos,
  comboService,
  machines,
  priceAdjustments,
  priceAdjustmentItems,
  products,
  service,
  serviceCategory,
  serviceMachine,
  serviceProduct,
  serviceProviders,
  serviceProviderService,
} from "../db/schema";
import type { Db } from "../db/client";
import { AppError } from "../lib/errors";
import { todayLocal } from "../lib/time";
import type { ContenidoPlanilla } from "../lib/planilla-servicios";
import {
  aplicarPlanilla,
  cargarCatalogo,
  ErroresDePlanilla,
  leerPlanilla,
  previsualizarPlanilla,
} from "./planilla-servicios.repo";

// Integración real contra Postgres local: las transacciones, los FOR UPDATE y las
// consultas recursivas no se ejercitan con un doble de `Db`. Cada test arma sus datos.
const LOCAL_DB_URL = "postgresql://piubella:piubella@localhost:5499/piubella";
const P = "ZZ_QA_PLANILLA_";
const AREA = P + "area";

const pgClient = postgres(LOCAL_DB_URL, { max: 1, fetch_types: false, prepare: false });
const db = drizzle(pgClient, { schema }) as unknown as Db;
const usuario = { id: "u-qa", email: "qa@piubella.test" };

let areaId: string, madre: string, hija: string;
let sActivo: string, sArchivado: string;
let ana: string, bea: string, maq: string, gel: string, crema: string;
let combo: string;

async function limpiar() {
  const svcs = await db.select({ id: service.id }).from(service).where(like(service.name, `${P}%`));
  const cats = await db.select({ id: categories.id }).from(categories).where(like(categories.name, `${P}%`));
  const cmbs = await db.select({ id: combos.id }).from(combos).where(like(combos.name, `${P}%`));
  const provs = await db.select({ id: serviceProviders.id }).from(serviceProviders).where(like(serviceProviders.fullName, `${P}%`));
  const prods = await db.select({ id: products.id }).from(products).where(like(products.name, `${P}%`));
  const maqs = await db.select({ id: machines.id }).from(machines).where(like(machines.name, `${P}%`));
  const sIds = svcs.map((s) => s.id), catIds = cats.map((c) => c.id), cIds = cmbs.map((c) => c.id);
  const pIds = provs.map((p) => p.id), prIds = prods.map((p) => p.id), mIds = maqs.map((m) => m.id);
  if (catIds.length) await db.delete(priceAdjustments).where(inArray(priceAdjustments.categoryId, catIds));
  if (cIds.length) await db.delete(comboService).where(inArray(comboService.comboId, cIds));
  if (cIds.length) await db.delete(combos).where(inArray(combos.id, cIds));
  if (sIds.length) {
    await db.delete(serviceProviderService).where(inArray(serviceProviderService.serviceId, sIds));
    await db.delete(serviceProduct).where(inArray(serviceProduct.serviceId, sIds));
    await db.delete(serviceMachine).where(inArray(serviceMachine.serviceId, sIds));
    await db.delete(serviceCategory).where(inArray(serviceCategory.serviceId, sIds));
    await db.delete(service).where(inArray(service.id, sIds));
  }
  if (pIds.length) await db.delete(serviceProviders).where(inArray(serviceProviders.id, pIds));
  if (prIds.length) await db.delete(products).where(inArray(products.id, prIds));
  if (mIds.length) await db.delete(machines).where(inArray(machines.id, mIds));
  if (catIds.length) await db.delete(categories).where(inArray(categories.id, catIds));
}

beforeEach(async () => {
  await limpiar();
  [areaId, madre, hija] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
  await db.insert(categories).values([
    { id: areaId, name: AREA, kind: "area", isActive: false },
    { id: madre, name: P + "madre", kind: "tecnica", isActive: true },
    { id: hija, name: P + "hija", kind: "tecnica", isActive: true, parentCategoryId: madre },
  ]);
  [ana, bea, maq, gel, crema] = [1, 2, 3, 4, 5].map(() => crypto.randomUUID());
  await db.insert(serviceProviders).values([
    { id: ana, fullName: P + "Ana", status: "active" },
    { id: bea, fullName: P + "Bea", status: "active" },
  ]);
  await db.insert(machines).values({ id: maq, name: P + "Maquina", status: "active" });
  await db.insert(products).values([
    { id: gel, name: P + "Gel", isActive: true, isSupply: true },
    { id: crema, name: P + "Crema", isActive: true, isSupply: true },
  ]);
  [sActivo, sArchivado] = [crypto.randomUUID(), crypto.randomUUID()];
  await db.insert(service).values([
    {
      id: sActivo, name: P + "Activo", unitPriceList: "10000.00", unitPriceCash: "9000.00",
      estimatedDurationMinutes: 30, requiresOperator: true, requiresMachine: false,
      isVisible: true, isFeatured: false, isActive: true, noVendible: false, webSortOrder: 0,
    },
    {
      id: sArchivado, name: P + "Archivado", unitPriceList: "5000.00", unitPriceCash: "4000.00",
      estimatedDurationMinutes: 30, isActive: false, noVendible: false,
    },
  ]);
  await db.insert(serviceCategory).values([
    { serviceId: sActivo, categoryId: areaId },
    { serviceId: sActivo, categoryId: hija },
    { serviceId: sArchivado, categoryId: areaId },
  ]);
  await db.insert(serviceMachine).values({ serviceId: sActivo, machineId: maq, isPrimaryMachine: true });
  await db.insert(serviceProviderService).values({
    serviceProviderId: ana, serviceId: sActivo, paymentType: "per_hour", rate: "100.00",
    validFrom: "2026-01-01", isActive: true,
  });
  await db.insert(serviceProduct).values({ serviceId: sActivo, productId: gel, quantity: "2.000" });
  combo = crypto.randomUUID();
  await db.insert(combos).values({
    id: combo, name: P + "combo", isActive: true, priceType: "fixed", fixedPrice: "1000.00",
    validityMonths: 6, kind: "combo", areaCategoryId: areaId,
  });
  await db.insert(comboService).values({ comboId: combo, serviceId: sActivo, sessionsIncluded: 1, servicePrice: "10000.00" });
});

afterAll(async () => {
  await limpiar();
  await pgClient.end();
});

const clonar = (c: ContenidoPlanilla): ContenidoPlanilla => JSON.parse(JSON.stringify(c));

async function bajar() {
  const original = (await leerPlanilla(db, AREA)).contenido;
  return { original, editada: clonar(original) };
}

async function filaDeServicio(id: string) {
  const [r] = await db.select().from(service).where(eq(service.id, id));
  return r!;
}

describe("leerPlanilla", () => {
  it("devuelve sólo el servicio activo con sus relaciones y celdas en castellano", async () => {
    const r = await leerPlanilla(db, AREA);
    expect(r.area).toEqual({ id: areaId, nombre: AREA });
    expect(r.contenido.servicios).toHaveLength(1);
    expect(r.contenido.servicios[0]).toMatchObject({
      fila: 2, id: sActivo, nombre: P + "Activo", precioLista: 10000, precioEfectivo: 9000, duracion: 30,
      requiereOperadora: "Sí", requiereMaquina: "No", maquina: P + "Maquina", visibleWeb: "Sí", destacado: "No",
      codigo: null, descripcion: null,
    });
    expect(r.contenido.acuerdos).toEqual([
      { fila: 2, servicio: P + "Activo", proveedora: P + "Ana", tipoDePago: "Por hora", tarifa: 100 },
    ]);
    expect(r.contenido.insumos).toEqual([{ fila: 2, servicio: P + "Activo", insumo: P + "Gel", cantidad: 2 }]);
    // la categoría área no aparece; la hija va con su ruta completa
    expect(r.contenido.categorias).toEqual([
      { fila: 2, servicio: P + "Activo", categoria: `${P}madre › ${P}hija` },
    ]);
    expect(r.listas.maquinas).toContain(P + "Maquina");
    expect(r.listas.proveedoras).toEqual(expect.arrayContaining([P + "Ana", P + "Bea"]));
    expect(r.listas.insumos).toEqual(expect.arrayContaining([P + "Gel", P + "Crema"]));
    expect(r.listas.categorias).toEqual(expect.arrayContaining([P + "madre", `${P}madre › ${P}hija`]));
    expect(r.listas.categorias).not.toContain(AREA);
    expect(r.listas.tiposDePago).toEqual(["Por hora", "Porcentaje (%)", "Fijo por servicio"]);
  });

  it("área inexistente es 404", async () => {
    await expect(leerPlanilla(db, P + "no existe")).rejects.toMatchObject({ status: 404 });
  });

  it("no incluye servicios no vendibles", async () => {
    await db.update(service).set({ noVendible: true }).where(eq(service.id, sActivo));
    expect((await leerPlanilla(db, AREA)).contenido.servicios).toEqual([]);
  });
});

describe("cargarCatalogo", () => {
  it("nombre a id, null si el nombre se repite", async () => {
    await db.insert(serviceProviders).values({ fullName: P + "Ana", status: "active" });
    const c = await cargarCatalogo(db, areaId);
    expect(c.maquinas.get(P + "Maquina")).toBe(maq);
    expect(c.insumos.get(P + "Gel")).toBe(gel);
    expect(c.proveedoras.get(P + "Bea")).toBe(bea);
    expect(c.proveedoras.get(P + "Ana")).toBeNull();
    expect(c.categorias.get(`${P}madre › ${P}hija`)).toBe(hija);
    expect(c.idsDelArea.has(sActivo)).toBe(true);
    expect(c.idsDelArea.has(sArchivado)).toBe(false);
  });
});

describe("previsualizarPlanilla", () => {
  it("avisa combos afectados y no escribe nada", async () => {
    const { original, editada } = await bajar();
    editada.servicios[0]!.precioLista = 12000;
    const v = await previsualizarPlanilla(db, { area: AREA, original, editada });
    expect(v.errores).toEqual([]);
    expect(v.resumen.serviciosModificados).toBe(1);
    expect(v.combosAfectados).toEqual([{ id: combo, nombre: P + "combo", kind: "combo" }]);
    expect(Number((await filaDeServicio(sActivo)).unitPriceList)).toBe(10000);
    const ajustes = await db.select().from(priceAdjustments).where(eq(priceAdjustments.categoryId, areaId));
    expect(ajustes).toHaveLength(0);
  });

  it("sin cambio de precio no hay combos afectados", async () => {
    const { original, editada } = await bajar();
    editada.servicios[0]!.descripcion = "hola";
    const v = await previsualizarPlanilla(db, { area: AREA, original, editada });
    expect(v.combosAfectados).toEqual([]);
  });
});

describe("aplicarPlanilla", () => {
  it("aplica todo junto", async () => {
    const { original, editada } = await bajar();
    editada.servicios[0]!.precioLista = 12000;
    editada.servicios[0]!.descripcion = "nueva";
    editada.servicios.push({
      fila: 3, id: null, nombre: P + "Nuevo", codigo: null, descripcion: null, precioLista: 20000, precioEfectivo: 18000,
      duracion: 60, unidad: null, requiereOperadora: "Sí", requiereMaquina: "Sí", maquina: P + "Maquina",
      visibleWeb: "Sí", destacado: "No", ordenWeb: null, beneficios: null, contraindicaciones: null, instrucciones: null,
    });
    editada.acuerdos.push({ fila: 3, servicio: P + "Activo", proveedora: P + "Bea", tipoDePago: "Porcentaje (%)", tarifa: 30 });
    editada.insumos.push({ fila: 3, servicio: P + "Activo", insumo: P + "Crema", cantidad: 1.5 });
    editada.categorias.push({ fila: 3, servicio: P + "Nuevo", categoria: `${P}madre › ${P}hija` });

    const resumen = await aplicarPlanilla(db, { area: AREA, original, editada }, usuario);
    expect(resumen).toEqual({ serviciosNuevos: 1, serviciosModificados: 1, acuerdos: 1, insumos: 1, categorias: 1 });

    const s = await filaDeServicio(sActivo);
    expect(Number(s.unitPriceList)).toBe(12000);
    expect(s.description).toBe("nueva");
    expect(Number(s.unitPriceCash)).toBe(9000);

    const [nuevo] = await db.select().from(service).where(eq(service.name, P + "Nuevo"));
    expect(nuevo).toBeDefined();
    expect(nuevo!.taxCategory).toBeNull();
    expect(nuevo!.isActive).toBe(true);
    const cats = (await db.select().from(serviceCategory).where(eq(serviceCategory.serviceId, nuevo!.id))).map((c) => c.categoryId);
    expect(cats.sort()).toEqual([areaId, hija].sort());
    const [m] = await db.select().from(serviceMachine).where(eq(serviceMachine.serviceId, nuevo!.id));
    expect(m).toMatchObject({ machineId: maq, isPrimaryMachine: true });

    const acus = await db.select().from(serviceProviderService).where(and(eq(serviceProviderService.serviceId, sActivo), eq(serviceProviderService.serviceProviderId, bea)));
    expect(acus).toHaveLength(1);
    expect(acus[0]).toMatchObject({ paymentType: "percentage", isActive: true, validFrom: todayLocal() });
    expect(Number(acus[0]!.rate)).toBe(30);
    const ins = await db.select().from(serviceProduct).where(and(eq(serviceProduct.serviceId, sActivo), eq(serviceProduct.productId, crema)));
    expect(Number(ins[0]!.quantity)).toBe(1.5);
  });

  it("si hay un error no guarda nada", async () => {
    const { original, editada } = await bajar();
    editada.servicios[0]!.precioLista = 12000;
    editada.acuerdos[0]!.tarifa = 0;
    let err: unknown;
    try {
      await aplicarPlanilla(db, { area: AREA, original, editada }, usuario);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ErroresDePlanilla);
    expect(err).toBeInstanceOf(AppError);
    expect((err as ErroresDePlanilla).status).toBe(400);
    expect((err as ErroresDePlanilla).errores.length).toBeGreaterThan(0);
    expect(Number((await filaDeServicio(sActivo)).unitPriceList)).toBe(10000);
    const acus = await db.select().from(serviceProviderService).where(eq(serviceProviderService.serviceId, sActivo));
    expect(acus).toHaveLength(1);
    expect(Number(acus[0]!.rate)).toBe(100);
    expect(await db.select().from(priceAdjustments).where(eq(priceAdjustments.categoryId, areaId))).toHaveLength(0);
  });

  it("no cierra acuerdos ausentes", async () => {
    const { original, editada } = await bajar();
    editada.acuerdos = [];
    editada.insumos = [];
    editada.servicios[0]!.descripcion = "algo";
    await aplicarPlanilla(db, { area: AREA, original, editada }, usuario);
    const acus = await db.select().from(serviceProviderService).where(eq(serviceProviderService.serviceId, sActivo));
    expect(acus).toHaveLength(1);
    expect(acus[0]!.isActive).toBe(true);
    expect(await db.select().from(serviceProduct).where(eq(serviceProduct.serviceId, sActivo))).toHaveLength(1);
  });

  it("cambio de tarifa deja el viejo cerrado con valid_until hoy", async () => {
    const { original, editada } = await bajar();
    editada.acuerdos[0]!.tarifa = 150;
    await aplicarPlanilla(db, { area: AREA, original, editada }, usuario);
    const acus = await db.select().from(serviceProviderService).where(eq(serviceProviderService.serviceId, sActivo));
    expect(acus).toHaveLength(2);
    const viejo = acus.find((a) => !a.isActive)!;
    const nuevo = acus.find((a) => a.isActive)!;
    expect(Number(viejo.rate)).toBe(100);
    expect(viejo.validUntil).toBe(todayLocal());
    expect(Number(nuevo.rate)).toBe(150);
    expect(nuevo.validFrom).toBe(todayLocal());
  });

  it("cambio de precio deja historial", async () => {
    const { original, editada } = await bajar();
    editada.servicios[0]!.precioLista = 12000;
    editada.servicios[0]!.precioEfectivo = 11000;
    await aplicarPlanilla(db, { area: AREA, original, editada }, usuario);
    const [cab] = await db.select().from(priceAdjustments).where(eq(priceAdjustments.categoryId, areaId));
    expect(cab).toMatchObject({ mode: "planilla", userEmail: usuario.email, userId: usuario.id, servicesCount: 1, direction: null, value: null, rounding: null });
    const items = await db.select().from(priceAdjustmentItems).where(eq(priceAdjustmentItems.adjustmentId, cab!.id));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ serviceId: sActivo });
    expect([items[0]!.listBefore, items[0]!.listAfter, items[0]!.cashBefore, items[0]!.cashAfter].map(Number)).toEqual([10000, 12000, 9000, 11000]);
  });

  it("sin cambio de precio no hay historial", async () => {
    const { original, editada } = await bajar();
    editada.servicios[0]!.descripcion = "solo texto";
    await aplicarPlanilla(db, { area: AREA, original, editada }, usuario);
    expect(await db.select().from(priceAdjustments).where(eq(priceAdjustments.categoryId, areaId))).toHaveLength(0);
  });

  it("cambiar y quitar la máquina", async () => {
    const { original, editada } = await bajar();
    editada.servicios[0]!.maquina = null;
    await aplicarPlanilla(db, { area: AREA, original, editada }, usuario);
    expect(await db.select().from(serviceMachine).where(eq(serviceMachine.serviceId, sActivo))).toHaveLength(0);
  });

  it("una planilla vieja no pisa un cambio hecho en el sistema", async () => {
    const { original, editada } = await bajar();
    editada.servicios[0]!.precioLista = 12000;
    await db.update(service).set({ unitPriceList: "15000.00" }).where(eq(service.id, sActivo));
    await expect(aplicarPlanilla(db, { area: AREA, original, editada }, usuario)).rejects.toBeInstanceOf(ErroresDePlanilla);
    expect(Number((await filaDeServicio(sActivo)).unitPriceList)).toBe(15000);
  });
});
