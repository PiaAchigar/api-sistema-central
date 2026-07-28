import { and, desc, eq, inArray, isNotNull, isNull, ne, or } from "drizzle-orm";
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

/** Deal "abierto" de un contacto (no cancelado, no completado) — lo usa
 *  `registerDeposit` para actualizar en vez de duplicar al cobrar una seña.
 *  `cancelled` es nullable (deals viejos y los creados manualmente no la
 *  setean), y en SQL `NULL <> true` da `NULL` — que en un WHERE se evalúa
 *  como falso y excluiría esas filas. Por eso se usa
 *  `or(isNull(...), ne(...))`: solo se excluyen los explícitamente
 *  cancelados (`cancelled = true`), no los que tienen `cancelled = NULL`. */
export async function getOpenDealByContactId(db: Pick<Db, "select">, contactId: string) {
  const rows = await db
    .select()
    .from(deals)
    .where(
      and(
        eq(deals.contactId, contactId),
        ne(deals.stage, "completado"),
        or(isNull(deals.cancelled), ne(deals.cancelled, true)),
      ),
    )
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
 *  caller (Task 8) en la misma transacción, junto con la cancelación del turno. */
export async function cancelDeal(
  tx: Pick<Db, "update">,
  id: string,
  data: { cancelReason: string },
) {
  const rows = await tx
    .update(deals)
    .set({ cancelled: true, cancelReason: data.cancelReason })
    .where(eq(deals.id, id))
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
