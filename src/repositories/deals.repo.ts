import { and, desc, eq, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
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
