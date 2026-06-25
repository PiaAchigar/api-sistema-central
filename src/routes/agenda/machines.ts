import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { createDb } from "../../db/client";
import { notFound } from "../../lib/errors";
import { auth, requireAdmin, requireAuth, requireRole } from "../../middleware/auth";
import {
  createMachine,
  createMaintenanceLog,
  deleteMaintenanceLog,
  listMachines,
  listMaintenanceLogs,
  setMachineStatus,
  updateMachine,
  updateMaintenanceLog,
} from "../../repositories/machines.repo";
import type { AppBindings, Variables } from "../../env";

const STAFF = ["admin", "manager", "operator"] as const;

const machinesRouter = new Hono<{ Bindings: AppBindings; Variables: Variables }>();

// ── Serialización (decimales string → number) ───────────────────────────────
function serializeMachine<T extends Record<string, unknown>>(m: T) {
  return {
    ...m,
    hourlyCost: m.hourlyCost != null ? Number(m.hourlyCost) : null,
    weightKg: m.weightKg != null ? Number(m.weightKg) : null,
    warrantyCost: m.warrantyCost != null ? Number(m.warrantyCost) : null,
  };
}
function serializeLog<T extends Record<string, unknown>>(l: T) {
  return { ...l, cost: l.cost != null ? Number(l.cost) : null };
}

// ── Máquinas ────────────────────────────────────────────────────────────────
machinesRouter.get(
  "/",
  auth,
  zValidator("query", z.object({ includeInactive: z.string().optional() })),
  async (c) => {
    const db = createDb(c.env);
    const canSeeInactive = (STAFF as readonly string[]).includes(c.get("userRole") ?? "");
    const includeInactive = canSeeInactive && c.req.valid("query").includeInactive === "true";
    const rows = await listMachines(db, includeInactive);
    return c.json(rows.map(serializeMachine));
  },
);

const machineBody = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(2000).nullish(),
  equipmentType: z.string().max(100).nullish(),
  requiresOperator: z.boolean().nullish(),
  hourlyCost: z.number().nonnegative().nullish(),
  status: z.enum(["active", "inactive", "maintenance"]).optional(),
  purchaseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  weightKg: z.number().nonnegative().nullish(),
  dimensions: z.string().max(100).nullish(),
  quantity: z.number().int().nonnegative().nullish(),
  maintenanceNotes: z.string().max(2000).nullish(),
  supplierInfo: z.string().max(2000).nullish(),
  warrantyCost: z.number().nonnegative().nullish(),
  warrantyExpiry: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
});

machinesRouter.post(
  "/",
  auth,
  requireAuth,
  requireAdmin,
  zValidator("json", machineBody.extend({ name: z.string().min(1).max(255) })),
  async (c) => {
    const db = createDb(c.env);
    const created = await createMachine(db, c.req.valid("json"));
    return c.json(serializeMachine(created), 201);
  },
);

machinesRouter.patch(
  "/:id",
  auth,
  requireAuth,
  requireRole(...STAFF),
  zValidator("json", machineBody),
  async (c) => {
    const db = createDb(c.env);
    const updated = await updateMachine(db, c.req.param("id"), c.req.valid("json"));
    if (!updated) throw notFound("Machine");
    return c.json(serializeMachine(updated));
  },
);

machinesRouter.delete("/:id", auth, requireAuth, requireAdmin, async (c) => {
  const db = createDb(c.env);
  const archived = await setMachineStatus(db, c.req.param("id"), "inactive");
  if (!archived) throw notFound("Machine");
  return c.json(serializeMachine(archived));
});

machinesRouter.post("/:id/restore", auth, requireAuth, requireAdmin, async (c) => {
  const db = createDb(c.env);
  const restored = await setMachineStatus(db, c.req.param("id"), "active");
  if (!restored) throw notFound("Machine");
  return c.json(serializeMachine(restored));
});

// ── Logs de mantenimiento ───────────────────────────────────────────────────
machinesRouter.get("/:id/logs", auth, requireAuth, requireRole(...STAFF), async (c) => {
  const db = createDb(c.env);
  const logs = await listMaintenanceLogs(db, c.req.param("id"));
  return c.json(logs.map(serializeLog));
});

const logBody = z.object({
  maintenanceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  maintenanceType: z.enum(["preventive", "corrective", "repair"]).nullish(),
  description: z.string().max(2000).nullish(),
  cost: z.number().nonnegative().nullish(),
  performedBy: z.string().max(255).nullish(),
  notes: z.string().max(2000).nullish(),
});

machinesRouter.post(
  "/:id/logs",
  auth,
  requireAuth,
  requireRole(...STAFF),
  zValidator("json", logBody.extend({ maintenanceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) })),
  async (c) => {
    const db = createDb(c.env);
    const created = await createMaintenanceLog(db, c.req.param("id"), c.req.valid("json"));
    return c.json(serializeLog(created), 201);
  },
);

machinesRouter.patch(
  "/log/:logId",
  auth,
  requireAuth,
  requireRole(...STAFF),
  zValidator("json", logBody),
  async (c) => {
    const db = createDb(c.env);
    const updated = await updateMaintenanceLog(db, c.req.param("logId"), c.req.valid("json"));
    if (!updated) throw notFound("MaintenanceLog");
    return c.json(serializeLog(updated));
  },
);

machinesRouter.delete("/log/:logId", auth, requireAuth, requireAdmin, async (c) => {
  const db = createDb(c.env);
  const deleted = await deleteMaintenanceLog(db, c.req.param("logId"));
  if (!deleted) throw notFound("MaintenanceLog");
  return c.json({ ok: true });
});

export { machinesRouter };
