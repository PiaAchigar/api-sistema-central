import { and, eq, isNull, or, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  appointments,
  customerPurchase,
  customerPurchaseService,
} from "../db/schema";
import { conflict } from "../lib/errors";
import { type ServicioDisponible, elegirServicio } from "../lib/eleccion-de-servicio";

/**
 * Lo que la clienta tiene a favor para un servicio, y qué se descontaría.
 *
 * Es la consulta que corre al abrir el turno nuevo, así que la condición de
 * "disponible" está escrita en SQL en vez de traer todo y filtrar en memoria:
 * una clienta con años de historia tiene muchos servicios comprados y casi
 * ninguno libre.
 *
 * Espeja `estadoDeSesion()` de `lib/compras.ts` — que es la definición— para el
 * caso `disponible`:
 *
 *   sin consumir · sin turno vivo · la compra ni vencida ni cancelada
 *
 * ⚠️ Si esa función cambia, esta condición cambia con ella. Se duplica a
 * propósito y no se comparte porque una es TypeScript sobre filas ya traídas y
 * la otra es un WHERE; unificarlas obligaría a traer la historia entera.
 */
export async function serviciosDisponiblesPara(
  db: Db,
  customerId: string,
  serviceId: string,
  ahora: Date,
): Promise<ServicioDisponible[]> {
  const filas = await db
    .select({
      purchaseServiceId: customerPurchaseService.id,
      purchaseId: customerPurchase.id,
      descripcion: customerPurchase.description,
      repeticion: customerPurchaseService.repeticion,
      venceEl: customerPurchase.expiresAt,
    })
    .from(customerPurchaseService)
    .innerJoin(
      customerPurchase,
      eq(customerPurchase.id, customerPurchaseService.customerPurchaseId),
    )
    .leftJoin(appointments, eq(appointments.id, customerPurchaseService.appointmentId))
    .where(
      and(
        eq(customerPurchase.customerId, customerId),
        // La compra tiene que estar viva.
        isNull(customerPurchase.cancelledAt),
        or(
          isNull(customerPurchase.expiresAt),
          sql`${customerPurchase.expiresAt} >= ${ahora}`,
        ),
        // El servicio, libre: sin consumir y sin un turno que lo reserve. Un
        // turno CANCELADO no reserva —se avisó, se reagenda— pero un `no_show`
        // sí lo deja tomado: la clienta lo perdió (reglas §3.8).
        isNull(customerPurchaseService.consumedAt),
        or(
          isNull(customerPurchaseService.appointmentId),
          eq(appointments.status, "cancelled"),
        ),
        // Que la fila SEA de este servicio. Antes acá había que salir a buscar
        // si el combo lo contenía y contar cuántos servicios tenía, para dejar
        // afuera los de 2+ (V3b los habilita). Ahora la fila ya lo sabe.
        eq(customerPurchaseService.serviceId, serviceId),
      ),
    );

  return filas.map((f) => ({
    purchaseServiceId: f.purchaseServiceId,
    purchaseId: f.purchaseId,
    descripcion: f.descripcion ?? "Compra sin descripción",
    repeticion: f.repeticion ?? 0,
    venceEl: f.venceEl,
  }));
}

/** Lo que la pantalla de turno nuevo necesita saber en una sola consulta. */
export async function queSeDescuenta(
  db: Db,
  customerId: string,
  serviceId: string,
  ahora: Date,
) {
  return elegirServicio(await serviciosDisponiblesPara(db, customerId, serviceId, ahora));
}

/**
 * Ata el servicio comprado al turno recién creado. Falla si ya no está libre.
 *
 * El UPDATE trae la condición de "libre" adentro del WHERE y no en un SELECT
 * previo, y eso es lo que lo hace seguro: si dos personas agendan el mismo
 * servicio al mismo tiempo, la segunda actualiza cero filas y se entera. Con
 * un SELECT y después un UPDATE, las dos verían el servicio libre y la
 * segunda pisaría a la primera — el pack quedaría con un servicio de más y
 * nadie se enteraría hasta que la clienta reclame.
 *
 * También valida que el servicio sea de ESTA clienta: un id ajeno, mandado
 * por error o a propósito, descontaría el pack de otra persona.
 */
export async function tomarServicio(
  db: Db,
  purchaseServiceId: string,
  ctx: { appointmentId: string; customerId: string; serviceId: string; ahora: Date },
): Promise<void> {
  const libres = await serviciosDisponiblesPara(db, ctx.customerId, ctx.serviceId, ctx.ahora);
  if (!libres.some((s) => s.purchaseServiceId === purchaseServiceId)) {
    throw conflict("Ese servicio ya no está disponible para descontar");
  }

  const tomadas = await db
    .update(customerPurchaseService)
    .set({ appointmentId: ctx.appointmentId, updatedAt: new Date() })
    .where(
      and(
        eq(customerPurchaseService.id, purchaseServiceId),
        isNull(customerPurchaseService.consumedAt),
        // Sin turno, o con uno cancelado que ya no lo reserva.
        or(
          isNull(customerPurchaseService.appointmentId),
          sql`EXISTS (
            SELECT 1 FROM ${appointments} a
             WHERE a.id = ${customerPurchaseService.appointmentId}
               AND a.status = 'cancelled'
          )`,
        ),
      ),
    )
    .returning({ id: customerPurchaseService.id });

  if (tomadas.length === 0) {
    throw conflict("Ese servicio acaba de ser tomado por otro turno");
  }
}

/**
 * Marca consumido el servicio comprado atado a este turno.
 *
 * Se llama cuando el turno pasa a `completed`. Es idempotente: si ya tenía
 * `consumed_at` no lo pisa, así que volver a completar un turno no mueve la
 * fecha original.
 *
 * **El ausente NO pasa por acá.** Un servicio perdido por `no_show` se deriva
 * del estado del turno (`estadoDeSesion` lo devuelve como "perdida") y no se
 * escribe: así, si Laura se equivocó y corrige el turno, el servicio vuelve
 * solo a estar disponible sin que nadie tenga que deshacer nada.
 */
export async function consumirServicioDelTurno(
  db: Db,
  appointmentId: string,
  ahora: Date,
): Promise<void> {
  await db
    .update(customerPurchaseService)
    .set({ consumedAt: ahora, updatedAt: new Date() })
    .where(
      and(
        eq(customerPurchaseService.appointmentId, appointmentId),
        isNull(customerPurchaseService.consumedAt),
      ),
    );
}
