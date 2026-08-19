import { describe, expect, it } from "vitest";
import { computeComboFinalPrice, computeComboSubtotal, precioDeServicio } from "./combo-pricing";

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

describe("precioDeServicio", () => {
  it("usa el precio de lista cuando está cargado", () => {
    expect(precioDeServicio("45000.00", "40000.00")).toBe(45000);
  });

  it("cae al precio de efectivo cuando no hay lista", () => {
    // El caso real de producción: 79 de 213 servicios activos sólo tienen
    // unit_price_cash. Antes de este respaldo, el combo se congelaba en $0.
    expect(precioDeServicio(null, "30000.00")).toBe(30000);
  });

  it("devuelve 0 si el servicio no tiene ningún precio cargado", () => {
    expect(precioDeServicio(null, null)).toBe(0);
    expect(precioDeServicio(undefined, undefined)).toBe(0);
  });

  it("acepta números además de los decimal string de Drizzle", () => {
    expect(precioDeServicio(45000, null)).toBe(45000);
  });

  it("no devuelve NaN ante un valor no numérico", () => {
    expect(precioDeServicio("no es un precio", null)).toBe(0);
  });
});
