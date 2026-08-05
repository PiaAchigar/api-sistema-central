// api-sistema-central/src/services/messaging.service.ts
import type { Db } from "../db/client";
import type { AppBindings } from "../env";
import { addAgentMessage, getConversationCore } from "../repositories/conversations.repo";
import { retryableWhatsAppSend } from "./whatsapp-retry.service";

/** Persiste la respuesta del agente/motor (igual que antes) y, si el canal de
 *  la conversación es whatsapp, además la manda de verdad por el Graph API
 *  con reintentos (Task 1 — confiabilidad WhatsApp: 3 intentos, backoff
 *  1s/5s/30s, solo errores temporales — ver whatsapp-retry.service).
 *  Best-effort: un fallo del envío real (token vencido, número no registrado,
 *  etc.) NO revierte el mensaje ya guardado ni se relanza — queda auditado en
 *  delivery_logs y, si se agotan los 3 intentos, dispara una alerta. */
export async function sendAgentReply(
  db: Db,
  env: AppBindings,
  conversationId: string,
  text: string,
) {
  const message = await addAgentMessage(db, conversationId, text);
  const conversation = await getConversationCore(db, conversationId);
  if (!conversation || conversation.channel !== "whatsapp" || !conversation.contactId) {
    return message;
  }

  try {
    const result = await retryableWhatsAppSend(
      db,
      env,
      conversation.contactId,
      conversationId,
      text,
      message.id,
    );
    if (!result.success) {
      console.error("[whatsapp] envío real falló tras reintentos (best-effort)", result.error);
    }
  } catch (err) {
    console.error("[whatsapp] envío real falló (best-effort)", err);
  }
  return message;
}
