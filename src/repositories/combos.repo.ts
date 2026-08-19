import { and, asc, eq, inArray, ne } from "drizzle-orm";
import type { Db } from "../db/client";
import { combos, comboService, service } from "../db/schema";
import { computeComboFinalPrice, computeComboSubtotal } from "../lib/combo-pricing";

export type ComboLineInput = {
  serviceId: string;
  sessionsIncluded: number;
};

export type ComboHeaderInput = {
  name: string;
  description?: string | null;
  priceType: "fixed" | "percentage";
  fixedPrice?: number | null;
  discountPercentage?: number | null;
  validityMonths: number;
  isVisibleWeb?: boolean | null;
  displayOrder?: number | null;
};

/** Drizzle espera los decimal como string. */
const dec = (v: number | null | undefined) => (v == null ? null : String(v));
const num = (v: unknown) => (v == null ? null : Number(v));

const comboFields = {
  id: combos.id,
  name: combos.name,
  description: combos.description,
  priceType: combos.priceType,
  fixedPrice: combos.fixedPrice,
  discountPercentage: combos.discountPercentage,
  validityMonths: combos.validityMonths,
  isActive: combos.isActive,
  isVisibleWeb: combos.isVisibleWeb,
  displayOrder: combos.displayOrder,
};

async function linesFor(db: Db, comboId: string) {
  return db
    .select({
      id: comboService.id,
      serviceId: comboService.serviceId,
      serviceName: service.name,
      serviceIsActive: service.isActive,
      sessionsIncluded: comboService.sessionsIncluded,
      servicePrice: comboService.servicePrice,
    })
    .from(comboService)
    .leftJoin(service, eq(comboService.serviceId, service.id))
    .where(eq(comboService.comboId, comboId));
}

/**
 * Arma la vista completa de un combo: sus líneas, el subtotal y el precio final.
 *
 * `hasInactiveService` es lo que usan el panel (para avisarle a Laura) y la
 * ruta pública (para no publicarlo). Publicar un paquete que incluye un
 * servicio que ya no se hace es peor que no publicarlo.
 */
export function assembleCombo(
  combo: Record<string, unknown>,
  lines: {
    id: string;
    serviceId: string | null;
    serviceName: string | null;
    serviceIsActive: boolean | null;
    sessionsIncluded: number | null;
    servicePrice: string | number | null;
  }[],
) {
  const priced = lines.map((l) => ({
    servicePrice: l.servicePrice != null ? Number(l.servicePrice) : 0,
    sessionsIncluded: l.sessionsIncluded ?? 0,
  }));
  const servicesSubtotal = computeComboSubtotal(priced);
  const finalAmount = computeComboFinalPrice(
    servicesSubtotal,
    (combo.priceType as string | null) ?? null,
    num(combo.fixedPrice),
    num(combo.discountPercentage),
  );

  return {
    ...combo,
    fixedPrice: num(combo.fixedPrice),
    discountPercentage: num(combo.discountPercentage),
    servicesSubtotal,
    finalAmount,
    hasInactiveService: lines.some((l) => l.serviceIsActive === false),
    lines: lines.map((l) => ({
      id: l.id,
      serviceId: l.serviceId,
      serviceName: l.serviceName,
      serviceIsActive: l.serviceIsActive,
      sessionsIncluded: l.sessionsIncluded,
      servicePrice: num(l.servicePrice),
    })),
  };
}

/** Congela el precio de lista de cada servicio elegido, igual que las promos. */
async function freezePrices(db: Db, lines: ComboLineInput[]) {
  const ids = lines.map((l) => l.serviceId);
  const priced = ids.length
    ? await db
        .select({ id: service.id, price: service.unitPriceList })
        .from(service)
        .where(inArray(service.id, ids))
    : [];
  const priceById = new Map(priced.map((p) => [p.id, p.price ? Number(p.price) : 0]));
  return lines.map((l) => ({ ...l, servicePrice: priceById.get(l.serviceId) ?? 0 }));
}

async function writeLines(
  db: Db,
  comboId: string,
  frozen: (ComboLineInput & { servicePrice: number })[],
) {
  await db.delete(comboService).where(eq(comboService.comboId, comboId));
  if (frozen.length === 0) return;
  await db.insert(comboService).values(
    frozen.map((l) => ({
      comboId,
      serviceId: l.serviceId,
      sessionsIncluded: l.sessionsIncluded,
      servicePrice: dec(l.servicePrice),
    })),
  );
}

export async function listCombos(db: Db, includeInactive = false) {
  const base = db.select(comboFields).from(combos).orderBy(asc(combos.displayOrder), asc(combos.name));
  const rows = includeInactive
    ? await base
    : await db
        .select(comboFields)
        .from(combos)
        .where(ne(combos.isActive, false))
        .orderBy(asc(combos.displayOrder), asc(combos.name));
  const out = [];
  for (const c of rows) out.push(assembleCombo(c, await linesFor(db, c.id)));
  return out;
}

export async function getComboById(db: Db, id: string) {
  const [c] = await db.select(comboFields).from(combos).where(eq(combos.id, id)).limit(1);
  if (!c) return null;
  return assembleCombo(c, await linesFor(db, id));
}

/** Lo que ve la web: activo, visible, y con TODOS sus servicios activos. */
export async function listPublicCombos(db: Db) {
  const rows = await db
    .select(comboFields)
    .from(combos)
    .where(and(eq(combos.isActive, true), eq(combos.isVisibleWeb, true)))
    .orderBy(asc(combos.displayOrder), asc(combos.name));

  const out = [];
  for (const c of rows) {
    const assembled = assembleCombo(c, await linesFor(db, c.id));
    if (assembled.hasInactiveService) continue;
    if (assembled.lines.length === 0) continue;
    out.push(assembled);
  }
  return out;
}

/**
 * `writeLines` borra todas las líneas del combo y las vuelve a insertar: sin
 * transacción, si el INSERT falla después del DELETE el combo queda activo,
 * visible y vacío (0 servicios, $0), sin forma de deshacerlo. Por eso todo el
 * alta va en una única transacción.
 */
export async function createCombo(db: Db, header: ComboHeaderInput, lines: ComboLineInput[]) {
  const createdId = await db.transaction(async (tx) => {
    const frozen = await freezePrices(tx, lines);
    const [created] = await tx
      .insert(combos)
      .values({
        name: header.name,
        description: header.description ?? null,
        priceType: header.priceType,
        fixedPrice: dec(header.fixedPrice ?? null),
        discountPercentage: dec(header.discountPercentage ?? null),
        validityMonths: header.validityMonths,
        isActive: true,
        isVisibleWeb: header.isVisibleWeb ?? true,
        displayOrder: header.displayOrder ?? 0,
      })
      .returning({ id: combos.id });
    if (!created) return null;
    await writeLines(tx, created.id, frozen);
    return created.id;
  });
  if (!createdId) return null;
  // getComboById va DESPUÉS del commit, no adentro de la transacción: es una
  // lectura de lo que ya quedó confirmado, y no tiene sentido alargar el
  // bloqueo de la transacción con un SELECT que no necesita ver datos "en
  // vuelo" ni participar del rollback.
  return getComboById(db, createdId);
}

/** Mismo motivo que `createCombo`: DELETE + INSERT de las líneas en una sola transacción. */
export async function updateCombo(
  db: Db,
  id: string,
  header: ComboHeaderInput,
  lines: ComboLineInput[],
) {
  const updatedId = await db.transaction(async (tx) => {
    const frozen = await freezePrices(tx, lines);
    const updated = await tx
      .update(combos)
      .set({
        name: header.name,
        description: header.description ?? null,
        priceType: header.priceType,
        fixedPrice: dec(header.fixedPrice ?? null),
        discountPercentage: dec(header.discountPercentage ?? null),
        validityMonths: header.validityMonths,
        isVisibleWeb: header.isVisibleWeb ?? true,
        displayOrder: header.displayOrder ?? 0,
      })
      .where(eq(combos.id, id))
      .returning({ id: combos.id });
    if (updated.length === 0) return null;
    await writeLines(tx, id, frozen);
    return updated[0]!.id;
  });
  if (!updatedId) return null;
  // Mismo criterio que en createCombo: lectura post-commit, fuera de la transacción.
  return getComboById(db, updatedId);
}

export async function setComboStatus(db: Db, id: string, isActive: boolean) {
  const rows = await db
    .update(combos)
    .set({ isActive })
    .where(eq(combos.id, id))
    .returning({ id: combos.id });
  if (rows.length === 0) return null;
  return getComboById(db, id);
}

/**
 * Borrado real. En la fase 1 es incondicional porque `customer_combos` todavía
 * no existe y no hay compras contra las cuales chequear.
 *
 * REQUISITO DE LA FASE 2: agregar acá la guarda que rechace el borrado de un
 * combo con compras. Si se olvida, se va a poder borrar un combo que una
 * clienta ya pagó.
 */
export async function deleteComboPermanently(db: Db, id: string) {
  await db.delete(comboService).where(eq(comboService.comboId, id));
  const result = await db.delete(combos).where(eq(combos.id, id)).returning({ id: combos.id });
  return result.length > 0;
}
