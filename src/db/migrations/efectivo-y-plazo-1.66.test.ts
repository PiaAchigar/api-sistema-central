import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
// @ts-ignore -- el proyecto no incluye @types/node (solo workers-types); vitest corre en Node
import { execSync } from "node:child_process";

/**
 * Migración 1.66.0: efectivo de combos, plazo en semanas y aplazos de compras
 * (#30, #31). Cada test arma sus propios servicios y combos: no depende del
 * catálogo ni de la config que Laura edita.
 */
const URL_DB = "postgresql://piubella:piubella@localhost:5499/piubella";
const sql = postgres(URL_DB, { max: 1, fetch_types: false, prepare: false });
const ARCHIVO = "src/db/migrations/1.66.0/01-efectivo-y-plazo.sql";
const TAG = `__t166_${Date.now()}`;

function aplicarMigracion() {
  execSync(
    `DOCKER_CONTEXT=default docker exec -i piubella-db psql -U piubella -d piubella -v ON_ERROR_STOP=1 < "${ARCHIVO}"`,
    { stdio: "pipe" },
  );
}

const creados = { combos: [] as string[], servicios: [] as string[], depi: [] as string[] };

async function servicio(lista: number, efectivo: number | null): Promise<string> {
  const [r] = await sql<{ id: string }[]>`
    INSERT INTO service (id, name, unit_price_list, unit_price_cash)
    VALUES (gen_random_uuid(), ${TAG}, ${lista}, ${efectivo}) RETURNING id`;
  creados.servicios.push(r!.id);
  return r!.id;
}

async function combo(meses: number | null): Promise<string> {
  const [area] = await sql<{ id: string }[]>`SELECT id FROM categories LIMIT 1`;
  const [r] = await sql<{ id: string }[]>`
    INSERT INTO combos (name, price_type, fixed_price, validity_months, area_category_id)
    VALUES (${TAG}, 'fixed', 100, ${meses}, ${area!.id}) RETURNING id`;
  creados.combos.push(r!.id);
  return r!.id;
}

async function packDepi(meses: number | null): Promise<string> {
  const [r] = await sql<{ id: string }[]>`
    INSERT INTO depilation_combo (name, kind, fixed_price, validity_months)
    VALUES (${TAG + Math.random()}, 'pack_fijo', 100, ${meses}) RETURNING id`;
  creados.depi.push(r!.id);
  return r!.id;
}

describe("migración 1.66.0 — efectivo de combos y plazo en semanas", () => {
  beforeAll(() => aplicarMigracion());

  afterAll(async () => {
    if (creados.combos.length) await sql`DELETE FROM combos WHERE id IN ${sql(creados.combos)}`;
    if (creados.depi.length) await sql`DELETE FROM depilation_combo WHERE id IN ${sql(creados.depi)}`;
    if (creados.servicios.length) await sql`DELETE FROM service WHERE id IN ${sql(creados.servicios)}`;
    await sql.end();
  });

  it("crea las columnas y la tabla con RLS", async () => {
    const cols = await sql<{ t: string; c: string }[]>`
      SELECT table_name AS t, column_name AS c FROM information_schema.columns
      WHERE (table_name, column_name) IN (
        ('combo_service', 'service_price_cash'), ('combos', 'fixed_price_cash'),
        ('combos', 'validity_weeks'), ('depilation_combo', 'validity_weeks'),
        ('customer_purchase', 'price_mode'))`;
    expect(cols).toHaveLength(5);
    const [t] = await sql<{ rls: boolean }[]>`
      SELECT relrowsecurity AS rls FROM pg_class WHERE relname = 'purchase_expiry_postponements'`;
    expect(t?.rls).toBe(true);
  });

  it("congela el efectivo de cada renglón: cash si hay, si no lista", async () => {
    const conCash = await servicio(1000, 900);
    const sinCash = await servicio(500, null);
    const c = await combo(1);
    await sql`INSERT INTO combo_service (combo_id, service_id, sessions_included, service_price)
              VALUES (${c}, ${conCash}, 1, NULL), (${c}, ${sinCash}, 1, NULL)`;
    aplicarMigracion();
    const rows = await sql<{ service_id: string; p: string }[]>`
      SELECT service_id, service_price_cash AS p FROM combo_service WHERE combo_id = ${c}`;
    const por = Object.fromEntries(rows.map((r) => [r.service_id, Number(r.p)]));
    expect(por[conCash]).toBe(900);
    expect(por[sinCash]).toBe(500);
  });

  it("no pisa un service_price_cash ya cargado", async () => {
    const s = await servicio(1000, 900);
    const c = await combo(1);
    await sql`INSERT INTO combo_service (combo_id, service_id, sessions_included, service_price_cash)
              VALUES (${c}, ${s}, 1, 777)`;
    aplicarMigracion();
    const [r] = await sql<{ p: string }[]>`SELECT service_price_cash AS p FROM combo_service WHERE combo_id = ${c}`;
    expect(Number(r!.p)).toBe(777);
  });

  it("convierte los meses a semanas redondeando para arriba", async () => {
    const casos: [number | null, number | null][] = [[1, 5], [2, 9], [12, 52], [null, null]];
    const ids = [];
    for (const [m] of casos) {
      ids.push({ combo: await combo(m), depi: await packDepi(m) });
    }
    aplicarMigracion();
    for (const [i, [, semanas]] of casos.entries()) {
      const { combo: cid, depi } = ids[i]!;
      {
        const [r] = await sql<{ w: number | null }[]>`SELECT validity_weeks AS w FROM combos WHERE id = ${cid}`;
        expect(r!.w).toBe(semanas);
      }
      const [d] = await sql<{ w: number | null }[]>`SELECT validity_weeks AS w FROM depilation_combo WHERE id = ${depi}`;
      expect(d!.w).toBe(semanas);
    }
  });

  it("no pisa un validity_weeks ya cargado", async () => {
    const c = await combo(1);
    const d = await packDepi(1);
    await sql`UPDATE combos SET validity_weeks = 20 WHERE id = ${c}`;
    await sql`UPDATE depilation_combo SET validity_weeks = 20 WHERE id = ${d}`;
    aplicarMigracion();
    const [r] = await sql<{ w: number }[]>`SELECT validity_weeks AS w FROM combos WHERE id = ${c}`;
    const [x] = await sql<{ w: number }[]>`SELECT validity_weeks AS w FROM depilation_combo WHERE id = ${d}`;
    expect(r!.w).toBe(20);
    expect(x!.w).toBe(20);
  });

  it("permite un combo con solo validity_weeks (validity_months NULL)", async () => {
    const c = await combo(null);
    await sql`UPDATE combos SET validity_weeks = 8 WHERE id = ${c}`;
    const [r] = await sql<{ m: number | null; w: number }[]>`
      SELECT validity_months AS m, validity_weeks AS w FROM combos WHERE id = ${c}`;
    expect(r).toEqual({ m: null, w: 8 });
  });

  it("no toca validity_months ni los precios de lista", async () => {
    const foto = async () => (await sql<{ m: string; p: string; s: string }[]>`
      SELECT
        (SELECT coalesce(sum(validity_months), 0) FROM combos)
          + (SELECT coalesce(sum(validity_months), 0) FROM depilation_combo) AS m,
        (SELECT coalesce(sum(unit_price_list), 0) FROM service) AS p,
        (SELECT coalesce(sum(service_price), 0) FROM combo_service) AS s`)[0]!;
    const antes = await foto();
    aplicarMigracion();
    expect(await foto()).toEqual(antes);
  });
});
