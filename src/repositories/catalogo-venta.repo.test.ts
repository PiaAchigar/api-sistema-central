import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { and, eq, isNull, like, notLike } from "drizzle-orm";
import * as schema from "../db/schema";
import { bodyZone, categories, combos, depilationCombo, promotions, service } from "../db/schema";
import type { Db } from "../db/client";
import { listCatalogoVendible, obtenerPromoVendible, preciosDeListaDe } from "./catalogo-venta.repo";
import { cotizarPaquete } from "../lib/cotizacion-de-paquete";
import { crearCombo, hardDeleteCombo } from "./depilacion.repo";
import { createCombo, deleteComboPermanently } from "./combos.repo";
import { createPromotion, deletePromotionPermanently } from "./promotions.repo";

/**
 * Task 7 (concern de la coordinadora): un pack de depilación `guardado` no
 * tiene `fixed_price` propio (CHECK `ck_dc_precio_guardado` lo garantiza
 * NULL) — se cotiza con la fórmula sobre zonas, un camino que la VENTA de un
 * paquete no usa nunca (`lineasDeUnPaquete` en `compras.repo.ts` sólo lee
 * `depilation_combo.fixed_price` y rechaza si es NULL). `preciosDeListaDe`
 * tiene que fallar de la misma forma, ANTES de la venta: cotizar con la
 * fórmula prometería un precio que confirmar la compra después niega.
 */
const pgClient = postgres("postgresql://piubella:piubella@localhost:5499/piubella", {
  max: 1,
  fetch_types: false,
  prepare: false,
});
const db = drizzle(pgClient, { schema }) as unknown as Db;

const QA = "ZZ_QA_CATALOGO_VENTA";

let zonaId: string;
let packFijoId: string;
let packGuardadoId: string;
let promoPackFijoId: string;
let promoPackGuardadoId: string;
let packConEleccionId: string;
let comboPackId: string;
let servicioId: string;
let servicioNombre: string;
let zonaNombre: string;
let zonaBisNombre: string;

async function limpiar() {
  const promos = await db.select({ id: promotions.id }).from(promotions).where(like(promotions.name, `${QA}%`));
  for (const p of promos) await deletePromotionPermanently(db, p.id);

  const combosQa = await db
    .select({ id: depilationCombo.id })
    .from(depilationCombo)
    .where(like(depilationCombo.name, `${QA}%`));
  for (const c of combosQa) await hardDeleteCombo(db, c.id);

  const genericosQa = await db
    .select({ id: combos.id })
    .from(combos)
    .where(like(combos.name, `${QA}%`));
  for (const c of genericosQa) await deleteComboPermanently(db, c.id);
}

beforeAll(async () => {
  await limpiar();

  // Una zona real, activa, que NO sea de un fixture QA de otra suite: un
  // `select ... limit 1` sin este filtro agarró una vez un fixture QA vivo
  // de otro archivo en una corrida anterior de la suite entera.
  const [zona] = await db
    .select({ id: bodyZone.id })
    .from(bodyZone)
    .where(notLike(bodyZone.name, "ZZ_QA%"))
    .orderBy(bodyZone.name)
    .limit(1);
  zonaId = zona!.id;

  // Regresión: un pack_fijo CON fixed_price cargado — tiene que seguir
  // cotizando exactamente igual que antes de este fix.
  const packFijo = await crearCombo(db, {
    name: `${QA}_PACK_FIJO`,
    kind: "pack_fijo",
    fixedPrice: 65000,
    zonaIds: [zonaId],
  });
  packFijoId = packFijo!.id;

  // El caso nuevo: un guardado, sin fixed_price (el CHECK de la base lo
  // exige NULL para este kind).
  const packGuardado = await crearCombo(db, {
    name: `${QA}_PACK_GUARDADO`,
    kind: "guardado",
    zonaIds: [zonaId],
  });
  packGuardadoId = packGuardado!.id;

  const promoPackFijo = await createPromotion(
    db,
    { name: `${QA}_PROMO_PACK_FIJO`, promotionType: "paquete", precioDelPaquete: 50000 },
    [{ tipo: "depilacion", id: packFijoId, cantidad: 1 }],
    [],
  );
  promoPackFijoId = promoPackFijo!.id;

  const promoPackGuardado = await createPromotion(
    db,
    { name: `${QA}_PROMO_PACK_GUARDADO`, promotionType: "paquete", precioDelPaquete: 50000 },
    [{ tipo: "depilacion", id: packGuardadoId, cantidad: 1 }],
    [],
  );
  promoPackGuardadoId = promoPackGuardado!.id;

  // Dos zonas reales distintas: el desglose tiene que listarlas a las DOS,
  // más la "a elección", que se SUMA (no sale de adentro de las cargadas).
  const zonasReales = await db
    .select({ id: bodyZone.id, name: bodyZone.name })
    .from(bodyZone)
    .where(notLike(bodyZone.name, "ZZ_QA%"))
    .orderBy(bodyZone.name)
    .limit(2);
  zonaNombre = zonasReales[0]!.name;
  zonaBisNombre = zonasReales[1]!.name;

  const conEleccion = await crearCombo(db, {
    name: `${QA}_PACK_CON_ELECCION`,
    kind: "pack_fijo",
    fixedPrice: 80000,
    choiceZoneCount: 1,
    zonaIds: zonasReales.map((z) => z.id),
  });
  packConEleccionId = conEleccion!.id;

  // Un servicio real CON precio: `createCombo` congela el precio de cada
  // renglón, y uno sin precio dejaría el combo en $0 y sin nada que desglosar.
  const [s1] = await db
    .select({ id: service.id, name: service.name })
    .from(service)
    .where(and(eq(service.isActive, true), notLike(service.name, "ZZ_QA%")))
    .orderBy(service.name)
    .limit(1);
  servicioId = s1!.id;
  servicioNombre = s1!.name ?? "";

  // `area_category_id` es NOT NULL en `combos`: hace falta un área real.
  const [area] = await db
    .select({ id: categories.id })
    .from(categories)
    .where(isNull(categories.parentCategoryId))
    .orderBy(categories.name)
    .limit(1);

  // Un PACK de 3 con un renglón de 1: el caso exacto de "Pack 1 - Prueba" en
  // producción, que es el que a Laura le salía con un cartel rojo.
  const comboPack = await createCombo(
    db,
    {
      name: `${QA}_COMBO_PACK`,
      priceType: "percentage",
      discountPercentage: 10,
      validityMonths: 12,
      areaCategoryId: area!.id,
      kind: "pack",
      packSessions: 3,
    },
    [{ serviceId: servicioId, sessionsIncluded: 1 }],
  );
  comboPackId = comboPack!.id;
});

afterAll(async () => {
  await limpiar();
  await pgClient.end();
});

describe("preciosDeListaDe — depilación pesa igual que la venta", () => {
  it("un pack_fijo con fixed_price cargado cotiza con ESE precio, sin tocar la fórmula", async () => {
    const promo = await obtenerPromoVendible(db, promoPackFijoId);
    const catalogo = await preciosDeListaDe(db, promo!.destinos);
    expect(catalogo.precios.get(packFijoId)).toBe(65000);

    const q = cotizarPaquete(promo!, catalogo, new Date());
    expect(q.baseAmount).toBe(65000);
    expect(q.finalAmount).toBe(50000);
  });

  it("un pack guardado (sin fixed_price) no resuelve precio: cotizarPaquete lo rechaza nombrándolo", async () => {
    const promo = await obtenerPromoVendible(db, promoPackGuardadoId);
    const catalogo = await preciosDeListaDe(db, promo!.destinos);
    // No lo resuelve — ni siquiera con la fórmula sobre zonas: sería un
    // precio que la venta real del paquete nunca usa.
    expect(catalogo.precios.has(packGuardadoId)).toBe(false);

    // NOMBRÁNDOLO, que es lo que dice el título y lo que el readme promete.
    // Este test antes exigía el UUID —cementaba el bug que decía arreglar—:
    // Laura leía "No se pudo resolver el precio de: 0d3e1a7c-…" y tenía que
    // ir a la promo a adivinar cuál de las cosas que tildó era esa.
    let mensaje = "";
    try {
      cotizarPaquete(promo!, catalogo, new Date());
    } catch (e) {
      mensaje = (e as Error).message;
    }
    expect(mensaje).toContain(`${QA}_PACK_GUARDADO`);
    expect(mensaje).not.toContain(packGuardadoId);
  });
});

/**
 * Que el desglose EXISTA no alcanza: tiene que llegar al front por el
 * catálogo. La revisión de V3b enseñó esto por las malas — una función pura
 * puede estar impecablemente testeada mientras nadie la llama, y la suite
 * queda verde con la funcionalidad apagada.
 */
describe("listCatalogoVendible — el desglose llega al front", () => {
  it("un pack de depilación viaja con sus zonas y su zona a elección", async () => {
    const catalogo = await listCatalogoVendible(db);
    const pack = catalogo.depilacion.find((i) => i.id === packConEleccionId);

    expect(pack, "el pack de QA tiene que estar en el catálogo").toBeDefined();
    expect(pack!.desglose.map((f) => f.nombre)).toEqual([
      zonaNombre,
      zonaBisNombre,
      "Zona a elección",
    ]);
    // Tres renglones y tres zonas: la "a elección" se suma a las dos cargadas.
    expect(pack!.desglose.reduce((t, f) => t + f.cantidad, 0)).toBe(3);
  });

  it("un pack de 3 dice '3 × servicio', que es lo que la clienta va a poder agendar", async () => {
    const catalogo = await listCatalogoVendible(db);
    const pack = catalogo.combos.find((i) => i.id === comboPackId);

    expect(pack, "el combo pack de QA tiene que estar en el catálogo").toBeDefined();
    expect(pack!.desglose).toEqual([{ nombre: servicioNombre, cantidad: 3 }]);
    expect(pack!.packSesiones).toBe(3);
  });

  it("un servicio suelto no inventa desglose: es una cosa sola", async () => {
    const catalogo = await listCatalogoVendible(db);
    const suelto = catalogo.servicios.find((i) => i.id === servicioId);

    expect(suelto, "el servicio real tiene que estar en el catálogo").toBeDefined();
    expect(suelto!.desglose).toEqual([]);
  });
});
