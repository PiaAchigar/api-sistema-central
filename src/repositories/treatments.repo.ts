import { sql } from "drizzle-orm";
import type { Db } from "../db/client";

export type TreatmentResult = {
  id: string;
  name: string;
  description: string | null;
  unit_price_list: number;
  benefits: string | null;
  contraindications: string | null;
  special_attention_notes: string | null;
  similarity_score: number;
};

export type PromotionResult = {
  id: string;
  name: string;
  description: string | null;
  promotion_type: string;
  discount_percentage: number | null;
  discount_amount: number | null;
  final_amount: number | null;
  valid_from: Date | null;
  valid_until: Date | null;
  status: string;
  is_featured: boolean;
  services: Array<{ service_id: string; service_name: string }>;
};

export type SearchResults = {
  treatments: TreatmentResult[];
  promotions: PromotionResult[];
};

/**
 * Búsqueda híbrida: encuentra servicios similares usando embeddings vectoriales,
 * luego busca promociones que contengan esos servicios.
 *
 * - `embedding`: vector de 1536 dimensiones (embeddings semánticos de la query)
 * - `limit`: cantidad máxima de servicios a retornar (default 10)
 * - `similarityThreshold`: valor mínimo de similitud coseno (0-1, default 0.3)
 */
export async function searchTreatments(
  db: Db,
  embedding: number[],
  options: { limit?: number; similarityThreshold?: number } = {},
): Promise<SearchResults> {
  const limit = options.limit ?? 10;
  const threshold = options.similarityThreshold ?? 0.3;

  // Validar que el embedding tiene la dimensión correcta
  if (!Array.isArray(embedding) || embedding.length !== 1536) {
    throw new Error(`Embedding debe tener 1536 dimensiones, se recibieron ${embedding.length}`);
  }

  // Vector literal para pgvector: '[n1,n2,...]'
  const vectorLiteral = `[${embedding.join(",")}]`;

  // 1. Búsqueda de servicios por similitud vectorial
  const treatments = await db.execute<TreatmentResult>(
    sql`
      SELECT
        s.id,
        s.name,
        s.description,
        s.unit_price_list,
        s.benefits,
        s.contraindications,
        s.special_attention_notes,
        ROUND((1 - (se.embedding <=> ${vectorLiteral}::vector))::numeric, 3)::float AS similarity_score
      FROM service_embeddings se
      JOIN service s ON se.service_id = s.id
      WHERE se.embedding IS NOT NULL
        AND (1 - (se.embedding <=> ${vectorLiteral}::vector)) >= ${threshold}
        AND s.is_active = true
      ORDER BY similarity_score DESC
      LIMIT ${limit}
    `,
  );

  // 2. Buscar promociones que contengan los servicios encontrados
  let promotions: PromotionResult[] = [];

  if (treatments.length > 0) {
    const serviceIds = treatments.map((t) => t.id);
    // Construir la lista de UUIDs de forma segura
    const uuidList = serviceIds.map((id) => `'${id}'`).join(",");

    // Agrupar promociones y listar sus servicios relacionados con la búsqueda
    promotions = await db.execute<any>(
      sql.raw(`
        SELECT
          p.id,
          p.name,
          p.description,
          p.promotion_type,
          p.discount_percentage,
          p.discount_amount,
          p.final_amount,
          p.valid_from,
          p.valid_until,
          p.status,
          p.is_featured,
          json_agg(
            json_build_object('service_id', ps.service_id::text, 'service_name', s.name)
          ) as services
        FROM promotions p
        JOIN promotion_service ps ON p.id = ps.promotion_id
        JOIN service s ON ps.service_id = s.id
        WHERE ps.service_id::text IN (${uuidList})
          AND p.status = 'active'
          AND (p.valid_until IS NULL OR p.valid_until >= CURRENT_DATE)
        GROUP BY p.id, p.name, p.description, p.promotion_type, p.discount_percentage,
                 p.discount_amount, p.final_amount, p.valid_from, p.valid_until,
                 p.status, p.is_featured
        ORDER BY p.is_featured DESC, p.valid_until ASC NULLS LAST
      `)
    );

    // Parsear el JSON aggregado de servicios y convertir tipos
    promotions = promotions.map((promo: any) => ({
      id: promo.id,
      name: promo.name,
      description: promo.description,
      promotion_type: promo.promotion_type,
      discount_percentage: promo.discount_percentage ? Number(promo.discount_percentage) : null,
      discount_amount: promo.discount_amount ? Number(promo.discount_amount) : null,
      final_amount: promo.final_amount ? Number(promo.final_amount) : null,
      valid_from: promo.valid_from,
      valid_until: promo.valid_until,
      status: promo.status,
      is_featured: promo.is_featured,
      services: typeof promo.services === "string" ? JSON.parse(promo.services) : promo.services || [],
    }));
  }

  return { treatments, promotions };
}
