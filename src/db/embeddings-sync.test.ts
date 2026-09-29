import { afterAll, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq, inArray, like, sql } from "drizzle-orm";
import * as schema from "./schema";
import { service } from "./schema";
import type { Db } from "./client";

// El disparador vive en la base, no en TypeScript: sin Postgres de verdad no
// hay nada que probar. Requiere la migración 1.57.0 aplicada en local.
const LOCAL_DB_URL = "postgresql://piubella:piubella@localhost:5499/piubella";
const QA = "ZZ_QA_EMBED_SYNC_";

const pgClient = postgres(LOCAL_DB_URL, { max: 1, fetch_types: false, prepare: false });
const db = drizzle(pgClient, { schema }) as unknown as Db;

let servicioId = "";

async function limpiar() {
  const svcs = await db.select({ id: service.id }).from(service).where(like(service.name, `${QA}%`));
  const ids = svcs.map((s) => s.id);
  if (ids.length > 0) {
    await db.execute(sql`DELETE FROM service_embeddings WHERE service_id IN ${ids}`);
    await db.delete(service).where(inArray(service.id, ids));
  }
}

/** El vector guardado hoy, o null. */
async function vectorDe(id: string): Promise<string | null> {
  const filas = await db.execute<{ embedding: string | null }>(
    sql`SELECT embedding::text AS embedding FROM service_embeddings WHERE service_id = ${id}`,
  );
  return filas[0]?.embedding ?? null;
}

beforeEach(async () => {
  await limpiar();
  const [s] = await db
    .insert(service)
    .values({ name: `${QA}SERVICIO`, description: "Texto original.", isActive: true })
    .returning({ id: service.id });
  servicioId = s!.id;

  // Simula un vector ya calculado: es el estado del que parte el bug.
  const vector = `[${Array.from({ length: 1536 }, () => 0.01).join(",")}]`;
  await db.execute(
    sql`UPDATE service_embeddings SET embedding = ${vector}::vector WHERE service_id = ${servicioId}`,
  );
  expect(await vectorDe(servicioId)).not.toBeNull();
});

afterAll(async () => {
  await limpiar();
  await pgClient.end();
});

describe("el vector de un servicio sigue a su texto", () => {
  // El bug: el disparador actualizaba `content` y dejaba el vector viejo, y el
  // calculador sólo mira las filas con vector NULL. La descripción editada no
  // llegaba nunca al buscador.
  it("editar la descripción invalida el vector", async () => {
    await db
      .update(service)
      .set({ description: "Ahora sirve para tonificar y reafirmar brazos." })
      .where(eq(service.id, servicioId));

    expect(await vectorDe(servicioId)).toBeNull();
  });

  it("editar el nombre también lo invalida", async () => {
    await db.update(service).set({ name: `${QA}OTRO NOMBRE` }).where(eq(service.id, servicioId));
    expect(await vectorDe(servicioId)).toBeNull();
  });

  // La contracara, y es la que evita gastar llamadas a OpenAI de más: tocar
  // algo que NO es texto no puede invalidar nada.
  it("cambiar algo que no es texto NO lo invalida", async () => {
    await db.update(service).set({ isActive: false }).where(eq(service.id, servicioId));
    expect(await vectorDe(servicioId)).not.toBeNull();
  });

  it("el texto nuevo queda guardado en content", async () => {
    await db
      .update(service)
      .set({ description: "Tonificar y reafirmar brazos." })
      .where(eq(service.id, servicioId));

    const filas = await db.execute<{ content: string }>(
      sql`SELECT content FROM service_embeddings WHERE service_id = ${servicioId}`,
    );
    expect(filas[0]!.content).toContain("Tonificar y reafirmar brazos.");
  });
});
