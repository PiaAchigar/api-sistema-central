import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { createDb } from "../../db/client";
import {
  CATEGORY_KINDS,
  createCategory,
  listCategories,
  setCategoryActive,
  updateCategory,
} from "../../repositories/categories.repo";
import { auth, requireAuth, requirePermission } from "../../middleware/auth";
import { notFound } from "../../lib/errors";
import type { AppBindings, Variables } from "../../env";

type CategoryNode = {
  id: string;
  name: string | null;
  description: string | null;
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

// Archivar (soft-delete) — solo admin.
categoriesRouter.delete("/:id", auth, requireAuth, requirePermission("catalogo", "manage"), async (c) => {
  const db = createDb(c.env);
  const archived = await setCategoryActive(db, c.req.param("id"), false);
  if (!archived) throw notFound("Category");
  return c.json(archived);
});

// Restaurar — solo admin.
categoriesRouter.post("/:id/restore", auth, requireAuth, requirePermission("catalogo", "manage"), async (c) => {
  const db = createDb(c.env);
  const restored = await setCategoryActive(db, c.req.param("id"), true);
  if (!restored) throw notFound("Category");
  return c.json(restored);
});

export { categoriesRouter };
