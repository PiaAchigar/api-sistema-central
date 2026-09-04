import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { inArray } from "drizzle-orm";
import { categoriesQuery } from "./categories";
import { listCategories } from "../../repositories/categories.repo";
import * as schema from "../../db/schema";
import { categories } from "../../db/schema";
import type { Db } from "../../db/client";

describe("categoriesQuery", () => {
  it("acepta los cuatro ejes", () => {
    for (const kind of ["area", "tecnica", "objetivo", "maquina"]) {
      expect(categoriesQuery.safeParse({ kind }).success).toBe(true);
    }
  });

  it("rechaza un eje que no existe", () => {
    const r = categoriesQuery.safeParse({ kind: "cualquiera" });
    expect(r.success).toBe(false);
  });

  it("sin kind es válido: el filtro es opcional y no cambia el comportamiento previo", () => {
    expect(categoriesQuery.safeParse({}).success).toBe(true);
    expect(categoriesQuery.safeParse({ includeInactive: "true" }).success).toBe(true);
  });
});

// ── Integración contra el Postgres local ────────────────────────────────────
// El filtro por `kind` es un WHERE: un doble de `Db` sólo podría verificar que
// se llamó a `.where()`, no que filtró bien. Necesita base de verdad, igual
// que el harness de depilación. Si no hay DB levantada, esto falla con error
// de conexión — señal de "correé `npm run db:up` primero".
const LOCAL_DB_URL = "postgresql://piubella:piubella@localhost:5499/piubella";
const QA = "ZZ_QA_CATEGORIES_TEST_";

const pgClient = postgres(LOCAL_DB_URL, { max: 1 });
const testDb = drizzle(pgClient, { schema }) as unknown as Db;

const SEMBRADAS = [
  { name: `${QA}area`, kind: "area" },
  { name: `${QA}tecnica`, kind: "tecnica" },
  { name: `${QA}objetivo`, kind: "objetivo" },
  { name: `${QA}maquina`, kind: "maquina" },
  { name: `${QA}archivada`, kind: "area", isActive: false },
];

async function limpiar() {
  await testDb.delete(categories).where(
    inArray(categories.name, SEMBRADAS.map((s) => s.name)),
  );
}

describe("listCategories — filtro por eje", () => {
  beforeAll(async () => {
    await limpiar();
    for (const s of SEMBRADAS) {
      await testDb.insert(categories).values({
        name: s.name,
        kind: s.kind,
        isActive: s.isActive ?? true,
      });
    }
  });

  afterAll(async () => {
    await limpiar();
    await pgClient.end();
  });

  it("con kind devuelve SOLO ese eje", async () => {
    const rows = await listCategories(testDb, false, "area");
    const mias = rows.filter((r) => r.name?.startsWith(QA));
    expect(mias).toHaveLength(1);
    expect(mias[0]!.name).toBe(`${QA}area`);
  });

  it("sin kind devuelve los cuatro ejes, como antes", async () => {
    const rows = await listCategories(testDb, false);
    const mias = rows.filter((r) => r.name?.startsWith(QA));
    expect(new Set(mias.map((r) => r.kind))).toEqual(
      new Set(["area", "tecnica", "objetivo", "maquina"]),
    );
  });

  it("el filtro por eje no se come el filtro de archivadas", async () => {
    const activas = await listCategories(testDb, false, "area");
    expect(activas.filter((r) => r.name === `${QA}archivada`)).toHaveLength(0);

    const conArchivadas = await listCategories(testDb, true, "area");
    expect(conArchivadas.filter((r) => r.name === `${QA}archivada`)).toHaveLength(1);
  });

  it("devuelve `kind` en cada fila, que es lo que la web necesita para filtrar", async () => {
    const rows = await listCategories(testDb, false);
    const mia = rows.find((r) => r.name === `${QA}maquina`);
    expect(mia?.kind).toBe("maquina");
  });

  it("un eje sin categorías devuelve lista vacía, no error", async () => {
    const rows = await listCategories(testDb, false, "objetivo");
    expect(Array.isArray(rows)).toBe(true);
  });
});
