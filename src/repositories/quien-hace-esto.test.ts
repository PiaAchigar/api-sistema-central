import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Db } from "../db/client";
import { anclaDeDepilacion } from "./ancla-de-depilacion.repo";
import { quienHaceEsto } from "./quien-hace-esto.repo";

// "¿Quién hace esto?": en el Nuevo turno, elegido el servicio / combo / pack /
// promo, el desplegable de Prestadora lista a las que hacen alguna parte, con
// qué hace cada una y si hace todo (spec 2026-10-22-nuevo-turno-filtros-cruzados).
const URL = "postgresql://piubella:piubella@localhost:5499/piubella";
const pg = postgres(URL, { max: 1, fetch_types: false, prepare: false });
const db = drizzle(pg, { schema }) as unknown as Db;

const QA = "ZZ_QA_QUIEN";

let lu = ""; // hace limpieza y masaje
let gabi = ""; // sólo limpieza
let archivada = ""; // hace limpieza, pero está archivada
let limpieza = "";
let masaje = "";
let combo = "";
let pack = "";
let promoCombo = "";
let promoDepi = "";

const uno = async (q: ReturnType<typeof sql>) => ((await db.execute(q)) as unknown as { id: string }[])[0]!.id;

async function limpiar() {
  await db.execute(sql`DELETE FROM promotion_target WHERE promotion_id IN (SELECT id FROM promotions WHERE name LIKE ${QA + "%"})`);
  await db.execute(sql`DELETE FROM promotions WHERE name LIKE ${QA + "%"}`);
  await db.execute(sql`DELETE FROM service_provider_service WHERE service_provider_id IN (SELECT id FROM service_providers WHERE full_name LIKE ${QA + "%"})`);
  await db.execute(sql`DELETE FROM combos WHERE name LIKE ${QA + "_Pack%"}`);
  await db.execute(sql`DELETE FROM combos WHERE name LIKE ${QA + "%"}`);
  await db.execute(sql`DELETE FROM service WHERE name LIKE ${QA + "%"}`);
  await db.execute(sql`DELETE FROM service_providers WHERE full_name LIKE ${QA + "%"}`);
}

const habilitar = (prov: string, serv: string) =>
  db.execute(sql`
    INSERT INTO service_provider_service (id, service_provider_id, service_id, payment_type, rate, is_active)
    VALUES (gen_random_uuid(), ${prov}, ${serv}, 'percentage', 10, true)`);

beforeAll(async () => {
  await limpiar();
  const prov = (nombre: string, status = "active") =>
    uno(sql`INSERT INTO service_providers (id, full_name, status) VALUES (gen_random_uuid(), ${`${QA}_${nombre}`}, ${status}) RETURNING id`);
  lu = await prov("Lu");
  gabi = await prov("Gabi");
  archivada = await prov("Vieja", "inactive");
  const servicio = (nombre: string) =>
    uno(sql`INSERT INTO service (id, name, is_active, no_vendible) VALUES (gen_random_uuid(), ${`${QA}_${nombre}`}, true, false) RETURNING id`);
  limpieza = await servicio("Limpieza");
  masaje = await servicio("Masaje");
  await habilitar(lu, limpieza);
  await habilitar(lu, masaje);
  await habilitar(gabi, limpieza);
  await habilitar(archivada, limpieza);

  const categoria = await uno(sql`SELECT id FROM categories LIMIT 1`);
  combo = await uno(sql`
    INSERT INTO combos (id, name, price_type, fixed_price, validity_months, area_category_id)
    VALUES (gen_random_uuid(), ${QA + "_Rostro"}, 'fixed', 1000, 3, ${categoria}) RETURNING id`);
  for (const sv of [limpieza, masaje]) {
    await db.execute(sql`INSERT INTO combo_service (combo_id, service_id, sessions_included) VALUES (${combo}, ${sv}, 1)`);
  }
  pack = await uno(sql`
    INSERT INTO combos (id, name, price_type, fixed_price, validity_months, area_category_id, kind, pack_of_combo_id, pack_sessions)
    VALUES (gen_random_uuid(), ${QA + "_Pack"}, 'fixed', 1000, 3, ${categoria}, 'pack', ${combo}, 3) RETURNING id`);

  await habilitar(gabi, await anclaDeDepilacion(db));
  promoCombo = await uno(sql`INSERT INTO promotions (id, name, promotion_type, is_visible_web) VALUES (gen_random_uuid(), ${QA + "_PromoCombo"}, 'paquete', false) RETURNING id`);
  await db.execute(sql`INSERT INTO promotion_target (id, promotion_id, combo_id) VALUES (gen_random_uuid(), ${promoCombo}, ${combo})`);
  promoDepi = await uno(sql`INSERT INTO promotions (id, name, promotion_type, is_visible_web) VALUES (gen_random_uuid(), ${QA + "_PromoDepi"}, 'descuento', false) RETURNING id`);
  const depiCombo = await uno(sql`SELECT id FROM depilation_combo LIMIT 1`).catch(() => null);
  if (depiCombo) {
    await db.execute(sql`INSERT INTO promotion_target (id, promotion_id, depilation_combo_id) VALUES (gen_random_uuid(), ${promoDepi}, ${depiCombo})`);
  }
});

afterAll(async () => {
  await limpiar();
  await pg.end();
});

const de = (r: Awaited<ReturnType<typeof quienHaceEsto>>, id: string) => r.find((x) => x.providerId === id);

describe("quienHaceEsto", () => {
  it("un servicio: las activas que lo tienen habilitado, todas 'hacen todo'", async () => {
    const r = await quienHaceEsto(db, "servicio", limpieza);
    expect(de(r, lu)).toMatchObject({ nombre: `${QA}_Lu`, hace: [`${QA}_Limpieza`], todo: true });
    expect(de(r, gabi)).toMatchObject({ todo: true });
    expect(de(r, archivada)).toBeUndefined();
  });

  it("un combo: Lu hace todo, Gabi una parte (con qué hace); 'hacen todo' primero", async () => {
    const r = (await quienHaceEsto(db, "combo", combo)).filter((x) => [lu, gabi].includes(x.providerId));
    expect(r).toEqual([
      { providerId: lu, nombre: `${QA}_Lu`, hace: [`${QA}_Limpieza`, `${QA}_Masaje`], todo: true },
      { providerId: gabi, nombre: `${QA}_Gabi`, hace: [`${QA}_Limpieza`], todo: false },
    ]);
  });

  it("un pack de combo se mide por los servicios de su combo", async () => {
    const r = await quienHaceEsto(db, "combo", pack);
    expect(de(r, lu)?.todo).toBe(true);
    expect(de(r, gabi)?.todo).toBe(false);
  });

  it("una promo, por lo que tiene adentro", async () => {
    const r = await quienHaceEsto(db, "promo", promoCombo);
    expect(de(r, lu)?.todo).toBe(true);
    expect(de(r, gabi)?.hace).toEqual([`${QA}_Limpieza`]);
  });

  it("depilación, por el servicio ancla (cualquier pack de depilación)", async () => {
    const r = await quienHaceEsto(db, "depilacion", "00000000-0000-0000-0000-000000000000");
    expect(de(r, gabi)).toMatchObject({ todo: true });
    expect(de(r, lu)).toBeUndefined();
    const conPromo = await quienHaceEsto(db, "promo", promoDepi);
    if (conPromo.length) expect(de(conPromo, gabi)?.todo).toBe(true);
  });

  it("algo que no existe: lista vacía", async () => {
    expect(await quienHaceEsto(db, "combo", "00000000-0000-0000-0000-000000000000")).toEqual([]);
  });
});
