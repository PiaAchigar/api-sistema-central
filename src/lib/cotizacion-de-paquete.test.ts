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

const catalogo = {
  precios: new Map([["c1", 80000], ["s1", 85000]]),
  nombres: new Map([["c1", "Combo Facial"], ["s1", "Masaje descontracturante"]]),
};

describe("cotizarPaquete", () => {
  it("el precio final es el del paquete, sin recalcular nada", () => {
    expect(cotizarPaquete(promo, catalogo, new Date()).finalAmount).toBe(250000);
  });

  it("la base es lo que valdría suelto, con las cantidades", () => {
    // 80.000 del combo + 3 × 85.000 del servicio = 335.000. Es el número que
    // deja mostrar "valen $335.000 — te los llevás por $250.000".
    expect(cotizarPaquete(promo, catalogo, new Date()).baseAmount).toBe(335000);
  });

  it("descontado y final son iguales: el paquete no tiene una segunda capa", () => {
    const q = cotizarPaquete(promo, catalogo, new Date());
    expect(q.discountedAmount).toBe(q.finalAmount);
  });

  it("la compra es UNA sola, aunque lleve seis cosas adentro", () => {
    // Es lo que hace que el cupo se cuente bien: la Promo Novia con límite 5
    // se puede vender 5 veces.
    expect(cotizarPaquete(promo, catalogo, new Date()).sessionsTotal).toBe(1);
  });

  it("la descripción es el nombre de la promo: es lo que va en la factura", () => {
    expect(cotizarPaquete(promo, catalogo, new Date()).description).toBe("Promo Novia");
  });

  it("si una parte no tiene precio conocido, no cotiza y la NOMBRA", () => {
    // Preferible a inventar un reparto (spec §5). Y el mensaje tiene que
    // decir qué falta con el nombre que Laura tildó, no con su UUID: es lo
    // único que la deja ir a arreglarlo.
    const sinPrecioDelServicio = { ...catalogo, precios: new Map([["c1", 80000]]) };
    expect(() => cotizarPaquete(promo, sinPrecioDelServicio, new Date())).toThrow(
      /Masaje descontracturante/,
    );
    expect(() => cotizarPaquete(promo, sinPrecioDelServicio, new Date())).not.toThrow(/s1,|: s1/);
  });

  it("un destino que ya no está en el catálogo cae al id: no hay mejor nombre que dar", () => {
    // Borrado después de armar la promo. Peor sería callarlo.
    const sinNombre = { precios: new Map([["c1", 80000]]), nombres: new Map([["c1", "Combo Facial"]]) };
    expect(() => cotizarPaquete(promo, sinNombre, new Date())).toThrow(/s1/);
  });

  it("una promo que NO es paquete no se cotiza por acá", () => {
    expect(() =>
      cotizarPaquete({ ...promo, promotionType: "percentage" }, catalogo, new Date()),
    ).toThrow(/paquete/i);
  });

  it("un paquete sin precio cargado no se vende", () => {
    expect(() => cotizarPaquete({ ...promo, precioDelPaquete: null }, catalogo, new Date())).toThrow(/precio/i);
  });
});
