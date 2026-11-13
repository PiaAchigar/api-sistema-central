import { and, asc, eq, isNotNull, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { nombreCorto } from "../lib/nombre-corto";
import type { Db } from "../db/client";
import { users } from "../db/schema";

/** Crea o actualiza la fila local de `users` indexada por auth_id (puente a Supabase Auth). */
export async function upsertLocalUser(
  db: Db,
  data: {
    authId: string;
    email: string;
    role: string;
    fullName?: string;
    createdByUserId?: string | null;
  },
) {
  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.authId, data.authId))
    .limit(1);
  if (existing[0]) {
    await db
      .update(users)
      .set({
        email: data.email,
        role: data.role,
        isActive: true,
        ...(data.fullName !== undefined ? { fullName: data.fullName } : {}),
      })
      .where(eq(users.authId, data.authId));
    return;
  }
  await db.insert(users).values({
    authId: data.authId,
    email: data.email,
    role: data.role,
    fullName: data.fullName ?? null,
    createdByUserId: data.createdByUserId ?? null,
    isActive: true,
  });
}

export async function setLocalUserRole(db: Db, authId: string, role: string) {
  await db.update(users).set({ role }).where(eq(users.authId, authId));
}

export async function setLocalUserActive(
  db: Db,
  authId: string,
  isActive: boolean,
) {
  await db.update(users).set({ isActive }).where(eq(users.authId, authId));
}

/** Usuarios activos, para el dropdown de "asignar agente" en el pipeline del
 *  CRM. Cualquier rol con acceso a `crm` puede verlo (no es admin-only como
 *  /api/users, que expone datos de Supabase Auth). */
export async function listActiveLocalUsers(db: Db) {
  return db
    .select({ id: users.id, fullName: users.fullName, email: users.email })
    .from(users)
    .where(and(eq(users.isActive, true), isNotNull(users.authId)))
    .orderBy(asc(users.fullName));
}

/** Cambia el nombre visible. Devuelve false si no hay fila local con ese auth_id. */
export async function setLocalUserFullName(
  db: Db,
  authId: string,
  fullName: string,
) {
  const rows = await db
    .update(users)
    .set({ fullName })
    .where(eq(users.authId, authId))
    .returning({ id: users.id });
  return rows.length > 0;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** users.id local de quien hace el pedido (por su auth id). null si no hay fila
 *  (cuentas de desarrollo, api-key). */
export async function localUserIdByAuthId(db: Db, authId: string | null) {
  if (!authId || !UUID.test(authId)) return null;
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.authId, authId))
    .limit(1);
  return rows[0]?.id ?? null;
}

/** Nombre y "creado por" por auth_id, para enriquecer el listado de Supabase Auth. */
export async function datosLocalesPorAuthId(db: Db, authIds: string[]) {
  const map = new Map<
    string,
    { fullName: string | null; createdByName: string | null }
  >();
  if (authIds.length === 0) return map;
  const creador = alias(users, "creador");
  const rows = await db
    .select({
      authId: users.authId,
      fullName: users.fullName,
      creadorNombre: creador.fullName,
      creadorEmail: creador.email,
      creadorId: creador.id,
    })
    .from(users)
    .leftJoin(creador, eq(users.createdByUserId, creador.id))
    .where(inArray(users.authId, authIds));
  for (const r of rows) {
    if (!r.authId) continue;
    map.set(r.authId, {
      fullName: r.fullName,
      createdByName: r.creadorId
        ? nombreCorto(r.creadorNombre, r.creadorEmail)
        : null,
    });
  }
  return map;
}
