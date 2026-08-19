import { describe, expect, it } from "vitest";
import { comboBody } from "./combos";

const valido = {
  name: "Depilación cuerpo completo",
  priceType: "fixed" as const,
  fixedPrice: 120000,
  validityMonths: 12,
  lines: [{ serviceId: "11111111-1111-1111-1111-111111111111", sessionsIncluded: 8 }],
};

describe("comboBody", () => {
  it("acepta un combo válido", () => {
    expect(comboBody.safeParse(valido).success).toBe(true);
  });

  it("rechaza un combo sin líneas: un combo sin servicios no es nada", () => {
    const r = comboBody.safeParse({ ...valido, lines: [] });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.message).toMatch(/al menos un servicio/i);
  });

  it("rechaza sessions_included en 0", () => {
    const r = comboBody.safeParse({
      ...valido,
      lines: [{ serviceId: "11111111-1111-1111-1111-111111111111", sessionsIncluded: 0 }],
    });
    expect(r.success).toBe(false);
  });

  it("rechaza sessions_included no entero", () => {
    const r = comboBody.safeParse({
      ...valido,
      lines: [{ serviceId: "11111111-1111-1111-1111-111111111111", sessionsIncluded: 2.5 }],
    });
    expect(r.success).toBe(false);
  });

  it("rechaza priceType 'fixed' sin fixedPrice", () => {
    const { fixedPrice: _, ...sinPrecio } = valido;
    const r = comboBody.safeParse(sinPrecio);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.message).toMatch(/precio/i);
  });

  it("rechaza priceType 'percentage' sin discountPercentage", () => {
    const { fixedPrice: _, ...resto } = valido;
    const r = comboBody.safeParse({ ...resto, priceType: "percentage" });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.message).toMatch(/porcentaje/i);
  });

  it("acepta 'percentage' con su porcentaje", () => {
    const { fixedPrice: _, ...resto } = valido;
    const r = comboBody.safeParse({ ...resto, priceType: "percentage", discountPercentage: 20 });
    expect(r.success).toBe(true);
  });

  it("rechaza un porcentaje mayor a 100", () => {
    const { fixedPrice: _, ...resto } = valido;
    const r = comboBody.safeParse({ ...resto, priceType: "percentage", discountPercentage: 120 });
    expect(r.success).toBe(false);
  });

  it("rechaza validityMonths en 0", () => {
    expect(comboBody.safeParse({ ...valido, validityMonths: 0 }).success).toBe(false);
  });

  it("rechaza el mismo servicio dos veces en el mismo combo", () => {
    const r = comboBody.safeParse({
      ...valido,
      lines: [
        { serviceId: "11111111-1111-1111-1111-111111111111", sessionsIncluded: 8 },
        { serviceId: "11111111-1111-1111-1111-111111111111", sessionsIncluded: 4 },
      ],
    });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.message).toMatch(/repetido/i);
  });
});
