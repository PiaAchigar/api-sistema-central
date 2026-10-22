import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Db } from "../db/client";
import { basePlanificador, intervaloDeLaCompra } from "./planificador.repo";
import { createCompra } from "./compras.repo";
import { crearCombo, hardDeleteCombo, leerConfig } from "./depilacion.repo";

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
  await db.execute(sql`DELETE FROM payments WHERE customer_purchase_id IN (SELECT id FROM customer_purchase WHERE description LIKE ${QA + "%"})`);
  await db.execute(sql`DELETE FROM customer_purchase WHERE description LIKE ${QA + "%"}`);
  await db.execute(sql`DELETE FROM appointments WHERE notes LIKE ${QA + "%"}`);
  const packs = (await db.execute(sql`SELECT id FROM depilation_combo WHERE name LIKE ${QA + "_BasePack%"}`)) as unknown as { id: string }[];
  for (const p of packs) await hardDeleteCombo(db, p.id);
  await db.execute(sql`DELETE FROM training WHERE name LIKE ${QA + "%"}`);
  await db.execute(sql`DELETE FROM promotion_target WHERE promotion_id IN (SELECT id FROM promotions WHERE name LIKE ${QA + "%"})`);
  await db.execute(sql`DELETE FROM promotions WHERE name LIKE ${QA + "%"}`);
  await db.execute(sql`DELETE FROM combos WHERE name LIKE ${QA + "_Pack%"}`);
  await db.execute(sql`DELETE FROM combos WHERE name LIKE ${QA + "%"}`);
  await db.execute(sql`DELETE FROM depilation_combo WHERE name LIKE ${QA + "%"}`);
  await db.execute(sql`DELETE FROM customers WHERE tax_id LIKE ${QA + "%"}`);
  await db.execute(sql`DELETE FROM contacts WHERE name LIKE ${QA + "%"}`);
  await db.execute(sql`DELETE FROM service WHERE name LIKE ${QA + "_Svc%"}`);
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


// ── basePlanificador ────────────────────────────────────────────────────────

const dia = 24 * 60 * 60 * 1000;

/** Una clienta con contacto (nombre y sexo) propia de cada test. */
async function clienta(nombre: string, sexo: "mujer" | "hombre" | null) {
  const contacto = await uno(sql`
    INSERT INTO contacts (id, name, sexo) VALUES (gen_random_uuid(), ${`${QA}_${nombre}`}, ${sexo}) RETURNING id`);
  const id = await uno(sql`
    INSERT INTO customers (id, tax_id, contact_id) VALUES (gen_random_uuid(), ${`${QA}_${nombre}`}, ${contacto}) RETURNING id`);
  return { id, nombre: `${QA}_${nombre}` };
}

/** Un pack de depilación con dos zonas reales y 1 "a elección" (que NO tiene que salir). */
async function packDeDepilacion(nombre: string) {
  const zonas = (await db.execute(sql`
    SELECT id, category FROM body_zone WHERE is_active = true AND category IN ('grande','chica') ORDER BY category, name LIMIT 20`)) as unknown as { id: string; category: "grande" | "chica" }[];
  const grande = zonas.find((z) => z.category === "grande")!;
  const chica = zonas.find((z) => z.category === "chica")!;
  const c = await crearCombo(db, {
    name: `${QA}_BasePack${nombre}`,
    kind: "pack_fijo",
    fixedPrice: 30001,
    choiceZoneCount: 1,
    zonaIds: [grande.id, chica.id],
  });
  return { id: c!.id, zonas: [grande, chica] };
}

const comprarDepi = (cliente: string, nombre: string, depi: string, sesiones: number, final = 30001) =>
  createCompra(db, {
    customerId: cliente,
    depilationComboId: depi,
    description: `${QA}_${nombre}`,
    sessionsTotal: sesiones,
    baseAmount: final,
    discountedAmount: final,
    finalAmount: final,
  });

/** Un combo de dos servicios; el que va PRIMERO en el combo es el que se llama "Zeta" (al revés del alfabeto). */
async function comboDeDosServicios(nombre: string, juntos: boolean) {
  const zeta = await uno(sql`
    INSERT INTO service (id, name, estimated_duration_minutes, is_active) VALUES (gen_random_uuid(), ${`${QA}_Svc${nombre}Zeta`}, 40, true) RETURNING id`);
  const alfa = await uno(sql`
    INSERT INTO service (id, name, estimated_duration_minutes, is_active) VALUES (gen_random_uuid(), ${`${QA}_Svc${nombre}Alfa`}, 25, true) RETURNING id`);
  const id = await uno(sql`
    INSERT INTO combos (id, name, price_type, fixed_price, validity_months, area_category_id, kind, services_together)
    VALUES (gen_random_uuid(), ${`${QA}_Base${nombre}`}, 'fixed', 1000, 3, ${categoria}, 'combo', ${juntos}) RETURNING id`);
  await db.execute(sql`INSERT INTO combo_service (id, combo_id, service_id, sessions_included, service_price, created_at)
    VALUES (gen_random_uuid(), ${id}, ${zeta}, 1, 500, '2026-01-01 10:00:00.000')`);
  await db.execute(sql`INSERT INTO combo_service (id, combo_id, service_id, sessions_included, service_price, created_at)
    VALUES (gen_random_uuid(), ${id}, ${alfa}, 1, 500, '2026-01-01 10:00:00.500')`);
  return { id, zeta, alfa };
}

const comprarCombo = (cliente: string, nombre: string, comboId: string, vueltas: number) =>
  createCompra(db, {
    customerId: cliente,
    comboId,
    description: `${QA}_${nombre}`,
    sessionsTotal: vueltas,
    baseAmount: 1000 * vueltas,
    discountedAmount: 1000 * vueltas,
    finalAmount: 1000 * vueltas,
  });

describe("basePlanificador", () => {
  it("pack de depilación × 3: 3 sesiones, vueltas 1..3, todas las zonas del pack, duración por el sexo de la clienta", async () => {
    const pack = await packDeDepilacion("X3");
    const cfg = await leerConfig(db);
    for (const sexo of ["mujer", "hombre"] as const) {
      const cli = await clienta(`Depi3${sexo}`, sexo);
      const compra = await comprarDepi(cli.id, `Depi3${sexo}`, pack.id, 3);
      const base = (await basePlanificador(db, compra.id))!;

      expect(base.compraId).toBe(compra.id);
      expect(base.customerId).toBe(cli.id);
      expect(base.clienta).toBe(cli.nombre);
      expect(base.sesiones.map((s) => s.vuelta)).toEqual([1, 2, 3]);
      expect(base.sesiones.map((s) => s.orden)).toEqual([1, 1, 1]);
      const esperado = pack.zonas.reduce((t, z) => t + cfg.minutosTurno[sexo][z.category], 0);
      for (const s of base.sesiones) {
        expect(s.esDepilacion).toBe(true);
        expect(s.juntos).toBe(false);
        // Las dos del pack, sin la zona "a elección" (regalo).
        expect([...s.zonas].sort()).toEqual(pack.zonas.map((z) => z.id).sort());
        expect(s.duracionMinutos).toBe(esperado);
        expect(s.serviceId).toBeTruthy();
      }
      expect(base.intervalo).toEqual(await intervaloDeLaCompra(db, compra.id));
    }
  });

  it("combo juntos × 2 vueltas con 2 servicios: 4 sesiones ordenadas (1,1),(1,2),(2,1),(2,2) y juntos=true", async () => {
    const cli = await clienta("Juntos", null);
    const c = await comboDeDosServicios("Juntos", true);
    const compra = await comprarCombo(cli.id, "Juntos", c.id, 2);
    const base = (await basePlanificador(db, compra.id))!;

    expect(base.sesiones.map((s) => [s.vuelta, s.orden])).toEqual([[1, 1], [1, 2], [2, 1], [2, 2]]);
    // El orden es el del combo (Zeta primero), no el alfabético.
    expect(base.sesiones.map((s) => s.serviceId)).toEqual([c.zeta, c.alfa, c.zeta, c.alfa]);
    expect(base.sesiones.map((s) => s.duracionMinutos)).toEqual([40, 25, 40, 25]);
    expect(base.sesiones.every((s) => s.juntos && !s.esDepilacion && s.zonas.length === 0)).toBe(true);
    expect(base.sesiones[0]!.nombre).toBe(`${QA}_SvcJuntosZeta`);
    expect(base.puerta).toBeNull();

    const separados = await comboDeDosServicios("Separados", false);
    const otra = await comprarCombo(cli.id, "Separados", separados.id, 1);
    expect((await basePlanificador(db, otra.id))!.sesiones.every((s) => !s.juntos)).toBe(true);
  });

  it("las líneas ya agendadas, consumidas o de capacitación no aparecen", async () => {
    const cli = await clienta("Libres", null);
    const c = await comboDeDosServicios("Libres", true);
    const compra = await comprarCombo(cli.id, "Libres", c.id, 3);
    const lineas = (await db.execute(sql`
      SELECT id, repeticion, service_id FROM customer_purchase_service WHERE customer_purchase_id = ${compra.id}
      ORDER BY repeticion, service_id`)) as unknown as { id: string; repeticion: number; service_id: string }[];
    const de = (rep: number, svc: string) => lineas.find((l) => l.repeticion === rep && l.service_id === svc)!;

    const turno = async (estado: string) =>
      uno(sql`INSERT INTO appointments (id, customer_id, appointment_start, appointment_end, status, notes)
        VALUES (gen_random_uuid(), ${cli.id}, now() + interval '3 days', now() + interval '3 days 1 hour', ${estado}, ${`${QA}_T`}) RETURNING id`);
    // Vuelta 1 / Zeta: con turno vivo. Vuelta 1 / Alfa: consumida.
    await db.execute(sql`UPDATE customer_purchase_service SET appointment_id = ${await turno("scheduled")} WHERE id = ${de(1, c.zeta).id}`);
    await db.execute(sql`UPDATE customer_purchase_service SET consumed_at = now() WHERE id = ${de(1, c.alfa).id}`);
    // Vuelta 2 / Zeta: el turno se canceló, así que vuelve a estar libre.
    await db.execute(sql`UPDATE customer_purchase_service SET appointment_id = ${await turno("cancelled")} WHERE id = ${de(2, c.zeta).id}`);
    // Una línea de capacitación en la misma compra.
    const cap = await uno(sql`INSERT INTO training (id, name) VALUES (gen_random_uuid(), ${`${QA}_Cap`}) RETURNING id`);
    await db.execute(sql`INSERT INTO customer_purchase_service (id, customer_purchase_id, training_id, repeticion, orden)
      VALUES (gen_random_uuid(), ${compra.id}, ${cap}, 1, 1)`);

    const base = (await basePlanificador(db, compra.id))!;
    expect(base.sesiones.map((s) => s.purchaseServiceId)).toEqual([
      de(2, c.zeta).id,
      de(2, c.alfa).id,
      de(3, c.zeta).id,
      de(3, c.alfa).id,
    ]);
    // Las posiciones son las de la vuelta entera, no se corren por lo ya agendado.
    expect(base.sesiones.map((s) => [s.vuelta, s.orden])).toEqual([[2, 1], [2, 2], [3, 1], [3, 2]]);
  });

  it("puerta: total, pagado y minimo = 40% del total redondeado; null fuera de depilación", async () => {
    const pack = await packDeDepilacion("Puerta");
    const cli = await clienta("Puerta", "mujer");
    const compra = await comprarDepi(cli.id, "Puerta", pack.id, 3, 30001);
    await db.execute(sql`INSERT INTO payments (id, customer_purchase_id, customer_id, amount, status, payment_method)
      VALUES (gen_random_uuid(), ${compra.id}, ${cli.id}, 5000, 'confirmed', 'cash')`);
    await db.execute(sql`INSERT INTO payments (id, customer_purchase_id, customer_id, amount, status, payment_method)
      VALUES (gen_random_uuid(), ${compra.id}, ${cli.id}, 999, 'pending', 'cash')`);
    const base = (await basePlanificador(db, compra.id))!;
    // 30001 × 0,4 = 12000,4 → 12000. El pago sin confirmar no cuenta.
    expect(base.puerta).toEqual({ total: 30001, pagado: 5000, minimo: 12000 });

    const c = await comboDeDosServicios("SinPuerta", false);
    const otra = await comprarCombo(cli.id, "SinPuerta", c.id, 2);
    expect((await basePlanificador(db, otra.id))!.puerta).toBeNull();
  });

  it("turnosDeLaClienta trae sólo los futuros no cancelados", async () => {
    const cli = await clienta("Turnos", null);
    const otra = await clienta("TurnosOtra", null);
    const c = await comboDeDosServicios("Turnos", false);
    const compra = await comprarCombo(cli.id, "Turnos", c.id, 1);
    const turno = (cliente: string, desde: string, hasta: string, estado: string) =>
      db.execute(sql`INSERT INTO appointments (id, customer_id, appointment_start, appointment_end, status, notes)
        VALUES (gen_random_uuid(), ${cliente}, now() + ${desde}::interval, now() + ${hasta}::interval, ${estado}, ${`${QA}_T`})`);
    await turno(cli.id, "2 days", "2 days 1 hour", "scheduled");
    await turno(cli.id, "1 day", "1 day 30 minutes", "reserved");
    await turno(cli.id, "5 days", "5 days 1 hour", "cancelled");
    await turno(cli.id, "-2 days", "-2 days 1 hour", "completed");
    await turno(otra.id, "3 days", "3 days 1 hour", "scheduled");

    const base = (await basePlanificador(db, compra.id))!;
    expect(base.turnosDeLaClienta).toHaveLength(2);
    const ahora = Date.now();
    expect(base.turnosDeLaClienta.map((t) => Math.round((new Date(t.start).getTime() - ahora) / dia))).toEqual([1, 2]);
    for (const t of base.turnosDeLaClienta) expect(new Date(t.end).getTime()).toBeGreaterThan(new Date(t.start).getTime());
  });

  it("venceEl: YYYY-MM-DD en hora local, o null; compra inexistente: null", async () => {
    const cli = await clienta("Vence", null);
    const c = await comboDeDosServicios("Vence", false);
    const compra = await comprarCombo(cli.id, "Vence", c.id, 1);
    expect((await basePlanificador(db, compra.id))!.venceEl).toBeNull();
    // 02:00 UTC del 31/12 son las 23:00 del 30/12 en Buenos Aires.
    const futuro = new Date(Date.UTC(2099, 11, 31, 2, 0, 0));
    await db.execute(sql`UPDATE customer_purchase SET expires_at = ${futuro.toISOString()} WHERE id = ${compra.id}`);
    expect((await basePlanificador(db, compra.id))!.venceEl).toBe("2099-12-30");
    expect(await basePlanificador(db, "00000000-0000-0000-0000-000000000000")).toBeNull();
  });
});
