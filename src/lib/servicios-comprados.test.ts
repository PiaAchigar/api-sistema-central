import { describe, expect, it } from "vitest";
import { filasDeServicioComprado } from "./servicios-comprados";

const BABY = "svc-baby-botox";
const DEPI = "svc-depilacion-facial";

describe("filasDeServicioComprado", () => {
  it("un combo de 2 servicios vendido suelto da 2 filas, las dos de la vuelta 1", () => {
    const filas = filasDeServicioComprado(1, [
      { serviceId: BABY, sessionsIncluded: 1 },
      { serviceId: DEPI, sessionsIncluded: 1 },
    ]);
    expect(filas).toEqual([
      { serviceId: BABY, repeticion: 1, orden: 1 },
      { serviceId: DEPI, repeticion: 1, orden: 1 },
    ]);
  });

  it("un pack de 3 de ese combo da 6 filas: 3 vueltas por 2 servicios", () => {
    const filas = filasDeServicioComprado(3, [
      { serviceId: BABY, sessionsIncluded: 1 },
      { serviceId: DEPI, sessionsIncluded: 1 },
    ]);
    expect(filas).toHaveLength(6);
    expect(filas.filter((f) => f.serviceId === BABY)).toHaveLength(3);
    expect(filas.map((f) => f.repeticion)).toEqual([1, 1, 2, 2, 3, 3]);
  });

  it("un servicio suelto con 3 sesiones da 3 filas del mismo servicio", () => {
    const filas = filasDeServicioComprado(3, [{ serviceId: BABY, sessionsIncluded: 1 }]);
    expect(filas).toEqual([
      { serviceId: BABY, repeticion: 1, orden: 1 },
      { serviceId: BABY, repeticion: 2, orden: 1 },
      { serviceId: BABY, repeticion: 3, orden: 1 },
    ]);
  });

  it("sin líneas —depilación, capacitación— da una fila por vuelta con serviceId null", () => {
    expect(filasDeServicioComprado(2, [])).toEqual([
      { serviceId: null, repeticion: 1, orden: 1 },
      { serviceId: null, repeticion: 2, orden: 1 },
    ]);
  });

  it("un renglón con sessions_included 3 da 3 filas de ese servicio, con orden 1, 2 y 3", () => {
    // La clienta pagó 3 Baby Botox: tiene que poder agendar 3, no 1.
    const filas = filasDeServicioComprado(1, [{ serviceId: BABY, sessionsIncluded: 3 }]);
    expect(filas).toEqual([
      { serviceId: BABY, repeticion: 1, orden: 1 },
      { serviceId: BABY, repeticion: 1, orden: 2 },
      { serviceId: BABY, repeticion: 1, orden: 3 },
    ]);
  });

  it("rechaza 0 repeticiones: una compra sin nada que agendar no existe", () => {
    expect(() => filasDeServicioComprado(0, [])).toThrow(/al menos una/i);
  });
});
