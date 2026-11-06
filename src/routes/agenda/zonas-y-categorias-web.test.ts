import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq, like } from "drizzle-orm";
import * as schema from "../../db/schema";
import { bodyZone, categories, depilationPricingConfig } from "../../db/schema";
import type { Db } from "../../db/client";
import type { AppBindings } from "../../env";
import { listarZonasPublicas, listarZonasVendibles } from "../../repositories/depilacion.repo";
import { usarConfigDeDepilacionDeTest } from "../../test-support/depilation-config";
import { categoriesRouter } from "./categories";
import { depilacionRouter } from "./depilacion";

/**
 * Lo que Laura controla de la web desde el panel (1.68.0), contra la base: qué
 * zonas se publican y qué descripción lleva cada categoría.
 */
usarConfigDeDepilacionDeTest();

const URL_DB = "postgresql://piubella:piubella@localhost:5499/piubella";
const QA = "ZZ_QA_WEB_168";
const API_KEY = "qa-web-168-key";
const ENV = { HYPERDRIVE: { connectionString: URL_DB }, API_KEY } as unknown as AppBindings;
const pg = postgres(URL_DB, { max: 1, fetch_types: false, prepare: false });
const db = drizzle(pg, { schema }) as unknown as Db;

const zonas = (ruta: string, method: string, body?: unknown, conClave = true) =>
  depilacionRouter.request(
    ruta,
    {
      method,
      headers: { "content-type": "application/json", ...(conClave ? { "x-api-key": API_KEY } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    },
    ENV,
  );

const cats = (ruta: string, method: string, body?: unknown, conClave = true) =>
  categoriesRouter.request(
    ruta,
    {
      method,
      headers: { "content-type": "application/json", ...(conClave ? { "x-api-key": API_KEY } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    },
    ENV,
  );

async function limpiar() {
  await db.delete(bodyZone).where(like(bodyZone.name, `${QA}%`));
  await db.delete(categories).where(like(categories.name, `${QA}%`));
}

async function crearZona(nombre: string, extra: Record<string, unknown> = {}) {
  const res = await zonas("/zonas", "POST", { name: `${QA} ${nombre}`, category: "chica", ...extra });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; isVisibleWeb: boolean };
}

beforeAll(limpiar);
afterAll(async () => {
  await limpiar();
  await pg.end();
});

describe("zonas visibles en la web", () => {
  it("una zona nueva arranca publicada aunque no se aclare", async () => {
    const z = await crearZona("nueva");
    expect(z.isVisibleWeb).toBe(true);
  });

  it("se puede crear ya oculta", async () => {
    const z = await crearZona("oculta de entrada", { isVisibleWeb: false });
    expect(z.isVisibleWeb).toBe(false);
  });

  it("editar la zona sin mandar el dato no la vuelve a publicar", async () => {
    const z = await crearZona("editada", { isVisibleWeb: false });
    const res = await zonas(`/zonas/${z.id}`, "PATCH", { name: `${QA} editada 2`, category: "chica" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { isVisibleWeb: boolean }).isVisibleWeb).toBe(false);
  });

  it("la zona oculta no sale en la web, pero se sigue pudiendo vender", async () => {
    const z = await crearZona("sólo en el CRM");
    const res = await zonas(`/zonas/${z.id}/visible-web`, "PATCH", { isVisibleWeb: false });
    expect(res.status).toBe(200);

    expect((await listarZonasPublicas(db)).some((p) => p.id === z.id)).toBe(false);
    expect((await listarZonasVendibles(db)).some((v) => v.id === z.id)).toBe(true);
  });

  it("el listado del panel dice cuál está publicada", async () => {
    const z = await crearZona("en el panel", { isVisibleWeb: false });
    const res = await zonas("/zonas", "GET");
    const grupos = (await res.json()) as { chica: { id: string; isVisibleWeb: boolean }[] };
    expect(grupos.chica.find((x) => x.id === z.id)?.isVisibleWeb).toBe(false);
  });

  it("publica los dos precios sin confundirlos", async () => {
    // Distintos a propósito: en producción hoy son iguales, y con precios iguales
    // este test pasaría aunque el de hombre saliera de la tarifa de mujer.
    await db.update(depilationPricingConfig).set({ priceFemaleChica: 12000, priceMaleChica: 14000 });
    const z = await crearZona("con precios");
    const publica = (await listarZonasPublicas(db)).find((p) => p.id === z.id);
    expect(publica?.precioMujer).toBe(12000);
    expect(publica?.precioHombre).toBe(14000);
  });

  it("cambiar la visibilidad pide sesión", async () => {
    const z = await crearZona("sin sesión");
    const res = await zonas(`/zonas/${z.id}/visible-web`, "PATCH", { isVisibleWeb: false }, false);
    expect(res.status).toBe(401);
  });

  it("sobre una zona que no existe responde 404", async () => {
    const res = await zonas("/zonas/00000000-0000-4000-8000-000000000000/visible-web", "PATCH", {
      isVisibleWeb: false,
    });
    expect(res.status).toBe(404);
  });
});

describe("descripción de la categoría en la web", () => {
  async function crearCategoria() {
    const [c] = await db
      .insert(categories)
      .values({ name: `${QA} categoría`, description: "nota interna", isActive: true })
      .returning({ id: categories.id });
    return c!.id;
  }

  const nodo = async (id: string) => {
    const res = await cats("/", "GET", undefined, false);
    const raices = (await res.json()) as { id: string; description: string; webDescription: string | null }[];
    return raices.find((r) => r.id === id);
  };

  it("se guarda sin tocar la nota interna, y el catálogo público la devuelve", async () => {
    const id = await crearCategoria();
    const res = await cats(`/${id}/descripcion-web`, "PATCH", { webDescription: "  Para vos.\nY para ella.  " });
    expect(res.status).toBe(200);

    const n = await nodo(id);
    expect(n?.webDescription).toBe("Para vos.\nY para ella.");
    expect(n?.description).toBe("nota interna");
  });

  it("borrarla la deja vacía de verdad, no como texto en blanco", async () => {
    const id = await crearCategoria();
    await cats(`/${id}/descripcion-web`, "PATCH", { webDescription: "algo" });
    await cats(`/${id}/descripcion-web`, "PATCH", { webDescription: "   " });
    expect((await nodo(id))?.webDescription).toBeNull();
  });

  it("editar la categoría desde Catálogo no se lleva puesta la descripción", async () => {
    const id = await crearCategoria();
    await cats(`/${id}/descripcion-web`, "PATCH", { webDescription: "se queda" });
    await cats(`/${id}`, "PATCH", { description: "otra nota" });
    const [fila] = await db.select().from(categories).where(eq(categories.id, id));
    expect(fila?.webDescription).toBe("se queda");
    expect(fila?.description).toBe("otra nota");
  });

  it("guardarla pide sesión", async () => {
    const id = await crearCategoria();
    const res = await cats(`/${id}/descripcion-web`, "PATCH", { webDescription: "x" }, false);
    expect(res.status).toBe(401);
  });

  it("sobre una categoría que no existe responde 404", async () => {
    const res = await cats("/00000000-0000-4000-8000-000000000000/descripcion-web", "PATCH", {
      webDescription: "x",
    });
    expect(res.status).toBe(404);
  });

  it("rechaza un texto de más de 2000 caracteres", async () => {
    const id = await crearCategoria();
    const res = await cats(`/${id}/descripcion-web`, "PATCH", { webDescription: "x".repeat(2001) });
    expect(res.status).toBe(400);
  });
});
