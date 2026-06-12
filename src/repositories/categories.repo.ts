import { asc, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { categories } from "../db/schema";

export async function listActiveCategories(db: Db) {
  return db
    .select({
      id: categories.id,
      parentCategoryId: categories.parentCategoryId,
      name: categories.name,
      description: categories.description,
      displayOrder: categories.displayOrder,
    })
    .from(categories)
    .where(eq(categories.isActive, true))
    .orderBy(asc(categories.displayOrder), asc(categories.name));
}
