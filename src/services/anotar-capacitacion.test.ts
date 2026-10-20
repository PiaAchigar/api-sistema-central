import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq, inArray, like, sql } from "drizzle-orm";
import * as schema from "../db/schema";
import { appointments, contacts, customers } from "../db/schema";
import type { Db } from "../db/client";
import { anotarACapacitacion } from "./anotar.service";

const URL = "postgresql://piubella:piubella@localhost:5499/piubella";
const pg = postgres(URL, { max: 2, fetch_types: false, prepare: false });
const db = drizzle(pg, { schema }) as unknown as Db;

const QA = "ZZ_QA_ANOTAR_CAPA";
// Martes 20 de octubre de 2026, 11:00 ART (= 14:00 UTC).
const AHORA = new Date("2026-10-20T14:00:00Z");

let trainingId = "";
let clientaId = "";
let otraClientaId = "";
let sinCompraId = "";
let sesPasada = "";
let sesFutura1 = "";
let sesFutura2 = "";
let sesBaja = "";
let sesLlena = "";

async function crearClienta(nombre: string) {
  const [ct] = await db.insert(contacts).values({ name: `${QA}_${nombre}` }).returning({ id: contacts.id });
  const [cu] = await db.insert(customers).values({ contactId: ct!.id }).returning({ id: customers.id });
  return cu!.id;
}

async function sesion(n: number, fecha: string, hora: string, extra: { activo?: boolean; capacidad?: number } = {}) {
  const [r] = (await db.execute(sql`
    INSERT INTO training_sessions (training_id, session_number, session_date, start_time, end_time, is_active, capacity, notes)
    VALUES (${trainingId}, ${n}, ${fecha}::date, ${hora}::time, (${hora}::time + interval '2 hours'), ${extra.activo ?? true}, ${extra.capacidad ?? null}, ${QA})
    RETURNING id`)) as unknown as { id: string }[];
  return r!.id;
}

async function compra(customerId: string, cancelada = false) {
  await db.execute(sql`
    INSERT INTO customer_purchase (customer_id, training_id, description, sessions_total, base_amount, discounted_amount, final_amount, cancelled_at, notes)
    VALUES (${customerId}, ${trainingId}, ${QA}, 1, 100, 0, 100, ${cancelada ? sql`now()` : sql`NULL`}, ${QA})`);
}

async function limpiar() {
  const cts = await db.select({ id: contacts.id }).from(contacts).where(like(contacts.name, `${QA}%`));
  const cuIds: string[] = [];
  for (const ct of cts) {
    const cus = await db.select({ id: customers.id }).from(customers).where(eq(customers.contactId, ct.id));
    cuIds.push(...cus.map((c) => c.id));
  }
  if (cuIds.length) {
    await db.delete(appointments).where(inArray(appointments.customerId, cuIds));
    await db.execute(sql`DELETE FROM payments WHERE customer_id IN (${sql.join(cuIds.map((i) => sql`${i}::uuid`), sql`, `)})`);
    await db.execute(sql`DELETE FROM customer_purchase WHERE customer_id IN (${sql.join(cuIds.map((i) => sql`${i}::uuid`), sql`, `)})`);
    await db.delete(customers).where(inArray(customers.id, cuIds));
  }
  for (const ct of cts) await db.delete(contacts).where(eq(contacts.id, ct.id));
  await db.execute(sql`DELETE FROM appointments WHERE training_session_id IN (SELECT ts.id FROM training_sessions ts JOIN training t ON t.id = ts.training_id WHERE t.name LIKE ${QA + "%"})`);
  await db.execute(sql`DELETE FROM training_sessions WHERE training_id IN (SELECT id FROM training WHERE name LIKE ${QA + "%"})`);
  await db.execute(sql`DELETE FROM training WHERE name LIKE ${QA + "%"}`);
}

beforeAll(async () => {
  await limpiar();
  const [t] = (await db.execute(sql`
    INSERT INTO training (id, name, max_participants, is_active) VALUES (gen_random_uuid(), ${QA + "_Capa"}, 10, true) RETURNING id`)) as unknown as { id: string }[];
  trainingId = t!.id;
  sesPasada = await sesion(1, "2026-10-20", "09:00"); // hoy, ya pasó (11:00)
  sesFutura1 = await sesion(2, "2026-10-20", "15:00"); // hoy, todavía no
  sesFutura2 = await sesion(3, "2026-10-27", "10:00");
  sesBaja = await sesion(4, "2026-11-03", "10:00", { activo: false });
  sesLlena = await sesion(5, "2026-11-10", "10:00", { capacidad: 1 });
  clientaId = await crearClienta("CLIENTA");
  otraClientaId = await crearClienta("OTRA");
  sinCompraId = await crearClienta("SINCOMPRA");
});

beforeEach(async () => {
  await db.delete(appointments).where(inArray(appointments.customerId, [clientaId, otraClientaId, sinCompraId]));
  await db.execute(sql`DELETE FROM customer_purchase WHERE notes = ${QA}`);
});

afterAll(async () => {
  await limpiar();
  await pg.end();
});

async function turnosDe(customerId: string) {
  return db.select().from(appointments).where(eq(appointments.customerId, customerId));
}

describe("anotarACapacitacion", () => {
  it("anota en los encuentros futuros activos y saltea el pasado y el dado de baja", async () => {
    await compra(clientaId);
    const r = await anotarACapacitacion(db, { trainingId, customerId: clientaId, ahora: AHORA });
    expect(r).toEqual({ anotada: 3, yaEstaba: 0, sinLugar: [] });
    const turnos = await turnosDe(clientaId);
    const ids = turnos.map((x) => x.trainingSessionId).sort();
    expect(ids).toEqual([sesFutura1, sesFutura2, sesLlena].sort());
    expect(ids).not.toContain(sesPasada);
    expect(ids).not.toContain(sesBaja);
    expect(turnos[0]!.status).toBe("scheduled");
    expect(turnos[0]!.isTrial).toBe(false);
  });

  it("un encuentro lleno queda en sinLugar con su número", async () => {
    await compra(clientaId);
    await compra(otraClientaId);
    await anotarACapacitacion(db, { trainingId, customerId: otraClientaId, ahora: AHORA }); // ocupa el único lugar
    const r = await anotarACapacitacion(db, { trainingId, customerId: clientaId, ahora: AHORA });
    expect(r).toEqual({ anotada: 2, yaEstaba: 0, sinLugar: [5] });
  });

  it("la segunda vez cuenta yaEstaba y no anota nada", async () => {
    await compra(clientaId);
    await anotarACapacitacion(db, { trainingId, customerId: clientaId, ahora: AHORA });
    const r = await anotarACapacitacion(db, { trainingId, customerId: clientaId, ahora: AHORA });
    expect(r).toEqual({ anotada: 0, yaEstaba: 3, sinLugar: [] });
    expect(await turnosDe(clientaId)).toHaveLength(3);
  });

  it("compra cancelada o inexistente: 400", async () => {
    await compra(clientaId, true);
    await expect(anotarACapacitacion(db, { trainingId, customerId: clientaId, ahora: AHORA })).rejects.toMatchObject({
      message: "No compró esta capacitación",
    });
    await expect(anotarACapacitacion(db, { trainingId, customerId: sinCompraId, ahora: AHORA })).rejects.toMatchObject({
      message: "No compró esta capacitación",
    });
  });
});
