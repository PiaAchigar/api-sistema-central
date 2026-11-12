import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { createDb } from "../../db/client";
import { requireAuth, requirePermission } from "../../middleware/auth";
import { getVinculos, setTitular } from "../../repositories/contact-links.repo";
import type { AppBindings, Variables } from "../../env";
import { titularInput } from "./contacts.schema";

const contactLinksRouter = new Hono<{ Bindings: AppBindings; Variables: Variables }>();

contactLinksRouter.get("/:id/vinculos", requireAuth, requirePermission("crm", "view"), async (c) => {
  return c.json(await getVinculos(createDb(c.env), c.req.param("id")));
});

contactLinksRouter.put(
  "/:id/titular",
  requireAuth,
  requirePermission("crm", "edit"),
  zValidator("json", titularInput),
  async (c) => {
    const db = createDb(c.env);
    const id = c.req.param("id");
    await setTitular(db, id, c.req.valid("json"));
    return c.json(await getVinculos(db, id));
  },
);

export { contactLinksRouter };
