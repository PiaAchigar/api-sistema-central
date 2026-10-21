import { sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { anclaDeDepilacionOpcional } from "./ancla-de-depilacion.repo";
import { listServicesForProvider } from "./services.repo";

/**
 * Lo que ofrece una prestadora, para que el "Nuevo turno" abierto desde su
 * columna muestre sólo lo suyo (pedido de Pia, 2026-10-22).
 *
 * - `servicios`: los vendibles que tiene habilitados (`listServicesForProvider`).
 * - `depilacion`: si está habilitada en el servicio ancla, que no es vendible
 *   y por eso no sale en `servicios`.
 * - `actividades`: las que dicta en algún horario activo y vigente (la
 *   proveedora va por horario desde la 1.60.0).
 * - `capacitaciones`: las que tienen un encuentro suyo que todavía no pasó.
 */
export type OfertaDeProveedora = {
  servicios: string[];
  depilacion: boolean;
  actividades: { id: string; nombre: string }[];
  capacitaciones: { id: string; nombre: string }[];
};

/** `hoy` es el día local (ART) en YYYY-MM-DD. */
export async function getOfertaDeProveedora(db: Db, providerId: string, hoy: string): Promise<OfertaDeProveedora> {
  const [servicios, ancla, actividades, capacitaciones] = await Promise.all([
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
    depilacion,
    actividades: actividades as unknown as { id: string; nombre: string }[],
    capacitaciones: capacitaciones as unknown as { id: string; nombre: string }[],
  };
}
