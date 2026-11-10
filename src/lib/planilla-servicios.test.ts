import { describe, expect, it } from "vitest";
import {
  celdasIguales,
  normalizarServicio,
  planificarPlanilla,
  type Catalogo,
  type ContenidoPlanilla,
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

// ───────────────────────── planificarPlanilla ─────────────────────────

const ID_A = "id-a";
const ID_B = "id-b";

function contenido(o: Partial<ContenidoPlanilla> = {}): ContenidoPlanilla {
  return { servicios: [], acuerdos: [], insumos: [], categorias: [], ...o };
}
function catalogo(o: Partial<Catalogo> = {}): Catalogo {
  return {
    maquinas: new Map([["Láser", "m1"]]),
    proveedoras: new Map([["Ana", "p-ana"], ["Dup", null]]),
    insumos: new Map([["Gel", "i-gel"]]),
    categorias: new Map([["Madre › Hija", "c1"]]),
    idsDelArea: new Set([ID_A, ID_B]),
    ...o,
  };
}
const A = (o: Partial<FilaServicioPlanilla> = {}) => filaServicio({ id: ID_A, nombre: "ZZ_QA_PLANILLA_A", ...o });
const acu = (fila: number, servicio: string, proveedora: string, tipo: string | null, tarifa: number | string | null) => ({
  fila, servicio, proveedora, tipoDePago: tipo, tarifa,
});
/** Las tres versiones iguales, con un servicio A existente. */
function trio(o: Partial<FilaServicioPlanilla> = {}) {
  const c = () => contenido({ servicios: [A(o)] });
  return { original: c(), editada: c(), actual: c() };
}
const plan = (t: { original: ContenidoPlanilla; editada: ContenidoPlanilla; actual: ContenidoPlanilla }, cat = catalogo()) =>
  planificarPlanilla({ ...t, catalogo: cat });

describe("planificarPlanilla — servicios existentes", () => {
  it("aplica sólo lo que Laura tocó", () => {
    const t = trio();
    t.actual.servicios[0] = A({ precioLista: 99999 }); // alguien lo cambió desde el modal
    const r = plan(t);
    expect(r.vista.errores).toEqual([]);
    expect(r.plan.actualizar).toEqual([]);
  });

  it("lo que Laura tocó va al patch, con precioAntes tomado de actual", () => {
    const t = trio();
    t.editada.servicios[0] = A({ precioLista: 50000 });
    const r = plan(t);
    expect(r.vista.errores).toEqual([]);
    expect(r.plan.actualizar).toEqual([
      { id: ID_A, fila: 2, patch: { unitPriceList: 50000 }, precioAntes: { lista: 45000, efectivo: 40000 } },
    ]);
    expect(r.vista.servicios[0]?.cambios).toEqual([{ campo: "Precio lista", antes: "45000", despues: "50000" }]);
  });

  it("conflicto si Laura y el sistema cambiaron la misma celda", () => {
    const t = trio();
    t.editada.servicios[0] = A({ precioLista: 50000 });
    t.actual.servicios[0] = A({ precioLista: 47000 });
    const r = plan(t);
    expect(r.vista.errores).toHaveLength(1);
    expect(r.vista.errores[0]?.mensaje).toContain("cambió en el sistema");
    expect(r.vista.errores[0]?.mensaje).toContain("Precio lista");
  });

  it("borrar una fila no borra nada", () => {
    const original = contenido({
      servicios: [A()],
      acuerdos: [acu(2, "ZZ_QA_PLANILLA_A", "Ana", "Por hora", 100)],
      insumos: [{ fila: 2, servicio: "ZZ_QA_PLANILLA_A", insumo: "Gel", cantidad: 2 }],
      categorias: [{ fila: 2, servicio: "ZZ_QA_PLANILLA_A", categoria: "Madre › Hija" }],
    });
    const r = plan({ original, editada: contenido(), actual: original });
    expect(r.vista.errores).toEqual([]);
    expect(r.plan).toEqual({ crear: [], actualizar: [], acuerdos: [], insumos: [], categorias: [] });
  });

  it("vaciar precio efectivo de un existente es error", () => {
    const t = trio();
    t.editada.servicios[0] = A({ precioEfectivo: "" });
    const r = plan(t);
    expect(r.vista.errores[0]?.mensaje).toContain("Precio efectivo");
    expect(r.plan.actualizar).toEqual([]);
  });

  it("vaciar beneficios de un existente lo deja en null", () => {
    const t = trio({ beneficios: "Algo" });
    t.editada.servicios[0] = A({ beneficios: "" });
    const r = plan(t);
    expect(r.vista.errores).toEqual([]);
    expect(r.plan.actualizar[0]?.patch).toEqual({ benefits: null });
  });

  it("vaciar orden web es válido", () => {
    const t = trio({ ordenWeb: 3 });
    t.editada.servicios[0] = A({ ordenWeb: null });
    const r = plan(t);
    expect(r.vista.errores).toEqual([]);
    expect(r.plan.actualizar[0]?.patch).toEqual({ webSortOrder: null });
  });

  it("45000 vs '45000' no es cambio, 'Si' vs 'Sí' tampoco", () => {
    const t = trio();
    t.editada.servicios[0] = A({ precioLista: "45000", requiereOperadora: "Si" });
    const r = plan(t);
    expect(r.vista.errores).toEqual([]);
    expect(r.plan.actualizar).toEqual([]);
  });

  it("id de otra área es error", () => {
    const t = trio();
    t.editada.servicios[0] = A();
    const r = plan(t, catalogo({ idsDelArea: new Set() }));
    expect(r.vista.errores[0]?.mensaje).toContain("id que no es de esta área");
  });

  it("id que no estaba en la planilla original es error", () => {
    const t = trio();
    t.editada.servicios.push(A({ id: "ajeno", nombre: "ZZ_QA_PLANILLA_X", fila: 3 }));
    const r = plan(t, catalogo({ idsDelArea: new Set([ID_A, "ajeno"]) }));
    expect(r.vista.errores[0]).toMatchObject({ pestana: "Servicios", fila: 3 });
  });

  it("nombre de servicio repetido es error", () => {
    const t = trio();
    t.editada.servicios.push(filaServicio({ fila: 3, nombre: "zz_qa_planilla_a " }));
    const r = plan(t);
    expect(r.vista.errores.some((e) => e.mensaje.includes("repetido"))).toBe(true);
  });
});

describe("planificarPlanilla — servicios nuevos", () => {
  const nueva = () => filaServicio({ fila: 5, nombre: "ZZ_QA_PLANILLA_Nuevo" });
  const cat = { fila: 2, servicio: "ZZ_QA_PLANILLA_Nuevo", categoria: "Madre › Hija" };

  it("sin categoría es error", () => {
    const r = plan({ original: contenido(), editada: contenido({ servicios: [nueva()] }), actual: contenido() });
    expect(r.vista.errores[0]?.mensaje).toContain("al menos una categoría web");
  });

  it("con categoría se crea, con defaults de Sí/No", () => {
    const r = plan({
      original: contenido(),
      editada: contenido({
        servicios: [filaServicio({ fila: 5, nombre: "ZZ_QA_PLANILLA_Nuevo", requiereOperadora: null, visibleWeb: null })],
        categorias: [cat],
      }),
      actual: contenido(),
    });
    expect(r.vista.errores).toEqual([]);
    expect(r.plan.crear).toHaveLength(1);
    expect(r.plan.crear[0]?.datos).toMatchObject({ requiresOperator: false, isVisible: true, isFeatured: false });
    expect(r.plan.categorias).toEqual([{ servicio: { nuevaFila: 5 }, categoryId: "c1" }]);
    expect(r.vista.resumen.serviciosNuevos).toBe(1);
  });

  it("sin precio efectivo es error", () => {
    const r = plan({
      original: contenido(),
      editada: contenido({ servicios: [filaServicio({ fila: 5, nombre: "ZZ_QA_PLANILLA_Nuevo", precioEfectivo: null })], categorias: [cat] }),
      actual: contenido(),
    });
    expect(r.vista.errores[0]?.mensaje).toContain("Precio efectivo");
  });

  it("máquina inexistente es error", () => {
    const r = plan({
      original: contenido(),
      editada: contenido({ servicios: [filaServicio({ fila: 5, nombre: "ZZ_QA_PLANILLA_Nuevo", maquina: "Nada" })], categorias: [cat] }),
      actual: contenido(),
    });
    expect(r.vista.errores.some((e) => e.mensaje.includes("máquina"))).toBe(true);
  });
});

describe("planificarPlanilla — relaciones", () => {
  const base = () => ({
    original: contenido({ servicios: [A()], acuerdos: [acu(2, "ZZ_QA_PLANILLA_A", "Ana", "Por hora", 100)] }),
    editada: contenido({ servicios: [A()], acuerdos: [acu(2, "ZZ_QA_PLANILLA_A", "Ana", "Por hora", 100)] }),
    actual: contenido({ servicios: [A()], acuerdos: [acu(2, "ZZ_QA_PLANILLA_A", "Ana", "Por hora", 100)] }),
  });

  it("renombrar arrastra las relaciones", () => {
    const t = base();
    t.editada.servicios[0] = A({ nombre: "ZZ_QA_PLANILLA_Renombrado" });
    t.editada.acuerdos = [acu(2, "ZZ_QA_PLANILLA_Renombrado", "Ana", "Por hora", 100)];
    t.editada.insumos = [{ fila: 2, servicio: "ZZ_QA_PLANILLA_Renombrado", insumo: "Gel", cantidad: 1 }];
    const r = plan(t);
    expect(r.vista.errores).toEqual([]);
    expect(r.plan.actualizar[0]?.patch).toEqual({ name: "ZZ_QA_PLANILLA_Renombrado" });
    expect(r.plan.acuerdos).toEqual([]); // el acuerdo no cambió
    expect(r.plan.insumos).toEqual([{ servicio: { id: ID_A }, productId: "i-gel", quantity: 1 }]);
  });

  it("relación con el nombre viejo da error", () => {
    const t = base();
    t.editada.servicios[0] = A({ nombre: "ZZ_QA_PLANILLA_Renombrado" });
    const r = plan(t);
    expect(r.vista.errores).toHaveLength(1);
    expect(r.vista.errores[0]).toMatchObject({ pestana: "Proveedoras", fila: 2 });
    expect(r.vista.errores[0]?.mensaje).toContain("pestaña Servicios");
  });

  it("cambio de tarifa cierra y crea", () => {
    const t = base();
    t.editada.acuerdos = [acu(2, "ZZ_QA_PLANILLA_A", "Ana", "Por hora", 120)];
    const r = plan(t);
    expect(r.vista.errores).toEqual([]);
    expect(r.plan.acuerdos).toEqual([
      { servicio: { id: ID_A }, proveedoraId: "p-ana", paymentType: "per_hour", rate: 120, cerrarVigente: true },
    ]);
    expect(r.vista.acuerdos[0]).toMatchObject({ tipo: "cambia", antes: "Por hora, 100", despues: "Por hora, 120" });
  });

  it("acuerdo nuevo (no está en original ni en actual) es alta sin cerrar nada", () => {
    const t = base();
    t.original.acuerdos = [];
    t.actual.acuerdos = [];
    const r = plan(t);
    expect(r.plan.acuerdos[0]?.cerrarVigente).toBe(false);
  });

  it("acuerdo que cambió en el sistema y Laura también lo tocó es conflicto", () => {
    const t = base();
    t.editada.acuerdos = [acu(2, "ZZ_QA_PLANILLA_A", "Ana", "Por hora", 120)];
    t.actual.acuerdos = [acu(2, "ZZ_QA_PLANILLA_A", "Ana", "Por hora", 150)];
    expect(plan(t).vista.errores[0]?.mensaje).toContain("cambió en el sistema");
  });

  it("acuerdo que el sistema cambió y Laura no tocó queda como está", () => {
    const t = base();
    t.actual.acuerdos = [acu(2, "ZZ_QA_PLANILLA_A", "Ana", "Por hora", 150)];
    const r = plan(t);
    expect(r.vista.errores).toEqual([]);
    expect(r.plan.acuerdos).toEqual([]);
  });

  it("alta de un par que ya existe en el sistema con otros valores es conflicto", () => {
    const t = base();
    t.original.acuerdos = [];
    t.actual.acuerdos = [acu(2, "ZZ_QA_PLANILLA_A", "Ana", "Por hora", 150)];
    expect(plan(t).vista.errores[0]?.mensaje).toContain("se cargó en el sistema");
  });

  it("tarifa 0 es error", () => {
    const t = base();
    t.editada.acuerdos = [acu(2, "ZZ_QA_PLANILLA_A", "Ana", "Por hora", 0)];
    expect(plan(t).vista.errores[0]?.mensaje).toContain("La tarifa no puede ser 0");
  });

  it("acuerdo sin tipo o sin tarifa es error", () => {
    const t = base();
    t.editada.acuerdos = [acu(2, "ZZ_QA_PLANILLA_A", "Ana", null, 100)];
    expect(plan(t).vista.errores[0]?.mensaje).toContain("cómo cobra y cuánto cobra");
  });

  it("proveedora inexistente o ambigua es error", () => {
    const t = base();
    t.editada.acuerdos = [acu(2, "ZZ_QA_PLANILLA_A", "Nadie", "Por hora", 100)];
    expect(plan(t).vista.errores[0]?.mensaje).toContain("no existe");
    t.editada.acuerdos = [acu(2, "ZZ_QA_PLANILLA_A", "Dup", "Por hora", 100)];
    expect(plan(t).vista.errores[0]?.mensaje).toContain("más de una");
  });

  it("proveedora repetida para el mismo servicio es error", () => {
    const t = base();
    t.editada.acuerdos = [
      acu(2, "ZZ_QA_PLANILLA_A", "Ana", "Por hora", 100),
      acu(3, "ZZ_QA_PLANILLA_A", "ana", "Por hora", 100),
    ];
    const r = plan(t);
    expect(r.vista.errores).toHaveLength(1);
    expect(r.vista.errores[0]).toMatchObject({ pestana: "Proveedoras", fila: 3 });
  });

  it("insumo con cantidad <= 0 o no numérica es error; cantidad nueva actualiza", () => {
    const t = base();
    t.original.insumos = [{ fila: 2, servicio: "ZZ_QA_PLANILLA_A", insumo: "Gel", cantidad: 2 }];
    t.actual.insumos = [{ fila: 2, servicio: "ZZ_QA_PLANILLA_A", insumo: "Gel", cantidad: 2 }];
    t.editada.insumos = [{ fila: 2, servicio: "ZZ_QA_PLANILLA_A", insumo: "Gel", cantidad: 0 }];
    expect(plan(t).vista.errores).toHaveLength(1);
    t.editada.insumos = [{ fila: 2, servicio: "ZZ_QA_PLANILLA_A", insumo: "Gel", cantidad: "mucho" }];
    expect(plan(t).vista.errores).toHaveLength(1);
    t.editada.insumos = [{ fila: 2, servicio: "ZZ_QA_PLANILLA_A", insumo: "Gel", cantidad: 3 }];
    const r = plan(t);
    expect(r.plan.insumos).toEqual([{ servicio: { id: ID_A }, productId: "i-gel", quantity: 3 }]);
    expect(r.vista.insumos[0]).toMatchObject({ tipo: "cambia", antes: 2, despues: 3 });
  });

  it("categorías: sólo altas; el par existente no se toca", () => {
    const t = base();
    t.original.categorias = [{ fila: 2, servicio: "ZZ_QA_PLANILLA_A", categoria: "Madre › Hija" }];
    t.actual.categorias = t.original.categorias;
    t.editada.categorias = [{ fila: 2, servicio: "ZZ_QA_PLANILLA_A", categoria: "Madre › Hija" }];
    expect(plan(t).plan.categorias).toEqual([]);
    t.original.categorias = [];
    t.actual.categorias = [];
    expect(plan(t).plan.categorias).toEqual([{ servicio: { id: ID_A }, categoryId: "c1" }]);
  });

  it("categoría inexistente es error con la fila", () => {
    const t = base();
    t.editada.categorias = [{ fila: 4, servicio: "ZZ_QA_PLANILLA_A", categoria: "Otra" }];
    expect(plan(t).vista.errores[0]).toMatchObject({ pestana: "Categorías web", fila: 4 });
  });
});
