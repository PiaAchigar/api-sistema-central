import { describe, expect, it } from "vitest";
import {
  celdasIguales,
  normalizarServicio,
  type FilaServicioPlanilla,
} from "./planilla-servicios";

function filaServicio(o: Partial<FilaServicioPlanilla> = {}): FilaServicioPlanilla {
  return {
    fila: 2,
    id: null,
    nombre: "ZZ_QA_PLANILLA_Servicio",
    codigo: null,
    descripcion: null,
    precioLista: 45000,
    precioEfectivo: 40000,
    duracion: 45,
    unidad: null,
    requiereOperadora: "Sí",
    requiereMaquina: "No",
    maquina: null,
    visibleWeb: "Sí",
    destacado: "No",
    ordenWeb: null,
    beneficios: null,
    contraindicaciones: null,
    instrucciones: null,
    ...o,
  };
}

describe("celdasIguales", () => {
  it("tolera lo que Excel/Sheets reformatean", () => {
    expect(celdasIguales(45000, "45000")).toBe(true);
    expect(celdasIguales(45000, "45000.0")).toBe(true);
    expect(celdasIguales("Si", "Sí")).toBe(true);
    expect(celdasIguales("SÍ", "sí")).toBe(true);
    expect(celdasIguales(" x ", "x")).toBe(true);
    expect(celdasIguales("", null)).toBe(true);
  });
  it("detecta diferencias reales", () => {
    expect(celdasIguales(45000, 45001)).toBe(false);
    expect(celdasIguales("Sí", "No")).toBe(false);
    expect(celdasIguales("a", null)).toBe(false);
  });
});

describe("normalizarServicio", () => {
  it("fila válida completa: sin errores y valores tipados", () => {
    const r = normalizarServicio(
      filaServicio({
        precioLista: "45000",
        requiereOperadora: "Sí",
        requiereMaquina: "No",
        ordenWeb: "3",
        descripcion: " hola ",
      }),
    );
    expect(r.errores).toEqual([]);
    expect(r.valor.unitPriceList).toBe(45000);
    expect(r.valor.requiresOperator).toBe(true);
    expect(r.valor.requiresMachine).toBe(false);
    expect(r.valor.webSortOrder).toBe(3);
    expect(r.valor.description).toBe("hola");
    expect(r.valor.maquina).toBeNull();
  });

  it("precio no numérico → error que nombra la columna", () => {
    const r = normalizarServicio(filaServicio({ fila: 7, precioLista: "abc" }));
    expect(r.errores).toHaveLength(1);
    expect(r.errores[0]).toMatchObject({ pestana: "Servicios", fila: 7 });
    expect(r.errores[0]?.mensaje).toContain("Precio lista");
  });

  it("precio negativo → error", () => {
    expect(normalizarServicio(filaServicio({ precioLista: -1 })).errores[0]?.mensaje).toContain("Precio lista");
  });

  it("duración con decimales → error (entero)", () => {
    expect(normalizarServicio(filaServicio({ duracion: 45.5 })).errores[0]?.mensaje).toContain("Duración");
  });

  it("Sí/No inválido → error", () => {
    expect(normalizarServicio(filaServicio({ requiereOperadora: "tal vez" })).errores[0]?.mensaje).toContain("Requiere operadora");
  });

  it("textos demasiado largos → error", () => {
    expect(normalizarServicio(filaServicio({ descripcion: "x".repeat(2001) })).errores[0]?.mensaje).toContain("Descripción");
    expect(normalizarServicio(filaServicio({ nombre: "x".repeat(256) })).errores[0]?.mensaje).toContain("Nombre");
    expect(normalizarServicio(filaServicio({ nombre: "x".repeat(255) })).errores).toEqual([]);
  });

  it("celdas vacías quedan en null sin error", () => {
    const r = normalizarServicio(filaServicio({ precioEfectivo: "", duracion: "  " }));
    expect(r.errores).toEqual([]);
    expect(r.valor.unitPriceCash).toBeNull();
    expect(r.valor.estimatedDurationMinutes).toBeNull();
  });
});
