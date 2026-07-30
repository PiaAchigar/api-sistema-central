// api-sistema-central/src/services/messaging.service.ts
import type { Db } from "../db/client";
import type { AppBindings } from "../env";
import { getChannelByType } from "../repositories/channels.repo";
import { addAgentMessage, getConversationCore } from "../repositories/conversations.repo";
import { getContactById } from "../repositories/contacts.repo";
import { decrypt } from "./crypto.service";
import { sendWhatsAppText } from "./whatsapp.service";

/** Persiste la respuesta del agente/motor (igual que antes) y, si el canal de
 *  la conversación es whatsapp, además la manda de verdad por el Graph API.
 *  Best-effort: un fallo del envío real (token vencido, número no registrado,
 *  etc.) NO revierte el mensaje ya guardado ni se relanza — se loguea nomás. */
export async function sendAgentReply(
  db: Db,
  env: AppBindings,
  conversationId: string,
  text: string,
) {
  const message = await addAgentMessage(db, conversationId, text);
  const conversation = await getConversationCore(db, conversationId);
  if (!conversation || conversation.channel !== "whatsapp") return message;

  try {
    const contact = conversation.contactId
      ? await getContactById(db, conversation.contactId)
      : null;
    const channel = await getChannelByType(db, "whatsapp");
    if (!contact?.whatsappId || !channel?.encryptedCredentials) return message;
    const credsJson = await decrypt(channel.encryptedCredentials, env.CREDENTIALS_ENCRYPTION_KEY);
    const creds = JSON.parse(credsJson) as { accessToken: string; phoneNumberId: string };
    await sendWhatsAppText(
      { accessToken: creds.accessToken, phoneNumberId: creds.phoneNumberId },
      contact.whatsappId,
      text,
    );
  } catch (err) {
    console.error("[whatsapp] envío real falló (best-effort)", err);
  }
  return message;
}
