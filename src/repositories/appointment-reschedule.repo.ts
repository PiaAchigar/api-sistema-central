import { desc, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { alias } from "drizzle-orm/pg-core";
import { appointmentReschedule, serviceProviders, users } from "../db/schema";
import type { FilaDeReagendado } from "../lib/reagendado";

/** Subconjunto de `Db` que también sirve dentro de una transacción (`tx`). */
type Tx = Pick<Db, "select" | "insert" | "update" | "delete">;

/**
 * Deja el rastro de un movimiento. Se llama SIEMPRE dentro de la misma
 * transacción que mueve el turno: si el UPDATE se hace y esto no, el
 * historial miente por omisión y nadie se entera.
 */
export async function recordReschedule(tx: Tx, fila: FilaDeReagendado) {
  await tx.insert(appointmentReschedule).values(fila);
}

/**
 * El historial de un turno, del movimiento más nuevo al más viejo.
 *
 * El nombre de quien lo movió sale de un LEFT JOIN por `users.auth_id` (el
 * `sub` del JWT de Supabase). Hoy sólo 2 de los 11 usuarios de producción
 * tienen `auth_id` cargado, así que muchas filas van a venir con
 * `rescheduledByName` en null — la fecha y el motivo se muestran igual, que es
 * lo que de verdad se perdía antes.
 */
export async function listReschedules(db: Db, appointmentId: string) {
  const proveedoraAnterior = alias(serviceProviders, "proveedora_anterior");
  const proveedoraNueva = alias(serviceProviders, "proveedora_nueva");
  return db
    .select({
      id: appointmentReschedule.id,
      previousStart: appointmentReschedule.previousStart,
      previousEnd: appointmentReschedule.previousEnd,
      newStart: appointmentReschedule.newStart,
      newEnd: appointmentReschedule.newEnd,
      reason: appointmentReschedule.reason,
      createdAt: appointmentReschedule.createdAt,
      rescheduledByName: users.fullName,
      previousProviderName: proveedoraAnterior.fullName,
      newProviderName: proveedoraNueva.fullName,
    })
    .from(appointmentReschedule)
    .leftJoin(users, eq(users.authId, appointmentReschedule.rescheduledByUserId))
    .leftJoin(proveedoraAnterior, eq(proveedoraAnterior.id, appointmentReschedule.previousProviderId))
    .leftJoin(proveedoraNueva, eq(proveedoraNueva.id, appointmentReschedule.newProviderId))
    .where(eq(appointmentReschedule.appointmentId, appointmentId))
    .orderBy(desc(appointmentReschedule.createdAt));
}
