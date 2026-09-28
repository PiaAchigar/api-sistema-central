import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { eq, like } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "../db/schema";
import { appointments, bodyZone, customerPurchase, customerPurchaseService, depilationCombo } from "../db/schema";
import type { Db } from "../db/client";
import { sesionesCompradasSinTurno } from "./turno-de-depilacion.repo";
import { createCompra } from "./compras.repo";
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

let sinTurnoAntes: number;

beforeAll(async () => {
  await limpiar();

  // Snapshot ANTES de armar el fixture: así el test no depende de que la
  // base local esté vacía de otras líneas de depilación sin turno.
  sinTurnoAntes = await sesionesCompradasSinTurno(db);

  // Sin filtro ZZ_QA a propósito: ningún archivo de la suite crea clientes,
  // así que no hay fixture QA ajeno que un `limit 1` sin ORDER BY pueda
  // agarrar (mismo criterio que consumo.repo.test.ts).
  const [cli] = await db.execute<{ id: string }>("select id from customers limit 1" as never);
  if (!cli) throw new Error("no hay clientes en la base local (¿corriste npm run db:up?)");

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

  // Dos sesiones compradas: una se queda SIN turno (la que tiene que contar
  // `sesionesCompradasSinTurno`) y a la otra le enganchamos un turno a mano.
  // Sin esta segunda línea, un `count(*)` que ignorara el filtro de
  // `appointment_id` pasaría este test igual — la línea CON turno es el
  // caso que la condición tiene que EXCLUIR.
  const compra = await createCompra(db, {
    customerId: cli.id,
    depilationComboId: comboId,
    description: `${QA}_COMPRA`,
    sessionsTotal: 2,
    baseAmount: 20000,
    discountedAmount: 20000,
    finalAmount: 20000,
  });

  const lineas = await db
    .select({ id: customerPurchaseService.id, repeticion: customerPurchaseService.repeticion })
    .from(customerPurchaseService)
    .where(eq(customerPurchaseService.customerPurchaseId, compra.id));
  const lineaAEnganchar = lineas[0];
  if (!lineaAEnganchar) throw new Error("createCompra no armó las líneas de depilación esperadas");

  const [turno] = await db
    .insert(appointments)
    .values({ notes: `${QA}_TURNO`, status: "completed" })
    .returning({ id: appointments.id });

  await db
    .update(customerPurchaseService)
    .set({ appointmentId: turno!.id })
    .where(eq(customerPurchaseService.id, lineaAEnganchar.id));
}, 30000);

afterAll(async () => {
  await limpiar();
  await pgClient.end();
});

describe("sesionesCompradasSinTurno", () => {
  it("cuenta las líneas de depilación sin turno, sin contar la que ya tiene uno", async () => {
    // El fixture compró 2 sesiones y sólo enganchó turno a 1: el conteo
    // tiene que subir en exactamente 1, no en 2.
    expect(await sesionesCompradasSinTurno(db)).toBe(sinTurnoAntes + 1);
  });
});
