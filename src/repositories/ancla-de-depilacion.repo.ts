import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { depilationPricingConfig } from "../db/schema";

/**
 * El `service` que sostiene la agenda de depilación.
 *
 * No se vende: existe para colgarle las proveedoras habilitadas (con su
 * tarifa) y la máquina, de modo que un turno de depilación use la misma
 * disponibilidad, el mismo reagendado y el mismo pago a proveedora que
 * cualquier otro servicio.
 *
 * Se lee de la config y **no se busca por nombre**: el nombre es texto que
 * alguien puede editar desde el dashboard, y el día que lo haga la agenda de
 * depilación dejaría de encontrarlo sin que nada avise.
 */
export async function anclaDeDepilacion(db: Db): Promise<string> {
  const [fila] = await db
    .select({ id: depilationPricingConfig.anchorServiceId })
    .from(depilationPricingConfig)
    .where(eq(depilationPricingConfig.singleton, true))
    .limit(1);

  if (!fila?.id) {
    throw new Error(
      "La configuración de depilación no tiene servicio ancla: falta aplicar la migración 1.56.0",
    );
  }
  return fila.id;
}

/**
 * El ancla, o `null` si todavía no hay.
 *
 * Las migraciones de este proyecto se aplican **a mano** en el SQL Editor de
 * Supabase (CLAUDE.md §5): nada garantiza que la 1.56.0 esté aplicada cuando
 * el worker sale. La versión que tira está bien donde la ausencia del ancla
 * ES el error —`datosParaAgendar`, que no tiene nada que hacer sin ella—,
 * pero la agenda general la consulta para una sola cosa: saber si ESTE turno
 * es de depilación. Ahí, "no hay ancla" significa "ningún turno es de
 * depilación", y el turnero del salón —una limpieza de cutis, una clase de
 * Pilates— tiene que seguir funcionando.
 *
 * Ruidoso a propósito: el `console.error` es lo único que va a explicar por
 * qué la depilación "no anda" si alguien deployó antes de migrar.
 */
export async function anclaDeDepilacionOpcional(db: Db): Promise<string | null> {
  try {
    return await anclaDeDepilacion(db);
  } catch (e) {
    console.error(
      "[depilación] No se pudo resolver el servicio ancla: los turnos de depilación no se van a poder agendar hasta aplicar la migración 1.56.0.",
      e,
    );
    return null;
  }
}
