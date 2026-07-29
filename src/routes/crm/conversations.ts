// api-sistema-central/src/routes/crm/conversations.ts
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { createDb } from "../../db/client";
import { notFound } from "../../lib/errors";
import { requireAuth, requirePermission } from "../../middleware/auth";
import {
  addAgentMessage,
  getConversationById,
  getConversationWithMessages,
  listConversations,
  updateConversation,
  upsertConversation,
} from "../../repositories/conversations.repo";
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

export { conversationsRouter };
