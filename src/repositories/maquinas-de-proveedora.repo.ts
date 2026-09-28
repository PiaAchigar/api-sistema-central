import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { machines, serviceProviderMachine } from "../db/schema";

/**
 * Qué máquinas sabe usar una proveedora.
 *
 * `service_provider_machine` NO tiene columna de servicio: la certificación es
 * un hecho de la proveedora, no del servicio para el que se la mira. Por eso
 * esto devuelve TODAS sus máquinas, y quien llame filtra las que le importan.
 * Lo que ninguna pantalla puede hacer es reconciliar este conjunto contra la
 * lista que ella muestra: le borraría a la proveedora las máquinas que usa en
 * otras áreas del salón.
 */
export async function maquinasDeProveedora(db: Db, providerId: string) {
  return db
    .select({
      machineId: serviceProviderMachine.machineId,
      machineName: machines.name,
      machineStatus: machines.status,
    })
    .from(serviceProviderMachine)
    .innerJoin(machines, eq(machines.id, serviceProviderMachine.machineId))
    .where(eq(serviceProviderMachine.serviceProviderId, providerId));
}

/** Idempotente: habilitar dos veces deja una sola fila. No hay índice único
 *  que lo garantice, así que se chequea acá. */
export async function habilitarMaquina(db: Db, providerId: string, machineId: string) {
  const [ya] = await db
    .select({ id: serviceProviderMachine.id })
    .from(serviceProviderMachine)
    .where(
      and(
        eq(serviceProviderMachine.serviceProviderId, providerId),
        eq(serviceProviderMachine.machineId, machineId),
      ),
    )
    .limit(1);
  if (ya) return;

  await db.insert(serviceProviderMachine).values({
    serviceProviderId: providerId,
    machineId,
    certifiedDate: null,
  });
}

/** Idempotente: deshabilitar algo que no está no es un error. */
export async function deshabilitarMaquina(db: Db, providerId: string, machineId: string) {
  await db
    .delete(serviceProviderMachine)
    .where(
      and(
        eq(serviceProviderMachine.serviceProviderId, providerId),
        eq(serviceProviderMachine.machineId, machineId),
      ),
    );
}
