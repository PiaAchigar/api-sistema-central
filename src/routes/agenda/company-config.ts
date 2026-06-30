import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { createDb } from "../../db/client";
import { getAllOpenHours } from "../../repositories/providers.repo";
import { getConfigRow, updateConfig, upsertOpenHours } from "../../repositories/company-config.repo";
import { auth, requireAuth, requirePermission } from "../../middleware/auth";
import type { AppBindings, Variables } from "../../env";

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

// ── Branding (sitio-web/edit) ─────────────────────────────────────────────
const brandingBody = z.object({
  heroTitle: z.string().max(255).nullish(),
  heroSubtitle: z.string().max(500).nullish(),
  aboutUs: z.string().max(10000).nullish(),
  companyDescription: z.string().max(255).nullish(),
  instagram: z.string().max(255).nullish(),
  facebook: z.string().max(255).nullish(),
  whatsapp: z.string().max(50).nullish(),
  website: z.string().max(255).nullish(),
});

companyConfigRouter.patch(
  "/branding",
  auth,
  requireAuth,
  requirePermission("sitio-web", "edit"),
  zValidator("json", brandingBody),
  async (c) => {
    const db = createDb(c.env);
    const updated = await updateConfig(db, c.req.valid("json"));
    return c.json(serialize(updated));
  },
);

// ── Datos de empresa (config-local/edit) ─────────────────────────────────
const datosBody = z.object({
  companyName: z.string().max(255).nullish(),
  address: z.string().max(255).nullish(),
  phone: z.string().max(50).nullish(),
  email: z.string().email().max(255).nullish(),
});

companyConfigRouter.patch(
  "/datos",
  auth,
  requireAuth,
  requirePermission("config-local", "edit"),
  zValidator("json", datosBody),
  async (c) => {
    const db = createDb(c.env);
    const updated = await updateConfig(db, c.req.valid("json"));
    return c.json(serialize(updated));
  },
);

// ── Horarios (config-local/edit) ─────────────────────────────────────────
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
  auth,
  requireAuth,
  requirePermission("config-local", "edit"),
  zValidator("json", openHoursBody),
  async (c) => {
    const db = createDb(c.env);
    const rows = await upsertOpenHours(db, c.req.valid("json").days);
    return c.json(rows);
  },
);

export { companyConfigRouter };
