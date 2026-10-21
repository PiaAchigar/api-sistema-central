import { sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { anclaDeDepilacionOpcional } from "./ancla-de-depilacion.repo";
import { listServicesForProvider } from "./services.repo";

/**
 * Lo que ofrece una prestadora, para que el "Nuevo turno" abierto desde su
 * columna muestre sólo lo suyo (pedido de Pia, 2026-10-22).
 *
 * - `servicios`: los vendibles que tiene habilitados (`listServicesForProvider`).
 * - `combos`: combos y packs activos con al menos un servicio suyo (un pack
 *   de combo, por los servicios de su combo). Alcanza con uno: desde su hueco
 *   se agenda lo que ella hace y el resto queda "A agendar".
 * - `depilacion`: si está habilitada en el servicio ancla, que no es vendible
 *   y por eso no sale en `servicios`.
 * - `actividades`: las que dicta en algún horario activo y vigente (la
 *   proveedora va por horario desde la 1.60.0).
 * - `capacitaciones`: las que tienen un encuentro suyo que todavía no pasó.
 */
export type OfertaDeProveedora = {
  servicios: string[];
  combos: string[];
  depilacion: boolean;
  actividades: { id: string; nombre: string }[];
  capacitaciones: { id: string; nombre: string }[];
};

/** `hoy` es el día local (ART) en YYYY-MM-DD. */
export async function getOfertaDeProveedora(db: Db, providerId: string, hoy: string): Promise<OfertaDeProveedora> {
  const [servicios, ancla, actividades, capacitaciones, combos] = await Promise.all([
    listServicesForProvider(db, providerId),
    anclaDeDepilacionOpcional(db),
    db.execute(sql`
      SELECT DISTINCT a.id, a.name AS nombre
      FROM activity_schedules s JOIN activities a ON a.id = s.activity_id
      WHERE s.service_provider_id = ${providerId}::uuid AND s.is_active AND a.is_active
        AND (s.valid_until IS NULL OR s.valid_until >= ${hoy}::date)
      ORDER BY a.name
    `),
    db.execute(sql`
      SELECT DISTINCT t.id, t.name AS nombre
      FROM training_sessions ts JOIN training t ON t.id = ts.training_id
      WHERE ts.service_provider_id = ${providerId}::uuid AND ts.is_active AND t.is_active
        AND ts.session_date >= ${hoy}::date
      ORDER BY t.name
    `),
    db.execute(sql`
      SELECT c.id FROM combos c
      WHERE c.is_active AND EXISTS (
        SELECT 1 FROM combo_service cs
        JOIN service_provider_service sps ON sps.service_id = cs.service_id
        JOIN service s ON s.id = cs.service_id
        WHERE cs.combo_id = coalesce(c.pack_of_combo_id, c.id)
          AND sps.service_provider_id = ${providerId}::uuid AND sps.is_active AND s.is_active
      )
    `),
  ]);

  let depilacion = false;
  if (ancla) {
    const filas = (await db.execute(sql`
      SELECT 1 FROM service_provider_service
      WHERE service_provider_id = ${providerId}::uuid AND service_id = ${ancla}::uuid AND is_active
      LIMIT 1
    `)) as unknown as unknown[];
    depilacion = filas.length > 0;
  }

  return {
    servicios: servicios.map((s) => s.id),
    combos: (combos as unknown as { id: string }[]).map((c) => c.id),
    depilacion,
    actividades: actividades as unknown as { id: string; nombre: string }[],
    capacitaciones: capacitaciones as unknown as { id: string; nombre: string }[],
  };
}
