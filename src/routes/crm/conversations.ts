// api-sistema-central/src/routes/crm/conversations.ts
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { createDb } from "../../db/client";
import { conflict, notFound } from "../../lib/errors";
import { requireAuth, requirePermission } from "../../middleware/auth";
import {
  addAgentMessage,
  addContactMessage,
  getConversationById,
  getConversationCore,
  getConversationWithMessages,
  listConversations,
  updateConversation,
  upsertConversation,
} from "../../repositories/conversations.repo";
import { runAutomations } from "../../services/automation.service";
import {
  createConversationBody,
  listConversationsQuery,
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
    const msg = await addAgentMessage(db, id, c.req.valid("json").content);
    return c.json(msg, 201);
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
    await runAutomations(db, {
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
