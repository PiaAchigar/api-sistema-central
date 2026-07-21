import { and, asc, eq, gt, gte, inArray, isNotNull, lt, not, or, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  appointments,
  contacts,
  customers,
  machines,
  service,
  serviceProviders,
} from "../db/schema";

/** Estados que nunca bloquean disponibilidad. */
export const NON_BLOCKING_STATUSES = ["cancelled", "no_show"];

/**
 * Condición Drizzle: el turno SÍ ocupa agenda (bloquea disponibilidad).
 * Excluye: cancelled, no_show y reserved cuyo reservation_expires_at ya venció.
 */
function isBlocking() {
  return not(
    or(
      inArray(appointments.status, NON_BLOCKING_STATUSES),
      and(
        eq(appointments.status, "reserved"),
        isNotNull(appointments.reservationExpiresAt),
        lt(appointments.reservationExpiresAt, sql`now()`),
      ),
    )!,
  );
}

type Tx = Pick<Db, "select" | "insert" | "update">;

/** Turnos que ocupan agenda en un rango UTC, para proveedoras dadas. */
export async function getBusyAppointmentsForProviders(
  db: Tx,
  providerIds: string[],
  range: { start: Date; end: Date },
) {
  if (providerIds.length === 0) return [];
  return db
    .select({
      providerId: appointments.serviceProviderId,
      machineId: appointments.machineId,
      appointmentStart: appointments.appointmentStart,
      appointmentEnd: appointments.appointmentEnd,
    })
    .from(appointments)
    .where(
      and(
        inArray(appointments.serviceProviderId, providerIds),
        gte(appointments.appointmentStart, range.start),
        lt(appointments.appointmentStart, range.end),
        isBlocking(),
      ),
    );
}

/** Turnos que ocupan máquinas en un rango UTC (cualquier proveedora). */
export async function getBusyAppointmentsForMachines(
  db: Tx,
  machineIds: string[],
  range: { start: Date; end: Date },
) {
  if (machineIds.length === 0) return [];
  return db
    .select({
      machineId: appointments.machineId,
      appointmentStart: appointments.appointmentStart,
      appointmentEnd: appointments.appointmentEnd,
    })
    .from(appointments)
    .where(
      and(
        inArray(appointments.machineId, machineIds),
        gte(appointments.appointmentStart, range.start),
        lt(appointments.appointmentStart, range.end),
        isBlocking(),
      ),
    );
}

/**
 * Turnos que se solapan con [start, end) para una proveedora o máquina.
 * Se usa como re-chequeo dentro de la transacción de creación.
 */
export async function getOverlappingAppointments(
  db: Tx,
  target: { providerId?: string; machineId?: string },
  start: Date,
  end: Date,
) {
  const conditions = [
    lt(appointments.appointmentStart, end),
    gt(appointments.appointmentEnd, start),
    isBlocking(),
  ];
  if (target.providerId) {
    conditions.push(eq(appointments.serviceProviderId, target.providerId));
  }
  if (target.machineId) conditions.push(eq(appointments.machineId, target.machineId));

  return db
    .select({ id: appointments.id })
    .from(appointments)
    .where(and(...conditions));
}

export async function listAppointmentsByRange(
  db: Db,
  range: { start: Date; end: Date },
  filters: { providerId?: string; status?: string | string[] },
) {
  const conditions = [
    gte(appointments.appointmentStart, range.start),
    lt(appointments.appointmentStart, range.end),
  ];
  if (filters.providerId) {
    conditions.push(eq(appointments.serviceProviderId, filters.providerId));
  }
  if (filters.status) {
    conditions.push(
      Array.isArray(filters.status)
        ? inArray(appointments.status, filters.status)
        : eq(appointments.status, filters.status),
    );
  }

  return db
    .select({
      id: appointments.id,
      appointmentStart: appointments.appointmentStart,
      appointmentEnd: appointments.appointmentEnd,
      durationMinutes: appointments.durationMinutes,
      servicePrice: appointments.servicePrice,
      status: appointments.status,
      reservationExpiresAt: appointments.reservationExpiresAt,
      notes: appointments.notes,
      providerPaymentType: appointments.providerPaymentType,
      providerRate: appointments.providerRate,
      providerEarning: appointments.providerEarning,
      customerId: appointments.customerId,
      customerName: contacts.name,
      customerPhone: contacts.phone,
      serviceId: appointments.serviceId,
      serviceName: service.name,
      providerId: appointments.serviceProviderId,
      providerName: serviceProviders.fullName,
      machineId: appointments.machineId,
      machineName: machines.name,
    })
    .from(appointments)
    .leftJoin(customers, eq(customers.id, appointments.customerId))
    .leftJoin(contacts, eq(contacts.id, customers.contactId))
    .leftJoin(service, eq(service.id, appointments.serviceId))
    .leftJoin(serviceProviders, eq(serviceProviders.id, appointments.serviceProviderId))
    .leftJoin(machines, eq(machines.id, appointments.machineId))
    .where(and(...conditions))
    .orderBy(asc(appointments.appointmentStart));
}

export async function getAppointmentById(db: Db, id: string) {
  const rows = await db.select().from(appointments).where(eq(appointments.id, id)).limit(1);
  return rows[0] ?? null;
}

/** Mismo shape que `listAppointmentsByRange` (con nombres de cliente/servicio/proveedora), para un solo turno. */
export async function getAppointmentDetail(db: Db, id: string) {
  const rows = await db
    .select({
      id: appointments.id,
      appointmentStart: appointments.appointmentStart,
      appointmentEnd: appointments.appointmentEnd,
      durationMinutes: appointments.durationMinutes,
      servicePrice: appointments.servicePrice,
      status: appointments.status,
      reservationExpiresAt: appointments.reservationExpiresAt,
      notes: appointments.notes,
      providerPaymentType: appointments.providerPaymentType,
      providerRate: appointments.providerRate,
      providerEarning: appointments.providerEarning,
      customerId: appointments.customerId,
      customerName: contacts.name,
      customerPhone: contacts.phone,
      serviceId: appointments.serviceId,
      serviceName: service.name,
      providerId: appointments.serviceProviderId,
      providerName: serviceProviders.fullName,
      machineId: appointments.machineId,
      machineName: machines.name,
    })
    .from(appointments)
    .leftJoin(customers, eq(customers.id, appointments.customerId))
    .leftJoin(contacts, eq(contacts.id, customers.contactId))
    .leftJoin(service, eq(service.id, appointments.serviceId))
    .leftJoin(serviceProviders, eq(serviceProviders.id, appointments.serviceProviderId))
    .leftJoin(machines, eq(machines.id, appointments.machineId))
    .where(eq(appointments.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export async function insertAppointment(
  db: Tx,
  values: typeof appointments.$inferInsert,
) {
  const rows = await db.insert(appointments).values(values).returning();
  return rows[0]!;
}

export async function updateAppointment(
  db: Tx,
  id: string,
  values: Partial<typeof appointments.$inferInsert>,
) {
  const rows = await db
    .update(appointments)
    .set(values)
    .where(eq(appointments.id, id))
    .returning();
  return rows[0] ?? null;
}
