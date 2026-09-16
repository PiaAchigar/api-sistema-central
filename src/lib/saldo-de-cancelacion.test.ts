import { describe, expect, it } from "vitest";
import {
  proporcionUsada,
  puedeDevolverse,
  saldoAAcreditar,
  valorDeLoUsado,
} from "./saldo-de-cancelacion";

/** Un pack de depilación de 3: no se desglosa, así que no hay precio por fila. */
const pack = (usadas: number) =>
  Array.from({ length: 3 }, (_, i) => ({ price: null, usado: i < usadas }));

const PACK_PAGADO = { finalAmount: 166000, servicios: pack(0) };

/**
 * El Combo1-prueba de producción, que es el que destapó el problema:
 * dos servicios con precios muy distintos.
 */
const BOTOX = 249000;
const DEPILACION = 17500;
const COMBO = 213200; // $266.500 con 20% off
const combo = (usados: { botox: boolean; depilacion: boolean }) => [
  { price: BOTOX, usado: usados.botox },
  { price: DEPILACION, usado: usados.depilacion },
];

describe("proporcionUsada — la regla, sin plata de por medio", () => {
  it("con precios, pesa cada servicio por lo que vale", () => {
    // El Botox es el 93,4% del combo, no la mitad.
    expect(proporcionUsada(combo({ botox: true, depilacion: false }))).toBeCloseTo(
      249000 / 266500,
      6,
    );
  });

  it("sin precios, reparte en partes iguales", () => {
    expect(proporcionUsada(pack(1))).toBeCloseTo(1 / 3, 6);
  });

  it("con todos los precios IGUALES da lo mismo que contar", () => {
    // Esto es lo que hace que sea UNA regla y no dos: un pack del mismo
    // servicio cae solo en el reparto por partes iguales.
    const tres = [
      { price: 65000, usado: true },
      { price: 65000, usado: false },
      { price: 65000, usado: false },
    ];
    expect(proporcionUsada(tres)).toBeCloseTo(proporcionUsada(pack(1)), 6);
  });

  it("si los precios suman cero, cuenta en vez de dividir por cero", () => {
    // Hay 9 servicios activos en producción sin ningún precio cargado.
    const sinPrecio = [
      { price: 0, usado: true },
      { price: 0, usado: false },
    ];
    expect(proporcionUsada(sinPrecio)).toBe(0.5);
  });

  it("sin servicios no usó nada", () => {
    expect(proporcionUsada([])).toBe(0);
  });
});

describe("saldoAAcreditar — un combo de precios distintos", () => {
  it("se hizo el Botox: le queda a favor lo que vale la depilación", () => {
    // Antes esto devolvía $106.600 —la mitad— por un servicio de $17.500.
    expect(
      saldoAAcreditar({
        pagado: COMBO,
        finalAmount: COMBO,
        servicios: combo({ botox: true, depilacion: false }),
      }),
    ).toBe(14000);
  });

  it("se hizo la depilación: le queda a favor casi todo", () => {
    expect(
      saldoAAcreditar({
        pagado: COMBO,
        finalAmount: COMBO,
        servicios: combo({ botox: false, depilacion: true }),
      }),
    ).toBe(199200);
  });

  it("los dos caminos NO dan lo mismo, que era el bug", () => {
    const a = saldoAAcreditar({
      pagado: COMBO,
      finalAmount: COMBO,
      servicios: combo({ botox: true, depilacion: false }),
    });
    const b = saldoAAcreditar({
      pagado: COMBO,
      finalAmount: COMBO,
      servicios: combo({ botox: false, depilacion: true }),
    });
    expect(a).not.toBe(b);
  });

  it("las dos partes suman lo pagado: no se devuelve de más ni de menos", () => {
    const a = saldoAAcreditar({
      pagado: COMBO,
      finalAmount: COMBO,
      servicios: combo({ botox: true, depilacion: false }),
    });
    const b = saldoAAcreditar({
      pagado: COMBO,
      finalAmount: COMBO,
      servicios: combo({ botox: false, depilacion: true }),
    });
    expect(a + b).toBe(COMBO);
  });
});

describe("valorDeLoUsado", () => {
  it("reparte el precio entre todos los servicios comprados", () => {
    expect(valorDeLoUsado(166000, pack(1))).toBe(55333);
  });

  it("sin servicios comprados no divide por cero", () => {
    expect(valorDeLoUsado(166000, [])).toBe(0);
  });
});

describe("saldoAAcreditar — una seña también queda a favor", () => {
  it("pagó una seña del 40% y no consumió: le queda toda a favor", () => {
    // Es lo primero que se le ofrece a la clienta: "tenés esta plata para el
    // tratamiento que quieras". Recién si no vuelve en 3 meses se pierde.
    expect(saldoAAcreditar({ pagado: 66400, ...PACK_PAGADO })).toBe(66400);
  });

  it("pagó una seña y consumió una sesión: se descuenta al precio", () => {
    // La sesión vale $55.333, no un tercio de la seña.
    expect(saldoAAcreditar({ pagado: 66400, finalAmount: 166000, servicios: pack(1) })).toBe(11067);
  });

  it("consumió más valor del que pagó: cero, no deuda", () => {
    // Pagó $66.400 y se hizo 2 sesiones que valen $110.667.
    expect(saldoAAcreditar({ pagado: 66400, finalAmount: 166000, servicios: pack(2) })).toBe(0);
  });
});

describe("saldoAAcreditar — pagado el 100%", () => {
  it("sin consumir, vuelve todo", () => {
    expect(saldoAAcreditar({ pagado: 166000, ...PACK_PAGADO })).toBe(166000);
  });

  it("con una de tres consumida, se descuenta esa sesión", () => {
    expect(saldoAAcreditar({ pagado: 166000, finalAmount: 166000, servicios: pack(1) })).toBe(110667);
  });

  it("con dos consumidas, queda una", () => {
    expect(saldoAAcreditar({ pagado: 166000, finalAmount: 166000, servicios: pack(2) })).toBe(55333);
  });

  it("consumido todo, no queda nada", () => {
    expect(saldoAAcreditar({ pagado: 166000, finalAmount: 166000, servicios: pack(3) })).toBe(0);
  });

  it("el redondeo nunca acredita más de lo pagado", () => {
    const partes = [0, 1, 2, 3].map((c) =>
      saldoAAcreditar({ pagado: 166000, finalAmount: 166000, servicios: pack(c) }),
    );
    expect(partes.every((p) => p <= 166000)).toBe(true);
  });

  it("pagó de más: vuelve lo que entró, no el precio", () => {
    expect(saldoAAcreditar({ pagado: 170000, ...PACK_PAGADO })).toBe(170000);
  });

  it("sin pagos no hay nada que acreditar", () => {
    expect(saldoAAcreditar({ pagado: 0, ...PACK_PAGADO })).toBe(0);
  });

  it("una compra sin servicios devuelve todo lo pagado", () => {
    // No debería existir, pero quedarse con la plata sería lo peor.
    expect(saldoAAcreditar({ pagado: 50000, finalAmount: 50000, servicios: [] })).toBe(50000);
  });
});

describe("puedeDevolverse", () => {
  it("pagada al 100%, sí", () => {
    expect(puedeDevolverse({ pagado: 166000, finalAmount: 166000 })).toBe(true);
  });

  it("con una seña, no", () => {
    expect(puedeDevolverse({ pagado: 66400, finalAmount: 166000 })).toBe(false);
  });

  it("sin pagar nada, no", () => {
    expect(puedeDevolverse({ pagado: 0, finalAmount: 166000 })).toBe(false);
  });
});
