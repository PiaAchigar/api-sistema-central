import { describe, expect, it } from "vitest";
import { cotizar, type ItemVendible } from "./cotizacion";

const GLOBAL = { sesiones: 6, descuentoPct: 15, redondeo: 500 };
const COMPRA = new Date("2026-09-08T15:00:00Z");

const combo: ItemVendible = {
  origen: "combo",
  id: "c1",
  nombre: "Combo Facial Premium",
  base: 60000,
  conDescuento: 51000,
  validityMonths: 6,
};

const zona: ItemVendible = {
  origen: "depilacion",
  id: "d1",
  nombre: "Media pierna",
  unitario: 10000,
  politica: GLOBAL,
};

const servicio: ItemVendible = {
  origen: "servicio",
  id: "s1",
  nombre: "Venus Legacy 1 zona",
  unitario: 10000,
  politica: GLOBAL,
};

describe("cotizar — combo genérico", () => {
  it("una sola sesión, con el precio que ya tiene el catálogo", () => {
    // El combo ya trae su precio calculado por el dashboard. Recalcularlo acá
    // sería una segunda verdad sobre el mismo número.
    const q = cotizar(combo, 1, null, COMPRA);
    expect(q).toMatchObject({ sessionsTotal: 1, baseAmount: 60000, discountedAmount: 51000, finalAmount: 51000 });
  });

  it("vence a los meses de vigencia del combo", () => {
    expect(cotizar(combo, 1, null, COMPRA).expiresAt).toEqual(new Date("2027-03-08T15:00:00Z"));
  });

  it("sin vigencia cargada, no vence", () => {
    expect(cotizar({ ...combo, validityMonths: null }, 1, null, COMPRA).expiresAt).toBeNull();
  });

  it("la descripción dice qué se vendió", () => {
    expect(cotizar(combo, 1, null, COMPRA).description).toBe("Combo Facial Premium");
  });
});

describe("cotizar — pack por fórmula", () => {
  it("con las sesiones del pack corre la fórmula y descuenta", () => {
    const q = cotizar(zona, 6, null, COMPRA);
    expect(q.baseAmount).toBe(60000);
    expect(q.discountedAmount).toBe(51000); // 60000 × 0,85, redondeado a 500
    expect(q.finalAmount).toBe(51000);
  });

  it("la descripción dice cuántas sesiones lleva", () => {
    expect(cotizar(zona, 6, null, COMPRA).description).toBe("Media pierna — pack de 6");
  });

  it("un pack de depilación no vence", () => {
    expect(cotizar(zona, 6, null, COMPRA).expiresAt).toBeNull();
  });
});

describe("cotizar — sesiones que no son las del pack", () => {
  it("se venden al precio de lista, sin descuento", () => {
    // No es un pack: es comprar sesiones sueltas por adelantado. Aplicarles el
    // descuento del pack de 6 sería regalar plata.
    const q = cotizar(servicio, 2, null, COMPRA);
    expect(q.baseAmount).toBe(20000);
    expect(q.discountedAmount).toBe(20000);
  });

  it("una sesión sola tampoco descuenta", () => {
    const q = cotizar(servicio, 1, null, COMPRA);
    expect(q).toMatchObject({ baseAmount: 10000, discountedAmount: 10000, finalAmount: 10000 });
  });

  it("y no dice 'pack' en la descripción", () => {
    expect(cotizar(servicio, 2, null, COMPRA).description).toBe("Venus Legacy 1 zona — 2 sesiones");
    expect(cotizar(servicio, 1, null, COMPRA).description).toBe("Venus Legacy 1 zona");
  });

  it("un pack de UNA sesión no se llama pack", () => {
    // Una capacitación tiene política de 1 sesión: "Instructorado — pack de 1"
    // se lee como un error del sistema.
    const capacitacion: ItemVendible = {
      origen: "capacitacion",
      id: "t1",
      nombre: "Instructorado de Pilates",
      unitario: 403000,
      politica: { sesiones: 1, descuentoPct: 0, redondeo: 1 },
    };
    expect(cotizar(capacitacion, 1, null, COMPRA).description).toBe("Instructorado de Pilates");
  });

  it("con las del pack sí descuenta", () => {
    expect(cotizar(servicio, 6, null, COMPRA).discountedAmount).toBe(51000);
  });
});

describe("cotizar — la promo va encima de todo", () => {
  const promo = { id: "p1", name: "Primavera", discountPercentage: 10, discountAmount: null, destinos: [] };

  it("descuenta sobre el precio del pack, no sobre la base", () => {
    const q = cotizar(zona, 6, promo, COMPRA);
    expect(q.baseAmount).toBe(60000);
    expect(q.discountedAmount).toBe(51000);
    expect(q.finalAmount).toBe(45900); // 51000 − 10%
  });

  it("también aplica a un combo genérico", () => {
    expect(cotizar(combo, 1, promo, COMPRA).finalAmount).toBe(45900);
  });

  it("una promo en pesos se resta", () => {
    const enPesos = { id: "p2", name: "Fijo", discountPercentage: null, discountAmount: 1000, destinos: [] };
    expect(cotizar(zona, 6, enPesos, COMPRA).finalAmount).toBe(50000);
  });

  it("sin promo, el final es el descontado", () => {
    const q = cotizar(zona, 6, null, COMPRA);
    expect(q.finalAmount).toBe(q.discountedAmount);
  });

  it("guarda a qué promo corresponde", () => {
    expect(cotizar(zona, 6, promo, COMPRA).promotionId).toBe("p1");
    expect(cotizar(zona, 6, null, COMPRA).promotionId).toBeNull();
  });
});

describe("cotizar — lo que se rechaza", () => {
  it("cero sesiones no es una venta", () => {
    expect(() => cotizar(servicio, 0, null, COMPRA)).toThrow(/al menos una sesión/i);
  });

  it("un combo genérico se vende de a uno", () => {
    // `sessions_total = 1` es la regla del modelo: el combo YA es el paquete.
    expect(() => cotizar(combo, 3, null, COMPRA)).toThrow(/de a uno/i);
  });

  it("un item sin precio no se puede vender", () => {
    // Pasó de verdad con los combos congelados en $0: vender eso deja una
    // compra de cero pesos que después nadie entiende.
    expect(() => cotizar({ ...servicio, unitario: 0 }, 1, null, COMPRA)).toThrow(/sin precio/i);
  });
});

describe("cotizar — los montos siempre van de mayor a menor", () => {
  it("aunque la promo sea enorme, nunca queda negativo", () => {
    const enorme = { id: "p3", name: "Regalo", discountPercentage: null, discountAmount: 999999, destinos: [] };
    const q = cotizar(zona, 6, enorme, COMPRA);
    expect(q.finalAmount).toBe(0);
    expect(q.finalAmount).toBeLessThanOrEqual(q.discountedAmount);
    expect(q.discountedAmount).toBeLessThanOrEqual(q.baseAmount);
  });
});

// ── Packs de catálogo (1.50.0) ─────────────────────────────────────────────

describe("cotizar — un pack de catálogo", () => {
  /**
   * Un pack se vende como UNA unidad —"llevame el Facial × 4"— pero la clienta
   * se lleva CUATRO vueltas. Si `sessionsTotal` quedara en 1, la compra
   * crearía las filas de `customer_purchase_service` de una sola vuelta y a la
   * clienta le faltarían tres visitas que pagó.
   */
  const pack: ItemVendible = {
    origen: "combo",
    id: "p1",
    nombre: "Combo Facial × 4",
    base: 240000,
    // Ya viene con el descuento del pack aplicado por `conPrecioDePack`.
    conDescuento: 204000,
    validityMonths: 6,
    packSesiones: 4,
  };

  it("le da a la clienta las N sesiones del pack, no una sola", () => {
    expect(cotizar(pack, 1, null, COMPRA).sessionsTotal).toBe(4);
  });

  it("cobra el precio que ya trae calculado, sin volver a multiplicar", () => {
    const c = cotizar(pack, 1, null, COMPRA);
    expect(c.baseAmount).toBe(240000);
    expect(c.discountedAmount).toBe(204000);
    expect(c.finalAmount).toBe(204000);
  });

  it("un combo común sigue dando una sola sesión", () => {
    expect(cotizar(combo, 1, null, COMPRA).sessionsTotal).toBe(1);
  });

  it("se vende de a uno: pedir 2 packs sigue siendo un error", () => {
    expect(() => cotizar(pack, 2, null, COMPRA)).toThrow(/de a uno/i);
  });
});
