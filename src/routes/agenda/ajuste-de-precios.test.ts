import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq, inArray, like } from "drizzle-orm";
import * as schema from "../../db/schema";
import { categories, priceAdjustments, service, serviceCategory } from "../../db/schema";
import type { Db } from "../../db/client";
import type { AppBindings, Variables } from "../../env";
import { auth } from "../../middleware/auth";
import { agenda } from "./index";

// Integración real contra Postgres local; auth por API_KEY como Bearer → admin.
const LOCAL_DB_URL = "postgresql://piubella:piubella@localhost:5499/piubella";
const P = "ZZ_QA_ENDPOINT_PRECIOS_";
const API_KEY = "qa-precios-key";
const ENV = { HYPERDRIVE: { connectionString: LOCAL_DB_URL }, API_KEY } as unknown as AppBindings;

const pgClient = postgres(LOCAL_DB_URL, { max: 1, fetch_types: false, prepare: false });
const db = drizzle(pgClient, { schema }) as unknown as Db;

const app = new Hono<{ Bindings: AppBindings; Variables: Variables }>();
app.use("*", auth);
app.route("/api/agenda", agenda);

const ajuste = { direccion: "subir", modo: "porcentaje", valor: 10, redondeo: 1 };
const H = { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" };
const post = (path: string, body: unknown, headers: Record<string, string> = H) =>
  app.request(`/api/agenda/precios/${path}`, { method: "POST", headers, body: JSON.stringify(body) }, ENV);

let cat = "", sid = "";
const adjustmentIds: string[] = [];

async function limpiar() {
  const svcs = await db.select({ id: service.id }).from(service).where(like(service.name, `${P}%`));
  const ids = svcs.map((s) => s.id);
  if (adjustmentIds.length) await db.delete(priceAdjustments).where(inArray(priceAdjustments.id, adjustmentIds));
  if (ids.length) await db.delete(serviceCategory).where(inArray(serviceCategory.serviceId, ids));
  if (ids.length) await db.delete(service).where(inArray(service.id, ids));
  await db.delete(categories).where(like(categories.name, `${P}%`));
}

beforeAll(async () => {
  await limpiar();
  cat = crypto.randomUUID();
  sid = crypto.randomUUID();
  await db.insert(categories).values({ id: cat, name: P + "cat", parentCategoryId: null });
  await db.insert(service).values({
    id: sid, name: P + "uno", unitPriceList: "10000.00", unitPriceCash: "9000.00", isActive: true, noVendible: false,
  });
  await db.insert(serviceCategory).values({ serviceId: sid, categoryId: cat });
});

afterAll(async () => {
  await limpiar();
  await pgClient.end();
});

describe("POST /api/agenda/precios", () => {
  it("sin token → 401", async () => {
    const r = await post("simular", { categoryId: cat, ajuste }, { "Content-Type": "application/json" });
    expect(r.status).toBe(401);
  });

  it("ajuste inválido → 400", async () => {
    const r = await post("simular", { categoryId: cat, ajuste: { ...ajuste, valor: -5 } });
    expect(r.status).toBe(400);
  });

  it("simular → 200 con servicios y combos", async () => {
    const r = await post("simular", { categoryId: cat, ajuste });
    expect(r.status).toBe(200);
    const b = (await r.json()) as Record<string, any>;
    expect(b.combos).toEqual([]);
    expect(b.servicios).toHaveLength(1);
    expect(b.servicios[0]).toMatchObject({ id: sid, listaAntes: 10000, listaDespues: 11000, estado: "cambia" });
  });

  it("aplicar con precio viejo → 409 con conflictos", async () => {
    const r = await post("aplicar", {
      categoryId: cat, ajuste, servicios: [{ id: sid, listaVista: 9999, efectivoVista: 9000 }],
    });
    expect(r.status).toBe(409);
    const b = (await r.json()) as Record<string, any>;
    expect(b.conflictos).toEqual([sid]);
    expect(typeof b.error).toBe("string");
  });

  it("aplicar ok → 200 y historial con user_id api-key", async () => {
    const r = await post("aplicar", {
      categoryId: cat, ajuste, servicios: [{ id: sid, listaVista: 10000, efectivoVista: 9000 }],
    });
    expect(r.status).toBe(200);
    const b = (await r.json()) as Record<string, any>;
    expect(b.aplicados).toBe(1);
    adjustmentIds.push(b.ajusteId);
    const [h] = await db.select().from(priceAdjustments).where(eq(priceAdjustments.id, b.ajusteId));
    expect(h!.userId).toBe("api-key");
    expect(h!.userEmail).toBeNull();
  });
});
