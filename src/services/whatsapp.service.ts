// api-sistema-central/src/services/whatsapp.service.ts
import { badGateway } from "../lib/errors";

export type WhatsAppCredentials = { accessToken: string; phoneNumberId: string };

/** Envía un mensaje de texto real por WhatsApp Cloud API (Meta Graph API).
 *  Lanza si Meta responde con error — el llamador (sendAgentReply) lo trata
 *  best-effort: no hay reintentos ni cola en v1. Sin harness para mockear el
 *  Graph API real en este proyecto — se verifica con tsc + QA manual con el
 *  número de test de Meta (igual que el resto del CRM). */
export async function sendWhatsAppText(
  credentials: WhatsAppCredentials,
  to: string,
  text: string,
): Promise<void> {
  const res = await fetch(`https://graph.facebook.com/v22.0/${credentials.phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${credentials.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text },
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw badGateway(`WhatsApp Graph API error ${res.status}: ${body}`);
  }
}
