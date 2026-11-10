import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
// @ts-ignore -- el proyecto no incluye @types/node; vitest corre en Node
import { execSync } from "node:child_process";

/** Migración 1.69.0: price_adjustments acepta mode='planilla' (sin dirección, valor ni redondeo). */
const URL_DB = "postgresql://piubella:piubella@localhost:5499/piubella";
const sql = postgres(URL_DB, { max: 1, fetch_types: false, prepare: false });
const ARCHIVO = "src/db/migrations/1.69.0/01-historial-de-precios-por-planilla.sql";
const TAG = `ZZ_QA_PLANILLA_${Date.now()}`;

function aplicarMigracion() {
  execSync(
    `DOCKER_CONTEXT=default docker exec -i piubella-db psql -U piubella -d piubella -v ON_ERROR_STOP=1 < "${ARCHIVO}"`,
    { stdio: "pipe" },
  );
}

describe("migración 1.69.0 — historial de precios por planilla", () => {
  beforeAll(() => aplicarMigracion());
  afterAll(async () => {
    await sql`DELETE FROM price_adjustments WHERE user_email = ${TAG}`;
    await sql.end();
  });

  it("acepta una fila de planilla sin dirección, valor ni redondeo", async () => {
    const [r] = await sql<{ id: string }[]>`
      INSERT INTO price_adjustments (user_email, mode, direction, value, rounding, services_count)
      VALUES (${TAG}, 'planilla', NULL, NULL, NULL, 3) RETURNING id`;
    expect(r!.id).toBeTruthy();
  });

  it("es idempotente", () => {
    expect(() => aplicarMigracion()).not.toThrow();
    expect(() => aplicarMigracion()).not.toThrow();
  });

  it("sigue exigiendo mode", async () => {
    await expect(sql`
      INSERT INTO price_adjustments (user_email, mode, services_count)
      VALUES (${TAG}, NULL, 1)`).rejects.toThrow();
  });

  it("service.description es text", async () => {
    const [r] = await sql<{ data_type: string }[]>`
      SELECT data_type FROM information_schema.columns
      WHERE table_name = 'service' AND column_name = 'description'`;
    expect(r!.data_type).toBe("text");
  });
});
