import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { createDb } from "../../db/client";
import { notFound } from "../../lib/errors";
import { requireAuth, requirePermission } from "../../middleware/auth";
import {
  createContact,
  getContactById,
  listContacts,
  updateContact,
} from "../../repositories/contacts.repo";
import type { AppBindings, Variables } from "../../env";

const contactsRouter = new Hono<{ Bindings: AppBindings; Variables: Variables }>();

const STATUS = ["prospect", "customer", "inactive"] as const;

const listQuery = z.object({
  status: z.enum(STATUS).optional(),
  q: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const contactInput = z.object({
  name: z.string().min(1),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  status: z.enum(STATUS).default("prospect"),
  notes: z.string().optional(),
});

contactsRouter.get(
  "/",
  requireAuth,
  requirePermission("crm", "view"),
  zValidator("query", listQuery),
  async (c) => {
    const db = createDb(c.env);
    const filters = c.req.valid("query");
    return c.json(await listContacts(db, filters));
  },
);

contactsRouter.post(
  "/",
  requireAuth,
  requirePermission("crm", "edit"),
  zValidator("json", contactInput),
  async (c) => {
    const db = createDb(c.env);
    const body = c.req.valid("json");
    return c.json(await createContact(db, body), 201);
  },
);

contactsRouter.patch(
  "/:id",
  requireAuth,
  requirePermission("crm", "edit"),
  zValidator("json", contactInput.partial()),
  async (c) => {
    const db = createDb(c.env);
    const id = c.req.param("id");
    const existing = await getContactById(db, id);
    if (!existing) throw notFound("Contact");
    return c.json(await updateContact(db, id, c.req.valid("json")));
  },
);

export { contactsRouter };
