// api-sistema-central/src/routes/crm/conversations.ts
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { createDb } from "../../db/client";
import { badRequest, conflict, notFound } from "../../lib/errors";
import { requireAuth, requirePermission } from "../../middleware/auth";
import {
  addContactMessage,
  getConversationById,
  getConversationCore,
  getConversationWithMessages,
  listConversations,
  listMessagesAfter,
  listMessagesBefore,
  updateConversation,
  upsertConversation,
} from "../../repositories/conversations.repo";
import { decodeMessageCursor } from "../../lib/message-cursor";
import { runAutomations } from "../../services/automation.service";
import { sendAgentReply } from "../../services/messaging.service";
import {
  createConversationBody,
  listConversationsQuery,
  listMessagesQuery,
  patchConversationBody,
  sendMessageBody,
} from "./conversations.schema";
import type { AppBindings, Variables } from "../../env";

const conversationsRouter = new Hono<{ Bindings: AppBindings; Variables: Variables }>();

conversationsRouter.get(
  "/",
  requireAuth,
  requirePermission("crm", "view"),
  zValidator("query", listConversationsQuery),
  async (c) => {
    const db = createDb(c.env);
    return c.json(await listConversations(db, c.req.valid("query")));
  },
);

conversationsRouter.get("/:id", requireAuth, requirePermission("crm", "view"), async (c) => {
  const db = createDb(c.env);
  const result = await getConversationWithMessages(db, c.req.param("id"));
  if (!result) throw notFound("Conversation");
  return c.json(result);
});

conversationsRouter.post(
  "/",
  requireAuth,
  requirePermission("crm", "edit"),
  zValidator("json", createConversationBody),
  async (c) => {
    const db = createDb(c.env);
    const conv = await upsertConversation(db, c.req.valid("json"));
    return c.json(conv, 201);
  },
);

conversationsRouter.post(
  "/:id/messages",
  requireAuth,
  requirePermission("crm", "edit"),
  zValidator("json", sendMessageBody),
  async (c) => {
    const db = createDb(c.env);
    const id = c.req.param("id");
    if (!(await getConversationById(db, id))) throw notFound("Conversation");
    const msg = await sendAgentReply(db, c.env, id, c.req.valid("json").content);
    return c.json(msg, 201);
  },
);

conversationsRouter.get(
  "/:id/messages",
  requireAuth,
  requirePermission("crm", "view"),
  zValidator("query", listMessagesQuery),
  async (c) => {
    const db = createDb(c.env);
    const id = c.req.param("id");
    if (!(await getConversationById(db, id))) throw notFound("Conversation");
    const { before, after, limit } = c.req.valid("query");
    // Se valida el formato del cursor acá, aparte, para no envolver la
    // llamada al repositorio en el mismo try/catch — si no, un error real
    // de base de datos quedaría enmascarado como "Cursor inválido" (400)
    // en vez de propagarse como el 500 que realmente es.
    if (before !== undefined) {
      try {
        decodeMessageCursor(before);
      } catch {
        throw badRequest("Cursor inválido");
      }
      return c.json(await listMessagesBefore(db, id, before, limit));
    }
    // El refine de listMessagesQuery garantiza que acá `after` está
    // definido (antes vino undefined). Puede venir vacío ("") para "sin
    // cursor todavía" — se trata como null.
    const afterCursor = after ?? "";
    if (afterCursor !== "") {
      try {
        decodeMessageCursor(afterCursor);
      } catch {
        throw badRequest("Cursor inválido");
      }
    }
    return c.json(await listMessagesAfter(db, id, afterCursor === "" ? null : afterCursor, limit));
  },
);

conversationsRouter.patch(
  "/:id",
  requireAuth,
  requirePermission("crm", "edit"),
  zValidator("json", patchConversationBody),
  async (c) => {
    const db = createDb(c.env);
    const updated = await updateConversation(db, c.req.param("id"), c.req.valid("json"));
    if (!updated) throw notFound("Conversation");
    return c.json(updated);
  },
);

// Herramienta de prueba (y en Fase 6 lo hace el webhook): simula un mensaje
// entrante del contacto y dispara el motor de automatización.
conversationsRouter.post(
  "/:id/simulate-inbound",
  requireAuth,
  requirePermission("crm", "manage"),
  zValidator("json", z.object({ content: z.string().min(1) })),
  async (c) => {
    const db = createDb(c.env);
    const id = c.req.param("id");
    const conv = await getConversationCore(db, id);
    if (!conv) throw notFound("Conversation");
    const msg = await addContactMessage(db, id, c.req.valid("json").content);
    if (!msg) throw conflict("Mensaje duplicado");
    await runAutomations(db, c.env, {
      type: "incoming_message",
      conversationId: id,
      contactId: conv.contactId,
      channel: conv.channel,
      text: c.req.valid("json").content,
    });
    return c.json(msg, 201);
  },
);

export { conversationsRouter };
