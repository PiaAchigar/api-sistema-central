import { asc, desc, eq, ne } from "drizzle-orm";
import type { Db } from "../db/client";
import { machineMaintenanceLogs, machines, serviceMachine } from "../db/schema";

const machineFields = {
  id: machines.id,
  name: machines.name,
  description: machines.description,
  equipmentType: machines.equipmentType,
  requiresOperator: machines.requiresOperator,
  hourlyCost: machines.hourlyCost,
  status: machines.status,
  purchaseDate: machines.purchaseDate,
  weightKg: machines.weightKg,
  dimensions: machines.dimensions,
  quantity: machines.quantity,
  maintenanceCount: machines.maintenanceCount,
  lastMaintenanceAt: machines.lastMaintenanceAt,
  maintenanceNotes: machines.maintenanceNotes,
  supplierInfo: machines.supplierInfo,
  warrantyCost: machines.warrantyCost,
  warrantyExpiry: machines.warrantyExpiry,
};

/** Lista máquinas. Sin `includeInactive`, oculta las archivadas (status='inactive'). */
export async function listMachines(db: Db, includeInactive = false) {
  const base = db.select(machineFields).from(machines);
  const ordered = includeInactive ? base : base.where(ne(machines.status, "inactive"));
  return ordered.orderBy(asc(machines.name));
}

export async function getMachineById(db: Db, id: string) {
  const rows = await db.select(machineFields).from(machines).where(eq(machines.id, id)).limit(1);
  return rows[0] ?? null;
}

type MachineWritable = {
  name?: string;
  description?: string | null;
  equipmentType?: string | null;
  requiresOperator?: boolean | null;
  hourlyCost?: number | null;
  status?: string | null;
  purchaseDate?: string | null;
  weightKg?: number | null;
  dimensions?: string | null;
  quantity?: number | null;
  maintenanceNotes?: string | null;
  supplierInfo?: string | null;
  warrantyCost?: number | null;
  warrantyExpiry?: string | null;
};

const dec = (v: number | null | undefined) => (v == null ? v : String(v));
const ts = (v: string | null | undefined): Date | null => (v ? new Date(v) : null);

function toMachineSet(p: MachineWritable) {
  return {
    ...(p.name !== undefined && { name: p.name }),
    ...(p.description !== undefined && { description: p.description }),
    ...(p.equipmentType !== undefined && { equipmentType: p.equipmentType }),
    ...(p.requiresOperator !== undefined && { requiresOperator: p.requiresOperator }),
    ...(p.hourlyCost !== undefined && { hourlyCost: dec(p.hourlyCost) }),
    ...(p.status !== undefined && { status: p.status }),
    ...(p.purchaseDate !== undefined && { purchaseDate: p.purchaseDate }),
    ...(p.weightKg !== undefined && { weightKg: dec(p.weightKg) }),
    ...(p.dimensions !== undefined && { dimensions: p.dimensions }),
    ...(p.quantity !== undefined && { quantity: p.quantity }),
    ...(p.maintenanceNotes !== undefined && { maintenanceNotes: p.maintenanceNotes }),
    ...(p.supplierInfo !== undefined && { supplierInfo: p.supplierInfo }),
    ...(p.warrantyCost !== undefined && { warrantyCost: dec(p.warrantyCost) }),
    ...(p.warrantyExpiry !== undefined && { warrantyExpiry: ts(p.warrantyExpiry) }),
  };
}

export async function createMachine(db: Db, data: MachineWritable & { name: string }) {
  const rows = await db
    .insert(machines)
    .values({ ...toMachineSet(data), status: data.status ?? "active" })
    .returning(machineFields);
  return rows[0]!;
}

export async function updateMachine(db: Db, id: string, patch: MachineWritable) {
  const rows = await db
    .update(machines)
    .set(toMachineSet(patch))
    .where(eq(machines.id, id))
    .returning(machineFields);
  return rows[0] ?? null;
}

/** Soft-delete / restore: status active ↔ inactive (regla 1.3). */
export async function setMachineStatus(db: Db, id: string, status: "active" | "inactive") {
  const rows = await db
    .update(machines)
    .set({ status })
    .where(eq(machines.id, id))
    .returning(machineFields);
  return rows[0] ?? null;
}

// ── Logs de mantenimiento ───────────────────────────────────────────────────

const logFields = {
  id: machineMaintenanceLogs.id,
  machineId: machineMaintenanceLogs.machineId,
  maintenanceDate: machineMaintenanceLogs.maintenanceDate,
  maintenanceType: machineMaintenanceLogs.maintenanceType,
  description: machineMaintenanceLogs.description,
  cost: machineMaintenanceLogs.cost,
  performedBy: machineMaintenanceLogs.performedBy,
  notes: machineMaintenanceLogs.notes,
  createdAt: machineMaintenanceLogs.createdAt,
};

export async function listMaintenanceLogs(db: Db, machineId: string) {
  return db
    .select(logFields)
    .from(machineMaintenanceLogs)
    .where(eq(machineMaintenanceLogs.machineId, machineId))
    .orderBy(desc(machineMaintenanceLogs.maintenanceDate));
}

/** Recalcula el contador desnormalizado y la última fecha desde los logs reales. */
async function recomputeMaintenance(db: Db, machineId: string) {
  const logs = await db
    .select({ date: machineMaintenanceLogs.maintenanceDate })
    .from(machineMaintenanceLogs)
    .where(eq(machineMaintenanceLogs.machineId, machineId));
  const dates = logs.map((l) => l.date).filter((d): d is string => Boolean(d)).sort();
  const last = dates.length ? dates[dates.length - 1]! : null;
  await db
    .update(machines)
    .set({ maintenanceCount: logs.length, lastMaintenanceAt: last ? new Date(last) : null })
    .where(eq(machines.id, machineId));
}

type LogWritable = {
  maintenanceDate?: string | null;
  maintenanceType?: string | null;
  description?: string | null;
  cost?: number | null;
  performedBy?: string | null;
  notes?: string | null;
};

function toLogSet(p: LogWritable) {
  return {
    ...(p.maintenanceDate !== undefined && { maintenanceDate: p.maintenanceDate }),
    ...(p.maintenanceType !== undefined && { maintenanceType: p.maintenanceType }),
    ...(p.description !== undefined && { description: p.description }),
    ...(p.cost !== undefined && { cost: dec(p.cost) }),
    ...(p.performedBy !== undefined && { performedBy: p.performedBy }),
    ...(p.notes !== undefined && { notes: p.notes }),
  };
}

export async function createMaintenanceLog(db: Db, machineId: string, data: LogWritable) {
  const rows = await db
    .insert(machineMaintenanceLogs)
    .values({ ...toLogSet(data), machineId })
    .returning(logFields);
  await recomputeMaintenance(db, machineId);
  return rows[0]!;
}

export async function updateMaintenanceLog(db: Db, logId: string, patch: LogWritable) {
  const rows = await db
    .update(machineMaintenanceLogs)
    .set(toLogSet(patch))
    .where(eq(machineMaintenanceLogs.id, logId))
    .returning(logFields);
  const updated = rows[0] ?? null;
  if (updated?.machineId) await recomputeMaintenance(db, updated.machineId);
  return updated;
}

export async function deleteMaintenanceLog(db: Db, logId: string) {
  const rows = await db
    .delete(machineMaintenanceLogs)
    .where(eq(machineMaintenanceLogs.id, logId))
    .returning({ id: machineMaintenanceLogs.id, machineId: machineMaintenanceLogs.machineId });
  const deleted = rows[0] ?? null;
  if (deleted?.machineId) await recomputeMaintenance(db, deleted.machineId);
  return deleted;
}

// ── Vínculo servicio ↔ máquina (una principal) ──────────────────────────────

/** Modelo "una máquina por servicio": reemplaza el vínculo existente. */
export async function setServicePrimaryMachine(
  db: Db,
  serviceId: string,
  machineId: string | null,
) {
  await db.delete(serviceMachine).where(eq(serviceMachine.serviceId, serviceId));
  if (machineId) {
    await db.insert(serviceMachine).values({ serviceId, machineId, isPrimaryMachine: true });
  }
}

export { machineFields };
