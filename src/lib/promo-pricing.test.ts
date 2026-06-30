import { describe, expect, it } from "vitest";
import { applyDiscount, computeMargin } from "./promo-pricing";

describe("applyDiscount", () => {
  it("aplica porcentaje", () => {
    expect(applyDiscount(1000, "percentage", 20, null)).toBe(800);
  });
  it("aplica monto fijo", () => {
    expect(applyDiscount(1000, "fixed_amount", null, 300)).toBe(700);
  });
  it("nunca baja de 0", () => {
    expect(applyDiscount(100, "fixed_amount", null, 500)).toBe(0);
  });
  it("sin tipo devuelve el subtotal", () => {
    expect(applyDiscount(1000, null, null, null)).toBe(1000);
  });
  it("porcentaje sin valor devuelve el subtotal", () => {
    expect(applyDiscount(1000, "percentage", null, null)).toBe(1000);
  });
});

describe("computeMargin", () => {
  it("total menos pagos a proveedoras", () => {
    expect(computeMargin(800, [200, 150])).toBe(450);
  });
  it("sin pagos, margen = total", () => {
    expect(computeMargin(800, [])).toBe(800);
  });
});
