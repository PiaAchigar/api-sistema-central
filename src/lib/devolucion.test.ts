import { describe, expect, it } from "vitest";
import { razonesParaNoDevolver, montoADevolver, type CompraParaDevolver } from "./devolucion";

const base: CompraParaDevolver = {
  cancelada: true,
  pagado: 166000,
  finalAmount: 166000,
  totalDeServicios: 3,
  usadas: 1,
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
    expect(razonesParaNoDevolver({ ...base, usadas: 3, saldoDisponible: 0 })).toHaveLength(1);
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
    expect(montoADevolver({ ...base, usadas: 0, saldoDisponible: 166000 })).toBe(166000);
  });

  it("nunca más que el saldo que le queda", () => {
    // Gastó parte del saldo en otra compra: sólo se puede devolver lo que
    // todavía está.
    expect(montoADevolver({ ...base, saldoDisponible: 40000 })).toBe(40000);
  });

  it("una sesión perdida por no venir también descuenta", () => {
    // `usadas` ya trae consumidas + perdidas.
    expect(montoADevolver({ ...base, usadas: 2, saldoDisponible: 110667 })).toBe(55333);
  });

  it("consumido todo, cero", () => {
    expect(montoADevolver({ ...base, usadas: 3 })).toBe(0);
  });
});

describe("montoADevolver — el denominador son los SERVICIOS", () => {
  // Misma premisa equivocada que en `saldoAAcreditar`: hasta V3b las filas y
  // las repeticiones eran el mismo número, y estos tests lo daban por hecho.
  // Un combo suelto de 2 servicios tiene `sessions_total = 1` y DOS filas.
  it("combo de 2 servicios con uno hecho: se devuelve la mitad", () => {
    expect(
      montoADevolver({
        cancelada: true,
        pagado: 213200,
        finalAmount: 213200,
        totalDeServicios: 2,
        usadas: 1,
        saldoDisponible: 213200,
        yaDevuelta: false,
      }),
    ).toBe(106600);
  });
});
