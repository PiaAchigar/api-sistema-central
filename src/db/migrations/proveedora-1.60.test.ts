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

describe("migración 1.60.0: alinea los turnos futuros", () => {
  it("el turno futuro con la proveedora vieja pasa a la del horario; el pasado, el cancelado y el de otra hora no; dos corridas = una", async () => {
    const [vieja] = await sql`INSERT INTO service_providers (id, full_name) VALUES (gen_random_uuid(), ${QA + "_Vieja"}) RETURNING id`;
    const [nueva] = await sql`INSERT INTO service_providers (id, full_name) VALUES (gen_random_uuid(), ${QA + "_Nueva"}) RETURNING id`;
    const [act] = await sql`
      INSERT INTO activities (id, name, activity_type, monthly_base_price, service_provider_id)
      VALUES (gen_random_uuid(), ${QA + "_alinea"}, 'class', 1000, ${vieja!.id}) RETURNING id`;
    // Miércoles 12:00 ART, con la proveedora NUEVA ya cargada en el horario.
    await sql`
      INSERT INTO activity_schedules (id, activity_id, day_of_week, start_time, end_time, service_provider_id)
      VALUES (gen_random_uuid(), ${act!.id}, 3, '12:00', '13:00', ${nueva!.id})`;
    const [ct] = await sql`INSERT INTO contacts (id, name) VALUES (gen_random_uuid(), ${QA + "_ct"}) RETURNING id`;
    const [cu] = await sql`INSERT INTO customers (id, contact_id) VALUES (gen_random_uuid(), ${ct!.id}) RETURNING id`;
    const turno = async (inicioUtc: string, status = "scheduled") => {
      const [t] = await sql`
        INSERT INTO appointments (id, customer_id, activity_id, service_provider_id, status, appointment_start, appointment_end, duration_minutes)
        VALUES (gen_random_uuid(), ${cu!.id}, ${act!.id}, ${vieja!.id}, ${status},
                ${inicioUtc}::text::timestamp, (${inicioUtc}::text::timestamp + interval '1 hour'), 60) RETURNING id`;
      return t!.id as string;
    };
    try {
      const futuro = await turno("2030-01-02 15:00:00");          // mié 12:00 ART
      const pasado = await turno("2026-03-04 15:00:00");          // mié 12:00 ART, ya pasó
      const cancelado = await turno("2030-01-09 15:00:00", "cancelled");
      const otraHora = await turno("2030-01-02 16:00:00");        // mié 13:00 ART: no es de este horario
      const prov = async (id: string) => (await sql`SELECT service_provider_id FROM appointments WHERE id = ${id}`)[0]!.service_provider_id;

      aplicarMigracion();
      expect(await prov(futuro)).toBe(nueva!.id);
      expect(await prov(pasado)).toBe(vieja!.id);
      expect(await prov(cancelado)).toBe(vieja!.id);
      expect(await prov(otraHora)).toBe(vieja!.id);

      const [antes] = await sql`SELECT updated_at FROM appointments WHERE id = ${futuro}`;
      aplicarMigracion(); // idempotente: no vuelve a tocar nada
      const [despues] = await sql`SELECT updated_at FROM appointments WHERE id = ${futuro}`;
      expect(despues!.updated_at).toEqual(antes!.updated_at);
      expect(await prov(futuro)).toBe(nueva!.id);
    } finally {
      await sql`DELETE FROM appointments WHERE customer_id = ${cu!.id}`;
      await sql`DELETE FROM customers WHERE id = ${cu!.id}`;
      await sql`DELETE FROM contacts WHERE id = ${ct!.id}`;
    }
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
