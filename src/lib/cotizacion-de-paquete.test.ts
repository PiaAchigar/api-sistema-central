import { describe, expect, it } from "vitest";
import { cotizarPaquete } from "./cotizacion-de-paquete";

const promo = {
  id: "pr1",
  name: "Promo Novia",
  promotionType: "paquete",
  precioDelPaquete: 250000,
  destinos: [
    { tipo: "combo" as const, id: "c1", cantidad: 1 },
    { tipo: "servicio" as const, id: "s1", cantidad: 3 },
  ],
};

const precios = new Map([["c1", 80000], ["s1", 85000]]);

describe("cotizarPaquete", () => {
  it("el precio final es el del paquete, sin recalcular nada", () => {
    expect(cotizarPaquete(promo, precios, new Date()).finalAmount).toBe(250000);
  });

  it("la base es lo que valdría suelto, con las cantidades", () => {
    // 80.000 del combo + 3 × 85.000 del servicio = 335.000. Es el número que
    // deja mostrar "valen $335.000 — te los llevás por $250.000".
    expect(cotizarPaquete(promo, precios, new Date()).baseAmount).toBe(335000);
  });

  it("descontado y final son iguales: el paquete no tiene una segunda capa", () => {
    const q = cotizarPaquete(promo, precios, new Date());
    expect(q.discountedAmount).toBe(q.finalAmount);
  });

  it("la compra es UNA sola, aunque lleve seis cosas adentro", () => {
    // Es lo que hace que el cupo se cuente bien: la Promo Novia con límite 5
    // se puede vender 5 veces.
    expect(cotizarPaquete(promo, precios, new Date()).sessionsTotal).toBe(1);
  });

  it("la descripción es el nombre de la promo: es lo que va en la factura", () => {
    expect(cotizarPaquete(promo, precios, new Date()).description).toBe("Promo Novia");
  });

  it("si una parte no tiene precio conocido, no cotiza y dice cuál", () => {
    // Preferible a inventar un reparto (spec §5).
    expect(() => cotizarPaquete(promo, new Map([["c1", 80000]]), new Date())).toThrow(/s1/);
  });

  it("una promo que NO es paquete no se cotiza por acá", () => {
    expect(() =>
      cotizarPaquete({ ...promo, promotionType: "percentage" }, precios, new Date()),
    ).toThrow(/paquete/i);
  });

  it("un paquete sin precio cargado no se vende", () => {
    expect(() => cotizarPaquete({ ...promo, precioDelPaquete: null }, precios, new Date())).toThrow(/precio/i);
  });
});
