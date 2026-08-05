// api-sistema-central/src/services/whatsapp-retry.service.ts
import type { Db } from "../db/client";
import type { AppBindings } from "../env";
import { getChannelByType } from "../repositories/channels.repo";
import { getContactById } from "../repositories/contacts.repo";
import { decrypt } from "./crypto.service";
import { logDelivery } from "./delivery-logger.service";
import { ALERT_EMAIL_ADDRESS, sendAlertEmail } from "./email-alert.service";
import { sendWhatsAppText } from "./whatsapp.service";

const RETRY_ATTEMPTS = 3;
const BACKOFF_MS = [1000, 5000, 30000]; // 1s, 5s, 30s

export interface RetryResult {
  success: boolean;
  deliveryLogId?: string;
  error?: string;
  lastHttpStatus?: number;
}

/** Envía un WhatsApp con reintentos: máximo 3 intentos, backoff exponencial
 *  1s → 5s → 30s. Solo reintenta errores temporales (4xx/5xx) — un 401
 *  (token inválido/vencido) corta al toque, reintentarlo no cambia nada.
 *  Cada intento (éxito, fallo, reintento) queda auditado en `delivery_logs`
 *  vía logDelivery. Si se agotan los 3 intentos, dispara una alerta
 *  best-effort (ver sendFailureAlert) a complexa.ia@gmail.com.
 *
 *  `conversationId` es obligatorio porque `delivery_logs.conversation_id`
 *  tiene FK NOT NULL (migración 1.21.0) — a diferencia de `messageId`, que
 *  es opcional y solo sirve para correlacionar el intento con un mensaje
 *  puntual de la tabla `messages`. */
export async function retryableWhatsAppSend(
  db: Db,
  env: AppBindings,
  contactId: string,
  conversationId: string,
  content: string,
  messageId?: string,
): Promise<RetryResult> {
  const contact = await getContactById(db, contactId);
  if (!contact?.whatsappId) {
    return { success: false, error: "Contacto sin whatsappId — no se puede enviar por WhatsApp" };
  }

  const channel = await getChannelByType(db, "whatsapp");
  if (!channel?.encryptedCredentials) {
    return { success: false, error: "Canal whatsapp sin credenciales configuradas" };
  }

  const credsJson = await decrypt(channel.encryptedCredentials, env.CREDENTIALS_ENCRYPTION_KEY);
  const creds = JSON.parse(credsJson) as { accessToken: string; phoneNumberId: string };

  let lastError = "";
  let lastHttpStatus = 0;

  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    try {
      await sendWhatsAppText(creds, contact.whatsappId, content);

      // Éxito — log y return.
      const deliveryLogId = await logDelivery(db, {
        conversationId,
        contactId,
        messageId,
        channel: "whatsapp",
        status: "success",
        retryAttempt: attempt,
        httpStatusCode: 200,
      });

      return { success: true, deliveryLogId };
    } catch (err: unknown) {
      const httpStatus = httpStatusOf(err);
      lastError = messageOf(err);
      lastHttpStatus = httpStatus;

      // 401 = token inválido, no reintentar.
      if (httpStatus === 401) {
        await logDelivery(db, {
          conversationId,
          contactId,
          messageId,
          channel: "whatsapp",
          status: "failed",
          metaErrorCode: 401,
          metaErrorMessage: "Unauthorized - Invalid access token",
          retryAttempt: attempt,
          httpStatusCode: 401,
        });

        return {
          success: false,
          error: "Invalid access token (401) — not retrying",
          lastHttpStatus: 401,
        };
      }

      // Si no es el último intento, esperar backoff y reintentar.
      if (attempt < RETRY_ATTEMPTS) {
        const waitMs = BACKOFF_MS[attempt - 1]!;
        await logDelivery(db, {
          conversationId,
          contactId,
          messageId,
          channel: "whatsapp",
          status: "retry",
          metaErrorCode: httpStatus,
          metaErrorMessage: lastError,
          retryAttempt: attempt,
          httpStatusCode: httpStatus,
        });

        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }

      // Último intento falló.
      await logDelivery(db, {
        conversationId,
        contactId,
        messageId,
        channel: "whatsapp",
        status: "failed",
        metaErrorCode: httpStatus,
        metaErrorMessage: lastError,
        retryAttempt: attempt,
        httpStatusCode: httpStatus,
      });
    }
  }

  // Falló tras 3 reintentos.
  await sendFailureAlert(env, contactId, conversationId, lastError, lastHttpStatus);

  return {
    success: false,
    error: `Failed after ${RETRY_ATTEMPTS} attempts: ${lastError}`,
    lastHttpStatus,
  };
}

function httpStatusOf(err: unknown): number {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : 500;
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Task 3 — confiabilidad WhatsApp: dispara la alerta por email cuando un
 *  envío se agotó tras los 3 reintentos (nunca se llama para un 401 corto —
 *  ver el `return` temprano más arriba: token vencido no alerta, el usuario
 *  ya sabe que tiene que actualizar credenciales).
 *
 *  Único call site: tanto `sendAgentReply` (messaging.service.ts) como
 *  `processMessageQueue` (workers/queue-processor.ts, Task 2) pasan por
 *  `retryableWhatsAppSend`, así que centralizar la alerta acá evita
 *  duplicarla en cada caller.
 *
 *  Best-effort vía `sendAlertEmail` (email-alert.service.ts) — no relanza:
 *  un fallo de alerta no debe tumbar el request que la dispara. Sin
 *  proveedor de email configurado (`env.RESEND_API_KEY`), cae a un log de
 *  servidor con tag [ALERT]. */
async function sendFailureAlert(
  env: AppBindings,
  contactId: string,
  conversationId: string,
  error: string,
  lastHttpStatus: number,
): Promise<void> {
  await sendAlertEmail(
    {
      subject: "❌ WhatsApp Send Failed — Check Cloudflare Logs",
      to: ALERT_EMAIL_ADDRESS,
      html: `
        <div style="font-family: sans-serif; padding: 20px;">
          <h2>⚠️ WhatsApp Message Send Failed</h2>

          <div style="background: #f8f9fa; padding: 15px; border-radius: 5px; margin: 15px 0;">
            <p><strong>Contact:</strong> ${contactId}</p>
            <p><strong>Conversation:</strong> ${conversationId}</p>
            <p><strong>HTTP Status:</strong> ${lastHttpStatus}</p>
            <p><strong>Error:</strong> ${error}</p>
          </div>

          <h3>What happened?</h3>
          <p>A message failed to send after ${RETRY_ATTEMPTS} retry attempts with exponential backoff (1s → 5s → 30s).</p>

          <h3>Next steps:</h3>
          <ol>
            <li><strong>Check Cloudflare Worker logs:</strong>
              <a href="https://dash.cloudflare.com/workers/view/piubella-worker/logs">Cloudflare Dashboard</a>
            </li>
            <li><strong>Verify Meta Cloud API credentials:</strong>
              <a href="https://developers.facebook.com/apps">Facebook Developers</a>
            </li>
            <li><strong>Check rate limits:</strong>
              Meta rate limits 50+ msgs/min per phone number. Is traffic spiking?
            </li>
          </ol>

          <p style="color: #666; font-size: 12px; margin-top: 30px;">
            Sent at ${new Date().toISOString()}
          </p>
        </div>
      `,
      contactId,
      conversationId,
      errorCode: lastHttpStatus,
    },
    env,
  );
}
