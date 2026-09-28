import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "../db/schema";

// No hay helper compartido de conexión en este repo: cada `*.repo.test.ts`
// arma el suyo. `fetch_types: false` espeja las opciones de producción bajo
// Hyperdrive, que es donde los arrays como parámetro revientan.
const pgClient = postgres("postgresql://piubella:piubella@localhost:5499/piubella", {
  max: 1,
  fetch_types: false,
  prepare: false,
});
const db = drizzle(pgClient, { schema });
import {
  machines,
  serviceMachine,
  serviceProviderMachine,
  serviceProviderService,
  serviceProviders,
} from "../db/schema";
import { anclaDeDepilacion } from "./ancla-de-depilacion.repo";
import { habilitarMaquina, maquinasDeProveedora } from "./maquinas-de-proveedora.repo";
import { agregarEquipo, equiposDeDepilacion, sacarEquipo } from "./equipos-de-depilacion.repo";

const PROV = "ZZ_QA_EQUIPOS_prov";
const PROV_SIN_ACUERDO = "ZZ_QA_EQUIPOS_prov_sin_acuerdo";
const MAQ_DEPI = "ZZ_QA_EQUIPOS_depi";
const MAQ_AJENA = "ZZ_QA_EQUIPOS_ajena";

let ancla: string;
let provId: string;
let provSinAcuerdoId: string;
let maqDepiId: string;
let maqAjenaId: string;

beforeAll(async () => {
  ancla = await anclaDeDepilacion(db);

  const [p] = await db
    .insert(serviceProviders)
    .values({ fullName: PROV, status: "active" })
    .returning({ id: serviceProviders.id });
  provId = p!.id;

  // Sin fila en service_provider_service sobre el ancla: NO hace depilación.
  // Es la proveedora que prueba que sacarEquipo no le borra la certificación
  // de un equipo que usa en otra área (criolipólisis, HIFU, etc).
  const [pSinAcuerdo] = await db
    .insert(serviceProviders)
    .values({ fullName: PROV_SIN_ACUERDO, status: "active" })
    .returning({ id: serviceProviders.id });
  provSinAcuerdoId = pSinAcuerdo!.id;

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

  // La proveedora hace depilación: acuerdo vigente sobre el ancla.
  await db.insert(serviceProviderService).values({
    serviceProviderId: provId,
    serviceId: ancla,
    paymentType: "fixed_per_service",
    rate: "20000.00",
    isActive: true,
  });
});

afterAll(async () => {
  await db.delete(serviceMachine).where(
    and(eq(serviceMachine.serviceId, ancla), eq(serviceMachine.machineId, maqDepiId)),
  );
  await db.delete(serviceProviderMachine).where(eq(serviceProviderMachine.serviceProviderId, provId));
  await db
    .delete(serviceProviderMachine)
    .where(eq(serviceProviderMachine.serviceProviderId, provSinAcuerdoId));
  await db.delete(serviceProviderService).where(eq(serviceProviderService.serviceProviderId, provId));
  await db.delete(machines).where(eq(machines.id, maqDepiId));
  await db.delete(machines).where(eq(machines.id, maqAjenaId));
  await db.delete(serviceProviders).where(eq(serviceProviders.id, provId));
  await db.delete(serviceProviders).where(eq(serviceProviders.id, provSinAcuerdoId));
});

describe("equipos-de-depilacion", () => {
  it("agrega un equipo y lo devuelve al leer", async () => {
    await agregarEquipo(db, maqDepiId);
    const ids = (await equiposDeDepilacion(db)).map((e) => e.machineId);
    expect(ids).toContain(maqDepiId);
  });

  it("agregar dos veces no duplica", async () => {
    await agregarEquipo(db, maqDepiId);
    await agregarEquipo(db, maqDepiId);
    const filas = (await equiposDeDepilacion(db)).filter((e) => e.machineId === maqDepiId);
    expect(filas).toHaveLength(1);
  });

  it("sacar un equipo saca las certificaciones de ESE equipo y ninguna otra", async () => {
    await agregarEquipo(db, maqDepiId);
    await habilitarMaquina(db, provId, maqDepiId);
    // Ésta la usa para otra área: no la toca nadie.
    await habilitarMaquina(db, provId, maqAjenaId);
    // Certificada en el MISMO equipo de depilación, pero SIN acuerdo sobre
    // el ancla: es quien prueba que el filtro por acuerdo realmente filtra.
    await habilitarMaquina(db, provSinAcuerdoId, maqDepiId);

    await sacarEquipo(db, maqDepiId);

    const ids = (await maquinasDeProveedora(db, provId)).map((m) => m.machineId);
    expect(ids).not.toContain(maqDepiId);
    expect(ids).toContain(maqAjenaId);
    expect((await equiposDeDepilacion(db)).map((e) => e.machineId)).not.toContain(maqDepiId);

    // Sin acuerdo sobre el ancla: sacarEquipo no la toca, conserva la
    // certificación en el equipo que usa en su propia área.
    const idsSinAcuerdo = (await maquinasDeProveedora(db, provSinAcuerdoId)).map((m) => m.machineId);
    expect(idsSinAcuerdo).toContain(maqDepiId);
  });
});
