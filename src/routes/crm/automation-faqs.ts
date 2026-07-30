import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { createDb } from "../../db/client";
import { notFound } from "../../lib/errors";
import { requireAuth, requirePermission } from "../../middleware/auth";
import {
  createFaq,
  deleteFaq,
  listFaqs,
  updateFaq,
} from "../../repositories/automation-faqs.repo";
import { faqBody } from "./automation-faqs.schema";
import type { AppBindings, Variables } from "../../env";

const automationFaqsRouter = new Hono<{ Bindings: AppBindings; Variables: Variables }>();

automationFaqsRouter.get("/", requireAuth, requirePermission("crm", "view"), async (c) => {
  const db = createDb(c.env);
  return c.json(await listFaqs(db));
});

automationFaqsRouter.post(
  "/",
  requireAuth,
  requirePermission("crm", "manage"),
  zValidator("json", faqBody),
  async (c) => {
    const db = createDb(c.env);
    const b = c.req.valid("json");
    const faq = await createFaq(db, {
      question: b.question ?? null,
      answer: b.answer,
      keywords: b.keywords,
      isActive: b.isActive ?? true,
    });
    return c.json(faq, 201);
  },
);

automationFaqsRouter.patch(
  "/:id",
  requireAuth,
  requirePermission("crm", "manage"),
  zValidator("json", faqBody),
  async (c) => {
    const db = createDb(c.env);
    const b = c.req.valid("json");
    const updated = await updateFaq(db, c.req.param("id"), {
      question: b.question ?? null,
      answer: b.answer,
      keywords: b.keywords,
      isActive: b.isActive ?? true,
    });
    if (!updated) throw notFound("Faq");
    return c.json(updated);
  },
);

automationFaqsRouter.delete("/:id", requireAuth, requirePermission("crm", "manage"), async (c) => {
  const db = createDb(c.env);
  const deleted = await deleteFaq(db, c.req.param("id"));
  if (!deleted) throw notFound("Faq");
  return c.json({ ok: true });
});

export { automationFaqsRouter };
