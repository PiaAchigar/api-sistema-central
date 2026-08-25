import { describe, expect, it } from "vitest";
import {
  calcularDuracionTurno, calcularPrecioCombo, calcularPrecioPack,
  buscarPackFijo, zonasBloqueadas,
  type DepilationConfig, type ZonaParaCotizar,
} from "./depilation-pricing";

/** Los valores del PDF (secciones 2, 3, 4, 7 y 8). */
const CONFIG: DepilationConfig = {
  precioLista:   { grande: 19000, mediana: 17000, chica: 12000 },
  minutosPrecio: { grande: 10,    mediana: 7,     chica: 5 },
  tarifaEscalon1: 1200,
  tarifaEscalon2: 1000,
  minutosTurno: {
    mujer:  { grande: 9,  mediana: 6, chica: 3 },
    hombre: { grande: 10, mediana: 8, chica: 5 },
  },
  redondeoTurno: 5,
  turnoMinimo: 10,
  packSesiones: 3,
  packDescuentoPct: 15,
  packRedondeo: 1000,
};

let n = 0;
const z = (categoria: ZonaParaCotizar["categoria"], nombre = `z${++n}`): ZonaParaCotizar =>
  ({ id: `${nombre}-id`, nombre, categoria });

const G = () => z("grande");
const M = () => z("mediana");
const C = () => z("chica");

describe("calcularPrecioCombo — los 5 ejemplos del PDF §5", () => {
  it("Cavado + Axila (2 chicas) = $18.000", () => {
    expect(calcularPrecioCombo([C(), C()], CONFIG).total).toBe(18000);
  });
  it("4 chicas = $28.000", () => {
    expect(calcularPrecioCombo([C(), C(), C(), C()], CONFIG).total).toBe(28000);
  });
  it("1 grande + 4 chicas = $40.000", () => {
    expect(calcularPrecioCombo([G(), C(), C(), C(), C()], CONFIG).total).toBe(40000);
  });
  it("2 grandes + 3 chicas = $46.000", () => {
    expect(calcularPrecioCombo([G(), G(), C(), C(), C()], CONFIG).total).toBe(46000);
  });
  it("2 grandes + 1 chica = $36.000", () => {
    expect(calcularPrecioCombo([G(), G(), C()], CONFIG).total).toBe(36000);
  });
});

// Acá había dos casos tomados de la lista de precios vieja. Se sacaron el
// 2026-08-21: los dos combos incluyen "Cavado completo", que en esa lista
// contaba como zona chica y en el modelo nuevo es MEDIANA. Con la
// clasificación actual dan $28.000 y $42.400, no $23.000 y $40.000. No eran
// una verificación independiente de la fórmula, sino el mismo malentendido
// dos veces.

describe("calcularPrecioCombo — orden y desglose", () => {
  it("ordena grande antes que chica sin importar cómo entren", () => {
    const r = calcularPrecioCombo([C(), G()], CONFIG);
    expect(r.lineas.map((l) => l.categoria)).toEqual(["grande", "chica"]);
    expect(r.lineas[0].motivo).toBe("lista");
    expect(r.lineas[1].motivo).toBe("escalon_1");
  });
  it("a igual categoría conserva el orden de entrada (desempate estable)", () => {
    const a = z("chica", "a");
    const b = z("chica", "b");
    const c = z("chica", "c");
    const r = calcularPrecioCombo([a, b, c], CONFIG);
    expect(r.lineas.map((l) => l.zonaId)).toEqual([a.id, b.id, c.id]);
  });
  it("la tabla ya resuelta del PDF §4", () => {
    // pos 1 / pos 2 / pos 3+ para cada categoría
    expect(calcularPrecioCombo([G(), G(), G()], CONFIG).lineas.map((l) => l.importe))
      .toEqual([19000, 12000, 10000]);
    expect(calcularPrecioCombo([M(), M(), M()], CONFIG).lineas.map((l) => l.importe))
      .toEqual([17000, 8400, 7000]);
    expect(calcularPrecioCombo([C(), C(), C()], CONFIG).lineas.map((l) => l.importe))
      .toEqual([12000, 6000, 5000]);
  });
  it("selección vacía da 0 y sin líneas", () => {
    expect(calcularPrecioCombo([], CONFIG)).toEqual({ total: 0, lineas: [] });
  });
});

describe("calcularPrecioCombo — no-inversión (propiedad del PDF §1)", () => {
  it("agregar una zona nunca baja el precio, en 500 combinaciones al azar", () => {
    const cats = ["grande", "mediana", "chica"] as const;
    for (let i = 0; i < 500; i++) {
      const largo = 1 + Math.floor(Math.random() * 8);
      const base = Array.from({ length: largo }, () => z(cats[Math.floor(Math.random() * 3)]));
      const extra = z(cats[Math.floor(Math.random() * 3)]);
      const antes = calcularPrecioCombo(base, CONFIG).total;
      const despues = calcularPrecioCombo([...base, extra], CONFIG).total;
      expect(despues).toBeGreaterThan(antes);
    }
  });
});

describe("calcularPrecioPack — los 8 ejemplos del PDF §7", () => {
  it.each([
    [18000, 46000], [28000, 71000], [35000, 89000], [40000, 102000],
    [46000, 117000], [49000, 125000], [58000, 148000], [65000, 166000],
  ])("combo %i → pack %i", (combo, esperado) => {
    expect(calcularPrecioPack(combo, CONFIG)).toBe(esperado);
  });

  // Ronda de fixes 2, punto 4 (Minor): había acá un test
  // "no arrastra error de coma flotante" que solo chequeaba
  // `Number.isInteger(...)` — `calcularPrecioPack` termina en
  // `Math.round(x) * packRedondeo`, así que SIEMPRE devuelve un entero, sin
  // importar si el cuerpo de la función está bien o mal. El revisor lo
  // confirmó reemplazando la función entera por algo mal y en float, y ese
  // test seguía pasando. Se borra: el `it.each` de arriba —que incluye
  // justamente el caso 18000 → 46000, el mismo que arrastraría el error de
  // coma flotante (18000 × 3 × 0,85 da 45900.000000000007)— ya prueba el
  // valor EXACTO, que es la propiedad que en verdad importa.
});

describe("calcularDuracionTurno — PDF §8", () => {
  it.each([
    [[C()], 10],                          // 3 → piso de 10
    [[C(), C(), C(), C()], 10],           // 12 → 10
    [[G()], 10],                          // 9 → 10
    [[G(), G()], 20],                     // 18 → 20
    [[G(), G(), C(), C(), C()], 25],      // 27 → 25
  ])("mujer: %#", (zonas, esperado) => {
    expect(calcularDuracionTurno(zonas as ZonaParaCotizar[], "mujer", CONFIG)).toBe(esperado);
  });

  it.each([
    [[C()], 10],       // 5 → piso de 10
    [[G()], 10],       // 10
    [[G(), G()], 20],  // 20
  ])("hombre: %#", (zonas, esperado) => {
    expect(calcularDuracionTurno(zonas as ZonaParaCotizar[], "hombre", CONFIG)).toBe(esperado);
  });

  it("el punto de quiebre 12,5 sube: 12 → 10, 13 → 15", () => {
    // 12 con mujer: 4 chicas = 3+3+3+3
    expect(calcularDuracionTurno([C(), C(), C(), C()], "mujer", CONFIG)).toBe(10);
    // 13 SOLO se puede armar con hombre: mediana 8 + chica 5. Con mujer los
    // minutos son 9/6/3, todos múltiplos de 3, así que 13 es inalcanzable.
    expect(calcularDuracionTurno([M(), C()], "hombre", CONFIG)).toBe(15);
  });

  it("selección vacía da 0, no el piso de 10", () => {
    expect(calcularDuracionTurno([], "mujer", CONFIG)).toBe(0);
  });
});

describe("buscarPackFijo", () => {
  const esenciales = {
    id: "p1", nombre: "Combo de Esenciales",
    zonasBase: ["a", "b", "c", "d", "e"], zonasAEleccion: 1,
    precioFijo: 49000, duracionFija: null,
  };

  it("reconoce el pack con 6 zonas (5 base + 1 a elección)", () => {
    expect(buscarPackFijo(["a","b","c","d","e","x"], [esenciales])?.id).toBe("p1");
  });
  it("no lo reconoce con 5 zonas ni con 7", () => {
    expect(buscarPackFijo(["a","b","c","d","e"], [esenciales])).toBeNull();
    expect(buscarPackFijo(["a","b","c","d","e","x","y"], [esenciales])).toBeNull();
  });
  it("no lo reconoce si falta una zona base", () => {
    expect(buscarPackFijo(["a","b","c","d","x","y"], [esenciales])).toBeNull();
  });
  it("si coinciden dos, gana el más barato", () => {
    const caro = { ...esenciales, id: "p2", precioFijo: 60000 };
    expect(buscarPackFijo(["a","b","c","d","e","x"], [caro, esenciales])?.id).toBe("p1");
  });
});

describe("zonasBloqueadas", () => {
  const exclusiones = [
    { zonaId: "pierna", excluyeA: "media" },
    { zonaId: "media",  excluyeA: "pierna" },
  ];
  it("bloquea media pierna cuando está pierna entera", () => {
    expect(zonasBloqueadas(["pierna"], exclusiones).get("media")).toBe("pierna");
  });
  it("y a la inversa", () => {
    expect(zonasBloqueadas(["media"], exclusiones).get("pierna")).toBe("media");
  });
  it("sin selección no bloquea nada", () => {
    expect(zonasBloqueadas([], exclusiones).size).toBe(0);
  });
  it("si están las dos zonas del par a la vez, ninguna queda bloqueada", () => {
    expect(zonasBloqueadas(["pierna", "media"], exclusiones).size).toBe(0);
  });
});
