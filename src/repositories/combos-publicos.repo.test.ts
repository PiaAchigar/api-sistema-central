import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import * as schema from "../db/schema";
import { combos, comboService } from "../db/schema";
import type { Db } from "../db/client";
import { listPublicCombos } from "./combos.repo";

const LOCAL_DB_URL = "postgresql://piubella:piubella@localhost:5499/piubella";

// ⚠️ Estas opciones NO son decorativas: son las MISMAS que usa
// `createDb()` en producción, y son las que hacen visible el bug.
//
// Con `fetch_types: false` —obligatorio bajo Hyperdrive— postgres-js no puede
// averiguar el OID de un array, así que un parámetro de tipo array se manda
// aplastado a un escalar y Postgres contesta `malformed array literal`. Un
// cliente de test con las opciones por defecto NO reproduce esto: la consulta
// pasa y el test da verde mientras producción tira 500.
const pgClient = postgres(LOCAL_DB_URL, {
  max: 1,
  fetch_types: false,
  prepare: false,
});
const db = drizzle(pgClient, { schema }) as unknown as Db;

const QA = "ZZ_QA_COMBOS_PUBLICOS";

let comboId: string;

async function limpiar() {
  const previos = await db.select({ id: combos.id }).from(combos).where(eq(combos.name, QA));
  for (const c of previos) {
    await db.delete(comboService).where(eq(comboService.comboId, c.id));
    await db.delete(combos).where(eq(combos.id, c.id));
  }
}

beforeAll(async () => {
  await limpiar();

  const [area] = await db.execute<{ id: string }>(
    "select id from categories where kind = 'area' and name not like 'ZZ_QA%' order by id limit 1" as never,
  );
  // Un servicio que cuelga de alguna categoría: sin eso el combo no tendría
  // clasificaciones y la parte que importa del test no probaría nada.
  const [servicio] = await db.execute<{ id: string }>(
    `select s.id from service s
       join service_category sc on sc.service_id = s.id
      where s.is_active = true and s.name not like 'ZZ_QA%'
      order by s.id limit 1` as never,
  );

  const [creado] = await db
    .insert(combos)
    .values({
      name: QA,
      priceType: "fixed",
      fixedPrice: "1000",
      validityMonths: 1,
      isActive: true,
      isVisibleWeb: true,
      areaCategoryId: area!.id,
    })
    .returning({ id: combos.id });
  comboId = creado!.id;

  await db.insert(comboService).values({
    comboId,
    serviceId: servicio!.id,
    sessionsIncluded: 1,
    servicePrice: "1000",
  });
});

afterAll(async () => {
  await limpiar();
  await pgClient.end();
});

describe("listPublicCombos — lo que consume la web", () => {
  it("no revienta: es el endpoint público, un 500 acá deja la página sin combos", async () => {
    // Producción devolvía 500 en GET /api/agenda/combos (2026-09-22): la
    // consulta de clasificaciones pasaba la lista de ids como UN parámetro
    // array (`= ANY($1)`), y eso con estas opciones de cliente no se puede.
    const publicados = await listPublicCombos(db);
    expect(publicados.some((c) => c.id === comboId)).toBe(true);
  });

  it("cada combo viene con el nombre de su área y sus clasificaciones", async () => {
    const publicados = await listPublicCombos(db);
    const mio = publicados.find((c) => c.id === comboId)!;
    expect(mio.areaName).toBeTruthy();
    expect(Array.isArray(mio.clasificaciones)).toBe(true);
  });
});
