import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { createDb } from "../../db/client";
import { notFound } from "../../lib/errors";
import { auth, requireAdmin, requireAuth, requireRole } from "../../middleware/auth";
import { createFaq, listFaqs, setFaqActive, updateFaq } from "../../repositories/faq.repo";
import type { AppBindings, Variables } from "../../env";

const STAFF = ["admin", "manager", "operator"] as const;

const faqRouter = new Hono<{ Bindings: AppBindings; Variables: Variables }>();

faqRouter.get(
  "/",
  auth,
  requireAuth,
  requireRole(...STAFF),
  zValidator("query", z.object({ includeInactive: z.string().optional() })),
  async (c) => {
    const db = createDb(c.env);
    const includeInactive = c.req.valid("query").includeInactive === "true";
    return c.json(await listFaqs(db, includeInactive));
  },
);

const faqBody = z.object({
  question: z.string().max(255).nullish(),
  answer: z.string().max(10000).nullish(),
  category: z.string().max(100).nullish(),
  displayOrder: z.number().int().nullish(),
  keywords: z.array(z.string()).nullish(),
  isActive: z.boolean().nullish(),
});

faqRouter.post(
  "/",
  auth,
  requireAuth,
  requireAdmin,
  zValidator("json", faqBody.extend({ question: z.string().min(1).max(255) })),
  async (c) => {
    const db = createDb(c.env);
    return c.json(await createFaq(db, c.req.valid("json")), 201);
  },
);

faqRouter.patch(
  "/:id",
  auth,
  requireAuth,
  requireRole(...STAFF),
  zValidator("json", faqBody),
  async (c) => {
    const db = createDb(c.env);
    const updated = await updateFaq(db, c.req.param("id"), c.req.valid("json"));
    if (!updated) throw notFound("Faq");
    return c.json(updated);
  },
);

faqRouter.delete("/:id", auth, requireAuth, requireAdmin, async (c) => {
  const db = createDb(c.env);
  const archived = await setFaqActive(db, c.req.param("id"), false);
  if (!archived) throw notFound("Faq");
  return c.json(archived);
});

faqRouter.post("/:id/restore", auth, requireAuth, requireAdmin, async (c) => {
  const db = createDb(c.env);
  const restored = await setFaqActive(db, c.req.param("id"), true);
  if (!restored) throw notFound("Faq");
  return c.json(restored);
});

export { faqRouter };
