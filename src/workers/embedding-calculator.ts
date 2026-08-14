// api-sistema-central/src/workers/embedding-calculator.ts
//
// Recalcula los embeddings de `service_embeddings` y `activity_embeddings`
// que quedaron en NULL: los triggers `trg_service_embeddings_sync` (1.4.0) y
// `trg_activity_embeddings_sync` (1.26.0/06) resetean `content` y dejan
// `embedding = NULL` cada vez que se crea/edita un `service` o una
// `activity`. Este worker toma hasta 10 filas pendientes por invocación
// (para no acercarse al límite de tiempo de un Worker), mezclando ambas
// tablas, y les calcula el vector usando OpenAI text-embedding-3-small
// (embeddings semánticos reales).
//
// Se puede disparar de dos formas (misma lógica, `recalculateEmbeddings`):
//   1. HTTP: POST /api/webhooks/recalculate-embeddings (requiere auth, ver
//      index.ts) — para correrlo a mano o desde otro sistema interno.
//   2. Cron: Cloudflare Cron Trigger → `scheduled()` en index.ts (opcional,
//      comentado en wrangler.toml — puede habilitarse una vez confirmado que
//      funciona con OpenAI).

import type { Context } from "hono";
import { sql } from "drizzle-orm";
import { createDb, type Db } from "../db/client";
import { generateEmbedding, getActiveCredential } from "../lib/embedding";
import type { AppBindings, Variables } from "../env";

const BATCH_LIMIT = 10;

// `source` distingue de qué tabla vino la fila (ver el UNION ALL más abajo)
// para saber a cuál de las dos hay que escribirle el vector calculado.
type PendingEmbeddingRow = { id: string; content: string; source: "service" | "activity" };

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
  const credential = await getActiveCredential(db, env.CREDENTIALS_ENCRYPTION_KEY, "openai");
  if (!credential) {
    return { error: "No hay credencial de OpenAI activa configurada en ai_provider_credentials. Ve a /automatizacion/llm-config en front-crm para agregar una." };
  }

  // UNION ALL: un mismo batch puede traer filas pendientes de servicios y de
  // actividades. No hay riesgo de mezclar sus IDs porque cada UPDATE de abajo
  // apunta a la tabla correcta según `source`.
  const rows = await db.execute<PendingEmbeddingRow>(
    sql`SELECT id, content, 'service' AS source
          FROM service_embeddings
         WHERE embedding IS NULL
        UNION ALL
        SELECT id, content, 'activity' AS source
          FROM activity_embeddings
         WHERE embedding IS NULL
        LIMIT ${BATCH_LIMIT}`,
  );

  if (rows.length === 0) {
    return { message: "No hay embeddings para recalcular" };
  }

  const results: RecalculateResultRow[] = [];

  for (const row of rows) {
    try {
      const embedding = await generateEmbedding(row.content, credential.apiKey, "openai", credential.model);
      // pgvector acepta el literal de texto "[n1,n2,...]" con cast a ::vector.
      const vectorLiteral = `[${embedding.join(",")}]`;
      if (row.source === "activity") {
        await db.execute(
          sql`UPDATE activity_embeddings
              SET embedding = ${vectorLiteral}::vector, updated_at = now()
              WHERE id = ${row.id}`,
        );
      } else {
        await db.execute(
          sql`UPDATE service_embeddings
              SET embedding = ${vectorLiteral}::vector, updated_at = now()
              WHERE id = ${row.id}`,
        );
      }
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
