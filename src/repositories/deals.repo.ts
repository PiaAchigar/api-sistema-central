import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { contacts, deals } from "../db/schema";

type Tx = Pick<Db, "select" | "insert" | "update">;

export async function insertDeal(tx: Tx, values: typeof deals.$inferInsert) {
  const rows = await tx.insert(deals).values(values).returning();
  return rows[0]!;
}

export async function getDealByAppointmentId(db: Tx, appointmentId: string) {
  const rows = await db
    .select()
    .from(deals)
    .where(eq(deals.appointmentId, appointmentId))
    .limit(1);
  return rows[0] ?? null;
}

/** Busca un deal por su propio id — usado para distinguir "no existe" de
 *  "ya está cancelado" antes de reintentar una cancelación (ver `/cancel`
 *  en routes/crm/deals.ts). */
export async function getDealById(db: Pick<Db, "select">, id: string) {
  const rows = await db.select().from(deals).where(eq(deals.id, id)).limit(1);
  return rows[0] ?? null;
}

/** Señas pagadas de varios turnos de una vez (para el estado de cuenta del día). */
export async function getPaidDealsByAppointmentIds(db: Db, appointmentIds: string[]) {
  if (appointmentIds.length === 0) return [];
  return db
    .select()
    .from(deals)
    .where(
      and(
        inArray(deals.appointmentId, appointmentIds),
        eq(deals.seniaPaid, true),
        isNotNull(deals.seniaAmount),
      ),
    );
}

// ── Pipeline (CRM Fase 1) ────────────────────────────────────────────────────

/** Todos los deals con el nombre del contacto, para pintar el kanban. El front
 *  decide si oculta los `cancelled=true` por defecto. */
export async function listDealsForPipeline(db: Db) {
  return db
    .select({
      id: deals.id,
      contactId: deals.contactId,
      contactName: contacts.name,
      appointmentId: deals.appointmentId,
      title: deals.title,
      serviceName: deals.serviceName,
      servicePrice: deals.servicePrice,
      seniaAmount: deals.seniaAmount,
      seniaPaid: deals.seniaPaid,
      stage: deals.stage,
      assignedAgentId: deals.assignedAgentId,
      cancelled: deals.cancelled,
      cancelReason: deals.cancelReason,
      createdAt: deals.createdAt,
    })
    .from(deals)
    .leftJoin(contacts, eq(contacts.id, deals.contactId))
    .orderBy(desc(deals.createdAt));
}

/** Deal creado a mano en el pipeline del CRM que TODAVÍA no tiene turno ni seña
 *  — lo usa `registerDeposit` para completarlo en vez de duplicarlo cuando por
 *  fin se cobra la seña del turno.
 *
 *  El match es deliberadamente angosto — las TRES condiciones son necesarias:
 *
 *  1. `appointment_id IS NULL` + 2. `senia_paid IS NOT TRUE`: sin esto, la
 *     segunda seña de un cliente que vuelve pisaba el deal de su PRIMER turno
 *     (corrompiendo `appointments.deal_id`, rompiendo el seguimiento de señas y
 *     silenciando el crédito por cancelación del primer turno).
 *
 *  3. `cancelled IS NOT TRUE`: sin esto, un deal manual que se canceló desde el
 *     kanban (sin plata de por medio, así que no se acreditó nada — correcto)
 *     seguía matcheando, y `updateDealFromDeposit` lo "resucitaba" con la seña
 *     nueva SIN limpiar `cancelled`/`cancel_reason`. Resultado: el deal pago
 *     quedaba invisible en el kanban, y si después se cancelaba ese turno el
 *     guard de `cancelDeal` (`WHERE cancelled IS NOT TRUE`) no matcheaba nada,
 *     devolvía null y `creditCustomer` NUNCA corría — la seña del cliente se
 *     perdía en silencio. Excluyéndolo, la seña cae a `insertDeal` y arranca un
 *     deal nuevo con su propio ciclo de cancelación/crédito.
 *
 *  Sobre `IS NOT TRUE`: un deal recién creado a mano tiene `senia_paid` y
 *  `cancelled` en NULL, y SÍ queremos matchearlo (nadie pagó ni canceló nada
 *  todavía). `ne(col, true)` en Postgres es `col <> true`, que da NULL para NULL
 *  y quedaría excluido por el WHERE — el footgun clásico de three-valued logic.
 *  Por eso ambas usan SQL crudo `IS NOT TRUE`, que incluye NULL y false. */
export async function getOpenDealByContactId(db: Pick<Db, "select">, contactId: string) {
  const rows = await db
    .select()
    .from(deals)
    .where(
      and(
        eq(deals.contactId, contactId),
        isNull(deals.appointmentId),
        sql`${deals.seniaPaid} IS NOT TRUE`,
        sql`${deals.cancelled} IS NOT TRUE`,
      ),
    )
    .orderBy(desc(deals.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

export async function createDeal(db: Db, data: typeof deals.$inferInsert) {
  const rows = await db.insert(deals).values(data).returning();
  return rows[0]!;
}

export async function updateDealStage(db: Db, id: string, stage: string) {
  const rows = await db.update(deals).set({ stage }).where(eq(deals.id, id)).returning();
  return rows[0] ?? null;
}

export async function assignDeal(db: Db, id: string, assignedAgentId: string | null) {
  const rows = await db
    .update(deals)
    .set({ assignedAgentId })
    .where(eq(deals.id, id))
    .returning();
  return rows[0] ?? null;
}

/** Cancela el deal con motivo. No toca `credit_balance` — eso lo hace el
 *  caller (Task 8) en la misma transacción, junto con la cancelación del turno.
 *
 *  El WHERE incluye `cancelled IS NOT TRUE` (equivalente Postgres-nativo de
 *  "no es explícitamente true", cubre NULL y false sin el footgun de
 *  three-valued logic de `ne()`) para que el UPDATE sea un no-op si el deal
 *  ya estaba cancelado. Esto hace la cancelación segura ante carreras: dos
 *  UPDATEs concurrentes sobre la misma fila se serializan por el lock de fila
 *  de Postgres; el primero en commitear pone `cancelled=true`, el segundo
 *  reevalúa el WHERE, no matchea nada y devuelve `null` — el caller debe
 *  tratar `null` como "no se acreditó nada" (ver appointments.service.ts). */
export async function cancelDeal(
  tx: Pick<Db, "update">,
  id: string,
  data: { cancelReason: string },
) {
  const rows = await tx
    .update(deals)
    .set({ cancelled: true, cancelReason: data.cancelReason })
    .where(and(eq(deals.id, id), sql`${deals.cancelled} IS NOT TRUE`))
    .returning();
  return rows[0] ?? null;
}

/** Actualiza un deal abierto existente con los datos de la seña recién cobrada,
 *  en vez de crear uno nuevo (evita duplicar oportunidades en el kanban). */
export async function updateDealFromDeposit(
  tx: Pick<Db, "update">,
  id: string,
  data: {
    appointmentId: string;
    serviceName: string | null;
    servicePrice: string;
    seniaAmount: string;
    seniaPaid: boolean;
    seniaPaidDate: Date;
    stage: string;
  },
) {
  const rows = await tx.update(deals).set(data).where(eq(deals.id, id)).returning();
  return rows[0]!;
}

/** Todos los deals de un contacto (para la ficha de contacto), más reciente primero. */
export async function listDealsByContactId(db: Db, contactId: string) {
  return db
    .select({
      id: deals.id,
      title: deals.title,
      serviceName: deals.serviceName,
      servicePrice: deals.servicePrice,
      seniaAmount: deals.seniaAmount,
      seniaPaid: deals.seniaPaid,
      stage: deals.stage,
      cancelled: deals.cancelled,
      totalAmount: deals.totalAmount,
      amountPaid: deals.amountPaid,
      amountPending: deals.amountPending,
      createdAt: deals.createdAt,
    })
    .from(deals)
    .where(eq(deals.contactId, contactId))
    .orderBy(desc(deals.createdAt));
}
