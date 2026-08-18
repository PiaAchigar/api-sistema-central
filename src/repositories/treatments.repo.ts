import { sql } from "drizzle-orm";
import type { Db } from "../db/client";

export type TreatmentKind = "service" | "activity" | "training";

export type TreatmentResult = {
  id: string;
  name: string;
  description: string | null;
  // Sigue siendo el precio de SERVICE tal cual estaba: para actividades y
  // capacitaciones viene NULL (no se renombra, no se reutiliza). El precio
  // que corresponda a cada `kind` está en el campo `price`, agregado abajo.
  unit_price_list: number | null;
  benefits: string | null;
  contraindications: string | null;
  special_attention_notes: string | null;
  similarity_score: number;
  // Campos nuevos (Task 3): de dónde viene el resultado y cómo se cobra.
  kind: TreatmentKind;
  price: number | null;
  price_label: string;
};

// Fila cruda que devuelve el UNION ALL, antes de calcularle `price_label` en TS.
type TreatmentQueryRow = Omit<TreatmentResult, "price_label">;

/**
 * Qué unidad de cobro corresponde a cada resultado.
 *
 * Las actividades son el caso feo: `monthly_base_price` guarda el abono del mes
 * o el precio de una clase suelta, y la base no los distingue con ningún campo.
 * El único indicio es el nombre. Es frágil a propósito y está anotado como
 * deuda — lo correcto sería una columna en `activities`.
 */
export function priceLabelFor(kind: TreatmentKind, name: string): string {
  if (kind === "training") return "el curso";
  if (kind === "activity") {
    return /clase suelta|prueba/i.test(name) ? "por clase" : "por mes";
  }
  return "por sesión";
}

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
 * Búsqueda híbrida: encuentra servicios, actividades y capacitaciones similares
 * usando embeddings vectoriales (UNION ALL de las tres tablas de embeddings),
 * luego busca promociones que contengan los SERVICIOS encontrados.
 *
 * - `embedding`: vector de 1536 dimensiones (embeddings semánticos de la query)
 * - `limit`: cantidad máxima de resultados a retornar (default 10), aplicado
 *   sobre el conjunto ya unido de las tres fuentes
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

  // 1. Búsqueda por similitud vectorial, unida entre las tres fuentes.
  // Cada rama proyecta las MISMAS columnas en el MISMO orden: donde una tabla
  // no tiene el dato (p.ej. `benefits` en activities) se castea NULL al tipo
  // correcto — Postgres es estricto con los tipos en un UNION y sin el cast
  // explícito puede fallar al resolver el tipo de la columna combinada.
  const rows = await db.execute<TreatmentQueryRow>(
    sql`
      SELECT
        s.id,
        s.name,
        s.description,
        s.unit_price_list,
        s.unit_price_list AS price,
        'service'::text AS kind,
        s.benefits,
        s.contraindications,
        s.special_attention_notes,
        ROUND((1 - (se.embedding <=> ${vectorLiteral}::vector))::numeric, 3)::float AS similarity_score
      FROM service_embeddings se
      JOIN service s ON se.service_id = s.id
      WHERE se.embedding IS NOT NULL
        AND s.is_active = true
        AND (1 - (se.embedding <=> ${vectorLiteral}::vector)) >= ${threshold}

      UNION ALL

      SELECT
        a.id,
        a.name,
        a.description,
        NULL::numeric AS unit_price_list,
        a.monthly_base_price AS price,
        'activity'::text AS kind,
        NULL::text AS benefits,
        NULL::text AS contraindications,
        NULL::text AS special_attention_notes,
        ROUND((1 - (ae.embedding <=> ${vectorLiteral}::vector))::numeric, 3)::float AS similarity_score
      FROM activity_embeddings ae
      JOIN activities a ON ae.activity_id = a.id
      WHERE ae.embedding IS NOT NULL
        AND a.is_active = true
        AND (1 - (ae.embedding <=> ${vectorLiteral}::vector)) >= ${threshold}

      UNION ALL

      SELECT
        t.id,
        t.name,
        t.description,
        NULL::numeric AS unit_price_list,
        t.list_price AS price,
        'training'::text AS kind,
        NULL::text AS benefits,
        NULL::text AS contraindications,
        NULL::text AS special_attention_notes,
        ROUND((1 - (te.embedding <=> ${vectorLiteral}::vector))::numeric, 3)::float AS similarity_score
      FROM training_embeddings te
      JOIN training t ON te.training_id = t.id
      WHERE te.embedding IS NOT NULL
        AND t.is_active = true
        AND (1 - (te.embedding <=> ${vectorLiteral}::vector)) >= ${threshold}

      ORDER BY similarity_score DESC
      LIMIT ${limit}
    `,
  );

  // Se calcula `price_label` en TS (no en SQL) porque depende de una regex
  // sobre el nombre — ver `priceLabelFor`.
  const treatments: TreatmentResult[] = rows.map((row) => ({
    ...row,
    price_label: priceLabelFor(row.kind, row.name),
  }));

  // 2. Buscar promociones que contengan los servicios encontrados.
  // 🚨 `promotion_service` solo conoce ids de SERVICIOS: un id de actividad o
  // capacitación no existe ahí y ensuciaría la consulta (o directamente
  // fallaría si algún día se agrega una FK). Se filtra por kind === "service"
  // antes de armar la lista.
  let promotions: PromotionResult[] = [];

  const serviceIds = treatments.filter((t) => t.kind === "service").map((t) => t.id);

  if (serviceIds.length > 0) {
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
