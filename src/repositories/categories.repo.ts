import { and, asc, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { categories, serviceCategory } from "../db/schema";
import { razonesParaNoArchivar, razonesParaNoBorrar } from "../lib/categorias-borrado";

const categoryFields = {
  id: categories.id,
  parentCategoryId: categories.parentCategoryId,
  name: categories.name,
  description: categories.description,
  webDescription: categories.webDescription,
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

/** El texto de la web, aparte de `updateCategory`: lo edita Sitio Web, no Catálogo. */
export async function setCategoryWebDescription(db: Db, id: string, webDescription: string | null) {
  const rows = await db
    .update(categories)
    .set({ webDescription })
    .where(eq(categories.id, id))
    .returning(categoryFields);
  return rows[0] ?? null;
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
/**
 * Archiva o restaura. Archivar un área está prohibido: su pestaña del panel
 * quedaría vacía y desaparecería del modal de Nuevo Servicio, que es lo que
 * pasó con "Estética". Restaurar nunca se bloquea.
 *
 * Devuelve `{ blocked }` en vez de tirar, para que la ruta arme la respuesta.
 */
export async function setCategoryActive(db: Db, id: string, isActive: boolean) {
  if (!isActive) {
    const cat = await getCategoryById(db, id);
    if (cat) {
      const motivos = razonesParaNoArchivar(cat);
      if (motivos.length > 0) return { blocked: `No se puede archivar: ${motivos[0]}.` } as const;
    }
  }

  const rows = await db
    .update(categories)
    .set({ isActive })
    .where(eq(categories.id, id))
    .returning(categoryFields);
  return rows[0] ?? null;
}

// ── Hard-delete (borrado permanente, admin-only) ────────────────────────────

/**
 * Qué pasaría si se borrara la categoría para siempre.
 *
 * Se bloquea por dos motivos, y los dos son de verdad, no precaución:
 *
 *   · **Tiene subcategorías.** `fk_cat_parent` es NO ACTION, así que el DELETE
 *     fallaría con un error de FK. Peor: si algún día se pusiera en CASCADE,
 *     borrar una raíz se llevaría en silencio una rama de siete niveles.
 *   · **Está activa.** El botón sólo aparece del lado de archivados, pero la
 *     regla vive acá: una categoría activa puede estar en el menú del sitio
 *     público, y borrarla lo cambia sin aviso.
 *
 * Los vínculos con servicios NO bloquean: `service_category` sólo relaciona.
 * Al borrarlos, cada servicio pierde una etiqueta y sigue existiendo. Se
 * cuentan igual para que la confirmación diga cuántos van a quedar sin ella.
 */
export async function getCategoryDeleteImpact(db: Db, id: string) {
  const [cat, hijas, servicios] = await Promise.all([
    getCategoryById(db, id),
    db.select({ id: categories.id }).from(categories).where(eq(categories.parentCategoryId, id)),
    db
      .select({ id: serviceCategory.serviceId })
      .from(serviceCategory)
      .where(eq(serviceCategory.categoryId, id)),
  ]);

  const motivos = cat ? razonesParaNoBorrar(cat, hijas.length) : [];

  return {
    blocked: motivos.length > 0,
    blockReason: motivos.length > 0 ? `No se puede eliminar: ${motivos.join(" y ")}.` : undefined,
    cascade: { serviceLinks: servicios.length },
  };
}

/**
 * Borra la categoría y sus vínculos con servicios, en una transacción.
 *
 * La ruta tiene que haber verificado `getCategoryDeleteImpact` antes: acá no se
 * vuelve a chequear, igual que en `hardDeleteService`.
 */
export async function hardDeleteCategory(db: Db, id: string): Promise<boolean> {
  const deleted = await db.transaction(async (tx) => {
    await tx.delete(serviceCategory).where(eq(serviceCategory.categoryId, id));
    return tx.delete(categories).where(eq(categories.id, id)).returning({ id: categories.id });
  });
  return deleted.length > 0;
}
