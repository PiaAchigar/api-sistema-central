import { describe, expect, it } from "vitest";
import { promoAgotada, promoEstaVigente } from "./promo-vigente";

describe("promoEstaVigente", () => {
  const hoy = "2026-09-16";

  it("sin fechas, siempre vigente", () => {
    expect(promoEstaVigente({ validFrom: null, validUntil: null }, hoy)).toBe(true);
  });

  it("vence hoy: todavía vale", () => {
    // En UTC, entre las 21:00 y las 24:00 ART ya es mañana: una promo que
    // vence hoy desaparecía tres horas antes de tiempo.
    expect(promoEstaVigente({ validFrom: null, validUntil: hoy }, hoy)).toBe(true);
  });

  it("venció ayer: no vale", () => {
    expect(promoEstaVigente({ validFrom: null, validUntil: "2026-09-15" }, hoy)).toBe(false);
  });

  it("empieza mañana: todavía no vale", () => {
    // Esto NO se respetaba antes de 1.53.0: listPromosVendibles sólo miraba
    // valid_until, así que una promo programada ya se podía aplicar.
    expect(promoEstaVigente({ validFrom: "2026-09-17", validUntil: null }, hoy)).toBe(false);
  });

  it("empieza hoy: ya vale", () => {
    expect(promoEstaVigente({ validFrom: hoy, validUntil: null }, hoy)).toBe(true);
  });
});

describe("promoAgotada", () => {
  it("sin límite, nunca se agota", () => {
    expect(promoAgotada(null, 999)).toBe(false);
  });

  it("con usos por debajo del límite, no está agotada", () => {
    expect(promoAgotada(10, 9)).toBe(false);
  });

  it("al llegar al límite, se agota", () => {
    expect(promoAgotada(10, 10)).toBe(true);
  });

  it("un límite de cero agota la promo desde el arranque", () => {
    expect(promoAgotada(0, 0)).toBe(true);
  });
});
