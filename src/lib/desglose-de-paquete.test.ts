import { describe, expect, it } from "vitest";
import { lineasDelPaquete, type ParteDelPaquete } from "./desglose-de-paquete";

const servicio = (id: string, precio: number, cantidad = 1): ParteDelPaquete => ({
  tipo: "servicio", id, cantidad, precioDeLista: precio, lineas: [{ serviceId: id, sessionsIncluded: 1, price: precio }],
});

describe("lineasDelPaquete", () => {
  it("un servicio con cantidad 3 da 3 líneas", () => {
    // "3 limpiezas de cutis" es UNA fila de promotion_target con cantidad 3,
    // pero son 3 turnos que la clienta va a querer agendar por separado.
    expect(lineasDelPaquete([servicio("s1", 20000, 3)])).toHaveLength(3);
  });

  it("un combo aporta TODAS sus líneas, multiplicadas por la cantidad", () => {
    const combo: ParteDelPaquete = {
      tipo: "combo", id: "c1", cantidad: 2, precioDeLista: 80000,
      lineas: [
        { serviceId: "s1", sessionsIncluded: 1, price: 50000 },
        { serviceId: "s2", sessionsIncluded: 1, price: 30000 },
      ],
    };
    const lineas = lineasDelPaquete([combo]);
    expect(lineas).toHaveLength(4);
    expect(lineas.map((l) => l.serviceId)).toEqual(["s1", "s2", "s1", "s2"]);
  });

  it("un pack de depilación da líneas con su identidad, no con service_id", () => {
    const pack: ParteDelPaquete = {
      tipo: "depilacion", id: "p1", cantidad: 1, precioDeLista: 65000,
      lineas: [{ serviceId: null, depilationComboId: "p1", sessionsIncluded: 1, price: 65000 }],
    };
    expect(lineasDelPaquete([pack])).toEqual([
      { serviceId: null, depilationComboId: "p1", trainingId: null, sessionsIncluded: 1, price: 65000 },
    ]);
  });

  it("mantiene el orden en que Laura armó el paquete", () => {
    const lineas = lineasDelPaquete([servicio("a", 100), servicio("b", 200), servicio("c", 300)]);
    expect(lineas.map((l) => l.serviceId)).toEqual(["a", "b", "c"]);
  });

  it("sin partes no da líneas", () => {
    expect(lineasDelPaquete([])).toEqual([]);
  });

  it("un renglón de combo con sessionsIncluded 2 da DOS líneas, no una", () => {
    // Si se propagara `sessionsIncluded`, `filasDeServicioComprado` expandiría
    // después y habría 1 monto repartido para 2 filas: las partes sumarían más
    // que el precio del paquete.
    const combo: ParteDelPaquete = {
      tipo: "combo", id: "c1", cantidad: 1, precioDeLista: 100000,
      lineas: [{ serviceId: "s1", sessionsIncluded: 2, price: 50000 }],
    };
    const lineas = lineasDelPaquete([combo]);
    expect(lineas).toHaveLength(2);
    expect(lineas.every((l) => l.sessionsIncluded === 1)).toBe(true);
  });
});
