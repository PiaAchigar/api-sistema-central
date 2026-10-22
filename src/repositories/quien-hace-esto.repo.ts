import { sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { anclaDeDepilacionOpcional } from "./ancla-de-depilacion.repo";

/**
 * ¿Quién hace esto? Para el Nuevo turno buscando desde el servicio (spec
 * 2026-10-22-nuevo-turno-filtros-cruzados): las prestadoras activas que hacen
 * al menos una parte de lo elegido, con qué hace cada una y si hace todo.
 * "Hacen todo" primero, después por nombre.
 *
 * Qué servicios tiene adentro cada cosa:
 * - servicio: él mismo;
 * - combo / pack: los de `combo_service` (un pack de combo, los de su combo);
 * - depilación: el servicio ancla (cualquier pack o zona: lo hace quien está
 *   habilitada en el ancla, el `id` no importa);
 * - promo: lo de sus `promotion_target` (servicios, combos; las zonas y packs
 *   de depilación, por el ancla).
 */
export type TipoDeQue = "servicio" | "combo" | "depilacion" | "promo";

export type QuienLoHace = {
  providerId: string;
  nombre: string | null;
  /** Nombres de los servicios de esto que ella hace */
  hace: string[];
  /** Sus ids, en el mismo orden (para medir si está libre) */
  serviceIds: string[];
  todo: boolean;
};

export async function quienHaceEsto(db: Db, tipo: TipoDeQue, id: string): Promise<QuienLoHace[]> {
  const ancla = await anclaDeDepilacionOpcional(db);
  const anclaSql = ancla ? sql`${ancla}::uuid` : sql`NULL::uuid`;

  const servicios =
    tipo === "servicio"
      ? sql`SELECT ${id}::uuid AS service_id`
      : tipo === "combo"
        ? sql`SELECT cs.service_id FROM combos c JOIN combo_service cs ON cs.combo_id = coalesce(c.pack_of_combo_id, c.id) WHERE c.id = ${id}::uuid`
        : tipo === "depilacion"
          ? sql`SELECT ${anclaSql} AS service_id`
          : sql`
            SELECT pt.service_id FROM promotion_target pt WHERE pt.promotion_id = ${id}::uuid AND pt.service_id IS NOT NULL
            UNION
            SELECT cs.service_id FROM promotion_target pt
              JOIN combos c ON c.id = pt.combo_id
              JOIN combo_service cs ON cs.combo_id = coalesce(c.pack_of_combo_id, c.id)
            WHERE pt.promotion_id = ${id}::uuid
            UNION
            SELECT ${anclaSql} FROM promotion_target pt
            WHERE pt.promotion_id = ${id}::uuid AND (pt.depilation_combo_id IS NOT NULL OR pt.body_zone_id IS NOT NULL)`;

  const filas = (await db.execute(sql`
    WITH necesarios AS (
      SELECT DISTINCT n.service_id FROM (${servicios}) n WHERE n.service_id IS NOT NULL
    ),
    pares AS (
      SELECT DISTINCT sps.service_provider_id AS provider_id, ne.service_id
      FROM necesarios ne
      JOIN service_provider_service sps ON sps.service_id = ne.service_id AND sps.is_active
    )
    SELECT sp.id AS "providerId", sp.full_name AS nombre,
           json_agg(s.name ORDER BY s.name) AS hace,
           json_agg(s.id ORDER BY s.name) AS "serviceIds",
           count(*) = (SELECT count(*) FROM necesarios) AS todo
    FROM pares pa
    JOIN service s ON s.id = pa.service_id AND s.is_active
    JOIN service_providers sp ON sp.id = pa.provider_id AND sp.status = 'active'
    GROUP BY sp.id, sp.full_name
    ORDER BY todo DESC, sp.full_name
  `)) as unknown as QuienLoHace[];
  return filas;
}
