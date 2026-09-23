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
