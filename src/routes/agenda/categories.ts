import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { createDb } from "../../db/client";
import {
  CATEGORY_KINDS,
  createCategory,
  getCategoryById,
  getCategoryDeleteImpact,
  hardDeleteCategory,
  listCategories,
  setCategoryActive,
  setCategoryWebDescription,
  updateCategory,
} from "../../repositories/categories.repo";
import { auth, requireAdmin, requireAuth, requirePermission } from "../../middleware/auth";
import { badRequest, notFound } from "../../lib/errors";
import type { AppBindings, Variables } from "../../env";

type CategoryNode = {
  id: string;
  name: string | null;
  description: string | null;
  webDescription: string | null;
  displayOrder: number | null;
  isActive: boolean | null;
  kind: string;
  children: CategoryNode[];
};

const STAFF = ["admin", "manager", "operator"];

const categoriesRouter = new Hono<{ Bindings: AppBindings; Variables: Variables }>();

export const categoriesQuery = z.object({
  includeInactive: z.string().optional(),
  kind: z.enum(CATEGORY_KINDS).optional(),
});

// GET público (lo usan agenda y web). `auth` no bloquea: solo permite que un
// usuario staff pida también las archivadas con ?includeInactive=true.
//
// `kind` acota a un eje (migración 1.37.0). Sin el parámetro devuelve todo,
// igual que antes — la web filtra del lado suyo por el `kind` que ahora viene
// en cada fila, así que este endpoint no cambia de comportamiento para nadie
// que no lo pida.
categoriesRouter.get(
  "/",
  auth,
  zValidator("query", categoriesQuery),
  async (c) => {
    const db = createDb(c.env);
    const canSeeInactive = STAFF.includes(c.get("userRole") ?? "");
    const includeInactive =
      canSeeInactive && c.req.valid("query").includeInactive === "true";

    const rows = await listCategories(db, includeInactive, c.req.valid("query").kind);

    const nodes = new Map<string, CategoryNode>(
      rows.map((r) => [
        r.id,
        {
          id: r.id,
          name: r.name,
          description: r.description,
          webDescription: r.webDescription,
          displayOrder: r.displayOrder,
          isActive: r.isActive,
          kind: r.kind,
          children: [],
        },
      ]),
    );
    const roots: CategoryNode[] = [];
    for (const row of rows) {
      const node = nodes.get(row.id)!;
      const parent = row.parentCategoryId ? nodes.get(row.parentCategoryId) : undefined;
      if (parent) parent.children.push(node);
      else roots.push(node);
    }
    return c.json(roots);
  },
);

const categoryBody = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(2000).nullish(),
  parentCategoryId: z.string().uuid().nullish(),
  displayOrder: z.number().int().nullish(),
});

// Crear — solo admin (crear = nivel F de la matriz).
categoriesRouter.post("/", auth, requireAuth, requirePermission("catalogo", "manage"), zValidator("json", categoryBody), async (c) => {
  const db = createDb(c.env);
  const created = await createCategory(db, c.req.valid("json"));
  return c.json(created, 201);
});

// Editar — admin + manager + operator (nivel E).
categoriesRouter.patch(
  "/:id",
  auth,
  requireAuth,
  requirePermission("catalogo", "edit"),
  zValidator("json", categoryBody.partial()),
  async (c) => {
    const db = createDb(c.env);
    const updated = await updateCategory(db, c.req.param("id"), c.req.valid("json"));
    if (!updated) throw notFound("Category");
    return c.json(updated);
  },
);

// La descripción que se ve en la web. Aparte del PATCH de arriba porque se edita
// desde Sitio Web, con el permiso de esa sección. Vacía se guarda como NULL.
categoriesRouter.patch(
  "/:id/descripcion-web",
  auth,
  requireAuth,
  requirePermission("sitio-web", "edit"),
  zValidator("json", z.object({ webDescription: z.string().max(2000).nullable() })),
  async (c) => {
    const db = createDb(c.env);
    const texto = c.req.valid("json").webDescription?.trim() || null;
    const updated = await setCategoryWebDescription(db, c.req.param("id"), texto);
    if (!updated) throw notFound("Category");
    return c.json(updated);
  },
);

// Archivar (soft-delete) — solo admin. Un área no se archiva: su pestaña del
// panel quedaría vacía y desaparecería del modal de Nuevo Servicio.
categoriesRouter.delete("/:id", auth, requireAuth, requirePermission("catalogo", "manage"), async (c) => {
  const db = createDb(c.env);
  const archived = await setCategoryActive(db, c.req.param("id"), false);
  if (!archived) throw notFound("Category");
  if ("blocked" in archived) throw badRequest(archived.blocked);
  return c.json(archived);
});

// Restaurar — solo admin.
categoriesRouter.post("/:id/restore", auth, requireAuth, requirePermission("catalogo", "manage"), async (c) => {
  const db = createDb(c.env);
  const restored = await setCategoryActive(db, c.req.param("id"), true);
  if (!restored) throw notFound("Category");
  return c.json(restored);
});

// Impacto de un hard-delete: qué se desvincularía y si está bloqueado. Solo
// admin — es el paso previo al DELETE /:id/permanent.
categoriesRouter.get("/:id/delete-impact", auth, requireAuth, requireAdmin, async (c) => {
  const db = createDb(c.env);
  const id = c.req.param("id");
  if (!(await getCategoryById(db, id))) throw notFound("Category");
  return c.json(await getCategoryDeleteImpact(db, id));
});

// Hard-delete real (no el archivado de DELETE /:id). Solo admin. Se bloquea si
// la categoría tiene subcategorías, si todavía está activa, o si es un área del
// panel (esas no se borran nunca: `admin-nav.ts` las referencia por nombre).
categoriesRouter.delete("/:id/permanent", auth, requireAuth, requireAdmin, async (c) => {
  const db = createDb(c.env);
  const id = c.req.param("id");
  if (!(await getCategoryById(db, id))) throw notFound("Category");

  const impacto = await getCategoryDeleteImpact(db, id);
  if (impacto.blocked) throw badRequest(impacto.blockReason!);

  await hardDeleteCategory(db, id);
  return c.json({ ok: true });
});

export { categoriesRouter };
