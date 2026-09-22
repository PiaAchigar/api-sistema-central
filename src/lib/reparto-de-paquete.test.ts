import { describe, expect, it } from "vitest";
import { repartirPrecioDelPaquete } from "./reparto-de-paquete";

describe("repartirPrecioDelPaquete", () => {
  it("reparte proporcional al precio de lista", () => {
    // 100.000 y 300.000 → una cuarta parte y tres cuartas partes.
    expect(repartirPrecioDelPaquete(200000, [100000, 300000])).toEqual([50000, 150000]);
  });

  it("la última parte absorbe el redondeo", () => {
    // 3 partes iguales de 10.000 sobre 10.000: 3333,33 cada una.
    const montos = repartirPrecioDelPaquete(10000, [10000, 10000, 10000]);
    expect(montos).toEqual([3333, 3333, 3334]);
  });

  it("con una sola parte le toca todo", () => {
    expect(repartirPrecioDelPaquete(250000, [80000])).toEqual([250000]);
  });

  it("una parte de precio 0 no se lleva nada, y el resto igual suma el total", () => {
    // Sin el caso especial, 0/total = 0 y la última parte absorbe todo el resto.
    expect(repartirPrecioDelPaquete(100000, [0, 100000])).toEqual([0, 100000]);
  });

  it("si TODAS las partes valen 0, reparte en partes iguales", () => {
    // Dividir por cero daría NaN y las filas quedarían sin precio: al cancelar
    // la clienta no cobraría nada de vuelta.
    expect(repartirPrecioDelPaquete(9000, [0, 0, 0])).toEqual([3000, 3000, 3000]);
  });

  it("INVARIANTE: la suma es siempre exactamente el precio del paquete", () => {
    const casos: [number, number[]][] = [
      [250000, [80000, 25000, 65000]],
      [10000, [10000, 10000, 10000]],
      [1, [3, 5, 7, 11]],
      [999999, [1, 1, 1, 1, 1, 1, 1]],
      [123457, [33333, 66667, 1]],
      [50000, [0, 0, 1]],
    ];
    for (const [precio, partes] of casos) {
      const montos = repartirPrecioDelPaquete(precio, partes);
      expect(montos).toHaveLength(partes.length);
      expect(montos.reduce((a, b) => a + b, 0)).toBe(precio);
    }
  });

  it("sin partes devuelve una lista vacía, no explota", () => {
    expect(repartirPrecioDelPaquete(250000, [])).toEqual([]);
  });
});
