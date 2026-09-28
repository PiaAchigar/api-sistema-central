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

  // Los tres casos que el conteo tiene que EXCLUIR, y que hasta la revisión
  // final no estaban en ningún fixture. Sin ellos, la versión que ignora
  // `customer_purchase` pasaba el test igual — y en producción decía 6 donde
  // la verdad era 3, porque una compra de "Cuerpo Full ×3" cancelada el
  // 2026-09-23 seguía sumando sus 3 sesiones.
  //
  // 1) Compra CANCELADA: la clienta ya no tiene esas sesiones.
  const cancelada = await createCompra(db, {
    customerId: cli.id,
    depilationComboId: comboId,
    description: `${QA}_CANCELADA`,
    sessionsTotal: 3,
    baseAmount: 30000,
    discountedAmount: 30000,
    finalAmount: 30000,
  });
  await cancelCompra(db, cancelada.id, `${QA}_motivo`);

  // 2) Compra VENCIDA ayer: la sesión está sin usar, pero ya no se agenda.
  const ayer = new Date(Date.now() - 24 * 60 * 60 * 1000);
  await createCompra(db, {
    customerId: cli.id,
    depilationComboId: comboId,
    description: `${QA}_VENCIDA`,
    sessionsTotal: 1,
    baseAmount: 10000,
    discountedAmount: 10000,
    finalAmount: 10000,
    expiresAt: ayer,
  });

  // 3) Línea CONSUMIDA sin turno enganchado: ya se usó, no espera nada.
  const consumida = await createCompra(db, {
    customerId: cli.id,
    depilationComboId: comboId,
    description: `${QA}_CONSUMIDA`,
    sessionsTotal: 1,
    baseAmount: 10000,
    discountedAmount: 10000,
    finalAmount: 10000,
  });
  await db
    .update(customerPurchaseService)
    .set({ consumedAt: new Date() })
    .where(eq(customerPurchaseService.customerPurchaseId, consumida.id));
}, 30000);

afterAll(async () => {
  await limpiar();
  await pgClient.end();
});

describe("sesionesCompradasSinTurno", () => {
  it("cuenta las líneas de depilación sin turno, sin contar la que ya tiene uno", async () => {
    // El fixture compró 2 sesiones y sólo enganchó turno a 1: el conteo
    // tiene que subir en exactamente 1, no en 2.
    //
    // Y además hay 5 sesiones más en la base —3 canceladas, 1 vencida y 1
    // consumida— que NO tienen que sumar. `sinTurnoAntes + 1` es la aserción
    // fuerte: cualquiera de esas cinco que se cuele lo rompe.
    expect(await sesionesCompradasSinTurno(db)).toBe(sinTurnoAntes + 1);
  });

  // Los tres de arriba, cada uno por su cuenta: si el conteo se rompe, el
  // nombre del test dice CUÁL de los tres filtros se cayó en vez de dejar un
  // "+1 ≠ +4" a interpretar.
  it("no cuenta las sesiones de una compra cancelada", async () => {
    const canceladas = await db
      .select({ id: customerPurchaseService.id })
      .from(customerPurchaseService)
      .innerJoin(
        customerPurchase,
        eq(customerPurchase.id, customerPurchaseService.customerPurchaseId),
      )
      .where(eq(customerPurchase.description, `${QA}_CANCELADA`));
    // El fixture existe de verdad: sin esto el test pasaría por vacío.
    expect(canceladas).toHaveLength(3);
    expect(await sesionesCompradasSinTurno(db)).toBe(sinTurnoAntes + 1);
  });

  it("no cuenta las sesiones de una compra vencida", async () => {
    const [vencida] = await db
      .select({ id: customerPurchase.id, expiresAt: customerPurchase.expiresAt })
      .from(customerPurchase)
      .where(eq(customerPurchase.description, `${QA}_VENCIDA`));
    expect(vencida?.expiresAt).toBeTruthy();
    expect(vencida!.expiresAt!.getTime()).toBeLessThan(Date.now());
    expect(await sesionesCompradasSinTurno(db)).toBe(sinTurnoAntes + 1);
  });

  it("no cuenta una línea ya consumida aunque no tenga turno enganchado", async () => {
    const consumidas = await db
      .select({ id: customerPurchaseService.id })
      .from(customerPurchaseService)
      .innerJoin(
        customerPurchase,
        eq(customerPurchase.id, customerPurchaseService.customerPurchaseId),
      )
      .where(eq(customerPurchase.description, `${QA}_CONSUMIDA`));
    expect(consumidas).toHaveLength(1);
    expect(await sesionesCompradasSinTurno(db)).toBe(sinTurnoAntes + 1);
  });
});
