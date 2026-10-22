import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Db } from "../db/client";
import { intervaloDeLaCompra } from "./planificador.repo";

// Los días sugeridos entre sesiones de una compra (spec 2026-10-22-planificador-de-la-compra).
// Cada test arma sus propios datos con el prefijo ZZ_QA_PLAN y no depende de lo
// que Laura tenga cargado en Depilación → Packs.
const URL = "postgresql://piubella:piubella@localhost:5499/piubella";
const pg = postgres(URL, { max: 1, fetch_types: false, prepare: false });
const db = drizzle(pg, { schema }) as unknown as Db;

const QA = "ZZ_QA_PLAN";
const uno = async (q: ReturnType<typeof sql>) => ((await db.execute(q)) as unknown as { id: string }[])[0]!.id;

let categoria = "";
let cliente = "";

async function limpiar() {
  await db.execute(sql`DELETE FROM customer_purchase WHERE description LIKE ${QA + "%"}`);
  await db.execute(sql`DELETE FROM promotion_target WHERE promotion_id IN (SELECT id FROM promotions WHERE name LIKE ${QA + "%"})`);
  await db.execute(sql`DELETE FROM promotions WHERE name LIKE ${QA + "%"}`);
  await db.execute(sql`DELETE FROM combos WHERE name LIKE ${QA + "_Pack%"}`);
  await db.execute(sql`DELETE FROM combos WHERE name LIKE ${QA + "%"}`);
  await db.execute(sql`DELETE FROM depilation_combo WHERE name LIKE ${QA + "%"}`);
  await db.execute(sql`DELETE FROM customers WHERE tax_id = ${QA}`);
}

const combo = (nombre: string, dias: number | null, pack?: { de: string }) =>
  uno(sql`
    INSERT INTO combos (id, name, price_type, fixed_price, validity_months, area_category_id, kind, pack_of_combo_id, pack_sessions, session_interval_days)
    VALUES (gen_random_uuid(), ${`${QA}_${nombre}`}, 'fixed', 1000, 3, ${categoria},
            ${pack ? "pack" : "combo"}, ${pack?.de ?? null}, ${pack ? 3 : null}, ${dias}) RETURNING id`);

const compra = (nombre: string, origen: { combo?: string; depi?: string; promo?: string }) =>
  uno(sql`
    INSERT INTO customer_purchase (id, customer_id, combo_id, depilation_combo_id, promotion_id, es_paquete_de_promo,
                                   description, sessions_total, base_amount, discounted_amount, final_amount)
    VALUES (gen_random_uuid(), ${cliente}, ${origen.combo ?? null}, ${origen.depi ?? null}, ${origen.promo ?? null},
            ${!!origen.promo && !origen.combo}, ${`${QA}_${nombre}`}, 3, 100, 100, 100) RETURNING id`);

const promo = async (nombre: string, dias: number | null, combos: string[]) => {
  const id = await uno(sql`
    INSERT INTO promotions (id, name, promotion_type, is_visible_web, session_interval_days)
    VALUES (gen_random_uuid(), ${`${QA}_${nombre}`}, 'paquete', false, ${dias}) RETURNING id`);
  for (const c of combos) {
    await db.execute(sql`INSERT INTO promotion_target (id, promotion_id, combo_id, created_at)
      VALUES (gen_random_uuid(), ${id}, ${c}, clock_timestamp())`);
  }
  return id;
};

beforeAll(async () => {
  await limpiar();
  categoria = await uno(sql`SELECT id FROM categories LIMIT 1`);
  cliente = await uno(sql`INSERT INTO customers (id, tax_id) VALUES (gen_random_uuid(), ${QA}) RETURNING id`);
});

afterAll(async () => {
  await limpiar();
  await pg.end();
});

describe("intervaloDeLaCompra", () => {
  it("un combo con días cargados: { dias: 21, cargado: true }", async () => {
    const c = await combo("Combo21", 21);
    expect(await intervaloDeLaCompra(db, await compra("C21", { combo: c }))).toEqual({ dias: 21, cargado: true });
  });

  it("un pack de combo sin días toma los de su combo", async () => {
    const c = await combo("Combo15", 15);
    const p = await combo("Pack15", null, { de: c });
    expect(await intervaloDeLaCompra(db, await compra("P15", { combo: p }))).toEqual({ dias: 15, cargado: true });
  });

  it("un pack con días propios gana sobre los de su combo", async () => {
    const c = await combo("Combo15b", 15);
    const p = await combo("Pack10", 10, { de: c });
    expect(await intervaloDeLaCompra(db, await compra("P10", { combo: p }))).toEqual({ dias: 10, cargado: true });
  });

  it("una promo sin días toma los del primer combo o pack de adentro que los tenga", async () => {
    const sinDias = await combo("SinDias", null);
    const conDias = await combo("Con14", 14);
    const otro = await combo("Con7", 7);
    const pr = await promo("PromoSin", null, [sinDias, conDias, otro]);
    expect(await intervaloDeLaCompra(db, await compra("PR", { promo: pr }))).toEqual({ dias: 14, cargado: true });
  });

  it("una promo con días propios gana sobre los de adentro", async () => {
    const c = await combo("Con14b", 14);
    const pr = await promo("PromoCon", 45, [c]);
    expect(await intervaloDeLaCompra(db, await compra("PR45", { promo: pr }))).toEqual({ dias: 45, cargado: true });
  });

  it("un pack de depilación sin días toma los de depilation_pricing_config", async () => {
    const original = await db.execute(sql`SELECT id, session_interval_days AS dias FROM depilation_pricing_config LIMIT 1`) as unknown as { id: string; dias: number | null }[];
    const fila = original[0]!;
    const d = await uno(sql`
      INSERT INTO depilation_combo (id, name, kind, fixed_price, choice_zone_count, is_published_web, display_order, is_active)
      VALUES (gen_random_uuid(), ${QA + "_Depi"}, 'pack_fijo', 1000, 1, false, 0, true) RETURNING id`);
    const c = await compra("DEPI", { depi: d });
    try {
      await db.execute(sql`UPDATE depilation_pricing_config SET session_interval_days = 28 WHERE id = ${fila.id}`);
      expect(await intervaloDeLaCompra(db, c)).toEqual({ dias: 28, cargado: true });
      await db.execute(sql`UPDATE depilation_combo SET session_interval_days = 20 WHERE id = ${d}`);
      expect(await intervaloDeLaCompra(db, c)).toEqual({ dias: 20, cargado: true });
    } finally {
      await db.execute(sql`UPDATE depilation_pricing_config SET session_interval_days = ${fila.dias} WHERE id = ${fila.id}`);
    }
  });

  it("nadie los tiene: { dias: 30, cargado: false }", async () => {
    const c = await combo("ComboVacio", null);
    const original = await db.execute(sql`SELECT id, session_interval_days AS dias FROM depilation_pricing_config LIMIT 1`) as unknown as { id: string; dias: number | null }[];
    const fila = original[0]!;
    const d = await uno(sql`
      INSERT INTO depilation_combo (id, name, kind, fixed_price, choice_zone_count, is_published_web, display_order, is_active)
      VALUES (gen_random_uuid(), ${QA + "_DepiVacio"}, 'pack_fijo', 1000, 1, false, 0, true) RETURNING id`);
    try {
      await db.execute(sql`UPDATE depilation_pricing_config SET session_interval_days = NULL WHERE id = ${fila.id}`);
      expect(await intervaloDeLaCompra(db, await compra("VACIO", { combo: c }))).toEqual({ dias: 30, cargado: false });
      expect(await intervaloDeLaCompra(db, await compra("VACIO2", { depi: d }))).toEqual({ dias: 30, cargado: false });
    } finally {
      await db.execute(sql`UPDATE depilation_pricing_config SET session_interval_days = ${fila.dias} WHERE id = ${fila.id}`);
    }
  });

  it("una compra que no existe: { dias: 30, cargado: false }", async () => {
    expect(await intervaloDeLaCompra(db, "00000000-0000-0000-0000-000000000000")).toEqual({ dias: 30, cargado: false });
  });
});
