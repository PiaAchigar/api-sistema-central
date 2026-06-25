import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { createDb } from "../../db/client";
import { getAllOpenHours } from "../../repositories/providers.repo";
import { getConfigRow, updateConfig, upsertOpenHours } from "../../repositories/company-config.repo";
import { auth, requireAuth, requireRole } from "../../middleware/auth";
import type { AppBindings, Variables } from "../../env";

const STAFF = ["admin", "manager", "operator"] as const;

const companyConfigRouter = new Hono<{ Bindings: AppBindings; Variables: Variables }>();

function serialize(config: Awaited<ReturnType<typeof getConfigRow>>) {
  return {
    companyName: config?.companyName ?? "PiuBella",
    companyDescription: config?.companyDescription ?? null,
    heroTitle: config?.heroTitle ?? null,
    heroSubtitle: config?.heroSubtitle ?? null,
    aboutUs: config?.aboutUs ?? null,
    address: config?.address ?? null,
    phone: config?.phone ?? null,
    email: config?.email ?? null,
    website: config?.website ?? null,
    instagram: config?.instagram ?? null,
    facebook: config?.facebook ?? null,
    whatsapp: config?.whatsapp ?? null,
  };
}

companyConfigRouter.get("/", async (c) => {
  const db = createDb(c.env);
  const config = await getConfigRow(db);
  const openHours = await getAllOpenHours(db);
  return c.json({ ...serialize(config), openHours });
});

const configBody = z.object({
  companyName: z.string().max(255).nullish(),
  companyDescription: z.string().max(255).nullish(),
  heroTitle: z.string().max(255).nullish(),
  heroSubtitle: z.string().max(500).nullish(),
  aboutUs: z.string().max(10000).nullish(),
  address: z.string().max(255).nullish(),
  phone: z.string().max(50).nullish(),
  email: z.string().max(255).nullish(),
  website: z.string().max(255).nullish(),
  instagram: z.string().max(255).nullish(),
  facebook: z.string().max(255).nullish(),
  whatsapp: z.string().max(50).nullish(),
});

companyConfigRouter.patch(
  "/",
  auth,
  requireAuth,
  requireRole(...STAFF),
  zValidator("json", configBody),
  async (c) => {
    const db = createDb(c.env);
    const updated = await updateConfig(db, c.req.valid("json"));
    return c.json(serialize(updated));
  },
);

const TIME = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;
const openHoursBody = z.object({
  days: z.array(
    z.object({
      dayOfWeek: z.number().int().min(0).max(6),
      openingTime: z.string().regex(TIME).nullish(),
      closingTime: z.string().regex(TIME).nullish(),
      isOpen: z.boolean().nullish(),
    }),
  ),
});

companyConfigRouter.patch(
  "/open-hours",
  requireAuth,
  requireRole(...STAFF),
  zValidator("json", openHoursBody),
  async (c) => {
    const db = createDb(c.env);
    const rows = await upsertOpenHours(db, c.req.valid("json").days);
    return c.json(rows);
  },
);

export { companyConfigRouter };
