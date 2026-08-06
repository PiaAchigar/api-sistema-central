import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { createDb } from "../../db/client";
import { conflict, notFound } from "../../lib/errors";
import {
  createQuickCustomer,
  findCustomerByDni,
  getCustomerById,
  listRecentCustomers,
  searchCustomers,
} from "../../repositories/customers.repo";
import { listInvoices } from "../../repositories/invoices.repo";
import { getCustomerDayStatus } from "../../services/account-status.service";
import type { AppBindings } from "../../env";

const customersRouter = new Hono<{ Bindings: AppBindings }>();

customersRouter.get(
  "/",
  zValidator(
    "query",
    z.object({
      q: z.string().max(100).optional(),
      // Sin `limit` devuelve los 20 más recientes (autocompletar del facturador).
      // El selector de cliente de Suscripciones necesita la lista completa, así
      // que pide un limit alto explícitamente.
      limit: z.coerce.number().int().min(1).max(1000).optional(),
    }),
  ),
  async (c) => {
    const db = createDb(c.env);
    const { q, limit } = c.req.valid("query");
    const rows = q ? await searchCustomers(db, q) : await listRecentCustomers(db, limit);
    return c.json(rows);
  },
);

// OJO: registrado antes de "/:id" para que "day-status" no matchee como id.
customersRouter.get(
  "/day-status",
  zValidator("query", z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) })),
  async (c) => {
    const db = createDb(c.env);
    return c.json(await getCustomerDayStatus(db, c.req.valid("query").date));
  },
);

const createBody = z.object({
  name: z.string().min(2).max(255),
  dni: z.string().regex(/^\d{7,8}$/, "DNI de 7 u 8 dígitos"),
  phone: z.string().max(50).optional(),
  email: z.string().email().optional(),
});

customersRouter.post("/", zValidator("json", createBody), async (c) => {
  const db = createDb(c.env);
  const data = c.req.valid("json");
  // El DNI filtra duplicados (regla del negocio: no repetir personas)
  const existing = await findCustomerByDni(db, data.dni);
  if (existing) throw conflict("Ya existe un cliente con ese DNI");

  const { customerId } = await createQuickCustomer(db, data);
  const customer = await getCustomerById(db, customerId);
  return c.json(customer, 201);
});

customersRouter.get("/:id", async (c) => {
  const db = createDb(c.env);
  const customer = await getCustomerById(db, c.req.param("id"));
  if (!customer) throw notFound("Customer");
  return c.json(customer);
});

customersRouter.get("/:id/invoices", async (c) => {
  const db = createDb(c.env);
  const rows = await listInvoices(db, { customerId: c.req.param("id") });
  return c.json(
    rows.map((r) => ({
      ...r,
      totalAmount: r.totalAmount != null ? Number(r.totalAmount) : null,
    })),
  );
});

export { customersRouter };
