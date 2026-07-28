import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { users } from "../db/schema";

/** Crea o actualiza la fila local de `users` indexada por auth_id (puente a Supabase Auth). */
export async function upsertLocalUser(
  db: Db,
  data: { authId: string; email: string; role: string },
) {
  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.authId, data.authId))
    .limit(1);
  if (existing[0]) {
    await db
      .update(users)
      .set({ email: data.email, role: data.role, isActive: true })
      .where(eq(users.authId, data.authId));
    return;
  }
  await db.insert(users).values({
    authId: data.authId,
    email: data.email,
    role: data.role,
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
    .where(eq(users.isActive, true));
}
