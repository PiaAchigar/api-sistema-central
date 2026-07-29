import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
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
import { contactInput, listQuery } from "./contacts.schema";

const contactsRouter = new Hono<{ Bindings: AppBindings; Variables: Variables }>();

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
