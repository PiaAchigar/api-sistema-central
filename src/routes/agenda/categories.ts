import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { createDb } from "../../db/client";
import {
  createCategory,
  listCategories,
  setCategoryActive,
  updateCategory,
} from "../../repositories/categories.repo";
import { auth, requireAdmin, requireAuth, requireRole } from "../../middleware/auth";
import { notFound } from "../../lib/errors";
import type { AppBindings, Variables } from "../../env";

type CategoryNode = {
  id: string;
  name: string | null;
  description: string | null;
  displayOrder: number | null;
  isActive: boolean | null;
  children: CategoryNode[];
};

const STAFF = ["admin", "manager", "operator"];

const categoriesRouter = new Hono<{ Bindings: AppBindings; Variables: Variables }>();

// GET público (lo usan agenda y web). `auth` no bloquea: solo permite que un
// usuario staff pida también las archivadas con ?includeInactive=true.
categoriesRouter.get(
  "/",
  auth,
  zValidator("query", z.object({ includeInactive: z.string().optional() })),
  async (c) => {
    const db = createDb(c.env);
    const canSeeInactive = STAFF.includes(c.get("userRole") ?? "");
    const includeInactive =
      canSeeInactive && c.req.valid("query").includeInactive === "true";

    const rows = await listCategories(db, includeInactive);

    const nodes = new Map<string, CategoryNode>(
      rows.map((r) => [
        r.id,
        {
          id: r.id,
          name: r.name,
          description: r.description,
          displayOrder: r.displayOrder,
          isActive: r.isActive,
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
categoriesRouter.post("/", auth, requireAuth, requireAdmin, zValidator("json", categoryBody), async (c) => {
  const db = createDb(c.env);
  const created = await createCategory(db, c.req.valid("json"));
  return c.json(created, 201);
});

// Editar — admin + manager + operator (nivel E).
categoriesRouter.patch(
  "/:id",
  auth,
  requireAuth,
  requireRole(...STAFF),
  zValidator("json", categoryBody.partial()),
  async (c) => {
    const db = createDb(c.env);
    const updated = await updateCategory(db, c.req.param("id"), c.req.valid("json"));
    if (!updated) throw notFound("Category");
    return c.json(updated);
  },
);

// Archivar (soft-delete) — solo admin.
categoriesRouter.delete("/:id", auth, requireAuth, requireAdmin, async (c) => {
  const db = createDb(c.env);
  const archived = await setCategoryActive(db, c.req.param("id"), false);
  if (!archived) throw notFound("Category");
  return c.json(archived);
});

// Restaurar — solo admin.
categoriesRouter.post("/:id/restore", auth, requireAuth, requireAdmin, async (c) => {
  const db = createDb(c.env);
  const restored = await setCategoryActive(db, c.req.param("id"), true);
  if (!restored) throw notFound("Category");
  return c.json(restored);
});

export { categoriesRouter };
