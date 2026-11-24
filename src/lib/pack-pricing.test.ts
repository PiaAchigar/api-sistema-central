import { describe, expect, it } from "vitest";
import { aplicarPromo, precioDeCompra, precioPack } from "./pack-pricing";

const GLOBAL = { packSesiones: 6, packDescuentoPct: 15, packRedondeo: 500 };

describe("aplicarPromo", () => {
  it("sin promo devuelve el mismo precio", () => {
    expect(aplicarPromo(50000, null)).toBe(50000);
    expect(aplicarPromo(50000, undefined)).toBe(50000);
  });

  it("aplica el porcentaje", () => {
    expect(aplicarPromo(50000, { discountPercentage: 15 })).toBe(42500);
  });

  it("aplica el monto fijo", () => {
    expect(aplicarPromo(50000, { discountAmount: 7000 })).toBe(43000);
  });

  it("redondea al peso, no a la base de redondeo del pack", () => {
    // El redondeo a $500 es una política de precios de LISTA. Un 15% sobre un
    // precio de lista no tiene por qué volver a caer en un múltiplo de 500.
    expect(aplicarPromo(45500, { discountPercentage: 15 })).toBe(38675);
  });

  it("un descuento más grande que el precio da 0, no negativo", () => {
    // Un negativo se cobraría al revés más adelante.
    expect(aplicarPromo(5000, { discountAmount: 9000 })).toBe(0);
  });

  it("el porcentaje gana si vinieran los dos", () => {
    expect(aplicarPromo(50000, { discountPercentage: 10, discountAmount: 40000 })).toBe(45000);
  });

  it("una promo sin ningún descuento no descuenta", () => {
    // Las 65 'promotions' de producción son bundles sin precio: si esto
    // devolviera 0 o NaN, regalaría el tratamiento.
    expect(aplicarPromo(50000, {})).toBe(50000);
    expect(aplicarPromo(50000, { discountPercentage: null, discountAmount: null })).toBe(50000);
  });
});

describe("precioDeCompra — capa 1 por fórmula", () => {
  it("la base es el unitario por las sesiones, sin descuento", () => {
    const p = precioDeCompra(10000, 6, { forma: "formula", config: GLOBAL });
    expect(p.baseAmount).toBe(60000);
  });

  it("el descuento del pack sale de la fórmula", () => {
    // 10000 × 6 × 0.85 = 51000, ya múltiplo de 500.
    const p = precioDeCompra(10000, 6, { forma: "formula", config: GLOBAL });
    expect(p.discountedAmount).toBe(51000);
  });

  it("NO multiplica dos veces las sesiones", () => {
    // La fórmula ya multiplica por dentro. Volver a multiplicar acá daría
    // 306000 en vez de 51000: es el error de plata más fácil de cometer.
    const p = precioDeCompra(10000, 6, { forma: "formula", config: GLOBAL });
    expect(p.discountedAmount).toBeLessThan(p.baseAmount);
  });

  it("respeta la política propia del combo por encima de la global", () => {
    const propia = { sesiones: 4, descuentoPct: 20, redondeo: 100 };
    const p = precioDeCompra(10000, 4, { forma: "formula", config: GLOBAL, propia });
    expect(p.discountedAmount).toBe(32000); // 10000 × 4 × 0.80
  });

  it("revienta si las sesiones no son las de la política", () => {
    // La fórmula usa las sesiones de la política; la base usa las que le
    // pasan. Si no coinciden, base y descuento hablan de packs distintos y el
    // resultado es plata mal cobrada, en silencio.
    expect(() => precioDeCompra(10000, 8, { forma: "formula", config: GLOBAL })).toThrow(
      /sesiones/i,
    );
  });
});

describe("precioDeCompra — capa 1 por precio fijo", () => {
  it("el precio fijo se multiplica por las sesiones y la fórmula no interviene", () => {
    const p = precioDeCompra(10000, 4, { forma: "fijo", precioFijo: 7000 });
    expect(p.baseAmount).toBe(40000);
    expect(p.discountedAmount).toBe(28000);
  });

  it("acepta cualquier cantidad de sesiones: no hay política que respetar", () => {
    expect(() => precioDeCompra(10000, 99, { forma: "fijo", precioFijo: 7000 })).not.toThrow();
  });

  it("un combo suelto es una compra de una sesión", () => {
    // Un combo vendido entra en la misma tabla con sessions_total = 1.
    const p = precioDeCompra(30000, 1, { forma: "fijo", precioFijo: 25000 });
    expect(p.discountedAmount).toBe(25000);
  });
});

describe("precioDeCompra — las dos capas juntas", () => {
  it("la promo se aplica DESPUÉS del descuento del pack", () => {
    // 51000 con 10% → 45900. Al revés (promo primero) daría lo mismo acá, pero
    // no con redondeos: el orden tiene que ser siempre este.
    const p = precioDeCompra(10000, 6, { forma: "formula", config: GLOBAL }, {
      discountPercentage: 10,
    });
    expect(p.discountedAmount).toBe(51000);
    expect(p.finalAmount).toBe(45900);
  });

  it("sin promo, el final es igual al descontado", () => {
    const p = precioDeCompra(10000, 6, { forma: "formula", config: GLOBAL });
    expect(p.finalAmount).toBe(p.discountedAmount);
  });

  it("los tres montos quedan en orden de mayor a menor", () => {
    const p = precioDeCompra(10000, 6, { forma: "formula", config: GLOBAL }, {
      discountPercentage: 10,
    });
    expect(p.baseAmount).toBeGreaterThan(p.discountedAmount);
    expect(p.discountedAmount).toBeGreaterThan(p.finalAmount);
  });
});

describe("precioPack sigue andando igual que antes de moverse", () => {
  it("redondea una sola vez, al final", () => {
    expect(precioPack(10000, GLOBAL)).toBe(51000);
  });

  it("con la política propia usa esa", () => {
    expect(precioPack(10000, GLOBAL, { sesiones: 4, descuentoPct: 20, redondeo: 100 })).toBe(32000);
  });
});

describe("precioPack con sesiones sin cobrar (retoque)", () => {
  const propia = { sesiones: 2, descuentoPct: 10, redondeo: 100 };

  it("un pack de 2 con el retoque sin cobrar cuesta una sesión, con descuento", () => {
    expect(precioPack(10000, GLOBAL, propia, 1)).toBe(9000);
  });

  it("un pack de 4 con retoque cobra 3", () => {
    expect(precioPack(10000, GLOBAL, { ...propia, sesiones: 4 }, 1)).toBe(27000);
  });

  it("sin sesiones sin cobrar es igual que antes", () => {
    expect(precioPack(10000, GLOBAL, propia, 0)).toBe(18000);
    expect(precioPack(10000, GLOBAL, propia)).toBe(18000);
  });

  it("nunca cobra menos de una sesión ni cuenta negativas", () => {
    expect(precioPack(10000, GLOBAL, { ...propia, sesiones: 2 }, 5)).toBe(9000);
    expect(precioPack(10000, GLOBAL, propia, -3)).toBe(18000);
  });
});
