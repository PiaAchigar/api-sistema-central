import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "../schema";
import type { Db } from "../client";
import type { AppBindings, Variables } from "../../env";
// @ts-ignore -- el proyecto no incluye @types/node (solo workers-types); vitest corre en Node
import { execSync } from "node:child_process";

// El router de actividades pide sesión: se reemplaza `auth` por uno que toma el rol de x-rol.
vi.mock("../../middleware/auth", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../middleware/auth")>();
  return {
    ...real,
    auth: async (c: any, next: any) => {
      const rol = c.req.header("x-rol") ?? null;
      c.set("userId", rol ? "u-test" : null);
      c.set("userRole", rol);
      await next();
    },
  };
});

const { auth } = await import("../../middleware/auth");
const { activitiesRouter } = await import("../../routes/activities");
const { activitiesRepository } = await import("../../repositories/activitiesRepository");

/**
 * Migración 1.60.0 (proveedora por horario) y alta de actividades sin proveedora,
 * contra la base local. Cada test arma sus propios datos (prefijo ZZ_QA_PH160).
 */
const URL_DB = "postgresql://piubella:piubella@localhost:5499/piubella";
const sql = postgres(URL_DB, { max: 1, fetch_types: false, prepare: false });
const db = drizzle(postgres(URL_DB, { max: 1, fetch_types: false, prepare: false }), { schema }) as unknown as Db;
const ENV = { HYPERDRIVE: { connectionString: URL_DB } } as unknown as AppBindings;

const QA = "ZZ_QA_PH160";
const ARCHIVO = "src/db/migrations/1.60.0/01-proveedora-por-horario.sql";

function aplicarMigracion() {
  execSync(
    `DOCKER_CONTEXT=default docker exec -i piubella-db psql -U piubella -d piubella -v ON_ERROR_STOP=1 < "${ARCHIVO}"`,
    { stdio: "pipe" },
  );
}

async function limpiar() {
  await sql`DELETE FROM activity_schedules WHERE activity_id IN (SELECT id FROM activities WHERE name LIKE ${QA + "%"})`;
  await sql`DELETE FROM activities WHERE name LIKE ${QA + "%"}`;
  await sql`DELETE FROM service_providers WHERE full_name LIKE ${QA + "%"}`;
}

const app = new Hono<{ Bindings: AppBindings; Variables: Variables }>();
app.use("*", auth);
app.route("/api", activitiesRouter);

const post = (body: unknown) =>
  app.request(
    "/api/activities",
    { method: "POST", headers: { "Content-Type": "application/json", "x-rol": "admin" }, body: JSON.stringify(body) },
    ENV,
  );

beforeAll(async () => {
  activitiesRepository.setDb(db);
  await limpiar();
});

afterAll(async () => {
  await limpiar();
  await sql.end();
});

describe("migración 1.60.0", () => {
  it("corrida dos veces deja la columna; el horario hereda la proveedora de la actividad", async () => {
    const [prov] = await sql`INSERT INTO service_providers (id, full_name) VALUES (gen_random_uuid(), ${QA + "_P"}) RETURNING id`;
    const [conP] = await sql`
      INSERT INTO activities (id, name, activity_type, monthly_base_price, service_provider_id)
      VALUES (gen_random_uuid(), ${QA + "_conP"}, 'class', 1000, ${prov!.id}) RETURNING id`;
    const [sinP] = await sql`
      INSERT INTO activities (id, name, activity_type, monthly_base_price)
      VALUES (gen_random_uuid(), ${QA + "_sinP"}, 'class', 1000) RETURNING id`;
    const [h1] = await sql`
      INSERT INTO activity_schedules (id, activity_id, day_of_week, start_time, end_time)
      VALUES (gen_random_uuid(), ${conP!.id}, 1, '10:00', '11:00') RETURNING id`;
    const [h2] = await sql`
      INSERT INTO activity_schedules (id, activity_id, day_of_week, start_time, end_time)
      VALUES (gen_random_uuid(), ${sinP!.id}, 1, '10:00', '11:00') RETURNING id`;

    aplicarMigracion();
    aplicarMigracion(); // idempotente

    const col = await sql`
      SELECT 1 FROM information_schema.columns
       WHERE table_name = 'activity_schedules' AND column_name = 'service_provider_id'`;
    expect(col.length).toBe(1);
    const prov1 = (await sql`SELECT service_provider_id FROM activity_schedules WHERE id = ${h1!.id}`)[0]!;
    const prov2 = (await sql`SELECT service_provider_id FROM activity_schedules WHERE id = ${h2!.id}`)[0]!;
    expect(prov1.service_provider_id).toBe(prov!.id);
    expect(prov2.service_provider_id).toBeNull();
  });
});

describe("POST /api/activities sin proveedora", () => {
  it("class sin serviceProviderId y con classesPerMonth 8 da 201", async () => {
    const res = await post({ name: QA + "_alta", activityType: "class", classesPerMonth: 8, monthlyBasePrice: 5000 });
    expect(res.status).toBe(201);
  });

  it("class con classesPerMonth 0 sigue dando 400", async () => {
    const res = await post({ name: QA + "_cero", activityType: "class", classesPerMonth: 0, monthlyBasePrice: 5000 });
    expect(res.status).toBe(400);
  });

  it("machine con classesPerMonth > 0 sigue dando 400", async () => {
    const res = await post({ name: QA + "_maq", activityType: "machine", classesPerMonth: 4, monthlyBasePrice: 5000 });
    expect(res.status).toBe(400);
  });
});
