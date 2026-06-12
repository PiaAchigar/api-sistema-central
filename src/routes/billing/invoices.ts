import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { createArcaClient } from "../../arca/factory";
import { createDb } from "../../db/client";
import {
  cancelInvoice,
  createDraftInvoice,
  emitBatch,
  emitInvoice,
  getInvoiceDetail,
  listInvoices,
} from "../../services/invoicing.service";
import type { AppBindings } from "../../env";

const invoicesRouter = new Hono<{ Bindings: AppBindings }>();

const listQuery = z.object({
  status: z.enum(["draft", "emitted", "paid", "cancelled"]).optional(),
  customerId: z.string().uuid().optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

invoicesRouter.get("/", zValidator("query", listQuery), async (c) => {
  const db = createDb(c.env);
  const q = c.req.valid("query");
  const rows = await listInvoices(db, {
    status: q.status,
    customerId: q.customerId,
    from: q.from ? new Date(`${q.from}T00:00:00-03:00`) : undefined,
    to: q.to ? new Date(`${q.to}T23:59:59-03:00`) : undefined,
  });
  return c.json(
    rows.map((r) => ({
      ...r,
      subtotal: r.subtotal != null ? Number(r.subtotal) : null,
      totalAmount: r.totalAmount != null ? Number(r.totalAmount) : null,
    })),
  );
});

const createBody = z.object({
  customerId: z.string().uuid(),
  items: z
    .array(
      z
        .object({
          serviceId: z.string().uuid().optional(),
          productId: z.string().uuid().optional(),
          quantity: z.number().int().positive(),
          unitPrice: z.number().nonnegative().optional(),
          priceMode: z.enum(["list", "cash"]).optional(),
        })
        .refine((i) => Boolean(i.serviceId) !== Boolean(i.productId), {
          message: "Cada ítem necesita serviceId o productId (no ambos)",
        }),
    )
    .min(1),
  adjustmentAmount: z.number().optional(),
  description: z.string().max(1000).optional(),
});

invoicesRouter.post("/", zValidator("json", createBody), async (c) => {
  const db = createDb(c.env);
  const arca = createArcaClient(c.env);
  const invoice = await createDraftInvoice(db, arca, c.req.valid("json"));
  return c.json(invoice, 201);
});

invoicesRouter.post(
  "/emit-batch",
  zValidator(
    "json",
    z.object({ invoiceIds: z.array(z.string().uuid()).optional() }).optional().default({}),
  ),
  async (c) => {
    const db = createDb(c.env);
    const arca = createArcaClient(c.env);
    const { invoiceIds } = c.req.valid("json");
    return c.json(await emitBatch(db, arca, invoiceIds));
  },
);

invoicesRouter.get("/:id", async (c) => {
  const db = createDb(c.env);
  const detail = await getInvoiceDetail(db, c.req.param("id"));
  return c.json({
    ...detail,
    subtotal: detail.subtotal != null ? Number(detail.subtotal) : null,
    totalAmount: detail.totalAmount != null ? Number(detail.totalAmount) : null,
    lineItems: detail.lineItems.map((li) => ({
      ...li,
      unitPrice: li.unitPrice != null ? Number(li.unitPrice) : null,
      subtotal: li.subtotal != null ? Number(li.subtotal) : null,
      totalAmount: li.totalAmount != null ? Number(li.totalAmount) : null,
    })),
  });
});

invoicesRouter.post("/:id/emit", async (c) => {
  const db = createDb(c.env);
  const arca = createArcaClient(c.env);
  return c.json(await emitInvoice(db, arca, c.req.param("id")));
});

invoicesRouter.post(
  "/:id/cancel",
  zValidator("json", z.object({ reason: z.string().max(500).optional() }).optional().default({})),
  async (c) => {
    const db = createDb(c.env);
    const arca = createArcaClient(c.env);
    const { reason } = c.req.valid("json");
    return c.json(await cancelInvoice(db, arca, c.req.param("id"), reason));
  },
);

export { invoicesRouter };
