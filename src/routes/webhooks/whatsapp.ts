import { Hono, type ExecutionContext } from "hono";
import { createDb, type Db } from "../../db/client";
import { getChannelByType } from "../../repositories/channels.repo";
import { createContact, getContactByWhatsappId } from "../../repositories/contacts.repo";
import { addContactMessage, upsertConversation } from "../../repositories/conversations.repo";
import { decrypt } from "../../services/crypto.service";
import { runAutomations } from "../../services/automation.service";
import type { AppBindings } from "../../env";
import {
  extractIncomingMessage,
  parseHandshakeQuery,
  verifyWhatsAppSignature,
} from "./whatsapp.util";

type WhatsAppCredentials = {
  accessToken: string;
  phoneNumberId: string;
  appSecret: string;
  verifyToken: string;
};

async function getWhatsAppCredentials(
  db: Db,
  env: AppBindings,
): Promise<WhatsAppCredentials | null> {
  const channel = await getChannelByType(db, "whatsapp");
  if (!channel?.encryptedCredentials) return null;
  const json = await decrypt(channel.encryptedCredentials, env.CREDENTIALS_ENCRYPTION_KEY);
  return JSON.parse(json) as WhatsAppCredentials;
}

/** Wrapper defensivo: `getWhatsAppCredentials` puede tirar (p.ej.
 *  CREDENTIALS_ENCRYPTION_KEY mal configurada, o ciphertext corrupto en la
 *  fila guardada). Un endpoint público no debe devolver 500 por esto — se
 *  loguea server-side y se trata como "sin credenciales" para el caller. */
async function safeGetWhatsAppCredentials(
  db: Db,
  env: AppBindings,
): Promise<WhatsAppCredentials | null> {
  try {
    return await getWhatsAppCredentials(db, env);
  } catch (err) {
    console.error("[whatsapp webhook] no se pudieron leer/desencriptar las credenciales", err);
    return null;
  }
}

async function processIncomingMessage(
  db: Db,
  env: AppBindings,
  executionCtx: ExecutionContext,
  incoming: { from: string; waId: string; text: string },
) {
  let contact = await getContactByWhatsappId(db, incoming.from);
  if (!contact) {
    contact = await createContact(db, {
      name: incoming.from,
      phone: incoming.from,
      whatsappId: incoming.from,
      status: "prospect",
    });
  }
  const conversation = await upsertConversation(db, { contactId: contact.id, channel: "whatsapp" });
  const msg = await addContactMessage(db, conversation.id, incoming.text, incoming.waId);
  if (msg) {
    executionCtx.waitUntil(
      runAutomations(db, env, {
        type: "incoming_message",
        conversationId: conversation.id,
        contactId: contact.id,
        channel: "whatsapp",
        text: incoming.text,
      }),
    );
  }
}

const whatsappWebhookRouter = new Hono<{ Bindings: AppBindings }>();

// Handshake de verificación: Meta lo llama al configurar/guardar la URL del
// webhook. Responde el challenge en texto plano si el verify_token coincide.
whatsappWebhookRouter.get("/", async (c) => {
  const db = createDb(c.env);
  const creds = await safeGetWhatsAppCredentials(db, c.env);
  const parsedQuery = parseHandshakeQuery({
    "hub.mode": c.req.query("hub.mode"),
    "hub.verify_token": c.req.query("hub.verify_token"),
    "hub.challenge": c.req.query("hub.challenge"),
  });
  if (!creds || !parsedQuery || parsedQuery["hub.verify_token"] !== creds.verifyToken) {
    return c.text("Forbidden", 403);
  }
  return c.text(parsedQuery["hub.challenge"]);
});

// Mensaje entrante real. Responde 200 apenas persiste — el motor de
// automatización (con su delay de 5s) corre en segundo plano vía waitUntil
// para no hacer esperar a Meta (que reintenta si no hay 200 rápido). Meta
// puede batchear varios mensajes en un solo webhook call, así que se procesa
// cada uno del array antes de responder.
whatsappWebhookRouter.post("/", async (c) => {
  const db = createDb(c.env);
  const creds = await safeGetWhatsAppCredentials(db, c.env);
  const rawBody = await c.req.text();
  const signatureOk =
    creds && (await verifyWhatsAppSignature(rawBody, c.req.header("X-Hub-Signature-256"), creds.appSecret));
  if (!signatureOk) return c.text("Unauthorized", 401);

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    // Body no-JSON pese a firma válida: nada que procesar, y no tiene sentido
    // que Meta reintente algo que nunca va a parsear distinto.
    return c.text("OK", 200);
  }

  const incomingMessages = extractIncomingMessage(payload);
  for (const incoming of incomingMessages) {
    await processIncomingMessage(db, c.env, c.executionCtx, incoming);
  }
  return c.text("OK", 200);
});

export { whatsappWebhookRouter };
