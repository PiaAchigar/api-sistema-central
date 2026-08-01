// api-sistema-central/src/workers/embedding-calculator.ts
//
// Recalcula los embeddings de `service_embeddings` que quedaron en NULL: el
// trigger `trg_service_embeddings_sync` (migración 1.4.0) resetea `content`
// y deja `embedding = NULL` cada vez que se crea/edita un `service`. Este
// worker toma hasta 10 filas pendientes por invocación (para no acercarse al
// límite de tiempo de un Worker) y les calcula el vector.
//
// ⚠️ Ver la advertencia en `lib/embedding.ts`: lo que este worker guarda en
// `embedding` NO es un embedding semántico real (Claude no tiene endpoint de
// embeddings) — es un array de 1536 números que Claude "inventa" por chat.
// La tabla queda poblada, pero una búsqueda por similitud coseno sobre estos
// vectores no va a devolver resultados semánticamente relevantes. No cablear
// el Task 5 (búsqueda) sobre esto sin resolver antes ese punto — ver detalle
// en `lib/embedding.ts`.
//
// Se puede disparar de dos formas (misma lógica, `recalculateEmbeddings`):
//   1. HTTP: POST /api/webhooks/recalculate-embeddings (requiere auth, ver
//      index.ts) — para correrlo a mano o desde otro sistema interno.
//   2. Cron: Cloudflare Cron Trigger → `scheduled()` en index.ts (opcional,
//      comentado en wrangler.toml — ver nota ahí antes de habilitarlo).

import type { Context } from "hono";
import { sql } from "drizzle-orm";
import { createDb, type Db } from "../db/client";
import { generateEmbedding, getActiveCredential } from "../lib/embedding";
import type { AppBindings, Variables } from "../env";

const BATCH_LIMIT = 10;

type PendingEmbeddingRow = { id: string; service_id: string; content: string };

export type RecalculateResultRow = { id: string; status: "success" | "failed"; error?: string };

export type RecalculateOutcome =
  | { error: string }
  | { message: string }
  | { processed: number; results: RecalculateResultRow[] };

/**
 * Lógica compartida por el endpoint HTTP (`recalculateEmbeddingsWorker`) y el
 * cron trigger (`scheduled` en index.ts) — ninguno de los dos duplica la
 * consulta ni el loop, solo deciden cómo se invoca y qué hacer con el
 * resultado.
 */
export async function recalculateEmbeddings(
  db: Db,
  env: Pick<AppBindings, "CREDENTIALS_ENCRYPTION_KEY">,
): Promise<RecalculateOutcome> {
  const credential = await getActiveCredential(db, env.CREDENTIALS_ENCRYPTION_KEY, "anthropic");
  if (!credential) {
    return { error: "No hay credencial de Anthropic activa configurada en ai_provider_credentials." };
  }

  const rows = await db.execute<PendingEmbeddingRow>(
    sql`SELECT id, service_id, content
        FROM service_embeddings
        WHERE embedding IS NULL
        LIMIT ${BATCH_LIMIT}`,
  );

  if (rows.length === 0) {
    return { message: "No hay embeddings para recalcular" };
  }

  const results: RecalculateResultRow[] = [];

  for (const row of rows) {
    try {
      const embedding = await generateEmbedding(row.content, credential.apiKey, credential.model);
      // pgvector acepta el literal de texto "[n1,n2,...]" con cast a ::vector.
      const vectorLiteral = `[${embedding.join(",")}]`;
      await db.execute(
        sql`UPDATE service_embeddings
            SET embedding = ${vectorLiteral}::vector, updated_at = now()
            WHERE id = ${row.id}`,
      );
      results.push({ id: row.id, status: "success" });
    } catch (err) {
      console.error(`[embedding-calculator] Fallo al generar embedding para ${row.id}:`, err);
      results.push({
        id: row.id,
        status: "failed",
        error: err instanceof Error ? err.message : "Unknown error",
      });
    }
  }

  return { processed: results.length, results };
}

export async function recalculateEmbeddingsWorker(
  c: Context<{ Bindings: AppBindings; Variables: Variables }>,
) {
  try {
    const db = createDb(c.env);
    const outcome = await recalculateEmbeddings(db, c.env);
    if ("error" in outcome) return c.json(outcome, 400);
    return c.json(outcome);
  } catch (err) {
    console.error("[embedding-calculator] Error:", err);
    return c.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      500,
    );
  }
}
