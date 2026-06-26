import { asc, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { mercadopagoAccounts } from "../db/schema";

const fields = {
  id: mercadopagoAccounts.id,
  serviceProviderId: mercadopagoAccounts.serviceProviderId,
  accountOwnerName: mercadopagoAccounts.accountOwnerName,
  accountEmail: mercadopagoAccounts.accountEmail,
  alias: mercadopagoAccounts.alias,
  cvu: mercadopagoAccounts.cvu,
  status: mercadopagoAccounts.status,
  createdAt: mercadopagoAccounts.createdAt,
};

export async function listMpAccountsByProvider(db: Db, providerId: string) {
  return db
    .select(fields)
    .from(mercadopagoAccounts)
    .where(eq(mercadopagoAccounts.serviceProviderId, providerId))
    .orderBy(asc(mercadopagoAccounts.createdAt));
}

type MpWritable = {
  alias?: string | null;
  cvu?: string | null;
  accountOwnerName?: string | null;
  accountEmail?: string | null;
};

export async function createMpAccount(db: Db, providerId: string, data: MpWritable) {
  const [row] = await db
    .insert(mercadopagoAccounts)
    .values({ serviceProviderId: providerId, status: "active", ...data })
    .returning(fields);
  return row;
}

export async function updateMpAccount(db: Db, id: string, patch: MpWritable) {
  const rows = await db
    .update(mercadopagoAccounts)
    .set(patch)
    .where(eq(mercadopagoAccounts.id, id))
    .returning(fields);
  return rows[0] ?? null;
}

export async function deleteMpAccount(db: Db, id: string) {
  const rows = await db
    .delete(mercadopagoAccounts)
    .where(eq(mercadopagoAccounts.id, id))
    .returning({ id: mercadopagoAccounts.id });
  return rows[0] ?? null;
}
