import { and, asc, gte, lt } from "drizzle-orm";
import type { Db } from "../db/client";
import { cashRegister } from "../db/schema";

type Tx = Pick<Db, "select" | "insert" | "update">;

export async function insertCashMovement(tx: Tx, values: typeof cashRegister.$inferInsert) {
  const rows = await tx.insert(cashRegister).values(values).returning();
  return rows[0]!;
}

export async function listCashMovementsByRange(db: Db, range: { start: Date; end: Date }) {
  return db
    .select()
    .from(cashRegister)
    .where(
      and(
        gte(cashRegister.registrationDate, range.start),
        lt(cashRegister.registrationDate, range.end),
      ),
    )
    .orderBy(asc(cashRegister.registrationDate));
}
