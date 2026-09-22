import { describe, expect, it } from "vitest";
import { cotizarPaquete, razonParaNoVenderElPaquete } from "./cotizacion-de-paquete";

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

describe("cotizarPaquete — un paquete no puede salir más caro que sus partes", () => {
  // ── IMPORTANTE 4 (revisión final de la 1.55.0) ─────────────────────────
  // Antes esto cotizaba redondo y el `.refine` de `compraBody` tiraba "Los
  // montos tienen que ir de mayor a menor" recién al apretar Vender — un
  // mensaje sobre tres campos de un JSON, para un error que está en el precio
  // que Laura cargó en la promo.
  const caro = { ...promo, precioDelPaquete: 400000 };

  it("se rechaza al COTIZAR, no al vender", () => {
    expect(() => cotizarPaquete(caro, catalogo, new Date())).toThrow(/más caro/i);
  });

  it("y el mensaje dice los dos montos, para que se entienda qué revisar", () => {
    let mensaje = "";
    try {
      cotizarPaquete(caro, catalogo, new Date());
    } catch (e) {
      mensaje = (e as Error).message;
    }
    // 400.000 cargado contra 335.000 de lista (80.000 + 3 × 85.000).
    expect(mensaje).toContain("400.000");
    expect(mensaje).toContain("335.000");
    expect(mensaje).toContain("Promo Novia");
  });

  it("un paquete al precio EXACTO de sus partes sigue cotizando: no hay descuento mínimo", () => {
    // Un paquete que no descuenta nada es raro pero no es un error de carga;
    // el que cobra de más sí.
    const alCosto = { ...promo, precioDelPaquete: 335000 };
    expect(cotizarPaquete(alCosto, catalogo, new Date()).finalAmount).toBe(335000);
  });
});

describe("razonParaNoVenderElPaquete", () => {
  // ── IMPORTANTE 4 ───────────────────────────────────────────────────────
  // El `finalAmount` que llega no sólo se congela: es el número que se reparte
  // entre las líneas de la compra.
  const laPromo = { name: "Promo Novia", precioDelPaquete: 250000 };

  it("el precio que manda la pantalla tiene que ser el de la promo", () => {
    expect(razonParaNoVenderElPaquete(laPromo, 250000)).toBeNull();
  });

  it("si no coincide se RECHAZA, no se pisa en silencio", () => {
    // Pisarlo vendería a un precio que Laura no vio, y escondería que la
    // pantalla se le quedó atrás.
    expect(razonParaNoVenderElPaquete(laPromo, 200000)).toMatch(/pantalla quedó vieja/i);
  });

  it("y el mensaje trae los DOS montos", () => {
    const r = razonParaNoVenderElPaquete(laPromo, 200000)!;
    expect(r).toContain("250.000");
    expect(r).toContain("200.000");
  });

  it("cobrar de MÁS tampoco pasa", () => {
    expect(razonParaNoVenderElPaquete(laPromo, 300000)).not.toBeNull();
  });

  it("una promo sin precio de paquete no se vende", () => {
    expect(razonParaNoVenderElPaquete({ name: "X", precioDelPaquete: null }, 100)).toMatch(/precio/i);
  });
});
