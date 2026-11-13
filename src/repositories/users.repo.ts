import { and, asc, eq, isNotNull, inArray } from "drizzle-orm";
import type { Db } from "../db/client";
import { users } from "../db/schema";

/** Crea o actualiza la fila local de `users` indexada por auth_id (puente a Supabase Auth). */
export async function upsertLocalUser(
  db: Db,
  data: { authId: string; email: string; role: string; fullName?: string },
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
    isActive: true,
  });
}

export async function setLocalUserRole(db: Db, authId: string, role: string) {
  await db.update(users).set({ role }).where(eq(users.authId, authId));
}

export async function setLocalUserActive(db: Db, authId: string, isActive: boolean) {
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
export async function setLocalUserFullName(db: Db, authId: string, fullName: string) {
  const rows = await db
    .update(users)
    .set({ fullName })
    .where(eq(users.authId, authId))
    .returning({ id: users.id });
  return rows.length > 0;
}

/** Nombres por auth_id, para enriquecer el listado de Supabase Auth. */
export async function fullNamesByAuthId(db: Db, authIds: string[]) {
  const map = new Map<string, string | null>();
  if (authIds.length === 0) return map;
  const rows = await db
    .select({ authId: users.authId, fullName: users.fullName })
    .from(users)
    .where(inArray(users.authId, authIds));
  for (const r of rows) if (r.authId) map.set(r.authId, r.fullName);
  return map;
}
