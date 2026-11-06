import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq, inArray, like } from "drizzle-orm";
import * as schema from "../../db/schema";
import {
  bodyZone,
  contacts,
  customerPurchase,
  customerPurchaseService,
  customers,
  depilationCombo,
  depilationComboZone,
  zoneExclusion,
} from "../../db/schema";
import type { Db } from "../../db/client";
import type { AppBindings, Variables } from "../../env";
import { calcularPrecioCombo, type Categoria } from "../../lib/depilation-pricing";
import { listComprasDeCliente } from "../../repositories/compras.repo";
import { leerConfig, listarCombos, listarZonasPublicas } from "../../repositories/depilacion.repo";
import { datosParaAgendar } from "../../repositories/turno-de-depilacion.repo";
import { usarConfigDeDepilacionDeTest } from "../../test-support/depilation-config";
import { compraBody, comprasRouter } from "./compras";

/**
 * Vender zonas de depilación sueltas: del catálogo a la agenda, contra la base.
 * Lo que más importa acá es lo de después de vender: la compra tiene que poder
 * agendarse igual que un pack.
 */
usarConfigDeDepilacionDeTest();

const URL_DB = "postgresql://piubella:piubella@localhost:5499/piubella";
const QA = "ZZ_QA_ZONAS_SUELTAS";
const pg = postgres(URL_DB, { max: 1, fetch_types: false, prepare: false });
const db = drizzle(pg, { schema }) as unknown as Db;
const API_KEY = "qa-zonas-sueltas-key";
const ENV = { HYPERDRIVE: { connectionString: URL_DB }, API_KEY } as unknown as AppBindings;

const app = new Hono<{ Bindings: AppBindings; Variables: Variables }>();
app.onError((err, c) => {
  if ("status" in err && typeof err.status === "number") {
    return c.json({ error: err.message }, err.status as 400);
  }
  return c.json({ error: String(err) }, 500);
});
app.route("/", comprasRouter);

const pedir = (ruta: string, body?: unknown) =>
  app.request(
    ruta,
    {
      method: body ? "POST" : "GET",
      headers: { "Content-Type": "application/json", "x-api-key": API_KEY },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
    ENV,
  );

type Zona = { id: string; name: string; category: string };
let zonaA: Zona;
let zonaB: Zona;
let parExcluido: [string, string];
let mujerId = "";
let hombreId = "";

async function crearClienta(nombre: string, sexo: "mujer" | "hombre") {
  const [contacto] = await db.insert(contacts).values({ name: nombre, sexo }).returning({ id: contacts.id });
  const [cliente] = await db.insert(customers).values({ contactId: contacto!.id }).returning({ id: customers.id });
  return cliente!.id;
}

async function limpiar() {
  const clientas = await db
    .select({ id: customers.id, contactId: customers.contactId })
    .from(customers)
    .innerJoin(contacts, eq(contacts.id, customers.contactId))
    .where(like(contacts.name, `${QA}%`));
  const ids = clientas.map((c) => c.id);
  if (ids.length > 0) {
    const compras = await db
      .select({ id: customerPurchase.id })
      .from(customerPurchase)
      .where(inArray(customerPurchase.customerId, ids));
    if (compras.length > 0) {
      const compraIds = compras.map((c) => c.id);
      await db.delete(customerPurchaseService).where(inArray(customerPurchaseService.customerPurchaseId, compraIds));
      await db.delete(customerPurchase).where(inArray(customerPurchase.id, compraIds));
    }
    await db.delete(customers).where(inArray(customers.id, ids));
    await db
      .delete(contacts)
      .where(inArray(contacts.id, clientas.map((c) => c.contactId).filter((v): v is string => v != null)));
  }
  const combos = await db
    .select({ id: depilationCombo.id })
    .from(depilationCombo)
    .where(eq(depilationCombo.kind, "a_medida"));
  if (combos.length > 0) {
    const comboIds = combos.map((c) => c.id);
    await db.delete(depilationComboZone).where(inArray(depilationComboZone.comboId, comboIds));
    await db.delete(depilationCombo).where(inArray(depilationCombo.id, comboIds));
  }
}

beforeAll(async () => {
  await limpiar();
  mujerId = await crearClienta(`${QA}_MUJER`, "mujer");
  hombreId = await crearClienta(`${QA}_HOMBRE`, "hombre");
  const [excluida] = await db.select().from(zoneExclusion).limit(1);
  if (!excluida) throw new Error("La base no tiene exclusiones de zonas: ¿corriste las migraciones?");
  parExcluido = [excluida.zoneId, excluida.excludesZoneId];
  const activas = await db
    .select({ id: bodyZone.id, name: bodyZone.name, category: bodyZone.category })
    .from(bodyZone)
    .where(eq(bodyZone.isActive, true));
  const excluidas = await db.select().from(zoneExclusion);
  const conExclusion = new Set(excluidas.flatMap((e) => [e.zoneId, e.excludesZoneId]));
  const libres = activas.filter((z) => !conExclusion.has(z.id));
  [zonaA, zonaB] = (libres.length >= 2 ? libres : activas) as [Zona, Zona];
});

afterAll(async () => {
  await limpiar();
  await pg.end();
});

describe("el catálogo trae las zonas para vender", () => {
  it("con su precio por sexo y con qué no se pueden combinar", async () => {
    const res = await pedir("/purchases/catalog");
    expect(res.status).toBe(200);
    const { zonas, packDeZonas } = (await res.json()) as {
      zonas: { id: string; nombre: string; precioMujer: number; precioHombre: number; excluye: string[] }[];
      packDeZonas: { sesiones: number; descuentoPct: number };
    };
    const config = await leerConfig(db);
    const a = zonas.find((z) => z.id === zonaA.id)!;
    expect(a.nombre).toBe(zonaA.name);
    expect(a.precioMujer).toBe(config.precioLista.mujer[zonaA.category as Categoria]);
    expect(a.precioHombre).toBe(config.precioLista.hombre[zonaA.category as Categoria]);
    expect(zonas.find((z) => z.id === parExcluido[0])!.excluye).toContain(parExcluido[1]);
    expect(packDeZonas.sesiones).toBe(config.packSesiones);
  });
});

describe("POST /purchases/quote con zonas", () => {
  const cotizar = (over: object = {}) =>
    pedir("/purchases/quote", {
      origen: "zonas",
      zonaIds: [zonaA.id, zonaB.id],
      sessions: 1,
      customerId: mujerId,
      ...over,
    });

  it("cotiza con la fórmula de zonas y no crea nada todavía", async () => {
    const antes = await db.select({ id: depilationCombo.id }).from(depilationCombo);
    const res = await cotizar();
    expect(res.status).toBe(200);
    const q = (await res.json()) as Record<string, unknown>;
    const config = await leerConfig(db);
    const zonas = [zonaA, zonaB].map((z) => ({ id: z.id, nombre: z.name, categoria: z.category as Categoria }));
    expect(q.finalAmount).toBe(calcularPrecioCombo(zonas, "mujer", config).total);
    expect(q.description).toContain(zonaA.name);
    expect(q.zonaIds).toEqual([zonaA.id, zonaB.id]);
    expect(q.depilationComboId).toBeNull();
    expect(await db.select({ id: depilationCombo.id }).from(depilationCombo)).toHaveLength(antes.length);
  });

  it("a un hombre le cotiza en su tarifa", async () => {
    const config = await leerConfig(db);
    const q = (await (await cotizar({ customerId: hombreId })).json()) as { finalAmount: number };
    const zonas = [zonaA, zonaB].map((z) => ({ id: z.id, nombre: z.name, categoria: z.category as Categoria }));
    expect(q.finalAmount).toBe(calcularPrecioCombo(zonas, "hombre", config).total);
  });

  it("rechaza dos zonas que no se pueden combinar", async () => {
    const res = await cotizar({ zonaIds: parExcluido });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/no se pueden combinar/);
  });

  it("rechaza una zona que no existe", async () => {
    const res = await cotizar({ zonaIds: ["00000000-0000-4000-8000-000000000000"] });
    expect(res.status).toBe(400);
  });

  it("rechaza no elegir ninguna", async () => {
    expect((await cotizar({ zonaIds: [] })).status).toBe(400);
  });
});

describe("POST /purchases con zonas", () => {
  async function vender(zonaIds: string[], sessions = 1) {
    const q = await (
      await pedir("/purchases/quote", { origen: "zonas", zonaIds, sessions, customerId: mujerId })
    ).json();
    return pedir("/purchases", { ...(q as object), customerId: mujerId });
  }

  it("crea una compra con una línea por sesión y se puede agendar como un pack", async () => {
    const res = await vender([zonaA.id, zonaB.id], 2);
    expect(res.status).toBe(201);
    const compra = (await res.json()) as { id: string; depilationComboId: string };

    const [combo] = await db.select().from(depilationCombo).where(eq(depilationCombo.id, compra.depilationComboId));
    expect(combo!.kind).toBe("a_medida");
    expect(combo!.isPublishedWeb).toBe(false);

    const lineas = await db
      .select()
      .from(customerPurchaseService)
      .where(eq(customerPurchaseService.customerPurchaseId, compra.id));
    expect(lineas).toHaveLength(2);
    expect(lineas.every((l) => l.depilationComboId === compra.depilationComboId)).toBe(true);

    const ficha = await listComprasDeCliente(db, mujerId);
    const enFicha = ficha.find((c) => c.id === compra.id)!;
    expect(enFicha.zonasDelPack?.map((z) => z.nombre).sort()).toEqual([zonaA.name, zonaB.name].sort());

    const agenda = await datosParaAgendar(db, lineas[0]!.id);
    expect(agenda).not.toBeNull();
    expect(agenda!.zonas.map((z) => z.id)).toEqual(expect.arrayContaining([zonaA.id, zonaB.id]));
  });

  it("las mismas zonas, en otro orden, reusan el mismo registro", async () => {
    const uno = (await (await vender([zonaA.id, zonaB.id])).json()) as { depilationComboId: string };
    const dos = (await (await vender([zonaB.id, zonaA.id])).json()) as { depilationComboId: string };
    expect(dos.depilationComboId).toBe(uno.depilationComboId);
  });

  it("otras zonas son otro registro", async () => {
    const uno = (await (await vender([zonaA.id, zonaB.id])).json()) as { depilationComboId: string };
    const dos = (await (await vender([zonaA.id])).json()) as { depilationComboId: string };
    expect(dos.depilationComboId).not.toBe(uno.depilationComboId);
  });

  it("no aparecen en las listas de combos ni en el catálogo de venta", async () => {
    const { depilationComboId } = (await (await vender([zonaA.id, zonaB.id])).json()) as {
      depilationComboId: string;
    };
    expect((await listarCombos(db)).some((c) => c.id === depilationComboId)).toBe(false);
    const catalogo = (await (await pedir("/purchases/catalog")).json()) as { depilacion: { id: string }[] };
    expect(catalogo.depilacion.some((c) => c.id === depilationComboId)).toBe(false);
  });

  it("si el precio cambió desde que se cotizó, no vende", async () => {
    const q = (await (
      await pedir("/purchases/quote", { origen: "zonas", zonaIds: [zonaA.id], sessions: 1, customerId: mujerId })
    ).json()) as { finalAmount: number; discountedAmount: number; baseAmount: number };
    const res = await pedir("/purchases", {
      ...q,
      customerId: mujerId,
      finalAmount: 1,
      discountedAmount: 1,
      baseAmount: 1,
    });
    expect(res.status).toBe(400);
  });

  it("zonas sueltas no llevan promo", () => {
    const base = {
      customerId: "11111111-1111-4111-8111-111111111111",
      description: "x",
      sessionsTotal: 1,
      baseAmount: 1,
      discountedAmount: 1,
      finalAmount: 1,
      zonaIds: ["11111111-1111-4111-8111-111111111111"],
    };
    expect(compraBody.safeParse(base).success).toBe(true);
    expect(
      compraBody.safeParse({ ...base, promotionId: "22222222-2222-4222-8222-222222222222" }).success,
    ).toBe(false);
  });
});

describe("las zonas en la web pública", () => {
  it("salen las activas con los precios de mujer y de hombre", async () => {
    const config = await leerConfig(db);
    const publicas = await listarZonasPublicas(db);
    const a = publicas.find((z) => z.id === zonaA.id)!;
    expect(a.nombre).toBe(zonaA.name);
    expect(a.precioMujer).toBe(config.precioLista.mujer[zonaA.category as Categoria]);
    expect(a.precioHombre).toBe(config.precioLista.hombre[zonaA.category as Categoria]);
  });
});
