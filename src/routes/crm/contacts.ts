import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { createDb } from "../../db/client";
import { badRequest, notFound } from "../../lib/errors";
import { isForeignKeyViolation } from "../../lib/db-errors";
import { requireAdmin, requireAuth, requirePermission } from "../../middleware/auth";
import {
  createContact,
  getContactById,
  hardDeleteClient,
  listContacts,
  updateContact,
} from "../../repositories/contacts.repo";
import {
  getClientDeleteImpact,
  getCustomerByContactId,
} from "../../repositories/customers.repo";
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

// Impacto del borrado: qué historial tiene el cliente y si se puede borrar.
// Solo admin — es el paso previo al DELETE /:id/permanent.
contactsRouter.get(
  "/:id/delete-impact",
  requireAuth,
  requireAdmin,
  async (c) => {
    const db = createDb(c.env);
    const id = c.req.param("id");
    const contact = await getContactById(db, id);
    if (!contact) throw notFound("Contact");
    return c.json(await getClientDeleteImpact(db, id));
  },
);

// Borrado permanente. Solo admin. Se vuelve a calcular el impacto acá aunque el
// front ya lo haya consultado: entre el preview y la confirmación puede haberle
// entrado una factura, y el front nunca decide si algo es borrable.
contactsRouter.delete(
  "/:id/permanent",
  requireAuth,
  requireAdmin,
  async (c) => {
    const db = createDb(c.env);
    const id = c.req.param("id");
    const contact = await getContactById(db, id);
    if (!contact) throw notFound("Contact");

    const impact = await getClientDeleteImpact(db, id);
    if (impact.blocked) throw badRequest(impact.blockReason!);

    try {
      await hardDeleteClient(db, id);
    } catch (err) {
      // Última red: si apareció una referencia que el impacto no contempla,
      // Postgres la rechaza y acá se traduce a un mensaje entendible.
      if (isForeignKeyViolation(err)) {
        throw badRequest(
          "No se puede eliminar: apareció una referencia nueva justo ahora. Archivalo en su lugar.",
        );
      }
      throw err;
    }
    return c.json({ deleted: true });
  },
);

export { contactsRouter };
