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
import { getCustomerByContactId } from "../../repositories/customers.repo";
import { listDealsByContactId } from "../../repositories/deals.repo";
import { listAppointmentsByContactId } from "../../repositories/appointments.repo";
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

contactsRouter.get(
  "/:id",
  requireAuth,
  requirePermission("crm", "view"),
  async (c) => {
    const db = createDb(c.env);
    const id = c.req.param("id");
    const contact = await getContactById(db, id);
    if (!contact) throw notFound("Contact");

    const [customer, deals, appointments] = await Promise.all([
      getCustomerByContactId(db, id),
      listDealsByContactId(db, id),
      listAppointmentsByContactId(db, id),
    ]);

    return c.json({ contact, customer, deals, appointments });
  },
);

export { contactsRouter };
