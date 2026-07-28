import { and, desc, eq, inArray, isNotNull, ne } from "drizzle-orm";
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
 *  `ne(deals.cancelled, true)` incluye también las filas donde `cancelled` es
 *  `NULL` (deals viejos, la columna siempre fue nullable) — que es lo que se
 *  quiere: solo excluir los explícitamente cancelados. */
export async function getOpenDealByContactId(db: Pick<Db, "select">, contactId: string) {
  const rows = await db
    .select()
    .from(deals)
    .where(
      and(
        eq(deals.contactId, contactId),
        ne(deals.stage, "completado"),
        ne(deals.cancelled, true),
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
