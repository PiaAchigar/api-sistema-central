// api-sistema-central/src/workers/queue-processor.ts
//
// Procesa `message_queue` (Task 2 — confiabilidad WhatsApp). Se dispara desde
// el cron trigger en index.ts (ver wrangler.toml — cron "* * * * *", cada
// minuto: es la granularidad mínima que soporta Cloudflare Cron Triggers, no
// existe cron por segundos). Cada corrida toma hasta MAX_MESSAGES_PER_RUN
// mensajes pendientes — con cron cada 1 min y 10 mensajes por corrida, el
// worst case es 10 msgs/min, exactamente el rate limit de automatizaciones
// pedido en el plan (no los "cada 10 segundos" del enunciado original, que
// con Cloudflare Cron Triggers habría implicado 60 msgs/min — violaría el
// límite).
//
// El envío real (con reintentos 1s/5s/30s y auditoría en delivery_logs) lo
// hace íntegramente `retryableWhatsAppSend` (Task 1) — no hace falta resolver
// canal/credenciales acá, ya lo hace esa función.
import type { Db } from "../db/client";
import type { AppBindings } from "../env";
import { getConversationCore } from "../repositories/conversations.repo";
import { getQueuedMessages, markAsProcessed } from "../services/message-queue.service";
import { retryableWhatsAppSend } from "../services/whatsapp-retry.service";

const MAX_MESSAGES_PER_RUN = 10; // 10 msgs/min con cron de 1 min — respeta el rate limit de automatizaciones

export interface ProcessMessageQueueResult {
  processed: number;
  failed: number;
}

export async function processMessageQueue(
  db: Db,
  env: AppBindings,
): Promise<ProcessMessageQueueResult> {
  const messages = await getQueuedMessages(db, MAX_MESSAGES_PER_RUN);

  let processed = 0;
  let failed = 0;

  for (const msg of messages) {
    try {
      const conversation = await getConversationCore(db, msg.conversationId);
      if (!conversation || !conversation.contactId) {
        await markAsProcessed(db, msg.id, "failed", "Conversación o contacto no encontrado");
        failed++;
        continue;
      }

      const result = await retryableWhatsAppSend(
        db,
        env,
        conversation.contactId,
        msg.conversationId,
        msg.content,
      );

      if (result.success) {
        await markAsProcessed(db, msg.id, "sent");
        processed++;
      } else {
        await markAsProcessed(db, msg.id, "failed", result.error);
        failed++;
      }
    } catch (err) {
      console.error("[queue-processor] Fallo procesando mensaje de la cola:", msg.id, err);
      await markAsProcessed(db, msg.id, "failed", err instanceof Error ? err.message : String(err));
      failed++;
    }
  }

  return { processed, failed };
}
