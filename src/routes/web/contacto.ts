import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { createDb } from "../../db/client";
import { recibirContactoWeb } from "../../services/contacto-web.service";
import type { AppBindings, Variables } from "../../env";

// POST /api/web/contacto — el formulario de Contacto del sitio. Público: lo
// llama la web sin sesión. Ver contacto-web.service.ts.

const texto = (max: number) => z.string().trim().min(1).max(max);

export const consultaWebBody = z.object({
  nombre: texto(120),
  email: z.string().trim().email().max(255),
  telefono: texto(50).refine((t) => t.replace(/\D/g, "").length >= 8, "Teléfono incompleto"),
  mensaje: texto(2000),
  // Campo trampa: la web lo esconde, así que una persona lo deja vacío y un
  // bot que llena todo lo completa.
  empresa: z.string().max(200).optional(),
});

export function esUnBot(body: z.infer<typeof consultaWebBody>): boolean {
  return !!body.empresa?.trim();
}

const contactoWebRouter = new Hono<{ Bindings: AppBindings; Variables: Variables }>();

contactoWebRouter.post("/", zValidator("json", consultaWebBody), async (c) => {
  const body = c.req.valid("json");
  // Al bot se le contesta igual que a una persona, para que no aprenda nada.
  if (esUnBot(body)) return c.json({ ok: true }, 201);
  const { empresa: _empresa, ...consulta } = body;
  await recibirContactoWeb(createDb(c.env), consulta);
  return c.json({ ok: true }, 201);
});

export { contactoWebRouter };
