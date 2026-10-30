import { describe, expect, it } from "vitest";
import { ajusteSchema, calcularFila, precioNuevo, type Ajuste } from "./ajuste-de-precios";

const subir10 = (redondeo: Ajuste["redondeo"] = 100): Ajuste => ({
  direccion: "subir",
  modo: "porcentaje",
  valor: 10,
  redondeo,
});

describe("precioNuevo", () => {
  it("sube un porcentaje y redondea al múltiplo más cercano", () => {
    expect(precioNuevo(45000, { direccion: "subir", modo: "porcentaje", valor: 10, redondeo: 100 })).toBe(49500);
  });

  it("45150 +10% a 1000 → 49665 redondea a 50000", () => {
    expect(precioNuevo(45150, subir10(1000))).toBe(50000);
  });

  it("baja un monto fijo y redondea a 500", () => {
    expect(precioNuevo(40000, { direccion: "bajar", modo: "monto", valor: 2500, redondeo: 500 })).toBe(37500);
  });

  it("sin redondeo (redondeo 1) deja pesos enteros", () => {
    expect(precioNuevo(12345, { direccion: "subir", modo: "porcentaje", valor: 3, redondeo: 1 })).toBe(12715);
  });
});

describe("calcularFila", () => {
  it("sin lista (null o 0) → sin_precio y ambos quedan en null", () => {
    expect(calcularFila(null, 5000, subir10())).toEqual({
      listaDespues: null,
      efectivoDespues: null,
      estado: "sin_precio",
    });
    expect(calcularFila(0, 5000, subir10())).toEqual({
      listaDespues: null,
      efectivoDespues: null,
      estado: "sin_precio",
    });
  });

  it("lista con precio, efectivo vacío → cambia sólo la lista", () => {
    expect(calcularFila(45000, null, subir10())).toEqual({
      listaDespues: 49500,
      efectivoDespues: null,
      estado: "cambia",
    });
  });

  it("un precio que queda ≤ 0 → invalido", () => {
    expect(
      calcularFila(1000, 900, { direccion: "bajar", modo: "monto", valor: 1000, redondeo: 100 }),
    ).toMatchObject({ estado: "invalido" });
  });

  it("si el redondeo no mueve ningún precio → no_cambia", () => {
    expect(
      calcularFila(45000, 40000, { direccion: "subir", modo: "porcentaje", valor: 0.1, redondeo: 1000 }),
    ).toMatchObject({ listaDespues: 45000, efectivoDespues: 40000, estado: "no_cambia" });
  });
});

describe("ajusteSchema", () => {
  const base = { direccion: "subir", modo: "porcentaje", valor: 10, redondeo: 100 };

  it("rechaza valor 0", () => {
    expect(ajusteSchema.safeParse({ ...base, valor: 0 }).success).toBe(false);
  });

  it("rechaza bajar en porcentaje 100 o más", () => {
    expect(ajusteSchema.safeParse({ ...base, direccion: "bajar", valor: 100 }).success).toBe(false);
  });

  it("rechaza monto con decimales", () => {
    expect(ajusteSchema.safeParse({ ...base, modo: "monto", valor: 10.5 }).success).toBe(false);
  });

  it("rechaza redondeo fuera de {1,100,500,1000}", () => {
    expect(ajusteSchema.safeParse({ ...base, redondeo: 250 }).success).toBe(false);
  });

  it("acepta subir en porcentaje 150", () => {
    expect(ajusteSchema.safeParse({ ...base, valor: 150 }).success).toBe(true);
  });
});
