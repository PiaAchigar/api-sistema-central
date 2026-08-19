import { describe, expect, it } from "vitest";
import { armarEstado } from "./embeddings-status.repo";

describe("armarEstado", () => {
  // Postgres devuelve los count() como string: si no los convertimos, el front
  // compara "0" > 0 y nunca muestra el cartel.
  const filas = [
    { source: "service", total: "228", pendientes: "5" },
    { source: "activity", total: "13", pendientes: "0" },
    { source: "training", total: "6", pendientes: "1" },
  ];

  it("convierte los conteos de string a number", () => {
    const e = armarEstado(filas, true);
    expect(e.total).toBe(247);
    expect(typeof e.total).toBe("number");
    expect(e.pendientes).toBe(6);
    expect(e.indexados).toBe(241);
  });

  it("desglosa por tipo", () => {
    const e = armarEstado(filas, true);
    expect(e.por_tipo.service).toEqual({ total: 228, pendientes: 5 });
    expect(e.por_tipo.activity).toEqual({ total: 13, pendientes: 0 });
    expect(e.por_tipo.training).toEqual({ total: 6, pendientes: 1 });
  });

  it("refleja si hay credencial activa", () => {
    expect(armarEstado(filas, false).credencial_activa).toBe(false);
    expect(armarEstado(filas, true).credencial_activa).toBe(true);
  });

  it("devuelve ceros para un tipo que no vino en la consulta", () => {
    const e = armarEstado([{ source: "service", total: "10", pendientes: "0" }], true);
    expect(e.por_tipo.training).toEqual({ total: 0, pendientes: 0 });
    expect(e.total).toBe(10);
  });

  it("no explota con la base vacía", () => {
    const e = armarEstado([], true);
    expect(e.total).toBe(0);
    expect(e.pendientes).toBe(0);
    expect(e.indexados).toBe(0);
  });
});
