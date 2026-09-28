import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client";
import { machines, serviceMachine, serviceProviderMachine } from "../db/schema";
import { anclaDeDepilacion } from "./ancla-de-depilacion.repo";
import { listAgreementRowsForService } from "./providers.repo";

/**
 * Los equipos que usa la depilación: `service_machine` del servicio ancla.
 *
 * Es la MITAD de la cuenta que hace la disponibilidad. La otra mitad es la
 * certificación de cada proveedora, y `loadAvailabilityContext` cruza las dos:
 *
 *     máquinas del turno = equipos del servicio ∩ certificación de la proveedora
 *
 * Si un equipo falta acá, certificar a la proveedora no sirve de nada: la
 * intersección da vacío, ella no aparece con horarios, y no hay ningún error
 * que lo explique. Por eso las dos listas se mueven juntas (ver `sacarEquipo`).
 */
export async function equiposDeDepilacion(db: Db) {
  const ancla = await anclaDeDepilacion(db);
  return db
    .select({
      machineId: machines.id,
      machineName: machines.name,
      machineStatus: machines.status,
    })
    .from(serviceMachine)
    .innerJoin(machines, eq(machines.id, serviceMachine.machineId))
    .where(eq(serviceMachine.serviceId, ancla));
}

/** Idempotente. `service_machine.id` no tiene DEFAULT en Postgres: lo genera
 *  Drizzle en runtime, así que el insert va por Drizzle y no por SQL crudo. */
export async function agregarEquipo(db: Db, machineId: string) {
  const ancla = await anclaDeDepilacion(db);
  const [ya] = await db
    .select({ id: serviceMachine.id })
    .from(serviceMachine)
    .where(and(eq(serviceMachine.serviceId, ancla), eq(serviceMachine.machineId, machineId)))
    .limit(1);
  if (ya) return;

  await db.insert(serviceMachine).values({
    serviceId: ancla,
    machineId,
    isPrimaryMachine: false,
  });
}

/**
 * Saca el equipo de la depilación y arrastra las certificaciones de ESE equipo
 * en las proveedoras que hacen depilación.
 *
 * Sin el arrastre quedan certificaciones que ya no significan nada y la lista
 * de la pantalla muestra a alguien habilitado en un equipo que la depilación
 * no usa. Se limita a las proveedoras CON ACUERDO sobre el ancla: la
 * certificación es global, y a una proveedora que usa ese equipo para otra
 * área no la toca nadie desde acá.
 */
export async function sacarEquipo(db: Db, machineId: string) {
  const ancla = await anclaDeDepilacion(db);
  const deDepilacion = await listAgreementRowsForService(db, ancla);
  const providerIds = deDepilacion.map((a) => a.serviceProviderId);

  await db.transaction(async (tx) => {
    await tx
      .delete(serviceMachine)
      .where(and(eq(serviceMachine.serviceId, ancla), eq(serviceMachine.machineId, machineId)));

    // `inArray` y no `= ANY(...)`: con `fetch_types: false` bajo Hyperdrive,
    // postgres-js no puede mandar un array como parámetro.
    if (providerIds.length > 0) {
      await tx
        .delete(serviceProviderMachine)
        .where(
          and(
            eq(serviceProviderMachine.machineId, machineId),
            inArray(serviceProviderMachine.serviceProviderId, providerIds),
          ),
        );
    }
  });
}
