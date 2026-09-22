import { describe, expect, it } from "vitest";
import { compraBody } from "./compras";

describe("el body de POST /purchases", () => {
  const base = {
    customerId: "11111111-1111-1111-1111-111111111111",
    description: "Promo Novia",
    sessionsTotal: 1,
    baseAmount: 335000,
    discountedAmount: 250000,
    finalAmount: 250000,
  };

  it("acepta un paquete sin ningún origen suelto", () => {
    const r = compraBody.safeParse({
      ...base,
      esPaquete: true,
      promotionId: "22222222-2222-2222-2222-222222222222",
    });
    expect(r.success).toBe(true);
  });

  it("un paquete SIN promo no pasa: sin promo no hay qué desglosar", () => {
    expect(compraBody.safeParse({ ...base, esPaquete: true }).success).toBe(false);
  });

  it("un paquete CON origen suelto no pasa", () => {
    const r = compraBody.safeParse({
      ...base,
      esPaquete: true,
      promotionId: "22222222-2222-2222-2222-222222222222",
      comboId: "33333333-3333-3333-3333-333333333333",
    });
    expect(r.success).toBe(false);
  });

  it("la venta de siempre sigue exigiendo exactamente un origen", () => {
    expect(
      compraBody.safeParse({ ...base, comboId: "33333333-3333-3333-3333-333333333333" }).success,
    ).toBe(true);
    expect(compraBody.safeParse(base).success).toBe(false);
  });
});
