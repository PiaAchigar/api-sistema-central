import { describe, expect, it } from "vitest";
import { computeComboFinalPrice, computeComboSubtotal } from "./combo-pricing";

describe("computeComboSubtotal", () => {
  it("multiplica el precio de cada servicio por sus sesiones", () => {
    const subtotal = computeComboSubtotal([
      { servicePrice: 10000, sessionsIncluded: 8 },
      { servicePrice: 5000, sessionsIncluded: 4 },
    ]);
    expect(subtotal).toBe(100000);
  });

  it("devuelve 0 si no hay líneas", () => {
    expect(computeComboSubtotal([])).toBe(0);
  });

  it("cuenta una sola línea", () => {
    expect(computeComboSubtotal([{ servicePrice: 7500, sessionsIncluded: 3 }])).toBe(22500);
  });
});

describe("computeComboFinalPrice", () => {
  it("con 'fixed' devuelve el precio cerrado e IGNORA el subtotal", () => {
    // Es la diferencia clave con las promos: acá 'fixed' NO resta del subtotal.
    expect(computeComboFinalPrice(100000, "fixed", 60000, null)).toBe(60000);
  });

  it("con 'percentage' descuenta ese porcentaje del subtotal", () => {
    expect(computeComboFinalPrice(100000, "percentage", null, 25)).toBe(75000);
  });

  it("con 0% deja el subtotal intacto", () => {
    expect(computeComboFinalPrice(100000, "percentage", null, 0)).toBe(100000);
  });

  it("con 100% da cero (combo de regalo)", () => {
    expect(computeComboFinalPrice(100000, "percentage", null, 100)).toBe(0);
  });

  it("con 'fixed' mayor al subtotal devuelve el fijo, sin recortar", () => {
    // Puede ser intencional: un combo financiado sale más que la suma suelta.
    expect(computeComboFinalPrice(50000, "fixed", 80000, null)).toBe(80000);
  });

  it("nunca devuelve negativo", () => {
    expect(computeComboFinalPrice(100000, "fixed", -5000, null)).toBe(0);
    expect(computeComboFinalPrice(100000, "percentage", null, 150)).toBe(0);
  });

  it("si falta el dato del precio, cae al subtotal en vez de romper", () => {
    expect(computeComboFinalPrice(100000, "fixed", null, null)).toBe(100000);
    expect(computeComboFinalPrice(100000, "percentage", null, null)).toBe(100000);
    expect(computeComboFinalPrice(100000, null, null, null)).toBe(100000);
  });
});
