import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { aiProviderCredentials } from "../db/schema";

/** Lista todas las credenciales guardadas. El route nunca reenvía `apiKey`
 *  (se selecciona sin esa columna para no tenerla ni de paso en memoria). */
export async function listAICredentials(db: Db) {
  return db
    .select({
      id: aiProviderCredentials.id,
      provider: aiProviderCredentials.provider,
      model: aiProviderCredentials.model,
      isActive: aiProviderCredentials.isActive,
      createdAt: aiProviderCredentials.createdAt,
    })
    .from(aiProviderCredentials)
    .orderBy(aiProviderCredentials.createdAt);
}

/** Inserta una credencial nueva y desactiva cualquier otra del mismo
 *  provider, en una transacción (el índice único parcial `(provider) WHERE
 *  is_active` exige que nunca haya dos filas activas al mismo tiempo). */
export async function createAICredential(
  db: Db,
  data: { provider: string; encryptedApiKey: string; model: string },
) {
  return db.transaction(async (tx) => {
    await tx
      .update(aiProviderCredentials)
      .set({ isActive: false, updatedAt: new Date() })
      .where(
        and(
          eq(aiProviderCredentials.provider, data.provider),
          eq(aiProviderCredentials.isActive, true),
        ),
      );

    const rows = await tx
      .insert(aiProviderCredentials)
      .values({
        provider: data.provider,
        apiKey: data.encryptedApiKey,
        model: data.model,
        isActive: true,
      })
      .returning({
        id: aiProviderCredentials.id,
        provider: aiProviderCredentials.provider,
        model: aiProviderCredentials.model,
        isActive: aiProviderCredentials.isActive,
        createdAt: aiProviderCredentials.createdAt,
      });
    return rows[0]!;
  });
}

/** Desactiva una credencial por id. Devuelve la fila actualizada o null si no
 *  existe. */
export async function deactivateAICredential(db: Db, id: string) {
  const rows = await db
    .update(aiProviderCredentials)
    .set({ isActive: false, updatedAt: new Date() })
    .where(eq(aiProviderCredentials.id, id))
    .returning({
      id: aiProviderCredentials.id,
      provider: aiProviderCredentials.provider,
      model: aiProviderCredentials.model,
      isActive: aiProviderCredentials.isActive,
      createdAt: aiProviderCredentials.createdAt,
    });
  return rows[0] ?? null;
}

/** Credencial activa por provider, CON `apiKey` (encriptada) — solo para uso
 *  interno server-side (ej: el endpoint que otros sistemas usan para resolver
 *  la key real). Nunca se expone directo en una respuesta HTTP. */
export async function getActiveAICredential(db: Db, provider: string) {
  const rows = await db
    .select()
    .from(aiProviderCredentials)
    .where(
      and(
        eq(aiProviderCredentials.provider, provider),
        eq(aiProviderCredentials.isActive, true),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}
