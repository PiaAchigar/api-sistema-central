// api-sistema-central/src/lib/embedding.ts
//
// Genera embeddings semánticos reales usando OpenAI o Anthropic.
// - OpenAI `text-embedding-3-small` → 1536-dimensional real semantic embeddings
// - Anthropic → historicamente no tiene embeddings API (no recomendado para RAG)
//
// El provider se detecta desde la credencial activa en `ai_provider_credentials`.

import { decrypt } from "../services/crypto.service";
import { getActiveAICredential } from "../repositories/ai-credentials.repo";
import type { Db } from "../db/client";
import { mapearErrorOpenAI } from "./openai-errors";

const OPENAI_EMBEDDINGS_URL = "https://api.openai.com/v1/embeddings";
// Exportadas para que `ai-config.ts` (POST /validate) y `ai-config.schema.ts`
// (createCredentialSchema) usen los mismos valores que la generación real:
// una key puede "validar" con un modelo/params distintos a los que se usan
// después para calcular el vector de verdad, y ahí se cuela un desalineado
// silencioso (ver IMPORTANT 1 y 3 del review de rama).
export const EMBEDDING_DIMENSIONS = 1536;
export const DEFAULT_OPENAI_MODEL = "text-embedding-3-small";

export class EmbeddingError extends Error {
  status?: number;
  codigo?: string;
  constructor(message: string, status?: number, codigo?: string) {
    super(message);
    this.name = "EmbeddingError";
    this.status = status;
    this.codigo = codigo;
  }
}

type OpenAIEmbeddingsResponse = {
  data: Array<{
    embedding: number[];
  }>;
};

/**
 * Genera embedding usando OpenAI text-embedding-3-small (1536 dimensiones reales).
 * Solo acepta provider="openai" en `ai_provider_credentials`.
 */
async function generateOpenAIEmbedding(
  text: string,
  apiKey: string,
  model: string = DEFAULT_OPENAI_MODEL,
): Promise<number[]> {
  const res = await fetch(OPENAI_EMBEDDINGS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: text,
      dimensions: EMBEDDING_DIMENSIONS,
    }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    // Se conserva el código además del mensaje: `recalculateEmbeddings` lo
    // usa para cortar el drenado cuando la cuenta se quedó sin crédito, en
    // vez de reintentar 10 lotes contra una cuenta vacía.
    const info = mapearErrorOpenAI(res.status, body);
    throw new EmbeddingError(
      `Fallo al llamar a OpenAI Embeddings API: ${info.detalle ?? info.mensaje}`,
      res.status,
      info.codigo,
    );
  }

  const data = (await res.json()) as OpenAIEmbeddingsResponse;
  const embedding = data.data?.[0]?.embedding;

  if (!Array.isArray(embedding) || embedding.length !== EMBEDDING_DIMENSIONS) {
    throw new EmbeddingError(
      `Se esperaban ${EMBEDDING_DIMENSIONS} dimensiones de OpenAI, se recibieron ` +
        (Array.isArray(embedding) ? `${embedding.length}` : typeof embedding),
    );
  }

  return embedding;
}

/**
 * Punto de entrada: detecta provider y llama al endpoint correcto.
 * Por ahora solo OpenAI está soportado para RAG (produce embeddings semánticos reales).
 */
export async function generateEmbedding(
  text: string,
  apiKey: string,
  provider: string = "openai",
  model?: string,
): Promise<number[]> {
  if (provider === "openai") {
    return generateOpenAIEmbedding(text, apiKey, model || DEFAULT_OPENAI_MODEL);
  }

  throw new EmbeddingError(
    `Provider '${provider}' no soportado para embeddings. Use 'openai' (text-embedding-3-small).`,
  );
}

export type ActiveEmbeddingCredential = { apiKey: string; model: string };

/**
 * Credencial activa desencriptada para `provider` (default "anthropic").
 * Reutiliza `getActiveAICredential` (repositories/ai-credentials.repo.ts)
 * para la consulta — acá solo se agrega el descifrado con
 * CREDENTIALS_ENCRYPTION_KEY (mismo secreto que usa crypto.service en todo
 * el resto del proyecto; en Workers no existe `process.env`, así que se
 * recibe como parámetro en vez de leerlo global).
 */
export async function getActiveCredential(
  db: Db,
  encryptionKey: string | undefined,
  provider: string = "anthropic",
): Promise<ActiveEmbeddingCredential | null> {
  const row = await getActiveAICredential(db, provider);
  if (!row || !row.apiKey) return null;

  const apiKey = await decrypt(row.apiKey, encryptionKey);
  return { apiKey, model: row.model ?? DEFAULT_OPENAI_MODEL };
}
