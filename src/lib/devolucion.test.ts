import { describe, expect, it } from "vitest";
import { razonesParaNoDevolver, montoADevolver, type CompraParaDevolver } from "./devolucion";

/** Un pack de depilación de 3: no se desglosa, así que no hay precio por fila
 *  y el reparto es en partes iguales. */
const pack = (usadas: number) =>
  Array.from({ length: 3 }, (_, i) => ({ price: null, usado: i < usadas }));

const base: CompraParaDevolver = {
  cancelada: true,
  pagado: 166000,
  finalAmount: 166000,
  servicios: pack(1),
  saldoDisponible: 110667,
  yaDevuelta: false,
};

describe("razonesParaNoDevolver", () => {
  it("una compra cancelada y paga al 100% se puede devolver", () => {
    expect(razonesParaNoDevolver(base)).toEqual([]);
  });

  it("primero hay que cancelarla", () => {
    // Devolver la plata de algo que la clienta todavía tiene sería dejarle el
    // pack gratis.
    expect(razonesParaNoDevolver({ ...base, cancelada: false })).toEqual([
      "la compra sigue activa (hay que cancelarla primero)",
    ]);
  });

  it("una seña no se devuelve en efectivo", () => {
    expect(razonesParaNoDevolver({ ...base, pagado: 66400, saldoDisponible: 66400 })).toEqual([
      "no está paga al 100% (se pagaron $66.400 de $166.000) — esa plata queda a favor, pero no se devuelve en efectivo",
    ]);
  });

  it("no se devuelve dos veces", () => {
    expect(razonesParaNoDevolver({ ...base, yaDevuelta: true })).toEqual([
      "ya se le devolvió la plata de esta compra",
    ]);
  });

  it("si ya usó el saldo en otra cosa, no hay qué devolver", () => {
    // Se lo gastó en otro tratamiento: esa plata ya se la llevó en servicios.
    expect(razonesParaNoDevolver({ ...base, saldoDisponible: 0 })).toEqual([
      "ya no tiene saldo a favor (lo usó en otra compra)",
    ]);
  });

  it("si consumió todo, no queda nada a devolver", () => {
    expect(razonesParaNoDevolver({ ...base, servicios: pack(3), saldoDisponible: 0 })).toHaveLength(1);
  });

  it("junta todos los motivos", () => {
    const m = razonesParaNoDevolver({ ...base, cancelada: false, yaDevuelta: true });
    expect(m).toHaveLength(2);
  });

  it("una compra sin cancelar NO dice que se gastó el saldo", () => {
    // Todavía no acreditó nada: el saldo está en cero porque no hay nada
    // acreditado, no porque la clienta lo haya usado. Decir lo otro sería
    // mentirle a Laura sobre por qué no se puede.
    const m = razonesParaNoDevolver({ ...base, cancelada: false, saldoDisponible: 0 });
    expect(m).toEqual(["la compra sigue activa (hay que cancelarla primero)"]);
  });

  it("una seña tampoco lo dice", () => {
    const m = razonesParaNoDevolver({ ...base, pagado: 66400, saldoDisponible: 0 });
    expect(m).toHaveLength(1);
    expect(m[0]).toMatch(/no está paga al 100%/);
  });
});

describe("montoADevolver", () => {
  it("es lo pagado menos las sesiones usadas", () => {
    expect(montoADevolver(base)).toBe(110667);
  });

  it("sin usar nada, vuelve todo", () => {
    expect(montoADevolver({ ...base, servicios: pack(0), saldoDisponible: 166000 })).toBe(166000);
  });

  it("nunca más que el saldo que le queda", () => {
    // Gastó parte del saldo en otra compra: sólo se puede devolver lo que
    // todavía está.
    expect(montoADevolver({ ...base, saldoDisponible: 40000 })).toBe(40000);
  });

  it("una sesión perdida por no venir también descuenta", () => {
    // `usadas` ya trae consumidas + perdidas.
    expect(montoADevolver({ ...base, servicios: pack(2), saldoDisponible: 110667 })).toBe(55333);
  });

  it("consumido todo, cero", () => {
    expect(montoADevolver({ ...base, servicios: pack(3) })).toBe(0);
  });
});

describe("montoADevolver — un combo pesa por precio, no por cantidad", () => {
  /**
   * El Combo1-prueba de producción: Baby Botox $249.000 y una depilación
   * facial de $17.500, el combo entero a $213.200.
   *
   * Este test decía "se devuelve la mitad, $106.600". Era la misma cuenta que
   * le regalaba $92.000 a la clienta por un servicio de $17.500 (Pia,
   * 2026-09-16). La devolución en efectivo y el saldo a favor comparten la
   * cuenta, así que el error salía por las dos puertas.
   */
  const combo = (botoxHecho: boolean) => ({
    cancelada: true,
    pagado: 213200,
    finalAmount: 213200,
    servicios: [
      { price: 249000, usado: botoxHecho },
      { price: 17500, usado: !botoxHecho },
    ],
    saldoDisponible: 213200,
    yaDevuelta: false,
  });

  it("hecho el Botox, se devuelve lo que vale la depilación", () => {
    expect(montoADevolver(combo(true))).toBe(14000);
  });

  it("hecha la depilación, se devuelve casi todo", () => {
    expect(montoADevolver(combo(false))).toBe(199200);
  });
});
