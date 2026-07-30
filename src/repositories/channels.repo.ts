import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { channelCredentials } from "../db/schema";

/** Todas las filas de canales guardadas (0..4). El route mergea con el set fijo. */
export async function listChannels(db: Db) {
  return db.select().from(channelCredentials);
}

/** Una fila de canal por tipo, o null. Incluye `encryptedCredentials` crudo
 *  (nunca se expone en una respuesta HTTP — solo lo usan messaging.service y
 *  el webhook para desencriptar server-side). */
export async function getChannelByType(db: Db, channelType: string) {
  const rows = await db
    .select()
    .from(channelCredentials)
    .where(eq(channelCredentials.channelType, channelType))
    .limit(1);
  return rows[0] ?? null;
}

/** Upsert por channel_type: inserta si no existe, actualiza si sí. Setea
 *  `updated_at` explícito porque `$onUpdate` de Drizzle no corre en el path de
 *  onConflictDoUpdate. `encryptedCredentials` es opcional: si no viene, la fila
 *  existente NO se toca (permite editar config/isActive sin re-mandar secretos). */
export async function upsertChannel(
  db: Db,
  channelType: string,
  data: { config: Record<string, unknown>; isActive: boolean; encryptedCredentials?: string },
) {
  const setClause: Record<string, unknown> = {
    configJson: data.config,
    isActive: data.isActive,
    updatedAt: new Date(),
  };
  if (data.encryptedCredentials !== undefined) {
    setClause.encryptedCredentials = data.encryptedCredentials;
  }
  const rows = await db
    .insert(channelCredentials)
    .values({
      channelType,
      configJson: data.config,
      isActive: data.isActive,
      ...(data.encryptedCredentials !== undefined
        ? { encryptedCredentials: data.encryptedCredentials }
        : {}),
    })
    .onConflictDoUpdate({
      target: channelCredentials.channelType,
      set: setClause,
    })
    .returning();
  return rows[0]!;
}
