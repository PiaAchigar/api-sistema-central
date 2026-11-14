import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { like } from "drizzle-orm";
import * as schema from "../../db/schema";
import { categories } from "../../db/schema";
import type { Db } from "../../db/client";
import type { AppBindings, Variables } from "../../env";
import { auth } from "../../middleware/auth";
import { agenda } from "./index";

const LOCAL_DB_URL = "postgresql://piubella:piubella@localhost:5499/piubella";
const P = "ZZ_QA_RUTAS_PLN_";
const API_KEY = "qa-planilla-key";
const ENV = { HYPERDRIVE: { connectionString: LOCAL_DB_URL }, API_KEY } as unknown as AppBindings;

const pgClient = postgres(LOCAL_DB_URL, { max: 1, fetch_types: false, prepare: false });
const db = drizzle(pgClient, { schema }) as unknown as Db;

const app = new Hono<{ Bindings: AppBindings; Variables: Variables }>();
app.use("*", auth);
app.route("/api/agenda", agenda);

const conRol = (rol: string) => {
  const a = new Hono<{ Bindings: AppBindings; Variables: Variables }>();
  a.use("*", async (c, next) => {
    c.set("userId", "u-" + rol);
    c.set("userRole", rol as never);
    c.set("userEmail", null);
    await next();
  });
  a.route("/api/agenda", agenda);
  return a;
};
const operator = conRol("operator");
const manager = conRol("manager");

const H = { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" };
const BASE = "/api/agenda/planilla-servicios";
const AREA = P + "area";
const vacio = { servicios: [], acuerdos: [], insumos: [], categorias: [] };
const entrada = { area: AREA, original: vacio, editada: vacio };
const MSG = "El archivo no tiene el formato de la planilla. Bajá una nueva y completala.";

async function limpiar() {
  await db.delete(categories).where(like(categories.name, `${P}%`));
}

beforeAll(async () => {
  await limpiar();
  await db.insert(categories).values({ id: crypto.randomUUID(), name: AREA, kind: "area", parentCategoryId: null } as never);
});
afterAll(async () => {
  await limpiar();
  await pgClient.end();
});

describe("/api/agenda/planilla-servicios", () => {
  it("sin token → 401", async () => {
    expect((await app.request(`${BASE}?area=x`, {}, ENV)).status).toBe(401);
  });

  it("operator → 403 en las tres rutas", async () => {
    expect((await operator.request(`${BASE}?area=${AREA}`, { headers: H }, ENV)).status).toBe(403);
    for (const p of ["previsualizar", "aplicar"]) {
      const r = await operator.request(`${BASE}/${p}`, { method: "POST", headers: H, body: JSON.stringify(entrada) }, ENV);
      expect(r.status).toBe(403);
    }
  });

  it("manager GET → 200 con la planilla del área", async () => {
    const r = await manager.request(`${BASE}?area=${encodeURIComponent(AREA)}`, { headers: H }, ENV);
    expect(r.status).toBe(200);
    const b = (await r.json()) as any;
    expect(b.area.nombre).toBe(AREA);
    expect(b.contenido.servicios).toEqual([]);
  });

  it("GET sin area → 400; área desconocida → 404", async () => {
    expect((await manager.request(BASE, { headers: H }, ENV)).status).toBe(400);
    expect((await manager.request(`${BASE}?area=${P}nope`, { headers: H }, ENV)).status).toBe(404);
  });

  it("manager previsualizar → 200 con resumen", async () => {
    const r = await manager.request(`${BASE}/previsualizar`, { method: "POST", headers: H, body: JSON.stringify(entrada) }, ENV);
    expect(r.status).toBe(200);
    const b = (await r.json()) as any;
    expect(b.errores).toEqual([]);
    expect(b.resumen.serviciosNuevos).toBe(0);
  });

  it("la pestaña Máquinas es opcional pero, si viene, se valida", async () => {
    const ok = { ...entrada, editada: { ...vacio, maquinas: [] }, original: { ...vacio, maquinas: [] } };
    const r1 = await manager.request(`${BASE}/previsualizar`, { method: "POST", headers: H, body: JSON.stringify(ok) }, ENV);
    expect(r1.status).toBe(200);
    expect(((await r1.json()) as any).resumen.maquinas).toBe(0);
    const mal = { ...entrada, editada: { ...vacio, maquinas: [{ fila: 2, servicio: {}, maquina: "x" }] } };
    const r2 = await manager.request(`${BASE}/previsualizar`, { method: "POST", headers: H, body: JSON.stringify(mal) }, ENV);
    expect(r2.status).toBe(400);
  });

  it("manager aplicar sin cambios → 200 con resumen", async () => {
    const r = await manager.request(`${BASE}/aplicar`, { method: "POST", headers: H, body: JSON.stringify(entrada) }, ENV);
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).resumen).toBeTruthy();
  });

  it("aplicar con errores de planilla → 400 { error, errores }", async () => {
    const fila = { // fila con nombre pero sin precios ni duración
      fila: 2, id: null, nombre: P + "sin precio", codigo: null, descripcion: null, precioLista: null, precioEfectivo: null,
      duracion: null, unidad: null, requiereOperadora: null, requiereMaquina: null, maquina: null,
      visibleWeb: null, destacado: null, ordenWeb: null, beneficios: null, contraindicaciones: null, instrucciones: null,
    };
    const r = await manager.request(
      `${BASE}/aplicar`,
      { method: "POST", headers: H, body: JSON.stringify({ ...entrada, editada: { ...vacio, servicios: [fila] } }) },
      ENV,
    );
    expect(r.status).toBe(400);
    const b = (await r.json()) as any;
    expect(typeof b.error).toBe("string");
    expect(b.errores.length).toBeGreaterThan(0);
    expect(b.errores[0].pestana).toBe("Servicios");
  });

  it("body roto → 400 con error de pestaña Archivo", async () => {
    for (const p of ["previsualizar", "aplicar"]) {
      const r = await manager.request(`${BASE}/${p}`, { method: "POST", headers: H, body: JSON.stringify({ area: AREA }) }, ENV);
      expect(r.status).toBe(400);
      const b = (await r.json()) as any;
      expect(b.error).toBe(MSG);
      expect(b.errores).toEqual([{ pestana: "Archivo", fila: null, mensaje: MSG }]);
    }
  });

  it("body que no es JSON → 400 de Archivo", async () => {
    const r = await manager.request(`${BASE}/previsualizar`, { method: "POST", headers: H, body: "no-json" }, ENV);
    expect(r.status).toBe(400);
    expect(((await r.json()) as any).error).toBe(MSG);
  });

  it("celda con tipo inválido (objeto) → 400 de Archivo", async () => {
    const r = await manager.request(
      `${BASE}/previsualizar`,
      { method: "POST", headers: H, body: JSON.stringify({ ...entrada, editada: { ...vacio, insumos: [{ fila: 2, servicio: {}, insumo: "x", cantidad: 1 }] } }) },
      ENV,
    );
    expect(r.status).toBe(400);
    expect(((await r.json()) as any).errores[0].pestana).toBe("Archivo");
  });
});
