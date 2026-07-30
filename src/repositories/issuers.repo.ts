import { and, asc, eq, ne, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { arcaIssuers } from "../db/schema";

type Tx = Pick<Db, "select" | "insert" | "update">;

/**
 * Columnas seguras para exponer por la API: TODO menos los secretos cifrados.
 * Los `*_enc` solo se leen en `getIssuerWithSecrets` (uso interno del factory).
 */
const publicColumns = {
  id: arcaIssuers.id,
  name: arcaIssuers.name,
  cuit: arcaIssuers.cuit,
  environment: arcaIssuers.environment,
  pointOfSale: arcaIssuers.pointOfSale,
  invoiceType: arcaIssuers.invoiceType,
  isActive: arcaIssuers.isActive,
  isDefault: arcaIssuers.isDefault,
  notes: arcaIssuers.notes,
  createdAt: arcaIssuers.createdAt,
  updatedAt: arcaIssuers.updatedAt,
};

export type PublicIssuer = {
  [K in keyof typeof publicColumns]: (typeof arcaIssuers)["$inferSelect"][K];
};

export async function listIssuers(db: Db, opts: { onlyActive?: boolean } = {}) {
  const rows = await db
    .select(publicColumns)
    .from(arcaIssuers)
    .where(opts.onlyActive ? eq(arcaIssuers.isActive, true) : undefined)
    .orderBy(asc(arcaIssuers.name));
  return rows;
}

export async function getIssuer(db: Db, id: string) {
  const rows = await db.select(publicColumns).from(arcaIssuers).where(eq(arcaIssuers.id, id)).limit(1);
  return rows[0] ?? null;
}

/** Fila completa CON los secretos cifrados. Solo para el factory de ARCA. */
export async function getIssuerWithSecrets(db: Db, id: string) {
  const rows = await db.select().from(arcaIssuers).where(eq(arcaIssuers.id, id)).limit(1);
  return rows[0] ?? null;
}

/** El facturador marcado por defecto (activo). Es el que se usa si no se eligió uno. */
export async function getDefaultIssuerWithSecrets(db: Db) {
  const rows = await db
    .select()
    .from(arcaIssuers)
    .where(and(eq(arcaIssuers.isDefault, true), eq(arcaIssuers.isActive, true)))
    .limit(1);
  return rows[0] ?? null;
}

export async function countIssuers(db: Db): Promise<number> {
  const rows = await db.select({ n: sql<number>`count(*)::int` }).from(arcaIssuers);
  return rows[0]?.n ?? 0;
}

export async function findIssuerByName(db: Db, name: string) {
  const rows = await db
    .select({ id: arcaIssuers.id })
    .from(arcaIssuers)
    .where(sql`lower(${arcaIssuers.name}) = lower(${name})`)
    .limit(1);
  return rows[0] ?? null;
}

export async function insertIssuer(db: Tx, values: typeof arcaIssuers.$inferInsert) {
  const rows = await db.insert(arcaIssuers).values(values).returning(publicColumns);
  return rows[0]!;
}

export async function updateIssuer(
  db: Tx,
  id: string,
  values: Partial<typeof arcaIssuers.$inferInsert>,
) {
  const rows = await db
    .update(arcaIssuers)
    .set(values)
    .where(eq(arcaIssuers.id, id))
    .returning(publicColumns);
  return rows[0] ?? null;
}

/**
 * Saca la marca de "por defecto" del resto. Hay un índice único parcial que
 * impide dos defaults a la vez, así que esto va SIEMPRE antes de marcar el nuevo
 * y dentro de la misma transacción.
 */
export async function clearDefaultExcept(db: Pick<Db, "update">, keepId: string) {
  await db
    .update(arcaIssuers)
    .set({ isDefault: false })
    .where(and(eq(arcaIssuers.isDefault, true), ne(arcaIssuers.id, keepId)));
}
