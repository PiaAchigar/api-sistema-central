import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { automationRules, automationRuns } from "../db/schema";

export async function listRules(db: Db) {
  return db.select().from(automationRules).orderBy(desc(automationRules.createdAt));
}

export async function getRuleById(db: Db, id: string) {
  const rows = await db
    .select()
    .from(automationRules)
    .where(eq(automationRules.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export async function createRule(db: Db, data: typeof automationRules.$inferInsert) {
  const rows = await db.insert(automationRules).values(data).returning();
  return rows[0]!;
}

export async function updateRule(
  db: Db,
  id: string,
  data: Partial<typeof automationRules.$inferInsert>,
) {
  const rows = await db
    .update(automationRules)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(automationRules.id, id))
    .returning();
  return rows[0] ?? null;
}

export async function deleteRule(db: Db, id: string) {
  const rows = await db
    .delete(automationRules)
    .where(eq(automationRules.id, id))
    .returning({ id: automationRules.id });
  return rows[0] ?? null;
}

export async function listActiveRulesByTrigger(db: Db, triggerType: string) {
  return db
    .select()
    .from(automationRules)
    .where(and(eq(automationRules.triggerType, triggerType), eq(automationRules.isActive, true)));
}

export async function insertRun(db: Db, data: typeof automationRuns.$inferInsert) {
  await db.insert(automationRuns).values(data);
}

export async function listRuns(db: Db, limit: number) {
  return db
    .select({
      id: automationRuns.id,
      ruleId: automationRuns.ruleId,
      ruleName: automationRules.name,
      triggerType: automationRuns.triggerType,
      contactId: automationRuns.contactId,
      conversationId: automationRuns.conversationId,
      dealId: automationRuns.dealId,
      status: automationRuns.status,
      detail: automationRuns.detail,
      createdAt: automationRuns.createdAt,
    })
    .from(automationRuns)
    .leftJoin(automationRules, eq(automationRules.id, automationRuns.ruleId))
    .orderBy(desc(automationRuns.createdAt))
    .limit(limit);
}
