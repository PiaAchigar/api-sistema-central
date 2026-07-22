import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { createArcaClient } from "../../arca/factory";
import { createDb } from "../../db/client";
import { checkout } from "../../services/checkout.service";
import type { AppBindings } from "../../env";

const checkoutRouter = new Hono<{ Bindings: AppBindings }>();

const itemSchema = z
  .object({
    serviceId: z.string().uuid().optional(),
    productId: z.string().uuid().optional(),
    quantity: z.number().int().positive(),
    unitPrice: z.number().nonnegative().optional(),
    priceMode: z.enum(["list", "cash"]).optional(),
    billable: z.boolean().optional(),
  })
  .refine((i) => Boolean(i.serviceId) !== Boolean(i.productId), {
    message: "Cada ítem necesita serviceId o productId (no ambos)",
  });

const body = z.object({
  customerId: z.string().uuid(),
  appointmentId: z.string().uuid().optional(),
  items: z.array(itemSchema),
  payment: z.object({
    method: z.enum(["cash", "bank_transfer", "mercadopago"]),
    amount: z.number().positive(),
    wantsInvoice: z.boolean(),
    paidToProviderId: z.string().uuid().optional(),
  }),
  notes: z.string().max(1000).optional(),
});

checkoutRouter.post("/", zValidator("json", body), async (c) => {
  const db = createDb(c.env);
  const arca = createArcaClient(c.env);
  const result = await checkout(db, arca, c.req.valid("json"));
  return c.json(result, 201);
});

export { checkoutRouter };
