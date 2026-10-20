import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq, inArray, like, sql } from "drizzle-orm";
import * as schema from "../db/schema";
import { appointments, contacts, customers } from "../db/schema";
import type { Db } from "../db/client";
import { anotarACapacitacion, opcionesDeCapacitacion } from "./anotar.service";

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
  const [r] = (await db.execute(sql`
    INSERT INTO customer_purchase (customer_id, training_id, description, sessions_total, base_amount, discounted_amount, final_amount, cancelled_at, notes)
    VALUES (${customerId}, ${trainingId}, ${QA}, 1, 100, 0, 100, ${cancelada ? sql`now()` : sql`NULL`}, ${QA})
    RETURNING id`)) as unknown as { id: string }[];
  return r!.id;
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

describe("opcionesDeCapacitacion", () => {
  const op = (customerId = clientaId) => opcionesDeCapacitacion(db, { trainingId, customerId, ahora: AHORA });
  const turno = (customerId: string, sesionId: string, inicio: string) =>
    db.insert(appointments).values({
      customerId, trainingSessionId: sesionId, status: "scheduled",
      appointmentStart: new Date(inicio), appointmentEnd: new Date(new Date(inicio).getTime() + 7200_000), durationMinutes: 120,
    });

  it("sin compra: sin id y sin deuda; igual cuenta los encuentros que quedan", async () => {
    // activos que no pasaron: futura1, futura2 y la llena (la pasada y la de baja no)
    expect(await op(sinCompraId)).toEqual({ compraId: null, debe: 0, encuentrosAnotada: 0, encuentrosQueQuedan: 3 });
  });

  it("con compra viva y deuda: su id y lo que debe", async () => {
    const id = await compra(clientaId);
    expect(await op()).toMatchObject({ compraId: id, debe: 100 });
  });

  it("una compra cancelada no cuenta", async () => {
    await compra(clientaId, true);
    expect(await op()).toMatchObject({ compraId: null, debe: 0 });
  });

  it("encuentrosAnotada cuenta sólo turnos no cancelados de encuentros que quedan", async () => {
    await compra(clientaId);
    await turno(clientaId, sesFutura1, "2026-10-20T18:00:00Z");
    await turno(clientaId, sesFutura2, "2026-10-27T13:00:00Z").then(() =>
      db.update(appointments).set({ status: "cancelled" }).where(eq(appointments.trainingSessionId, sesFutura2)),
    );
    await turno(clientaId, sesPasada, "2026-10-20T12:00:00Z");
    expect(await op()).toMatchObject({ encuentrosAnotada: 1, encuentrosQueQuedan: 3 });
  });

  it("escenario del brief: 1 pasado, 1 de baja, 2 futuros activos y anotada en 1", async () => {
    const [t] = (await db.execute(sql`
      INSERT INTO training (id, name, max_participants, is_active) VALUES (gen_random_uuid(), ${QA + "_Capa2"}, 10, true) RETURNING id`)) as unknown as { id: string }[];
    const tid = t!.id;
    const ses = async (n: number, fecha: string, activo: boolean) => {
      const [r] = (await db.execute(sql`
        INSERT INTO training_sessions (training_id, session_number, session_date, start_time, end_time, is_active, notes)
        VALUES (${tid}, ${n}, ${fecha}::date, '10:00'::time, '12:00'::time, ${activo}, ${QA}) RETURNING id`)) as unknown as { id: string }[];
      return r!.id;
    };
    await ses(1, "2026-10-13", true); // pasado
    await ses(2, "2026-10-30", false); // de baja
    const f1 = await ses(3, "2026-10-27", true);
    await ses(4, "2026-11-03", true);
    await turno(clientaId, f1, "2026-10-27T13:00:00Z");
    expect(await opcionesDeCapacitacion(db, { trainingId: tid, customerId: clientaId, ahora: AHORA })).toEqual({
      compraId: null, debe: 0, encuentrosAnotada: 1, encuentrosQueQuedan: 2,
    });
  });

  it("con dos compras vivas devuelve la más reciente y su deuda", async () => {
    const insertar = async (monto: number, fecha: string) => {
      const [r] = (await db.execute(sql`
        INSERT INTO customer_purchase (customer_id, training_id, description, sessions_total, base_amount, discounted_amount, final_amount, purchased_at, notes)
        VALUES (${clientaId}, ${trainingId}, ${QA}, 1, ${monto}, 0, ${monto}, ${fecha}::timestamptz, ${QA}) RETURNING id`)) as unknown as { id: string }[];
      return r!.id;
    };
    await insertar(100, "2026-09-01T12:00:00Z");
    const nueva = await insertar(250, "2026-10-01T12:00:00Z");
    expect(await op()).toMatchObject({ compraId: nueva, debe: 250 });
  });
});
