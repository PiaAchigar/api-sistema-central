import { describe, expect, it } from "vitest";
import { desgloseDeCombo, desgloseDeDepilacion } from "./desglose-de-catalogo";
import { filasDeServicioComprado } from "./servicios-comprados";

describe("desgloseDeCombo", () => {
  it("un combo común muestra sus renglones tal cual", () => {
    expect(
      desgloseDeCombo(
        [
          { serviceName: "Baby Botox", sessionsIncluded: 1 },
          { serviceName: "Depilación facial con hilo", sessionsIncluded: 1 },
        ],
        null,
      ),
    ).toEqual([
      { nombre: "Baby Botox", cantidad: 1 },
      { nombre: "Depilación facial con hilo", cantidad: 1 },
    ]);
  });

  it("un pack multiplica por sus sesiones: 'Pack 1 - Prueba' trae 3 Baby Botox", () => {
    expect(desgloseDeCombo([{ serviceName: "Baby Botox", sessionsIncluded: 1 }], 3)).toEqual([
      { nombre: "Baby Botox", cantidad: 3 },
    ]);
  });

  it("multiplica las dos cosas: un renglón de 2 en un pack de 3 da 6", () => {
    expect(desgloseDeCombo([{ serviceName: "Masaje", sessionsIncluded: 2 }], 3)).toEqual([
      { nombre: "Masaje", cantidad: 6 },
    ]);
  });

  /**
   * El desglose es una PROMESA: lo que Laura ve antes de cobrar tiene que ser
   * lo que la clienta después puede agendar. Las dos cuentas viven en archivos
   * distintos, así que se comparan acá contra la misma entrada.
   *
   * Sin este test, cambiar una de las dos deja la otra mintiendo en silencio:
   * la pantalla prometería 3 sesiones y la ficha tendría 1, y nadie se entera
   * hasta que la clienta quiere el segundo turno.
   */
  it("promete exactamente las filas agendables que la venta va a crear", () => {
    const lineas = [
      { serviceId: "s1", serviceName: "Baby Botox", sessionsIncluded: 1, price: null },
      { serviceId: "s2", serviceName: "Masaje", sessionsIncluded: 2, price: null },
    ];
    const packSesiones = 3;

    const prometido = desgloseDeCombo(lineas, packSesiones);
    // `sessionsTotal` de un combo es `packSesiones ?? 1` (ver `cotizar`).
    const creadas = filasDeServicioComprado(packSesiones, lineas);

    for (const fila of prometido) {
      const id = lineas.find((l) => l.serviceName === fila.nombre)!.serviceId;
      expect(creadas.filter((f) => f.serviceId === id)).toHaveLength(fila.cantidad);
    }
    expect(creadas).toHaveLength(prometido.reduce((t, f) => t + f.cantidad, 0));
  });

  it("un renglón sin nombre se dice, no se dibuja en blanco", () => {
    expect(desgloseDeCombo([{ serviceName: null, sessionsIncluded: 1 }], null)).toEqual([
      { nombre: "(sin nombre)", cantidad: 1 },
    ]);
  });

  it("un combo sin renglones no inventa nada", () => {
    expect(desgloseDeCombo([], 4)).toEqual([]);
  });
});

describe("desgloseDeDepilacion", () => {
  it("lista las zonas del pack, una cada una", () => {
    expect(
      desgloseDeDepilacion([{ name: "Axila" }, { name: "Pierna entera" }], 0),
    ).toEqual([
      { nombre: "Axila", cantidad: 1 },
      { nombre: "Pierna entera", cantidad: 1 },
    ]);
  });

  /**
   * "Combo de Esenciales" (producción): 5 zonas cargadas + `choice_zone_count`
   * 1. `precioFormulaDeCombo` cotiza 6 zonas, no 5 — las a elección se SUMAN.
   * Si el desglose las contara adentro de las 5, Laura vendería un pack de 6
   * zonas diciendo que son 5.
   */
  it("las zonas a elección se SUMAN a las fijas, no salen de adentro", () => {
    const filas = desgloseDeDepilacion(
      [
        { name: "Axila" },
        { name: "Cavado" },
        { name: "Pierna entera" },
        { name: "Rostro completo" },
        { name: "Tira de cola" },
      ],
      1,
    );
    expect(filas).toHaveLength(6);
    expect(filas.at(-1)).toEqual({ nombre: "Zona a elección", cantidad: 1 });
    expect(filas.reduce((t, f) => t + f.cantidad, 0)).toBe(6);
  });

  it("sin zonas a elección no agrega el renglón", () => {
    expect(desgloseDeDepilacion([{ name: "Axila" }], 0).map((f) => f.nombre)).toEqual(["Axila"]);
  });
});
