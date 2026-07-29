import type { Db } from "../db/client";
import { channelCredentials } from "../db/schema";

/** Todas las filas de canales guardadas (0..4). El route mergea con el set fijo. */
export async function listChannels(db: Db) {
  return db.select().from(channelCredentials);
}

/** Upsert por channel_type: inserta si no existe, actualiza si sí. Setea
 *  `updated_at` explícito porque `$onUpdate` de Drizzle no corre en el path de
 *  onConflictDoUpdate. `encrypted_credentials` no se toca (Fase 6). */
export async function upsertChannel(
  db: Db,
  channelType: string,
  data: { config: Record<string, unknown>; isActive: boolean },
) {
  const rows = await db
    .insert(channelCredentials)
    .values({
      channelType,
      configJson: data.config,
      isActive: data.isActive,
    })
    .onConflictDoUpdate({
      target: channelCredentials.channelType,
      set: { configJson: data.config, isActive: data.isActive, updatedAt: new Date() },
    })
    .returning();
  return rows[0]!;
}
