import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq, inArray, like } from "drizzle-orm";
import * as schema from "../db/schema";
import { appointments, serviceProviders, training, trainingSessions } from "../db/schema";
import type { Db } from "../db/client";
import { crearEncuentro, editarEncuentro, generarEncuentros, listEncuentros } from "./training-sessions.repo";

/** Encuentros de capacitación contra la base local, con datos propios ZZ_QA_. */
const pgClient = postgres("postgresql://piubella:piubella@localhost:5499/piubella", {
  max: 1,
  fetch_types: false,
  prepare: false,
});
const db = drizzle(pgClient, { schema }) as unknown as Db;

const QA = "ZZ_QA_ENCUENTROS";
let capId: string;
let provId: string;

// Los turnos no se borran con el encuentro (training_session_id es ON DELETE
// SET NULL), así que se marcan en notes y se borran por esa marca.
async function limpiarTurnos() {
  await db.delete(appointments).where(like(appointments.notes, `${QA}%`));
}

async function limpiar() {
  await limpiarTurnos();
  const caps = await db.select({ id: training.id }).from(training).where(like(training.name, `${QA}%`));
  const ids = caps.map((c) => c.id);
  if (ids.length) {
    const ses = await db
      .select({ id: trainingSessions.id })
      .from(trainingSessions)
      .where(inArray(trainingSessions.trainingId, ids));
    if (ses.length) {
      await db.delete(appointments).where(inArray(appointments.trainingSessionId, ses.map((s) => s.id)));
    }
    await db.delete(trainingSessions).where(inArray(trainingSessions.trainingId, ids));
    await db.delete(training).where(inArray(training.id, ids));
  }
  await db.delete(serviceProviders).where(like(serviceProviders.fullName, `${QA}%`));
}

beforeAll(async () => {
  await limpiar();
  const [p] = await db.insert(serviceProviders).values({ fullName: `${QA}_prov` }).returning({ id: serviceProviders.id });
  provId = p!.id;
});
afterAll(async () => {
  await limpiar();
  await pgClient.end();
});
beforeEach(async () => {
  await limpiarTurnos();
  await db.delete(trainingSessions).where(eq(trainingSessions.trainingId, capId ?? "00000000-0000-0000-0000-000000000000"));
  if (capId) await db.delete(training).where(eq(training.id, capId));
  const [c] = await db.insert(training).values({ name: `${QA}_cap`, totalSessions: 3 }).returning({ id: training.id });
  capId = c!.id;
});

const base = { desde: "2026-11-02", diaDeLaSemana: 3, startTime: "10:00:00", endTime: "12:00:00" };

describe("generarEncuentros", () => {
  it("arma fechas semanales desde el primer día de la semana pedido", async () => {
    const r = await generarEncuentros(db, capId, { ...base, cantidad: 4 });
    expect(r.map((e) => e.sessionDate)).toEqual(["2026-11-04", "2026-11-11", "2026-11-18", "2026-11-25"]);
    expect(r.map((e) => e.sessionNumber)).toEqual([1, 2, 3, 4]);
    expect(r[0]!.startTime).toBe("10:00:00");
  });

  it("sin cantidad usa total_sessions de la capacitación", async () => {
    const r = await generarEncuentros(db, capId, base);
    expect(r).toHaveLength(3);
  });

  it("rechaza con 409 aunque los encuentros existentes estén todos inactivos", async () => {
    const e = await crearEncuentro(db, capId, {
      sessionNumber: 1, sessionDate: "2026-11-04", startTime: "10:00:00", endTime: "12:00:00",
    });
    await editarEncuentro(db, e.id, { isActive: false });
    await expect(generarEncuentros(db, capId, base)).rejects.toMatchObject({
      status: 409,
      message: "Esta capacitación ya tiene encuentros: editalos uno por uno",
    });
  });

  it("rechaza con 409 si no hay cantidad ni total_sessions", async () => {
    await db.update(training).set({ totalSessions: null }).where(eq(training.id, capId));
    await expect(generarEncuentros(db, capId, base)).rejects.toMatchObject({ status: 409 });
  });

  it("rechaza con 409 si ya hay encuentros activos", async () => {
    await generarEncuentros(db, capId, base);
    await expect(generarEncuentros(db, capId, base)).rejects.toMatchObject({
      status: 409,
      message: "Esta capacitación ya tiene encuentros: editalos uno por uno",
    });
  });
});

describe("listEncuentros / editarEncuentro", () => {
  it("cuenta anotadas ignorando turnos cancelados y trae providerName", async () => {
    const e = await crearEncuentro(db, capId, {
      sessionNumber: 1, sessionDate: "2026-11-04", startTime: "10:00:00", endTime: "12:00:00", serviceProviderId: provId,
    });
    const t = new Date("2026-11-04T13:00:00Z");
    await db.insert(appointments).values([
      { trainingSessionId: e.id, status: "scheduled", notes: `${QA}_t1`, appointmentStart: t, appointmentEnd: t },
      { trainingSessionId: e.id, status: "cancelled", notes: `${QA}_t2`, appointmentStart: t, appointmentEnd: t },
    ]);
    const [r] = await listEncuentros(db, capId, {});
    expect(r!.anotadas).toBe(1);
    expect(r!.providerName).toBe(`${QA}_prov`);
  });

  it("un encuentro desactivado no aparece salvo incluirInactivos", async () => {
    const e = await crearEncuentro(db, capId, {
      sessionNumber: 1, sessionDate: "2026-11-04", startTime: "10:00:00", endTime: "12:00:00",
    });
    const ed = await editarEncuentro(db, e.id, { isActive: false });
    expect(ed.isActive).toBe(false);
    expect(await listEncuentros(db, capId, {})).toHaveLength(0);
    expect(await listEncuentros(db, capId, { incluirInactivos: true })).toHaveLength(1);
  });

  it("editar un encuentro inexistente da 404", async () => {
    await expect(
      editarEncuentro(db, "00000000-0000-0000-0000-000000000000", { location: "x" }),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe("número de encuentro repetido", () => {
  const datos = { sessionDate: "2026-11-04", startTime: "10:00:00", endTime: "12:00:00" };

  it("crear con un número ya usado da 409 (no 500)", async () => {
    await crearEncuentro(db, capId, { sessionNumber: 1, ...datos });
    await expect(crearEncuentro(db, capId, { sessionNumber: 1, ...datos })).rejects.toMatchObject({
      status: 409,
      message: "Ya hay un encuentro N.º 1 en esta capacitación",
    });
  });

  it("editar al número de otro encuentro da 409 (no 500)", async () => {
    await crearEncuentro(db, capId, { sessionNumber: 1, ...datos });
    const b = await crearEncuentro(db, capId, { sessionNumber: 2, ...datos });
    await expect(editarEncuentro(db, b.id, { sessionNumber: 1 })).rejects.toMatchObject({
      status: 409,
      message: "Ya hay un encuentro N.º 1 en esta capacitación",
    });
  });
});
