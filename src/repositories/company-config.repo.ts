import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { companyConfig, openHours } from "../db/schema";

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

// ── Horarios de atención (open_hours) ────────────────────────────────────────

export type OpenHourInput = {
  dayOfWeek: number;
  openingTime?: string | null;
  closingTime?: string | null;
  isOpen?: boolean | null;
};

/** Upsert por día de la semana (0=domingo … 6=sábado). */
export async function upsertOpenHours(db: Db, days: OpenHourInput[]) {
  for (const d of days) {
    const values = {
      openingTime: d.openingTime ?? null,
      closingTime: d.closingTime ?? null,
      isOpen: d.isOpen ?? null,
    };
    const updated = await db
      .update(openHours)
      .set(values)
      .where(eq(openHours.dayOfWeek, d.dayOfWeek))
      .returning({ id: openHours.id });
    if (updated.length === 0) {
      await db.insert(openHours).values({ dayOfWeek: d.dayOfWeek, ...values });
    }
  }
  return db
    .select({
      dayOfWeek: openHours.dayOfWeek,
      openingTime: openHours.openingTime,
      closingTime: openHours.closingTime,
      isOpen: openHours.isOpen,
    })
    .from(openHours)
    .orderBy(openHours.dayOfWeek);
}
