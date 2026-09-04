import { and, asc, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { categories } from "../db/schema";

const categoryFields = {
  id: categories.id,
  parentCategoryId: categories.parentCategoryId,
  name: categories.name,
  description: categories.description,
  displayOrder: categories.displayOrder,
  isActive: categories.isActive,
  kind: categories.kind,
};

/** Los cuatro ejes de `categories.kind` (migración 1.37.0). */
export const CATEGORY_KINDS = ["area", "tecnica", "objetivo", "maquina"] as const;
export type CategoryKind = (typeof CATEGORY_KINDS)[number];

export async function listActiveCategories(db: Db) {
  return listCategories(db, false);
}

/**
 * Lista categorías ordenadas.
 *
 * `includeInactive` suma las archivadas (solo admin/staff). `kind` acota a un
 * eje — las pestañas piden 'area', el buscador de la web 'objetivo'. Los dos
 * filtros son independientes: pedir un eje NO deja pasar archivadas.
 */
export async function listCategories(db: Db, includeInactive = false, kind?: CategoryKind) {
  const condiciones = [
    includeInactive ? undefined : eq(categories.isActive, true),
    kind ? eq(categories.kind, kind) : undefined,
  ].filter((c) => c !== undefined);

  const base = db.select(categoryFields).from(categories);
  const filtrada = condiciones.length > 0 ? base.where(and(...condiciones)) : base;
  return filtrada.orderBy(asc(categories.displayOrder), asc(categories.name));
}

export async function getCategoryById(db: Db, id: string) {
  const rows = await db.select(categoryFields).from(categories).where(eq(categories.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function createCategory(
  db: Db,
  data: {
    name: string;
    description?: string | null;
    parentCategoryId?: string | null;
    displayOrder?: number | null;
  },
) {
  const rows = await db
    .insert(categories)
    .values({
      name: data.name,
      description: data.description ?? null,
      parentCategoryId: data.parentCategoryId ?? null,
      displayOrder: data.displayOrder ?? null,
      isActive: true,
    })
    .returning(categoryFields);
  return rows[0]!;
}

export async function updateCategory(
  db: Db,
  id: string,
  patch: {
    name?: string;
    description?: string | null;
    parentCategoryId?: string | null;
    displayOrder?: number | null;
  },
) {
  const rows = await db
    .update(categories)
    .set({
      ...(patch.name !== undefined && { name: patch.name }),
      ...(patch.description !== undefined && { description: patch.description }),
      ...(patch.parentCategoryId !== undefined && { parentCategoryId: patch.parentCategoryId }),
      ...(patch.displayOrder !== undefined && { displayOrder: patch.displayOrder }),
    })
    .where(eq(categories.id, id))
    .returning(categoryFields);
  return rows[0] ?? null;
}

/** Soft-delete / restore: nunca borra, solo cambia `is_active` (regla 1.3). */
export async function setCategoryActive(db: Db, id: string, isActive: boolean) {
  const rows = await db
    .update(categories)
    .set({ isActive })
    .where(eq(categories.id, id))
    .returning(categoryFields);
  return rows[0] ?? null;
}
