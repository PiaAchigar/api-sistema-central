// api-sistema-central/src/repositories/embeddings-status.repo.ts
//
// Conteo de embeddings indexados y pendientes sobre las tres tablas. Lo
// consume GET /api/ai-config/embeddings-status, y con eso el dashboard pinta
// el cartel de pendientes y el número del modal de confirmación.

import { sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { getActiveAICredential } from "./ai-credentials.repo";

export type TipoEmbedding = "service" | "activity" | "training";

/** Fila cruda de la consulta: Postgres devuelve los count() como string. */
export type FilaConteo = { source: string; total: string | number; pendientes: string | number };

export type EmbeddingsStatus = {
  total: number;
  indexados: number;
  pendientes: number;
  por_tipo: Record<TipoEmbedding, { total: number; pendientes: number }>;
  credencial_activa: boolean;
};

const TIPOS: TipoEmbedding[] = ["service", "activity", "training"];

/**
 * Arma la respuesta a partir de las filas crudas. Separado de la consulta
 * para poder testear la conversión de tipos sin una base levantada — que es
 * justo donde está el riesgo (ver el comentario sobre bigint más abajo).
 */
export function armarEstado(filas: FilaConteo[], credencialActiva: boolean): EmbeddingsStatus {
  const por_tipo = Object.fromEntries(
    TIPOS.map((t) => [t, { total: 0, pendientes: 0 }]),
  ) as Record<TipoEmbedding, { total: number; pendientes: number }>;

  for (const fila of filas) {
    const tipo = fila.source as TipoEmbedding;
    if (!TIPOS.includes(tipo)) continue;
    // `count(*)` es bigint y el driver lo entrega como string. Sin este
    // Number() el JSON sale con los números entre comillas y el front compara
    // "0" > 0, que es false, y el cartel no aparece nunca.
    por_tipo[tipo] = { total: Number(fila.total), pendientes: Number(fila.pendientes) };
  }

  const total = TIPOS.reduce((acc, t) => acc + por_tipo[t].total, 0);
  const pendientes = TIPOS.reduce((acc, t) => acc + por_tipo[t].pendientes, 0);

  return { total, indexados: total - pendientes, pendientes, por_tipo, credencial_activa: credencialActiva };
}

export async function getEmbeddingsStatus(db: Db): Promise<EmbeddingsStatus> {
  const filas = await db.execute<FilaConteo>(
    sql`SELECT 'service' AS source, count(*) AS total,
               count(*) FILTER (WHERE embedding IS NULL) AS pendientes
          FROM service_embeddings
        UNION ALL
        SELECT 'activity', count(*), count(*) FILTER (WHERE embedding IS NULL)
          FROM activity_embeddings
        UNION ALL
        SELECT 'training', count(*), count(*) FILTER (WHERE embedding IS NULL)
          FROM training_embeddings`,
  );

  const credencial = await getActiveAICredential(db, "openai");
  return armarEstado(Array.from(filas), Boolean(credencial));
}
