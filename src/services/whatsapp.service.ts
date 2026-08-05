// api-sistema-central/src/services/whatsapp.service.ts
import { badGateway, unauthorized } from "../lib/errors";

export type WhatsAppCredentials = { accessToken: string; phoneNumberId: string };

/** Envía un mensaje de texto real por WhatsApp Cloud API (Meta Graph API).
 *  Lanza si Meta responde con error. whatsapp-retry.service (Task 1 —
 *  reintentos) necesita distinguir un 401 (token inválido/vencido, no tiene
 *  sentido reintentar) del resto de errores 4xx/5xx (temporales, sí se
 *  reintentan) — por eso el 401 se lanza con status 401 real en vez de
 *  envolverlo siempre en badGateway (502). El resto del comportamiento no
 *  cambia: mismo mensaje, mismo tipo de excepción (AppError/HTTPException). */
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
    const message = `WhatsApp Graph API error ${res.status}: ${body}`;
    if (res.status === 401) throw unauthorized(message);
    throw badGateway(message);
  }
}
