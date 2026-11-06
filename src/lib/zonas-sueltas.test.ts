import { describe, expect, it } from "vitest";
import { nombreDeZonasSueltas } from "./zonas-sueltas";

describe("nombreDeZonasSueltas", () => {
  it("nombra las zonas tal como se eligieron", () => {
    expect(nombreDeZonasSueltas(["Axila", "Bozo"])).toBe("Zonas: Axila + Bozo");
  });

  it("una sola zona se dice en singular", () => {
    expect(nombreDeZonasSueltas(["Axila"])).toBe("Zona: Axila");
  });

  it("con muchas zonas no se pasa de largo y dice cuántas faltan", () => {
    const nombre = nombreDeZonasSueltas(Array.from({ length: 24 }, (_, i) => `Zona larga número ${i + 1}`));
    expect(nombre.length).toBeLessThanOrEqual(150);
    expect(nombre).toMatch(/y \d+ más$/);
  });
});
