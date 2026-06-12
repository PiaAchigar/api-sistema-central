import { Hono } from "hono";
import { createDb } from "../../db/client";
import { listActiveCategories } from "../../repositories/categories.repo";
import type { AppBindings } from "../../env";

type CategoryNode = {
  id: string;
  name: string | null;
  description: string | null;
  displayOrder: number | null;
  children: CategoryNode[];
};

const categoriesRouter = new Hono<{ Bindings: AppBindings }>();

categoriesRouter.get("/", async (c) => {
  const db = createDb(c.env);
  const rows = await listActiveCategories(db);

  const nodes = new Map<string, CategoryNode>(
    rows.map((r) => [
      r.id,
      {
        id: r.id,
        name: r.name,
        description: r.description,
        displayOrder: r.displayOrder,
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
});

export { categoriesRouter };
