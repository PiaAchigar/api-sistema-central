import { Hono } from "hono";
import { createDb } from "../../db/client";
import { companyConfig } from "../../db/schema";
import { getAllOpenHours } from "../../repositories/providers.repo";
import type { AppBindings } from "../../env";

const companyConfigRouter = new Hono<{ Bindings: AppBindings }>();

companyConfigRouter.get("/", async (c) => {
  const db = createDb(c.env);
  const [config] = await db.select().from(companyConfig).limit(1);
  const openHours = await getAllOpenHours(db);
  return c.json({
    companyName: config?.companyName ?? "PiuBella",
    companyDescription: config?.companyDescription ?? null,
    address: config?.address ?? null,
    phone: config?.phone ?? null,
    email: config?.email ?? null,
    whatsapp: config?.whatsapp ?? null,
    instagram: config?.instagram ?? null,
    website: config?.website ?? null,
    openHours,
  });
});

export { companyConfigRouter };
