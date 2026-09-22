import { describe, expect, it } from "vitest";
import {
  comboDelQueSalenLosServicios,
  filasDeServicioComprado,
  ordenDeServiciosComprados,
  type ServicioOrdenable,
} from "./servicios-comprados";

const BABY = "svc-baby-botox";
const DEPI = "svc-depilacion-facial";

describe("filasDeServicioComprado", () => {
  it("un combo de 2 servicios vendido suelto da 2 filas, las dos de la vuelta 1", () => {
    const filas = filasDeServicioComprado(1, [
      { serviceId: BABY, sessionsIncluded: 1, price: 249000 },
      { serviceId: DEPI, sessionsIncluded: 1, price: 17500 },
    ]);
    expect(filas).toEqual([
      { serviceId: BABY, depilationComboId: null, trainingId: null, repeticion: 1, orden: 1, price: 249000 },
      { serviceId: DEPI, depilationComboId: null, trainingId: null, repeticion: 1, orden: 1, price: 17500 },
    ]);
  });

  it("cada fila se lleva el precio de SU servicio, no un promedio", () => {
    // Es lo que hace que al cancelar la clienta reciba lo que vale el servicio
    // que no usó. Sin esto, un combo de $249.000 + $17.500 se repartía por la
    // mitad y Laura regalaba $92.000 (1.52.0).
    const filas = filasDeServicioComprado(2, [
      { serviceId: BABY, sessionsIncluded: 1, price: 249000 },
      { serviceId: DEPI, sessionsIncluded: 1, price: 17500 },
    ]);
    expect(filas.map((f) => f.price)).toEqual([249000, 17500, 249000, 17500]);
  });

  it("un pack de 3 de ese combo da 6 filas: 3 vueltas por 2 servicios", () => {
    const filas = filasDeServicioComprado(3, [
      { serviceId: BABY, sessionsIncluded: 1, price: 249000 },
      { serviceId: DEPI, sessionsIncluded: 1, price: 17500 },
    ]);
    expect(filas).toHaveLength(6);
    expect(filas.filter((f) => f.serviceId === BABY)).toHaveLength(3);
    expect(filas.map((f) => f.repeticion)).toEqual([1, 1, 2, 2, 3, 3]);
  });

  it("un servicio suelto con 3 sesiones da 3 filas del mismo servicio", () => {
    const filas = filasDeServicioComprado(3, [{ serviceId: BABY, sessionsIncluded: 1, price: 249000 }]);
    expect(filas).toEqual([
      { serviceId: BABY, depilationComboId: null, trainingId: null, repeticion: 1, orden: 1, price: 249000 },
      { serviceId: BABY, depilationComboId: null, trainingId: null, repeticion: 2, orden: 1, price: 249000 },
      { serviceId: BABY, depilationComboId: null, trainingId: null, repeticion: 3, orden: 1, price: 249000 },
    ]);
  });

  it("sin líneas —depilación, capacitación— da una fila por vuelta con serviceId null", () => {
    expect(filasDeServicioComprado(2, [])).toEqual([
      { serviceId: null, depilationComboId: null, trainingId: null, repeticion: 1, orden: 1, price: null },
      { serviceId: null, depilationComboId: null, trainingId: null, repeticion: 2, orden: 1, price: null },
    ]);
  });

  it("un renglón con sessions_included 3 da 3 filas de ese servicio, con orden 1, 2 y 3", () => {
    // La clienta pagó 3 Baby Botox: tiene que poder agendar 3, no 1.
    const filas = filasDeServicioComprado(1, [{ serviceId: BABY, sessionsIncluded: 3, price: 249000 }]);
    expect(filas).toEqual([
      { serviceId: BABY, depilationComboId: null, trainingId: null, repeticion: 1, orden: 1, price: 249000 },
      { serviceId: BABY, depilationComboId: null, trainingId: null, repeticion: 1, orden: 2, price: 249000 },
      { serviceId: BABY, depilationComboId: null, trainingId: null, repeticion: 1, orden: 3, price: 249000 },
    ]);
  });

  it("rechaza 0 repeticiones: una compra sin nada que agendar no existe", () => {
    expect(() => filasDeServicioComprado(0, [])).toThrow(/al menos una/i);
  });
});

describe("comboDelQueSalenLosServicios", () => {
  // Esta decisión no tenía ningún test y se equivoca en silencio: si un pack
  // que repite un combo mirara sus PROPIAS líneas (que no tiene), la venta no
  // falla — crea filas con `service_id` NULL y la clienta se entera recién al
  // querer agendar que no hay nada que agendar (revisión final de V3b,
  // 2026-09-14).
  it("un pack que repite un combo saca los servicios del combo original", () => {
    expect(comboDelQueSalenLosServicios("pack", "combo-1", "pack-1")).toBe("combo-1");
  });

  it("un pack con servicios propios se mira a sí mismo", () => {
    expect(comboDelQueSalenLosServicios("pack", null, "pack-1")).toBe("pack-1");
  });

  it("un combo común se mira a sí mismo", () => {
    expect(comboDelQueSalenLosServicios("combo", null, "combo-1")).toBe("combo-1");
  });

  it("un combo con `packOfComboId` colgado igual se mira a sí mismo", () => {
    // La columna sólo significa algo para los packs. Un combo que la tuviera
    // sucia no debe empezar a vender los servicios de otro.
    expect(comboDelQueSalenLosServicios("combo", "combo-9", "combo-1")).toBe("combo-1");
  });

  it("sin kind cargado, se mira a sí mismo", () => {
    expect(comboDelQueSalenLosServicios(null, "combo-9", "combo-1")).toBe("combo-1");
  });
});

describe("ordenDeServiciosComprados", () => {
  const fila = (o: Partial<ServicioOrdenable> = {}): ServicioOrdenable => ({
    id: "z", repeticion: 1, orden: 1, serviceName: "Baby Botox", ...o,
  });

  it("primero por vuelta", () => {
    expect(
      ordenDeServiciosComprados(fila({ repeticion: 2 }), fila({ repeticion: 1 })),
    ).toBeGreaterThan(0);
  });

  it("dentro de la vuelta, por `orden`", () => {
    expect(ordenDeServiciosComprados(fila({ orden: 1 }), fila({ orden: 2 }))).toBeLessThan(0);
  });

  it("empatados repeticion y orden, desempata el nombre", () => {
    // El caso normal de un combo de 2 servicios distintos: las dos filas son
    // repeticion 1, orden 1. Sin desempate el orden lo decidía Postgres, que
    // reescribe la fila al agendarla y la manda al final: los dos servicios
    // se daban vuelta entre visitas a la ficha.
    const a = fila({ id: "a", serviceName: "Baby Botox" });
    const b = fila({ id: "b", serviceName: "Depilación facial" });
    expect(ordenDeServiciosComprados(a, b)).toBeLessThan(0);
    expect(ordenDeServiciosComprados(b, a)).toBeGreaterThan(0);
  });

  it("sin nombre desempata el id, que siempre está", () => {
    const a = fila({ id: "aaa", serviceName: null });
    const b = fila({ id: "bbb", serviceName: null });
    expect(ordenDeServiciosComprados(a, b)).toBeLessThan(0);
  });

  it("es total: dos filas nunca empatan salvo que sean la misma", () => {
    const a = fila({ id: "a", serviceName: null });
    const b = fila({ id: "a", serviceName: null });
    expect(ordenDeServiciosComprados(a, b)).toBe(0);
  });

  it("los nulos de repeticion y orden no rompen el orden", () => {
    const a = fila({ id: "a", repeticion: null, orden: null });
    const b = fila({ id: "b", repeticion: 1, orden: 1 });
    expect(ordenDeServiciosComprados(a, b)).toBeLessThan(0);
  });
});

describe("filasDeServicioComprado — líneas que no son un servicio", () => {
  // Un paquete de promo mezcla cosas de distinto tipo en la MISMA compra, así
  // que la cabecera ya no puede decir quién es cada línea: dos packs de
  // depilación distintos en un paquete se verían iguales. La identidad baja a
  // la fila.
  it("propaga el pack de depilación a la fila", () => {
    const filas = filasDeServicioComprado(1, [
      { serviceId: null, depilationComboId: "pack1", trainingId: null, sessionsIncluded: 1, price: 65000 },
    ]);
    expect(filas).toEqual([
      { serviceId: null, depilationComboId: "pack1", trainingId: null, repeticion: 1, orden: 1, price: 65000 },
    ]);
  });

  it("propaga la capacitación a la fila", () => {
    const filas = filasDeServicioComprado(1, [
      { serviceId: null, depilationComboId: null, trainingId: "cap1", sessionsIncluded: 1, price: 30000 },
    ]);
    expect(filas[0]).toMatchObject({ trainingId: "cap1", serviceId: null, depilationComboId: null });
  });

  it("mezcla los tres tipos en una sola compra, que es lo que hace un paquete", () => {
    const filas = filasDeServicioComprado(1, [
      { serviceId: "s1", depilationComboId: null, trainingId: null, sessionsIncluded: 1, price: 100 },
      { serviceId: null, depilationComboId: "pack1", trainingId: null, sessionsIncluded: 1, price: 200 },
      { serviceId: null, depilationComboId: null, trainingId: "cap1", sessionsIncluded: 1, price: 300 },
    ]);
    expect(filas).toHaveLength(3);
    expect(filas.map((f) => f.price)).toEqual([100, 200, 300]);
  });

  it("una compra sin líneas sigue dando una fila anónima por vuelta", () => {
    // Compatibilidad hacia atrás: es como se venden hoy depilación y
    // capacitaciones sueltas, y esas compras no se tocan.
    const filas = filasDeServicioComprado(3, []);
    expect(filas).toHaveLength(3);
    expect(filas.every((f) => f.serviceId === null && f.depilationComboId === null)).toBe(true);
  });
});
