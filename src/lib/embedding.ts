// api-sistema-central/src/lib/embedding.ts
//
// ⚠️ ADVERTENCIA DE DISEÑO — leer antes de construir nada arriba de esto ⚠️
//
// Anthropic (Claude) NO tiene un endpoint de embeddings. La Messages API
// solo genera texto conversacional — no existe un `client.embeddings.create()`
// como en OpenAI o Voyage AI. `generateEmbedding` de acá le pide a Claude, por
// chat, que "invente" 1536 números en formato JSON. Esos números NO son un
// embedding semántico real: nada garantiza que dos textos parecidos generen
// vectores parecidos (dos llamadas con el mismo texto pueden dar vectores
// distintos). Usar esto para búsqueda por similitud coseno
// (`idx_service_embeddings_embedding`, migración 1.4.0) va a devolver
// resultados esencialmente aleatorios — sin ningún error, silenciosamente mal.
//
// Este approach viene del plan original (Task 4 tal cual se pidió), que ya
// arrastraba el mismo defecto desde la migración 1.4.0 (comentario ahí:
// "vector 1536-dim (Claude 3.5 Sonnet embedding model)" — ese modelo de
// embeddings no existe). Se implementa tal cual se pidió para no romper la
// cadena de tareas (Task 5 depende de esta función), pero ANTES de construir
// búsqueda semántica real sobre `service_embeddings` hay que migrar a un
// proveedor con embeddings de verdad:
//   - Voyage AI (voyage-3) — socio de embeddings recomendado por Anthropic.
//   - OpenAI `text-embedding-3-small` (1536 dimensiones exactas) — esta misma
//     tabla `ai_provider_credentials` ya soporta provider="openai", así que
//     el cambio no requiere nueva infraestructura de credenciales.
//
// Nota de implementación: no se agrega `@anthropic-ai/sdk` como dependencia.
// El resto del proyecto ya llama a la API de Anthropic con `fetch` crudo
// (ver `routes/ai-config.ts` → `testAnthropicKey`) para no sumar peso al
// bundle de un Worker — se mantiene esa misma convención acá.

import { decrypt } from "../services/crypto.service";
import { getActiveAICredential } from "../repositories/ai-credentials.repo";
import type { Db } from "../db/client";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const EMBEDDING_DIMENSIONS = 1536;

// El plan original pedía "claude-3-5-sonnet-20241022" — retirado (Oct 2025).
// Se mantiene el mismo tier (Sonnet) pero con el ID vigente. Si la credencial
// guardada en `ai_provider_credentials.model` trae otro valor, se usa ese.
const DEFAULT_MODEL = "claude-sonnet-5";

export class EmbeddingError extends Error {}

type AnthropicMessageResponse = {
  stop_reason?: string;
  content: Array<{ type: string; text?: string }>;
};

/**
 * Le pide a Claude que "genere" un array de N números vía chat completion.
 * Ver la advertencia al inicio del archivo: esto NO produce un embedding
 * semántico real, solo satisface el shape (1536 floats) que espera la
 * columna `service_embeddings.embedding vector(1536)`.
 */
export async function generateEmbedding(
  text: string,
  apiKey: string,
  model: string = DEFAULT_MODEL,
): Promise<number[]> {
  const res = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 8192,
      // Pedimos thinking apagado: acá no hay razonamiento real que hacer (son
      // números inventados) y así evitamos el costo/latencia extra y el modo
      // de falla documentado de bloques <thinking> filtrando al texto visible.
      thinking: { type: "disabled" },
      messages: [
        {
          role: "user",
          content:
            `Generate a ${EMBEDDING_DIMENSIONS}-dimensional embedding vector for this text. ` +
            `Return ONLY valid JSON array of ${EMBEDDING_DIMENSIONS} numbers between -1 and 1. ` +
            `No explanation, no markdown code fences, no internal or system XML tags.\n\n` +
            `Text: "${text}"\n\n` +
            `Return format: [0.123, -0.456, 0.789, ...(${EMBEDDING_DIMENSIONS} values total)]`,
        },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const message =
      (body as { error?: { message?: string } } | null)?.error?.message ??
      `Anthropic respondió ${res.status}`;
    throw new EmbeddingError(`Fallo al llamar a Claude API: ${message}`);
  }

  const data = (await res.json()) as AnthropicMessageResponse;

  // stop_reason "refusal" viene con HTTP 200 — hay que chequearlo antes de
  // leer `content` (puede venir vacío).
  if (data.stop_reason === "refusal") {
    throw new EmbeddingError("Claude rechazó la solicitud (stop_reason: refusal).");
  }

  const textBlock = data.content?.find((block) => block.type === "text");
  if (!textBlock?.text) {
    throw new EmbeddingError("Respuesta inesperada de Claude API: no hay bloque de texto.");
  }

  const match = textBlock.text.match(/\[[\s\S]*\]/);
  if (!match) {
    throw new EmbeddingError("No se encontró un array JSON en la respuesta de Claude.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch (err) {
    throw new EmbeddingError(
      `No se pudo parsear el JSON devuelto por Claude: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (
    !Array.isArray(parsed) ||
    parsed.length !== EMBEDDING_DIMENSIONS ||
    !parsed.every((n) => typeof n === "number" && Number.isFinite(n))
  ) {
    throw new EmbeddingError(
      `Se esperaban ${EMBEDDING_DIMENSIONS} números finitos, se recibieron ` +
        (Array.isArray(parsed) ? `${parsed.length} elementos` : typeof parsed),
    );
  }

  return parsed as number[];
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
  return { apiKey, model: row.model ?? DEFAULT_MODEL };
}
