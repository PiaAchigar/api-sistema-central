// api-sistema-central/src/services/delivery-logger.service.ts
import type { Db } from "../db/client";
import { deliveryLogs } from "../db/schema";

export interface DeliveryLogInput {
  conversationId: string;
  contactId?: string;
  messageId?: string;
  channel: string;
  status: "success" | "failed" | "retry";
  metaErrorCode?: number;
  metaErrorMessage?: string;
  retryAttempt: number;
  httpStatusCode: number;
}

/** Audita un intento de envío (whatsapp-retry.service llama esto en cada
 *  intento del backoff). No hay `db` global en este Worker — cada request
 *  crea su propia conexión vía Hyperdrive (ver db/client.ts) — por eso `db`
 *  se recibe como parámetro, igual que el resto de los repos/servicios. */
export async function logDelivery(db: Db, input: DeliveryLogInput): Promise<string> {
  const rows = await db
    .insert(deliveryLogs)
    .values({
      conversationId: input.conversationId,
      contactId: input.contactId,
      messageId: input.messageId,
      channel: input.channel,
      status: input.status,
      metaErrorCode: input.metaErrorCode,
      metaErrorMessage: input.metaErrorMessage,
      retryAttempt: input.retryAttempt,
      httpStatusCode: input.httpStatusCode,
    })
    .returning({ id: deliveryLogs.id });

  return rows[0]!.id;
}
