import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { eq, like } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "../db/schema";
import { appointments, bodyZone, customerPurchase, customerPurchaseService, depilationCombo } from "../db/schema";
import type { Db } from "../db/client";
import { sesionesCompradasSinTurno } from "./turno-de-depilacion.repo";
import { cancelCompra, createCompra } from "./compras.repo";
import { crearCombo, hardDeleteCombo } from "./depilacion.repo";

// `fetch_types: false` a propósito: espeja las opciones de producción bajo
// Hyperdrive, que es donde los arrays como parámetro revientan.
const pgClient = postgres("postgresql://piubella:piubella@localhost:5499/piubella", {
  max: 1,
  fetch_types: false,
  prepare: false,
});
const db = drizzle(pgClient, { schema }) as unknown as Db;

const QA = "ZZ_QA_SESIONES_SIN_TURNO";

let comboId: string;

async function limpiar() {
  const compras = await db
    .select({ id: customerPurchase.id })
    .from(customerPurchase)
    .where(like(customerPurchase.description, `${QA}%`));
  for (const c of compras) {
    await db
      .delete(customerPurchaseService)
      .where(eq(customerPurchaseService.customerPurchaseId, c.id));
    await db.delete(customerPurchase).where(eq(customerPurchase.id, c.id));
  }
  // El turno de prueba sólo queda libre para borrarse DESPUÉS de borrar las
  // líneas de arriba: `customer_purchase_service_appointment_id_fkey` no
  // tiene ON DELETE CASCADE.
  await db.delete(appointments).where(eq(appointments.notes, `${QA}_TURNO`));

  const combos = await db
    .select({ id: depilationCombo.id })
    .from(depilationCombo)
    .where(like(depilationCombo.name, `${QA}%`));
  for (const c of combos) await hardDeleteCombo(db, c.id);
}

let clienteId: string;

/** Cuántas líneas tiene esa compra. Confirma que el fixture se armó de verdad:
 *  un test que no valida eso pasa por vacío si `createCompra` cambia. */
async function lineasDe(purchaseId: string): Promise<number> {
  const filas = await db
    .select({ id: customerPurchaseService.id })
    .from(customerPurchaseService)
    .where(eq(customerPurchaseService.customerPurchaseId, purchaseId));
  return filas.length;
}

beforeAll(async () => {
  await limpiar();

  // Sin filtro ZZ_QA a propósito: ningún archivo de la suite crea clientes,
  // así que no hay fixture QA ajeno que un `limit 1` sin ORDER BY pueda
  // agarrar (mismo criterio que consumo.repo.test.ts).
  const [cli] = await db.execute<{ id: string }>("select id from customers limit 1" as never);
  if (!cli) throw new Error("no hay clientes en la base local (¿corriste npm run db:up?)");
  clienteId = cli.id;

  const [axila] = await db
    .select({ id: bodyZone.id })
    .from(bodyZone)
    .where(eq(bodyZone.name, "Axila"))
    .limit(1);
  if (!axila) throw new Error('no está seedeada la zona real "Axila" (¿corriste npm run db:up?)');

  const combo = await crearCombo(db, {
    name: `${QA}_PACK`,
    kind: "pack_fijo",
    fixedPrice: 10000,
    choiceZoneCount: 0,
    zonaIds: [axila.id],
  });
  comboId = combo!.id;

}, 30000);

afterAll(async () => {
  await limpiar();
  await pgClient.end();
});

/** Una compra de depilación del fixture QA, con `sessionsTotal` líneas. */
async function comprarDepilacion(
  sufijo: string,
  sessionsTotal: number,
  expiresAt?: Date,
): Promise<string> {
  const compra = await createCompra(db, {
    customerId: clienteId,
    depilationComboId: comboId,
    description: `${QA}_${sufijo}`,
    sessionsTotal,
    baseAmount: 10000 * sessionsTotal,
    discountedAmount: 10000 * sessionsTotal,
    finalAmount: 10000 * sessionsTotal,
    expiresAt,
  });
  return compra.id;
}

describe("sesionesCompradasSinTurno", () => {
  it("cuenta las líneas de depilación sin turno, sin contar la que ya tiene uno", async () => {
    const antes = await sesionesCompradasSinTurno(db);

    // Dos sesiones compradas: una se queda SIN turno (la que tiene que contar
    // `sesionesCompradasSinTurno`) y a la otra le enganchamos un turno a mano.
    // Sin esa segunda línea, un `count(*)` que ignorara el filtro de
    // `appointment_id` pasaría este test igual — la línea CON turno es el caso
    // que la condición tiene que EXCLUIR.
    const id = await comprarDepilacion("DOS_SESIONES", 2);
    const lineas = await db
      .select({ id: customerPurchaseService.id })
      .from(customerPurchaseService)
      .where(eq(customerPurchaseService.customerPurchaseId, id));
    expect(lineas).toHaveLength(2);

    const [turno] = await db
      .insert(appointments)
      .values({ notes: `${QA}_TURNO`, status: "completed" })
      .returning({ id: appointments.id });
    await db
      .update(customerPurchaseService)
      .set({ appointmentId: turno!.id })
      .where(eq(customerPurchaseService.id, lineas[0]!.id));

    // Sube en exactamente 1, no en 2.
    expect(await sesionesCompradasSinTurno(db)).toBe(antes + 1);
  });

  // Los tres casos que el conteo tiene que EXCLUIR, y que hasta la revisión
  // final no estaban en ningún fixture: sin ellos, la versión que ignora
  // `customer_purchase` pasaba el test igual. En producción eso daba 6 donde la
  // verdad eran 3, porque una compra de "Cuerpo Full ×3" cancelada el
  // 2026-09-23 seguía sumando sus tres sesiones.
  //
  // Cada uno mide su PROPIO delta —conteo antes, insert, conteo después— en vez
  // de compararse contra un snapshot del `beforeAll`: los archivos de la suite
  // corren en paralelo y varios crean líneas de depilación, así que un número
  // absoluto tomado al principio del archivo se desactualiza solo.
  it("no cuenta las sesiones de una compra cancelada", async () => {
    const antes = await sesionesCompradasSinTurno(db);
    const id = await comprarDepilacion("CANCELADA", 3);
    // El fixture existe de verdad: sin esto el test pasaría por vacío.
    expect(await lineasDe(id)).toBe(3);
    await cancelCompra(db, id, `${QA}_motivo`);
    expect(await sesionesCompradasSinTurno(db)).toBe(antes);
  });

  it("no cuenta las sesiones de una compra vencida", async () => {
    const antes = await sesionesCompradasSinTurno(db);
    const ayer = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const id = await comprarDepilacion("VENCIDA", 2, ayer);
    expect(await lineasDe(id)).toBe(2);
    expect(await sesionesCompradasSinTurno(db)).toBe(antes);
  });

  it("no cuenta una línea ya consumida aunque no tenga turno enganchado", async () => {
    const antes = await sesionesCompradasSinTurno(db);
    const id = await comprarDepilacion("CONSUMIDA", 2);
    expect(await lineasDe(id)).toBe(2);
    await db
      .update(customerPurchaseService)
      .set({ consumedAt: new Date() })
      .where(eq(customerPurchaseService.customerPurchaseId, id));
    expect(await sesionesCompradasSinTurno(db)).toBe(antes);
  });

  // La contracara: una compra viva, sin vencer y sin consumir, SÍ tiene que
  // sumar. Sin esto, un conteo que devolviera siempre el mismo número pasaría
  // los tres tests de arriba.
  it("una compra viva sin turno sí suma sus sesiones", async () => {
    const antes = await sesionesCompradasSinTurno(db);
    const id = await comprarDepilacion("VIVA", 3);
    expect(await lineasDe(id)).toBe(3);
    expect(await sesionesCompradasSinTurno(db)).toBe(antes + 3);
  });
});
