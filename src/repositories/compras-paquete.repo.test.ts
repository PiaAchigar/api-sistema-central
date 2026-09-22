import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { and, eq, like } from "drizzle-orm";
import * as schema from "../db/schema";
import {
  areaPackPolicy,
  categories,
  combos,
  comboService,
  customerPurchase,
  customerPurchaseService,
  promotions,
  promotionTarget,
  service,
} from "../db/schema";
import type { Db } from "../db/client";
import { createCompra, cancelCompra } from "./compras.repo";
import { createPromotion, deletePromotionPermanently } from "./promotions.repo";
import { obtenerPromoVendible, preciosDeListaDe } from "./catalogo-venta.repo";
import { cotizarPaquete } from "../lib/cotizacion-de-paquete";

const pgClient = postgres("postgresql://piubella:piubella@localhost:5499/piubella", {
  max: 1,
  fetch_types: false,
  prepare: false,
});
const db = drizzle(pgClient, { schema }) as unknown as Db;

const QA = "ZZ_QA_PAQUETE";
let clienteId: string;
let servicioId: string;
let comboId: string;
let promoId: string;

// ── Fixtures de los hallazgos de la revisión ────────────────────────────────
let servicioSoloCashId: string;
let servicioSinPrecioId: string;
let servicioListaConocidaId: string;
let comboBaratoId: string;
let promoDosNivelesId: string;
let promoSoloCashId: string;
let promoSinPrecioId: string;
let promoDescuentoId: string;
let promoZonaId: string;
let bodyZoneId: string;

// ── CRÍTICO 1: un pack (kind='pack') adentro de un paquete ─────────────────
let areaDePackId: string;
let servicioPackAId: string;
let servicioPackBId: string;
let comboDelPackId: string;
let packId: string;
let promoConPackId: string;

async function limpiar() {
  // Las compras de test primero: si una corrida anterior dejó una fila
  // cancelada (pero no borrada, `cancelCompra` no borra) que referencia un
  // service/combo QA, el DELETE de más abajo revienta por FK — pasó de
  // verdad en la corrida anterior de esta suite.
  const compras = await db
    .select({ id: customerPurchase.id })
    .from(customerPurchase)
    .where(like(customerPurchase.description, `${QA}%`));
  for (const c of compras) {
    await db.delete(customerPurchaseService).where(eq(customerPurchaseService.customerPurchaseId, c.id));
    await db.delete(customerPurchase).where(eq(customerPurchase.id, c.id));
  }

  const promos = await db.select({ id: promotions.id }).from(promotions).where(like(promotions.name, `${QA}%`));
  for (const p of promos) await deletePromotionPermanently(db, p.id);

  // Los PACKS primero: un `kind='pack'` apunta con `pack_of_combo_id` al
  // combo que repite, y borrar ese combo antes revienta por FK. El SELECT de
  // abajo no promete orden, así que el orden se fuerza acá.
  const packsQA = await db
    .select({ id: combos.id })
    .from(combos)
    .where(and(like(combos.name, `${QA}%`), eq(combos.kind, "pack")));
  for (const p of packsQA) {
    await db.delete(promotionTarget).where(eq(promotionTarget.comboId, p.id));
    await db.delete(comboService).where(eq(comboService.comboId, p.id));
    await db.delete(combos).where(eq(combos.id, p.id));
  }

  const viejos = await db.select({ id: combos.id }).from(combos).where(like(combos.name, `${QA}%`));
  for (const c of viejos) {
    // Defensivo: corriendo la suite entera (paralelismo de archivos) se vio
    // fallar `promotion_target_combo_id_fkey` acá — un `promotion_target`
    // que apunta a este combo seguía vivo pese a la limpieza de `promos` de
    // arriba. Sin este DELETE extra es la única fila que puede bloquear el
    // de más abajo.
    await db.delete(promotionTarget).where(eq(promotionTarget.comboId, c.id));
    await db.delete(comboService).where(eq(comboService.comboId, c.id));
    await db.delete(combos).where(eq(combos.id, c.id));
  }

  await db.delete(service).where(like(service.name, `${QA}%`));

  // El área QA y su tarifario de packs, al final: los combos que la usaban ya
  // no están.
  const areasQA = await db
    .select({ id: categories.id })
    .from(categories)
    .where(like(categories.name, `${QA}%`));
  for (const a of areasQA) {
    await db.delete(areaPackPolicy).where(eq(areaPackPolicy.areaCategoryId, a.id));
    await db.delete(categories).where(eq(categories.id, a.id));
  }
}

beforeAll(async () => {
  await limpiar();
  const [cli] = await db.execute<{ id: string }>("select id from customers limit 1" as never);
  const [srv] = await db.execute<{ id: string }>(
    "select id from service where is_active = true and unit_price_list > 0 and name not like 'ZZ_QA%' order by id limit 1" as never,
  );
  const [area] = await db.execute<{ id: string }>(
    "select id from categories where kind = 'area' and name not like 'ZZ_QA%' order by id limit 1" as never,
  );
  const [zona] = await db.execute<{ id: string }>(
    "select id from body_zone where name not like 'ZZ_QA%' order by id limit 1" as never,
  );
  clienteId = cli!.id;
  servicioId = srv!.id;
  bodyZoneId = zona!.id;

  const [combo] = await db
    .insert(combos)
    .values({ name: QA, priceType: "fixed", fixedPrice: "80000", validityMonths: 12,
             isActive: true, isVisibleWeb: false, areaCategoryId: area!.id })
    .returning({ id: combos.id });
  comboId = combo!.id;
  await db.insert(comboService).values({
    comboId, serviceId: servicioId, sessionsIncluded: 1, servicePrice: "80000",
  });

  const promo = await createPromotion(
    db,
    { name: QA, promotionType: "paquete", precioDelPaquete: 250000 },
    [{ tipo: "combo", id: comboId, cantidad: 1 }, { tipo: "servicio", id: servicioId, cantidad: 3 }],
    [],
  );
  promoId = promo!.id;

  // ── CRÍTICO 2 / IMPORTANTE 3: servicios y combo con precios de control ───
  // `isActive: false` a propósito en los tres: `lineasDeUnPaquete` no filtra
  // por actividad (resuelve el `service_id` del destino directo, como el
  // resto del catálogo vendido), así que no afecta a estos tests — pero
  // evita que OTRO archivo de test, con su propio `select ... where
  // is_active = true and unit_price_list > 0 limit 1` sin ORDER BY, levante
  // por casualidad uno de estos servicios QA justo antes de que el
  // `afterAll` de acá lo borre. Pasó de verdad corriendo la suite entera:
  // `servicioListaConocidaId` (el único de los tres que antes quedaba
  // `is_active = true` CON precio de lista) fue el que otro archivo agarró.
  const [soloCash] = await db
    .insert(service)
    .values({ name: `${QA}_SOLO_CASH`, isActive: false, unitPriceList: null, unitPriceCash: "45000" })
    .returning({ id: service.id });
  servicioSoloCashId = soloCash!.id;

  const [sinPrecio] = await db
    .insert(service)
    .values({ name: `${QA}_SIN_PRECIO`, isActive: false, unitPriceList: null, unitPriceCash: null })
    .returning({ id: service.id });
  servicioSinPrecioId = sinPrecio!.id;

  const [listaConocida] = await db
    .insert(service)
    .values({ name: `${QA}_LISTA_CONOCIDA`, isActive: false, unitPriceList: "70000" })
    .returning({ id: service.id });
  servicioListaConocidaId = listaConocida!.id;

  // Un combo que vale MENOS que la suma de sus servicios: sus líneas listan
  // $130.000 pero el combo cuesta $80.000 fijo. Es el ejemplo exacto del
  // hallazgo Importante 3.
  const [comboBarato] = await db
    .insert(combos)
    .values({ name: `${QA}_COMBO_BARATO`, priceType: "fixed", fixedPrice: "80000", validityMonths: 12,
             isActive: true, isVisibleWeb: false, areaCategoryId: area!.id })
    .returning({ id: combos.id });
  comboBaratoId = comboBarato!.id;
  await db.insert(comboService).values({
    comboId: comboBaratoId, serviceId: servicioId, sessionsIncluded: 1, servicePrice: "130000",
  });

  // Paquete $150.000 = combo $80.000 + servicio de lista conocida $70.000.
  const promoDosNiveles = await createPromotion(
    db,
    { name: `${QA}_DOS_NIVELES`, promotionType: "paquete", precioDelPaquete: 150000 },
    [
      { tipo: "combo", id: comboBaratoId, cantidad: 1 },
      { tipo: "servicio", id: servicioListaConocidaId, cantidad: 1 },
    ],
    [],
  );
  promoDosNivelesId = promoDosNiveles!.id;

  // Va acompañado de otro servicio con precio de lista conocido: si el peso
  // del que sólo tiene `unit_price_cash` cayera en 0 (como pasaba antes de
  // usar `precioDeServicio`), el reparto le daría TODO el paquete al otro
  // servicio — con un solo destino el atajo de `repartirPrecioDelPaquete`
  // (largo 1 ⇒ le da el total igual, sin mirar el peso) disimulaba el bug.
  const promoSoloCash = await createPromotion(
    db,
    { name: `${QA}_SOLO_CASH`, promotionType: "paquete", precioDelPaquete: 115000 },
    [
      { tipo: "servicio", id: servicioSoloCashId, cantidad: 1 },
      { tipo: "servicio", id: servicioListaConocidaId, cantidad: 1 },
    ],
    [],
  );
  promoSoloCashId = promoSoloCash!.id;

  const promoSinPrecio = await createPromotion(
    db,
    { name: `${QA}_SIN_PRECIO`, promotionType: "paquete", precioDelPaquete: 10000 },
    [{ tipo: "servicio", id: servicioSinPrecioId, cantidad: 1 }],
    [],
  );
  promoSinPrecioId = promoSinPrecio!.id;

  // MENOR 2: una promo de DESCUENTO, no de paquete.
  const promoDescuento = await createPromotion(
    db,
    { name: `${QA}_DESCUENTO`, promotionType: "percentage", discountPercentage: 10 },
    [{ tipo: "servicio", id: servicioId, cantidad: 1 }],
    [],
  );
  promoDescuentoId = promoDescuento!.id;

  // MENOR 1: una promo de paquete válida, con un destino extra que
  // `createPromotion` no puede armar por su tipo (`TipoDeDestino` no incluye
  // "zona") — se inserta directo para reproducir el caso real: una fila de
  // `promotion_target` con sólo `body_zone_id`.
  const promoZona = await createPromotion(
    db,
    { name: `${QA}_ZONA`, promotionType: "paquete", precioDelPaquete: 10000 },
    [{ tipo: "servicio", id: servicioId, cantidad: 1 }],
    [],
  );
  promoZonaId = promoZona!.id;
  await db.insert(promotionTarget).values({ promotionId: promoZonaId, bodyZoneId, cantidad: 1 });

  // ── CRÍTICO 1: un pack de N sesiones adentro de un paquete ──────────────
  // Área propia con tarifario propio: `conPrecioDePack` se va sin tocar el
  // precio si el área no tiene fila en `area_pack_policy`, y ninguna de las
  // áreas reales del catálogo local la tiene. Descuento 0 y redondeo 1 para
  // que la aritmética del test sea exacta y no dependa de la política.
  const [areaPack] = await db
    .insert(categories)
    .values({ name: `${QA}_AREA_PACK`, kind: "area", isActive: true })
    .returning({ id: categories.id });
  areaDePackId = areaPack!.id;
  await db.insert(areaPackPolicy).values({
    areaCategoryId: areaDePackId,
    packSessions: 4,
    packDiscountPercentage: 0,
    packRoundingBase: 1,
  });

  const [packA] = await db
    .insert(service)
    .values({ name: `${QA}_PACK_A`, isActive: false, unitPriceList: "10000" })
    .returning({ id: service.id });
  servicioPackAId = packA!.id;
  const [packB] = await db
    .insert(service)
    .values({ name: `${QA}_PACK_B`, isActive: false, unitPriceList: "5000" })
    .returning({ id: service.id });
  servicioPackBId = packB!.id;

  // El combo que el pack repite: dos servicios, $12.000 fijos la vuelta.
  const [comboDelPack] = await db
    .insert(combos)
    .values({ name: `${QA}_COMBO_DEL_PACK`, priceType: "fixed", fixedPrice: "12000",
             validityMonths: 12, isActive: true, isVisibleWeb: false, areaCategoryId: areaDePackId })
    .returning({ id: combos.id });
  comboDelPackId = comboDelPack!.id;
  await db.insert(comboService).values([
    { comboId: comboDelPackId, serviceId: servicioPackAId, sessionsIncluded: 1, servicePrice: "10000" },
    { comboId: comboDelPackId, serviceId: servicioPackBId, sessionsIncluded: 1, servicePrice: "5000" },
  ]);

  // El pack: 4 vueltas de ese combo. `getComboById` le va a devolver
  // `finalAmount` = 12.000 × 4 = $48.000 (descuento 0).
  const [pack] = await db
    .insert(combos)
    .values({ name: `${QA}_PACK_4`, priceType: "fixed", fixedPrice: "12000", validityMonths: 12,
             isActive: true, isVisibleWeb: false, areaCategoryId: areaDePackId,
             kind: "pack", packOfComboId: comboDelPackId, packSessions: 4, servicesTogether: false })
    .returning({ id: combos.id });
  packId = pack!.id;

  // Paquete de $118.000 = pack de $48.000 + servicio de $70.000. Al precio de
  // lista exacto, así el reparto no mete redondeos y los números del test
  // dicen lo que dicen.
  const promoConPack = await createPromotion(
    db,
    { name: `${QA}_CON_PACK`, promotionType: "paquete", precioDelPaquete: 118000 },
    [
      { tipo: "combo", id: packId, cantidad: 1 },
      { tipo: "servicio", id: servicioListaConocidaId, cantidad: 1 },
    ],
    [],
  );
  promoConPackId = promoConPack!.id;
});

afterAll(async () => {
  await limpiar();
  await pgClient.end();
});

describe("createCompra — el paquete", () => {
  it("crea UNA compra sin ningún origen suelto", async () => {
    const compra = await createCompra(db, {
      customerId: clienteId,
      esPaquete: true,
      promotionId: promoId,
      promotionName: QA,
      description: QA,
      sessionsTotal: 1,
      baseAmount: 335000,
      discountedAmount: 250000,
      finalAmount: 250000,
    });
    expect(compra.comboId).toBeNull();
    expect(compra.serviceId).toBeNull();

    const [fila] = await db
      .select({ es: customerPurchase.esPaqueteDePromo })
      .from(customerPurchase)
      .where(eq(customerPurchase.id, compra.id));
    expect(fila!.es).toBe(true);
    await cancelCompra(db, compra.id, "limpieza de test");
  });

  it("desglosa el paquete en una línea por cosa: 1 del combo + 3 del servicio", async () => {
    const compra = await createCompra(db, {
      customerId: clienteId, esPaquete: true, promotionId: promoId, promotionName: QA,
      description: QA, sessionsTotal: 1, baseAmount: 335000, discountedAmount: 250000, finalAmount: 250000,
    });
    const lineas = await db
      .select({ id: customerPurchaseService.id, price: customerPurchaseService.price })
      .from(customerPurchaseService)
      .where(eq(customerPurchaseService.customerPurchaseId, compra.id));
    expect(lineas).toHaveLength(4);
    await cancelCompra(db, compra.id, "limpieza de test");
  });

  it("las partes suman EXACTAMENTE el precio del paquete", async () => {
    // Si no sumara, cancelar le acreditaría a la clienta de más o de menos.
    const compra = await createCompra(db, {
      customerId: clienteId, esPaquete: true, promotionId: promoId, promotionName: QA,
      description: QA, sessionsTotal: 1, baseAmount: 335000, discountedAmount: 250000, finalAmount: 250000,
    });
    const lineas = await db
      .select({ price: customerPurchaseService.price })
      .from(customerPurchaseService)
      .where(eq(customerPurchaseService.customerPurchaseId, compra.id));
    const suma = lineas.reduce((a, l) => a + Number(l.price ?? 0), 0);
    expect(suma).toBe(250000);
    await cancelCompra(db, compra.id, "limpieza de test");
  });

  it("un paquete con un origen suelto NO se vende", async () => {
    // El CHECK de la base lo rechazaría igual, pero un error de Postgres crudo
    // no le dice nada a quien está vendiendo.
    await expect(
      createCompra(db, {
        customerId: clienteId, esPaquete: true, promotionId: promoId, promotionName: QA,
        comboId, description: QA, sessionsTotal: 1,
        baseAmount: 1, discountedAmount: 1, finalAmount: 1,
      }),
    ).rejects.toThrow(/paquete/i);
  });

  it("un paquete SIN promo no se vende: sin promo no hay qué desglosar", async () => {
    await expect(
      createCompra(db, {
        customerId: clienteId, esPaquete: true, description: QA, sessionsTotal: 1,
        baseAmount: 1, discountedAmount: 1, finalAmount: 1,
      }),
    ).rejects.toThrow(/promo/i);
  });

  // ── Importante 4 ───────────────────────────────────────────────────────
  it("un paquete no admite varias repeticiones en la cabecera", async () => {
    // `lineasDeUnPaquete` ya expandió cantidad × sessionsIncluded de cada
    // destino: aceptar sessionsTotal !== 1 en silencio multiplicaría todo
    // eso otra vez, y la cabecera diría "2 vueltas" con una sola vendida.
    await expect(
      createCompra(db, {
        customerId: clienteId, esPaquete: true, promotionId: promoId, promotionName: QA,
        description: QA, sessionsTotal: 2, baseAmount: 335000, discountedAmount: 250000, finalAmount: 250000,
      }),
    ).rejects.toThrow(/una sola vez/i);
  });
});

describe("createCompra — el paquete pesa cada parte por lo que vale, no por lo que suma", () => {
  // ── Crítico 2 ────────────────────────────────────────────────────────────
  it("un servicio sin unit_price_list usa unit_price_cash — y PESA por eso en el reparto", async () => {
    // Si el peso cayera en 0, el reparto le daría los $115.000 enteros al
    // servicio de lista conocida y $0 al que sólo tiene precio de efectivo.
    const compra = await createCompra(db, {
      customerId: clienteId, esPaquete: true, promotionId: promoSoloCashId,
      promotionName: `${QA}_SOLO_CASH`, description: `${QA}_SOLO_CASH`, sessionsTotal: 1,
      baseAmount: 115000, discountedAmount: 115000, finalAmount: 115000,
    });
    const lineas = await db
      .select({ price: customerPurchaseService.price, serviceId: customerPurchaseService.serviceId })
      .from(customerPurchaseService)
      .where(eq(customerPurchaseService.customerPurchaseId, compra.id));
    const soloCash = lineas.find((l) => l.serviceId === servicioSoloCashId);
    const listaConocida = lineas.find((l) => l.serviceId === servicioListaConocidaId);
    expect(Number(soloCash!.price)).toBe(45000);
    expect(Number(listaConocida!.price)).toBe(70000);
    await cancelCompra(db, compra.id, "limpieza de test");
  });

  it("un servicio sin ningún precio cargado NO se vende: adivinar sería peor", async () => {
    await expect(
      createCompra(db, {
        customerId: clienteId, esPaquete: true, promotionId: promoSinPrecioId,
        promotionName: `${QA}_SIN_PRECIO`, description: `${QA}_SIN_PRECIO`, sessionsTotal: 1,
        baseAmount: 10000, discountedAmount: 10000, finalAmount: 10000,
      }),
    ).rejects.toThrow(/no tiene precio/i);
  });

  // ── Importante 3 ───────────────────────────────────────────────────────
  it("un combo pesa lo que CUESTA, no la suma de lo que valen sus servicios", async () => {
    // Paquete $150.000 = combo de precio fijo $80.000 (sus servicios listan
    // $130.000) + servicio de $70.000. Ponderar por el subtotal ($130.000)
    // en vez del precio final ($80.000) le habría dado al combo $97.500 y al
    // servicio $52.500 — $17.500 de menos para la clienta al cancelar.
    const compra = await createCompra(db, {
      customerId: clienteId, esPaquete: true, promotionId: promoDosNivelesId,
      promotionName: `${QA}_DOS_NIVELES`, description: `${QA}_DOS_NIVELES`, sessionsTotal: 1,
      baseAmount: 200000, discountedAmount: 150000, finalAmount: 150000,
    });
    const lineas = await db
      .select({ price: customerPurchaseService.price, serviceId: customerPurchaseService.serviceId })
      .from(customerPurchaseService)
      .where(eq(customerPurchaseService.customerPurchaseId, compra.id));

    expect(lineas).toHaveLength(2);
    const delCombo = lineas.find((l) => l.serviceId === servicioId);
    const delServicio = lineas.find((l) => l.serviceId === servicioListaConocidaId);
    expect(Number(delCombo!.price)).toBe(80000);
    expect(Number(delServicio!.price)).toBe(70000);

    const suma = lineas.reduce((a, l) => a + Number(l.price ?? 0), 0);
    expect(suma).toBe(150000);
    await cancelCompra(db, compra.id, "limpieza de test");
  });
});

describe("createCompra — un pack adentro de un paquete entrega las N sesiones que cobra", () => {
  // ── CRÍTICO 1 (revisión final) ─────────────────────────────────────────
  // `getComboById(pack).finalAmount` YA viene multiplicado por las sesiones
  // del pack, pero `lineasParaVender` devuelve las líneas de UNA vuelta. En
  // la venta suelta la multiplicidad la aporta `sessionsTotal`; en un paquete
  // es 1 siempre. Sin expandir, la clienta paga 4 vueltas y agenda 1 — y al
  // cancelar, si usó esa única fila, se le acredita $0.
  async function venderElPaqueteConPack() {
    return createCompra(db, {
      customerId: clienteId, esPaquete: true, promotionId: promoConPackId,
      promotionName: `${QA}_CON_PACK`, description: `${QA}_CON_PACK`, sessionsTotal: 1,
      baseAmount: 118000, discountedAmount: 118000, finalAmount: 118000,
    });
  }

  it("crea N × (líneas del combo): un pack de 4 sobre un combo de 2 servicios da 8 filas", async () => {
    const compra = await venderElPaqueteConPack();
    const lineas = await db
      .select({ price: customerPurchaseService.price, serviceId: customerPurchaseService.serviceId })
      .from(customerPurchaseService)
      .where(eq(customerPurchaseService.customerPurchaseId, compra.id));

    expect(lineas.filter((l) => l.serviceId === servicioPackAId)).toHaveLength(4);
    expect(lineas.filter((l) => l.serviceId === servicioPackBId)).toHaveLength(4);
    // Más la del servicio suelto del paquete.
    expect(lineas).toHaveLength(9);
    await cancelCompra(db, compra.id, "limpieza de test");
  });

  it("y la suma de las partes SIGUE dando exactamente el precio del paquete", async () => {
    // La invariante que sostiene la devolución: si expandir rompiera el
    // reparto, cancelar le acreditaría a la clienta de más o de menos.
    const compra = await venderElPaqueteConPack();
    const lineas = await db
      .select({ price: customerPurchaseService.price, serviceId: customerPurchaseService.serviceId })
      .from(customerPurchaseService)
      .where(eq(customerPurchaseService.customerPurchaseId, compra.id));

    const suma = lineas.reduce((a, l) => a + Number(l.price ?? 0), 0);
    expect(suma).toBe(118000);

    // Y cada fila se lleva SU parte, no el precio del pack entero: las 4
    // vueltas del servicio de $10.000 valen $8.000 cada una dentro del
    // paquete, no $48.000 una y $0 las otras tres.
    const deA = lineas.filter((l) => l.serviceId === servicioPackAId).map((l) => Number(l.price));
    const deB = lineas.filter((l) => l.serviceId === servicioPackBId).map((l) => Number(l.price));
    expect(deA).toEqual([8000, 8000, 8000, 8000]);
    expect(deB).toEqual([4000, 4000, 4000, 4000]);
    // El pack completo pesa sus $48.000 y el servicio suelto sus $70.000.
    expect(deA.concat(deB).reduce((a, b) => a + b, 0)).toBe(48000);
    await cancelCompra(db, compra.id, "limpieza de test");
  });

  it("cotizar y vender pesan el pack IGUAL: el baseAmount cuadra con el reparto", async () => {
    // Las dos puntas leen el precio del pack por caminos distintos
    // (`preciosDeListaDe` → `obtenerItemVendible` vs. `getComboById` adentro
    // de `lineasDeUnPaquete`). Si una multiplicara por las sesiones y la otra
    // no, la pantalla mostraría un "valen $X" que el reparto no respeta.
    const promo = await obtenerPromoVendible(db, promoConPackId);
    const q = cotizarPaquete(promo!, await preciosDeListaDe(db, promo!.destinos), new Date());
    expect(q.baseAmount).toBe(118000);
    expect(q.finalAmount).toBe(118000);
  });
});

describe("createCompra — el paquete no se desentiende de destinos raros", () => {
  // ── Menor 1 ────────────────────────────────────────────────────────────
  it("un destino que no es servicio, combo ni pack de depilación no se pierde en silencio", async () => {
    await expect(
      createCompra(db, {
        customerId: clienteId, esPaquete: true, promotionId: promoZonaId,
        promotionName: `${QA}_ZONA`, description: `${QA}_ZONA`, sessionsTotal: 1,
        baseAmount: 10000, discountedAmount: 10000, finalAmount: 10000,
      }),
    ).rejects.toThrow(/destino/i);
  });

  // ── Menor 2 ────────────────────────────────────────────────────────────
  it("una promo de descuento no se vende como paquete", async () => {
    await expect(
      createCompra(db, {
        customerId: clienteId, esPaquete: true, promotionId: promoDescuentoId,
        promotionName: `${QA}_DESCUENTO`, description: `${QA}_DESCUENTO`, sessionsTotal: 1,
        baseAmount: 10000, discountedAmount: 10000, finalAmount: 10000,
      }),
    ).rejects.toThrow(/no es un paquete/i);
  });
});
