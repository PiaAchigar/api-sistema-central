// api-sistema-central/src/workers/embedding-calculator.ts
//
// Recalcula los embeddings de `service_embeddings`, `activity_embeddings` y
// `training_embeddings` que quedaron en NULL: los triggers
// `trg_service_embeddings_sync` (1.4.0), `trg_activity_embeddings_sync`
// (1.26.0/06) y `trg_training_embeddings_sync` (1.27.0/01) resetean
// `content` y dejan `embedding = NULL` cada vez que se crea/edita un
// `service`, una `activity` o una `training`. `recalculateEmbeddings` toma
// hasta 10 filas pendientes por llamada (para no acercarse al límite de
// tiempo de un Worker), mezclando las tres tablas, y les calcula el vector
// usando OpenAI text-embedding-3-small (embeddings semánticos reales).
//
// Se dispara de dos formas, ambas activas:
//   1. HTTP: POST /api/webhooks/recalculate-embeddings (requiere auth, ver
//      index.ts) — un lote de hasta 10 por llamada; lo usa el botón
//      "Actualizar buscador" del dashboard, que lo llama en loop.
//   2. Cron: Cloudflare Cron Trigger horario → `scheduled()` en index.ts,
//      que llama a `drenarPendientes` (ver más abajo) para correr varios
//      lotes seguidos hasta un tope de lotes/ítems/tiempo, no solo uno.

import type { Context } from "hono";
import { sql } from "drizzle-orm";
import { createDb, type Db } from "../db/client";
import { EmbeddingError, generateEmbedding, getActiveCredential } from "../lib/embedding";
import type { AppBindings, Variables } from "../env";

const BATCH_LIMIT = 10;

// `source` distingue de qué tabla vino la fila (ver el UNION ALL más abajo)
// para saber a cuál de las tres hay que escribirle el vector calculado.
export type EmbeddingSource = "service" | "activity" | "training";

type PendingEmbeddingRow = { id: string; content: string; source: EmbeddingSource };

/**
 * Mapea `source` a su tabla de embeddings. Extraído a función y exportado
 * para poder testear el mapeo sin necesidad de una base levantada.
 */
export function tableForSource(source: EmbeddingSource): string {
  if (source === "activity") return "activity_embeddings";
  if (source === "training") return "training_embeddings";
  return "service_embeddings";
}

export type RecalculateResultRow = { id: string; status: "success" | "failed"; error?: string };

export type RecalculateOutcome =
  | { error: string }
  | { message: string }
  | {
      processed: number;
      results: RecalculateResultRow[];
      sinCredito: boolean;
      /**
       * Cuántos de `results` terminaron en `status: "failed"`. `processed`
       * cuenta fallidos igual que éxitos (es `results.length`), así que un
       * caller que solo mira `processed` no puede distinguir un lote que
       * hizo trabajo real de uno que falló entero — ver `fallidos ===
       * processed` como "no se escribió ni un vector" en `drenarPendientes`
       * y en el loop del front (InteligenciaArtificialPage.tsx).
       */
      fallidos: number;
    };

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
    return {
      error:
        "Todavía no cargaste una credencial de OpenAI. Andá a Configuración → Inteligencia Artificial para cargarla.",
    };
  }

  // UNION ALL: un mismo batch puede traer filas pendientes de servicios, de
  // actividades y de capacitaciones. No hay riesgo de mezclar sus IDs porque
  // el UPDATE de abajo resuelve la tabla correcta con `tableForSource`. El
  // LIMIT aplica al resultado combinado de las tres ramas (un lote de hasta
  // 10 filas en total, no 10 por tabla).
  const rows = await db.execute<PendingEmbeddingRow>(
    sql`SELECT id, content, 'service' AS source
          FROM service_embeddings
         WHERE embedding IS NULL
        UNION ALL
        SELECT id, content, 'activity' AS source
          FROM activity_embeddings
         WHERE embedding IS NULL
        UNION ALL
        SELECT id, content, 'training' AS source
          FROM training_embeddings
         WHERE embedding IS NULL
        LIMIT ${BATCH_LIMIT}`,
  );

  if (rows.length === 0) {
    return { message: "No hay embeddings para recalcular" };
  }

  const results: RecalculateResultRow[] = [];
  let sinCredito = false;

  for (const row of rows) {
    try {
      const embedding = await generateEmbedding(row.content, credential.apiKey, "openai", credential.model);
      // pgvector acepta el literal de texto "[n1,n2,...]" con cast a ::vector.
      const vectorLiteral = `[${embedding.join(",")}]`;
      // El nombre de tabla no puede ir como parámetro bindeado en un `sql``
      // template (Postgres no acepta parámetros donde va un identificador):
      // hay que interpolarlo con `sql.raw()`. Es seguro porque `tableForSource`
      // devuelve un literal cerrado del código, nunca un valor de `row` ni
      // ninguna otra entrada externa.
      const table = tableForSource(row.source);
      await db.execute(
        sql`UPDATE ${sql.raw(table)}
            SET embedding = ${vectorLiteral}::vector, updated_at = now()
            WHERE id = ${row.id}`,
      );
      results.push({ id: row.id, status: "success" });
    } catch (err) {
      console.error(`[embedding-calculator] Fallo al generar embedding para ${row.id}:`, err);
      // `EmbeddingError.codigo` viene de `mapearErrorOpenAI` (ver
      // lib/openai-errors.ts). Sin crédito no tiene sentido seguir: los
      // lotes que falten van a fallar todos igual.
      if (err instanceof EmbeddingError && err.codigo === "insufficient_quota") {
        sinCredito = true;
      }
      results.push({
        id: row.id,
        status: "failed",
        error: err instanceof Error ? err.message : "Unknown error",
      });
    }
  }

  const fallidos = results.filter((r) => r.status === "failed").length;
  return { processed: results.length, results, sinCredito, fallidos };
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

export type MotivoCorte =
  | "sin-pendientes"
  | "tope-lotes"
  | "tope-items"
  | "tope-tiempo"
  | "sin-credito"
  | "sin-credencial"
  | "todos-fallaron";

export type DrenarOpciones = {
  maxLotes?: number;
  maxItems?: number;
  maxMs?: number;
  /** Inyectable para testear el corte por tiempo sin esperar de verdad. */
  ahora?: () => number;
  /** Inyectable para testear los cortes sin base ni red. */
  correrLote?: typeof recalculateEmbeddings;
};

export type DrenarResultado = {
  lotes: number;
  procesados: number;
  sinCredito: boolean;
  motivo: MotivoCorte;
  /**
   * Primer error de ítem del lote que causó el corte por `"todos-fallaron"`.
   * Solo se completa en ese caso — queda en el log del cron para que se
   * pueda diagnosticar sin ir a mirar `console.error` por id.
   */
  error?: string;
};

/**
 * Corre lotes de `recalculateEmbeddings` hasta que se cumpla el PRIMERO de
 * cuatro topes. Lo usa el cron horario: una sola corrida tiene que poder
 * absorber una edición masiva, porque si no, a 10 ítems por hora, tocar 50
 * servicios tardaría 5 horas en verse en el buscador.
 *
 * Los topes de lotes, items y tiempo existen para no acercarse al límite de
 * ejecución de un Worker de Cloudflare. El de crédito evita martillar una
 * cuenta sin saldo con 10 lotes que van a fallar todos.
 */
export async function drenarPendientes(
  db: Db,
  env: Pick<AppBindings, "CREDENTIALS_ENCRYPTION_KEY">,
  opciones: DrenarOpciones = {},
): Promise<DrenarResultado> {
  const maxLotes = opciones.maxLotes ?? 10;
  const maxItems = opciones.maxItems ?? 100;
  const maxMs = opciones.maxMs ?? 25_000;
  const ahora = opciones.ahora ?? (() => Date.now());
  const correrLote = opciones.correrLote ?? recalculateEmbeddings;

  const inicio = ahora();
  let lotes = 0;
  let procesados = 0;

  while (true) {
    if (lotes >= maxLotes) return { lotes, procesados, sinCredito: false, motivo: "tope-lotes" };
    if (procesados >= maxItems) return { lotes, procesados, sinCredito: false, motivo: "tope-items" };
    if (ahora() - inicio >= maxMs) return { lotes, procesados, sinCredito: false, motivo: "tope-tiempo" };

    const salida = await correrLote(db, env);

    // `lotes++` va DESPUÉS de estos dos early-return a propósito: cuenta
    // tandas que hicieron trabajo, no llamadas al endpoint. La última llamada
    // de un drenado siempre devuelve "no hay nada" y contarla inflaría el
    // número que sale en el log del cron.
    if ("error" in salida) return { lotes, procesados, sinCredito: false, motivo: "sin-credencial" };
    if ("message" in salida) return { lotes, procesados, sinCredito: false, motivo: "sin-pendientes" };

    lotes++;

    procesados += salida.processed;
    if (salida.sinCredito) return { lotes, procesados, sinCredito: true, motivo: "sin-credito" };

    // Un lote sin un solo éxito (`fallidos === processed`) significa que no
    // se escribió ni un vector: sin este corte, el `LIMIT 10` de la próxima
    // vuelta trae exactamente las mismas filas y el drenado repite el mismo
    // error para siempre (ver IMPORTANT 1 del review de rama). Se corta acá
    // en vez de reintentar — igual que el corte por `sinCredito` — porque un
    // fallo por ítem que no sea falta de crédito (key revocada, modelo
    // inválido, etc.) tampoco se va a arreglar solo reintentando.
    if (salida.processed > 0 && salida.fallidos === salida.processed) {
      const primerError = salida.results.find((r) => r.status === "failed")?.error;
      return { lotes, procesados, sinCredito: false, motivo: "todos-fallaron", error: primerError };
    }
  }
}
