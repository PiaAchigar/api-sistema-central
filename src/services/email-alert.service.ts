// api-sistema-central/src/services/email-alert.service.ts
import type { AppBindings } from "../env";

export interface AlertEmailParams {
  subject: string;
  to: string;
  html: string;
  contactId?: string;
  conversationId?: string;
  errorCode?: number;
}

export const ALERT_EMAIL_ADDRESS = "complexa.ia@gmail.com";

type EmailEnv = Pick<AppBindings, "RESEND_API_KEY" | "ALERT_EMAIL_FROM">;

/**
 * Envía un email de alerta. Best-effort: nunca lanza — un fallo del email
 * no debe tumbar el flujo que lo dispara (ver `whatsapp-retry.service.ts`,
 * único caller hoy).
 *
 * Este Worker corre en el runtime de Cloudflare Workers, no en Node — por
 * eso esta implementación NO usa `nodemailer` ni SMTP:
 * - No hay `process.env`: las variables llegan por el binding `env` de cada
 *   request (ver `src/env.ts`), así que `env` se recibe como parámetro
 *   explícito, igual que el resto de los servicios de este proyecto.
 * - No hay sockets TCP crudos disponibles sin el binding `cloudflare:sockets`
 *   (no configurado acá) — el transporte SMTP de `nodemailer` no funciona en
 *   este entorno tal cual. Por eso se usa la API HTTP de Resend
 *   (https://resend.com/docs/api-reference/emails/send-email) vía `fetch`,
 *   que sí es 100% compatible con Workers.
 *
 * **Proveedor real: pendiente.** Sin `env.RESEND_API_KEY` configurado (hoy
 * es el caso — no hay proveedor de email dado de alta), esta función cae a
 * un log de servidor con tag `[ALERT]`, grepeable en los logs de Cloudflare,
 * con el mismo contenido que se hubiera mandado por mail. Es el placeholder
 * documentado en el plan ("No real SMTP provider is configured yet").
 *
 * Setup real pendiente (ver DOCUMENTACION_BD.md § DELIVERY_LOGS):
 *   wrangler secret put RESEND_API_KEY
 *   wrangler secret put ALERT_EMAIL_FROM   (opcional, default abajo)
 */
export async function sendAlertEmail(params: AlertEmailParams, env?: EmailEnv): Promise<void> {
  const apiKey = env?.RESEND_API_KEY;

  if (!apiKey) {
    console.error(
      "[email-alert][ALERT] Sin proveedor de email configurado (falta RESEND_API_KEY) — alerta solo logueada, no enviada",
      {
        to: params.to,
        subject: params.subject,
        contactId: params.contactId,
        conversationId: params.conversationId,
        errorCode: params.errorCode,
        at: new Date().toISOString(),
      },
    );
    return;
  }

  try {
    const from = env?.ALERT_EMAIL_FROM || "Piubella CRM <onboarding@resend.dev>";
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [params.to],
        subject: params.subject,
        html: params.html,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error("[email-alert] Resend respondió con error", res.status, body);
      return;
    }

    const data = (await res.json().catch(() => null)) as { id?: string } | null;
    console.log("[email-alert] Alert email sent", data?.id);
  } catch (err) {
    // No relanza — el email no es crítico, solo logging.
    console.error("[email-alert] Failed to send alert email (best-effort)", err);
  }
}
