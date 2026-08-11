import { and, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  analyticsEvents,
  appointments,
  callLogs,
  contacts,
  conversations,
  customers,
  deals,
  invoices,
  messages,
  payments,
  trainingEnrollments,
  trainingSubscriptions,
} from "../db/schema";

const customerSummary = {
  id: customers.id,
  contactId: customers.contactId,
  dni: customers.dni,
  cuit: customers.cuit,
  creditBalance: customers.creditBalance,
  name: contacts.name,
  phone: contacts.phone,
  email: contacts.email,
};

// Un cliente ARCHIVADO no se ofrece en ningún selector del sistema: ni para
// agendar, ni para facturar, ni para suscribir. Estas dos funciones son el único
// embudo — `GET /api/billing/customers` es el endpoint que consumen los cuatro
// frontends (agenda, dashboard, facturador y CRM), así que el filtro va acá y no
// repetido en cada pantalla.
//
// Las búsquedas puntuales por id (`getCustomerById`, `getCustomerByContactId`)
// NO filtran a propósito: una factura vieja de un cliente archivado tiene que
// seguir resolviendo su nombre. Archivar saca de las listas, no borra el pasado.
const notArchived = sql`${contacts.isArchived} IS NOT TRUE`;

export async function searchCustomers(db: Db, q: string, limit = 20) {
  const pattern = `%${q}%`;
  return db
    .select(customerSummary)
    .from(customers)
    .innerJoin(contacts, eq(contacts.id, customers.contactId))
    .where(
      and(
        notArchived,
        or(
          ilike(contacts.name, pattern),
          ilike(customers.dni, pattern),
          ilike(contacts.phone, pattern),
        ),
      ),
    )
    .limit(limit);
}

export async function getCustomerById(db: Pick<Db, "select">, id: string) {
  const rows = await db
    .select(customerSummary)
    .from(customers)
    .innerJoin(contacts, eq(contacts.id, customers.contactId))
    .where(eq(customers.id, id))
    .limit(1);
  return rows[0] ?? null;
}

/** Igual que `getCustomerById` pero busca por CONTACT id en vez de CUSTOMER id —
 *  usar cuando lo único disponible es el `contactId` (ej: `deals.contactId`),
 *  que es una FK a `contacts`, no a `customers`. */
export async function getCustomerByContactId(db: Pick<Db, "select">, contactId: string) {
  const rows = await db
    .select(customerSummary)
    .from(customers)
    .innerJoin(contacts, eq(contacts.id, customers.contactId))
    .where(eq(customers.contactId, contactId))
    .limit(1);
  return rows[0] ?? null;
}

export async function findCustomerByDni(db: Db, dni: string) {
  const rows = await db
    .select({ id: customers.id })
    .from(customers)
    .where(and(eq(customers.dni, dni)))
    .limit(1);
  return rows[0] ?? null;
}

/** Alta rápida: crea CONTACT (status customer) + CUSTOMER en una transacción. */
export async function createQuickCustomer(
  db: Db,
  data: { name: string; dni: string; phone?: string; email?: string },
) {
  return db.transaction(async (tx) => {
    const [contact] = await tx
      .insert(contacts)
      .values({
        name: data.name,
        phone: data.phone ?? null,
        email: data.email ?? null,
        status: "customer",
        country: "AR",
        firstContactDate: new Date(),
        isArchived: false,
      })
      .returning({ id: contacts.id });

    const [customer] = await tx
      .insert(customers)
      .values({
        contactId: contact!.id,
        dni: data.dni,
        firstPurchaseDate: new Date(),
      })
      .returning({ id: customers.id });

    return { customerId: customer!.id, contactId: contact!.id };
  });
}

export async function listRecentCustomers(db: Db, limit = 20) {
  return db
    .select(customerSummary)
    .from(customers)
    .innerJoin(contacts, eq(contacts.id, customers.contactId))
    .where(notArchived)
    .orderBy(desc(customers.createdAt))
    .limit(limit);
}

/** Acredita `amount` al saldo a favor del cliente. Se llama dentro de la misma
 *  transacción que cancela el deal (ver appointments.service.ts). `sql` suma
 *  sobre el valor actual en la propia query — no hay condición de carrera entre
 *  leer y escribir el balance. */
export async function creditCustomer(
  tx: Pick<Db, "update">,
  customerId: string,
  amount: number,
) {
  await tx
    .update(customers)
    .set({ creditBalance: sql`${customers.creditBalance} + ${amount}` })
    .where(eq(customers.id, customerId));
}

// ── Borrado de un cliente (admin-only) ──────────────────────────────────────

/** Cuenta el historial de un cliente para decidir si se puede borrar.
 *
 *  Reglas de negocio 1.3: hard DELETE solo en registros SIN transacciones
 *  asociadas. Facturas, pagos, turnos, suscripciones e inscripciones son
 *  historial de negocio y bloquean el borrado — una factura emitida con CAE ya
 *  existe en ARCA y borrarla acá solo desincroniza el sistema.
 *
 *  Conversaciones, deals y logs son rastros de CRM sin valor fiscal ni
 *  contable: se borran junto con el cliente.
 *
 *  Recibe el CONTACT id porque es la clave que tiene la pantalla de Clientes;
 *  el customer se resuelve adentro y puede no existir. */
export async function getClientDeleteImpact(db: Db, contactId: string) {
  const customer = await db
    .select({ id: customers.id })
    .from(customers)
    .where(eq(customers.contactId, contactId))
    .limit(1);
  const customerId = customer[0]?.id;

  // Sin customer no hay historial de negocio posible: es un contacto que nunca
  // agendó ni compró.
  const n = (rows: { n: number }[]) => rows[0]?.n ?? 0;
  const [inv, pay, appt, subs, enr] = customerId
    ? await Promise.all([
        db.select({ n: sql<number>`count(*)::int` }).from(invoices)
          .where(eq(invoices.customerId, customerId)).then(n),
        db.select({ n: sql<number>`count(*)::int` }).from(payments)
          .where(eq(payments.customerId, customerId)).then(n),
        db.select({ n: sql<number>`count(*)::int` }).from(appointments)
          .where(eq(appointments.customerId, customerId)).then(n),
        db.select({ n: sql<number>`count(*)::int` }).from(trainingSubscriptions)
          .where(eq(trainingSubscriptions.customerId, customerId)).then(n),
        db.select({ n: sql<number>`count(*)::int` }).from(trainingEnrollments)
          .where(eq(trainingEnrollments.customerId, customerId)).then(n),
      ])
    : [0, 0, 0, 0, 0];

  const [conv, dealRows, calls, events] = await Promise.all([
    db.select({ id: conversations.id }).from(conversations).where(eq(conversations.contactId, contactId)),
    db.select({ id: deals.id }).from(deals).where(eq(deals.contactId, contactId)),
    db.select({ id: callLogs.id }).from(callLogs).where(eq(callLogs.contactId, contactId)),
    db.select({ id: analyticsEvents.id }).from(analyticsEvents).where(eq(analyticsEvents.contactId, contactId)),
  ]);

  const msgRows = conv.length
    ? await db
        .select({ n: sql<number>`count(*)::int` })
        .from(messages)
        .where(inArray(messages.conversationId, conv.map((r) => r.id)))
    : [];

  const parts: string[] = [];
  if (inv > 0) parts.push(`${inv} factura(s)`);
  if (pay > 0) parts.push(`${pay} pago(s)`);
  if (appt > 0) parts.push(`${appt} turno(s)`);
  if (subs > 0) parts.push(`${subs} suscripción(es)`);
  if (enr > 0) parts.push(`${enr} inscripción(es)`);

  return {
    blocked: parts.length > 0,
    blockReason:
      parts.length > 0
        ? `Tiene ${parts.join(", ")}. Archivalo en su lugar para no perder el historial.`
        : undefined,
    history: { invoices: inv, payments: pay, appointments: appt, subscriptions: subs, enrollments: enr },
    cascade: {
      conversations: conv.length,
      messages: msgRows[0]?.n ?? 0,
      deals: dealRows.length,
      callLogs: calls.length,
      analyticsEvents: events.length,
    },
  };
}
