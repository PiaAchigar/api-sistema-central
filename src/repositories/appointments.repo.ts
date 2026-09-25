import { and, asc, desc, eq, gt, gte, inArray, isNotNull, lt, not, or, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  activities,
  appointmentBodyZone,
  bodyZone,
  customerPurchaseService,
  appointments,
  contacts,
  customers,
  machines,
  service,
  serviceProviders,
} from "../db/schema";
import { getCustomerByContactId } from "./customers.repo";

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
      // `id` para poder excluir un turno de su propio cálculo al reagendarlo.
      id: appointments.id,
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
      id: appointments.id,
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

/**
 * Las zonas de depilación de varios turnos, en un `select` aparte indexado
 * por `appointment_id` — no un JOIN sobre la consulta principal, que
 * multiplicaría cada fila de turno por cada zona que tenga.
 */
export async function getBodyZonesForAppointments(
  db: Db,
  appointmentIds: string[],
): Promise<Map<string, { bodyZoneId: string; nombre: string; minutos: number }[]>> {
  const mapa = new Map<string, { bodyZoneId: string; nombre: string; minutos: number }[]>();
  if (appointmentIds.length === 0) return mapa;

  const filas = await db
    .select({
      appointmentId: appointmentBodyZone.appointmentId,
      bodyZoneId: appointmentBodyZone.bodyZoneId,
      minutos: appointmentBodyZone.minutos,
      nombre: bodyZone.name,
    })
    .from(appointmentBodyZone)
    .innerJoin(bodyZone, eq(bodyZone.id, appointmentBodyZone.bodyZoneId))
    .where(inArray(appointmentBodyZone.appointmentId, appointmentIds));

  for (const f of filas) {
    const lista = mapa.get(f.appointmentId) ?? [];
    lista.push({ bodyZoneId: f.bodyZoneId, nombre: f.nombre, minutos: f.minutos });
    mapa.set(f.appointmentId, lista);
  }
  return mapa;
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
      // Necesarios para que la Agenda distinga un turno de ACTIVIDAD y pueda
      // abrir el modal de asistencias (ver GET /api/class-attendance).
      activityId: appointments.activityId,
      activityName: activities.name,
      activityType: activities.activityType,
      trainingSessionId: appointments.trainingSessionId,
      // El servicio comprado del que sale este turno, si sale de uno. La
      // agenda lo usa para NO ofrecer "Cobrar": esa plata ya se cobró (o se
      // cobra) del lado de la compra, y cobrarla de nuevo acá sería cobrarle
      // dos veces a la clienta. Uno solo por turno lo garantiza el índice
      // `ux_cpsv_turno`, así que el join no multiplica filas.
      customerPurchaseServiceId: customerPurchaseService.id,
    })
    .from(appointments)
    .leftJoin(customerPurchaseService, eq(customerPurchaseService.appointmentId, appointments.id))
    .leftJoin(customers, eq(customers.id, appointments.customerId))
    .leftJoin(contacts, eq(contacts.id, customers.contactId))
    .leftJoin(service, eq(service.id, appointments.serviceId))
    .leftJoin(serviceProviders, eq(serviceProviders.id, appointments.serviceProviderId))
    .leftJoin(machines, eq(machines.id, appointments.machineId))
    .leftJoin(activities, eq(activities.id, appointments.activityId))
    .where(and(...conditions))
    .orderBy(asc(appointments.appointmentStart));

  // Las zonas de depilación de cada turno del día. Turno sin zonas (el caso
  // normal) queda con []. Igual que en `getAppointmentDetail`: hoy ningún
  // front lo lee — está para que la grilla pueda mostrar "Depilación ·
  // pierna, axila" cuando se construya esa parte.
  const zonasPorTurno = await getBodyZonesForAppointments(db, rows.map((r) => r.id));
  return rows.map((r) => ({ ...r, zonas: zonasPorTurno.get(r.id) ?? [] }));
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
      // Necesarios para que la Agenda distinga un turno de ACTIVIDAD y pueda
      // abrir el modal de asistencias (ver GET /api/class-attendance).
      activityId: appointments.activityId,
      activityName: activities.name,
      activityType: activities.activityType,
      trainingSessionId: appointments.trainingSessionId,
      // El servicio comprado del que sale este turno, si sale de uno. La
      // agenda lo usa para NO ofrecer "Cobrar": esa plata ya se cobró (o se
      // cobra) del lado de la compra, y cobrarla de nuevo acá sería cobrarle
      // dos veces a la clienta. Uno solo por turno lo garantiza el índice
      // `ux_cpsv_turno`, así que el join no multiplica filas.
      customerPurchaseServiceId: customerPurchaseService.id,
    })
    .from(appointments)
    .leftJoin(customerPurchaseService, eq(customerPurchaseService.appointmentId, appointments.id))
    .leftJoin(customers, eq(customers.id, appointments.customerId))
    .leftJoin(contacts, eq(contacts.id, customers.contactId))
    .leftJoin(service, eq(service.id, appointments.serviceId))
    .leftJoin(serviceProviders, eq(serviceProviders.id, appointments.serviceProviderId))
    .leftJoin(machines, eq(machines.id, appointments.machineId))
    .leftJoin(activities, eq(activities.id, appointments.activityId))
    .where(eq(appointments.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) return null;

  // Mismo criterio que `listAppointmentsByRange`: un `select` aparte, no un
  // join sobre la consulta principal (que multiplicaría esta única fila por
  // cada zona).
  //
  // **Hoy NINGUNA pantalla lee este campo** (ronda de arreglos 3, Important
  // 5): ni `front-agenda` —su tipo `Appointment` ni siquiera declara
  // `zonas`— ni ningún otro front. El dato viaja para que el recibo y la
  // trazabilidad de qué se depiló tengan de dónde salir cuando esa pantalla
  // se construya; mientras tanto es payload sin consumir, y decirlo acá es
  // preferible a un comentario que afirme una pantalla que no existe.
  const zonasPorTurno = await getBodyZonesForAppointments(db, [row.id]);
  return { ...row, zonas: zonasPorTurno.get(row.id) ?? [] };
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

/** Turnos de un contacto (para la ficha). Resuelve contacto→cliente y lista sus
 *  turnos con el nombre del servicio. Si el contacto no es cliente, devuelve []. */
export async function listAppointmentsByContactId(db: Db, contactId: string) {
  const customer = await getCustomerByContactId(db, contactId);
  if (!customer) return [];
  return db
    .select({
      id: appointments.id,
      serviceName: service.name,
      appointmentStart: appointments.appointmentStart,
      appointmentEnd: appointments.appointmentEnd,
      servicePrice: appointments.servicePrice,
      status: appointments.status,
    })
    .from(appointments)
    .leftJoin(service, eq(service.id, appointments.serviceId))
    .where(eq(appointments.customerId, customer.id))
    .orderBy(desc(appointments.appointmentStart));
}
