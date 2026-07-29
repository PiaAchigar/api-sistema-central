// api-sistema-central/src/routes/crm/automations.ts
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { createDb } from "../../db/client";
import { notFound } from "../../lib/errors";
import { requireAuth, requirePermission } from "../../middleware/auth";
import {
  createRule,
  deleteRule,
  listRuns,
  listRules,
  updateRule,
} from "../../repositories/automations.repo";
import { ruleBody } from "./automation.schema";
import type { AppBindings, Variables } from "../../env";

const automationsRouter = new Hono<{ Bindings: AppBindings; Variables: Variables }>();

automationsRouter.get("/", requireAuth, requirePermission("crm", "view"), async (c) => {
  const db = createDb(c.env);
  return c.json(await listRules(db));
});

automationsRouter.get(
  "/runs",
  requireAuth,
  requirePermission("crm", "view"),
  zValidator("query", z.object({ limit: z.coerce.number().int().min(1).max(200).optional() })),
  async (c) => {
    const db = createDb(c.env);
    return c.json(await listRuns(db, c.req.valid("query").limit ?? 50));
  },
);

automationsRouter.post(
  "/",
  requireAuth,
  requirePermission("crm", "manage"),
  zValidator("json", ruleBody),
  async (c) => {
    const db = createDb(c.env);
    const b = c.req.valid("json");
    const rule = await createRule(db, {
      name: b.name,
      isActive: b.isActive ?? true,
      triggerType: b.triggerType,
      conditions: b.conditions,
      actionType: b.actionType,
      actionConfig: b.actionConfig,
    });
    return c.json(rule, 201);
  },
);

automationsRouter.patch(
  "/:id",
  requireAuth,
  requirePermission("crm", "manage"),
  zValidator("json", ruleBody),
  async (c) => {
    const db = createDb(c.env);
    const b = c.req.valid("json");
    const updated = await updateRule(db, c.req.param("id"), {
      name: b.name,
      isActive: b.isActive ?? true,
      triggerType: b.triggerType,
      conditions: b.conditions,
      actionType: b.actionType,
      actionConfig: b.actionConfig,
    });
    if (!updated) throw notFound("Rule");
    return c.json(updated);
  },
);

automationsRouter.delete("/:id", requireAuth, requirePermission("crm", "manage"), async (c) => {
  const db = createDb(c.env);
  const deleted = await deleteRule(db, c.req.param("id"));
  if (!deleted) throw notFound("Rule");
  return c.json({ ok: true });
});

export { automationsRouter };
