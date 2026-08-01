// POST /api/treatments/search
// Búsqueda híbrida: semantica (embeddings) + promociones asociadas.
// Sin autenticación requerida (acceso público para piubella_web).

import { Hono } from "hono";
import { badRequest } from "../../lib/errors";
import { generateEmbedding, getActiveCredential } from "../../lib/embedding";
import { createDb } from "../../db/client";
import { searchTreatments } from "../../repositories/treatments.repo";
import type { AppBindings, Variables } from "../../env";
import { z } from "zod";

const treatmentSearchRouter = new Hono<{ Bindings: AppBindings; Variables: Variables }>();

const searchRequestSchema = z.object({
  query: z.string().min(1, "query no puede estar vacío").max(500),
  limit: z.number().int().min(1).max(50).optional().default(10),
  similarityThreshold: z.number().min(0).max(1).optional().default(0.3),
});

type SearchRequest = z.infer<typeof searchRequestSchema>;

/**
 * POST /api/treatments/search
 * Búsqueda híbrida: servicios + promociones por query semántica.
 *
 * Request:
 * {
 *   "query": "quiero una depilación rápida",
 *   "limit": 10,
 *   "similarityThreshold": 0.3
 * }
 *
 * Response:
 * {
 *   "treatments": [
 *     {
 *       "id": "...",
 *       "name": "Depilación Láser - Bikini",
 *       "description": "...",
 *       "unit_price_list": 4500,
 *       "benefits": "Rápido, sin dolor",
 *       "similarity_score": 0.876
 *     }
 *   ],
 *   "promotions": [
 *     {
 *       "id": "...",
 *       "name": "Pack 5 depilaciones -20%",
 *       "description": "...",
 *       "promotion_type": "percentage",
 *       "discount_percentage": 20,
 *       "final_amount": 18000,
 *       "status": "active",
 *       "is_featured": true,
 *       "services": [
 *         { "service_id": "...", "service_name": "Depilación Láser - Bikini" }
 *       ]
 *     }
 *   ]
 * }
 */
treatmentSearchRouter.post("/", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = searchRequestSchema.safeParse(body);

  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? "Datos inválidos";
    throw badRequest(message);
  }

  const { query, limit, similarityThreshold } = parsed.data;

  try {
    const db = createDb(c.env);

    // Obtener credencial activa de OpenAI
    const credential = await getActiveCredential(
      db,
      c.env.CREDENTIALS_ENCRYPTION_KEY,
      "openai",
    );

    if (!credential) {
      return c.json(
        {
          error: "No hay credencial de OpenAI activa. Configúrala en el CRM.",
        },
        503,
      );
    }

    // Generar embedding de la query
    const embedding = await generateEmbedding(query, credential.apiKey, "openai", credential.model);

    // Búsqueda híbrida
    const results = await searchTreatments(db, embedding, {
      limit,
      similarityThreshold,
    });

    return c.json(results);
  } catch (err) {
    console.error("[treatments-search] Error:", err);

    if (err instanceof Error && err.message.includes("Embedding")) {
      return c.json({ error: err.message }, 400);
    }

    return c.json(
      { error: err instanceof Error ? err.message : "Error en búsqueda de tratamientos" },
      500,
    );
  }
});

export { treatmentSearchRouter };
