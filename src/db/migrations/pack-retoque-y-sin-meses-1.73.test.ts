import { afterAll, describe, expect, it } from "vitest";
import postgres from "postgres";
// @ts-ignore -- el proyecto no incluye @types/node (solo workers-types); vitest corre en Node
import { execSync } from "node:child_process";

/**
 * Migración 1.73.0: 01 borra `validity_months` (#46) y 02 agrega
 * `combos.last_session_is_touchup` (#36). Cada test arma sus propias filas.
 */
const sql = postgres("postgresql://piubella:piubella@localhost:5499/piubella", {
  max: 1,
  fetch_types: false,
  prepare: false,
});
const M01 = "src/db/migrations/1.73.0/01-borrar-validity-months.sql";
const M02 = "src/db/migrations/1.73.0/02-pack-retoque.sql";
const TAG = `__t173_${Date.now()}`;

function aplicar(archivo: string): string {
  return execSync(
    `DOCKER_CONTEXT=default docker exec -i piubella-db psql -U piubella -d piubella -v ON_ERROR_STOP=1 < "${archivo}" 2>&1`,
    { stdio: "pipe" },
  ).toString();
}
const tieneColumna = async (tabla: string, col: string) =>
  (await sql`SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = ${tabla} AND column_name = ${col}`).length === 1;

async function reponerMeses() {
  await sql.unsafe("ALTER TABLE combos ADD COLUMN IF NOT EXISTS validity_months integer");
  await sql.unsafe("ALTER TABLE depilation_combo ADD COLUMN IF NOT EXISTS validity_months integer");
}

afterAll(async () => {
  await sql`DELETE FROM combos WHERE name LIKE ${TAG + "%"}`;
  await sql`DELETE FROM depilation_combo WHERE name LIKE ${TAG + "%"}`;
  await sql.end();
});

describe("1.73.0/01 — borra validity_months", () => {
  it("aborta sin borrar nada si hay un combo con meses y sin semanas", async () => {
    await reponerMeses();
    await sql.unsafe(
      `INSERT INTO combos (area_category_id, name, price_type, fixed_price, validity_months) VALUES ((SELECT id FROM categories LIMIT 1), '${TAG}_a', 'fixed', 100, 6)`,
    );
    expect(() => aplicar(M01)).toThrow();
    expect(await tieneColumna("combos", "validity_months")).toBe(true);
    expect(await tieneColumna("depilation_combo", "validity_months")).toBe(true);
  });

  it("aborta si es un pack de depilación el que tiene meses y no semanas", async () => {
    await reponerMeses();
    await sql`DELETE FROM combos WHERE name LIKE ${TAG + "%"}`;
    await sql.unsafe(
      `INSERT INTO depilation_combo (name, kind, fixed_price, validity_months) VALUES ('${TAG}_d', 'pack_fijo', 100, 6)`,
    );
    expect(() => aplicar(M01)).toThrow();
    expect(await tieneColumna("depilation_combo", "validity_months")).toBe(true);
  });

  it("borra las dos columnas cuando todo tiene semanas, y se puede correr dos veces", async () => {
    await reponerMeses();
    await sql`DELETE FROM depilation_combo WHERE name LIKE ${TAG + "%"}`;
    await sql.unsafe(
      `INSERT INTO combos (area_category_id, name, price_type, fixed_price, validity_months, validity_weeks) VALUES ((SELECT id FROM categories LIMIT 1), '${TAG}_b', 'fixed', 100, 6, 26)`,
    );
    aplicar(M01);
    expect(await tieneColumna("combos", "validity_months")).toBe(false);
    expect(await tieneColumna("depilation_combo", "validity_months")).toBe(false);
    aplicar(M01); // idempotente
    const [r] = await sql<{ w: number }[]>`SELECT validity_weeks AS w FROM combos WHERE name = ${TAG + "_b"}`;
    expect(r!.w).toBe(26);
  });
});

describe("1.73.0/02 — last_session_is_touchup", () => {
  it("crea la columna con default false y es idempotente", async () => {
    aplicar(M02);
    aplicar(M02);
    const [c] = await sql<{ d: string; n: string }[]>`
      SELECT column_default AS d, is_nullable AS n FROM information_schema.columns
       WHERE table_name = 'combos' AND column_name = 'last_session_is_touchup'`;
    expect(c).toEqual({ d: "false", n: "NO" });
  });

  it("un combo (no pack) no puede tenerla en true; un pack sí", async () => {
    aplicar(M02);
    await expect(
      sql.unsafe(
        `INSERT INTO combos (area_category_id, name, price_type, fixed_price, kind, last_session_is_touchup) VALUES ((SELECT id FROM categories LIMIT 1), '${TAG}_c', 'fixed', 100, 'combo', true)`,
      ),
    ).rejects.toThrow(/ck_combos_touchup_solo_pack/);
    await sql.unsafe(
      `INSERT INTO combos (area_category_id, name, price_type, fixed_price, kind, pack_sessions, last_session_is_touchup) VALUES ((SELECT id FROM categories LIMIT 1), '${TAG}_p', 'fixed', 100, 'pack', 2, true)`,
    );
    const [r] = await sql<{ t: boolean }[]>`SELECT last_session_is_touchup AS t FROM combos WHERE name = ${TAG + "_p"}`;
    expect(r!.t).toBe(true);
  });
});
