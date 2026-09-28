import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import * as schema from "../db/schema";
import { machines, serviceProviderMachine, serviceProviders } from "../db/schema";
import type { Db } from "../db/client";
import {
  deshabilitarMaquina,
  habilitarMaquina,
  maquinasDeProveedora,
} from "./maquinas-de-proveedora.repo";

// `fetch_types: false` a propósito: espeja las opciones de producción bajo
// Hyperdrive, que es donde los arrays como parámetro revientan.
const pgClient = postgres("postgresql://piubella:piubella@localhost:5499/piubella", {
  max: 1,
  fetch_types: false,
  prepare: false,
});
const db = drizzle(pgClient, { schema }) as unknown as Db;

const PROV = "ZZ_QA_MAQPROV_prov";
const MAQ_DEPI = "ZZ_QA_MAQPROV_depi";
const MAQ_AJENA = "ZZ_QA_MAQPROV_ajena";

let provId: string;
let maqDepiId: string;
let maqAjenaId: string;

beforeAll(async () => {
  const [p] = await db
    .insert(serviceProviders)
    .values({ fullName: PROV, status: "active" })
    .returning({ id: serviceProviders.id });
  provId = p!.id;

  // `machines.id` no tiene DEFAULT en Postgres: lo genera Drizzle en runtime.
  const [m1] = await db
    .insert(machines)
    .values({ name: MAQ_DEPI, status: "active" })
    .returning({ id: machines.id });
  const [m2] = await db
    .insert(machines)
    .values({ name: MAQ_AJENA, status: "active" })
    .returning({ id: machines.id });
  maqDepiId = m1!.id;
  maqAjenaId = m2!.id;
});

afterAll(async () => {
  await db.delete(serviceProviderMachine).where(eq(serviceProviderMachine.serviceProviderId, provId));
  await db.delete(machines).where(eq(machines.id, maqDepiId));
  await db.delete(machines).where(eq(machines.id, maqAjenaId));
  await db.delete(serviceProviders).where(eq(serviceProviders.id, provId));
  await pgClient.end();
});

describe("maquinas-de-proveedora", () => {
  it("habilita un par y lo devuelve al leer", async () => {
    await habilitarMaquina(db, provId, maqDepiId);
    const filas = await maquinasDeProveedora(db, provId);
    expect(filas.map((f) => f.machineId)).toContain(maqDepiId);
    expect(filas.find((f) => f.machineId === maqDepiId)?.machineName).toBe(MAQ_DEPI);
  });

  it("habilitar dos veces no duplica", async () => {
    await habilitarMaquina(db, provId, maqDepiId);
    await habilitarMaquina(db, provId, maqDepiId);
    const filas = await maquinasDeProveedora(db, provId);
    expect(filas.filter((f) => f.machineId === maqDepiId)).toHaveLength(1);
  });

  it("deshabilitar saca SOLO ese par y deja intactas las otras máquinas", async () => {
    // Ésta es la máquina que la proveedora usa para OTRA área del salón.
    await habilitarMaquina(db, provId, maqAjenaId);
    await habilitarMaquina(db, provId, maqDepiId);

    await deshabilitarMaquina(db, provId, maqDepiId);

    const ids = (await maquinasDeProveedora(db, provId)).map((f) => f.machineId);
    expect(ids).not.toContain(maqDepiId);
    expect(ids).toContain(maqAjenaId);
  });

  it("deshabilitar un par que no existe no rompe", async () => {
    await expect(deshabilitarMaquina(db, provId, maqDepiId)).resolves.toBeUndefined();
  });
});
