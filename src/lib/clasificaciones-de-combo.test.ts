import { describe, expect, it } from "vitest";
import { agruparClasificaciones } from "./clasificaciones-de-combo";

describe("agruparClasificaciones", () => {
  it("un combo con servicios de dos clasificaciones queda en las dos", () => {
    const mapa = agruparClasificaciones([
      { comboId: "c1", clasificacionId: "k1", clasificacionName: "Belleza" },
      { comboId: "c1", clasificacionId: "k2", clasificacionName: "Tratamientos Médicos" },
    ]);
    expect(mapa.get("c1")).toEqual([
      { id: "k1", name: "Belleza" },
      { id: "k2", name: "Tratamientos Médicos" },
    ]);
  });

  it("dos servicios de la MISMA clasificación no la repiten", () => {
    const mapa = agruparClasificaciones([
      { comboId: "c1", clasificacionId: "k1", clasificacionName: "Belleza" },
      { comboId: "c1", clasificacionId: "k1", clasificacionName: "Belleza" },
    ]);
    expect(mapa.get("c1")).toEqual([{ id: "k1", name: "Belleza" }]);
  });

  it("separa por combo", () => {
    const mapa = agruparClasificaciones([
      { comboId: "c1", clasificacionId: "k1", clasificacionName: "Belleza" },
      { comboId: "c2", clasificacionId: "k2", clasificacionName: "Masajes" },
    ]);
    expect(mapa.get("c1")).toEqual([{ id: "k1", name: "Belleza" }]);
    expect(mapa.get("c2")).toEqual([{ id: "k2", name: "Masajes" }]);
  });

  it("ordena alfabéticamente en español: el orden de la consulta no se respeta solo", () => {
    const mapa = agruparClasificaciones([
      { comboId: "c1", clasificacionId: "k2", clasificacionName: "Ñandú" },
      { comboId: "c1", clasificacionId: "k1", clasificacionName: "Aparatología" },
    ]);
    expect(mapa.get("c1")?.map((c) => c.name)).toEqual(["Aparatología", "Ñandú"]);
  });

  it("sin filas devuelve un mapa vacío, no explota", () => {
    expect(agruparClasificaciones([]).size).toBe(0);
  });

  it("descarta filas sin nombre: una clasificación anónima no se puede mostrar", () => {
    const mapa = agruparClasificaciones([
      { comboId: "c1", clasificacionId: "k1", clasificacionName: null },
    ]);
    expect(mapa.has("c1")).toBe(false);
  });
});
