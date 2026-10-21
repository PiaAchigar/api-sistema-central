import { sql, type SQL } from "drizzle-orm";

/**
 * Una compra de capacitación sigue viva si no está cancelada y no está
 * TERMINADA: dar de baja a una clienta que queda debiendo no cancela la
 * compra (una cancelada no muestra deuda), sino que marca consumida su fila
 * de servicio. Esa compra ya no la inscribe: no figura en Inscriptas y, al
 * volver a anotarla, se la trata como si no la hubiera comprado.
 *
 * `compraId` es la columna del id de la compra en la consulta que lo usa.
 */
export const compraSinTerminar = (compraId: SQL) => sql`NOT EXISTS (
  SELECT 1 FROM customer_purchase_service cps_t
  WHERE cps_t.customer_purchase_id = ${compraId} AND cps_t.consumed_at IS NOT NULL
)`;
