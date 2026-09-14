import { describe, expect, it } from "vitest";
import {
  puedeDevolverse,
  saldoAAcreditar,
  valorDeUnServicioComprado,
} from "./saldo-de-cancelacion";

const PACK = { finalAmount: 166000, totalDeServicios: 3 };

describe("valorDeUnServicioComprado", () => {
  it("reparte el precio entre todos los servicios comprados", () => {
    expect(valorDeUnServicioComprado(166000, 3)).toBeCloseTo(55333.33, 2);
  });

  it("sin servicios comprados no divide por cero", () => {
    expect(valorDeUnServicioComprado(166000, 0)).toBe(0);
  });
});

describe("saldoAAcreditar — una seña también queda a favor", () => {
  it("pagó una seña del 40% y no consumió: le queda toda a favor", () => {
    // Es lo primero que se le ofrece a la clienta: "tenés esta plata para el
    // tratamiento que quieras". Recién si no vuelve en 3 meses se pierde.
    expect(saldoAAcreditar({ pagado: 66400, ...PACK, consumidas: 0 })).toBe(66400);
  });

  it("pagó una seña y consumió una sesión: se descuenta al precio", () => {
    // La sesión vale $55.333, no un tercio de la seña.
    expect(saldoAAcreditar({ pagado: 66400, ...PACK, consumidas: 1 })).toBe(11067);
  });

  it("consumió más valor del que pagó: cero, no deuda", () => {
    // Pagó $66.400 y se hizo 2 sesiones que valen $110.667.
    expect(saldoAAcreditar({ pagado: 66400, ...PACK, consumidas: 2 })).toBe(0);
  });
});

describe("saldoAAcreditar — pagado el 100%", () => {
  it("sin consumir, vuelve todo", () => {
    expect(saldoAAcreditar({ pagado: 166000, ...PACK, consumidas: 0 })).toBe(166000);
  });

  it("con una de tres consumida, se descuenta esa sesión", () => {
    expect(saldoAAcreditar({ pagado: 166000, ...PACK, consumidas: 1 })).toBe(110667);
  });

  it("con dos consumidas, queda una", () => {
    expect(saldoAAcreditar({ pagado: 166000, ...PACK, consumidas: 2 })).toBe(55333);
  });

  it("consumido todo, no queda nada", () => {
    expect(saldoAAcreditar({ pagado: 166000, ...PACK, consumidas: 3 })).toBe(0);
  });

  it("el redondeo nunca acredita más de lo pagado", () => {
    const partes = [0, 1, 2, 3].map((c) => saldoAAcreditar({ pagado: 166000, ...PACK, consumidas: c }));
    expect(partes.every((p) => p <= 166000)).toBe(true);
  });

  it("pagó de más: vuelve lo que entró, no el precio", () => {
    expect(saldoAAcreditar({ pagado: 180000, ...PACK, consumidas: 0 })).toBe(180000);
  });

  it("un servicio suelto ya hecho no deja nada", () => {
    expect(saldoAAcreditar({ pagado: 51000, finalAmount: 51000, totalDeServicios: 1, consumidas: 1 })).toBe(0);
  });

  it("las agendadas NO cuentan como consumidas", () => {
    // Sólo se descuenta lo que se HIZO. Si se rompió la máquina, ese turno se
    // reagenda desde la Agenda y la sesión sigue intacta.
    expect(saldoAAcreditar({ pagado: 166000, ...PACK, consumidas: 0 })).toBe(166000);
  });
});

describe("saldoAAcreditar — el denominador son los SERVICIOS, no las repeticiones", () => {
  // El caso real de Laura (2026-09-14, revisión final de V3b). "Combo1 -
  // Prueba": $213.200, `sessions_total = 1`, DOS servicios adentro → dos filas
  // de `customer_purchase_service`. La clienta pagó todo, se hizo el Baby
  // Botox y dejó la depilación facial a agendar.
  //
  // Con el denominador viejo (`sessionsTotal = 1`) la única sesión hecha se
  // comía la compra entera y el saldo a favor daba $0. El error es siempre del
  // mismo signo —las filas son ≥ que las repeticiones—, así que siempre se le
  // acreditaba de MENOS a la clienta.
  const COMBO_DE_DOS = { pagado: 213200, finalAmount: 213200, totalDeServicios: 2 };

  it("combo de 2 servicios con uno hecho: se descuenta la mitad", () => {
    expect(saldoAAcreditar({ ...COMBO_DE_DOS, consumidas: 1 })).toBe(106600);
  });

  it("combo de 2 servicios sin nada hecho: vuelve todo", () => {
    expect(saldoAAcreditar({ ...COMBO_DE_DOS, consumidas: 0 })).toBe(213200);
  });

  it("combo de 2 servicios con los dos hechos: no queda nada", () => {
    expect(saldoAAcreditar({ ...COMBO_DE_DOS, consumidas: 2 })).toBe(0);
  });

  it("pack de 3 de un combo de 2: seis filas, no tres", () => {
    // `sessions_total = 3` pero seis cosas que agendar. Con dos hechas quedan
    // cuatro sextos de la plata, no un tercio.
    expect(
      saldoAAcreditar({ pagado: 600000, finalAmount: 600000, totalDeServicios: 6, consumidas: 2 }),
    ).toBe(400000);
  });
});

describe("saldoAAcreditar — bordes", () => {
  it("si no pagó nada, no hay nada a favor", () => {
    expect(saldoAAcreditar({ pagado: 0, ...PACK, consumidas: 0 })).toBe(0);
  });

  it("una compra sin sesiones cargadas devuelve lo pagado", () => {
    expect(saldoAAcreditar({ pagado: 51000, finalAmount: 51000, totalDeServicios: 0, consumidas: 0 })).toBe(51000);
  });
});

describe("puedeDevolverse — la plata en mano exige el 100%", () => {
  it("pagado entero: sí", () => {
    expect(puedeDevolverse({ pagado: 166000, finalAmount: 166000 })).toBe(true);
  });

  it("una seña: no", () => {
    // Le queda a favor, pero no se le saca de la caja.
    expect(puedeDevolverse({ pagado: 66400, finalAmount: 166000 })).toBe(false);
  });

  it("casi todo pero no todo: no", () => {
    expect(puedeDevolverse({ pagado: 165000, finalAmount: 166000 })).toBe(false);
  });

  it("pagó de más: sí, con más razón está paga", () => {
    expect(puedeDevolverse({ pagado: 180000, finalAmount: 166000 })).toBe(true);
  });

  it("sin pagar nada no hay nada que devolver", () => {
    // El 0 >= 0 de una compra sin precio diría que sí. No hay plata: es que no.
    expect(puedeDevolverse({ pagado: 0, finalAmount: 0 })).toBe(false);
  });
});
