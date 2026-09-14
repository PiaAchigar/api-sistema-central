import { describe, expect, it } from "vitest";
import { type ServicioDisponible, elegirServicio, opcionesDeCompra } from "./eleccion-de-servicio";

function ses(over: Partial<ServicioDisponible> = {}): ServicioDisponible {
  return {
    purchaseServiceId: "s1",
    purchaseId: "c1",
    descripcion: "Lifting de pestañas — pack de 3",
    repeticion: 1,
    venceEl: null,
    ...over,
  };
}

describe("elegirServicio", () => {
  it("sin nada a favor no elige nada, y no es un error", () => {
    // La mayoría de los turnos se cobran en el momento.
    expect(elegirServicio([])).toEqual({ tipo: "ninguna" });
  });

  it("con una sola compra la descuenta sola", () => {
    const r = elegirServicio([ses()]);
    expect(r.tipo).toBe("automatica");
    if (r.tipo === "automatica") expect(r.purchaseServiceId).toBe("s1");
  });

  it("VARIOS servicios de la MISMA compra siguen siendo una sola opción", () => {
    // Son intercambiables: elegir entre el 2 y el 3 del mismo pack no es una
    // decisión, es un click al pedo.
    const r = elegirServicio([
      ses({ purchaseServiceId: "s1", repeticion: 1 }),
      ses({ purchaseServiceId: "s2", repeticion: 2 }),
      ses({ purchaseServiceId: "s3", repeticion: 3 }),
    ]);
    expect(r.tipo).toBe("automatica");
    if (r.tipo === "automatica") {
      expect(r.purchaseServiceId).toBe("s1");
      expect(r.opcion.disponibles).toBe(3);
    }
  });

  it("descuenta el de número más bajo, aunque venga desordenado", () => {
    const r = elegirServicio([
      ses({ purchaseServiceId: "s3", repeticion: 3 }),
      ses({ purchaseServiceId: "s1", repeticion: 1 }),
      ses({ purchaseServiceId: "s2", repeticion: 2 }),
    ]);
    if (r.tipo === "automatica") expect(r.purchaseServiceId).toBe("s1");
  });

  it("con dos compras distintas, elige Laura", () => {
    const r = elegirServicio([
      ses({ purchaseId: "c1", purchaseServiceId: "s1", descripcion: "Lifting — pack de 3" }),
      ses({ purchaseId: "c2", purchaseServiceId: "s9", descripcion: "Combo Facial" }),
    ]);
    expect(r.tipo).toBe("elige_laura");
    if (r.tipo === "elige_laura") expect(r.opciones).toHaveLength(2);
  });
});

describe("opcionesDeCompra — el orden", () => {
  const enero = new Date("2027-01-15T00:00:00Z");
  const marzo = new Date("2027-03-15T00:00:00Z");

  it("lo que vence antes va primero: es lo que está por perderse", () => {
    const opciones = opcionesDeCompra([
      ses({ purchaseId: "c2", purchaseServiceId: "s2", descripcion: "Combo", venceEl: marzo }),
      ses({ purchaseId: "c1", purchaseServiceId: "s1", descripcion: "Pack", venceEl: enero }),
    ]);
    expect(opciones.map((o) => o.purchaseId)).toEqual(["c1", "c2"]);
  });

  it("lo que no vence nunca va último: no corre riesgo", () => {
    const opciones = opcionesDeCompra([
      ses({ purchaseId: "c1", purchaseServiceId: "s1", descripcion: "Sin vencimiento", venceEl: null }),
      ses({ purchaseId: "c2", purchaseServiceId: "s2", descripcion: "Vence", venceEl: marzo }),
    ]);
    expect(opciones.map((o) => o.purchaseId)).toEqual(["c2", "c1"]);
  });

  it("a igual vencimiento ordena por nombre, así la lista no baila", () => {
    const opciones = opcionesDeCompra([
      ses({ purchaseId: "c2", purchaseServiceId: "s2", descripcion: "Zeta", venceEl: enero }),
      ses({ purchaseId: "c1", purchaseServiceId: "s1", descripcion: "Alfa", venceEl: enero }),
    ]);
    expect(opciones.map((o) => o.descripcion)).toEqual(["Alfa", "Zeta"]);
  });

  it("cuenta bien las disponibles de cada compra", () => {
    const opciones = opcionesDeCompra([
      ses({ purchaseId: "c1", purchaseServiceId: "s1", repeticion: 1 }),
      ses({ purchaseId: "c1", purchaseServiceId: "s2", repeticion: 2 }),
      ses({ purchaseId: "c2", purchaseServiceId: "s9", repeticion: 1, descripcion: "Otra" }),
    ]);
    expect(opciones.find((o) => o.purchaseId === "c1")?.disponibles).toBe(2);
    expect(opciones.find((o) => o.purchaseId === "c2")?.disponibles).toBe(1);
  });
});
