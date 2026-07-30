import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { createDb } from "../../db/client";
import { badRequest, conflict, notFound } from "../../lib/errors";
import { encryptSecret } from "../../lib/secret-box";
import {
  clearDefaultExcept,
  findIssuerByName,
  getIssuer,
  insertIssuer,
  listIssuers,
  updateIssuer,
} from "../../repositories/issuers.repo";
import { requireAdmin } from "../../middleware/auth";
import type { AppBindings, Variables } from "../../env";

const issuersRouter = new Hono<{ Bindings: AppBindings; Variables: Variables }>();

/**
 * Facturadores ARCA (identidades fiscales). Las credenciales (sdk token, cert,
 * key) se guardan CIFRADAS y NUNCA se devuelven: solo se pueden reemplazar.
 *
 * El listado es legible por cualquier usuario autenticado (el selector de la
 * cobranza lo necesita); crear/editar/borrar es solo admin.
 */

issuersRouter.get(
  "/",
  zValidator("query", z.object({ onlyActive: z.enum(["true", "false"]).optional() })),
  async (c) => {
    const db = createDb(c.env);
    const { onlyActive } = c.req.valid("query");
    return c.json(await listIssuers(db, { onlyActive: onlyActive === "true" }));
  },
);

const createBody = z.object({
  name: z.string().min(2).max(100),
  cuit: z.string().regex(/^\d{11}$/, "El CUIT son 11 dígitos sin guiones"),
  sdkToken: z.string().min(10),
  cert: z.string().min(40),
  key: z.string().min(40),
  environment: z.enum(["homo", "prod"]).default("homo"),
  pointOfSale: z.number().int().positive().default(1),
  invoiceType: z.enum(["A", "B", "C"]).default("C"),
  isActive: z.boolean().default(true),
  isDefault: z.boolean().default(false),
  notes: z.string().max(500).optional(),
});

issuersRouter.post("/", requireAdmin, zValidator("json", createBody), async (c) => {
  const db = createDb(c.env);
  const body = c.req.valid("json");

  if (await findIssuerByName(db, body.name)) {
    throw conflict(`Ya existe un facturador llamado "${body.name}"`);
  }

  const [sdkTokenEnc, certEnc, keyEnc] = await Promise.all([
    encryptSecret(body.sdkToken, c.env.ARCA_SECRETS_KEY),
    encryptSecret(body.cert, c.env.ARCA_SECRETS_KEY),
    encryptSecret(body.key, c.env.ARCA_SECRETS_KEY),
  ]);

  return c.json(
    await db.transaction(async (tx) => {
      const created = await insertIssuer(tx, {
        name: body.name,
        cuit: body.cuit,
        sdkTokenEnc,
        certEnc,
        keyEnc,
        environment: body.environment,
        pointOfSale: body.pointOfSale,
        invoiceType: body.invoiceType,
        isActive: body.isActive,
        // El índice único parcial impide dos defaults: se limpia el anterior primero.
        isDefault: false,
      });
      if (body.isDefault) {
        await clearDefaultExcept(tx, created.id);
        return (await updateIssuer(tx, created.id, { isDefault: true }))!;
      }
      return created;
    }),
    201,
  );
});

/**
 * Migra las credenciales que hoy viven en las variables del Worker (AFIP_*) a
 * un facturador de la base, para no tener que copiar y pegar el certificado a
 * mano la primera vez. Idempotente: si ya existe uno con ese nombre, no hace nada.
 */
issuersRouter.post(
  "/import-from-env",
  requireAdmin,
  zValidator("json", z.object({ name: z.string().min(2).max(100).default("Gastón") })),
  async (c) => {
    const { AFIP_CUIT, AFIP_SDK_TOKEN, AFIP_CERT, AFIP_KEY } = c.env;
    if (!AFIP_CUIT || !AFIP_SDK_TOKEN || !AFIP_CERT || !AFIP_KEY) {
      throw badRequest(
        "El Worker no tiene AFIP_CUIT / AFIP_SDK_TOKEN / AFIP_CERT / AFIP_KEY configurados: cargá el facturador a mano.",
      );
    }
    const db = createDb(c.env);
    const { name } = c.req.valid("json");
    const existing = await findIssuerByName(db, name);
    if (existing) return c.json({ ...(await getIssuer(db, existing.id))!, imported: false });

    const [sdkTokenEnc, certEnc, keyEnc] = await Promise.all([
      encryptSecret(AFIP_SDK_TOKEN, c.env.ARCA_SECRETS_KEY),
      encryptSecret(AFIP_CERT, c.env.ARCA_SECRETS_KEY),
      encryptSecret(AFIP_KEY, c.env.ARCA_SECRETS_KEY),
    ]);

    const created = await db.transaction(async (tx) => {
      const row = await insertIssuer(tx, {
        name,
        cuit: AFIP_CUIT.replace(/\D/g, ""),
        sdkTokenEnc,
        certEnc,
        keyEnc,
        environment: c.env.ARCA_ENV === "prod" ? "prod" : "homo",
        pointOfSale: Number(c.env.ARCA_POS ?? "2"),
        invoiceType: c.env.ARCA_INVOICE_TYPE ?? "C",
        isActive: true,
        isDefault: false,
      });
      await clearDefaultExcept(tx, row.id);
      return (await updateIssuer(tx, row.id, { isDefault: true }))!;
    });

    return c.json({ ...created, imported: true }, 201);
  },
);

const patchBody = z.object({
  name: z.string().min(2).max(100).optional(),
  cuit: z.string().regex(/^\d{11}$/).optional(),
  // Secretos: solo si se quieren reemplazar. Omitidos ⇒ se conservan los actuales.
  sdkToken: z.string().min(10).optional(),
  cert: z.string().min(40).optional(),
  key: z.string().min(40).optional(),
  environment: z.enum(["homo", "prod"]).optional(),
  pointOfSale: z.number().int().positive().optional(),
  invoiceType: z.enum(["A", "B", "C"]).optional(),
  isActive: z.boolean().optional(),
  isDefault: z.boolean().optional(),
  notes: z.string().max(500).nullish(),
});

issuersRouter.patch("/:id", requireAdmin, zValidator("json", patchBody), async (c) => {
  const db = createDb(c.env);
  const id = c.req.param("id");
  const body = c.req.valid("json");

  const current = await getIssuer(db, id);
  if (!current) throw notFound("Facturador");

  if (body.name) {
    const clash = await findIssuerByName(db, body.name);
    if (clash && clash.id !== id) {
      throw conflict(`Ya existe un facturador llamado "${body.name}"`);
    }
  }
  // Desactivar el que está por defecto dejaría a las cobranzas sin facturador.
  if (body.isActive === false && current.isDefault && body.isDefault !== false) {
    throw badRequest(
      "No se puede desactivar el facturador por defecto: marcá otro como predeterminado primero.",
    );
  }

  const values: Record<string, unknown> = {};
  if (body.name !== undefined) values.name = body.name;
  if (body.cuit !== undefined) values.cuit = body.cuit;
  if (body.environment !== undefined) values.environment = body.environment;
  if (body.pointOfSale !== undefined) values.pointOfSale = body.pointOfSale;
  if (body.invoiceType !== undefined) values.invoiceType = body.invoiceType;
  if (body.isActive !== undefined) values.isActive = body.isActive;
  if (body.notes !== undefined) values.notes = body.notes;

  if (body.sdkToken) values.sdkTokenEnc = await encryptSecret(body.sdkToken, c.env.ARCA_SECRETS_KEY);
  if (body.cert) values.certEnc = await encryptSecret(body.cert, c.env.ARCA_SECRETS_KEY);
  if (body.key) values.keyEnc = await encryptSecret(body.key, c.env.ARCA_SECRETS_KEY);

  return c.json(
    await db.transaction(async (tx) => {
      if (body.isDefault === true) {
        await clearDefaultExcept(tx, id);
        values.isDefault = true;
        values.isActive = true; // el default siempre tiene que poder facturar
      } else if (body.isDefault === false) {
        values.isDefault = false;
      }
      const updated = await updateIssuer(tx, id, values);
      if (!updated) throw notFound("Facturador");
      return updated;
    }),
  );
});

/**
 * Baja lógica: no se borra la fila porque las facturas ya emitidas apuntan a
 * ella (y hay que poder auditar con qué CUIT se emitió cada comprobante).
 */
issuersRouter.delete("/:id", requireAdmin, async (c) => {
  const db = createDb(c.env);
  const id = c.req.param("id");
  const current = await getIssuer(db, id);
  if (!current) throw notFound("Facturador");
  if (current.isDefault) {
    throw badRequest(
      "No se puede dar de baja el facturador por defecto: marcá otro como predeterminado primero.",
    );
  }
  return c.json(await updateIssuer(db, id, { isActive: false }));
});

export { issuersRouter };
