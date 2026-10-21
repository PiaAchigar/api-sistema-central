import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Db } from "../db/client";
import { anclaDeDepilacion } from "./ancla-de-depilacion.repo";
import { getOfertaDeProveedora } from "./oferta-de-proveedora.repo";

// Lo que ofrece una prestadora: con esto el "Nuevo turno" desde su columna
// muestra sólo lo suyo (pedido de Pia, 2026-10-22).
const URL = "postgresql://piubella:piubella@localhost:5499/piubella";
const pg = postgres(URL, { max: 1, fetch_types: false, prepare: false });
const db = drizzle(pg, { schema }) as unknown as Db;

const QA = "ZZ_QA_OFERTA";
// Jueves 22 de octubre de 2026, 11:00 ART.
const HOY = "2026-10-22";

let ana = "";
let otra = "";
let suyo = "";
let ajeno = "";
let noVendible = "";
let pilates = "";
let yoga = "";
let capaFutura = "";
let capaPasada = "";

const uno = async (q: ReturnType<typeof sql>) => ((await db.execute(q)) as unknown as { id: string }[])[0]!.id;

async function limpiar() {
  await db.execute(sql`DELETE FROM service_provider_service WHERE service_provider_id IN (SELECT id FROM service_providers WHERE full_name LIKE ${QA + "%"})`);
  await db.execute(sql`DELETE FROM activity_schedules WHERE activity_id IN (SELECT id FROM activities WHERE name LIKE ${QA + "%"})`);
  await db.execute(sql`DELETE FROM activities WHERE name LIKE ${QA + "%"}`);
  await db.execute(sql`DELETE FROM training_sessions WHERE training_id IN (SELECT id FROM training WHERE name LIKE ${QA + "%"})`);
  await db.execute(sql`DELETE FROM training WHERE name LIKE ${QA + "%"}`);
  await db.execute(sql`DELETE FROM service WHERE name LIKE ${QA + "%"}`);
  await db.execute(sql`DELETE FROM service_providers WHERE full_name LIKE ${QA + "%"}`);
}

const habilitar = (prov: string, serv: string, activo = true) =>
  db.execute(sql`
    INSERT INTO service_provider_service (id, service_provider_id, service_id, payment_type, rate, is_active)
    VALUES (gen_random_uuid(), ${prov}, ${serv}, 'percentage', 10, ${activo})`);

beforeAll(async () => {
  await limpiar();
  ana = await uno(sql`INSERT INTO service_providers (id, full_name) VALUES (gen_random_uuid(), ${QA + "_Ana"}) RETURNING id`);
  otra = await uno(sql`INSERT INTO service_providers (id, full_name) VALUES (gen_random_uuid(), ${QA + "_Otra"}) RETURNING id`);
  const servicio = (nombre: string) =>
    uno(sql`INSERT INTO service (id, name, is_active, no_vendible) VALUES (gen_random_uuid(), ${`${QA}_${nombre}`}, true, false) RETURNING id`);
  suyo = await servicio("Limpieza");
  ajeno = await servicio("Masaje");
  noVendible = await uno(sql`INSERT INTO service (id, name, is_active, no_vendible) VALUES (gen_random_uuid(), ${QA + "_Interno"}, true, true) RETURNING id`);
  await habilitar(ana, suyo);
  await habilitar(ana, noVendible);
  await habilitar(otra, ajeno);
  await habilitar(ana, ajeno, false); // dada de baja de ese servicio

  const actividad = (nombre: string) =>
    uno(sql`INSERT INTO activities (id, name, monthly_base_price, activity_type, is_active) VALUES (gen_random_uuid(), ${`${QA}_${nombre}`}, 1000, 'class', true) RETURNING id`);
  pilates = await actividad("Pilates");
  yoga = await actividad("Yoga");
  const horario = (act: string, prov: string, extra: { activo?: boolean; hasta?: string | null } = {}) =>
    db.execute(sql`
      INSERT INTO activity_schedules (id, activity_id, day_of_week, start_time, end_time, is_active, valid_until, service_provider_id)
      VALUES (gen_random_uuid(), ${act}, 3, '12:00', '13:00', ${extra.activo ?? true}, ${extra.hasta ?? null}, ${prov})`);
  await horario(pilates, ana);
  await horario(pilates, ana); // dos horarios de la misma actividad: sale una vez
  await horario(yoga, ana, { hasta: "2026-09-30" }); // vencido
  await horario(yoga, otra);

  const capacitacion = async (nombre: string, fecha: string) => {
    const t = await uno(sql`INSERT INTO training (id, name, is_active) VALUES (gen_random_uuid(), ${`${QA}_${nombre}`}, true) RETURNING id`);
    await db.execute(sql`
      INSERT INTO training_sessions (training_id, session_number, session_date, start_time, end_time, is_active, service_provider_id)
      VALUES (${t}, 1, ${fecha}::date, '10:00', '12:00', true, ${ana})`);
    return t;
  };
  capaFutura = await capacitacion("Instructorado", "2026-11-05");
  capaPasada = await capacitacion("Vieja", "2026-09-01");
});

afterAll(async () => {
  await limpiar();
  await pg.end();
});

describe("getOfertaDeProveedora", () => {
  it("servicios: sólo los vendibles y activos que tiene habilitados", async () => {
    const o = await getOfertaDeProveedora(db, ana, HOY);
    expect(o.servicios).toContain(suyo);
    expect(o.servicios).not.toContain(ajeno);
    expect(o.servicios).not.toContain(noVendible);
  });

  it("actividades: las que dicta en un horario vigente, sin repetir", async () => {
    const o = await getOfertaDeProveedora(db, ana, HOY);
    expect(o.actividades.filter((a) => a.id === pilates)).toEqual([{ id: pilates, nombre: `${QA}_Pilates` }]);
    expect(o.actividades.map((a) => a.id)).not.toContain(yoga);
  });

  it("capacitaciones: las que tienen un encuentro suyo que todavía no pasó", async () => {
    const o = await getOfertaDeProveedora(db, ana, HOY);
    expect(o.capacitaciones.map((c) => c.id)).toContain(capaFutura);
    expect(o.capacitaciones.map((c) => c.id)).not.toContain(capaPasada);
  });

  it("depilación: sí sólo si está habilitada en el servicio ancla", async () => {
    expect((await getOfertaDeProveedora(db, otra, HOY)).depilacion).toBe(false);
    const ancla = await anclaDeDepilacion(db);
    await habilitar(otra, ancla);
    try {
      expect((await getOfertaDeProveedora(db, otra, HOY)).depilacion).toBe(true);
    } finally {
      await db.execute(sql`DELETE FROM service_provider_service WHERE service_provider_id = ${otra} AND service_id = ${ancla}`);
    }
  });
});
