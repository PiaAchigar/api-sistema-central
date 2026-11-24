import { describe, expect, it } from "vitest";
import { esLineaDeRetoque } from "./retoque";

describe("esLineaDeRetoque", () => {
  it("es retoque sólo la sesión N de N cuando el pack lo marca", () => {
    expect(esLineaDeRetoque({ repeticion: 2 }, { sessionsTotal: 2 }, true)).toBe(true);
    expect(esLineaDeRetoque({ repeticion: 1 }, { sessionsTotal: 2 }, true)).toBe(false);
  });
  it("si el pack no lo marca, ninguna lo es", () => {
    expect(esLineaDeRetoque({ repeticion: 2 }, { sessionsTotal: 2 }, false)).toBe(false);
  });
  it("sin número de sesión o sin total, no lo es", () => {
    expect(esLineaDeRetoque({ repeticion: null }, { sessionsTotal: 2 }, true)).toBe(false);
    expect(esLineaDeRetoque({ repeticion: 2 }, { sessionsTotal: null }, true)).toBe(false);
  });
});
