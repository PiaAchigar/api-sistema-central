// api-sistema-central/src/services/message-queue.service.ts
//
// Cola interna de mensajes pendientes de enviar por WhatsApp (Task 2 —
// confiabilidad WhatsApp). Las automatizaciones masivas (ofertas, recordatorios
// a muchos contactos) no pueden enviar directo — bloquearían el request y
// violarían el rate limit de Meta. En cambio: enqueueMessage() inserta acá
// (rápido, ~100ms) y el worker background (queue-processor.ts) la procesa cada
// corrida de cron, máx 10 mensajes por vez.
//
// No hay `db` global en este Worker — cada request/cron crea su propia
// conexión vía Hyperdrive (ver db/client.ts) — por eso `db` se recibe como
// parámetro, igual que el resto de repos/servicios (ver delivery-logger.service.ts).
import { and, asc, eq, isNull, lt, or } from "drizzle-orm";
import type { Db } from "../db/client";
import { messageQueue } from "../db/schema";

export type MessageQueueSenderType = "agent" | "system";
export type MessageQueueStatus = "pending" | "sent" | "failed" | "cancelled";

/** Encola un mensaje para ser enviado por el worker background. No envía
 *  nada acá — solo persiste con status "pending". */
export async function enqueueMessage(
  db: Db,
  conversationId: string,
  content: string,
  senderType: MessageQueueSenderType,
): Promise<string> {
  const rows = await db
    .insert(messageQueue)
    .values({
      conversationId,
      content,
      senderType,
      status: "pending",
    })
    .returning({ id: messageQueue.id });

  return rows[0]!.id;
}

/** Mensajes listos para procesar: status = "pending" y, si tienen
 *  `scheduled_for`, ya venció (o no tienen — se procesan de inmediato).
 *  Ordenados por antigüedad (FIFO) para no dejar mensajes viejos atrás. */
export async function getQueuedMessages(db: Db, limit = 10) {
  const now = new Date();
  return db
    .select()
    .from(messageQueue)
    .where(
      and(
        eq(messageQueue.status, "pending"),
        or(isNull(messageQueue.scheduledFor), lt(messageQueue.scheduledFor, now)),
      ),
    )
    .orderBy(asc(messageQueue.createdAt))
    .limit(limit);
}

/** Marca el resultado de procesar un mensaje de la cola (llamado por
 *  queue-processor.ts tras intentar el envío real). */
export async function markAsProcessed(
  db: Db,
  queueId: string,
  status: Extract<MessageQueueStatus, "sent" | "failed">,
  error?: string,
): Promise<void> {
  await db
    .update(messageQueue)
    .set({
      status,
      lastError: error ?? null,
      processedAt: new Date(),
    })
    .where(eq(messageQueue.id, queueId));
}
