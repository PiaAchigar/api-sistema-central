import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq, inArray, like, sql } from "drizzle-orm";
import * as schema from "../db/schema";
import { appointments, contacts, customers } from "../db/schema";
import type { Db } from "../db/client";
import { anotarACapacitacion, opcionesDeCapacitacion } from "./anotar.service";
import { cuentaDeBaja, darDeBajaDeCapacitacion } from "./baja-de-capacitacion.service";
import { listInscriptas } from "../repositories/training-sessions.repo";

// Dar de baja a una clienta de una capacitación (regla de Pia, 2026-10-21):
// - Antes del primer encuentro: se cancela la compra; lo pagado queda a favor.
// - Ya empezada: Laura decide el saldo a favor o lo que queda debiendo, con la
//   cuenta proporcional a los encuentros que ya pasaron como sugerencia.
const URL = "postgresql://piubella:piubella@localhost:5499/piubella";
const pg = postgres(URL, { max: 2, fetch_types: false, prepare: false });
const db = drizzle(pg, { schema }) as unknown as Db;

const QA = "ZZ_QA_BAJA_CAPA";
// Martes 20 de octubre de 2026, 11:00 ART (= 14:00 UTC).
const AHORA = new Date("2026-10-20T14:00:00Z");

let capaNueva = ""; // 3 encuentros, todos futuros
let capaEmpezada = ""; // 3 encuentros: 2 pasados, 1 futuro
let empezadaPasados: string[] = [];
let clienta = "";

async function crearClienta(nombre: string) {
  const [ct] = await db.insert(contacts).values({ name: `${QA}_${nombre}` }).returning({ id: contacts.id });
  const [cu] = await db.insert(customers).values({ contactId: ct!.id }).returning({ id: customers.id });
  return cu!.id;
}

async function capacitacion(nombre: string, fechas: string[]) {
  const [t] = (await db.execute(sql`
    INSERT INTO training (id, name, max_participants, is_active) VALUES (gen_random_uuid(), ${`${QA}_${nombre}`}, 10, true) RETURNING id`)) as unknown as { id: string }[];
  const sesiones: string[] = [];
  for (const [i, f] of fechas.entries()) {
    const [s] = (await db.execute(sql`
      INSERT INTO training_sessions (training_id, session_number, session_date, start_time, end_time, is_active, notes)
      VALUES (${t!.id}, ${i + 1}, ${f}::date, '10:00'::time, '12:00'::time, true, ${QA})
      RETURNING id`)) as unknown as { id: string }[];
    sesiones.push(s!.id);
  }
  return { id: t!.id, sesiones };
}

/** Una compra de $100.000 de la capacitación, con su fila de servicio, y lo que haya pagado. */
async function compra(trainingId: string, pagado = 0) {
  const [r] = (await db.execute(sql`
    INSERT INTO customer_purchase (customer_id, training_id, description, sessions_total, base_amount, discounted_amount, final_amount, purchased_at, notes)
    VALUES (${clienta}, ${trainingId}, ${QA}, 1, 100000, 0, 100000, now(), ${QA})
    RETURNING id`)) as unknown as { id: string }[];
  await db.execute(sql`
    INSERT INTO customer_purchase_service (customer_purchase_id, training_id, repeticion, orden)
    VALUES (${r!.id}, ${trainingId}, 1, 1)`);
  if (pagado > 0) {
    await db.execute(sql`
      INSERT INTO payments (id, customer_id, customer_purchase_id, amount, payment_method, status)
      VALUES (gen_random_uuid(), ${clienta}, ${r!.id}, ${pagado}, 'cash', 'confirmed')`);
  }
  return r!.id;
}

/** Un turno de la clienta en un encuentro, con el estado que se le pida. */
async function turno(sesionId: string, status: string) {
  const [s] = (await db.execute(sql`
    SELECT ((session_date + start_time) AT TIME ZONE 'America/Argentina/Buenos_Aires') AS inicio
    FROM training_sessions WHERE id = ${sesionId}`)) as unknown as { inicio: Date }[];
  const inicio = new Date(s!.inicio);
  await db.insert(appointments).values({
    customerId: clienta, trainingSessionId: sesionId, status,
    appointmentStart: inicio, appointmentEnd: new Date(inicio.getTime() + 7200_000), durationMinutes: 120,
  });
}

const deuda = async (compraId: string) => {
  const [r] = (await db.execute(sql`
    SELECT cp.final_amount::numeric - coalesce((SELECT sum(amount) FROM payments p WHERE p.customer_purchase_id = cp.id AND p.status = 'confirmed'), 0) AS debe,
           cp.cancelled_at
    FROM customer_purchase cp WHERE cp.id = ${compraId}`)) as unknown as { debe: string; cancelled_at: Date | null }[];
  return { debe: Number(r!.debe), cancelada: r!.cancelled_at != null };
};
const saldoAFavor = async () => {
  const [r] = (await db.execute(sql`
    SELECT coalesce(sum(amount), 0) AS s FROM customer_credit_movements WHERE customer_id = ${clienta}`)) as unknown as { s: string }[];
  return Number(r!.s);
};
const turnosVivos = async () =>
  (await db.select().from(appointments).where(eq(appointments.customerId, clienta))).filter((t) => t.status !== "cancelled");

async function limpiar() {
  const cts = await db.select({ id: contacts.id }).from(contacts).where(like(contacts.name, `${QA}%`));
  const cuIds: string[] = [];
  for (const ct of cts) {
    const cus = await db.select({ id: customers.id }).from(customers).where(eq(customers.contactId, ct.id));
    cuIds.push(...cus.map((c) => c.id));
  }
  if (cuIds.length) {
    const lista = sql.join(cuIds.map((i) => sql`${i}::uuid`), sql`, `);
    await db.delete(appointments).where(inArray(appointments.customerId, cuIds));
    await db.execute(sql`DELETE FROM customer_credit_movements WHERE customer_id IN (${lista})`);
    await db.execute(sql`DELETE FROM payments WHERE customer_id IN (${lista})`);
    await db.execute(sql`DELETE FROM customer_purchase_service WHERE customer_purchase_id IN (SELECT id FROM customer_purchase WHERE customer_id IN (${lista}))`);
    await db.execute(sql`DELETE FROM customer_purchase WHERE customer_id IN (${lista})`);
    await db.delete(customers).where(inArray(customers.id, cuIds));
  }
  for (const ct of cts) await db.delete(contacts).where(eq(contacts.id, ct.id));
  await db.execute(sql`DELETE FROM training_sessions WHERE training_id IN (SELECT id FROM training WHERE name LIKE ${QA + "%"})`);
  await db.execute(sql`DELETE FROM training WHERE name LIKE ${QA + "%"}`);
}

beforeAll(async () => {
  await limpiar();
  capaNueva = (await capacitacion("Nueva", ["2026-10-27", "2026-11-03", "2026-11-10"])).id;
  const e = await capacitacion("Empezada", ["2026-10-06", "2026-10-13", "2026-10-27"]);
  capaEmpezada = e.id;
  empezadaPasados = e.sesiones.slice(0, 2);
  clienta = await crearClienta("CLIENTA");
});

beforeEach(async () => {
  const lista = sql`${clienta}::uuid`;
  await db.delete(appointments).where(eq(appointments.customerId, clienta));
  await db.execute(sql`DELETE FROM customer_credit_movements WHERE customer_id = ${lista}`);
  await db.execute(sql`DELETE FROM payments WHERE customer_id = ${lista}`);
  await db.execute(sql`DELETE FROM customer_purchase_service WHERE customer_purchase_id IN (SELECT id FROM customer_purchase WHERE customer_id = ${lista})`);
  await db.execute(sql`DELETE FROM customer_purchase WHERE customer_id = ${lista}`);
});

afterAll(async () => {
  await limpiar();
  await pg.end();
});

const cuenta = (trainingId: string) => cuentaDeBaja(db, { trainingId, customerId: clienta, ahora: AHORA });
const baja = (trainingId: string, extra: { saldoAFavor?: number; debe?: number } = {}) =>
  darDeBajaDeCapacitacion(db, { trainingId, customerId: clienta, ahora: AHORA, ...extra });

describe("antes del primer encuentro", () => {
  it("la cuenta dice que no empezó", async () => {
    await compra(capaNueva, 40000);
    expect(await cuenta(capaNueva)).toMatchObject({ empezo: false, precio: 100000, pagado: 40000, encuentrosPasados: 0 });
  });

  it("sin pagos: cancela los encuentros y la compra, y la deuda queda en 0", async () => {
    const id = await compra(capaNueva);
    await anotarACapacitacion(db, { trainingId: capaNueva, customerId: clienta, ahora: AHORA });
    const r = await baja(capaNueva);
    expect(r).toMatchObject({ encuentrosCancelados: 3, saldoAcreditado: 0, debe: 0 });
    expect(await turnosVivos()).toHaveLength(0);
    expect(await deuda(id)).toMatchObject({ cancelada: true });
    expect(await saldoAFavor()).toBe(0);
  });

  it("con una seña: todo lo pagado queda a favor", async () => {
    await compra(capaNueva, 40000);
    const r = await baja(capaNueva);
    expect(r.saldoAcreditado).toBe(40000);
    expect(await saldoAFavor()).toBe(40000);
  });

  it("después de la baja, volver a anotarla es como si nunca la hubiera comprado", async () => {
    await compra(capaNueva);
    await baja(capaNueva);
    expect(await opcionesDeCapacitacion(db, { trainingId: capaNueva, customerId: clienta, ahora: AHORA })).toMatchObject({
      compraId: null, debe: 0,
    });
  });
});

describe("ya empezada (2 de 3 encuentros pasaron)", () => {
  it("la cuenta: el ejemplo de Pia — pagó 40%, vino a 1, faltó a 1: debe ~26,7%", async () => {
    await compra(capaEmpezada, 40000);
    await turno(empezadaPasados[0]!, "completed");
    await turno(empezadaPasados[1]!, "no_show");
    expect(await cuenta(capaEmpezada)).toEqual({
      compraId: expect.any(String),
      empezo: true,
      precio: 100000,
      pagado: 40000,
      encuentrosTotales: 3,
      encuentrosPasados: 2,
      vino: 1,
      falto: 1,
      corresponde: 66667,
      sugerido: { saldoAFavor: 0, debe: 26667 },
    });
  });

  it("si pagó de más, sugiere saldo a favor por la diferencia", async () => {
    await compra(capaEmpezada, 100000);
    expect((await cuenta(capaEmpezada)).sugerido).toEqual({ saldoAFavor: 33333, debe: 0 });
  });

  it("sin decir saldo a favor ni deuda: 400", async () => {
    await compra(capaEmpezada, 40000);
    await expect(baja(capaEmpezada)).rejects.toMatchObject({ status: 400 });
    await expect(baja(capaEmpezada, { saldoAFavor: 0, debe: 10 })).rejects.toMatchObject({ status: 400 });
  });

  it("saldo a favor: cancela la compra y acredita EXACTAMENTE lo que eligió Laura", async () => {
    const id = await compra(capaEmpezada, 100000);
    const r = await baja(capaEmpezada, { saldoAFavor: 20000 });
    expect(r).toMatchObject({ saldoAcreditado: 20000, debe: 0 });
    expect(await saldoAFavor()).toBe(20000);
    expect(await deuda(id)).toMatchObject({ cancelada: true });
  });

  it("el saldo a favor no puede pasar lo pagado", async () => {
    await compra(capaEmpezada, 40000);
    await expect(baja(capaEmpezada, { saldoAFavor: 50000 })).rejects.toMatchObject({ status: 400 });
  });

  it("debe 0 sin pagos: cancela y no queda deuda", async () => {
    const id = await compra(capaEmpezada);
    await baja(capaEmpezada, { debe: 0 });
    expect(await deuda(id)).toMatchObject({ cancelada: true });
  });

  it("queda debiendo: la compra no se cancela, debe lo que eligió Laura y sale de Inscriptas", async () => {
    const id = await compra(capaEmpezada, 40000);
    await turno(empezadaPasados[0]!, "completed");
    await anotarACapacitacion(db, { trainingId: capaEmpezada, customerId: clienta, ahora: AHORA });
    const r = await baja(capaEmpezada, { debe: 26667 });
    expect(r).toMatchObject({ encuentrosCancelados: 1, saldoAcreditado: 0, debe: 26667 });
    expect(await deuda(id)).toEqual({ debe: 26667, cancelada: false });
    // El turno del encuentro que ya pasó queda: es historia.
    expect((await turnosVivos()).map((t) => t.trainingSessionId)).toEqual([empezadaPasados[0]]);
    expect(await listInscriptas(db, capaEmpezada)).toHaveLength(0);
    // Volver a anotarla: como si no la hubiera comprado (no ofrece "Cobrar lo que falta").
    expect(await opcionesDeCapacitacion(db, { trainingId: capaEmpezada, customerId: clienta, ahora: AHORA })).toMatchObject({
      compraId: null, debe: 0,
    });
    await expect(anotarACapacitacion(db, { trainingId: capaEmpezada, customerId: clienta, ahora: AHORA })).rejects.toMatchObject({
      message: "No compró esta capacitación",
    });
  });

  it("la deuda no puede pasar lo que falta pagar del precio", async () => {
    await compra(capaEmpezada, 40000);
    await expect(baja(capaEmpezada, { debe: 70000 })).rejects.toMatchObject({ status: 400 });
  });
});

it("sin compra viva: 400 'No compró esta capacitación'", async () => {
  await expect(cuenta(capaNueva)).rejects.toMatchObject({ message: "No compró esta capacitación" });
  await expect(baja(capaNueva)).rejects.toMatchObject({ message: "No compró esta capacitación" });
});
