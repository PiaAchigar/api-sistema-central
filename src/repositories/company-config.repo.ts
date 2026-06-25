import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { companyConfig } from "../db/schema";

export async function getConfigRow(db: Db) {
  const [row] = await db.select().from(companyConfig).limit(1);
  return row ?? null;
}

export type ConfigWritable = {
  companyName?: string | null;
  companyDescription?: string | null;
  heroTitle?: string | null;
  heroSubtitle?: string | null;
  aboutUs?: string | null;
  address?: string | null;
  phone?: string | null;
  email?: string | null;
  website?: string | null;
  instagram?: string | null;
  facebook?: string | null;
  whatsapp?: string | null;
};

/** Actualiza la fila de configuración (única). Si no existe, la crea. */
export async function updateConfig(db: Db, patch: ConfigWritable) {
  const existing = await getConfigRow(db);
  const values = { ...patch, lastModifiedAt: new Date() };
  if (existing) {
    const [row] = await db
      .update(companyConfig)
      .set(values)
      .where(eq(companyConfig.id, existing.id))
      .returning();
    return row ?? null;
  }
  const [row] = await db.insert(companyConfig).values(values).returning();
  return row ?? null;
}
