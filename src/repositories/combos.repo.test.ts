import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq, inArray, like } from "drizzle-orm";
import * as schema from "../db/schema";
import { areaPackPolicy, categories, combos, comboService, service } from "../db/schema";
import type { Db } from "../db/client";
import {
  assembleCombo,
  createCombo,
  deleteComboPermanently,
  freezePrices,
  getComboById,
  validarPrecioMenor,
} from "./combos.repo";

const combo = {
  id: "c1",
  name: "Depilación completa",
  priceType: "percentage",
  fixedPrice: null,
  discountPercentage: "20.00",
  validityMonths: 12,
  isActive: true,
  isVisibleWeb: true,
  displayOrder: 0,
};

const lineas = [
  { id: "l1", serviceId: "s1", serviceName: "Media pierna", serviceIsActive: true,
    sessionsIncluded: 8, servicePrice: "10000.00" },
  { id: "l2", serviceId: "s2", serviceName: "Axila", serviceIsActive: true,
    sessionsIncluded: 4, servicePrice: "5000.00" },
];

describe("assembleCombo", () => {
  it("calcula el subtotal multiplicando precio por sesiones de cada línea", () => {
    expect(assembleCombo(combo, lineas).servicesSubtotal).toBe(100000);
  });

  it("aplica el descuento porcentual al precio final", () => {
    expect(assembleCombo(combo, lineas).finalAmount).toBe(80000);
  });

  it("con precio fijo devuelve ese monto e ignora el subtotal", () => {
    const fijo = { ...combo, priceType: "fixed", fixedPrice: "65000.00", discountPercentage: null };
    expect(assembleCombo(fijo, lineas).finalAmount).toBe(65000);
  });

  it("convierte a número los decimal que Drizzle devuelve como string", () => {
    // Si esto se rompe, el front compara "80000" > 0 y muestra cualquier cosa.
    const out = assembleCombo(combo, lineas);
    expect(typeof out.discountPercentage).toBe("number");
    expect(typeof out.lines[0]!.servicePrice).toBe("number");
  });

  it("marca hasInactiveService si ALGUNA línea tiene el servicio archivado", () => {
    const conArchivado = [lineas[0]!, { ...lineas[1]!, serviceIsActive: false }];
    expect(assembleCombo(combo, conArchivado).hasInactiveService).toBe(true);
  });

  it("no marca hasInactiveService si están todos activos", () => {
    expect(assembleCombo(combo, lineas).hasInactiveService).toBe(false);
  });

  it("sin líneas da subtotal 0 y no rompe", () => {
    const out = assembleCombo(combo, []);
    expect(out.servicesSubtotal).toBe(0);
    expect(out.hasInactiveService).toBe(false);
  });
});

// ── Efectivo (1.66.0) ───────────────────────────────────────────────────────

describe("assembleCombo — efectivo", () => {
  const renglones = [
    { id: "l1", serviceId: "s1", serviceName: "A", serviceIsActive: true,
      sessionsIncluded: 1, servicePrice: "1000.00", servicePriceCash: "900.00" },
  ];

  it("combo calculado: el efectivo lleva el mismo % sobre la base de efectivo", () => {
    const c = { ...combo, discountPercentage: "20" };
    const out = assembleCombo(c, renglones);
    expect(out.finalAmount).toBe(800);
    expect(out.finalAmountCash).toBe(720);
  });

  it("combo a mano: efectivo escrito", () => {
    const c = { ...combo, priceType: "fixed", fixedPrice: "50000", fixedPriceCash: "45000", discountPercentage: null };
    const out = assembleCombo(c, renglones);
    expect(out.finalAmount).toBe(50000);
    expect(out.finalAmountCash).toBe(45000);
  });

  it("combo a mano sin efectivo: el efectivo es la lista, nunca 0", () => {
    const c = { ...combo, priceType: "fixed", fixedPrice: "50000", fixedPriceCash: null, discountPercentage: null };
    expect(assembleCombo(c, renglones).finalAmountCash).toBe(50000);
  });

  it("renglón viejo sin service_price_cash usa service_price", () => {
    const viejo = [{ ...renglones[0]!, servicePriceCash: null }];
    const out = assembleCombo(combo, viejo);
    expect(out.servicesSubtotalCash).toBe(1000);
    expect(out.lines[0]!.servicePriceCash).toBeNull();
  });
});

const pgClient = postgres("postgresql://piubella:piubella@localhost:5499/piubella", {
  max: 1,
  fetch_types: false,
  prepare: false,
});
const db = drizzle(pgClient, { schema }) as unknown as Db;
const QA = "ZZ_QA_COMBOS_EFECTIVO";

let areaId: string;
let sA: string; // 1000 / 900
let sB: string; // 500 / sin efectivo
let sC: string; // sin lista / 700

async function limpiar() {
  const cs = await db.select({ id: combos.id }).from(combos).where(like(combos.name, `${QA}%`));
  // Primero los packs (apuntan a combos), después los combos.
  for (const c of cs) await db.delete(comboService).where(eq(comboService.comboId, c.id));
  await db.delete(combos).where(like(combos.name, `${QA}_PACK%`));
  for (const c of cs) await deleteComboPermanently(db, c.id);
  await db.delete(service).where(like(service.name, `${QA}%`));
  const areas = await db.select({ id: categories.id }).from(categories).where(like(categories.name, `${QA}%`));
  if (areas.length) {
    await db.delete(areaPackPolicy).where(inArray(areaPackPolicy.areaCategoryId, areas.map((a) => a.id)));
    await db.delete(categories).where(like(categories.name, `${QA}%`));
  }
}

beforeAll(async () => {
  await limpiar();
  const [area] = await db
    .insert(categories)
    .values({ name: `${QA}_AREA`, kind: "area", isActive: true, displayOrder: 0 })
    .returning({ id: categories.id });
  areaId = area!.id;
  await db.insert(areaPackPolicy).values({
    areaCategoryId: areaId, packSessions: 4, packDiscountPercentage: 10, packRoundingBase: 500,
  });
  const mk = async (n: string, list: string | null, cash: string | null) => {
    const [r] = await db
      .insert(service)
      .values({ name: `${QA}_${n}`, isActive: true, unitPriceList: list, unitPriceCash: cash })
      .returning({ id: service.id });
    return r!.id;
  };
  sA = await mk("A", "1000", "900");
  sB = await mk("B", "500", null);
  sC = await mk("C", null, "700");
});

afterAll(async () => {
  await limpiar();
  await pgClient.end();
});

const base = { priceType: "percentage" as const, areaCategoryId: "" };
const header = (extra: Record<string, unknown>) =>
  ({ ...base, areaCategoryId: areaId, validityWeeks: 52, ...extra }) as never;

describe("freezePrices", () => {
  it("freezePrices congela lista y efectivo; sin efectivo usa lista; sin lista usa efectivo", async () => {
    const out = await freezePrices(db, [
      { serviceId: sA, sessionsIncluded: 1 },
      { serviceId: sB, sessionsIncluded: 1 },
      { serviceId: sC, sessionsIncluded: 1 },
    ]);
    expect(out.map((l) => l.servicePrice)).toEqual([1000, 500, 700]);
    expect(out.map((l) => l.servicePriceCash)).toEqual([900, 500, 700]);
  });
});

describe("packs con efectivo", () => {
  it("pack con %: el efectivo sale de la misma política y redondeo", async () => {
    const p = await createCombo(
      db,
      header({ name: `${QA}_PACK_PCT`, discountPercentage: 0, kind: "pack", packSessions: 4 }),
      [{ serviceId: sA, sessionsIncluded: 1 }],
    );
    expect(p!.finalAmount).toBe(3500); // 1000×4×0,9 = 3600 → 3500
    expect(p!.finalAmountCash).toBe(3000); // 900×4×0,9 = 3240 → 3000
    expect((p as any).packUnitAmountCash).toBe(900);
    expect((p as any).packDiscountSource).toBe("area");
  });

  it("pack de un combo: la base de efectivo es el finalAmountCash del combo", async () => {
    const combo = await createCombo(
      db,
      header({ name: `${QA}_COMBO_BASE`, priceType: "fixed", fixedPrice: 1800, fixedPriceCash: 1500, kind: "combo" }),
      [{ serviceId: sA, sessionsIncluded: 1 }, { serviceId: sA === sB ? sC : sB, sessionsIncluded: 1 }],
    );
    const p = await createCombo(
      db,
      header({ name: `${QA}_PACK_DE_COMBO`, discountPercentage: 0, kind: "pack", packSessions: 4, packOfComboId: combo!.id }),
      [],
    );
    expect((p as any).packUnitAmount).toBe(1800);
    expect((p as any).packUnitAmountCash).toBe(1500);
    expect(p!.finalAmount).toBe(6500); // 1800×4×0,9 = 6480 → 6500
    expect(p!.finalAmountCash).toBe(5500); // 1500×4×0,9 = 5400 → 5500
  });

  it("pack a mano: cobra lo escrito y packEffectiveSessions = packSessions", async () => {
    const p = await createCombo(
      db,
      header({
        name: `${QA}_PACK_MANO`, priceType: "fixed", fixedPrice: 30000, fixedPriceCash: 27000,
        kind: "pack", packSessions: 4,
      }),
      [{ serviceId: sA, sessionsIncluded: 1 }],
    );
    const leido = await getComboById(db, p!.id);
    expect(leido!.finalAmount).toBe(30000);
    expect(leido!.finalAmountCash).toBe(27000);
    expect((leido as any).packEffectiveSessions).toBe(4);
    expect((leido as any).packDiscountSource).toBe("a_mano");
  });
});

describe("validarPrecioMenor", () => {
  it("rechaza un combo a mano igual a la suma y acepta uno menor", async () => {
    const lines = [{ serviceId: sA, sessionsIncluded: 1 }, { serviceId: sB, sessionsIncluded: 1 }];
    const igual = await validarPrecioMenor(db, header({ name: "x", priceType: "fixed", fixedPrice: 1500 }), lines);
    expect(igual).toMatch(/tiene que ser menor que la suma/);
    const menor = await validarPrecioMenor(db, header({ name: "x", priceType: "fixed", fixedPrice: 1400 }), lines);
    expect(menor).toBeNull();
    // El efectivo escrito también cuenta: suma de efectivo = 900 + 500.
    const cashIgual = await validarPrecioMenor(
      db, header({ name: "x", priceType: "fixed", fixedPrice: 1400, fixedPriceCash: 1400 }), lines);
    expect(cashIgual).toMatch(/\$1\.400/);
  });

  it("rechaza un pack con 0% que queda igual a la suma", async () => {
    const r = await validarPrecioMenor(
      db,
      header({ name: "x", discountPercentage: 0, kind: "pack", packSessions: 4, packDiscountPercentage: 0, packRoundingBase: 1 }),
      [{ serviceId: sA, sessionsIncluded: 1 }],
    );
    expect(r).toBe("El precio final ($4.000) tiene que ser menor que la suma de lo que incluye ($4.000).");
  });

  it("en edición arma el combo existente con el encabezado nuevo", async () => {
    const c = await createCombo(
      db,
      header({ name: `${QA}_COMBO_EDIT`, priceType: "fixed", fixedPrice: 1000, kind: "combo" }),
      [{ serviceId: sA, sessionsIncluded: 1 }, { serviceId: sB, sessionsIncluded: 1 }],
    );
    expect(await validarPrecioMenor(db, { name: "x", priceType: "fixed", fixedPrice: 1500 } as never, [], c!.id))
      .toMatch(/menor/);
    expect(await validarPrecioMenor(db, { name: "x", priceType: "fixed", fixedPrice: 1499 } as never, [], c!.id))
      .toBeNull();
  });

  it("suma de las partes 0: no hay con qué comparar, la edición pasa", async () => {
    const c = await createCombo(
      db,
      header({ name: `${QA}_COMBO_VACIO`, priceType: "fixed", fixedPrice: 0, kind: "combo" }),
      [],
    );
    expect(await validarPrecioMenor(db, { name: "x", priceType: "fixed", fixedPrice: 500, displayOrder: 3 } as never, [], c!.id))
      .toBeNull();
    expect(await validarPrecioMenor(db, header({ name: "x", priceType: "fixed", fixedPrice: 500, fixedPriceCash: 400 }), []))
      .toBeNull();
  });
});
