import { and, eq, inArray, isNotNull } from "drizzle-orm";
import type { Db } from "../db/client";
import { deals } from "../db/schema";

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
